import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import Sidebar from './components/Sidebar'
import Login from './pages/Login'
import Overview from './pages/Overview'
import { AuthUser } from './hooks/useAuth'

// Finance
const FinanceOverview = lazy(() => import('./pages/finance/Overview'))
const Transactions    = lazy(() => import('./pages/finance/Transactions'))
const Collections     = lazy(() => import('./pages/finance/Collections'))
const Recovery        = lazy(() => import('./pages/finance/Recovery'))
const Reconciliation  = lazy(() => import('./pages/finance/Reconciliation'))
const Eod             = lazy(() => import('./pages/finance/Eod'))
const Income          = lazy(() => import('./pages/finance/Income'))

// Sales
const SalesOverview   = lazy(() => import('./pages/sales/Overview'))
const Customers       = lazy(() => import('./pages/sales/Customers'))
const SalesCards      = lazy(() => import('./pages/sales/Cards'))
const Cohort          = lazy(() => import('./pages/sales/Cohort'))

// Cards & Ops
const CardsOverview   = lazy(() => import('./pages/cards/Overview'))
const CardTrends      = lazy(() => import('./pages/cards/Trends'))
const CardManagement  = lazy(() => import('./pages/cards/Management'))

// CRM
const CrmContacts     = lazy(() => import('./pages/crm/Contacts'))
const CrmPipeline     = lazy(() => import('./pages/crm/Pipeline'))
const CrmTasks        = lazy(() => import('./pages/crm/Tasks'))
const CrmReports      = lazy(() => import('./pages/crm/Reports'))

// Operations
const CreditPortfolio = lazy(() => import('./pages/operations/CreditPortfolio'))
const FixedDeposit    = lazy(() => import('./pages/operations/FixedDeposit'))
const Settlement      = lazy(() => import('./pages/operations/Settlement'))
const MobileApp       = lazy(() => import('./pages/operations/MobileApp'))
const BlinkCard       = lazy(() => import('./pages/operations/BlinkCard'))

// Platform
const Campaigns       = lazy(() => import('./pages/Campaigns'))
const Watch           = lazy(() => import('./pages/Watch'))
const Settings        = lazy(() => import('./pages/Settings'))
const AdminUsers      = lazy(() => import('./pages/AdminUsers'))

function Placeholder({ title, dept, icon = 'construction' }: { title: string; dept?: string; icon?: string }) {
  return (
    <div className="px-8 py-8 animate-fadeIn">
      {dept && (
        <p className="text-[13px] text-slate-400 mb-1">
          <span className="text-slate-600 font-medium">{dept}</span>
          <span className="mx-1.5 text-slate-300">›</span>
          <span className="text-slate-500">{title}</span>
        </p>
      )}
      <div className="flex flex-col items-center justify-center min-h-[55vh] text-center">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
          style={{ background: 'rgba(14,40,65,0.06)' }}>
          <span className="material-symbols-rounded text-[24px]" style={{ color: '#0E2841' }}>{icon}</span>
        </div>
        <h2 className="text-[15px] font-semibold text-slate-700 dark:text-slate-200 mb-1">{title}</h2>
        <p className="text-[13px] text-slate-400 max-w-xs leading-relaxed">
          Being built as part of the platform rebuild.
        </p>
      </div>
    </div>
  )
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-8 h-8 border-2 rounded-full animate-spin"
        style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: '#0E2841' }} />
    </div>
  )
}

function parseToken(token: string): { exp: number } | null {
  try { return JSON.parse(atob(token.split('.')[1])) } catch { return null }
}

export default function App() {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [dark,    setDark]    = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('o3c_token')
    const stored = localStorage.getItem('o3c_user')
    if (token && stored) {
      const payload = parseToken(token)
      if (payload && payload.exp * 1000 > Date.now()) {
        setUser(JSON.parse(stored))
      } else {
        localStorage.removeItem('o3c_token')
        localStorage.removeItem('o3c_user')
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  function handleLogin(u: AuthUser) {
    setUser(u)
    toast.success(`Welcome back, ${u.name.split(' ')[0]}`, {
      description: `Signed in as ${u.role.replace(/_/g, ' ')}`,
    })
  }

  function handleLogout() {
    localStorage.removeItem('o3c_token')
    localStorage.removeItem('o3c_user')
    setUser(null)
    toast.info('Signed out')
  }

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#F6F5F2]">
      <div className="w-8 h-8 border-2 rounded-full animate-spin"
        style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: '#0E2841' }} />
    </div>
  )

  if (!user) return (
    <>
      <Toaster richColors position="top-right" />
      <Login onLogin={handleLogin} />
    </>
  )

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-[#F6F5F2] dark:bg-[#0B1120]">
        <Toaster richColors position="top-right" />
        <Sidebar user={user} onLogout={handleLogout} />

        <div className="flex-1 flex flex-col overflow-hidden">
          <header className="flex items-center justify-end gap-1 px-6 py-2.5 flex-shrink-0"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <button onClick={() => setDark(d => !d)}
              className="p-2 rounded-lg transition-colors text-slate-400 hover:text-slate-700 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              aria-label="Toggle dark mode">
              <span className="material-symbols-rounded text-[19px]">{dark ? 'light_mode' : 'dark_mode'}</span>
            </button>
            <button onClick={() => toast.info('No new notifications')}
              className="relative p-2 rounded-lg transition-colors text-slate-400 hover:text-slate-700 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              aria-label="Notifications">
              <span className="material-symbols-rounded text-[19px]">notifications</span>
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full" style={{ background: '#C00000' }} />
            </button>
          </header>

          <main className="flex-1 overflow-y-auto">
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/"                            element={<Overview />} />
                <Route path="/approvals"                   element={<Placeholder title="Approvals" icon="approval_delegation" />} />

                {/* Finance */}
                <Route path="/finance"                     element={<FinanceOverview />} />
                <Route path="/finance/transactions"        element={<Transactions />} />
                <Route path="/finance/collections"         element={<Collections />} />
                <Route path="/finance/recovery"            element={<Recovery />} />
                <Route path="/finance/reconciliation"      element={<Reconciliation />} />
                <Route path="/finance/eod"                 element={<Eod />} />
                <Route path="/finance/income"              element={<Income />} />

                {/* Sales */}
                <Route path="/sales"                       element={<SalesOverview />} />
                <Route path="/sales/customers"             element={<Customers />} />
                <Route path="/sales/cards"                 element={<SalesCards />} />
                <Route path="/sales/cohort"                element={<Cohort />} />

                {/* Cards & Ops */}
                <Route path="/cards"                       element={<CardsOverview />} />
                <Route path="/cards/trends"                element={<CardTrends />} />
                <Route path="/cards/management"            element={<CardManagement />} />

                {/* CRM */}
                <Route path="/crm/contacts"                element={<CrmContacts />} />
                <Route path="/crm/pipeline"                element={<CrmPipeline />} />
                <Route path="/crm/tasks"                   element={<CrmTasks />} />
                <Route path="/crm/reports"                 element={<CrmReports />} />

                {/* Operations */}
                <Route path="/operations/credit-portfolio" element={<CreditPortfolio />} />
                <Route path="/operations/fixed-deposit"    element={<FixedDeposit />} />
                <Route path="/operations/settlement"       element={<Settlement />} />
                <Route path="/operations/mobile-app"       element={<MobileApp />} />
                <Route path="/operations/blink-card"       element={<BlinkCard />} />

                {/* Marketing */}
                <Route path="/marketing/campaigns"         element={<Campaigns />} />
                <Route path="/marketing/templates"         element={<Placeholder title="Message Templates" dept="Marketing" icon="mail" />} />
                <Route path="/marketing/lists"             element={<Placeholder title="Contact Lists" dept="Marketing" icon="list_alt" />} />

                {/* Platform */}
                <Route path="/watch"                       element={<Watch />} />
                <Route path="/settings"                    element={<Settings />} />
                <Route path="/admin"                       element={<Placeholder title="Admin" icon="admin_panel_settings" />} />
                <Route path="/admin/users"                 element={<AdminUsers />} />

                <Route path="*"                            element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </BrowserRouter>
  )
}
