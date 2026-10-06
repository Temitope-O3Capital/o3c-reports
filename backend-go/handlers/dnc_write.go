package handlers

import (
	"context"
	"log/slog"

	"github.com/o3c/workspace/core"
)

// ccEnsureDNC is the ONE writer for a do-not-call that a logged call implies.
//
// WHY THIS EXISTS. "Do Not Call" reached dnc_list from two independent places, each
// keyed on a different id, and between them they missed most of the screens that can
// log a call:
//
//   - ccApplyDisposition writes it, keyed on contact_id — so only the Outbound Queue,
//     the one screen of seven that passes a contact_id to the shared call form.
//   - syncLeadFromCall writes it, keyed on lead_id — so Leads, and a callback reminder
//     whose source is a lead. Its own comment states the principle the other half of
//     the code did not follow: "that obligation does not depend on which screen logged
//     the call."
//
// A call carrying NEITHER id went through hdLogCall, recorded "Do Not Call" on the
// call row, and suppressed nothing: Helpdesk Calls, My Dashboard, Inbound, and a
// non-lead callback reminder. The Collections queue missed it a third way — it posts
// to collectionsOpsContact, which had no DNC handling at all, while its disposition
// list is derived from the same catalogue where do_not_call carries AddToDNC: true.
//
// The fix is to key the obligation on the one thing every one of those paths has: the
// PHONE NUMBER. dnc_list is a list of numbers, not of leads or contacts, so the id was
// never the right key — it was just the key each path happened to be holding.
//
// Writes are idempotent (ON CONFLICT DO NOTHING), so the lead and contact paths calling
// this as well as hdLogCall costs one no-op statement and keeps each path correct on
// its own. Deliberately NOT merged in: ccDNCAdd, the admin endpoint, which uses
// DO UPDATE and refuses an unusable number with a 422 — a person typing a number into
// a form should be told it is wrong, where a disposition's side-effect cannot be.
//
// Returns whether the number is now suppressed, so a caller can tell the difference
// between "listed" and "we could not act on this".
func ccEnsureDNC(ctx context.Context, db *core.DB, phone, reason string, userID *int64, origin string) bool {
	// Store the canonical form app.norm_phone() produces — the bare last 10 digits — and
	// conflict on it, so the list holds one row per number instead of the same number in
	// four shapes. length()==10 is the validity guard: norm_phone returns '' (not NULL)
	// for anything it cannot parse, and a blank row on the DNC list would suppress every
	// contact whose phone is blank.
	np := normalizePhone(phone)
	if len(np) != 10 {
		// A do-not-call we cannot act on is a regulatory gap, not a no-op.
		slog.Warn("ccEnsureDNC: do-not-call NOT suppressed — unusable phone",
			"origin", origin, "phone", phone)
		return false
	}
	if _, err := db.PGExec(ctx,
		`INSERT INTO dnc_list (phone, reason, added_by)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (phone) DO NOTHING`, np, reason, userID); err != nil {
		slog.Error("ccEnsureDNC: add to DNC", "origin", origin, "err", err)
		return false
	}
	return true
}

// ccDispositionAddsToDNC reports whether a disposition — as a code, a label, or whatever
// wording a screen sent — means the number must be suppressed.
//
// Resolved through ccDispositionCode so every spelling of it lands on the catalogue
// entry, rather than a fourth copy of `strings.Contains(d, "do not call")`.
func ccDispositionAddsToDNC(disposition string) bool {
	d, ok := ccDispositionByCode(ccDispositionCode(disposition))
	return ok && d.AddToDNC
}
