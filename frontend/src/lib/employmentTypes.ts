// How an applicant earns a living — one list, shared by every form that writes it.
//
// THESE VALUES ARE ENFORCED. `employmentTypes` in backend-go/handlers/employment_vocab.go
// rejects anything else with a 422, and migration 332's CHECK rejects it at the database.
//
// WHY THIS FILE EXISTS. Two forms held two lists for one column, neither validated:
//
//   los/NewApplication.tsx             'permanent' | 'contract' | 'self_employed'
//   components/NewApplicationModal.tsx 'salaried' | 'self_employed' | 'contract' |
//                                      'retired' | 'unemployed'
//
// 'permanent' and 'salaried' were one thing under two names. But the cost was downstream, not
// in our own reports: the value is forwarded to Phoenix, whose resolveEmploymentType accepts
// only employed / self_employed / business_owner / unemployed and treats everything else as
// not_specified. The scorer then picks an income-variance threshold by that word — 0.15 for
// 'employed' ("salaried, very predictable") against 0.20 for unknown. So every salaried
// borrower we submitted was judged less predictable than the model intends.
//
// The translation now happens at the wire (phoenixEmploymentType), not here, so this list can
// keep distinctions Phoenix has no category for — 'contract' and 'retired' are real facts about
// a borrower and worth holding even though Phoenix cannot score them separately.
export interface EmploymentTypeOption {
  value: string
  label: string
  hint?: string
}

// 'business_owner' is newly expressible: Phoenix scores a business owner differently from a
// self-employed trader, and until now every one of them went across as 'self_employed'.
export const EMPLOYMENT_TYPES: EmploymentTypeOption[] = [
  { value: 'salaried',      label: 'Salaried',       hint: 'On a payroll' },
  { value: 'self_employed', label: 'Self-Employed',  hint: 'Trader or sole practitioner' },
  { value: 'business_owner',label: 'Business Owner', hint: 'Owns a registered business with employees' },
  { value: 'contract',      label: 'Contract',       hint: 'Fixed-term engagement' },
  { value: 'retired',       label: 'Retired',        hint: 'Pension or investment income' },
  { value: 'unemployed',    label: 'Unemployed' },
]

export function employmentTypeLabel(value: string | null | undefined): string {
  if (!value) return '—'
  return EMPLOYMENT_TYPES.find(t => t.value === value)?.label ?? value
}
