package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// The Sales Team Lead's dashboard.
//
// The page this replaces was a credit-origination dashboard: it read loan-kpis,
// monthly-disbursements and recent-applications out of loan_applications, a table with
// zero rows, and showed nothing about customer acquisition or the state of the team's
// book. A sales lead opens a dashboard to answer four questions:
//
//	1. Are we acquiring customers, and from where?
//	2. How is each officer performing?
//	3. What is in the pipeline, and is it moving?
//	4. Is the book healthy — arrears, maturities, customers nobody owns?
//
// Everything here is scoped to the whole team; per-officer views come from the same
// endpoints with ?officer_id=.

func RegisterSalesOverview(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales")
	r.With(access).Get("/overview/summary", overviewSummary(db))
	r.With(access).Get("/overview/acquisition", overviewAcquisition(db))
	r.With(access).Get("/overview/officers", overviewOfficers(db))
	r.With(access).Get("/overview/sources", overviewSources(db))
	r.With(access).Get("/overview/attention", overviewAttention(db))
}

// overviewSummary is the KPI strip. Counts come from the derived acquisition date, so
// they include the 2,507 customers whose date had to be recovered from their first
// account — the old account_created-only view undercounted 2024 by a factor of eleven.
func overviewSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH person_acq AS (
			    -- Person-level: a CIF is a card; roll every card up to its owner so we
			    -- count PEOPLE. A person is acquired on their FIRST card; unassigned only
			    -- if NO card has an officer.
			    SELECT person_key,
			           MIN(acquired_on)                       AS acquired_on,
			           bool_and(officer_id IS NULL)           AS unassigned,
			           bool_or(acquired_on_source = 'unknown') AS undated
			      FROM app.customer_acquisition
			     GROUP BY person_key
			), acq AS (
			    SELECT COUNT(*)                                                          AS customers,
			           COUNT(*) FILTER (WHERE acquired_on >= date_trunc('month', CURRENT_DATE))  AS mtd,
			           COUNT(*) FILTER (WHERE acquired_on >= date_trunc('year',  CURRENT_DATE))  AS ytd,
			           COUNT(*) FILTER (WHERE acquired_on >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
			                              AND acquired_on <  date_trunc('month', CURRENT_DATE))  AS prev_month,
			           COUNT(*) FILTER (WHERE unassigned)                               AS unassigned,
			           COUNT(*) FILTER (WHERE undated)                                  AS undated
			      FROM person_acq
			), leads AS (
			    SELECT COUNT(*) FILTER (WHERE lead_stage NOT IN ('converted','disqualified')) AS open_leads,
			           COUNT(*) FILTER (WHERE lead_stage = 'qualified')                       AS qualified,
			           COUNT(*) FILTER (WHERE lead_stage = 'converted'
			                              AND converted_at >= date_trunc('month', CURRENT_DATE)) AS converted_mtd,
			           COUNT(*) FILTER (WHERE next_action_at IS NOT NULL
			                              AND next_action_at <= NOW()
			                              AND lead_stage NOT IN ('converted','disqualified'))  AS overdue_actions,
			           COALESCE(SUM(estimated_value_kobo) FILTER (
			               WHERE lead_stage NOT IN ('converted','disqualified')), 0)           AS pipeline_value_kobo
			      FROM crm_contacts
			), apps AS (
			    SELECT COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)) AS submitted_mtd,
			           COUNT(*) FILTER (WHERE status = 'active')                               AS active,
			           COALESCE(SUM(amount_approved_kobo) FILTER (
			               WHERE booked_at >= date_trunc('month', CURRENT_DATE)), 0)           AS approved_mtd_kobo
			      FROM loan_applications
			), team AS (
			    SELECT COUNT(*) FILTER (WHERE u.is_active) AS officers
			      FROM o3c_users u
			     WHERE u.deleted_at IS NULL AND (`+salesOfficerPredicate+`)
			)
			SELECT acq.*, leads.*, apps.*, team.*,
			       CASE WHEN acq.prev_month > 0
			            THEN ROUND(((acq.mtd - acq.prev_month)::numeric / acq.prev_month) * 100, 1)
			            ELSE NULL END AS mom_change_pct
			  FROM acq, leads, apps, team`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, firstRowOrEmpty(rows), "pg")
	}
}

// overviewAcquisition is the monthly trend. acquired_on_source is broken out so the
// chart can show how much of each month rests on a derived date rather than presenting
// inference and fact as the same thing.
func overviewAcquisition(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		months := qint(r, "months", 24, 1, 60)
		rows, err := db.PGQuery(r.Context(), `
			WITH person_acq AS (
			    -- one row per PERSON at their FIRST card (with that card's date source)
			    SELECT DISTINCT ON (person_key) person_key, acquired_on, acquired_on_source
			      FROM app.customer_acquisition
			     WHERE acquired_on IS NOT NULL
			     ORDER BY person_key, acquired_on ASC
			)
			SELECT to_char(date_trunc('month', acquired_on), 'YYYY-MM')      AS month,
			       date_trunc('month', acquired_on)::date                    AS month_start,
			       COUNT(*)                                                  AS customers,
			       COUNT(*) FILTER (WHERE acquired_on_source = 'account_created') AS confirmed,
			       COUNT(*) FILTER (WHERE acquired_on_source <> 'account_created') AS derived
			  FROM person_acq
			 -- make_interval, not ($1 || ' months')::interval. String concatenation
			 -- makes Postgres infer $1 as text, and pgx refuses to encode an int
			 -- into a text parameter — the query fails before it ever runs, which
			 -- is what put "Internal server error" across the Sales Overview.
			 WHERE acquired_on >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1)
			   AND acquired_on <= CURRENT_DATE
			 GROUP BY 1, 2
			 ORDER BY 2`, months)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewOfficers is the team league table: book size, what each officer brought in,
// and how their pipeline is converting.
//
// Officers with an empty book still appear — a lead who has closed nothing is exactly
// who a team lead needs to see, and an INNER JOIN would hide them.
func overviewOfficers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id, u.full_name, u.role, u.is_active,
			       COALESCE(b.book_size, 0)            AS book_size,
			       COALESCE(b.acquired_mtd, 0)         AS acquired_mtd,
			       COALESCE(b.acquired_ytd, 0)         AS acquired_ytd,
			       COALESCE(b.in_arrears, 0)           AS customers_in_arrears,
			       COALESCE(l.open_leads, 0)           AS open_leads,
			       COALESCE(l.qualified, 0)            AS qualified_leads,
			       COALESCE(l.converted_mtd, 0)        AS converted_mtd,
			       COALESCE(l.overdue_actions, 0)      AS overdue_actions,
			       COALESCE(l.pipeline_value_kobo, 0)  AS pipeline_value_kobo,
			       CASE WHEN COALESCE(l.worked, 0) > 0
			            THEN ROUND((COALESCE(l.converted_all, 0)::numeric / l.worked) * 100, 1)
			            ELSE NULL END                  AS conversion_rate_pct
			  FROM o3c_users u
			  LEFT JOIN (
			      SELECT a.officer_id,
			             COUNT(*)                                                                AS book_size,
			             COUNT(*) FILTER (WHERE a.acquired_on >= date_trunc('month', CURRENT_DATE)) AS acquired_mtd,
			             COUNT(*) FILTER (WHERE a.acquired_on >= date_trunc('year',  CURRENT_DATE)) AS acquired_ytd,
			             COUNT(*) FILTER (WHERE k.max_dpd > 0)                                    AS in_arrears
			        FROM app.customer_acquisition a
			        LEFT JOIN (`+cardAggSQL+`) k ON k.cif = a.cif
			       WHERE a.officer_id IS NOT NULL
			       GROUP BY a.officer_id
			  ) b ON b.officer_id = u.id
			  LEFT JOIN (
			      SELECT lead_owner_id,
			             COUNT(*) FILTER (WHERE lead_stage NOT IN ('converted','disqualified')) AS open_leads,
			             COUNT(*) FILTER (WHERE lead_stage = 'qualified')                       AS qualified,
			             COUNT(*) FILTER (WHERE lead_stage = 'converted'
			                                AND converted_at >= date_trunc('month', CURRENT_DATE)) AS converted_mtd,
			             COUNT(*) FILTER (WHERE lead_stage = 'converted')                       AS converted_all,
			             COUNT(*) FILTER (WHERE lead_stage IN ('converted','disqualified'))     AS worked,
			             COUNT(*) FILTER (WHERE next_action_at IS NOT NULL AND next_action_at <= NOW()
			                                AND lead_stage NOT IN ('converted','disqualified'))  AS overdue_actions,
			             COALESCE(SUM(estimated_value_kobo) FILTER (
			                 WHERE lead_stage NOT IN ('converted','disqualified')), 0)           AS pipeline_value_kobo
			        FROM crm_contacts
			       WHERE lead_owner_id IS NOT NULL
			       GROUP BY lead_owner_id
			  ) l ON l.lead_owner_id = u.id
			 WHERE u.deleted_at IS NULL AND (`+salesOfficerPredicate+`)
			 ORDER BY u.is_active DESC, acquired_mtd DESC, book_size DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewSources credits origination. Lead sources cover what the workspace captured;
// they say nothing about the ~21,000 customers who predate lead tracking, so the
// response separates the two rather than implying the whole book came from a campaign.
func overviewSources(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(c.lead_source, ''), 'unrecorded') AS source,
			       COALESCE(s.label, 'Unrecorded')                   AS label,
			       COUNT(*)                                          AS leads,
			       COUNT(*) FILTER (WHERE c.lead_stage = 'converted') AS converted,
			       COUNT(*) FILTER (WHERE c.lead_stage = 'disqualified') AS disqualified,
			       CASE WHEN COUNT(*) FILTER (WHERE c.lead_stage IN ('converted','disqualified')) > 0
			            THEN ROUND((COUNT(*) FILTER (WHERE c.lead_stage = 'converted')::numeric
			                        / COUNT(*) FILTER (WHERE c.lead_stage IN ('converted','disqualified'))) * 100, 1)
			            ELSE NULL END                                 AS conversion_rate_pct
			  FROM crm_contacts c
			  LEFT JOIN crm_lead_sources s ON s.code = c.lead_source
			 GROUP BY 1, 2
			 ORDER BY leads DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewAttention is the team lead's action list: the things that are wrong right
// now. Each block is capped, because this is a worklist, not a report.
func overviewAttention(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{}

		if rows, err := db.PGQuery(r.Context(), `
			SELECT a.cif, a.full_name, a.acquired_on, a.state
			  FROM app.customer_acquisition a
			 WHERE a.officer_id IS NULL
			 ORDER BY a.acquired_on DESC NULLS LAST
			 LIMIT 25`); err == nil {
			out["unassigned_customers"] = rows
		}

		if rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.first_name, c.last_name, c.phone, c.lead_stage,
			       c.next_action_at, u.full_name AS owner_name
			  FROM crm_contacts c
			  LEFT JOIN o3c_users u ON u.id = c.lead_owner_id
			 WHERE c.next_action_at IS NOT NULL AND c.next_action_at <= NOW()
			   AND c.lead_stage NOT IN ('converted','disqualified')
			 ORDER BY c.next_action_at
			 LIMIT 25`); err == nil {
			out["overdue_actions"] = rows
		}

		// Leads with no owner cannot be worked by anyone; they are the first thing a
		// team lead should clear each morning.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.first_name, c.last_name, c.phone, c.lead_source, c.created_at
			  FROM crm_contacts c
			 WHERE c.lead_owner_id IS NULL
			   AND c.lead_stage NOT IN ('converted','disqualified')
			 ORDER BY c.created_at DESC
			 LIMIT 25`); err == nil {
			out["unowned_leads"] = rows
		}

		// Stalled: qualified but untouched for a fortnight.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.first_name, c.last_name, c.lead_stage,
			       c.last_activity_at, u.full_name AS owner_name
			  FROM crm_contacts c
			  LEFT JOIN o3c_users u ON u.id = c.lead_owner_id
			 WHERE c.lead_stage IN ('contacted','qualified')
			   AND COALESCE(c.last_activity_at, c.updated_at) < NOW() - INTERVAL '14 days'
			 ORDER BY COALESCE(c.last_activity_at, c.updated_at)
			 LIMIT 25`); err == nil {
			out["stalled_leads"] = rows
		}

		// How fresh is the customer book? A team lead reading acquisition numbers needs
		// to know whether the feed behind them is still running.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT status, started_at, finished_at,
			       customers_inserted, customers_updated, files_parsed, files_failed
			  FROM customer_feed_runs
			 ORDER BY started_at DESC LIMIT 1`); err == nil && len(rows) > 0 {
			out["feed"] = rows[0]
		} else {
			out["feed"] = nil
		}

		respond(w, out, "pg")
	}
}
