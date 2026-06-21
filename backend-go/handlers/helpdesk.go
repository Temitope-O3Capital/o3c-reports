// Package handlers — Helpdesk module
//
// NOTE for main.go:
//   Public (no auth): /api/helpdesk/inbound/email, /api/helpdesk/inbound/sms, /api/helpdesk/csat/*
//   Protected (auth): remaining /api/helpdesk/* routes
//   Call: RegisterHelpdesk(r, db)
//
// Registration pattern (in main.go):
//
//   // Public (outside auth group):
//   r.Route("/api/helpdesk", func(r chi.Router) {
//       handlers.RegisterHelpdeskPublic(r, db)
//   })
//   // Protected (inside auth group):
//   r.Route("/api/helpdesk", func(r chi.Router) {
//       handlers.RegisterHelpdeskProtected(r, db)
//   })
//
// OR use the combined helper:
//   handlers.RegisterHelpdesk(r, db)   // mounts all routes directly on r

package handlers

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Route registration ────────────────────────────────────────────────────────

// RegisterHelpdeskPublic mounts no-auth helpdesk endpoints.
// Call this BEFORE the JWT auth middleware group in main.go.
func RegisterHelpdeskPublic(r chi.Router, db *core.DB) {
	r.Post("/inbound/email", hdInboundEmail(db))
	r.Post("/inbound/sms", hdInboundSMS(db))
	r.Get("/csat/{token}", hdCSATGet(db))
	r.Post("/csat/{token}", hdCSATSubmit(db))
}

// RegisterHelpdesk mounts auth-protected helpdesk endpoints.
// Call this INSIDE the JWT auth middleware group in main.go.
func RegisterHelpdesk(r chi.Router, db *core.DB) {
	r.Get("/stats", hdStats(db))
	r.Post("/tickets", hdCreateTicket(db))
	r.Get("/tickets", hdListTickets(db))
	r.Get("/tickets/search", hdSearchTickets(db))
	r.Get("/tickets/{id}", hdGetTicket(db))
	r.Patch("/tickets/{id}", hdUpdateTicket(db))
	r.Post("/tickets/{id}/messages", hdSendMessage(db))
	r.Post("/tickets/{id}/merge", hdMergeTicket(db))
	r.Get("/canned-responses", hdListCanned(db))
	r.Post("/canned-responses", hdCreateCanned(db))
	r.Put("/canned-responses/{id}", hdUpdateCanned(db))
	r.Delete("/canned-responses/{id}", hdDeleteCanned(db))
	r.Get("/sla-policies", hdListSLA(db))
	r.Put("/sla-policies/{id}", hdUpdateSLA(db))
}

// ── Tickets ───────────────────────────────────────────────────────────────────

func hdCreateTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Channel      string  `json:"channel"`
			Subject      string  `json:"subject"`
			CustomerCIF  *string `json:"customer_cif"`
			CustomerName *string `json:"customer_name"`
			CustomerEmail *string `json:"customer_email"`
			CustomerPhone *string `json:"customer_phone"`
			Priority     *string `json:"priority"`
			Department   *string `json:"department"`
			MessageText  string  `json:"message_text"`
			MessageHTML  *string `json:"message_html"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Channel == "" {
			respondErr(w, 422, "channel is required")
			return
		}
		if b.Subject == "" {
			respondErr(w, 422, "subject is required")
			return
		}
		if b.MessageText == "" {
			respondErr(w, 422, "message_text is required")
			return
		}

		priority := "normal"
		if b.Priority != nil && *b.Priority != "" {
			priority = *b.Priority
		}

		// Look up SLA for priority
		slaDueAt := hdComputeSLADue(r.Context(), db, priority)

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_tickets
			    (channel, status, priority, subject, customer_cif, customer_name,
			     customer_email, customer_phone, department, sla_due_at)
			VALUES ($1,'open',$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING *`,
			b.Channel, priority, b.Subject,
			ptrOrNil(b.CustomerCIF), ptrOrNil(b.CustomerName),
			ptrOrNil(b.CustomerEmail), ptrOrNil(b.CustomerPhone),
			ptrOrNil(b.Department), slaDueAt)
		if err != nil {
			slog.Error("hdCreateTicket: insert ticket", "err", err)
			respondErr(w, 500, "Could not create ticket")
			return
		}
		ticket := rows[0]
		ticketID := toInt64(ticket["id"])

		// Insert first message
		msgRows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_user_id, author_name,
			     body_text, body_html, is_internal_note)
			VALUES ($1,'outbound',$2,$3,$4,$5,$6,false)
			RETURNING *`,
			ticketID, b.Channel, user.ID, user.FullName,
			b.MessageText, ptrOrNil(b.MessageHTML))
		if err != nil {
			slog.Error("hdCreateTicket: insert message", "err", err)
		}

		// Record created event
		hdRecordEvent(r.Context(), db, ticketID, user.ID, "created", "", str(ticket["ticket_ref"]))

		// Send via channel
		ctx := r.Context()
		if b.CustomerEmail != nil && *b.CustomerEmail != "" {
			go hdSendTicketEmail(context.Background(), db, ticket, b.MessageText, ptrStr(b.MessageHTML), "", "", "")
		}
		if b.CustomerPhone != nil && *b.CustomerPhone != "" && b.Channel == "sms" {
			go sendSMS(context.Background(), db, *b.CustomerPhone, b.MessageText)
		}
		_ = ctx

		msg := map[string]any{}
		if len(msgRows) > 0 {
			msg = msgRows[0]
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ticket":  ticket,
			"message": msg,
		})
	}
}

func hdListTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		page := qint(r, "page", 1, 1, 10000)
		perPage := qint(r, "per_page", 25, 1, 200)
		offset := (page - 1) * perPage

		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND t.status=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "priority"); v != "" {
			where += fmt.Sprintf(" AND t.priority=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "channel"); v != "" {
			where += fmt.Sprintf(" AND t.channel=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "department"); v != "" {
			where += fmt.Sprintf(" AND t.department=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "assigned_to"); v != "" {
			where += fmt.Sprintf(" AND t.assigned_to=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "search"); v != "" {
			where += fmt.Sprintf(` AND (t.subject ILIKE $%d OR t.customer_name ILIKE $%d OR t.customer_cif ILIKE $%d OR t.ticket_ref ILIKE $%d)`, n, n, n, n)
			args = append(args, "%"+v+"%")
			n++
		}
		if v := qstr(r, "date_from"); v != "" {
			where += fmt.Sprintf(" AND t.created_at::date >= $%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "date_to"); v != "" {
			where += fmt.Sprintf(" AND t.created_at::date <= $%d", n)
			args = append(args, v)
			n++
		}

		filterArgs := append([]any(nil), args...)
		total := 0
		if tr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM helpdesk_tickets t WHERE %s", where), filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}

		args = append(args, perPage, offset)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				t.id, t.ticket_ref, t.channel, t.status, t.priority, t.subject,
				t.customer_name, t.customer_cif, t.assigned_to, t.department,
				t.sla_due_at, t.created_at,
				u.full_name AS assigned_to_name,
				(SELECT COUNT(*) FROM helpdesk_messages m WHERE m.ticket_id=t.id) AS message_count,
				(SELECT MAX(m2.created_at) FROM helpdesk_messages m2 WHERE m2.ticket_id=t.id) AS last_message_at,
				(SELECT LEFT(m3.body_text,120) FROM helpdesk_messages m3 WHERE m3.ticket_id=t.id ORDER BY m3.created_at DESC LIMIT 1) AS last_message_preview,
				(t.sla_due_at IS NOT NULL AND t.sla_due_at < NOW() AND t.status NOT IN ('resolved','closed')) AS sla_breached
			FROM helpdesk_tickets t
			LEFT JOIN o3c_users u ON t.assigned_to=u.id
			WHERE %s
			ORDER BY t.created_at DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"total":    total,
			"page":     page,
			"per_page": perPage,
			"tickets":  rows,
		})
	}
}

func hdGetTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		tRows, err := db.PGQuery(r.Context(), `
			SELECT t.*, u.full_name AS assigned_to_name
			FROM helpdesk_tickets t
			LEFT JOIN o3c_users u ON t.assigned_to=u.id
			WHERE t.id=$1`, id)
		if err != nil || len(tRows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		ticket := tRows[0]

		msgs, _ := db.PGQuery(r.Context(), `
			SELECT m.*, u.full_name AS author_user_name
			FROM helpdesk_messages m
			LEFT JOIN o3c_users u ON m.author_user_id=u.id
			WHERE m.ticket_id=$1
			ORDER BY m.created_at ASC`, id)

		events, _ := db.PGQuery(r.Context(), `
			SELECT e.*, u.full_name AS user_name
			FROM helpdesk_events e
			LEFT JOIN o3c_users u ON e.user_id=u.id
			WHERE e.ticket_id=$1
			ORDER BY e.ts ASC`, id)

		if msgs == nil {
			msgs = []core.Row{}
		}
		if events == nil {
			events = []core.Row{}
		}

		// Build customer context from CIF
		cif := str(ticket["customer_cif"])
		customerCtx := hdCustomerContext(r.Context(), db, cif)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ticket":           ticket,
			"messages":         msgs,
			"events":           events,
			"customer_context": customerCtx,
		})
	}
}

func hdUpdateTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		tRows, _ := db.PGQuery(r.Context(), `SELECT * FROM helpdesk_tickets WHERE id=$1`, id)
		if len(tRows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		ticket := tRows[0]
		ticketID := toInt64(ticket["id"])

		var b map[string]any
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		var setParts []string
		var args []any
		n := 1

		allowed := []string{"subject", "department", "tags"}
		for _, col := range allowed {
			if v, ok := b[col]; ok {
				setParts = append(setParts, fmt.Sprintf("%s=$%d", col, n))
				args = append(args, v)
				n++
			}
		}

		// Status change
		if newStatus, ok := b["status"].(string); ok && newStatus != str(ticket["status"]) {
			oldStatus := str(ticket["status"])
			setParts = append(setParts, fmt.Sprintf("status=$%d", n))
			args = append(args, newStatus)
			n++
			switch newStatus {
			case "resolved":
				setParts = append(setParts, "resolved_at=NOW()")
				// Send CSAT
				go hdSendCSATEmail(context.Background(), db, ticket)
			case "closed":
				setParts = append(setParts, "closed_at=NOW()")
			}
			hdRecordEvent(ctx, db, ticketID, user.ID, "status_changed", oldStatus, newStatus)
		}

		// Priority change
		if newPri, ok := b["priority"].(string); ok && newPri != str(ticket["priority"]) {
			oldPri := str(ticket["priority"])
			setParts = append(setParts, fmt.Sprintf("priority=$%d", n))
			args = append(args, newPri)
			n++
			// Recompute SLA
			newSLA := hdComputeSLADue(ctx, db, newPri)
			if newSLA != nil {
				setParts = append(setParts, fmt.Sprintf("sla_due_at=$%d", n))
				args = append(args, newSLA)
				n++
			}
			hdRecordEvent(ctx, db, ticketID, user.ID, "priority_changed", oldPri, newPri)
		}

		// Assignment change
		if newAssign, ok := b["assigned_to"]; ok {
			oldAssign := fmt.Sprintf("%v", ticket["assigned_to"])
			var newAssignID int64
			switch v := newAssign.(type) {
			case float64:
				newAssignID = int64(v)
			case int64:
				newAssignID = v
			}
			if newAssignID > 0 {
				setParts = append(setParts, fmt.Sprintf("assigned_to=$%d, assigned_at=NOW()", n))
				args = append(args, newAssignID)
				n++
				// Get assignee name for event
				nameRows, _ := db.PGQuery(ctx, "SELECT full_name FROM o3c_users WHERE id=$1", newAssignID)
				newAssignName := ""
				if len(nameRows) > 0 {
					newAssignName = str(nameRows[0]["full_name"])
				}
				hdRecordEvent(ctx, db, ticketID, user.ID, "assigned", oldAssign, newAssignName)
				// Notify new assignee via all enabled channels
				if newAssignID != user.ID {
					go Notify(context.Background(), db, NotifPayload{
						EventType: EvtTicketAssigned,
						UserID:    newAssignID,
						Title:     fmt.Sprintf("Ticket assigned: %s", str(ticket["ticket_ref"])),
						Body:      fmt.Sprintf("You've been assigned ticket %s: %s", str(ticket["ticket_ref"]), str(ticket["subject"])),
						ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
						EntityRef: fmt.Sprintf("ticket:%d", ticketID),
					})
				}
			} else {
				setParts = append(setParts, fmt.Sprintf("assigned_to=$%d, assigned_at=NULL", n))
				args = append(args, nil)
				n++
				hdRecordEvent(ctx, db, ticketID, user.ID, "unassigned", oldAssign, "")
			}
		}

		if len(setParts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		setParts = append(setParts, "updated_at=NOW()")
		args = append(args, id)
		_, err := db.PGExec(ctx, fmt.Sprintf("UPDATE helpdesk_tickets SET %s WHERE id=$%d",
			strings.Join(setParts, ","), n), args...)
		if err != nil {
			slog.Error("hdUpdateTicket", "err", err)
			respondErr(w, 500, "Update failed")
			return
		}

		updated, _ := db.PGQuery(ctx, `
			SELECT t.*, u.full_name AS assigned_to_name
			FROM helpdesk_tickets t LEFT JOIN o3c_users u ON t.assigned_to=u.id
			WHERE t.id=$1`, id)
		if len(updated) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(updated[0]) //nolint:errcheck
	}
}

func hdSendMessage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		tRows, _ := db.PGQuery(r.Context(), `SELECT * FROM helpdesk_tickets WHERE id=$1`, id)
		if len(tRows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		ticket := tRows[0]
		ticketID := toInt64(ticket["id"])

		var b struct {
			BodyText       string          `json:"body_text"`
			BodyHTML       *string         `json:"body_html"`
			IsInternalNote bool            `json:"is_internal_note"`
			Channel        *string         `json:"channel"`
			Attachments    []MailAttachment `json:"attachments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.BodyText) == "" {
			respondErr(w, 422, "body_text is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		channel := str(ticket["channel"])
		if b.Channel != nil && *b.Channel != "" {
			channel = *b.Channel
		}

		attachJSON := "[]"
		if len(b.Attachments) > 0 {
			if raw, err := json.Marshal(b.Attachments); err == nil {
				attachJSON = string(raw)
			}
		}

		// Generate email Message-ID
		msgUUID := hdNewUUID()
		emailMsgID := fmt.Sprintf("<msg-%s@o3ccards.com>", msgUUID)

		// Get last message email_message_id for In-Reply-To
		lastMsgRows, _ := db.PGQuery(ctx, `
			SELECT email_message_id FROM helpdesk_messages
			WHERE ticket_id=$1 AND email_message_id IS NOT NULL
			ORDER BY created_at DESC LIMIT 1`, ticketID)
		inReplyTo := ""
		if len(lastMsgRows) > 0 {
			inReplyTo = str(lastMsgRows[0]["email_message_id"])
		}

		msgRows, err := db.PGQuery(ctx, `
			INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_user_id, author_name,
			     body_text, body_html, attachments, email_message_id, in_reply_to, is_internal_note)
			VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7::jsonb,$8,NULLIF($9,''),false)
			RETURNING *`,
			ticketID, channel, user.ID, user.FullName,
			b.BodyText, ptrOrNil(b.BodyHTML), attachJSON,
			emailMsgID, inReplyTo)
		if err != nil {
			slog.Error("hdSendMessage: insert", "err", err)
			respondErr(w, 500, "Could not insert message")
			return
		}
		msg := msgRows[0]

		// Set first_response_at if this is the first outbound reply
		if ticket["first_response_at"] == nil {
			db.PGExec(ctx, //nolint:errcheck
				"UPDATE helpdesk_tickets SET first_response_at=NOW(), updated_at=NOW() WHERE id=$1 AND first_response_at IS NULL",
				ticketID)
		} else {
			db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck
		}

		// Send externally unless internal note
		if !b.IsInternalNote {
			customerEmail := str(ticket["customer_email"])
			customerPhone := str(ticket["customer_phone"])
			ticketChannel := str(ticket["channel"])

			if ticketChannel == "email" && customerEmail != "" {
				agentName := user.FullName
				go hdSendTicketEmail(context.Background(), db, ticket, b.BodyText, ptrStr(b.BodyHTML), emailMsgID, inReplyTo, agentName)
			}
			if ticketChannel == "sms" && customerPhone != "" {
				go sendSMS(context.Background(), db, customerPhone, b.BodyText)
			}
			// New: deliver reply to customer via WhatsApp when channel is whatsapp
			if ticketChannel == "whatsapp" && customerPhone != "" {
				go sendWhatsApp(context.Background(), db, customerPhone, b.BodyText)
			}
		}

		// Notify the assigned agent when a new message arrives (if sender is not the assignee)
		if assignedID := toInt64(ticket["assigned_to"]); assignedID != 0 && assignedID != user.ID {
			ref := str(ticket["ticket_ref"])
			go Notify(context.Background(), db, NotifPayload{
				EventType: EvtTicketReplied,
				UserID:    assignedID,
				Title:     fmt.Sprintf("New message on ticket %s", ref),
				Body:      truncateStr(b.BodyText, 120),
				ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
				EntityRef: fmt.Sprintf("ticket:%d", ticketID),
			})
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(msg) //nolint:errcheck
	}
}

func hdSearchTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := qstr(r, "q")
		if q == "" {
			respondErr(w, 422, "q is required")
			return
		}
		page := qint(r, "page", 1, 1, 10000)
		perPage := qint(r, "per_page", 25, 1, 200)
		offset := (page - 1) * perPage

		// Ticket FTS
		ticketRows, _ := db.PGQuery(r.Context(), `
			SELECT t.id, t.ticket_ref, t.subject, t.status, t.priority, t.channel,
			       t.customer_name, t.customer_cif, t.created_at,
			       ts_rank(to_tsvector('english', coalesce(t.subject,'') || ' ' || coalesce(t.customer_name,'') || ' ' || coalesce(t.customer_cif,'')),
			               plainto_tsquery('english', $1)) AS rank,
			       'ticket' AS result_type
			FROM helpdesk_tickets t
			WHERE to_tsvector('english', coalesce(t.subject,'') || ' ' || coalesce(t.customer_name,'') || ' ' || coalesce(t.customer_cif,''))
			      @@ plainto_tsquery('english', $1)
			ORDER BY rank DESC
			LIMIT $2 OFFSET $3`, q, perPage, offset)

		// Message FTS
		msgRows, _ := db.PGQuery(r.Context(), `
			SELECT m.id, m.ticket_id, t.ticket_ref, LEFT(m.body_text,200) AS excerpt,
			       m.created_at, m.direction,
			       ts_rank(to_tsvector('english', coalesce(m.body_text,'')),
			               plainto_tsquery('english', $1)) AS rank,
			       'message' AS result_type
			FROM helpdesk_messages m
			JOIN helpdesk_tickets t ON m.ticket_id=t.id
			WHERE to_tsvector('english', coalesce(m.body_text,'')) @@ plainto_tsquery('english', $1)
			ORDER BY rank DESC
			LIMIT $2 OFFSET $3`, q, perPage, offset)

		if ticketRows == nil {
			ticketRows = []core.Row{}
		}
		if msgRows == nil {
			msgRows = []core.Row{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"tickets":  ticketRows,
			"messages": msgRows,
		})
	}
}

func hdMergeTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		srcID := chi.URLParam(r, "id")
		var b struct {
			TargetTicketID int64 `json:"target_ticket_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.TargetTicketID == 0 {
			respondErr(w, 422, "target_ticket_id is required")
			return
		}
		srcIDInt, _ := strconv.ParseInt(srcID, 10, 64)
		if srcIDInt == b.TargetTicketID {
			respondErr(w, 422, "source and target ticket must differ")
			return
		}

		// Verify both tickets exist
		sRows, _ := db.PGQuery(r.Context(), "SELECT ticket_ref FROM helpdesk_tickets WHERE id=$1", srcID)
		tRows, _ := db.PGQuery(r.Context(), "SELECT ticket_ref FROM helpdesk_tickets WHERE id=$1", b.TargetTicketID)
		if len(sRows) == 0 || len(tRows) == 0 {
			respondErr(w, 404, "Source or target ticket not found")
			return
		}

		ctx := r.Context()
		user := core.UserFromCtx(r.Context())

		// Move messages
		db.PGExec(ctx, "UPDATE helpdesk_messages SET ticket_id=$1 WHERE ticket_id=$2", b.TargetTicketID, srcIDInt) //nolint:errcheck

		// Record event on both
		hdRecordEvent(ctx, db, srcIDInt, user.ID, "merged_into", str(sRows[0]["ticket_ref"]), str(tRows[0]["ticket_ref"]))
		hdRecordEvent(ctx, db, b.TargetTicketID, user.ID, "merged_from", str(sRows[0]["ticket_ref"]), str(tRows[0]["ticket_ref"]))

		// Close source
		db.PGExec(ctx, "UPDATE helpdesk_tickets SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE id=$1", srcIDInt) //nolint:errcheck

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"merged":        true,
			"source_ticket": str(sRows[0]["ticket_ref"]),
			"target_ticket": str(tRows[0]["ticket_ref"]),
		})
	}
}

// ── Canned Responses ──────────────────────────────────────────────────────────

func hdListCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "channel"); v != "" {
			where += fmt.Sprintf(" AND (channel=$%d OR channel='both')", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "category"); v != "" {
			where += fmt.Sprintf(" AND category=$%d", n)
			args = append(args, v)
			n++
		}
		_ = n
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT * FROM helpdesk_canned_responses WHERE %s ORDER BY name ASC", where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

func hdCreateCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name     string  `json:"name"`
			Channel  string  `json:"channel"`
			Subject  *string `json:"subject"`
			BodyText string  `json:"body_text"`
			BodyHTML *string `json:"body_html"`
			Category *string `json:"category"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Name) == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if strings.TrimSpace(b.BodyText) == "" {
			respondErr(w, 422, "body_text is required")
			return
		}
		if b.Channel == "" {
			b.Channel = "both"
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_canned_responses (name, channel, subject, body_text, body_html, category, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
			b.Name, b.Channel, ptrOrNil(b.Subject), b.BodyText, ptrOrNil(b.BodyHTML), ptrOrNil(b.Category), user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func hdUpdateCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		allowed := []string{"name", "channel", "subject", "body_text", "body_html", "category"}
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		args = append(args, id)
		db.PGExec(r.Context(), fmt.Sprintf("UPDATE helpdesk_canned_responses SET %s WHERE id=$%d", //nolint:errcheck
			strings.Join(parts, ","), len(args)), args...)
		rows, _ := db.PGQuery(r.Context(), "SELECT * FROM helpdesk_canned_responses WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func hdDeleteCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), "SELECT id FROM helpdesk_canned_responses WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		db.PGExec(r.Context(), "DELETE FROM helpdesk_canned_responses WHERE id=$1", id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── SLA Policies ─────────────────────────────────────────────────────────────

func hdListSLA(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), "SELECT * FROM helpdesk_sla_policies ORDER BY first_response_hours ASC")
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

func hdUpdateSLA(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		allowed := []string{"name", "first_response_hours", "resolution_hours", "is_active"}
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		args = append(args, id)
		db.PGExec(r.Context(), fmt.Sprintf("UPDATE helpdesk_sla_policies SET %s WHERE id=$%d", //nolint:errcheck
			strings.Join(parts, ","), len(args)), args...)
		rows, _ := db.PGQuery(r.Context(), "SELECT * FROM helpdesk_sla_policies WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// ── Stats ─────────────────────────────────────────────────────────────────────

func hdStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Optional date range — defaults to last 30 days for time-bounded metrics
		dateFrom := qstr(r, "date_from")
		dateTo   := qstr(r, "date_to")

		// Predicate for date-range filtering; falls back to last 30 days when unset
		var dateClause string
		var dateArgs []any
		if dateFrom != "" && dateTo != "" {
			dateClause = "AND created_at >= $1 AND created_at < $2::date + 1"
			dateArgs = []any{dateFrom, dateTo}
		} else {
			dateClause = "AND created_at >= NOW() - INTERVAL '30 days'"
			dateArgs = []any{}
		}

		counts := map[string]int64{}
		if rows, _ := db.PGQuery(ctx, `
			SELECT status, COUNT(*) AS n
			FROM helpdesk_tickets
			WHERE status NOT IN ('closed')
			GROUP BY status`); rows != nil {
			for _, row := range rows {
				counts[str(row["status"])] = toInt64(row["n"])
			}
		}

		resolvedToday := int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n FROM helpdesk_tickets
			WHERE status='resolved' AND resolved_at::date=CURRENT_DATE`); len(rows) > 0 {
			resolvedToday = toInt64(rows[0]["n"])
		}

		slaBreached := int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n FROM helpdesk_tickets
			WHERE sla_due_at IS NOT NULL AND sla_due_at < NOW()
			  AND status NOT IN ('resolved','closed')`); len(rows) > 0 {
			slaBreached = toInt64(rows[0]["n"])
		}

		avgFirstResp := 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/3600) AS avg_hrs
			 FROM helpdesk_tickets
			 WHERE first_response_at IS NOT NULL `+dateClause, dateArgs...); len(rows) > 0 {
			if v, ok := rows[0]["avg_hrs"].(float64); ok {
				avgFirstResp = v
			}
		}

		avgResolution := 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) AS avg_hrs
			 FROM helpdesk_tickets
			 WHERE resolved_at IS NOT NULL `+dateClause, dateArgs...); len(rows) > 0 {
			if v, ok := rows[0]["avg_hrs"].(float64); ok {
				avgResolution = v
			}
		}

		avgCSAT := 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT AVG(csat_score::float) AS avg
			 FROM helpdesk_tickets
			 WHERE csat_score IS NOT NULL `+dateClause, dateArgs...); len(rows) > 0 {
			if v, ok := rows[0]["avg"].(float64); ok {
				avgCSAT = v
			}
		}

		byChannel := map[string]int64{}
		if rows, _ := db.PGQuery(ctx,
			`SELECT channel, COUNT(*) AS n FROM helpdesk_tickets
			 WHERE TRUE `+dateClause+` GROUP BY channel`, dateArgs...); rows != nil {
			for _, row := range rows {
				byChannel[str(row["channel"])] = toInt64(row["n"])
			}
		}

		byDept := map[string]int64{}
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(department,'general') AS department, COUNT(*) AS n
			 FROM helpdesk_tickets WHERE TRUE `+dateClause+` GROUP BY department`, dateArgs...); rows != nil {
			for _, row := range rows {
				byDept[str(row["department"])] = toInt64(row["n"])
			}
		}

		byAgent, _ := db.PGQuery(ctx,
			`SELECT u.full_name AS agent_name,
			        COUNT(*) FILTER (WHERE t.status NOT IN ('resolved','closed')) AS open_tickets,
			        COUNT(*) FILTER (WHERE t.status='resolved' AND t.resolved_at::date=CURRENT_DATE) AS resolved_today,
			        ROUND(AVG(t.csat_score::float) FILTER (WHERE t.csat_score IS NOT NULL), 1) AS avg_csat
			 FROM helpdesk_tickets t
			 JOIN o3c_users u ON t.assigned_to=u.id
			 WHERE t.assigned_to IS NOT NULL `+dateClause+`
			 GROUP BY u.full_name
			 ORDER BY u.full_name`, dateArgs...)
		if byAgent == nil {
			byAgent = []core.Row{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"open":                    counts["open"],
			"pending":                 counts["pending"],
			"in_progress":             counts["in_progress"],
			"resolved_today":          resolvedToday,
			"sla_breached":            slaBreached,
			"avg_first_response_hours": round2(avgFirstResp),
			"avg_resolution_hours":    round2(avgResolution),
			"avg_csat_score":          round2(avgCSAT),
			"by_channel":              byChannel,
			"by_department":           byDept,
			"by_agent":                byAgent,
		})
	}
}

// ── CSAT ─────────────────────────────────────────────────────────────────────

func hdCSATGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		rows, _ := db.PGQuery(r.Context(),
			"SELECT id, ticket_ref, customer_name, subject, csat_score, csat_comment, status FROM helpdesk_tickets WHERE csat_token=$1",
			token)
		if len(rows) == 0 {
			respondErr(w, 404, "Invalid CSAT token")
			return
		}
		ticket := rows[0]

		// If score is provided in query param (from email link click)
		if scoreStr := qstr(r, "score"); scoreStr != "" {
			score, err := strconv.Atoi(scoreStr)
			if err == nil && score >= 1 && score <= 5 {
				db.PGExec(r.Context(), //nolint:errcheck
					"UPDATE helpdesk_tickets SET csat_score=$1, updated_at=NOW() WHERE csat_token=$2 AND csat_score IS NULL",
					score, token)
				ticket["csat_score"] = int64(score)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ticket_ref":    ticket["ticket_ref"],
			"customer_name": ticket["customer_name"],
			"subject":       ticket["subject"],
			"status":        ticket["status"],
			"csat_score":    ticket["csat_score"],
			"csat_comment":  ticket["csat_comment"],
		})
	}
}

func hdCSATSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		var b struct {
			Score   int    `json:"score"`
			Comment string `json:"comment"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Score < 1 || b.Score > 5 {
			respondErr(w, 422, "score must be between 1 and 5")
			return
		}

		tRows, _ := db.PGQuery(r.Context(),
			"SELECT id, ticket_ref FROM helpdesk_tickets WHERE csat_token=$1", token)
		if len(tRows) == 0 {
			respondErr(w, 404, "Invalid CSAT token")
			return
		}
		ticketID := toInt64(tRows[0]["id"])

		db.PGExec(r.Context(), //nolint:errcheck
			"UPDATE helpdesk_tickets SET csat_score=$1, csat_comment=$2, updated_at=NOW() WHERE csat_token=$3",
			b.Score, b.Comment, token)

		hdRecordEvent(r.Context(), db, ticketID, 0, "csat_submitted",
			"", fmt.Sprintf("score=%d", b.Score))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	}
}

// ── Inbound webhooks (no auth) ─────────────────────────────────────────────────

func hdInboundEmail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		r.ParseMultipartForm(10 << 20) //nolint:errcheck

		from := hdFormVal(r, r.MultipartForm, "from")
		to := hdFormVal(r, r.MultipartForm, "to")
		subject := hdFormVal(r, r.MultipartForm, "subject")
		bodyText := hdFormVal(r, r.MultipartForm, "text")
		bodyHTML := hdFormVal(r, r.MultipartForm, "html")
		headersRaw := hdFormVal(r, r.MultipartForm, "headers")

		// Parse email headers
		msgID, inReplyTo, _ := hdParseEmailHeaders(headersRaw)

		// Parse sender email
		senderEmail := hdParseEmail(from)
		senderName := hdParseName(from)

		var ticketID int64
		var ticket map[string]any

		// 1. Try to find ticket from To address (e.g. ticket-TKT-00042@...)
		if ref := hdExtractTicketRef(to); ref != "" {
			if rows, _ := db.PGQuery(ctx, "SELECT * FROM helpdesk_tickets WHERE ticket_ref=$1", ref); len(rows) > 0 {
				ticket = rows[0]
				ticketID = toInt64(ticket["id"])
			}
		}

		// 2. Try to match by In-Reply-To
		if ticketID == 0 && inReplyTo != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT t.* FROM helpdesk_messages m
				JOIN helpdesk_tickets t ON m.ticket_id=t.id
				WHERE m.email_message_id=$1
				ORDER BY m.created_at DESC LIMIT 1`, inReplyTo); len(rows) > 0 {
				ticket = rows[0]
				ticketID = toInt64(ticket["id"])
			}
		}

		// 3. Match by sender email to most recent open ticket
		if ticketID == 0 && senderEmail != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT * FROM helpdesk_tickets
				WHERE customer_email=$1 AND status NOT IN ('resolved','closed')
				ORDER BY created_at DESC LIMIT 1`, senderEmail); len(rows) > 0 {
				ticket = rows[0]
				ticketID = toInt64(ticket["id"])
			}
		}

		// 4. Create new ticket
		if ticketID == 0 {
			// Try to find CIF by email
			customerCIF := ""
			if rows, _ := db.PGQuery(ctx, `SELECT "CIF Number" AS cif FROM "CIF Table" WHERE Email=$1 LIMIT 1`, senderEmail); len(rows) > 0 {
				customerCIF = str(rows[0]["cif"])
			}

			sub := subject
			if sub == "" {
				sub = "Inbound email from " + senderEmail
			}
			newRows, err := db.PGQuery(ctx, `
				INSERT INTO helpdesk_tickets
				    (channel, status, priority, subject, customer_cif, customer_name, customer_email, email_thread_id)
				VALUES ('email','open','normal',$1,$2,$3,$4,$5)
				RETURNING *`,
				sub,
				ptrOrNilStr(customerCIF),
				ptrOrNilStr(senderName),
				senderEmail,
				ptrOrNilStr(msgID))
			if err != nil {
				slog.Error("hdInboundEmail: create ticket", "err", err)
				w.WriteHeader(200) // Always 200 to avoid SendGrid retries
				return
			}
			ticket = newRows[0]
			ticketID = toInt64(ticket["id"])
			hdRecordEvent(ctx, db, ticketID, 0, "created_inbound", "", str(ticket["ticket_ref"]))
		}

		// Insert message
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_name, body_text, body_html, email_message_id, in_reply_to)
			VALUES ($1,'inbound','email',$2,$3,$4,NULLIF($5,''),NULLIF($6,''))`,
			ticketID, senderName, bodyText, bodyHTML, msgID, inReplyTo)

		db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck

		// Notify assigned agent
		if ticket != nil {
			if assignedTo := toInt64(ticket["assigned_to"]); assignedTo > 0 {
				go sendNotification(context.Background(), db, assignedTo,
					"ticket_reply",
					fmt.Sprintf("New reply on %s", str(ticket["ticket_ref"])),
					fmt.Sprintf("%s replied to ticket %s", senderName, str(ticket["ticket_ref"])),
					"helpdesk_tickets", ticketID)
			}
		}

		w.WriteHeader(200)
	}
}

func hdInboundSMS(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var data map[string]any
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			w.WriteHeader(200)
			return
		}

		fromRaw := str(data["from"])
		bodyText := str(data["text"])
		providerMsgID := str(data["messageId"])

		phone := hdNormalizePhone(fromRaw)
		if phone == "" || bodyText == "" {
			w.WriteHeader(200)
			return
		}

		var ticketID int64
		var ticket map[string]any

		// Find most recent open ticket with this phone
		if rows, _ := db.PGQuery(ctx, `
			SELECT * FROM helpdesk_tickets
			WHERE customer_phone=$1 AND status NOT IN ('resolved','closed')
			ORDER BY created_at DESC LIMIT 1`, phone); len(rows) > 0 {
			ticket = rows[0]
			ticketID = toInt64(ticket["id"])
		}

		// Create new ticket if not found
		if ticketID == 0 {
			customerCIF := ""
			// Try MSSQL/Supabase lookup by phone (Accounts table)
			if rows, _ := db.PGQuery(ctx, `SELECT "CIF Number" AS cif FROM "Accounts" WHERE Phone=$1 LIMIT 1`, phone); len(rows) > 0 {
				customerCIF = str(rows[0]["cif"])
			}
			newRows, err := db.PGQuery(ctx, `
				INSERT INTO helpdesk_tickets
				    (channel, status, priority, subject, customer_cif, customer_phone)
				VALUES ('sms','open','normal',$1,$2,$3)
				RETURNING *`,
				"SMS from "+phone,
				ptrOrNilStr(customerCIF),
				phone)
			if err != nil {
				slog.Error("hdInboundSMS: create ticket", "err", err)
				w.WriteHeader(200)
				return
			}
			ticket = newRows[0]
			ticketID = toInt64(ticket["id"])
			hdRecordEvent(ctx, db, ticketID, 0, "created_inbound", "", str(ticket["ticket_ref"]))
		}

		// Insert message
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_name, body_text, provider_message_id)
			VALUES ($1,'inbound','sms',$2,$3,$4)`,
			ticketID, phone, bodyText, providerMsgID)

		db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck

		// Notify assigned agent
		if ticket != nil {
			if assignedTo := toInt64(ticket["assigned_to"]); assignedTo > 0 {
				go sendNotification(context.Background(), db, assignedTo,
					"ticket_reply",
					fmt.Sprintf("New SMS reply on %s", str(ticket["ticket_ref"])),
					fmt.Sprintf("Customer replied via SMS to ticket %s", str(ticket["ticket_ref"])),
					"helpdesk_tickets", ticketID)
			}
		}

		w.WriteHeader(200)
	}
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func hdRecordEvent(ctx context.Context, db *core.DB, ticketID, userID int64, eventType, oldVal, newVal string) {
	var uid any
	if userID > 0 {
		uid = userID
	}
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO helpdesk_events (ticket_id, user_id, event_type, old_value, new_value)
		 VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''))`,
		ticketID, uid, eventType, oldVal, newVal)
}

func hdComputeSLADue(ctx context.Context, db *core.DB, priority string) *time.Time {
	rows, err := db.PGQuery(ctx,
		"SELECT resolution_hours FROM helpdesk_sla_policies WHERE priority=$1 AND is_active=true LIMIT 1",
		priority)
	if err != nil || len(rows) == 0 {
		return nil
	}
	hours := toInt64(rows[0]["resolution_hours"])
	if hours <= 0 {
		return nil
	}
	t := time.Now().Add(time.Duration(hours) * time.Hour)
	return &t
}

func hdCustomerContext(ctx context.Context, db *core.DB, cif string) map[string]any {
	result := map[string]any{
		"cif_number":        nil,
		"full_name":         nil,
		"account_status":    nil,
		"open_tickets":      int64(0),
		"dpd":               nil,
		"loan_balance_kobo": nil,
		"last_payment_date": nil,
	}
	if cif == "" {
		return result
	}
	result["cif_number"] = cif

	// Open tickets count
	if rows, _ := db.PGQuery(ctx, `
		SELECT COUNT(*) AS n FROM helpdesk_tickets
		WHERE customer_cif=$1 AND status NOT IN ('resolved','closed')`, cif); len(rows) > 0 {
		result["open_tickets"] = toInt64(rows[0]["n"])
	}

	// Account info from Supabase snapshot
	if rows, _ := db.PGQuery(ctx, `
		SELECT "First Name", "Last Name", "Account Created Date"
		FROM "Accounts" WHERE "CIF Number"=$1 LIMIT 1`, cif); len(rows) > 0 {
		firstName := str(rows[0]["First Name"])
		lastName := str(rows[0]["Last Name"])
		result["full_name"] = strings.TrimSpace(firstName + " " + lastName)
	}

	// Product/status info
	if rows, _ := db.PGQuery(ctx, `
		SELECT "Account Status", "Product Name"
		FROM "Products" WHERE "CIF Number"=$1 LIMIT 1`, cif); len(rows) > 0 {
		result["account_status"] = rows[0]["Account Status"]
	}

	// Loan info if available
	if rows, _ := db.PGQuery(ctx, `
		SELECT dpd, outstanding_balance_kobo, last_payment_date
		FROM loan_applications
		WHERE customer_cif=$1 AND status NOT IN ('cancelled','rejected')
		ORDER BY created_at DESC LIMIT 1`, cif); len(rows) > 0 {
		result["dpd"] = rows[0]["dpd"]
		result["loan_balance_kobo"] = rows[0]["outstanding_balance_kobo"]
		result["last_payment_date"] = rows[0]["last_payment_date"]
	}

	return result
}

func hdSendTicketEmail(ctx context.Context, db *core.DB, ticket map[string]any, bodyText, bodyHTML, msgID, inReplyTo, agentName string) {
	toEmail := str(ticket["customer_email"])
	if toEmail == "" {
		return
	}
	toName  := str(ticket["customer_name"])
	subject := fmt.Sprintf("Re: %s [%s]", str(ticket["subject"]), str(ticket["ticket_ref"]))

	// Show the agent's name in the FROM display so the customer knows who replied.
	// Replies still go to the shared inbox (care@o3cards.com) via the from address.
	fromName := "O3 Capital Support"
	if agentName != "" {
		fromName = agentName + " (O3 Capital)"
	}

	opts := SendMailOptions{
		To:          []MailAddress{{Email: toEmail, Name: toName}},
		FromName:    fromName,
		Subject:     subject,
		HTMLBody:    bodyHTML,
		TextBody:    bodyText,
		Category:    "helpdesk",
		Kind:        "helpdesk",
		RelatedType: "helpdesk_tickets",
		RelatedID:   toInt64(ticket["id"]),
		CustomArgs: map[string]string{
			"ticket_ref": str(ticket["ticket_ref"]),
			"msg_id":     msgID,
		},
	}
	if bodyHTML == "" {
		opts.HTMLBody = "<p>" + escapeMailHTML(bodyText) + "</p>"
	}
	SendMail(ctx, db, opts)
}

func hdSendCSATEmail(ctx context.Context, db *core.DB, ticket map[string]any) {
	toEmail := str(ticket["customer_email"])
	if toEmail == "" {
		return
	}
	csatToken := str(ticket["csat_token"])
	if csatToken == "" {
		return
	}

	// Get APP_BASE_URL from settings
	base := ""
	if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='app_base_url'`); len(rows) > 0 {
		base = strings.TrimRight(str(rows[0]["value"]), "/")
	}
	if base == "" {
		slog.Warn("hdSendCSATEmail: app_base_url not configured, skipping CSAT email")
		return
	}

	csatURL := fmt.Sprintf("%s/csat/%s", base, csatToken)
	customerName := str(ticket["customer_name"])
	if customerName == "" {
		customerName = "Customer"
	}
	ticketRef := str(ticket["ticket_ref"])
	subject := fmt.Sprintf("How did we do? — %s", ticketRef)
	html := fmt.Sprintf(`<p>Hi %s,</p>
<p>Your support request (<strong>%s</strong>) has been resolved. We'd love to know how we did!</p>
<p>Rate your experience (1–5 stars):</p>
<p>
  <a href="%s?score=1">&#11088; 1</a> &nbsp;
  <a href="%s?score=2">&#11088;&#11088; 2</a> &nbsp;
  <a href="%s?score=3">&#11088;&#11088;&#11088; 3</a> &nbsp;
  <a href="%s?score=4">&#11088;&#11088;&#11088;&#11088; 4</a> &nbsp;
  <a href="%s?score=5">&#11088;&#11088;&#11088;&#11088;&#11088; 5</a>
</p>
<p style="font-size:12px;color:#666">O3C Cards Customer Support</p>`,
		escapeMailHTML(customerName), escapeMailHTML(ticketRef),
		csatURL, csatURL, csatURL, csatURL, csatURL)
	text := fmt.Sprintf("Hi %s,\n\nYour support request (%s) has been resolved.\nRate your experience: %s\n\nO3C Cards Customer Support",
		customerName, ticketRef, csatURL)

	SendMail(ctx, db, SendMailOptions{
		To:          []MailAddress{{Email: toEmail, Name: customerName}},
		Subject:     subject,
		HTMLBody:    html,
		TextBody:    text,
		Category:    "helpdesk",
		Kind:        "csat",
		RelatedType: "helpdesk_tickets",
		RelatedID:   toInt64(ticket["id"]),
	})
}

// ── Parsing / normalization helpers ──────────────────────────────────────────

var ticketRefRE = regexp.MustCompile(`TKT-\d{5}`)

func hdExtractTicketRef(to string) string {
	m := ticketRefRE.FindString(strings.ToUpper(to))
	return m
}

func hdParseEmailHeaders(raw string) (msgID, inReplyTo, references string) {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "message-id:") {
			msgID = strings.TrimSpace(line[len("message-id:"):])
		} else if strings.HasPrefix(lower, "in-reply-to:") {
			inReplyTo = strings.TrimSpace(line[len("in-reply-to:"):])
		} else if strings.HasPrefix(lower, "references:") {
			references = strings.TrimSpace(line[len("references:"):])
		}
	}
	return
}

func hdParseEmail(raw string) string {
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		// Fall back to extracting bare email
		if i := strings.Index(raw, "<"); i >= 0 {
			if j := strings.Index(raw[i:], ">"); j >= 0 {
				return strings.TrimSpace(raw[i+1 : i+j])
			}
		}
		return strings.TrimSpace(raw)
	}
	return strings.ToLower(strings.TrimSpace(addr.Address))
}

func hdParseName(raw string) string {
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(addr.Name)
}

func hdNormalizePhone(raw string) string {
	// Strip non-digits
	re := regexp.MustCompile(`\D`)
	digits := re.ReplaceAllString(raw, "")
	if len(digits) == 0 {
		return ""
	}
	// Nigerian: 080xxxxxxxx → 2348xxxxxxxx
	if len(digits) == 11 && strings.HasPrefix(digits, "0") {
		return "234" + digits[1:]
	}
	return digits
}

func hdFormVal(r *http.Request, form *multipart.Form, key string) string {
	if form != nil {
		if vals, ok := form.Value[key]; ok && len(vals) > 0 {
			return vals[0]
		}
	}
	return r.FormValue(key)
}

func hdNewUUID() string {
	// Use gen_random_uuid equivalent — crypto/rand based
	var buf [16]byte
	rand.Read(buf[:]) //nolint:errcheck
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func ptrOrNil(s *string) any {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	return *s
}

func ptrOrNilStr(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func ptrStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}
