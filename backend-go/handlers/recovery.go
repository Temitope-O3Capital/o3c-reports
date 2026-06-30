package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterRecovery(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("recovery"))
	r.Get("/kpis", recoveryKPIs(db))
	r.Get("/by-method", recoveryByMethod(db))
	r.Get("/monthly-trend", recoveryMonthlyTrend(db))
	r.Get("/cases", recoveryCases(db))
	r.Get("/export", recoveryExport(db))
}

func recoveryKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, ms, pg string }
		for _, s := range []spec{
			{"total_recovered",
				"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
				`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"`},
			{"accounts_in_legal",
				"SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.RecoveryMasterSheet WHERE [Legal Stage] IS NOT NULL",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE "Legal Stage" IS NOT NULL`},
			{"recovery_mtd",
				"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE MONTH([Recovery Date])=MONTH(GETDATE()) AND YEAR([Recovery Date])=YEAR(GETDATE())",
				`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE DATE_TRUNC('month',"Recovery Date")=DATE_TRUNC('month',CURRENT_DATE)`},
			{"open_cases",
				"SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.RecoveryMasterSheet WHERE [Status] IS NULL OR [Status] NOT IN ('Recovered','Paid','Closed')",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE "Status" IS NULL OR "Status" NOT IN ('Recovered','Paid','Closed')`},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// CBN recovery rate = total_recovered / total_npl_book_value * 100
		// (CBN supervisory framework: recoveries as % of gross NPL balance)
		nplBalance, _, _ := db.DualScalar(ctx, "val",
			"SELECT ISNULL(SUM([Outstanding Balance]),0) AS val FROM dbo.RecoveryMasterSheet",
			`SELECT COALESCE(SUM("Outstanding Balance"),0) AS val FROM "Recovery Master Sheet"`)
		if toFloat(nplBalance) > 0 {
			kpis["recovery_rate"] = round1(toFloat(kpis["total_recovered"]) / toFloat(nplBalance) * 100)
		} else {
			kpis["recovery_rate"] = 0.0
		}
		kpis["total_npl_balance"] = nplBalance

		respond(w, kpis, pickSource(sources))
	}
}

func recoveryByMethod(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT [Recovery Method], ISNULL(SUM([Recovery Amount]),0) AS total, COUNT(*) AS count
			 FROM dbo.RecoveryMasterSheet GROUP BY [Recovery Method] ORDER BY total DESC`,
			`SELECT "Recovery Method", COALESCE(SUM("Recovery Amount"),0) AS total, COUNT(*) AS count
			 FROM "Recovery Master Sheet" GROUP BY "Recovery Method" ORDER BY total DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func recoveryMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT FORMAT([Recovery Date],'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1) AS month_sort,
			        ISNULL(SUM([Recovery Amount]),0) AS total
			 FROM dbo.RecoveryMasterSheet
			 GROUP BY DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1),
			          FORMAT([Recovery Date],'MMM yyyy')
			 ORDER BY month_sort`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Recovery Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Recovery Date") AS month_sort,
			        COALESCE(SUM("Recovery Amount"),0) AS total
			 FROM "Recovery Master Sheet"
			 GROUP BY DATE_TRUNC('month',"Recovery Date") ORDER BY month_sort`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func recoveryCases(db *core.DB) http.HandlerFunc {
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
		limit := qint(r, "limit", 200, 1, 1000)

		var f Filter
		f.Date("r.[Recovery Date]", `r."Recovery Date"`, dateFrom, dateTo)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TOP %d
			        r.[CIF Number], a.First_Name AS [First Name], a.Last_Name AS [Last Name],
			        r.[Recovery Amount], r.[Recovery Method], r.[Legal Stage],
			        r.Agent, r.Status, r.[Recovery Date]
			 FROM dbo.RecoveryMasterSheet r
			 LEFT JOIN dbo.Contact a ON r.[CIF Number]=a.CIF
			 WHERE 1=1%s ORDER BY r.[Recovery Date] DESC`, limit, f.MS()),
			fmt.Sprintf(`SELECT r."CIF Number", a."First Name", a."Last Name",
			        r."Recovery Amount", r."Recovery Method", r."Legal Stage",
			        r."Agent", r."Status", r."Recovery Date"
			 FROM "Recovery Master Sheet" r
			 LEFT JOIN "Accounts" a ON r."CIF Number"=a."CIF Number"
			 WHERE 1=1%s ORDER BY r."Recovery Date" DESC LIMIT %d`, f.PG(), limit),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func recoveryExport(db *core.DB) http.HandlerFunc {
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
		f.Date("r.[Recovery Date]", `r."Recovery Date"`, dateFrom, dateTo)
		data, _, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT r.[CIF Number], a.First_Name AS [First Name], a.Last_Name AS [Last Name],
			        r.[Recovery Amount], r.[Recovery Method], r.[Legal Stage],
			        r.Agent, r.Status, r.[Recovery Date]
			 FROM dbo.RecoveryMasterSheet r
			 LEFT JOIN dbo.Contact a ON r.[CIF Number]=a.CIF
			 WHERE 1=1%s ORDER BY r.[Recovery Date] DESC`, f.MS()),
			fmt.Sprintf(`SELECT r."CIF Number", a."First Name", a."Last Name",
			        r."Recovery Amount", r."Recovery Method", r."Legal Stage",
			        r."Agent", r."Status", r."Recovery Date"
			 FROM "Recovery Master Sheet" r
			 LEFT JOIN "Accounts" a ON r."CIF Number"=a."CIF Number"
			 WHERE 1=1%s ORDER BY r."Recovery Date" DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Export failed")
			return
		}
		name := fmt.Sprintf("recovery_%s_%s.csv",
			coalesce(dateFrom, "all"), coalesce(dateTo, "all"))
		streamCSV(w, name, data)
	}
}
