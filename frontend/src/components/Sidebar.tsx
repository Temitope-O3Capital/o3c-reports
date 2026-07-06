import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useLocation, Link, useNavigate } from 'react-router-dom'
import { roleLabel } from '../lib/roles'
import { INTER } from '../lib/design'
import type { AuthUser } from '../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubItem { label: string; to: string }
interface NavItem {
  icon:  string
  label: string
  to:    string
  subs?: SubItem[]
  vis?:  string[] | 'all'
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
          { label: 'Inbox',   to: '/mail/inbox' },
          { label: 'Compose', to: '/mail/compose' },
        ],
      },
      // Campaigns + Marketing attribution merged — same function, same audience
      {
        icon: 'campaign', label: 'Campaigns & Marketing', to: '/campaigns',
        vis: ['sales_head','bd_officer','bd_head','telemarketing_head'],
        subs: [
          { label: 'All Campaigns',        to: '/campaigns' },
          { label: 'Templates',            to: '/campaigns/templates' },
          { label: 'Contact Lists',        to: '/campaigns/lists' },
          { label: 'Campaign Analytics',   to: '/campaigns/analytics' },
          { label: 'Attribution Report',   to: '/marketing/attribution' },
          { label: 'Acquisition Funnel',   to: '/marketing/funnel' },
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
        ],
        subs: [
          { label: 'All Tickets',      to: '/helpdesk/tickets' },
          { label: 'Call Log',         to: '/helpdesk/calls' },
          { label: 'Supervisor',       to: '/helpdesk/supervisor' },
          { label: 'Analytics',        to: '/helpdesk/stats' },
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
    // Renamed from "Operations" — Settlements moved to Finance; this is now purely lending lifecycle
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
          { label: 'EOD / EOB',         to: '/finance/eod' },
          { label: 'P&L',               to: '/finance/pnl' },
          { label: 'Manual Postings',   to: '/finance/manual-postings' },
          { label: 'Chart of Accounts', to: '/finance/gl-accounts' },
          { label: 'Cost Tracking',     to: '/finance/costs' },
          { label: 'Budget',            to: '/finance/budget' },
        ],
      },
      // Settlements moved here from Loan Management — it is a financial back-office function
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
          { label: 'SOC 2 Controls',       to: '/compliance/soc2'         },
          { label: 'Pentest Tracker',      to: '/compliance/pentest'      },
          { label: 'Policy Documents',     to: '/compliance/policies'     },
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
    // Reports & BI and BI Studio merged — same function, same roles, no reason to split
    key: 'analytics',
    header: 'Analytics',
    items: [
      {
        icon: 'analytics', label: 'Reports & BI', to: '/reports',
        vis: ['bi_analyst','bi_head','internal_control_head'],
        subs: [
          { label: 'KPI Tracker',          to: '/reports/kpi' },
          { label: 'Analytics Dashboard',  to: '/reports' },
          { label: 'Data Export',          to: '/reports/export' },
          { label: 'Report Builder',       to: '/bi/builder' },
          { label: 'Saved Reports',        to: '/bi' },
          { label: 'Scheduled Reports',    to: '/bi/scheduled' },
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
      // Admin uses a grid/tile overview page for sub-module navigation — no sidebar sub-items needed
      {
        icon: 'admin_panel_settings', label: 'System Admin', to: '/admin',
        vis: ['it_admin'],
      },
    ],
  },
]

// ── Role visibility ───────────────────────────────────────────────────────────

const MGMT = new Set([
  'md','coo','cfo','cmo','executive','admin','management','head_ops','head_it','head_hr',
])

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
        display: 'flex', alignItems: 'center', gap: 8,
        height: 32, padding: '0 9px 0 10px',
        margin: '2px 0', borderRadius: 6,
        textDecoration: 'none',
        color: active ? 'var(--sub-act)' : 'var(--sub-txt)',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        background: active ? 'rgba(0,0,0,.02)' : 'transparent',
        transition: 'color 120ms, background 120ms',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        if (!active) {
          el.style.background = 'var(--nav-hvr-bg)'
          el.style.color = 'var(--sub-hvr)'
        }
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = active ? 'rgba(0,0,0,.02)' : 'transparent'
        el.style.color = active ? 'var(--sub-act)' : 'var(--sub-txt)'
      }}
    >
      {/* 1px vertical line indicator — matches demo */}
      <div style={{
        width: 1, height: 14, flexShrink: 0, borderRadius: 1,
        background: active ? 'var(--nav-dot)' : 'var(--bdr)',
        transition: 'background 120ms',
      }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {sub.label}
      </span>
    </Link>
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

  return (
    <div>
      <Link
        to={hasSubs ? '#' : item.to}
        onClick={hasSubs ? (e) => { e.preventDefault(); onToggle() } : undefined}
        title={collapsed ? item.label : undefined}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 36,
          margin: '2px 7px',
          borderRadius: 8,
          padding: collapsed ? '0' : '0 9px 0 12px',
          justifyContent: collapsed ? 'center' : undefined,
          textDecoration: 'none',
          background: highlighted ? 'var(--nav-act-bg)' : 'transparent',
          color: highlighted ? 'var(--nav-act-txt)' : 'var(--nav-txt)',
          fontSize: 13.5,
          fontWeight: highlighted ? 600 : 500,
          transition: 'background 120ms, color 120ms',
          userSelect: 'none',
        }}
        onMouseEnter={e => {
          if (!highlighted) {
            (e.currentTarget as HTMLElement).style.background = 'var(--nav-hvr-bg)'
            ;(e.currentTarget as HTMLElement).style.color = 'var(--nav-hvr-txt)'
          }
        }}
        onMouseLeave={e => {
          if (!highlighted) {
            (e.currentTarget as HTMLElement).style.background = 'transparent'
            ;(e.currentTarget as HTMLElement).style.color = 'var(--nav-txt)'
          }
        }}
      >
        {/* Active indicator bar on left edge */}
        {highlighted && (
          <div style={{
            position: 'absolute', left: -7, top: '50%', transform: 'translateY(-50%)',
            width: 3, height: 16, background: 'var(--nav-dot)',
            borderRadius: '0 3px 3px 0',
          }} />
        )}

        <span
          className="material-symbols-rounded"
          style={{ fontSize: 18, flexShrink: 0 }}
        >
          {item.icon}
        </span>

        {!collapsed && (
          <>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
            {hasSubs && (
              <span
                className="material-symbols-rounded"
                style={{
                  fontSize: 13, flexShrink: 0,
                  color: 'var(--grp)',
                  transform: open ? 'rotate(180deg)' : 'none',
                  transition: 'transform 200ms',
                }}
              >
                expand_more
              </span>
            )}
          </>
        )}
      </Link>

      {/* Accordion sub-items */}
      {hasSubs && !collapsed && (
        <div style={{
          overflow: 'hidden',
          maxHeight: open ? `${item.subs!.length * 34 + 8}px` : 0,
          transition: 'max-height 220ms ease',
          padding: '0 7px 0 16px',
        }}>
          {item.subs!.map(sub => (
            <SubLink key={sub.to} sub={sub} active={pathname === sub.to} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label, collapsed }: { label?: string; collapsed: boolean }) {
  if (!label) return null
  if (collapsed) return <div style={{ height: 8 }} />
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '1px', color: 'var(--grp)',
      padding: '12px 14px 4px', fontFamily: INTER,
    }}>
      {label}
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function Sidebar({ user, onLogout, utilities }: { user: AuthUser; onLogout: () => void; utilities?: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('o3c_sb') === '1')

  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const open = new Set<string>()
    SECTIONS.forEach(s =>
      s.items.forEach(item => {
        const subMatch = item.subs?.some(sub => sub.to !== '/' && pathname.startsWith(sub.to))
        if (subMatch || (item.to !== '/' && pathname.startsWith(item.to))) open.add(item.to)
      })
    )
    return open
  })

  useEffect(() => {
    localStorage.setItem('o3c_sb', collapsed ? '1' : '0')
  }, [collapsed])

  const sections = visibleSections(user.role as string)

  function toggleItem(to: string) {
    setOpenKeys(prev => {
      const next = new Set(prev)
      next.has(to) ? next.delete(to) : next.add(to)
      return next
    })
  }

  const initials = user.name
    .split(' ')
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const W = collapsed ? 60 : 252

  return (
    <aside style={{
      width: W, minWidth: W,
      display: 'flex', flexDirection: 'column',
      height: '100vh', flexShrink: 0,
      background: 'var(--sb)',
      borderRight: '1px solid var(--sb-bdr)',
      overflow: 'visible',
      transition: 'width 240ms cubic-bezier(0.4,0,0.2,1), min-width 240ms cubic-bezier(0.4,0,0.2,1)',
      position: 'relative', zIndex: 10,
    }}>

      {/* ── Logo row ──────────────────────────────────────────────────────── */}
      <div style={{
        height: 50, flexShrink: 0,
        display: 'flex', alignItems: 'center',
        padding: collapsed ? '0 14px' : '0 14px',
        gap: 9,
        borderBottom: '1px solid var(--sb-bdr)',
        justifyContent: collapsed ? 'center' : undefined,
      }}>
        {/* O3 box logo */}
        <div style={{
          width: 28, height: 28, borderRadius: 7,
          background: '#C00000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 800, color: '#fff',
          flexShrink: 0, fontFamily: INTER,
        }}>
          O3
        </div>

        {!collapsed && (
          <>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: '#FFFFFF', letterSpacing: -0.4, whiteSpace: 'nowrap' }}>
              O3 <span style={{ color: '#C00000' }}>Capital</span>
            </div>
            <div style={{
              marginLeft: 'auto', fontSize: 8.5, fontWeight: 700, letterSpacing: 0.5,
              color: 'rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.10)',
              padding: '2px 6px', borderRadius: 4, fontFamily: INTER, whiteSpace: 'nowrap',
            }}>
              WORKSPACE
            </div>
          </>
        )}
      </div>

      {/* Floating collapse tab — sits on the right edge of the sidebar */}
      <div
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{
          position: 'absolute', right: -12, top: '50%', transform: 'translateY(-50%)',
          width: 20, height: 40,
          background: 'var(--sb)',
          border: '1px solid var(--sb-bdr)',
          borderLeft: 'none',
          borderRadius: '0 8px 8px 0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 20,
          color: 'var(--nav-txt)',
          transition: 'background 120ms, color 120ms',
          boxShadow: '2px 0 6px rgba(0,0,0,.15)',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.background = 'var(--nav-hvr-bg)'
          ;(e.currentTarget as HTMLElement).style.color = '#fff'
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.background = 'var(--sb)'
          ;(e.currentTarget as HTMLElement).style.color = 'var(--nav-txt)'
        }}
      >
        <span className="material-symbols-rounded" style={{
          fontSize: 13,
          transform: collapsed ? 'none' : 'rotate(180deg)',
          transition: 'transform 240ms cubic-bezier(0.4,0,0.2,1)',
        }}>
          chevron_right
        </span>
      </div>

      {/* ── Nav ────────────────────────────────────────────────────────────── */}
      <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '6px 0 12px' }}>
        {sections.map((section, i) => (
          <div key={section.key} style={{ marginBottom: 4 }}>
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
                open={openKeys.has(item.to)}
                onToggle={() => toggleItem(item.to)}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* ── User footer ────────────────────────────────────────────────────── */}
      <div style={{
        flexShrink: 0,
        borderTop: '1px solid var(--sb-bdr)',
        padding: collapsed ? '8px 7px 6px' : '8px 7px 6px',
      }}>
        {/* Utility buttons (C360, approvals, notifications, theme) */}
        {utilities && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexWrap: 'wrap', gap: 2, padding: '2px 2px 6px',
          }}>
            {utilities}
          </div>
        )}
        {/* User row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px 2px',
          borderTop: '1px solid var(--sb-bdr)', marginTop: 4,
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0, fontFamily: INTER,
          }}>
            {initials}
          </div>

          {!collapsed && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--nav-act-txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.name}
                </div>
                <div style={{ fontSize: 9.5, color: 'var(--nav-txt)', fontFamily: INTER }}>
                  {roleLabel(user.role as string)}
                </div>
              </div>

              <button
                onClick={() => navigate('/settings')}
                title="Settings & Security"
                style={{
                  width: 24, height: 24, borderRadius: 6, border: 'none',
                  background: 'transparent', cursor: 'pointer', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--txt3)', transition: 'color 120ms',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#fff' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--txt3)' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 17 }}>settings</span>
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
