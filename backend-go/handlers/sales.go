package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterSales(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("sales"))
	r.Get("/kpis", salesKPIs(db))
	r.Get("/funnel", salesFunnel(db))
	r.Get("/accounts-trend", salesAccountsTrend(db))
	r.Get("/by-state", salesByState(db))
	r.Get("/by-city", salesByCity(db))
	r.Get("/manager-performance", salesManagerPerformance(db))
	r.Get("/product-mix", salesProductMix(db))
	r.Get("/customers", salesCustomers(db))
}

func salesKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, ms, pg string }
		for _, s := range []spec{
			{"total_customers",
				"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"`},
			{"new_mtd",
				"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE MONTH(Account_Created)=MONTH(GETDATE()) AND YEAR(Account_Created)=YEAR(GETDATE())",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts" WHERE DATE_TRUNC('month',"Account Created Date")=DATE_TRUNC('month',CURRENT_DATE)`},
			{"ytd_new",
				"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE YEAR(Account_Created)=YEAR(GETDATE())",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts" WHERE EXTRACT(year FROM "Account Created Date")=EXTRACT(year FROM CURRENT_DATE)`},
			{"active_cards",
				"SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products" WHERE "Account Status" IN ('Open','Active')`},
			{"total_cards",
				"SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products"`},
			{"states_reached",
				"SELECT COUNT(DISTINCT State_) AS val FROM dbo.Contact WHERE State_ IS NOT NULL AND State_ != ''",
				`SELECT COUNT(DISTINCT "State") AS val FROM "Accounts" WHERE "State" IS NOT NULL AND "State" != ''`},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		prev, _, _ := db.DualScalar(ctx, "val",
			"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE MONTH(Account_Created)=MONTH(DATEADD(month,-1,GETDATE())) AND YEAR(Account_Created)=YEAR(DATEADD(month,-1,GETDATE()))",
			`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts" WHERE DATE_TRUNC('month',"Account Created Date")=DATE_TRUNC('month',CURRENT_DATE-INTERVAL '1 month')`)
		prevN := toFloat(prev)
		newMTD := toFloat(kpis["new_mtd"])
		if prevN > 0 {
			kpis["mom_growth"] = round1((newMTD - prevN) / prevN * 100)
		} else {
			kpis["mom_growth"] = 0.0
		}
		kpis["prev_month"] = prev

		total := toFloat(kpis["total_cards"])
		if total > 0 {
			kpis["activation_rate"] = round1(toFloat(kpis["active_cards"]) / total * 100)
		} else {
			kpis["activation_rate"] = 0.0
		}

		respond(w, kpis, pickSource(sources))
	}
}

func salesFunnel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		stages := map[string]any{}
		var sources []string
		for _, s := range []struct{ key, ms, pg string }{
			{"registered",
				"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"`},
			{"card_issued",
				"SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products"`},
			{"card_active",
				"SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products" WHERE "Account Status" IN ('Open','Active')`},
			{"transacting",
				"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Transaction_Listing",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Transactions"`},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			stages[s.key] = val
			sources = append(sources, src)
		}
		respond(w, stages, pickSource(sources))
	}
}

func salesAccountsTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT FORMAT(Account_Created,'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1) AS month_sort,
			        COUNT(DISTINCT CIF) AS new_accounts
			 FROM dbo.Contact WHERE Account_Created IS NOT NULL
			 GROUP BY DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1),
			          FORMAT(Account_Created,'MMM yyyy')
			 ORDER BY month_sort`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Account Created Date") AS month_sort,
			        COUNT(DISTINCT "CIF Number") AS new_accounts
			 FROM "Accounts" WHERE "Account Created Date" IS NOT NULL
			 GROUP BY DATE_TRUNC('month',"Account Created Date") ORDER BY month_sort`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func salesByState(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT State_, COUNT(DISTINCT CIF) AS count FROM dbo.Contact
			 WHERE State_ IS NOT NULL AND State_!='' GROUP BY State_ ORDER BY count DESC`,
			`SELECT "State", COUNT(DISTINCT "CIF Number") AS count FROM "Accounts"
			 WHERE "State" IS NOT NULL AND "State"!='' GROUP BY "State" ORDER BY count DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func salesByCity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TOP 20 City, State_, COUNT(DISTINCT CIF) AS count FROM dbo.Contact
			 WHERE City IS NOT NULL AND City!='' GROUP BY City, State_ ORDER BY count DESC`,
			`SELECT "City", "State", COUNT(DISTINCT "CIF Number") AS count FROM "Accounts"
			 WHERE "City" IS NOT NULL AND "City"!='' GROUP BY "City","State" ORDER BY count DESC LIMIT 20`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func salesManagerPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TOP 20
			        Account_Manager_txt AS [Account Manager],
			        COUNT(*) AS total_accounts,
			        SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active_accounts,
			        ROUND(100.0*SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END)/COUNT(*),1) AS activation_rate
			 FROM dbo.Account WHERE Account_Manager_txt IS NOT NULL AND Account_Manager_txt NOT IN ('','Unassigned')
			 GROUP BY Account_Manager_txt ORDER BY total_accounts DESC`,
			`SELECT "Account Manager",
			        COUNT(*) AS total_accounts,
			        SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active_accounts,
			        ROUND(100.0*SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END)/COUNT(*),1) AS activation_rate
			 FROM "Products" WHERE "Account Manager" IS NOT NULL AND "Account Manager" NOT IN ('','Unassigned')
			 GROUP BY "Account Manager" ORDER BY total_accounts DESC LIMIT 20`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func salesProductMix(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT Product_Name, COUNT(*) AS total,
			        SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active
			 FROM dbo.Account WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY total DESC`,
			`SELECT "Product Name", COUNT(*) AS total,
			        SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active
			 FROM "Products" WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY total DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func salesCustomers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 500)
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TOP %d
			        c.CIF AS [CIF Number], c.First_Name AS [First Name], c.Last_Name AS [Last Name],
			        c.State_ AS [State], c.City, c.Job_Title AS [Job Title],
			        c.Account_Created AS [Account Created Date],
			        p.Product_Name AS [Product Name], p.Status AS [Account Status],
			        p.Account_Manager_txt AS [Account Manager]
			 FROM dbo.Contact c
			 OUTER APPLY (
			     SELECT TOP 1 Product_Name, Status, Account_Manager_txt FROM dbo.Account
			     WHERE CIF_Number=c.CIF ORDER BY CASE WHEN Status IN ('Open','Active') THEN 0 ELSE 1 END
			 ) p ORDER BY c.Account_Created DESC`, limit),
			fmt.Sprintf(`SELECT a."CIF Number", a."First Name", a."Last Name",
			        a."State", a."City", a."Job Title", a."Account Created Date",
			        p."Product Name", p."Account Status", p."Account Manager"
			 FROM "Accounts" a
			 LEFT JOIN LATERAL (
			     SELECT "Product Name","Account Status","Account Manager" FROM "Products"
			     WHERE "CIF Number"=a."CIF Number"
			     ORDER BY CASE WHEN "Account Status" IN ('Open','Active') THEN 0 ELSE 1 END LIMIT 1
			 ) p ON true
			 ORDER BY a."Account Created Date" DESC LIMIT %d`, limit))
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}
