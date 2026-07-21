package handlers

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterSettings(r chi.Router, db *core.DB) {
	settings := core.RequirePages("settings")
	syncStatus := core.RequirePages("sync_status", "settings")

	// Settings key-value
	r.With(settings).Get("/", settingsList(db))
	r.With(settings).Put("/{key}", settingsUpdate(db))

	// Sync status
	r.With(syncStatus).Get("/sync-status", settingsSyncStatusList(db))
	r.With(syncStatus).Post("/sync-status", settingsSyncStatusInsert(db))

	// User management
	r.With(settings).Get("/users", settingsUserList(db))
	r.With(settings).Post("/users", settingsUserCreate(db))
	r.With(settings).Put("/users/{id}", settingsUserUpdate(db))
	r.With(settings).Put("/users/{id}/reset-password", settingsUserResetPassword(db))
	r.With(settings).Delete("/users/{id}", settingsUserDelete(db))

	// Per-user Zoho Voice connection (any authenticated user manages their own)
	r.Get("/zoho-voice", zohoVoiceStatus(db))
	r.Put("/zoho-voice", zohoVoiceConnect(db))
	r.Delete("/zoho-voice", zohoVoiceDisconnect(db))
}

// ── Zoho Voice per-user connection ────────────────────────────────────────────

func ensureZohoVoiceColumns(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_refresh_token TEXT`)       //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_access_token TEXT`)        //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_token_expiry TIMESTAMPTZ`) //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_agent_id TEXT`)            //nolint:errcheck
}

func zohoVoiceStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		ensureZohoVoiceColumns(ctx, db)
		rows, err := db.PGQuery(ctx,
			`SELECT zoho_voice_agent_id FROM o3c_users WHERE id=$1`, user.ID)
		connected := err == nil && len(rows) > 0 && str(rows[0]["zoho_voice_agent_id"]) != ""
		agentID := ""
		if connected {
			agentID = str(rows[0]["zoho_voice_agent_id"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"connected": connected,
			"agent_id":  agentID,
		})
	}
}

func zohoVoiceConnect(db *core.DB) http.HandlerFunc {
	type body struct {
		RefreshToken string `json:"refresh_token"`
		AgentID      string `json:"agent_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if strings.TrimSpace(b.RefreshToken) == "" {
			respondErr(w, 422, "refresh_token is required")
			return
		}
		ensureZohoVoiceColumns(ctx, db)
		encToken, err := encryptValue(b.RefreshToken)
		if err != nil {
			respondErr(w, 500, "encryption error")
			return
		}
		_, err = db.PGExec(ctx,
			`UPDATE o3c_users
			 SET zoho_voice_refresh_token=$1, zoho_voice_agent_id=$2,
			     zoho_voice_access_token=NULL, zoho_voice_token_expiry=NULL
			 WHERE id=$3`,
			encToken, strings.TrimSpace(b.AgentID), user.ID)
		if err != nil {
			respondErr(w, 500, "save failed")
			return
		}
		w.WriteHeader(204)
	}
}

func zohoVoiceDisconnect(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		ensureZohoVoiceColumns(ctx, db)
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE o3c_users
			 SET zoho_voice_refresh_token=NULL, zoho_voice_access_token=NULL,
			     zoho_voice_token_expiry=NULL, zoho_voice_agent_id=NULL
			 WHERE id=$1`, user.ID)
		w.WriteHeader(204)
	}
}

// ── Settings key-value ────────────────────────────────────────────────────────

// sensitiveSettingKey returns true for keys that should be encrypted at rest.
func sensitiveSettingKey(key string) bool {
	for _, pat := range []string{"secret", "password", "token", "_key", "credential", "api_key"} {
		if len(key) >= len(pat) {
			// case-insensitive suffix/substring check
			lk := strings.ToLower(key)
			if strings.Contains(lk, pat) {
				return true
			}
		}
	}
	return false
}

func settingsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT key, value, updated_at FROM settings ORDER BY key`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// M3: Mask sensitive values in a new slice of new maps — don't mutate original rows.
		masked := make([]map[string]any, len(rows))
		for i, row := range rows {
			newRow := make(map[string]any, len(row))
			for k, v := range row {
				newRow[k] = v
			}
			k, _ := row["key"].(string)
			if sensitiveSettingKey(k) {
				if enc, _ := row["value"].(string); enc != "" {
					newRow["value"] = "••••••••"
					newRow["has_value"] = true
				} else {
					newRow["has_value"] = false
				}
			}
			masked[i] = newRow
		}
		respond(w, masked, "pg")
	}
}

func settingsUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		Value string `json:"value"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		user := core.UserFromCtx(r.Context())

		storeVal := b.Value
		if sensitiveSettingKey(key) {
			enc, err := encryptValue(b.Value)
			if err == nil {
				storeVal = enc
			}
		}

		_, err := db.PGExec(r.Context(), `
			INSERT INTO settings (key, value, updated_by, updated_at)
			VALUES ($1, $2, $3, NOW())
			ON CONFLICT (key) DO UPDATE
				SET value = EXCLUDED.value,
				    updated_by = EXCLUDED.updated_by,
				    updated_at = NOW()`,
			key, storeVal, user.ID)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "Setting updated")
	}
}

// ── Sync status ───────────────────────────────────────────────────────────────

func settingsSyncStatusList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")

		q := `SELECT * FROM sync_engine_status WHERE 1=1`
		var args []any
		if from != "" {
			args = append(args, from)
			q += " AND created_at::date >= $" + itoa(len(args)) + "::date"
		}
		if to != "" {
			args = append(args, to)
			q += " AND created_at::date <= $" + itoa(len(args)) + "::date"
		}
		q += " ORDER BY created_at DESC LIMIT 100"
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func settingsSyncStatusInsert(db *core.DB) http.HandlerFunc {
	type body struct {
		StartedAt  string `json:"started_at"`
		FinishedAt string `json:"finished_at"`
		Status     string `json:"status"`
		RowsSynced int    `json:"rows_synced"`
		ErrorMsg   string `json:"error_msg"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status == "" {
			respondErr(w, 422, "status is required")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO sync_engine_status (started_at, finished_at, status, rows_synced, error_msg, created_at)
			VALUES ($1, $2, $3, $4, $5, NOW())
			RETURNING id, status, rows_synced, created_at`,
			b.StartedAt, b.FinishedAt, b.Status, b.RowsSynced, b.ErrorMsg)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// ── User management ───────────────────────────────────────────────────────────

func settingsUserList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, email, full_name, role, department, is_active, last_login
			FROM o3c_users
			WHERE deleted_at IS NULL
			ORDER BY full_name`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func settingsUserCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		Email      string `json:"email"`
		FullName   string `json:"full_name"`
		Role       string `json:"role"`
		Department string `json:"department"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Email == "" || b.FullName == "" || b.Role == "" {
			respondErr(w, 422, "email, full_name, and role are required")
			return
		}

		// Generate a random 12-character password
		plain, err := generatePassword(12)
		if err != nil {
			respondErr(w, 500, "Password generation failed")
			return
		}

		hash, err := core.HashPassword(plain)
		if err != nil {
			respondErr(w, 500, "Password hashing failed")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO o3c_users (email, full_name, role, department,
				password_hash, is_active, must_change_password)
			VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
			RETURNING id, email, full_name, role, department, is_active, must_change_password`,
			b.Email, b.FullName, b.Role, b.Department, hash)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}

		result := map[string]any{
			"user":              rows[0],
			"temporary_password": plain, // one-time — share with the user immediately
		}
		respond(w, result, "pg")
	}
}

func settingsUserUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		Role       string `json:"role"`
		Department string `json:"department"`
		IsActive   *bool  `json:"is_active"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid user ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		_, err = db.PGExec(r.Context(), `
			UPDATE o3c_users SET
				role       = COALESCE(NULLIF($1,''), role),
				department = COALESCE(NULLIF($2,''), department),
				is_active  = COALESCE($3, is_active)
			WHERE id = $4 AND deleted_at IS NULL`,
			b.Role, b.Department, b.IsActive, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "User updated")
	}
}

func settingsUserResetPassword(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid user ID")
			return
		}

		plain, err := generatePassword(12)
		if err != nil {
			respondErr(w, 500, "Password generation failed")
			return
		}

		hash, err := core.HashPassword(plain)
		if err != nil {
			respondErr(w, 500, "Password hashing failed")
			return
		}

		_, err = db.PGExec(r.Context(), `
			UPDATE o3c_users SET password_hash = $1, must_change_password = TRUE
			WHERE id = $2 AND deleted_at IS NULL`, hash, id)
		if err != nil {
			respondErr(w, 500, "Reset failed")
			return
		}

		// Return the plaintext password one time only — admin shares it with the user
		respond(w, map[string]string{"temporary_password": plain}, "pg")
	}
}

func settingsUserDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid user ID")
			return
		}

		// H5: also set is_active=FALSE so deactivation is immediate regardless of query filters.
		_, err = db.PGExec(r.Context(), `
			UPDATE o3c_users SET is_active = FALSE, deleted_at = NOW() WHERE id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		respondErr(w, 200, "User deleted")
	}
}

// ── Password generator ────────────────────────────────────────────────────────

const passwordChars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%"

func generatePassword(length int) (string, error) {
	b := make([]byte, length)
	charLen := big.NewInt(int64(len(passwordChars)))
	for i := range b {
		n, err := rand.Int(rand.Reader, charLen)
		if err != nil {
			return "", err
		}
		b[i] = passwordChars[n.Int64()]
	}
	return string(b), nil
}
