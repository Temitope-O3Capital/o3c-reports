package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/o3c/reports/core"
)

// parseChannelMap decodes a `channels` jsonb value (map, string, or []byte) into
// a channel→enabled map. Used for notification_defaults / notification_preferences,
// whose channels column is jsonb like {"in_app":true,"email":false,"sms":false}.
func parseChannelMap(v any) map[string]bool {
	out := map[string]bool{}
	var m map[string]any
	switch t := v.(type) {
	case map[string]any:
		m = t
	case string:
		_ = json.Unmarshal([]byte(t), &m)
	case []byte:
		_ = json.Unmarshal(t, &m)
	}
	for k, val := range m {
		if b, ok := val.(bool); ok {
			out[k] = b
		}
	}
	return out
}

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
	EvtTicketSLAWarning       = "ticket_sla_warning"
	EvtTicketUnassignedAlert  = "ticket_unassigned_alert"
	EvtCSATLowScore           = "csat_low_score"
	EvtAMLWatchlistHit        = "aml_watchlist_hit"
	EvtSARFiled               = "sar_filed"
	EvtPTPDueToday            = "ptp_due_today"
	EvtPTPBroken              = "ptp_broken"
	EvtAccountDPD90           = "account_dpd90"
	EvtFDMaturing7Days        = "fd_maturing_7days"
	EvtFDMaturedUnactioned    = "fd_matured_unactioned"
	EvtCampaignDeliveryFailed = "campaign_delivery_failed"
	EvtAPIKeyExpiry           = "api_key_expiry"
	EvtSystemAlert            = "system_alert"
	EvtNewAccountCreated      = "new_account_created"
	EvtFirstLogin             = "first_login"

	// Recovery events
	EvtRecoveryCaseAssigned   = "recovery_case_assigned"
	EvtRecoveryLegalMilestone = "recovery_legal_milestone"
	EvtRecoveryDebtSale       = "recovery_debt_sale"

	// Cards events
	EvtCardDisputeFiled      = "card_dispute_filed"
	EvtCreditLimitApproved   = "credit_limit_approved"
	EvtBillingCycleGenerated = "billing_cycle_generated"

	// Collections events
	EvtRepaymentPlanCreated = "repayment_plan_created"
	EvtWriteoffApproved     = "writeoff_approved"

	// Compliance events
	EvtFindingCreated = "finding_created"
	EvtFindingClosed  = "finding_closed"

	// HR events
	EvtLeaveApproved = "leave_approved"
	EvtLeaveDeclined = "leave_declined"

	// Finance events
	EvtManualPostingSubmitted = "manual_posting_submitted"
	EvtManualPostingApproved  = "manual_posting_approved"
	EvtManualPostingRejected  = "manual_posting_rejected"

	// Payroll events
	EvtPayrollPaid = "payroll_paid"

	// Call-centre: a scheduled call-back has come due for the assigned agent.
	EvtCallbackDue = "callback_due"

	// Sales account-manager portfolio alerts (daily worker)
	EvtLoanRepaymentDueSoon  = "loan_repayment_due_soon"  // 7 days before next_due_date
	EvtLoanRepaymentDue3Days = "loan_repayment_due_3days" // 3 days before next_due_date
	EvtLoanRepaymentDueToday = "loan_repayment_due_today" // on the due date
	EvtLoanPastDue           = "loan_past_due"            // DPD > 0 (daily)
	EvtFDMaturing3Days       = "fd_maturing_3days"        // 3 days before maturity_date
	EvtFDMaturingToday       = "fd_maturing_today"        // maturity_date = today
)

// NotifPayload carries everything needed to dispatch a notification.
type NotifPayload struct {
	EventType string
	UserID    int64
	Title     string
	Body      string
	ActionURL string
	EntityRef string

	// GroupKey collapses a class of events into ONE live in-app notification per
	// user. While an unread row with the same key exists it is updated in place
	// and its group_count incremented, instead of a new row being inserted.
	//
	// This exists because the unassigned-ticket alert fired once per ticket and
	// produced 4,133 notifications for two people, who then stopped reading any of
	// them. A digest ("1,000 tickets unassigned") stays useful at any volume.
	// Email/SMS are suppressed on a grouped re-send so only the first one pings.
	GroupKey string

	// Priority drives ordering and styling in the bell: low | normal | high | urgent.
	Priority string
}

// Notify dispatches a notification to one user across all channels they have enabled.
// Global admin config is checked first; user override is applied on top.
// Safe to call in a goroutine.
func Notify(ctx context.Context, db *core.DB, p NotifPayload) {
	users, err := db.PGQuery(ctx,
		`SELECT id, email, phone, full_name, role FROM o3c_users WHERE id=$1`, p.UserID)
	if err != nil || len(users) == 0 {
		return
	}
	u := users[0]

	// Channel resolution against the REAL schema (the three tables differ in shape):
	//   1. notification_defaults(role, event_type, channels jsonb, is_enabled) — role defaults
	//   2. notification_event_config(event_type, channel, enabled)             — admin global per-channel
	//   3. notification_preferences(user_id, event_type, channels jsonb)       — per-user override
	// Precedence: role defaults → admin config → user prefs (later wins).
	//
	// Resolution is table-driven across ALL FOUR channels. It used to track only
	// in_app and email in two bools, with a channelOn() that returned false for
	// anything else — so the sms and whatsapp blocks below were unreachable dead
	// code. Nine event/channel pairs were switched ON in notification_event_config
	// (including ticket_sla_breach → sms) and had never once sent.
	//
	// Defaults: in-app and email on; sms and whatsapp off, because they cost money
	// and reach people out of hours — they stay opt-in per event via
	// Admin → Notification Settings.
	chans := map[string]bool{"in_app": true, "email": true, "sms": false, "whatsapp": false}
	apply := func(m map[string]bool) {
		for k, v := range m {
			if _, known := chans[k]; known {
				chans[k] = v
			}
		}
	}

	// Layer 1: role defaults (channels jsonb), gated by is_enabled.
	if rows, _ := db.PGQuery(ctx,
		`SELECT channels, is_enabled FROM notification_defaults WHERE role=$1 AND event_type=$2`,
		str(u["role"]), p.EventType); len(rows) > 0 {
		if rows[0]["is_enabled"] == false {
			for k := range chans {
				chans[k] = false
			}
		} else {
			apply(parseChannelMap(rows[0]["channels"]))
		}
	}
	// Layer 2: admin per-channel event config (overrides defaults).
	if rows, _ := db.PGQuery(ctx,
		`SELECT channel, enabled FROM notification_event_config WHERE event_type=$1`, p.EventType); len(rows) > 0 {
		for _, row := range rows {
			if k := str(row["channel"]); k != "" {
				if _, known := chans[k]; known {
					chans[k] = row["enabled"] == true
				}
			}
		}
	}
	// Layer 3: per-user override (channels jsonb).
	if rows, _ := db.PGQuery(ctx,
		`SELECT channels FROM notification_preferences WHERE user_id=$1 AND event_type=$2`,
		p.UserID, p.EventType); len(rows) > 0 {
		apply(parseChannelMap(rows[0]["channels"]))
	}

	channelOn := func(ch string) bool { return chans[ch] }

	// grouped reports whether this send folded into an existing unread digest row.
	// When it does, the noisy channels are skipped — the user has already been
	// pinged once for this group and does not need a second email per ticket.
	grouped := false

	// ── In-app ────────────────────────────────────────────────────────────────
	if channelOn("in_app") {
		prio := p.Priority
		if prio == "" {
			prio = "normal"
		}
		if p.GroupKey != "" {
			// Upsert onto idx_notifications_group_unread (unique on user_id+group_key
			// WHERE unread). xmax=0 distinguishes a fresh INSERT from an UPDATE, which
			// is how we know whether the user has already been pinged for this group.
			rows, err := db.PGQuery(ctx,
				`INSERT INTO notifications
				   (user_id, type, title, body, action_url, entity_ref, group_key, group_count, priority, is_read, created_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,FALSE,NOW())
				 ON CONFLICT (user_id, group_key) WHERE group_key IS NOT NULL AND is_read = FALSE
				 DO UPDATE SET title       = EXCLUDED.title,
				               body        = EXCLUDED.body,
				               action_url  = EXCLUDED.action_url,
				               group_count = notifications.group_count + 1,
				               priority    = EXCLUDED.priority,
				               created_at  = NOW()
				 RETURNING (xmax = 0) AS inserted`,
				p.UserID, p.EventType, p.Title, p.Body, p.ActionURL, p.EntityRef, p.GroupKey, prio)
			if err != nil {
				slog.Error("notify: grouped in_app upsert failed", "error", err, "event", p.EventType)
			} else if len(rows) > 0 && rows[0]["inserted"] != true {
				grouped = true
			}
		} else if _, err := db.PGExec(ctx,
			`INSERT INTO notifications (user_id, type, title, body, action_url, entity_ref, entity_type, entity_id, priority, is_read, created_at)
			 VALUES ($1,$2,$3,$4,$5,$6, NULL, NULL, $7, FALSE, NOW())`,
			p.UserID, p.EventType, p.Title, p.Body, p.ActionURL, p.EntityRef, prio); err != nil {
			slog.Error("notify: in_app insert failed", "error", err, "event", p.EventType)
		}
	}

	// A repeat ping for a group the user has already been told about is noise on
	// every channel that leaves the app.
	if grouped {
		return
	}

	// ── Email ──────────────────────────────────────────────────────────────────
	if channelOn("email") {
		if email := str(u["email"]); email != "" {
			name := str(u["full_name"])
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
	NotifyRoles(ctx, db, []string{role}, p)
}

// NotifyRoles sends to all active users whose role is in the given list.
// Admins are ALWAYS copied so they can track every alert (Temitope's request);
// recipients are de-duplicated so no one is notified twice for one event.
func NotifyRoles(ctx context.Context, db *core.DB, roles []string, p NotifPayload) {
	roleSet := map[string]bool{"admin": true} // always copy admins
	for _, r := range roles {
		if r != "" {
			roleSet[r] = true
		}
	}
	seen := map[int64]bool{}
	for role := range roleSet {
		rows, _ := db.PGQuery(ctx,
			`SELECT id FROM o3c_users WHERE role=$1 AND is_active=TRUE`, role)
		for _, row := range rows {
			uid, _ := row["id"].(int64)
			if uid == 0 || seen[uid] {
				continue
			}
			seen[uid] = true
			cp := p
			cp.UserID = uid
			// Detach from the request context so the fire-and-forget insert isn't
			// canceled when the HTTP handler returns (keeps values, drops cancellation).
			go Notify(context.WithoutCancel(ctx), db, cp)
		}
	}
}

// NotifyUsers sends to an explicit set of user ids, de-duplicated, skipping
// zeros. This is the recipient path that was missing: almost every alert in the
// app routed through NotifyRole("call_center_head"), so 4,133 of 4,455
// notifications landed on two people and the eleven agents doing the work were
// told nothing. Anything addressed to specific people should use this.
func NotifyUsers(ctx context.Context, db *core.DB, ids []int64, p NotifPayload) {
	seen := map[int64]bool{}
	for _, id := range ids {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		cp := p
		cp.UserID = id
		go Notify(context.WithoutCancel(ctx), db, cp)
	}
}

// NotifyExcept is NotifyUsers minus one person — normally the actor, who does
// not need telling about something they just did themselves.
func NotifyExcept(ctx context.Context, db *core.DB, ids []int64, except int64, p NotifPayload) {
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id != except {
			out = append(out, id)
		}
	}
	NotifyUsers(ctx, db, out, p)
}

// ticketAudience resolves everyone with a legitimate interest in a ticket:
// its owner, whoever it is escalated to, and anyone who has assisted on it.
// Used so a reply or a resolution reaches the people actually involved rather
// than only the supervisor.
func ticketAudience(ctx context.Context, db *core.DB, ticketID int64) []int64 {
	rows, _ := db.PGQuery(ctx, `
		SELECT t.assigned_to AS id FROM helpdesk_tickets t WHERE t.id=$1 AND t.assigned_to IS NOT NULL
		UNION
		SELECT t.escalated_to FROM helpdesk_tickets t
		 WHERE t.id=$1 AND t.escalated_to IS NOT NULL AND t.escalation_resolved_at IS NULL
		UNION
		SELECT a.helper_user_id FROM ticket_assists a
		 WHERE a.ticket_id=$1 AND a.action <> 'viewed'`, ticketID)
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		if id := toInt64(r["id"]); id > 0 {
			out = append(out, id)
		}
	}
	return out
}

// activeAgentIDs returns the call-centre agents who actually work the queues.
// Leaf agents only — supervisors are notified separately and do not need a copy
// of every agent-level alert.
func activeAgentIDs(ctx context.Context, db *core.DB) []int64 {
	rows, _ := db.PGQuery(ctx, `
		SELECT id FROM o3c_users
		 WHERE is_active = TRUE AND deleted_at IS NULL AND role = 'call_center_agent'
		 ORDER BY id`)
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		if id := toInt64(r["id"]); id > 0 {
			out = append(out, id)
		}
	}
	return out
}

func buildNotifEmail(title, body, actionURL, logoURL string) string {
	appURL := workspaceURL() // APP_BASE_URL → https://crm.o3cards.pri:8443
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
