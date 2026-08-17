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
import { bandColor, bandLabel, scoreColor, fmtScore } from '../../lib/riskScale'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReviewKPIs {
  reviewed: number; approved: number; declined: number; pending: number
  origination_live?: boolean
}
interface PortfolioKPIs {
  npl_ratio_pct: number; par30_rate_pct: number; par60_rate_pct: number
  avg_credit_score: number; total_book_kobo: number; total_active_loans: number
  total_arrears_kobo: number; top_obligor_exposure_kobo: number
}
interface EyeKPIs {
  scored_today: number; avg_score_month: number; high_risk_count: number; requests_month: number
  origination_live?: boolean
}
interface PARPoint { month: string; par30_kobo: number; par60_kobo: number; par90_kobo: number }
interface BandRow  { band: string; count: number; pct: number }
interface SectorRow { sector: string; sector_code: string; loan_count: number; book_kobo: number; book_pct: number }
/** Concentration row. `basis` decides whether `company` is an employer or a borrower. */
interface ConcentrationRow {
  company: string; applicant_cif?: string
  staff_loans_count: number; book_kobo: number; pct_of_total: number; par30_count: number
}

// ── Colour helpers ────────────────────────────────────────────────────────────
// bandColor / scoreColor / bandLabel now come from lib/riskScale — this page used to
// declare its own Prime/Near-Prime map against an API that emits A-E, so the donut
// rendered a single flat NAVY and the legend read "A, B, C, E".

// Single-obligor concentration limit. Hardcoded here as it was before; it belongs in
// a risk-appetite settings table once the policy engine exists.
const CONCENTRATION_LIMIT_PCT = 20

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

// ── Concentration table ───────────────────────────────────────────────────────
// The column header follows the basis the API reports. When origination is not live
// the rows are BORROWERS off the live CBS book, not employers — showing those under
// an "Employer" heading is how this table used to lie when it had data at all.

function concentrationCols(basis: string): TableCol<ConcentrationRow>[] { return [
  {
    key: 'company', label: basis === 'employer' ? 'Employer' : 'Borrower', sortable: true,
    render: r => (
      <div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.company}</div>
        {r.applicant_cif && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.applicant_cif}</div>}
      </div>
    ),
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
      const breach = pct > CONCENTRATION_LIMIT_PCT
      const color = breach ? RED : pct > CONCENTRATION_LIMIT_PCT / 2 ? AMBER : NAVY
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <div style={{ width: 56, height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3, width: `${Math.min(100, pct)}%`, background: color }} />
          </div>
          <span style={{ ...NUM, fontSize: TEXT.sm, minWidth: 38, textAlign: 'right', color, fontWeight: breach ? FW.bold : FW.normal }}>
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
]}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function RiskOverview() {
  const navigate = useNavigate()

  const [reviewKPIs,    setReviewKPIs]    = useState<ReviewKPIs | null>(null)
  const [portfolioKPIs, setPortfolioKPIs] = useState<PortfolioKPIs | null>(null)
  const [eyeKPIs,       setEyeKPIs]       = useState<EyeKPIs | null>(null)
  const [parTrend,      setParTrend]      = useState<PARPoint[]>([])
  const [bands,         setBands]         = useState<BandRow[]>([])
  const [sectors,       setSectors]       = useState<SectorRow[]>([])
  const [concentration, setConcentration] = useState<ConcentrationRow[]>([])
  const [concBasis,     setConcBasis]     = useState<string>('obligor')
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
        apiFetch<{ data: { basis: string; rows: ConcentrationRow[] } }>('/api/risk/top-employers'),
      ])
      setReviewKPIs(rk.data); setPortfolioKPIs(pk.data); setEyeKPIs(ek.data)
      setParTrend(Array.isArray(pt.data) ? pt.data : [])
      setBands(Array.isArray(bd.data) ? bd.data : [])
      setSectors(Array.isArray(sc.data) ? sc.data : [])
      setConcBasis(em.data?.basis ?? 'obligor')
      setConcentration(Array.isArray(em.data?.rows) ? em.data.rows : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['loans'] })

  // Origination is not live on this deployment, so review/eye KPIs are structurally
  // zero rather than "a quiet day". The API says which, and the page says so too
  // instead of showing a confident 0% approval rate off an empty table.
  const originationLive = reviewKPIs?.origination_live !== false

  const approvalRate = reviewKPIs
    ? (reviewKPIs.approved + reviewKPIs.declined > 0
      ? Math.round(100 * reviewKPIs.approved / (reviewKPIs.approved + reviewKPIs.declined))
      : 0)
    : null

  const totalBandCount = bands.reduce((s, b) => s + b.count, 0)
  const concentrationAlerts = concentration.filter(e => Number(e.pct_of_total) > CONCENTRATION_LIMIT_PCT)
  const filteredConcentration = empSearch
    ? concentration.filter(e => e.company.toLowerCase().includes(empSearch.toLowerCase()))
    : concentration
  const concLabel = concBasis === 'employer' ? 'Employer' : 'Borrower'
  const concCols = concentrationCols(concBasis)

  function exportCsv() {
    apiExport('/api/risk/top-employers/export', `${concBasis}-concentration.csv`)
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
              {concLabel} concentration breach{concentrationAlerts.length > 1 ? 'es' : ''}
            </span>
            {concentrationAlerts.map(e => (
              <div key={e.company} style={{ fontSize: TEXT.xs, color: RED, marginTop: 2 }}>
                {e.company} — {fmtPct(e.pct_of_total)} of book · Policy limit {CONCENTRATION_LIMIT_PCT}%
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Origination not live — say so once, rather than three KPIs quietly reading 0 */}
      {!originationLive && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: SP[4],
          padding: `${SP[2]} ${SP[4]}`,
          background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)', flexShrink: 0, marginTop: 1 }}>info</span>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--txt)' }}>No applications in the pipeline yet.</strong>{' '}
            Pending Review, Approval Rate and High-Risk Loans read “n/a” rather than zero
            until the first application is raised here or synced from Phoenix. Portfolio,
            delinquency and concentration figures below are live off the Udara book.
          </div>
        </div>
      )}

      {/* 8-KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Active Book"    value={portfolioKPIs ? fmtKobo(portfolioKPIs.total_book_kobo) : '—'} sub={portfolioKPIs ? `${fmtNum(portfolioKPIs.total_active_loans)} loans` : undefined} icon="account_balance_wallet" accent={NAVY} />
        <KpiCard label="NPL Ratio"      value={portfolioKPIs ? `${portfolioKPIs.npl_ratio_pct}%` : '—'} sub="DPD > 90 days" icon="trending_down" accent={(portfolioKPIs?.npl_ratio_pct ?? 0) > 5 ? RED : (portfolioKPIs?.npl_ratio_pct ?? 0) > 2 ? AMBER : GREEN} />
        <KpiCard label="PAR 30"         value={portfolioKPIs ? `${portfolioKPIs.par30_rate_pct}%` : '—'} sub="DPD > 30 days" icon="schedule" accent={(portfolioKPIs?.par30_rate_pct ?? 0) > 10 ? RED : (portfolioKPIs?.par30_rate_pct ?? 0) > 5 ? AMBER : GREEN} />
        <KpiCard label="Total Arrears"  value={portfolioKPIs ? fmtKobo(portfolioKPIs.total_arrears_kobo) : '—'} sub="Behind schedule" icon="warning_amber" accent={(portfolioKPIs?.total_arrears_kobo ?? 0) > 0 ? AMBER : GREEN} />
        {originationLive ? (
          <>
            <KpiCard label="Pending Review" value={String(reviewKPIs?.pending ?? '—')} sub="Awaiting decision" icon="pending_actions" accent={(reviewKPIs?.pending ?? 0) > 0 ? AMBER : GREEN} />
            <KpiCard label="Approval Rate"  value={approvalRate !== null ? `${approvalRate}%` : '—'} sub={reviewKPIs ? `${reviewKPIs.approved} of ${reviewKPIs.approved + reviewKPIs.declined} decided` : undefined} icon="check_circle" accent={(approvalRate ?? 0) >= 70 ? GREEN : (approvalRate ?? 0) >= 50 ? AMBER : RED} />
            <KpiCard label="High-Risk Loans" value={String(eyeKPIs?.high_risk_count ?? '—')} sub="Eye band: High-Risk" icon="error_outline" accent={(eyeKPIs?.high_risk_count ?? 0) > 0 ? RED : GREEN} />
          </>
        ) : (
          <>
            <KpiCard label="Pending Review"  value="n/a" sub="Origination not live" icon="pending_actions" accent={NAVY} />
            <KpiCard label="Approval Rate"   value="n/a" sub="Origination not live" icon="check_circle"    accent={NAVY} />
            <KpiCard label="Top Exposure"    value={portfolioKPIs ? fmtKobo(portfolioKPIs.top_obligor_exposure_kobo) : '—'} sub={`Largest single ${concLabel.toLowerCase()}`} icon="corporate_fare" accent={NAVY} />
          </>
        )}
        <KpiCard label="Avg Risk Score"  value={fmtScore(portfolioKPIs?.avg_credit_score)} sub="Active book · 0-100" icon="psychology" accent={scoreColor(portfolioKPIs?.avg_credit_score)} />
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
        <SectionCard title="Risk Band Distribution" subtitle="Active book, banded A (Prime) → E (High-Risk)">
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
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{bandLabel(b.band)}</span>
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

      {/* Concentration — employer when origination is live, otherwise single-obligor */}
      <SectionCard
        title={`Top ${concLabel}s by Exposure`}
        subtitle={`Concentration policy: no single ${concLabel.toLowerCase()} to exceed ${CONCENTRATION_LIMIT_PCT}% of active book`}
        badge={filteredConcentration.length}
        padding={false}
        actions={
          <button onClick={exportCsv} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export
          </button>
        }
      >
        <ExpandableFilterBar search={empSearch} onSearch={setEmpSearch} groups={[]} onReset={() => setEmpSearch('')} resultCount={filteredConcentration.length} totalCount={concentration.length} />
        <DataTable cols={concCols} rows={filteredConcentration} keyFn={(r, i) => r.applicant_cif ?? r.company ?? i} emptyText={`No ${concLabel.toLowerCase()} data`} pageSize={15} />
      </SectionCard>
    </Page>
  )
}
