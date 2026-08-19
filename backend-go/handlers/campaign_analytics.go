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
	"sort"
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
	r.With(access).Get("/overview", marketingOverview(db))
	r.With(access).Get("/summary", campaignsSummary(db))
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
			WorkerBeat(context.Background(), db, "campaign_ticker", "error", err.Error(), "")
			continue
		}
		launched := 0
		for _, row := range rows {
			id := toInt64(row["id"])
			if id == 0 {
				continue
			}
			ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
			prepareCampaignRecipients(ctx2, db, id)
			_, err := db.PGExec(ctx2,
				`UPDATE campaigns SET status='active', pause_reason=NULL, paused_until=NULL, started_at=NOW(), updated_at=NOW() WHERE id=$1`, id)
			cancel2()
			if err != nil {
				slog.Error("ScheduledCampaignTicker: activate failed", "id", id, "err", err)
				continue
			}
			slog.Info("Auto-launching scheduled campaign", "id", id)
			startDispatch(db, id)
			launched++
		}
		WorkerBeat(context.Background(), db, "campaign_ticker", "ok", fmt.Sprintf("%d launched", launched), "")
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
			    COALESCE(SUM(emails_sent + sms_sent + whatsapp_sent),0)             AS total_sent,
			    COALESCE(SUM(emails_delivered + sms_delivered + whatsapp_delivered),0)  AS total_delivered,
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
			    COALESCE(SUM(emails_sent + sms_sent + whatsapp_sent),0)                 AS sent,
			    COALESCE(SUM(emails_delivered + sms_delivered + whatsapp_delivered),0)      AS delivered,
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

		monthlyVolumeRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
			    type,
			    COALESCE(SUM(emails_sent + sms_sent + whatsapp_sent),0) AS sent
			FROM campaigns
			WHERE %s
			GROUP BY date_trunc('month', created_at), type
			ORDER BY date_trunc('month', created_at) ASC`, where), args...)
		monthlyMap := map[string]map[string]any{}
		for _, row := range monthlyVolumeRows {
			month := str(row["month"])
			if month == "" {
				continue
			}
			entry := monthlyMap[month]
			if entry == nil {
				entry = map[string]any{"month": month, "email": int64(0), "sms": int64(0), "whatsapp": int64(0)}
				monthlyMap[month] = entry
			}
			entry[str(row["type"])] = toInt64(row["sent"])
		}
		monthlyVolume := make([]map[string]any, 0, len(monthlyMap))
		for _, entry := range monthlyMap {
			monthlyVolume = append(monthlyVolume, entry)
		}
		sort.Slice(monthlyVolume, func(i, j int) bool {
			return str(monthlyVolume[i]["month"]) < str(monthlyVolume[j]["month"])
		})

		channelSplitRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT type AS channel, COUNT(*) AS count
			FROM campaigns
			WHERE %s
			GROUP BY type
			ORDER BY type`, where), args...)
		channelSplit := make([]map[string]any, 0, len(channelSplitRows))
		for _, row := range channelSplitRows {
			channelSplit = append(channelSplit, map[string]any{
				"channel": str(row["channel"]),
				"count":   toInt64(row["count"]),
			})
		}

		// Top campaigns by open rate (email campaigns with >0 sent)
		topRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT id, name, type,
			       COALESCE(emails_sent + sms_sent + whatsapp_sent,0) AS sent,
			       GREATEST(COALESCE(emails_delivered + sms_delivered + whatsapp_delivered,0), (
			           SELECT COUNT(*) FROM campaign_contacts cc
			           WHERE cc.campaign_id=campaigns.id
			             AND (cc.email_status IN ('delivered','opened','clicked') OR cc.sms_status='delivered')
			       )) AS delivered,
			       GREATEST(COALESCE(emails_opened,0), (
			           SELECT COUNT(*) FROM campaign_contacts cc
			           WHERE cc.campaign_id=campaigns.id AND cc.email_status IN ('opened','clicked')
			       )) AS opened,
			       GREATEST(COALESCE(emails_clicked,0), (
			           SELECT COUNT(*) FROM campaign_contacts cc
			           WHERE cc.campaign_id=campaigns.id AND cc.email_status='clicked'
			       )) AS clicked
			FROM campaigns
			WHERE %s AND (emails_sent + sms_sent + whatsapp_sent) > 0
			ORDER BY
			    CASE WHEN (emails_sent + sms_sent) > 0
			         THEN (emails_opened::float / (emails_sent + sms_sent))
			         ELSE 0
			    END DESC
			LIMIT 10`, where), args...)

		topCampaigns := make([]map[string]any, 0, len(topRows))
		for _, row := range topRows {
			sent := toInt64(row["sent"])
			delivered := toInt64(row["delivered"])
			opened := toInt64(row["opened"])
			clicked := toInt64(row["clicked"])
			entry := map[string]any{
				"id":            toInt64(row["id"]),
				"name":          str(row["name"]),
				"channel":       str(row["type"]),
				"sent":          sent,
				"delivered":     delivered,
				"delivered_pct": float64(0),
				"open_rate":     float64(0),
				"click_rate":    float64(0),
			}
			if sent > 0 {
				entry["delivered_pct"] = roundPct(float64(delivered) / float64(sent) * 100)
				entry["open_rate"] = roundPct(float64(opened) / float64(sent) * 100)
				entry["click_rate"] = roundPct(float64(clicked) / float64(sent) * 100)
			}
			topCampaigns = append(topCampaigns, entry)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary":        summary,
			"metrics":        summary,
			"by_channel":     byChannel,
			"by_month":       byMonth,
			"channel_split":  channelSplit,
			"monthly_volume": monthlyVolume,
			"top_campaigns":  topCampaigns,
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
			       COALESCE(whatsapp_sent,0) AS whatsapp_sent,
			       COALESCE(whatsapp_delivered,0) AS whatsapp_delivered,
			       COALESCE(whatsapp_failed,0) AS whatsapp_failed,
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
		contactRollupRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(*) FILTER (WHERE email_status IN ('queued','processed','delivered','opened','clicked')) AS email_sent,
			    COUNT(*) FILTER (WHERE email_status IN ('delivered','opened','clicked')) AS email_delivered,
			    COUNT(*) FILTER (WHERE email_status IN ('opened','clicked')) AS email_opened,
			    COUNT(*) FILTER (WHERE email_status='clicked') AS email_clicked,
			    COUNT(*) FILTER (WHERE email_status IN ('bounced','spam','unsubscribed','failed')) AS email_bounced,
			    COUNT(*) FILTER (WHERE sms_status='sent') AS sms_sent,
			    COUNT(*) FILTER (WHERE sms_status='delivered') AS sms_delivered,
			    COUNT(*) FILTER (WHERE sms_status='failed') AS sms_failed,
			    COUNT(*) FILTER (WHERE whatsapp_status IN ('sent','delivered')) AS wa_sent,
			    COUNT(*) FILTER (WHERE whatsapp_status='delivered') AS wa_delivered,
			    COUNT(*) FILTER (WHERE whatsapp_status='failed') AS wa_failed
			FROM campaign_contacts
			WHERE campaign_id=$1`, id)
		contactRollup := map[string]any{}
		if len(contactRollupRows) > 0 {
			contactRollup = contactRollupRows[0]
		}
		// Per-channel rollups (max of campaign counters vs live contact-status rollup).
		emSent := maxInt64(toInt64(camp["emails_sent"]), toInt64(contactRollup["email_sent"]))
		emDeliv := maxInt64(toInt64(camp["emails_delivered"]), toInt64(contactRollup["email_delivered"]))
		emOpen := maxInt64(toInt64(camp["emails_opened"]), toInt64(contactRollup["email_opened"]))
		emClick := maxInt64(toInt64(camp["emails_clicked"]), toInt64(contactRollup["email_clicked"]))
		emBounce := maxInt64(toInt64(camp["emails_bounced"]), toInt64(contactRollup["email_bounced"]))
		smSent := maxInt64(toInt64(camp["sms_sent"]), toInt64(contactRollup["sms_sent"]))
		smDeliv := maxInt64(toInt64(camp["sms_delivered"]), toInt64(contactRollup["sms_delivered"]))
		smFail := maxInt64(toInt64(camp["sms_failed"]), toInt64(contactRollup["sms_failed"]))
		waSent := maxInt64(toInt64(camp["whatsapp_sent"]), toInt64(contactRollup["wa_sent"]))
		waDeliv := maxInt64(toInt64(camp["whatsapp_delivered"]), toInt64(contactRollup["wa_delivered"]))
		waFail := maxInt64(toInt64(camp["whatsapp_failed"]), toInt64(contactRollup["wa_failed"]))

		hasEmail := channel == "email" || channel == "multi"
		hasSMS := channel == "sms" || channel == "multi"
		hasWA := channel == "whatsapp" || channel == "multi"

		if hasEmail {
			sent += emSent
			delivered += emDeliv
			opened += emOpen
			clicked += emClick
			bounced += emBounce
		}
		if hasSMS {
			sent += smSent
			delivered += smDeliv
			failed += smFail
		}
		if hasWA {
			sent += waSent
			delivered += waDeliv
			failed += waFail
		}

		// Per-channel breakdown so the Results page can show each channel on its own.
		chanMetric := func(ch string, s, d, o, c, f int64, engage bool) map[string]any {
			mm := map[string]any{"channel": ch, "sent": s, "delivered": d, "delivery_rate": pctOf(d, s), "failed": f}
			if engage {
				mm["opened"] = o
				mm["open_rate"] = pctOf(o, s)
				mm["clicked"] = c
				mm["click_rate"] = pctOf(c, s)
			}
			return mm
		}
		channels := []map[string]any{}
		if hasEmail {
			channels = append(channels, chanMetric("email", emSent, emDeliv, emOpen, emClick, emBounce, true))
		}
		if hasSMS {
			channels = append(channels, chanMetric("sms", smSent, smDeliv, 0, 0, smFail, false))
		}
		if hasWA {
			channels = append(channels, chanMetric("whatsapp", waSent, waDeliv, 0, 0, waFail, false))
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
			    COUNT(*) FILTER (WHERE email_status IN ('queued','processed','delivered','opened','clicked') OR sms_status='sent') AS sent,
			    COUNT(*) FILTER (WHERE email_status IN ('delivered','opened','clicked') OR sms_status='delivered') AS delivered,
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

		// Benchmarks: how this campaign's rates compare to the average of other
		// launched campaigns on the same channel (with sends). Lets a rate read as
		// good/bad at a glance rather than as a bare number.
		benchmarks := map[string]any{"peer_count": int64(0), "avg_open_rate": float64(0), "avg_click_rate": float64(0), "avg_delivery_rate": float64(0)}
		benchRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(*) AS peer_count,
			    COALESCE(AVG(CASE WHEN (emails_sent+sms_sent+whatsapp_sent) > 0
			        THEN (emails_delivered+sms_delivered+whatsapp_delivered)::float/(emails_sent+sms_sent+whatsapp_sent)*100 END),0) AS avg_delivery_rate,
			    COALESCE(AVG(CASE WHEN emails_sent > 0 THEN emails_opened::float/emails_sent*100 END),0)  AS avg_open_rate,
			    COALESCE(AVG(CASE WHEN emails_sent > 0 THEN emails_clicked::float/emails_sent*100 END),0) AS avg_click_rate
			FROM campaigns
			WHERE type=$1 AND id<>$2 AND (emails_sent+sms_sent+whatsapp_sent) > 0`, channel, id)
		if len(benchRows) > 0 {
			b := benchRows[0]
			benchmarks["peer_count"] = toInt64(b["peer_count"])
			benchmarks["avg_delivery_rate"] = roundPct(toFloat(b["avg_delivery_rate"]))
			benchmarks["avg_open_rate"] = roundPct(toFloat(b["avg_open_rate"]))
			benchmarks["avg_click_rate"] = roundPct(toFloat(b["avg_click_rate"]))
		}

		// Engagement insights from the raw event stream (opens with timestamps).
		insights := map[string]any{
			"opens_by_hour":     []map[string]any{},
			"peak_open_hour":    nil,
			"total_opens":       int64(0),
			"unique_openers":    int64(0),
			"repeat_opens":      int64(0),
			"avg_hours_to_open": float64(0),
			"device":            map[string]any{"mobile": int64(0), "desktop": int64(0)},
		}
		hodRows, _ := db.PGQuery(r.Context(), `
			SELECT EXTRACT(hour FROM ts)::int AS hod, COUNT(*) AS opens
			FROM campaign_events WHERE campaign_id=$1 AND event_type='opened'
			GROUP BY 1 ORDER BY 1`, id)
		opensByHour := make([]map[string]any, 0, len(hodRows))
		var peakHour, peakOpens int64 = -1, -1
		for _, row := range hodRows {
			h := toInt64(row["hod"])
			o := toInt64(row["opens"])
			opensByHour = append(opensByHour, map[string]any{"hour": h, "opens": o})
			if o > peakOpens {
				peakOpens = o
				peakHour = h
			}
		}
		insights["opens_by_hour"] = opensByHour
		if peakHour >= 0 {
			insights["peak_open_hour"] = peakHour
		}
		repeatRows, _ := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS total_opens, COUNT(DISTINCT contact_id) AS unique_openers
			FROM campaign_events WHERE campaign_id=$1 AND event_type='opened'`, id)
		if len(repeatRows) > 0 {
			total := toInt64(repeatRows[0]["total_opens"])
			uniq := toInt64(repeatRows[0]["unique_openers"])
			insights["total_opens"] = total
			insights["unique_openers"] = uniq
			if total > uniq {
				insights["repeat_opens"] = total - uniq
			}
		}
		ttoRows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (fo.first_open - COALESCE(c.started_at, c.created_at)))/3600.0),0) AS avg_hours
			FROM (SELECT contact_id, MIN(ts) AS first_open FROM campaign_events
			      WHERE campaign_id=$1 AND event_type='opened' AND contact_id IS NOT NULL
			      GROUP BY contact_id) fo
			CROSS JOIN campaigns c WHERE c.id=$1`, id)
		if len(ttoRows) > 0 {
			h := toFloat(ttoRows[0]["avg_hours"])
			if h > 0 {
				insights["avg_hours_to_open"] = float64(int64(h*10+0.5)) / 10
			}
		}
		devRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(*) FILTER (WHERE user_agent ILIKE '%Mobi%') AS mobile,
			    COUNT(*) FILTER (WHERE user_agent IS NOT NULL AND user_agent NOT ILIKE '%Mobi%') AS desktop
			FROM campaign_events WHERE campaign_id=$1 AND event_type='opened'`, id)
		if len(devRows) > 0 {
			insights["device"] = map[string]any{"mobile": toInt64(devRows[0]["mobile"]), "desktop": toInt64(devRows[0]["desktop"])}
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
			"channels":      channels,
			"timeline":      timeline,
			"top_links":     topLinks,
			"contact_stats": contactStats,
			"benchmarks":    benchmarks,
			"insights":      insights,
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
			respondErrLog(w, 500, "Query failed", err)
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
)

func UploadRoot() string {
	if root := strings.TrimSpace(os.Getenv("UPLOAD_ROOT")); root != "" {
		return root
	}
	return "/tmp/o3c-uploads"
}

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

		storedName := newUUID() + ext
		url, ok := uploadCampaignImageToR2(storedName, mime, file)
		if !ok {
			// On-prem fallback: R2 isn't configured, so persist to local disk and
			// serve via the /uploads/* static handler. Reset the reader first —
			// the R2 attempt / MIME sniff may have consumed part of it.
			if rs, ok2 := file.(readerWithSeek); ok2 {
				rs.Seek(0, io.SeekStart) //nolint:errcheck
			}
			url, ok = saveCampaignImageLocal(storedName, file)
		}
		if !ok {
			respondErr(w, 503, "Image storage failed: R2 is not configured and the local uploads directory is not writable. Set the R2_* env vars or a writable UPLOAD_ROOT.")
			return
		}

		recordCampaignUpload(r.Context(), db, header.Filename, storedName, mime, 0, url)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"url": url}) //nolint:errcheck
	}
}

// saveCampaignImageLocal persists an uploaded campaign image to the local uploads
// root (served by the /uploads/* static handler). Used when R2 object storage
// isn't configured (the on-prem deployment).
//
// It returns a ROOT-RELATIVE URL ("/uploads/campaign-images/<name>") by default,
// which is the correct, portable form: the browser resolves it against whatever
// origin the user is on (crm.o3cards.pri, 10.1.2.30, localhost…), and the email
// send path inlines any /uploads image as a CID attachment, so deliverability
// doesn't depend on a reachable host. Set PUBLIC_BASE_URL only if you have a
// genuinely public origin and want absolute links (e.g. to skip CID inlining).
func saveCampaignImageLocal(storedName string, src io.Reader) (string, bool) {
	dir := filepath.Join(UploadRoot(), "campaign-images")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		slog.Error("campaign image local save: mkdir failed", "dir", dir, "err", err)
		return "", false
	}
	dst, err := os.Create(filepath.Join(dir, storedName))
	if err != nil {
		slog.Error("campaign image local save: create failed", "err", err)
		return "", false
	}
	defer dst.Close()
	if _, err := io.Copy(dst, src); err != nil {
		slog.Error("campaign image local save: copy failed", "err", err)
		return "", false
	}
	rel := "/uploads/campaign-images/" + storedName
	if base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/"); base != "" {
		return base + rel, true
	}
	return rel, true
}

func uploadCampaignImageToR2(storedName, contentType string, file multipartFile) (string, bool) {
	accountID := strings.TrimSpace(os.Getenv("R2_ACCOUNT_ID"))
	bucketName := strings.TrimSpace(os.Getenv("R2_BUCKET_NAME"))
	accessKey := strings.TrimSpace(os.Getenv("R2_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("R2_SECRET_ACCESS_KEY"))
	publicBase := strings.TrimSpace(firstNonEmpty(
		os.Getenv("R2_PUBLIC_BASE_URL"),
		os.Getenv("R2_PUBLIC_URL"),
		os.Getenv("CAMPAIGN_ASSET_BASE_URL"),
	))
	if accountID == "" || bucketName == "" || accessKey == "" || secretKey == "" || publicBase == "" {
		return "", false
	}
	data, err := io.ReadAll(file)
	if err != nil {
		slog.Warn("campaignUploadImage: R2 read failed", "err", err)
		file.Seek(0, io.SeekStart) //nolint:errcheck
		return "", false
	}
	objectKey := "campaign-images/" + storedName
	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s", accountID, bucketName, objectKey)
	if err := r2Put(endpoint, accessKey, secretKey, accountID, bucketName, objectKey, contentType, data); err != nil {
		slog.Warn("campaignUploadImage: R2 upload failed", "err", err)
		file.Seek(0, io.SeekStart) //nolint:errcheck
		return "", false
	}
	return strings.TrimRight(publicBase, "/") + "/" + objectKey, true
}

type multipartFile interface {
	io.Reader
	io.Seeker
}

func recordCampaignUpload(ctx context.Context, db *core.DB, originalName, storedName, mime string, size int64, publicURL string) {
	user := core.UserFromCtx(ctx)
	var uploaderID any
	if user != nil {
		uploaderID = user.ID
	}
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO campaign_uploads (original_name, stored_name, mime_type, size_bytes, url, uploaded_by)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		originalName, storedName, mime, size, publicURL, uploaderID)
}

func absoluteRequestURL(r *http.Request, path string) string {
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	host := firstForwardedValue(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return path
	}
	proto := firstForwardedValue(r.Header.Get("X-Forwarded-Proto"))
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return proto + "://" + host + path
}

func firstForwardedValue(v string) string {
	if i := strings.Index(v, ","); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

// ── Open tracking pixel ───────────────────────────────────────────────────────

// transparent1x1GIF is a minimal 1×1 transparent GIF89a.
var transparent1x1GIF = []byte{
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
	0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
}

// getRealIPFromRequest returns the real client IP using the rightmost X-Forwarded-For value.
// Railway appends the real IP last; the leftmost value is attacker-controlled.
// H7: Used in trackClick and trackOpen.
func getRealIPFromRequest(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := strings.Split(fwd, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if v := strings.TrimSpace(parts[i]); v != "" {
				return v
			}
		}
	}
	return r.RemoteAddr
}

func trackOpen(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		trackingID := chi.URLParam(r, "tracking_id")
		trackingID = strings.TrimSuffix(trackingID, ".gif")

		if trackingID != "" {
			// Capture IP and UA before the goroutine; use rightmost X-Forwarded-For value
			// (Railway appends the real client IP last).
			ip := getRealIPFromRequest(r)
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
					     (campaign_id, contact_id, tracking_id, event_type, channel, ip_address, user_agent)
					 VALUES ($1, $2, $3, 'opened', 'email', $4, $5)`,
					campaignID, contactID, trackingID, ip, ua)
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

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func roundPct(v float64) float64 {
	// Round to 1 decimal place
	return float64(int64(v*10+0.5)) / 10
}

// ── Marketing overview (landing dashboard) ───────────────────────────────────
// One round-trip powering the Marketing Overview: campaign counts by status,
// all-time + 30-day performance, channel mix, audience reach (lists/contacts/
// segments), template counts by channel, and recent campaigns.
func marketingOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Campaign status counts (full book).
		statusCounts := map[string]int64{}
		var totalCampaigns int64
		if rows, err := db.PGQuery(ctx, `SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status`); err == nil {
			for _, row := range rows {
				c := toInt64(row["n"])
				statusCounts[str(row["status"])] = c
				totalCampaigns += c
			}
		}

		// Performance — all-time and last 30 days.
		perf := func(where string) map[string]any {
			q := `SELECT
				COALESCE(SUM(emails_sent + sms_sent + whatsapp_sent),0)               AS sent,
				COALESCE(SUM(emails_delivered + sms_delivered + whatsapp_delivered),0) AS delivered,
				COALESCE(SUM(emails_opened),0)                                        AS opened,
				COALESCE(SUM(emails_clicked),0)                                       AS clicked
				FROM campaigns WHERE ` + where
			m := map[string]any{"sent": int64(0), "delivered": int64(0), "opened": int64(0), "clicked": int64(0), "open_rate": 0.0, "delivery_rate": 0.0}
			if rows, err := db.PGQuery(ctx, q); err == nil && len(rows) > 0 {
				sent := toInt64(rows[0]["sent"])
				delivered := toInt64(rows[0]["delivered"])
				opened := toInt64(rows[0]["opened"])
				m["sent"] = sent
				m["delivered"] = delivered
				m["opened"] = opened
				m["clicked"] = toInt64(rows[0]["clicked"])
				if sent > 0 {
					m["delivery_rate"] = roundPct(float64(delivered) / float64(sent) * 100)
					m["open_rate"] = roundPct(float64(opened) / float64(sent) * 100)
				}
			}
			return m
		}

		// Channel mix — campaigns + sent volume by type.
		channelMix := []map[string]any{}
		if rows, err := db.PGQuery(ctx, `
			SELECT type,
			       COUNT(*) AS campaigns,
			       COALESCE(SUM(emails_sent + sms_sent + whatsapp_sent),0) AS sent
			FROM campaigns GROUP BY type ORDER BY sent DESC`); err == nil {
			for _, row := range rows {
				channelMix = append(channelMix, map[string]any{
					"type":      str(row["type"]),
					"campaigns": toInt64(row["campaigns"]),
					"sent":      toInt64(row["sent"]),
				})
			}
		}

		// Audience — lists, total contacts, saved segments.
		audience := map[string]any{"lists": int64(0), "contacts": int64(0), "segments": int64(0)}
		if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS lists, COALESCE(SUM(member_count),0) AS contacts FROM contact_lists`); err == nil && len(rows) > 0 {
			audience["lists"] = toInt64(rows[0]["lists"])
			audience["contacts"] = toInt64(rows[0]["contacts"])
		}
		if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM contact_segments`); err == nil && len(rows) > 0 {
			audience["segments"] = toInt64(rows[0]["n"])
		}

		// Templates by channel.
		templates := []map[string]any{}
		var totalTemplates int64
		if rows, err := db.PGQuery(ctx, `SELECT channel, COUNT(*) AS n FROM message_templates GROUP BY channel ORDER BY n DESC`); err == nil {
			for _, row := range rows {
				n := toInt64(row["n"])
				totalTemplates += n
				templates = append(templates, map[string]any{"channel": str(row["channel"]), "count": n})
			}
		}

		// Recent campaigns.
		recent := []map[string]any{}
		if rows, err := db.PGQuery(ctx, `
			SELECT id, name, type, status, total_contacts,
			       (emails_sent + sms_sent + whatsapp_sent) AS sent,
			       (emails_opened) AS opened, created_at
			FROM campaigns ORDER BY created_at DESC LIMIT 6`); err == nil {
			for _, row := range rows {
				recent = append(recent, map[string]any{
					"id":             toInt64(row["id"]),
					"name":           str(row["name"]),
					"type":           str(row["type"]),
					"status":         str(row["status"]),
					"total_contacts": toInt64(row["total_contacts"]),
					"sent":           toInt64(row["sent"]),
					"opened":         toInt64(row["opened"]),
					"created_at":     row["created_at"],
				})
			}
		}

		respond(w, map[string]any{
			"campaigns": map[string]any{
				"total":     totalCampaigns,
				"active":    statusCounts["active"],
				"scheduled": statusCounts["scheduled"],
				"completed": statusCounts["completed"],
				"draft":     statusCounts["draft"],
				"paused":    statusCounts["paused"],
				"cancelled": statusCounts["cancelled"],
			},
			"performance_all":  perf("1=1"),
			"performance_30d":  perf("created_at >= NOW() - interval '30 days'"),
			"channel_mix":      channelMix,
			"audience":         audience,
			"templates":        templates,
			"templates_total":  totalTemplates,
			"recent_campaigns": recent,
		}, "postgres")
	}
}

// campaignsSummary returns full-book status counts so the All Campaigns KPI
// strip reflects the whole book, not just the currently-loaded page.
func campaignsSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		counts := map[string]any{"total": int64(0), "active": int64(0), "scheduled": int64(0),
			"completed": int64(0), "draft": int64(0), "paused": int64(0), "cancelled": int64(0)}
		var total int64
		if rows, err := db.PGQuery(r.Context(), `SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status`); err == nil {
			for _, row := range rows {
				n := toInt64(row["n"])
				counts[str(row["status"])] = n
				total += n
			}
		}
		counts["total"] = total
		respond(w, counts, "postgres")
	}
}
