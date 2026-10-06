package handlers

// ccLeadStatusByDisposition maps every disposition in the catalogue to the lead status
// that call implies — ONE table, consulted after ONE normaliser.
//
// WHY THIS EXISTS. leadStatusFromCall was a second, independent substring matcher beside
// ccDispositionCode, and the two disagreed. The expensive case has already been fixed
// (see the "to verify" guard: "Says They Have Paid — To Verify" contains "paid" and was
// permanently marking a lead converted on a customer's unverified word). What was left
// was quieter and larger: nine dispositions the catalogue has a clear opinion about fell
// through leadStatusFromCall's switch to a bare "called", so the contact and the lead
// told a supervisor two different stories about the same call.
//
// The catalogue already states the intent in prose, in each entry's Hint. This table is
// read off those hints, not invented:
//
//   - "stays in the queue" / "stays open until …" → the lead is NOT terminal. Something
//     is owed, so the lead carries 'callback' (rank 3) where a follow-up call is the
//     thing owed, 'not_ready' where it is simply too early, 'no_answer' where nobody
//     spoke at all.
//   - "closes the contact" → the lead may be terminal, with one exception below.
//
// THE EXCEPTION, and it is deliberate: a CUSTOMER DECLINE closes the contact but leaves
// the lead workable at 'called'. That is the established precedent, not an oversight —
// "Answered — Not Interested" closes the contact and maps to 'called' so a later call
// can still advance the lead, and leadDeclinedOnCall exists specifically to handle the
// consequence. "Rate or Charges Too High" is the same kind of fact (the customer saying
// no, for a reason that can change), so it keeps the same treatment. Our OWN declines
// ("Not Eligible", "Wants a Product We Do Not Offer") and finished business ("Resolved",
// "Information Provided", "Closed") are terminal, because nothing a later call does
// changes them.
//
// Terminality is the part worth being slow about: 'converted', 'closed', 'invalid' and
// 'dnc' all share rank 5 in ccLeadStatusRank, and the forward-only guard means nothing
// later can move a lead out of them. Every value below was checked against that rank
// table rather than chosen by feel, and TestLeadStatusMatchesContactStatus pins the one
// invariant that must never break: a disposition that leaves the CONTACT open (Status
// "") must never give the LEAD a terminal status, or the queue would keep calling
// someone whose lead can no longer record the result.
var ccLeadStatusByDisposition = map[string]string{
	// ── Contact stays open: the lead must stay movable ────────────────────────
	"answered_interested":     "interested",
	"callback":                "callback",
	"ptp":                     "callback", // a promise is a follow-up call
	"not_ready":               "not_ready",
	"call_dropped":            "pending", // nothing was established; dial again
	"no_answer":               "no_answer",
	"payment_to_verify":       "callback", // never 'converted' — see the guard
	"dispute":                 "callback",
	"winback_wants_offer":     "interested",
	"info_sent":               "callback",  // "until they reply" — a reply is owed
	"call_rejected":           "no_answer", // Connected:false, nobody spoke
	"registration_incomplete": "callback",  // "so someone can finish it with them"
	"not_yet_due":             "not_ready", // "rests and returns when it is"
	"escalated":               "callback",  // "stays open until they close it out"
	"complaint_logged":        "callback",  // "stays open until it is answered"
	"pending_followup":        "callback",  // "unfinished"

	// ── Customer declines: contact closes, lead stays workable ────────────────
	"answered_not_interested": "called",
	"winback_declined":        "called",
	"price_objection":         "called", // the customer saying no, for a changeable reason

	// ── Our decline, or business finished: terminal ───────────────────────────
	"not_eligible":       "closed",
	"wrong_product":      "closed", // we do not sell what they want
	"resolved":           "closed",
	"info_provided":      "closed", // "their question was answered"
	"closed":             "closed",
	"winback_price":      "closed",
	"winback_service":    "closed",
	"winback_competitor": "closed",
	"winback_no_need":    "closed",

	// ── Terminal and positive ─────────────────────────────────────────────────
	"converted":           "converted",
	"paid":                "converted",
	"winback_reactivated": "converted",

	// ── Terminal and absolute ─────────────────────────────────────────────────
	"wrong_number": "invalid",
	"do_not_call":  "dnc",

	// "other" is deliberately ABSENT. It means "I cannot tell you from the dropdown",
	// so there is nothing to infer — and leaving it out lets leadStatusFromCall fall
	// through to its substring matcher, which is still the right reader for the free
	// text that legacy helpdesk_calls rows carry.
}

// ccDecliningDispositionCodes are the dispositions where the CUSTOMER THEMSELVES said no.
//
// This is the one thing allowed to overturn an earned 'interested', so it is kept narrow
// and explicit. leadDeclinedOnCall reads it after one pass through ccDispositionCode,
// which makes it the last reader in this group to stop matching substrings.
//
// THE BUG THAT MOTIVATED THE CHANGE. The old version lowercased the input, replaced
// underscores with spaces, and tested for "not interested" or "do not call". Its own
// comment said that was so "the CODE and the LABEL are matched by the same words" —
// and for two of the three it was. For the third it was not:
//
//	winback_declined             → "winback declined"          → NO MATCH
//	"Not Interested in Returning" → same disposition, as a label → MATCHES
//
// So whether a customer's refusal to come back could un-qualify their lead depended on
// which form the screen happened to send — and the function's own comment notes that
// callers differ, the outbound queue passing the label while the call-log endpoints pass
// whatever the client sent. Latent when found on 2026-10-06: zero calls and zero leads
// carry any winback disposition in either form, so nothing had been mis-handled yet.
//
// 'price_objection' is deliberately ABSENT, and that is an open question rather than a
// decision. "Rate or Charges Too High" is the customer saying no, so it arguably belongs
// here — but adding it changes when an earned 'interested' is withdrawn, which moves the
// qualified count and what reaches Sales. That is a judgement call with numbers attached,
// recorded in CALL_CENTRE_HANDOVER §14.9 rather than slipped in here.
var ccDecliningDispositionCodes = map[string]bool{
	"answered_not_interested": true,
	"winback_declined":        true,
	"do_not_call":             true,
}
