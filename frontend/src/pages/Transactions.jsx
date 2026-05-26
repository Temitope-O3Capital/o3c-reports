import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, HBarCard, DonutCard, fmt, fmtNum } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

export default function Transactions({ setDs }) {
  const kpis      = useApi('/api/transactions/kpis')
  const trend     = useApi('/api/transactions/monthly-trend')
  const merchants = useApi('/api/transactions/top-merchants')
  const byType    = useApi('/api/transactions/by-type')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <PageShell title="Transactions" subtitle="Volume, trends and merchant breakdown" source={kpis.dataSource} error={kpis.error}>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4">
        <KpiCard label="Total Volume"      value={fmt(d.total_volume)}         accent="accent" icon="payments" />
        <KpiCard label="Transaction Count" value={fmtNum(d.transaction_count)} accent="navy"   icon="receipt_long" />
        <KpiCard label="Volume (MTD)"      value={fmt(d.volume_mtd)}           accent="green"  icon="calendar_month" />
        <KpiCard label="Avg Txn Value"     value={fmt(d.avg_txn_value)}        accent="amber"  icon="calculate" />
        <KpiCard label="Unique Merchants"  value={fmtNum(d.unique_merchants)}  accent="navy"   icon="store" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <CurrencyLineCard
          title="Monthly Volume Trend"
          data={trend.data || []}
          xKey="month"
          lines={[{ key: 'volume', label: 'Volume', color: '#C00000' }]}
        />
        <DonutCard
          title="Transactions by Type"
          data={(byType.data || []).slice(0, 8)}
          nameKey="Description"
          valueKey="count"
        />
      </div>

      <div className="mt-4">
        <HBarCard
          title="Top 10 Merchants by Volume"
          data={merchants.data || []}
          nameKey="Merchant_Name"
          valueKey="volume"
          currency
        />
      </div>

      {merchants.data?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700">
            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Top Merchants</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3 text-left">#</th>
                  <th className="px-5 py-3 text-left">Merchant</th>
                  <th className="px-5 py-3 text-right">Volume</th>
                  <th className="px-5 py-3 text-right">Transactions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {merchants.data.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="px-5 py-3 text-slate-400 font-mono text-xs">{i + 1}</td>
                    <td className="px-5 py-3 font-semibold text-slate-800 dark:text-slate-200">{row.Merchant_Name}</td>
                    <td className="px-5 py-3 text-right font-mono text-slate-700 dark:text-slate-300">{fmt(row.volume)}</td>
                    <td className="px-5 py-3 text-right font-mono text-slate-700 dark:text-slate-300">{fmtNum(row.count)}</td>
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
