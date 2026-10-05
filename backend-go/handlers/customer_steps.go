package handlers

import (
	"context"
	"encoding/json"
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
		label = st.Label + " — " + strings.TrimSpace(body)
	}
	if _, err := db.PGExec(ctx, applyStepToLeadSQL(), status, label, ccLeadStatusRank[status], leadID); err != nil {
		slog.Error("customer step: could not update the lead", "lead", leadID, "step", code, "err", err)
	}
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
