package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterCardsCredit mounts the revolving credit-card portfolio analytics under
// /api/cards-credit. Source is card_cycle_data (ingested cycle balances) joined to
// card_products where category='credit' — i.e. true revolving credit cards, not
// prepaid/Blink. Point-in-time views use the latest available cycle_date.
func RegisterCardsCredit(r chi.Router, db *core.DB) {
	access := core.RequirePages("cards")
	r.With(access).Get("/kpis", ccKPIs(db))
	r.With(access).Get("/utilization-distribution", ccUtilizationDist(db))
	r.With(access).Get("/interest-trend", ccInterestTrend(db))
	r.With(access).Get("/receivables-trend", ccReceivablesTrend(db))
	r.With(access).Get("/by-product", ccByProduct(db))
	r.With(access).Get("/accounts", ccAccounts(db))
	r.With(access).Post("/import", cardCycleImport(db))
}

// latest cycle_date across all credit-card cycle rows, as a scalar subquery.
const ccLatestCycle = `(SELECT MAX(d2.cycle_date)
	FROM card_cycle_data d2
	JOIN card_products p2 ON p2.product_code = d2.product_code AND p2.category='credit')`

// ccKPIs — revolving portfolio headline metrics at the latest cycle.
func ccKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{
			"cycle_date":            nil,
			"accounts":              int64(0),
			"total_receivables_kobo": int64(0),
			"total_credit_limit_kobo": int64(0),
			"utilization_pct":       0.0,
			"interest_income_kobo":  int64(0),
			"min_payment_due_kobo":  int64(0),
			"overdue_kobo":          int64(0),
			"overdue_accounts":      int64(0),
			"delinquency_rate_pct":  0.0,
			"avg_balance_kobo":      int64(0),
			"purchases_kobo":        int64(0),
			"cash_advance_kobo":     int64(0),
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				TO_CHAR(d.cycle_date,'YYYY-MM-DD')                    AS cycle_date,
				COUNT(*)                                              AS accounts,
				COALESCE(SUM(d.outstanding_balance_kobo),0)::bigint   AS total_receivables_kobo,
				COALESCE(SUM(d.credit_limit_kobo),0)::bigint          AS total_credit_limit_kobo,
				COALESCE(SUM(d.total_interest_kobo),0)::bigint        AS interest_income_kobo,
				COALESCE(SUM(d.minimum_payment_kobo),0)::bigint       AS min_payment_due_kobo,
				COALESCE(SUM(d.overdue_amount_kobo),0)::bigint        AS overdue_kobo,
				COUNT(*) FILTER (WHERE d.overdue_amount_kobo > 0)     AS overdue_accounts,
				COALESCE(SUM(d.purchase_amount_kobo),0)::bigint       AS purchases_kobo,
				COALESCE(SUM(d.cash_advance_kobo),0)::bigint          AS cash_advance_kobo
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
			WHERE d.cycle_date = `+ccLatestCycle+`
			GROUP BY d.cycle_date`)
		if err == nil && len(rows) > 0 {
			row := rows[0]
			accounts := toInt64(row["accounts"])
			recv := toInt64(row["total_receivables_kobo"])
			limit := toInt64(row["total_credit_limit_kobo"])
			overdueAcct := toInt64(row["overdue_accounts"])
			out["cycle_date"] = row["cycle_date"]
			out["accounts"] = accounts
			out["total_receivables_kobo"] = recv
			out["total_credit_limit_kobo"] = limit
			out["interest_income_kobo"] = toInt64(row["interest_income_kobo"])
			out["min_payment_due_kobo"] = toInt64(row["min_payment_due_kobo"])
			out["overdue_kobo"] = toInt64(row["overdue_kobo"])
			out["overdue_accounts"] = overdueAcct
			out["purchases_kobo"] = toInt64(row["purchases_kobo"])
			out["cash_advance_kobo"] = toInt64(row["cash_advance_kobo"])
			if limit > 0 {
				out["utilization_pct"] = round1(float64(recv) / float64(limit) * 100)
			}
			if accounts > 0 {
				out["delinquency_rate_pct"] = round1(float64(overdueAcct) / float64(accounts) * 100)
				out["avg_balance_kobo"] = recv / accounts
			}
		}
		respond(w, out, "pg")
	}
}

// ccUtilizationDist — per-account utilization buckets at the latest cycle.
func ccUtilizationDist(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			WITH acct AS (
				SELECT CASE
					WHEN d.credit_limit_kobo <= 0 THEN 'No limit'
					WHEN d.outstanding_balance_kobo::numeric / d.credit_limit_kobo <= 0.30 THEN '0–30%'
					WHEN d.outstanding_balance_kobo::numeric / d.credit_limit_kobo <= 0.50 THEN '30–50%'
					WHEN d.outstanding_balance_kobo::numeric / d.credit_limit_kobo <= 0.80 THEN '50–80%'
					WHEN d.outstanding_balance_kobo::numeric / d.credit_limit_kobo <= 1.00 THEN '80–100%'
					ELSE 'Over limit'
				END AS bucket,
				d.outstanding_balance_kobo
				FROM card_cycle_data d
				JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
				WHERE d.cycle_date = `+ccLatestCycle+`
			)
			SELECT bucket, COUNT(*) AS count, COALESCE(SUM(outstanding_balance_kobo),0)::bigint AS outstanding_kobo
			FROM acct GROUP BY bucket
			ORDER BY CASE bucket
				WHEN '0–30%' THEN 1 WHEN '30–50%' THEN 2 WHEN '50–80%' THEN 3
				WHEN '80–100%' THEN 4 WHEN 'Over limit' THEN 5 ELSE 6 END`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ccInterestTrend — interest income per cycle (last 12 cycles).
func ccInterestTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(d.cycle_date,'YYYY-MM-DD') AS cycle_date,
				COALESCE(SUM(d.total_interest_kobo),0)::bigint AS interest_kobo,
				COALESCE(SUM(d.fees_kobo),0)::bigint           AS fees_kobo
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
			GROUP BY d.cycle_date
			ORDER BY d.cycle_date DESC
			LIMIT 12`)
		// return chronological
		for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
			rows[i], rows[j] = rows[j], rows[i]
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ccReceivablesTrend — outstanding vs overdue per cycle (last 12 cycles).
func ccReceivablesTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(d.cycle_date,'YYYY-MM-DD') AS cycle_date,
				COALESCE(SUM(d.outstanding_balance_kobo),0)::bigint AS outstanding_kobo,
				COALESCE(SUM(d.overdue_amount_kobo),0)::bigint      AS overdue_kobo
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
			GROUP BY d.cycle_date
			ORDER BY d.cycle_date DESC
			LIMIT 12`)
		for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
			rows[i], rows[j] = rows[j], rows[i]
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ccByProduct — revolving portfolio split by credit-card product at latest cycle.
func ccByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(p.product_name,''), d.product_code) AS product,
				COUNT(*)                                            AS accounts,
				COALESCE(SUM(d.outstanding_balance_kobo),0)::bigint AS outstanding_kobo,
				COALESCE(SUM(d.credit_limit_kobo),0)::bigint        AS credit_limit_kobo,
				COALESCE(SUM(d.total_interest_kobo),0)::bigint      AS interest_kobo,
				COALESCE(SUM(d.overdue_amount_kobo),0)::bigint      AS overdue_kobo,
				COALESCE(SUM(d.minimum_payment_kobo),0)::bigint     AS min_payment_kobo,
				CASE WHEN SUM(d.credit_limit_kobo) > 0
					THEN ROUND(SUM(d.outstanding_balance_kobo)::numeric / SUM(d.credit_limit_kobo) * 100, 1)
					ELSE 0 END                                      AS utilization_pct
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
			WHERE d.cycle_date = `+ccLatestCycle+`
			GROUP BY 1
			ORDER BY outstanding_kobo DESC`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ccAccounts — top revolving accounts by outstanding at latest cycle (paged).
func ccAccounts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)
		q := "%" + r.URL.Query().Get("q") + "%"
		onlyOverdue := r.URL.Query().Get("overdue") == "1"
		overdueClause := ""
		if onlyOverdue {
			overdueClause = " AND d.overdue_amount_kobo > 0"
		}
		rows, _ := db.PGQuery(r.Context(), `
			SELECT d.account_number, d.cif, p.product_name,
				d.outstanding_balance_kobo, d.credit_limit_kobo, d.overdue_amount_kobo,
				d.minimum_payment_kobo, d.total_interest_kobo,
				CASE WHEN d.credit_limit_kobo > 0
					THEN ROUND(d.outstanding_balance_kobo::numeric / d.credit_limit_kobo * 100, 1)
					ELSE 0 END AS utilization_pct
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
			WHERE d.cycle_date = `+ccLatestCycle+`
			  AND ($1 = '%%' OR d.account_number ILIKE $1 OR d.cif ILIKE $1)`+overdueClause+`
			ORDER BY d.outstanding_balance_kobo DESC
			LIMIT $2 OFFSET $3`, q, limit, offset)
		if rows == nil {
			rows = []core.Row{}
		}
		var total int64
		if tr, err := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS c
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
			WHERE d.cycle_date = `+ccLatestCycle+`
			  AND ($1 = '%%' OR d.account_number ILIKE $1 OR d.cif ILIKE $1)`+overdueClause, q); err == nil && len(tr) > 0 {
			total = toInt64(tr[0]["c"])
		}
		respond(w, map[string]any{"data": rows, "total": total}, "pg")
	}
}
