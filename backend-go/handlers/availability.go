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

/*
AVAILABILITY — saying that somebody is away, and letting every queue ask.

WHY THIS EXISTS, MEASURED. A sales head in Lagos was unavailable and kept being given
forwarded leads: 21 sat accepted-but-unworked on his name, averaging 3.4 days against a
four-hour pickup promise, and one arrived the same afternoon this was written. Nothing
was malfunctioning. There was simply no way to record that a person is away, so there
was nothing for a queue to respect.

TWO KINDS OF ABSENCE, ONE ANSWER. Approved leave already existed (migration 374) and was
consulted by nothing outside the leave module. It also cannot describe the common case:
an emergency this morning, a day in the field, somebody seconded to another task. Nobody
files a leave request for those. So migration 378 adds app.staff_unavailability for the
ad-hoc half and app.is_unavailable() to fold both together with account state — one
predicate, asked the same way by every queue, instead of each module inventing its own
test and drifting.

WARN FOR PEOPLE, EXCLUDE FOR MACHINES. The business decision taken on 2026-10-19:

  a human assigning by hand    sees the absence and may still assign deliberately.
                               The dropdown does NOT hide them. Hiding them would also
                               mean that a whole team being away leaves work with
                               nowhere to go, which is worse than a visible override.

  automatic distribution       excludes them outright. Round-robin and least-busy are
                               nobody's judgement, so there is no one to show a warning
                               to and nothing to override.

That is why this file exposes availability as DATA on the candidate lists rather than as
a filter, and why app.is_unavailable() is applied inside the automatic pools instead.

WHAT THIS DELIBERATELY DOES NOT DO. It does not reassign anybody's existing work. The
attribution rules in this codebase are emphatic — moving a customer moves commission
(officer_overrides.go), moving a lead can move conversion credit
(call_center_outbound.go:945), and migration 365 states that no approver is ever
invented. Of the work a person actually holds, the unclocked majority (recovery cases,
collections rows, the relationship book) loses nothing by waiting and everything by
being churned for a two-day absence. So absence makes work VISIBLE, never reassigned.
*/

// Who may record somebody else's absence. Self is handled separately: anybody may mark
// themselves away, because the whole point is that an emergency can be recorded without
// waiting for someone to approve it.
const availabilityAdminPage = "leave_admin"

// unavailabilityKinds mirrors the CHECK on app.staff_unavailability. Kept here so a bad
// value is a 400 naming the options rather than a 500 from the constraint.
var unavailabilityKinds = map[string]bool{
	"emergency": true, "sick": true, "field_work": true,
	"reassigned": true, "training": true, "personal": true, "other": true,
}

func RegisterAvailability(r chi.Router, db *core.DB) {
	// Who is available right now, with the reason and the cover where not. Open to any
	// signed-in user: this is the list every assign dropdown joins, and withholding it
	// would just mean each screen guessing.
	r.Get("/", availabilityList(db))

	// Record and lift an absence. Authorisation is per-subject and checked in the
	// handler, because "self, their line manager, HR, or a department head" is a fact
	// about the relationship between two users — not a page grant. Same reasoning as
	// leave.go: being somebody's manager is data, not a role.
	r.Post("/", availabilitySet(db))
	r.Post("/{id}/cancel", availabilityCancel(db))

	// What is sitting on people who are away. The answer to "he is off, what of his is
	// now at risk" — and deliberately a report rather than a reassignment.
	r.Get("/held", availabilityHeldWork(db))

	// The list an assign-to dropdown should be built from. See availabilityAssignable.
	r.Get("/assignable", availabilityAssignable(db))
}

// availabilityAssignable answers one question: who can I hand work to?
//
// WHY IT EXISTS, MEASURED. Three Collections screens built their assignee picker from
// GET /api/admin/users — Queue.tsx, AccountDetail.tsx and Portfolio.tsx. That route sits
// behind RequirePages("admin_users", "admin"), which no collections role holds, so for
// every non-admin it returned 403. In Portfolio the picker was merely always empty; in
// Queue the call shares a Promise.all with the queue itself, so the 403 rejected both and
// the page showed an error with no rows — the queue had loaded fine and was thrown away.
// A supervisor could not reassign a row, and nothing said why.
//
// It is also the right shape for the eighteen hand-assignment endpoints: it carries
// availability as DATA, so a dropdown can show "away until Thursday, cover Blessing Obi"
// beside a name and still let somebody pick them. That is the warn-a-person half of the
// decision; the exclude-a-machine half lives inside the automatic pools.
//
// Open to any signed-in user, like availabilityList: picking a colleague from a list is
// not an administrative act, and every screen that cannot ask has to guess instead.
func availabilityAssignable(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Only people who could actually do the work: a suspended or deactivated account
		// cannot sign in, so offering it as an assignee is offering a dead end. This is
		// the one place availability is a filter rather than a flag, and only for account
		// state — being away is temporary and is reported, never hidden.
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id, u.full_name, u.role, u.department, u.email,
			       COALESCE(av.available, TRUE) AS available,
			       av.unavailable_kind, av.unavailable_until, av.unavailable_reason,
			       av.cover_user_id, av.cover_name
			  FROM app.o3c_users u
			  LEFT JOIN app.v_staff_availability av ON av.user_id = u.id
			 WHERE u.is_active AND u.deleted_at IS NULL AND u.suspended_at IS NULL
			 ORDER BY COALESCE(av.available, TRUE) DESC, u.full_name`)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read who can be assigned work", err)
			return
		}
		respond(w, rows, "app.o3c_users + app.v_staff_availability")
	}
}

// ── Who is available ────────────────────────────────────────────────────────

func availabilityList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// onlyUnavailable lets a screen ask the short question cheaply; the default is
		// everybody, because the dropdown case needs the available ones too.
		where := ""
		if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("state")), "unavailable") {
			where = " WHERE NOT available"
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT user_id, full_name, role, department, available,
			       unavailable_kind, unavailable_until, unavailable_reason,
			       cover_user_id, cover_name
			  FROM app.v_staff_availability`+where+`
			 ORDER BY available, full_name`)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read availability", err)
			return
		}
		respond(w, rows, "app.v_staff_availability")
	}
}

// ── Recording an absence ────────────────────────────────────────────────────

type availabilityBody struct {
	UserID      int64  `json:"user_id"`
	FromDate    string `json:"from_date"`
	ToDate      string `json:"to_date"`
	Kind        string `json:"kind"`
	Reason      string `json:"reason"`
	CoverUserID *int64 `json:"cover_user_id"`
}

// mayRecordAbsenceFor answers whether `actor` may mark `subject` away.
//
// Four routes, and the first is the one that matters most: a person may always mark
// THEMSELVES away. An emergency that has to wait for a manager to be found is not
// recorded, and an unrecorded absence is exactly the state this whole change exists to
// end. The other three come from the question put to the business on 2026-10-19.
func mayRecordAbsenceFor(ctx context.Context, db *core.DB, actor *core.Claims, subject int64) (bool, string) {
	if actor == nil {
		return false, "Unauthorized"
	}
	if actor.ID == subject {
		return true, ""
	}
	// Admin and anyone holding HR's write grant. core.RequirePages short-circuits for
	// admin, but this is a hand-rolled check so admin is named explicitly.
	if actor.Role == core.RoleAdmin || actor.HasPage(availabilityAdminPage) {
		return true, ""
	}
	// The recorded line manager — the same fact leave approval routes on — and the level
	// HR names above them, which is a different fact and not derivable from the chain
	// (migration 380: 11 of 50 rows disagree with "my lead's lead"). The escalation
	// approver counts here unconditionally rather than only while the lead is away: the
	// lead being away is one of the things that most needs recording, and requiring them
	// to be marked away first to let somebody mark them away is circular.
	rows, err := db.PGQuery(ctx, `
		SELECT (u.manager_user_id = $2)            AS is_manager,
		       (u.escalation_manager_user_id = $2) AS is_escalation,
		       (COALESCE(NULLIF(btrim(u.department),''), '~none') =
		        COALESCE(NULLIF(btrim(m.department),''), '~other')) AS same_department
		  FROM app.o3c_users u CROSS JOIN app.o3c_users m
		 WHERE u.id = $1 AND m.id = $2`, subject, actor.ID)
	if err != nil || len(rows) == 0 {
		return false, "Could not establish your relationship to that member of staff"
	}
	if b, _ := rows[0]["is_manager"].(bool); b {
		return true, ""
	}
	if b, _ := rows[0]["is_escalation"].(bool); b {
		return true, ""
	}
	// A department head, for anybody in their department. Heads are named by the role
	// suffix the auth layer already uses, so a new *_head role is covered without
	// another edit here.
	if strings.HasSuffix(actor.Role, "_head") || actor.Role == "head_ops" || actor.Role == "coo" {
		if b, _ := rows[0]["same_department"].(bool); b {
			return true, ""
		}
		return false, "You can mark somebody unavailable in your own department, and this person is in another"
	}
	return false, "Only this person, their line manager, the approver above that manager, their department head or HR can mark them unavailable"
}

func availabilitySet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		var b availabilityBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if b.UserID == 0 {
			b.UserID = user.ID // omitting user_id means "me"
		}
		if ok, why := mayRecordAbsenceFor(r.Context(), db, user, b.UserID); !ok {
			respondErr(w, http.StatusForbidden, why)
			return
		}
		if !unavailabilityKinds[b.Kind] {
			respondErr(w, http.StatusBadRequest,
				"kind must be one of: emergency, sick, field_work, reassigned, training, personal, other")
			return
		}
		from, to, err := availabilityDates(b.FromDate, b.ToDate)
		if err != nil {
			respondErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if b.CoverUserID != nil && *b.CoverUserID == b.UserID {
			respondErr(w, http.StatusBadRequest, "Somebody cannot cover for themselves")
			return
		}
		// A cover who has left, or who is themselves away, is worse than no cover: the
		// work would be routed into a second silence. Checked before the insert so the
		// message names the real problem.
		if b.CoverUserID != nil {
			rows, qerr := db.PGQuery(r.Context(), `
				SELECT full_name, app.is_unavailable(id, $2::date) AS also_away
				  FROM app.o3c_users WHERE id = $1 AND is_active AND deleted_at IS NULL`,
				*b.CoverUserID, from)
			if qerr != nil {
				respondErrLog(w, http.StatusInternalServerError, "could not check the cover", qerr)
				return
			}
			if len(rows) == 0 {
				respondErr(w, http.StatusBadRequest, "That cover is not an active member of staff")
				return
			}
			if away, _ := rows[0]["also_away"].(bool); away {
				respondErr(w, http.StatusBadRequest,
					"That cover is themselves unavailable on the first day of this absence")
				return
			}
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.staff_unavailability
			    (user_id, from_date, to_date, kind, reason, cover_user_id, set_by)
			VALUES ($1, $2::date, $3::date, $4, NULLIF($5,''), $6, $7)
			RETURNING id, user_id, from_date, to_date, kind, reason, cover_user_id`,
			b.UserID, from, to, b.Kind, strings.TrimSpace(b.Reason), b.CoverUserID, user.ID)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not record the absence", err)
			return
		}

		// Tell the people whose work this changes. Not the whole company: the person
		// themselves (unless they recorded it), their cover, and their line manager.
		availabilityNotify(r, db, b.UserID, user, from, to, b.Kind, b.CoverUserID)
		respond(w, rows, "app.staff_unavailability")
	}
}

// availabilityDates parses and bounds the window.
//
// A blank from_date means today, because the overwhelmingly common case is "he is not
// in today". A blank to_date means the same day, not "for ever": an absence with no end
// is how somebody silently drops out of every rota, and the cost of saying so again
// tomorrow is one click.
func availabilityDates(fromStr, toStr string) (string, string, error) {
	today := time.Now().Format(leaveDateFmt)
	from := strings.TrimSpace(fromStr)
	if from == "" {
		from = today
	}
	to := strings.TrimSpace(toStr)
	if to == "" {
		to = from
	}
	fd, err := time.Parse(leaveDateFmt, from)
	if err != nil {
		return "", "", fmt.Errorf("from_date must be YYYY-MM-DD")
	}
	td, err := time.Parse(leaveDateFmt, to)
	if err != nil {
		return "", "", fmt.Errorf("to_date must be YYYY-MM-DD")
	}
	if td.Before(fd) {
		return "", "", fmt.Errorf("to_date cannot be before from_date")
	}
	// A year is already far longer than this record is for. Anything longer is leave,
	// a secondment or a leaver, and all three have their own proper handling.
	if td.Sub(fd) > 366*24*time.Hour {
		return "", "", fmt.Errorf("an absence longer than a year is not an absence — use leave, or deactivate the account")
	}
	return fd.Format(leaveDateFmt), td.Format(leaveDateFmt), nil
}

func availabilityNotify(r *http.Request, db *core.DB, subject int64, actor *core.Claims,
	from, to, kind string, cover *int64) {
	ctx := r.Context()
	rows, _ := db.PGQuery(ctx, `
		SELECT u.full_name AS who, u.manager_user_id
		  FROM app.o3c_users u WHERE u.id = $1`, subject)
	if len(rows) == 0 {
		return
	}
	who := str(rows[0]["who"])
	window := from
	if to != from {
		window = from + " to " + to
	}

	// The person, when somebody else recorded it for them — so an absence is never
	// recorded about you without your knowing.
	if actor.ID != subject {
		Notify(ctx, db, NotifPayload{
			EventType: "staff_unavailable",
			UserID:    subject,
			Title:     "You have been marked unavailable",
			Body:      fmt.Sprintf("%s recorded you as unavailable (%s) for %s.", actor.FullName, kind, window),
			ActionURL: "/leave",
			EntityRef: "staff_unavailability:" + strconv.FormatInt(subject, 10),
		})
	}
	// The cover, because they are about to start receiving the time-critical half.
	if cover != nil && *cover != 0 {
		Notify(ctx, db, NotifPayload{
			EventType: "staff_unavailable",
			UserID:    *cover,
			Title:     "You are covering for " + who,
			Body: fmt.Sprintf("%s is unavailable (%s) for %s, and you are recorded as their cover.",
				who, kind, window),
			ActionURL: "/leave",
			EntityRef: "staff_unavailability:" + strconv.FormatInt(subject, 10),
			Priority:  "high",
		})
	}
	// The line manager, unless they are the one who recorded it.
	if mgr := toInt64(rows[0]["manager_user_id"]); mgr != 0 && mgr != actor.ID && mgr != subject {
		Notify(ctx, db, NotifPayload{
			EventType: "staff_unavailable",
			UserID:    mgr,
			Title:     who + " is unavailable",
			Body:      fmt.Sprintf("%s (%s) for %s. Work already on their name is listed under Leave → Unavailable.", who, kind, window),
			ActionURL: "/leave",
			EntityRef: "staff_unavailability:" + strconv.FormatInt(subject, 10),
		})
	}
}

// ── Lifting an absence ──────────────────────────────────────────────────────

func availabilityCancel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || id <= 0 {
			respondErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		// Read the subject first so the same authorisation rule applies to lifting an
		// absence as to recording one. Anyone who could mark you away can mark you back.
		own, qerr := db.PGQuery(r.Context(), `
			SELECT user_id FROM app.staff_unavailability WHERE id = $1 AND cancelled_at IS NULL`, id)
		if qerr != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read that absence", qerr)
			return
		}
		if len(own) == 0 {
			respondErr(w, http.StatusNotFound, "No open absence with that id")
			return
		}
		subject := toInt64(own[0]["user_id"])
		if ok, why := mayRecordAbsenceFor(r.Context(), db, user, subject); !ok {
			respondErr(w, http.StatusForbidden, why)
			return
		}
		// Cancelled, never deleted: "he was marked away and it was lifted at 10am" is a
		// different fact from "he was never marked away", and the first one explains why
		// a lead sat unclaimed for two hours.
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.staff_unavailability
			   SET cancelled_at = NOW(), cancelled_by = $2
			 WHERE id = $1 AND cancelled_at IS NULL
			RETURNING id, user_id, from_date, to_date, kind`, id, user.ID)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not lift that absence", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, http.StatusConflict, "That absence was already lifted")
			return
		}
		respond(w, rows, "app.staff_unavailability")
	}
}

// ── What is sitting on people who are away ──────────────────────────────────

// availabilityHeldWork answers "she is off — what of hers is now at risk", and answers
// it as a REPORT. Nothing here moves anything.
//
// The split is by whether a clock is running, because that is what decides whether
// absence costs anything:
//
//	clocked    a forwarded lead with a four-hour pickup promise, a callback promised to
//	           a customer at a named time, a promise-to-pay due today, a ticket against
//	           an SLA. These decay while nobody is looking, and in three of five cases
//	           the existing reminder goes to the absent person and nobody else.
//	unclocked  recovery cases, collections rows, the relationship book. They wait. They
//	           lose nothing by waiting and a great deal by being churned — moving a
//	           customer moves commission, moving a lead can move conversion credit.
//
// So the clocked column is the one to act on, and it is deliberately the smaller number.
func availabilityHeldWork(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH away AS (
			  SELECT user_id, full_name, unavailable_kind, unavailable_until,
			         cover_user_id, cover_name
			    FROM app.v_staff_availability
			   WHERE NOT available
			)
			SELECT a.user_id, a.full_name, a.unavailable_kind, a.unavailable_until,
			       a.cover_user_id, a.cover_name,

			       -- CLOCKED: a promise with a time on it.
			       (SELECT COUNT(*) FROM app.call_center_lead_forwards f
			         WHERE f.sales_owner_id = a.user_id
			           AND f.status IN ('forwarded','assigned'))              AS forwarded_leads,
			       (SELECT COUNT(*) FROM app.call_center_contacts c
			         WHERE c.assigned_to = a.user_id AND c.status = 'pending'
			           AND c.callback_at IS NOT NULL
			           AND c.callback_at <= NOW() + interval '1 day')         AS callbacks_due,
			       (SELECT COUNT(*) FROM app.collection_promises p
			         WHERE p.agent_user_id = a.user_id
			           AND p.actual_date IS NULL
			           AND COALESCE(p.is_kept, FALSE) = FALSE
			           AND p.promised_date <= CURRENT_DATE + 1)               AS promises_due,
			       (SELECT COUNT(*) FROM app.helpdesk_tickets t
			         WHERE t.assigned_to = a.user_id AND t.deleted_at IS NULL
			           AND t.status NOT IN ('resolved','closed'))             AS open_tickets,
			       (SELECT COUNT(*) FROM app.crm_contacts c
			         WHERE c.sales_owner_id = a.user_id
			           AND c.next_action_at IS NOT NULL
			           AND c.next_action_at <= NOW() + interval '1 day'
			           AND COALESCE(c.lead_stage,'') NOT IN ('converted','disqualified'))
			                                                                  AS follow_ups_due,

			       -- UNCLOCKED: ownership that merely waits. Shown so the picture is
			       -- complete, NOT because it should be moved.
			       (SELECT COUNT(*) FROM app.collection_assignments ca
			         WHERE ca.agent_user_id = a.user_id AND ca.status = 'active') AS collections_rows,
			       (SELECT COUNT(*) FROM app.recovery_cases rc
			         WHERE COALESCE(rc.assigned_agent_id, rc.assigned_to_user_id) = a.user_id
			           AND rc.status NOT IN ('closed','recovered','written_off')) AS recovery_cases,
			       (SELECT COUNT(*) FROM app.customer_officers co
			         WHERE co.officer_id = a.user_id)                        AS customers_owned,

			       -- BLOCKING: nobody else can act on these at all, so an absence here
			       -- stops other people's work rather than delaying their own.
			       (SELECT COUNT(*) FROM app.leave_requests lr
			         WHERE lr.routed_to_manager = a.user_id
			           AND lr.status = 'pending_manager')                     AS leave_approvals_waiting
			  FROM away a
			 ORDER BY a.full_name`)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read held work", err)
			return
		}
		respond(w, rows, "app.v_staff_availability")
	}
}
