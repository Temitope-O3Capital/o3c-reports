import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, AreaChartCard, ProgressListCard, StatSummaryCard, fmtNum } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

function calcMoM(arr, key) {
  if (!arr || arr.length < 2) return null
  const prev = Number(arr[arr.length - 2]?.[key] ?? 0)
  const curr = Number(arr[arr.length - 1]?.[key] ?? 0)
  if (prev === 0) return null
  return ((curr - prev) / prev) * 100
}

export default function Sales({ setDs }) {
  const kpis     = useApi('/api/sales/kpis')
  const states   = useApi('/api/sales/accounts-by-state')
  const trend    = useApi('/api/sales/accounts-trend')
  const managers = useApi('/api/sales/by-account-manager')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d       = kpis.data || {}
  const momDir  = d.mom_growth >= 0 ? '+' : ''
  const acctMoM = calcMoM(trend.data, 'new_accounts')

  return (
    <PageShell title="Sales & Growth" subtitle="Customer acquisition, account manager performance, and regional breakdown" source={kpis.dataSource} error={kpis.error}>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Customers"    value={fmtNum(d.total_customers)}             icon="groups"       accent="navy"   trend={acctMoM} />
        <KpiCard label="New Accounts (MTD)" value={fmtNum(d.new_mtd)}                    icon="person_add"   accent="accent" />
        <KpiCard label="MoM Growth"         value={d.mom_growth != null ? `${momDir}${d.mom_growth}%` : '—'} icon="trending_up" accent={d.mom_growth >= 0 ? 'green' : 'accent'} sub="vs previous month" />
        <KpiCard label="States Reached"     value={fmtNum((states.data || []).length)}   icon="location_on"  accent="navy"   sub="active regions" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="New Accounts Trend"
            data={trend.data || []}
            xKey="month"
            areas={[{ key: 'new_accounts', label: 'New Accounts', color: '#C00000' }]}
            height={280}
          />
        </div>
        <StatSummaryCard
          title="Best Months"
          icon="emoji_events"
          accent="amber"
          items={(trend.data || [])
            .slice()
            .sort((a, b) => Number(b.new_accounts || 0) - Number(a.new_accounts || 0))
            .slice(0, 5)
            .map(r => ({ label: r.month, value: fmtNum(r.new_accounts) }))
          }
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <ProgressListCard
          title="Top Performing Regions"
          data={states.data || []}
          nameKey="State"
          valueKey="count"
          maxItems={10}
        />
        <ProgressListCard
          title="Accounts by Manager"
          data={managers.data || []}
          nameKey="Account Manager"
          valueKey="accounts"
          maxItems={10}
        />
      </div>
    </PageShell>
  )
}
