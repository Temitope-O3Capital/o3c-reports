package recon

import (
	"bufio"
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestLiveRun reconciles the real 2025 Interswitch book against the Sage ledger.
// Gated behind RECON_LIVE_TEST=1 so it never runs in normal CI.
//
//	RECON_LIVE_TEST=1 go test ./recon -run TestLiveRun -v -timeout 30m
func TestLiveRun(t *testing.T) {
	if os.Getenv("RECON_LIVE_TEST") != "1" {
		t.Skip("set RECON_LIVE_TEST=1 to run the live reconciliation test")
	}
	env := readDotEnv(t, "../.env")

	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := context.Background()

	mig, err := os.ReadFile("../migrations/125_recon_engine.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if _, err := pg.ExecContext(ctx, string(mig)); err != nil {
		t.Fatalf("apply migration 125: %v", err)
	}

	from := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)

	start := time.Now()
	res, err := Run(ctx, db, InterswitchSage, from, to, "manual", sql.NullInt64{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	t.Logf("run %d completed in %s", res.RunID, time.Since(start).Round(time.Millisecond))
	t.Logf("source          %6d rows  ₦%.2f", res.SourceN, float64(res.SourceValueKobo)/100)
	t.Logf("matched         %6d rows  ₦%.2f  (%.1f%%)", res.MatchedN,
		float64(res.MatchedValueKobo)/100,
		100*float64(res.MatchedN)/float64(max(res.SourceN, 1)))
	t.Logf("ambiguous       %6d rows", res.AmbiguousN)
	t.Logf("unmatched total %6d rows  ₦%.2f", res.UnmatchedN, float64(res.UnmatchedValueKobo)/100)
	for _, tr := range interswitchTiers {
		t.Logf("  tier %-22s %6d", tr.Name, res.PerTier[tr.Name])
	}

	if res.SourceN == 0 {
		t.Fatal("no source rows staged — expected the 2025 Interswitch book")
	}
	if res.MatchedN+res.UnmatchedN != res.SourceN {
		t.Errorf("accounting error: matched %d + unmatched %d != source %d",
			res.MatchedN, res.UnmatchedN, res.SourceN)
	}

	// A ledger row must never be claimed twice within a run.
	var dupes int
	if err := pg.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
		  SELECT counterparty_key FROM recon_matches WHERE run_id=$1
		  GROUP BY counterparty_key HAVING COUNT(*) > 1) x`, res.RunID).Scan(&dupes); err != nil {
		t.Fatalf("dupe check: %v", err)
	}
	if dupes != 0 {
		t.Errorf("%d ledger rows matched more than once", dupes)
	}

	// Exception mix — this is the queue the settlement team would work.
	rows, err := pg.QueryContext(ctx, `
		SELECT reason, COUNT(*), COALESCE(SUM(ABS(amount_kobo)),0)
		FROM recon_exceptions WHERE run_id=$1 GROUP BY reason ORDER BY 2 DESC`, res.RunID)
	if err != nil {
		t.Fatalf("exception mix: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var reason string
		var n int
		var value int64
		if err := rows.Scan(&reason, &n, &value); err != nil {
			t.Fatalf("scan: %v", err)
		}
		t.Logf("  exception %-14s %6d rows  ₦%.2f", reason, n, float64(value)/100)
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func readDotEnv(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return out
}
