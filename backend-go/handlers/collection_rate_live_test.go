package handlers

import (
	"context"
	"database/sql"
	"math"
	"os"
	"testing"

	"github.com/o3c/workspace/core"
)

// THE COLLECTION RATE IS THE RIGHT NUMBER, not merely a non-zero one.
//
// This exists because TestKPITilesAreNotSilentlyZeroLive passed on a version of
// collectionRateToDate that was wrong. The first draft joined app.collection_payments
// straight onto app.collection_assignments, which repeats the assignment row once per
// payment, so SUM(target_amount_kobo) counted the same target several times: the
// denominator came out at NGN 3.11bn instead of NGN 1.86bn and the rate read 25.2%
// instead of 42.1%. Every test in the suite was green.
//
// That is the limit of a "is this tile zero?" test, and it is worth naming: it can tell
// you a metric has come alive, and it cannot tell you the metric is correct. A ratio
// needs its two sides checked INDEPENDENTLY, which is what this does — it rebuilds the
// numerator and the denominator with two separate single-table queries that cannot
// fan out, and compares them with what the helper returns.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestCollectionRateMatchesItsOwnPartsLive -v
func TestCollectionRateMatchesItsOwnPartsLive(t *testing.T) {
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
	ctx := context.Background()

	// The denominator, from assignments alone. One row per assignment by construction,
	// so nothing can inflate it.
	var targetKobo float64
	if rows, err := db.PGQuery(ctx,
		`SELECT COALESCE(SUM(target_amount_kobo), 0) AS t
		   FROM app.collection_assignments
		  WHERE COALESCE(target_amount_kobo, 0) > 0`); err != nil || len(rows) == 0 {
		t.Fatalf("could not read targets: %v", err)
	} else {
		targetKobo = toFloat(rows[0]["t"])
	}
	if targetKobo <= 0 {
		t.Skip("no collection targets are set, so there is no rate to check")
	}

	// The numerator, from payments alone, restricted to the same population: approved
	// payments whose assignment carries a target. A subquery, not a join, for the same
	// reason the helper uses one.
	var collectedKobo float64
	if rows, err := db.PGQuery(ctx,
		`SELECT COALESCE(SUM(amount_kobo), 0) AS c
		   FROM app.collection_payments
		  WHERE status = 'approved'
		    AND assignment_id IN (
		        SELECT id FROM app.collection_assignments
		         WHERE COALESCE(target_amount_kobo, 0) > 0)`); err != nil || len(rows) == 0 {
		t.Fatalf("could not read payments: %v", err)
	} else {
		collectedKobo = toFloat(rows[0]["c"])
	}

	want := math.Round(collectedKobo/targetKobo*1000) / 10 // round1, as the helper does
	got, ok := collectionRateToDate(ctx, db, 0).(float64)
	if !ok {
		t.Fatalf("collectionRateToDate returned no rate while targets totalling %.2f kobo exist", targetKobo)
	}

	if math.Abs(got-want) > 0.05 {
		t.Errorf("collection rate is %.1f%% but its own parts say %.1f%% "+
			"(collected %.2f kobo / target %.2f kobo). A gap here means the query is "+
			"fanning out — check that payments are aggregated per assignment BEFORE the "+
			"join, or the same target is being counted once per payment.",
			got, want, collectedKobo, targetKobo)
	}

	// A rate over 100% is not impossible in principle, but with this data it would mean
	// the denominator has shrunk relative to the numerator — the fan-out bug inverted.
	// Worth failing on, because it is the shape of the error that looks like good news.
	if got > 100.0 {
		t.Errorf("collection rate reads %.1f%%: collections exceed targets, which with "+
			"only 259 targeted assignments almost certainly means the two sides are "+
			"drawn from different populations again", got)
	}
}
