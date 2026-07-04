package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterSales(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("sales"))
	r.Get("/kpis", salesKPIs(db))
	r.Get("/loan-kpis",            salesLoanKPIs(db))            // loan-platform KPIs for Sales Overview
	r.Get("/monthly-disbursements", salesMonthlyDisbursements(db)) // 12-month disbursements trend
	r.Get("/recent-applications",   salesRecentApplications(db))   // recent LOS applications
	r.Get("/top-performers",        salesTopPerformers(db))         // top officers by disbursements
	r.Get("/funnel", salesFunnel(db))
	r.Get("/accounts-trend", salesAccountsTrend(db))
	r.Get("/by-state", salesByState(db))
	r.Get("/by-city", salesByCity(db))
	r.Get("/manager-performance", salesManagerPerformance(db))
	r.Get("/product-mix", salesProductMix(db))
	r.Get("/customers", salesCustomers(db))

	// Sales Targets (Wave 5G)
	r.Get("/targets",         salesTargetList(db))
	r.Post("/targets",        salesTargetCreate(db))
	r.Patch("/targets/{id}",  salesTargetUpdate(db))
	r.Delete("/targets/{id}", salesTargetDelete(db))
	r.Get("/targets/actuals", salesTargetActuals(db))
}

// salesLoanKPIs returns LOS-based KPIs for the Sales Overview page.
func salesLoanKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())
				           THEN 1 END)                                    AS submitted_mtd,
				COALESCE(SUM(
					CASE WHEN stage = 'active'
					     AND DATE_TRUNC('month', updated_at) = DATE_TRUNC('month', NOW())
					THEN amount_approved_kobo END
				), 0)                                                     AS disbursed_mtd_kobo,
				COALESCE(SUM(
					CASE WHEN stage NOT IN ('active','declined','closed')
					THEN amount_requested_kobo END
				), 0)                                                     AS pipeline_kobo,
				CASE WHEN (COUNT(CASE WHEN stage = 'active'  THEN 1 END)
				         + COUNT(CASE WHEN stage = 'declined' THEN 1 END)) = 0
				     THEN 0::numeric
				     ELSE ROUND(
				       COUNT(CASE WHEN stage = 'active' THEN 1 END)::numeric
				       / (COUNT(CASE WHEN stage = 'active'  THEN 1 END)
				        + COUNT(CASE WHEN stage = 'declined' THEN 1 END))::numeric * 100, 1
				     )
				END                                                       AS win_rate_pct
			FROM loan_applications`)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"submitted_mtd": int64(0), "disbursed_mtd_kobo": int64(0),
				"pipeline_kobo": int64(0), "win_rate_pct": 0.0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// salesMonthlyDisbursements returns 12 months of disbursement data.
func salesMonthlyDisbursements(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
				SELECT generate_series(
					DATE_TRUNC('month', NOW() - INTERVAL '11 months'),
					DATE_TRUNC('month', NOW()),
					'1 month'::interval
				) AS m
			)
			SELECT TO_CHAR(m.m, 'Mon YY') AS month, m.m AS month_sort,
			       COALESCE(SUM(la.amount_approved_kobo), 0) AS disbursements_kobo,
			       COUNT(la.id) AS count
			FROM months m
			LEFT JOIN loan_applications la
				ON la.stage = 'active'
				AND DATE_TRUNC('month', la.updated_at) = m.m
			GROUP BY m.m ORDER BY m.m`)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// salesRecentApplications returns the 20 most-recently-updated applications.
func salesRecentApplications(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		q := `SELECT la.id, la.stage, la.status, la.amount_requested_kobo,
		             la.amount_approved_kobo, la.created_at, la.updated_at,
		             la.officer_id, u.name AS officer_name
		      FROM loan_applications la
		      LEFT JOIN users u ON u.id = la.officer_id
		      WHERE 1=1`
		args := []any{}
		n := 1
		if !user.HasPage("los_all") {
			q += fmt.Sprintf(" AND la.officer_id = $%d", n)
			args = append(args, user.ID)
			n++
		}
		q += " ORDER BY la.updated_at DESC LIMIT 20"
		_ = n
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// salesTopPerformers returns top 10 officers by disbursements this month.
func salesTopPerformers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.name, u.role,
			       COALESCE(SUM(la.amount_approved_kobo), 0) AS amount_kobo,
			       COUNT(la.id) AS count
			FROM loan_applications la
			JOIN users u ON u.id = la.officer_id
			WHERE la.stage = 'active'
			  AND DATE_TRUNC('month', la.updated_at) = DATE_TRUNC('month', NOW())
			GROUP BY u.id, u.name, u.role
			ORDER BY amount_kobo DESC LIMIT 10`)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
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

// ── Sales Targets (Wave 5G) ───────────────────────────────────────────────────

func salesTargetList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		where, args := "WHERE 1=1", []any{}
		if period != "" {
			where += fmt.Sprintf(" AND st.period=$%d", len(args)+1)
			args = append(args, period)
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT st.id, st.user_id, u.full_name, u.email, st.period,
			       st.loan_count, st.disbursement_kobo, st.notes, st.updated_at
			FROM sales_targets st
			JOIN o3c_users u ON u.id = st.user_id
			%s ORDER BY st.period DESC, u.full_name`, where), args...)
		if err != nil {
			respondErr(w, 500, "DB error"); return
		}
		if rows == nil { rows = []core.Row{} }
		respond(w, rows, "pg")
	}
}

func salesTargetCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			UserID           int64  `json:"user_id"`
			Period           string `json:"period"`
			LoanCount        int    `json:"loan_count"`
			DisbursementKobo int64  `json:"disbursement_kobo"`
			Notes            string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO sales_targets (user_id, period, loan_count, disbursement_kobo, notes, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6)
			 ON CONFLICT (user_id, period) DO UPDATE
			   SET loan_count=$3, disbursement_kobo=$4, notes=$5, updated_at=NOW()
			 RETURNING *`,
			body.UserID, body.Period, body.LoanCount, body.DisbursementKobo, body.Notes, user.ID)
		if err != nil {
			respondErr(w, 500, "DB error"); return
		}
		if len(rows) > 0 { respond(w, rows[0], "pg") }
	}
}

func salesTargetUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body struct {
			LoanCount        int    `json:"loan_count"`
			DisbursementKobo int64  `json:"disbursement_kobo"`
			Notes            string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		rows, err := db.PGQuery(r.Context(),
			`UPDATE sales_targets SET loan_count=$1, disbursement_kobo=$2, notes=$3, updated_at=NOW()
			 WHERE id=$4 RETURNING *`,
			body.LoanCount, body.DisbursementKobo, body.Notes, id)
		if err != nil || len(rows) == 0 { respondErr(w, 404, "Not found"); return }
		respond(w, rows[0], "pg")
	}
}

func salesTargetDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `DELETE FROM sales_targets WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(http.StatusNoContent)
	}
}

func salesTargetActuals(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		periodExpr := "DATE_TRUNC('month', NOW())"
		if period != "" && period != "current" {
			periodExpr = fmt.Sprintf("DATE_TRUNC('month', '%s'::date)", period)
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT u.id AS user_id, u.full_name,
			       COALESCE(t.loan_count,0)        AS target_loans,
			       COALESCE(t.disbursement_kobo,0) AS target_kobo,
			       COUNT(a.id)                     AS actual_loans,
			       COALESCE(SUM(a.amount_approved_kobo),0) AS actual_kobo
			FROM o3c_users u
			LEFT JOIN sales_targets t
			    ON t.user_id=u.id AND DATE_TRUNC('month',(t.period||'-01')::date)=%s
			LEFT JOIN loan_applications a
			    ON a.created_by_user_id=u.id
			    AND DATE_TRUNC('month',a.created_at)=%s
			    AND a.stage NOT IN ('withdrawn')
			WHERE u.role IN ('sales_officer','sales_head','bd_officer','bd_head')
			  AND u.deleted_at IS NULL
			GROUP BY u.id, u.full_name, t.loan_count, t.disbursement_kobo
			ORDER BY actual_kobo DESC`, periodExpr, periodExpr))
		if err != nil { respondErr(w, 500, "DB error"); return }
		if rows == nil { rows = []core.Row{} }
		respond(w, rows, "pg")
	}
}
