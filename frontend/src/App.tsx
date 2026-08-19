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
import C360Drawer       from './components/C360Drawer'
import { RealtimeProvider } from './hooks/useRealtime'
import { type AuthUser, ROLE_PAGES, allRoles } from './hooks/useAuth'
import { useCustomerSearch } from './hooks/useCustomerSearch'
import { useModules } from './hooks/useModules'
import { useAgentPresence } from './hooks/useAgentPresence'
import { roleLabel, MGMT } from './lib/roles'
import { API, apiFetch, apiPost, apiLogout, refreshSession } from './lib/api'
import { LIGHT, DARK, GREEN, BLUE, NAVY, PLEX, MONO, RED, CANVAS }  from './lib/design'
import { IcoSearch, IcoApprove, IcoSun, IcoMoon } from './lib/icons'
import { fmtKobo } from './lib/fmt'
import { ConfirmModal } from './components/UI'

// ── Lazy imports ──────────────────────────────────────────────────────────────
const CSATSurvey   = lazy(() => import('./pages/helpdesk/CSATSurvey'))
const UserSettings = lazy(() => import('./pages/Settings'))

// Intelligence
const ReportsMyDashboard = lazy(() => import('./pages/reports/MyDashboard'))
const ReportsLibrary  = lazy(() => import('./pages/reports/ReportsLibrary'))
const ReportsKPI      = lazy(() => import('./pages/reports/KPITracker'))
const ReportsExport   = lazy(() => import('./pages/reports/Export'))
const BIOverview      = lazy(() => import('./pages/bi/BIOverview'))
const BIBuilder       = lazy(() => import('./pages/bi/ReportBuilder'))
const BIScheduled     = lazy(() => import('./pages/bi/ScheduledReports'))
const Statements    = lazy(() => import('./pages/statements/Statements'))
const Login    = lazy(() => import('./pages/Login'))
const Overview = lazy(() => import('./pages/Overview'))

// Executive drill-down pages
const ExecCards       = lazy(() => import('./pages/executive/Cards'))
const ExecFinance     = lazy(() => import('./pages/executive/Finance'))
const ExecSales       = lazy(() => import('./pages/executive/Sales'))
const ExecCollections = lazy(() => import('./pages/executive/Collections'))
const ExecRisk        = lazy(() => import('./pages/executive/Risk'))
const ExecSettlements = lazy(() => import('./pages/executive/Settlements'))
const ExecFixedDeposits = lazy(() => import('./pages/executive/FixedDeposits'))
const Interswitch          = lazy(() => import('./pages/cards/Interswitch'))
const InterswitchReport    = lazy(() => import('./pages/cards/InterswitchReport'))
const InterswitchImport    = lazy(() => import('./pages/cards/InterswitchImport'))
// C360Drawer imported directly (not lazy) so slide animation works on first open

// BD
const BDOverview     = lazy(() => import('./pages/bd/Overview'))
const BDPipeline     = lazy(() => import('./pages/bd/Pipeline'))
const BDEmployers    = lazy(() => import('./pages/bd/Employers'))
const BDAssignments  = lazy(() => import('./pages/bd/Assignments'))

// Campaigns
const CampaignsList     = lazy(() => import('./pages/campaigns/List'))
const CampaignTemplates      = lazy(() => import('./pages/campaigns/Templates'))
const CampaignTemplateEditor = lazy(() => import('./pages/campaigns/TemplateEditor'))
const CampaignLists          = lazy(() => import('./pages/campaigns/ContactLists'))
const CampaignReport         = lazy(() => import('./pages/campaigns/Report'))
const CampaignEditor         = lazy(() => import('./pages/campaigns/Editor'))

// Approvals & Mail
const ApprovalsPage  = lazy(() => import('./pages/Approvals'))
const MailOverview   = lazy(() => import('./pages/mail/Overview'))
const MailInbox      = lazy(() => import('./pages/mail/Inbox'))
const MailCompose    = lazy(() => import('./pages/mail/Compose'))
const MailThread     = lazy(() => import('./pages/mail/ThreadDetail'))

// Sales
const SalesOverview  = lazy(() => import('./pages/sales/Overview'))
const SalesCohort    = lazy(() => import('./pages/sales/Cohort'))
const SalesCohortDetail = lazy(() => import('./pages/sales/CohortDetail'))
const SalesTargets   = lazy(() => import('./pages/sales/Targets'))
const CRMContacts    = lazy(() => import('./pages/sales/Customers'))
const SalesBook      = lazy(() => import('./pages/sales/Book'))
const SalesBookCustomer = lazy(() => import('./pages/sales/BookCustomer'))
const TaskModal      = lazy(() => import('./components/TaskModal'))
const ScriptsDrawer  = lazy(() => import('./components/ScriptsDrawer'))
const SalesLeads     = lazy(() => import('./pages/sales/Leads'))
const CRMContactDetail = lazy(() => import('./pages/sales/ContactDetail'))
const ContactProfile   = lazy(() => import('./pages/contacts/ContactProfile'))
const CustomerDirectory = lazy(() => import('./pages/directory/Customers'))
const ContactSegments  = lazy(() => import('./pages/contacts/Segments'))
const CRMTasks       = lazy(() => import('./pages/sales/Tasks'))
// LOS (loan origination)
const LOSQueue         = lazy(() => import('./pages/los/Queue'))
const LOSNewApp        = lazy(() => import('./pages/los/NewApplication'))
const LOSAppDetail     = lazy(() => import('./pages/los/ApplicationDetail'))

// Mobile App & Blink Card
const MobileAppDashboard = lazy(() => import('./pages/mobile/Dashboard'))
const BlinkCard          = lazy(() => import('./pages/cards/BlinkCard'))

// Collections
const CollectionsOverview  = lazy(() => import('./pages/collections/Overview'))
const CollectionsQueue     = lazy(() => import('./pages/collections/Queue'))
const CollectionsPromises  = lazy(() => import('./pages/collections/Promises'))
const CollectionsPlans     = lazy(() => import('./pages/collections/RepaymentPlans'))
const CollectionsWriteoffs    = lazy(() => import('./pages/collections/WriteoffQueue'))
const CollectionsPortfolio    = lazy(() => import('./pages/collections/Portfolio'))
const CollectionsAccountDetail = lazy(() => import('./pages/collections/AccountDetail'))
const CollectionsWoRequests   = lazy(() => import('./pages/collections/WriteoffRequests'))
const CollectionsRecoveryPmts = lazy(() => import('./pages/collections/RecoveryPaymentApprovals'))
const CollectionsWatchlist    = lazy(() => import('./pages/collections/Watchlist'))
const CollectionsActivityLog  = lazy(() => import('./pages/collections/ActivityLog'))
const RecoveryActivityLog     = lazy(() => import('./pages/recovery/ActivityLog'))
const CreditAuditTrail        = lazy(() => import('./pages/compliance/CreditAuditTrail'))

// Risk
const RiskMyDashboard   = lazy(() => import('./pages/risk/MyDashboard'))
const RiskOverview      = lazy(() => import('./pages/risk/Overview'))
const RiskAppReview     = lazy(() => import('./pages/risk/AppReview'))
const RiskPortfolio     = lazy(() => import('./pages/risk/Portfolio'))
const RiskVintage       = lazy(() => import('./pages/risk/VintageAnalysis'))
const RiskVintageDetail = lazy(() => import('./pages/risk/VintageDetail'))
// Previously orphaned: both files existed and were imported nowhere, so the routes
// below did not exist and the code was dead. CreditFile is the only implementation
// that matches the /api/risk/credit-file contract.
const RiskEyeScore      = lazy(() => import('./pages/risk/EyeScore'))
const RiskCreditFile    = lazy(() => import('./pages/risk/CreditFile'))
const RiskSectorCodes   = lazy(() => import('./pages/risk/SectorCodes'))

// Recovery
const RecoveryOverview    = lazy(() => import('./pages/recovery/Overview'))
const RecoveryCases       = lazy(() => import('./pages/recovery/Cases'))
const RecoveryCaseDetail  = lazy(() => import('./pages/recovery/CaseDetail'))
const RecoveryLegal       = lazy(() => import('./pages/recovery/Legal'))
const RecoveryDebtSale    = lazy(() => import('./pages/recovery/DebtSale'))

// Collections Ops
const CollOpsAgentDash = lazy(() => import('./pages/collections-ops/AgentDashboard'))

// Agent dashboards
const RecoveryAgentDash   = lazy(() => import('./pages/recovery-ops/Agent'))
const SalesMyDashboard    = lazy(() => import('./pages/sales/MyDashboard'))
const SalesSupervisor     = lazy(() => import('./pages/sales/Supervisor'))
const HelpdeskOverview    = lazy(() => import('./pages/helpdesk/Overview'))
const HelpdeskMyDashboard = lazy(() => import('./pages/helpdesk/MyDashboard'))
const BDMyDashboard       = lazy(() => import('./pages/bd/MyDashboard'))
const CardsMyQueue        = lazy(() => import('./pages/cards/MyQueue'))

// Helpdesk
const HelpdeskTickets     = lazy(() => import('./pages/helpdesk/Tickets'))
const HelpdeskEscalations = lazy(() => import('./pages/helpdesk/Escalations'))
const HelpdeskTicketDetail = lazy(() => import('./pages/helpdesk/TicketDetail'))
const HelpdeskNewTicket   = lazy(() => import('./pages/helpdesk/NewTicketPage'))
const CareInbox           = lazy(() => import('./pages/care/Inbox'))
const CareHub             = lazy(() => import('./pages/care/CareHub'))
const HelpdeskSupervisor  = lazy(() => import('./pages/helpdesk/Supervisor'))
const HelpdeskCalls       = lazy(() => import('./pages/helpdesk/Calls'))
const HelpdeskStats       = lazy(() => import('./pages/helpdesk/Stats'))
const HelpdeskKB          = lazy(() => import('./pages/helpdesk/KnowledgeBase'))
const HelpdeskCanned      = lazy(() => import('./pages/helpdesk/Canned'))
const HelpdeskCallScripts = lazy(() => import('./pages/helpdesk/CallScripts'))
const HelpdeskCBNReport   = lazy(() => import('./pages/helpdesk/CBNReport'))

// Cards
const CardsOverview    = lazy(() => import('./pages/cards/Overview'))
const CardCreditPortfolio = lazy(() => import('./pages/cards/CreditPortfolio'))
const CardCycleImport   = lazy(() => import('./pages/cards/CycleImport'))
const CardAtRisk        = lazy(() => import('./pages/cards/AtRiskCards'))
const CardTrends       = lazy(() => import('./pages/cards/Trends'))
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
const AdminModules               = lazy(() => import('./pages/admin/Modules'))

// Finance
const FinanceMyDashboard  = lazy(() => import('./pages/finance/MyDashboard'))
const FinanceOverview     = lazy(() => import('./pages/finance/Overview'))
const FinanceTxns         = lazy(() => import('./pages/finance/Transactions'))
const FinanceIncome       = lazy(() => import('./pages/finance/Income'))
const FinanceFixedDeposits = lazy(() => import('./pages/finance/FixedDeposits'))
const FinanceEOD          = lazy(() => import('./pages/finance/Eod'))
const FinanceFXRates      = lazy(() => import('./pages/finance/FXRates'))

// Settlements
const SettleMyDashboard = lazy(() => import('./pages/settlements/MyDashboard'))
const SettleOverview   = lazy(() => import('./pages/settlements/Overview'))
const SettleBatches    = lazy(() => import('./pages/settlements/Batches'))
const SettleNIP        = lazy(() => import('./pages/settlements/NIP'))
const SettleNIPRecon   = lazy(() => import('./pages/settlements/NIPReconciliation'))
const SettleRecon      = lazy(() => import('./pages/settlements/Reconciliation'))
const SettleFailed     = lazy(() => import('./pages/settlements/FailedTransactions'))
const SettleManualPost = lazy(() => import('./pages/settlements/ManualPostings'))
const SettleWorkbench  = lazy(() => import('./pages/settlements/Workbench'))
const SettleExceptions = lazy(() => import('./pages/settlements/Exceptions'))
const SettlePosition   = lazy(() => import('./pages/settlements/Position'))
const SettleRuns       = lazy(() => import('./pages/settlements/Runs'))

// Call Center
const CallCenterQueue          = lazy(() => import('./pages/call-center/Queue'))
const CallCenterLeads          = lazy(() => import('./pages/call-center/Leads'))
const CallCenterDNC            = lazy(() => import('./pages/call-center/DNC'))
const CallCenterPerformance    = lazy(() => import('./pages/call-center/Performance'))
const CallCenterVoiceSpike     = lazy(() => import('./pages/call-center/VoiceSpike'))
const CallCenterInbound        = lazy(() => import('./pages/call-center/Inbound'))

// Marketing
const MarketingOverview    = lazy(() => import('./pages/marketing/Overview'))
const MarketingAnalytics   = lazy(() => import('./pages/marketing/MarketingAnalytics'))

// Payroll
const PayrollOverview = lazy(() => import('./pages/payroll/PayrollOverview'))
const PayrollRunDetail = lazy(() => import('./pages/payroll/RunDetail'))
const PayslipView     = lazy(() => import('./pages/payroll/PayslipView'))

// Compliance
const ComplianceMyDashboard    = lazy(() => import('./pages/compliance/MyDashboard'))
const ComplianceWatchlist      = lazy(() => import('./pages/compliance/WatchList'))
const ComplianceRegCalendar    = lazy(() => import('./pages/compliance/RegulatoryCalendar'))
const ComplianceFindings       = lazy(() => import('./pages/compliance/Findings'))
const ComplianceChecklists     = lazy(() => import('./pages/compliance/Checklists'))
const ComplianceAuditTrail     = lazy(() => import('./pages/compliance/AuditTrail'))
const CompliancePrudential     = lazy(() => import('./pages/compliance/PrudentialRatios'))
const ComplianceDSAR           = lazy(() => import('./pages/compliance/DataSubjectRequests'))
const ComplianceKYCExpiry   = lazy(() => import('./pages/compliance/KYCExpiry'))
const ComplianceAMLRules    = lazy(() => import('./pages/compliance/AMLRules'))
const ComplianceConcentration = lazy(() => import('./pages/compliance/ConcentrationRisk'))
const ComplianceDPARegister   = lazy(() => import('./pages/compliance/DPARegister'))
const ComplianceSOC2          = lazy(() => import('./pages/compliance/SOC2'))
const ComplianceSOC2Detail    = lazy(() => import('./pages/compliance/SOC2ControlDetail'))
const CompliancePentest       = lazy(() => import('./pages/compliance/PentestDashboard'))
const CompliancePolicies      = lazy(() => import('./pages/compliance/PolicyDocuments'))
const ComplianceBoardPack     = lazy(() => import('./pages/compliance/BoardPack'))
const ComplianceCreditBureau  = lazy(() => import('./pages/compliance/CreditBureau'))
const ComplianceBreach        = lazy(() => import('./pages/compliance/BreachIncidents'))

// HR
const CoreBanking       = lazy(() => import('./pages/core-banking/CoreBanking'))
const CCStatements      = lazy(() => import('./pages/statements/CCStatements'))
const CCStatementNew    = lazy(() => import('./pages/statements/CCStatementNew'))
const CCStatementDetail = lazy(() => import('./pages/statements/CCStatementDetail'))

// Presence beacon for call-facing roles — mounted once in the shell so an agent goes
// online on login, stays online while the app is open, and drops offline on close.
// Renders nothing.
function AgentPresence({ enabled }: { enabled: boolean }) {
  useAgentPresence(enabled)
  return null
}

// ── Role → home ───────────────────────────────────────────────────────────────

function homeFor(role: string): string {
  const map: Record<string, string> = {
    md: '/', coo: '/', cfo: '/', cmo: '/', executive: '/',
    admin: '/', management: '/', head_ops: '/', head_it: '/admin/overview',
    sales_officer: '/sales',       sales_head: '/sales',   head_sales: '/sales',
    bd_officer: '/bd',             bd_head: '/bd',
    risk_officer: '/operations/risk', risk_head: '/operations/risk',
    finance_officer: '/finance',   finance_head: '/finance',
    cards_ops_officer: '/cards',   cards_ops_head: '/cards',
    collections_agent: '/collections', collections_head: '/collections',
    head_collections: '/collections',
    recovery_agent: '/recovery',   recovery_head: '/recovery',
    head_recovery: '/recovery',
    call_center_agent: '/helpdesk/my-dashboard', call_center_head: '/helpdesk',
    compliance_officer: '/compliance', compliance_head: '/compliance',
    internal_control_head: '/compliance',
    it_admin: '/admin/overview',
    bi_analyst: '/reports',        bi_head: '/reports',
    settlement_officer: '/settlements', settlement_head: '/settlements',
    payroll_officer: '/payroll',   payroll_manager: '/payroll',
  }
  return map[role] ?? '/'
}

// ── Access guard ──────────────────────────────────────────────────────────────


function RequireAccess({ page, user, children }: { page: string | string[]; user: AuthUser; children: ReactNode }) {
  const roles = allRoles(user)
  // Only admin & MD are unrestricted (admin bypasses backend gating; MD holds
  // every page). All other roles — including coo/cfo/cmo — are gated by their
  // actual pages so frontend access matches the backend exactly (no more
  // "nav opens but the API 403s"). user.pages (baked at login) is authoritative;
  // ROLE_PAGES is only a dev/empty-token fallback and now mirrors the backend.
  if (roles.some(r => r === 'admin' || r === 'md')) return <>{children}</>
  const pages = Array.isArray(page) ? page : [page]
  const userPages = user.pages?.length ? user.pages : roles.flatMap(r => ROLE_PAGES[r] ?? [])
  const allowed = pages.some(p => userPages.includes(p))
  if (!allowed) return <Navigate to={homeFor(user.role as string)} replace />
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
  useEffect(() => {
    const match = MODULE_TITLES.find(([prefix]) => prefix === '/' ? pathname === '/' : pathname.startsWith(prefix))
    document.title = match ? `${match[2]} — O3 Capital Workspace` : 'O3 Capital Workspace'
  }, [pathname])
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

// ── Module title + breadcrumb map ────────────────────────────────────────────

const MODULE_TITLES: [string, string, string][] = [
  ['/approvals',       'Workspace',         'Approvals'],
  ['/bd',              'Sales & BD',        'Business Dev'],
  ['/mail',            'Sales & BD',        'Mail'],
  ['/campaigns',       'Sales & BD',        'Campaigns & Marketing'],
  ['/marketing',       'Sales & BD',        'Marketing'],
  ['/sales/crm',       'Sales',             'Pipeline'],
  ['/sales/customers', 'Sales',             'Contacts'],
  ['/sales',           'Sales',             'Sales'],
  ['/call-center',     'Call Center',       'Call Center'],
  ['/helpdesk',        'Call Center',       'Overview'],
  ['/care',            'Care',              'Care'],
  ['/blink-card',      'Cards',             'Blink Card'],
  ['/mobile-app',      'Cards',             'Mobile App Analytics'],
  ['/cards',           'Cards',             'Card Operations'],
  ['/operations/risk', 'Credit Management', 'Risk'],
  ['/collections',     'Credit Management', 'Collections'],
  ['/recovery',        'Credit Management', 'Recovery'],
  ['/finance',         'Finance',           'Finance'],
  ['/settlements',     'Finance',           'Settlements'],
  ['/compliance',      'Compliance',        'Compliance'],
  ['/reports',         'Analytics',         'Reports & BI'],
  ['/bi',              'Analytics',         'Reports & BI'],
  ['/statements',      'Analytics',         'Statements'],
  ['/core-banking',              'Analytics',  'Core Banking'],
  ['/statements/credit-cards',  'Analytics',  'CC Statements'],
  ['/admin',           'Admin',             'System Admin'],
  ['/settings',        'Workspace',         'Settings'],
  ['/',                '',                  'Overview'],
]

function useModuleTitle() {
  const { pathname } = useLocation()
  const match = MODULE_TITLES.find(([prefix]) =>
    prefix === '/' ? pathname === '/' : pathname.startsWith(prefix)
  )
  return { crumb: match?.[1] ?? '', title: match?.[2] ?? 'Workspace' }
}

function HeadTitles() {
  const { crumb, title } = useModuleTitle()
  return (
    <div style={{ flexShrink: 0 }}>
      {crumb && (
        <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 2 }}>
          {crumb}
        </div>
      )}
      <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--txt)', whiteSpace: 'nowrap' }}>
        {title}
      </h1>
    </div>
  )
}


// ── TopBar icon button ─────────────────────────────────────────────────────────

function TbBtn({ onClick, title, children }: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} style={{
      position: 'relative', width: 34, height: 34, borderRadius: 5,
      border: '1px solid var(--bdr)', background: 'var(--card)',
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--txt2)', transition: 'border-color .12s, color .12s',
    }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.borderColor = 'var(--txt3)'
        el.style.color = 'var(--txt)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.borderColor = 'var(--bdr)'
        el.style.color = 'var(--txt2)'
      }}
    >
      {children}
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

// ── Approvals dropdown ────────────────────────────────────────────────────────

interface ApprovalItem {
  item_id:      number
  module:       string
  stage:        string
  title:        string
  description?: string
  amount_kobo?: number
  requested_by?: string
}

function ApprovalsDropdown({ user }: { user: AuthUser }) {
  const navigate = useNavigate()
  const [open,         setOpen]         = useState(false)
  const [items,        setItems]        = useState<ApprovalItem[]>([])
  const [count,        setCount]        = useState(0)
  const [acted,        setActed]        = useState<Record<string, 'approved' | 'rejected'>>({})
  const [rejectTarget, setRejectTarget] = useState<ApprovalItem | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectLoading, setRejectLoading] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const role = user.role as string
  const canApprove = MGMT.has(role) || role === 'finance_head' || role === 'compliance_head'

  const loadApprovals = useCallback(() => {
    if (!canApprove) return
    apiFetch<{ data: ApprovalItem[] }>('/api/approvals/pending', { silent: true })
      .then(d => { const list = d.data ?? []; setItems(list); setCount(list.length) })
      .catch(() => {})
  }, [canApprove])

  useEffect(() => {
    loadApprovals()
    const t = setInterval(loadApprovals, 60_000)
    return () => clearInterval(t)
  }, [loadApprovals])

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function handleApprove(item: ApprovalItem) {
    const key = `${item.module}-${item.item_id}`
    try {
      await apiPost('/api/approvals/batch', {
        action: 'approve',
        notes: '',
        items: [{ module: item.module, item_id: item.item_id }],
      })
      setActed(a => ({ ...a, [key]: 'approved' }))
      setCount(c => Math.max(0, c - 1))
    } catch {}
  }

  async function handleReject() {
    if (!rejectTarget) return
    const key = `${rejectTarget.module}-${rejectTarget.item_id}`
    setRejectLoading(true)
    try {
      await apiPost('/api/approvals/batch', {
        action: 'reject',
        notes: rejectReason,
        items: [{ module: rejectTarget.module, item_id: rejectTarget.item_id }],
      })
      setActed(a => ({ ...a, [key]: 'rejected' }))
      setCount(c => Math.max(0, c - 1))
    } catch {}
    setRejectLoading(false)
    setRejectTarget(null)
    setRejectReason('')
  }

  if (!canApprove) return null

  const pendingCount = Math.max(0, count - Object.keys(acted).length)

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Approvals"
        style={{
          position: 'relative', width: 34, height: 34,
          borderRadius: 5, border: '1px solid var(--bdr)',
          background: 'var(--card)',
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--txt2)',
          transition: 'border-color .12s, color .12s',
        }}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--txt3)'; el.style.color = 'var(--txt)'
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--bdr)'; el.style.color = 'var(--txt2)'
        }}
      >
        <IcoApprove size={16} />
        {pendingCount > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5,
            minWidth: 16, height: 16, borderRadius: 8,
            background: RED, color: '#fff',
            fontSize: 9.5, fontWeight: 600, fontFamily: MONO,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
          }}>
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0,
          width: 340, background: 'var(--card)',
          border: '1px solid var(--bdr)', borderRadius: 6,
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          zIndex: 9500, overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--bdr)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', fontFamily: "'Sora', sans-serif" }}>
              Pending approvals
            </span>
          </div>

          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--txt3)', fontSize: 13, fontFamily: "'Sora', sans-serif" }}>
                No pending approvals
              </div>
            ) : items.map(item => {
              const key = `${item.module}-${item.item_id}`
              return (
              <div key={key} style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)' }}>
                {acted[key] ? (
                  <div style={{
                    fontSize: 12.5, fontWeight: 600, fontFamily: "'Sora', sans-serif",
                    color: acted[key] === 'approved' ? GREEN : RED,
                  }}>
                    {acted[key] === 'approved' ? '✓ Approved' : '✗ Rejected'}
                    <span style={{ fontWeight: 400, color: 'var(--txt3)', marginLeft: 6 }}>{item.title}</span>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', marginBottom: 4, fontFamily: "'Sora', sans-serif", lineHeight: 1.3 }}>
                      {item.title}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--txt2)', marginBottom: 10, fontFamily: "'Sora', sans-serif", lineHeight: 1.4 }}>
                      {item.description}
                      {item.amount_kobo != null && <> · <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtKobo(item.amount_kobo)}</span></>}
                      {item.requested_by && <> · raised by {item.requested_by}</>}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => handleApprove(item)}
                        style={{
                          padding: '4px 14px', borderRadius: 6, border: 'none',
                          background: GREEN, color: '#fff', fontSize: 12, fontWeight: 600,
                          cursor: 'pointer', fontFamily: "'Sora', sans-serif",
                        }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => setRejectTarget(item)}
                        style={{
                          padding: '4px 14px', borderRadius: 6,
                          border: '1px solid var(--bdr)', background: 'transparent',
                          color: 'var(--txt2)', fontSize: 12, cursor: 'pointer', fontFamily: "'Sora', sans-serif",
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </>
                )}
              </div>
              )
            })}
          </div>

          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--bdr)' }}>
            <button
              onClick={() => { setOpen(false); navigate('/approvals') }}
              style={{ fontSize: 12, color: BLUE, border: 'none', background: 'none', cursor: 'pointer', fontFamily: "'Sora', sans-serif", padding: 0, fontWeight: 500 }}
            >
              View all approvals
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!rejectTarget}
        title="Reject approval"
        body={rejectTarget ? `Rejecting: ${rejectTarget.title}` : ''}
        confirmLabel="Reject"
        danger
        loading={rejectLoading}
        onConfirm={handleReject}
        onClose={() => { setRejectTarget(null); setRejectReason('') }}
      >
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
          value={rejectReason}
          onChange={e => setRejectReason(e.target.value)}
          placeholder="Enter rejection reason…"
          rows={3}
          style={{
            width: '100%', padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--bdr)', background: 'var(--input-bg)',
            color: 'var(--txt)', fontSize: 13, fontFamily: 'inherit',
            resize: 'none', boxSizing: 'border-box',
          }}
        />
      </ConfirmModal>
    </div>
  )
}

// ── Theme toggle ──────────────────────────────────────────────────────────────

function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <TbBtn onClick={onToggle} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? <IcoSun size={16} /> : <IcoMoon size={16} />}
    </TbBtn>
  )
}

// ── C360 inline search bar ────────────────────────────────────────────────────

interface C360Hit { cif: string; name: string; phone: string; email: string }

function C360Bar({ onPick }: { onPick: (r: C360Hit) => void }) {
  // Shared hook = consistent debounce/min-length and, importantly, a race guard so a
  // slow earlier response can't overwrite fresher results while typing fast.
  const { query, setQuery, results, loading, reset } = useCustomerSearch({ limit: 8 })
  const [focused, setFocused] = useState(false)
  const [show,    setShow]    = useState(false)
  const wrapRef   = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShow(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Open the dropdown whenever there's a searchable query (covers loading + empty too).
  useEffect(() => { if (query.trim().length >= 2) setShow(true) }, [query, results])

  function pick(r: C360Hit) {
    reset(); setShow(false)
    onPick(r)
  }

  return (
    <div
      ref={wrapRef}
      style={{
        flex: 1, maxWidth: 380, marginLeft: 16, position: 'relative', cursor: 'text',
        display: 'flex', alignItems: 'center', gap: 8,
        border: `1px solid ${focused ? '#0EA5E9' : 'var(--bdr)'}`,
        borderRadius: 8, background: 'var(--card)',
        padding: '7px 11px', color: 'var(--txt3)',
        transition: 'border-color .12s',
      }}
    >
      <IcoSearch size={14} style={{ flexShrink: 0 }} />
      <input
        className="srch-input"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => { setFocused(true); if (query.trim().length >= 2) setShow(true) }}
        onBlur={() => setFocused(false)}
        onKeyDown={e => { if (e.key === 'Escape') { setShow(false); reset() } }}
        placeholder="Customer 360: name, CIF, phone or email…"
        style={{
          border: 'none', outline: 'none', background: 'none', flex: 1,
          fontFamily: "'Sora', sans-serif", fontSize: 12.5, color: 'var(--txt)',
          minWidth: 0,
        }}
      />

      {show && query.trim().length >= 2 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
          background: 'var(--card)', border: '1px solid var(--bdr)',
          borderRadius: 6, boxShadow: '0 12px 40px rgba(0,0,0,.18)',
          zIndex: 30, overflow: 'hidden',
        }}>
          {results.length > 0 ? results.map(r => (
            <div
              key={r.cif}
              onClick={() => pick(r)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 13px', cursor: 'pointer',
                fontSize: 12.5, color: 'var(--txt)',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <strong style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</strong>
              {r.phone && <span style={{ fontSize: 11, color: 'var(--txt3)' }}>{r.phone}</span>}
              {r.card_count != null && r.card_count > 1 && (
                <span style={{ fontSize: 10, color: 'var(--txt3)' }}>· {r.card_count} accounts</span>
              )}
              <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11, color: 'var(--txt3)', flexShrink: 0 }}>{r.cif}</span>
            </div>
          )) : (
            <div style={{ padding: '9px 13px', color: 'var(--txt3)', fontSize: 12.5, cursor: 'default' }}>
              {loading ? 'Searching…' : <>No customers match &ldquo;{query}&rdquo;</>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function TopBar({
  user, dark, onToggleDark, onPickC360,
}: {
  user: AuthUser
  dark: boolean
  onToggleDark: () => void
  onPickC360:  (r: C360Hit) => void
}) {
  const navigate = useNavigate()
  return (
    <div style={{
      flexShrink: 0,
      display: 'flex', alignItems: 'center',
      padding: '14px 24px', gap: 14,
      background: 'var(--card)',
      borderBottom: '1px solid var(--bdr)',
      boxShadow: '0 1px 0 var(--bdr)',
    }}>
      {/* Left: breadcrumb + h1 */}
      <HeadTitles />

      {/* Centre: C360 inline search — margin-left:16px matches demo */}
      <C360Bar onPick={onPickC360} />

      {/* Right: icon buttons + primary action */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <ThemeToggle dark={dark} onToggle={onToggleDark} />
        <ApprovalsDropdown user={user} />
        <NotificationBell />
      </div>
    </div>
  )
}

// ── Idle timer ────────────────────────────────────────────────────────────────

const IDLE_WARN_MS   = 25 * 60 * 1000
const IDLE_LOGOUT_MS = 30 * 60 * 1000

// ── App shell ─────────────────────────────────────────────────────────────────

const AppShell = memo(function AppShell({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const enabledModules = useModules()
  const [c360Open,    setC360Open]    = useState(false)
  const [c360Customer, setC360Customer] = useState<{ cif: string; name: string; phone: string; email: string } | null>(null)
  const [searchOpen,  setSearchOpen]  = useState(false)
  const [idleWarn,    setIdleWarn]    = useState(false)
  const [dark,        setDark]        = useState(() => {
    const stored = localStorage.getItem('o3c_theme')
    if (stored) return stored === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

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
      // M11: Cmd+Enter / Ctrl+Enter → submit the focused form
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const active = document.activeElement
        const form = active?.closest('form') as HTMLFormElement | null
        if (form) {
          e.preventDefault()
          const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)')
          submitBtn ? submitBtn.click() : form.requestSubmit?.()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const role = user.role as string

  return (
    <BrowserRouter>
     <RealtimeProvider>
      <div style={{
        display: 'flex', height: '100vh', overflow: 'hidden',
        ...(dark ? DARK : LIGHT),
        background: 'var(--bg)',
        fontFamily: "'Sora', sans-serif",
      }}>
        <Toaster richColors position="top-right" />
        <AgentPresence enabled={role === 'call_center_agent' || role === 'call_center_head'} />

        {/* Sidebar */}
        <Sidebar user={user} onLogout={onLogout} onCmdK={() => setSearchOpen(true)} enabledModules={enabledModules} />

        {/* Main column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* Top bar */}
          <TopBar
            user={user}
            dark={dark}
            onToggleDark={toggleDark}
            onPickC360={(r: C360Hit) => { setC360Customer(r); setC360Open(true) }}
          />

          {/* Page area */}
          <main style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
            <Suspense fallback={<PageLoader />}>
              <PageFade>
                <Routes>
                  <Route path="/" element={
                    MGMT.has(role) ? <Overview /> : <Navigate to={homeFor(role)} replace />
                  } />

                  {/* Executive department drill-downs */}
                  <Route path="/executive/cards"        element={<RequireAccess page="executive" user={user}><PageErrorBoundary><ExecCards /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/executive/finance"      element={<RequireAccess page="executive" user={user}><PageErrorBoundary><ExecFinance /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/executive/sales"        element={<RequireAccess page="executive" user={user}><PageErrorBoundary><ExecSales /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/executive/collections"  element={<RequireAccess page="executive" user={user}><PageErrorBoundary><ExecCollections /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/executive/risk"         element={<RequireAccess page="executive" user={user}><PageErrorBoundary><ExecRisk /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/executive/settlements"  element={<RequireAccess page="executive" user={user}><PageErrorBoundary><ExecSettlements /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/executive/fixed-deposits" element={<RequireAccess page="executive" user={user}><PageErrorBoundary><ExecFixedDeposits /></PageErrorBoundary></RequireAccess>} />
                  {/* Page key is 'settlement' (singular) — 'settlements' matches no role and
                      bounced settlement_officer / head_of_reconciliation / finance_head home.
                      'cards' is accepted too since the feed is card activity. */}
                  <Route path="/settlements/interswitch"           element={<RequireAccess page={['settlement','cards']} user={user}><PageErrorBoundary><Interswitch /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/interswitch/half-year" element={<RequireAccess page={['settlement','cards']} user={user}><PageErrorBoundary><InterswitchReport /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/interswitch/import"    element={<RequireAccess page={['settlement','cards']} user={user}><PageErrorBoundary><InterswitchImport /></PageErrorBoundary></RequireAccess>} />

                  <Route path="/approvals" element={<PageErrorBoundary><ApprovalsPage /></PageErrorBoundary>} />

                  {/* Sales & BD */}
                  <Route path="/bd"             element={<RequireAccess page="bd" user={user}><PageErrorBoundary><BDOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bd/leads"       element={<RequireAccess page="bd" user={user}><PageErrorBoundary><BDPipeline /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bd/pipeline"    element={<RequireAccess page="bd_pipeline" user={user}><PageErrorBoundary><BDPipeline /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bd/employers"    element={<RequireAccess page="bd_employers" user={user}><PageErrorBoundary><BDEmployers /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bd/assignments"  element={<RequireAccess page="bd" user={user}><PageErrorBoundary><BDAssignments /></PageErrorBoundary></RequireAccess>} />

                  <Route path="/campaigns"            element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignsList /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/templates"          element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignTemplates /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/templates/new"      element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignTemplateEditor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/templates/:id/edit" element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignTemplateEditor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/lists"      element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignLists /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/analytics"  element={<Navigate to="/marketing/analytics?tab=performance" replace />} />
                  <Route path="/campaigns/:id/edit"   element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignEditor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/:id/report" element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignReport /></PageErrorBoundary></RequireAccess>} />

                  <Route path="/sales"           element={<RequireAccess page="sales" user={user}><PageErrorBoundary><SalesOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/overview" element={<RequireAccess page="sales" user={user}><PageErrorBoundary><SalesOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/cohort"         element={<RequireAccess page="cohort" user={user}><PageErrorBoundary><SalesCohort /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/cohort/:month"  element={<RequireAccess page="cohort" user={user}><PageErrorBoundary><SalesCohortDetail /></PageErrorBoundary></RequireAccess>} />
                  {/* Reports retired — its content lives on Overview + Team (Live). */}
                  <Route path="/sales/reports"   element={<Navigate to="/sales/overview" replace />} />
                  <Route path="/sales/targets"   element={<RequireAccess page="sales" user={user}><PageErrorBoundary><SalesTargets /></PageErrorBoundary></RequireAccess>} />
                  {/* The account officer's book. /sales/accounts is kept as a redirect
                      so existing links and bookmarks do not break. */}
                  <Route path="/sales/book"          element={<RequireAccess page="crm_contacts" user={user}><PageErrorBoundary><SalesBook /></PageErrorBoundary></RequireAccess>} />
                  {/* Sales keeps its own customer view. Linking to /customers/:cif sent
                      the officer into the Contact Centre's ticket-first page and moved the
                      sidebar out of Sales on every row click. */}
                  <Route path="/sales/book/:cif"     element={<RequireAccess page="crm_contacts" user={user}><PageErrorBoundary><SalesBookCustomer /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/accounts"      element={<Navigate to="/sales/book" replace />} />
                  <Route path="/sales/leads"         element={<RequireAccess page="crm_contacts" user={user}><PageErrorBoundary><SalesLeads /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/customers"     element={<RequireAccess page="crm_contacts" user={user}><PageErrorBoundary><CRMContacts /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/customers/:id" element={<RequireAccess page="crm_contacts" user={user}><PageErrorBoundary><CRMContactDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/contacts/:id"        element={<RequireAccess page="crm_contacts" user={user}><PageErrorBoundary><ContactProfile /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/contact-segments"    element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><ContactSegments /></PageErrorBoundary></RequireAccess>} />

                  {/* Pipeline retired — the Leads funnel (crm_contacts) is the one source of truth. */}
                  <Route path="/sales/crm"           element={<Navigate to="/sales/leads" replace />} />
                  <Route path="/sales/tasks"         element={<RequireAccess page="crm_tasks" user={user}><PageErrorBoundary><CRMTasks /></PageErrorBoundary></RequireAccess>} />

                  <Route path="/sales/applications"     element={<RequireAccess page="loans" user={user}><PageErrorBoundary><LOSQueue /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/applications/new" element={<RequireAccess page="loans" user={user}><PageErrorBoundary><LOSNewApp /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/applications/:id" element={<RequireAccess page="loans" user={user}><PageErrorBoundary><LOSAppDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/loans/portfolio" element={<Navigate to="/operations/risk/portfolio" replace />} />

                  {/* Marketing */}
                  <Route path="/marketing/overview"    element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><MarketingOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/marketing/analytics"   element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><MarketingAnalytics /></PageErrorBoundary></RequireAccess>} />
                  {/* Retired standalone pages — now tabs on /marketing/analytics */}
                  <Route path="/marketing/attribution" element={<Navigate to="/marketing/analytics?tab=attribution" replace />} />
                  <Route path="/marketing/funnel"      element={<Navigate to="/marketing/analytics?tab=funnel" replace />} />

                  {/* Contact Centre */}
                  <Route path="/customers"      element={<RequireAccess page="customer360" user={user}><PageErrorBoundary><CustomerDirectory /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/customers/:cif" element={<RequireAccess page="customer360" user={user}><PageErrorBoundary><ContactProfile /></PageErrorBoundary></RequireAccess>} />
                  {/* Care-scoped aliases — same pages, so the sidebar highlights Care not Call Center */}
                  <Route path="/care/customers"      element={<RequireAccess page="customer360" user={user}><PageErrorBoundary><CustomerDirectory /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/care/customers/:cif" element={<RequireAccess page="customer360" user={user}><PageErrorBoundary><ContactProfile /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/care/knowledge-base" element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskKB /></PageErrorBoundary></RequireAccess>} />
                  {/* Call Center — outbound queue, leads, DNC, performance */}
                  <Route path="/call-center"                    element={<RequireAccess page="call_center" user={user}><PageErrorBoundary><CallCenterQueue /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/call-center/queue"              element={<RequireAccess page="call_center" user={user}><PageErrorBoundary><CallCenterQueue /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/call-center/leads"              element={<RequireAccess page="call_center" user={user}><PageErrorBoundary><CallCenterLeads /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/call-center/dnc"                element={<RequireAccess page="call_center" user={user}><PageErrorBoundary><CallCenterDNC /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/call-center/performance"        element={<RequireAccess page="call_center_stats" user={user}><PageErrorBoundary><CallCenterPerformance /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/call-center/voice-spike"        element={<RequireAccess page="call_center_stats" user={user}><PageErrorBoundary><CallCenterVoiceSpike /></PageErrorBoundary></RequireAccess>} />
                  {/* Agent Matching is a modal in the Supervisor view, not a standalone route. */}
                  {/* Inbound is agent-level work (returning missed calls), not a head-only view */}
                  <Route path="/call-center/inbound"            element={<RequireAccess page="call_center" user={user}><PageErrorBoundary><CallCenterInbound /></PageErrorBoundary></RequireAccess>} />
                  {/* Predictive-dialer pages retired — no in-app dialer (agents dial via carrier); redirect to the queue */}
                  <Route path="/call-center/dialer/*"           element={<Navigate to="/call-center" replace />} />
                  {/* Legacy /telemarketing/* links redirect to the Call Center paths */}
                  <Route path="/telemarketing"       element={<Navigate to="/call-center" replace />} />
                  <Route path="/telemarketing/queue" element={<Navigate to="/call-center/queue" replace />} />
                  <Route path="/telemarketing/leads" element={<Navigate to="/call-center/leads" replace />} />
                  <Route path="/telemarketing/dnc"   element={<Navigate to="/call-center/dnc" replace />} />
                  <Route path="/telemarketing/performance"        element={<Navigate to="/call-center/performance" replace />} />
                  <Route path="/telemarketing/dialer/*"           element={<Navigate to="/call-center" replace />} />

                  <Route path="/helpdesk"                element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/tickets"        element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskTickets /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/escalations"    element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskEscalations /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/new"            element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskNewTicket /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/care"                    element={<RequireAccess page="care" user={user}><PageErrorBoundary><CareHub /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/care/inbox"              element={<RequireAccess page="care" user={user}><PageErrorBoundary><CareInbox /></PageErrorBoundary></RequireAccess>} />
                  {/* Supervisor is now a tab in the Care hub — keep the old path working. */}
                  <Route path="/care/supervisor"         element={<Navigate to="/care?tab=supervisor" replace />} />
                  <Route path="/helpdesk/calls"          element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskCalls /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/supervisor"     element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskSupervisor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/stats"          element={<RequireAccess page="helpdesk_stats" user={user}><PageErrorBoundary><HelpdeskStats /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/knowledge-base" element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskKB /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/canned"         element={<RequireAccess page="helpdesk_canned" user={user}><PageErrorBoundary><HelpdeskCallScripts /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/care/canned"             element={<RequireAccess page="helpdesk_canned" user={user}><PageErrorBoundary><HelpdeskCanned /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/cbn-complaints" element={<RequireAccess page="cbn_reports" user={user}><PageErrorBoundary><HelpdeskCBNReport /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/:id"            element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskTicketDetail /></PageErrorBoundary></RequireAccess>} />

                  {/* Cards */}
                  <Route path="/cards"              element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardsOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/credit-portfolio" element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardCreditPortfolio /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/cycle-import" element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardCycleImport /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/at-risk" element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardAtRisk /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/trends"       element={<RequireAccess page="card_trends" user={user}><PageErrorBoundary><CardTrends /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/management"   element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardsMgmt /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/issuance"     element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardsIssuance /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/disputes"     element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardsDisputes /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/credit-limit" element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardsCreditLimit /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/billing"      element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardsBilling /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/blink-card"         element={<RequireAccess page="blink_card" user={user}><PageErrorBoundary><BlinkCard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/mobile-app"         element={<RequireAccess page="mobile_app" user={user}><PageErrorBoundary><MobileAppDashboard /></PageErrorBoundary></RequireAccess>} />

                  {/* Retired: Active Loan Book → Risk Portfolio; Credit Portfolio → Risk Portfolio */}
                  <Route path="/loans/active" element={<Navigate to="/operations/risk/portfolio" replace />} />

                  {/* Operations — Risk */}
                  <Route path="/operations/risk/my-dashboard"      element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk"                   element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/applications"      element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskAppReview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/applications/:id"  element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><LOSAppDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/portfolio"         element={<RequireAccess page={['credit_portfolio','active_loan_book']} user={user}><PageErrorBoundary><RiskPortfolio /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/vintage"           element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskVintage /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/vintage/:month"    element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskVintageDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/eye-scores"        element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskEyeScore /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/credit-file"       element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskCreditFile /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/operations/risk/sector-codes"      element={<RequireAccess page="credit_portfolio" user={user}><PageErrorBoundary><RiskSectorCodes /></PageErrorBoundary></RequireAccess>} />

                  {/* Collections */}
                  <Route path="/collections"                 element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/queue"           element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsQueue /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/promises"        element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsPromises /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/repayment-plans" element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsPlans /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/writeoffs"            element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsWriteoffs /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/portfolio"            element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsPortfolio /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/accounts/:cif"        element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsAccountDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/watchlist"            element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsWatchlist /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/writeoff-requests"    element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsWoRequests /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/recovery-approvals"   element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><CollectionsRecoveryPmts /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/collections/activity-log"         element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollectionsActivityLog /></PageErrorBoundary></RequireAccess>} />

                  {/* Recovery */}
                  <Route path="/recovery"                element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><RecoveryOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/recovery/cases"          element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><RecoveryCases /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/recovery/cases/:id"      element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><RecoveryCaseDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/recovery/legal"          element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><RecoveryLegal /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/recovery/activity-log"   element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><RecoveryActivityLog /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/recovery/debt-sales"     element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><RecoveryDebtSale /></PageErrorBoundary></RequireAccess>} />

                  {/* Collections Ops */}
                  <Route path="/collections-ops/agent" element={<RequireAccess page="collections" user={user}><PageErrorBoundary><CollOpsAgentDash /></PageErrorBoundary></RequireAccess>} />

                  {/* Agent dashboards */}
                  <Route path="/recovery-ops/agent"     element={<RequireAccess page="recovery" user={user}><PageErrorBoundary><RecoveryAgentDash /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/my-dashboard"     element={<RequireAccess page="sales" user={user}><PageErrorBoundary><SalesMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/sales/supervisor"       element={<RequireAccess page="sales" user={user}><PageErrorBoundary><SalesSupervisor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/helpdesk/my-dashboard"  element={<RequireAccess page="helpdesk" user={user}><PageErrorBoundary><HelpdeskMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bd/my-dashboard"        element={<RequireAccess page="bd" user={user}><PageErrorBoundary><BDMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/cards/my-queue"         element={<RequireAccess page="cards" user={user}><PageErrorBoundary><CardsMyQueue /></PageErrorBoundary></RequireAccess>} />

                  {/* Settlements */}
                  <Route path="/settlements/my-dashboard"             element={<RequireAccess page="settlement" user={user}><PageErrorBoundary><SettleMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements"                          element={<RequireAccess page="settlement" user={user}><PageErrorBoundary><SettleOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/batches"                  element={<RequireAccess page="settlement" user={user}><PageErrorBoundary><SettleBatches /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/nip"                      element={<RequireAccess page="settlement" user={user}><PageErrorBoundary><SettleNIP /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/nip-recon"                element={<RequireAccess page="reconciliation" user={user}><PageErrorBoundary><SettleNIPRecon /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/reconciliation"           element={<RequireAccess page="reconciliation" user={user}><PageErrorBoundary><SettleRecon /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/failed"                   element={<RequireAccess page="settlement" user={user}><PageErrorBoundary><SettleFailed /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/manual-postings"          element={<RequireAccess page="settlement" user={user}><PageErrorBoundary><SettleManualPost /></PageErrorBoundary></RequireAccess>} />
                  {/* Rebuilt module: operations (workbench, exceptions) + reporting (position) */}
                  <Route path="/settlements/workbench"                element={<RequireAccess page={['settlement','reconciliation']} user={user}><PageErrorBoundary><SettleWorkbench /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/exceptions"               element={<RequireAccess page={['settlement','reconciliation']} user={user}><PageErrorBoundary><SettleExceptions /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/position"                 element={<RequireAccess page={['settlement','reconciliation']} user={user}><PageErrorBoundary><SettlePosition /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/settlements/runs"                     element={<RequireAccess page={['settlement','reconciliation']} user={user}><PageErrorBoundary><SettleRuns /></PageErrorBoundary></RequireAccess>} />

                  {/* Finance */}
                  <Route path="/finance/my-dashboard"       element={<RequireAccess page={['income','finance']} user={user}><PageErrorBoundary><FinanceMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/finance"                    element={<RequireAccess page="income" user={user}><PageErrorBoundary><FinanceOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/finance/transactions"       element={<RequireAccess page="transactions" user={user}><PageErrorBoundary><FinanceTxns /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/finance/income"             element={<RequireAccess page="income" user={user}><PageErrorBoundary><FinanceIncome /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/deposits"                   element={<RequireAccess page="fixed_deposit" user={user}><PageErrorBoundary><FinanceFixedDeposits /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/finance/eod"                element={<RequireAccess page="eod" user={user}><PageErrorBoundary><FinanceEOD /></PageErrorBoundary></RequireAccess>} />
                  {/* Retired standalone FD pages — now tabs on /deposits */}
                  <Route path="/finance/fixed-deposit"      element={<Navigate to="/deposits?tab=register" replace />} />
                  <Route path="/finance/fd-maturity"        element={<Navigate to="/deposits?tab=maturity" replace />} />
                  <Route path="/finance/fd-accrual"         element={<Navigate to="/deposits?tab=accrual" replace />} />
                  <Route path="/finance/fx-rates"           element={<RequireAccess page="fx_rates" user={user}><PageErrorBoundary><FinanceFXRates /></PageErrorBoundary></RequireAccess>} />

                  {/* Compliance */}
                  <Route path="/compliance/my-dashboard" element={<RequireAccess page={['watch_list','audit_findings','compliance_checklists','compliance_all']} user={user}><PageErrorBoundary><ComplianceMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance"             element={<RequireAccess page="watch_list" user={user}><Navigate to="/compliance/watchlist" replace /></RequireAccess>} />
                  <Route path="/compliance/watchlist"   element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceWatchlist /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/regulatory"  element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceRegCalendar /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/findings"    element={<RequireAccess page="audit_findings" user={user}><PageErrorBoundary><ComplianceFindings /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/checklists"  element={<RequireAccess page="compliance_checklists" user={user}><PageErrorBoundary><ComplianceChecklists /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/audit-trail"        element={<RequireAccess page="audit_trail" user={user}><PageErrorBoundary><ComplianceAuditTrail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/credit-audit-trail" element={<RequireAccess page="audit_trail" user={user}><PageErrorBoundary><CreditAuditTrail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/kyc-expiry"   element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceKYCExpiry /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/aml-rules"    element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceAMLRules /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/prudential"      element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><CompliancePrudential /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/dsar"            element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceDSAR /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/concentration"   element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceConcentration /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/dpa-register"   element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceDPARegister /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/soc2"           element={<RequireAccess page="audit_trail" user={user}><PageErrorBoundary><ComplianceSOC2 /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/soc2/:id"       element={<RequireAccess page="audit_trail" user={user}><PageErrorBoundary><ComplianceSOC2Detail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/pentest"        element={<RequireAccess page="audit_trail" user={user}><PageErrorBoundary><CompliancePentest /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/policies"       element={<RequireAccess page="compliance_checklists" user={user}><PageErrorBoundary><CompliancePolicies /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/credit-bureau"   element={<RequireAccess page="watch_list" user={user}><PageErrorBoundary><ComplianceCreditBureau /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/breach-incidents" element={<RequireAccess page="compliance_all" user={user}><PageErrorBoundary><ComplianceBreach /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/compliance/board-pack"      element={<RequireAccess page="compliance_all" user={user}><PageErrorBoundary><ComplianceBoardPack /></PageErrorBoundary></RequireAccess>} />

                  {/* People */}

                  <Route path="/payroll"                          element={<RequireAccess page="payroll" user={user}><PageErrorBoundary><PayrollOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/payroll/runs/:id"                 element={<RequireAccess page="payroll" user={user}><PageErrorBoundary><PayrollRunDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/payroll/runs/:runId/items/:itemId" element={<RequireAccess page="payroll" user={user}><PageErrorBoundary><PayslipView /></PageErrorBoundary></RequireAccess>} />

                  {/* Intelligence */}
                  <Route path="/reports/my-dashboard" element={<RequireAccess page="reports" user={user}><PageErrorBoundary><ReportsMyDashboard /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/reports"        element={<RequireAccess page="reports" user={user}><PageErrorBoundary><ReportsLibrary /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/reports/kpi"    element={<RequireAccess page="kpi_dashboard" user={user}><PageErrorBoundary><ReportsKPI /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/reports/export" element={<RequireAccess page="reports" user={user}><PageErrorBoundary><ReportsExport /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bi"             element={<RequireAccess page="reports" user={user}><PageErrorBoundary><BIOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bi/builder"     element={<RequireAccess page="reports" user={user}><PageErrorBoundary><BIBuilder /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bi/builder/:id" element={<RequireAccess page="reports" user={user}><PageErrorBoundary><BIBuilder /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/bi/scheduled"   element={<RequireAccess page="reports" user={user}><PageErrorBoundary><BIScheduled /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/core-banking"               element={<RequireAccess page="core-banking" user={user}><PageErrorBoundary><CoreBanking /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/statements/credit-cards"    element={<RequireAccess page="statements" user={user}><PageErrorBoundary><CCStatements /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/statements/credit-cards/new" element={<RequireAccess page="statements" user={user}><PageErrorBoundary><CCStatementNew /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/statements/credit-cards/:id" element={<RequireAccess page="statements" user={user}><PageErrorBoundary><CCStatementDetail /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/statements"     element={<RequireAccess page="statements" user={user}><PageErrorBoundary><Statements /></PageErrorBoundary></RequireAccess>} />

                  {/* Admin */}
                  <Route path="/admin/modules"               element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminModules /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin"                       element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/overview"              element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/users"                 element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminUsers /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/roles"                 element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminRoles /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/email-senders"         element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminEmailSenders /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/mail"                  element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminMailHealth /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/api-keys"              element={<RequireAccess page="admin_api_keys" user={user}><PageErrorBoundary><AdminApiKeys /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/settings"              element={<RequireAccess page="settings" user={user}><PageErrorBoundary><AdminSettings /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/notification-settings" element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminNotificationSettings /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/integrations"          element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminIntegrations /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/audit"                 element={<RequireAccess page="sync_status" user={user}><PageErrorBoundary><AdminAuditLog /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/sync"                  element={<RequireAccess page="sync_status" user={user}><PageErrorBoundary><AdminSyncStatus /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/helpdesk-settings"     element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminHelpdeskSettings /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/admin/workflow-templates"    element={<RequireAccess page="admin_users" user={user}><PageErrorBoundary><AdminWorkflowTemplates /></PageErrorBoundary></RequireAccess>} />

                  {/* Mail */}
                  <Route path="/mail"         element={<RequireAccess page="mail" user={user}><PageErrorBoundary><MailOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/mail/overview" element={<RequireAccess page="mail" user={user}><PageErrorBoundary><MailOverview /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/mail/inbox"   element={<RequireAccess page="mail" user={user}><PageErrorBoundary><MailInbox /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/mail/sent"    element={<RequireAccess page="mail" user={user}><PageErrorBoundary><MailInbox /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/mail/drafts"  element={<RequireAccess page="mail" user={user}><PageErrorBoundary><MailInbox /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/mail/compose" element={<RequireAccess page="mail" user={user}><PageErrorBoundary><MailCompose /></PageErrorBoundary></RequireAccess>} />
                  {/* Signature moved to Settings → Email Signature. Kept as a redirect
                      because it was a sidebar entry, so it will be in bookmarks. */}
                  <Route path="/mail/signature" element={<Navigate to="/settings?tab=signature" replace />} />
                  <Route path="/mail/:id"     element={<RequireAccess page="mail" user={user}><PageErrorBoundary><MailThread /></PageErrorBoundary></RequireAccess>} />

                  <Route path="/settings" element={<PageErrorBoundary><UserSettings /></PageErrorBoundary>} />

                  <Route path="*" element={<Navigate to={homeFor(role)} replace />} />
                </Routes>
              </PageFade>
            </Suspense>
          </main>
        </div>

        {/* Task modal — driven by ?task=<id>, so a task opens over whatever page the
            user is already on rather than sending them to a task list. Mounted here
            once so notification deep links work from anywhere in the app. */}
        <Suspense fallback={null}><TaskModal /></Suspense>

        {/* Call Scripts launcher — global, self-gates to Call Centre staff so an agent
            can pull up a talk-track from any screen while on a live call. */}
        <Suspense fallback={null}><ScriptsDrawer /></Suspense>

        {/* C360 drawer */}
        <C360Drawer open={c360Open} onClose={() => { setC360Open(false); setC360Customer(null) }} initialCustomer={c360Customer} />

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
     </RealtimeProvider>
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
    if (pw.length < 12) { setErr('Password must be at least 12 characters'); return }
    try {
      await apiFetch('/api/auth/force-change-password', { method: 'POST', body: JSON.stringify({ new_password: pw }) } as RequestInit)
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
          <p style={{ color: 'var(--nav-dot)', fontWeight: 600 }}>Password updated. Logging you in…</p>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input type="password" placeholder="New password (min. 12 characters)" value={pw} onChange={e => setPw(e.target.value)}
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
        role: (import.meta.env.VITE_DEV_ROLE ?? 'md') as AuthUser['role'], pages: [], must_change_password: false,
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

  // Keep the session warm. The access token lives 30 minutes; without this the first
  // action after that window costs a failed request, a refresh and a retry, and any
  // pre-existing bug in that recovery path surfaces as a surprise logout. Refreshing
  // on a timer and whenever the tab regains focus means the token is almost always
  // valid before it is used.
  useEffect(() => {
    if (!user) return
    const REFRESH_EVERY = 20 * 60 * 1000 // comfortably inside the 30-minute token life
    const tick = () => { if (document.visibilityState === 'visible') refreshSession() }
    const id = window.setInterval(tick, REFRESH_EVERY)
    // Returning to a tab left open overnight: refresh before the user clicks anything.
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSession() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [user])

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


  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: CANVAS }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', border: '2.5px solid rgba(14,40,65,0.12)', borderTopColor: RED, animation: 'spin 0.7s linear infinite' }} />
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
    const LIGHT_LOCAL = { '--bg': CANVAS, '--card': '#FFFFFF', '--txt': '#0F1623', '--txt2': '#798094', '--input-bg': '#F2F4F9', '--input-bdr': '#DDE0EA', '--nav-dot': RED, '--card-shadow': '0 1px 2px rgba(0,0,0,0.04), 0 4px 18px rgba(0,0,0,0.05)' } as React.CSSProperties
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
