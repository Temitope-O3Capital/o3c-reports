package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Hand-offs — the missing half of the activity stream.
//
// "Hand off to Risk" wrote app.activities(type='handoff', target_team='risk',
// status='open') and stopped there. Nothing in the app read target_team, so the
// receiving team was never told, and the raiser could never learn what happened:
// the only reflect-back in the codebase (resolveHandoffsForApplication) fires when a
// LOAN APPLICATION reaches a decision, so a hand-off to Ops, Finance or Care stayed
// "open" for ever. Migration 228 had already reserved
// idx_activities_handoff (target_team, status) for the inbox this file builds:
//
//	GET   /api/activities/handoffs?scope=inbox|raised   — what my team owes, what I raised
//	PATCH /api/activities/{id}/status                   — accept / resolve / return / cancel
//
// Every transition writes a REFLECT-BACK activity pointing at the original
// (related_activity_id) and anchored to the same person, so the answer lands on the
// lead's own timeline next to the question, and the raiser is told once.

// Event types for the bell. Kept here rather than in notify.go's const block so the
// hand-off feature lands as one file in a tree several sessions edit at once.
const (
	EvtHandoffRaised  = "handoff_raised"
	EvtHandoffUpdated = "handoff_updated"
)

// The lifecycle migration 228 specified. Anything outside it is rejected: a free-text
// status would make "still open" — the only question the inbox asks — meaningless.
var handoffStatuses = map[string]bool{
	"open": true, "accepted": true, "in_progress": true,
	"resolved": true, "returned": true, "cancelled": true,
}

// Reaching one of these ends a hand-off; the inbox stops carrying it.
func handoffClosed(status string) bool {
	switch status {
	case "resolved", "returned", "cancelled":
		return true
	}
	return false
}

// handoffUpdateSubject phrases a transition the way the person who raised it would
// read it on the lead's timeline — "Risk resolved it", not "status=resolved".
func handoffUpdateSubject(status, team string) string {
	who := titleTeam(team)
	switch status {
	case "accepted":
		return who + " accepted the hand-off"
	case "in_progress":
		return who + " is working on the hand-off"
	case "resolved":
		return who + " resolved the hand-off"
	case "returned":
		return who + " returned the hand-off"
	case "cancelled":
		return "Hand-off to " + who + " cancelled"
	}
	return "Hand-off updated"
}

// titleTeam renders a team code as a label ("call_center" → "Call Center").
func titleTeam(team string) string {
	t := strings.TrimSpace(team)
	if t == "" {
		return "The team"
	}
	parts := strings.Split(strings.ReplaceAll(t, "_", " "), " ")
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

// notifyTeam pings everyone whose role folds to a team, by INVERTING teamFromRole —
// the same mapping an activity is attributed with — rather than keeping a second
// hardcoded list of role names that would drift the first time a role is renamed.
// Returns how many people were actually told, so the sender can be shown whether the
// hand-off reached anyone at all instead of a success toast either way.
func notifyTeam(ctx context.Context, db *core.DB, team string, except int64, p NotifPayload) int {
	team = strings.ToLower(strings.TrimSpace(team))
	if team == "" {
		return 0
	}
	rows, err := db.PGQuery(ctx, `SELECT id, COALESCE(role,'') AS role FROM o3c_users WHERE is_active = TRUE`)
	if err != nil {
		return 0
	}
	var ids []int64
	for _, row := range rows {
		if teamFromRole(str(row["role"])) != team {
			continue
		}
		id := toInt64(row["id"])
		if id == 0 || id == except {
			continue
		}
		ids = append(ids, id)
	}
	NotifyUsers(ctx, db, ids, p)
	return len(ids)
}

// anchorURL is where a notification about this activity should land you: on the
// record it concerns, never on a list you then have to search.
func anchorURL(leadID *int64, fallback string) string {
	if leadID != nil && *leadID > 0 {
		return fmt.Sprintf("/call-center/leads?open=%d", *leadID)
	}
	return fallback
}

// notifyHandoffRaised tells the receiving team that work has arrived. Grouped per
// team (GroupKey) so a busy day collapses into one live notification that counts up,
// rather than one ping per hand-off — the pattern the unassigned-pool digest set.
func notifyHandoffRaised(ctx context.Context, db *core.DB, a Activity, actorID int64) int {
	subject := strings.TrimSpace(a.Subject)
	if subject == "" {
		subject = "A lead was handed to your team"
	}
	from := strings.TrimSpace(a.ActorName)
	if from == "" {
		from = "A colleague"
	}
	return notifyTeam(ctx, db, a.TargetTeam, actorID, NotifPayload{
		EventType: EvtHandoffRaised,
		Title:     "Handed to " + titleTeam(a.TargetTeam),
		Body:      from + ": " + subject,
		ActionURL: anchorURL(a.LeadID, "/handoffs"),
		EntityRef: "handoff",
		GroupKey:  "handoff:" + strings.ToLower(a.TargetTeam),
		Priority:  "normal",
	})
}

// handoffList answers the two questions a hand-off raises: what does my team owe
// (scope=inbox), and what did I hand over (scope=raised). Open first, newest first.
func handoffList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "sign in first")
			return
		}
		scope := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("scope")))
		if scope == "" {
			scope = "inbox"
		}
		myTeam := teamFromRole(u.Role)

		var where string
		var args []any
		if scope == "raised" {
			args = append(args, u.ID)
			where = "a.actor_user_id = $1"
		} else {
			args = append(args, myTeam)
			where = "a.target_team = $1"
		}
		// Default view is work still owed; ?status=all opens the archive.
		if strings.ToLower(r.URL.Query().Get("status")) != "all" {
			where += " AND COALESCE(a.status,'open') NOT IN ('resolved','returned','cancelled')"
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT a.id, a.subject, a.body, a.outcome, COALESCE(a.status,'open') AS status,
			       COALESCE(a.target_team,'') AS target_team, COALESCE(a.actor_name,'') AS actor_name,
			       COALESCE(a.actor_team,'') AS actor_team, COALESCE(a.actor_user_id,0) AS actor_user_id,
			       a.occurred_at, a.lead_id, a.contact_id, a.cif, a.application_id,
			       COALESCE(NULLIF(l.customer_name,''),
			                NULLIF(TRIM(CONCAT(c.first_name,' ',c.last_name)),''),
			                NULLIF(a.cif,''), COALESCE(a.phone,'')) AS about_name,
			       COALESCE(NULLIF(l.customer_phone,''), NULLIF(c.phone,''), COALESCE(a.phone,'')) AS about_phone,
			       (SELECT COUNT(*) FROM app.activities u2 WHERE u2.related_activity_id = a.id) AS update_count,
			       (SELECT u3.body FROM app.activities u3 WHERE u3.related_activity_id = a.id
			         ORDER BY u3.occurred_at DESC LIMIT 1) AS last_update
			  FROM app.activities a
			  LEFT JOIN app.call_center_leads l ON l.id = a.lead_id
			  LEFT JOIN crm_contacts c          ON c.id = a.contact_id
			 WHERE a.type = 'handoff' AND `+where+`
			 ORDER BY (COALESCE(a.status,'open') = 'open') DESC, a.occurred_at DESC
			 LIMIT 200`, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load hand-offs", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data":   rows,
			"viewer": map[string]any{"user_id": u.ID, "team": myTeam, "scope": scope},
		})
	}
}

// Statuses a follow-up may take. A task's status lives in crm_tasks, so these are the
// CRM's words, not the hand-off lifecycle's.
var taskStatuses = map[string]bool{"open": true, "in_progress": true, "done": true, "cancelled": true}

// taskSetStatus ticks a follow-up off (or reopens it) from the record it was raised on.
// The write goes to crm_tasks because that is the task's system of record — the activity
// row is only its shadow, and the timeline reads the live status back through the entity
// link. No reflect-back activity is written: a task going done is not news, and a second
// row per tick would bury the history it sits in.
func taskSetStatus(w http.ResponseWriter, r *http.Request, db *core.DB, u *core.Claims, h core.Row, status, note string) {
	if !taskStatuses[status] {
		respondErr(w, 400, "Unknown status. Use open, in_progress, done or cancelled.")
		return
	}
	taskID, err := strconv.ParseInt(strings.TrimSpace(str(h["entity_id"])), 10, 64)
	if err != nil || taskID <= 0 {
		respondErr(w, 400, "this follow-up is not linked to a task")
		return
	}
	rows, err := db.PGQuery(r.Context(), `
		SELECT COALESCE(assigned_to,0) AS assigned_to, COALESCE(created_by,0) AS created_by,
		       COALESCE(title,'') AS title
		  FROM crm_tasks WHERE id = $1`, taskID)
	if err != nil {
		respondErrLog(w, 500, "Could not load the follow-up", err)
		return
	}
	if len(rows) == 0 {
		respondErr(w, 404, "follow-up not found")
		return
	}
	owner, creator := toInt64(rows[0]["assigned_to"]), toInt64(rows[0]["created_by"])
	if u.ID != owner && u.ID != creator && !strings.Contains(strings.ToLower(u.Role), "admin") {
		respondErr(w, 403, "only the person the follow-up belongs to can close it")
		return
	}
	if _, err := db.PGExec(r.Context(), `
		UPDATE crm_tasks
		   SET status = $1,
		       description = CASE WHEN $2 = '' THEN description
		                          ELSE COALESCE(description || E'\n', '') || $2 END,
		       updated_at = NOW()
		 WHERE id = $3`, status, strings.TrimSpace(note), taskID); err != nil {
		respondErrLog(w, 500, "Could not update the follow-up", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"id": toInt64(h["id"]), "task_id": taskID, "status": status}) //nolint:errcheck
}

// activitySetStatus moves the two activity kinds that HAVE a lifecycle. A hand-off:
// the receiving team accepts, works and resolves or returns it, and only the person who
// raised it may cancel it — every transition leaves a reflect-back on the person's
// timeline and tells the raiser. A task: ticked off by whoever owns it.
func activitySetStatus(db *core.DB) http.HandlerFunc {
	type body struct {
		Status  string `json:"status"`
		Note    string `json:"note"`
		Outcome string `json:"outcome"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "sign in first")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || id <= 0 {
			respondErr(w, 400, "invalid activity id")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		status := strings.ToLower(strings.TrimSpace(b.Status))
		if status == "" {
			respondErr(w, 400, "status is required")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT id, COALESCE(type,'') AS type, COALESCE(status,'open') AS status,
			       COALESCE(target_team,'') AS target_team, COALESCE(subject,'') AS subject,
			       COALESCE(actor_user_id,0) AS actor_user_id, COALESCE(actor_name,'') AS actor_name,
			       COALESCE(entity_type,'') AS entity_type, COALESCE(entity_id,'') AS entity_id,
			       lead_id, contact_id, application_id, COALESCE(cif,'') AS cif, COALESCE(phone,'') AS phone
			  FROM app.activities WHERE id = $1`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not load the activity", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "activity not found")
			return
		}
		h := rows[0]
		switch str(h["type"]) {
		case "task":
			taskSetStatus(w, r, db, u, h, status, b.Note)
			return
		case "handoff":
			// The hand-off lifecycle below.
		default:
			respondErr(w, 400, "that activity has no status to change")
			return
		}
		if !handoffStatuses[status] {
			respondErr(w, 400, "Unknown status. Use open, accepted, in_progress, resolved, returned or cancelled.")
			return
		}
		if handoffClosed(str(h["status"])) {
			respondErr(w, 409, "this hand-off is already closed")
			return
		}

		team := str(h["target_team"])
		raiser := toInt64(h["actor_user_id"])
		adminish := strings.Contains(strings.ToLower(u.Role), "admin")
		onTeam := teamFromRole(u.Role) == team
		// Cancelling is the raiser's call (they asked for it); everything else belongs
		// to the team that was asked to do the work.
		if status == "cancelled" {
			if u.ID != raiser && !adminish {
				respondErr(w, 403, "only the person who raised a hand-off can cancel it")
				return
			}
		} else if !onTeam && !adminish {
			respondErr(w, 403, "only "+titleTeam(team)+" can update this hand-off")
			return
		}
		// A resolution that says nothing is not a resolution — the raiser has to be
		// able to read what happened without chasing anyone.
		if handoffClosed(status) && status != "cancelled" && strings.TrimSpace(b.Note) == "" {
			respondErr(w, 400, "say what happened before closing a hand-off")
			return
		}

		if _, err := db.PGExec(r.Context(), `
			UPDATE app.activities
			   SET status = $1, outcome = COALESCE(NULLIF($2,''), outcome)
			 WHERE id = $3 AND type = 'handoff'`, status, strings.TrimSpace(b.Outcome), id); err != nil {
			respondErrLog(w, 500, "Could not update the hand-off", err)
			return
		}

		// Reflect-back: anchored to the same person, pointing at the original, so the
		// lead's timeline shows the answer under the question.
		nullable := func(v any) *int64 {
			if n := toInt64(v); n > 0 {
				return &n
			}
			return nil
		}
		leadID := nullable(h["lead_id"])
		actorID, actorName, actorTeam := actorOf(u)
		logActivitySafe(r.Context(), db, Activity{
			LeadID: leadID, ContactID: nullable(h["contact_id"]), ApplicationID: nullable(h["application_id"]),
			CIF: str(h["cif"]), Phone: str(h["phone"]),
			ActorUserID: actorID, ActorName: actorName, ActorTeam: actorTeam,
			Type: "handoff_update", Subject: handoffUpdateSubject(status, team),
			Body: strings.TrimSpace(b.Note), Outcome: strings.TrimSpace(b.Outcome),
			TargetTeam: team, Status: status, RelatedID: &id, Source: "handoff",
		})

		// Tell the raiser — once, and never about their own click.
		if raiser > 0 && raiser != u.ID {
			NotifyUsers(context.WithoutCancel(r.Context()), db, []int64{raiser}, NotifPayload{
				EventType: EvtHandoffUpdated,
				Title:     handoffUpdateSubject(status, team),
				Body:      strings.TrimSpace(b.Note),
				ActionURL: anchorURL(leadID, "/handoffs?scope=raised"),
				EntityRef: fmt.Sprintf("activity:%d", id),
				Priority:  "normal",
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": id, "status": status}) //nolint:errcheck
	}
}
