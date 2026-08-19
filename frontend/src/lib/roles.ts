import { snake } from './labels'

// Clean role taxonomy — one Head + one Agent/Officer per operating module, a lean
// C-suite, plus IT (system) and BI (analytics). Labels for display; the backend
// (/api/admin/roles) is the source of truth for which roles exist. Retired legacy
// slugs are kept here only so any lingering reference still renders a name.
export const ROLE_LABELS: Record<string, string> = {
  // System / Executive
  admin:                    'Administrator',
  md:                       'Managing Director',
  coo:                      'Chief Operating Officer',
  cfo:                      'Chief Financial Officer',
  cmo:                      'Chief Marketing Officer',

  // IT & Analytics
  it_admin:                 'IT Administrator',
  bi_head:                  'Head of Analytics',
  bi_analyst:               'Analytics Analyst',

  // Sales & BD
  sales_officer:            'Sales Officer',
  sales_head:               'Head of Sales',
  bd_officer:               'BD Officer',
  bd_head:                  'Head of Business Development',

  // Lending / Risk
  risk_officer:             'Risk Officer',
  risk_head:                'Head of Risk',

  // Collections & Recovery
  collections_agent:        'Collections Agent',
  collections_head:         'Head of Collections',
  recovery_agent:           'Recovery Agent',
  recovery_head:            'Head of Recovery',

  // Cards
  cards_agent:              'Cards Agent',
  cards_head:               'Head of Cards',

  // Finance
  finance_officer:          'Finance Officer',
  finance_head:             'Head of Finance',

  // Settlement & Reconciliation (own Operations module)
  settlement_officer:       'Settlement Officer',
  settlement_head:          'Head of Settlement & Reconciliation',

  // Contact Centre
  call_center_agent:        'Call Center Agent',
  call_center_head:         'Head of Call Center',
  care_agent:               'Care Agent',
  care_head:                'Head of Care',

  // Compliance
  compliance_officer:       'Compliance Officer',
  compliance_head:          'Head of Compliance',

  // ── Retired legacy slugs (render a name if still referenced) ──
  executive:                'Executive',
  management:               'Management',
  head_ops:                 'Head of Operations',
  head_it:                  'Head of IT',
  head_sales:               'Head of Sales',
  head_collections:         'Head of Collections',
  head_recovery:            'Head of Recovery',
  head_of_reconciliation:   'Head of Reconciliation',
  internal_control_head:    'Head of Internal Control',
  sales:                    'Sales',
  collections:              'Collections',
  recovery:                 'Recovery',
  cards_ops:                'Cards Operations',
  cards_ops_officer:        'Cards Operations Officer',
  cards_ops_head:           'Head of Cards Operations',
  customer_service:         'Customer Service',
  treasury_officer:         'Treasury Officer',
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? snake(role)
}

// Management tier — the executive roles that see the General Overview and
// company-wide dashboards. Must stay in sync with core/scope.go managementRoles.
export const MGMT = new Set([
  'admin', 'md', 'coo', 'cfo', 'cmo',
])
