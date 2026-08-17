package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// Escalation, take-over and assisted resolution.
//
// Before this, "escalation" was a status string. Setting it notified
// call_center_head and nothing else was recorded — not who escalated, not why,
// not to whom, not whether anyone ever picked it up. No ticket in 35,035 was
// ever in that state, which is what you would expect of a workflow with no way
// back out of it.
//
// An escalation now names a person, carries a reason, and has to be closed by
// someone. That makes it answerable: the supervisor's list of open escalations
// is a real worklist rather than a status filter over an empty set.

// hdUserCanWorkTickets reports whether a user could actually open a ticket if one
// were put in their name.
//
// Page access is derived purely from role (+ extra_roles) via core.RolePages —
// there is no per-user pages column — and the 'helpdesk' page is granted only to
// the call-centre and Care roles. A finance_officer or settlement_officer has no
// helpdesk access at all.
//
// This matters because hdListAgents lists EVERY active user with no role filter,
// so a supervisor could assign a call-centre ticket to someone in Settlements.
// The assignment succeeded, the notification and email were sent, and the link
// then 403'd — the ticket left its owner's queue and landed with someone who
// could not open it, while the SLA monitor kept chasing them about it.
func hdUserCanWorkTickets(ctx context.Context, db *core.DB, userID int64) (ok bool, name string) {
	rows, _ := db.PGQuery(ctx,
		`SELECT COALESCE(full_name,'') AS full_name, COALESCE(role,'') AS role, extra_roles
		   FROM o3c_users WHERE id=$1 AND is_active = TRUE AND deleted_at IS NULL`, userID)
	if len(rows) == 0 {
		return false, ""
	}
	name = str(rows[0]["full_name"])
	role := str(rows[0]["role"])
	if role == "admin" {
		return true, name
	}

	roles := []string{role}
	switch v := rows[0]["extra_roles"].(type) {
	case []any:
		for _, e := range v {
			roles = append(roles, str(e))
		}
	case []string:
		roles = append(roles, v...)
	}
	for _, rl := range roles {
		for _, p := range core.RolePages[rl] {
			if p == "helpdesk" {
				return true, name
			}
		}
	}
	return false, name
}

// hdEscalateTicket — POST /tickets/{id}/escalate
// Body: {"to_user_id": 12, "reason": "customer disputes the fee"}
// to_user_id is optional; without it the escalation goes to the call-centre head
// pool, which is the common case for an agent who does not know who owns the
// problem.
func hdEscalateTicket(db *core.DB) http.HandlerFunc {
	type body struct {
		ToUserID int64  `json:"to_user_id"`
		Reason   string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ticketID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ticket ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		b.Reason = strings.TrimSpace(b.Reason)
		if b.Reason == "" {
			// An escalation without a reason is just a status change, and the person
			// receiving it has nothing to act on.
			respondErr(w, 422, "A reason is required to escalate")
			return
		}
		// Refuse to escalate INTO a dead end.
		if b.ToUserID > 0 {
			can, who := hdUserCanWorkTickets(ctx, db, b.ToUserID)
			if !can {
				if who == "" {
					respondErr(w, 422, "That person is not an active user")
					return
				}
				respondErr(w, 422, who+" does not have Helpdesk access, so they could not open this ticket. "+
					"Escalate to supervisors instead, or ask an admin to grant them the Helpdesk page.")
				return
			}
		}

		// Escalation is a FLAG, not a status.
		//
		// helpdesk_tickets_status_check permits only open/pending/in_progress/
		// resolved/closed — 'escalated' has never been a legal value, so the older
		// code path that set it threw a constraint violation every time. That, not
		// disuse, is why zero of 35,035 tickets were ever escalated.
		//
		// Keeping it orthogonal is also the right model: an escalated ticket is
		// still open, and overwriting status would drop it out of every
		// status='open' count in the app while it is at its most urgent.
		rows, err := db.PGQuery(ctx, `
			UPDATE helpdesk_tickets
			   SET escalated_at           = NOW(),
			       escalated_by           = $1,
			       escalated_to           = NULLIF($2,0)::bigint,
			       escalation_reason      = $3,
			       escalation_resolved_at = NULL,
			       escalation_resolved_by = NULL,
			       updated_at             = NOW()
			 WHERE id = $4
			   AND status NOT IN ('resolved','closed')
			   AND escalation_resolved_at IS NULL
			   AND escalated_at IS NULL
			 RETURNING ticket_ref, subject, assigned_to`,
			user.ID, b.ToUserID, b.Reason, ticketID)
		if err != nil {
			respondErr(w, 500, "Could not escalate")
			return
		}
		if len(rows) == 0 {
			cur, _ := db.PGQuery(ctx,
				`SELECT status, escalated_at FROM helpdesk_tickets WHERE id=$1`, ticketID)
			if len(cur) == 0 {
				respondErr(w, 404, "Ticket not found")
				return
			}
			if cur[0]["escalated_at"] != nil {
				respondErr(w, 409, "That ticket already has an open escalation")
				return
			}
			respondErr(w, 409, "Cannot escalate a "+str(cur[0]["status"])+" ticket")
			return
		}
		t := rows[0]
		ref := str(t["ticket_ref"])

		hdRecordEvent(ctx, db, ticketID, user.ID, "escalated", "", b.Reason)
		go hdLogAssist(context.WithoutCancel(ctx), db, ticketID, user.ID, "escalated", b.Reason)

		p := NotifPayload{
			EventType: "ticket_escalated",
			Title:     fmt.Sprintf("Escalated to you: %s", ref),
			Body:      fmt.Sprintf("%s — %s (escalated by %s)", str(t["subject"]), b.Reason, user.FullName),
			ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
			EntityRef: ref,
			Priority:  "high",
		}
		if b.ToUserID > 0 {
			// Named target: tell that person directly, and copy the supervisors so an
			// escalation cannot disappear into one person's inbox.
			NotifyUsers(context.WithoutCancel(ctx), db, []int64{b.ToUserID}, p)
			sup := p
			sup.Title = fmt.Sprintf("Escalated: %s", ref)
			go NotifyRole(context.WithoutCancel(ctx), db, "call_center_head", sup)
		} else {
			p.Title = fmt.Sprintf("Escalated: %s", ref)
			go NotifyRole(context.WithoutCancel(ctx), db, "call_center_head", p)
		}
		// The owner needs to know their ticket left their hands.
		if owner := toInt64(t["assigned_to"]); owner > 0 && owner != user.ID {
			ow := p
			ow.Title = fmt.Sprintf("Your ticket was escalated: %s", ref)
			NotifyUsers(context.WithoutCancel(ctx), db, []int64{owner}, ow)
		}

		respond(w, map[string]any{"escalated": true, "ticket_ref": ref}, "json")
	}
}

// hdResolveEscalation — POST /tickets/{id}/escalation/resolve
// Closes the escalation and hands the ticket back to normal working state. The
// ticket itself is NOT resolved by this — an escalation ending means the blocker
// is cleared, not that the customer's problem is fixed.
func hdResolveEscalation(db *core.DB) http.HandlerFunc {
	type body struct {
		Note string `json:"note"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ticketID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ticket ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		rows, err := db.PGQuery(ctx, `
			UPDATE helpdesk_tickets
			   SET escalation_resolved_at = NOW(),
			       escalation_resolved_by = $1,
			       updated_at = NOW()
			 WHERE id = $2 AND escalated_at IS NOT NULL AND escalation_resolved_at IS NULL
			 RETURNING ticket_ref, escalated_by, assigned_to`, user.ID, ticketID)
		if err != nil {
			respondErr(w, 500, "Could not close the escalation")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 409, "No open escalation on that ticket")
			return
		}
		t := rows[0]
		ref := str(t["ticket_ref"])
		hdRecordEvent(ctx, db, ticketID, user.ID, "escalation_resolved", "", b.Note)

		// Tell the person who raised it and the current owner — an escalation that
		// closes silently is why nobody trusted the old one.
		NotifyExcept(context.WithoutCancel(ctx), db,
			[]int64{toInt64(t["escalated_by"]), toInt64(t["assigned_to"])}, user.ID,
			NotifPayload{
				EventType: "ticket_escalation_resolved",
				Title:     fmt.Sprintf("Escalation cleared: %s", ref),
				Body:      strings.TrimSpace(fmt.Sprintf("%s closed the escalation. %s", user.FullName, b.Note)),
				ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
				EntityRef: ref,
			})

		respond(w, map[string]any{"resolved": true}, "json")
	}
}

// hdTakeOverTicket — POST /tickets/{id}/take-over
// Explicit transfer of ownership away from another agent. Deliberately separate
// from claim (which only takes unowned work) and from assisting (which leaves
// ownership alone): taking a ticket off a colleague should be a decision, not a
// side effect of opening it.
func hdTakeOverTicket(db *core.DB) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ticketID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ticket ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		prev, _ := db.PGQuery(ctx,
			`SELECT assigned_to, ticket_ref FROM helpdesk_tickets WHERE id=$1`, ticketID)
		if len(prev) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		previousOwner := toInt64(prev[0]["assigned_to"])
		if previousOwner == user.ID {
			respondErr(w, 409, "You already own that ticket")
			return
		}

		if _, err := db.PGExec(ctx,
			`UPDATE helpdesk_tickets
			    SET assigned_to=$1, assigned_at=NOW(), updated_at=NOW()
			  WHERE id=$2 AND status NOT IN ('resolved','closed')`, user.ID, ticketID); err != nil {
			respondErr(w, 500, "Take-over failed")
			return
		}
		ref := str(prev[0]["ticket_ref"])
		hdRecordEvent(ctx, db, ticketID, user.ID, "assigned", fmt.Sprintf("%d", previousOwner), fmt.Sprintf("%d", user.ID))
		go hdLogAssist(context.WithoutCancel(ctx), db, ticketID, user.ID, "took_over", b.Reason)

		if previousOwner > 0 {
			NotifyUsers(context.WithoutCancel(ctx), db, []int64{previousOwner}, NotifPayload{
				EventType: "ticket_taken_over",
				Title:     fmt.Sprintf("%s took over %s", user.FullName, ref),
				Body: strings.TrimSpace(fmt.Sprintf(
					"%s is now the owner of %s. %s", user.FullName, ref, b.Reason)),
				ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
				EntityRef: ref,
			})
		}
		respond(w, map[string]any{"assigned_to": user.ID, "previous_owner": previousOwner}, "json")
	}
}

// hdListEscalations — GET /escalations
// The supervisor worklist: every open escalation, oldest first, with how long it
// has been sitting. Agents see the ones they raised or received.
func hdListEscalations(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		where := "t.escalated_at IS NOT NULL"
		args := []any{}
		if qstr(r, "include_resolved") != "1" {
			where += " AND t.escalation_resolved_at IS NULL"
		}
		if !user.CanSeeAllRows() && !user.HasPage("call_center_stats") {
			args = append(args, user.ID)
			where += " AND (t.escalated_by=$1 OR t.escalated_to=$1 OR t.assigned_to=$1)"
		}

		rows, err := db.PGQuery(ctx, `
			SELECT t.id, t.ticket_ref, t.subject, t.priority, t.status,
			       t.escalated_at, t.escalation_reason,
			       t.escalation_resolved_at,
			       eb.full_name AS escalated_by_name,
			       et.full_name AS escalated_to_name,
			       er.full_name AS resolved_by_name,
			       ow.full_name AS owner_name,
			       ROUND(EXTRACT(EPOCH FROM (COALESCE(t.escalation_resolved_at, NOW()) - t.escalated_at))/3600.0, 1) AS hours_open
			  FROM helpdesk_tickets t
			  LEFT JOIN o3c_users eb ON eb.id = t.escalated_by
			  LEFT JOIN o3c_users et ON et.id = t.escalated_to
			  LEFT JOIN o3c_users er ON er.id = t.escalation_resolved_by
			  LEFT JOIN o3c_users ow ON ow.id = t.assigned_to
			 WHERE `+where+`
			 ORDER BY t.escalation_resolved_at IS NOT NULL, t.escalated_at ASC
			 LIMIT 200`, args...)
		if err != nil {
			respondErr(w, 500, "Could not load escalations")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// hdTicketAssists — GET /tickets/{id}/assists
// Who has helped on this ticket. Shown on the ticket so the owner can see who
// touched their work, and so a helper gets visible credit for it.
func hdTicketAssists(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT a.id, a.action, a.detail, a.created_at,
			       u.full_name AS helper_name, u.role AS helper_role
			  FROM ticket_assists a
			  LEFT JOIN o3c_users u ON u.id = a.helper_user_id
			 WHERE a.ticket_id = $1
			 ORDER BY a.created_at DESC
			 LIMIT 100`, chi.URLParam(r, "id"))
		if err != nil {
			respondErr(w, 500, "Could not load assists")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}
