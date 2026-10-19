package handlers

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
NIGERIAN PUBLIC HOLIDAYS — keeping the business clock current.

Migration 367 put Nigeria's holidays into app.public_holidays for 2015-2040, taking
the Islamic dates from Google's Nigerian holiday calendar because it is the only
source reachable from here that carries them. That fixed the clock; this keeps it
fixed. The feed covers 2021-2031, so there is no cliff edge, but two things do change
and neither can be predicted:

  a tentative Eid becomes a declared one, and the date can move by a day
  the Federal Government declares a one-off (the Buhari Day of Mourning, 2025-07-15)

WHAT THIS IS ALLOWED TO CHANGE, and why the rule is narrow. app.public_holidays drives
every duration the platform reports, so an importer that can rewrite anything is an
importer that can silently restate how fast people look. Provenance decides:

  source='manual'        NEVER touched. This is how HR corrects a date that landed a
                         day out, and a correction that an import undoes is not a
                         correction.
  source='arithmetic'    never touched — fixed and Easter dates are derived, not fetched.
  source='substitution'  RECOMPUTED FROM SCRATCH every run, which means dropped as
                         well as added: a substitute that no longer follows from a
                         declared holiday is not a holiday, it is a working day the
                         office would otherwise never get back. Recomputing rather than
                         adding to is also what makes the import idempotent — see
                         substitutesFor for what the first version did instead.
  source='google_ics'
    is_estimated=true    REPLACEABLE. A tentative date that moved is the whole reason
                         this exists.
    is_estimated=false   never touched. Once declared, it is history.

So the importer can add a date, and can move one it previously guessed. It cannot
delete a confirmed holiday, cannot edit a human's correction, and cannot touch history:
nothing before last year is considered at all.

The calendar rebuild is not done here. Migration 367 put a statement-level trigger on
app.public_holidays, so writing a row applies it — which is the point of that trigger.
*/

// holidayFeedURL is Google's Nigerian public holiday calendar. No key, covers
// 2021-2031, and the only source tested that carries Eid al-Fitr, Id el Kabir and Id
// el Maulud. Nager.Date also lists Nigeria and was rejected: none of the five Islamic
// holidays in any year, plus Children's Day and National Youth Day, which are not
// work-free here.
const holidayFeedURL = "https://calendar.google.com/calendar/ical/" +
	"en.ng%23holiday%40group.v.calendar.google.com/public/basic.ics"

// workFreeHolidays is the allow-list, and it is not optional. The feed also carries
// Valentine's Day, Ash Wednesday, Women's Day, Mothering Sunday, Ramadan Start,
// Father's Day, Christmas Eve, New Year's Eve, Al-Hijra, Holy Saturday, Easter Sunday
// and Children's Day — none of which are work-free in Nigeria. Children's Day is the
// one that bites: on 2026-05-27 it shares a date with Id el Kabir, so taking the feed
// wholesale would close the office on Valentine's Day and open it on an Eid.
var workFreeHolidays = map[string]bool{
	"New Year's Day": true, "Good Friday": true, "Easter Monday": true,
	"Workers' Day": true, "Democracy Day": true, "National Day": true,
	"Christmas Day": true, "Boxing Day": true,
	"Eid El-Fitr": true, "Eid El-Fitr Holiday": true,
	"Id el Kabir": true, "Id el Kabir Holiday": true,
	"Id el Maulud": true,
}

// oneOffPrefixes are the holidays no rule can predict — a declared day of national
// mourning. Matched by prefix because the name carries the occasion.
var oneOffPrefixes = []string{"Day of Mourning"}

type feedHoliday struct {
	Date      string `json:"date"` // YYYY-MM-DD
	Name      string `json:"name"`
	Estimated bool   `json:"estimated"`
}

// HolidayImport is what both the preview and the apply return, so a dry run and a real
// run are read the same way.
type HolidayImport struct {
	FeedURL      string        `json:"feed_url"`
	FetchedAt    time.Time     `json:"fetched_at"`
	FeedHolidays int           `json:"feed_holidays"`
	Added        []feedHoliday `json:"added"`
	Moved        []feedHoliday `json:"moved"`
	Removed      []feedHoliday `json:"removed"`
	Substitutes  []feedHoliday `json:"substitutes"`
	// Reported separately from Removed because they are a different kind of change: a
	// removal is a holiday the feed stopped naming, a dropped substitute is a day the
	// office gets back. Both read as "fewer holidays" and conflating them would hide
	// which one happened.
	SubstitutesDropped []feedHoliday `json:"substitutes_dropped"`
	Applied            bool          `json:"applied"`
	Skipped            int           `json:"skipped_not_ours"`
}

var icsDate = regexp.MustCompile(`DTSTART;VALUE=DATE:(\d{8})`)
var icsSummary = regexp.MustCompile(`SUMMARY:(.*)`)
var tentative = regexp.MustCompile(`(?i)\s*\(tentative\)\s*$`)

// fetchHolidayFeed pulls the calendar and returns the work-free holidays it names.
// Unfolds RFC 5545 line continuations first, which is a CRLF followed by a space.
func fetchHolidayFeed(ctx context.Context) ([]feedHoliday, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, holidayFeedURL, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 45 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("holiday feed unreachable: %w", err)
	}
	defer res.Body.Close() //nolint:errcheck
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("holiday feed returned %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	return parseHolidayFeed(string(body)), nil
}

// parseHolidayFeed is separated from the fetch so the filtering rules can be tested
// without a network call — which matters, because the allow-list IS the correctness.
func parseHolidayFeed(body string) []feedHoliday {
	unfolded := strings.ReplaceAll(body, "\r\n ", "")
	unfolded = strings.ReplaceAll(unfolded, "\n ", "")

	seen := map[string]bool{}
	var out []feedHoliday
	for _, ev := range strings.Split(unfolded, "BEGIN:VEVENT")[1:] {
		d := icsDate.FindStringSubmatch(ev)
		s := icsSummary.FindStringSubmatch(ev)
		if d == nil || s == nil {
			continue
		}
		summary := strings.TrimSpace(s[1])
		est := tentative.MatchString(summary)
		name := strings.TrimSpace(tentative.ReplaceAllString(summary, ""))

		keep := workFreeHolidays[name]
		for _, p := range oneOffPrefixes {
			if strings.HasPrefix(name, p) {
				keep = true
			}
		}
		if !keep {
			continue
		}
		// Match migration 367's naming so a re-import does not rewrite every row.
		if name == "National Day" {
			name = "Independence Day"
		}
		date := fmt.Sprintf("%s-%s-%s", d[1][0:4], d[1][4:6], d[1][6:8])
		if seen[date] {
			continue // a work-free day already claimed this date
		}
		seen[date] = true
		out = append(out, feedHoliday{Date: date, Name: name, Estimated: est})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date < out[j].Date })
	return out
}

// nextWorkingDay is the weekend-substitution rule Temitope chose: a holiday on EITHER
// Saturday or Sunday is observed on the next working day. Skips days already taken, so
// two consecutive weekend holidays land on the Monday and then the Tuesday.
func nextWorkingDay(d time.Time, taken map[string]bool) time.Time {
	for {
		d = d.AddDate(0, 0, 1)
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			continue
		}
		if taken[d.Format("2006-01-02")] {
			continue
		}
		return d
	}
}

// substitutesFor applies the weekend rule to a whole set at once, and it takes the
// DECLARED holidays only — never the substitutes already in the table.
//
// That distinction is the entire correctness of this function, and getting it wrong is
// not a cosmetic bug. The first version allocated against every row in the table, which
// includes the substitutes the PREVIOUS run created. So a substitute looked like an
// obstacle to itself: Boxing Day 2026 fell on Saturday, run one observed it on Monday
// the 28th, run two found the 28th "taken" and observed it again on Tuesday the 29th,
// run three on the 30th. Two runs nine minutes apart on 2026-10-12 left three Boxing
// Days and 75 spurious holidays, and the worker runs weekly, so it would have closed
// the office for another 38 working days every week without anybody authorising a day
// off. Nothing before 2025 was touched and no ticket spanned the two past dates, so the
// published figures were unharmed — this was caught before it mattered, not after.
//
// Being a pure function of the declared set makes it idempotent by construction: the
// same input gives the same output no matter how many times it has run before.
func substitutesFor(declared []feedHoliday) []feedHoliday {
	sorted := append([]feedHoliday(nil), declared...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Date < sorted[j].Date })

	// Seeded from the declared dates alone. A substitute never blocks a substitute
	// except within this one allocation, which is what the taken[key] below adds.
	taken := map[string]bool{}
	for _, h := range sorted {
		taken[h.Date] = true
	}

	var out []feedHoliday
	for _, h := range sorted {
		d, err := time.Parse("2006-01-02", h.Date)
		if err != nil {
			continue
		}
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
			continue
		}
		key := nextWorkingDay(d, taken).Format("2006-01-02")
		// In date order, so Christmas on a Saturday takes the Monday and Boxing Day on
		// the Sunday takes the Tuesday, rather than both wanting the Monday.
		taken[key] = true
		out = append(out, feedHoliday{Date: key, Name: h.Name + " (observed)"})
	}
	return out
}

// reconcileSubstitutes turns what the table holds into what it should hold. Recomputing
// means dropping as well as adding, because a substitute that is no longer derivable
// from a declared holiday is not a holiday — it is a working day the office lost.
//
// Keyed on date AND name so a renamed holiday corrects its substitute's label too.
func reconcileSubstitutes(have, want []feedHoliday) (drop, add []feedHoliday) {
	key := func(h feedHoliday) string { return h.Date + "\x00" + h.Name }

	wanted := map[string]bool{}
	for _, h := range want {
		wanted[key(h)] = true
	}
	held := map[string]bool{}
	for _, h := range have {
		held[key(h)] = true
	}

	for _, h := range have {
		if !wanted[key(h)] {
			drop = append(drop, h)
		}
	}
	for _, h := range want {
		if !held[key(h)] {
			add = append(add, h)
		}
	}
	sort.Slice(drop, func(i, j int) bool { return drop[i].Date < drop[j].Date })
	sort.Slice(add, func(i, j int) bool { return add[i].Date < add[j].Date })
	return drop, add
}

// importNigerianHolidays diffs the feed against the table. With apply=false it changes
// nothing and reports what it would do, which is the only safe way to look at an
// importer that writes to this particular table.
func importNigerianHolidays(ctx context.Context, db *core.DB, apply bool) (*HolidayImport, error) {
	feed, err := fetchHolidayFeed(ctx)
	if err != nil {
		return nil, err
	}
	out := &HolidayImport{
		FeedURL: holidayFeedURL, FetchedAt: time.Now(), FeedHolidays: len(feed), Applied: apply,
	}

	// History is not up for revision: last year onwards only.
	minYear := time.Now().Year() - 1
	cutoff := fmt.Sprintf("%d-01-01", minYear)

	rows, err := db.PGQuery(ctx, `
		SELECT to_char(date,'YYYY-MM-DD') AS d, name, source, is_estimated
		  FROM app.public_holidays
		 WHERE date >= $1::date`, cutoff)
	if err != nil {
		return nil, err
	}
	type existing struct {
		name, source string
		estimated    bool
	}
	have := map[string]existing{}
	for _, r := range rows {
		have[str(r["d"])] = existing{str(r["name"]), str(r["source"]), r["is_estimated"] == true}
	}

	want := map[string]feedHoliday{}
	for _, h := range feed {
		if h.Date < cutoff {
			continue
		}
		want[h.Date] = h
	}

	// Added: the feed names a date we do not hold.
	for _, h := range feed {
		if h.Date < cutoff {
			continue
		}
		if _, ok := have[h.Date]; !ok {
			out.Added = append(out.Added, h)
		}
	}

	// Removed: a date we hold ONLY as our own tentative guess, which the feed no longer
	// names. That is a lunar date that moved once it was declared.
	for d, e := range have {
		if _, ok := want[d]; ok {
			continue
		}
		if e.source == "google_ics" && e.estimated {
			out.Removed = append(out.Removed, feedHoliday{Date: d, Name: e.name, Estimated: true})
		} else if e.source != "substitution" {
			out.Skipped++
		}
	}

	// Moved is the pair of the two above, reported for readability: a removal and an
	// addition within a fortnight is the same holiday shifting.
	for _, add := range out.Added {
		for _, rem := range out.Removed {
			if rem.Name == add.Name {
				out.Moved = append(out.Moved, add)
			}
		}
	}

	sort.Slice(out.Removed, func(i, j int) bool { return out.Removed[i].Date < out.Removed[j].Date })

	// The substitution set is worked out BEFORE the apply/preview fork, so a dry run
	// reports it. That ordering is not tidiness: the first version computed substitutes
	// only on the apply path, so the runaway described in substitutesFor could not be
	// seen in a preview at all. The one thing this importer does that is hard to reason
	// about was the one thing you could not look at without writing to the table.
	declared := make([]feedHoliday, 0, len(have))
	held := make([]feedHoliday, 0, len(have))
	pendingRemoval := map[string]bool{}
	for _, h := range out.Removed {
		pendingRemoval[h.Date] = true
	}
	for d, e := range have {
		if pendingRemoval[d] {
			continue
		}
		switch e.source {
		case "substitution":
			held = append(held, feedHoliday{Date: d, Name: e.name})
		default:
			declared = append(declared, feedHoliday{Date: d, Name: e.name})
		}
	}
	// Dates about to be inserted are declared holidays for this purpose, so a new Eid on
	// a Saturday gets its substitute in the same run that adds it.
	declared = append(declared, out.Added...)

	drop, add := reconcileSubstitutes(held, substitutesFor(declared))
	out.SubstitutesDropped, out.Substitutes = drop, add

	if !apply {
		return out, nil
	}

	for _, h := range out.Removed {
		if _, err := db.PGExec(ctx,
			`DELETE FROM app.public_holidays
			  WHERE date=$1::date AND source='google_ics' AND is_estimated`, h.Date); err != nil {
			return nil, fmt.Errorf("removing moved holiday %s: %w", h.Date, err)
		}
	}
	for _, h := range out.Added {
		if _, err := db.PGExec(ctx, `
			INSERT INTO app.public_holidays (date, name, source, is_estimated)
			VALUES ($1::date, $2, 'google_ics', $3)
			ON CONFLICT (date) DO NOTHING`, h.Date, h.Name, h.Estimated); err != nil {
			return nil, fmt.Errorf("adding holiday %s: %w", h.Date, err)
		}
	}

	// Batched into one statement each because migration 367's rebuild trigger is
	// statement-level: a row-at-a-time reconcile would rebuild the whole materialised
	// calendar a hundred-odd times for one import.
	if len(drop) > 0 {
		args := make([]any, 0, len(drop))
		ph := make([]string, 0, len(drop))
		for i, h := range drop {
			ph = append(ph, fmt.Sprintf("$%d", i+1))
			args = append(args, h.Date)
		}
		// source='substitution' in the predicate is the safety rail: this statement can
		// never reach a declared holiday or a human's correction.
		if _, err := db.PGExec(ctx, `
			DELETE FROM app.public_holidays
			 WHERE source = 'substitution'
			   AND date IN (`+strings.Join(ph, ",")+`)`, args...); err != nil {
			return nil, fmt.Errorf("dropping %d stale substitute(s): %w", len(drop), err)
		}
	}
	if len(add) > 0 {
		args := make([]any, 0, len(add)*2)
		vals := make([]string, 0, len(add))
		for i, h := range add {
			vals = append(vals, fmt.Sprintf("($%d::date, $%d, 'substitution', false)", i*2+1, i*2+2))
			args = append(args, h.Date, h.Name)
		}
		if _, err := db.PGExec(ctx, `
			INSERT INTO app.public_holidays (date, name, source, is_estimated)
			VALUES `+strings.Join(vals, ",")+`
			ON CONFLICT (date) DO NOTHING`, args...); err != nil {
			return nil, fmt.Errorf("adding %d substitute(s): %w", len(add), err)
		}
	}

	slog.Info("holiday import applied",
		"added", len(out.Added), "removed", len(out.Removed),
		"substitutes_added", len(out.Substitutes),
		"substitutes_dropped", len(out.SubstitutesDropped),
		"left_alone", out.Skipped)
	return out, nil
}

/* ── Routes ─────────────────────────────────────────────────────────────────── */

// RegisterHolidays mounts the importer. Gated on admin because it writes the table
// every reported duration is computed from — see handlers/people.go for why the People
// Directory itself has no write route at all.
func RegisterHolidays(r chi.Router, db *core.DB) {
	gate := core.RequirePages("admin")

	// Preview changes nothing. Look before you write to this table.
	r.With(gate).Get("/preview", func(w http.ResponseWriter, req *http.Request) {
		res, err := importNigerianHolidays(req.Context(), db, false)
		if err != nil {
			respondErrLog(w, http.StatusBadGateway, "could not read the holiday feed", err)
			return
		}
		respond(w, res, holidayFeedURL)
	})

	r.With(gate).Post("/import", func(w http.ResponseWriter, req *http.Request) {
		res, err := importNigerianHolidays(req.Context(), db, true)
		if err != nil {
			respondErrLog(w, http.StatusBadGateway, "could not import the holiday feed", err)
			return
		}
		respond(w, res, holidayFeedURL)
	})

	// Coverage per year, so "is this clock trustworthy for 2027" has an answer.
	r.With(gate).Get("/coverage", func(w http.ResponseWriter, req *http.Request) {
		rows, err := db.PGQuery(req.Context(), `SELECT * FROM app.v_holiday_coverage`)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read holiday coverage", err)
			return
		}
		respond(w, rows, "app.v_holiday_coverage")
	})
}

// ScheduleHolidayImport re-imports weekly. Weekly rather than daily because the thing
// it is watching for — a tentative Eid being declared — happens a handful of times a
// year, and because the rules above mean a run usually changes nothing at all.
func ScheduleHolidayImport(db *core.DB) {
	// Not on boot: a deploy should not be waiting on an external calendar.
	time.Sleep(10 * time.Minute)
	for {
		ctx := context.Background()
		WorkerBeat(ctx, db, "holiday_import", "running", "", "")
		res, err := importNigerianHolidays(ctx, db, true)
		switch {
		case err != nil:
			// A feed that cannot be reached is not an emergency: the table already
			// holds every date through 2031.
			slog.Warn("holiday import skipped", "err", err)
			WorkerBeat(ctx, db, "holiday_import", "error", "", err.Error())
		default:
			// The summary goes in detail, not in the error slot: WorkerBeat's 'ok'
			// branch writes $2 (detail) and discards errStr, so passing it the other
			// way round left the Workers page showing a green row with nothing on it.
			// A run that changes nothing is the expected outcome here, so "added 0,
			// moved 0" is the line that proves the recomputation is stable — losing
			// it is losing the only reason to look at this worker at all.
			WorkerBeat(ctx, db, "holiday_import", "ok",
				fmt.Sprintf("added %d, moved %d, substitutes +%d/-%d",
					len(res.Added), len(res.Removed),
					len(res.Substitutes), len(res.SubstitutesDropped)), "")
		}
		time.Sleep(7 * 24 * time.Hour)
	}
}
