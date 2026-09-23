package handlers

// The 1:1 customer messaging rail.
//
// Every message this platform has ever sent a customer was bespoke code at its own
// call site — the CSAT email, the survey dispatcher, a Care reply, a statement — with
// no shared consent check, no shared rate limit and no shared audit trail. Notify()
// cannot reach a customer at all: it resolves recipients from o3c_users.
//
// This is the one path. Everything a retention journey sends goes through
// SendToCustomer, which refuses more often than it sends, and records every refusal.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT IS OFF UNTIL SOMEONE TURNS IT ON, AND IT FAILS CLOSED.
//
// CUSTOMER_MESSAGING_MODE must equal exactly "live" for a single message to leave
// the building. Anything else — unset, empty, misspelt, "true", "yes", "LIVE " with
// a stray space — is not live. That asymmetry is deliberate: the failure mode of a
// misconfigured retention engine is messaging thousands of real customers, so the
// default has to be silence and a typo has to mean silence too.
//
//   off           (default) journeys do not run at all
//   staff_preview journeys run, every message is computed and written to
//                 app.customer_messages with state='preview', nothing is dispatched.
//                 This is how you inspect a journey against real customers.
//   live          messages are actually sent
// ─────────────────────────────────────────────────────────────────────────────

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/o3c/workspace/core"
)

type sendMode string

const (
	modeOff     sendMode = "off"
	modePreview sendMode = "staff_preview"
	modeLive    sendMode = "live"
)

// customerSendMode resolves the rail's mode. Fails closed by construction: the only
// string that produces modeLive is exactly "live".
func customerSendMode() sendMode {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CUSTOMER_MESSAGING_MODE"))) {
	case "live":
		return modeLive
	case "staff_preview", "preview":
		return modePreview
	default:
		return modeOff
	}
}

// Caps. A retention engine that messages someone three times in a week has stopped
// being retention. Enforced against app.customer_messages, which is written before
// dispatch, so a crash mid-send still counts against the cap.
const (
	customerMaxPerWeek = 2
	quietHourStart     = 21 // 21:00 — nothing goes out after this
	quietHourEnd       = 8  // 08:00 — or before this
)

// CustomerMessage is one message, addressed to a person rather than a staff account.
type CustomerMessage struct {
	PartyID int64
	CIF     string
	Channel string // sms | email | whatsapp
	Purpose string // servicing | marketing
	Journey string // fd_maturity_t14 | loan_repaid | winback | ...
	To      string
	Subject string
	Body    string
}

// SendToCustomer is the only way to message a customer. It records what it did in
// every case — including, and especially, when it refuses.
//
// Returns the state it settled on, for the caller's log line.
func SendToCustomer(ctx context.Context, db *core.DB, m CustomerMessage) string {
	mode := customerSendMode()
	if mode == modeOff {
		return "off"
	}
	if m.To == "" || strings.TrimSpace(m.Body) == "" || m.PartyID == 0 {
		return "invalid"
	}

	// Refusals, cheapest first. Each records WHY, because a message we chose not to
	// send is the most important row in this table for an NDPR audit.
	if why := customerSendRefusal(ctx, db, m); why != "" {
		logCustomerMessage(ctx, db, m, "suppressed", why, "", nil)
		return "suppressed:" + why
	}

	if mode == modePreview {
		logCustomerMessage(ctx, db, m, "preview", "", "", nil)
		return "preview"
	}

	// Written BEFORE the provider call, so a send that crashes mid-flight still
	// leaves a trace and still counts against the cap.
	id := logCustomerMessage(ctx, db, m, "queued", "", "", nil)

	var ok bool
	var provider string
	switch m.Channel {
	case "sms":
		ok, provider = sendSMS(ctx, db, m.To, m.Body)
	case "whatsapp":
		ok, provider = sendWhatsAppCampaign(ctx, db, m.To, m.Body, "")
	case "email":
		ok, provider = sendEmail(ctx, db, m.To, "", "", "", m.Subject, m.Body, m.Body, "")
	default:
		ok, provider = false, "unknown channel"
	}

	state := "sent"
	if !ok {
		state = "failed"
	}
	if id > 0 {
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE app.customer_messages
			    SET state=$2, provider_id=NULLIF($3,''), error_text=CASE WHEN $2='failed' THEN NULLIF($3,'') END,
			        sent_at=CASE WHEN $2='sent' THEN NOW() END
			  WHERE id=$1`, id, state, provider)
	}
	return state
}

// customerSendRefusal returns the reason this message must NOT go, or "".
func customerSendRefusal(ctx context.Context, db *core.DB, m CustomerMessage) string {
	// 1. Consent. Servicing rides legitimate interest for a product the customer
	//    holds; marketing and win-back need a recorded opt-in that nobody has yet.
	if !consentAllows(ctx, db, m.PartyID, m.Channel, m.Purpose) {
		return "no_consent"
	}

	// 2. The opt-out registers, which already govern every other channel.
	switch m.Channel {
	case "sms", "whatsapp":
		if rows, _ := db.PGQuery(ctx, `
			SELECT 1 FROM app.dnc_list d
			 WHERE app.norm_phone(d.phone) = app.norm_phone($1)
			   AND length(app.norm_phone(d.phone)) = 10`, m.To); len(rows) > 0 {
			return "dnc"
		}
	case "email":
		if rows, _ := db.PGQuery(ctx, `
			SELECT 1 FROM app.mail_suppressions
			 WHERE is_active AND LOWER(TRIM(email)) = LOWER(TRIM($1))`, m.To); len(rows) > 0 {
			return "suppressed_email"
		}
	}

	// 3. Quiet hours — SMS and WhatsApp only. An email at 23:00 is read in the
	//    morning; a text at 23:00 wakes someone up.
	if m.Channel != "email" {
		if h := time.Now().Hour(); h >= quietHourStart || h < quietHourEnd {
			return "quiet_hours"
		}
	}

	// 4. Frequency cap, counted from what we have actually queued or sent.
	if rows, _ := db.PGQuery(ctx, `
		SELECT COUNT(*) AS n FROM app.customer_messages
		 WHERE party_id = $1 AND state IN ('queued','sent')
		   AND created_at > NOW() - INTERVAL '7 days'`, m.PartyID); len(rows) > 0 {
		if toInt64(rows[0]["n"]) >= customerMaxPerWeek {
			return "rate_limited"
		}
	}
	return ""
}

// consentAllows answers whether we may send this, on this channel, for this purpose.
//
// A withdrawal always wins, for both purposes: someone who says stop has said stop,
// and reading that as "stop marketing only" is the kind of lawyering that ends up in
// a regulator's letter.
func consentAllows(ctx context.Context, db *core.DB, partyID int64, channel, purpose string) bool {
	rows, err := db.PGQuery(ctx, `
		SELECT purpose, state FROM app.party_contact_consent
		 WHERE party_id = $1 AND channel = $2
		   AND (expires_at IS NULL OR expires_at > NOW())`, partyID, channel)
	if err != nil {
		// Fail closed. A consent store we cannot read is not permission.
		slog.Error("consentAllows: could not read consent — refusing", "party", partyID, "err", err)
		return false
	}
	granted := map[string]bool{}
	for _, r := range rows {
		p, s := str(r["purpose"]), str(r["state"])
		if s == "withdrawn" {
			return false
		}
		if s == "granted" {
			granted[p] = true
		}
	}
	if purpose == "servicing" {
		return granted["servicing"]
	}
	return granted["marketing"]
}

func logCustomerMessage(ctx context.Context, db *core.DB, m CustomerMessage,
	state, suppressedBy, providerID string, _ any) int64 {

	seg := 0
	if m.Channel == "sms" {
		seg = smsSegments(m.Body)
	}
	rows, err := db.PGQuery(ctx, `
		INSERT INTO app.customer_messages
		  (party_id, cif, channel, purpose, journey, to_address, subject, body,
		   state, suppressed_by, provider_id, segments)
		VALUES ($1, NULLIF($2,''), $3, $4, NULLIF($5,''), $6, NULLIF($7,''), $8,
		        $9, NULLIF($10,''), NULLIF($11,''), NULLIF($12,0))
		ON CONFLICT DO NOTHING
		RETURNING id`,
		m.PartyID, m.CIF, m.Channel, m.Purpose, m.Journey, m.To, m.Subject, m.Body,
		state, suppressedBy, providerID, seg)
	if err != nil {
		slog.Error("logCustomerMessage", "party", m.PartyID, "journey", m.Journey, "err", err)
		return 0
	}
	if len(rows) == 0 {
		// The daily-per-journey unique index refused it: already messaged today.
		return 0
	}
	return toInt64(rows[0]["id"])
}

// ── SMS cost discipline ──────────────────────────────────────────────────────

// smsSegments reports how many billed segments a body costs.
//
// GSM-7 fits 160 characters in one segment. A SINGLE character outside that alphabet
// forces the whole message to UCS-2, where a segment is 70 characters — so one stray
// glyph can triple the bill on a run of thousands. The two that matter here are the
// naira sign and the em-dash, both of which this codebase's own prose is full of:
// customer SMS must spell "NGN 250,000" and use a plain hyphen.
func smsSegments(body string) int {
	if body == "" {
		return 0
	}
	n := len([]rune(body))
	if !isGSM7(body) {
		if n <= 70 {
			return 1
		}
		return (n + 66) / 67 // concatenated UCS-2 segments carry a 3-char header
	}
	if n <= 160 {
		return 1
	}
	return (n + 152) / 153
}

// gsm7Extra are the GSM-7 characters outside plain ASCII that are still safe.
const gsm7Extra = "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà^{}\\[~]|€"

func isGSM7(s string) bool {
	for _, r := range s {
		if r < unicode.MaxASCII && (r >= ' ' || r == '\n' || r == '\r') {
			continue
		}
		if !strings.ContainsRune(gsm7Extra, r) {
			return false
		}
	}
	return true
}

// customerSMSSafe rewrites the characters that silently triple the cost of a send.
func customerSMSSafe(body string) string {
	r := strings.NewReplacer(
		"₦", "NGN ", "—", "-", "–", "-", "’", "'", "‘", "'",
		"“", `"`, "”", `"`, "…", "...", "•", "*",
	)
	return strings.TrimSpace(strings.Join(strings.Fields(r.Replace(body)), " "))
}

// describeSendMode is what the Sync Status page and the worker log say, so nobody has
// to guess whether the rail is armed.
func describeSendMode() string {
	switch customerSendMode() {
	case modeLive:
		return "LIVE — messages are being sent to customers"
	case modePreview:
		return "preview only — messages are computed and logged, nothing is sent"
	default:
		return fmt.Sprintf("off — set CUSTOMER_MESSAGING_MODE=%s or %s to enable", modePreview, modeLive)
	}
}
