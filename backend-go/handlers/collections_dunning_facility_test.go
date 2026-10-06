package handlers

import (
	"strings"
	"testing"
)

// What a borrower is actually called their product in the first line of a demand for
// money, for every product on the delinquent book on 2026-10-06.
//
// Nothing here is invented. raw is the product_name app.collections_delinquent_unified
// carries, catalog/category/coop are what app.card_products sells it as, and the trailing
// counts are delinquent facilities.
//
// The catalogue wins, and rows 1 and 5 are the reason. Deriving a label from the raw
// string produced "Classic Account" — but the product is a Classic CARD, on 494
// facilities, the largest on the book. And it produced "Amex Naira card", which would
// have printed American Express on 112 borrowers' demand letters for a product O3 sells
// as O3 Green Naira. A name is a fact to look up, not a string to derive.
type dunningFacilityCase struct {
	raw, catalog, category string
	coop                   bool
	want                   string
}

func dunningFacilityCases() []dunningFacilityCase {
	return []dunningFacilityCase{
		{"Classic Accounts", "Classic Card", "credit", false, "Classic Card"},    // 494
		{"PREP", "PREP", "prepaid", false, "prepaid card"},                       // 155 — a code
		{"Prestige Accounts", "Prestige Card", "credit", false, "Prestige Card"}, // 152
		{"SSANU-UI Account", "SSANU-UI", "credit", true, "SSANU-UI"},             // 130
		{"Amex Naira", "O3 Green Naira", "credit", false, "O3 Green Naira"},      // 82 — NOT Amex
		{"Platinum Accounts", "Platinum Card", "credit", false, "Platinum Card"}, // 82
		{"LIRS COOP Account", "LIRS COOP Card", "credit", true, "LIRS COOP Card"},         // 80
		{"BB Classic Account", "BB Classic Card", "credit", false, "BB Classic Card"},     // 60
		{"MEMCOS", "MEMCOS", "credit", true, "cooperative credit card"},                   // 40 — a code
		{"Business Accounts", "Business Card", "credit", false, "Business Card"},           // 39
		{"Amex USD", "O3 Green USD", "credit", false, "O3 Green USD"},                     // 30 — NOT Amex
		{"SME LOAN ", "", "", false, "SME Loan"},                                          // 29 — uncatalogued
		{"AIRTEL", "AIRTEL", "credit", false, "credit card"},                              // 18 — a code
		{"Loan (uploaded)", "", "", false, "Loan"},                                        // 13 — uncatalogued
		{"Charge Accounts", "FINTRACK Charge Card", "credit", false, "FINTRACK Charge Card"}, // 8
		{"INSIGHT COOP Account", "INSIGHT COOP Card", "credit", true, "INSIGHT COOP Card"},   // 6
		{"CONSUMER LOAN ", "", "", false, "Consumer Loan"},                                   // 5 — uncatalogued
		{"Classic Accounts- Contactless", "Classic Card Contactless", "credit", false,
			"Classic Card Contactless"}, // 3
		{"Business Account  Instalment 1", "Business Instalment 1", "credit", false,
			"Business Instalment 1"}, // 2
		{"Business Account Instalment 2", "Business Instalment 2", "credit", false,
			"Business Instalment 2"}, // 2
		{"GAME", "GAME", "credit", false, "credit card"},                      // 2 — a code
		{"NOHIL COOP Accounts", "NOHIL COOP", "credit", true, "NOHIL COOP"},   // 2
		{"LBIC COOP ACCOUNT", "LBIC COOP Credit", "credit", true, "LBIC COOP Credit"}, // 2
		{"Business Account 2", "Business Card 2", "credit", false, "Business Card 2"},  // 2
		{"Financial Inclusion Account", "Financial Inclusion", "prepaid", false,
			"Financial Inclusion"}, // 1
		{"Business Account Instalment 3", "Business Instalment 3", "credit", false,
			"Business Instalment 3"}, // 1
		{"Fixed Classic Accounts", "Fixed Classic Card", "credit", false, "Fixed Classic Card"}, // 1
	}
}

func TestDunningFacilityDisplayOnEveryRealProductName(t *testing.T) {
	for _, c := range dunningFacilityCases() {
		got := dunningFacilityDisplay(c.raw, c.catalog, c.category, c.coop)
		if got != c.want {
			t.Errorf("dunningFacilityDisplay(%q, %q, %q, %v) = %q, want %q",
				c.raw, c.catalog, c.category, c.coop, got, c.want)
		}
	}
}

// Whatever comes out has to be fit to appear in "Your ___ with O3 Capital is 5 days past
// due". Note what is NOT asserted: catalogue names may legitimately shout (INSIGHT COOP
// Card) and may legitimately end in a number (Business Instalment 2), because the
// catalogue is the authority on its own product names and this code is not here to
// improve them.
func TestEveryDisplayedNameIsFitForACustomerLetter(t *testing.T) {
	for _, c := range dunningFacilityCases() {
		got := dunningFacilityDisplay(c.raw, c.catalog, c.category, c.coop)
		switch {
		case got == "":
			t.Errorf("%q renders nothing, so the letter would read \"Your  with O3 Capital\"", c.raw)
		case strings.ContainsAny(got, "()"):
			t.Errorf("%q -> %q still carries a parenthetical", c.raw, got)
		case strings.Contains(got, "  ") || got != strings.TrimSpace(got):
			t.Errorf("%q -> %q has untidy whitespace", c.raw, got)
		case dunningLooksLikeBareCode(got):
			t.Errorf("%q -> %q is still a bare code", c.raw, got)
		}
		// The grammar fault: every template says "is" or "has been" about this phrase,
		// so a plural name produced "... Accounts is 5 days past due" on 494 facilities.
		for _, tok := range strings.Fields(got) {
			if l := strings.ToLower(tok); l == "accounts" || l == "loans" || l == "cards" {
				t.Errorf("%q -> %q is plural, so the template's \"is\" no longer agrees",
					c.raw, got)
			}
		}
	}
}

// An instalment number is part of the catalogue's name and must survive. The raw-string
// tidier strips a trailing number on purpose — "Business Account 2" is our own numbering
// — so running it over a catalogue name would quietly collapse four distinct products.
func TestCatalogueNamesAreNotTidied(t *testing.T) {
	for _, n := range []string{"Business Instalment 1", "Business Instalment 2",
		"Business Instalment 3", "Business Card 2"} {
		if got := dunningFacilityDisplay("whatever", n, "credit", false); got != n {
			t.Errorf("catalogue name %q came back as %q; it must be used as written", n, got)
		}
	}
}

// The uncatalogued fallback, on the only three values that reach it.
func TestDunningFacilityLabelOnTheUncataloguedLoans(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"SME LOAN ", "SME Loan"}, // trailing space, shouted
		{"CONSUMER LOAN ", "Consumer Loan"},
		{"Loan (uploaded)", "Loan"}, // the parenthetical names the import
	}
	for _, c := range cases {
		if got := dunningFacilityLabel(c.raw); got != c.want {
			t.Errorf("dunningFacilityLabel(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

// A code that is in neither the catalogue nor any rule has to degrade to a true
// sentence, and that only works because renderTemplate falls back to a {{field|default}}
// on a BLANK value and not merely a missing one. If that ever changed, the letter would
// read "Your  with O3 Capital is 5 days past due".
func TestUncataloguedBareCodeFallsBackToTheGenericNoun(t *testing.T) {
	const line = "Your {{facility|account}} with O3 Capital is {{dpd}} days past due"
	merge := map[string]any{"facility": dunningFacilityDisplay("XYZCO", "", "", false), "dpd": 5}
	want := "Your account with O3 Capital is 5 days past due"
	if got := renderTemplate(line, merge); got != want {
		t.Errorf("rendered %q, want %q", got, want)
	}
	// And a real name still displaces the default.
	merge = map[string]any{"facility": dunningFacilityDisplay("Classic Accounts", "Classic Card", "credit", false), "dpd": 5}
	want = "Your Classic Card with O3 Capital is 5 days past due"
	if got := renderTemplate(line, merge); got != want {
		t.Errorf("rendered %q, want %q", got, want)
	}
}

// Refused by SHAPE, not by name, so the next PREP added upstream reaches the generic
// noun rather than a borrower's letter.
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

// The kind-of-card fallback, for the four codes the catalogue cannot name either.
func TestDunningCardKindNamesWhatItCan(t *testing.T) {
	cases := []struct {
		category string
		coop     bool
		want     string
	}{
		{"credit", false, "credit card"},
		{"credit", true, "cooperative credit card"},
		{"prepaid", false, "prepaid card"},
		{"prepaid", true, "cooperative prepaid card"},
		{"blink", false, "card"}, // an internal category name: say nothing we cannot stand behind
		{"", false, "card"},
	}
	for _, c := range cases {
		if got := dunningCardKind(c.category, c.coop); got != c.want {
			t.Errorf("dunningCardKind(%q, %v) = %q, want %q", c.category, c.coop, got, c.want)
		}
	}
}
