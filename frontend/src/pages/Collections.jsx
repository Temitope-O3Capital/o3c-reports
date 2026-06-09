import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, AreaChartCard, ProgressListCard, fmt, fmtNum } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

function calcMoM(arr, key) {
  if (!arr || arr.length < 2) return null
  const prev = Number(arr[arr.length - 2]?.[key] ?? 0)
  const curr = Number(arr[arr.length - 1]?.[key] ?? 0)
  if (prev === 0) return null
  return ((curr - prev) / prev) * 100
}

function ModeBadge({ mode }) {
  const m = (mode || '').toUpperCase()
  if (m === 'NDD')      return <span className="badge badge-blue">NDD</span>
  if (m === 'TRANSFER') return <span className="badge badge-green">Transfer</span>
  return <span className="badge badge-grey">{mode || '—'}</span>
}

export default function Collections({ setDs }) {
  const kpis   = useApi('/api/collections/kpis')
  const agents = useApi('/api/collections/by-agent')
  const modes  = useApi('/api/collections/by-mode')
  const trend  = useApi('/api/collections/monthly-trend')
  const log    = useApi('/api/collections/log')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d      = kpis.data || {}
  const mTrend = calcMoM(trend.data, 'total')

  return (
    <PageShell title="Collections" subtitle="Agent performance, payment modes, and monthly trends" source={kpis.dataSource} error={kpis.error}>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Total Collected"   value={fmt(d.total_collected)}      icon="account_balance_wallet" accent="green"  tooltip="Cumulative amount collected from all overdue accounts across all time" />
        <KpiCard label="Collections (MTD)" value={fmt(d.collections_mtd)}      icon="calendar_month"         accent="accent" trend={mTrend} tooltip="Collections received in the current calendar month" />
        <KpiCard label="Collection Count"  value={fmtNum(d.collection_count)}  icon="tag"                    accent="navy"   tooltip="Number of individual collection events logged this month" />
        <KpiCard label="NDD Collections"   value={fmt(d.ndd_collections)}      icon="schedule"               accent="amber"  tooltip="Near-due-date collections — payments received before the overdue threshold is crossed" />
        <KpiCard label="Transfer"          value={fmt(d.transfer_collections)} icon="swap_horiz"             accent="blue"   tooltip="Collections received via bank transfer payment method" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Collections Trend"
            data={trend.data || []}
            xKey="month"
            areas={[{ key: 'total', label: 'Collections', color: '#10B981' }]}
            height={260}
            currency
          />
        </div>
        <ProgressListCard
          title="Collections by Mode"
          data={modes.data || []}
          nameKey="Mode Of Payment"
          valueKey="total"
          currency
          maxItems={6}
        />
      </div>

      <div className="mt-4">
        <ProgressListCard
          title="Top Agents by Collections"
          data={agents.data || []}
          nameKey="Agent"
          valueKey="total"
          currency
          maxItems={15}
        />
      </div>

      {log.data?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/60 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Collections Log</p>
            <span className="badge badge-grey">{log.data.length} entries</span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {['Date','CIF','Customer','Agent','Mode','Amount','Receipt'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {log.data.map((row, i) => (
                  <tr key={i}>
                    <td className="text-slate-500 whitespace-nowrap text-xs">
                      {row.Date ? new Date(row.Date).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="font-mono text-xs text-slate-500">{row.CIF}</td>
                    <td className="font-medium text-slate-800 dark:text-slate-200">
                      {[row['First Name'], row['Last Name']].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="text-slate-600 dark:text-slate-400">{row.Agent || '—'}</td>
                    <td><ModeBadge mode={row['Mode Of Payment']} /></td>
                    <td className="tabular-nums text-slate-800 dark:text-slate-200 whitespace-nowrap font-semibold">{fmt(row.Amount)}</td>
                    <td className="text-slate-400 text-xs">{row['Payment Receipt'] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageShell>
  )
}
