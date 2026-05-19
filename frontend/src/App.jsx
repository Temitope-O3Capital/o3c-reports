import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth.js'
import { useState } from 'react'
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

const NAV_ITEMS = [
  { page: 'overview',      label: 'Overview',      path: '/',               icon: <IconOverview /> },
  { page: 'transactions',  label: 'Transactions',  path: '/transactions',   icon: <IconTxn /> },
  { page: 'cards',         label: 'Cards',         path: '/cards',          icon: <IconCards /> },
  { page: 'sales',         label: 'Sales',         path: '/sales',          icon: <IconSales /> },
  { page: 'collections',   label: 'Collections',   path: '/collections',    icon: <IconCollect /> },
  { page: 'recovery',      label: 'Recovery',      path: '/recovery',       icon: <IconRecovery /> },
  { page: 'cohort',        label: 'Cohort',        path: '/cohort',         icon: <IconCohort /> },
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
  const [lastSync, setLastSync]     = useState(null)
  const [syncOpen, setSyncOpen]     = useState(false)

  if (loading) return <div className="loading"><div className="spinner" />Loading…</div>
  if (!user)   return <Login onLogin={login} />

  const initials = (user.full_name || user.email)
    .split(' ').slice(0,2).map(w => w[0].toUpperCase()).join('')

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="brand">O3<span>C</span> Cards</div>
          <div className="tagline">Reports Dashboard</div>
        </div>

        <ul className="sidebar-nav">
          {NAV_ITEMS.filter(n => canAccess(n.page)).map(n => (
            <li key={n.page}>
              <NavLink
                to={n.path}
                end={n.path === '/'}
                className={({ isActive }) => isActive ? 'active' : ''}
              >
                {n.icon}
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="avatar">{initials}</div>
            <div className="info">
              <div className="name">{user.full_name || user.email}</div>
              <div className="role">{user.role?.replace('_', ' ')}</div>
            </div>
            <button className="logout-btn" onClick={logout} title="Sign out">
              <IconLogout />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="main-content">
        <header className="topbar">
          <span className="topbar-title">O3C Cards · Reporting</span>
          <div className="topbar-right">
            <DataBanner source={dataSource} lastSync={lastSync} />
            {user.role === 'admin' && (
              <button className="btn btn-navy" style={{fontSize:12,padding:'6px 12px'}} onClick={() => setSyncOpen(true)}>
                ↻ Sync
              </button>
            )}
          </div>
        </header>

        <div className="page-body">
          <Routes>
            <Route path="/"             element={<Guard page="overview">     <Overview     setDs={setDataSource} /></Guard>} />
            <Route path="/transactions" element={<Guard page="transactions">  <Transactions setDs={setDataSource} /></Guard>} />
            <Route path="/cards"        element={<Guard page="cards">        <Cards        setDs={setDataSource} /></Guard>} />
            <Route path="/sales"        element={<Guard page="sales">        <Sales        setDs={setDataSource} /></Guard>} />
            <Route path="/collections"  element={<Guard page="collections">  <Collections  setDs={setDataSource} /></Guard>} />
            <Route path="/recovery"     element={<Guard page="recovery">     <Recovery     setDs={setDataSource} /></Guard>} />
            <Route path="/cohort"       element={<Guard page="cohort">       <Cohort       setDs={setDataSource} /></Guard>} />
            <Route path="*"             element={<DefaultRedirect canAccess={canAccess} />} />
          </Routes>
        </div>
      </div>

      {syncOpen && <SyncPanel onClose={() => setSyncOpen(false)} onSynced={setLastSync} />}
    </div>
  )
}

function Guard({ page, children }) {
  const { canAccess } = useAuth()
  if (!canAccess(page)) return <Navigate to="/" replace />
  return children
}

function DefaultRedirect({ canAccess }) {
  const first = NAV_ITEMS.find(n => canAccess(n.page))
  return <Navigate to={first?.path || '/'} replace />
}

/* ── Inline SVG icons ─────────────────────────────────────────────────────── */
function IconOverview() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>
}
function IconTxn() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
  </svg>
}
function IconCards() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <rect x="2" y="6" width="20" height="13" rx="2"/>
    <path strokeLinecap="round" d="M2 10h20"/>
    <path strokeLinecap="round" d="M6 14h4"/>
  </svg>
}
function IconSales() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
  </svg>
}
function IconCollect() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 14l-4-4 4-4M15 10h6M3 10h6"/>
    <circle cx="12" cy="18" r="3"/>
  </svg>
}
function IconRecovery() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
  </svg>
}
function IconCohort() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-5.916-3.516M9 20H4v-2a4 4 0 015.916-3.516M15 7a3 3 0 11-6 0 3 3 0 016 0zM21 12a3 3 0 11-6 0 3 3 0 016 0zM3 12a3 3 0 116 0 3 3 0 01-6 0z"/>
  </svg>
}
function IconLogout() {
  return <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
  </svg>
}
