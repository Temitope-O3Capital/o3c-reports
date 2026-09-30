package handlers

import (
	"crypto/rand"
	"encoding/json"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// The emergency stop for a staff account.
//
// Deactivating an account blocks the next sign-in but leaves the session the person is
// already in completely intact — AuthMiddleware rejects a token only for being denylisted,
// expired, or minted before o3c_users.tokens_valid_from, and the ordinary deactivate never
// moved that watermark. Suspension moves it, which is the whole point: the reason you reach
// for this button is that the account is being misused *now*, so "they cannot sign in again
// tomorrow" is not an answer.
//
// Suspension reuses is_active rather than adding a second switch. One flag means "may this
// account be used"; two would mean writing precedence rules and getting them wrong. The
// suspended_* columns record why and by whom, and gate nothing on their own.

const (
	// A reinstatement code is for a mistake being fixed in the moment — the wrong row
	// clicked, a suspension lifted over the phone. Half an hour is long enough to find the
	// person and short enough that a code left on a notepad is worthless by morning.
	reinstateCodeTTL = 30 * time.Minute

	// Five guesses against a 6-digit code is a 1-in-200,000 chance per issued code. The cap
	// is what makes a short numeric code defensible at all, so it is enforced in the
	// database rather than in memory: restarting the process must not hand an attacker a
	// fresh five.
	reinstateMaxAttempts = 5
)

// genNumericCode returns a uniformly random decimal string of the requested length,
// zero-padded, from crypto/rand. math/rand would make the code predictable from the issue
// time, which for a credential is the same as having no code.
func genNumericCode(digits int) (string, error) {
	upper := big.NewInt(1)
	for i := 0; i < digits; i++ {
		upper.Mul(upper, big.NewInt(10))
	}
	n, err := rand.Int(rand.Reader, upper)
	if err != nil {
		return "", err
	}
	s := n.String()
	for len(s) < digits {
		s = "0" + s
	}
	return s, nil
}

// suspendUser cuts an account off immediately: no further sign-in, and every live session
// dies on its next request.
func suspendUser(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		var body struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		reason := strings.TrimSpace(body.Reason)
		if reason == "" {
			respondErr(w, 400, "Say why this account is being suspended — it is the only record of it.")
			return
		}
		if len([]rune(reason)) > 500 {
			respondErr(w, 400, "Keep the reason under 500 characters.")
			return
		}

		caller := core.UserFromCtx(r.Context())
		if caller != nil && strconv.FormatInt(caller.ID, 10) == id {
			respondErr(w, 400, "You cannot suspend your own account — you would have no way back in.")
			return
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT id, email, full_name, role, COALESCE(is_active, true) AS is_active
			   FROM o3c_users WHERE id=$1 AND deleted_at IS NULL`, id)
		if err != nil {
			respondErrLog(w, 500, "Suspend failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "User not found")
			return
		}
		target := rows[0]

		// Same last-admin guard the ordinary deactivate carries. Suspension is the more
		// abrupt route to the same place, so it must not be the way round it.
		if str(target["role"]) == "admin" {
			var adminCount int
			db.PG.QueryRowContext(r.Context(), //nolint:errcheck
				`SELECT COUNT(*) FROM o3c_users WHERE role='admin' AND is_active=TRUE AND deleted_at IS NULL`,
			).Scan(&adminCount)
			if adminCount <= 1 {
				respondErr(w, 422, "This is the last active admin account. Suspending it would lock everyone out of administration.")
				return
			}
		}

		var callerID int64
		callerRole, callerName := "", ""
		if caller != nil {
			callerID, callerRole, callerName = caller.ID, caller.Role, caller.FullName
		}

		// Any code outstanding from an earlier suspension is cleared here, not carried over:
		// a code issued for a different incident must not open the door to this one.
		if _, err := db.PGExec(r.Context(),
			`UPDATE o3c_users
			    SET is_active                 = FALSE,
			        suspended_at              = NOW(),
			        suspended_by              = NULLIF($2, 0),
			        suspended_reason          = $3,
			        reinstate_code_hash       = NULL,
			        reinstate_code_expires_at = NULL,
			        reinstate_code_attempts   = 0
			  WHERE id = $1 AND deleted_at IS NULL`, id, callerID, reason); err != nil {
			respondErrLog(w, 500, "Suspend failed", err)
			return
		}

		// The part an ordinary deactivate misses. Everything above only decides tomorrow;
		// this is what ends the session they are in right now.
		core.InvalidateUserTokens(r.Context(), toInt64(target["id"]))

		// A suspended account should not also be sitting behind a failed-sign-in lockout,
		// or a later reinstatement would look broken for fifteen minutes.
		db.PGExec(r.Context(), `DELETE FROM login_failures WHERE user_id=$1`, id) //nolint:errcheck

		changesJSON, _ := json.Marshal(map[string]any{
			"email":  str(target["email"]),
			"reason": reason,
		})
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO audit_logs (actor_id, actor_role, actor_name, action, entity_type, entity_id, changes, ip_address, created_at)
			 VALUES ($1,$2,$3,'account_suspended','user',$4,$5,'',NOW())`,
			callerID, callerRole, callerName, id, string(changesJSON))
		slog.Warn("account-suspended", "user", id, "email", str(target["email"]), "by", callerID, "reason", reason)

		writeJSON(w, map[string]any{
			"detail": "Account suspended. Every open session has been signed out.",
		})
	}
}

// issueReinstateCode mints the short code that lifts a suspension. Returned once, to the
// admin, to be read to the person — it is never emailed and never stored in the clear.
func issueReinstateCode(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		var body struct {
			Digits int `json:"digits"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		if body.Digits == 0 {
			body.Digits = 6
		}
		if body.Digits != 4 && body.Digits != 6 {
			respondErr(w, 400, "A reinstatement code is 4 or 6 digits.")
			return
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT id, email, full_name, suspended_at
			   FROM o3c_users WHERE id=$1 AND deleted_at IS NULL`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not issue a code", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "User not found")
			return
		}
		// A code for an account that is not suspended would be a credential that does
		// nothing, which is worse than no credential: someone would rely on it.
		if rows[0]["suspended_at"] == nil {
			respondErr(w, 422, "This account is not suspended, so there is nothing for a code to lift.")
			return
		}

		code, err := genNumericCode(body.Digits)
		if err != nil {
			respondErrLog(w, 500, "Could not generate a code", err)
			return
		}
		hash, err := core.HashPassword(code)
		if err != nil {
			respondErrLog(w, 500, "Could not store the code", err)
			return
		}

		expires := time.Now().Add(reinstateCodeTTL)
		if _, err := db.PGExec(r.Context(),
			`UPDATE o3c_users
			    SET reinstate_code_hash       = $2,
			        reinstate_code_expires_at = $3,
			        reinstate_code_attempts   = 0
			  WHERE id = $1`, id, hash, expires); err != nil {
			respondErrLog(w, 500, "Could not store the code", err)
			return
		}

		caller := core.UserFromCtx(r.Context())
		var callerID int64
		callerRole, callerName := "", ""
		if caller != nil {
			callerID, callerRole, callerName = caller.ID, caller.Role, caller.FullName
		}
		// The code itself is deliberately absent from the audit row. That it was issued,
		// by whom, and for whom is the auditable fact; the value is a credential.
		changesJSON, _ := json.Marshal(map[string]any{
			"email":  str(rows[0]["email"]),
			"digits": body.Digits,
		})
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO audit_logs (actor_id, actor_role, actor_name, action, entity_type, entity_id, changes, ip_address, created_at)
			 VALUES ($1,$2,$3,'reinstate_code_issued','user',$4,$5,'',NOW())`,
			callerID, callerRole, callerName, id, string(changesJSON))
		slog.Info("reinstate-code-issued", "user", id, "by", callerID, "digits", body.Digits)

		writeJSON(w, map[string]any{
			"code":       code,
			"digits":     body.Digits,
			"expires_at": expires.Format(time.RFC3339),
			"detail":     "Read this to " + str(rows[0]["full_name"]) + ". It lifts the suspension only — they still sign in with their own password.",
		})
	}
}

// ReinstateWithCode is the unauthenticated half: the suspended person enters their email and
// the code they were given.
//
// It lifts the suspension and NOTHING else. No session is issued and no password is changed,
// so a code that is overheard, forwarded or guessed is not an account takeover — the holder
// still needs that person's password. That restraint is what lets the code be six digits
// instead of a reset link.
func ReinstateWithCode(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
			Code  string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Enter your email address and the code you were given.")
			return
		}
		email := strings.ToLower(strings.TrimSpace(body.Email))
		code := strings.TrimSpace(body.Code)
		if email == "" || code == "" {
			respondErr(w, 400, "Enter your email address and the code you were given.")
			return
		}

		// One message for every failure below. Distinguishing "no such account" from "wrong
		// code" would turn this endpoint into a way to enumerate staff email addresses and
		// to discover which accounts are currently suspended.
		const refuse = "That code is not valid. Ask your administrator for a new one."

		rows, err := db.PGQuery(r.Context(),
			`SELECT id, full_name, suspended_at, reinstate_code_hash,
			        reinstate_code_expires_at, reinstate_code_attempts
			   FROM o3c_users WHERE LOWER(email)=$1 AND deleted_at IS NULL`, email)
		if err != nil {
			respondErr(w, 503, "The database is not answering. Try again in a moment.")
			return
		}
		if len(rows) == 0 || rows[0]["suspended_at"] == nil || rows[0]["reinstate_code_hash"] == nil {
			// Same bcrypt cost as the success path, so timing does not separate these
			// cases from a wrong code.
			core.DummyHashCheck(code)
			respondErr(w, 400, refuse)
			return
		}
		u := rows[0]
		userID := toInt64(u["id"])

		if exp, ok := u["reinstate_code_expires_at"].(time.Time); !ok || time.Now().After(exp) {
			core.DummyHashCheck(code)
			respondErr(w, 400, refuse)
			return
		}

		if toInt64(u["reinstate_code_attempts"]) >= reinstateMaxAttempts {
			// Burn the code rather than only refusing this attempt. Leaving a spent code in
			// place would let an attacker wait out any window and keep guessing.
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE o3c_users SET reinstate_code_hash=NULL, reinstate_code_expires_at=NULL WHERE id=$1`, userID)
			core.DummyHashCheck(code)
			respondErr(w, 400, refuse)
			return
		}

		if !core.CheckPassword(code, str(u["reinstate_code_hash"])) {
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE o3c_users SET reinstate_code_attempts = reinstate_code_attempts + 1 WHERE id=$1`, userID)
			slog.Warn("reinstate-code-rejected", "user", userID)
			respondErr(w, 400, refuse)
			return
		}

		// Single use. tokens_valid_from is deliberately NOT rolled back: the sessions the
		// suspension killed stay dead, and the person signs in fresh.
		if _, err := db.PGExec(r.Context(),
			`UPDATE o3c_users
			    SET is_active                 = TRUE,
			        suspended_at              = NULL,
			        suspended_by              = NULL,
			        suspended_reason          = NULL,
			        reinstate_code_hash       = NULL,
			        reinstate_code_expires_at = NULL,
			        reinstate_code_attempts   = 0
			  WHERE id = $1`, userID); err != nil {
			respondErrLog(w, 500, "Could not reinstate the account", err)
			return
		}
		db.PGExec(r.Context(), `DELETE FROM login_failures WHERE user_id=$1`, userID) //nolint:errcheck

		changesJSON, _ := json.Marshal(map[string]any{"email": email, "via": "reinstatement_code"})
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO audit_logs (actor_id, actor_role, actor_name, action, entity_type, entity_id, changes, ip_address, created_at)
			 VALUES ($1,'','','account_reinstated','user',$2,$3,'',NOW())`,
			userID, userID, string(changesJSON))
		slog.Info("account-reinstated", "user", userID, "via", "code")

		writeJSON(w, map[string]any{
			"detail": "Your access is restored. Sign in with your usual password.",
		})
	}
}
