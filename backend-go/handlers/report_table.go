package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
Table view, column unique values, and the one renderer every report file goes through.

The Report Builder shows a report two ways. A Summary is the pivot (reports_pivot.go),
drawn as a matrix (pivot_matrix.go). A Table is one line per record, with the columns,
names, order and sort the person chose. Before Table view existed people built lists out
of the pivot, which merged identical records and stopped at 5,000 groups.

renderReport is the only place a report becomes columns and rows for a file, so a
download, an emailed report and a scheduled send all match what the builder shows.

Safety is the export engine's: every column, sort field and filter resolves BY KEY from
the dataset registry, directions and operators come from whitelists, and every value is
a bound parameter.
*/

type tableColumn struct {
	Key   string `json:"key"`
	Label string `json:"label,omitempty"`
}

type reportSort struct {
	Key string `json:"key"`
	Dir string `json:"dir"` // asc | desc
}

type tableSpec struct {
	DateFrom   string
	DateTo     string
	Filters    map[string]string
	ColFilters []colFilter
	Columns    []tableColumn
	Sort       []reportSort
	Limit      int
	Offset     int
}

type tableResult struct {
	Cols   []exportCol
	Rows   []core.Row
	Total  int64          // records matching the filters, across every page
	Totals map[string]any // column key → sum, for whole-number and money columns
}

const (
	tableMaxColumns  = 60
	tablePageDefault = 200
	tablePageMax     = 500
	uniquesDefault   = 100
	uniquesMax       = 500
)

// A report file carries every matching record, up to the data source's own cap
// (d.maxRows(): exportDefaultMaxRows, or the dataset's own MaxRows). Department
// supervisors used to stop at 5,000 while BI kept the data source's cap — reversed on
// 2026-09-18, after a supervisor's download came back short. A person's role decides
// WHICH data sources they may report on (reportDatasetAllowed) and who they may email
// (reportRecipientsNotAllowed), never how many records their own report returns.

// tableTotalable reports whether a column's values add up to a meaningful total.
func tableTotalable(t exportColType) bool {
	return t == colInt || t == colKobo || t == colMoney
}

// colFilterDateOnly reports whether every value on a filter is a bare date
// (YYYY-MM-DD), which is how a date-and-time field is filtered by calendar day.
func colFilterDateOnly(cf colFilter) bool {
	vals := append([]string{cf.Value, cf.Value2}, cf.Values...)
	any := false
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if len(v) != len("2006-01-02") {
			return false
		}
		if _, err := time.Parse("2006-01-02", v); err != nil {
			return false
		}
		any = true
	}
	return any
}

type tableQuery struct {
	Select string // the page of records
	Totals string // COUNT(*) and column sums over the same filters
	Args   []any
	Cols   []exportCol
}

func buildTableQuery(d exportDataset, spec tableSpec) (tableQuery, error) {
	if len(spec.Columns) == 0 {
		return tableQuery{}, pivotUserError{"Add at least one column"}
	}
	if len(spec.Columns) > tableMaxColumns {
		return tableQuery{}, pivotUserError{fmt.Sprintf("A table can show up to %d columns", tableMaxColumns)}
	}
	var (
		cols    []exportCol
		selects []string
		sums    = []string{"COUNT(*) AS n"}
		seen    = map[string]bool{}
	)
	for _, tc := range spec.Columns {
		c, ok := d.colByKey(tc.Key)
		if !ok {
			return tableQuery{}, pivotUserError{"Unknown field: " + tc.Key}
		}
		if seen[c.Key] {
			continue
		}
		seen[c.Key] = true
		label := c.Label
		if l := strings.TrimSpace(tc.Label); l != "" {
			label = l
		}
		cols = append(cols, exportCol{Key: c.Key, Label: label, Type: c.Type})
		selects = append(selects, fmt.Sprintf("%s AS %q", c.Expr, c.Key))
		if tableTotalable(c.Type) {
			sums = append(sums, fmt.Sprintf("SUM((%s)::numeric) AS %q", c.Expr, "t_"+c.Key))
		}
	}

	where, args, err := buildExportWhere(d, exportRequest{
		Dataset: d.Key, DateFrom: spec.DateFrom, DateTo: spec.DateTo,
		Filters: spec.Filters, ColFilters: spec.ColFilters,
	})
	if err != nil {
		return tableQuery{}, pivotUserError{err.Error()}
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = "\nWHERE " + strings.Join(where, "\n  AND ")
	}

	var order []string
	for _, s := range spec.Sort {
		c, ok := d.colByKey(s.Key)
		if !ok {
			return tableQuery{}, pivotUserError{"Unknown sort field: " + s.Key}
		}
		dir := "ASC"
		if s.Dir == "desc" {
			dir = "DESC"
		}
		order = append(order, fmt.Sprintf("(%s) %s NULLS LAST", c.Expr, dir))
	}
	// The data source's own order, then its unique key, break ties, so a page break never
	// repeats or skips a record when many share the same sort value.
	if d.OrderBy != "" {
		order = append(order, d.OrderBy)
	}
	if d.KeyCol != "" {
		order = append(order, d.KeyCol)
	}

	limit := spec.Limit
	if limit <= 0 {
		limit = tablePageDefault
	}
	offset := spec.Offset
	if offset < 0 {
		offset = 0
	}

	q := "SELECT " + strings.Join(selects, ",\n       ") + "\nFROM " + d.From + whereSQL
	if len(order) > 0 {
		q += "\nORDER BY " + strings.Join(order, ", ")
	}
	q += fmt.Sprintf("\nLIMIT %d OFFSET %d", limit, offset)

	return tableQuery{
		Select: q,
		Totals: "SELECT " + strings.Join(sums, ", ") + "\nFROM " + d.From + whereSQL,
		Args:   args,
		Cols:   cols,
	}, nil
}

func runTable(ctx context.Context, db *core.DB, d exportDataset, spec tableSpec, withTotals bool) (tableResult, error) {
	tq, err := buildTableQuery(d, spec)
	if err != nil {
		return tableResult{}, err
	}
	rows, err := db.PGQuery(ctx, tq.Select, tq.Args...)
	if err != nil {
		return tableResult{}, err
	}
	if rows == nil {
		rows = []core.Row{}
	}
	res := tableResult{Cols: tq.Cols, Rows: rows}
	if withTotals {
		tr, err := db.PGQuery(ctx, tq.Totals, tq.Args...)
		if err != nil {
			return tableResult{}, err
		}
		if len(tr) > 0 {
			res.Total = toInt64(tr[0]["n"])
			res.Totals = map[string]any{}
			for _, c := range tq.Cols {
				if v, ok := tr[0]["t_"+c.Key]; ok {
					res.Totals[c.Key] = v
				}
			}
		}
	}
	return res, nil
}

type uniquesSpec struct {
	Column     string
	DateFrom   string
	DateTo     string
	Filters    map[string]string
	ColFilters []colFilter
	Search     string
	Limit      int
}

// buildUniquesQuery lists a column's distinct values under the report's filters, most
// common first, with how many records hold each. Empty text counts as blank. Dates are
// listed by calendar day, which is what a ticked value then filters on.
func buildUniquesQuery(d exportDataset, spec uniquesSpec) (string, []any, error) {
	c, ok := d.colByKey(spec.Column)
	if !ok {
		return "", nil, pivotUserError{"Unknown field: " + spec.Column}
	}
	valExpr := fmt.Sprintf("NULLIF((%s)::text, '')", c.Expr)
	if c.Type == colDate || c.Type == colDateTime {
		valExpr = fmt.Sprintf("to_char((%s)::timestamp, 'YYYY-MM-DD')", c.Expr)
	}
	where, args, err := buildExportWhere(d, exportRequest{
		Dataset: d.Key, DateFrom: spec.DateFrom, DateTo: spec.DateTo,
		Filters: spec.Filters, ColFilters: spec.ColFilters,
	})
	if err != nil {
		return "", nil, pivotUserError{err.Error()}
	}
	inner := "SELECT " + valExpr + " AS v FROM " + d.From
	if len(where) > 0 {
		inner += "\nWHERE " + strings.Join(where, "\n  AND ")
	}
	q := "SELECT v AS value, COUNT(*) AS n, COUNT(*) OVER () AS distinct_total\nFROM (" + inner + ") x"
	if s := strings.TrimSpace(spec.Search); s != "" {
		args = append(args, likeEscape(s))
		q += fmt.Sprintf("\nWHERE v ILIKE '%%' || $%d || '%%' ESCAPE '\\'", len(args))
	}
	limit := spec.Limit
	if limit <= 0 {
		limit = uniquesDefault
	}
	if limit > uniquesMax {
		limit = uniquesMax
	}
	q += fmt.Sprintf("\nGROUP BY v\nORDER BY n DESC, v ASC NULLS LAST\nLIMIT %d", limit)
	return q, args, nil
}

// ── Rendering for files, email and schedules ─────────────────────────────────

type renderedReport struct {
	Cols      []exportCol
	Rows      []map[string]any
	Truncated bool  // the report has more records than this person's file cap
	Cap       int   // that cap
	Total     int64 // Table view: matching records in all
	Summary   bool  // rows are summary lines rather than records
	TotalsRow bool  // the last row is a Table's totals line
}

// RecordCount is how many records, or summary lines, the report carries, leaving out a
// Table's closing totals line.
func (r renderedReport) RecordCount() int {
	if r.TotalsRow && len(r.Rows) > 0 {
		return len(r.Rows) - 1
	}
	return len(r.Rows)
}

// renderReport turns a report definition into the columns and rows every file, email
// and schedule writes — the same columns, names, order, sort and layout the builder
// shows.
func renderReport(ctx context.Context, db *core.DB, d exportDataset, cfg savedPivotConfig, now time.Time, fileCap int) (renderedReport, error) {
	ps := cfg.toSpec(now)
	if err := validateExportRequest(d, exportRequest{DateFrom: ps.DateFrom, DateTo: ps.DateTo}); err != nil {
		return renderedReport{}, pivotUserError{err.Error()}
	}
	out := renderedReport{Cap: fileCap}

	if cfg.View == "table" {
		spec := cfg.toTableSpec(now)
		spec.Limit = fileCap + 1
		res, err := runTable(ctx, db, d, spec, len(cfg.Totals) > 0)
		if err != nil {
			return renderedReport{}, err
		}
		rows := res.Rows
		if len(rows) > fileCap {
			rows = rows[:fileCap]
			out.Truncated = true
		}
		out.Cols, out.Rows, out.Total = res.Cols, rows, res.Total
		if len(cfg.Totals) > 0 && len(res.Cols) > 0 {
			out.Rows = append(out.Rows, tableTotalsRow(res, cfg.Totals))
			out.TotalsRow = true
		}
		return out, nil
	}

	res, err := runPivot(ctx, db, d, ps)
	if err != nil {
		return renderedReport{}, err
	}
	out.Summary = true
	out.Cols, out.Rows = buildPivotMatrix(res, cfg.HeaderLabels, cfg.HiddenCols, cfg.Sort).exportRows()
	out.Truncated = res.Truncated
	if len(out.Rows) > fileCap {
		out.Rows = out.Rows[:fileCap]
		out.Truncated = true
	}
	return out, nil
}

// tableTotalsRow is the closing line of a Table file: the sums of the columns the
// report totals, over every matching record, labelled in the first column.
func tableTotalsRow(res tableResult, keys []string) map[string]any {
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	row := map[string]any{}
	labelled := false
	for _, c := range res.Cols {
		if want[c.Key] && tableTotalable(c.Type) {
			row[c.Key] = res.Totals[c.Key]
			continue
		}
		// The label goes in the first column that isn't itself a total, so it is never
		// overwritten by a sum and the line never reads as a record.
		if !labelled {
			row[c.Key] = fmt.Sprintf("Total of %d Records", res.Total)
			labelled = true
		}
	}
	return row
}

// respondReportErr maps a bad report definition to 422 and anything else to 500.
func respondReportErr(w http.ResponseWriter, err error) {
	var ue pivotUserError
	if errors.As(err, &ue) {
		respondErr(w, 422, ue.Error())
		return
	}
	respondErrLog(w, 500, "Could not run the report", err)
}

// ── Recipients ───────────────────────────────────────────────────────────────

// reportRecipientsNotAllowed returns the recipients this person may not send a report
// to. BI can send anywhere, as before. A department supervisor's reports carry their
// department's records, so they go only to company addresses: the domains active
// workspace users' emails are on. A domain counts only when several active users share
// it, so one account made with a personal address can't open gmail.com to every head.
func reportRecipientsNotAllowed(ctx context.Context, db *core.DB, u *core.Claims, to []string) []string {
	if u != nil && u.HasPage("reports") {
		return nil
	}
	allowed := map[string]bool{}
	rows, _ := db.PGQuery(ctx, `
		SELECT lower(split_part(email, '@', 2)) AS domain
		FROM o3c_users
		WHERE deleted_at IS NULL AND COALESCE(is_active, true) AND email LIKE '%@%'
		GROUP BY 1
		HAVING COUNT(*) >= 3`)
	for _, r := range rows {
		allowed[str(r["domain"])] = true
	}
	var bad []string
	for _, e := range to {
		at := strings.LastIndex(e, "@")
		if at < 0 || !allowed[strings.ToLower(e[at+1:])] {
			bad = append(bad, e)
		}
	}
	return bad
}

func reportRecipientsDeniedMessage(bad []string) string {
	return "Reports on your department's data can only go to company email addresses. Remove " + strings.Join(bad, ", ")
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// reportTable returns one page of a Table report, with the total record count and
// column sums across every page.
func reportTable(db *core.DB) http.HandlerFunc {
	type body struct {
		DateFrom   string            `json:"date_from"`
		DateTo     string            `json:"date_to"`
		Filters    map[string]string `json:"filters"`
		ColFilters []colFilter       `json:"col_filters"`
		Columns    []tableColumn     `json:"columns"`
		Sort       []reportSort      `json:"sort"`
		Limit      int               `json:"limit"`
		Offset     int               `json:"offset"`
		// SkipTotals is set when only the page changed: the count and sums are the same as
		// the page before, so they aren't worked out again.
		SkipTotals bool `json:"skip_totals"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		d, ok := exportDatasetByKey(key)
		if !ok {
			respondErr(w, 404, "Unknown dataset: "+key)
			return
		}
		u := core.UserFromCtx(r.Context())
		if !reportDatasetAllowed(u, key) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}
		var b body
		if r.Body != nil {
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil && err.Error() != "EOF" {
				respondErr(w, 400, "invalid JSON")
				return
			}
		}
		if err := validateExportRequest(d, exportRequest{DateFrom: b.DateFrom, DateTo: b.DateTo}); err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		limit := b.Limit
		if limit <= 0 {
			limit = tablePageDefault
		}
		if limit > tablePageMax {
			limit = tablePageMax
		}
		offset := b.Offset
		if offset < 0 {
			offset = 0
		}
		res, err := runTable(r.Context(), db, d, tableSpec{
			DateFrom: b.DateFrom, DateTo: b.DateTo, Filters: b.Filters, ColFilters: b.ColFilters,
			Columns: b.Columns, Sort: b.Sort, Limit: limit, Offset: offset,
		}, !b.SkipTotals)
		if err != nil {
			respondReportErr(w, err)
			return
		}
		out := map[string]any{
			"columns": res.Cols,
			"rows":    res.Rows,
			"offset":  offset,
			"limit":   limit,
		}
		if !b.SkipTotals {
			out["total"], out["totals"] = res.Total, res.Totals
		}
		respond(w, out, "pg")
	}
}

// reportUniques lists one column's values with their record counts, under the report's
// other filters — the list in a column's header menu.
func reportUniques(db *core.DB) http.HandlerFunc {
	type body struct {
		Column     string            `json:"column"`
		DateFrom   string            `json:"date_from"`
		DateTo     string            `json:"date_to"`
		Filters    map[string]string `json:"filters"`
		ColFilters []colFilter       `json:"col_filters"`
		Search     string            `json:"search"`
		Limit      int               `json:"limit"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		d, ok := exportDatasetByKey(key)
		if !ok {
			respondErr(w, 404, "Unknown dataset: "+key)
			return
		}
		if !reportDatasetAllowed(core.UserFromCtx(r.Context()), key) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}
		var b body
		if r.Body != nil {
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil && err.Error() != "EOF" {
				respondErr(w, 400, "invalid JSON")
				return
			}
		}
		if err := validateExportRequest(d, exportRequest{DateFrom: b.DateFrom, DateTo: b.DateTo}); err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		q, args, err := buildUniquesQuery(d, uniquesSpec{
			Column: b.Column, DateFrom: b.DateFrom, DateTo: b.DateTo, Filters: b.Filters,
			ColFilters: b.ColFilters, Search: b.Search, Limit: b.Limit,
		})
		if err != nil {
			respondReportErr(w, err)
			return
		}
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondReportErr(w, err)
			return
		}
		values := make([]map[string]any, 0, len(rows))
		var distinct int64
		for _, row := range rows {
			values = append(values, map[string]any{"value": row["value"], "count": toInt64(row["n"])})
			distinct = toInt64(row["distinct_total"])
		}
		respond(w, map[string]any{
			"column":         b.Column,
			"values":         values,
			"distinct_total": distinct,
			"more":           distinct > int64(len(values)),
		}, "pg")
	}
}

// reportFile renders the report open in the builder — saved or not — as a file:
// xlsx or csv to download, or json for the builder's PDF. It is the same render a
// saved report's email and schedule use.
func reportFile(db *core.DB) http.HandlerFunc {
	type body struct {
		Name    string           `json:"name"`
		Dataset string           `json:"dataset"`
		Config  savedPivotConfig `json:"config"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		format, ok := parseExportFormat(r.URL.Query().Get("format"))
		if !ok {
			respondErr(w, 422, "Unsupported format (use xlsx, csv or json)")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		d, ok := exportDatasetByKey(b.Dataset)
		if !ok {
			respondErr(w, 422, "Unknown data source")
			return
		}
		u := core.UserFromCtx(ctx)
		if !reportDatasetAllowed(u, d.Key) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}
		rep, err := renderReport(ctx, db, d, b.Config, time.Now(), d.maxRows())
		if err != nil {
			respondReportErr(w, err)
			return
		}
		name := strings.TrimSpace(b.Name)
		if name == "" {
			name = d.Label + " Report"
		}
		if rep.Truncated {
			w.Header().Set("X-Export-Truncated", "true")
		}
		// A PDF made from the json render leaves the building like any other file.
		logBIExport(ctx, db, r, name, d.Key, format, rep.RecordCount())
		if err := writeExport(w, format, exportFilename(name, format), rep.Cols, rep.Rows); err != nil {
			slog.Error("reportFile write", "dataset", d.Key, "format", format, "err", err)
		}
	}
}
