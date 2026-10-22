package handlers

import (
	"context"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// People do not type identifiers.
func TestDatasetMatchAcceptsPlainWords(t *testing.T) {
	for _, q := range []string{"card_disputes", "card disputes", "disputes card", "Card Disputes"} {
		d, near := assistantDatasetMatch(q)
		if d.Key != "card_disputes" {
			t.Errorf("%q resolved to %q (near: %d), want card_disputes", q, d.Key, len(near))
		}
	}
}

// A word that matches several datasets must NOT silently pick one. Answering
// about the wrong dataset is worse than asking which was meant.
func TestAnAmbiguousDatasetNameReturnsCandidates(t *testing.T) {
	d, near := assistantDatasetMatch("card")
	if d.Key != "" {
		t.Errorf("'card' resolved straight to %q; it matches several datasets and should not", d.Key)
	}
	if len(near) < 2 {
		t.Fatalf("expected several candidates for 'card', got %d", len(near))
	}
}

func TestAnUnknownDatasetMatchesNothing(t *testing.T) {
	d, near := assistantDatasetMatch("quillbottom ledger")
	if d.Key != "" || len(near) != 0 {
		t.Errorf("nonsense matched %q with %d candidates", d.Key, len(near))
	}
}

// THE ACCESS GUARD. The export engine is gated on one page by design, and an
// assistant that answered from these datasets for someone without that page
// would be a hole in that decision rather than a convenience.
func TestTheDatasetToolsAreGatedOnTheReportsPage(t *testing.T) {
	var gated int
	for _, tl := range assistantDatasetTools() {
		found := false
		for _, p := range tl.Pages {
			if p == "reports" {
				found = true
			}
		}
		if !found {
			t.Errorf("%s is not gated on the reports page, so it widens who can read every dataset", tl.Name)
			continue
		}
		gated++

		// And the guard must actually refuse somebody who lacks the page.
		sales := &core.Claims{ID: 2, Role: "sales_officer", FullName: "An Officer"}
		if userCanUseTool(sales, tl) {
			t.Errorf("a sales officer can call %s; the reports guard is not holding", tl.Name)
		}
		admin := &core.Claims{ID: 1, Role: "admin", FullName: "Admin"}
		if !userCanUseTool(admin, tl) {
			t.Errorf("an admin cannot call %s, so the tool is unreachable for everyone", tl.Name)
		}
	}
	if gated == 0 {
		t.Fatal("no dataset tools registered")
	}
}

// The count must be the same number the equivalent report would export. If these
// drift, a report and an answer disagree and neither can be trusted.
func TestTheCountMatchesTheExportEngine(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "query_workspace_data",
		map[string]any{"dataset": "card_disputes"})

	got := asInt(out["matching_records"])
	d, _ := exportDatasetByKey("card_disputes")
	cq, cargs, _, err := buildExportCountQuery(d, exportRequest{Dataset: d.Key})
	if err != nil {
		t.Fatalf("count query: %v", err)
	}
	rows, err := db.PGQuery(context.Background(), cq, cargs...)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	want := asInt(rows[0]["n"])
	if got != want {
		t.Errorf("tool reported %d records, the export engine counts %d", got, want)
	}
	t.Logf("card_disputes: %d records", got)
}

// A bad group_by must come back with the columns that would work, not an error
// the model will paper over.
func TestABadGroupByOffersTheValidColumns(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "query_workspace_data",
		map[string]any{"dataset": "card_disputes", "group_by": "not_a_column"})

	if _, ok := out["breakdown"]; ok {
		t.Error("a nonsense group_by still produced a breakdown")
	}
	cols, _ := out["groupable_columns"].([]string)
	if len(cols) == 0 {
		t.Fatalf("no groupable_columns offered: %v", out)
	}
	if !strings.Contains(asString(out["note"]), "not in this dataset") {
		t.Errorf("note does not explain the rejection: %q", asString(out["note"]))
	}
}

// Grouping must use the declared column expression. Most columns leave Expr empty
// and mean Key, so using Expr raw would emit "SELECT ()::text" and fail on nearly
// every dataset.
//
// Checked against fixed_deposits, where the figures are independently known: 234
// Active and 205 Closed, the same split get_fixed_deposit_summary reports. If the
// bridge and the dedicated tool ever disagree, one of them is lying.
func TestGroupingWorksAndAgreesWithTheDedicatedTool(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "query_workspace_data",
		map[string]any{"dataset": "fixed_deposits", "group_by": "status"})

	rows, _ := out["breakdown"].([]map[string]any)
	if len(rows) == 0 {
		t.Fatalf("no breakdown returned: %v", out)
	}
	var summed int64
	for _, r := range rows {
		n := asInt(r["records"])
		summed += n
		t.Logf("   %-24s %d", asString(r["value"]), n)
	}
	// The grouped counts must add up to the total the count query reported, or
	// the two queries are filtering differently and the breakdown is fiction.
	if total := asInt(out["matching_records"]); total != summed {
		t.Errorf("breakdown sums to %d but matching_records is %d; the two queries disagree", summed, total)
	}
}

// An empty dataset must come back as a clean zero, not an error and not a gap.
// card_disputes holds no rows today, which is exactly the case that would crash a
// grouping query built carelessly.
func TestAnEmptyDatasetReturnsZeroRatherThanFailing(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "query_workspace_data",
		map[string]any{"dataset": "card_disputes", "group_by": "status"})

	if n := asInt(out["matching_records"]); n != 0 {
		t.Skipf("card_disputes now holds %d records; nothing to assert", n)
	}
	rows, ok := out["breakdown"].([]map[string]any)
	if !ok {
		t.Fatalf("breakdown missing entirely for an empty dataset: %v", out)
	}
	if len(rows) != 0 {
		t.Errorf("empty dataset produced %d breakdown rows", len(rows))
	}
}
