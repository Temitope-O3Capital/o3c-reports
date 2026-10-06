package handlers

import "testing"

// TestEveryDispositionHasALeadStatus is the completeness half of the fix.
//
// leadStatusFromCall used to be a substring matcher, so a disposition it had not been
// told about fell through to a bare "called" — silently, and for nine of the catalogue's
// entries at once. Deriving the answer from a table only helps if the table is complete,
// so this fails the moment a disposition is added without deciding what it means for a
// lead. "other" is the one deliberate absence: it means "I cannot tell you from the
// dropdown", so there is nothing to decide.
func TestEveryDispositionHasALeadStatus(t *testing.T) {
	for _, d := range ccDispositions {
		if d.Code == "other" {
			if _, ok := ccLeadStatusByDisposition[d.Code]; ok {
				t.Errorf("'other' should NOT have a lead status — it carries no information " +
					"to infer one from, and leaving it out lets the substring fallback read " +
					"the free text instead")
			}
			continue
		}
		status, ok := ccLeadStatusByDisposition[d.Code]
		if !ok {
			t.Errorf("disposition %q (%q) has no lead status — decide what this outcome "+
				"means for a lead rather than letting it fall through to \"called\"",
				d.Code, d.Label)
			continue
		}
		if !ccLeadStatuses[status] {
			t.Errorf("disposition %q maps to lead status %q, which call_center_leads_status_chk "+
				"does not allow", d.Code, status)
		}
	}
	// Nothing in the table may name a disposition that no longer exists, or the entry
	// becomes dead weight nobody dares delete.
	for code := range ccLeadStatusByDisposition {
		if _, ok := ccDispositionByCode(code); !ok {
			t.Errorf("ccLeadStatusByDisposition has an entry for %q, which is not a "+
				"disposition in the catalogue", code)
		}
	}
}

// TestLeadStatusMatchesContactStatus pins the one invariant that must never break.
//
// A disposition that leaves the CONTACT open (Status "", meaning it rests for the cooldown
// and returns to the queue) must never give the LEAD a terminal status. Terminal is
// absolute: 'converted', 'closed', 'invalid' and 'dnc' share rank 5 in ccLeadStatusRank
// and the forward-only guard means nothing later can move a lead out of them. So the
// combination this test forbids is a queue that keeps calling someone whose lead can no
// longer record what the next call found.
//
// The reverse is NOT asserted, and that is deliberate. A customer DECLINE closes the
// contact while leaving the lead workable at 'called' — "Answered — Not Interested" has
// always worked that way, with leadDeclinedOnCall built to handle the consequence, and
// "Rate or Charges Too High" follows the same precedent. Asserting symmetry here would
// force price_objection to close a lead that may well buy next quarter.
func TestLeadStatusMatchesContactStatus(t *testing.T) {
	terminal := map[string]bool{"converted": true, "closed": true, "invalid": true, "dnc": true}
	for _, d := range ccDispositions {
		status, ok := ccLeadStatusByDisposition[d.Code]
		if !ok {
			continue // covered by TestEveryDispositionHasALeadStatus
		}
		if d.Status == "" && terminal[status] {
			t.Errorf("%q leaves the CONTACT open but gives the LEAD terminal status %q "+
				"(rank %d) — the queue will call this person again and the lead will not "+
				"be able to record the result", d.Code, status, ccLeadStatusRank[status])
		}
		// Rank 5 and the terminal set must stay the same set; if someone adds a status to
		// one and not the other, the check above quietly stops checking anything.
		if terminal[status] != (ccLeadStatusRank[status] == 5) {
			t.Errorf("lead status %q: terminal=%v but rank=%d — the two definitions of "+
				"terminal have drifted", status, terminal[status], ccLeadStatusRank[status])
		}
	}
}

// TestLeadStatusAgreesWithTheDispositionCatalogue walks the catalogue through the real
// entry point, by LABEL, which is what every screen actually sends.
//
// The nine that used to disagree are listed explicitly rather than derived, because the
// point of the test is that these specific outcomes now reach the lead instead of
// collapsing into "called". Each expectation is the catalogue's own Hint, read as a
// sentence about the lead.
func TestLeadStatusAgreesWithTheDispositionCatalogue(t *testing.T) {
	cases := []struct {
		label, want, why string
	}{
		{"Information Sent — Awaiting Reply", "callback", "a reply is owed, so a follow-up is owed"},
		{"Customer Rejected the Call", "no_answer", "Connected is false — nobody spoke"},
		{"Registration Not Completed", "callback", "someone has to finish it with them"},
		{"Nothing Due This Cycle", "not_ready", "too early, not a refusal"},
		{"Escalated", "callback", "stays open until whoever has it closes it out"},
		{"Complaint Logged", "callback", "stays open until it is answered"},
		{"Pending / Follow-up", "callback", "unfinished by its own definition"},
		{"Wants a Product We Do Not Offer", "closed", "our decline — nothing a later call changes"},
		{"Information Provided", "closed", "their question was answered"},
		// Unchanged, and asserted so the table cannot quietly make them terminal.
		{"Rate or Charges Too High", "called", "a customer decline, for a reason that can change"},
		{"Answered — Not Interested", "called", "the precedent price_objection follows"},
		{"Says They Have Paid — To Verify", "callback", "never converted on an unverified claim"},
		{"Other — Describe What Happened", "called", "nothing to infer; falls through to the matcher"},
	}
	for _, c := range cases {
		label := c.label
		if got := leadStatusFromCall("completed", &label); got != c.want {
			t.Errorf("%q → %q, want %q (%s)", c.label, got, c.want, c.why)
		}
	}
}

// TestDoNotCallIsRecognisedInEveryWording covers the DNC half.
//
// The obligation now hangs off ccDispositionAddsToDNC rather than off a fourth copy of
// strings.Contains(d, "do not call"), and it is reached on every logged call rather than
// only the two paths that happened to hold a lead_id or a contact_id. Whichever spelling
// a screen sends has to land on the catalogue entry, because a DNC that resolves to
// nothing is a regulatory gap that returns HTTP 201.
func TestDoNotCallIsRecognisedInEveryWording(t *testing.T) {
	for _, s := range []string{"do_not_call", "Do Not Call", "do not call", "DO NOT CALL"} {
		if !ccDispositionAddsToDNC(s) {
			t.Errorf("%q should add to the DNC list", s)
		}
	}
	// And must not fire on anything else — a false positive here suppresses a customer
	// who never asked to be.
	for _, d := range ccDispositions {
		if d.Code == "do_not_call" {
			continue
		}
		if ccDispositionAddsToDNC(d.Code) || ccDispositionAddsToDNC(d.Label) {
			t.Errorf("%q (%q) must not add to the DNC list", d.Code, d.Label)
		}
	}
	for _, s := range []string{"", "completed", "Not Interested", "Called, will call again"} {
		if ccDispositionAddsToDNC(s) {
			t.Errorf("%q must not add to the DNC list", s)
		}
	}
}
