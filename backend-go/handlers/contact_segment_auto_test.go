package handlers

import (
	"strings"
	"testing"
)

// The customer-base filters, and the one that decides most of the audience.

// A lifecycle or recency filter on a LOAN-BOOK segment must be refused, the mirror of
// the loan-filter rule. Ignoring it is the dangerous direction in both: "applicants quiet
// for a year" would silently become "every applicant".
func TestCustomerFiltersAreRefusedOnALoanSegment(t *testing.T) {
	cases := []struct {
		what string
		c    segmentCriteria
	}{
		{"lifecycle bucket", segmentCriteria{Buckets: []string{"churned"}}},
		{"value tier", segmentCriteria{ValueTiers: []string{"gold"}}},
		{"time since last transaction", segmentCriteria{MinDaysSinceTxn: 90}},
		{"time since last transaction (max)", segmentCriteria{MaxDaysSinceTxn: 365}},
		{"time since last transaction (unknowns)", segmentCriteria{NeverTransacted: "only"}},
		{"already with recovery", segmentCriteria{ExcludeRecovery: true}},
	}
	for _, tc := range cases {
		tc.c.Audience = segmentAudienceApplications
		if problem := segmentCriteriaProblem(tc.c); problem == "" {
			t.Errorf("a loan-book segment carrying a %s was accepted; it must be refused, "+
				"because ignoring the filter widens the audience to every application", tc.what)
		} else if !strings.Contains(problem, "active customers") {
			t.Errorf("%s: refusal does not name the way out; got %q", tc.what, problem)
		}
	}
}

// The same filters are legal against the customer base, which is what they describe.
func TestCustomerFiltersAreFineOnTheCustomerBase(t *testing.T) {
	c := segmentCriteria{
		Audience: segmentAudienceCustomers,
		Buckets:  []string{"churned", "lapsed"}, ValueTiers: []string{"gold", "vip"},
		MinDaysSinceTxn: 90, NeverTransacted: "exclude", ExcludeRecovery: true,
	}
	if problem := segmentCriteriaProblem(c); problem != "" {
		t.Errorf("customer segment refused: %q", problem)
	}
}

// never_transacted takes three answers and nothing else. A typo must be refused rather
// than falling through to the default, because the default LEAVES PEOPLE OUT and a
// silently-ignored "inculde" would quietly shrink a dormancy audience instead.
func TestNeverTransactedVocabularyIsClosed(t *testing.T) {
	for _, ok := range []string{"", "include", "exclude", "only"} {
		c := segmentCriteria{Audience: segmentAudienceCustomers, NeverTransacted: ok}
		if problem := segmentCriteriaProblem(c); problem != "" {
			t.Errorf("never_transacted=%q refused: %q", ok, problem)
		}
	}
	for _, bad := range []string{"inculde", "all", "none", "yes", "INCLUDE "} {
		c := segmentCriteria{Audience: segmentAudienceCustomers, NeverTransacted: bad}
		if problem := segmentCriteriaProblem(c); problem == "" {
			t.Errorf("never_transacted=%q was accepted; an unrecognised value must be "+
				"refused rather than silently treated as the default", bad)
		}
	}
}

// The SQL the recency filter builds, checked for the thing that is easy to get backwards.
//
// days_since_txn IS NULL means "no transaction data reached us", true of 11,483 of the
// 17,890 active customers. A plain >= comparison excludes them, which is the honest
// default; "include" has to add them back EXPLICITLY, and "only" selects just them.
// Getting this wrong turns a 5,268-person audience into a 16,866-person one.
func TestRecencyFilterHandlesUnknownDatesExplicitly(t *testing.T) {
	base := segmentCriteria{Audience: segmentAudienceCustomers, MinDaysSinceTxn: 90}

	where, args := buildCustomerSegmentWhere(base)
	if !strings.Contains(where, "days_since_txn >=") {
		t.Errorf("default: no lower bound applied: %q", where)
	}
	if strings.Contains(where, "IS NULL") {
		t.Errorf("default: unknown dates must NOT be folded in silently: %q", where)
	}
	if len(args) != 1 || args[0] != 90 {
		t.Errorf("default: args = %v, want [90]", args)
	}

	incl := base
	incl.NeverTransacted = "include"
	if w, _ := buildCustomerSegmentWhere(incl); !strings.Contains(w, "OR days_since_txn IS NULL") {
		t.Errorf("include: unknown dates were not added back: %q", w)
	}

	excl := base
	excl.NeverTransacted = "exclude"
	if w, _ := buildCustomerSegmentWhere(excl); !strings.Contains(w, "days_since_txn IS NOT NULL") {
		t.Errorf("exclude: unknown dates were not ruled out: %q", w)
	}

	only := segmentCriteria{Audience: segmentAudienceCustomers, NeverTransacted: "only"}
	w, a := buildCustomerSegmentWhere(only)
	if !strings.Contains(w, "days_since_txn IS NULL") || strings.Contains(w, ">=") {
		t.Errorf("only: want just the IS NULL test, got %q", w)
	}
	if len(a) != 0 {
		t.Errorf("only: expected no args, got %v", a)
	}
}

// "include" with no window at all is not a filter: everybody is already in, and emitting
// a dangling OR would have selected the unknowns and nobody else.
func TestIncludeWithNoWindowFiltersNothing(t *testing.T) {
	c := segmentCriteria{Audience: segmentAudienceCustomers, NeverTransacted: "include"}
	if w, _ := buildCustomerSegmentWhere(c); strings.Contains(w, "days_since_txn") {
		t.Errorf("include with no window should add no recency clause, got %q", w)
	}
}

// Placeholders are numbered in the order the args are appended, and a mismatch here is a
// wrong-audience bug rather than an error: the query still runs, against the wrong values.
func TestCustomerWherePlaceholdersMatchTheirArgs(t *testing.T) {
	c := segmentCriteria{
		Audience: segmentAudienceCustomers,
		Buckets:  []string{"churned", "lapsed"}, ValueTiers: []string{"gold"},
		MinDaysSinceTxn: 90, MaxDaysSinceTxn: 400,
	}
	where, args := buildCustomerSegmentWhere(c)
	for i := 1; i <= len(args); i++ {
		if !strings.Contains(where, "$"+itoa(i)) {
			t.Errorf("$%d is never referenced but %d args were bound: %q", i, len(args), where)
		}
	}
	if strings.Contains(where, "$"+itoa(len(args)+1)) {
		t.Errorf("placeholder beyond the %d bound args: %q", len(args), where)
	}
	// churned, lapsed, gold, 90, 400
	if len(args) != 5 {
		t.Errorf("args = %v, want 5 of them", args)
	}
}

// The refresh interval is clamped to what the CHECK constraint allows, so a bad number
// from a client is corrected rather than surfacing as a 500 from the database.
func TestRefreshIntervalIsClamped(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, 24}, {-5, 24}, {1, 1}, {24, 24}, {168, 168}, {720, 720}, {721, 720}, {99999, 720},
	}
	for _, c := range cases {
		if got := refreshIntervalOrDefault(c.in); got != c.want {
			t.Errorf("refreshIntervalOrDefault(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}
