import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, Spinner, DateFilter } from '../components/UI'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../lib/fmt'
import { RED, AMBER, BLUE, GREEN, PURPLE, NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KPIs {
  portfolio_outstanding_kobo: number
  fd_book_kobo: number
  active_cards: number
  performing_rate_pct: number
  npl_rate_pct: number
  disbursements_kobo: number
  active_customers: number
  active_loans: number
  portfolio_change_pct: number | null
  fd_change_pct: number | null
  performing_change_pct: number | null
  disbursements_change_pct: number | null
  customers_change_pct: number | null
  portfolio_series: number[]
  fd_series: number[]
  performing_series: number[]
  disbursements_series: number[]
  customers_series: number[]
}
interface SettlementsSummary {
  settled_period_kobo: number
  pending_count: number
  failed_period: number
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
  escalations_open: number
}
interface CardsSummary {
  disputes_open: number
  green_count: number;    green_outstanding_kobo: number
  gold_count: number;     gold_outstanding_kobo: number
  platinum_count: number; platinum_outstanding_kobo: number
  prepaid_ngn_count: number;   prepaid_ngn_balance_kobo: number
  prepaid_usd_count: number;   prepaid_usd_balance_cents: number
  credit_ngn_count: number;    credit_ngn_balance_kobo: number
}
interface MonthlyPoint { month: string; disbursements_kobo: number; fd_payouts_kobo: number }
interface ProductPoint  { product: string; count: number; volume_kobo: number }
interface DPDPoint      { month: string; par30: number; par60: number; par90: number }
interface TopPerformer  { name: string; dept: string; amount_kobo: number; count: number }
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

const DONUT_COLORS = [NAVY, RED, AMBER, GREEN, PURPLE]
const PERF_COLORS  = [RED, NAVY, AMBER, GREEN, PURPLE, BLUE]

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

// ── Dark tooltip ──────────────────────────────────────────────────────────────

function Tip({ active, payload, label, fmt }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  fmt?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const f = fmt ?? (v => String(v))
  return (
    <div style={{ background: NAVY, borderRadius: RADIUS.lg, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{f(p.value)}</span>
          {p.name && payload.length > 1 && <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.4)', fontFamily: SORA }}>{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

// ── ATM card visual ───────────────────────────────────────────────────────────

function ATMCard({ tier, gradient, count, outstanding, lastFour }: {
  tier: string; gradient: string; count: number; outstanding: number; lastFour: string
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
          <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'rgba(255,255,255,0.5)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 4 }}>O3 {tier}</div>
          {(() => { const b = bookAmount(outstanding, count > 0); return <>
            <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: '#fff', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.5 }}>{b.text}</div>
            <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,0.45)', fontFamily: INTER, marginTop: 3 }}>{b.label}</div>
          </> })()}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...NUM, fontSize: 26, fontWeight: FW.extrabold, color: '#fff', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(count)}</div>
          <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,0.45)', fontFamily: INTER, marginTop: 3 }}>cardholders</div>
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
  const [lastSync,   setLastSync]   = useState<Date | null>(null)

  async function load(f: string, t: string) {
    const win = `from=${f}&to=${t}`
    const exec = `period=custom&start=${f}&end=${t}`
    // U2: Use Promise.allSettled so a single failed endpoint doesn't blank the
    // entire dashboard — each section degrades independently.
    const results = await Promise.allSettled([
      apiFetch<{ data: KPIs                 }>(`/api/overview/kpis?${win}`),
      apiFetch<{ data: MonthlyPoint[]       }>('/api/overview/monthly-volume'),
      apiFetch<{ data: ProductPoint[]       }>('/api/overview/product-mix'),
      apiFetch<{ data: DPDPoint[]           }>('/api/overview/dpd-trend'),
      apiFetch<{ data: TopPerformer[]       }>(`/api/overview/top-performers?${win}`),
      apiFetch<{ data: LOSStages            }>('/api/overview/los-stages'),
      apiFetch<{ data: CCStages             }>('/api/overview/cc-stages'),
      apiFetch<{ data: FDSummary            }>('/api/overview/fd-summary'),
      apiFetch<{ data: CardsSummary         }>('/api/overview/cards-summary'),
      apiFetch<{ data: ContactCenterSummary }>('/api/overview/contact-center'),
      apiFetch<{ data: AcquisitionFunnel    }>('/api/overview/acquisition-funnel'),
      apiFetch<{ data: SettlementsSummary   }>(`/api/executive/settlements?${exec}`),
    ])
    function ok<T>(r: PromiseSettledResult<{ data: T }>): { data: T } | null {
      return r.status === 'fulfilled' ? r.value : null
    }
    const k   = ok<KPIs>(results[0]   as PromiseSettledResult<{ data: KPIs }>)
    const m   = ok<MonthlyPoint[]>(results[1]  as PromiseSettledResult<{ data: MonthlyPoint[] }>)
    const pr  = ok<ProductPoint[]>(results[2]  as PromiseSettledResult<{ data: ProductPoint[] }>)
    const d   = ok<DPDPoint[]>(results[3]      as PromiseSettledResult<{ data: DPDPoint[] }>)
    const tp  = ok<TopPerformer[]>(results[4]  as PromiseSettledResult<{ data: TopPerformer[] }>)
    const ls  = ok<LOSStages>(results[5]       as PromiseSettledResult<{ data: LOSStages }>)
    const ccs = ok<CCStages>(results[6]        as PromiseSettledResult<{ data: CCStages }>)
    const f2  = ok<FDSummary>(results[7]       as PromiseSettledResult<{ data: FDSummary }>)
    const ca  = ok<CardsSummary>(results[8]    as PromiseSettledResult<{ data: CardsSummary }>)
    const cct = ok<ContactCenterSummary>(results[9]  as PromiseSettledResult<{ data: ContactCenterSummary }>)
    const fn  = ok<AcquisitionFunnel>(results[10] as PromiseSettledResult<{ data: AcquisitionFunnel }>)
    const stl = ok<SettlementsSummary>(results[11] as PromiseSettledResult<{ data: SettlementsSummary }>)
    if (k?.data)          setKpis(k.data)
    if (m?.data?.length)  setMonthly(m.data)
    // volume_kobo / count arrive as JSON *strings* (pg bigint/numeric serialisation).
    // Coerce to Number here or the downstream reduce concatenates strings instead of
    // summing — which silently corrupted the donut total and every percentage.
    if (pr?.data?.length) setProducts(pr.data.map(p => ({
      product: p.product,
      count: Number(p.count),
      volume_kobo: Number(p.volume_kobo),
    })))
    if (d?.data?.length)  setDpd(d.data)
    setPerformers(tp?.data ?? [])   // period-scoped: clear when the new window has none
    if (ls?.data)         setLosStages(ls.data)
    if (ccs?.data)        setCcStages(ccs.data)
    if (f2?.data)         setFd(f2.data)
    if (ca?.data)         setCards(ca.data)
    if (cct?.data)        setCcSummary(cct.data)
    if (fn?.data)         setFunnel(fn.data)
    if (stl?.data)        setSettlements(stl.data)
    setLastSync(new Date())
    setLoading(false)
  }

  useEffect(() => { load(from, to) }, [from, to])

  const totalVolume = products.reduce((s, p) => s + p.volume_kobo, 0) || 1
  const perfMax     = performers[0]?.amount_kobo ?? 1

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

  // Three product-line books + one portfolio-health metric — O3 is a multi-product
  // business (Credit, Fixed Deposits, Cards), so each line gets a headline slot.
  const KPI_CARDS = [
    { lbl: 'Loan Book',        sub: 'outstanding',   icon: 'account_balance_wallet', color: NAVY,   val: kpis ? fmtKobo(kpis.portfolio_outstanding_kobo) : '—', chg: kpis?.portfolio_change_pct  ?? null, spark: kpis?.portfolio_series  ?? [], unit: '%' as const },
    { lbl: 'FD Book',          sub: 'deposits',      icon: 'savings',                color: AMBER,  val: kpis ? fmtKobo(kpis.fd_book_kobo)               : '—', chg: kpis?.fd_change_pct         ?? null, spark: kpis?.fd_series         ?? [], unit: '%' as const },
    { lbl: 'Active Cards',     sub: 'cardholders',   icon: 'credit_card',            color: PURPLE, val: kpis ? fmtNum(kpis.active_cards)                : '—', chg: null,                               spark: [],                            unit: '%' as const },
    { lbl: 'Loan Performing',  sub: 'portfolio health', icon: 'monitoring',          color: GREEN,  val: kpis ? fmtPct(kpis.performing_rate_pct)         : '—', chg: perfPts,                            spark: kpis?.performing_series ?? [], unit: 'pts' as const },
  ]

  const dateSlicer = <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />

  if (loading) return (
    <Page title="Executive Overview" actions={dateSlicer}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '100px 0' }}>
        <Spinner size={36} />
      </div>
    </Page>
  )

  return (
    <Page
      title="Executive Overview"
      subtitle={kpis ? `${fmtNum(kpis.active_customers)} active borrowers${lastSync ? ' · Last synced ' + fmtRelTime(lastSync) : ''}` : undefined}
      actions={dateSlicer}
    >

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--card-bdr)',
        boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, marginBottom: 14,
        display: 'grid', gridTemplateColumns: 'repeat(4,1fr)',
      }}>
        {KPI_CARDS.map((k, i, arr) => (
          <div key={k.lbl} style={{ padding: '22px 24px', borderRight: i < arr.length - 1 ? '1px solid var(--bdr)' : undefined }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: INTER }}>{k.lbl}</span>
              <span className="material-symbols-rounded" style={{ fontSize: 17, color: k.color, opacity: 0.7 }}>{k.icon}</span>
            </div>
            <div style={{ ...NUM, fontSize: 30, fontWeight: FW.extrabold, color: 'var(--txt)', letterSpacing: -1.5, fontFamily: INTER, lineHeight: 1 }}>{k.val}</div>
            {k.chg == null ? (
              <div style={{ marginTop: 8, fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt3)', fontFamily: INTER }}>{k.sub}</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginTop: 8, fontSize: TEXT.xs, fontWeight: FW.semibold, color: k.chg >= 0 ? GREEN : RED, fontFamily: INTER }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>{k.chg >= 0 ? 'arrow_upward' : 'arrow_downward'}</span>
                <span>{k.chg >= 0 ? '+' : ''}{k.chg.toFixed(1)}{k.unit === 'pts' ? ' pts' : '%'} vs last period</span>
              </div>
            )}
            <div style={{ marginTop: 14, height: 28 }}><Spark data={k.spark} color={k.color} /></div>
          </div>
        ))}
      </div>

      {/* ── Department Dashboards ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 10 }}>
        <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>Department Dashboards</span>
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>Click any department for an executive view</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 18 }}>
        <DeptPanel
          icon="credit_card" label="Cards" color={PURPLE} to="/executive/cards"
          metrics={[
            { label: 'Active Cards',   value: cards ? fmtNum((cards.green_count) + (cards.gold_count) + (cards.platinum_count)) : '—' },
            // Real NGN credit book from card_cycle_data — the per-tier outstandings only
            // match cards whose product_name contains the tier word, so summing them
            // under-captures the book and can even net negative. credit_ngn_balance_kobo
            // is the whole credit category.
            { label: 'Credit Book',    value: cards ? fmtKobo(cards.credit_ngn_balance_kobo) : '—' },
            { label: 'Open Disputes',  value: cards ? String(cards.disputes_open) : '—' },
          ]}
        />
        <DeptPanel
          icon="savings" label="Fixed Deposits" color={AMBER} to="/executive/fixed-deposits"
          metrics={[
            { label: 'FD Book',        value: fd ? fmtKobo(fd.total_fd_book_kobo) : '—' },
            { label: 'Active Deposits', value: fd ? fmtNum(fd.active_fd_count) : '—' },
            { label: 'Maturing 30d',   value: fd ? String(fd.maturing_30d) : '—' },
          ]}
        />
        <DeptPanel
          icon="trending_up" label="Sales" color={GREEN} to="/executive/sales"
          metrics={[
            { label: 'Disbursed (period)', value: kpis ? fmtKobo(kpis.disbursements_kobo) : '—' },
            { label: 'Active Loans',       value: kpis ? fmtNum(kpis.active_loans) : '—' },
            { label: 'Active Borrowers',   value: kpis ? fmtNum(kpis.active_customers) : '—' },
          ]}
        />
        <DeptPanel
          icon="receipt_long" label="Collections" color={AMBER} to="/executive/collections"
          metrics={[
            { label: 'Performing Rate', value: kpis ? fmtPct(kpis.performing_rate_pct) : '—' },
            { label: 'NPL Rate',        value: kpis ? fmtPct(kpis.npl_rate_pct) : '—' },
            { label: 'Portfolio',       value: kpis ? fmtKobo(kpis.portfolio_outstanding_kobo) : '—' },
          ]}
        />
        <DeptPanel
          icon="shield" label="Risk" color={RED} to="/executive/risk"
          metrics={[
            { label: 'Portfolio',       value: kpis ? fmtKobo(kpis.portfolio_outstanding_kobo) : '—' },
            { label: 'NPL Rate',        value: kpis ? fmtPct(kpis.npl_rate_pct) : '—' },
            { label: 'Performing Rate', value: kpis ? fmtPct(kpis.performing_rate_pct) : '—' },
          ]}
        />
        <DeptPanel
          icon="swap_horiz" label="Settlements" color="#7C3AED" to="/executive/settlements"
          metrics={[
            { label: 'Settled (period)', value: settlements ? fmtKobo(settlements.settled_period_kobo) : '—' },
            { label: 'Pending Batches',  value: settlements ? String(settlements.pending_count) : '—' },
            { label: 'Failed',           value: settlements ? String(settlements.failed_period) : '—' },
          ]}
        />
        {/* Call centre and care are one team, so they get one panel. It reuses the
            contact-center summary already fetched for the panel further down rather
            than adding a second request for the same numbers. */}
        <DeptPanel
          icon="support_agent" label="Contact Centre" color={BLUE} to="/helpdesk/stats"
          metrics={[
            { label: 'Open Tickets',   value: ccSummary ? fmtNum(ccSummary.open_tickets) : '—' },
            { label: 'Resolved Today', value: ccSummary ? fmtNum(ccSummary.resolved_today) : '—' },
            { label: 'SLA Compliance', value: ccSummary ? fmtPct(ccSummary.sla_compliance_pct) : '—' },
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

          {/* 3 ATM card visuals — credit tiers */}
          <div style={{ display: 'flex', gap: SP[2], marginBottom: 20 }}>
            {cards && <>
            <ATMCard tier="Green"    gradient="linear-gradient(135deg,#14532D,#16A34A,#22C55E)"   count={cards.green_count}    outstanding={cards.green_outstanding_kobo}    lastFour="••••" />
            <ATMCard tier="Gold"     gradient="linear-gradient(135deg,#78350F,#D97706,#F59E0B)"   count={cards.gold_count}     outstanding={cards.gold_outstanding_kobo}     lastFour="••••" />
            <ATMCard tier="Platinum" gradient="linear-gradient(135deg,#374151,#6B7280,#D1D5DB)"   count={cards.platinum_count} outstanding={cards.platinum_outstanding_kobo} lastFour="••••" />
          </>}
          </div>

          {/* Currency product tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[2] }}>

            {/* Naira Credit Card — red accent */}
            <div style={{ background: 'rgba(192,0,0,0.07)', border: '1px solid rgba(192,0,0,0.18)', borderRadius: RADIUS.xl, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginBottom: 10 }}>
                <span style={{ fontSize: TEXT['2xl'], lineHeight: 1 }}>🇳🇬</span>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: RED, fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5 }}>Credit Card</div>
              </div>
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.5 }}>{cards ? fmtKobo(cards.credit_ngn_balance_kobo) : '—'}</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, marginTop: 5 }}>{cards ? fmtNum(cards.credit_ngn_count) : '—'} holders</div>
            </div>

            {/* Prepaid NGN */}
            <div style={{ background: 'var(--chip-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginBottom: 10 }}>
                <span style={{ fontSize: TEXT['2xl'], lineHeight: 1 }}>🇳🇬</span>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5 }}>Prepaid ₦</div>
              </div>
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.5 }}>{cards ? bookAmount(cards.prepaid_ngn_balance_kobo, cards.prepaid_ngn_count > 0).text : '—'}</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, marginTop: 5 }}>{cards ? `${fmtNum(cards.prepaid_ngn_count)} active · float held` : '—'}</div>
            </div>

            {/* Prepaid USD */}
            <div style={{ background: 'var(--chip-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginBottom: 10 }}>
                <span style={{ fontSize: TEXT['2xl'], lineHeight: 1 }}>🇺🇸</span>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5 }}>Prepaid $</div>
              </div>
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.5 }}>{cards ? fmtUsd(cards.prepaid_usd_balance_cents) : '—'}</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, marginTop: 5 }}>{cards ? fmtNum(cards.prepaid_usd_count) : '—'} active</div>
            </div>

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

        <SectionCard title="Loan & FD Payouts" subtitle="Loan disbursements vs FD maturities · rolling 12-month view (Udara)"
          actions={
            <div style={{ display: 'flex', gap: SP[3] }}>
              {[{ c: NAVY, l: 'Loan Disbursements' }, { c: AMBER, l: 'FD Payouts' }].map(({ c, l }) => (
                <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                  <div style={{ width: 10, height: 3, borderRadius: 2, background: c }} />{l}
                </div>
              ))}
            </div>
          }>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={monthly} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                <linearGradient id="gradDisb" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={NAVY} stopOpacity={0}    />
                </linearGradient>
                <linearGradient id="gradFd" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={AMBER} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={AMBER} stopOpacity={0}    />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={70} tickCount={5}
                tickFormatter={v => {
                  const n = v as number
                  if (n === 0) return ''
                  if (n >= 1_000_000_00) return `₦${(n / 1_000_000_00).toFixed(0)}m`
                  if (n >= 1_000_00)     return `₦${(n / 1_000_00).toFixed(0)}k`
                  return ''
                }}
                tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false}
              />
              <Tooltip content={<Tip fmt={v => fmtKobo(v)} />} />
              <Area type="monotone" dataKey="disbursements_kobo" name="Loan Disbursements"
                stroke={NAVY} strokeWidth={2.2} fill="url(#gradDisb)"
                dot={{ r: 3, fill: NAVY, strokeWidth: 0 }}
                activeDot={{ r: 5, fill: NAVY, stroke: '#fff', strokeWidth: 2 }}
              />
              <Area type="monotone" dataKey="fd_payouts_kobo" name="FD Payouts"
                stroke={AMBER} strokeWidth={2.2} fill="url(#gradFd)"
                dot={{ r: 3, fill: AMBER, strokeWidth: 0 }}
                activeDot={{ r: 5, fill: AMBER, stroke: '#fff', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Product Mix" subtitle="By product line · book value (Udara)">
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], marginTop: 6 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <PieChart width={148} height={148}>
                <Pie data={products} cx={72} cy={72} innerRadius={42} outerRadius={66}
                  dataKey="volume_kobo" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                  {products.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<Tip fmt={v => fmtKobo(v)} />} />
              </PieChart>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtKobo(totalVolume)}</div>
                <div style={{ fontSize: 9, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>total book</div>
              </div>
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
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={dpd} margin={{ top: 4, right: 8, bottom: 14, left: 8 }} barCategoryGap="30%" barGap={3}>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={36} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={v => `${v} accounts`} />} />
              <Bar dataKey="par30" name="PAR30 (1–30d)"  fill={AMBER}  radius={[3, 3, 0, 0]} />
              <Bar dataKey="par60" name="PAR60 (31–60d)" fill={RED}    radius={[3, 3, 0, 0]} />
              <Bar dataKey="par90" name="PAR90 (60d+)"   fill={PURPLE} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Top Performers" subtitle="By disbursement amount this period">
          {performers.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '44px 16px', textAlign: 'center' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 30, color: 'var(--txt3)' }}>leaderboard</span>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: SORA }}>No disbursements in this period</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER, maxWidth: 260 }}>Widen the date range to rank officers over a period with loan activity.</div>
            </div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
            {performers.map((p, i) => {
              const color    = PERF_COLORS[i % PERF_COLORS.length]
              const initials = p.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
              return (
                <div key={p.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, width: 16, flexShrink: 0, textAlign: 'right' }}>#{i + 1}</span>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, flexShrink: 0 }}>
                      {initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'capitalize' }}>{p.dept.replace(/_/g, ' ')}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.amount_kobo)}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{p.count} loans</div>
                    </div>
                  </div>
                  <div style={{ height: 4, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width: `${(p.amount_kobo / perfMax) * 100}%`, height: '100%', background: color, borderRadius: 99 }} />
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
