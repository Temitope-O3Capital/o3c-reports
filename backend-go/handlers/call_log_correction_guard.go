package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Telling a CORRECTION apart from a LATER DEVELOPMENT.
//
// A call log is the record of what was said on one call at one time. Correcting it is
// legitimate — an agent mis-clicks, or writes up the wrong leg of a dialling episode.
// Overwriting it because the customer did something else a week later is not: it moves
// an event that happened on Friday onto Monday's call, and Monday's call stops being a
// record of anything.
//
// Measured on 2026-09-28, of 280 edits on helpdesk_calls:
//
//   - 188 filled in a disposition the agent had left blank. Completing a log, not
//     rewriting one. These must stay frictionless — they are two thirds of all edits.
//   - ~43 overwrote an outcome that had already been recorded, and the delay says what
//     they really were: Interested → Not Interested averaging 104 HOURS later,
//     Interested → Not Eligible 132 hours, Interested → Converted. Nobody learns four
//     days later what was said on Monday's call.
//   - 13 were Callback Scheduled → Unreachable at ~17 hours: the agent made the promised
//     call-back, got no answer, and overwrote the original instead of logging the new
//     dial. The second attempt vanished entirely — no credit for the agent, and the
//     customer looks un-chased.
//   - 278 of the 280 recorded no reason at all. The field existed and was dead.
//
// The delay is the signal that separates the two, and the two populations barely
// overlap: corrections land within minutes (0.1–0.6h), developments at 17h and up.
//
// Agents were not being careless. Editing was the only door we had left open — logging
// a new call means claiming a call that never happened, and an activity note was
// invisible from the Call Log. So this guard does not simply refuse: it names the door
// the agent actually wanted (record a step, or log the new dial) and sends them there.

// How long after a call an unexplained change of outcome is still treated as a plausible
// mis-pick rather than a later development.
//
// Six hours sits in the empty space between the two populations above, and errs towards
// the agent: anything they notice during the same shift is still a correction.
const callCorrectionWindow = 6 * time.Hour

// How much explanation a late correction has to carry. Same floor as an "Other"
// disposition, for the same reason — "fix", "-" and "n/a" are how a mandatory field
// gets defeated.
const callEditReasonMinRunes = 15

type callEditKind int

const (
	// "" → X. The agent is completing a log they left unfinished. Always allowed.
	editFillingBlank callEditKind = iota
	// A plausible mis-pick, made while the agent is still in the same shift as the call,
	// or a relabel that changes nothing. Allowed silently — this is ordinary work.
	editCorrection
	// Late, but not a shape that can only be a later development: nobody answered and now
	// there is a conversation on the record (an agent who wrote the call up on the wrong
	// row), or an outcome that is ambiguous by nature. Allowed, but it has to say why —
	// 278 of 280 edits recorded no reason at all.
	editLateCorrection
	// A different conclusion about a conversation, recorded long after it ended. The
	// call was right when it was written; something has happened since.
	editLaterDevelopment
	// A subsequent dial written over the first one, so the first disappears.
	editNewAttempt
)

// classifyDispositionEdit decides what an agent is really doing when they change a
// call's disposition.
//
// `since` is how long after the call STARTED the edit is being made. A zero or negative
// duration (a clock skew, or a missing started_at) is treated as inside the window:
// refusing an edit because of a bad timestamp would block real work to prevent a
// bookkeeping problem.
func classifyDispositionEdit(from, to string, since time.Duration) callEditKind {
	if strings.TrimSpace(from) == "" {
		return editFillingBlank
	}
	if ccDispositionCode(from) == ccDispositionCode(to) {
		// Relabelled to a synonym — "PTP" to "Promise to Pay". Nothing changed.
		return editCorrection
	}
	if since < callCorrectionWindow {
		return editCorrection
	}

	fromTalked, fromKnown := dispositionExpectsConversation(from)
	toTalked, toKnown := dispositionExpectsConversation(to)

	// Wrong Number and Call Dropped are genuinely ambiguous — a dead number or a person
	// telling you it is the wrong one. Never refuse on an ambiguity; a wrong refusal
	// costs an agent their correction, which is how they learn to stop reporting things.
	if !fromKnown || !toKnown {
		return editLateCorrection
	}

	switch {
	// A conversation happened, and now the record says nobody answered. That is the
	// NEXT dial, not this one.
	case fromTalked && !toTalked:
		return editNewAttempt
	// Two different conclusions about the same conversation, days apart. The first one
	// was not wrong; the customer moved.
	case fromTalked && toTalked:
		return editLaterDevelopment
	// Nobody answered, and now there is a conversation on the record. Almost always an
	// agent who forgot to write up the call that did connect. Let them, with a reason.
	default:
		return editLateCorrection
	}
}

// callEditRefusal returns the message to refuse an edit with, or "" to allow it.
//
// The message is the whole point: it has to leave the agent knowing which control to
// use instead, or they will find another way to write the same wrong thing.
func callEditRefusal(kind callEditKind, from, to, reason string) string {
	switch kind {
	case editLaterDevelopment:
		return "This call recorded \"" + from + "\" and that was true when it was written. " +
			"If " + to + " is what has happened SINCE, use Record an Update on this " +
			"customer instead — it adds the new step to their timeline and leaves the " +
			"call as the record of what was actually said. Only change the call itself " +
			"if you picked the wrong outcome at the time."
	case editNewAttempt:
		return "This call recorded \"" + from + "\", so \"" + to + "\" is a later attempt " +
			"rather than a correction to this one. Log that attempt as its own call — " +
			"overwriting this one deletes the conversation you already had, and you lose " +
			"the credit for the call you have just made."
	case editLateCorrection:
		if len([]rune(strings.TrimSpace(reason))) < callEditReasonMinRunes {
			return "Say briefly why this outcome is being changed. It has been more than " +
				"a few hours since the call, so whoever reads this log next needs to know " +
				"whether the original was a mistake or something has changed."
		}
	}
	return ""
}

// callEditNeedsReason reports whether this change may not be saved without an
// explanation. Kept separate from the refusal text so the API can tell a client which
// field to put the cursor in.
//
// Note it takes no duration: the age is already baked into the classification, which is
// the whole reason editLateCorrection is a kind of its own. An earlier version compared
// the age here as well, and demanded a reason for same-shift corrections too — the
// common case made worse to fix the rare one.
func callEditNeedsReason(kind callEditKind) bool {
	return kind == editLateCorrection
}

// editSuggestion names the control the agent actually wanted, so the form can open it
// for them rather than leaving them to read a paragraph and work it out.
//
// A refusal that does not offer an alternative does not prevent the bad record — it
// just makes the agent find a different way to write it.
func editSuggestion(kind callEditKind) string {
	switch kind {
	case editLaterDevelopment:
		return "record_step" // opens the Record an Update form on this customer
	case editNewAttempt:
		return "log_new_call" // opens the call form, pre-set to this customer
	case editLateCorrection:
		return "give_reason"
	}
	return ""
}

// editNeedsField names the input to focus when the edit can still be saved as it stands
// once the agent adds something.
func editNeedsField(kind callEditKind) string {
	if kind == editLateCorrection {
		return "reason"
	}
	return ""
}

// respondEditRefusal declines an edit in the shape respondErr uses — the frontend reads
// `detail` — plus the two fields that tell it what to offer next.
func respondEditRefusal(w http.ResponseWriter, kind callEditKind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(422)
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"detail":      msg,
		"error_code":  "call_edit_not_a_correction",
		"suggest":     editSuggestion(kind),
		"needs_field": editNeedsField(kind),
	})
}
