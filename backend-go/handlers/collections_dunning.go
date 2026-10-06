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

// dunningSkipRecovery reports whether accounts a recovery officer is actively working
// should be left alone. Default on. Accounts at 'legal' are excluded regardless and
// this setting cannot reach them: see the query.
func dunningSkipRecovery(ctx context.Context, db *core.DB) bool {
	return !strings.EqualFold(strings.TrimSpace(
		resolveCredKey(ctx, db, "COLLECTIONS_DUNNING_SKIP_RECOVERY")), "off")
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
		       -- The name the product is actually SOLD under. The delinquency view carries
		       -- the system name, which is a different string: "Classic Accounts" is sold
		       -- as "Classic Card", and "Amex Naira" is sold as "O3 Green Naira" — a brand
		       -- we do not own and must not print. See dunningFacilityDisplay.
		       cp.product_name  AS catalog_name,
		       cp.category      AS catalog_category,
		       COALESCE(cp.is_cooperative, false) AS catalog_coop,
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
		  -- system_name is unique in app.card_products, so this cannot fan the row out.
		  -- 24 of the 27 product names on the delinquent book resolve here; the three that
		  -- do not are loan-arm values and fall through to dunningFacilityLabel.
		  LEFT JOIN app.card_products cp
		         ON UPPER(BTRIM(cp.system_name)) = UPPER(BTRIM(d.product_name))
		 WHERE d.dpd > 0
		   AND d.outstanding_kobo >= $3
		   AND ($4 = 0 OR d.dpd <= $4)
		   -- NOBODY WHOSE CASE IS ALREADY WITH SOLICITORS, AND BY DEFAULT NOBODY A
		   -- RECOVERY OFFICER IS ALREADY WORKING.
		   --
		   -- 186 facilities holding ₦613.7m sat in this pool at recovery status 'legal'.
		   -- An automated letter inviting them to "call us and discuss a repayment
		   -- arrangement" would have gone to borrowers O3 has engaged solicitors against
		   -- — 95 legal proceedings are on file. That is correspondence outside counsel,
		   -- it contradicts what the company is telling them through its lawyers, and it
		   -- is the sort of document that gets read back in court. 'legal' is therefore
		   -- excluded unconditionally: no setting turns it on.
		   --
		   -- 'active' (382 facilities, the officer-worked cases) is excluded by default
		   -- but is Collections' call, because the argument is finer: a nudge alongside
		   -- an officer can help, and a full-balance demand sent to someone who is
		   -- current on an agreed instalment plan is worse than silence. Default off,
		   -- COLLECTIONS_DUNNING_SKIP_RECOVERY=off to include them.
		   AND NOT EXISTS (
		       SELECT 1 FROM app.recovery_cases rc
		        WHERE rc.party_id = d.party_id
		          AND (rc.status = 'legal' OR ($6 AND rc.status = 'active'))
		   )
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
		 --
		 -- THE CAP IS FOR MESSAGES THAT CAN ARRIVE. The throttle counts only 'sent' and
		 -- 'staff_preview', so a customer with no email and no phone was re-selected every
		 -- night forever — three no_contact rows, nothing moved, and because they sort by
		 -- value they sit at the head of the queue permanently. 6 of the top 20 are
		 -- unreachable: 6 slots in every 20 spent on post with nowhere to go, while
		 -- reachable borrowers behind them never come up at all.
		 -- This does not hide the gap. 26 people holding ₦316.8m have no address of any
		 -- kind, and dunningStatus reports them as their own figure — a number someone can
		 -- act on, which a nightly repeat of the same dead rows is not.
		 WHERE COALESCE(x.email,'') <> '' OR COALESCE(x.phone,'') <> ''
		 ORDER BY (x.dpd <= $5) DESC, x.outstanding_kobo DESC, x.dpd DESC
		 LIMIT $2`,
		dunningThrottleDays, dunningMaxPerRun(ctx, db),
		dunningMinKobo(ctx, db), dunningMaxDPD(ctx, db), dunningFreshDays(ctx, db),
		dunningSkipRecovery(ctx, db))
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
		// Resolved once per candidate, not per channel: the name does not change with
		// the medium, only the amount does.
		facility := dunningFacilityDisplay(cand.Facility,
			str(r["catalog_name"]), str(r["catalog_category"]), toBool(r["catalog_coop"]))

		for _, ch := range []string{"email", "whatsapp", "sms"} {
			// Built per channel, because the amount is not spelt the same way on all
			// three. See dunningAmount.
			merge := map[string]any{
				"first_name": dunningFirstName(cand.Name),
				"full_name":  cand.Name,
				// Looked up, not raw. cand.Facility stays as the book holds it because it
				// is also the throttle key — see dunningFacilityDisplay.
				"facility": facility,
				"dpd":      cand.DPD,
				"amount":   dunningAmount(cand.AmountKobo, ch),
				"cif":      cand.CIF,
			}
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

// dunningFacilityDisplay names the product the way the business names it.
//
// app.card_products is the catalogue, and it is authoritative in a way nothing derivable
// from the raw string is: system_name is the value the delinquency view carries,
// product_name is what the product is SOLD as, and the two differ on almost every row.
// Guessing from the raw string got this wrong in both directions — "Classic Accounts" is
// a Classic CARD, not an account, on 494 facilities, the largest product on the book;
// and "Amex Naira" is sold as "O3 Green Naira", so inferring a label from the stored
// string would have printed American Express on 112 borrowers' demand letters for a
// product O3 does not badge that way. A name is a fact to look up, not a string to
// derive.
//
// Three of the 27 names are not in the catalogue at all — the loan-arm values — and
// those fall through to dunningFacilityLabel, which tidies the raw string instead.
func dunningFacilityDisplay(raw, catalogName, category string, cooperative bool) string {
	if n := strings.Join(strings.Fields(catalogName), " "); n != "" {
		// Taken as written. The catalogue is not ours to improve on here: no
		// singularising, and no stripping of instalment numbers, because "Business
		// Instalment 2" is the product's real name and the 2 is part of it.
		if !dunningLooksLikeBareCode(n) {
			return n
		}
		// The catalogue has no name for it either — product_name IS the code, as it is
		// for PREP, MEMCOS, AIRTEL and GAME. It does still know what KIND of thing it
		// is, which is both true and more use to a borrower than the code.
		return dunningCardKind(category, cooperative)
	}
	return dunningFacilityLabel(raw)
}

// dunningLooksLikeBareCode: one word, arrived shouting. PREP, MEMCOS, GAME, AIRTEL.
// Judged by shape rather than by name so the next one does not have to reach a borrower
// before anybody notices it.
func dunningLooksLikeBareCode(s string) bool {
	return !strings.ContainsAny(s, " -") && s == strings.ToUpper(s)
}

// dunningCardKind is the fallback a borrower can still recognise. Lower case on purpose:
// this is a common noun describing the product, not its name, so "Your prepaid card with
// O3 Capital is 5 days past due" reads as a sentence rather than a label.
func dunningCardKind(category string, cooperative bool) string {
	kind := "card"
	switch strings.ToLower(strings.TrimSpace(category)) {
	case "credit":
		kind = "credit card"
	case "prepaid":
		kind = "prepaid card"
	}
	if cooperative {
		return "cooperative " + kind
	}
	return kind
}

// dunningFacilityAcronyms survive title-casing. Everything here is a real token in the
// book: scheme and employer abbreviations, and SME. Lower-cased "Sme Loan" would read
// as a typo on a letter about money.
var dunningFacilityAcronyms = map[string]bool{
	"SME": true, "USD": true, "NGN": true, "UI": true, "COOP": true,
	"SSANU": true, "LIRS": true, "LBIC": true, "NOHIL": true, "BB": true,
}

// dunningFacilityLabel tidies a raw product name for the values the card catalogue does
// not hold — the loan-arm ones. Prefer dunningFacilityDisplay, which looks the name up
// properly; this is only what is left when there is nothing to look up:
//
//	SME LOAN         a CBS code, shouted, with a trailing space
//	CONSUMER LOAN    the same
//	Loan (uploaded)  the parenthetical names the import, not the product
//
// All three went in raw, so a preview read "Your Loan (uploaded) with O3 Capital is 5
// days past due". Nothing had been sent live, so no borrower received one.
//
// Singularising here also fixes a grammar fault in all six templates on all three
// channels without rewriting a line of copy: every one of them says "is" or "has been"
// about this phrase, so a plural name produced "... Accounts is 5 days past due". The
// fault was in the data, not the wording.
//
// Returns "" for anything it cannot render safely, which is the design and not a
// failure: renderTemplate falls back to the default on a blank value, so the sentence
// becomes "Your account with O3 Capital is 5 days past due". A generic noun is always
// true. An internal code is always a defect, and on the one kind of letter whose reader
// is already inclined to suspect a scam, it is the detail that settles it.
//
// NOT a substitute for dunningCandidate.Facility, which stays raw on purpose: that value
// is written to dunning_sends.facility and the throttle matches it back against the
// product name (BTRIM(ds.facility) = BTRIM(d.product_name)). Prettify it there and no
// throttle row matches again, so every borrower is reminded afresh every night.
func dunningFacilityLabel(raw string) string {
	// Collapsing whitespace also closes the double space in "Business Account  Instalment 1"
	// and the trailing space Udara ships on "SME LOAN ".
	s := strings.Join(strings.Fields(raw), " ")
	if s == "" {
		return ""
	}
	bare := dunningLooksLikeBareCode(s)

	// "Loan (uploaded)" — the parenthetical names the import, not the product.
	if i := strings.LastIndexByte(s, '('); i > 0 && strings.HasSuffix(s, ")") {
		s = strings.TrimSpace(s[:i])
	}
	// A separator hyphen written without its spaces ("Classic Accounts- Contactless").
	// Only asymmetric ones: SSANU-UI is a compound and must stay joined.
	s = strings.ReplaceAll(s, "- ", " - ")
	s = strings.ReplaceAll(s, " -", " - ")

	parts := strings.Fields(s)
	// Our instalment numbering, innermost first: "... Instalment 2" and "... 2".
	for len(parts) > 1 {
		last := parts[len(parts)-1]
		if _, err := strconv.Atoi(last); err == nil ||
			strings.EqualFold(last, "instalment") || strings.EqualFold(last, "installment") {
			parts = parts[:len(parts)-1]
			continue
		}
		break
	}
	for i, tok := range parts {
		tok = dunningTitleToken(tok)
		// The agreement fix: one account, one loan, one card.
		if l := strings.ToLower(tok); l == "accounts" || l == "loans" || l == "cards" {
			tok = tok[:len(tok)-1]
		}
		parts[i] = tok
	}
	s = strings.Join(parts, " ")

	if bare {
		return ""
	}
	return s
}

// dunningTitleToken calms one SHOUTED word, keeping known acronyms and handling a
// hyphenated compound a part at a time.
//
// Only all-caps tokens are touched. A token that already carries mixed case was written
// that way deliberately and is left exactly as the book holds it — the same reasoning as
// dunningFirstName, which refuses to prettify a legal entity on a demand for money.
func dunningTitleToken(tok string) string {
	if strings.Contains(tok, "-") {
		bits := strings.Split(tok, "-")
		for i, b := range bits {
			bits[i] = dunningTitleToken(b)
		}
		return strings.Join(bits, "-")
	}
	if tok == "" || tok != strings.ToUpper(tok) || dunningFacilityAcronyms[tok] {
		return tok
	}
	return strings.ToUpper(tok[:1]) + strings.ToLower(tok[1:])
}

// dunningAmount renders kobo the way a demand for money has to read — grouped in
// thousands, and carrying its currency. fmtKoboStr is right for a log line and wrong
// here: it wrote "N100000000.00" into the 2026-09-30 previews, a figure no reader can
// check at a glance, on the kind of notice people already suspect of being a scam.
//
// The sign differs by channel, and this is the reason. ₦ is U+20A6, which is not in
// the GSM 7-bit alphabet, so a single naira sign converts the entire SMS to UCS-2 and
// cuts the segment from 160 characters to 70. The rendered reminder already runs to
// about 157 characters for a long company name, so that one character turns a
// two-segment message into three, on every SMS, for as long as the system runs. Email
// and WhatsApp are UTF-8 and pay nothing for it, so they carry the real sign and SMS
// carries the ISO code, which is at least unambiguous in a way a bare "N" is not.
func dunningAmount(kobo int64, channel string) string {
	if channel == "sms" {
		return "NGN" + dunningGroup(kobo)
	}
	return "₦" + dunningGroup(kobo)
}

// dunningGroup is the figure alone, grouped in thousands, with no currency.
func dunningGroup(kobo int64) string {
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
