package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterSettlement — daily settlement vs clearing summary from the Transactions table.
func RegisterSettlement(r chi.Router, db *core.DB) {
	access := core.RequirePages("settlement")
	r.With(access).Get("/summary", settlementSummary(db))
}

func settlementSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		var f Filter
		f.Date("Transaction_Date", "txn_date", dateFrom, dateTo)

		ctx := r.Context()

		// Totals breakdown: credit vs debit settlement volumes
		rows, src, err := db.DualQuery(ctx,
			`SELECT
			  txn_date::date            AS settlement_date,
			  COUNT(*)                  AS txn_count,
			  COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS credits,
			  COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0) AS debits,
			  COALESCE(SUM(amount),0)   AS net_position
			FROM app.transactions
			WHERE 1=1`+f.PG()+`
			GROUP BY txn_date::date
			ORDER BY settlement_date DESC`,
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Settlement query failed")
			return
		}
		respond(w, rows, src)
	}
}

// RegisterMobileApp — mobile app usage statistics from transaction activity.
func RegisterMobileApp(r chi.Router, db *core.DB) {
	access := core.RequirePages("mobile_app")
	r.With(access).Get("/summary", mobileAppSummary(db))
}

func mobileAppSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		var f Filter
		f.Date("Transaction_Date", "txn_date", dateFrom, dateTo)

		ctx := r.Context()

		// Monthly activity: distinct active users + transaction count
		rows, src, err := db.DualQuery(ctx,
			`SELECT
			  COUNT(DISTINCT cif)          AS active_users,
			  COUNT(*)                     AS txn_count,
			  COALESCE(SUM(amount),0)      AS total_volume,
			  COALESCE(AVG(amount),0)      AS avg_txn_size
			FROM app.transactions
			WHERE 1=1`+f.PG(),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Mobile app query failed")
			return
		}

		// Monthly trend
		trend, tSrc, err2 := db.DualQuery(ctx,
			`SELECT
			  TO_CHAR(DATE_TRUNC('month',txn_date),'Mon YYYY') AS month,
			  DATE_TRUNC('month',txn_date) AS month_sort,
			  COUNT(DISTINCT cif) AS active_users,
			  COUNT(*) AS txn_count
			FROM app.transactions
			GROUP BY DATE_TRUNC('month',txn_date)
			ORDER BY month_sort DESC
			LIMIT 12`)
		if err2 != nil {
			trend = []core.Row{}
			tSrc = src
		}

		respond(w, map[string]any{
			"summary": rows,
			"trend":   trend,
		}, pickSource([]string{src, tSrc}))
	}
}

// RegisterBlinkCard — Blink Card product stats from Products/Accounts tables.
func RegisterBlinkCard(r chi.Router, db *core.DB) {
	access := core.RequirePages("blink_card")
	r.With(access).Get("/summary", blinkCardSummary(db))
}

func blinkCardSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Card counts by status — scoped to the actual Blink product.
		// The Blink product is catalogued as "PREP Temporary Virtual" (notes='Blink'),
		// so match both the brand name and the product name. If nothing matches we return
		// an empty breakdown (honest) rather than dumping ALL products mislabeled as Blink.
		const blinkMS = `(Product_Name LIKE '%Blink%' OR Product_Name LIKE '%blink%' OR Product_Name LIKE '%PREP Temporary Virtual%')`
		const blinkPG = `(product_name ILIKE '%blink%' OR product_name ILIKE '%PREP Temporary Virtual%')`
		statusRows, src, err := db.DualQuery(ctx,
			`SELECT status, COUNT(*) AS count
			 FROM app.accounts
			 WHERE `+blinkPG+`
			 GROUP BY status
			 ORDER BY count DESC`)
		if err != nil {
			respondErr(w, 500, "Blink card query failed")
			return
		}
		if statusRows == nil {
			statusRows = []core.Row{}
		}

		// Monthly issuance trend — Blink product only.
		trend, tSrc, _ := db.DualQuery(ctx,
			`SELECT
			  TO_CHAR(DATE_TRUNC('month',opened_date),'Mon YYYY') AS month,
			  DATE_TRUNC('month',opened_date) AS month_sort,
			  COUNT(*) AS issued
			FROM app.accounts
			WHERE opened_date IS NOT NULL AND `+blinkPG+`
			GROUP BY DATE_TRUNC('month',opened_date)
			ORDER BY month_sort DESC
			LIMIT 60`)
		if trend == nil {
			trend = []core.Row{}
		}

		respond(w, map[string]any{
			"status_breakdown": statusRows,
			"issuance_trend":   trend,
		}, pickSource([]string{src, tSrc}))
	}
}
