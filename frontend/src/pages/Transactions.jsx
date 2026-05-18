import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, HBarCard, DonutCard, fmt, fmtNum } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

export default function Transactions({ setDs }) {
  const kpis      = useApi('/api/transactions/kpis')
  const trend     = useApi('/api/transactions/monthly-trend')
  const merchants = useApi('/api/transactions/top-merchants')
  const byType    = useApi('/api/transactions/by-type')

  useEffect(() => {
    if (kpis.dataSource) setDs(kpis.dataSource)
  }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <div>
      <div className="page-header">
        <h1>Transactions</h1>
        <DataBanner source={kpis.dataSource} />
      </div>

      {kpis.error && <div className="error-msg">Failed to load KPIs: {kpis.error}</div>}

      <div className="kpi-grid">
        <KpiCard label="Total Volume"       value={fmt(d.total_volume)}         accent="accent" />
        <KpiCard label="Transaction Count"  value={fmtNum(d.transaction_count)} accent="navy" />
        <KpiCard label="Volume (MTD)"       value={fmt(d.volume_mtd)}           accent="green" />
        <KpiCard label="Avg Txn Value"      value={fmt(d.avg_txn_value)}        accent="amber" />
        <KpiCard label="Unique Merchants"   value={fmtNum(d.unique_merchants)}  accent="navy" />
      </div>

      <div className="chart-grid">
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

      <div className="section-gap">
        <HBarCard
          title="Top 10 Merchants by Volume"
          data={merchants.data || []}
          nameKey="Merchant_Name"
          valueKey="volume"
          currency
        />
      </div>

      {/* Merchants table */}
      {merchants.data && merchants.data.length > 0 && (
        <div className="table-wrap mt-4">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Merchant</th>
                <th>Volume</th>
                <th>Transactions</th>
              </tr>
            </thead>
            <tbody>
              {merchants.data.map((row, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{row.Merchant_Name}</td>
                  <td className="mono">{fmt(row.volume)}</td>
                  <td className="mono">{fmtNum(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
