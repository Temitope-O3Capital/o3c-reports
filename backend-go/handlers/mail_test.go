package handlers

import "testing"

func TestUsesInboundReplyAddressOnlyForHelpdesk(t *testing.T) {
	cases := []struct {
		kind string
		want bool
	}{
		{kind: "helpdesk", want: true},
		{kind: "HelpDesk", want: true},
		{kind: "single", want: false},
		{kind: "campaign", want: false},
		{kind: "notification", want: false},
		{kind: "password_reset", want: false},
		{kind: "", want: false},
	}

	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			if got := usesInboundReplyAddress(tc.kind); got != tc.want {
				t.Fatalf("usesInboundReplyAddress(%q) = %v, want %v", tc.kind, got, tc.want)
			}
		})
	}
}
