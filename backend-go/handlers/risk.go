package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterRisk(r chi.Router, db *core.DB) {
	// "credit_portfolio" is included deliberately. App.tsx has always gated the
	// /operations/risk routes on credit_portfolio while this guard demanded
	// risk_all|risk_officer|risk_head, so five roles that hold credit_portfolio
	// (collections_head, recovery_head, finance_officer, finance_head,
	// settlement_officer) could open the page and then 403 on every single call.
	// The UI's choice is the correct one — those roles need to read the credit
	// book — so the API is aligned to it rather than the page being taken away.
	access := core.RequirePages("risk_all", "risk_officer", "risk_head", "credit_portfolio")

	// AppReview
	r.With(access).Get("/applications", riskApplications(db))
	r.With(access).Get("/review-kpis", riskReviewKPIs(db))
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

	// My Dashboard — the risk officer's personal station (review pipeline + book)
	r.With(access).Get("/my-dashboard", riskMyDashboard(db))

	// Sector code registry — O3 owns the CBN code→name mapping (Udara sends codes only)
	RegisterRiskSectors(r, db)
}

// riskMyDashboard — the risk officer's station: the origination review pipeline
// they work (pending review, reviewed today, decisions MTD, ageing + risk-band
// mix of what's waiting) plus a live credit-book headline. Defensive: when the
// origination pipeline is empty, review metrics are simply omitted.
func riskMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dash := map[string]any{}
		live := riskOriginationLive(ctx, db)
		dash["origination_live"] = live

		const pendingWhere = `stage IN ('risk_review','risk_head_review','pending_committee') AND status NOT IN ('declined','active','disbursed','booked','written_off')`

		if live {
			if rows, _ := db.PGQuery(ctx, `
				SELECT
					COUNT(*) FILTER (WHERE `+pendingWhere+`) AS pending,
					COUNT(*) FILTER (WHERE risk_reviewed_at::date = CURRENT_DATE) AS reviewed_today,
					COUNT(*) FILTER (WHERE risk_reviewed_at >= NOW() - INTERVAL '7 days') AS reviewed_week,
					COUNT(*) FILTER (WHERE status IN ('active','disbursed','booked') AND DATE_TRUNC('month', COALESCE(risk_reviewed_at, submitted_at)) = DATE_TRUNC('month', CURRENT_DATE)) AS approved_mtd,
					COUNT(*) FILTER (WHERE status='declined' AND DATE_TRUNC('month', COALESCE(risk_reviewed_at, submitted_at)) = DATE_TRUNC('month', CURRENT_DATE)) AS declined_mtd
				FROM loan_applications`); len(rows) > 0 {
				for k, v := range rows[0] {
					dash[k] = v
				}
			}
			if rows, _ := db.PGQuery(ctx, `SELECT COALESCE(MAX(EXTRACT(DAY FROM NOW() - submitted_at))::int, 0) AS days FROM loan_applications WHERE `+pendingWhere); len(rows) > 0 {
				dash["oldest_pending_days"] = rows[0]["days"]
			}
			bands, _ := db.PGQuery(ctx, `SELECT COALESCE(eye_rating,'—') AS band, COUNT(*) AS count FROM loan_applications WHERE `+pendingWhere+` GROUP BY eye_rating ORDER BY count DESC`)
			if bands == nil {
				bands = []core.Row{}
			}
			dash["pending_by_band"] = bands
			list, _ := db.PGQuery(ctx, `
				SELECT reference, applicant_name, COALESCE(product_type, loan_type, '') AS product_type,
				       COALESCE(amount_requested_kobo, 0) AS amount_requested_kobo,
				       eye_score, eye_rating AS risk_band, submitted_at
				FROM loan_applications WHERE `+pendingWhere+`
				ORDER BY submitted_at ASC NULLS LAST LIMIT 8`)
			if list == nil {
				list = []core.Row{}
			}
			dash["pending_list"] = list
		}

		// Live credit-book headline (safe simple aggregate)
		if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS loans, COALESCE(SUM(outstanding_principal_kobo), 0) AS outstanding FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')`); len(rows) > 0 {
			dash["book_loans"] = rows[0]["loans"]
			dash["book_outstanding_kobo"] = rows[0]["outstanding"]
		}

		respond(w, dash, "pg")
	}
}

// riskOriginationLive reports whether the origination pipeline has any rows at all.
// app.loan_applications is empty until the first application is raised in the workspace
// or synced in from Phoenix, and that emptiness silently blanked App Review, Eye Score,
// the concentration panel and three Overview KPIs. Endpoints that depend on it now say
// so explicitly instead of returning a convincing zero.
//
// This is a "no rows yet" signal, NOT a feature flag — App Review and Eye Score are
// fully built and stay wired up; they simply have nothing to show until data arrives.
func riskOriginationLive(ctx context.Context, db *core.DB) bool {
	rows, err := db.PGQuery(ctx, `SELECT EXISTS (SELECT 1 FROM loan_applications LIMIT 1) AS live`)
	if err != nil || len(rows) == 0 {
		return false
	}
	live, _ := rows[0]["live"].(bool)
	return live
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
				stage,
				status,
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

// riskEmptyReviewKPIs carries origination_live so the UI can distinguish "nothing
// pending today" (a good day) from "this pipeline does not exist here" (a blank page
// that used to look identical).
func riskEmptyReviewKPIs() map[string]any {
	return map[string]any{
		"reviewed": 0, "approved": 0, "declined": 0, "pending": 0,
		"origination_live": false,
	}
}

func riskReviewKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !riskOriginationLive(r.Context(), db) {
			respond(w, riskEmptyReviewKPIs(), "pg")
			return
		}
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
				respond(w, riskEmptyReviewKPIs(), "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, riskEmptyReviewKPIs(), "pg")
			return
		}
		rows[0]["origination_live"] = true
		respond(w, rows[0], "pg")
	}
}

// ── LoanBook ─────────────────────────────────────────────────────────────────

func riskLoanBook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dpd := qstr(r, "dpd")
		band := qstr(r, "band")
		q := qstr(r, "q")
		lim := qint(r, "limit", 200, 1, 500)
		off := qint(r, "offset", 0, 0, 1<<30)

		where, args, n := riskLoanBookWhere(dpd, band, q)
		base := riskLoanBookBase + where

		var total int64
		countRows, err := db.PGQuery(ctx, "SELECT COUNT(*) AS total "+base, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		dataArgs := append(args, lim, off)
		query := "SELECT * " + base + fmt.Sprintf(
			" ORDER BY dpd DESC NULLS LAST, outstanding_kobo DESC LIMIT $%d OFFSET $%d", n, n+1)

		rows, err := db.PGQuery(ctx, query, dataArgs...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// respondPaginated, not respond(map{data,total}) — the latter double-wraps
		// into { data: { data, total } }, which the frontend had to special-case.
		respondPaginated(w, rows, total, "pg")
	}
}

// riskLoanBookBase is the live Udara/CBS credit book projection shared by the list
// and its CSV export. DPD comes from the rebuilt amortisation schedule (see
// migration 151) rather than days past final maturity; risk_band/eye_score are
// derived from that DPD. The mirror carries no employer, so the concentration
// dimension it does carry — CBN economic sector — is surfaced instead, resolved to
// a name via app.cbn_sector_name so the UI stops printing raw codes like "41000".
const riskLoanBookBase = `FROM (
	SELECT cl.cbs_id AS id, cl.cbs_account_number AS reference,
	       ` + cbsLoanName + ` AS applicant_name, cl.cbs_customer_id AS applicant_cif,
	       app.cbn_sector_name(cl.economic_sector) AS sector, cl.product_name AS product_type,
	       cl.loan_amount_kobo AS amount_kobo, cl.outstanding_principal_kobo AS outstanding_kobo,
	       ` + cbsLoanDPD + ` AS dpd,
	       ` + cbsLoanArrears + ` AS arrears_kobo,
	       ` + cbsLoanBand + ` AS risk_band,
	       ` + cbsLoanScore + ` AS eye_score,
	       cl.status, cl.start_date AS booked_at, cl.maturity_date
	FROM cbs_loans cl WHERE cl.status NOT IN ('Closed','Revoked')
) la WHERE 1=1`

// riskLoanBookWhere builds the shared filter. The band filter is now actually
// applied — it used to be accepted, discarded (`_ = band`) and silently returned
// the unfiltered book, so the UI's band chips appeared to work and did nothing.
func riskLoanBookWhere(dpd, band, q string) (string, []any, int) {
	var extra strings.Builder
	var args []any
	n := 1

	switch dpd {
	case "current":
		extra.WriteString(" AND dpd < 30")
	case "par30":
		extra.WriteString(" AND dpd BETWEEN 30 AND 59")
	case "par60":
		extra.WriteString(" AND dpd BETWEEN 60 AND 89")
	case "par90":
		extra.WriteString(" AND dpd BETWEEN 90 AND 179")
	case "npl":
		extra.WriteString(" AND dpd >= 180")
	}
	if band != "" {
		multiIn(&extra, &args, &n, "risk_band", band)
	}
	if q != "" {
		extra.WriteString(fmt.Sprintf(" AND (applicant_name ILIKE $%d OR applicant_cif ILIKE $%d)", n, n))
		args = append(args, "%"+q+"%")
		n++
	}
	return extra.String(), args, n
}

// ── PortfolioHealth ───────────────────────────────────────────────────────────

func riskPortfolioKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		var dateWhere string
		var args []any
		n := 1
		if from != "" {
			dateWhere += fmt.Sprintf(" AND start_date::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			dateWhere += fmt.Sprintf(" AND start_date::date <= $%d", n)
			args = append(args, to)
			n++
		}
		_ = n
		// Live Udara/CBS credit book, open book = status NOT IN (Closed,Revoked).
		//
		// PAR/NPL are computed from the schedule-derived DPD (migration 151), not from
		// days past final maturity. On the live book that moved PAR30 from 12% to 48%
		// and NPL from 4% to 8%: the old proxy scored every not-yet-matured loan as
		// Current, including all six CBS had flagged 'Defaulting'.
		//
		// NOTE on `from`/`to`: these filter on start_date, i.e. "loans BOOKED in this
		// window", not "the book as at this date". The frontend labels the control
		// accordingly; there is no historical balance snapshot to support as-at.
		//
		// top_obligor_exposure_kobo replaces the hardcoded 0 that used to sit here. It
		// is single-obligor concentration off the live book (CBS carries no employer),
		// which is the concentration limit that can actually be checked today.
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE dpd > 90) / COUNT(*), 2)
				     ELSE 0 END AS npl_ratio_pct,
				CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE dpd > 30) / COUNT(*), 2)
				     ELSE 0 END AS par30_rate_pct,
				CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE dpd > 60) / COUNT(*), 2)
				     ELSE 0 END AS par60_rate_pct,
				COALESCE(ROUND(AVG(score)), 0) AS avg_credit_score,
				COALESCE(SUM(outstanding_principal_kobo), 0) AS total_book_kobo,
				COALESCE(SUM(arrears_kobo), 0) AS total_arrears_kobo,
				COUNT(*) AS total_active_loans,
				(SELECT COALESCE(MAX(e), 0) FROM (
				   SELECT SUM(outstanding_principal_kobo) AS e
				   FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')
				   GROUP BY cbs_customer_id) o) AS top_obligor_exposure_kobo
			FROM (
				SELECT outstanding_principal_kobo,
				       `+cbsLoanDPDBare+` AS dpd,
				       `+cbsLoanArrearsBare+` AS arrears_kobo,
				       `+cbsLoanScoreBare+` AS score
				FROM cbs_loans
				WHERE status NOT IN ('Closed','Revoked')`+dateWhere+`
			) la`, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, riskEmptyPortfolioKPIs(), "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, riskEmptyPortfolioKPIs(), "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func riskEmptyPortfolioKPIs() map[string]any {
	return map[string]any{
		"npl_ratio_pct": 0, "par30_rate_pct": 0, "par60_rate_pct": 0,
		"avg_credit_score": 0, "top_obligor_exposure_kobo": 0,
		"total_book_kobo": 0, "total_arrears_kobo": 0, "total_active_loans": 0,
	}
}

func riskPARTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// PAR trend over the live CBS book, bucketed by disbursement month (start_date).
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				TO_CHAR(DATE_TRUNC('month', start_date), 'Mon YYYY') AS month,
				DATE_TRUNC('month', start_date) AS _sort,
				COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE dpd > 30), 0) AS par30_kobo,
				COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE dpd > 60), 0) AS par60_kobo,
				COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE dpd > 90), 0) AS par90_kobo
			FROM (
				SELECT start_date, outstanding_principal_kobo,
				       `+cbsLoanDPDBare+` AS dpd
				FROM cbs_loans
				WHERE status NOT IN ('Closed','Revoked')
				  AND start_date >= NOW() - INTERVAL '13 months'
			) la
			GROUP BY DATE_TRUNC('month', start_date)
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
		// Distribution across the DERIVED internal risk band (A best … E worst) over the
		// live CBS book. Udara holds no credit rating, so app.cbs_risk_band_dpd scores it
		// from repayment status + the schedule-derived DPD.
		//
		// The band vocabulary really is A-E. Every frontend used to map
		// Prime/Near-Prime/Sub-Prime/High-Risk against it, so the donut rendered a single
		// flat colour and the band filter chips could never match a row.
		rows, err := db.PGQuery(r.Context(), `
			WITH b AS (
				SELECT `+cbsLoanBandBare+` AS band
				FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')
			),
			totals AS (SELECT COUNT(*) AS grand_total FROM b)
			SELECT
				band,
				COUNT(*) AS count,
				CASE WHEN (SELECT grand_total FROM totals) > 0
				     THEN ROUND(100.0 * COUNT(*) / (SELECT grand_total FROM totals), 1)
				     ELSE 0 END AS pct
			FROM b
			GROUP BY band
			ORDER BY band`)
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
		// Concentration by Udara economic sector over the live CBS book.
		//
		// economic_sector holds the raw CBN numeric code ('41000'), and the Udara payload
		// carries no name beside it, so this chart used to be labelled "41000 — 39.6%".
		// app.cbn_sector_name resolves it via app.cbn_sector_codes; until that table is
		// populated from the authoritative CBN list it returns 'Sector <code>', which is
		// at least honestly an unresolved code rather than an invented sector name.
		rows, err := db.PGQuery(r.Context(), `
			WITH book AS (
				SELECT
					app.cbn_sector_name(economic_sector) AS sector,
					economic_sector AS sector_code,
					outstanding_principal_kobo AS book_kobo
				FROM cbs_loans
				WHERE status NOT IN ('Closed','Revoked')
			),
			totals AS (
				SELECT COALESCE(SUM(book_kobo), 0) AS grand_total FROM book
			)
			SELECT
				sector,
				MIN(sector_code) AS sector_code,
				COUNT(*) AS loan_count,
				COALESCE(SUM(book_kobo), 0) AS book_kobo,
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

// riskConcentrationSQL — employer concentration, the origination-era metric. Reads
// loan_applications, which is empty on this deployment.
const riskConcentrationEmployerSQL = `
	WITH book_total AS (
		SELECT COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0) AS grand_total
		FROM loan_applications WHERE status = 'active'
	)
	SELECT
		COALESCE(NULLIF(employer,''), 'Unknown') AS company,
		COUNT(*) AS staff_loans_count,
		COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0) AS book_kobo,
		CASE WHEN (SELECT grand_total FROM book_total) > 0
		     THEN ROUND(100.0 * COALESCE(SUM(COALESCE(outstanding_kobo, amount_requested_kobo, 0)), 0)
		          / (SELECT grand_total FROM book_total), 2)
		     ELSE 0 END AS pct_of_total,
		COUNT(*) FILTER (WHERE COALESCE(dpd, 0) > 30) AS par30_count
	FROM loan_applications
	WHERE status = 'active'
	GROUP BY COALESCE(NULLIF(employer,''), 'Unknown')
	ORDER BY book_kobo DESC
	LIMIT 20`

// riskConcentrationObligorSQL — single-obligor concentration off the live CBS book.
// This is the fallback when origination is not live, and it is a real risk limit in
// its own right: the CBS mirror carries no employer, but it does carry the borrower,
// and single-obligor exposure is the concentration cap that can actually be checked
// today. Previously this panel just rendered empty and the breach alert never fired.
const riskConcentrationObligorSQL = `
	WITH book AS (
		SELECT cl.cbs_customer_id AS cif,
		       ` + cbsLoanName + ` AS borrower,
		       cl.outstanding_principal_kobo AS book_kobo,
		       ` + cbsLoanDPD + ` AS dpd
		FROM cbs_loans cl WHERE cl.status NOT IN ('Closed','Revoked')
	),
	book_total AS (SELECT COALESCE(SUM(book_kobo), 0) AS grand_total FROM book)
	SELECT
		COALESCE(NULLIF(MAX(borrower),''), cif, 'Unknown') AS company,
		cif AS applicant_cif,
		COUNT(*) AS staff_loans_count,
		COALESCE(SUM(book_kobo), 0) AS book_kobo,
		CASE WHEN (SELECT grand_total FROM book_total) > 0
		     THEN ROUND(100.0 * COALESCE(SUM(book_kobo), 0)
		          / (SELECT grand_total FROM book_total), 2)
		     ELSE 0 END AS pct_of_total,
		COUNT(*) FILTER (WHERE dpd > 30) AS par30_count
	FROM book
	GROUP BY cif
	ORDER BY book_kobo DESC
	LIMIT 20`

// riskConcentration returns whichever concentration dimension the data supports, and
// says which one it picked so the UI can label the column honestly ("Employer" vs
// "Borrower") instead of showing borrowers under an "Employer" heading.
func riskConcentration(ctx context.Context, db *core.DB) (string, []core.Row) {
	basis := "obligor"
	query := riskConcentrationObligorSQL
	if riskOriginationLive(ctx, db) {
		basis = "employer"
		query = riskConcentrationEmployerSQL
	}
	rows, err := db.PGQuery(ctx, query)
	if err != nil || rows == nil {
		return basis, []core.Row{}
	}
	return basis, rows
}

func riskTopEmployers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		basis, rows := riskConcentration(r.Context(), db)
		respond(w, map[string]any{"basis": basis, "rows": rows}, "pg")
	}
}

// ── VintageAnalysis ───────────────────────────────────────────────────────────

func riskVintage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		product := qstr(r, "product")
		from := qstr(r, "from")
		to := qstr(r, "to")

		var extraClauses strings.Builder
		var args []any
		n := 1
		if product != "" {
			multiIn(&extraClauses, &args, &n, "product_name", product)
		}
		if from != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(approved_date, start_date)::date >= $%d", n))
			args = append(args, from)
			n++
		}
		if to != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(approved_date, start_date)::date <= $%d", n))
			args = append(args, to)
			n++
		}
		_ = n

		// Vintage cohorts by booking month (Udara approvedDate, falling back to startDate)
		// over the live CBS book. PAR = days past maturity_date.
		rows, err := db.PGQuery(ctx, `
			SELECT
				TO_CHAR(DATE_TRUNC('month', COALESCE(approved_date, start_date)), 'Mon YYYY') AS booking_month,
				DATE_TRUNC('month', COALESCE(approved_date, start_date)) AS _sort,
				COUNT(*) AS cohort_count,
				CASE WHEN DATE_TRUNC('month', COALESCE(approved_date, start_date)) <= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_1m,
				CASE WHEN DATE_TRUNC('month', COALESCE(approved_date, start_date)) <= DATE_TRUNC('month', NOW()) - INTERVAL '3 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_3m,
				CASE WHEN DATE_TRUNC('month', COALESCE(approved_date, start_date)) <= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_6m,
				CASE WHEN DATE_TRUNC('month', COALESCE(approved_date, start_date)) <= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*), 0), 1) END AS par30_12m
			FROM cbs_loans
			WHERE status NOT IN ('Closed','Revoked')`+extraClauses.String()+`
			GROUP BY DATE_TRUNC('month', COALESCE(approved_date, start_date))
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
		from := qstr(r, "from")
		to := qstr(r, "to")

		var extraClauses strings.Builder
		var args []any
		n := 1
		if product != "" {
			multiIn(&extraClauses, &args, &n, "product_name", product)
		}
		if from != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(approved_date, start_date)::date >= $%d", n))
			args = append(args, from)
			n++
		}
		if to != "" {
			extraClauses.WriteString(fmt.Sprintf(" AND COALESCE(approved_date, start_date)::date <= $%d", n))
			args = append(args, to)
			n++
		}
		_ = n

		rows, err := db.PGQuery(ctx, `
			WITH cohorts AS (
				SELECT
					DATE_TRUNC('month', COALESCE(approved_date, start_date)) AS booking_month,
					ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
					      / NULLIF(COUNT(*), 0), 1) AS par30_rate
				FROM cbs_loans
				WHERE status NOT IN ('Closed','Revoked')`+extraClauses.String()+`
				GROUP BY DATE_TRUNC('month', COALESCE(approved_date, start_date))
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
				"booking_month":     month,
				"total_count":       0,
				"active_count":      0,
				"active_book_kobo":  0,
				"written_off_count": 0,
				"par30_rate_pct":    0,
				"par60_rate_pct":    0,
				"par90_rate_pct":    0,
				"npl_rate_pct":      0,
				"avg_eye_score":     0,
				"historical_par":    []any{},
				"dpd_buckets":       []any{},
				"sectors":           []any{},
				"products":          []any{},
				"loans":             []any{},
			}, "pg")
		}

		// 1. All aggregate stats + DPD buckets + historical PAR milestones in one query
		aggRows, err := db.PGQuery(ctx, `
			SELECT
				COUNT(*) AS total_count,
				COUNT(*) FILTER (WHERE status NOT IN ('Closed','Revoked')) AS active_count,
				COALESCE(SUM(outstanding_principal_kobo)
					FILTER (WHERE status NOT IN ('Closed','Revoked')), 0) AS active_book_kobo,
				COUNT(*) FILTER (WHERE status IN ('Expired','Revoked')) AS written_off_count,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS par30_rate_pct,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 60)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS par60_rate_pct,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 90)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS par90_rate_pct,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` >= 180)
				          / NULLIF(COUNT(*),0), 2) END, 0) AS npl_rate_pct,
				COALESCE(ROUND(AVG(`+cbsLoanScoreBare+`)), 0) AS avg_eye_score,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(approved_date, start_date)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_1m,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(approved_date, start_date)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '3 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_3m,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(approved_date, start_date)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_6m,
				CASE WHEN MIN(DATE_TRUNC('month', COALESCE(approved_date, start_date)))
				          <= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*),0), 1) END AS par30_12m,
				COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` < 30) AS dpd_current,
				COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` BETWEEN 30 AND 59) AS dpd_par30,
				COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` BETWEEN 60 AND 89) AS dpd_par60,
				COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` BETWEEN 90 AND 179) AS dpd_par90,
				COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` >= 180) AS dpd_npl
			FROM cbs_loans
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(approved_date, start_date)), 'Mon YYYY') = $1`,
			month)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				empty()
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(aggRows) == 0 {
			empty()
			return
		}
		agg := aggRows[0]

		// Build structured sub-arrays from the flat aggregate row
		historicalPAR := []map[string]any{
			{"age_label": "1m", "par30_pct": agg["par30_1m"]},
			{"age_label": "3m", "par30_pct": agg["par30_3m"]},
			{"age_label": "6m", "par30_pct": agg["par30_6m"]},
			{"age_label": "12m", "par30_pct": agg["par30_12m"]},
		}
		dpdBuckets := []map[string]any{
			{"label": "Current", "count": agg["dpd_current"]},
			{"label": "PAR30", "count": agg["dpd_par30"]},
			{"label": "PAR60", "count": agg["dpd_par60"]},
			{"label": "PAR90", "count": agg["dpd_par90"]},
			{"label": "NPL", "count": agg["dpd_npl"]},
		}

		// 2. Sector breakdown (top 10 by loan count). CBS carries no employer, so this
		// has always been economic sector — it was just returned under the key
		// "employer" and rendered under an "Employer" heading, showing raw CBN codes as
		// if they were company names. Returned as "sector" now, resolved to a name.
		sectorRows, err := db.PGQuery(ctx, `
			SELECT
				app.cbn_sector_name(economic_sector) AS sector,
				COUNT(*) AS count,
				COALESCE(SUM(outstanding_principal_kobo), 0) AS book_kobo,
				COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30) AS par30_count
			FROM cbs_loans
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(approved_date, start_date)), 'Mon YYYY') = $1
			GROUP BY app.cbn_sector_name(economic_sector)
			ORDER BY count DESC
			LIMIT 10`, month)
		if err != nil || sectorRows == nil {
			sectorRows = []core.Row{}
		}

		// 3. Product breakdown
		productRows, err := db.PGQuery(ctx, `
			SELECT
				COALESCE(NULLIF(product_name,''), 'Other') AS product_type,
				COUNT(*) AS count,
				COALESCE(SUM(outstanding_principal_kobo), 0) AS book_kobo,
				COALESCE(CASE WHEN COUNT(*) > 0
				     THEN ROUND(100.0 * COUNT(*) FILTER (WHERE `+cbsLoanDPDBare+` > 30)
				          / NULLIF(COUNT(*),0), 1) END, 0) AS par30_pct
			FROM cbs_loans
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(approved_date, start_date)), 'Mon YYYY') = $1
			GROUP BY COALESCE(NULLIF(product_name,''), 'Other')
			ORDER BY count DESC`, month)
		if err != nil || productRows == nil {
			productRows = []core.Row{}
		}

		// 4. Individual loans (up to 200, highest DPD first)
		loanRows, err := db.PGQuery(ctx, `
			SELECT
				cl.cbs_id AS id,
				cl.reference_number AS reference,
				`+cbsLoanName+` AS applicant_name,
				cl.cbs_customer_id AS applicant_cif,
				app.cbn_sector_name(cl.economic_sector) AS sector,
				cl.product_name AS product_type,
				cl.outstanding_principal_kobo AS outstanding_kobo,
				`+cbsLoanDPD+` AS dpd,
				`+cbsLoanBand+` AS risk_band,
				`+cbsLoanScore+` AS eye_score,
				cl.status,
				cl.maturity_date
			FROM cbs_loans cl
			WHERE TO_CHAR(DATE_TRUNC('month', COALESCE(cl.approved_date, cl.start_date)), 'Mon YYYY') = $1
			ORDER BY dpd DESC NULLS LAST
			LIMIT 200`, month)
		if err != nil || loanRows == nil {
			loanRows = []core.Row{}
		}

		respond(w, map[string]any{
			"booking_month":     month,
			"total_count":       agg["total_count"],
			"active_count":      agg["active_count"],
			"active_book_kobo":  agg["active_book_kobo"],
			"written_off_count": agg["written_off_count"],
			"par30_rate_pct":    agg["par30_rate_pct"],
			"par60_rate_pct":    agg["par60_rate_pct"],
			"par90_rate_pct":    agg["par90_rate_pct"],
			"npl_rate_pct":      agg["npl_rate_pct"],
			"avg_eye_score":     agg["avg_eye_score"],
			"historical_par":    historicalPAR,
			"dpd_buckets":       dpdBuckets,
			"sectors":           sectorRows,
			"products":          productRows,
			"loans":             loanRows,
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
		if !riskOriginationLive(r.Context(), db) {
			respond(w, map[string]any{
				"scored_today": 0, "avg_score_month": 0,
				"high_risk_count": 0, "requests_month": 0,
				"origination_live": false,
			}, "pg")
			return
		}
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

		// Loan history. This used to read loan_applications ONLY, which is empty on
		// this deployment — so every credit file 404'd, including for customers with
		// live loans sitting in the CBS book. The live book is now the primary source
		// and origination rows are unioned in behind it when the pipeline goes live.
		loans, err := db.PGQuery(ctx, `
			SELECT * FROM (
				SELECT
					cl.cbs_id::text AS id,
					COALESCE(NULLIF(cl.reference_number,''), cl.cbs_account_number) AS ref,
					COALESCE(NULLIF(cl.product_name,''), 'Loan') AS product,
					COALESCE(cl.loan_amount_kobo, 0) AS principal_kobo,
					COALESCE(cl.outstanding_principal_kobo, 0) AS outstanding_kobo,
					`+cbsLoanDPD+` AS dpd,
					`+cbsLoanArrears+` AS arrears_kobo,
					`+cbsLoanBand+` AS risk_band,
					`+cbsLoanScore+` AS eye_score,
					COALESCE(cl.status, 'unknown') AS status,
					COALESCE(cl.start_date, cl.approved_date)::text AS disbursed_at,
					COALESCE(cl.start_date, cl.approved_date) AS _sort,
					'cbs' AS source
				FROM cbs_loans cl
				WHERE cl.cbs_customer_id = $1
				UNION ALL
				SELECT
					'la-'||id::text AS id,
					COALESCE(reference, 'LA-'||id::text) AS ref,
					COALESCE(product_type, loan_type, 'Loan') AS product,
					COALESCE(amount_requested_kobo, 0) AS principal_kobo,
					COALESCE(outstanding_kobo, 0) AS outstanding_kobo,
					COALESCE(dpd, 0) AS dpd,
					0::bigint AS arrears_kobo,
					COALESCE(risk_band, '') AS risk_band,
					eye_score,
					COALESCE(status, 'unknown') AS status,
					COALESCE(disbursed_at, created_at)::text AS disbursed_at,
					COALESCE(disbursed_at, created_at) AS _sort,
					'origination' AS source
				FROM loan_applications
				WHERE applicant_cif = $1
			) h ORDER BY _sort DESC NULLS LAST`, cif)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		for _, l := range loans {
			delete(l, "_sort")
		}
		if len(loans) == 0 {
			respondErr(w, 404, "No credit file found for CIF")
			return
		}

		// Aggregate stats. "Open" has to cover both vocabularies: the CBS book uses
		// Active/Defaulting/Expired, origination uses active/disbursed.
		var totalOutstanding, totalArrears, totalCount, activeCount, worstDPD int64
		for _, l := range loans {
			totalCount++
			totalOutstanding += toInt64(l["outstanding_kobo"])
			totalArrears += toInt64(l["arrears_kobo"])
			switch strings.ToLower(str(l["status"])) {
			case "active", "disbursed", "defaulting", "expired":
				activeCount++
			}
			if dpd := toInt64(l["dpd"]); dpd > worstDPD {
				worstDPD = dpd
			}
		}

		// Score + band: prefer a real origination Eye Score if one exists, otherwise
		// fall back to the worst live band on the book so the file is never blank for a
		// customer who plainly has delinquent loans. `score_basis` tells the UI which it
		// got — the two are different scales and must not be labelled the same way.
		var eyeScore, eyeBand, dtiPct any
		scoreBasis := "none"
		eyeRows, _ := db.PGQuery(ctx, `
			SELECT eye_score, eye_rating, dti_pct
			FROM loan_applications
			WHERE applicant_cif = $1 AND eye_score IS NOT NULL
			ORDER BY created_at DESC LIMIT 1`, cif)
		if len(eyeRows) > 0 {
			eyeScore = eyeRows[0]["eye_score"]
			eyeBand = eyeRows[0]["eye_rating"]
			dtiPct = eyeRows[0]["dti_pct"]
			scoreBasis = "eye_score"
		} else {
			derived, _ := db.PGQuery(ctx, `
				SELECT MIN(`+cbsLoanScore+`) AS score,
				       MAX(`+cbsLoanBand+`) AS band
				FROM cbs_loans cl
				WHERE cl.cbs_customer_id = $1 AND cl.status NOT IN ('Closed','Revoked')`, cif)
			if len(derived) > 0 && derived[0]["score"] != nil {
				eyeScore = derived[0]["score"]
				eyeBand = derived[0]["band"]
				scoreBasis = "cbs_derived"
			}
		}

		// Customer info: try MSSQL first, fall back to PG loan_applications
		custRows, _, _ := db.DualQuery(ctx,
			`SELECT cif,
				COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') AS full_name,
				COALESCE(phone,'') AS phone,
				COALESCE(bvn,'') AS bvn,
				'unknown' AS kyc_status
			 FROM app.customers WHERE cif = $1 LIMIT 1`,
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
			"score_basis":            scoreBasis,
			"bureau_score":           nil, // no bureau integration yet
			"total_loan_count":       totalCount,
			"active_loan_count":      activeCount,
			"total_outstanding_kobo": totalOutstanding,
			"total_arrears_kobo":     totalArrears,
			"worst_dpd":              worstDPD,
			"dti_pct":                dtiPct,
			"kyc_status":             kycStatus,
			"bvn":                    bvn,
			"loans":                  loans,
		}, "pg")
	}
}
