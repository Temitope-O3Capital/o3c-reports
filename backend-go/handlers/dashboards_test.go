package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// A DASHBOARD MUST NOT BE A WAY ROUND THE PERMISSIONS.
//
// This is the test the whole feature stands on. A tile points at a saved pivot report or
// a saved SQL query, and dashSourceReadable decides whether THIS viewer may see THAT
// source — called when the tile is added, when the dashboard is opened, and again every
// time the tile's data is fetched.
//
// The escalation it prevents is concrete: the SQL console is gated on the "reports" page,
// which is BI and admin. Department heads hold "report_builder" instead, and the
// dashboards module admits both (RequirePages is any-of). So without this check, a BI
// analyst could put a saved query on a dashboard, tick "shared", and hand every
// department head a window onto the whole warehouse — including the datasets their own
// Report Builder is scoped away from.
//
// The second case is quieter and just as real: a pivot report carries a dataset, and
// reportDatasetAllowed() is what keeps Collections out of Finance's data. A tile that
// skipped it would let a dashboard launder a dataset across departments.
func TestADashboardTileCannotEscalate(t *testing.T) {
	// A department head: Report Builder, their own module, no "reports".
	head := &core.Claims{ID: 10, Role: "collections_head",
		Pages: []string{"report_builder", "collections"}}
	// BI: the "reports" page, which is what the SQL console requires.
	analyst := &core.Claims{ID: 20, Role: "bi_analyst", Pages: []string{"reports", "report_builder"}}

	t.Run("a saved SQL query is refused to a department head", func(t *testing.T) {
		src := core.Row{"is_shared": true, "created_by": int64(20)}
		ok, why := dashSourceReadable(head, "sql", src)
		if ok {
			t.Fatal("a report_builder holder must NOT read a saved SQL tile — that is the " +
				"escalation this guard exists for: the console itself requires \"reports\"")
		}
		if !strings.Contains(strings.ToLower(why), "bi") {
			t.Errorf("the refusal should say why, and name BI; got %q", why)
		}
	})

	t.Run("a shared saved SQL query is allowed to BI", func(t *testing.T) {
		src := core.Row{"is_shared": true, "created_by": int64(99)}
		if ok, why := dashSourceReadable(analyst, "sql", src); !ok {
			t.Errorf("BI must be able to read a SHARED query it did not write: %s", why)
		}
	})

	t.Run("a private saved query is refused even to BI", func(t *testing.T) {
		src := core.Row{"is_shared": false, "created_by": int64(99)}
		if ok, _ := dashSourceReadable(analyst, "sql", src); ok {
			t.Error("a private query belongs to its author; sharing a dashboard does not share it")
		}
	})

	t.Run("my own private query is mine to put on a dashboard", func(t *testing.T) {
		src := core.Row{"is_shared": false, "created_by": int64(20)}
		if ok, why := dashSourceReadable(analyst, "sql", src); !ok {
			t.Errorf("an author must be able to tile their own query: %s", why)
		}
	})

	t.Run("a public report in my own department is readable", func(t *testing.T) {
		src := core.Row{"is_public": true, "created_by": int64(99), "dataset": "collections_payments"}
		if ok, why := dashSourceReadable(head, "report", src); !ok {
			t.Errorf("collections_head must read a public collections report: %s", why)
		}
	})

	t.Run("a public report in another department is refused", func(t *testing.T) {
		// Public is not the same as unscoped: reportDatasetAllowed still applies, which
		// is what stops a dashboard laundering a dataset across departments.
		//
		// The dataset here is "sars" — compliance's suspicious-activity reports, which
		// need the sars or compliance_all page. The first draft of this test used
		// loan_book and FAILED, correctly: collections_head holds credit_portfolio and
		// loans, so it genuinely may read the loan book. A collections head works the
		// loan book; they have no business in the SAR register. The test was wrong, not
		// the guard, and the fix was to pick a dataset that is actually out of reach
		// rather than to loosen the assertion.
		src := core.Row{"is_public": true, "created_by": int64(99), "dataset": "sars"}
		ok, why := dashSourceReadable(head, "report", src)
		if ok {
			t.Fatal("a public report over another department's dataset must still be refused")
		}
		if !strings.Contains(why, "sars") {
			t.Errorf("the refusal should name the dataset so the reader knows what is missing; got %q", why)
		}
	})

	t.Run("someone else's private report is refused", func(t *testing.T) {
		src := core.Row{"is_public": false, "created_by": int64(99), "dataset": "collections_payments"}
		if ok, _ := dashSourceReadable(head, "report", src); ok {
			t.Error("a private report belongs to its author")
		}
	})

	t.Run("nil claims and a missing source are refused, not defaulted", func(t *testing.T) {
		if ok, _ := dashSourceReadable(nil, "report", core.Row{"is_public": true}); ok {
			t.Error("no claims must mean no access — a guard that fails open is not a guard")
		}
		if ok, _ := dashSourceReadable(analyst, "sql", nil); ok {
			t.Error("a tile whose source has vanished must not be readable")
		}
	})

	t.Run("an unknown source kind is refused", func(t *testing.T) {
		// If a third source type is ever added, the default must be "no". A switch that
		// fell through to true would silently admit it.
		if ok, _ := dashSourceReadable(analyst, "something_new", core.Row{}); ok {
			t.Error("an unrecognised source kind must be refused by default")
		}
	})
}

// Management holds no "reports" page in RolePages — it passes RequirePages by being
// management — so the SQL branch has to admit it explicitly or the MD would be refused a
// tile on their own dashboard. This pins that, because it is the kind of special case
// that gets dropped in a refactor and then looks like a permissions bug.
func TestManagementReadsASQLTile(t *testing.T) {
	md := &core.Claims{ID: 1, Role: "md"}
	src := core.Row{"is_shared": true, "created_by": int64(20)}
	if ok, why := dashSourceReadable(md, "sql", src); !ok {
		t.Errorf("management must be able to read a shared query tile: %s", why)
	}
}

// Every viz the API accepts must be one the database accepts, and the reverse. Two lists
// of the same thing in two languages is how a tile gets saved that cannot be read back —
// the handler would 422 on a value the CHECK allows, or the CHECK would reject a value
// the handler waved through, surfacing as a 500 carrying a constraint name.
func TestTheVizListMatchesTheDatabaseConstraint(t *testing.T) {
	// READ THE CONSTRAINT, DO NOT RESTATE IT. This test used to hold its own copy of
	// migration 358's six kinds, which meant widening the CHECK (migration 381 added
	// barh, combo and funnel) made the test fail for being out of date rather than
	// because anything was wrong — a third list of the same thing, which is the exact
	// failure the test exists to prevent. It now parses the live migration directory, so
	// the next person to add a kind has one place to change.
	inMigration, from := vizKindsFromMigrations(t)
	if len(inMigration) == 0 {
		t.Fatal("no migration defines dashboard_tiles_viz_check; this test cannot verify anything")
	}
	for v := range dashVizKinds {
		if !inMigration[v] {
			t.Errorf("the handler accepts viz %q, which the CHECK in %s would reject", v, from)
		}
	}
	for v := range inMigration {
		if !dashVizKinds[v] {
			t.Errorf("%s allows viz %q, which the handler refuses", from, v)
		}
	}
}

// vizKindsFromMigrations returns the kinds admitted by the newest migration that defines
// dashboard_tiles_viz_check, and that file's name. Parsing the directory rather than the
// database keeps the test hermetic — it fails on a migration written but not yet applied,
// which is the state a developer is actually in.
func vizKindsFromMigrations(t *testing.T) (map[string]bool, string) {
	t.Helper()
	// Only promoted migrations count: a .sql.draft is invisible to the migrator, so a
	// kind that exists only in a draft must NOT be accepted by the handler yet.
	files, err := filepath.Glob(filepath.Join("..", "migrations", "*.sql"))
	if err != nil {
		t.Fatalf("glob migrations: %v", err)
	}
	sort.Strings(files) // numeric prefixes are zero-padded to the same width
	var (
		kinds map[string]bool
		from  string
	)
	quoted := regexp.MustCompile(`'([a-z_]+)'`)
	for _, f := range files {
		body, readErr := os.ReadFile(f)
		if readErr != nil {
			continue
		}
		s := string(body)
		// The last ADD CONSTRAINT in the file wins, so a migration that drops and
		// re-adds is read as its final state.
		i := strings.LastIndex(s, "dashboard_tiles_viz_check")
		if i < 0 {
			continue
		}
		rest := s[i:]
		open := strings.Index(rest, "ARRAY[")
		if open < 0 {
			continue
		}
		end := strings.Index(rest[open:], "]")
		if end < 0 {
			continue
		}
		found := map[string]bool{}
		for _, m := range quoted.FindAllStringSubmatch(rest[open:open+end], -1) {
			found[m[1]] = true
		}
		if len(found) > 0 {
			kinds, from = found, filepath.Base(f)
		}
	}
	return kinds, from
}
