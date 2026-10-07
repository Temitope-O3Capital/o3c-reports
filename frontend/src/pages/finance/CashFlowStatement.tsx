import { useEffect, useState, useMemo } from 'react'
import { Page, DataTable, ErrBanner, KpiCard, SegmentedToggle, DateFilter, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LedgerTree } from '../../components/finance/LedgerTree'
import type { LedgerSection } from '../../components/finance/LedgerTree'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtDate } from '../../lib/fmt'
import { GREEN, RED, NAVY, PURPLE, TEXT, FW, SP } from '../../lib/design'

// Cash Flow Statement — did not exist anywhere in this system before migration 348.
// Reads cbs_gl_postings directly rather than the pre-aggregated app.cash_flow_statement_by_branch
// view, so Date can be a real filter (see backend-go/handlers/cash_flow.go's header for why).
// Built by whole-ledger conservation rather than leg-by-leg pairing — see that file for the
// method and its small, disclosed reconciliation gap.
//
// Rendered as a real ledger (LedgerTree): Operating/Investing/Financing/Unclassified
// sections, each line directly drillable into the real GL postings behind it. Net Change
// in Cash (the grand total) deliberately excludes Unclassified — that section is a flag,
// not a real activity, same framing as its red-bordered card before this pass.

interface Line { branch: string; activity: 'operating' | 'investing' | 'financing' | 'unclassified'; line_label: string; amount_kobo: number; postings: number }
interface Totals { branch: string; activity: string; amount_kobo: number }
interface Payload { lines: Line[]; totals: Totals[]; coverage_start: string; basis: string }

interface Entry {
  id: number; financial_date: string; narration: string; posting_reference: string
  account_number: string; account_name: string; side: string; amount_kobo: number; branch: string
}

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
] as const

const ACTIVITY_META: Record<string, { label: string; accent: string; icon: string }> = {
  operating: { label: 'Operating Activities', accent: NAVY, icon: 'sync_alt' },
  investing: { label: 'Investing Activities', accent: PURPLE, icon: 'trending_up' },
  financing: { label: 'Financing Activities', accent: GREEN, icon: 'account_balance' },
  unclassified: { label: 'Unclassified — not a real activity, flagged not summed', accent: RED, icon: 'help' },
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

const entryCols: TableCol<Entry>[] = [
  { key: 'financial_date', label: 'Date', render: r => fmtDate(r.financial_date) },
  { key: 'account_name', label: 'Account', render: r => r.account_name },
  { key: 'narration', label: 'Narration', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.narration || r.posting_reference || '—'}</span> },
  { key: 'side', label: 'Side', render: r => <span style={{ textTransform: 'capitalize' }}>{r.side}</span> },
  { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo) },
]

export default function CashFlowStatement() {
  const [branch, setBranch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [drill, setDrill] = useState<Line | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [entriesLoading, setEntriesLoading] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams()
      if (branch) q.set('branch', branch)
      if (dateFrom) q.set('date_from', dateFrom)
      if (dateTo) q.set('date_to', dateTo)
      const res = await apiFetch(`/api/finance/cash-flow-statement?${q.toString()}`)
      setData(unwrap<Payload>(res))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load cash flow statement')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [branch, dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  const byActivity = useMemo(() => groupBy(data?.lines ?? [], l => l.activity), [data])
  const totalByActivity = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of data?.totals ?? []) m.set(t.activity, (m.get(t.activity) ?? 0) + Number(t.amount_kobo))
    return m
  }, [data])
  const netChange = ['operating', 'investing', 'financing'].reduce((s, a) => s + (totalByActivity.get(a) ?? 0), 0)

  async function openDrill(row: Line) {
    setDrill(row)
    setEntries(null)
    setEntriesLoading(true)
    try {
      const q = new URLSearchParams()
      q.set('activity', row.activity)
      q.set('line_label', row.line_label)
      if (branch) q.set('branch', branch)
      if (dateFrom) q.set('date_from', dateFrom)
      if (dateTo) q.set('date_to', dateTo)
      const res = await apiFetch(`/api/finance/cash-flow-statement/entries?${q.toString()}`)
      setEntries(unwrap<{ entries: Entry[] }>(res).entries)
    } catch (e: any) {
      setEntries([])
    } finally {
      setEntriesLoading(false)
    }
  }

  const sections: LedgerSection[] = (['operating', 'investing', 'financing', 'unclassified'] as const)
    .filter(a => (byActivity.get(a)?.length ?? 0) > 0)
    .map(a => ({
      key: a,
      label: ACTIVITY_META[a].label,
      accent: ACTIVITY_META[a].accent,
      lines: (byActivity.get(a) ?? []).map(row => ({
        key: `${a}-${row.line_label}`,
        label: row.line_label,
        accounts: [{ key: `${a}-${row.line_label}-acc`, label: row.line_label, amount: Number(row.amount_kobo), postings: row.postings, onClick: () => openDrill(row) }],
        onClick: () => openDrill(row),
      })),
    }))

  return (
    <Page
      title="Cash Flow Statement"
      subtitle={`By branch, from Udara's own GL · from ${data?.coverage_start ?? '2026-07-01'}`}
      back={{ label: 'Finance', to: '/finance' }}
      loading={loading && !data}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)' }}>Location</span>
          <SegmentedToggle value={branch} onChange={setBranch} options={BRANCHES as any} />
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Net Change in Cash" value={fmtKoboExact(netChange)}
          icon={netChange >= 0 ? 'trending_up' : 'trending_down'} accent={netChange >= 0 ? GREEN : RED} loading={loading} />
        <KpiCard label="Operating" value={fmtKoboExact(totalByActivity.get('operating') ?? 0)} icon="sync_alt" accent={NAVY} loading={loading} />
        <KpiCard label="Investing" value={fmtKoboExact(totalByActivity.get('investing') ?? 0)} icon="trending_up" accent={PURPLE} loading={loading} />
        <KpiCard label="Financing" value={fmtKoboExact(totalByActivity.get('financing') ?? 0)} icon="account_balance" accent={GREEN} loading={loading} />
      </div>

      <LedgerTree sections={sections} grandTotalLabel="Net Change in Cash" grandTotal={netChange} fmtAmount={fmtKoboExact}
        loading={loading && !data} emptyText="No activity in this period" />

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4], lineHeight: 1.55 }}>{data?.basis}</p>

      <Modal open={!!drill} onClose={() => setDrill(null)}
        title={drill ? `${ACTIVITY_META[drill.activity]?.label ?? drill.activity} — ${drill.line_label}` : ''} width={760}>
        {drill && (
          <>
            <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 0 }}>
              {drill.branch} · {fmtKoboExact(drill.amount_kobo)} net across {drill.postings} postings
            </p>
            <DataTable cols={entryCols} rows={entries ?? []} keyFn={(r, i) => r.id ?? i} loading={entriesLoading}
              emptyText="No entries found for this line" />
          </>
        )}
      </Modal>
    </Page>
  )
}
