import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, LineChartCard, HBarCard, BarChartCard, fmtNum, pct } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

export default function Sales({ setDs }) {
  const kpis    = useApi('/api/sales/kpis')
  const states  = useApi('/api/sales/accounts-by-state')
  const trend   = useApi('/api/sales/accounts-trend')
  const managers = useApi('/api/sales/by-account-manager')

  useEffect(() => {
    if (kpis.dataSource) setDs(kpis.dataSource)
  }, [kpis.dataSource])

  const d = kpis.data || {}

  const momDir = d.mom_growth >= 0 ? '+' : ''

  return (
    <div>
      <div className="page-header">
        <h1>Sales</h1>
        <DataBanner source={kpis.dataSource} />
      </div>

      {kpis.error && <div className="error-msg">Failed to load KPIs: {kpis.error}</div>}

      <div className="kpi-grid">
        <KpiCard label="Total Customers"    value={fmtNum(d.total_customers)} accent="navy" />
        <KpiCard label="New Accounts (MTD)" value={fmtNum(d.new_mtd)}         accent="accent" />
        <KpiCard label="MoM Growth"
          value={d.mom_growth != null ? `${momDir}${d.mom_growth}%` : '—'}
          accent={d.mom_growth >= 0 ? 'green' : 'accent'}
        />
      </div>

      <div className="chart-grid">
        <LineChartCard
          title="New Accounts Trend"
          data={trend.data || []}
          xKey="month"
          lines={[{ key: 'new_accounts', label: 'New Accounts', color: '#C00000' }]}
        />
        <BarChartCard
          title="Accounts by Account Manager (Top 15)"
          data={managers.data || []}
          xKey="Account Manager"
          bars={[{ key: 'accounts', label: 'Accounts', color: '#0E2841' }]}
          height={260}
        />
      </div>

      <div className="section-gap">
        <HBarCard
          title="Accounts by State"
          data={states.data || []}
          nameKey="State"
          valueKey="count"
          currency={false}
        />
      </div>
    </div>
  )
}
