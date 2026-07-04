package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/o3c/reports/core"
)

// Event type constants — used as the `type` column in notifications
// and as the key in notification_event_config / notification_preferences.
const (
	EvtTaskAssigned      = "task_assigned"
	EvtTaskDueSoon       = "task_due_soon"
	EvtTaskOverdue       = "task_overdue"
	EvtBirthdaySoon      = "birthday_soon"
	EvtBirthdayToday     = "birthday_today"
	EvtLoanSubmitted     = "loan_submitted"
	EvtLoanStageChanged  = "loan_stage_changed"
	EvtLoanApproved      = "loan_approved"
	EvtLoanRejected      = "loan_rejected"
	EvtTicketAssigned    = "ticket_assigned"
	EvtTicketReplied     = "ticket_replied"
	EvtTicketSLABreach   = "ticket_sla_breach"
	EvtDealStageChanged  = "deal_stage_changed"
	EvtCRMRequestCreated = "crm_request_created"

	// Wave 5H — extended event matrix
	EvtTicketSLAWarning      = "ticket_sla_warning"
	EvtTicketUnassignedAlert = "ticket_unassigned_alert"
	EvtCSATLowScore          = "csat_low_score"
	EvtAMLWatchlistHit       = "aml_watchlist_hit"
	EvtSARFiled              = "sar_filed"
	EvtPTPDueToday           = "ptp_due_today"
	EvtPTPBroken             = "ptp_broken"
	EvtAccountDPD90          = "account_dpd90"
	EvtFDMaturing7Days       = "fd_maturing_7days"
	EvtFDMaturedUnactioned   = "fd_matured_unactioned"
	EvtCampaignDeliveryFailed = "campaign_delivery_failed"
	EvtAPIKeyExpiry          = "api_key_expiry"
	EvtSystemAlert           = "system_alert"
	EvtNewAccountCreated     = "new_account_created"
	EvtFirstLogin            = "first_login"
)

// NotifPayload carries everything needed to dispatch a notification.
type NotifPayload struct {
	EventType string
	UserID    int64
	Title     string
	Body      string
	ActionURL string
	EntityRef string
}

// Notify dispatches a notification to one user across all channels they have enabled.
// Global admin config is checked first; user override is applied on top.
// Safe to call in a goroutine.
func Notify(ctx context.Context, db *core.DB, p NotifPayload) {
	users, err := db.PGQuery(ctx,
		`SELECT id, email, phone, full_name FROM o3c_users WHERE id=$1`, p.UserID)
	if err != nil || len(users) == 0 {
		return
	}
	u := users[0]

	// Global channel config for this event
	cfgRows, _ := db.PGQuery(ctx,
		`SELECT channel, enabled FROM notification_event_config WHERE event_type=$1`, p.EventType)
	globalEnabled := map[string]bool{}
	for _, row := range cfgRows {
		globalEnabled[str(row["channel"])] = row["enabled"] == true
	}

	// Per-user overrides
	prefRows, _ := db.PGQuery(ctx,
		`SELECT channel, enabled FROM notification_preferences
		 WHERE user_id=$1 AND event_type=$2`, p.UserID, p.EventType)
	userPref := map[string]bool{}
	for _, row := range prefRows {
		userPref[str(row["channel"])] = row["enabled"] == true
	}

	// channelOn: user override wins; if no override, use global default.
	// If global disables a channel, it can never be re-enabled by user prefs.
	channelOn := func(ch string) bool {
		gOn, gSet := globalEnabled[ch]
		if !gSet || !gOn {
			return false
		}
		if uOn, uSet := userPref[ch]; uSet {
			return uOn
		}
		return gOn
	}

	// ── In-app ────────────────────────────────────────────────────────────────
	if channelOn("in_app") {
		if _, err := db.PGExec(ctx,
			`INSERT INTO notifications (user_id, type, title, body, action_url, entity_ref)
			 VALUES ($1,$2,$3,$4,$5,$6)`,
			p.UserID, p.EventType, p.Title, p.Body, p.ActionURL, p.EntityRef); err != nil {
			slog.Error("notify: in_app insert failed", "error", err, "event", p.EventType)
		}
	}

	// ── Email ──────────────────────────────────────────────────────────────────
	if channelOn("email") {
		if email := str(u["email"]); email != "" {
			name    := str(u["full_name"])
			logoURL := resolveCredKey(ctx, db, "EMAIL_LOGO_URL")
			htmlBody := buildNotifEmail(p.Title, p.Body, p.ActionURL, logoURL)
			go func() {
				res := SendMail(ctx, db, SendMailOptions{
					To:       []MailAddress{{Email: email, Name: name}},
					Subject:  p.Title,
					HTMLBody: htmlBody,
					TextBody: p.Title + "\n\n" + p.Body,
					Kind:     "notification",
					Category: "notification",
					// List-Unsubscribe header — Gmail one-click requirement
					CustomArgs: map[string]string{"o3c_notif_event": p.EventType},
				})
				if !res.OK {
					slog.Warn("notify: email failed", "event", p.EventType, "user", p.UserID, "err", res.Error)
				}
			}()
		}
	}

	// ── SMS ────────────────────────────────────────────────────────────────────
	if channelOn("sms") {
		if phone := str(u["phone"]); phone != "" {
			msg := fmt.Sprintf("O3 Capital: %s — %s", p.Title, p.Body)
			if len(msg) > 160 {
				msg = msg[:157] + "..."
			}
			go func() {
				if ok, _ := sendSMS(ctx, db, phone, msg); !ok {
					slog.Warn("notify: sms failed", "event", p.EventType, "user", p.UserID)
				}
			}()
		}
	}

	// ── WhatsApp ───────────────────────────────────────────────────────────────
	if channelOn("whatsapp") {
		if phone := str(u["phone"]); phone != "" {
			msg := fmt.Sprintf("*%s*\n\n%s", p.Title, p.Body)
			if p.ActionURL != "" {
				msg += "\n\n" + p.ActionURL
			}
			go func() {
				if ok, _ := sendWhatsApp(ctx, db, phone, msg); !ok {
					slog.Warn("notify: whatsapp failed", "event", p.EventType, "user", p.UserID)
				}
			}()
		}
	}
}

// NotifyRole sends to every active user with the given role.
func NotifyRole(ctx context.Context, db *core.DB, role string, p NotifPayload) {
	rows, _ := db.PGQuery(ctx,
		`SELECT id FROM o3c_users WHERE role=$1 AND is_active=TRUE`, role)
	for _, row := range rows {
		uid, _ := row["id"].(int64)
		if uid == 0 {
			continue
		}
		cp := p
		cp.UserID = uid
		go Notify(ctx, db, cp)
	}
}

// NotifyRoles sends to all active users whose role is in the given list.
func NotifyRoles(ctx context.Context, db *core.DB, roles []string, p NotifPayload) {
	for _, role := range roles {
		NotifyRole(ctx, db, role, p)
	}
}

func buildNotifEmail(title, body, actionURL, logoURL string) string {
	appURL   := coalesce(os.Getenv("APP_URL"), "https://reports.o3cards.com")
	prefsURL := appURL + "/settings/notifications"

	logoTag := ""
	if logoURL != "" {
		logoTag = fmt.Sprintf(
			`<img src="%s" alt="O3 Capital" height="32" style="display:block;margin-bottom:12px" />`,
			logoURL)
	}

	btn := ""
	if actionURL != "" {
		btn = fmt.Sprintf(
			`<a href="%s%s" style="display:inline-block;background:#0E2841;color:white;`+
				`padding:10px 20px;border-radius:6px;text-decoration:none;`+
				`font-size:13px;font-weight:600;margin-top:16px">View Details →</a>`,
			appURL, actionURL)
	}
	return fmt.Sprintf(`
<div style="font-family:DM Sans,sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#0E2841;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
    %s
    <h2 style="margin:0;font-size:16px;font-weight:600">%s</h2>
  </div>
  <div style="background:#F4F6F8;padding:20px 24px;border-radius:0 0 8px 8px">
    <p style="margin:0;color:#334155;font-size:14px;line-height:1.6">%s</p>
    %s
    <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0 16px" />
    <p style="margin:0;font-size:11px;color:#94A3B8;line-height:1.6">
      This notification was sent by O3 Capital.<br/>
      <a href="%s" style="color:#0E2841;text-decoration:underline">Manage notification preferences</a>
      &nbsp;&middot;&nbsp;
      You received this because you are a staff member of O3 Capital.
    </p>
  </div>
</div>`, logoTag, title, body, btn, prefsURL)
}
