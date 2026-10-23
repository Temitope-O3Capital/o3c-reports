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

// The management desk: things that need a judgement, and the conversation about them.
//
// WHY THIS IS NOT A DASHBOARD. An MD will not browse a module daily. What gets read at that
// tier is a short queue of things needing a decision, with one verb that creates
// accountability -- so the desk carries comment, acknowledge, ask and escalate, and carries
// no operational control at all. Reassigning a lead is the head's job; the MD's version is
// "ask the head to", which lands as an owned task with an answer due. An executive handed
// operational buttons produces silent actions nobody can trace.
//
// WHY THERE IS NO PER-SUBJECT ACCESS LIST HERE. Visibility derives from the subject, through
// management_subject_types.page_keys -- the same shape as reportDatasetPages: entitlement
// computed from the pages a viewer holds. A second access list beside the first drifts from
// it, and the drift is invisible until somebody reads what they should not. So the only
// question this file ever asks is "does the caller hold a page that opens this subject type".
//
// WHY THE ROUTE GROUP IS NOT GATED ON A ROLE. There is no single page key that covers every
// subject type, and inventing a `management` page would put the gate in a second place that
// has to be kept in step with the registry. Instead every handler resolves the subject type's
// page_keys from the registry and refuses before it reads anything -- and the inbox refuses a
// caller who holds no key for any active type. That is enforcement, not UI hiding; the
// difference matters, because /api/approvals is mounted in this codebase with no gate at all
// and is readable by every authenticated user today.

// managementSubject is one thing on the desk.
type managementSubject struct {
	SubjectType string   `json:"subject_type"`
	SubjectKey  string   `json:"subject_key"`
	Module      string   `json:"module"`
	Label       string   `json:"label"`
	Title       string   `json:"title"`
	Narrative   string   `json:"narrative"`
	Figures     []figure `json:"figures"`
	PeriodStart string   `json:"period_start,omitempty"`
	PeriodEnd   string   `json:"period_end,omitempty"`
	Verbs       []string `json:"verbs"`
	ReviewState string   `json:"review_state"`
	ReviewedBy  string   `json:"reviewed_by,omitempty"`
	ReviewedAt  string   `json:"reviewed_at,omitempty"`
	OpenThreads int      `json:"open_threads"`
	Notes       int      `json:"notes"`
	Severity    string   `json:"severity"`
}

type figure struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Bad   bool   `json:"bad,omitempty"`
}

// RegisterManagementDesk mounts the desk under /api/management.
func RegisterManagementDesk(r chi.Router, db *core.DB) {
	r.Get("/subject-types", managementSubjectTypes(db))
	r.Get("/inbox", managementInbox(db))
	r.Get("/subjects/{type}/{key}/notes", managementListNotes(db))
	r.Post("/subjects/{type}/{key}/notes", managementAddNote(db))
	r.Post("/subjects/{type}/{key}/review", managementSetReview(db))
	r.Put("/notes/{id}/status", managementSetNoteStatus(db))
}

// subjectTypeRow is the registry entry, loaded per request rather than cached: the registry
// is tiny, and is_active is the switch that silences a noisy subject type WITHOUT a deploy.
// Caching it would mean a type stays on the desk until the next restart, which defeats the
// point of making it a table.
type subjectTypeRow struct {
	SubjectType string
	Module      string
	Label       string
	PageKeys    []string
	Verbs       []string
	RaisedWhen  string
}

func loadSubjectType(ctx context.Context, db *core.DB, subjectType string) (subjectTypeRow, bool) {
	rows, err := db.PGQuery(ctx, `
		SELECT subject_type, module, label, page_keys, verbs, raised_when
		  FROM app.management_subject_types
		 WHERE subject_type = $1 AND is_active`, subjectType)
	if err != nil || len(rows) == 0 {
		return subjectTypeRow{}, false
	}
	return subjectTypeRow{
		SubjectType: str(rows[0]["subject_type"]),
		Module:      str(rows[0]["module"]),
		Label:       str(rows[0]["label"]),
		PageKeys:    pgTextArray(rows[0]["page_keys"]),
		Verbs:       pgTextArray(rows[0]["verbs"]),
		RaisedWhen:  str(rows[0]["raised_when"]),
	}, true
}

// canSeeSubjectType is the whole access model: hold any page that opens the subject, and you
// may read it, its notes and its review state.
func canSeeSubjectType(u *core.Claims, st subjectTypeRow) bool {
	if u == nil {
		return false
	}
	for _, p := range st.PageKeys {
		if u.HasPage(p) {
			return true
		}
	}
	return false
}

// verbsFor narrows the registry's verbs to the ones this caller may actually use. Everyone who
// can see a subject may comment and acknowledge -- a comment is how a head answers an MD, so
// restricting it to management would make the thread one-sided and the 'answered' state
// unreachable. 'escalate' is management's, because escalating to yourself is not a thing.
func verbsFor(u *core.Claims, st subjectTypeRow) []string {
	out := make([]string, 0, len(st.Verbs))
	for _, v := range st.Verbs {
		if v == "escalate" && !core.IsManagement(u.Role) {
			continue
		}
		out = append(out, v)
	}
	return out
}

func managementSubjectTypes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			SELECT subject_type, module, label, page_keys, verbs, raised_when, is_active
			  FROM app.management_subject_types ORDER BY module, subject_type`)
		if err != nil {
			respondErrLog(w, 500, "Could not load the subject registry", err)
			return
		}
		out := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			st := subjectTypeRow{
				PageKeys: pgTextArray(row["page_keys"]),
			}
			if !canSeeSubjectType(u, st) {
				continue
			}
			out = append(out, row)
		}
		respond(w, out, "pg")
	}
}

// ---------------------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------------------

func managementInbox(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Sign in to open the desk")
			return
		}

		// The week under review. Default is the last COMPLETE week, because judging an
		// officer on a Wednesday for a week that still has two days left in it is how a
		// desk earns a reputation for being wrong.
		from, to := lastCompleteWeek(time.Now())
		if s := strings.TrimSpace(r.URL.Query().Get("week_of")); s != "" {
			if d, err := time.Parse("2006-01-02", s); err == nil {
				from, to = weekOf(d)
			}
		}

		st, ok := loadSubjectType(r.Context(), db, "sales_officer_week")
		if !ok {
			// The type is switched off. An empty desk is a legitimate answer and the
			// reason is returned so the page can say so rather than look broken.
			respond(w, map[string]any{
				"subjects": []managementSubject{}, "from": from.Format("2006-01-02"),
				"to": to.Format("2006-01-02"), "silenced": []string{"sales_officer_week"},
			}, "pg")
			return
		}
		if !canSeeSubjectType(u, st) {
			respondErr(w, 403, "The desk has nothing you hold the pages to see")
			return
		}

		subjects, err := salesOfficerWeekSubjects(r, db, u, st, from, to)
		if err != nil {
			respondErrLog(w, 500, "Could not build the desk", err)
			return
		}
		respond(w, map[string]any{
			"subjects": subjects,
			"from":     from.Format("2006-01-02"),
			"to":       to.Format("2006-01-02"),
		}, "pg")
	}
}

// salesOfficerWeekSubjects raises one subject per officer who did no recorded work across a
// full working week while holding live leads.
//
// THE THREE CONDITIONS, AND WHY EACH IS LOAD-BEARING:
//
//  1. zero activities in the week, read from v_sales_officer_days -- which as of migration
//     391 counts emails and the five kinds that move a lead, and deliberately does NOT count
//     the bulk stage_change rows. Counting those would have put "317 activities" against a
//     head who ran one sweep.
//
//  2. app.available_working_days(officer, from, to) > 0. This is the condition that decides
//     whether anyone trusts the desk. It is per-person and subtracts that person's leave, and
//     the calendar underneath it excludes weekends and declared public holidays. Without it
//     the first item the MD ever sees is somebody on signed-off annual leave, and the list is
//     finished as a management tool the moment that happens once.
//
//  3. at least one live lead. "No activity" alone fires for every officer who has never been
//     given anything, which today is most of them -- 13 of 16 log nothing. That is a real
//     problem but it is an onboarding problem, and burying four other items under thirteen
//     copies of it is how a desk stops being opened. With a live book, the item says work is
//     going unattended, which is the thing a manager can act on.
func salesOfficerWeekSubjects(
	r *http.Request, db *core.DB, u *core.Claims, st subjectTypeRow, from, to time.Time,
) ([]managementSubject, error) {
	// Scope. teamHeadOfficerIDs is headship of an active team, not the sales_head role --
	// two of the four teams are headed by officers whose role is sales_officer, and a
	// role-only test would leave both of those heads unable to see their own people.
	scope, ids := salesLeadScope(r, db, u)
	where := ""
	args := []any{from.Format("2006-01-02"), to.Format("2006-01-02")}
	switch scope {
	case scopeTeam:
		where = " AND r.id = ANY($3)"
		args = append(args, ids)
	case scopeOwn:
		// An officer has no business reading the desk, but if one reaches it they see only
		// themselves rather than an error -- the same shape the rest of the module uses.
		where = " AND r.id = $3"
		args = append(args, u.ID)
	}

	rows, err := db.PGQuery(r.Context(), `
		WITH wk AS (SELECT $1::date AS d_from, $2::date AS d_to),
		roster AS (
		    SELECT u.id, u.full_name, u.role,
		           COALESCE(u.office_location, '') AS office,
		           u.last_login
		      FROM app.o3c_users u
		     WHERE u.deleted_at IS NULL AND u.is_active AND (`+salesOfficerPredicate+`)
		),
		acted AS (
		    SELECT d.officer_id, SUM(d.activities) AS activities,
		           MAX(d.last_activity_at) AS last_at
		      FROM app.v_sales_officer_days d CROSS JOIN wk
		     WHERE d.day BETWEEN wk.d_from AND wk.d_to
		     GROUP BY d.officer_id
		),
		book AS (
		    SELECT c.sales_owner_id AS officer_id, COUNT(*) AS live_leads,
		           COUNT(*) FILTER (WHERE c.next_action_at < NOW()) AS overdue
		      FROM app.crm_contacts c
		     WHERE c.sales_owner_id IS NOT NULL
		       AND c.sales_entered_at IS NOT NULL
		       AND c.lead_stage NOT IN ('converted', 'disqualified')
		     GROUP BY 1
		)
		SELECT r.id, r.full_name, r.role, r.office,
		       (r.last_login IS NULL) AS never_signed_in,
		       COALESCE(b.live_leads, 0) AS live_leads,
		       COALESCE(b.overdue, 0)    AS overdue,
		       app.available_working_days(r.id, wk.d_from, wk.d_to) AS working_days,
		       (SELECT MAX(d2.day) FROM app.v_sales_officer_days d2
		         WHERE d2.officer_id = r.id AND d2.activities > 0) AS last_active_day
		  FROM roster r
		  CROSS JOIN wk
		  LEFT JOIN acted a ON a.officer_id = r.id
		  LEFT JOIN book  b ON b.officer_id = r.id
		 WHERE COALESCE(a.activities, 0) = 0
		   AND COALESCE(b.live_leads, 0) > 0
		   AND app.available_working_days(r.id, wk.d_from, wk.d_to) > 0`+where+`
		 ORDER BY COALESCE(b.live_leads, 0) DESC, r.full_name`, args...)
	if err != nil {
		return nil, err
	}

	out := make([]managementSubject, 0, len(rows))
	for _, row := range rows {
		key := str(row["id"])
		live := toInt64(row["live_leads"])
		overdue := toInt64(row["overdue"])
		never := row["never_signed_in"] == true
		name := str(row["full_name"])
		office := str(row["office"])
		if office == "" {
			office = "no office set"
		}

		// The narrative says which of the two situations this is, because they need
		// completely different responses. An officer who cannot sign in is not idle.
		var narrative, title, severity string
		if never {
			title = fmt.Sprintf("%s holds %d live leads and has never signed in", name, live)
			narrative = fmt.Sprintf(
				"%s (%s, %s) is carrying %d live leads and has no recorded activity this week. "+
					"They have never had a session, so this is an access problem rather than an "+
					"idle week -- the leads are assigned, which means nothing else in the system "+
					"flags them as needing attention.", name, str(row["role"]), office, live)
			severity = "urgent"
		} else {
			lastSeen := "no activity on record at all"
			if d := str(row["last_active_day"]); d != "" {
				lastSeen = "last logged something on " + d
			}
			title = fmt.Sprintf("%s logged nothing for a full week, holding %d live leads", name, live)
			narrative = fmt.Sprintf(
				"%s (%s, %s) recorded no calls, visits, meetings, notes, emails or lead "+
					"movements between %s and %s, and %s. Their working days that week are net "+
					"of leave and declared holidays, so this is not a week off.",
				name, str(row["role"]), office,
				from.Format("2 Jan"), to.Format("2 Jan 2006"), lastSeen)
			severity = "watch"
		}

		figs := []figure{
			{Label: "Live leads", Value: strconv.FormatInt(live, 10)},
			{Label: "Activities this week", Value: "0", Bad: true},
			{Label: "Working days", Value: str(row["working_days"])},
		}
		if overdue > 0 {
			figs = append(figs, figure{
				Label: "Overdue follow-ups", Value: strconv.FormatInt(overdue, 10), Bad: true})
		}

		s := managementSubject{
			SubjectType: st.SubjectType, SubjectKey: key,
			Module: st.Module, Label: st.Label,
			Title: title, Narrative: narrative, Figures: figs,
			PeriodStart: from.Format("2006-01-02"), PeriodEnd: to.Format("2006-01-02"),
			Verbs: verbsFor(u, st), Severity: severity,
			ReviewState: "needs_review",
		}
		out = append(out, s)
	}

	return decorateWithReviewAndNotes(r.Context(), db, out)
}

// decorateWithReviewAndNotes attaches the review state and thread counts in ONE round trip
// rather than per subject, so a desk of forty items is two queries and not eighty-one.
func decorateWithReviewAndNotes(
	ctx context.Context, db *core.DB, subs []managementSubject,
) ([]managementSubject, error) {
	if len(subs) == 0 {
		return subs, nil
	}
	keys := make([]string, 0, len(subs))
	for _, s := range subs {
		keys = append(keys, s.SubjectKey)
	}
	st := subs[0].SubjectType

	rev, err := db.PGQuery(ctx, `
		SELECT v.subject_key, v.state, v.reviewed_at, u.full_name
		  FROM app.management_reviews v
		  LEFT JOIN app.o3c_users u ON u.id = v.reviewer_user_id
		 WHERE v.subject_type = $1 AND v.subject_key = ANY($2)
		   AND COALESCE(v.period_start, '0001-01-01'::date) = $3::date`,
		st, keys, subs[0].PeriodStart)
	if err != nil {
		return nil, err
	}
	byKey := map[string]map[string]any{}
	for _, row := range rev {
		byKey[str(row["subject_key"])] = row
	}

	cnt, err := db.PGQuery(ctx, `
		SELECT subject_key,
		       COUNT(*)                                                      AS notes,
		       COUNT(*) FILTER (WHERE thread_root_id IS NULL
		                          AND status = 'open')                       AS open_threads
		  FROM app.management_notes
		 WHERE subject_type = $1 AND subject_key = ANY($2)
		 GROUP BY subject_key`, st, keys)
	if err != nil {
		return nil, err
	}
	counts := map[string]map[string]any{}
	for _, row := range cnt {
		counts[str(row["subject_key"])] = row
	}

	for i := range subs {
		if row, ok := byKey[subs[i].SubjectKey]; ok {
			subs[i].ReviewState = str(row["state"])
			subs[i].ReviewedBy = str(row["full_name"])
			subs[i].ReviewedAt = str(row["reviewed_at"])
		}
		if row, ok := counts[subs[i].SubjectKey]; ok {
			subs[i].Notes = int(toInt64(row["notes"]))
			subs[i].OpenThreads = int(toInt64(row["open_threads"]))
		}
	}
	return subs, nil
}

// ---------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------

func managementListNotes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		st, ok := loadSubjectType(r.Context(), db, chi.URLParam(r, "type"))
		if !ok {
			respondErr(w, 404, "That is not a subject anyone can review")
			return
		}
		if !canSeeSubjectType(u, st) {
			respondErr(w, 403, "You do not hold a page that opens this")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT n.id, n.thread_root_id, n.body, n.status, n.created_at,
			       n.author_user_id, u.full_name AS author_name, u.role AS author_role
			  FROM app.management_notes n
			  JOIN app.o3c_users u ON u.id = n.author_user_id
			 WHERE n.subject_type = $1 AND n.subject_key = $2
			 ORDER BY COALESCE(n.thread_root_id, n.id), n.id`,
			st.SubjectType, chi.URLParam(r, "key"))
		if err != nil {
			respondErrLog(w, 500, "Could not load the thread", err)
			return
		}
		jsonRows(w, rows)
	}
}

func managementAddNote(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		st, ok := loadSubjectType(r.Context(), db, chi.URLParam(r, "type"))
		if !ok {
			respondErr(w, 404, "That is not a subject anyone can review")
			return
		}
		if !canSeeSubjectType(u, st) {
			respondErr(w, 403, "You do not hold a page that opens this")
			return
		}
		var b struct {
			Body         string `json:"body"`
			ThreadRootID *int64 `json:"thread_root_id"`
			PeriodStart  string `json:"period_start"`
			PeriodEnd    string `json:"period_end"`
			// An ASK: who owes the answer, and by when. Both optional — a plain comment
			// addresses nobody, which is a different kind of note rather than a defective
			// one. Deliberately NOT the subject of the note: a question about an officer's
			// week is normally asked of their HEAD, and addressing it to the officer would
			// send it to the one person who cannot answer it.
			AskedUserID *int64 `json:"asked_user_id"`
			DueAt       string `json:"due_at"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		body := strings.TrimSpace(b.Body)
		if body == "" {
			respondErr(w, 422, "A note needs something in it.")
			return
		}
		if len([]rune(body)) > 4000 {
			respondErr(w, 422, "Keep the note to 4,000 characters or fewer.")
			return
		}

		// An ask has to be answerable by somebody who can actually open it, so the
		// recipient is checked the way every other assignment target in the module is —
		// assignTargetProblem, which is the only one of these tests that also covers
		// suspended_at. A question owed by a deactivated account is a question nobody owes.
		var askedID *int64
		if b.AskedUserID != nil && *b.AskedUserID > 0 {
			if b.ThreadRootID != nil && *b.ThreadRootID > 0 {
				respondErr(w, 422, "A reply answers a question; it cannot ask a new one. "+
					"Start a new note to ask somebody something.")
				return
			}
			if p := assignTargetProblem(r.Context(), db, *b.AskedUserID); p != "" {
				respondErr(w, 422, p)
				return
			}
			askedID = b.AskedUserID
		}
		if strings.TrimSpace(b.DueAt) != "" && askedID == nil {
			respondErr(w, 422, "A date to answer by needs somebody to answer it. "+
				"Choose who you are asking.")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.management_notes
			  (subject_type, subject_key, period_start, period_end, thread_root_id,
			   author_user_id, body, asked_user_id, due_at)
			VALUES ($1, $2, NULLIF($3,'')::date, NULLIF($4,'')::date, $5, $6, $7,
			        $8, NULLIF($9,'')::timestamptz)
			RETURNING id, created_at`,
			st.SubjectType, chi.URLParam(r, "key"),
			b.PeriodStart, b.PeriodEnd, b.ThreadRootID, u.ID, body,
			askedID, b.DueAt)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not save the note", err)
			return
		}

		// A reply answers the thread it is on. Without this the MD asks a question, the head
		// answers it, and the thread still reads 'open' on the desk for ever -- so the next
		// person to look chases an answer that is already there.
		if b.ThreadRootID != nil && *b.ThreadRootID > 0 {
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE app.management_notes SET status = 'answered'
				  WHERE id = $1 AND thread_root_id IS NULL AND status = 'open'`, *b.ThreadRootID)
		}

		// Tell the person the note is ABOUT, not just the managers watching. A comment the
		// subject never sees is worse than no comment: the manager believes they have
		// managed and nobody is listening. For sales_officer_week the subject_key IS the
		// officer's user id, so the recipient is unambiguous.
		if st.SubjectType == "sales_officer_week" {
			if officerID, convErr := strconv.ParseInt(chi.URLParam(r, "key"), 10, 64); convErr == nil &&
				officerID != u.ID {
				NotifyUsers(r.Context(), db, []int64{officerID}, NotifPayload{
					EventType: "management_note",
					Title:     "A note on your week",
					Body:      u.FullName + " left a note on your week: " + noteFirstLine(body, 140),
					ActionURL: "/sales/my-dashboard",
					EntityRef: st.SubjectType + ":" + chi.URLParam(r, "key"),
					// Ungrouped: it is about one person, one week, and it is specific enough
					// to be worth an email every time rather than a count in a badge.
					Priority: "normal",
				})
			}
		}

		// The person who OWES the answer is told, separately and more pointedly than the
		// subject. This is what makes an ask an ask: without it the question sits on a page
		// the recipient has no reason to open, which is exactly what the button used to do
		// while its own copy claimed it created "an owned question with an answer due".
		if askedID != nil && *askedID != u.ID {
			due := ""
			if d := strings.TrimSpace(b.DueAt); d != "" {
				if t, perr := time.Parse(time.RFC3339, d); perr == nil {
					due = " Answer by " + t.Format("Mon 2 Jan") + "."
				}
			}
			NotifyUsers(r.Context(), db, []int64{*askedID}, NotifPayload{
				EventType: "management_ask",
				Title:     u.FullName + " asked you a question",
				Body:      noteFirstLine(body, 160) + due,
				ActionURL: "/sales/desk",
				EntityRef: st.SubjectType + ":" + chi.URLParam(r, "key"),
				// Ungrouped and high: it is addressed to one person, it names them, and it
				// is waiting on them. A digest would bury the one notification in this
				// module that somebody actually owes an answer to.
				Priority: "high",
			})
		}

		respond(w, map[string]any{"ok": true, "id": rows[0]["id"]}, "pg")
	}
}

func managementSetNoteStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		var b struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status != "open" && b.Status != "answered" && b.Status != "closed" {
			respondErr(w, 422, "A thread is open, answered or closed.")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Bad note id")
			return
		}

		// The subject type is read from the note itself rather than the URL, so the access
		// check cannot be steered by passing a type the caller happens to hold.
		rows, err := db.PGQuery(r.Context(),
			`SELECT subject_type FROM app.management_notes WHERE id = $1 AND thread_root_id IS NULL`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "No such thread")
			return
		}
		st, ok := loadSubjectType(r.Context(), db, str(rows[0]["subject_type"]))
		if !ok || !canSeeSubjectType(u, st) {
			respondErr(w, 403, "You do not hold a page that opens this")
			return
		}

		if _, err := db.PGExec(r.Context(),
			`UPDATE app.management_notes SET status = $2 WHERE id = $1 AND thread_root_id IS NULL`,
			id, b.Status); err != nil {
			respondErrLog(w, 500, "Could not update the thread", err)
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

// ---------------------------------------------------------------------------------------
// Review state
// ---------------------------------------------------------------------------------------

func managementSetReview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		st, ok := loadSubjectType(r.Context(), db, chi.URLParam(r, "type"))
		if !ok {
			respondErr(w, 404, "That is not a subject anyone can review")
			return
		}
		if !canSeeSubjectType(u, st) {
			respondErr(w, 403, "You do not hold a page that opens this")
			return
		}
		var b struct {
			State       string `json:"state"`
			PeriodStart string `json:"period_start"`
			PeriodEnd   string `json:"period_end"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		switch b.State {
		case "reviewed", "acknowledged", "closed":
		case "escalated":
			if !core.IsManagement(u.Role) {
				respondErr(w, 403, "Escalating is management's to do.")
				return
			}
		default:
			respondErr(w, 422, "A subject is reviewed, acknowledged, escalated or closed.")
			return
		}

		// ON CONFLICT on the same expression the unique index uses, or a second
		// acknowledgement of the same week would be rejected as a duplicate rather than
		// recorded as a change of mind.
		if _, err := db.PGExec(r.Context(), `
			INSERT INTO app.management_reviews
			  (subject_type, subject_key, period_start, period_end, state,
			   reviewer_user_id, reviewed_at)
			VALUES ($1, $2, NULLIF($3,'')::date, NULLIF($4,'')::date, $5, $6, NOW())
			ON CONFLICT (subject_type, subject_key, COALESCE(period_start, '0001-01-01'::date))
			DO UPDATE SET state = EXCLUDED.state,
			              reviewer_user_id = EXCLUDED.reviewer_user_id,
			              reviewed_at = EXCLUDED.reviewed_at,
			              period_end = EXCLUDED.period_end,
			              updated_at = NOW()`,
			st.SubjectType, chi.URLParam(r, "key"), b.PeriodStart, b.PeriodEnd, b.State, u.ID); err != nil {
			respondErrLog(w, 500, "Could not record the review", err)
			return
		}
		respond(w, map[string]any{"ok": true, "state": b.State}, "pg")
	}
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

// weekOf returns the Monday-to-Sunday week containing d, in local terms. Monday because the
// sales week is discussed as one, not because the database cares.
func weekOf(d time.Time) (time.Time, time.Time) {
	wd := int(d.Weekday())
	if wd == 0 {
		wd = 7 // Sunday closes the week rather than opening it
	}
	start := d.AddDate(0, 0, -(wd - 1))
	return truncDay(start), truncDay(start.AddDate(0, 0, 6))
}

// lastCompleteWeek is the week before the one now in progress. Judging a week that still has
// days left in it produces items that resolve themselves by Friday, and a desk whose items
// evaporate is a desk nobody trusts.
func lastCompleteWeek(now time.Time) (time.Time, time.Time) {
	thisMon, _ := weekOf(now)
	prev := thisMon.AddDate(0, 0, -7)
	return weekOf(prev)
}

func truncDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

func noteFirstLine(s string, max int) string {
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	if len([]rune(s)) > max {
		return string([]rune(s)[:max]) + "..."
	}
	return s
}
