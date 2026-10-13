package handlers

import (
	"fmt"
	"testing"
	"time"
)

// These tests exist because the first version of the weekend substitution was wrong in
// production for 22 minutes and nobody could see it. It allocated each substitute
// against every row in app.public_holidays, which includes the substitutes the previous
// run had written, so a substitute blocked itself and shifted one day later on every
// run. Two runs left three Boxing Days in December 2026 and 75 spurious holidays, and
// the worker runs weekly.
//
// Idempotence was the property that mattered and it was the property not tested. So it
// is tested first here, and by the strongest statement of it I can write: whatever the
// table already holds, a second run must change nothing.

func decl(dates ...string) []feedHoliday {
	out := make([]feedHoliday, 0, len(dates))
	for _, d := range dates {
		out = append(out, feedHoliday{Date: d, Name: "Holiday " + d})
	}
	return out
}

// THE REGRESSION TEST. Reconciling the output against itself must be a no-op; if it is
// not, the set grows every run, which is precisely the bug.
func TestSubstitutionIsIdempotent(t *testing.T) {
	// A deliberately awkward year: a Saturday holiday, a Sat+Sun pair, and a Friday one
	// that must not produce a substitute at all.
	declared := decl(
		"2026-12-25", // Friday   - weekday, no substitute
		"2026-12-26", // Saturday - observed Monday 28th
		"2027-12-25", // Saturday - observed Monday 27th
		"2027-12-26", // Sunday   - observed Tuesday 28th
	)

	first := substitutesFor(declared)
	if len(first) != 3 {
		t.Fatalf("expected 3 substitutes, got %d: %v", len(first), first)
	}

	// Run two: the table now holds `first`, which is where the old code went wrong.
	second := substitutesFor(declared)
	drop, add := reconcileSubstitutes(first, second)
	if len(drop) != 0 || len(add) != 0 {
		t.Errorf("a second run changed the table: drop=%v add=%v\n"+
			"the substitution set must be a function of the DECLARED holidays only, "+
			"never of the substitutes already stored", drop, add)
	}

	// And a tenth run is still the same, because "stable after one more" is not the
	// claim being made — "stable forever" is.
	state := first
	for i := 0; i < 10; i++ {
		d, a := reconcileSubstitutes(state, substitutesFor(declared))
		if len(d) != 0 || len(a) != 0 {
			t.Fatalf("run %d still churned: drop=%v add=%v", i+3, d, a)
		}
		state = substitutesFor(declared)
	}
}

// The rule Temitope chose: either weekend day moves to the next working day.
func TestWeekendHolidaysMoveToTheNextWorkingDay(t *testing.T) {
	cases := []struct {
		name     string
		declared []feedHoliday
		want     map[string]string // substitute date -> the name it should carry
	}{
		{
			name:     "a Saturday holiday takes the Monday",
			declared: decl("2026-12-26"),
			want:     map[string]string{"2026-12-28": "Holiday 2026-12-26 (observed)"},
		},
		{
			name:     "a Sunday holiday takes the Monday",
			declared: decl("2027-12-26"),
			want:     map[string]string{"2027-12-27": "Holiday 2027-12-26 (observed)"},
		},
		{
			// Christmas Saturday, Boxing Day Sunday: Monday then Tuesday, in date order,
			// not both fighting for the Monday.
			name:     "a Saturday and Sunday pair takes Monday then Tuesday",
			declared: decl("2027-12-25", "2027-12-26"),
			want: map[string]string{
				"2027-12-27": "Holiday 2027-12-25 (observed)",
				"2027-12-28": "Holiday 2027-12-26 (observed)",
			},
		},
		{
			// The substitute must step over a declared holiday, not land on it.
			name:     "the substitute steps over a holiday already declared on the Monday",
			declared: decl("2026-12-26", "2026-12-28"),
			want:     map[string]string{"2026-12-29": "Holiday 2026-12-26 (observed)"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := substitutesFor(c.declared)
			if len(got) != len(c.want) {
				t.Fatalf("got %d substitutes, want %d: %v", len(got), len(c.want), got)
			}
			for _, h := range got {
				wantName, ok := c.want[h.Date]
				if !ok {
					t.Errorf("unexpected substitute on %s (%s)", h.Date, h.Name)
					continue
				}
				if h.Name != wantName {
					t.Errorf("%s is named %q, want %q", h.Date, h.Name, wantName)
				}
			}
		})
	}
}

// A weekday holiday is already a day off; giving it a substitute would hand out a
// second one. This is the direction the bug ran in, so it gets its own test.
func TestWeekdayHolidaysGetNoSubstitute(t *testing.T) {
	// Monday to Friday of one ordinary week.
	declared := decl("2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16")
	if got := substitutesFor(declared); len(got) != 0 {
		t.Errorf("weekday holidays produced %d substitute(s): %v", len(got), got)
	}
}

// A substitute never lands on a Saturday or Sunday, which would be a day off nobody
// gets and a holiday the business clock already treats as closed.
func TestSubstitutesAlwaysLandOnAWorkingDay(t *testing.T) {
	var declared []feedHoliday
	// Every Saturday and Sunday across two years, which is the worst case the allocator
	// can ever be handed.
	for d := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC); d.Year() < 2032; d = d.AddDate(0, 0, 1) {
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			declared = append(declared, feedHoliday{
				Date: d.Format("2006-01-02"), Name: fmt.Sprintf("Weekend %s", d.Format("2006-01-02")),
			})
		}
	}

	subs := substitutesFor(declared)
	seen := map[string]bool{}
	for _, h := range subs {
		d, err := time.Parse("2006-01-02", h.Date)
		if err != nil {
			t.Fatalf("substitute %q is not a date: %v", h.Date, err)
		}
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			t.Errorf("%s is a %s, so it is not a working day", h.Date, d.Weekday())
		}
		if seen[h.Date] {
			t.Errorf("two substitutes allocated to %s", h.Date)
		}
		seen[h.Date] = true
	}
	if len(subs) != len(declared) {
		t.Errorf("got %d substitutes for %d weekend holidays", len(subs), len(declared))
	}
}

// Reconciliation has to drop as well as add. A substitute that no longer follows from a
// declared holiday is not a holiday, it is a working day the office is not getting back
// unless something deletes the row.
func TestReconcileDropsASubstituteWhoseHolidayIsGone(t *testing.T) {
	held := []feedHoliday{
		{Date: "2026-12-28", Name: "Holiday 2026-12-26 (observed)"},
		{Date: "2026-12-29", Name: "Holiday 2026-12-26 (observed)"}, // the runaway's second day
		{Date: "2026-12-30", Name: "Holiday 2026-12-26 (observed)"}, // and its third
	}
	want := substitutesFor(decl("2026-12-26"))

	drop, add := reconcileSubstitutes(held, want)
	if len(add) != 0 {
		t.Errorf("nothing needed adding, got %v", add)
	}
	if len(drop) != 2 {
		t.Fatalf("expected the 29th and 30th dropped, got %v", drop)
	}
	if drop[0].Date != "2026-12-29" || drop[1].Date != "2026-12-30" {
		t.Errorf("dropped the wrong days: %v", drop)
	}
}

// A renamed holiday must correct its substitute's label rather than leave a stale one
// beside the new one, which would be two days off for one holiday.
func TestReconcileCorrectsARenamedSubstitute(t *testing.T) {
	held := []feedHoliday{{Date: "2026-12-28", Name: "Old Name (observed)"}}
	want := []feedHoliday{{Date: "2026-12-28", Name: "New Name (observed)"}}

	drop, add := reconcileSubstitutes(held, want)
	if len(drop) != 1 || drop[0].Name != "Old Name (observed)" {
		t.Errorf("the stale name should be dropped, got %v", drop)
	}
	if len(add) != 1 || add[0].Name != "New Name (observed)" {
		t.Errorf("the corrected name should be added, got %v", add)
	}
}
