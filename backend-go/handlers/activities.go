package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// viewerSeesSAR reports whether the request user may see Suspicious Activity Report detail.
// SARs surface on the timeline as a bare "compliance flag" for everyone; only compliance
// roles see the detail — anti-tipping-off. Kept here so both the Customer 360 timeline and
// the activity list gate identically.
func viewerSeesSAR(u *core.Claims) bool {
	return u != nil && (u.HasPage("sars") || u.HasPage("compliance_all") || u.HasPage("compliance_head"))
}

// actorOf pulls the standard actor fields (id, name, team) from the request user for an
// emitted activity. Handles a nil user (unauthenticated/system) gracefully.
func actorOf(u *core.Claims) (id *int64, name, team string) {
	if u != nil {
		id = &u.ID
		name = u.FullName
		team = teamFromRole(u.Role)
	}
	return
}

// logActivitySafe emits an activity as a SIDE-EFFECT of a primary action. A failure is
// logged, never returned, so recording an activity can never break the action that caused
// it (a lead move, a decision, a card block). Use this from handlers; use LogActivity
// directly only when the id or a hard failure matters.
func logActivitySafe(ctx context.Context, db *core.DB, a Activity) {
	if _, err := LogActivity(ctx, db, a); err != nil {
		slog.Warn("LogActivity failed", "type", a.Type, "source", a.Source, "err", err)
	}
}

// resolveHandoffsForApplication closes the open hand-offs for the customer behind a loan
// application when a downstream team reaches a verdict — the reflect-back that lets the
// call-centre agent who forwarded the lead see the outcome. Matches open handoff activities
// by the application's CIF or phone (the lead may still have no CIF), stamps status +
// outcome. Best-effort: a failure is swallowed so it never blocks the decision.
func resolveHandoffsForApplication(ctx context.Context, db *core.DB, applicationID int64, status, outcome string) {
	db.PGExec(ctx, `
		WITH la AS (
		  SELECT NULLIF(applicant_cif,'') AS cif,
		         NULLIF(app.norm_phone(applicant_phone),'') AS phone,
		         (SELECT c.party_id FROM app.customers c WHERE c.cif = lo.applicant_cif AND c.party_id IS NOT NULL LIMIT 1) AS party_id
		    FROM app.loan_applications lo WHERE lo.id = $1)
		UPDATE app.activities a
		   SET status = $2, outcome = COALESCE(NULLIF($3,''), a.outcome)
		  FROM la
		 WHERE a.type = 'handoff' AND a.status = 'open'
		   AND ( (la.party_id IS NOT NULL AND a.party_id = la.party_id)
		      OR (la.cif   IS NOT NULL AND a.cif   = la.cif)
		      OR (la.phone IS NOT NULL AND a.phone = la.phone) )`,
		applicationID, status, outcome) //nolint:errcheck
}

// Activity stream — see migrations/228_activities.sql.
//
// LogActivity is the SINGLE writer for app.activities, the way every call goes through
// hdLogCall. Any team (call centre, sales, risk, …) records a note, a document, a handoff,
// a stage change or a decision by filling the anchors + fields it has and calling this.
// Readers match a person by those anchors, exactly like the Customer 360 union and the
// lead call-history query already do, so a pre-CIF lead and the loan application it later
// becomes land on the same stream.

// Activity is the input to LogActivity. Only set what you have; empty fields are stored NULL.
type Activity struct {
	PartyID       *int64 // set directly when the caller already knows the person (else the DB trigger resolves it)
	LeadID        *int64
	ContactID     *int64
	CIF           string
	ApplicationID *int64
	TicketID      *int64
	CallID        *int64
	Phone         string
	ActorUserID   *int64
	ActorName     string
	ActorTeam     string
	Type          string // note | document | handoff | stage_change | decision | task | ...
	Direction     string // in | out | internal
	Subject       string
	Body          string
	Outcome       string
	TargetTeam    string
	TargetUserID  *int64
	Status        string
	RelatedID     *int64 // reflect-back → the originating handoff
	EntityType    string // deep-link to a sub-entity: promise | dispute | fd_txn | card_request | condition | deal | ...
	EntityID      string
	Metadata      map[string]any
	Source        string
	OccurredAt    *time.Time
}

// teamFromRole folds a user's role into the coarse team an activity is attributed to.
func teamFromRole(role string) string {
	r := strings.ToLower(role)
	switch {
	case strings.Contains(r, "call_center"), strings.Contains(r, "telemarket"):
		return "call_center"
	case strings.Contains(r, "sales"), strings.Contains(r, "bd"):
		return "sales"
	case strings.Contains(r, "risk"):
		return "risk"
	case strings.Contains(r, "finance"), strings.Contains(r, "cfo"):
		return "finance"
	case strings.Contains(r, "collection"):
		return "collections"
	case strings.Contains(r, "recovery"):
		return "recovery"
	case strings.Contains(r, "care"), strings.Contains(r, "helpdesk"), strings.Contains(r, "support"):
		return "care"
	case strings.Contains(r, "ops"), strings.Contains(r, "cards"):
		return "ops"
	}
	return r
}

// LogActivity inserts one activity and returns its id. Errors are returned to the caller;
// a side-effect log (e.g. from a call or a handoff) should log-and-continue, never fail the
// primary action because the activity write failed.
func LogActivity(ctx context.Context, db *core.DB, a Activity) (int64, error) {
	if strings.TrimSpace(a.Type) == "" {
		a.Type = "note"
	}
	if strings.TrimSpace(a.Source) == "" {
		a.Source = "manual"
	}
	phone := strings.TrimSpace(a.Phone)
	if phone != "" {
		phone = normalizePhone(phone)
	}
	var meta any // nil → NULL::jsonb
	if a.Metadata != nil {
		if b, err := json.Marshal(a.Metadata); err == nil {
			meta = string(b)
		}
	}
	occurred := time.Now()
	if a.OccurredAt != nil && !a.OccurredAt.IsZero() {
		occurred = *a.OccurredAt
	}
	rows, err := db.PGQuery(ctx, `
		INSERT INTO app.activities
		  (lead_id, contact_id, cif, application_id, ticket_id, call_id, phone,
		   actor_user_id, actor_name, actor_team, type, direction, subject, body, outcome,
		   target_team, target_user_id, status, related_activity_id, metadata, source, occurred_at,
		   entity_type, entity_id, party_id)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,NULLIF($7,''),
		        $8,NULLIF($9,''),NULLIF($10,''),$11,NULLIF($12,''),NULLIF($13,''),NULLIF($14,''),NULLIF($15,''),
		        NULLIF($16,''),$17,NULLIF($18,''),$19,$20::jsonb,$21,$22,
		        NULLIF($23,''),NULLIF($24,''),$25)
		RETURNING id`,
		a.LeadID, a.ContactID, a.CIF, a.ApplicationID, a.TicketID, a.CallID, phone,
		a.ActorUserID, a.ActorName, a.ActorTeam, a.Type, a.Direction, a.Subject, a.Body, a.Outcome,
		a.TargetTeam, a.TargetUserID, a.Status, a.RelatedID, meta, a.Source, occurred,
		a.EntityType, a.EntityID, a.PartyID)
	if err != nil {
		return 0, err
	}
	if len(rows) > 0 {
		if id, ok := rows[0]["id"].(int64); ok {
			return id, nil
		}
	}
	return 0, nil
}

// RegisterActivities mounts the activity-stream routes under an authenticated group.
func RegisterActivities(r chi.Router, db *core.DB) {
	r.Get("/activities", activityList(db))
	r.Post("/activities", activityCreate(db))
	// Hand-offs: the inbox for the team that was handed something, and the lifecycle
	// that lets them answer it (see activity_handoffs.go).
	r.Get("/activities/handoffs", handoffList(db))
	r.Patch("/activities/{id}/status", activitySetStatus(db))
	// Lead/contact document uploads (pre-application file store).
	r.Post("/activities/document", activityUploadDocument(db))
	r.Get("/activities/documents/{doc_id}/content", activityDocumentContent(db))
}

// activityList returns activities for a person, matched by any anchor supplied as a query
// param (lead_id, contact_id, cif, application_id, phone). Multiple anchors widen the match
// (OR) so a lead can be found by its id AND its phone.
func activityList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var clauses []string
		var args []any
		add := func(col string, v any) { args = append(args, v); clauses = append(clauses, fmt.Sprintf("a.%s = $%d", col, len(args))) }

		if v := r.URL.Query().Get("party_id"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				add("party_id", n)
			}
		}
		if v := r.URL.Query().Get("lead_id"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				add("lead_id", n)
			}
		}
		if v := r.URL.Query().Get("contact_id"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				add("contact_id", n)
			}
		}
		if v := strings.TrimSpace(r.URL.Query().Get("cif")); v != "" {
			add("cif", v)
		}
		if v := r.URL.Query().Get("application_id"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				add("application_id", n)
			}
		}
		if v := strings.TrimSpace(r.URL.Query().Get("phone")); v != "" {
			add("phone", normalizePhone(v))
		}
		if len(clauses) == 0 {
			respondErr(w, 400, "provide an anchor: lead_id, contact_id, cif, application_id or phone")
			return
		}

		// A task's status lives in crm_tasks, which is its system of record — the
		// activity row is only its shadow. Reading the live status back (rather than
		// the stamp written when the task was created) is why ticking a task off in
		// the CRM shows as done on the lead's timeline instead of sitting open for ever.
		rows, err := db.PGQuery(r.Context(), `
			SELECT a.id, a.type, a.direction, a.subject, a.body, a.outcome,
			       a.actor_name, a.actor_team, a.actor_user_id, a.target_team,
			       COALESCE(t.status, a.status) AS status,
			       a.metadata, a.occurred_at, a.created_at,
			       a.entity_type, a.entity_id, a.related_activity_id,
			       a.lead_id, a.contact_id, a.cif, a.application_id, a.ticket_id, a.call_id,
			       t.due_date AS due_at, t.priority AS task_priority, tu.full_name AS assignee_name
			  FROM app.activities a
			  LEFT JOIN crm_tasks t ON a.entity_type = 'crm_task'
			                       AND a.entity_id ~ '^[0-9]+$'
			                       AND t.id = a.entity_id::bigint
			  LEFT JOIN o3c_users tu ON tu.id = t.assigned_to
			 WHERE `+strings.Join(clauses, " OR ")+`
			 ORDER BY a.occurred_at DESC
			 LIMIT 200`, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load activities", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Anti-tipping-off: non-compliance viewers see a SAR only as a bare flag, no detail.
		if !viewerSeesSAR(core.UserFromCtx(r.Context())) {
			for _, row := range rows {
				if str(row["type"]) == "compliance_flag" {
					row["subject"] = "Compliance flag"
					row["body"] = nil
					row["outcome"] = nil
					row["metadata"] = nil
				}
			}
		}
		// The viewer travels with the list so the timeline can tell whether THIS user is
		// the team a hand-off is waiting on (and may answer it) without the frontend
		// keeping its own copy of teamFromRole, which would drift the day a role changes.
		u := core.UserFromCtx(r.Context())
		viewer := map[string]any{"user_id": int64(0), "team": ""}
		if u != nil {
			viewer = map[string]any{"user_id": u.ID, "team": teamFromRole(u.Role)}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "viewer": viewer}) //nolint:errcheck
	}
}

// activityCreate is the manual "Log activity" action from the lead detail / Customer 360.
func activityCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		LeadID        *int64         `json:"lead_id"`
		ContactID     *int64         `json:"contact_id"`
		CIF           string         `json:"cif"`
		ApplicationID *int64         `json:"application_id"`
		TicketID      *int64         `json:"ticket_id"`
		Phone         string         `json:"phone"`
		Type          string         `json:"type"`
		Direction     string         `json:"direction"`
		Subject       string         `json:"subject"`
		Body          string         `json:"body"`
		Outcome       string         `json:"outcome"`
		TargetTeam    string         `json:"target_team"`
		Status        string         `json:"status"`
		Metadata      map[string]any `json:"metadata"`
		OccurredAt    string         `json:"occurred_at"`
		// type=task only: a follow-up is a real crm_task, so it carries a when.
		DueAt    string `json:"due_at"`
		Priority string `json:"priority"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Type) == "" {
			respondErr(w, 400, "type is required")
			return
		}
		if b.LeadID == nil && b.ContactID == nil && strings.TrimSpace(b.CIF) == "" && b.ApplicationID == nil && strings.TrimSpace(b.Phone) == "" {
			respondErr(w, 400, "an activity needs at least one anchor (lead, contact, cif, application or phone)")
			return
		}
		u := core.UserFromCtx(r.Context())
		a := Activity{
			LeadID: b.LeadID, ContactID: b.ContactID, CIF: strings.TrimSpace(b.CIF), ApplicationID: b.ApplicationID,
			TicketID: b.TicketID, Phone: b.Phone, Type: strings.ToLower(strings.TrimSpace(b.Type)),
			Direction: b.Direction, Subject: b.Subject, Body: b.Body, Outcome: b.Outcome,
			TargetTeam: b.TargetTeam, Status: b.Status, Metadata: b.Metadata, Source: "manual",
		}
		if u != nil {
			a.ActorUserID = &u.ID
			a.ActorName = u.FullName
			a.ActorTeam = teamFromRole(u.Role)
		}
		if b.OccurredAt != "" {
			if t, err := time.Parse(time.RFC3339, b.OccurredAt); err == nil {
				a.OccurredAt = &t
			}
		}
		// A handoff is outstanding until the target team acts.
		if a.Type == "handoff" && strings.TrimSpace(a.Status) == "" {
			a.Status = "open"
		}

		// A follow-up has a home of its own: crm_tasks. Writing a task-shaped ACTIVITY
		// and stopping there was the old behaviour, and it produced a "task" with no
		// owner and no due date that no task list, no due-soon worker and no reminder
		// would ever see. Create the real task — owned by whoever raised it, due when
		// they said — and let the activity be its shadow, entity-linked so the timeline
		// reads the live status back instead of a copy that goes stale.
		//
		// It lives here rather than behind POST /api/crm/tasks because that route is
		// gated on CRM page access, which the call-centre agent working the lead does
		// not have; the follow-up is theirs, on their own lead. Same insert as
		// createTask in crm.go, minus the deal/assignee options this path doesn't offer.
		var taskID int64
		if a.Type == "task" {
			if u == nil {
				respondErr(w, 401, "sign in first")
				return
			}
			if strings.TrimSpace(a.Subject) == "" {
				respondErr(w, 400, "a follow-up needs a title")
				return
			}
			var linkedType *string
			var linkedID *int64
			if a.LeadID != nil && *a.LeadID > 0 {
				lt := "lead"
				linkedType, linkedID = &lt, a.LeadID
			}
			var due *string
			if s := strings.TrimSpace(b.DueAt); s != "" {
				due = &s
			}
			trows, terr := db.PGQuery(r.Context(), `
				INSERT INTO crm_tasks
				  (contact_id, title, description, due_date, priority, assigned_to, created_by, linked_type, linked_id)
				VALUES ($1,$2,NULLIF($3,''),$4,COALESCE(NULLIF($5,''),'medium'),$6,$7,$8,$9)
				RETURNING id`,
				a.ContactID, strings.TrimSpace(a.Subject), a.Body, due, strings.ToLower(strings.TrimSpace(b.Priority)),
				u.ID, u.ID, linkedType, linkedID)
			if terr != nil {
				respondErrLog(w, 500, "Could not create the follow-up", terr)
				return
			}
			if len(trows) > 0 {
				taskID = toInt64(trows[0]["id"])
			}
			a.Status = "open"
			a.TargetUserID = &u.ID
			a.EntityType, a.EntityID = "crm_task", strconv.FormatInt(taskID, 10)
		}

		id, err := LogActivity(r.Context(), db, a)
		if err != nil {
			respondErrLog(w, 500, "Could not log activity", err)
			return
		}
		// A hand-off that nobody is told about is a note with extra steps. Tell the
		// receiving team, and hand the count back so the sender sees whether it
		// actually reached anyone rather than a success toast either way.
		notified := 0
		if a.Type == "handoff" && strings.TrimSpace(a.TargetTeam) != "" {
			var actorID int64
			if u != nil {
				actorID = u.ID
			}
			notified = notifyHandoffRaised(context.WithoutCancel(r.Context()), db, a, actorID)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": id, "notified": notified, "task_id": taskID}) //nolint:errcheck
	}
}
