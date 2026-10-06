package handlers

import (
	"context"
	"log/slog"
	"strings"

	"github.com/o3c/workspace/core"
)

// ccRederiveLeadStatus recomputes a lead's status from the calls that SURVIVE, and is the
// one place allowed to move a lead BACKWARDS.
//
// WHY IT HAS TO EXIST. Lead status is forward-only: syncLeadFromCall refuses to lower a
// lead's rank, so a later call can advance a lead but never walk it back. That rule is
// right while the evidence only grows — a no-answer today does not undo the interest
// recorded yesterday. It is wrong the moment the evidence SHRINKS, and voiding a call
// shrinks it.
//
// WHAT IT COST. On 2026-10-02 an agent logged "Converted" against lead 13080 (Crowning
// Products) at 11:06:02, realised, and re-logged "Interested" at 11:07:31 and 11:11:26.
// Forward-only refused both corrections — 'interested' is rank 4, 'converted' is rank 5 —
// so the lead stayed converted and its last_disposition read "Interested" while its status
// read "Converted". The agent then VOIDED all three calls. hdVoidCall struck out the rows
// and nothing re-derived the lead, so a call that had been withdrawn still owned the
// lead's status four days later, in the converted count, with no control in the UI to
// change it. Three separate attempts by a person to correct one mis-click, all defeated.
// Migration 340 corrected that lead and four others; this function is why it will not
// recur.
//
// THE RULE. The lead gets the HIGHEST rank any surviving call earns it — the same
// forward-only semantics, recomputed over a smaller set rather than applied one call at a
// time. So voiding the single call that converted a lead drops it back to whatever its
// other calls justify; voiding a no-answer changes nothing, because it was never the
// highest. With no surviving call at all the lead returns to 'pending': every record of it
// having been worked has been withdrawn.
//
// leadStatusFromCall is called per surviving call rather than reimplemented, so there is no
// second copy of the mapping to drift.
//
// DELIBERATELY NOT UNDONE here:
//   - The hand-off to Sales. Forwarding is a thing that happened and Sales may already have
//     acted on it; withdrawing a call log is not authority to reach into their pipeline.
//   - The DNC suppression. A customer asking not to be called is their standing request,
//     not an artefact of the agent's write-up, and un-suppressing someone because a log
//     was tidied up is the one error here with a regulator attached.
//
// Failures are logged, never fatal: the void itself has already succeeded and must not be
// reported as failed because the lead could not be re-derived.
func ccRederiveLeadStatus(ctx context.Context, db *core.DB, leadID int64, origin string) {
	if leadID <= 0 {
		return
	}
	rows, err := db.PGQuery(ctx, `
		SELECT disposition, outcome
		  FROM app.helpdesk_calls
		 WHERE lead_id = $1
		   AND voided_at IS NULL
		   AND merged_into_call_id IS NULL
		 ORDER BY created_at`, leadID)
	if err != nil {
		slog.Error("ccRederiveLeadStatus: load surviving calls",
			"lead", leadID, "origin", origin, "err", err)
		return
	}

	status, disposition := ccLeadStatusFromSurvivingCalls(rows)

	// No guard on the current value: lowering is the entire purpose. Writing
	// unconditionally also repairs the case where status and last_disposition had drifted
	// apart, which is what made lead 13080 unreadable — the status came from one call and
	// the disposition from another.
	if _, err := db.PGExec(ctx, `
		UPDATE app.call_center_leads
		   SET status           = $2,
		       last_disposition = NULLIF($3, ''),
		       updated_at       = NOW()
		 WHERE id = $1`, leadID, status, disposition); err != nil {
		slog.Error("ccRederiveLeadStatus: write lead",
			"lead", leadID, "origin", origin, "status", status, "err", err)
		return
	}
	// Both sides of the fact, or neither. The lead and the sales stage are two readings of
	// the same call history, and correcting only the one the call centre looks at is what
	// left migration 340 half-done.
	ccRederiveContactStage(ctx, db, leadID, status, disposition, origin)
	slog.Info("lead status re-derived from surviving calls",
		"lead", leadID, "origin", origin, "status", status,
		"surviving_calls", len(rows))
}

// ccLeadStatusFromSurvivingCalls is the rule, separated from the database so it can be
// tested without one: the lead gets the highest-ranking status any surviving call earns
// it, and the disposition of whichever call that was.
//
// 'pending' is both the answer for a lead with nothing left on the record and the floor —
// rank 0, so any surviving call beats it.
func ccLeadStatusFromSurvivingCalls(calls []core.Row) (status, disposition string) {
	status = "pending"
	best := -1
	for _, row := range calls {
		d := str(row["disposition"])
		var dp *string
		if d != "" {
			dp = &d
		}
		st := leadStatusFromCall(str(row["outcome"]), dp)
		if rank, ok := ccLeadStatusRank[st]; ok && rank > best {
			best, status, disposition = rank, st, d
		}
	}
	return status, disposition
}

// ccSalesOwnedStages are the pipeline stages that belong to SALES, not to the call centre.
//
// Re-derivation may lower a stage the call centre set — that is the point — but a contact
// Sales has moved into their own process is their work. Withdrawing a call log is not
// authority to pull a submitted application back to 'contacted', any more than it is
// authority to reverse a hand-off; both decisions need a person.
var ccSalesOwnedStages = map[string]bool{
	"handed_to_sales":       true,
	"documents_requested":   true,
	"application_submitted": true,
	"approved":              true,
}

// ccRederiveContactStage brings the SALES-side stage back in line with a lead whose status
// has just been re-derived.
//
// WHY IT EXISTS, AND IT IS A LESSON FROM THE SAME DAY. Migration 340 corrected five leads
// out of 'converted' in call_center_leads and left app.crm_contacts.lead_stage alone — so
// two of them went on telling the sales pipeline they had converted, including the one
// whose converting call had been voided with the reason typed as "TEST". Fixing one side
// of a two-sided fact is the defect this codebase keeps paying for, and ccRederiveLeadStatus
// had exactly the same hole until this was added: it would have re-derived the lead on a
// void and left Sales reading 'converted' for ever.
//
// crmCallMoveAllowed is deliberately bypassed. It enforces forward-only on the stage for
// the same good reason syncLeadFromCall does on the status, and it is wrong here for the
// same reason: the evidence shrank.
func ccRederiveContactStage(ctx context.Context, db *core.DB, leadID int64, status, disposition, origin string) {
	stage, _ := crmStageForCall(status, disposition)
	if stage == "" {
		return
	}
	rows, err := db.PGQuery(ctx, `
		SELECT c.id, c.lead_stage, COALESCE(c.disqualify_reason, '') AS disqualify_reason
		  FROM app.call_center_leads l JOIN app.crm_contacts c ON c.id = l.contact_id
		 WHERE l.id = $1`, leadID)
	if err != nil || len(rows) == 0 {
		return
	}
	contactID := toInt64(rows[0]["id"])
	current := str(rows[0]["lead_stage"])
	if current == stage || contactID <= 0 {
		return
	}
	if ccSalesOwnedStages[current] {
		slog.Info("lead re-derived but sales stage left alone — Sales owns this contact now",
			"lead", leadID, "contact", contactID, "stage", current, "origin", origin)
		return
	}
	// A contact disqualified by anyone other than the call centre stays disqualified.
	// Compliance and Sales both write here, and un-disqualifying someone because a call
	// log was tidied up is not a call this function gets to make.
	if current == "disqualified" && !strings.HasPrefix(str(rows[0]["disqualify_reason"]), crmCallDisqualifyPrefix) {
		return
	}
	if _, err := db.PGExec(ctx, `
		UPDATE app.crm_contacts
		   SET lead_stage = $2, stage_changed_at = NOW(), updated_at = NOW()
		 WHERE id = $1`, contactID, stage); err != nil {
		slog.Error("ccRederiveContactStage: write stage",
			"lead", leadID, "contact", contactID, "err", err)
		return
	}
	db.PGExec(ctx, `
		INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
		VALUES ($1, 'stage_regraded', $2, $3, $4, NULL)`,
		contactID, current, stage,
		"Re-derived from the calls that remain after a log was withdrawn.") //nolint:errcheck
}
