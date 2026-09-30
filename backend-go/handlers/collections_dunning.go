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
	"log/slog"
	"strconv"
	"strings"

	"github.com/o3c/workspace/core"
)

const (
	dunningDefaultMaxPerRun = 100
	dunningThrottleDays     = 7

	// Below this, a reminder costs more than the debt. Measured on the live book
	// 2026-09-29: 242 of 909 delinquent facilities — 27% of the queue by count — sit
	// under ₦1,000 and hold ₦14,942 BETWEEN THEM. The selection was ordered by DPD
	// descending, so the first arrears demands this company would ever have sent
	// included a ₦5.00 balance 2,048 days past due and a ₦360.00 balance at 2,634.
	// A formal demand for ₦5 does not recover ₦5; it spends a relationship.
	dunningDefaultMinKobo = 100_000 // ₦1,000

	// What counts as fresh enough for a reminder to be the right instrument. A nudge
	// works while the debt is recent and the person still recognises it; at several
	// years it is recovery's job, not a text message's.
	dunningDefaultFreshDays = 90
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
	return dunningIntSetting(ctx, db, "COLLECTIONS_DUNNING_MAX_PER_RUN", dunningDefaultMaxPerRun, false)
}

// dunningMinKobo is the materiality floor: facilities owing less are never chased.
func dunningMinKobo(ctx context.Context, db *core.DB) int {
	return dunningIntSetting(ctx, db, "COLLECTIONS_DUNNING_MIN_KOBO", dunningDefaultMinKobo, true)
}

// dunningFreshDays is the DPD inside which a reminder is contacted FIRST. It orders,
// it does not exclude — see the note on dunningMaxDPD.
func dunningFreshDays(ctx context.Context, db *core.DB) int {
	return dunningIntSetting(ctx, db, "COLLECTIONS_DUNNING_FRESH_DAYS", dunningDefaultFreshDays, false)
}

// dunningMaxDPD is an upper age bound, and it DEFAULTS TO OFF (0 = no bound).
//
// That default is deliberate and is not the same kind of judgement as the floor below
// it. Skipping a ₦5 balance forgoes ₦5. Excluding everything past three years would
// have withheld every reminder from 140 facilities holding ₦392m of real, owed money —
// a decision about whether to pursue a debt at all, which belongs to Collections and
// not to a default in a source file. The mechanism is here so they can set it; until
// they do, an old debt is still reminded about, just after the recoverable ones.
func dunningMaxDPD(ctx context.Context, db *core.DB) int {
	return dunningIntSetting(ctx, db, "COLLECTIONS_DUNNING_MAX_DPD", 0, true)
}

// dunningIntSetting reads a whole-number setting from config.
func dunningIntSetting(ctx context.Context, db *core.DB, key string, def int, allowZero bool) int {
	raw := resolveCredKey(ctx, db, key)
	n := dunningParseSetting(raw, def, allowZero)
	if n == def && strings.TrimSpace(raw) != "" && strings.TrimSpace(raw) != strconv.Itoa(def) {
		slog.Warn("ignoring unreadable dunning setting, using default",
			"key", key, "value", raw, "default", def)
	}
	return n
}

// dunningParseSetting is the parsing rule, kept pure so the policy can be tested
// without a database. allowZero distinguishes "0 means off" (the age bound) from
// "0 is meaningless here, use the default" (the batch size).
//
// Anything unreadable falls back to the DOCUMENTED DEFAULT, never to "no limit": a
// typo in a config value must not quietly widen who receives a demand for money.
func dunningParseSetting(raw string, def int, allowZero bool) int {
	v := strings.TrimSpace(raw)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 || (n == 0 && !allowZero) {
		return def
	}
	return n
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

	// Every collections template, so each facility can be written to in the wording
	// that matches its age. This was ORDER BY id LIMIT 1 — one template for everyone.
	// Harmless while only one exists, and a silent trap the moment a second does: the
	// firmer 360+ copy someone writes tomorrow would sit in the table unused, because
	// nothing here would ever look past the lowest id. Today that one template is named
	// "1-30 Days" and is going to 401 facilities over a year old.
	tplRows, err := db.PGQuery(ctx, `
		SELECT id, name, sms_body, whatsapp_body, email_subject, email_body_text, email_body_html
		  FROM app.message_templates
		 WHERE category = 'collections'
		 ORDER BY id`)
	if err != nil || len(tplRows) == 0 {
		WorkerBeat(ctx, db, "collections_dunning", "idle", "no collections template configured", "")
		return 0, nil
	}

	// Candidates: delinquent facilities not contacted in the throttle window. Identity
	// and contact details come from v_contact_identity (freshest phone/email per party),
	// falling back to the card customer record for the few rows with no party.
	rows, err := db.PGQuery(ctx, `
		SELECT * FROM (
		SELECT DISTINCT ON (COALESCE('p'||d.party_id::text, 'c'||d.key_cif))
		       d.key_cif AS cif, d.party_id, TRIM(d.product_name) AS product_name,
		       d.dpd, d.dpd_bucket, d.outstanding_kobo,
		       COALESCE(NULLIF(TRIM(v.full_name),''), NULLIF(TRIM(d.customer_name),'')) AS full_name,
		       COALESCE(NULLIF(v.email,''), NULLIF(c.email,''))                         AS email,
		       COALESCE(NULLIF(v.phone,''), NULLIF(c.phone,''))                         AS phone
		  FROM app.collections_delinquent_unified d
		  LEFT JOIN app.v_contact_identity v ON v.party_id = d.party_id
		  -- ARM-GATED. Ungated this took a STRANGER'S EMAIL for a Udara borrower, and
		  -- the artefact here is a written demand for money: 9 rows were pending, one of
		  -- which would have emailed FOLTI TECHNOLOGIES' N154,300,000 arrears notice to
		  -- olabode.sanusi@firstbanknigeria.com. Disclosure and misdirected collection.
		  LEFT JOIN app.customers c          ON d.arm = 'cards' AND c.cif = d.raw_cif
		 WHERE d.dpd > 0
		   AND d.outstanding_kobo >= $3
		   AND ($4 = 0 OR d.dpd <= $4)
		   AND NOT EXISTS (
		       SELECT 1 FROM app.dunning_sends ds
		        -- Throttle on the namespaced key, not the raw id: keyed bare, a card customer's
		        -- send suppressed an unrelated Udara borrower's reminder, and vice versa.
		        WHERE ds.account_cif = d.key_cif
		          -- BTRIM both sides: Udara ships product names with a trailing space, so a
		          -- stored "SME LOAN " would not match a freshly trimmed "SME LOAN" and the
		          -- throttle would let the same facility through again.
		          AND BTRIM(COALESCE(ds.facility,'')) = BTRIM(COALESCE(d.product_name,''))
		          AND ds.outcome IN ('sent','staff_preview')
		          AND ds.sent_at > NOW() - make_interval(days => $1)
		   )
		 -- Recoverability, not age. This was ORDER BY dpd DESC, which sounds right and
		 -- is backwards: it reaches the oldest debt first, where a reminder does least,
		 -- and the freshest last. With a nightly cap that is not a tie-break, it is the
		 -- whole policy — at 5 facilities a night the 450 cases inside 90 days, holding
		 -- ₦1.08bn, would have waited months behind debts from 2018.
		 ORDER BY COALESCE('p'||d.party_id::text, 'c'||d.key_cif),
		          (d.dpd <= $5) DESC, d.outstanding_kobo DESC, d.dpd DESC
		) x
		 -- ONE REMINDER PER PERSON PER NIGHT — the DISTINCT ON above. The throttle only
		 -- sees rows already written, and the whole batch is chosen before any of it is
		 -- logged, so a customer with two facilities passed it twice. On 2026-09-30 PAUBEE
		 -- GLOBAL VENTURE was sent two demands for N54,166,667 in the same minute, to the
		 -- same address, differing only in DPD. Two at once reads as a broken system and
		 -- invites the reply that the amount must be wrong. The per-facility throttle still
		 -- stands, so their second facility comes up on a later night.
		 ORDER BY (x.dpd <= $5) DESC, x.outstanding_kobo DESC, x.dpd DESC
		 LIMIT $2`,
		dunningThrottleDays, dunningMaxPerRun(ctx, db),
		dunningMinKobo(ctx, db), dunningMaxDPD(ctx, db), dunningFreshDays(ctx, db))
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
		tpl := dunningTemplateFor(tplRows, cand.DPDBucket)
		tplID := toInt64(tpl["id"])
		merge := map[string]any{
			"first_name": dunningFirstName(cand.Name),
			"full_name":  cand.Name,
			"facility":   cand.Facility,
			"dpd":        cand.DPD,
			"amount":     dunningAmount(cand.AmountKobo),
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

			// CONSENT first. Until 2026-09-29 this ran on suppression alone and never
			// consulted app.party_contact_consent — so a customer who had explicitly
			// withdrawn servicing contact still received a demand, because withdrawal
			// and suppression are recorded in different places.
			//
			// An arrears reminder is SERVICING, so it is opt-out (see consentIsOptIn in
			// audience.go): a missing row means never asked, and the reminder stands.
			// Only a real withdrawal stops it. Requiring opt-in here would have silenced
			// 282 of 654 delinquent parties — 43% of a ₦2.19bn book — none of whom had
			// objected to anything.
			if withdrawn, wErr := contactConsentWithdrawn(ctx, db, cand.PartyID, ch, purposeServicing); wErr == nil && withdrawn {
				dunningLog(ctx, db, cand, ch, recipient, "", "", "suppressed",
					"customer withdrew consent for "+ch, tplID)
				suppressed++
				continue
			}

			// SUPPRESSION second. Covers contact_suppressions (per party, phone or
			// email, honouring channel='all') AND the legacy dnc_list for the
			// voice-adjacent channels.
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

// dunningOrgWords are the words that make a name a company rather than a person.
// Matched whole, against the name upper-cased and stripped of punctuation.
var dunningOrgWords = map[string]bool{
	"LTD": true, "LIMITED": true, "PLC": true, "LLC": true, "LLP": true, "INC": true,
	"COMPANY": true, "CO": true, "CORP": true, "CORPORATION": true, "GROUP": true,
	"HOLDINGS": true, "ENTERPRISE": true, "ENTERPRISES": true, "VENTURE": true,
	"VENTURES": true, "GLOBAL": true, "INTERNATIONAL": true, "NIG": true, "NIGERIA": true,
	"TECHNOLOGY": true, "TECHNOLOGIES": true, "SERVICES": true, "SOLUTIONS": true,
	"RESOURCES": true, "INVESTMENTS": true, "SOCIETY": true, "COOPERATIVE": true,
	"ASSOCIATES": true, "PARTNERS": true, "CONSULTING": true, "CONSULT": true,
	"CONTRACTORS": true, "INDUSTRIES": true, "TRADING": true, "CONCEPTS": true,
	"HOTEL": true, "HOTELS": true, "RESORTS": true, "FARMS": true, "FOODS": true,
	"MOTORS": true, "STORES": true, "AGENCY": true, "FOUNDATION": true, "ACADEMY": true,
	"MINISTRIES": true, "CHURCH": true, "BANK": true, "MICROFINANCE": true,
}

// dunningLooksLikeOrg reports whether a name belongs to an organisation.
func dunningLooksLikeOrg(name string) bool {
	if strings.Contains(name, "&") {
		return true
	}
	for _, w := range strings.Fields(strings.ToUpper(name)) {
		if dunningOrgWords[strings.Trim(w, ".,()/-")] {
			return true
		}
	}
	return false
}

// dunningFirstName picks the greeting. A first name is right for a person and wrong
// for a company: the 2026-09-30 previews opened a ₦100m demand to AMBIENCE HOTEL AND
// RESORTS LIMITED with "Dear AMBIENCE," — the first word of a company name, which
// reads as a mail-merge accident on the one kind of letter that has to look
// deliberate. A company has no first name, so it is addressed by its own name whole.
// Case is left exactly as the record holds it; this is a legal entity on a demand for
// money, not a label to prettify.
func dunningFirstName(full string) string {
	fields := strings.Fields(full)
	if len(fields) == 0 {
		return "Customer"
	}
	joined := strings.Join(fields, " ")
	if dunningLooksLikeOrg(joined) {
		return joined
	}
	return fields[0]
}

// dunningAmount renders kobo the way a demand for money has to read — grouped in
// thousands. fmtKoboStr is right for a log line and wrong here: it wrote
// "N100000000.00" into the 2026-09-30 previews, a figure no reader can check at a
// glance, on the kind of notice people already suspect of being a scam.
func dunningAmount(kobo int64) string {
	whole, frac := fmtKoboStr(kobo), ""
	if i := strings.LastIndexByte(whole, '.'); i >= 0 {
		whole, frac = whole[:i], whole[i:]
	}
	sign := ""
	if strings.HasPrefix(whole, "-") {
		sign, whole = "-", whole[1:]
	}
	var b strings.Builder
	for i := 0; i < len(whole); i++ {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteByte(whole[i])
	}
	return sign + b.String() + frac
}

// dunningTemplateMatches reports whether a template is written for a DPD bucket, by
// looking for the bucket token in its name with digit boundaries either side — so
// "1-30" does not quietly match a template named for "181-360".
func dunningTemplateMatches(name, bucket string) bool {
	name, bucket = strings.ToLower(strings.TrimSpace(name)), strings.ToLower(strings.TrimSpace(bucket))
	if name == "" || bucket == "" {
		return false
	}
	edge := func(b byte) bool { return (b >= '0' && b <= '9') || b == '-' || b == '+' }
	for i := 0; i+len(bucket) <= len(name); i++ {
		if name[i:i+len(bucket)] != bucket {
			continue
		}
		if i > 0 && edge(name[i-1]) {
			continue
		}
		if j := i + len(bucket); j < len(name) && edge(name[j]) {
			continue
		}
		return true
	}
	return false
}

// dunningTemplateFor picks the template written for this facility's age, falling back
// to the lowest-numbered collections template when none names the bucket.
func dunningTemplateFor(rows []core.Row, bucket string) core.Row {
	for _, r := range rows {
		if dunningTemplateMatches(str(r["name"]), bucket) {
			return r
		}
	}
	return rows[0]
}

// nullableInt64 keeps a zero id out of a foreign-keyed column.
func nullableInt64(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}
