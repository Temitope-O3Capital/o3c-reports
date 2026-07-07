import { snake } from './labels'

export const ROLE_LABELS: Record<string, string> = {
  // C-Suite
  md:                       'Managing Director',
  coo:                      'Chief Operating Officer',
  cfo:                      'Chief Financial Officer',
  cmo:                      'Chief Marketing Officer',
  executive:                'Executive',

  // Legacy / generic
  admin:                    'Administrator',
  management:               'Management',
  head_ops:                 'Head of Operations',
  head_it:                  'Head of IT',
  head_of_reconciliation:   'Head of Reconciliation',
  head_hr:                  'Head of HR',
  head_sales:               'Head of Sales',
  head_collections:         'Head of Collections',
  head_recovery:            'Head of Recovery',

  // Sales
  sales_officer:            'Sales Officer',
  sales_head:               'Head of Sales',
  sales:                    'Sales',

  // Risk & Credit
  risk_officer:             'Risk Officer',
  risk_head:                'Head of Risk',

  // Finance
  finance_officer:          'Finance Officer',
  finance_head:             'Head of Finance',

  // Cards
  cards_ops_officer:        'Cards Operations Officer',
  cards_ops_head:           'Head of Cards Operations',
  cards_ops:                'Cards Operations',

  // Collections
  collections_agent:        'Collections Agent',
  collections_head:         'Head of Collections',
  collections:              'Collections',

  // Recovery
  recovery_agent:           'Recovery Agent',
  recovery_head:            'Head of Recovery',
  recovery:                 'Recovery',

  // Call Centre
  call_center_agent:        'Call Centre Agent',
  call_center_head:         'Head of Call Centre',
  call_centre:              'Call Centre',

  // HR
  hr_officer:               'HR Officer',
  hr_manager:               'HR Manager',

  // Compliance
  compliance_officer:       'Compliance Officer',
  compliance_head:          'Head of Compliance',
  internal_control_head:    'Head of Internal Control',

  // IT
  it_admin:                 'IT Administrator',

  // Settlements / Treasury
  settlement_officer:       'Settlement Officer',
  treasury_officer:         'Treasury Officer',

  // Telemarketing
  telemarketing_agent:      'Telemarketing Agent',
  telemarketing_head:       'Head of Telemarketing',

  // Business Development
  bd_officer:               'BD Officer',
  bd_head:                  'Head of Business Development',

  // Payroll
  payroll_officer:          'Payroll Officer',
  payroll_manager:          'Payroll Manager',
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? snake(role)
}

export const MGMT = new Set([
  'md','coo','cfo','cmo','executive','admin','management','head_ops','head_it','head_hr',
])
