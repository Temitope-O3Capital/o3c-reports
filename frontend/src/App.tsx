import { lazy, Suspense, useEffect, useRef, useState, useCallback, Component, memo } from 'react'
import type { ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useParams, useLocation } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import Sidebar from './components/Sidebar'
import NotificationBell from './components/NotificationBell'

const Login    = lazy(() => import('./pages/Login'))
const Overview = lazy(() => import('./pages/Overview'))
import { AuthUser, parseToken, ROLE_PAGES } from './hooks/useAuth'
import { roleLabel } from './lib/roles'
import { API, apiFetch } from './lib/api'
import { LIGHT, DARK } from './lib/design'

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
    call_center_agent: '/helpdesk', call_center_head: '/helpdesk',
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
const Campaigns            = lazy(() => import('./pages/Campaigns'))
const CampaignsOverview    = lazy(() => import('./pages/campaigns/CampaignsOverview'))
const CSATPage             = lazy(() => import('./pages/helpdesk/CSAT'))
const CampaignReport       = lazy(() => import('./pages/campaigns/CampaignReport'))
const AllCampaignAnalytics = lazy(() => import('./pages/campaigns/AllCampaignAnalytics'))

// Customer 360 drawer
const C360Drawer = lazy(() => import('./components/C360Drawer'))

// Helpdesk (Customer Service ticketing)
const HelpdeskOverview = lazy(() => import('./pages/helpdesk/HelpdeskOverview'))
const TicketList       = lazy(() => import('./pages/helpdesk/TicketList'))
const TicketDetail     = lazy(() => import('./pages/helpdesk/TicketDetail'))
const CannedResponses  = lazy(() => import('./pages/helpdesk/CannedResponses'))
const HelpdeskStats    = lazy(() => import('./pages/helpdesk/HelpdeskStats'))
const VoiceConnect     = lazy(() => import('./pages/settings/VoiceConnect'))
const MessageTemplates = lazy(() => import('./pages/marketing/MessageTemplates'))
const ContactLists     = lazy(() => import('./pages/marketing/ContactLists'))
const ComposeMail      = lazy(() => import('./pages/marketing/ComposeMail'))

// Customer Service
const CSOverview       = lazy(() => import('./pages/customer-service/Overview'))
const CSCalls          = lazy(() => import('./pages/customer-service/Calls'))

// Admin
const AdminOverview           = lazy(() => import('./pages/admin/AdminOverview'))
const UserManagement          = lazy(() => import('./pages/admin/UserManagement'))
const RoleManagement          = lazy(() => import('./pages/admin/RoleManagement'))
const PlatformSettings        = lazy(() => import('./pages/admin/PlatformSettings'))
const SyncStatus              = lazy(() => import('./pages/admin/SyncStatus'))
const ApiKeys                 = lazy(() => import('./pages/admin/ApiKeys'))
const MailHealth              = lazy(() => import('./pages/admin/MailHealth'))
const NotificationSettings    = lazy(() => import('./pages/admin/NotificationSettings'))
const NotificationPreferences = lazy(() => import('./pages/settings/NotificationPreferences'))
const EmailSenders            = lazy(() => import('./pages/admin/EmailSenders'))
const ZohoIntegration         = lazy(() => import('./pages/admin/ZohoIntegration'))

// Mail environment
const MailLayout  = lazy(() => import('./pages/mail/MailLayout'))
const MailInbox   = lazy(() => import('./pages/mail/MailInbox'))
const MailSent    = lazy(() => import('./pages/mail/MailSent'))
const MailCompose = lazy(() => import('./pages/mail/MailCompose'))
const MailDrafts  = lazy(() => import('./pages/mail/MailDrafts'))

// Helpdesk additions
const CallLog         = lazy(() => import('./pages/helpdesk/CallLog'))
const NewTicketPage   = lazy(() => import('./pages/helpdesk/NewTicketPage'))
const SupervisorPage  = lazy(() => import('./pages/helpdesk/Supervisor'))
const KnowledgeBase   = lazy(() => import('./pages/helpdesk/KnowledgeBase'))

// Telemarketing
const TelemarketingOverview = lazy(() => import('./pages/telemarketing/Overview'))
const OutboundQueue         = lazy(() => import('./pages/telemarketing/OutboundQueue'))
const DNCListPage           = lazy(() => import('./pages/telemarketing/DNCList'))

// Active Loan Book
const LoanBook   = lazy(() => import('./pages/active-loan-book/LoanBook'))
const LoanDetail = lazy(() => import('./pages/active-loan-book/LoanDetail'))

// Business Development
const BDOverview       = lazy(() => import('./pages/bd/Overview'))
const EmployerRegister = lazy(() => import('./pages/bd/EmployerRegister'))
const BDPipeline       = lazy(() => import('./pages/bd/Pipeline'))

const PayrollOverview  = lazy(() => import('./pages/payroll/Overview'))
const PayrollRunDetail = lazy(() => import('./pages/payroll/RunDetail'))
const PayrollPayslip   = lazy(() => import('./pages/payroll/Payslip'))

// Reports & Approvals
const Reports          = lazy(() => import('./pages/reports/Reports'))
const Statements       = lazy(() => import('./pages/statements/Statements'))
const Approvals        = lazy(() => import('./pages/Approvals'))

// Other platform pages
const Watch            = lazy(() => import('./pages/Watch'))
const DesignDemo       = lazy(() => import('./pages/DesignDemo'))

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

function ToolbarIconLink({ to, icon, title }: { to: string; icon: string; title: string }) {
  return (
    <Link to={to} title={title} aria-label={title}
      className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors">
      <span className="material-symbols-rounded text-[20px]" aria-hidden="true">{icon}</span>
    </Link>
  )
}

function ToolbarIconButton({ onClick, icon, title }: { onClick: () => void; icon: string; title: string }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors">
      <span className="material-symbols-rounded text-[20px]" aria-hidden="true">{icon}</span>
    </button>
  )
}

function ApprovalsButton({ user }: { user: AuthUser }) {
  const [open,       setOpen]      = useState(false)
  const [summary,    setSummary]   = useState<ApprovalSummary | null>(null)
  const [fetchError, setFetchError] = useState(false)
  const navigate                   = useNavigate()
  const intervalRef                = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSummary = useCallback(async () => {
    try {
      const data = await apiFetch<ApprovalSummary>('/api/approvals/summary')
      setSummary(data)
      setFetchError(false)
    } catch {
      setFetchError(true)
    }
  }, [])

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
            className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center px-1 text-[11px] font-bold text-white rounded-full"
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
          {!summary && !fetchError && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 rounded-full animate-spin"
                style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: '#0E2841' }} />
            </div>
          )}
          {fetchError && (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
              <span className="material-symbols-rounded text-[32px]" style={{ color: '#C00000', opacity: 0.5 }}>error_outline</span>
              <p className="text-[13px] text-slate-500">Could not load approvals</p>
              <button
                onClick={fetchSummary}
                className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
                style={{ background: 'rgba(14,40,65,0.07)', color: '#0E2841' }}>
                Retry
              </button>
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

// ── Per-route error boundary ──────────────────────────────────────────────────

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  render() {
    if (this.state.error) return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-8">
        <span className="material-symbols-rounded text-[40px]" style={{ color: '#C00000', opacity: 0.5 }}>error_outline</span>
        <div>
          <p className="text-[15px] font-semibold text-slate-700 mb-1">This page failed to load</p>
          <p className="text-[13px] text-slate-400">Try refreshing, or navigate to another page.</p>
        </div>
        <button onClick={() => this.setState({ error: false })}
          className="text-[13px] font-medium px-4 py-2 rounded-lg transition-colors"
          style={{ background: 'rgba(14,40,65,0.07)', color: '#0E2841' }}>
          Retry
        </button>
      </div>
    )
    return this.props.children
  }
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
    if (next.length < 12) { setErr('Password must be at least 12 characters'); return }
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
        <p className="text-[13px] text-slate-500 mb-1">
          Your account requires a password change before you can continue.
        </p>
        <p className="text-[12px] text-slate-400 mb-6">
          This is required because your account was newly created or reset by an administrator. Choose a strong password of at least 12 characters.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          {[
            { id: 'cp-current', label: 'Current Password',  val: current,  set: setCurrent },
            { id: 'cp-next',    label: 'New Password',      val: next,     set: setNext },
            { id: 'cp-confirm', label: 'Confirm Password',  val: confirm,  set: setConfirm },
          ].map(f => (
            <div key={f.id}>
              <label htmlFor={f.id} className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">{f.label}</label>
              <input id={f.id} type="password" required value={f.val} onChange={e => f.set(e.target.value)}
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

// ── Route-level role guard ────────────────────────────────────────────────────

function RequireAccess({ page, user, children }: { page: string; user: AuthUser; children: React.ReactNode }) {
  // Prefer pages from the JWT (user.pages), fall back to frontend ROLE_PAGES map
  const pages: string[] = user.pages?.length
    ? user.pages
    : (ROLE_PAGES[user.role as string] ?? [])
  if (pages.length > 0 && !pages.includes(page)) {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}

// NOTE: 'cmo' is a legacy role not in the canonical 24 — kept intentionally for backwards compatibility
const MGMT_ROLES = ['md', 'coo', 'cfo', 'cmo', 'executive', 'admin', 'management', 'head_ops', 'head_it']

// ── Page crossfade on route change ───────────────────────────────────────────
function PageFade({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <div key={location.pathname} className="animate-crossfade">{children}</div>
}

// ── Authenticated layout shell ────────────────────────────────────────────────

const IDLE_WARN_MS   = 25 * 60 * 1000   // show warning after 25 min of inactivity
const IDLE_LOGOUT_MS = 30 * 60 * 1000   // force logout after 30 min

const AppShell = memo(function AppShell({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [c360Open,    setC360Open]    = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [idleWarn,    setIdleWarn]    = useState(false)
  const [dark, setDark] = useState(() => localStorage.getItem('o3c_theme') === 'dark')
  const openC360 = useCallback(() => setC360Open(true), [])

  const toggleDark = useCallback(() => {
    setDark(d => {
      const next = !d
      localStorage.setItem('o3c_theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  // Idle session timeout
  useEffect(() => {
    let warnTimer: ReturnType<typeof setTimeout>
    let logoutTimer: ReturnType<typeof setTimeout>

    function reset() {
      setIdleWarn(false)
      clearTimeout(warnTimer)
      clearTimeout(logoutTimer)
      warnTimer   = setTimeout(() => setIdleWarn(true), IDLE_WARN_MS)
      logoutTimer = setTimeout(() => onLogout(), IDLE_LOGOUT_MS)
    }

    const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const
    EVENTS.forEach(ev => window.addEventListener(ev, reset, { passive: true }))
    reset()

    return () => {
      clearTimeout(warnTimer)
      clearTimeout(logoutTimer)
      EVENTS.forEach(ev => window.removeEventListener(ev, reset))
    }
  }, [onLogout])

  const role         = user.role as string
  const isManagement = MGMT_ROLES.includes(role)

  return (
    <BrowserRouter>
      <a href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:rounded-lg focus:text-[13px] focus:font-semibold focus:text-white"
        style={{ background: '#0E2841' }}>
        Skip to main content
      </a>
      <div className="flex h-screen overflow-hidden" style={{ ...(dark ? DARK : LIGHT), background: 'var(--bg)', transition: 'background .25s, color .25s' }}>
        <Toaster richColors position="top-right" />

        {sidebarOpen && (
          <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
        )}

        <div className={`fixed inset-y-0 left-0 z-50 md:relative md:inset-auto md:z-auto transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
          <Sidebar user={user} onLogout={onLogout} onMobileClose={() => setSidebarOpen(false)} />
        </div>

        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <header
            className="flex items-center gap-2 px-4 py-2.5 flex-shrink-0"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <button
              className="md:hidden p-1.5 rounded-lg hover:bg-black/[0.06] transition-colors"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation">
              <span className="material-symbols-rounded text-[22px] text-slate-600" aria-hidden="true">menu</span>
            </button>
            <div className="flex-1" />
            <button
              onClick={toggleDark}
              title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                borderRadius: 99, border: '1px solid var(--bdr, #E8EBF2)',
                background: 'var(--chip-bg, #EEF0F8)', cursor: 'pointer',
                fontSize: 11.5, fontWeight: 600, color: 'var(--txt2, #798094)',
              }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>
                {dark ? 'light_mode' : 'dark_mode'}
              </span>
              {dark ? 'Light' : 'Dark'}
            </button>
            <ToolbarIconButton onClick={openC360} icon="person_search" title="Customer 360" />
            <ToolbarIconLink to="/tasks"       icon="task_alt"      title="Tasks" />
            <ToolbarIconLink to="/mail/inbox"  icon="mail"          title="Mail" />
            <div className="w-px h-4 bg-slate-200 mx-1" />
            <ApprovalsButton user={user} />
            <NotificationBell />
          </header>

          <main id="main-content" className="flex-1 overflow-y-auto">
            <Suspense fallback={<PageLoader />}>
              <PageFade>
              <Routes>
                {/* Design demo — full-screen overlay, no access guard */}
                <Route path="/design-demo" element={<PageErrorBoundary><DesignDemo /></PageErrorBoundary>} />

                {/* Root — redirect non-management users to their home module */}
                <Route path="/"
                  element={isManagement
                    ? <Overview />
                    : <Navigate to={homeFor(role)} replace />
                  }
                />

                <Route path="/approvals" element={<PageErrorBoundary><RequireAccess page="approvals" user={user}><Approvals /></RequireAccess></PageErrorBoundary>} />

                {/* ── Finance ── */}
                <Route path="/finance"              element={<PageErrorBoundary><RequireAccess page="income" user={user}><FinanceOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/finance/transactions" element={<PageErrorBoundary><RequireAccess page="transactions" user={user}><Transactions /></RequireAccess></PageErrorBoundary>} />
                <Route path="/finance/income"       element={<PageErrorBoundary><RequireAccess page="income" user={user}><Income /></RequireAccess></PageErrorBoundary>} />
                <Route path="/finance/fixed-deposit"element={<PageErrorBoundary><RequireAccess page="fixed_deposit" user={user}><FixedDeposit /></RequireAccess></PageErrorBoundary>} />
                <Route path="/finance/eod"          element={<PageErrorBoundary><RequireAccess page="eod" user={user}><Eod /></RequireAccess></PageErrorBoundary>} />

                {/* ── Sales & CRM ── */}
                <Route path="/sales"                    element={<PageErrorBoundary><RequireAccess page="sales" user={user}><SalesOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/sales/customers"          element={<PageErrorBoundary><RequireAccess page="sales" user={user}><Customers /></RequireAccess></PageErrorBoundary>} />
                <Route path="/sales/crm"                element={<PageErrorBoundary><RequireAccess page="crm_pipeline" user={user}><CrmPipeline /></RequireAccess></PageErrorBoundary>} />
                <Route path="/sales/tasks"              element={<PageErrorBoundary><RequireAccess page="crm_tasks" user={user}><CrmTasks /></RequireAccess></PageErrorBoundary>} />
                <Route path="/tasks"                    element={<PageErrorBoundary><RequireAccess page="crm_tasks" user={user}><CrmTasks /></RequireAccess></PageErrorBoundary>} />
                <Route path="/sales/applications"       element={<PageErrorBoundary><RequireAccess page="sales" user={user}><LOSQueue /></RequireAccess></PageErrorBoundary>} />
                <Route path="/sales/applications/new"   element={<PageErrorBoundary><RequireAccess page="sales" user={user}><LOSNew /></RequireAccess></PageErrorBoundary>} />
                <Route path="/sales/applications/:id"   element={<PageErrorBoundary><RequireAccess page="sales" user={user}><LOSDetail /></RequireAccess></PageErrorBoundary>} />

                {/* ── Risk & Credit ── */}
                <Route path="/risk"              element={<RequireAccess page="credit_portfolio" user={user}><RiskOverview /></RequireAccess>} />
                <Route path="/risk/applications" element={<RequireAccess page="los_all" user={user}><LOSAll /></RequireAccess>} />
                <Route path="/risk/portfolio"    element={<RequireAccess page="credit_portfolio" user={user}><RiskPortfolio /></RequireAccess>} />

                {/* ── Settlements ── */}
                <Route path="/settlements"      element={<PageErrorBoundary><RequireAccess page="settlement" user={user}><SettlementsOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/settlements/recon"element={<PageErrorBoundary><RequireAccess page="reconciliation" user={user}><Reconciliation /></RequireAccess></PageErrorBoundary>} />

                {/* ── Cards & Channels ── */}
                <Route path="/cards"           element={<PageErrorBoundary><RequireAccess page="cards" user={user}><CardsOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/cards/trends"    element={<PageErrorBoundary><RequireAccess page="card_trends" user={user}><CardTrends /></RequireAccess></PageErrorBoundary>} />
                <Route path="/cards/management"element={<PageErrorBoundary><RequireAccess page="cards" user={user}><CardManagement /></RequireAccess></PageErrorBoundary>} />
                <Route path="/cards/blink"     element={<PageErrorBoundary><RequireAccess page="blink_card" user={user}><BlinkCard /></RequireAccess></PageErrorBoundary>} />
                <Route path="/cards/mobile-app"element={<PageErrorBoundary><RequireAccess page="mobile_app" user={user}><MobileApp /></RequireAccess></PageErrorBoundary>} />

                {/* ── Collections ── */}
                <Route path="/collections"         element={<PageErrorBoundary><RequireAccess page="collections" user={user}><CollectionsOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/collections/queue"   element={<PageErrorBoundary><RequireAccess page="collections" user={user}><CollectionsQueue /></RequireAccess></PageErrorBoundary>} />
                <Route path="/collections/targets" element={<PageErrorBoundary><RequireAccess page="collections" user={user}><CollectionsTargets /></RequireAccess></PageErrorBoundary>} />
                <Route path="/collections/promises"element={<PageErrorBoundary><RequireAccess page="collections" user={user}><CollectionsPromises /></RequireAccess></PageErrorBoundary>} />

                {/* ── Recovery ── */}
                <Route path="/recovery"        element={<PageErrorBoundary><RequireAccess page="recovery" user={user}><RecoveryOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/recovery/cases"  element={<PageErrorBoundary><RequireAccess page="recovery" user={user}><RecoveryCases /></RequireAccess></PageErrorBoundary>} />
                <Route path="/recovery/legal"  element={<PageErrorBoundary><RequireAccess page="recovery" user={user}><RecoveryLegal /></RequireAccess></PageErrorBoundary>} />
                <Route path="/recovery/visits" element={<PageErrorBoundary><RequireAccess page="recovery" user={user}><RecoveryVisits /></RequireAccess></PageErrorBoundary>} />

                {/* ── Customer 360 ── */}
                <Route path="/customer360"      element={<PageErrorBoundary><RequireAccess page="crm_contacts" user={user}><Customer360 /></RequireAccess></PageErrorBoundary>} />
                <Route path="/customer360/:cif" element={<PageErrorBoundary><RequireAccess page="crm_contacts" user={user}><Customer360 /></RequireAccess></PageErrorBoundary>} />

                {/* ── Customer Service ── */}
                <Route path="/customer-service"       element={<Navigate to="/helpdesk" replace />} />
                <Route path="/customer-service/calls" element={<Navigate to="/helpdesk/calls" replace />} />

                {/* ── HR ── */}
                <Route path="/hr"              element={<Navigate to="/hr/employees" replace />} />
                <Route path="/hr/employees"    element={<RequireAccess page="hr_employees" user={user}><HREmployees /></RequireAccess>} />
                <Route path="/hr/leave"        element={<RequireAccess page="hr_leave" user={user}><HRLeave /></RequireAccess>} />
                <Route path="/hr/performance"  element={<RequireAccess page="hr_performance" user={user}><HRPerformance /></RequireAccess>} />
                <Route path="/hr/disciplinary" element={<RequireAccess page="hr_disciplinary" user={user}><HRDisciplinary /></RequireAccess>} />
                <Route path="/hr/training"     element={<RequireAccess page="hr_training" user={user}><HRTraining /></RequireAccess>} />

                {/* ── Compliance ── */}
                <Route path="/compliance"               element={<Navigate to="/compliance/checklists" replace />} />
                <Route path="/compliance/watchlist"     element={<RequireAccess page="watch_list" user={user}><WatchList /></RequireAccess>} />
                <Route path="/compliance/sars"          element={<RequireAccess page="sars" user={user}><Sars /></RequireAccess>} />
                <Route path="/compliance/cbn-reports"   element={<RequireAccess page="cbn_reports" user={user}><CbnReports /></RequireAccess>} />
                <Route path="/compliance/findings"      element={<RequireAccess page="audit_findings" user={user}><Findings /></RequireAccess>} />
                <Route path="/compliance/checklists"    element={<RequireAccess page="compliance_checklists" user={user}><Checklists /></RequireAccess>} />
                <Route path="/compliance/audit-trail"   element={<RequireAccess page="audit_trail" user={user}><AuditTrail /></RequireAccess>} />

                {/* ── Campaigns ── */}
                <Route path="/campaigns/overview"         element={<PageErrorBoundary><RequireAccess page="campaigns" user={user}><CampaignsOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/campaigns"                  element={<PageErrorBoundary><RequireAccess page="campaigns" user={user}><Campaigns /></RequireAccess></PageErrorBoundary>} />
                <Route path="/campaigns/compose"          element={<PageErrorBoundary><RequireAccess page="campaigns" user={user}><ComposeMail /></RequireAccess></PageErrorBoundary>} />
                <Route path="/campaigns/templates"        element={<PageErrorBoundary><RequireAccess page="message_templates" user={user}><MessageTemplates /></RequireAccess></PageErrorBoundary>} />
                <Route path="/campaigns/lists"            element={<PageErrorBoundary><RequireAccess page="contact_lists" user={user}><ContactLists /></RequireAccess></PageErrorBoundary>} />
                <Route path="/campaigns/analytics"        element={<PageErrorBoundary><RequireAccess page="campaign_analytics" user={user}><AllCampaignAnalytics /></RequireAccess></PageErrorBoundary>} />
                <Route path="/campaigns/:id/report"       element={<PageErrorBoundary><RequireAccess page="campaign_analytics" user={user}><CampaignReport /></RequireAccess></PageErrorBoundary>} />

                {/* ── Helpdesk ── */}
                <Route path="/helpdesk"            element={<PageErrorBoundary><RequireAccess page="helpdesk" user={user}><HelpdeskOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/tickets"    element={<PageErrorBoundary><RequireAccess page="helpdesk" user={user}><TicketList /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/new"        element={<PageErrorBoundary><RequireAccess page="helpdesk" user={user}><NewTicketPage /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/stats"      element={<PageErrorBoundary><RequireAccess page="helpdesk_stats" user={user}><HelpdeskStats /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/canned"     element={<PageErrorBoundary><RequireAccess page="helpdesk_canned" user={user}><CannedResponses /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/calls"      element={<PageErrorBoundary><RequireAccess page="helpdesk" user={user}><CallLog /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/supervisor"      element={<PageErrorBoundary><RequireAccess page="helpdesk_stats" user={user}><SupervisorPage /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/knowledge-base" element={<PageErrorBoundary><RequireAccess page="helpdesk_kb" user={user}><KnowledgeBase /></RequireAccess></PageErrorBoundary>} />
                <Route path="/helpdesk/:id"             element={<PageErrorBoundary><RequireAccess page="helpdesk" user={user}><TicketDetail /></RequireAccess></PageErrorBoundary>} />

                {/* ── Telemarketing ── */}
                <Route path="/telemarketing"       element={<PageErrorBoundary><RequireAccess page="telemarketing" user={user}><TelemarketingOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/telemarketing/queue" element={<PageErrorBoundary><RequireAccess page="telemarketing" user={user}><OutboundQueue /></RequireAccess></PageErrorBoundary>} />
                <Route path="/telemarketing/dnc"   element={<PageErrorBoundary><RequireAccess page="telemarketing" user={user}><DNCListPage /></RequireAccess></PageErrorBoundary>} />

                {/* ── Active Loan Book ── */}
                <Route path="/active-loan-book"     element={<PageErrorBoundary><RequireAccess page="active_loan_book" user={user}><LoanBook /></RequireAccess></PageErrorBoundary>} />
                <Route path="/active-loan-book/:id" element={<PageErrorBoundary><RequireAccess page="active_loan_book" user={user}><LoanDetail /></RequireAccess></PageErrorBoundary>} />

                {/* ── Business Development ── */}
                <Route path="/bd"           element={<PageErrorBoundary><RequireAccess page="bd" user={user}><BDOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/bd/employers" element={<PageErrorBoundary><RequireAccess page="bd_employers" user={user}><EmployerRegister /></RequireAccess></PageErrorBoundary>} />
                <Route path="/bd/pipeline"  element={<PageErrorBoundary><RequireAccess page="bd_pipeline" user={user}><BDPipeline /></RequireAccess></PageErrorBoundary>} />

                {/* ── Payroll ── */}
                <Route path="/payroll"                       element={<PageErrorBoundary><RequireAccess page="payroll" user={user}><PayrollOverview /></RequireAccess></PageErrorBoundary>} />
                <Route path="/payroll/runs/:id"              element={<PageErrorBoundary><RequireAccess page="payroll" user={user}><PayrollRunDetail /></RequireAccess></PageErrorBoundary>} />
                <Route path="/payroll/runs/:runId/items/:itemId" element={<PageErrorBoundary><RequireAccess page="payroll" user={user}><PayrollPayslip /></RequireAccess></PageErrorBoundary>} />

                {/* ── Settings ── */}
                <Route path="/settings/voice"      element={<VoiceConnect />} />

                {/* ── Reports ── */}
                <Route path="/reports" element={<PageErrorBoundary><RequireAccess page="reports" user={user}><Reports /></RequireAccess></PageErrorBoundary>} />
                <Route path="/statements" element={<RequireAccess page="statements" user={user}><Statements /></RequireAccess>} />

                {/* ── Admin ── */}
                <Route path="/admin"                       element={<RequireAccess page="admin_users" user={user}><Navigate to="/admin/overview" replace /></RequireAccess>} />
                <Route path="/admin/overview"              element={<RequireAccess page="admin_users" user={user}><AdminOverview /></RequireAccess>} />
                <Route path="/admin/users"                 element={<RequireAccess page="admin_users" user={user}><UserManagement /></RequireAccess>} />
                <Route path="/admin/api-keys"              element={<RequireAccess page="admin_api_keys" user={user}><ApiKeys /></RequireAccess>} />
                <Route path="/admin/mail"                  element={<RequireAccess page="admin_api_keys" user={user}><MailHealth /></RequireAccess>} />
                <Route path="/admin/settings"              element={<RequireAccess page="settings" user={user}><PlatformSettings /></RequireAccess>} />
                <Route path="/admin/sync"                  element={<RequireAccess page="sync_status" user={user}><SyncStatus /></RequireAccess>} />
                <Route path="/admin/notification-settings" element={<RequireAccess page="settings" user={user}><NotificationSettings /></RequireAccess>} />
                <Route path="/admin/email-senders"         element={<RequireAccess page="settings" user={user}><EmailSenders /></RequireAccess>} />
                <Route path="/admin/roles"                 element={<RequireAccess page="admin_users" user={user}><RoleManagement /></RequireAccess>} />
                <Route path="/admin/integrations"          element={<RequireAccess page="admin_api_keys" user={user}><ZohoIntegration /></RequireAccess>} />
                <Route path="/admin/audit"                 element={<RequireAccess page="admin_users" user={user}><AuditTrail /></RequireAccess>} />
                <Route path="/settings/notifications" element={<NotificationPreferences />} />

                {/* ── Mail environment ── */}
                <Route path="/mail" element={<MailLayout />}>
                  <Route index element={<Navigate to="/mail/inbox" replace />} />
                  <Route path="inbox"   element={<MailInbox />} />
                  <Route path="sent"    element={<MailSent />} />
                  <Route path="compose" element={<MailCompose />} />
                  <Route path="drafts"  element={<MailDrafts />} />
                </Route>

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
              </PageFade>
            </Suspense>
          </main>
        </div>
        <Suspense fallback={null}>
          <C360Drawer open={c360Open} onClose={() => setC360Open(false)} />
        </Suspense>

        {/* Idle session warning */}
        {idleWarn && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4 text-center">
              <span className="material-symbols-rounded text-[36px] mb-3 block" style={{ color: '#D97706' }}>timer</span>
              <h2 className="text-[16px] font-bold text-slate-800 mb-1">Session expiring soon</h2>
              <p className="text-[13px] text-slate-500 mb-5">
                You've been inactive for 25 minutes. Move your mouse or press a key to stay signed in,
                or you'll be automatically signed out.
              </p>
              <button
                onClick={() => setIdleWarn(false)}
                className="w-full py-2.5 rounded-xl text-[14px] font-semibold text-white"
                style={{ background: '#0E2841' }}>
                Stay signed in
              </button>
            </div>
          </div>
        )}
      </div>
    </BrowserRouter>
  )
})

// ── App — auth layer only ─────────────────────────────────────────────────────

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

    function onAuthExpired() {
      setUser(null)
      toast.error('Session expired — please sign in again')
    }
    function onStorage(e: StorageEvent) {
      if (e.key === 'o3c_token' && !e.newValue) setUser(null)
    }
    window.addEventListener('auth:expired', onAuthExpired)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('auth:expired', onAuthExpired)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const handleLogin = useCallback((u: AuthUser) => {
    setUser(u)
    toast.success(`Welcome back, ${u.name.split(' ')[0]}`, {
      description: `Signed in as ${roleLabel(u.role as string)}`,
    })
  }, [])

  const handleLogout = useCallback(() => {
    localStorage.removeItem('o3c_token')
    localStorage.removeItem('o3c_user')
    setUser(null)
    toast.info('Signed out')
  }, [])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#F6F5F2]">
      <div className="w-8 h-8 border-2 rounded-full animate-spin"
        style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: '#0E2841' }} />
    </div>
  )

  // Public routes — no auth required
  if (window.location.pathname === '/design-demo') {
    return (
      <BrowserRouter>
        <Suspense fallback={<div className="min-h-screen bg-[#F6F7F9]" />}>
          <Routes>
            <Route path="/design-demo" element={<DesignDemo />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    )
  }

  if (window.location.pathname.startsWith('/csat/')) {
    return (
      <BrowserRouter>
        <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
          <Routes>
            <Route path="/csat/:token" element={<CSATPage />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    )
  }

  if (!user) return (
    <>
      <Toaster richColors position="top-right" />
      <Suspense fallback={<div className="min-h-screen bg-[#F6F5F2]" />}>
        <Login onLogin={handleLogin} />
      </Suspense>
    </>
  )

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

  return <AppShell user={user} onLogout={handleLogout} />
}

// Helper: redirect /los/:id → /sales/applications/:id, preserving the param
function NavigateWithParams({ to }: { to: string }) {
  const params = useParams()
  const target = to.replace(/:(\w+)/g, (_, key) => params[key] ?? key)
  return <Navigate to={target} replace />
}
