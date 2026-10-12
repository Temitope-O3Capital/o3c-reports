package handlers

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// validDate IS THE HOUSE DATE GUARD, AND IT HAD NO TEST.
//
// It stands in front of 143 call sites. Every report that takes a window runs its
// date_from/date_to through here, and the reason it exists is sharp: the readers it
// guards discard query errors (`rows, _ :=`), so a date Postgres refuses does not
// produce a 500 — it produces HTTP 200, a page of zeros, and no fault reported
// anywhere. A wrong date and a quiet month look identical.
//
// Until now the only tests touching date validation went through biQueryForReport, the
// superseded BI module's query builder, which is being deleted. Testing the live guard
// directly is the trade that makes that deletion a net gain rather than a loss of
// coverage: these cases are the ones that actually reach production code.
func TestValidDateAcceptsOnlyRealDates(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // "" plus wantErr means rejected
		err  bool
	}{
		// The ordinary path.
		{"a real date", "2026-10-12", "2026-10-12", false},
		{"a leap day in a leap year", "2024-02-29", "2024-02-29", false},
		{"first of a month", "2026-01-01", "2026-01-01", false},
		{"last of a long month", "2026-12-31", "2026-12-31", false},

		// Absent is not invalid: every caller treats "" as "no window given" and
		// substitutes its own default. Rejecting it here would break every report that
		// is allowed to run undated.
		{"absent", "", "", false},

		// Shapes the regex alone would let through.
		{"the 30th of February", "2026-02-30", "", true},
		{"the 31st of April", "2026-04-31", "", true},
		{"a leap day in a non-leap year", "2026-02-29", "", true},
		{"month 13", "2026-13-01", "", true},
		{"month 00", "2026-00-10", "", true},
		{"day 00", "2026-10-00", "", true},

		// Wrong shape.
		{"day first", "12-10-2026", "", true},
		{"no padding", "2026-1-5", "", true},
		{"a timestamp", "2026-10-12T00:00:00Z", "", true},
		{"only a month", "2026-10", "", true},
		{"words", "yesterday", "", true},
		{"whitespace around a good date", " 2026-10-12 ", "", true},

		// Injection. None of these should come back as a usable value — and the point is
		// not that they are escaped later, it is that they never become a date at all.
		{"quote and OR", "2026-10-12' OR '1'='1", "", true},
		{"statement terminator", "2026-10-12; DROP TABLE app.customers", "", true},
		{"comment", "2026-10-12--", "", true},
		{"union", "2026-10-12 UNION SELECT 1", "", true},
		{"a subquery", "(SELECT 1)", "", true},
		{"a bare quote", "'", "", true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/?date_from="+url.QueryEscape(c.in), nil)
			got, err := validDate(r, "date_from")
			if c.err && err == nil {
				t.Fatalf("validDate(%q) returned no error; it must be refused, because the "+
					"readers behind it discard query errors and would answer 200 with zeros", c.in)
			}
			if !c.err && err != nil {
				t.Fatalf("validDate(%q) errored: %v", c.in, err)
			}
			if got != c.want {
				t.Errorf("validDate(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// The error has to name the parameter, because a report takes two dates and "invalid
// date" tells the user nothing about which field to fix.
func TestValidDateErrorNamesTheParameter(t *testing.T) {
	r := httptest.NewRequest("GET", "/?date_to=2026-02-30", nil)
	_, err := validDate(r, "date_to")
	if err == nil {
		t.Fatal("expected an error for the 30th of February")
	}
	if !strings.Contains(err.Error(), "date_to") {
		t.Errorf("error %q should name the parameter it rejected", err.Error())
	}
}
