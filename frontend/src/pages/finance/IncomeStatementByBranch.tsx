import { useEffect, useState, useMemo } from 'react'
import { Page, DataTable, ErrBanner, KpiCard, SegmentedToggle, DateFilter, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LedgerTree } from '../../components/finance/LedgerTree'
import type { LedgerSection, LedgerLine, LedgerAccount } from '../../components/finance/LedgerTree'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtDate } from '../../lib/fmt'
import { GREEN, RED, NAVY, TEXT, FW, SP } from '../../lib/design'

// Real Income Statement, branch-split, from Udara's own GL (migration 342's
// gl_account_lines, read directly off app.cbs_gl_postings — not the pre-aggregated
// app.income_statement_by_branch view, which has no date dimension left in its output to
// filter by; see backend-go/handlers/income_statement_branch.go's header). Also absorbs
// what used to be the separate Revenue Breakdown page: card joining fees and loan fees
// are folded in here as their own lines, since they answer the same question this page
// now does natively.
//
// Rendered as a real ledger (LedgerTree): Income/Expense sections expand to statement
// lines (Card Interest Income, Rent...), which expand to the individual accounts/products
// behind them, each with its own subtotal, down to one grand total (Net) at the foot —
// not a flat table. Every account row still drills into its real GL entries on click.

interface Line { branch: string; statement_line: string; product_label: string | null; statement: 'income' | 'expense'; amount_kobo: number; postings: number }
interface Totals { branch: string; statement: string; amount_kobo: number }
interface Payload { lines: Line[]; totals: Totals[]; coverage_start: string }

interface Entry {
  id: number; financial_date?: string; narration?: string; posting_reference?: string
  account_number?: string; account_name?: string; side?: string; amount_kobo?: number
  // fee_income / loan_fee_income shaped entries
  fee_type?: string; branch_name?: string; loan_account?: string
}

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
] as const

const entryCols: TableCol<Entry>[] = [
  { key: 'financial_date', label: 'Date', render: r => <span>{r.financial_date ? fmtDate(r.financial_date) : '—'}</span> },
  { key: 'account_name', label: 'Account', render: r => <span>{r.account_name ?? r.fee_type ?? '—'}</span> },
  { key: 'narration', label: 'Narration', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.narration ?? r.posting_reference ?? r.loan_account ?? '—'}</span> },
  { key: 'side', label: 'Side', render: r => r.side ? <span style={{ textTransform: 'capitalize' }}>{r.side}</span> : '—' },
  { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo ?? 0) },
]

export default function IncomeStatementByBranch() {
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
      const res = await apiFetch(`/api/finance/income-statement-by-branch?${q.toString()}`)
      setData(unwrap<Payload>(res))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load income statement')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [branch, dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  const income = useMemo(() => (data?.lines ?? []).filter(l => l.statement === 'income'), [data])
  const expense = useMemo(() => (data?.lines ?? []).filter(l => l.statement === 'expense'), [data])
  const totalIncome = income.reduce((s, l) => s + Number(l.amount_kobo), 0)
  const totalExpense = expense.reduce((s, l) => s + Number(l.amount_kobo), 0)
  const net = totalIncome - totalExpense

  async function openDrill(row: Line) {
    setDrill(row)
    setEntries(null)
    setEntriesLoading(true)
    try {
      const q = new URLSearchParams()
      q.set('statement_line', row.statement_line)
      q.set('product_label', row.product_label ?? '')
      if (branch) q.set('branch', branch)
      if (dateFrom) q.set('date_from', dateFrom)
      if (dateTo) q.set('date_to', dateTo)
      const res = await apiFetch(`/api/finance/income-statement-by-branch/entries?${q.toString()}`)
      setEntries(unwrap<{ entries: Entry[] }>(res).entries)
    } catch (e: any) {
      setEntries([])
    } finally {
      setEntriesLoading(false)
    }
  }

  // Lines (flat, from the API) -> statement_line groups -> account/product rows, the
  // shape LedgerTree renders. A line with exactly one account sharing its own name
  // collapses to a single clickable row instead of a pointless one-item expand.
  function buildLines(rows: Line[]): LedgerLine[] {
    const byLine = new Map<string, Line[]>()
    for (const r of rows) {
      const arr = byLine.get(r.statement_line) ?? []
      arr.push(r)
      byLine.set(r.statement_line, arr)
    }
    return [...byLine.entries()].map(([statementLine, lineRows]) => {
      // Consolidated shows every branch's contribution as its own row (not summed away),
      // so the same product can appear twice — "Platinum" for Lagos and for Abuja. Suffix
      // with the branch whenever more than one branch is present, so they read as two
      // different rows rather than a duplicate.
      const multiBranch = new Set(lineRows.map(r => r.branch)).size > 1
      const accounts: LedgerAccount[] = lineRows.map((r, i) => ({
        key: `${statementLine}-${r.product_label ?? 'none'}-${r.branch}-${i}`,
        label: r.product_label ?? statementLine,
        meta: multiBranch ? r.branch : undefined,
        amount: Number(r.amount_kobo),
        postings: r.postings,
        onClick: () => openDrill(r),
      }))
      const soleAccount = accounts.length === 1 && accounts[0].label === statementLine
      return {
        key: statementLine,
        label: statementLine,
        accounts,
        onClick: soleAccount ? accounts[0].onClick : undefined,
      }
    }).sort((a, b) => {
      const at = a.accounts.reduce((s, x) => s + x.amount, 0)
      const bt = b.accounts.reduce((s, x) => s + x.amount, 0)
      return bt - at
    })
  }

  const sections: LedgerSection[] = [
    { key: 'income', label: 'Income', lines: buildLines(income), accent: GREEN },
    { key: 'expense', label: 'Expense', lines: buildLines(expense), accent: RED },
  ]

  return (
    <Page title="Income Statement" subtitle={`By branch, from Udara's own GL · from ${data?.coverage_start ?? '2026-07-01'}`}
      back={{ label: 'Finance', to: '/finance' }} loading={loading && !data}
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
        <KpiCard label="Total Income" value={fmtKoboExact(totalIncome)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="Total Expense" value={fmtKoboExact(totalExpense)} icon="trending_down" accent={NAVY} loading={loading} />
        <KpiCard label="Net" value={fmtKoboExact(net)} icon={net >= 0 ? 'add_circle' : 'remove_circle'}
          accent={net >= 0 ? GREEN : RED} loading={loading} />
      </div>

      <LedgerTree sections={sections} grandTotalLabel="Net" grandTotal={net} fmtAmount={fmtKoboExact} loading={loading && !data}
        emptyText="No income or expense lines in this period" />

      <Modal open={!!drill} onClose={() => setDrill(null)}
        title={drill ? `${drill.statement_line}${drill.product_label ? ' — ' + drill.product_label : ''}` : ''} width={760}>
        {drill && (
          <>
            <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 0 }}>
              {drill.branch} · {fmtKoboExact(drill.amount_kobo)} across {drill.postings} postings
            </p>
            <DataTable cols={entryCols} rows={entries ?? []} keyFn={(r, i) => r.id ?? i} loading={entriesLoading}
              emptyText="No entries found for this line" />
          </>
        )}
      </Modal>
    </Page>
  )
}
