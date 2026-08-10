package handlers

import "testing"

// The officer/owner columns are bigint. An earlier version passed the raw ?officer_id=
// query string straight into the query, which made Postgres evaluate `bigint = text` —
// no such operator exists, so every filtered request died with a bare 500. The fix is to
// parse the parameter here; these cases pin that behaviour down.
func TestParseUserID(t *testing.T) {
	for _, tc := range []struct {
		name    string
		in      string
		want    int64
		wantErr bool
	}{
		{"plain", "5", 5, false},
		{"large", "9007199254740993", 9007199254740993, false},
		{"padded", "  42  ", 42, false},
		{"empty", "", 0, true},
		{"word", "unassigned", 0, true},
		{"decimal", "5.0", 0, true},
		{"injection attempt", "1 OR 1=1", 0, true},
		{"negative is parseable", "-1", -1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseUserID(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseUserID(%q) = %d, want an error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseUserID(%q): unexpected error %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("parseUserID(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

// isSalesHead decides whether a caller sees the whole book or only their own. Getting
// this wrong is a data-scope bug, not a cosmetic one, so the membership is asserted
// rather than left to the map literal.
func TestIsSalesHead(t *testing.T) {
	for role, want := range map[string]bool{
		"admin":             true,
		"sales_head":        true,
		"head_sales":        true,
		"head_ops":          true,
		"cfo":               true,
		"sales_officer":     false,
		"bd_officer":        false,
		"call_center_agent": false,
		"risk_officer":      false,
		"":                  false,
	} {
		if got := salesHeadRoles[role]; got != want {
			t.Errorf("salesHeadRoles[%q] = %v, want %v", role, got, want)
		}
	}
	if isSalesHead(nil) {
		t.Error("isSalesHead(nil) must be false — an absent user is never a head")
	}
}
