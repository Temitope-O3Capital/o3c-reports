package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterAuth(r chi.Router, db *core.DB) {
	r.Post("/token", loginHandler(db))
	r.Get("/me", meHandler())
	r.Post("/change-password", changePasswordHandler(db))
}

func loginHandler(db *core.DB) http.HandlerFunc {
	type response struct {
		AccessToken string         `json:"access_token"`
		TokenType   string         `json:"token_type"`
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
			`SELECT id, email, password_hash, full_name, role, department,
			        must_change_password, is_active, deleted_at
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

		// Update last_login (best-effort)
		db.PGExec(r.Context(), `UPDATE o3c_users SET last_login = NOW() WHERE id = $1`, u["id"]) //nolint:errcheck

		role := str(u["role"])
		pages := core.RolePages[role]
		if len(pages) == 0 {
			// Custom role — look up from DB
			rows2, _ := db.PGQuery(r.Context(), `SELECT pages FROM o3c_custom_roles WHERE name = $1`, role)
			if len(rows2) > 0 {
				if p, ok := rows2[0]["pages"].([]any); ok {
					for _, v := range p {
						pages = append(pages, str(v))
					}
				}
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

		mustChange, _ := u["must_change_password"].(bool)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response{ //nolint:errcheck
			AccessToken: token,
			TokenType:   "bearer",
			User: map[string]any{
				"id":                   u["id"],
				"email":                str(u["email"]),
				"full_name":            str(u["full_name"]),
				"role":                 role,
				"department":           str(u["department"]),
				"pages":                pages,
				"must_change_password": mustChange,
			},
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
		if len(b.NewPassword) < 8 {
			respondErr(w, 422, "New password must be at least 8 characters")
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
		respondErr(w, 200, "Password updated successfully")
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
	}
	return 0
}
