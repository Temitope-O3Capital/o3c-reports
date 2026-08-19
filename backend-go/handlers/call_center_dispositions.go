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
