package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Daily Reports — what the sales floor actually did on a given day, written out to be READ.
//
// WHY THIS IS NOT THE TEAM CALENDAR. TeamCalendar is a month grid of coloured squares: it
// answers "did this person work" and stops there. A green square cannot tell the MD what the
// officer did, which customer they saw, or what came of it — and that is the whole question.
// This endpoint composes the day into prose-ready detail: every visit with where it was,
// every call with its outcome, every lead that moved, and the officer's own note on top.
//
// WHY THE DAY IS COMPOSED RATHER THAN SUBMITTED. app.sales_daily_reports has never held a
// single row, and the field was made optional on purpose — asking an officer to write up a
// day they have already logged is asking them to type it twice, and the second telling is the
// one that gets skipped. So the report IS the activity, and the officer's note is commentary
// on it rather than permission for it to count.
//
// THE FOUR STATES OF A DAY, AND WHY THEY MUST NEVER BE ONE NUMBER. "Worked", "quiet", "away"
// and "no access" demand completely different responses from a reader, and collapsing them
// into one count is how a management page starts lying. Away comes from app.is_unavailable
// (the single availability predicate) and "not a working day" from app.business_calendar,
// which already carries declared public holidays — so a holiday can never render as a missed
// day. TeamCalendar dims weekends with a raw JavaScript day-of-week test and consults neither,
// which is exactly the bug this avoids: on 24 Aug and 28 Sep it showed the whole floor idle.

type dailyEntry struct {
	Type       string `json:"type"`
	Subject    string `json:"subject"`
	Body       string `json:"body,omitempty"`
	Outcome    string `json:"outcome,omitempty"`
	Location   string `json:"location,omitempty"`
	CustomerID *int64 `json:"customer_id,omitempty"`
	Customer   string `json:"customer,omitempty"`
	At         string `json:"at"`
}

type dailyOfficer struct {
	OfficerID   int64        `json:"officer_id"`
	Name        string       `json:"officer_name"`
	Role        string       `json:"role"`
	Office      string       `json:"office"`
	State       string       `json:"state"` // worked | quiet | away | no_access
	Activities  int64        `json:"activities"`
	Visits      int64        `json:"visits"`
	Calls       int64        `json:"calls"`
	Meetings    int64        `json:"meetings"`
	Notes       int64        `json:"notes"`
	Emails      int64        `json:"emails"`
	Moves       int64        `json:"moves"`
	Customers   int64        `json:"customers_touched"`
	LiveLeads   int64        `json:"live_leads"`
	Overdue     int64        `json:"overdue_followups"`
	OwnNote     string       `json:"own_note,omitempty"`
	OwnPlan     string       `json:"own_plan,omitempty"`
	LastAt      string       `json:"last_activity_at,omitempty"`
	WorkingDay  bool         `json:"working_day"`
	Entries     []dailyEntry `json:"entries"`
	NoteCount   int64        `json:"note_count"`
	OpenThreads int64        `json:"open_threads"`
}

// RegisterSalesDailyReports mounts the reading view. Gated on sales_team, the supervision
// key — the same one the floor view and the management desk use, so a reader who can open
// one can open all three. withStructuralPages grants it at login to whoever heads an active
// team, which is why the two teams headed by officers rather than sales_heads are not
// stranded; and the COO now holds it explicitly, having previously been able to see the
// Sales figure on the Overview while the module behind it answered 403.
func RegisterSalesDailyReports(r chi.Router, db *core.DB) {
	sup := core.RequirePages("sales_team")
	r.With(sup).Get("/daily-reports", salesDailyReports(db))
}

func salesDailyReports(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "sign in first")
			return
		}

		// Default to yesterday, not today. A day read at 10am is half a day, and an officer
		// judged on it looks idle for the ordinary reason that the morning is not over.
		day := time.Now().AddDate(0, 0, -1)
		if s := strings.TrimSpace(r.URL.Query().Get("date")); s != "" {
			if d, err := time.Parse("2006-01-02", s); err == nil {
				day = d
			} else {
				respondErr(w, 400, "date must be YYYY-MM-DD")
				return
			}
		}
		if day.After(time.Now()) {
			respondErr(w, 422, "That day has not happened yet.")
			return
		}
		ds := day.Format("2006-01-02")

		// Scope. Management reads the floor; a team head reads their team. Keyed on team
		// headship rather than the sales_head role, because two of the four teams are
		// headed by officers whose role is sales_officer.
		mode, ids := salesLeadScope(r, db, u)
		scope := ""
		args := []any{ds}
		switch mode {
		case scopeTeam:
			scope = " AND u.id = ANY($2)"
			args = append(args, ids)
		case scopeOwn:
			scope = " AND u.id = $2"
			args = append(args, u.ID)
		}

		rows, err := db.PGQuery(r.Context(), `
			WITH d AS (SELECT $1::date AS the_day),
			working AS (SELECT (app.leave_working_days(d.the_day, d.the_day) > 0) AS is_working FROM d)
			SELECT u.id, u.full_name, u.role, COALESCE(u.office_location, '') AS office,
			       (u.last_login IS NULL)                      AS never_signed_in,
			       app.is_unavailable(u.id, d.the_day)         AS away,
			       working.is_working                          AS working_day,
			       COALESCE(v.activities, 0) AS activities, COALESCE(v.visits, 0)   AS visits,
			       COALESCE(v.calls, 0)      AS calls,      COALESCE(v.meetings, 0) AS meetings,
			       COALESCE(v.notes, 0)      AS notes,      COALESCE(v.emails, 0)   AS emails,
			       COALESCE(v.moves, 0)      AS moves,
			       COALESCE(v.contacts_touched, 0) AS customers_touched,
			       v.last_activity_at, v.summary, v.plan,
			       COALESCE(b.live_leads, 0) AS live_leads,
			       COALESCE(b.overdue, 0)    AS overdue_followups,
			       COALESCE(n.note_count, 0) AS note_count,
			       COALESCE(n.open_threads, 0) AS open_threads
			  FROM app.o3c_users u
			  CROSS JOIN d
			  CROSS JOIN working
			  LEFT JOIN app.v_sales_officer_days v
			         ON v.officer_id = u.id AND v.day = d.the_day
			  LEFT JOIN (
			       SELECT c.sales_owner_id AS officer_id, COUNT(*) AS live_leads,
			              COUNT(*) FILTER (WHERE c.next_action_at < NOW()) AS overdue
			         FROM app.crm_contacts c
			        WHERE c.sales_owner_id IS NOT NULL AND c.sales_entered_at IS NOT NULL
			          AND c.lead_stage NOT IN ('converted', 'disqualified')
			        GROUP BY 1
			  ) b ON b.officer_id = u.id
			  LEFT JOIN (
			       SELECT subject_key::bigint AS officer_id,
			              COUNT(*) AS note_count,
			              COUNT(*) FILTER (WHERE thread_root_id IS NULL AND status = 'open') AS open_threads
			         FROM app.management_notes
			        WHERE subject_type = 'sales_officer_week'
			          AND subject_key ~ '^[0-9]+$'
			        GROUP BY 1
			  ) n ON n.officer_id = u.id
			 WHERE u.deleted_at IS NULL AND u.is_active AND (`+salesOfficerPredicate+`)`+scope+`
			 ORDER BY COALESCE(v.activities, 0) DESC, u.full_name`, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load the day", err)
			return
		}

		// Every entry for the whole floor in ONE query, then bucketed in Go. Per-officer
		// queries would be sixteen round trips for a page that is read start to finish.
		entryRows, eerr := db.PGQuery(r.Context(), `
			SELECT a.actor_user_id AS officer_id, a.type, COALESCE(a.subject, '') AS subject,
			       COALESCE(a.body, '') AS body, COALESCE(a.outcome, '') AS outcome,
			       COALESCE(a.metadata->>'location', '') AS location,
			       a.contact_id,
			       btrim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS customer,
			       a.occurred_at
			  FROM app.activities a
			  LEFT JOIN app.crm_contacts c ON c.id = a.contact_id
			 WHERE a.actor_user_id IS NOT NULL
			   AND COALESCE(a.actor_team, '') = 'sales'
			   AND a.source = 'manual'
			   AND (a.occurred_at AT TIME ZONE 'Africa/Lagos')::date = $1::date
			 ORDER BY a.occurred_at`, ds)
		if eerr != nil {
			respondErrLog(w, 500, "Could not load the day's entries", eerr)
			return
		}
		byOfficer := map[int64][]dailyEntry{}
		for _, e := range entryRows {
			id := toInt64(e["officer_id"])
			byOfficer[id] = append(byOfficer[id], dailyEntry{
				Type: str(e["type"]), Subject: str(e["subject"]), Body: str(e["body"]),
				Outcome: str(e["outcome"]), Location: str(e["location"]),
				Customer: str(e["customer"]), At: str(e["occurred_at"]),
			})
		}

		out := make([]dailyOfficer, 0, len(rows))
		var worked, quiet, away, noAccess int
		workingDay := true
		for _, row := range rows {
			o := dailyOfficer{
				OfficerID: toInt64(row["id"]), Name: str(row["full_name"]),
				Role: str(row["role"]), Office: str(row["office"]),
				Activities: toInt64(row["activities"]), Visits: toInt64(row["visits"]),
				Calls: toInt64(row["calls"]), Meetings: toInt64(row["meetings"]),
				Notes: toInt64(row["notes"]), Emails: toInt64(row["emails"]),
				Moves: toInt64(row["moves"]), Customers: toInt64(row["customers_touched"]),
				LiveLeads: toInt64(row["live_leads"]), Overdue: toInt64(row["overdue_followups"]),
				OwnNote: str(row["summary"]), OwnPlan: str(row["plan"]),
				LastAt: str(row["last_activity_at"]), WorkingDay: row["working_day"] == true,
				NoteCount: toInt64(row["note_count"]), OpenThreads: toInt64(row["open_threads"]),
				Entries: byOfficer[toInt64(row["id"])],
			}
			if o.Entries == nil {
				o.Entries = []dailyEntry{}
			}
			workingDay = o.WorkingDay

			// Order matters. An officer with no route to the system is not idle, and someone
			// on approved leave is not quiet — reporting either as "logged nothing" is the
			// mistake that costs a management page its credibility the first time it happens.
			switch {
			case row["never_signed_in"] == true:
				o.State = "no_access"
				noAccess++
			case row["away"] == true:
				o.State = "away"
				away++
			case o.Activities > 0:
				o.State = "worked"
				worked++
			default:
				o.State = "quiet"
				quiet++
			}
			out = append(out, o)
		}

		respond(w, map[string]any{
			"date":        ds,
			"working_day": workingDay,
			"officers":    out,
			"summary": map[string]any{
				"total": len(out), "worked": worked, "quiet": quiet,
				"away": away, "no_access": noAccess,
			},
		}, "pg")
	}
}
