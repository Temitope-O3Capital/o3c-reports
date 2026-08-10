package iswsettle

import (
	"bufio"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestLiveImport parses a directory of real Interswitch reports and loads them.
// Gated behind ISW_LIVE_TEST=1; point ISW_DIR at the extracted folder.
//
//	ISW_LIVE_TEST=1 ISW_DIR=/path/to/csvs go test ./iswsettle -run TestLiveImport -v
func TestLiveImport(t *testing.T) {
	if os.Getenv("ISW_LIVE_TEST") != "1" {
		t.Skip("set ISW_LIVE_TEST=1 to run the live Interswitch import test")
	}
	dir := os.Getenv("ISW_DIR")
	if dir == "" {
		t.Fatal("set ISW_DIR to the folder of extracted Interswitch CSVs")
	}
	env := readDotEnv(t, "../.env")

	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := context.Background()

	mig, err := os.ReadFile("../migrations/126_interswitch_settlement.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if _, err := pg.ExecContext(ctx, string(mig)); err != nil {
		t.Fatalf("apply migration 126: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}

	var all []Leg
	perFamily := map[string]int{}
	skipped, parsed, failed := 0, 0, 0

	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".csv") {
			continue
		}
		f, err := os.Open(filepath.Join(dir, e.Name()))
		if err != nil {
			failed++
			continue
		}
		legs, perr := ParseFile(f, e.Name())
		f.Close()
		if perr != nil {
			failed++
			t.Logf("parse error %s: %v", e.Name(), perr)
			continue
		}
		if len(legs) == 0 {
			skipped++ // aggregate report, correctly ignored
			continue
		}
		parsed++
		for _, l := range legs {
			perFamily[l.ReportFamily]++
		}
		all = append(all, legs...)
	}

	t.Logf("files: parsed=%d skipped(aggregate)=%d failed=%d", parsed, skipped, failed)
	t.Logf("legs parsed: %d", len(all))

	var fams []string
	for k := range perFamily {
		fams = append(fams, k)
	}
	sort.Strings(fams)
	for _, k := range fams {
		t.Logf("  %-24s %6d legs", k, perFamily[k])
	}

	if len(all) == 0 {
		t.Fatal("parsed no legs at all — parser or directory is wrong")
	}

	ins, skip, err := Insert(ctx, db, all)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	t.Logf("inserted=%d skipped(duplicate)=%d", ins, skip)

	// Sanity: the collapsed view must never report more transactions than legs.
	var legsN, txnsN int
	if err := pg.QueryRowContext(ctx, `SELECT COUNT(*) FROM interswitch_legs`).Scan(&legsN); err != nil {
		t.Fatalf("count legs: %v", err)
	}
	if err := pg.QueryRowContext(ctx, `SELECT COUNT(*) FROM interswitch_transactions`).Scan(&txnsN); err != nil {
		t.Fatalf("count txns: %v", err)
	}
	t.Logf("legs in table: %d   collapsed transactions: %d  (fan-out %.2fx)",
		legsN, txnsN, float64(legsN)/float64(max(txnsN, 1)))
	if txnsN > legsN {
		t.Errorf("collapsed transactions (%d) exceed legs (%d) — grouping is wrong", txnsN, legsN)
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
