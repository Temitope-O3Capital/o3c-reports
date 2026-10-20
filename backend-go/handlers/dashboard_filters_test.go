package handlers

import (
	"net/http/httptest"
	"testing"
)

func TestDashReadSelection(t *testing.T) {
	r := httptest.NewRequest("GET",
		"/x?f_state=Lagos&f_direction=inbound&win=last_30_days&from=2026-01-01&to=2026-02-01&other=ignored", nil)
	sel := dashReadSelection(r)

	if sel.Values["state"] != "Lagos" || sel.Values["direction"] != "inbound" {
		t.Errorf("slicer values not read: %#v", sel.Values)
	}
	// Only f_-prefixed parameters are slicers. Without the prefix, a future parameter
	// could be read as a filter key and silently narrow every tile.
	if _, leaked := sel.Values["other"]; leaked {
		t.Error("an unprefixed parameter was read as a slicer")
	}
	if len(sel.Values) != 2 {
		t.Errorf("expected 2 slicers, got %d: %#v", len(sel.Values), sel.Values)
	}
	if sel.Win != "last_30_days" || sel.From != "2026-01-01" || sel.To != "2026-02-01" {
		t.Errorf("period not read: %+v", sel)
	}
}

// A cross-language assumption worth pinning: the browser's URLSearchParams encodes a
// space as "+", and Go must read it back as a space. If it did not, a slicer set to
// "FCT, Abuja" would filter on the literal "FCT,+Abuja" and match nothing — silently,
// since a filter that matches nothing looks like a period with no data.
func TestDashReadSelectionDecodesPlusAsSpace(t *testing.T) {
	r := httptest.NewRequest("GET", "/x?f_state=FCT%2C+Abuja", nil)
	sel := dashReadSelection(r)
	if sel.Values["state"] != "FCT, Abuja" {
		t.Errorf("got %q, want %q", sel.Values["state"], "FCT, Abuja")
	}
}

func TestDashReadSelectionDropsBlanks(t *testing.T) {
	// A blank filter value is skipped by exports.go, so carrying it would be a no-op that
	// still counts as "applied" and tells the viewer their filter took effect.
	r := httptest.NewRequest("GET", "/x?f_state=&f_outcome=%20%20&f_=Lagos", nil)
	sel := dashReadSelection(r)
	if len(sel.Values) != 0 {
		t.Errorf("blank and unnamed slicers must be dropped, got %#v", sel.Values)
	}
}

// The safety property: a slicer reaches a tile ONLY through a filter the dataset already
// declares, so it can never read anything a report could not already filter on.
func TestDashApplySelectionOnlyUsesDeclaredFilters(t *testing.T) {
	d, ok := exportDatasetByKey("helpdesk_calls")
	if !ok {
		t.Fatal("helpdesk_calls dataset is gone; re-point this test")
	}

	sel := dashSlicerSelection{Values: map[string]string{
		"direction":   "inbound",   // declared on this dataset
		"state":       "Lagos",     // NOT declared here
		"hangup_junk": "something", // not a filter at all
	}}
	cfg, applied, ignored := dashApplySelection(d, savedPivotConfig{}, sel)

	if cfg.Filters["direction"] != "inbound" {
		t.Errorf("a declared filter was not applied: %#v", cfg.Filters)
	}
	if _, leaked := cfg.Filters["state"]; leaked {
		t.Error("a filter the dataset does not declare was written into the config")
	}
	if len(applied) != 1 || applied[0] != "direction" {
		t.Errorf("applied = %v, want [direction]", applied)
	}
	if len(ignored) != 2 {
		t.Errorf("ignored = %v, want the two undeclared keys", ignored)
	}
}

// A tile built with its own filter value, on a board filtered to something else, must
// show the board's value or say it could not. Showing the tile's own value under the
// board's heading is the one outcome that actively misleads.
func TestTheBoardsSelectionWinsOverTheTilesOwn(t *testing.T) {
	d, _ := exportDatasetByKey("helpdesk_calls")
	cfg := savedPivotConfig{Filters: map[string]string{"direction": "outbound"}}
	out, applied, _ := dashApplySelection(d, cfg,
		dashSlicerSelection{Values: map[string]string{"direction": "inbound"}})

	if out.Filters["direction"] != "inbound" {
		t.Errorf("the board's selection must win, got %q", out.Filters["direction"])
	}
	if len(applied) != 1 {
		t.Errorf("applied = %v", applied)
	}
	// And the saved report's own config must not have been mutated underneath it.
	if cfg.Filters["direction"] != "outbound" {
		t.Error("the tile's saved config was mutated; a viewer's selection leaked into it")
	}
}

func TestDashApplySelectionPeriod(t *testing.T) {
	d, _ := exportDatasetByKey("helpdesk_calls")
	if d.DateCol == "" {
		t.Fatal("helpdesk_calls has no date column; re-point this test")
	}

	// A named window must clear any explicit dates, or stale dates override the name
	// when resolveReportWindow recomputes it.
	cfg := savedPivotConfig{DateFrom: "2020-01-01", DateTo: "2020-02-01"}
	out, applied, _ := dashApplySelection(d, cfg, dashSlicerSelection{Win: "last_30_days"})
	if out.DateWindow != "last_30_days" || out.DateFrom != "" || out.DateTo != "" {
		t.Errorf("named window did not clear the dates: %+v", out)
	}
	if len(applied) == 0 || applied[len(applied)-1] != "period" {
		t.Errorf("period should be reported as applied, got %v", applied)
	}

	// A custom window keeps them.
	out2, _, _ := dashApplySelection(d, savedPivotConfig{},
		dashSlicerSelection{Win: "custom", From: "2026-01-01", To: "2026-02-01"})
	if out2.DateWindow != "custom" || out2.DateFrom != "2026-01-01" || out2.DateTo != "2026-02-01" {
		t.Errorf("custom window lost its dates: %+v", out2)
	}
}

func TestDashApplySelectionIgnoresPeriodWithoutADateColumn(t *testing.T) {
	// A dataset with no date column cannot answer a period, and must say so rather than
	// appear to have been filtered.
	d := exportDataset{Key: "no_dates", Filters: []exportFilter{{Key: "x", Expr: "x = ?"}}}
	out, applied, ignored := dashApplySelection(d, savedPivotConfig{}, dashSlicerSelection{Win: "this_month"})
	if out.DateWindow != "" {
		t.Error("a period was applied to a dataset with no date column")
	}
	if len(applied) != 0 {
		t.Errorf("applied = %v, want none", applied)
	}
	if len(ignored) != 1 || ignored[0] != "period" {
		t.Errorf("ignored = %v, want [period]", ignored)
	}
}

// An empty selection must leave the config exactly as it was: an unfiltered board has to
// render precisely what it rendered before any of this existed.
func TestAnEmptySelectionChangesNothing(t *testing.T) {
	d, _ := exportDatasetByKey("helpdesk_calls")
	cfg := savedPivotConfig{
		Filters:    map[string]string{"direction": "outbound"},
		DateWindow: "this_quarter",
	}
	out, applied, ignored := dashApplySelection(d, cfg, dashSlicerSelection{Values: map[string]string{}})

	if out.DateWindow != "this_quarter" || out.Filters["direction"] != "outbound" {
		t.Errorf("an empty selection altered the config: %+v", out)
	}
	if len(applied) != 0 || len(ignored) != 0 {
		t.Errorf("applied=%v ignored=%v, want both empty", applied, ignored)
	}
}

// The grains the pivot understands, and the one property that matters about the coarse
// ones: they must sort as text into real chronological order, because the grain becomes a
// chart's x-axis and the axis keeps the order the rows arrive in.
func TestCoarseGrainsSortChronologically(t *testing.T) {
	for _, c := range []struct {
		grain  string
		sorted []string
	}{
		{"month", []string{"2025-12", "2026-01", "2026-02", "2026-10", "2026-11"}},
		{"quarter", []string{"2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"}},
		{"week", []string{"2025-W52", "2026-W01", "2026-W05", "2026-W40"}},
		{"year", []string{"2024", "2025", "2026"}},
	} {
		for i := 1; i < len(c.sorted); i++ {
			if !(c.sorted[i-1] < c.sorted[i]) {
				t.Errorf("%s grain: %q must sort before %q, or a line chart draws time out of order",
					c.grain, c.sorted[i-1], c.sorted[i])
			}
		}
	}
}
