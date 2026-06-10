import { useState, useEffect, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './hooks/useAuth.js'
import SyncPanel from './components/SyncPanel.jsx'
import DataBanner from './components/DataBanner.jsx'
import Login from './pages/Login.jsx'
import Overview from './pages/Overview.jsx'
import Transactions from './pages/Transactions.jsx'
import Collections from './pages/Collections.jsx'
import Recovery from './pages/Recovery.jsx'
import Sales from './pages/Sales.jsx'
import Cards from './pages/Cards.jsx'
import Cohort from './pages/Cohort.jsx'
import Admin from './pages/Admin.jsx'
import Income          from './pages/Income.jsx'
import Eod             from './pages/Eod.jsx'
import Uploads         from './pages/Uploads.jsx'
import ChangePassword  from './pages/ChangePassword.jsx'
import CrmPipeline     from './pages/crm/Pipeline.jsx'
import CrmContacts     from './pages/crm/Contacts.jsx'
import CrmContact360   from './pages/crm/Contact360.jsx'
import CrmTasks        from './pages/crm/Tasks.jsx'
import CrmRequests     from './pages/crm/Requests.jsx'
import CrmReports      from './pages/crm/CrmReports.jsx'
import Reconciliation  from './pages/Reconciliation.jsx'
import CallCenter      from './pages/CallCenter.jsx'

const REPORTING_NAV = [
  { page: 'overview',        label: 'Overview',        path: '/',                icon: 'space_dashboard' },
  { page: 'income',          label: 'Income Report',   path: '/income',          icon: 'payments' },
  { page: 'reconciliation',  label: 'Reconciliation',  path: '/reconciliation',  icon: 'balance' },
  { page: 'eod',             label: 'EOD Report',      path: '/eod',             icon: 'today' },
  { page: 'transactions',    label: 'Transactions',    path: '/transactions',    icon: 'receipt_long' },
  { page: 'cards',           label: 'Cards',           path: '/cards',           icon: 'credit_card' },
  { page: 'collections',     label: 'Collections',     path: '/collections',     icon: 'account_balance_wallet' },
  { page: 'recovery',        label: 'Recovery',        path: '/recovery',        icon: 'gavel' },
  { page: 'call_center',     label: 'Call Center',     path: '/call-center',     icon: 'headset_mic' },
  { page: 'cohort',          label: 'Cohort',          path: '/cohort',          icon: 'group_work' },
  { page: 'uploads',         label: 'Data Uploads',    path: '/uploads',         icon: 'upload_file' },
]

// Sales section includes Sales page + CRM sub-pages
const SALES_NAV = [
  { page: 'sales',        label: 'Sales',       path: '/sales',        icon: 'trending_up' },
]

const CRM_NAV = [
  { page: 'crm_pipeline', label: 'Pipeline',    path: '/crm/pipeline', icon: 'view_kanban' },
  { page: 'crm_contacts', label: 'Contacts',    path: '/crm/contacts', icon: 'contacts' },
  { page: 'crm_tasks',    label: 'Tasks',       path: '/crm/tasks',    icon: 'task_alt' },
  { page: 'crm_requests', label: 'Requests',    path: '/crm/requests', icon: 'support_agent' },
  { page: 'crm_reports',  label: 'CRM Reports', path: '/crm/reports',  icon: 'insert_chart' },
]

export default function App() {
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  )
}

function AppInner() {
  const { user, loading, login, logout, canAccess, clearMustChangePassword } = useAuth()
  const [dataSource, setDataSource] = useState(null)
  const [syncOpen,   setSyncOpen]   = useState(false)
  const [sideOpen,   setSideOpen]   = useState(false)
  const [isDark,     setIsDark]     = useState(() => localStorage.getItem('o3c_theme') === 'dark')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem('o3c_theme', isDark ? 'dark' : 'light')
  }, [isDark])

  if (loading) return (
    <div className="h-screen flex items-center justify-center" style={{ background: 'rgb(var(--bg-page))' }}>
      <div className="flex flex-col items-center gap-3">
        <div className="spinner" style={{ width: 24, height: 24 }} />
        <p className="text-xs font-medium" style={{ color: 'rgb(var(--fg-3))' }}>Loading</p>
      </div>
    </div>
  )

  if (!user) return <Login onLogin={login} />

  if (user.must_change_password)
    return <ChangePassword user={user} onDone={clearMustChangePassword} />

  const initials = (user.full_name || user.email)
    .split(' ').slice(0, 2).map(w => w[0].toUpperCase()).join('')

  const visibleNav     = REPORTING_NAV.filter(n => canAccess(n.page))
  const visibleSalesNav = SALES_NAV.filter(n => canAccess(n.page))
  const visibleCrmNav   = CRM_NAV.filter(n => canAccess(n.page))

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'rgb(var(--bg-page))' }}>

      {/* ── Mobile overlay ── */}
      {sideOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSideOpen(false)} />
          <aside className="relative z-10 flex flex-col w-64 bg-primary h-full">
            <SidebarContent
              visibleNav={visibleNav}
              visibleSalesNav={visibleSalesNav}
              visibleCrmNav={visibleCrmNav}
              canAccess={canAccess}
              user={user}
              initials={initials}
              isDark={isDark}
              setIsDark={setIsDark}
              logout={logout}
              onNav={() => setSideOpen(false)}
            />
          </aside>
        </div>
      )}

      {/* ── Desktop sidebar ── */}
      <aside className="hidden lg:flex flex-col w-60 bg-primary dark:bg-primary-dark flex-shrink-0 h-screen">
        <SidebarContent
          visibleNav={visibleNav}
          visibleSalesNav={visibleSalesNav}
          visibleCrmNav={visibleCrmNav}
          canAccess={canAccess}
          user={user}
          initials={initials}
          isDark={isDark}
          setIsDark={setIsDark}
          logout={logout}
          onNav={() => {}}
        />
      </aside>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Topbar */}
        <header className="flex-shrink-0 h-14 flex items-center gap-3 px-4 lg:px-6"
          style={{
            background: 'rgb(var(--bg-surface))',
            borderBottom: '1px solid rgb(var(--border) / 0.08)',
          }}>
          <button className="lg:hidden btn-icon" onClick={() => setSideOpen(true)}>
            <span className="material-symbols-rounded text-[22px]">menu</span>
          </button>

          <PageTitle />

          <div className="flex items-center gap-2 ml-auto">
            <DataBanner source={dataSource} compact />

            {user.role === 'admin' && (
              <button
                onClick={() => setSyncOpen(true)}
                className="hidden sm:flex btn btn-ghost btn-sm gap-1.5 text-slate-600"
              >
                <span className="material-symbols-rounded text-[16px]">sync</span>
                Sync
              </button>
            )}

            <button
              onClick={() => setIsDark(d => !d)}
              className="btn-icon"
              title={isDark ? 'Light mode' : 'Dark mode'}
            >
              <span className="material-symbols-rounded text-[20px]">
                {isDark ? 'light_mode' : 'dark_mode'}
              </span>
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <Routes>
            {/* Reporting */}
            <Route path="/"             element={<Guard page="overview"      ca={canAccess}><Overview     setDs={setDataSource} /></Guard>} />
            <Route path="/transactions" element={<Guard page="transactions"  ca={canAccess}><Transactions setDs={setDataSource} /></Guard>} />
            <Route path="/cards"        element={<Guard page="cards"         ca={canAccess}><Cards        setDs={setDataSource} /></Guard>} />
            <Route path="/sales"        element={<Guard page="sales"         ca={canAccess}><Sales        setDs={setDataSource} /></Guard>} />
            <Route path="/collections"  element={<Guard page="collections"   ca={canAccess}><Collections  setDs={setDataSource} /></Guard>} />
            <Route path="/recovery"     element={<Guard page="recovery"      ca={canAccess}><Recovery     setDs={setDataSource} /></Guard>} />
            <Route path="/cohort"       element={<Guard page="cohort"        ca={canAccess}><Cohort       setDs={setDataSource} /></Guard>} />
            <Route path="/admin"        element={<Guard page="admin"         ca={canAccess}><Admin /></Guard>} />
            {/* /executive redirects to Dashboard */}
            <Route path="/executive"            element={<Navigate to="/" replace />} />
            <Route path="/income"               element={<Guard page="income"       ca={canAccess}><Income /></Guard>} />
            <Route path="/uploads"              element={<Guard page="uploads"      ca={canAccess}><Uploads /></Guard>} />
            <Route path="/eod"                 element={<Guard page="eod"             ca={canAccess}><Eod /></Guard>} />
            <Route path="/reconciliation"      element={<Guard page="reconciliation"  ca={canAccess}><Reconciliation /></Guard>} />
            <Route path="/call-center"         element={<Guard page="call_center"     ca={canAccess}><CallCenter /></Guard>} />
            {/* CRM */}
            <Route path="/crm/pipeline"         element={<Guard page="crm_pipeline" ca={canAccess}><CrmPipeline /></Guard>} />
            <Route path="/crm/contacts"         element={<Guard page="crm_contacts" ca={canAccess}><CrmContacts /></Guard>} />
            <Route path="/crm/contacts/:id"     element={<Guard page="crm_contacts" ca={canAccess}><CrmContact360 /></Guard>} />
            <Route path="/crm/tasks"            element={<Guard page="crm_tasks"    ca={canAccess}><CrmTasks /></Guard>} />
            <Route path="/crm/requests"         element={<Guard page="crm_requests" ca={canAccess}><CrmRequests /></Guard>} />
            <Route path="/crm/reports"          element={<Guard page="crm_reports"  ca={canAccess}><CrmReports /></Guard>} />
            <Route path="*"                     element={<DefaultRedirect canAccess={canAccess} />} />
          </Routes>
        </main>
      </div>

      {syncOpen && <SyncPanel onClose={() => setSyncOpen(false)} onSynced={() => {}} />}
    </div>
  )
}

/* ── Sidebar content ─────────────────────────────────────────────────────── */
function SidebarContent({ visibleNav, visibleSalesNav, visibleCrmNav, canAccess, user, initials, isDark, setIsDark, logout, onNav }) {
  return (
    <>
      {/* Brand */}
      <div className="px-5 pt-5 pb-4 flex-shrink-0">
        <div>
          <span className="text-[18px] font-bold text-white tracking-tight leading-tight">
            O3 <span className="text-accent">Capital</span>
          </span>
        </div>
        <p className="text-[10px] font-semibold text-white/25 uppercase tracking-[0.12em] mt-0.5">
          Central Reporting System
        </p>
      </div>

      <div className="mx-4 border-t border-white/[0.08]" />

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <p className="px-2 text-[10px] font-semibold text-white/25 uppercase tracking-[0.12em] mb-2">
          Dashboards
        </p>
        {visibleNav.map(n => (
          <NavLink
            key={n.page}
            to={n.path}
            end={n.path === '/'}
            onClick={onNav}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all mb-0.5 ${
                isActive
                  ? 'bg-white/[0.1] text-white'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className={`material-symbols-rounded text-[19px] flex-shrink-0 transition-all ${isActive ? 'opacity-100' : 'opacity-60'}`}>
                  {n.icon}
                </span>
                {n.label}
                {isActive && <span className="ml-auto w-1 h-4 rounded-full bg-accent flex-shrink-0" />}
              </>
            )}
          </NavLink>
        ))}

        {/* Sales & CRM nav section */}
        {(visibleSalesNav.length > 0 || visibleCrmNav.length > 0) && (
          <>
            <div className="mx-2 border-t border-white/[0.08] my-3" />
            <p className="px-2 text-[10px] font-semibold text-white/25 uppercase tracking-[0.12em] mb-2">
              Sales & CRM
            </p>
            {[...visibleSalesNav, ...visibleCrmNav].map(n => (
              <NavLink
                key={n.page}
                to={n.path}
                onClick={onNav}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all mb-0.5 ${
                    isActive
                      ? 'bg-white/[0.1] text-white'
                      : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span className={`material-symbols-rounded text-[19px] flex-shrink-0 ${isActive ? 'opacity-100' : 'opacity-60'}`}>
                      {n.icon}
                    </span>
                    {n.label}
                    {isActive && <span className="ml-auto w-1 h-4 rounded-full bg-accent flex-shrink-0" />}
                  </>
                )}
              </NavLink>
            ))}
          </>
        )}

        {canAccess('admin') && (
          <>
            <div className="mx-2 border-t border-white/[0.08] my-3" />
            <p className="px-2 text-[10px] font-semibold text-white/25 uppercase tracking-[0.12em] mb-2">
              Admin
            </p>
            <NavLink
              to="/admin"
              onClick={onNav}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                  isActive
                    ? 'bg-white/[0.1] text-white'
                    : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className={`material-symbols-rounded text-[19px] flex-shrink-0 ${isActive ? 'opacity-100' : 'opacity-60'}`}>
                    manage_accounts
                  </span>
                  Settings
                  {isActive && <span className="ml-auto w-1 h-4 rounded-full bg-accent flex-shrink-0" />}
                </>
              )}
            </NavLink>
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="flex-shrink-0 p-3">
        <div className="mx-1 border-t border-white/[0.08] mb-3" />
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/[0.05] transition-colors group">
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-white truncate leading-tight">
              {user.full_name || user.email}
            </p>
            <p className="text-[10px] text-white/35 capitalize leading-tight mt-0.5">
              {(user.role || '').replace(/_/g, ' ')}
            </p>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            className="opacity-0 group-hover:opacity-100 text-white/40 hover:text-white/80 transition-all flex-shrink-0"
          >
            <span className="material-symbols-rounded text-[18px]">logout</span>
          </button>
        </div>
      </div>
    </>
  )
}

/* ── Page title from route ───────────────────────────────────────────────── */
function PageTitle() {
  const { pathname } = useLocation()
  const titles = {
    '/':                 'Overview',
    '/transactions':     'Transactions',
    '/cards':            'Cards',
    '/sales':            'Sales & Growth',
    '/collections':      'Collections',
    '/recovery':         'Recovery',
    '/cohort':           'Cohort Analysis',
    '/admin':            'Settings',
    '/income':           'Income Report',
    '/uploads':          'Data Uploads',
    '/eod':              'EOD Report',
    '/reconciliation':   'Reconciliation',
    '/call-center':      'Call Center',
    '/crm/pipeline':     'Pipeline',
    '/crm/contacts':     'Contacts',
    '/crm/tasks':        'Tasks',
    '/crm/requests':     'Requests',
    '/crm/reports':      'CRM Reports',
  }
  const title = pathname.startsWith('/crm/contacts/')
    ? 'Customer 360'
    : (titles[pathname] || 'Dashboard')
  return <p className="text-[15px] font-semibold text-slate-800 dark:text-slate-100">{title}</p>
}

function Guard({ page, ca, children }) {
  if (!ca(page)) return <Navigate to="/" replace />
  return children
}

function DefaultRedirect({ canAccess }) {
  const first = [...REPORTING_NAV, ...SALES_NAV, ...CRM_NAV].find(n => canAccess(n.page))
  return <Navigate to={first?.path || '/'} replace />
}
