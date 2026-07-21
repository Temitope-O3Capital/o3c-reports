package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCollections(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("collections"))
	r.Get("/kpis", collectionsKPIs(db))
	r.Get("/portfolio-kpis", collectionsPortfolioKPIs(db)) // loan-platform DPD KPIs
	r.Get("/dpd-trend",      collectionsDPDTrend(db))      // 6-month PAR trend from collection_assignments
	r.Get("/by-agent", collectionsByAgent(db))
	r.Get("/by-mode", collectionsByMode(db))
	r.Get("/monthly-trend", collectionsMonthlyTrend(db))
	r.Get("/roll-rate", collectionsRollRate(db))
	r.Get("/log", collectionsLog(db))
	r.Get("/export", collectionsExport(db))
	r.Get("/promise-kpis", collectionsPromiseKPIs(db))
	r.Get("/repayment-kpis", collectionsRepaymentKPIs(db))
	r.Get("/writeoff-kpis", collectionsWriteoffKPIs(db))
}

// collectionsPortfolioKPIs returns PAR-based KPIs from collection_assignments.
func collectionsPortfolioKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(SUM(CASE WHEN dpd_bucket = '1-30'
				                  THEN outstanding_kobo END), 0)                 AS par30_kobo,
				COALESCE(SUM(CASE WHEN dpd_bucket IN ('31-60','61-90')
				                  THEN outstanding_kobo END), 0)                 AS par60_kobo,
				COALESCE(SUM(CASE WHEN dpd_bucket IN ('91-180','181-360')
				                  THEN outstanding_kobo END), 0)                 AS par90_kobo,
				COALESCE(SUM(outstanding_kobo), 0)                              AS total_outstanding_kobo,
				COUNT(*)                                                         AS total_accounts,
				COUNT(CASE WHEN dpd_bucket != '0' THEN 1 END)                   AS delinquent_accounts,
				CASE WHEN COUNT(*) = 0 THEN 0::numeric
				     ELSE ROUND(
				       COUNT(CASE WHEN dpd_bucket = '0' THEN 1 END)::numeric
				       / COUNT(*)::numeric * 100, 1
				     )
				END                                                              AS current_rate_pct
			FROM collection_assignments
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"par30_kobo": int64(0), "par60_kobo": int64(0), "par90_kobo": int64(0),
				"total_outstanding_kobo": int64(0), "total_accounts": int64(0),
				"delinquent_accounts": int64(0), "current_rate_pct": 0.0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// collectionsDPDTrend returns 6-month PAR trend from collection_assignments.
func collectionsDPDTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
				SELECT generate_series(
					DATE_TRUNC('month', NOW() - INTERVAL '5 months'),
					DATE_TRUNC('month', NOW()),
					'1 month'::interval
				) AS m
			)
			SELECT
				TO_CHAR(m.m, 'Mon YY') AS month,
				m.m                    AS month_sort,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket = '1-30'
				              THEN ca.outstanding_kobo END), 0)            AS par30_kobo,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('31-60','61-90')
				              THEN ca.outstanding_kobo END), 0)            AS par60_kobo,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('91-180','181-360')
				              THEN ca.outstanding_kobo END), 0)            AS par90_kobo
			FROM months m
			LEFT JOIN collection_assignments ca
				ON DATE_TRUNC('month', ca.updated_at) = m.m
				AND ($1 = '' OR ca.updated_at::date >= $1::date)
				AND ($2 = '' OR ca.updated_at::date <= $2::date)
			GROUP BY m.m
			ORDER BY m.m`, from, to)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// collectionsRollRate returns DPD bucket distribution and MoM transition counts.
// A full roll-rate matrix requires historical snapshots; this endpoint provides
// the current DPD distribution plus last-month's distribution for comparison.
func collectionsRollRate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")

		// Current DPD distribution
		current, err := db.PGQuery(ctx, `
			SELECT
				dpd_bucket,
				COUNT(*)                             AS account_count,
				COALESCE(SUM(outstanding_kobo), 0)  AS outstanding_kobo
			FROM collection_assignments
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)
			GROUP BY dpd_bucket
			ORDER BY
				CASE dpd_bucket
					WHEN '0'       THEN 0
					WHEN '1-30'    THEN 1
					WHEN '31-60'   THEN 2
					WHEN '61-90'   THEN 3
					WHEN '91-180'  THEN 4
					WHEN '181-360' THEN 5
					ELSE 6
				END`, from, to)
		if err != nil {
			respondErr(w, 500, "Roll rate query failed")
			return
		}

		// Movement this month: accounts that changed dpd_bucket in the current calendar month.
		// Proxied by comparing updated_at vs created_at bucket changes.
		cures, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cured_count
			FROM collection_assignments
			WHERE dpd_bucket = '0'
			  AND updated_at >= DATE_TRUNC('month', CURRENT_DATE)
			  AND updated_at > created_at`)

		respond(w, map[string]any{
			"current_distribution": current,
			"cured_this_month":     func() any {
				if len(cures) > 0 { return cures[0]["cured_count"] }
				return 0
			}(),
		}, "pg")
	}
}

func collectionsKPIs(db *core.DB) http.HandlerFunc {
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
		agent := qstr(r, "agent")

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND Rn_Create_User=?", ` AND "Agent"=?`, agent)

		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, ms, pg string }
		for _, s := range []spec{
			{"total_collected",
				fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE 1=1%s", f.MS()),
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG())},
			{"collection_count",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.o3_loan_Repayment WHERE 1=1%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG())},
			{"paid_collections",
				fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Paid=1%s", f.MS()),
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NOT NULL%s`, f.PG())},
			{"pending_collections",
				fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE (Paid IS NULL OR Paid=0)%s", f.MS()),
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NULL%s`, f.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg, f.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// MTD always uses current month; include agent filter but not date filter
		var af Filter
		af.Eq(" AND Rn_Create_User=?", ` AND "Agent"=?`, agent)
		mtd, src, _ := db.DualScalar(ctx, "val",
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE MONTH(Repayment_Date)=MONTH(GETDATE()) AND YEAR(Repayment_Date)=YEAR(GETDATE())%s", af.MS()),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE DATE_TRUNC('month',"Date")=DATE_TRUNC('month',CURRENT_DATE)%s`, af.PG()),
			af.Args()...)
		kpis["collections_mtd"] = mtd
		sources = append(sources, src)

		respond(w, kpis, pickSource(sources))
	}
}

func collectionsByAgent(db *core.DB) http.HandlerFunc {
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
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TOP 15 Rn_Create_User AS Agent, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count
			  FROM dbo.o3_loan_Repayment WHERE Rn_Create_User IS NOT NULL AND Rn_Create_User!=''%s
			  GROUP BY Rn_Create_User ORDER BY total DESC`, f.MS()),
			fmt.Sprintf(`SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count
			  FROM "Collections Log" WHERE "Agent" IS NOT NULL AND "Agent"!=''%s
			  GROUP BY "Agent" ORDER BY total DESC LIMIT 15`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsByMode(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT CASE WHEN Paid=1 THEN 'Paid' ELSE 'Pending' END AS payment_status,
			        ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count
			 FROM dbo.o3_loan_Repayment GROUP BY Paid ORDER BY total DESC`,
			`SELECT COALESCE("Mode Of Payment",'Pending') AS payment_status,
			        COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count
			 FROM "Collections Log" GROUP BY "Mode Of Payment" ORDER BY total DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT FORMAT(Repayment_Date,'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1) AS month_sort,
			        ISNULL(SUM(Amount),0) AS total
			 FROM dbo.o3_loan_Repayment WHERE Repayment_Date IS NOT NULL
			 GROUP BY DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1),
			          FORMAT(Repayment_Date,'MMM yyyy') ORDER BY month_sort`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Date") AS month_sort,
			        COALESCE(SUM("Amount"),0) AS total
			 FROM "Collections Log" WHERE "Date" IS NOT NULL
			 GROUP BY DATE_TRUNC('month',"Date") ORDER BY month_sort`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsLog(db *core.DB) http.HandlerFunc {
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
		agent := qstr(r, "agent")
		limit := qint(r, "limit", 200, 1, 1000)

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND r.Rn_Create_User=?", ` AND cl."Agent"=?`, agent)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TOP %d
			        r.Repayment_Date AS [Date], a.CIF_Number AS CIF,
			        c.First_Name AS [First Name], c.Last_Name AS [Last Name],
			        r.Rn_Create_User AS Agent, r.Amount,
			        NULL AS [Mode Of Payment], r.Comments AS [Payment Receipt]
			 FROM dbo.o3_loan_Repayment r
			 LEFT JOIN dbo.Account a ON r.Loan_Account=a.Account_Id
			 LEFT JOIN dbo.Contact c ON a.CIF_Number=c.CIF
			 WHERE 1=1%s ORDER BY r.Repayment_Date DESC`, limit, f.MS()),
			fmt.Sprintf(`SELECT cl."Date", cl."CIF",
			        a."First Name", a."Last Name",
			        cl."Agent", cl."Amount", cl."Mode Of Payment", cl."Payment Receipt"
			 FROM "Collections Log" cl
			 LEFT JOIN "Accounts" a ON cl."CIF"=a."CIF Number"
			 WHERE 1=1%s ORDER BY cl."Date" DESC LIMIT %d`, f.PG(), limit),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsExport(db *core.DB) http.HandlerFunc {
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
		agent := qstr(r, "agent")

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND r.Rn_Create_User=?", ` AND cl."Agent"=?`, agent)

		data, _, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT r.Repayment_Date AS [Date], a.CIF_Number AS CIF,
			        c.First_Name AS [First Name], c.Last_Name AS [Last Name],
			        r.Rn_Create_User AS Agent, r.Amount, r.Comments AS Notes
			 FROM dbo.o3_loan_Repayment r
			 LEFT JOIN dbo.Account a ON r.Loan_Account=a.Account_Id
			 LEFT JOIN dbo.Contact c ON a.CIF_Number=c.CIF
			 WHERE 1=1%s ORDER BY r.Repayment_Date DESC`, f.MS()),
			fmt.Sprintf(`SELECT cl."Date", cl."CIF",
			        a."First Name", a."Last Name",
			        cl."Agent", cl."Amount", cl."Payment Receipt"
			 FROM "Collections Log" cl
			 LEFT JOIN "Accounts" a ON cl."CIF"=a."CIF Number"
			 WHERE 1=1%s ORDER BY cl."Date" DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Export failed")
			return
		}
		name := fmt.Sprintf("collections_%s_%s.csv",
			coalesce(dateFrom, "all"), coalesce(dateTo, "all"))
		streamCSV(w, name, data)
	}
}

func collectionsPromiseKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                      AS total,
				COUNT(*) FILTER (WHERE is_kept = TRUE)                        AS kept,
				COUNT(*) FILTER (WHERE is_kept = FALSE)                       AS broken,
				COALESCE(SUM(promised_amount_kobo), 0)                        AS amount_promised_kobo
			FROM collection_promises
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "kept": int64(0), "broken": int64(0),
				"amount_promised_kobo": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func collectionsRepaymentKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE status = 'Active')                         AS active,
				COUNT(*) FILTER (WHERE status = 'Active'
				                   AND (next_payment_date IS NULL
				                        OR next_payment_date >= CURRENT_DATE))    AS on_track,
				COUNT(*) FILTER (WHERE status = 'Active'
				                   AND next_payment_date < CURRENT_DATE)          AS behind,
				COALESCE(SUM(
					CASE WHEN status = 'Active'
					THEN (SELECT COALESCE(SUM(ri.amount_kobo),0)
					      FROM repayment_instalments ri
					      WHERE ri.plan_id = rp.id
					        AND ri.due_date >= DATE_TRUNC('month', CURRENT_DATE)
					        AND ri.due_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
					        AND ri.status != 'Paid')
					ELSE 0 END
				), 0)                                                              AS monthly_due_kobo
			FROM repayment_plans rp
			WHERE ($1 = '' OR rp.created_at::date >= $1::date)
			  AND ($2 = '' OR rp.created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"active": int64(0), "on_track": int64(0),
				"behind": int64(0), "monthly_due_kobo": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func collectionsWriteoffKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                          AS total,
				COALESCE(SUM(wo.amount_kobo), 0)                                 AS amount_kobo,
				CASE WHEN SUM(wo.amount_kobo) = 0 OR SUM(wo.amount_kobo) IS NULL THEN 0
				     ELSE ROUND(
				       100.0 * SUM(rc.recovered_kobo) / NULLIF(SUM(wo.amount_kobo), 0), 1
				     )
				END                                                               AS recovery_rate_pct,
				COUNT(*) FILTER (WHERE wo.status = 'pending')                    AS pending
			FROM recovery_write_off_approvals wo
			JOIN recovery_cases rc ON wo.case_id = rc.id
			WHERE ($1 = '' OR wo.created_at::date >= $1::date)
			  AND ($2 = '' OR wo.created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "amount_kobo": int64(0),
				"recovery_rate_pct": 0.0, "pending": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}
