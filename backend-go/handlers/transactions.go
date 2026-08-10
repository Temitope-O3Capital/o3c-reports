package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterTransactions(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("transactions"))
	r.Get("/kpis", txnKPIs(db))
	r.Get("/monthly-trend", txnMonthlyTrend(db))
	r.Get("/top-merchants", txnTopMerchants(db))
	r.Get("/by-type", txnByType(db))
	r.Get("/export", txnExport(db))
}

func txnKPIs(db *core.DB) http.HandlerFunc {
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
		kpis := map[string]any{}
		var sources []string

		type spec struct {
			key, pg string
		}
		for _, s := range []spec{
			{"total_volume",
				fmt.Sprintf(`SELECT COALESCE(SUM(amount),0) AS val FROM app.transactions WHERE 1=1%s`, f.PG())},
			{"transaction_count",
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.transactions WHERE 1=1%s`, f.PG())},
			{"unique_merchants",
				fmt.Sprintf(`SELECT COUNT(DISTINCT merchant_name) AS val FROM app.transactions WHERE 1=1%s`, f.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.pg, f.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// MTD is always current month regardless of date filter
		mtd, src, _ := db.DualScalar(ctx, "val",
			`SELECT COALESCE(SUM(amount),0) AS val FROM app.transactions WHERE DATE_TRUNC('month',txn_date)=DATE_TRUNC('month',CURRENT_DATE)`)
		kpis["volume_mtd"] = mtd
		sources = append(sources, src)

		cnt := toFloat(kpis["transaction_count"])
		vol := toFloat(kpis["total_volume"])
		if cnt > 0 {
			kpis["avg_txn_value"] = round1(vol / cnt)
		} else {
			kpis["avg_txn_value"] = 0.0
		}

		respond(w, kpis, pickSource(sources))
	}
}

func txnMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TO_CHAR(DATE_TRUNC('month',txn_date),'Mon YYYY') AS month,
			        DATE_TRUNC('month',txn_date) AS month_sort,
			        COALESCE(SUM(amount),0) AS volume, COUNT(*) AS count
			 FROM app.transactions WHERE txn_date IS NOT NULL
			 GROUP BY DATE_TRUNC('month',txn_date) ORDER BY month_sort`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func txnTopMerchants(db *core.DB) http.HandlerFunc {
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
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT merchant_name AS "Merchant_Name", COALESCE(SUM(amount),0) AS volume, COUNT(*) AS count
			  FROM app.transactions WHERE merchant_name IS NOT NULL AND merchant_name!=''%s
			  GROUP BY merchant_name ORDER BY volume DESC LIMIT 10`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func txnByType(db *core.DB) http.HandlerFunc {
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
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT description AS "Description", COALESCE(SUM(amount),0) AS volume, COUNT(*) AS count
			  FROM app.transactions WHERE description IS NOT NULL%s
			  GROUP BY description ORDER BY volume DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func txnExport(db *core.DB) http.HandlerFunc {
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
		data, _, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT txn_date AS "Transaction Date", cif AS "CIF Number", merchant_name AS "Merchant_Name", description AS "Description", amount AS "Amount"
			  FROM app.transactions WHERE 1=1%s ORDER BY txn_date DESC LIMIT 5000`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Export failed")
			return
		}
		name := fmt.Sprintf("transactions_%s_%s.csv",
			coalesce(dateFrom, "all"), coalesce(dateTo, "all"))
		streamCSV(w, name, data)
	}
}
