import { useEffect, useState, useMemo } from 'react'
import { Page, DataTable, ErrBanner, KpiCard, SegmentedToggle, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LedgerTree } from '../../components/finance/LedgerTree'
import type { LedgerSection } from '../../components/finance/LedgerTree'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtDate } from '../../lib/fmt'
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
// date" balance sheet from.
//
// Rendered as a real ledger (LedgerTree), one per currency: Assets/Liabilities/Equity
// sections, each line directly drillable into the real loan/FD/card records behind it —
// these lines are already the finest grain financial_position_by_branch offers (no
// per-product breakdown exists under "Loan Receivable" the way Income Statement's lines
// break into products), so each is a single clickable row rather than a three-level
// expand. Net Position (Assets − Liabilities) is the grand total; Equity is excluded from
// it deliberately, same framing the KPI strip already uses.

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

  function sectionsFor(currency: string, lines: Line[]): LedgerSection[] {
    const forSide = (side: Line['side']): LedgerSection['lines'] =>
      lines.filter(l => l.side === side).map(l => ({
        key: `${currency}-${l.line}`,
        label: l.line,
        meta: l.gl_code,
        accounts: [{ key: `${currency}-${l.line}-acc`, label: l.line, amount: Number(l.amount_kobo), postings: l.items, onClick: () => openDrill(l) }],
        onClick: () => openDrill(l),
      }))
    const out: LedgerSection[] = [
      { key: 'assets', label: 'Assets', lines: forSide('Asset'), accent: NAVY },
      { key: 'liabilities', label: 'Liabilities', lines: forSide('Liability'), accent: AMBER },
    ]
    if (lines.some(l => l.side === 'Equity')) {
      out.push({ key: 'equity', label: 'Equity (Frozen Opening) — not included in Net Position', lines: forSide('Equity'), accent: GREEN })
    }
    return out
  }

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

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[5] }}>
        {(data?.totals ?? []).map(t => {
          const lines = (data?.lines ?? []).filter(l => l.currency === t.currency)
          return (
            <div key={t.currency}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: SP[2] }}>
                {t.currency}
              </div>
              <LedgerTree
                sections={sectionsFor(t.currency, lines)}
                grandTotalLabel="Net Position"
                grandTotal={t.assets_kobo - t.liabilities_kobo}
                fmtAmount={fmtKoboExact}
                loading={loading && !data}
                emptyText={`No ${t.currency} lines`}
                unitLabel="items"
              />
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
