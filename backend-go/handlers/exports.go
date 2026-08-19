package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

/*
The export engine.

One request shape, one query builder, one writer, one audit record — for every
dataset in the registry and every format the workspace offers.

Safety properties, all enforced here rather than trusted to callers:

  - No request value ever reaches the SQL string. Columns and filters are
    selected BY KEY from the dataset registry; an unknown key is a 422, not an
    interpolation. Filter values are bound parameters.
  - Every query is capped (LIMIT maxRows+1, so we can tell the operator the file
    was truncated instead of silently handing them a partial book).
  - Every export is logged before the bytes are streamed, with the actor, the
    dataset, the filters, the format and the row count. If the download dies
    halfway the record still exists — for an audit trail, an attempted export is
    as interesting as a completed one.
*/

// exportRequest is the body of a run or download call.
type exportRequest struct {
	Dataset  string            `json:"dataset"`
	Format   string            `json:"format"`
	DateFrom string            `json:"date_from"`
	DateTo   string            `json:"date_to"`
	Columns  []string          `json:"columns"` // empty = all declared columns, in registry order
	Filters  map[string]string `json:"filters"`
	Limit    int               `json:"limit"` // preview only
}

// RegisterExports mounts the export engine under /api/reports.
//
// The guard is the `reports` page for every route: O3 concentrates all data
// extraction in Reports & BI, so the question "may this person export?" has
// exactly one answer in exactly one place.
func RegisterExports(r chi.Router, db *core.DB) {
	rd := core.RequirePages("reports")

	r.With(rd).Get("/datasets", exportListDatasets(db))
	r.With(rd).Post("/datasets/{key}/preview", exportPreview(db))
	r.With(rd).Post("/datasets/{key}/download", exportDownload(db))
	r.With(rd).Get("/exports/log", exportLog(db))
}

// exportListDatasets returns the registry: what can be exported, which columns
// each has and which filters it accepts. The Data Export page is built entirely
// from this, so adding a dataset needs no frontend change.
func exportListDatasets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := make([]exportDataset, 0, len(exportDatasets))
		for _, d := range exportDatasets {
			d.MaxRows = d.maxRows() // surface the effective cap, not the zero default
			out = append(out, d)
		}
		respond(w, out, "static")
	}
}

// ── Query building ────────────────────────────────────────────────────────────

// buildExportQuery assembles the SQL for a request. Every dynamic part comes
// from the registry; every value is bound.
func buildExportQuery(d exportDataset, req exportRequest, limit int) (string, []any, []exportCol, error) {
	// Columns: registry order is authoritative, so a caller cannot reorder the
	// file by reordering the request (which would defeat deterministic output).
	var cols []exportCol
	if len(req.Columns) == 0 {
		cols = d.Cols
	} else {
		want := make(map[string]bool, len(req.Columns))
		for _, k := range req.Columns {
			if _, ok := d.colByKey(k); !ok {
				return "", nil, nil, fmt.Errorf("unknown column %q for dataset %q", k, d.Key)
			}
			want[k] = true
		}
		for _, c := range d.Cols {
			if want[c.Key] {
				cols = append(cols, c)
			}
		}
	}
	if len(cols) == 0 {
		return "", nil, nil, fmt.Errorf("select at least one column")
	}

	sel := make([]string, len(cols))
	for i, c := range cols {
		sel[i] = c.sql()
	}

	var (
		where []string
		args  []any
	)
	if d.Where != "" {
		where = append(where, "("+d.Where+")")
	}

	// Date range.
	if d.DateCol != "" {
		if req.DateFrom != "" {
			args = append(args, req.DateFrom)
			where = append(where, fmt.Sprintf("%s >= $%d::date", d.DateCol, len(args)))
		}
		if req.DateTo != "" {
			args = append(args, req.DateTo)
			where = append(where, fmt.Sprintf("%s <= $%d::date", d.DateCol, len(args)))
		}
	}

	// Declared filters only. An undeclared key is rejected rather than ignored:
	// silently dropping a filter would hand someone a much larger file than the
	// one they believe they asked for.
	for k, v := range req.Filters {
		if strings.TrimSpace(v) == "" {
			continue
		}
		f, ok := d.filterByKey(k)
		if !ok {
			return "", nil, nil, fmt.Errorf("unknown filter %q for dataset %q", k, d.Key)
		}
		if strings.Count(f.Expr, "?") != 1 {
			// A registry authoring error, not a caller error.
			return "", nil, nil, fmt.Errorf("filter %q is malformed", k)
		}
		args = append(args, v)
		where = append(where, strings.Replace(f.Expr, "?", fmt.Sprintf("$%d", len(args)), 1))
	}

	q := "SELECT " + strings.Join(sel, ",\n       ") + "\nFROM " + d.From
	if len(where) > 0 {
		q += "\nWHERE " + strings.Join(where, "\n  AND ")
	}
	if d.OrderBy != "" {
		q += "\nORDER BY " + d.OrderBy
	}
	q += fmt.Sprintf("\nLIMIT %d", limit)
	return q, args, cols, nil
}

// validateExportRequest applies the dataset's own preconditions.
func validateExportRequest(d exportDataset, req exportRequest) error {
	if d.DateRequired && (req.DateFrom == "" || req.DateTo == "") {
		return fmt.Errorf("%s requires both a start and end date", d.Label)
	}
	if req.DateFrom != "" && req.DateTo != "" && req.DateFrom > req.DateTo {
		return fmt.Errorf("start date is after end date")
	}
	for _, v := range []string{req.DateFrom, req.DateTo} {
		if v == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", v); err != nil {
			return fmt.Errorf("dates must be YYYY-MM-DD")
		}
	}
	return nil
}

func decodeExportRequest(r *http.Request, key string) (exportRequest, error) {
	var req exportRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			return req, fmt.Errorf("invalid JSON")
		}
	}
	req.Dataset = key
	return req, nil
}

// ── Preview ───────────────────────────────────────────────────────────────────

// exportPreview runs the same query the download would run, capped small, so an
// operator can confirm they are about to extract the right rows before pulling
// a file. Previews are not written to the export log — nothing left the building.
func exportPreview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		d, ok := exportDatasetByKey(key)
		if !ok {
			respondErr(w, 404, "Unknown dataset: "+key)
			return
		}
		req, err := decodeExportRequest(r, key)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		// A preview is a sanity check, not an extract, so d.DateRequired is
		// deliberately not enforced here — an operator should be able to see the
		// shape of a large table before committing to a date range for the file.
		if req.DateFrom != "" && req.DateTo != "" && req.DateFrom > req.DateTo {
			respondErr(w, 422, "start date is after end date")
			return
		}

		limit := req.Limit
		if limit <= 0 || limit > 200 {
			limit = 50
		}
		q, args, cols, err := buildExportQuery(d, req, limit)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			slog.Error("export preview", "dataset", key, "err", err)
			respondErr(w, 500, "Preview failed: "+err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// Estimate the true size so the operator knows what the download holds.
		total := int64(len(rows))
		if len(rows) == limit {
			if cq, cargs, _, cerr := buildExportCountQuery(d, req); cerr == nil {
				if cr, cerr2 := db.PGQuery(r.Context(), cq, cargs...); cerr2 == nil && len(cr) > 0 {
					total = toInt64(cr[0]["n"])
				}
			}
		}

		respond(w, map[string]any{
			"columns":   cols,
			"rows":      rows,
			"row_count": len(rows),
			"total":     total,
			"max_rows":  d.maxRows(),
		}, "pg")
	}
}

// buildExportCountQuery mirrors buildExportQuery's predicates for a COUNT(*).
func buildExportCountQuery(d exportDataset, req exportRequest) (string, []any, []exportCol, error) {
	// Reuse the builder for its WHERE clause, then swap the projection. Building
	// the predicates twice is how the count and the export drift apart.
	q, args, cols, err := buildExportQuery(d, req, 1)
	if err != nil {
		return "", nil, nil, err
	}
	from := strings.Index(q, "\nFROM ")
	if from < 0 {
		return "", nil, nil, fmt.Errorf("cannot build count query")
	}
	body := q[from:]
	if i := strings.Index(body, "\nORDER BY "); i >= 0 {
		body = body[:i]
	} else if i := strings.Index(body, "\nLIMIT "); i >= 0 {
		body = body[:i]
	}
	return "SELECT COUNT(*) AS n" + body, args, cols, nil
}

// ── Download ──────────────────────────────────────────────────────────────────

func exportDownload(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		d, ok := exportDatasetByKey(key)
		if !ok {
			respondErr(w, 404, "Unknown dataset: "+key)
			return
		}
		req, err := decodeExportRequest(r, key)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		if err := validateExportRequest(d, req); err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		format, ok := parseExportFormat(req.Format)
		if !ok {
			respondErr(w, 422, "Unsupported format: "+req.Format+" (use csv, xlsx or json)")
			return
		}

		cap := d.maxRows()
		// +1 so a full page tells us the result was truncated.
		q, args, cols, err := buildExportQuery(d, req, cap+1)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}

		started := time.Now()
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			slog.Error("export query", "dataset", key, "err", err)
			logExport(r.Context(), db, r, d, req, format, 0, "failed", err.Error())
			respondErr(w, 500, "Export failed: "+err.Error())
			return
		}
		truncated := false
		if len(rows) > cap {
			rows = rows[:cap]
			truncated = true
		}

		filename := exportFilename(d.Key, format)

		// Logged BEFORE streaming: a download that dies halfway is still an
		// attempt to move data out, and that is exactly what an audit trail is for.
		status := "ok"
		if truncated {
			status = "truncated"
		}
		logExport(r.Context(), db, r, d, req, format, len(rows), status, "")

		if truncated {
			// The operator must not mistake a capped file for the whole book.
			w.Header().Set("X-Export-Truncated", "true")
		}
		if err := writeExport(w, format, filename, cols, rows); err != nil {
			slog.Error("export write", "dataset", key, "format", format, "err", err)
			return
		}
		slog.Info("export", "dataset", key, "format", format, "rows", len(rows),
			"truncated", truncated, "ms", time.Since(started).Milliseconds())
	}
}

// ── Audit ─────────────────────────────────────────────────────────────────────

// logExport records one export attempt. Fire-and-forget: a logging failure must
// never fail the operator's download, but it is logged loudly.
func logExport(ctx context.Context, db *core.DB, r *http.Request, d exportDataset,
	req exportRequest, format exportFormat, rowCount int, status, errMsg string) {

	var uid any
	var actorName, actorRole string
	if u := core.UserFromCtx(ctx); u != nil {
		uid = u.ID
		actorName, actorRole = u.FullName, u.Role
	}

	meta := map[string]any{
		"date_from": req.DateFrom,
		"date_to":   req.DateTo,
		"filters":   req.Filters,
		"columns":   req.Columns,
		"module":    d.Module,
	}
	if errMsg != "" {
		meta["error"] = errMsg
	}
	metaJSON, _ := json.Marshal(meta)

	ip := ""
	if r != nil {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			ip = strings.TrimSpace(parts[len(parts)-1])
		} else {
			ip = r.RemoteAddr
		}
	}

	if _, err := db.PGExec(ctx, `
		INSERT INTO report_export_log
			(report_type, filters, row_count, created_by, format, status,
			 actor_name, actor_role, ip_address)
		VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)`,
		d.Key, string(metaJSON), rowCount, uid, string(format), status,
		actorName, actorRole, ip); err != nil {
		slog.Error("logExport", "dataset", d.Key, "err", err)
	}
}

// exportLog returns recent export activity. This is the compliance view of who
// has taken what out of the workspace.
func exportLog(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 50, 1, 500)
		mine := qstr(r, "mine") == "true"

		where := "WHERE 1=1"
		args := []any{}
		if mine {
			if u := core.UserFromCtx(r.Context()); u != nil {
				args = append(args, u.ID)
				where += fmt.Sprintf(" AND el.created_by = $%d", len(args))
			}
		}
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT el.id, el.report_type, el.row_count, el.created_at,
			       COALESCE(el.format, 'csv')                       AS format,
			       COALESCE(el.status, 'ok')                        AS status,
			       COALESCE(u.full_name, el.actor_name, '')         AS created_by,
			       COALESCE(u.role, el.actor_role, '')              AS created_by_role,
			       el.filters
			FROM report_export_log el
			LEFT JOIN app.o3c_users u ON u.id = el.created_by
			%s
			ORDER BY el.created_at DESC
			LIMIT $%d`, where, len(args)), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// Attach the human label so the log reads as report names, not keys.
		labels := map[string]string{}
		for _, d := range exportDatasets {
			labels[d.Key] = d.Label
		}
		for _, row := range rows {
			k := str(row["report_type"])
			if l, ok := labels[k]; ok {
				row["dataset_label"] = l
			} else {
				row["dataset_label"] = k
			}
		}
		respond(w, rows, "pg")
	}
}
