package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
	STAFF PERFORMANCE — how quickly work gets attended to, where that can honestly
	be measured.

	The module leads with COVERAGE rather than a league table, because the survey of
	the platform came back blunt. Of 28 tables carrying both an actor and a completion
	timestamp, exactly four have a single attributed row, and only two have enough to
	say anything about a person:

	    helpdesk_tickets   26,768 attributed resolutions   15 people
	    helpdesk_calls    201,276 calls with an agent        8 agents
	    recovery_payments     269 approvals                  1 person
	    recon_exceptions      266 resolutions                1 person

	Everything else — collections, credit, compliance, sales, internal control,
	manual postings — reads zero. Not "low": zero. Ranking anyone on those would be
	ranking the absence of a writer, so this module says so instead.

	TWO CLOCKS, SIDE BY SIDE, ON PURPOSE.

	Every duration is reported both ways. app.helpdesk_set_sla_from_type sets
	sla_due_at := created_at + INTERVAL 'N hours', so the live figures count nights,
	weekends and public holidays against whoever was on duty. Measured across the
	resolved tickets that is a ~4x overstatement of how long work took. Neither clock
	is quietly preferred here: both are shown, because switching the definition
	restates how people are judged and that is a decision for the business, not a
	default buried in a handler.

	WHAT IS DELIBERATELY ABSENT.

	There is no quality figure for the helpdesk, and that is a data fact rather than
	an oversight. csat_score is NULL on all 40,794 tickets and no code path writes it;
	first_response_at is NULL on all of them too, so time-to-first-response cannot be
	computed at all; status only ever holds 'open' or 'closed', so there is no reopen
	signal; escalated_at, is_flagged and merged_into_ticket_id are entirely unpopulated.
	The design agreed with the business pairs every speed figure with a quality one —
	that half cannot be honoured from what is recorded today, so this reports speed and
	names the gap rather than inventing a proxy.

	sla_breached IS NOT USED. It is a live "currently overdue" marker maintained by a
	worker, not a historical record: it is true on 6,157 rows of which 6,081 are still
	open, while 467 resolved tickets were in fact resolved after their due time and only
	76 of those carry the flag. It also disagrees with a direct count of open tickets
	past due (11,516). Breach is therefore computed from timestamps every time.
*/

// perfPeriod reads the standard date filter, defaulting to the last 30 days.
//
// Unlike fleetPeriod, which returns empty strings and lets the caller widen to all
// time, every query here is bounded: these tables hold 212,654 calls and 40,794
// tickets, and an unbounded default would make the page's first load its slowest.
func perfPeriod(r *http.Request) (string, string) {
	from, _ := validDate(r, "date_from")
	to, _ := validDate(r, "date_to")
	if from == "" || to == "" {
		// 90 days, not 30. Helpdesk resolutions are concentrated in 2026-06..2026-09
		// and stop in September, so a 30-day default returned an empty page while the
		// data sat one month out of reach — the window looking broken rather than the
		// feed looking stopped.
		now := time.Now()
		return now.AddDate(0, 0, -90).Format("2006-01-02"), now.Format("2006-01-02")
	}
	return from, to
}

func perfJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func RegisterPerformance(r chi.Router, db *core.DB) {
	// One gate. Every route here is a read, and the module deliberately exposes no
	// writes: the business asked for "visibility now, appraisal later", so there is
	// nothing here that records a judgement about a person.
	read := core.RequirePages("staff_performance")

	r.With(read).Get("/coverage", perfCoverage(db))
	r.With(read).Get("/helpdesk", perfHelpdesk(db))
	r.With(read).Get("/calls", perfCalls(db))
}

/* ── Coverage ───────────────────────────────────────────────────────────────── */

// perfCoverage is the survey: for each operational table that carries both an actor
// and a completion timestamp, how much of it is actually attributed to a person.
//
// It is the first thing the page shows because it is the finding. A performance
// module over data with no actor recorded would produce confident zeroes, which read
// as "nobody did anything" rather than "nothing was written down".
//
// The probe list is explicit rather than generated from the catalogue: each entry
// names the specific pair of columns that constitutes "done, by someone" for that
// table, and that pairing is a judgement no schema scan can make.
func perfCoverage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT * FROM (
			  SELECT 'Helpdesk' AS department, 'helpdesk_tickets' AS source,
			         'assigned_to + resolved_at' AS attributed_by,
			         COUNT(*) AS rows_total,
			         COUNT(resolved_at) AS completed,
			         COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND assigned_to IS NOT NULL) AS attributed,
			         COUNT(DISTINCT assigned_to) AS people
			    FROM app.helpdesk_tickets
			  UNION ALL
			  SELECT 'Contact Centre', 'helpdesk_calls', 'agent_id + started_at',
			         COUNT(*), COUNT(started_at),
			         COUNT(*) FILTER (WHERE started_at IS NOT NULL AND agent_id IS NOT NULL),
			         COUNT(DISTINCT agent_id)
			    FROM app.helpdesk_calls
			  UNION ALL
			  SELECT 'Recovery', 'recovery_payments', 'approved_by + approved_at',
			         COUNT(*), COUNT(approved_at),
			         COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND approved_by IS NOT NULL),
			         COUNT(DISTINCT approved_by)
			    FROM app.recovery_payments
			  UNION ALL
			  SELECT 'Settlement', 'recon_exceptions', 'resolved_by + resolved_at',
			         COUNT(*), COUNT(resolved_at),
			         COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_by IS NOT NULL),
			         COUNT(DISTINCT resolved_by)
			    FROM app.recon_exceptions
			  UNION ALL
			  SELECT 'Settlement', 'manual_postings', 'approved_by + approved_at',
			         COUNT(*), COUNT(approved_at),
			         COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND approved_by IS NOT NULL),
			         COUNT(DISTINCT approved_by)
			    FROM app.manual_postings
			  UNION ALL
			  SELECT 'Collections', 'collection_payments', 'approved_by + approved_at',
			         COUNT(*), COUNT(approved_at),
			         COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND approved_by IS NOT NULL),
			         COUNT(DISTINCT approved_by)
			    FROM app.collection_payments
			  UNION ALL
			  SELECT 'Collections', 'collections_watchlist', 'resolved_by + resolved_at',
			         COUNT(*), COUNT(resolved_at),
			         COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_by IS NOT NULL),
			         COUNT(DISTINCT resolved_by)
			    FROM app.collections_watchlist
			  UNION ALL
			  SELECT 'Credit', 'loan_applications', 'reviewed_by + reviewed_at',
			         COUNT(*), COUNT(reviewed_at),
			         COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL),
			         COUNT(DISTINCT reviewed_by)
			    FROM app.loan_applications
			  UNION ALL
			  SELECT 'Care', 'crm_requests', 'assigned_to + resolved_at',
			         COUNT(*), COUNT(resolved_at),
			         COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND assigned_to IS NOT NULL),
			         COUNT(DISTINCT assigned_to)
			    FROM app.crm_requests
			  UNION ALL
			  SELECT 'Sales', 'sales_visit_plans', 'officer_id + completed_at',
			         COUNT(*), COUNT(completed_at),
			         COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND officer_id IS NOT NULL),
			         COUNT(DISTINCT officer_id)
			    FROM app.sales_visit_plans
			  UNION ALL
			  SELECT 'Compliance', 'aml_flags', 'reviewed_by + reviewed_at',
			         COUNT(*), COUNT(reviewed_at),
			         COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL),
			         COUNT(DISTINCT reviewed_by)
			    FROM app.aml_flags
			  UNION ALL
			  SELECT 'Internal Control', 'audit_findings', 'assigned_to + closed_at',
			         COUNT(*), COUNT(closed_at),
			         COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND assigned_to IS NOT NULL),
			         COUNT(DISTINCT assigned_to)
			    FROM app.audit_findings
			) q
			ORDER BY attributed DESC, rows_total DESC`)
		if err != nil {
			respondErrLog(w, 500, "Could not read the attribution survey", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		perfJSON(w, 200, map[string]any{"data": rows})
	}
}

/* ── Helpdesk ───────────────────────────────────────────────────────────────── */

func perfHelpdesk(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		from, to := perfPeriod(r)
		out := map[string]any{"period": map[string]string{"from": from, "to": to}}

		// Both clocks computed once per ticket in the CTE, then aggregated. Computing
		// them inside the aggregates would call the window function several times per
		// row for the averages and the medians.
		//
		// allow_h is each ticket's OWN allowance (sla_due_at - created_at), not a
		// policy lookup, because that is the promise the ticket was actually given.
		// COMPLETION IS resolved_at OR, FAILING THAT, closed_at.
		//
		// Keying on resolved_at alone made this module blind. Zoho's resolvedTime stopped
		// arriving on 2026-09-11 while closedTime kept flowing — a ticket was closed today
		// at 16:56 and the newest resolved_at is a month old — so every figure here went
		// empty for the most recent month while work plainly continued. It also silently
		// dropped 9,599 tickets that are closed and carry no resolution time at all,
		// roughly a third of all finished work.
		//
		// Falling back to closed_at measures the same thing slightly later: closed is at
		// or after resolved, so a duration taken this way is an upper bound, never
		// flattering. Which basis each figure used is counted and reported beside it
		// rather than blended invisibly.
		const base = `
			WITH t AS (
			  SELECT t.assigned_to,
			         (t.resolved_at IS NOT NULL) AS on_resolution,
			         (EXTRACT(EPOCH FROM (COALESCE(t.resolved_at, t.closed_at) - t.created_at))
			            / 3600.0)::numeric AS cal_h,
			         app.business_hours_between(t.created_at,
			            COALESCE(t.resolved_at, t.closed_at))                               AS bus_h,
			         (EXTRACT(EPOCH FROM (t.sla_due_at  - t.created_at)) / 3600.0)::numeric AS allow_h
			    FROM app.helpdesk_tickets t
			   WHERE COALESCE(t.resolved_at, t.closed_at) IS NOT NULL
			     AND t.sla_due_at IS NOT NULL
			     AND t.deleted_at IS NULL
			     AND COALESCE(t.resolved_at, t.closed_at) >= $1::date
			     AND COALESCE(t.resolved_at, t.closed_at) <  ($2::date + 1)
			)`

		// Per person. Ordered by volume, not by speed: a league table sorted on speed
		// puts whoever handled three easy tickets at the top.
		if rows, err := db.PGQuery(ctx, base+`
			SELECT u.id AS user_id,
			       COALESCE(NULLIF(btrim(u.full_name), ''), 'User ' || u.id) AS name,
			       COALESCE(NULLIF(btrim(u.department), ''), '')             AS department,
			       COUNT(*)                                                 AS completed,
			       COUNT(*) FILTER (WHERE t.on_resolution)                  AS on_resolution,
			       COUNT(*) FILTER (WHERE NOT t.on_resolution)              AS on_closure,
			       -- Durations are computed PER BASIS and never blended. Blending them
			       -- once produced an average of 148 business hours over a population
			       -- whose resolution-timed half averages 2.9: the closure-timed tickets
			       -- carry a long administrative lag between the work finishing and
			       -- somebody closing the record, so one mean over both describes
			       -- neither. The UI shows the resolution figure where it exists and
			       -- falls back to the closure figure, labelled.
			       ROUND(AVG(t.cal_h) FILTER (WHERE t.on_resolution), 1)    AS avg_calendar_h,
			       ROUND(AVG(t.bus_h) FILTER (WHERE t.on_resolution), 1)    AS avg_business_h,
			       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY t.cal_h)
			              FILTER (WHERE t.on_resolution))::numeric, 1)      AS median_calendar_h,
			       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY t.bus_h)
			              FILTER (WHERE t.on_resolution))::numeric, 1)      AS median_business_h,
			       ROUND(AVG(t.bus_h) FILTER (WHERE NOT t.on_resolution), 1) AS closure_avg_business_h,
			       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY t.bus_h)
			              FILTER (WHERE NOT t.on_resolution))::numeric, 1)  AS closure_median_business_h,
			       COUNT(*) FILTER (WHERE t.cal_h > t.allow_h)              AS breach_calendar,
			       COUNT(*) FILTER (WHERE t.bus_h > t.allow_h)              AS breach_business
			  FROM t JOIN app.o3c_users u ON u.id = t.assigned_to
			 GROUP BY u.id, u.full_name, u.department
			 ORDER BY completed DESC`, from, to); err == nil {
			if rows == nil {
				rows = []core.Row{}
			}
			out["by_person"] = rows
		} else {
			respondErrLog(w, 500, "Could not read helpdesk performance", err)
			return
		}

		// The same figures for the department as a whole, including the tickets that
		// have no assignee — which no per-person row can show.
		if rows, _ := db.PGQuery(ctx, base+`
			SELECT COUNT(*)                                     AS completed,
			       COUNT(*) FILTER (WHERE on_resolution)        AS on_resolution,
			       COUNT(*) FILTER (WHERE NOT on_resolution)    AS on_closure,
			       COUNT(*) FILTER (WHERE assigned_to IS NULL)  AS unattributed,
			       ROUND(AVG(cal_h) FILTER (WHERE on_resolution), 1) AS avg_calendar_h,
			       ROUND(AVG(bus_h) FILTER (WHERE on_resolution), 1) AS avg_business_h,
			       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY cal_h)
			              FILTER (WHERE on_resolution))::numeric, 1) AS median_calendar_h,
			       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY bus_h)
			              FILTER (WHERE on_resolution))::numeric, 1) AS median_business_h,
			       ROUND(AVG(bus_h) FILTER (WHERE NOT on_resolution), 1) AS closure_avg_business_h,
			       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY bus_h)
			              FILTER (WHERE NOT on_resolution))::numeric, 1) AS closure_median_business_h,
			       COUNT(*) FILTER (WHERE cal_h > allow_h)      AS breach_calendar,
			       COUNT(*) FILTER (WHERE bus_h > allow_h)      AS breach_business
			  FROM t`, from, to); len(rows) > 0 {
			out["totals"] = rows[0]
		}

		// The backlog, which is a position rather than a period figure and so is NOT
		// filtered by the date range. Computed from timestamps; see the note on
		// sla_breached at the top of this file for why the flag is not trusted.
		//
		// "Still open" is closed_at IS NULL, NOT resolved_at IS NULL. Those are not the
		// same thing: 38,835 tickets are closed but only 29,240 carry a resolved_at, so
		// keying the backlog on resolved_at counted 9,595 already-finished tickets and
		// reported a backlog of 11,516 against a real one of 1,959.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*)                                                    AS open_tickets,
			       COUNT(*) FILTER (WHERE sla_due_at < now())                  AS open_overdue,
			       COUNT(*) FILTER (WHERE assigned_to IS NULL)                 AS open_unassigned,
			       COUNT(*) FILTER (WHERE sla_due_at < now()
			                          AND assigned_to IS NULL)                 AS open_overdue_unassigned,
			       MIN(created_at)::date                                       AS oldest_open
			  FROM app.helpdesk_tickets
			 WHERE closed_at IS NULL AND deleted_at IS NULL`); len(rows) > 0 {
			out["backlog"] = rows[0]
		}

		// Open and overdue by person, so a fast resolver sitting on an old queue is
		// visible rather than flattered by their resolution time alone.
		if rows, _ := db.PGQuery(ctx, `
			SELECT u.id AS user_id,
			       COALESCE(NULLIF(btrim(u.full_name), ''), 'User ' || u.id) AS name,
			       COUNT(*)                                   AS open_tickets,
			       COUNT(*) FILTER (WHERE t.sla_due_at < now()) AS open_overdue,
			       MIN(t.created_at)::date                    AS oldest_open
			  FROM app.helpdesk_tickets t
			  JOIN app.o3c_users u ON u.id = t.assigned_to
			 WHERE t.closed_at IS NULL AND t.deleted_at IS NULL
			 GROUP BY u.id, u.full_name
			 ORDER BY open_overdue DESC, open_tickets DESC`); rows != nil {
			out["open_by_person"] = rows
		}

		// What cannot be measured, carried in the payload so the page states it rather
		// than leaving a reader to assume the absence means "good".
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*)                        AS tickets,
			       COUNT(csat_score)               AS with_csat,
			       COUNT(first_response_at)        AS with_first_response,
			       COUNT(escalated_at)             AS with_escalation,
			       COUNT(*) FILTER (WHERE is_flagged) AS flagged,
			       COUNT(resolved_by)              AS with_resolver,
			       -- Closed but never marked resolved. These are now timed on closed_at
			       -- rather than dropped, which is why the figures above cover them --
			       -- but the basis is different and the count is reported so it shows.
			       COUNT(*) FILTER (WHERE closed_at IS NOT NULL
			                          AND resolved_at IS NULL) AS closed_without_resolution,
			       MAX(resolved_at)::date          AS last_resolution,
			       MAX(closed_at)::date            AS last_closure
			  FROM app.helpdesk_tickets`); len(rows) > 0 {
			out["unmeasurable"] = rows[0]
		}

		perfJSON(w, 200, out)
	}
}

/* ── Contact centre ─────────────────────────────────────────────────────────── */

// perfCalls reports call VOLUME and OUTCOME, and not talk time.
//
// duration_sec is populated on 34,838 of 212,654 calls and answered_at on 8,829, so an
// average handling time would be computed from a sixth of the data and presented as
// though it described all of it. The coverage counts are returned alongside instead,
// so the sparsity is visible rather than hidden inside an average.
//
// The operation is overwhelmingly outbound (207,180 against 5,474 inbound), so
// "connected" is the meaningful rate here rather than an answer rate.
func perfCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		from, to := perfPeriod(r)
		out := map[string]any{"period": map[string]string{"from": from, "to": to}}

		const base = `
			WITH c AS (
			  SELECT c.agent_id, c.agent_name, c.direction, c.outcome, c.duration_sec, c.wait_sec
			    FROM app.helpdesk_calls c
			   WHERE c.voided_at IS NULL
			     AND c.started_at >= $1::date
			     AND c.started_at <  ($2::date + 1)
			)`

		if rows, err := db.PGQuery(ctx, base+`
			SELECT c.agent_id AS user_id,
			       COALESCE(NULLIF(btrim(u.full_name), ''),
			                NULLIF(btrim(MAX(c.agent_name)), ''),
			                'Agent ' || c.agent_id)                       AS name,
			       COUNT(*)                                               AS calls,
			       COUNT(*) FILTER (WHERE c.direction = 'outbound')        AS outbound,
			       COUNT(*) FILTER (WHERE c.direction = 'inbound')         AS inbound,
			       COUNT(*) FILTER (WHERE c.outcome = 'completed')         AS completed,
			       COUNT(*) FILTER (WHERE c.outcome = 'missed')            AS missed,
			       COUNT(*) FILTER (WHERE c.outcome = 'voicemail')         AS voicemail,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE c.outcome = 'completed')
			                   / NULLIF(COUNT(*), 0), 1)                   AS connect_pct,
			       -- Talk time over the calls that actually carry a duration, with the
			       -- denominator returned beside it so it is never read as the whole.
			       COUNT(c.duration_sec)                                  AS with_duration,
			       ROUND(AVG(c.duration_sec) FILTER (WHERE c.duration_sec > 0), 0) AS avg_talk_sec
			  FROM c LEFT JOIN app.o3c_users u ON u.id = c.agent_id
			 WHERE c.agent_id IS NOT NULL
			 GROUP BY c.agent_id, u.full_name
			 ORDER BY calls DESC`, from, to); err == nil {
			if rows == nil {
				rows = []core.Row{}
			}
			out["by_agent"] = rows
		} else {
			respondErrLog(w, 500, "Could not read call performance", err)
			return
		}

		if rows, _ := db.PGQuery(ctx, base+`
			SELECT COUNT(*)                                          AS calls,
			       COUNT(*) FILTER (WHERE agent_id IS NULL)          AS unattributed,
			       COUNT(*) FILTER (WHERE outcome = 'completed')     AS completed,
			       COUNT(*) FILTER (WHERE outcome = 'missed')        AS missed,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'completed')
			                   / NULLIF(COUNT(*), 0), 1)             AS connect_pct,
			       COUNT(duration_sec)                               AS with_duration,
			       COUNT(wait_sec)                                   AS with_wait
			  FROM c`, from, to); len(rows) > 0 {
			out["totals"] = rows[0]
		}

		perfJSON(w, 200, out)
	}
}
