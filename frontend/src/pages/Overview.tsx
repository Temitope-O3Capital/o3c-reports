import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, Spinner } from '../components/UI'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../lib/fmt'
import { RED, AMBER, BLUE, GREEN, PURPLE, NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KPIs {
  portfolio_outstanding_kobo: number
  collections_rate_pct: number
  disbursements_mtd_kobo: number
  active_customers: number
  portfolio_change_pct?: number
  collections_change_pct?: number
  disbursements_change_pct?: number
  customers_change_pct?: number
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
interface MonthlyPoint { month: string; disbursements_kobo: number }
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

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'

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

const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd',  label: 'MTD'      },
  { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' },
  { id: 'ytd',  label: 'YTD'      },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-NG')}`
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
      padding: '20px 22px', overflow: 'hidden', flex: 1,
      boxShadow: '0 8px 28px rgba(0,0,0,0.28)', minHeight: 180,
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
          <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: '#fff', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.5 }}>{fmtKobo(outstanding)}</div>
          <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,0.45)', fontFamily: INTER, marginTop: 3 }}>outstanding</div>
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

// ── MiniStat ──────────────────────────────────────────────────────────────────

function MiniStat({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.6 }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: subColor ?? 'var(--txt2)', fontFamily: INTER, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ── Period selector ───────────────────────────────────────────────────────────

function PeriodFilter({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--chip-bg)', borderRadius: RADIUS.md, padding: 3, border: '1px solid var(--bdr)' }}>
      {PERIOD_OPTIONS.map(opt => (
        <button key={opt.id} onClick={() => onChange(opt.id)} style={{
          padding: '5px 14px', borderRadius: 7, border: 'none',
          fontSize: TEXT.sm, fontWeight: period === opt.id ? 700 : 500,
          fontFamily: INTER, cursor: 'pointer',
          background: period === opt.id ? 'var(--card)' : 'transparent',
          color: period === opt.id ? 'var(--txt)' : 'var(--txt2)',
          boxShadow: period === opt.id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          transition: 'all 130ms',
        }}>
          {opt.label}
        </button>
      ))}
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Overview() {
  const [loading,    setLoading]    = useState(true)
  const [period,     setPeriod]     = useState<Period>('mtd')
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
  const [lastSync,   setLastSync]   = useState<Date | null>(null)
  const [syncTick,   setSyncTick]   = useState(0)

  useEffect(() => {
    const t = setInterval(() => setSyncTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  async function load(p: Period) {
    try {
      const [k, m, pr, d, tp, ls, ccs, f, ca, cct, fn] = await Promise.all([
        apiFetch<{ data: KPIs                 }>(`/api/overview/kpis?period=${p}`),
        apiFetch<{ data: MonthlyPoint[]       }>(`/api/overview/monthly-volume?period=${p}`),
        apiFetch<{ data: ProductPoint[]       }>(`/api/overview/product-mix?period=${p}`),
        apiFetch<{ data: DPDPoint[]           }>(`/api/overview/dpd-trend?period=${p}`),
        apiFetch<{ data: TopPerformer[]       }>(`/api/overview/top-performers?period=${p}`),
        apiFetch<{ data: LOSStages            }>('/api/overview/los-stages'),
        apiFetch<{ data: CCStages             }>('/api/overview/cc-stages'),
        apiFetch<{ data: FDSummary            }>('/api/overview/fd-summary'),
        apiFetch<{ data: CardsSummary         }>('/api/overview/cards-summary'),
        apiFetch<{ data: ContactCenterSummary }>('/api/overview/contact-center'),
        apiFetch<{ data: AcquisitionFunnel    }>('/api/overview/acquisition-funnel'),
      ])
      if (k?.data)          setKpis(k.data)
      if (m?.data?.length)  setMonthly(m.data)
      if (pr?.data?.length) setProducts(pr.data)
      if (d?.data?.length)  setDpd(d.data)
      if (tp?.data?.length) setPerformers(tp.data)
      if (ls?.data)         setLosStages(ls.data)
      if (ccs?.data)        setCcStages(ccs.data)
      if (f?.data)          setFd(f.data)
      if (ca?.data)         setCards(ca.data)
      if (cct?.data)        setCcSummary(cct.data)
      if (fn?.data)         setFunnel(fn.data)
      setLastSync(new Date())
    } catch {
      // API unavailable — state stays null, empty sections shown
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(period) }, [period])

  const disbSpark  = monthly.slice(-7).map(m => m.disbursements_kobo)
  const totalCount = products.reduce((s, p) => s + p.count, 0) || 1
  const perfMax    = performers[0]?.amount_kobo ?? 1

  const KPI_CARDS = [
    { lbl: 'Portfolio Outstanding', icon: 'account_balance_wallet', color: NAVY,  val: kpis ? fmtKobo(kpis.portfolio_outstanding_kobo) : '—', chg: kpis?.portfolio_change_pct     ?? 0, up: (kpis?.portfolio_change_pct     ?? 0) >= 0, spark: disbSpark },
    { lbl: 'Collections Rate',      icon: 'trending_up',            color: GREEN, val: kpis ? fmtPct(kpis.collections_rate_pct)         : '—', chg: kpis?.collections_change_pct   ?? 0, up: (kpis?.collections_change_pct   ?? 0) >= 0, spark: disbSpark.map((_, i) => 88 + i * 0.6) },
    { lbl: 'Disbursements MTD',     icon: 'payments',               color: RED,   val: kpis ? fmtKobo(kpis.disbursements_mtd_kobo)      : '—', chg: kpis?.disbursements_change_pct ?? 0, up: (kpis?.disbursements_change_pct ?? 0) >= 0, spark: disbSpark },
    { lbl: 'Active Customers',      icon: 'groups',                 color: BLUE,  val: kpis ? fmtNum(kpis.active_customers)              : '—', chg: kpis?.customers_change_pct     ?? 0, up: (kpis?.customers_change_pct     ?? 0) >= 0, spark: disbSpark.map((_, i) => 1100 + i * 20) },
  ]

  if (loading) return (
    <Page title="Executive Overview" actions={<PeriodFilter period={period} onChange={p => { setPeriod(p) }} />}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '100px 0' }}>
        <Spinner size={36} />
      </div>
    </Page>
  )

  return (
    <Page
      title="Executive Overview"
      subtitle={kpis ? `${fmtNum(kpis.active_customers)} active customers${lastSync ? ' · Last synced ' + fmtRelTime(lastSync) : ''}` : undefined}
      actions={<PeriodFilter key={syncTick} period={period} onChange={setPeriod} />}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginTop: 8, fontSize: TEXT.xs, fontWeight: FW.semibold, color: k.up ? GREEN : RED, fontFamily: INTER }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>{k.up ? 'arrow_upward' : 'arrow_downward'}</span>
              <span>{k.up ? '+' : ''}{k.chg.toFixed(1)}% vs last period</span>
            </div>
            <div style={{ marginTop: 14 }}><Spark data={k.spark} color={k.color} /></div>
          </div>
        ))}
      </div>

      {/* ── Business Lines: [FD + CC stacked] | Cards ────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: SP[3], marginBottom: 14 }}>

        {/* Left column — FD above, CC below */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>

          {/* Fixed Deposits */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, padding: `${SP[5]} ${SP[6]}`, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 20 }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: AMBER }}>savings</span>
              <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>Fixed Deposits</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[5] }}>
              <MiniStat label="Total Book Value" value={fd ? fmtKobo(fd.total_fd_book_kobo) : '—'} />
              <MiniStat label="Active FDs"       value={fd ? fmtNum(fd.active_fd_count) : '—'} />
              <MiniStat label="Maturing in 30d"  value={fd ? String(fd.maturing_30d) : '—'}    sub="Require action" subColor={(fd?.maturing_30d ?? 0) > 10 ? RED : 'var(--txt2)'} />
              <MiniStat label="New This Month"   value={fd ? String(fd.new_this_month) : '—'}  sub="New placements" />
            </div>
          </div>

          {/* Contact Centre */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, padding: `${SP[5]} ${SP[6]}`, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 20 }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: BLUE }}>support_agent</span>
              <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>Contact Centre</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[5] }}>
              <MiniStat
                label="Open Tickets"
                value={ccSummary ? String(ccSummary.open_tickets) : '—'}
                sub={ccSummary ? `${ccSummary.in_queue} in queue` : undefined}
              />
              <MiniStat
                label="Resolved Today"
                value={ccSummary ? String(ccSummary.resolved_today) : '—'}
                sub="tickets closed"
              />
              <MiniStat
                label="Avg 1st Response"
                value={ccSummary ? `${ccSummary.avg_first_response_mins.toFixed(1)}m` : '—'}
                sub="target < 5 min"
                subColor={(ccSummary?.avg_first_response_mins ?? 0) < 5 ? GREEN : RED}
              />
              <MiniStat
                label="SLA Compliance"
                value={ccSummary ? fmtPct(ccSummary.sla_compliance_pct) : '—'}
                sub={ccSummary ? (ccSummary.escalations_open > 0 ? `${ccSummary.escalations_open} escalations` : 'no escalations') : undefined}
                subColor={(ccSummary?.escalations_open ?? 0) > 0 ? RED : 'var(--txt2)'}
              />
            </div>
          </div>

        </div>

        {/* Right column — Cards (wider) */}
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
            <ATMCard tier="Green"    gradient="linear-gradient(135deg,#14532D,#16A34A,#22C55E)"   count={cards.green_count}    outstanding={cards.green_outstanding_kobo}    lastFour="4521" />
            <ATMCard tier="Gold"     gradient="linear-gradient(135deg,#78350F,#D97706,#F59E0B)"   count={cards.gold_count}     outstanding={cards.gold_outstanding_kobo}     lastFour="7820" />
            <ATMCard tier="Platinum" gradient="linear-gradient(135deg,#374151,#6B7280,#D1D5DB)"   count={cards.platinum_count} outstanding={cards.platinum_outstanding_kobo} lastFour="3614" />
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
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.5 }}>{cards ? fmtKobo(cards.prepaid_ngn_balance_kobo) : '—'}</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, marginTop: 5 }}>{cards ? fmtNum(cards.prepaid_ngn_count) : '—'} active</div>
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
      {losStages && ccStages && (
      <SectionCard title="Origination Pipelines" style={{ marginBottom: 14 }}>
        <div style={{ padding: '4px 0 6px' }}>
          <PipelineSegments
            stages={LOS_STAGES}
            data={losStages as unknown as Record<keyof LOSStages, number>}
            label="Credit Applications"
          />
        </div>
        <div style={{ borderTop: '1px solid var(--bdr)', margin: '16px 0 6px' }} />
        <div style={{ paddingBottom: 4 }}>
          <PipelineSegments
            stages={CC_STAGES}
            data={ccStages as unknown as Record<keyof CCStages, number>}
            label="Credit Card Applications"
            activeBadge={{ count: ccStages.active, color: PURPLE, label: 'active cards' }}
          />
        </div>
      </SectionCard>
      )}

      {/* ── Acquisition Funnel ──────────────────────────────────────────────── */}
      {funnel && (
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

        <SectionCard title="Monthly Disbursements" subtitle="Loan payouts per month">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={monthly} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                <linearGradient id="gradDisb" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={NAVY} stopOpacity={0}    />
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
              <Area type="monotone" dataKey="disbursements_kobo" name="Disbursements"
                stroke={NAVY} strokeWidth={2.2} fill="url(#gradDisb)"
                dot={{ r: 3, fill: NAVY, strokeWidth: 0 }}
                activeDot={{ r: 5, fill: NAVY, stroke: '#fff', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Product Mix" subtitle="Portfolio by account count">
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], marginTop: 6 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <PieChart width={148} height={148}>
                <Pie data={products} cx={72} cy={72} innerRadius={42} outerRadius={66}
                  dataKey="count" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                  {products.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<Tip fmt={v => `${v} accounts`} />} />
              </PieChart>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(totalCount)}</div>
                <div style={{ fontSize: 9, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>accounts</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {products.map((p, i) => {
                const pct = Math.round((p.count / totalCount) * 100)
                return (
                  <div key={p.product}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium }}>{p.product}</span>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{pct}%</span>
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, ...NUM, minWidth: 30, textAlign: 'right' }}>{fmtNum(p.count)}</span>
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
        </SectionCard>

      </div>
    </Page>
  )
}
