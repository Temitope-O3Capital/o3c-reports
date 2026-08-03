import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation, Link, useNavigate } from 'react-router-dom'
import { roleLabel, MGMT } from '../lib/roles'
import { SORA, PLEX, MONO } from '../lib/design'
import { NAV_ICONS, IcoSearch } from '../lib/icons'
import type { AuthUser } from '../hooks/useAuth'

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
      { icon: 'space_dashboard', label: 'Overview', to: '/', vis: 'all' },
    ],
  },
  {
    key: 'sales',
    header: 'Sales & BD',
    items: [
      {
        icon: 'corporate_fare', label: 'Business Dev', to: '/bd',
        vis: ['sales_officer','sales_head','head_sales','bd_officer','bd_head'],
        subs: [
          { label: 'My Dashboard',      to: '/bd/my-dashboard',  vis: ['bd_officer'] },
          { label: 'All Leads',         to: '/bd/leads' },
          { label: 'My Pipeline',       to: '/bd/pipeline' },
          { label: 'Employer Register', to: '/bd/employers' },
          { label: 'Assignments',       to: '/bd/assignments',   vis: ['bd_officer','bd_head'] },
          { label: 'Analytics',         to: '/bd/analytics',     vis: ['bd_head','sales_head','head_sales'] },
        ],
      },
      {
        icon: 'mark_email_read', label: 'Mail', to: '/mail/overview',
        vis: ['sales_officer','sales_head','head_sales','bd_officer','bd_head'],
        subs: [
          { label: 'Overview',  to: '/mail/overview' },
          { label: 'Inbox',     to: '/mail/inbox' },
          { label: 'Sent Mail', to: '/mail/sent' },
          { label: 'Drafts',    to: '/mail/drafts' },
          { label: 'Signature', to: '/mail/signature' },
        ],
      },
      {
        icon: 'campaign', label: 'Campaigns & Marketing', to: '/campaigns',
        vis: ['sales_head','head_sales','bd_officer','bd_head','telemarketing_head'],
        subs: [
          { label: 'All Campaigns',      to: '/campaigns' },
          { label: 'Templates',          to: '/campaigns/templates' },
          { label: 'Contact Lists',      to: '/campaigns/lists' },
          { label: 'Contact Segments',   to: '/contact-segments' },
          { label: 'Campaign Analytics', to: '/campaigns/analytics' },
          { label: 'Attribution Report', to: '/marketing/attribution' },
          { label: 'Acquisition Funnel', to: '/marketing/funnel' },
        ],
      },
      {
        icon: 'trending_up', label: 'Sales & CRM', to: '/sales/overview',
        vis: ['sales_officer','sales_head','head_sales'],
        subs: [
          { label: 'My Dashboard',     to: '/sales/my-dashboard',  vis: ['sales_officer'] },
          { label: 'My Accounts',      to: '/sales/accounts' },
          { label: 'Leads',            to: '/sales/customers' },
          { label: 'Pipeline',         to: '/sales/crm' },
          { label: 'Tasks',            to: '/sales/tasks' },
          { label: 'Cohort Analysis',  to: '/sales/cohort' },
          { label: 'Targets',          to: '/sales/targets' },
          { label: 'Reports',          to: '/sales/reports' },
          { label: 'All Applications', to: '/sales/applications' },
        ],
      },
    ],
  },
  {
    key: 'contact',
    header: 'Contact Centre',
    items: [
      {
        icon: 'headset_mic', label: 'Contact Centre', to: '/helpdesk',
        vis: ['call_center_agent','call_center_head','telemarketing_agent','telemarketing_head'],
        subs: [
          // agent dashboards — each role sees only their own
          { label: 'My Dashboard',     to: '/helpdesk/my-dashboard',      vis: ['call_center_agent'] },
          { label: 'My Dashboard',     to: '/telemarketing/dialer/agent',  vis: ['telemarketing_agent'] },
          // shared operational tools (both teams)
          { label: 'Customer Directory', to: '/customers' },
          { label: 'Ticket Queue',     to: '/helpdesk/tickets' },
          { label: 'Call Log',         to: '/helpdesk/calls' },
          { label: 'Outbound Queue',   to: '/telemarketing/queue' },
          { label: 'Marketing Leads',  to: '/telemarketing/leads' },
          { label: 'DNC List',         to: '/telemarketing/dnc' },
          // leadership — supervisor manages day-to-day for both teams
          { label: 'Dialer Campaigns', to: '/telemarketing/dialer',       vis: ['call_center_head','telemarketing_head'] },
          { label: 'Performance',      to: '/telemarketing/performance',  vis: ['call_center_head','telemarketing_head'] },
          { label: 'Supervisor View',  to: '/helpdesk/supervisor',        vis: ['telemarketing_head'] },
          { label: 'CBN Report',       to: '/helpdesk/cbn-report',        vis: ['call_center_head'] },
          // shared resources
          { label: 'Knowledge Base',   to: '/helpdesk/knowledge-base' },
          { label: 'Canned Responses', to: '/helpdesk/canned' },
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
        vis: ['cards_ops_officer','cards_ops_head','risk_officer','risk_head'],
        subs: [
          { label: 'My Queue',            to: '/cards/my-queue', vis: ['cards_ops_officer'] },
          { label: 'Credit Card Portfolio', to: '/cards/credit-portfolio' },
          { label: 'Card Trends',         to: '/cards/trends' },
          { label: 'Cardholder Mgmt',     to: '/cards/management' },
          { label: 'Issuance Queue',      to: '/cards/issuance' },
          { label: 'Disputes',            to: '/cards/disputes' },
          { label: 'Credit Limit Review', to: '/cards/credit-limit' },
          { label: 'Billing Cycles',      to: '/cards/billing' },
          { label: 'Blink Card',          to: '/blink-card', vis: ['cards_ops_officer','cards_ops_head'] },
        ],
      },
      {
        icon: 'smartphone', label: 'Mobile App', to: '/mobile-app',
        vis: ['cards_ops_head','finance_head','head_ops'],
      },
    ],
  },
  {
    key: 'deposits',
    header: 'Fixed Deposits',
    items: [
      {
        icon: 'savings', label: 'Fixed Deposits', to: '/deposits',
        vis: ['finance_officer','finance_head','head_of_reconciliation','head_ops'],
        subs: [
          { label: 'Dashboard',    to: '/deposits' },
          { label: 'Deposit Book', to: '/finance/fixed-deposit' },
          { label: 'Maturity',     to: '/finance/fd-maturity' },
          { label: 'Accruals',     to: '/finance/fd-accrual' },
        ],
      },
    ],
  },
  {
    key: 'lending',
    header: 'Credit Management',
    items: [
      {
        icon: 'shield', label: 'Risk', to: '/operations/risk',
        vis: ['risk_officer','risk_head','finance_officer','finance_head','collections_head','head_collections'],
        subs: [
          { label: 'Overview',         to: '/operations/risk',              vis: ['risk_officer','risk_head'] },
          { label: 'App Review',       to: '/operations/risk/applications', vis: ['risk_officer','risk_head'] },
          { label: 'Portfolio',        to: '/operations/risk/portfolio' },
          { label: 'Vintage Analysis', to: '/operations/risk/vintage',      vis: ['risk_officer','risk_head'] },
        ],
      },
      {
        icon: 'collections_bookmark', label: 'Collections', to: '/collections',
        vis: ['collections_agent','collections_head','head_collections'],
        subs: [
          { label: 'Credit Portfolio',     to: '/collections/portfolio' },
          { label: 'Watchlist',            to: '/collections/watchlist' },
          { label: 'Agent Queue',          to: '/collections/queue' },
          { label: 'Promises to Pay',      to: '/collections/promises' },
          { label: 'Repayment Plans',      to: '/collections/repayment-plans' },
          { label: 'Write-off Queue',      to: '/collections/writeoffs' },
          { label: 'Write-off Requests',   to: '/collections/writeoff-requests' },
          { label: 'Recovery Approvals',   to: '/collections/recovery-approvals' },
          { label: 'Activity Log',         to: '/collections/activity-log', vis: ['collections_head','head_collections'] },
          { label: 'My Dashboard',         to: '/collections-ops/agent', vis: ['collections_agent'] },
        ],
      },
      {
        icon: 'gavel', label: 'Recovery', to: '/recovery',
        vis: ['recovery_agent','recovery_head','head_recovery'],
        subs: [
          { label: 'My Dashboard',   to: '/recovery-ops/agent', vis: ['recovery_agent'] },
          { label: 'Cases',          to: '/recovery/cases' },
          { label: 'Legal Tracker',  to: '/recovery/legal' },
          { label: 'Activity Log',   to: '/recovery/activity-log', vis: ['recovery_head','head_recovery'] },
          { label: 'Debt Sales',     to: '/recovery/debt-sales' },
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
        vis: ['finance_officer','finance_head','head_of_reconciliation'],
        subs: [
          { label: 'Transactions',      to: '/finance/transactions' },
          { label: 'Income',            to: '/finance/income' },
          { label: 'EOD / EOB',         to: '/finance/eod' },
          { label: 'P&L',               to: '/finance/pnl' },
          { label: 'Manual Postings',   to: '/finance/manual-postings' },
          { label: 'Chart of Accounts', to: '/finance/gl-accounts' },
          { label: 'Cost Tracking',     to: '/finance/costs' },
          { label: 'Budget',            to: '/finance/budget' },
          { label: 'FX Parallel Rates', to: '/finance/fx-rates' },
        ],
      },
      {
        icon: 'compare_arrows', label: 'Settlements', to: '/settlements',
        vis: ['settlement_officer','finance_head','head_of_reconciliation'],
        subs: [
          { label: 'Batches',                  to: '/settlements/batches' },
          { label: 'NIP Reconciliation',       to: '/settlements/nip' },
          { label: 'NIP Batch Exceptions',     to: '/settlements/nip-recon' },
          { label: 'Processor Reconciliation', to: '/settlements/reconciliation' },
          { label: 'Failed Transactions',      to: '/settlements/failed' },
          { label: 'Manual Postings',          to: '/settlements/manual-postings' },
          { label: 'Interswitch',              to: '/settlements/interswitch' },
          { label: 'Transaction Report',       to: '/settlements/interswitch/half-year' },
          { label: 'Import EODTXN',            to: '/settlements/interswitch/import', vis: ['cards_ops_head'] },
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
        vis: ['compliance_officer','compliance_head','internal_control_head'],
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
    key: 'people',
    header: 'People',
    items: [
      {
        icon: 'badge', label: 'HR', to: '/hr',
        vis: ['hr_officer','hr_manager'],
        subs: [
          { label: 'Employees',    to: '/hr/employees' },
          { label: 'Leave',        to: '/hr/leave' },
          { label: 'Performance',  to: '/hr/performance' },
          { label: 'Disciplinary', to: '/hr/disciplinary' },
          { label: 'Training',     to: '/hr/training' },
          { label: 'Recruitment',  to: '/hr/recruitment' },
          { label: 'Org Chart',    to: '/hr/org-chart' },
        ],
      },
      {
        icon: 'payments', label: 'Payroll', to: '/payroll',
        vis: ['hr_manager','payroll_officer','payroll_manager'],
      },
    ],
  },
  {
    key: 'analytics',
    header: 'Analytics',
    items: [
      {
        icon: 'analytics', label: 'Reports & BI', to: '/reports',
        vis: ['internal_control_head','finance_head'],
        subs: [
          { label: 'KPI Tracker',         to: '/reports/kpi' },
          { label: 'Analytics Dashboard', to: '/reports' },
          { label: 'Data Export',         to: '/reports/export' },
          { label: 'Report Builder',      to: '/bi/builder' },
          { label: 'Saved Reports',       to: '/bi' },
          { label: 'Scheduled Reports',   to: '/bi/scheduled' },
        ],
      },
      {
        icon: 'receipt_long', label: 'Statements', to: '/statements',
        vis: ['internal_control_head','finance_officer','finance_head','head_of_reconciliation'],
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

// ── Role visibility ───────────────────────────────────────────────────────────


function canSee(vis: NavItem['vis'], role: string): boolean {
  if (MGMT.has(role))  return true
  if (vis === 'all')   return true
  if (!vis)            return false
  return (vis as string[]).includes(role)
}

function canSeeSub(vis: string[] | undefined, role: string): boolean {
  if (!vis) return true
  if (MGMT.has(role)) return true
  return vis.includes(role)
}

function visibleSections(role: string): Section[] {
  return SECTIONS
    .map(s => ({ ...s, items: s.items.filter(item => canSee(item.vis, role)) }))
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
  item, isActive, hasActiveSub, collapsed, open, onToggle, role,
}: {
  item: NavItem; isActive: boolean; hasActiveSub: boolean
  collapsed: boolean; open: boolean; onToggle: () => void; role: string
}) {
  const visibleSubs = item.subs?.filter(s => canSeeSub(s.vis, role)) ?? []
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

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function Sidebar({ user, onLogout, utilities, onCmdK, enabledModules }: {
  user: AuthUser; onLogout: () => void; utilities?: ReactNode; onCmdK?: () => void
  enabledModules: Set<string>
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('o3c_sb') === '1')

  // M4: Poll /api/health every 60 s to reflect actual MSSQL connection status.
  const [mssqlStatus, setMssqlStatus] = useState<'online' | 'offline' | 'not_configured' | null>(null)
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const token = localStorage.getItem('o3c_token')
        const res = await fetch('/api/health', token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
        const json = await res.json()
        if (!cancelled) setMssqlStatus(json.mssql ?? 'not_configured')
      } catch { if (!cancelled) setMssqlStatus('offline') }
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

  // root and admin sections always show; all others require the module to be enabled
  const sections = visibleSections(user.role as string).filter(s =>
    s.key === 'root' || s.key === 'admin' || enabledModules.has(s.key)
  )

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
        {sections.map((section, i) => (
          <div key={section.key}>
            {(section.header || i > 0) && (
              <SectionHeader label={section.header} collapsed={collapsed} />
            )}
            {section.items.map(item => (
              <NavRow
                key={item.to}
                item={item}
                role={user.role as string}
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
              background: mssqlStatus === 'online' ? '#2FB673' : mssqlStatus === 'offline' ? '#C00000' : '#888',
              boxShadow: mssqlStatus === 'online' ? '0 0 0 3px rgba(47,182,115,.2)' : undefined,
              display: 'inline-block', flexShrink: 0,
            }} />
            {mssqlStatus === 'online' ? 'MSSQL · live' : mssqlStatus === 'offline' ? 'MSSQL · offline' : mssqlStatus === 'not_configured' ? 'MSSQL · not configured' : 'MSSQL · checking…'}
          </div>
        )}
      </div>
    </aside>
  )
}
