package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/o3c/workspace/core"
)

// WHY THIS TEST EXISTS.
//
// The reporting module already had a live test that executed every BI query against the
// real database. It asserted one thing: that the query did not ERROR.
//
//	if _, err := db.PGQuery(ctx, q); err != nil { t.Fatalf(...) }
//
// Every defect this module actually had sailed through it, because every one of them was
// valid SQL returning a valid zero. Found on 2026-10-07, all of them green in CI:
//
//   - recovery_rate_pct filtered status='recovered', a value no writer has ever
//     produced, across 1,617 cases.
//   - total_disbursed_kobo read an 8-row table whose amount column was entirely NULL
//     and whose status never matched the filter.
//   - The BI campaigns funnel summed five counters that nothing increments, while the
//     per-channel counters beside them held 5,230 real sends.
//   - csat_score averaged a column that is NULL on all 40,616 tickets.
//   - collection_rate_pct divided by a rollup table with no rows.
//   - Every RAG indicator read a targets table whose write route was never mounted.
//
// A "does it parse" test on a reporting module does not catch the failure mode reporting
// modules actually have: a number that is confidently, permanently, wrong — and zero is
// the most dangerous wrong number there is, because it reads as an answer.
//
// So this test asserts the opposite thing. Every numeric tile must either carry a real
// value, or be named below with a reason why zero is the truth.
//
// IT ALSO FAILS WHEN AN EXEMPTION STOPS BEING TRUE. That is the half that makes the list
// shrink instead of grow: once someone wires up a CSAT writer, this test fails until the
// exemption is deleted. An exemption list that only ever grows is just a list of things
// everyone agreed to stop looking at.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestKPITilesAreNotSilentlyZeroLive -v
//
// It is gated like the other live tests because it needs the production database: the
// whole point is to measure what the tiles say TODAY, which no fixture can tell us.

// kpiZeroIsTheTruth names every tile allowed to read zero, and why.
//
// A reason must say what was MEASURED, not what is assumed. "No data yet" is not a
// reason; "0 of 40,616 rows populated, no writer exists" is.
var kpiZeroIsTheTruth = map[string]string{
	// CORRECTED 2026-10-12. This entry used to read "no code path writes it", which was
	// wrong, and a true-sounding wrong reason is worse than no reason: it closed the
	// question. The writer exists and is complete — hdCSATSubmit on a public route, and
	// all 40,789 tickets already carry a csat_token minted by the Zoho sync. Two
	// measured reasons nothing arrives:
	//
	//  1. The survey email fires from ONE place, the in-app resolve endpoint, so every
	//     Zoho-synced closure bypasses it: 46 CSAT emails ever sent against 29,240
	//     tickets with resolved_at — 0.16%.
	//  2. Those 46 could not have been answered anyway. The link is built from
	//     settings.app_base_url = crm.o3cards.pri:8443, a private host no customer's
	//     browser can resolve.
	//
	// So this is not "nobody built it". It was built, and pointed inwards.
	"csat_score": "the CSAT writer EXISTS (hdCSATSubmit, public route; all 40,789 tickets " +
		"carry a token) but the send fires only from the in-app resolve path — 46 emails " +
		"against 29,240 resolved tickets — and the link uses the private host " +
		"crm.o3cards.pri:8443, so no customer could answer one. Needs a public " +
		"app_base_url and the send hooked to the Zoho close path; not a new writer.",

	// collection_rate_pct IS NO LONGER EXEMPT. It read zero because both producers
	// divided by app.collections_daily_kpi, which has 0 rows; they now share
	// collectionRateToDate, which measures 42.1% against real targets. Deleting the
	// exemption is the point of the mechanism — the list is supposed to shrink.

	"targets_set": "app.kpi_targets is empty. The write route is now mounted (see " +
		"RegisterKPI in main.go), so this clears as soon as anyone sets a target. Delete " +
		"this exemption the day they do.",
}

func TestKPITilesAreNotSilentlyZeroLive(t *testing.T) {
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}

	// A whole year, so a quiet week cannot be mistaken for a broken metric. A tile that
	// is zero across twelve months is not having a slow month.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/?period=this_year", nil)
	reportKPIsHandler(db)(rec, req)

	if rec.Code != 200 {
		t.Fatalf("kpis returned %d, body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Data) == 0 {
		t.Fatal("kpis returned no tiles at all")
	}

	seen := map[string]bool{}
	for key, raw := range body.Data {
		f, numeric := kpiNumeric(raw)
		if !numeric {
			continue // labels, dates and period strings are not tiles
		}
		seen[key] = true
		reason, exempt := kpiZeroIsTheTruth[key]

		switch {
		case f != 0 && exempt:
			// The good failure: something got fixed and the list did not keep up.
			t.Errorf("%s now reads %v, so its exemption is stale — DELETE it from "+
				"kpiZeroIsTheTruth. Recorded reason was: %s", key, raw, reason)
		case f == 0 && !exempt:
			t.Errorf("%s is zero over a full year and nothing explains why. Either it is "+
				"broken (look at its query before you believe the number), or zero really "+
				"is the truth — in which case add it to kpiZeroIsTheTruth with what you "+
				"MEASURED, not what you assume.", key)
		}
	}

	// An exemption for a tile that no longer exists is dead weight, and worse, it quietly
	// covers for a tile someone removed rather than fixed.
	for key := range kpiZeroIsTheTruth {
		if !seen[key] {
			t.Errorf("kpiZeroIsTheTruth names %q, but the KPI payload has no such numeric "+
				"tile. Remove the exemption, or restore the tile.", key)
		}
	}
}

// kpiNumeric reports whether a decoded JSON value is a number, and its value.
//
// Everything arrives as float64 through encoding/json, but kobo figures come back from
// Postgres as NUMERIC, which the driver hands over as a string — so a money tile would
// otherwise be skipped as "not a tile", which is exactly the kind of silent hole this
// test exists to close.
func kpiNumeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		// Only treat a string as numeric if it parses whole; a status label must not be
		// silently read as 0 and then reported as a broken tile.
		var f float64
		if _, err := json.Marshal(n); err == nil {
			if err := json.Unmarshal([]byte(n), &f); err == nil {
				return f, true
			}
		}
		return 0, false
	}
	return 0, false
}

// TestKPIsRejectAMalformedDate needs no database: the guard must fire before any query
// runs. That is the whole point — the old code let a bad date through to Postgres, every
// cast threw, every error was discarded, and the caller got HTTP 200 with a page of
// zeros. A rejection is the only honest answer, and it is also the cheap one.
func TestKPIsRejectAMalformedDate(t *testing.T) {
	for _, q := range []string{
		"/?from=garbage",
		"/?to=garbage",
		"/?from=2026-13-45",
		"/?from=2026%2F01%2F01",
		"/?to=yesterday",
	} {
		rec := httptest.NewRecorder()
		// A nil *core.DB is deliberate: if the handler reaches the database on a
		// malformed date, this test panics rather than quietly passing.
		reportKPIsHandler(nil)(rec, httptest.NewRequest("GET", q, nil))
		if rec.Code != 400 {
			t.Errorf("%s returned %d, want 400 — a bad date must not reach the queries",
				q, rec.Code)
		}
	}
}
