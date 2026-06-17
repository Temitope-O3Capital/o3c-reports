package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterOverview(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("overview"))
	r.Get("/kpis", overviewKPIs(db))
	r.Get("/monthly-volume", overviewMonthlyVolume(db))
	r.Get("/new-accounts-trend", overviewNewAccountsTrend(db))
	r.Get("/cards-by-product", overviewCardsByProduct(db))
	r.Get("/txn-by-type", overviewTxnByType(db))
}

func overviewKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		type kpiResult struct {
			val any
			src string
		}

		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type qSpec struct {
			key   string
			msSQL string
			pgSQL string
		}
		specs := []qSpec{
			{"total_cardholders",
				"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"`},
			{"active_accounts",
				"SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products" WHERE "Account Status" IN ('Open','Active')`},
			{"total_cards_issued",
				"SELECT COUNT(*) AS val FROM dbo.Account",
				`SELECT COUNT(*) AS val FROM "Products"`},
			{"total_txn_volume",
				"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing",
				`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions"`},
			{"new_accounts_mtd",
				"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE MONTH(Account_Created)=MONTH(GETDATE()) AND YEAR(Account_Created)=YEAR(GETDATE())",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts" WHERE DATE_TRUNC('month',"Account Created Date")=DATE_TRUNC('month',CURRENT_DATE)`},
			{"total_collected",
				"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment",
				`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"`},
			{"collections_mtd",
				"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE MONTH(Repayment_Date)=MONTH(GETDATE()) AND YEAR(Repayment_Date)=YEAR(GETDATE())",
				`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE DATE_TRUNC('month',"Date")=DATE_TRUNC('month',CURRENT_DATE)`},
			{"total_recovered",
				"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
				`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"`},
		}

		for _, s := range specs {
			val, src, err := db.DualScalar(ctx, "val", s.msSQL, s.pgSQL)
			if err != nil {
				// Don't hard-fail — just return 0 for this stat so the page still renders
				kpis[s.key] = 0
				sources = append(sources, "error")
				continue
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		collected := toFloat(kpis["total_collected"])
		recovered := toFloat(kpis["total_recovered"])
		total := collected + recovered
		if total > 0 {
			kpis["recovery_rate"] = round1(recovered / total * 100)
		} else {
			kpis["recovery_rate"] = 0.0
		}

		respond(w, kpis, pickSource(sources))
	}
}

func overviewMonthlyVolume(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS month_sort,
			        ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS txn_count
			 FROM dbo.Transaction_Listing
			 GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1),
			          FORMAT(Transaction_Date,'MMM yyyy')
			 ORDER BY month_sort`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Transaction Date") AS month_sort,
			        COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS txn_count
			 FROM "Transactions"
			 GROUP BY DATE_TRUNC('month',"Transaction Date")
			 ORDER BY month_sort`)
		if err != nil {
			respond(w, []any{}, "error")
			return
		}
		respond(w, data, src)
	}
}

func overviewNewAccountsTrend(db *core.DB) http.HandlerFunc {
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
			 GROUP BY DATE_TRUNC('month',"Account Created Date")
			 ORDER BY month_sort`)
		if err != nil {
			respond(w, []any{}, "error")
			return
		}
		respond(w, data, src)
	}
}

func overviewCardsByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT Product_Name, COUNT(*) AS count FROM dbo.Account
			 WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY count DESC`,
			`SELECT "Product Name", COUNT(*) AS count FROM "Products"
			 WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY count DESC`)
		if err != nil {
			respond(w, []any{}, "error")
			return
		}
		respond(w, data, src)
	}
}

func overviewTxnByType(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TOP 10 Description, COUNT(*) AS count, ISNULL(SUM(Amount),0) AS volume
			 FROM dbo.Transaction_Listing WHERE Description IS NOT NULL
			 GROUP BY Description ORDER BY count DESC`,
			`SELECT "Description", COUNT(*) AS count, COALESCE(SUM("Amount"),0) AS volume
			 FROM "Transactions" WHERE "Description" IS NOT NULL
			 GROUP BY "Description" ORDER BY count DESC LIMIT 10`)
		if err != nil {
			respond(w, []any{}, "error")
			return
		}
		respond(w, data, src)
	}
}

// ── numeric helpers ───────────────────────────────────────────────────────────

func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int32:
		return float64(t)
	}
	return 0
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}
