package handlers

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
	"net/http"
	"strconv"

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
}

// ── Settings key-value ────────────────────────────────────────────────────────

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
		respond(w, rows, "pg")
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

		_, err := db.PGExec(r.Context(), `
			INSERT INTO settings (key, value, updated_by, updated_at)
			VALUES ($1, $2, $3, NOW())
			ON CONFLICT (key) DO UPDATE
				SET value = EXCLUDED.value,
				    updated_by = EXCLUDED.updated_by,
				    updated_at = NOW()`,
			key, b.Value, user.ID)
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
		rows, err := db.PGQuery(r.Context(), `
			SELECT * FROM sync_engine_status ORDER BY created_at DESC LIMIT 10`)
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

		_, err = db.PGExec(r.Context(), `
			UPDATE o3c_users SET deleted_at = NOW() WHERE id = $1`, id)
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
