import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  ErrBanner, ColDef, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

interface SettlementRow {
  settlement_date: string
  txn_count: number
  credits: number
  debits: number
  net_position: number
}

const COLS: ColDef<SettlementRow>[] = [
  { key: 'settlement_date', label: 'Date' },
  { key: 'txn_count', label: 'Transactions', right: true,
    render: r => <span className="kpi-number">{n(r.txn_count).toLocaleString()}</span> },
  { key: 'credits', label: 'Credits (₦)', right: true,
    render: r => <span className="kpi-number font-semibold" style={{ color: GREEN }}>{fmt(r.credits)}</span> },
  { key: 'debits', label: 'Debits (₦)', right: true,
    render: r => <span className="kpi-number font-semibold" style={{ color: RED }}>{fmt(r.debits)}</span> },
  { key: 'net_position', label: 'Net Position (₦)', right: true,
    render: r => {
      const v = n(r.net_position)
      return <span className="kpi-number font-semibold" style={{ color: v >= 0 ? GREEN : RED }}>{fmt(v)}</span>
    } },
]

export default function Settlement() {
  const [data, setData]     = useState<SettlementRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')
  const [from, setFrom]     = useState(monthStart())
  const [to, setTo]         = useState(today())

  useEffect(() => {
    setLoading(true)
    setError('')
    apiFetch(`/api/settlement/summary?date_from=${from}&date_to=${to}`)
      .then(res => {
        const rows: SettlementRow[] = Array.isArray(res) ? res : (res?.data ?? res?.rows ?? [])
        setData(rows)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [from, to])

  const totalCredits = data.reduce((s, r) => s + n(r.credits), 0)
  const totalDebits  = data.reduce((s, r) => s + n(r.debits), 0)
  const netPosition  = data.reduce((s, r) => s + n(r.net_position), 0)
  const totalTxns    = data.reduce((s, r) => s + n(r.txn_count), 0)

  return (
    <Page
      dept="Operations"
      title="Settlement"
      subtitle="Daily card processor settlement breakdown"
      actions={
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      }
    >
      <ErrBanner msg={error} />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard
          label="Total Credits"
          value={loading ? '—' : fmt(totalCredits)}
          icon="arrow_downward"
          accent={GREEN}
          loading={loading}
        />
        <KpiCard
          label="Total Debits"
          value={loading ? '—' : fmt(totalDebits)}
          icon="arrow_upward"
          accent={RED}
          loading={loading}
        />
        <KpiCard
          label="Net Position"
          value={loading ? '—' : fmt(netPosition)}
          icon="account_balance"
          accent={netPosition >= 0 ? NAVY : RED}
          loading={loading}
        />
        <KpiCard
          label="Transaction Count"
          value={loading ? '—' : fmtNum(totalTxns)}
          icon="receipt_long"
          accent={AMBER}
          loading={loading}
        />
      </div>

      {/* Credits vs Debits bar chart */}
      <div className="mb-5">
        <SectionCard
          title="Credits vs Debits by Day"
          subtitle="Settlement amounts per day in the selected period"
        >
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex items-end gap-3" style={{ height: 220 }}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${25 + i * 10}%` }} />
                ))}
              </div>
            ) : data.length === 0 ? (
              <p className="text-[13px] py-16 text-center" style={{ color: 'var(--txt2)' }}>No settlement data for this period</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 4 }} barSize={14}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="settlement_date" tick={{ fontSize: 10, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                    tickFormatter={v => fmt(v)} width={60}
                    domain={[(dataMin: number) => dataMin < 0 ? Math.floor(dataMin * 1.12) : 0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 10]} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      return (
                        <div className="rounded-lg border px-3 py-2.5 shadow-lg"
                          style={{ background: 'var(--card)', borderColor: 'var(--bdr)', fontSize: 12 }}>
                          <p className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--txt2)' }}>{label}</p>
                          {payload.map((p: any, i: number) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.fill }} />
                              <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
                              <span className="font-semibold font-mono" style={{ color: 'var(--txt)' }}>{fmt(p.value)}</span>
                            </div>
                          ))}
                        </div>
                      )
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                  <Bar dataKey="credits" name="Credits" fill={GREEN} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="debits"  name="Debits"  fill={RED}   radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </SectionCard>
      </div>

      {/* Detail table */}
      <SectionCard
        title="Settlement Breakdown"
        subtitle="Row-by-row daily settlement detail"
        badge={loading ? undefined : data.length}
      >
        <DataTable<SettlementRow>
          cols={COLS}
          rows={data}
          loading={loading}
          emptyIcon="compare_arrows"
          emptyMsg="No settlement records for this period"
        />
      </SectionCard>
    </Page>
  )
}
