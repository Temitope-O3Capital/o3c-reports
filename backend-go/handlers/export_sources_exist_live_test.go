package handlers

import (
	"context"
	"database/sql"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// EVERY DATASET'S SOURCE RELATION MUST ACTUALLY EXIST.
//
// This is the one thing TestExportDatasetsRunLive cannot tell you, and the gap is by
// design rather than by accident. core.isTableMissing recognises PostgreSQL's 42P01
// ("relation does not exist") and the query helpers turn it into an EMPTY RESULT WITH A
// NIL ERROR, so that a module under construction shows a clean empty state instead of an
// error page. That is a good decision for a half-built module and a blind spot for a
// test suite: a dataset pointed at a table that does not exist runs, returns nothing,
// and passes.
//
// It is not hypothetical. The October audit found exactly this twice — Monthly Business
// and Settlement Reconciliation both summed a relation called "Collections Log" which
// exists in no schema, and reported total_collections as null for months with nothing
// anywhere raising a fault. And it caught me the same day: I added the whatsapp_messages
// dataset before its migration had been applied, ran the live dataset test, and watched
// it pass against a table that was not there.
//
// So this test asks the question the other one structurally cannot: for every relation
// named in every dataset's FROM clause, does Postgres know it?
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestEveryDatasetSourceExistsLive -v
func TestEveryDatasetSourceExistsLive(t *testing.T) {
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

	// Every app-schema relation named anywhere in a FROM clause, joins included. Matching
	// on the schema prefix keeps aliases, ON conditions and column references out: a
	// dataset writes app.customers c, never a bare customers.
	rel := regexp.MustCompile(`\bapp\.([a-z_][a-z0-9_]*)`)

	// relation name -> the datasets that read it, so a missing table is reported once
	// with everything it breaks rather than once per dataset.
	used := map[string][]string{}
	for _, d := range exportDatasets {
		seen := map[string]bool{}
		for _, m := range rel.FindAllStringSubmatch(d.From, -1) {
			name := m[1]
			if seen[name] {
				continue
			}
			seen[name] = true
			used[name] = append(used[name], d.Key)
		}
		if len(seen) == 0 {
			t.Errorf("dataset %q has no app-schema relation in its FROM clause (%q) — either "+
				"it reads another schema, which this test should learn about, or the clause "+
				"is malformed", d.Key, d.From)
		}
	}

	names := make([]string, 0, len(used))
	for n := range used {
		names = append(names, n)
	}
	sort.Strings(names)

	missing := 0
	for _, name := range names {
		var reg *string
		// to_regclass returns NULL rather than erroring for an unknown name, which is
		// exactly the shape this test needs: one round trip, no exception handling, and
		// it resolves views as readily as tables.
		if err := db.PG.QueryRowContext(ctx,
			`SELECT to_regclass('app.' || $1)::text`, name).Scan(&reg); err != nil {
			t.Fatalf("to_regclass(%q): %v", name, err)
		}
		if reg == nil {
			missing++
			sort.Strings(used[name])
			t.Errorf("app.%s DOES NOT EXIST, and is read by: %s\n"+
				"    A dataset over a missing relation does not fail — the query helpers turn "+
				"42P01 into an empty result with a nil error, so it returns nothing and says "+
				"nothing. If the migration that creates it is not applied yet, apply it; if the "+
				"table was renamed, fix the FROM clause.",
				name, strings.Join(used[name], ", "))
		}
	}
	if missing == 0 {
		t.Logf("all %d app relations behind %d datasets exist", len(names), len(exportDatasets))
	}
}
