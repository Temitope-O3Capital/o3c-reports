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
	r.Put("/read-all", notificationsReadAll(db))
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

func notificationsListHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		limit := qint(r, "limit", 20, 1, 100)
		offset := qint(r, "offset", 0, 0, 1<<30)

		rows, err := db.PGQuery(r.Context(), `
			SELECT id, type, title, body, entity_type, entity_id, is_read, created_at
			FROM notifications
			WHERE user_id = $1
			ORDER BY created_at DESC
			LIMIT $2 OFFSET $3`, user.ID, limit, offset)
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
			UPDATE notifications SET is_read = TRUE
			WHERE id = $1 AND user_id = $2`, id, user.ID)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "Marked as read")
	}
}

func notificationsReadAll(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())

		_, err := db.PGExec(r.Context(), `
			UPDATE notifications SET is_read = TRUE
			WHERE user_id = $1 AND is_read = FALSE`, user.ID)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "All notifications marked as read")
	}
}

// notificationsSSE streams real-time notifications via Server-Sent Events.
// Authenticated via a short-lived ?ticket= query param (EventSource cannot send headers).
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
		// Build a minimal user struct from the ticket claims for the query below.
		type sseUser struct{ ID int64 }
		user := &sseUser{ID: claims.ID}

		flusher, ok := w.(http.Flusher)
		if !ok {
			respondErr(w, 500, "Streaming not supported")
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		ctx := r.Context()

		// Seed lastID with the current max so we only push new notifications.
		var lastID int64
		seedRows, err := db.PGQuery(ctx, `SELECT COALESCE(MAX(id), 0) AS max_id FROM notifications WHERE user_id = $1`, user.ID)
		if err == nil && len(seedRows) > 0 {
			lastID = toInt64(seedRows[0]["max_id"])
		}

		fmt.Fprintf(w, ":keepalive\n\n")
		flusher.Flush()

		poll := time.NewTicker(2 * time.Second)
		keepalive := time.NewTicker(30 * time.Second)
		defer poll.Stop()
		defer keepalive.Stop()

		for {
			select {
			case <-ctx.Done():
				return

			case <-keepalive.C:
				fmt.Fprintf(w, ":keepalive\n\n")
				flusher.Flush()

			case <-poll.C:
				rows, err := db.PGQuery(ctx, `
					SELECT id, type, title, body, entity_type, entity_id, is_read, created_at
					FROM notifications
					WHERE user_id = $1 AND id > $2
					ORDER BY id ASC`, user.ID, lastID)
				if err != nil {
					continue
				}
				for _, row := range rows {
					payload, err := json.Marshal(row)
					if err != nil {
						continue
					}
					fmt.Fprintf(w, "data: %s\n\n", payload)
					flusher.Flush()
					if id := toInt64(row["id"]); id > lastID {
						lastID = id
					}
				}
			}
		}
	}
}

// sendNotification inserts a notification row and fires NOTIFY on the per-user channel.
// Used by other handlers (LOS assignment, etc.) to push real-time alerts.
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
	return err
}
