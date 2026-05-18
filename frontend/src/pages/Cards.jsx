import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, DonutCard, fmtNum, pct } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

export default function Cards({ setDs }) {
  const kpis     = useApi('/api/cards/kpis')
  const byProd   = useApi('/api/cards/by-product')
  const byStatus = useApi('/api/cards/by-status')

  useEffect(() => {
    if (kpis.dataSource) setDs(kpis.dataSource)
  }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <div>
      <div className="page-header">
        <h1>Cards</h1>
        <DataBanner source={kpis.dataSource} />
      </div>

      {kpis.error && <div className="error-msg">Failed to load KPIs: {kpis.error}</div>}

      <div className="kpi-grid">
        <KpiCard label="Total Issued"       value={fmtNum(d.total_issued)}     accent="navy" />
        <KpiCard label="Active Cards"       value={fmtNum(d.active)}           accent="green" />
        <KpiCard label="Activation Rate"    value={pct(d.activation_rate)}     accent="green" />
        <KpiCard label="Prepaid Cards"      value={fmtNum(d.prepaid)}          accent="navy" />
        <KpiCard label="Credit Cards"       value={fmtNum(d.credit)}           accent="accent" />
        <KpiCard label="International USD"  value={fmtNum(d.international)}    accent="amber" />
      </div>

      <div className="chart-grid">
        <DonutCard
          title="Cards by Product Type"
          data={byProd.data || []}
          nameKey="Product Name"
          valueKey="count"
        />
        <DonutCard
          title="Cards by Account Status"
          data={byStatus.data || []}
          nameKey="Account Status"
          valueKey="count"
        />
      </div>

      {/* Product breakdown table */}
      {byProd.data && byProd.data.length > 0 && (
        <div className="table-wrap mt-4">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="text-right">Count</th>
                <th className="text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {byProd.data.map((row, i) => {
                const total = byProd.data.reduce((s, r) => s + (r.count || 0), 0)
                const share = total > 0 ? (row.count / total * 100).toFixed(1) : '0.0'
                return (
                  <tr key={i}>
                    <td>{row['Product Name']}</td>
                    <td className="mono text-right">{fmtNum(row.count)}</td>
                    <td className="mono text-right">{share}%</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
