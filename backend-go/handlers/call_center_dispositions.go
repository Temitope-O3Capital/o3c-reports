package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/o3c/reports/core"
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
	// Hint is shown under the option so an agent knows what they are committing to.
	Hint string `json:"hint"`
}

var ccDispositions = []ccDisposition{
	{Code: "answered_interested", Label: "Answered — Interested", Status: "", Connected: true,
		Hint: "Stays in the queue for follow-up"},
	{Code: "answered_not_interested", Label: "Answered — Not Interested", Status: "closed", Connected: true,
		Hint: "Closes the contact — no further calls"},
	{Code: "callback", Label: "Callback Requested", Status: "", NeedsCallback: true, Connected: true,
		Hint: "Served again at the time you set, ahead of everything else"},
	{Code: "ptp", Label: "Promise to Pay", Status: "", Connected: true,
		Hint: "Recorded in the Collections promise book"},
	// "Not eligible" and "not ready" were being forced into "Not Interested",
	// which CLOSES the contact. They are different outcomes with different
	// follow-ups, and collapsing them lost every not-yet lead worth calling back.
	{Code: "not_eligible", Label: "Not Eligible", Status: "closed", Connected: true,
		Hint: "Does not qualify (age, employer, exposure) — closes the contact"},
	{Code: "not_ready", Label: "Not Ready Yet", Status: "", Connected: true,
		Hint: "Interested but not now — stays in the queue for a later cycle"},
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

// ccListDispositions serves the vocabulary so the frontend renders from one list
// instead of its own copy.
func ccListDispositions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": ccDispositions}) //nolint:errcheck
	}
}

// ccApplyDisposition applies a disposition's consequences to a contact: where it moves
// to, when it should ring back, and whether the number is suppressed outright.
//
// Errors are logged by the caller's error path rather than surfaced per-statement — the
// call itself is already recorded in helpdesk_calls by that point, and losing the
// follow-up state must not make the agent think the call went unlogged.
func ccApplyDisposition(ctx context.Context, db *core.DB, contactID string,
	d ccDisposition, phone string, callbackAt *string, userID *int64) {

	status := d.Status
	if status == "" {
		status = "pending"
	}

	// A callback with no time is still a callback — default it rather than dropping the
	// promise on the floor, so it resurfaces tomorrow instead of never.
	var cb any
	if d.NeedsCallback {
		if callbackAt != nil && *callbackAt != "" {
			cb = *callbackAt
		} else {
			cb = "tomorrow 09:00"
		}
	}

	db.PGExec(ctx, //nolint:errcheck
		`UPDATE call_center_contacts
		    SET disposition_code = $1,
		        last_disposition = $2,
		        status           = $3,
		        callback_at      = CASE WHEN $4::text IS NULL THEN NULL
		                                ELSE $4::timestamptz END,
		        updated_at       = NOW()
		  WHERE id = $5`,
		d.Code, d.Label, status, cb, contactID)

	if d.AddToDNC && strings.TrimSpace(phone) != "" {
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO dnc_list (phone, reason, added_by)
			 VALUES ($1, 'Agent disposition: Do Not Call', $2)
			 ON CONFLICT (phone) DO NOTHING`, phone, userID)
	}
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
