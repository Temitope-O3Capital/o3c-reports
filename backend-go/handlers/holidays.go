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
  source='substitution'  recomputed, because a new holiday on a weekend needs one.
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
	Applied      bool          `json:"applied"`
	Skipped      int           `json:"skipped_not_ours"`
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

	// A holiday the importer just added may fall on a weekend, and then it needs the
	// substitute working day that migration 367 generated for everything it seeded.
	subs, err := db.PGQuery(ctx, `
		SELECT to_char(date,'YYYY-MM-DD') AS d, name
		  FROM app.public_holidays
		 WHERE date >= $1::date
		   AND EXTRACT(ISODOW FROM date) IN (6, 7)
		 ORDER BY date`, cutoff)
	if err != nil {
		return nil, err
	}
	taken, err := db.PGQuery(ctx,
		`SELECT to_char(date,'YYYY-MM-DD') AS d FROM app.public_holidays WHERE date >= $1::date`, cutoff)
	if err != nil {
		return nil, err
	}
	isTaken := map[string]bool{}
	for _, r := range taken {
		isTaken[str(r["d"])] = true
	}
	for _, r := range subs {
		d, perr := time.Parse("2006-01-02", str(r["d"]))
		if perr != nil {
			continue
		}
		obs := nextWorkingDay(d, isTaken)
		key := obs.Format("2006-01-02")
		name := str(r["name"]) + " (observed)"
		res, err := db.PGExec(ctx, `
			INSERT INTO app.public_holidays (date, name, source, is_estimated)
			VALUES ($1::date, $2, 'substitution', false)
			ON CONFLICT (date) DO NOTHING`, key, name)
		if err != nil {
			return nil, fmt.Errorf("adding substitute %s: %w", key, err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			isTaken[key] = true
			out.Substitutes = append(out.Substitutes, feedHoliday{Date: key, Name: name})
		}
	}

	slog.Info("holiday import applied",
		"added", len(out.Added), "removed", len(out.Removed),
		"substitutes", len(out.Substitutes), "left_alone", out.Skipped)
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
			WorkerBeat(ctx, db, "holiday_import", "ok", "",
				fmt.Sprintf("added %d, moved %d, substitutes %d",
					len(res.Added), len(res.Removed), len(res.Substitutes)))
		}
		time.Sleep(7 * 24 * time.Hour)
	}
}
