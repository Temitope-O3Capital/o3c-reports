import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, DateFilter, AreaChartCard, BarChartCard,
  ErrBanner, NAVY, GREEN, AMBER, RED,
} from '../../components/UI'

interface SummaryRow {
  active_users: number
  txn_count: number
  total_volume: number
  avg_txn_size: number
}

interface TrendRow {
  month: string
  active_users: number
  txn_count: number
}

export default function MobileApp() {
  const [summary, setSummary] = useState<SummaryRow | null>(null)
  const [trend,   setTrend]   = useState<TrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [from,    setFrom]    = useState(monthStart())
  const [to,      setTo]      = useState(today())

  useEffect(() => {
    setLoading(true)
    setError('')
    apiFetch(`/api/mobile-app/summary?date_from=${from}&date_to=${to}`)
      .then(res => {
        // Handle both wrapper shapes:
        //   { data: { summary: [...], trend: [...] }, data_source }
        //   { summary: [...], trend: [...] }
        const inner = res?.data ?? res
        const summaryArr: SummaryRow[] = inner?.summary ?? []
        const trendArr: TrendRow[]     = inner?.trend   ?? []
        setSummary(summaryArr[0] ?? null)
        setTrend(trendArr)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [from, to])

  const s = summary

  return (
    <Page
      dept="Operations"
      title="Mobile App"
      subtitle="App usage and customer activity metrics"
      actions={
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      }
    >
      <ErrBanner msg={error} />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard
          label="Active Users"
          value={loading ? '—' : fmtNum(n(s?.active_users))}
          icon="person"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Transactions"
          value={loading ? '—' : fmtNum(n(s?.txn_count))}
          icon="receipt"
          accent={GREEN}
          loading={loading}
        />
        <KpiCard
          label="Total Volume"
          value={loading ? '—' : fmt(n(s?.total_volume))}
          icon="payments"
          accent={AMBER}
          loading={loading}
        />
        <KpiCard
          label="Avg Transaction"
          value={loading ? '—' : fmt(n(s?.avg_txn_size))}
          icon="bar_chart"
          accent={RED}
          loading={loading}
        />
      </div>

      {/* Monthly active users trend */}
      <div className="mb-5">
        <AreaChartCard
          title="Monthly Active Users"
          subtitle="Active user count over time"
          data={trend}
          xKey="month"
          areaKey="active_users"
          color={NAVY}
          height={220}
          loading={loading}
        />
      </div>

      {/* Monthly transaction count */}
      <BarChartCard
        title="Monthly Transactions"
        subtitle="Transaction count per month"
        data={trend}
        xKey="month"
        barKey="txn_count"
        color={GREEN}
        height={220}
        loading={loading}
      />
    </Page>
  )
}
