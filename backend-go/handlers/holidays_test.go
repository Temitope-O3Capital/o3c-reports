package handlers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readHandlerFile(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Clean(name))
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	return string(b)
}

func containsAll(src string, needles ...string) bool {
	for _, n := range needles {
		if !strings.Contains(src, n) {
			return false
		}
	}
	return true
}

// A fixture cut from the real Google en.ng#holiday feed, keeping one of each thing
// that matters: a work-free holiday, a tentative lunar date, a one-off declaration,
// the Children's Day / Id el Kabir date collision, and four observances that are NOT
// work-free in Nigeria.
const feedFixture = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260101
SUMMARY:New Year's Day
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260214
SUMMARY:Valentine's Day
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260218
SUMMARY:Ramadan Start
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260320
SUMMARY:Eid El-Fitr
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260527
SUMMARY:Children's Day
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260527
SUMMARY:Id el Kabir
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260616
SUMMARY:Al-Hijra
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261001
SUMMARY:National Day
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261224
SUMMARY:Christmas Eve
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20270310
SUMMARY:Eid El-Fitr (tentative)
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20250715
SUMMARY:Day of Mourning for President Muhammadu Buhari
END:VEVENT
END:VCALENDAR`

func TestHolidayFeedKeepsOnlyWorkFreeDays(t *testing.T) {
	got := parseHolidayFeed(feedFixture)

	byDate := map[string]feedHoliday{}
	for _, h := range got {
		byDate[h.Date] = h
	}

	// Kept.
	for _, want := range []struct{ date, name string }{
		{"2026-01-01", "New Year's Day"},
		{"2026-03-20", "Eid El-Fitr"},
		{"2026-10-01", "Independence Day"}, // renamed to match migration 367
		{"2027-03-10", "Eid El-Fitr"},
		{"2025-07-15", "Day of Mourning for President Muhammadu Buhari"},
	} {
		h, ok := byDate[want.date]
		if !ok {
			t.Errorf("%s (%s) was dropped and should have been kept", want.date, want.name)
			continue
		}
		if h.Name != want.name {
			t.Errorf("%s: name = %q, want %q", want.date, h.Name, want.name)
		}
	}

	// Dropped. None of these is work-free in Nigeria, and taking the feed wholesale
	// would have closed the office on Valentine's Day.
	for _, d := range []string{"2026-02-14", "2026-02-18", "2026-06-16", "2026-12-24"} {
		if h, ok := byDate[d]; ok {
			t.Errorf("%s (%s) is not work-free in Nigeria and must be dropped", d, h.Name)
		}
	}

	// The collision that matters: Children's Day shares 2026-05-27 with Id el Kabir,
	// and only the Eid is work-free. The allow-list must leave the Eid standing.
	if h, ok := byDate["2026-05-27"]; !ok {
		t.Error("2026-05-27 was dropped entirely; Id el Kabir is work-free")
	} else if h.Name != "Id el Kabir" {
		t.Errorf("2026-05-27 resolved to %q, want \"Id el Kabir\" — Children's Day won the "+
			"date collision, which would open the office on an Eid", h.Name)
	}
}

// The feed marks future lunar dates "(tentative)". That flag is the difference between
// a date the clock can be trusted on and one it cannot, so it has to survive parsing.
func TestHolidayFeedCarriesTheTentativeFlag(t *testing.T) {
	byDate := map[string]feedHoliday{}
	for _, h := range parseHolidayFeed(feedFixture) {
		byDate[h.Date] = h
	}

	if h := byDate["2027-03-10"]; !h.Estimated {
		t.Error("2027-03-10 Eid El-Fitr (tentative) lost its estimated flag — a figure " +
			"computed across it would be presented as exact")
	}
	if h := byDate["2027-03-10"]; h.Name != "Eid El-Fitr" {
		t.Errorf("the tentative marker was left in the name: %q", h.Name)
	}
	if h := byDate["2026-03-20"]; h.Estimated {
		t.Error("2026-03-20 is a declared date and must not be marked estimated")
	}
}

// Temitope's rule: a holiday on EITHER Saturday or Sunday is observed on the next
// working day, and two in a row take the Monday and then the Tuesday.
func TestWeekendSubstitutionTakesTheNextFreeWorkingDay(t *testing.T) {
	day := func(s string) time.Time {
		d, err := time.Parse("2006-01-02", s)
		if err != nil {
			t.Fatalf("bad fixture date %s: %v", s, err)
		}
		return d
	}

	// 2027-12-25 is a Saturday and 2027-12-26 a Sunday: Christmas takes Monday the
	// 27th, Boxing Day then has to take Tuesday the 28th.
	taken := map[string]bool{"2027-12-25": true, "2027-12-26": true}
	first := nextWorkingDay(day("2027-12-25"), taken)
	if got := first.Format("2006-01-02"); got != "2027-12-27" {
		t.Errorf("Saturday Christmas 2027 observed on %s, want 2027-12-27 (Monday)", got)
	}
	taken[first.Format("2006-01-02")] = true

	second := nextWorkingDay(day("2027-12-26"), taken)
	if got := second.Format("2006-01-02"); got != "2027-12-28" {
		t.Errorf("Sunday Boxing Day 2027 observed on %s, want 2027-12-28 (Tuesday) — two "+
			"weekend holidays must not collide on the same Monday", got)
	}

	// A Saturday holiday with a free Monday takes it.
	if got := nextWorkingDay(day("2026-12-26"), map[string]bool{}).Format("2006-01-02"); got != "2026-12-28" {
		t.Errorf("Saturday Boxing Day 2026 observed on %s, want 2026-12-28", got)
	}
}

// The importer writes the table every reported duration is computed from, so the set
// of things it may overwrite is the whole safety argument. Asserted against the source
// rather than trusted to the comment above it.
func TestImporterOnlyEverReplacesItsOwnEstimates(t *testing.T) {
	src := readHandlerFile(t, "holidays.go")

	// It may delete only its own unconfirmed guesses.
	if !containsAll(src,
		`DELETE FROM app.public_holidays`,
		`source='google_ics' AND is_estimated`) {
		t.Error("the delete is not restricted to source='google_ics' AND is_estimated — " +
			"an import must never remove a confirmed holiday or a manual correction")
	}
	// And its inserts must never clobber an existing row.
	if !containsAll(src, `ON CONFLICT (date) DO NOTHING`) {
		t.Error("an insert uses something other than ON CONFLICT DO NOTHING, so an " +
			"import could overwrite a date HR had corrected by hand")
	}
	if containsAll(src, `ON CONFLICT (date) DO UPDATE`) {
		t.Error("the importer upserts with DO UPDATE; only migration 367 may do that")
	}
}
