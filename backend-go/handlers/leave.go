package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
LEAVE — requesting time off, approving it, and the days someone was available.

THREE AUDIENCES, THREE DIFFERENT KINDS OF GATE. This is the first module where the
authorisation story is not "one page key for the lot", so it is worth stating why:

  self-service   NO page gate. Every member of staff must be able to request their
                 own leave, so a grant would be the wrong instrument — holding a page
                 is not what makes leave yours. Every self route is scoped in SQL to
                 the signed-in user's own id, the way /handoffs is scoped to your own
                 team. There is no route here that takes a user_id from the client.

  manager        NO page gate either, because being an approver is a FACT IN THE DATA
                 (o3c_users.manager_user_id), not a role somebody was granted. Gating
                 on a role would approve the wrong set of people twice over: a team
                 lead without the role could not approve their own reports, and a
                 holder of the role could approve strangers. Every manager route
                 matches on leave_requests.routed_to_manager = me, or on being the
                 escalation approver of a requester whose routed manager is away.

  HR             leave_admin, a real page key. Setting an entitlement and confirming
                 an approval are company decisions rather than personal ones.

WHY A REQUEST IS REFUSED WHEN NOBODY MANAGES YOU. The approval chain the business
chose is line manager, then HR. If manager_user_id is unset the chain does not exist,
and the two ways to carry on regardless are both worse than refusing: routing straight
to HR silently deletes the approval step somebody chose, and approving it on the spot
is no approval at all. So submission is refused with an actionable message and HR gets
/admin/unmanaged listing exactly whose manager is missing. On the day this shipped that
was all 50 active staff; migration 380 loaded HR's roster and it is now 7, of which 6
are accounts the HR file does not name at all and one is the MD.

AND WHEN THE APPROVER IS AWAY. A chain with exactly one named approver stalls when that
person is on leave, which is common: a team books time off around the same weeks their
lead does. So o3c_users.escalation_manager_user_id — HR's own MANAGER column, the level
above the team lead — may decide a request while app.is_unavailable() says the routed
manager cannot. Three properties make this different from the silent re-routing that was
rejected above: the second approver is RECORDED BY HR rather than inferred, the request
is not re-routed (routed_to_manager still names the line manager, who can still decide
it the moment they are back), and manager_decided_by records who actually decided, so a
decision taken on somebody's behalf is visibly that rather than attributed to them.

WHAT THIS FILE DOES NOT ENFORCE, DELIBERATELY. Two policy columns on leave_types are
reported rather than imposed:

  min_notice_days  a late request is flagged short_notice to both approvers and still
                   submitted. Sick leave carries a notice of zero for the obvious
                   reason, and compassionate leave is asked for on the worst day of
                   somebody's year; refusing those at the door would be absurd.
  requires_docs    flagged documents_outstanding, not blocked. Somebody off sick on
                   the morning cannot produce the note first, and a system that
                   demands it makes them submit nothing at all.

Exceeding an entitlement is likewise flagged (over_entitlement) rather than refused —
on day one nobody HAS an entitlement row, so a hard block would make the module
unusable until HR finished a data-entry task, and the person with the authority to
judge the exception is the approver reading the flag.

CONSUMPTION IS NEVER WRITTEN. There is no days_used column anywhere in this file and
no handler that decrements a balance. app.v_leave_balance derives taken and pending
from the requests themselves, which is why cancelling an approved future leave needs
no compensating update — the balance simply recomputes. The same property is what
makes app.available_working_days() safe for the KPI denominators.

EVERY TRANSITION IS A GUARDED UPDATE. A decision is applied with its precondition in
the WHERE clause and verified by the affected row count, never read-then-write: two
managers opening the same request would otherwise both see pending_manager and both
write a decision, and the second would overwrite the first with no trace.
*/

// leaveTypeColumns is the whole of leave_types this module exposes. Named once so
// the self-service form, the approver views and HR all describe a type identically.
const leaveTypeColumns = `t.id, t.name, t.days_per_year, t.is_paid, t.requires_docs,
	t.min_notice_days, t.carry_over_max`

// leaveAdminPage gates the HR half. Declared as a constant because it appears in the
// route table, in the per-row privacy rule on the calendar, and in core/catalog.go —
// three places that must not drift.
const leaveAdminPage = "leave_admin"

func RegisterLeave(r chi.Router, db *core.DB) {
	admin := core.RequirePages(leaveAdminPage)

	// ── Self-service. Scoped in SQL to the caller; no gate, no user_id parameter. ──
	r.Get("/types", leaveTypes(db))
	r.Get("/me", leaveMe(db))
	r.Get("/colleagues", leaveColleagues(db))
	r.Post("/requests", leaveSubmit(db))
	r.Post("/requests/{id}/cancel", leaveCancel(db))

	// Who is off and who is covering. Open to everyone because covering someone's
	// work requires knowing they are out — but the leave TYPE is withheld per row
	// unless you are the person, their manager, or HR. See leaveCalendar.
	r.Get("/calendar", leaveCalendar(db))

	// ── Manager. Scoped to routed_to_manager = me. ──
	r.Get("/approvals", leaveApprovals(db))
	r.Post("/requests/{id}/manager-decision", leaveManagerDecision(db))

	// ── HR. ──
	r.With(admin).Get("/admin/requests", leaveAdminRequests(db))
	r.With(admin).Post("/requests/{id}/hr-decision", leaveHRDecision(db))
	r.With(admin).Get("/admin/entitlements", leaveEntitlements(db))
	r.With(admin).Post("/admin/entitlements", leaveSetEntitlement(db))
	r.With(admin).Get("/admin/gaps", leaveGaps(db))
	r.With(admin).Get("/admin/unmanaged", leaveUnmanaged(db))
	// The write that makes the two lists above actionable. Nothing else in the
	// codebase sets manager_user_id or hire_date, so without this the 412 on
	// submission was a dead end: HR could see all 50 names and had no way to give
	// any of them a manager. Employment facts rather than leave facts, kept here
	// because HR owns them and leave is what consumes them.
	r.With(admin).Post("/admin/employment", leaveSetEmployment(db))
	r.With(admin).Get("/admin/drift", leaveDrift(db))
	r.With(admin).Get("/admin/lookups", leaveLookups(db))
}

/* ── Error translation ──────────────────────────────────────────────────────── */

// leaveWriteErr turns the database's own refusals into the right status code.
//
// Migration 374 enforces three rules in triggers and constraints rather than in Go,
// because they must hold for every writer and not merely for this file. The cost is
// that they arrive here as errors, and left alone they would all surface as 500 —
// telling a user "server error" when the truth is "you already booked that week".
// Matched on the message text the migration raises; those strings are part of the
// schema's contract and changing one without this list is the drift to watch for.
func leaveWriteErr(w http.ResponseWriter, err error) {
	s := err.Error()
	switch {
	case strings.Contains(s, "contains no working days"):
		respondErr(w, http.StatusBadRequest,
			"Those dates contain no working days — weekends and public holidays do not count as leave")
	case strings.Contains(s, "overlaps an existing active request"):
		respondErr(w, http.StatusConflict,
			"You already have leave booked or pending that overlaps these dates")
	case strings.Contains(s, "leave_requests_no_self_cover"):
		respondErr(w, http.StatusBadRequest, "You cannot be your own cover")
	case strings.Contains(s, "leave_requests_dates_make_sense"):
		respondErr(w, http.StatusBadRequest, "The end date cannot be before the start date")
	case strings.Contains(s, "o3c_users_manager_not_self"):
		respondErr(w, http.StatusBadRequest, "Somebody cannot be their own line manager")
	case strings.Contains(s, "would form a cycle"):
		respondErr(w, http.StatusBadRequest,
			"That would make two people each other's manager, directly or through a chain")
	default:
		respondErrLog(w, http.StatusInternalServerError, "could not save the leave record", err)
	}
}

/* ── Types ──────────────────────────────────────────────────────────────────── */

func leaveTypes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT %s
			FROM app.leave_types t
			WHERE t.is_active
			ORDER BY t.sort_order, t.name`, leaveTypeColumns))
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read leave types", err)
			return
		}
		respond(w, rows, "app.leave_types")
	}
}

// leaveColleagues names the people you could put down as cover, and nothing else.
//
// Scoped to your own department and returning two columns, because its only purpose
// is to fill one dropdown. The staff register lives behind people_directory and must
// stay there: an ungated endpoint returning every employee's details would be a
// second, unguarded route to it, which is precisely the mistake /api/people was
// written to avoid.
func leaveColleagues(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id, u.full_name
			FROM app.o3c_users u
			WHERE u.is_active AND u.deleted_at IS NULL
			  AND u.id <> $1
			  AND btrim(COALESCE(u.department,'')) = (
			        SELECT btrim(COALESCE(department,'')) FROM app.o3c_users WHERE id = $1)
			ORDER BY u.full_name`, user.ID)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read your colleagues", err)
			return
		}
		respond(w, rows, "app.o3c_users")
	}
}

/* ── My leave ───────────────────────────────────────────────────────────────── */

// leaveMe is everything the self-service page needs in one round trip: who approves
// my leave, what I am entitled to, what I have asked for, and how many working days
// I am actually available this year.
//
// can_approve and can_administer are returned rather than inferred in the browser,
// because the frontend must not decide authorisation — it decides which tabs to draw,
// and the server decides what the tabs are allowed to load.
func leaveMe(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		year := qint(r, "year", time.Now().Year(), 2020, 2100)
		out := map[string]any{"year": year}

		// Who I am, for leave purposes: my manager and my hire date. hire_date is
		// returned even when NULL so the page can say "HR has not recorded your start
		// date" rather than render a pro-rata entitlement computed from nothing.
		if rows, _ := db.PGQuery(ctx, `
			SELECT u.id, u.full_name, u.department, u.hire_date,
			       u.manager_user_id, m.full_name AS manager_name
			FROM app.o3c_users u
			LEFT JOIN app.o3c_users m ON m.id = u.manager_user_id
			WHERE u.id = $1`, user.ID); len(rows) > 0 {
			out["me"] = rows[0]
		}

		// Balances. Somebody with no entitlement row is absent from this view by
		// design — the page shows the gap as a gap. See app.v_leave_entitlement_gaps.
		if rows, err := db.PGQuery(ctx, `
			SELECT leave_type_id, leave_type, days_entitled, days_carried_over,
			       days_taken, days_pending, days_remaining
			FROM app.v_leave_balance
			WHERE user_id = $1 AND year = $2
			ORDER BY leave_type`, user.ID, year); err == nil {
			out["balances"] = rows
		}

		// Which types I have no entitlement for this year, with what HR's own view
		// suggests it should be. Shown to the person so a missing entitlement is
		// chased rather than silently treated as zero days.
		if rows, err := db.PGQuery(ctx, `
			SELECT leave_type_id, leave_type, suggested_days
			FROM app.v_leave_entitlement_gaps
			WHERE user_id = $1
			ORDER BY leave_type`, user.ID); err == nil {
			out["entitlement_gaps"] = rows
		}

		if rows, err := db.PGQuery(ctx, `
			SELECT r.id, r.leave_type_id, t.name AS leave_type,
			       r.start_date, r.end_date, r.working_days, r.status,
			       r.reason, r.document_ref,
			       r.cover_user_id, c.full_name AS cover_name,
			       r.routed_to_manager, m.full_name AS manager_name,
			       r.manager_decided_at, r.manager_note,
			       r.hr_decided_at, r.hr_note,
			       r.created_at,
			       -- Cancellable by the person themselves: anything still pending, or
			       -- an approved absence that has not started. Approved leave already
			       -- under way is HR's to unwind, not the employee's.
			       (r.status IN ('pending_manager','pending_hr')
			        OR (r.status = 'approved' AND r.start_date > CURRENT_DATE)) AS can_cancel
			FROM app.leave_requests r
			JOIN app.leave_types t ON t.id = r.leave_type_id
			LEFT JOIN app.o3c_users c ON c.id = r.cover_user_id
			LEFT JOIN app.o3c_users m ON m.id = r.routed_to_manager
			WHERE r.user_id = $1
			ORDER BY r.start_date DESC
			LIMIT 100`, user.ID); err == nil {
			out["requests"] = rows
		}

		// The denominator the KPI framework uses, shown to the person it describes.
		// Year to date rather than the whole year: days you have not reached yet are
		// not days you were available.
		if rows, _ := db.PGQuery(ctx, `
			SELECT app.leave_working_days(GREATEST($2::date, date_trunc('year', $2::date)::date),
			                              LEAST(CURRENT_DATE, ($3||'-12-31')::date)) AS working_days_ytd,
			       app.available_working_days($1,
			            ($3||'-01-01')::date,
			            LEAST(CURRENT_DATE, ($3||'-12-31')::date)) AS available_days_ytd,
			       app.on_leave($1, CURRENT_DATE) AS on_leave_today`,
			user.ID, fmt.Sprintf("%d-01-01", year), fmt.Sprintf("%d", year)); len(rows) > 0 {
			out["availability"] = rows[0]
		}

		// How many decisions are waiting on me as somebody's manager. Drives whether
		// the Approvals tab is drawn at all.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE status = 'pending_manager') AS awaiting_my_decision,
			       COUNT(*)                                           AS routed_to_me_ever
			FROM app.leave_requests
			WHERE routed_to_manager = $1`, user.ID); len(rows) > 0 {
			out["as_manager"] = rows[0]
		}

		// Do I manage anybody at all? A team lead with no pending decisions still
		// needs the tab, otherwise it appears and disappears with the queue.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS direct_reports
			FROM app.o3c_users
			WHERE manager_user_id = $1 AND is_active AND deleted_at IS NULL`, user.ID); len(rows) > 0 {
			out["direct_reports"] = rows[0]["direct_reports"]
		}

		out["can_administer"] = user.HasPage(leaveAdminPage)
		respond(w, out, "app.leave_requests, app.v_leave_balance")
	}
}

/* ── Submitting ─────────────────────────────────────────────────────────────── */

type leaveSubmitBody struct {
	LeaveTypeID int    `json:"leave_type_id"`
	StartDate   string `json:"start_date"`
	EndDate     string `json:"end_date"`
	Reason      string `json:"reason"`
	DocumentRef string `json:"document_ref"`
	CoverUserID *int64 `json:"cover_user_id"`
}

// leaveDateFmt is the wire format for every date in this module: the ISO date the
// frontend sends and the database stores, with no time and no zone. Leave is counted
// in whole working days, so a timestamp here would only invite a timezone bug.
const leaveDateFmt = "2006-01-02"

func leaveSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}

		var b leaveSubmitBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if b.LeaveTypeID <= 0 {
			respondErr(w, http.StatusBadRequest, "leave_type_id is required")
			return
		}
		start, err := time.Parse(leaveDateFmt, strings.TrimSpace(b.StartDate))
		if err != nil {
			respondErr(w, http.StatusBadRequest, "start_date must be YYYY-MM-DD")
			return
		}
		end, err := time.Parse(leaveDateFmt, strings.TrimSpace(b.EndDate))
		if err != nil {
			respondErr(w, http.StatusBadRequest, "end_date must be YYYY-MM-DD")
			return
		}
		if end.Before(start) {
			respondErr(w, http.StatusBadRequest, "The end date cannot be before the start date")
			return
		}

		// The chosen approval chain is line manager then HR, so no manager means no
		// chain. Refused here rather than routed around — see the file header.
		var managerID *int64
		var escalationID *int64
		var managerAway bool
		var typeName string
		var minNotice int
		var requiresDocs bool
		if rows, qerr := db.PGQuery(ctx, `
			SELECT u.manager_user_id, u.escalation_manager_user_id,
			       COALESCE(app.is_unavailable(u.manager_user_id), FALSE) AS manager_away,
			       t.name, t.min_notice_days, t.requires_docs
			FROM app.o3c_users u
			CROSS JOIN app.leave_types t
			WHERE u.id = $1 AND t.id = $2 AND t.is_active`, user.ID, b.LeaveTypeID); qerr != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read your record", qerr)
			return
		} else if len(rows) == 0 {
			respondErr(w, http.StatusBadRequest, "unknown or inactive leave type")
			return
		} else {
			if v := rows[0]["manager_user_id"]; v != nil {
				mid := toInt64(v)
				managerID = &mid
			}
			if v := rows[0]["escalation_manager_user_id"]; v != nil {
				eid := toInt64(v)
				escalationID = &eid
			}
			managerAway = rows[0]["manager_away"] == true
			typeName = fmt.Sprintf("%v", rows[0]["name"])
			minNotice = int(toInt64(rows[0]["min_notice_days"]))
			requiresDocs = rows[0]["requires_docs"] == true
		}
		if managerID == nil {
			respondErr(w, http.StatusPreconditionFailed,
				"No line manager is recorded for your account, so there is nobody to approve this. Ask HR to set your line manager.")
			return
		}

		rows, err := db.PGQuery(ctx, `
			INSERT INTO app.leave_requests
			    (user_id, leave_type_id, start_date, end_date, reason, document_ref,
			     cover_user_id, status, routed_to_manager)
			VALUES ($1, $2, $3::date, $4::date, NULLIF($5,''), NULLIF($6,''),
			        $7, 'pending_manager', $8)
			RETURNING id, start_date, end_date, working_days, status`,
			user.ID, b.LeaveTypeID, b.StartDate, b.EndDate,
			strings.TrimSpace(b.Reason), strings.TrimSpace(b.DocumentRef),
			b.CoverUserID, *managerID)
		if err != nil {
			leaveWriteErr(w, err)
			return
		}
		if len(rows) == 0 {
			respondErrLog(w, http.StatusInternalServerError, "the leave request was not created", nil)
			return
		}
		created := rows[0]

		// The three advisory flags. Reported, not enforced — the file header says why.
		noticeDays := int(start.Sub(time.Now().Truncate(24*time.Hour)).Hours() / 24)
		out := map[string]any{
			"request":               created,
			"leave_type":            typeName,
			"short_notice":          noticeDays < minNotice,
			"notice_given_days":     noticeDays,
			"notice_required_days":  minNotice,
			"documents_outstanding": requiresDocs && strings.TrimSpace(b.DocumentRef) == "",
		}

		// Balance impact, including the two honest "we cannot say" cases: no
		// entitlement row at all, and a request that exceeds what is left.
		year := start.Year()
		if brows, _ := db.PGQuery(ctx, `
			SELECT days_entitled, days_carried_over, days_taken, days_pending, days_remaining
			FROM app.v_leave_balance
			WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
			user.ID, b.LeaveTypeID, year); len(brows) > 0 {
			out["balance"] = brows[0]
			// days_remaining already has this request in days_pending, so a negative
			// remainder is precisely an over-draw.
			out["over_entitlement"] = toFloat(brows[0]["days_remaining"]) < 0
		} else {
			out["balance"] = nil
			out["entitlement_missing"] = true
		}

		// TELL THE APPROVER. This was missing from the day this file was written, and it
		// is the worst omission in it. The chain routes every request to ONE named
		// manager, no peer may act on it by design, there is no due date on the row and
		// nothing sweeps it — so with no notification a request simply waited until its
		// own start date passed, and the person went away unapproved or did not go.
		//
		// Addressed to the snapshotted routed_to_manager rather than the requester's
		// current manager_user_id, matching the rule in leaveManagerDecision: otherwise
		// a reorganisation would notify somebody whose guarded UPDATE cannot match.
		Notify(ctx, db, NotifPayload{
			EventType: "leave_request",
			UserID:    *managerID,
			Title:     "Leave request awaiting your decision",
			Body: fmt.Sprintf("%s has requested %s from %s to %s. You are their line manager; HR confirms after you.",
				user.FullName, typeName, b.StartDate, b.EndDate),
			ActionURL: "/leave",
			EntityRef: fmt.Sprintf("leave_request:%v", created["id"]),
			// Grouped per approver: a manager whose six reports all book Christmas off
			// should get one live item saying so, not six they stop reading.
			GroupKey: fmt.Sprintf("leave_pending:%d", *managerID),
			Priority: "high",
		})

		// AND IF THAT APPROVER IS ALREADY AWAY, tell the person HR names above them.
		//
		// Notifying the line manager is pointless when the line manager is the one on
		// leave, and that is not a rare case: a team books time off around the same
		// weeks their lead does. The second approver is not invented here — it is
		// escalation_manager_user_id, which is HR's own MANAGER column from the roster
		// (migration 380), and it is sent only while the routed approver is actually
		// unavailable. The request itself is NOT re-routed: routed_to_manager still
		// names the line manager, so if they come back tomorrow it is theirs to decide,
		// and the audit trail says who really decided it either way.
		if managerAway && escalationID != nil && *escalationID != *managerID {
			out["manager_unavailable"] = true
			Notify(ctx, db, NotifPayload{
				EventType: "leave_request",
				UserID:    *escalationID,
				Title:     "Leave request waiting on an approver who is away",
				Body: fmt.Sprintf("%s has requested %s from %s to %s. Their line manager is unavailable, and you are the approver above. You can decide it while they are away.",
					user.FullName, typeName, b.StartDate, b.EndDate),
				ActionURL: "/leave",
				EntityRef: fmt.Sprintf("leave_request:%v", created["id"]),
				GroupKey:  fmt.Sprintf("leave_escalated:%d", *escalationID),
				Priority:  "high",
			})
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data":        out,
			"data_source": "app.leave_requests",
			"data_as_of":  time.Now().UTC().Format(time.RFC3339),
		})
	}
}

/* ── Cancelling ─────────────────────────────────────────────────────────────── */

// leaveCancel withdraws your own request. No balance is adjusted because none is
// stored: v_leave_balance stops counting a cancelled row on its next read.
func leaveCancel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		id := chi.URLParam(r, "id")

		// user_id = me is the authorisation, in the same statement as the transition.
		res, err := db.PGExec(r.Context(), `
			UPDATE app.leave_requests
			   SET status = 'cancelled', cancelled_by = $1, cancelled_at = NOW(), updated_at = NOW()
			 WHERE id = $2
			   AND user_id = $1
			   AND (status IN ('pending_manager','pending_hr')
			        OR (status = 'approved' AND start_date > CURRENT_DATE))`, user.ID, id)
		if err != nil {
			leaveWriteErr(w, err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, http.StatusConflict,
				"That request is not yours to cancel, or it has already started or been decided")
			return
		}
		respondOK(w, "Leave request cancelled")
	}
}

/* ── Manager ────────────────────────────────────────────────────────────────── */

// leaveApprovals lists what is waiting on the signed-in person as a line manager.
// routed_to_manager is matched rather than the requester's current manager_user_id:
// the routing was captured at submission precisely so a reorganisation cannot move
// a pending decision to somebody who never saw it.
func leaveApprovals(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		status := qstr(r, "status")
		if status == "" {
			status = "pending_manager"
		}
		if !leaveStatuses[status] && status != "all" {
			respondErr(w, http.StatusBadRequest, "unknown status filter")
			return
		}
		clause := "r.status = $2"
		args := []any{user.ID, status}
		if status == "all" {
			clause = "1=1"
			args = args[:1]
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT r.id, r.user_id, u.full_name, u.department, u.role,
			       t.name AS leave_type, t.requires_docs,
			       r.start_date, r.end_date, r.working_days, r.status,
			       r.reason, r.document_ref,
			       r.cover_user_id, c.full_name AS cover_name,
			       r.created_at,
			       -- Advisory flags, computed for the approver rather than stored.
			       (r.start_date - r.created_at::date) < t.min_notice_days AS short_notice,
			       (t.requires_docs AND r.document_ref IS NULL)            AS documents_outstanding,
			       bal.days_remaining,
			       (bal.user_id IS NULL)                                   AS entitlement_missing,
			       -- Whose decision this really is, and whether you are seeing it only
			       -- because the person it was routed to is away.
			       r.routed_to_manager, rm.full_name AS routed_manager_name,
			       (r.routed_to_manager <> $1)                             AS via_escalation
			FROM app.leave_requests r
			JOIN app.o3c_users  u ON u.id = r.user_id
			JOIN app.leave_types t ON t.id = r.leave_type_id
			LEFT JOIN app.o3c_users c  ON c.id  = r.cover_user_id
			LEFT JOIN app.o3c_users rm ON rm.id = r.routed_to_manager
			LEFT JOIN app.v_leave_balance bal
			       ON bal.user_id = r.user_id
			      AND bal.leave_type_id = r.leave_type_id
			      AND bal.year = EXTRACT(YEAR FROM r.start_date)::int
			WHERE (r.routed_to_manager = $1
			       -- Or you are the approver HR names above a line manager who is away.
			       -- Scoped to the requester's own escalation manager, because that is
			       -- what the roster records: per employee, the lead and the level above.
			       OR (u.escalation_manager_user_id = $1
			           AND COALESCE(app.is_unavailable(r.routed_to_manager), FALSE)))
			  AND %s
			ORDER BY (r.status = 'pending_manager') DESC, r.start_date
			LIMIT 200`, clause), args...)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read your approvals", err)
			return
		}
		respond(w, rows, "app.leave_requests")
	}
}

var leaveStatuses = map[string]bool{
	"pending_manager": true, "pending_hr": true, "approved": true,
	"rejected": true, "cancelled": true,
}

type leaveDecisionBody struct {
	Decision string `json:"decision"` // approve | reject
	Note     string `json:"note"`
}

// leaveManagerDecision moves pending_manager to pending_hr or rejected.
//
// routed_to_manager = $1 in the WHERE clause is both the authorisation and the
// concurrency guard: a second manager cannot decide somebody else's report, and a
// second click cannot overwrite a decision already recorded.
func leaveManagerDecision(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		var b leaveDecisionBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		next, ok := leaveNextStatus(b.Decision, "pending_hr")
		if !ok {
			respondErr(w, http.StatusBadRequest, "decision must be approve or reject")
			return
		}
		// A rejection without a reason is the thing people complain about afterwards.
		if next == "rejected" && strings.TrimSpace(b.Note) == "" {
			respondErr(w, http.StatusBadRequest, "Please give a reason when rejecting a leave request")
			return
		}

		res, err := db.PGExec(r.Context(), `
			UPDATE app.leave_requests r
			   SET status = $3,
			       manager_decided_by = $1, manager_decided_at = NOW(),
			       manager_note = NULLIF($4,''), updated_at = NOW()
			 WHERE r.id = $2
			   AND r.status = 'pending_manager'
			   AND (r.routed_to_manager = $1
			        -- The escalation approver, and ONLY while the routed one is away.
			        -- This widens who may act; it does not widen what is recorded —
			        -- manager_decided_by is the actor, so a decision taken on somebody
			        -- else's behalf is visibly that. The second approver comes from the
			        -- HR roster (migration 380), not from a role, so nobody is invented.
			        OR (COALESCE(app.is_unavailable(r.routed_to_manager), FALSE)
			            AND $1 = (SELECT u.escalation_manager_user_id
			                        FROM app.o3c_users u WHERE u.id = r.user_id)))`,
			user.ID, chi.URLParam(r, "id"), next, strings.TrimSpace(b.Note))
		if err != nil {
			leaveWriteErr(w, err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, http.StatusConflict,
				"That request is not awaiting your decision — it may already have been decided")
			return
		}
		// Tell the person, and on approval tell HR that something is now waiting on
		// them. Without this the requester had to keep reopening the page to find out,
		// and HR had no signal at all that the queue had grown.
		leaveNotifyDecision(r.Context(), db, chi.URLParam(r, "id"), next, user.FullName, strings.TrimSpace(b.Note), "manager")
		if next == "rejected" {
			respondOK(w, "Leave request rejected")
			return
		}
		respondOK(w, "Approved and passed to HR to confirm")
	}
}

// leaveNotifyDecision tells the people a decision affects.
//
// Called after the guarded UPDATE has already succeeded, so it describes something that
// definitely happened. Best-effort throughout: a notification that fails must never turn
// a recorded decision into an error the approver sees, because the decision is the fact
// and the message is only its announcement.
//
// stage is "manager" or "hr", and it decides who hears:
//
//	manager approve  the requester (it moved on), and HR (something now waits on them)
//	manager reject   the requester only — HR never needs to see what did not reach them
//	hr      either   the requester, and the manager who approved it. The manager matters
//	                 on approval because from that moment app.on_leave starts excluding
//	                 their report from automatic distribution, which changes their team's
//	                 capacity whether or not they are watching.
//
// One more case: when manager_decided_by is not the routed manager, somebody decided in
// their place while they were away, and the routed manager is told. Otherwise they come
// back to a queue with no trace of a request they know was submitted.
func leaveNotifyDecision(ctx context.Context, db *core.DB, reqID, next, actorName, note, stage string) {
	rows, err := db.PGQuery(ctx, `
		SELECT r.user_id, r.routed_to_manager, r.manager_decided_by,
		       r.start_date, r.end_date, t.name AS leave_type
		  FROM app.leave_requests r
		  JOIN app.leave_types t ON t.id = r.leave_type_id
		 WHERE r.id = $1::bigint`, reqID)
	if err != nil || len(rows) == 0 {
		return
	}
	row := rows[0]
	requester := toInt64(row["user_id"])
	manager := toInt64(row["routed_to_manager"])
	decidedBy := toInt64(row["manager_decided_by"])
	window := fmt.Sprintf("%v to %v", row["start_date"], row["end_date"])
	typeName := fmt.Sprintf("%v", row["leave_type"])

	outcome := "approved"
	if next == "rejected" {
		outcome = "declined"
	}
	body := fmt.Sprintf("%s %s your %s request for %s.", actorName, outcome, typeName, window)
	if note != "" {
		body += " Note: " + note
	}
	if next != "rejected" && stage == "manager" {
		body += " It now waits on HR to confirm."
	}

	Notify(ctx, db, NotifPayload{
		EventType: "leave_request",
		UserID:    requester,
		Title:     "Your leave request was " + outcome,
		Body:      body,
		ActionURL: "/leave",
		EntityRef: "leave_request:" + reqID,
		Priority:  "high",
	})

	if stage == "manager" && next != "rejected" {
		NotifyRole(ctx, db, "hr", NotifPayload{
			EventType: "leave_request",
			Title:     "Leave approved by a manager, awaiting your confirmation",
			Body:      fmt.Sprintf("%s for %s, approved by %s.", typeName, window, actorName),
			ActionURL: "/leave",
			EntityRef: "leave_request:" + reqID,
			// One live item however many are queued, for the same reason the approver's
			// own notification is grouped: a per-request ping stops being read.
			GroupKey: "leave_pending_hr",
		})
	}
	// Somebody decided this in the line manager's place, which they may do only while
	// that manager is away. Tell the manager, because they will come back to a request
	// that is no longer theirs to act on and the absence of any trace of it reads like
	// the system lost it.
	if stage == "manager" && manager != 0 && decidedBy != 0 && decidedBy != manager {
		Notify(ctx, db, NotifPayload{
			EventType: "leave_request",
			UserID:    manager,
			Title:     "Leave for your report was " + outcome + " while you were away",
			Body:      body + " You were unavailable, so it was decided by the approver above you.",
			ActionURL: "/leave",
			EntityRef: "leave_request:" + reqID,
		})
	}
	if stage == "hr" && manager != 0 && manager != requester {
		Notify(ctx, db, NotifPayload{
			EventType: "leave_request",
			UserID:    manager,
			Title:     "HR " + outcome + " leave you approved",
			Body:      body,
			ActionURL: "/leave",
			EntityRef: "leave_request:" + reqID,
		})
	}
}

// leaveNextStatus maps a decision word to the status it produces. approveTo differs
// by stage: the manager's approval produces pending_hr, HR's produces approved.
func leaveNextStatus(decision, approveTo string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(decision)) {
	case "approve", "approved":
		return approveTo, true
	case "reject", "rejected":
		return "rejected", true
	}
	return "", false
}

/* ── HR ─────────────────────────────────────────────────────────────────────── */

func leaveHRDecision(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		var b leaveDecisionBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		next, ok := leaveNextStatus(b.Decision, "approved")
		if !ok {
			respondErr(w, http.StatusBadRequest, "decision must be approve or reject")
			return
		}
		if next == "rejected" && strings.TrimSpace(b.Note) == "" {
			respondErr(w, http.StatusBadRequest, "Please give a reason when rejecting a leave request")
			return
		}

		// status = 'pending_hr' is the guard: HR confirms what a manager approved, so
		// this cannot reach into a request the manager has not seen.
		res, err := db.PGExec(r.Context(), `
			UPDATE app.leave_requests
			   SET status = $3,
			       hr_decided_by = $1, hr_decided_at = NOW(),
			       hr_note = NULLIF($4,''), updated_at = NOW()
			 WHERE id = $2 AND status = 'pending_hr'`,
			user.ID, chi.URLParam(r, "id"), next, strings.TrimSpace(b.Note))
		if err != nil {
			leaveWriteErr(w, err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, http.StatusConflict,
				"That request is not awaiting HR confirmation")
			return
		}
		// The final word, so it goes to the requester and to the manager who approved
		// it — the manager needs to know their report is actually off, because from
		// here app.on_leave starts excluding that person from automatic distribution.
		leaveNotifyDecision(r.Context(), db, chi.URLParam(r, "id"), next, user.FullName, strings.TrimSpace(b.Note), "hr")
		if next == "rejected" {
			respondOK(w, "Leave request rejected")
			return
		}
		respondOK(w, "Leave approved")
	}
}

func leaveAdminRequests(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := []string{"1=1"}
		var args []any

		status := qstr(r, "status")
		switch {
		case status == "" || status == "outstanding":
			where = append(where, "r.status IN ('pending_manager','pending_hr')")
		case status == "all":
		case leaveStatuses[status]:
			args = append(args, status)
			where = append(where, fmt.Sprintf("r.status = $%d", len(args)))
		default:
			respondErr(w, http.StatusBadRequest, "unknown status filter")
			return
		}
		if from, err := validDate(r, "date_from"); err != nil {
			respondErr(w, http.StatusBadRequest, err.Error())
			return
		} else if from != "" {
			args = append(args, from)
			where = append(where, fmt.Sprintf("r.end_date >= $%d::date", len(args)))
		}
		if to, err := validDate(r, "date_to"); err != nil {
			respondErr(w, http.StatusBadRequest, err.Error())
			return
		} else if to != "" {
			args = append(args, to)
			where = append(where, fmt.Sprintf("r.start_date <= $%d::date", len(args)))
		}
		if dept := qstr(r, "department"); dept != "" {
			args = append(args, dept)
			where = append(where, fmt.Sprintf("btrim(COALESCE(u.department,'')) = $%d", len(args)))
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT r.id, r.user_id, u.full_name, u.department,
			       t.name AS leave_type, t.is_paid,
			       r.start_date, r.end_date, r.working_days, r.status,
			       r.reason, r.document_ref,
			       (t.requires_docs AND r.document_ref IS NULL) AS documents_outstanding,
			       r.cover_user_id, c.full_name AS cover_name,
			       r.routed_to_manager, m.full_name AS manager_name,
			       r.manager_decided_at, mb.full_name AS manager_decided_by_name, r.manager_note,
			       r.hr_decided_at, hb.full_name AS hr_decided_by_name, r.hr_note,
			       r.created_at
			FROM app.leave_requests r
			JOIN app.o3c_users  u ON u.id = r.user_id
			JOIN app.leave_types t ON t.id = r.leave_type_id
			LEFT JOIN app.o3c_users c  ON c.id  = r.cover_user_id
			LEFT JOIN app.o3c_users m  ON m.id  = r.routed_to_manager
			LEFT JOIN app.o3c_users mb ON mb.id = r.manager_decided_by
			LEFT JOIN app.o3c_users hb ON hb.id = r.hr_decided_by
			WHERE %s
			ORDER BY (r.status = 'pending_hr') DESC, r.start_date
			LIMIT 500`, strings.Join(where, " AND ")), args...)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read leave requests", err)
			return
		}
		respond(w, rows, "app.leave_requests")
	}
}

func leaveEntitlements(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		year := qint(r, "year", time.Now().Year(), 2020, 2100)
		rows, err := db.PGQuery(r.Context(), `
			SELECT user_id, full_name, role, year, leave_type_id, leave_type,
			       days_entitled, days_carried_over, days_taken, days_pending, days_remaining
			FROM app.v_leave_balance
			WHERE year = $1
			ORDER BY full_name, leave_type`, year)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read entitlements", err)
			return
		}
		respond(w, rows, "app.v_leave_balance")
	}
}

type leaveEntitlementBody struct {
	UserID          int64    `json:"user_id"`
	LeaveTypeID     int      `json:"leave_type_id"`
	Year            int      `json:"year"`
	DaysEntitled    *float64 `json:"days_entitled"`
	DaysCarriedOver *float64 `json:"days_carried_over"`
	Notes           string   `json:"notes"`
}

// leaveSetEntitlement records what one person is entitled to. Upsert on the natural
// key, because "set Ada's 2027 annual leave to 22" is one decision whether or not a
// row already exists, and set_by/updated_at keep the trail of who changed it.
//
// days_carried_over is NOT validated against the type's carry_over_max. HR carries a
// year over as an agreed exception often enough that a hard ceiling would be wrong;
// the max is what the standard says, and app.v_leave_balance reports both.
func leaveSetEntitlement(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		var b leaveEntitlementBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if b.UserID <= 0 || b.LeaveTypeID <= 0 {
			respondErr(w, http.StatusBadRequest, "user_id and leave_type_id are required")
			return
		}
		if b.Year < 2020 || b.Year > 2100 {
			respondErr(w, http.StatusBadRequest, "year must be between 2020 and 2100")
			return
		}
		if b.DaysEntitled == nil || *b.DaysEntitled < 0 {
			respondErr(w, http.StatusBadRequest, "days_entitled is required and cannot be negative")
			return
		}
		carried := 0.0
		if b.DaysCarriedOver != nil {
			if *b.DaysCarriedOver < 0 {
				respondErr(w, http.StatusBadRequest, "days_carried_over cannot be negative")
				return
			}
			carried = *b.DaysCarriedOver
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.leave_entitlements
			    (user_id, leave_type_id, year, days_entitled, days_carried_over, notes, set_by)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6,''), $7)
			ON CONFLICT (user_id, leave_type_id, year) DO UPDATE
			   SET days_entitled     = EXCLUDED.days_entitled,
			       days_carried_over = EXCLUDED.days_carried_over,
			       notes             = EXCLUDED.notes,
			       set_by            = EXCLUDED.set_by,
			       updated_at        = NOW()
			RETURNING id, user_id, leave_type_id, year, days_entitled, days_carried_over`,
			b.UserID, b.LeaveTypeID, b.Year, *b.DaysEntitled, carried,
			strings.TrimSpace(b.Notes), user.ID)
		if err != nil {
			leaveWriteErr(w, err)
			return
		}
		respond(w, rows, "app.leave_entitlements")
	}
}

func leaveGaps(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT user_id, full_name, role, department, hire_date,
			       year, leave_type_id, leave_type, suggested_days
			FROM app.v_leave_entitlement_gaps
			ORDER BY full_name, leave_type`)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read entitlement gaps", err)
			return
		}
		respond(w, rows, "app.v_leave_entitlement_gaps")
	}
}

// leaveUnmanaged is the list that has to be empty before anybody can request leave.
// Served under the leave gate rather than borrowed from /api/people, whose
// people_directory grant HR holds but which would tie this page to a second gate.
func leaveUnmanaged(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id AS user_id, u.full_name, u.role, u.department, u.hire_date,
			       (u.hire_date IS NULL) AS hire_date_missing
			FROM app.o3c_users u
			WHERE u.is_active AND u.deleted_at IS NULL
			  AND u.manager_user_id IS NULL
			ORDER BY u.department NULLS LAST, u.full_name`)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read the manager gaps", err)
			return
		}
		respond(w, rows, "app.o3c_users")
	}
}

// leaveDrift surfaces approved periods whose day count no longer matches the
// calendar, because a holiday was declared after the leave was agreed. Reported and
// never applied: crediting a day back restates an agreed balance, which is HR's
// decision and not a worker's.
func leaveDrift(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT leave_request_id, user_id, full_name, start_date, end_date,
			       days_agreed, days_by_calendar_now, difference
			FROM app.v_leave_daycount_drift
			ORDER BY start_date DESC`)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read day-count drift", err)
			return
		}
		respond(w, rows, "app.v_leave_daycount_drift")
	}
}

// leaveLookups feeds HR's forms: who can be given an entitlement or named as a
// manager, and the types. Deliberately the minimum set of staff columns — this is
// not a second route to the staff register.
func leaveLookups(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{}
		if rows, err := db.PGQuery(ctx, `
			SELECT u.id, u.full_name, u.department, u.role, u.hire_date,
			       u.manager_user_id, m.full_name AS manager_name
			FROM app.o3c_users u
			LEFT JOIN app.o3c_users m ON m.id = u.manager_user_id
			WHERE u.is_active AND u.deleted_at IS NULL
			ORDER BY u.full_name`); err == nil {
			out["staff"] = rows
		}
		if rows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT %s FROM app.leave_types t WHERE t.is_active
			ORDER BY t.sort_order, t.name`, leaveTypeColumns)); err == nil {
			out["leave_types"] = rows
		}
		respond(w, out, "app.o3c_users, app.leave_types")
	}
}

/* ── Calendar ───────────────────────────────────────────────────────────────── */

// leaveCalendar answers "who is out, and who is covering" for everybody, because
// that is an operational question any colleague may legitimately have.
//
// THE LEAVE TYPE IS WITHHELD PER ROW. Knowing a colleague is away is routine; knowing
// they are on sick leave is medical information, and compassionate leave is worse. So
// the type is returned only to the person themselves, to the manager the request was
// routed to, and to HR — everyone else sees the absence and not its reason. Decided
// in SQL per row rather than by serving a different endpoint to each audience, so
// there is no second query that could be wired up without the rule.
func leaveCalendar(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		from, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, http.StatusBadRequest, err.Error())
			return
		}
		to, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if from == "" {
			from = time.Now().Format(leaveDateFmt)
		}
		if to == "" {
			to = time.Now().AddDate(0, 0, 60).Format(leaveDateFmt)
		}

		args := []any{user.ID, from, to, user.HasPage(leaveAdminPage)}
		clause := ""
		if dept := qstr(r, "department"); dept != "" {
			args = append(args, dept)
			clause = fmt.Sprintf(" AND btrim(COALESCE(v.department,'')) = $%d", len(args))
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT v.leave_request_id, v.user_id, v.full_name, v.role, v.department,
			       v.start_date, v.end_date, v.working_days, v.status,
			       v.cover_user_id, v.cover_name,
			       CASE WHEN $4::boolean
			             OR v.user_id = $1
			             OR v.routed_to_manager = $1
			            THEN v.leave_type END AS leave_type
			FROM app.v_leave_calendar v
			WHERE v.start_date <= $3::date AND v.end_date >= $2::date`+clause+`
			ORDER BY v.start_date, v.full_name
			LIMIT 500`, args...)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read the leave calendar", err)
			return
		}
		respond(w, map[string]any{"from": from, "to": to, "absences": rows},
			"app.v_leave_calendar")
	}
}

/* ── Employment basics: the two facts leave depends on ──────────────────────── */

// leaveSetEmployment writes o3c_users.manager_user_id and hire_date. It is the ONLY
// writer of either column anywhere in the codebase.
//
// WHY IT EXISTS. Submission is refused when nobody manages you, and the entitlement
// gap list derives its pro-rata suggestion from hire_date. Both columns were readable
// and neither was settable, which made that refusal a dead end rather than a prompt:
// HR could see all 50 names on /admin/unmanaged and had no way to clear a single one.
// A gate nothing can satisfy is worse than no gate at all.
//
// WHY A PAGE KEY HERE WHEN MOST OF LEAVE HAS NONE. Who reports to whom is a company
// decision, like an entitlement, so it sits behind leave_admin alongside HR's other
// write. Admin reaches it as well, because core.RequirePages short-circuits for the
// super-user.
//
// WHY set_manager / set_hire_date RATHER THAN JUST THE VALUES. A null manager has to
// mean two different things — "clear it" and "leave it alone" — and JSON cannot tell
// an absent field from a null one. The flags make the caller state which decision
// they are making, so a form that only touches the reporting line cannot silently
// wipe a hire date somebody else entered.
//
// It takes a LIST because the opening state is 50 people with no manager, and a
// chore done one request at a time is the kind that gets abandoned half finished.
// Self-management, a cycle and a departed manager are refused by migration 374's
// constraint, FK and trigger respectively; leaveWriteErr turns those into English.
// The id-in-list check below exists only so the bulk case names the problem before
// the database rejects the whole statement.
type leaveEmploymentBody struct {
	UserIDs       []int64 `json:"user_ids"`
	SetManager    bool    `json:"set_manager"`
	ManagerUserID *int64  `json:"manager_user_id"`
	SetHireDate   bool    `json:"set_hire_date"`
	HireDate      *string `json:"hire_date"`
}

func leaveSetEmployment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		var b leaveEmploymentBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if len(b.UserIDs) == 0 {
			respondErr(w, http.StatusBadRequest, "user_ids is required")
			return
		}
		if len(b.UserIDs) > 200 {
			respondErr(w, http.StatusBadRequest, "that is more than 200 people in one request")
			return
		}
		if !b.SetManager && !b.SetHireDate {
			respondErr(w, http.StatusBadRequest,
				"nothing to change — set set_manager or set_hire_date")
			return
		}

		if b.SetManager && b.ManagerUserID != nil {
			for _, id := range b.UserIDs {
				if id == *b.ManagerUserID {
					respondErr(w, http.StatusBadRequest,
						"Somebody cannot be their own line manager, and they are in the list you are assigning")
					return
				}
			}
			// Checked before the UPDATE so the message names the real problem. The FK
			// catches an id that does not exist, but NOT one belonging to somebody who
			// has left — a leaver can still be referenced, and then nobody can approve.
			mgr, err := db.PGQuery(r.Context(), `
				SELECT full_name FROM app.o3c_users
				 WHERE id = $1 AND is_active AND deleted_at IS NULL`, *b.ManagerUserID)
			if err != nil {
				respondErrLog(w, http.StatusInternalServerError, "could not check the line manager", err)
				return
			}
			if len(mgr) == 0 {
				respondErr(w, http.StatusBadRequest,
					"That line manager is not an active member of staff")
				return
			}
		}

		// nil stays nil deliberately: set_hire_date with no date is how a wrong date
		// gets cleared, which is different from not touching the column at all.
		var hire any
		if b.SetHireDate && b.HireDate != nil && strings.TrimSpace(*b.HireDate) != "" {
			d, err := time.Parse(leaveDateFmt, strings.TrimSpace(*b.HireDate))
			if err != nil {
				respondErr(w, http.StatusBadRequest, "hire_date must be YYYY-MM-DD")
				return
			}
			// A start date in the future is legitimate — somebody joining next month —
			// so it is allowed. Anything far out is far likelier a mistyped year.
			if d.Year() < 1970 || d.After(time.Now().AddDate(1, 0, 0)) {
				respondErr(w, http.StatusBadRequest,
					"hire_date must be a real date, and not more than a year ahead")
				return
			}
			hire = d.Format(leaveDateFmt)
		}

		// One guarded UPDATE. The CASE arms are what make the flags work: a column the
		// caller did not ask to change is written back to itself rather than nulled.
		// Restricted to live staff, so an id that has left is skipped rather than
		// quietly given a reporting line — and the rows returned show what landed.
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.o3c_users u
			   SET manager_user_id = CASE WHEN $2::boolean THEN $3::bigint
			                              ELSE u.manager_user_id END,
			       hire_date       = CASE WHEN $4::boolean THEN $5::date
			                              ELSE u.hire_date END,
			       updated_at      = NOW()
			 WHERE u.id = ANY($1::bigint[])
			   AND u.is_active AND u.deleted_at IS NULL
			RETURNING u.id, u.full_name, u.hire_date, u.manager_user_id`,
			b.UserIDs, b.SetManager, b.ManagerUserID, b.SetHireDate, hire)
		if err != nil {
			leaveWriteErr(w, err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, http.StatusNotFound,
				"None of those accounts are active members of staff")
			return
		}
		respond(w, rows, "app.o3c_users")
	}
}
