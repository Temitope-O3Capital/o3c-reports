package handlers

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterBI(r chi.Router, db *core.DB) {
	bi := core.RequirePages("reports")

	r.With(bi).Get("/reports", biListReports(db))
	r.With(bi).Post("/reports", biCreateReport(db))
	r.With(bi).Put("/reports/{id}", biUpdateReport(db))
	r.With(bi).Delete("/reports/{id}", biDeleteReport(db))
	r.With(bi).Post("/reports/preview", biPreviewReport(db)) // M13: preview without saving
	r.With(bi).Post("/reports/{id}/run", biRunReport(db))
	r.With(bi).Get("/reports/{id}/export", biExportReport(db))
	r.With(bi).Post("/reports/{id}/schedule", biScheduleReport(db))
	r.With(bi).Get("/scheduled", biListScheduled(db))
	r.With(bi).Delete("/scheduled/{sid}", biDeleteSchedule(db))
	r.With(bi).Get("/runs", biListRuns(db))
	r.With(bi).Get("/my-dashboard", biMyDashboard(db))
}

// biMyDashboard — the analyst's personal station: their saved reports, schedules
// (active / due), recent run health, and their exports. Defensive: a missing
// table simply omits that field.
func biMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var uid int64
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		dash := map[string]any{}
		scalar := func(key, sql string, args ...any) {
			rows, _ := db.PGQuery(ctx, sql, args...)
			if len(rows) > 0 {
				dash[key] = rows[0]["count"]
			}
		}

		scalar("my_reports", `SELECT COUNT(*) AS count FROM bi_report_definitions WHERE created_by=$1`, uid)
		scalar("public_reports", `SELECT COUNT(*) AS count FROM bi_report_definitions WHERE is_public=TRUE`)
		scalar("scheduled_active", `SELECT COUNT(*) AS count FROM bi_scheduled_reports WHERE is_active=TRUE`)
		scalar("scheduled_due", `SELECT COUNT(*) AS count FROM bi_scheduled_reports WHERE is_active=TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()`)
		scalar("runs_today", `SELECT COUNT(*) AS count FROM bi_report_runs WHERE started_at::date = CURRENT_DATE`)
		scalar("runs_failed_7d", `SELECT COUNT(*) AS count FROM bi_report_runs WHERE status IN ('failed','error') AND started_at >= NOW() - INTERVAL '7 days'`)
		scalar("my_exports_7d", `SELECT COUNT(*) AS count FROM report_export_log WHERE created_by=$1 AND created_at >= NOW() - INTERVAL '7 days'`, uid)

		if rows, _ := db.PGQuery(ctx, `SELECT MIN(next_run_at) AS next FROM bi_scheduled_reports WHERE is_active=TRUE AND next_run_at IS NOT NULL AND next_run_at > NOW()`); len(rows) > 0 {
			dash["next_scheduled_at"] = rows[0]["next"]
		}

		runs, _ := db.PGQuery(ctx, `
			SELECT r.status, r.row_count, r.started_at, d.name AS report_name, u.full_name AS run_by_name
			FROM bi_report_runs r
			LEFT JOIN bi_report_definitions d ON d.id = r.report_id
			LEFT JOIN o3c_users u ON u.id = r.run_by
			ORDER BY r.started_at DESC LIMIT 8`)
		if runs == nil {
			runs = []core.Row{}
		}
		dash["recent_runs"] = runs

		sched, _ := db.PGQuery(ctx, `
			SELECT s.cron_expr, s.next_run_at, s.last_run_at, d.name AS report_name
			FROM bi_scheduled_reports s
			LEFT JOIN bi_report_definitions d ON d.id = s.report_id
			WHERE s.is_active=TRUE
			ORDER BY (s.next_run_at IS NULL), s.next_run_at ASC LIMIT 8`)
		if sched == nil {
			sched = []core.Row{}
		}
		dash["upcoming_schedules"] = sched

		mine, _ := db.PGQuery(ctx, `SELECT id, name, module, is_public, updated_at FROM bi_report_definitions WHERE created_by=$1 ORDER BY updated_at DESC LIMIT 8`, uid)
		if mine == nil {
			mine = []core.Row{}
		}
		dash["my_report_list"] = mine

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(dash) //nolint:errcheck
	}
}

// ── Report Definitions ────────────────────────────────────────────────────────

func biListReports(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")

		q := `SELECT d.id, d.name, d.description, d.module, d.dimensions, d.metrics,
			       d.date_range, d.is_public, d.created_at,
			       u.full_name AS created_by_name,
			       (SELECT COUNT(*) FROM bi_report_runs WHERE report_id=d.id) AS run_count,
			       (SELECT MAX(started_at) FROM bi_report_runs WHERE report_id=d.id) AS last_run_at
			FROM bi_report_definitions d
			LEFT JOIN o3c_users u ON d.created_by = u.id
			WHERE (d.is_public=TRUE OR d.created_by=$1)`
		args := []any{user.ID}
		if from != "" {
			args = append(args, from)
			q += " AND d.created_at::date >= $" + itoa(len(args)) + "::date"
		}
		if to != "" {
			args = append(args, to)
			q += " AND d.created_at::date <= $" + itoa(len(args)) + "::date"
		}
		q += " ORDER BY d.updated_at DESC"
		rows, err := db.PGQuery(ctx, q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func biCreateReport(db *core.DB) http.HandlerFunc {
	type body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Module      string `json:"module"`
		Dimensions  any    `json:"dimensions"`
		Metrics     any    `json:"metrics"`
		Filters     any    `json:"filters"`
		DateRange   string `json:"date_range"`
		IsPublic    bool   `json:"is_public"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Name == "" || b.Module == "" {
			respondErr(w, 400, "name and module are required")
			return
		}
		if b.DateRange == "" {
			b.DateRange = "last_30_days"
		}
		dims, _ := json.Marshal(b.Dimensions)
		metrics, _ := json.Marshal(b.Metrics)
		filters, _ := json.Marshal(b.Filters)
		rows, err := db.PGQuery(ctx, `
			INSERT INTO bi_report_definitions (name, description, module, dimensions, metrics, filters, date_range, is_public, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING id, name, module, date_range, is_public, created_at`,
			b.Name, b.Description, b.Module, dims, metrics, filters, b.DateRange, b.IsPublic, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func biUpdateReport(db *core.DB) http.HandlerFunc {
	type body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Module      *string `json:"module"`
		Dimensions  any     `json:"dimensions"`
		Metrics     any     `json:"metrics"`
		Filters     any     `json:"filters"`
		DateRange   *string `json:"date_range"`
		IsPublic    *bool   `json:"is_public"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// Ownership check
		existing, _ := db.PGQuery(ctx, `SELECT created_by FROM bi_report_definitions WHERE id=$1`, id)
		if len(existing) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		if toInt64(existing[0]["created_by"]) != user.ID {
			respondErr(w, 403, "Not your report")
			return
		}

		set := "updated_at=NOW()"
		args := []any{}
		n := 1
		appendField := func(col string, val any) {
			set += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, val)
			n++
		}
		if b.Name != nil {
			appendField("name", *b.Name)
		}
		if b.Description != nil {
			appendField("description", *b.Description)
		}
		if b.Module != nil {
			appendField("module", *b.Module)
		}
		if b.DateRange != nil {
			appendField("date_range", *b.DateRange)
		}
		if b.IsPublic != nil {
			appendField("is_public", *b.IsPublic)
		}
		if b.Dimensions != nil {
			j, _ := json.Marshal(b.Dimensions)
			appendField("dimensions", j)
		}
		if b.Metrics != nil {
			j, _ := json.Marshal(b.Metrics)
			appendField("metrics", j)
		}
		if b.Filters != nil {
			j, _ := json.Marshal(b.Filters)
			appendField("filters", j)
		}

		args = append(args, id)
		_, err := db.PGExec(ctx, fmt.Sprintf(`UPDATE bi_report_definitions SET %s WHERE id=$%d`, set, n), args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respond(w, map[string]any{"ok": true}, "json")
	}
}

func biDeleteReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		existing, _ := db.PGQuery(ctx, `SELECT created_by FROM bi_report_definitions WHERE id=$1`, id)
		if len(existing) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		if toInt64(existing[0]["created_by"]) != user.ID {
			respondErr(w, 403, "Not your report")
			return
		}
		db.PGExec(ctx, `DELETE FROM bi_report_definitions WHERE id=$1`, id) //nolint:errcheck
		respond(w, map[string]any{"ok": true}, "json")
	}
}

// ── Run / Execute ─────────────────────────────────────────────────────────────

// biQueryForReport maps a report definition to executable SQL + args.
// Returns (columns, query, args, error).
func biQueryForReport(r *http.Request, def map[string]any) (string, []any, error) {
	module := str(def["module"])
	dr := str(def["date_range"])

	// Resolve date range to a WHERE clause fragment
	var dateFrom, dateTo string
	switch dr {
	case "today":
		dateFrom = "CURRENT_DATE"
		dateTo = "CURRENT_DATE"
	case "last_7_days":
		dateFrom = "(CURRENT_DATE - 7)"
		dateTo = "CURRENT_DATE"
	case "last_30_days":
		dateFrom = "(CURRENT_DATE - 30)"
		dateTo = "CURRENT_DATE"
	case "this_month":
		dateFrom = "DATE_TRUNC('month', CURRENT_DATE)"
		dateTo = "CURRENT_DATE"
	case "last_3_months":
		dateFrom = "(CURRENT_DATE - 90)"
		dateTo = "CURRENT_DATE"
	case "this_year":
		dateFrom = "DATE_TRUNC('year', CURRENT_DATE)"
		dateTo = "CURRENT_DATE"
	default:
		dateFrom = "(CURRENT_DATE - 30)"
		dateTo = "CURRENT_DATE"
	}

	// Override with explicit query params if provided
	if from := r.URL.Query().Get("from"); from != "" {
		dateFrom = "'" + from + "'::date"
	}
	if to := r.URL.Query().Get("to"); to != "" {
		dateTo = "'" + to + "'::date"
	}

	var q string
	switch module {
	case "LOS":
		q = fmt.Sprintf(`
			SELECT date_trunc('day', created_at)::date AS date,
			       stage AS dimension,
			       COUNT(*)                            AS applications,
			       COUNT(*) FILTER (WHERE stage='approved') AS approvals,
			       COALESCE(SUM(loan_amount_kobo),0)   AS disbursement_kobo
			FROM loan_applications
			WHERE created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC, 2`, dateFrom, dateTo)

	case "Collections":
		q = fmt.Sprintf(`
			SELECT date_trunc('day', created_at)::date AS date,
			       dpd_bucket                          AS dimension,
			       COUNT(*)                            AS accounts,
			       COALESCE(SUM(outstanding_kobo),0)   AS outstanding_kobo
			FROM collection_assignments
			WHERE created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "CRM":
		// Reads crm_contacts, not crm_deals.
		//
		// crm_deals is the deal-pipeline model and is empty — the workspace never
		// adopted it. The lead pipeline that sales actually works is
		// crm_contacts.lead_stage, which holds 29,663 rows (27,869 new, 1,794
		// converted). An earlier fix here corrected crm_deals' column names, which
		// made the query valid but still guaranteed an empty result.
		q = fmt.Sprintf(`
			SELECT date_trunc('day', k.created_at)::date            AS date,
			       COALESCE(NULLIF(k.lead_stage,''), 'unstaged')    AS dimension,
			       COUNT(*)                                         AS leads,
			       COUNT(*) FILTER (WHERE k.converted_at IS NOT NULL) AS converted,
			       COALESCE(SUM(k.estimated_value_kobo),0)          AS value_kobo
			FROM crm_contacts k
			WHERE k.created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "Finance":
		// `financial_transactions` does not exist in this database, so every
		// Finance report errored. The real financial activity is the CCS card
		// transaction book. Amounts there are numeric major units, not kobo, and
		// credits are stored negative — see the ledger data model.
		q = fmt.Sprintf(`
			SELECT t.txn_date                          AS date,
			       COALESCE(NULLIF(t.channel,''),'Unspecified') AS dimension,
			       COUNT(*)                            AS count,
			       COALESCE(SUM(t.amount_debit),0)     AS debit_ngn,
			       COALESCE(SUM(t.amount_credit),0)    AS credit_ngn,
			       COALESCE(SUM(t.amount),0)           AS net_ngn
			FROM app.transactions t
			WHERE t.txn_date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "Helpdesk":
		q = fmt.Sprintf(`
			SELECT date_trunc('day', created_at)::date AS date,
			       status                              AS dimension,
			       COUNT(*)                            AS tickets,
			       ROUND(AVG(csat_score::numeric), 2)  AS avg_csat
			FROM helpdesk_tickets
			WHERE created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "Campaigns":
		// Two faults here: campaign_analytics is not a table in this database,
		// and campaigns has `type`, not `campaign_type`. The send/open/click
		// counters live on the campaigns row itself.
		q = fmt.Sprintf(`
			SELECT date_trunc('day', c.created_at)::date          AS date,
			       COALESCE(NULLIF(c.type,''),'Unspecified')      AS dimension,
			       COUNT(*)                                       AS campaigns,
			       COALESCE(SUM(c.sent_count),0)                  AS sent,
			       COALESCE(SUM(c.delivered_count),0)             AS delivered,
			       COALESCE(SUM(c.open_count),0)                  AS opened,
			       COALESCE(SUM(c.click_count),0)                 AS clicked,
			       COALESCE(SUM(c.bounce_count),0)                AS bounced
			FROM campaigns c
			WHERE c.created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "Compliance":
		// `compliance_findings` does not exist; the findings table is
		// audit_findings, and it dates from created_at rather than finding_date.
		q = fmt.Sprintf(`
			SELECT date_trunc('day', f.created_at)::date              AS date,
			       COALESCE(NULLIF(f.severity,''),'Unrated')          AS dimension,
			       COUNT(*)                                           AS findings,
			       COUNT(*) FILTER (WHERE f.status = 'closed')        AS closed,
			       COUNT(*) FILTER (WHERE f.status <> 'closed'
			                         AND f.due_date < CURRENT_DATE)   AS overdue
			FROM audit_findings f
			WHERE f.created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	default:
		return "", nil, fmt.Errorf("unsupported module: %s", module)
	}

	return q, nil, nil
}

func biRunReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")

		defs, err := db.PGQuery(ctx, `SELECT * FROM bi_report_definitions WHERE id=$1`, id)
		if err != nil || len(defs) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		def := defs[0]
		isPublic, _ := def["is_public"].(bool)
		if !isPublic && toInt64(def["created_by"]) != user.ID {
			respondErr(w, 403, "Not authorised")
			return
		}

		q, _, qErr := biQueryForReport(r, def)
		if qErr != nil {
			respondErr(w, 422, qErr.Error())
			return
		}

		// Record run start
		runRows, _ := db.PGQuery(ctx,
			`INSERT INTO bi_report_runs (report_id, status, run_by) VALUES ($1,'running',$2) RETURNING id`,
			id, user.ID)

		rows, err := db.PGQuery(ctx, q)
		if err != nil {
			if len(runRows) > 0 {
				db.PGExec(ctx, //nolint:errcheck
					`UPDATE bi_report_runs SET status='failed', error_message=$1, finished_at=NOW() WHERE id=$2`,
					err.Error(), runRows[0]["id"])
			}
			respondErr(w, 500, "Query execution failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		if len(runRows) > 0 {
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE bi_report_runs SET status='completed', row_count=$1, finished_at=NOW() WHERE id=$2`,
				len(rows), runRows[0]["id"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"rows": rows, "row_count": len(rows)}) //nolint:errcheck
	}
}

// biPreviewReport runs a report definition inline without requiring a saved report ID.
// M13: allows result preview before saving.
func biPreviewReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var def map[string]any
		if err := json.NewDecoder(r.Body).Decode(&def); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if def["module"] == nil {
			respondErr(w, 422, "module is required")
			return
		}
		q, _, qErr := biQueryForReport(r, def)
		if qErr != nil {
			respondErr(w, 422, qErr.Error())
			return
		}
		rows, err := db.PGQuery(ctx, q)
		if err != nil {
			respondErr(w, 500, "Query execution failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"rows": rows, "row_count": len(rows)}) //nolint:errcheck
	}
}

// biExportReport downloads a saved report definition as a file.
//
// It goes through the same writer as the export engine, so a saved report gets
// the same guarantees as a dataset export: escaped values, formula injection
// neutralised, xlsx/json as well as csv, and an entry in the export log. Before,
// this was a third hand-rolled CSV path that recorded nothing.
func biExportReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")

		defs, err := db.PGQuery(ctx, `SELECT * FROM bi_report_definitions WHERE id=$1`, id)
		if err != nil || len(defs) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		// Ownership: a private report is not exportable by someone who cannot run
		// it. biRunReport enforced this; this path did not.
		def := defs[0]
		isPublic, _ := def["is_public"].(bool)
		user := core.UserFromCtx(ctx)
		if !isPublic && user != nil && toInt64(def["created_by"]) != user.ID {
			respondErr(w, 403, "Not authorised")
			return
		}

		format, ok := parseExportFormat(r.URL.Query().Get("format"))
		if !ok {
			respondErr(w, 422, "Unsupported format (use csv, xlsx or json)")
			return
		}

		q, _, qErr := biQueryForReport(r, def)
		if qErr != nil {
			respondErr(w, 422, qErr.Error())
			return
		}

		rows, err := db.PGQuery(ctx, q)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		// A report definition has a dynamic shape, so columns are derived from
		// the result and sorted — the label is the raw key, humanised.
		var cols []exportCol
		if len(rows) > 0 {
			keys := make([]string, 0, len(rows[0]))
			for k := range rows[0] {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				cols = append(cols, exportCol{Key: k, Label: humaniseKey(k), Type: colText})
			}
		}

		name := str(def["name"])
		if name == "" {
			name = "report-" + id
		}
		filename := exportFilename(name, format)

		logBIExport(ctx, db, r, name, str(def["module"]), format, len(rows))

		if err := writeExport(w, format, filename, cols, rows); err != nil {
			slog.Error("biExportReport write", "id", id, "err", err)
		}
	}
}

// humaniseKey turns a SQL result key into a column header: outstanding_kobo →
// "Outstanding Kobo". Crude, but better than shipping raw column names.
func humaniseKey(k string) string {
	parts := strings.Split(k, "_")
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}

// logBIExport records a saved-report download in the same log as dataset exports,
// so the compliance view of "what left the building" is complete.
func logBIExport(ctx context.Context, db *core.DB, r *http.Request,
	name, module string, format exportFormat, rowCount int) {

	var uid any
	var actorName, actorRole string
	if u := core.UserFromCtx(ctx); u != nil {
		uid, actorName, actorRole = u.ID, u.FullName, u.Role
	}
	meta, _ := json.Marshal(map[string]any{"module": module, "saved_report": name})

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
		VALUES ($1, $2::jsonb, $3, $4, $5, 'ok', $6, $7, $8)`,
		"saved_report", string(meta), rowCount, uid, string(format),
		actorName, actorRole, ip); err != nil {
		slog.Error("logBIExport", "report", name, "err", err)
	}
}

// ── Scheduled Reports ─────────────────────────────────────────────────────────

func biScheduleReport(db *core.DB) http.HandlerFunc {
	type body struct {
		CronExpr   string `json:"cron_expr"`
		Recipients any    `json:"recipients"`
		Format     string `json:"format"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.CronExpr == "" {
			respondErr(w, 400, "cron_expr is required")
			return
		}
		if b.Format == "" {
			b.Format = "csv"
		}
		recip, _ := json.Marshal(b.Recipients)
		rows, err := db.PGQuery(ctx, `
			INSERT INTO bi_scheduled_reports (report_id, cron_expr, recipients, format, created_by)
			VALUES ($1,$2,$3,$4,$5) RETURNING id, report_id, cron_expr, format, created_at`,
			id, b.CronExpr, recip, b.Format, user.ID)
		if err != nil {
			respondErr(w, 500, "Schedule creation failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func biListScheduled(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")

		q := `SELECT s.id, s.report_id, d.name AS report_name, d.module,
			       s.cron_expr, s.recipients, s.format, s.is_active,
			       s.last_run_at, s.next_run_at, s.created_at,
			       u.full_name AS created_by_name
			FROM bi_scheduled_reports s
			JOIN bi_report_definitions d ON d.id = s.report_id
			LEFT JOIN o3c_users u ON s.created_by = u.id
			WHERE 1=1`
		var args []any
		if from != "" {
			args = append(args, from)
			q += " AND s.created_at::date >= $" + itoa(len(args)) + "::date"
		}
		if to != "" {
			args = append(args, to)
			q += " AND s.created_at::date <= $" + itoa(len(args)) + "::date"
		}
		q += " ORDER BY s.created_at DESC"
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func biDeleteSchedule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		db.PGExec(r.Context(), `DELETE FROM bi_scheduled_reports WHERE id=$1`, sid) //nolint:errcheck
		respond(w, map[string]any{"ok": true}, "json")
	}
}

func biListRuns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reportID := r.URL.Query().Get("report_id")
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		query := `
			SELECT rr.id, rr.report_id, d.name AS report_name, rr.status,
			       rr.row_count, rr.error_message, rr.started_at, rr.finished_at,
			       u.full_name AS run_by_name
			FROM bi_report_runs rr
			JOIN bi_report_definitions d ON d.id = rr.report_id
			LEFT JOIN o3c_users u ON rr.run_by = u.id
			WHERE 1=1`
		args := []any{}
		if reportID != "" {
			args = append(args, reportID)
			query += " AND rr.report_id=$" + itoa(len(args))
		}
		if from != "" {
			args = append(args, from)
			query += " AND rr.started_at::date >= $" + itoa(len(args)) + "::date"
		}
		if to != "" {
			args = append(args, to)
			query += " AND rr.started_at::date <= $" + itoa(len(args)) + "::date"
		}
		limit := 100
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 500 {
				limit = parsed
			}
		}
		offset := 0
		if v := r.URL.Query().Get("offset"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed >= 0 {
				offset = parsed
			}
		}
		args = append(args, limit, offset)
		query += " ORDER BY rr.started_at DESC LIMIT $" + itoa(len(args)-1) + " OFFSET $" + itoa(len(args))
		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

// batchRunScheduledBIReports finds all active scheduled BI reports due for execution,
// generates each as CSV, emails it to the configured recipients, and updates next_run_at.
// H8: Wire this into batch.go's runBatch (step 13) to enable scheduled report delivery.
func batchRunScheduledBIReports(ctx context.Context, db *core.DB) error {
	// This selected d.query_template, a column that does not exist on
	// bi_report_definitions. The statement failed on every batch run, so step 13
	// returned an error immediately and no scheduled report has ever been
	// delivered. The runner re-derives SQL through biQueryForReport below, so
	// the column was never read even when it was selected.
	schedules, err := db.PGQuery(ctx, `
		SELECT s.id, s.report_id, s.cron_expr, s.recipients, s.format,
		       d.name AS report_name, d.module, d.filters
		FROM bi_scheduled_reports s
		JOIN bi_report_definitions d ON d.id = s.report_id
		WHERE s.is_active = TRUE
		  AND (s.next_run_at IS NULL OR s.next_run_at <= NOW())`)
	if err != nil {
		return fmt.Errorf("batchRunScheduledBIReports: query schedules: %w", err)
	}
	if len(schedules) == 0 {
		return nil
	}

	var lastErr error
	for _, sched := range schedules {
		schedID := toInt64(sched["id"])
		reportID := toInt64(sched["report_id"])
		reportName := str(sched["report_name"])

		// Record run start
		runRows, err := db.PGQuery(ctx,
			`INSERT INTO bi_report_runs (report_id, status, started_at)
			 VALUES ($1,'running',NOW()) RETURNING id`, reportID)
		if err != nil {
			slog.Error("batchRunScheduledBIReports: create run record", "schedule_id", schedID, "err", err)
			lastErr = err
			continue
		}
		runID := toInt64(runRows[0]["id"])

		// Build and execute the report query (reuse biQueryForReport logic)
		defRows, _ := db.PGQuery(ctx, `SELECT * FROM bi_report_definitions WHERE id=$1`, reportID)
		if len(defRows) == 0 {
			db.PGExec(ctx, `UPDATE bi_report_runs SET status='failed', error_message='report definition not found', finished_at=NOW() WHERE id=$1`, runID) //nolint:errcheck
			continue
		}

		// Build CSV in memory
		fakeReq, _ := http.NewRequestWithContext(ctx, "GET", "/", nil)
		q, _, qErr := biQueryForReport(fakeReq, defRows[0])
		if qErr != nil {
			db.PGExec(ctx, `UPDATE bi_report_runs SET status='failed', error_message=$2, finished_at=NOW() WHERE id=$1`, runID, qErr.Error()) //nolint:errcheck
			lastErr = qErr
			continue
		}

		rows, qErr := db.PGQuery(ctx, q)
		if qErr != nil {
			db.PGExec(ctx, `UPDATE bi_report_runs SET status='failed', error_message=$2, finished_at=NOW() WHERE id=$1`, runID, qErr.Error()) //nolint:errcheck
			lastErr = qErr
			continue
		}

		var csvBuf strings.Builder
		cw := csv.NewWriter(&csvBuf)
		if len(rows) > 0 {
			headers := make([]string, 0, len(rows[0]))
			for k := range rows[0] {
				headers = append(headers, k)
			}
			sort.Strings(headers)
			cw.Write(headers) //nolint:errcheck
			for _, row := range rows {
				record := make([]string, len(headers))
				for i, h := range headers {
					record[i] = fmt.Sprintf("%v", row[h])
				}
				cw.Write(record) //nolint:errcheck
			}
		}
		cw.Flush()

		// Email to recipients
		recipJSON := str(sched["recipients"])
		var recipients []string
		json.Unmarshal([]byte(recipJSON), &recipients) //nolint:errcheck

		fname := fmt.Sprintf("%s_%s.csv", reportName, time.Now().Format("20060102"))
		if len(recipients) > 0 {
			to := make([]MailAddress, 0, len(recipients))
			for _, email := range recipients {
				if email != "" {
					to = append(to, MailAddress{Email: email})
				}
			}
			if len(to) > 0 {
				SendMail(ctx, db, SendMailOptions{
					To:          to,
					Subject:     fmt.Sprintf("Scheduled Report: %s (%s)", reportName, time.Now().Format("2006-01-02")),
					TextBody:    fmt.Sprintf("Scheduled BI report attached: %s\nGenerated: %s", reportName, time.Now().Format("2006-01-02 15:04")),
					HTMLBody:    fmt.Sprintf("<p>Scheduled BI report attached: <strong>%s</strong></p><p>Generated: %s</p>", reportName, time.Now().Format("2006-01-02 15:04")),
					Kind:        "report",
					Category:    "scheduled_report",
					Attachments: []MailAttachment{{Filename: fname, ContentType: "text/csv", Content: base64.StdEncoding.EncodeToString([]byte(csvBuf.String()))}},
				})
			}
		}

		db.PGExec(ctx, `UPDATE bi_report_runs SET status='success', row_count=$2, finished_at=NOW() WHERE id=$1`, runID, len(rows)) //nolint:errcheck

		nextRun := nextCronRun(str(sched["cron_expr"]), time.Now().UTC())
		db.PGExec(ctx, `UPDATE bi_scheduled_reports SET last_run_at=NOW(), next_run_at=$2 WHERE id=$1`, schedID, nextRun) //nolint:errcheck

		slog.Info("batchRunScheduledBIReports: report sent", "report", reportName, "recipients", len(recipients), "rows", len(rows))
	}
	return lastErr
}

// nextCronRun returns the next execution time after `after` for the given cron expression.
// Supports named schedules (@hourly, @daily, @weekly, @monthly) and standard 5-field
// expressions of the form "0 H * * *" (daily at hour H). Everything else defaults to 24h.
func nextCronRun(expr string, after time.Time) time.Time {
	switch strings.TrimSpace(strings.ToLower(expr)) {
	case "@hourly":
		return after.Add(time.Hour).Truncate(time.Hour)
	case "@daily", "@midnight":
		d := after.AddDate(0, 0, 1)
		return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, after.Location())
	case "@weekly":
		d := after.AddDate(0, 0, 7)
		return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, after.Location())
	case "@monthly":
		d := after.AddDate(0, 1, 0)
		return time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, after.Location())
	}
	// Standard 5-field cron: min hour dom month dow
	// Handle "0 H * * *" — daily at a specific hour.
	parts := strings.Fields(expr)
	if len(parts) == 5 && parts[0] == "0" && parts[2] == "*" && parts[3] == "*" && parts[4] == "*" {
		if h, err := strconv.Atoi(parts[1]); err == nil && h >= 0 && h <= 23 {
			candidate := time.Date(after.Year(), after.Month(), after.Day(), h, 0, 0, 0, after.Location())
			if !candidate.After(after) {
				candidate = candidate.AddDate(0, 0, 1)
			}
			return candidate
		}
	}
	return after.Add(24 * time.Hour)
}
