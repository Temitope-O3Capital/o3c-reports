package handlers

import "strings"

// The two recovery vocabularies that had no server-side guard at all.
//
// WHY THIS FILE EXISTS. Both of these were declared only in TypeScript, so the dropdown was
// the entire enforcement. `recoveryOpsPayment` checked `channel != ""` and
// `recoveryAddLegalMilestone` checked `milestone_type != ""`, and there was no CHECK constraint
// on either column. A dropdown is not a constraint: anything that posts to those endpoints —
// a script, a stale tab, a renamed option — wrote straight through.
//
// What that cost, measured 2026-09-30 before the fix:
//
//   - recovery_payments.channel held 269 rows worth NGN 921m across EIGHT values, and not one
//     of them was any of the six the dropdown offered. The UI said 'Bank Transfer'; the data
//     said TRANSFER, 'loan repayment', REMITA, NDD, ZENITH, legal, 'TRANSFER/NDD', 'recovery'.
//     Migration 321 reconciled them and kept every original in channel_raw.
//   - recovery_cases.legal_stage drives the Recovery dashboard, the Executive legal funnel and
//     the Legal tracker. The milestone form offered six Title Case values ('Pre-Litigation
//     Notice', 'Court Filing', …) while the column holds four lowercase ones. The form had
//     NEVER been used — all 95 legal_proceedings rows came from one import on 2026-08-24 — so
//     the first person to use it would have injected a third vocabulary into the column behind
//     a NGN 1.5bn figure, where 'legal_stage IS NOT NULL' counts it and
//     'legal_stage IN (…)' does not.
//
// The lists live here, in Go, because Go is what the write path can actually enforce. The
// TypeScript copies now name these as their authority, and a drift is a loud 422 rather than a
// silent bad row — which is the whole reason the copy is tolerable at all. Serving them from an
// endpoint the way customerSteps is served remains the better end state; it was not done here
// because it would convert five live recovery and collections screens from a synchronous
// constant to an async fetch, which is real regression risk for a vocabulary that changes about
// once a year. With the 422 and the CHECK constraint in place, drift can no longer be silent.

// recoveryPaymentChannels is the whitelist for recovery_payments.channel, enforced here and by
// the CHECK constraint added in migration 321. The first six are the business's own set; Remita
// and Direct Debit were added because 66 real rows use them, and Unspecified exists because 90
// imported rows genuinely have no channel recorded and inventing one for them would be a lie.
var recoveryPaymentChannels = []string{
	"Bank Transfer",
	"Remita",
	"Direct Debit",
	"Cash",
	"Cheque",
	"TPA",
	"Legal Settlement",
	"Self-Cure",
	"Unspecified",
}

// recoveryLegalStages is the vocabulary for recovery_cases.legal_stage AND for
// legal_proceedings.proceeding_type — one list, because the milestone handler writes the same
// value to both. Ordered as the case progresses.
//
// 'recovery' is the PRE-LEGAL stage: ordinary chasing, no lawyer involved. It is the reason
// "accounts in legal" is overstated wherever the test is `legal_stage IS NOT NULL` — 251 cases
// worth NGN 592m sit at this stage and are not in legal at all. Counting it is a reporting
// decision that belongs to whoever owns the KPI, so nothing here changes those numbers; this
// list only stops a FIFTH value appearing while that is decided.
var recoveryLegalStages = []string{
	"recovery",
	"legal",
	"court",
	"judgment",
}

func isRecoveryPaymentChannel(s string) bool { return inVocab(recoveryPaymentChannels, s) }
func isRecoveryLegalStage(s string) bool     { return inVocab(recoveryLegalStages, s) }

func inVocab(vocab []string, s string) bool {
	for _, v := range vocab {
		if v == s {
			return true
		}
	}
	return false
}

// vocabList renders a vocabulary for an error message, so the 422 tells the caller exactly what
// is accepted instead of making them read the source.
func vocabList(vocab []string) string { return strings.Join(vocab, ", ") }
