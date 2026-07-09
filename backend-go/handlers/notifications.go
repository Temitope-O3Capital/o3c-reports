package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterNotifications mounts auth-protected notification endpoints.
// The SSE endpoint is registered separately via RegisterNotificationsSSE
// because EventSource cannot send Authorization headers.
func RegisterNotifications(r chi.Router, db *core.DB) {
	r.Get("/", notificationsListHandler(db))
	r.Get("/count", notificationsCountHandler(db))
	r.Put("/{id}/read", notificationsMarkRead(db))
	r.Patch("/{id}/read", notificationsMarkRead(db))
	r.Put("/read-all", notificationsReadAll(db))
	r.Post("/mark-all-read", notificationsReadAll(db))
	r.Delete("/{id}", notificationsDelete(db))
	r.Post("/sse-ticket", notificationsSSETicket())
}

// RegisterNotificationsSSE mounts the SSE stream outside the auth middleware.
// The handler validates a short-lived ticket from the ?ticket= query param.
func RegisterNotificationsSSE(r chi.Router, db *core.DB) {
	r.Get("/sse", notificationsSSE(db))
}

// notificationsSSETicket returns a short-lived token for the SSE endpoint.
func notificationsSSETicket() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ticket, err := core.CreateSSEToken(user.ID)
		if err != nil {
			respondErr(w, 500, "Could not issue ticket")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"ticket": ticket}) //nolint:errcheck
	}
}

// notificationsListHandler lists the authenticated user's notifications.
// Query params:
//   - unread_only=true — filter to unread notifications only
//   - page            — 1-based page number (default 1)
//   - per_page        — items per page, max 50 (default 20)
//   - limit/offset    — legacy pagination (lower precedence than page/per_page)
//
// Response: {"total": N, "unread_count": N, "notifications": [...]}
func notificationsListHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())

		// Support both page/per_page and legacy limit/offset.
		perPage := qint(r, "per_page", 0, 1, 50)
		if perPage == 0 {
			perPage = qint(r, "limit", 20, 1, 100)
		}
		page := qint(r, "page", 1, 1, 1<<30)
		offset := (page - 1) * perPage
		// Legacy offset overrides page-based offset only when page param absent and offset param present.
		if r.URL.Query().Get("page") == "" && r.URL.Query().Get("offset") != "" {
			offset = qint(r, "offset", 0, 0, 1<<30)
		}

		unreadOnly := qstr(r, "unread_only") == "true" || qstr(r, "unread_only") == "1"

		whereClause := "user_id = $1"
		args := []any{user.ID}
		if unreadOnly {
			whereClause += " AND is_read = FALSE"
		}

		// Total count matching the filter
		total := int64(0)
		if tr, _ := db.PGQuery(r.Context(),
			"SELECT COUNT(*) AS n FROM notifications WHERE "+whereClause, args...); len(tr) > 0 {
			total = toInt64(tr[0]["n"])
		}

		// Unread count (always — regardless of filter — so the badge stays accurate)
		unreadCount := int64(0)
		if ucRows, _ := db.PGQuery(r.Context(),
			"SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE", user.ID); len(ucRows) > 0 {
			unreadCount = toInt64(ucRows[0]["n"])
		}

		pageArgs := append(args, perPage, offset)
		n := len(args) + 1
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT id, type, title, body, entity_type, entity_id, action_url,
			       is_read, read_at, created_at
			FROM notifications
			WHERE %s
			ORDER BY created_at DESC
			LIMIT $%d OFFSET $%d`, whereClause, n, n+1), pageArgs...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"total":         total,
			"unread_count":  unreadCount,
			"notifications": rows,
		})
	}
}

func notificationsCountHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS unread FROM notifications
			WHERE user_id = $1 AND is_read = FALSE`, user.ID)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		unread := int64(0)
		if len(rows) > 0 {
			unread = toInt64(rows[0]["unread"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int64{"unread": unread}) //nolint:errcheck
	}
}

func notificationsMarkRead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid notification ID")
			return
		}
		user := core.UserFromCtx(r.Context())

		_, err = db.PGExec(r.Context(), `
			UPDATE notifications SET is_read = TRUE, read_at = NOW()
			WHERE id = $1 AND user_id = $2`, id, user.ID)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	}
}

func notificationsReadAll(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())

		_, err := db.PGExec(r.Context(), `
			UPDATE notifications SET is_read = TRUE, read_at = NOW()
			WHERE user_id = $1 AND is_read = FALSE`, user.ID)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	}
}

// notificationsDelete deletes a single notification for the authenticated user.
// Only the notification's owner can delete it.
func notificationsDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid notification ID")
			return
		}
		user := core.UserFromCtx(r.Context())

		res, err := db.PGExec(r.Context(),
			`DELETE FROM notifications WHERE id = $1 AND user_id = $2`, id, user.ID)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			respondErr(w, 404, "Notification not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "deleted"}) //nolint:errcheck
	}
}

// notificationsSSE streams real-time notifications via Server-Sent Events.
// Authenticated via a short-lived ?ticket= query param (EventSource cannot send headers).
// Uses 4-second polling against the pool rather than a dedicated LISTEN connection,
// which avoids pgx.Connect failures in environments where private-network DNS
// resolution or connection limits differ from the main pool.
func notificationsSSE(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ticket := r.URL.Query().Get("ticket")
		if ticket == "" {
			respondErr(w, 401, "Missing SSE ticket")
			return
		}
		claims, err := core.VerifySSEToken(ticket)
		if err != nil {
			respondErr(w, 401, "Invalid or expired SSE ticket")
			return
		}
		type sseUser struct{ ID int64 }
		user := &sseUser{ID: claims.ID}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		// NewResponseController unwraps any middleware-wrapped ResponseWriter
		// (e.g. httprate's recorder) to reach the underlying Flusher.
		rc := http.NewResponseController(w)

		ctx := r.Context()

		// Seed lastID so we only push notifications that arrive after this connection opens.
		var lastID int64
		seedRows, err := db.PGQuery(ctx, `SELECT COALESCE(MAX(id), 0) AS max_id FROM notifications WHERE user_id = $1`, user.ID)
		if err == nil && len(seedRows) > 0 {
			lastID = toInt64(seedRows[0]["max_id"])
		}

		fmt.Fprintf(w, ":keepalive\n\n") //nolint:errcheck
		rc.Flush()                        //nolint:errcheck

		poll := time.NewTicker(4 * time.Second)
		heartbeat := time.NewTicker(25 * time.Second)
		defer poll.Stop()
		defer heartbeat.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-heartbeat.C:
				fmt.Fprintf(w, ":keepalive\n\n") //nolint:errcheck
				rc.Flush()                        //nolint:errcheck
			case <-poll.C:
				rows, err := db.PGQuery(ctx, `
					SELECT id, type, title, body, entity_type, entity_id, action_url,
					       is_read, read_at, created_at
					FROM notifications
					WHERE user_id = $1 AND id > $2
					ORDER BY id
					LIMIT 20`, user.ID, lastID)
				if err != nil {
					continue
				}
				for _, row := range rows {
					payload, merr := json.Marshal(row)
					if merr != nil {
						continue
					}
					fmt.Fprintf(w, "data: %s\n\n", payload) //nolint:errcheck
					lastID = toInt64(row["id"])
				}
				if len(rows) > 0 {
					rc.Flush() //nolint:errcheck
				}
			}
		}
	}
}

// sendNotification inserts a notification row and fires NOTIFY on the per-user channel.
// Used by other handlers (LOS assignment, helpdesk, collections, recovery) to push real-time alerts.
func sendNotification(ctx context.Context, db *core.DB, userID int64, notifType, title, body, entityType string, entityID int64) error {
	rows, err := db.PGQuery(ctx, `
		INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, is_read, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW())
		RETURNING id`,
		userID, notifType, title, body, entityType, entityID)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("no id returned from notification insert")
	}

	notifID := toInt64(rows[0]["id"])
	channel := fmt.Sprintf("notifications_%d", userID)

	// NOTIFY carries the notification ID; the SSE listener fetches the full row.
	_, err = db.PGExec(ctx, fmt.Sprintf("NOTIFY %s, '%d'", channel, notifID))
	sendNotificationEmail(ctx, db, userID, notifType, title, body, entityType, entityID)
	return err
}

func sendNotificationEmail(ctx context.Context, db *core.DB, userID int64, notifType, title, body, entityType string, entityID int64) {
	if !notificationEmailEnabled(ctx, db) {
		return
	}
	rows, err := db.PGQuery(ctx, `
		SELECT email, COALESCE(full_name, first_name, email) AS name
		FROM o3c_users
		WHERE id=$1 AND COALESCE(is_active, true)=true AND deleted_at IS NULL`, userID)
	if err != nil || len(rows) == 0 || str(rows[0]["email"]) == "" {
		return
	}
	html := fmt.Sprintf(`
		<p>Hello %s,</p>
		<p>%s</p>
		<p style="color:#64748b;font-size:13px;">This notification was generated by the O3 Capital portal.</p>`,
		escapeMailHTML(str(rows[0]["name"])), escapeMailHTML(body))
	SendMail(ctx, db, SendMailOptions{
		To:          []MailAddress{{Email: str(rows[0]["email"]), Name: str(rows[0]["name"])}},
		Subject:     title,
		HTMLBody:    html,
		TextBody:    body,
		Category:    "notification",
		Kind:        "notification",
		RelatedType: entityType,
		RelatedID:   entityID,
		CustomArgs: map[string]string{
			"o3c_notification_type": notifType,
		},
	})
}

func notificationEmailEnabled(ctx context.Context, db *core.DB) bool {
	rows, err := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='notification_email_enabled'`)
	if err != nil || len(rows) == 0 {
		return true
	}
	return str(rows[0]["value"]) != "false"
}
