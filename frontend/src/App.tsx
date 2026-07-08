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
import CallWidget       from './components/CallWidget'
import C360Drawer       from './components/C360Drawer'
import { type AuthUser, ROLE_PAGES } from './hooks/useAuth'
import { roleLabel, MGMT } from './lib/roles'
import { API, apiFetch, apiPost, apiLogout, refreshSession } from './lib/api'
import { LIGHT, DARK, GREEN, BLUE, NAVY, PLEX, MONO, RED, CANVAS }  from './lib/design'
import { IcoSearch, IcoApprove, IcoSun, IcoMoon } from './lib/icons'
import { fmtKobo } from './lib/fmt'
import { ConfirmModal } from './components/UI'

// ── Lazy imports ──────────────────────────────────────────────────────────────
const CS           = lazy(() => import('./pages/ComingSoon'))
const CSATSurvey   = lazy(() => import('./pages/helpdesk/CSATSurvey'))
const UserSettings = lazy(() => import('./pages/Settings'))

// Intelligence
const ReportsBI       = lazy(() => import('./pages/reports/BI'))
const ReportsKPI      = lazy(() => import('./pages/reports/KPITracker'))
const ReportsExport   = lazy(() => import('./pages/reports/Export'))
const BIOverview      = lazy(() => import('./pages/bi/BIOverview'))
const BIBuilder       = lazy(() => import('./pages/bi/ReportBuilder'))
const BIScheduled     = lazy(() => import('./pages/bi/ScheduledReports'))
const Statements    = lazy(() => import('./pages/statements/Statements'))
const Login    = lazy(() => import('./pages/Login'))
const Overview = lazy(() => import('./pages/Overview'))
// C360Drawer imported directly (not lazy) so slide animation works on first open

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
const CampaignEditor         = lazy(() => import('./pages/campaigns/Editor'))

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
const ContactProfile   = lazy(() => import('./pages/contacts/ContactProfile'))
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
const HelpdeskNewTicket   = lazy(() => import('./pages/helpdesk/NewTicket'))
const HelpdeskCBNReport   = lazy(() => import('./pages/helpdesk/CBNReport'))

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

// ── Module title + breadcrumb map ────────────────────────────────────────────

const MODULE_TITLES: [string, string, string][] = [
  ['/approvals',       'Workspace',         'Approvals'],
  ['/bd',              'Sales & BD',        'Business Dev'],
  ['/mail',            'Sales & BD',        'Mail'],
  ['/campaigns',       'Sales & BD',        'Campaigns & Marketing'],
  ['/marketing',       'Sales & BD',        'Marketing'],
  ['/sales/crm',       'Sales & BD',        'CRM'],
  ['/sales/customers', 'Sales & BD',        'Contacts'],
  ['/sales',           'Sales & BD',        'Sales'],
  ['/telemarketing',   'Contact Centre',    'Telemarketing'],
  ['/helpdesk',        'Contact Centre',    'Customer Service'],
  ['/cards',           'Cards',             'Card Operations'],
  ['/operations/risk', 'Credit Management', 'Risk'],
  ['/collections',     'Credit Management', 'Collections'],
  ['/recovery',        'Credit Management', 'Recovery'],
  ['/finance',         'Finance',           'Finance'],
  ['/settlements',     'Finance',           'Settlements'],
  ['/compliance',      'Compliance',        'Compliance'],
  ['/hr',              'People',            'HR'],
  ['/payroll',         'People',            'Payroll'],
  ['/reports',         'Analytics',         'Reports & BI'],
  ['/bi',              'Analytics',         'Reports & BI'],
  ['/statements',      'Analytics',         'Statements'],
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


// Wraps the modal-shaped NewTicket form for standalone page routing
function NewTicketPage() {
  const nav = useNavigate()
  return <HelpdeskNewTicket onClose={() => nav(-1)} onCreated={id => nav(`/helpdesk/${id}`)} />
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
    apiFetch<ApprovalItem[]>('/api/approvals/pending', { silent: true })
      .then(d => { const list = Array.isArray(d) ? d : []; setItems(list); setCount(list.length) })
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
        <IcoApprove width={16} height={16} />
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
              View all approvals →
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
        <textarea
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
      {dark ? <IcoSun width={16} height={16} /> : <IcoMoon width={16} height={16} />}
    </TbBtn>
  )
}

// ── C360 inline search bar ────────────────────────────────────────────────────

interface C360Hit { cif: string; name: string; phone: string; email: string }

function C360Bar({ onPick }: { onPick: (r: C360Hit) => void }) {
  const [q,       setQ]       = useState('')
  const [results, setResults] = useState<C360Hit[]>([])
  const [focused, setFocused] = useState(false)
  const [show,    setShow]    = useState(false)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const debounce  = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShow(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function search(val: string) {
    setQ(val)
    if (debounce.current) clearTimeout(debounce.current)
    if (val.trim().length < 2) { setResults([]); setShow(false); return }
    debounce.current = setTimeout(async () => {
      try {
        const data = await apiFetch<{ data: C360Hit[] }>(`/api/customer360/search?q=${encodeURIComponent(val.trim())}&limit=6`)
        const hits: C360Hit[] = (data?.data ?? []).map((r: any) => ({
          cif: r.cif, name: r.name ?? r.full_name, phone: r.phone, email: r.email ?? '',
        }))
        setResults(hits)
        setShow(true)
      } catch {
        setResults([]); setShow(false)
      }
    }, 250)
  }

  function pick(r: C360Hit) {
    setQ(''); setShow(false); setResults([])
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
      <IcoSearch width={14} height={14} style={{ flexShrink: 0 }} />
      <input
        className="srch-input"
        value={q}
        onChange={e => search(e.target.value)}
        onFocus={() => { setFocused(true); if (results.length > 0) setShow(true) }}
        onBlur={() => setFocused(false)}
        onKeyDown={e => { if (e.key === 'Escape') { setShow(false); setQ('') } }}
        placeholder="Customer 360 — search name or CIF…"
        style={{
          border: 'none', outline: 'none', background: 'none', flex: 1,
          fontFamily: "'Sora', sans-serif", fontSize: 12.5, color: 'var(--txt)',
          minWidth: 0,
        }}
      />

      {show && q.trim().length >= 2 && (
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
              <strong>{r.name}</strong>
              <span style={{ fontSize: 11, color: 'var(--txt3)' }}>{r.phone}</span>
              <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11, color: 'var(--txt3)' }}>{r.cif}</span>
            </div>
          )) : (
            <div style={{ padding: '9px 13px', color: 'var(--txt3)', fontSize: 12.5, cursor: 'default' }}>
              No customers match &ldquo;{q}&rdquo;
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
        <Sidebar user={user} onLogout={onLogout} onCmdK={() => setSearchOpen(true)} />

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
                  <Route path="/campaigns/:id/edit"   element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignEditor /></PageErrorBoundary></RequireAccess>} />
                  <Route path="/campaigns/:id/report" element={<RequireAccess page="campaigns" user={user}><PageErrorBoundary><CampaignReport /></PageErrorBoundary></RequireAccess>} />

                  <Route path="/sales"           element={<PageErrorBoundary><SalesOverview /></PageErrorBoundary>} />
                  <Route path="/sales/cohort"    element={<PageErrorBoundary><SalesCohort /></PageErrorBoundary>} />
                  <Route path="/sales/reports"   element={<PageErrorBoundary><SalesReports /></PageErrorBoundary>} />
                  <Route path="/sales/targets"   element={<PageErrorBoundary><SalesTargets /></PageErrorBoundary>} />
                  <Route path="/sales/customers"     element={<PageErrorBoundary><CRMContacts /></PageErrorBoundary>} />
                  <Route path="/sales/customers/:id" element={<PageErrorBoundary><CRMContactDetail /></PageErrorBoundary>} />
                  <Route path="/contacts/:id"        element={<PageErrorBoundary><ContactProfile /></PageErrorBoundary>} />
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
                  <Route path="/helpdesk/cbn-report"     element={<PageErrorBoundary><HelpdeskCBNReport /></PageErrorBoundary>} />
                  <Route path="/helpdesk/new"            element={<PageErrorBoundary><NewTicketPage /></PageErrorBoundary>} />
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
                  <Route path="/compliance/kyc-expiry"   element={<PageErrorBoundary><ComplianceKYCExpiry /></PageErrorBoundary>} />
                  <Route path="/compliance/aml-rules"    element={<PageErrorBoundary><ComplianceAMLRules /></PageErrorBoundary>} />
                  <Route path="/compliance/prudential"      element={<PageErrorBoundary><CompliancePrudential /></PageErrorBoundary>} />
                  <Route path="/compliance/dsar"            element={<PageErrorBoundary><ComplianceDSAR /></PageErrorBoundary>} />
                  <Route path="/compliance/concentration"   element={<PageErrorBoundary><ComplianceConcentration /></PageErrorBoundary>} />
                  <Route path="/compliance/dpa-register"   element={<PageErrorBoundary><ComplianceDPARegister /></PageErrorBoundary>} />
                  <Route path="/compliance/soc2"           element={<PageErrorBoundary><ComplianceSOC2 /></PageErrorBoundary>} />
                  <Route path="/compliance/soc2/:id"       element={<PageErrorBoundary><ComplianceSOC2Detail /></PageErrorBoundary>} />
                  <Route path="/compliance/pentest"        element={<PageErrorBoundary><CompliancePentest /></PageErrorBoundary>} />
                  <Route path="/compliance/policies"       element={<PageErrorBoundary><CompliancePolicies /></PageErrorBoundary>} />

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
                  <Route path="/bi"             element={<PageErrorBoundary><BIOverview /></PageErrorBoundary>} />
                  <Route path="/bi/builder"     element={<PageErrorBoundary><BIBuilder /></PageErrorBoundary>} />
                  <Route path="/bi/builder/:id" element={<PageErrorBoundary><BIBuilder /></PageErrorBoundary>} />
                  <Route path="/bi/scheduled"   element={<PageErrorBoundary><BIScheduled /></PageErrorBoundary>} />
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
                  <Route path="/mail/sent"    element={<PageErrorBoundary><MailInbox /></PageErrorBoundary>} />
                  <Route path="/mail/drafts"  element={<PageErrorBoundary><MailInbox /></PageErrorBoundary>} />
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
        <C360Drawer open={c360Open} onClose={() => { setC360Open(false); setC360Customer(null) }} initialCustomer={c360Customer} />

        {/* Global search (Cmd+K) */}
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

        {/* Persistent call widget — dial + inbound ringing */}
        <CallWidget user={user} />

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

  if (typeof window !== 'undefined' && window.location.pathname === '/workspace') {
    const O3CWorkspace = lazy(() => import('./pages/O3CWorkspace'))
    return (
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes><Route path="/workspace" element={<O3CWorkspace />} /></Routes>
        </Suspense>
      </BrowserRouter>
    )
  }

  if (typeof window !== 'undefined' && window.location.pathname === '/demo') {
    const WorkspaceDemo = lazy(() => import('./pages/WorkspaceDemo'))
    return (
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes><Route path="/demo" element={<WorkspaceDemo />} /></Routes>
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
