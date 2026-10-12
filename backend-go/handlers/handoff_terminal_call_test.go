package handlers

import "testing"

func sp(s string) *string { return &s }

// Closing the hand-off and overturning an earned 'interested' are two different
// questions, and for most of this module's life one predicate answered both. The cost:
// 14 contacts measured on 2026-10-12 sat at lead_stage 'disqualified' with the hand-off
// still reading 'forwarded', every one moved by a call logging "Not Eligible" — our own
// decline, which leadDeclinedOnCall deliberately (and correctly) does not count.
//
// The tracker rendered them as rejected because forwardStatusExpr reads the stage, so the
// gap never showed on screen while resolved_at stayed NULL and they aged as open
// hand-offs for ever.
func TestOurOwnDeclineAlsoEndsTheHandoff(t *testing.T) {
	// The case that was broken. "Not Eligible" is not a customer refusal...
	if leadDeclinedOnCall("completed", sp("Not Eligible")) {
		t.Error("Not Eligible now counts as a CUSTOMER refusal — that would let our own " +
			"credit decision overturn an earned 'interested', which is a different rule")
	}
	// ...and must still end the hand-off.
	if !leadEndsHandoffOnCall("completed", sp("Not Eligible")) {
		t.Error("Not Eligible does not end the hand-off: Sales keeps a lead the business " +
			"has already refused, and the ledger ages it as open for ever")
	}

	// A customer refusal ends it too — that path must not regress.
	if !leadEndsHandoffOnCall("completed", sp("Not Interested")) {
		t.Error("a customer refusal no longer ends the hand-off")
	}

	// Terminal in the other two senses.
	for _, d := range []string{"Do Not Call", "Wrong Number"} {
		if !leadEndsHandoffOnCall("completed", sp(d)) {
			t.Errorf("%q does not end the hand-off, but there is nobody left to sell to", d)
		}
	}

	// And the ones that must NOT close anything. A lead Sales is working is not finished
	// because one dial went unanswered or the customer asked for more time.
	for _, d := range []string{"Unreachable / No Answer", "Callback Scheduled", "Not Ready Yet", "Call Dropped"} {
		if leadEndsHandoffOnCall("completed", sp(d)) {
			t.Errorf("%q ends the hand-off — it would take a live lead off Sales on a "+
				"call that established nothing", d)
		}
	}

	// No disposition at all is not a terminal outcome either.
	if leadEndsHandoffOnCall("completed", nil) {
		t.Error("a bare logged call ends the hand-off, which would close lead after lead " +
			"as agents log ordinary calls")
	}
}
