package handlers

import "testing"

// The qualification rule agreed on 14 Sept 2026: only "Interested" qualifies.
func TestCRMStageForCall(t *testing.T) {
	cases := []struct {
		status, disposition, want string
	}{
		{"interested", "Interested", "qualified"},
		{"callback", "Callback Scheduled", "contacted"},
		{"not_ready", "Not Ready Yet", "contacted"},
		{"called", "Not Interested", "disqualified"},
		{"called", "  NOT INTERESTED ", "disqualified"},
		{"called", "", "contacted"},
		{"called", "completed", "contacted"},
		{"no_answer", "Unreachable / No Answer", "contacted"},
		{"pending", "", "contacted"},
		{"closed", "Not Eligible", "disqualified"},
		{"dnc", "Do Not Call", "disqualified"},
		{"invalid", "Wrong Number", "disqualified"},
		{"converted", "Converted", "converted"},
		{"promise_to_pay", "Promise to Pay", ""},
	}
	for _, c := range cases {
		if got, _ := crmStageForCall(c.status, c.disposition); got != c.want {
			t.Errorf("crmStageForCall(%q, %q) = %q, want %q", c.status, c.disposition, got, c.want)
		}
	}
}

func TestCRMCallMoveAllowed(t *testing.T) {
	const byCall = crmCallDisqualifyPrefix + "Not Interested"
	cases := []struct {
		name                     string
		current, reason, stage   string
		want                     bool
	}{
		{"new lead reached, no outcome", "new", "", "contacted", true},
		{"interested call qualifies a contacted lead", "contacted", "", "qualified", true},
		{"a callback never drags a qualified lead back", "qualified", "", "contacted", false},
		{"a refusal closes a lead that was interested", "qualified", "", "disqualified", true},
		{"a refusal never closes a lead Sales is working", "documents_requested", "", "disqualified", false},
		{"interested reopens a lead a call disqualified", "disqualified", byCall, "qualified", true},
		{"interested does not overrule a person's disqualification", "disqualified", "Duplicate record", "qualified", false},
		{"a converted lead stays converted", "converted", "", "qualified", false},
		{"a contacted lead is not moved by another no-answer", "contacted", "", "contacted", false},
	}
	for _, c := range cases {
		_, rank := crmStageForCall(map[string]string{
			"contacted": "no_answer", "qualified": "interested", "disqualified": "dnc",
		}[c.stage], "")
		if got := crmCallMoveAllowed(c.current, c.reason, c.stage, rank); got != c.want {
			t.Errorf("%s: crmCallMoveAllowed(%q, %q, %q) = %v, want %v", c.name, c.current, c.reason, c.stage, got, c.want)
		}
	}
}
