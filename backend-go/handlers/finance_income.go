package handlers

import (
	"net/http"

	"github.com/o3c/workspace/core"
)

// Income statement — a real, transaction-derived revenue statement.
//
// Source is app.income_daily (a view that classifies the live transaction feed
// through the card/txn code map into interest / fee / penalty income, in
// naira). This replaces the old card-cycle summary that was frozen on a single
// July statement snapshot. There is no expense or GL data, so this is a
// top-line REVENUE statement, labelled as such — not a full P&L.

// finIncomeStatement — headline totals, prior-period comparison, daily trend
// and per-product / per-category breakdowns for a date range.
func finIncomeStatement(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")

		// Default window: the 30 days ending at the latest income date.
		if to == "" {
			if rows, _ := db.PGQuery(ctx,
				`SELECT to_char(MAX(income_date),'YYYY-MM-DD') AS d FROM app.income_daily`); len(rows) > 0 {
				to = str(rows[0]["d"])
			}
		}
		if to == "" {
			respond(w, map[string]any{"empty": true}, "pg")
			return
		}
		if from == "" {
			if rows, _ := db.PGQuery(ctx,
				`SELECT to_char($1::date - 29,'YYYY-MM-DD') AS d`, to); len(rows) > 0 {
				from = str(rows[0]["d"])
			}
		}

		out := map[string]any{"from": from, "to": to}

		catExpr := `
			COALESCE(SUM(amount_ngn) FILTER (WHERE category='interest'),0) AS interest_ngn,
			COALESCE(SUM(amount_ngn) FILTER (WHERE category='fee'),0)      AS fee_ngn,
			COALESCE(SUM(amount_ngn) FILTER (WHERE category='penalty'),0)  AS penalty_ngn,
			COALESCE(SUM(amount_ngn),0)                                    AS total_ngn,
			COALESCE(SUM(txn_count),0)                                     AS txn_count`

		// Loan interest income (accrual) for a window = interest DUE in [f,t] from the Udara
		// repayment schedule, in NAIRA (kobo/100). Folded into the statement so revenue
		// covers the full business (card book + loan book), not cards alone. FD interest is
		// a cost of funds and is deliberately NOT added to revenue here.
		loanInt := func(f, t string) float64 {
			if f == "" || t == "" {
				return 0
			}
			if rows, _ := db.PGQuery(ctx, `
				SELECT COALESCE(SUM(interest_kobo),0)::numeric / 100 AS v FROM app.cbs_loan_schedules
				WHERE payment_date BETWEEN $1::date AND $2::date`, f, t); len(rows) > 0 {
				return toFloat(rows[0]["v"])
			}
			return 0
		}
		// Fold loan interest into a card-income totals row so "Interest Income" and "Total
		// Revenue" reflect both books; card_interest / loan_interest are kept split too.
		foldLoan := func(row core.Row, loan float64) map[string]any {
			ci := toFloat(row["interest_ngn"])
			return map[string]any{
				"card_interest_ngn": ci,
				"loan_interest_ngn": loan,
				"interest_ngn":      ci + loan,
				"fee_ngn":           toFloat(row["fee_ngn"]),
				"penalty_ngn":       toFloat(row["penalty_ngn"]),
				"total_ngn":         toFloat(row["total_ngn"]) + loan,
				"txn_count":         toInt64(row["txn_count"]),
			}
		}

		// Totals for the window (card income + loan interest).
		curLoan := loanInt(from, to)
		if rows, _ := db.PGQuery(ctx, `
			SELECT `+catExpr+`
			FROM app.income_daily WHERE income_date BETWEEN $1::date AND $2::date`, from, to); len(rows) > 0 {
			out["totals"] = foldLoan(rows[0], curLoan)
		}

		// Prior equal-length window, for the delta chips.
		var prevFrom, prevTo string
		if rows, _ := db.PGQuery(ctx,
			`SELECT to_char($1::date - ($2::date - $1::date) - 1,'YYYY-MM-DD') AS pf,
			        to_char($1::date - 1,'YYYY-MM-DD') AS pt`, from, to); len(rows) > 0 {
			prevFrom, prevTo = str(rows[0]["pf"]), str(rows[0]["pt"])
		}
		if rows, _ := db.PGQuery(ctx, `
			WITH w AS (SELECT ($2::date - $1::date) AS span)
			SELECT `+catExpr+`
			FROM app.income_daily, w
			WHERE income_date BETWEEN ($1::date - w.span - 1) AND ($1::date - 1)`, from, to); len(rows) > 0 {
			out["prev"] = foldLoan(rows[0], loanInt(prevFrom, prevTo))
		}

		// Daily trend
		if rows, _ := db.PGQuery(ctx, `
			SELECT to_char(income_date,'YYYY-MM-DD') AS date,
			  COALESCE(SUM(amount_ngn) FILTER (WHERE category='interest'),0) AS interest_ngn,
			  COALESCE(SUM(amount_ngn) FILTER (WHERE category='fee'),0)      AS fee_ngn,
			  COALESCE(SUM(amount_ngn) FILTER (WHERE category='penalty'),0)  AS penalty_ngn,
			  COALESCE(SUM(amount_ngn),0)                                    AS total_ngn
			FROM app.income_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY income_date ORDER BY income_date`, from, to); rows != nil {
			out["trend"] = rows
		}

		// By product
		if rows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(product_name,''),'Unclassified') AS product_name,
			  COALESCE(SUM(amount_ngn) FILTER (WHERE category='interest'),0) AS interest_ngn,
			  COALESCE(SUM(amount_ngn) FILTER (WHERE category='fee'),0)      AS fee_ngn,
			  COALESCE(SUM(amount_ngn) FILTER (WHERE category='penalty'),0)  AS penalty_ngn,
			  COALESCE(SUM(amount_ngn),0)                                    AS total_ngn
			FROM app.income_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY total_ngn DESC LIMIT 20`, from, to); rows != nil {
			// Loan interest as its own product line, so the breakdown shows the loan book's
			// contribution alongside the card products. The frontend re-sorts by total.
			if curLoan > 0 {
				rows = append(rows, core.Row{
					"product_name": "Loans (interest)",
					"interest_ngn": curLoan, "fee_ngn": 0.0, "penalty_ngn": 0.0, "total_ngn": curLoan,
				})
			}
			out["by_product"] = rows
		}

		// By category (for the composition donut). Bump the interest slice by the loan
		// interest so the donut total reconciles with Total Revenue above.
		if rows, _ := db.PGQuery(ctx, `
			SELECT category,
			  COALESCE(SUM(amount_ngn),0) AS amount_ngn,
			  COALESCE(SUM(txn_count),0)  AS txn_count
			FROM app.income_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY category ORDER BY amount_ngn DESC`, from, to); rows != nil {
			if curLoan > 0 {
				bumped := false
				for _, rr := range rows {
					if str(rr["category"]) == "interest" {
						rr["amount_ngn"] = toFloat(rr["amount_ngn"]) + curLoan
						bumped = true
						break
					}
				}
				if !bumped {
					rows = append(rows, core.Row{"category": "interest", "amount_ngn": curLoan, "txn_count": int64(0)})
				}
			}
			out["by_category"] = rows
		}

		respond(w, out, "pg")
	}
}
