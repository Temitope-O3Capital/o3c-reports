import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Spinner, DateFilter } from '../components/UI'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../lib/fmt'
import { RED, DARKRED, AMBER, BLUE, GREEN, PURPLE, NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../lib/design'
import { CHART_SERIES } from '../components/charts'
import { EChart, EArea, EDonut, EBar, baseTooltip, tipCard, type ChartTokens } from '../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KPIs {
  portfolio_outstanding_kobo: number
  fd_book_kobo: number
  active_cards: number
  performing_rate_pct: number
  npl_rate_pct: number
  disbursements_kobo: number
  revenue_kobo: number
  revenue_cards_kobo: number
  revenue_loans_kobo: number
  revenue_loans_forward_kobo: number
  revenue_fd_cost_kobo: number
  active_customers: number
  active_loans: number
  portfolio_change_pct: number | null
  fd_change_pct: number | null
  performing_change_pct: number | null
  disbursements_change_pct: number | null
  revenue_change_pct: number | null
  customers_change_pct: number | null
  portfolio_series: number[]
  fd_series: number[]
  performing_series: number[]
  disbursements_series: number[]
  revenue_series: number[]
  customers_series: number[]
}
interface SettlementsSummary {
  settled_period_kobo: number
  payouts_kobo: number
  open_exceptions: number
}
// Collections dept panel reads the executive collections drilldown — the real
// collections book (app.collection_assignments) + collected flow, not the loan-book
// health rates the Risk panel already carries.
interface CollectionsSummary {
  assigned_kobo: number
  assigned_count: number
  collected_mtd_kobo: number
  card_overdue_kobo: number
}
// Headline figures for the Recovery department panel — the full shape lives on the
// /executive/recovery drilldown.
interface RecoverySummary {
  open_cases: number
  open_outstanding_kobo: number
  recovered_period_kobo: number
  recovery_rate_pct: number
}
interface FDSummary {
  total_fd_book_kobo: number
  active_fd_count: number
  maturing_30d: number
  new_this_month: number
}
interface ContactCenterSummary {
  open_tickets: number
  in_queue: number
  avg_first_response_mins: number
  sla_compliance_pct: number
  resolved_today: number
  resolved_period: number
  escalations_open: number
}
interface CardsSummary {
  disputes_open: number
  active_total: number
  card_spend_period_kobo: number
  green_count: number;    green_outstanding_kobo: number
  gold_count: number;     gold_outstanding_kobo: number
  platinum_count: number; platinum_outstanding_kobo: number
  prepaid_ngn_count: number;   prepaid_ngn_balance_kobo: number
  prepaid_usd_count: number;   prepaid_usd_balance_cents: number
  credit_ngn_count: number;    credit_ngn_balance_kobo: number
}
interface MonthlyPoint { month: string; disbursements_kobo: number; fd_payouts_kobo: number; card_spend_kobo: number }
interface ProductPoint  { product: string; count: number; volume_kobo: number }
interface DPDPoint      { month: string; par30: number; par60: number; par90: number }
interface TopPerformer  {
  name: string; role: string; dept: string
  amount_kobo: number; total_kobo: number
  loans_kobo: number; loans_count: number
  fd_kobo: number; fd_count: number
  cards_count: number; count: number
}
interface LOSStages {
  draft: number; submitted: number; document_collection: number
  risk_review: number; risk_head_review: number; pending_conditions: number
  finance_approval: number; booking: number; active_count: number
}
interface CCStages {
  application: number; doc_review: number; credit_check: number
  risk_review: number; approved: number; issuance: number; active: number
}

interface AcquisitionFunnel {
  leads: number
  applications: number
  approved: number
  disbursed: number
}

// Customer growth & activity — sourced from the live feed (registrations from
// app.accounts.opened_date, transactions + churn from app.transactions). Numeric
// fields arrive as JSON strings (pg bigint/numeric), so coerce with Number().
interface GrowthSummary {
  registrations: { this_month: number; last_month: number; ytd: number; total: number }
  transactions: {
    count_this: number; count_last: number
    spend_kobo_this: number; spend_kobo_last: number; active_this: number; active_last: number
  }
  activity: { total: number; active: number; lapsing: number; dormant: number; never_active: number }
  trend?: GrowthTrend[]
}
interface GrowthTrend { month: string; new_accounts: number; active_customers: number }

// ── Date helpers (ISO YYYY-MM-DD) ────────────────────────────────────────────
function isoDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
function monthStartIso(): string {
  const n = new Date()
  return isoDate(new Date(n.getFullYear(), n.getMonth(), 1))
}

// ── Stage configs (CC uses same navy/grey ramp as LOS) ───────────────────────

const LOS_STAGES: { key: keyof LOSStages; label: string; color: string }[] = [
  { key: 'draft',               label: 'Draft',      color: '#C5CDD8' },
  { key: 'submitted',           label: 'Submitted',  color: '#9BAFC4' },
  { key: 'document_collection', label: 'Doc Coll.',  color: '#6D8FAF' },
  { key: 'risk_review',         label: 'Risk Rev.',  color: '#3E6F9A' },
  { key: 'risk_head_review',    label: 'Risk Head',  color: '#1E5285' },
  { key: 'pending_conditions',  label: 'Conditions', color: '#0D3A66' },
  { key: 'finance_approval',    label: 'Finance',    color: '#0A2847' },
  { key: 'booking',             label: 'Booking',    color: '#041D38' },
  { key: 'active_count',        label: 'Active',     color: GREEN     },
]

// 'active' is the total card stock, not a pipeline flow — kept separate from the bar
const CC_STAGES: { key: keyof CCStages; label: string; color: string }[] = [
  { key: 'application',  label: 'Application',  color: '#C5CDD8' },
  { key: 'doc_review',   label: 'Doc Review',   color: '#9BAFC4' },
  { key: 'credit_check', label: 'Credit Check', color: '#6D8FAF' },
  { key: 'risk_review',  label: 'Risk Review',  color: '#3E6F9A' },
  { key: 'approved',     label: 'Approved',     color: '#1E5285' },
  { key: 'issuance',     label: 'Issuance',     color: '#041D38' },
]

// ── Palette ───────────────────────────────────────────────────────────────────

const DONUT_COLORS = CHART_SERIES
const PERF_COLORS  = [RED, NAVY, AMBER, GREEN, PURPLE, BLUE]

// Money-scale formatter shared by the payouts chart's endpoint labels — mirrors the
// ₦m / ₦k scale the removed Y-axis used.
const moneyTick = (v: number) => {
  if (v === 0) return ''
  if (v >= 1_000_000_00) return `₦${(v / 1_000_000_00).toFixed(0)}m`
  if (v >= 1_000_00)     return `₦${(v / 1_000_00).toFixed(0)}k`
  return ''
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-NG')}`
}

// Card ledger balances (card_cycle_data) are net figures: cardholders carrying credit
// or prepaid float make a tier's "outstanding" go negative, and a tier with cards but
// no synced cycle rows reads as 0. A bare "-₦343m outstanding" / "₦0 outstanding" on
// an exec card visual reads as a bug, so present the sign honestly instead:
//   negative → a credit/float balance   ·   zero-with-cards → balance not synced yet.
function bookAmount(kobo: number, hasCards: boolean): { text: string; label: string } {
  if (kobo < 0)              return { text: fmtKobo(-kobo), label: 'in credit' }
  if (kobo === 0 && hasCards) return { text: '—',           label: 'balance not synced' }
  return { text: fmtKobo(kobo), label: 'outstanding' }
}

function fmtRelTime(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 60)   return 'just now'
  if (diff < 120)  return '1 min ago'
  if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`
  return date.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Spark({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null
  const W = 80, H = 28, pd = 2
  const max = Math.max(...data), min = Math.min(...data), rng = max - min || 1
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - pd - ((v - min) / rng) * (H - pd * 2)}`).join(' ')
  const gid = `sg${color.replace('#', '')}`
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0}    />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── ATM card visual ───────────────────────────────────────────────────────────

function ATMCard({ tier, gradient, count, outstanding, lastFour, currency = 'NGN', countLabel = 'cardholders' }: {
  tier: string; gradient: string; count: number; outstanding: number; lastFour: string
  currency?: 'NGN' | 'USD'; countLabel?: string
}) {
  return (
    <div style={{
      borderRadius: RADIUS['2xl'], background: gradient, position: 'relative',
      padding: '22px 26px', overflow: 'hidden', flex: 1,
      boxShadow: '0 8px 28px rgba(0,0,0,0.28)', minHeight: 200,
    }}>
      <div style={{ position: 'absolute', top: -32, right: -32, width: 120, height: 120, borderRadius: '50%', background: 'rgba(255,255,255,0.07)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: -20, right: 16, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', pointerEvents: 'none' }} />
      {/* Chip + contactless */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div style={{ width: 36, height: 27, borderRadius: 5, background: 'linear-gradient(135deg,rgba(255,213,0,0.95),rgba(190,150,0,0.8))', display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 1.5, padding: SP[1] }}>
          {[0,1,2,3].map(i => <div key={i} style={{ background: 'rgba(180,130,0,0.4)', borderRadius: 1 }} />)}
        </div>
        <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {[8, 11, 15].map(s => <div key={s} style={{ width: s, height: s, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.5)', background: 'none' }} />)}
        </div>
      </div>
      {/* Card number */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginBottom: 18 }}>
        {['●●●●','●●●●','●●●●'].map((g, i) => <span key={i} style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,0.35)', letterSpacing: 2, fontFamily: INTER }}>{g}</span>)}
        <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'rgba(255,255,255,0.8)', fontFamily: INTER, ...NUM, letterSpacing: 2 }}>{lastFour}</span>
      </div>
      {/* Tier + metrics */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'rgba(255,255,255,0.5)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 4 }}>{tier}</div>
          {(() => {
            const b = currency === 'USD'
              ? { text: fmtUsd(outstanding), label: 'balance' }
              : bookAmount(outstanding, count > 0)
            return <>
            <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: '#fff', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.5 }}>{b.text}</div>
            <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,0.45)', fontFamily: INTER, marginTop: 3 }}>{b.label}</div>
          </> })()}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...NUM, fontSize: 26, fontWeight: FW.extrabold, color: '#fff', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(count)}</div>
          <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,0.45)', fontFamily: INTER, marginTop: 3 }}>{countLabel}</div>
        </div>
      </div>
    </div>
  )
}

// ── Pipeline segment bar (no card wrapper) ────────────────────────────────────

function PipelineSegments<K extends string>({
  stages, data, label, activeBadge,
}: {
  stages: { key: K; label: string; color: string }[]
  data: Record<K, number>
  label: string
  activeBadge?: { count: number; color: string; label: string }
}) {
  const total = stages.reduce((s, st) => s + (data[st.key] ?? 0), 0) || 1
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>{label}</span>
          {activeBadge && (
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: INTER, ...NUM, padding: '2px 9px', borderRadius: 99, background: `${activeBadge.color}18`, color: activeBadge.color, border: `1px solid ${activeBadge.color}30` }}>
              {fmtNum(activeBadge.count)} {activeBadge.label}
            </span>
          )}
        </div>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, ...NUM }}>{fmtNum(total)} in pipeline</span>
      </div>
      <div style={{ display: 'flex', borderRadius: RADIUS.md, overflow: 'hidden', height: 50 }}>
        {stages.map(st => {
          const count = data[st.key] ?? 0
          if (count === 0) return null
          return (
            <div key={st.key} title={`${st.label}: ${count}`} style={{
              flex: count, background: st.color,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              padding: '0 6px', minWidth: 30, overflow: 'hidden',
            }}>
              <div style={{ fontSize: 15, fontWeight: FW.extrabold, color: '#fff', fontFamily: INTER, ...NUM, lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>{count}</div>
              <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.65)', fontFamily: INTER, marginTop: 3, textTransform: 'uppercase', letterSpacing: 0.3, textAlign: 'center', lineHeight: 1.2 }}>{st.label}</div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10 }}>
        {stages.map(st => {
          const count = data[st.key] ?? 0
          return (
            <div key={st.key} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', border: '1px solid var(--bdr)' }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: st.color, flexShrink: 0 }} />
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: SORA }}>{st.label}</span>
              <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: count > 0 ? 'var(--txt)' : 'var(--txt3)', fontFamily: INTER }}>{count}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── DPD Legend (rendered in SectionCard actions — top right) ──────────────────

const DPD_LEGEND = (
  <div style={{ display: 'flex', gap: SP[3] }}>
    {([{ c: AMBER, l: 'PAR30' }, { c: RED, l: 'PAR60' }, { c: PURPLE, l: 'PAR90' }]).map(({ c, l }) => (
      <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
        <div style={{ width: 10, height: 3, borderRadius: 2, background: c }} />{l}
      </div>
    ))}
  </div>
)

// ── Department panel ──────────────────────────────────────────────────────────

function DeptPanel({ icon, label, color, metrics, to }: {
  icon: string; label: string; color: string
  metrics: { label: string; value: string }[]
  to: string
}) {
  const navigate = useNavigate()
  return (
    <div onClick={() => navigate(to)} style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)',
      borderRadius: RADIUS.xl, padding: `${SP[5]} ${SP[6]}`,
      cursor: 'pointer', transition: 'box-shadow 150ms',
    }}
    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)' }}
    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 16 }}>
        <div style={{ width: 32, height: 32, borderRadius: RADIUS.md, background: `${color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color }}>{icon}</span>
        </div>
        <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>{label}</span>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: 'var(--txt3)', marginLeft: 'auto' }}>chevron_right</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {metrics.map(m => (
          <div key={m.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{m.label}</span>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{m.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Empty state (for sections whose source lives in Udara, not the workspace) ──

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '34px 16px', textAlign: 'center' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 30, color: 'var(--txt3)' }}>{icon}</span>
      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: SORA }}>{title}</div>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER, maxWidth: 340 }}>{body}</div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Overview() {
  const navigate = useNavigate()
  const [loading,    setLoading]    = useState(true)
  const [from,       setFrom]       = useState(monthStartIso())
  const [to,         setTo]         = useState(isoDate(new Date()))
  const [kpis,       setKpis]       = useState<KPIs | null>(null)
  const [fd,         setFd]         = useState<FDSummary | null>(null)
  const [ccSummary,  setCcSummary]  = useState<ContactCenterSummary | null>(null)
  const [cards,      setCards]      = useState<CardsSummary | null>(null)
  const [monthly,    setMonthly]    = useState<MonthlyPoint[]>([])
  const [products,   setProducts]   = useState<ProductPoint[]>([])
  const [dpd,        setDpd]        = useState<DPDPoint[]>([])
  const [performers, setPerformers] = useState<TopPerformer[]>([])
  const [losStages,  setLosStages]  = useState<LOSStages | null>(null)
  const [ccStages,   setCcStages]   = useState<CCStages | null>(null)
  const [funnel,     setFunnel]     = useState<AcquisitionFunnel | null>(null)
  const [settlements, setSettlements] = useState<SettlementsSummary | null>(null)
  const [collections, setCollections] = useState<CollectionsSummary | null>(null)
  const [recovery,   setRecovery]   = useState<RecoverySummary | null>(null)
  const [growth,     setGrowth]     = useState<GrowthSummary | null>(null)
  const [growthTrend, setGrowthTrend] = useState<GrowthTrend[]>([])
  const [lastSync,   setLastSync]   = useState<Date | null>(null)
  const [perfRegion, setPerfRegion] = useState<'' | 'lagos' | 'abuja'>('')
  const [revProduct, setRevProduct] = useState<'all' | 'cards' | 'loans' | 'fd'>('all')

  async function load(f: string, t: string) {
    const win = `from=${f}&to=${t}`
    const exec = `period=custom&start=${f}&end=${t}`
    setLoading(true)

    // Progressive load: every endpoint applies its own result the moment it resolves,
    // so one heavy aggregation (e.g. the growth per-customer GROUP BY) can't hold the
    // whole dashboard blank — light sections paint immediately. React 18 batches the
    // ones that land in the same tick, so this is a couple of renders, not 13.
    const run = <T,>(url: string, apply: (d: T) => void) =>
      apiFetch<{ data: T }>(url).then(r => { if (r?.data != null) apply(r.data) }).catch(() => {})

    await Promise.allSettled([
      run<KPIs>(`/api/overview/kpis?${win}`, d => setKpis(d)),
      // Money fields arrive as JSON *strings* (pg bigint/numeric) — coerce at the
      // boundary so no downstream reduce/axis silently string-concatenates.
      run<MonthlyPoint[]>(`/api/overview/monthly-volume?${win}`, d => { if (d.length) setMonthly(d.map(r => ({
        ...r, disbursements_kobo: Number(r.disbursements_kobo) || 0, fd_payouts_kobo: Number(r.fd_payouts_kobo) || 0,
        card_spend_kobo: Number(r.card_spend_kobo) || 0,
      }))) }),
      run<ProductPoint[]>('/api/overview/product-mix', d => { if (d.length) setProducts(d.map(p => ({
        product: p.product, count: Number(p.count), volume_kobo: Number(p.volume_kobo),
      }))) }),
      run<DPDPoint[]>('/api/overview/dpd-trend', d => { if (d.length) setDpd(d) }),
      run<LOSStages>('/api/overview/los-stages', d => setLosStages(d)),
      run<CCStages>('/api/overview/cc-stages', d => setCcStages(d)),
      run<FDSummary>('/api/overview/fd-summary', d => setFd(d)),
      run<CardsSummary>(`/api/overview/cards-summary?${win}`, d => setCards(d)),
      run<ContactCenterSummary>(`/api/overview/contact-center?${win}`, d => setCcSummary(d)),
      run<AcquisitionFunnel>('/api/overview/acquisition-funnel', d => setFunnel(d)),
      run<SettlementsSummary>(`/api/executive/settlements?${exec}`, d => setSettlements(d)),
      run<CollectionsSummary>(`/api/executive/collections?${exec}`, d => setCollections(d)),
      run<GrowthSummary>(`/api/overview/growth?${win}`, d => {
        setGrowth(d)
        if (d.trend?.length) setGrowthTrend(d.trend.map(r => ({
          month: r.month, new_accounts: Number(r.new_accounts) || 0, active_customers: Number(r.active_customers) || 0,
        })))
      }),
      run<RecoverySummary>(`/api/executive/recovery?${exec}`, d => setRecovery(d)),
    ])
    setLastSync(new Date())
    setLoading(false)
  }

  useEffect(() => { load(from, to) }, [from, to])

  // Top Performers is fetched on its own so the Lagos/Abuja/All region toggle can
  // refresh just this panel without reloading the whole dashboard. Ranks officers
  // across loans + FD + cards (via the customer→officer map) in the selected window.
  useEffect(() => {
    const reg = perfRegion ? `&region=${perfRegion}` : ''
    apiFetch<{ data: TopPerformer[] }>(`/api/overview/top-performers?from=${from}&to=${to}${reg}`)
      .then(res => setPerformers(res.data ?? []))
      .catch(() => setPerformers([]))
  }, [from, to, perfRegion])

  const totalVolume = products.reduce((s, p) => s + p.volume_kobo, 0) || 1
  // `|| 1` (not `?? 1`): in a card-only period every officer's total_kobo is 0, and
  // `?? 1` would leave perfMax=0 → NaN% bar widths → bars silently vanish.
  const perfMax     = performers[0]?.total_kobo || 1

  // Origination pipelines & the acquisition funnel are fed by workspace-native tables
  // (loan_applications / bd_leads / card_issuance_requests) that are empty by design —
  // origination is booked in Udara. Detect "no pipeline data" so we show an explanation
  // instead of dead all-zero bars.
  const losTotal    = losStages ? LOS_STAGES.reduce((s, st) => s + (losStages[st.key] ?? 0), 0) : 0
  const ccPipeTotal = ccStages  ? CC_STAGES.reduce((s, st) => s + (ccStages[st.key] ?? 0), 0)  : 0
  const funnelTotal = funnel ? funnel.leads + funnel.applications + funnel.approved + funnel.disbursed : 0

  // Loan-performing change reads as a rate, so express its delta in percentage POINTS
  // (last snapshot − first), not the relative %-change the backend sends — a 42%→91%
  // move is "+49 pts", not a misleading "+117%".
  const perfSeries = kpis?.performing_series ?? []
  const perfPts    = perfSeries.length >= 2 ? perfSeries[perfSeries.length - 1] - perfSeries[0] : null

  // Revenue product filter — the KPI narrows to each product line. Cards (fees/interest/
  // penalties) and loan interest accrued are income; FD interest is a cost of funds, shown
  // but flagged (amber) rather than counted as revenue. "All" = cards + loan interest.
  const REV_VIEWS = {
    all:   { val: kpis?.revenue_kobo,        sub: 'cards + loan interest',       tone: GREEN, showChg: true  },
    cards: { val: kpis?.revenue_cards_kobo,  sub: 'fees · interest · penalties', tone: GREEN, showChg: false },
    loans: { val: kpis?.revenue_loans_kobo,  sub: kpis ? `interest accrued · ${fmtKobo(kpis.revenue_loans_forward_kobo)} forward` : 'interest accrued', tone: GREEN, showChg: false },
    fd:    { val: kpis?.revenue_fd_cost_kobo, sub: 'cost of funds · accrued',     tone: AMBER, showChg: false },
  } as const
  const rv = REV_VIEWS[revProduct]

  // Revenue headline + three product-line books + one portfolio-health metric — O3 is a
  // multi-product business (Credit, Fixed Deposits, Cards), so each line gets a slot, led
  // by the period revenue, filterable by product.
  const KPI_CARDS = [
    { lbl: 'Revenue',          sub: rv.sub,          icon: 'payments',             color: GREEN,  val: kpis ? fmtKobo(Number(rv.val) || 0)             : '—', chg: rv.showChg ? (kpis?.revenue_change_pct ?? null) : null, spark: kpis?.revenue_series ?? [], unit: '%' as const },
    { lbl: 'Loan Book',        sub: 'outstanding',   icon: 'account_balance_wallet', color: NAVY,   val: kpis ? fmtKobo(kpis.portfolio_outstanding_kobo) : '—', chg: kpis?.portfolio_change_pct  ?? null, spark: kpis?.portfolio_series  ?? [], unit: '%' as const },
    { lbl: 'FD Book',          sub: 'deposits',      icon: 'savings',                color: AMBER,  val: kpis ? fmtKobo(kpis.fd_book_kobo)               : '—', chg: kpis?.fd_change_pct         ?? null, spark: kpis?.fd_series         ?? [], unit: '%' as const },
    { lbl: 'Active Cards',     sub: 'cardholders',   icon: 'credit_card',            color: PURPLE, val: kpis ? fmtNum(kpis.active_cards)                : '—', chg: null,                               spark: [],                            unit: '%' as const },
    { lbl: 'Loan Performing',  sub: 'portfolio health', icon: 'monitoring',          color: BLUE,   val: kpis ? fmtPct(kpis.performing_rate_pct)         : '—', chg: perfPts,                            spark: kpis?.performing_series ?? [], unit: 'pts' as const },
  ]

  // Customer growth & activity KPIs (pg serialises the counts as strings).
  // Each of registrations / transactions / activity is present only if its backend
  // query succeeded, so read every field through optional chaining — a missing group
  // must degrade to 0, never throw and take the whole section down.
  const gReg        = Number(growth?.registrations?.this_month) || 0
  const gRegPrev    = Number(growth?.registrations?.last_month) || 0
  const gTxn        = Number(growth?.transactions?.count_this) || 0
  const gTxnPrev    = Number(growth?.transactions?.count_last) || 0
  const gActive     = Number(growth?.transactions?.active_this) || 0
  const gActivePrev = Number(growth?.transactions?.active_last) || 0
  const gDormant    = Number(growth?.activity?.dormant) || 0
  const pctDelta = (cur: number, prev: number): number | null => prev ? ((cur - prev) / prev) * 100 : null

  const dateSlicer = <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />

  // Carry the Overview's selected window into each drilldown so the exec keeps the same
  // period on the way down — the drilldowns read ?from/?to and default to MTD without it.
  const execTo = (path: string) => `${path}?from=${from}&to=${to}`

  // Progressive render: show the page shell immediately and let each section fill in as
  // its data arrives, instead of blocking the whole page on the slowest fetch. Every
  // section already guards on null/empty, so the shell is safe to paint on first mount.
  return (
    <Page
      title="Executive Overview"
      subtitle={kpis ? `${fmtNum(kpis.active_customers)} active borrowers${lastSync ? ' · Last synced ' + fmtRelTime(lastSync) : ''}` : undefined}
      actions={dateSlicer}
      loading={loading && !kpis}
      skeletonKpis={5}
    >
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
          <Spinner size={13} color={NAVY} /> Refreshing…
        </div>
      )}

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--card-bdr)',
        boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, marginBottom: 14,
        display: 'grid', gridTemplateColumns: 'repeat(5,1fr)',
      }}>
        {KPI_CARDS.map((k, i, arr) => {
          const isRev = k.lbl === 'Revenue'
          return (
          <div key={k.lbl} style={{ padding: '22px 24px', borderRight: i < arr.length - 1 ? '1px solid var(--bdr)' : undefined }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: INTER }}>{k.lbl}</span>
              <span className="material-symbols-rounded" style={{ fontSize: 17, color: k.color, opacity: 0.7 }}>{k.icon}</span>
            </div>
            <div style={{ ...NUM, fontSize: 30, fontWeight: FW.extrabold, color: isRev ? rv.tone : 'var(--txt)', letterSpacing: -1.5, fontFamily: INTER, lineHeight: 1 }}>{k.val}</div>
            {k.chg == null ? (
              <div style={{ marginTop: 8, fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt3)', fontFamily: INTER }}>{k.sub}</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginTop: 8, fontSize: TEXT.xs, fontWeight: FW.semibold, color: k.chg >= 0 ? GREEN : RED, fontFamily: INTER }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>{k.chg >= 0 ? 'arrow_upward' : 'arrow_downward'}</span>
                <span>{k.chg >= 0 ? '+' : ''}{k.chg.toFixed(1)}{k.unit === 'pts' ? ' pts' : '%'} vs last period</span>
              </div>
            )}
            {isRev ? (
              <div style={{ display: 'flex', gap: 2, marginTop: 13, background: 'var(--chip-bg)', borderRadius: 6, padding: 2, border: '1px solid var(--bdr)' }}>
                {([['all', 'All'], ['cards', 'Cards'], ['loans', 'Loans'], ['fd', 'FD']] as const).map(([v, l]) => (
                  <button key={v} onClick={() => setRevProduct(v)} style={{
                    flex: 1, padding: '3px 0', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontFamily: INTER, fontWeight: revProduct === v ? FW.bold : FW.medium,
                    background: revProduct === v ? (v === 'fd' ? AMBER : GREEN) : 'transparent',
                    color: revProduct === v ? '#fff' : 'var(--txt2)', transition: 'background 120ms',
                  }}>{l}</button>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 14, height: 28 }}><Spark data={k.spark} color={k.color} /></div>
            )}
          </div>
          )
        })}
      </div>

      {/* ── Customer Growth & Activity ────────────────────────────────────── */}
      {growth && (
      <SectionCard
        title="Customer Growth & Activity"
        subtitle="Registrations, transactions and actives respond to the date filter · churn is a live snapshot"
        actions={
          <button onClick={() => navigate('/executive/growth')} style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: RADIUS.md,
            border: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer',
            fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, fontFamily: INTER,
          }}>
            Open monitor
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>arrow_forward</span>
          </button>
        }
        style={{ marginBottom: 18 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.55fr) minmax(0,1fr)', gap: 26, alignItems: 'stretch' }}>

          {/* LEFT — period flows (track the date filter) + 12-month trend */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {([
                { lbl: 'New Registrations', val: fmtNum(gReg),    delta: pctDelta(gReg, gRegPrev),       color: NAVY,  icon: 'person_add' },
                { lbl: 'Transactions',      val: fmtNum(gTxn),    delta: pctDelta(gTxn, gTxnPrev),       color: BLUE,  icon: 'sync_alt' },
                { lbl: 'Active Customers',  val: fmtNum(gActive), delta: pctDelta(gActive, gActivePrev), color: GREEN, icon: 'how_to_reg' },
              ]).map((k, i) => (
                <div key={k.lbl} style={{ paddingLeft: i > 0 ? 20 : 0, paddingRight: 20, borderRight: i < 2 ? '1px solid var(--bdr)' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 17, color: k.color }}>{k.icon}</span>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: INTER }}>{k.lbl}</span>
                  </div>
                  <div style={{ ...NUM, fontSize: 25, fontWeight: FW.extrabold, color: 'var(--txt)', letterSpacing: -0.8, lineHeight: 1 }}>{k.val}</div>
                  {k.delta != null && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginTop: 9, padding: '2px 8px 2px 5px', borderRadius: 20, background: (k.delta >= 0 ? GREEN : RED) + '14', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: k.delta >= 0 ? GREEN : RED, fontFamily: INTER }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{k.delta >= 0 ? 'arrow_upward' : 'arrow_downward'}</span>
                      {k.delta >= 0 ? '+' : ''}{k.delta.toFixed(1)}% vs prior
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Registrations vs active-customers — rolling 12 months */}
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: INTER }}>Registrations vs Active · 12 months</span>
                <div style={{ display: 'flex', gap: 12 }}>
                  {[{ c: NAVY, l: 'New registrations' }, { c: GREEN, l: 'Active customers' }].map(({ c, l }) => (
                    <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{l}
                    </span>
                  ))}
                </div>
              </div>
              <EChart height={140} option={(t: ChartTokens) => ({
                grid: { top: 12, right: 6, bottom: 4, left: 4, containLabel: true },
                tooltip: {
                  trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
                  formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), ps.map((p) => ({ color: p.color, name: p.seriesName, value: fmtNum(Number(p.value)) }))),
                },
                xAxis: { type: 'category', data: growthTrend.map((d: any) => d.month), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.lbl, fontSize: 10, fontFamily: 'Segoe UI, sans-serif' } },
                yAxis: [{ type: 'value', show: false }, { type: 'value', show: false }],
                series: [
                  { type: 'bar', name: 'New registrations', yAxisIndex: 0, data: growthTrend.map((d: any) => d.new_accounts), barMaxWidth: 15, itemStyle: { color: NAVY, borderRadius: [3, 3, 0, 0] } },
                  { type: 'bar', name: 'Active customers', yAxisIndex: 1, data: growthTrend.map((d: any) => d.active_customers), barMaxWidth: 15, itemStyle: { color: GREEN, borderRadius: [3, 3, 0, 0] } },
                ],
                animationDuration: 700,
              })} />
            </div>
          </div>

          {/* RIGHT — live churn snapshot */}
          {(() => {
            const gTotal = Number(growth.activity?.total) || 1
            const bands = [
              { v: Number(growth.activity?.active) || 0,       label: 'Active ≤90d',      color: GREEN },
              { v: Number(growth.activity?.lapsing) || 0,      label: 'Lapsing <1yr',     color: AMBER },
              { v: gDormant,                                   label: 'Dormant >1yr',     color: RED },
              { v: Number(growth.activity?.never_active) || 0, label: 'Never transacted', color: '#94A3B8' },
            ]
            return (
            <div style={{ borderLeft: '1px solid var(--bdr)', paddingLeft: 26, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: INTER }}>Activity Distribution</span>
                <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER }}>live snapshot</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
                <div style={{ width: 130, flexShrink: 0 }}>
                  <EDonut
                    data={bands} valueKey="v" nameKey="label" colorFn={(d) => d.color}
                    size={130} inner={38} outer={52} centerSize={16}
                    centerValue={fmtNum(gTotal)} centerLabel="on book"
                    valueFmt={(v) => fmtNum(v)}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minWidth: 0 }}>
                  {bands.map((b) => (
                    <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: b.color, flexShrink: 0 }} />
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, flex: 1, whiteSpace: 'nowrap' }}>{b.label}</span>
                      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(b.v)}</span>
                      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER, width: 44, textAlign: 'right' }}>{fmtPct((b.v / gTotal) * 100)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            )
          })()}

        </div>
      </SectionCard>
      )}

      {/* ── Department Dashboards ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: SP[2], marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>Department Dashboards</span>
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>Books &amp; rates are live; flows (disbursed, card spend, collected, recovered, settled, resolved) track the selected period · click any department to drill in</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 18 }}>
        <DeptPanel
          icon="credit_card" label="Cards" color={PURPLE} to={execTo('/executive/cards')}
          metrics={[
            // active_total is the WHOLE active book (~18.7k). Summing green+gold+platinum
            // undercounted it to a few hundred — those tier strings only match a sliver of
            // the portfolio.
            { label: 'Active Cards',      value: cards ? fmtNum(cards.active_total) : '—' },
            // Real NGN credit book from card_cycle_data — the per-tier outstandings only
            // match cards whose product_name contains the tier word, so summing them
            // under-captures the book and can even net negative. credit_ngn_balance_kobo
            // is the whole credit category.
            { label: 'Credit Book',       value: cards ? fmtKobo(cards.credit_ngn_balance_kobo) : '—' },
            { label: 'Card Spend (period)', value: cards ? fmtKobo(cards.card_spend_period_kobo) : '—' },
          ]}
        />
        <DeptPanel
          icon="savings" label="Fixed Deposits" color={AMBER} to={execTo('/executive/fixed-deposits')}
          metrics={[
            { label: 'FD Book',        value: fd ? fmtKobo(fd.total_fd_book_kobo) : '—' },
            { label: 'Active Deposits', value: fd ? fmtNum(fd.active_fd_count) : '—' },
            { label: 'Maturing 30d',   value: fd ? String(fd.maturing_30d) : '—' },
          ]}
        />
        <DeptPanel
          icon="trending_up" label="Sales" color={GREEN} to={execTo('/executive/sales')}
          metrics={[
            { label: 'Disbursed (period)', value: kpis ? fmtKobo(kpis.disbursements_kobo) : '—' },
            { label: 'Active Loans',       value: kpis ? fmtNum(kpis.active_loans) : '—' },
            { label: 'Active Borrowers',   value: kpis ? fmtNum(kpis.active_customers) : '—' },
          ]}
        />
        <DeptPanel
          icon="receipt_long" label="Collections" color={AMBER} to={execTo('/executive/collections')}
          metrics={[
            // Collections-specific highlights (the assigned book + collected flow), not the
            // portfolio-health rates the Risk panel already shows.
            { label: 'In Collections',     value: collections ? fmtKobo(collections.assigned_kobo) : '—' },
            { label: 'Open Cases',         value: collections ? fmtNum(collections.assigned_count) : '—' },
            { label: 'Collected (period)', value: collections ? fmtKobo(collections.collected_mtd_kobo) : '—' },
          ]}
        />
        <DeptPanel
          icon="gavel" label="Recovery" color={DARKRED} to={execTo('/executive/recovery')}
          metrics={[
            { label: 'Open Cases',     value: recovery ? fmtNum(recovery.open_cases) : '—' },
            { label: 'In Recovery',    value: recovery ? fmtKobo(recovery.open_outstanding_kobo) : '—' },
            { label: 'Recovered (period)', value: recovery ? fmtKobo(recovery.recovered_period_kobo) : '—' },
          ]}
        />
        <DeptPanel
          icon="shield" label="Risk" color={RED} to={execTo('/executive/risk')}
          metrics={[
            { label: 'Portfolio',       value: kpis ? fmtKobo(kpis.portfolio_outstanding_kobo) : '—' },
            { label: 'NPL Rate',        value: kpis ? fmtPct(kpis.npl_rate_pct) : '—' },
            { label: 'Performing Rate', value: kpis ? fmtPct(kpis.performing_rate_pct) : '—' },
          ]}
        />
        <DeptPanel
          icon="swap_horiz" label="Settlements" color="#7C3AED" to={execTo('/executive/settlements')}
          metrics={[
            // Payouts + settled are period flows; open recon exceptions is the live risk the
            // exec needs (the old Pending/Failed lines were structurally always zero).
            { label: 'Payouts (period)',  value: settlements ? fmtKobo(settlements.payouts_kobo) : '—' },
            { label: 'Settled (period)',  value: settlements ? fmtKobo(settlements.settled_period_kobo) : '—' },
            { label: 'Open Exceptions',   value: settlements ? fmtNum(settlements.open_exceptions) : '—' },
          ]}
        />
        {/* Call centre and care are one team, so they get one panel. It reuses the
            contact-center summary already fetched for the panel further down rather
            than adding a second request for the same numbers. */}
        <DeptPanel
          icon="support_agent" label="Contact Centre" color={BLUE} to="/helpdesk/stats"
          metrics={[
            { label: 'Open Tickets',      value: ccSummary ? fmtNum(ccSummary.open_tickets) : '—' },
            { label: 'Resolved (period)', value: ccSummary ? fmtNum(ccSummary.resolved_period) : '—' },
            { label: 'SLA Compliance',    value: ccSummary ? fmtPct(ccSummary.sla_compliance_pct) : '—' },
          ]}
        />
      </div>

      {/* ── Business Lines: Cards, full width ────────────────────────────── */}
      {/* Fixed Deposits and Contact Centre used to sit stacked in a narrow left
          column here, duplicating the numbers their Department Dashboard panels
          already carry. Dropping them gives the card tiers and currency tiles the
          full row, which is what they needed — three ATM visuals at a third of a
          third of the page were unreadable. */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, padding: `${SP[5]} ${SP[6]}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: PURPLE }}>credit_card</span>
              <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>Cards</span>
            </div>
            {(cards?.disputes_open ?? 0) > 0 && (
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: INTER, padding: '3px 10px', borderRadius: 99, background: (cards?.disputes_open ?? 0) > 5 ? 'rgba(192,0,0,0.10)' : 'var(--chip-bg)', color: (cards?.disputes_open ?? 0) > 5 ? RED : 'var(--txt2)' }}>
                {cards?.disputes_open} disputes
              </span>
            )}
          </div>

          {/* 3 ATM visuals — the REAL card book: Credit (owed to O3), Prepaid ₦ float
              (mostly customer credit), and Prepaid USD. The old green/gold/platinum tiles
              covered <600 of ~18.7k cards and had no synced cycle balances, so they read
              as unwired — these three are the categories that actually carry the money. */}
          <div style={{ display: 'flex', gap: SP[2] }}>
            {cards && <>
            <ATMCard tier="Credit Card ₦" gradient="linear-gradient(135deg,#7F0000,#C00000,#E23A3A)" count={cards.credit_ngn_count}  outstanding={cards.credit_ngn_balance_kobo}  countLabel="holders" lastFour="CR" />
            <ATMCard tier="Prepaid ₦"     gradient="linear-gradient(135deg,#0A2847,#12507F,#2C7BB6)" count={cards.prepaid_ngn_count}  outstanding={cards.prepaid_ngn_balance_kobo} countLabel="active"  lastFour="₦" />
            <ATMCard tier="Prepaid $"     gradient="linear-gradient(135deg,#14532D,#15803D,#22C55E)" count={cards.prepaid_usd_count}  outstanding={cards.prepaid_usd_balance_cents} currency="USD" countLabel="active" lastFour="$" />
            </>}
          </div>
        </div>
      </div>

      {/* ── Origination Pipelines — LOS + CC in one card ─────────────────── */}
      {(losStages || ccStages) && (
      <SectionCard title="Origination Pipelines" style={{ marginBottom: 14 }}>
        {losTotal > 0 || ccPipeTotal > 0 ? (
          <>
            {losStages && (
              <div style={{ padding: '4px 0 6px' }}>
                <PipelineSegments
                  stages={LOS_STAGES}
                  data={losStages as unknown as Record<keyof LOSStages, number>}
                  label="Credit Applications"
                />
              </div>
            )}
            {losStages && ccStages && <div style={{ borderTop: '1px solid var(--bdr)', margin: '16px 0 6px' }} />}
            {ccStages && (
              <div style={{ paddingBottom: 4 }}>
                <PipelineSegments
                  stages={CC_STAGES}
                  data={ccStages as unknown as Record<keyof CCStages, number>}
                  label="Credit Card Applications"
                  activeBadge={{ count: ccStages.active, color: PURPLE, label: 'active cards' }}
                />
              </div>
            )}
          </>
        ) : (
          <EmptyState icon="conveyor_belt"
            title="No applications in the workspace pipeline"
            body="Loan and card originations are booked in Udara core banking; they appear in the books above once active, not as workspace pipeline stages." />
        )}
      </SectionCard>
      )}

      {/* ── Acquisition Funnel ──────────────────────────────────────────────── */}
      {funnel && funnelTotal > 0 && (
      <SectionCard title="Acquisition Funnel" subtitle="Lead to disbursement conversion" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0', gap: 0 }}>
          {[
            { label: 'Leads',        count: funnel.leads,        color: NAVY,  icon: 'contacts'     },
            { label: 'Applications', count: funnel.applications, color: BLUE,  icon: 'description'  },
            { label: 'Approved',     count: funnel.approved,     color: AMBER, icon: 'check_circle' },
            { label: 'Disbursed',    count: funnel.disbursed,    color: GREEN, icon: 'payments'     },
          ].flatMap((step, i, arr) => {
            const nodes = []
            if (i > 0) {
              const prev = arr[i - 1]
              const pct = prev.count > 0 ? (step.count / prev.count) * 100 : 0
              nodes.push(
                <div key={`arrow-${i}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 6px', flexShrink: 0 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: 'var(--txt3)' }}>chevron_right</span>
                  <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: GREEN, fontFamily: INTER, ...NUM }}>{fmtPct(pct)}</span>
                </div>
              )
            }
            nodes.push(
              <div key={step.label} style={{ flex: 1, textAlign: 'center', padding: '18px 10px', background: `${step.color}08`, borderRadius: RADIUS.lg, border: `1px solid ${step.color}1A` }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT['2xl'], color: step.color }}>{step.icon}</span>
                <div style={{ ...NUM, fontFamily: INTER, fontSize: 28, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1, marginTop: 8 }}>{fmtNum(step.count)}</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, marginTop: 5 }}>{step.label}</div>
              </div>
            )
            return nodes
          })}
        </div>
      </SectionCard>
      )}

      {/* ── Charts: Disbursements + Product Mix ───────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>

        <SectionCard title="Loan, FD & Card Flows" subtitle="Loan disbursements · FD payouts · card spend · rolling 12-month view"
          actions={
            <div style={{ display: 'flex', gap: SP[3], flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {[{ c: NAVY, l: 'Loan Disbursements' }, { c: AMBER, l: 'FD Payouts' }, { c: PURPLE, l: 'Card Spend' }].map(({ c, l }) => (
                <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                  <div style={{ width: 10, height: 3, borderRadius: 2, background: c }} />{l}
                </div>
              ))}
            </div>
          }>
          <EArea
            data={monthly} xKey="month" height={200} leftMargin={4}
            endLabel endFmt={moneyTick} dots hideYAxis
            valueFmt={v => fmtKobo(v)}
            series={[
              { key: 'disbursements_kobo', name: 'Loan Disbursements', color: NAVY },
              { key: 'fd_payouts_kobo', name: 'FD Payouts', color: AMBER },
              { key: 'card_spend_kobo', name: 'Card Spend', color: PURPLE },
            ]}
          />
        </SectionCard>

        <SectionCard title="Product Mix" subtitle="By product line · book value (Udara)">
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], marginTop: 6 }}>
            <div style={{ width: 148, flexShrink: 0 }}>
              <EDonut
                data={products} valueKey="volume_kobo" nameKey="product"
                colorFn={(_, i) => DONUT_COLORS[i % DONUT_COLORS.length]}
                size={148} inner={42} outer={66} centerSize={15}
                centerValue={fmtKobo(totalVolume)} centerLabel="total book"
                valueFmt={v => fmtKobo(v)}
              />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {products.map((p, i) => {
                const pct = Math.round((p.volume_kobo / totalVolume) * 100)
                return (
                  <div key={p.product}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium }}>{p.product}</span>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{pct}%</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, paddingLeft: 15 }}>
                      <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, ...NUM }}>
                        {p.volume_kobo > 0 ? fmtKobo(p.volume_kobo) : 'balances not synced'}
                      </span>
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, ...NUM }}>{fmtNum(p.count)} accts</span>
                    </div>
                    <div style={{ height: 3, background: 'var(--bdr)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: DONUT_COLORS[i % DONUT_COLORS.length], borderRadius: 2 }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </SectionCard>

      </div>

      {/* ── DPD Trend + Top Performers ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3] }}>

        {/* Legend moved to card header (actions prop) — chart gets full height */}
        <SectionCard title="DPD Trend" subtitle="PAR30 / PAR60 / PAR90" actions={DPD_LEGEND}>
          <EBar
            data={dpd} xKey="month" height={230} legend={false} leftMargin={8}
            valueFmt={v => `${v} accounts`}
            series={[
              { key: 'par30', name: 'PAR30 (1–30d)', color: AMBER },
              { key: 'par60', name: 'PAR60 (31–90d)', color: RED },
              { key: 'par90', name: 'PAR90 (91d+)', color: PURPLE },
            ]}
          />
        </SectionCard>

        <SectionCard
          title="Top Performers"
          subtitle="Account officers by value originated · loans + deposits placed in period"
          actions={
            <div style={{ display: 'flex', gap: 2, background: 'var(--chip-bg)', borderRadius: RADIUS.md, padding: 3, border: '1px solid var(--bdr)' }}>
              {([['', 'All'], ['lagos', 'Lagos'], ['abuja', 'Abuja']] as const).map(([val, label]) => (
                <button key={val} onClick={() => setPerfRegion(val)} style={{
                  padding: '4px 11px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: TEXT.xs, fontFamily: INTER, fontWeight: perfRegion === val ? FW.bold : FW.medium,
                  background: perfRegion === val ? NAVY : 'transparent',
                  color: perfRegion === val ? '#fff' : 'var(--txt2)',
                }}>{label}</button>
              ))}
            </div>
          }
        >
          {performers.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '44px 16px', textAlign: 'center' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 30, color: 'var(--txt3)' }}>leaderboard</span>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: SORA }}>No originations in this period{perfRegion ? ` · ${perfRegion === 'lagos' ? 'Lagos' : 'Abuja'}` : ''}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER, maxWidth: 260 }}>Widen the date range or switch region to rank officers over a period with activity.</div>
            </div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
            {performers.map((p, i) => {
              const color    = PERF_COLORS[i % PERF_COLORS.length]
              const initials = p.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
              const parts = [
                p.loans_kobo > 0 ? `Loans ${fmtKobo(p.loans_kobo)}` : '',
                p.fd_kobo > 0 ? `FD ${fmtKobo(p.fd_kobo)}` : '',
                p.cards_count > 0 ? `${p.cards_count} card${p.cards_count === 1 ? '' : 's'}` : '',
              ].filter(Boolean).join(' · ')
              return (
                <div key={p.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, width: 16, flexShrink: 0, textAlign: 'right' }}>#{i + 1}</span>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, flexShrink: 0 }}>
                      {initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parts || (p.role ?? '').replace(/_/g, ' ')}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.total_kobo)}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>originated</div>
                    </div>
                  </div>
                  <div style={{ height: 4, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width: `${(p.total_kobo / perfMax) * 100}%`, height: '100%', background: color, borderRadius: 99 }} />
                  </div>
                </div>
              )
            })}
          </div>
          )}
        </SectionCard>

      </div>

    </Page>
  )
}
