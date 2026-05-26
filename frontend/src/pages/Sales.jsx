import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, LineChartCard, HBarCard, BarChartCard, fmtNum } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

export default function Sales({ setDs }) {
  const kpis     = useApi('/api/sales/kpis')
  const states   = useApi('/api/sales/accounts-by-state')
  const trend    = useApi('/api/sales/accounts-trend')
  const managers = useApi('/api/sales/by-account-manager')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d      = kpis.data || {}
  const momDir = d.mom_growth >= 0 ? '+' : ''

  return (
    <PageShell title="Sales & Growth" subtitle="Customer acquisition, account manager performance, and regional breakdown" source={kpis.dataSource} error={kpis.error}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <KpiCard label="Total Customers"    value={fmtNum(d.total_customers)} accent="navy"   icon="groups" />
        <KpiCard label="New Accounts (MTD)" value={fmtNum(d.new_mtd)}         accent="accent" icon="person_add" />
        <KpiCard
          label="MoM Growth"
          value={d.mom_growth != null ? `${momDir}${d.mom_growth}%` : '—'}
          accent={d.mom_growth >= 0 ? 'green' : 'accent'}
          icon="trending_up"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
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

      <div className="mt-4">
        <HBarCard
          title="Accounts by State"
          data={states.data || []}
          nameKey="State"
          valueKey="count"
          currency={false}
        />
      </div>
    </PageShell>
  )
}
