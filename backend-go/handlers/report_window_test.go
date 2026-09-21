package handlers

import (
	"testing"
	"time"
)

// The weekly windows a scheduled report resolves on the day it is sent. They must match
// resolveWindow in frontend/src/pages/reports/builder/model.ts.
func TestResolveReportWindowWeeks(t *testing.T) {
	lagos := func(s string) time.Time {
		tm, err := time.ParseInLocation("2006-01-02 15:04", s, reportTZ)
		if err != nil {
			t.Fatal(err)
		}
		return tm
	}
	cases := []struct {
		now      time.Time
		window   string
		from, to string
	}{
		// Monday 14 Sep 2026, 07:00: the weekly send.
		{lagos("2026-09-14 07:00"), "last_work_week", "2026-09-07", "2026-09-11"},
		{lagos("2026-09-14 07:00"), "last_week", "2026-09-07", "2026-09-13"},
		{lagos("2026-09-14 07:00"), "this_week", "2026-09-14", "2026-09-14"},
		// Sunday still belongs to the week that began on Monday.
		{lagos("2026-09-13 23:30"), "this_week", "2026-09-07", "2026-09-13"},
		{lagos("2026-09-13 23:30"), "last_work_week", "2026-08-31", "2026-09-04"},
		// 23:30 UTC on Sunday is 00:30 Monday in Lagos.
		{time.Date(2026, 9, 13, 23, 30, 0, 0, time.UTC), "last_work_week", "2026-09-07", "2026-09-11"},
		// Across the year end.
		{lagos("2026-01-05 07:00"), "last_work_week", "2025-12-29", "2026-01-02"},
		{lagos("2026-09-16 10:00"), "yesterday", "2026-09-15", "2026-09-15"},
		{lagos("2026-09-14 07:00"), "last_quarter", "2026-04-01", "2026-06-30"},
		{lagos("2026-02-10 07:00"), "last_quarter", "2025-10-01", "2025-12-31"},
	}
	for _, c := range cases {
		from, to := resolveReportWindow(c.window, c.now)
		if from != c.from || to != c.to {
			t.Errorf("%s at %s: got %s..%s, want %s..%s", c.window, c.now.Format(time.RFC3339), from, to, c.from, c.to)
		}
	}
}
