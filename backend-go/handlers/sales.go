package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// salesOfficerPredicate decides who counts as a sales/account officer, as a SQL
// fragment over an `o3c_users u`.
//
// It is deliberately not a bare `u.role IN (...)` list. Role literals were the
// reason every per-officer view rendered empty: nobody in o3c_users carries a
// sales_* role, yet people are demonstrably doing the job. Holding a book or
// carrying a target is evidence of the role regardless of the label on the
// account, so the predicate treats those as qualifying too. That way an officer
// shows up the moment they are given customers, without waiting on an admin to
// re-label them.
const salesOfficerPredicate = `
	u.role IN ('sales_officer','sales_head','head_sales','bd_officer','bd_head')
	OR EXISTS (SELECT 1 FROM customer_officers co WHERE co.officer_id = u.id)
	OR EXISTS (SELECT 1 FROM sales_targets st WHERE st.user_id = u.id)`

func RegisterSales(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("sales"))
	r.Get("/kpis", salesKPIs(db))
	r.Get("/loan-kpis", salesLoanKPIs(db))                         // loan-platform KPIs for Sales Overview
	r.Get("/monthly-disbursements", salesMonthlyDisbursements(db)) // 12-month disbursements trend
	r.Get("/recent-applications", salesRecentApplications(db))     // recent LOS applications
	r.Get("/top-performers", salesTopPerformers(db))               // top officers by disbursements
	r.Get("/contact-kpis", salesContactKPIs(db))                   // CRM contact KPIs
	r.Get("/task-kpis", salesTaskKPIs(db))                         // CRM task KPIs
	r.Get("/funnel", salesFunnel(db))
	r.Get("/accounts-trend", salesAccountsTrend(db))
	r.Get("/by-state", salesByState(db))
	r.Get("/by-city", salesByCity(db))
	r.Get("/manager-performance", salesManagerPerformance(db))
	r.Get("/product-mix", salesProductMix(db))
	r.Get("/customers", salesCustomers(db))

	// Sales Targets (Wave 5G)
	//
	// Reading a target is open to the team — an officer must be able to see the
	// number they are held to, and the league table is deliberately visible to
	// everyone. Writing is not: a target is set for you by your supervisor, never
	// by yourself. Until now every write here was reachable by any user holding
	// the `sales` page, so an officer could raise, lower or delete their own
	// target — and the actuals they are measured against came from the same page.
	r.Get("/targets", salesTargetList(db))
	r.Get("/targets/actuals", salesTargetActuals(db))
	r.Group(func(r chi.Router) {
		r.Use(requireSalesHead)
		r.Post("/targets", salesTargetCreate(db))
		r.Patch("/targets/{id}", salesTargetUpdate(db))
		r.Delete("/targets/{id}", salesTargetDelete(db))
	})

	// Marketing analytics (Wave 5G)
	r.Get("/by-lead-source", salesByLeadSource(db))
	r.Get("/campaign-attribution", salesCampaignAttribution(db))

	// Cohort heatmap
	r.Get("/cohort-matrix", salesCohortMatrix(db))
	r.Get("/cohort-detail", salesCohortDetail(db))

	// Agent dashboard
	r.Get("/my-dashboard", salesMyDashboard(db))
}

func salesMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		kpiRows, _ := db.PGQuery(ctx, `
			SELECT
				COUNT(CASE WHEN created_at >= DATE_TRUNC('month', NOW()) THEN 1 END)                                                          AS mtd_submitted,
				COALESCE(SUM(CASE WHEN stage = 'active' AND created_at >= DATE_TRUNC('month', NOW()) THEN disbursed_amount_kobo END), 0)      AS mtd_disbursed_kobo,
				COUNT(CASE WHEN stage NOT IN ('declined','cancelled') THEN 1 END)                                                             AS pipeline_count,
				COALESCE(SUM(CASE WHEN stage NOT IN ('declined','cancelled') THEN amount_requested_kobo END), 0)                              AS pipeline_kobo
			FROM loan_applications
			WHERE sales_officer_id = $1`, user.ID)

		stageRows, _ := db.PGQuery(ctx, `
			SELECT stage, COUNT(*) AS count
			FROM loan_applications
			WHERE sales_officer_id = $1
			  AND stage NOT IN ('declined','cancelled')
			GROUP BY stage
			ORDER BY count DESC`, user.ID)

		if stageRows == nil {
			stageRows = []core.Row{}
		}

		result := map[string]any{
			"mtd_submitted":      int64(0),
			"mtd_disbursed_kobo": int64(0),
			"pipeline_count":     int64(0),
			"pipeline_kobo":      int64(0),
			"stage_breakdown":    stageRows,
		}
		if len(kpiRows) > 0 {
			result["mtd_submitted"] = kpiRows[0]["mtd_submitted"]
			result["mtd_disbursed_kobo"] = kpiRows[0]["mtd_disbursed_kobo"]
			result["pipeline_count"] = kpiRows[0]["pipeline_count"]
			result["pipeline_kobo"] = kpiRows[0]["pipeline_kobo"]
		}

		respond(w, result, "pg")
	}
}

// salesLoanKPIs returns LOS-based KPIs for the Sales Overview page.
func salesLoanKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(CASE WHEN ($1='' OR created_at::date >= $1::date)
				            AND ($2='' OR created_at::date <= $2::date)
				           THEN 1 END)                                    AS submitted_mtd,
				COALESCE(SUM(
					CASE WHEN stage = 'active'
					     AND ($1='' OR updated_at::date >= $1::date)
					     AND ($2='' OR updated_at::date <= $2::date)
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
			FROM loan_applications`, from, to)
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
		from := qstr(r, "from")
		to := qstr(r, "to")
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
				AND ($1 = '' OR la.updated_at::date >= $1::date)
				AND ($2 = '' OR la.updated_at::date <= $2::date)
			GROUP BY m.m ORDER BY m.m`, from, to)
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
		from := qstr(r, "from")
		to := qstr(r, "to")
		// H13: use o3c_users (not legacy users table) and full_name column
		// loan_applications has no `officer_id`. The credited officer is
		// sales_officer_id, falling back to created_by for rows keyed before that
		// column existed. Selecting the missing name made every one of these
		// queries fail — and the handler swallows the error and returns [], so the
		// page rendered empty instead of reporting the fault.
		q := `SELECT la.id, la.stage, la.status, la.amount_requested_kobo,
		             la.amount_approved_kobo, la.created_at, la.updated_at,
		             la.applicant_name, la.product_type,
		             COALESCE(la.sales_officer_id, la.created_by) AS officer_id,
		             u.full_name AS officer_name
		      FROM loan_applications la
		      LEFT JOIN o3c_users u ON u.id = COALESCE(la.sales_officer_id, la.created_by)
		      WHERE 1=1`
		args := []any{}
		n := 1
		if !user.HasPage("los_all") {
			q += fmt.Sprintf(" AND COALESCE(la.sales_officer_id, la.created_by) = $%d", n)
			args = append(args, user.ID)
			n++
		}
		if from != "" {
			q += fmt.Sprintf(" AND la.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			q += fmt.Sprintf(" AND la.created_at::date <= $%d::date", n)
			args = append(args, to)
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

// salesTopPerformers returns top 10 officers by disbursements in the given period.
func salesTopPerformers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		// H13: use o3c_users (not legacy users table) and full_name column
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.full_name, u.role,
			       COALESCE(SUM(la.amount_approved_kobo), 0) AS amount_kobo,
			       COUNT(la.id) AS count
			FROM loan_applications la
			JOIN o3c_users u ON u.id = COALESCE(la.sales_officer_id, la.created_by)
			WHERE la.stage = 'active'
			  AND ($1 = '' OR la.updated_at::date >= $1::date)
			  AND ($2 = '' OR la.updated_at::date <= $2::date)
			GROUP BY u.id, u.full_name, u.role
			ORDER BY amount_kobo DESC LIMIT 10`, from, to)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// salesContactKPIs returns aggregate KPIs for CRM contacts.
func salesContactKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                                      AS total,
				COUNT(*) FILTER (WHERE updated_at >= DATE_TRUNC('month', NOW()))              AS active_this_month,
				COUNT(*) FILTER (WHERE ($1='' OR created_at::date >= $1::date)
				                   AND ($2='' OR created_at::date <= $2::date))               AS new_this_month,
				CASE WHEN COUNT(*) = 0 THEN 0::numeric
				     ELSE ROUND(COUNT(*) FILTER (WHERE status='customer')::numeric
				                / COUNT(*)::numeric * 100, 1)
				END                                                                           AS conversion_rate_pct
			FROM crm_contacts`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "active_this_month": int64(0),
				"new_this_month": int64(0), "conversion_rate_pct": 0.0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// salesTaskKPIs returns aggregate KPIs for CRM tasks.
func salesTaskKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                                      AS total,
				COUNT(*) FILTER (WHERE status='open')                                        AS open,
				COUNT(*) FILTER (WHERE status NOT IN ('done','cancelled') AND due_date<NOW()) AS overdue,
				COUNT(*) FILTER (WHERE status='done'
				    AND ($1='' OR updated_at::date >= $1::date)
				    AND ($2='' OR updated_at::date <= $2::date))                             AS completed_this_month
			FROM crm_tasks`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "open": int64(0),
				"overdue": int64(0), "completed_this_month": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func salesKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, pg string }
		for _, s := range []spec{
			{"total_customers",
				`SELECT COUNT(DISTINCT COALESCE('p'||party_id,'c'||contact_id)) AS val FROM app.customers`},
			{"new_mtd",
				`SELECT COUNT(*) AS val FROM (SELECT MIN(account_created) fc FROM app.customers GROUP BY COALESCE('p'||party_id,'c'||contact_id)) f WHERE DATE_TRUNC('month',f.fc)=DATE_TRUNC('month',CURRENT_DATE)`},
			{"ytd_new",
				`SELECT COUNT(*) AS val FROM (SELECT MIN(account_created) fc FROM app.customers GROUP BY COALESCE('p'||party_id,'c'||contact_id)) f WHERE EXTRACT(year FROM f.fc)=EXTRACT(year FROM CURRENT_DATE)`},
			{"active_cards",
				`SELECT COUNT(DISTINCT cif) AS val FROM app.accounts WHERE status IN ('Open','Active')`},
			{"total_cards",
				`SELECT COUNT(DISTINCT cif) AS val FROM app.accounts`},
			{"states_reached",
				`SELECT COUNT(DISTINCT state) AS val FROM app.customers WHERE state IS NOT NULL AND state != ''`},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.pg)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		prev, _, _ := db.DualScalar(ctx, "val",
			`SELECT COUNT(*) AS val FROM (SELECT MIN(account_created) fc FROM app.customers GROUP BY COALESCE('p'||party_id,'c'||contact_id)) f WHERE DATE_TRUNC('month',f.fc)=DATE_TRUNC('month',CURRENT_DATE-INTERVAL '1 month')`)
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
		for _, s := range []struct{ key, pg string }{
			{"registered",
				`SELECT COUNT(DISTINCT COALESCE('p'||party_id,'c'||contact_id)) AS val FROM app.customers`},
			{"card_issued",
				`SELECT COUNT(DISTINCT cif) AS val FROM app.accounts`},
			{"card_active",
				`SELECT COUNT(DISTINCT cif) AS val FROM app.accounts WHERE status IN ('Open','Active')`},
			{"transacting",
				`SELECT COUNT(DISTINCT cif) AS val FROM app.transactions`},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.pg)
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
		from, err1 := validDate(r, "from")
		to, err2 := validDate(r, "to")
		if err1 != nil || err2 != nil {
			respondErr(w, 400, "from and to must be YYYY-MM-DD dates")
			return
		}
		msWhere := "Account_Created IS NOT NULL"
		pgWhere := `account_created IS NOT NULL`
		if from != "" {
			msWhere += fmt.Sprintf(" AND Account_Created >= '%s'", from)
			pgWhere += fmt.Sprintf(` AND account_created >= '%s'`, from)
		}
		if to != "" {
			msWhere += fmt.Sprintf(" AND Account_Created <= '%s'", to)
			pgWhere += fmt.Sprintf(` AND account_created <= '%s'`, to)
		}
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TO_CHAR(DATE_TRUNC('month',account_created),'Mon YYYY') AS month,
			        DATE_TRUNC('month',account_created) AS month_sort,
			        COUNT(*) AS new_accounts
			 FROM (SELECT COALESCE('p'||party_id,'c'||contact_id) pk, MIN(account_created) AS account_created
			       FROM app.customers GROUP BY 1) f
			 WHERE %s
			 GROUP BY DATE_TRUNC('month',account_created) ORDER BY month_sort`, pgWhere))
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func salesByState(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT state AS "State", COUNT(DISTINCT COALESCE('p'||party_id,'c'||contact_id)) AS count FROM app.customers
			 WHERE state IS NOT NULL AND state!='' GROUP BY state ORDER BY count DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func salesByCity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT city AS "City", state AS "State", COUNT(DISTINCT COALESCE('p'||party_id,'c'||contact_id)) AS count FROM app.customers
			 WHERE city IS NOT NULL AND city!='' GROUP BY city,state ORDER BY count DESC LIMIT 20`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func salesManagerPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT NULL::text AS "Account Manager", 0::bigint AS total_accounts,
			        0::bigint AS active_accounts, 0::numeric AS activation_rate
			 WHERE false`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func salesProductMix(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT product_name AS "Product Name", COUNT(*) AS total,
			        SUM(CASE WHEN status IN ('Open','Active') THEN 1 ELSE 0 END) AS active
			 FROM app.accounts WHERE product_name IS NOT NULL GROUP BY product_name ORDER BY total DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func salesCustomers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 500)
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT a.cif, a.first_name AS "First Name", a.last_name AS "Last Name",
			        a.state AS "State", a.city AS "City", a.job_title AS "Job Title", a.account_created,
			        p."Product Name", p.status, p."Account Manager"
			 FROM app.customers a
			 LEFT JOIN LATERAL (
			     SELECT product_name AS "Product Name", status, NULL AS "Account Manager" FROM app.accounts
			     WHERE cif=a.cif
			     ORDER BY CASE WHEN status IN ('Open','Active') THEN 0 ELSE 1 END LIMIT 1
			 ) p ON true
			 ORDER BY a.account_created DESC LIMIT %d`, limit))
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

// ── Sales Targets (Wave 5G) ───────────────────────────────────────────────────

func salesTargetList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		from := qstr(r, "from")
		to := qstr(r, "to")
		where, args := "WHERE 1=1", []any{}
		if period != "" {
			where += fmt.Sprintf(" AND st.period=$%d", len(args)+1)
			args = append(args, period)
		}
		if from != "" {
			where += fmt.Sprintf(" AND st.updated_at::date >= $%d::date", len(args)+1)
			args = append(args, from)
		}
		if to != "" {
			where += fmt.Sprintf(" AND st.updated_at::date <= $%d::date", len(args)+1)
			args = append(args, to)
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT st.id, st.user_id, u.full_name, u.email, st.period,
			       st.loan_count, st.disbursement_kobo, st.notes, st.updated_at
			FROM sales_targets st
			JOIN o3c_users u ON u.id = st.user_id
			%s ORDER BY st.period DESC, u.full_name`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "DB error", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
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
			respondErr(w, 400, "Invalid JSON")
			return
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
			respondErrLog(w, 500, "DB error", err)
			return
		}
		if len(rows) > 0 {
			respond(w, rows[0], "pg")
		} else {
			respondErr(w, 500, "Target saved but no row returned")
		}
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
			respondErr(w, 400, "Invalid JSON")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`UPDATE sales_targets SET loan_count=$1, disbursement_kobo=$2, notes=$3, updated_at=NOW()
			 WHERE id=$4 RETURNING *`,
			body.LoanCount, body.DisbursementKobo, body.Notes, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
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
		from := qstr(r, "from")
		to := qstr(r, "to")
		periodExpr := "DATE_TRUNC('month', NOW())"
		if period != "" && period != "current" {
			if !periodRE.MatchString(period) {
				respondErr(w, 400, "period must be YYYY-MM")
				return
			}
			periodExpr = fmt.Sprintf("DATE_TRUNC('month', '%s-01'::date)", period)
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
			    ON COALESCE(a.sales_officer_id, a.created_by)=u.id
			    AND DATE_TRUNC('month',a.created_at)=%s
			    AND ($1 = '' OR a.created_at::date >= $1::date)
			    AND ($2 = '' OR a.created_at::date <= $2::date)
			    AND a.stage NOT IN ('withdrawn')
			WHERE u.deleted_at IS NULL AND (`+salesOfficerPredicate+`)
			GROUP BY u.id, u.full_name, t.loan_count, t.disbursement_kobo
			ORDER BY actual_kobo DESC`, periodExpr, periodExpr), from, to)
		if err != nil {
			respondErrLog(w, 500, "DB error", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func salesByLeadSource(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		where, args := "WHERE 1=1", []any{}
		if from != "" {
			where += fmt.Sprintf(" AND created_at::date >= $%d", len(args)+1)
			args = append(args, from)
		}
		if to != "" {
			where += fmt.Sprintf(" AND created_at::date <= $%d", len(args)+1)
			args = append(args, to)
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    COALESCE(lead_source,'unknown') AS lead_source,
			    COUNT(*)                        AS total_applications,
			    COUNT(CASE WHEN status NOT IN ('declined') THEN 1 END) AS approved,
			    COALESCE(SUM(CASE WHEN status NOT IN ('declined') THEN amount_approved_kobo END),0) AS disbursement_kobo
			FROM loan_applications
			%s
			GROUP BY COALESCE(lead_source,'unknown')
			ORDER BY total_applications DESC`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func salesCampaignAttribution(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		// Multi-signal attribution: a campaign recipient is a "conversion" if they
		// can be resolved to a customer (by CIF, else phone, else email via the
		// app.customers master) who took a CBS loan within 90 days AFTER the send.
		// Each conversion is tagged with the matching basis. If the customer master
		// is absent, degrade gracefully to CIF-only resolution.
		where, args := "WHERE 1=1", []any{}
		if from != "" {
			where += fmt.Sprintf(" AND c.created_at::date >= $%d", len(args)+1)
			args = append(args, from)
		}
		if to != "" {
			where += fmt.Sprintf(" AND c.created_at::date <= $%d", len(args)+1)
			args = append(args, to)
		}
		// Optional single-campaign scope — powers the per-campaign attribution
		// block on the campaign Results page.
		if cid := qstr(r, "campaign_id"); cid != "" {
			where += fmt.Sprintf(" AND c.id = $%d", len(args)+1)
			args = append(args, cid)
		}

		hasMaster := false
		var reg *string
		if err := db.PG.QueryRowContext(r.Context(), `SELECT to_regclass('app.customers')`).Scan(&reg); err == nil && reg != nil && *reg != "" {
			hasMaster = true
		}

		acctCTE := ``
		resolvedCTE := `resolved AS (
			SELECT cc.campaign_id, NULLIF(cc.cif_number,'') AS cif, 'cif'::text AS basis
			FROM campaign_contacts cc)`
		if hasMaster {
			acctCTE = `
			acct_phone AS (
				SELECT p10, MIN(cif) AS cif FROM (
					SELECT right(regexp_replace(phone,'\D','','g'),10) AS p10, cif AS cif
					FROM app.customers WHERE length(regexp_replace(COALESCE(phone,''),'\D','','g')) >= 10
				) x GROUP BY p10 HAVING count(DISTINCT cif) = 1),
			acct_email AS (
				SELECT em, MIN(cif) AS cif FROM (
					SELECT lower(email) AS em, cif AS cif FROM app.customers WHERE COALESCE(email,'') <> ''
				) x GROUP BY em HAVING count(DISTINCT cif) = 1),`
			resolvedCTE = `resolved AS (
				SELECT cc.campaign_id,
				       COALESCE(NULLIF(cc.cif_number,''), ap.cif, ae.cif) AS cif,
				       CASE WHEN NULLIF(cc.cif_number,'') IS NOT NULL THEN 'cif'
				            WHEN ap.cif IS NOT NULL THEN 'phone'
				            WHEN ae.cif IS NOT NULL THEN 'email' END AS basis
				FROM campaign_contacts cc
				LEFT JOIN acct_phone ap ON cc.phone IS NOT NULL AND cc.phone <> ''
				     AND ap.p10 = right(regexp_replace(cc.phone,'\D','','g'),10)
				LEFT JOIN acct_email ae ON cc.email IS NOT NULL AND cc.email <> ''
				     AND ae.em = lower(cc.email))`
		}

		q := `WITH ` + acctCTE + resolvedCTE + `,
			conv AS (
				SELECT DISTINCT ON (r.campaign_id, r.cif)
				       r.campaign_id, r.cif, r.basis,
				       (SELECT COALESCE(SUM(l.loan_amount_kobo),0) FROM cbs_loans l
				        WHERE l.cbs_customer_id = r.cif
				          AND l.start_date >= COALESCE(c.started_at, c.created_at)
				          AND l.start_date <  COALESCE(c.started_at, c.created_at) + interval '90 days') AS amt
				FROM resolved r JOIN campaigns c ON c.id = r.campaign_id
				WHERE r.cif IS NOT NULL
				  AND EXISTS (SELECT 1 FROM cbs_loans l WHERE l.cbs_customer_id = r.cif
				              AND l.start_date >= COALESCE(c.started_at, c.created_at)
				              AND l.start_date <  COALESCE(c.started_at, c.created_at) + interval '90 days')
				ORDER BY r.campaign_id, r.cif,
				         CASE r.basis WHEN 'cif' THEN 1 WHEN 'phone' THEN 2 ELSE 3 END)
			SELECT c.id AS campaign_id, c.name AS campaign_name, c.type AS campaign_type,
			       (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id) AS contacts_reached,
			       COUNT(cv.cif) AS conversions,
			       COUNT(cv.cif) FILTER (WHERE cv.basis='cif')   AS matched_cif,
			       COUNT(cv.cif) FILTER (WHERE cv.basis='phone') AS matched_phone,
			       COUNT(cv.cif) FILTER (WHERE cv.basis='email') AS matched_email,
			       COALESCE(SUM(cv.amt),0) AS attributed_disbursement_kobo
			FROM campaigns c
			LEFT JOIN conv cv ON cv.campaign_id = c.id
			` + where + `
			GROUP BY c.id, c.name, c.type
			ORDER BY conversions DESC, contacts_reached DESC`

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── Cohort Heatmap ────────────────────────────────────────────────────────────

// salesCohortMatrix returns a retention heatmap: for each booking-month cohort,
// what % of accounts were still transacting at 1m / 3m / 6m / 9m / 12m.
// Uses loan_applications as the cohort source. "Transacting" = status not in
// (rejected, cancelled, withdrawn) at the measured age.
func salesCohortMatrix(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")

		var dateWhere string
		var args []any
		n := 1
		if from != "" {
			dateWhere += fmt.Sprintf(" AND DATE_TRUNC('month', created_at) >= DATE_TRUNC('month', $%d::date)", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			dateWhere += fmt.Sprintf(" AND DATE_TRUNC('month', created_at) <= DATE_TRUNC('month', $%d::date)", n)
			args = append(args, to)
			n++
		}
		_ = n

		rows, err := db.PGQuery(r.Context(), `
			SELECT
				TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS cohort_month,
				COUNT(*) AS cohort_size,
				-- Retention at age N = % still active at month N after booking
				ROUND(100.0 * COUNT(*) FILTER (
					WHERE status NOT IN ('rejected','cancelled','withdrawn')
					  AND created_at <= NOW() - INTERVAL '1 month'
				) / NULLIF(COUNT(*), 0), 1) AS ret_1m,
				ROUND(100.0 * COUNT(*) FILTER (
					WHERE status NOT IN ('rejected','cancelled','withdrawn')
					  AND created_at <= NOW() - INTERVAL '3 months'
				) / NULLIF(COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '3 months'), 0), 1) AS ret_3m,
				ROUND(100.0 * COUNT(*) FILTER (
					WHERE status NOT IN ('rejected','cancelled','withdrawn')
					  AND created_at <= NOW() - INTERVAL '6 months'
				) / NULLIF(COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '6 months'), 0), 1) AS ret_6m,
				ROUND(100.0 * COUNT(*) FILTER (
					WHERE status NOT IN ('rejected','cancelled','withdrawn')
					  AND created_at <= NOW() - INTERVAL '9 months'
				) / NULLIF(COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '9 months'), 0), 1) AS ret_9m,
				ROUND(100.0 * COUNT(*) FILTER (
					WHERE status NOT IN ('rejected','cancelled','withdrawn')
					  AND created_at <= NOW() - INTERVAL '12 months'
				) / NULLIF(COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '12 months'), 0), 1) AS ret_12m,
				-- PAR30 rates per cohort age
				ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(dpd,0) > 30) / NULLIF(COUNT(*),0), 1) AS par30_current
			FROM loan_applications
			WHERE stage NOT IN ('draft') `+dateWhere+`
			GROUP BY DATE_TRUNC('month', created_at)
			ORDER BY DATE_TRUNC('month', created_at) DESC
			LIMIT 24`, args...)

		if err != nil {
			respond(w, []core.Row{}, "pg")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// salesCohortDetail returns the list of loan applications in a specific cohort-month
// so the frontend can drill into a heatmap cell.
func salesCohortDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cohort := qstr(r, "cohort") // e.g. "2024-03"
		if cohort == "" {
			respondErr(w, 400, "cohort required (YYYY-MM)")
			return
		}
		stage := qstr(r, "stage")
		limit := qint(r, "limit", 100, 1, 500)

		q := `
			SELECT
				id, reference, applicant_name,
				COALESCE(product_type, loan_type, '') AS product_type,
				COALESCE(employer, '') AS employer,
				COALESCE(amount_requested_kobo, 0) AS amount_requested_kobo,
				COALESCE(outstanding_kobo, 0) AS outstanding_kobo,
				COALESCE(dpd, 0) AS dpd,
				status, stage, created_at
			FROM loan_applications
			WHERE TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') = $1`
		args := []any{cohort}
		n := 2
		if stage != "" {
			q += fmt.Sprintf(" AND stage = $%d", n)
			args = append(args, stage)
			n++
		}
		q += fmt.Sprintf(" ORDER BY created_at DESC LIMIT $%d", n)
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respond(w, map[string]any{"data": []any{}, "cohort": cohort}, "pg")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// Quick summary stats
		var totalOutstanding int64
		var par30Count int64
		for _, row := range rows {
			totalOutstanding += toInt64(row["outstanding_kobo"])
			if toInt64(row["dpd"]) > 30 {
				par30Count++
			}
		}

		respond(w, map[string]any{
			"cohort":            cohort,
			"data":              rows,
			"count":             len(rows),
			"total_outstanding": totalOutstanding,
			"par30_count":       par30Count,
		}, "pg")
	}
}
