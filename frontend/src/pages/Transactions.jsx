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

export default function Transactions({ setDs }) {
  const kpis      = useApi('/api/transactions/kpis')
  const trend     = useApi('/api/transactions/monthly-trend')
  const merchants = useApi('/api/transactions/top-merchants')
  const byType    = useApi('/api/transactions/by-type')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d        = kpis.data || {}
  const volTrend = calcMoM(trend.data, 'volume')

  return (
    <PageShell title="Transactions" subtitle="Volume, trends, and merchant breakdown" source={kpis.dataSource} error={kpis.error}>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Total Volume"      value={fmt(d.total_volume)}         icon="payments"       accent="accent" trend={volTrend} tooltip="Total naira value of all transactions in the selected date range" />
        <KpiCard label="Transaction Count" value={fmtNum(d.transaction_count)} icon="receipt_long"   accent="navy"   tooltip="Number of individual card transactions in the selected date range" />
        <KpiCard label="Volume (MTD)"      value={fmt(d.volume_mtd)}           icon="calendar_month" accent="green"  tooltip="Total transaction value in the current calendar month" />
        <KpiCard label="Avg Txn Value"     value={fmt(d.avg_txn_value)}        icon="calculate"      accent="amber"  tooltip="Average value per transaction — Total Volume ÷ Transaction Count" />
        <KpiCard label="Unique Merchants"  value={fmtNum(d.unique_merchants)}  icon="storefront"     accent="navy"   tooltip="Number of distinct merchant locations where O3C cards were used" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Volume Trend"
            data={trend.data || []}
            xKey="month"
            areas={[{ key: 'volume', label: 'Volume', color: '#C00000' }]}
            height={260}
            currency
          />
        </div>
        <ProgressListCard
          title="Transaction Types"
          data={(byType.data || []).slice(0, 8)}
          nameKey="Description"
          valueKey="count"
          maxItems={8}
        />
      </div>

      {merchants.data?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/60 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Top Merchants by Volume</p>
            <span className="badge badge-grey">{merchants.data.length} merchants</span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th>Merchant</th>
                  <th className="text-right">Volume</th>
                  <th className="text-right">Transactions</th>
                </tr>
              </thead>
              <tbody>
                {merchants.data.map((row, i) => (
                  <tr key={i}>
                    <td className="text-slate-300 dark:text-slate-600 text-xs tabular-nums">{i + 1}</td>
                    <td className="font-medium text-slate-800 dark:text-slate-200">{row.Merchant_Name}</td>
                    <td className="text-right tabular-nums text-slate-700 dark:text-slate-300">{fmt(row.volume)}</td>
                    <td className="text-right tabular-nums text-slate-500">{fmtNum(row.count)}</td>
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
