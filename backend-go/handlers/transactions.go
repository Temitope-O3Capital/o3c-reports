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
		f.Date("Transaction_Date", `"Transaction Date"`, dateFrom, dateTo)

		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct {
			key, ms, pg string
		}
		for _, s := range []spec{
			{"total_volume",
				fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE 1=1%s", f.MS()),
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE 1=1%s`, f.PG())},
			{"transaction_count",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE 1=1%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Transactions" WHERE 1=1%s`, f.PG())},
			{"unique_merchants",
				fmt.Sprintf("SELECT COUNT(DISTINCT Merchant_Name) AS val FROM dbo.Transaction_Listing WHERE 1=1%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(DISTINCT "Merchant_Name") AS val FROM "Transactions" WHERE 1=1%s`, f.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg, f.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// MTD is always current month regardless of date filter
		mtd, src, _ := db.DualScalar(ctx, "val",
			"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE MONTH(Transaction_Date)=MONTH(GETDATE()) AND YEAR(Transaction_Date)=YEAR(GETDATE())",
			`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE DATE_TRUNC('month',"Transaction Date")=DATE_TRUNC('month',CURRENT_DATE)`)
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
			`SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS month_sort,
			        ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count
			 FROM dbo.Transaction_Listing WHERE Transaction_Date IS NOT NULL
			 GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1),
			          FORMAT(Transaction_Date,'MMM yyyy')
			 ORDER BY month_sort`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Transaction Date") AS month_sort,
			        COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count
			 FROM "Transactions" WHERE "Transaction Date" IS NOT NULL
			 GROUP BY DATE_TRUNC('month',"Transaction Date") ORDER BY month_sort`)
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
		f.Date("Transaction_Date", `"Transaction Date"`, dateFrom, dateTo)
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TOP 10 Merchant_Name, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count
			  FROM dbo.Transaction_Listing WHERE Merchant_Name IS NOT NULL AND Merchant_Name!=''%s
			  GROUP BY Merchant_Name ORDER BY volume DESC`, f.MS()),
			fmt.Sprintf(`SELECT "Merchant_Name", COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count
			  FROM "Transactions" WHERE "Merchant_Name" IS NOT NULL AND "Merchant_Name"!=''%s
			  GROUP BY "Merchant_Name" ORDER BY volume DESC LIMIT 10`, f.PG()),
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
		f.Date("Transaction_Date", `"Transaction Date"`, dateFrom, dateTo)
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT Description, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count
			  FROM dbo.Transaction_Listing WHERE Description IS NOT NULL%s
			  GROUP BY Description ORDER BY volume DESC`, f.MS()),
			fmt.Sprintf(`SELECT "Description", COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count
			  FROM "Transactions" WHERE "Description" IS NOT NULL%s
			  GROUP BY "Description" ORDER BY volume DESC`, f.PG()),
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
		f.Date("Transaction_Date", `"Transaction Date"`, dateFrom, dateTo)
		data, _, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TOP 5000 Transaction_Date, CIF, Merchant_Name, Description, Amount
			  FROM dbo.Transaction_Listing WHERE 1=1%s ORDER BY Transaction_Date DESC`, f.MS()),
			fmt.Sprintf(`SELECT "Transaction Date","CIF Number","Merchant_Name","Description","Amount"
			  FROM "Transactions" WHERE 1=1%s ORDER BY "Transaction Date" DESC LIMIT 5000`, f.PG()),
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
