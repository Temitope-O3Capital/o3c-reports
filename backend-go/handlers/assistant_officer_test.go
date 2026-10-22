package handlers

import (
	"strings"
	"testing"
)

// Names arrive in one order and are stored in the other.
func TestNameTokensIgnoreOrderAndPunctuation(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Kehinde Ajayi", "kehinde ajayi"},
		{"Ajayi Kehinde", "ajayi kehinde"},
		{"  AJAYI,  Kehinde  ", "ajayi kehinde"},
		{"Kehinde A Ajayi", "kehinde ajayi"}, // a lone initial matches anything
		{"", ""},
		{"K", ""},
	}
	for _, c := range cases {
		if got := assistantNameTokens(c.in); got != c.want {
			t.Errorf("assistantNameTokens(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The chart is no longer volunteered. It must appear when asked for and not
// otherwise, because an unasked-for graph under every figure is what made the
// assistant feel like a dashboard instead of an answer.
func TestChartOnlyWhenTheQuestionAsksForOne(t *testing.T) {
	wants := []string{
		"show me a chart of revenue",
		"can I get a graph of collections",
		"plot the loan book",
		"revenue as a chart please",
		"visualise the card portfolio",
	}
	for _, q := range wants {
		if !assistantWantsVisual(q) {
			t.Errorf("%q should ask for a visual", q)
		}
	}
	notWants := []string{
		"how much are we holding in fixed deposits",
		"how many customers has team Jennifer reached out to this week",
		"who is the CEO",
		"draft an email to a customer whose card was declined",
		"how much has Kehinde Ajayi brought in",
		// "chart" inside an unrelated word must not trigger it.
		"what is our uncharted exposure",
		"give me a breakdown by month",
		"show me a breakdown of the deposit book",
	}
	for _, q := range notWants {
		if assistantWantsVisual(q) {
			t.Errorf("%q should NOT trigger a chart", q)
		}
	}
}

// The staff/customer guard. This is the one that disclosed two members of the
// public's transaction totals as an employee's sales production.
func TestAStaffNameIsNotLookedUpAsACustomer(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_customer_transactions",
		map[string]any{"customer": "Kehinde Ajayi", "days": 365})

	if _, leaked := out["activity"]; leaked {
		t.Error("returned customer activity for a colleague's name")
	}
	if _, leaked := out["transactions"]; leaked {
		t.Error("returned a transaction total for a colleague's name")
	}
	staff, _ := out["is_a_colleague_not_a_customer"].([]map[string]any)
	if len(staff) == 0 {
		t.Fatalf("did not recognise Kehinde Ajayi as a colleague: %v", out)
	}
	note := asString(out["note"])
	if !strings.Contains(note, "get_officer_production") {
		t.Errorf("note does not redirect to the officer tool: %q", note)
	}
}

// And the question that was asked in the first place must now be answerable.
func TestOfficerProductionFindsADepositBookedUnderTheOtherNameOrder(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_officer_production",
		map[string]any{"officer": "Kehinde Ajayi", "days": 3650})

	if found, _ := out["found"].(bool); !found {
		t.Fatalf("no officer matched 'Kehinde Ajayi', though CBS holds 'Ajayi Kehinde': %v", out)
	}
	matched, _ := out["matched_officer_names"].([]map[string]any)
	if len(matched) == 0 {
		t.Fatal("found=true but no officer name reported, so the answer cannot name them")
	}
	fd, _ := out["fixed_deposits"].(map[string]any)
	if fd == nil {
		t.Fatal("no fixed_deposits block")
	}
	t.Logf("matched %v", asString(matched[0]["officer"]))
	t.Logf("  deposits booked=%d  principal=%s  still active=%d",
		asInt(fd["deposits_booked"]), asString(fd["principal_ngn"]), asInt(fd["still_active"]))
	if asInt(fd["deposits_booked"]) == 0 {
		t.Error("matched the officer but counted no deposits")
	}
}

// Finding nobody is not the same as producing nothing, and the difference is a
// wrong answer that looks right.
func TestAnUnknownOfficerIsNotReportedAsZeroProduction(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_officer_production",
		map[string]any{"officer": "Zephaniah Quillbottom"})
	if found, _ := out["found"].(bool); found {
		t.Error("an unknown name reported found=true")
	}
	note := strings.ToLower(asString(out["note"]))
	if !strings.Contains(note, "not recorded as an") {
		t.Errorf("note does not distinguish 'not an officer' from 'produced nothing': %q", note)
	}
}
