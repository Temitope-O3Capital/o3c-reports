import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation, Link, useNavigate } from 'react-router-dom'
import { roleLabel, MGMT } from '../lib/roles'
import { SORA, PLEX, MONO } from '../lib/design'
import { NAV_ICONS, IcoSearch } from '../lib/icons'
import { allRoles, ROLE_PAGES, type AuthUser } from '../hooks/useAuth'
import { useMediaQuery } from '../hooks/useMediaQuery'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubItem { label: string; to: string; badge?: number; vis?: string[] }
interface NavItem {
  icon:   string
  label:  string
  to:     string
  subs?:  SubItem[]
  vis?:   string[] | 'all'
  badge?: number
  hot?:   boolean
  // Optional module gate: when set, the item shows only while that module_config
  // key is enabled — lets a sub-module (e.g. Feedback) live inside another
  // section's header yet be toggled on/off independently, the way Care does.
  mod?:   string
}
interface Section { key: string; header?: string; items: NavItem[] }

// ── Canonical nav data (BUILD_GUIDE Part 5) ───────────────────────────────────

const SECTIONS: Section[] = [
  {
    key: 'root',
    items: [
      // General Overview is the executive dashboard — management staff only.
      // (canSee also short-circuits MGMT roles, but list them for intent.)
      { icon: 'space_dashboard', label: 'Overview', to: '/', vis: [...MGMT] },
    ],
  },
  {
    key: 'sales',
    header: 'Sales & BD',
    items: [
      {
        icon: 'corporate_fare', label: 'Business Dev', to: '/bd',
        vis: ['bd_officer','bd_head'],
        subs: [
          { label: 'My Dashboard',      to: '/bd/my-dashboard',  vis: ['bd_officer'] },
          // Same page, two scopes: My Pipeline is filtered to the signed-in officer,
          // All Leads is the whole book. They used to be byte-identical.
          { label: 'My Pipeline',       to: '/bd/pipeline' },
          { label: 'All Leads',         to: '/bd/leads' },
          { label: 'Employer Register', to: '/bd/employers' },
          { label: 'Assignments',       to: '/bd/assignments',   vis: ['bd_officer','bd_head'] },
        ],
      },
      {
        icon: 'mark_email_read', label: 'Mail', to: '/mail/overview',
        vis: ['sales_officer','sales_head','bd_officer','bd_head'],
        subs: [
          { label: 'Overview',  to: '/mail/overview' },
          { label: 'Inbox',     to: '/mail/inbox' },
          { label: 'Sent Mail', to: '/mail/sent' },
          { label: 'Outbox',    to: '/mail/outbox' },
          { label: 'Drafts',    to: '/mail/drafts' },
          // Signature lives in Settings → Email Signature. It is a per-user preference
          // like the rest of that page, not a mail destination, and having it in both
          // places left two editors where only one was kept working.
        ],
      },
      {
        icon: 'campaign', label: 'Campaigns & Marketing', to: '/marketing/overview',
        vis: ['sales_head','bd_head','call_center_head'],
        subs: [
          { label: 'Overview',           to: '/marketing/overview' },
          { label: 'All Campaigns',      to: '/campaigns' },
          { label: 'Templates',          to: '/campaigns/templates' },
          { label: 'Contact Lists',      to: '/campaigns/lists' },
          { label: 'Contact Segments',   to: '/contact-segments' },
          { label: 'Marketing Analytics', to: '/marketing/analytics' },
        ],
      },
      {
        // Sales officers are also account officers, so the menu follows that shape:
        // the book you own, the leads you are working, the applications you have
        // raised, then reporting. 'My Accounts' and the old contact list were two
        // routes onto the same idea and are now one — My Book — and 'Cohort Analysis'
        // moved under Reports rather than standing alone.
        icon: 'trending_up', label: 'Sales', to: '/sales/overview',
        vis: ['sales_officer','sales_head'],
        subs: [
          { label: 'Overview',         to: '/sales/overview' },
          { label: 'Team (Live)',      to: '/sales/supervisor', vis: ['sales_head'] },
          { label: 'My Dashboard',     to: '/sales/my-dashboard', vis: ['sales_officer'] },
          { label: 'My Book',          to: '/sales/book' },
          { label: 'Leads',            to: '/sales/leads' },
          { label: 'Teams',            to: '/sales/teams', vis: ['sales_head', 'head_ops', 'admin', 'cmo', 'md', 'coo', 'cfo'] },
          { label: 'Contacts',         to: '/sales/customers' },
          { label: 'Tasks',            to: '/sales/tasks' },
          { label: 'Applications',     to: '/sales/applications' },
          { label: 'Targets',          to: '/sales/targets' },
          { label: 'Cohort Analysis',  to: '/sales/cohort' },
        ],
      },
    ],
  },
  {
    // Contact Centre is the shared category for the two customer-contact departments:
    // Call Center (phone/dialler) and Care (customer email). They remain SEPARATE
    // modules — own roles, own vis gates, own pages — just grouped under one section
    // header, so a call-centre agent sees only Call Center and a Care agent only Care,
    // while a supervisor/admin sees both listed under Contact Centre.
    key: 'contact',
    header: 'Contact Centre',
    items: [
      {
        icon: 'headset_mic', label: 'Call Center', to: '/helpdesk',
        vis: ['call_center_agent','call_center_head'],
        subs: [
          { label: 'My Dashboard',     to: '/helpdesk/my-dashboard' },
          { label: 'Customer Directory', to: '/customers' },
          { label: 'Ticket Queue',     to: '/helpdesk/tickets' },
          { label: 'Escalations',      to: '/helpdesk/escalations' },
          { label: 'Call Log',         to: '/helpdesk/calls' },
          { label: 'Inbound Calls',    to: '/call-center/inbound' },
          { label: 'Outbound Queue',   to: '/call-center/queue' },
          { label: 'Leads',            to: '/call-center/leads' },
          { label: 'Forwarded to Sales', to: '/call-center/forwards' },
          { label: 'DNC List',         to: '/call-center/dnc' },
          // leadership — Performance now lives inside the Supervisor view (not a standalone nav page).
          // Agent Matching is now a modal inside the Supervisor view (not a nav page).
          { label: 'Supervisor View',  to: '/helpdesk/supervisor',      vis: ['call_center_head'] },
          // resources
          { label: 'Knowledge Base',   to: '/helpdesk/knowledge-base' },
          { label: 'Call Scripts',     to: '/helpdesk/canned' },
        ],
      },
      {
        // Care is a distinct module (own module_config toggle + 'care' permission key),
        // worked by dedicated care_agent/care_head roles — call-centre staff don't see
        // Care and Care staff don't see Call Center; both simply live under this header.
        icon: 'mark_email_unread', label: 'Care', to: '/care',
        vis: ['care_agent','care_head'],
        subs: [
          // Care handles customer mail — email-channel tickets shown as an inbox.
          // Dashboard + Supervisor + Analytics are now tabs in the /care hub.
          { label: 'Dashboard',          to: '/care' },
          { label: 'Care Inbox',         to: '/care/inbox' },
          { label: 'Outbox',             to: '/care/outbox' },
          { label: 'Deletion Approvals', to: '/care/approvals' },
          // shared history + resources (customer's cross-channel history via Customer 360).
          // Care-scoped paths (same pages) so the sidebar highlights Care, not Call Center.
          { label: 'Customer Directory', to: '/care/customers' },
          { label: 'Knowledge Base',     to: '/care/knowledge-base' },
          { label: 'Email Templates',    to: '/care/canned' },
        ],
      },
      {
        // Customer Feedback — surveys & their results. Its own module (module_config
        // key 'feedback'), so it can be toggled independently, but it lives under the
        // Contact Centre header alongside Call Center and Care.
        icon: 'reviews', label: 'Customer Feedback', to: '/feedback', mod: 'feedback',
        vis: ['care_agent', 'care_head', 'cards_head', 'call_center_head', 'collections_head', 'cmo'],
      },
    ],
  },
  {
    key: 'cards',
    header: 'Cards',
    items: [
      {
        icon: 'credit_card', label: 'Card Operations', to: '/cards',
        vis: ['cards_agent','cards_head'],
        subs: [
          { label: 'My Queue',            to: '/cards/my-queue', vis: ['cards_agent'] },
          { label: 'Credit Card Portfolio', to: '/cards/credit-portfolio' },
          { label: 'At-Risk Cards',       to: '/cards/at-risk' },
          { label: 'Card Trends',         to: '/cards/trends' },
          { label: 'Cardholder Mgmt',     to: '/cards/management' },
          { label: 'Issuance Queue',      to: '/cards/issuance' },
          { label: 'Disputes',            to: '/cards/disputes' },
          { label: 'Credit Limit Review', to: '/cards/credit-limit' },
          { label: 'Loan Booking',        to: '/loans/approvals', vis: ['cards_agent','cards_head'] },
          { label: 'Billing Cycles',      to: '/cards/billing' },
          { label: 'Blink Card',          to: '/blink-card', vis: ['cards_agent','cards_head'] },
        ],
      },
      {
        icon: 'smartphone', label: 'Mobile App', to: '/mobile-app',
        vis: ['cards_head','coo'],
      },
    ],
  },
  {
    key: 'lending',
    header: 'Operations',
    items: [
      {
        // Every role holding credit_portfolio belongs here — the API now accepts that
        // page too. collections_head was listed twice and recovery_head/coo were
        // missing entirely, so the COO could not see a module they hold every page for.
        icon: 'shield', label: 'Risk', to: '/operations/risk',
        vis: ['risk_officer','risk_head','finance_officer','finance_head',
              'collections_head','recovery_head','settlement_officer','settlement_head','coo'],
        subs: [
          { label: 'Overview',         to: '/operations/risk' },
          { label: 'My Dashboard',     to: '/operations/risk/my-dashboard', vis: ['risk_officer'] },
          { label: 'Supervisor',       to: '/operations/risk/supervisor', vis: ['risk_head','coo'] },
          { label: 'Loan/Credit Card Review',    to: '/operations/risk/applications', vis: ['risk_officer','risk_head','coo'] },
          { label: 'My Approvals',               to: '/loans/approvals', vis: ['risk_officer','risk_head','coo'] },
          { label: 'Loan/Credit Card Portfolio', to: '/operations/risk/portfolio' },
          { label: 'Vintage Analysis', to: '/operations/risk/vintage' },
          { label: 'Eye Score',        to: '/operations/risk/eye-scores',   vis: ['risk_officer','risk_head','coo'] },
          { label: 'Sector Codes',     to: '/operations/risk/sector-codes',  vis: ['risk_officer','risk_head','coo'] },
        ],
      },
      {
        icon: 'collections_bookmark', label: 'Collections', to: '/collections',
        vis: ['collections_agent','collections_head','collections_head'],
        subs: [
          { label: 'Supervisor',           to: '/collections/supervisor', vis: ['collections_head'] },
          { label: 'Credit Portfolio',     to: '/collections/portfolio' },
          { label: 'Repayments Due',       to: '/collections/due-schedule' },
          { label: 'Payment Tiers',        to: '/collections/payment-tiers' },
          { label: 'Watchlist',            to: '/collections/watchlist' },
          { label: 'Agent Queue',          to: '/collections/queue' },
          { label: 'Promises to Pay',      to: '/collections/promises' },
          { label: 'Repayment Plans',      to: '/collections/repayment-plans' },
          { label: 'Write-offs',           to: '/collections/writeoffs' },
          { label: 'Payment Approvals',    to: '/collections/payment-approvals' },
          { label: 'Recovery Approvals',   to: '/collections/recovery-approvals' },
          { label: 'My Dashboard',         to: '/collections-ops/agent', vis: ['collections_agent'] },
        ],
      },
      {
        icon: 'gavel', label: 'Recovery', to: '/recovery',
        vis: ['recovery_agent','recovery_head'],
        subs: [
          { label: 'Overview',       to: '/recovery' },
          { label: 'Supervisor',     to: '/recovery/supervisor', vis: ['recovery_head'] },
          { label: 'My Dashboard',   to: '/recovery-ops/agent', vis: ['recovery_agent'] },
          { label: 'Cases',          to: '/recovery/cases' },
          { label: 'Legal Tracker',  to: '/recovery/legal' },
          { label: 'Debt Sales',     to: '/recovery/debt-sales' },
        ],
      },
      {
        icon: 'compare_arrows', label: 'Settlement & Reconciliation', to: '/settlements',
        vis: ['settlement_officer','settlement_head','finance_head'],
        // The module serves two jobs: OPERATIONS (do the day's work) and REPORTING
        // (see the position). Entries are grouped in that order.
        //
        // Removed: 'NIP Reconciliation' and 'NIP Batch Exceptions' (no NIBSS feed
        // exists — those pages could never show anything, and NIP activity that IS
        // visible arrives via Paystack), and 'Failed Transactions' / 'Batches',
        // both folded into Exceptions and the run log. Their routes still resolve
        // for anyone holding a bookmark.
        subs: [
          { label: 'My Dashboard',             to: '/settlements/my-dashboard', vis: ['settlement_officer'] },
          { label: 'Recon Workbench',          to: '/settlements/workbench' },
          { label: 'Exceptions & Failures',    to: '/settlements/exceptions' },
          { label: 'Settlement Position',      to: '/settlements/position' },
          { label: 'Runs & Imports',           to: '/settlements/runs' },
          { label: 'Processor Reconciliation', to: '/settlements/reconciliation' },
          { label: 'Manual Postings',          to: '/settlements/manual-postings' },
          { label: 'Interswitch',              to: '/settlements/interswitch' },
          { label: 'Transaction Report',       to: '/settlements/interswitch/half-year' },
        ],
      },
    ],
  },
  {
    key: 'finance',
    header: 'Finance',
    items: [
      {
        icon: 'account_balance', label: 'Finance', to: '/finance',
        vis: ['finance_officer','finance_head'],
        subs: [
          { label: 'Overview',          to: '/finance' },
          { label: 'End of Day',        to: '/finance/eod' },
          { label: 'Income Statement',  to: '/finance/income' },
          { label: 'Treasury',          to: '/finance/treasury' },
          { label: 'Transactions',      to: '/finance/transactions' },
          { label: 'Fixed Deposits',    to: '/deposits' },
          { label: 'FX Parallel Rates', to: '/finance/fx-rates' },
          { label: 'Sales Commissions', to: '/finance/commissions' },
          { label: 'Loan Approvals',    to: '/loans/approvals' },
        ],
      },
    ],
  },
  {
    key: 'compliance',
    header: 'Compliance',
    items: [
      {
        icon: 'verified_user', label: 'Compliance', to: '/compliance',
        vis: ['compliance_officer','compliance_head','compliance_head'],
        subs: [
          { label: 'My Dashboard',        to: '/compliance/my-dashboard', vis: ['compliance_officer'] },
          { label: 'Credit Audit Trail',  to: '/compliance/credit-audit-trail' },
          { label: 'AML Watchlist',       to: '/compliance/watchlist' },
          { label: 'Regulatory Calendar', to: '/compliance/regulatory' },
          // A statutory return. It was filed under Analytics only because its
          // route happens to start /reports.
          { label: 'CBN Complaints Report', to: '/compliance/cbn-complaints' },
          { label: 'Findings',            to: '/compliance/findings' },
          { label: 'Checklists',          to: '/compliance/checklists' },
          { label: 'Audit Trail',         to: '/compliance/audit-trail' },
          { label: 'AML Rules',           to: '/compliance/aml-rules' },
          { label: 'Prudential Ratios',   to: '/compliance/prudential' },
          { label: 'Data Subject (DSAR)', to: '/compliance/dsar' },
          { label: 'Concentration Risk',  to: '/compliance/concentration' },
          { label: 'Data Processing Reg', to: '/compliance/dpa-register' },
          { label: 'Policy Documents',    to: '/compliance/policies' },
          { label: 'Data Breaches',       to: '/compliance/breach-incidents' },
          { label: 'Board Pack',          to: '/compliance/board-pack' },
        ],
      },
    ],
  },
  {
    key: 'analytics',
    header: 'Analytics',
    items: [
      // Reports & BI. The data-extract surfaces (Report Builder, My Dashboard,
      // Customer Behaviour) stay BI-only via per-sub vis. KPI Tracker lives here as
      // a page too, but its audience is every operating head plus management, so the
      // MODULE is visible to that wider set; the sensitive subs are gated below and
      // each sub's canOpen still enforces the real page permission. The /reports
      // landing routes each role to a page they can actually open (see ReportsHome).
      {
        icon: 'analytics', label: 'Reports & BI', to: '/reports',
        vis: ['bi_analyst','bi_head','sales_head','collections_head','recovery_head',
              'finance_head','compliance_head','cards_head','risk_head','call_center_head',
              'care_head','bd_head','coo','cfo','cmo','md'],
        subs: [
          { label: 'My Dashboard',       to: '/reports/my-dashboard', vis: ['bi_analyst'] },
          { label: 'Report Builder',     to: '/reports/builder',      vis: ['bi_analyst','bi_head'] },
          { label: 'Customer Behaviour', to: '/reports/behaviour',    vis: ['bi_analyst','bi_head'] },
          { label: 'Data Management',    to: '/reports/uploads',      vis: ['bi_head','cards_head','finance_head','settlement_head','coo','cfo'] },
          { label: 'KPI Tracker',        to: '/reports/kpi',
            vis: ['bi_analyst','bi_head','sales_head','collections_head','recovery_head',
                  'finance_head','compliance_head','cards_head','risk_head','call_center_head',
                  'care_head','bd_head','coo','cfo','cmo','md'] },
          // Growth & Activity now lives INSIDE Reports & BI (moved out of a standalone
          // Analytics item). Surfaced to operating HEADS (not agents) + BI + management;
          // route guard/PAGE_FOR gate on kpi_dashboard/reports/executive.
          { label: 'Growth & Activity',  to: '/growth',
            vis: ['bi_analyst','bi_head','sales_head','cards_head','collections_head','recovery_head',
                  'coo','cfo','cmo','md'] },
        ],
      },
      // Mobile Analytics — app install / media-source / funnel analytics from AppsFlyer,
      // one sub per mobile app. Blink carries live data; the main Mobile App (o3cards)
      // is built identically but isn't on AppsFlyer yet.
      {
        icon: 'smartphone', label: 'Mobile Analytics', to: '/mobile-analytics/blink',
        vis: ['bi_analyst','bi_head','cmo','cards_head','coo','cfo','md'],
        subs: [
          { label: 'Blink',      to: '/mobile-analytics/blink' },
          { label: 'Mobile App', to: '/mobile-analytics/app'   },
        ],
      },
      {
        icon: 'receipt_long', label: 'Statements', to: '/statements',
        vis: ['bi_head','finance_head'],
        subs: [
          { label: 'Account Statements',     to: '/statements' },
          { label: 'Credit Card Statements', to: '/statements/credit-cards' },
        ],
      },
      {
        icon: 'account_balance', label: 'Udara', to: '/core-banking',
        vis: ['finance_officer','finance_head'],
      },
    ],
  },
  {
    key: 'admin',
    header: 'Admin',
    items: [
      {
        icon: 'admin_panel_settings', label: 'System Admin', to: '/admin',
        vis: ['it_admin'],
      },
    ],
  },
]

// ── Page-key gating ───────────────────────────────────────────────────────────
// Every nav destination maps to the page-key(s) its route guard (RequireAccess in
// App.tsx) enforces. The sidebar hides any entry whose page the signed-in user does
// not hold, so the menu shows only what will actually open — no items that would
// immediately bounce to a redirect. This is what stops management roles (coo/cfo/cmo)
// from seeing modules they can't enter, and clears dead cross-module links (e.g. a
// sales officer seeing "Business Dev", a compliance officer seeing audit-trail pages).
// Keep in step with the route→page map in App.tsx. Entries with no mapping here are
// left to the role (`vis`) gate alone. admin & md bypass entirely.
const PAGE_FOR: Record<string, string | string[]> = {
  // Sales & BD
  '/bd': 'bd', '/bd/my-dashboard': 'bd', '/bd/pipeline': 'bd_pipeline',
  '/bd/leads': 'bd', '/bd/employers': 'bd_employers', '/bd/assignments': 'bd',
  '/mail/overview': 'mail', '/mail/inbox': 'mail', '/mail/sent': 'mail', '/mail/drafts': 'mail', '/mail/outbox': 'mail',
  '/marketing/overview': 'campaigns', '/campaigns': 'campaigns', '/campaigns/templates': 'campaigns',
  '/campaigns/lists': 'campaigns', '/contact-segments': 'campaigns', '/marketing/analytics': 'campaigns',
  '/sales/overview': 'sales', '/sales/my-dashboard': 'sales', '/sales/book': 'crm_contacts',
  '/sales/leads': 'crm_contacts', '/sales/teams': 'crm_contacts', '/sales/customers': 'crm_contacts',
  '/sales/crm': 'crm_pipeline', '/sales/tasks': 'crm_tasks', '/sales/applications': 'loans',
  '/sales/targets': 'sales', '/sales/reports': 'crm_reports', '/sales/cohort': 'cohort',
  // Contact Centre
  '/helpdesk': 'helpdesk', '/helpdesk/my-dashboard': 'helpdesk', '/helpdesk/tickets': 'helpdesk',
  '/helpdesk/escalations': 'helpdesk',
  '/helpdesk/calls': 'helpdesk', '/helpdesk/supervisor': 'helpdesk',
  '/helpdesk/knowledge-base': 'helpdesk', '/helpdesk/canned': 'helpdesk_canned',
  '/customers': 'customer360',
  '/call-center/queue': 'call_center', '/call-center/leads': 'call_center', '/call-center/forwards': 'call_center', '/call-center/dnc': 'call_center',
  '/call-center/inbound': 'call_center',
  '/call-center/performance': 'call_center_stats',
  '/care': 'care', '/care/inbox': 'care', '/care/outbox': 'care', '/care/approvals': 'care', '/care/customers': 'customer360',
  '/care/knowledge-base': 'helpdesk', '/care/canned': 'helpdesk_canned',
  // Customer Feedback
  '/feedback': 'surveys',
  // Cards
  '/cards': 'cards', '/cards/my-queue': 'cards', '/cards/credit-portfolio': 'cards',
  '/cards/at-risk': 'cards', '/cards/cycle-import': 'cards', '/cards/trends': 'card_trends',
  '/cards/management': 'cards', '/cards/issuance': 'cards', '/cards/disputes': 'cards',
  '/cards/credit-limit': 'cards', '/cards/billing': 'cards', '/blink-card': 'blink_card',
  '/mobile-app': 'mobile_app',
  // Operations
  '/operations/risk': 'credit_portfolio', '/operations/risk/my-dashboard': 'credit_portfolio', '/operations/risk/applications': 'credit_portfolio',
  '/operations/risk/portfolio': ['credit_portfolio', 'active_loan_book'], '/operations/risk/vintage': 'credit_portfolio',
  '/operations/risk/eye-scores': 'credit_portfolio',
  '/operations/risk/supervisor': ['risk_head', 'risk_all'],
  '/operations/risk/sector-codes': 'credit_portfolio',
  '/collections': 'collections', '/collections/supervisor': 'collections_assign',
  '/collections/portfolio': 'collections', '/collections/payment-tiers': 'collections', '/collections/due-schedule': 'collections', '/collections/watchlist': 'collections',
  '/collections/queue': 'collections', '/collections/promises': 'collections',
  '/collections/repayment-plans': 'collections', '/collections/writeoffs': 'collections',
  '/collections/writeoff-requests': 'collections', '/collections/recovery-approvals': 'recovery',
  '/collections/payment-approvals': 'collections_payment_approve',
  '/collections/activity-log': 'collections', '/collections-ops/agent': 'collections',
  '/recovery': 'recovery', '/recovery/supervisor': 'recovery_assign',
  '/recovery-ops/agent': 'recovery', '/recovery/cases': 'recovery',
  '/recovery/legal': 'recovery', '/recovery/debt-sales': 'recovery',
  '/settlements': 'settlement', '/settlements/my-dashboard': 'settlement',
  '/settlements/workbench': ['settlement', 'reconciliation'], '/settlements/exceptions': ['settlement', 'reconciliation'],
  '/settlements/position': ['settlement', 'reconciliation'], '/settlements/runs': ['settlement', 'reconciliation'],
  '/settlements/reconciliation': 'reconciliation', '/settlements/manual-postings': 'settlement',
  '/settlements/interswitch': ['settlement', 'cards'], '/settlements/interswitch/half-year': ['settlement', 'cards'],
  '/settlements/interswitch/import': ['settlement', 'cards'],
  // Finance
  '/finance': 'income', '/finance/transactions': 'transactions', '/finance/income': 'income', '/finance/treasury': 'income', '/finance/commissions': 'income',
  '/deposits': 'fixed_deposit', '/finance/eod': 'eod', '/finance/fx-rates': 'fx_rates',
  // Compliance
  '/compliance': 'watch_list', '/compliance/my-dashboard': ['watch_list', 'audit_findings', 'compliance_checklists', 'compliance_all'],
  '/compliance/credit-audit-trail': 'audit_trail',
  '/compliance/watchlist': 'watch_list', '/compliance/regulatory': 'watch_list',
  '/compliance/findings': 'audit_findings', '/compliance/checklists': 'compliance_checklists',
  '/compliance/audit-trail': 'audit_trail',
  '/compliance/aml-rules': 'watch_list', '/compliance/prudential': 'watch_list',
  '/compliance/dsar': 'watch_list', '/compliance/concentration': 'watch_list',
  '/compliance/dpa-register': 'watch_list',
  '/compliance/policies': 'compliance_checklists',
  '/compliance/breach-incidents': 'compliance_all',
  '/compliance/board-pack': 'compliance_all',
  // Analytics
  // '/reports' itself is intentionally left ungated so the KPI audience (heads +
  // management, who lack the 'reports' page) can open the module; ReportsHome routes
  // them to a page they can access. The individual subs below still enforce pages.
  '/reports/my-dashboard': 'reports', '/reports/behaviour': 'reports', '/reports/builder': 'reports', '/reports/kpi': 'kpi_dashboard', '/reports/uploads': 'uploads', '/compliance/cbn-complaints': 'cbn_reports',
  '/growth': ['kpi_dashboard', 'reports', 'executive'],
  '/statements': 'statements', '/statements/credit-cards': 'statements', '/core-banking': 'core-banking',
  // Admin
  '/admin': 'admin_users',
}

// ── Role visibility ───────────────────────────────────────────────────────────


// Visibility is evaluated against the user's full role set (primary + secondary
// team roles), so multi-team staff see every module any of their roles grants.
function canSee(vis: NavItem['vis'], roles: string[]): boolean {
  if (roles.some(r => MGMT.has(r))) return true
  if (vis === 'all')                return true
  if (!vis)                         return false
  return roles.some(r => (vis as string[]).includes(r))
}

function canSeeSub(vis: string[] | undefined, roles: string[]): boolean {
  if (!vis) return true
  if (roles.some(r => MGMT.has(r))) return true
  return roles.some(r => vis.includes(r))
}

// makeCanOpen returns a predicate that answers "will this destination actually open
// for the signed-in user". user.pages (baked into the JWT at login) is authoritative;
// ROLE_PAGES is only the dev/empty-token fallback. admin & md are unrestricted.
function makeCanOpen(user: AuthUser, roles: string[]): (to: string) => boolean {
  if (roles.some(r => r === 'admin' || r === 'md')) return () => true
  const pages = user.pages?.length ? user.pages : roles.flatMap(r => ROLE_PAGES[r] ?? [])
  const held = new Set(pages)
  return (to: string) => {
    const need = PAGE_FOR[to]
    if (!need) return true
    return Array.isArray(need) ? need.some(p => held.has(p)) : held.has(need)
  }
}

function visibleSections(roles: string[], canOpen: (to: string) => boolean): Section[] {
  return SECTIONS
    .map(s => ({ ...s, items: s.items.filter(item => canSee(item.vis, roles) && canOpen(item.to)) }))
    .filter(s => s.items.length > 0)
}

// ── Sub-item ──────────────────────────────────────────────────────────────────

function SubLink({ sub, active }: { sub: SubItem; active: boolean }) {
  return (
    <Link
      to={sub.to}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '7px 14px 7px 40px',
        fontSize: 13, fontFamily: SORA,
        color: active ? '#7DD3FC' : 'rgba(255,255,255,.66)',
        borderLeft: active ? '3px solid #0EA5E9' : '3px solid transparent',
        textDecoration: 'none',
        transition: 'color .12s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = '#fff' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,.66)' }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub.label}</span>
      {sub.badge != null && sub.badge > 0 && (
        <span style={{ fontFamily: MONO, fontSize: 10, color: 'rgba(255,255,255,.4)', marginLeft: 'auto' }}>
          {sub.badge}
        </span>
      )}
    </Link>
  )
}

// ── Nav badge ─────────────────────────────────────────────────────────────────

function NavBadge({ n, hot }: { n: number; hot?: boolean }) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, fontWeight: 500,
      background: hot ? 'rgba(192,0,0,.35)' : 'rgba(14,165,233,.18)',
      color: hot ? '#FCA5A5' : '#7DD3FC',
      borderRadius: 3, padding: '1px 6px',
      marginLeft: 'auto', flexShrink: 0,
    }}>
      {n > 99 ? '99+' : n}
    </span>
  )
}

// ── Nav row ───────────────────────────────────────────────────────────────────

function NavRow({
  item, isActive, hasActiveSub, collapsed, open, onToggle, roles, canOpen,
}: {
  item: NavItem; isActive: boolean; hasActiveSub: boolean
  collapsed: boolean; open: boolean; onToggle: () => void; roles: string[]
  canOpen: (to: string) => boolean
}) {
  const visibleSubs = item.subs?.filter(s => canSeeSub(s.vis, roles) && canOpen(s.to)) ?? []
  const hasSubs     = visibleSubs.length > 0
  const highlighted = isActive || hasActiveSub
  const { pathname } = useLocation()

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center',
    gap: 10,
    padding: collapsed ? '10px 0' : '8px 12px 8px 11px',
    justifyContent: collapsed ? 'center' : undefined,
    borderLeft: collapsed ? 'none' : (highlighted ? '3px solid #0EA5E9' : '3px solid transparent'),
    fontSize: 13.5, fontFamily: SORA, fontWeight: 500,
    color: highlighted ? '#fff' : 'rgba(255,255,255,.72)',
    background: highlighted ? 'rgba(14,165,233,.10)' : 'transparent',
    cursor: 'pointer',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    transition: 'background .12s, color .12s',
  }

  const Ico = NAV_ICONS[item.icon]

  const content = (
    <>
      {Ico
        ? <Ico size={16} style={{ flexShrink: 0, opacity: 0.85 }} />
        : <span className="material-symbols-rounded" style={{ fontSize: 16, flexShrink: 0, opacity: 0.85 }}>{item.icon}</span>
      }
      {!collapsed && (
        <>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.label}
          </span>
          {item.badge != null && item.badge > 0 && (
            <NavBadge n={item.badge} hot={item.hot} />
          )}
        </>
      )}
    </>
  )

  function handleHover(el: HTMLElement, enter: boolean) {
    if (!highlighted) {
      el.style.color = enter ? '#fff' : 'rgba(255,255,255,.66)'
      el.style.background = enter ? 'rgba(255,255,255,.03)' : 'transparent'
    }
  }

  if (hasSubs) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link
            to={item.to}
            onClick={() => { if (!open) onToggle() }}
            style={{ ...rowStyle, flex: 1, paddingRight: collapsed ? undefined : 4 }}
            onMouseEnter={e => handleHover(e.currentTarget as HTMLElement, true)}
            onMouseLeave={e => handleHover(e.currentTarget as HTMLElement, false)}
          >
            {Ico
              ? <Ico size={16} style={{ flexShrink: 0, opacity: 0.85 }} />
              : <span className="material-symbols-rounded" style={{ fontSize: 16, flexShrink: 0, opacity: 0.85 }}>{item.icon}</span>
            }
            {!collapsed && (
              <>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
                {item.badge != null && item.badge > 0 && <NavBadge n={item.badge} hot={item.hot} />}
              </>
            )}
          </Link>
        </div>
        {!collapsed && (
          <div style={{
            overflow: 'hidden',
            maxHeight: open ? `${visibleSubs.length * 34}px` : 0,
            transition: 'max-height .18s ease',
          }}>
            {visibleSubs.map(sub => (
              <SubLink key={sub.to} sub={sub} active={pathname === sub.to} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <Link
      to={item.to}
      title={collapsed ? item.label : undefined}
      style={rowStyle}
      onMouseEnter={e => handleHover(e.currentTarget as HTMLElement, true)}
      onMouseLeave={e => handleHover(e.currentTarget as HTMLElement, false)}
    >
      {content}
    </Link>
  )
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label, collapsed }: { label?: string; collapsed: boolean }) {
  if (!label) return null
  if (collapsed) return <div style={{ height: 8 }} />
  return (
    <div style={{
      padding: '14px 14px 4px',
      fontSize: 11, fontWeight: 600,
      letterSpacing: '.12em', textTransform: 'uppercase',
      color: 'rgba(255,255,255,.44)',
      whiteSpace: 'nowrap', fontFamily: SORA,
    }}>
      {label}
    </div>
  )
}

// ── Flat module (agent view) ──────────────────────────────────────────────────
// Agents/officers work inside one or two modules, so a collapsible dropdown is
// pure friction. Their nav shows the module as a section header with every page
// they can reach listed flat beneath it — no clicking to expand.
function FlatModule({ item, roles, pathname, canOpen }: { item: NavItem; roles: string[]; pathname: string; canOpen: (to: string) => boolean }) {
  const subs = item.subs?.filter(s => canSeeSub(s.vis, roles) && canOpen(s.to)) ?? []
  const Ico = NAV_ICONS[item.icon]
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '14px 14px 6px',
        fontSize: 11.5, fontWeight: 700, letterSpacing: '.11em', textTransform: 'uppercase',
        color: 'rgba(255,255,255,.52)', fontFamily: SORA, whiteSpace: 'nowrap',
      }}>
        {Ico
          ? <Ico size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
          : <span className="material-symbols-rounded" style={{ fontSize: 14, opacity: 0.6, flexShrink: 0 }}>{item.icon}</span>}
        <span>{item.label}</span>
      </div>
      {subs.length > 0
        ? subs.map(sub => <SubLink key={sub.to} sub={sub} active={pathname === sub.to} />)
        : <SubLink sub={{ label: `${item.label} Home`, to: item.to }} active={pathname === item.to || pathname.startsWith(item.to + '/')} />}
    </div>
  )
}

// Which top-level nav item "owns" the current path, for section highlight + auto-expand.
// Uses a boundary-aware, LONGEST-prefix match so a broad prefix in one section can't
// hijack a deeper route that belongs to another (fixes cross-section mis-highlighting).
// Shared Customer-360 profile drill-ins (/customers/:id, /care/customers/:id) are opened
// from every module, so they deliberately own NO section — otherwise opening a customer
// from Collections/Recovery/Cards would light up Call Center (which hosts the directory).
function isSharedProfilePath(p: string): boolean {
  // Only the bare /customers/:cif is section-neutral (it's opened from every module via
  // the Customer-360 button). /care/customers/:cif is explicitly under Care, so it stays
  // owned by Care and keeps that context.
  return /^\/customers\/[^/]+/.test(p)
}
function navOwns(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(to + '/')
}
function activeItemTo(pathname: string): string | null {
  if (isSharedProfilePath(pathname)) return null
  let bestTo: string | null = null
  let bestLen = -1
  for (const s of SECTIONS) {
    for (const item of s.items) {
      const cands = [item.to, ...(item.subs?.map(x => x.to) ?? [])]
      for (const c of cands) {
        if (c && c !== '/' && navOwns(pathname, c) && c.length > bestLen) {
          bestLen = c.length
          bestTo = item.to
        }
      }
    }
  }
  return bestTo
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function Sidebar({ user, onLogout, utilities, onCmdK, enabledModules }: {
  user: AuthUser; onLogout: () => void; utilities?: ReactNode; onCmdK?: () => void
  enabledModules: Set<string>
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const activeTo = activeItemTo(pathname)

  // The user's stored preference, and the effective state. On a narrow viewport the rail
  // is forced collapsed to give the content room, without clobbering what the user chose —
  // expanding the window restores their preference.
  const [userCollapsed, setUserCollapsed] = useState(() => localStorage.getItem('o3c_sb') === '1')
  const isNarrow = useMediaQuery('(max-width: 1100px)')
  const collapsed = userCollapsed || isNarrow

  // Poll /api/health every 60 s to reflect the datastore (PostgreSQL) status.
  const [dbStatus, setDbStatus] = useState<'online' | 'offline' | null>(null)
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const token = localStorage.getItem('o3c_token')
        const res = await fetch('/api/health', token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
        const json = await res.json()
        if (!cancelled) setDbStatus(res.ok && json.status === 'ok' ? 'online' : 'offline')
      } catch { if (!cancelled) setDbStatus('offline') }
    }
    poll()
    const id = setInterval(poll, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const [openKey, setOpenKey] = useState<string | null>(() => activeItemTo(pathname))

  useEffect(() => {
    localStorage.setItem('o3c_sb', userCollapsed ? '1' : '0')
  }, [userCollapsed])

  const roleSet = allRoles(user)

  // canOpen hides any nav entry whose route the user's pages don't grant, so the menu
  // shows only what actually opens (no items that would redirect). See makeCanOpen.
  const canOpen = makeCanOpen(user, roleSet)

  // root and admin sections always show; all others require the module to be enabled.
  // Items carrying their own `mod` (a sub-module hosted under another section, e.g.
  // Feedback under Contact Centre) are additionally hidden when that module is off.
  const sections = visibleSections(roleSet, canOpen)
    .map(s => ({ ...s, items: s.items.filter(it => !it.mod || enabledModules.has(it.mod)) }))
    .filter(s => (s.key === 'root' || s.key === 'admin' || enabledModules.has(s.key)) && s.items.length > 0)

  // Agents/officers get a flat, dropdown-free nav (module = header, pages listed
  // beneath). Heads, management and admins keep the collapsible accordion since
  // they span many modules. Collapsed rail always uses the icon accordion.
  const flatNav = !collapsed && roleSet.length > 0 && roleSet.every(r => /(_agent|_officer)$/.test(r))

  function toggleItem(to: string) {
    setOpenKey(prev => prev === to ? null : to)
  }

  const initials = user.name
    .split(' ')
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const W = collapsed ? 60 : 238

  return (
    <aside style={{
      width: W, minWidth: W,
      display: 'flex', flexDirection: 'column',
      height: '100vh', flexShrink: 0,
      background: 'var(--sb)',
      color: 'rgba(255,255,255,.72)',
      transition: 'width 180ms ease, min-width 180ms ease',
      position: 'relative', zIndex: 10,
    }}>

      {/* ── Brand row ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: collapsed ? '14px 0' : '12px 12px 11px',
        borderBottom: '1px solid rgba(255,255,255,.08)',
        justifyContent: collapsed ? 'center' : 'space-between',
        flexShrink: 0, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, overflow: 'hidden', minWidth: 0 }}>
          {/* L4: branding reads from VITE_ORG_NAME env var */}
          <img
            src="/o3-logo-transparent.svg"
            width={46} height={25}
            alt={import.meta.env.VITE_ORG_NAME ?? 'O3 Capital'}
            style={{ display: 'block', flexShrink: 0 }}
          />

          {!collapsed && (
            <div style={{ overflow: 'hidden', minWidth: 0 }}>
              <div style={{
                fontWeight: 700, fontSize: 13.5, color: 'var(--nav-act-txt)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontFamily: SORA, letterSpacing: '-0.2px', lineHeight: 1.15,
              }}>
                {import.meta.env.VITE_ORG_NAME ?? 'O3 Capital'}
              </div>
              <div style={{
                fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '1.4px', color: 'var(--grp)',
                fontFamily: SORA, marginTop: 3, whiteSpace: 'nowrap',
              }}>
                Workspace
              </div>
            </div>
          )}
        </div>
        {/* L3: switch workspace button removed — no workspace picker in this deployment */}
      </div>

      {/* Floating collapse/expand tab */}
      <div
        onClick={() => setUserCollapsed(c => !c)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{
          position: 'absolute', right: -12, top: '50%', transform: 'translateY(-50%)',
          width: 20, height: 40,
          background: 'var(--sb)',
          border: '1px solid rgba(255,255,255,.08)',
          borderLeft: 'none',
          borderRadius: '0 8px 8px 0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 20,
          color: 'var(--nav-txt)',
          transition: 'color 120ms',
          boxShadow: '2px 0 6px rgba(0,0,0,.12)',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nav-hvr-txt)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nav-txt)' }}
      >
        <span className="material-symbols-rounded" style={{
          fontSize: 13,
          transform: collapsed ? 'none' : 'rotate(180deg)',
          transition: 'transform 240ms cubic-bezier(0.4,0,0.2,1)',
        }}>
          chevron_right
        </span>
      </div>

      {/* ── ⌘K bar ────────────────────────────────────────────────────────── */}
      {!collapsed && (
        <button
          onClick={onCmdK}
          style={{
            margin: '12px 12px 4px', flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--sb2)', border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 8, padding: '7px 10px',
            color: 'var(--nav-txt)', fontSize: 12,
            fontFamily: SORA, cursor: 'pointer', whiteSpace: 'nowrap',
            transition: 'border-color .12s, color .12s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--nav-dot)'
            ;(e.currentTarget as HTMLElement).style.color = 'var(--nav-hvr-txt)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,.08)'
            ;(e.currentTarget as HTMLElement).style.color = 'var(--nav-txt)'
          }}
        >
          <IcoSearch size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
          <span style={{ flex: 1, textAlign: 'left' }}>Jump to…</span>
          <kbd style={{
            fontFamily: MONO, fontSize: 10,
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 3, padding: '1px 5px',
            color: 'var(--nav-txt)',
            background: 'transparent',
          }}>
            {IS_MAC ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
      )}

      {/* ── Nav ───────────────────────────────────────────────────────────── */}
      <nav style={{
        flex: 1, overflowY: 'auto', overflowX: 'clip',
        padding: '8px 0',
        scrollbarWidth: 'thin',
        scrollbarColor: 'var(--sb2) transparent',
      }}>
        {flatNav
          ? sections.flatMap(s => s.items).map(item => (
              <FlatModule key={item.to} item={item} roles={roleSet} pathname={pathname} canOpen={canOpen} />
            ))
          : sections.map((section, i) => (
              <div key={section.key}>
                {(section.header || i > 0) && (
                  <SectionHeader label={section.header} collapsed={collapsed} />
                )}
                {section.items.map(item => (
                  <NavRow
                    key={item.to}
                    item={item}
                    roles={roleSet}
                    canOpen={canOpen}
                    isActive={item.to === '/' ? pathname === '/' : item.to === activeTo}
                    hasActiveSub={item.to === activeTo && pathname !== item.to}
                    collapsed={collapsed}
                    open={openKey === item.to}
                    onToggle={() => toggleItem(item.to)}
                  />
                ))}
              </div>
            ))}
      </nav>

      {/* ── User footer ───────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,.08)', overflow: 'hidden' }}>
        {utilities && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexWrap: 'wrap', gap: 2, padding: '6px 6px 4px',
          }}>
            {utilities}
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: collapsed ? '12px 8px' : '12px 14px',
          justifyContent: collapsed ? 'center' : undefined,
        }}>
          {/* Avatar */}
          <div style={{
            width: 30, height: 30, minWidth: 30, borderRadius: '50%',
            background: '#0EA5E9',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 600, fontSize: 12, color: '#fff', flexShrink: 0,
            fontFamily: SORA,
          }}>
            {initials}
          </div>

          {!collapsed && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--nav-act-txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: SORA }}>
                  {user.name}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--nav-txt)', whiteSpace: 'nowrap', fontFamily: SORA }}>
                  {roleLabel(user.role as string)}
                </div>
              </div>

              <button
                onClick={() => navigate('/settings')}
                title="Settings"
                style={{
                  width: 24, height: 24, borderRadius: 4, border: 'none',
                  background: 'transparent', cursor: 'pointer', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--nav-txt)', transition: 'color 120ms',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nav-hvr-txt)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nav-txt)' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 17 }}>settings</span>
              </button>

              <button
                onClick={onLogout}
                title="Sign out"
                style={{
                  width: 24, height: 24, borderRadius: 4, border: 'none',
                  background: 'transparent', cursor: 'pointer', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--nav-txt)', transition: 'color 120ms',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#C00000' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nav-txt)' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 17 }}>logout</span>
              </button>
            </>
          )}
        </div>

        {/* Sync strip — shown only when expanded */}
        {!collapsed && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 14px', fontSize: 10.5,
            background: 'rgba(0,0,0,.22)', color: 'rgba(255,255,255,.5)',
            whiteSpace: 'nowrap', fontFamily: MONO,
          }}>
            <span style={{
              width: 6, height: 6, minWidth: 6, borderRadius: '50%',
              background: dbStatus === 'online' ? '#2FB673' : dbStatus === 'offline' ? '#C00000' : '#888',
              boxShadow: dbStatus === 'online' ? '0 0 0 3px rgba(47,182,115,.2)' : undefined,
              display: 'inline-block', flexShrink: 0,
            }} />
            {dbStatus === 'online' ? 'Database · live' : dbStatus === 'offline' ? 'Database · offline' : 'Database · checking…'}
          </div>
        )}

      </div>
    </aside>
  )
}
