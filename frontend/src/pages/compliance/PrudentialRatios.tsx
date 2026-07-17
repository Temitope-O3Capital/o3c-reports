import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, RED, NAVY, NUM } from '../../lib/design'

interface Ratios {
  npl_kobo:              number
  total_loan_book_kobo:  number
  npl_ratio_pct:         number
  par30_pct:             number
  par60_pct:             number
  par90_pct:             number
  total_fd_liabilities_kobo: number
  total_disbursed_kobo:  number
  active_loans:          number
  cbn_thresholds: {
    npl_max_pct:   number
    par90_max_pct: number
    car_min_pct:   number
  }
}

function RatioCard({ label, value, threshold, thresholdLabel, isMin = false }: {
  label: string
  value: number
  threshold?: number
  thresholdLabel?: string
  isMin?: boolean
}) {
  let color = NAVY
  if (threshold !== undefined) {
    const breached = isMin ? value < threshold : value > threshold
    color = breached ? RED : value > threshold * 0.8 && !isMin ? AMBER : GREEN
  }
  return (
    <div style={{ background: 'var(--card)', border: `1px solid ${color}30`, borderRadius: RADIUS.xl, padding: '16px 20px' }}>
      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: SP[2] }}>
        {label}
      </div>
      <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color, ...NUM }}>{Number(value ?? 0).toFixed(2)}%</div>
      {threshold !== undefined && (
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 6 }}>
          CBN {isMin ? 'min' : 'max'}: <span style={{ fontWeight: FW.bold, color: 'var(--txt2)' }}>{threshold}%</span>
          {thresholdLabel && ` · ${thresholdLabel}`}
        </div>
      )}
    </div>
  )
}

export default function PrudentialRatios() {
  const [data,    setData]    = useState<Ratios | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<Ratios>('/api/compliance/prudential-ratios')
      setData(res)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Page title="Prudential Ratios" subtitle="CBN-required portfolio health indicators">
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : data ? (
        <>
          {/* Key ratios */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[6] }}>
            <RatioCard label="NPL Ratio" value={data.npl_ratio_pct} threshold={data.cbn_thresholds.npl_max_pct} thresholdLabel="CAR at risk" />
            <RatioCard label="PAR 30" value={data.par30_pct} threshold={15} />
            <RatioCard label="PAR 60" value={data.par60_pct} threshold={10} />
            <RatioCard label="PAR 90" value={data.par90_pct} threshold={data.cbn_thresholds.par90_max_pct} />
          </div>

          {/* Book summary */}
          <SectionCard title="Loan Book Summary">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              {[
                { label: 'Total Loan Book',     value: fmtKobo(data.total_loan_book_kobo) },
                { label: 'NPL Amount',           value: fmtKobo(data.npl_kobo) },
                { label: 'Active Loans',         value: String(data.active_loans) },
                { label: 'Total Disbursed',      value: fmtKobo(data.total_disbursed_kobo) },
                { label: 'FD Liabilities',       value: fmtKobo(data.total_fd_liabilities_kobo) },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: 'var(--row-hvr)', borderRadius: RADIUS.lg, padding: '14px 16px' }}>
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
                  <div style={{ fontSize: TEXT.xl, fontWeight: FW.extrabold, color: NAVY, marginTop: SP[1], ...NUM }}>{value}</div>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* CBN thresholds reference */}
          <SectionCard title="CBN Regulatory Thresholds">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Metric', 'Threshold', 'Current', 'Status'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 14px', fontWeight: FW.bold, fontSize: TEXT.xs,
                      textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { metric: 'NPL Ratio', threshold: `≤ ${data.cbn_thresholds.npl_max_pct}%`, current: data.npl_ratio_pct, breached: data.npl_ratio_pct > data.cbn_thresholds.npl_max_pct },
                  { metric: 'PAR 90',    threshold: `≤ ${data.cbn_thresholds.par90_max_pct}%`, current: data.par90_pct, breached: data.par90_pct > data.cbn_thresholds.par90_max_pct },
                  { metric: 'CAR (Capital Adequacy)', threshold: `≥ ${data.cbn_thresholds.car_min_pct}%`, current: null, breached: false },
                ].map(row => (
                  <tr key={row.metric} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '10px 14px', fontWeight: FW.semibold }}>{row.metric}</td>
                    <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{row.threshold}</td>
                    <td style={{ padding: '10px 14px', ...NUM, fontWeight: FW.bold, color: row.breached ? RED : NAVY }}>
                      {row.current != null ? `${Number(row.current).toFixed(2)}%` : 'N/A (manual input)'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {row.current !== null ? (
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md,
                          background: row.breached ? `${RED}15` : `${GREEN}18`,
                          color: row.breached ? RED : GREEN }}>
                          {row.breached ? 'Breached' : 'Compliant'}
                        </span>
                      ) : (
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Requires manual calculation</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
        </>
      ) : null}
    </Page>
  )
}
