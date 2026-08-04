import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { NAVY, BLUE, AMBER, GREEN, RED, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

interface Summary {
  at_risk_accounts: number
  over_limit_accounts: number
  overdue_accounts: number
  overdue_kobo: number
  over_limit_excess_kobo: number
}
interface RiskAccount {
  account_number: string
  cif: string
  customer_name: string
  product: string
  outstanding_balance_kobo: number
  credit_limit_kobo: number
  overdue_amount_kobo: number
  minimum_payment_kobo: number
  utilization_pct: number | string
  over_limit: boolean
  overdue: boolean
}

type Filter = 'all' | 'over_limit' | 'overdue'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All at-risk' },
  { id: 'over_limit', label: 'Over limit' },
  { id: 'overdue', label: 'Overdue' },
]

const back = { label: 'Credit Card Portfolio', to: '/cards/credit-portfolio' }

function Chip({ label, color }: { label: string; color: string }) {
  return <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 7px', borderRadius: RADIUS.lg, background: `${color}18`, color, whiteSpace: 'nowrap' }}>{label}</span>
}

export default function AtRiskCards() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [rows, setRows] = useState<RiskAccount[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<any>(`/api/cards-credit/at-risk?filter=${filter}&limit=1000`)
      const d = r?.data ?? r
      setSummary(d?.summary ?? null)
      setRows(Array.isArray(d?.accounts) ? d.accounts : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [filter])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['cards'] })

  function exportCsv() {
    const head = ['CIF', 'Customer', 'Account', 'Product', 'Balance (NGN)', 'Limit (NGN)', 'Utilization %', 'Overdue (NGN)', 'Min Payment (NGN)', 'Flags']
    const lines = rows.map(r => [
      r.cif, r.customer_name || '', r.account_number, r.product,
      (r.outstanding_balance_kobo / 100).toFixed(2), (r.credit_limit_kobo / 100).toFixed(2),
      Number(r.utilization_pct).toFixed(1), (r.overdue_amount_kobo / 100).toFixed(2),
      (r.minimum_payment_kobo / 100).toFixed(2),
      [r.over_limit ? 'over-limit' : '', r.overdue ? 'overdue' : ''].filter(Boolean).join('|'),
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `at-risk-cards-${filter}.csv`; a.click(); URL.revokeObjectURL(url)
  }

  const TH: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }
  const TD: React.CSSProperties = { padding: '9px 12px', fontSize: TEXT.sm, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)' }

  const actions = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <div style={{ display: 'flex', gap: 2, background: 'var(--chip-bg)', borderRadius: RADIUS.md, padding: 3, border: '1px solid var(--bdr)' }}>
        {FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: '5px 12px', borderRadius: 7, border: 'none', fontSize: TEXT.sm, fontFamily: INTER, cursor: 'pointer',
            fontWeight: filter === f.id ? FW.bold : FW.medium,
            background: filter === f.id ? 'var(--card)' : 'transparent',
            color: filter === f.id ? 'var(--txt)' : 'var(--txt2)',
          }}>{f.label}</button>
        ))}
      </div>
      <button onClick={exportCsv} disabled={!rows.length} style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: RADIUS.md,
        border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm,
        fontWeight: FW.semibold, cursor: rows.length ? 'pointer' : 'default', opacity: rows.length ? 1 : 0.5,
      }}><span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>Export</button>
    </div>
  )

  return (
    <Page title="At-Risk Credit Cards" subtitle="Over-limit and overdue accounts from the latest billing cycle" back={back} actions={actions}>
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="At-Risk Accounts" value={fmtNum(summary?.at_risk_accounts ?? 0)} icon="warning" accent={RED} />
        <KpiCard label="Over Limit" value={fmtNum(summary?.over_limit_accounts ?? 0)} icon="trending_up" accent={AMBER} sub={summary ? `${fmtKobo(summary.over_limit_excess_kobo)} excess` : undefined} />
        <KpiCard label="Overdue Accounts" value={fmtNum(summary?.overdue_accounts ?? 0)} icon="schedule" accent={RED} />
        <KpiCard label="Overdue Exposure" value={fmtKobo(summary?.overdue_kobo ?? 0)} icon="account_balance_wallet" accent={NAVY} />
      </div>

      <SectionCard title="Accounts" badge={rows.length} padding={false}>
        {loading && !rows.length ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={28} /></div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: 'var(--txt3)', fontSize: TEXT.base, fontFamily: INTER }}>No at-risk accounts for this filter</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Customer</th>
                  <th style={TH}>Product</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Balance</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Limit</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Util</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Overdue</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Min Pymt</th>
                  <th style={TH}>Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const util = Number(r.utilization_pct)
                  return (
                    <tr key={i}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                      <td style={TD}>
                        <a href={`/customers/${encodeURIComponent(r.cif)}`} style={{ textDecoration: 'none' }}>
                          <div style={{ fontWeight: FW.semibold, color: NAVY, fontFamily: SORA }}>{r.customer_name || '—'}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--txt3)', ...NUM }}>{r.cif} · {r.account_number}</div>
                        </a>
                      </td>
                      <td style={{ ...TD, color: 'var(--txt2)' }}>{r.product}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', fontWeight: FW.semibold }}>{fmtKobo(r.outstanding_balance_kobo)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{fmtKobo(r.credit_limit_kobo)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', fontWeight: FW.bold, color: util >= 100 ? RED : util >= 80 ? AMBER : 'var(--txt2)' }}>{util.toFixed(0)}%</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: r.overdue_amount_kobo > 0 ? RED : 'var(--txt3)' }}>{fmtKobo(r.overdue_amount_kobo)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{fmtKobo(r.minimum_payment_kobo)}</td>
                      <td style={{ ...TD }}>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {r.over_limit && <Chip label="Over limit" color={AMBER} />}
                          {r.overdue && <Chip label="Overdue" color={RED} />}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
