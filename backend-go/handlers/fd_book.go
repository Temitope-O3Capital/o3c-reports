package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterFDBook mounts the Fixed-Deposit book analytics under /api/fd-book.
// Source of truth is the CBS/Udara-synced cbs_fixed_deposits register (not the
// legacy native fd_transactions table). All routes require the fixed_deposit page.
func RegisterFDBook(r chi.Router, db *core.DB) {
	access := core.RequirePages("fixed_deposit")
	r.With(access).Get("/kpis", fdBookKPIs(db))
	r.With(access).Get("/maturity-ladder", fdBookMaturityLadder(db))
	r.With(access).Get("/book-trend", fdBookTrend(db))
	r.With(access).Get("/by-product", fdBookByProduct(db))
	r.With(access).Get("/tenor-distribution", fdBookTenorDist(db))
	r.With(access).Get("/list", fdBookList(db))
}

// fdBookKPIs — headline deposit-book metrics from cbs_fixed_deposits (Active book).
func fdBookKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{
			"total_principal_kobo":            int64(0),
			"total_ledger_kobo":               int64(0),
			"total_accrued_interest_kobo":     int64(0),
			"active_count":                    int64(0),
			"unique_customers":                int64(0),
			"weighted_avg_rate":               0.0,
			"weighted_avg_tenor_days":         0.0,
			"annualized_interest_expense_kobo": int64(0),
			"maturing_30d_count":              int64(0),
			"maturing_30d_kobo":               int64(0),
			"new_this_month_count":            int64(0),
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(SUM(principal_kobo)        FILTER (WHERE status='Active'), 0) AS total_principal_kobo,
				COALESCE(SUM(ledger_balance_kobo)   FILTER (WHERE status='Active'), 0) AS total_ledger_kobo,
				COALESCE(SUM(accrued_interest_kobo) FILTER (WHERE status='Active'), 0) AS total_accrued_interest_kobo,
				COUNT(*)                            FILTER (WHERE status='Active')     AS active_count,
				COUNT(DISTINCT cbs_customer_id)     FILTER (WHERE status='Active')     AS unique_customers,
				-- weighted average interest rate, weighted by principal
				COALESCE(SUM(principal_kobo * interest_rate) FILTER (WHERE status='Active' AND interest_rate IS NOT NULL)
					/ NULLIF(SUM(principal_kobo) FILTER (WHERE status='Active' AND interest_rate IS NOT NULL), 0), 0) AS weighted_avg_rate,
				COALESCE(SUM(principal_kobo * tenor_days) FILTER (WHERE status='Active' AND tenor_days IS NOT NULL)
					/ NULLIF(SUM(principal_kobo) FILTER (WHERE status='Active' AND tenor_days IS NOT NULL), 0), 0) AS weighted_avg_tenor_days,
				-- annualized interest-expense run-rate = principal * rate% per year
				COALESCE(SUM(principal_kobo * interest_rate / 100.0) FILTER (WHERE status='Active'), 0)::bigint AS annualized_interest_expense_kobo,
				COUNT(*)                     FILTER (WHERE status='Active' AND maturity_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS maturing_30d_count,
				COALESCE(SUM(principal_kobo) FILTER (WHERE status='Active' AND maturity_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30), 0) AS maturing_30d_kobo,
				COUNT(*)                     FILTER (WHERE commencement_date >= DATE_TRUNC('month', CURRENT_DATE)) AS new_this_month_count
			FROM cbs_fixed_deposits`)
		if err == nil && len(rows) > 0 {
			row := rows[0]
			out["total_principal_kobo"] = toInt64(row["total_principal_kobo"])
			out["total_ledger_kobo"] = toInt64(row["total_ledger_kobo"])
			out["total_accrued_interest_kobo"] = toInt64(row["total_accrued_interest_kobo"])
			out["active_count"] = toInt64(row["active_count"])
			out["unique_customers"] = toInt64(row["unique_customers"])
			out["weighted_avg_rate"] = round1(toFloat(row["weighted_avg_rate"]))
			out["weighted_avg_tenor_days"] = round1(toFloat(row["weighted_avg_tenor_days"]))
			out["annualized_interest_expense_kobo"] = toInt64(row["annualized_interest_expense_kobo"])
			out["maturing_30d_count"] = toInt64(row["maturing_30d_count"])
			out["maturing_30d_kobo"] = toInt64(row["maturing_30d_kobo"])
			out["new_this_month_count"] = toInt64(row["new_this_month_count"])
		}
		respond(w, out, "pg")
	}
}

// fdBookMaturityLadder — Active principal bucketed by days-to-maturity.
func fdBookMaturityLadder(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			WITH b AS (
				SELECT
					CASE
						WHEN maturity_date::date < CURRENT_DATE                              THEN 'Overdue'
						WHEN maturity_date::date <= CURRENT_DATE + 30                        THEN '0–30d'
						WHEN maturity_date::date <= CURRENT_DATE + 60                        THEN '31–60d'
						WHEN maturity_date::date <= CURRENT_DATE + 90                        THEN '61–90d'
						WHEN maturity_date::date <= CURRENT_DATE + 180                       THEN '91–180d'
						WHEN maturity_date::date <= CURRENT_DATE + 365                       THEN '181–365d'
						ELSE '365d+'
					END AS bucket,
					principal_kobo, accrued_interest_kobo
				FROM cbs_fixed_deposits
				WHERE status='Active' AND maturity_date IS NOT NULL
			)
			SELECT bucket,
				COUNT(*)                               AS count,
				COALESCE(SUM(principal_kobo), 0)       AS principal_kobo,
				COALESCE(SUM(accrued_interest_kobo),0) AS accrued_interest_kobo
			FROM b
			GROUP BY bucket
			ORDER BY CASE bucket
				WHEN 'Overdue' THEN 0 WHEN '0–30d' THEN 1 WHEN '31–60d' THEN 2 WHEN '61–90d' THEN 3
				WHEN '91–180d' THEN 4 WHEN '181–365d' THEN 5 ELSE 6 END`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookTrend — deposit-book size over time from the daily CBS portfolio snapshot.
func fdBookTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(snapshot_date, 'YYYY-MM-DD') AS date,
				fd_active_count        AS active_count,
				fd_principal_kobo      AS principal_kobo,
				fd_ledger_balance_kobo AS ledger_kobo
			FROM cbs_portfolio_snapshot
			WHERE snapshot_date >= CURRENT_DATE - INTERVAL '90 days'
			ORDER BY snapshot_date`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookByProduct — Active book split by FD product, with weighted rate.
func fdBookByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(product_name,''), product_code, 'Unknown') AS product,
				COUNT(*)                                AS count,
				COALESCE(SUM(principal_kobo), 0)        AS principal_kobo,
				COALESCE(SUM(accrued_interest_kobo), 0) AS accrued_interest_kobo,
				COALESCE(SUM(principal_kobo * interest_rate) / NULLIF(SUM(principal_kobo), 0), 0) AS avg_rate,
				COALESCE(SUM(principal_kobo * interest_rate / 100.0), 0)::bigint AS annual_interest_kobo
			FROM cbs_fixed_deposits
			WHERE status='Active'
			GROUP BY 1
			ORDER BY principal_kobo DESC`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookTenorDist — Active book bucketed by original tenor.
func fdBookTenorDist(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			WITH b AS (
				SELECT CASE
					WHEN tenor_days <= 30  THEN '≤30d'
					WHEN tenor_days <= 90  THEN '31–90d'
					WHEN tenor_days <= 180 THEN '91–180d'
					WHEN tenor_days <= 365 THEN '181–365d'
					ELSE '365d+'
				END AS bucket, principal_kobo
				FROM cbs_fixed_deposits
				WHERE status='Active' AND tenor_days IS NOT NULL
			)
			SELECT bucket, COUNT(*) AS count, COALESCE(SUM(principal_kobo),0) AS principal_kobo
			FROM b GROUP BY bucket
			ORDER BY CASE bucket
				WHEN '≤30d' THEN 1 WHEN '31–90d' THEN 2 WHEN '91–180d' THEN 3 WHEN '181–365d' THEN 4 ELSE 5 END`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookList — paginated Active deposit list for the book view.
func fdBookList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)
		q := "%" + r.URL.Query().Get("q") + "%"
		rows, _ := db.PGQuery(r.Context(), `
			SELECT cbs_account_number, cbs_customer_id, product_name, status,
				principal_kobo, accrued_interest_kobo, ledger_balance_kobo,
				interest_rate, tenor_days,
				TO_CHAR(commencement_date, 'YYYY-MM-DD') AS commencement_date,
				TO_CHAR(maturity_date, 'YYYY-MM-DD')     AS maturity_date
			FROM cbs_fixed_deposits
			WHERE ($1 = '%%' OR cbs_account_number ILIKE $1 OR cbs_customer_id ILIKE $1 OR product_name ILIKE $1)
			ORDER BY (status='Active') DESC, maturity_date NULLS LAST
			LIMIT $2 OFFSET $3`, q, limit, offset)
		if rows == nil {
			rows = []core.Row{}
		}
		var total int64
		if tr, err := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS c FROM cbs_fixed_deposits
			WHERE ($1 = '%%' OR cbs_account_number ILIKE $1 OR cbs_customer_id ILIKE $1 OR product_name ILIKE $1)`, q); err == nil && len(tr) > 0 {
			total = toInt64(tr[0]["c"])
		}
		respond(w, map[string]any{"data": rows, "total": total}, "pg")
	}
}
