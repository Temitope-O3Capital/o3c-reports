package paystacksync

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

// TestLiveSync mirrors the live Paystack account into the snapshot tables against
// the real workspace database. Gated behind PAYSTACK_LIVE_TEST=1 so it never runs
// in normal CI. Reads PAYSTACK_SECRET_KEY and DATABASE_URL from ../.env (the same
// file the backend uses) and applies migration 122 idempotently first.
//
// The first run is a full backfill (~31k records, ~315 paced requests, a few
// minutes). Later runs only re-pull the trailing overlap window.
//
//	PAYSTACK_LIVE_TEST=1 go test ./paystacksync -run TestLiveSync -v -timeout 40m
func TestLiveSync(t *testing.T) {
	if os.Getenv("PAYSTACK_LIVE_TEST") != "1" {
		t.Skip("set PAYSTACK_LIVE_TEST=1 to run the live Paystack sync test")
	}
	env := readDotEnv(t, "../.env")

	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := context.Background()

	mig, err := os.ReadFile("../migrations/124_paystack_mirror.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if _, err := pg.ExecContext(ctx, string(mig)); err != nil {
		t.Fatalf("apply migration 124: %v", err)
	}

	secret := env["PAYSTACK_SECRET_KEY"]
	if secret == "" {
		t.Fatal("PAYSTACK_SECRET_KEY not found in ../.env")
	}

	kind := "manual"
	if os.Getenv("PAYSTACK_BACKFILL") == "1" {
		kind = "backfill"
	}

	start := time.Now()
	res, err := SyncAll(ctx, db, secret, kind, sql.NullInt64{})
	if err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	t.Logf("sync (%s) in %s: transactions=%d transfers=%d settlements=%d disputes=%d",
		kind, time.Since(start).Round(time.Second),
		res.Transactions, res.Transfers, res.Settlements, res.Disputes)

	// Settlements always sync in full, so they are the reliable non-zero check.
	if res.Settlements == 0 {
		t.Errorf("expected non-zero settlements, got %+v", res)
	}

	for _, tbl := range []string{
		"paystack_transactions", "paystack_transfers",
		"paystack_settlements", "paystack_disputes",
	} {
		var n int
		if err := pg.QueryRowContext(ctx, "SELECT count(*) FROM "+tbl).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", tbl, err)
		}
		t.Logf("%-24s %d rows", tbl, n)
	}

	// Status mix — this is what the Exceptions & Failures queue will read.
	rows, err := pg.QueryContext(ctx, `
		SELECT 'transfer' AS src, status, count(*) FROM paystack_transfers GROUP BY 1,2
		UNION ALL
		SELECT 'transaction', status, count(*) FROM paystack_transactions GROUP BY 1,2
		ORDER BY 1,3 DESC`)
	if err != nil {
		t.Fatalf("status mix: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var src, status string
		var n int
		if err := rows.Scan(&src, &status, &n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		t.Logf("  %-12s %-12s %d", src, status, n)
	}
}

// readDotEnv parses KEY=VALUE lines from a .env file (ignoring blanks/comments).
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
