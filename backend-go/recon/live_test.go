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

	"github.com/o3c/workspace/core"
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

	// The engine's tables must already exist; this test does NOT create them.
	//
	// It used to re-apply migrations/125_recon_engine.sql by hand, which stopped
	// working: that migration ends with CREATE INDEX on core.transaction, and
	// core.transaction is now a VIEW, so the statement fails with SQLSTATE 42809
	// and took the whole test down before a single row was reconciled. Re-applying
	// a migration from a test was always the wrong move — migrations are embedded
	// and applied when the server boots, so the only thing worth checking here is
	// that the schema this test needs is actually present.
	for _, rel := range []string{"recon_runs", "recon_matches", "recon_exceptions"} {
		var ok bool
		if err := pg.QueryRowContext(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			                WHERE n.nspname = 'app' AND c.relname = $1 AND c.relkind = 'r')`,
			rel).Scan(&ok); err != nil {
			t.Fatalf("check %s: %v", rel, err)
		}
		if !ok {
			t.Fatalf("app.%s missing — boot the server once to apply migrations", rel)
		}
	}

	// Wide enough to span both books: the CCS master runs 2025-01 → 2025-12, the
	// Interswitch uploads 2024-12 → 2026-07. A window covering only one of them
	// would make the other pair look broken when it is merely out of period.
	from := time.Date(2024, 12, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)

	for _, pair := range Pairs() {
		t.Run(pair.String(), func(t *testing.T) {
			spec, ok := specFor(pair)
			if !ok {
				t.Fatalf("no spec for %s", pair)
			}

			start := time.Now()
			res, err := Run(ctx, db, pair, from, to, "manual", sql.NullInt64{})
			if err != nil {
				t.Fatalf("Run: %v", err)
			}

			t.Logf("run %d completed in %s", res.RunID, time.Since(start).Round(time.Millisecond))
			t.Logf("source          %6d rows  ₦%.2f", res.SourceN, float64(res.SourceValueKobo)/100)
			t.Logf("matched         %6d rows  ₦%.2f  (%.1f%%)", res.MatchedN,
				float64(res.MatchedValueKobo)/100,
				100*float64(res.MatchedN)/float64(max(res.SourceN, 1)))
			t.Logf("ambiguous       %6d rows", res.AmbiguousN)
			t.Logf("master_no_data  %6d rows", res.MasterNoDataN)
			t.Logf("unmatched total %6d rows  ₦%.2f", res.UnmatchedN, float64(res.UnmatchedValueKobo)/100)
			for _, tr := range spec.Tiers {
				t.Logf("  tier %-22s %6d", tr.Name, res.PerTier[tr.Name])
			}

			if res.SourceN == 0 {
				t.Fatalf("no source rows staged for %s", pair)
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

			// A source row must never be claimed twice either — the staging key has
			// to be unique at the source's own grain. For the Interswitch feed that
			// grain is (report_family, session, settlement_date, rrn), because RRN
			// alone repeats across families: 4,275 rows carry only 3,948 RRNs.
			var srcDupes int
			if err := pg.QueryRowContext(ctx, `
				SELECT COUNT(*) FROM (
				  SELECT source_key FROM recon_matches WHERE run_id=$1
				  GROUP BY source_key HAVING COUNT(*) > 1) x`, res.RunID).Scan(&srcDupes); err != nil {
				t.Fatalf("source dupe check: %v", err)
			}
			if srcDupes != 0 {
				t.Errorf("%d source rows matched more than once", srcDupes)
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
		})
	}
}

// TestPairAliasResolvesToCanonical pins the rename down. The engine shipped with
// this pair registered as "interswitch↔sage_ledger" while it actually compared the
// CCS master to the card account book, so any run recorded under the old name
// asserted a reconciliation that had not happened. The alias must keep working for
// existing callers AND must record the honest name.
func TestPairAliasResolvesToCanonical(t *testing.T) {
	spec, ok := specFor(InterswitchSage)
	if !ok {
		t.Fatal("deprecated pair name no longer resolves — existing callers would break")
	}
	if spec.Pair != CCSCardLedger {
		t.Errorf("alias resolved to %s, want %s", spec.Pair, CCSCardLedger)
	}
	if _, ok := specFor(Pair{Source: "nope", Counterparty: "nope"}); ok {
		t.Error("unknown pair resolved to a spec")
	}
	for _, p := range Pairs() {
		if _, ok := specFor(p); !ok {
			t.Errorf("advertised pair %s has no spec", p)
		}
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
