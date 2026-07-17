package handlers

import (
	"fmt"
	"net/http"

	"github.com/o3c/reports/core"
)

/* ── GET /api/cards/products ──────────────────────────────────────────────── */

func cardProducts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "category"); v != "" {
			where += fmt.Sprintf(" AND category=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "card_type"); v != "" {
			where += fmt.Sprintf(" AND card_type=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "is_active"); v != "" {
			where += fmt.Sprintf(" AND is_active=$%d", n); args = append(args, v == "true"); n++
		}
		_ = n

		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT * FROM card_products WHERE %s ORDER BY is_active DESC, product_name`, where),
			args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

/* ── GET /api/cards/cycle-dates ───────────────────────────────────────────── */
// Returns list of distinct cycle dates available in the data feed, newest first.

func cardCycleDates(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT DISTINCT TO_CHAR(cycle_date,'YYYY-MM-DD') AS cycle_date FROM card_cycle_data ORDER BY cycle_date DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

/* ── GET /api/cards/cycle-data ────────────────────────────────────────────── */
// Paginated account-level cycle data.
// Filters: cycle_date, product_code, cif, account_number, currency, overdue_only
// Sort: outstanding_balance_kobo DESC by default

func cardCycleData(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "cycle_date"); v != "" {
			where += fmt.Sprintf(" AND cycle_date=$%d::date", n); args = append(args, v); n++
		}
		if v := qstr(r, "product_code"); v != "" {
			where += fmt.Sprintf(" AND product_code=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "cif"); v != "" {
			where += fmt.Sprintf(" AND cif=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "account_number"); v != "" {
			where += fmt.Sprintf(" AND account_number ILIKE $%d", n); args = append(args, "%"+v+"%"); n++
		}
		if v := qstr(r, "currency"); v != "" {
			where += fmt.Sprintf(" AND currency=$%d", n); args = append(args, v); n++
		}
		if qstr(r, "overdue_only") == "true" {
			where += " AND overdue_amount_kobo > 0"
		}

		limit  := qint(r, "limit", 200, 1, 1000)
		offset := qint(r, "offset", 0, 0, 1<<30)

		countRows, _ := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT COUNT(*) AS total FROM card_cycle_data WHERE %s`, where), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		args2 := append(args, limit, offset)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  d.*,
			  p.product_name,
			  p.category,
			  p.card_type
			FROM card_cycle_data d
			LEFT JOIN card_products p ON p.product_code = d.product_code
			WHERE %s
			ORDER BY outstanding_balance_kobo DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1), args2...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}

		respondPaginated(w, rows, total, "json")
	}
}

/* ── GET /api/cards/cycle-summary ─────────────────────────────────────────── */
// Aggregate summary by product for a given cycle date (or all cycles).
// Returns totals per product: account_count, total_outstanding, total_overdue,
// total_interest, total_credit_limit, overdue_accounts.

func cardCycleSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "cycle_date"); v != "" {
			where += fmt.Sprintf(" AND d.cycle_date=$%d::date", n); args = append(args, v); n++
		}
		if v := qstr(r, "category"); v != "" {
			where += fmt.Sprintf(" AND p.category=$%d", n); args = append(args, v); n++
		}
		_ = n

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  TO_CHAR(d.cycle_date,'YYYY-MM-DD')                        AS cycle_date,
			  d.product_code,
			  p.product_name,
			  p.category,
			  p.card_type,
			  d.currency,
			  COUNT(*)::BIGINT                                           AS account_count,
			  COUNT(*) FILTER (WHERE d.overdue_amount_kobo > 0)::BIGINT AS overdue_accounts,
			  COALESCE(SUM(d.outstanding_balance_kobo), 0)::BIGINT      AS total_outstanding_kobo,
			  COALESCE(SUM(d.overdue_amount_kobo),      0)::BIGINT      AS total_overdue_kobo,
			  COALESCE(SUM(d.total_interest_kobo),      0)::BIGINT      AS total_interest_kobo,
			  COALESCE(SUM(d.fees_kobo),                0)::BIGINT      AS total_fees_kobo,
			  COALESCE(SUM(d.penalty_kobo),             0)::BIGINT      AS total_penalty_kobo,
			  COALESCE(SUM(d.credit_limit_kobo),        0)::BIGINT      AS total_credit_limit_kobo,
			  COALESCE(SUM(d.purchase_amount_kobo),     0)::BIGINT      AS total_purchases_kobo,
			  COALESCE(SUM(d.cash_advance_kobo),        0)::BIGINT      AS total_cash_advance_kobo
			FROM card_cycle_data d
			LEFT JOIN card_products p ON p.product_code = d.product_code
			WHERE %s
			GROUP BY d.cycle_date, d.product_code, p.product_name, p.category, p.card_type, d.currency
			ORDER BY d.cycle_date DESC, d.currency, total_outstanding_kobo DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}
