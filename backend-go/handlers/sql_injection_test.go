package handlers

import (
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

/*
Two paths built SQL with fmt.Sprintf around values that came straight from the
caller — a JSON body in the card-statement query, a query string in every BI
report. Both are fixed; these tests exist so neither comes back.

The rule they encode: a caller's value is either bound as a parameter, or proven
to be the shape we expect before it is written into SQL. The rest of this package
already works that way — ymd() and validDate() are the house validators, and the
date ranges in executive.go come from a time.Time, so they cannot carry text at
all. bi.go was the one place that quoted a raw query parameter instead.
*/

// The BI date range reaches sixteen report queries as a SQL expression, so it is
// the one input where a missing check is worth the most to an attacker.
func TestAnInjectedReportDateIsRefused(t *testing.T) {
	attacks := []string{
		"2026-01-01' OR '1'='1",
		"2026-01-01'::date; DROP TABLE loan_applications --",
		"2026-01-01' UNION SELECT NULL,NULL,NULL,NULL --",
		"'; DELETE FROM bi_report_definitions; --",
		"CURRENT_DATE", // an expression, not a date — still not the caller's to choose
		"not-a-date",
		"2026-13-45",
	}
	for _, bad := range attacks {
		for _, param := range []string{"from", "to"} {
			r := httptest.NewRequest("GET", "/x?"+param+"="+url.QueryEscape(bad), nil)
			_, _, err := biQueryForReport(r, map[string]any{"module": "LOS"})
			if err == nil {
				t.Errorf("%s=%q built a report with no error", param, bad)
				continue
			}
			if !strings.Contains(err.Error(), param) {
				t.Errorf("%s=%q: error should name the parameter, got: %v", param, bad, err)
			}
		}
	}
}

// A refusal has to be a refusal, not a quiet fallback to the default window —
// otherwise an injected range looks identical to an ordinary report.
func TestAnInjectedDateDoesNotSilentlyFallBack(t *testing.T) {
	r := httptest.NewRequest("GET", "/x?from="+url.QueryEscape("2026-01-01' OR '1'='1"), nil)
	q, _, err := biQueryForReport(r, map[string]any{"module": "LOS"})
	if err == nil {
		t.Fatal("injected range was accepted")
	}
	if q != "" {
		t.Errorf("a refused request still returned SQL: %s", q)
	}
}

// The legitimate case still works, and what lands in the SQL is the parsed date
// rather than the caller's own bytes.
func TestARealReportDateStillWorks(t *testing.T) {
	r := httptest.NewRequest("GET", "/x?from=2026-09-01&to=2026-09-24", nil)
	q, _, err := biQueryForReport(r, map[string]any{"module": "LOS"})
	if err != nil {
		t.Fatalf("a valid range was refused: %v", err)
	}
	if !strings.Contains(q, "'2026-09-01'::date") || !strings.Contains(q, "'2026-09-24'::date") {
		t.Errorf("expected both canonicalised dates in the SQL, got: %s", q)
	}
}

// With no override the built-in range is used and the query still builds.
func TestTheDefaultReportRangeStillBuilds(t *testing.T) {
	r := httptest.NewRequest("GET", "/x", nil)
	q, _, err := biQueryForReport(r, map[string]any{"module": "LOS"})
	if err != nil {
		t.Fatalf("default range failed to build: %v", err)
	}
	if !strings.Contains(q, "CURRENT_DATE") {
		t.Errorf("expected the default window in the SQL, got: %s", q)
	}
}

// The card-statement query takes a CIF and two dates from a JSON body. Those are
// bound now; if anyone reintroduces interpolation this fails. Checked against the
// source because the handler needs a live DualQuery to run.
func TestTheStatementQueryBindsItsInputs(t *testing.T) {
	src, err := os.ReadFile("cc_statements.go")
	if err != nil {
		t.Fatalf("read cc_statements.go: %v", err)
	}
	s := string(src)
	if !strings.Contains(s, "WHERE cif = $1 AND txn_date BETWEEN $2::date AND $3::date") {
		t.Error("the statement query no longer binds cif and the date range")
	}
	if strings.Contains(s, "WHERE cif = '%s'") {
		t.Error("the statement query is interpolating cif again")
	}
}
