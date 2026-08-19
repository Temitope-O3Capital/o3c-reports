package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// Correcting a call log.
//
// Until now a write-up was final. An agent who picked the wrong disposition, or
// whose notes landed on the wrong call, had no way to fix it — which is how
// contradictory rows accumulated and stayed. But a log an agent can silently
// rewrite is worse than one they cannot touch: the call log is the record of what
// was said to a customer, and it feeds QA scoring and lead status.
//
// So: agents may correct their own logs, supervisors may correct any, and every
// change is kept with who made it, when, and what it was before. Deleting is a
// void, not a DELETE — the row stays, marked, and a supervisor can restore it.

// hdCanSuperviseCalls reports whether the user may act on someone else's log.
func hdCanSuperviseCalls(u *core.Claims) bool {
	return u != nil && (u.HasPage("call_center_stats") || u.CanSeeAllRows())
}

// hdEditCall applies a correction and records what changed.
//
// Only notes, resolution, disposition, purpose, direction and duration may be
// corrected. Identity (customer, phone, agent) and telephony facts (started_at,
// recording) are deliberately not editable: those come from the exchange, and
// letting an agent rewrite them turns a correction into a way to reassign
// someone else's call to yourself.
func hdEditCall(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if id <= 0 {
			respondErr(w, 400, "Invalid call id")
			return
		}
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Sign in to edit a call log")
			return
		}

		var b struct {
			Notes       *string `json:"notes"`
			Resolution  *string `json:"resolution"`
			Disposition *string `json:"disposition"`
			Purpose     *string `json:"purpose"`
			Direction   *string `json:"direction"`
			DurationSec *int    `json:"duration_sec"`
			Reason      string  `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the correction")
			return
		}

		cur, err := db.PGQuery(r.Context(), `
			SELECT id, agent_id, agent_name, notes, resolution, disposition, purpose,
			       direction, duration_sec, voided_at, lead_id, outcome
			  FROM helpdesk_calls WHERE id = $1`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not load the call", err)
			return
		}
		if len(cur) == 0 {
			respondErr(w, 404, "No such call")
			return
		}
		row := cur[0]
		if row["voided_at"] != nil {
			respondErr(w, 409, "This log has been voided — restore it before editing")
			return
		}
		// Own log, or a supervisor.
		if toInt64(row["agent_id"]) != user.ID && !hdCanSuperviseCalls(user) {
			respondErr(w, 403, "You can only correct your own call logs")
			return
		}

		// A raw telephony word is not a disposition — same guard as logging.
		if b.Disposition != nil && isRawCallOutcome(*b.Disposition) {
			respondErr(w, 422, "That is a call outcome, not a disposition")
			return
		}

		set, args, changes := []string{}, []any{id}, map[string]any{}
		add := func(col string, oldVal, newVal any) {
			args = append(args, newVal)
			set = append(set, col+" = $"+strconv.Itoa(len(args)))
			changes[col] = map[string]any{"from": oldVal, "to": newVal}
		}
		if b.Notes != nil && strings.TrimSpace(*b.Notes) != str(row["notes"]) {
			add("notes", row["notes"], strings.TrimSpace(*b.Notes))
		}
		if b.Resolution != nil && strings.TrimSpace(*b.Resolution) != str(row["resolution"]) {
			add("resolution", row["resolution"], strings.TrimSpace(*b.Resolution))
		}
		if b.Disposition != nil && strings.TrimSpace(*b.Disposition) != str(row["disposition"]) {
			add("disposition", row["disposition"], strings.TrimSpace(*b.Disposition))
		}
		if b.Purpose != nil && strings.ToLower(strings.TrimSpace(*b.Purpose)) != str(row["purpose"]) {
			add("purpose", row["purpose"], strings.ToLower(strings.TrimSpace(*b.Purpose)))
		}
		if b.Direction != nil {
			d := strings.ToLower(strings.TrimSpace(*b.Direction))
			if d == "inbound" || d == "outbound" {
				if d != str(row["direction"]) {
					add("direction", row["direction"], d)
				}
			}
		}
		if b.DurationSec != nil && *b.DurationSec >= 0 && int64(*b.DurationSec) != toInt64(row["duration_sec"]) {
			add("duration_sec", row["duration_sec"], *b.DurationSec)
		}
		if len(set) == 0 {
			respondErr(w, 400, "Nothing changed")
			return
		}
		// A correction answers the question the review flag was asking.
		set = append(set, "needs_review = false", "reviewed_at = NOW()",
			"reviewed_by = "+strconv.FormatInt(user.ID, 10))

		if _, err := db.PGExec(r.Context(),
			`UPDATE helpdesk_calls SET `+strings.Join(set, ", ")+` WHERE id = $1`, args...); err != nil {
			respondErrLog(w, 500, "Could not save the correction", err)
			return
		}
		hdRecordCallEdit(r, db, id, "edit", user, changes, b.Reason)

		// The lead's status was derived from the old disposition — re-derive it.
		if row["lead_id"] != nil {
			if b.Disposition != nil {
				d := strings.TrimSpace(*b.Disposition)
				syncLeadFromCall(r.Context(), db, toInt64(row["lead_id"]),
					str(row["outcome"]), &d, "", &user.ID)
			}
		}
		respond(w, map[string]any{"id": id, "changed": len(changes)}, "pg")
	}
}

// hdVoidCall marks a log as struck out. The row survives: a call that happened
// still happened, and a supervisor needs to see what was withdrawn and by whom.
func hdVoidCall(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		user := core.UserFromCtx(r.Context())
		if id <= 0 || user == nil {
			respondErr(w, 400, "Invalid request")
			return
		}
		var b struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		if strings.TrimSpace(b.Reason) == "" {
			respondErr(w, 422, "Say why this log is being removed")
			return
		}
		cur, err := db.PGQuery(r.Context(),
			`SELECT agent_id, notes, disposition FROM helpdesk_calls WHERE id = $1 AND voided_at IS NULL`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not load the call", err)
			return
		}
		if len(cur) == 0 {
			respondErr(w, 404, "No such call, or it is already voided")
			return
		}
		if toInt64(cur[0]["agent_id"]) != user.ID && !hdCanSuperviseCalls(user) {
			respondErr(w, 403, "You can only remove your own call logs")
			return
		}
		if _, err := db.PGExec(r.Context(), `
			UPDATE helpdesk_calls
			   SET voided_at = NOW(), voided_by = $2, void_reason = $3, needs_review = false
			 WHERE id = $1`, id, user.ID, strings.TrimSpace(b.Reason)); err != nil {
			respondErrLog(w, 500, "Could not remove the log", err)
			return
		}
		hdRecordCallEdit(r, db, id, "void", user, map[string]any{
			"notes":       map[string]any{"from": cur[0]["notes"], "to": nil},
			"disposition": map[string]any{"from": cur[0]["disposition"], "to": nil},
		}, b.Reason)
		respond(w, map[string]any{"id": id, "voided": true}, "pg")
	}
}

// hdRestoreCall puts a voided log back. Supervisors only — an agent who could
// void and restore at will could hide a log for as long as it suited them.
func hdRestoreCall(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		user := core.UserFromCtx(r.Context())
		if !hdCanSuperviseCalls(user) {
			respondErr(w, 403, "Supervisor access required")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE helpdesk_calls SET voided_at = NULL, voided_by = NULL, void_reason = NULL
			  WHERE id = $1`, id); err != nil {
			respondErrLog(w, 500, "Could not restore the log", err)
			return
		}
		hdRecordCallEdit(r, db, id, "restore", user, map[string]any{}, "")
		respond(w, map[string]any{"id": id, "restored": true}, "pg")
	}
}

// hdClearCallReview dismisses a review flag without changing the log — the
// supervisor looked and decided it is fine as it stands.
func hdClearCallReview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		user := core.UserFromCtx(r.Context())
		if !hdCanSuperviseCalls(user) {
			respondErr(w, 403, "Supervisor access required")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE helpdesk_calls SET needs_review = false, reviewed_at = NOW(), reviewed_by = $2
			  WHERE id = $1`, id, user.ID); err != nil {
			respondErrLog(w, 500, "Could not clear the flag", err)
			return
		}
		hdRecordCallEdit(r, db, id, "review_cleared", user, map[string]any{}, "")
		respond(w, map[string]any{"id": id, "cleared": true}, "pg")
	}
}

// hdRecordCallEdit writes the audit row. Best-effort: the correction itself has
// already been saved, and failing to record it must not tell the agent their fix
// did not apply. It is logged loudly instead, because an unaudited edit is
// exactly what a supervisor needs to know about.
func hdRecordCallEdit(r *http.Request, db *core.DB, callID int64, action string,
	u *core.Claims, changes map[string]any, reason string) {

	blob, err := json.Marshal(changes)
	if err != nil {
		blob = []byte("{}")
	}
	name := ""
	if u != nil {
		name = u.FullName
	}
	var uid any
	if u != nil {
		uid = u.ID
	}
	if _, err := db.PGExec(r.Context(), `
		INSERT INTO helpdesk_call_edits (call_id, action, edited_by, edited_name, changes, reason)
		VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
		callID, action, uid, name, string(blob), strings.TrimSpace(reason)); err != nil {
		slogErrorAuditFailed(callID, action, err)
	}
}

// hdCallEdits is the supervisor's feed: every correction and withdrawal, newest
// first, with what changed and who did it.
func hdCallEdits(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !hdCanSuperviseCalls(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Supervisor access required")
			return
		}
		limit := qint(r, "limit", 100, 1, 500)
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.id, e.call_id, e.action, e.edited_name, e.changes, e.reason, e.created_at,
			       c.customer_name, c.customer_phone, c.agent_name, c.started_at,
			       c.duration_sec, c.disposition, c.direction,
			       (c.recording_filename IS NOT NULL) AS has_recording,
			       (c.voided_at IS NOT NULL)          AS is_voided
			  FROM helpdesk_call_edits e
			  JOIN helpdesk_calls c ON c.id = e.call_id
			 ORDER BY e.created_at DESC
			 LIMIT $1`, limit)
		if err != nil {
			respondErrLog(w, 500, "Could not load the edit history", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// hdCallsNeedingReview lists logs the workspace could not make sense of, so a
// supervisor can settle them rather than have them sit contradicting themselves.
func hdCallsNeedingReview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !hdCanSuperviseCalls(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Supervisor access required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, agent_name, customer_name, customer_phone, started_at, duration_sec,
			       direction, disposition, notes, review_reason,
			       (recording_filename IS NOT NULL) AS has_recording
			  FROM helpdesk_calls
			 WHERE needs_review AND voided_at IS NULL
			 ORDER BY started_at DESC
			 LIMIT 500`)
		if err != nil {
			respondErrLog(w, 500, "Could not load the review queue", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// slogErrorAuditFailed keeps the noisy log line out of the handler body.
func slogErrorAuditFailed(callID int64, action string, err error) {
	slog.Error("call log edit was NOT audited", "call", callID, "action", action, "err", err)
}
