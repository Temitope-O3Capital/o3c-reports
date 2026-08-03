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
		f.Date("Transaction_Date", `"Transaction Date"`, dateFrom, dateTo)

		ctx := r.Context()

		// Totals breakdown: credit vs debit settlement volumes
		rows, src, err := db.DualQuery(ctx,
			`SELECT
			  CAST(Transaction_Date AS DATE)          AS settlement_date,
			  COUNT(*)                                AS txn_count,
			  ISNULL(SUM(CASE WHEN Amount>0 THEN Amount ELSE 0 END),0) AS credits,
			  ISNULL(SUM(CASE WHEN Amount<0 THEN ABS(Amount) ELSE 0 END),0) AS debits,
			  ISNULL(SUM(Amount),0)                   AS net_position
			FROM dbo.Transaction_Listing
			WHERE 1=1`+f.MS()+`
			GROUP BY CAST(Transaction_Date AS DATE)
			ORDER BY settlement_date DESC`,
			`SELECT
			  "Transaction Date"::date  AS settlement_date,
			  COUNT(*)                  AS txn_count,
			  COALESCE(SUM(CASE WHEN "Amount">0 THEN "Amount" ELSE 0 END),0) AS credits,
			  COALESCE(SUM(CASE WHEN "Amount"<0 THEN ABS("Amount") ELSE 0 END),0) AS debits,
			  COALESCE(SUM("Amount"),0) AS net_position
			FROM "Transactions"
			WHERE 1=1`+f.PG()+`
			GROUP BY "Transaction Date"::date
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
		f.Date("Transaction_Date", `"Transaction Date"`, dateFrom, dateTo)

		ctx := r.Context()

		// Monthly activity: distinct active users + transaction count
		rows, src, err := db.DualQuery(ctx,
			`SELECT
			  COUNT(DISTINCT CIF_Number) AS active_users,
			  COUNT(*)                   AS txn_count,
			  ISNULL(SUM(Amount),0)      AS total_volume,
			  ISNULL(AVG(CAST(Amount AS FLOAT)),0) AS avg_txn_size
			FROM dbo.Transaction_Listing
			WHERE 1=1`+f.MS(),
			`SELECT
			  COUNT(DISTINCT "CIF Number") AS active_users,
			  COUNT(*)                     AS txn_count,
			  COALESCE(SUM("Amount"),0)    AS total_volume,
			  COALESCE(AVG("Amount"),0)    AS avg_txn_size
			FROM "Transactions"
			WHERE 1=1`+f.PG(),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Mobile app query failed")
			return
		}

		// Monthly trend
		trend, tSrc, err2 := db.DualQuery(ctx,
			`SELECT
			  FORMAT(Transaction_Date,'MMM yyyy') AS month,
			  DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS month_sort,
			  COUNT(DISTINCT CIF_Number) AS active_users,
			  COUNT(*) AS txn_count
			FROM dbo.Transaction_Listing
			GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1),
			         FORMAT(Transaction_Date,'MMM yyyy')
			ORDER BY month_sort DESC`,
			`SELECT
			  TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month,
			  DATE_TRUNC('month',"Transaction Date") AS month_sort,
			  COUNT(DISTINCT "CIF Number") AS active_users,
			  COUNT(*) AS txn_count
			FROM "Transactions"
			GROUP BY DATE_TRUNC('month',"Transaction Date")
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
		const blinkPG = `("Product Name" ILIKE '%blink%' OR "Product Name" ILIKE '%PREP Temporary Virtual%')`
		statusRows, src, err := db.DualQuery(ctx,
			`SELECT Account_Status AS status, COUNT(*) AS count
			 FROM dbo.Account
			 WHERE `+blinkMS+`
			 GROUP BY Account_Status
			 ORDER BY count DESC`,
			`SELECT "Account Status" AS status, COUNT(*) AS count
			 FROM "Products"
			 WHERE `+blinkPG+`
			 GROUP BY "Account Status"
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
			  FORMAT(Account_Created,'MMM yyyy') AS month,
			  DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1) AS month_sort,
			  COUNT(*) AS issued
			FROM dbo.Account
			WHERE Account_Created IS NOT NULL AND `+blinkMS+`
			GROUP BY DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1),
			         FORMAT(Account_Created,'MMM yyyy')
			ORDER BY month_sort DESC`,
			`SELECT
			  TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
			  DATE_TRUNC('month',"Account Created Date") AS month_sort,
			  COUNT(*) AS issued
			FROM "Products"
			WHERE "Account Created Date" IS NOT NULL AND `+blinkPG+`
			GROUP BY DATE_TRUNC('month',"Account Created Date")
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
