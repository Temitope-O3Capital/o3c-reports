package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// TODO: CREATE TABLE notification_preferences (user_id BIGINT, event_type TEXT, channel TEXT, enabled BOOL, updated_at TIMESTAMPTZ, PRIMARY KEY (user_id, event_type, channel))

// RegisterNotificationPrefs mounts user-facing preference endpoints.
// Mount under /api/user inside the auth group.
func RegisterNotificationPrefs(r chi.Router, db *core.DB) {
	r.Get("/notification-preferences", getUserNotifPrefs(db))
	r.Put("/notification-preferences", putUserNotifPrefs(db))
}

// RegisterNotificationSettings mounts admin notification config endpoints.
// Mount under /api/admin inside the auth group.
func RegisterNotificationSettings(r chi.Router, db *core.DB) {
	r.Get("/notification-settings", getAdminNotifSettings(db))
	r.Put("/notification-settings", putAdminNotifSettings(db))
}

// getUserNotifPrefs returns the merged view: global defaults with user overrides applied.
// Each row includes: event_type, channel, enabled (global default), label, description,
// user_enabled (effective value for this user), has_override (true if user set their own pref).
func getUserNotifPrefs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())

		cfgRows, _ := db.PGQuery(r.Context(),
			`SELECT event_type, channel, enabled, label, description
			 FROM notification_event_config ORDER BY event_type, channel`)
		if cfgRows == nil {
			cfgRows = []core.Row{}
		}

		// notification_preferences may not exist yet — ignore error, treat as no overrides.
		prefRows, _ := db.PGQuery(r.Context(),
			`SELECT event_type, channel, enabled
			 FROM notification_preferences WHERE user_id=$1`, user.ID)

		overrides   := map[string]bool{}
		overrideSet := map[string]bool{}
		for _, row := range prefRows {
			k := str(row["event_type"]) + ":" + str(row["channel"])
			overrides[k]   = row["enabled"] == true
			overrideSet[k] = true
		}

		for i, row := range cfgRows {
			k := str(row["event_type"]) + ":" + str(row["channel"])
			if overrideSet[k] {
				cfgRows[i]["user_enabled"] = overrides[k]
			} else {
				cfgRows[i]["user_enabled"] = row["enabled"]
			}
			cfgRows[i]["has_override"] = overrideSet[k]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cfgRows) //nolint:errcheck
	}
}

// putUserNotifPrefs bulk-upserts the calling user's preferences.
// Body: [{"event_type":"task_assigned","channel":"email","enabled":true}, ...]
func putUserNotifPrefs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var items []struct {
			EventType string `json:"event_type"`
			Channel   string `json:"channel"`
			Enabled   bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&items); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		for _, item := range items {
			db.PGExec(r.Context(), //nolint:errcheck
				`INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (user_id, event_type, channel) DO UPDATE SET enabled=EXCLUDED.enabled`,
				user.ID, item.EventType, item.Channel, item.Enabled)
		}
		w.WriteHeader(204)
	}
}

func getAdminNotifSettings(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT event_type, channel, enabled, label, description
			 FROM notification_event_config ORDER BY event_type, channel`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

// putAdminNotifSettings bulk-updates global event config.
// Body: [{"event_type":"task_assigned","channel":"email","enabled":false}, ...]
func putAdminNotifSettings(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var items []struct {
			EventType string `json:"event_type"`
			Channel   string `json:"channel"`
			Enabled   bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&items); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		for _, item := range items {
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE notification_event_config SET enabled=$1
				 WHERE event_type=$2 AND channel=$3`,
				item.Enabled, item.EventType, item.Channel)
		}
		w.WriteHeader(204)
	}
}
