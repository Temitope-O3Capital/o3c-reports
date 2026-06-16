import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

type User = { name: string; role: string }

interface SubItem { label: string; to: string }
interface Dept    { id: string; label: string; icon: string; items: SubItem[] }

const TOP = [
  { label: 'Dashboard', icon: 'dashboard',           to: '/' },
  { label: 'Approvals', icon: 'approval_delegation', to: '/approvals', badge: 3 },
]

const DEPTS: Dept[] = [
  {
    id: 'finance', label: 'Finance', icon: 'account_balance',
    items: [
      { label: 'Overview',       to: '/finance' },
      { label: 'Transactions',   to: '/finance/transactions' },
      { label: 'Collections',    to: '/finance/collections' },
      { label: 'Recovery',       to: '/finance/recovery' },
      { label: 'Reconciliation', to: '/finance/reconciliation' },
      { label: 'EOD Reports',    to: '/finance/eod' },
      { label: 'Income',         to: '/finance/income' },
    ],
  },
  {
    id: 'sales', label: 'Sales', icon: 'trending_up',
    items: [
      { label: 'Overview',           to: '/sales' },
      { label: 'Customer Directory', to: '/sales/customers' },
      { label: 'Card Issuance',      to: '/sales/cards' },
      { label: 'Cohort Analysis',    to: '/sales/cohort' },
    ],
  },
  {
    id: 'cards', label: 'Cards & Ops', icon: 'credit_card',
    items: [
      { label: 'Overview',        to: '/cards' },
      { label: 'Card Trends',     to: '/cards/trends' },
      { label: 'Card Management', to: '/cards/management' },
    ],
  },
  {
    id: 'crm', label: 'CRM', icon: 'contacts',
    items: [
      { label: 'Contacts', to: '/crm/contacts' },
      { label: 'Pipeline', to: '/crm/pipeline' },
      { label: 'Tasks',    to: '/crm/tasks' },
      { label: 'Reports',  to: '/crm/reports' },
    ],
  },
]

const OPS = [
  { label: 'Campaigns', icon: 'campaign',   to: '/marketing/campaigns' },
  { label: 'Watch',     icon: 'visibility', to: '/watch',    badge: 4 },
  { label: 'Settings',  icon: 'settings',   to: '/settings' },
]

const IDLE_TEXT   = 'rgba(255,255,255,0.58)'
const IDLE_ICON   = 'rgba(255,255,255,0.38)'
const ACTIVE_TEXT = '#ffffff'
const ACCENT      = '#C00000'

function NavItem({ label, icon, to, badge, end: endProp = false }: {
  label: string; icon: string; to: string; badge?: number; end?: boolean
}) {
  return (
    <NavLink to={to} end={endProp}>
      {({ isActive }) => (
        <span
          className={`flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors cursor-pointer w-full ${!isActive ? 'hover:bg-white/[0.07]' : ''}`}
          style={{
            color:       isActive ? ACTIVE_TEXT : IDLE_TEXT,
            borderLeft:  isActive ? `2px solid ${ACCENT}` : '2px solid transparent',
            paddingLeft: isActive ? 'calc(0.75rem - 2px)' : '0.75rem',
          }}>
          <span className="material-symbols-rounded text-[17px] flex-shrink-0"
            style={{ color: isActive ? '#fff' : IDLE_ICON }}>
            {icon}
          </span>
          <span className="flex-1">{label}</span>
          {badge != null && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white"
              style={{ background: ACCENT }}>
              {badge}
            </span>
          )}
        </span>
      )}
    </NavLink>
  )
}

export default function Sidebar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const location = useLocation()

  const activeDeptId = DEPTS.find(d =>
    d.items.some(i => location.pathname === i.to || location.pathname.startsWith(i.to + '/'))
  )?.id ?? null

  // Accordion: only one dept open at a time; auto-open the active one on mount
  const [openId, setOpenId] = useState<string | null>(activeDeptId)

  // Navigate to the dept's overview page and ensure it's the only open dept
  function openDept(id: string) {
    setOpenId(prev => (prev === id ? id : id)) // always keep clicked one open
  }

  const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <aside className="flex flex-col w-[220px] flex-shrink-0 h-screen"
      style={{ background: '#0E2841', borderRight: '1px solid rgba(255,255,255,0.06)' }}>

      {/* ── Logo ── */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: ACCENT, boxShadow: '0 1px 6px rgba(192,0,0,0.35)' }}>
          <span className="text-white font-extrabold text-[12px] tracking-tight">O3</span>
        </div>
        <div>
          <p className="font-bold text-[14px] tracking-tight text-white leading-tight">O3 Capital</p>
          <p className="text-[10px] leading-tight" style={{ color: 'rgba(255,255,255,0.38)' }}>Cards Platform</p>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="px-3 mb-3">
        <button className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-[12.5px] transition-colors"
          style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.35)' }}>
          <span className="material-symbols-rounded text-[15px]">search</span>
          <span className="flex-1 text-left">Search…</span>
          <kbd className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.3)' }}>⌘K</kbd>
        </button>
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5 pb-2">

        {TOP.map(({ label, icon, to, badge }) => (
          <NavItem key={to} label={label} icon={icon} to={to} badge={badge} end={to === '/'} />
        ))}

        <p className="px-3 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.1em]"
          style={{ color: 'rgba(255,255,255,0.28)' }}>
          Departments
        </p>

        {DEPTS.map(dept => {
          const isOpen     = openId === dept.id
          const deptActive = dept.id === activeDeptId

          return (
            <div key={dept.id}>
              {/* Department header — navigates to overview + opens accordion */}
              <NavLink
                to={dept.items[0].to}
                onClick={() => setOpenId(dept.id)}
              >
                {() => (
                  <span
                    className={`flex items-center gap-2.5 w-full px-3 py-[7px] rounded-lg text-[13px] font-semibold transition-colors cursor-pointer ${!deptActive ? 'hover:bg-white/[0.07]' : ''}`}
                    style={{
                      color:       deptActive ? ACTIVE_TEXT : IDLE_TEXT,
                      borderLeft:  deptActive ? `2px solid ${ACCENT}` : '2px solid transparent',
                      paddingLeft: deptActive ? 'calc(0.75rem - 2px)' : '0.75rem',
                    }}>
                    <span className="material-symbols-rounded text-[17px] flex-shrink-0"
                      style={{ color: deptActive ? '#fff' : IDLE_ICON }}>
                      {dept.icon}
                    </span>
                    <span className="flex-1">{dept.label}</span>
                  </span>
                )}
              </NavLink>

              {/* Sub-items — accordion, one open at a time */}
              <div className="overflow-hidden transition-all duration-200 ease-out"
                style={{ maxHeight: isOpen ? `${dept.items.length * 34}px` : '0px' }}>
                <div className="ml-[30px] mt-0.5 mb-1"
                  style={{ borderLeft: '1px solid rgba(255,255,255,0.1)' }}>
                  {dept.items.map(({ label, to }) => (
                    <NavLink key={to} to={to} end>
                      {({ isActive }) => (
                        <span
                          className={`flex items-center py-[7px] text-[12.5px] cursor-pointer w-full transition-colors rounded-r-lg ${!isActive ? 'hover:bg-white/[0.07]' : ''}`}
                          style={{
                            marginLeft:  '-1px',
                            paddingLeft: isActive ? '11px' : '12px',
                            borderLeft:  isActive ? `2px solid ${ACCENT}` : '2px solid transparent',
                            color:       isActive ? '#ffffff' : 'rgba(255,255,255,0.5)',
                            fontWeight:  isActive ? 600 : 400,
                            background:  'transparent',
                          }}>
                          {label}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            </div>
          )
        })}

        <p className="px-3 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.1em]"
          style={{ color: 'rgba(255,255,255,0.28)' }}>
          Operations
        </p>
        {OPS.map(({ label, icon, to, badge }) => (
          <NavItem key={to} label={label} icon={icon} to={to} badge={badge} />
        ))}
      </nav>

      {/* ── User footer ── */}
      <div className="flex-shrink-0 px-2 py-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors group cursor-pointer hover:bg-white/[0.07]">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
            style={{ background: ACCENT }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-semibold text-white truncate leading-tight">{user.name}</p>
            <p className="text-[11px] capitalize leading-tight" style={{ color: 'rgba(255,255,255,0.4)' }}>
              {user.role}
            </p>
          </div>
          <button onClick={onLogout} title="Sign out" aria-label="Sign out"
            className="p-1 rounded transition-all opacity-0 group-hover:opacity-100"
            style={{ color: 'rgba(255,255,255,0.45)' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}>
            <span className="material-symbols-rounded text-[15px]">logout</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
