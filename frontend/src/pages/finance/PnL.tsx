import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, filterInputStyle, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, monthStart, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProductLine {
  product:  string
  revenue:  number
  cost:     number
  net:      number
}

interface PnLData {
  lines:          ProductLine[]
  total_revenue:  number
  total_cost:     number
  net_income:     number
  data_available: boolean
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function periodDates(period: string): { from: string; to: string } {
  const now   = new Date()
  const pad   = (n: number) => String(n).padStart(2, '0')
  const ymd   = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
  const today = ymd(now)

  if (period === 'mtd') {
    return { from: `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`, to: today }
  }
  if (period === 'ytd') {
    return { from: `${now.getFullYear()}-01-01`, to: today }
  }
  // qtd
  const q   = Math.floor(now.getMonth() / 3)
  const qm  = q * 3
  return { from: `${now.getFullYear()}-${pad(qm+1)}-01`, to: today }
}

// ── Table cols ─────────────────────────────────────────────────────────────────

const LINE_COLS: TableCol<ProductLine>[] = [
  { key: 'product', label: 'Product', render: r => <span style={{ fontWeight: FW.medium }}>{r.product}</span> },
  { key: 'revenue', label: 'Revenue ₦',  align: 'right', render: r => <span style={NUM}>{fmtKobo(r.revenue)}</span> },
  { key: 'cost',    label: 'Cost ₦',     align: 'right', render: r => <span style={{ ...NUM, color: RED }}>{fmtKobo(r.cost)}</span> },
  { key: 'net',     label: 'Net ₦',      align: 'right', render: r => (
    <span style={{ ...NUM, color: r.net >= 0 ? GREEN : RED, fontWeight: FW.semibold }}>{fmtKobo(r.net)}</span>
  )},
]

// ── Tooltip ────────────────────────────────────────────────────────────────────

function PnLTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.md, padding: '10px 14px', fontSize: TEXT.sm }}>
      <div style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: SP[1] }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.fill, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, color: 'var(--txt)', fontWeight: FW.semibold }}>{fmtKobo(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinancePnL() {
  const [period,   setPeriod]   = useState('mtd')
  const [product,  setProduct]  = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [data,     setData]     = useState<PnLData | null>(null)
  const [loading,  setLoading]  = useState(false)

  function handlePeriod(p: string) {
    setPeriod(p)
    const { from, to } = periodDates(p)
    setDateFrom(from)
    setDateTo(to)
  }

  useEffect(() => {
    const params = new URLSearchParams({ from: dateFrom, to: dateTo })
    if (product) params.set('product', product)
    setLoading(true)
    apiFetch<{ data: PnLData }>(`/api/finance/pnl?${params}`)
      .then(r => setData(r.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo, product])

  const lines   = data?.lines          ?? []
  const totRev  = data?.total_revenue  ?? 0
  const totCost = data?.total_cost     ?? 0
  const netInc  = data?.net_income     ?? 0

  function exportPnlCsv(data: ProductLine[]) {
    const header = ['Product', 'Revenue ₦', 'Cost ₦', 'Net ₦']
    const rows = data.map(r => [
      `"${String(r.product ?? '').replace(/"/g, '""')}"`,
      (r.revenue / 100).toFixed(2),
      (r.cost / 100).toFixed(2),
      (r.net / 100).toFixed(2),
    ].join(','))
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `pnl-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="Profit & Loss"
      subtitle="Revenue, cost of funds, provisioning, net income"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <select value={product} onChange={e => setProduct(e.target.value)} style={filterInputStyle}>
            <option value="">All products</option>
            <option value="salary_loan">Salary Loan</option>
            <option value="business_loan">Business Loan</option>
            <option value="credit_card">Credit Card</option>
            <option value="fixed_deposit">Fixed Deposit</option>
          </select>
          <select value={period} onChange={e => handlePeriod(e.target.value)} style={filterInputStyle}>
            <option value="mtd">Month to Date</option>
            <option value="qtd">Quarter to Date</option>
            <option value="ytd">Year to Date</option>
          </select>
        </div>
      }
    >
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5], opacity: loading ? 0.6 : 1 }}>
        <KpiCard label="Revenue"       value={fmtKobo(totRev)}              icon="trending_up"    accent={GREEN} />
        <KpiCard label="Cost of Funds" value={fmtKobo(totCost)}             icon="payments"       accent={AMBER} />
        <KpiCard label="Gross Margin"  value={totRev ? `${((netInc/totRev)*100).toFixed(1)}%` : '—'} icon="percent" accent={NAVY} />
        <KpiCard label="Net Income"    value={fmtKobo(netInc)}              icon="account_balance" accent={netInc >= 0 ? NAVY : RED} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        {/* Bar — by product line */}
        <SectionCard title="P&L by Product Line" subtitle="Revenue vs cost">
          {lines.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={lines} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" />
                <XAxis dataKey="product" tick={{ fontSize: TEXT.xs, fill: 'var(--txt2)' }} />
                <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} width={70} />
                <Tooltip content={<PnLTooltip />} />
                <Bar dataKey="revenue" name="Revenue" fill={GREEN}  radius={[3,3,0,0]} />
                <Bar dataKey="cost"    name="Cost"    fill={AMBER}  radius={[3,3,0,0]} />
                <Bar dataKey="net"     name="Net"     fill={NAVY}   radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--txt2)', fontSize: TEXT.base, flexDirection: 'column', gap: SP[2] }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], opacity: 0.3 }}>bar_chart</span>
              {loading ? 'Loading…' : 'No transaction data for this period'}
            </div>
          )}
        </SectionCard>

        {/* Summary card */}
        <SectionCard title="Period Summary">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 8 }}>
            {[
              { label: 'Total Revenue',  value: totRev,  color: GREEN },
              { label: 'Total Cost',     value: totCost, color: RED   },
              { label: 'Net Income',     value: netInc,  color: netInc >= 0 ? NAVY : RED },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>{label}</span>
                <span style={{ ...NUM, fontWeight: FW.bold, color }}>{fmtKobo(value)}</span>
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>Product Lines</span>
                <span style={{ ...NUM, fontWeight: FW.semibold }}>{lines.length}</span>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Product breakdown table */}
      <SectionCard title="P&L by Product" subtitle="Revenue, cost and net per product" padding={false} actions={lines.length > 0 ? (
        <button onClick={() => exportPnlCsv(lines)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
          Export CSV
        </button>
      ) : undefined}>
        <DataTable
          cols={LINE_COLS}
          rows={lines}
          keyFn={r => r.product}
          emptyText={loading ? 'Loading…' : 'No P&L data available for this period'}
          searchKeys={['product']}
          pageSize={20}
        />
      </SectionCard>
    </Page>
  )
}
