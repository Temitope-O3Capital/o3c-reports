package handlers

import "testing"

// A promised callback that has actually been dialled must stop reading as "Callback".
//
// The bug this locks down: 'callback' ranks 3 in ccLeadStatusRank, above 'called' (1)
// and 'not_ready' (2). syncLeadFromCall's forward-only guard therefore refused to move
// a lead off 'callback' when the promised call was made and answered "Not Interested"
// (→ 'called'), so 25 leads sat showing an outstanding callback for a conversation that
// had already happened. The fix lets a REAL conversation resolve a lead that is merely
// holding a promise, while still refusing to walk an earned status backwards.
//
// These tests cover the Go half — the status mapping and the `fulfilled` flag derived
// from it. The decision itself lives in the UPDATE's CASE, which is exercised against
// Postgres; what matters here is that the inputs it relies on cannot drift.

// fulfilledFor mirrors the derivation in syncLeadFromCall exactly.
func fulfilledFor(label string) bool {
	s := leadStatusFromCall("", &label)
	return s != "no_answer" && s != "pending"
}

func TestLeadStatusFromCallKeyDispositions(t *testing.T) {
	for _, c := range []struct{ label, want string }{
		// The two that were freezing leads on 'callback'.
		{"Answered — Not Interested", "called"},
		{"Not Interested", "called"},
		{"Not Ready Yet", "not_ready"},
		// Must NOT resolve a promise: nobody spoke.
		{"No Answer", "no_answer"},
		{"Unreachable / No Answer", "no_answer"},
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

func TestPromiseIsResolvedOnlyByARealConversation(t *testing.T) {
	// Reaching the customer resolves the promise…
	for _, label := range []string{
		"Answered — Not Interested", "Not Interested", "Not Ready Yet",
		"Answered — Interested", "Promise to Pay",
	} {
		if !fulfilledFor(label) {
			t.Errorf("%q should resolve a promised callback, but fulfilled=false", label)
		}
	}
	// …and these two must not: nothing was discussed, so the promise still stands.
	for _, label := range []string{"No Answer", "Unreachable / No Answer", "Call Dropped"} {
		if fulfilledFor(label) {
			t.Errorf("%q must NOT resolve a promised callback, but fulfilled=true", label)
		}
	}
}

// The invariant that keeps the fix working as dispositions are added: whenever a
// disposition represents a real conversation AND maps to a status ranking below
// 'callback', `fulfilled` must be true — otherwise the rank guard silently freezes the
// lead again, which is exactly how this bug arrived.
//
// Dispositions mapping to a rank >= 'callback' are exempt: the rank comparison already
// moves those, so the flag never decides anything for them ("Wrong Number" is the live
// example — not Connected, yet it maps to 'invalid' at rank 5 and moves regardless).
func TestConnectedDispositionsBelowCallbackAlwaysResolve(t *testing.T) {
	callbackRank := ccLeadStatusRank["callback"]
	for _, d := range ccDispositions {
		realConversation := d.Connected && d.Code != "call_dropped"
		if !realConversation {
			continue
		}
		label := d.Label
		status := leadStatusFromCall(ccCallOutcome(d), &label)
		if ccLeadStatusRank[status] >= callbackRank {
			continue // moved by the rank guard alone
		}
		if !fulfilledFor(label) {
			t.Errorf("disposition %q (%s) maps to %q (rank %d, below callback) but "+
				"fulfilled=false — a promised callback logged with it would freeze",
				d.Code, d.Label, status, ccLeadStatusRank[status])
		}
	}
}
