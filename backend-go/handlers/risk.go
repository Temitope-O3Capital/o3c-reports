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
	r.With(access).Get("/loan-book", riskLoanBook(db))

	// PortfolioHealth
	r.With(access).Get("/portfolio-kpis", riskPortfolioKPIs(db))
	r.With(access).Get("/par-trend", riskPARTrend(db))
	r.With(access).Get("/band-distribution", riskBandDistribution(db))
	r.With(access).Get("/sector-concentration", riskSectorConcentration(db))
	r.With(access).Get("/top-employers", riskTopEmployers(db))

	// VintageAnalysis
	r.With(access).Get("/vintage", riskVintage(db))
	r.With(access).Get("/vintage-kpis", riskVintageKPIs(db))
	r.With(access).Get("/vintage/{month}", riskVintageDetail(db))

	// EyeScore
	r.With(access).Get("/eye-scores", riskEyeScores(db))
	r.With(access).Get("/eye-kpis", riskEyeKPIs(db))

	// CreditFile
	r.With(access).Get("/credit-file/{cif}", riskCreditFile(db))
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

func multiIn(sb *strings.Builder, args *[]any, n *int, col, val string) {
	vals := strings.Split(val, ",")
	for i := range vals {
		vals[i] = strings.TrimSpace(vals[i])
	}
	if len(vals) == 1 {
		sb.WriteString(fmt.Sprintf(" AND %s = $%d", col, *n))
		*args = append(*args, vals[0])
		*n++
	} else {
		ph := make([]string, len(vals))
		for i := range vals {
			ph[i] = fmt.Sprintf("$%d", *n+i)
			*args = append(*args, vals[i])
		}
		*n += len(vals)
		sb.WriteString(" AND " + col + " IN (" + strings.Join(ph, ",") + ")")
	}
}

func riskAppWhere(stage, product, band, dateFrom, dateTo string) (string, []any) {
	var sb strings.Builder
	var args []any
	n := 1

	if stage != "" {
		multiIn(&sb, &args, &n, "stage", stage)
	}
	if product != "" {
		multiIn(&sb, &args, &n, "COALESCE(product_type, loan_type)", product)
	}
	if band != "" {
		multiIn(&sb, &args, &n, "eye_rating", band)
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

// ── LoanBook ─────────────────────────────────────────────────────────────────

func riskLoanBook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dpd  := qstr(r, "dpd")
		band := qstr(r, "band")
		q    := qstr(r, "q")
		lim  := qint(r, "limit", 200, 1, 500)
		off  := qint(r, "offset", 0, 0, 1<<30)

		var where strings.Builder
		var args  []any
		n := 1

		where.WriteString(" AND la.status IN ('active','booked')")

		switch dpd {
		case "current":
			where.WriteString(" AND GREATEST(0, CURRENT_DATE - COALESCE(la.maturity_date::date, CURRENT_DATE)) < 30")
		case "par30":
			where.WriteString(" AND GREATEST(0, CURRENT_DATE - COALESCE(la.maturity_date::date, CURRENT_DATE)) BETWEEN 30 AND 59")
		case "par60":
			where.WriteString(" AND GREATEST(0, CURRENT_DATE - COALESCE(la.maturity_date::date, CURRENT_DATE)) BETWEEN 60 AND 89")
		case "par90":
			where.WriteString(" AND GREATEST(0, CURRENT_DATE - COALESCE(la.maturity_date::date, CURRENT_DATE)) BETWEEN 90 AND 179")
		case "npl":
			where.WriteString(" AND GREATEST(0, CURRENT_DATE - COALESCE(la.maturity_date::date, CURRENT_DATE)) >= 180")
		}

		if band != "" {
			where.WriteString(fmt.Sprintf(" AND la.eye_rating = $%d", n))
			args = append(args, band); n++
		}
		if q != "" {
			where.WriteString(fmt.Sprintf(" AND (la.applicant_name ILIKE $%d OR la.applicant_cif ILIKE $%d OR la.employer ILIKE $%d)", n, n, n))
			args = append(args, "%"+q+"%"); n++
		}

		var total int64
		countRows, err := db.PGQuery(ctx, "SELECT COUNT(*) AS total FROM loan_applications la WHERE 1=1"+where.String(), args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{"data": []any{}, "total": 0}, "pg"); return
			}
			respondErr(w, 500, "Query failed"); return
		}
		if len(countRows) > 0 { total = toInt64(countRows[0]["total"]) }

		dataArgs := append(args, lim, off)
		query := fmt.Sprintf(`
			SELECT
				la.id,
				la.reference,
				COALESCE(la.applicant_name, la.applicant_cif) AS applicant_name,
				la.applicant_cif,
				COALESCE(la.employer, '') AS employer,
				COALESCE(la.product_type, la.loan_type, '') AS product_type,
				COALESCE(la.amount_requested_kobo, 0) AS amount_kobo,
				COALESCE(la.outstanding_kobo, la.amount_requested_kobo, 0) AS outstanding_kobo,
				GREATEST(0, CURRENT_DATE - COALESCE(la.maturity_date::date, CURRENT_DATE)) AS dpd,
				la.eye_rating AS risk_band,
				la.eye_score,
				la.status,
				la.booked_at,
				la.maturity_date
			FROM loan_applications la
			WHERE 1=1%s
			ORDER BY dpd DESC NULLS LAST, outstanding_kobo DESC
			LIMIT $%d OFFSET $%d`, where.String(), n, n+1)

		rows, err := db.PGQuery(ctx, query, dataArgs...)
		if err != nil { respondErr(w, 500, "Query failed"); return }
		if rows == nil { rows = []core.Row{} }
		respond(w, map[string]any{"data": rows, "total": total}, "pg")
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
			WITH top_emp AS (
				SELECT COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0) AS top_exposure
				FROM loan_applications
				WHERE status = 'active'
				GROUP BY COALESCE(NULLIF(employer, ''), 'Unknown')
				ORDER BY top_exposure DESC
				LIMIT 1
			)
			SELECT
				CASE WHEN COUNT(*) FILTER (WHERE status = 'active') > 0
				     THEN ROUND(100.0
				          * COUNT(*) FILTER (WHERE status = 'active'
				            AND GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 90)
				          / COUNT(*) FILTER (WHERE status = 'active'), 2)
				     ELSE 0 END AS npl_ratio_pct,
				CASE WHEN COUNT(*) FILTER (WHERE status = 'active') > 0
				     THEN ROUND(100.0
				          * COUNT(*) FILTER (WHERE status = 'active'
				            AND GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / COUNT(*) FILTER (WHERE status = 'active'), 2)
				     ELSE 0 END AS par30_rate_pct,
				CASE WHEN COUNT(*) FILTER (WHERE status = 'active') > 0
				     THEN ROUND(100.0
				          * COUNT(*) FILTER (WHERE status = 'active'
				            AND GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 60)
				          / COUNT(*) FILTER (WHERE status = 'active'), 2)
				     ELSE 0 END AS par60_rate_pct,
				COALESCE(ROUND(AVG(eye_score) FILTER (WHERE status = 'active' AND eye_score IS NOT NULL), 0), 0) AS avg_credit_score,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)) FILTER (WHERE status = 'active'), 0) AS total_book_kobo,
				COUNT(*) FILTER (WHERE status = 'active') AS total_active_loans,
				COALESCE((SELECT top_exposure FROM top_emp), 0) AS top_employer_exposure_kobo
			FROM loan_applications la
			WHERE 1=1`+dateWhere, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{
					"npl_ratio_pct": 0, "par30_rate_pct": 0, "par60_rate_pct": 0,
					"avg_credit_score": 0, "top_employer_exposure_kobo": 0,
					"total_book_kobo": 0, "total_active_loans": 0,
				}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{
				"npl_ratio_pct": 0, "par30_rate_pct": 0, "par60_rate_pct": 0,
				"avg_credit_score": 0, "top_employer_exposure_kobo": 0,
				"total_book_kobo": 0, "total_active_loans": 0,
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
					FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30), 0) AS par30_kobo,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0))
					FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 60), 0) AS par60_kobo,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0))
					FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 90), 0) AS par90_kobo
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
				COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30) AS par30_count
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
			multiIn(&extraClauses, &args, &n, "COALESCE(product_type, loan_type)", product)
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
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_1m,
				CASE WHEN DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) <= DATE_TRUNC('month', NOW()) - INTERVAL '3 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_3m,
				CASE WHEN DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) <= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_6m,
				CASE WHEN DATE_TRUNC('month', COALESCE(disbursed_at, created_at)) <= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
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
			multiIn(&extraClauses, &args, &n, "COALESCE(product_type, loan_type)", product)
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
					ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
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

func riskVintageDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		month := chi.URLParam(r, "month")
		if month == "" {
			respondErr(w, 400, "month is required")
			return
		}

		empty := func() {
			respond(w, map[string]any{
				"booking_month":    month,
				"total_count":      0,
				"active_count":     0,
				"active_book_kobo": 0,
				"written_off_count": 0,
				"par30_rate_pct":   0,
				"par60_rate_pct":   0,
				"par90_rate_pct":   0,
				"npl_rate_pct":     0,
				"avg_eye_score":    0,
				"historical_par":   []any{},
				"dpd_buckets":      []any{},
				"employers":        []any{},
				"products":         []any{},
				"loans":            []any{},
			}, "pg")
		}

		// 1. All aggregate stats + DPD buckets + historical PAR milestones in one query
		aggRows, err := db.PGQuery(ctx, `
			SELECT
				COUNT(*) AS total_count,
				COUNT(*) FILTER (WHERE status IN ('active','booked')) AS active_count,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0))
					FILTER (WHERE status IN ('active','booked')), 0) AS active_book_kobo,
				COUNT(*) FILTER (WHERE status = 'written_off') AS written_off_count,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS par30_rate_pct,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 60)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS par60_rate_pct,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 90)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS par90_rate_pct,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) >= 180)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS npl_rate_pct,
				COALESCE(ROUND(AVG(eye_score) FILTER (WHERE eye_score IS NOT NULL), 0), 0) AS avg_eye_score,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_1m,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '3 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_3m,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_6m,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_12m,
				COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) < 30) AS dpd_current,
				COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) BETWEEN 30 AND 59) AS dpd_par30,
				COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) BETWEEN 60 AND 89) AS dpd_par60,
				COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) BETWEEN 90 AND 179) AS dpd_par90,
				COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) >= 180) AS dpd_npl
			FROM loan_applications
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)), 'Mon YYYY') = $1`,
			month)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				empty(); return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(aggRows) == 0 {
			empty(); return
		}
		agg := aggRows[0]

		// Build structured sub-arrays from the flat aggregate row
		historicalPAR := []map[string]any{
			{"age_label": "1m",  "par30_pct": agg["par30_1m"]},
			{"age_label": "3m",  "par30_pct": agg["par30_3m"]},
			{"age_label": "6m",  "par30_pct": agg["par30_6m"]},
			{"age_label": "12m", "par30_pct": agg["par30_12m"]},
		}
		dpdBuckets := []map[string]any{
			{"label": "Current", "count": agg["dpd_current"]},
			{"label": "PAR30",   "count": agg["dpd_par30"]},
			{"label": "PAR60",   "count": agg["dpd_par60"]},
			{"label": "PAR90",   "count": agg["dpd_par90"]},
			{"label": "NPL",     "count": agg["dpd_npl"]},
		}

		// 2. Employer breakdown (top 10 by loan count)
		employerRows, err := db.PGQuery(ctx, `
			SELECT
				COALESCE(NULLIF(employer,''), 'Unknown') AS employer,
				COUNT(*) AS count,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0) AS book_kobo,
				COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30) AS par30_count
			FROM loan_applications
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)), 'Mon YYYY') = $1
			GROUP BY COALESCE(NULLIF(employer,''), 'Unknown')
			ORDER BY count DESC
			LIMIT 10`, month)
		if err != nil || employerRows == nil {
			employerRows = []core.Row{}
		}

		// 3. Product breakdown
		productRows, err := db.PGQuery(ctx, `
			SELECT
				COALESCE(NULLIF(COALESCE(product_type, loan_type),''), 'Other') AS product_type,
				COUNT(*) AS count,
				COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0) AS book_kobo,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) > 30)
				          / NULLIF(COUNT(*),0), 1) END, 0) AS par30_pct
			FROM loan_applications
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)), 'Mon YYYY') = $1
			GROUP BY COALESCE(NULLIF(COALESCE(product_type, loan_type),''), 'Other')
			ORDER BY count DESC`, month)
		if err != nil || productRows == nil {
			productRows = []core.Row{}
		}

		// 4. Individual loans (up to 200, highest DPD first)
		loanRows, err := db.PGQuery(ctx, `
			SELECT
				id,
				COALESCE(reference, 'LA-'||id::text) AS reference,
				COALESCE(applicant_name, applicant_cif) AS applicant_name,
				applicant_cif,
				COALESCE(employer, '') AS employer,
				COALESCE(product_type, loan_type, '') AS product_type,
				COALESCE(outstanding_kobo, amount_requested_kobo, 0) AS outstanding_kobo,
				GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) AS dpd,
				COALESCE(eye_rating, '') AS risk_band,
				eye_score,
				status,
				maturity_date
			FROM loan_applications
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(disbursed_at, created_at)), 'Mon YYYY') = $1
			ORDER BY dpd DESC NULLS LAST
			LIMIT 200`, month)
		if err != nil || loanRows == nil {
			loanRows = []core.Row{}
		}

		respond(w, map[string]any{
			"booking_month":    month,
			"total_count":      agg["total_count"],
			"active_count":     agg["active_count"],
			"active_book_kobo": agg["active_book_kobo"],
			"written_off_count": agg["written_off_count"],
			"par30_rate_pct":   agg["par30_rate_pct"],
			"par60_rate_pct":   agg["par60_rate_pct"],
			"par90_rate_pct":   agg["par90_rate_pct"],
			"npl_rate_pct":     agg["npl_rate_pct"],
			"avg_eye_score":    agg["avg_eye_score"],
			"historical_par":   historicalPAR,
			"dpd_buckets":      dpdBuckets,
			"employers":        employerRows,
			"products":         productRows,
			"loans":            loanRows,
		}, "pg")
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
			multiIn(&wbuf, &args, &n, "COALESCE(product_type, loan_type)", product)
		}
		if band != "" {
			multiIn(&wbuf, &args, &n, "eye_rating", band)
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

// ── CreditFile ─────────────────────────────────────────────────────────────────

func riskCreditFile(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()

		// Loan history from loan_applications
		loans, err := db.PGQuery(ctx, `
			SELECT
				id,
				COALESCE(reference, 'LA-'||id::text) AS ref,
				COALESCE(product_type, loan_type, 'Loan') AS product,
				COALESCE(amount_requested_kobo, 0) AS principal_kobo,
				COALESCE(outstanding_kobo, 0) AS outstanding_kobo,
				GREATEST(0, CURRENT_DATE - COALESCE(maturity_date::date, CURRENT_DATE)) AS dpd,
				COALESCE(status, 'unknown') AS status,
				COALESCE(disbursed_at, created_at)::text AS disbursed_at
			FROM loan_applications
			WHERE applicant_cif = $1
			ORDER BY created_at DESC`, cif)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") {
				respondErr(w, 404, "No credit file found for CIF")
				return
			}
			respondErr(w, 500, err.Error())
			return
		}
		if len(loans) == 0 {
			respondErr(w, 404, "No credit file found for CIF")
			return
		}

		// Aggregate stats
		var totalOutstanding, totalCount, activeCount, worstDPD int64
		for _, l := range loans {
			totalCount++
			outstanding := toInt64(l["outstanding_kobo"])
			totalOutstanding += outstanding
			if str(l["status"]) == "active" || str(l["status"]) == "disbursed" {
				activeCount++
			}
			if dpd := toInt64(l["dpd"]); dpd > worstDPD {
				worstDPD = dpd
			}
		}

		// Eye score + DTI from most recent scored application
		var eyeScore, eyeBand, dtiPct any
		eyeRows, _ := db.PGQuery(ctx, `
			SELECT eye_score, eye_rating, dti_pct
			FROM loan_applications
			WHERE applicant_cif = $1 AND eye_score IS NOT NULL
			ORDER BY created_at DESC LIMIT 1`, cif)
		if len(eyeRows) > 0 {
			eyeScore = eyeRows[0]["eye_score"]
			eyeBand = eyeRows[0]["eye_rating"]
			dtiPct = eyeRows[0]["dti_pct"]
		}

		// Customer info: try MSSQL first, fall back to PG loan_applications
		custRows, _, _ := db.DualQuery(ctx,
			`SELECT TOP 1 CIF_Number AS cif,
				COALESCE(First_Name,'') + ' ' + COALESCE(Last_Name,'') AS full_name,
				COALESCE(Phone,'') AS phone,
				COALESCE(BVN,'') AS bvn,
				COALESCE(KYC_Status,'unknown') AS kyc_status
			 FROM dbo.Contact WHERE CIF_Number = @p1`,
			`SELECT "CIF Number" AS cif,
				COALESCE("First Name",'') || ' ' || COALESCE("Last Name",'') AS full_name,
				COALESCE("Phone Number",'') AS phone,
				'' AS bvn,
				'unknown' AS kyc_status
			 FROM "Accounts" WHERE "CIF Number" = $1 LIMIT 1`,
			cif)

		custName, phone, bvn, kycStatus := cif, "", "", "unknown"
		if len(custRows) > 0 {
			if v := str(custRows[0]["full_name"]); strings.TrimSpace(v) != "" {
				custName = strings.TrimSpace(v)
			}
			phone = str(custRows[0]["phone"])
			bvn = str(custRows[0]["bvn"])
			kycStatus = str(custRows[0]["kyc_status"])
		} else {
			// Fallback: get name+phone from loan application
			appRows, _ := db.PGQuery(ctx,
				`SELECT applicant_name, phone FROM loan_applications WHERE applicant_cif = $1 LIMIT 1`, cif)
			if len(appRows) > 0 {
				if v := str(appRows[0]["applicant_name"]); v != "" {
					custName = v
				}
				phone = str(appRows[0]["phone"])
			}
		}

		respond(w, map[string]any{
			"cif":                    cif,
			"customer_name":          custName,
			"phone":                  phone,
			"eye_score":              eyeScore,
			"eye_band":               eyeBand,
			"total_loan_count":       totalCount,
			"active_loan_count":      activeCount,
			"total_outstanding_kobo": totalOutstanding,
			"worst_dpd":              worstDPD,
			"dti_pct":               dtiPct,
			"kyc_status":            kycStatus,
			"bvn":                   bvn,
			"loans":                 loans,
		}, "pg")
	}
}
