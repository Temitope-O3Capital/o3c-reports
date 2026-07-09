export type Role =
  | 'md' | 'coo' | 'cfo' | 'head_it' | 'head_hr' | 'cmo'
  | 'head_ops' | 'head_sales' | 'head_collections' | 'head_recovery' | 'head_of_reconciliation'
  | 'admin' | 'management' | 'sales' | 'collections' | 'recovery'
  | 'cards_ops' | 'call_centre'
  // Canonical roles
  | 'executive' | 'sales_officer' | 'sales_head' | 'risk_officer' | 'risk_head'
  | 'finance_officer' | 'finance_head' | 'cards_ops_officer' | 'cards_ops_head'
  | 'collections_agent' | 'collections_head' | 'recovery_agent' | 'recovery_head'
  | 'call_center_agent' | 'call_center_head' | 'hr_officer' | 'hr_manager'
  | 'compliance_officer' | 'compliance_head' | 'internal_control_head' | 'it_admin'
  | 'telemarketing_agent' | 'telemarketing_head'
  | 'bd_officer' | 'bd_head'
  | 'payroll_officer' | 'payroll_manager'
  | 'settlement_officer'

export interface AuthUser {
  id:                  number
  name:                string
  email:               string
  role:                Role
  pages?:              string[]
  must_change_password?: boolean
}

const CRM        = ['crm_pipeline','crm_contacts','crm_tasks','crm_requests']
const CRM_REPORT = ['crm_reports']
const CAMPAIGNS  = ['campaigns','campaign_analytics','contact_lists','message_templates','statements']
const HELPDESK   = ['helpdesk','helpdesk_stats','helpdesk_canned']
const OPERATIONS = ['credit_portfolio','fixed_deposit','settlement','mobile_app','blink_card']

const FINANCE_PAGES     = ['income','transactions','fixed_deposit','eod','fx_rates']
const COLLECTIONS_PAGES = ['collections','recovery','credit_portfolio']
const RECOVERY_PAGES    = ['recovery','collections','credit_portfolio']
const HR_PAGES          = ['hr_employees','hr_leave','hr_performance','hr_disciplinary','hr_training']
const COMPLIANCE_PAGES  = ['compliance_checklists','watch_list','sars','cbn_reports','audit_findings','audit_trail']
const ADMIN_PAGES       = ['admin_users','admin_api_keys','settings','sync_status']

export const ROLE_PAGES: Record<string, string[]> = {
  // Legacy roles
  md:               ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','call_center','loans', ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS, ...HELPDESK],
  coo:              ['overview','transactions','collections','recovery','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','call_center','loans',          ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS, ...HELPDESK],
  cfo:              ['overview','income','collections','recovery','executive','transactions','eod','uploads','reconciliation','loans','credit_portfolio','fixed_deposit','settlement','statements', ...FINANCE_PAGES],
  head_it:          ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','admin','executive','income','eod','uploads','reconciliation','call_center','loans', ...CRM, ...CRM_REPORT, ...CAMPAIGNS, 'mobile_app','blink_card', ...ADMIN_PAGES, ...HELPDESK],
  head_hr:          ['overview','sales','uploads', ...HR_PAGES],
  cmo:              ['overview','sales','cohort','executive','uploads', ...CRM, ...CRM_REPORT, ...CAMPAIGNS],
  head_ops:         ['overview','transactions','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','credit_portfolio','fixed_deposit','settlement', ...CRM, ...HELPDESK],
  head_sales:       ['sales','overview','uploads','executive','loans','credit_portfolio', ...CRM, ...CRM_REPORT, ...CAMPAIGNS],
  head_collections: ['collections','recovery','overview','eod','uploads','executive','reconciliation','loans','credit_portfolio', ...CRM, ...HELPDESK],
  head_recovery:    ['recovery','collections','overview','eod','uploads','executive','loans','credit_portfolio', ...CRM, ...HELPDESK],
  admin:            ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','admin','executive','income','eod','uploads','reconciliation','call_center','loans', ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS, ...ADMIN_PAGES, ...HELPDESK],
  management:       ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','call_center',                 ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS, ...HELPDESK],
  sales:            ['sales','overview','uploads','loans','credit_portfolio',                                                                                                                       ...CRM, ...CRM_REPORT, ...CAMPAIGNS],
  collections:      ['collections','recovery','eod','uploads','reconciliation','credit_portfolio',                                                                                                  ...CRM, ...HELPDESK],
  recovery:         ['recovery','collections','eod','uploads','loans','credit_portfolio',                                                                                                           ...CRM, ...HELPDESK],
  cards_ops:        ['cards','card_trends','transactions','overview','eod','uploads','blink_card', ...HELPDESK],
  call_centre:      ['overview','transactions','call_center','crm_requests','crm_contacts','uploads', ...HELPDESK],

  // Canonical roles
  executive:             ['overview','income','transactions','credit_portfolio','fixed_deposit','eod', ...FINANCE_PAGES],
  sales_officer:         ['sales','overview','loans','credit_portfolio','bd','bd_employers','bd_pipeline', ...CRM, ...CRM_REPORT],
  sales_head:            ['sales','overview','loans','credit_portfolio','reports','statements','bd','bd_employers','bd_pipeline', ...CRM, ...CRM_REPORT, ...CAMPAIGNS],
  risk_officer:          ['credit_portfolio','los_all','income'],
  risk_head:             ['credit_portfolio','los_all','income','reports','statements'],
  finance_officer:       [...FINANCE_PAGES, 'overview'],
  finance_head:          [...FINANCE_PAGES, 'overview','reports','statements','settlement','reconciliation','credit_portfolio','fixed_deposit'],
  cards_ops_officer:     ['cards','card_trends','transactions','overview','eod','blink_card','mobile_app', ...HELPDESK],
  cards_ops_head:        ['cards','card_trends','transactions','overview','eod','blink_card','mobile_app','reports','statements', ...HELPDESK],
  collections_agent:     [...COLLECTIONS_PAGES, 'eod','uploads', ...HELPDESK],
  collections_head:      [...COLLECTIONS_PAGES, 'eod','uploads','reports','statements','reconciliation', ...HELPDESK],
  recovery_agent:        [...RECOVERY_PAGES, 'eod','uploads', ...HELPDESK],
  recovery_head:         [...RECOVERY_PAGES, 'eod','uploads','reports','statements', ...HELPDESK],
  call_center_agent:     ['call_center','overview','transactions','crm_requests','crm_contacts', ...HELPDESK],
  call_center_head:      ['call_center','overview','transactions','crm_requests','crm_contacts','reports','statements', ...HELPDESK],
  hr_officer:            [...HR_PAGES],
  hr_manager:            [...HR_PAGES, 'reports','statements'],
  compliance_officer:    [...COMPLIANCE_PAGES],
  compliance_head:       [...COMPLIANCE_PAGES, 'reports','statements'],
  internal_control_head: [...COMPLIANCE_PAGES, 'reports','statements','audit_trail'],
  it_admin:              [...ADMIN_PAGES, 'overview', ...HELPDESK],

  // Telemarketing
  telemarketing_agent:   ['overview','telemarketing','customer360'],
  telemarketing_head:    ['overview','telemarketing','telemarketing_stats','customer360','kpi_dashboard','campaigns','contact_lists','message_templates'],

  // Business Development
  bd_officer:            ['overview','bd','bd_employers','bd_pipeline','customer360','crm_contacts','campaigns','contact_lists','message_templates'],
  bd_head:               ['overview','bd','bd_employers','bd_pipeline','customer360','crm_contacts','kpi_dashboard','statements','campaigns','contact_lists','message_templates'],

  // Payroll
  payroll_officer:       ['overview','payroll'],
  payroll_manager:       ['overview','payroll','payroll_manager','hr_employees','kpi_dashboard'],

  // Finance ops
  head_of_reconciliation: ['overview','income','eod','transactions','uploads','reconciliation','credit_portfolio','fixed_deposit','settlement','kpi_dashboard','reports','statements'],
  settlement_officer:     ['overview','settlement','reconciliation','eod','transactions','credit_portfolio'],
}

export function parseToken(token: string): { exp: number; [key: string]: unknown } | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64))
  } catch {
    return null
  }
}
