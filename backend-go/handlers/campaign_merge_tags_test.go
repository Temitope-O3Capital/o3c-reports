package handlers

import "testing"

// The email builder advertises a strip of merge tags, and renderTemplate resolves
// anything it cannot fill to the EMPTY STRING. That combination is silent: a tag
// nobody fills does not render as a mistake, it renders as nothing, and the
// customer receives a sentence with a hole in it. These tests pin which tags a
// campaign can actually fill, so the strip and the sender cannot drift apart again.

func mergeDataForTest() map[string]any {
	return campaignContactMergeData(map[string]any{
		"first_name": "Adaeze",
		"last_name":  "Okonkwo",
		"phone":      "08031234567",
		"email":      "adaeze@example.com",
		"cif_number": "CIF00412",
	})
}

func TestEveryTagTheBuilderOffersIsFilled(t *testing.T) {
	d := mergeDataForTest()
	// Exactly the MERGE_TAGS strip in EmailBlockEditor.tsx.
	for _, key := range []string{"first_name", "last_name", "full_name", "phone", "email", "cif"} {
		got := renderTemplate("{{"+key+"}}", d)
		if got == "" {
			t.Errorf("{{%s}} is offered in the email builder but renders empty", key)
		}
	}
}

func TestCifIsAnAliasOfCifNumber(t *testing.T) {
	d := mergeDataForTest()
	if got := renderTemplate("{{cif}}", d); got != "CIF00412" {
		t.Fatalf("{{cif}} = %q, want CIF00412", got)
	}
	if got := renderTemplate("{{cif_number}}", d); got != "CIF00412" {
		t.Fatalf("{{cif_number}} = %q, want CIF00412", got)
	}
}

// merge_data from the contact list must win over the alias, so a list that carries
// its own cif is not overwritten by the snapshot column.
func TestListMergeDataWinsOverTheAlias(t *testing.T) {
	d := campaignContactMergeData(map[string]any{
		"cif_number": "FROM_COLUMN",
		"merge_data":  `{"cif":"FROM_LIST"}`,
	})
	if got := renderTemplate("{{cif}}", d); got != "FROM_LIST" {
		t.Fatalf("{{cif}} = %q, want the list's own value FROM_LIST", got)
	}
}

func TestAnUnfillableTagRendersEmptyWhichIsWhyFallbacksMatter(t *testing.T) {
	d := mergeDataForTest()
	// This is the trap, asserted so nobody "fixes" it by accident.
	if got := renderTemplate("Balance: {{amount}}", d); got != "Balance: " {
		t.Fatalf("unknown tag = %q, want it to collapse to empty", got)
	}
	// The fallback form the builder now inserts for context-only tags.
	if got := renderTemplate("Balance: {{amount|—}}", d); got != "Balance: —" {
		t.Fatalf("fallback form = %q, want Balance: —", got)
	}
	// A filled tag still beats its fallback.
	if got := renderTemplate("{{first_name|there}}", d); got != "Adaeze" {
		t.Fatalf("filled tag with fallback = %q, want Adaeze", got)
	}
}

// cta_url was the default URL on every button block, and nothing fills it, so the
// main call to action in every starter template rendered as href="". The default is
// now empty and surfaced in the UI; this guards the reason.
func TestCtaUrlIsNotSomethingACampaignCanFill(t *testing.T) {
	d := mergeDataForTest()
	if got := renderTemplate("{{cta_url}}", d); got != "" {
		t.Fatalf("{{cta_url}} = %q — if this is now fillable, the button default should use it", got)
	}
}
