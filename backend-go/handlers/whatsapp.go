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
	"github.com/o3c/workspace/core"
)

const waAPIBase = "https://graph.facebook.com/v19.0"

// waInboundRoute is the path Meta POSTs to, relative to the /api/whatsapp mount in
// main.go. waWebhookPublicPath is the same thing as a customer of this code sees it —
// the URL pasted into Meta's webhook configuration.
//
// They are one definition because the setup screen advertises the URL and the router
// serves it, and the first draft of that screen advertised "/api/whatsapp/webhook",
// which does not exist. Nobody would have found that out until an onboarding session
// failed with Meta reporting a callback URL it could not verify.
const waInboundRoute = "/inbound/whatsapp"
const waWebhookPublicPath = "/api/whatsapp" + waInboundRoute

// waSend is who a message is from and what it is about — the context the transport
// layer cannot infer and the ledger cannot do without.
//
// It is a parameter rather than something derived inside the sender because only the
// caller knows. A care reply and a campaign blast are the same HTTP request to Meta and
// completely different things to a cost report, a consent audit, or a policy review.
type waSend struct {
	// Kind must be one of the values migration 364 permits: care, campaign,
	// notification, ad_reply, other. Note what is absent: there is no 'dunning'.
	// Meta prohibits debt collection on the platform, WhatsApp was removed from the
	// arrears sweep for that reason, and leaving the value out of the vocabulary is how
	// that decision stays made.
	Kind string
	// Purpose is the lawful basis, matching app.party_contact_consent.purpose:
	// 'servicing' or 'marketing'. Blank is recorded as NULL rather than guessed.
	Purpose    string
	PartyID    int64
	TicketID   int64
	CampaignID int64
}

// sendWhatsAppCampaign dispatches a campaign message: uses the template API when
// templateName is set (required for proactive outbound), free-form text otherwise.
func sendWhatsAppCampaign(ctx context.Context, db *core.DB, phone, body, templateName string, meta waSend) (bool, string) {
	if templateName != "" {
		return sendWhatsAppTemplate(ctx, db, phone, templateName, body, meta)
	}
	return sendWhatsApp(ctx, db, phone, body, meta)
}

// waLogMessage records one message in app.whatsapp_messages.
//
// EVERY SEND PASSES THROUGH HERE, including the ones that failed before Meta gave them
// an id. That is deliberate: a send Meta rejected is the single most useful row in the
// table, and the previous arrangement — where only campaign sends kept their wamid —
// dropped it along with everything else.
//
// ON CONFLICT on the wamid, because status webhooks arrive repeatedly for one message
// (sent, then delivered, then read) and each must update the row rather than add one.
// Best-effort: a ledger write must never be the reason a customer did not get their
// message, so an error here is logged and swallowed.
func waLogMessage(ctx context.Context, db *core.DB, m waSend, direction, phone, msgType,
	templateName, body, status, wamid, errText string) {

	nullIf := func(s string) any {
		if strings.TrimSpace(s) == "" {
			return nil
		}
		return s
	}
	nullID := func(id int64) any {
		if id == 0 {
			return nil
		}
		return id
	}
	kind := m.Kind
	if kind == "" {
		kind = "other"
	}

	if _, err := db.PGExec(ctx, `
		INSERT INTO app.whatsapp_messages
			(wamid, direction, phone, party_id, ticket_id, campaign_id,
			 kind, purpose, msg_type, template_name, body, status, status_at, error_text)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13)
		ON CONFLICT (wamid) DO UPDATE
		   SET status = EXCLUDED.status, status_at = NOW(),
		       error_text = COALESCE(EXCLUDED.error_text, app.whatsapp_messages.error_text)`,
		nullIf(wamid), direction, phone, nullID(m.PartyID), nullID(m.TicketID), nullID(m.CampaignID),
		kind, nullIf(m.Purpose), msgType, nullIf(templateName), nullIf(body), status,
		nullIf(errText)); err != nil {
		slog.Error("waLogMessage", "phone", phone, "status", status, "err", err)
	}
}

// waWindowOpen answers whether a free-form (non-template) message may still be sent to
// this number: Meta permits one only within 24 hours of the customer's last inbound
// message, and requires an approved template outside it.
//
// It is worth asking BEFORE sending rather than discovering it from the API error,
// because the failure arrives after the agent has pressed Send and believes the customer
// was answered. A number we have never heard from has no open window, which is the
// correct answer and also why the missing-row case returns false.
func waWindowOpen(ctx context.Context, db *core.DB, phone string) bool {
	rows, err := db.PGQuery(ctx,
		`SELECT window_open FROM app.v_whatsapp_window WHERE phone = $1`, normalizeE164(phone))
	if err != nil || len(rows) == 0 {
		return false
	}
	return toBool(rows[0]["window_open"])
}

// sendWhatsAppTemplate sends via the Meta template messages API.
// bodyText is passed as a single body parameter — the template must have exactly
// one {{1}} body variable, or be a static template (parameters array is omitted).
func sendWhatsAppTemplate(ctx context.Context, db *core.DB, phone, templateName, bodyText string, meta waSend) (ok bool, providerID string) {
	phoneID := resolveCredKey(ctx, db, "WHATSAPP_PHONE_NUMBER_ID")
	token := resolveCredKey(ctx, db, "WHATSAPP_ACCESS_TOKEN")
	phone = normalizeE164(phone)
	if phoneID == "" || token == "" {
		slog.Warn("whatsapp template: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not configured")
		waLogMessage(ctx, db, meta, "out", phone, "template", templateName, bodyText,
			"failed", "", "not_configured")
		return false, "not_configured"
	}
	components := []map[string]any{}
	if bodyText != "" {
		components = append(components, map[string]any{
			"type": "body",
			"parameters": []map[string]any{
				{"type": "text", "text": bodyText},
			},
		})
	}
	payload, _ := json.Marshal(map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                phone,
		"type":              "template",
		"template": map[string]any{
			"name":       templateName,
			"language":   map[string]string{"code": "en"},
			"components": components,
		},
	})
	url := fmt.Sprintf("%s/%s/messages", waAPIBase, phoneID)
	resp, err := httpPost(url, "application/json", "Bearer "+token, payload, 15*time.Second)
	if err != nil {
		slog.Error("whatsapp template: http error", "error", err)
		waLogMessage(ctx, db, meta, "out", phone, "template", templateName, bodyText,
			"failed", "", err.Error())
		return false, err.Error()
	}
	defer resp.Body.Close()
	var d map[string]any
	json.NewDecoder(resp.Body).Decode(&d) //nolint:errcheck
	if resp.StatusCode == 200 {
		id := ""
		if msgs, ok2 := d["messages"].([]any); ok2 && len(msgs) > 0 {
			if m, ok3 := msgs[0].(map[string]any); ok3 {
				id = str(m["id"])
			}
		}
		waLogMessage(ctx, db, meta, "out", phone, "template", templateName, bodyText,
			"accepted", id, "")
		return true, id
	}
	slog.Error("whatsapp template: api error", "status", resp.StatusCode, "body", d)
	detail := fmt.Sprintf("status %d", resp.StatusCode)
	waLogMessage(ctx, db, meta, "out", phone, "template", templateName, bodyText,
		"failed", "", detail+" "+truncateStr(fmt.Sprint(d), 300))
	return false, detail
}

func sendWhatsApp(ctx context.Context, db *core.DB, phone, message string, meta waSend) (ok bool, providerID string) {
	phoneID := resolveCredKey(ctx, db, "WHATSAPP_PHONE_NUMBER_ID")
	token := resolveCredKey(ctx, db, "WHATSAPP_ACCESS_TOKEN")
	phone = normalizeE164(phone)
	if phoneID == "" || token == "" {
		slog.Warn("whatsapp: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not configured")
		waLogMessage(ctx, db, meta, "out", phone, "text", "", message, "failed", "", "not_configured")
		return false, "not_configured"
	}
	payload, _ := json.Marshal(map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                phone,
		"type":              "text",
		"text":              map[string]string{"body": message},
	})
	url := fmt.Sprintf("%s/%s/messages", waAPIBase, phoneID)
	resp, err := httpPost(url, "application/json", "Bearer "+token, payload, 15*time.Second)
	if err != nil {
		slog.Error("whatsapp: http error", "error", err)
		waLogMessage(ctx, db, meta, "out", phone, "text", "", message, "failed", "", err.Error())
		return false, err.Error()
	}
	defer resp.Body.Close()
	var d map[string]any
	json.NewDecoder(resp.Body).Decode(&d) //nolint:errcheck
	if resp.StatusCode == 200 {
		id := ""
		if msgs, ok2 := d["messages"].([]any); ok2 && len(msgs) > 0 {
			if m, ok3 := msgs[0].(map[string]any); ok3 {
				id = str(m["id"])
			}
		}
		waLogMessage(ctx, db, meta, "out", phone, "text", "", message, "accepted", id, "")
		return true, id
	}
	slog.Error("whatsapp: api error", "status", resp.StatusCode, "body", d)
	detail := fmt.Sprintf("status %d", resp.StatusCode)
	waLogMessage(ctx, db, meta, "out", phone, "text", "", message, "failed", "",
		detail+" "+truncateStr(fmt.Sprint(d), 300))
	return false, detail
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
	r.Get(waInboundRoute, waVerify())
	r.Post(waInboundRoute, waInbound(db))
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
			w.WriteHeader(200)
			return // always 200 to Meta
		}
		entries, _ := payload["entry"].([]any)
		for _, entry := range entries {
			e, _ := entry.(map[string]any)
			changes, _ := e["changes"].([]any)
			for _, change := range changes {
				c, _ := change.(map[string]any)
				val, _ := c["value"].(map[string]any)
				msgs, _ := val["messages"].([]any)
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
					m, _ := msg.(map[string]any)
					fromPhone := str(m["from"])
					msgType := str(m["type"])
					wamid := str(m["id"])
					text := ""
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

					// CLICK-TO-WHATSAPP ATTRIBUTION: captured here or never.
					//
					// Meta attaches ctwa_clid to the referral object of the FIRST inbound
					// message after an ad click, and never again. It travels in no URL and
					// appears in no later webhook. If this block does not record it, the ad
					// that produced the customer is unknowable afterwards — which is exactly
					// the implementation gap most advertisers are reported to have, and the
					// reason a Status or Feed ad cannot otherwise be measured past the click.
					clid, headline, refSrc := "", "", ""
					if ref, ok := m["referral"].(map[string]any); ok {
						clid = str(ref["ctwa_clid"])
						headline = str(ref["headline"])
						refSrc = str(ref["source_url"])
					}

					// A message carrying a referral is a reply to an ad, not a support
					// request, and the distinction matters to both the cost report and
					// whoever is judging the campaign.
					kind := "care"
					if clid != "" {
						kind = "ad_reply"
					}
					waLogInbound(db, kind, fromPhone, msgType, text, wamid, clid, headline, refSrc)
					// A STOP is honoured before anything else, and never becomes a support ticket:
					// it is a completed instruction, not a request for help.
					if waHandleOptOut(db, fromPhone, text) {
						continue
					}
					go processWAMessage(db, fromPhone, senderName, text)
				}

				// Delivery status callbacks. These arrive for EVERY outbound message, not
				// only campaign ones — which is why they now update the ledger as well as
				// campaign_contacts: a care reply and a notification had no delivery state
				// at all before, because nothing stored their wamid to match against.
				statuses, _ := val["statuses"].([]any)
				for _, statusEntry := range statuses {
					s, _ := statusEntry.(map[string]any)
					msgID := str(s["id"])
					st := str(s["status"]) // "sent", "delivered", "read", "failed"
					if msgID == "" {
						continue
					}
					errCode, errText := "", ""
					if errs, ok := s["errors"].([]any); ok && len(errs) > 0 {
						if e, ok := errs[0].(map[string]any); ok {
							errCode = str(e["code"])
							errText = str(e["title"])
						}
					}
					go waUpdateLedgerStatus(db, msgID, st, errCode, errText)
					go processWADeliveryStatus(db, msgID, st)
				}
			}
		}
		w.WriteHeader(200)
	}
}

// processWADeliveryStatus updates campaign_contacts when Meta posts a delivery/read receipt.
func processWADeliveryStatus(db *core.DB, providerID, status string) {
	ctx := context.Background()
	switch status {
	case "delivered", "read":
		sub, _ := db.PGQuery(ctx,
			`SELECT campaign_id FROM campaign_contacts WHERE whatsapp_provider_id=$1 LIMIT 1`, providerID)
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE campaign_contacts SET whatsapp_status='delivered', updated_at=NOW()
			 WHERE whatsapp_provider_id=$1 AND whatsapp_status NOT IN ('delivered')`, providerID)
		if len(sub) > 0 {
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE campaigns SET whatsapp_delivered=whatsapp_delivered+1, updated_at=NOW() WHERE id=$1`,
				sub[0]["campaign_id"])
		}
	case "failed":
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE campaign_contacts SET whatsapp_status='failed', updated_at=NOW()
			 WHERE whatsapp_provider_id=$1 AND whatsapp_status NOT IN ('delivered')`, providerID)
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
			Title:     "New WhatsApp Support Ticket",
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

// waLogInbound records a message the customer sent us, with whatever ad referral came
// with it.
//
// Separate from waLogMessage because inbound rows differ in three ways that are easy to
// get wrong if one function tries to do both: there is no lawful-basis purpose (a
// customer writing to us needs none), the status is always 'received', and only inbound
// can carry a ctwa_clid.
//
// Best-effort, like its outbound sibling: a ledger failure must never stop a customer's
// message reaching an agent.
func waLogInbound(db *core.DB, kind, phone, msgType, body, wamid, clid, headline, refSrc string) {
	ctx := context.Background()
	nullIf := func(s string) any {
		if strings.TrimSpace(s) == "" {
			return nil
		}
		return s
	}
	if _, err := db.PGExec(ctx, `
		INSERT INTO app.whatsapp_messages
			(wamid, direction, phone, kind, msg_type, body, status, status_at,
			 ctwa_clid, referral_headline, referral_source)
		VALUES ($1,'in',$2,$3,$4,$5,'received',NOW(),$6,$7,$8)
		ON CONFLICT (wamid) DO NOTHING`,
		nullIf(wamid), normalizeE164(phone), kind, msgType, nullIf(body),
		nullIf(clid), nullIf(headline), nullIf(refSrc)); err != nil {
		slog.Error("waLogInbound", "phone", phone, "err", err)
	}
}

// waUpdateLedgerStatus moves a message along its delivery lifecycle.
//
// WHY THE STATUS ONLY EVER GOES FORWARD. Meta does not guarantee webhook order, and a
// 'sent' callback arriving after 'read' would otherwise walk the status backwards and
// make a delivered message look unsent. The rank below is the lifecycle order, and a
// lower-ranked status is ignored.
//
// This also keeps 'read' distinct from 'delivered', which the campaign-only path did not:
// it treated them as the same case, discarding the one signal that tells a care agent the
// customer actually saw the answer.
func waUpdateLedgerStatus(db *core.DB, wamid, status, errCode, errText string) {
	rank := map[string]int{"accepted": 1, "sent": 2, "delivered": 3, "read": 4, "failed": 5}
	if rank[status] == 0 {
		return // Not a status we model; ignore rather than write something meaningless.
	}
	ctx := context.Background()
	nullIf := func(s string) any {
		if strings.TrimSpace(s) == "" {
			return nil
		}
		return s
	}
	if _, err := db.PGExec(ctx, `
		UPDATE app.whatsapp_messages
		   SET status     = $2,
		       status_at  = NOW(),
		       error_code = COALESCE($3, error_code),
		       error_text = COALESCE($4, error_text)
		 WHERE wamid = $1
		   AND CASE status
		         WHEN 'accepted'  THEN 1
		         WHEN 'sent'      THEN 2
		         WHEN 'delivered' THEN 3
		         WHEN 'read'      THEN 4
		         WHEN 'failed'    THEN 5
		         ELSE 0
		       END < $5`,
		wamid, status, nullIf(errCode), nullIf(errText), rank[status]); err != nil {
		slog.Error("waUpdateLedgerStatus", "wamid", wamid, "status", status, "err", err)
	}
}

// waHandleOptOut honours a customer who replies STOP on WhatsApp. It reports whether the
// message was an opt-out, so the caller can skip the usual ticket handling.
//
// WHY THIS EXISTS. optOutKeyword and the whole CTIA keyword set were already here and
// already wired — to SMS. WhatsApp inbound ignored them completely, so a customer typing
// STOP on WhatsApp got a support ticket opened and kept receiving messages. That is the
// exact fact pattern a Lagos court awarded NGN 1,000,000 over in Olatokun v. Polaris Bank
// (December 2024): the bank kept messaging after an explicit stop request, and the court
// rejected "there was an unsubscribe mechanism" as a defence. An opt-out honoured on one
// channel and ignored on another is not a mechanism, it is a trap.
//
// THIS CHANNEL, NOT ALL CHANNELS, and that is a deliberate reading. The request arrived
// on WhatsApp, so WhatsApp is what it certainly covers. Writing dnc_list instead — which
// app.is_suppressed applies to call, sms AND whatsapp — would also silence the arrears
// reminders and due-date notices the customer may well still want, and nobody asked for
// that. Note the asymmetry is already there and is correct: a STOP sent by SMS writes
// dnc_list and therefore DOES stop WhatsApp too, because a voice/SMS do-not-call is the
// broader instruction.
//
// SUPPRESSION RUNS FIRST, before any ticket work, so it still lands if everything after
// it fails. The order is the point: a suppression we failed to record is a regulatory
// exposure, and a ticket we failed to open is an inconvenience.
func waHandleOptOut(db *core.DB, phone, text string) bool {
	if !optOutKeyword(text) {
		return false
	}
	ctx := context.Background()
	norm := normalizeE164(phone)

	if _, err := db.PGExec(ctx, `
		INSERT INTO app.contact_suppressions (phone, channel, reason, source)
		VALUES ($1, 'whatsapp', 'Customer replied STOP on WhatsApp', 'whatsapp_inbound')`,
		norm); err != nil {
		// Loud, because this is the half that carries the legal weight.
		slog.Error("waHandleOptOut: STOP received but NOT suppressed", "phone", norm, "err", err)
	} else {
		slog.Info("waHandleOptOut: opt-out honoured", "phone", norm)
	}

	// Withdraw any recorded WhatsApp consent as well, so the audience resolver and the
	// suppression list agree. app.party_contact_consent is keyed on party, so this only
	// applies where the number is linked to one — the suppression above is what protects
	// the rest.
	db.PGExec(ctx, `
		UPDATE app.party_contact_consent c
		   SET state = 'withdrawn', recorded_at = NOW()
		  FROM app.parties p
		 WHERE p.party_id = c.party_id
		   AND c.channel = 'whatsapp'
		   AND c.state = 'granted'
		   AND app.norm_phone(p.primary_phone) = app.norm_phone($1)`, norm) //nolint:errcheck

	// Thread it onto an OPEN conversation if there is one, so the agent can see that the
	// customer opted out — but never open a NEW ticket. A STOP is a completed
	// instruction, not a support request, and one ticket per opt-out is exactly the noise
	// that buried the alerting rail before. Same rule as the SMS path.
	if rows, _ := db.PGQuery(ctx, `
		SELECT id FROM helpdesk_tickets
		 WHERE channel = 'whatsapp' AND contact_phone = $1
		   AND status NOT IN ('resolved','closed')
		 ORDER BY created_at DESC LIMIT 1`, norm); len(rows) > 0 {
		tid := toInt64(rows[0]["id"])
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_messages (ticket_id, direction, channel, body_text, sender_name, created_at)
			 VALUES ($1, 'inbound', 'whatsapp', $2, $3, NOW())`,
			tid, text, norm)
	}
	return true
}
