import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard, SegmentedToggle, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, TEXT, FW, SP } from '../../lib/design'

// Balance Sheet — promoted out of the "Financial Position" section that used to sit
// inside Overview.tsx. Same source (app.financial_position_by_branch, migration 339,
// read for every Location including Consolidated — live-verified to sum to exactly the
// same totals the older whole-company view gave), now its own book under Finance >
// Books of Accounts. Carries the frozen 2026-01-01 Opening Equity line and lets the
// handler add Retained Earnings since the GL's 2026-07-01 coverage floor — an IMPLIED
// equity figure, not folded into Net Position, explicitly partial-period. No date range
// filter here (unlike Income Statement/Cash Flow) — this is a live point-in-time
// position, not a period, and no snapshot history exists to reconstruct an "as of a past
// date" balance sheet from. Every row drills into the real underlying records.

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

interface Entry {
  cbs_account_number?: string; product_name?: string; status?: string
  outstanding_principal_kobo?: number; customer_name?: string; principal_kobo?: number
  accrued_interest_kobo?: number; maturity_date?: string; account_no?: string; cif?: string
  currency?: string; amount_kobo?: number; office_location?: string; branch_name?: string
  is_estimated?: boolean; note?: string
}

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
] as const

function entryColsFor(line: string): TableCol<Entry>[] {
  switch (line) {
    case 'Loan Receivable':
      return [
        { key: 'cbs_account_number', label: 'Account' },
        { key: 'product_name', label: 'Product' },
        { key: 'status', label: 'Status' },
        { key: 'outstanding_principal_kobo', label: 'Outstanding', align: 'right', render: r => fmtKoboExact(r.outstanding_principal_kobo ?? 0) },
      ]
    case 'Fixed Deposit Principal':
    case 'Fixed Deposit Interest Payable':
      return [
        { key: 'cbs_account_number', label: 'Account' },
        { key: 'customer_name', label: 'Customer' },
        { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => fmtKoboExact(r.principal_kobo ?? 0) },
        { key: 'accrued_interest_kobo', label: 'Accrued Interest', align: 'right', render: r => fmtKoboExact(r.accrued_interest_kobo ?? 0) },
        { key: 'maturity_date', label: 'Maturity', render: r => r.maturity_date ? fmtDate(r.maturity_date) : '—' },
      ]
    case 'Card Receivable':
    case 'Card Customer Float':
      return [
        { key: 'account_no', label: 'Account' },
        { key: 'cif', label: 'CIF' },
        { key: 'product_name', label: 'Product' },
        { key: 'office_location', label: 'Officer Location', render: r => r.office_location ?? 'Unattributed' },
        { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo ?? 0) },
      ]
    default: // Opening Equity
      return [
        { key: 'branch_name', label: 'Branch' },
        { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo ?? 0) },
        { key: 'is_estimated', label: 'Estimated?', render: r => r.is_estimated ? 'Yes' : 'No' },
        { key: 'note', label: 'Note' },
      ]
  }
}

export default function BalanceSheet() {
  const [branch, setBranch] = useState('')
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

  async function openDrill(row: Line) {
    setDrill(row)
    setEntries(null)
    setEntriesLoading(true)
    try {
      const q = new URLSearchParams()
      q.set('line', row.line)
      if (branch) q.set('branch', branch)
      q.set('currency', row.currency)
      const res = await apiFetch(`/api/finance/position/entries?${q.toString()}`)
      setEntries(unwrap<{ entries: Entry[] }>(res).entries)
    } catch (e: any) {
      setEntries([])
    } finally {
      setEntriesLoading(false)
    }
  }

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
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)' }}>Location</span>
          <SegmentedToggle value={branch} onChange={setBranch} options={BRANCHES as any} />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Assets" value={fmtKoboExact(primary?.assets_kobo ?? 0)} icon="account_balance_wallet" accent={NAVY} loading={loading} />
        <KpiCard label="Total Liabilities" value={fmtKoboExact(primary?.liabilities_kobo ?? 0)} icon="savings" accent={AMBER} loading={loading} />
        <KpiCard label="Net Position" value={fmtKoboExact(primary?.net_position_kobo ?? 0)}
          sub="assets − liabilities; not equity" icon={((primary?.net_position_kobo ?? 0) >= 0) ? 'trending_up' : 'trending_down'}
          accent={(primary?.net_position_kobo ?? 0) >= 0 ? GREEN : RED} loading={loading} />
        <KpiCard label="Implied Equity" value={fmtKoboExact(impliedEquity)}
          sub={`opening (2026-01-01) + retained earnings since ${data?.retained_earnings_since ?? '2026-07-01'}`}
          icon="account_balance" accent={GREEN} loading={loading} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        {(data?.totals ?? []).map(t => {
          const lines = (data?.lines ?? []).filter(l => l.currency === t.currency)
          return (
            <div key={t.currency} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
              <SectionCard title={`Assets · ${t.currency}`} subtitle={fmtKoboExact(t.assets_kobo)}>
                <DataTable cols={cols} rows={lines.filter(l => l.side === 'Asset')} keyFn={(r, i) => `a-${t.currency}-${i}`} onRowClick={openDrill} emptyText="No asset lines" />
              </SectionCard>
              <SectionCard title={`Liabilities · ${t.currency}`} subtitle={fmtKoboExact(t.liabilities_kobo)}>
                <DataTable cols={cols} rows={lines.filter(l => l.side === 'Liability')} keyFn={(r, i) => `l-${t.currency}-${i}`} onRowClick={openDrill} emptyText="No liability lines" />
              </SectionCard>
              {lines.some(l => l.side === 'Equity') && (
                <SectionCard title={`Equity (Frozen Opening) · ${t.currency}`} subtitle="2026-01-01, flagged estimate — see footnote" style={{ gridColumn: '1 / -1' }}>
                  <DataTable cols={cols} rows={lines.filter(l => l.side === 'Equity')} keyFn={(r, i) => `e-${t.currency}-${i}`} onRowClick={openDrill} emptyText="No equity lines" />
                </SectionCard>
              )}
            </div>
          )
        })}
      </div>

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4], lineHeight: 1.55 }}>
        {data?.basis}
        {' '}Implied Equity adds Retained Earnings (income minus expense from Udara's own GL, {data?.retained_earnings_since ?? '2026-07-01'}
        {' '}onward only — Jan–Jun 2026 has no GL feed at all) to the frozen 2026-01-01 Opening Equity estimate. It will not exactly
        reconcile to Net Position above; both are shown rather than forcing a balance.
      </p>

      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill?.line ?? ''} width={760}>
        {drill && (
          <>
            <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 0 }}>
              {drill.currency} · {fmtKoboExact(drill.amount_kobo)} across {drill.items} items
            </p>
            <DataTable cols={entryColsFor(drill.line)} rows={entries ?? []} keyFn={(r, i) => i} loading={entriesLoading}
              emptyText="No records found for this line" />
          </>
        )}
      </Modal>
    </Page>
  )
}
