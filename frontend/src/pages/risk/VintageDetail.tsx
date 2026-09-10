import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, ErrBanner, DataTable } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtPct, fmtNum, fmtDate } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, DARKRED, AMBER, GREEN, BLUE, INTER, NUM } from '../../lib/design'
import { bandColor, bandLabel, bandShort, scoreColor, fmtScore, dpdColor, dpdLabel, DPD_BUCKETS } from '../../lib/riskScale'
import { EArea, EChart, baseTooltip, tipCard, axisVal, CHART_FONT } from '../../components/echarts'
import type { ChartTokens } from '../../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface HistoricalPAR { age_label: string; par30_pct: number | null }
interface DPDBucket     { label: string; count: number }
interface SectorRow     { sector: string; count: number; book_kobo: number; par30_count: number }
interface ProductRow    { product_type: string; count: number; book_kobo: number; par30_pct: number }
interface LoanRow {
  id: number
  reference: string
  applicant_name: string
  applicant_cif: string
  sector: string
  product_type: string
  outstanding_kobo: number
  dpd: number
  risk_band: string
  eye_score: number | null
  status: string
  maturity_date: string | null
}
interface CohortDetail {
  booking_month:    string
  total_count:      number
  active_count:     number
  active_book_kobo: number
  written_off_count: number
  par30_rate_pct:   number
  par60_rate_pct:   number
  par90_rate_pct:   number
  npl_rate_pct:     number
  avg_eye_score:    number
  historical_par:   HistoricalPAR[]
  dpd_buckets:      DPDBucket[]
  sectors:          SectorRow[]
  products:         ProductRow[]
  loans:            LoanRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// dpdColor / dpdLabel come from lib/riskScale (shared with Portfolio, the Overview
// and the dashboards). The local versions had current = DPD < 30 and NPL = DPD < 180,
// which disagreed with the KPI cards on this very page (NPL there is DPD > 90).

// Bands come from lib/riskScale — the local Prime/Near-Prime map never matched the
// A-E letters this API emits, so every pill fell through to grey.
function BandPill({ band }: { band: string }) {
  if (!band) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>—</span>
  const c = bandColor(band)
  return (
    <span title={bandLabel(band)} style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: `${c}1F`, color: c, whiteSpace: 'nowrap' }}>
      {bandShort(band)}
    </span>
  )
}

const DPD_BUCKET_COLORS: Record<string, string> = {
  'Current': GREEN,
  'PAR30':   AMBER,
  'PAR60':   RED,
  'PAR90':   DARKRED,
  'NPL':     DARKRED,
}

// ── Loan table columns ────────────────────────────────────────────────────────

function loanCols(navigate: ReturnType<typeof useNavigate>): TableCol<LoanRow>[] {
  return [
    {
      key: 'applicant_name', label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.applicant_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.applicant_cif}</div>
        </div>
      ),
    },
    {
      key: 'sector', label: 'Sector',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.sector || '—'}</span>,
    },
    {
      key: 'product_type', label: 'Product',
      render: r => (
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
          {r.product_type || '—'}
        </span>
      ),
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKoboExact(r.outstanding_kobo)}</span>,
    },
    {
      key: 'dpd', label: 'DPD', align: 'right', sortable: true,
      render: r => (
        <div style={{ textAlign: 'right' }}>
          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: dpdColor(Number(r.dpd)) }}>
            {Number(r.dpd)}
          </span>
          <div style={{ fontSize: TEXT.xs, color: dpdColor(Number(r.dpd)), fontWeight: FW.semibold }}>
            {dpdLabel(Number(r.dpd))}
          </div>
        </div>
      ),
    },
    {
      key: 'risk_band', label: 'Band',
      render: r => <BandPill band={r.risk_band} />,
    },
    {
      key: 'eye_score', label: 'Score', align: 'right', sortable: true,
      render: r => (
        <span title={fmtScore(r.eye_score)} style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(r.eye_score) }}>
          {r.eye_score ?? '—'}
        </span>
      ),
    },
    {
      key: 'maturity_date', label: 'Maturity',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{r.maturity_date ? fmtDate(r.maturity_date) : '—'}</span>,
    },
  ]
}

// ── DPD filter button group ───────────────────────────────────────────────────

// Filter chips derived from the shared DPD scale so the buckets, colours and NPL
// cut-off (> 90) match the KPI cards and every other Risk page.
const DPD_FILTERS: { key: string; label: string; color?: string }[] = [
  { key: 'all', label: 'All' },
  ...DPD_BUCKETS.map(b => ({ key: b.key, label: b.short, color: b.color })),
]

function filterByDPD(loans: LoanRow[], key: string): LoanRow[] {
  if (key === 'all') return loans
  return loans.filter(l => {
    const d = Number(l.dpd)
    if (key === 'current') return d <= 0
    if (key === 'par30')   return d >= 1 && d <= 30
    if (key === 'par60')   return d >= 31 && d <= 60
    if (key === 'par90')   return d >= 61 && d <= 90
    if (key === 'npl')     return d > 90
    return true
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function VintageDetail() {
  const { month: rawMonth } = useParams<{ month: string }>()
  const navigate = useNavigate()
  const month = decodeURIComponent(rawMonth ?? '')

  const [detail,  setDetail]  = useState<CohortDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [dpdFilter, setDpdFilter] = useState('all')

  const load = useCallback(async (silent = false) => {
    if (!month) return
    if (!silent) setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: CohortDetail }>(`/api/risk/vintage/${encodeURIComponent(month)}`)
      setDetail(res.data ?? null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load cohort')
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['loans'] })

  const filteredLoans = useMemo(
    () => filterByDPD(detail?.loans ?? [], dpdFilter),
    [detail?.loans, dpdFilter],
  )

  const parChartData = useMemo(
    () => (detail?.historical_par ?? []).filter(p => p.par30_pct !== null),
    [detail?.historical_par],
  )
  function parAccent(v: number): string {
    if (v < 5) return GREEN; if (v <= 15) return AMBER; return RED
  }

  const cols = useMemo(() => loanCols(navigate), [navigate])

  const backBtn = (
    <button
      onClick={() => navigate('/operations/risk/vintage')}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '6px 14px', borderRadius: RADIUS.md,
        border: '1px solid var(--bdr)', background: 'var(--card)',
        color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer',
        fontFamily: INTER,
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_back</span>
      Back to Vintage
    </button>
  )

  return (
    <Page
      title={detail ? `Vintage: ${detail.booking_month}` : 'Vintage Detail'}
      subtitle={detail ? `${fmtNum(detail.total_count)} loans booked in this cohort` : 'Loading cohort…'}
      actions={backBtn}
      loading={loading && !detail}
      skeletonKpis={3}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* ── KPI strip (6 cards, 3×2) ────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard
          label="Total Loans"
          value={loading ? '…' : fmtNum(detail?.total_count ?? 0)}
          loading={false}
          accent={NAVY}
          icon="group"
          sub="All loans in cohort"
        />
        <KpiCard
          label="Active Loans"
          value={loading ? '…' : fmtNum(detail?.active_count ?? 0)}
          loading={false}
          accent={BLUE}
          icon="check_circle"
          sub="Currently active"
        />
        <KpiCard
          label="Active Book"
          value={loading ? '…' : fmtKoboExact(detail?.active_book_kobo ?? 0)}
          loading={false}
          accent={NAVY}
          icon="account_balance_wallet"
          sub="Outstanding principal"
        />
        <KpiCard
          label="PAR30 Rate"
          value={loading ? '…' : fmtPct(detail?.par30_rate_pct ?? 0, 1)}
          loading={false}
          accent={parAccent(detail?.par30_rate_pct ?? 0)}
          icon="warning"
          sub="Loans > 30 DPD"
        />
        <KpiCard
          label="PAR60 Rate"
          value={loading ? '…' : fmtPct(detail?.par60_rate_pct ?? 0, 1)}
          loading={false}
          accent={parAccent(detail?.par60_rate_pct ?? 0)}
          icon="error_outline"
          sub="Loans > 60 DPD"
        />
        <KpiCard
          label="NPL Rate"
          value={loading ? '…' : fmtPct(detail?.npl_rate_pct ?? 0, 1)}
          loading={false}
          accent={detail?.npl_rate_pct ? RED : GREEN}
          icon="block"
          sub="Loans > 90 DPD"
        />
      </div>

      {/* ── Charts row (PAR trajectory + DPD distribution) ──────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        {/* PAR Trajectory */}
        <SectionCard title="PAR Trajectory">
          {parChartData.length === 0 ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
              Not enough cohort age data yet
            </div>
          ) : (
            <EArea
              data={parChartData.map(p => ({ age_label: p.age_label, par30_pct: Number(p.par30_pct) }))}
              xKey="age_label"
              height={200}
              dots
              hideYAxis
              endLabel
              valueFmt={(v) => fmtPct(v, 1)}
              endFmt={(v) => `${v}%`}
              series={[{ key: 'par30_pct', name: 'PAR30', color: AMBER }]}
            />
          )}
        </SectionCard>

        {/* DPD Distribution */}
        <SectionCard title="DPD Distribution">
          {loading || !detail || (detail.dpd_buckets?.length ?? 0) === 0 ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
              {loading ? 'Loading…' : 'No loans in this cohort'}
            </div>
          ) : (
            <EChart
              height={200}
              option={(t: ChartTokens) => ({
                grid: { top: 8, right: 24, bottom: 8, left: 8, containLabel: true },
                tooltip: {
                  trigger: 'item', ...baseTooltip(t),
                  formatter: (p: any) => tipCard(t, String(p.name), [{ color: p.color, name: 'Loans', value: fmtNum(p.value) }]),
                },
                xAxis: { ...axisVal(t, (v: number) => fmtNum(v)), minInterval: 1 },
                yAxis: {
                  type: 'category',
                  inverse: true,
                  data: detail!.dpd_buckets.map(b => b.label),
                  axisLine: { show: false }, axisTick: { show: false },
                  axisLabel: { color: t.lbl, fontSize: 11, fontFamily: CHART_FONT },
                },
                series: [{
                  type: 'bar', name: 'Loans', barMaxWidth: 22,
                  data: detail!.dpd_buckets.map(b => ({
                    value: Number(b.count),
                    itemStyle: { color: DPD_BUCKET_COLORS[b.label] ?? NAVY, borderRadius: [0, 4, 4, 0] },
                  })),
                }],
                animationDuration: 700,
              })}
            />
          )}
        </SectionCard>
      </div>

      {/* ── Breakdown tables (Employers + Products) ──────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        {/* Top Sectors (CBS carries no employer dimension) */}
        <SectionCard title="Top Sectors" badge={detail?.sectors?.length} padding={false}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Sector', 'Loans', 'Book', 'PAR30'].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: h === 'Sector' ? 'left' : 'right',
                      fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
                      borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(loading || !detail) ? (
                  <tr><td colSpan={4} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>Loading…</td></tr>
                ) : detail.sectors.length === 0 ? (
                  <tr><td colSpan={4} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No data</td></tr>
                ) : detail.sectors.map((r, i) => (
                  <tr key={i}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                  >
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.sector}</td>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM }}>{fmtNum(r.count)}</td>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM }}>{fmtKoboExact(r.book_kobo)}</td>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM, color: r.par30_count > 0 ? AMBER : 'var(--txt3)' }}>
                      {fmtNum(r.par30_count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* By Product */}
        <SectionCard title="By Product" badge={detail?.products?.length} padding={false}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Product', 'Loans', 'Book', 'PAR30 Rate'].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: h === 'Product' ? 'left' : 'right',
                      fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
                      borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(loading || !detail) ? (
                  <tr><td colSpan={4} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>Loading…</td></tr>
                ) : detail.products.length === 0 ? (
                  <tr><td colSpan={4} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No data</td></tr>
                ) : detail.products.map((r, i) => {
                  const pct = Number(r.par30_pct)
                  const parColor = pct < 5 ? GREEN : pct <= 15 ? AMBER : RED
                  return (
                    <tr key={i}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                    >
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.product_type}</td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM }}>{fmtNum(r.count)}</td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM }}>{fmtKoboExact(r.book_kobo)}</td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM, color: parColor, fontWeight: FW.semibold }}>
                        {fmtPct(pct, 1)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      {/* ── Loans table ──────────────────────────────────────────────────────── */}
      <SectionCard
        title="Cohort Loans"
        badge={filteredLoans.length}
        padding={false}
        actions={
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {DPD_FILTERS.map(f => {
              const active = dpdFilter === f.key
              return (
                <button
                  key={f.key}
                  onClick={() => setDpdFilter(f.key)}
                  style={{
                    padding: '3px 10px', borderRadius: RADIUS.full, fontSize: TEXT.xs,
                    fontWeight: active ? FW.bold : FW.normal,
                    border: `1px solid ${active ? (f.color ?? NAVY) : 'var(--bdr)'}`,
                    background: active ? `${f.color ?? NAVY}18` : 'transparent',
                    color: active ? (f.color ?? NAVY) : 'var(--txt2)',
                    cursor: 'pointer', fontFamily: INTER, transition: 'all .1s',
                  }}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
        }
      >
        <DataTable
          cols={cols}
          rows={filteredLoans}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          onRowClick={r => navigate(`/operations/risk/applications/${r.id}`)}
          emptyText="No loans match the selected filter"
        />
      </SectionCard>
    </Page>
  )
}
