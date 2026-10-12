package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// The steps a customer actually moves through, as the call centre sees them.
//
// WHY THIS EXISTS. A call log records one conversation at one moment. It is the wrong
// place to record what the customer did afterwards — and yet that is what agents were
// using it for, because it was the only writable surface in front of them. Measured on
// 2026-09-28: 43 call logs had had their outcome overwritten days after the call,
// including Interested → Converted, so the call stopped being a record of the call.
// See call_log_correction_guard.go for the numbers.
//
// So this is the door that was missing. A step says "this happened to this customer on
// this date", separately from any call, and the timeline then reads the way the work
// actually went:
//
//	call (Interested) → Documents Received → Application Started → Converted
//
// instead of one mutated row claiming it was always Converted.
//
// WHY NOT REUSE THE LOS STAGES. app.loan_applications has a formal ten-stage pipeline
// (draft → submitted → document_collection → risk_review → … → active), and it is
// tempting to make agents advance that instead. It would be wrong twice: those stages
// are owned by Risk, Finance and Card Ops and gated on pages a telesales agent does not
// have (see frontend/src/lib/losFlow.ts), and the agent's work happens BEFORE a draft
// application exists at all. These steps cover exactly that stretch and hand over:
// 'application_started' is where LOS takes the story on.
//
// WHY A LIST AND NOT A FREE-TEXT BOX. There already is a free-text box — activities
// carries type='note', and it has exactly ONE row in the whole table, written by an
// admin. A blank box asks the agent to invent the structure, so nobody uses it. A named
// step costs one click and produces something countable.

type customerStep struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	// Hint is shown under the option, in the same voice as a disposition hint.
	Hint string `json:"hint"`
	// NeedsNote makes the written explanation mandatory. Set only where the step is
	// worthless without it — a drop-off whose reason nobody recorded is a lost customer
	// and no learning.
	NeedsNote bool `json:"needs_note,omitempty"`
	// Terminal marks the end of the agent's involvement, won or lost. A terminal step is
	// what a report counts; the rest are progress.
	Terminal bool `json:"terminal,omitempty"`
	// Won distinguishes the one terminal step that is a success, so a conversion rate can
	// be computed without hardcoding a string somewhere else.
	Won bool `json:"won,omitempty"`
}

// Ordered as the journey runs, because the form renders them in this order and an agent
// picking "where are we now" reads down a sequence, not an alphabetical list.
var customerSteps = []customerStep{
	{Code: "information_sent", Label: "Information Sent",
		Hint: "Product details went out by email, WhatsApp or SMS"},
	{Code: "customer_reviewing", Label: "Customer Reviewing",
		Hint: "They have what they asked for and are considering it"},
	{Code: "documents_requested", Label: "Documents Requested",
		Hint: "We have asked them for what we need to proceed"},
	{Code: "documents_received", Label: "Documents Received",
		Hint: "Their paperwork is in — say what is still outstanding, if anything"},
	{Code: "met_customer", Label: "Visited Branch / Met Customer",
		Hint: "Seen in person, at a branch or on a visit"},
	{Code: "application_started", Label: "Application Started",
		Hint: "An application now exists — from here the LOS pipeline carries it"},
	{Code: "sent_to_risk", Label: "Sent to Risk",
		Hint: "Handed to Risk for review — no longer waiting on the call centre"},
	{Code: "customer_went_quiet", Label: "Customer Went Quiet",
		Hint: "They stopped responding after showing interest — not a refusal"},
	// Found by repairing the rewritten call logs (migration 300): six of the overwritten
	// outcomes were "Not Eligible" recorded days after the call, i.e. WE declined them
	// after checking. That is not the customer dropping off and it is not a call outcome
	// either — it is a decision of ours, and without a step for it the repair would have
	// had to file it as something it is not.
	{Code: "declined_not_eligible", Label: "Declined — Not Eligible", Terminal: true,
		Hint: "We checked and they do not qualify — name the criterion (age, employer, exposure)"},
	// The only step that demands prose. "Dropped Off" with no reason records that we lost
	// somebody and teaches us nothing; the reason is the entire value of the row.
	{Code: "dropped_off", Label: "Dropped Off", NeedsNote: true, Terminal: true,
		Hint: "They have withdrawn. Say why — this is the only place that reason is captured"},
	{Code: "converted", Label: "Converted", Terminal: true, Won: true,
		Hint: "They took the product. Record the date it actually happened, not today"},
}

func customerStepByCode(s string) (customerStep, bool) {
	s = strings.TrimSpace(s)
	for _, st := range customerSteps {
		if strings.EqualFold(st.Code, s) || strings.EqualFold(st.Label, s) {
			return st, true
		}
	}
	return customerStep{}, false
}

// The activity type a step is stored under. Kept as a constant because it is written in
// Go, read by the timeline query, and filtered on in the frontend — three places that
// must agree.
const activityTypeStep = "step"

// customerStepNoteMissing reports whether a step requires an explanation and none was
// given. Same minimum length as an "Other" disposition, for the same reason: "n/a" and
// "-" are how a mandatory field gets defeated.
func customerStepNoteMissing(code, body string) bool {
	st, ok := customerStepByCode(code)
	if !ok || !st.NeedsNote {
		return false
	}
	return len([]rune(strings.TrimSpace(body))) < ccOtherNoteMinRunes
}

// applyTerminalStep closes the outbound-queue contact when a step ends the journey.
//
// WHY THIS IS NOT INERT. A step and a call disposition are deliberately independent in
// one direction — recording a step must never rewrite a call, because that is the defect
// the whole feature exists to remove. But the reverse is not symmetry, it is a bug:
// "Converted" and "Dropped Off" are the end of the relationship, and a contact that
// nobody closes keeps being dialled.
//
// That is precisely the failure this morning's disposition work removed. Nine Call Log
// labels — Converted and Paid among them — resolved to nothing and left the contact
// 'pending', so a lead we had already won stayed in the dial pool and a settled
// collections account kept being chased. Shipping a step vocabulary with the same
// silence would have rebuilt the bug in a new place.
//
// Conservative on purpose. It closes ('no further calls') and does nothing else: no DNC
// suppression, no callback rewriting, no touching crm_contacts.lead_stage. Only a
// 'pending' contact moves, so a contact somebody has deliberately closed or marked
// invalid is left exactly as they left it.
//
// SCOPED BY PURPOSE, WHICH IS NOT OPTIONAL. These steps describe the ACQUISITION journey:
// "Converted" and "Dropped Off" end the attempt to sell somebody a product. They say
// nothing about money that person already owes us, or about a support issue they have
// open. Closing on a bare phone match would cross all three, because 44 acquisition
// phones also carry a pending collections or support contact — so recording "Converted"
// on a sales lead would have closed that same person's COLLECTIONS contact and stopped
// us chasing their arrears. Same family of defect as every other one fixed today: a
// blunt key match acting on the wrong record.
//
// Caught before it ever fired: applyTerminalStep had not yet executed once in production
// when this scope was added.
//
// Errors are logged rather than returned: the step is already recorded by this point, and
// failing the request would tell an agent their step went unrecorded when it did not.
func applyTerminalStep(ctx context.Context, db *core.DB, st customerStep, contactID *int64, phone string, actor *int64) {
	if !st.Terminal {
		return
	}

	// When the caller knows exactly which contact is being worked, close that one and
	// nothing else. No inference, no reach across campaigns.
	if contactID != nil && *contactID > 0 {
		rows, err := db.PGQuery(ctx, `
			UPDATE call_center_contacts SET status = 'closed', updated_at = NOW()
			 WHERE id = $1 AND status = 'pending' RETURNING id`, *contactID)
		if err != nil {
			slog.Error("customer step: could not close the contact",
				"step", st.Code, "contact", *contactID, "err", err)
			return
		}
		slog.Info("customer step closed its own outbound contact",
			"step", st.Code, "contact", *contactID, "closed", len(rows), "by", actor)
		return
	}

	// Otherwise fall back to the phone — but only across the acquisition queues, never
	// collections or support.
	//
	// normalizePhone and normalizedPhoneExpr both reduce to the last 10 digits, so the Go
	// value and the SQL expression agree; verified rather than assumed, because a mismatch
	// here would make this whole function a silent no-op. app.norm_phone returns '' rather
	// than NULL for anything unparseable, so a blank would match every blank-phoned
	// contact — length 10 is the validity test. See [[o3c-phone-normalisation]].
	np := normalizePhone(phone)
	if len(np) != 10 {
		slog.Warn("customer step: terminal step closed nothing — no contact id and an unusable phone",
			"step", st.Code, "phone", phone)
		return
	}
	rows, err := db.PGQuery(ctx, stepCloseByPhoneSQL(), np)
	if err != nil {
		slog.Error("customer step: could not close the contact",
			"step", st.Code, "err", err)
		return
	}
	if len(rows) > 0 {
		slog.Info("customer step closed the outbound contact",
			"step", st.Code, "contacts", len(rows), "by", actor)
	}
}

// leadStatusFromStep maps a terminal step to the SAME status vocabulary
// leadStatusFromCall uses for a call disposition (see call_center_outbound.go)
// — so a step and a call move the Leads board the same way, rather than
// inventing a second vocabulary that drifts from the first the way the call-log
// and disposition lists once did.
func leadStatusFromStep(code string) (status string, ok bool) {
	switch code {
	case "converted":
		return "converted", true
	case "declined_not_eligible":
		// Our decline, not theirs — same bucket leadStatusFromCall gives "Not
		// Eligible" on a call.
		return "closed", true
	case "dropped_off":
		// They withdrew — same bucket a customer-initiated churn gets on a call
		// ("Left Over...", "No Longer Needs...").
		return "closed", true
	}
	return "", false
}

// applyStepToLead keeps the Leads board in harmony with a terminal step, the way
// syncLeadFromCall already keeps it in harmony with a call disposition — same
// forward-only rank guard (ccLeadStatusRankSQL), so a step can log against a
// lead that a later call has already carried past it without knocking it
// backward, exactly as one call can't undo a further-along call.
//
// Deliberately does not touch crm_contacts.lead_stage: that pipeline is owned by
// Sales and its own conversion path (convertLead) requires a product line and a
// CIF/account reference neither this free-text step nor the call-centre agent
// logging it carries, and is gated to that lead's own Sales owner. Reaching that
// far would risk marking a lead "customer" with no CIF — corrupting every join
// that assumes a converted card customer has one — or silently failing an
// ownership check the agent has no way to satisfy. This stays inside the
// call-centre's own board, which is the system the agent actually works and
// where the gap was reported.
func applyStepToLead(ctx context.Context, db *core.DB, leadID int64, code, body string) {
	status, ok := leadStatusFromStep(code)
	if !ok {
		return
	}
	st, _ := customerStepByCode(code)
	label := st.Label
	if strings.TrimSpace(body) != "" {
		label = st.Label + ": " + strings.TrimSpace(body)
	}
	if _, err := db.PGExec(ctx, applyStepToLeadSQL(), status, label, ccLeadStatusRank[status], leadID); err != nil {
		slog.Error("customer step: could not update the lead", "lead", leadID, "step", code, "err", err)
		return
	}
	// A DECLINE has to reach Sales. A conversion still must not — see
	// declineReachesSales for why the two are not the same reach.
	if declineReachesSales(code) {
		disqualifyForwardedLead(ctx, db, leadID, label)
	}
}

// declineReachesSales reports whether a terminal step must also end the lead on the
// SALES side, not just on the call-centre board.
//
// THE CASE THAT FORCED THIS. Lead 14648, "Sicostar". One call on 2 October, disposition
// Interested, which correctly qualified the contact and forwarded it. On 6 October
// somebody moved it to Declined — Not Eligible with the note "BAD CREDIT RECORD WITH
// OPAY AND NEWEDGE". The lead board closed, as designed. Sales was never told: the
// contact still read qualified, the hand-off still read open, and on 12 October a bulk
// distribution handed a lead the business had already declined to a sales officer to go
// and visit. Sixteen leads were in that state, fifteen of them already with an officer.
//
// WHY THIS IS NOT THE REACH applyStepToLead REFUSES. That function deliberately leaves
// crm_contacts alone, and TestATerminalStepNeverTouchesTheSalesPipeline holds it to it.
// The reason given there is specific and correct: CONVERTING needs a product line and a
// CIF that a free-text step does not carry, and marking a lead "customer" without one
// corrupts every join that assumes a converted customer has a CIF.
//
// None of that applies to a decline. Disqualifying needs no CIF, no product and no
// account reference — only a reason, which the step carries in its own note. So the
// asymmetry is deliberate: converted stays inside the call centre, declines travel.
// The harm of not travelling is an officer driving to a customer we have already
// refused.
func declineReachesSales(code string) bool {
	return code == "declined_not_eligible" || code == "dropped_off"
}

// disqualifyForwardedLeadSQL ends the lead on the Sales side. In its own function, and
// its own statement, so applyStepToLeadSQL stays provably clear of crm_contacts and the
// two tests can state the distinction between a decline and a conversion.
//
// Three restrictions, each load-bearing:
//
//   - it moves only a contact THIS lead was actually forwarded as (the hand-off ledger
//     is the link, not a phone match), so a step can never disqualify a stranger;
//   - never over a converted contact. Sales booking a customer outranks a call-centre
//     note, and reversing a conversion would drop a real customer out of the numbers;
//   - never over an already-disqualified one, so re-logging the step is a no-op rather
//     than a second reason overwriting the first.
func disqualifyForwardedLeadSQL() string {
	return `
		UPDATE crm_contacts c
		   SET lead_stage        = 'disqualified',
		       disqualify_reason = COALESCE(NULLIF(btrim($2), ''), c.disqualify_reason),
		       updated_at        = NOW()
		 WHERE c.id = (SELECT f.contact_id
		                 FROM call_center_lead_forwards f
		                WHERE f.lead_id = $1
		                  AND f.contact_id IS NOT NULL
		                ORDER BY f.forwarded_at DESC
		                LIMIT 1)
		   AND c.lead_stage NOT IN ('converted', 'disqualified')
	 RETURNING c.id, c.sales_owner_id`
}

// disqualifyForwardedLead ends the hand-off and tells whoever was working it.
//
// The notification is the point. Closing the records silently would fix the reports and
// leave the officer exactly as wrong as before — still holding the lead, still planning
// the visit. It goes only to the owner, ungrouped, because "stop work on this one" is
// not a digest item.
func disqualifyForwardedLead(ctx context.Context, db *core.DB, leadID int64, reason string) {
	rows, err := db.PGQuery(ctx, disqualifyForwardedLeadSQL(), leadID, reason)
	if err != nil {
		slog.Error("customer step: could not end the hand-off on the sales side",
			"lead", leadID, "err", err)
		return
	}
	if len(rows) == 0 {
		return // never forwarded, already closed, or already a customer
	}
	contactID := toInt64(rows[0]["id"])
	if contactID == 0 {
		return
	}
	var owner *int64
	if id := toInt64(rows[0]["sales_owner_id"]); id != 0 {
		owner = &id
	}

	// The stage history has to carry it too, or the lead page shows a disqualified lead
	// with nothing saying who disqualified it or why.
	if _, err := db.PGExec(ctx, `
		INSERT INTO crm_lead_events (contact_id, event, to_stage, note, created_by)
		VALUES ($1, 'disqualified', 'disqualified', $2, NULL)`,
		contactID, "Declined by the call centre after the hand-off: "+reason); err != nil {
		slog.Error("customer step: could not record the disqualification", "contact", contactID, "err", err)
	}

	markForwardResolved(ctx, db, contactID, "rejected", owner, reason)

	if owner != nil {
		name := contactDisplayName(ctx, db, contactID)
		go Notify(context.WithoutCancel(ctx), db, NotifPayload{
			EventType: EvtLeadDeclinedAfterHandoff,
			UserID:    *owner,
			Title:     "Stop Work: " + name + " Has Been Declined",
			Body: "The call centre has declined this lead since it was handed to you: " +
				reason + ". It has been taken off your queue; no visit is needed.",
			ActionURL: fmt.Sprintf("/sales/leads/%d", contactID),
			EntityRef: fmt.Sprintf("crm_contact:%d", contactID),
			Priority:  "high",
		})
	}
	slog.Info("hand-off ended on the sales side by a call-centre decline",
		"lead", leadID, "contact", contactID, "reason", reason)
}

// contactDisplayName is for the alert’s subject line. A lead with no name on it reads
// as "This Lead", which is better than an empty gap where a person should be.
func contactDisplayName(ctx context.Context, db *core.DB, contactID int64) string {
	rows, err := db.PGQuery(ctx, `
		SELECT btrim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS name
		  FROM crm_contacts WHERE id = $1`, contactID)
	if err != nil || len(rows) == 0 {
		return "This Lead"
	}
	if n := strings.TrimSpace(str(rows[0]["name"])); n != "" {
		return n
	}
	return "This Lead"
}

// applyStepToLeadSQL is the UPDATE applyStepToLead runs, pulled into its own function —
// same reason as stepCloseByPhoneSQL — so a test can assert its properties without a
// live database: the rank guard is present, and crm_contacts is not touched.
func applyStepToLeadSQL() string {
	return `
		UPDATE call_center_leads
		   SET status           = CASE WHEN $3::int >= ` + ccLeadStatusRankSQL + ` THEN $1 ELSE status END,
		       last_disposition = $2,
		       updated_at       = NOW()
		 WHERE id = $4`
}

// stepCloseByPhoneSQL is the fallback close, in a function rather than inline so a test
// can assert its two restrictions. Both exist because of specific harm:
//
//   - purpose IN ('marketing','sales') — 44 acquisition phones also carry a pending
//     collections or support contact, so an unscoped close would have stopped us chasing
//     a converted lead's arrears.
//   - status = 'pending' — anything else has been deliberately closed or invalidated by
//     somebody, and a step must not reopen or re-close their decision.
//
// Guarded by TestATerminalStepNeverReachesBeyondAcquisition.
func stepCloseByPhoneSQL() string {
	return `
		UPDATE call_center_contacts
		   SET status = 'closed', updated_at = NOW()
		 WHERE ` + normalizedPhoneExpr("phone") + ` = $1
		   AND status = 'pending'
		   -- Acquisition only. A collections or support contact on the same number is a
		   -- different relationship and is none of this step's business.
		   AND COALESCE(purpose,'') IN ('marketing', 'sales')
		 RETURNING id`
}

// ccListCustomerSteps serves the vocabulary so the form renders from this list rather
// than its own copy. Two copies of a vocabulary drifting apart is how the call-centre
// disposition list ended up defined twice with different contents.
func ccListCustomerSteps() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": customerSteps}) //nolint:errcheck
	}
}
