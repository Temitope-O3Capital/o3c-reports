import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, LineChartCard, DonutCard, ProgressListCard, StatSummaryCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
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

  const d = kpis.data || {}

  const volTrend     = calcMoM(volume.data, 'volume')
  const acctTrend    = calcMoM(trend.data, 'new_accounts')
  const txnCntTrend  = calcMoM(volume.data, 'txn_count')

  const totalCards = (byProd.data || []).reduce((s, r) => s + Number(r.count || 0), 0)

  return (
    <PageShell title="Executive Overview" subtitle="Real-time KPIs across all O3C Cards business units" source={kpis.dataSource} error={kpis.error}>

      {/* ── Primary KPIs ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total Cardholders"
          value={fmtNum(d.total_cardholders)}
          icon="groups"
          accent="navy"
          trend={acctTrend}
        />
        <KpiCard
          label="Active Accounts"
          value={fmtNum(d.active_accounts)}
          icon="check_circle"
          accent="green"
          sub={d.total_cards_issued ? `${pct((d.active_accounts / d.total_cards_issued) * 100, 0)} of issued` : undefined}
        />
        <KpiCard
          label="Total Txn Volume"
          value={fmt(d.total_txn_volume)}
          icon="receipt_long"
          accent="navy"
          trend={volTrend}
        />
        <KpiCard
          label="New Accounts (MTD)"
          value={fmtNum(d.new_accounts_mtd)}
          icon="person_add"
          accent="accent"
          trend={acctTrend}
        />
      </div>

      {/* ── Secondary KPIs ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        <KpiCard
          label="Cards Issued"
          value={fmtNum(d.total_cards_issued)}
          icon="credit_card"
          accent="navy"
        />
        <KpiCard
          label="Total Collected"
          value={fmt(d.total_collected)}
          icon="account_balance"
          accent="green"
        />
        <KpiCard
          label="Collections (MTD)"
          value={fmt(d.collections_mtd)}
          icon="calendar_month"
          accent="amber"
        />
        <KpiCard
          label="Recovery Rate"
          value={pct(d.recovery_rate)}
          icon="gavel"
          accent={d.recovery_rate >= 50 ? 'green' : 'accent'}
          sub={d.total_recovered ? `${fmt(d.total_recovered)} recovered` : undefined}
        />
      </div>

      {/* ── Charts Row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <CurrencyLineCard
            title="Monthly Transaction Volume"
            data={volume.data || []}
            xKey="month"
            lines={[{ key: 'volume', label: 'Volume', color: '#C00000' }]}
            height={260}
          />
        </div>
        <StatSummaryCard
          title="Financial Snapshot"
          icon="monitoring"
          accent="navy"
          items={[
            { label: 'Total Volume',      value: fmt(d.total_txn_volume),   color: 'text-slate-800 dark:text-slate-200' },
            { label: 'Total Collected',   value: fmt(d.total_collected),    color: 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Collections (MTD)', value: fmt(d.collections_mtd),    color: 'text-amber-600 dark:text-amber-400' },
            { label: 'Total Recovered',   value: fmt(d.total_recovered),    color: 'text-blue-600 dark:text-blue-400' },
            { label: 'Recovery Rate',     value: pct(d.recovery_rate),      color: d.recovery_rate >= 50 ? 'text-emerald-600' : 'text-red-500' },
          ]}
        />
      </div>

      {/* ── Breakdown Row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <ProgressListCard
          title="Cards by Product Type"
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
