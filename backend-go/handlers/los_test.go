package handlers

import "testing"

func TestLosStageToStatus(t *testing.T) {
	cases := []struct {
		stage string
		want  string
	}{
		{"approved", "approved"},
		{"booking", "approved"},
		{"declined", "declined"},
		{"rejected", "declined"},
		{"active", "active"},
		{"draft", "pending"},
		{"submitted", "pending"},
		{"risk_review", "pending"},
		{"", "pending"},
	}
	for _, tc := range cases {
		if got := losStageToStatus(tc.stage); got != tc.want {
			t.Errorf("losStageToStatus(%q) = %q, want %q", tc.stage, got, tc.want)
		}
	}
}

func TestTransitionRequiredPage(t *testing.T) {
	// Verify every key in the map follows "from:to" format.
	for key := range transitionRequiredPage {
		found := false
		for _, c := range key {
			if c == ':' {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("transitionRequiredPage key %q has no colon separator", key)
		}
	}
}

func TestTransitionRequiredPageCoverage(t *testing.T) {
	// The happy-path chain must be fully covered.
	chain := []string{
		"draft:submitted",
		"submitted:document_collection",
		"document_collection:risk_review",
		"risk_review:risk_head_review",
		"risk_head_review:pending_conditions",
		"pending_conditions:finance_approval",
		"finance_approval:booking",
		"booking:active",
	}
	for _, key := range chain {
		if _, ok := transitionRequiredPage[key]; !ok {
			t.Errorf("transitionRequiredPage missing required key %q", key)
		}
	}
}
