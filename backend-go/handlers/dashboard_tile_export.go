package handlers

/*
Downloading one tile.

WHY THIS IS NOT DONE IN THE BROWSER. The page already holds the tile's rows, so writing a
CSV from them client-side would have been a few lines and no endpoint. It would also have
been wrong: a tile is capped at dashTileRowCap (500) because nobody reads a 500-slice
donut, so a download built from what is on screen would silently stop at 500 rows. A
supervisor's export coming back short is exactly the failure that had the Report Builder's
own 5,000-record cap removed in September. An export has to run the report again, with the
report's own cap.

So this endpoint re-runs the tile's source at the DATA SOURCE's cap (d.maxRows(), 100k on
most and 250k on one) and streams it through the same writer every other export uses —
same columns, same names, same order, same number formatting. The file a tile produces is
the file the report produces.

WHAT IT DOES NOT RELAX. Every guard dashTileData applies, in the same order: the tile must
exist, its source must exist, dashSourceReadable must admit THIS viewer, the dataset must
admit them, and any related dataset is re-checked too. A download is a read, so there is
nothing here a reader could not already see on screen — only more rows of it.

THE BOARD'S FILTERS TRAVEL WITH IT. The same f_<key> parameters the tile's data request
carries are read here, so exporting a tile from a board filtered to Lagos gives the Lagos
figures. A file whose contents disagree with the screen it came from is worse than no file.
*/

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// dashExportSQLRowCap bounds the saved-query path. An export dataset carries its own cap
// and that is used instead; a saved SQL query has no declared size, so it needs a number
// here. 20,000 is well past "a tile" and well short of a memory problem, since the SQL
// path materialises its rows rather than streaming them.
const dashExportSQLRowCap = 20000

// dashTileExport writes one tile's full result as a file.
//
// GET /api/dashboards/tiles/{tid}/export?format=csv|xlsx|json
func dashTileExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		tid := chi.URLParam(r, "tid")

		format, okFormat := parseExportFormat(r.URL.Query().Get("format"))
		if !okFormat {
			respondErr(w, 422, "Unsupported format (use xlsx, csv or json)")
			return
		}

		tile, kind, src, err := dashLoadTileSource(ctx, db, tid)
		if err != nil {
			respondErrLog(w, 500, "Could not load the tile", err)
			return
		}
		if tile == nil {
			respondErr(w, 404, "Tile not found")
			return
		}
		if src == nil {
			respondErr(w, 404, "That tile's source no longer exists")
			return
		}
		// THE CHECK THAT MATTERS, and it is the same one the data endpoint makes: the
		// viewer against the source, not the dashboard.
		if ok, why := dashSourceReadable(u, kind, src); !ok {
			respondErr(w, 403, why)
			return
		}

		// The tile's own title names the file, because that is what the person pressing
		// the button is looking at. The source's name is the fallback.
		name := str(tile["title"])
		if name == "" {
			name = str(src["name"])
		}
		if name == "" {
			name = "Tile"
		}

		if kind == "sql" {
			res, runErr := biSQLExecute(ctx, db, str(src["sql_text"]), dashExportSQLRowCap)
			if runErr != nil {
				respondErr(w, 422, biSQLFriendlyError(runErr).Error())
				return
			}
			// The same result check the screen makes. A saved query that was safe when it
			// was written can start returning a credential-shaped column after a schema
			// change, and a file leaves the building in a way a screen does not.
			if bad := biSQLCheckResult(res.Columns, res.Rows); bad != nil {
				respondErr(w, 403, bad.Error())
				return
			}
			cols := make([]exportCol, 0, len(res.Columns))
			for _, c := range res.Columns {
				// A saved query declares no types, so every column is written as text.
				// Guessing a type here would risk a reference number being reformatted
				// as one. The header is the name the query itself gave the column, which
				// is what the console shows on screen — renaming it in the file would
				// make the two disagree.
				cols = append(cols, exportCol{Key: c, Label: c, Type: colText})
			}
			if res.Truncated {
				w.Header().Set("X-Export-Truncated", "true")
			}
			logReportExport(ctx, db, r, name, "dashboard_tile_sql", format, len(res.Rows))
			if err := writeExport(w, format, exportFilename(name, format), cols, res.Rows); err != nil {
				respondErrLog(w, 500, "Could not write the file", err)
			}
			return
		}

		// A saved pivot report. Same expansion and same guards as runTileReport — this
		// cannot call it, because that function deliberately returns chart-shaped rows
		// capped for a tile, and the whole point here is the uncapped file shape.
		d, okDataset := exportDatasetByKey(str(src["dataset"]))
		if !okDataset {
			respondErr(w, 422, "That report reads a data source that no longer exists")
			return
		}
		if !reportDatasetAllowed(u, d.Key) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}
		cfg := parseSavedConfig(src["config"])
		d, relErr := datasetWithRelations(d, cfg.Relations, u)
		if relErr != nil {
			respondErr(w, 403, relErr.Error())
			return
		}
		// The board's selection, exactly as the tile's data request applies it, so the
		// file matches the screen it was downloaded from.
		cfg, _, _ = dashApplySelection(d, cfg, dashReadSelection(r))

		rep, err := renderReport(ctx, db, d, cfg, time.Now(), d.maxRows())
		if err != nil {
			respondReportErr(w, err)
			return
		}
		if rep.Truncated {
			w.Header().Set("X-Export-Truncated", "true")
		}
		logReportExport(ctx, db, r, name, d.Key, format, rep.RecordCount())
		if err := writeExport(w, format, exportFilename(name, format), rep.Cols, rep.Rows); err != nil {
			respondErrLog(w, 500, "Could not write the file", err)
		}
	}
}
