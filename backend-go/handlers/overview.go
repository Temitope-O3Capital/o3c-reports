package handlers

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// overviewRange resolves the from/to query params into current + previous windows.
// Both present → custom range; otherwise defaults to the current month.
// The Executive Overview's period-flow widgets (disbursements, top performers) honor
// this window; point-in-time snapshots (portfolio, FD book, cards) are always "as of now".
func overviewRange(r *http.Request) (cs, ce, ps, pe time.Time) {
	from, to := qstr(r, "from"), qstr(r, "to")
	if from != "" && to != "" {
		if a, b, c, dd, err := periodDates("custom", from, to); err == nil {
			return a, b, c, dd
		}
	}
	a, b, c, dd, _ := periodDates("month", "", "")
	return a, b, c, dd
}

func RegisterOverview(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("overview"))
	r.Get("/kpis",               overviewKPIs(db))
	r.Get("/monthly-volume",     overviewMonthlyVolume(db))
	r.Get("/product-mix",        overviewProductMix(db))
	r.Get("/dpd-trend",          overviewDPDTrend(db))
	r.Get("/acquisition-funnel", overviewAcquisitionFunnel(db))
	r.Get("/top-performers",     overviewTopPerformers(db))
	r.Get("/los-stages",         overviewLOSStages(db))
	r.Get("/cc-stages",          overviewCCStages(db))
	r.Get("/fd-summary",         overviewFDSummary(db))
	r.Get("/cards-summary",      overviewCardsSummary(db))
	r.Get("/contact-center",     overviewContactCenter(db))
}

// overviewKPIs returns the executive KPIs from the real Udara/CBS loan book.
// The workspace-native loan_applications / collection_assignments tables are empty
// (the workspace is a front-end to Udara core banking), so headline values are read
// live from cbs_loans; sparkline history + vs-last-period deltas come from
// cbs_portfolio_snapshot (portfolio/performing/borrowers) and cbs_loans (disbursements).
func overviewKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		cs, ce, ps, pe := overviewRange(r)

		out := map[string]any{
			"portfolio_outstanding_kobo": int64(0),
			"fd_book_kobo":               int64(0),
			"active_cards":               int64(0),
			"performing_rate_pct":        0.0,
			"npl_rate_pct":               0.0,
			"disbursements_kobo":         int64(0),
			"active_customers":           int64(0),
			"active_loans":               int64(0),
			"portfolio_change_pct":       nil,
			"fd_change_pct":              nil,
			"performing_change_pct":      nil,
			"disbursements_change_pct":   nil,
			"customers_change_pct":       nil,
			"portfolio_series":           []int64{},
			"fd_series":                  []int64{},
			"performing_series":          []float64{},
			"disbursements_series":       []int64{},
			"customers_series":           []int64{},
		}

		// KPI 1 (Loan Book) — live from the CBS/Udara loan book.
		// open loans = NOT IN ('Closed','Revoked');  NPL = Defaulting/Expired.
		if rows, err := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE status NOT IN ('Closed','Revoked')), 0) AS outstanding_kobo,
				COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE status IN ('Defaulting','Expired')), 0)  AS npl_kobo,
				COUNT(*)                        FILTER (WHERE status = 'Active')                                 AS active_loans,
				COUNT(DISTINCT cbs_customer_id) FILTER (WHERE status = 'Active')                                 AS borrowers_active
			FROM cbs_loans`); err == nil && len(rows) > 0 {
			outstanding := toInt64(rows[0]["outstanding_kobo"])
			npl := toInt64(rows[0]["npl_kobo"])
			out["portfolio_outstanding_kobo"] = outstanding
			out["active_customers"] = toInt64(rows[0]["borrowers_active"])
			out["active_loans"] = toInt64(rows[0]["active_loans"])
			if outstanding > 0 {
				out["performing_rate_pct"] = round1(float64(outstanding-npl) / float64(outstanding) * 100)
				out["npl_rate_pct"] = round1(float64(npl) / float64(outstanding) * 100)
			}
		}

		// KPI 2 (FD Book) — live from the CBS/Udara fixed-deposit register (deposits liability).
		if rows, err := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(principal_kobo) FILTER (WHERE status = 'Active'), 0) AS fd_book_kobo
			FROM cbs_fixed_deposits`); err == nil && len(rows) > 0 {
			out["fd_book_kobo"] = toInt64(rows[0]["fd_book_kobo"])
		}

		// KPI 3 (Active Cards) — from the live card book (MSSQL dbo.Account or the
		// synced Postgres "Products" view when MSSQL is not configured).
		if rows, _, err := db.DualQuery(ctx,
			`SELECT SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS n FROM dbo.Account`,
			`SELECT COUNT(*) FILTER (WHERE "Account Status" IN ('Open','Active')) AS n FROM "Products"`,
		); err == nil && len(rows) > 0 {
			out["active_cards"] = toInt64(rows[0]["n"])
		}

		// Disbursements within the selected window (by loan start_date), + prev window.
		disb := func(s, e time.Time) int64 {
			if rows, err := db.PGQuery(ctx, `
				SELECT COALESCE(SUM(loan_amount_kobo), 0) AS v
				FROM cbs_loans
				WHERE start_date::date BETWEEN $1 AND $2`, d(s), d(e)); err == nil && len(rows) > 0 {
				return toInt64(rows[0]["v"])
			}
			return 0
		}
		curDisb := disb(cs, ce)
		out["disbursements_kobo"] = curDisb
		out["disbursements_change_pct"] = pctChange(float64(curDisb), float64(disb(ps, pe)))

		// Disbursements sparkline — real trailing 12-month monthly series.
		if rows, err := db.PGQuery(ctx, `
			WITH months AS (
				SELECT generate_series(DATE_TRUNC('month', NOW()) - INTERVAL '11 months',
				                       DATE_TRUNC('month', NOW()), '1 month'::interval) AS m)
			SELECT COALESCE(SUM(l.loan_amount_kobo), 0) AS v
			FROM months mo
			LEFT JOIN cbs_loans l ON DATE_TRUNC('month', l.start_date) = mo.m
			GROUP BY mo.m ORDER BY mo.m`); err == nil {
			ser := make([]int64, 0, len(rows))
			for _, row := range rows {
				ser = append(ser, toInt64(row["v"]))
			}
			out["disbursements_series"] = ser
		}

		// Portfolio / performing / borrowers sparklines — from the CBS daily snapshot
		// history (grows one point per day). vs-last-period = last vs first available point.
		if rows, err := db.PGQuery(ctx, `
			SELECT outstanding_principal_kobo, npl_kobo, borrowers_active, fd_principal_kobo
			FROM cbs_portfolio_snapshot
			WHERE snapshot_date >= (CURRENT_DATE - INTERVAL '29 days')
			ORDER BY snapshot_date`); err == nil && len(rows) > 0 {
			pSer := make([]int64, 0, len(rows))
			perfSer := make([]float64, 0, len(rows))
			cSer := make([]int64, 0, len(rows))
			fdSer := make([]int64, 0, len(rows))
			for _, row := range rows {
				o := toInt64(row["outstanding_principal_kobo"])
				n := toInt64(row["npl_kobo"])
				pSer = append(pSer, o)
				cSer = append(cSer, toInt64(row["borrowers_active"]))
				fdSer = append(fdSer, toInt64(row["fd_principal_kobo"]))
				if o > 0 {
					perfSer = append(perfSer, round1(float64(o-n)/float64(o)*100))
				} else {
					perfSer = append(perfSer, 0)
				}
			}
			out["portfolio_series"] = pSer
			out["performing_series"] = perfSer
			out["customers_series"] = cSer
			out["fd_series"] = fdSer
			if len(pSer) >= 2 {
				out["portfolio_change_pct"] = pctChange(float64(pSer[len(pSer)-1]), float64(pSer[0]))
				out["customers_change_pct"] = pctChange(float64(cSer[len(cSer)-1]), float64(cSer[0]))
				out["performing_change_pct"] = pctChange(perfSer[len(perfSer)-1], perfSer[0])
				out["fd_change_pct"] = pctChange(float64(fdSer[len(fdSer)-1]), float64(fdSer[0]))
			}
		}

		respond(w, out, "pg")
	}
}

// overviewMonthlyVolume returns the "Loan & FD payouts per month" chart: real loan
// disbursements (cbs_loans.start_date) and FD payouts at maturity
// (cbs_fixed_deposits.maturity_date), over a rolling window of 6 months back → 6 forward.
func overviewMonthlyVolume(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
				SELECT generate_series(
					DATE_TRUNC('month', NOW()) - INTERVAL '6 months',
					DATE_TRUNC('month', NOW()) + INTERVAL '6 months',
					'1 month'::interval
				) AS m
			)
			SELECT
				TO_CHAR(mo.m, 'Mon YY') AS month,
				mo.m                    AS month_sort,
				COALESCE((SELECT SUM(l.loan_amount_kobo) FROM cbs_loans l
				          WHERE DATE_TRUNC('month', l.start_date) = mo.m), 0) AS disbursements_kobo,
				COALESCE((SELECT SUM(f.principal_kobo + COALESCE(f.accrued_interest_kobo, 0))
				          FROM cbs_fixed_deposits f
				          WHERE DATE_TRUNC('month', f.maturity_date) = mo.m), 0) AS fd_payouts_kobo
			FROM months mo
			ORDER BY mo.m`)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewProductMix returns the book split across the three product LINES —
// Loans, Fixed Deposits and Cards — by book value (kobo) and account count.
// Cards value is 0 (no card-balance ledger is synced yet); its count still shows.
func overviewProductMix(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT 'Loans' AS product,
				(SELECT COUNT(*) FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')) AS count,
				(SELECT COALESCE(SUM(outstanding_principal_kobo),0) FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')) AS volume_kobo
			UNION ALL
			SELECT 'Fixed Deposits',
				(SELECT COUNT(*) FROM cbs_fixed_deposits WHERE status='Active'),
				(SELECT COALESCE(SUM(principal_kobo),0) FROM cbs_fixed_deposits WHERE status='Active')
			UNION ALL
			SELECT 'Cards',
				(SELECT COUNT(*) FROM "Products" WHERE "Account Status" IN ('Open','Active')),
				0
			ORDER BY volume_kobo DESC`)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewDPDTrend returns 6 months of PAR30/PAR60/PAR90 account counts for the stacked bar.
func overviewDPDTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
				SELECT generate_series(
					DATE_TRUNC('month', NOW() - INTERVAL '5 months'),
					DATE_TRUNC('month', NOW()),
					'1 month'::interval
				) AS m
			)
			SELECT
				TO_CHAR(m.m, 'Mon YY') AS month,
				m.m AS month_sort,
				COUNT(CASE WHEN ca.dpd_bucket = '1-30' THEN 1 END)                    AS par30,
				COUNT(CASE WHEN ca.dpd_bucket IN ('31-60','61-90') THEN 1 END)        AS par60,
				COUNT(CASE WHEN ca.dpd_bucket IN ('91-180','181-360') THEN 1 END)     AS par90
			FROM months m
			LEFT JOIN collection_assignments ca
				ON DATE_TRUNC('month', ca.updated_at) = m.m
			GROUP BY m.m
			ORDER BY m.m`)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewAcquisitionFunnel returns {leads, applications, approved, disbursed}.
func overviewAcquisitionFunnel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		leads := int64(0)
		db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM bd_leads`) // ignore err — just try

		leadsRows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM bd_leads`)
		if len(leadsRows) > 0 {
			leads = toInt64(leadsRows[0]["n"])
		}

		totals, err := db.PGQuery(ctx, `
			SELECT
				COUNT(*)                                                                           AS applications,
				COUNT(CASE WHEN stage NOT IN ('draft','submitted','declined','closed') THEN 1 END) AS approved,
				COUNT(CASE WHEN stage = 'active' THEN 1 END)                                       AS disbursed
			FROM loan_applications
			WHERE stage != 'declined'`)

		empty := map[string]any{"leads": leads, "applications": 0, "approved": 0, "disbursed": 0}
		if err != nil || len(totals) == 0 {
			respond(w, empty, "pg")
			return
		}
		row := totals[0]
		respond(w, map[string]any{
			"leads":        leads,
			"applications": toInt64(row["applications"]),
			"approved":     toInt64(row["approved"]),
			"disbursed":    toInt64(row["disbursed"]),
		}, "pg")
	}
}

// overviewTopPerformers returns the top 10 loan officers by disbursement amount
// within the selected window, from the CBS loan book (officer_name).
func overviewTopPerformers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := overviewRange(r)
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				officer_name                        AS name,
				'Loan Officer'                      AS dept,
				COALESCE(SUM(loan_amount_kobo), 0)  AS amount_kobo,
				COUNT(*)                            AS count
			FROM cbs_loans
			WHERE officer_name IS NOT NULL AND officer_name <> ''
			  AND start_date::date BETWEEN $1 AND $2
			GROUP BY officer_name
			ORDER BY amount_kobo DESC
			LIMIT 10`, d(cs), d(ce))
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewLOSStages returns current count of applications in each LOS stage.
func overviewLOSStages(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		rows, err := db.PGQuery(ctx, `
			SELECT
				COUNT(CASE WHEN stage = 'draft' THEN 1 END)               AS draft,
				COUNT(CASE WHEN stage = 'submitted' THEN 1 END)           AS submitted,
				COUNT(CASE WHEN stage = 'document_collection' THEN 1 END) AS document_collection,
				COUNT(CASE WHEN stage = 'risk_review' THEN 1 END)         AS risk_review,
				COUNT(CASE WHEN stage = 'risk_head_review' THEN 1 END)    AS risk_head_review,
				COUNT(CASE WHEN stage = 'pending_conditions' THEN 1 END)  AS pending_conditions,
				COUNT(CASE WHEN stage = 'finance_approval' THEN 1 END)    AS finance_approval,
				COUNT(CASE WHEN stage = 'booking' THEN 1 END)             AS booking,
				COUNT(CASE WHEN stage = 'active' THEN 1 END)              AS active_count
			FROM loan_applications
			WHERE stage NOT IN ('declined', 'closed')`)

		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"draft": 0, "submitted": 0, "document_collection": 0,
				"risk_review": 0, "risk_head_review": 0, "pending_conditions": 0,
				"finance_approval": 0, "booking": 0, "active_count": 0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// overviewCCStages returns card issuance pipeline stage counts.
func overviewCCStages(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		empty := map[string]any{
			"application": 0, "doc_review": 0, "credit_check": 0,
			"risk_review": 0, "approved": 0, "issuance": 0, "active": 0,
		}

		rows, err := db.PGQuery(ctx, `
			SELECT
				COUNT(CASE WHEN status = 'pending'                        THEN 1 END) AS application,
				COUNT(CASE WHEN status = 'doc_review'                     THEN 1 END) AS doc_review,
				COUNT(CASE WHEN status = 'credit_check'                   THEN 1 END) AS credit_check,
				COUNT(CASE WHEN status = 'risk_review'                    THEN 1 END) AS risk_review,
				COUNT(CASE WHEN status = 'approved'                       THEN 1 END) AS approved,
				COUNT(CASE WHEN status IN ('processing','dispatched')      THEN 1 END) AS issuance
			FROM card_issuance_requests`)
		if err != nil || len(rows) == 0 {
			respond(w, empty, "pg")
			return
		}

		// active card count from live card data
		activeRows, _, _ := db.DualQuery(ctx,
			`SELECT COUNT(*) AS n FROM dbo.Account WHERE Status IN ('Open','Active')`,
			`SELECT COUNT(*) AS n FROM "Products" WHERE "Account Status" IN ('Open','Active')`)
		active := int64(0)
		if len(activeRows) > 0 {
			active = toInt64(activeRows[0]["n"])
		}

		row := rows[0]
		respond(w, map[string]any{
			"application":  toInt64(row["application"]),
			"doc_review":   toInt64(row["doc_review"]),
			"credit_check": toInt64(row["credit_check"]),
			"risk_review":  toInt64(row["risk_review"]),
			"approved":     toInt64(row["approved"]),
			"issuance":     toInt64(row["issuance"]),
			"active":       active,
		}, "pg")
	}
}

// overviewFDSummary returns the fixed deposit book summary from the CBS/Udara register.
// principal_kobo is already in kobo (unlike the empty native fd_transactions table).
func overviewFDSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		empty := map[string]any{
			"total_fd_book_kobo": 0, "active_fd_count": 0,
			"maturing_30d": 0, "new_this_month": 0,
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE status = 'Active')                              AS active_fd_count,
				COALESCE(SUM(principal_kobo) FILTER (WHERE status = 'Active'), 0)      AS total_fd_book_kobo,
				COUNT(*) FILTER (WHERE status = 'Active'
					AND maturity_date BETWEEN NOW()::date AND (NOW()+INTERVAL '30 days')::date) AS maturing_30d,
				COUNT(*) FILTER (WHERE status = 'Active'
					AND DATE_TRUNC('month', commencement_date) = DATE_TRUNC('month', NOW()))    AS new_this_month
			FROM cbs_fixed_deposits`)
		if err != nil || len(rows) == 0 {
			respond(w, empty, "pg")
			return
		}
		row := rows[0]
		respond(w, map[string]any{
			"total_fd_book_kobo": toInt64(row["total_fd_book_kobo"]),
			"active_fd_count":    toInt64(row["active_fd_count"]),
			"maturing_30d":       toInt64(row["maturing_30d"]),
			"new_this_month":     toInt64(row["new_this_month"]),
		}, "pg")
	}
}

// overviewCardsSummary returns card counts by tier and product type.
func overviewCardsSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		empty := map[string]any{
			"disputes_open":            0,
			"green_count":              0, "green_outstanding_kobo":    0,
			"gold_count":               0, "gold_outstanding_kobo":     0,
			"platinum_count":           0, "platinum_outstanding_kobo": 0,
			"prepaid_ngn_count":        0, "prepaid_ngn_balance_kobo":  0,
			"prepaid_usd_count":        0, "prepaid_usd_balance_cents": 0,
			"credit_ngn_count":         0, "credit_ngn_balance_kobo":   0,
		}

		// Counts by card product / tier from live card data
		rows, _, err := db.DualQuery(ctx,
			`SELECT
				SUM(CASE WHEN LOWER(ISNULL(Card_Product,'')) LIKE '%green%'    THEN 1 ELSE 0 END) AS green_count,
				SUM(CASE WHEN LOWER(ISNULL(Card_Product,'')) LIKE '%gold%'     THEN 1 ELSE 0 END) AS gold_count,
				SUM(CASE WHEN LOWER(ISNULL(Card_Product,'')) LIKE '%platinum%' THEN 1 ELSE 0 END) AS platinum_count,
				SUM(CASE WHEN LOWER(ISNULL(Product_Name,'')) LIKE '%prep%'     THEN 1 ELSE 0 END) AS prepaid_ngn_count,
				SUM(CASE WHEN LOWER(ISNULL(Product_Name,'')) LIKE '%usd%'      THEN 1 ELSE 0 END) AS prepaid_usd_count,
				SUM(CASE WHEN LOWER(ISNULL(Product_Name,'')) LIKE '%classic%'
				      OR LOWER(ISNULL(Product_Name,'')) LIKE '%credit%'        THEN 1 ELSE 0 END) AS credit_ngn_count
			FROM dbo.Account WHERE Status IN ('Open','Active')`,
			`SELECT
				SUM(CASE WHEN LOWER(COALESCE("Card Product",'')) LIKE '%green%'    THEN 1 ELSE 0 END) AS green_count,
				SUM(CASE WHEN LOWER(COALESCE("Card Product",'')) LIKE '%gold%'     THEN 1 ELSE 0 END) AS gold_count,
				SUM(CASE WHEN LOWER(COALESCE("Card Product",'')) LIKE '%platinum%' THEN 1 ELSE 0 END) AS platinum_count,
				SUM(CASE WHEN LOWER(COALESCE("Product Name",'')) LIKE '%prep%'     THEN 1 ELSE 0 END) AS prepaid_ngn_count,
				SUM(CASE WHEN LOWER(COALESCE("Product Name",'')) LIKE '%usd%'      THEN 1 ELSE 0 END) AS prepaid_usd_count,
				SUM(CASE WHEN LOWER(COALESCE("Product Name",'')) LIKE '%classic%'
				      OR LOWER(COALESCE("Product Name",'')) LIKE '%credit%'        THEN 1 ELSE 0 END) AS credit_ngn_count
			FROM "Products" WHERE "Account Status" IN ('Open','Active')`)
		if err != nil || len(rows) == 0 {
			respond(w, empty, "pg")
			return
		}

		// Open disputes from card_ops schema
		disputesRows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n FROM card_disputes WHERE status NOT IN ('resolved','closed')`)
		disputes := int64(0)
		if len(disputesRows) > 0 {
			disputes = toInt64(disputesRows[0]["n"])
		}

		row := rows[0]

		// Balances from card_cycle_data (most recent billing cycle) joined to card_products.
		// Counts still come from the DualQuery above (MSSQL is the source of truth for active accounts).
		balRows, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(CASE WHEN LOWER(p.product_name) LIKE '%green%'    AND d.currency='NGN'
			               THEN d.outstanding_balance_kobo END), 0) AS green_outstanding_kobo,
			  COALESCE(SUM(CASE WHEN LOWER(p.product_name) LIKE '%gold%'     AND d.currency='NGN'
			               THEN d.outstanding_balance_kobo END), 0) AS gold_outstanding_kobo,
			  COALESCE(SUM(CASE WHEN LOWER(p.product_name) LIKE '%platinum%' AND d.currency='NGN'
			               THEN d.outstanding_balance_kobo END), 0) AS platinum_outstanding_kobo,
			  COALESCE(SUM(CASE WHEN p.category='prepaid' AND d.currency='NGN'
			               THEN d.outstanding_balance_kobo END), 0) AS prepaid_ngn_balance_kobo,
			  COALESCE(SUM(CASE WHEN p.category='prepaid' AND d.currency='USD'
			               THEN d.outstanding_balance_kobo END), 0) AS prepaid_usd_balance_cents,
			  COALESCE(SUM(CASE WHEN p.category='credit'  AND d.currency='NGN'
			               THEN d.outstanding_balance_kobo END), 0) AS credit_ngn_balance_kobo
			FROM card_cycle_data d
			LEFT JOIN card_products p ON p.product_code = d.product_code
			WHERE d.cycle_date = (SELECT MAX(cycle_date) FROM card_cycle_data)`)

		bal := map[string]any{}
		if len(balRows) > 0 {
			bal = balRows[0]
		}

		respond(w, map[string]any{
			"disputes_open":             disputes,
			"green_count":               toInt64(row["green_count"]),
			"green_outstanding_kobo":    toInt64(bal["green_outstanding_kobo"]),
			"gold_count":                toInt64(row["gold_count"]),
			"gold_outstanding_kobo":     toInt64(bal["gold_outstanding_kobo"]),
			"platinum_count":            toInt64(row["platinum_count"]),
			"platinum_outstanding_kobo": toInt64(bal["platinum_outstanding_kobo"]),
			"prepaid_ngn_count":         toInt64(row["prepaid_ngn_count"]),
			"prepaid_ngn_balance_kobo":  toInt64(bal["prepaid_ngn_balance_kobo"]),
			"prepaid_usd_count":         toInt64(row["prepaid_usd_count"]),
			"prepaid_usd_balance_cents": toInt64(bal["prepaid_usd_balance_cents"]),
			"credit_ngn_count":          toInt64(row["credit_ngn_count"]),
			"credit_ngn_balance_kobo":   toInt64(bal["credit_ngn_balance_kobo"]),
		}, "pg")
	}
}

// overviewContactCenter returns helpdesk/contact centre summary.
func overviewContactCenter(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		empty := map[string]any{
			"open_tickets": 0, "in_queue": 0, "avg_first_response_mins": 0.0,
			"sla_compliance_pct": 0.0, "resolved_today": 0, "escalations_open": 0,
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(CASE WHEN status IN ('open','in_progress')                            THEN 1 END) AS open_tickets,
				COUNT(CASE WHEN status = 'open' AND assigned_to IS NULL                    THEN 1 END) AS in_queue,
				COUNT(CASE WHEN status IN ('resolved','closed')
				           AND updated_at::date = NOW()::date                               THEN 1 END) AS resolved_today,
				COUNT(CASE WHEN priority = 'urgent'
				           AND status NOT IN ('resolved','closed')                          THEN 1 END) AS escalations_open,
				COALESCE(ROUND(AVG(
					EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60.0
				) FILTER (WHERE first_response_at IS NOT NULL), 1), 0)                                  AS avg_first_response_mins,
				COALESCE(ROUND(
					COUNT(CASE WHEN status IN ('resolved','closed')
					           AND (sla_due_at IS NULL OR updated_at <= sla_due_at) THEN 1 END)::numeric
					/ NULLIF(COUNT(CASE WHEN status IN ('resolved','closed') THEN 1 END), 0) * 100
				, 1), 0)                                                                                 AS sla_compliance_pct
			FROM helpdesk_tickets`)
		if err != nil || len(rows) == 0 {
			respond(w, empty, "pg")
			return
		}
		row := rows[0]
		respond(w, map[string]any{
			"open_tickets":            toInt64(row["open_tickets"]),
			"in_queue":                toInt64(row["in_queue"]),
			"resolved_today":          toInt64(row["resolved_today"]),
			"escalations_open":        toInt64(row["escalations_open"]),
			"avg_first_response_mins": toFloat(row["avg_first_response_mins"]),
			"sla_compliance_pct":      toFloat(row["sla_compliance_pct"]),
		}, "pg")
	}
}

// ── Numeric helpers (kept for potential use by other overview utilities) ─────

func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int32:
		return float64(t)
	case string:
		// pgx returns NUMERIC / AVG / weighted ratios as normalized strings.
		f, _ := strconv.ParseFloat(t, 64)
		return f
	}
	return 0
}

func round1(f float64) float64 {
	return math.Round(f*10) / 10
}
