import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, ExpandableFilterBar, ErrBanner, Sk, DateFilter } from '../../components/UI'
import type { FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtPct, fmtNum, fmtKoboExact, fmtKobo, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, RED, NAVY, BLUE, INTER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────
// CURRENT delinquency by booking-month vintage. Deliberately NOT the old 1m/3m/6m/12m
// PAR matrix: app.cbs_loan_dpd is a point-in-time snapshot with no DPD history, so those
// columns were all the same current number (a flat, fake vintage curve). This shows the
// real question the data answers — of loans booked in month X, how delinquent are they now.
interface VintageRow {
  booking_month: string
  cohort_count: number
  outstanding_kobo: number
  par30: number | null
  npl: number | null
  avg_dpd: number | null
  worst_dpd: number | null
  age_months: number
}
interface VintageKPIs {
  total_loans: number
  par30: number | null
  npl: number | null
  par30_outstanding_kobo: number
}

// ── Cell colouring ──────────────────────────────────────────────────────────────
function parStyle(v: number | null): { bg: string; color: string } {
  if (v === null) return { bg: 'transparent', color: 'var(--txt3)' }
  if (v < 5)   return { bg: 'rgba(22,163,74,.10)', color: GREEN }
  if (v <= 15) return { bg: 'rgba(217,119,6,.10)', color: AMBER }
  return         { bg: 'rgba(192,0,0,.10)',        color: RED }
}
function dpdColor(v: number | null): string {
  if (v == null) return 'var(--txt3)'
  if (v <= 0)  return GREEN
  if (v <= 30) return AMBER
  return RED
}
function RateCell({ value }: { value: number | null }) {
  const s = parStyle(value)
  return (
    <td style={{ padding: '10px 16px', textAlign: 'right', background: s.bg, borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: s.color }}>{value === null ? '—' : fmtPct(value, 1)}</span>
    </td>
  )
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <tr key={i}>
          {Array.from({ length: 8 }, (_, j) => (
            <td key={j} style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', textAlign: j === 0 ? 'left' : 'right' }}><Sk h={14} w={j === 0 ? 90 : 48} /></td>
          ))}
        </tr>
      ))}
    </>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function VintageAnalysis() {
  const navigate = useNavigate()
  const [rows,      setRows]      = useState<VintageRow[]>([])
  const [kpis,      setKpis]      = useState<VintageKPIs | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [fProducts, setFProducts] = useState(new Set<string>())
  const [search,    setSearch]    = useState('')
  const [dateFrom,  setDateFrom]  = useState(monthStart())
  const [dateTo,    setDateTo]    = useState(today())
  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback(() => {
    const p = new URLSearchParams()
    if (fProducts.size) p.set('product', [...fProducts].join(','))
    if (dateFrom) p.set('from', dateFrom)
    if (dateTo)   p.set('to', dateTo)
    return p.toString()
  }, [fProducts, dateFrom, dateTo])

  const load = useCallback(async (silent = false) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    if (!silent) setLoading(true); setError(null)
    try {
      const [vintageRes, kpiRes] = await Promise.all([
        apiFetch<{ data: VintageRow[] }>(`/api/risk/vintage?${buildQS()}`, { signal: abortRef.current.signal }),
        apiFetch<{ data: VintageKPIs }>(`/api/risk/vintage-kpis?${buildQS()}`),
      ])
      setRows(vintageRes.data ?? [])
      setKpis(kpiRes.data)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [buildQS])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['loans'] })

  const kpiLoading = loading && !kpis

  const filteredRows = useMemo(() =>
    search ? rows.filter(r => r.booking_month.toLowerCase().includes(search.toLowerCase())) : rows,
    [rows, search],
  )

  function parAccent(val: number | null | undefined): string {
    if (val == null) return NAVY
    if (val < 5)   return GREEN
    if (val <= 15) return AMBER
    return RED
  }

  // Worst vintage = highest current PAR30 among cohorts big enough not to be pure noise.
  const worstMonth = useMemo(() => {
    const scored = rows.filter(r => r.cohort_count >= 3 && r.par30 != null)
      .sort((a, b) => (b.par30 ?? 0) - (a.par30 ?? 0))
    return scored.length && (scored[0].par30 ?? 0) > 0 ? scored[0].booking_month : null
  }, [rows])

  const totalLoans = kpis?.total_loans ?? rows.reduce((s, r) => s + r.cohort_count, 0)

  return (
    <Page
      title="Vintage Analysis"
      subtitle="Current delinquency of the loan book by the month each loan was booked"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
      loading={loading && rows.length === 0}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Honest scope note — what this is and isn't. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md, background: `${BLUE}0F`, border: `1px solid ${BLUE}33`, marginBottom: SP[4], fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: BLUE, flexShrink: 0 }}>info</span>
        <div>
          Each row shows a booking cohort's delinquency <strong>as it stands today</strong>, next to how old it is —
          so you can see loans booked longer ago aging into arrears. This is not a classic age-based vintage curve
          (PAR30 at 1/3/6/12 months of age): that needs a history of DPD snapshots the core system doesn't yet feed.
          The book is small ({fmtNum(totalLoans)} loans), so cohorts under 5 loans <span style={{ color: AMBER, fontWeight: FW.bold }}>*</span> are statistically noisy.
        </div>
      </div>

      {/* KPI strip — honest book-level current state */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard label="Loans in Book" value={loading ? '…' : fmtNum(totalLoans)} accent={NAVY} icon="account_balance" sub={`${fmtNum(rows.length)} booking cohorts`} />
        <KpiCard label="PAR30 (current)" value={kpis?.par30 != null ? fmtPct(kpis.par30, 1) : 'N/A'} loading={kpiLoading} accent={parAccent(kpis?.par30)} icon="monitoring" sub="30+ days past due" />
        <KpiCard label="NPL (current)" value={kpis?.npl != null ? fmtPct(kpis.npl, 1) : 'N/A'} loading={kpiLoading} accent={parAccent(kpis?.npl)} icon="error_outline" sub="90+ days past due" />
        <KpiCard label="At Risk" value={fmtKoboExact(kpis?.par30_outstanding_kobo ?? 0)} loading={kpiLoading} accent={RED} icon="warning" sub="outstanding on PAR30 loans" />
      </div>

      {worstMonth && !loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md, background: 'rgba(192,0,0,.07)', border: `1px solid ${RED}40`, marginBottom: SP[4] }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>warning</span>
          <span style={{ fontSize: TEXT.sm, color: RED, fontWeight: FW.semibold }}>
            Watch: the <strong>{worstMonth}</strong> cohort has the highest current PAR30.
          </span>
        </div>
      )}

      <SectionCard title="Delinquency by Booking Vintage" badge={filteredRows.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'product', label: 'Product',
              options: [{ value: 'Salary Loan' }, { value: 'Business Loan' }, { value: 'Personal Loan' }],
              selected: fProducts, onChange: setFProducts,
            } as FilterGroupDef,
          ]}
          onReset={() => { setFProducts(new Set()); setSearch('') }}
          onApply={load}
          resultCount={filteredRows.length}
          totalCount={rows.length}
        />

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {[
                  { l: 'Booking Cohort', a: 'left' }, { l: 'Age', a: 'right' }, { l: 'Loans', a: 'right' },
                  { l: 'Outstanding', a: 'right' }, { l: 'PAR30', a: 'right' }, { l: 'NPL', a: 'right' },
                  { l: 'Avg DPD', a: 'right' }, { l: 'Worst DPD', a: 'right' }, { l: '', a: 'right' },
                ].map(h => (
                  <th key={h.l} style={{ padding: '10px 16px', textAlign: h.a as any, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>{h.l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows count={6} />
              ) : filteredRows.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>No loans in the book for this filter</td></tr>
              ) : (
                filteredRows.map(row => {
                  const isWorst = row.booking_month === worstMonth
                  const rowBg = isWorst ? 'rgba(192,0,0,.05)' : 'transparent'
                  return (
                    <tr key={row.booking_month} style={{ background: rowBg, cursor: 'pointer' }}
                      onClick={() => navigate(`/operations/risk/vintage/${encodeURIComponent(row.booking_month)}`)}
                      onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = isWorst ? 'rgba(192,0,0,.09)' : 'var(--row-hvr)'}
                      onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = rowBg}>
                      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: NAVY }}>{row.booking_month}</span>
                          {isWorst && <span style={{ fontSize: 10, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: 'rgba(192,0,0,.12)', color: RED }}>WATCH</span>}
                        </div>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{row.age_months === 0 ? 'new' : `${row.age_months} mo`}</span>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(row.cohort_count)}</span>
                        {row.cohort_count > 0 && row.cohort_count < 5 && (
                          <span title="Small cohort — one loan moves the rate by 20%+ so these are noisy" style={{ marginLeft: 4, fontSize: 11, color: AMBER, fontWeight: FW.bold, cursor: 'help' }}>*</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtKoboExact(row.outstanding_kobo)}</span>
                      </td>
                      <RateCell value={row.par30} />
                      <RateCell value={row.npl} />
                      <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: dpdColor(row.avg_dpd) }}>{row.avg_dpd ?? '—'}</span>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: dpdColor(row.worst_dpd) }}>{row.worst_dpd ?? '—'}</span>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)' }}>chevron_right</span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>PAR30 / NPL:</span>
          {([
            { label: '< 5%',   bg: 'rgba(22,163,74,.10)', color: GREEN },
            { label: '5–15%',  bg: 'rgba(217,119,6,.10)', color: AMBER },
            { label: '> 15%',  bg: 'rgba(192,0,0,.10)',   color: RED },
          ] as const).map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 24, height: 14, borderRadius: RADIUS.xs, background: item.bg, border: '1px solid var(--bdr)' }} />
              <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: item.color }}>{item.label}</span>
            </div>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>Click a cohort to see its loans · DPD = days past due</span>
        </div>
      </SectionCard>
    </Page>
  )
}
