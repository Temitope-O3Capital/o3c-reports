package handlers

import "testing"

// A lead's status should say what its LAST CALL actually established, and a promised
// callback that has been dialled must stop reading as "Callback".
//
// The bug this locks down: 'callback' ranks 3 in ccLeadStatusRank, above 'called' (1)
// and 'no_answer' (1). syncLeadFromCall's forward-only guard therefore refused to move
// a lead off 'callback' once the promised call had been made — whether it was answered
// "Not Interested" (→ 'called', 25 leads, migration 275) or simply went unanswered
// (→ 'no_answer', 48 leads, migration 278). Both sat showing an outstanding callback
// for a call that had already happened.
//
// While a lead is only HOLDING a promise ('callback' / 'not_ready'), the status now
// follows the call. Two boundaries matter and are tested below: a dropped call
// establishes nothing, and earned statuses are never walked backwards.
//
// These cover the Go half — the mapping and the `outcomeKnown` flag derived from it.
// The decision itself is the UPDATE's CASE, verified directly against Postgres; the
// integration harness that could assert it in CI lives on main, not this branch.

// outcomeKnownFor mirrors the derivation in syncLeadFromCall exactly.
func outcomeKnownFor(label string) bool {
	return leadStatusFromCall("", &label) != "pending"
}

func TestLeadStatusFromCallKeyDispositions(t *testing.T) {
	for _, c := range []struct{ label, want string }{
		// The two groups that were freezing leads on 'callback'.
		{"Answered — Not Interested", "called"},
		{"Not Interested", "called"},
		{"Not Ready Yet", "not_ready"},
		{"No Answer", "no_answer"},
		{"Unreachable / No Answer", "no_answer"},
		// Establishes nothing — the one call that must not restate the status.
		{"Call Dropped", "pending"},
		// Forward moves and terminal outcomes.
		{"Answered — Interested", "interested"},
		{"Callback Requested", "callback"},
		{"Promise to Pay", "callback"}, // deliberately surfaced like a callback
		{"Not Eligible", "closed"},
		{"Wrong Number", "invalid"},
		{"Do Not Call", "dnc"},
	} {
		if got := leadStatusFromCall("", &c.label); got != c.want {
			t.Errorf("leadStatusFromCall(%q) = %q, want %q", c.label, got, c.want)
		}
	}
}

func TestACallEstablishesAnOutcomeExceptWhenDropped(t *testing.T) {
	// Every one of these says something definite about the call — including the fact
	// that nobody picked up — so each may restate a promise-holding lead's status.
	for _, label := range []string{
		"Answered — Not Interested", "Not Interested", "Not Ready Yet",
		"Answered — Interested", "Promise to Pay",
		"No Answer", "Unreachable / No Answer",
	} {
		if !outcomeKnownFor(label) {
			t.Errorf("%q should establish an outcome, but outcomeKnown=false", label)
		}
	}
	// Picked up and died within seconds: nothing was established, so the lead keeps
	// whatever it already said rather than being reset to "never worked".
	if outcomeKnownFor("Call Dropped") {
		t.Error("\"Call Dropped\" must NOT restate a lead's status, but outcomeKnown=true")
	}
}

// The invariant that keeps this working as dispositions are added: any disposition
// mapping to a status that ranks BELOW 'callback' must set outcomeKnown, or the rank
// guard silently freezes the lead again — which is exactly how this bug arrived, twice.
//
// Dispositions mapping to a rank >= 'callback' are exempt: the rank comparison already
// moves those, so the flag never decides anything for them.
func TestDispositionsBelowCallbackAlwaysRestateTheStatus(t *testing.T) {
	callbackRank := ccLeadStatusRank["callback"]
	for _, d := range ccDispositions {
		if d.Code == "call_dropped" {
			continue // establishes nothing, by design
		}
		label := d.Label
		status := leadStatusFromCall(ccCallOutcome(d), &label)
		if ccLeadStatusRank[status] >= callbackRank {
			continue // moved by the rank guard alone
		}
		if !outcomeKnownFor(label) {
			t.Errorf("disposition %q (%s) maps to %q (rank %d, below callback) but "+
				"outcomeKnown=false — a promised callback logged with it would freeze",
				d.Code, d.Label, status, ccLeadStatusRank[status])
		}
	}
}

// The promise must survive a no-answer. callback_at is cleared only when the call
// actually resolved the matter; 'no_answer' and 'pending' leave it standing so the
// queue still rings the customer back. This asserts the statuses that CASE keys on,
// so a rename of either cannot quietly drop promises on the floor.
func TestNoAnswerKeepsThePromiseAlive(t *testing.T) {
	for _, label := range []string{"No Answer", "Unreachable / No Answer"} {
		if got := leadStatusFromCall("", &label); got != "no_answer" {
			t.Errorf("leadStatusFromCall(%q) = %q — callback_at is preserved only for "+
				"'no_answer'/'pending', so the promise would be discarded", label, got)
		}
	}
	dropped := "Call Dropped"
	if got := leadStatusFromCall("", &dropped); got != "pending" {
		t.Errorf("leadStatusFromCall(%q) = %q, want \"pending\" — otherwise a dropped "+
			"call discards the promise", dropped, got)
	}
}
