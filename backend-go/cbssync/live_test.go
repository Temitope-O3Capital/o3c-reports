package cbssync

import (
	"bufio"
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
	"github.com/o3c/reports/udara"
)

// TestLiveSync spools the live Udara360 book into the snapshot tables against the
// real workspace database, then reconciles. It is gated behind CBS_LIVE_TEST=1 so
// it never runs in normal CI. It reads credentials from ../.env (the same file the
// backend uses) and applies migration 110 idempotently before syncing.
//
//	CBS_LIVE_TEST=1 go test ./cbssync -run TestLiveSync -v
func TestLiveSync(t *testing.T) {
	if os.Getenv("CBS_LIVE_TEST") != "1" {
		t.Skip("set CBS_LIVE_TEST=1 to run the live CBS sync test")
	}
	env := readDotEnv(t, "../.env")

	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := context.Background()

	// Reset the derived snapshot tables so schema iterations take effect (safe: these
	// hold only CBS-derived data that the sync rebuilds). Not run in production.
	if _, err := pg.ExecContext(ctx, `DROP TABLE IF EXISTS cbs_loans, cbs_fixed_deposits, cbs_products CASCADE`); err != nil {
		t.Fatalf("reset snapshot tables: %v", err)
	}

	// Apply migration 110 (CREATE ... IF NOT EXISTS -> idempotent). pgx stdlib runs
	// multi-statement SQL via the simple protocol when there are no args.
	mig, err := os.ReadFile("../migrations/110_cbs_integration.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if _, err := pg.ExecContext(ctx, string(mig)); err != nil {
		t.Fatalf("apply migration 110: %v", err)
	}

	c := udara.New(env["UDARA360_BASE_URL"], env["UDARA360_CLIENT_ID"], env["UDARA360_CLIENT_SECRET"])
	if !c.IsConfigured() {
		t.Fatal("udara client not configured from .env")
	}

	res, err := SyncAll(ctx, c, db, "manual", sql.NullInt64{})
	if err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	t.Logf("sync result: products=%d loans=%d fds=%d matched=%d unmatched=%d",
		res.Products, res.Loans, res.FDs, res.Matched, res.Unmatched)

	if res.Products == 0 || res.Loans == 0 || res.FDs == 0 {
		t.Fatalf("expected non-zero product/loan/fd counts, got %+v", res)
	}

	// Diagnostic: analyse fetched loans/FDs for blank or duplicate CBS ids.
	for _, d := range []struct {
		name, path string
	}{{"loans", "/api/LoanAccount/v1/Search"}, {"fds", "/api/FixedDepositAccount/v1/Search"}} {
		recs, ferr := fetchFullBook(ctx, c, d.path)
		if ferr != nil {
			t.Logf("diag %s: fetch err %v", d.name, ferr)
			continue
		}
		ids := map[string]int{}
		empty := 0
		for _, m := range recs {
			id := gstr(m, "id")
			if id == "" {
				empty++
			} else {
				ids[id]++
			}
		}
		dups := 0
		for _, n := range ids {
			if n > 1 {
				dups++
			}
		}
		t.Logf("diag %s: fetched=%d distinct_id=%d empty_id=%d dup_ids=%d", d.name, len(recs), len(ids), empty, dups)
	}

	// Cross-check row counts landed in the snapshot tables.
	for tbl, got := range map[string]int{
		"cbs_products":       res.Products,
		"cbs_loans":          res.Loans,
		"cbs_fixed_deposits": res.FDs,
	} {
		var n int
		if err := pg.QueryRowContext(ctx, "SELECT count(*) FROM "+tbl).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", tbl, err)
		}
		if n != got {
			t.Errorf("%s: snapshot has %d rows, sync reported %d", tbl, n, got)
		}
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
