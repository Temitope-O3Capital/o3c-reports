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
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterBI(r chi.Router, db *core.DB) {
	bi := core.RequirePages("reports")

	r.With(bi).Get("/reports",                    biListReports(db))
	r.With(bi).Post("/reports",                   biCreateReport(db))
	r.With(bi).Put("/reports/{id}",               biUpdateReport(db))
	r.With(bi).Delete("/reports/{id}",            biDeleteReport(db))
	r.With(bi).Post("/reports/{id}/run",          biRunReport(db))
	r.With(bi).Get("/reports/{id}/export",        biExportReport(db))
	r.With(bi).Post("/reports/{id}/schedule",     biScheduleReport(db))
	r.With(bi).Get("/scheduled",                  biListScheduled(db))
	r.With(bi).Delete("/scheduled/{sid}",         biDeleteSchedule(db))
	r.With(bi).Get("/runs",                       biListRuns(db))
}

// ── Report Definitions ────────────────────────────────────────────────────────

func biListReports(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		rows, err := db.PGQuery(ctx, `
			SELECT d.id, d.name, d.description, d.module, d.dimensions, d.metrics,
			       d.date_range, d.is_public, d.created_at,
			       u.full_name AS created_by_name,
			       (SELECT COUNT(*) FROM bi_report_runs WHERE report_id=d.id) AS run_count,
			       (SELECT MAX(started_at) FROM bi_report_runs WHERE report_id=d.id) AS last_run_at
			FROM bi_report_definitions d
			LEFT JOIN o3c_users u ON d.created_by = u.id
			WHERE d.is_public=TRUE OR d.created_by=$1
			ORDER BY d.updated_at DESC`, user.ID)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
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
			respondErr(w, 400, "name and module are required"); return
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
			respondErr(w, 500, "Create failed"); return
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
			respondErr(w, 400, "Invalid JSON"); return
		}
		// Ownership check
		existing, _ := db.PGQuery(ctx, `SELECT created_by FROM bi_report_definitions WHERE id=$1`, id)
		if len(existing) == 0 {
			respondErr(w, 404, "Report not found"); return
		}
		if toInt64(existing[0]["created_by"]) != user.ID {
			respondErr(w, 403, "Not your report"); return
		}

		set := "updated_at=NOW()"
		args := []any{}
		n := 1
		appendField := func(col string, val any) {
			set += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, val); n++
		}
		if b.Name != nil        { appendField("name",        *b.Name)        }
		if b.Description != nil { appendField("description", *b.Description) }
		if b.Module != nil      { appendField("module",      *b.Module)      }
		if b.DateRange != nil   { appendField("date_range",  *b.DateRange)   }
		if b.IsPublic != nil    { appendField("is_public",   *b.IsPublic)    }
		if b.Dimensions != nil  { j, _ := json.Marshal(b.Dimensions); appendField("dimensions", j) }
		if b.Metrics != nil     { j, _ := json.Marshal(b.Metrics); appendField("metrics",    j) }
		if b.Filters != nil     { j, _ := json.Marshal(b.Filters);  appendField("filters",    j) }

		args = append(args, id)
		_, err := db.PGExec(ctx, fmt.Sprintf(`UPDATE bi_report_definitions SET %s WHERE id=$%d`, set, n), args...)
		if err != nil {
			respondErr(w, 500, "Update failed"); return
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
			respondErr(w, 404, "Report not found"); return
		}
		if toInt64(existing[0]["created_by"]) != user.ID {
			respondErr(w, 403, "Not your report"); return
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
		q = fmt.Sprintf(`
			SELECT date_trunc('day', created_at)::date AS date,
			       stage                               AS dimension,
			       COUNT(*)                            AS count,
			       COALESCE(SUM(value_kobo),0)         AS value_kobo
			FROM crm_deals
			WHERE created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "Finance":
		q = fmt.Sprintf(`
			SELECT date_trunc('day', transaction_date)::date AS date,
			       transaction_type                          AS dimension,
			       COUNT(*)                                  AS count,
			       COALESCE(SUM(amount_kobo),0)              AS amount_kobo
			FROM financial_transactions
			WHERE transaction_date::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "HR":
		q = fmt.Sprintf(`
			SELECT date_trunc('month', employment_date)::date AS date,
			       department_id::text                        AS dimension,
			       COUNT(*)                                   AS headcount
			FROM employees
			WHERE employment_date::date BETWEEN %s AND %s
			AND status='active'
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
		q = fmt.Sprintf(`
			SELECT date_trunc('day', c.created_at)::date     AS date,
			       c.campaign_type                           AS dimension,
			       COUNT(DISTINCT c.id)                      AS campaigns,
			       COALESCE(SUM(ca.sent_count),0)            AS sent,
			       COALESCE(SUM(ca.opened_count),0)          AS opened,
			       COALESCE(SUM(ca.clicked_count),0)         AS clicked
			FROM campaigns c
			LEFT JOIN campaign_analytics ca ON ca.campaign_id = c.id
			WHERE c.created_at::date BETWEEN %s AND %s
			GROUP BY 1, 2 ORDER BY 1 DESC`, dateFrom, dateTo)

	case "Compliance":
		q = fmt.Sprintf(`
			SELECT date_trunc('day', finding_date)::date AS date,
			       severity                              AS dimension,
			       COUNT(*)                              AS findings,
			       COUNT(*) FILTER (WHERE status='closed') AS closed
			FROM compliance_findings
			WHERE finding_date::date BETWEEN %s AND %s
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
			respondErr(w, 404, "Report not found"); return
		}
		def := defs[0]
		isPublic, _ := def["is_public"].(bool)
		if !isPublic && toInt64(def["created_by"]) != user.ID {
			respondErr(w, 403, "Not authorised"); return
		}

		q, _, qErr := biQueryForReport(r, def)
		if qErr != nil {
			respondErr(w, 422, qErr.Error()); return
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
			respondErr(w, 500, "Query execution failed"); return
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

func biExportReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")

		defs, err := db.PGQuery(ctx, `SELECT * FROM bi_report_definitions WHERE id=$1`, id)
		if err != nil || len(defs) == 0 {
			respondErr(w, 404, "Report not found"); return
		}

		q, _, qErr := biQueryForReport(r, defs[0])
		if qErr != nil {
			respondErr(w, 422, qErr.Error()); return
		}

		rows, err := db.PGQuery(ctx, q)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}

		fname := fmt.Sprintf("report_%s_%s.csv", id, time.Now().Format("20060102"))
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)

		cw := csv.NewWriter(w)
		if len(rows) > 0 {
			// H3: Sort column headers so CSV output is deterministic across runs.
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
			respondErr(w, 400, "cron_expr is required"); return
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
			respondErr(w, 500, "Schedule creation failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func biListScheduled(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT s.id, s.report_id, d.name AS report_name, d.module,
			       s.cron_expr, s.recipients, s.format, s.is_active,
			       s.last_run_at, s.next_run_at, s.created_at,
			       u.full_name AS created_by_name
			FROM bi_scheduled_reports s
			JOIN bi_report_definitions d ON d.id = s.report_id
			LEFT JOIN o3c_users u ON s.created_by = u.id
			ORDER BY s.created_at DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
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
			query += " AND rr.report_id=$1"
			args = append(args, reportID)
		}
		query += " ORDER BY rr.started_at DESC LIMIT 100"
		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
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
	schedules, err := db.PGQuery(ctx, `
		SELECT s.id, s.report_id, s.cron_expr, s.recipients, s.format,
		       d.name AS report_name, d.module, d.query_template, d.filters
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

		// Advance next_run_at by 24 hours (simple daily schedule).
		// TODO: parse cron_expr for more precise scheduling.
		db.PGExec(ctx, `UPDATE bi_scheduled_reports SET last_run_at=NOW(), next_run_at=NOW()+INTERVAL '24 hours' WHERE id=$1`, schedID) //nolint:errcheck

		slog.Info("batchRunScheduledBIReports: report sent", "report", reportName, "recipients", len(recipients), "rows", len(rows))
	}
	return lastErr
}
