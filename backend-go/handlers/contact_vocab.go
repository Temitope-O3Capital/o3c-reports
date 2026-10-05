package handlers

// The contact and field-visit vocabularies, which until 2026-09-30 existed only in TypeScript —
// in more than one version each, writing to the same column.
//
// WHY THIS WAS WORTH FIXING BEFORE IT COST ANYTHING. Both tables are EMPTY: recovery_field_visits
// and collection_contacts hold 0 rows. Nobody has logged a visit or a contact through these
// screens yet, so there is no data to migrate and no report to correct — which is the cheapest
// this will ever be. The screens are built and mounted, so the first agent to use them starts
// writing whichever vocabulary their screen happens to hold.
//
// What the conflict actually was:
//
//   POST /api/recovery-ops/cases/{id}/visit      — visit_type, outcome
//     recovery/Cases.tsx + recovery/CaseDetail.tsx: 'Physical Visit'|'Phone Call'|'WhatsApp'|
//         'Email'|'Legal Notice'  and  'Customer Met'|'Not Home'|'Promised to Pay'|
//         'Refused to Pay'|'No Response'|'Other'
//     recovery-ops/Agent.tsx:                      'field'|'phone'|'letter'|'legal'
//         and  'paid'|'promised'|'refused'|'absent'|'no_contact'
//
//   POST /api/collections-ops/{id}/contact       — contact_type, outcome
//     collections/AccountDetail.tsx:   'phone'|'sms'|'whatsapp'|'email'|'field_visit'
//     collections-ops/AgentDashboard.tsx: 'call'|'sms'|'email'|'visit'
//     collections/Queue.tsx:           hardcodes 'call'
//
// Two screens describing the same physical act as 'Physical Visit' and 'field', and the same
// refusal as 'Refused to Pay' and 'refused', means any GROUP BY on these columns would have
// produced two rows per real category — for ever, and invisibly, because neither value is wrong
// on its own.
//
// THE CONVENTION, matching everything else that got fixed this week: the DATABASE stores a
// snake_case code and the SCREEN shows a label. That is how customerSteps works, how
// recovery_cases.legal_stage works after migration 321, and it is what lets a label be reworded
// without a migration. The stored codes are the union of the two sets, collapsed to one code per
// real-world category, so nothing either screen could express is lost.

// recoveryVisitTypes — how the agent reached (or tried to reach) the customer.
var recoveryVisitTypes = []string{
	"field_visit",
	"phone",
	"whatsapp",
	"email",
	"letter",
	"legal_notice",
}

// recoveryVisitOutcomes — what came of it. 'paid' and 'promised_to_pay' are separate because
// money received and money promised are not the same event, which is the distinction
// recovery-ops/Agent.tsx had and the other two screens did not.
var recoveryVisitOutcomes = []string{
	"customer_met",
	"paid",
	"promised_to_pay",
	"refused_to_pay",
	"not_home",
	"no_response",
	"other",
}

// collectionContactTypes — the channel a collections contact was attempted on. 'call' and 'visit'
// from collections-ops/AgentDashboard.tsx collapse into 'phone' and 'field_visit'.
var collectionContactTypes = []string{
	"phone",
	"sms",
	"whatsapp",
	"email",
	"field_visit",
}

func isRecoveryVisitType(s string) bool    { return inVocab(recoveryVisitTypes, s) }
func isRecoveryVisitOutcome(s string) bool { return inVocab(recoveryVisitOutcomes, s) }
func isCollectionContactType(s string) bool {
	return inVocab(collectionContactTypes, s)
}

// collection_contacts.outcome AND .disposition — SETTLED 2026-10-05 by migration 331.
//
// This column used to take BOTH facts from two screens, and the note here recorded it as an open
// question. The business has now answered it: keep both, in two columns.
//
//   outcome     — REACHABILITY. Did we get through? collections/AccountDetail.tsx writes this.
//   disposition — THE RESULT. What came of it? collections/Queue.tsx writes this.
//
// Either may be NULL (an SMS send has no call result; the queue may know only the result), but
// migration 331's collection_contacts_says_something_chk requires at least one, because a
// contact recording neither fact is not a contact.
//
// Why two columns and not one: 'answered' says the phone was picked up, 'ptp' says what was
// agreed. A customer who did both could previously be recorded only as one. And 'not_reachable'
// against 'Unreachable / No Answer' was the same fact in two spellings, which would have split
// every GROUP BY on this column in half for ever.
//
// I checked the obvious cheaper option first — drop the disposition, since the call log surely
// has it. It does NOT: Queue.tsx posts to /api/collections-ops/{id}/contact, not the call-log
// endpoint, and says so in its own comment. That disposition exists nowhere else.

// collectionContactOutcomes — the reachability vocabulary. Mirrors COLLECTION_CONTACT_OUTCOMES
// in frontend/src/lib/contactVocab.ts and migration 331's collection_contacts_outcome_chk.
var collectionContactOutcomes = []string{
	"answered",
	"no_answer",
	"not_reachable",
	"promised_to_pay",
	"broken_promise",
	"refused_to_pay",
	"wrong_number",
}

func isCollectionContactOutcome(s string) bool { return inVocab(collectionContactOutcomes, s) }

// collectionContactDispositions is DERIVED, not copied. ccDispositions in
// call_center_dispositions.go is the one list this system owns, and a sixteenth hand-typed copy
// of it is exactly the defect this file exists to remove. Scoped to the collections purpose, it
// yields 15 codes — a clean superset of the 12 the queue screen offers.
func collectionContactDispositions() []string {
	ds := ccDispositionsForPurpose("collections")
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.Code)
	}
	return out
}

func isCollectionContactDisposition(s string) bool {
	return inVocab(collectionContactDispositions(), s)
}
