import { snake } from './labels'
import { allRoles, currentUser, hasPage, type AuthUser } from '../hooks/useAuth'

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
  exec_overview:            'Executive (Overview)',

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
  internal_control_head:    'Head of Internal Control',

  // ── Retired legacy slugs (render a name if still referenced) ──
  executive:                'Executive',
  management:               'Management',
  head_ops:                 'Head of Operations',
  head_it:                  'Head of IT',
  head_sales:               'Head of Sales',
  head_collections:         'Head of Collections',
  head_recovery:            'Head of Recovery',
  head_of_reconciliation:   'Head of Reconciliation',
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
  'admin', 'md', 'coo', 'cfo', 'cmo', 'head_ops', 'exec_overview',
  // Internal Control audits every module, so the sidebar shows it everything its pages
  // allow. It changes nothing: the backend refuses every write for this role
  // (core.WriteBlocked), so "sees the whole floor" never means "can act on it".
  'internal_control_head',
])

// isCallCentreSupervisor answers "does this person get the whole floor, rather than
// just their own book" — for every call-centre screen. This is the ONE place that
// question is answered.
//
// Queue, Leads and Forwards each used to decide it differently. Two of them tested a
// regex over the stored role (/head|admin|super|manager|lead|supervisor/i), which
// matches 'call_center_head' but NOT 'md', 'coo', 'cfo' or 'cmo' — so the COO got an
// agent's view on Leads and the whole floor on Forwards.
//
// This mirrors what the server actually accepts, which is two checks:
//   • ccIsSupervisor (handlers/call_center_forwards.go) — 'call_center_head', or
//     core.IsManagement (core/scope.go managementRoles, mirrored by MGMT above);
//   • the 'call_center_stats' page, which the rest of the module gates its supervisor
//     reads on (call_center_outbound.go, helpdesk.go, helpdesk_call_edit.go).
// Secondary team roles count, via allRoles — a multi-team user supervises if ANY of
// their roles does, which is how the backend reads AllRoles() too.
//
// Cosmetic only: the backend is what actually enforces this. A stale copy here hides a
// control, it never grants access.
export function isCallCentreSupervisor(user: AuthUser | null = currentUser()): boolean {
  if (!user) return false
  if (allRoles(user).some(r => r === 'call_center_head' || MGMT.has(r))) return true
  return hasPage('call_center_stats', user)
}
