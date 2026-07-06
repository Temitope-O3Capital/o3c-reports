import { useState, useRef, useEffect, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BudgetLine {
  id: number
  cost_centre: string
  category: string
  budget_amount: number
  actual_amount: number
  committed_amount: number
  period: string
}

// ── Columns ───────────────────────────────────────────────────────────────────

const COLS: TableCol<BudgetLine>[] = [
  { key: 'cost_centre', label: 'Cost Centre', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'budget_amount', label: 'Budget ₦', align: 'right', sortable: true,
    render: r => <span style={NUM}>{fmtKobo(r.budget_amount)}</span> },
  { key: 'actual_amount', label: 'Actual ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: r.actual_amount > r.budget_amount ? RED : 'var(--txt)' }}>{fmtKobo(r.actual_amount)}</span> },
  { key: 'committed_amount', label: 'Committed ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.committed_amount)}</span> },
  { key: '_variance', label: 'Variance', align: 'right', render: r => {
    const v = r.budget_amount - r.actual_amount - r.committed_amount
    const pct = r.budget_amount > 0 ? ((Math.abs(v) / r.budget_amount) * 100).toFixed(1) : '0'
    return (
      <div style={{ textAlign: 'right' }}>
        <div style={{ ...NUM, fontWeight: 600, color: v >= 0 ? GREEN : RED }}>{fmtKobo(Math.abs(v))}</div>
        <div style={{ fontSize: 10.5, color: 'var(--txt2)' }}>{v >= 0 ? 'remaining' : `${pct}% over`}</div>
      </div>
    )
  }},
  { key: '_utilisation', label: 'Utilisation', align: 'right', render: r => {
    const pct = r.budget_amount > 0 ? ((r.actual_amount / r.budget_amount) * 100) : 0
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 6, background: 'var(--bdr)', borderRadius: 3, minWidth: 60, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: pct > 100 ? RED : pct > 80 ? AMBER : GREEN, borderRadius: 3, transition: 'width 0.3s' }} />
        </div>
        <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, color: pct > 100 ? RED : pct > 80 ? AMBER : GREEN, minWidth: 36, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
      </div>
    )
  }},
]

function exportBudgetCsv(rows: BudgetLine[]) {
  const header = ['Cost Centre', 'Category', 'Budget (₦)', 'Actual (₦)', 'Committed (₦)', 'Variance (₦)', 'Period']
  const lines = rows.map(r => [
    `"${String(r.cost_centre ?? '').replace(/"/g, '""')}"`,
    `"${String(r.category ?? '').replace(/"/g, '""')}"`,
    (r.budget_amount / 100).toFixed(2),
    (r.actual_amount / 100).toFixed(2),
    (r.committed_amount / 100).toFixed(2),
    ((r.budget_amount - r.actual_amount - r.committed_amount) / 100).toFixed(2),
    r.period ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `budget-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Upload button ─────────────────────────────────────────────────────────────

function UploadBudgetButton() {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input ref={inputRef} type="file" accept=".csv,.xlsx" style={{ display: 'none' }} onChange={() => toast.info('Budget file import coming soon')} />
      <button onClick={() => inputRef.current?.click()} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 14px', borderRadius: 8, border: '1px solid var(--bdr)',
        background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>upload</span>Load Budget File
      </button>
    </>
  )
}

// ── Tooltip ────────────────────────────────────────────────────────────────────

function BudgetTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: 'var(--txt)', marginBottom: 6 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.fill, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, color: 'var(--txt)', fontWeight: 600 }}>{fmtKobo(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceBudget() {
  const [centreFilter, setCentreFilter] = useState('')
  const [period, setPeriod] = useState('2026-07')
  const [rows, setRows] = useState<BudgetLine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await apiFetch<BudgetLine[]>(`/api/finance/budget?period=${period}`)
      setRows(data ?? [])
    } catch (e: any) {
      setError(e.message ?? 'Failed to load budget')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  const centres = [...new Set(rows.map(l => l.cost_centre))]
  const filtered = rows.filter(l => !centreFilter || l.cost_centre === centreFilter)

  // Aggregate for chart
  const chartData = centres.map(c => {
    const lines = rows.filter(l => l.cost_centre === c)
    return {
      centre: c,
      budget: lines.reduce((s, l) => s + l.budget_amount, 0),
      actual: lines.reduce((s, l) => s + l.actual_amount, 0),
    }
  })

  const totalBudget = filtered.reduce((s, l) => s + l.budget_amount, 0)
  const totalActual = filtered.reduce((s, l) => s + l.actual_amount, 0)

  return (
    <Page
      title="Budget vs Actuals"
      subtitle="Cost centre budgets, actual spend, and variance"
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => exportBudgetCsv(filtered)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 8, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>Export CSV
          </button>
          <UploadBudgetButton />
          <select value={period} onChange={e => setPeriod(e.target.value)} style={filterInputStyle}>
            <option value="2026-07">July 2026</option>
            <option value="2026-06">June 2026</option>
            <option value="2026-05">May 2026</option>
          </select>
        </div>
      }
    >
      {error && <ErrBanner error={error} onRetry={load} />}
      {loading && <Spinner />}

      {!loading && !error && (
        <>
          {/* Summary strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
            <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 6 }}>Total Budget</div>
              <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: 'var(--txt)' }}>{fmtKobo(totalBudget)}</div>
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 6 }}>Actual Spend</div>
              <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: totalActual > totalBudget ? RED : 'var(--txt)' }}>{fmtKobo(totalActual)}</div>
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 6 }}>Budget Utilisation</div>
              <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: GREEN }}>
                {totalBudget > 0 ? fmtPct((totalActual / totalBudget) * 100) : '0%'}
              </div>
            </div>
          </div>

          {/* Bar chart */}
          <SectionCard title="Budget vs Actual by Cost Centre" style={{ marginBottom: 16 }}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                <XAxis dataKey="centre" tick={{ fontSize: 11, fill: '#9AA4B8' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={72} />
                <Tooltip content={<BudgetTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="budget" name="Budget" fill="#0E2841" radius={[3, 3, 0, 0]} />
                <Bar dataKey="actual" name="Actual" fill="#C00000" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </SectionCard>

          {/* Filter + table */}
          <FilterBar onReset={() => setCentreFilter('')}>
            <select value={centreFilter} onChange={e => setCentreFilter(e.target.value)} style={filterInputStyle}>
              <option value="">All cost centres</option>
              {centres.map(c => <option key={c}>{c}</option>)}
            </select>
          </FilterBar>

          <SectionCard padding={false} actions={
            <button onClick={() => exportBudgetCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
              Export CSV
            </button>
          }>
            <DataTable
              cols={COLS}
              rows={filtered}
              keyFn={r => r.id}
              emptyText="No budget lines for this period"
              pageSize={20}
            />
          </SectionCard>
        </>
      )}
    </Page>
  )
}
