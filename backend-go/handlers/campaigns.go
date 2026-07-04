package handlers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
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

// hrefRE matches href="http(s)://..." in email HTML bodies for click-tracking rewrites.
var hrefRE = regexp.MustCompile(`href="(https?://[^"]+)"`)

// ── Config ────────────────────────────────────────────────────────────────────

var (
	termiiSenderID           = coalesce(os.Getenv("TERMII_SENDER_ID"), "O3CCARDS")
	sendgridFromEmail        = os.Getenv("SENDGRID_FROM_EMAIL")
	sendgridFromName         = coalesce(os.Getenv("SENDGRID_FROM_NAME"), "Care")
	smsWebhookSecret         = os.Getenv("SMS_WEBHOOK_SECRET")
	emailWebhookSecret       = os.Getenv("EMAIL_WEBHOOK_SECRET")
	sendgridWebhookPublicKey = os.Getenv("SENDGRID_WEBHOOK_PUBLIC_KEY")
	campaignDispatchWorkers  sync.Map
)

// resolveCredKey returns the credential value: env var first, then DB-stored (encrypted).
func resolveCredKey(ctx context.Context, db *core.DB, envKey string) string {
	if v := os.Getenv(envKey); v != "" {
		return v
	}
	rows, _ := db.PGQuery(ctx, `SELECT encrypted_value FROM api_credentials WHERE key_name=$1`, envKey)
	if len(rows) == 0 {
		return ""
	}
	enc, _ := rows[0]["encrypted_value"].(string)
	plain, _ := decryptValue(enc)
	return plain
}

var mergePlaceholderRE = regexp.MustCompile(`\{\{[^}]+\}\}`)

// renderTemplate substitutes {{key}} merge tags. Unknown tags are stripped.
func renderTemplate(tmpl string, data map[string]any) string {
	if tmpl == "" || data == nil {
		return mergePlaceholderRE.ReplaceAllString(tmpl, "")
	}
	for k, v := range data {
		tmpl = strings.ReplaceAll(tmpl, "{{"+k+"}}", fmt.Sprintf("%v", v))
	}
	return mergePlaceholderRE.ReplaceAllString(tmpl, "")
}

func campaignContactMergeData(c map[string]any) map[string]any {
	mergeData := map[string]any{}
	switch raw := c["merge_data"].(type) {
	case []byte:
		json.Unmarshal(raw, &mergeData) //nolint:errcheck
	case string:
		json.Unmarshal([]byte(raw), &mergeData) //nolint:errcheck
	case map[string]any:
		for k, v := range raw {
			mergeData[k] = v
		}
	}
	if mergeData == nil {
		mergeData = map[string]any{}
	}
	firstName := str(c["first_name"])
	lastName := str(c["last_name"])
	name := strings.TrimSpace(firstName + " " + lastName)
	mergeData["first_name"] = firstName
	mergeData["last_name"] = lastName
	mergeData["name"] = name
	mergeData["full_name"] = name
	mergeData["phone"] = str(c["phone"])
	mergeData["email"] = str(c["email"])
	mergeData["cif_number"] = str(c["cif_number"])
	return mergeData
}

// ── Provider functions ────────────────────────────────────────────────────────

func sendSMS(ctx context.Context, db *core.DB, phone, body string) (ok bool, providerID string) {
	apiKey := resolveCredKey(ctx, db, "TERMII_API_KEY")
	if apiKey == "" {
		return false, "TERMII_API_KEY not configured"
	}
	senderID := coalesce(resolveCredKey(ctx, db, "TERMII_SENDER_ID"), termiiSenderID)
	payload, _ := json.Marshal(map[string]any{
		"api_key": apiKey,
		"to":      phone,
		"from":    senderID,
		"sms":     body,
		"type":    "plain",
		"channel": "generic",
	})
	resp, err := httpPost("https://api.ng.termii.com/api/sms/send", "application/json", "", payload, 15*time.Second)
	if err != nil {
		return false, err.Error()
	}
	defer resp.Body.Close()
	var d map[string]any
	json.NewDecoder(resp.Body).Decode(&d) //nolint:errcheck
	if resp.StatusCode == 200 && str(d["code"]) == "ok" {
		return true, str(d["message_id"])
	}
	return false, str(d["message"])
}

func sendEmail(ctx context.Context, db *core.DB, toEmail, toName, fromEmail, fromName, subject, htmlBody, textBody, contactRef string) (ok bool, providerID string) {
	res := SendMail(ctx, db, SendMailOptions{
		To:        []MailAddress{{Email: toEmail, Name: toName}},
		FromEmail: fromEmail,
		FromName:  fromName,
		Subject:   subject,
		HTMLBody:  htmlBody,
		TextBody:  textBody,
		Category:  "campaign",
		Kind:      "campaign",
		CustomArgs: map[string]string{
			"o3c_contact_id": contactRef,
		},
	})
	if !res.OK {
		return false, res.Error
	}
	return true, res.ProviderID
}

func publicAppURL() string {
	base := strings.TrimRight(strings.TrimSpace(firstNonEmpty(
		os.Getenv("APP_URL"),
		os.Getenv("APP_BASE_URL"),
		os.Getenv("RAILWAY_PUBLIC_DOMAIN"),
	)), "/")
	if base != "" && !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}
	return base
}

func httpPost(url, contentType, auth string, body []byte, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	return (&http.Client{Timeout: timeout}).Do(req)
}

func intSetting(ctx context.Context, db *core.DB, key string, fallback int) int {
	rows, err := db.PGQuery(ctx, `SELECT value FROM settings WHERE key=$1`, key)
	if err != nil || len(rows) == 0 {
		return fallback
	}
	v, err := strconv.Atoi(str(rows[0]["value"]))
	if err != nil {
		return fallback
	}
	return v
}

func boolSetting(ctx context.Context, db *core.DB, key string, fallback bool) bool {
	rows, err := db.PGQuery(ctx, `SELECT value FROM settings WHERE key=$1`, key)
	if err != nil || len(rows) == 0 {
		return fallback
	}
	s := strings.ToLower(strings.TrimSpace(str(rows[0]["value"])))
	if s == "" {
		return fallback
	}
	return s == "true" || s == "1" || s == "yes" || s == "on"
}

func campaignMailSentToday(ctx context.Context, db *core.DB) int {
	rows, err := db.PGQuery(ctx, `
		SELECT COUNT(*) AS n
		FROM mail_messages
		WHERE kind='campaign' AND created_at::date=CURRENT_DATE
		  AND status NOT IN ('failed')`)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return int(toInt64(rows[0]["n"]))
}

func campaignEmailSentToday(ctx context.Context, db *core.DB, campaignID int64) int {
	rows, err := db.PGQuery(ctx, `
		SELECT COUNT(*) AS n
		FROM campaign_contacts
		WHERE campaign_id=$1
		  AND email_sent_at::date=CURRENT_DATE
		  AND email_status NOT IN ('failed','skipped')`, campaignID)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return int(toInt64(rows[0]["n"]))
}

func effectiveCampaignDailyLimit(ctx context.Context, db *core.DB) int {
	limit := intSetting(ctx, db, "campaign_daily_email_limit", 5000)
	if boolSetting(ctx, db, "campaign_warmup_mode_enabled", true) {
		warmup := intSetting(ctx, db, "campaign_warmup_daily_email_limit", 1000)
		if warmup > 0 && (limit == 0 || warmup < limit) {
			return warmup
		}
	}
	return limit
}

func acquireCampaignDispatchLock(ctx context.Context, db *core.DB, campaignID int64) bool {
	rows, err := db.PGQuery(ctx, `
		UPDATE campaigns
		SET dispatch_lock_until=NOW() + INTERVAL '15 minutes', updated_at=NOW()
		WHERE id=$1 AND (dispatch_lock_until IS NULL OR dispatch_lock_until < NOW())
		RETURNING id`, campaignID)
	return err == nil && len(rows) > 0
}

func refreshCampaignDispatchLock(ctx context.Context, db *core.DB, campaignID int64) {
	_, _ = db.PGExec(ctx, `UPDATE campaigns SET dispatch_lock_until=NOW() + INTERVAL '15 minutes' WHERE id=$1`, campaignID)
}

func releaseCampaignDispatchLock(ctx context.Context, db *core.DB, campaignID int64) {
	_, _ = db.PGExec(ctx, `UPDATE campaigns SET dispatch_lock_until=NULL WHERE id=$1`, campaignID)
}

// ── Background dispatch ───────────────────────────────────────────────────────

func startDispatch(db *core.DB, campaignID int64) {
	if _, loaded := campaignDispatchWorkers.LoadOrStore(campaignID, true); loaded {
		slog.Info("Campaign dispatch already running", "id", campaignID)
		return
	}
	go func() {
		defer campaignDispatchWorkers.Delete(campaignID)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
		defer cancel()
		if !acquireCampaignDispatchLock(ctx, db, campaignID) {
			slog.Info("Campaign dispatch lock is already held", "id", campaignID)
			return
		}
		defer releaseCampaignDispatchLock(context.Background(), db, campaignID)

		campRows, err := db.PGQuery(ctx, "SELECT * FROM campaigns WHERE id=$1", campaignID)
		if err != nil || len(campRows) == 0 {
			return
		}
		camp := campRows[0]
		if str(camp["status"]) != "active" {
			return
		}
		isSMS := str(camp["type"]) == "sms" || str(camp["type"]) == "multi"
		isEmail := str(camp["type"]) == "email" || str(camp["type"]) == "multi"
		sendDelay := time.Duration(intSetting(ctx, db, "campaign_send_delay_ms", 250)) * time.Millisecond
		dailyLimit := effectiveCampaignDailyLimit(ctx, db)
		perCampaignDailyLimit := intSetting(ctx, db, "campaign_per_campaign_daily_email_limit", 5000)

		contactRows, err := db.PGQuery(ctx, `
			SELECT * FROM campaign_contacts
			WHERE campaign_id=$1
			  AND (($2 AND sms_status='pending') OR ($3 AND email_status='pending'))
			ORDER BY position ASC`, campaignID, isSMS, isEmail)
		if err != nil {
			slog.Error("Campaign dispatch: contacts query failed", "id", campaignID, "err", err)
			return
		}

		for _, c := range contactRows {
			refreshCampaignDispatchLock(ctx, db, campaignID)
			// Check if paused
			stRow, _ := db.PGQuery(ctx, "SELECT status FROM campaigns WHERE id=$1", campaignID)
			if len(stRow) > 0 && str(stRow[0]["status"]) != "active" {
				slog.Info("Campaign dispatch stopped", "id", campaignID, "status", str(stRow[0]["status"]))
				return
			}

			mergeData := campaignContactMergeData(c)
			firstName := str(c["first_name"])
			lastName := str(c["last_name"])
			name := strings.TrimSpace(firstName + " " + lastName)
			if name == "" {
				name = "Customer"
			}
			cid := toInt64(c["id"])

			if isSMS && str(c["sms_status"]) == "pending" && str(c["phone"]) != "" {
				claimed, _ := db.PGQuery(ctx, `
					UPDATE campaign_contacts
					SET sms_status='sending', updated_at=NOW()
					WHERE id=$1 AND sms_status='pending'
					RETURNING id`, cid)
				if len(claimed) > 0 {
					body := renderTemplate(str(camp["sms_body"]), mergeData)
					ok, pid := sendSMS(ctx, db, str(c["phone"]), body)
					smsStatus := "sent"
					smsCol := "sms_sent"
					if !ok {
						smsStatus = "failed"
						smsCol = "sms_failed"
					}
					db.PGExec(ctx, //nolint:errcheck
						`UPDATE campaign_contacts SET sms_status=$1, sms_provider_id=$2, sms_sent_at=NOW(), updated_at=NOW() WHERE id=$3`,
						smsStatus, pid, cid)
					db.PGExec(ctx, //nolint:errcheck
						fmt.Sprintf("UPDATE campaigns SET %s=%s+1, updated_at=NOW() WHERE id=$1", smsCol, smsCol), campaignID)
				}
			}

			if isEmail && str(c["email_status"]) == "pending" && str(c["email"]) != "" {
				if dailyLimit > 0 && campaignMailSentToday(ctx, db) >= dailyLimit {
					db.PGExec(ctx, "UPDATE campaigns SET status='paused', pause_reason='daily_limit', paused_until=date_trunc('day', NOW()) + INTERVAL '1 day', updated_at=NOW() WHERE id=$1", campaignID) //nolint:errcheck
					slog.Info("Campaign paused because daily email limit was reached", "id", campaignID, "limit", dailyLimit)
					return
				}
				if perCampaignDailyLimit > 0 && campaignEmailSentToday(ctx, db, campaignID) >= perCampaignDailyLimit {
					db.PGExec(ctx, "UPDATE campaigns SET status='paused', pause_reason='daily_limit', paused_until=date_trunc('day', NOW()) + INTERVAL '1 day', updated_at=NOW() WHERE id=$1", campaignID) //nolint:errcheck
					slog.Info("Campaign paused because per-campaign daily email limit was reached", "id", campaignID, "limit", perCampaignDailyLimit)
					return
				}
				claimed, _ := db.PGQuery(ctx, `
					UPDATE campaign_contacts
					SET email_status='sending', updated_at=NOW()
					WHERE id=$1 AND email_status='pending'
					RETURNING id`, cid)
				if len(claimed) == 0 {
					continue
				}
				subject := renderTemplate(str(camp["email_subject"]), mergeData)
				htmlBody := renderTemplate(str(camp["email_body_html"]), mergeData)
				textBody := renderTemplate(str(camp["email_body_text"]), mergeData)

				// Inject click-tracking and open-pixel if the public app URL and tracking_id are set.
				trackingID := str(c["tracking_id"])
				appURL := publicAppURL()
				if appURL != "" && trackingID != "" {
					// Wrap all href="https?://..." links with the click-tracking redirect.
					htmlBody = hrefRE.ReplaceAllStringFunc(htmlBody, func(match string) string {
						sub := hrefRE.FindStringSubmatch(match)
						if len(sub) < 2 {
							return match
						}
						return fmt.Sprintf(`href="%s/t/c/%s?url=%s"`, appURL, trackingID, url.QueryEscape(sub[1]))
					})
					// Inject 1×1 open-tracking pixel before </body> (or append if absent).
					pixel := fmt.Sprintf(
						`<img src="%s/t/o/%s.gif" width="1" height="1" alt="" style="display:none;border:0;height:1px;width:1px;">`,
						appURL, trackingID)
					if strings.Contains(htmlBody, "</body>") {
						htmlBody = strings.Replace(htmlBody, "</body>", pixel+"</body>", 1)
					} else {
						htmlBody += pixel
					}
				}

				ok, pid := sendEmail(
					ctx, db,
					str(c["email"]), name,
					str(camp["from_email"]), str(camp["from_name"]),
					subject, htmlBody, textBody, fmt.Sprintf("%d", cid),
				)
				emailStatus := "queued"
				emailCol := "emails_sent"
				if !ok {
					emailStatus = "failed"
					emailCol = "emails_bounced"
				}
				db.PGExec(ctx, //nolint:errcheck
					`UPDATE campaign_contacts SET email_status=$1, email_provider_id=$2, email_sent_at=NOW(), updated_at=NOW() WHERE id=$3`,
					emailStatus, pid, cid)
				db.PGExec(ctx, //nolint:errcheck
					fmt.Sprintf("UPDATE campaigns SET %s=%s+1, updated_at=NOW() WHERE id=$1", emailCol, emailCol), campaignID)
				// Record sent event for analytics timeline.
				db.PGExec(ctx, //nolint:errcheck
					`INSERT INTO campaign_events
					     (campaign_id, contact_id, tracking_id, event_type, channel, provider_msg_id)
					 VALUES ($1, $2, $3, 'sent', 'email', $4)`,
					campaignID, cid, trackingID, pid)
			}

			time.Sleep(sendDelay) // rate-limit provider calls
		}

		db.PGExec(ctx, //nolint:errcheck
			"UPDATE campaigns SET status='completed', pause_reason=NULL, paused_until=NULL, completed_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='active'",
			campaignID)
		slog.Info("Campaign dispatch complete", "id", campaignID)
	}()
}

// ResumeInterruptedCampaigns is called on startup to restart any campaigns that
// were mid-dispatch when the pod last restarted.  It looks for campaigns that
// are still 'active' but have at least one contact record with a NULL sent_at,
// meaning dispatch was interrupted before they were reached.
func ResumeInterruptedCampaigns(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db.PGExec(ctx, `
		UPDATE campaign_contacts cc
		SET sms_status='pending', updated_at=NOW()
		FROM campaigns c
		WHERE c.id=cc.campaign_id AND c.status='active' AND cc.sms_status='sending'`) //nolint:errcheck
	db.PGExec(ctx, `
		UPDATE campaign_contacts cc
		SET email_status='pending', updated_at=NOW()
		FROM campaigns c
		WHERE c.id=cc.campaign_id AND c.status='active' AND cc.email_status='sending'`) //nolint:errcheck
	rows, err := db.PGQuery(ctx, `
		SELECT DISTINCT c.id
		FROM campaigns c
		WHERE c.status = 'active'
		  AND EXISTS (
		      SELECT 1 FROM campaign_contacts cc
		      WHERE cc.campaign_id = c.id
		        AND (cc.sms_status = 'pending' OR cc.email_status = 'pending')
		  )`)
	if err != nil {
		slog.Error("ResumeInterruptedCampaigns: query failed", "err", err)
		return
	}
	for _, row := range rows {
		id := toInt64(row["id"])
		slog.Info("Resuming interrupted campaign", "campaign_id", id)
		startDispatch(db, id)
	}
}

func ScheduleCampaignAutoResume(db *core.DB) {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	resumeDailyLimitCampaigns(db)
	for range ticker.C {
		resumeDailyLimitCampaigns(db)
	}
}

func resumeDailyLimitCampaigns(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if effectiveCampaignDailyLimit(ctx, db) > 0 && campaignMailSentToday(ctx, db) >= effectiveCampaignDailyLimit(ctx, db) {
		return
	}
	rows, err := db.PGQuery(ctx, `
		UPDATE campaigns
		SET status='active', pause_reason=NULL, paused_until=NULL, updated_at=NOW()
		WHERE status='paused'
		  AND pause_reason='daily_limit'
		  AND (paused_until IS NULL OR paused_until <= NOW())
		RETURNING id`)
	if err != nil {
		slog.Error("Campaign auto-resume: query failed", "err", err)
		return
	}
	for _, row := range rows {
		id := toInt64(row["id"])
		if id <= 0 {
			continue
		}
		slog.Info("Auto-resuming campaign paused by daily limit", "campaign_id", id)
		startDispatch(db, id)
	}
}

// ── Route registration ────────────────────────────────────────────────────────

var campaignUpdateCols = []string{
	"name", "description", "email_subject", "email_body_html", "email_body_text",
	"from_name", "from_email", "sms_body", "scheduled_at", "list_id",
}

func RegisterCampaigns(r chi.Router, db *core.DB) {
	// Webhook endpoints are public (no JWT) — registered on the parent router
	// by returning a func the caller can use; handled via main.go.
	// All management endpoints require campaigns page access.
	access := core.RequirePages("campaigns")

	r.With(access).Get("/", listCampaigns(db))
	r.With(access).Get("/preflight", campaignPreflight(db))
	r.With(access).Post("/", createCampaign(db))
	r.With(access).Get("/{id}", getCampaign(db))
	r.With(access).Patch("/{id}", updateCampaign(db))
	r.With(access).Post("/{id}/start", startCampaign(db))
	r.With(access).Post("/{id}/pause", pauseCampaign(db))
	r.With(access).Post("/{id}/cancel", cancelCampaign(db))
	r.With(access).Get("/{id}/contacts", listCampaignContacts(db))
	r.With(access).Post("/{id}/push-to-telemarketing", campaignPushToTelemarketing(db))
}

// RegisterCampaignWebhooks wires public webhook endpoints (no auth required).
func RegisterCampaignWebhooks(r chi.Router, db *core.DB) {
	r.Post("/sms-webhook", smsWebhook(db))
	r.Post("/email-webhook", emailWebhook(db))
}

func campaignPreflight(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		listID := qstr(r, "list_id")
		channel := qstr(r, "type")
		if channel == "" {
			channel = "email"
		}
		if listID == "" {
			respondErr(w, 422, "list_id is required")
			return
		}
		if channel != "email" && channel != "sms" && channel != "multi" {
			respondErr(w, 422, "type must be email, sms, or multi")
			return
		}
		if err := ensureMailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Mail storage setup failed")
			return
		}

		listRows, err := db.PGQuery(r.Context(), "SELECT id, name FROM contact_lists WHERE id=$1", listID)
		if err != nil || len(listRows) == 0 {
			respondErr(w, 404, "Contact list not found")
			return
		}
		row1 := func(query string, args ...any) core.Row {
			rows, _ := db.PGQuery(r.Context(), query, args...)
			if len(rows) == 0 {
				return core.Row{}
			}
			return rows[0]
		}
		total := toInt64(row1(`SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=$1 AND status='active'`, listID)["n"])
		withEmail := toInt64(row1(`SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=$1 AND status='active' AND NULLIF(TRIM(email),'') IS NOT NULL`, listID)["n"])
		withPhone := toInt64(row1(`SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=$1 AND status='active' AND NULLIF(TRIM(phone),'') IS NOT NULL`, listID)["n"])
		invalidEmail := toInt64(row1(`
			SELECT COUNT(*) AS n FROM contact_list_members
			WHERE list_id=$1 AND status='active' AND NULLIF(TRIM(email),'') IS NOT NULL
			  AND TRIM(email) !~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'`, listID)["n"])
		roleEmail := toInt64(row1(`
			SELECT COUNT(*) AS n FROM contact_list_members
			WHERE list_id=$1 AND status='active' AND NULLIF(TRIM(email),'') IS NOT NULL
			  AND LOWER(SPLIT_PART(TRIM(email),'@',1)) IN ('admin','support','info','sales','contact','hello','noreply','no-reply','postmaster','abuse')`, listID)["n"])
		disposableEmail := toInt64(row1(`
			SELECT COUNT(*) AS n FROM contact_list_members
			WHERE list_id=$1 AND status='active' AND NULLIF(TRIM(email),'') IS NOT NULL
			  AND LOWER(SPLIT_PART(TRIM(email),'@',2)) IN ('mailinator.com','tempmail.com','10minutemail.com','guerrillamail.com','yopmail.com')`, listID)["n"])
		suppressed := toInt64(row1(`
			SELECT COUNT(*) AS n
			FROM contact_list_members m
			JOIN mail_suppressions s ON LOWER(TRIM(s.email))=LOWER(TRIM(m.email)) AND s.is_active=true
			WHERE m.list_id=$1 AND m.status='active' AND NULLIF(TRIM(m.email),'') IS NOT NULL`, listID)["n"])
		dupeRows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(SUM(n - 1),0) AS duplicate_rows, COUNT(*) AS duplicate_groups
			FROM (
			  SELECT LOWER(TRIM(email)) AS email, COUNT(*) AS n
			  FROM contact_list_members
			  WHERE list_id=$1 AND status='active' AND NULLIF(TRIM(email),'') IS NOT NULL
			  GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1
			) d`, listID)
		duplicateRows := int64(0)
		duplicateGroups := int64(0)
		if len(dupeRows) > 0 {
			duplicateRows = toInt64(dupeRows[0]["duplicate_rows"])
			duplicateGroups = toInt64(dupeRows[0]["duplicate_groups"])
		}
		usableEmail := withEmail - suppressed - duplicateRows - invalidEmail
		if usableEmail < 0 {
			usableEmail = 0
		}
		usableSMS := withPhone
		usable := usableEmail
		if channel == "sms" {
			usable = usableSMS
		} else if channel == "multi" {
			usable = usableEmail + usableSMS
		}

		sendDelayMs := intSetting(r.Context(), db, "campaign_send_delay_ms", 100)
		dailyEmailLimit := effectiveCampaignDailyLimit(r.Context(), db)
		estimatedSeconds := int64(0)
		if channel == "email" {
			estimatedSeconds = (usableEmail * int64(sendDelayMs)) / 1000
		} else if channel == "sms" {
			estimatedSeconds = (usableSMS * int64(sendDelayMs)) / 1000
		} else {
			estimatedSeconds = ((usableEmail + usableSMS) * int64(sendDelayMs)) / 1000
		}
		if estimatedSeconds == 0 && usable > 0 {
			estimatedSeconds = 1
		}

		sample, _ := db.PGQuery(r.Context(), `
			SELECT first_name, last_name, email, phone, cif_number
			FROM contact_list_members
			WHERE list_id=$1 AND status='active'
			ORDER BY id ASC
			LIMIT 25`, listID)
		warnings := []string{}
		if channel == "email" || channel == "multi" {
			if total-withEmail > 0 {
				warnings = append(warnings, fmt.Sprintf("%d active contact(s) have no email address", total-withEmail))
			}
			if suppressed > 0 {
				warnings = append(warnings, fmt.Sprintf("%d email recipient(s) are suppressed and will be skipped by the sender", suppressed))
			}
			if duplicateRows > 0 {
				warnings = append(warnings, fmt.Sprintf("%d duplicate email row(s) found across %d duplicate address(es)", duplicateRows, duplicateGroups))
			}
			if invalidEmail > 0 {
				warnings = append(warnings, fmt.Sprintf("%d email address(es) have invalid format and will be skipped", invalidEmail))
			}
			if roleEmail > 0 {
				warnings = append(warnings, fmt.Sprintf("%d role-based email address(es) found; consider removing from promotional campaigns", roleEmail))
			}
			if disposableEmail > 0 {
				warnings = append(warnings, fmt.Sprintf("%d disposable-looking email address(es) found; consider removing before sending", disposableEmail))
			}
			if dailyEmailLimit > 0 && usableEmail > int64(dailyEmailLimit) {
				warnings = append(warnings, fmt.Sprintf("Daily campaign email limit is %d; this run will pause and resume in batches", dailyEmailLimit))
			}
			if boolSetting(r.Context(), db, "campaign_warmup_mode_enabled", true) {
				warnings = append(warnings, fmt.Sprintf("Warmup mode is enabled; effective daily limit is %d", dailyEmailLimit))
			}
			if usableEmail >= 30000 && dailyEmailLimit == 0 {
				warnings = append(warnings, "30,000+ email run with no daily email limit configured")
			}
		}
		if channel == "sms" || channel == "multi" {
			if total-withPhone > 0 {
				warnings = append(warnings, fmt.Sprintf("%d active contact(s) have no phone number", total-withPhone))
			}
		}

		respond(w, map[string]any{
			"list":                    map[string]any{"id": listRows[0]["id"], "name": listRows[0]["name"]},
			"channel":                 channel,
			"total_active":            total,
			"with_email":              withEmail,
			"with_phone":              withPhone,
			"missing_email":           total - withEmail,
			"missing_phone":           total - withPhone,
			"suppressed_email":        suppressed,
			"duplicate_email_rows":    duplicateRows,
			"duplicate_email_groups":  duplicateGroups,
			"invalid_email":           invalidEmail,
			"role_email":              roleEmail,
			"disposable_email":        disposableEmail,
			"usable_email_recipients": usableEmail,
			"usable_sms_recipients":   usableSMS,
			"estimated_messages":      usable,
			"send_delay_ms":           sendDelayMs,
			"daily_email_limit":       dailyEmailLimit,
			"estimated_seconds":       estimatedSeconds,
			"sample":                  sample,
			"warnings":                warnings,
		}, "postgres")
	}
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

func listCampaigns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "type"); v != "" {
			where += fmt.Sprintf(" AND c.type=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND c.status=$%d", n)
			args = append(args, v)
			n++
		}
		filterArgs := append([]any(nil), args...)
		args = append(args, limit, offset)

		total := 0
		if tr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM campaigns c WHERE %s", where), filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT c.*, u.full_name AS created_by_name, cl.name AS list_name,
			       COALESCE(cp.pending_count,0) AS pending_count,
			       COALESCE(cp.sending_count,0) AS sending_count,
			       COALESCE(cp.skipped_count,0) AS skipped_count,
			       COALESCE(cp.failed_count,0) AS contact_failed_count,
			       COALESCE(cp.completed_count,0) AS completed_contact_count
			FROM campaigns c
			LEFT JOIN o3c_users u  ON c.created_by=u.id
			LEFT JOIN contact_lists cl ON c.list_id=cl.id
			LEFT JOIN LATERAL (
			  SELECT
			    COUNT(*) FILTER (WHERE sms_status='pending' OR email_status='pending') AS pending_count,
			    COUNT(*) FILTER (WHERE sms_status='sending' OR email_status='sending') AS sending_count,
			    COUNT(*) FILTER (WHERE sms_status='skipped' OR email_status='skipped') AS skipped_count,
			    COUNT(*) FILTER (WHERE sms_status='failed' OR email_status IN ('failed','bounced','spam')) AS failed_count,
			    COUNT(*) FILTER (WHERE sms_status IN ('sent','delivered','failed','skipped') OR email_status IN ('queued','processed','delivered','opened','clicked','failed','bounced','spam','unsubscribed','skipped')) AS completed_count
			  FROM campaign_contacts cc WHERE cc.campaign_id=c.id
			) cp ON true
			WHERE %s ORDER BY c.created_at DESC LIMIT $%d OFFSET $%d`, where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"total": total, "campaigns": rows}) //nolint:errcheck
	}
}

func createCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name          string  `json:"name"`
			Description   *string `json:"description"`
			Type          string  `json:"type"`
			ListID        *int64  `json:"list_id"`
			ScheduledAt   *string `json:"scheduled_at"`
			Subject       *string `json:"subject"`
			Message       *string `json:"message"`
			EmailSubject  *string `json:"email_subject"`
			EmailBodyHTML *string `json:"email_body_html"`
			EmailBodyText *string `json:"email_body_text"`
			FromName      *string `json:"from_name"`
			FromEmail     *string `json:"from_email"`
			SMSBody       *string `json:"sms_body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if b.Type != "sms" && b.Type != "email" && b.Type != "multi" {
			b.Type = "sms"
		}
		if b.EmailSubject == nil {
			b.EmailSubject = b.Subject
		}
		if b.Message != nil {
			if b.Type == "email" || b.Type == "multi" {
				if b.EmailBodyHTML == nil {
					b.EmailBodyHTML = b.Message
				}
			}
			if b.Type == "sms" || b.Type == "multi" {
				if b.SMSBody == nil {
					b.SMSBody = b.Message
				}
			}
		}
		status := "draft"
		if b.ScheduledAt != nil && strings.TrimSpace(*b.ScheduledAt) != "" {
			status = "scheduled"
		}

		var total int64
		if b.ListID != nil {
			if tr, _ := db.PGQuery(r.Context(),
				"SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=$1 AND status='active'", *b.ListID); len(tr) > 0 {
				total = toInt64(tr[0]["n"])
			}
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO campaigns
			    (name, description, status, type, list_id, email_subject, email_body_html,
			     email_body_text, from_name, from_email, sms_body,
			     scheduled_at, total_contacts, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
			b.Name, b.Description, status, b.Type, b.ListID,
			b.EmailSubject, b.EmailBodyHTML, b.EmailBodyText, b.FromName, b.FromEmail,
			b.SMSBody, b.ScheduledAt, total, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		camp := rows[0]
		campID := toInt64(camp["id"])

		// Snapshot contact list members into campaign_contacts
		if b.ListID != nil && total > 0 {
			db.PGExec(r.Context(), //nolint:errcheck
				`INSERT INTO campaign_contacts
				    (campaign_id, first_name, last_name, phone, email, cif_number, merge_data, position)
				SELECT $1, first_name, last_name, phone, email, cif_number, merge_data,
				       ROW_NUMBER() OVER (ORDER BY id) - 1
				FROM contact_list_members WHERE list_id=$2 AND status='active'`,
				campID, *b.ListID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(camp) //nolint:errcheck
	}
}

func getCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS created_by_name, cl.name AS list_name
			FROM campaigns c
			LEFT JOIN o3c_users u  ON c.created_by=u.id
			LEFT JOIN contact_lists cl ON c.list_id=cl.id
			WHERE c.id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		stRows, _ := db.PGQuery(r.Context(), "SELECT status FROM campaigns WHERE id=$1", id)
		if len(stRows) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}
		if st := str(stRows[0]["status"]); st != "draft" && st != "scheduled" {
			respondErr(w, 400, "Only draft or scheduled campaigns can be edited")
			return
		}

		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// Reject an explicit empty name
		if n, ok := body["name"]; ok {
			if ns, _ := n.(string); strings.TrimSpace(ns) == "" {
				respondErr(w, 422, "name cannot be empty")
				return
			}
		}
		parts, args := buildSet(body, campaignUpdateCols, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}

		// If list_id changed, recount members
		if lid, ok := body["list_id"]; ok && lid != nil {
			if tr, _ := db.PGQuery(r.Context(),
				"SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=$1 AND status='active'", lid); len(tr) > 0 {
				n := len(args) + 1
				parts = append(parts, fmt.Sprintf("total_contacts=$%d", n))
				args = append(args, toInt64(tr[0]["n"]))
			}
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		db.PGExec(r.Context(), //nolint:errcheck
			fmt.Sprintf("UPDATE campaigns SET %s WHERE id=$%d",
				strings.Join(parts, ","), len(args)), args...)

		rows, _ := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS created_by_name, cl.name AS list_name
			FROM campaigns c
			LEFT JOIN o3c_users u  ON c.created_by=u.id
			LEFT JOIN contact_lists cl ON c.list_id=cl.id
			WHERE c.id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func startCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		campRows, _ := db.PGQuery(r.Context(), "SELECT id,status,list_id FROM campaigns WHERE id=$1", id)
		if len(campRows) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}
		camp := campRows[0]
		status := str(camp["status"])
		if status != "draft" && status != "scheduled" && status != "paused" {
			respondErr(w, 400, fmt.Sprintf("Cannot start a campaign with status '%s'", status))
			return
		}

		campID := toInt64(camp["id"])
		if status == "draft" || status == "scheduled" {
			// Re-snapshot contacts
			db.PGExec(r.Context(), "DELETE FROM campaign_contacts WHERE campaign_id=$1", campID) //nolint:errcheck
			if lid := camp["list_id"]; lid != nil {
				db.PGExec(r.Context(), //nolint:errcheck
					`INSERT INTO campaign_contacts
					    (campaign_id, first_name, last_name, phone, email, cif_number, merge_data, position)
					SELECT $1, first_name, last_name, phone, email, cif_number, merge_data,
					       ROW_NUMBER() OVER (ORDER BY id) - 1
					FROM contact_list_members WHERE list_id=$2 AND status='active'`,
					campID, lid)
			}
			if tr, _ := db.PGQuery(r.Context(),
				"SELECT COUNT(*) AS n FROM campaign_contacts WHERE campaign_id=$1", campID); len(tr) > 0 {
				db.PGExec(r.Context(), "UPDATE campaigns SET total_contacts=$1 WHERE id=$2", //nolint:errcheck
					toInt64(tr[0]["n"]), campID)
			}
		}
		prepareCampaignRecipients(r.Context(), db, campID)

		db.PGExec(r.Context(), //nolint:errcheck
			"UPDATE campaigns SET status='active', pause_reason=NULL, paused_until=NULL, started_at=NOW(), updated_at=NOW() WHERE id=$1", campID)

		startDispatch(db, campID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "active", "campaign_id": campID}) //nolint:errcheck
	}
}

func prepareCampaignRecipients(ctx context.Context, db *core.DB, campaignID int64) {
	rows, err := db.PGQuery(ctx, "SELECT type FROM campaigns WHERE id=$1", campaignID)
	if err != nil || len(rows) == 0 {
		return
	}
	typ := str(rows[0]["type"])
	isSMS := typ == "sms" || typ == "multi"
	isEmail := typ == "email" || typ == "multi"
	if isSMS {
		_, _ = db.PGExec(ctx, `
			UPDATE campaign_contacts
			SET sms_status='skipped', updated_at=NOW()
			WHERE campaign_id=$1 AND sms_status='pending' AND NULLIF(TRIM(phone),'') IS NULL`, campaignID)
	}
	if isEmail {
		if err := ensureMailSchema(ctx, db); err == nil {
			_, _ = db.PGExec(ctx, `
				UPDATE campaign_contacts cc
				SET email_status='skipped', updated_at=NOW()
				FROM mail_suppressions s
				WHERE cc.campaign_id=$1
				  AND cc.email_status='pending'
				  AND s.is_active=true
				  AND LOWER(TRIM(s.email))=LOWER(TRIM(cc.email))`, campaignID)
		}
		_, _ = db.PGExec(ctx, `
			UPDATE campaign_contacts
			SET email_status='skipped', updated_at=NOW()
			WHERE campaign_id=$1 AND email_status='pending' AND NULLIF(TRIM(email),'') IS NULL`, campaignID)
		_, _ = db.PGExec(ctx, `
			UPDATE campaign_contacts
			SET email_status='skipped', updated_at=NOW()
			WHERE campaign_id=$1 AND email_status='pending'
			  AND NULLIF(TRIM(email),'') IS NOT NULL
			  AND TRIM(email) !~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'`, campaignID)
		_, _ = db.PGExec(ctx, `
			WITH ranked AS (
			  SELECT id, ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(email)) ORDER BY id ASC) AS rn
			  FROM campaign_contacts
			  WHERE campaign_id=$1 AND email_status='pending' AND NULLIF(TRIM(email),'') IS NOT NULL
			)
			UPDATE campaign_contacts cc
			SET email_status='skipped', updated_at=NOW()
			FROM ranked r
			WHERE cc.id=r.id AND r.rn > 1`, campaignID)
	}
	if tr, _ := db.PGQuery(ctx, "SELECT COUNT(*) AS n FROM campaign_contacts WHERE campaign_id=$1", campaignID); len(tr) > 0 {
		_, _ = db.PGExec(ctx, "UPDATE campaigns SET total_contacts=$1, updated_at=NOW() WHERE id=$2", toInt64(tr[0]["n"]), campaignID)
	}
}

func pauseCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), "SELECT status FROM campaigns WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}
		if str(rows[0]["status"]) != "active" {
			respondErr(w, 400, "Only active campaigns can be paused")
			return
		}
		db.PGExec(r.Context(), "UPDATE campaigns SET status='paused', pause_reason='manual', paused_until=NULL, updated_at=NOW() WHERE id=$1", id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "paused"}) //nolint:errcheck
	}
}

func cancelCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), "SELECT status FROM campaigns WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}
		st := str(rows[0]["status"])
		if st == "completed" || st == "cancelled" {
			respondErr(w, 400, fmt.Sprintf("Campaign is already %s", st))
			return
		}
		db.PGExec(r.Context(), "UPDATE campaigns SET status='cancelled', pause_reason=NULL, paused_until=NULL, dispatch_lock_until=NULL, updated_at=NOW() WHERE id=$1", id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "cancelled"}) //nolint:errcheck
	}
}

func listCampaignContacts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		limit := qint(r, "limit", 100, 1, 1000)
		offset := qint(r, "offset", 0, 0, 1<<30)
		where := "campaign_id=$1"
		args := []any{id}
		n := 2
		if v := qstr(r, "sms_status"); v != "" {
			where += fmt.Sprintf(" AND sms_status=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "email_status"); v != "" {
			where += fmt.Sprintf(" AND email_status=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "search"); v != "" {
			where += fmt.Sprintf(
				" AND (first_name ILIKE $%d OR last_name ILIKE $%d OR phone ILIKE $%d OR email ILIKE $%d)",
				n, n, n, n)
			args = append(args, "%"+v+"%")
			n++
		}
		filterArgs := append([]any(nil), args...)
		args = append(args, limit, offset)

		total := 0
		if tr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM campaign_contacts WHERE %s", where), filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT * FROM campaign_contacts WHERE %s ORDER BY position ASC LIMIT $%d OFFSET $%d",
				where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"total": total, "contacts": rows}) //nolint:errcheck
	}
}

// ── Campaign → Telemarketing handoff ──────────────────────────────────────────

func campaignPushToTelemarketing(db *core.DB) http.HandlerFunc {
	type body struct {
		TelemarketingCampaignID *int64  `json:"telemarketing_campaign_id"`
		NewCampaignName         string  `json:"new_campaign_name"`
		Segment                 string  `json:"segment"` // all | email_opened | email_clicked | sms_delivered
		AssignedTo              *int64  `json:"assigned_to"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		campaignID := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Segment == "" {
			b.Segment = "all"
		}

		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// ── 1. Verify campaign exists ─────────────────────────────────────────
		campaigns, err := db.PGQuery(ctx, `SELECT id, name FROM campaigns WHERE id=$1`, campaignID)
		if err != nil || len(campaigns) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}

		// ── 2. Resolve or create the telemarketing campaign ───────────────────
		var tmCampaignID int64
		if b.TelemarketingCampaignID != nil && *b.TelemarketingCampaignID > 0 {
			tmCampaignID = *b.TelemarketingCampaignID
		} else {
			name := b.NewCampaignName
			if name == "" {
				name = "Campaign: " + str(campaigns[0]["name"])
			}
			rows, err := db.PGQuery(ctx,
				`INSERT INTO telemarketing_campaigns (name, status, created_by)
				 VALUES ($1, 'active', $2) RETURNING id`,
				name, user.ID)
			if err != nil || len(rows) == 0 {
				respondErr(w, 500, "Failed to create telemarketing campaign")
				return
			}
			tmCampaignID = toInt64(rows[0]["id"])
		}

		// ── 3. Build segment filter ───────────────────────────────────────────
		segmentFilter := ""
		switch b.Segment {
		case "email_opened":
			segmentFilter = " AND email_status='opened'"
		case "email_clicked":
			segmentFilter = " AND email_status='clicked'"
		case "sms_delivered":
			segmentFilter = " AND sms_status='delivered'"
		}

		// ── 4. Fetch contacts, excluding DNC numbers ──────────────────────────
		contacts, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT cc.first_name, cc.last_name, cc.phone, cc.email, cc.cif_number
			FROM campaign_contacts cc
			WHERE cc.campaign_id=$1
			  AND cc.phone IS NOT NULL
			  AND NOT EXISTS (
			      SELECT 1 FROM dnc_list d WHERE d.phone = cc.phone
			  )
			%s`, segmentFilter), campaignID)
		if err != nil {
			respondErr(w, 500, "Failed to fetch contacts")
			return
		}

		// ── 5. Count DNC-skipped contacts for reporting ───────────────────────
		var totalCount int64
		if tr, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COUNT(*) AS n FROM campaign_contacts
			WHERE campaign_id=$1 AND phone IS NOT NULL%s`, segmentFilter), campaignID); len(tr) > 0 {
			totalCount = toInt64(tr[0]["n"])
		}
		skippedDNC := totalCount - int64(len(contacts))

		// ── 6. Bulk insert into telemarketing_leads ───────────────────────────
		created := int64(0)
		for _, c := range contacts {
			firstName := str(c["first_name"])
			lastName := str(c["last_name"])
			fullName := strings.TrimSpace(firstName + " " + lastName)
			if fullName == "" {
				fullName = str(c["email"])
			}
			phone := ns(str(c["phone"]))
			var cif *string
			if v := str(c["cif_number"]); v != "" {
				cif = &v
			}
			// RETURNING id so we can count only rows actually inserted;
			// ON CONFLICT DO NOTHING returns nothing when a duplicate is skipped.
			inserted, err := db.PGQuery(ctx,
				`INSERT INTO telemarketing_leads
				   (campaign_id, customer_cif, customer_name, customer_phone, lead_score, assigned_to, status)
				 VALUES ($1,$2,$3,$4,50,$5,'pending')
				 ON CONFLICT DO NOTHING
				 RETURNING id`,
				tmCampaignID, cif, fullName, phone, b.AssignedTo)
			if err == nil {
				created += int64(len(inserted))
			}
		}

		respond(w, map[string]any{
			"telemarketing_campaign_id": tmCampaignID,
			"created":                   created,
			"skipped_dnc":               skippedDNC,
		}, "pg")
	}
}

// ── Webhooks (public — no JWT) ─────────────────────────────────────────────────

func checkWebhookToken(r *http.Request, expected string) bool {
	if expected == "" {
		// Bug fix: previously returned true (accepted any request when secret unconfigured).
		// Now rejects — an unconfigured secret means the webhook is effectively open to anyone,
		// which is a security hole. Operators must set SMS_WEBHOOK_SECRET / EMAIL_WEBHOOK_SECRET.
		slog.Warn("Webhook secret not configured — request rejected")
		return false
	}
	provided := r.URL.Query().Get("secret")
	// hmac.Equal is constant-time; the previous hand-rolled loop still leaked info via
	// the early length check and branch prediction.
	return hmac.Equal([]byte(provided), []byte(expected))
}

func smsWebhook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret := coalesce(resolveCredKey(r.Context(), db, "SMS_WEBHOOK_SECRET"), smsWebhookSecret)
		if !checkWebhookToken(r, secret) {
			w.WriteHeader(401)
			return
		}
		var data map[string]any
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			w.WriteHeader(204)
			return
		}
		providerID := coalesce(str(data["id"]), str(data["message_id"]))
		statusRaw := strings.ToLower(coalesce(str(data["status"]), str(data["delivery_status"])))
		statusMap := map[string]string{
			"delivered": "delivered", "failed": "failed", "undelivered": "failed",
			"sent": "sent", "queued": "queued",
		}
		newStatus := statusMap[statusRaw]
		if providerID != "" && newStatus != "" {
			ctx := r.Context()
			db.PGExec(ctx, //nolint:errcheck
				"UPDATE campaign_contacts SET sms_status=$1, updated_at=NOW() WHERE sms_provider_id=$2",
				newStatus, providerID)
			if newStatus == "delivered" {
				if sub, _ := db.PGQuery(ctx,
					"SELECT campaign_id FROM campaign_contacts WHERE sms_provider_id=$1 LIMIT 1", providerID); len(sub) > 0 {
					db.PGExec(ctx, //nolint:errcheck
						"UPDATE campaigns SET sms_delivered=sms_delivered+1, updated_at=NOW() WHERE id=$1",
						sub[0]["campaign_id"])
				}
			}
		}
		w.WriteHeader(204)
	}
}

func insertCampaignEmailEvent(ctx context.Context, db *core.DB, contact map[string]any, eventType, providerID string, ev map[string]any) {
	if len(contact) == 0 || eventType == "" {
		return
	}
	payload, _ := json.Marshal(ev)
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO campaign_events
		     (campaign_id, contact_id, tracking_id, event_type, channel, url, provider_msg_id, raw_payload)
		 VALUES ($1, $2, $3, $4, 'email', NULLIF($5,''), $6, $7::jsonb)`,
		contact["campaign_id"], contact["id"], str(contact["tracking_id"]), eventType, str(ev["url"]), providerID, string(payload))
}

func campaignContactHasEvent(ctx context.Context, db *core.DB, contactID any, eventType string) bool {
	if toInt64(contactID) <= 0 || eventType == "" {
		return false
	}
	rows, _ := db.PGQuery(ctx, `
		SELECT 1
		FROM campaign_events
		WHERE contact_id=$1 AND event_type=$2
		LIMIT 1`, contactID, eventType)
	return len(rows) > 0
}

func emailWebhook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		publicKey := sendgridWebhookPublicKey
		if publicKey == "" {
			publicKey = resolveCredKey(r.Context(), db, "SENDGRID_WEBHOOK_PUBLIC_KEY")
		}
		if publicKey != "" {
			ok := verifySendGridSignature(
				publicKey,
				r.Header.Get("X-Twilio-Email-Event-Webhook-Timestamp"),
				r.Header.Get("X-Twilio-Email-Event-Webhook-Signature"),
				body,
			)
			if !ok {
				w.WriteHeader(401)
				return
			}
		} else if !checkWebhookToken(r, coalesce(resolveCredKey(r.Context(), db, "EMAIL_WEBHOOK_SECRET"), emailWebhookSecret)) {
			w.WriteHeader(401)
			return
		}
		var events []map[string]any
		if err := json.Unmarshal(body, &events); err != nil {
			var single map[string]any
			if err := json.Unmarshal(body, &single); err != nil {
				w.WriteHeader(204)
				return
			}
			events = []map[string]any{single}
		}
		ctx := r.Context()
		for _, ev := range events {
			rawPID := str(ev["sg_message_id"])
			pid := strings.SplitN(rawPID, ".", 2)[0]
			event := str(ev["event"])
			if pid == "" {
				continue
			}
			recordMailEvent(ctx, db, pid, event, ev)
			switch event {
			case "processed":
				db.PGExec(ctx, //nolint:errcheck
					"UPDATE campaign_contacts SET email_status='processed', updated_at=NOW() WHERE email_provider_id=$1 AND email_status NOT IN ('delivered','opened','clicked')", pid)
			case "delivered":
				rows, _ := db.PGQuery(ctx, `
					SELECT id, campaign_id, tracking_id, email_status
					FROM campaign_contacts
					WHERE email_provider_id=$1
					LIMIT 1`, pid)
				if len(rows) > 0 {
					alreadyDelivered := campaignContactHasEvent(ctx, db, rows[0]["id"], "delivered")
					if !alreadyDelivered {
						db.PGExec(ctx, "UPDATE campaigns SET emails_delivered=emails_delivered+1, updated_at=NOW() WHERE id=$1", rows[0]["campaign_id"]) //nolint:errcheck
						insertCampaignEmailEvent(ctx, db, rows[0], "delivered", pid, ev)
					}
					db.PGExec(ctx, `
						UPDATE campaign_contacts
						SET email_status='delivered', updated_at=NOW()
						WHERE id=$1
						  AND email_status NOT IN ('opened','clicked','bounced','spam','unsubscribed','failed')`, rows[0]["id"]) //nolint:errcheck
				}
			case "open":
				rows, _ := db.PGQuery(ctx, `
					UPDATE campaign_contacts
					SET email_status='opened', email_opened_at=COALESCE(email_opened_at, NOW()), updated_at=NOW()
					WHERE email_provider_id=$1
					  AND email_opened_at IS NULL
					  AND email_status NOT IN ('clicked','bounced','spam','unsubscribed','failed')
					RETURNING id, campaign_id, tracking_id`, pid)
				if len(rows) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_opened=emails_opened+1, updated_at=NOW() WHERE id=$1", rows[0]["campaign_id"]) //nolint:errcheck
					insertCampaignEmailEvent(ctx, db, rows[0], "opened", pid, ev)
				}
			case "click":
				rows, _ := db.PGQuery(ctx, `
					UPDATE campaign_contacts
					SET email_status='clicked', updated_at=NOW()
					WHERE email_provider_id=$1
					  AND email_status NOT IN ('clicked','bounced','spam','unsubscribed','failed')
					RETURNING id, campaign_id, tracking_id`, pid)
				if len(rows) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_clicked=emails_clicked+1, updated_at=NOW() WHERE id=$1", rows[0]["campaign_id"]) //nolint:errcheck
					insertCampaignEmailEvent(ctx, db, rows[0], "clicked", pid, ev)
				}
			case "bounce", "dropped", "spamreport", "unsubscribe", "group_unsubscribe":
				status := "bounced"
				eventType := "bounced"
				campaignUpdate := "emails_bounced=emails_bounced+1"
				if event == "spamreport" {
					status = "spam"
					eventType = "spam"
					campaignUpdate = "bounce_count=bounce_count+1"
				} else if event == "unsubscribe" || event == "group_unsubscribe" {
					status = "unsubscribed"
					eventType = "unsubscribed"
					campaignUpdate = "unsubscribe_count=unsubscribe_count+1"
				}
				rows, _ := db.PGQuery(ctx, `
					UPDATE campaign_contacts
					SET email_status=$2, updated_at=NOW()
					WHERE email_provider_id=$1
					  AND email_status NOT IN ('bounced','spam','unsubscribed','failed')
					RETURNING id, campaign_id, tracking_id`, pid, status)
				if len(rows) > 0 {
					db.PGExec(ctx, fmt.Sprintf("UPDATE campaigns SET %s, updated_at=NOW() WHERE id=$1", campaignUpdate), rows[0]["campaign_id"]) //nolint:errcheck
					insertCampaignEmailEvent(ctx, db, rows[0], eventType, pid, ev)
				}
			case "deferred":
				db.PGExec(ctx, //nolint:errcheck
					"UPDATE campaign_contacts SET email_status='deferred', updated_at=NOW() WHERE email_provider_id=$1 AND email_status NOT IN ('delivered','opened','clicked')", pid)
			}
		}
		w.WriteHeader(204)
	}
}
