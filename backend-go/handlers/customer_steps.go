package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
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

// ccListCustomerSteps serves the vocabulary so the form renders from this list rather
// than its own copy. Two copies of a vocabulary drifting apart is how the call-centre
// disposition list ended up defined twice with different contents.
func ccListCustomerSteps() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": customerSteps}) //nolint:errcheck
	}
}
