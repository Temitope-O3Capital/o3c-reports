package handlers

import "testing"

// The Interested guard keys on a disposition CODE, but every client sends a LABEL
// ("Interested", "Answered — Interested") and the normaliser is a top-to-bottom switch
// of substring tests. So the rule is only as good as that resolution: if a label stops
// resolving to answered_interested, the guard silently stops asking for a location and
// leads start reaching Sales with nowhere to visit them — which is the exact state this
// work was done to fix, and it would fail open rather than loudly.
//
// Equally important is the other direction. "Not Interested" contains "Interested" as a
// substring, and a careless matcher would demand a city before an agent could record a
// refusal — turning a guard meant to help Sales into an obstruction on the one
// disposition that needs no location at all.
func TestOnlyInterestedDemandsALocation(t *testing.T) {
	demands := []string{
		"Interested",
		"interested",
		"Answered — Interested",
		"Answered-Interested",
		"answered_interested",
	}
	for _, d := range demands {
		if !leadLocationRequired(d) {
			t.Errorf("disposition %q should require a location (resolved to %q)",
				d, ccDispositionCode(d))
		}
	}

	// Everything else records an outcome that does not hand the lead to Sales, so none
	// of it may block on a location. "Not Interested" and "Not Ready Yet" are the ones
	// a substring match gets wrong.
	allows := []string{
		"Not Interested",
		"not interested",
		"Answered — Not Interested",
		"Not Ready Yet",
		"Not Eligible",
		"Callback Scheduled",
		"Wrong Number",
		"Do Not Call",
		"Unreachable / No Answer",
		"Converted",
		"Issue Resolved",
		"Other",
		"",
	}
	for _, d := range allows {
		if leadLocationRequired(d) {
			t.Errorf("disposition %q must NOT require a location (resolved to %q)",
				d, ccDispositionCode(d))
		}
	}
}

// missing() drives which boxes the prompt opens with, so it has to name exactly the
// fields that are absent — and treat whitespace as absent, because " " is what a form
// sends when someone tabs through a field without typing.
func TestMissingNamesOnlyTheBlankFields(t *testing.T) {
	cases := []struct {
		name string
		loc  leadLocation
		want []string
	}{
		{"both present", leadLocation{City: "Ikeja", State: "Lagos"}, nil},
		{"no city", leadLocation{State: "Lagos"}, []string{"city"}},
		{"no state", leadLocation{City: "Ikeja"}, []string{"state"}},
		{"neither", leadLocation{}, []string{"city", "state"}},
		{"whitespace only", leadLocation{City: "  ", State: "\t"}, []string{"city", "state"}},
		{"address is not a substitute", leadLocation{Address: "12 Allen Avenue"}, []string{"city", "state"}},
	}
	for _, c := range cases {
		got := c.loc.missing()
		if len(got) != len(c.want) {
			t.Errorf("%s: missing() = %v, want %v", c.name, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: missing() = %v, want %v", c.name, got, c.want)
				break
			}
		}
	}
}
