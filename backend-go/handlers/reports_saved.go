package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"sort"
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
	DimLabels  map[string]string `json:"dim_labels,omitempty"` // row/col column key → display override
	DateWindow string            `json:"date_window"`          // "" | custom | today | last_7_days | ...
	DateFrom   string            `json:"date_from"`
	DateTo     string            `json:"date_to"`
	Chart      json.RawMessage   `json:"chart,omitempty"` // view prefs; opaque to the server

	// View is "table" (one line per record) or "summary" (the pivot). Reports saved
	// before Table view existed have no view, and are summaries.
	View         string            `json:"view,omitempty"`
	Columns      []tableColumn     `json:"columns,omitempty"`       // Table: ordered columns and their names
	Totals       []string          `json:"totals,omitempty"`        // Table: column keys that show a total
	Sort         []reportSort      `json:"sort,omitempty"`          // Table: field keys; Summary: matrix column ids
	HeaderLabels map[string]string `json:"header_labels,omitempty"` // Summary: matrix column id → name
	HiddenCols   []string          `json:"hidden_cols,omitempty"`   // Summary: matrix column ids not shown
	TopN         *pivotTopN        `json:"top_n,omitempty"`         // Summary: keep the N biggest groups
}

// toTableSpec resolves a Table report's definition, with its date window rolled forward
// like toSpec's.
func (c savedPivotConfig) toTableSpec(now time.Time) tableSpec {
	s := c.toSpec(now)
	return tableSpec{DateFrom: s.DateFrom, DateTo: s.DateTo, Filters: c.Filters, ColFilters: c.ColFilters, Columns: c.Columns, Sort: c.Sort}
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
	return pivotSpec{DateFrom: from, DateTo: to, Filters: c.Filters, ColFilters: c.ColFilters, Rows: c.Rows, Cols: c.Cols, Values: c.Values, Grains: c.Grains, DimLabels: c.DimLabels, TopN: c.TopN}
}

// resolveReportWindow turns a named relative window into concrete YYYY-MM-DD
// bounds in Lagos time. Kept in lockstep with resolveWindow() in the frontend.
func resolveReportWindow(window string, now time.Time) (string, string) {
	n := now.In(reportTZ)
	today := time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, reportTZ)
	d := func(t time.Time) string { return t.Format("2006-01-02") }
	// Weeks start on Monday. A report scheduled for Monday morning on last_work_week
	// covers the Monday to Friday just gone.
	monday := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	switch window {
	case "today":
		return d(today), d(today)
	case "yesterday":
		y := today.AddDate(0, 0, -1)
		return d(y), d(y)
	case "this_week":
		return d(monday), d(today)
	case "last_week":
		start := monday.AddDate(0, 0, -7)
		return d(start), d(start.AddDate(0, 0, 6))
	case "last_work_week":
		start := monday.AddDate(0, 0, -7)
		return d(start), d(start.AddDate(0, 0, 4))
	case "last_quarter":
		q := (int(n.Month()) - 1) / 3
		start := time.Date(n.Year(), time.Month(q*3+1), 1, 0, 0, 0, 0, reportTZ)
		return d(start.AddDate(0, -3, 0)), d(start.AddDate(0, 0, -1))
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
	// Open to BI ("reports") and to department supervisors ("report_builder"). What a
	// supervisor reaches inside is decided per data source — see report_access.go.
	rd := core.RequirePages("reports", "report_builder")

	r.With(rd).Get("/saved", savedListReports(db))
	r.With(rd).Post("/saved", savedCreateReport(db))
	r.With(rd).Get("/saved/{id}", savedGetReport(db))
	r.With(rd).Put("/saved/{id}", savedUpdateReport(db))
	r.With(rd).Delete("/saved/{id}", savedDeleteReport(db))
	r.With(rd).Post("/saved/{id}/export", savedExportReport(db)) // ?format=csv|xlsx|json
	r.With(rd).Post("/saved/{id}/email", savedEmailReport(db))
	r.With(rd).Post("/pivot-email", savedEmailAdhoc(db)) // email an unsaved config
	r.With(rd).Post("/report-file", reportFile(db))      // ?format=xlsx|csv|json — the open report as a file

	r.With(rd).Get("/schedules", savedListSchedules(db))
	r.With(rd).Post("/saved/{id}/schedule", savedCreateSchedule(db))
	r.With(rd).Put("/schedules/{sid}", savedUpdateSchedule(db))
	r.With(rd).Delete("/schedules/{sid}", savedDeleteSchedule(db))
	r.With(rd).Post("/schedules/{sid}/run-now", savedRunScheduleNow(db))

	r.With(rd).Get("/my-dashboard", savedMyDashboard(db))
}

// savedMyDashboard is the analyst's station over the pivot Report Builder: their
// saved reports, active/due schedules, recent delivery health and upcoming runs.
//
// Everything on it is limited to what this person can see: their own reports and
// shared ones, on data sources their departments cover, plus schedules they set up.
// It used to count and list every schedule in the table, which put other people's
// private report names on screen.
func savedMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		var uid int64
		if u != nil {
			uid = u.ID
		}

		reports, _ := db.PGQuery(ctx, `
			SELECT id, name, dataset, is_public, created_by, updated_at
			FROM pivot_reports
			WHERE created_by = $1 OR is_public
			ORDER BY updated_at DESC`, uid)
		visible := map[int64]bool{}
		myCount, sharedCount := 0, 0
		myList := []core.Row{}
		for _, p := range reports {
			if !reportDatasetAllowed(u, str(p["dataset"])) {
				continue
			}
			visible[toInt64(p["id"])] = true
			if toInt64(p["created_by"]) == uid {
				myCount++
				if len(myList) < 8 {
					myList = append(myList, p)
				}
			}
			if shared, _ := p["is_public"].(bool); shared {
				sharedCount++
			}
		}

		all, _ := db.PGQuery(ctx, `
			SELECT s.report_id, s.created_by, s.frequency, s.hour, s.day_of_week, s.day_of_month,
			       s.next_run_at, s.last_run_at, s.last_status, s.format, s.is_active,
			       p.name AS report_name, p.dataset
			FROM pivot_report_schedules s
			JOIN pivot_reports p ON p.id = s.report_id`)
		now := time.Now()
		today := now.In(reportTZ).Format("2006-01-02")
		var (
			scheduled                           []core.Row
			active, due, deliveredToday, failed int
			nextRun                             *time.Time
		)
		for _, s := range all {
			setUpByMe := toInt64(s["created_by"]) == uid && reportDatasetAllowed(u, str(s["dataset"]))
			if !visible[toInt64(s["report_id"])] && !setUpByMe {
				continue
			}
			scheduled = append(scheduled, s)
			next, hasNext := s["next_run_at"].(time.Time)
			last, hasLast := s["last_run_at"].(time.Time)
			status := str(s["last_status"])
			if on, _ := s["is_active"].(bool); on {
				active++
				if hasNext && !next.After(now) {
					due++
				}
				if hasNext && next.After(now) && (nextRun == nil || next.Before(*nextRun)) {
					n := next
					nextRun = &n
				}
			}
			if hasLast && strings.HasPrefix(status, "sent") && last.In(reportTZ).Format("2006-01-02") == today {
				deliveredToday++
			}
			if hasLast && strings.HasPrefix(status, "error") && now.Sub(last) <= 7*24*time.Hour {
				failed++
			}
		}

		upcoming := []core.Row{}
		recent := []core.Row{}
		for _, s := range scheduled {
			if on, _ := s["is_active"].(bool); on {
				upcoming = append(upcoming, s)
			}
			if _, ok := s["last_run_at"].(time.Time); ok {
				recent = append(recent, s)
			}
		}
		sort.SliceStable(upcoming, func(i, j int) bool {
			a, aok := upcoming[i]["next_run_at"].(time.Time)
			b, bok := upcoming[j]["next_run_at"].(time.Time)
			if aok != bok {
				return aok // unscheduled runs go last
			}
			return aok && a.Before(b)
		})
		sort.SliceStable(recent, func(i, j int) bool {
			return recent[i]["last_run_at"].(time.Time).After(recent[j]["last_run_at"].(time.Time))
		})
		if len(upcoming) > 8 {
			upcoming = upcoming[:8]
		}
		if len(recent) > 8 {
			recent = recent[:8]
		}

		dash := map[string]any{
			"my_reports":         myCount,
			"shared_reports":     sharedCount,
			"scheduled_active":   active,
			"scheduled_due":      due,
			"delivered_today":    deliveredToday,
			"failed_recent":      failed,
			"upcoming_schedules": upcoming,
			"recent_deliveries":  recent,
			"my_report_list":     myList,
		}
		if nextRun != nil {
			dash["next_scheduled_at"] = *nextRun
		}
		respond(w, dash, "pg")
	}
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

func savedListReports(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		var uid int64
		if u != nil {
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
		visibleRows := make([]core.Row, 0, len(rows))
		for _, row := range rows {
			// A shared report on another department's data is not this person's to run.
			if reportDatasetAllowed(u, str(row["dataset"])) {
				visibleRows = append(visibleRows, row)
			}
		}
		respond(w, visibleRows, "pg")
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
		if !reportDatasetAllowed(u, str(rep["dataset"])) {
			respondErr(w, 403, reportDatasetDenied)
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
		if !reportDatasetAllowed(u, b.Dataset) {
			respondErr(w, 403, reportDatasetDenied)
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
		existing, _ := db.PGQuery(ctx, `SELECT created_by, dataset FROM pivot_reports WHERE id=$1`, id)
		if len(existing) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		if !canManageReportItem(u, toInt64(existing[0]["created_by"])) {
			respondErr(w, 403, "Only the person who made this report can change it. Save a copy instead.")
			return
		}
		if !reportDatasetAllowed(u, str(existing[0]["dataset"])) {
			respondErr(w, 403, reportDatasetDenied)
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
		if !canManageReportItem(u, toInt64(existing[0]["created_by"])) {
			respondErr(w, 403, "Only the person who made this report can delete it")
			return
		}
		db.PGExec(ctx, `DELETE FROM pivot_reports WHERE id=$1`, id) //nolint:errcheck
		respond(w, map[string]any{"ok": true}, "json")
	}
}

// ── loadReportSpec resolves a saved report to (dataset, spec, name) ──────────────

func loadReportSpec(ctx context.Context, db *core.DB, id string, u *core.Claims) (exportDataset, savedPivotConfig, string, int, error) {
	rows, err := db.PGQuery(ctx, `SELECT name, dataset, config, is_public, created_by FROM pivot_reports WHERE id=$1`, id)
	if err != nil || len(rows) == 0 {
		return exportDataset{}, savedPivotConfig{}, "", 404, fmt.Errorf("Report not found")
	}
	rep := rows[0]
	isPublic, _ := rep["is_public"].(bool)
	if !isPublic && u != nil && toInt64(rep["created_by"]) != u.ID {
		return exportDataset{}, savedPivotConfig{}, "", 403, fmt.Errorf("Not authorised")
	}
	if !reportDatasetAllowed(u, str(rep["dataset"])) {
		return exportDataset{}, savedPivotConfig{}, "", 403, fmt.Errorf("%s", reportDatasetDenied)
	}
	d, ok := exportDatasetByKey(str(rep["dataset"]))
	if !ok {
		return exportDataset{}, savedPivotConfig{}, "", 422, fmt.Errorf("This report's data source no longer exists")
	}
	return d, parseSavedConfig(rep["config"]), str(rep["name"]), 200, nil
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
		u := core.UserFromCtx(ctx)
		d, cfg, name, code, err := loadReportSpec(ctx, db, id, u)
		if err != nil {
			respondErr(w, code, err.Error())
			return
		}
		rep, err := renderReport(ctx, db, d, cfg, time.Now(), d.maxRows())
		if err != nil {
			respondReportErr(w, err)
			return
		}
		if name == "" {
			name = "report"
		}
		filename := exportFilename(name, format)
		if rep.Truncated {
			w.Header().Set("X-Export-Truncated", "true")
		}
		logBIExport(ctx, db, r, name, d.Key, format, rep.RecordCount())
		if err := writeExport(w, format, filename, rep.Cols, rep.Rows); err != nil {
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
		u := core.UserFromCtx(ctx)
		if bad := reportRecipientsNotAllowed(ctx, db, u, to); len(bad) > 0 {
			respondErr(w, 422, reportRecipientsDeniedMessage(bad))
			return
		}
		d, cfg, name, code, err := loadReportSpec(ctx, db, id, u)
		if err != nil {
			respondErr(w, code, err.Error())
			return
		}
		rep, err := renderReport(ctx, db, d, cfg, time.Now(), d.maxRows())
		if err != nil {
			respondReportErr(w, err)
			return
		}
		sent, err := emailReport(ctx, db, r, name, d.Key, rep, to, b.Format, b.Message)
		if err != nil {
			var big reportTooBig
			if errors.As(err, &big) {
				respondErr(w, 422, big.Error())
				return
			}
			respondErrLog(w, 502, "Could not send the report", err)
			return
		}
		respond(w, map[string]any{"ok": true, "recipients": sent, "rows": rep.RecordCount(), "truncated": rep.Truncated}, "json")
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
		DimLabels  map[string]string `json:"dim_labels,omitempty"`
		DateWindow string            `json:"date_window"`
		DateFrom   string            `json:"date_from"`
		DateTo     string            `json:"date_to"`
		Recipients []string          `json:"recipients"`
		Format     string            `json:"format"`
		Message    string            `json:"message"`
		// Config is the whole report definition, as the builder sends it now. A tab
		// opened before Table view sends the Summary fields above instead.
		Config *savedPivotConfig `json:"config"`
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
		u := core.UserFromCtx(ctx)
		if !reportDatasetAllowed(u, b.Dataset) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}
		if bad := reportRecipientsNotAllowed(ctx, db, u, to); len(bad) > 0 {
			respondErr(w, 422, reportRecipientsDeniedMessage(bad))
			return
		}
		cfg := savedPivotConfig{
			Rows: b.Rows, Cols: b.Cols, Values: b.Values, Filters: b.Filters, ColFilters: b.ColFilters, Grains: b.Grains, DimLabels: b.DimLabels,
			DateWindow: b.DateWindow, DateFrom: b.DateFrom, DateTo: b.DateTo,
		}
		if b.Config != nil {
			cfg = *b.Config
		}
		rep, err := renderReport(ctx, db, d, cfg, time.Now(), d.maxRows())
		if err != nil {
			respondReportErr(w, err)
			return
		}
		name := strings.TrimSpace(b.Name)
		if name == "" {
			name = d.Label + " report"
		}
		sent, err := emailReport(ctx, db, r, name, d.Key, rep, to, b.Format, b.Message)
		if err != nil {
			var big reportTooBig
			if errors.As(err, &big) {
				respondErr(w, 422, big.Error())
				return
			}
			respondErrLog(w, 502, "Could not send the report", err)
			return
		}
		respond(w, map[string]any{"ok": true, "recipients": sent, "rows": rep.RecordCount(), "truncated": rep.Truncated}, "json")
	}
}

// ── File + email helpers ─────────────────────────────────────────────────────────

// reportTooBig marks a report that rendered fine but is too large to leave as a mail
// attachment. The email handlers turn it into a 422 the sender can act on; without it
// the provider's rejection arrives as a bare "Could not send the report".
type reportTooBig struct{ msg string }

func (e reportTooBig) Error() string { return e.msg }

// reportMailMaxBytes is the most attachment one message may carry. The provider rejects
// a message over 30MB measured AFTER base64 (+33%), so guard the encoded size and leave
// room for the body. Reports only reach this size because files are no longer capped at
// 5,000 records; a download has no such limit.
const reportMailMaxBytes = 20 << 20

// emailFormat clamps the requested format to what makes sense as a mail
// attachment (a spreadsheet), defaulting to xlsx.
func emailFormat(s string) exportFormat {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "csv":
		return fmtCSV
	}
	return fmtXLSX
}

func renderReportBytes(rep renderedReport, format exportFormat) ([]byte, error) {
	var buf bytes.Buffer
	var err error
	switch format {
	case fmtCSV:
		err = writeExportCSV(&buf, rep.Cols, rep.Rows)
	default:
		err = writeExportXLSX(&buf, rep.Cols, rep.Rows)
	}
	return buf.Bytes(), err
}

// reportHTMLTable renders up to `limit` rows as an inline HTML table so the
// recipient sees the figures in the mail body, with the full set attached.
func reportHTMLTable(cols []exportCol, rows []map[string]any, limit int) string {
	var b strings.Builder
	b.WriteString(`<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px;margin-top:8px">`)
	b.WriteString(`<thead><tr>`)
	for _, c := range cols {
		b.WriteString(`<th style="text-align:left;padding:6px 12px;border-bottom:2px solid #0E2841;color:#0E2841;white-space:nowrap">` + html.EscapeString(c.Label) + `</th>`)
	}
	b.WriteString(`</tr></thead><tbody>`)
	shown := 0
	for _, row := range rows {
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
	if len(rows) > limit {
		b.WriteString(fmt.Sprintf(`<p style="font-size:12px;color:#6B7280;margin-top:6px">Showing %d of %d rows. The full report is attached.</p>`, limit, len(rows)))
	}
	return b.String()
}

// emailReport writes a rendered report to a file, builds an HTML body with an inline
// preview, and sends it. Returns the number of recipients.
func emailReport(ctx context.Context, db *core.DB, r *http.Request, name, dataset string, rep renderedReport, recipients []string, format, message string) (int, error) {
	f := emailFormat(format)
	data, err := renderReportBytes(rep, f)
	if err != nil {
		return 0, err
	}
	if enc := base64.StdEncoding.EncodedLen(len(data)); enc > reportMailMaxBytes {
		return 0, reportTooBig{fmt.Sprintf(
			"This report is too large to email: %d records come to %d MB attached, and a message can carry %d MB. Download it instead, or add a filter to narrow it down.",
			rep.RecordCount(), enc>>20, reportMailMaxBytes>>20)}
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
	fileNote := fmt.Sprintf("The attached %s file holds the complete report.", strings.ToUpper(f.ext()))
	if rep.Truncated {
		// The number actually attached: a Summary can stop at its line limit before the file cap.
		unit := "records"
		if rep.Summary {
			unit = "lines"
		}
		fileNote = fmt.Sprintf("The attached %s file holds the first %d %s; the report has more.", strings.ToUpper(f.ext()), rep.RecordCount(), unit)
	}
	htmlBody := fmt.Sprintf(`<div style="font-family:Segoe UI,Arial,sans-serif;color:#111827">`+
		`<h2 style="color:#0E2841;margin:0 0 4px">%s</h2>`+
		`<p style="font-size:13px;color:#6B7280;margin:0 0 12px">O3 Capital Workspace · generated %s · %d rows</p>`+
		`%s%s`+
		`<p style="font-size:12px;color:#9CA3AF;margin-top:16px">This report was generated from the Report Builder. %s</p>`+
		`</div>`,
		safeName, stamp, rep.RecordCount(), intro, reportHTMLTable(rep.Cols, rep.Rows, 100), html.EscapeString(fileNote))

	textBody := fmt.Sprintf("%s\n\nGenerated %s · %d rows.\n%s", name, stamp, rep.RecordCount(), fileNote)

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
	logBIExport(ctx, db, r, name, dataset, f, rep.RecordCount())
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
		u := core.UserFromCtx(ctx)
		var uid int64
		if u != nil {
			uid = u.ID
		}
		rows, err := db.PGQuery(ctx, `
			SELECT s.id, s.report_id, p.name AS report_name, p.dataset,
			       s.frequency, s.hour, s.day_of_week, s.day_of_month,
			       s.recipients, s.format, s.is_active, s.last_run_at, s.next_run_at,
			       s.last_status, s.created_at, s.created_by, p.created_by AS report_created_by,
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
		visibleRows := make([]core.Row, 0, len(rows))
		for _, row := range rows {
			if !reportDatasetAllowed(u, str(row["dataset"])) {
				continue
			}
			// Tells the page whether to offer edit, pause, send-now and delete. A schedule is
			// managed by the person who set it up: they chose its recipients and it sends
			// with their access.
			canManage := canManageReportItem(u, scheduleOwnerID(row["created_by"], row["report_created_by"]))
			row["can_manage"] = canManage
			if !canManage {
				// Someone else's recipients and send errors are theirs to see.
				row["recipients"] = []string{}
				if strings.HasPrefix(str(row["last_status"]), "error") {
					row["last_status"] = "error"
				}
			}
			visibleRows = append(visibleRows, row)
		}
		respond(w, visibleRows, "pg")
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

		exists, _ := db.PGQuery(ctx, `SELECT created_by, is_public, dataset FROM pivot_reports WHERE id=$1`, id)
		if len(exists) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		isPublic, _ := exists[0]["is_public"].(bool)
		if !isPublic && u != nil && toInt64(exists[0]["created_by"]) != u.ID {
			respondErr(w, 403, "Not your report")
			return
		}
		if !reportDatasetAllowed(u, str(exists[0]["dataset"])) {
			respondErr(w, 403, reportDatasetDenied)
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
		if bad := reportRecipientsNotAllowed(ctx, db, u, to); len(bad) > 0 {
			respondErr(w, 422, reportRecipientsDeniedMessage(bad))
			return
		}
		freq := b.Frequency
		if freq != "weekly" && freq != "monthly" {
			freq = "daily"
		}
		if b.Hour < 0 || b.Hour > 23 {
			b.Hour = 7
		}
		// Stored as they will run, so the Schedules tab never shows a day that isn't used.
		if b.DayOfWeek < 0 || b.DayOfWeek > 6 {
			b.DayOfWeek = 1
		}
		if b.DayOfMonth < 1 || b.DayOfMonth > 28 {
			b.DayOfMonth = 1
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
		cur, _ := db.PGQuery(ctx, `
			SELECT s.frequency, s.hour, s.day_of_week, s.day_of_month,
			       s.created_by, p.created_by AS report_created_by, p.dataset
			FROM pivot_report_schedules s JOIN pivot_reports p ON p.id = s.report_id
			WHERE s.id=$1`, sid)
		if len(cur) == 0 {
			respondErr(w, 404, "Schedule not found")
			return
		}
		u := core.UserFromCtx(ctx)
		if !canManageReportItem(u, scheduleOwnerID(cur[0]["created_by"], cur[0]["report_created_by"])) {
			respondErr(w, 403, "Only the person who set up this schedule can change it")
			return
		}
		if !reportDatasetAllowed(u, str(cur[0]["dataset"])) {
			respondErr(w, 403, reportDatasetDenied)
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
			// A resumed schedule waits for its next slot instead of sending at once for the
			// slot it missed while paused.
			if *b.IsActive {
				timingChanged = true
			}
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
			if dow < 0 || dow > 6 {
				dow = 1
			}
			add("day_of_week", dow)
			timingChanged = true
		}
		if b.DayOfMonth != nil {
			dom = *b.DayOfMonth
			if dom < 1 || dom > 28 {
				dom = 1
			}
			add("day_of_month", dom)
			timingChanged = true
		}
		if b.Recipients != nil {
			to := cleanRecipients(*b.Recipients)
			if len(to) == 0 {
				respondErr(w, 400, "Add at least one valid recipient email")
				return
			}
			if bad := reportRecipientsNotAllowed(ctx, db, u, to); len(bad) > 0 {
				respondErr(w, 422, reportRecipientsDeniedMessage(bad))
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
		cur, _ := db.PGQuery(r.Context(), `
			SELECT s.created_by, p.created_by AS report_created_by
			FROM pivot_report_schedules s JOIN pivot_reports p ON p.id = s.report_id
			WHERE s.id=$1`, sid)
		if len(cur) == 0 {
			respondErr(w, 404, "Schedule not found")
			return
		}
		if !canManageReportItem(core.UserFromCtx(r.Context()), scheduleOwnerID(cur[0]["created_by"], cur[0]["report_created_by"])) {
			respondErr(w, 403, "Only the person who set up this schedule can delete it")
			return
		}
		db.PGExec(r.Context(), `DELETE FROM pivot_report_schedules WHERE id=$1`, sid) //nolint:errcheck
		respond(w, map[string]any{"ok": true}, "json")
	}
}

// savedRunScheduleNow delivers a schedule immediately, on demand — so an analyst
// can confirm a schedule looks right without waiting for its next_run_at. It
// records the attempt (last_run_at/last_status) like a real run but leaves
// next_run_at untouched, since a manual test shouldn't shift the cadence.
func savedRunScheduleNow(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		sid := chi.URLParam(r, "sid")
		rows, err := db.PGQuery(ctx, `
			SELECT s.id, s.report_id, s.recipients, s.format, p.name, p.dataset, p.config, p.is_public, p.created_by,
			       p.created_by AS report_created_by, s.created_by AS sched_created_by,
			       COALESCE(s.created_by, p.created_by) AS owner_id
			FROM pivot_report_schedules s JOIN pivot_reports p ON p.id = s.report_id
			WHERE s.id=$1`, sid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Schedule not found")
			return
		}
		s := rows[0]
		// Sending now mails the recipients, so it is for the person who set up the schedule
		// (and admin), not everyone who can see a shared report or the report's owner.
		if !canManageReportItem(u, scheduleOwnerID(s["sched_created_by"], s["created_by"])) {
			respondErr(w, 403, "Only the person who set up this schedule can send it now")
			return
		}
		if !reportDatasetAllowed(u, str(s["dataset"])) {
			respondErr(w, 403, reportDatasetDenied)
			return
		}
		// Sent as the schedule's owner, exactly as the worker would send it.
		status := deliverScheduledReport(ctx, db, s, reportOwnerClaims(ctx, db, toInt64(s["owner_id"])))
		db.PGExec(ctx, `UPDATE pivot_report_schedules SET last_run_at=NOW(), last_status=$2 WHERE id=$1`, sid, status) //nolint:errcheck
		if strings.HasPrefix(status, "error") {
			respondErr(w, 502, status)
			return
		}
		respond(w, map[string]any{"ok": true, "status": status}, "json")
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
			       s.recipients, s.format, s.next_run_at, p.name, p.dataset, p.config,
			       p.is_public, p.created_by AS report_created_by,
			       COALESCE(s.created_by, p.created_by) AS owner_id
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
			// The next slot is counted from whichever is later, this server's clock or the
			// slot being sent, so a clock a little behind the database can't pick the same
			// slot again.
			after := time.Now()
			slot, hadSlot := s["next_run_at"].(time.Time)
			if hadSlot && slot.After(after) {
				after = slot
			}
			next := nextReportRun(str(s["frequency"]), int(toInt64(s["hour"])), int(toInt64(s["day_of_week"])), int(toInt64(s["day_of_month"])), after)
			// Claim the slot before sending. A second backend running during a restart skips
			// a slot already claimed, and a crash after the email went out doesn't send it
			// again on start-up.
			var prev any
			if hadSlot {
				prev = slot
			}
			claimed, err := db.PGQuery(ctx, `
				UPDATE pivot_report_schedules SET next_run_at = $2
				WHERE id = $1 AND is_active AND next_run_at IS NOT DISTINCT FROM $3::timestamptz
				RETURNING id`, schedID, next, prev)
			if err != nil || len(claimed) == 0 {
				continue
			}
			// A schedule runs with its owner's access as it stands today. Someone who has
			// moved department, left, or lost sight of the report must not keep mailing it
			// out, so the schedule is paused with the reason on it.
			owner := reportOwnerClaims(ctx, db, toInt64(s["owner_id"]))
			if problem := scheduleOwnerProblem(owner, s); problem != "" {
				db.PGExec(ctx, //nolint:errcheck
					`UPDATE pivot_report_schedules SET is_active=FALSE, last_run_at=NOW(), last_status=$2 WHERE id=$1`,
					schedID, "error: paused, "+problem)
				continue
			}
			status := deliverScheduleSafely(ctx, db, s, owner)
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE pivot_report_schedules SET last_run_at=NOW(), last_status=$2 WHERE id=$1`,
				schedID, status)
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

// scheduleOwnerID is who a schedule sends as and who manages it: the person who set it
// up, or, for a schedule saved before that was recorded, the report's owner.
func scheduleOwnerID(schedCreatedBy, reportCreatedBy any) int64 {
	if id := toInt64(schedCreatedBy); id != 0 {
		return id
	}
	return toInt64(reportCreatedBy)
}

// scheduleOwnerProblem says why a schedule may not send as its owner today, or "" when it
// may. The owner must still be active, still reach the data source, and still be able to
// open the report: their own, a shared one, or any report for admin.
func scheduleOwnerProblem(owner *core.Claims, s core.Row) string {
	if owner == nil {
		return "the person who set this up no longer has an active account"
	}
	if !reportDatasetAllowed(owner, str(s["dataset"])) {
		return "the person who set this up no longer has access to this data"
	}
	public, _ := s["is_public"].(bool)
	if !public && owner.Role != "admin" && toInt64(s["report_created_by"]) != owner.ID {
		return "the report is no longer shared with the person who set this up"
	}
	return ""
}

// deliverScheduleSafely sends one schedule within a time limit and turns a panic into a
// failed send, so one bad report can't stop the backend and every other schedule.
func deliverScheduleSafely(ctx context.Context, db *core.DB, s core.Row, owner *core.Claims) (status string) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("scheduled report panicked", "schedule", toInt64(s["id"]), "panic", rec)
			status = "error: the report could not be built"
		}
	}()
	c, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	return deliverScheduledReport(c, db, s, owner)
}

// deliverScheduledReport runs and emails one schedule row, returning a short
// status string stored on the schedule for the UI.
//
// It sends as the schedule's owner: their current access decides which data sources it
// may read and who it may go to, so a schedule never sends what its owner could not send
// by hand.
func deliverScheduledReport(ctx context.Context, db *core.DB, s core.Row, owner *core.Claims) string {
	d, ok := exportDatasetByKey(str(s["dataset"]))
	if !ok {
		return "error: data source missing"
	}
	// Checked here as well as in the worker, so Send Now can't send a schedule whose
	// owner has lost access.
	if problem := scheduleOwnerProblem(owner, s); problem != "" {
		return "error: " + problem
	}
	var recipients []string
	json.Unmarshal(jsonBytes(s["recipients"]), &recipients) //nolint:errcheck
	to := cleanRecipients(recipients)
	if len(to) == 0 {
		return "error: no recipients"
	}
	if bad := reportRecipientsNotAllowed(ctx, db, owner, to); len(bad) > 0 {
		return "error: " + reportRecipientsDeniedMessage(bad)
	}
	rep, err := renderReport(ctx, db, d, parseSavedConfig(s["config"]), time.Now(), d.maxRows())
	if err != nil {
		return "error: " + err.Error()
	}
	n, err := emailReport(ctx, db, nil, str(s["name"]), d.Key, rep, to, str(s["format"]), "")
	if err != nil {
		return "error: " + err.Error()
	}
	slog.Info("scheduled report delivered", "report", str(s["name"]), "recipients", n, "rows", rep.RecordCount())
	return fmt.Sprintf("sent to %d · %d rows", n, rep.RecordCount())
}
