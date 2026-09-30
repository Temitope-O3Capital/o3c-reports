package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// The sales day: what an officer did, and how their head reads it.
//
// An officer's work is mostly outside the building — employer visits, calls, a customer
// met at a branch — and until this existed none of it was recorded anywhere. The only
// trace a day left was whatever happened to a LEAD, so an officer who spent the day on
// four employer visits that produced no lead that afternoon appeared to have done
// nothing, and their head had no way to know better.
//
// Two endpoints for the officer (log an activity, file the day's report) and two for the
// supervisor (the month grid, and one officer's day). See migration 307 for why the
// individual activities and the daily report are separate things.

// salesActivityTypes is what an officer may log. Deliberately short: a list long enough
// to need thought is a list people stop filling in honestly.
var salesActivityTypes = map[string]string{
	"visit":   "Visit",
	"call":    "Call",
	"meeting": "Meeting",
	"note":    "Note",
}

// ── Dispositions ─────────────────────────────────────────────────────────────
//
// What CAME OF the activity, as a controlled vocabulary rather than the free-text
// "Outcome" box this form used to carry. Free text cannot be counted, so a head could not
// answer "how many visits got past the gatekeeper this month" from 200 hand-typed
// outcomes, and two officers describing the same result wrote it two ways.
//
// A CALL DELIBERATELY REUSES THE CALL CENTRE'S CODES. A sales officer's phone call and an
// agent's phone call are the same act, so answered_interested / callback / no_answer /
// wrong_number mean the same thing and land in the same `outcome` column vocabulary
// (app.activities.outcome here, call_center_dispositions.outcome there). That is what makes
// "interested calls this month" answerable across both teams instead of per-team. Adding a
// sales-only synonym for a call outcome would silently split that number, so don't.
//
// Visits and meetings get their own codes because there is no call-centre equivalent — an
// agent never fails to get past a gatekeeper. Kept short on purpose: a list long enough to
// need thought is a list people stop filling in honestly.
type salesDisposition struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Hint  string `json:"hint"`
	// NeedsNote makes the write-up mandatory. Served to the form so the browser and the
	// server enforce the same rule rather than the browser alone.
	NeedsNote bool `json:"needs_note,omitempty"`
	// NeedsFollowUp means this outcome is meaningless without a date to come back on.
	// "They asked me to call back" with no callback date is how a lead is lost politely.
	NeedsFollowUp bool `json:"needs_follow_up,omitempty"`
	// Qualifies marks the one outcome that moves a linked lead to 'qualified'. Only a
	// stated interest qualifies a lead — a callback request does not. Kept in step with
	// the call centre's rule, which is the canonical one.
	Qualifies bool `json:"qualifies,omitempty"`
	// Closes marks outcomes that end the pursuit, so the form can warn before saving.
	Closes bool `json:"closes,omitempty"`
	// Advances is the lead stage this outcome puts the lead in. Empty means the outcome
	// decides nothing about the stage — "No Answer" is not progress, and leaving it blank
	// says so rather than inventing a movement.
	//
	// This is what makes the pipeline reachable at all. Before it, the only transition any
	// activity performed was new|contacted -> qualified; every lead arrives from the call
	// centre ALREADY qualified, so logging a call moved nothing. 172 leads sat at 'qualified'
	// and 13 at 'disqualified' with all four stages between them permanently empty, because
	// neither a code path nor a button could reach them.
	//
	// Movement is FORWARD ONLY, checked against leadStageOrder at the write: a "No Answer" on
	// a lead whose application is already submitted must not drag it back into conversation,
	// and a converted or disqualified lead is never moved by an activity at all.
	//
	// A closing outcome deliberately advances NOTHING. "Not interested" does not disqualify
	// the lead here — disqualification is irreversible from the officer's side, so it stays an
	// explicit act with a stated reason rather than a side effect of a dropdown.
	Advances string `json:"advances,omitempty"`
}

var salesDispositions = map[string][]salesDisposition{
	// Same codes as ccDispositions. See the note above before editing.
	"call": {
		{Code: "answered_interested", Label: "Answered — Interested", Qualifies: true,
			Advances: "handed_to_sales",
			Hint:     "They said yes in principle. This is what qualifies the lead."},
		{Code: "callback", Label: "Callback Requested", NeedsFollowUp: true,
			Advances: "handed_to_sales",
			Hint:     "They asked you to come back at a specific time."},
		{Code: "not_ready", Label: "Interested, Not Now", NeedsFollowUp: true,
			Advances: "handed_to_sales",
			Hint:     "Interested but not this cycle — stays in your queue for later."},
		{Code: "price_objection", Label: "Price Objection", NeedsNote: true,
			Advances: "handed_to_sales",
			Hint:     "Say what they objected to; it is the most useful thing you can record."},
		{Code: "documents_requested", Label: "Asked For Documents", NeedsFollowUp: true,
			Advances: "documents_requested",
			Hint:     "You asked them to send paperwork. Set the date you expect it."},
		// No stage: the phone rang out. Nothing was decided, so nothing moves.
		{Code: "no_answer", Label: "No Answer", Hint: "Rang out. Nothing decided."},
		{Code: "wrong_number", Label: "Wrong Number", Closes: true,
			Hint: "Not the person. The lead cannot be worked on this number."},
		{Code: "answered_not_interested", Label: "Answered — Not Interested", Closes: true, NeedsNote: true,
			Hint: "A clear no. Say why, so the next campaign does not repeat it."},
		{Code: "not_eligible", Label: "Not Eligible", Closes: true, NeedsNote: true,
			Hint: "They do not qualify for the product. Say which criterion."},
		{Code: "do_not_call", Label: "Asked Not To Be Contacted", Closes: true,
			Hint: "Suppresses them from future campaigns. Use only if they asked."},
	},
	"visit": {
		{Code: "visit_interested", Label: "Met Them — Interested", Qualifies: true,
			Advances: "handed_to_sales",
			Hint:     "You saw the decision maker and they said yes in principle."},
		{Code: "visit_met_no_decision", Label: "Met Them — No Decision", NeedsFollowUp: true,
			Advances: "handed_to_sales",
			Hint:     "You got in front of them but nothing was settled."},
		// No stage: never reached the decision maker, so the lead has not moved even though
		// the officer's day has. The visit is still recorded as work done.
		{Code: "visit_gatekeeper", Label: "Did Not Get Past Reception", NeedsFollowUp: true,
			Hint: "Never reached the decision maker. Worth another attempt."},
		{Code: "visit_documents", Label: "Collected Documents",
			Advances: "documents_requested",
			Hint:     "You came away with paperwork the application needs."},
		{Code: "visit_closed", Label: "Premises Closed",
			Hint: "Nobody there. Not a refusal."},
		{Code: "visit_not_interested", Label: "Met Them — Not Interested", Closes: true, NeedsNote: true,
			Hint: "A clear no in person. Say why."},
	},
	"meeting": {
		{Code: "meeting_interested", Label: "Interested", Qualifies: true,
			Advances: "handed_to_sales",
			Hint:     "They committed in principle."},
		{Code: "meeting_proposal", Label: "Wants A Proposal", NeedsFollowUp: true,
			Advances: "handed_to_sales",
			Hint:     "Asked for something in writing. Set the date you will send it."},
		{Code: "meeting_documents", Label: "Asked For Documents", NeedsFollowUp: true,
			Advances: "documents_requested",
			Hint:     "You asked them for paperwork. Set the date you expect it."},
		{Code: "meeting_deferred", Label: "Deferred", NeedsFollowUp: true,
			Advances: "handed_to_sales",
			Hint:     "Parked for now, with a date to return to it."},
		{Code: "meeting_not_interested", Label: "Not Interested", Closes: true, NeedsNote: true,
			Hint: "They declined. Say why."},
	},
	// A note has no outcome: it is the record itself, not the result of an attempt.
	"note": {},
}

// findSalesDisposition returns the disposition for a kind, and whether it is valid for it.
// Scoping by kind is the point: "Did Not Get Past Reception" must not be selectable on a
// phone call, and a form that offers it is a form that will eventually record it.
func findSalesDisposition(kind, code string) (salesDisposition, bool) {
	for _, d := range salesDispositions[kind] {
		if d.Code == code {
			return d, true
		}
	}
	return salesDisposition{}, false
}

// listSalesDispositions serves the vocabulary to the form.
//
// Sales cannot read /api/call-center/dispositions — that whole route group is gated on the
// call_center page, which no sales role holds — so the codes have to be served here. They
// are the same codes for a call; see the note on salesDispositions.
func listSalesDispositions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": salesDispositions}) //nolint:errcheck
	}
}

func RegisterSalesActivity(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")

	// The officer's own day.
	r.With(access).Post("/activity", logSalesActivity(db))
	r.With(access).Get("/activity/dispositions", listSalesDispositions())
	r.With(access).Get("/my-day", getMyDay(db))
	r.With(access).Put("/my-day/report", upsertDailyReport(db))

	// The supervisor's view. Gated on sales_team, the supervision key — an officer must
	// not be able to read their colleagues' days by calling the endpoint directly.
	sup := core.RequirePages("sales_team")
	r.With(sup).Get("/team-days", teamDays(db))
	r.With(sup).Get("/team-days/{officerID}/{day}", officerDay(db))
}

// logSalesActivity records one thing the officer did.
//
// Writes to app.activities rather than a sales-only table, so a visit logged against a
// lead appears on that lead's timeline next to the call centre's calls — the Leads
// drawer reads exactly this stream. A separate table would have split one lead's history
// across two places.
func logSalesActivity(db *core.DB) http.HandlerFunc {
	type body struct {
		Type    string `json:"type"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
		// Disposition is the controlled code (see salesDispositions). Outcome is kept for
		// the older callers that still send free text; when a disposition is given it is
		// what lands in the outcome column, because a counted vocabulary beats prose.
		Disposition string `json:"disposition"`
		Outcome     string `json:"outcome"`
		Location    string `json:"location"`
		ContactID   *int64 `json:"contact_id"`
		CIF         string `json:"cif"`
		// Optional: when it happened, if logging after the fact at the end of the day.
		OccurredAt string `json:"occurred_at"`
		// When to come back to this lead. Required by the dispositions that mean
		// "not now" — see NeedsFollowUp.
		FollowUpAt string `json:"follow_up_at"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil || user.ID == 0 {
			respondErr(w, 401, "Not authenticated")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.Type = strings.ToLower(strings.TrimSpace(b.Type))
		if _, ok := salesActivityTypes[b.Type]; !ok {
			respondErr(w, 400, "Choose what kind of activity this was: a visit, a call, a meeting or a note")
			return
		}
		b.Subject = strings.TrimSpace(b.Subject)
		if b.Subject == "" {
			respondErr(w, 400, "Say briefly what this was — it is what the entry reads as on your day")
			return
		}

		// The disposition, and the two rules it carries. Validated server-side as well as
		// in the form: a rule enforced only in the browser is a rule that is not enforced.
		var disp salesDisposition
		hasDisp := false
		if code := strings.TrimSpace(b.Disposition); code != "" {
			d, ok := findSalesDisposition(b.Type, code)
			if !ok {
				respondErr(w, 422, "That outcome does not belong to a "+salesActivityTypes[b.Type]+
					". Pick one from the list.")
				return
			}
			disp, hasDisp = d, true
			if disp.NeedsNote && strings.TrimSpace(b.Body) == "" {
				respondErr(w, 422, "\""+disp.Label+"\" needs a note saying why — that is the "+
					"part anyone reading this later actually needs.")
				return
			}
			// A follow-up outcome with no date is the failure this rule exists to stop: the
			// officer records "they asked me to call back", nothing schedules it, and the
			// lead goes quiet. Only enforced when a lead is linked, since next_action_at
			// lives on the lead and there is nowhere to put the date otherwise.
			if disp.NeedsFollowUp && b.ContactID != nil && *b.ContactID > 0 &&
				strings.TrimSpace(b.FollowUpAt) == "" {
				respondErr(w, 422, "\""+disp.Label+"\" needs a date to come back on.")
				return
			}
			// The disposition IS the outcome. Free text loses to a counted code.
			b.Outcome = disp.Code
		}

		// Backdating is allowed (an officer logs the day's visits that evening) but only
		// within a week, and never into the future. Without the bound, a mistyped year
		// parks the activity in 2025 where nobody will see it again, or in 2027 where it
		// sits at the top of every day's list for ever.
		occurred := "now()"
		args := []any{user.ID, b.Type, b.Subject, nullIfEmpty(b.Body), nullIfEmpty(b.Outcome), b.ContactID, nullIfEmpty(strings.TrimSpace(b.CIF))}
		if s := strings.TrimSpace(b.OccurredAt); s != "" {
			t, err := time.Parse(time.RFC3339, s)
			if err != nil {
				respondErr(w, 400, "occurred_at must be an RFC3339 timestamp")
				return
			}
			if t.After(time.Now().Add(2 * time.Minute)) {
				respondErr(w, 400, "That is in the future — log what happened, not what is planned")
				return
			}
			if t.Before(time.Now().AddDate(0, 0, -7)) {
				respondErr(w, 400, "That is more than a week ago. Ask your head to record it if it still needs to go on the record")
				return
			}
			occurred = fmt.Sprintf("$%d", len(args)+1)
			args = append(args, t)
		}

		// metadata carries the location for a visit. A dedicated column would be empty on
		// three of the four types; the jsonb column already exists for exactly this.
		var meta any
		if loc := strings.TrimSpace(b.Location); loc != "" {
			meta = fmt.Sprintf(`{"location":%s}`, mustJSONString(loc))
		}
		args = append(args, meta)

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.activities
			  (actor_user_id, actor_name, actor_team, type, subject, body, outcome,
			   contact_id, cif, occurred_at, source, metadata)
			VALUES ($1, (SELECT full_name FROM app.o3c_users WHERE id=$1), 'sales',
			        $2, $3, $4, $5, $6, $7, `+occurred+`, 'manual', $`+fmt.Sprint(len(args))+`::jsonb)
			RETURNING id, occurred_at`, args...)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not record the activity", err)
			return
		}

		// Keep the lead's own freshness in step, so an activity logged against a lead
		// stops it showing as stalled. Without this an officer could visit a customer
		// weekly and the lead would still appear on the "untouched for a fortnight"
		// worklist, which is the exact thing that makes people distrust a worklist.
		moved := ""
		if b.ContactID != nil && *b.ContactID > 0 {
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE app.crm_contacts SET last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
				*b.ContactID)

			// The follow-up date the disposition demanded, parked where the queue reads it.
			if fu := strings.TrimSpace(b.FollowUpAt); fu != "" {
				if t, err := time.Parse(time.RFC3339, fu); err == nil {
					db.PGExec(r.Context(), //nolint:errcheck
						`UPDATE app.crm_contacts SET next_action_at = $2, updated_at = NOW() WHERE id = $1`,
						*b.ContactID, t)
				}
			}

			// The outcome moves the lead. See salesDisposition.Advances for why this exists
			// and why a closing outcome moves nothing.
			//
			// Forward only, and the comparison is what enforces it: the target must outrank
			// the current stage in leadStageOrder, which is the same ladder the rest of the
			// module uses. isOpenLeadStage keeps converted and disqualified leads untouched,
			// so a stray call logged against a booked customer cannot reopen them.
			//
			// The move is written to crm_lead_events in the same breath, because a stage that
			// changes with no record of what changed it is exactly the thing the timeline
			// exists to answer.
			if hasDisp && disp.Advances != "" {
				if to, ok := advanceLeadStage(r.Context(), db, *b.ContactID, disp.Advances, user.ID, disp.Label); ok {
					moved = to
				}
			}
		}
		out := map[string]any{
			"ok": true, "id": toInt64(rows[0]["id"]), "occurred_at": rows[0]["occurred_at"],
		}
		if moved != "" {
			out["moved"] = moved
		}
		respond(w, out, "pg")
	}
}

// mustJSONString quotes a string for embedding in a JSON literal.
func mustJSONString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// getMyDay returns the officer's own day: what they have logged, and their report if they
// have started one. ?day=YYYY-MM-DD for a past day; defaults to today in Lagos time.
//
// Lagos, not UTC: at 1am Lagos the UTC date is still yesterday, so a UTC "today" would
// show an officer the wrong day's work for the first hour of every morning.
func getMyDay(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil || user.ID == 0 {
			respondErr(w, 401, "Not authenticated")
			return
		}
		day, err := validDate(r, "day")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dayExpr := "(now() AT TIME ZONE 'Africa/Lagos')::date"
		args := []any{user.ID}
		if day != "" {
			dayExpr = "$2::date"
			args = append(args, day)
		}

		acts, _ := db.PGQuery(r.Context(), `
			SELECT id, type, subject, body, outcome, contact_id, cif, occurred_at,
			       metadata->>'location' AS location,
			       (SELECT NULLIF(TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')),'')
			          FROM app.crm_contacts c WHERE c.id = a.contact_id) AS contact_name
			  FROM app.activities a
			 WHERE a.actor_user_id = $1 AND COALESCE(a.actor_team,'') = 'sales'
			   AND (a.occurred_at AT TIME ZONE 'Africa/Lagos')::date = `+dayExpr+`
			 ORDER BY a.occurred_at DESC`, args...)

		report, _ := db.PGQuery(r.Context(), `
			SELECT id, report_date, summary, plan, submitted_at
			  FROM app.sales_daily_reports
			 WHERE officer_id = $1 AND report_date = `+dayExpr, args...)

		var rep any
		if len(report) > 0 {
			rep = report[0]
		}
		if acts == nil {
			acts = []map[string]any{}
		}

		// The day's report, DERIVED from what was logged rather than typed again.
		//
		// Asking an officer to write an end-of-day summary after they have already logged
		// every visit and call is asking them to type the same day twice, and the second
		// telling is the one that gets skipped — which is why sales_daily_reports has never
		// held a row. The activity IS the report. This counts what happened, so the
		// supervisor's calendar can turn green off real work instead of off a form
		// somebody remembered to submit.
		//
		// The free-text report is not removed: a genuine end-of-day note ("branch flooded,
		// lost the afternoon") is worth having and cannot be derived. It is now optional
		// commentary on top of a summary that always exists.
		summary, _ := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                                      AS logged,
			  COUNT(*) FILTER (WHERE a.type = 'visit')                      AS visits,
			  COUNT(*) FILTER (WHERE a.type = 'call')                       AS calls,
			  COUNT(*) FILTER (WHERE a.type = 'meeting')                    AS meetings,
			  COUNT(*) FILTER (WHERE a.type = 'note')                       AS notes,
			  COUNT(DISTINCT a.contact_id) FILTER (WHERE a.contact_id IS NOT NULL) AS leads_touched,
			  -- Qualifying outcomes across all three kinds, so "did today produce
			  -- anything" is answerable without reading the list.
			  COUNT(*) FILTER (WHERE a.outcome IN
			      ('answered_interested','visit_interested','meeting_interested'))  AS interested,
			  COUNT(*) FILTER (WHERE a.outcome IN
			      ('answered_not_interested','visit_not_interested','meeting_not_interested',
			       'not_eligible','wrong_number','do_not_call'))              AS closed_out,
			  MIN(a.occurred_at)                                            AS first_at,
			  MAX(a.occurred_at)                                            AS last_at
			  FROM app.activities a
			 WHERE a.actor_user_id = $1 AND COALESCE(a.actor_team,'') = 'sales'
			   AND (a.occurred_at AT TIME ZONE 'Africa/Lagos')::date = `+dayExpr, args...)

		var derived any
		if len(summary) > 0 {
			derived = summary[0]
		}
		respond(w, map[string]any{
			"activities": acts,
			"report":     rep,
			"derived":    derived,
		}, "pg")
	}
}

// upsertDailyReport saves or submits the officer's account of their day.
//
// A draft (submit=false) can be saved repeatedly through the day; submitting stamps
// submitted_at, which is what a head's calendar marks green. Re-submitting an already
// submitted day updates the text and keeps the ORIGINAL submitted_at — the interesting
// fact is when the officer signed the day off, not when they last corrected a typo.
func upsertDailyReport(db *core.DB) http.HandlerFunc {
	type body struct {
		Day     string `json:"day"`
		Summary string `json:"summary"`
		Plan    string `json:"plan"`
		Submit  bool   `json:"submit"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil || user.ID == 0 {
			respondErr(w, 401, "Not authenticated")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// Either field alone is a legitimate note. This used to demand a summary whenever
		// Submit was set, which blocked the commonest real note after a quiet day — a plan
		// for tomorrow with nothing to report about today. The day itself no longer depends
		// on this record existing (the summary is derived from the activities), so the only
		// thing worth refusing is an entirely empty write.
		if strings.TrimSpace(b.Summary) == "" && strings.TrimSpace(b.Plan) == "" {
			respondErr(w, 400, "There is nothing to save — write a note or a plan first")
			return
		}

		dayExpr := "(now() AT TIME ZONE 'Africa/Lagos')::date"
		args := []any{user.ID, strings.TrimSpace(b.Summary), strings.TrimSpace(b.Plan), b.Submit}
		if s := strings.TrimSpace(b.Day); s != "" {
			dayExpr = "$5::date"
			args = append(args, s)
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.sales_daily_reports (officer_id, report_date, summary, plan, submitted_at)
			VALUES ($1, `+dayExpr+`, $2, $3, CASE WHEN $4 THEN now() END)
			ON CONFLICT (officer_id, report_date) DO UPDATE
			   SET summary      = EXCLUDED.summary,
			       plan         = EXCLUDED.plan,
			       -- COALESCE keeps the first submission's timestamp.
			       submitted_at = COALESCE(app.sales_daily_reports.submitted_at, EXCLUDED.submitted_at),
			       updated_at   = now()
			RETURNING id, report_date, submitted_at`, args...)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not save the report", err)
			return
		}
		respond(w, rows[0], "pg")
	}
}

// teamDays is the supervisor's month grid: for every officer they oversee, what each day
// of the month holds. This is the "calendar view where a submitted day shows green".
//
// Scoped to the caller's own team. A head sees their officers; management sees everyone.
// Without the scope a head could read another team's floor by calling the endpoint.
func teamDays(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Not authenticated")
			return
		}
		from, err := validDate(r, "from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		to, err := validDate(r, "to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		// Default to the current month in Lagos time.
		if from == "" {
			from = time.Now().Format("2006-01") + "-01"
		}
		if to == "" {
			to = time.Now().Format("2006-01-02")
		}

		// Which officers this caller may see. teamHeadOfficerIDs returns the members of
		// every team they head (including themselves); empty means they head none, in
		// which case management sees all and anyone else sees only their own day.
		ids := teamHeadOfficerIDs(r, db, user.ID)
		scope := "TRUE"
		args := []any{from, to}
		switch {
		case len(ids) > 0:
			scope = "d.officer_id = ANY($3)"
			args = append(args, ids)
		case user.CanSeeAllRows():
			// management: every officer
		default:
			scope = "d.officer_id = $3"
			args = append(args, user.ID)
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT d.officer_id, u.full_name AS officer_name, u.role,
			       d.day, d.activities, d.visits, d.calls, d.meetings, d.notes,
			       d.contacts_touched, d.last_activity_at,
			       d.report_submitted, d.submitted_at
			  FROM app.v_sales_officer_days d
			  JOIN app.o3c_users u ON u.id = d.officer_id
			 WHERE d.day BETWEEN $1::date AND $2::date
			   AND u.deleted_at IS NULL
			   AND `+scope+`
			 ORDER BY u.full_name, d.day`, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load the team calendar", err)
			return
		}

		// The roster is returned alongside the days so the grid can render a row for an
		// officer who logged NOTHING all month. Deriving the rows from the day records
		// would make exactly those officers invisible — and an officer with no activity
		// at all is the single most important thing this page has to show.
		roster, _ := db.PGQuery(r.Context(), `
			SELECT u.id, u.full_name, u.role
			  FROM app.o3c_users u
			 WHERE u.deleted_at IS NULL AND u.is_active AND (`+salesOfficerPredicate+`)
			   AND `+strings.Replace(scope, "d.officer_id", "u.id", 1)+`
			 ORDER BY u.full_name`, args[2:]...)

		if rows == nil {
			rows = []map[string]any{}
		}
		if roster == nil {
			roster = []map[string]any{}
		}
		respond(w, map[string]any{
			"days": rows, "officers": roster, "from": from, "to": to,
		}, "pg")
	}
}

// officerDay is one officer's day in full, opened from the calendar: their report and
// every activity behind the count.
func officerDay(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Not authenticated")
			return
		}
		officerID := toInt64FromStr(chi.URLParam(r, "officerID"))
		day := chi.URLParam(r, "day")
		if officerID == 0 || day == "" {
			respondErr(w, 400, "Officer and day are both required")
			return
		}
		if _, err := time.Parse("2006-01-02", day); err != nil {
			respondErr(w, 400, "day must be YYYY-MM-DD")
			return
		}

		// Same scope rule as the grid, applied to this one officer. The grid hiding a
		// name is not access control — this endpoint takes an officer id from the caller.
		if ids := teamHeadOfficerIDs(r, db, user.ID); len(ids) > 0 {
			ok := false
			for _, id := range ids {
				if id == officerID {
					ok = true
					break
				}
			}
			if !ok {
				respondErr(w, 403, "That officer is not on your team")
				return
			}
		} else if !user.CanSeeAllRows() && officerID != user.ID {
			respondErr(w, 403, "You can only open your own day")
			return
		}

		var report any
		if rows, _ := db.PGQuery(r.Context(), `
			SELECT id, report_date, summary, plan, submitted_at, updated_at
			  FROM app.sales_daily_reports
			 WHERE officer_id = $1 AND report_date = $2::date`, officerID, day); len(rows) > 0 {
			report = rows[0]
		}

		acts, _ := db.PGQuery(r.Context(), `
			SELECT a.id, a.type, a.subject, a.body, a.outcome, a.occurred_at,
			       a.metadata->>'location' AS location,
			       a.contact_id,
			       NULLIF(TRIM(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')),'') AS contact_name
			  FROM app.activities a
			  LEFT JOIN app.crm_contacts c ON c.id = a.contact_id
			 WHERE a.actor_user_id = $1 AND COALESCE(a.actor_team,'') = 'sales'
			   AND (a.occurred_at AT TIME ZONE 'Africa/Lagos')::date = $2::date
			 ORDER BY a.occurred_at`, officerID, day)
		if acts == nil {
			acts = []map[string]any{}
		}

		var name sql.NullString
		_ = db.PG.QueryRowContext(r.Context(),
			`SELECT full_name FROM app.o3c_users WHERE id=$1`, officerID).Scan(&name)

		respond(w, map[string]any{
			"officer_id": officerID, "officer_name": name.String, "day": day,
			"report": report, "activities": acts,
		}, "pg")
	}
}

// advanceLeadStage moves a lead forward to `to` and records why, returning the stage it
// landed on. It is a no-op — reporting false — when the lead is already at or past that
// stage, when it is converted or disqualified, or when the lead simply does not exist.
//
// Forward-only is the whole contract. The officer picks an outcome describing what just
// happened; they are not choosing a stage, and they must not be able to walk a lead backwards
// by logging a late call against it. leadStageOrder is the single ladder both this and
// advanceLeadOnApplication measure against, so the two cannot disagree about what "forward"
// means.
//
// Best-effort by design: the activity has already been written and committed by the time this
// runs, and an activity that saved is worth more than a stage that did not. A failure here is
// logged and swallowed rather than failing the officer's save and losing their write-up.
func advanceLeadStage(ctx context.Context, db *core.DB, contactID int64, to string, actorID int64, why string) (string, bool) {
	rank, known := leadStageOrder[to]
	if !known {
		slog.Error("advanceLeadStage: unknown target stage", "stage", to, "contact", contactID)
		return "", false
	}

	rows, err := db.PGQuery(ctx,
		`SELECT lead_stage FROM app.crm_contacts WHERE id = $1 AND sales_entered_at IS NOT NULL`, contactID)
	if err != nil || len(rows) == 0 {
		return "", false
	}
	current := str(rows[0]["lead_stage"])
	if !isOpenLeadStage(current) || leadStageOrder[current] >= rank {
		return "", false
	}

	// qualified_at is stamped when the lead passes 'qualified', not only when it lands on it:
	// an outcome that takes a lead straight from 'contacted' to 'handed_to_sales' has still
	// established that the customer is interested, and the reports keyed on qualified_at would
	// otherwise never see it.
	res, err := db.PGExec(ctx, `
		UPDATE app.crm_contacts
		   SET lead_stage       = $2,
		       stage_changed_at = NOW(),
		       qualified_at     = COALESCE(qualified_at, NOW()),
		       last_activity_at = NOW(),
		       updated_at       = NOW()
		 WHERE id = $1 AND lead_stage = $3`, contactID, to, current)
	if err != nil {
		slog.Error("advanceLeadStage: stage not moved", "contact", contactID, "to", to, "err", err)
		return "", false
	}
	// Re-read the current stage in the WHERE above rather than trusting the earlier SELECT:
	// two officers logging against the same lead at once would otherwise both write, and the
	// later one could land a lower stage. Zero rows here means somebody else moved first.
	if aff, _ := res.RowsAffected(); aff == 0 {
		return "", false
	}

	if _, err := db.PGExec(ctx, `
		INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
		VALUES ($1, 'stage_change', $2, $3, $4, $5)`,
		contactID, current, to, nullIfEmpty(why), actorID); err != nil {
		slog.Error("advanceLeadStage: stage moved but NOT recorded", "contact", contactID,
			"from", current, "to", to, "err", err)
	}
	return to, true
}
