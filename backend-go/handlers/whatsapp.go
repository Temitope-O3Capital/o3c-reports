package handlers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

const waAPIBase = "https://graph.facebook.com/v19.0"

// sendWhatsApp sends a text message via Meta Cloud API.
// phone may be in local Nigerian format; it is normalised to E.164 internally.
func sendWhatsApp(ctx context.Context, db *core.DB, phone, message string) (ok bool, providerID string) {
	phoneID := resolveCredKey(ctx, db, "WHATSAPP_PHONE_NUMBER_ID")
	token   := resolveCredKey(ctx, db, "WHATSAPP_ACCESS_TOKEN")
	if phoneID == "" || token == "" {
		slog.Warn("whatsapp: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not configured")
		return false, "not_configured"
	}
	phone = normalizeE164(phone)
	payload, _ := json.Marshal(map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                phone,
		"type":              "text",
		"text":              map[string]string{"body": message},
	})
	url  := fmt.Sprintf("%s/%s/messages", waAPIBase, phoneID)
	resp, err := httpPost(url, "application/json", "Bearer "+token, payload, 15*time.Second)
	if err != nil {
		slog.Error("whatsapp: http error", "error", err)
		return false, err.Error()
	}
	defer resp.Body.Close()
	var d map[string]any
	json.NewDecoder(resp.Body).Decode(&d) //nolint:errcheck
	if resp.StatusCode == 200 {
		if msgs, ok2 := d["messages"].([]any); ok2 && len(msgs) > 0 {
			if m, ok3 := msgs[0].(map[string]any); ok3 {
				return true, str(m["id"])
			}
		}
		return true, ""
	}
	slog.Error("whatsapp: api error", "status", resp.StatusCode, "body", d)
	return false, fmt.Sprintf("status %d", resp.StatusCode)
}

// normalizeE164 converts a local Nigerian number to E.164 digits (no leading +).
func normalizeE164(p string) string {
	p = strings.TrimSpace(p)
	for _, ch := range []string{" ", "-", "(", ")"} {
		p = strings.ReplaceAll(p, ch, "")
	}
	if strings.HasPrefix(p, "+") {
		return p[1:]
	}
	if strings.HasPrefix(p, "0") {
		return "234" + p[1:]
	}
	return p
}

// truncateStr trims s to at most n bytes, appending "..." if truncated.
func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-3] + "..."
}

// RegisterWhatsAppPublic mounts unauthenticated WhatsApp webhook endpoints.
// Must be called BEFORE the JWT auth middleware group in main.go.
func RegisterWhatsAppPublic(r chi.Router, db *core.DB) {
	r.Get("/inbound/whatsapp", waVerify())
	r.Post("/inbound/whatsapp", waInbound(db))
}

// waVerify handles Meta's one-time GET challenge for webhook verification.
func waVerify() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vToken := os.Getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN")
		if r.URL.Query().Get("hub.mode") == "subscribe" &&
			r.URL.Query().Get("hub.verify_token") == vToken {
			w.Write([]byte(r.URL.Query().Get("hub.challenge"))) //nolint:errcheck
			return
		}
		http.Error(w, "Forbidden", 403)
	}
}

// waInbound receives customer messages from Meta and routes them into
// helpdesk_tickets (channel = 'whatsapp').
func waInbound(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		r.Body = io.NopCloser(bytes.NewBuffer(body))

		// Verify Meta X-Hub-Signature-256 HMAC.
		appSecret := os.Getenv("WHATSAPP_APP_SECRET")
		if appSecret == "" {
			slog.Error("waInbound: WHATSAPP_APP_SECRET not configured — rejecting")
			w.WriteHeader(503)
			return
		}
		sig := r.Header.Get("X-Hub-Signature-256")
		if sig == "" {
			w.WriteHeader(403)
			return
		}
		mac := hmac.New(sha256.New, []byte(appSecret))
		mac.Write(body)
		expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(sig), []byte(expected)) {
			w.WriteHeader(403)
			return
		}

		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			w.WriteHeader(200); return // always 200 to Meta
		}
		entries, _ := payload["entry"].([]any)
		for _, entry := range entries {
			e, _ := entry.(map[string]any)
			changes, _ := e["changes"].([]any)
			for _, change := range changes {
				c, _   := change.(map[string]any)
				val, _ := c["value"].(map[string]any)
				msgs, _     := val["messages"].([]any)
				contacts, _ := val["contacts"].([]any)

				senderName := ""
				if len(contacts) > 0 {
					if ct, ok := contacts[0].(map[string]any); ok {
						if prof, ok := ct["profile"].(map[string]any); ok {
							senderName = str(prof["name"])
						}
					}
				}

				for _, msg := range msgs {
					m, _     := msg.(map[string]any)
					fromPhone := str(m["from"])
					msgType   := str(m["type"])
					text      := ""
					if msgType == "text" {
						if t, ok := m["text"].(map[string]any); ok {
							text = str(t["body"])
						}
					} else {
						text = "[" + msgType + " attachment]"
					}
					if fromPhone == "" || text == "" {
						continue
					}
					go processWAMessage(db, fromPhone, senderName, text)
				}
			}
		}
		w.WriteHeader(200)
	}
}

func processWAMessage(db *core.DB, phone, name, text string) {
	ctx := context.Background()

	// Find an existing open WhatsApp ticket for this phone number
	existing, _ := db.PGQuery(ctx, `
		SELECT id FROM helpdesk_tickets
		WHERE channel='whatsapp' AND contact_phone=$1
		  AND status NOT IN ('resolved','closed')
		ORDER BY created_at DESC LIMIT 1`, phone)

	var ticketID int64
	if len(existing) > 0 {
		if v, ok := existing[0]["id"].(int64); ok {
			ticketID = v
		}
	} else {
		// New conversation — create a ticket (ticket_ref is auto-generated by the column default)
		subject := truncateStr(text, 80)
		rows, err := db.PGQuery(ctx, `
			INSERT INTO helpdesk_tickets
			    (channel, contact_phone, contact_name, subject, status, priority, created_at, updated_at)
			VALUES ('whatsapp', $1, $2, $3, 'open', 'normal', NOW(), NOW())
			RETURNING id`, phone, coalesce(name, phone), subject)
		if err != nil || len(rows) == 0 {
			slog.Error("whatsapp: create ticket failed", "phone", phone, "error", err)
			return
		}
		if v, ok := rows[0]["id"].(int64); ok {
			ticketID = v
		}
		// Alert the customer service team
		NotifyRoles(ctx, db, []string{"call_center_agent", "call_center_head", "cards_ops_head"}, NotifPayload{
			EventType: EvtCRMRequestCreated,
			Title:     "New WhatsApp support ticket",
			Body:      fmt.Sprintf("From %s: %s", coalesce(name, phone), truncateStr(text, 100)),
			ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
			EntityRef: fmt.Sprintf("ticket:%d", ticketID),
		})
	}

	if ticketID == 0 {
		return
	}

	// Append message to ticket
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO helpdesk_messages (ticket_id, direction, channel, body_text, sender_name, created_at)
		 VALUES ($1,'inbound','whatsapp',$2,$3,NOW())`,
		ticketID, text, coalesce(name, phone))

	db.PGExec(ctx, //nolint:errcheck
		`UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1`, ticketID)
}
