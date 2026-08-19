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

// crmLeadStageCase maps the stored lead_stage vocabulary onto the five display
// stages the sales UI colours (Prospect/Qualified/Proposal/Negotiation/Won). Shared
// by the officer dashboard and the supervisor funnel so both read the same way.
const crmLeadStageCase = `CASE lower(COALESCE(lead_stage,'new'))
	WHEN 'new' THEN 'Prospect' WHEN 'contacted' THEN 'Prospect'
	WHEN 'qualified' THEN 'Qualified' WHEN 'proposal' THEN 'Proposal'
	WHEN 'negotiation' THEN 'Negotiation'
	WHEN 'converted' THEN 'Won' WHEN 'won' THEN 'Won'
	ELSE initcap(COALESCE(lead_stage,'Prospect')) END`

func RegisterSales(r chi.Router, db *core.DB) {
	// This is only the FIRST of several registrars mounted on the shared
	// /api/sales router (main.go also mounts RegisterSalesBook, RegisterSalesLeads,
	// RegisterSalesOverview, RegisterSalesApplications on this same router). A bare
	// `r.Use(core.RequirePages("sales"))` here would apply to ALL of them and
	// override the wider per-route guards those files declare (sales+crm_contacts,
	// sales+crm_contacts+bd, …) — locking BD/call-centre users who hold
	// crm_contacts/bd but not `sales` out of the entire /api/sales tree.
	//
	// Confine the `sales` page requirement to THIS registrar's own routes with an
	// inline r.Group sub-router. In chi, r.Group's middleware applies only to the
	// routes registered inside the closure; it does not touch routes the sibling
	// registrars add to the parent router.
	r.Group(func(r chi.Router) {
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

		// Team-lead live view (the sales analogue of the call-centre supervisor).
		r.Get("/supervisor", salesSupervisor(db))
	})

	// Commission rates live OUTSIDE the sales-page group: Finance sets them, and a
	// finance_officer/finance_head does not hold the `sales` page. Grant read+write to
	// sales, income or finance page holders; salesSetCommissionRates() then enforces
	// that only Finance/admin ROLES may actually change them.
	commissionAccess := core.RequirePages("sales", "income", "finance")
	r.With(commissionAccess).Get("/commission-rates", salesCommissionRates(db))
	r.With(commissionAccess).Put("/commission-rates", salesSetCommissionRates(db))
}

// salesSupervisor powers the live team view (frontend sales/Supervisor.tsx). It is
// the sales counterpart of the call-centre supervisor wallboard: one row per officer
// with their live workload, team totals, the open-pipeline funnel, and the pool of
// unowned leads waiting to be distributed. Read-only and cheap enough to poll.
//
// "Officer" here is anyone the salesOfficerPredicate recognises — holding a book, a
// target, or a sales role. Before the first distribution nobody qualifies and the
// wallboard is empty by design; the page shows a distribute prompt in that state.
func salesSupervisor(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{
			"totals":        map[string]any{},
			"officers":      []core.Row{},
			"funnel":        []core.Row{},
			"unowned_leads": []core.Row{},
		}

		// Team totals across the whole lead book.
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (WHERE status='lead')                                              AS total_leads,
			  COUNT(*) FILTER (WHERE status='lead' AND lead_owner_id IS NULL)                     AS unowned_leads,
			  COUNT(*) FILTER (WHERE status='customer' AND converted_at>=DATE_TRUNC('month',NOW())) AS converted_mtd,
			  COUNT(*) FILTER (WHERE status='lead' AND next_action_at::date < CURRENT_DATE)        AS overdue_followups,
			  COALESCE(SUM(estimated_value_kobo) FILTER (WHERE status='lead'),0)                   AS pipeline_kobo
			FROM crm_contacts`); len(rows) > 0 {
			out["totals"] = rows[0]
		}

		// Per-officer live workload. LEFT JOIN keeps an officer with zero owned leads
		// on the board (a book or a target is enough to qualify them).
		if rows, _ := db.PGQuery(ctx, `
			SELECT u.id, u.full_name, u.role, u.is_active,
			  COUNT(c.id) FILTER (WHERE c.status='lead')                                          AS open_leads,
			  COUNT(c.id) FILTER (WHERE c.status='lead' AND c.next_action_at::date < CURRENT_DATE) AS overdue,
			  COUNT(c.id) FILTER (WHERE c.status='lead' AND c.lead_stage IN ('contacted','qualified')
			                      AND (c.last_activity_at IS NULL
			                           OR c.last_activity_at < NOW()-INTERVAL '14 days'))          AS stalled,
			  COUNT(c.id) FILTER (WHERE c.status='customer'
			                      AND c.converted_at>=DATE_TRUNC('month',NOW()))                   AS converted_mtd,
			  COALESCE(SUM(c.estimated_value_kobo) FILTER (WHERE c.status='lead'),0)               AS pipeline_kobo,
			  (SELECT COUNT(*) FROM customer_officers co WHERE co.officer_id=u.id)                 AS book_size
			FROM o3c_users u
			LEFT JOIN crm_contacts c ON c.lead_owner_id = u.id
			WHERE u.deleted_at IS NULL AND u.is_active AND (`+salesOfficerPredicate+`)
			GROUP BY u.id, u.full_name, u.role, u.is_active
			ORDER BY open_leads DESC, converted_mtd DESC, u.full_name`); len(rows) > 0 {
			out["officers"] = rows
		}

		// Open-pipeline funnel by stage.
		if rows, _ := db.PGQuery(ctx, `
			SELECT stage, cnt, value_kobo FROM (
			  SELECT `+crmLeadStageCase+` AS stage, COUNT(*) AS cnt,
			         COALESCE(SUM(estimated_value_kobo),0) AS value_kobo
			  FROM crm_contacts WHERE status='lead' GROUP BY 1
			) s
			ORDER BY CASE stage WHEN 'Prospect' THEN 1 WHEN 'Qualified' THEN 2
			                    WHEN 'Proposal' THEN 3 WHEN 'Negotiation' THEN 4
			                    WHEN 'Won' THEN 5 ELSE 6 END`); len(rows) > 0 {
			out["funnel"] = rows
		}

		// A sample of the unowned pool — the concrete worklist behind the Distribute
		// button.
		if rows, _ := db.PGQuery(ctx, `
			SELECT id,
			  NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS name,
			  COALESCE(lead_source,'unrecorded') AS lead_source, phone, created_at
			FROM crm_contacts
			WHERE status='lead' AND lead_owner_id IS NULL
			ORDER BY created_at DESC NULLS LAST
			LIMIT 12`); len(rows) > 0 {
			out["unowned_leads"] = rows
		}

		respond(w, out, "pg")
	}
}

// salesMyDashboard powers the sales officer's personal station
// (frontend/src/pages/sales/MyDashboard.tsx, GET /api/sales/my-dashboard).
//
// It previously read loan_applications — an empty table — and, worse, returned a
// shape (mtd_submitted / pipeline_count / stage_breakdown) that the page never
// consumed. The page reads {my_leads, won_mtd, conversion_rate_pct, target_kobo,
// achieved_kobo, target_pct, pipeline[], recent_leads[], monthly_trend[]}, so
// `data.pipeline` came back undefined and `data.pipeline.filter(...)` threw on
// render — the officer's home page was a white screen. This rebuilds the handler
// to emit exactly that contract from the tables that actually hold sales data:
//
//   - leads/pipeline  → crm_contacts, owned via lead_owner_id (the canonical
//     lead-owner column used across the sales module)
//   - target          → sales_targets.disbursement_kobo for the current month
//   - achieved        → loans + FDs booked this month on the CIFs this officer
//     owns (customer_officers) — the SAME attribution the
//     Targets page uses, so the two pages agree
//
// Ownership/targets are unpopulated until Phase 1 distributes leads and sets
// targets, so today this returns clean zeros for every officer rather than
// crashing; it lights up automatically once that data exists.
func salesMyDashboard(db *core.DB) http.HandlerFunc {
	const stageCase = crmLeadStageCase

	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()
		uid := user.ID

		result := map[string]any{
			"my_leads":            int64(0),
			"won_mtd":             int64(0),
			"conversion_rate_pct": 0.0,
			"target_kobo":         int64(0),
			"achieved_kobo":       int64(0),
			"target_pct":          0.0,
			"commission_kobo":     int64(0),
			"pipeline":            []core.Row{},
			"recent_leads":        []core.Row{},
			"monthly_trend":       []core.Row{},
			// Phase 2 additions (agent-station parity with the call centre).
			"rank_mtd":          int64(0),
			"team_size":         int64(0),
			"followups_due":     int64(0),
			"followups_overdue": int64(0),
			"stalled_leads":     int64(0),
			"next_followups":    []core.Row{},
			"recent_activity":   []core.Row{},
		}

		// Lead headline + lifetime conversion for the signed-in officer.
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (WHERE status = 'lead')                                          AS my_leads,
			  COUNT(*) FILTER (WHERE status = 'customer'
			                   AND converted_at >= DATE_TRUNC('month', NOW()))                 AS won_mtd,
			  CASE WHEN COUNT(*) = 0 THEN 0::numeric
			       ELSE ROUND(COUNT(*) FILTER (WHERE status = 'customer')::numeric
			                  / COUNT(*)::numeric * 100, 1) END                                AS conversion_rate_pct
			FROM crm_contacts
			WHERE lead_owner_id = $1`, uid); len(rows) > 0 {
			result["my_leads"] = rows[0]["my_leads"]
			result["won_mtd"] = rows[0]["won_mtd"]
			result["conversion_rate_pct"] = rows[0]["conversion_rate_pct"]
		}

		// Target (this month) vs achieved (loans + FDs booked this month on owned CIFs).
		if rows, _ := db.PGQuery(ctx, `
			WITH tgt AS (
			  SELECT COALESCE(disbursement_kobo,0) AS target_kobo
			  FROM sales_targets
			  WHERE user_id = $1
			    AND DATE_TRUNC('month',(period||'-01')::date) = DATE_TRUNC('month', NOW())
			  LIMIT 1
			),
			loan AS (
			  SELECT COALESCE(SUM(l.loan_amount_kobo),0) AS kobo
			  FROM customer_officers co
			  JOIN cbs_loans l ON l.cbs_customer_id = co.cif
			  WHERE co.officer_id = $1
			    AND DATE_TRUNC('month', l.start_date) = DATE_TRUNC('month', NOW())
			),
			fd AS (
			  SELECT COALESCE(SUM(f.principal_kobo),0) AS kobo
			  FROM customer_officers co
			  JOIN cbs_fixed_deposits f ON f.cbs_customer_id = co.cif
			  WHERE co.officer_id = $1
			    AND DATE_TRUNC('month', f.commencement_date) = DATE_TRUNC('month', NOW())
			),
			card AS (
			  SELECT COUNT(a.account_id) AS n
			  FROM customer_officers co
			  JOIN app.accounts a ON a.cif = co.cif
			  WHERE co.officer_id = $1
			    AND a.product_line IN ('prepaid','credit_card')
			    AND a.opened_date IS NOT NULL
			    AND DATE_TRUNC('month', a.opened_date) = DATE_TRUNC('month', NOW())
			)
			SELECT
			  COALESCE((SELECT target_kobo FROM tgt),0)                     AS target_kobo,
			  (SELECT kobo FROM loan) + (SELECT kobo FROM fd)               AS achieved_kobo,
			  (SELECT kobo FROM loan)                                       AS loan_kobo,
			  (SELECT kobo FROM fd)                                         AS fd_kobo,
			  (SELECT n FROM card)                                          AS card_count,
			  CASE WHEN COALESCE((SELECT target_kobo FROM tgt),0) = 0 THEN 0::numeric
			       ELSE ROUND(((SELECT kobo FROM loan)+(SELECT kobo FROM fd))::numeric
			                  / (SELECT target_kobo FROM tgt)::numeric * 100, 1) END AS target_pct`, uid); len(rows) > 0 {
			result["target_kobo"] = rows[0]["target_kobo"]
			result["achieved_kobo"] = rows[0]["achieved_kobo"]
			result["target_pct"] = rows[0]["target_pct"]
			// Commission earned MTD, from the Finance-set rates.
			cr := loadCommissionRates(ctx, db)
			result["commission_kobo"] = cr.commissionKobo(
				toInt64(rows[0]["loan_kobo"]), toInt64(rows[0]["fd_kobo"]), toInt64(rows[0]["card_count"]))
		}

		// Open pipeline by stage (leads only; won leads leave the open pipeline).
		if rows, _ := db.PGQuery(ctx, `
			SELECT stage, count, value_kobo FROM (
			  SELECT `+stageCase+` AS stage,
			         COUNT(*)                              AS count,
			         COALESCE(SUM(estimated_value_kobo),0) AS value_kobo
			  FROM crm_contacts
			  WHERE lead_owner_id = $1 AND status = 'lead'
			  GROUP BY 1
			) s
			ORDER BY CASE stage WHEN 'Prospect' THEN 1 WHEN 'Qualified' THEN 2
			                    WHEN 'Proposal' THEN 3 WHEN 'Negotiation' THEN 4
			                    WHEN 'Won' THEN 5 ELSE 6 END`, uid); len(rows) > 0 {
			result["pipeline"] = rows
		}

		// Most recently touched leads. lead_score has no source model yet (Phase 2
		// introduces one); emit 0 rather than invent a number.
		if rows, _ := db.PGQuery(ctx, `
			SELECT id,
			  COALESCE(NULLIF(employer,''),
			           NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')) AS company_name,
			  NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'')            AS contact_name,
			  `+stageCase+`                                                                     AS stage,
			  COALESCE(estimated_value_kobo,0)                                                  AS potential_value_kobo,
			  updated_at,
			  0                                                                                 AS lead_score
			FROM crm_contacts
			WHERE lead_owner_id = $1
			ORDER BY updated_at DESC NULLS LAST
			LIMIT 15`, uid); len(rows) > 0 {
			result["recent_leads"] = rows
		}

		// Six-month trend of leads created vs. leads won, for this officer.
		if rows, _ := db.PGQuery(ctx, `
			WITH months AS (
			  SELECT generate_series(DATE_TRUNC('month', NOW() - INTERVAL '5 months'),
			                         DATE_TRUNC('month', NOW()), '1 month'::interval) AS m
			)
			SELECT TO_CHAR(m.m,'Mon') AS month,
			  COUNT(c.id) FILTER (WHERE DATE_TRUNC('month', c.created_at)   = m.m) AS leads,
			  COUNT(c.id) FILTER (WHERE DATE_TRUNC('month', c.converted_at) = m.m) AS won
			FROM months m
			LEFT JOIN crm_contacts c
			  ON c.lead_owner_id = $1
			 AND (DATE_TRUNC('month', c.created_at) = m.m
			   OR DATE_TRUNC('month', c.converted_at) = m.m)
			GROUP BY m.m ORDER BY m.m`, uid); len(rows) > 0 {
			result["monthly_trend"] = rows
		}

		// Gamified rank among officers who hold leads — the "you're Nth of M" nudge
		// the call-centre station uses. Ranked by conversions this month, then by
		// book size, so an officer who has not converted yet is ordered by effort.
		if rows, _ := db.PGQuery(ctx, `
			WITH officer AS (
			  SELECT lead_owner_id AS uid,
			         COUNT(*) FILTER (WHERE status='customer'
			                          AND converted_at >= DATE_TRUNC('month',NOW())) AS won,
			         COUNT(*) AS owned
			  FROM crm_contacts WHERE lead_owner_id IS NOT NULL GROUP BY 1
			),
			ranked AS (
			  SELECT uid, RANK() OVER (ORDER BY won DESC, owned DESC) AS rnk,
			         COUNT(*) OVER () AS team
			  FROM officer
			)
			SELECT COALESCE((SELECT rnk FROM ranked WHERE uid=$1),0)  AS rank_mtd,
			       COALESCE((SELECT MAX(team) FROM ranked),0)         AS team_size`, uid); len(rows) > 0 {
			result["rank_mtd"] = rows[0]["rank_mtd"]
			result["team_size"] = rows[0]["team_size"]
		}

		// Follow-up pressure on the officer's own open leads (fed by the activity
		// denorm sync added in Phase 1).
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (WHERE next_action_at::date = CURRENT_DATE)                       AS followups_due,
			  COUNT(*) FILTER (WHERE next_action_at::date < CURRENT_DATE)                       AS followups_overdue,
			  COUNT(*) FILTER (WHERE lead_stage IN ('contacted','qualified')
			                   AND (last_activity_at IS NULL
			                        OR last_activity_at < NOW() - INTERVAL '14 days'))          AS stalled_leads
			FROM crm_contacts
			WHERE lead_owner_id = $1 AND status = 'lead'`, uid); len(rows) > 0 {
			result["followups_due"] = rows[0]["followups_due"]
			result["followups_overdue"] = rows[0]["followups_overdue"]
			result["stalled_leads"] = rows[0]["stalled_leads"]
		}

		// The concrete follow-up worklist — soonest first, overdue at the top.
		if rows, _ := db.PGQuery(ctx, `
			SELECT id,
			  NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS name,
			  next_action_at, lead_stage, phone,
			  COALESCE(estimated_value_kobo,0) AS estimated_value_kobo
			FROM crm_contacts
			WHERE lead_owner_id = $1 AND status = 'lead' AND next_action_at IS NOT NULL
			ORDER BY next_action_at ASC
			LIMIT 12`, uid); len(rows) > 0 {
			result["next_followups"] = rows
		}

		// The officer's own recent activity feed.
		if rows, _ := db.PGQuery(ctx, `
			SELECT a.id, a.type, a.subject, a.outcome, a.created_at, a.contact_id,
			  NULLIF(TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')),'') AS contact_name
			FROM crm_activities a
			JOIN crm_contacts c ON c.id = a.contact_id
			WHERE a.created_by = $1
			ORDER BY a.created_at DESC
			LIMIT 12`, uid); len(rows) > 0 {
			result["recent_activity"] = rows
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

// salesManagerPerformance ranks each account officer ("Account Manager") by the
// applications they carry and how many of those actually booked. There is no
// manager hierarchy on o3c_users, so the officer who owns the application is the
// unit of measure here — the same officer/user join salesTopPerformers and
// salesTargetActuals use. "active_accounts" counts booked/disbursed loans using
// the file-wide booked definition (stage='active'), so activation_rate is the
// share of an officer's book that actually funded. Kept Postgres-only because
// loan_applications / o3c_users are PG tables (as elsewhere in this file), and
// the declared column shape (Account Manager / total / active / rate) is
// preserved so any future consumer sees the contract it expects.
func salesManagerPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.full_name AS "Account Manager",
			       COUNT(la.id)                                          AS total_accounts,
			       COUNT(la.id) FILTER (WHERE la.stage = 'active')       AS active_accounts,
			       CASE WHEN COUNT(la.id) = 0 THEN 0::numeric
			            ELSE ROUND(
			                COUNT(la.id) FILTER (WHERE la.stage = 'active')::numeric
			                / COUNT(la.id)::numeric * 100, 1)
			       END                                                   AS activation_rate
			FROM loan_applications la
			JOIN o3c_users u ON u.id = COALESCE(la.sales_officer_id, la.created_by)
			WHERE ($1 = '' OR la.created_at::date >= $1::date)
			  AND ($2 = '' OR la.created_at::date <= $2::date)
			GROUP BY u.id, u.full_name
			ORDER BY active_accounts DESC, total_accounts DESC`, from, to)
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
			       st.loan_count, st.disbursement_kobo,
			       st.fd_count, st.fd_amount_kobo, st.notes, st.updated_at
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
			FDCount          int    `json:"fd_count"`
			FDAmountKobo     int64  `json:"fd_amount_kobo"`
			CardCount        int    `json:"card_count"`
			Notes            string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO sales_targets (user_id, period, loan_count, disbursement_kobo, fd_count, fd_amount_kobo, card_count, notes, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			 ON CONFLICT (user_id, period) DO UPDATE
			   SET loan_count=$3, disbursement_kobo=$4, fd_count=$5, fd_amount_kobo=$6, card_count=$7, notes=$8, updated_at=NOW()
			 RETURNING *`,
			body.UserID, body.Period, body.LoanCount, body.DisbursementKobo, body.FDCount, body.FDAmountKobo, body.CardCount, body.Notes, user.ID)
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
			FDCount          int    `json:"fd_count"`
			FDAmountKobo     int64  `json:"fd_amount_kobo"`
			CardCount        int    `json:"card_count"`
			Notes            string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`UPDATE sales_targets SET loan_count=$1, disbursement_kobo=$2, fd_count=$3, fd_amount_kobo=$4, card_count=$5, notes=$6, updated_at=NOW()
			 WHERE id=$7 RETURNING *`,
			body.LoanCount, body.DisbursementKobo, body.FDCount, body.FDAmountKobo, body.CardCount, body.Notes, id)
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
		// Actuals now come from the Udara CBS snapshot (cbs_loans / cbs_fixed_deposits),
		// not loan_applications. Both books key on cbs_customer_id, which carries the
		// CIF, and officer attribution flows through customer_officers (officer_id owns a
		// cif). The two book aggregations are pre-grouped per officer in subqueries and
		// LEFT JOINed onto o3c_users so the every-officer-with-a-target-shows-up
		// behaviour is preserved: the anchor is still the officer row, and an officer
		// with a target but no booked loans/FDs comes back with zeros rather than
		// dropping out. customer_officers may be empty today (0 officers) — that just
		// yields all-zero actuals, which is correct.
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT u.id AS user_id, u.full_name,
			       COALESCE(t.loan_count,0)        AS target_loans,
			       COALESCE(t.disbursement_kobo,0) AS target_kobo,
			       COALESCE(t.fd_count,0)          AS target_fds,
			       COALESCE(t.fd_amount_kobo,0)    AS target_fd_kobo,
			       COALESCE(t.card_count,0)        AS target_cards,
			       COALESCE(la.actual_loans,0)     AS actual_loans,
			       COALESCE(la.actual_kobo,0)      AS actual_kobo,
			       COALESCE(fd.actual_fds,0)       AS actual_fds,
			       COALESCE(fd.actual_fd_kobo,0)   AS actual_fd_kobo,
			       COALESCE(cd.actual_cards,0)     AS actual_cards
			FROM o3c_users u
			LEFT JOIN sales_targets t
			    ON t.user_id=u.id AND DATE_TRUNC('month',(t.period||'-01')::date)=%s
			LEFT JOIN (
			    SELECT co.officer_id,
			           COUNT(l.cbs_id)                     AS actual_loans,
			           COALESCE(SUM(l.loan_amount_kobo),0) AS actual_kobo
			    FROM customer_officers co
			    JOIN cbs_loans l ON l.cbs_customer_id = co.cif
			    WHERE DATE_TRUNC('month', l.start_date) = %s
			      AND ($1 = '' OR l.start_date::date >= $1::date)
			      AND ($2 = '' OR l.start_date::date <= $2::date)
			    GROUP BY co.officer_id
			) la ON la.officer_id = u.id
			LEFT JOIN (
			    SELECT co.officer_id,
			           COUNT(f.cbs_id)                   AS actual_fds,
			           COALESCE(SUM(f.principal_kobo),0) AS actual_fd_kobo
			    FROM customer_officers co
			    JOIN cbs_fixed_deposits f ON f.cbs_customer_id = co.cif
			    WHERE DATE_TRUNC('month', f.commencement_date) = %s
			      AND ($1 = '' OR f.commencement_date::date >= $1::date)
			      AND ($2 = '' OR f.commencement_date::date <= $2::date)
			    GROUP BY co.officer_id
			) fd ON fd.officer_id = u.id
			LEFT JOIN (
			    -- Cards issued in the period by the officer's customers. The card book is
			    -- app.accounts (product_line 'prepaid'/'credit_card'), keyed by cif, dated
			    -- on opened_date. Attribution flows through customer_officers like loans/FDs.
			    SELECT co.officer_id,
			           COUNT(a.account_id) AS actual_cards
			    FROM customer_officers co
			    JOIN app.accounts a ON a.cif = co.cif
			    WHERE a.product_line IN ('prepaid','credit_card')
			      AND a.opened_date IS NOT NULL
			      AND DATE_TRUNC('month', a.opened_date) = %s
			      AND ($1 = '' OR a.opened_date >= $1::date)
			      AND ($2 = '' OR a.opened_date <= $2::date)
			    GROUP BY co.officer_id
			) cd ON cd.officer_id = u.id
			WHERE u.deleted_at IS NULL AND (`+salesOfficerPredicate+`)
			ORDER BY actual_kobo DESC`, periodExpr, periodExpr, periodExpr, periodExpr), from, to)
		if err != nil {
			respondErrLog(w, 500, "DB error", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Attach earned commission per officer from the Finance-set rates.
		cr := loadCommissionRates(r.Context(), db)
		for _, row := range rows {
			row["commission_kobo"] = cr.commissionKobo(
				toInt64(row["actual_kobo"]), toInt64(row["actual_fd_kobo"]), toInt64(row["actual_cards"]))
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
		// Role-aware scope: an officer only ever sees their own book; a head sees the
		// whole team and may narrow to one officer via ?officer_id=.
		if user := core.UserFromCtx(r.Context()); user != nil && !isSalesHead(user) {
			dateWhere += fmt.Sprintf(" AND sales_officer_id = $%d", n)
			args = append(args, user.ID)
			n++
		} else if oid := qstr(r, "officer_id"); oid != "" {
			if id, err := parseUserID(oid); err == nil {
				dateWhere += fmt.Sprintf(" AND sales_officer_id = $%d", n)
				args = append(args, id)
				n++
			}
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
				) / NULLIF(COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '1 month'), 0), 1) AS ret_1m,
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
		// Same role-aware scope as the matrix: officer sees own, head sees all or one.
		if user := core.UserFromCtx(r.Context()); user != nil && !isSalesHead(user) {
			q += fmt.Sprintf(" AND sales_officer_id = $%d", n)
			args = append(args, user.ID)
			n++
		} else if oid := qstr(r, "officer_id"); oid != "" {
			if id, err := parseUserID(oid); err == nil {
				q += fmt.Sprintf(" AND sales_officer_id = $%d", n)
				args = append(args, id)
				n++
			}
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
