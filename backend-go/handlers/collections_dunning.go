package handlers

// Arrears reminders — the automated side of collections contact.
//
// Until now nothing told a customer they were overdue before an agent phoned them:
// message_templates held exactly one template (marketing), mail_outbox was empty, and
// the only "past due" event in the system (loan_past_due) alerts STAFF, not borrowers.
//
// POLICY, set by Collections and encoded here deliberately so it is findable:
//   * Every DPD band, all three channels — email, WhatsApp, SMS.
//   * At most one round per FACILITY per 7 days. A customer holding a card and two
//     loans hears about each separately; on this book only 24 of 939 delinquent
//     customers hold more than one facility, and the worst case is four.
//   * Nothing is sent to a suppressed customer on a suppressed channel, ever.
//
// SAFETY: the pipeline starts in staff_preview mode. It resolves everything for real —
// recipient, channel, rendered copy, suppression decision, amount — but delivers to a
// staff inbox instead of the borrower, and logs each attempt as 'staff_preview'. Nobody
// in debt receives an automated message until COLLECTIONS_DUNNING_MODE is set to 'live'.

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/o3c/workspace/core"
)

const (
	dunningDefaultMaxPerRun = 100
	dunningThrottleDays     = 7
)

// dunningMode returns "live" only when explicitly configured. Anything else — unset,
// empty, a typo — means staff_preview, because the failure mode of guessing wrong here
// is messaging people about their debts without approval.
func dunningMode(ctx context.Context, db *core.DB) string {
	if strings.EqualFold(strings.TrimSpace(resolveCredKey(ctx, db, "COLLECTIONS_DUNNING_MODE")), "live") {
		return "live"
	}
	return "staff_preview"
}

func dunningMaxPerRun(ctx context.Context, db *core.DB) int {
	if v := strings.TrimSpace(resolveCredKey(ctx, db, "COLLECTIONS_DUNNING_MAX_PER_RUN")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return dunningDefaultMaxPerRun
}

// dunningCandidate is one delinquent facility with its resolved contact details.
type dunningCandidate struct {
	PartyID    int64
	CIF        string
	Name       string
	Facility   string
	DPD        int
	DPDBucket  string
	AmountKobo int64
	Email      string
	Phone      string
}

// batchDunningRun sends (or previews) one round of arrears reminders.
//
// Returns the number of messages actually dispatched — to the customer in live mode, to
// the staff inbox in preview. Every attempt is written to dunning_sends regardless of
// outcome: a log that records only successes cannot answer "why did this customer hear
// from us after opting out?".
func batchDunningRun(ctx context.Context, db *core.DB) (int64, error) {
	WorkerBeat(ctx, db, "collections_dunning", "running", "", "")

	mode := dunningMode(ctx, db)
	inbox := strings.TrimSpace(resolveCredKey(ctx, db, "COLLECTIONS_DUNNING_INBOX"))
	if mode == "staff_preview" && inbox == "" {
		WorkerBeat(ctx, db, "collections_dunning", "idle",
			"no COLLECTIONS_DUNNING_INBOX configured — nothing previewed", "")
		return 0, nil
	}

	tplRows, err := db.PGQuery(ctx, `
		SELECT id, sms_body, whatsapp_body, email_subject, email_body_text, email_body_html
		  FROM app.message_templates
		 WHERE category = 'collections'
		 ORDER BY id
		 LIMIT 1`)
	if err != nil || len(tplRows) == 0 {
		WorkerBeat(ctx, db, "collections_dunning", "idle", "no collections template configured", "")
		return 0, nil
	}
	tpl := tplRows[0]
	tplID := toInt64(tpl["id"])

	// Candidates: delinquent facilities not contacted in the throttle window. Identity
	// and contact details come from v_contact_identity (freshest phone/email per party),
	// falling back to the card customer record for the few rows with no party.
	rows, err := db.PGQuery(ctx, `
		SELECT d.cif, d.party_id, d.product_name, d.dpd, d.dpd_bucket, d.outstanding_kobo,
		       COALESCE(NULLIF(TRIM(v.full_name),''), NULLIF(TRIM(d.customer_name),'')) AS full_name,
		       COALESCE(NULLIF(v.email,''), NULLIF(c.email,''))                         AS email,
		       COALESCE(NULLIF(v.phone,''), NULLIF(c.phone,''))                         AS phone
		  FROM app.collections_delinquent_unified d
		  LEFT JOIN app.v_contact_identity v ON v.party_id = d.party_id
		  LEFT JOIN app.customers c          ON c.cif = d.cif
		 WHERE d.dpd > 0
		   AND d.outstanding_kobo > 0
		   AND NOT EXISTS (
		       SELECT 1 FROM app.dunning_sends ds
		        WHERE ds.account_cif = d.cif
		          AND COALESCE(ds.facility,'') = COALESCE(d.product_name,'')
		          AND ds.outcome IN ('sent','staff_preview')
		          AND ds.sent_at > NOW() - ($1 || ' days')::interval
		   )
		 ORDER BY d.dpd DESC
		 LIMIT $2`, strconv.Itoa(dunningThrottleDays), dunningMaxPerRun(ctx, db))
	if err != nil {
		WorkerBeat(ctx, db, "collections_dunning", "error", "", err.Error())
		return 0, fmt.Errorf("select dunning candidates: %w", err)
	}
	if len(rows) == 0 {
		WorkerBeat(ctx, db, "collections_dunning", "idle", "no facility due a reminder", "")
		return 0, nil
	}

	var dispatched, suppressed, noContact, failed int64
	for _, r := range rows {
		cand := dunningCandidate{
			PartyID:    toInt64(r["party_id"]),
			CIF:        str(r["cif"]),
			Name:       str(r["full_name"]),
			Facility:   str(r["product_name"]),
			DPD:        int(toInt64(r["dpd"])),
			DPDBucket:  str(r["dpd_bucket"]),
			AmountKobo: toInt64(r["outstanding_kobo"]),
			Email:      strings.TrimSpace(str(r["email"])),
			Phone:      strings.TrimSpace(str(r["phone"])),
		}
		merge := map[string]any{
			"first_name": dunningFirstName(cand.Name),
			"full_name":  cand.Name,
			"facility":   cand.Facility,
			"dpd":        cand.DPD,
			"amount":     fmtKoboStr(cand.AmountKobo),
			"cif":        cand.CIF,
		}

		for _, ch := range []string{"email", "whatsapp", "sms"} {
			recipient := cand.Phone
			if ch == "email" {
				recipient = cand.Email
			}
			if recipient == "" {
				dunningLog(ctx, db, cand, ch, "", "", "", "no_contact", "no address for this channel", tplID)
				noContact++
				continue
			}

			// One guard, consulted for every channel. Covers contact_suppressions
			// (per party, phone or email, honouring channel='all') AND the legacy
			// dnc_list for the voice-adjacent channels.
			var blocked bool
			if sRows, sErr := db.PGQuery(ctx,
				`SELECT app.is_suppressed($1::bigint, $2, $3, $4) AS blocked`,
				nullableInt64(cand.PartyID), cand.Phone, cand.Email, ch); sErr == nil && len(sRows) > 0 {
				blocked = sRows[0]["blocked"] == true
			}
			if blocked {
				dunningLog(ctx, db, cand, ch, recipient, "", "", "suppressed", "customer opted out of this channel", tplID)
				suppressed++
				continue
			}

			subject, body := dunningRender(tpl, ch, merge)
			if strings.TrimSpace(body) == "" {
				dunningLog(ctx, db, cand, ch, recipient, subject, body, "failed", "template has no body for this channel", tplID)
				failed++
				continue
			}

			if mode == "staff_preview" {
				// Real resolution, staff delivery. The subject says whose message this
				// would have been, so a reviewer can read the batch as the customer would.
				previewSubject := fmt.Sprintf("[DUNNING PREVIEW · %s] %s — %s", strings.ToUpper(ch), cand.Name, subject)
				ok, detail := sendEmail(ctx, db, inbox, "Collections", "", "", previewSubject, dunningPreviewHTML(cand, ch, subject, body), body, cand.CIF)
				outcome := "staff_preview"
				if !ok {
					outcome = "failed"
					failed++
				} else {
					dispatched++
				}
				dunningLog(ctx, db, cand, ch, recipient, subject, body, outcome, "preview to "+inbox+" · "+detail, tplID)
				continue
			}

			var ok bool
			var detail string
			switch ch {
			case "email":
				ok, detail = sendEmail(ctx, db, recipient, cand.Name, "", "", subject, dunningEmailHTML(tpl, merge), body, cand.CIF)
			case "sms":
				ok, detail = sendSMS(ctx, db, recipient, body)
			case "whatsapp":
				ok, detail = sendWhatsApp(ctx, db, recipient, body)
			}
			if ok {
				dispatched++
				dunningLog(ctx, db, cand, ch, recipient, subject, body, "sent", detail, tplID)
			} else {
				failed++
				dunningLog(ctx, db, cand, ch, recipient, subject, body, "failed", detail, tplID)
			}
		}
	}

	detail := fmt.Sprintf("%s · %d dispatched, %d suppressed, %d no-contact, %d failed across %d facilities",
		mode, dispatched, suppressed, noContact, failed, len(rows))
	if dispatched == 0 {
		WorkerBeat(ctx, db, "collections_dunning", "idle", detail, "")
	} else {
		WorkerBeat(ctx, db, "collections_dunning", "ok", detail, "")
	}
	return dispatched, nil
}

// dunningRender picks the right column for the channel and renders its merge tags.
func dunningRender(tpl core.Row, channel string, merge map[string]any) (subject, body string) {
	switch channel {
	case "email":
		return renderTemplate(str(tpl["email_subject"]), merge), renderTemplate(str(tpl["email_body_text"]), merge)
	case "sms":
		return "", renderTemplate(str(tpl["sms_body"]), merge)
	case "whatsapp":
		return "", renderTemplate(str(tpl["whatsapp_body"]), merge)
	}
	return "", ""
}

func dunningEmailHTML(tpl core.Row, merge map[string]any) string {
	if h := strings.TrimSpace(str(tpl["email_body_html"])); h != "" {
		return renderTemplate(h, merge)
	}
	return ""
}

// dunningPreviewHTML wraps the customer-bound copy with the decision behind it, so a
// reviewer sees both what would be sent and why this customer was selected.
func dunningPreviewHTML(c dunningCandidate, channel, subject, body string) string {
	return fmt.Sprintf(
		`<p style="font:13px system-ui;color:#555">This message was NOT sent to the customer. `+
			`Dunning is in staff_preview mode.</p>`+
			`<table style="font:13px system-ui;border-collapse:collapse">`+
			`<tr><td style="padding:2px 10px 2px 0;color:#777">Customer</td><td>%s</td></tr>`+
			`<tr><td style="padding:2px 10px 2px 0;color:#777">CIF</td><td>%s</td></tr>`+
			`<tr><td style="padding:2px 10px 2px 0;color:#777">Facility</td><td>%s</td></tr>`+
			`<tr><td style="padding:2px 10px 2px 0;color:#777">Days past due</td><td>%d (%s)</td></tr>`+
			`<tr><td style="padding:2px 10px 2px 0;color:#777">Outstanding</td><td>N%s</td></tr>`+
			`<tr><td style="padding:2px 10px 2px 0;color:#777">Channel</td><td>%s</td></tr>`+
			`<tr><td style="padding:2px 10px 2px 0;color:#777">Subject</td><td>%s</td></tr>`+
			`</table><hr><pre style="font:13px/1.5 system-ui;white-space:pre-wrap">%s</pre>`,
		c.Name, c.CIF, c.Facility, c.DPD, c.DPDBucket, fmtKoboStr(c.AmountKobo), channel, subject, body)
}

func dunningLog(ctx context.Context, db *core.DB, c dunningCandidate,
	channel, recipient, subject, body, outcome, detail string, tplID int64) {
	db.PGExec(ctx, `
		INSERT INTO app.dunning_sends
		  (party_id, account_cif, facility, channel, dpd, dpd_bucket, outstanding_kobo,
		   recipient, subject, body, outcome, outcome_detail, template_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),NULLIF($10,''),$11,NULLIF($12,''),$13)`,
		nullableInt64(c.PartyID), c.CIF, c.Facility, channel, c.DPD, c.DPDBucket, c.AmountKobo,
		recipient, subject, body, outcome, detail, tplID) //nolint:errcheck
}

func dunningFirstName(full string) string {
	if f := strings.Fields(strings.TrimSpace(full)); len(f) > 0 {
		return f[0]
	}
	return "Customer"
}

// nullableInt64 keeps a zero id out of a foreign-keyed column.
func nullableInt64(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}
