package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

// The call-outcome vocabulary for the outbound queue.
//
// This list was previously hardcoded in the React page — twice, in two arrays that had
// already drifted apart — with no server-side validation and, more to the point, no
// consequence: marking a number "Wrong Number" left it sitting in the queue to be
// dialled again tomorrow. Across 14,709 contacts not one disposition had ever been
// recorded, so the vocabulary was decoration.
//
// Each entry now carries what should HAPPEN to the contact, which is the only reason an
// agent has to spend three seconds logging one.

type ccDisposition struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	// Status the contact moves to. Empty means it stays 'pending' and will be served
	// again once it clears the cooldown.
	Status string `json:"status"`
	// NeedsCallback marks the dispositions that require a callback time.
	NeedsCallback bool `json:"needs_callback"`
	// AddToDNC suppresses the number from every future queue sync.
	AddToDNC bool `json:"add_to_dnc"`
	// Connected records whether a human actually spoke. Drives connect-rate reporting
	// and keeps "attempts with no connect" honest.
	Connected bool `json:"connected"`
	// Purposes scopes a disposition to the kind of call it belongs to
	// ('marketing','collections','support'). Empty means it applies to every purpose
	// (callback / no-answer / wrong-number / DNC are universal). The queue's log form
	// shows an agent only the dispositions that fit the contact they're calling, so a
	// telesales call never offers "Promise to Pay" and a collections call never offers
	// "Not Eligible".
	Purposes []string `json:"purposes,omitempty"`
	// Hint is shown under the option so an agent knows what they are committing to.
	Hint string `json:"hint"`
}

var ccDispositions = []ccDisposition{
	{Code: "answered_interested", Label: "Answered — Interested", Status: "", Connected: true,
		Purposes: []string{"marketing"}, Hint: "Stays in the queue for follow-up"},
	{Code: "answered_not_interested", Label: "Answered — Not Interested", Status: "closed", Connected: true,
		Purposes: []string{"marketing"}, Hint: "Closes the contact — no further calls"},
	{Code: "callback", Label: "Callback Requested", Status: "", NeedsCallback: true, Connected: true,
		Hint: "Served again at the time you set, ahead of everything else"},
	{Code: "ptp", Label: "Promise to Pay", Status: "", Connected: true,
		Purposes: []string{"collections"}, Hint: "Recorded in the Collections promise book"},
	// "Not eligible" and "not ready" were being forced into "Not Interested",
	// which CLOSES the contact. They are different outcomes with different
	// follow-ups, and collapsing them lost every not-yet lead worth calling back.
	{Code: "not_eligible", Label: "Not Eligible", Status: "closed", Connected: true,
		Purposes: []string{"marketing"}, Hint: "Does not qualify (age, employer, exposure) — closes the contact"},
	{Code: "not_ready", Label: "Not Ready Yet", Status: "", Connected: true,
		Purposes: []string{"marketing"}, Hint: "Interested but not now — stays in the queue for a later cycle"},
	// Support calls close on a resolution, not on interest. Without a "resolved"
	// disposition a support callback had nothing honest to log, so it borrowed a
	// marketing label. Scoped to support so it only shows there.
	{Code: "resolved", Label: "Resolved", Status: "closed", Connected: true,
		Purposes: []string{"support"}, Hint: "The customer's issue was handled — closes the contact"},
	// Answered, then gone within seconds. Agents were forcing this into "No
	// Answer", which is wrong twice over: it was answered, and it hides a number
	// that is reachable but keeps cutting off. Nothing was discussed, so the
	// contact stays workable and returns to the queue.
	{Code: "call_dropped", Label: "Call Dropped", Status: "", Connected: true,
		Hint: "Picked up then dropped within seconds — returns to the queue to retry"},
	{Code: "no_answer", Label: "No Answer", Status: "", Connected: false,
		Hint: "Rests for the cooldown, then returns to the queue"},
	{Code: "wrong_number", Label: "Wrong Number", Status: "invalid", Connected: false,
		Hint: "Removes the contact — the number is not the customer"},
	{Code: "do_not_call", Label: "Do Not Call", Status: "closed", AddToDNC: true, Connected: true,
		Hint: "Closes the contact and suppresses the number from all future lists"},

	// ── Retention / win-back ──────────────────────────────────────────────────
	//
	// A win-back call is not a marketing call. The customer already bought from us
	// and then stopped, so the useful outcomes are about WHY they left and whether
	// they will come back — not whether they qualify. Offering "Not Eligible" to
	// someone who has been our customer for years reads as an insult; offering
	// "Answered — Interested" loses the one thing this call exists to learn.
	//
	// These are also the only way we will ever capture a churn reason. A schema-wide
	// search on 2026-09-23 found no closure-reason field anywhere: of 6,539 churned
	// customers we can explain 347 (5.3%), and only because they defaulted. Every
	// disposition below that names a cause starts fixing that from today forward.
	{Code: "winback_reactivated", Label: "Reactivating — Will Use Again", Status: "closed", Connected: true,
		Purposes: []string{"retention"}, Hint: "They are coming back — closes the win-back contact as a win"},
	{Code: "winback_wants_offer", Label: "Interested in a New Offer", Status: "", Connected: true,
		Purposes: []string{"retention"}, Hint: "Warm — hand to Sales, stays in the queue until they do"},
	{Code: "winback_price", Label: "Left Over Charges or Rates", Status: "closed", Connected: true,
		Purposes: []string{"retention"}, Hint: "Records the reason and closes the contact"},
	{Code: "winback_service", Label: "Left Over Service or an Unresolved Issue", Status: "closed", Connected: true,
		Purposes: []string{"retention"}, Hint: "Records the reason and closes the contact — raise a Care ticket if it is still open"},
	{Code: "winback_competitor", Label: "Using Another Provider", Status: "closed", Connected: true,
		Purposes: []string{"retention"}, Hint: "Records the reason and closes the contact"},
	{Code: "winback_no_need", Label: "No Longer Needs the Product", Status: "closed", Connected: true,
		Purposes: []string{"retention"}, Hint: "Records the reason and closes the contact"},
	{Code: "winback_declined", Label: "Not Interested in Returning", Status: "closed", Connected: true,
		Purposes: []string{"retention"}, Hint: "Closes the contact — no further win-back calls"},
}

// ccDispositionsForPurpose returns the dispositions valid for a call purpose
// ('marketing','collections','support'); an unknown or empty purpose gets the full list
// so nothing is ever hidden by accident. Universal dispositions (empty Purposes) are
// always included.
func ccDispositionsForPurpose(purpose string) []ccDisposition {
	purpose = strings.ToLower(strings.TrimSpace(purpose))
	if purpose == "" {
		return ccDispositions
	}
	out := make([]ccDisposition, 0, len(ccDispositions))
	for _, d := range ccDispositions {
		if len(d.Purposes) == 0 {
			out = append(out, d)
			continue
		}
		for _, p := range d.Purposes {
			if p == purpose {
				out = append(out, d)
				break
			}
		}
	}
	return out
}

// ccDispositionByCode resolves a code, and also accepts the legacy display labels the
// React page used to POST ("Answered-Interested", "Wrong Number", …) so dispositions
// logged by an older frontend against a newer backend are not rejected mid-deploy.
func ccDispositionByCode(s string) (ccDisposition, bool) {
	s = strings.TrimSpace(s)
	for _, d := range ccDispositions {
		if strings.EqualFold(d.Code, s) || strings.EqualFold(d.Label, s) {
			return d, true
		}
	}
	legacy := map[string]string{
		"Answered-Interested":     "answered_interested",
		"Answered-Not Interested": "answered_not_interested",
		"No Answer":               "no_answer",
		"Wrong Number":            "wrong_number",
		"PTP":                     "ptp",
		"Callback":                "callback",
	}
	if code, ok := legacy[s]; ok {
		for _, d := range ccDispositions {
			if d.Code == code {
				return d, true
			}
		}
	}
	return ccDisposition{}, false
}

// ccDispositionCode normalizes any disposition string — a canonical code, a current or
// legacy label, or one of the older shared-form labels the reporting table accumulated
// ("Unreachable / No Answer", "Not Interested", "Callback Scheduled", "Interested") — to
// the canonical code. This is the single writer-side normalizer, mirrored by the SQL
// backfill in migration 193 so the stored column and new writes speak one vocabulary.
//
// Empty in → "". A raw connected telephony outcome (completed/answered/resolved) → the
// soft code "connected" (a human spoke, but the agent recorded no business disposition).
// Anything else non-empty → "other", so it still groups rather than masquerading as a
// real code. Ordering matters: "not interested" is tested before "interested".
func ccDispositionCode(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if d, ok := ccDispositionByCode(s); ok {
		return d.Code
	}
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "do not call"):
		return "do_not_call"
	case strings.Contains(l, "promise to pay"), l == "ptp":
		return "ptp"
	case strings.Contains(l, "not eligible"):
		return "not_eligible"
	case strings.Contains(l, "not ready"):
		return "not_ready"
	case strings.Contains(l, "callback"):
		return "callback"
	case strings.Contains(l, "drop"):
		return "call_dropped"
	case strings.Contains(l, "not interested"):
		return "answered_not_interested"
	case strings.Contains(l, "interested"):
		return "answered_interested"
	case strings.Contains(l, "wrong number"):
		return "wrong_number"
	case strings.Contains(l, "unreachable"), strings.Contains(l, "no answer"),
		l == "no_answer", strings.Contains(l, "voicemail"), l == "missed":
		return "no_answer"
	case l == "completed", l == "answered", l == "resolved", l == "connected":
		return "connected"
	}
	return "other"
}

// ccListDispositions serves the vocabulary so the frontend renders from one list
// instead of its own copy.
func ccListDispositions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": ccDispositions}) //nolint:errcheck
	}
}

// ccCallOutcome maps a disposition to the telephony outcome recorded on the call
// ledger: did the phone actually reach a conversation?
//
// A queue call carries no duration and no recording — the agent just picks an outcome
// — so the disposition is the only evidence there is. ccLogCall used to write
// 'completed' for anything flagged Connected, which put "Call Dropped" (answered, then
// dead within seconds, nothing discussed) into the connect count. callUnansweredExpr
// in helpdesk.go then exempts source_system='call_center' rows from the sub-5-second
// rule, so no downstream reader could correct it: the connect rate was inflated at the
// point of writing and every surface inherited it.
//
// Nothing is lost by being honest here — the disposition and its label ride on the
// same row, so "Call Dropped" is still exactly what the Call Log shows.
func ccCallOutcome(d ccDisposition) string {
	if !d.Connected {
		// An outbound dial nobody picked up. 'no_answer' rather than 'missed' because
		// the Call Log renders an unanswered OUTBOUND call "No Answer"
		// (resultCategoryExpr); both sit inside callUnansweredExpr, so the connect
		// count is identical either way.
		return "no_answer"
	}
	if d.Code == "call_dropped" {
		// Answered, then gone within seconds. The line connected; a conversation did
		// not. The module's own connect test already discounts a 'completed' call
		// under callConnectMinSec with no recording — a queue call has no duration to
		// fail that test with, so counting it as a connect would let the MISSING
		// measurement promote it. Counted the way a 3-second call is counted.
		return "no_answer"
	}
	return "completed"
}

// ccApplyDisposition applies a disposition's consequences to a contact: where it moves
// to, when it should ring back, and whether the number is suppressed outright.
//
// It changes ONLY what the disposition actually means to change. It used to rewrite
// every field on every call, which destroyed work: status was reset to 'pending'
// whenever a disposition carried none, silently reopening 'closed' and 'invalid'
// contacts back into the dial pool; and callback_at was cleared on every disposition
// that did not set one, so a "No Answer" on a later dial erased the call-back time the
// customer had actually asked for.
//
// Errors are logged rather than returned: the call itself is already in helpdesk_calls
// by this point, and failing the agent's request would tell them the call went unlogged
// when it did not. They were previously discarded outright, which is how a failed cast
// could lose a disposition's entire effect while the agent saw a 201.
func ccApplyDisposition(ctx context.Context, db *core.DB, contactID string,
	d ccDisposition, phone string, callbackAt *string, userID *int64) {

	// A callback with no time is still a callback — default it rather than dropping the
	// promise on the floor, so it resurfaces tomorrow morning instead of never.
	//
	// Built as a real timestamp here. The previous default was the string
	// 'tomorrow 09:00', which is not a timestamptz literal Postgres accepts, so the
	// whole UPDATE failed — and with the error discarded, the status move, the call-back
	// AND the DNC suppression were all lost behind a 201.
	var cb any
	if d.NeedsCallback {
		if callbackAt != nil && *callbackAt != "" {
			cb = *callbackAt
		} else {
			cb = time.Now().AddDate(0, 0, 1).Format("2006-01-02") + " 09:00:00"
		}
	} else if d.Code == "not_ready" && callbackAt != nil && *callbackAt != "" {
		// "Not Ready Yet" can carry an OPTIONAL try-again date without being a promised
		// callback: set, it floats the contact back into the queue on that day; left
		// blank, it just rests and returns after the cooldown.
		cb = *callbackAt
	}

	// Did THIS dial actually reach the customer? A promised call-back is a promise to
	// TRY the number at that time, not to close the contact — so a real conversation
	// fulfils it no matter what was said ("Answered — Interested" and "Promise to Pay"
	// both carry no status of their own, same as "No Answer"). Without this, calling
	// a customer back exactly as promised and logging the outcome left the old
	// callback_at in place: the contact kept showing "Callback Due" and inflating the
	// queue's count forever, because nothing here ever cleared a promise that wasn't
	// being replaced by a newer one or closed outright.
	//
	// "Call Dropped" is the one connected code that is NOT a real conversation — the
	// line picked up and died within seconds, so whatever was promised still stands.
	fulfilled := d.Connected && d.Code != "call_dropped"

	if _, err := db.PGExec(ctx,
		`UPDATE call_center_contacts
		    SET disposition_code = $1,
		        last_disposition = $2,
		        -- Only a disposition that names a status moves the contact. One that
		        -- names none ("No Answer", "Call Dropped") leaves it where it is, so a
		        -- later dial can no longer reopen a contact an agent deliberately
		        -- closed. The exception is a promised call-back: the customer asked to
		        -- be rung back, and only a 'pending' row is ever served by the queue or
		        -- alarmed by the reminder worker, so that one reopens the contact.
		        status           = CASE WHEN NULLIF($3::text,'') IS NOT NULL THEN $3
		                                WHEN $4::text IS NOT NULL             THEN 'pending'
		                                ELSE status END,
		        -- Set a new time when this disposition carries one; drop a now-meaningless
		        -- one when the contact is being closed out or the call-back was just
		        -- fulfilled by reaching the customer; otherwise (no answer, call dropped)
		        -- leave the customer's existing promise alone for the next attempt.
		        callback_at      = CASE WHEN $4::text IS NOT NULL THEN $4::timestamptz
		                                WHEN $3::text IN ('closed','invalid') THEN NULL
		                                WHEN $6::boolean THEN NULL
		                                ELSE callback_at END,
		        -- Re-arm the reminder whenever a NEW call-back is scheduled. The worker
		        -- fires only where callback_notified_at IS NULL, so leaving the old stamp
		        -- in place meant the SECOND call-back on a contact never alerted anyone.
		        callback_notified_at = CASE WHEN $4::text IS NOT NULL THEN NULL
		                                    ELSE callback_notified_at END,
		        updated_at       = NOW()
		  WHERE id = $5`,
		d.Code, d.Label, d.Status, cb, contactID, fulfilled); err != nil {
		slog.Error("ccApplyDisposition: apply to contact",
			"contact", contactID, "disposition", d.Code, "err", err)
	}

	if d.AddToDNC {
		// Store the canonical form app.norm_phone() produces — the bare last 10 digits —
		// and conflict on it, so the list holds one row per number instead of the same
		// number in four shapes. length()==10 is the validity guard: norm_phone returns
		// '' (not NULL) for anything it cannot parse, and a blank row on the DNC list
		// would suppress every contact whose phone is blank.
		if np := normalizePhone(phone); len(np) == 10 {
			if _, err := db.PGExec(ctx,
				`INSERT INTO dnc_list (phone, reason, added_by)
				 VALUES ($1, 'Agent disposition: Do Not Call', $2)
				 ON CONFLICT (phone) DO NOTHING`, np, userID); err != nil {
				slog.Error("ccApplyDisposition: add to DNC",
					"contact", contactID, "err", err)
			}
		} else {
			// A do-not-call we cannot act on is a regulatory gap, not a no-op.
			slog.Warn("ccApplyDisposition: do-not-call NOT suppressed — unusable phone",
				"contact", contactID, "phone", phone)
		}
	}

	// A lapsed customer who asks for an offer is the entire point of a win-back
	// call, and the call centre cannot make one. Raise it to Sales on the hand-off
	// rail that already carries cross-team work, so it lands on /handoffs with an
	// owner rather than dying in a disposition nobody reads.
	//
	// Deliberately NOT done for every high-value lapsed customer at queue-build
	// time: that would have dropped 417 hand-offs on Sales in one press, which is
	// how an alerting rail gets ignored. One customer asking is one hand-off.
	if d.Code == "winback_wants_offer" {
		go ccRaiseWinbackHandoff(context.WithoutCancel(ctx), db, contactID, phone, userID)
	}
}

// ccRaiseWinbackHandoff hands one warm win-back customer to Sales.
// Fire-and-forget: the disposition is already recorded, and a failed hand-off must
// not throw an error back at an agent who has just finished a conversation.
func ccRaiseWinbackHandoff(ctx context.Context, db *core.DB, contactID, phone string, userID *int64) {
	var name, cif string
	if rows, _ := db.PGQuery(ctx,
		`SELECT COALESCE(customer_name,'') AS n, COALESCE(cif,'') AS c
		   FROM call_center_contacts WHERE id = $1`, contactID); len(rows) > 0 {
		name = str(rows[0]["n"])
		cif = str(rows[0]["c"])
	}
	if name == "" {
		name = "A lapsed customer"
	}
	// What they were worth is the whole reason Sales should pick this up first, so
	// it goes in the subject rather than being something they have to look up.
	worth := ""
	if cif != "" {
		if v, _ := db.PGQuery(ctx, `
			SELECT cl.value_kobo, cl.value_tier, cl.days_since_txn
			  FROM app.customer_lifecycle cl
			  JOIN app.customers c ON c.party_id = cl.party_id
			 WHERE COALESCE(NULLIF(c.cif,''), c.contact_id) = $1 LIMIT 1`, cif); len(v) > 0 {
			worth = fmt.Sprintf(" — %s tier, was worth %s a year, last active %d days ago",
				strings.ToUpper(str(v[0]["value_tier"])),
				formatKoboShort(toInt64(v[0]["value_kobo"])),
				toInt64(v[0]["days_since_txn"]))
		}
	}
	logActivitySafe(ctx, db, Activity{
		CIF:         cif,
		Phone:       phone,
		ActorUserID: userID,
		ActorTeam:   "call_center",
		Type:        "handoff",
		Direction:   "internal",
		TargetTeam:  "sales",
		Status:      "open",
		Subject:     "Win-back: " + name + " wants an offer",
		Body: "Reached on a win-back call and asked about a new offer" + worth +
			". The call centre cannot price or place one — Sales to follow up.",
		Source: "retention",
	})
	slog.Info("retention: win-back hand-off raised to Sales", "contact", contactID, "cif", cif)
}

// isRawCallOutcome reports whether a string is a telephony outcome rather than a
// business disposition. The two live in different columns and mean different
// things: an outcome says whether the phone connected, a disposition says what
// the agent concluded. Storing one as the other is how 'completed' ended up
// rendered to agents as the result of a call.
func isRawCallOutcome(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "completed", "missed", "no_answer", "no answer", "voicemail", "answered", "resolved":
		return true
	}
	return false
}

// Whether a disposition asserts that a human conversation took place.
//
// This is the missing signal in call attachment. An agent who dials, gets no
// answer, dials again and connects produces two rows; the write-up they then
// save says which of the two it describes. "Not Interested" cannot be the
// outcome of a call nobody answered, and "Unreachable / No Answer" cannot be the
// outcome of a two-minute conversation — but the matcher only knew "most recent
// un-written-up call", so a second dial routinely inherited the first call's
// account of itself, and vice versa.
//
// Returns (expectsConversation, known). known=false means the disposition says
// nothing either way and the caller should not bias on it — "Wrong Number" is
// genuinely both (an invalid number, or a person telling you so), and guessing
// would trade one wrong attachment for another.
func dispositionExpectsConversation(s string) (expects, known bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "":
		return false, false
	// Nobody spoke.
	case "unreachable / no answer", "no answer", "no_answer", "voicemail", "unreachable":
		return false, true
	// Ambiguous by nature — do not bias.
	//
	// "Call Dropped" belongs here despite the line having been answered. The
	// "connected" test a caller applies is duration > 5s OR a recording, and a
	// call dropped after three seconds satisfies neither reliably — biasing it
	// toward connected calls would push these write-ups onto the wrong row for
	// exactly the calls the disposition exists to describe.
	case "wrong number", "wrong_number", "pending / follow-up", "call dropped", "call_dropped":
		return false, false
	}
	// Everything else in the vocabulary — Interested, Not Interested, Not Ready
	// Yet, Not Eligible, Converted, Callback Scheduled, Do Not Call, Promise to
	// Pay, Paid, Dispute, Escalated, Resolved — is a conclusion you can only
	// reach by speaking to someone.
	return true, true
}

// callAttachMode maps a disposition to the ordering bias hdLatestCall applies:
// 0 = no preference, 1 = prefer a call that connected, 2 = prefer a dial that did not.
func callAttachMode(disposition string) int {
	expects, known := dispositionExpectsConversation(disposition)
	if !known {
		return 0
	}
	if expects {
		return 1
	}
	return 2
}

// hdBetterAttachTarget returns a call id to attach a write-up to instead of the
// one the client chose, or 0 to keep the client's choice.
//
// It only ever moves a write-up between two calls the SAME agent made to the
// SAME number within a few minutes — i.e. legs of one dialling episode, where
// the only question is which leg the agent means. It never reaches across
// numbers or agents.
//
// It intervenes only when the chosen call plainly contradicts the disposition
// AND an un-written-up sibling plainly fits. When nothing clearly fits, the
// client's choice stands: a wrong guess here is worse than leaving the agent's
// own selection alone.
func hdBetterAttachTarget(ctx context.Context, db *core.DB, chosenID int64, disposition string) int64 {
	expects, known := dispositionExpectsConversation(disposition)
	if !known {
		return 0
	}
	rows, err := db.PGQuery(ctx, `
		WITH chosen AS (
		    SELECT id, agent_id, started_at,
		           (COALESCE(duration_sec,0) > 5 OR recording_filename IS NOT NULL) AS connected,
		           `+normalizedPhoneExpr("customer_phone")+` AS ph
		      FROM helpdesk_calls WHERE id = $1
		)
		SELECT c.id
		  FROM helpdesk_calls c, chosen
		 WHERE `+normalizedPhoneExpr("c.customer_phone")+` = chosen.ph
		   AND chosen.ph <> ''
		   AND c.id <> chosen.id
		   AND c.agent_id IS NOT DISTINCT FROM chosen.agent_id
		   AND c.merged_into_call_id IS NULL AND c.voided_at IS NULL
		   AND COALESCE(NULLIF(TRIM(c.notes),''), NULLIF(TRIM(c.disposition),'')) IS NULL
		   AND c.started_at BETWEEN chosen.started_at - interval '15 min'
		                        AND chosen.started_at + interval '15 min'
		   -- Only act when the chosen call is the WRONG kind and this one is right.
		   AND chosen.connected <> $2
		   AND (COALESCE(c.duration_sec,0) > 5 OR c.recording_filename IS NOT NULL) = $2
		 ORDER BY c.started_at DESC
		 LIMIT 1`, chosenID, expects)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return toInt64(rows[0]["id"])
}

// The SQL forms of the vocabulary above, so the absorb query can make the same
// judgement the Go classifier makes. Kept beside it and covered by
// TestDispositionVocabularyAgrees, because two copies of a vocabulary that drift
// apart is exactly how a call ends up carrying another call's outcome.
const (
	sqlNoContactDispositions = `('unreachable / no answer','no answer','no_answer','voicemail','unreachable')`
	sqlAmbiguousDispositions = `('wrong number','wrong_number','pending / follow-up','call dropped','call_dropped')`
)

// sqlDispositionFitsCall renders the predicate "this write-up belongs on this
// call", given a disposition column and a boolean 'connected' column.
func sqlDispositionFitsCall(dispositionCol, connectedCol string) string {
	return `(CASE
	           WHEN TRIM(COALESCE(` + dispositionCol + `,'')) = '' THEN TRUE
	           WHEN lower(TRIM(` + dispositionCol + `)) IN ` + sqlNoContactDispositions + ` THEN NOT ` + connectedCol + `
	           WHEN lower(TRIM(` + dispositionCol + `)) IN ` + sqlAmbiguousDispositions + ` THEN TRUE
	           ELSE ` + connectedCol + `
	         END)`
}
