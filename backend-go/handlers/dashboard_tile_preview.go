package handlers

/*
Running a tile's report, and previewing one that does not exist yet.

WHY THESE SHARE ONE FUNCTION. The tile builder shows a live preview of the visual being
composed, and it also has to populate the field wells — "which column is the category,
which are the measures" — from the report's real output columns. If the preview ran the
report by a different path from the dashboard, the builder would offer columns the tile
would not produce, and a chart that looked right while building would draw blank once
saved. So `runTileReport` is the single path: `dashTileData` calls it for a saved tile,
`dashTilePreview` calls it for an unsaved config, and neither can drift from the other.

WHAT THE PREVIEW DOES NOT RELAX. It is a report run, so it carries the same guards: the
dataset must exist, `reportDatasetAllowed` must admit this viewer, and any related
dataset is re-checked against them by `datasetWithRelations`. It takes a config in the
request body rather than an id precisely because nothing is saved yet — which means it
never widens access, since the dataset guard does not care where the config came from.
*/

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/o3c/workspace/core"
)

// dashPreviewRowCap bounds a preview. The dashboard caps a tile at dashTileRowCap (500);
// a preview is smaller still because nobody composes a visual by reading 500 rows, and
// the builder refetches on every shape change.
const dashPreviewRowCap = 200

// runTileReport runs a saved report config and returns the chart-shaped payload: column
// keys in order, then rows. The int is the HTTP status to use if error is non-nil, so
// callers need no knowledge of which failures are the user's fault.
//
// Long format for a summary — one row per group, dimensions then measures — because that
// is what a chart wants. The matrix form is for a page of numbers, not a visual.
func runTileReport(
	ctx context.Context, db *core.DB, u *core.Claims, dataset, rawConfig string,
	sel dashSlicerSelection,
) (map[string]any, int, error) {
	d, ok := exportDatasetByKey(dataset)
	if !ok {
		return nil, 422, errors.New("That report reads a data source that no longer exists")
	}
	// The guard that makes this safe to call with a caller-supplied config.
	if !reportDatasetAllowed(u, dataset) {
		return nil, 403, errors.New(reportDatasetDenied)
	}

	var cfg savedPivotConfig
	if rawConfig != "" {
		if err := json.Unmarshal([]byte(rawConfig), &cfg); err != nil {
			return nil, 422, errors.New("That report's definition could not be read")
		}
	}
	// A tile over a report that reaches related data needs the same expansion, and the
	// same access check: the relationship is re-checked against THIS VIEWER, so a shared
	// dashboard refuses a tile whose related dataset they cannot open rather than
	// rendering it. That is the per-tile rule dashSourceReadable applies to the base
	// dataset, extended to the edge.
	d, relErr := datasetWithRelations(d, cfg.Relations, u)
	if relErr != nil {
		return nil, 403, relErr
	}
	// The board's slicers fold in AFTER the relations are expanded, so a slicer can use a
	// filter that only exists on a related dataset. Applied and ignored keys travel back
	// with the rows: a tile that could not answer the board's question must say so rather
	// than look like it did.
	cfg, applied, ignored := dashApplySelection(d, cfg, sel)
	now := time.Now()

	if cfg.View == "table" {
		spec := cfg.toTableSpec(now)
		spec.Limit = dashTileRowCap
		res, runErr := runTable(ctx, db, d, spec, false)
		if runErr != nil {
			if ue, isUser := runErr.(pivotUserError); isUser {
				return nil, 422, ue
			}
			return nil, 500, runErr
		}
		cols := make([]string, 0, len(res.Cols))
		types := make(map[string]string, len(res.Cols))
		labels := make(map[string]string, len(res.Cols))
		for _, c := range res.Cols {
			cols = append(cols, c.Key)
			types[c.Key] = string(c.Type)
			labels[c.Key] = c.Label
		}
		return map[string]any{
			"columns": cols, "rows": rowsOrEmpty(res.Rows),
			"column_types": types, "column_labels": labels,
			"row_count": len(res.Rows), "truncated": res.Total > int64(len(res.Rows)),
			"applied_filters": applied, "ignored_filters": ignored,
		}, 0, nil
	}

	spec := cfg.toSpec(now)
	spec.Limit = dashTileRowCap
	res, runErr := runPivot(ctx, db, d, spec)
	if runErr != nil {
		if ue, isUser := runErr.(pivotUserError); isUser {
			return nil, 422, ue
		}
		return nil, 500, runErr
	}
	cols := make([]string, 0, len(res.Dims)+len(res.Meas))
	types := make(map[string]string, len(res.Dims)+len(res.Meas))
	labels := make(map[string]string, len(res.Dims)+len(res.Meas))
	// Dimensions first, then measures. The builder relies on this order to pre-fill the
	// field wells sensibly — first dimension as the category, the measures as the series
	// — which is also the fallback the renderer uses when a tile names nothing.
	dims := make([]string, 0, len(res.Dims))
	meas := make([]string, 0, len(res.Meas))
	for _, dm := range res.Dims {
		cols = append(cols, dm.Key)
		// The report's own declared type, not an assumption. A dimension can be a date,
		// and the builder needs to know that to offer it as a time axis rather than a
		// plain category.
		types[dm.Key] = dm.Type
		labels[dm.Key] = dm.Label
		dims = append(dims, dm.Key)
	}
	for _, ms := range res.Meas {
		cols = append(cols, ms.Key)
		types[ms.Key] = ms.Type
		labels[ms.Key] = ms.Label
		meas = append(meas, ms.Key)
	}
	return map[string]any{
		"columns": cols, "rows": rowsOrEmpty(res.Rows),
		"column_types": types, "column_labels": labels,
		"dimensions": dims, "measures": meas,
		"row_count": len(res.Rows), "truncated": res.Truncated,
		"applied_filters": applied, "ignored_filters": ignored,
	}, 0, nil
}

// dashTilePreview runs an unsaved tile config so the builder can draw the real visual and
// fill its field wells from the report's actual output columns.
//
// POST /api/dashboards/tile-preview
func dashTilePreview(db *core.DB) http.HandlerFunc {
	type body struct {
		Dataset string          `json:"dataset"`
		Config  json.RawMessage `json:"config"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		if u == nil {
			respondErr(w, 401, "Sign in to preview a tile")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		raw := ""
		if len(b.Config) > 0 {
			raw = string(b.Config)
		}
		// A preview has no board around it, so no slicers apply: the builder is composing
		// the tile's own definition, and folding a selection in here would show a chart
		// that does not match what gets saved.
		out, status, err := runTileReport(ctx, db, u, b.Dataset, raw, dashSlicerSelection{})
		if err != nil {
			if status >= 500 {
				respondErrLog(w, status, "That report could not be run", err)
			} else {
				respondErr(w, status, err.Error())
			}
			return
		}
		// A preview is trimmed after the run rather than before it: the totals and the
		// truncation flag describe the whole result, so the builder can say "showing 200
		// of 4,812" instead of implying the report is small.
		if rows, okRows := out["rows"].([]core.Row); okRows && len(rows) > dashPreviewRowCap {
			out["rows"] = rows[:dashPreviewRowCap]
			out["preview_trimmed"] = true
		}
		respond(w, out, "pg")
	}
}
