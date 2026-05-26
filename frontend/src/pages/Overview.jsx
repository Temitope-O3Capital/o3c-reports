import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, LineChartCard, DonutCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

export default function Overview({ setDs }) {
  const kpis   = useApi('/api/overview/kpis')
  const volume = useApi('/api/overview/monthly-volume')
  const trend  = useApi('/api/overview/new-accounts-trend')
  const byProd = useApi('/api/overview/cards-by-product')
  const byType = useApi('/api/overview/txn-by-type')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <PageShell title="Overview" subtitle="Executive KPIs across all business units" source={kpis.dataSource} error={kpis.error}>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
        <KpiCard label="Total Cardholders"   value={fmtNum(d.total_cardholders)}  accent="navy"   icon="groups" />
        <KpiCard label="Active Accounts"     value={fmtNum(d.active_accounts)}    accent="green"  icon="check_circle" />
        <KpiCard label="Cards Issued"        value={fmtNum(d.total_cards_issued)} accent="navy"   icon="credit_card" />
        <KpiCard label="New Accounts (MTD)"  value={fmtNum(d.new_accounts_mtd)}   accent="accent" icon="person_add" />
        <KpiCard label="Total Txn Volume"    value={fmt(d.total_txn_volume)}      accent="navy"   icon="receipt_long" />
        <KpiCard label="Total Collected"     value={fmt(d.total_collected)}       accent="green"  icon="account_balance" />
        <KpiCard label="Collections (MTD)"   value={fmt(d.collections_mtd)}       accent="amber"  icon="schedule" />
        <KpiCard label="Total Recovered"     value={fmt(d.total_recovered)}       accent="accent" icon="gavel" />
        <KpiCard label="Recovery Rate"       value={pct(d.recovery_rate)}         accent="green"  icon="percent" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <CurrencyLineCard
          title="Monthly Transaction Volume"
          data={volume.data || []}
          xKey="month"
          lines={[{ key: 'volume', label: 'Volume', color: '#C00000' }]}
        />
        <LineChartCard
          title="New Accounts Trend"
          data={trend.data || []}
          xKey="month"
          lines={[{ key: 'new_accounts', label: 'New Accounts', color: '#0E2841' }]}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <DonutCard
          title="Cards by Product Type"
          data={byProd.data || []}
          nameKey="Product Name"
          valueKey="count"
        />
        <DonutCard
          title="Transactions by Type (Top 10)"
          data={byType.data || []}
          nameKey="Description"
          valueKey="count"
        />
      </div>
    </PageShell>
  )
}
