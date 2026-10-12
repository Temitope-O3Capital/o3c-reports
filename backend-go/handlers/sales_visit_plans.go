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

// ─────────────────────────────────────────────────────────────────────────────
// The officer's diary — what they intend to do, as opposed to what they did.
//
// Sales already had a calendar, but it looks backwards: TeamCalendar is a month of
// squares per officer derived from app.activities, and it answers "what did Tuesday
// actually look like for Justina". Useful to a head, no use to an officer on Monday
// morning deciding where to drive. There was nowhere in the app to write down an
// intention at all — the only forward-looking field was crm_contacts.next_action_at,
// one timestamp per lead, with no address, no kind and no room for two calls on one day.
//
// So plans live in their own table (migration 353) and completing one writes an
// activity through the normal path. The retrospective calendar keeps reading
// activities and stays truthful; this one reads plans. A planned visit never counts
// as a made visit, which it would if intentions were written into app.activities.
//
// The calendar feed deliberately returns BOTH plans and the follow-ups a lead already
// carries in next_action_at. An officer thinking about Thursday needs to see the lead
// they promised to ring on Thursday, and that promise is recorded by the disposition
// machinery, not by this table. Showing one without the other would make the calendar
// lie by omission, and it is why the follow-ups are tagged source:'follow_up' rather
// than copied into plans — nothing is duplicated, and the lead stays the one writer of
// its own next action.
// ─────────────────────────────────────────────────────────────────────────────

var visitPlanKinds = map[string]bool{"visit": true, "call": true, "meeting": true, "follow_up": true}

// RegisterSalesVisitPlans adds the planning diary.
func RegisterSalesVisitPlans(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")
	r.With(access).Get("/visit-plans", listVisitPlans(db))
	r.With(access).Post("/visit-plans", createVisitPlan(db))
	r.With(access).Patch("/visit-plans/{id}", updateVisitPlan(db))
	r.With(access).Post("/visit-plans/{id}/complete", completeVisitPlan(db))
	r.With(access).Delete("/visit-plans/{id}", cancelVisitPlan(db))
}

// visitPlanOfficer resolves whose diary this request is about, and refuses the ones the
// caller may not touch. Default is always the caller's own: an officer asking for "the
// calendar" means theirs, and a head must name an officer to see someone else's.
func visitPlanOfficer(r *http.Request, db *core.DB, u *core.Claims, want string) (int64, bool) {
	if u == nil || u.ID == 0 {
		return 0, false
	}
	id, _ := strconv.ParseInt(strings.TrimSpace(want), 10, 64)
	if id == 0 || id == u.ID {
		return u.ID, true
	}
	if u.CanSeeAllRows() {
		return id, true
	}
	for _, member := range teamHeadOfficerIDs(r, db, u.ID) {
		if member == id {
			return id, true
		}
	}
	return 0, false
}

// listVisitPlans is the calendar feed: every plan in the window, plus the lead
// follow-ups that fall in it.
func listVisitPlans(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		from, to := qstr(r, "from"), qstr(r, "to")
		if from == "" || to == "" {
			respondErr(w, 422, "from and to dates are required")
			return
		}

		// scope=team is the head's view: every diary they manage in one read. Without it
		// the supervisor page would fetch each officer separately — seven round trips to
		// answer one question, and a half-drawn week whenever one of them failed.
		if qstr(r, "scope") == "team" {
			ids := teamHeadOfficerIDs(r, db, u.ID)
			if len(ids) == 0 && u.CanSeeAllRows() {
				rows, _ := db.PGQuery(ctx, `
					SELECT DISTINCT m.user_id FROM app.sales_teams t
					  JOIN app.sales_team_members m ON m.team_id = t.id WHERE t.is_active
					UNION SELECT t.head_user_id FROM app.sales_teams t
					 WHERE t.is_active AND t.head_user_id IS NOT NULL`)
				for _, row := range rows {
					if id := toInt64(row["user_id"]); id != 0 {
						ids = append(ids, id)
					}
				}
			}
			if len(ids) == 0 {
				respondErr(w, 403, "You do not run a team")
				return
			}
			plans, err := db.PGQuery(ctx, `
				SELECT p.id, p.kind, p.planned_for, p.planned_at, p.status, p.title,
				       p.address, p.city, p.state, p.officer_id,
				       u.full_name AS officer_name,
				       btrim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name,
				       c.phone AS contact_phone, p.contact_id,
				       COALESCE(NULLIF(btrim(p.city),''),  c.city)  AS where_city,
				       COALESCE(NULLIF(btrim(p.state),''), c.state) AS where_state,
				       'plan'::text AS source
				  FROM app.sales_visit_plans p
				  JOIN app.o3c_users u ON u.id = p.officer_id
				  LEFT JOIN app.crm_contacts c ON c.id = p.contact_id
				 WHERE p.officer_id = ANY($1::bigint[])
				   AND p.planned_for BETWEEN $2::date AND $3::date
				 ORDER BY p.planned_for, u.full_name, p.planned_at NULLS LAST`,
				int64Array(ids), from, to)
			if err != nil {
				respondErrLog(w, 500, "Could not read the team diary", err)
				return
			}
			officers, _ := db.PGQuery(ctx, `
				SELECT id, full_name, COALESCE(app.sales_hub_for_office(office_location), '') AS hub
				  FROM app.o3c_users WHERE id = ANY($1::bigint[]) AND is_active
				 ORDER BY full_name`, int64Array(ids))
			respond(w, map[string]any{"scope": "team", "officers": officers, "plans": plans}, "pg")
			return
		}

		officer, ok := visitPlanOfficer(r, db, u, qstr(r, "officer_id"))
		if !ok {
			respondErr(w, 403, "That is not your diary")
			return
		}
		plans, err := db.PGQuery(ctx, `
			SELECT p.id, p.kind, p.planned_for, p.planned_at, p.status, p.title, p.notes,
			       p.address, p.city, p.state, p.outcome, p.completed_at,
			       p.contact_id, p.lead_id, p.officer_id,
			       btrim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name,
			       c.phone        AS contact_phone,
			       c.lead_stage   AS contact_stage,
			       COALESCE(NULLIF(btrim(p.city), ''),  c.city)  AS where_city,
			       COALESCE(NULLIF(btrim(p.state), ''), c.state) AS where_state,
			       'plan'::text AS source
			  FROM app.sales_visit_plans p
			  LEFT JOIN app.crm_contacts c ON c.id = p.contact_id
			 WHERE p.officer_id = $1
			   AND p.planned_for BETWEEN $2::date AND $3::date
			 ORDER BY p.planned_for, p.planned_at NULLS LAST, p.id`,
			officer, from, to)
		if err != nil {
			respondErrLog(w, 500, "Could not read the diary", err)
			return
		}
		// The lead's own next action, which the disposition machinery writes. Excluded
		// when a plan already covers that lead on that day, so an officer who planned
		// the follow-up does not see it twice.
		followUps, err := db.PGQuery(ctx, `
			SELECT c.id AS contact_id, c.next_action_at,
			       c.next_action_at::date AS planned_for,
			       btrim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name,
			       c.phone AS contact_phone, c.lead_stage AS contact_stage,
			       c.city AS where_city, c.state AS where_state,
			       'follow_up'::text AS source
			  FROM app.crm_contacts c
			 WHERE c.sales_owner_id = $1
			   AND c.next_action_at IS NOT NULL
			   AND c.next_action_at::date BETWEEN $2::date AND $3::date
			   AND c.lead_stage NOT IN ('converted', 'disqualified')
			   AND NOT EXISTS (
			       SELECT 1 FROM app.sales_visit_plans p
			        WHERE p.contact_id = c.id
			          AND p.officer_id = $1
			          AND p.planned_for = c.next_action_at::date
			          AND p.status = 'planned')
			 ORDER BY c.next_action_at`,
			officer, from, to)
		if err != nil {
			respondErrLog(w, 500, "Could not read the follow-ups", err)
			return
		}
		respond(w, map[string]any{
			"officer_id": officer,
			"plans":      plans,
			"follow_ups": followUps,
		}, "pg")
	}
}

type visitPlanBody struct {
	OfficerID  *int64 `json:"officer_id"`
	ContactID  *int64 `json:"contact_id"`
	LeadID     *int64 `json:"lead_id"`
	Kind       string `json:"kind"`
	PlannedFor string `json:"planned_for"`
	PlannedAt  string `json:"planned_at"`
	Title      string `json:"title"`
	Notes      string `json:"notes"`
	Address    string `json:"address"`
	City       string `json:"city"`
	State      string `json:"state"`
}

func createVisitPlan(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		if u == nil || u.ID == 0 {
			respondErr(w, 401, "Not authenticated")
			return
		}
		var b visitPlanBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		want := ""
		if b.OfficerID != nil {
			want = strconv.FormatInt(*b.OfficerID, 10)
		}
		officer, ok := visitPlanOfficer(r, db, u, want)
		if !ok {
			respondErr(w, 403, "You can only plan your own day, or your team's")
			return
		}
		kind := strings.ToLower(strings.TrimSpace(b.Kind))
		if kind == "" {
			kind = "visit"
		}
		if !visitPlanKinds[kind] {
			respondErr(w, 422, "kind must be visit, call, meeting or follow_up")
			return
		}
		if strings.TrimSpace(b.PlannedFor) == "" {
			respondErr(w, 422, "planned_for is required — a plan needs a day")
			return
		}
		// A plan has to be about somebody, for the same reason an activity does: it
		// becomes an activity when it is closed, and an activity attached to nobody is
		// work claimed against no record. It is also the only way the diary can know
		// WHERE the visit is — the address defaults from the lead.
		if b.ContactID == nil || *b.ContactID <= 0 {
			respondErr(w, 422, "Pick the lead or customer this is for. A diary entry attached to "+
				"nobody cannot carry an address, and closing it would log work against no record.")
			return
		}
		// A visit with no address is a plan nobody can act on, so the city and state are
		// taken from the lead when the officer has not typed them. This is the payoff for
		// carrying the location across in the first place.
		rows, err := db.PGQuery(ctx, `
			INSERT INTO app.sales_visit_plans
			  (officer_id, contact_id, lead_id, kind, planned_for, planned_at,
			   title, notes, address, city, state, created_by)
			SELECT $1, $2, $3, $4, $5::date, NULLIF($6, '')::timestamptz,
			       NULLIF(btrim($7), ''), NULLIF(btrim($8), ''),
			       COALESCE(NULLIF(btrim($9), ''),  c.address),
			       COALESCE(NULLIF(btrim($10), ''), c.city),
			       COALESCE(NULLIF(btrim($11), ''), c.state),
			       $12
			  FROM (SELECT 1) one
			  LEFT JOIN app.crm_contacts c ON c.id = $2
			ON CONFLICT (officer_id, contact_id, planned_for)
			   WHERE contact_id IS NOT NULL AND status = 'planned'
			DO UPDATE SET kind        = EXCLUDED.kind,
			              planned_at  = EXCLUDED.planned_at,
			              title       = COALESCE(EXCLUDED.title, app.sales_visit_plans.title),
			              notes       = COALESCE(EXCLUDED.notes, app.sales_visit_plans.notes),
			              address     = COALESCE(EXCLUDED.address, app.sales_visit_plans.address),
			              updated_at  = NOW()
			RETURNING *`,
			officer, b.ContactID, b.LeadID, kind, b.PlannedFor, strings.TrimSpace(b.PlannedAt),
			b.Title, b.Notes, b.Address, b.City, b.State, u.ID)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not save the plan", err)
			return
		}
		// Someone else putting work in your diary is worth telling you about; doing it
		// to your own diary is not.
		if officer != u.ID {
			notifyVisitPlanned(ctx, db, officer, u.FullName, kind, b.PlannedFor, toInt64(rows[0]["id"]))
		}
		w.WriteHeader(201)
		respond(w, rows[0], "pg")
	}
}

func updateVisitPlan(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		var b visitPlanBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		id := chi.URLParam(r, "id")
		owner, ok := visitPlanOwner(ctx, db, r, u, id)
		if !ok {
			respondErr(w, 404, "Plan not found")
			return
		}
		_ = owner
		q := `UPDATE app.sales_visit_plans SET updated_at = NOW()`
		var args []any
		n := 1
		add := func(frag string, v any) {
			q += fmt.Sprintf(frag, n)
			args = append(args, v)
			n++
		}
		if strings.TrimSpace(b.PlannedFor) != "" {
			add(", planned_for = $%d::date", b.PlannedFor)
		}
		if b.PlannedAt != "" {
			add(", planned_at = NULLIF($%d, '')::timestamptz", strings.TrimSpace(b.PlannedAt))
		}
		if k := strings.ToLower(strings.TrimSpace(b.Kind)); k != "" {
			if !visitPlanKinds[k] {
				respondErr(w, 422, "kind must be visit, call, meeting or follow_up")
				return
			}
			add(", kind = $%d", k)
		}
		if b.Title != "" {
			add(", title = $%d", strings.TrimSpace(b.Title))
		}
		if b.Notes != "" {
			add(", notes = $%d", strings.TrimSpace(b.Notes))
		}
		if b.Address != "" {
			add(", address = $%d", strings.TrimSpace(b.Address))
		}
		args = append(args, id)
		q += fmt.Sprintf(" WHERE id = $%d RETURNING *", n)
		rows, err := db.PGQuery(ctx, q, args...)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not update the plan", err)
			return
		}
		respond(w, rows[0], "pg")
	}
}

// visitPlanOwner checks the caller may act on this plan, returning its officer.
func visitPlanOwner(ctx context.Context, db *core.DB, r *http.Request, u *core.Claims, id string) (int64, bool) {
	rows, err := db.PGQuery(ctx, `SELECT officer_id FROM app.sales_visit_plans WHERE id = $1`, id)
	if err != nil || len(rows) == 0 {
		return 0, false
	}
	officer := toInt64(rows[0]["officer_id"])
	if _, ok := visitPlanOfficer(r, db, u, strconv.FormatInt(officer, 10)); !ok {
		return 0, false
	}
	return officer, true
}

// completeVisitPlan closes a plan and writes the activity it became.
//
// The activity is the point. Without it a completed plan would be invisible to the
// team calendar, the lead's timeline and every count of work done — the officer would
// have to log the same visit twice, and in practice would log it once, in whichever
// place nobody was reading.
func completeVisitPlan(db *core.DB) http.HandlerFunc {
	type body struct {
		Outcome string `json:"outcome"`
		Notes   string `json:"notes"`
		Status  string `json:"status"` // done (default) | missed
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		id := chi.URLParam(r, "id")
		if _, ok := visitPlanOwner(ctx, db, r, u, id); !ok {
			respondErr(w, 404, "Plan not found")
			return
		}
		status := strings.ToLower(strings.TrimSpace(b.Status))
		if status != "missed" {
			status = "done"
		}
		plans, err := db.PGQuery(ctx, `
			SELECT p.*, btrim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name
			  FROM app.sales_visit_plans p
			  LEFT JOIN app.crm_contacts c ON c.id = p.contact_id
			 WHERE p.id = $1`, id)
		if err != nil || len(plans) == 0 {
			respondErr(w, 404, "Plan not found")
			return
		}
		p := plans[0]
		var activityID any
		if status == "done" {
			kind := str(p["kind"])
			actType := kind
			if kind == "follow_up" {
				actType = "call" // a follow-up is a call unless the officer said otherwise
			}
			subject := str(p["title"])
			if subject == "" {
				subject = strings.ToUpper(kind[:1]) + kind[1:] + ": " + str(p["contact_name"])
			}
			notes := strings.TrimSpace(b.Notes)
			if notes == "" {
				notes = str(p["notes"])
			}
			act, aerr := db.PGQuery(ctx, `
				INSERT INTO app.activities
				  (actor_user_id, actor_name, actor_team, type, subject, body, outcome,
				   contact_id, occurred_at, source, metadata)
				VALUES ($1, (SELECT full_name FROM app.o3c_users WHERE id = $1), 'sales',
				        $2, $3, $4, NULLIF(btrim($5), ''), $6, NOW(), 'visit_plan',
				        jsonb_build_object('visit_plan_id', $7::bigint))
				RETURNING id`,
				u.ID, actType, subject, notes, b.Outcome, p["contact_id"], id)
			if aerr != nil || len(act) == 0 {
				respondErrLog(w, 500, "Could not record the visit", aerr)
				return
			}
			activityID = act[0]["id"]
			if cid := toInt64(p["contact_id"]); cid > 0 {
				db.PGExec(ctx, //nolint:errcheck
					`UPDATE app.crm_contacts SET last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`, cid)
			}
		}
		rows, err := db.PGExec(ctx, `
			UPDATE app.sales_visit_plans
			   SET status       = $2,
			       outcome      = COALESCE(NULLIF(btrim($3), ''), outcome),
			       notes        = COALESCE(NULLIF(btrim($4), ''), notes),
			       activity_id  = COALESCE($5, activity_id),
			       completed_at = NOW(),
			       updated_at   = NOW()
			 WHERE id = $1`, id, status, b.Outcome, b.Notes, activityID)
		if err != nil {
			respondErrLog(w, 500, "Could not close the plan", err)
			return
		}
		_ = rows
		respond(w, map[string]any{"ok": true, "status": status, "activity_id": activityID}, "pg")
	}
}

func cancelVisitPlan(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		if _, ok := visitPlanOwner(ctx, db, r, u, id); !ok {
			respondErr(w, 404, "Plan not found")
			return
		}
		// Cancelled rather than deleted: a day that was planned and then dropped is
		// information, and the unique index only guards 'planned' rows so the slot frees
		// up for a re-plan either way.
		if _, err := db.PGExec(ctx, `
			UPDATE app.sales_visit_plans
			   SET status = 'cancelled', updated_at = NOW()
			 WHERE id = $1`, id); err != nil {
			respondErrLog(w, 500, "Could not cancel the plan", err)
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

func notifyVisitPlanned(ctx context.Context, db *core.DB, officer int64, by, kind, day string, planID int64) {
	go Notify(context.WithoutCancel(ctx), db, NotifPayload{
		EventType: EvtVisitPlanned,
		UserID:    officer,
		Title:     "A " + kind + " Was Added to Your Diary",
		Body:      by + " planned a " + kind + " for you on " + day + ".",
		ActionURL: "/sales/calendar",
		EntityRef: fmt.Sprintf("sales_visit_plan:%d", planID),
		Priority:  "normal",
	})
}
