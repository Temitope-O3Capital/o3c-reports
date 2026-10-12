package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
Two paths built SQL with fmt.Sprintf around values that came straight from the
caller — a JSON body in the card-statement query, and a query string in every
report of the legacy BI module. Both were fixed; this test exists so the first
cannot come back.

The rule they encode: a caller's value is either bound as a parameter, or proven
to be the shape we expect before it is written into SQL. The rest of this package
already works that way — ymd() and validDate() are the house validators, and the
date ranges in executive.go come from a time.Time, so they cannot carry text at
all.

THE FOUR BI TESTS THAT USED TO LIVE HERE ARE GONE WITH THEIR SUBJECT. They drove
biQueryForReport, the superseded module's query builder, which was deleted with
handlers/bi.go — it had no callers, no saved reports and weaker access control
than the live Report Builder. Deleting tests is normally how coverage quietly
disappears, so the trade was made explicitly and in the other direction first:
validDate, the house guard those tests only reached indirectly, had NO test of
its own despite standing in front of 143 call sites. It now has 24 cases,
including the injected dates this file used to cover, in valid_date_test.go.
That is the live path; biQueryForReport was not.
*/

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
