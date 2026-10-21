package handlers

import (
	"strings"
	"testing"
)

// The gap between how staff ask and how the column stores it. Each case below
// is a phrasing someone would actually type.
func TestRoleTokenNormalisesHowPeopleAsk(t *testing.T) {
	cases := map[string]string{
		"MD":                       "md",
		"the MD":                   "md",
		"CEO":                      "ceo",
		"head of risk":             "risk",
		"risk head":                "risk_head",
		"Head of Internal Control": "internal_control",
		"chief financial officer":  "financial_officer",
		"who is the CFO":           "cfo",
		"head of the sales team":   "sales",
		"HR":                       "hr",
		"call centre":              "call_centre",
	}
	for in, want := range cases {
		if got := assistantRoleToken(in); got != want {
			t.Errorf("assistantRoleToken(%q) = %q, want %q", in, got, want)
		}
	}
}

// The one that matters most: in a Nigerian bank the person others would call
// the CEO is the MD. Get this wrong and the most senior person in the company
// is unfindable.
func TestCeoResolvesToMd(t *testing.T) {
	for _, q := range []string{"CEO", "ceo", "chief executive", "managing director", "MD", "the MD"} {
		got := assistantRoleCandidates(q)
		if len(got) != 1 || got[0] != "md" {
			t.Errorf("%q resolved to %v, want [md]", q, got)
		}
	}
}

func TestRoleCandidatesCoverTheRealVocabulary(t *testing.T) {
	// Every value below is a role actually present in app.o3c_users.
	cases := map[string]string{
		"head of risk":               "risk_head",
		"who heads internal control": "internal_control_head",
		"audit":                      "internal_control_head",
		"head of cards":              "cards_head",
		"head of operations":         "head_ops",
		"CFO":                        "cfo",
		"COO":                        "coo",
		"CMO":                        "cmo",
		"head of sales":              "sales_head",
		"compliance":                 "compliance_officer",
		"human resources":            "hr",
		"head of customer care":      "care_head",
		"contact centre":             "call_center_head",
	}
	for q, want := range cases {
		got := assistantRoleCandidates(q)
		found := false
		for _, g := range got {
			if g == want {
				found = true
			}
		}
		if !found {
			t.Errorf("%q resolved to %v, which does not include %q", q, got, want)
		}
	}
}

// An ambiguous question should offer both rather than silently picking one.
// "Who handles settlements" could mean the head or the officers, and an answer
// that names only one of them is a wrong answer dressed as a complete one.
func TestAmbiguousRolesReturnEveryCandidate(t *testing.T) {
	got := assistantRoleCandidates("settlements")
	if len(got) < 2 {
		t.Fatalf("settlements resolved to %v, expected both the head and the officers", got)
	}
	if !strings.Contains(strings.Join(got, ","), "settlement_head") {
		t.Errorf("settlements should include settlement_head, got %v", got)
	}
}

// An unknown phrase must still produce something searchable, because the loose
// match on the role column may well find a role nobody has asked for before.
func TestUnknownRoleStillReturnsItsOwnToken(t *testing.T) {
	if got := assistantRoleCandidates("head of treasury"); len(got) != 1 || got[0] != "treasury" {
		t.Errorf("unknown role gave %v, want [treasury]", got)
	}
	if got := assistantRoleCandidates("   "); len(got) != 1 || got[0] != "" {
		t.Errorf("blank gave %v, want [\"\"]", got)
	}
}
