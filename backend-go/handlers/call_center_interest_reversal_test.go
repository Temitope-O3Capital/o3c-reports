package handlers

import "testing"

// A lead that was logged Interested and is later reached again and REFUSES must stop
// reading as Interested.
//
// The bug this locks down: 'interested' ranks 4 in ccLeadStatusRank while "Not
// Interested" maps to 'called' (rank 1), so syncLeadFromCall's forward-only guard
// refused the move and the lead stayed Interested. Found live on 2026-09-23 — three
// leads whose latest disposition was answered_not_interested still sat on
// 'interested', and two of them had already been auto-forwarded to Sales as
// qualified, who were still chasing customers that had said no.
//
// The companion risk is over-correcting: 'interested' is EARNED, and most calls that
// rank below it say nothing about interest. The tests below pin both edges — what
// must overturn it, and what must never.

func TestARefusalOverturnsInterested(t *testing.T) {
	// Both the label the outbound queue sends and the code stored on the
	// disposition row, because the call-log endpoints pass through whatever the
	// client held.
	for _, d := range []string{
		"Not Interested",
		"Answered — Not Interested",
		"answered_not_interested",
		"Do Not Call",
		"do_not_call",
	} {
		label := d
		if !leadDeclinedOnCall("", &label) {
			t.Errorf("leadDeclinedOnCall(%q) = false — a refusal must be able to "+
				"overturn 'interested'", d)
		}
	}
}

func TestOnlyARefusalOverturnsInterested(t *testing.T) {
	// None of these is the customer saying no, so none may un-qualify a warm lead.
	for _, d := range []string{
		"No Answer",               // nobody picked up: says nothing about interest
		"Unreachable / No Answer", //
		"no_answer",               //
		"Call Dropped",            // answered then died: nothing was established
		"Not Ready Yet",           // a timing objection — "Interested but not now"
		"not_ready",               //
		"Interested",              // the opposite
		"Answered — Interested",   //
		"answered_interested",     //
		"Not Eligible",            // OUR decline, not theirs; ranks terminal anyway
		"not_eligible",            //
		"Callback Requested",      // still wants the call
		"Converted",               // the sale landed
		"",                        // a bare call with no disposition
	} {
		label := d
		if leadDeclinedOnCall("", &label) {
			t.Errorf("leadDeclinedOnCall(%q) = true — this would silently un-qualify "+
				"a lead that never refused", d)
		}
	}
	// A nil disposition (the call-edit path can pass one) must not panic or decline.
	if leadDeclinedOnCall("completed", nil) {
		t.Error("leadDeclinedOnCall(outcome=\"completed\", nil) = true, want false")
	}
}

// The mapping and the refusal test have to agree: anything we call a refusal must
// also map to a status that is NOT 'interested', or the UPDATE would set the lead
// straight back to where it started.
func TestARefusalNeverMapsBackToInterested(t *testing.T) {
	for _, d := range ccDispositions {
		label := d.Label
		if !leadDeclinedOnCall(ccCallOutcome(d), &label) {
			continue
		}
		if got := leadStatusFromCall(ccCallOutcome(d), &label); got == "interested" {
			t.Errorf("disposition %q (%s) counts as a refusal but maps to %q — the "+
				"lead would be set back to the status the refusal is meant to clear",
				d.Code, d.Label, got)
		}
	}
}

// Every disposition that CLOSES the contact because the customer refused must be
// caught, so adding one to ccDispositions cannot quietly reintroduce the freeze.
// "Not Eligible" and "Resolved" also close the contact but are not the customer
// refusing, and both already map above 'interested', so they are exempt by rank.
func TestEveryCustomerRefusalIsRecognised(t *testing.T) {
	interestedRank := ccLeadStatusRank["interested"]
	for _, d := range ccDispositions {
		if d.Code != "answered_not_interested" && d.Code != "do_not_call" {
			continue
		}
		label := d.Label
		status := leadStatusFromCall(ccCallOutcome(d), &label)
		if ccLeadStatusRank[status] >= interestedRank {
			continue // the rank guard alone already moves it
		}
		if !leadDeclinedOnCall(ccCallOutcome(d), &label) {
			t.Errorf("disposition %q (%s) maps to %q (rank %d, below interested) but "+
				"is not recognised as a refusal — a lead logged Interested and then "+
				"declined would freeze on 'interested' again",
				d.Code, d.Label, status, ccLeadStatusRank[status])
		}
	}
}
