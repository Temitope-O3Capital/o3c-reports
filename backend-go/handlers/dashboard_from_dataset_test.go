package handlers

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
)

// The guards that make a dashboard-built tile safe, asserted statically so they cannot be
// loosened by accident.
func TestTileFromDatasetKeepsTheTileInvariants(t *testing.T) {
	// A tile built here must still choose from the SAME visuals the schema allows. If a
	// new one is added to dashVizKinds without a renderer, a tile can be created that the
	// dashboard cannot draw.
	//
	// THIS LIST IS THE CONTRACT between three places that must agree: this map, the CHECK
	// constraint from migration 381, and the renderer's branches in
	// builder/TileVisual.tsx (offered to the user by VIZ_KINDS in builder/tileViz.ts).
	// A kind in one and not the others is a tile that stores fine and draws nothing.
	wantKinds := []string{
		"kpi", "bar", "line", "area", "donut", "table",
		"barh", "combo", "funnel",
	}
	for _, v := range wantKinds {
		if !dashVizKinds[v] {
			t.Errorf("visual %q is offered by the tile builder but not accepted by the handler", v)
		}
	}
	if len(dashVizKinds) != len(wantKinds) {
		t.Errorf("dashVizKinds has %d entries; the tile builder offers %d and they must match",
			len(dashVizKinds), len(wantKinds))
	}

	// The generated name is also the tile's caption, read in a grid cell.
	if dashTileNameMaxRunes < 40 || dashTileNameMaxRunes > 200 {
		t.Errorf("dashTileNameMaxRunes = %d, which is not a caption length", dashTileNameMaxRunes)
	}
}

// Every list people browse for reports must exclude the ones a dashboard wrote for a
// tile. Missing one of these is how twelve charts turn into twelve library entries
// nobody created, so the filter is asserted on the source rather than trusted.
func TestReportListsHideTileOwnedReports(t *testing.T) {
	for _, f := range []struct{ file, fn string }{
		{"reports_saved.go", "savedListReports"},
		{"reports_saved.go", "savedMyDashboard"},
		{"dashboards.go", "dashSources"},
	} {
		src, err := os.ReadFile(f.file)
		if err != nil {
			t.Fatalf("read %s: %v", f.file, err)
		}
		body := funcBodyFor(string(src), f.fn)
		if body == "" {
			t.Errorf("could not find %s in %s — if it was renamed, re-point this test", f.fn, f.file)
			continue
		}
		if !strings.Contains(body, "tile_only") {
			t.Errorf("%s does not filter on tile_only: reports a dashboard wrote for a tile "+
				"would be offered as though somebody had built them", f.fn)
		}
	}
}

// funcBodyFor returns the source between "func <name>(" and the next top-level "\nfunc ",
// which is enough to assert what a single handler's SQL mentions.
func funcBodyFor(src, name string) string {
	i := strings.Index(src, "func "+name+"(")
	if i < 0 {
		return ""
	}
	rest := src[i:]
	if j := strings.Index(rest[1:], "\nfunc "); j >= 0 {
		return rest[:j+1]
	}
	return rest
}

// What the Go compiler cannot check: that the CTE actually runs, that the library filter
// really hides the row, and that deleting the report really takes the tile with it. All
// three inside one transaction that is rolled back, so the live database is unchanged.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestTileFromDatasetLive -v
func TestTileFromDatasetLive(t *testing.T) {
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

	tx, err := pg.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck // the rollback IS the cleanup

	// A dashboard and a dataset to hang the tile on. Created inside the transaction so
	// the test does not depend on what happens to be in the database.
	var boardID int64
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO app.dashboards (name, description, is_shared, created_by)
		VALUES ('tile-builder test board', '', FALSE, 1) RETURNING id`).Scan(&boardID); err != nil {
		t.Fatalf("seed dashboard: %v", err)
	}

	const dataset = "helpdesk_calls"
	if _, ok := exportDatasetByKey(dataset); !ok {
		t.Fatalf("dataset %q no longer exists; pick another for this test", dataset)
	}

	// Exactly the statement dashTileFromDataset runs.
	var tileID, reportID int64
	if err := tx.QueryRowContext(ctx, `
		WITH new_report AS (
			INSERT INTO app.pivot_reports
				(name, description, dataset, config, is_public, created_by, tile_only)
			VALUES ($1, 'Built on a dashboard tile.', $2, $3::jsonb, FALSE, $4, TRUE)
			RETURNING id
		)
		INSERT INTO app.dashboard_tiles
			(dashboard_id, title, viz, source_report_id,
			 grid_x, grid_y, grid_w, grid_h, config)
		SELECT $5, $1, $6, nr.id, $7, $8, $9, $10, '{}'::jsonb
		  FROM new_report nr
		RETURNING id, source_report_id`,
		"Calls By Agent", dataset, `{"view":"table","columns":[]}`, 1,
		boardID, "bar", 0, 0, 6, 4).Scan(&tileID, &reportID); err != nil {
		t.Fatalf("the tile-from-dataset statement failed: %v", err)
	}
	if tileID == 0 || reportID == 0 {
		t.Fatalf("tile %d / report %d: both rows must exist", tileID, reportID)
	}

	// The report is flagged, so nothing browses to it.
	var flagged bool
	if err := tx.QueryRowContext(ctx,
		`SELECT tile_only FROM app.pivot_reports WHERE id = $1`, reportID).Scan(&flagged); err != nil {
		t.Fatalf("read flag: %v", err)
	}
	if !flagged {
		t.Error("the report behind a dashboard-built tile is not flagged tile_only, so it " +
			"will appear in the saved-reports library")
	}

	// The library query — the real one from savedListReports — must not return it.
	var inLibrary int64
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM app.pivot_reports p
		 WHERE (p.is_public = TRUE OR p.created_by = $1)
		   AND NOT p.tile_only
		   AND p.id = $2`, 1, reportID).Scan(&inLibrary); err != nil {
		t.Fatalf("library query: %v", err)
	}
	if inLibrary != 0 {
		t.Errorf("the tile's report is visible in the saved-reports library (%d rows)", inLibrary)
	}

	// Deleting the owned report takes its tile with it. This is the cascade the tile
	// cleanup in dashTileDelete relies on; without it a removed tile would leave a report
	// nobody can see or reach.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM app.pivot_reports WHERE id = $1 AND tile_only`, reportID); err != nil {
		t.Fatalf("delete owned report: %v", err)
	}
	var tilesLeft int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM app.dashboard_tiles WHERE id = $1`, tileID).Scan(&tilesLeft); err != nil {
		t.Fatalf("count tiles: %v", err)
	}
	if tilesLeft != 0 {
		t.Error("deleting a tile's own report left the tile behind: the FK has lost ON DELETE CASCADE")
	}

	// And the guard that protects a library report: the same delete must NOT touch one.
	var libReportID int64
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO app.pivot_reports (name, description, dataset, config, is_public, created_by)
		VALUES ('a report somebody built', '', $1, '{}'::jsonb, FALSE, 1)
		RETURNING id`, dataset).Scan(&libReportID); err != nil {
		t.Fatalf("seed library report: %v", err)
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM app.pivot_reports WHERE id = $1 AND tile_only`, libReportID)
	if err != nil {
		t.Fatalf("guarded delete: %v", err)
	}
	if n, _ := res.RowsAffected(); n != 0 {
		t.Errorf("the tile cleanup deleted a report somebody built (%d rows); the "+
			"\"AND tile_only\" guard is not holding", n)
	}
}
