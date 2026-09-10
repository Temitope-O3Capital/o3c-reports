import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { EBar, EDonut } from '../../components/echarts'
import { Page, KpiCard, SectionCard, ErrBanner, Spinner, DataTable, ExpandableFilterBar } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { DpdBar } from '../../components/DpdBar'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtPct, fmtNum } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, NUM } from '../../lib/design'
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
interface Disbursements {
  count_mtd: number; kobo_mtd: number; count_ytd: number; kobo_ytd: number
  count_total: number; kobo_total: number
  by_month: { month: string; count: number; kobo: number }[]
}
interface DpdBucketRow { bucket: string; count: number; kobo: number }
interface BandRow  { band: string; count: number; pct: number }
interface SectorRow { sector: string; sector_code: string; loan_count: number; book_kobo: number; book_pct: number }
interface ConcentrationRow {
  company: string; applicant_cif?: string
  staff_loans_count: number; book_kobo: number; pct_of_total: number; par30_count: number
}

// Single-obligor concentration limit — belongs in a risk-appetite settings table
// once the policy engine exists; hardcoded here as it was before.
const CONCENTRATION_LIMIT_PCT = 20

function sectorFill(i: number, total: number) {
  const op = 0.95 - (i / Math.max(total - 1, 1)) * 0.55
  return `rgba(14,40,65,${op.toFixed(2)})`
}

// Compact naira for chart axes (values arrive in kobo).
function kAxis(kobo: number): string {
  const n = kobo / 100
  if (Math.abs(n) >= 1e9) return `₦${(n / 1e9).toFixed(1)}b`
  if (Math.abs(n) >= 1e6) return `₦${(n / 1e6).toFixed(0)}m`
  if (Math.abs(n) >= 1e3) return `₦${(n / 1e3).toFixed(0)}k`
  return n ? `₦${n.toFixed(0)}` : ''
}

// Concentration table. When origination is not live the rows are BORROWERS off the
// live CBS book, not employers — the header follows the basis the API reports.
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
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKoboExact(r.book_kobo)}</span>,
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
          <span style={{ ...NUM, fontSize: TEXT.sm, minWidth: 42, textAlign: 'right', color, fontWeight: breach ? FW.bold : FW.normal }}>
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
  const [dpd,           setDpd]           = useState<DpdBucketRow[]>([])
  const [disb,          setDisb]          = useState<Disbursements | null>(null)
  const [bands,         setBands]         = useState<BandRow[]>([])
  const [sectors,       setSectors]       = useState<SectorRow[]>([])
  const [concentration, setConcentration] = useState<ConcentrationRow[]>([])
  const [concBasis,     setConcBasis]     = useState<string>('obligor')
  const [empSearch,     setEmpSearch]     = useState('')
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [rk, pk, ek, dp, bd, sc, em, di] = await Promise.all([
        apiFetch<{ data: ReviewKPIs    }>('/api/risk/review-kpis'),
        apiFetch<{ data: PortfolioKPIs }>('/api/risk/portfolio-kpis'),
        apiFetch<{ data: EyeKPIs       }>('/api/risk/eye-kpis'),
        apiFetch<{ data: DpdBucketRow[] }>('/api/risk/dpd-distribution').catch(() => ({ data: [] })),
        apiFetch<{ data: BandRow[]     }>('/api/risk/band-distribution'),
        apiFetch<{ data: SectorRow[]   }>('/api/risk/sector-concentration'),
        apiFetch<{ data: { basis: string; rows: ConcentrationRow[] } }>('/api/risk/top-employers'),
        apiFetch<{ data: Disbursements }>('/api/risk/disbursements').catch(() => ({ data: null })),
      ])
      setReviewKPIs(rk.data); setPortfolioKPIs(pk.data); setEyeKPIs(ek.data)
      setDisb(di.data ?? null)
      setDpd(Array.isArray(dp.data) ? dp.data : [])
      setBands(Array.isArray(bd.data) ? bd.data : [])
      setSectors(Array.isArray(sc.data) ? sc.data : [])
      setConcBasis(em.data?.basis ?? 'obligor')
      setConcentration(Array.isArray(em.data?.rows) ? em.data.rows : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['loans'] })

  const originationLive = reviewKPIs?.origination_live !== false

  const approvalRate = reviewKPIs
    ? (reviewKPIs.approved + reviewKPIs.declined > 0
      ? Math.round(100 * reviewKPIs.approved / (reviewKPIs.approved + reviewKPIs.declined))
      : 0)
    : null

  const totalBandCount = bands.reduce((s, b) => s + Number(b.count), 0)
  const concentrationAlerts = concentration.filter(e => Number(e.pct_of_total) > CONCENTRATION_LIMIT_PCT)
  const filteredConcentration = empSearch
    ? concentration.filter(e => e.company.toLowerCase().includes(empSearch.toLowerCase()))
    : concentration
  const concLabel = concBasis === 'employer' ? 'Employer' : 'Borrower'
  const concCols = concentrationCols(concBasis)

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
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: SP[3],
          padding: `${SP[2]} ${SP[4]}`, background: `${AMBER}10`, border: `1px solid ${AMBER}40`, borderRadius: RADIUS.md, cursor: 'pointer',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER }}>pending_actions</span>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER }}>
            {reviewKPIs?.pending} application{reviewKPIs?.pending !== 1 ? 's' : ''} awaiting risk review
          </span>
          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: AMBER, fontWeight: FW.semibold }}>Review now</span>
        </div>
      )}

      {/* Concentration breach alerts */}
      {concentrationAlerts.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: SP[3],
          padding: `${SP[2]} ${SP[4]}`, background: `${RED}08`, border: `1px solid ${RED}30`, borderRadius: RADIUS.md,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED, flexShrink: 0, marginTop: 1 }}>corporate_fare</span>
          <div>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED }}>
              {concLabel} concentration breach{concentrationAlerts.length > 1 ? 'es' : ''}
            </span>
            {concentrationAlerts.map(e => (
              <div key={e.company} style={{ fontSize: TEXT.xs, color: RED, marginTop: 2 }}>
                {e.company}: {fmtPct(e.pct_of_total)} of book · policy limit {CONCENTRATION_LIMIT_PCT}%
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Origination not live note */}
      {!originationLive && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: SP[3],
          padding: `${SP[2]} ${SP[4]}`, background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)', flexShrink: 0, marginTop: 1 }}>info</span>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--txt)' }}>No applications in the pipeline yet.</strong>{' '}
            Pending Review, Approval Rate and High-Risk Loans read "n/a" until the first application is raised here
            or synced from Phoenix. Portfolio, delinquency and concentration below are live off the Udara book.
          </div>
        </div>
      )}

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Active Book"    value={portfolioKPIs ? fmtKoboExact(portfolioKPIs.total_book_kobo) : '—'} sub={portfolioKPIs ? `${fmtNum(portfolioKPIs.total_active_loans)} loans` : undefined} icon="account_balance_wallet" accent={NAVY} />
        <KpiCard label="NPL Ratio"      value={portfolioKPIs ? fmtPct(portfolioKPIs.npl_ratio_pct) : '—'} sub="DPD > 90 days" icon="trending_down" accent={(portfolioKPIs?.npl_ratio_pct ?? 0) > 5 ? RED : (portfolioKPIs?.npl_ratio_pct ?? 0) > 2 ? AMBER : GREEN} />
        <KpiCard label="PAR 30"         value={portfolioKPIs ? fmtPct(portfolioKPIs.par30_rate_pct) : '—'} sub="DPD > 30 days" icon="schedule" accent={(portfolioKPIs?.par30_rate_pct ?? 0) > 10 ? RED : (portfolioKPIs?.par30_rate_pct ?? 0) > 5 ? AMBER : GREEN} />
        <KpiCard label="Total Arrears"  value={portfolioKPIs ? fmtKoboExact(portfolioKPIs.total_arrears_kobo) : '—'} sub="behind schedule" icon="warning_amber" accent={(portfolioKPIs?.total_arrears_kobo ?? 0) > 0 ? AMBER : GREEN} />
        {originationLive ? (
          <>
            <KpiCard label="Pending Review" value={String(reviewKPIs?.pending ?? '—')} sub="awaiting decision" icon="pending_actions" accent={(reviewKPIs?.pending ?? 0) > 0 ? AMBER : GREEN} />
            <KpiCard label="Approval Rate"  value={approvalRate !== null ? `${approvalRate}%` : '—'} sub={reviewKPIs ? `${reviewKPIs.approved} of ${reviewKPIs.approved + reviewKPIs.declined} decided` : undefined} icon="check_circle" accent={(approvalRate ?? 0) >= 70 ? GREEN : (approvalRate ?? 0) >= 50 ? AMBER : RED} />
            <KpiCard label="High-Risk Loans" value={String(eyeKPIs?.high_risk_count ?? '—')} sub="Eye band: High-Risk" icon="error_outline" accent={(eyeKPIs?.high_risk_count ?? 0) > 0 ? RED : GREEN} />
          </>
        ) : (
          <>
            <KpiCard label="Pending Review"  value="n/a" sub="origination not live" icon="pending_actions" accent={NAVY} />
            <KpiCard label="Approval Rate"   value="n/a" sub="origination not live" icon="check_circle"    accent={NAVY} />
            <KpiCard label="Top Exposure"    value={portfolioKPIs ? fmtKoboExact(portfolioKPIs.top_obligor_exposure_kobo) : '—'} sub={`largest single ${concLabel.toLowerCase()}`} icon="corporate_fare" accent={NAVY} />
          </>
        )}
        <KpiCard label="Avg Risk Score"  value={fmtScore(portfolioKPIs?.avg_credit_score)} sub="active book · 0-100" icon="psychology" accent={scoreColor(portfolioKPIs?.avg_credit_score)} />
      </div>

      {/* Origination & Disbursements — applications/approvals feed from Phoenix
          (empty until live); disbursements are the live booked book, by start_date. */}
      <SectionCard title="Origination & Disbursements" subtitle="Applications and approvals arrive from Phoenix · disbursements are the live booked book" style={{ marginBottom: SP[4] }}>
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[4], alignItems: 'stretch' }}>
          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>Disbursements · last 12 months</div>
            {(!disb || disb.by_month.length === 0) ? (
              <div style={{ padding: '52px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No disbursement history</div>
            ) : (
              <EBar
                data={disb.by_month} xKey="month" series={[{ key: 'kobo', name: 'Disbursed', color: NAVY }]}
                height={190} valueFmt={(v) => fmtKoboExact(v)} axisFmt={(v) => kAxis(v)} xTickSize={9.5}
              />
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, justifyContent: 'center' }}>
            {[
              { label: 'Disbursed (MTD)', value: disb ? fmtKoboExact(Number(disb.kobo_mtd)) : '—', sub: disb ? `${fmtNum(Number(disb.count_mtd))} loans booked` : '' },
              { label: 'Disbursed (YTD)', value: disb ? fmtKoboExact(Number(disb.kobo_ytd)) : '—', sub: disb ? `${fmtNum(Number(disb.count_ytd))} loans booked` : '' },
              { label: 'Applications pending', value: originationLive ? String(reviewKPIs?.pending ?? 0) : 'n/a', sub: originationLive ? 'awaiting decision' : 'origination not live' },
              { label: 'Approval rate', value: originationLive && approvalRate !== null ? `${approvalRate}%` : 'n/a', sub: originationLive ? `${reviewKPIs?.approved ?? 0} approved to date` : 'origination not live' },
            ].map(s => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
                <div>
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{s.label}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{s.sub}</div>
                </div>
                <span style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      {/* Delinquency distribution — the honest headline for a small book */}
      <SectionCard title="Delinquency Distribution" subtitle="Active book by days past due (schedule-derived DPD)" style={{ marginBottom: SP[4] }}>
        {dpd.length === 0
          ? <div style={{ padding: `${SP[6]} 0`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No active loans</div>
          : <DpdBar buckets={dpd} height={44} />}
      </SectionCard>

      {/* Band donut + Sector bar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Risk Band Distribution" subtitle="Active book, A (Prime) to E (High-Risk)">
          {bands.length === 0 ? (
            <div style={{ padding: `${SP[6]} 0`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No scored loans</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
              <div style={{ flexShrink: 0, width: 148 }}>
                <EDonut
                  data={bands} valueKey="count" nameKey="band"
                  colorFn={(b) => bandColor(b.band)}
                  size={148} inner={42} outer={66}
                  centerValue={fmtNum(totalBandCount)} centerLabel="loans"
                  valueFmt={(v) => fmtNum(v)} nameFmt={(b) => bandLabel(b)}
                />
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

        <SectionCard title="Sector Concentration" subtitle="Top sectors by share of active book">
          {sectors.length === 0 ? (
            <div style={{ padding: `${SP[6]} 0`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No sector data</div>
          ) : (
            <EBar
              data={sectors.slice(0, 8)} xKey="sector"
              series={[{ key: 'book_pct', name: '% of Book', colorFn: (_, i) => sectorFill(i, Math.min(sectors.length, 8)) }]}
              height={200} valueFmt={(v) => `${v.toFixed(1)}%`} axisFmt={(v) => `${v}%`} xTickSize={9.5}
            />
          )}
        </SectionCard>
      </div>

      {/* Concentration — employer when origination is live, otherwise single-obligor */}
      <SectionCard
        title={`Top ${concLabel}s by Exposure`}
        subtitle={`Concentration policy: no single ${concLabel.toLowerCase()} to exceed ${CONCENTRATION_LIMIT_PCT}% of active book`}
        badge={filteredConcentration.length}
        padding={false}
      >
        <ExpandableFilterBar search={empSearch} onSearch={setEmpSearch} groups={[]} onReset={() => setEmpSearch('')} resultCount={filteredConcentration.length} totalCount={concentration.length} />
        <DataTable cols={concCols} rows={filteredConcentration} keyFn={(r, i) => r.applicant_cif ?? r.company ?? i} emptyText={`No ${concLabel.toLowerCase()} data`} pageSize={15} />
      </SectionCard>
    </Page>
  )
}
