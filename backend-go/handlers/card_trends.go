package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCardTrends(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("card_trends"))
	r.Get("/kpis", cardTrendsKPIs(db))
	r.Get("/issuance-trend", cardTrendsIssuance(db))
	r.Get("/portfolio-health", cardTrendsPortfolioHealth(db))
	r.Get("/status-distribution", cardTrendsStatusDist(db))
	r.Get("/by-program", cardTrendsByProgram(db))
	r.Get("/by-product", cardTrendsByProduct(db))
	r.Get("/programs", cardTrendsPrograms(db))
}

// buildTrendsFilter builds the WHERE filter for card trend endpoints.
// Account_Created_Date / "Account Created Date" is the date column.
func buildTrendsFilter(r *http.Request) (*Filter, error) {
	dateFrom, err := validDate(r, "date_from")
	if err != nil {
		return nil, err
	}
	dateTo, err := validDate(r, "date_to")
	if err != nil {
		return nil, err
	}
	product := qstr(r, "product")
	cardProgram := qstr(r, "card_program")

	var f Filter
	f.Date("Account_Created_Date", `"Account Created Date"`, dateFrom, dateTo)
	f.Eq(" AND Product_Name=?", ` AND "Product Name"=?`, product)
	f.Eq(" AND Card_Product=?", ` AND "Card Product"=?`, cardProgram)
	return &f, nil
}

func cardTrendsKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, err := buildTrendsFilter(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, ms, pg string }
		for _, s := range []spec{
			{"total_issued",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE 1=1%s`, f.PG())},
			{"active",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active')%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN ('Open','Active')%s`, f.PG())},
			{"inactive",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status NOT IN ('Open','Active')%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" NOT IN ('Open','Active')%s`, f.PG())},
			{"terminated",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status='TERMINATED'%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status"='TERMINATED'%s`, f.PG())},
			{"legal_suspended",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('LEGAL ACTI','SUSPENDED')%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN ('LEGAL ACTI','SUSPENDED')%s`, f.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg, f.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// MTD always uses current month
		mtd, src, _ := db.DualScalar(ctx, "val",
			"SELECT COUNT(*) AS val FROM dbo.Account WHERE MONTH(Account_Created_Date)=MONTH(GETDATE()) AND YEAR(Account_Created_Date)=YEAR(GETDATE())",
			`SELECT COUNT(*) AS val FROM "Products" WHERE DATE_TRUNC('month',"Account Created Date")=DATE_TRUNC('month',CURRENT_DATE)`)
		kpis["issued_mtd"] = mtd
		sources = append(sources, src)

		total := toFloat(kpis["total_issued"])
		if total > 0 {
			kpis["activation_rate"] = round1(toFloat(kpis["active"]) / total * 100)
		} else {
			kpis["activation_rate"] = 0.0
		}

		respond(w, kpis, pickSource(sources))
	}
}

func cardTrendsIssuance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, err := buildTrendsFilter(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
			        COUNT(*) AS issued
			 FROM dbo.Account WHERE Account_Created_Date IS NOT NULL%s
			 GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
			          FORMAT(Account_Created_Date,'MMM yyyy') ORDER BY month_sort`, f.MS()),
			fmt.Sprintf(`SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Account Created Date") AS month_sort, COUNT(*) AS issued
			 FROM "Products" WHERE "Account Created Date" IS NOT NULL%s
			 GROUP BY DATE_TRUNC('month',"Account Created Date") ORDER BY month_sort`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func cardTrendsPortfolioHealth(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, err := buildTrendsFilter(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
			        SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
			        SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
			        COUNT(*) AS total
			 FROM dbo.Account WHERE Account_Created_Date IS NOT NULL%s
			 GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
			          FORMAT(Account_Created_Date,'MMM yyyy') ORDER BY month_sort`, f.MS()),
			fmt.Sprintf(`SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Account Created Date") AS month_sort,
			        SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
			        SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
			        COUNT(*) AS total
			 FROM "Products" WHERE "Account Created Date" IS NOT NULL%s
			 GROUP BY DATE_TRUNC('month',"Account Created Date") ORDER BY month_sort`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func cardTrendsStatusDist(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, err := buildTrendsFilter(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf("SELECT Status AS status, COUNT(*) AS count FROM dbo.Account WHERE 1=1%s GROUP BY Status ORDER BY count DESC", f.MS()),
			fmt.Sprintf(`SELECT "Account Status" AS status, COUNT(*) AS count FROM "Products" WHERE 1=1%s GROUP BY "Account Status" ORDER BY count DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func cardTrendsByProgram(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")
		var f Filter
		f.Date("Account_Created_Date", `"Account Created Date"`, dateFrom, dateTo)
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT Card_Product AS program, COUNT(*) AS total,
			        SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
			        SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
			        ROUND(100.0*SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END)/COUNT(*),1) AS activation_rate
			 FROM dbo.Account WHERE Card_Product IS NOT NULL AND Card_Product!=''%s
			 GROUP BY Card_Product ORDER BY total DESC`, f.MS()),
			fmt.Sprintf(`SELECT "Card Product" AS program, COUNT(*) AS total,
			        SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
			        SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
			        ROUND(100.0*SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END)/COUNT(*),1) AS activation_rate
			 FROM "Products" WHERE "Card Product" IS NOT NULL AND "Card Product"!=''%s
			 GROUP BY "Card Product" ORDER BY total DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			data = []core.Row{} // non-fatal — column may not exist on all tenants
			src = "supabase_snapshot"
		}
		respond(w, data, src)
	}
}

func cardTrendsByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, err := buildTrendsFilter(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT Product_Name, COUNT(*) AS total,
			        SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
			        SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
			        ROUND(100.0*SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END)/COUNT(*),1) AS activation_rate
			 FROM dbo.Account WHERE Product_Name IS NOT NULL%s
			 GROUP BY Product_Name ORDER BY total DESC`, f.MS()),
			fmt.Sprintf(`SELECT "Product Name", COUNT(*) AS total,
			        SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
			        SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
			        ROUND(100.0*SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END)/COUNT(*),1) AS activation_rate
			 FROM "Products" WHERE "Product Name" IS NOT NULL%s
			 GROUP BY "Product Name" ORDER BY total DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func cardTrendsPrograms(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT DISTINCT Card_Product AS program FROM dbo.Account
			 WHERE Card_Product IS NOT NULL AND Card_Product!='' ORDER BY Card_Product`,
			`SELECT DISTINCT "Card Product" AS program FROM "Products"
			 WHERE "Card Product" IS NOT NULL AND "Card Product"!='' ORDER BY "Card Product"`)
		if err != nil {
			respond(w, []string{}, "supabase_snapshot")
			return
		}
		programs := make([]any, 0, len(data))
		for _, row := range data {
			programs = append(programs, row["program"])
		}
		respond(w, programs, src)
	}
}
