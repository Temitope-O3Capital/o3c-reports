import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, LineChartCard, DonutCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

export default function Overview({ setDs }) {
  const kpis     = useApi('/api/overview/kpis')
  const volume   = useApi('/api/overview/monthly-volume')
  const trend    = useApi('/api/overview/new-accounts-trend')
  const byProd   = useApi('/api/overview/cards-by-product')
  const byType   = useApi('/api/overview/txn-by-type')

  useEffect(() => {
    if (kpis.dataSource) setDs(kpis.dataSource)
  }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <div>
      <div className="page-header">
        <h1>Overview</h1>
        <DataBanner source={kpis.dataSource} />
      </div>

      {kpis.error && <div className="error-msg">Failed to load KPIs: {kpis.error}</div>}

      <div className="kpi-grid">
        <KpiCard label="Total Cardholders"   value={fmtNum(d.total_cardholders)}  accent="navy" />
        <KpiCard label="Active Accounts"     value={fmtNum(d.active_accounts)}    accent="green" />
        <KpiCard label="Cards Issued"        value={fmtNum(d.total_cards_issued)} accent="navy" />
        <KpiCard label="New Accounts (MTD)"  value={fmtNum(d.new_accounts_mtd)}   accent="accent" />
        <KpiCard label="Total Txn Volume"    value={fmt(d.total_txn_volume)}      accent="navy" />
        <KpiCard label="Total Collected"     value={fmt(d.total_collected)}       accent="green" />
        <KpiCard label="Collections (MTD)"   value={fmt(d.collections_mtd)}       accent="amber" />
        <KpiCard label="Total Recovered"     value={fmt(d.total_recovered)}       accent="accent" />
        <KpiCard label="Recovery Rate"       value={pct(d.recovery_rate)}         accent="green" />
      </div>

      <div className="chart-grid">
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

      <div className="chart-grid">
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
    </div>
  )
}
