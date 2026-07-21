package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterRisk(r chi.Router, db *core.DB) {
	access := core.RequirePages("risk_all", "risk_officer", "risk_head")

	// AppReview
	r.With(access).Get("/applications", riskApplications(db))
	r.With(access).Get("/review-kpis", riskReviewKPIs(db))
	r.With(access).Get("/applications/export", riskApplicationsExport(db))

	// PortfolioHealth
	r.With(access).Get("/portfolio-kpis", riskPortfolioKPIs(db))
	r.With(access).Get("/par-trend", riskPARTrend(db))
	r.With(access).Get("/band-distribution", riskBandDistribution(db))
	r.With(access).Get("/sector-concentration", riskSectorConcentration(db))
	r.With(access).Get("/top-employers", riskTopEmployers(db))

	// VintageAnalysis
	r.With(access).Get("/vintage", riskVintage(db))
	r.With(access).Get("/vintage-kpis", riskVintageKPIs(db))

	// EyeScore
	r.With(access).Get("/eye-scores", riskEyeScores(db))
	r.With(access).Get("/eye-kpis", riskEyeKPIs(db))
}

// ── AppReview ─────────────────────────────────────────────────────────────────

func riskApplications(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		stage := qstr(r, "stage")
		product := qstr(r, "product")
		band := qstr(r, "band")
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		where, args := riskAppWhere(stage, product, band, dateFrom, dateTo)

		// Count total
		var total int64
		countRows, err := db.PGQuery(ctx,
			"SELECT COUNT(*) AS total FROM loan_applications WHERE 1=1"+where, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				writeRiskList(w, []core.Row{}, 0)
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		// Data query
		n := len(args) + 1
		dataArgs := append(args, limit, offset)
		query := fmt.Sprintf(`
			SELECT
				id,
				reference,
				applicant_name,
				COALESCE(employer, '') AS employer_name,
				eye_score,
				eye_rating AS risk_band,
				COALESCE(monthly_income_kobo, 0) AS monthly_income_kobo,
				dti_pct,
				COALESCE(amount_requested_kobo, 0) AS amount_requested_kobo,
				COALESCE(product_type, loan_type, '') AS product_type,
				submitted_at
			FROM loan_applications
			WHERE 1=1%s
			ORDER BY submitted_at DESC NULLS LAST, id DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1)

		rows, err := db.PGQuery(ctx, query, dataArgs...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		writeRiskList(w, rows, total)
	}
}

func riskAppWhere(stage, product, band, dateFrom, dateTo string) (string, []any) {
	var sb strings.Builder
	var args []any
	n := 1

	if stage != "" {
		sb.WriteString(fmt.Sprintf(" AND stage = $%d", n))
		args = append(args, stage)
		n++
	}
	if product != "" {
		sb.WriteString(fmt.Sprintf(" AND COALESCE(product_type, loan_type) = $%d", n))
		args = append(args, product)
		n++
	}
	if band != "" {
		sb.WriteString(fmt.Sprintf(" AND eye_rating = $%d", n))
		args = append(args, band)
		n++
	}
	if dateFrom != "" && dateTo != "" {
		sb.WriteString(fmt.Sprintf(" AND submitted_at::date BETWEEN $%d AND $%d", n, n+1))
		args = append(args, dateFrom, dateTo)
		n += 2
	} else if dateFrom != "" {
		sb.WriteString(fmt.Sprintf(" AND submitted_at::date >= $%d", n))
		args = append(args, dateFrom)
		n++
	} else if dateTo != "" {
		sb.WriteString(fmt.Sprintf(" AND submitted_at::date <= $%d", n))
		args = append(args, dateTo)
		n++
	}
	_ = n // suppress unused-variable warning after last branch
	return sb.String(), args
}

// writeRiskList writes a paginated JSON response: { data: [...], total: N }
func writeRiskList(w http.ResponseWriter, rows []core.Row, total int64) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"data":  rows,
		"total": total,
	})
}

func riskReviewKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE risk_reviewed_at IS NOT NULL) AS reviewed,
				COUNT(*) FILTER (WHERE status IN ('active','disbursed','booked')) AS approved,
				COUNT(*) FILTER (WHERE status = 'declined') AS declined,
				COUNT(*) FILTER (WHERE stage IN ('risk_review','risk_head_review','pending_committee')
					AND status NOT IN ('declined','active','disbursed','booked','written_off')) AS pending
			FROM loan_applications`)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{"reviewed": 0, "approved": 0, "declined": 0, "pending": 0}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{"reviewed": 0, "approved": 0, "declined": 0, "pending": 0}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func riskApplicationsExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		stage := qstr(r, "stage")
		product := qstr(r, "product")
		band := qstr(r, "band")
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")

		where, args := riskAppWhere(stage, product, band, dateFrom, dateTo)

		rows, err := db.PGQuery(ctx, `
			SELECT
				reference,
				applicant_name,
				COALESCE(employer, '') AS employer_name,
				eye_score,
				eye_rating AS risk_band,
				COALESCE(monthly_income_kobo, 0) AS monthly_income_kobo,
				dti_pct,
				COALESCE(amount_requested_kobo, 0) AS amount_requested_kobo,
				COALESCE(product_type, loan_type, '') AS product_type,
				stage,
				status,
				submitted_at
			FROM loan_applications
			WHERE 1=1`+where+`
			ORDER BY submitted_at DESC NULLS LAST, id DESC
			LIMIT 5000`, args...)
		if err != nil {
			respondErr(w, 500, "Export failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		streamCSV(w, "risk-applications.csv", rows)
	}
}

// ── PortfolioHealth ───────────────────────────────────────────────────────────

func riskPortfolioKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to   := qstr(r, "to")
		var dateWhere string
		var args []any
		n := 1
		if from != "" {
			dateWhere += fmt.Sprintf(" AND submitted_at::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			dateWhere += fmt.Sprintf(" AND submitted_at::date <= $%d", n)
			args = append(args, to)
			n++
		}
		_ = n
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				-- C10: compute DPD on-the-fly from maturity_date rather than relying on the
				-- never-auto-populated dpd column.
				-- NPL ratio: active loans overdue by >90 days
				CASE WHEN COUNT(*) FILTER (WHERE status = 'active') > 0
				     THEN ROUND(100.0
				          * COUNT(*) FILTER (WHERE status = 'active'
				            AND GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 90)
				          / COUNT(*) FILTER (WHERE status = 'active'), 2)
				     ELSE 0 END AS npl_ratio_pct,
				-- PAR30 rate: active loans overdue by >30 days
				CASE WHEN COUNT(*) FILTER (WHERE status = 'active') > 0
				     THEN ROUND(100.0
				          * COUNT(*) FILTER (WHERE status = 'active'
				            AND GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / COUNT(*) FILTER (WHERE status = 'active'), 2)
				     ELSE 0 END AS par30_rate_pct,
				-- Avg eye score for active loans
				COALESCE(ROUND(AVG(eye_score) FILTER (WHERE status = 'active' AND eye_score IS NOT NULL), 0), 0) AS avg_credit_score,
				-- Top employer exposure (sum of outstanding or requested kobo)
				COALESCE((
					SELECT SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0))
					FROM loan_applications sub
					WHERE sub.status = 'active'
					  AND sub.employer = la.employer
					GROUP BY sub.employer
					ORDER BY 1 DESC
					LIMIT 1
				), 0) AS top_employer_exposure_kobo
			FROM loan_applications la
			WHERE 1=1`+dateWhere, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{
					"npl_ratio_pct": 0, "par30_rate_pct": 0,
					"avg_credit_score": 0, "top_employer_exposure_kobo": 0,
				}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{
				"npl_ratio_pct": 0, "par30_rate_pct": 0,
				"avg_credit_score": 0, "top_employer_exposure_kobo": 0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func riskPARTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				TO_CHAR(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)), 'Mon YYYY') AS month,
				DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) AS _sort,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0))
					FILTER (WHERE COALESCE(dpd,0) > 30), 0) AS par30_kobo,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0))
					FILTER (WHERE COALESCE(dpd,0) > 60), 0) AS par60_kobo,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0))
					FILTER (WHERE COALESCE(dpd,0) > 90), 0) AS par90_kobo
			FROM loan_applications
			WHERE status = 'active'
			  AND COALESCE(disbursed_at, created_at) >= NOW() - INTERVAL '13 months'
			GROUP BY DATE_TRUNC('month', COALESCE(disbursed_at, created_at))
			ORDER BY _sort`)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, []core.Row{}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Drop internal sort column before returning
		for _, row := range rows {
			delete(row, "_sort")
		}
		respond(w, rows, "pg")
	}
}

func riskBandDistribution(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH totals AS (
				SELECT COUNT(*) AS grand_total
				FROM loan_applications
				WHERE status = 'active' AND eye_rating IS NOT NULL
			)
			SELECT
				eye_rating AS band,
				COUNT(*) AS count,
				CASE WHEN (SELECT grand_total FROM totals) > 0
				     THEN ROUND(100.0 * COUNT(*) / (SELECT grand_total FROM totals), 1)
				     ELSE 0 END AS pct
			FROM loan_applications
			WHERE status = 'active' AND eye_rating IS NOT NULL
			GROUP BY eye_rating
			ORDER BY
				CASE eye_rating
					WHEN 'Prime'       THEN 1
					WHEN 'Near-Prime'  THEN 2
					WHEN 'Sub-Prime'   THEN 3
					WHEN 'High-Risk'   THEN 4
					ELSE 5
				END`)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, []core.Row{}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func riskSectorConcentration(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Use sector_code if available; fall back to employer as proxy sector.
		rows, err := db.PGQuery(r.Context(), `
			WITH book AS (
				SELECT
					COALESCE(NULLIF(sector_code,''), NULLIF(employer,''), 'Other') AS sector,
					COALESCE(outstanding_kobo, amount_requested_kobo, 0) AS book_kobo
				FROM loan_applications
				WHERE status = 'active'
			),
			totals AS (
				SELECT COALESCE(SUM(book_kobo), 0) AS grand_total FROM book
			)
			SELECT
				sector,
				CASE WHEN (SELECT grand_total FROM totals) > 0
				     THEN ROUND(100.0 * SUM(book_kobo) / (SELECT grand_total FROM totals), 1)
				     ELSE 0 END AS book_pct
			FROM book
			GROUP BY sector
			ORDER BY book_pct DESC
			LIMIT 10`)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, []core.Row{}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func riskTopEmployers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH book_total AS (
				SELECT COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0) AS grand_total
				FROM loan_applications
				WHERE status = 'active'
			)
			SELECT
				COALESCE(NULLIF(employer,''), 'Unknown') AS company,
				COUNT(*) AS staff_loans_count,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0) AS book_kobo,
				CASE WHEN (SELECT grand_total FROM book_total) > 0
				     THEN ROUND(100.0
				          * COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0)
				          / (SELECT grand_total FROM book_total), 2)
				     ELSE 0 END AS pct_of_total,
				COUNT(*) FILTER (WHERE COALESCE(dpd, 0) > 30) AS par30_count
			FROM loan_applications
			WHERE status = 'active'
			GROUP BY COALESCE(NULLIF(employer,''), 'Unknown')
			ORDER BY book_kobo DESC
			LIMIT 20`)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, []core.Row{}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── VintageAnalysis ───────────────────────────────────────────────────────────

func riskVintage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		product := qstr(r, "product")
		from    := qstr(r, "from")
		to      := qstr(r, "to")

		var extraClauses strings.Builder
		var args []any
		n := 1
		if product != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(product_type, loan_type) = $%d", n))
			args = append(args, product)
			n++
		}
		if from != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(disbursed_at, created_at)::date >= $%d", n))
			args = append(args, from)
			n++
		}
		if to != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(disbursed_at, created_at)::date <= $%d", n))
			args = append(args, to)
			n++
		}
		_ = n

		// H3: group by disbursement month (not application creation month) so cohort
		// timing reflects when the loan was actually booked, not applied for.
		rows, err := db.PGQuery(ctx, `
			SELECT
				TO_CHAR(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)), 'Mon YYYY') AS booking_month,
				DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) AS _sort,
				COUNT(*) AS cohort_count,
				CASE WHEN DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) <= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(dpd,0) > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_1m,
				CASE WHEN DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) <= DATE_TRUNC('month', NOW()) - INTERVAL '3 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(dpd,0) > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_3m,
				CASE WHEN DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) <= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(dpd,0) > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_6m,
				CASE WHEN DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) <= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(dpd,0) > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_12m
			FROM loan_applications
			WHERE 1=1`+extraClauses.String()+`
			GROUP BY DATE_TRUNC('month', COALESCE(disbursed_at, created_at))
			ORDER BY _sort DESC
			LIMIT 24`, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, []core.Row{}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		for _, row := range rows {
			delete(row, "_sort")
		}
		respond(w, rows, "pg")
	}
}

func riskVintageKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		product := qstr(r, "product")
		from    := qstr(r, "from")
		to      := qstr(r, "to")

		var extraClauses strings.Builder
		var args []any
		n := 1
		if product != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(product_type, loan_type) = $%d", n))
			args = append(args, product)
			n++
		}
		if from != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(disbursed_at, created_at)::date >= $%d", n))
			args = append(args, from)
			n++
		}
		if to != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(disbursed_at, created_at)::date <= $%d", n))
			args = append(args, to)
			n++
		}
		_ = n

		rows, err := db.PGQuery(ctx, `
			WITH cohorts AS (
				SELECT
					DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) AS booking_month,
					ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(dpd,0) > 30)
					      / NULLIF(COUNT(*), 0), 1) AS par30_rate
				FROM loan_applications
				WHERE 1=1`+extraClauses.String()+`
				GROUP BY DATE_TRUNC('month', COALESCE(disbursed_at, created_at))
			)
			SELECT
				ROUND(AVG(par30_rate) FILTER (
					WHERE booking_month <= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'), 1) AS avg_par30_6m,
				ROUND(AVG(par30_rate) FILTER (
					WHERE booking_month <= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'), 1) AS avg_par30_12m
			FROM cohorts`, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{"avg_par30_6m": nil, "avg_par30_12m": nil}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{"avg_par30_6m": nil, "avg_par30_12m": nil}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// ── EyeScore ──────────────────────────────────────────────────────────────────

func riskEyeScores(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		product := qstr(r, "product")
		band := qstr(r, "band")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		var wbuf strings.Builder
		var args []any
		n := 1

		// Only return rows that have been eye-scored
		wbuf.WriteString(" AND eye_score IS NOT NULL")

		if dateFrom != "" && dateTo != "" {
			wbuf.WriteString(fmt.Sprintf(" AND scored_at::date BETWEEN $%d AND $%d", n, n+1))
			args = append(args, dateFrom, dateTo)
			n += 2
		} else if dateFrom != "" {
			wbuf.WriteString(fmt.Sprintf(" AND scored_at::date >= $%d", n))
			args = append(args, dateFrom)
			n++
		} else if dateTo != "" {
			wbuf.WriteString(fmt.Sprintf(" AND scored_at::date <= $%d", n))
			args = append(args, dateTo)
			n++
		}
		if product != "" {
			wbuf.WriteString(fmt.Sprintf(" AND COALESCE(product_type, loan_type) = $%d", n))
			args = append(args, product)
			n++
		}
		if band != "" {
			wbuf.WriteString(fmt.Sprintf(" AND eye_rating = $%d", n))
			args = append(args, band)
			n++
		}

		where := wbuf.String()

		// Wrap the base query in a CTE that computes scored_at once
		baseQuery := `
			SELECT
				id,
				id AS application_id,
				applicant_name,
				COALESCE(product_type, loan_type, '') AS product_type,
				eye_score AS score,
				COALESCE(eye_rating, '') AS band,
				CAST(NULL AS TEXT) AS top_factor,
				dti_pct,
				COALESCE(risk_reviewed_at, submitted_at, created_at) AS scored_at
			FROM loan_applications`

		// Count
		var total int64
		countRows, err := db.PGQuery(ctx,
			"SELECT COUNT(*) AS total FROM ("+baseQuery+") sub WHERE 1=1"+where, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				writeRiskList(w, []core.Row{}, 0)
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		// Data
		pageArgs := append(args, limit, offset)
		dataRows, err := db.PGQuery(ctx,
			"SELECT * FROM ("+baseQuery+") sub WHERE 1=1"+where+
				fmt.Sprintf(" ORDER BY scored_at DESC NULLS LAST LIMIT $%d OFFSET $%d", n, n+1),
			pageArgs...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if dataRows == nil {
			dataRows = []core.Row{}
		}

		writeRiskList(w, dataRows, total)
	}
}

func riskEyeKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (
					WHERE eye_score IS NOT NULL
					  AND COALESCE(risk_reviewed_at, submitted_at, created_at)::date = CURRENT_DATE
				) AS scored_today,
				COALESCE(ROUND(AVG(eye_score) FILTER (
					WHERE eye_score IS NOT NULL
					  AND DATE_TRUNC('month', COALESCE(risk_reviewed_at, submitted_at, created_at))
					      = DATE_TRUNC('month', NOW())
				), 0), 0) AS avg_score_month,
				COUNT(*) FILTER (WHERE eye_rating = 'High-Risk') AS high_risk_count,
				COUNT(*) FILTER (
					WHERE eye_score IS NOT NULL
					  AND DATE_TRUNC('month', COALESCE(risk_reviewed_at, submitted_at, created_at))
					      = DATE_TRUNC('month', NOW())
				) AS requests_month
			FROM loan_applications`)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{
					"scored_today": 0, "avg_score_month": 0,
					"high_risk_count": 0, "requests_month": 0,
				}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{
				"scored_today": 0, "avg_score_month": 0,
				"high_risk_count": 0, "requests_month": 0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}
