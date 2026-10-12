package handlers

import (
	"context"
	"strings"
	"testing"
)

// THE PIVOT HEADER GUARD.
//
// A Summary report puts a field's VALUES in the header row when that field is in
// Columns -- that is what a pivot is. So an identifier there produces a file whose
// first line is a row of customer identifiers, with no name possible beside them,
// because a header has nowhere to put a second label.
//
// This file also used to hold TestBIReportVisibilityRule, which pinned the
// authorisation rule for the legacy BI module. That module and its rule were deleted
// with handlers/bi.go, and the test went with them: a test whose subject no longer
// exists is not coverage, it is a reader's dead end. The guard below is the part that
// protects LIVE code -- pivot_matrix.go backs the real Report Builder.
//
// Refused rather than warned, because these files are built by a cron and emailed:
// there is no screen for a warning to land on.

// The simplest case: CIF in Columns.
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
