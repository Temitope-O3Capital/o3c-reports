import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { fmtExact, fmtDate } from '../lib/fmt'
import { GREEN, NUM, TEXT, FW } from '../lib/design'

// Monthly repayment cadence for one CIF — the same money-in view Customer 360 shows,
// rendered compact for the collections/recovery detail panels. Fetches its own data
// from `${endpointBase}/repayment-pattern` (mounted under both ops route groups), so a
// panel just drops it in with the account's CIF. Transaction-feed amounts are NAIRA.
interface PatMonth { month: string; amount: number; count: number }
interface PayItem  { date: string; amount: number; description?: string; merchant?: string }

export function RepaymentPatternMini({ cif, endpointBase }: { cif: string; endpointBase: string }) {
  const [pattern, setPattern] = useState<PatMonth[]>([])
  const [history, setHistory] = useState<PayItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    apiFetch<{ data: { repayment_pattern?: PatMonth[]; payment_history?: PayItem[] } }>(
      `${endpointBase}/repayment-pattern?cif=${encodeURIComponent(cif)}`)
      .then(res => {
        if (!live) return
        setPattern(res.data?.repayment_pattern ?? [])
        setHistory(res.data?.payment_history ?? [])
      })
      .catch(() => { if (live) { setPattern([]); setHistory([]) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [cif, endpointBase])

  if (loading) {
    return <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', padding: '4px 0' }}>Loading cadence…</div>
  }
  if (pattern.length === 0 && history.length === 0) {
    return <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', padding: '4px 0' }}>No repayments on record.</div>
  }

  const max = Math.max(...pattern.map(x => Number(x.amount) || 0), 1)

  return (
    <div>
      {pattern.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 58, marginBottom: 12, paddingTop: 4 }}>
          {pattern.map((m, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}>
              <div
                title={`${m.month}: ${fmtExact(m.amount)} · ${m.count} payment${m.count === 1 ? '' : 's'}`}
                style={{ width: '100%', height: `${Math.max(3, ((Number(m.amount) || 0) / max) * 42)}px`, background: GREEN, borderRadius: 3 }}
              />
              <span style={{ fontSize: 8, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{m.month}</span>
            </div>
          ))}
        </div>
      )}
      {history.slice(0, 6).map((p, i, arr) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px', borderBottom: i < arr.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt)', fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.description || 'Repayment'}</div>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDate(p.date)}{p.merchant ? ` · ${p.merchant}` : ''}</div>
          </div>
          <div style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color: GREEN, flexShrink: 0 }}>+{fmtExact(p.amount)}</div>
        </div>
      ))}
    </div>
  )
}
