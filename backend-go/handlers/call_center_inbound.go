package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ymd validates and normalises a YYYY-MM-DD query param. Parsing then re-formatting
// makes it safe to inline into SQL (no injection) — an invalid value yields ok=false.
func ymd(s string) (string, bool) {
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.Format("2006-01-02"), true
	}
	return "", false
}

// Inbound call handling.
//
// Inbound was the module's blind spot. Of 3,226 inbound calls, 1,718 (53%) went
// unanswered, and not one inbound call had ever been linked to a ticket or a follow-up
// of any kind. Over the last 30 days 613 were missed and only 185 got a return call
// within 48 hours — 428 customers rang O3 Capital, nobody picked up, and nothing in the
// workspace recorded that we owed them a call.
//
// The model here deliberately adds no new state to track "handled":
//   * returned — an outbound call to the same number after the missed one. Derived from
//     the call ledger, so a call an agent makes through the carrier counts automatically
//     and nobody has to remember to tick anything.
//   * queued   — a support call-back sitting in call_center_contacts for that call
//     (source='missed_inbound', ref=call id), which the existing queue already serves.
//
// A missed inbound call becomes an ordinary High-priority support contact in the same
// outbound queue agents already work, rather than a second worklist to check.

// ccInboundReturnWindow is how long after a missed call an outbound call to the same
// number still counts as returning it. Two working days.
const ccInboundReturnWindow = "48 hours"

func ccInboundList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		days := qint(r, "days", 7, 1, 90)
		status := qstr(r, "status") // missed | answered | (all)
		outstanding := qstr(r, "outstanding") == "1"

		// Date window: an explicit from/to (YYYY-MM-DD) range wins; otherwise the
		// last-N-days fallback. Prebuilt as a concrete SQL fragment (dates validated by
		// ymd) so it can be concatenated into both the list and summary queries.
		windowClause := fmt.Sprintf("hc.started_at > NOW() - INTERVAL '%d days'", days)
		if f, ok := ymd(qstr(r, "from")); ok {
			if t, ok2 := ymd(qstr(r, "to")); ok2 {
				windowClause = fmt.Sprintf("hc.started_at >= '%s'::date AND hc.started_at < ('%s'::date + INTERVAL '1 day')", f, t)
			}
		}

		// A 'completed' call under callConnectMinSec with no recording never reached a
		// conversation (a 1-second dial blip, not a pickup). Fold that into the outcome
		// the SAME way the rest of the app does (callConnectedExpr / callUnansweredExpr),
		// so the Inbound page's "Answered" means an actual conversation — not a number
		// that rang and dropped. Over half of raw inbound 'completed' rows are these.
		connected := callConnectedExpr("hc.")
		unans := callUnansweredExpr("hc.")

		cond := ""
		switch status {
		case "missed":
			cond = " AND " + unans
		case "answered":
			cond = " AND " + connected
		}
		// "Outstanding" is the actual worklist: didn't connect, not returned, not queued.
		if outstanding {
			cond += " AND " + unans + " AND NOT returned.ok AND NOT queued.ok"
		}

		// Present a non-connect as 'missed' (the frontend keys "Answered" off
		// outcome='completed'), so a 1-second blip reads as owed-a-call, not answered.
		outcomeCol := "CASE WHEN " + connected + " THEN hc.outcome ELSE 'missed' END"

		q := fmt.Sprintf(`
			SELECT hc.id, hc.started_at, hc.customer_phone, hc.customer_name,
			       NULLIF(hc.customer_cif,'')                       AS customer_cif,
			       `+outcomeCol+` AS outcome, COALESCE(hc.duration_sec,0) AS duration_sec,
			       NULLIF(hc.agent_name,'')                         AS agent_name,
			       -- Provider-neutral telephony facts (Zoho today, our own telephony later)
			       hc.wait_sec                                      AS wait_sec,
			       hc.answered_at                                   AS answered_at,
			       hc.abandoned                                     AS abandoned,
			       NULLIF(hc.disconnected_by,'')                    AS disconnected_by,
			       NULLIF(hc.queue_name,'')                         AS queue_name,
			       (SELECT COUNT(*) FROM call_ring_legs l WHERE l.call_id = hc.id) AS ring_legs,
			       returned.ok                                      AS returned,
			       queued.ok                                        AS queued,
			       cust.full_name                                   AS matched_customer
			  FROM helpdesk_calls hc
			  LEFT JOIN LATERAL (
			    SELECT EXISTS (
			      SELECT 1 FROM helpdesk_calls o
			       WHERE o.direction = 'outbound'
			         AND norm_phone(o.customer_phone) = norm_phone(hc.customer_phone)
			         AND norm_phone(hc.customer_phone) <> ''
			         AND o.merged_into_call_id IS NULL AND o.voided_at IS NULL
			         AND o.started_at BETWEEN hc.started_at AND hc.started_at + INTERVAL '%s'
			    ) AS ok
			  ) returned ON TRUE
			  LEFT JOIN LATERAL (
			    SELECT EXISTS (
			      SELECT 1 FROM call_center_contacts cc
			       WHERE cc.source = 'missed_inbound'
			         AND cc.ref = hc.id::text
			         AND cc.status = 'pending'
			    ) AS ok
			  ) queued ON TRUE
			  LEFT JOIN LATERAL (
			    SELECT c.full_name FROM customers c
			     WHERE norm_phone(hc.customer_phone) <> ''
			       AND norm_phone(c.phone) = norm_phone(hc.customer_phone)
			     LIMIT 1
			  ) cust ON TRUE
			 WHERE hc.direction = 'inbound'
			   AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL
			   AND `+windowClause+`%s
			 ORDER BY hc.started_at DESC
			 LIMIT 2000`, ccInboundReturnWindow, cond)

		rows, err := db.PGQuery(r.Context(), q)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// Summary is computed over the same window but WITHOUT the status/outstanding
		// filter, so the header keeps reporting the full picture while a filter is on.
		summary := map[string]any{"total": 0, "missed": 0, "answered": 0, "outstanding": 0, "answer_rate_pct": 0, "abandoned": 0, "avg_wait_sec": 0}
		if sr, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT COUNT(*)                                                  AS total,
			       COUNT(*) FILTER (WHERE %[2]s)                             AS missed,
			       COUNT(*) FILTER (WHERE %[3]s)                             AS answered,
			       COUNT(*) FILTER (WHERE %[2]s
			                          AND NOT returned.ok AND NOT queued.ok) AS outstanding,
			       -- Caller hung up before anyone answered — the queue's true failure rate,
			       -- distinct from "missed" (which folds in system/no-answer). Fed by the
			       -- provider-neutral abandoned flag.
			       COUNT(*) FILTER (WHERE hc.abandoned)                      AS abandoned,
			       ROUND(AVG(hc.wait_sec) FILTER (WHERE hc.wait_sec IS NOT NULL))::int AS avg_wait_sec,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE %[3]s)
			             / NULLIF(COUNT(*),0), 1)                            AS answer_rate_pct
			  FROM helpdesk_calls hc
			  LEFT JOIN LATERAL (
			    SELECT EXISTS (
			      SELECT 1 FROM helpdesk_calls o
			       WHERE o.direction = 'outbound'
			         AND norm_phone(o.customer_phone) = norm_phone(hc.customer_phone)
			         AND norm_phone(hc.customer_phone) <> ''
			         AND o.merged_into_call_id IS NULL AND o.voided_at IS NULL
			         AND o.started_at BETWEEN hc.started_at AND hc.started_at + INTERVAL '%[1]s'
			    ) AS ok
			  ) returned ON TRUE
			  LEFT JOIN LATERAL (
			    SELECT EXISTS (
			      SELECT 1 FROM call_center_contacts cc
			       WHERE cc.source = 'missed_inbound' AND cc.ref = hc.id::text
			         AND cc.status = 'pending'
			    ) AS ok
			  ) queued ON TRUE
			 WHERE hc.direction = 'inbound'
			   AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL
			   AND `+windowClause+``,
			ccInboundReturnWindow, unans, connected)); len(sr) > 0 {
			summary = sr[0]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "summary": summary}) //nolint:errcheck
	}
}

// ccQueueMissedCallbacks turns outstanding missed inbound calls into support call-backs
// in the outbound queue. Button-triggered rather than automatic on import, matching the
// module's other feeders (sync-from-crm, sync-collections) — a supervisor decides how
// far back to sweep instead of the importer silently manufacturing worklist.
func ccQueueMissedCallbacks(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		days := qint(r, "days", 7, 1, 90)
		// Match the visible window: an explicit from/to range wins over the days fallback,
		// so "Queue N call-backs" sweeps exactly what the page is showing.
		windowClause := fmt.Sprintf("hc.started_at > NOW() - INTERVAL '%d days'", days)
		if f, ok := ymd(qstr(r, "from")); ok {
			if t, ok2 := ymd(qstr(r, "to")); ok2 {
				windowClause = fmt.Sprintf("hc.started_at >= '%s'::date AND hc.started_at < ('%s'::date + INTERVAL '1 day')", f, t)
			}
		}

		// One call-back per NUMBER, not per missed call — a customer who rang five times
		// in an afternoon is owed one return call, not five queue entries. DISTINCT ON
		// keeps the most recent call as the one referenced.
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			WITH candidates AS (
			  SELECT DISTINCT ON (norm_phone(hc.customer_phone))
			         hc.id, hc.customer_phone, hc.customer_name, hc.customer_cif, hc.started_at
			    FROM helpdesk_calls hc
			   WHERE hc.direction = 'inbound'
			     AND `+callUnansweredExpr("hc.")+`
			     AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL
			     AND COALESCE(hc.customer_phone,'') <> ''
			     AND `+windowClause+`
			     -- not already returned
			     AND NOT EXISTS (
			       SELECT 1 FROM helpdesk_calls o
			        WHERE o.direction = 'outbound'
			          AND norm_phone(o.customer_phone) = norm_phone(hc.customer_phone)
			          AND o.merged_into_call_id IS NULL AND o.voided_at IS NULL
			          AND o.started_at BETWEEN hc.started_at AND hc.started_at + INTERVAL '%s')
			     -- not suppressed
			     AND NOT EXISTS (
			       SELECT 1 FROM dnc_list d WHERE norm_phone(d.phone) = norm_phone(hc.customer_phone))
			   ORDER BY norm_phone(hc.customer_phone), hc.started_at DESC
			)
			INSERT INTO call_center_contacts
			    (customer_name, phone, cif, product_name, priority,
			     is_existing_customer, status, purpose, source, ref)
			SELECT COALESCE(NULLIF(c.customer_name,''), 'Unknown caller'),
			       c.customer_phone,
			       NULLIF(c.customer_cif,''),
			       'Missed Call — Return',
			       'High',
			       NULLIF(c.customer_cif,'') IS NOT NULL,
			       'pending', 'support', 'missed_inbound', c.id::text
			  FROM candidates c
			 WHERE NOT EXISTS (
			   -- don't stack a second open call-back on a number already queued
			   SELECT 1 FROM call_center_contacts cc
			    WHERE norm_phone(cc.phone) = norm_phone(c.customer_phone)
			      AND cc.purpose = 'support'
			      AND cc.status = 'pending')
			RETURNING id`, ccInboundReturnWindow))
		if err != nil {
			respondErr(w, 500, "Could not queue call-backs: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"queued": len(rows)}) //nolint:errcheck
	}
}

// ccInboundToTicket raises a support ticket from an inbound call, so a caller with a
// real issue leaves a trail beyond the call log. Inbound calls previously had no path
// to a ticket at all — ticket_id was NULL on all 3,226 of them.
func ccInboundToTicket(db *core.DB) http.HandlerFunc {
	type body struct {
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		callID := chi.URLParam(r, "id")
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		if b.Subject == "" {
			b.Subject = "Inbound call follow-up"
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		call, _ := db.PGQuery(ctx,
			`SELECT COALESCE(customer_name,'') nm, COALESCE(customer_phone,'') ph,
			        COALESCE(customer_cif,'') cif, started_at
			   FROM helpdesk_calls WHERE id=$1 AND direction='inbound'`, callID)
		if len(call) == 0 {
			respondErr(w, 404, "Inbound call not found")
			return
		}
		c := call[0]

		var agentID *int64
		if user != nil {
			agentID = &user.ID
		}

		rows, err := db.PGQuery(ctx,
			`INSERT INTO helpdesk_tickets
			   (subject, description, channel, status, priority,
			    customer_name, customer_phone, customer_cif, assigned_to, linked_call_id)
			 VALUES ($1,$2,'call','open','normal',$3,$4,NULLIF($5,''),$6,$7)
			 RETURNING id`,
			b.Subject, b.Body, str(c["nm"]), str(c["ph"]), str(c["cif"]), agentID, callID)
		if err != nil {
			respondErr(w, 500, "Could not create ticket: "+err.Error())
			return
		}

		// Point the call at its ticket so the two stay joined from either side.
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE helpdesk_calls SET ticket_id=$1 WHERE id=$2`, rows[0]["id"], callID)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"ticket_id": rows[0]["id"]}) //nolint:errcheck
	}
}

// ccInboundRingLegs returns the per-agent ring sequence of one call: which agents it rang,
// in what order, how long each rang, and who let it pass on to the next — the "who dropped
// it before it moved on" view. Provider-neutral: reads call_ring_legs, which any telephony
// producer fills, so this works identically once O3 moves off Zoho.
func ccInboundRingLegs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		callID := chi.URLParam(r, "id")
		legs, err := db.PGQuery(r.Context(), `
			SELECT l.position, l.agent_name, l.rang_at, l.ring_sec, l.outcome,
			       u.full_name AS agent_full_name
			  FROM call_ring_legs l
			  LEFT JOIN o3c_users u ON u.id = l.agent_id
			 WHERE l.call_id = $1
			 ORDER BY l.position ASC`, callID)
		if err != nil {
			respondErrLog(w, 500, "Could not load ring legs", err)
			return
		}
		if legs == nil {
			legs = []core.Row{}
		}
		// Queue + strategy are the same across a call's legs; take them from the first.
		queue, strategy := "", ""
		if len(legs) > 0 {
			if hdr, _ := db.PGQuery(r.Context(),
				`SELECT queue_name, strategy FROM call_ring_legs WHERE call_id = $1 LIMIT 1`, callID); len(hdr) > 0 {
				queue = str(hdr[0]["queue_name"])
				strategy = str(hdr[0]["strategy"])
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"legs": legs, "queue_name": queue, "strategy": strategy,
		})
	}
}
