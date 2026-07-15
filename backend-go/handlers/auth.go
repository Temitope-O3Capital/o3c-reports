package handlers

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterAuth(r chi.Router, db *core.DB) {
	r.Post("/token", loginHandler(db))
	r.Post("/refresh", refreshHandler(db))
	r.Get("/me", meHandler())
	r.Post("/change-password", changePasswordHandler(db))
	r.Post("/forgot-password", ForgotPasswordHandler(db))
}

// cookieAttrs returns (secure, sameSite) based on whether the request was HTTPS.
// SameSite=None is required for cross-origin cookie sending (Cloudflare Pages → Railway).
func cookieAttrs(r *http.Request) (bool, http.SameSite) {
	secure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	if secure {
		return true, http.SameSiteNoneMode
	}
	return false, http.SameSiteLaxMode
}

// setAuthCookie writes the 30-min access token as an HttpOnly cookie and a matching
// CSRF token in a readable (non-HttpOnly) cookie for the double-submit pattern.
// It returns the CSRF token value so callers can include it in the response body
// for cross-origin clients that cannot read the cookie via document.cookie.
func setAuthCookie(w http.ResponseWriter, r *http.Request, token string) string {
	secure, sameSite := cookieAttrs(r)
	http.SetCookie(w, &http.Cookie{
		Name:     "o3c_token",
		Value:    token,
		Path:     "/",
		MaxAge:   30 * 60,
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
	})
	csrf := newCSRFToken()
	http.SetCookie(w, &http.Cookie{
		Name:     "o3c_csrf",
		Value:    csrf,
		Path:     "/",
		MaxAge:   30 * 60,
		HttpOnly: false,
		Secure:   secure,
		SameSite: sameSite,
	})
	return csrf
}

// setRefreshCookie writes the 7-day refresh token as an HttpOnly cookie.
func setRefreshCookie(w http.ResponseWriter, r *http.Request, token string) {
	secure, sameSite := cookieAttrs(r)
	http.SetCookie(w, &http.Cookie{
		Name:     "o3c_refresh",
		Value:    token,
		Path:     "/",
		MaxAge:   7 * 24 * 60 * 60,
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
	})
}

// ClearAuthCookies expires all auth cookies — called on logout.
func ClearAuthCookies(w http.ResponseWriter, r *http.Request) {
	secure, sameSite := cookieAttrs(r)
	for _, name := range []string{"o3c_token", "o3c_refresh"} {
		http.SetCookie(w, &http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   secure,
			SameSite: sameSite,
		})
	}
	// o3c_csrf is non-HttpOnly by design; deletion must match the original attributes.
	http.SetCookie(w, &http.Cookie{
		Name:     "o3c_csrf",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: false,
		Secure:   secure,
		SameSite: sameSite,
	})
}

func newCSRFToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		slog.Error("newCSRFToken: rand.Read failed; CSRF token entropy degraded", "err", err)
	}
	return hex.EncodeToString(b)
}

func ForgotPasswordHandler(db *core.DB) http.HandlerFunc {
	type body struct {
		Email string `json:"email"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Email == "" {
			// Always return success to prevent email enumeration.
			w.WriteHeader(204)
			return
		}
		b.Email = strings.ToLower(strings.TrimSpace(b.Email))
		ctx := context.Background()

		rows, err := db.PGQuery(ctx, `SELECT id, full_name FROM o3c_users WHERE LOWER(email)=$1 AND deleted_at IS NULL AND is_active=TRUE LIMIT 1`, b.Email)
		if err != nil || len(rows) == 0 {
			w.WriteHeader(204) // don't reveal whether email exists
			return
		}

		rawBytes := make([]byte, 8)
		rand.Read(rawBytes) //nolint:errcheck
		tempPW := hex.EncodeToString(rawBytes) // 16 hex chars — meets 12-char minimum

		hash, err := core.HashPassword(tempPW)
		if err != nil {
			w.WriteHeader(204)
			return
		}

		name := str(rows[0]["full_name"])
		uid := toInt64(rows[0]["id"])

		// H1: Send email BEFORE updating the DB — if email fails the user's password
		// should not be changed, otherwise they'd be locked out with no recovery path.
		mailRes := SendTemporaryPasswordEmail(ctx, db, b.Email, name, tempPW, uid)
		if !mailRes.OK {
			slog.Error("forgotPassword: email send failed", "email", b.Email, "err", mailRes.Error)
			respondErr(w, 500, "Failed to send reset email")
			return
		}

		_, err = db.PGExec(ctx,
			`UPDATE o3c_users SET password_hash=$1, must_change_password=TRUE WHERE id=$2`,
			hash, rows[0]["id"])
		if err != nil {
			slog.Error("forgotPassword: update failed", "err", err)
			w.WriteHeader(204)
			return
		}

		w.WriteHeader(204)
	}
}

// registerHandler lets a new staff member request access without admin pre-action.
// The account is created inactive; IT Admin activates it from Admin → Users.
func RegisterHandler(db *core.DB) http.HandlerFunc {
	type body struct {
		FirstName  string `json:"first_name"`
		LastName   string `json:"last_name"`
		Email      string `json:"email"`
		Department string `json:"department"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			w.WriteHeader(204)
			return
		}
		b.Email = strings.ToLower(strings.TrimSpace(b.Email))
		if b.FirstName == "" || b.Email == "" {
			respondErr(w, 422, "first_name and email are required")
			return
		}

		// Don't reveal whether email already exists — silently succeed.
		existing, _ := db.PGQuery(r.Context(), `SELECT id FROM o3c_users WHERE email=$1`, b.Email)
		if len(existing) > 0 {
			w.WriteHeader(204)
			return
		}

		fullName := strings.TrimSpace(b.FirstName + " " + b.LastName)
		// Lock the account until admin activates: use a random unusable hash.
		rawBytes := make([]byte, 32)
		rand.Read(rawBytes) //nolint:errcheck
		hash, _ := core.HashPassword(hex.EncodeToString(rawBytes))

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO o3c_users
			  (email, password_hash, full_name, first_name, last_name, role, department, must_change_password, is_active)
			VALUES ($1,$2,$3,$4,$5,'call_centre',$6,TRUE,FALSE)
			RETURNING id`,
			b.Email, hash, fullName, b.FirstName, b.LastName, b.Department)
		if err != nil {
			slog.Error("register: insert failed", "err", err)
			w.WriteHeader(204)
			return
		}

		newUID := toInt64(rows[0]["id"])
		ctx := r.Context()

		go NotifyRole(ctx, db, "it_admin", NotifPayload{
			EventType: EvtNewAccountCreated,
			Title:     "New access request",
			Body:      fmt.Sprintf("%s (%s) has requested workspace access. Review in Admin → Users.", fullName, b.Email),
			ActionURL: "/admin/users",
			EntityRef: fmt.Sprint(newUID),
		})

		go SendMail(ctx, db, SendMailOptions{
			To:      []MailAddress{{Email: b.Email, Name: fullName}},
			Subject: "O3 Capital — Access Request Received",
			HTMLBody: fmt.Sprintf(`<p>Hi %s,</p>
<p>Your access request for <strong>O3 Capital Workspace</strong> has been received.</p>
<p>The IT Admin will review and activate your account. You will receive your login credentials by email once approved.</p>`,
				escapeMailHTML(fullName)),
			TextBody: fmt.Sprintf("Hi %s,\n\nYour access request for O3 Capital Workspace has been received.\n\nThe IT Admin will review and activate your account. You will receive your login credentials by email once approved.", fullName),
			Kind:     "auth",
			Category: "auth",
		})

		w.WriteHeader(204)
	}
}

func loginHandler(db *core.DB) http.HandlerFunc {
	type response struct {
		AccessToken string         `json:"access_token"`
		TokenType   string         `json:"token_type"`
		CsrfToken   string         `json:"csrf_token"`
		User        map[string]any `json:"user"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			respondErr(w, 400, "Invalid form data")
			return
		}
		email := r.FormValue("username")
		password := r.FormValue("password")
		if email == "" || password == "" {
			respondErr(w, 400, "username and password are required")
			return
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT id, email, password_hash, full_name,
			        COALESCE(first_name,'') AS first_name,
			        COALESCE(last_name,'')  AS last_name,
			        role, department,
			        COALESCE(must_change_password, false) AS must_change_password,
			        COALESCE(is_active, true)             AS is_active,
			        COALESCE(totp_enabled, false)         AS totp_enabled,
			        deleted_at,
			        last_login
			 FROM o3c_users WHERE email = $1`, email)
		if err != nil {
			respondErr(w, 503, "Database unavailable — please try again")
			return
		}
		if len(rows) == 0 || !core.CheckPassword(password, str(rows[0]["password_hash"])) {
			respondErr(w, 401, "Invalid credentials")
			return
		}
		u := rows[0]
		if u["deleted_at"] != nil {
			respondErr(w, 403, "This account has been removed. Contact your administrator.")
			return
		}
		if active, _ := u["is_active"].(bool); !active {
			respondErr(w, 403, "Your account is deactivated. Contact your administrator.")
			return
		}

		// Update last_login and record session (best-effort)
		isFirstLogin := u["last_login"] == nil
		db.PGExec(r.Context(), `UPDATE o3c_users SET last_login = NOW() WHERE id = $1`, u["id"]) //nolint:errcheck
		if isFirstLogin {
			go Notify(r.Context(), db, NotifPayload{
				EventType: EvtFirstLogin,
				UserID:    toInt64(u["id"]),
				Title:     "Welcome to O3 Capital Workspace!",
				Body:      "Your account is ready. Explore your dashboard to get started.",
				ActionURL: "/",
			})
		}
		// Rightmost X-Forwarded-For — Railway appends real IP last
		ip := ""
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			ip = strings.TrimSpace(parts[len(parts)-1])
		}
		if ip == "" {
			ip = r.RemoteAddr
		}
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO user_sessions (user_id, ip_address, user_agent) VALUES ($1,$2,$3)`,
			u["id"], ip, r.Header.Get("User-Agent"))

		role := str(u["role"])
		pages := core.RolePages[role]
		if len(pages) == 0 {
			// Custom role — look up from DB
			rows2, _ := db.PGQuery(r.Context(), `SELECT pages FROM o3c_custom_roles WHERE name = $1`, role)
			if len(rows2) > 0 {
				pages = core.ParsePages(rows2[0]["pages"])
			}
		}

		// If TOTP is enabled, issue a short-lived MFA challenge token instead.
		if totpEnabled, _ := u["totp_enabled"].(bool); totpEnabled {
			mfaTok, err := core.CreateMFAToken(toInt64(u["id"]))
			if err != nil {
				respondErr(w, 500, "Token generation failed")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"mfa_required": true,
				"mfa_token":    mfaTok,
			})
			return
		}

		claims := &core.Claims{
			Sub:        str(u["email"]),
			ID:         toInt64(u["id"]),
			Role:       role,
			FullName:   str(u["full_name"]),
			Department: str(u["department"]),
			Pages:      pages,
		}
		token, err := core.CreateToken(claims)
		if err != nil {
			respondErr(w, 500, "Token generation failed")
			return
		}

		csrfTok := setAuthCookie(w, r, token)

		refreshTok, err := core.CreateRefreshToken(toInt64(u["id"]))
		if err != nil {
			respondErr(w, 500, "Token generation failed")
			return
		}
		setRefreshCookie(w, r, refreshTok)

		mustChange, _ := u["must_change_password"].(bool)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response{ //nolint:errcheck
			AccessToken: token,
			TokenType:   "bearer",
			CsrfToken:   csrfTok,
			User: map[string]any{
				"id":                   u["id"],
				"email":                str(u["email"]),
				"name":                 str(u["full_name"]),
				"first_name":           str(u["first_name"]),
				"last_name":            str(u["last_name"]),
				"role":                 role,
				"department":           str(u["department"]),
				"pages":                pages,
				"must_change_password": mustChange,
			},
		})
	}
}

// refreshHandler reads the o3c_refresh HttpOnly cookie, verifies it, looks up the user,
// and issues a fresh 30-min access token + rotated 7-day refresh token.
func refreshHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("o3c_refresh")
		if err != nil {
			respondErr(w, 401, "No refresh token")
			return
		}
		old, err := core.VerifyRefreshToken(cookie.Value)
		if err != nil {
			respondErr(w, 401, "Invalid or expired refresh token")
			return
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT id, email, full_name, role, department
			 FROM o3c_users WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE`, old.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 401, "User not found or inactive")
			return
		}
		u := rows[0]

		role := str(u["role"])
		pages := core.RolePages[role]
		if len(pages) == 0 {
			rows2, _ := db.PGQuery(r.Context(), `SELECT pages FROM o3c_custom_roles WHERE name = $1`, role)
			if len(rows2) > 0 {
				pages = core.ParsePages(rows2[0]["pages"])
			}
		}

		claims := &core.Claims{
			Sub:        str(u["email"]),
			ID:         old.ID,
			Role:       role,
			FullName:   str(u["full_name"]),
			Department: str(u["department"]),
			Pages:      pages,
		}
		token, err := core.CreateToken(claims)
		if err != nil {
			respondErr(w, 500, "Token generation failed")
			return
		}

		newRefresh, err := core.CreateRefreshToken(old.ID)
		if err != nil {
			respondErr(w, 500, "Token generation failed")
			return
		}

		csrfTok := setAuthCookie(w, r, token)
		setRefreshCookie(w, r, newRefresh)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"access_token": token,
			"token_type":   "bearer",
			"csrf_token":   csrfTok,
		})
	}
}

func meHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user) //nolint:errcheck
	}
}

func changePasswordHandler(db *core.DB) http.HandlerFunc {
	type body struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.NewPassword) < 12 {
			respondErr(w, 422, "New password must be at least 12 characters")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, password_hash FROM o3c_users WHERE id = $1`, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "User not found")
			return
		}
		if !core.CheckPassword(b.CurrentPassword, str(rows[0]["password_hash"])) {
			respondErr(w, 401, "Current password is incorrect")
			return
		}
		hash, err := core.HashPassword(b.NewPassword)
		if err != nil {
			respondErr(w, 500, "Password hashing failed")
			return
		}
		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE o3c_users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`,
			hash, user.ID)
		// H8: Invalidate all existing sessions so open sessions are forced to re-authenticate.
		db.PGExec(r.Context(), `DELETE FROM user_sessions WHERE user_id=$1`, user.ID) //nolint:errcheck
		respondErr(w, 200, "Password updated successfully")
	}
}

// BootstrapHandler creates the first admin user when no users exist.
// Once any user exists this endpoint returns 403 — it self-disables.
// If BOOTSTRAP_SECRET env var is set, the X-Bootstrap-Secret header must match it.
func BootstrapHandler(db *core.DB) http.HandlerFunc {
	bootstrapSecret := os.Getenv("BOOTSTRAP_SECRET")
	type body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		FullName string `json:"full_name"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if bootstrapSecret != "" &&
			subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Bootstrap-Secret")), []byte(bootstrapSecret)) != 1 {
			respondErr(w, 403, "Forbidden")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Email == "" || b.Password == "" {
			respondErr(w, 422, "email and password are required")
			return
		}
		if len(b.Password) < 12 {
			respondErr(w, 422, "Password must be at least 12 characters")
			return
		}
		if b.FullName == "" {
			b.FullName = "Admin"
		}

		hash, err := core.HashPassword(b.Password)
		if err != nil {
			respondErr(w, 500, "Password hashing failed")
			return
		}

		// Atomic: INSERT only when no users exist, RETURNING nothing if a race wins.
		created, err := db.PGQuery(r.Context(),
			`INSERT INTO o3c_users (email, password_hash, full_name, first_name, last_name, role, must_change_password)
			 SELECT $1, $2, $3, $3, '', 'admin', FALSE
			 WHERE NOT EXISTS (SELECT 1 FROM o3c_users)
			 RETURNING id, email, full_name, role`,
			b.Email, hash, b.FullName)
		if err != nil {
			slog.Error("BootstrapHandler: failed to create admin user", "err", err)
			respondErr(w, 500, "Failed to create admin user")
			return
		}
		if len(created) == 0 {
			respondErr(w, 403, "Platform already has users — use the admin panel to add more")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"message": "Admin user created successfully. You can now log in.",
			"user":    created[0],
		})
	}
}

// ResetAdminHandler resets a user's password. Requires X-Admin-Secret header matching
// RESET_ADMIN_SECRET (a dedicated env var, separate from SECRET_KEY).
// Only mounted when ENABLE_RESET_ADMIN=true. Remove that env var after use.
func ResetAdminHandler(db *core.DB, resetSecret string) http.HandlerFunc {
	type body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ip := ""
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			ip = strings.TrimSpace(parts[len(parts)-1])
		}
		if ip == "" {
			ip = r.RemoteAddr
		}

		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Admin-Secret")), []byte(resetSecret)) != 1 {
			slog.Warn("ResetAdminHandler: forbidden attempt", "ip", ip)
			respondErr(w, 403, "Forbidden")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Email == "" || len(b.Password) < 12 {
			respondErr(w, 422, "email and password (min 12 chars) required")
			return
		}
		hash, err := core.HashPassword(b.Password)
		if err != nil {
			respondErr(w, 500, "Hashing failed")
			return
		}
		res, err := db.PGQuery(r.Context(),
			`UPDATE o3c_users SET password_hash=$1, must_change_password=FALSE, is_active=TRUE, deleted_at=NULL
			 WHERE email=$2 RETURNING id, email, full_name, role`, hash, b.Email)
		if err != nil || len(res) == 0 {
			slog.Warn("ResetAdminHandler: user not found", "email", b.Email, "ip", ip)
			respondErr(w, 404, "User not found")
			return
		}
		mailRes := SendTemporaryPasswordEmail(r.Context(), db,
			str(res[0]["email"]), str(res[0]["full_name"]), b.Password, toInt64(res[0]["id"]))
		slog.Warn("ResetAdminHandler: password reset performed", "email", b.Email, "ip", ip)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"message":     "Password reset",
			"user":        res[0],
			"email_sent":  mailRes.OK,
			"email_error": mailRes.Error,
		})
	}
}

// ── small type helpers used across handler files ──────────────────────────────

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int32:
		return int64(t)
	case float64:
		return int64(t)
	case string:
		// pgx returns SUM(bigint) as numeric → []byte → string after normalizeVal
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	}
	return 0
}
