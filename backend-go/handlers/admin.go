package handlers

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// adminOnly gates routes to admin/head_it roles.
func adminOnly(next http.Handler) http.Handler {
	return core.RequirePages("admin_users")(next)
}

func RegisterAdmin(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("admin_users", "admin"))
	r.Get("/users", listUsers(db))
	r.Post("/users", createUser(db))
	r.Put("/users/{id}", updateUser(db))
	r.Delete("/users/{id}", deleteUser(db))
	r.Post("/users/{id}/reset-password", resetPassword(db))
	r.Patch("/users/{id}/deactivate", deactivateUser(db))
	r.Patch("/users/{id}/reactivate", reactivateUser(db))
	r.Get("/roles", listRoles(db))
	r.Post("/roles", createRole(db))
	r.Put("/roles/{name}", updateRole(db))
	r.Delete("/roles/{name}", deleteRole(db))
	r.Get("/activity", getActivity(db))
	r.Get("/activity/export", exportActivityCSV(db))
	r.Get("/users/{id}/activity", getUserActivity(db))
	r.Get("/users/{id}/sessions", getUserSessions(db))

	r.With(adminOnly).Get("/api-keys", listApiKeys(db))
	r.With(adminOnly).Put("/api-keys/{name}", updateApiKey(db))
	r.With(adminOnly).Post("/api-keys/{name}/test", testApiKey(db))
	r.With(adminOnly).Post("/upload-logo", uploadEmailLogo(db))

	// Vendor Integration Registry (5I)
	r.Get("/integrations",            listIntegrations(db))
	r.Post("/integrations",           createIntegration(db))
	r.Patch("/integrations/{id}",     updateIntegration(db))
	r.Delete("/integrations/{id}",    deleteIntegration(db))
	r.Post("/integrations/{id}/ping", pingIntegration(db))
}

// RegisterActivityLog is mounted outside the admin guard (any authenticated user can log).
func RegisterActivityLog(r chi.Router, db *core.DB) {
	r.Post("/admin/activity", logActivity(db))
}

// ── User CRUD ─────────────────────────────────────────────────────────────────

func validRole(db *core.DB, r *http.Request, role string) bool {
	if _, ok := core.RolePages[role]; ok {
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
			SELECT id, email, full_name,
			       COALESCE(first_name,'') AS first_name,
			       COALESCE(last_name,'')  AS last_name,
			       role, department, created_at,
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
		FirstName  string `json:"first_name"`
		LastName   string `json:"last_name"`
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
		if b.Email == "" || b.FirstName == "" {
			respondErr(w, 422, "first_name and email are required")
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
		fullName := strings.TrimSpace(b.FirstName + " " + b.LastName)
		tempPW := genPassword()
		hash, err := core.HashPassword(tempPW)
		if err != nil {
			respondErr(w, 500, "Password generation failed")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO o3c_users (email, password_hash, full_name, first_name, last_name, role, department, must_change_password)
			VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
			RETURNING id, email, full_name, first_name, last_name, role, department, created_at, must_change_password`,
			b.Email, hash, fullName, b.FirstName, b.LastName, b.Role, b.Department)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		result := rows[0]
		result["temp_password"] = tempPW // returned once only
		mailRes := SendTemporaryPasswordEmail(r.Context(), db,
			str(result["email"]), str(result["full_name"]), tempPW, toInt64(result["id"]))
		result["email_sent"] = mailRes.OK
		newUID := toInt64(result["id"])
		go NotifyRole(r.Context(), db, "it_admin", NotifPayload{
			EventType: EvtNewAccountCreated,
			Title:     "New account created",
			Body:      fmt.Sprintf("%s (%s) was added with role %s.", fullName, b.Email, b.Role),
			ActionURL: "/admin/users/" + fmt.Sprint(newUID),
			EntityRef: fmt.Sprint(newUID),
		})
		if !mailRes.OK && mailRes.Error != "" {
			result["email_error"] = mailRes.Error
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(result) //nolint:errcheck
	}
}

func updateUser(db *core.DB) http.HandlerFunc {
	type body struct {
		FirstName  *string `json:"first_name"`
		LastName   *string `json:"last_name"`
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
		if b.FirstName != nil {
			setCols["first_name"] = *b.FirstName
		}
		if b.LastName != nil {
			setCols["last_name"] = *b.LastName
		}
		// Keep full_name in sync
		if b.FirstName != nil || b.LastName != nil {
			// Fetch current values to build full_name
			cur, _ := db.PGQuery(r.Context(),
				`SELECT COALESCE(first_name,'') AS fn, COALESCE(last_name,'') AS ln FROM o3c_users WHERE id=$1`, chi.URLParam(r, "id"))
			fn, ln := "", ""
			if len(cur) > 0 {
				fn = str(cur[0]["fn"])
				ln = str(cur[0]["ln"])
			}
			if b.FirstName != nil {
				fn = *b.FirstName
			}
			if b.LastName != nil {
				ln = *b.LastName
			}
			setCols["full_name"] = strings.TrimSpace(fn + " " + ln)
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
			hash, err := core.HashPassword(*b.Password)
			if err != nil {
				respondErr(w, 500, "Failed to hash password")
				return
			}
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
		if caller != nil && strconv.FormatInt(caller.ID, 10) == id {
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
		rows, _ := db.PGQuery(r.Context(), `SELECT id, email, full_name FROM o3c_users WHERE id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "User not found")
			return
		}
		tempPW := genPassword()
		hash, err := core.HashPassword(tempPW)
		if err != nil {
			respondErr(w, 500, "Failed to hash password")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE o3c_users SET password_hash=$1, must_change_password=TRUE WHERE id=$2`, hash, id); err != nil {
			respondErr(w, 500, "Failed to reset password")
			return
		}
		mailRes := SendTemporaryPasswordEmail(r.Context(), db,
			str(rows[0]["email"]), str(rows[0]["full_name"]), tempPW, toInt64(rows[0]["id"]))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"email_sent":  mailRes.OK,
			"email_error": mailRes.Error,
		})
	}
}

func deactivateUser(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		caller := core.UserFromCtx(r.Context())
		if caller != nil && strconv.FormatInt(caller.ID, 10) == id {
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
		db.PGExec(r.Context(), `UPDATE o3c_users SET is_active=TRUE, deleted_at=NULL WHERE id=$1`, id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"detail": "User reactivated"}) //nolint:errcheck
	}
}

// ── Custom roles ──────────────────────────────────────────────────────────────

type rolePayload struct {
	Name  string   `json:"name"`
	Label string   `json:"label"`
	Pages []string `json:"pages"`
}

func roleSlug(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.ReplaceAll(name, " ", "_")
	name = strings.ReplaceAll(name, "-", "_")
	return name
}

func roleDisplayName(name string) string {
	parts := strings.Fields(strings.ReplaceAll(name, "_", " "))
	for i := range parts {
		if len(parts[i]) > 0 {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, " ")
}

func roleResponse(name, label string, pages []string, builtIn bool, extra map[string]any) map[string]any {
	if label == "" {
		label = roleDisplayName(name)
	}
	res := map[string]any{
		"name":     name,
		"label":    label,
		"pages":    pages,
		"builtin":  builtIn,
		"built_in": builtIn,
	}
	for k, v := range extra {
		res[k] = v
	}
	return res
}

func listRoles(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		roles := make([]map[string]any, 0, len(core.RolePages))
		for _, name := range core.BuiltinRoleNames() {
			roles = append(roles, roleResponse(name, "", core.ParsePages(core.RolePages[name]), true, nil))
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT id, name, label, pages, created_at FROM o3c_custom_roles ORDER BY created_at DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		for _, row := range rows {
			roles = append(roles, roleResponse(
				str(row["name"]),
				str(row["label"]),
				core.ParsePages(row["pages"]),
				false,
				map[string]any{"id": row["id"], "created_at": row["created_at"]},
			))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(roles) //nolint:errcheck
	}
}

func createRole(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b rolePayload
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		slug := roleSlug(b.Name)
		if slug == "" {
			respondErr(w, 422, "Role name is required")
			return
		}
		if _, ok := core.RolePages[slug]; ok {
			respondErr(w, 409, "'"+slug+"' is a built-in role name")
			return
		}
		existing, _ := db.PGQuery(r.Context(), `SELECT 1 FROM o3c_custom_roles WHERE name=$1`, slug)
		if len(existing) > 0 {
			respondErr(w, 409, "Role '"+slug+"' already exists")
			return
		}
		pages := core.ParsePages(b.Pages)
		pagesJSON, _ := json.Marshal(pages)
		if _, err := db.PGExec(r.Context(),
			`INSERT INTO o3c_custom_roles (name, label, pages) VALUES ($1,$2,$3::jsonb)`,
			slug, strings.TrimSpace(b.Label), string(pagesJSON)); err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(roleResponse(slug, b.Label, pages, false, nil)) //nolint:errcheck
	}
}

func updateRole(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := roleSlug(chi.URLParam(r, "name"))
		if _, ok := core.RolePages[name]; ok {
			respondErr(w, 409, "Built-in roles cannot be edited")
			return
		}
		var b rolePayload
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		pages := core.ParsePages(b.Pages)
		pagesJSON, _ := json.Marshal(pages)
		res, err := db.PGExec(r.Context(),
			`UPDATE o3c_custom_roles SET label=$1, pages=$2::jsonb WHERE name=$3`,
			strings.TrimSpace(b.Label), string(pagesJSON), name)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if affected, _ := res.RowsAffected(); affected == 0 {
			respondErr(w, 404, "Role not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(roleResponse(name, b.Label, pages, false, nil)) //nolint:errcheck
	}
}

func deleteRole(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := roleSlug(chi.URLParam(r, "name"))
		if _, ok := core.RolePages[name]; ok {
			respondErr(w, 409, "Built-in roles cannot be deleted")
			return
		}
		assigned, _ := db.PGQuery(r.Context(), `SELECT COUNT(*) AS count FROM o3c_users WHERE role=$1 AND deleted_at IS NULL`, name)
		if len(assigned) > 0 && toInt64(assigned[0]["count"]) > 0 {
			respondErr(w, 409, "Role is assigned to active users")
			return
		}
		res, err := db.PGExec(r.Context(), `DELETE FROM o3c_custom_roles WHERE name=$1`, name)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		if affected, _ := res.RowsAffected(); affected == 0 {
			respondErr(w, 404, "Role not found")
			return
		}
		w.WriteHeader(204)
	}
}

// ── Activity log ──────────────────────────────────────────────────────────────

// allowedActivityPages is the exhaustive set of page names the frontend may log.
var allowedActivityPages = map[string]bool{
	"overview": true, "executive": true, "approvals": true,
	"los": true, "los_all": true, "los_risk_review": true, "los_risk_head": true,
	"los_finance": true, "los_finance_approve": true, "los_booking": true,
	"collections": true, "collections_assign": true, "collections_payment": true, "collections_payment_approve": true,
	"recovery": true, "recovery_assign": true, "recovery_write_off": true,
	"sales": true, "cohort": true, "crm_pipeline": true, "crm_contacts": true, "crm_tasks": true, "crm_reports": true,
	"cards": true, "card_trends": true, "call_center": true, "customer_service": true, "customer360": true,
	"campaigns": true, "contact_lists": true, "message_templates": true,
	"hr_employees": true, "hr_leave": true, "hr_performance": true, "hr_disciplinary": true, "hr_payroll": true, "hr_training": true,
	"compliance_all": true, "compliance_checklists": true, "cbn_reports": true,
	"audit_trail": true, "audit_export": true, "sars": true, "watch_list": true, "audit_findings": true,
	"income": true, "eod": true, "transactions": true, "reconciliation": true,
	"credit_portfolio": true, "fixed_deposit": true, "settlement": true, "statements": true,
	"kpi_dashboard": true, "reports": true,
	"admin_users": true, "admin_api_keys": true, "settings": true, "sync_status": true, "uploads": true,
	"loans": true, "mobile_app": true, "blink_card": true, "risk_all": true,
}

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
		if !allowedActivityPages[b.Page] {
			respondErr(w, 422, "Invalid page name")
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

// exportActivityCSV streams the activity log as a CSV file with chunked
// transfer encoding — no row cap, no full-table load into memory.
func exportActivityCSV(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := r.URL.Query().Get("user_id")
		from   := r.URL.Query().Get("from")
		to     := r.URL.Query().Get("to")

		q := `SELECT a.ts, u.full_name, u.email, u.role, a.page, a.action, a.detail, a.ip
		      FROM o3c_activity_log a LEFT JOIN o3c_users u ON u.id = a.user_id WHERE 1=1`
		var args []any
		if userID != "" {
			args = append(args, userID)
			q += " AND a.user_id=$" + itoa(len(args))
		}
		if from != "" {
			args = append(args, from)
			q += " AND a.ts >= $" + itoa(len(args)) + "::timestamptz"
		}
		if to != "" {
			args = append(args, to)
			q += " AND a.ts <= $" + itoa(len(args)) + "::timestamptz"
		}
		q += " ORDER BY a.ts DESC"

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}

		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="activity_export.csv"`)
		w.Header().Set("Transfer-Encoding", "chunked")

		cw := csv.NewWriter(w)
		cw.Write([]string{"timestamp", "user_name", "email", "role", "page", "action", "detail", "ip"}) //nolint:errcheck
		for _, row := range rows {
			cw.Write([]string{ //nolint:errcheck
				str(row["ts"]),
				str(row["full_name"]),
				str(row["email"]),
				str(row["role"]),
				str(row["page"]),
				str(row["action"]),
				str(row["detail"]),
				str(row["ip"]),
			})
		}
		cw.Flush()
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

// ── API key encryption ────────────────────────────────────────────────────────

// encryptionKey32 returns the AES-256 key from ENCRYPTION_KEY env var.
// Returns (nil, nil) when the env var is not set (plaintext-fallback mode).
// Returns an error when the var is set but not exactly 32 bytes.
func encryptionKey32() ([]byte, error) {
	raw := os.Getenv("ENCRYPTION_KEY")
	if raw == "" {
		return nil, nil
	}
	key := []byte(raw)
	if len(key) != 32 {
		return nil, fmt.Errorf("ENCRYPTION_KEY must be exactly 32 bytes, got %d", len(key))
	}
	return key, nil
}

// encryptValue encrypts plaintext using AES-GCM. Falls back to base64 plaintext
// prefixed with "plain:" if ENCRYPTION_KEY is not set.
func encryptValue(plaintext string) (string, error) {
	key, err := encryptionKey32()
	if err != nil {
		return "", err
	}
	if key == nil {
		return "", fmt.Errorf("ENCRYPTION_KEY is not configured — cannot encrypt API key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("aes.NewCipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("cipher.NewGCM: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("nonce: %w", err)
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// decryptValue reverses encryptValue.
func decryptValue(stored string) (string, error) {
	if strings.HasPrefix(stored, "plain:") {
		b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, "plain:"))
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	key, err := encryptionKey32()
	if err != nil {
		return "", err
	}
	if key == nil {
		return "", fmt.Errorf("ENCRYPTION_KEY not set but value is encrypted")
	}
	data, err := base64.StdEncoding.DecodeString(stored)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(data) < ns {
		return "", fmt.Errorf("ciphertext too short")
	}
	plain, err := gcm.Open(nil, data[:ns], data[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// ── API Keys handlers ─────────────────────────────────────────────────────────

func listApiKeys(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT key_name, description, category, is_active, is_secret,
			       (encrypted_value IS NOT NULL AND encrypted_value <> '') AS has_value,
			       last_tested_at, test_status, updated_at, updated_by
			FROM api_credentials
			ORDER BY category, key_name`)
		if err != nil {
			// Table may not exist yet — return empty array gracefully.
			slog.Warn("api_credentials query failed", "err", err)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]any{}) //nolint:errcheck
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func updateApiKey(db *core.DB) http.HandlerFunc {
	type body struct {
		Value string `json:"value"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Value) == "" {
			respondErr(w, 422, "value is required")
			return
		}
		enc, err := encryptValue(b.Value)
		if err != nil {
			respondErr(w, 500, "Encryption failed")
			return
		}
		caller := core.UserFromCtx(r.Context())
		var updatedBy any
		if caller != nil {
			updatedBy = caller.ID // bigint FK — must be int64, not email string
		}
		_, err = db.PGExec(r.Context(),
			`UPDATE api_credentials SET encrypted_value=$1, updated_at=NOW(), updated_by=$2,
			 test_status=NULL, last_tested_at=NULL WHERE key_name=$3`,
			enc, updatedBy, name)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"detail": "saved"}) //nolint:errcheck
	}
}

func testApiKey(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")

		rows, err := db.PGQuery(r.Context(),
			`SELECT key_name, category, encrypted_value FROM api_credentials WHERE key_name=$1`, name)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Key not found")
			return
		}
		row := rows[0]
		encVal, _ := row["encrypted_value"].(string)
		if encVal == "" {
			respondErr(w, 422, "No value stored for this key — save a value first")
			return
		}
		plaintext, err := decryptValue(encVal)
		if err != nil {
			respondErr(w, 500, "Could not decrypt key value")
			return
		}

		category, _ := row["category"].(string)
		status, detail := pingExternalAPI(name, category, plaintext)

		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE api_credentials SET last_tested_at=NOW(), test_status=$1 WHERE key_name=$2`,
			status, name)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"status": status,
			"detail": detail,
		})
	}
}

// pingExternalAPI performs a lightweight liveness check for known providers.
func pingExternalAPI(keyName, category, value string) (status, detail string) {
	client := &http.Client{Timeout: 10 * 1e9} // 10s in nanoseconds (time.Duration)

	upper := strings.ToUpper(keyName)

	switch {
	case strings.Contains(upper, "SENDGRID"):
		req, _ := http.NewRequest("GET", "https://api.sendgrid.com/v3/user/account", nil)
		req.Header.Set("Authorization", "Bearer "+value)
		resp, err := client.Do(req)
		if err != nil {
			return "failed", "Request error: " + err.Error()
		}
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			return "ok", fmt.Sprintf("SendGrid responded %d", resp.StatusCode)
		}
		return "failed", fmt.Sprintf("SendGrid responded %d", resp.StatusCode)

	case strings.Contains(upper, "TERMII"):
		body := strings.NewReader(`{"api_key":"` + value + `"}`)
		req, err := http.NewRequestWithContext(context.Background(), "POST",
			"https://api.ng.termii.com/api/get-balance", body)
		if err != nil {
			return "failed", "Request build error: " + err.Error()
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return "failed", "Request error: " + err.Error()
		}
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			return "ok", fmt.Sprintf("Termii responded %d", resp.StatusCode)
		}
		return "failed", fmt.Sprintf("Termii responded %d", resp.StatusCode)

	case strings.Contains(upper, "PAYSTACK"):
		req, _ := http.NewRequest("GET", "https://api.paystack.co/customer", nil)
		req.Header.Set("Authorization", "Bearer "+value)
		resp, err := client.Do(req)
		if err != nil {
			return "failed", "Request error: " + err.Error()
		}
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			return "ok", fmt.Sprintf("Paystack responded %d", resp.StatusCode)
		}
		return "failed", fmt.Sprintf("Paystack responded %d", resp.StatusCode)

	case upper == "ZOHO_CLIENT_ID" || upper == "ZOHO_CLIENT_SECRET":
		// OAuth app credentials cannot be tested independently — they only work
		// together in the OAuth flow. Treat a non-empty stored value as OK.
		if strings.TrimSpace(value) == "" {
			return "failed", "Value is empty — paste your Zoho OAuth app credential and click Set Key"
		}
		return "ok", "Value stored — go to Admin → Connected Services to complete OAuth"

	case upper == "ZOHO_REFRESH_TOKEN":
		// Validate by attempting a real token refresh
		form := strings.NewReader(
			"grant_type=refresh_token" +
				"&client_id=" + zohoClientID +
				"&client_secret=" + zohoClientSecret +
				"&refresh_token=" + value,
		)
		req, err := http.NewRequestWithContext(context.Background(), "POST",
			"https://accounts.zoho."+zohoDC+"/oauth/v2/token", form)
		if err != nil {
			return "failed", "Request build error: " + err.Error()
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := client.Do(req)
		if err != nil {
			return "failed", "Could not reach Zoho: " + err.Error()
		}
		defer resp.Body.Close()
		var zohoTokResp struct {
			AccessToken string `json:"access_token"`
			Error       string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&zohoTokResp) //nolint:errcheck
		if zohoTokResp.AccessToken != "" {
			return "ok", "Refresh token valid — Zoho token exchange succeeded"
		}
		msg := zohoTokResp.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return "failed", "Token refresh failed: " + msg

	case upper == "ZOHO_ORG_ID" || upper == "ZOHO_DC":
		if strings.TrimSpace(value) == "" {
			return "failed", "Value is empty"
		}
		return "ok", "Value stored"

	default:
		_ = category
		return "test_not_implemented", "No test defined for " + keyName
	}
}

// ── Per-user activity & sessions ──────────────────────────────────────────────

func getUserActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		limit := qint(r, "limit", 200, 1, 5000)
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, page, action, detail, ip,
			       COALESCE(resource,'') AS resource,
			       COALESCE(method,'')   AS method,
			       ts
			FROM o3c_activity_log
			WHERE user_id = $1
			ORDER BY ts DESC
			LIMIT $2`, id, limit)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func getUserSessions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, ip_address, user_agent, logged_in_at, last_active_at
			FROM user_sessions
			WHERE user_id = $1
			ORDER BY logged_in_at DESC
			LIMIT 50`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

// uploadEmailLogo accepts a multipart image upload (PNG/JPG/SVG ≤ 512 KB),
// encodes it as a base64 data URL, and saves it to EMAIL_LOGO_URL in the
// credential store — no external file hosting required.
func uploadEmailLogo(db *core.DB) http.HandlerFunc {
	const maxSize = 512 * 1024 // 512 KB
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(maxSize); err != nil {
			respondErr(w, 400, "File too large (max 512 KB)")
			return
		}
		file, header, err := r.FormFile("logo")
		if err != nil {
			respondErr(w, 400, "logo field required")
			return
		}
		defer file.Close()

		ext := strings.ToLower(header.Filename[strings.LastIndex(header.Filename, "."):])
		if !strings.Contains(ext, ".") {
			ext = ""
		}
		mimeType := map[string]string{
			".png":  "image/png",
			".jpg":  "image/jpeg",
			".jpeg": "image/jpeg",
			".svg":  "image/svg+xml",
			".gif":  "image/gif",
			".webp": "image/webp",
		}[ext]
		if mimeType == "" {
			respondErr(w, 422, "Unsupported type. Use PNG, JPG, SVG, GIF, or WebP.")
			return
		}

		imgData, err := io.ReadAll(io.LimitReader(file, maxSize))
		if err != nil {
			respondErr(w, 500, "Read failed")
			return
		}
		dataURL := "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(imgData)

		user := core.UserFromCtx(r.Context())
		if _, err := db.PGExec(r.Context(), `
			INSERT INTO api_credentials
			    (key_name, description, category, is_secret, encrypted_value, is_active, updated_at, updated_by)
			VALUES ('EMAIL_LOGO_URL','Logo image embedded in notification emails','messaging',FALSE,$1,TRUE,NOW(),$2)
			ON CONFLICT (key_name) DO UPDATE
			    SET encrypted_value=$1, is_active=TRUE, updated_at=NOW(), updated_by=$2`,
			dataURL, user.ID); err != nil {
			slog.Error("uploadEmailLogo: db error", "err", err)
			respondErr(w, 500, "Save failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	}
}

// ── Vendor Integration Registry (Wave 5I) ─────────────────────────────────────

func listIntegrations(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, name, type, status, COALESCE(health_url,'') AS health_url,
			        last_ping, last_status_code, key_expiry, owner, notes, updated_at
			 FROM vendor_integrations ORDER BY name`)
		if err != nil {
			respondErr(w, 500, "DB error")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func createIntegration(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name       string `json:"name"`
			Type       string `json:"type"`
			Status     string `json:"status"`
			HealthURL  string `json:"health_url"`
			KeyExpiry  string `json:"key_expiry"`
			Owner      string `json:"owner"`
			Notes      string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if body.Status == "" {
			body.Status = "unknown"
		}
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO vendor_integrations (name, type, status, health_url, key_expiry, owner, notes)
			 VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,'')::timestamptz,$6,$7)
			 RETURNING *`,
			body.Name, body.Type, body.Status, body.HealthURL, body.KeyExpiry, body.Owner, body.Notes)
		if err != nil {
			slog.Error("createIntegration", "err", err)
			respondErr(w, 500, "DB error")
			return
		}
		if len(rows) > 0 {
			respond(w, rows[0], "pg")
		}
	}
}

func updateIntegration(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body struct {
			Name      string `json:"name"`
			Type      string `json:"type"`
			Status    string `json:"status"`
			HealthURL string `json:"health_url"`
			KeyExpiry string `json:"key_expiry"`
			Owner     string `json:"owner"`
			Notes     string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`UPDATE vendor_integrations
			 SET name=$1, type=$2, status=$3, health_url=NULLIF($4,''),
			     key_expiry=NULLIF($5,'')::timestamptz, owner=$6, notes=$7, updated_at=NOW()
			 WHERE id=$8 RETURNING *`,
			body.Name, body.Type, body.Status, body.HealthURL, body.KeyExpiry, body.Owner, body.Notes, id)
		if err != nil {
			respondErr(w, 500, "DB error")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func deleteIntegration(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `DELETE FROM vendor_integrations WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(http.StatusNoContent)
	}
}

func pingIntegration(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		rows, err := db.PGQuery(r.Context(),
			`SELECT health_url FROM vendor_integrations WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		healthURL := str(rows[0]["health_url"])
		if healthURL == "" {
			// No URL — mark status as unknown and return
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE vendor_integrations SET last_ping=NOW(), status='unknown', updated_at=NOW() WHERE id=$1`, id)
			respond(w, map[string]any{"status": "unknown", "note": "no health_url configured"}, "pg")
			return
		}

		// Ping with a short timeout
		client := &http.Client{Timeout: 8 * time.Second}
		resp, pingErr := client.Get(healthURL) //nolint:noctx
		statusCode := 0
		newStatus := "down"
		if pingErr == nil {
			resp.Body.Close()
			statusCode = resp.StatusCode
			if statusCode >= 200 && statusCode < 400 {
				newStatus = "active"
			} else if statusCode >= 400 && statusCode < 500 {
				newStatus = "degraded"
			}
		}

		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE vendor_integrations
			 SET last_ping=NOW(), last_status_code=$1, status=$2, updated_at=NOW()
			 WHERE id=$3`,
			statusCode, newStatus, id)

		respond(w, map[string]any{
			"status":      newStatus,
			"status_code": statusCode,
			"pinged_at":   time.Now(),
		}, "pg")
	}
}
