package handlers

import (
	"math"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

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

// overviewKPIs returns the 4 executive KPIs:
// portfolio outstanding (kobo), collections rate (%), disbursements MTD (kobo), active customers.
func overviewKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		kpis := map[string]any{
			"portfolio_outstanding_kobo": int64(0),
			"collections_rate_pct":       0.0,
			"disbursements_mtd_kobo":     int64(0),
			"active_customers":           int64(0),
		}

		// Portfolio outstanding + collections rate from collection_assignments
		collRows, err := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(outstanding_kobo), 0) AS portfolio_outstanding_kobo,
				CASE WHEN COUNT(*) = 0 THEN 0::numeric
				     ELSE ROUND(
				       COUNT(CASE WHEN dpd_bucket = '0' THEN 1 END)::numeric
				       / COUNT(*)::numeric * 100, 1
				     )
				END AS collections_rate_pct
			FROM collection_assignments`)
		if err == nil && len(collRows) > 0 {
			kpis["portfolio_outstanding_kobo"] = collRows[0]["portfolio_outstanding_kobo"]
			kpis["collections_rate_pct"] = collRows[0]["collections_rate_pct"]
		}

		// Disbursements MTD + active customers from loan_applications
		loanRows, err := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(
					CASE WHEN stage = 'active'
					     AND DATE_TRUNC('month', updated_at) = DATE_TRUNC('month', NOW())
					THEN amount_approved_kobo END
				), 0) AS disbursements_mtd_kobo,
				COUNT(CASE WHEN stage = 'active' THEN 1 END) AS active_customers
			FROM loan_applications`)
		if err == nil && len(loanRows) > 0 {
			kpis["disbursements_mtd_kobo"] = loanRows[0]["disbursements_mtd_kobo"]
			kpis["active_customers"] = loanRows[0]["active_customers"]
		}

		respond(w, kpis, "pg")
	}
}

// overviewMonthlyVolume returns 12 months of disbursements for the area chart.
func overviewMonthlyVolume(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
				SELECT generate_series(
					DATE_TRUNC('month', NOW() - INTERVAL '11 months'),
					DATE_TRUNC('month', NOW()),
					'1 month'::interval
				) AS m
			)
			SELECT
				TO_CHAR(m.m, 'Mon YY')                           AS month,
				m.m                                              AS month_sort,
				COALESCE(SUM(la.amount_approved_kobo), 0)        AS disbursements_kobo
			FROM months m
			LEFT JOIN loan_applications la
				ON la.stage = 'active'
				AND DATE_TRUNC('month', la.updated_at) = m.m
			GROUP BY m.m
			ORDER BY m.m`)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewProductMix returns loan count + volume by product type for the donut chart.
func overviewProductMix(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(product_type, 'Other') AS product,
				COUNT(*)                         AS count,
				COALESCE(SUM(amount_approved_kobo), 0) AS volume_kobo
			FROM loan_applications
			WHERE stage NOT IN ('declined', 'closed')
			GROUP BY product_type
			ORDER BY count DESC`)
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

// overviewTopPerformers returns the top 10 loan officers by disbursements MTD.
func overviewTopPerformers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				u.full_name                               AS name,
				u.role                                    AS dept,
				COALESCE(SUM(la.amount_approved_kobo), 0) AS amount_kobo,
				COUNT(la.id)                              AS count
			FROM loan_applications la
			JOIN o3c_users u ON u.id = la.sales_officer_id
			WHERE la.stage = 'active'
			  AND DATE_TRUNC('month', la.updated_at) = DATE_TRUNC('month', NOW())
			GROUP BY u.id, u.full_name, u.role
			ORDER BY amount_kobo DESC
			LIMIT 10`)
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
			"doc_review":   0,
			"credit_check": 0,
			"risk_review":  0,
			"approved":     toInt64(row["approved"]),
			"issuance":     toInt64(row["issuance"]),
			"active":       active,
		}, "pg")
	}
}

// overviewFDSummary returns fixed deposit book summary.
func overviewFDSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		empty := map[string]any{
			"total_fd_book_kobo": 0, "active_fd_count": 0,
			"maturing_30d": 0, "new_this_month": 0,
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(CASE WHEN transaction_type='inflow' THEN 1 END)                                    AS active_fd_count,
				COALESCE(SUM(CASE WHEN transaction_type='inflow' THEN principal END)::bigint * 100, 0)   AS total_fd_book_kobo,
				COUNT(CASE WHEN transaction_type='inflow'
				           AND maturity_date BETWEEN NOW()::date AND (NOW()+INTERVAL'30 days')::date
				      THEN 1 END)                                                                         AS maturing_30d,
				COUNT(CASE WHEN transaction_type='inflow'
				           AND DATE_TRUNC('month',transaction_date)=DATE_TRUNC('month',NOW())
				      THEN 1 END)                                                                         AS new_this_month
			FROM fd_transactions`)
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
		respond(w, map[string]any{
			"disputes_open":            disputes,
			"green_count":              toInt64(row["green_count"]),
			"green_outstanding_kobo":   0,
			"gold_count":               toInt64(row["gold_count"]),
			"gold_outstanding_kobo":    0,
			"platinum_count":           toInt64(row["platinum_count"]),
			"platinum_outstanding_kobo": 0,
			"prepaid_ngn_count":        toInt64(row["prepaid_ngn_count"]),
			"prepaid_ngn_balance_kobo": 0,
			"prepaid_usd_count":        toInt64(row["prepaid_usd_count"]),
			"prepaid_usd_balance_cents": 0,
			"credit_ngn_count":         toInt64(row["credit_ngn_count"]),
			"credit_ngn_balance_kobo":  0,
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
	}
	return 0
}

func round1(f float64) float64 {
	return math.Round(f*10) / 10
}
