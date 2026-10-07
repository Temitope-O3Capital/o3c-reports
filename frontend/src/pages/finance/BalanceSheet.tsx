import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard, SegmentedToggle } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, TEXT, FW, SP } from '../../lib/design'

// Balance Sheet — promoted out of the "Financial Position" section that used to sit
// inside Overview.tsx. Same source (app.financial_position / app.financial_position_by_branch,
// migrations 282/339), now its own branch-splittable book under Finance > Books of Accounts.
// Consolidated (no branch) reads the whole-company view directly; picking a branch switches
// to the branch-split view, which also carries the frozen 2026-01-01 Opening Equity line and
// lets the handler add Retained Earnings since the GL's 2026-07-01 coverage floor — an
// IMPLIED equity figure, not folded into Net Position, and explicitly partial-period.

interface Line { currency: string; side: 'Asset' | 'Liability' | 'Equity'; line: string; gl_code: string; amount_kobo: number; items: number }
interface Totals { currency: string; assets_kobo: number; liabilities_kobo: number; opening_equity_kobo: number; net_position_kobo: number }
interface Payload {
  lines: Line[]
  totals: Totals[]
  branch: string
  retained_earnings_kobo: number
  retained_earnings_since: string
  as_of?: { cards?: string | null; cbs?: string | null }
  gl_entries: number
  basis: string
}

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
] as const

export default function BalanceSheet() {
  const [branch, setBranch] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = branch ? `?branch=${branch}` : ''
      const res = await apiFetch(`/api/finance/position${q}`)
      setData(unwrap<Payload>(res))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load balance sheet')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [branch]) // eslint-disable-line react-hooks/exhaustive-deps

  const primary = useMemo(() => (data?.totals ?? []).find(t => t.currency === 'NGN') ?? data?.totals?.[0], [data])
  const impliedEquity = (primary?.opening_equity_kobo ?? 0) + (data?.retained_earnings_kobo ?? 0)

  const cols: TableCol<Line>[] = [
    { key: 'line', label: 'Line' },
    { key: 'gl_code', label: 'GL Code', align: 'right' },
    { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo) },
    { key: 'items', label: 'Items', align: 'right', render: r => fmtNum(r.items) },
  ]

  return (
    <Page
      title="Balance Sheet"
      subtitle={`Assets and liabilities from the live books of record${data?.as_of?.cards ? ` · cards to ${fmtDate(data.as_of.cards)}` : ''}`}
      back={{ label: 'Finance', to: '/finance' }}
      loading={loading && !data}
      skeletonKpis={branch ? 4 : 3}
      actions={<SegmentedToggle value={branch} onChange={setBranch} options={BRANCHES as any} />}
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${branch ? 4 : 3},1fr)`, gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Assets" value={fmtKoboExact(primary?.assets_kobo ?? 0)} icon="account_balance_wallet" accent={NAVY} loading={loading} />
        <KpiCard label="Total Liabilities" value={fmtKoboExact(primary?.liabilities_kobo ?? 0)} icon="savings" accent={AMBER} loading={loading} />
        <KpiCard label="Net Position" value={fmtKoboExact(primary?.net_position_kobo ?? 0)}
          sub="assets − liabilities; not equity" icon={((primary?.net_position_kobo ?? 0) >= 0) ? 'trending_up' : 'trending_down'}
          accent={(primary?.net_position_kobo ?? 0) >= 0 ? GREEN : RED} loading={loading} />
        {branch && (
          <KpiCard label="Implied Equity" value={fmtKoboExact(impliedEquity)}
            sub={`opening (2026-01-01) + retained earnings since ${data?.retained_earnings_since ?? '2026-07-01'}`}
            icon="account_balance" accent={GREEN} loading={loading} />
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        {(data?.totals ?? []).map(t => {
          const lines = (data?.lines ?? []).filter(l => l.currency === t.currency)
          return (
            <div key={t.currency} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
              <SectionCard title={`Assets · ${t.currency}`} subtitle={fmtKoboExact(t.assets_kobo)}>
                <DataTable cols={cols} rows={lines.filter(l => l.side === 'Asset')} keyFn={(r, i) => `a-${t.currency}-${i}`} emptyText="No asset lines" />
              </SectionCard>
              <SectionCard title={`Liabilities · ${t.currency}`} subtitle={fmtKoboExact(t.liabilities_kobo)}>
                <DataTable cols={cols} rows={lines.filter(l => l.side === 'Liability')} keyFn={(r, i) => `l-${t.currency}-${i}`} emptyText="No liability lines" />
              </SectionCard>
              {lines.some(l => l.side === 'Equity') && (
                <SectionCard title={`Equity (Frozen Opening) · ${t.currency}`} subtitle="2026-01-01, flagged estimate — see footnote" style={{ gridColumn: '1 / -1' }}>
                  <DataTable cols={cols} rows={lines.filter(l => l.side === 'Equity')} keyFn={(r, i) => `e-${t.currency}-${i}`} emptyText="No equity lines" />
                </SectionCard>
              )}
            </div>
          )
        })}
      </div>

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4], lineHeight: 1.55 }}>
        {data?.basis}
        {branch && (
          <> Implied Equity adds Retained Earnings (income minus expense from Udara's own GL, {data?.retained_earnings_since ?? '2026-07-01'}
            onward only — Jan–Jun 2026 has no GL feed at all) to the frozen 2026-01-01 Opening Equity estimate. It will not exactly
            reconcile to Net Position above; both are shown rather than forcing a balance.</>
        )}
      </p>
    </Page>
  )
}
