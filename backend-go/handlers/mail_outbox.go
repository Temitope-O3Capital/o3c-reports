package handlers

// Mail module undo-send / recall.
//
// A composed mail is staged in mail_outbox and only handed to SendMail after its
// hold window elapses, so it can be recalled inside that window. SendMail itself is
// untouched — we simply call it later, from the dispatcher.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

type outboxPayload struct {
	To               []MailAddress    `json:"to"`
	CC               []MailAddress    `json:"cc"`
	BCC              []MailAddress    `json:"bcc"`
	Subject          string           `json:"subject"`
	HTMLBody         string           `json:"html_body"`
	TextBody         string           `json:"text_body"`
	FromEmail        string           `json:"from_email"`
	FromName         string           `json:"from_name"`
	ReplyToEmail     string           `json:"reply_to_email"`
	ReplyToName      string           `json:"reply_to_name"`
	Attachments      []MailAttachment `json:"attachments"`
	SendCopyToSender bool             `json:"send_copy_to_sender"`
}

// stageOutboxMail parks a composed mail in the outbox for delayed dispatch.
func stageOutboxMail(ctx context.Context, db *core.DB, userID int64, p outboxPayload, holdSeconds int) (int64, error) {
	raw, _ := json.Marshal(p)
	rows, err := db.PGQuery(ctx, `
		INSERT INTO mail_outbox (created_by, from_email, subject, payload, send_after)
		VALUES ($1, NULLIF($2,''), $3, $4::jsonb, NOW() + ($5 || ' seconds')::interval)
		RETURNING id`,
		userID, p.FromEmail, p.Subject, string(raw), strconv.Itoa(holdSeconds))
	if err != nil {
		return 0, err
	}
	return toInt64(rows[0]["id"]), nil
}

// dispatchPendingOutboxMail sends every staged mail whose hold window has elapsed.
func dispatchPendingOutboxMail(ctx context.Context, db *core.DB) {
	claimed, err := db.PGQuery(ctx, `
		UPDATE mail_outbox SET status='sending'
		WHERE id IN (
			SELECT id FROM mail_outbox WHERE status='pending' AND send_after <= NOW()
			ORDER BY send_after LIMIT 25
		)
		RETURNING id, created_by, payload`)
	if err != nil {
		return
	}
	for _, row := range claimed {
		id := toInt64(row["id"])
		var p outboxPayload
		jsonInto(row["payload"], &p)
		res := SendMail(ctx, db, SendMailOptions{
			To:                 p.To,
			CC:                 p.CC,
			BCC:                p.BCC,
			Subject:            p.Subject,
			HTMLBody:           p.HTMLBody,
			TextBody:           p.TextBody,
			FromEmail:          p.FromEmail,
			FromName:           p.FromName,
			ReplyToEmail:       p.ReplyToEmail,
			ReplyToName:        p.ReplyToName,
			Category:           "single",
			Kind:               "single",
			CreatedBy:          toInt64(row["created_by"]),
			SendCopyToSender:   p.SendCopyToSender,
			SenderCopyEmail:    p.ReplyToEmail,
			SenderCopyName:     p.ReplyToName,
			SendViaUserMailbox: true,
			Attachments:        p.Attachments,
		})
		if res.OK {
			db.PGExec(ctx, `UPDATE mail_outbox SET status='sent', mail_id=$1, sent_at=NOW() WHERE id=$2`, res.MailID, id) //nolint:errcheck
		} else {
			slog.Warn("mail outbox dispatch failed", "id", id, "err", res.Error)
			db.PGExec(ctx, `UPDATE mail_outbox SET status='failed', error_text=$1 WHERE id=$2`, res.Error, id) //nolint:errcheck
		}
	}
}

// mailOutboxList — GET /api/mail/outbox : my held + recently actioned mail.
func mailOutboxList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, subject, status, send_after, error_text, created_at, sent_at, mail_id,
			       EXTRACT(EPOCH FROM (send_after - NOW()))::int AS seconds_left,
			       payload->'to' AS to_addrs
			  FROM mail_outbox
			 WHERE created_by=$1 AND (status IN ('pending','failed') OR sent_at > NOW() - INTERVAL '1 hour')
			 ORDER BY created_at DESC LIMIT 100`, user.ID)
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

// mailOutboxCancel — POST /api/mail/outbox/{id}/cancel : recall while still pending.
func mailOutboxCancel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid id")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `
			UPDATE mail_outbox SET status='recalled'
			WHERE id=$1 AND created_by=$2 AND status='pending'
			RETURNING id`, id, user.ID)
		if len(rows) == 0 {
			respondErr(w, 409, "This message has already been sent and can no longer be recalled.")
			return
		}
		respond(w, map[string]any{"recalled": true}, "json")
	}
}
