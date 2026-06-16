import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import Sidebar from './components/Sidebar'
import Login from './pages/Login'
import Overview from './pages/Overview'

type User = { name: string; role: string; email: string }

function Placeholder({ title, dept, icon = 'construction' }: { title: string; dept?: string; icon?: string }) {
  return (
    <div className="px-8 py-8 animate-fadeIn">
      {dept && (
        <p className="text-[13px] text-slate-400 mb-1">
          <span className="hover:text-slate-600 cursor-pointer transition-colors">{dept}</span>
          <span className="mx-1.5 text-slate-300">›</span>
          <span className="text-slate-600">{title}</span>
        </p>
      )}
      <div className="flex flex-col items-center justify-center min-h-[55vh] text-center">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
          style={{ background: 'rgba(14,40,65,0.06)' }}>
          <span className="material-symbols-rounded text-[24px]" style={{ color: '#0E2841' }}>{icon}</span>
        </div>
        <h2 className="text-[15px] font-semibold text-slate-700 dark:text-slate-200 mb-1">{title}</h2>
        <p className="text-[13px] text-slate-400 max-w-xs leading-relaxed">
          Being built as part of the full platform rebuild. The Overview dashboard is live now.
        </p>
      </div>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [dark, setDark] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  function handleLogin(u: User) {
    setUser(u)
    toast.success(`Welcome back, ${u.name.split(' ')[0]}`, { description: `Signed in as ${u.role}` })
  }
  function handleLogout() { setUser(null); toast.info('Signed out') }

  if (!user) return <Login onLogin={handleLogin} />

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-[#F6F5F2] dark:bg-[#0B1120]">
        <Toaster richColors position="top-right" />
        <Sidebar user={user} onLogout={handleLogout} />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Minimal top bar — just right-side controls */}
          <header className="flex items-center justify-end gap-1 px-6 py-2.5 flex-shrink-0"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.07)', background: 'transparent' }}>
            <button
              onClick={() => { setDark(d => !d) }}
              className="p-2 rounded-lg transition-colors text-slate-400 hover:text-slate-700 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              aria-label="Toggle dark mode">
              <span className="material-symbols-rounded text-[19px]">{dark ? 'light_mode' : 'dark_mode'}</span>
            </button>
            <button
              onClick={() => toast.success('No new notifications')}
              className="relative p-2 rounded-lg transition-colors text-slate-400 hover:text-slate-700 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              aria-label="Notifications">
              <span className="material-symbols-rounded text-[19px]">notifications</span>
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-o3c rounded-full" />
            </button>
          </header>

          <main className="flex-1 overflow-y-auto">
            <Routes>
              <Route path="/"                       element={<Overview />} />
              <Route path="/approvals"              element={<Placeholder title="Approvals"          icon="approval_delegation" />} />
              <Route path="/finance"                element={<Placeholder title="Finance Overview"   dept="Finance"    icon="account_balance" />} />
              <Route path="/finance/transactions"   element={<Placeholder title="Transactions"       dept="Finance"    icon="receipt_long" />} />
              <Route path="/finance/collections"    element={<Placeholder title="Collections"        dept="Finance"    icon="account_balance_wallet" />} />
              <Route path="/finance/recovery"       element={<Placeholder title="Recovery"           dept="Finance"    icon="health_and_safety" />} />
              <Route path="/finance/reconciliation" element={<Placeholder title="Reconciliation"     dept="Finance"    icon="balance" />} />
              <Route path="/finance/eod"            element={<Placeholder title="EOD Reports"        dept="Finance"    icon="summarize" />} />
              <Route path="/finance/income"         element={<Placeholder title="Income"             dept="Finance"    icon="payments" />} />
              <Route path="/sales"                  element={<Placeholder title="Sales Overview"     dept="Sales"      icon="trending_up" />} />
              <Route path="/sales/customers"        element={<Placeholder title="Customer Directory" dept="Sales"      icon="group" />} />
              <Route path="/sales/cards"            element={<Placeholder title="Card Issuance"      dept="Sales"      icon="add_card" />} />
              <Route path="/sales/cohort"           element={<Placeholder title="Cohort Analysis"    dept="Sales"      icon="grid_view" />} />
              <Route path="/cards"                  element={<Placeholder title="Cards Overview"     dept="Cards & Ops" icon="credit_card" />} />
              <Route path="/cards/trends"           element={<Placeholder title="Card Trends"        dept="Cards & Ops" icon="stacked_line_chart" />} />
              <Route path="/cards/management"       element={<Placeholder title="Card Management"    dept="Cards & Ops" icon="manage_accounts" />} />
              <Route path="/crm/contacts"           element={<Placeholder title="Contacts"           dept="CRM"        icon="contacts" />} />
              <Route path="/crm/pipeline"           element={<Placeholder title="Pipeline"           dept="CRM"        icon="view_kanban" />} />
              <Route path="/crm/tasks"              element={<Placeholder title="Tasks"              dept="CRM"        icon="task_alt" />} />
              <Route path="/crm/reports"            element={<Placeholder title="CRM Reports"        dept="CRM"        icon="bar_chart" />} />
              <Route path="/marketing/campaigns"    element={<Placeholder title="Campaigns"          dept="Marketing"  icon="campaign" />} />
              <Route path="/marketing/templates"    element={<Placeholder title="Message Templates"  dept="Marketing"  icon="mail" />} />
              <Route path="/marketing/lists"        element={<Placeholder title="Contact Lists"      dept="Marketing"  icon="list_alt" />} />
              <Route path="/watch"                  element={<Placeholder title="Watch List"         icon="visibility" />} />
              <Route path="/settings"               element={<Placeholder title="Settings"           icon="settings" />} />
              <Route path="/admin"                  element={<Placeholder title="Admin"              icon="admin_panel_settings" />} />
              <Route path="/admin/users"            element={<Placeholder title="User Management"    dept="Admin"      icon="manage_accounts" />} />
              <Route path="*"                       element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  )
}
