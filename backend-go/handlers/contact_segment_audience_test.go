package handlers

import (
	"strings"
	"testing"
)

// A segment's audience decides which POPULATION it draws from, and the two are not two
// filters on one table: app.customer_lifecycle is a table of people, loan_applications is
// a table of applications. These pin the part that fails silently if it drifts.

// The default has to stay the loan book. contact_segments was empty on 2026-10-06 so no
// saved row could be misread today, but a saved segment written tomorrow and reloaded
// after a restart must not change meaning because the default moved under it.
func TestSegmentAudienceDefaultsToTheLoanBook(t *testing.T) {
	for _, raw := range []string{"", "   ", "applications", "nonsense", "CUSTOMERS "} {
		got := segmentAudience(segmentCriteria{Audience: raw})
		if raw == "customers" {
			continue
		}
		if got != segmentAudienceApplications {
			t.Errorf("audience %q resolved to %q, want %q — an unrecognised value must not "+
				"silently select a different population", raw, got, segmentAudienceApplications)
		}
	}
	if got := segmentAudience(segmentCriteria{Audience: "customers"}); got != segmentAudienceCustomers {
		t.Errorf("audience \"customers\" resolved to %q", got)
	}
}

// A loan filter on a customer segment must be REFUSED, not ignored.
//
// This is the direction that matters. Ignoring it turns "active customers 31-60 days
// down" into "every active customer" and then messages all 17,890 of them — the same
// failure the DPD-bucket switch in buildSegmentWhere was fixed for, where an
// unrecognised band contributed no clause and therefore selected the entire book. A
// segment returning nobody gets noticed; one returning everybody looks like a success.
func TestLoanFiltersAreRefusedOnACustomerSegment(t *testing.T) {
	cases := []struct {
		what string
		c    segmentCriteria
	}{
		{"arrears band", segmentCriteria{DPDBuckets: []string{"31-60"}}},
		{"application stage", segmentCriteria{Stages: []string{"disbursed"}}},
		{"application status", segmentCriteria{Statuses: []string{"active"}}},
		{"employer", segmentCriteria{Employers: []string{"NNPC"}}},
		{"loan product", segmentCriteria{Products: []string{"Salary Loan"}}},
		{"days past due", segmentCriteria{MinDPD: 31}},
		{"days past due (max)", segmentCriteria{MaxDPD: 60}},
		{"outstanding balance", segmentCriteria{MinOutstandingKobo: 100000}},
		{"outstanding balance (max)", segmentCriteria{MaxOutstandingKobo: 100000}},
	}
	for _, tc := range cases {
		tc.c.Audience = segmentAudienceCustomers
		problem := segmentCriteriaProblem(tc.c)
		if problem == "" {
			t.Errorf("a customer segment carrying a %s was accepted; it must be refused, "+
				"because ignoring the filter widens the audience to everybody", tc.what)
			continue
		}
		// The message has to name the offending filter, or the officer cannot fix it.
		if !strings.Contains(problem, "loan book") {
			t.Errorf("%s: refusal does not offer the way out (build it against the loan "+
				"book instead); got %q", tc.what, problem)
		}
	}
}

// The same filters are perfectly legal against the loan book, which is what they describe.
func TestLoanFiltersAreFineOnTheLoanBook(t *testing.T) {
	c := segmentCriteria{
		Audience: segmentAudienceApplications,
		DPDBuckets: []string{"31-60"}, Stages: []string{"disbursed"},
		Employers: []string{"NNPC"}, MinOutstandingKobo: 100000,
	}
	if problem := segmentCriteriaProblem(c); problem != "" {
		t.Errorf("loan-book segment refused: %q", problem)
	}
}

// Reachability flags are about the PERSON, so they are legal on either audience and must
// never be mistaken for a loan filter.
func TestReachabilityFlagsAreAllowedOnACustomerSegment(t *testing.T) {
	c := segmentCriteria{Audience: segmentAudienceCustomers, RequireEmail: true, RequirePhone: true}
	if problem := segmentCriteriaProblem(c); problem != "" {
		t.Errorf("require_email/require_phone refused on a customer segment: %q", problem)
	}
}

// splitSegmentName feeds first_name/last_name, which the templates greet people by.
// A single-word name goes to last_name whole, matching the CSV loader, so nobody is
// addressed as "Dear ," and no surname is invented.
func TestSplitSegmentName(t *testing.T) {
	cases := []struct{ in, first, last string }{
		{"Ada Okonkwo", "Ada", "Okonkwo"},
		{"Ada  Nkemdirim  Okonkwo", "Ada", "Nkemdirim Okonkwo"},
		{"Ada", "", "Ada"},
		{"  Ada Okonkwo  ", "Ada", "Okonkwo"},
		{"", "", ""},
		{"FOLTI TECHNOLOGIES LIMITED", "FOLTI", "TECHNOLOGIES LIMITED"},
	}
	for _, c := range cases {
		first, last := splitSegmentName(c.in)
		if first != c.first || last != c.last {
			t.Errorf("splitSegmentName(%q) = (%q,%q), want (%q,%q)", c.in, first, last, c.first, c.last)
		}
	}
}

// The cap is a real number that gets reported, not a silent truncation. The old
// materialiser carried a bare LIMIT 5000, which against 17,890 active customers dropped
// 72% of the audience and reported success.
func TestSegmentCapIsLargerThanTheCustomerBaseAndExplicit(t *testing.T) {
	const activeCustomersOn20261006 = 17890
	if segmentMaxMembers <= activeCustomersOn20261006 {
		t.Errorf("segmentMaxMembers is %d, which is below the %d active customers on the "+
			"book — the headline audience would be silently truncated",
			segmentMaxMembers, activeCustomersOn20261006)
	}
}
