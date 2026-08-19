package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

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

		cond := ""
		switch status {
		case "missed":
			cond = " AND hc.outcome = 'missed'"
		case "answered":
			cond = " AND hc.outcome = 'completed'"
		}
		// "Outstanding" is the actual worklist: missed, not returned, not already queued.
		if outstanding {
			cond += " AND hc.outcome = 'missed' AND NOT returned.ok AND NOT queued.ok"
		}

		q := fmt.Sprintf(`
			SELECT hc.id, hc.started_at, hc.customer_phone, hc.customer_name,
			       NULLIF(hc.customer_cif,'')                       AS customer_cif,
			       hc.outcome, COALESCE(hc.duration_sec,0)          AS duration_sec,
			       NULLIF(hc.agent_name,'')                         AS agent_name,
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
			   AND hc.started_at > NOW() - INTERVAL '%d days'%s
			 ORDER BY hc.started_at DESC
			 LIMIT 300`, ccInboundReturnWindow, days, cond)

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
		summary := map[string]any{"total": 0, "missed": 0, "answered": 0, "outstanding": 0, "answer_rate_pct": 0}
		if sr, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT COUNT(*)                                                  AS total,
			       COUNT(*) FILTER (WHERE hc.outcome = 'missed')             AS missed,
			       COUNT(*) FILTER (WHERE hc.outcome = 'completed')          AS answered,
			       COUNT(*) FILTER (WHERE hc.outcome = 'missed'
			                          AND NOT returned.ok AND NOT queued.ok) AS outstanding,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE hc.outcome = 'completed')
			             / NULLIF(COUNT(*),0), 1)                            AS answer_rate_pct
			  FROM helpdesk_calls hc
			  LEFT JOIN LATERAL (
			    SELECT EXISTS (
			      SELECT 1 FROM helpdesk_calls o
			       WHERE o.direction = 'outbound'
			         AND norm_phone(o.customer_phone) = norm_phone(hc.customer_phone)
			         AND norm_phone(hc.customer_phone) <> ''
			         AND o.started_at BETWEEN hc.started_at AND hc.started_at + INTERVAL '%s'
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
			   AND hc.started_at > NOW() - INTERVAL '%d days'`,
			ccInboundReturnWindow, days)); len(sr) > 0 {
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

		// One call-back per NUMBER, not per missed call — a customer who rang five times
		// in an afternoon is owed one return call, not five queue entries. DISTINCT ON
		// keeps the most recent call as the one referenced.
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			WITH candidates AS (
			  SELECT DISTINCT ON (norm_phone(hc.customer_phone))
			         hc.id, hc.customer_phone, hc.customer_name, hc.customer_cif, hc.started_at
			    FROM helpdesk_calls hc
			   WHERE hc.direction = 'inbound'
			     AND hc.outcome = 'missed'
			     AND COALESCE(hc.customer_phone,'') <> ''
			     AND hc.started_at > NOW() - INTERVAL '%d days'
			     -- not already returned
			     AND NOT EXISTS (
			       SELECT 1 FROM helpdesk_calls o
			        WHERE o.direction = 'outbound'
			          AND norm_phone(o.customer_phone) = norm_phone(hc.customer_phone)
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
			RETURNING id`, days, ccInboundReturnWindow))
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
