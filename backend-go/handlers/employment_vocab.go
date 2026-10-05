package handlers

import "strings"

// The employment-type vocabulary, and the translation Phoenix needs.
//
// WHY THIS FILE EXISTS. Two forms offered two different lists for one column, neither validated
// anywhere, and the value is forwarded to a SECOND SYSTEM that accepts neither list in full:
//
//   los/NewApplication.tsx        : 'permanent' | 'contract' | 'self_employed'
//   components/NewApplicationModal.tsx : 'salaried' | 'self_employed' | 'contract' |
//                                        'retired' | 'unemployed'
//
// 'permanent' and 'salaried' are one thing under two names. That alone splits any GROUP BY. But
// the expensive half is downstream.
//
// WHAT IT WAS COSTING. phoenixSubmitOne forwards employment_type raw, and Phoenix's
// resolveEmploymentType (core-api/internal/httpapi/portal_handlers.go) accepts EXACTLY four
// words -- "employed", "self_employed", "business_owner", "unemployed" -- and derives from
// borrower_category otherwise. We send no borrower_category, so anything else becomes
// "not_specified". The scorer then picks an income-variance threshold by that word
// (intelligence-api/app/parsers/analytics.py, _VARIANCE_THRESHOLDS):
//
//     employed       0.15   "salaried, very predictable"
//     self_employed  0.25
//     business_owner 0.30
//     contract       0.25
//     (unknown)      0.20   middle ground
//
// So a salaried borrower submitted as 'salaried' or 'permanent' was scored at the 0.20 unknown
// default instead of 0.15 -- their income judged less predictable than the model intends, on the
// most common borrower type in the book. phoenixProductName already exists for exactly this kind
// of boundary translation; employment_type simply never got one.
//
// The database keeps OUR word and the wire gets Phoenix's. That is deliberate: 'retired' and
// 'contract' are real distinctions for our own reporting that Phoenix has no category for, and
// collapsing them at rest to suit another system's API would lose information we collected.

// employmentTypes is the one list both forms offer and the CHECK constraint enforces.
//
// 'business_owner' is NEW here. Phoenix scores a business owner (0.30) differently from a
// self-employed trader (0.25), and until now neither form could express the difference -- every
// one of them went as 'self_employed'. 'permanent' is NOT here: it is 'salaried'.
var employmentTypes = []string{
	"salaried",
	"self_employed",
	"business_owner",
	"contract",
	"retired",
	"unemployed",
}

func isEmploymentType(s string) bool { return inVocab(employmentTypes, s) }

// phoenixEmploymentTypes maps our word to the one Phoenix understands. Only entries that
// actually need changing appear here; everything else is passed through verbatim.
//
// Why 'contract' is deliberately NOT mapped to "employed": the scorer's own threshold for a
// contractor is 0.25, looser than employed's 0.15. Sending "employed" would score a contractor
// as MORE predictable than the model believes -- wrong in the risky direction. Passed through,
// core-api does not recognise it and yields "not_specified" (0.20), which is nearer the intended
// 0.25 than 0.15 is. The honest fix is for core-api's resolveEmploymentType to accept "contract",
// which its own scorer already has a threshold for; that is a Phoenix-side change, not ours.
//
// 'retired' is likewise passed through to "not_specified". Phoenix has no retired category, and
// inventing one -- mapping a pensioner to "unemployed" -- would be a credit judgement disguised
// as a data mapping.
var phoenixEmploymentTypes = map[string]string{
	"salaried": "employed",
	// Legacy: los/NewApplication.tsx offered this for the same thing before the lists were
	// unified, so rows written by it still carry the word.
	"permanent": "employed",
	// Defensive: the one hand-inserted value found in the table (see migration 332). Nothing in
	// the codebase ever produced it, but an import could.
	"full_time": "employed",
}

// phoenixEmploymentType translates an employment type for the Phoenix wire format. An unknown or
// empty value is returned unchanged, so Phoenix applies its own fallback rather than ours.
func phoenixEmploymentType(s string) string {
	k := strings.ToLower(strings.TrimSpace(s))
	if v, ok := phoenixEmploymentTypes[k]; ok {
		return v
	}
	return s
}
