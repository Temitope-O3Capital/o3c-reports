package handlers

import (
	"strings"
	"testing"
)

// What a borrower is actually called their product in the first line of a demand for
// money. These are not invented inputs: every string on the left is a real distinct
// product_name in app.collections_delinquent_unified on 2026-10-06, and the counts are
// how many delinquent facilities carry it. Interpolated raw — which is what happened
// until this test existed — they produced "Your Loan (uploaded) with O3 Capital is 5
// days past due" and "Your MEMCOS with O3 Capital...".
//
// An empty expectation is not a gap. It means the stored value cannot be shown to a
// customer at all, so the template's {{facility|account}} default takes over and the
// sentence reads "Your account with O3 Capital is 5 days past due". See
// TestFacilityLabelFallsBackToTheGenericNoun, which pins that against the real renderer.
func TestDunningFacilityLabelOnEveryRealProductName(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"Classic Accounts", "Classic Account"},                           // 494
		{"PREP", ""},                                                      // 155 — a bare code
		{"Prestige Accounts", "Prestige Account"},                         // 152
		{"SSANU-UI Account", "SSANU-UI Account"},                          // 130 — compound stays joined
		{"Amex Naira", "Amex Naira card"},                                 // 82 — needs its noun
		{"Platinum Accounts", "Platinum Account"},                         // 82
		{"LIRS COOP Account", "LIRS COOP Account"},                        // 80 — both acronyms kept
		{"BB Classic Account", "Classic Account"},                         // 60 — "BB" is our channel
		{"MEMCOS", ""},                                                    // 40 — a bare code
		{"Business Accounts", "Business Account"},                          // 39
		{"Amex USD", "Amex USD card"},                                     // 30
		{"SME LOAN ", "SME Loan"},                                         // 29 — trailing space, shouted
		{"AIRTEL", ""},                                                    // 18 — a bare code
		{"Loan (uploaded)", "Loan"},                                       // 13 — names the import
		{"Charge Accounts", "Charge Account"},                             // 8
		{"INSIGHT COOP Account", "Insight COOP Account"},                  // 6
		{"CONSUMER LOAN ", "Consumer Loan"},                               // 5
		{"Classic Accounts- Contactless", "Classic Account - Contactless"}, // 3
		{"Business Account  Instalment 1", "Business Account"},            // 2 — double space
		{"Business Account Instalment 2", "Business Account"},             // 2
		{"GAME", ""},                                                      // 2 — a bare code
		{"NOHIL COOP Accounts", "NOHIL COOP Account"},                     // 2
		{"LBIC COOP ACCOUNT", "LBIC COOP Account"},                        // 2
		{"Business Account 2", "Business Account"},                         // 2
		{"Financial Inclusion Account", "Financial Inclusion Account"},    // 1 — already right
		{"Business Account Instalment 3", "Business Account"},             // 1
		{"Fixed Classic Accounts", "Fixed Classic Account"},               // 1
	}
	for _, c := range cases {
		if got := dunningFacilityLabel(c.raw); got != c.want {
			t.Errorf("dunningFacilityLabel(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

// The grammar fault this change fixes. Every template says "is" or "has been" about
// this phrase — "Your {{facility|account}} with O3 Capital is {{dpd}} days past due" —
// so a plural product name produced "Your Classic Accounts ... is 5 days past due" on
// 494 facilities, the largest product in the book. Fixing the noun fixes the agreement
// in all six templates on all three channels without touching a line of copy.
func TestFacilityLabelIsAlwaysSingular(t *testing.T) {
	plural := map[string]bool{"accounts": true, "loans": true, "cards": true}
	for _, raw := range dunningRealProductNames() {
		for _, tok := range strings.Fields(dunningFacilityLabel(raw)) {
			if plural[strings.ToLower(tok)] {
				t.Errorf("dunningFacilityLabel(%q) contains the plural %q, so the template's "+
					"\"is\" no longer agrees", raw, tok)
			}
		}
	}
}

// Nothing internal survives into the sentence: no import artefact in brackets, no
// instalment numbering of ours, no shouting, and no stray whitespace from the source.
func TestFacilityLabelCarriesNothingInternal(t *testing.T) {
	for _, raw := range dunningRealProductNames() {
		got := dunningFacilityLabel(raw)
		if got == "" {
			continue
		}
		switch {
		case strings.ContainsAny(got, "()"):
			t.Errorf("%q -> %q still carries a parenthetical", raw, got)
		case strings.Contains(got, "  ") || got != strings.TrimSpace(got):
			t.Errorf("%q -> %q has untidy whitespace", raw, got)
		case strings.Contains(strings.ToLower(got), "instalment") ||
			strings.Contains(strings.ToLower(got), "installment"):
			t.Errorf("%q -> %q still carries our instalment numbering", raw, got)
		}
		for _, tok := range strings.Fields(got) {
			// A compound is judged part by part: SSANU-UI is two acronyms, not shouting.
			for _, part := range strings.Split(tok, "-") {
				if part == "" || dunningFacilityAcronyms[part] {
					continue
				}
				if part == strings.ToUpper(part) && len(part) > 1 {
					t.Errorf("%q -> %q still shouts %q; add it to dunningFacilityAcronyms "+
						"if that is deliberate", raw, got, part)
				}
			}
		}
	}
}

// The blank contract, against the renderer that has to honour it. dunningFacilityLabel
// returning "" is only safe because renderTemplate falls back to a {{field|default}} on
// a BLANK value and not merely a missing one — if that ever changed, 215 borrowers on
// PREP, MEMCOS, AIRTEL and GAME would receive "Your  with O3 Capital is 5 days past due".
func TestFacilityLabelFallsBackToTheGenericNoun(t *testing.T) {
	const line = "Your {{facility|account}} with O3 Capital is {{dpd}} days past due"
	for _, raw := range []string{"PREP", "MEMCOS", "AIRTEL", "GAME"} {
		merge := map[string]any{"facility": dunningFacilityLabel(raw), "dpd": 5}
		want := "Your account with O3 Capital is 5 days past due"
		if got := renderTemplate(line, merge); got != want {
			t.Errorf("%q renders %q, want %q", raw, got, want)
		}
	}
	// And a real name still displaces the default.
	merge := map[string]any{"facility": dunningFacilityLabel("Classic Accounts"), "dpd": 5}
	want := "Your Classic Account with O3 Capital is 5 days past due"
	if got := renderTemplate(line, merge); got != want {
		t.Errorf("rendered %q, want %q", got, want)
	}
}

// A bare shouted code is refused by SHAPE, not by name, so the next PREP somebody adds
// upstream reaches the generic noun instead of a borrower's letter.
func TestUnmappedBareCodesAreRefusedByShape(t *testing.T) {
	for _, code := range []string{"XYZCO", "FLEXI", "WEMA", "QQ"} {
		if got := dunningFacilityLabel(code); got != "" {
			t.Errorf("unmapped bare code %q rendered as %q; it should fall back to the "+
				"generic noun rather than reach a customer", code, got)
		}
	}
	// Two words is a product name, not a code, so it is allowed through tidied.
	if got := dunningFacilityLabel("FLEXI SAVINGS ACCOUNT"); got != "Flexi Savings Account" {
		t.Errorf("multi-word name = %q, want %q", got, "Flexi Savings Account")
	}
}

// dunningRealProductNames is every distinct product_name carrying delinquency on
// 2026-10-06, so the invariants above run over the real book rather than examples.
func dunningRealProductNames() []string {
	return []string{
		"Classic Accounts", "PREP", "Prestige Accounts", "SSANU-UI Account", "Amex Naira",
		"Platinum Accounts", "LIRS COOP Account", "BB Classic Account", "MEMCOS",
		"Business Accounts", "Amex USD", "SME LOAN ", "AIRTEL", "Loan (uploaded)",
		"Charge Accounts", "INSIGHT COOP Account", "CONSUMER LOAN ",
		"Classic Accounts- Contactless", "Business Account  Instalment 1",
		"Business Account Instalment 2", "GAME", "NOHIL COOP Accounts", "LBIC COOP ACCOUNT",
		"Business Account 2", "Financial Inclusion Account", "Business Account Instalment 3",
		"Fixed Classic Accounts",
	}
}
