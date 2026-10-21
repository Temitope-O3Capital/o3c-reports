package handlers

/*
Building a tile straight from a data source.

A tile reads a saved report or a saved query and never carries its own SQL. That is the
whole reason the per-viewer access check means anything: when a dashboard is shared, each
tile is re-resolved against the person looking at it, and a tile that held a query string
would hand whoever opened the board the access of whoever built it.

So "let me chart a table" is not a licence to put SQL on a tile. It is a request for the
Report Builder's experience without the detour of naming and saving a report first, and
the honest way to grant it is to have the dashboard write the report for you: one
pivot_reports row flagged tile_only (migration 379), and a tile pointing at it the usual
way. The tile keeps its foreign key. The read path is untouched — dashTileData cannot
tell these tiles from any other, which is exactly the property worth having.

WHY ONE STATEMENT. The report and the tile are inserted by a single CTE, so either both
rows exist or neither does. core.DB exposes no transaction handle, and two sequential
INSERTs would leave a hidden report behind — invisible in every library listing and
owned by no tile — each time the second one failed.

WHAT IS CHECKED, AND IN WHICH ORDER. Dashboard ownership first (you cannot add a tile to
someone else's board), then the visual, then that the dataset exists, then that this
person's role reaches it. The dataset guard is the same reportDatasetAllowed the Report
Builder and every export path use; this endpoint adds no new way to reach data, it only
adds a new way to arrive at a report row.
*/

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// dashTileNameMaxRunes bounds the generated report's name. It is the tile's title too, so
// it is read in a grid cell, not a document: a name longer than this is a sentence.
const dashTileNameMaxRunes = 120

// dashTileFromDataset creates the report behind a new tile and the tile itself.
//
// POST /api/dashboards/{id}/tiles/from-dataset
func dashTileFromDataset(db *core.DB) http.HandlerFunc {
	type body struct {
		Name    string          `json:"name"`
		Dataset string          `json:"dataset"`
		Config  json.RawMessage `json:"config"`
		Viz     string          `json:"viz"`
		// How to draw it: which column is the category, which are the measures, stacked
		// or not. Stored on the tile, not the report — two tiles may draw one report
		// differently. Shape documented on the column (migration 381).
		VizConfig json.RawMessage `json:"viz_config"`
		GridX     int             `json:"grid_x"`
		GridY     int             `json:"grid_y"`
		GridW     int             `json:"grid_w"`
		GridH     int             `json:"grid_h"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		if u == nil {
			respondErr(w, 401, "Sign in to add a tile")
			return
		}
		id := chi.URLParam(r, "id")
		if !dashOwns(ctx, db, id, u.ID) {
			respondErr(w, 404, "Dashboard not found")
			return
		}

		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		b.Name = clampRunes(strings.TrimSpace(b.Name), dashTileNameMaxRunes)
		if b.Name == "" {
			respondErr(w, 400, "Give the tile a title")
			return
		}
		if !dashVizKinds[b.Viz] {
			respondErr(w, 422, dashVizProblem())
			return
		}
		if _, ok := exportDatasetByKey(b.Dataset); !ok {
			respondErr(w, 422, "Unknown data source")
			return
		}
		// The same guard the Report Builder applies. Without it this endpoint would be a
		// way to read a department's data by writing a report for yourself.
		if !reportDatasetAllowed(u, b.Dataset) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}

		cfg := "{}"
		if len(b.Config) > 0 {
			cfg = string(b.Config)
		}
		vizCfg := "{}"
		if len(b.VizConfig) > 0 {
			vizCfg = string(b.VizConfig)
		}
		if b.GridW == 0 {
			b.GridW = 6
		}
		if b.GridH == 0 {
			b.GridH = 4
		}

		// One statement: the report row and the tile that owns it, or nothing. The
		// description says where the row came from, because someone reading the table
		// directly has no other clue why a report they never built is sitting in it.
		rows, err := db.PGQuery(ctx, `
			WITH new_report AS (
				INSERT INTO app.pivot_reports
					(name, description, dataset, config, is_public, created_by, tile_only)
				VALUES ($1, 'Built on a dashboard tile.', $2, $3::jsonb, FALSE, $4, TRUE)
				RETURNING id
			)
			INSERT INTO app.dashboard_tiles
				(dashboard_id, title, viz, source_report_id,
				 grid_x, grid_y, grid_w, grid_h, config)
			SELECT $5, $1, $6, nr.id, $7, $8, $9, $10, $11::jsonb
			  FROM new_report nr
			RETURNING id, title, viz, source_report_id,
			          grid_x, grid_y, grid_w, grid_h, config`,
			b.Name, b.Dataset, cfg, u.ID,
			id, b.Viz, b.GridX, b.GridY, b.GridW, b.GridH, vizCfg)
		if err != nil {
			respondErrLog(w, 500, "Could not add the tile", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "Could not add the tile")
			return
		}
		touchDashboard(ctx, db, id)
		respond(w, rows[0], "pg")
	}
}

// dashTileConfigSave rewrites the report behind a dashboard-built tile.
//
// PUT /api/dashboards/tiles/{tid}/dataset
//
// Editing such a tile edits its report, so this writes pivot_reports rather than
// dashboard_tiles. It refuses a tile whose report is NOT tile_only: those point at
// reports someone built and named in the library, possibly shared with other people and
// used by other tiles, and a dashboard edit must never silently rewrite one of those.
func dashTileConfigSave(db *core.DB) http.HandlerFunc {
	type body struct {
		Name      string          `json:"name"`
		Config    json.RawMessage `json:"config"`
		Viz       string          `json:"viz"`
		VizConfig json.RawMessage `json:"viz_config"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		if u == nil {
			respondErr(w, 401, "Sign in to edit a tile")
			return
		}
		tid := chi.URLParam(r, "tid")

		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		b.Name = clampRunes(strings.TrimSpace(b.Name), dashTileNameMaxRunes)
		if b.Name == "" {
			respondErr(w, 400, "Give the tile a title")
			return
		}
		if b.Viz != "" && !dashVizKinds[b.Viz] {
			respondErr(w, 422, dashVizProblem())
			return
		}

		// Ownership of the BOARD is what grants the edit, scoped in the WHERE clause, and
		// tile_only is what makes the report safe to rewrite.
		own, err := db.PGQuery(ctx, `
			SELECT t.id, t.source_report_id, p.dataset, p.tile_only
			  FROM app.dashboard_tiles t
			  JOIN app.dashboards d ON d.id = t.dashboard_id
			  LEFT JOIN app.pivot_reports p ON p.id = t.source_report_id
			 WHERE t.id = $1 AND d.created_by = $2`, tid, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not read the tile", err)
			return
		}
		if len(own) == 0 {
			respondErr(w, 404, "Tile not found")
			return
		}
		row := own[0]
		if row["source_report_id"] == nil {
			respondErr(w, 422, "This tile reads a saved query, so there is nothing here to edit")
			return
		}
		if ok, _ := row["tile_only"].(bool); !ok {
			respondErr(w, 422,
				"This tile reads a saved report from the library. Edit it in the Report Builder, "+
					"so other tiles and schedules using it change with it.")
			return
		}
		// Re-check the dataset against the person editing: a role can lose a module after
		// the tile was built, and an edit is a fresh read of that data.
		if !reportDatasetAllowed(u, str(row["dataset"])) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}

		cfg := "{}"
		if len(b.Config) > 0 {
			cfg = string(b.Config)
		}
		if _, err := db.PGExec(ctx, `
			UPDATE app.pivot_reports
			   SET name = $1, config = $2::jsonb, updated_at = now()
			 WHERE id = $3 AND tile_only`,
			b.Name, cfg, row["source_report_id"]); err != nil {
			respondErrLog(w, 500, "Could not save the tile", err)
			return
		}
		// The tile's own row carries the title, the kind, and how to draw it. Built up
		// rather than written as one statement because viz and viz_config are each
		// optional: a caller changing only the title must not blank the composition.
		set := []string{"title = $1", "updated_at = now()"}
		args := []any{b.Name, tid}
		if b.Viz != "" {
			args = append(args, b.Viz)
			set = append(set, fmt.Sprintf("viz = $%d", len(args)))
		}
		if len(b.VizConfig) > 0 {
			args = append(args, string(b.VizConfig))
			set = append(set, fmt.Sprintf("config = $%d::jsonb", len(args)))
		}
		if _, err := db.PGExec(ctx,
			`UPDATE app.dashboard_tiles SET `+strings.Join(set, ", ")+` WHERE id = $2`,
			args...); err != nil {
			respondErrLog(w, 500, "Could not save the tile", err)
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}
