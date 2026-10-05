// Contact and field-visit vocabularies — one definition, shared by every screen that writes them.
//
// THESE VALUES ARE ENFORCED. `recoveryVisitTypes` / `recoveryVisitOutcomes` /
// `collectionContactTypes` in backend-go/handlers/contact_vocab.go reject anything else with a
// 422, and the CHECK constraints from migration 326 reject it at the database. Adding an option
// here alone now fails loudly instead of silently splitting a category.
//
// WHY THIS FILE EXISTS. Three screens held three vocabularies for the same two columns, and none
// was wrong on its own — which is why nothing caught it:
//
//   recovery/Cases.tsx + recovery/CaseDetail.tsx : 'Physical Visit' 'Phone Call' 'Legal Notice' …
//   recovery-ops/Agent.tsx                       : 'field' 'phone' 'letter' 'legal' …
//   collections/AccountDetail.tsx                : 'phone' 'sms' 'whatsapp' 'email' 'field_visit'
//   collections-ops/AgentDashboard.tsx           : 'call' 'sms' 'email' 'visit'
//
// Two screens calling the same physical act 'Physical Visit' and 'field' would have put two rows
// per real category into every GROUP BY, permanently and invisibly. Both tables were still empty
// when this was unified, which is the only reason it cost nothing.
//
// The convention is the one used for legal stages and customerSteps: the database stores the
// snake_case `value`, the screen shows the `label`. Reword a label freely; changing a value needs
// the Go list and a migration.

export interface VocabOption { value: string; label: string }

// How the agent reached, or tried to reach, the customer.
export const RECOVERY_VISIT_TYPES: VocabOption[] = [
  { value: 'field_visit',  label: 'Field Visit' },
  { value: 'phone',        label: 'Phone Call' },
  { value: 'whatsapp',     label: 'WhatsApp' },
  { value: 'email',        label: 'Email' },
  { value: 'letter',       label: 'Letter' },
  { value: 'legal_notice', label: 'Legal Notice' },
]

// What came of it. 'paid' and 'promised_to_pay' stay separate because money received and money
// promised are different events — a distinction only one of the three old screens could make.
export const RECOVERY_VISIT_OUTCOMES: VocabOption[] = [
  { value: 'customer_met',    label: 'Customer Met' },
  { value: 'paid',            label: 'Paid' },
  { value: 'promised_to_pay', label: 'Promised to Pay' },
  { value: 'refused_to_pay',  label: 'Refused to Pay' },
  { value: 'not_home',        label: 'Not Home' },
  { value: 'no_response',     label: 'No Response' },
  { value: 'other',           label: 'Other' },
]

// The channel a collections contact was attempted on. 'call' and 'visit' from
// collections-ops/AgentDashboard.tsx collapse into 'phone' and 'field_visit'.
export const COLLECTION_CONTACT_TYPES: VocabOption[] = [
  { value: 'phone',       label: 'Phone Call' },
  { value: 'sms',         label: 'SMS' },
  { value: 'whatsapp',    label: 'WhatsApp' },
  { value: 'email',       label: 'Email' },
  { value: 'field_visit', label: 'Field Visit' },
]

// Reachability outcomes for a collections contact.
//
// NOT enforced server-side, and that is deliberate rather than an omission. collections/Queue.tsx
// writes a CALL DISPOSITION into the same `outcome` column — one of ~45 strings from the shared
// disposition list — while AccountDetail writes one of these. Those are two different kinds of
// fact about a contact, not two spellings of one, so constraining the column to either would
// discard the other. Which one collections wants to measure is an open business question; see
// backend-go/handlers/contact_vocab.go and the handover doc.
export const COLLECTION_CONTACT_OUTCOMES: VocabOption[] = [
  { value: 'answered',        label: 'Answered' },
  { value: 'no_answer',       label: 'No Answer' },
  { value: 'not_reachable',   label: 'Not Reachable' },
  { value: 'promised_to_pay', label: 'Promised to Pay' },
  { value: 'broken_promise',  label: 'Promise Broken' },
  { value: 'refused_to_pay',  label: 'Refused to Pay' },
  { value: 'wrong_number',    label: 'Wrong Number' },
]

export function vocabLabel(vocab: VocabOption[], value: string | null | undefined): string {
  if (!value) return '—'
  return vocab.find(v => v.value === value)?.label ?? value
}

// COLLECTION_CONTACT_DISPOSITIONS — what came of a collections contact, as opposed to whether we
// reached anyone (that is COLLECTION_CONTACT_OUTCOMES above). Migration 331 split those into two
// columns because they are two facts and one column could only ever hold one of them.
//
// THESE CODES ARE NOT A NEW VOCABULARY. They are ccDispositionsForPurpose('collections') from
// backend-go/handlers/call_center_dispositions.go — the list this system already owns — and the
// labels are that list's labels too. collection_contacts.disposition CHECKs the same 15 codes.
//
// Two labels here read differently from what this screen used to show, and the change is
// deliberate: the queue showed 'Callback Scheduled' and 'Unreachable / No Answer' where the
// call-centre screen shows 'Callback Requested' and 'No Answer', for the same outcome. One
// wording per outcome is the whole point. Now that the DATABASE stores a code, the wording can
// be changed again whenever the business prefers the longer one — without a migration, which was
// never true while the label itself was the stored value.
export const COLLECTION_CONTACT_DISPOSITIONS: VocabOption[] = [
  { value: 'callback',          label: 'Callback Requested' },
  { value: 'ptp',               label: 'Promise to Pay' },
  { value: 'paid',              label: 'Paid' },
  { value: 'payment_to_verify', label: 'Says They Have Paid — To Verify' },
  { value: 'not_yet_due',       label: 'Nothing Due This Cycle' },
  { value: 'dispute',           label: 'Dispute' },
  { value: 'escalated',         label: 'Escalated' },
  { value: 'pending_followup',  label: 'Pending / Follow-up' },
  { value: 'no_answer',         label: 'No Answer' },
  { value: 'call_dropped',      label: 'Call Dropped' },
  { value: 'call_rejected',     label: 'Customer Rejected the Call' },
  { value: 'wrong_number',      label: 'Wrong Number' },
  { value: 'do_not_call',       label: 'Do Not Call' },
  { value: 'closed',            label: 'Closed' },
  // Last on purpose, and worthless without a note — enforced on the server by
  // ccDispositionNoteMissing, not only in the browser.
  { value: 'other',             label: 'Other — Describe What Happened' },
]

// The one disposition that demands prose. Kept here so the queue does not have to import the
// call-log modal just to know it.
export const OTHER_DISPOSITION_CODE = 'other'
