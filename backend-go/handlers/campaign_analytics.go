// Package handlers — campaign analytics, image upload, tracking pixel/redirect, scheduled launcher.
//
// NOTE for main.go:
//   PUBLIC routes (add BEFORE auth middleware, e.g. alongside /api/campaign-webhooks):
//     r.Get("/t/o/{tracking_id}", handlers.TrackOpen(db))
//     r.Get("/t/c/{tracking_id}", handlers.TrackClick(db))
//     r.Handle("/uploads/*", http.StripPrefix("/uploads/", http.FileServer(http.Dir("uploads/"))))
//
//   PROTECTED routes (add INSIDE the auth middleware group):
//     r.Route("/api/campaigns", func(r chi.Router) {
//         handlers.RegisterCampaigns(r, db)
//         handlers.RegisterCampaignAnalytics(r, db)   // <-- add this
//     })
//
//   STARTUP (add after ResumeInterruptedCampaigns):
//     go handlers.ScheduledCampaignTicker(db)

package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Route registration ────────────────────────────────────────────────────────

// RegisterCampaignAnalytics mounts analytics and upload endpoints.
// Call this inside the same auth-protected r.Route("/api/campaigns", ...) block
// that RegisterCampaigns uses.
func RegisterCampaignAnalytics(r chi.Router, db *core.DB) {
	access := core.RequirePages("campaigns")
	r.With(access).Get("/analytics", campaignsAllAnalytics(db))
	r.With(access).Get("/{id}/analytics", campaignAnalyticsDetail(db))
	r.With(access).Get("/{id}/contacts-report", campaignContactsReport(db))
	r.With(access).Post("/upload-image", campaignUploadImage(db))
}

// TrackOpen returns the 1×1 GIF open-pixel handler (no auth).
func TrackOpen(db *core.DB) http.HandlerFunc { return trackOpen(db) }

// TrackClick returns the click-redirect handler (no auth).
func TrackClick(db *core.DB) http.HandlerFunc { return trackClick(db) }

// ── Scheduled launcher ───────────────────────────────────────────────────────

// ScheduledCampaignTicker polls every 60 s for campaigns whose scheduled_at has
// passed and launches their dispatch goroutine. Call as: go ScheduledCampaignTicker(db)
func ScheduledCampaignTicker(db *core.DB) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		rows, err := db.PGQuery(ctx,
			`SELECT id FROM campaigns WHERE status='scheduled' AND scheduled_at <= NOW()`)
		cancel()
		if err != nil {
			slog.Error("ScheduledCampaignTicker: query failed", "err", err)
			continue
		}
		for _, row := range rows {
			id := toInt64(row["id"])
			if id == 0 {
				continue
			}
			ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
			_, err := db.PGExec(ctx2,
				`UPDATE campaigns SET status='active', started_at=NOW(), updated_at=NOW() WHERE id=$1`, id)
			cancel2()
			if err != nil {
				slog.Error("ScheduledCampaignTicker: activate failed", "id", id, "err", err)
				continue
			}
			slog.Info("Auto-launching scheduled campaign", "id", id)
			startDispatch(db, id)
		}
	}
}

// ── All-campaigns aggregate analytics ────────────────────────────────────────

func campaignsAllAnalytics(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")
		channel := qstr(r, "channel")

		// Build WHERE clause for campaigns
		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND created_at::date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND created_at::date <= $%d", n)
			args = append(args, dateTo)
			n++
		}
		if channel != "" {
			where += fmt.Sprintf(" AND type=$%d", n)
			args = append(args, channel)
			n++
		}

		// Summary row
		summaryRows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    COUNT(*)                                            AS total_campaigns,
			    COALESCE(SUM(emails_sent + sms_sent),0)             AS total_sent,
			    COALESCE(SUM(emails_delivered + sms_delivered),0)  AS total_delivered,
			    COALESCE(SUM(emails_opened),0)                     AS total_opened,
			    COALESCE(SUM(emails_clicked),0)                    AS total_clicked,
			    COALESCE(SUM(emails_bounced),0)                    AS total_bounced,
			    COALESCE(SUM(bounce_count),0)                      AS total_spam,
			    COALESCE(SUM(unsubscribe_count),0)                 AS total_unsubscribed
			FROM campaigns
			WHERE %s`, where), args...)
		if err != nil {
			respondErr(w, 500, "Analytics query failed")
			return
		}

		summary := map[string]any{
			"total_campaigns":    int64(0),
			"total_sent":         int64(0),
			"total_delivered":    int64(0),
			"total_opened":       int64(0),
			"total_clicked":      int64(0),
			"total_bounced":      int64(0),
			"total_spam":         int64(0),
			"total_unsubscribed": int64(0),
			"avg_open_rate":      float64(0),
			"avg_click_rate":     float64(0),
			"avg_bounce_rate":    float64(0),
			"avg_delivery_rate":  float64(0),
		}
		if len(summaryRows) > 0 {
			s := summaryRows[0]
			totalSent := toInt64(s["total_sent"])
			totalDelivered := toInt64(s["total_delivered"])
			totalOpened := toInt64(s["total_opened"])
			totalClicked := toInt64(s["total_clicked"])
			totalBounced := toInt64(s["total_bounced"])
			summary["total_campaigns"] = toInt64(s["total_campaigns"])
			summary["total_sent"] = totalSent
			summary["total_delivered"] = totalDelivered
			summary["total_opened"] = totalOpened
			summary["total_clicked"] = totalClicked
			summary["total_bounced"] = totalBounced
			summary["total_spam"] = toInt64(s["total_spam"])
			summary["total_unsubscribed"] = toInt64(s["total_unsubscribed"])
			if totalSent > 0 {
				summary["avg_open_rate"] = roundPct(float64(totalOpened) / float64(totalSent) * 100)
				summary["avg_click_rate"] = roundPct(float64(totalClicked) / float64(totalSent) * 100)
				summary["avg_bounce_rate"] = roundPct(float64(totalBounced) / float64(totalSent) * 100)
				summary["avg_delivery_rate"] = roundPct(float64(totalDelivered) / float64(totalSent) * 100)
			}
		}

		// By channel
		byChannelRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    type                                                    AS channel,
			    COALESCE(SUM(emails_sent + sms_sent),0)                 AS sent,
			    COALESCE(SUM(emails_delivered + sms_delivered),0)      AS delivered,
			    COALESCE(SUM(emails_opened),0)                         AS opened,
			    COALESCE(SUM(emails_clicked),0)                        AS clicked
			FROM campaigns
			WHERE %s
			GROUP BY type
			ORDER BY type`, where), args...)

		byChannel := make([]map[string]any, 0, len(byChannelRows))
		for _, row := range byChannelRows {
			sent := toInt64(row["sent"])
			delivered := toInt64(row["delivered"])
			opened := toInt64(row["opened"])
			clicked := toInt64(row["clicked"])
			entry := map[string]any{
				"channel":       str(row["channel"]),
				"sent":          sent,
				"delivered":     delivered,
				"open_rate":     float64(0),
				"click_rate":    float64(0),
				"delivery_rate": float64(0),
			}
			if sent > 0 {
				entry["open_rate"] = roundPct(float64(opened) / float64(sent) * 100)
				entry["click_rate"] = roundPct(float64(clicked) / float64(sent) * 100)
				entry["delivery_rate"] = roundPct(float64(delivered) / float64(sent) * 100)
			}
			byChannel = append(byChannel, entry)
		}

		// By month
		byMonthRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
			    COUNT(*)                                             AS campaigns,
			    COALESCE(SUM(emails_sent + sms_sent),0)              AS sent,
			    COALESCE(SUM(emails_opened),0)                      AS opened
			FROM campaigns
			WHERE %s
			GROUP BY date_trunc('month', created_at)
			ORDER BY date_trunc('month', created_at) DESC
			LIMIT 24`, where), args...)

		byMonth := make([]map[string]any, 0, len(byMonthRows))
		for _, row := range byMonthRows {
			sent := toInt64(row["sent"])
			opened := toInt64(row["opened"])
			entry := map[string]any{
				"month":     str(row["month"]),
				"campaigns": toInt64(row["campaigns"]),
				"sent":      sent,
				"open_rate": float64(0),
			}
			if sent > 0 {
				entry["open_rate"] = roundPct(float64(opened) / float64(sent) * 100)
			}
			byMonth = append(byMonth, entry)
		}

		// Top campaigns by open rate (email campaigns with >0 sent)
		topRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT id, name, type,
			       COALESCE(emails_sent + sms_sent,0) AS sent,
			       COALESCE(emails_opened,0)    AS opened,
			       COALESCE(emails_clicked,0)   AS clicked
			FROM campaigns
			WHERE %s AND (emails_sent + sms_sent) > 0
			ORDER BY
			    CASE WHEN (emails_sent + sms_sent) > 0
			         THEN (emails_opened::float / (emails_sent + sms_sent))
			         ELSE 0
			    END DESC
			LIMIT 10`, where), args...)

		topCampaigns := make([]map[string]any, 0, len(topRows))
		for _, row := range topRows {
			sent := toInt64(row["sent"])
			opened := toInt64(row["opened"])
			clicked := toInt64(row["clicked"])
			entry := map[string]any{
				"id":         toInt64(row["id"]),
				"name":       str(row["name"]),
				"channel":    str(row["type"]),
				"sent":       sent,
				"open_rate":  float64(0),
				"click_rate": float64(0),
			}
			if sent > 0 {
				entry["open_rate"] = roundPct(float64(opened) / float64(sent) * 100)
				entry["click_rate"] = roundPct(float64(clicked) / float64(sent) * 100)
			}
			topCampaigns = append(topCampaigns, entry)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary":       summary,
			"by_channel":    byChannel,
			"by_month":      byMonth,
			"top_campaigns": topCampaigns,
		})
	}
}

// ── Per-campaign detail analytics ─────────────────────────────────────────────

func campaignAnalyticsDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		campRows, err := db.PGQuery(r.Context(), `
			SELECT id, name, type, status, total_contacts,
			       emails_sent, emails_delivered, emails_opened, emails_clicked,
			       emails_bounced, sms_sent, sms_delivered, sms_failed,
			       bounce_count, unsubscribe_count,
			       started_at, completed_at, scheduled_at, created_at
			FROM campaigns WHERE id=$1`, id)
		if err != nil || len(campRows) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}
		camp := campRows[0]

		channel := str(camp["type"])
		totalContacts := toInt64(camp["total_contacts"])
		var sent, delivered, opened, clicked, bounced, failed int64
		switch channel {
		case "sms":
			sent = toInt64(camp["sms_sent"])
			delivered = toInt64(camp["sms_delivered"])
			failed = toInt64(camp["sms_failed"])
		case "email":
			sent = toInt64(camp["emails_sent"])
			delivered = toInt64(camp["emails_delivered"])
			opened = toInt64(camp["emails_opened"])
			clicked = toInt64(camp["emails_clicked"])
			bounced = toInt64(camp["emails_bounced"])
		case "multi":
			sent = toInt64(camp["emails_sent"]) + toInt64(camp["sms_sent"])
			delivered = toInt64(camp["emails_delivered"]) + toInt64(camp["sms_delivered"])
			opened = toInt64(camp["emails_opened"])
			clicked = toInt64(camp["emails_clicked"])
			bounced = toInt64(camp["emails_bounced"])
			failed = toInt64(camp["sms_failed"])
		}

		metrics := map[string]any{
			"total_contacts": totalContacts,
			"sent":           sent,
			"sent_pct":       pctOf(sent, totalContacts),
			"delivered":      delivered,
			"delivery_rate":  pctOf(delivered, sent),
			"opened":         opened,
			"open_rate":      pctOf(opened, sent),
			"clicked":        clicked,
			"click_rate":     pctOf(clicked, sent),
			"bounced":        bounced,
			"bounce_rate":    pctOf(bounced, sent),
			"spam":           toInt64(camp["bounce_count"]),
			"spam_rate":      pctOf(toInt64(camp["bounce_count"]), sent),
			"unsubscribed":   toInt64(camp["unsubscribe_count"]),
			"unsub_rate":     pctOf(toInt64(camp["unsubscribe_count"]), sent),
			"failed":         failed,
		}

		// Timeline: events grouped by hour from campaign_events
		timelineRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    date_trunc('hour', ts)       AS hour,
			    COUNT(*) FILTER (WHERE event_type='opened')    AS opened,
			    COUNT(*) FILTER (WHERE event_type='clicked')   AS clicked,
			    COUNT(*) FILTER (WHERE event_type='delivered') AS delivered
			FROM campaign_events
			WHERE campaign_id=$1
			GROUP BY date_trunc('hour', ts)
			ORDER BY hour ASC`, id)

		timeline := make([]map[string]any, 0, len(timelineRows))
		for _, row := range timelineRows {
			timeline = append(timeline, map[string]any{
				"hour":      row["hour"],
				"opened":    toInt64(row["opened"]),
				"clicked":   toInt64(row["clicked"]),
				"delivered": toInt64(row["delivered"]),
			})
		}

		// Top links clicked
		topLinkRows, _ := db.PGQuery(r.Context(), `
			SELECT url, COUNT(*) AS clicks
			FROM campaign_events
			WHERE campaign_id=$1 AND event_type='clicked' AND url IS NOT NULL AND url != ''
			GROUP BY url
			ORDER BY clicks DESC
			LIMIT 10`, id)

		topLinks := make([]map[string]any, 0, len(topLinkRows))
		for _, row := range topLinkRows {
			topLinks = append(topLinks, map[string]any{
				"url":    str(row["url"]),
				"clicks": toInt64(row["clicks"]),
			})
		}

		// Contact-level status summary
		contactStatsRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(*) FILTER (WHERE email_status='pending' OR sms_status='pending')  AS pending,
			    COUNT(*) FILTER (WHERE email_status='queued'  OR sms_status='sent')     AS sent,
			    COUNT(*) FILTER (WHERE email_status='delivered' OR sms_status='delivered') AS delivered,
			    COUNT(*) FILTER (WHERE email_status='opened')                            AS opened,
			    COUNT(*) FILTER (WHERE email_status='clicked')                           AS clicked,
			    COUNT(*) FILTER (WHERE email_status='bounced' OR sms_status='failed')   AS bounced,
			    COUNT(*) FILTER (WHERE email_status='failed')                            AS failed
			FROM campaign_contacts
			WHERE campaign_id=$1`, id)

		contactStats := map[string]any{
			"pending":   int64(0),
			"sent":      int64(0),
			"delivered": int64(0),
			"opened":    int64(0),
			"clicked":   int64(0),
			"bounced":   int64(0),
			"failed":    int64(0),
		}
		if len(contactStatsRows) > 0 {
			cs := contactStatsRows[0]
			contactStats["pending"] = toInt64(cs["pending"])
			contactStats["sent"] = toInt64(cs["sent"])
			contactStats["delivered"] = toInt64(cs["delivered"])
			contactStats["opened"] = toInt64(cs["opened"])
			contactStats["clicked"] = toInt64(cs["clicked"])
			contactStats["bounced"] = toInt64(cs["bounced"])
			contactStats["failed"] = toInt64(cs["failed"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"campaign": map[string]any{
				"id":            toInt64(camp["id"]),
				"name":          str(camp["name"]),
				"channel":       channel,
				"status":        str(camp["status"]),
				"contact_count": totalContacts,
				"sent_at":       camp["started_at"],
				"completed_at":  camp["completed_at"],
			},
			"metrics":       metrics,
			"timeline":      timeline,
			"top_links":     topLinks,
			"contact_stats": contactStats,
		})
	}
}

// ── Per-contact status report (paged) ────────────────────────────────────────

func campaignContactsReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		page := qint(r, "page", 1, 1, 10000)
		perPage := qint(r, "per_page", 50, 1, 500)
		statusFilter := qstr(r, "status")
		search := qstr(r, "search")
		exportCSV := strings.EqualFold(qstr(r, "format"), "csv")
		if exportCSV {
			page = 1
			perPage = 100000
		}
		offset := (page - 1) * perPage

		// Verify campaign exists
		if cr, _ := db.PGQuery(r.Context(), "SELECT id FROM campaigns WHERE id=$1", id); len(cr) == 0 {
			respondErr(w, 404, "Campaign not found")
			return
		}

		where := "cc.campaign_id=$1"
		args := []any{id}
		n := 2
		if statusFilter != "" {
			where += fmt.Sprintf(" AND (cc.email_status=$%d OR cc.sms_status=$%d)", n, n)
			args = append(args, statusFilter)
			n++
		}
		if search != "" {
			where += fmt.Sprintf(
				" AND (cc.first_name ILIKE $%d OR cc.last_name ILIKE $%d OR cc.phone ILIKE $%d OR cc.cif_number ILIKE $%d OR cc.email ILIKE $%d)",
				n, n, n, n, n)
			args = append(args, "%"+search+"%")
			n++
		}

		filterArgs := append([]any(nil), args...)

		total := 0
		if tr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM campaign_contacts cc WHERE %s", where), filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}

		args = append(args, perPage, offset)
		contactRows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    cc.id,
			    cc.cif_number,
			    cc.first_name,
			    cc.last_name,
			    cc.phone,
			    cc.email,
			    cc.sms_status,
			    cc.email_status,
			    cc.sms_sent_at       AS sent_at,
			    cc.email_opened_at   AS opened_at,
			    cc.tracking_id
			FROM campaign_contacts cc
			WHERE %s
			ORDER BY cc.position ASC
			LIMIT $%d OFFSET $%d`, where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		// For each contact, pull their first clicked_at and clicked URLs from campaign_events
		type contactResult struct {
			ID          int64    `json:"id"`
			CIFNumber   string   `json:"cif_number"`
			Name        string   `json:"name"`
			Phone       string   `json:"phone"`
			Email       string   `json:"email"`
			SMSStatus   string   `json:"sms_status"`
			EmailStatus string   `json:"email_status"`
			SentAt      any      `json:"sent_at"`
			OpenedAt    any      `json:"opened_at"`
			ClickedAt   any      `json:"clicked_at"`
			BouncedAt   any      `json:"bounced_at"`
			ClickedURLs []string `json:"clicked_urls"`
		}

		contacts := make([]contactResult, 0, len(contactRows))
		for _, row := range contactRows {
			contactID := toInt64(row["id"])
			firstName := str(row["first_name"])
			lastName := str(row["last_name"])
			name := strings.TrimSpace(firstName + " " + lastName)

			// Fetch events for this contact to get clicked_at, bounced_at, clicked URLs
			evRows, _ := db.PGQuery(r.Context(), `
				SELECT event_type, url, ts
				FROM campaign_events
				WHERE contact_id=$1
				ORDER BY ts ASC`, contactID)

			var clickedAt, bouncedAt any
			clickedURLs := []string{}
			urlSeen := map[string]bool{}
			for _, ev := range evRows {
				switch str(ev["event_type"]) {
				case "clicked":
					if clickedAt == nil {
						clickedAt = ev["ts"]
					}
					if u := str(ev["url"]); u != "" && !urlSeen[u] {
						urlSeen[u] = true
						clickedURLs = append(clickedURLs, u)
					}
				case "bounced":
					if bouncedAt == nil {
						bouncedAt = ev["ts"]
					}
				}
			}

			contacts = append(contacts, contactResult{
				ID:          contactID,
				CIFNumber:   str(row["cif_number"]),
				Name:        name,
				Phone:       str(row["phone"]),
				Email:       str(row["email"]),
				SMSStatus:   str(row["sms_status"]),
				EmailStatus: str(row["email_status"]),
				SentAt:      row["sent_at"],
				OpenedAt:    row["opened_at"],
				ClickedAt:   clickedAt,
				BouncedAt:   bouncedAt,
				ClickedURLs: clickedURLs,
			})
		}

		if exportCSV {
			csvRows := make([]map[string]any, 0, len(contacts))
			for _, c := range contacts {
				csvRows = append(csvRows, map[string]any{
					"name":         c.Name,
					"cif_number":   c.CIFNumber,
					"email":        c.Email,
					"phone":        c.Phone,
					"sms_status":   c.SMSStatus,
					"email_status": c.EmailStatus,
					"sent_at":      c.SentAt,
					"opened_at":    c.OpenedAt,
					"clicked_at":   c.ClickedAt,
					"bounced_at":   c.BouncedAt,
					"clicked_urls": strings.Join(c.ClickedURLs, " | "),
				})
			}
			streamCSV(w, fmt.Sprintf("campaign-%s-contacts.csv", id), csvRows)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"total":    total,
			"page":     page,
			"per_page": perPage,
			"contacts": contacts,
		})
	}
}

// ── Image upload ─────────────────────────────────────────────────────────────

const (
	maxImageSize = 5 << 20 // 5 MB
	uploadDir    = "uploads/campaigns"
)

func campaignUploadImage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Limit body size before parsing
		r.Body = http.MaxBytesReader(w, r.Body, maxImageSize+1024)

		if err := r.ParseMultipartForm(maxImageSize); err != nil {
			respondErr(w, 400, "File too large or invalid form — max 5 MB")
			return
		}

		file, header, err := r.FormFile("image")
		if err != nil {
			respondErr(w, 400, "Field 'image' missing")
			return
		}
		defer file.Close()

		// Validate MIME type
		buf := make([]byte, 512)
		n, _ := file.Read(buf)
		mime := http.DetectContentType(buf[:n])
		if !strings.HasPrefix(mime, "image/") {
			respondErr(w, 400, fmt.Sprintf("Only image files are accepted (detected: %s)", mime))
			return
		}
		// Reset reader — DetectContentType consumed the first 512 bytes
		type readerWithSeek interface {
			io.Reader
			io.Seeker
		}
		if rs, ok := file.(readerWithSeek); ok {
			rs.Seek(0, io.SeekStart) //nolint:errcheck
		}

		// Derive extension from original filename, fallback from MIME
		ext := strings.ToLower(filepath.Ext(header.Filename))
		if ext == "" {
			switch mime {
			case "image/jpeg":
				ext = ".jpg"
			case "image/png":
				ext = ".png"
			case "image/gif":
				ext = ".gif"
			case "image/webp":
				ext = ".webp"
			default:
				ext = ".bin"
			}
		}

		// Create upload directory if needed
		if err := os.MkdirAll(uploadDir, 0755); err != nil {
			respondErr(w, 500, "Cannot create upload directory")
			return
		}

		storedName := newUUID() + ext
		destPath := filepath.Join(uploadDir, storedName)
		out, err := os.Create(destPath)
		if err != nil {
			respondErr(w, 500, "Cannot create file")
			return
		}
		defer out.Close()

		written, err := io.Copy(out, file)
		if err != nil {
			respondErr(w, 500, "Upload write failed")
			return
		}

		publicURL := "/uploads/campaigns/" + storedName

		// Record in DB (best-effort — don't fail the upload if insert fails)
		user := core.UserFromCtx(r.Context())
		var uploaderID any
		if user != nil {
			uploaderID = user.ID
		}
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO campaign_uploads (original_name, stored_name, mime_type, size_bytes, url, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			header.Filename, storedName, mime, written, publicURL, uploaderID)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]string{"url": publicURL}) //nolint:errcheck
	}
}

// ── Open tracking pixel ───────────────────────────────────────────────────────

// transparent1x1GIF is a minimal 1×1 transparent GIF89a.
var transparent1x1GIF = []byte{
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
	0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
}

func trackOpen(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		trackingID := chi.URLParam(r, "tracking_id")
		trackingID = strings.TrimSuffix(trackingID, ".gif")

		if trackingID != "" {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				rows, _ := db.PGQuery(ctx,
					`SELECT id, campaign_id FROM campaign_contacts WHERE tracking_id=$1 LIMIT 1`, trackingID)
				if len(rows) == 0 {
					return
				}
				contactID := rows[0]["id"]
				campaignID := rows[0]["campaign_id"]
				db.PGExec(ctx, //nolint:errcheck
					`INSERT INTO campaign_events
					     (campaign_id, contact_id, tracking_id, event_type, channel, ip_address, user_agent)
					 VALUES ($1, $2, $3, 'opened', 'email', $4, $5)`,
					campaignID, contactID, trackingID, r.RemoteAddr, r.UserAgent())
				// Update contact status to opened (only advance, never downgrade)
				openedRows, _ := db.PGQuery(ctx,
					`UPDATE campaign_contacts
					 SET email_status='opened', email_opened_at=COALESCE(email_opened_at, NOW()), updated_at=NOW()
					 WHERE id=$1
					   AND email_opened_at IS NULL
					   AND email_status NOT IN ('clicked','bounced','spam','unsubscribed','failed')
					 RETURNING campaign_id`,
					contactID)
				if len(openedRows) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_opened=emails_opened+1, updated_at=NOW() WHERE id=$1", openedRows[0]["campaign_id"]) //nolint:errcheck
				}
			}()
		}

		w.Header().Set("Content-Type", "image/gif")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(transparent1x1GIF)))
		w.WriteHeader(http.StatusOK)
		w.Write(transparent1x1GIF) //nolint:errcheck
	}
}

// ── Click tracking redirect ───────────────────────────────────────────────────

func trackClick(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		trackingID := chi.URLParam(r, "tracking_id")
		destURL := r.URL.Query().Get("url")

		if destURL == "" {
			http.Redirect(w, r, "https://o3ccards.com", http.StatusFound)
			return
		}

		parsed, err := url.Parse(destURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			http.Redirect(w, r, "https://o3ccards.com", http.StatusFound)
			return
		}

		if trackingID != "" {
			ip := r.RemoteAddr
			ua := r.UserAgent()
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				rows, _ := db.PGQuery(ctx,
					`SELECT id, campaign_id FROM campaign_contacts WHERE tracking_id=$1 LIMIT 1`, trackingID)
				if len(rows) == 0 {
					return
				}
				contactID := rows[0]["id"]
				campaignID := rows[0]["campaign_id"]
				db.PGExec(ctx, //nolint:errcheck
					`INSERT INTO campaign_events
					     (campaign_id, contact_id, tracking_id, event_type, channel, url, ip_address, user_agent)
					 VALUES ($1, $2, $3, 'clicked', 'email', $4, $5, $6)`,
					campaignID, contactID, trackingID, destURL, ip, ua)
				// Advance contact status to clicked
				clickedRows, _ := db.PGQuery(ctx,
					`UPDATE campaign_contacts
					 SET email_status='clicked', updated_at=NOW()
					 WHERE id=$1 AND email_status NOT IN ('clicked','bounced','spam','unsubscribed','failed')
					 RETURNING campaign_id`,
					contactID)
				if len(clickedRows) > 0 {
					db.PGExec(ctx, "UPDATE campaigns SET emails_clicked=emails_clicked+1, updated_at=NOW() WHERE id=$1", clickedRows[0]["campaign_id"]) //nolint:errcheck
				}
			}()
		}

		http.Redirect(w, r, destURL, http.StatusFound)
	}
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

// newUUID returns a random UUID v4 string using crypto/rand.
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}

// ── Math helpers (package-private) ───────────────────────────────────────────

func pctOf(num, den int64) float64 {
	if den == 0 {
		return 0
	}
	return roundPct(float64(num) / float64(den) * 100)
}

func roundPct(v float64) float64 {
	// Round to 1 decimal place
	return float64(int64(v*10+0.5)) / 10
}
