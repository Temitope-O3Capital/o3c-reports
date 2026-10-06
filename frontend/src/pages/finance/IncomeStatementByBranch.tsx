import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { ErrBanner } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact } from '../../lib/fmt'
import { NAVY, GREEN, RED, TEXT, FW, SP } from '../../lib/design'

// Real Income Statement, branch-split, from Udara's own GL (app.income_statement_by_branch,
// migration 344) — not the transaction-derived /income-statement this app already had
// (that one stays as-is; this is the new, GL-account-based, branch-split one the finance
// meeting asked for).

interface Line { branch: string; statement_line: string; product_label: string | null; statement: 'income' | 'expense'; amount_kobo: number; postings: number }
interface Totals { branch: string; statement: string; amount_kobo: number }
interface Payload { lines: Line[]; totals: Totals[]; coverage_start: string }

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
]

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

export default function IncomeStatementByBranch() {
  const [branch, setBranch] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = branch ? `?branch=${branch}` : ''
      const res = await apiFetch(`/api/finance/income-statement-by-branch${q}`)
      setData(unwrap<Payload>(res))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load income statement')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [branch]) // eslint-disable-line react-hooks/exhaustive-deps

  const income = useMemo(() => (data?.lines ?? []).filter(l => l.statement === 'income'), [data])
  const expense = useMemo(() => (data?.lines ?? []).filter(l => l.statement === 'expense'), [data])
  const totalIncome = income.reduce((s, l) => s + Number(l.amount_kobo), 0)
  const totalExpense = expense.reduce((s, l) => s + Number(l.amount_kobo), 0)
  const net = totalIncome - totalExpense

  const cols: TableCol<Line>[] = [
    { key: 'statement_line', label: 'Line' },
    { key: 'product_label', label: 'Detail', render: r => r.product_label ?? '—' },
    { key: 'branch', label: 'Branch' },
    { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo) },
    { key: 'postings', label: 'Postings', align: 'right' },
  ]

  return (
    <Page title="Income Statement" subtitle={`By branch, from Udara's own GL · from ${data?.coverage_start ?? '2026-07-01'}`}
      back={{ label: 'Finance', to: '/finance' }} loading={loading && !data}
      actions={
        <div style={{ display: 'flex', gap: 4 }}>
          {BRANCHES.map(b => (
            <button key={b.value} onClick={() => setBranch(b.value)}
              style={{
                padding: '6px 12px', borderRadius: 8, fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: '1px solid var(--card-bdr)', cursor: 'pointer',
                background: branch === b.value ? NAVY : 'var(--card)',
                color: branch === b.value ? '#fff' : 'var(--txt2)',
              }}>
              {b.label}
            </button>
          ))}
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Total Income"><div style={BIG}>{fmtKoboExact(totalIncome)}</div></SectionCard>
        <SectionCard title="Total Expense"><div style={BIG}>{fmtKoboExact(totalExpense)}</div></SectionCard>
        <SectionCard title="Net">
          <div style={{ ...BIG, color: net >= 0 ? GREEN : RED }}>{fmtKoboExact(net)}</div>
        </SectionCard>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
        <SectionCard title="Income"><DataTable cols={cols} rows={income} keyFn={(r, i) => `inc-${i}`} /></SectionCard>
        <SectionCard title="Expense"><DataTable cols={cols} rows={expense} keyFn={(r, i) => `exp-${i}`} /></SectionCard>
      </div>
    </Page>
  )
}

const BIG = { fontSize: 24, fontWeight: 700, color: 'var(--txt)', letterSpacing: '-0.6px' }
