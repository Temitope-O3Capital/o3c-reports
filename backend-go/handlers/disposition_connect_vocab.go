package handlers

import (
	"sort"
	"strings"
)

// Did a human actually speak on this call? Three readers used to answer that, each from
// its own hand-typed list, and all three were DENY-LISTS: they named the dispositions
// where nobody spoke, named the ambiguous ones, and assumed everything else meant a
// conversation. Migration 308 converted the SQL twins of these to allow-lists for exactly
// that reason — the Go versions were never converted.
//
// WHY A DENY-LIST IS WRONG HERE. The fall-through is silent and it is the *confident*
// answer, not the cautious one. Add a disposition to the catalogue — as "Customer
// Rejected the Call" was added — and it is treated as a conversation from the moment it
// exists, with nothing to notice. That one mattered: it made callAttachMode prefer a call
// that CONNECTED, so hdBetterAttachTarget moved write-ups off the zero-second rejected
// call onto a nearby answered one by the same agent. The exact mis-attachment the
// mechanism exists to prevent, caused by the default rather than by a decision.
//
// So the fact is read off ONE source — ccDisposition.Connected, the field whose whole job
// is to record "whether a human actually spoke" — and the SQL lists are built by running
// every wording through the SAME Go classifier, so the two cannot disagree by
// construction. Anything the catalogue cannot place answers "I do not know".

// ccNoEvidenceDispositionCodes are the dispositions that say nothing either way about
// whether a human spoke, declared once here instead of in each reader.
//
// These are not oversights, they are genuinely uninformative:
//
//   - "Wrong Number" is an invalid number OR a person telling you so. Connected is false
//     for queue accounting, but as evidence about the call it is a coin flip, and guessing
//     would trade one wrong attachment for another.
//   - "Call Dropped" was answered, yet the connect test is duration > 5s or a recording,
//     and a call that died after three seconds satisfies neither reliably — biasing it
//     toward connected calls would push these write-ups onto the wrong row for exactly
//     the calls the disposition exists to describe.
//   - "Pending / Follow-up" describes the work, not the call.
//   - "Other" carries Connected: true in the catalogue, because an agent who reaches for
//     it has usually spoken to someone. But its whole meaning is "I cannot tell you from
//     the dropdown", and the note behind it is free text that may equally say the line was
//     engaged. Reading its Connected flag as evidence would be the same confident guess
//     this file exists to remove.
var ccNoEvidenceDispositionCodes = map[string]bool{
	"wrong_number":     true,
	"call_dropped":     true,
	"pending_followup": true,
	"other":            true,
}

// ccLegacyDispositionWordings are spellings that live in the disposition column but are
// NEITHER a catalogue code nor a catalogue label.
//
// THIS LIST IS A BUG FIX, and it was found by measuring the column rather than by reading
// the catalogue. Building the SQL lists from codes and labels alone left the screens' own
// wording out of all three of them, so it fell through to the CASE's ELSE branch — and on
// 2026-10-06 that was 4,475 live rows, still arriving the same day:
//
//	"not interested"  3,768 rows — the 2nd most common disposition in the table
//	"interested"        696 rows — the 6th
//	"issue resolved"     11 rows
//
// The catalogue says "Answered — Not Interested" and "Answered — Interested"; the Call Log
// form says the short forms, and "Issue Resolved" where the catalogue says "Resolved".
// ccDispositionCode has always normalised all three — that is the handover's §14.4 finding
// — so GO classified them correctly while SQL had no opinion at all. Both are conclusions
// you can only reach by speaking to someone, so losing them from the conversation list
// quietly stopped the absorb query from telling them apart from a no-answer.
//
// The rest are the stored forms ccDispositionByCode's own legacy map exists for. They are
// lowercased here because the SQL compares lower(TRIM(column)), and that map is
// case-sensitive, so these reach the classifier through the substring rules instead —
// which land on the same codes.
var ccLegacyDispositionWordings = []string{
	"not interested", "interested", "issue resolved",
	"no answer", "callback", "callback requested", "ptp",
	"answered-interested", "answered-not interested",
	// Raw telephony outcomes. Not dispositions, but they reach the column.
	"voicemail", "unreachable", "missed",
}

// ccConnectClass is what a wording says about whether a human spoke.
type ccConnectClass int

const (
	ccConnectNoEvidence ccConnectClass = iota // says nothing either way
	ccConnectNobodySpoke
	ccConnectSomeoneSpoke
)

// ccClassifyWording is the single judgement both languages use. The SQL lists are built
// from it, so a wording cannot be classified one way in Go and another in SQL.
func ccClassifyWording(w string) ccConnectClass {
	expects, known := dispositionExpectsConversation(w)
	switch {
	case !known:
		return ccConnectNoEvidence
	case expects:
		return ccConnectSomeoneSpoke
	default:
		return ccConnectNobodySpoke
	}
}

// dispositionExpectsConversation reports whether this disposition implies a human spoke.
//
// Returns (expects, known). known=false means the disposition says nothing either way and
// the caller must not bias on it — every caller treats that as "no preference", which is
// why answering "I do not know" for unrecognised wording is safe where assuming "yes"
// was not.
func dispositionExpectsConversation(s string) (expects, known bool) {
	if strings.TrimSpace(s) == "" {
		return false, false
	}
	// ONE normaliser. Codes, labels, legacy spellings and the raw outcomes a telephony
	// row carries all resolve here, so this function keeps no spellings of its own.
	code := ccDispositionCode(s)
	// "connected" is the raw-outcome bucket rather than a disposition, so it is no
	// evidence either; "other" is covered by the map above.
	if code == "" || code == "connected" {
		return false, false
	}
	if ccNoEvidenceDispositionCodes[code] {
		return false, false
	}
	d, ok := ccDispositionByCode(code)
	if !ok {
		return false, false
	}
	return d.Connected, true
}

// ccAllDispositionWordings is every spelling known to reach the disposition column:
// catalogue codes, catalogue labels, and the legacy forms measured in the table.
func ccAllDispositionWordings() []string {
	out := make([]string, 0, 2*len(ccDispositions)+len(ccLegacyDispositionWordings))
	for _, d := range ccDispositions {
		out = append(out, d.Code, d.Label)
	}
	return append(out, ccLegacyDispositionWordings...)
}

// ccDispositionWordings renders every known wording of a given class as a SQL IN list, so
// the absorb query makes the same judgement the Go classifier makes, from the same call.
//
// Quotes are doubled even though every value here is a compile-time constant from our own
// catalogue: a label is a sentence someone will one day write an apostrophe into, and the
// failure would be a syntax error in a query built at startup.
func ccDispositionWordings(class ccConnectClass) string {
	seen := map[string]bool{}
	for _, w := range ccAllDispositionWordings() {
		lw := strings.ToLower(strings.TrimSpace(w))
		if lw == "" || ccClassifyWording(lw) != class {
			continue
		}
		seen[lw] = true
	}
	out := make([]string, 0, len(seen))
	for w := range seen {
		out = append(out, "'"+strings.ReplaceAll(w, "'", "''")+"'")
	}
	// Sorted so the rendered SQL is stable between runs — a query string that reorders
	// itself defeats statement caching and makes two logs impossible to diff.
	sort.Strings(out)
	if len(out) == 0 {
		// An empty IN list is a syntax error. NULL matches nothing, which is the
		// correct meaning of "no disposition qualifies".
		return "(NULL)"
	}
	return "(" + strings.Join(out, ",") + ")"
}

// sqlNoContactDispositions: nobody spoke.
func sqlNoContactDispositions() string { return ccDispositionWordings(ccConnectNobodySpoke) }

// sqlAmbiguousDispositions: says nothing either way. Named for the SQL CASE branch it
// feeds, which answers TRUE — "this write-up is not contradicted".
func sqlAmbiguousDispositions() string { return ccDispositionWordings(ccConnectNoEvidence) }

// sqlConversationDispositions: a human spoke. This list is the point of the change — it is
// what lets the CASE name its "yes" branch explicitly instead of reaching it by
// elimination.
func sqlConversationDispositions() string { return ccDispositionWordings(ccConnectSomeoneSpoke) }
