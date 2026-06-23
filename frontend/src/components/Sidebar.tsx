import { useState } from 'react'
import { NavLink, useLocation, useNavigate, Link } from 'react-router-dom'
import { AuthUser } from '../hooks/useAuth'
import { roleLabel } from '../lib/roles'

// ── Role helpers ──────────────────────────────────────────────────────────────

const MGMT = ['md', 'coo', 'cfo', 'cmo', 'executive', 'admin', 'management', 'head_ops', 'head_it']

function hasAccess(role: string, moduleRoles: string[]): boolean {
  return MGMT.includes(role) || moduleRoles.includes(role)
}

// ── Nav data types ────────────────────────────────────────────────────────────

interface SubItem {
  label:   string
  to:      string
  icon:    string
  header?: boolean  // if true, renders as a section label, not a nav link
}

interface Module {
  id:    string
  label: string
  icon:  string
  roles: string[]    // non-management roles that can see this module
  items: SubItem[]   // empty means single-page (no sub-items)
}

// ── Module definitions ────────────────────────────────────────────────────────

const MODULES: Module[] = [
  {
    id: 'overview', label: 'Overview', icon: 'dashboard',
    roles: [],  // management only — hasAccess handles this via MGMT check
    items: [],
  },
  {
    id: 'sales', label: 'Sales', icon: 'trending_up',
    roles: ['sales_officer', 'sales_head'],
    items: [
      { label: 'Customers',    to: '/sales/customers',    icon: 'people' },
      { label: 'CRM Pipeline', to: '/sales/crm',          icon: 'account_tree' },
      { label: 'Applications', to: '/sales/applications', icon: 'description' },
    ],
  },
  {
    id: 'risk', label: 'Risk & Credit', icon: 'shield',
    roles: ['risk_officer', 'risk_head'],
    items: [
      { label: 'App Review', to: '/risk/applications',   icon: 'rate_review' },
      { label: 'Portfolio',  to: '/risk/portfolio',      icon: 'pie_chart' },
    ],
  },
  {
    id: 'finance', label: 'Finance', icon: 'account_balance',
    roles: ['finance_officer', 'finance_head', 'cfo', 'head_of_reconciliation'],
    items: [
      { label: 'Transactions',   to: '/finance/transactions',   icon: 'receipt_long' },
      { label: 'Income',         to: '/finance/income',         icon: 'trending_up' },
      { label: 'Fixed Deposits', to: '/finance/fixed-deposit',  icon: 'savings' },
      { label: 'EOD/EOB',        to: '/finance/eod',            icon: 'event_available' },
    ],
  },
  {
    id: 'collections', label: 'Collections', icon: 'payments',
    roles: ['collections_agent', 'collections_head'],
    items: [
      { label: 'Agent Queue',     to: '/collections/queue',    icon: 'format_list_bulleted' },
      { label: 'Targets',         to: '/collections/targets',  icon: 'flag' },
      { label: 'Promise-to-Pay',  to: '/collections/promises', icon: 'handshake' },
    ],
  },
  {
    id: 'recovery', label: 'Recovery', icon: 'refresh',
    roles: ['recovery_agent', 'recovery_head'],
    items: [
      { label: 'Cases',        to: '/recovery/cases',   icon: 'folder_open' },
      { label: 'Legal',        to: '/recovery/legal',   icon: 'gavel' },
      { label: 'Field Visits', to: '/recovery/visits',  icon: 'directions_car' },
    ],
  },
  {
    id: 'settlements', label: 'Settlements', icon: 'compare_arrows',
    roles: ['finance_head', 'cfo', 'head_of_reconciliation'],
    items: [
      { label: 'Settlement',     to: '/settlements',       icon: 'payments' },
      { label: 'Reconciliation', to: '/settlements/recon', icon: 'balance' },
    ],
  },
  {
    id: 'cards', label: 'Cards & Channels', icon: 'credit_card',
    roles: ['cards_ops_officer', 'cards_ops_head'],
    items: [
      { label: 'Trends',      to: '/cards/trends',      icon: 'show_chart' },
      { label: 'Management',  to: '/cards/management',  icon: 'manage_accounts' },
      { label: 'Blink Card',  to: '/cards/blink',       icon: 'contactless' },
      { label: 'Mobile App',  to: '/cards/mobile-app',  icon: 'smartphone' },
    ],
  },
  {
    id: 'helpdesk', label: 'Helpdesk', icon: 'support_agent',
    roles: [
      'call_center_agent', 'call_center_head',
      'collections_agent', 'collections_head',
      'recovery_agent',    'recovery_head',
      'cards_ops_officer', 'cards_ops_head',
      'sales_officer',     'sales_head',
      'risk_officer',      'risk_head',
      'finance_officer',   'finance_head',
      'hr_officer',        'hr_manager',
      'compliance_officer','compliance_head',
      'it_admin',          'head_it',
      'md', 'coo', 'cfo', 'cmo', 'management', 'admin',
    ],
    items: [
      { label: 'Overview',         to: '/helpdesk',            icon: 'dashboard' },
      { label: 'All Tickets',      to: '/helpdesk/tickets',    icon: 'confirmation_number' },
      { label: 'Call Log',         to: '/helpdesk/calls',      icon: 'call' },
      { label: 'Analytics',        to: '/helpdesk/stats',      icon: 'bar_chart' },
      { label: 'Canned Responses', to: '/helpdesk/canned',     icon: 'quickreply' },
    ],
  },
  {
    id: 'compliance', label: 'Compliance', icon: 'policy',
    roles: ['compliance_officer', 'compliance_head', 'internal_control_head'],
    items: [
      { label: 'AML Watchlist',to: '/compliance/watchlist',     icon: 'security' },
      { label: 'SAR Filing',   to: '/compliance/sars',          icon: 'report' },
      { label: 'CBN Reports',  to: '/compliance/cbn-reports',   icon: 'article' },
      { label: 'Findings',     to: '/compliance/findings',      icon: 'search' },
      { label: 'Checklists',   to: '/compliance/checklists',    icon: 'checklist' },
      { label: 'Audit Trail',  to: '/compliance/audit-trail',   icon: 'history' },
    ],
  },
  {
    id: 'hr', label: 'HR', icon: 'groups',
    roles: ['hr_officer', 'hr_manager'],
    items: [
      { label: 'Employees',     to: '/hr/employees',     icon: 'badge' },
      { label: 'Leave',         to: '/hr/leave',         icon: 'event_available' },
      { label: 'Performance',   to: '/hr/performance',   icon: 'star' },
      { label: 'Disciplinary',  to: '/hr/disciplinary',  icon: 'warning' },
      { label: 'Training',      to: '/hr/training',      icon: 'school' },
    ],
  },
  {
    id: 'campaigns', label: 'Campaigns', icon: 'campaign',
    roles: ['cmo', 'md', 'coo', 'management', 'admin'],
    items: [
      { label: 'Overview',      to: '/campaigns/overview',     icon: 'bar_chart' },
      { label: 'Campaigns',     to: '/campaigns',              icon: 'send' },
      { label: 'Analytics',     to: '/campaigns/analytics',    icon: 'insights' },
      { label: 'Templates',     to: '/campaigns/templates',    icon: 'article' },
      { label: 'Contact Lists', to: '/campaigns/lists',        icon: 'list_alt' },
      { label: 'Email Senders', to: '/admin/email-senders',    icon: 'alternate_email' },
    ],
  },
  {
    id: 'reports', label: 'Reports', icon: 'bar_chart',
    roles: [
      'sales_head', 'risk_head', 'finance_head', 'collections_head',
      'recovery_head', 'cards_ops_head', 'call_center_head', 'compliance_head',
      'internal_control_head', 'hr_manager',
    ],
    items: [],
  },
  {
    id: 'admin', label: 'Admin', icon: 'admin_panel_settings',
    roles: ['it_admin', 'head_it'],
    items: [
      // Users & Access
      { label: 'Overview',             to: '/admin/overview',              icon: 'dashboard' },
      { label: 'Users',                to: '/admin/users',                 icon: 'manage_accounts' },
      { label: 'Roles',                to: '/admin/roles',                 icon: 'lock_person' },
      // Communications
      { label: 'Email Senders',        to: '/admin/email-senders',         icon: 'alternate_email' },
      { label: 'Mail Health',          to: '/admin/mail',                  icon: 'mark_email_read' },
      { label: 'Notif. Settings',      to: '/admin/notification-settings', icon: 'notifications_active' },
      // Integrations
      { label: 'API Keys',             to: '/admin/api-keys',              icon: 'key' },
      { label: 'Connected Services',   to: '/admin/integrations',          icon: 'hub' },
      // Platform
      { label: 'Settings',             to: '/admin/settings',              icon: 'settings' },
      { label: 'Audit Log',            to: '/admin/audit',                 icon: 'history' },
      { label: 'Sync Status',          to: '/admin/sync',                  icon: 'sync' },
    ],
  },
]

// Module → primary route (clicking the section header navigates here)
const MODULE_PRIMARY: Record<string, string> = {
  overview:         '/',
  reports:          '/reports',
  sales:            '/sales',
  risk:             '/risk',
  finance:          '/finance',
  collections:      '/collections',
  recovery:         '/recovery',
  cards:            '/cards',
  'customer-service': '/customer-service',
  compliance:       '/compliance',
  hr:               '/hr',
  settlements:      '/settlements',
  campaigns:        '/campaigns',
  helpdesk:         '/helpdesk',
  los:              '/los',
  crm:              '/crm',
  admin:            '/admin/overview',
}

function primaryRoute(mod: Module): string {
  return MODULE_PRIMARY[mod.id] ?? (mod.items[0]?.to ?? '/')
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const NAVY   = '#0E2841'
const ACCENT = '#C00000'
const IDLE_TEXT   = 'rgba(255,255,255,0.58)'
const IDLE_ICON   = 'rgba(255,255,255,0.38)'
const ACTIVE_TEXT = '#ffffff'

// ── Sub-item nav link ─────────────────────────────────────────────────────────

function SubNavItem({ label, to, icon, header }: SubItem) {
  // Section header: render as small uppercase label, no link behaviour
  if (header) {
    return (
      <div className="px-3 pt-3 pb-0.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em]"
          style={{ color: 'rgba(255,255,255,0.25)' }}>
          {label.replace(/^— | —$/g, '')}
        </span>
      </div>
    )
  }

  return (
    <NavLink to={to} end>
      {({ isActive }) => (
        <span
          className={`flex items-center gap-2 py-[6px] text-[12.5px] cursor-pointer w-full transition-colors rounded-r-lg ${!isActive ? 'hover:bg-white/[0.07]' : ''}`}
          style={{
            marginLeft:  '-1px',
            paddingLeft: isActive ? '11px' : '12px',
            borderLeft:  isActive ? `2px solid ${ACCENT}` : '2px solid transparent',
            color:       isActive ? ACTIVE_TEXT : 'rgba(255,255,255,0.52)',
            fontWeight:  isActive ? 600 : 400,
          }}>
          <span className="material-symbols-rounded text-[14px] flex-shrink-0"
            style={{ color: isActive ? '#fff' : 'rgba(255,255,255,0.3)' }}>
            {icon}
          </span>
          {label}
        </span>
      )}
    </NavLink>
  )
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

export default function Sidebar({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const location = useLocation()
  const navigate  = useNavigate()
  const role = user.role as string

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('o3c_sidebar_collapsed') === '1' } catch { return false }
  })

  function toggleCollapse() {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem('o3c_sidebar_collapsed', next ? '1' : '0') } catch {}
  }

  // Visible modules for this user's role
  const visibleModules = MODULES.filter(m => {
    // 'overview' module is management-only; hasAccess with empty roles means only MGMT can see it
    if (m.id === 'overview') return MGMT.includes(role)
    return hasAccess(role, m.roles)
  })

  // Which module's section is currently active (by pathname prefix)
  function isModuleActive(mod: Module): boolean {
    if (mod.items.length === 0) {
      // Single-page module
      const pr = primaryRoute(mod)
      if (pr === '/') return location.pathname === '/'
      return location.pathname === pr || location.pathname.startsWith(pr + '/')
    }
    return mod.items.some(i =>
      location.pathname === i.to || location.pathname.startsWith(i.to + '/')
    )
  }

  // Open state for expanded accordion — auto-open the active section
  const initialOpen = visibleModules.find(m => isModuleActive(m) && m.items.length > 0)?.id ?? null
  const [openId, setOpenId] = useState<string | null>(initialOpen)

  const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <aside
      className={`flex flex-col flex-shrink-0 h-screen transition-all duration-200 ${collapsed ? 'w-[64px]' : 'w-60'}`}
      style={{ background: NAVY, borderRight: '1px solid rgba(255,255,255,0.06)' }}>

      {/* ── Logo ── */}
      <div className={`flex items-center gap-2.5 px-4 pt-4 pb-3 flex-shrink-0 ${collapsed ? 'justify-center px-2' : ''}`}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: ACCENT, boxShadow: '0 1px 6px rgba(192,0,0,0.35)' }}>
          <span className="text-white font-extrabold text-[12px] tracking-tight">O3</span>
        </div>
        {!collapsed && (
          <div>
            <p className="font-bold text-[14px] tracking-tight text-white leading-tight">O3 Capital</p>
            <p className="text-[10px] leading-tight" style={{ color: 'rgba(255,255,255,0.38)' }}>Cards Platform</p>
          </div>
        )}
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {visibleModules.map(mod => {
          const active  = isModuleActive(mod)
          const primary = primaryRoute(mod)
          const hasSubs = mod.items.length > 0

          // ── Collapsed: just icon, links to primary route ──
          if (collapsed) {
            return (
              <NavLink key={mod.id} to={primary} end={primary === '/'} title={mod.label}>
                {({ isActive: linkActive }) => {
                  // For multi-item modules, use our own active check
                  const shown = hasSubs ? active : linkActive
                  return (
                    <span
                      className={`flex items-center justify-center w-full py-[7px] rounded-lg transition-colors cursor-pointer ${!shown ? 'hover:bg-white/[0.07]' : ''}`}
                      style={{ borderLeft: shown ? `2px solid ${ACCENT}` : '2px solid transparent' }}>
                      <span className="material-symbols-rounded text-[18px]"
                        style={{ color: shown ? '#fff' : IDLE_ICON }}>
                        {mod.icon}
                      </span>
                    </span>
                  )
                }}
              </NavLink>
            )
          }

          // ── Single-page module (no sub-items) ──
          if (!hasSubs) {
            return (
              <NavLink key={mod.id} to={primary} end={primary === '/'}>
                {({ isActive: linkActive }) => (
                  <span
                    className={`flex items-center gap-2.5 w-full px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors cursor-pointer ${!linkActive ? 'hover:bg-white/[0.07]' : ''}`}
                    style={{
                      color:       linkActive ? ACTIVE_TEXT : IDLE_TEXT,
                      borderLeft:  linkActive ? `2px solid ${ACCENT}` : '2px solid transparent',
                      paddingLeft: linkActive ? 'calc(0.75rem - 2px)' : '0.75rem',
                    }}>
                    <span className="material-symbols-rounded text-[18px] flex-shrink-0"
                      style={{ color: linkActive ? '#fff' : IDLE_ICON }}>
                      {mod.icon}
                    </span>
                    <span className="flex-1">{mod.label}</span>
                  </span>
                )}
              </NavLink>
            )
          }

          // ── Multi-item module with accordion ──
          const isOpen = openId === mod.id

          return (
            <div key={mod.id}>
              {/* Section header — clicking navigates to the module overview and opens accordion */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => { setOpenId(mod.id); navigate(primary) }}
                onKeyDown={e => { if (e.key === 'Enter') { setOpenId(mod.id); navigate(primary) } }}
                className={`flex items-center gap-2.5 w-full px-3 py-[7px] rounded-lg text-[13px] font-semibold transition-colors cursor-pointer ${!active ? 'hover:bg-white/[0.07]' : ''}`}
                style={{
                  color:       active ? ACTIVE_TEXT : IDLE_TEXT,
                  borderLeft:  active ? `2px solid ${ACCENT}` : '2px solid transparent',
                  paddingLeft: active ? 'calc(0.75rem - 2px)' : '0.75rem',
                }}>
                <span className="material-symbols-rounded text-[18px] flex-shrink-0"
                  style={{ color: active ? '#fff' : IDLE_ICON }}>
                  {mod.icon}
                </span>
                <span className="flex-1 text-left">{mod.label}</span>
                <span className="material-symbols-rounded text-[14px] transition-transform"
                  style={{
                    color:     'rgba(255,255,255,0.25)',
                    transform: isOpen ? 'rotate(180deg)' : 'none',
                  }}>
                  expand_more
                </span>
              </div>

              {/* Sub-items accordion */}
              <div
                className="overflow-hidden transition-all duration-200 ease-out"
                style={{ maxHeight: isOpen ? `${mod.items.length * 40 + 60}px` : '0px' }}>
                <div className="ml-[30px] mt-0.5 mb-1"
                  style={{ borderLeft: '1px solid rgba(255,255,255,0.1)' }}>
                  {mod.items.map(item => (
                    <SubNavItem key={item.to} {...item} />
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </nav>

      {/* ── Collapse toggle ── */}
      <div className="flex-shrink-0 px-2 py-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <button
          onClick={toggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-[12px] transition-colors hover:bg-white/[0.07] ${collapsed ? 'justify-center' : ''}`}
          style={{ color: 'rgba(255,255,255,0.38)' }}>
          <span className="material-symbols-rounded text-[16px]">
            {collapsed ? 'chevron_right' : 'chevron_left'}
          </span>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>

      {/* ── User footer ── */}
      <div className="flex-shrink-0 px-2 py-2" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors group cursor-pointer hover:bg-white/[0.07] ${collapsed ? 'justify-center px-0' : ''}`}>
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
            style={{ background: ACCENT }}>
            {initials}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold text-white truncate leading-tight">{user.name}</p>
              <p className="text-[11px] leading-tight" style={{ color: 'rgba(255,255,255,0.4)' }}>
                {roleLabel(role)}
              </p>
            </div>
          )}
          {!collapsed && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
              <Link
                to="/settings/notifications"
                title="Notification preferences"
                className="p-1 rounded"
                style={{ color: 'rgba(255,255,255,0.45)' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}>
                <span className="material-symbols-rounded text-[15px]">notifications</span>
              </Link>
              <Link
                to="/settings/voice"
                title="Connect Zoho Voice"
                className="p-1 rounded"
                style={{ color: 'rgba(255,255,255,0.45)' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}>
                <span className="material-symbols-rounded text-[15px]">phone_in_talk</span>
              </Link>
              <button
                onClick={onLogout}
                title="Sign out"
                aria-label="Sign out"
                className="p-1 rounded"
                style={{ color: 'rgba(255,255,255,0.45)' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}>
                <span className="material-symbols-rounded text-[15px]">logout</span>
              </button>
            </div>
          )}
          {collapsed && (
            <button
              onClick={onLogout}
              title="Sign out"
              className="p-1 rounded hover:bg-white/10"
              style={{ color: 'rgba(255,255,255,0.38)' }}>
              <span className="material-symbols-rounded text-[15px]">logout</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
