package handlers

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterAdmin(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("admin"))
	r.Get("/users", listUsers(db))
	r.Post("/users", createUser(db))
	r.Put("/users/{id}", updateUser(db))
	r.Delete("/users/{id}", deleteUser(db))
	r.Post("/users/{id}/reset-password", resetPassword(db))
	r.Patch("/users/{id}/deactivate", deactivateUser(db))
	r.Patch("/users/{id}/reactivate", reactivateUser(db))
	r.Get("/roles", listRoles(db))
	r.Post("/roles", createRole(db))
	r.Delete("/roles/{name}", deleteRole(db))
	r.Get("/activity", getActivity(db))
}

// RegisterActivityLog is mounted outside the admin guard (any authenticated user can log).
func RegisterActivityLog(r chi.Router, db *core.DB) {
	r.Post("/admin/activity", logActivity(db))
}

// ── User CRUD ─────────────────────────────────────────────────────────────────

var staticRoles = map[string]bool{
	"md": true, "coo": true, "cfo": true, "head_it": true, "head_hr": true,
	"cmo": true, "head_ops": true, "head_sales": true, "head_collections": true,
	"head_recovery": true, "admin": true, "management": true, "sales": true,
	"collections": true, "recovery": true, "cards_ops": true, "call_centre": true,
}

func validRole(db *core.DB, r *http.Request, role string) bool {
	if staticRoles[role] {
		return true
	}
	rows, _ := db.PGQuery(r.Context(), `SELECT 1 FROM o3c_custom_roles WHERE name=$1`, role)
	return len(rows) > 0
}

func listUsers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		includeRemoved := r.URL.Query().Get("include_removed") == "true"
		where := "WHERE deleted_at IS NULL"
		if includeRemoved {
			where = ""
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, email, full_name, role, department, created_at,
			       must_change_password, last_login, is_active, deleted_at
			FROM o3c_users `+where+` ORDER BY created_at DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func createUser(db *core.DB) http.HandlerFunc {
	type body struct {
		FullName   string `json:"full_name"`
		Email      string `json:"email"`
		Role       string `json:"role"`
		Department string `json:"department"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Email == "" || b.FullName == "" {
			respondErr(w, 422, "full_name and email are required")
			return
		}
		if b.Role == "" {
			b.Role = "call_centre"
		}
		if !validRole(db, r, b.Role) {
			respondErr(w, 422, "Unknown role: "+b.Role)
			return
		}
		existing, _ := db.PGQuery(r.Context(), `SELECT id FROM o3c_users WHERE email=$1`, b.Email)
		if len(existing) > 0 {
			respondErr(w, 409, "A user with this email already exists")
			return
		}
		tempPW := genPassword()
		hash, err := core.HashPassword(tempPW)
		if err != nil {
			respondErr(w, 500, "Password generation failed")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO o3c_users (email, password_hash, full_name, role, department, must_change_password)
			VALUES ($1,$2,$3,$4,$5,TRUE)
			RETURNING id, email, full_name, role, department, created_at, must_change_password`,
			b.Email, hash, b.FullName, b.Role, b.Department)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		result := rows[0]
		result["temp_password"] = tempPW // returned once only
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(result) //nolint:errcheck
	}
}

func updateUser(db *core.DB) http.HandlerFunc {
	type body struct {
		FullName   *string `json:"full_name"`
		Email      *string `json:"email"`
		Role       *string `json:"role"`
		Department *string `json:"department"`
		Password   *string `json:"password"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Role != nil && !validRole(db, r, *b.Role) {
			respondErr(w, 422, "Unknown role: "+*b.Role)
			return
		}

		// Whitelist columns to avoid injection via column name
		setCols := map[string]any{}
		if b.FullName != nil {
			setCols["full_name"] = *b.FullName
		}
		if b.Email != nil {
			setCols["email"] = *b.Email
		}
		if b.Role != nil {
			setCols["role"] = *b.Role
		}
		if b.Department != nil {
			setCols["department"] = *b.Department
		}
		if b.Password != nil && *b.Password != "" {
			hash, _ := core.HashPassword(*b.Password)
			setCols["password_hash"] = hash
		}
		if len(setCols) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}

		// Build SET clause from whitelist
		var parts []string
		var args []any
		i := 1
		for col, val := range setCols {
			parts = append(parts, col+"=$"+itoa(i))
			args = append(args, val)
			i++
		}
		args = append(args, id)
		_, err := db.PGExec(r.Context(),
			"UPDATE o3c_users SET "+strings.Join(parts, ",")+
				" WHERE id=$"+itoa(i)+" AND deleted_at IS NULL", args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(),
			`SELECT id,email,full_name,role,department,created_at,must_change_password,last_login FROM o3c_users WHERE id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "User not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteUser(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		caller := core.UserFromCtx(r.Context())
		if caller != nil && itoa(int(caller.ID)) == id {
			respondErr(w, 400, "Cannot delete your own account")
			return
		}
		_, err := db.PGExec(r.Context(),
			`UPDATE o3c_users SET is_active=FALSE, deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, id)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		w.WriteHeader(204)
	}
}

func resetPassword(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), `SELECT id FROM o3c_users WHERE id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "User not found")
			return
		}
		tempPW := genPassword()
		hash, _ := core.HashPassword(tempPW)
		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE o3c_users SET password_hash=$1, must_change_password=TRUE WHERE id=$2`, hash, id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"temp_password": tempPW}) //nolint:errcheck
	}
}

func deactivateUser(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		caller := core.UserFromCtx(r.Context())
		if caller != nil && itoa(int(caller.ID)) == id {
			respondErr(w, 400, "Cannot deactivate your own account")
			return
		}
		db.PGExec(r.Context(), `UPDATE o3c_users SET is_active=FALSE WHERE id=$1 AND deleted_at IS NULL`, id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"detail": "User deactivated"}) //nolint:errcheck
	}
}

func reactivateUser(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `UPDATE o3c_users SET is_active=TRUE WHERE id=$1`, id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"detail": "User reactivated"}) //nolint:errcheck
	}
}

// ── Custom roles ──────────────────────────────────────────────────────────────

func listRoles(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, name, label, pages, created_at FROM o3c_custom_roles ORDER BY created_at DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func createRole(db *core.DB) http.HandlerFunc {
	type body struct {
		Name  string   `json:"name"`
		Label string   `json:"label"`
		Pages []string `json:"pages"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		slug := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(b.Name), " ", "_"))
		if slug == "" {
			respondErr(w, 422, "Role name is required")
			return
		}
		if staticRoles[slug] {
			respondErr(w, 409, "'"+slug+"' is a built-in role name")
			return
		}
		existing, _ := db.PGQuery(r.Context(), `SELECT 1 FROM o3c_custom_roles WHERE name=$1`, slug)
		if len(existing) > 0 {
			respondErr(w, 409, "Role '"+slug+"' already exists")
			return
		}
		pages := b.Pages
		if pages == nil {
			pages = []string{}
		}
		pagesJSON, _ := json.Marshal(pages)
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO o3c_custom_roles (name, label, pages) VALUES ($1,$2,$3)`,
			slug, strings.TrimSpace(b.Label), string(pagesJSON))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"name": slug, "label": b.Label, "pages": pages}) //nolint:errcheck
	}
}

func deleteRole(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		db.PGExec(r.Context(), `DELETE FROM o3c_custom_roles WHERE name=$1`, name) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Activity log ──────────────────────────────────────────────────────────────

func logActivity(db *core.DB) http.HandlerFunc {
	type body struct {
		Page   string `json:"page"`
		Action string `json:"action"`
		Detail string `json:"detail"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			w.WriteHeader(204)
			return
		}
		user := core.UserFromCtx(r.Context())

		// Rightmost X-Forwarded-For — Railway appends real IP last; leftmost is attacker-controlled.
		ip := ""
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			ip = strings.TrimSpace(parts[len(parts)-1])
		}
		if ip == "" && r.RemoteAddr != "" {
			ip = r.RemoteAddr
		}

		action := b.Action
		if action == "" {
			action = "view"
		}
		var uid any
		if user != nil {
			uid = user.ID
		}
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO o3c_activity_log (user_id, page, action, detail, ip) VALUES ($1,$2,$3,$4,$5)`,
			uid, b.Page, action, b.Detail, ip)
		w.WriteHeader(204)
	}
}

func getActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 1000)
		userID := r.URL.Query().Get("user_id")
		page := r.URL.Query().Get("page")

		q := `SELECT a.id, a.page, a.action, a.detail, a.ip, a.ts,
		             u.full_name, u.email, u.role
		      FROM o3c_activity_log a LEFT JOIN o3c_users u ON u.id=a.user_id WHERE 1=1`
		var args []any
		if userID != "" {
			args = append(args, userID)
			q += " AND a.user_id=$" + itoa(len(args))
		}
		if page != "" {
			args = append(args, page)
			q += " AND a.page=$" + itoa(len(args))
		}
		args = append(args, limit)
		q += " ORDER BY a.ts DESC LIMIT $" + itoa(len(args))

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

// ── small utils ───────────────────────────────────────────────────────────────

const pwAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%"

func genPassword() string {
	b := make([]byte, 16)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(pwAlphabet))))
		b[i] = pwAlphabet[n.Int64()]
	}
	return string(b)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := [20]byte{}
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[pos:])
}
