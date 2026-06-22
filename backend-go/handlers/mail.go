package handlers

import (
	"context"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
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

func RegisterMail(r chi.Router, db *core.DB) {
	if err := ensureMailSchema(context.Background(), db); err != nil {
		slog.Warn("Mail schema setup failed", "err", err)
	}
	access := core.RequirePages("campaigns", "crm_contacts", "customer_service")
	admin  := core.RequirePages("admin_api_keys")
	r.With(access).Post("/send", sendSingleMail(db))
	r.With(access).Get("/messages", listMailMessages(db))
	r.With(access).Get("/messages/{id}", getMailMessage(db))
	r.With(access).Get("/inbox", listInboundMail(db))
	r.With(admin).Get("/metrics", mailMetrics(db))
	r.With(admin).Get("/deliverability", mailDeliverability(db))
	r.With(admin).Post("/test", mailSendTest(db))
	r.With(admin).Get("/suppressions", mailListSuppressions(db))
	r.With(admin).Delete("/suppressions/{email}", mailRemoveSuppression(db))
	// Drafts
	r.With(access).Get("/drafts",         mailListDrafts(db))
	r.With(access).Post("/drafts",        mailSaveDraft(db))
	r.With(access).Get("/drafts/{id}",    mailGetDraft(db))
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
	r.Post("/inbound", mailInboundParse(db))
}

// mailInboundParse handles SendGrid Inbound Parse webhook (multipart/form-data).
// Configure SendGrid: Settings → Inbound Parse → add your domain's MX → webhook URL = /api/mail/inbound
func mailInboundParse(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			w.WriteHeader(200) // always 200 to SendGrid or it retries
			return
		}
		fromRaw := r.FormValue("from")
		// Extract name and email from "Name <email>" format
		fromName, fromEmail := "", fromRaw
		if i := strings.Index(fromRaw, "<"); i >= 0 {
			fromName = strings.TrimSpace(fromRaw[:i])
			fromEmail = strings.Trim(fromRaw[i+1:], "> ")
		}
		subject  := r.FormValue("subject")
		bodyText := r.FormValue("text")
		bodyHTML := r.FormValue("html")
		to       := r.FormValue("to")
		if fromEmail == "" {
			w.WriteHeader(200)
			return
		}
		if err := ensureMailSchema(r.Context(), db); err == nil {
			db.PGExec(r.Context(), `
				INSERT INTO inbound_mail (from_email, from_name, to_email, subject, body_text, body_html)
				VALUES ($1,$2,$3,$4,$5,$6)`,
				fromEmail, fromName, to, subject, bodyText, bodyHTML)
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
		limit := qint(r, "limit", 100, 1, 500)
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, from_email, from_name, to_email, subject,
			       body_text, body_html, is_read, received_at
			FROM inbound_mail
			ORDER BY received_at DESC
			LIMIT $1`, limit)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func sendSingleMail(db *core.DB) http.HandlerFunc {
	type urlAttachment struct {
		URL         string `json:"url"`
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
	}
	type body struct {
		To               []MailAddress   `json:"to"`
		CC               []MailAddress   `json:"cc"`
		BCC              []MailAddress   `json:"bcc"`
		Subject          string          `json:"subject"`
		HTMLBody         string          `json:"html_body"`
		TextBody         string          `json:"text_body"`
		FromAddress      string          `json:"from_address"`
		FromName         string          `json:"from_name"`
		SendAt           string          `json:"send_at"`
		URLAttachments   []urlAttachment `json:"attachments"`
		SendCopyToSender *bool           `json:"send_copy_to_sender"`
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
		user := core.UserFromCtx(r.Context())
		copyToSender := true
		if b.SendCopyToSender != nil {
			copyToSender = *b.SendCopyToSender
		}
		fromEmail := coalesce(b.FromAddress, user.Sub)
		fromName  := coalesce(b.FromName, user.FullName)
		// URL-based attachments (already uploaded to R2 / local storage)
		// are stored as metadata only — we don't re-encode them for SendGrid here.
		// They are stored in mail_messages.attachments for record keeping.
		urlAtts := make([]MailAttachment, 0, len(b.URLAttachments))
		for _, a := range b.URLAttachments {
			urlAtts = append(urlAtts, MailAttachment{
				Filename:    a.Name,
				ContentType: a.ContentType,
				Disposition: "attachment",
			})
		}
		res := SendMail(r.Context(), db, SendMailOptions{
			To:               b.To,
			CC:               b.CC,
			BCC:              b.BCC,
			Subject:          b.Subject,
			HTMLBody:         b.HTMLBody,
			TextBody:         b.TextBody,
			FromEmail:        fromEmail,
			FromName:         fromName,
			Category:         "single",
			Kind:             "single",
			CreatedBy:        user.ID,
			SendCopyToSender: copyToSender,
			SenderCopyEmail:  user.Sub,
			SenderCopyName:   user.FullName,
			Attachments:      urlAtts,
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
			WHERE created_by=$1 OR recipients::text ILIKE $2
			ORDER BY created_at DESC
			LIMIT $3`, user.ID, "%"+user.Sub+"%", limit)
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
		// Platform-wide totals (admin view)
		rows, err := db.PGQuery(r.Context(), `
			SELECT status, kind, COUNT(*) AS count
			FROM mail_messages
			GROUP BY status, kind
			ORDER BY kind, status`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
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
			HTMLBody: `<p>This is a test email sent from the <strong>O3C Cards Mail Health</strong> dashboard.</p>
<p>If you received this, your SendGrid integration is working correctly.</p>`,
			TextBody:   "This is a test email from O3C Cards Mail Health. If you received this, your SendGrid integration is working.",
			CreatedBy:  user.ID,
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
		mailID, _ := strconv.ParseInt(r.URL.Query().Get("mail_id"), 10, 64)
		if mailID <= 0 {
			http.Error(w, "Invalid unsubscribe link", http.StatusBadRequest)
			return
		}
		rows, _ := db.PGQuery(r.Context(), `SELECT recipients FROM mail_messages WHERE id=$1`, mailID)
		if len(rows) == 0 {
			http.Error(w, "Message not found", http.StatusNotFound)
			return
		}
		email := firstRecipientEmail(rows[0]["recipients"])
		if email == "" {
			http.Error(w, "Recipient not found", http.StatusNotFound)
			return
		}
		addSuppression(r.Context(), db, email, "unsubscribed", "unsubscribe_link")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("You have been unsubscribed from future campaign emails.")) //nolint:errcheck
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

	mailID := createMailMessage(ctx, db, opt)
	if opt.Kind == "campaign" {
		opt.HTMLBody = appendUnsubscribeHTML(ctx, db, opt.HTMLBody, mailID)
		opt.TextBody = appendUnsubscribeText(ctx, db, opt.TextBody, mailID)
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
	// Add List-Unsubscribe headers for notification mail (required by Gmail bulk sender policy)
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
		<p>Your O3C Cards portal password has been reset.</p>
		<p><strong>Temporary password:</strong> <code>%s</code></p>
		<p>Please sign in and change it immediately.</p>
		<p>If you did not request this reset, contact your administrator.</p>`,
		escapeMailHTML(coalesce(name, "there")), escapeMailHTML(tempPassword))
	text := fmt.Sprintf("Hello %s,\n\nYour O3C Cards portal password has been reset.\nTemporary password: %s\n\nPlease sign in and change it immediately.\nIf you did not request this reset, contact your administrator.",
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
		  from_email  TEXT NOT NULL,
		  from_name   TEXT,
		  to_email    TEXT,
		  subject     TEXT NOT NULL DEFAULT '',
		  body_text   TEXT,
		  body_html   TEXT,
		  raw_headers TEXT,
		  is_read     BOOLEAN NOT NULL DEFAULT false,
		  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_inbound_mail_received ON inbound_mail(received_at DESC)`,
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

func appendUnsubscribeHTML(ctx context.Context, db *core.DB, html string, mailID int64) string {
	if mailID <= 0 {
		return html
	}
	link := unsubscribeURL(ctx, db, mailID)
	if link == "" {
		return html
	}
	footer := fmt.Sprintf(`<p style="margin-top:24px;font-size:12px;color:#64748b;">You are receiving this email from O3C Cards. <a href="%s" style="color:#0E2841;">Unsubscribe</a></p>`, escapeMailHTML(link))
	return html + footer
}

func appendUnsubscribeText(ctx context.Context, db *core.DB, text string, mailID int64) string {
	link := unsubscribeURL(ctx, db, mailID)
	if link == "" {
		return text
	}
	return strings.TrimSpace(text) + "\n\nUnsubscribe: " + link
}

func unsubscribeURL(ctx context.Context, db *core.DB, mailID int64) string {
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
	mailID := createMailMessage(ctx, db, opt)
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
		updateMailMessageStatus(ctx, db, mailID, "failed", "", err.Error())
		return SendMailResult{MailID: mailID, Error: err.Error()}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	providerID := "graph:" + fmt.Sprintf("%d", mailID)
	if resp.StatusCode == http.StatusAccepted {
		updateMailMessageStatus(ctx, db, mailID, "queued", providerID, "")
		return SendMailResult{OK: true, ProviderID: providerID, MailID: mailID}
	}
	msg := strings.TrimSpace(string(respBody))
	if msg == "" {
		msg = fmt.Sprintf("Microsoft Graph HTTP %d", resp.StatusCode)
	}
	slog.Warn("Microsoft Graph mail send failed", "status", resp.StatusCode, "body", msg, "mail_id", mailID)
	updateMailMessageStatus(ctx, db, mailID, "failed", providerID, msg)
	return SendMailResult{MailID: mailID, ProviderID: providerID, Error: msg}
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
			WHERE id=$1 AND (created_by=$2 OR recipients::text ILIKE $3)`,
			id, user.ID, "%"+user.Sub+"%")
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
		toJSON   := jsonOrEmpty(b.ToAddrs)
		ccJSON   := jsonOrEmpty(b.CcAddrs)
		bccJSON  := jsonOrEmpty(b.BccAddrs)
		attJSON  := jsonOrEmpty(b.Attachments)

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
		accountID  := os.Getenv("R2_ACCOUNT_ID")
		bucketName := os.Getenv("R2_BUCKET_NAME")
		accessKey  := os.Getenv("R2_ACCESS_KEY_ID")
		secretKey  := os.Getenv("R2_SECRET_ACCESS_KEY")

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
			endpoint  := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s",
				accountID, bucketName, objectKey)
			pubURL := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s",
				accountID, bucketName, objectKey)

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
	dateLong  := now.Format("20060102T150405Z")
	region    := "auto"
	service   := "s3"

	// Step 1: canonical request
	payloadHash := fmt.Sprintf("%x", sha256Sum(data))
	headers := fmt.Sprintf("content-type:%s\nhost:%s.r2.cloudflarestorage.com\nx-amz-content-sha256:%s\nx-amz-date:%s\n",
		contentType, accountID, payloadHash, dateLong)
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"
	canonicalURI  := "/" + bucket + "/" + objectKey
	canonical := strings.Join([]string{
		"PUT", canonicalURI, "", headers, signedHeaders, payloadHash,
	}, "\n")

	// Step 2: string to sign
	credScope := strings.Join([]string{dateShort, region, service, "aws4_request"}, "/")
	strToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", dateLong, credScope, fmt.Sprintf("%x", sha256Sum([]byte(canonical))),
	}, "\n")

	// Step 3: signing key
	kDate    := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateShort))
	kRegion  := hmacSHA256(kDate, []byte(region))
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
