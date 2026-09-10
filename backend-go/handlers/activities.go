package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

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
		   target_team, target_user_id, status, related_activity_id, metadata, source, occurred_at)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,NULLIF($7,''),
		        $8,NULLIF($9,''),NULLIF($10,''),$11,NULLIF($12,''),NULLIF($13,''),NULLIF($14,''),NULLIF($15,''),
		        NULLIF($16,''),$17,NULLIF($18,''),$19,$20::jsonb,$21,$22)
		RETURNING id`,
		a.LeadID, a.ContactID, a.CIF, a.ApplicationID, a.TicketID, a.CallID, phone,
		a.ActorUserID, a.ActorName, a.ActorTeam, a.Type, a.Direction, a.Subject, a.Body, a.Outcome,
		a.TargetTeam, a.TargetUserID, a.Status, a.RelatedID, meta, a.Source, occurred)
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
}

// activityList returns activities for a person, matched by any anchor supplied as a query
// param (lead_id, contact_id, cif, application_id, phone). Multiple anchors widen the match
// (OR) so a lead can be found by its id AND its phone.
func activityList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var clauses []string
		var args []any
		add := func(col string, v any) { args = append(args, v); clauses = append(clauses, fmt.Sprintf("a.%s = $%d", col, len(args))) }

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

		rows, err := db.PGQuery(r.Context(), `
			SELECT a.id, a.type, a.direction, a.subject, a.body, a.outcome,
			       a.actor_name, a.actor_team, a.target_team, a.status,
			       a.metadata, a.occurred_at, a.created_at,
			       a.lead_id, a.contact_id, a.cif, a.application_id, a.ticket_id, a.call_id
			  FROM app.activities a
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
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
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
		id, err := LogActivity(r.Context(), db, a)
		if err != nil {
			respondErrLog(w, 500, "Could not log activity", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": id}) //nolint:errcheck
	}
}
