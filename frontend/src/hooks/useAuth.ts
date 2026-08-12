export type Role =
  | 'md' | 'coo' | 'cfo' | 'head_it' | 'cmo'
  | 'head_ops' | 'head_sales' | 'head_collections' | 'head_recovery' | 'head_of_reconciliation'
  | 'admin' | 'management' | 'sales' | 'collections' | 'recovery'
  | 'cards_ops'
  // Canonical roles
  | 'executive' | 'sales_officer' | 'sales_head' | 'risk_officer' | 'risk_head'
  | 'finance_officer' | 'finance_head' | 'cards_ops_officer' | 'cards_ops_head'
  | 'collections_agent' | 'collections_head' | 'recovery_agent' | 'recovery_head'
  | 'call_center_agent' | 'call_center_head'
  | 'compliance_officer' | 'compliance_head' | 'internal_control_head' | 'it_admin'
  | 'bd_officer' | 'bd_head'
  | 'settlement_officer'
  | 'bi_analyst' | 'bi_head'

export interface AuthUser {
  id:                  number
  name:                string
  email:               string
  role:                Role
  extra_roles?:        string[]   // secondary team roles (multi-team staff)
  pages?:              string[]
  must_change_password?: boolean
}

// allRoles returns a user's primary role plus any secondary roles — the set the
// sidebar and access checks should consider for multi-team staff.
export function allRoles(user: { role: string; extra_roles?: string[] }): string[] {
  // Guard: extra_roles can arrive as a JSON string from some endpoints (jsonb
  // stringified by the backend db layer), so never spread a non-array.
  const extra = Array.isArray(user.extra_roles) ? user.extra_roles : []
  return extra.length ? [user.role, ...extra] : [user.role]
}

// SALES_HEAD_ROLES must stay in step with salesHeadRoles in the Go handlers — the
// backend is what actually enforces this. Duplicating it here only decides whether
// a control is worth rendering; a stale copy hides a button, it never grants access.
const SALES_HEAD_ROLES = ['admin', 'sales_head', 'head_sales', 'head_ops', 'cfo']

// The one place the signed-in user is stored. Everything that needs the current user
// must go through AUTH_USER_KEY rather than spelling the key out again — a typo'd key
// does not throw, it silently returns null, and a null user degrades to "not a head,
// no id", which looks like a permissions decision rather than a bug.
export const AUTH_USER_KEY = 'o3c_user'

// currentUser reads the signed-in user from storage. Returns null when absent or
// unparseable so callers degrade to the least-privileged view rather than throwing.
export function currentUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY)
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

// isSalesHead answers "may this person set other people's targets and see the whole
// book" — the supervisor/officer split the Sales module is built around.
export function isSalesHead(user: AuthUser | null = currentUser()): boolean {
  if (!user) return false
  return allRoles(user).some(r => SALES_HEAD_ROLES.includes(r))
}

const CRM        = ['crm_pipeline','crm_contacts','crm_tasks','crm_requests']
const CRM_REPORT = ['crm_reports']
const CAMPAIGNS  = ['campaigns','campaign_analytics','contact_lists','message_templates','statements']
const HELPDESK   = ['helpdesk','helpdesk_stats','helpdesk_canned']
const OPERATIONS = ['credit_portfolio','fixed_deposit','settlement','mobile_app','blink_card']

const FINANCE_PAGES     = ['income','transactions','fixed_deposit','eod','fx_rates']
const COLLECTIONS_PAGES = ['collections','recovery','credit_portfolio']
const RECOVERY_PAGES    = ['recovery','collections','credit_portfolio']
const COMPLIANCE_PAGES  = ['compliance_checklists','watch_list','sars','cbn_reports','audit_findings','audit_trail']
const ADMIN_PAGES       = ['admin_users','admin_api_keys','settings','sync_status']

export const ROLE_PAGES: Record<string, string[]> = {
  // Auto-generated to mirror backend core/auth.go RolePages exactly. This is only a
  // FALLBACK for when the JWT carries no baked pages (dev/empty token); in production
  // the authoritative set is user.pages (resolved by the backend at login).
  admin:                ['active_loan_book', 'admin_api_keys', 'admin_users', 'approvals', 'audit_export', 'audit_findings', 'audit_trail', 'bd', 'bd_employers', 'bd_pipeline', 'blink_card', 'call_center', 'call_center_stats', 'campaigns', 'card_trends', 'cards', 'cbn_reports', 'cohort', 'collections', 'collections_assign', 'collections_payment', 'collections_payment_approve', 'compliance_all', 'compliance_checklists', 'contact_lists', 'core-banking', 'credit_portfolio', 'crm_contacts', 'crm_pipeline', 'crm_reports', 'crm_tasks', 'customer360', 'customer_service', 'eod', 'executive', 'finance', 'fixed_deposit', 'fx_rates', 'helpdesk', 'helpdesk_canned', 'helpdesk_kb', 'helpdesk_stats', 'income', 'kpi_dashboard', 'loans', 'los', 'los_all', 'los_assign', 'los_booking', 'los_finance', 'los_finance_approve', 'los_risk_head', 'los_risk_review', 'mail', 'message_templates', 'mobile_app', 'overview', 'payroll', 'reconciliation', 'recovery', 'recovery_assign', 'recovery_write_off', 'reports', 'risk_all', 'risk_head', 'risk_officer', 'sales', 'sars', 'settings', 'settlement', 'statements', 'sync_status', 'transactions', 'uploads', 'watch_list'],
  bd_head:              ['bd', 'bd_employers', 'bd_pipeline', 'campaigns', 'contact_lists', 'crm_contacts', 'customer360', 'executive', 'kpi_dashboard', 'mail', 'message_templates', 'overview', 'uploads'],
  bd_officer:           ['bd', 'bd_employers', 'bd_pipeline', 'crm_contacts', 'customer360', 'mail', 'overview', 'uploads'],
  bi_analyst:           ['cohort', 'kpi_dashboard', 'overview', 'reports'],
  bi_head:              ['cohort', 'executive', 'kpi_dashboard', 'overview', 'reports', 'statements'],
  call_center_agent:    ['call_center', 'crm_contacts', 'customer360', 'helpdesk', 'helpdesk_canned', 'helpdesk_kb', 'overview', 'transactions', 'uploads'],
  call_center_head:     ['call_center', 'call_center_stats', 'campaigns', 'contact_lists', 'crm_contacts', 'customer360', 'executive', 'helpdesk', 'helpdesk_canned', 'helpdesk_kb', 'helpdesk_stats', 'kpi_dashboard', 'message_templates', 'overview', 'statements', 'transactions', 'uploads'],
  cards_agent:          ['blink_card', 'card_trends', 'cards', 'customer360', 'eod', 'los_booking', 'overview', 'uploads'],
  cards_head:           ['blink_card', 'card_trends', 'cards', 'customer360', 'eod', 'executive', 'kpi_dashboard', 'los_assign', 'los_booking', 'mobile_app', 'overview', 'statements', 'uploads'],
  cfo:                  ['approvals', 'collections_payment', 'collections_payment_approve', 'core-banking', 'credit_portfolio', 'customer360', 'eod', 'executive', 'finance', 'fixed_deposit', 'fx_rates', 'income', 'kpi_dashboard', 'los_finance', 'los_finance_approve', 'overview', 'payroll', 'reconciliation', 'reports', 'settlement', 'statements', 'transactions', 'uploads'],
  cmo:                  ['bd', 'bd_employers', 'bd_pipeline', 'campaigns', 'cohort', 'contact_lists', 'crm_contacts', 'crm_pipeline', 'crm_reports', 'crm_tasks', 'customer360', 'executive', 'kpi_dashboard', 'loans', 'los', 'mail', 'message_templates', 'overview', 'reports', 'sales', 'uploads'],
  collections_agent:    ['collections', 'crm_contacts', 'customer360', 'eod', 'overview', 'uploads'],
  collections_head:     ['collections', 'collections_assign', 'collections_payment', 'collections_payment_approve', 'credit_portfolio', 'crm_contacts', 'customer360', 'eod', 'executive', 'kpi_dashboard', 'loans', 'overview', 'recovery', 'reports', 'statements', 'uploads'],
  compliance_head:      ['audit_export', 'audit_findings', 'audit_trail', 'cbn_reports', 'compliance_all', 'compliance_checklists', 'customer360', 'executive', 'kpi_dashboard', 'overview', 'reports', 'sars', 'uploads', 'watch_list'],
  compliance_officer:   ['audit_findings', 'compliance_checklists', 'customer360', 'overview', 'uploads', 'watch_list'],
  coo:                  ['active_loan_book', 'approvals', 'blink_card', 'call_center', 'call_center_stats', 'campaigns', 'card_trends', 'cards', 'collections', 'collections_assign', 'collections_payment', 'collections_payment_approve', 'contact_lists', 'core-banking', 'credit_portfolio', 'crm_contacts', 'customer360', 'eod', 'executive', 'finance', 'fixed_deposit', 'fx_rates', 'helpdesk', 'helpdesk_canned', 'helpdesk_kb', 'helpdesk_stats', 'income', 'kpi_dashboard', 'loans', 'los_assign', 'los_booking', 'los_finance', 'los_finance_approve', 'los_risk_head', 'los_risk_review', 'message_templates', 'mobile_app', 'overview', 'payroll', 'reconciliation', 'recovery', 'recovery_assign', 'recovery_write_off', 'reports', 'risk_all', 'risk_head', 'risk_officer', 'settlement', 'statements', 'transactions', 'uploads'],
  finance_head:         ['core-banking', 'credit_portfolio', 'customer360', 'eod', 'executive', 'finance', 'fixed_deposit', 'fx_rates', 'income', 'kpi_dashboard', 'los_finance', 'los_finance_approve', 'overview', 'payroll', 'reconciliation', 'reports', 'settlement', 'statements', 'transactions', 'uploads'],
  finance_officer:      ['core-banking', 'credit_portfolio', 'customer360', 'eod', 'finance', 'fixed_deposit', 'fx_rates', 'income', 'los_finance', 'overview', 'reconciliation', 'settlement', 'transactions', 'uploads'],
  it_admin:             ['admin_api_keys', 'admin_users', 'customer360', 'overview', 'settings', 'sync_status', 'uploads'],
  md:                   ['active_loan_book', 'admin_api_keys', 'admin_users', 'approvals', 'audit_export', 'audit_findings', 'audit_trail', 'bd', 'bd_employers', 'bd_pipeline', 'blink_card', 'call_center', 'call_center_stats', 'campaigns', 'card_trends', 'cards', 'cbn_reports', 'cohort', 'collections', 'collections_assign', 'collections_payment', 'collections_payment_approve', 'compliance_all', 'compliance_checklists', 'contact_lists', 'core-banking', 'credit_portfolio', 'crm_contacts', 'crm_pipeline', 'crm_reports', 'crm_tasks', 'customer360', 'customer_service', 'eod', 'executive', 'finance', 'fixed_deposit', 'fx_rates', 'helpdesk', 'helpdesk_canned', 'helpdesk_kb', 'helpdesk_stats', 'income', 'kpi_dashboard', 'loans', 'los', 'los_all', 'los_assign', 'los_booking', 'los_finance', 'los_finance_approve', 'los_risk_head', 'los_risk_review', 'mail', 'message_templates', 'mobile_app', 'overview', 'payroll', 'reconciliation', 'recovery', 'recovery_assign', 'recovery_write_off', 'reports', 'risk_all', 'risk_head', 'risk_officer', 'sales', 'sars', 'settings', 'settlement', 'statements', 'sync_status', 'transactions', 'uploads', 'watch_list'],
  recovery_agent:       ['customer360', 'eod', 'overview', 'recovery', 'uploads'],
  recovery_head:        ['credit_portfolio', 'customer360', 'eod', 'executive', 'kpi_dashboard', 'loans', 'overview', 'recovery', 'recovery_assign', 'recovery_write_off', 'reports', 'statements', 'uploads'],
  risk_head:            ['active_loan_book', 'credit_portfolio', 'customer360', 'executive', 'kpi_dashboard', 'loans', 'los_assign', 'los_risk_head', 'los_risk_review', 'overview', 'risk_all', 'risk_head', 'risk_officer', 'statements', 'uploads'],
  risk_officer:         ['credit_portfolio', 'customer360', 'loans', 'los_risk_review', 'overview', 'risk_officer', 'uploads'],
  sales_head:           ['campaigns', 'cohort', 'contact_lists', 'crm_contacts', 'crm_pipeline', 'crm_reports', 'crm_tasks', 'customer360', 'executive', 'kpi_dashboard', 'loans', 'los', 'los_all', 'los_assign', 'mail', 'message_templates', 'overview', 'reports', 'sales', 'statements', 'uploads'],
  sales_officer:        ['cohort', 'crm_contacts', 'crm_pipeline', 'crm_reports', 'crm_tasks', 'customer360', 'loans', 'los', 'mail', 'overview', 'sales', 'uploads'],
  settlement_officer:   ['credit_portfolio', 'customer360', 'eod', 'overview', 'reconciliation', 'settlement', 'transactions', 'uploads'],
}

export function parseToken(token: string): { exp: number; [key: string]: unknown } | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64))
  } catch {
    return null
  }
}
