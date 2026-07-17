package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterModules wires the module-config endpoints.
// Public read is on /api/modules (any auth user).
// Admin CRUD is on /api/admin/modules (it_admin only, registered in admin.go routes).
func RegisterModules(r chi.Router, db *core.DB) {
	r.Get("/", listModulesAdmin(db))
	r.Put("/{key}", toggleModule(db))
}

// GET /api/modules — any authenticated user.
// Returns the set of enabled module keys for sidebar filtering.
func GetEnabledModules(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT key FROM module_config WHERE enabled = true ORDER BY sort_order`)
		if err != nil {
			respondErr(w, 500, "database error")
			return
		}
		keys := make([]string, 0, len(rows))
		for _, row := range rows {
			if k, ok := row["key"].(string); ok {
				keys = append(keys, k)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"enabled": keys}) //nolint:errcheck
	}
}

// GET /api/admin/modules — it_admin only, full list with metadata.
func listModulesAdmin(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT key, label, enabled, sort_order, updated_at, updated_by
			 FROM module_config ORDER BY sort_order`)
		if err != nil {
			respondErr(w, 500, "database error")
			return
		}
		respond(w, rows, "pg")
	}
}

// PUT /api/admin/modules/:key — it_admin only, toggle a single module.
func toggleModule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")

		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "invalid body")
			return
		}

		user := core.UserFromCtx(r.Context())
		updatedBy := ""
		if user != nil {
			updatedBy = user.FullName
		}

		_, err := db.PGExec(r.Context(),
			`UPDATE module_config SET enabled=$1, updated_at=NOW(), updated_by=$2 WHERE key=$3`,
			body.Enabled, updatedBy, key)
		if err != nil {
			respondErr(w, 500, "database error")
			return
		}

		respond(w, map[string]any{"key": key, "enabled": body.Enabled}, "pg")
	}
}
