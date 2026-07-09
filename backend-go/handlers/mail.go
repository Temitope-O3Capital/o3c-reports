package handlers

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

type MailAddress struct {
	Email string
	Name  string
}

type MailAttachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Content     string `json:"content"`
	Disposition string `json:"disposition"`
	ContentID   string `json:"content_id"`
}

type SendMailOptions struct {
	To                 []MailAddress
	CC                 []MailAddress
	BCC                []MailAddress
	FromEmail          string
	FromName           string
	ReplyToEmail       string
	ReplyToName        string
	Subject            string
	HTMLBody           string
	TextBody           string
	Category           string
	Kind               string
	RelatedType        string
	RelatedID          int64
	CreatedBy          int64
	SendCopyToSender   bool
	SenderCopyEmail    string
	SenderCopyName     string
	SendViaUserMailbox bool
	Attachments        []MailAttachment
	CustomArgs         map[string]string
	TrackOpensAndLinks bool
}

type SendMailResult struct {
	OK         bool
	ProviderID string
	MailID     int64
	Error      string
}

var mailSchemaMu sync.Mutex
var mailSchemaReady bool

// graphToken cache — avoids a round-trip to the Microsoft identity endpoint on every send.
var (
	cachedGraphToken    string
	cachedGraphTokenExp time.Time
	graphTokenMu        sync.Mutex
)
var inboundReplyAddressRE = regexp.MustCompile(`(?i)\breply\+([0-9]+)@`)

func RegisterMail(r chi.Router, db *core.DB) {
	if err := ensureMailSchema(context.Background(), db); err != nil {
		slog.Warn("Mail schema setup failed", "err", err)
	}
	access := core.RequirePages("campaigns", "crm_contacts", "customer_service", "mail")
	admin := core.RequirePages("admin_api_keys")
	r.With(access).Post("/send", sendSingleMail(db))
	r.With(access).Get("/messages", listMailMessages(db))
	r.With(access).Get("/messages/{id}", getMailMessage(db))
	r.With(access).Get("/messages/{id}/replies", listMessageReplies(db))
	r.With(access).Post("/messages/{id}/reply", replyToMessage(db))
	r.With(access).Get("/messages/{id}/events", listMessageEvents(db))
	r.With(access).Put("/inbox/{id}/read", markInboundRead(db))
	r.With(access).Get("/inbox", listInboundMail(db))
	r.With(admin).Get("/metrics", mailMetrics(db))
	r.With(admin).Get("/campaign-health", mailCampaignHealth(db))
	r.With(admin).Put("/campaign-settings", mailCampaignSettingsUpdate(db))
	r.With(admin).Get("/deliverability", mailDeliverability(db))
	r.With(admin).Post("/test", mailSendTest(db))
	r.With(admin).Get("/suppressions", mailListSuppressions(db))
	r.With(admin).Post("/suppressions/import", mailImportSuppressions(db))
	r.With(admin).Get("/suppressions/export", mailExportSuppressions(db))
	r.With(admin).Delete("/suppressions/{email}", mailRemoveSuppression(db))
	// Drafts
	r.With(access).Get("/drafts", mailListDrafts(db))
	r.With(access).Post("/drafts", mailSaveDraft(db))
	r.With(access).Get("/drafts/{id}", mailGetDraft(db))
	r.With(access).Delete("/drafts/{id}", mailDeleteDraft(db))
	// Signature
	r.With(access).Get("/signature", mailGetSignature(db))
	r.With(access).Put("/signature", mailSaveSignature(db))
	// Attachments
	r.With(access).Post("/attachments/upload", mailUploadAttachment(db))
}

func RegisterMailPublic(r chi.Router, db *core.DB) {
	if err := ensureMailSchema(context.Background(), db); err != nil {
		slog.Warn("Mail schema setup failed", "err", err)
	}
	r.Get("/unsubscribe", mailUnsubscribe(db))
	r.Post("/unsubscribe", mailUnsubscribe(db))
	r.Post("/inbound", mailInboundParse(db))
}

// verifyInboundWebhookHMAC verifies HMAC-SHA256 signature on SendGrid Inbound Parse webhooks.
// key is SENDGRID_WEBHOOK_VERIFICATION_KEY; message = timestamp || body.
func verifyInboundWebhookHMAC(key, timestamp, signatureB64 string, body []byte) bool {
	if timestamp == "" || signatureB64 == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(timestamp))
	mac.Write(body)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signatureB64))
}

// mailInboundParse handles SendGrid Inbound Parse webhook (multipart/form-data).
// Configure SendGrid: Settings → Inbound Parse → add your domain's MX → webhook URL = /api/mail/inbound
func mailInboundParse(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Read raw body for signature verification before ParseMultipartForm consumes it.
		rawBody, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(rawBody))

		verifyKey := os.Getenv("SENDGRID_WEBHOOK_VERIFICATION_KEY")
		if verifyKey != "" {
			timestamp := r.Header.Get("X-Twilio-Email-Event-Webhook-Timestamp")
			signature := r.Header.Get("X-Twilio-Email-Event-Webhook-Signature")
			if !verifyInboundWebhookHMAC(verifyKey, timestamp, signature, rawBody) {
				w.WriteHeader(401)
				return
			}
		}

		if err := r.ParseMultipartForm(10 << 20); err != nil {
			w.WriteHeader(200) // always 200 to SendGrid or it retries
			return
		}
		fromRaw := r.FormValue("from")
		fromName, fromEmail := parseMailAddress(fromRaw)
		subject := r.FormValue("subject")
		bodyText := r.FormValue("text")
		bodyHTML := r.FormValue("html")
		to := r.FormValue("to")
		headers := r.FormValue("headers")
		messageID := firstNonEmpty(r.FormValue("Message-ID"), r.FormValue("message-id"))
		inReplyTo := firstNonEmpty(r.FormValue("In-Reply-To"), r.FormValue("in-reply-to"))
		relatedMailID := extractInboundReplyMailID(to)
		if fromEmail == "" {
			w.WriteHeader(200)
			return
		}
		if err := ensureMailSchema(r.Context(), db); err == nil {
			db.PGExec(r.Context(), `
				INSERT INTO inbound_mail
					(mail_message_id, from_email, from_name, to_email, subject, body_text, body_html, message_id, in_reply_to, raw_headers)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				nullableID(relatedMailID), fromEmail, fromName, to, subject, bodyText, bodyHTML, ns(messageID), ns(inReplyTo), ns(headers))
		}
		w.WriteHeader(200)
	}
}

func listInboundMail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		user := core.UserFromCtx(r.Context())
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 100000)
		rows, err := db.PGQuery(r.Context(), `
			SELECT im.id, im.mail_message_id, im.from_email, im.from_name, im.to_email, im.subject,
			       im.body_text, im.body_html, im.is_read, im.received_at,
			       mm.subject AS original_subject, mm.from_email AS original_from_email
			FROM inbound_mail im
			LEFT JOIN mail_messages mm ON mm.id = im.mail_message_id
			WHERE mm.id IS NULL
			   OR mm.created_by=$1
			   OR mm.recipients @> jsonb_build_array($2::text)
			ORDER BY im.received_at DESC
			LIMIT $3 OFFSET $4`, user.ID, user.Sub, limit, offset)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func sendSingleMail(db *core.DB) http.HandlerFunc {
	type body struct {
		To               []MailAddress    `json:"to"`
		CC               []MailAddress    `json:"cc"`
		BCC              []MailAddress    `json:"bcc"`
		Subject          string           `json:"subject"`
		HTMLBody         string           `json:"html_body"`
		TextBody         string           `json:"text_body"`
		FromAddress      string           `json:"from_address"`
		FromName         string           `json:"from_name"`
		SendAt           string           `json:"send_at"`
		Attachments      []MailAttachment `json:"attachments"`
		SendCopyToSender *bool            `json:"send_copy_to_sender"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.To) == 0 || strings.TrimSpace(b.Subject) == "" {
			respondErr(w, 422, "to and subject are required")
			return
		}
		if strings.TrimSpace(b.HTMLBody) == "" && strings.TrimSpace(b.TextBody) == "" {
			respondErr(w, 422, "html_body or text_body is required")
			return
		}
		if err := validateMailAttachments(b.Attachments); err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		user := core.UserFromCtx(r.Context())
		copyToSender := true
		if b.SendCopyToSender != nil {
			copyToSender = *b.SendCopyToSender
		}
		fromEmail := strings.TrimSpace(b.FromAddress)
		fromName := strings.TrimSpace(b.FromName)
		res := SendMail(r.Context(), db, SendMailOptions{
			To:                 b.To,
			CC:                 b.CC,
			BCC:                b.BCC,
			Subject:            b.Subject,
			HTMLBody:           b.HTMLBody,
			TextBody:           b.TextBody,
			FromEmail:          fromEmail,
			FromName:           fromName,
			ReplyToEmail:       user.Sub,
			ReplyToName:        user.FullName,
			Category:           "single",
			Kind:               "single",
			CreatedBy:          user.ID,
			SendCopyToSender:   copyToSender,
			SenderCopyEmail:    user.Sub,
			SenderCopyName:     user.FullName,
			SendViaUserMailbox: true,
			Attachments:        b.Attachments,
		})
		if !res.OK {
			slog.Warn("Single mail send failed", "user_id", user.ID, "error", res.Error)
			respondErr(w, 502, res.Error)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(res) //nolint:errcheck
	}
}

func listMailMessages(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		user := core.UserFromCtx(r.Context())
		limit := qint(r, "limit", 100, 1, 500)
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, kind, related_type, related_id, subject, from_email, from_name,
			       recipients, status, provider_message_id, queued_at, delivered_at,
			       opened_at, clicked_at, bounced_at, last_error, created_at, updated_at
			FROM mail_messages
			WHERE created_by=$1 OR recipients @> jsonb_build_array($2::text)
			ORDER BY created_at DESC
			LIMIT $3`, user.ID, user.Sub, limit)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func mailMetrics(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                       AS total_sent,
				COUNT(*) FILTER (WHERE status='delivered')     AS total_delivered,
				COUNT(*) FILTER (WHERE status='opened')        AS total_opened,
				COUNT(*) FILTER (WHERE status='clicked')       AS total_clicked,
				COUNT(*) FILTER (WHERE status='bounced')       AS total_bounced,
				COUNT(*) FILTER (WHERE status='spam_report')   AS total_spam
			FROM mail_messages`)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Query failed")
			return
		}
		row := rows[0]
		totalSent := toInt64(row["total_sent"])
		totalDelivered := toInt64(row["total_delivered"])
		totalOpened := toInt64(row["total_opened"])
		totalBounced := toInt64(row["total_bounced"])
		respond(w, map[string]any{
			"total_sent":      totalSent,
			"total_delivered": totalDelivered,
			"total_opened":    totalOpened,
			"total_clicked":   toInt64(row["total_clicked"]),
			"total_bounced":   totalBounced,
			"total_spam":      toInt64(row["total_spam"]),
			"delivery_rate":   rate(totalDelivered, totalSent),
			"open_rate":       rate(totalOpened, totalDelivered),
			"bounce_rate":     rate(totalBounced, totalSent),
		}, "postgres")
	}
}

func mailCampaignHealth(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		settings := map[string]int{
			"campaign_send_delay_ms":                  intSetting(r.Context(), db, "campaign_send_delay_ms", 250),
			"campaign_daily_email_limit":              intSetting(r.Context(), db, "campaign_daily_email_limit", 5000),
			"campaign_per_campaign_daily_email_limit": intSetting(r.Context(), db, "campaign_per_campaign_daily_email_limit", 5000),
			"campaign_warmup_daily_email_limit":       intSetting(r.Context(), db, "campaign_warmup_daily_email_limit", 1000),
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*) FILTER (WHERE kind='campaign') AS total,
			  COUNT(*) FILTER (WHERE kind='campaign' AND status IN ('queued','processed','sending','sent','delivered','opened','clicked')) AS attempted,
			  COUNT(*) FILTER (WHERE kind='campaign' AND delivered_at IS NOT NULL) AS delivered,
			  COUNT(*) FILTER (WHERE kind='campaign' AND opened_at IS NOT NULL) AS opened,
			  COUNT(*) FILTER (WHERE kind='campaign' AND clicked_at IS NOT NULL) AS clicked,
			  COUNT(*) FILTER (WHERE kind='campaign' AND status IN ('bounced','dropped','failed')) AS bounced,
			  COUNT(*) FILTER (WHERE kind='campaign' AND status='spam_report') AS spam_reports,
			  COUNT(*) FILTER (WHERE kind='campaign' AND status='unsubscribed') AS unsubscribed
			FROM mail_messages
			WHERE created_at >= NOW() - INTERVAL '30 days'`)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Query failed")
			return
		}
		s := rows[0]
		total := toInt64(s["total"])
		delivered := toInt64(s["delivered"])
		bounced := toInt64(s["bounced"])
		spam := toInt64(s["spam_reports"])
		unsub := toInt64(s["unsubscribed"])
		activeSuppressions := int64(0)
		if sr, _ := db.PGQuery(r.Context(), `SELECT COUNT(*) AS n FROM mail_suppressions WHERE is_active=true`); len(sr) > 0 {
			activeSuppressions = toInt64(sr[0]["n"])
		}
		lastWebhookAt := ""
		lastWebhookEvent := ""
		if wr, _ := db.PGQuery(r.Context(), `SELECT event_type, occurred_at FROM mail_events ORDER BY occurred_at DESC LIMIT 1`); len(wr) > 0 {
			lastWebhookEvent = str(wr[0]["event_type"])
			lastWebhookAt = timeString(wr[0]["occurred_at"])
		}
		respond(w, map[string]any{
			"window_days":           30,
			"settings":              settings,
			"total":                 total,
			"attempted":             toInt64(s["attempted"]),
			"delivered":             delivered,
			"opened":                toInt64(s["opened"]),
			"clicked":               toInt64(s["clicked"]),
			"bounced":               bounced,
			"spam_reports":          spam,
			"unsubscribed":          unsub,
			"active_suppressions":   activeSuppressions,
			"last_webhook_at":       lastWebhookAt,
			"last_webhook_event":    lastWebhookEvent,
			"webhook_signed":        resolveSendGridWebhookPublicKey(r.Context(), db) != "",
			"warmup_enabled":        boolSetting(r.Context(), db, "campaign_warmup_mode_enabled", true),
			"effective_daily_limit": effectiveCampaignDailyLimit(r.Context(), db),
			"delivery_rate":         rate(delivered, total),
			"open_rate":             rate(toInt64(s["opened"]), delivered),
			"click_rate":            rate(toInt64(s["clicked"]), delivered),
			"bounce_rate":           rate(bounced, total),
			"spam_rate":             rate(spam, total),
			"unsubscribe_rate":      rate(unsub, total),
		}, "postgres")
	}
}

func mailCampaignSettingsUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		DailyEmailLimit            int  `json:"campaign_daily_email_limit"`
		PerCampaignDailyEmailLimit int  `json:"campaign_per_campaign_daily_email_limit"`
		WarmupDailyEmailLimit      int  `json:"campaign_warmup_daily_email_limit"`
		WarmupModeEnabled          bool `json:"campaign_warmup_mode_enabled"`
		SendDelayMS                int  `json:"campaign_send_delay_ms"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.DailyEmailLimit < 0 || b.DailyEmailLimit > 100000 {
			respondErr(w, 422, "campaign_daily_email_limit must be between 0 and 100000")
			return
		}
		if b.SendDelayMS < 50 || b.SendDelayMS > 60000 {
			respondErr(w, 422, "campaign_send_delay_ms must be between 50 and 60000")
			return
		}
		if b.PerCampaignDailyEmailLimit < 0 || b.PerCampaignDailyEmailLimit > 100000 {
			respondErr(w, 422, "campaign_per_campaign_daily_email_limit must be between 0 and 100000")
			return
		}
		if b.WarmupDailyEmailLimit < 0 || b.WarmupDailyEmailLimit > 100000 {
			respondErr(w, 422, "campaign_warmup_daily_email_limit must be between 0 and 100000")
			return
		}
		user := core.UserFromCtx(r.Context())
		userID := int64(0)
		if user != nil {
			userID = user.ID
		}
		for key, val := range map[string]string{
			"campaign_daily_email_limit":              strconv.Itoa(b.DailyEmailLimit),
			"campaign_per_campaign_daily_email_limit": strconv.Itoa(b.PerCampaignDailyEmailLimit),
			"campaign_warmup_daily_email_limit":       strconv.Itoa(b.WarmupDailyEmailLimit),
			"campaign_warmup_mode_enabled":            strconv.FormatBool(b.WarmupModeEnabled),
			"campaign_send_delay_ms":                  strconv.Itoa(b.SendDelayMS),
		} {
			if _, err := db.PGExec(r.Context(), `
				INSERT INTO settings (key, value, updated_by, updated_at)
				VALUES ($1,$2,$3,NOW())
				ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
				key, val, nullableID(userID)); err != nil {
				respondErr(w, 500, "Update failed")
				return
			}
		}
		respond(w, map[string]any{"ok": true}, "postgres")
	}
}

func rate(part, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return float64(part) * 100 / float64(total)
}

func looksLikeEmail(email string) bool {
	email = strings.TrimSpace(email)
	if email == "" || strings.ContainsAny(email, " \t\n\r") {
		return false
	}
	parts := strings.Split(email, "@")
	return len(parts) == 2 && parts[0] != "" && strings.Contains(parts[1], ".")
}

func timeString(v any) string {
	switch t := v.(type) {
	case time.Time:
		return t.Format(time.RFC3339)
	case string:
		return t
	default:
		return ""
	}
}

func mailSendTest(db *core.DB) http.HandlerFunc {
	type body struct {
		To string `json:"to"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || strings.TrimSpace(b.To) == "" {
			respondErr(w, 400, "to (email) is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		res := SendMail(r.Context(), db, SendMailOptions{
			To:      []MailAddress{{Email: b.To, Name: b.To}},
			Subject: "O3C Mail Health — Test Email",
			HTMLBody: `<p>This is a test email sent from the <strong>O3 Capital Mail Health</strong> dashboard.</p>
<p>If you received this, your SendGrid integration is working correctly.</p>`,
			TextBody:     "This is a test email from O3 Capital Mail Health. If you received this, your SendGrid integration is working.",
			CreatedBy:    user.ID,
			ReplyToEmail: user.Sub,
		})
		if res.Error != "" {
			respondErr(w, 500, res.Error)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "provider_id": res.ProviderID, "mail_id": res.MailID}) //nolint:errcheck
	}
}

func mailListSuppressions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT email, reason, source, is_active, updated_at
			FROM mail_suppressions
			ORDER BY updated_at DESC
			LIMIT 500`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func mailImportSuppressions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			respondErr(w, 400, "Cannot parse upload")
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "file field required")
			return
		}
		defer file.Close()
		reader := csv.NewReader(file)
		reader.FieldsPerRecord = -1
		records, err := reader.ReadAll()
		if err != nil {
			respondErr(w, 422, "Invalid CSV")
			return
		}
		inserted := 0
		for i, rec := range records {
			if len(rec) == 0 {
				continue
			}
			email := strings.TrimSpace(rec[0])
			if i == 0 && strings.Contains(strings.ToLower(email), "email") {
				continue
			}
			if !looksLikeEmail(email) {
				continue
			}
			reason := "manual_import"
			if len(rec) > 1 && strings.TrimSpace(rec[1]) != "" {
				reason = strings.TrimSpace(rec[1])
			}
			addSuppression(r.Context(), db, email, reason, "import")
			inserted++
		}
		respond(w, map[string]any{"inserted": inserted}, "postgres")
	}
}

func mailExportSuppressions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT email, reason, source, is_active, updated_at
			FROM mail_suppressions
			ORDER BY updated_at DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="mail-suppressions.csv"`)
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"email", "reason", "source", "is_active", "updated_at"})
		for _, row := range rows {
			_ = cw.Write([]string{str(row["email"]), str(row["reason"]), str(row["source"]), fmt.Sprintf("%v", row["is_active"]), timeString(row["updated_at"])})
		}
		cw.Flush()
	}
}

func mailRemoveSuppression(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		email := chi.URLParam(r, "email")
		if email == "" {
			respondErr(w, 400, "email param required")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE mail_suppressions SET is_active=false, updated_at=NOW() WHERE email=$1`, email); err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func mailDeliverability(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed: "+err.Error())
			return
		}
		domain := mailDomain(r.Context(), db)
		checks := []map[string]any{}
		add := func(key, label string, ok bool, detail string) {
			checks = append(checks, map[string]any{"key": key, "label": label, "ok": ok, "detail": detail})
		}

		add("from_email", "SendGrid from email", sendgridFromEmail != "", valueOr(sendgridFromEmail, "SENDGRID_FROM_EMAIL is not set"))
		add("sendgrid_key", "SendGrid API key", resolveCredKey(r.Context(), db, "SENDGRID_API_KEY") != "", "Required for campaigns, reset emails, and notifications")
		add("signed_webhook", "Signed SendGrid webhook", resolveSendGridWebhookPublicKey(r.Context(), db) != "", "Set SENDGRID_WEBHOOK_PUBLIC_KEY after enabling signed Event Webhook")
		add("graph", "Microsoft Graph mailbox sending", graphConfigured(r.Context(), db), "Required for real staff Sent Items")

		if domain == "" {
			add("domain", "Mail domain", false, "Set mail_domain in platform settings or SENDGRID_FROM_EMAIL")
		} else {
			spfOK, spfDetail := checkSPF(domain)
			dmarcOK, dmarcDetail := checkDMARC(domain)
			dkimOK, dkimDetail := checkDKIM(domain)
			add("spf", "SPF includes SendGrid", spfOK, spfDetail)
			add("dmarc", "DMARC record exists", dmarcOK, dmarcDetail)
			add("dkim", "DKIM/domain authentication", dkimOK, dkimDetail)
		}

		suppressed := int64(0)
		if rows, _ := db.PGQuery(r.Context(), `SELECT COUNT(*) AS n FROM mail_suppressions WHERE is_active=true`); len(rows) > 0 {
			suppressed = toInt64(rows[0]["n"])
		}
		add("suppressions", "Suppression list active", true, fmt.Sprintf("%d active suppressed recipient(s)", suppressed))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"domain": domain, "checks": checks}) //nolint:errcheck
	}
}

func mailUnsubscribe(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			http.Error(w, "Mail storage setup failed", http.StatusInternalServerError)
			return
		}

		var mailID int64
		var email string

		if token := r.URL.Query().Get("token"); token != "" {
			// Preferred path: HMAC-signed token encodes both mail_id and recipient email.
			secretKey := os.Getenv("SECRET_KEY")
			if secretKey == "" {
				http.Error(w, "Invalid unsubscribe link", http.StatusBadRequest)
				return
			}
			var ok bool
			mailID, email, ok = parseUnsubToken(token, secretKey)
			if !ok || mailID <= 0 || email == "" {
				http.Error(w, "Invalid or tampered unsubscribe link", http.StatusBadRequest)
				return
			}
		} else {
			// Legacy path: plain mail_id (used when SECRET_KEY was not set at send time).
			mailID, _ = strconv.ParseInt(r.URL.Query().Get("mail_id"), 10, 64)
			if mailID <= 0 {
				http.Error(w, "Invalid unsubscribe link", http.StatusBadRequest)
				return
			}
		}

		rows, _ := db.PGQuery(r.Context(), `SELECT id, kind, recipients, provider_message_id FROM mail_messages WHERE id=$1`, mailID)
		if len(rows) == 0 {
			http.Error(w, "Message not found", http.StatusNotFound)
			return
		}
		if email == "" {
			email = firstRecipientEmail(rows[0]["recipients"])
		}
		if email == "" {
			http.Error(w, "Recipient not found", http.StatusNotFound)
			return
		}
		addSuppression(r.Context(), db, email, "unsubscribed", "unsubscribe_link")
		_, _ = db.PGExec(r.Context(), `
			UPDATE mail_messages
			SET status='unsubscribed', bounced_at=COALESCE(bounced_at,NOW()), updated_at=NOW()
			WHERE id=$1 AND kind='campaign'`, mailID)
		if str(rows[0]["kind"]) == "campaign" {
			recordCampaignUnsubscribeFromMail(r.Context(), db, rows[0], email)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head><body style="font-family:Arial,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:32px;"><main style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;"><h1 style="font-size:22px;margin:0 0 10px;">You have been unsubscribed</h1><p style="font-size:14px;line-height:1.5;color:#475569;margin:0;">` + escapeMailHTML(email) + ` will no longer receive promotional campaign emails from O3 Cards.</p></main></body></html>`)) //nolint:errcheck
	}
}

func recordCampaignUnsubscribeFromMail(ctx context.Context, db *core.DB, mail core.Row, email string) {
	pid := str(mail["provider_message_id"])
	where := "LOWER(TRIM(email))=LOWER(TRIM($1))"
	args := []any{email}
	if pid != "" {
		where = "(email_provider_id=$1 OR LOWER(TRIM(email))=LOWER(TRIM($2)))"
		args = []any{pid, email}
	}
	rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
		UPDATE campaign_contacts
		SET email_status='unsubscribed', updated_at=NOW()
		WHERE %s
		  AND email_status NOT IN ('unsubscribed','bounced','spam','failed')
		RETURNING id, campaign_id, tracking_id`, where), args...)
	if len(rows) == 0 {
		return
	}
	contact := rows[0]
	if !campaignContactHasEvent(ctx, db, contact["id"], "unsubscribed") {
		payload, _ := json.Marshal(map[string]any{"email": email, "source": "unsubscribe_link", "mail_id": mail["id"]})
		_, _ = db.PGExec(ctx, `
			INSERT INTO campaign_events
			  (campaign_id, contact_id, tracking_id, event_type, channel, provider_msg_id, raw_payload)
			VALUES ($1,$2,$3,'unsubscribed','email',$4,$5::jsonb)`,
			contact["campaign_id"], contact["id"], str(contact["tracking_id"]), pid, string(payload))
		_, _ = db.PGExec(ctx, "UPDATE campaigns SET unsubscribe_count=unsubscribe_count+1, updated_at=NOW() WHERE id=$1", contact["campaign_id"])
	}
}

func SendMail(ctx context.Context, db *core.DB, opt SendMailOptions) SendMailResult {
	if err := ensureMailSchema(ctx, db); err != nil {
		return SendMailResult{Error: "Mail storage setup failed: " + err.Error()}
	}
	if len(opt.To) == 0 {
		return SendMailResult{Error: "at least one recipient is required"}
	}
	if suppressed, reason := hasSuppressedRecipient(ctx, db, opt.To); suppressed {
		return SendMailResult{Error: "recipient suppressed: " + reason}
	}
	if opt.SendViaUserMailbox && opt.ReplyToEmail != "" && graphConfigured(ctx, db) {
		res := sendMailViaGraph(ctx, db, opt)
		if res.OK {
			return res
		}
		slog.Warn("Microsoft Graph mail failed; falling back to SendGrid", "error", res.Error)
		opt.SendViaUserMailbox = false
	}
	apiKey := resolveCredKey(ctx, db, "SENDGRID_API_KEY")
	if apiKey == "" {
		return SendMailResult{Error: "SENDGRID_API_KEY not configured"}
	}
	if opt.FromEmail == "" {
		// Prefer the active default sender from the email_senders table (UI-configurable).
		if senderRows, _ := db.PGQuery(ctx, `
			SELECT address, display_name FROM email_senders
			WHERE is_active=TRUE AND is_default=TRUE LIMIT 1`); len(senderRows) > 0 {
			opt.FromEmail = str(senderRows[0]["address"])
			if opt.FromName == "" {
				opt.FromName = str(senderRows[0]["display_name"])
			}
		}
	}
	if opt.FromEmail == "" {
		// DB credential takes priority; fall back to env var
		opt.FromEmail = coalesce(resolveCredKey(ctx, db, "EMAIL_FROM_ADDRESS"), sendgridFromEmail)
	}
	if opt.FromName == "" {
		opt.FromName = coalesce(resolveCredKey(ctx, db, "EMAIL_FROM_NAME"), sendgridFromName)
	}
	if opt.FromEmail == "" {
		return SendMailResult{Error: "EMAIL_FROM_ADDRESS not configured"}
	}
	if opt.ReplyToEmail == "" {
		opt.ReplyToEmail = defaultReplyToEmail(ctx, db)
	}
	if opt.HTMLBody == "" {
		opt.HTMLBody = "<p></p>"
	}
	if opt.TextBody == "" {
		opt.TextBody = htmlToText(opt.HTMLBody)
	}
	if opt.Kind == "" {
		opt.Kind = "transactional"
	}
	if opt.TrackOpensAndLinks == false && opt.Category == "" {
		opt.TrackOpensAndLinks = true
	}
	if opt.SendCopyToSender && opt.SenderCopyEmail != "" {
		opt.BCC = append(opt.BCC, MailAddress{Email: opt.SenderCopyEmail, Name: opt.SenderCopyName})
	}
	opt.To, opt.CC, opt.BCC = uniqueMailRecipients(opt.To, opt.CC, opt.BCC)
	if len(opt.To) == 0 {
		return SendMailResult{Error: "at least one recipient is required"}
	}

	mailID := createMailMessage(ctx, db, opt)
	if replyAddress := inboundReplyAddress(ctx, db, mailID, opt.Kind); replyAddress != "" {
		opt.ReplyToEmail = replyAddress
		if strings.TrimSpace(opt.ReplyToName) == "" {
			opt.ReplyToName = opt.FromName
		}
	}
	if opt.Kind == "campaign" {
		recipientEmail := ""
		if len(opt.To) > 0 {
			recipientEmail = opt.To[0].Email
		}
		opt.HTMLBody = appendUnsubscribeHTML(ctx, db, opt.HTMLBody, mailID, recipientEmail)
		opt.TextBody = appendUnsubscribeText(ctx, db, opt.TextBody, mailID, recipientEmail)
	}
	args := map[string]string{}
	for k, v := range opt.CustomArgs {
		args[k] = v
	}
	if mailID > 0 {
		args["o3c_mail_id"] = fmt.Sprintf("%d", mailID)
	}
	if opt.Kind != "" {
		args["o3c_kind"] = opt.Kind
	}
	if opt.RelatedType != "" {
		args["o3c_related_type"] = opt.RelatedType
	}
	if opt.RelatedID > 0 {
		args["o3c_related_id"] = fmt.Sprintf("%d", opt.RelatedID)
	}

	personalization := map[string]any{"to": mailAddresses(opt.To)}
	if len(opt.CC) > 0 {
		personalization["cc"] = mailAddresses(opt.CC)
	}
	if len(opt.BCC) > 0 {
		personalization["bcc"] = mailAddresses(opt.BCC)
	}
	if len(args) > 0 {
		personalization["custom_args"] = args
	}

	payload := map[string]any{
		"personalizations": []any{personalization},
		"from":             map[string]string{"email": opt.FromEmail, "name": opt.FromName},
		"subject":          opt.Subject,
		"content": []any{
			map[string]string{"type": "text/plain", "value": opt.TextBody},
			map[string]string{"type": "text/html", "value": opt.HTMLBody},
		},
	}
	if opt.ReplyToEmail != "" {
		payload["reply_to"] = map[string]string{"email": opt.ReplyToEmail, "name": opt.ReplyToName}
	}
	if opt.Category != "" {
		payload["categories"] = []string{opt.Category}
	}
	if opt.TrackOpensAndLinks {
		payload["tracking_settings"] = map[string]any{
			"click_tracking": map[string]any{"enable": true, "enable_text": false},
			"open_tracking":  map[string]any{"enable": true},
		}
	}
	if opt.Kind == "campaign" {
		listRecipientEmail := ""
		if len(opt.To) > 0 {
			listRecipientEmail = opt.To[0].Email
		}
		unsubURL := unsubscribeURL(ctx, db, mailID, listRecipientEmail)
		payload["headers"] = map[string]string{
			"List-Unsubscribe":      "<" + unsubURL + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		}
	}
	// Add List-Unsubscribe headers for notification mail preferences.
	if opt.Kind == "notification" {
		appURL := coalesce(os.Getenv("APP_URL"), "https://reports.o3cards.com")
		prefsURL := appURL + "/settings/notifications"
		payload["headers"] = map[string]string{
			"List-Unsubscribe":      "<" + prefsURL + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		}
	}
	if len(opt.Attachments) > 0 {
		payload["attachments"] = sendgridAttachments(opt.Attachments)
	}

	body, _ := json.Marshal(payload)
	resp, err := httpPost("https://api.sendgrid.com/v3/mail/send", "application/json",
		"Bearer "+apiKey, body, 20*time.Second)
	if err != nil {
		updateMailMessageStatus(ctx, db, mailID, "failed", "", err.Error())
		return SendMailResult{MailID: mailID, Error: err.Error()}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	providerID := resp.Header.Get("X-Message-Id")
	if resp.StatusCode == 200 || resp.StatusCode == 202 {
		updateMailMessageStatus(ctx, db, mailID, "queued", providerID, "")
		return SendMailResult{OK: true, ProviderID: providerID, MailID: mailID}
	}
	msg := strings.TrimSpace(string(respBody))
	if msg == "" {
		msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	slog.Warn("SendGrid mail send failed", "status", resp.StatusCode, "body", msg, "mail_id", mailID)
	updateMailMessageStatus(ctx, db, mailID, "failed", providerID, msg)
	return SendMailResult{MailID: mailID, ProviderID: providerID, Error: msg}
}

func SendTemporaryPasswordEmail(ctx context.Context, db *core.DB, email, name, tempPassword string, userID int64) SendMailResult {
	html := fmt.Sprintf(`
		<p>Hello %s,</p>
		<p>Your O3 Capital portal password has been reset.</p>
		<p><strong>Temporary password:</strong> <code>%s</code></p>
		<p>Please sign in and change it immediately.</p>
		<p>If you did not request this reset, contact your administrator.</p>`,
		escapeMailHTML(coalesce(name, "there")), escapeMailHTML(tempPassword))
	text := fmt.Sprintf("Hello %s,\n\nYour O3 Capital portal password has been reset.\nTemporary password: %s\n\nPlease sign in and change it immediately.\nIf you did not request this reset, contact your administrator.",
		coalesce(name, "there"), tempPassword)
	return SendMail(ctx, db, SendMailOptions{
		To:          []MailAddress{{Email: email, Name: name}},
		Subject:     "Your O3C portal password reset",
		HTMLBody:    html,
		TextBody:    text,
		Category:    "system",
		Kind:        "password_reset",
		RelatedType: "o3c_users",
		RelatedID:   userID,
		CustomArgs:  map[string]string{"o3c_template": "password_reset"},
	})
}

func hasSuppressedRecipient(ctx context.Context, db *core.DB, recipients []MailAddress) (bool, string) {
	for _, recipient := range recipients {
		email := strings.ToLower(strings.TrimSpace(recipient.Email))
		if email == "" {
			continue
		}
		rows, _ := db.PGQuery(ctx, `
			SELECT reason FROM mail_suppressions
			WHERE email=$1 AND is_active=true
			LIMIT 1`, email)
		if len(rows) > 0 {
			return true, str(rows[0]["reason"])
		}
	}
	return false, ""
}

func addSuppression(ctx context.Context, db *core.DB, email, reason, source string) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return
	}
	_, _ = db.PGExec(ctx, `
		INSERT INTO mail_suppressions (email, reason, source)
		VALUES ($1,$2,$3)
		ON CONFLICT (email) DO UPDATE SET
			reason=EXCLUDED.reason,
			source=EXCLUDED.source,
			is_active=true,
			updated_at=NOW()`,
		email, reason, source)
}

func ensureMailSchema(ctx context.Context, db *core.DB) error {
	mailSchemaMu.Lock()
	defer mailSchemaMu.Unlock()
	if mailSchemaReady {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS mail_messages (
		  id                  BIGSERIAL PRIMARY KEY,
		  kind                TEXT NOT NULL DEFAULT 'transactional',
		  related_type        TEXT,
		  related_id          BIGINT,
		  subject             TEXT NOT NULL DEFAULT '',
		  from_email          TEXT,
		  from_name           TEXT,
		  recipients          JSONB NOT NULL DEFAULT '{}',
		  status              TEXT NOT NULL DEFAULT 'sending',
		  provider_message_id TEXT,
		  queued_at           TIMESTAMPTZ,
		  delivered_at        TIMESTAMPTZ,
		  opened_at           TIMESTAMPTZ,
		  clicked_at          TIMESTAMPTZ,
		  bounced_at          TIMESTAMPTZ,
		  last_error          TEXT,
		  created_by          BIGINT REFERENCES o3c_users(id),
		  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		// Add columns to existing mail_messages table (idempotent)
		`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS html_body   TEXT`,
		`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS text_body   TEXT`,
		`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS thread_id   BIGINT`,
		`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS parent_id   BIGINT`,
		`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS send_at     TIMESTAMPTZ`,
		`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'`,
		`CREATE INDEX IF NOT EXISTS idx_mail_messages_provider ON mail_messages(provider_message_id) WHERE provider_message_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_mail_messages_created_by ON mail_messages(created_by, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_mail_messages_status ON mail_messages(status, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS mail_events (
		  id                BIGSERIAL PRIMARY KEY,
		  mail_message_id   BIGINT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
		  provider_event_id TEXT UNIQUE,
		  event_type        TEXT NOT NULL,
		  event_data        JSONB NOT NULL DEFAULT '{}',
		  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mail_events_message ON mail_events(mail_message_id, occurred_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_mail_events_type ON mail_events(event_type, occurred_at DESC)`,
		`CREATE TABLE IF NOT EXISTS mail_suppressions (
		  email      TEXT PRIMARY KEY,
		  reason     TEXT NOT NULL DEFAULT 'suppressed',
		  source     TEXT NOT NULL DEFAULT 'manual',
		  is_active  BOOLEAN NOT NULL DEFAULT true,
		  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mail_suppressions_active ON mail_suppressions(is_active, updated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS inbound_mail (
		  id          BIGSERIAL PRIMARY KEY,
		  mail_message_id BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL,
		  from_email  TEXT NOT NULL,
		  from_name   TEXT,
		  to_email    TEXT,
		  subject     TEXT NOT NULL DEFAULT '',
		  body_text   TEXT,
		  body_html   TEXT,
		  message_id  TEXT,
		  in_reply_to TEXT,
		  raw_headers TEXT,
		  is_read     BOOLEAN NOT NULL DEFAULT false,
		  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE inbound_mail ADD COLUMN IF NOT EXISTS mail_message_id BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL`,
		`ALTER TABLE inbound_mail ADD COLUMN IF NOT EXISTS message_id TEXT`,
		`ALTER TABLE inbound_mail ADD COLUMN IF NOT EXISTS in_reply_to TEXT`,
		`ALTER TABLE inbound_mail ADD COLUMN IF NOT EXISTS raw_headers TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_inbound_mail_received ON inbound_mail(received_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_inbound_mail_message ON inbound_mail(mail_message_id, received_at DESC) WHERE mail_message_id IS NOT NULL`,
		// Drafts table
		`CREATE TABLE IF NOT EXISTS mail_drafts (
		  id          BIGSERIAL PRIMARY KEY,
		  user_id     BIGINT NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
		  to_addrs    JSONB NOT NULL DEFAULT '[]',
		  cc_addrs    JSONB NOT NULL DEFAULT '[]',
		  bcc_addrs   JSONB NOT NULL DEFAULT '[]',
		  from_email  TEXT,
		  from_name   TEXT,
		  subject     TEXT NOT NULL DEFAULT '',
		  html_body   TEXT,
		  text_body   TEXT,
		  attachments JSONB NOT NULL DEFAULT '[]',
		  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mail_drafts_user ON mail_drafts(user_id, updated_at DESC)`,
		// User email signatures
		`CREATE TABLE IF NOT EXISTS user_email_signatures (
		  user_id        BIGINT PRIMARY KEY REFERENCES o3c_users(id) ON DELETE CASCADE,
		  signature_html TEXT,
		  signature_text TEXT,
		  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		// Ensure campaign_contacts has tracking_id for open/click pixel tracking.
		`ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS tracking_id UUID DEFAULT gen_random_uuid()`,
	}
	for _, stmt := range statements {
		if _, err := db.PGExec(ctx, stmt); err != nil {
			slog.Error("Mail schema statement failed", "err", err, "statement", stmt)
			return err
		}
	}
	mailSchemaReady = true
	return nil
}

// generateUnsubToken builds a signed unsubscribe token:
//   payload  = base64url("{mailID}:{email}")
//   token    = payload + "." + base64url(HMAC-SHA256(secretKey, payload))
func generateUnsubToken(mailID int64, email, secretKey string) string {
	payload := fmt.Sprintf("%d:%s", mailID, email)
	payloadEnc := base64.RawURLEncoding.EncodeToString([]byte(payload))
	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write([]byte(payloadEnc))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payloadEnc + "." + sig
}

// parseUnsubToken verifies and decodes a token produced by generateUnsubToken.
func parseUnsubToken(token, secretKey string) (mailID int64, email string, ok bool) {
	dotIdx := strings.LastIndex(token, ".")
	if dotIdx < 0 {
		return 0, "", false
	}
	payloadEnc := token[:dotIdx]
	sigGiven := token[dotIdx+1:]
	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write([]byte(payloadEnc))
	sigExpected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sigExpected), []byte(sigGiven)) {
		return 0, "", false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(payloadEnc)
	if err != nil {
		return 0, "", false
	}
	colonIdx := strings.Index(string(payloadBytes), ":")
	if colonIdx < 0 {
		return 0, "", false
	}
	mailID, err = strconv.ParseInt(string(payloadBytes[:colonIdx]), 10, 64)
	if err != nil {
		return 0, "", false
	}
	return mailID, string(payloadBytes[colonIdx+1:]), true
}

func appendUnsubscribeHTML(ctx context.Context, db *core.DB, html string, mailID int64, recipientEmail string) string {
	if mailID <= 0 {
		return html
	}
	link := unsubscribeURL(ctx, db, mailID, recipientEmail)
	if link == "" {
		slog.Warn("APP_BASE_URL not set — unsubscribe link omitted from bulk mail. This may violate CAN-SPAM/NDPR compliance.")
		return html
	}
	footer := fmt.Sprintf(`<p style="margin-top:24px;font-size:12px;color:#64748b;">You are receiving this email from O3 Capital. <a href="%s" style="color:#0E2841;">Unsubscribe</a></p>`, escapeMailHTML(link))
	return html + footer
}

func appendUnsubscribeText(ctx context.Context, db *core.DB, text string, mailID int64, recipientEmail string) string {
	link := unsubscribeURL(ctx, db, mailID, recipientEmail)
	if link == "" {
		return text
	}
	return strings.TrimSpace(text) + "\n\nUnsubscribe: " + link
}

func unsubscribeURL(ctx context.Context, db *core.DB, mailID int64, recipientEmail string) string {
	base := os.Getenv("APP_BASE_URL")
	if base == "" {
		if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='app_base_url'`); len(rows) > 0 {
			base = str(rows[0]["value"])
		}
	}
	base = strings.TrimRight(base, "/")
	if base == "" {
		return ""
	}
	secretKey := os.Getenv("SECRET_KEY")
	if secretKey != "" && recipientEmail != "" {
		token := generateUnsubToken(mailID, recipientEmail, secretKey)
		return fmt.Sprintf("%s/api/mail/unsubscribe?token=%s", base, url.QueryEscape(token))
	}
	if secretKey == "" {
		slog.Warn("SECRET_KEY not set; unsubscribe links are unsigned (plain mail_id)")
	}
	return fmt.Sprintf("%s/api/mail/unsubscribe?mail_id=%d", base, mailID)
}

func mailDomain(ctx context.Context, db *core.DB) string {
	if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='mail_domain'`); len(rows) > 0 && str(rows[0]["value"]) != "" {
		return strings.TrimSpace(str(rows[0]["value"]))
	}
	if idx := strings.LastIndex(sendgridFromEmail, "@"); idx >= 0 {
		return sendgridFromEmail[idx+1:]
	}
	return ""
}

func checkSPF(domain string) (bool, string) {
	txts, err := net.LookupTXT(domain)
	if err != nil {
		return false, "No TXT records found for " + domain
	}
	for _, txt := range txts {
		if strings.HasPrefix(strings.ToLower(txt), "v=spf1") {
			if strings.Contains(strings.ToLower(txt), "sendgrid.net") {
				return true, txt
			}
			return false, "SPF exists but does not include sendgrid.net"
		}
	}
	return false, "No SPF record found"
}

func checkDMARC(domain string) (bool, string) {
	txts, err := net.LookupTXT("_dmarc." + domain)
	if err != nil {
		return false, "No DMARC TXT record found"
	}
	for _, txt := range txts {
		if strings.HasPrefix(strings.ToLower(txt), "v=dmarc1") {
			return true, txt
		}
	}
	return false, "No DMARC record found"
}

func checkDKIM(domain string) (bool, string) {
	selectors := []string{"s1", "s2"}
	missing := []string{}
	for _, selector := range selectors {
		host := selector + "._domainkey." + domain
		cnames, err := net.LookupCNAME(host)
		if err != nil {
			missing = append(missing, host)
			continue
		}
		target := strings.ToLower(strings.TrimSuffix(cnames, "."))
		if !strings.Contains(target, "sendgrid.net") {
			return false, host + " points to " + target + ", expected SendGrid"
		}
	}
	if len(missing) > 0 {
		return false, "Missing SendGrid DKIM CNAMEs: " + strings.Join(missing, ", ")
	}
	return true, "s1/s2 DKIM CNAMEs point to SendGrid"
}

func defaultReplyToEmail(ctx context.Context, db *core.DB) string {
	if value := strings.TrimSpace(os.Getenv("SENDGRID_REPLY_TO_EMAIL")); value != "" {
		return value
	}
	if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='sendgrid_reply_to_email'`); len(rows) > 0 {
		return strings.TrimSpace(str(rows[0]["value"]))
	}
	return sendgridFromEmail
}

func inboundReplyAddress(ctx context.Context, db *core.DB, mailID int64, kind string) string {
	if mailID <= 0 {
		return ""
	}
	if !usesInboundReplyAddress(kind) {
		return ""
	}
	domain := strings.TrimSpace(os.Getenv("MAIL_INBOUND_DOMAIN"))
	if domain == "" {
		if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='mail_inbound_domain'`); len(rows) > 0 {
			domain = strings.TrimSpace(str(rows[0]["value"]))
		}
	}
	domain = strings.TrimPrefix(strings.TrimPrefix(domain, "@"), ".")
	if domain == "" {
		return ""
	}
	return fmt.Sprintf("reply+%d@%s", mailID, domain)
}

func usesInboundReplyAddress(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "helpdesk":
		return true
	default:
		return false
	}
}

func parseMailAddress(raw string) (string, string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	if i := strings.Index(raw, "<"); i >= 0 {
		name := strings.Trim(strings.TrimSpace(raw[:i]), `"`)
		email := strings.Trim(strings.TrimSpace(raw[i+1:]), "> ")
		return name, email
	}
	return "", strings.Trim(raw, `"`)
}

func extractInboundReplyMailID(raw string) int64 {
	match := inboundReplyAddressRE.FindStringSubmatch(raw)
	if len(match) != 2 {
		return 0
	}
	id, _ := strconv.ParseInt(match[1], 10, 64)
	return id
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func resolveSendGridWebhookPublicKey(ctx context.Context, db *core.DB) string {
	if sendgridWebhookPublicKey != "" {
		return sendgridWebhookPublicKey
	}
	return resolveCredKey(ctx, db, "SENDGRID_WEBHOOK_PUBLIC_KEY")
}

func firstRecipientEmail(raw any) string {
	var payload map[string][]map[string]string
	switch v := raw.(type) {
	case []byte:
		json.Unmarshal(v, &payload) //nolint:errcheck
	case string:
		json.Unmarshal([]byte(v), &payload) //nolint:errcheck
	}
	for _, item := range payload["to"] {
		if email := strings.TrimSpace(item["email"]); email != "" {
			return email
		}
	}
	return ""
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func graphConfigured(ctx context.Context, db *core.DB) bool {
	return resolveCredKey(ctx, db, "MS_GRAPH_TENANT_ID") != "" &&
		resolveCredKey(ctx, db, "MS_GRAPH_CLIENT_ID") != "" &&
		resolveCredKey(ctx, db, "MS_GRAPH_CLIENT_SECRET") != ""
}

func sendMailViaGraph(ctx context.Context, db *core.DB, opt SendMailOptions) SendMailResult {
	token, err := graphToken(ctx, db)
	if err != nil {
		return SendMailResult{Error: err.Error()}
	}
	if opt.FromEmail == "" {
		opt.FromEmail = opt.ReplyToEmail
	}
	if opt.FromName == "" {
		opt.FromName = opt.ReplyToName
	}
	if opt.HTMLBody == "" {
		opt.HTMLBody = "<p>" + escapeMailHTML(opt.TextBody) + "</p>"
	}
	// NOTE: createMailMessage is called AFTER a successful Graph HTTP send to avoid
	// creating a duplicate DB record when Graph fails and SendMail falls back to SendGrid.
	message := map[string]any{
		"subject": opt.Subject,
		"body": map[string]string{
			"contentType": "HTML",
			"content":     opt.HTMLBody,
		},
		"toRecipients":  graphRecipients(opt.To),
		"ccRecipients":  graphRecipients(opt.CC),
		"bccRecipients": graphRecipients(opt.BCC),
	}
	if len(opt.Attachments) > 0 {
		message["attachments"] = graphAttachments(opt.Attachments)
	}
	payload := map[string]any{
		"message":         message,
		"saveToSentItems": true,
	}
	body, _ := json.Marshal(payload)
	endpoint := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/sendMail", url.PathEscape(opt.ReplyToEmail))
	resp, err := httpPost(endpoint, "application/json", "Bearer "+token, body, 20*time.Second)
	if err != nil {
		// No DB record created — Graph failed before send; SendMail will fall back to SendGrid.
		return SendMailResult{Error: err.Error()}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusAccepted {
		// Create the DB record only after a confirmed successful send to prevent duplicates
		// when Graph fails and SendMail falls back to SendGrid (which creates its own record).
		mailID := createMailMessage(ctx, db, opt)
		providerID := "graph:" + fmt.Sprintf("%d", mailID)
		updateMailMessageStatus(ctx, db, mailID, "queued", providerID, "")
		return SendMailResult{OK: true, ProviderID: providerID, MailID: mailID}
	}
	errMsg := strings.TrimSpace(string(respBody))
	if errMsg == "" {
		errMsg = fmt.Sprintf("Microsoft Graph HTTP %d", resp.StatusCode)
	}
	slog.Warn("Microsoft Graph mail send failed", "status", resp.StatusCode, "body", errMsg)
	return SendMailResult{Error: errMsg}
}

func graphRecipients(addresses []MailAddress) []map[string]any {
	out := make([]map[string]any, 0, len(addresses))
	for _, a := range addresses {
		if strings.TrimSpace(a.Email) == "" {
			continue
		}
		out = append(out, map[string]any{
			"emailAddress": map[string]string{
				"address": a.Email,
				"name":    a.Name,
			},
		})
	}
	return out
}

func sendgridAttachments(attachments []MailAttachment) []map[string]string {
	out := make([]map[string]string, 0, len(attachments))
	for _, a := range attachments {
		filename := sanitizeAttachmentName(a.Filename)
		if filename == "" || strings.TrimSpace(a.Content) == "" {
			continue
		}
		disposition := strings.TrimSpace(a.Disposition)
		if disposition == "" {
			disposition = "attachment"
		}
		item := map[string]string{
			"content":     strings.TrimSpace(a.Content),
			"filename":    filename,
			"type":        valueOr(strings.TrimSpace(a.ContentType), "application/octet-stream"),
			"disposition": disposition,
		}
		if strings.TrimSpace(a.ContentID) != "" {
			item["content_id"] = strings.TrimSpace(a.ContentID)
		}
		out = append(out, item)
	}
	return out
}

func graphAttachments(attachments []MailAttachment) []map[string]any {
	out := make([]map[string]any, 0, len(attachments))
	for _, a := range attachments {
		filename := sanitizeAttachmentName(a.Filename)
		if filename == "" || strings.TrimSpace(a.Content) == "" {
			continue
		}
		item := map[string]any{
			"@odata.type":  "#microsoft.graph.fileAttachment",
			"name":         filename,
			"contentType":  valueOr(strings.TrimSpace(a.ContentType), "application/octet-stream"),
			"contentBytes": strings.TrimSpace(a.Content),
		}
		if strings.EqualFold(a.Disposition, "inline") {
			item["isInline"] = true
			if strings.TrimSpace(a.ContentID) != "" {
				item["contentId"] = strings.TrimSpace(a.ContentID)
			}
		}
		out = append(out, item)
	}
	return out
}

func graphToken(ctx context.Context, db *core.DB) (string, error) {
	graphTokenMu.Lock()
	defer graphTokenMu.Unlock()
	// Return cached token if it still has more than 60 s of life left.
	if cachedGraphToken != "" && time.Now().Before(cachedGraphTokenExp.Add(-60*time.Second)) {
		return cachedGraphToken, nil
	}
	tenantID := resolveCredKey(ctx, db, "MS_GRAPH_TENANT_ID")
	clientID := resolveCredKey(ctx, db, "MS_GRAPH_CLIENT_ID")
	clientSecret := resolveCredKey(ctx, db, "MS_GRAPH_CLIENT_SECRET")
	if tenantID == "" || clientID == "" || clientSecret == "" {
		return "", fmt.Errorf("Microsoft Graph mail is not configured")
	}
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("scope", "https://graph.microsoft.com/.default")
	form.Set("grant_type", "client_credentials")
	resp, err := httpPost("https://login.microsoftonline.com/"+url.PathEscape(tenantID)+"/oauth2/v2.0/token",
		"application/x-www-form-urlencoded", "", []byte(form.Encode()), 20*time.Second)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var data map[string]any
	json.NewDecoder(resp.Body).Decode(&data) //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Microsoft Graph token failed: HTTP %d", resp.StatusCode)
	}
	token := str(data["access_token"])
	if token == "" {
		return "", fmt.Errorf("Microsoft Graph token response missing access_token")
	}
	cachedGraphToken = token
	cachedGraphTokenExp = time.Now().Add(3600 * time.Second)
	return token, nil
}

func mailAddresses(addresses []MailAddress) []map[string]string {
	out := make([]map[string]string, 0, len(addresses))
	for _, a := range addresses {
		if strings.TrimSpace(a.Email) == "" {
			continue
		}
		out = append(out, map[string]string{"email": a.Email, "name": a.Name})
	}
	return out
}

func uniqueMailRecipients(to, cc, bcc []MailAddress) ([]MailAddress, []MailAddress, []MailAddress) {
	seen := map[string]bool{}
	filter := func(addresses []MailAddress) []MailAddress {
		out := make([]MailAddress, 0, len(addresses))
		for _, address := range addresses {
			email := strings.TrimSpace(address.Email)
			if email == "" {
				continue
			}
			key := strings.ToLower(email)
			if seen[key] {
				continue
			}
			seen[key] = true
			address.Email = email
			address.Name = strings.TrimSpace(address.Name)
			out = append(out, address)
		}
		return out
	}
	return filter(to), filter(cc), filter(bcc)
}

func validateMailAttachments(attachments []MailAttachment) error {
	const maxAttachments = 10
	const maxFileBytes = 10 * 1024 * 1024
	const maxTotalBytes = 20 * 1024 * 1024
	if len(attachments) > maxAttachments {
		return fmt.Errorf("maximum %d attachments allowed", maxAttachments)
	}
	total := 0
	for _, a := range attachments {
		filename := sanitizeAttachmentName(a.Filename)
		if filename == "" {
			return fmt.Errorf("attachment filename is required")
		}
		content := strings.TrimSpace(a.Content)
		if content == "" {
			return fmt.Errorf("attachment %s is empty", filename)
		}
		decoded, err := base64.StdEncoding.DecodeString(content)
		if err != nil {
			return fmt.Errorf("attachment %s is not valid base64", filename)
		}
		if len(decoded) > maxFileBytes {
			return fmt.Errorf("attachment %s is larger than 10 MB", filename)
		}
		total += len(decoded)
		if total > maxTotalBytes {
			return fmt.Errorf("attachments are larger than 20 MB total")
		}
	}
	return nil
}

func sanitizeAttachmentName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\x00", "")
	if len(name) > 180 {
		name = name[:180]
	}
	return name
}

func createMailMessage(ctx context.Context, db *core.DB, opt SendMailOptions) int64 {
	recipients, _ := json.Marshal(map[string]any{
		"to":  mailAddresses(opt.To),
		"cc":  mailAddresses(opt.CC),
		"bcc": mailAddresses(opt.BCC),
	})
	attachmentsJSON := "[]"
	if len(opt.Attachments) > 0 {
		if b, err := json.Marshal(opt.Attachments); err == nil {
			attachmentsJSON = string(b)
		}
	}
	rows, err := db.PGQuery(ctx, `
		INSERT INTO mail_messages
		    (kind, related_type, related_id, subject, from_email, from_name,
		     recipients, status, created_by, html_body, text_body, attachments)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'sending',$8,$9,$10,$11::jsonb)
		RETURNING id`,
		opt.Kind, ns(opt.RelatedType), nullableID(opt.RelatedID), opt.Subject,
		opt.FromEmail, opt.FromName, string(recipients), nullableID(opt.CreatedBy),
		ns(opt.HTMLBody), ns(opt.TextBody), attachmentsJSON)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return toInt64(rows[0]["id"])
}

func updateMailMessageStatus(ctx context.Context, db *core.DB, mailID int64, status, providerID, errMsg string) {
	if mailID <= 0 {
		return
	}
	_, _ = db.PGExec(ctx, `
		UPDATE mail_messages
		SET status=$1, provider_message_id=NULLIF($2,''), last_error=NULLIF($3,''), updated_at=NOW(),
		    queued_at=CASE WHEN $1='queued' THEN NOW() ELSE queued_at END
		WHERE id=$4`,
		status, providerID, errMsg, mailID)
}

func recordMailEvent(ctx context.Context, db *core.DB, providerID, eventType string, event map[string]any) {
	if providerID == "" || eventType == "" {
		return
	}
	payload, _ := json.Marshal(event)
	rows, _ := db.PGQuery(ctx, `
		SELECT id FROM mail_messages
		WHERE provider_message_id=$1 OR provider_message_id=$2
		ORDER BY id DESC LIMIT 1`, providerID, strings.SplitN(providerID, ".", 2)[0])
	if len(rows) == 0 {
		return
	}
	mailID := toInt64(rows[0]["id"])
	_, _ = db.PGExec(ctx, `
		INSERT INTO mail_events (mail_message_id, provider_event_id, event_type, event_data, occurred_at)
		VALUES ($1, NULLIF($2,''), $3, $4::jsonb,
		        COALESCE(to_timestamp(NULLIF($5,'')::double precision), NOW()))
		ON CONFLICT (provider_event_id) DO NOTHING`,
		mailID, str(event["sg_event_id"]), eventType, string(payload), str(event["timestamp"]))
	_, _ = db.PGExec(ctx, `
		UPDATE mail_messages
		SET status=$1,
		    delivered_at=CASE WHEN $1='delivered' THEN NOW() ELSE delivered_at END,
		    opened_at=CASE WHEN $1='opened' THEN COALESCE(opened_at, NOW()) ELSE opened_at END,
		    clicked_at=CASE WHEN $1='clicked' THEN COALESCE(clicked_at, NOW()) ELSE clicked_at END,
		    bounced_at=CASE WHEN $1 IN ('bounced','dropped','spam_report','unsubscribed') THEN NOW() ELSE bounced_at END,
		    updated_at=NOW()
		WHERE id=$2`, eventStatus(eventType), mailID)
	if eventType == "bounce" || eventType == "dropped" || eventType == "spamreport" || eventType == "unsubscribe" || eventType == "group_unsubscribe" {
		addSuppression(ctx, db, str(event["email"]), eventStatus(eventType), "sendgrid_event")
	}
}

func verifySendGridSignature(publicKeyRaw string, timestamp string, signatureRaw string, payload []byte) bool {
	publicKeyRaw = strings.TrimSpace(publicKeyRaw)
	if publicKeyRaw == "" || timestamp == "" || signatureRaw == "" {
		return false
	}
	pub, err := parseECDSAPublicKey(publicKeyRaw)
	if err != nil {
		return false
	}
	sigBytes, err := base64.StdEncoding.DecodeString(signatureRaw)
	if err != nil {
		return false
	}
	var sig struct {
		R *big.Int
		S *big.Int
	}
	if _, err := asn1.Unmarshal(sigBytes, &sig); err != nil {
		return false
	}
	if sig.R == nil || sig.S == nil {
		return false
	}
	hash := sha256.Sum256(append([]byte(timestamp), payload...))
	return ecdsa.Verify(pub, hash[:], sig.R, sig.S)
}

func parseECDSAPublicKey(raw string) (*ecdsa.PublicKey, error) {
	if block, _ := pem.Decode([]byte(raw)); block != nil {
		key, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		if pub, ok := key.(*ecdsa.PublicKey); ok {
			return pub, nil
		}
		return nil, fmt.Errorf("public key is not ECDSA")
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKIXPublicKey(decoded)
	if err != nil {
		return nil, err
	}
	pub, ok := key.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is not ECDSA")
	}
	return pub, nil
}

func eventStatus(eventType string) string {
	switch eventType {
	case "processed":
		return "processed"
	case "delivered":
		return "delivered"
	case "open":
		return "opened"
	case "click":
		return "clicked"
	case "bounce":
		return "bounced"
	case "dropped":
		return "dropped"
	case "deferred":
		return "deferred"
	case "spamreport":
		return "spam_report"
	case "unsubscribe", "group_unsubscribe":
		return "unsubscribed"
	default:
		return eventType
	}
}

func htmlToText(html string) string {
	replacer := strings.NewReplacer("<br>", "\n", "<br/>", "\n", "<br />", "\n", "</p>", "\n\n")
	text := replacer.Replace(html)
	for {
		start := strings.Index(text, "<")
		end := strings.Index(text, ">")
		if start < 0 || end < start {
			break
		}
		text = text[:start] + text[end+1:]
	}
	return strings.TrimSpace(strings.Join(strings.Fields(text), " "))
}

func escapeMailHTML(s string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	).Replace(s)
}

func nullableID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}

func ns(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// ── getMailMessage ────────────────────────────────────────────────────────────

func getMailMessage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		idStr := chi.URLParam(r, "id")
		id, _ := strconv.ParseInt(idStr, 10, 64)
		if id <= 0 {
			respondErr(w, 400, "invalid id")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, kind, related_type, related_id, subject, from_email, from_name,
			       recipients, status, provider_message_id, queued_at, delivered_at,
			       opened_at, clicked_at, bounced_at, last_error, created_at, updated_at,
			       html_body, text_body, thread_id, parent_id, send_at, attachments
			FROM mail_messages
			WHERE id=$1 AND (created_by=$2 OR recipients @> jsonb_build_array($3::text))`,
			id, user.ID, user.Sub)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "message not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// ── listMailMessages (updated to include body columns) ────────────────────────

// ── Draft handlers ────────────────────────────────────────────────────────────

func mailListDrafts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, subject, to_addrs, cc_addrs, bcc_addrs, from_email, from_name,
			       html_body, text_body, attachments, updated_at, created_at
			FROM mail_drafts
			WHERE user_id=$1
			ORDER BY updated_at DESC
			LIMIT 200`, user.ID)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func mailSaveDraft(db *core.DB) http.HandlerFunc {
	type body struct {
		ID          *int64          `json:"id"`
		ToAddrs     json.RawMessage `json:"to_addrs"`
		CcAddrs     json.RawMessage `json:"cc_addrs"`
		BccAddrs    json.RawMessage `json:"bcc_addrs"`
		FromEmail   string          `json:"from_email"`
		FromName    string          `json:"from_name"`
		Subject     string          `json:"subject"`
		HTMLBody    string          `json:"html_body"`
		TextBody    string          `json:"text_body"`
		Attachments json.RawMessage `json:"attachments"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		user := core.UserFromCtx(r.Context())
		toJSON := jsonOrEmpty(b.ToAddrs)
		ccJSON := jsonOrEmpty(b.CcAddrs)
		bccJSON := jsonOrEmpty(b.BccAddrs)
		attJSON := jsonOrEmpty(b.Attachments)

		if b.ID != nil && *b.ID > 0 {
			// Update existing draft
			rows, err := db.PGQuery(r.Context(), `
				UPDATE mail_drafts
				SET to_addrs=$1::jsonb, cc_addrs=$2::jsonb, bcc_addrs=$3::jsonb,
				    from_email=$4, from_name=$5, subject=$6, html_body=$7, text_body=$8,
				    attachments=$9::jsonb, updated_at=NOW()
				WHERE id=$10 AND user_id=$11
				RETURNING id, subject, to_addrs, cc_addrs, bcc_addrs, from_email, from_name,
				          html_body, text_body, attachments, updated_at, created_at`,
				toJSON, ccJSON, bccJSON,
				ns(b.FromEmail), ns(b.FromName), b.Subject,
				ns(b.HTMLBody), ns(b.TextBody), attJSON,
				*b.ID, user.ID)
			if err != nil || len(rows) == 0 {
				respondErr(w, 404, "draft not found or update failed")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
			return
		}
		// Insert new draft
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO mail_drafts
			    (user_id, to_addrs, cc_addrs, bcc_addrs, from_email, from_name, subject,
			     html_body, text_body, attachments)
			VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb)
			RETURNING id, subject, to_addrs, cc_addrs, bcc_addrs, from_email, from_name,
			          html_body, text_body, attachments, updated_at, created_at`,
			user.ID, toJSON, ccJSON, bccJSON,
			ns(b.FromEmail), ns(b.FromName), b.Subject,
			ns(b.HTMLBody), ns(b.TextBody), attJSON)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Failed to save draft")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func mailGetDraft(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if id <= 0 {
			respondErr(w, 400, "invalid id")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, subject, to_addrs, cc_addrs, bcc_addrs, from_email, from_name,
			       html_body, text_body, attachments, updated_at, created_at
			FROM mail_drafts
			WHERE id=$1 AND user_id=$2`, id, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "draft not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func mailDeleteDraft(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if id <= 0 {
			respondErr(w, 400, "invalid id")
			return
		}
		user := core.UserFromCtx(r.Context())
		if _, err := db.PGExec(r.Context(),
			`DELETE FROM mail_drafts WHERE id=$1 AND user_id=$2`, id, user.ID); err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// ── Signature handlers ────────────────────────────────────────────────────────

func mailGetSignature(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			SELECT signature_html, signature_text, updated_at
			FROM user_email_signatures WHERE user_id=$1`, user.ID)
		if err != nil || len(rows) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
				"signature_html": "",
				"signature_text": "",
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func mailSaveSignature(db *core.DB) http.HandlerFunc {
	type body struct {
		SignatureHTML string `json:"signature_html"`
		SignatureText string `json:"signature_text"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		user := core.UserFromCtx(r.Context())
		_, err := db.PGExec(r.Context(), `
			INSERT INTO user_email_signatures (user_id, signature_html, signature_text)
			VALUES ($1,$2,$3)
			ON CONFLICT (user_id) DO UPDATE SET
			    signature_html=EXCLUDED.signature_html,
			    signature_text=EXCLUDED.signature_text,
			    updated_at=NOW()`,
			user.ID, ns(b.SignatureHTML), ns(b.SignatureText))
		if err != nil {
			respondErr(w, 500, "Failed to save signature")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"ok": true}) //nolint:errcheck
	}
}

// ── Attachment upload ─────────────────────────────────────────────────────────

func mailUploadAttachment(_ *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check R2 configuration
		accountID := os.Getenv("R2_ACCOUNT_ID")
		bucketName := os.Getenv("R2_BUCKET_NAME")
		accessKey := os.Getenv("R2_ACCESS_KEY_ID")
		secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")

		r2Configured := accountID != "" && bucketName != "" && accessKey != "" && secretKey != ""

		if err := r.ParseMultipartForm(25 << 20); err != nil {
			respondErr(w, 400, "Failed to parse multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "field 'file' is required")
			return
		}
		defer file.Close()

		data, err := io.ReadAll(file)
		if err != nil {
			respondErr(w, 500, "Failed to read file")
			return
		}

		contentType := header.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		filename := sanitizeAttachmentName(header.Filename)
		uid := fmt.Sprintf("%d", time.Now().UnixNano())

		if r2Configured {
			objectKey := fmt.Sprintf("mail-attachments/%s/%s", uid, filename)
			endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s",
				accountID, bucketName, objectKey)

			// Public URL uses R2_PUBLIC_BASE_URL (same pattern as campaign image uploads).
			publicBase := strings.TrimRight(os.Getenv("R2_PUBLIC_BASE_URL"), "/")
			var pubURL string
			if publicBase != "" {
				pubURL = publicBase + "/" + objectKey
			} else {
				slog.Warn("mailUploadAttachment: R2_PUBLIC_BASE_URL not set; falling back to S3 API endpoint for attachment URL")
				pubURL = endpoint
			}

			if err := r2Put(endpoint, accessKey, secretKey, accountID, bucketName, objectKey, contentType, data); err != nil {
				slog.Warn("R2 upload failed", "err", err)
				respondErr(w, 502, "File upload to R2 failed: "+err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"url":          pubURL,
				"filename":     filename,
				"content_type": contentType,
				"size_bytes":   len(data),
			})
			return
		}

		// Fallback: local storage
		dir := fmt.Sprintf("/tmp/mail-attachments/%s", uid)
		if err := os.MkdirAll(dir, 0755); err != nil {
			respondErr(w, 500, "Storage error")
			return
		}
		dest := fmt.Sprintf("%s/%s", dir, filename)
		if err := os.WriteFile(dest, data, 0644); err != nil {
			respondErr(w, 500, "Write error")
			return
		}
		localURL := fmt.Sprintf("/api/mail/attachments/%s/%s", uid, filename)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"url":          localURL,
			"filename":     filename,
			"content_type": contentType,
			"size_bytes":   len(data),
		})
	}
}

// r2Put uploads a file using AWS Signature V4 to an R2 bucket.
func r2Put(endpoint, accessKey, secretKey, accountID, bucket, objectKey, contentType string, data []byte) error {
	now := time.Now().UTC()
	dateShort := now.Format("20060102")
	dateLong := now.Format("20060102T150405Z")
	region := "auto"
	service := "s3"

	// Step 1: canonical request
	payloadHash := fmt.Sprintf("%x", sha256Sum(data))
	headers := fmt.Sprintf("content-type:%s\nhost:%s.r2.cloudflarestorage.com\nx-amz-content-sha256:%s\nx-amz-date:%s\n",
		contentType, accountID, payloadHash, dateLong)
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"
	canonicalURI := "/" + bucket + "/" + objectKey
	canonical := strings.Join([]string{
		"PUT", canonicalURI, "", headers, signedHeaders, payloadHash,
	}, "\n")

	// Step 2: string to sign
	credScope := strings.Join([]string{dateShort, region, service, "aws4_request"}, "/")
	strToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", dateLong, credScope, fmt.Sprintf("%x", sha256Sum([]byte(canonical))),
	}, "\n")

	// Step 3: signing key
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateShort))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := fmt.Sprintf("%x", hmacSHA256(kSigning, []byte(strToSign)))

	authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s,SignedHeaders=%s,Signature=%s",
		accessKey, credScope, signedHeaders, signature)

	req, err := http.NewRequest(http.MethodPut, endpoint, strings.NewReader(string(data)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-amz-date", dateLong)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("Authorization", authHeader)
	req.ContentLength = int64(len(data))

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("R2 returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func sha256Sum(data []byte) []byte {
	h := sha256.Sum256(data)
	return h[:]
}

// jsonOrEmpty returns the JSON bytes as a string, or "[]" if nil/empty.
func jsonOrEmpty(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "[]"
	}
	return string(raw)
}

// hmacSHA256 computes HMAC-SHA256 of data with key.
func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

// ── Thread reply endpoints ─────────────────────────────────────────────────────

func listMessageReplies(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if id <= 0 {
			respondErr(w, 400, "invalid id")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, from_email, from_name, subject, body_text, body_html,
			       is_read, received_at, message_id, in_reply_to
			FROM inbound_mail
			WHERE mail_message_id=$1
			ORDER BY received_at ASC`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		// Mark all replies as read now that the thread is being viewed
		_, _ = db.PGExec(r.Context(), `UPDATE inbound_mail SET is_read=true WHERE mail_message_id=$1`, id)
		jsonRows(w, rows)
	}
}

func replyToMessage(db *core.DB) http.HandlerFunc {
	type reqBody struct {
		HTMLBody string        `json:"html_body"`
		TextBody string        `json:"text_body"`
		CC       []MailAddress `json:"cc"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if id <= 0 {
			respondErr(w, 400, "invalid id")
			return
		}
		var b reqBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.HTMLBody) == "" && strings.TrimSpace(b.TextBody) == "" {
			respondErr(w, 422, "html_body or text_body is required")
			return
		}
		// Load original message
		orig, err := db.PGQuery(r.Context(), `
			SELECT id, subject, recipients, from_email, from_name, created_by
			FROM mail_messages WHERE id=$1`, id)
		if err != nil || len(orig) == 0 {
			respondErr(w, 404, "message not found")
			return
		}
		user := core.UserFromCtx(r.Context())
		// Ownership check: user must be the sender or appear in the recipients list.
		msg := orig[0]
		isOwner := toInt64(msg["created_by"]) == user.ID ||
			strings.Contains(str(msg["recipients"]), user.Sub)
		if !isOwner {
			respondErr(w, 403, "You do not have access to this message thread")
			return
		}
		// Reply to most recent inbound sender, or fall back to original TO recipient
		replyTo := firstToAddress(orig[0]["recipients"])
		if latest, _ := db.PGQuery(r.Context(), `
			SELECT from_email, from_name FROM inbound_mail
			WHERE mail_message_id=$1 ORDER BY received_at DESC LIMIT 1`, id); len(latest) > 0 {
			replyTo = MailAddress{Email: str(latest[0]["from_email"]), Name: str(latest[0]["from_name"])}
		}
		subject := str(orig[0]["subject"])
		if !strings.HasPrefix(strings.ToLower(subject), "re:") {
			subject = "Re: " + subject
		}
		res := SendMail(r.Context(), db, SendMailOptions{
			To:                 []MailAddress{replyTo},
			CC:                 b.CC,
			Subject:            subject,
			HTMLBody:           b.HTMLBody,
			TextBody:           b.TextBody,
			ReplyToEmail:       user.Sub,
			ReplyToName:        user.FullName,
			Kind:               "single",
			Category:           "single",
			CreatedBy:          user.ID,
			SendCopyToSender:   true,
			SenderCopyEmail:    user.Sub,
			SenderCopyName:     user.FullName,
			SendViaUserMailbox: true,
		})
		if !res.OK {
			slog.Warn("Reply send failed", "user_id", user.ID, "error", res.Error)
			respondErr(w, 502, res.Error)
			return
		}
		// Link reply to parent thread
		if res.MailID > 0 {
			_, _ = db.PGExec(r.Context(), `UPDATE mail_messages SET parent_id=$1 WHERE id=$2`, id, res.MailID)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(res) //nolint:errcheck
	}
}

func listMessageEvents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if id <= 0 {
			respondErr(w, 400, "invalid id")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, event_type, event_data, occurred_at
			FROM mail_events
			WHERE mail_message_id=$1
			ORDER BY occurred_at ASC`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func markInboundRead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}
		id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if id <= 0 {
			respondErr(w, 400, "invalid id")
			return
		}
		user := core.UserFromCtx(r.Context())
		_, _ = db.PGExec(r.Context(), `
			UPDATE inbound_mail SET is_read=true
			WHERE id=$1
			  AND (mail_message_id IS NULL
			       OR mail_message_id IN (
			           SELECT id FROM mail_messages
			           WHERE created_by=$2 OR recipients::text ILIKE $3))`,
			id, user.ID, "%"+user.Sub+"%")
		w.WriteHeader(http.StatusNoContent)
	}
}

func firstToAddress(raw any) MailAddress {
	var payload map[string][]map[string]string
	switch v := raw.(type) {
	case []byte:
		json.Unmarshal(v, &payload) //nolint:errcheck
	case string:
		json.Unmarshal([]byte(v), &payload) //nolint:errcheck
	}
	for _, item := range payload["to"] {
		if email := strings.TrimSpace(item["email"]); email != "" {
			return MailAddress{Email: email, Name: item["name"]}
		}
	}
	return MailAddress{}
}
