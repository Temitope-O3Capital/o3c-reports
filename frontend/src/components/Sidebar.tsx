import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation, Link, useNavigate } from 'react-router-dom'
import { roleLabel, MGMT } from '../lib/roles'
import { SORA, PLEX, MONO } from '../lib/design'
import { NAV_ICONS, IcoSearch } from '../lib/icons'
import type { AuthUser } from '../hooks/useAuth'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubItem { label: string; to: string; badge?: number }
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
        vis: ['sales_officer','sales_head','bd_officer','bd_head'],
        subs: [
          { label: 'All Leads',         to: '/bd/leads' },
          { label: 'My Pipeline',       to: '/bd/pipeline' },
          { label: 'Employer Register', to: '/bd/employers' },
          { label: 'BD Analytics',      to: '/bd/analytics' },
        ],
      },
      {
        icon: 'mark_email_read', label: 'Mail', to: '/mail/inbox',
        vis: ['sales_officer','sales_head','bd_officer','bd_head'],
        subs: [
          { label: 'Inbox',     to: '/mail/inbox' },
          { label: 'Sent Mail', to: '/mail/sent' },
          { label: 'Drafts',    to: '/mail/drafts' },
        ],
      },
      {
        icon: 'campaign', label: 'Campaigns & Marketing', to: '/campaigns',
        vis: ['sales_head','bd_officer','bd_head','telemarketing_head'],
        subs: [
          { label: 'All Campaigns',      to: '/campaigns' },
          { label: 'Templates',          to: '/campaigns/templates' },
          { label: 'Contact Lists',      to: '/campaigns/lists' },
          { label: 'Campaign Analytics', to: '/campaigns/analytics' },
          { label: 'Attribution Report', to: '/marketing/attribution' },
          { label: 'Acquisition Funnel', to: '/marketing/funnel' },
        ],
      },
      {
        icon: 'trending_up', label: 'Sales', to: '/sales',
        vis: ['sales_officer','sales_head'],
        subs: [
          { label: 'Overview',         to: '/sales' },
          { label: 'Cohort Analysis',  to: '/sales/cohort' },
          { label: 'Targets',          to: '/sales/targets' },
          { label: 'Reports',          to: '/sales/reports' },
          { label: 'All Applications', to: '/sales/applications' },
        ],
      },
      {
        icon: 'contacts', label: 'CRM', to: '/sales/crm',
        vis: ['sales_officer','sales_head','bd_officer','bd_head'],
        subs: [
          { label: 'Contacts', to: '/sales/customers' },
          { label: 'Pipeline', to: '/sales/crm' },
          { label: 'Tasks',    to: '/sales/tasks' },
        ],
      },
    ],
  },
  {
    key: 'contact',
    header: 'Contact Centre',
    items: [
      {
        icon: 'call', label: 'Telemarketing', to: '/telemarketing',
        vis: ['telemarketing_agent','telemarketing_head'],
        subs: [
          { label: 'Outbound Queue',    to: '/telemarketing/queue' },
          { label: 'Marketing Leads',   to: '/telemarketing/leads' },
          { label: 'DNC List',          to: '/telemarketing/dnc' },
          { label: 'Performance',       to: '/telemarketing/performance' },
          { label: 'Dialer Campaigns',  to: '/telemarketing/dialer' },
          { label: 'Dialer Agent View', to: '/telemarketing/dialer/agent' },
          { label: 'Dialer Supervisor', to: '/telemarketing/dialer/supervisor' },
        ],
      },
      {
        icon: 'support_agent', label: 'Customer Service', to: '/helpdesk',
        vis: [
          'call_center_agent','call_center_head',
          'telemarketing_agent','telemarketing_head',
          'sales_officer','sales_head','bd_officer','bd_head',
          'compliance_officer',
        ],
        subs: [
          { label: 'New Ticket',       to: '/helpdesk/new' },
          { label: 'All Tickets',      to: '/helpdesk/tickets' },
          { label: 'Call Log',         to: '/helpdesk/calls' },
          { label: 'Supervisor',       to: '/helpdesk/supervisor' },
          { label: 'Analytics',        to: '/helpdesk/stats' },
          { label: 'Knowledge Base',   to: '/helpdesk/knowledge-base' },
          { label: 'Canned Responses', to: '/helpdesk/canned' },
          { label: 'CBN Report',       to: '/helpdesk/cbn-report' },
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
          { label: 'Overview',            to: '/cards' },
          { label: 'Cardholder Mgmt',     to: '/cards/management' },
          { label: 'Issuance Queue',      to: '/cards/issuance' },
          { label: 'Disputes',            to: '/cards/disputes' },
          { label: 'Credit Limit Review', to: '/cards/credit-limit' },
          { label: 'Billing Cycles',      to: '/cards/billing' },
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
        vis: ['risk_officer','risk_head'],
        subs: [
          { label: 'App Review',       to: '/operations/risk/applications' },
          { label: 'Portfolio Health', to: '/operations/risk/portfolio' },
          { label: 'Eye Credit Score', to: '/operations/risk/eye' },
          { label: 'Vintage Analysis', to: '/operations/risk/vintage' },
          { label: 'Credit File',      to: '/operations/risk/credit-file' },
        ],
      },
      {
        icon: 'collections_bookmark', label: 'Collections', to: '/collections',
        vis: ['collections_agent','collections_head'],
        subs: [
          { label: 'Overview',        to: '/collections' },
          { label: 'Agent Queue',     to: '/collections/queue' },
          { label: 'Promises to Pay', to: '/collections/promises' },
          { label: 'Repayment Plans', to: '/collections/repayment-plans' },
          { label: 'Write-off Queue', to: '/collections/writeoffs' },
          { label: 'My Dashboard',    to: '/collections-ops/agent' },
        ],
      },
      {
        icon: 'gavel', label: 'Recovery', to: '/recovery',
        vis: ['recovery_agent','recovery_head'],
        subs: [
          { label: 'Overview',       to: '/recovery' },
          { label: 'Cases',          to: '/recovery/cases' },
          { label: 'Legal Tracker',  to: '/recovery/legal' },
          { label: 'TPA Management', to: '/recovery/tpa' },
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
        vis: ['finance_officer','finance_head'],
        subs: [
          { label: 'Overview',          to: '/finance' },
          { label: 'Transactions',      to: '/finance/transactions' },
          { label: 'Income',            to: '/finance/income' },
          { label: 'Fixed Deposits',    to: '/finance/fixed-deposit' },
          { label: 'FD Maturity',       to: '/finance/fd-maturity' },
          { label: 'EOD / EOB',         to: '/finance/eod' },
          { label: 'P&L',               to: '/finance/pnl' },
          { label: 'Manual Postings',   to: '/finance/manual-postings' },
          { label: 'Chart of Accounts', to: '/finance/gl-accounts' },
          { label: 'Cost Tracking',     to: '/finance/costs' },
          { label: 'Budget',            to: '/finance/budget' },
        ],
      },
      {
        icon: 'compare_arrows', label: 'Settlements', to: '/settlements',
        vis: ['settlement_officer','finance_head'],
        subs: [
          { label: 'Overview',                 to: '/settlements' },
          { label: 'Batches',                  to: '/settlements/batches' },
          { label: 'NIP Reconciliation',       to: '/settlements/nip' },
          { label: 'NIP Batch Exceptions',     to: '/settlements/nip-recon' },
          { label: 'Processor Reconciliation', to: '/settlements/reconciliation' },
          { label: 'Failed Transactions',      to: '/settlements/failed' },
          { label: 'Manual Postings',          to: '/settlements/manual-postings' },
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
        vis: ['hr_officer','hr_manager','payroll_officer','payroll_manager'],
      },
    ],
  },
  {
    key: 'analytics',
    header: 'Analytics',
    items: [
      {
        icon: 'analytics', label: 'Reports & BI', to: '/reports',
        vis: ['bi_analyst','bi_head','internal_control_head'],
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
        vis: ['bi_analyst','bi_head','internal_control_head','finance_officer','finance_head'],
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
  item, isActive, hasActiveSub, collapsed, open, onToggle,
}: {
  item: NavItem; isActive: boolean; hasActiveSub: boolean
  collapsed: boolean; open: boolean; onToggle: () => void
}) {
  const hasSubs     = !!item.subs?.length
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
        ? <Ico width={16} height={16} style={{ flexShrink: 0, opacity: 0.85 }} />
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
          {hasSubs && (
            <span style={{
              fontSize: 9, opacity: 0.5, flexShrink: 0,
              marginLeft: item.badge != null && item.badge > 0 ? 6 : 'auto',
              display: 'inline-block',
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform .15s',
              lineHeight: 1,
            }}>
              ▶
            </span>
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
        <div
          style={rowStyle}
          onClick={onToggle}
          onMouseEnter={e => handleHover(e.currentTarget as HTMLElement, true)}
          onMouseLeave={e => handleHover(e.currentTarget as HTMLElement, false)}
        >
          {content}
        </div>
        {!collapsed && (
          <div style={{
            overflow: 'hidden',
            maxHeight: open ? `${item.subs!.length * 34}px` : 0,
            transition: 'max-height .18s ease',
          }}>
            {item.subs!.map(sub => (
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

export default function Sidebar({ user, onLogout, utilities, onCmdK }: {
  user: AuthUser; onLogout: () => void; utilities?: ReactNode; onCmdK?: () => void
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('o3c_sb') === '1')

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

  const sections = visibleSections(user.role as string)

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
        display: 'flex', alignItems: 'center', gap: 10,
        padding: collapsed ? '16px 8px 14px' : '16px 14px 14px',
        borderBottom: '1px solid rgba(255,255,255,.08)',
        justifyContent: collapsed ? 'center' : undefined,
        flexShrink: 0, overflow: 'hidden',
      }}>
        {/* Brand mark — sky gradient matching demo */}
        <div style={{
          width: 28, height: 28, minWidth: 28, borderRadius: 4,
          background: 'linear-gradient(135deg,#0EA5E9,#0369A1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 13, color: '#fff', fontFamily: SORA,
        }}>
          O3
        </div>

        {!collapsed && (
          <>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#fff', whiteSpace: 'nowrap', fontFamily: SORA }}>
                O3 Capital
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,.45)', letterSpacing: '.04em', whiteSpace: 'nowrap', fontFamily: SORA }}>
                WORKSPACE
              </div>
            </div>
          </>
        )}
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
          <IcoSearch width={14} height={14} style={{ opacity: 0.6, flexShrink: 0 }} />
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
              background: '#2FB673',
              boxShadow: '0 0 0 3px rgba(47,182,115,.2)',
              display: 'inline-block', flexShrink: 0,
            }} />
            DB sync · live · recon OK
          </div>
        )}
      </div>
    </aside>
  )
}
