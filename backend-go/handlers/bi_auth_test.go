package handlers

import (
	"context"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// AUTHORISATION ON THE LEGACY BI MODULE, AND THE PIVOT'S HEADER GUARD.
//
// Before this file there was no test anywhere in backend-go that named
// biScheduleReport, biDeleteSchedule or biListScheduled. The only BI test was
// bi_cron_test.go, which covers nextCronRun thoroughly and says nothing about who may
// do what — so the module's cron PARSER was well tested while its cron RUNNER and every
// one of its authorisation paths were not tested at all.
//
// WHY THESE TESTS AND NOT HTTP-LEVEL ONES. Claims reach a handler only through
// core.AuthMiddleware, and the context key it uses is unexported — there is no
// core.WithUser, so a handlers test cannot forge an authenticated request without
// minting a real JWT. Rather than build a token factory for this, the authorisation RULE
// was extracted into biReportVisibleTo and the handlers now all call it. That is the
// shape the fix wanted anyway: the rule had been written out three times and the fourth
// site had none.
//
// What this therefore does NOT cover: that each handler actually calls the function.
// Three call sites are a one-line grep and are commented at the point of use; the
// alternative was no test at all.

func TestBIReportVisibilityRule(t *testing.T) {
	const me, them = int64(7), int64(9)

	cases := []struct {
		name string
		def  core.Row
		user int64
		want bool
	}{
		{"my own private report", core.Row{"is_public": false, "created_by": me}, me, true},
		{"a public report, not mine", core.Row{"is_public": true, "created_by": them}, me, true},
		{"someone else's private report", core.Row{"is_public": false, "created_by": them}, me, false},
		// The hole the audit found: schedule had no check, so this case was reachable.
		{"someone else's private report, as the other way round", core.Row{"is_public": false, "created_by": me}, them, false},
		// created_by can be NULL — ON DELETE SET NULL on the author. A report whose
		// author is gone must not become everyone's.
		{"private, author deleted", core.Row{"is_public": false, "created_by": nil}, me, false},
		// is_public absent entirely (an older row, or a SELECT that did not ask for it)
		// must read as private, not as public.
		{"is_public missing", core.Row{"created_by": them}, me, false},
		{"no definition at all", nil, me, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := biReportVisibleTo(c.def, c.user); got != c.want {
				t.Errorf("biReportVisibleTo = %v, want %v", got, c.want)
			}
		})
	}
}

// A field in Columns has its VALUES promoted to the header row, so an identifier there
// produces a file whose first line is a list of customer identifiers with no name
// possible beside them. Refused rather than warned: these files are built by a cron and
// emailed, so there is no screen for a warning to land on.
func TestPivotRefusesAnIdentifierInColumns(t *testing.T) {
	d, ok := exportDatasetByKey("card_transactions")
	if !ok {
		t.Fatal("card_transactions dataset is missing from the registry")
	}

	// A nil *core.DB is safe here only because the guard returns before any query is
	// built or run. If that stops being true this test will panic rather than pass
	// quietly, which is the right failure.
	_, err := runPivot(context.Background(), nil, d, pivotSpec{
		Cols:   []string{"cif"},
		Values: []pivotValue{{Column: "amount", Agg: "sum"}},
	})
	if err == nil {
		t.Fatal("putting CIF in Columns must be refused: its values would become the column headings")
	}
	if !strings.Contains(err.Error(), "Columns") {
		t.Errorf("the refusal should tell the user what to do about it, got: %v", err)
	}

	// The same field in Rows must stay allowed, because a row can carry the name in the
	// next cell. That direction CANNOT be exercised here: the guard lets it through and
	// runPivot then needs a real database, so calling it with a nil *core.DB panics —
	// which is what the first draft of this test did. The guard reads spec.Cols and
	// nothing else (see runPivot), so Rows is unaffected by construction.
	if !pivotIdentifierCols["cif"] {
		t.Error("cif must be in the deny list, or the refusal above is passing for the wrong reason")
	}
}

// EVERY declared identifier is actually refused, not just the one the test above picks.
//
// This is the test that shows the guard works rather than that one example happens to
// work: a key could sit in pivotIdentifierCols while the guard looked at the wrong part
// of the spec, or lower-cased only one side, and the cif case would still pass. Each key
// is tried against a dataset that really has that column, so the refusal has to come
// from the guard and not from "unknown field".
//
// Safe with a nil *core.DB for the same reason as above: a refusal returns before any
// query is built. A key that is NOT refused falls through to the database and panics,
// which reports as a failure here — loudly, and in the right place.
func TestEveryDeclaredIdentifierIsRefusedInColumns(t *testing.T) {
	for key := range pivotIdentifierCols {
		var host exportDataset
		found := false
		for _, d := range exportDatasets {
			if _, ok := d.colByKey(key); ok {
				host, found = d, true
				break
			}
		}
		if !found {
			continue // TestPivotIdentifierListNamesRealColumns is the one that fails on this.
		}
		t.Run(key, func(t *testing.T) {
			_, err := runPivot(context.Background(), nil, host, pivotSpec{Cols: []string{key}})
			if err == nil {
				t.Fatalf("%q in Columns was not refused (dataset %q)", key, host.Key)
			}
			if !strings.Contains(err.Error(), "Columns") {
				t.Errorf("%q was rejected for the wrong reason: %v", key, err)
			}
		})
	}
}

// The other half of a deny list: that it does not catch what it should not. A guard
// which blocks the legitimate case gets switched off, and then protects nothing.
func TestPivotStillAllowsTheOrdinaryDimensions(t *testing.T) {
	// Every one of these is a normal thing to spread across columns — a month by
	// product, a branch by status. If any ends up in the deny list, the Report Builder
	// has quietly lost its point.
	for _, key := range []string{
		"product_name", "channel", "status", "state", "city", "branch_name",
		"currency", "direction", "purpose", "lead_stage", "party_type", "queue_name",
		"source_campaign", "disposition", "merchant_name", "mcc",
	} {
		if pivotIdentifierCols[key] {
			t.Errorf("%q is a normal pivot dimension and must not be refused in Columns", key)
		}
	}
}

// The deny list is only as good as its agreement with the registry: a key that matches
// no real column refuses nothing, and would sit here reading as protection.
func TestPivotIdentifierListNamesRealColumns(t *testing.T) {
	inRegistry := map[string]bool{}
	for _, d := range exportDatasets {
		for _, c := range d.Cols {
			inRegistry[strings.ToLower(c.Key)] = true
		}
	}
	for key := range pivotIdentifierCols {
		if !inRegistry[key] {
			t.Errorf("pivotIdentifierCols names %q, which is not a column key in any dataset — "+
				"it protects nothing and should be removed or corrected", key)
		}
	}
}
