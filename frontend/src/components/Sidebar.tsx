import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { AuthUser, ROLE_PAGES } from '../hooks/useAuth'
import { roleLabel } from '../lib/roles'

// ── Access control ────────────────────────────────────────────────────────────

const MGMT = ['md', 'coo', 'cfo', 'cmo', 'executive', 'admin', 'management', 'head_ops', 'head_it']

function hasAccess(role: string, moduleRoles: string[]): boolean {
  return MGMT.includes(role) || moduleRoles.includes(role)
}

const MODULE_PAGE_KEYS: Record<string, string[]> = {
  overview:    ['overview'],
  sales:       ['sales', 'crm_pipeline', 'crm_contacts', 'crm_tasks', 'crm_reports', 'los'],
  risk:        ['credit_portfolio', 'los_all', 'los_risk_review', 'risk_all'],
  finance:     ['income', 'transactions', 'fixed_deposit', 'eod', 'reconciliation', 'los_finance'],
  collections: ['collections', 'collections_assign', 'collections_payment', 'collections_payment_approve'],
  recovery:    ['recovery', 'recovery_assign', 'recovery_write_off'],
  settlements: ['settlement', 'reconciliation'],
  cards:       ['cards', 'card_trends', 'mobile_app', 'blink_card'],
  helpdesk:    ['customer_service', 'call_center'],
  compliance:  ['compliance_all', 'compliance_checklists', 'watch_list', 'sars', 'cbn_reports', 'audit_findings', 'audit_trail', 'audit_export'],
  hr:          ['hr_employees', 'hr_leave', 'hr_performance', 'hr_disciplinary', 'hr_payroll', 'hr_training'],
  campaigns:   ['campaigns', 'contact_lists', 'message_templates'],
  statements:  ['statements'],
  reports:     ['reports', 'kpi_dashboard'],
  admin:       ['admin_users', 'admin_api_keys', 'settings', 'sync_status'],
}

function hasPageAccess(pages: Set<string>, moduleId: string): boolean {
  const keys = MODULE_PAGE_KEYS[moduleId] ?? [moduleId]
  return keys.some(k => pages.has(k))
}

// ── Nav types ─────────────────────────────────────────────────────────────────

interface SubItem {
  label: string
  to:    string
}

interface NavModule {
  id:      string
  label:   string
  icon:    string
  roles:   string[]
  primary: string          // route to navigate to on header click
  items:   SubItem[]
}

interface NavSection {
  label: string | null     // null = no section header
  modules: NavModule[]
}

// ── Nav data ──────────────────────────────────────────────────────────────────

const SECTIONS: NavSection[] = [
  {
    label: null,
    modules: [
      { id: 'overview', label: 'Overview', icon: 'space_dashboard', roles: [], primary: '/', items: [] },
    ],
  },
  {
    label: 'Lending',
    modules: [
      {
        id: 'sales', label: 'Sales', icon: 'trending_up', roles: ['sales_officer', 'sales_head'],
        primary: '/sales',
        items: [
          { label: 'Customers',    to: '/sales/customers' },
          { label: 'CRM Pipeline', to: '/sales/crm' },
          { label: 'Applications', to: '/sales/applications' },
        ],
      },
      {
        id: 'risk', label: 'Risk & Credit', icon: 'shield', roles: ['risk_officer', 'risk_head'],
        primary: '/risk',
        items: [
          { label: 'App Review', to: '/risk/applications' },
          { label: 'Portfolio',  to: '/risk/portfolio' },
        ],
      },
    ],
  },
  {
    label: 'Operations',
    modules: [
      {
        id: 'finance', label: 'Finance', icon: 'account_balance', roles: ['finance_officer', 'finance_head', 'cfo', 'head_of_reconciliation'],
        primary: '/finance',
        items: [
          { label: 'Transactions',   to: '/finance/transactions' },
          { label: 'Income',         to: '/finance/income' },
          { label: 'Fixed Deposits', to: '/finance/fixed-deposit' },
          { label: 'EOD / EOB',      to: '/finance/eod' },
        ],
      },
      {
        id: 'cards', label: 'Cards & Channels', icon: 'credit_card', roles: ['cards_ops_officer', 'cards_ops_head'],
        primary: '/cards',
        items: [
          { label: 'Trends',     to: '/cards/trends' },
          { label: 'Management', to: '/cards/management' },
          { label: 'Blink Card', to: '/cards/blink' },
          { label: 'Mobile App', to: '/cards/mobile-app' },
        ],
      },
      {
        id: 'settlements', label: 'Settlements', icon: 'compare_arrows', roles: ['finance_head', 'cfo', 'head_of_reconciliation'],
        primary: '/settlements',
        items: [
          { label: 'Settlement',     to: '/settlements' },
          { label: 'Reconciliation', to: '/settlements/recon' },
        ],
      },
    ],
  },
  {
    label: 'Portfolio',
    modules: [
      {
        id: 'collections', label: 'Collections', icon: 'payments', roles: ['collections_agent', 'collections_head'],
        primary: '/collections',
        items: [
          { label: 'Agent Queue',    to: '/collections/queue' },
          { label: 'Targets',        to: '/collections/targets' },
          { label: 'Promise-to-Pay', to: '/collections/promises' },
        ],
      },
      {
        id: 'recovery', label: 'Recovery', icon: 'refresh', roles: ['recovery_agent', 'recovery_head'],
        primary: '/recovery',
        items: [
          { label: 'Cases',        to: '/recovery/cases' },
          { label: 'Legal',        to: '/recovery/legal' },
          { label: 'Field Visits', to: '/recovery/visits' },
        ],
      },
    ],
  },
  {
    label: 'Customer',
    modules: [
      {
        id: 'helpdesk', label: 'Helpdesk', icon: 'support_agent',
        roles: [
          'call_center_agent', 'call_center_head', 'collections_agent', 'collections_head',
          'recovery_agent', 'recovery_head', 'cards_ops_officer', 'cards_ops_head',
          'sales_officer', 'sales_head', 'risk_officer', 'risk_head',
          'finance_officer', 'finance_head', 'hr_officer', 'hr_manager',
          'compliance_officer', 'compliance_head', 'it_admin', 'head_it',
          'md', 'coo', 'cfo', 'cmo', 'management', 'admin',
        ],
        primary: '/helpdesk',
        items: [
          { label: 'Overview',         to: '/helpdesk' },
          { label: 'All Tickets',      to: '/helpdesk/tickets' },
          { label: 'New Ticket',       to: '/helpdesk/new' },
          { label: 'Call Log',         to: '/helpdesk/calls' },
          { label: 'Supervisor',       to: '/helpdesk/supervisor' },
          { label: 'Analytics',        to: '/helpdesk/stats' },
          { label: 'Canned Responses', to: '/helpdesk/canned' },
        ],
      },
    ],
  },
  {
    label: 'Governance',
    modules: [
      {
        id: 'compliance', label: 'Compliance', icon: 'policy', roles: ['compliance_officer', 'compliance_head', 'internal_control_head'],
        primary: '/compliance',
        items: [
          { label: 'AML Watchlist', to: '/compliance/watchlist' },
          { label: 'SAR Filing',   to: '/compliance/sars' },
          { label: 'CBN Reports',  to: '/compliance/cbn-reports' },
          { label: 'Findings',     to: '/compliance/findings' },
          { label: 'Checklists',   to: '/compliance/checklists' },
          { label: 'Audit Trail',  to: '/compliance/audit-trail' },
        ],
      },
      {
        id: 'hr', label: 'HR', icon: 'groups', roles: ['hr_officer', 'hr_manager'],
        primary: '/hr',
        items: [
          { label: 'Employees',    to: '/hr/employees' },
          { label: 'Leave',        to: '/hr/leave' },
          { label: 'Performance',  to: '/hr/performance' },
          { label: 'Disciplinary', to: '/hr/disciplinary' },
          { label: 'Training',     to: '/hr/training' },
        ],
      },
    ],
  },
  {
    label: 'Growth',
    modules: [
      {
        id: 'campaigns', label: 'Campaigns', icon: 'campaign', roles: ['cmo', 'md', 'coo', 'management', 'admin'],
        primary: '/campaigns',
        items: [
          { label: 'Overview',      to: '/campaigns/overview' },
          { label: 'Campaigns',     to: '/campaigns' },
          { label: 'Analytics',     to: '/campaigns/analytics' },
          { label: 'Templates',     to: '/campaigns/templates' },
          { label: 'Contact Lists', to: '/campaigns/lists' },
        ],
      },
    ],
  },
  {
    label: 'Intelligence',
    modules: [
      {
        id: 'statements', label: 'Statements', icon: 'receipt_long',
        roles: ['cmo', 'md', 'coo', 'cfo', 'finance_head', 'sales_head', 'call_center_head', 'management', 'admin'],
        primary: '/statements',
        items: [],
      },
      {
        id: 'reports', label: 'Reports', icon: 'bar_chart',
        roles: ['sales_head', 'risk_head', 'finance_head', 'collections_head', 'recovery_head', 'cards_ops_head', 'call_center_head', 'compliance_head', 'internal_control_head', 'hr_manager'],
        primary: '/reports',
        items: [],
      },
    ],
  },
  {
    label: 'Admin',
    modules: [
      {
        id: 'admin', label: 'Admin', icon: 'admin_panel_settings', roles: ['it_admin', 'head_it'],
        primary: '/admin/overview',
        items: [
          { label: 'Overview',           to: '/admin/overview' },
          { label: 'Users',              to: '/admin/users' },
          { label: 'Roles',              to: '/admin/roles' },
          { label: 'Email Senders',      to: '/admin/email-senders' },
          { label: 'Mail Health',        to: '/admin/mail' },
          { label: 'API Keys',           to: '/admin/api-keys' },
          { label: 'Settings',           to: '/admin/settings' },
          { label: 'Notif. Settings',    to: '/admin/notification-settings' },
          { label: 'Integrations',       to: '/admin/integrations' },
          { label: 'Audit Log',          to: '/admin/audit' },
          { label: 'Sync Status',        to: '/admin/sync' },
        ],
      },
    ],
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Sidebar({ user, onLogout, onMobileClose }: { user: AuthUser; onLogout: () => void; onMobileClose?: () => void }) {
  const location = useLocation()
  const navigate  = useNavigate()
  const role    = user.role as string
  const pageList = user.pages?.length ? user.pages : (ROLE_PAGES[role] ?? [])
  const pageSet  = new Set(pageList)

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('o3c_sidebar_collapsed') === '1' } catch { return false }
  })

  const [openId, setOpenId] = useState<string | null>(() => {
    // Auto-open the section that contains the current route
    for (const sec of SECTIONS) {
      for (const mod of sec.modules) {
        if (mod.items.some(i => location.pathname === i.to || location.pathname.startsWith(i.to + '/'))) {
          return mod.id
        }
      }
    }
    return null
  })

  function toggleCollapse() {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem('o3c_sidebar_collapsed', next ? '1' : '0') } catch {}
  }

  function isModuleVisible(mod: NavModule): boolean {
    if (pageSet.size > 0) return hasPageAccess(pageSet, mod.id)
    if (mod.id === 'overview') return MGMT.includes(role)
    return hasAccess(role, mod.roles)
  }

  function isModuleActive(mod: NavModule): boolean {
    if (mod.items.length === 0) {
      if (mod.primary === '/') return location.pathname === '/'
      return location.pathname === mod.primary || location.pathname.startsWith(mod.primary + '/')
    }
    return mod.items.some(i =>
      location.pathname === i.to || location.pathname.startsWith(i.to + '/')
    )
  }

  function handleModuleClick(mod: NavModule) {
    if (mod.items.length === 0) {
      navigate(mod.primary)
      onMobileClose?.()
    } else {
      setOpenId(openId === mod.id ? null : mod.id)
      navigate(mod.primary)
    }
  }

  const sidebarWidth = collapsed ? 64 : 236

  return (
    <aside
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        background: 'var(--sb)',
        borderRight: '1px solid var(--sb-bdr)',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        transition: 'width 200ms ease, min-width 200ms ease',
        flexShrink: 0,
      }}
    >
      {/* ── Logo ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: collapsed ? '18px 0' : '18px 16px 14px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        flexShrink: 0,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 7, flexShrink: 0,
          background: '#0E2841',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '-0.5px', fontFamily: "'Inter', sans-serif" }}>O3</span>
        </div>
        {!collapsed && (
          <div style={{ overflow: 'hidden', flex: 1 }}>
            <div style={{ color: 'var(--txt)', fontWeight: 800, fontSize: 13.5, lineHeight: 1.2, letterSpacing: '-0.4px' }}>
              O3 <span style={{ color: '#C00000' }}>Capital</span>
            </div>
            <div style={{
              display: 'inline-block', marginTop: 2,
              fontSize: 8.5, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase',
              color: 'var(--chip-txt)', background: 'var(--chip-bg)',
              padding: '1px 5px', borderRadius: 4,
            }}>
              WORKSPACE
            </div>
          </div>
        )}
      </div>

      {/* ── Nav ── */}
      <nav aria-label="Main navigation" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: collapsed ? '4px 8px' : '4px 10px' }}>
        {SECTIONS.map((section, si) => {
          const visibleMods = section.modules.filter(isModuleVisible)
          if (visibleMods.length === 0) return null

          return (
            <div key={si} style={{ marginBottom: 4 }}>
              {/* Section label */}
              {section.label && !collapsed && (
                <div style={{
                  fontSize: 8.5,
                  fontWeight: 700,
                  letterSpacing: '1.3px',
                  textTransform: 'uppercase',
                  color: 'var(--grp)',
                  padding: '10px 14px 3px',
                }}>
                  {section.label}
                </div>
              )}

              {visibleMods.map(mod => {
                const active   = isModuleActive(mod)
                const hasSubs  = mod.items.length > 0
                const isOpen   = openId === mod.id

                /* ── Collapsed: icon only ── */
                if (collapsed) {
                  return (
                    <button
                      key={mod.id}
                      onClick={() => handleModuleClick(mod)}
                      title={mod.label}
                      aria-label={mod.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        padding: '8px 0',
                        borderRadius: 7,
                        border: 'none',
                        background: active ? 'var(--nav-act-bg)' : 'transparent',
                        cursor: 'pointer',
                        marginBottom: 1,
                        transition: 'background 150ms',
                        position: 'relative',
                      }}
                      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--nav-hvr-bg)' }}
                      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                    >
                      {active && (
                        <div style={{
                          position: 'absolute', left: -7, top: '50%',
                          transform: 'translateY(-50%)', width: 3, height: 16,
                          background: 'var(--nav-dot)', borderRadius: '0 3px 3px 0',
                        }} />
                      )}
                      <span
                        aria-hidden="true"
                        className="material-symbols-rounded"
                        style={{ fontSize: 18, color: active ? 'var(--nav-act-txt)' : 'var(--nav-txt)' }}
                      >
                        {mod.icon}
                      </span>
                    </button>
                  )
                }

                /* ── Expanded: module row ── */
                return (
                  <div key={mod.id} style={{ margin: '1px 0' }}>
                    <button
                      onClick={() => handleModuleClick(mod)}
                      aria-expanded={hasSubs ? isOpen : undefined}
                      aria-controls={hasSubs ? `submenu-${mod.id}` : undefined}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        width: '100%',
                        height: 32,
                        padding: '0 9px 0 11px',
                        borderRadius: 7,
                        border: 'none',
                        background: active ? 'var(--nav-act-bg)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'background 150ms',
                        position: 'relative',
                      }}
                      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--nav-hvr-bg)' }}
                      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                    >
                      {active && (
                        <div style={{
                          position: 'absolute', left: -7, top: '50%',
                          transform: 'translateY(-50%)', width: 3, height: 16,
                          background: 'var(--nav-dot)', borderRadius: '0 3px 3px 0',
                        }} />
                      )}
                      <span
                        aria-hidden="true"
                        className="material-symbols-rounded"
                        style={{ fontSize: 16, flexShrink: 0, color: active ? 'var(--nav-act-txt)' : 'var(--nav-txt)' }}
                      >
                        {mod.icon}
                      </span>
                      <span style={{
                        flex: 1,
                        textAlign: 'left',
                        fontSize: 12.5,
                        fontWeight: active ? 600 : 500,
                        color: active ? 'var(--nav-act-txt)' : 'var(--nav-txt)',
                        letterSpacing: '-0.1px',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                      }}>
                        {mod.label}
                      </span>
                      {hasSubs && (
                        <span
                          aria-hidden="true"
                          className="material-symbols-rounded"
                          style={{
                            fontSize: 13,
                            color: 'var(--grp)',
                            transform: isOpen ? 'rotate(180deg)' : 'none',
                            transition: 'transform .22s ease',
                          }}
                        >
                          expand_more
                        </span>
                      )}
                    </button>

                    {/* Sub-items accordion */}
                    {hasSubs && (
                      <div id={`submenu-${mod.id}`} style={{
                        overflow: 'hidden',
                        maxHeight: isOpen ? `${mod.items.length * 30 + 8}px` : '0px',
                        transition: 'max-height .22s ease',
                        padding: '0 7px 0 14px',
                      }}>
                        {mod.items.map(item => (
                          <NavLink
                            key={item.to}
                            to={item.to}
                            end
                            onClick={onMobileClose}
                            style={({ isActive }) => ({
                              display: 'flex',
                              alignItems: 'center',
                              gap: 7,
                              height: 28,
                              padding: '0 8px 0 9px',
                              margin: '1px 0',
                              fontSize: 12.5,
                              fontWeight: isActive ? 600 : 400,
                              color: isActive ? 'var(--sub-act)' : 'var(--sub-txt)',
                              borderRadius: 5,
                              background: isActive ? 'var(--nav-act-bg)' : 'transparent',
                              textDecoration: 'none',
                              transition: 'color 120ms, background 120ms',
                              cursor: 'pointer',
                            })}
                            onMouseEnter={e => {
                              const el = e.currentTarget
                              if (el.getAttribute('aria-current') !== 'page') {
                                el.style.color = 'var(--sub-hvr)'
                                el.style.background = 'var(--nav-hvr-bg)'
                              }
                            }}
                            onMouseLeave={e => {
                              const el = e.currentTarget
                              if (el.getAttribute('aria-current') !== 'page') {
                                el.style.color = 'var(--sub-txt)'
                                el.style.background = 'transparent'
                              }
                            }}
                          >
                            {/* 1px × 14px vertical indicator line */}
                            {({ isActive }: { isActive: boolean }) => (
                              <>
                                <div style={{
                                  width: 1, height: 14, flexShrink: 0, borderRadius: 1,
                                  background: isActive ? 'var(--nav-dot)' : 'var(--bdr)',
                                  transition: 'background .12s',
                                }} />
                                {item.label}
                              </>
                            )}
                          </NavLink>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </nav>

      {/* ── Collapse toggle ── */}
      <div style={{ flexShrink: 0, padding: '6px 10px', borderTop: '1px solid var(--sb-bdr)' }}>
        <button
          onClick={toggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 8,
            width: '100%',
            padding: '6px 8px',
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--nav-txt)',
            fontSize: 12,
            fontWeight: 500,
            transition: 'color 150ms, background 150ms',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--nav-hvr-bg)'; e.currentTarget.style.color = 'var(--txt2)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--nav-txt)' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
            {collapsed ? 'chevron_right' : 'chevron_left'}
          </span>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>

      {/* ── User footer ── */}
      <div style={{
        flexShrink: 0,
        padding: '8px 10px',
        borderTop: '1px solid var(--sb-bdr)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}>
          {/* Avatar — always navy, initials in white */}
          <div style={{
            width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
            background: 'linear-gradient(135deg, #0E2841 0%, #1A4068 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#fff',
            letterSpacing: '-0.3px',
          }}>
            {initials(user.name)}
          </div>

          {!collapsed && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12.5, fontWeight: 600, color: 'var(--txt)',
                  overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                  lineHeight: 1.25,
                }}>
                  {user.name}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--txt2)', lineHeight: 1.3, marginTop: 1 }}>
                  {roleLabel(role)}
                </div>
              </div>
              <button
                onClick={onLogout}
                title="Sign out"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 6, border: 'none',
                  background: 'transparent', cursor: 'pointer',
                  color: 'var(--nav-txt)',
                  transition: 'color 150ms, background 150ms',
                  flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--nav-hvr-bg)'; e.currentTarget.style.color = 'var(--txt)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--nav-txt)' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>logout</span>
              </button>
            </>
          )}

          {collapsed && (
            <button
              onClick={onLogout}
              title="Sign out"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 6, border: 'none',
                background: 'transparent', cursor: 'pointer',
                color: 'var(--nav-txt)',
                transition: 'color 150ms, background 150ms',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--nav-hvr-bg)'; e.currentTarget.style.color = 'var(--txt)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--nav-txt)' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>logout</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
