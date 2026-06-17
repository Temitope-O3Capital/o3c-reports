import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import Sidebar from './components/Sidebar'
import NotificationBell from './components/NotificationBell'
import Login from './pages/Login'
import Overview from './pages/Overview'
import { AuthUser } from './hooks/useAuth'
import { roleLabel } from './lib/roles'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// ── Role → home route ─────────────────────────────────────────────────────────

function homeFor(role: string): string {
  const map: Record<string, string> = {
    md: '/', coo: '/', cfo: '/', cmo: '/', executive: '/',
    admin: '/', management: '/', head_ops: '/', head_it: '/',
    sales_officer: '/sales',   sales_head: '/sales',
    risk_officer:  '/risk',    risk_head: '/risk',
    finance_officer: '/finance', finance_head: '/finance',
    cards_ops_officer: '/cards', cards_ops_head: '/cards',
    collections_agent: '/collections', collections_head: '/collections',
    recovery_agent: '/recovery',       recovery_head: '/recovery',
    call_center_agent: '/customer-service', call_center_head: '/customer-service',
    hr_officer: '/hr',         hr_manager: '/hr',
    compliance_officer: '/compliance', compliance_head: '/compliance',
    internal_control_head: '/compliance',
    it_admin: '/admin',
  }
  return map[role] ?? '/finance'
}

// ── Lazy imports ──────────────────────────────────────────────────────────────

// Finance
const FinanceOverview  = lazy(() => import('./pages/finance/Overview'))
const Transactions     = lazy(() => import('./pages/finance/Transactions'))
const Eod              = lazy(() => import('./pages/finance/Eod'))
const Income           = lazy(() => import('./pages/finance/Income'))
const FixedDeposit     = lazy(() => import('./pages/operations/FixedDeposit'))

// Sales
const SalesOverview    = lazy(() => import('./pages/sales/Overview'))
const Customers        = lazy(() => import('./pages/sales/Customers'))

// CRM (now under /sales)
const CrmPipeline      = lazy(() => import('./pages/crm/Pipeline'))
const CrmTasks         = lazy(() => import('./pages/crm/Tasks'))

// LOS (now under /sales/applications and /risk/applications)
const LOSQueue         = lazy(() => import('./pages/los/Queue'))
const LOSAll           = lazy(() => import('./pages/los/AllApplications'))
const LOSNew           = lazy(() => import('./pages/los/NewApplication'))
const LOSDetail        = lazy(() => import('./pages/los/ApplicationDetail'))

// Risk
const RiskOverview     = lazy(() => import('./pages/risk/Overview'))
const RiskPortfolio    = lazy(() => import('./pages/risk/Portfolio'))

// Cards & Channels
const CardsOverview    = lazy(() => import('./pages/cards/Overview'))
const CardTrends       = lazy(() => import('./pages/cards/Trends'))
const CardManagement   = lazy(() => import('./pages/cards/Management'))
const BlinkCard        = lazy(() => import('./pages/operations/BlinkCard'))
const MobileApp        = lazy(() => import('./pages/operations/MobileApp'))

// Collections
const CollectionsOverview = lazy(() => import('./pages/collections/Overview'))
const CollectionsQueue    = lazy(() => import('./pages/collections-ops/Queue'))
const CollectionsTargets  = lazy(() => import('./pages/collections-ops/Targets'))
const CollectionsPromises = lazy(() => import('./pages/collections-ops/Promises'))

// Recovery
const RecoveryOverview = lazy(() => import('./pages/recovery/Overview'))
const RecoveryCases    = lazy(() => import('./pages/recovery-ops/Cases'))
const RecoveryLegal    = lazy(() => import('./pages/recovery-ops/Legal'))
const RecoveryVisits   = lazy(() => import('./pages/recovery-ops/Visits'))

// Settlements
const SettlementsOverview = lazy(() => import('./pages/settlements/Overview'))
const Reconciliation      = lazy(() => import('./pages/finance/Reconciliation'))

// Customer 360
const Customer360      = lazy(() => import('./pages/customer360/Customer360'))

// HR
const HREmployees      = lazy(() => import('./pages/hr/Employees'))
const HRLeave          = lazy(() => import('./pages/hr/Leave'))
const HRDisciplinary   = lazy(() => import('./pages/hr/Disciplinary'))
const HRTraining       = lazy(() => import('./pages/hr/Training'))
const HRPerformance    = lazy(() => import('./pages/hr/Performance'))

// Compliance
const AuditTrail       = lazy(() => import('./pages/compliance/AuditTrail'))
const CbnReports       = lazy(() => import('./pages/compliance/CbnReports'))
const Sars             = lazy(() => import('./pages/compliance/Sars'))
const WatchList        = lazy(() => import('./pages/compliance/WatchList'))
const Findings         = lazy(() => import('./pages/compliance/Findings'))
const Checklists       = lazy(() => import('./pages/compliance/Checklists'))

// Campaigns (was /marketing/*)
const Campaigns        = lazy(() => import('./pages/Campaigns'))
const MessageTemplates = lazy(() => import('./pages/marketing/MessageTemplates'))
const ContactLists     = lazy(() => import('./pages/marketing/ContactLists'))

// Customer Service
const CSOverview       = lazy(() => import('./pages/customer-service/Overview'))
const CSCalls          = lazy(() => import('./pages/customer-service/Calls'))

// Admin
const UserManagement   = lazy(() => import('./pages/admin/UserManagement'))
const PlatformSettings = lazy(() => import('./pages/admin/PlatformSettings'))
const SyncStatus       = lazy(() => import('./pages/admin/SyncStatus'))
const ApiKeys          = lazy(() => import('./pages/admin/ApiKeys'))

// Reports & Approvals
const Reports          = lazy(() => import('./pages/reports/Reports'))
const Approvals        = lazy(() => import('./pages/Approvals'))

// Other platform pages
const Watch            = lazy(() => import('./pages/Watch'))

// ── Shared UI helpers ─────────────────────────────────────────────────────────

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
        <h2 className="text-[15px] font-semibold text-slate-700 mb-1">{title}</h2>
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

// ── Approvals slide-over button ───────────────────────────────────────────────

interface ApprovalItem {
  id:     number
  module: string
  title:  string
  type:   string
  url:    string
}

interface ApprovalSummary {
  total: number
  items: ApprovalItem[]
}

function ApprovalsButton({ user }: { user: AuthUser }) {
  const [open,     setOpen]    = useState(false)
  const [summary,  setSummary] = useState<ApprovalSummary | null>(null)
  const navigate               = useNavigate()
  const intervalRef            = useRef<ReturnType<typeof setInterval> | null>(null)

  async function fetchSummary() {
    try {
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}/api/approvals/summary`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.ok) setSummary(await res.json())
    } catch {
      // silently ignore — bell won't show a count
    }
  }

  useEffect(() => {
    fetchSummary()
    intervalRef.current = setInterval(fetchSummary, 30_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [user.id])

  const total = summary?.total ?? 0

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Pending approvals"
        className="relative flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-slate-100">
        <span className="material-symbols-rounded text-[20px]" style={{ color: '#0E2841' }}>approval</span>
        {total > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center px-1 text-[10px] font-bold text-white rounded-full"
            style={{ background: '#C00000' }}>
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,0.25)' }}
          onClick={() => setOpen(false)}
        />
      )}

      {/* Slide-over panel */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col bg-white shadow-2xl transition-transform duration-200"
        style={{
          width:     '420px',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          borderLeft: '1px solid rgba(15,23,42,0.08)',
        }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-800">Pending Approvals</h2>
            {total > 0 && (
              <p className="text-[12px] text-slate-400 mt-0.5">{total} item{total !== 1 ? 's' : ''} awaiting review</p>
            )}
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            aria-label="Close">
            <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!summary && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 rounded-full animate-spin"
                style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: '#0E2841' }} />
            </div>
          )}

          {summary && total === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <span className="material-symbols-rounded text-[36px] mb-3" style={{ color: '#0E2841', opacity: 0.2 }}>
                check_circle
              </span>
              <p className="text-[14px] font-medium text-slate-600">All clear</p>
              <p className="text-[12px] text-slate-400 mt-1">No pending approvals</p>
            </div>
          )}

          {summary && total > 0 && (
            <div className="space-y-2">
              {summary.items.map(item => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors"
                  style={{ border: '1px solid rgba(15,23,42,0.07)' }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ background: 'rgba(14,40,65,0.06)' }}>
                    <span className="material-symbols-rounded text-[16px]" style={{ color: '#0E2841' }}>
                      pending_actions
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-slate-700 leading-tight truncate">{item.title}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5 capitalize">{item.module} · {item.type}</p>
                  </div>
                  <button
                    onClick={() => { setOpen(false); navigate(item.url) }}
                    className="text-[12px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors flex-shrink-0"
                    style={{ color: '#0E2841', background: 'rgba(14,40,65,0.07)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(14,40,65,0.13)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(14,40,65,0.07)')}>
                    Review
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer link to full approvals page */}
        <div className="flex-shrink-0 px-5 py-3" style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }}>
          <button
            onClick={() => { setOpen(false); navigate('/approvals') }}
            className="w-full py-2.5 text-[13px] font-semibold rounded-xl transition-colors"
            style={{ background: 'rgba(14,40,65,0.06)', color: '#0E2841' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(14,40,65,0.11)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(14,40,65,0.06)')}>
            View all approvals
          </button>
        </div>
      </div>
    </>
  )
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function parseToken(token: string): { exp: number } | null {
  try { return JSON.parse(atob(token.split('.')[1])) } catch { return null }
}

// ── Force change password wall ────────────────────────────────────────────────

function ForceChangePassword({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const [current,  setCurrent]  = useState('')
  const [next,     setNext]     = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [saving,   setSaving]   = useState(false)
  const [err,      setErr]      = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (next !== confirm) { setErr('Passwords do not match'); return }
    if (next.length < 8)  { setErr('Password must be at least 8 characters'); return }
    setSaving(true); setErr('')
    try {
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ current_password: current, new_password: next }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed'); }
      onDone()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F6F5F2] p-4">
      <div style={{ background: '#fff', borderRadius: 20, padding: 36, width: '100%', maxWidth: 420,
        boxShadow: '0 20px 60px rgba(0,0,0,0.12)' }}>
        <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
          style={{ background: '#0E2841' }}>
          <span className="material-symbols-rounded text-white text-[22px]">lock_reset</span>
        </div>
        <h1 className="text-[20px] font-bold text-slate-800 mb-1">Set a New Password</h1>
        <p className="text-[13px] text-slate-500 mb-6">
          Your account requires a password change before you can continue.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          {[
            { label: 'Current Password',  val: current,  set: setCurrent },
            { label: 'New Password',      val: next,     set: setNext },
            { label: 'Confirm Password',  val: confirm,  set: setConfirm },
          ].map(f => (
            <div key={f.label}>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">{f.label}</label>
              <input type="password" required value={f.val} onChange={e => f.set(e.target.value)}
                className="w-full rounded-xl border px-3 py-2.5 text-[13px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
            </div>
          ))}
          {err && <p className="text-[12px] text-red-600 bg-red-50 px-3 py-2 rounded-lg">{err}</p>}
          <button type="submit" disabled={saving}
            className="w-full py-3 rounded-xl text-[14px] font-semibold text-white mt-2 disabled:opacity-60"
            style={{ background: '#0E2841' }}>
            {saving ? 'Saving…' : 'Change Password & Continue'}
          </button>
        </form>
        <button onClick={onLogout} className="mt-3 w-full text-[12px] text-slate-400 hover:text-slate-600">
          Sign out instead
        </button>
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

const MGMT_ROLES = ['md', 'coo', 'cfo', 'cmo', 'executive', 'admin', 'management', 'head_ops', 'head_it']

export default function App() {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    try {
      const token  = localStorage.getItem('o3c_token')
      const stored = localStorage.getItem('o3c_user')
      if (token && stored) {
        const payload = parseToken(token)
        if (payload && payload.exp * 1000 > Date.now()) {
          const u = JSON.parse(stored)
          if (u && typeof u.name === 'string' && typeof u.role === 'string') {
            setUser(u)
          } else {
            localStorage.removeItem('o3c_token')
            localStorage.removeItem('o3c_user')
          }
        } else {
          localStorage.removeItem('o3c_token')
          localStorage.removeItem('o3c_user')
        }
      }
    } catch {
      localStorage.removeItem('o3c_token')
      localStorage.removeItem('o3c_user')
    }
    setLoading(false)
  }, [])

  function handleLogin(u: AuthUser) {
    setUser(u)
    toast.success(`Welcome back, ${u.name.split(' ')[0]}`, {
      description: `Signed in as ${roleLabel(u.role as string)}`,
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

  // Force password change if flagged (e.g. after admin reset)
  if (user.must_change_password) return (
    <>
      <Toaster richColors position="top-right" />
      <ForceChangePassword onDone={() => {
        setUser(u => u ? { ...u, must_change_password: false } : u)
        const stored = localStorage.getItem('o3c_user')
        if (stored) {
          try { localStorage.setItem('o3c_user', JSON.stringify({ ...JSON.parse(stored), must_change_password: false })) } catch {}
        }
      }} onLogout={handleLogout} />
    </>
  )

  const role = user.role as string
  const isManagement = MGMT_ROLES.includes(role)

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-[#F6F5F2]">
        <Toaster richColors position="top-right" />
        <Sidebar user={user} onLogout={handleLogout} />

        <div className="flex-1 flex flex-col overflow-hidden">
          <header
            className="flex items-center justify-end gap-2 px-6 py-2.5 flex-shrink-0"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <ApprovalsButton user={user} />
            <NotificationBell />
          </header>

          <main className="flex-1 overflow-y-auto">
            <Suspense fallback={<PageLoader />}>
              <Routes>
                {/* Root — redirect non-management users to their home module */}
                <Route path="/"
                  element={isManagement
                    ? <Overview />
                    : <Navigate to={homeFor(role)} replace />
                  }
                />

                {/* Approvals — keep this page, button is additive */}
                <Route path="/approvals" element={<Approvals />} />

                {/* ── Finance ── */}
                <Route path="/finance"              element={<FinanceOverview />} />
                <Route path="/finance/transactions" element={<Transactions />} />
                <Route path="/finance/income"       element={<Income />} />
                <Route path="/finance/fixed-deposit"element={<FixedDeposit />} />
                <Route path="/finance/eod"          element={<Eod />} />

                {/* ── Sales & CRM ── */}
                <Route path="/sales"                    element={<SalesOverview />} />
                <Route path="/sales/customers"          element={<Customers />} />
                <Route path="/sales/crm"                element={<CrmPipeline />} />
                <Route path="/sales/tasks"              element={<CrmTasks />} />
                <Route path="/sales/applications"       element={<LOSQueue />} />
                <Route path="/sales/applications/new"   element={<LOSNew />} />
                <Route path="/sales/applications/:id"   element={<LOSDetail />} />

                {/* ── Risk & Credit ── */}
                <Route path="/risk"              element={<RiskOverview />} />
                <Route path="/risk/applications" element={<LOSAll />} />
                <Route path="/risk/portfolio"    element={<RiskPortfolio />} />

                {/* ── Settlements ── */}
                <Route path="/settlements"      element={<SettlementsOverview />} />
                <Route path="/settlements/recon"element={<Reconciliation />} />

                {/* ── Cards & Channels ── */}
                <Route path="/cards"           element={<CardsOverview />} />
                <Route path="/cards/trends"    element={<CardTrends />} />
                <Route path="/cards/management"element={<CardManagement />} />
                <Route path="/cards/blink"     element={<BlinkCard />} />
                <Route path="/cards/mobile-app"element={<MobileApp />} />

                {/* ── Collections ── */}
                <Route path="/collections"         element={<CollectionsOverview />} />
                <Route path="/collections/queue"   element={<CollectionsQueue />} />
                <Route path="/collections/targets" element={<CollectionsTargets />} />
                <Route path="/collections/promises"element={<CollectionsPromises />} />

                {/* ── Recovery ── */}
                <Route path="/recovery"        element={<RecoveryOverview />} />
                <Route path="/recovery/cases"  element={<RecoveryCases />} />
                <Route path="/recovery/legal"  element={<RecoveryLegal />} />
                <Route path="/recovery/visits" element={<RecoveryVisits />} />

                {/* ── Customer 360 ── */}
                <Route path="/customer360"      element={<Customer360 />} />
                <Route path="/customer360/:cif" element={<Customer360 />} />

                {/* ── Customer Service ── */}
                <Route path="/customer-service"       element={<CSOverview />} />
                <Route path="/customer-service/calls" element={<CSCalls />} />

                {/* ── HR ── */}
                <Route path="/hr"              element={<Placeholder title="HR Overview" dept="HR" icon="groups" />} />
                <Route path="/hr/employees"    element={<HREmployees />} />
                <Route path="/hr/leave"        element={<HRLeave />} />
                <Route path="/hr/performance"  element={<HRPerformance />} />
                <Route path="/hr/disciplinary" element={<HRDisciplinary />} />
                <Route path="/hr/training"     element={<HRTraining />} />

                {/* ── Compliance ── */}
                <Route path="/compliance"               element={<Placeholder title="Compliance Overview" dept="Compliance" icon="policy" />} />
                <Route path="/compliance/watchlist"     element={<WatchList />} />
                <Route path="/compliance/sars"          element={<Sars />} />
                <Route path="/compliance/cbn-reports"   element={<CbnReports />} />
                <Route path="/compliance/findings"      element={<Findings />} />
                <Route path="/compliance/checklists"    element={<Checklists />} />
                <Route path="/compliance/audit-trail"   element={<AuditTrail />} />

                {/* ── Campaigns ── */}
                <Route path="/campaigns"           element={<Campaigns />} />
                <Route path="/campaigns/templates" element={<MessageTemplates />} />
                <Route path="/campaigns/lists"     element={<ContactLists />} />

                {/* ── Reports ── */}
                <Route path="/reports" element={<Reports />} />

                {/* ── Admin ── */}
                <Route path="/admin"          element={<Navigate to="/admin/users" replace />} />
                <Route path="/admin/users"    element={<UserManagement />} />
                <Route path="/admin/api-keys" element={<ApiKeys />} />
                <Route path="/admin/settings" element={<PlatformSettings />} />
                <Route path="/admin/sync"     element={<SyncStatus />} />

                {/* ── Watch ── */}
                <Route path="/watch" element={<Watch />} />

                {/* ── Legacy redirects ── */}
                <Route path="/collections-ops/queue"       element={<Navigate to="/collections/queue"    replace />} />
                <Route path="/collections-ops/targets"     element={<Navigate to="/collections/targets"  replace />} />
                <Route path="/collections-ops/promises"    element={<Navigate to="/collections/promises" replace />} />
                <Route path="/recovery-ops/cases"          element={<Navigate to="/recovery/cases"        replace />} />
                <Route path="/recovery-ops/legal"          element={<Navigate to="/recovery/legal"        replace />} />
                <Route path="/recovery-ops/visits"         element={<Navigate to="/recovery/visits"       replace />} />
                <Route path="/crm/pipeline"                element={<Navigate to="/sales/crm"             replace />} />
                <Route path="/crm/tasks"                   element={<Navigate to="/sales/tasks"           replace />} />
                <Route path="/crm/contacts"                element={<Navigate to="/sales/customers"       replace />} />
                <Route path="/crm/reports"                 element={<Navigate to="/reports"               replace />} />
                <Route path="/los/queue"                   element={<Navigate to="/sales/applications"    replace />} />
                <Route path="/los/all"                     element={<Navigate to="/risk/applications"     replace />} />
                <Route path="/los/new"                     element={<Navigate to="/sales/applications/new" replace />} />
                <Route path="/los/:id"                     element={<NavigateWithParams to="/sales/applications/:id" />} />
                <Route path="/marketing/campaigns"         element={<Navigate to="/campaigns"             replace />} />
                <Route path="/marketing/templates"         element={<Navigate to="/campaigns/templates"   replace />} />
                <Route path="/marketing/lists"             element={<Navigate to="/campaigns/lists"       replace />} />
                <Route path="/compliance/watch-list"       element={<Navigate to="/compliance/watchlist"  replace />} />
                <Route path="/settings"                    element={<Navigate to="/admin/settings"        replace />} />
                <Route path="/kpi"                         element={<Navigate to="/"                      replace />} />
                <Route path="/kpi/portfolio"               element={<Navigate to="/risk/portfolio"        replace />} />
                <Route path="/operations/settlement"       element={<Navigate to="/settlements"           replace />} />
                <Route path="/operations/blink-card"       element={<Navigate to="/cards/blink"           replace />} />
                <Route path="/operations/mobile-app"       element={<Navigate to="/cards/mobile-app"      replace />} />
                <Route path="/operations/credit-portfolio" element={<Navigate to="/risk/portfolio"        replace />} />
                <Route path="/operations/fixed-deposit"    element={<Navigate to="/finance/fixed-deposit" replace />} />
                <Route path="/finance/reconciliation"      element={<Navigate to="/settlements/recon"     replace />} />
                <Route path="/finance/collections"         element={<Navigate to="/collections"           replace />} />
                <Route path="/finance/recovery"            element={<Navigate to="/recovery"              replace />} />
                <Route path="/admin/users-legacy"          element={<Navigate to="/admin/users"           replace />} />

                <Route path="*" element={<Navigate to={homeFor(role)} replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </BrowserRouter>
  )
}

// Helper: redirect /los/:id → /sales/applications/:id, preserving the param
function NavigateWithParams({ to }: { to: string }) {
  const params = useParams()
  const target = to.replace(/:(\w+)/g, (_, key) => params[key] ?? key)
  return <Navigate to={target} replace />
}
