package handlers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // TOTP (RFC 6238) mandates SHA-1
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterMFA mounts TOTP endpoints. All are public (no auth middleware) but
// the setup/verify/disable routes read an MFA challenge token from the body.
func RegisterMFA(r chi.Router, db *core.DB) {
	r.Get("/status", mfaStatus(db))
	r.Post("/setup", mfaSetup(db))
	r.Post("/verify", mfaVerify(db))
	r.Post("/disable", mfaDisable(db))
	r.Post("/challenge", mfaChallenge(db))
}

func mfaStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`SELECT COALESCE(totp_enabled, false) AS totp_enabled FROM o3c_users WHERE id = $1`, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Database error")
			return
		}
		enabled, _ := rows[0]["totp_enabled"].(bool)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"totp_enabled": enabled}) //nolint:errcheck
	}
}

// mfaSetup generates a fresh TOTP secret for the authenticated user and stores it
// (encrypted, unverified). Returns the raw base32 secret + otpauth URI for QR code.
func mfaSetup(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		raw := make([]byte, 20)
		if _, err := rand.Read(raw); err != nil {
			respondErr(w, 500, "Failed to generate secret")
			return
		}
		secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)

		enc, err := encryptValue(secret)
		if err != nil {
			respondErr(w, 500, "Encryption error")
			return
		}

		_, err = db.PGExec(r.Context(),
			`UPDATE o3c_users SET totp_secret_encrypted = $1, totp_enabled = FALSE, totp_verified_at = NULL WHERE id = $2`,
			enc, user.ID)
		if err != nil {
			respondErr(w, 500, "Database error")
			return
		}

		email := user.Sub
		uri := fmt.Sprintf(
			"otpauth://totp/O3%%20Capital%%20Workspace:%s?secret=%s&issuer=O3%%20Capital%%20Workspace&algorithm=SHA1&digits=6&period=30",
			email, secret,
		)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"secret": secret,
			"uri":    uri,
		})
	}
}

// mfaVerify checks the TOTP code against the pending secret and, if valid,
// marks totp_enabled = TRUE. Called from the Settings security setup flow.
func mfaVerify(db *core.DB) http.HandlerFunc {
	type body struct {
		Code string `json:"code"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || strings.TrimSpace(b.Code) == "" {
			respondErr(w, 400, "code is required")
			return
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT totp_secret_encrypted FROM o3c_users WHERE id = $1`, user.ID)
		if err != nil || len(rows) == 0 || rows[0]["totp_secret_encrypted"] == nil {
			respondErr(w, 400, "No pending TOTP setup. Call /setup first.")
			return
		}
		encSecret := str(rows[0]["totp_secret_encrypted"])
		secret, err := decryptValue(encSecret)
		if err != nil {
			respondErr(w, 500, "Decryption error")
			return
		}

		if !totpVerify(secret, b.Code) {
			respondErr(w, 400, "Invalid code — check your authenticator app and try again")
			return
		}

		now := time.Now().UTC()
		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE o3c_users SET totp_enabled = TRUE, totp_verified_at = $1 WHERE id = $2`,
			now, user.ID)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"message": "Two-factor authentication enabled"}) //nolint:errcheck
	}
}

// mfaDisable turns off TOTP for the authenticated user. Requires the current
// password OR a valid TOTP code as a second factor before disabling.
func mfaDisable(db *core.DB) http.HandlerFunc {
	type body struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		rows, err := db.PGQuery(r.Context(),
			`SELECT password_hash, totp_secret_encrypted, totp_enabled FROM o3c_users WHERE id = $1`, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "User not found")
			return
		}
		if enabled, _ := rows[0]["totp_enabled"].(bool); !enabled {
			respondErr(w, 400, "Two-factor authentication is not enabled")
			return
		}

		// Require either current password OR a valid TOTP code
		pwOK := b.Password != "" && core.CheckPassword(b.Password, str(rows[0]["password_hash"]))
		codeOK := false
		if b.Code != "" && rows[0]["totp_secret_encrypted"] != nil {
			if secret, decErr := decryptValue(str(rows[0]["totp_secret_encrypted"])); decErr == nil {
				codeOK = totpVerify(secret, b.Code)
			}
		}
		if !pwOK && !codeOK {
			respondErr(w, 401, "Provide your current password or a valid authenticator code")
			return
		}

		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE o3c_users SET totp_enabled = FALSE, totp_secret_encrypted = NULL, totp_verified_at = NULL WHERE id = $1`,
			user.ID)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"message": "Two-factor authentication disabled"}) //nolint:errcheck
	}
}

// mfaChallenge is called after the login password step when totp_enabled=TRUE.
// Body: { mfa_token, code }. Returns a full access token on success.
func mfaChallenge(db *core.DB) http.HandlerFunc {
	type body struct {
		MFAToken string `json:"mfa_token"`
		Code     string `json:"code"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.MFAToken == "" || b.Code == "" {
			respondErr(w, 400, "mfa_token and code are required")
			return
		}

		userID, err := core.VerifyMFAToken(b.MFAToken)
		if err != nil {
			respondErr(w, 401, "MFA session expired — please log in again")
			return
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT id, email, full_name, role, department,
			        totp_secret_encrypted, totp_enabled,
			        COALESCE(must_change_password, false) AS must_change_password
			 FROM o3c_users WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE`, userID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 401, "User not found")
			return
		}
		u := rows[0]

		if enabled, _ := u["totp_enabled"].(bool); !enabled {
			respondErr(w, 400, "MFA not enabled for this user")
			return
		}
		if u["totp_secret_encrypted"] == nil {
			respondErr(w, 500, "TOTP secret missing")
			return
		}
		secret, err := decryptValue(str(u["totp_secret_encrypted"]))
		if err != nil {
			respondErr(w, 500, "Decryption error")
			return
		}
		if !totpVerify(secret, b.Code) {
			respondErr(w, 401, "Invalid authenticator code")
			return
		}

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

		setAuthCookie(w, r, token)

		refreshTok, refErr := core.CreateRefreshToken(toInt64(u["id"]))
		if refErr != nil {
			respondErr(w, 500, "Token generation failed")
			return
		}
		setRefreshCookie(w, r, refreshTok)

		mustChange, _ := u["must_change_password"].(bool)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"access_token": token,
			"token_type":   "bearer",
			"user": map[string]any{
				"id":                   u["id"],
				"email":                str(u["email"]),
				"name":                 str(u["full_name"]),
				"role":                 role,
				"department":           str(u["department"]),
				"pages":                pages,
				"must_change_password": mustChange,
			},
		})
	}
}

// ── Pure-Go TOTP implementation (RFC 6238 / RFC 4226) ────────────────────────

func totpVerify(base32Secret, code string) bool {
	// Accept the current window and ±1 step to account for clock drift
	now := time.Now().Unix()
	for _, offset := range []int64{-30, 0, 30} {
		if totpAt(base32Secret, now+offset) == code {
			return true
		}
	}
	return false
}

func totpAt(base32Secret string, unixSec int64) string {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(
		strings.ToUpper(base32Secret))
	if err != nil {
		return ""
	}
	counter := uint64(math.Floor(float64(unixSec) / 30))
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(buf) //nolint:errcheck
	h := mac.Sum(nil)

	offset := h[len(h)-1] & 0x0f
	code := (uint32(h[offset])&0x7f)<<24 |
		uint32(h[offset+1])<<16 |
		uint32(h[offset+2])<<8 |
		uint32(h[offset+3])
	return fmt.Sprintf("%06d", code%1_000_000)
}
