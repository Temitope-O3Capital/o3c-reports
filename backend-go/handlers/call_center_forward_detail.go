package handlers

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// One hand-off, in full, from the call centre's side of the glass.
//
// The tracker is a table of 326 rows and ends there: a head could see that a lead went
// to Sales and what bucket it currently sits in, and nothing else. "Why has this been
// With Sales for nine days" had no answer on the page — the calls that qualified it, who
// in Sales has it now, and whether anybody has touched it since are three different
// places, two of which a call-centre role cannot open at all.
//
// So this is the sales lead page's counterpart, built on the call centre's own
// permissions. It is deliberately READ-ONLY. A call-centre head has no business
// re-staging a lead that now belongs to a sales officer, and the one thing they would
// genuinely want — "nudge whoever has this" — is a notification, not an edit.
//
// SCOPE IS THE LIST'S SCOPE, not a new rule. An agent may open a hand-off for a lead
// they worked; a supervisor or head may open any. Re-deriving it here rather than
// sharing a helper would be the way the two quietly diverge, so the predicate is the
// same shape as ccListForwards' and the 404-not-403 is deliberate: an agent discovering
// which lead ids exist by their error codes is a worse outcome than a vague message.
// ─────────────────────────────────────────────────────────────────────────────

func ccForwardDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Not authenticated")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || id <= 0 {
			respondErr(w, 400, "Not a hand-off id")
			return
		}

		// Same scope rule as the tracker list: an agent is limited to the leads they
		// worked, everyone above sees the floor.
		scope, args := "", []any{id}
		if !ccIsSupervisor(user) {
			args = append(args, user.ID)
			scope = " AND l.assigned_to = $2"
		}

		head, err := db.PGQuery(ctx, `
			SELECT f.id, f.lead_id, f.contact_id,
			       COALESCE(f.forwarded_by_name, fb.full_name) AS forwarded_by_name,
			       f.customer_name, f.customer_phone, f.customer_cif, f.product_interest,
			       f.notes, f.forwarded_at, f.resolved_at, f.outcome,
			       `+forwardStatusExpr+` AS status,
			       c.lead_stage AS crm_stage, c.converted_cif, c.disqualify_reason,
			       COALESCE(ow.full_name, f.sales_owner_name) AS sales_owner_name,
			       ow.email AS sales_owner_email, ow.phone AS sales_owner_phone,
			       ow.office_location AS sales_owner_office,
			       la.full_name AS lead_agent_name,
			       cc.name AS campaign_name, mc.name AS marketing_campaign_name,
			       -- The lead book's own copy of where this customer is. Sales plans a
			       -- visit off these two, so a blank city is the single most common
			       -- reason a hand-off stalls, and the head who forwarded it is the one
			       -- person who can still ring and ask.
			       COALESCE(NULLIF(btrim(l.city), ''),  NULLIF(btrim(c.city), ''))  AS city,
			       COALESCE(NULLIF(btrim(l.state), ''), NULLIF(btrim(c.state), '')) AS state,
			       COALESCE(NULLIF(btrim(l.address), ''), NULLIF(btrim(c.address), '')) AS address,
			       l.employer, l.email AS lead_email, l.status AS lead_status,
			       c.estimated_value_kobo, c.last_activity_at, c.sales_entered_at,
			       -- Hours the hand-off has been open. Computed here so the page states a
			       -- number rather than asking the browser to subtract two timestamps and
			       -- disagree with the tracker's own ageing column.
			       ROUND(EXTRACT(EPOCH FROM (COALESCE(f.resolved_at, NOW()) - f.forwarded_at)) / 3600.0, 1) AS open_hours
			  FROM call_center_lead_forwards f
			  LEFT JOIN crm_contacts c           ON c.id  = f.contact_id
			  LEFT JOIN o3c_users fb             ON fb.id = f.forwarded_by
			  LEFT JOIN o3c_users ow             ON ow.id = c.sales_owner_id
			  LEFT JOIN call_center_leads l      ON l.id  = f.lead_id
			  LEFT JOIN o3c_users la             ON la.id = l.assigned_to
			  LEFT JOIN call_center_campaigns cc ON cc.id = f.cc_campaign_id
			  LEFT JOIN campaigns mc             ON mc.id = f.marketing_campaign_id
			 WHERE f.id = $1`+scope, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not read that hand-off", err)
			return
		}
		if len(head) == 0 {
			respondErr(w, 404, "That hand-off is not one you can open")
			return
		}
		f := head[0]
		leadID, contactID := toInt64(f["lead_id"]), toInt64(f["contact_id"])

		// The calls that led to the hand-off. This is the evidence a head actually wants:
		// the tracker says a lead was forwarded, these say what the customer agreed to.
		calls := []map[string]any{}
		if leadID != 0 {
			calls, err = db.PGQuery(ctx, `
				SELECT h.id, h.started_at, h.duration_sec, h.direction, h.outcome,
				       h.disposition, h.notes,
				       COALESCE(h.agent_name, u.full_name) AS agent_name,
				       h.recording_url IS NOT NULL AS has_recording
				  FROM helpdesk_calls h
				  LEFT JOIN o3c_users u ON u.id = h.agent_id
				 WHERE h.lead_id = $1 AND h.voided_at IS NULL
				 ORDER BY h.started_at DESC
				 LIMIT 50`, leadID)
			if err != nil {
				respondErrLog(w, 500, "Could not read the call history", err)
				return
			}
		}

		// What Sales has done since. app.activities, not crm_activities — the latter has
		// never held a row, which is the whole reason the sales dialogs were merged.
		// Without this the page could only ever say "With Sales" and never "and here is
		// the last thing anybody did about it".
		acts := []map[string]any{}
		if contactID != 0 {
			acts, err = db.PGQuery(ctx, `
				SELECT a.id, a.type AS kind, a.subject, a.body AS note,
				       a.outcome AS disposition, a.direction,
				       a.metadata->>'location' AS location,
				       COALESCE(a.occurred_at, a.created_at) AS occurred_at,
				       COALESCE(a.actor_name, u.full_name) AS officer_name
				  FROM app.activities a
				  LEFT JOIN o3c_users u ON u.id = a.actor_user_id
				 WHERE a.contact_id = $1
				 ORDER BY COALESCE(a.occurred_at, a.created_at) DESC
				 LIMIT 50`, contactID)
			if err != nil {
				respondErrLog(w, 500, "Could not read the sales activity", err)
				return
			}
		}

		// The stage history. Which stage it reached and when answers "is this moving or
		// has it been sitting at Documents Requested for a fortnight", which neither the
		// calls nor the activity list answers on its own.
		events := []map[string]any{}
		if contactID != 0 {
			events, err = db.PGQuery(ctx, `
				SELECT e.id, e.event, e.to_stage, e.note, e.created_at,
				       u.full_name AS by_name
				  FROM crm_lead_events e
				  LEFT JOIN o3c_users u ON u.id = e.created_by
				 WHERE e.contact_id = $1
				 ORDER BY e.created_at DESC
				 LIMIT 50`, contactID)
			if err != nil {
				respondErrLog(w, 500, "Could not read the stage history", err)
				return
			}
		}

		respond(w, map[string]any{
			"forward":    f,
			"calls":      calls,
			"activities": acts,
			"events":     events,
		}, "pg")
	}
}
