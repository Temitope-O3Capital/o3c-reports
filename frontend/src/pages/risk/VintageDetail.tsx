import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, ErrBanner, DataTable } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum, fmtDate } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, BLUE, INTER, SORA, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface HistoricalPAR { age_label: string; par30_pct: number | null }
interface DPDBucket     { label: string; count: number }
interface EmployerRow   { employer: string; count: number; book_kobo: number; par30_count: number }
interface ProductRow    { product_type: string; count: number; book_kobo: number; par30_pct: number }
interface LoanRow {
  id: number
  reference: string
  applicant_name: string
  applicant_cif: string
  employer: string
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
  employers:        EmployerRow[]
  products:         ProductRow[]
  loans:            LoanRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dpdColor(dpd: number): string {
  if (dpd < 30)  return GREEN
  if (dpd < 60)  return AMBER
  if (dpd < 90)  return '#B45309'
  return RED
}

function dpdLabel(dpd: number): string {
  if (dpd < 30)   return 'Current'
  if (dpd < 60)   return 'PAR30'
  if (dpd < 90)   return 'PAR60'
  if (dpd < 180)  return 'PAR90'
  return 'NPL'
}

const BAND_COLORS: Record<string, { bg: string; txt: string }> = {
  'Prime':      { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  'Near-Prime': { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  'Sub-Prime':  { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  'High-Risk':  { bg: 'rgba(192,0,0,.10)',    txt: '#C00000' },
}

function BandPill({ band }: { band: string }) {
  if (!band) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>—</span>
  const s = BAND_COLORS[band] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: s.bg, color: s.txt, whiteSpace: 'nowrap' }}>
      {band}
    </span>
  )
}

const DPD_BUCKET_COLORS: Record<string, string> = {
  'Current': GREEN,
  'PAR30':   AMBER,
  'PAR60':   '#B45309',
  'PAR90':   RED,
  'NPL':     '#9B1C1C',
}

// ── Custom Tooltip (dark navy, matches Overview.tsx) ─────────────────────────

function Tip({ active, payload, label, fmt }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  fmt?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const f = fmt ?? String
  return (
    <div style={{
      background: '#0E2841', borderRadius: RADIUS.lg, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {label && (
        <div style={{ fontSize: 9.5, fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: .5, textTransform: 'uppercase' }}>
          {label}
        </div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>
            {f(p.value)}
          </span>
          {p.name && payload.length > 1 && (
            <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.4)', fontFamily: SORA }}>{p.name}</span>
          )}
        </div>
      ))}
    </div>
  )
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
      key: 'employer', label: 'Employer',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.employer || '—'}</span>,
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
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKobo(r.outstanding_kobo)}</span>,
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
      key: 'eye_score', label: 'Eye', align: 'right', sortable: true,
      render: r => {
        const s = r.eye_score
        const c = s === null ? 'var(--txt3)' : s >= 700 ? GREEN : s >= 500 ? AMBER : RED
        return <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: c }}>{s ?? '—'}</span>
      },
    },
    {
      key: 'maturity_date', label: 'Maturity',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{r.maturity_date ? fmtDate(r.maturity_date) : '—'}</span>,
    },
  ]
}

// ── DPD filter button group ───────────────────────────────────────────────────

const DPD_FILTERS = [
  { key: 'all',     label: 'All' },
  { key: 'current', label: 'Current',  color: GREEN      },
  { key: 'par30',   label: 'PAR30',    color: AMBER      },
  { key: 'par60',   label: 'PAR60',    color: '#B45309'  },
  { key: 'par90',   label: 'PAR90',    color: RED        },
  { key: 'npl',     label: 'NPL',      color: '#9B1C1C'  },
]

function filterByDPD(loans: LoanRow[], key: string): LoanRow[] {
  if (key === 'all') return loans
  return loans.filter(l => {
    const d = Number(l.dpd)
    if (key === 'current') return d < 30
    if (key === 'par30')   return d >= 30 && d < 60
    if (key === 'par60')   return d >= 60 && d < 90
    if (key === 'par90')   return d >= 90 && d < 180
    if (key === 'npl')     return d >= 180
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

  const load = useCallback(async () => {
    if (!month) return
    setLoading(true); setError(null)
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
  useLiveData(load, { topics: ['loans'] })

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
      title={detail ? `Vintage — ${detail.booking_month}` : 'Vintage Detail'}
      subtitle={detail ? `${fmtNum(detail.total_count)} loans booked in this cohort` : 'Loading cohort…'}
      actions={backBtn}
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
          value={loading ? '…' : fmtKobo(detail?.active_book_kobo ?? 0)}
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
          sub="Loans ≥ 180 DPD"
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
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={parChartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="vdParGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={AMBER} stopOpacity={0.22} />
                    <stop offset="95%" stopColor={AMBER} stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                <XAxis dataKey="age_label" tick={{ fontSize: 11, fill: 'var(--chart-lbl)', fontFamily: INTER }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--chart-lbl)', fontFamily: INTER }} tickFormatter={v => `${v}%`} />
                <Tooltip content={<Tip fmt={v => fmtPct(v, 1)} />} />
                <Area
                  type="monotone"
                  dataKey="par30_pct"
                  name="PAR30"
                  stroke={AMBER}
                  strokeWidth={2}
                  fill="url(#vdParGrad)"
                  dot={{ fill: AMBER, r: 4 }}
                  activeDot={{ r: 5 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        {/* DPD Distribution */}
        <SectionCard title="DPD Distribution">
          {loading || !detail ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
              Loading…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                layout="vertical"
                data={detail.dpd_buckets}
                margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--chart-grid)" />
                <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--chart-lbl)', fontFamily: INTER }} allowDecimals={false} />
                <YAxis type="category" dataKey="label" width={52} tick={{ fontSize: 11, fill: 'var(--chart-lbl)', fontFamily: INTER }} />
                <Tooltip content={<Tip fmt={v => fmtNum(v)} />} />
                <Bar dataKey="count" name="Loans" radius={[0, 4, 4, 0]}>
                  {detail.dpd_buckets.map((entry, i) => (
                    <Cell key={i} fill={DPD_BUCKET_COLORS[entry.label] ?? NAVY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>

      {/* ── Breakdown tables (Employers + Products) ──────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        {/* Top Employers */}
        <SectionCard title="Top Employers" badge={detail?.employers?.length} padding={false}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Employer', 'Loans', 'Book', 'PAR30'].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: h === 'Employer' ? 'left' : 'right',
                      fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
                      borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(loading || !detail) ? (
                  <tr><td colSpan={4} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>Loading…</td></tr>
                ) : detail.employers.length === 0 ? (
                  <tr><td colSpan={4} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No data</td></tr>
                ) : detail.employers.map((r, i) => (
                  <tr key={i}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                  >
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.employer}</td>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM }}>{fmtNum(r.count)}</td>
                    <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM }}>{fmtKobo(r.book_kobo)}</td>
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
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', ...NUM }}>{fmtKobo(r.book_kobo)}</td>
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
