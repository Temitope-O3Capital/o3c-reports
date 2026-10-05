package handlers

import "testing"

// logLeadActivity now accepts a disposition, validated against the SAME salesDispositions
// vocabulary My Day uses. These pin the contract between the two, because the two lists are
// keyed differently — salesDispositions by activity kind, leadActivityLabel by every kind a
// lead can be logged against — and a drift between them fails silently rather than loudly.

// A forward kind IS its own outcome: "Documents Requested" names the result, not the
// attempt. logLeadActivity refuses a disposition sent with one, so a forward kind that also
// carried codes would make a legitimately offered outcome unsendable.
func TestForwardLeadKindsCarryNoDispositions(t *testing.T) {
	for kind := range leadActivityStage {
		if list, ok := salesDispositions[kind]; ok && len(list) > 0 {
			t.Errorf("%q moves the lead forward but also has %d dispositions — logLeadActivity "+
				"rejects a disposition on a forward kind, so these could never be used",
				kind, len(list))
		}
	}
}

// The two kinds where the outcome is the whole point. If either lost its codes the lead
// drawer would render no "What Came Of It?" picker at all and quietly go back to storing
// prose, which is the defect this change fixes.
//
// 'visit' deliberately has codes but is NOT a lead kind: a visit is logged against the
// officer's day, not against a lead. 'email' and 'note' deliberately have none — a note is
// the record itself rather than the result of an attempt.
func TestLeadRecordKindsThatNeedAnOutcomeHaveOne(t *testing.T) {
	for _, kind := range []string{"call", "meeting"} {
		if _, known := leadActivityLabel[kind]; !known {
			t.Fatalf("%q is no longer a kind a lead can be logged against", kind)
		}
		if _, moves := leadActivityStage[kind]; moves {
			t.Errorf("%q now moves the lead by itself, which changes what its outcome means", kind)
		}
		if len(salesDispositions[kind]) == 0 {
			t.Errorf("%q has no dispositions, so the lead drawer offers no outcome and falls back "+
				"to free text", kind)
		}
	}
}

// findSalesDisposition returns the FIRST match, so a duplicated code silently shadows
// whatever follows it — including, potentially, a different NeedsNote or Advances.
func TestDispositionCodesAreUniqueWithinAKind(t *testing.T) {
	for kind, list := range salesDispositions {
		seen := map[string]bool{}
		for _, d := range list {
			if seen[d.Code] {
				t.Errorf("%s has two dispositions coded %q; findSalesDisposition would only ever "+
					"return the first", kind, d.Code)
			}
			seen[d.Code] = true
		}
	}
}

// Every code the lead drawer can send must resolve for the kind it was offered under.
// Scoping is what keeps "Did Not Get Past Reception" off a phone call, and a lookup that
// ignored the kind would let the browser post it anyway.
func TestDispositionsResolveOnlyForTheirOwnKind(t *testing.T) {
	for kind, list := range salesDispositions {
		for _, d := range list {
			if _, ok := findSalesDisposition(kind, d.Code); !ok {
				t.Errorf("%s/%s does not resolve under its own kind", kind, d.Code)
			}
			for other := range salesDispositions {
				if other == kind {
					continue
				}
				if _, ok := findSalesDisposition(other, d.Code); ok {
					// Shared codes across kinds are allowed by design where the act is the
					// same; this flags only the ones that are NOT also declared there.
					found := false
					for _, od := range salesDispositions[other] {
						if od.Code == d.Code {
							found = true
							break
						}
					}
					if !found {
						t.Errorf("%s/%s leaks into kind %q", kind, d.Code, other)
					}
				}
			}
		}
	}
}
