package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Config ────────────────────────────────────────────────────────────────────

var (
	termiiSenderID     = coalesce(os.Getenv("TERMII_SENDER_ID"), "O3CCARDS")
	sendgridFromEmail  = os.Getenv("SENDGRID_FROM_EMAIL")
	sendgridFromName   = coalesce(os.Getenv("SENDGRID_FROM_NAME"), "O3C Cards")
	smsWebhookSecret   = os.Getenv("SMS_WEBHOOK_SECRET")
	emailWebhookSecret = os.Getenv("EMAIL_WEBHOOK_SECRET")
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

// ── Provider functions ────────────────────────────────────────────────────────

func sendSMS(ctx context.Context, db *core.DB, phone, body string) (ok bool, providerID string) {
	apiKey := resolveCredKey(ctx, db, "TERMII_API_KEY")
	if apiKey == "" {
		return false, "TERMII_API_KEY not configured"
	}
	payload, _ := json.Marshal(map[string]any{
		"api_key": apiKey,
		"to":      phone,
		"from":    termiiSenderID,
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
	apiKey := resolveCredKey(ctx, db, "SENDGRID_API_KEY")
	if apiKey == "" {
		return false, "SENDGRID_API_KEY not configured"
	}
	if fromEmail == "" {
		fromEmail = sendgridFromEmail
	}
	if fromName == "" {
		fromName = sendgridFromName
	}
	if fromEmail == "" {
		return false, "SENDGRID_FROM_EMAIL not configured"
	}
	if htmlBody == "" {
		htmlBody = "<p></p>"
	}
	if textBody == "" {
		textBody = "Please enable HTML to view this email."
	}
	payload, _ := json.Marshal(map[string]any{
		"personalizations": []any{map[string]any{"to": []any{map[string]string{"email": toEmail, "name": toName}}}},
		"from":             map[string]string{"email": fromEmail, "name": fromName},
		"subject":          subject,
		"content": []any{
			map[string]string{"type": "text/html", "value": htmlBody},
			map[string]string{"type": "text/plain", "value": textBody},
		},
		"custom_args": map[string]string{"o3c_contact_id": contactRef},
		"tracking_settings": map[string]any{
			"click_tracking": map[string]any{"enable": true, "enable_text": false},
			"open_tracking":  map[string]any{"enable": true},
		},
	})
	resp, err := httpPost("https://api.sendgrid.com/v3/mail/send", "application/json",
		"Bearer "+apiKey, payload, 20*time.Second)
	if err != nil {
		return false, err.Error()
	}
	defer resp.Body.Close()
	io.ReadAll(resp.Body) //nolint:errcheck
	if resp.StatusCode == 200 || resp.StatusCode == 202 {
		return true, resp.Header.Get("X-Message-Id")
	}
	return false, fmt.Sprintf("HTTP %d", resp.StatusCode)
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

// ── Background dispatch ───────────────────────────────────────────────────────

func startDispatch(db *core.DB, campaignID int64) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
		defer cancel()

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
			// Check if paused
			stRow, _ := db.PGQuery(ctx, "SELECT status FROM campaigns WHERE id=$1", campaignID)
			if len(stRow) > 0 && str(stRow[0]["status"]) == "paused" {
				slog.Info("Campaign paused, stopping dispatch", "id", campaignID)
				return
			}

			var mergeData map[string]any
			if raw, ok := c["merge_data"].([]byte); ok {
				json.Unmarshal(raw, &mergeData) //nolint:errcheck
			}
			firstName := str(c["first_name"])
			lastName := str(c["last_name"])
			name := strings.TrimSpace(firstName + " " + lastName)
			if name == "" {
				name = "Customer"
			}
			cid := toInt64(c["id"])

			if isSMS && str(c["sms_status"]) == "pending" && str(c["phone"]) != "" {
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

			if isEmail && str(c["email_status"]) == "pending" && str(c["email"]) != "" {
				subject := renderTemplate(str(camp["email_subject"]), mergeData)
				htmlBody := renderTemplate(str(camp["email_body_html"]), mergeData)
				textBody := renderTemplate(str(camp["email_body_text"]), mergeData)
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
			}

			time.Sleep(100 * time.Millisecond) // rate-limit provider calls
		}

		db.PGExec(ctx, //nolint:errcheck
			"UPDATE campaigns SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='active'",
			campaignID)
		slog.Info("Campaign dispatch complete", "id", campaignID)
	}()
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
	r.With(access).Post("/", createCampaign(db))
	r.With(access).Get("/{id}", getCampaign(db))
	r.With(access).Patch("/{id}", updateCampaign(db))
	r.With(access).Post("/{id}/start", startCampaign(db))
	r.With(access).Post("/{id}/pause", pauseCampaign(db))
	r.With(access).Post("/{id}/cancel", cancelCampaign(db))
	r.With(access).Get("/{id}/contacts", listCampaignContacts(db))
}

// RegisterCampaignWebhooks wires public webhook endpoints (no auth required).
func RegisterCampaignWebhooks(r chi.Router, db *core.DB) {
	r.Post("/sms-webhook", smsWebhook(db))
	r.Post("/email-webhook", emailWebhook(db))
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

func listCampaigns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "type"); v != "" {
			where += fmt.Sprintf(" AND c.type=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND c.status=$%d", n); args = append(args, v); n++
		}
		args = append(args, limit)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT c.*, u.full_name AS created_by_name, cl.name AS list_name
			FROM campaigns c
			LEFT JOIN o3c_users u  ON c.created_by=u.id
			LEFT JOIN contact_lists cl ON c.list_id=cl.id
			WHERE %s ORDER BY c.created_at DESC LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
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
			EmailSubject  *string `json:"email_subject"`
			EmailBodyHTML *string `json:"email_body_html"`
			EmailBodyText *string `json:"email_body_text"`
			FromName      *string `json:"from_name"`
			FromEmail     *string `json:"from_email"`
			SMSBody       *string `json:"sms_body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required"); return
		}
		if b.Type != "sms" && b.Type != "email" && b.Type != "multi" {
			b.Type = "sms"
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
			    (name, description, type, list_id, email_subject, email_body_html,
			     email_body_text, from_name, from_email, sms_body,
			     total_contacts, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
			b.Name, b.Description, b.Type, b.ListID,
			b.EmailSubject, b.EmailBodyHTML, b.EmailBodyText, b.FromName, b.FromEmail,
			b.SMSBody, total, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
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
			respondErr(w, 404, "Campaign not found"); return
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
			respondErr(w, 404, "Campaign not found"); return
		}
		if st := str(stRows[0]["status"]); st != "draft" && st != "scheduled" {
			respondErr(w, 400, "Only draft or scheduled campaigns can be edited"); return
		}

		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		parts, args := buildSet(body, campaignUpdateCols, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update"); return
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
			respondErr(w, 404, "Not found"); return
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
			respondErr(w, 404, "Campaign not found"); return
		}
		camp := campRows[0]
		status := str(camp["status"])
		if status != "draft" && status != "scheduled" && status != "paused" {
			respondErr(w, 400, fmt.Sprintf("Cannot start a campaign with status '%s'", status)); return
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

		db.PGExec(r.Context(), //nolint:errcheck
			"UPDATE campaigns SET status='active', started_at=NOW(), updated_at=NOW() WHERE id=$1", campID)

		startDispatch(db, campID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "active", "campaign_id": campID}) //nolint:errcheck
	}
}

func pauseCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), "SELECT status FROM campaigns WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Campaign not found"); return
		}
		if str(rows[0]["status"]) != "active" {
			respondErr(w, 400, "Only active campaigns can be paused"); return
		}
		db.PGExec(r.Context(), "UPDATE campaigns SET status='paused', updated_at=NOW() WHERE id=$1", id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "paused"}) //nolint:errcheck
	}
}

func cancelCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), "SELECT status FROM campaigns WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Campaign not found"); return
		}
		st := str(rows[0]["status"])
		if st == "completed" || st == "cancelled" {
			respondErr(w, 400, fmt.Sprintf("Campaign is already %s", st)); return
		}
		db.PGExec(r.Context(), "UPDATE campaigns SET status='cancelled', updated_at=NOW() WHERE id=$1", id) //nolint:errcheck
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
			where += fmt.Sprintf(" AND sms_status=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "email_status"); v != "" {
			where += fmt.Sprintf(" AND email_status=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "search"); v != "" {
			where += fmt.Sprintf(
				" AND (first_name ILIKE $%d OR last_name ILIKE $%d OR phone ILIKE $%d OR email ILIKE $%d)",
				n, n, n, n)
			args = append(args, "%"+v+"%"); n++
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
			respondErr(w, 500, "Query failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"total": total, "contacts": rows}) //nolint:errcheck
	}
}

// ── Webhooks (public — no JWT) ─────────────────────────────────────────────────

func checkWebhookToken(r *http.Request, expected string) bool {
	if expected == "" {
		slog.Warn("Webhook secret not configured — request accepted without verification")
		return true
	}
	// constant-time compare (hmac.Equal expects []byte, so convert)
	provided := r.URL.Query().Get("secret")
	if len(provided) != len(expected) {
		return false
	}
	match := true
	for i := range provided {
		if provided[i] != expected[i] {
			match = false
		}
	}
	return match
}

func smsWebhook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !checkWebhookToken(r, smsWebhookSecret) {
			w.WriteHeader(401); return
		}
		var data map[string]any
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			w.WriteHeader(204); return
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

func emailWebhook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !checkWebhookToken(r, emailWebhookSecret) {
			w.WriteHeader(401); return
		}
		var events []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&events); err != nil {
			// SendGrid may send a single object; try wrapping
			w.WriteHeader(204); return
		}
		ctx := r.Context()
		for _, ev := range events {
			rawPID := str(ev["sg_message_id"])
			pid := strings.SplitN(rawPID, ".", 2)[0]
			event := str(ev["event"])
			if pid == "" {
				continue
			}
			switch event {
			case "delivered":
				db.PGExec(ctx, //nolint:errcheck
					"UPDATE campaign_contacts SET email_status='delivered', updated_at=NOW() WHERE email_provider_id=$1", pid)
				if sub, _ := db.PGQuery(ctx, "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=$1 LIMIT 1", pid); len(sub) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_delivered=emails_delivered+1, updated_at=NOW() WHERE id=$1", sub[0]["campaign_id"]) //nolint:errcheck
				}
			case "open":
				db.PGExec(ctx, //nolint:errcheck
					"UPDATE campaign_contacts SET email_status='opened', email_opened_at=NOW(), updated_at=NOW() WHERE email_provider_id=$1 AND email_status NOT IN ('clicked')", pid)
				if sub, _ := db.PGQuery(ctx, "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=$1 LIMIT 1", pid); len(sub) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_opened=emails_opened+1, updated_at=NOW() WHERE id=$1", sub[0]["campaign_id"]) //nolint:errcheck
				}
			case "click":
				db.PGExec(ctx, //nolint:errcheck
					"UPDATE campaign_contacts SET email_status='clicked', updated_at=NOW() WHERE email_provider_id=$1", pid)
				if sub, _ := db.PGQuery(ctx, "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=$1 LIMIT 1", pid); len(sub) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_clicked=emails_clicked+1, updated_at=NOW() WHERE id=$1", sub[0]["campaign_id"]) //nolint:errcheck
				}
			case "bounce", "spamreport", "unsubscribe":
				db.PGExec(ctx, //nolint:errcheck
					"UPDATE campaign_contacts SET email_status='bounced', updated_at=NOW() WHERE email_provider_id=$1", pid)
				if sub, _ := db.PGQuery(ctx, "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=$1 LIMIT 1", pid); len(sub) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_bounced=emails_bounced+1, updated_at=NOW() WHERE id=$1", sub[0]["campaign_id"]) //nolint:errcheck
				}
			}
		}
		w.WriteHeader(204)
	}
}
