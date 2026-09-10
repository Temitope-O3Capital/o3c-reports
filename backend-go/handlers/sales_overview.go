package handlers

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
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
//
// ── The date window ──────────────────────────────────────────────────────────
// Acquisition, conversion and lead-intake are period questions, so the summary,
// acquisition trend, officer league table and lead sources all honour a ?from=&to=
// window (YYYY-MM-DD, both inclusive; empty = all-time). BOOK-STATE panels — the
// attention worklist and feed health — are deliberately NOT scoped: "who has no
// officer right now" does not change because you picked last quarter.

// newCustomerCutoff is go-live: customers acquired on or after this date are treated as
// genuinely NEW (and belong on the recently-acquired worklist). Everything before it is
// the legacy imported book. Kept as a single constant so the boundary is defined once.
const newCustomerCutoff = "2026-08-01"

func RegisterSalesOverview(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales")
	r.With(access).Get("/overview/summary", overviewSummary(db))
	r.With(access).Get("/overview/acquisition", overviewAcquisition(db))
	r.With(access).Get("/overview/officers", overviewOfficers(db))
	r.With(access).Get("/overview/sources", overviewSources(db))
	r.With(access).Get("/overview/attention", overviewAttention(db))
}

// salesWindow reads the ?from=&to= date window. Empty strings mean unbounded, and the
// SQL predicates below are written as ($n = '' OR col >= $n::date) so an empty bound is
// a no-op — Postgres short-circuits the OR before the ::date cast is ever evaluated.
func salesWindow(r *http.Request) (from, to string) {
	return qstr(r, "from"), qstr(r, "to")
}

// priorWindow returns the equal-length window immediately preceding [from,to], used for
// period-over-period deltas. Empty when the caller passed no window (nothing to compare).
func priorWindow(from, to string) (pf, pt string) {
	lf, e1 := time.Parse("2006-01-02", from)
	lt, e2 := time.Parse("2006-01-02", to)
	if e1 != nil || e2 != nil {
		return "", ""
	}
	span := lt.Sub(lf)
	prevEnd := lf.AddDate(0, 0, -1)
	return prevEnd.Add(-span).Format("2006-01-02"), prevEnd.Format("2006-01-02")
}

// overviewSummary is the KPI strip. Counts come from the derived acquisition date, so
// they include the customers whose date had to be recovered from their first account —
// the old account_created-only view undercounted 2024 by a factor of eleven.
//
// It returns two families of numbers: PERIOD metrics (acquired/leads/converted inside the
// window, each with an equal-length prior-period delta) that the date filter drives, and
// BOOK-STATE totals (whole book, unassigned, open leads, officers) that describe the team
// right now regardless of the window.
func overviewSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, to := salesWindow(r)
		pf, pt := priorWindow(from, to)
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
			           COUNT(*) FILTER (WHERE undated)                                  AS undated,
			           COUNT(*) FILTER (WHERE ($1 = '' OR acquired_on >= $1::date)
			                              AND ($2 = '' OR acquired_on <= $2::date))     AS period_customers,
			           COUNT(*) FILTER (WHERE $3 <> ''
			                              AND acquired_on >= $3::date
			                              AND acquired_on <= $4::date)                  AS prev_period_customers
			      FROM person_acq
			), leads AS (
			    SELECT COUNT(*)                                                              AS total_leads,
			           COUNT(*) FILTER (WHERE lead_stage NOT IN ('converted','disqualified')) AS open_leads,
			           COUNT(*) FILTER (WHERE lead_stage = 'qualified')                       AS qualified,
			           COUNT(*) FILTER (WHERE lead_stage = 'converted'
			                              AND converted_at >= date_trunc('month', CURRENT_DATE)) AS converted_mtd,
			           COUNT(*) FILTER (WHERE next_action_at IS NOT NULL
			                              AND next_action_at <= NOW()
			                              AND lead_stage NOT IN ('converted','disqualified'))  AS overdue_actions,
			           COUNT(*) FILTER (WHERE ($1 = '' OR created_at::date >= $1::date)
			                              AND ($2 = '' OR created_at::date <= $2::date))       AS period_leads,
			           COUNT(*) FILTER (WHERE $3 <> ''
			                              AND created_at::date >= $3::date
			                              AND created_at::date <= $4::date)                    AS prev_period_leads,
			           COUNT(*) FILTER (WHERE lead_stage = 'converted'
			                              AND ($1 = '' OR COALESCE(converted_at, updated_at)::date >= $1::date)
			                              AND ($2 = '' OR COALESCE(converted_at, updated_at)::date <= $2::date)) AS period_converted,
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
			            ELSE NULL END AS mom_change_pct,
			       CASE WHEN acq.prev_period_customers > 0
			            THEN ROUND(((acq.period_customers - acq.prev_period_customers)::numeric / acq.prev_period_customers) * 100, 1)
			            ELSE NULL END AS period_customers_change_pct,
			       CASE WHEN leads.prev_period_leads > 0
			            THEN ROUND(((leads.period_leads - leads.prev_period_leads)::numeric / leads.prev_period_leads) * 100, 1)
			            ELSE NULL END AS period_leads_change_pct,
			       CASE WHEN team.officers > 0
			            THEN ROUND(acq.customers::numeric / team.officers, 0)
			            ELSE NULL END AS avg_book_per_officer
			  FROM acq, leads, apps, team`, from, to, pf, pt)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, firstRowOrEmpty(rows), "pg")
	}
}

// overviewAcquisition is the monthly registration trend — one number per month, no
// confirmed/derived split. The registration date is simply acquired_on: the customer's
// own creation date, or failing that their first card/account opening (the view already
// COALESCEs the two). A record with no date at all — a vanishing fraction — has nothing
// to plot and is left out. With a window it bounds to [from,to]; without one it falls
// back to the last ?months= (default 24) so the trend always has shape.
func overviewAcquisition(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, to := salesWindow(r)
		months := qint(r, "months", 24, 1, 60)
		rows, err := db.PGQuery(r.Context(), `
			WITH person_acq AS (
			    -- one row per PERSON at their FIRST card/account
			    SELECT DISTINCT ON (person_key) person_key, acquired_on
			      FROM app.customer_acquisition
			     WHERE acquired_on IS NOT NULL
			     ORDER BY person_key, acquired_on ASC
			)
			SELECT to_char(date_trunc('month', acquired_on), 'YYYY-MM')      AS month,
			       date_trunc('month', acquired_on)::date                    AS month_start,
			       COUNT(*)                                                  AS customers
			  FROM person_acq
			 WHERE acquired_on <= CURRENT_DATE
			   -- windowed: honour from/to when supplied
			   AND ($1 = '' OR acquired_on >= date_trunc('month', $1::date))
			   AND ($2 = '' OR acquired_on <= $2::date)
			   -- unwindowed fallback: last N months. make_interval, not string concat —
			   -- ($n || ' months')::interval makes pgx refuse to encode an int into text.
			   AND ($1 <> '' OR acquired_on >= date_trunc('month', CURRENT_DATE) - make_interval(months => $3))
			 GROUP BY 1, 2
			 ORDER BY 2`, from, to, months)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewOfficers is the team league table: book size, what each officer brought in
// (in the selected window and lifetime), and how their pipeline is converting.
//
// Officers with an empty book still appear — a lead who has closed nothing is exactly
// who a team lead needs to see, and an INNER JOIN would hide them.
func overviewOfficers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, to := salesWindow(r)
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id, u.full_name, u.role, u.is_active,
			       COALESCE(NULLIF(TRIM(u.office_location),''), '') AS office_location,
			       COALESCE(b.book_size, 0)            AS book_size,
			       COALESCE(b.acquired_period, 0)      AS acquired_period,
			       COALESCE(b.acquired_mtd, 0)         AS acquired_mtd,
			       COALESCE(b.acquired_ytd, 0)         AS acquired_ytd,
			       COALESCE(b.in_arrears, 0)           AS customers_in_arrears,
			       COALESCE(l.open_leads, 0)           AS open_leads,
			       COALESCE(l.qualified, 0)            AS qualified_leads,
			       COALESCE(l.converted_period, 0)     AS converted_period,
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
			             COUNT(*) FILTER (WHERE ($1 = '' OR a.acquired_on >= $1::date)
			                                AND ($2 = '' OR a.acquired_on <= $2::date))          AS acquired_period,
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
			                                AND ($1 = '' OR COALESCE(converted_at, updated_at)::date >= $1::date)
			                                AND ($2 = '' OR COALESCE(converted_at, updated_at)::date <= $2::date)) AS converted_period,
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
			 ORDER BY u.is_active DESC, acquired_period DESC, book_size DESC`, from, to)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewSources credits origination — where GENUINE leads came from: campaigns, the
// call centre, and officers profiling a walk-in. It deliberately EXCLUDES the one-time
// bulk customer import (source='zoho_desk'): those ~16,800 rows are the pre-existing book
// carried over from the retired card system, not campaign-sourced leads, and counting
// them as an "Unrecorded" source drowned every real channel and implied the whole book
// came from a campaign it never touched.
func overviewSources(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, to := salesWindow(r)
		rows, err := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(c.lead_source, ''), 'unrecorded') AS source,
			       COALESCE(s.label, INITCAP(REPLACE(NULLIF(c.lead_source,''),'_',' ')), 'Unrecorded') AS label,
			       COUNT(*)                                          AS leads,
			       COUNT(*) FILTER (WHERE c.lead_stage = 'converted') AS converted,
			       COUNT(*) FILTER (WHERE c.lead_stage = 'disqualified') AS disqualified,
			       CASE WHEN COUNT(*) FILTER (WHERE c.lead_stage IN ('converted','disqualified')) > 0
			            THEN ROUND((COUNT(*) FILTER (WHERE c.lead_stage = 'converted')::numeric
			                        / COUNT(*) FILTER (WHERE c.lead_stage IN ('converted','disqualified'))) * 100, 1)
			            ELSE NULL END                                 AS conversion_rate_pct
			  FROM crm_contacts c
			  LEFT JOIN crm_lead_sources s ON s.code = c.lead_source
			 WHERE c.source IS DISTINCT FROM 'zoho_desk'
			   AND ($1 = '' OR c.created_at::date >= $1::date)
			   AND ($2 = '' OR c.created_at::date <= $2::date)
			 GROUP BY 1, 2
			 ORDER BY leads DESC`, from, to)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// overviewAttention is the team lead's action list: the things that are wrong right
// now. It is book-state, not period — deliberately unaffected by the date filter. Each
// block is a capped preview (LIMIT 25); the count shown on the page is the WORKLIST
// TOTAL carried in the sibling *_total, because rendering len(preview) is how "15,303
// unowned leads" once rendered as "25".
func overviewAttention(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{}

		scalar := func(sql string) int64 {
			var nrows int64
			_ = db.PG.QueryRowContext(r.Context(), sql).Scan(&nrows)
			return nrows
		}

		// "Recently acquired" means NEW customers only — those acquired on or after the
		// go-live cut-off. Before this date is the legacy imported book (a separate,
		// much larger assignment problem surfaced by the banner), and mixing the two
		// buried the handful of genuinely new customers under 19,000 old ones.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT a.cif, a.full_name, a.acquired_on, a.state, a.phone, a.account_count,
			       COALESCE(k.active_cards,0) > 0 AS has_cards,
			       COALESCE(l.active_loans,0) > 0 AS has_loans,
			       COALESCE(f.active_fds,0)   > 0 AS has_fds
			  FROM app.customer_acquisition a
			  LEFT JOIN (`+cardAggSQL+`) k ON k.cif = a.cif
			  LEFT JOIN (`+loanAggSQL+`) l ON l.cif = a.cif
			  LEFT JOIN (`+fdAggSQL+`)   f ON f.cif = a.cif
			 WHERE a.officer_id IS NULL
			   AND a.acquired_on >= '`+newCustomerCutoff+`'::date
			 ORDER BY a.acquired_on DESC NULLS LAST
			 LIMIT 50`); err == nil {
			out["unassigned_customers"] = rows
		}
		out["unassigned_customers_total"] = scalar(
			`SELECT COUNT(*) FROM app.customer_acquisition
			  WHERE officer_id IS NULL AND acquired_on >= '` + newCustomerCutoff + `'::date`)
		// The whole-book legacy backlog stays available for the banner/StatTile.
		out["unassigned_book_total"] = scalar(
			`SELECT COUNT(*) FROM app.customer_acquisition WHERE officer_id IS NULL`)

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
		out["overdue_actions_total"] = scalar(
			`SELECT COUNT(*) FROM crm_contacts
			  WHERE next_action_at IS NOT NULL AND next_action_at <= NOW()
			    AND lead_stage NOT IN ('converted','disqualified')`)

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
		out["unowned_leads_total"] = scalar(
			`SELECT COUNT(*) FROM crm_contacts
			  WHERE lead_owner_id IS NULL AND lead_stage NOT IN ('converted','disqualified')`)

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
		out["stalled_leads_total"] = scalar(
			`SELECT COUNT(*) FROM crm_contacts
			  WHERE lead_stage IN ('contacted','qualified')
			    AND COALESCE(last_activity_at, updated_at) < NOW() - INTERVAL '14 days'`)

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
