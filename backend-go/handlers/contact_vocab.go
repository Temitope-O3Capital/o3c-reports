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

// NOTE ON collection_contacts.outcome — DELIBERATELY NOT CONSTRAINED HERE, and this is a real
// open question rather than an oversight.
//
// Two screens write two different KINDS of thing into that one column:
//
//   collections/AccountDetail.tsx sends a reachability outcome — 'answered', 'no_answer',
//   'not_reachable', 'promised_to_pay', 'refused_to_pay'.
//
//   collections/Queue.tsx sends a CALL DISPOSITION — one of roughly 45 human-readable strings
//   from the shared disposition list ('Promise to Pay', 'Issue Resolved', 'Says They Have Paid
//   — To Verify', 'Other — Describe What Happened'), which is a richer, already-canonical
//   vocabulary enforced elsewhere as ccDispositions.
//
// Those are not two spellings of one idea; they are two different facts about a contact. Picking
// either one silently discards the other: constrain to reachability and the disposition is lost,
// constrain to dispositions and an SMS or a field visit has no outcome to give. The honest model
// is probably a separate `disposition` column alongside `outcome` — the table is empty, so that
// costs nothing but a migration — but which fact each screen is supposed to record is a business
// decision about what collections wants to measure, not a naming one. So contact_type is
// enforced and outcome is left open, with the conflict written down rather than resolved by
// whoever edited last. See the handover doc.
