import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, SectionCard, DataTable, ErrBanner, Sk, FilterBar, filterInputStyle } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface IncomeRow {
  date: string
  source: string
  type: 'Interest' | 'Fees' | 'Penalty'
  amount_kobo: number
  ref: string
}

interface ChartRow {
  type: string
  current: number
  previous: number
}

// ── Type pill ─────────────────────────────────────────────────────────────────

const TYPE_STYLE: Record<string, { bg: string; color: string }> = {
  Interest: { bg: 'rgba(22,163,74,.12)',  color: GREEN },
  Fees:     { bg: 'rgba(217,119,6,.12)',  color: AMBER },
  Penalty:  { bg: 'rgba(192,0,0,.1)',     color: RED },
}

function TypePill({ type }: { type: string }) {
  const s = TYPE_STYLE[type] ?? { bg: 'var(--chip-bg)', color: 'var(--chip-txt)' }
  return (
    <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20, ...s }}>
      {type}
    </span>
  )
}

// ── Table columns ─────────────────────────────────────────────────────────────

const COLS: TableCol<IncomeRow>[] = [
  { key: 'date', label: 'Date', sortable: true, width: 110,
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.date)}</span> },
  { key: 'source', label: 'Source', sortable: true,
    render: r => <span style={{ fontSize: 13, color: 'var(--txt)' }}>{r.source}</span> },
  { key: 'type', label: 'Type', width: 100,
    render: r => <TypePill type={r.type} /> },
  { key: 'amount_kobo', label: 'Amount ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(r.amount_kobo)}</span> },
  { key: 'ref', label: 'Ref', width: 60,
    render: r => <span style={{ ...NUM, fontSize: 11.5, color: 'var(--txt2)' }}>{r.ref}</span> },
]

// ── Chart tooltip ─────────────────────────────────────────────────────────────

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--txt)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.fill, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceIncome() {
  const [rows, setRows]         = useState<IncomeRow[]>([])
  const [chart, setChart]       = useState<ChartRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [offset, setOffset]     = useState(0)
  const PAGE = 200

  const load = useCallback(async (off = 0) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(off) })
      if (typeFilter) params.set('type', typeFilter)
      if (dateFrom)   params.set('date_from', dateFrom)
      if (dateTo)     params.set('date_to', dateTo)
      const data = await apiFetch<IncomeRow[]>(`/api/finance/income?${params}`)
      setRows(data ?? [])
      setOffset(off)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [typeFilter, dateFrom, dateTo])

  useEffect(() => { load(0) }, [load])

  useEffect(() => {
    apiFetch<ChartRow[]>('/api/finance/income/chart')
      .then(d => setChart(d ?? []))
      .catch(() => {})
  }, [])

  return (
    <Page title="Income" subtitle="Card billing cycle — interest, fees & penalties">
      <ErrBanner error={error} onRetry={() => setError(null)} />

      {/* Chart */}
      <SectionCard title="Income by Type" subtitle="Current cycle vs previous cycle" style={{ marginBottom: 20 }}>
        {chart.length === 0 ? (
          <Sk h={200} />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
              <XAxis dataKey="type" tick={{ fontSize: 12, fill: '#9AA4B8' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={80} />
              <Tooltip content={<ChartTip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="current"  name="Current cycle"  fill={NAVY}  radius={[3,3,0,0]} />
              <Bar dataKey="previous" name="Previous cycle" fill="#9AA4B8" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </SectionCard>

      {/* Filter bar */}
      <FilterBar>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          style={{ ...filterInputStyle, minWidth: 140 }}
        >
          <option value="">All types</option>
          <option value="Interest">Interest</option>
          <option value="Fees">Fees</option>
          <option value="Penalty">Penalty</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          style={{ ...filterInputStyle, minWidth: 140 }}
          placeholder="From"
        />
        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          style={{ ...filterInputStyle, minWidth: 140 }}
          placeholder="To"
        />
      </FilterBar>

      {/* Table */}
      <SectionCard padding={false}>
        <DataTable
          cols={COLS}
          rows={rows}
          keyFn={(r, i) => `${r.date}-${r.ref}-${r.type}-${i}`}
          loading={loading}
          emptyText="No income records for the selected filters"
        />
      </SectionCard>

      {/* Pagination */}
      {(rows.length === PAGE || offset > 0) && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 12 }}>
          <button
            disabled={offset === 0}
            onClick={() => load(offset - PAGE)}
            style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.4 : 1 }}
          >← Prev</button>
          <button
            disabled={rows.length < PAGE}
            onClick={() => load(offset + PAGE)}
            style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: rows.length < PAGE ? 'not-allowed' : 'pointer', opacity: rows.length < PAGE ? 0.4 : 1 }}
          >Next →</button>
        </div>
      )}
    </Page>
  )
}
