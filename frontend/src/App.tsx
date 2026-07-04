import {
  lazy, Suspense, useEffect, useState, useCallback, useRef, Component, memo,
} from 'react'
import type { ReactNode } from 'react'
import {
  BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useLocation,
} from 'react-router-dom'
import { Toaster, toast } from 'sonner'

import Sidebar          from './components/Sidebar'
import NotificationBell from './components/NotificationBell'
import GlobalSearch     from './components/GlobalSearch'
import { type AuthUser, ROLE_PAGES } from './hooks/useAuth'
import { roleLabel }    from './lib/roles'
import { API, apiFetch, apiLogout, refreshSession } from './lib/api'
import { LIGHT, DARK }  from './lib/design'

// ── Lazy imports ──────────────────────────────────────────────────────────────
const CS           = lazy(() => import('./pages/ComingSoon'))
const CSATSurvey   = lazy(() => import('./pages/helpdesk/CSATSurvey'))
const UserSettings = lazy(() => import('./pages/Settings'))

// Intelligence
const ReportsBI     = lazy(() => import('./pages/reports/BI'))
const ReportsKPI    = lazy(() => import('./pages/reports/KPITracker'))
const ReportsExport = lazy(() => import('./pages/reports/Export'))
const Statements    = lazy(() => import('./pages/statements/Statements'))
const Login    = lazy(() => import('./pages/Login'))
const Overview = lazy(() => import('./pages/Overview'))
const C360     = lazy(() => import('./components/C360Drawer'))

// BD
const BDOverview   = lazy(() => import('./pages/bd/Overview'))
const BDPipeline   = lazy(() => import('./pages/bd/Pipeline'))
const BDEmployers  = lazy(() => import('./pages/bd/Employers'))
const BDAnalytics  = lazy(() => import('./pages/bd/Analytics'))

// Campaigns
const CampaignsList     = lazy(() => import('./pages/campaigns/List'))
const CampaignAnalytics = lazy(() => import('./pages/campaigns/Analytics'))
const CampaignTemplates      = lazy(() => import('./pages/campaigns/Templates'))
const CampaignTemplateEditor = lazy(() => import('./pages/campaigns/TemplateEditor'))
const CampaignLists          = lazy(() => import('./pages/campaigns/ContactLists'))
const CampaignReport         = lazy(() => import('./pages/campaigns/Report'))

// Approvals & Mail
const ApprovalsPage  = lazy(() => import('./pages/Approvals'))
const MailInbox      = lazy(() => import('./pages/mail/Inbox'))
const MailCompose    = lazy(() => import('./pages/mail/Compose'))
const MailThread     = lazy(() => import('./pages/mail/ThreadDetail'))

// Sales
const SalesOverview  = lazy(() => import('./pages/sales/Overview'))
const SalesCohort    = lazy(() => import('./pages/sales/Cohort'))
const SalesReports   = lazy(() => import('./pages/sales/Reports'))
const SalesTargets   = lazy(() => import('./pages/sales/Targets'))
const CRMContacts    = lazy(() => import('./pages/sales/Customers'))
const CRMContactDetail = lazy(() => import('./pages/sales/ContactDetail'))
const CRMPipelinePg  = lazy(() => import('./pages/sales/CRMPipeline'))
const CRMTasks       = lazy(() => import('./pages/sales/Tasks'))

// LOS (loan origination)
const LOSQueue         = lazy(() => import('./pages/los/Queue'))
const LOSNewApp        = lazy(() => import('./pages/los/NewApplication'))
const LOSAppDetail     = lazy(() => import('./pages/los/ApplicationDetail'))

// Collections
const CollectionsOverview  = lazy(() => import('./pages/collections/Overview'))
const CollectionsQueue     = lazy(() => import('./pages/collections/Queue'))
const CollectionsPromises  = lazy(() => import('./pages/collections/Promises'))
const CollectionsPlans     = lazy(() => import('./pages/collections/RepaymentPlans'))
const CollectionsWriteoffs = lazy(() => import('./pages/collections/WriteoffQueue'))

// Risk
const RiskAppReview    = lazy(() => import('./pages/risk/AppReview'))
const RiskPortfolio    = lazy(() => import('./pages/risk/PortfolioHealth'))
const RiskEyeScore     = lazy(() => import('./pages/risk/EyeScore'))
const RiskVintage      = lazy(() => import('./pages/risk/VintageAnalysis'))
const RiskCreditFile   = lazy(() => import('./pages/risk/CreditFile'))

// Recovery
const RecoveryOverview = lazy(() => import('./pages/recovery/Overview'))
const RecoveryCases    = lazy(() => import('./pages/recovery/Cases'))
const RecoveryLegal    = lazy(() => import('./pages/recovery/Legal'))
const RecoveryTPA      = lazy(() => import('./pages/recovery/TPA'))
const RecoveryDebtSale = lazy(() => import('./pages/recovery/DebtSale'))

// Collections Ops
const CollOpsAgentDash = lazy(() => import('./pages/collections-ops/AgentDashboard'))

// Helpdesk
const HelpdeskTickets     = lazy(() => import('./pages/helpdesk/Tickets'))
const HelpdeskTicketDetail = lazy(() => import('./pages/helpdesk/TicketDetail'))
const HelpdeskSupervisor  = lazy(() => import('./pages/helpdesk/Supervisor'))
const HelpdeskCalls       = lazy(() => import('./pages/helpdesk/Calls'))
const HelpdeskStats       = lazy(() => import('./pages/helpdesk/Stats'))
const HelpdeskKB          = lazy(() => import('./pages/helpdesk/KnowledgeBase'))
const HelpdeskCanned      = lazy(() => import('./pages/helpdesk/Canned'))

// Cards
const CardsOverview    = lazy(() => import('./pages/cards/Overview'))
const CardsMgmt        = lazy(() => import('./pages/cards/Management'))
const CardsIssuance    = lazy(() => import('./pages/cards/Issuance'))
const CardsDisputes    = lazy(() => import('./pages/cards/Disputes'))
const CardsCreditLimit = lazy(() => import('./pages/cards/CreditLimit'))
const CardsBilling     = lazy(() => import('./pages/cards/Billing'))

// Admin
const AdminOverview              = lazy(() => import('./pages/admin/Overview'))
const AdminUsers                 = lazy(() => import('./pages/admin/Users'))
const AdminRoles                 = lazy(() => import('./pages/admin/Roles'))
const AdminEmailSenders          = lazy(() => import('./pages/admin/EmailSenders'))
const AdminMailHealth            = lazy(() => import('./pages/admin/MailHealth'))
const AdminApiKeys               = lazy(() => import('./pages/admin/ApiKeys'))
const AdminSettings              = lazy(() => import('./pages/admin/Settings'))
const AdminNotificationSettings  = lazy(() => import('./pages/admin/NotificationSettings'))
const AdminIntegrations          = lazy(() => import('./pages/admin/Integrations'))
const AdminAuditLog              = lazy(() => import('./pages/admin/AuditLog'))
const AdminSyncStatus            = lazy(() => import('./pages/admin/SyncStatus'))
const AdminHelpdeskSettings      = lazy(() => import('./pages/admin/HelpdeskSettings'))
const AdminWorkflowTemplates     = lazy(() => import('./pages/admin/WorkflowTemplates'))

// Finance
const FinanceOverview     = lazy(() => import('./pages/finance/Overview'))
const FinanceTxns         = lazy(() => import('./pages/finance/Transactions'))
const FinanceIncome       = lazy(() => import('./pages/finance/Income'))
const FinanceFD           = lazy(() => import('./pages/finance/FixedDeposit'))
const FinanceEOD          = lazy(() => import('./pages/finance/Eod'))
const FinancePnL          = lazy(() => import('./pages/finance/PnL'))
const FinanceManualPost   = lazy(() => import('./pages/finance/ManualPosting'))
const FinanceCoA          = lazy(() => import('./pages/finance/ChartOfAccounts'))
const FinanceFDMaturity   = lazy(() => import('./pages/finance/FDMaturity'))
const FinanceCosts        = lazy(() => import('./pages/finance/CostTracking'))
const FinanceBudget       = lazy(() => import('./pages/finance/Budget'))

// Settlements
const SettleOverview   = lazy(() => import('./pages/settlements/Overview'))
const SettleBatches    = lazy(() => import('./pages/settlements/Batches'))
const SettleNIP        = lazy(() => import('./pages/settlements/NIP'))
const SettleNIPRecon   = lazy(() => import('./pages/settlements/NIPReconciliation'))
const SettleRecon      = lazy(() => import('./pages/settlements/Reconciliation'))
const SettleFailed     = lazy(() => import('./pages/settlements/FailedTransactions'))
const SettleManualPost = lazy(() => import('./pages/settlements/ManualPostings'))

// Telemarketing
const TelemarketingQueue       = lazy(() => import('./pages/telemarketing/Queue'))
const TelemarketingLeads       = lazy(() => import('./pages/telemarketing/Leads'))
const TelemarketingDNC         = lazy(() => import('./pages/telemarketing/DNC'))
const TelemarketingPerformance = lazy(() => import('./pages/telemarketing/Performance'))
const DialerCampaigns          = lazy(() => import('./pages/telemarketing/DialerCampaigns'))
const DialerAgent              = lazy(() => import('./pages/telemarketing/DialerAgent'))
const DialerSupervisor         = lazy(() => import('./pages/telemarketing/DialerSupervisor'))

// Marketing
const MarketingAttribution = lazy(() => import('./pages/marketing/Attribution'))
const MarketingFunnel      = lazy(() => import('./pages/marketing/Funnel'))

// Payroll
const PayrollOverview = lazy(() => import('./pages/payroll/PayrollOverview'))
const PayrollRunDetail = lazy(() => import('./pages/payroll/RunDetail'))
const PayslipView     = lazy(() => import('./pages/payroll/PayslipView'))

// Compliance
const ComplianceWatchlist   = lazy(() => import('./pages/compliance/WatchList'))
const ComplianceRegCalendar = lazy(() => import('./pages/compliance/RegulatoryCalendar'))
const ComplianceFindings    = lazy(() => import('./pages/compliance/Findings'))
const ComplianceChecklists  = lazy(() => import('./pages/compliance/Checklists'))
const ComplianceAuditTrail  = lazy(() => import('./pages/compliance/AuditTrail'))
const ComplianceKYCExpiry   = lazy(() => import('./pages/compliance/KYCExpiry'))
const ComplianceAMLRules    = lazy(() => import('./pages/compliance/AMLRules'))

// HR
const HREmployees    = lazy(() => import('./pages/hr/Employees'))
const HRLeave        = lazy(() => import('./pages/hr/Leave'))
const HRPerformance  = lazy(() => import('./pages/hr/Performance'))
const HRDisciplinary = lazy(() => import('./pages/hr/Disciplinary'))
const HRTraining     = lazy(() => import('./pages/hr/Training'))
const HRRecruitment  = lazy(() => import('./pages/hr/Recruitment'))
const HROrgChart     = lazy(() => import('./pages/hr/OrgChart'))
const HROnboarding   = lazy(() => import('./pages/hr/Onboarding'))
const HROffboarding  = lazy(() => import('./pages/hr/Offboarding'))

// ── Role → home ───────────────────────────────────────────────────────────────

function homeFor(role: string): string {
  const map: Record<string, string> = {
    md: '/', coo: '/', cfo: '/', cmo: '/', executive: '/',
    admin: '/', management: '/', head_ops: '/', head_it: '/admin/overview',
    sales_officer: '/sales',       sales_head: '/sales',
    bd_officer: '/bd',             bd_head: '/bd',
    risk_officer: '/operations/risk', risk_head: '/operations/risk',
    finance_officer: '/finance',   finance_head: '/finance',
    cards_ops_officer: '/cards',   cards_ops_head: '/cards',
    collections_agent: '/collections', collections_head: '/collections',
    recovery_agent: '/recovery',   recovery_head: '/recovery',
    call_center_agent: '/helpdesk', call_center_head: '/helpdesk',
    hr_officer: '/hr',             hr_manager: '/hr',
    compliance_officer: '/compliance', compliance_head: '/compliance',
    internal_control_head: '/compliance',
    it_admin: '/admin/overview',
    bi_analyst: '/reports',        bi_head: '/reports',
    settlement_officer: '/settlements',
    telemarketing_agent: '/telemarketing', telemarketing_head: '/telemarketing',
    payroll_officer: '/payroll',   payroll_manager: '/payroll',
  }
  return map[role] ?? '/'
}

// ── Access guard ──────────────────────────────────────────────────────────────

const MGMT = new Set([
  'md','coo','cfo','cmo','executive','admin','management','head_ops','head_it','head_hr',
])

function RequireAccess({ page, user, children }: { page: string; user: AuthUser; children: ReactNode }) {
  const role = user.role as string
  if (MGMT.has(role)) return <>{children}</>
  const allowed = user.pages?.length
    ? user.pages.includes(page)
    : (ROLE_PAGES[role] ?? []).includes(page)
  if (!allowed) return <Navigate to={homeFor(role)} replace />
  return <>{children}</>
}

// ── Page shell utilities ──────────────────────────────────────────────────────

function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%',
        border: '2.5px solid var(--bdr)',
        borderTopColor: 'var(--nav-dot)',
        animation: 'spin 0.7s linear infinite',
      }} />
    </div>
  )
}

function PageFade({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div key={pathname} style={{ animation: 'pageFadeIn 180ms ease both', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {children}
    </div>
  )
}

class PageErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null }
  static getDerivedStateFromError(e: Error) { return { err: e.message } }
  render() {
    if (this.state.err) return (
      <div style={{ padding: 32, color: 'var(--nav-dot)', fontFamily: 'Sora, sans-serif' }}>
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Page error</p>
        <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 16 }}>{this.state.err}</p>
        <button onClick={() => { this.setState({ err: null }); window.location.reload() }}
          style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid currentColor', background: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          Retry
        </button>
      </div>
    )
    return this.props.children
  }
}

// ── Module title map (topbar left zone) ───────────────────────────────────────

const MODULE_TITLES: [string, string][] = [
  ['/approvals',         'Approvals'],
  ['/bd',                'Business Development'],
  ['/campaigns',         'Campaigns'],
  ['/sales',             'Sales'],
  ['/telemarketing',     'Telemarketing'],
  ['/helpdesk',          'Customer Service'],
  ['/cards',             'Card Operations'],
  ['/operations/risk',   'Risk'],
  ['/collections',       'Collections'],
  ['/recovery',          'Recovery'],
  ['/settlements',       'Settlements'],
  ['/finance',           'Finance'],
  ['/compliance',        'Compliance'],
  ['/hr',                'People & HR'],
  ['/payroll',           'Payroll'],
  ['/reports',           'Reports & BI'],
  ['/statements',        'Statements'],
  ['/admin',             'Admin'],
  ['/mail',              'Mail'],
  ['/',                  'Overview'],
]

function ModuleTitle() {
  const { pathname } = useLocation()
  const title = MODULE_TITLES.find(([prefix]) =>
    prefix === '/' ? pathname === '/' : pathname.startsWith(prefix)
  )?.[1] ?? 'Workspace'

  return (
    <span style={{
      fontSize: 14, fontWeight: 600,
      color: 'var(--txt)',
      letterSpacing: '-0.2px',
      whiteSpace: 'nowrap',
    }}>
      {title}
    </span>
  )
}

// ── ⌘K Search trigger ─────────────────────────────────────────────────────────

function SearchTrigger() {
  return (
    <button style={{
      display: 'flex', alignItems: 'center', gap: 8,
      height: 34, padding: '0 12px 0 10px',
      width: '100%', maxWidth: 340,
      borderRadius: 8, border: '1px solid var(--input-bdr)',
      background: 'var(--input-bg)', cursor: 'text',
      color: 'var(--txt3)', fontSize: 13, fontFamily: 'inherit',
      textAlign: 'left', outline: 'none',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, flexShrink: 0 }}>search</span>
      <span style={{ flex: 1 }}>Search workspace…</span>
      <kbd style={{
        fontSize: 10, fontFamily: 'inherit', fontWeight: 600,
        padding: '2px 6px', borderRadius: 5, lineHeight: 1.5,
        background: 'var(--chip-bg)', color: 'var(--chip-txt)',
        border: '1px solid var(--bdr)', flexShrink: 0,
      }}>⌘K</kbd>
    </button>
  )
}

// ── TopBar icon button ─────────────────────────────────────────────────────────

function TbBtn({ onClick, icon, title }: { onClick: () => void; icon: string; title: string }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 34, height: 34, borderRadius: 8, border: 'none',
      background: 'transparent', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--txt2)', transition: 'background 120ms, color 120ms',
    }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'var(--row-hvr)'
        el.style.color = 'var(--txt)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'transparent'
        el.style.color = 'var(--txt2)'
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{icon}</span>
    </button>
  )
}

function TbLink({ to, icon, title }: { to: string; icon: string; title: string }) {
  return (
    <Link to={to} title={title} style={{
      width: 34, height: 34, borderRadius: 8,
      background: 'transparent', textDecoration: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--txt2)', transition: 'background 120ms, color 120ms',
    }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'var(--row-hvr)'
        el.style.color = 'var(--txt)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'transparent'
        el.style.color = 'var(--txt2)'
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{icon}</span>
    </Link>
  )
}

function TbDivider() {
  return <div style={{ width: 1, height: 18, background: 'var(--bdr)', margin: '0 4px', flexShrink: 0 }} />
}

// ── Approvals badge button ────────────────────────────────────────────────────

interface ApprovalItem { id: number; module: string; title: string; type: string; url: string }

function ApprovalsButton({ user }: { user: AuthUser }) {
  const [count, setCount] = useState(0)
  const navigate          = useNavigate()

  useEffect(() => {
    const role = user.role as string
    if (!MGMT.has(role) && role !== 'finance_head' && role !== 'compliance_head') return
    const load = () => {
      apiFetch<{ total: number; items: ApprovalItem[] }>('/api/approvals/summary')
        .then(d => setCount(d.total))
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [user.role])

  return (
    <button
      onClick={() => navigate('/approvals')}
      title="Approvals"
      style={{
        position: 'relative', width: 34, height: 34,
        borderRadius: 8, border: 'none', background: 'transparent',
        cursor: 'pointer', display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: 'var(--txt2)',
        transition: 'background 120ms, color 120ms',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'var(--row-hvr)'
        el.style.color = 'var(--txt)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'transparent'
        el.style.color = 'var(--txt2)'
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>task_alt</span>
      {count > 0 && (
        <span style={{
          position: 'absolute', top: 5, right: 5,
          minWidth: 13, height: 13, borderRadius: 7,
          background: 'var(--nav-dot)', color: 'var(--card)',
          fontSize: 8, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 3px',
        }}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}

// ── Theme toggle ──────────────────────────────────────────────────────────────

function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        width: 34, height: 34, borderRadius: 8, border: 'none',
        background: 'transparent', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--txt2)', transition: 'background 120ms, color 120ms',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'var(--row-hvr)'
        el.style.color = 'var(--txt)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'transparent'
        el.style.color = 'var(--txt2)'
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
        {dark ? 'light_mode' : 'dark_mode'}
      </span>
    </button>
  )
}

// ── Idle timer ────────────────────────────────────────────────────────────────

const IDLE_WARN_MS   = 25 * 60 * 1000
const IDLE_LOGOUT_MS = 30 * 60 * 1000

// ── App shell ─────────────────────────────────────────────────────────────────

const AppShell = memo(function AppShell({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [c360Open,    setC360Open]    = useState(false)
  const [searchOpen,  setSearchOpen]  = useState(false)
  const [idleWarn,    setIdleWarn]    = useState(false)
  const [dark,        setDark]        = useState(() => localStorage.getItem('o3c_theme') === 'dark')

  const toggleDark = useCallback(() => {
    setDark(d => {
      const next = !d
      localStorage.setItem('o3c_theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  useEffect(() => {
    let warnTimer:   ReturnType<typeof setTimeout>
    let logoutTimer: ReturnType<typeof setTimeout>
    function reset() {
      setIdleWarn(false)
      clearTimeout(warnTimer); clearTimeout(logoutTimer)
      warnTimer   = setTimeout(() => setIdleWarn(true), IDLE_WARN_MS)
      logoutTimer = setTimeout(onLogout, IDLE_LOGOUT_MS)
    }
    const EVENTS = ['mousemove','mousedown','keydown','touchstart','scroll'] as const
    EVENTS.forEach(ev => window.addEventListener(ev, reset, { passive: true }))
    reset()
    return () => {
      clearTimeout(warnTimer); clearTimeout(logoutTimer)
      EVENTS.forEach(ev => window.removeEventListener(ev, reset))
    }
  }, [onLogout])

  // Cmd+K / Ctrl+K → open global search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const role = user.role as string

  return (
    <BrowserRouter>
      <div style={{
        display: 'flex', height: '100vh', overflow: 'hidden',
        ...(dark ? DARK : LIGHT),
        background: 'var(--bg)',
        fontFamily: "'Sora', sans-serif",
      }}>
        <Toaster richColors position="top-right" />

        {/* Sidebar */}
        <Sidebar
          user={user}
          onLogout={onLogout}
          utilities={<>
            <TbBtn onClick={() => setSearchOpen(true)} icon="search" title="Search (⌘K)" />
            <TbBtn onClick={() => setC360Open(true)} icon="manage_search" title="Customer 360°" />
            <ApprovalsButton user={user} />
            <NotificationBell />
            <TbDivider />
            <ThemeToggle dark={dark} onToggle={toggleDark} />
          </>}
        />

        {/* Main column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* Page area */}
          <main style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Suspense fallback={<PageLoader />}>
              <PageFade>
                <Routes>
                  <Route path="/" element={
                    MGMT.has(role) ? <Overview /> : <Navigate to={homeFor(role)} replace />
                  } />

                  <Route path="/approvals" element={<PageErrorBoundary><ApprovalsPage /></PageErrorBoundary>} />

                  {/* Sales & BD */}
                  <Route path="/bd"             element={<PageErrorBoundary><BDOverview /></PageErrorBoundary>} />
                  <Route path="/bd/leads"       element={<PageErrorBoundary><BDPipeline /></PageErrorBoundary>} />
                  <Route path="/bd/pipeline"    element={<PageErrorBoundary><BDPipeline /></PageErrorBoundary>} />
                  <Route path="/bd/employers"   element={<PageErrorBoundary><BDEmployers /></PageErrorBoundary>} />
                  <Route path="/bd/analytics"   element={<PageErrorBoundary><BDAnalytics /></PageErrorBoundary>} />

                  <Route path="/campaigns"            element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignsList /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/templates"          element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignTemplates /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/templates/new"      element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignTemplateEditor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/templates/:id/edit" element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignTemplateEditor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/lists"      element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignLists /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/analytics"  element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignAnalytics /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/:id/report" element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignReport /></PageErrorBoundary></RequireAccess>} />

                  <Route path="/sales"           element={<PageErrorBoundary><SalesOverview /></PageErrorBoundary>} />
                  <Route path="/sales/cohort"    element={<PageErrorBoundary><SalesCohort /></PageErrorBoundary>} />
                  <Route path="/sales/reports"   element={<PageErrorBoundary><SalesReports /></PageErrorBoundary>} />
                  <Route path="/sales/targets"   element={<PageErrorBoundary><SalesTargets /></PageErrorBoundary>} />
                  <Route path="/sales/customers"     element={<PageErrorBoundary><CRMContacts /></PageErrorBoundary>} />
                  <Route path="/sales/customers/:id" element={<PageErrorBoundary><CRMContactDetail /></PageErrorBoundary>} />
                  <Route path="/sales/crm"           element={<PageErrorBoundary><CRMPipelinePg /></PageErrorBoundary>} />
                  <Route path="/sales/tasks"         element={<PageErrorBoundary><CRMTasks /></PageErrorBoundary>} />

                  <Route path="/sales/applications"     element={<PageErrorBoundary><LOSQueue /></PageErrorBoundary>} />
                  <Route path="/sales/applications/new" element={<PageErrorBoundary><LOSNewApp /></PageErrorBoundary>} />
                  <Route path="/sales/applications/:id" element={<PageErrorBoundary><LOSAppDetail /></PageErrorBoundary>} />

                  {/* Marketing */}
                  <Route path="/marketing/attribution" element={<PageErrorBoundary><MarketingAttribution /></PageErrorBoundary>} />
                  <Route path="/marketing/funnel"      element={<PageErrorBoundary><MarketingFunnel /></PageErrorBoundary>} />

                  {/* Contact Centre */}
                  <Route path="/telemarketing"             element={<PageErrorBoundary><TelemarketingQueue /></PageErrorBoundary>} />
                  <Route path="/telemarketing/queue"       element={<PageErrorBoundary><TelemarketingQueue /></PageErrorBoundary>} />
                  <Route path="/telemarketing/leads"       element={<PageErrorBoundary><TelemarketingLeads /></PageErrorBoundary>} />
                  <Route path="/telemarketing/dnc"         element={<PageErrorBoundary><TelemarketingDNC /></PageErrorBoundary>} />
                  <Route path="/telemarketing/performance"        element={<PageErrorBoundary><TelemarketingPerformance /></PageErrorBoundary>} />
                  <Route path="/telemarketing/dialer"            element={<PageErrorBoundary><DialerCampaigns /></PageErrorBoundary>} />
                  <Route path="/telemarketing/dialer/agent"      element={<PageErrorBoundary><DialerAgent /></PageErrorBoundary>} />
                  <Route path="/telemarketing/dialer/supervisor" element={<PageErrorBoundary><DialerSupervisor /></PageErrorBoundary>} />

                  <Route path="/helpdesk"                element={<PageErrorBoundary><HelpdeskTickets /></PageErrorBoundary>} />
                  <Route path="/helpdesk/tickets"        element={<PageErrorBoundary><HelpdeskTickets /></PageErrorBoundary>} />
                  <Route path="/helpdesk/calls"          element={<PageErrorBoundary><HelpdeskCalls /></PageErrorBoundary>} />
                  <Route path="/helpdesk/supervisor"     element={<PageErrorBoundary><HelpdeskSupervisor /></PageErrorBoundary>} />
                  <Route path="/helpdesk/stats"          element={<PageErrorBoundary><HelpdeskStats /></PageErrorBoundary>} />
                  <Route path="/helpdesk/knowledge-base" element={<PageErrorBoundary><HelpdeskKB /></PageErrorBoundary>} />
                  <Route path="/helpdesk/canned"         element={<PageErrorBoundary><HelpdeskCanned /></PageErrorBoundary>} />
                  <Route path="/helpdesk/:id"            element={<PageErrorBoundary><HelpdeskTicketDetail /></PageErrorBoundary>} />

                  {/* Cards */}
                  <Route path="/cards"              element={<PageErrorBoundary><CardsOverview /></PageErrorBoundary>} />
                  <Route path="/cards/management"   element={<PageErrorBoundary><CardsMgmt /></PageErrorBoundary>} />
                  <Route path="/cards/issuance"     element={<PageErrorBoundary><CardsIssuance /></PageErrorBoundary>} />
                  <Route path="/cards/disputes"     element={<PageErrorBoundary><CardsDisputes /></PageErrorBoundary>} />
                  <Route path="/cards/credit-limit" element={<PageErrorBoundary><CardsCreditLimit /></PageErrorBoundary>} />
                  <Route path="/cards/billing"      element={<PageErrorBoundary><CardsBilling /></PageErrorBoundary>} />

                  {/* Operations — Risk */}
                  <Route path="/operations/risk"              element={<PageErrorBoundary><RiskAppReview /></PageErrorBoundary>} />
                  <Route path="/operations/risk/applications" element={<PageErrorBoundary><RiskAppReview /></PageErrorBoundary>} />
                  <Route path="/operations/risk/portfolio"    element={<PageErrorBoundary><RiskPortfolio /></PageErrorBoundary>} />
                  <Route path="/operations/risk/eye"          element={<PageErrorBoundary><RiskEyeScore /></PageErrorBoundary>} />
                  <Route path="/operations/risk/vintage"      element={<PageErrorBoundary><RiskVintage /></PageErrorBoundary>} />
                  <Route path="/operations/risk/credit-file"  element={<PageErrorBoundary><RiskCreditFile /></PageErrorBoundary>} />

                  {/* Collections */}
                  <Route path="/collections"                 element={<PageErrorBoundary><CollectionsOverview /></PageErrorBoundary>} />
                  <Route path="/collections/queue"           element={<PageErrorBoundary><CollectionsQueue /></PageErrorBoundary>} />
                  <Route path="/collections/promises"        element={<PageErrorBoundary><CollectionsPromises /></PageErrorBoundary>} />
                  <Route path="/collections/repayment-plans" element={<PageErrorBoundary><CollectionsPlans /></PageErrorBoundary>} />
                  <Route path="/collections/writeoffs"       element={<PageErrorBoundary><CollectionsWriteoffs /></PageErrorBoundary>} />

                  {/* Recovery */}
                  <Route path="/recovery"            element={<PageErrorBoundary><RecoveryOverview /></PageErrorBoundary>} />
                  <Route path="/recovery/cases"      element={<PageErrorBoundary><RecoveryCases /></PageErrorBoundary>} />
                  <Route path="/recovery/legal"      element={<PageErrorBoundary><RecoveryLegal /></PageErrorBoundary>} />
                  <Route path="/recovery/tpa"        element={<PageErrorBoundary><RecoveryTPA /></PageErrorBoundary>} />
                  <Route path="/recovery/debt-sales" element={<PageErrorBoundary><RecoveryDebtSale /></PageErrorBoundary>} />

                  {/* Collections Ops */}
                  <Route path="/collections-ops/agent" element={<PageErrorBoundary><CollOpsAgentDash /></PageErrorBoundary>} />

                  {/* Settlements */}
                  <Route path="/settlements"                          element={<PageErrorBoundary><SettleOverview /></PageErrorBoundary>} />
                  <Route path="/settlements/batches"                  element={<PageErrorBoundary><SettleBatches /></PageErrorBoundary>} />
                  <Route path="/settlements/nip"                      element={<PageErrorBoundary><SettleNIP /></PageErrorBoundary>} />
                  <Route path="/settlements/nip-recon"                element={<PageErrorBoundary><SettleNIPRecon /></PageErrorBoundary>} />
                  <Route path="/settlements/reconciliation"           element={<PageErrorBoundary><SettleRecon /></PageErrorBoundary>} />
                  <Route path="/settlements/failed"                   element={<PageErrorBoundary><SettleFailed /></PageErrorBoundary>} />
                  <Route path="/settlements/manual-postings"          element={<PageErrorBoundary><SettleManualPost /></PageErrorBoundary>} />

                  {/* Finance */}
                  <Route path="/finance"                    element={<PageErrorBoundary><FinanceOverview /></PageErrorBoundary>} />
                  <Route path="/finance/transactions"       element={<PageErrorBoundary><FinanceTxns /></PageErrorBoundary>} />
                  <Route path="/finance/income"             element={<PageErrorBoundary><FinanceIncome /></PageErrorBoundary>} />
                  <Route path="/finance/fixed-deposit"      element={<PageErrorBoundary><FinanceFD /></PageErrorBoundary>} />
                  <Route path="/finance/eod"                element={<PageErrorBoundary><FinanceEOD /></PageErrorBoundary>} />
                  <Route path="/finance/pnl"                element={<PageErrorBoundary><FinancePnL /></PageErrorBoundary>} />
                  <Route path="/finance/manual-postings"    element={<PageErrorBoundary><FinanceManualPost /></PageErrorBoundary>} />
                  <Route path="/finance/gl-accounts"        element={<PageErrorBoundary><FinanceCoA /></PageErrorBoundary>} />
                  <Route path="/finance/fd-maturity"        element={<PageErrorBoundary><FinanceFDMaturity /></PageErrorBoundary>} />
                  <Route path="/finance/costs"              element={<PageErrorBoundary><FinanceCosts /></PageErrorBoundary>} />
                  <Route path="/finance/budget"             element={<PageErrorBoundary><FinanceBudget /></PageErrorBoundary>} />

                  {/* Compliance */}
                  <Route path="/compliance"             element={<Navigate to="/compliance/watchlist" replace />} />
                  <Route path="/compliance/watchlist"   element={<PageErrorBoundary><ComplianceWatchlist /></PageErrorBoundary>} />
                  <Route path="/compliance/regulatory"  element={<PageErrorBoundary><ComplianceRegCalendar /></PageErrorBoundary>} />
                  <Route path="/compliance/findings"    element={<PageErrorBoundary><ComplianceFindings /></PageErrorBoundary>} />
                  <Route path="/compliance/checklists"  element={<PageErrorBoundary><ComplianceChecklists /></PageErrorBoundary>} />
                  <Route path="/compliance/audit-trail" element={<PageErrorBoundary><ComplianceAuditTrail /></PageErrorBoundary>} />
                  <Route path="/compliance/kyc-expiry"  element={<PageErrorBoundary><ComplianceKYCExpiry /></PageErrorBoundary>} />
                  <Route path="/compliance/aml-rules"   element={<PageErrorBoundary><ComplianceAMLRules /></PageErrorBoundary>} />

                  {/* People */}
                  <Route path="/hr"               element={<Navigate to="/hr/employees" replace />} />
                  <Route path="/hr/employees"     element={<PageErrorBoundary><HREmployees /></PageErrorBoundary>} />
                  <Route path="/hr/leave"         element={<PageErrorBoundary><HRLeave /></PageErrorBoundary>} />
                  <Route path="/hr/performance"   element={<PageErrorBoundary><HRPerformance /></PageErrorBoundary>} />
                  <Route path="/hr/disciplinary"  element={<PageErrorBoundary><HRDisciplinary /></PageErrorBoundary>} />
                  <Route path="/hr/training"      element={<PageErrorBoundary><HRTraining /></PageErrorBoundary>} />
                  <Route path="/hr/recruitment"   element={<PageErrorBoundary><HRRecruitment /></PageErrorBoundary>} />
                  <Route path="/hr/org-chart"     element={<PageErrorBoundary><HROrgChart /></PageErrorBoundary>} />
                  <Route path="/hr/employees/:id/onboarding"  element={<PageErrorBoundary><HROnboarding /></PageErrorBoundary>} />
                  <Route path="/hr/employees/:id/offboarding" element={<PageErrorBoundary><HROffboarding /></PageErrorBoundary>} />

                  <Route path="/payroll"                          element={<PageErrorBoundary><PayrollOverview /></PageErrorBoundary>} />
                  <Route path="/payroll/runs/:id"                 element={<PageErrorBoundary><PayrollRunDetail /></PageErrorBoundary>} />
                  <Route path="/payroll/runs/:runId/items/:itemId" element={<PageErrorBoundary><PayslipView /></PageErrorBoundary>} />

                  {/* Intelligence */}
                  <Route path="/reports"        element={<PageErrorBoundary><ReportsBI /></PageErrorBoundary>} />
                  <Route path="/reports/kpi"    element={<PageErrorBoundary><ReportsKPI /></PageErrorBoundary>} />
                  <Route path="/reports/export" element={<PageErrorBoundary><ReportsExport /></PageErrorBoundary>} />
                  <Route path="/statements"     element={<PageErrorBoundary><Statements /></PageErrorBoundary>} />

                  {/* Admin */}
                  <Route path="/admin"                       element={<PageErrorBoundary><AdminOverview /></PageErrorBoundary>} />
                  <Route path="/admin/overview"              element={<PageErrorBoundary><AdminOverview /></PageErrorBoundary>} />
                  <Route path="/admin/users"                 element={<PageErrorBoundary><AdminUsers /></PageErrorBoundary>} />
                  <Route path="/admin/roles"                 element={<PageErrorBoundary><AdminRoles /></PageErrorBoundary>} />
                  <Route path="/admin/email-senders"         element={<PageErrorBoundary><AdminEmailSenders /></PageErrorBoundary>} />
                  <Route path="/admin/mail"                  element={<PageErrorBoundary><AdminMailHealth /></PageErrorBoundary>} />
                  <Route path="/admin/api-keys"              element={<PageErrorBoundary><AdminApiKeys /></PageErrorBoundary>} />
                  <Route path="/admin/settings"              element={<PageErrorBoundary><AdminSettings /></PageErrorBoundary>} />
                  <Route path="/admin/notification-settings" element={<PageErrorBoundary><AdminNotificationSettings /></PageErrorBoundary>} />
                  <Route path="/admin/integrations"          element={<PageErrorBoundary><AdminIntegrations /></PageErrorBoundary>} />
                  <Route path="/admin/audit"                 element={<PageErrorBoundary><AdminAuditLog /></PageErrorBoundary>} />
                  <Route path="/admin/sync"                  element={<PageErrorBoundary><AdminSyncStatus /></PageErrorBoundary>} />
                  <Route path="/admin/helpdesk-settings"     element={<PageErrorBoundary><AdminHelpdeskSettings /></PageErrorBoundary>} />
                  <Route path="/admin/workflow-templates"   element={<PageErrorBoundary><AdminWorkflowTemplates /></PageErrorBoundary>} />

                  {/* Mail */}
                  <Route path="/mail/inbox"   element={<PageErrorBoundary><MailInbox /></PageErrorBoundary>} />
                  <Route path="/mail/compose" element={<PageErrorBoundary><MailCompose /></PageErrorBoundary>} />
                  <Route path="/mail/:id"     element={<PageErrorBoundary><MailThread /></PageErrorBoundary>} />

                  <Route path="/settings" element={<PageErrorBoundary><UserSettings /></PageErrorBoundary>} />

                  <Route path="*" element={<Navigate to={homeFor(role)} replace />} />
                </Routes>
              </PageFade>
            </Suspense>
          </main>
        </div>

        {/* C360 drawer */}
        <Suspense fallback={null}>
          <C360 open={c360Open} onClose={() => setC360Open(false)} />
        </Suspense>

        {/* Global search (Cmd+K) */}
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

        {/* Idle warning */}
        {idleWarn && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: 'var(--card)', borderRadius: 20, padding: 28, maxWidth: 340, width: '100%', margin: '0 16px', textAlign: 'center', boxShadow: '0 24px 64px rgba(0,0,0,0.3)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 36, color: 'var(--nav-dot)', display: 'block', marginBottom: 12 }}>timer</span>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)', marginBottom: 6 }}>Session expiring</h2>
              <p style={{ fontSize: 13, color: 'var(--txt2)', marginBottom: 20, lineHeight: 1.5 }}>
                25 minutes of inactivity. Move your mouse to stay signed in.
              </p>
              <button
                onClick={() => setIdleWarn(false)}
                style={{ width: '100%', padding: '10px 0', borderRadius: 12, border: 'none', background: 'var(--nav-dot)', color: 'var(--card)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                Stay signed in
              </button>
            </div>
          </div>
        )}
      </div>
    </BrowserRouter>
  )
})

// ── Force password change ─────────────────────────────────────────────────────

function ForceChangePassword({ onDone }: { onDone: () => void }) {
  const [pw,  setPw]  = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const [ok,  setOk]  = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (pw !== pw2) { setErr('Passwords do not match'); return }
    if (pw.length < 8) { setErr('Password must be at least 8 characters'); return }
    try {
      await apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ new_password: pw }) } as RequestInit)
      setOk(true)
      setTimeout(onDone, 1200)
    } catch (e: unknown) {
      setErr((e as Error).message ?? 'Failed')
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', fontFamily: "'Sora', sans-serif" }}>
      <div style={{ background: 'var(--card)', borderRadius: 20, padding: 32, maxWidth: 360, width: '100%', margin: '0 16px', boxShadow: 'var(--card-shadow)' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--txt)', marginBottom: 6 }}>Set your password</h1>
        <p style={{ fontSize: 13, color: 'var(--txt2)', marginBottom: 24 }}>Please set a new password before continuing.</p>
        {ok ? (
          <p style={{ color: 'var(--nav-dot)', fontWeight: 600 }}>Password updated — logging you in…</p>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input type="password" placeholder="New password" value={pw} onChange={e => setPw(e.target.value)}
              style={{ height: 48, borderRadius: 10, border: '1.5px solid var(--input-bdr)', padding: '0 14px', fontSize: 14, fontFamily: 'inherit', background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none' }} />
            <input type="password" placeholder="Confirm password" value={pw2} onChange={e => setPw2(e.target.value)}
              style={{ height: 48, borderRadius: 10, border: '1.5px solid var(--input-bdr)', padding: '0 14px', fontSize: 14, fontFamily: 'inherit', background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none' }} />
            {err && <p style={{ color: 'var(--nav-dot)', fontSize: 13 }}>{err}</p>}
            <button type="submit" style={{ height: 48, borderRadius: 10, border: 'none', background: 'var(--nav-dot)', color: 'var(--card)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Set password
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (import.meta.env.DEV) {
      setUser({
        id: 1, name: 'Temitope Posi', email: 'admin@o3cards.com',
        role: 'md', pages: [], must_change_password: false,
      })
      setLoading(false)
      return
    }

    const stored = localStorage.getItem('o3c_user')
    if (!stored) { setLoading(false); return }

    let u: AuthUser
    try {
      u = JSON.parse(stored) as AuthUser
      if (!u?.name || !u?.role) { setLoading(false); return }
    } catch { setLoading(false); return }

    // Always verify via a silent refresh — the CSRF cookie alone is not a
    // reliable proxy because the HttpOnly access token may have been cleared
    // independently (e.g., by a browser privacy extension).
    refreshSession().then(ok => {
      if (ok) { setUser(u) } else { localStorage.removeItem('o3c_user') }
      setLoading(false)
    })
  }, [])

  // Cross-tab logout: always listen so logout on Tab B clears Tab A
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === 'o3c_user' && !e.newValue) setUser(null) }
    const onExpired = () => { setUser(null); toast.error('Session expired') }
    window.addEventListener('storage',      onStorage)
    window.addEventListener('auth:expired', onExpired)
    return () => {
      window.removeEventListener('storage',      onStorage)
      window.removeEventListener('auth:expired', onExpired)
    }
  }, [])

  const handleLogin  = useCallback((u: AuthUser) => {
    setUser(u)
    toast.success(`Welcome back, ${u.name.split(' ')[0]}`, { description: roleLabel(u.role as string) })
  }, [])

  const handleLogout = useCallback(() => {
    apiLogout()
    setUser(null)
    toast.info('Signed out')
  }, [])

  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/csat/')) {
    return (
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes><Route path="/csat/:token" element={<CSATSurvey />} /></Routes>
        </Suspense>
      </BrowserRouter>
    )
  }

  if (typeof window !== 'undefined' && window.location.pathname === '/design-demo') {
    const DesignDemo = lazy(() => import('./pages/DesignDemo'))
    return (
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes><Route path="/design-demo" element={<DesignDemo />} /></Routes>
        </Suspense>
      </BrowserRouter>
    )
  }

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F4F6FA' }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', border: '2.5px solid rgba(14,40,65,0.12)', borderTopColor: '#C00000', animation: 'spin 0.7s linear infinite' }} />
    </div>
  )

  if (!user) return (
    <>
      <Toaster richColors position="top-right" />
      <Suspense fallback={null}>
        <Login onLogin={handleLogin} />
      </Suspense>
    </>
  )

  if (user.must_change_password) {
    const LIGHT_LOCAL = { '--bg': '#F4F6FA', '--card': '#FFFFFF', '--txt': '#0F1623', '--txt2': '#798094', '--input-bg': '#F2F4F9', '--input-bdr': '#DDE0EA', '--nav-dot': '#C00000', '--card-shadow': '0 1px 2px rgba(0,0,0,0.04), 0 4px 18px rgba(0,0,0,0.05)' } as React.CSSProperties
    return (
      <>
        <Toaster richColors position="top-right" />
        <div style={LIGHT_LOCAL}>
          <ForceChangePassword onDone={() => {
            setUser(u => u ? { ...u, must_change_password: false } : u)
            const stored = localStorage.getItem('o3c_user')
            if (stored) try { localStorage.setItem('o3c_user', JSON.stringify({ ...JSON.parse(stored), must_change_password: false })) } catch {}
          }} />
        </div>
      </>
    )
  }

  return <AppShell user={user} onLogout={handleLogout} />
}
