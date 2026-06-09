import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, KpiHero, AreaChartCard, LineChartCard, ProgressListCard, StatSummaryCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

function calcMoM(arr, key) {
  if (!arr || arr.length < 2) return null
  const prev = Number(arr[arr.length - 2]?.[key] ?? 0)
  const curr = Number(arr[arr.length - 1]?.[key] ?? 0)
  if (prev === 0) return null
  return ((curr - prev) / prev) * 100
}

export default function Overview({ setDs }) {
  const kpis   = useApi('/api/overview/kpis')
  const volume = useApi('/api/overview/monthly-volume')
  const trend  = useApi('/api/overview/new-accounts-trend')
  const byProd = useApi('/api/overview/cards-by-product')
  const byType = useApi('/api/overview/txn-by-type')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d         = kpis.data || {}
  const volTrend  = calcMoM(volume.data, 'volume')
  const acctTrend = calcMoM(trend.data, 'new_accounts')

  const volMoM = volTrend != null
    ? `${volTrend >= 0 ? '+' : ''}${volTrend.toFixed(1)}% vs last month`
    : null

  return (
    <PageShell
      title="Executive Overview"
      subtitle="Real-time performance across all O3C Cards business units"
      source={kpis.dataSource}
      error={kpis.error}
    >
      {/* Hero + secondary KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-1">
          <KpiHero
            label="Total Transaction Volume"
            value={fmt(d.total_txn_volume)}
            sub={volMoM}
            subUp={volTrend != null && volTrend >= 0}
            icon="payments"
            tooltip="Combined naira value of all card transactions processed to date"
          />
        </div>
        <KpiCard label="Total Cardholders"  value={fmtNum(d.total_cardholders)}  icon="groups"        accent="navy"   trend={acctTrend} tooltip="Total number of registered cardholders across all card products" />
        <KpiCard label="Active Accounts"    value={fmtNum(d.active_accounts)}    icon="check_circle"  accent="green"  sub={d.total_cards_issued ? `${pct((d.active_accounts / d.total_cards_issued) * 100, 0)} activation` : undefined} tooltip="Accounts with at least one transaction in the last 90 days" />
        <KpiCard label="New Accounts (MTD)" value={fmtNum(d.new_accounts_mtd)}   icon="person_add"    accent="accent" trend={acctTrend} tooltip="New cardholder accounts opened in the current calendar month" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        <KpiCard label="Cards Issued"      value={fmtNum(d.total_cards_issued)} icon="credit_card"     accent="navy"  tooltip="Total physical and virtual cards issued to customers across all products" />
        <KpiCard label="Total Collected"   value={fmt(d.total_collected)}       icon="account_balance" accent="green" tooltip="Cumulative amount collected from overdue accounts by the collections team" />
        <KpiCard label="Collections (MTD)" value={fmt(d.collections_mtd)}       icon="calendar_month"  accent="amber" tooltip="Collections received in the current calendar month" />
        <KpiCard label="Recovery Rate"     value={pct(d.recovery_rate)}         icon="gavel"           accent={d.recovery_rate >= 50 ? 'green' : 'accent'} sub={fmt(d.total_recovered) !== '—' ? `${fmt(d.total_recovered)} recovered` : undefined} tooltip="Percentage of the total outstanding recovery portfolio that has been recovered" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Transaction Volume"
            data={volume.data || []}
            xKey="month"
            areas={[{ key: 'volume', label: 'Volume', color: '#C00000' }]}
            height={260}
            currency
          />
        </div>
        <StatSummaryCard
          title="Financial Summary"
          icon="monitoring"
          accent="navy"
          items={[
            { label: 'Total Volume',    value: fmt(d.total_txn_volume), color: 'text-slate-800 dark:text-slate-100' },
            { label: 'Total Collected', value: fmt(d.total_collected),  color: 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Collections MTD', value: fmt(d.collections_mtd),  color: 'text-amber-600 dark:text-amber-400' },
            { label: 'Total Recovered', value: fmt(d.total_recovered),  color: 'text-blue-600 dark:text-blue-400' },
            { label: 'Recovery Rate',   value: pct(d.recovery_rate),    color: d.recovery_rate >= 50 ? 'text-emerald-600' : 'text-red-500' },
          ]}
        />
      </div>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <ProgressListCard
          title="Cards by Product"
          data={byProd.data || []}
          nameKey="Product Name"
          valueKey="count"
          maxItems={6}
        />
        <LineChartCard
          title="New Accounts Trend"
          data={trend.data || []}
          xKey="month"
          lines={[{ key: 'new_accounts', label: 'New Accounts', color: '#0E2841' }]}
          height={260}
        />
        <ProgressListCard
          title="Top Transaction Types"
          data={byType.data || []}
          nameKey="Description"
          valueKey="count"
          maxItems={6}
        />
      </div>
    </PageShell>
  )
}
