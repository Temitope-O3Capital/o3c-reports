import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth.js'
import DataBanner from './components/DataBanner.jsx'
import SyncPanel from './components/SyncPanel.jsx'
import Login from './pages/Login.jsx'
import Overview from './pages/Overview.jsx'
import Transactions from './pages/Transactions.jsx'
import Collections from './pages/Collections.jsx'
import Recovery from './pages/Recovery.jsx'
import Sales from './pages/Sales.jsx'
import Cards from './pages/Cards.jsx'
import Cohort from './pages/Cohort.jsx'
import Admin from './pages/Admin.jsx'

const NAV_ITEMS = [
  { page: 'overview',      label: 'Overview',      path: '/',             icon: 'grid_view' },
  { page: 'transactions',  label: 'Transactions',  path: '/transactions', icon: 'receipt_long' },
  { page: 'cards',         label: 'Cards',         path: '/cards',        icon: 'credit_card' },
  { page: 'sales',         label: 'Sales',         path: '/sales',        icon: 'trending_up' },
  { page: 'collections',   label: 'Collections',   path: '/collections',  icon: 'account_balance' },
  { page: 'recovery',      label: 'Recovery',      path: '/recovery',     icon: 'gavel' },
  { page: 'cohort',        label: 'Cohort',        path: '/cohort',       icon: 'groups' },
  { page: 'admin',         label: 'Settings',      path: '/admin',        icon: 'manage_accounts' },
]

export default function App() {
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  )
}

function AppInner() {
  const { user, loading, login, logout, canAccess } = useAuth()
  const [dataSource, setDataSource] = useState(null)
  const [lastSync,   setLastSync]   = useState(null)
  const [syncOpen,   setSyncOpen]   = useState(false)
  const [sideOpen,   setSideOpen]   = useState(false)
  const [isDark,     setIsDark]     = useState(() => localStorage.getItem('o3c_theme') === 'dark')

  useEffect(() => {
    if (isDark) document.documentElement.classList.add('dark')
    else        document.documentElement.classList.remove('dark')
    localStorage.setItem('o3c_theme', isDark ? 'dark' : 'light')
  }, [isDark])

  if (loading) return (
    <div className="flex items-center justify-center h-screen bg-slate-50 dark:bg-slate-900">
      <div className="flex flex-col items-center gap-3">
        <div className="spinner" />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    </div>
  )

  if (!user) return <Login onLogin={login} />

  const initials = (user.full_name || user.email)
    .split(' ').slice(0, 2).map(w => w[0].toUpperCase()).join('')

  const visibleNav = NAV_ITEMS.filter(n => canAccess(n.page))

  const Sidebar = ({ mobile = false }) => (
    <aside className={`flex flex-col bg-primary dark:bg-primary-dark h-full ${mobile ? 'w-72' : 'w-64'}`}>
      {/* Brand */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xl font-black text-white tracking-tight">
            O3<span className="text-accent">C</span>
          </span>
          <span className="text-white/40 text-xs font-medium mt-0.5">Cards</span>
        </div>
        <p className="text-white/40 text-[11px] font-medium tracking-widest uppercase">Reports Dashboard</p>
      </div>

      <div className="mx-4 border-t border-white/10 mb-3" />

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        <p className="px-3 text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-2">Dashboards</p>
        {visibleNav.filter(n => n.page !== 'admin').map(n => (
          <NavLink
            key={n.page}
            to={n.path}
            end={n.path === '/'}
            onClick={() => setSideOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-white/15 text-white border-l-2 border-accent ml-0 pl-[10px]'
                  : 'text-white/60 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <span className="material-symbols-outlined text-[20px]">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}

        {canAccess('admin') && (
          <>
            <div className="mx-3 border-t border-white/10 my-3" />
            <p className="px-3 text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-2">Admin</p>
            <NavLink
              to="/admin"
              onClick={() => setSideOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-white/15 text-white border-l-2 border-accent pl-[10px]'
                    : 'text-white/60 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <span className="material-symbols-outlined text-[20px]">manage_accounts</span>
              Settings
            </NavLink>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="p-4 mt-auto">
        <div className="mx-0 border-t border-white/10 mb-3" />
        <button
          onClick={() => setIsDark(d => !d)}
          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-colors mb-2"
        >
          <span className="material-symbols-outlined text-[18px]">{isDark ? 'light_mode' : 'dark_mode'}</span>
          {isDark ? 'Light mode' : 'Dark mode'}
        </button>
        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/10 transition-colors">
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white font-semibold truncate">{user.full_name || user.email}</p>
            <p className="text-[11px] text-white/40 capitalize">{(user.role || '').replace('_', ' ')}</p>
          </div>
          <button onClick={logout} title="Sign out" className="text-white/40 hover:text-white transition-colors">
            <span className="material-symbols-outlined text-[18px]">logout</span>
          </button>
        </div>
      </div>
    </aside>
  )

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-900 overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-shrink-0 h-screen sticky top-0">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      {sideOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-black/50" onClick={() => setSideOpen(false)} />
          <div className="relative z-10 h-full">
            <Sidebar mobile />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Topbar */}
        <header className="sticky top-0 z-40 flex items-center gap-4 bg-white/90 dark:bg-slate-800/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-700 px-4 lg:px-6 py-3">
          <button
            className="lg:hidden icon-btn"
            onClick={() => setSideOpen(true)}
          >
            <span className="material-symbols-outlined">menu</span>
          </button>

          <div className="flex-1 min-w-0">
            <DataBanner source={dataSource} lastSync={lastSync} />
          </div>

          <div className="flex items-center gap-2">
            {user.role === 'admin' && (
              <button
                onClick={() => setSyncOpen(true)}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary-light transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">sync</span>
                Sync
              </button>
            )}
          </div>
        </header>

        {/* Page body */}
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/"             element={<Guard page="overview"     canAccess={canAccess}><Overview     setDs={setDataSource} /></Guard>} />
            <Route path="/transactions" element={<Guard page="transactions" canAccess={canAccess}><Transactions setDs={setDataSource} /></Guard>} />
            <Route path="/cards"        element={<Guard page="cards"        canAccess={canAccess}><Cards        setDs={setDataSource} /></Guard>} />
            <Route path="/sales"        element={<Guard page="sales"        canAccess={canAccess}><Sales        setDs={setDataSource} /></Guard>} />
            <Route path="/collections"  element={<Guard page="collections"  canAccess={canAccess}><Collections  setDs={setDataSource} /></Guard>} />
            <Route path="/recovery"     element={<Guard page="recovery"     canAccess={canAccess}><Recovery     setDs={setDataSource} /></Guard>} />
            <Route path="/cohort"       element={<Guard page="cohort"       canAccess={canAccess}><Cohort       setDs={setDataSource} /></Guard>} />
            <Route path="/admin"        element={<Guard page="admin"        canAccess={canAccess}><Admin /></Guard>} />
            <Route path="*"             element={<DefaultRedirect canAccess={canAccess} />} />
          </Routes>
        </main>
      </div>

      {syncOpen && (
        <SyncPanel onClose={() => setSyncOpen(false)} onSynced={setLastSync} />
      )}
    </div>
  )
}

function Guard({ page, canAccess, children }) {
  if (!canAccess(page)) return <Navigate to="/" replace />
  return children
}

function DefaultRedirect({ canAccess }) {
  const first = NAV_ITEMS.find(n => canAccess(n.page))
  return <Navigate to={first?.path || '/'} replace />
}
