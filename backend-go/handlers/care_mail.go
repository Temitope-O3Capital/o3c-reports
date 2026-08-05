package handlers

// Care mailbox ingestion — poll care@o3cards.com via Microsoft Graph (app-only)
// and turn new mail into Care tickets (channel='email'), reusing the same
// create/thread logic the SendGrid inbound webhook uses. Dormant (no-op) until
// Microsoft Graph is configured (MS_GRAPH_* creds) so it never errors on a
// fresh install.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/o3c/reports/core"
)

var careHTTP = &http.Client{Timeout: 30 * time.Second}

// ── Graph message shapes ──────────────────────────────────────────────────────

type graphMailAddress struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}
type graphRecipient struct {
	EmailAddress graphMailAddress `json:"emailAddress"`
}
type graphHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type graphMessage struct {
	ID           string           `json:"id"`
	Subject      string           `json:"subject"`
	From         graphRecipient   `json:"from"`
	ToRecipients []graphRecipient `json:"toRecipients"`
	BodyPreview  string           `json:"bodyPreview"`
	Body         struct {
		ContentType string `json:"contentType"`
		Content     string `json:"content"`
	} `json:"body"`
	InternetMessageId      string        `json:"internetMessageId"`
	InternetMessageHeaders []graphHeader `json:"internetMessageHeaders"`
}

// ── Poller ────────────────────────────────────────────────────────────────────

func careMailbox(ctx context.Context, db *core.DB) string {
	if v := resolveCredKey(ctx, db, "CARE_MAILBOX"); v != "" {
		return v
	}
	return "care@o3cards.com"
}

// StartCareMailPoller runs a background loop that ingests new care@ mail every
// minute. It is a no-op while Microsoft Graph is unconfigured.
func StartCareMailPoller(db *core.DB) {
	go func() {
		time.Sleep(90 * time.Second) // let startup settle
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		run := func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if !graphConfigured(ctx, db) {
				return // dormant until IT connects Microsoft Graph
			}
			n, err := pollCareMailbox(ctx, db)
			if err != nil {
				slog.Warn("care mail poller", "err", err)
			} else if n > 0 {
				slog.Info("care mail poller: ingested", "count", n)
			}
		}
		run()
		for range ticker.C {
			run()
		}
	}()
}

// pollCareMailbox fetches unread messages from the care@ inbox, ingests each as a
// ticket, and marks it read so it is not reprocessed. Returns the count ingested.
func pollCareMailbox(ctx context.Context, db *core.DB) (int, error) {
	token, err := graphToken(ctx, db)
	if err != nil {
		return 0, err
	}
	mbox := careMailbox(ctx, db)

	q := url.Values{}
	q.Set("$filter", "isRead eq false")
	q.Set("$orderby", "receivedDateTime asc")
	q.Set("$top", "50")
	q.Set("$select", "id,subject,from,toRecipients,bodyPreview,body,internetMessageId,internetMessageHeaders")
	endpoint := "https://graph.microsoft.com/v1.0/users/" + url.PathEscape(mbox) + "/mailFolders/inbox/messages?" + q.Encode()

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := careHTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		snippet := string(body)
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		return 0, fmt.Errorf("graph list HTTP %d: %s", resp.StatusCode, snippet)
	}
	var out struct {
		Value []graphMessage `json:"value"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return 0, err
	}

	count := 0
	for _, m := range out.Value {
		senderEmail := strings.TrimSpace(m.From.EmailAddress.Address)
		senderName := strings.TrimSpace(m.From.EmailAddress.Name)

		toParts := make([]string, 0, len(m.ToRecipients))
		for _, t := range m.ToRecipients {
			if a := strings.TrimSpace(t.EmailAddress.Address); a != "" {
				toParts = append(toParts, a)
			}
		}
		toAddr := strings.Join(toParts, ", ")

		bodyHTML := ""
		bodyText := m.BodyPreview
		if strings.EqualFold(m.Body.ContentType, "html") {
			bodyHTML = m.Body.Content
		} else if m.Body.Content != "" {
			bodyText = m.Body.Content
		}

		inReplyTo := ""
		for _, h := range m.InternetMessageHeaders {
			if strings.EqualFold(h.Name, "In-Reply-To") {
				inReplyTo = strings.TrimSpace(h.Value)
				break
			}
		}

		if _, err := ingestInboundEmail(ctx, db, senderEmail, senderName, toAddr,
			m.Subject, bodyText, bodyHTML, m.InternetMessageId, inReplyTo); err != nil {
			slog.Warn("care mail poller: ingest", "msg_id", m.InternetMessageId, "err", err)
			continue // leave unread so it retries next cycle
		}
		markGraphMessageRead(ctx, token, mbox, m.ID)
		count++
	}
	return count, nil
}

func markGraphMessageRead(ctx context.Context, token, mbox, msgID string) {
	u := "https://graph.microsoft.com/v1.0/users/" + url.PathEscape(mbox) + "/messages/" + url.PathEscape(msgID)
	req, _ := http.NewRequestWithContext(ctx, "PATCH", u, strings.NewReader(`{"isRead":true}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if resp, err := careHTTP.Do(req); err == nil {
		resp.Body.Close()
	}
}

// ── Shared inbound-email ingestion ────────────────────────────────────────────

// ingestInboundEmail creates or threads an inbound email into a helpdesk ticket
// (channel='email') and records the inbound message. Idempotent on the email
// Message-ID. Used by the care@ Graph poller; the SendGrid webhook uses the same
// matching rules inline.
func ingestInboundEmail(ctx context.Context, db *core.DB, senderEmail, senderName, toAddr,
	subject, bodyText, bodyHTML, msgID, inReplyTo string) (int64, error) {

	// Idempotency: if this exact message was already ingested, do nothing.
	if msgID != "" {
		if rows, _ := db.PGQuery(ctx,
			`SELECT ticket_id FROM helpdesk_messages WHERE email_message_id=$1 LIMIT 1`, msgID); len(rows) > 0 {
			return toInt64(rows[0]["ticket_id"]), nil
		}
	}

	var ticketID int64
	var ticket map[string]any

	// 1. Ticket ref embedded in the To address (e.g. ticket-TKT-00042@…)
	if ref := hdExtractTicketRef(toAddr); ref != "" {
		if rows, _ := db.PGQuery(ctx, "SELECT * FROM helpdesk_tickets WHERE ticket_ref=$1", ref); len(rows) > 0 {
			ticket = rows[0]
			ticketID = toInt64(ticket["id"])
		}
	}
	// 2. In-Reply-To → the message it answers
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
	// 3. Sender's most recent open ticket
	if ticketID == 0 && senderEmail != "" {
		if rows, _ := db.PGQuery(ctx, `
			SELECT * FROM helpdesk_tickets
			WHERE customer_email=$1 AND status NOT IN ('resolved','closed')
			ORDER BY created_at DESC LIMIT 1`, senderEmail); len(rows) > 0 {
			ticket = rows[0]
			ticketID = toInt64(ticket["id"])
		}
	}
	// 4. New ticket
	if ticketID == 0 {
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
			sub, ptrOrNilStr(customerCIF), ptrOrNilStr(senderName), senderEmail, ptrOrNilStr(msgID))
		if err != nil {
			return 0, err
		}
		ticket = newRows[0]
		ticketID = toInt64(ticket["id"])
		hdRecordEvent(ctx, db, ticketID, 0, "created_inbound", "", str(ticket["ticket_ref"]))
	}

	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO helpdesk_messages
		    (ticket_id, direction, channel, author_name, body_text, body_html, email_message_id, in_reply_to)
		VALUES ($1,'inbound','email',$2,$3,$4,NULLIF($5,''),NULLIF($6,''))`,
		ticketID, senderName, bodyText, bodyHTML, msgID, inReplyTo)
	db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck

	if ticket != nil {
		if assignedTo := toInt64(ticket["assigned_to"]); assignedTo > 0 {
			go sendNotification(context.Background(), db, assignedTo, "ticket_reply",
				fmt.Sprintf("New reply on %s", str(ticket["ticket_ref"])),
				fmt.Sprintf("%s replied to ticket %s", senderName, str(ticket["ticket_ref"])),
				"helpdesk_tickets", ticketID)
		}
	}
	return ticketID, nil
}
