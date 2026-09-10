package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Call Centre → Sales hand-off, with tracking.
//
// Before this, a call-centre lead only ever leaked into Sales as a silent
// lead_stage nudge — nobody owned it, no deal was created, and the agent who
// worked it could not see whether it ever converted. This adds an explicit
// "Forward to Sales" action and a durable hand-off record so BOTH the agent who
// forwarded a lead and their supervisor can follow it to its outcome. The live
// outcome (with sales / converted / rejected) is read from crm_contacts at query
// time, so the tracker is always accurate without coupling every sales action.
// ─────────────────────────────────────────────────────────────────────────────

func ccIsSupervisor(u *core.Claims) bool {
	return u != nil && (u.Role == "call_center_head" || core.IsManagement(u.Role))
}

// forwardLeadToSales hands a worked call-centre lead to the Sales pipeline and
// records the hand-off. Agents may forward leads assigned to them; supervisors /
// heads / management may forward any lead and optionally pre-assign a sales owner.
func forwardLeadToSales(db *core.DB) http.HandlerFunc {
	type body struct {
		ProductInterest string `json:"product_interest"`
		Notes           string `json:"notes"`
		SalesOwnerID    *int64 `json:"sales_owner_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Not authenticated")
			return
		}
		leadID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || leadID == 0 {
			respondErr(w, 400, "Invalid lead id")
			return
		}
		var b body
		_ = json.NewDecoder(r.Body).Decode(&b)

		rows, err := db.PGQuery(ctx, `
			SELECT id, customer_name, customer_phone, customer_cif, campaign_id,
			       marketing_campaign_id, contact_id, assigned_to, status
			  FROM call_center_leads WHERE id = $1`, leadID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Lead not found")
			return
		}
		lead := rows[0]

		// Only supervisors / heads / management forward leads to Sales. Agents surface
		// interest by dispositioning a lead "Interested"; the supervisor reviews the
		// interested pile and forwards. (Both can still TRACK the outcome.)
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only a call-centre supervisor can forward leads to Sales")
			return
		}

		// Stage gate: only a lead an agent has actually warmed up belongs in Sales.
		// Forwarding a 'pending' / 'no_answer' / 'dnc' lead would flood Sales with cold
		// rows nobody qualified. 'interested' is the warm signal; 'callback' is a live
		// conversation mid-flight that's fair to hand over too. Everything else is refused.
		leadStatus := strings.ToLower(strings.TrimSpace(str(lead["status"])))
		if leadStatus != "interested" && leadStatus != "callback" {
			respondErr(w, 422, "Only a lead marked Interested can be forwarded to Sales")
			return
		}

		// Ensure the lead has a CRM contact (create/link if it never earned one).
		contactID := toInt64(lead["contact_id"])
		if contactID == 0 {
			crmLinkLeadToContact(ctx, db, leadID)
			if rr, _ := db.PGQuery(ctx, `SELECT contact_id FROM call_center_leads WHERE id=$1`, leadID); len(rr) > 0 {
				contactID = toInt64(rr[0]["contact_id"])
			}
		}
		if contactID == 0 {
			respondErr(w, 500, "Could not create a sales lead for this contact (no phone to match on)")
			return
		}

		var mktCampaign any
		if v := toInt64(lead["marketing_campaign_id"]); v != 0 {
			mktCampaign = v
		}

		// Move the CRM contact into the sales pipeline (forward-only), stamp source
		// + lineage + the product the agent surfaced.
		if _, err := db.PGExec(ctx, `
			UPDATE crm_contacts
			   SET lead_stage        = CASE WHEN lead_stage IN ('new','contacted') THEN 'qualified' ELSE lead_stage END,
			       lead_source       = COALESCE(NULLIF(lead_source,''), 'call_centre'),
			       source            = COALESCE(NULLIF(source,''), 'call_centre'),
			       product_interest  = COALESCE(NULLIF($2,''), product_interest),
			       source_campaign_id = COALESCE(source_campaign_id, $3),
			       source_cc_lead_id  = COALESCE(source_cc_lead_id, $4),
			       last_activity_at  = NOW(), updated_at = NOW()
			 WHERE id = $1`, contactID, strings.TrimSpace(b.ProductInterest), mktCampaign, leadID); err != nil {
			respondErr(w, 500, "Could not update the sales lead")
			return
		}

		// Optional supervisor pre-assignment of a sales owner.
		status := "forwarded"
		var salesOwner any
		if b.SalesOwnerID != nil && *b.SalesOwnerID > 0 {
			status = "assigned"
			salesOwner = *b.SalesOwnerID
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE crm_contacts SET lead_owner_id = $2, account_manager_id = COALESCE(account_manager_id,$2), updated_at=NOW() WHERE id=$1`,
				contactID, *b.SalesOwnerID)
		}

		var cif any
		if v := strings.TrimSpace(str(lead["customer_cif"])); v != "" {
			cif = v
		}

		// Upsert the hand-off. The partial unique index (uq_cc_forward_open) means
		// re-forwarding a lead whose hand-off is still open updates the pitch rather
		// than creating a duplicate; a closed hand-off lets it be forwarded afresh.
		ins, err := db.PGQuery(ctx, `
			INSERT INTO call_center_lead_forwards
			  (lead_id, contact_id, forwarded_by, forwarded_by_name, customer_name, customer_phone,
			   customer_cif, cc_campaign_id, marketing_campaign_id, product_interest, notes, status,
			   sales_owner_id, sales_owner_name)
			VALUES ($1,$2,$3,(SELECT full_name FROM o3c_users WHERE id=$3),$4,$5,$6,$7,$8,$9,$10,$11,$12,
			        (SELECT full_name FROM o3c_users WHERE id=$12))
			ON CONFLICT (lead_id) WHERE status IN ('forwarded','accepted','assigned')
			DO UPDATE SET product_interest = EXCLUDED.product_interest,
			              notes            = EXCLUDED.notes,
			              status           = EXCLUDED.status,
			              sales_owner_id   = EXCLUDED.sales_owner_id,
			              sales_owner_name = EXCLUDED.sales_owner_name,
			              updated_at       = NOW()
			RETURNING id`,
			leadID, contactID, user.ID, str(lead["customer_name"]), str(lead["customer_phone"]),
			cif, toInt64(lead["campaign_id"]), mktCampaign, strings.TrimSpace(b.ProductInterest),
			strings.TrimSpace(b.Notes), status, salesOwner)
		if err != nil {
			respondErr(w, 500, "Could not record the hand-off")
			return
		}

		// Stamp the lead so the Leads board shows it as forwarded, and keep a durable
		// disposition on the lead itself.
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE call_center_leads
			    SET forwarded_at = NOW(),
			        last_disposition = 'Forwarded to Sales',
			        updated_at = NOW()
			  WHERE id = $1`, leadID)

		// Audit the move on the CRM timeline.
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO crm_lead_events (contact_id, event, to_stage, note, created_by)
			 VALUES ($1,'forwarded_to_sales','qualified',$2,$3)`,
			contactID, nullIfEmpty(strings.TrimSpace(b.Notes)), user.ID)

		respond(w, map[string]any{
			"ok": true, "forward_id": toInt64(ins[0]["id"]), "contact_id": contactID, "status": status,
		}, "pg")
	}
}

// ccListForwards returns the hand-off tracker. An agent sees only their own
// forwards; a supervisor / head / management sees the whole floor (optionally
// filtered to one agent). The current outcome is read LIVE from crm_contacts.
func ccListForwards(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Not authenticated")
			return
		}
		sup := ccIsSupervisor(user)
		where := []string{"1=1"}
		args := []any{}
		if !sup {
			// An agent sees the leads THEY worked that were forwarded — whoever forwarded.
			args = append(args, user.ID)
			where = append(where, "l.assigned_to = $"+strconv.Itoa(len(args)))
		} else if r.URL.Query().Get("scope") == "mine" {
			// A supervisor viewing "my forwards" — the ones they personally forwarded.
			args = append(args, user.ID)
			where = append(where, "f.forwarded_by = $"+strconv.Itoa(len(args)))
		} else if a := r.URL.Query().Get("agent"); a != "" {
			if id, err := strconv.ParseInt(a, 10, 64); err == nil {
				args = append(args, id)
				where = append(where, "l.assigned_to = $"+strconv.Itoa(len(args)))
			}
		}
		if st := r.URL.Query().Get("status"); st != "" {
			args = append(args, st)
			where = append(where, forwardStatusExpr+" = $"+strconv.Itoa(len(args)))
		}

		rows, err := db.PGQuery(ctx, `
			SELECT f.id, f.lead_id, f.contact_id, f.forwarded_by, f.forwarded_by_name,
			       f.customer_name, f.customer_phone, f.customer_cif, f.product_interest,
			       f.notes, f.forwarded_at, f.resolved_at, f.outcome,
			       `+forwardStatusExpr+` AS status,
			       c.lead_stage AS crm_stage, c.converted_cif, c.disqualify_reason,
			       COALESCE(f.sales_owner_name, ow.full_name) AS sales_owner_name,
			       la.full_name AS lead_agent_name,
			       cc.name AS campaign_name, mc.name AS marketing_campaign_name
			  FROM call_center_lead_forwards f
			  LEFT JOIN crm_contacts c        ON c.id  = f.contact_id
			  LEFT JOIN o3c_users ow          ON ow.id = c.account_manager_id
			  LEFT JOIN call_center_leads l   ON l.id  = f.lead_id
			  LEFT JOIN o3c_users la          ON la.id = l.assigned_to
			  LEFT JOIN call_center_campaigns cc ON cc.id = f.cc_campaign_id
			  LEFT JOIN campaigns mc          ON mc.id = f.marketing_campaign_id
			 WHERE `+strings.Join(where, " AND ")+`
			 ORDER BY f.forwarded_at DESC
			 LIMIT 500`, args...)
		if err != nil {
			respondErr(w, 500, "Could not load forwarded leads")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		respond(w, rows, "pg")
	}
}

// ccForwardsSummary returns hand-off counts by outcome for the tracker header.
func ccForwardsSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Not authenticated")
			return
		}
		sup := ccIsSupervisor(user)
		where, args := "1=1", []any{}
		if !sup {
			args = append(args, user.ID)
			where = "l.assigned_to = $1"
		} else if r.URL.Query().Get("scope") == "mine" {
			args = append(args, user.ID)
			where = "f.forwarded_by = $1"
		} else if a := r.URL.Query().Get("agent"); a != "" {
			if id, err := strconv.ParseInt(a, 10, 64); err == nil {
				args = append(args, id)
				where = "l.assigned_to = $1"
			}
		}
		rows, err := db.PGQuery(ctx, `
			SELECT `+forwardStatusExpr+` AS status, COUNT(*) AS n
			  FROM call_center_lead_forwards f
			  LEFT JOIN crm_contacts c ON c.id = f.contact_id
			  LEFT JOIN call_center_leads l ON l.id = f.lead_id
			 WHERE `+where+`
			 GROUP BY 1`, args...)
		if err != nil {
			respondErr(w, 500, "Could not load summary")
			return
		}
		out := map[string]int64{"forwarded": 0, "with_sales": 0, "assigned": 0, "converted": 0, "rejected": 0, "total": 0}
		for _, r := range rows {
			s := str(r["status"])
			n := toInt64(r["n"])
			out[s] += n
			out["total"] += n
		}
		respond(w, out, "pg")
	}
}

// forwardStatusExpr derives the LIVE hand-off outcome from the CRM contact so the
// tracker never drifts from what Sales actually did. Falls back to the stored
// hand-off status when the contact has not moved.
const forwardStatusExpr = `
	CASE
	  WHEN c.lead_stage = 'converted'    THEN 'converted'
	  WHEN c.lead_stage = 'disqualified' THEN 'rejected'
	  WHEN f.status = 'assigned'         THEN 'assigned'
	  WHEN c.lead_stage = 'qualified'    THEN 'with_sales'
	  ELSE COALESCE(f.status, 'forwarded')
	END`

// markForwardResolved is called by the Sales handlers when a forwarded lead is
// converted or disqualified, so the tracker records a durable outcome + owner and
// stops treating the hand-off as open. Fire-and-forget.
func markForwardResolved(ctx context.Context, db *core.DB, contactID int64, status string, ownerID *int64, outcome string) {
	var owner any
	if ownerID != nil && *ownerID > 0 {
		owner = *ownerID
	}
	db.PGExec(ctx, //nolint:errcheck
		`UPDATE call_center_lead_forwards
		    SET status         = $2,
		        sales_owner_id  = COALESCE($3, sales_owner_id),
		        sales_owner_name = COALESCE((SELECT full_name FROM o3c_users WHERE id=$3), sales_owner_name),
		        outcome        = COALESCE(NULLIF($4,''), outcome),
		        updated_at     = NOW(),
		        resolved_at    = CASE WHEN $2 IN ('converted','rejected','closed') THEN NOW() ELSE resolved_at END
		  WHERE contact_id = $1 AND status IN ('forwarded','accepted','assigned')`,
		contactID, status, owner, outcome)
}
