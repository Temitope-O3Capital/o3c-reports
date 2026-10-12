package handlers

import (
	"strconv"
	"strings"
	"time"
)

// Cron expression parsing.
//
// Extracted intact from the legacy BI module (handlers/bi.go) when that module was
// deleted. It is kept, rather than deleted with the rest, for two reasons: it is the
// best-tested code in that file — bi_cron_test.go covers the named schedules, 13
// garbage inputs and a documented past regression — and scheduling is squarely in the
// path of the dashboards work that replaces the module, which will need exactly this.
//
// The regression the tests pin is worth knowing before touching this: it once understood
// only the named forms and the single shape "0 H * * *", and every other 5-field
// expression fell through to `after.Add(24 * time.Hour)`. That turned "0 7 * * 1" —
// Monday 07:00, the obvious way to write a weekly report — into a DAILY send. An
// expression it cannot parse now returns the zero Time so the caller can refuse to run
// it, rather than inventing a cadence nobody chose.

// nextCronRun returns the next execution time after `after` for the given cron
// expression, in `after`'s location. It supports the named schedules (@hourly, @daily,
// @midnight, @weekly, @monthly) and full 5-field expressions — "*", fixed values,
// "a-b" ranges, "a,b" lists and "*/n" steps, in any field.
//
// It previously understood only the named forms and the single shape "0 H * * *", and
// EVERY other 5-field expression fell through to `after.Add(24 * time.Hour)`. That
// silently turned "0 7 * * 1" — Monday at 07:00, the obvious way to write a weekly
// report — into a DAILY send, mailing recipients every morning for a schedule they had
// asked to receive once a week. Nothing surfaced the misreading.
//
// An expression that cannot be parsed now returns the zero Time so the caller can
// refuse to run it, rather than inventing a cadence nobody chose.
func nextCronRun(expr string, after time.Time) time.Time {
	switch strings.TrimSpace(strings.ToLower(expr)) {
	case "@hourly":
		return after.Add(time.Hour).Truncate(time.Hour)
	case "@daily", "@midnight":
		d := after.AddDate(0, 0, 1)
		return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, after.Location())
	case "@weekly":
		d := after.AddDate(0, 0, 7)
		return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, after.Location())
	case "@monthly":
		d := after.AddDate(0, 1, 0)
		return time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, after.Location())
	}

	// Standard 5-field cron: min hour dom month dow
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return time.Time{}
	}
	mins, okMin := cronField(parts[0], 0, 59)
	hours, okHour := cronField(parts[1], 0, 23)
	doms, okDom := cronField(parts[2], 1, 31)
	months, okMon := cronField(parts[3], 1, 12)
	dows, okDow := cronField(parts[4], 0, 7)
	if !okMin || !okHour || !okDom || !okMon || !okDow {
		return time.Time{}
	}
	// Cron accepts both 0 and 7 for Sunday; time.Weekday only knows 0.
	if dows[7] {
		dows[0] = true
	}
	domRestricted := strings.TrimSpace(parts[2]) != "*"
	dowRestricted := strings.TrimSpace(parts[4]) != "*"

	// Walk forward a minute at a time from the next whole minute. Bounded at four
	// years so an expression that can never match (e.g. "0 0 30 2 *") terminates
	// instead of spinning.
	t := after.Truncate(time.Minute).Add(time.Minute)
	limit := t.AddDate(4, 0, 0)
	for ; t.Before(limit); t = t.Add(time.Minute) {
		if !mins[t.Minute()] || !hours[t.Hour()] || !months[int(t.Month())] {
			continue
		}
		// Vixie cron: when BOTH day-of-month and day-of-week are restricted, a day
		// matching EITHER runs. Only one restricted means that one decides.
		dayOK := doms[t.Day()]
		switch {
		case domRestricted && dowRestricted:
			dayOK = doms[t.Day()] || dows[int(t.Weekday())]
		case dowRestricted:
			dayOK = dows[int(t.Weekday())]
		}
		if dayOK {
			return t
		}
	}
	return time.Time{}
}

// cronField expands one cron field into a lookup set, reporting false if the field is
// not valid for [min,max]. Accepts "*", "a", "a-b", comma-separated lists of those, and
// a "/n" step suffix on any of them.
func cronField(f string, min, max int) (map[int]bool, bool) {
	f = strings.TrimSpace(f)
	if f == "" {
		return nil, false
	}
	out := map[int]bool{}
	for _, part := range strings.Split(f, ",") {
		part = strings.TrimSpace(part)
		step := 1
		if i := strings.Index(part, "/"); i >= 0 {
			s, err := strconv.Atoi(strings.TrimSpace(part[i+1:]))
			if err != nil || s <= 0 {
				return nil, false
			}
			step = s
			part = strings.TrimSpace(part[:i])
		}
		lo, hi := min, max
		if part != "*" {
			if i := strings.Index(part, "-"); i > 0 {
				a, errA := strconv.Atoi(strings.TrimSpace(part[:i]))
				b, errB := strconv.Atoi(strings.TrimSpace(part[i+1:]))
				if errA != nil || errB != nil {
					return nil, false
				}
				lo, hi = a, b
			} else {
				v, err := strconv.Atoi(part)
				if err != nil {
					return nil, false
				}
				lo, hi = v, v
			}
		}
		if lo < min || hi > max || lo > hi {
			return nil, false
		}
		for v := lo; v <= hi; v += step {
			out[v] = true
		}
	}
	return out, len(out) > 0
}
