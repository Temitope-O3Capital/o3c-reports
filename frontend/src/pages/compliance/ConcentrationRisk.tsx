import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, NUM, INTER } from '../../lib/design'

interface ConcentrationData {
  total_loan_book_kobo:         number
  cbn_single_obligor_limit_pct: number
  top_obligors: Array<{ obligor: string; name: string; exposure_kobo: number; exposure_pct: number; loan_count: number }>
  by_loan_type: Array<{ loan_type: string; exposure_kobo: number; exposure_pct: number; count: number }>
  by_employer:  Array<{ employer: string; exposure_kobo: number; exposure_pct: number; borrower_count: number }>
}

function PctBar({ pct, limit }: { pct: number; limit?: number }) {
  const breached = limit !== undefined && pct > limit
  const warn     = limit !== undefined && pct > limit * 0.8
  const color    = breached ? RED : warn ? AMBER : NAVY
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--bdr)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .3s' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, ...NUM, minWidth: 44, textAlign: 'right' }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  )
}

export default function ConcentrationRisk() {
  const [data,    setData]    = useState<ConcentrationData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<ConcentrationData>('/api/compliance/concentration-risk')
      setData(res)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const th: React.CSSProperties = {
    textAlign: 'left', padding: '8px 14px', fontWeight: 700, fontSize: 11,
    textTransform: 'uppercase' as const, letterSpacing: '.4px',
    color: 'var(--txt2)', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)',
  }
  const td: React.CSSProperties = { padding: '10px 14px', borderBottom: '1px solid var(--bdr)' }

  return (
    <Page
      title="Concentration Risk"
      subtitle="CBN-required obligor, sector, and employer concentration metrics"
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : data ? (
        <>
          {/* Summary header */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
            {[
              { label: 'Total Loan Book', value: fmtKobo(data.total_loan_book_kobo) },
              { label: 'Active Obligors', value: String(data.top_obligors.length) + '+' },
              { label: 'CBN Single-Obligor Cap', value: `${data.cbn_single_obligor_limit_pct}%` },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 18px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: NAVY, marginTop: 4, ...NUM }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Top obligors */}
          <SectionCard title="Top 10 Obligors by Exposure" badge={data.top_obligors.length}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['#', 'Obligor', 'Name', 'Exposure', '% of Book', 'Loans', 'CBN Limit'].map(h => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.top_obligors.map((row, i) => {
                    const breached = row.exposure_pct > data.cbn_single_obligor_limit_pct
                    return (
                      <tr key={row.obligor} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--row-hvr)' }}>
                        <td style={{ ...td, fontWeight: 700, color: 'var(--txt3)', width: 32 }}>{i + 1}</td>
                        <td style={{ ...td, fontWeight: 600, color: NAVY, fontFamily: INTER }}>{row.obligor || '—'}</td>
                        <td style={{ ...td, color: 'var(--txt2)', fontSize: 12 }}>{row.name}</td>
                        <td style={{ ...td, ...NUM, fontWeight: 700 }}>{fmtKobo(row.exposure_kobo)}</td>
                        <td style={{ ...td, minWidth: 160 }}>
                          <PctBar pct={row.exposure_pct} limit={data.cbn_single_obligor_limit_pct} />
                        </td>
                        <td style={{ ...td, ...NUM }}>{row.loan_count}</td>
                        <td style={{ ...td }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8,
                            background: breached ? `${RED}15` : `${GREEN}18`,
                            color: breached ? RED : GREEN }}>
                            {breached ? 'Breached' : 'Within limit'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}>
            {/* By loan type */}
            <SectionCard title="By Loan Type">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['Type', 'Count', 'Exposure', '% of Book'].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.by_loan_type.map((row, i) => (
                    <tr key={row.loan_type} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--row-hvr)' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{row.loan_type}</td>
                      <td style={{ ...td, ...NUM }}>{row.count}</td>
                      <td style={{ ...td, ...NUM, fontWeight: 700 }}>{fmtKobo(row.exposure_kobo)}</td>
                      <td style={{ ...td, minWidth: 130 }}><PctBar pct={row.exposure_pct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>

            {/* By employer */}
            <SectionCard title="Top 10 Employers">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['Employer', 'Borrowers', 'Exposure', '% of Book'].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.by_employer.map((row, i) => (
                    <tr key={row.employer} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--row-hvr)' }}>
                      <td style={{ ...td, fontWeight: 600, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.employer}</td>
                      <td style={{ ...td, ...NUM }}>{row.borrower_count}</td>
                      <td style={{ ...td, ...NUM, fontWeight: 700 }}>{fmtKobo(row.exposure_kobo)}</td>
                      <td style={{ ...td, minWidth: 130 }}><PctBar pct={row.exposure_pct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          </div>
        </>
      ) : null}
    </Page>
  )
}
