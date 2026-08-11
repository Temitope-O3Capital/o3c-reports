package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// Multi-step scheduled campaigns (sequence engine). A sequence campaign has an
// ordered list of steps; each step sends a saved template on a channel at a
// day-offset from launch or an absolute time. A background ticker fires steps
// as they come due; the campaign stays active until the last step has sent.
// See migration 119_campaign_sequences.sql.

func RegisterCampaignSteps(r chi.Router, db *core.DB) {
	access := core.RequirePages("campaigns")
	r.With(access).Get("/{id}/steps", listSteps(db))
	r.With(access).Post("/{id}/steps", createStep(db))
	r.With(access).Put("/{id}/steps/{sid}", updateStep(db))
	r.With(access).Delete("/{id}/steps/{sid}", deleteStep(db))
	r.With(access).Post("/{id}/launch-sequence", launchSequence(db))
}

func listSteps(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT s.id, s.campaign_id, s.step_no, s.channel, s.template_id,
			       s.schedule_mode, s.offset_days, s.send_at, s.status,
			       s.scheduled_for, s.sent_at, s.sent_count, s.failed_count,
			       s.audience_filter,
			       t.name AS template_name
			FROM campaign_steps s
			LEFT JOIN message_templates t ON t.id = s.template_id
			WHERE s.campaign_id=$1
			ORDER BY s.step_no ASC, s.id ASC`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

type stepBody struct {
	StepNo         int    `json:"step_no"`
	Channel        string `json:"channel"`
	TemplateID     *int64 `json:"template_id"`
	ScheduleMode   string `json:"schedule_mode"`
	OffsetDays     int    `json:"offset_days"`
	SendAt         string `json:"send_at"`
	AudienceFilter string `json:"audience_filter"`
}

var stepAudienceFilters = map[string]bool{
	"all": true, "delivered": true, "not_delivered": true,
	"opened": true, "not_opened": true, "clicked": true,
}

// audienceFilterSQL returns an AND-clause narrowing campaign_contacts to a
// prior-engagement segment. Empty string = the whole audience.
func audienceFilterSQL(f string) string {
	switch f {
	case "delivered":
		return " AND (email_status IN ('delivered','opened','clicked') OR sms_status='delivered' OR whatsapp_status='delivered')"
	case "not_delivered":
		return " AND NOT (email_status IN ('delivered','opened','clicked') OR sms_status='delivered' OR whatsapp_status='delivered')"
	case "opened":
		return " AND email_status IN ('opened','clicked')"
	case "not_opened":
		return " AND (email_status IS NULL OR email_status NOT IN ('opened','clicked'))"
	case "clicked":
		return " AND email_status='clicked'"
	default:
		return ""
	}
}

func createStep(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b stepBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Channel != "email" && b.Channel != "sms" && b.Channel != "whatsapp" {
			respondErr(w, 422, "channel must be email, sms or whatsapp")
			return
		}
		if b.ScheduleMode != "absolute" {
			b.ScheduleMode = "offset"
		}
		if !stepAudienceFilters[b.AudienceFilter] {
			b.AudienceFilter = "all"
		}
		var sendAt any
		if b.SendAt != "" {
			sendAt = b.SendAt
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO campaign_steps (campaign_id, step_no, channel, template_id, schedule_mode, offset_days, send_at, audience_filter)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
			id, b.StepNo, b.Channel, b.TemplateID, b.ScheduleMode, b.OffsetDays, sendAt, b.AudienceFilter)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateStep(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		var b stepBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ScheduleMode != "absolute" {
			b.ScheduleMode = "offset"
		}
		if !stepAudienceFilters[b.AudienceFilter] {
			b.AudienceFilter = "all"
		}
		var sendAt any
		if b.SendAt != "" {
			sendAt = b.SendAt
		}
		rows, err := db.PGQuery(r.Context(), `
			UPDATE campaign_steps
			SET step_no=$1, channel=$2, template_id=$3, schedule_mode=$4, offset_days=$5, send_at=$6, audience_filter=$7, updated_at=NOW()
			WHERE id=$8 RETURNING *`,
			b.StepNo, b.Channel, b.TemplateID, b.ScheduleMode, b.OffsetDays, sendAt, b.AudienceFilter, sid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Step not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteStep(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		db.PGExec(r.Context(), "DELETE FROM campaign_steps WHERE id=$1", sid) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// launchSequence resolves each step's fire time, snapshots the audience, and
// marks the campaign an active sequence. Steps then fire via SequenceStepTicker.
func launchSequence(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ctx := r.Context()

		steps, err := db.PGQuery(ctx, `SELECT id, schedule_mode, offset_days, send_at FROM campaign_steps WHERE campaign_id=$1 ORDER BY step_no`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if len(steps) == 0 {
			respondErr(w, 422, "Add at least one step before launching the sequence")
			return
		}
		now := time.Now()
		for _, s := range steps {
			var sf time.Time
			if str(s["schedule_mode"]) == "absolute" && s["send_at"] != nil {
				if t, ok := s["send_at"].(time.Time); ok {
					sf = t
				} else if ts, ok := s["send_at"].(string); ok {
					if parsed, e := time.Parse(time.RFC3339, ts); e == nil {
						sf = parsed
					}
				}
			}
			if sf.IsZero() {
				sf = now.Add(time.Duration(toInt64(s["offset_days"])) * 24 * time.Hour)
			}
			db.PGExec(ctx, `UPDATE campaign_steps SET scheduled_for=$1, status='pending', updated_at=NOW() WHERE id=$2`, sf, toInt64(s["id"])) //nolint:errcheck
		}

		// Snapshot the audience now and mark the campaign a running sequence.
		prepareCampaignRecipients(ctx, db, mustInt64(id))
		db.PGExec(ctx, `UPDATE campaigns SET is_sequence=TRUE, status='active', started_at=COALESCE(started_at, NOW()), updated_at=NOW() WHERE id=$1`, id) //nolint:errcheck

		respond(w, map[string]any{"launched": true, "steps": len(steps)}, "db")
	}
}

func mustInt64(s string) int64 { return toInt64(s) }

// ── Step dispatch + scheduler ─────────────────────────────────────────────────

// SequenceStepTicker fires campaign steps whose scheduled_for has passed. Call as:
//
//	go SequenceStepTicker(db)
func SequenceStepTicker(db *core.DB) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		rows, err := db.PGQuery(ctx, `
			SELECT s.id, s.campaign_id
			FROM campaign_steps s
			JOIN campaigns c ON c.id = s.campaign_id
			WHERE s.status='pending' AND s.scheduled_for IS NOT NULL AND s.scheduled_for <= NOW()
			  AND c.is_sequence = TRUE AND c.status IN ('active','scheduled')`)
		cancel()
		if err != nil {
			WorkerBeat(context.Background(), db, "sequence_ticker", "error", err.Error(), "")
			continue
		}
		advanced := 0
		for _, row := range rows {
			stepID := toInt64(row["id"])
			campaignID := toInt64(row["campaign_id"])
			// Claim the step so a later tick doesn't double-send it.
			res, e := db.PGExec(context.Background(), `UPDATE campaign_steps SET status='sending', updated_at=NOW() WHERE id=$1 AND status='pending'`, stepID)
			if e != nil {
				continue
			}
			if n, _ := res.RowsAffected(); n == 0 {
				continue
			}
			db.PGExec(context.Background(), `UPDATE campaigns SET status='active', started_at=COALESCE(started_at, NOW()), updated_at=NOW() WHERE id=$1 AND status='scheduled'`, campaignID) //nolint:errcheck
			go dispatchStep(db, campaignID, stepID)
			advanced++
		}
		WorkerBeat(context.Background(), db, "sequence_ticker", "ok", fmt.Sprintf("%d steps advanced", advanced), "")
	}
}

// dispatchStep sends one step's template to the whole snapshotted audience.
func dispatchStep(db *core.DB, campaignID, stepID int64) {
	ctx := context.Background()
	stepRows, _ := db.PGQuery(ctx, `
		SELECT s.channel, s.template_id, s.audience_filter, c.from_email, c.from_name
		FROM campaign_steps s JOIN campaigns c ON c.id = s.campaign_id
		WHERE s.id=$1`, stepID)
	if len(stepRows) == 0 {
		return
	}
	st := stepRows[0]
	channel := str(st["channel"])

	var tpl map[string]any
	if tid := toInt64(st["template_id"]); tid > 0 {
		if tr, _ := db.PGQuery(ctx, `SELECT * FROM message_templates WHERE id=$1`, tid); len(tr) > 0 {
			tpl = tr[0]
		}
	}
	if tpl == nil {
		db.PGExec(ctx, `UPDATE campaign_steps SET status='skipped', updated_at=NOW() WHERE id=$1`, stepID) //nolint:errcheck
		completeSequenceIfDone(ctx, db, campaignID)
		return
	}

	prepareCampaignRecipients(ctx, db, campaignID)
	contacts, _ := db.PGQuery(ctx, `SELECT * FROM campaign_contacts WHERE campaign_id=$1`+audienceFilterSQL(str(st["audience_filter"])), campaignID)

	fromEmail := coalesce(str(st["from_email"]), resolveCredKey(ctx, db, "SENDGRID_FROM_EMAIL"))
	fromName := coalesce(str(st["from_name"]), coalesce(resolveCredKey(ctx, db, "SENDGRID_FROM_NAME"), "O3 Capital"))
	sendDelay := time.Duration(intSetting(ctx, db, "campaign_send_delay_ms", 250)) * time.Millisecond

	sent, failed := 0, 0
	for _, c := range contacts {
		md := campaignContactMergeData(c)
		ok := false
		switch channel {
		case "email":
			if str(c["email"]) == "" {
				continue
			}
			subject := renderTemplate(str(tpl["email_subject"]), md)
			html := renderTemplate(str(tpl["email_body_html"]), md)
			text := renderTemplate(str(tpl["email_body_text"]), md)
			name := strings.TrimSpace(str(c["first_name"]) + " " + str(c["last_name"]))
			ok, _ = sendEmail(ctx, db, str(c["email"]), name, fromEmail, fromName, subject, html, text, str(c["id"]))
		case "sms":
			if str(c["phone"]) == "" {
				continue
			}
			body := withSMSOptOut(renderTemplate(str(tpl["sms_body"]), md))
			ok, _ = sendSMS(ctx, db, str(c["phone"]), body)
		case "whatsapp":
			if str(c["phone"]) == "" {
				continue
			}
			body := renderTemplate(str(tpl["whatsapp_body"]), md)
			ok, _ = sendWhatsAppCampaign(ctx, db, str(c["phone"]), body, "")
		}
		if ok {
			sent++
		} else {
			failed++
		}
		time.Sleep(sendDelay)
	}

	db.PGExec(ctx, `UPDATE campaign_steps SET status='sent', sent_at=NOW(), sent_count=$1, failed_count=$2, updated_at=NOW() WHERE id=$3`, sent, failed, stepID) //nolint:errcheck
	completeSequenceIfDone(ctx, db, campaignID)
}

// completeSequenceIfDone marks the campaign completed once no steps remain.
func completeSequenceIfDone(ctx context.Context, db *core.DB, campaignID int64) {
	rem, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM campaign_steps WHERE campaign_id=$1 AND status IN ('pending','sending')`, campaignID)
	if len(rem) > 0 && toInt64(rem[0]["n"]) == 0 {
		db.PGExec(ctx, `UPDATE campaigns SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1 AND is_sequence=TRUE`, campaignID) //nolint:errcheck
	}
}
