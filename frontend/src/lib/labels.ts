/** Convert snake_case to Title Case (generic fallback) */
export function snake(s: string | null | undefined): string {
  return (s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ── Specific label maps (use these for known value sets) ──────────────────────

export const STATUS_LABELS: Record<string, string> = {
  active:           'Active',
  inactive:         'Inactive',
  draft:            'Draft',
  paused:           'Paused',
  completed:        'Completed',
  cancelled:        'Cancelled',
  open:             'Open',
  closed:           'Closed',
  pending:          'Pending',
  approved:         'Approved',
  declined:         'Declined',
  rejected:         'Rejected',
  in_progress:      'In Progress',
  escalated:        'Escalated',
  legal:            'Referred to Legal',
  new:              'New',
  resolved:         'Resolved',
  on_hold:          'On Hold',
  pending_review:   'Pending Review',
  under_review:     'Under Review',
  disbursed:        'Disbursed',
  repaid:           'Repaid',
  written_off:      'Written Off',
  overdue:          'Overdue',
  current:          'Current',
  settled:          'Settled',
  booked:           'Booked',
  offer_sent:       'Offer Sent',
  accepted:         'Accepted',
  expired:          'Expired',
}

export const LEGAL_STAGE_LABELS: Record<string, string> = {
  pre_legal:          'Pre-Legal',
  letter_of_demand:   'Letter of Demand',
  court_filing:       'Court Filing',
  hearing:            'Hearing',
  garnishee:          'Garnishee Order',
  judgment:           'Judgment',
  closed:             'Closed',
}

export const LOAN_STAGE_LABELS: Record<string, string> = {
  submitted:          'Submitted',
  kyc:                'KYC',
  bureau:             'Bureau Check',
  underwriting:       'Underwriting',
  credit_committee:   'Credit Committee',
  approved:           'Approved',
  declined:           'Declined',
  offer_sent:         'Offer Sent',
  accepted:           'Accepted',
  booking:            'Booking',
  disbursed:          'Disbursed',
  cancelled:          'Cancelled',
  written_off:        'Written Off',
}

export const COLLECTIONS_STAGE_LABELS: Record<string, string> = {
  new:          'New',
  in_progress:  'In Progress',
  escalated:    'Escalated',
  legal:        'Referred to Legal',
  closed:       'Closed',
}

export const OUTCOME_LABELS: Record<string, string> = {
  no_answer:          'No Answer',
  promised_payment:   'Promised Payment',
  dispute:            'Dispute',
  rtp:                'Refuse to Pay',
  paid:               'Paid',
  not_found:          'Not Found',
  call_back:          'Call Back Requested',
  deceased:           'Deceased',
}

export const CONTACT_TYPE_LABELS: Record<string, string> = {
  call:   'Phone Call',
  sms:    'SMS',
  visit:  'Field Visit',
  email:  'Email',
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash:       'Cash',
  transfer:   'Bank Transfer',
  card:       'Card',
  cheque:     'Cheque',
}

export const VISIT_TYPE_LABELS: Record<string, string> = {
  field_visit:    'Field Visit',
  office_visit:   'Office Visit',
  phone_call:     'Phone Call',
}

export const LEGAL_PROCEEDING_LABELS: Record<string, string> = {
  letter_of_demand:   'Letter of Demand',
  court_filing:       'Court Filing',
  hearing:            'Hearing',
  garnishee:          'Garnishee Order',
  judgment:           'Judgment',
}

export const LEAVE_TYPE_LABELS: Record<string, string> = {
  annual:         'Annual Leave',
  sick:           'Sick Leave',
  maternity:      'Maternity Leave',
  paternity:      'Paternity Leave',
  unpaid:         'Unpaid Leave',
  compassionate:  'Compassionate Leave',
  study:          'Study Leave',
}

export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  full_time:    'Full Time',
  part_time:    'Part Time',
  contract:     'Contract',
  intern:       'Intern',
  probation:    'Probation',
}

export const SEVERITY_LABELS: Record<string, string> = {
  low:      'Low',
  medium:   'Medium',
  high:     'High',
  critical: 'Critical',
  minor:    'Minor',
  major:    'Major',
  gross:    'Gross Misconduct',
}

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  prepaid_card:     'Prepaid Card',
  credit_card:      'Credit Card',
  personal_loan:    'Personal Loan',
  business_loan:    'Business Loan',
  salary_advance:   'Salary Advance',
  fixed_deposit:    'Fixed Deposit',
  usd_card:         'USD Card',
}

export const CRM_SOURCE_LABELS: Record<string, string> = {
  referral:         'Referral',
  walk_in:          'Walk-In',
  social_media:     'Social Media',
  website:          'Website',
  cold_call:        'Cold Call',
  partner:          'Partner',
  event:            'Event',
  email_campaign:   'Email Campaign',
  sms_campaign:     'SMS Campaign',
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  todo:         'To Do',
  in_progress:  'In Progress',
  done:         'Done',
  blocked:      'Blocked',
  cancelled:    'Cancelled',
}

/** Look up a value in a specific map; falls back to snake() */
export function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '—'
  return map[key] ?? snake(key)
}
