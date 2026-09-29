package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
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

func RegisterSalesActivity(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")

	// The officer's own day.
	r.With(access).Post("/activity", logSalesActivity(db))
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
		Type      string `json:"type"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
		Outcome   string `json:"outcome"`
		Location  string `json:"location"`
		ContactID *int64 `json:"contact_id"`
		CIF       string `json:"cif"`
		// Optional: when it happened, if logging after the fact at the end of the day.
		OccurredAt string `json:"occurred_at"`
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
		if b.ContactID != nil && *b.ContactID > 0 {
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE app.crm_contacts SET last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
				*b.ContactID)
		}
		respond(w, map[string]any{
			"ok": true, "id": toInt64(rows[0]["id"]), "occurred_at": rows[0]["occurred_at"],
		}, "pg")
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
		respond(w, map[string]any{"activities": acts, "report": rep}, "pg")
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
		if b.Submit && strings.TrimSpace(b.Summary) == "" {
			respondErr(w, 400, "Write a line about the day before submitting it")
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
