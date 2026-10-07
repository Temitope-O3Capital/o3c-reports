import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard, SegmentedToggle } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtNum } from '../../lib/fmt'
import { GREEN, RED, NAVY, PURPLE, TEXT, SP } from '../../lib/design'

// Cash Flow Statement — did not exist anywhere in this system before migration 348.
// Built off Udara's own GL (app.cash_flow_statement_by_branch), same 2026-07-01+ floor
// as the Income Statement, by whole-ledger conservation rather than leg-by-leg pairing.
// See that migration's header for the method and its small, disclosed reconciliation gap.

interface Line { branch: string; activity: 'operating' | 'investing' | 'financing' | 'unclassified'; line_label: string; amount_kobo: number; postings: number }
interface Totals { branch: string; activity: string; amount_kobo: number }
interface Payload { lines: Line[]; totals: Totals[]; coverage_start: string; basis: string }

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
] as const

const ACTIVITY_META: Record<string, { label: string; accent: string; icon: string }> = {
  operating: { label: 'Operating Activities', accent: NAVY, icon: 'sync_alt' },
  investing: { label: 'Investing Activities', accent: PURPLE, icon: 'trending_up' },
  financing: { label: 'Financing Activities', accent: GREEN, icon: 'account_balance' },
  unclassified: { label: 'Unclassified', accent: RED, icon: 'help' },
}

function groupBy<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const cur = m.get(k) ?? []
    cur.push(r)
    m.set(k, cur)
  }
  return m
}

export default function CashFlowStatement() {
  const [branch, setBranch] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = branch ? `?branch=${branch}` : ''
      const res = await apiFetch(`/api/finance/cash-flow-statement${q}`)
      setData(unwrap<Payload>(res))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load cash flow statement')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [branch]) // eslint-disable-line react-hooks/exhaustive-deps

  const byActivity = useMemo(() => groupBy(data?.lines ?? [], l => l.activity), [data])
  const totalByActivity = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of data?.totals ?? []) m.set(t.activity, (m.get(t.activity) ?? 0) + Number(t.amount_kobo))
    return m
  }, [data])
  const netChange = ['operating', 'investing', 'financing'].reduce((s, a) => s + (totalByActivity.get(a) ?? 0), 0)
  const unclassifiedTotal = totalByActivity.get('unclassified') ?? 0

  const cols: TableCol<Line>[] = [
    { key: 'line_label', label: 'Line' },
    { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo) },
    { key: 'postings', label: 'Postings', align: 'right', render: r => fmtNum(r.postings) },
  ]

  return (
    <Page
      title="Cash Flow Statement"
      subtitle={`By branch, from Udara's own GL · from ${data?.coverage_start ?? '2026-07-01'}`}
      back={{ label: 'Finance', to: '/finance' }}
      loading={loading && !data}
      skeletonKpis={4}
      actions={<SegmentedToggle value={branch} onChange={setBranch} options={BRANCHES as any} />}
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Net Change in Cash" value={fmtKoboExact(netChange)}
          icon={netChange >= 0 ? 'trending_up' : 'trending_down'} accent={netChange >= 0 ? GREEN : RED} loading={loading} />
        <KpiCard label="Operating" value={fmtKoboExact(totalByActivity.get('operating') ?? 0)} icon="sync_alt" accent={NAVY} loading={loading} />
        <KpiCard label="Investing" value={fmtKoboExact(totalByActivity.get('investing') ?? 0)} icon="trending_up" accent={PURPLE} loading={loading} />
        <KpiCard label="Financing" value={fmtKoboExact(totalByActivity.get('financing') ?? 0)} icon="account_balance" accent={GREEN} loading={loading} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[4] }}>
        {(['operating', 'investing', 'financing'] as const).map(a => (
          <SectionCard key={a} title={ACTIVITY_META[a].label} subtitle={fmtKoboExact(totalByActivity.get(a) ?? 0)}>
            <DataTable cols={cols} rows={byActivity.get(a) ?? []} keyFn={(r, i) => `${a}-${i}`} emptyText="No activity in this period" />
          </SectionCard>
        ))}
      </div>

      {(byActivity.get('unclassified')?.length ?? 0) > 0 && (
        <div style={{ marginTop: SP[4] }}>
          <SectionCard title="Unclassified" subtitle={`${fmtKoboExact(unclassifiedTotal)} — generic GL accounts not yet mapped to an activity; see footnote`}>
            <DataTable cols={cols} rows={byActivity.get('unclassified') ?? []} keyFn={(r, i) => `u-${i}`} emptyText="Nothing unclassified" />
          </SectionCard>
        </div>
      )}

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4], lineHeight: 1.55 }}>{data?.basis}</p>
    </Page>
  )
}
