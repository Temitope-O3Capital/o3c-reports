import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiExport } from '../../lib/api'
import { fmt, fmtNum, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  AreaChartCard, ProgressList,
  ErrBanner, ExportBtn, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

export default function Transactions() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [kpis, setKpis] = useState<any>(null)
  const [trend, setTrend] = useState<any[]>([])
  const [merchants, setMerchants] = useState<any[]>([])
  const [byType, setByType] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ date_from: from, date_to: to }).toString()
      const [k, tr, me, bt] = await Promise.all([
        apiFetch(`/api/transactions/kpis?${qs}`),
        apiFetch('/api/transactions/monthly-trend'),
        apiFetch(`/api/transactions/top-merchants?${qs}`),
        apiFetch(`/api/transactions/by-type?${qs}`),
      ])
      setKpis(k.data ?? k)
      setTrend(tr.data ?? tr)
      setMerchants(me.data ?? me)
      setByType(bt.data ?? bt)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const d = kpis || {}

  const merchantCols = [
    {
      key: '#', label: '#', sortable: false,
      render: (_: any, i?: number) => (
        <span className="text-slate-400 text-xs tabular-nums">{(i ?? 0) + 1}</span>
      ),
    },
    { key: 'Merchant_Name', label: 'Merchant' },
    {
      key: 'volume', label: 'Volume', right: true,
      render: (r: any) => <span className="font-mono font-semibold">{fmt(r.volume)}</span>,
    },
    {
      key: 'count', label: 'Transactions', right: true,
      render: (r: any) => fmtNum(r.count),
    },
  ]

  return (
    <Page dept="Finance" title="Transactions"
      subtitle="Volume, trends, and merchant breakdown"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          <ExportBtn
            onClick={async () => {
              setExporting(true)
              await apiExport(`/api/transactions/export?date_from=${from}&date_to=${to}`, `transactions_${from}_${to}`)
              setExporting(false)
            }}
            loading={exporting}
          />
        </div>
      }>

      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Volume" value={fmt(d.total_volume)} icon="payments" accent={RED} />
        <KpiCard loading={loading} label="Txn Count" value={fmtNum(d.transaction_count)} icon="receipt_long" accent={NAVY} />
        <KpiCard loading={loading} label="Volume MTD" value={fmt(d.volume_mtd)} icon="calendar_month" accent={GREEN} />
        <KpiCard loading={loading} label="Avg Txn Value" value={fmt(d.avg_txn_value)} icon="calculate" accent={AMBER} />
        <KpiCard loading={loading} label="Unique Merchants" value={fmtNum(d.unique_merchants)} icon="storefront" accent={NAVY} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Volume Trend"
            subtitle="All time — last 12 months"
            data={trend}
            xKey="month"
            areaKey="volume"
            color={RED}
            currency
            height={240}
            loading={loading}
          />
        </div>
        <ProgressList
          title="Transaction Types"
          subtitle="By count in period"
          data={byType.slice(0, 8).map((r: any) => ({ label: r.Description, count: n(r.count) }))}
          nameKey="label"
          valueKey="count"
          loading={loading}
        />
      </div>

      <SectionCard title="Top Merchants by Volume" badge={merchants.length}>
        <DataTable
          cols={merchantCols}
          rows={merchants}
          loading={loading}
          emptyIcon="storefront"
          emptyMsg="No merchant data for this period"
        />
      </SectionCard>
    </Page>
  )
}
