package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
Saved reports + scheduled delivery for the drag-and-drop Report Builder.

A saved report is the builder's configuration (dataset + rows/cols/values +
filters + a date window + chart prefs) stored as JSON. Running one re-executes
the pivot live through runPivot (reports_pivot.go), so it is always current.
The same runPivot drives three surfaces with identical safety guarantees:

  - the live preview in the builder (exportPivot),
  - an on-demand download or email of a saved report,
  - the scheduled-email worker (StartReportScheduleWorker).

Files are produced by the shared export writers (exportwriter.go), so a scheduled
CSV/XLSX gets the same column ordering, kobo→naira formatting and formula-
injection guard as every other file the workspace emits. Email goes through the
same SendMail path as the rest of the platform.
*/

// reportTZ anchors schedule times and relative date windows to Africa/Lagos,
// which has no DST — so a "07:00 daily" report lands at 07:00 local regardless of
// the server's own timezone.
var reportTZ = time.FixedZone("WAT", 1*60*60)

// ── Config ────────────────────────────────────────────────────────────────────

type savedPivotConfig struct {
	Rows       []string          `json:"rows"`
	Cols       []string          `json:"cols"`
	Values     []pivotValue      `json:"values"`
	Filters    map[string]string `json:"filters"`
	ColFilters []colFilter       `json:"col_filters"`
	Grains     map[string]string `json:"grains"`
	DateWindow string            `json:"date_window"` // "" | custom | today | last_7_days | ...
	DateFrom   string            `json:"date_from"`
	DateTo     string            `json:"date_to"`
	Chart      json.RawMessage   `json:"chart,omitempty"` // view prefs; opaque to the server
}

// toSpec resolves the config into an executable pivotSpec. A relative window is
// recomputed against `now` so a scheduled report rolls forward each run; a custom
// window uses the stored fixed dates.
func (c savedPivotConfig) toSpec(now time.Time) pivotSpec {
	from, to := c.DateFrom, c.DateTo
	if c.DateWindow != "" && c.DateWindow != "custom" {
		if f, t := resolveReportWindow(c.DateWindow, now); f != "" {
			from, to = f, t
		}
	}
	return pivotSpec{DateFrom: from, DateTo: to, Filters: c.Filters, ColFilters: c.ColFilters, Rows: c.Rows, Cols: c.Cols, Values: c.Values, Grains: c.Grains}
}

// resolveReportWindow turns a named relative window into concrete YYYY-MM-DD
// bounds in Lagos time. Kept in lockstep with resolveWindow() in the frontend.
func resolveReportWindow(window string, now time.Time) (string, string) {
	n := now.In(reportTZ)
	today := time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, reportTZ)
	d := func(t time.Time) string { return t.Format("2006-01-02") }
	switch window {
	case "today":
		return d(today), d(today)
	case "last_7_days":
		return d(today.AddDate(0, 0, -6)), d(today)
	case "last_30_days":
		return d(today.AddDate(0, 0, -29)), d(today)
	case "last_90_days":
		return d(today.AddDate(0, 0, -89)), d(today)
	case "this_month":
		return d(time.Date(n.Year(), n.Month(), 1, 0, 0, 0, 0, reportTZ)), d(today)
	case "last_month":
		first := time.Date(n.Year(), n.Month(), 1, 0, 0, 0, 0, reportTZ)
		end := first.AddDate(0, 0, -1)
		start := time.Date(end.Year(), end.Month(), 1, 0, 0, 0, 0, reportTZ)
		return d(start), d(end)
	case "this_quarter":
		q := (int(n.Month()) - 1) / 3
		return d(time.Date(n.Year(), time.Month(q*3+1), 1, 0, 0, 0, 0, reportTZ)), d(today)
	case "this_year":
		return d(time.Date(n.Year(), 1, 1, 0, 0, 0, 0, reportTZ)), d(today)
	}
	return "", ""
}

// jsonBytes coerces a value read back from a jsonb column (which pgx may hand
// back as []byte or string) into raw JSON bytes.
func jsonBytes(v any) []byte {
	switch t := v.(type) {
	case nil:
		return nil
	case []byte:
		return t
	case string:
		return []byte(t)
	default:
		b, _ := json.Marshal(t)
		return b
	}
}

func parseSavedConfig(v any) savedPivotConfig {
	var c savedPivotConfig
	if b := jsonBytes(v); len(b) > 0 {
		json.Unmarshal(b, &c) //nolint:errcheck
	}
	return c
}

// ── Registration ──────────────────────────────────────────────────────────────

func RegisterSavedReports(r chi.Router, db *core.DB) {
	rd := core.RequirePages("reports")

	r.With(rd).Get("/saved", savedListReports(db))
	r.With(rd).Post("/saved", savedCreateReport(db))
	r.With(rd).Get("/saved/{id}", savedGetReport(db))
	r.With(rd).Put("/saved/{id}", savedUpdateReport(db))
	r.With(rd).Delete("/saved/{id}", savedDeleteReport(db))
	r.With(rd).Post("/saved/{id}/export", savedExportReport(db)) // ?format=csv|xlsx|json
	r.With(rd).Post("/saved/{id}/email", savedEmailReport(db))
	r.With(rd).Post("/pivot-email", savedEmailAdhoc(db)) // email an unsaved config

	r.With(rd).Get("/schedules", savedListSchedules(db))
	r.With(rd).Post("/saved/{id}/schedule", savedCreateSchedule(db))
	r.With(rd).Put("/schedules/{sid}", savedUpdateSchedule(db))
	r.With(rd).Delete("/schedules/{sid}", savedDeleteSchedule(db))

	r.With(rd).Get("/my-dashboard", savedMyDashboard(db))
}

// savedMyDashboard is the analyst's station over the pivot Report Builder: their
// saved reports, active/due schedules, recent delivery health and upcoming runs.
// A missing table simply omits that field.
func savedMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var uid int64
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		dash := map[string]any{}
		scalar := func(key, q string, args ...any) {
			rows, _ := db.PGQuery(ctx, q, args...)
			if len(rows) > 0 {
				dash[key] = rows[0]["count"]
			}
		}
		scalar("my_reports", `SELECT COUNT(*) AS count FROM pivot_reports WHERE created_by=$1`, uid)
		scalar("shared_reports", `SELECT COUNT(*) AS count FROM pivot_reports WHERE is_public`)
		scalar("scheduled_active", `SELECT COUNT(*) AS count FROM pivot_report_schedules s
			JOIN pivot_reports p ON p.id=s.report_id
			WHERE s.is_active AND (p.created_by=$1 OR s.created_by=$1 OR p.is_public)`, uid)
		scalar("scheduled_due", `SELECT COUNT(*) AS count FROM pivot_report_schedules s
			JOIN pivot_reports p ON p.id=s.report_id
			WHERE s.is_active AND s.next_run_at IS NOT NULL AND s.next_run_at<=NOW()
			  AND (p.created_by=$1 OR s.created_by=$1 OR p.is_public)`, uid)
		scalar("delivered_today", `SELECT COUNT(*) AS count FROM pivot_report_schedules
			WHERE last_run_at::date=CURRENT_DATE AND COALESCE(last_status,'') LIKE 'sent%'`)
		scalar("failed_recent", `SELECT COUNT(*) AS count FROM pivot_report_schedules
			WHERE COALESCE(last_status,'') LIKE 'error%' AND last_run_at >= NOW() - INTERVAL '7 days'`)

		if rows, _ := db.PGQuery(ctx, `SELECT MIN(next_run_at) AS next FROM pivot_report_schedules WHERE is_active AND next_run_at>NOW()`); len(rows) > 0 {
			dash["next_scheduled_at"] = rows[0]["next"]
		}

		up, _ := db.PGQuery(ctx, `
			SELECT s.frequency, s.hour, s.day_of_week, s.day_of_month, s.next_run_at, s.last_run_at,
			       s.format, p.name AS report_name
			FROM pivot_report_schedules s JOIN pivot_reports p ON p.id=s.report_id
			WHERE s.is_active
			ORDER BY (s.next_run_at IS NULL), s.next_run_at ASC LIMIT 8`)
		if up == nil {
			up = []core.Row{}
		}
		dash["upcoming_schedules"] = up

		recent, _ := db.PGQuery(ctx, `
			SELECT s.last_run_at, s.last_status, s.format, p.name AS report_name
			FROM pivot_report_schedules s JOIN pivot_reports p ON p.id=s.report_id
			WHERE s.last_run_at IS NOT NULL
			ORDER BY s.last_run_at DESC LIMIT 8`)
		if recent == nil {
			recent = []core.Row{}
		}
		dash["recent_deliveries"] = recent

		mine, _ := db.PGQuery(ctx, `SELECT id, name, dataset, is_public, updated_at FROM pivot_reports WHERE created_by=$1 ORDER BY updated_at DESC LIMIT 8`, uid)
		if mine == nil {
			mine = []core.Row{}
		}
		dash["my_report_list"] = mine

		respond(w, dash, "pg")
	}
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

func savedListReports(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var uid int64
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		rows, err := db.PGQuery(ctx, `
			SELECT p.id, p.name, p.description, p.dataset, p.config, p.is_public,
			       p.created_by, p.created_at, p.updated_at,
			       u.full_name AS created_by_name,
			       (p.created_by = $1) AS is_mine,
			       (SELECT COUNT(*) FROM pivot_report_schedules s
			         WHERE s.report_id = p.id AND s.is_active) AS active_schedules
			FROM pivot_reports p
			LEFT JOIN o3c_users u ON u.id = p.created_by
			WHERE p.is_public = TRUE OR p.created_by = $1
			ORDER BY p.updated_at DESC`, uid)
		if err != nil {
			respondErrLog(w, 500, "Could not load saved reports", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func savedGetReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		u := core.UserFromCtx(ctx)
		rows, err := db.PGQuery(ctx, `SELECT * FROM pivot_reports WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		rep := rows[0]
		isPublic, _ := rep["is_public"].(bool)
		if !isPublic && u != nil && toInt64(rep["created_by"]) != u.ID {
			respondErr(w, 403, "Not your report")
			return
		}
		respond(w, rep, "pg")
	}
}

func savedCreateReport(db *core.DB) http.HandlerFunc {
	type body struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Dataset     string          `json:"dataset"`
		Config      json.RawMessage `json:"config"`
		IsPublic    bool            `json:"is_public"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.Name = strings.TrimSpace(b.Name)
		if b.Name == "" {
			respondErr(w, 400, "A report name is required")
			return
		}
		if _, ok := exportDatasetByKey(b.Dataset); !ok {
			respondErr(w, 422, "Unknown data source")
			return
		}
		cfg := b.Config
		if len(cfg) == 0 {
			cfg = json.RawMessage("{}")
		}
		var uid any
		if u != nil {
			uid = u.ID
		}
		rows, err := db.PGQuery(ctx, `
			INSERT INTO pivot_reports (name, description, dataset, config, is_public, created_by)
			VALUES ($1,$2,$3,$4::jsonb,$5,$6)
			RETURNING id, name, description, dataset, config, is_public, created_at, updated_at`,
			b.Name, b.Description, b.Dataset, string(cfg), b.IsPublic, uid)
		if err != nil {
			respondErrLog(w, 500, "Could not save the report", err)
			return
		}
		respond(w, rows[0], "pg")
	}
}

func savedUpdateReport(db *core.DB) http.HandlerFunc {
	type body struct {
		Name        *string         `json:"name"`
		Description *string         `json:"description"`
		Config      json.RawMessage `json:"config"`
		IsPublic    *bool           `json:"is_public"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		existing, _ := db.PGQuery(ctx, `SELECT created_by FROM pivot_reports WHERE id=$1`, id)
		if len(existing) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		if u != nil && toInt64(existing[0]["created_by"]) != u.ID {
			respondErr(w, 403, "Not your report")
			return
		}
		set := "updated_at=NOW()"
		args := []any{}
		n := 1
		add := func(col string, val any) {
			set += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, val)
			n++
		}
		if b.Name != nil {
			add("name", strings.TrimSpace(*b.Name))
		}
		if b.Description != nil {
			add("description", *b.Description)
		}
		if b.IsPublic != nil {
			add("is_public", *b.IsPublic)
		}
		if len(b.Config) > 0 {
			set += fmt.Sprintf(", config=$%d::jsonb", n)
			args = append(args, string(b.Config))
			n++
		}
		args = append(args, id)
		if _, err := db.PGExec(ctx, fmt.Sprintf(`UPDATE pivot_reports SET %s WHERE id=$%d`, set, n), args...); err != nil {
			respondErrLog(w, 500, "Could not update the report", err)
			return
		}
		respond(w, map[string]any{"ok": true}, "json")
	}
}

func savedDeleteReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		existing, _ := db.PGQuery(ctx, `SELECT created_by FROM pivot_reports WHERE id=$1`, id)
		if len(existing) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		if u != nil && toInt64(existing[0]["created_by"]) != u.ID {
			respondErr(w, 403, "Not your report")
			return
		}
		db.PGExec(ctx, `DELETE FROM pivot_reports WHERE id=$1`, id) //nolint:errcheck
		respond(w, map[string]any{"ok": true}, "json")
	}
}

// ── loadReportSpec resolves a saved report to (dataset, spec, name) ──────────────

func loadReportSpec(ctx context.Context, db *core.DB, id string, u *core.Claims) (exportDataset, pivotSpec, string, int, error) {
	rows, err := db.PGQuery(ctx, `SELECT name, dataset, config, is_public, created_by FROM pivot_reports WHERE id=$1`, id)
	if err != nil || len(rows) == 0 {
		return exportDataset{}, pivotSpec{}, "", 404, fmt.Errorf("Report not found")
	}
	rep := rows[0]
	isPublic, _ := rep["is_public"].(bool)
	if !isPublic && u != nil && toInt64(rep["created_by"]) != u.ID {
		return exportDataset{}, pivotSpec{}, "", 403, fmt.Errorf("Not authorised")
	}
	d, ok := exportDatasetByKey(str(rep["dataset"]))
	if !ok {
		return exportDataset{}, pivotSpec{}, "", 422, fmt.Errorf("This report's data source no longer exists")
	}
	cfg := parseSavedConfig(rep["config"])
	return d, cfg.toSpec(time.Now()), str(rep["name"]), 200, nil
}

// ── Export (download) ───────────────────────────────────────────────────────────

func savedExportReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		format, ok := parseExportFormat(r.URL.Query().Get("format"))
		if !ok {
			respondErr(w, 422, "Unsupported format (use csv, xlsx or json)")
			return
		}
		d, spec, name, code, err := loadReportSpec(ctx, db, id, core.UserFromCtx(ctx))
		if err != nil {
			respondErr(w, code, err.Error())
			return
		}
		res, err := runPivot(ctx, db, d, spec)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		cols := pivotExportCols(res)
		if name == "" {
			name = "report"
		}
		filename := exportFilename(name, format)
		logBIExport(ctx, db, r, name, d.Key, format, len(res.Rows))
		if err := writeExport(w, format, filename, cols, res.Rows); err != nil {
			slog.Error("savedExportReport write", "id", id, "err", err)
		}
	}
}

// ── Email ───────────────────────────────────────────────────────────────────────

func savedEmailReport(db *core.DB) http.HandlerFunc {
	type body struct {
		Recipients []string `json:"recipients"`
		Format     string   `json:"format"`
		Message    string   `json:"message"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		to := cleanRecipients(b.Recipients)
		if len(to) == 0 {
			respondErr(w, 400, "Add at least one valid recipient email")
			return
		}
		d, spec, name, code, err := loadReportSpec(ctx, db, id, core.UserFromCtx(ctx))
		if err != nil {
			respondErr(w, code, err.Error())
			return
		}
		res, err := runPivot(ctx, db, d, spec)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		sent, err := emailPivotReport(ctx, db, r, name, d.Key, res, to, b.Format, b.Message)
		if err != nil {
			respondErrLog(w, 502, "Could not send the report", err)
			return
		}
		respond(w, map[string]any{"ok": true, "recipients": sent, "rows": len(res.Rows)}, "json")
	}
}

// savedEmailAdhoc emails a report straight from the builder without saving it —
// so "email me this" works before a report has a name.
func savedEmailAdhoc(db *core.DB) http.HandlerFunc {
	type body struct {
		Name       string            `json:"name"`
		Dataset    string            `json:"dataset"`
		Rows       []string          `json:"rows"`
		Cols       []string          `json:"cols"`
		Values     []pivotValue      `json:"values"`
		Filters    map[string]string `json:"filters"`
		ColFilters []colFilter       `json:"col_filters"`
		Grains     map[string]string `json:"grains"`
		DateWindow string            `json:"date_window"`
		DateFrom   string            `json:"date_from"`
		DateTo     string            `json:"date_to"`
		Recipients []string          `json:"recipients"`
		Format     string            `json:"format"`
		Message    string            `json:"message"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		to := cleanRecipients(b.Recipients)
		if len(to) == 0 {
			respondErr(w, 400, "Add at least one valid recipient email")
			return
		}
		d, ok := exportDatasetByKey(b.Dataset)
		if !ok {
			respondErr(w, 422, "Unknown data source")
			return
		}
		cfg := savedPivotConfig{
			Rows: b.Rows, Cols: b.Cols, Values: b.Values, Filters: b.Filters, ColFilters: b.ColFilters, Grains: b.Grains,
			DateWindow: b.DateWindow, DateFrom: b.DateFrom, DateTo: b.DateTo,
		}
		res, err := runPivot(ctx, db, d, cfg.toSpec(time.Now()))
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		name := strings.TrimSpace(b.Name)
		if name == "" {
			name = d.Label + " report"
		}
		sent, err := emailPivotReport(ctx, db, r, name, d.Key, res, to, b.Format, b.Message)
		if err != nil {
			respondErrLog(w, 502, "Could not send the report", err)
			return
		}
		respond(w, map[string]any{"ok": true, "recipients": sent, "rows": len(res.Rows)}, "json")
	}
}

// ── File + email helpers ─────────────────────────────────────────────────────────

// pivotExportCols flattens a pivot result to ordered export columns: dimensions
// first (as text), then measures with their display type so kobo/pct/money format
// correctly in the file.
func pivotExportCols(res pivotResult) []exportCol {
	cols := make([]exportCol, 0, len(res.Dims)+len(res.Meas))
	for _, dm := range res.Dims {
		cols = append(cols, exportCol{Key: dm.Key, Label: dm.Label, Type: colText})
	}
	for _, ms := range res.Meas {
		cols = append(cols, exportCol{Key: ms.Key, Label: ms.Label, Type: exportColType(ms.Type)})
	}
	return cols
}

// emailFormat clamps the requested format to what makes sense as a mail
// attachment (a spreadsheet), defaulting to xlsx.
func emailFormat(s string) exportFormat {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "csv":
		return fmtCSV
	}
	return fmtXLSX
}

func renderPivotBytes(res pivotResult, format exportFormat) ([]byte, error) {
	var buf bytes.Buffer
	cols := pivotExportCols(res)
	var err error
	switch format {
	case fmtCSV:
		err = writeExportCSV(&buf, cols, res.Rows)
	default:
		err = writeExportXLSX(&buf, cols, res.Rows)
	}
	return buf.Bytes(), err
}

// pivotHTMLTable renders up to `limit` rows as an inline HTML table so the
// recipient sees the figures in the mail body, with the full set attached.
func pivotHTMLTable(res pivotResult, limit int) string {
	cols := pivotExportCols(res)
	var b strings.Builder
	b.WriteString(`<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px;margin-top:8px">`)
	b.WriteString(`<thead><tr>`)
	for _, c := range cols {
		b.WriteString(`<th style="text-align:left;padding:6px 12px;border-bottom:2px solid #0E2841;color:#0E2841;white-space:nowrap">` + html.EscapeString(c.Label) + `</th>`)
	}
	b.WriteString(`</tr></thead><tbody>`)
	shown := 0
	for _, row := range res.Rows {
		if shown >= limit {
			break
		}
		b.WriteString(`<tr>`)
		for _, c := range cols {
			align := "left"
			if exportNumeric(c.Type) {
				align = "right"
			}
			b.WriteString(`<td style="padding:5px 12px;border-bottom:1px solid #E5E7EB;text-align:` + align + `;white-space:nowrap">` + html.EscapeString(exportValue(row[c.Key], c.Type)) + `</td>`)
		}
		b.WriteString(`</tr>`)
		shown++
	}
	b.WriteString(`</tbody></table>`)
	if len(res.Rows) > limit {
		b.WriteString(fmt.Sprintf(`<p style="font-size:12px;color:#6B7280;margin-top:6px">Showing %d of %d rows — the full report is attached.</p>`, limit, len(res.Rows)))
	}
	return b.String()
}

// emailPivotReport renders the result to a file, builds an HTML body with an
// inline preview, and sends it. Returns the number of recipients.
func emailPivotReport(ctx context.Context, db *core.DB, r *http.Request, name, dataset string, res pivotResult, recipients []string, format, message string) (int, error) {
	f := emailFormat(format)
	data, err := renderPivotBytes(res, f)
	if err != nil {
		return 0, err
	}
	to := make([]MailAddress, 0, len(recipients))
	for _, e := range recipients {
		to = append(to, MailAddress{Email: e})
	}

	var uid int64
	if u := core.UserFromCtx(ctx); u != nil {
		uid = u.ID
	}

	stamp := time.Now().In(reportTZ).Format("2006-01-02 15:04")
	safeName := html.EscapeString(name)
	intro := ""
	if strings.TrimSpace(message) != "" {
		intro = `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827">` + html.EscapeString(message) + `</p>`
	}
	htmlBody := fmt.Sprintf(`<div style="font-family:Segoe UI,Arial,sans-serif;color:#111827">`+
		`<h2 style="color:#0E2841;margin:0 0 4px">%s</h2>`+
		`<p style="font-size:13px;color:#6B7280;margin:0 0 12px">O3 Capital Workspace · generated %s · %d rows</p>`+
		`%s%s`+
		`<p style="font-size:12px;color:#9CA3AF;margin-top:16px">This report was generated from the Report Builder. The attached %s file holds the complete data.</p>`+
		`</div>`,
		safeName, stamp, len(res.Rows), intro, pivotHTMLTable(res, 100), strings.ToUpper(f.ext()))

	textBody := fmt.Sprintf("%s\n\nGenerated %s · %d rows.\nThe complete report is attached as a %s file.", name, stamp, len(res.Rows), strings.ToUpper(f.ext()))

	fname := exportFilename(name, f)
	result := SendMail(ctx, db, SendMailOptions{
		To:        to,
		Subject:   fmt.Sprintf("Report: %s (%s)", name, time.Now().In(reportTZ).Format("2006-01-02")),
		HTMLBody:  htmlBody,
		TextBody:  textBody,
		Kind:      "report",
		Category:  "pivot_report",
		CreatedBy: uid,
		Attachments: []MailAttachment{{
			Filename:    fname,
			ContentType: f.contentType(),
			Content:     base64.StdEncoding.EncodeToString(data),
			Disposition: "attachment",
		}},
	})
	if !result.OK && result.Error != "" {
		return 0, fmt.Errorf("%s", result.Error)
	}
	logBIExport(ctx, db, r, name, dataset, f, len(res.Rows))
	return len(to), nil
}

func cleanRecipients(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, e := range in {
		e = strings.TrimSpace(strings.ToLower(e))
		if e == "" || !strings.Contains(e, "@") || !strings.Contains(e, ".") || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return out
}

// ── Schedules ────────────────────────────────────────────────────────────────

func savedListSchedules(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var uid int64
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		rows, err := db.PGQuery(ctx, `
			SELECT s.id, s.report_id, p.name AS report_name, p.dataset,
			       s.frequency, s.hour, s.day_of_week, s.day_of_month,
			       s.recipients, s.format, s.is_active, s.last_run_at, s.next_run_at,
			       s.last_status, s.created_at, s.created_by,
			       u.full_name AS created_by_name
			FROM pivot_report_schedules s
			JOIN pivot_reports p ON p.id = s.report_id
			LEFT JOIN o3c_users u ON u.id = s.created_by
			WHERE p.is_public = TRUE OR p.created_by = $1 OR s.created_by = $1
			ORDER BY s.is_active DESC, s.next_run_at NULLS LAST`, uid)
		if err != nil {
			respondErrLog(w, 500, "Could not load schedules", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func savedCreateSchedule(db *core.DB) http.HandlerFunc {
	type body struct {
		Frequency  string   `json:"frequency"`
		Hour       int      `json:"hour"`
		DayOfWeek  int      `json:"day_of_week"`
		DayOfMonth int      `json:"day_of_month"`
		Recipients []string `json:"recipients"`
		Format     string   `json:"format"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")

		exists, _ := db.PGQuery(ctx, `SELECT created_by, is_public FROM pivot_reports WHERE id=$1`, id)
		if len(exists) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		isPublic, _ := exists[0]["is_public"].(bool)
		if !isPublic && u != nil && toInt64(exists[0]["created_by"]) != u.ID {
			respondErr(w, 403, "Not your report")
			return
		}

		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		to := cleanRecipients(b.Recipients)
		if len(to) == 0 {
			respondErr(w, 400, "Add at least one valid recipient email")
			return
		}
		freq := b.Frequency
		if freq != "weekly" && freq != "monthly" {
			freq = "daily"
		}
		if b.Hour < 0 || b.Hour > 23 {
			b.Hour = 7
		}
		f := string(emailFormat(b.Format))
		recip, _ := json.Marshal(to)
		next := nextReportRun(freq, b.Hour, b.DayOfWeek, b.DayOfMonth, time.Now())

		var uid any
		if u != nil {
			uid = u.ID
		}
		rows, err := db.PGQuery(ctx, `
			INSERT INTO pivot_report_schedules
				(report_id, frequency, hour, day_of_week, day_of_month, recipients, format, next_run_at, created_by)
			VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
			RETURNING id, report_id, frequency, hour, day_of_week, day_of_month, recipients, format, is_active, next_run_at, created_at`,
			id, freq, b.Hour, b.DayOfWeek, b.DayOfMonth, string(recip), f, next, uid)
		if err != nil {
			respondErrLog(w, 500, "Could not create the schedule", err)
			return
		}
		respond(w, rows[0], "pg")
	}
}

func savedUpdateSchedule(db *core.DB) http.HandlerFunc {
	type body struct {
		IsActive   *bool     `json:"is_active"`
		Frequency  *string   `json:"frequency"`
		Hour       *int      `json:"hour"`
		DayOfWeek  *int      `json:"day_of_week"`
		DayOfMonth *int      `json:"day_of_month"`
		Recipients *[]string `json:"recipients"`
		Format     *string   `json:"format"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		sid := chi.URLParam(r, "sid")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// Read current values so we can recompute next_run_at when timing changes.
		cur, _ := db.PGQuery(ctx, `SELECT frequency, hour, day_of_week, day_of_month FROM pivot_report_schedules WHERE id=$1`, sid)
		if len(cur) == 0 {
			respondErr(w, 404, "Schedule not found")
			return
		}
		freq := str(cur[0]["frequency"])
		hour := int(toInt64(cur[0]["hour"]))
		dow := int(toInt64(cur[0]["day_of_week"]))
		dom := int(toInt64(cur[0]["day_of_month"]))

		set := "id=id"
		args := []any{}
		n := 1
		add := func(col string, val any) {
			set += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, val)
			n++
		}
		timingChanged := false
		if b.IsActive != nil {
			add("is_active", *b.IsActive)
		}
		if b.Frequency != nil {
			f := *b.Frequency
			if f != "weekly" && f != "monthly" {
				f = "daily"
			}
			freq = f
			add("frequency", f)
			timingChanged = true
		}
		if b.Hour != nil {
			h := *b.Hour
			if h < 0 || h > 23 {
				h = 7
			}
			hour = h
			add("hour", h)
			timingChanged = true
		}
		if b.DayOfWeek != nil {
			dow = *b.DayOfWeek
			add("day_of_week", dow)
			timingChanged = true
		}
		if b.DayOfMonth != nil {
			dom = *b.DayOfMonth
			add("day_of_month", dom)
			timingChanged = true
		}
		if b.Recipients != nil {
			to := cleanRecipients(*b.Recipients)
			if len(to) == 0 {
				respondErr(w, 400, "Add at least one valid recipient email")
				return
			}
			recip, _ := json.Marshal(to)
			set += fmt.Sprintf(", recipients=$%d::jsonb", n)
			args = append(args, string(recip))
			n++
		}
		if b.Format != nil {
			add("format", string(emailFormat(*b.Format)))
		}
		if timingChanged {
			add("next_run_at", nextReportRun(freq, hour, dow, dom, time.Now()))
		}
		args = append(args, sid)
		if _, err := db.PGExec(ctx, fmt.Sprintf(`UPDATE pivot_report_schedules SET %s WHERE id=$%d`, set, n), args...); err != nil {
			respondErrLog(w, 500, "Could not update the schedule", err)
			return
		}
		respond(w, map[string]any{"ok": true}, "json")
	}
}

func savedDeleteSchedule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		db.PGExec(r.Context(), `DELETE FROM pivot_report_schedules WHERE id=$1`, sid) //nolint:errcheck
		respond(w, map[string]any{"ok": true}, "json")
	}
}

// nextReportRun computes the next fire time (UTC) for a schedule in Lagos time.
func nextReportRun(freq string, hour, dow, dom int, after time.Time) time.Time {
	a := after.In(reportTZ)
	if hour < 0 || hour > 23 {
		hour = 7
	}
	at := func(y int, m time.Month, d int) time.Time {
		return time.Date(y, m, d, hour, 0, 0, 0, reportTZ)
	}
	switch freq {
	case "weekly":
		if dow < 0 || dow > 6 {
			dow = 1
		}
		cand := at(a.Year(), a.Month(), a.Day())
		delta := (dow - int(cand.Weekday()) + 7) % 7
		cand = cand.AddDate(0, 0, delta)
		if !cand.After(a) {
			cand = cand.AddDate(0, 0, 7)
		}
		return cand.UTC()
	case "monthly":
		if dom < 1 || dom > 28 {
			dom = 1
		}
		cand := at(a.Year(), a.Month(), dom)
		if !cand.After(a) {
			cand = at(a.Year(), a.Month(), dom).AddDate(0, 1, 0)
		}
		return cand.UTC()
	default: // daily
		cand := at(a.Year(), a.Month(), a.Day())
		if !cand.After(a) {
			cand = cand.AddDate(0, 0, 1)
		}
		return cand.UTC()
	}
}

// ── Scheduled-delivery worker ────────────────────────────────────────────────

// StartReportScheduleWorker delivers due scheduled reports. Every minute it
// picks up schedules whose next_run_at has passed, runs the pivot live, emails
// the file to the recipients and rolls next_run_at forward. Follows the standard
// worker pattern (heartbeat + due-check + stamp), so it shows in the Sync &
// Workers hub as "report_schedules".
func StartReportScheduleWorker(db *core.DB) {
	run := func() {
		ctx := context.Background()
		WorkerBeat(ctx, db, "report_schedules", "running", "", "")
		rows, err := db.PGQuery(ctx, `
			SELECT s.id, s.report_id, s.frequency, s.hour, s.day_of_week, s.day_of_month,
			       s.recipients, s.format, p.name, p.dataset, p.config
			FROM pivot_report_schedules s
			JOIN pivot_reports p ON p.id = s.report_id
			WHERE s.is_active = TRUE AND (s.next_run_at IS NULL OR s.next_run_at <= NOW())
			ORDER BY s.next_run_at NULLS FIRST
			LIMIT 50`)
		if err != nil {
			WorkerBeat(ctx, db, "report_schedules", "error", "", err.Error())
			return
		}
		sent := 0
		for _, s := range rows {
			schedID := toInt64(s["id"])
			status := deliverScheduledReport(ctx, db, s)
			next := nextReportRun(str(s["frequency"]), int(toInt64(s["hour"])), int(toInt64(s["day_of_week"])), int(toInt64(s["day_of_month"])), time.Now())
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE pivot_report_schedules SET last_run_at=NOW(), next_run_at=$2, last_status=$3 WHERE id=$1`,
				schedID, next, status)
			if strings.HasPrefix(status, "sent") {
				sent++
			}
		}
		WorkerBeat(ctx, db, "report_schedules", "ok", fmt.Sprintf("%d delivered", sent), "")
	}
	run()
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

// deliverScheduledReport runs and emails one schedule row, returning a short
// status string stored on the schedule for the UI.
func deliverScheduledReport(ctx context.Context, db *core.DB, s core.Row) string {
	d, ok := exportDatasetByKey(str(s["dataset"]))
	if !ok {
		return "error: data source missing"
	}
	cfg := parseSavedConfig(s["config"])
	res, err := runPivot(ctx, db, d, cfg.toSpec(time.Now()))
	if err != nil {
		return "error: " + err.Error()
	}
	var recipients []string
	json.Unmarshal(jsonBytes(s["recipients"]), &recipients) //nolint:errcheck
	to := cleanRecipients(recipients)
	if len(to) == 0 {
		return "error: no recipients"
	}
	n, err := emailPivotReport(ctx, db, nil, str(s["name"]), d.Key, res, to, str(s["format"]), "")
	if err != nil {
		return "error: " + err.Error()
	}
	slog.Info("scheduled report delivered", "report", str(s["name"]), "recipients", n, "rows", len(res.Rows))
	return fmt.Sprintf("sent to %d · %d rows", n, len(res.Rows))
}
