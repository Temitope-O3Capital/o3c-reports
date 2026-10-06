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
// So the fact is now read off ONE source — ccDisposition.Connected, the field whose whole
// job is to record "whether a human actually spoke" — and anything the catalogue cannot
// place answers "I do not know" instead of "yes".

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
//     this file exists to remove — TestDispositionVocabularyAgrees caught exactly that,
//     with SQL calling it a conversation while Go called it unknown.
var ccNoEvidenceDispositionCodes = map[string]bool{
	"wrong_number":     true,
	"call_dropped":     true,
	"pending_followup": true,
	"other":            true,
}

// ccNoContactExtraWordings are raw telephony outcomes that mean "nobody spoke" but are
// not catalogue dispositions, so they have no Code or Label to derive from. Kept
// explicit and kept short.
var ccNoContactExtraWordings = []string{"voicemail", "unreachable", "missed"}

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
	// row carries all resolve here, so this function no longer keeps its own spellings.
	code := ccDispositionCode(s)
	// "connected" is the raw-outcome bucket rather than a disposition, so it is no
	// evidence either; "other" is covered by the map below.
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

// ccDispositionWordings renders every spelling of the dispositions matching pick — code
// and label, lowercased — as a SQL IN list, so the absorb query makes the same judgement
// the Go classifier makes from the same source.
//
// Quotes are doubled even though every value here is a compile-time constant from our own
// catalogue: a label is a sentence someone will one day write an apostrophe into, and the
// failure would be a syntax error in a query built at startup.
func ccDispositionWordings(pick func(ccDisposition) bool, extra ...string) string {
	seen := map[string]bool{}
	for _, d := range ccDispositions {
		if !pick(d) {
			continue
		}
		seen[strings.ToLower(strings.TrimSpace(d.Code))] = true
		seen[strings.ToLower(strings.TrimSpace(d.Label))] = true
	}
	for _, e := range extra {
		seen[strings.ToLower(strings.TrimSpace(e))] = true
	}
	out := make([]string, 0, len(seen))
	for w := range seen {
		if w == "" {
			continue
		}
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

func ccCarriesConnectEvidence(d ccDisposition) bool { return !ccNoEvidenceDispositionCodes[d.Code] }

// sqlNoContactDispositions: nobody spoke. Was a const list of seven hand-typed strings.
func sqlNoContactDispositions() string {
	return ccDispositionWordings(func(d ccDisposition) bool {
		return !d.Connected && ccCarriesConnectEvidence(d)
	}, ccNoContactExtraWordings...)
}

// sqlAmbiguousDispositions: says nothing either way. Named for the SQL CASE branch it
// feeds, which answers TRUE — "this write-up is not contradicted".
func sqlAmbiguousDispositions() string {
	return ccDispositionWordings(func(d ccDisposition) bool {
		return ccNoEvidenceDispositionCodes[d.Code]
	})
}

// sqlConversationDispositions: a human spoke. This list is the point of the change — it
// is what lets the CASE below name its "yes" branch explicitly instead of reaching it by
// elimination.
func sqlConversationDispositions() string {
	return ccDispositionWordings(func(d ccDisposition) bool {
		return d.Connected && ccCarriesConnectEvidence(d)
	})
}
