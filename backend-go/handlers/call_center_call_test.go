package handlers

import "testing"

// normaliseNGPhone is the import-time twin of app.normalise_ng_phone. Both must
// agree, or a lead imported through the API and the same lead normalised in SQL
// would dedupe against each other inconsistently.
func TestNormaliseNGPhone(t *testing.T) {
	cases := map[string]string{
		"08033153664":       "08033153664",
		"+2348033153664":    "08033153664",
		"234 803 315 3664":  "08033153664",
		"8033153664":        "08033153664",
		"+234-803-315-3664": "08033153664",
		"0803 315 3664":     "08033153664",
		// Too short to be a phone number: rejected, which is what makes phone a
		// genuinely required field at import rather than a silently blank one.
		"123":        "",
		"":           "",
		"abcdefghij": "",
	}
	for in, want := range cases {
		if got := normaliseNGPhone(in); got != want {
			t.Errorf("normaliseNGPhone(%q) = %q, want %q", in, got, want)
		}
	}
}

// leadStatusFromCall replaces the Leads page's private four-outcome vocabulary
// with the disposition vocabulary the whole call centre shares.
func TestLeadStatusFromCall(t *testing.T) {
	s := func(v string) *string { return &v }

	cases := []struct {
		name        string
		outcome     string
		disposition *string
		want        string
	}{
		// The disposition is the stronger signal: a call that connected but whose
		// result is "Do Not Call" must not be filed as merely "called".
		{"dnc wins over connected", "completed", s("Do Not Call"), "dnc"},
		{"converted", "completed", s("Converted"), "converted"},
		{"callback", "completed", s("Callback Scheduled"), "callback"},
		{"not interested still called", "completed", s("Not Interested"), "called"},
		{"interested still called", "completed", s("Interested"), "called"},
		{"wrong number is invalid", "completed", s("Wrong Number"), "invalid"},
		{"unreachable", "missed", s("Unreachable / No Answer"), "no_answer"},

		// No disposition picked: fall back to the mechanical outcome.
		{"missed no disposition", "missed", nil, "no_answer"},
		{"voicemail", "voicemail", nil, "no_answer"},
		{"completed no disposition", "completed", nil, "called"},
		{"empty outcome", "", nil, "called"},

		// Case and spacing must not change the answer — dispositions are free text
		// coming from a select, and a stray capital should not silently reroute a
		// lead.
		{"case insensitive", "completed", s("  do not call  "), "dnc"},
	}
	for _, c := range cases {
		if got := leadStatusFromCall(c.outcome, c.disposition); got != c.want {
			t.Errorf("%s: leadStatusFromCall(%q, %v) = %q, want %q",
				c.name, c.outcome, c.disposition, got, c.want)
		}
	}
}

// The Log-a-Call form and the database must agree on the call purposes.
//
// They did not: the form offered "Outbound Sales" while
// helpdesk_calls_purpose_chk allowed only collections, marketing, support,
// retention and other. Every sales call an agent logged failed on the constraint
// and surfaced as a bare "Internal server error". This pins the vocabulary so the
// two cannot drift again — if the form gains a purpose, the migration that widens
// the constraint has to land with it.
func TestCallPurposeVocabularyMatchesConstraint(t *testing.T) {
	// Mirrors CALL_PURPOSES in frontend/src/components/LogCallModal.tsx.
	// '' is the Support / Service option, which the handler stores as NULL.
	formPurposes := []string{"", "marketing", "sales", "collections"}

	// Mirrors helpdesk_calls_purpose_chk after migration 162.
	allowed := map[string]bool{
		"collections": true, "marketing": true, "sales": true,
		"support": true, "retention": true, "other": true,
	}

	for _, p := range formPurposes {
		if p == "" {
			continue // stored as NULL, which the constraint permits
		}
		if !allowed[p] {
			t.Errorf("the Log-a-Call form offers purpose %q but helpdesk_calls_purpose_chk "+
				"rejects it — logging such a call returns an error to the agent", p)
		}
	}
}
