package handlers

// Care Module workspace — the pieces that turn the helpdesk email channel into a
// full customer-care mailbox:
//
//   • a hold / undo-send window on outbound replies (recall)
//   • an outbox of replies still inside that window
//   • an escalation response-timer with due-soon / overdue alerts
//   • per-mail flagging and subgroups (New Registration, Support, …)
//   • deletion that requires a second team member's approval
//   • "due soon" feeds that drive the SLA + Escalation floating popups
//
// The heavy send machinery (SendMail, hdSendTicketEmail) is reused as-is; this file
// only defers WHEN a reply is dispatched and adds the surrounding workflow.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// careHoldSeconds is how long an outbound reply sits in the outbox before it is
// actually dispatched — the window during which an agent can recall it. Short
// enough not to delay the customer noticeably, long enough to catch a mistake.
const careHoldSeconds = 30

// MAIL_SUBGROUPS is the canonical set of inbox subgroups. Free text in the DB, but
// the UI and classifier work off this list.
var careSubgroups = []string{"New Registration", "Support", "Complaints", "Transactions", "Cards", "Loans", "Fixed Deposit", "General"}

// ── Schema guarantee (mirrors migration 199, runs on every boot) ──────────────

func ensureCareSchema(ctx context.Context, db *core.DB) {
	stmts := []string{
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS escalation_due_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS escalation_warned BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS escalation_overdue_alerted BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS flagged_by BIGINT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS flag_note TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS mail_subgroup TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS deleted_by BIGINT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS delete_requested BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS send_state TEXT NOT NULL DEFAULT 'sent'`,
		`ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS send_after TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS recalled_by BIGINT`,
		`ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS cc_addrs JSONB NOT NULL DEFAULT '[]'`,
		`ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS bcc_addrs JSONB NOT NULL DEFAULT '[]'`,
		`ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS error_text TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_hd_messages_pending ON helpdesk_messages (send_after) WHERE send_state = 'pending'`,
		`CREATE TABLE IF NOT EXISTS helpdesk_delete_requests (
			id BIGSERIAL PRIMARY KEY,
			ticket_id BIGINT NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
			requested_by BIGINT NOT NULL,
			reason TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			decided_by BIGINT,
			decided_at TIMESTAMPTZ,
			decision_note TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_delete_req_open ON helpdesk_delete_requests (ticket_id) WHERE status = 'pending'`,
		`CREATE TABLE IF NOT EXISTS mail_outbox (
			id BIGSERIAL PRIMARY KEY,
			created_by BIGINT NOT NULL,
			from_email TEXT,
			subject TEXT NOT NULL DEFAULT '',
			payload JSONB NOT NULL,
			send_after TIMESTAMPTZ NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			mail_id BIGINT,
			error_text TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			sent_at TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending ON mail_outbox (send_after) WHERE status = 'pending'`,
		// Recover any reply left mid-flight by a crash: send it on the next tick.
		`UPDATE helpdesk_messages SET send_state='pending' WHERE send_state='sending'`,
		// Seed the escalation-timer + delete-request notification config (in-app only).
		`INSERT INTO notification_event_config (event_type, channel, enabled) VALUES
			('escalation_response_due','in_app',TRUE),('escalation_response_due','email',FALSE),
			('escalation_response_overdue','in_app',TRUE),('escalation_response_overdue','email',FALSE),
			('ticket_delete_requested','in_app',TRUE),('ticket_delete_requested','email',FALSE)
		 ON CONFLICT (event_type, channel) DO NOTHING`,
	}
	for _, s := range stmts {
		db.PGExec(ctx, s) //nolint:errcheck
	}
}

// ── Merge context for a ticket reply ──────────────────────────────────────────

func careFirstName(full string) string {
	full = strings.TrimSpace(full)
	if full == "" {
		return "there"
	}
	if i := strings.IndexByte(full, ' '); i > 0 {
		return full[:i]
	}
	return full
}

// careMergeData builds the substitution map used by renderTemplate on a reply, so
// {{customer_name}}, {{ticket_ref}}, {{agent_name}} … are filled server-side.
func careMergeData(ticket core.Row, agentName string) map[string]any {
	name := str(ticket["customer_name"])
	if name == "" {
		name = "Customer"
	}
	return map[string]any{
		"customer_name": name,
		"first_name":    careFirstName(str(ticket["customer_name"])),
		"full_name":     name,
		"ticket_ref":    str(ticket["ticket_ref"]),
		"agent_name":    agentName,
		"customer_email": str(ticket["customer_email"]),
		"cif_number":    str(ticket["customer_cif"]),
		"status":        str(ticket["status"]),
		"priority":      str(ticket["priority"]),
		"company":       "O3 Capital",
	}
}

// ── Outbound dispatcher + escalation timer worker ─────────────────────────────

// StartCareWorkers runs the deferred-send dispatcher and the escalation response
// timer. One goroutine, modest cadence — the whole thing is single-instance.
func StartCareWorkers(db *core.DB) {
	go func() {
		ticker := time.NewTicker(12 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			ctx := context.Background()
			careDispatchPendingReplies(ctx, db)
			careEscalationTimerPass(ctx, db)
			dispatchPendingOutboxMail(ctx, db)
		}
	}()
}

// careDispatchPendingReplies sends every held reply whose window has elapsed.
func careDispatchPendingReplies(ctx context.Context, db *core.DB) {
	claimed, err := db.PGQuery(ctx, `
		UPDATE helpdesk_messages SET send_state='sending'
		WHERE id IN (
			SELECT id FROM helpdesk_messages
			WHERE send_state='pending' AND send_after <= NOW()
			ORDER BY send_after LIMIT 25
		)
		RETURNING id`)
	if err != nil {
		slog.Warn("care dispatch: claim failed", "err", err)
		return
	}
	for _, c := range claimed {
		careDispatchOneReply(ctx, db, toInt64(c["id"]))
	}
}

func careDispatchOneReply(ctx context.Context, db *core.DB, msgID int64) {
	rows, _ := db.PGQuery(ctx, `SELECT * FROM helpdesk_messages WHERE id=$1`, msgID)
	if len(rows) == 0 {
		return
	}
	m := rows[0]
	ticketID := toInt64(m["ticket_id"])
	tRows, _ := db.PGQuery(ctx, `SELECT * FROM helpdesk_tickets WHERE id=$1`, ticketID)
	if len(tRows) == 0 {
		db.PGExec(ctx, `UPDATE helpdesk_messages SET send_state='failed', error_text='ticket missing' WHERE id=$1`, msgID) //nolint:errcheck
		return
	}
	ticket := tRows[0]

	var attachments []MailAttachment
	jsonInto(m["attachments"], &attachments)
	var cc, bcc []MailAddress
	jsonInto(m["cc_addrs"], &cc)
	jsonInto(m["bcc_addrs"], &bcc)

	bodyText := str(m["body_text"])
	bodyHTML := str(m["body_html"])
	channel := str(m["channel"])
	customerEmail := str(ticket["customer_email"])
	customerPhone := str(ticket["customer_phone"])

	failed := ""
	switch {
	case channel == "email" && customerEmail != "":
		res := hdSendTicketEmail(ctx, db, ticket, bodyText, bodyHTML, str(m["email_message_id"]), str(m["in_reply_to"]), str(m["author_name"]), attachments, cc, bcc)
		if !res.OK {
			failed = res.Error
		} else if res.ProviderID != "" {
			db.PGExec(ctx, `UPDATE helpdesk_messages SET provider_message_id=$1 WHERE id=$2`, res.ProviderID, msgID) //nolint:errcheck
		}
	case channel == "sms" && customerPhone != "":
		sendSMS(ctx, db, customerPhone, bodyText)
	case channel == "whatsapp" && customerPhone != "":
		sendWhatsApp(ctx, db, customerPhone, bodyText)
	}

	if failed != "" {
		db.PGExec(ctx, `UPDATE helpdesk_messages SET send_state='failed', error_text=$1 WHERE id=$2`, failed, msgID) //nolint:errcheck
		return
	}
	db.PGExec(ctx, `UPDATE helpdesk_messages SET send_state='sent' WHERE id=$1`, msgID) //nolint:errcheck
}

// careEscalationTimerPass alerts on escalations approaching or past their deadline.
func careEscalationTimerPass(ctx context.Context, db *core.DB) {
	// Due soon: within 30 min of the deadline.
	due, _ := db.PGQuery(ctx, `
		UPDATE helpdesk_tickets SET escalation_warned=TRUE
		WHERE escalated_at IS NOT NULL AND escalation_resolved_at IS NULL
		  AND escalation_due_at IS NOT NULL
		  AND escalation_due_at BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
		  AND escalation_warned=FALSE
		  AND status NOT IN ('resolved','closed') AND deleted_at IS NULL
		RETURNING id, ticket_ref, subject, escalated_to`)
	for _, row := range due {
		careEscalationNotify(ctx, db, row, "escalation_response_due",
			fmt.Sprintf("Escalation due soon: %s", str(row["ticket_ref"])),
			fmt.Sprintf("The escalation on %s is due for a response within 30 minutes.", str(row["ticket_ref"])), "high")
	}

	// Overdue: deadline passed.
	over, _ := db.PGQuery(ctx, `
		UPDATE helpdesk_tickets SET escalation_overdue_alerted=TRUE
		WHERE escalated_at IS NOT NULL AND escalation_resolved_at IS NULL
		  AND escalation_due_at IS NOT NULL AND escalation_due_at < NOW()
		  AND escalation_overdue_alerted=FALSE
		  AND status NOT IN ('resolved','closed') AND deleted_at IS NULL
		RETURNING id, ticket_ref, subject, escalated_to`)
	for _, row := range over {
		careEscalationNotify(ctx, db, row, "escalation_response_overdue",
			fmt.Sprintf("Escalation OVERDUE: %s", str(row["ticket_ref"])),
			fmt.Sprintf("The escalation on %s has passed its response deadline and needs immediate attention.", str(row["ticket_ref"])), "urgent")
	}
}

func careEscalationNotify(ctx context.Context, db *core.DB, row core.Row, evt, title, body, prio string) {
	ticketID := toInt64(row["id"])
	ref := str(row["ticket_ref"])
	p := NotifPayload{
		EventType: evt, Title: title, Body: body,
		ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID), EntityRef: ref, Priority: prio,
	}
	if to := toInt64(row["escalated_to"]); to > 0 {
		go NotifyUsers(context.WithoutCancel(ctx), db, []int64{to}, p)
	}
	go NotifyRole(context.WithoutCancel(ctx), db, "call_center_head", p)
	hdRecordEvent(ctx, db, ticketID, 0, evt, "", ref)
}

// ── Recall ────────────────────────────────────────────────────────────────────

// hdRecallMessage — POST /tickets/{id}/messages/{msgId}/recall
// Cancels a reply that is still inside its hold window.
func hdRecallMessage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		msgID, err := strconv.ParseInt(chi.URLParam(r, "msgId"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid message ID")
			return
		}
		rows, err := db.PGQuery(ctx, `
			UPDATE helpdesk_messages
			   SET send_state='recalled', recalled_at=NOW(), recalled_by=$1
			 WHERE id=$2 AND ticket_id=$3 AND send_state='pending'
			 RETURNING id, ticket_id`, user.ID, msgID, chi.URLParam(r, "id"))
		if err != nil {
			respondErr(w, 500, "Could not recall")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 409, "This reply has already been sent and can no longer be recalled.")
			return
		}
		hdRecordEvent(ctx, db, toInt64(rows[0]["ticket_id"]), user.ID, "reply_recalled", "", "")
		respond(w, map[string]any{"recalled": true}, "json")
	}
}

// ── Outbox ────────────────────────────────────────────────────────────────────

// hdOutbox — GET /outbox
// Replies still in the hold window (+ any that failed to send), so an agent can
// watch and recall them. Supervisors see everyone's; agents see their own.
func hdOutbox(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		where := "m.send_state IN ('pending','failed')"
		args := []any{}
		if !(user.CanSeeAllRows() || user.HasPage("call_center_stats")) {
			args = append(args, user.ID)
			where += " AND m.author_user_id=$1"
		}
		rows, err := db.PGQuery(ctx, `
			SELECT m.id, m.ticket_id, m.channel, m.body_text, m.send_state, m.send_after,
			       m.error_text, m.created_at, m.author_name,
			       EXTRACT(EPOCH FROM (m.send_after - NOW()))::int AS seconds_left,
			       t.ticket_ref, t.subject, t.customer_name, t.customer_email
			  FROM helpdesk_messages m
			  JOIN helpdesk_tickets t ON t.id = m.ticket_id
			 WHERE `+where+`
			 ORDER BY m.send_after ASC
			 LIMIT 200`, args...)
		if err != nil {
			respondErr(w, 500, "Could not load outbox")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── Flag ──────────────────────────────────────────────────────────────────────

// hdFlagTicket — POST /tickets/{id}/flag  {"flagged":true,"note":"..."}
func hdFlagTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		var b struct {
			Flagged bool   `json:"flagged"`
			Note    string `json:"note"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		id := chi.URLParam(r, "id")
		if b.Flagged {
			db.PGExec(ctx, `UPDATE helpdesk_tickets SET is_flagged=TRUE, flagged_at=NOW(), flagged_by=$1, flag_note=NULLIF($2,''), updated_at=NOW() WHERE id=$3`, user.ID, strings.TrimSpace(b.Note), id) //nolint:errcheck
		} else {
			db.PGExec(ctx, `UPDATE helpdesk_tickets SET is_flagged=FALSE, flagged_at=NULL, flagged_by=NULL, flag_note=NULL, updated_at=NOW() WHERE id=$1`, id) //nolint:errcheck
		}
		tid, _ := strconv.ParseInt(id, 10, 64)
		ev := "unflagged"
		if b.Flagged {
			ev = "flagged"
		}
		hdRecordEvent(ctx, db, tid, user.ID, ev, "", strings.TrimSpace(b.Note))
		respond(w, map[string]any{"flagged": b.Flagged}, "json")
	}
}

// ── Subgroup ──────────────────────────────────────────────────────────────────

// hdSetSubgroup — POST /tickets/{id}/subgroup  {"subgroup":"Support"}
func hdSetSubgroup(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		var b struct {
			Subgroup string `json:"subgroup"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		sg := strings.TrimSpace(b.Subgroup)
		id := chi.URLParam(r, "id")
		db.PGExec(ctx, `UPDATE helpdesk_tickets SET mail_subgroup=NULLIF($1,''), updated_at=NOW() WHERE id=$2`, sg, id) //nolint:errcheck
		tid, _ := strconv.ParseInt(id, 10, 64)
		hdRecordEvent(ctx, db, tid, user.ID, "subgroup_changed", "", sg)
		respond(w, map[string]any{"subgroup": sg}, "json")
	}
}

// hdSubgroupCounts — GET /subgroups
// Open-mail counts per subgroup for the inbox rail.
func hdSubgroupCounts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(mail_subgroup,''),'Unsorted') AS subgroup, COUNT(*) AS n
			  FROM helpdesk_tickets
			 WHERE channel='email' AND deleted_at IS NULL AND status NOT IN ('resolved','closed')
			 GROUP BY 1 ORDER BY 2 DESC`)
		if rows == nil {
			rows = []core.Row{}
		}
		var flagged int
		_ = db.PG.QueryRowContext(r.Context(), `
			SELECT COUNT(*) FROM helpdesk_tickets
			 WHERE channel='email' AND deleted_at IS NULL AND is_flagged=TRUE
			   AND status NOT IN ('resolved','closed')`).Scan(&flagged)
		respond(w, map[string]any{"subgroups": careSubgroups, "counts": rows, "flagged": flagged}, "json")
	}
}

// careBackfillSubgroups classifies existing Care email tickets that have no
// mail_subgroup yet (the Zoho-imported backlog never ran through the classifier).
// Self-idempotent: only touches tickets whose mail_subgroup is empty, so it fills
// the folders once and then no-ops. Pure keyword classification, no external calls.
func careBackfillSubgroups(db *core.DB) {
	ctx := context.Background()
	rows, err := db.PGQuery(ctx, `
		SELECT t.id, COALESCE(t.subject,'') AS subject,
		       COALESCE(t.description,'') AS descr,
		       COALESCE((SELECT m.body_text FROM helpdesk_messages m
		                  WHERE m.ticket_id=t.id AND m.direction='inbound'
		                  ORDER BY m.created_at ASC LIMIT 1),'') AS body
		  FROM helpdesk_tickets t
		 WHERE t.channel='email' AND COALESCE(t.mail_subgroup,'')=''
		 LIMIT 10000`)
	if err != nil || len(rows) == 0 {
		return
	}
	slog.Info("care subgroup backfill: starting", "tickets", len(rows))
	n := 0
	for _, row := range rows {
		body := str(row["descr"]) + " " + str(row["body"])
		sg := careClassifySubgroup(str(row["subject"]), body)
		if _, uerr := db.PGExec(ctx,
			`UPDATE helpdesk_tickets SET mail_subgroup=$1 WHERE id=$2 AND COALESCE(mail_subgroup,'')=''`,
			sg, row["id"]); uerr == nil {
			n++
		}
	}
	slog.Info("care subgroup backfill: done", "classified", n)
}

// careBackfillZohoCc recovers the Cc list for OPEN Zoho-imported email tickets whose
// inbound messages predate Cc capture. Self-idempotent: it targets inbound messages
// with cc_addrs IS NULL, so once every open ticket is filled it becomes a no-op.
// Closed tickets are intentionally skipped — Reply all only matters on live mail and
// re-pulling thousands of closed threads from Zoho isn't worth the API cost.
func careBackfillZohoCc(db *core.DB) {
	ctx := context.Background()
	if !zohoEnsureConfigured(ctx, db) {
		return
	}
	rows, err := db.PGQuery(ctx, `
		SELECT DISTINCT t.id, t.ticket_ref
		  FROM helpdesk_tickets t
		  JOIN helpdesk_messages m ON m.ticket_id = t.id
		 WHERE t.channel='email' AND t.source_system='zoho_desk'
		   AND t.ticket_ref LIKE 'ZOHO-%'
		   AND t.status NOT IN ('resolved','closed')
		   AND m.direction='inbound' AND m.cc_addrs IS NULL
		 ORDER BY t.id DESC LIMIT 500`)
	if err != nil || len(rows) == 0 {
		return
	}
	slog.Info("care cc backfill: starting", "tickets", len(rows))
	filled, scanned := 0, 0
	for _, row := range rows {
		zohoID := strings.TrimPrefix(str(row["ticket_ref"]), "ZOHO-")
		if zohoID == "" {
			continue
		}
		convs, cerr := zohoFetchConversations(ctx, zohoID)
		if cerr != nil {
			continue
		}
		for _, c := range convs {
			if !strings.EqualFold(zohoStr(c["type"]), "thread") {
				continue
			}
			extID := zohoStr(c["id"])
			if extID == "" {
				continue
			}
			_, cc, ferr := zohoFetchThread(ctx, zohoID, extID)
			if ferr != nil {
				continue
			}
			scanned++
			ccJSON := careCcJSON(cc)
			if res, uerr := db.PGExec(ctx,
				`UPDATE helpdesk_messages SET cc_addrs=$1::jsonb WHERE external_id=$2 AND cc_addrs IS NULL`,
				ccJSON, extID); uerr == nil && res != nil {
				if n, _ := res.RowsAffected(); n > 0 && string(ccJSON) != "[]" {
					filled++
				}
			}
		}
		// Mark any remaining un-touched inbound rows on this ticket (non-thread) as
		// processed so the ticket drops out of the backfill set on the next pass.
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE helpdesk_messages SET cc_addrs='[]'::jsonb WHERE ticket_id=$1 AND direction='inbound' AND cc_addrs IS NULL`,
			row["id"])
	}
	slog.Info("care cc backfill: done", "tickets", len(rows), "threads_scanned", scanned, "with_cc", filled)
}

// careClassifySubgroup guesses a subgroup from subject/body keywords. Used to
// auto-sort inbound mail; agents can always re-assign.
func careClassifySubgroup(subject, body string) string {
	s := strings.ToLower(subject + " " + body)
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(s, w) {
				return true
			}
		}
		return false
	}
	switch {
	case has("register", "sign up", "signup", "onboard", "new account", "open an account", "activation", "activate"):
		return "New Registration"
	case has("complaint", "dissatisf", "unhappy", "escalate", "not happy", "poor service", "disappointed"):
		return "Complaints"
	case has("transaction", "transfer", "reversal", "debited", "failed payment", "not received", "refund", "charge"):
		return "Transactions"
	case has("card", "atm", "pos", "pin", "cvv", "block my card"):
		return "Cards"
	case has("loan", "repayment", "borrow", "installment", "instalment"):
		return "Loans"
	case has("fixed deposit", "fd ", "investment", "maturity", "tenor"):
		return "Fixed Deposit"
	case has("help", "support", "issue", "problem", "unable", "error", "how do i", "how to"):
		return "Support"
	}
	return "General"
}

// ── Deletion approval ─────────────────────────────────────────────────────────

// hdRequestDelete — POST /tickets/{id}/delete-request  {"reason":"..."}
func hdRequestDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ticketID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ticket ID")
			return
		}
		var b struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		tRows, _ := db.PGQuery(ctx, `SELECT ticket_ref, subject, deleted_at FROM helpdesk_tickets WHERE id=$1`, ticketID)
		if len(tRows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		if tRows[0]["deleted_at"] != nil {
			respondErr(w, 409, "That mail is already deleted")
			return
		}
		ref := str(tRows[0]["ticket_ref"])

		rows, err := db.PGQuery(ctx, `
			INSERT INTO helpdesk_delete_requests (ticket_id, requested_by, reason)
			VALUES ($1,$2,NULLIF($3,''))
			ON CONFLICT (ticket_id) WHERE status='pending' DO NOTHING
			RETURNING id`, ticketID, user.ID, strings.TrimSpace(b.Reason))
		if err != nil {
			respondErr(w, 500, "Could not raise the deletion request")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 409, "A deletion request is already pending on that mail")
			return
		}
		db.PGExec(ctx, `UPDATE helpdesk_tickets SET delete_requested=TRUE, updated_at=NOW() WHERE id=$1`, ticketID) //nolint:errcheck
		hdRecordEvent(ctx, db, ticketID, user.ID, "delete_requested", "", strings.TrimSpace(b.Reason))

		p := NotifPayload{
			EventType: "ticket_delete_requested",
			Title:     fmt.Sprintf("Deletion approval needed: %s", ref),
			Body:      fmt.Sprintf("%s asked to delete %s and needs a colleague to approve it. %s", user.FullName, ref, strings.TrimSpace(b.Reason)),
			ActionURL: "/care/approvals",
			EntityRef: ref,
			Priority:  "high",
		}
		go NotifyRole(context.WithoutCancel(ctx), db, "care_head", p)
		go NotifyRole(context.WithoutCancel(ctx), db, "call_center_head", p)
		respond(w, map[string]any{"requested": true, "request_id": toInt64(rows[0]["id"])}, "json")
	}
}

// hdListDeleteRequests — GET /delete-requests
func hdListDeleteRequests(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		where := "dr.status='pending'"
		if status == "all" {
			where = "TRUE"
		} else if status != "" {
			where = "dr.status='" + strings.ReplaceAll(status, "'", "") + "'"
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT dr.id, dr.ticket_id, dr.reason, dr.status, dr.created_at, dr.decided_at, dr.decision_note,
			       rq.full_name AS requested_by_name, dc.full_name AS decided_by_name,
			       t.ticket_ref, t.subject, t.customer_name, t.customer_email, t.channel
			  FROM helpdesk_delete_requests dr
			  JOIN helpdesk_tickets t ON t.id = dr.ticket_id
			  LEFT JOIN o3c_users rq ON rq.id = dr.requested_by
			  LEFT JOIN o3c_users dc ON dc.id = dr.decided_by
			 WHERE `+where+`
			 ORDER BY dr.status='pending' DESC, dr.created_at DESC
			 LIMIT 200`)
		if err != nil {
			respondErr(w, 500, "Could not load deletion requests")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// hdDecideDelete — POST /delete-requests/{id}/decide  {"approve":true,"note":"..."}
// The approver must be a team member who can work tickets, and cannot be the person
// who requested the deletion — that is the "at least one other team member" rule.
func hdDecideDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		reqID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid request ID")
			return
		}
		var b struct {
			Approve bool   `json:"approve"`
			Note    string `json:"note"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		reqRows, _ := db.PGQuery(ctx, `SELECT * FROM helpdesk_delete_requests WHERE id=$1`, reqID)
		if len(reqRows) == 0 {
			respondErr(w, 404, "Deletion request not found")
			return
		}
		dr := reqRows[0]
		if str(dr["status"]) != "pending" {
			respondErr(w, 409, "That request has already been decided")
			return
		}
		requestedBy := toInt64(dr["requested_by"])
		if requestedBy == user.ID {
			respondErr(w, 403, "A deletion must be approved by a different team member than the one who requested it.")
			return
		}
		if can, _ := hdUserCanWorkTickets(ctx, db, user.ID); !can {
			respondErr(w, 403, "Only a Care/Helpdesk team member can approve a deletion.")
			return
		}
		ticketID := toInt64(dr["ticket_id"])

		newStatus := "rejected"
		if b.Approve {
			newStatus = "approved"
		}
		db.PGExec(ctx, `UPDATE helpdesk_delete_requests SET status=$1, decided_by=$2, decided_at=NOW(), decision_note=NULLIF($3,'') WHERE id=$4`,
			newStatus, user.ID, strings.TrimSpace(b.Note), reqID) //nolint:errcheck

		if b.Approve {
			db.PGExec(ctx, `UPDATE helpdesk_tickets SET deleted_at=NOW(), deleted_by=$1, delete_requested=FALSE, updated_at=NOW() WHERE id=$2`, user.ID, ticketID) //nolint:errcheck
			hdRecordEvent(ctx, db, ticketID, user.ID, "deleted", "", strings.TrimSpace(b.Note))
		} else {
			db.PGExec(ctx, `UPDATE helpdesk_tickets SET delete_requested=FALSE, updated_at=NOW() WHERE id=$1`, ticketID) //nolint:errcheck
			hdRecordEvent(ctx, db, ticketID, user.ID, "delete_rejected", "", strings.TrimSpace(b.Note))
		}

		ref := str(dr["ticket_ref"])
		if ref == "" {
			if tr, _ := db.PGQuery(ctx, `SELECT ticket_ref FROM helpdesk_tickets WHERE id=$1`, ticketID); len(tr) > 0 {
				ref = str(tr[0]["ticket_ref"])
			}
		}
		verb := "approved"
		if !b.Approve {
			verb = "rejected"
		}
		go NotifyUsers(context.WithoutCancel(ctx), db, []int64{requestedBy}, NotifPayload{
			EventType: "ticket_delete_decided",
			Title:     fmt.Sprintf("Deletion %s: %s", verb, ref),
			Body:      fmt.Sprintf("%s %s your request to delete %s. %s", user.FullName, verb, ref, strings.TrimSpace(b.Note)),
			ActionURL: "/care/approvals",
			EntityRef: ref,
		})
		respond(w, map[string]any{"status": newStatus}, "json")
	}
}

// ── Due feeds for the SLA + Escalation popups ─────────────────────────────────

// hdSLADue — GET /sla/due
// Tickets assigned to me that are about to breach or have breached, for the popup.
func hdSLADue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		where := "t.assigned_to = $1"
		args := []any{user.ID}
		if user.CanSeeAllRows() || user.HasPage("call_center_stats") {
			where = "TRUE" // supervisors see every at-risk ticket
			args = nil
		}
		rows, err := db.PGQuery(ctx, `
			SELECT t.id, t.ticket_ref, t.subject, t.priority, t.customer_name,
			       t.sla_due_at, t.sla_breached,
			       EXTRACT(EPOCH FROM (t.sla_due_at - NOW()))::int AS seconds_left
			  FROM helpdesk_tickets t
			 WHERE `+where+`
			   AND t.sla_due_at IS NOT NULL
			   AND t.status NOT IN ('resolved','closed') AND t.deleted_at IS NULL
			   AND (t.sla_breached = TRUE OR t.sla_due_at <= NOW() + INTERVAL '60 minutes')
			 ORDER BY t.sla_due_at ASC
			 LIMIT 25`, args...)
		if err != nil {
			respondErr(w, 500, "Could not load SLA feed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// hdEscalationsDue — GET /escalations/due
// Open escalations assigned TO me that are near or past their response deadline.
func hdEscalationsDue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		where := "t.escalated_to = $1"
		args := []any{user.ID}
		if user.CanSeeAllRows() || user.HasPage("call_center_stats") {
			where = "TRUE"
			args = nil
		}
		rows, err := db.PGQuery(ctx, `
			SELECT t.id, t.ticket_ref, t.subject, t.priority, t.customer_name,
			       t.escalation_due_at, t.escalation_reason,
			       eb.full_name AS escalated_by_name,
			       EXTRACT(EPOCH FROM (t.escalation_due_at - NOW()))::int AS seconds_left
			  FROM helpdesk_tickets t
			  LEFT JOIN o3c_users eb ON eb.id = t.escalated_by
			 WHERE `+where+`
			   AND t.escalated_at IS NOT NULL AND t.escalation_resolved_at IS NULL
			   AND t.escalation_due_at IS NOT NULL
			   AND t.status NOT IN ('resolved','closed') AND t.deleted_at IS NULL
			   AND t.escalation_due_at <= NOW() + INTERVAL '30 minutes'
			 ORDER BY t.escalation_due_at ASC
			 LIMIT 25`, args...)
		if err != nil {
			respondErr(w, 500, "Could not load escalation feed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── small helper ──────────────────────────────────────────────────────────────

// jsonInto unmarshals a jsonb column value (string or []byte) into dest.
func jsonInto(v any, dest any) {
	switch t := v.(type) {
	case []byte:
		if len(t) > 0 {
			json.Unmarshal(t, dest) //nolint:errcheck
		}
	case string:
		if t != "" {
			json.Unmarshal([]byte(t), dest) //nolint:errcheck
		}
	}
}
