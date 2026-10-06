package handlers

import (
	"context"
	"log/slog"

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
