import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation, Link, useNavigate } from 'react-router-dom'
import { roleLabel, MGMT } from '../lib/roles'
import { SORA, PLEX, MONO } from '../lib/design'
import { NAV_ICONS, IcoSearch } from '../lib/icons'
import { allRoles, ROLE_PAGES, type AuthUser } from '../hooks/useAuth'

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
        vis: ['sales_officer','sales_head','sales_head','bd_officer','bd_head'],
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
        vis: ['sales_officer','sales_head','sales_head','bd_officer','bd_head'],
        subs: [
          { label: 'Overview',  to: '/mail/overview' },
          { label: 'Inbox',     to: '/mail/inbox' },
          { label: 'Sent Mail', to: '/mail/sent' },
          { label: 'Drafts',    to: '/mail/drafts' },
          // Signature lives in Settings → Email Signature. It is a per-user preference
          // like the rest of that page, not a mail destination, and having it in both
          // places left two editors where only one was kept working.
        ],
      },
      {
        icon: 'campaign', label: 'Campaigns & Marketing', to: '/marketing/overview',
        vis: ['sales_head','sales_head','bd_officer','bd_head','call_center_head'],
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
        icon: 'trending_up', label: 'Sales & CRM', to: '/sales/overview',
        vis: ['sales_officer','sales_head','sales_head'],
        subs: [
          { label: 'Overview',         to: '/sales/overview' },
          { label: 'My Book',          to: '/sales/book' },
          { label: 'Leads',            to: '/sales/leads' },
          { label: 'Pipeline',         to: '/sales/crm' },
          { label: 'Tasks',            to: '/sales/tasks' },
          { label: 'Applications',     to: '/sales/applications' },
          { label: 'Targets',          to: '/sales/targets' },
          { label: 'Reports',          to: '/sales/reports' },
        ],
      },
    ],
  },
  {
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
          { label: 'Call Log',         to: '/helpdesk/calls' },
          { label: 'Inbound Calls',    to: '/call-center/inbound' },
          { label: 'Outbound Queue',   to: '/call-center/queue' },
          { label: 'Leads',            to: '/call-center/leads' },
          { label: 'DNC List',         to: '/call-center/dnc' },
          // leadership
          { label: 'Performance',      to: '/call-center/performance',  vis: ['call_center_head'] },
          { label: 'Agent Matching',   to: '/call-center/agent-matching', vis: ['call_center_head'] },
          { label: 'Supervisor View',  to: '/helpdesk/supervisor',      vis: ['call_center_head'] },
          // resources
          { label: 'Knowledge Base',   to: '/helpdesk/knowledge-base' },
          { label: 'Call Scripts',     to: '/helpdesk/canned' },
        ],
      },
      {
        icon: 'mark_email_unread', label: 'Care', to: '/care',
        vis: ['call_center_agent','call_center_head'],
        subs: [
          // Care handles customer mail — email-channel tickets shown as an inbox.
          // Dashboard + Supervisor + Analytics are now tabs in the /care hub.
          { label: 'Dashboard',          to: '/care' },
          { label: 'Care Inbox',         to: '/care/inbox' },
          // shared history + resources (customer's cross-channel history via Customer 360).
          // Care-scoped paths (same pages) so the sidebar highlights Care, not Call Center.
          { label: 'Customer Directory', to: '/care/customers' },
          { label: 'Knowledge Base',     to: '/care/knowledge-base' },
          { label: 'Email Templates',    to: '/care/canned' },
        ],
      },
    ],
  },
  {
    key: 'cards',
    header: 'Cards',
    items: [
      {
        icon: 'credit_card', label: 'Card Operations', to: '/cards',
        vis: ['cards_agent','cards_head','risk_officer','risk_head'],
        subs: [
          { label: 'My Queue',            to: '/cards/my-queue', vis: ['cards_agent'] },
          { label: 'Credit Card Portfolio', to: '/cards/credit-portfolio' },
          { label: 'At-Risk Cards',       to: '/cards/at-risk' },
          { label: 'Import Cycle Data',   to: '/cards/cycle-import', vis: ['cards_head','finance_head'] },
          { label: 'Card Trends',         to: '/cards/trends' },
          { label: 'Cardholder Mgmt',     to: '/cards/management' },
          { label: 'Issuance Queue',      to: '/cards/issuance' },
          { label: 'Disputes',            to: '/cards/disputes' },
          { label: 'Credit Limit Review', to: '/cards/credit-limit' },
          { label: 'Billing Cycles',      to: '/cards/billing' },
          { label: 'Blink Card',          to: '/blink-card', vis: ['cards_agent','cards_head'] },
        ],
      },
      {
        icon: 'smartphone', label: 'Mobile App', to: '/mobile-app',
        vis: ['cards_head','finance_head','coo'],
      },
    ],
  },
  {
    key: 'lending',
    header: 'Operations',
    items: [
      {
        icon: 'shield', label: 'Risk', to: '/operations/risk',
        vis: ['risk_officer','risk_head','finance_officer','finance_head','collections_head','collections_head'],
        subs: [
          { label: 'Overview',         to: '/operations/risk',              vis: ['risk_officer','risk_head'] },
          { label: 'App Review',       to: '/operations/risk/applications', vis: ['risk_officer','risk_head'] },
          { label: 'Portfolio',        to: '/operations/risk/portfolio' },
          { label: 'Vintage Analysis', to: '/operations/risk/vintage',      vis: ['risk_officer','risk_head'] },
        ],
      },
      {
        icon: 'collections_bookmark', label: 'Collections', to: '/collections',
        vis: ['collections_agent','collections_head','collections_head'],
        subs: [
          { label: 'Credit Portfolio',     to: '/collections/portfolio' },
          { label: 'Watchlist',            to: '/collections/watchlist' },
          { label: 'Agent Queue',          to: '/collections/queue' },
          { label: 'Promises to Pay',      to: '/collections/promises' },
          { label: 'Repayment Plans',      to: '/collections/repayment-plans' },
          { label: 'Write-off Approvals',  to: '/collections/writeoffs' },
          { label: 'Write-off Requests',   to: '/collections/writeoff-requests' },
          { label: 'Recovery Approvals',   to: '/collections/recovery-approvals' },
          { label: 'Activity Log',         to: '/collections/activity-log', vis: ['collections_head','collections_head'] },
          { label: 'My Dashboard',         to: '/collections-ops/agent', vis: ['collections_agent'] },
        ],
      },
      {
        icon: 'gavel', label: 'Recovery', to: '/recovery',
        vis: ['recovery_agent','recovery_head','recovery_head'],
        subs: [
          { label: 'My Dashboard',   to: '/recovery-ops/agent', vis: ['recovery_agent'] },
          { label: 'Cases',          to: '/recovery/cases' },
          { label: 'Legal Tracker',  to: '/recovery/legal' },
          { label: 'Activity Log',   to: '/recovery/activity-log', vis: ['recovery_head','recovery_head'] },
          { label: 'Debt Sales',     to: '/recovery/debt-sales' },
        ],
      },
      {
        icon: 'compare_arrows', label: 'Settlement & Reconciliation', to: '/settlements',
        vis: ['settlement_officer','finance_head','finance_head'],
        // The module serves two jobs: OPERATIONS (do the day's work) and REPORTING
        // (see the position). Entries are grouped in that order.
        //
        // Removed: 'NIP Reconciliation' and 'NIP Batch Exceptions' (no NIBSS feed
        // exists — those pages could never show anything, and NIP activity that IS
        // visible arrives via Paystack), and 'Failed Transactions' / 'Batches',
        // both folded into Exceptions and the run log. Their routes still resolve
        // for anyone holding a bookmark.
        subs: [
          { label: 'Recon Workbench',          to: '/settlements/workbench' },
          { label: 'Exceptions & Failures',    to: '/settlements/exceptions' },
          { label: 'Settlement Position',      to: '/settlements/position' },
          { label: 'Runs & Imports',           to: '/settlements/runs' },
          { label: 'Processor Reconciliation', to: '/settlements/reconciliation' },
          { label: 'Manual Postings',          to: '/settlements/manual-postings' },
          { label: 'Interswitch',              to: '/settlements/interswitch' },
          { label: 'Transaction Report',       to: '/settlements/interswitch/half-year' },
          { label: 'Import EODTXN',            to: '/settlements/interswitch/import', vis: ['cards_head'] },
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
        vis: ['finance_officer','finance_head','finance_head'],
        subs: [
          { label: 'Transactions',      to: '/finance/transactions' },
          { label: 'Income',            to: '/finance/income' },
          { label: 'Fixed Deposits',    to: '/deposits' },
          { label: 'EOD / EOB',         to: '/finance/eod' },
          { label: 'FX Parallel Rates', to: '/finance/fx-rates' },
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
          { label: 'Credit Audit Trail',  to: '/compliance/credit-audit-trail' },
          { label: 'AML Watchlist',       to: '/compliance/watchlist' },
          { label: 'Regulatory Calendar', to: '/compliance/regulatory' },
          { label: 'Findings',            to: '/compliance/findings' },
          { label: 'Checklists',          to: '/compliance/checklists' },
          { label: 'Audit Trail',         to: '/compliance/audit-trail' },
          { label: 'KYC Expiry',          to: '/compliance/kyc-expiry' },
          { label: 'AML Rules',           to: '/compliance/aml-rules' },
          { label: 'Prudential Ratios',   to: '/compliance/prudential' },
          { label: 'Data Subject (DSAR)', to: '/compliance/dsar' },
          { label: 'Concentration Risk',  to: '/compliance/concentration' },
          { label: 'Data Processing Reg', to: '/compliance/dpa-register' },
          { label: 'SOC 2 Controls',      to: '/compliance/soc2' },
          { label: 'Pentest Tracker',     to: '/compliance/pentest' },
          { label: 'Policy Documents',    to: '/compliance/policies' },
          { label: 'Credit Bureau',       to: '/compliance/credit-bureau' },
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
      {
        icon: 'analytics', label: 'Reports & BI', to: '/reports',
        vis: ['bi_analyst','bi_head','compliance_head','finance_head'],
        subs: [
          { label: 'KPI Tracker',         to: '/reports/kpi' },
          { label: 'Analytics Dashboard', to: '/reports' },
          { label: 'CBN Complaints Report', to: '/reports/cbn-report' },
          { label: 'Data Export',         to: '/reports/export' },
          { label: 'Report Builder',      to: '/bi/builder' },
          { label: 'Saved Reports',       to: '/bi' },
          { label: 'Scheduled Reports',   to: '/bi/scheduled' },
        ],
      },
      {
        icon: 'receipt_long', label: 'Statements', to: '/statements',
        vis: ['bi_head','compliance_head','finance_officer','finance_head'],
        subs: [
          { label: 'Account Statements',     to: '/statements' },
          { label: 'Credit Card Statements', to: '/statements/credit-cards' },
        ],
      },
      {
        icon: 'account_balance', label: 'Core Banking', to: '/core-banking',
        vis: ['it_admin','finance_officer','finance_head'],
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
  '/mail/overview': 'mail', '/mail/inbox': 'mail', '/mail/sent': 'mail', '/mail/drafts': 'mail',
  '/marketing/overview': 'campaigns', '/campaigns': 'campaigns', '/campaigns/templates': 'campaigns',
  '/campaigns/lists': 'campaigns', '/contact-segments': 'campaigns', '/marketing/analytics': 'campaigns',
  '/sales/overview': 'sales', '/sales/book': 'crm_contacts', '/sales/leads': 'crm_contacts',
  '/sales/crm': 'crm_pipeline', '/sales/tasks': 'crm_tasks', '/sales/applications': 'loans',
  '/sales/targets': 'sales', '/sales/reports': 'crm_reports',
  // Contact Centre
  '/helpdesk': 'helpdesk', '/helpdesk/my-dashboard': 'helpdesk', '/helpdesk/tickets': 'helpdesk',
  '/helpdesk/calls': 'helpdesk', '/helpdesk/supervisor': 'helpdesk',
  '/helpdesk/knowledge-base': 'helpdesk', '/helpdesk/canned': 'helpdesk_canned',
  '/customers': 'customer360',
  '/call-center/queue': 'call_center', '/call-center/leads': 'call_center', '/call-center/dnc': 'call_center',
  '/call-center/inbound': 'call_center',
  '/call-center/performance': 'call_center_stats', '/call-center/agent-matching': 'call_center_stats',
  '/care': 'helpdesk', '/care/inbox': 'helpdesk', '/care/customers': 'customer360',
  '/care/knowledge-base': 'helpdesk', '/care/canned': 'helpdesk_canned',
  // Cards
  '/cards': 'cards', '/cards/my-queue': 'cards', '/cards/credit-portfolio': 'cards',
  '/cards/at-risk': 'cards', '/cards/cycle-import': 'cards', '/cards/trends': 'card_trends',
  '/cards/management': 'cards', '/cards/issuance': 'cards', '/cards/disputes': 'cards',
  '/cards/credit-limit': 'cards', '/cards/billing': 'cards', '/blink-card': 'blink_card',
  '/mobile-app': 'mobile_app',
  // Operations
  '/operations/risk': 'credit_portfolio', '/operations/risk/applications': 'credit_portfolio',
  '/operations/risk/portfolio': ['credit_portfolio', 'active_loan_book'], '/operations/risk/vintage': 'credit_portfolio',
  '/collections': 'collections', '/collections/portfolio': 'collections', '/collections/watchlist': 'collections',
  '/collections/queue': 'collections', '/collections/promises': 'collections',
  '/collections/repayment-plans': 'collections', '/collections/writeoffs': 'collections',
  '/collections/writeoff-requests': 'collections', '/collections/recovery-approvals': 'recovery',
  '/collections/activity-log': 'collections', '/collections-ops/agent': 'collections',
  '/recovery': 'recovery', '/recovery-ops/agent': 'recovery', '/recovery/cases': 'recovery',
  '/recovery/legal': 'recovery', '/recovery/activity-log': 'recovery', '/recovery/debt-sales': 'recovery',
  '/settlements': 'settlement',
  '/settlements/workbench': ['settlement', 'reconciliation'], '/settlements/exceptions': ['settlement', 'reconciliation'],
  '/settlements/position': ['settlement', 'reconciliation'], '/settlements/runs': ['settlement', 'reconciliation'],
  '/settlements/reconciliation': 'reconciliation', '/settlements/manual-postings': 'settlement',
  '/settlements/interswitch': ['settlement', 'cards'], '/settlements/interswitch/half-year': ['settlement', 'cards'],
  '/settlements/interswitch/import': ['settlement', 'cards'],
  // Finance
  '/finance': 'income', '/finance/transactions': 'transactions', '/finance/income': 'income',
  '/deposits': 'fixed_deposit', '/finance/eod': 'eod', '/finance/fx-rates': 'fx_rates',
  // Compliance
  '/compliance': 'watch_list', '/compliance/credit-audit-trail': 'audit_trail',
  '/compliance/watchlist': 'watch_list', '/compliance/regulatory': 'watch_list',
  '/compliance/findings': 'audit_findings', '/compliance/checklists': 'compliance_checklists',
  '/compliance/audit-trail': 'audit_trail', '/compliance/kyc-expiry': 'watch_list',
  '/compliance/aml-rules': 'watch_list', '/compliance/prudential': 'watch_list',
  '/compliance/dsar': 'watch_list', '/compliance/concentration': 'watch_list',
  '/compliance/dpa-register': 'watch_list', '/compliance/soc2': 'audit_trail',
  '/compliance/pentest': 'audit_trail', '/compliance/policies': 'compliance_checklists',
  '/compliance/credit-bureau': 'watch_list', '/compliance/breach-incidents': 'compliance_all',
  '/compliance/board-pack': 'compliance_all',
  // Analytics
  '/reports': 'reports', '/reports/kpi': 'reports', '/reports/cbn-report': 'reports',
  '/reports/export': 'reports', '/bi': 'reports', '/bi/builder': 'reports', '/bi/scheduled': 'reports',
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
        padding: '6px 14px 6px 40px',
        fontSize: 12, fontFamily: SORA,
        color: active ? '#7DD3FC' : 'rgba(255,255,255,.5)',
        borderLeft: active ? '3px solid #0EA5E9' : '3px solid transparent',
        textDecoration: 'none',
        transition: 'color .12s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = '#fff' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,.5)' }}
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
    fontSize: 12.5, fontFamily: SORA, fontWeight: 500,
    color: highlighted ? '#fff' : 'rgba(255,255,255,.66)',
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
      fontSize: 10, fontWeight: 600,
      letterSpacing: '.12em', textTransform: 'uppercase',
      color: 'rgba(255,255,255,.32)',
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
        fontSize: 10.5, fontWeight: 700, letterSpacing: '.11em', textTransform: 'uppercase',
        color: 'rgba(255,255,255,.42)', fontFamily: SORA, whiteSpace: 'nowrap',
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

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function Sidebar({ user, onLogout, utilities, onCmdK, enabledModules }: {
  user: AuthUser; onLogout: () => void; utilities?: ReactNode; onCmdK?: () => void
  enabledModules: Set<string>
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('o3c_sb') === '1')

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

  const [openKey, setOpenKey] = useState<string | null>(() => {
    for (const s of SECTIONS) {
      for (const item of s.items) {
        const subMatch = item.subs?.some(sub => sub.to !== '/' && pathname.startsWith(sub.to))
        if (subMatch || (item.to !== '/' && pathname.startsWith(item.to))) return item.to
      }
    }
    return null
  })

  useEffect(() => {
    localStorage.setItem('o3c_sb', collapsed ? '1' : '0')
  }, [collapsed])

  const roleSet = allRoles(user)

  // canOpen hides any nav entry whose route the user's pages don't grant, so the menu
  // shows only what actually opens (no items that would redirect). See makeCanOpen.
  const canOpen = makeCanOpen(user, roleSet)

  // root and admin sections always show; all others require the module to be enabled
  const sections = visibleSections(roleSet, canOpen).filter(s =>
    s.key === 'root' || s.key === 'admin' || enabledModules.has(s.key)
  )

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
        borderBottom: '1px solid rgba(255,255,255,.07)',
        justifyContent: collapsed ? 'center' : 'space-between',
        flexShrink: 0, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, overflow: 'hidden', minWidth: 0 }}>
          {/* L4: branding reads from VITE_ORG_NAME env var */}
          <img
            src="/o3-logo-transparent.svg"
            width={50} height={27}
            alt={import.meta.env.VITE_ORG_NAME ?? 'O3 Capital'}
            style={{ display: 'block', flexShrink: 0 }}
          />

          {!collapsed && (
            <div style={{ overflow: 'hidden', minWidth: 0 }}>
              <div style={{
                fontWeight: 700, fontSize: 13.5, color: '#fff',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontFamily: SORA, letterSpacing: '-0.2px', lineHeight: 1.15,
              }}>
                {import.meta.env.VITE_ORG_NAME ?? 'O3 Capital'}
              </div>
              <div style={{
                fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '1.4px', color: 'rgba(255,255,255,.28)',
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
        onClick={() => setCollapsed(c => !c)}
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
          color: 'rgba(255,255,255,.4)',
          transition: 'color 120ms',
          boxShadow: '2px 0 6px rgba(0,0,0,.2)',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#fff' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,.4)' }}
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
            borderRadius: 4, padding: '7px 10px',
            color: 'rgba(255,255,255,.45)', fontSize: 12,
            fontFamily: SORA, cursor: 'pointer', whiteSpace: 'nowrap',
            transition: 'border-color .12s, color .12s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(14,165,233,.5)'
            ;(e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,.7)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,.08)'
            ;(e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,.45)'
          }}
        >
          <IcoSearch size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
          <span style={{ flex: 1, textAlign: 'left' }}>Jump to…</span>
          <kbd style={{
            fontFamily: MONO, fontSize: 10,
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 3, padding: '1px 5px',
            color: 'rgba(255,255,255,.4)',
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
                    isActive={item.to === '/' ? pathname === '/' : item.subs?.length ? pathname === item.to : pathname.startsWith(item.to)}
                    hasActiveSub={item.subs?.some(s => s.to !== '/' && pathname.startsWith(s.to)) ?? false}
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
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: SORA }}>
                  {user.name}
                </div>
                <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.45)', whiteSpace: 'nowrap', fontFamily: SORA }}>
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
                  color: 'rgba(255,255,255,.35)', transition: 'color 120ms',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#fff' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,.35)' }}
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
                  color: 'rgba(255,255,255,.35)', transition: 'color 120ms',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#C00000' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,.35)' }}
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
