import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  PieChart, Pie, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, KpiCard, SectionCard, ErrBanner, Spinner, DataTable, ExpandableFilterBar } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiExport } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, DARKRED, AMBER, GREEN, BLUE, INTER, SORA, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReviewKPIs {
  reviewed: number; approved: number; declined: number; pending: number
}
interface PortfolioKPIs {
  npl_ratio_pct: number; par30_rate_pct: number; par60_rate_pct: number
  avg_credit_score: number; total_book_kobo: number; total_active_loans: number
}
interface EyeKPIs {
  scored_today: number; avg_score_month: number; high_risk_count: number; requests_month: number
}
interface PARPoint { month: string; par30_kobo: number; par60_kobo: number; par90_kobo: number }
interface BandRow  { band: string; count: number; pct: number }
interface SectorRow { sector: string; book_pct: number }
interface EmployerRow {
  company: string; staff_loans_count: number; book_kobo: number; pct_of_total: number; par30_count: number
}

// ── Colour helpers ────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, string> = {
  'Prime': GREEN, 'Near-Prime': BLUE, 'Sub-Prime': AMBER, 'High-Risk': RED,
}
function bandColor(b: string) { return BAND_COLORS[b] ?? NAVY }

function scoreColor(s: number) {
  if (s >= 700) return GREEN; if (s >= 500) return AMBER; if (s > 0) return RED; return 'var(--txt3)'
}

function sectorFill(i: number, total: number) {
  const op = 0.95 - (i / Math.max(total - 1, 1)) * 0.55
  return `rgba(14,40,65,${op.toFixed(2)})`
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function Tip({ active, payload, label, fmt }: {
  active?: boolean; payload?: { name: string; value: number; color: string }[]
  label?: string; fmt?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const f = fmt ?? String
  return (
    <div style={{
      background: '#0E2841', borderRadius: RADIUS.lg, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {label && <div style={{ fontSize: 9.5, fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: .5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{f(p.value)}</span>
          {p.name && payload.length > 1 && <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.4)', fontFamily: SORA }}>{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

// ── Employer table ────────────────────────────────────────────────────────────

const empCols: TableCol<EmployerRow>[] = [
  {
    key: 'company', label: 'Employer', sortable: true,
    render: r => <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.company}</span>,
  },
  {
    key: 'staff_loans_count', label: 'Loans', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtNum(r.staff_loans_count)}</span>,
  },
  {
    key: 'book_kobo', label: 'Exposure', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKobo(r.book_kobo)}</span>,
  },
  {
    key: 'pct_of_total', label: '% of Book', align: 'right', sortable: true,
    render: r => {
      const pct = Number(r.pct_of_total)
      const color = pct > 20 ? RED : pct > 10 ? AMBER : NAVY
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <div style={{ width: 56, height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3, width: `${Math.min(100, pct)}%`, background: color }} />
          </div>
          <span style={{ ...NUM, fontSize: TEXT.sm, minWidth: 38, textAlign: 'right', color, fontWeight: pct > 20 ? FW.bold : FW.normal }}>
            {fmtPct(pct)}
          </span>
        </div>
      )
    },
  },
  {
    key: 'par30_count', label: 'PAR30', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: r.par30_count > 0 ? AMBER : 'var(--txt3)' }}>{r.par30_count > 0 ? r.par30_count : '—'}</span>,
  },
]

// ── Main ──────────────────────────────────────────────────────────────────────

export default function RiskOverview() {
  const navigate = useNavigate()

  const [reviewKPIs,    setReviewKPIs]    = useState<ReviewKPIs | null>(null)
  const [portfolioKPIs, setPortfolioKPIs] = useState<PortfolioKPIs | null>(null)
  const [eyeKPIs,       setEyeKPIs]       = useState<EyeKPIs | null>(null)
  const [parTrend,      setParTrend]      = useState<PARPoint[]>([])
  const [bands,         setBands]         = useState<BandRow[]>([])
  const [sectors,       setSectors]       = useState<SectorRow[]>([])
  const [employers,     setEmployers]     = useState<EmployerRow[]>([])
  const [empSearch,     setEmpSearch]     = useState('')
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [rk, pk, ek, pt, bd, sc, em] = await Promise.all([
        apiFetch<{ data: ReviewKPIs    }>('/api/risk/review-kpis'),
        apiFetch<{ data: PortfolioKPIs }>('/api/risk/portfolio-kpis'),
        apiFetch<{ data: EyeKPIs       }>('/api/risk/eye-kpis'),
        apiFetch<{ data: PARPoint[]    }>('/api/risk/par-trend').catch(() => ({ data: [] })),
        apiFetch<{ data: BandRow[]     }>('/api/risk/band-distribution'),
        apiFetch<{ data: SectorRow[]   }>('/api/risk/sector-concentration'),
        apiFetch<{ data: EmployerRow[] }>('/api/risk/top-employers'),
      ])
      setReviewKPIs(rk.data); setPortfolioKPIs(pk.data); setEyeKPIs(ek.data)
      setParTrend(Array.isArray(pt.data) ? pt.data : [])
      setBands(Array.isArray(bd.data) ? bd.data : [])
      setSectors(Array.isArray(sc.data) ? sc.data : [])
      setEmployers(Array.isArray(em.data) ? em.data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['loans'] })

  const approvalRate = reviewKPIs
    ? (reviewKPIs.approved + reviewKPIs.declined > 0
      ? Math.round(100 * reviewKPIs.approved / (reviewKPIs.approved + reviewKPIs.declined))
      : 0)
    : null

  const totalBandCount = bands.reduce((s, b) => s + b.count, 0)
  const concentrationAlerts = employers.filter(e => Number(e.pct_of_total) > 20)
  const filteredEmployers = empSearch
    ? employers.filter(e => e.company.toLowerCase().includes(empSearch.toLowerCase()))
    : employers

  function exportCsv() {
    apiExport('/api/risk/top-employers/export', 'employer-exposure.csv')
  }

  if (loading) return (
    <Page title="Overview">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  return (
    <Page title="Overview" subtitle="Portfolio quality, delinquency, concentration and scoring at a glance">
      <ErrBanner error={error} onRetry={load} />

      {/* Pending review alert */}
      {(reviewKPIs?.pending ?? 0) > 0 && (
        <div onClick={() => navigate('/operations/risk/applications')} style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: SP[4],
          padding: `${SP[2]} ${SP[4]}`,
          background: `${AMBER}10`, border: `1px solid ${AMBER}40`, borderRadius: RADIUS.md, cursor: 'pointer',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER }}>pending_actions</span>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER }}>
            {reviewKPIs?.pending} application{reviewKPIs?.pending !== 1 ? 's' : ''} awaiting risk review
          </span>
          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: AMBER, fontWeight: FW.semibold }}>Review now →</span>
        </div>
      )}

      {/* Concentration breach alerts */}
      {concentrationAlerts.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: SP[4],
          padding: `${SP[2]} ${SP[4]}`,
          background: `${RED}08`, border: `1px solid ${RED}30`, borderRadius: RADIUS.md,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED, flexShrink: 0, marginTop: 1 }}>corporate_fare</span>
          <div>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED }}>
              Employer concentration breach{concentrationAlerts.length > 1 ? 'es' : ''}
            </span>
            {concentrationAlerts.map(e => (
              <div key={e.company} style={{ fontSize: TEXT.xs, color: RED, marginTop: 2 }}>
                {e.company} — {fmtPct(e.pct_of_total)} of book · Policy limit 20%
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 8-KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Active Book"    value={portfolioKPIs ? fmtKobo(portfolioKPIs.total_book_kobo) : '—'} sub={portfolioKPIs ? `${fmtNum(portfolioKPIs.total_active_loans)} loans` : undefined} icon="account_balance_wallet" accent={NAVY} />
        <KpiCard label="NPL Ratio"      value={portfolioKPIs ? `${portfolioKPIs.npl_ratio_pct}%` : '—'} sub="DPD > 90 days" icon="trending_down" accent={(portfolioKPIs?.npl_ratio_pct ?? 0) > 5 ? RED : (portfolioKPIs?.npl_ratio_pct ?? 0) > 2 ? AMBER : GREEN} />
        <KpiCard label="PAR 30"         value={portfolioKPIs ? `${portfolioKPIs.par30_rate_pct}%` : '—'} sub="DPD > 30 days" icon="schedule" accent={(portfolioKPIs?.par30_rate_pct ?? 0) > 10 ? RED : (portfolioKPIs?.par30_rate_pct ?? 0) > 5 ? AMBER : GREEN} />
        <KpiCard label="PAR 60"         value={portfolioKPIs ? `${portfolioKPIs.par60_rate_pct}%` : '—'} sub="DPD > 60 days" icon="warning_amber" accent={(portfolioKPIs?.par60_rate_pct ?? 0) > 7 ? RED : (portfolioKPIs?.par60_rate_pct ?? 0) > 3 ? AMBER : GREEN} />
        <KpiCard label="Pending Review" value={String(reviewKPIs?.pending ?? '—')} sub="Awaiting decision" icon="pending_actions" accent={(reviewKPIs?.pending ?? 0) > 0 ? AMBER : GREEN} />
        <KpiCard label="Approval Rate"  value={approvalRate !== null ? `${approvalRate}%` : '—'} sub={reviewKPIs ? `${reviewKPIs.approved} of ${reviewKPIs.approved + reviewKPIs.declined} decided` : undefined} icon="check_circle" accent={(approvalRate ?? 0) >= 70 ? GREEN : (approvalRate ?? 0) >= 50 ? AMBER : RED} />
        <KpiCard label="High-Risk Loans" value={String(eyeKPIs?.high_risk_count ?? '—')} sub="Eye band: High-Risk" icon="error_outline" accent={(eyeKPIs?.high_risk_count ?? 0) > 0 ? RED : GREEN} />
        <KpiCard label="Avg Eye Score"  value={portfolioKPIs ? String(portfolioKPIs.avg_credit_score) : '—'} sub="Active book" icon="psychology" accent={scoreColor(portfolioKPIs?.avg_credit_score ?? 0)} />
      </div>

      {/* Charts row 1 — PAR area trend + risk band donut */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>

        {/* PAR area trend — 12 months */}
        <SectionCard title="PAR Trend — 12 Months" subtitle="Outstanding balance in each delinquency band">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={parTrend} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <defs>
                <linearGradient id="par30g" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={AMBER} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={AMBER} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="par60g" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={RED} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={RED} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="par90g" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={DARKRED} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={DARKRED} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickFormatter={v => fmtKobo(v)} width={68} />
              <Tooltip content={(p: any) => <Tip {...p} fmt={fmtKobo} />} />
              <Area type="monotone" dataKey="par30_kobo" name="PAR30" stroke={AMBER}   strokeWidth={2} fill="url(#par30g)" dot={false} />
              <Area type="monotone" dataKey="par60_kobo" name="PAR60" stroke={RED}     strokeWidth={2} fill="url(#par60g)" dot={false} />
              <Area type="monotone" dataKey="par90_kobo" name="PAR90" stroke={DARKRED} strokeWidth={2} fill="url(#par90g)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, justifyContent: 'flex-end' }}>
            {([[AMBER,'PAR30'],[RED,'PAR60'],[DARKRED,'PAR90']] as const).map(([c,l]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                <div style={{ width: 16, height: 2.5, borderRadius: 2, background: c }} />{l}
              </div>
            ))}
          </div>
        </SectionCard>

        {/* Risk band donut */}
        <SectionCard title="Risk Band Distribution" subtitle="Active loan book scored by Eye">
          {bands.length === 0 ? (
            <div style={{ padding: `${SP[6]} 0`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No scored loans</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <PieChart width={148} height={148}>
                  <Pie data={bands} cx={70} cy={70} innerRadius={42} outerRadius={66} dataKey="count" nameKey="band" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                    {bands.map(b => <Cell key={b.band} fill={bandColor(b.band)} />)}
                  </Pie>
                  <Tooltip content={(p: any) => <Tip {...p} fmt={fmtNum} />} />
                </PieChart>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                  <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, lineHeight: 1 }}>{fmtNum(totalBandCount)}</div>
                  <div style={{ fontSize: 9, color: 'var(--txt2)', marginTop: 2 }}>loans</div>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {bands.map(b => (
                  <div key={b.band} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: RADIUS.xs, background: bandColor(b.band), flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{b.band}</span>
                    <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: bandColor(b.band) }}>{fmtPct(b.pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Sector concentration bar */}
      <SectionCard title="Sector Concentration" subtitle="Top 8 sectors by share of active loan book — flag any exceeding 30%" style={{ marginBottom: SP[4] }}>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={sectors.slice(0, 8)} margin={{ top: 4, right: 8, bottom: 4, left: -18 }} barCategoryGap="28%">
            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} />
            <XAxis dataKey="sector" tick={{ fontSize: 9.5, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} interval={0} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
            <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v.toFixed(1)}%`} />} />
            <Bar dataKey="book_pct" name="% of Book" radius={[4, 4, 0, 0]}>
              {sectors.slice(0, 8).map((_, i) => <Cell key={i} fill={sectorFill(i, Math.min(sectors.length, 8))} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </SectionCard>

      {/* Top employers */}
      <SectionCard
        title="Top Employers by Exposure"
        subtitle="Concentration policy: no single employer to exceed 20% of active book"
        badge={filteredEmployers.length}
        padding={false}
        actions={
          <button onClick={exportCsv} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export
          </button>
        }
      >
        <ExpandableFilterBar search={empSearch} onSearch={setEmpSearch} groups={[]} onReset={() => setEmpSearch('')} resultCount={filteredEmployers.length} totalCount={employers.length} />
        <DataTable cols={empCols} rows={filteredEmployers} keyFn={(r, i) => r.company ?? i} emptyText="No employer data" pageSize={15} />
      </SectionCard>
    </Page>
  )
}
