package handlers

import (
	"testing"
	"time"
)

// nextCronRun used to understand only the named schedules and the single shape
// "0 H * * *". Every other 5-field expression fell through to `after.Add(24h)`, so a
// weekly schedule written the obvious way — "0 7 * * 1", Monday at 07:00 — silently
// became a DAILY send and mailed its recipients every morning. Nothing surfaced it:
// the schedule looked correct in the UI and the runner reported success each time.
//
// The reference instant is Saturday 12 September 2026, 10:00 UTC, so "next Monday"
// is the 14th and a same-day-but-later time is still today.
func TestNextCronRun(t *testing.T) {
	after := time.Date(2026, 9, 12, 10, 0, 0, 0, time.UTC)

	for _, tc := range []struct {
		name string
		expr string
		want time.Time
	}{
		// The regression this whole change exists for.
		{"weekly monday 07:00", "0 7 * * 1", time.Date(2026, 9, 14, 7, 0, 0, 0, time.UTC)},
		{"weekly sunday as 0", "0 7 * * 0", time.Date(2026, 9, 13, 7, 0, 0, 0, time.UTC)},
		{"weekly sunday as 7", "0 7 * * 7", time.Date(2026, 9, 13, 7, 0, 0, 0, time.UTC)},

		// Daily, including the one shape the old code did handle.
		{"daily 07:00 rolls to tomorrow", "0 7 * * *", time.Date(2026, 9, 13, 7, 0, 0, 0, time.UTC)},
		{"daily later today stays today", "30 14 * * *", time.Date(2026, 9, 12, 14, 30, 0, 0, time.UTC)},

		// Steps, lists and ranges — all previously unparseable.
		{"every 15 minutes", "*/15 * * * *", time.Date(2026, 9, 12, 10, 15, 0, 0, time.UTC)},
		{"minute list", "5,20,50 * * * *", time.Date(2026, 9, 12, 10, 5, 0, 0, time.UTC)},
		{"hour range picks next in range", "0 11-13 * * *", time.Date(2026, 9, 12, 11, 0, 0, 0, time.UTC)},

		// Day-of-month, and the Vixie union rule: when BOTH dom and dow are
		// restricted, a day matching EITHER runs. Monday the 14th beats the 15th.
		{"monthly on the 1st", "0 9 1 * *", time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)},
		{"dom and dow union", "0 6 15 * 1", time.Date(2026, 9, 14, 6, 0, 0, 0, time.UTC)},

		// Named schedules must keep working.
		{"@daily", "@daily", time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)},
		{"@hourly", "@hourly", time.Date(2026, 9, 12, 11, 0, 0, 0, time.UTC)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := nextCronRun(tc.expr, after)
			if !got.Equal(tc.want) {
				t.Errorf("nextCronRun(%q)\n got  %s\n want %s", tc.expr, got, tc.want)
			}
		})
	}
}

// An expression we cannot read must return the zero Time so the caller stops, rather
// than defaulting to some cadence nobody chose. The old code returned after+24h for
// all of these, which is how an unreadable schedule still sent daily mail.
func TestNextCronRunRejectsGarbage(t *testing.T) {
	after := time.Date(2026, 9, 12, 10, 0, 0, 0, time.UTC)

	for _, expr := range []string{
		"",
		"bogus",
		"0 7 * *",         // four fields
		"0 7 * * * *",     // six fields
		"99 7 * * *",      // minute out of range
		"0 25 * * *",      // hour out of range
		"0 7 32 * *",      // day out of range
		"0 7 * 13 *",      // month out of range
		"0 7 * * 8",       // weekday out of range
		"0 7 * * mon",     // names unsupported
		"*/0 * * * *",     // zero step
		"0 10-5 * * *",    // inverted range
		"@yearly",         // not implemented
	} {
		if got := nextCronRun(expr, after); !got.IsZero() {
			t.Errorf("nextCronRun(%q) = %s, want zero Time so the caller refuses to run it", expr, got)
		}
	}
}

// An expression that can never match must terminate rather than spin forever.
func TestNextCronRunImpossibleDateTerminates(t *testing.T) {
	after := time.Date(2026, 9, 12, 10, 0, 0, 0, time.UTC)
	if got := nextCronRun("0 0 30 2 *", after); !got.IsZero() { // 30 February
		t.Errorf("nextCronRun(30 Feb) = %s, want zero Time", got)
	}
}
