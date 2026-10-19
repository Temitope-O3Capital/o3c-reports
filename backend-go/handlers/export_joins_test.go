package handlers

import (
	"context"
	"database/sql"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// A curated relationship is only as good as its guarantees, and these are the guarantees.
// The expensive one — that an edge cannot change the row count — needs the database and
// lives in TestEveryJoinEdgeIsToOneLive at the bottom.

func TestEveryJoinEdgeNamesRealDatasets(t *testing.T) {
	for _, e := range exportJoinEdges {
		if _, ok := exportDatasetByKey(e.From); !ok {
			t.Errorf("edge %q hangs off dataset %q, which is not in the registry", e.Key, e.From)
		}
		// Requires must be a REAL dataset key, because reportDatasetAllowed falls through
		// to "BI sees everything" for an unmapped key. A typo here would therefore not
		// fail loudly — it would quietly make the edge BI-only, or worse, open.
		if _, ok := exportDatasetByKey(e.Requires); !ok {
			t.Errorf("edge %q requires dataset %q, which is not in the registry: access would "+
				"not be checked against anything real", e.Key, e.Requires)
		}
		if _, mapped := reportDatasetPages[e.Requires]; !mapped && !reportBIOnlyDatasets[e.Requires] {
			t.Errorf("edge %q requires %q, which appears in neither reportDatasetPages nor "+
				"reportBIOnlyDatasets — so no department can be said to own it", e.Key, e.Requires)
		}
		if strings.TrimSpace(e.Label) == "" || strings.TrimSpace(e.Note) == "" {
			t.Errorf("edge %q needs a Label and a Note: the Note is where a lateral says which "+
				"row it picked, and that is the part a reader cannot infer", e.Key)
		}
		if len(e.Cols) == 0 {
			t.Errorf("edge %q contributes no columns, so joining it can only cost time", e.Key)
		}
	}
}

// An edge key plus a column key becomes a SQL identifier, because exportCol.sql() emits
// "<expr> AS <key>". This is the test that catches a separator which looked fine in Go
// and is a syntax error in Postgres — a dot, a dash, a space.
func TestJoinedColumnKeysAreValidSQLIdentifiers(t *testing.T) {
	ident := regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	for _, e := range exportJoinEdges {
		seen := map[string]bool{}
		for _, c := range e.Cols {
			key := e.Key + joinKeySep + c.Key
			if !ident.MatchString(key) {
				t.Errorf("joined column key %q is not a bare lowercase SQL identifier; it is "+
					"emitted as \"expr AS %s\" and would not compile", key, key)
			}
			// Postgres truncates an identifier at 63 bytes, which would silently collide
			// two long joined columns into one result key.
			if len(key) > 63 {
				t.Errorf("joined column key %q is %d bytes; Postgres truncates at 63 and two "+
					"such columns would collide", key, len(key))
			}
			if seen[c.Key] {
				t.Errorf("edge %q declares column %q twice", e.Key, c.Key)
			}
			seen[c.Key] = true
			if strings.TrimSpace(c.Expr) == "" {
				t.Errorf("edge %q column %q has no Expr: it would fall back to selecting a bare "+
					"column name that does not exist on the base relation", e.Key, c.Key)
			}
		}
	}
}

// A joined column must not collide with a base column, or selecting one would silently
// return the other.
func TestJoinedColumnsDoNotShadowBaseColumns(t *testing.T) {
	for _, e := range exportJoinEdges {
		d, ok := exportDatasetByKey(e.From)
		if !ok {
			continue
		}
		for _, c := range e.Cols {
			key := e.Key + joinKeySep + c.Key
			if _, clash := d.colByKey(key); clash {
				t.Errorf("edge %q would contribute %q, which dataset %q already declares",
					e.Key, key, e.From)
			}
		}
	}
}

// LEFT, always. An INNER join would drop every base row with no match — turning "every
// repayment, with its loan where we have one" into "only repayments whose loan we hold",
// which is a different report that looks like the one asked for.
func TestEveryJoinEdgeIsALeftJoin(t *testing.T) {
	for _, e := range exportJoinEdges {
		up := strings.ToUpper(e.Join)
		if !strings.HasPrefix(strings.TrimSpace(up), "LEFT JOIN") {
			t.Errorf("edge %q does not start with LEFT JOIN: %q", e.Key, e.Join)
		}
		if strings.Contains(up, "INNER JOIN") || strings.Contains(up, "RIGHT JOIN") ||
			strings.Contains(up, "CROSS JOIN") {
			t.Errorf("edge %q uses a join kind that can add or drop base rows: %q", e.Key, e.Join)
		}
		// A lateral is how a non-unique key is made to-one. If one is used it must carry
		// the LIMIT that makes that true, or it fans out exactly like a plain join.
		if strings.Contains(up, "LATERAL") && !strings.Contains(up, "LIMIT 1") {
			t.Errorf("edge %q joins laterally without LIMIT 1, so it does not pick one row: %q",
				e.Key, e.Join)
		}
		if strings.Contains(up, "LATERAL") && !strings.Contains(up, "ORDER BY") {
			t.Errorf("edge %q takes one row from a lateral without ORDER BY, so WHICH row is "+
				"whatever the planner returns first and the report is not reproducible: %q",
				e.Key, e.Join)
		}
	}
}

// THE REGISTRY MUST SURVIVE BEING USED. d.Cols shares its backing array with the package
// level literal, so an append with spare capacity writes the joined columns into the
// registry — and every later request on that dataset would carry someone else's join.
func TestRelationsDoNotMutateTheRegistry(t *testing.T) {
	d, ok := exportDatasetByKey("loan_repayments")
	if !ok {
		t.Skip("loan_repayments not in registry")
	}
	before := len(d.Cols)
	u := &core.Claims{ID: 1, Role: "admin", Pages: []string{"reports"}}

	if _, err := datasetWithRelations(d, []string{"loan"}, u); err != nil {
		t.Fatalf("expanding: %v", err)
	}
	again, _ := exportDatasetByKey("loan_repayments")
	if len(again.Cols) != before {
		t.Fatalf("the registry grew from %d to %d columns: the expansion wrote into the "+
			"registry's own slice", before, len(again.Cols))
	}
	// And the expansion must actually have added them to its own copy.
	exp, err := datasetWithRelations(d, []string{"loan"}, u)
	if err != nil {
		t.Fatalf("expanding: %v", err)
	}
	if len(exp.Cols) <= before {
		t.Fatalf("expansion added no columns (%d, base %d)", len(exp.Cols), before)
	}
	if !strings.Contains(exp.From, "LEFT JOIN") {
		t.Error("expansion added columns but no join clause")
	}
}

func TestRelationsRefuseWhatTheCallerCannotSee(t *testing.T) {
	d, ok := exportDatasetByKey("loan_repayments")
	if !ok {
		t.Skip("loan_repayments not in registry")
	}
	// Holds the base dataset through "collections", but NOT loan_book.
	//
	// A CUSTOM role name on purpose: HasPage unions core.RolePages[role] with the
	// explicit Pages, so naming a real role here would quietly grant whatever that role
	// carries and the test would be asserting nothing. This is the same reason
	// report_access_test.go builds its limited user from an invented role.
	limited := &core.Claims{ID: 9, Role: "collections_only_custom_role",
		Pages: []string{"report_builder", "collections"}}
	if !reportDatasetAllowed(limited, "loan_repayments") {
		t.Fatal("precondition: this user should reach loan_repayments via collections")
	}
	if reportDatasetAllowed(limited, "loan_book") {
		t.Fatal("precondition: this user should NOT reach loan_book")
	}
	if _, err := datasetWithRelations(d, []string{"loan"}, limited); err == nil {
		t.Error("a relationship into loan_book was allowed for someone who cannot open " +
			"loan_book: a curated edge must never be a way around the dataset guard")
	}
	// And it is not offered in the first place.
	for _, e := range joinEdgesFor("loan_repayments", limited) {
		if e.Key == "loan" {
			t.Error("the loan relationship was offered to someone who cannot open loan_book")
		}
	}
}

// Refused, not ignored. A dropped relationship returns a report missing the columns
// somebody asked for, which is noticed only after a decision is taken on it.
func TestAnUnknownRelationIsAnError(t *testing.T) {
	d, _ := exportDatasetByKey("loan_repayments")
	u := &core.Claims{ID: 1, Role: "admin", Pages: []string{"reports"}}
	if _, err := datasetWithRelations(d, []string{"not_a_relationship"}, u); err == nil {
		t.Error("an unknown relationship key was accepted silently")
	}
	// An edge belonging to a DIFFERENT dataset must not resolve either.
	if _, err := datasetWithRelations(d, []string{"assignment"}, u); err == nil {
		t.Error("an edge declared on another dataset resolved against this one")
	}
}

// ── The one that needs the database ──────────────────────────────────────────

// EVERY EDGE IS TO-ONE, PROVED RATHER THAN ASSERTED.
//
// This is the whole safety argument of the registry. A to-one join cannot change the
// number of rows, so it cannot inflate a SUM — and the moment an edge fans out, every
// money column in every report using it is overstated by however many extra rows the
// join produced. That is not a visible failure: the report renders, the totals look
// plausible, and they are wrong.
//
// So: run the base dataset's FROM, run it again with the edge, compare the counts. The
// numbers that justified each edge (cbs_loans unique 59/59, four assignments for one
// customer at worst) are measurements of today's data, and today's data changes.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestEveryJoinEdgeIsToOneLive -v
func TestEveryJoinEdgeIsToOneLive(t *testing.T) {
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	ctx := context.Background()

	count := func(from, where string) (int64, error) {
		q := "SELECT COUNT(*) FROM " + from
		if where != "" {
			q += " WHERE " + where
		}
		var n int64
		return n, pg.QueryRowContext(ctx, q).Scan(&n)
	}

	for _, e := range exportJoinEdges {
		d, ok := exportDatasetByKey(e.From)
		if !ok {
			t.Errorf("edge %q: dataset %q missing", e.Key, e.From)
			continue
		}
		base, err := count(d.From, d.Where)
		if err != nil {
			t.Errorf("edge %q: counting base dataset %q: %v", e.Key, e.From, err)
			continue
		}
		joined, err := count(d.From+"\n"+e.Join, d.Where)
		if err != nil {
			t.Errorf("edge %q: counting with the join: %v\nJOIN: %s", e.Key, err, e.Join)
			continue
		}
		switch {
		case joined > base:
			t.Errorf("edge %q FANS OUT: %d rows become %d. Every sum in every report using "+
				"this relationship is overstated. Make it a LEFT JOIN LATERAL with an "+
				"ORDER BY ... LIMIT 1 that says which row it means.", e.Key, base, joined)
		case joined < base:
			t.Errorf("edge %q DROPS %d of %d rows, so it is not behaving as a LEFT join",
				e.Key, base-joined, base)
		default:
			t.Logf("edge %q: to-one confirmed at %d rows", e.Key, base)
		}

		// And the columns must execute. A to-one join over an expression that does not
		// compile is still a broken report.
		sel := make([]string, 0, len(e.Cols))
		for _, c := range e.Cols {
			sel = append(sel, c.Expr)
		}
		probe := "SELECT " + strings.Join(sel, ", ") + " FROM " + d.From + "\n" + e.Join
		if d.Where != "" {
			probe += " WHERE " + d.Where
		}
		probe += " LIMIT 5"
		rows, err := pg.QueryContext(ctx, probe)
		if err != nil {
			t.Errorf("edge %q: its columns do not run: %v", e.Key, err)
			continue
		}
		rows.Close()
	}
}
