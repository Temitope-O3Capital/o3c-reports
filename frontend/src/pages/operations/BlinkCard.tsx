import { useState, useEffect } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from 'recharts'
import { apiFetch } from '../../lib/api'
import { fmtNum, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, BarChartCard,
  ErrBanner, ColDef, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

interface StatusRow {
  status: string
  count: number
}

interface IssuanceTrendRow {
  month: string
  product: string
  issued: number
}

interface IssuanceSummary {
  month: string
  issued: number
}

const DONUT_COLORS = [NAVY, GREEN, RED, AMBER, '#2563EB', '#8B5CF6', '#0891B2']

const STATUS_COLS: ColDef<StatusRow>[] = [
  { key: 'status', label: 'Status' },
  { key: 'count',  label: 'Count', right: true,
    render: r => <span className="kpi-number font-semibold">{n(r.count).toLocaleString()}</span> },
]

export default function BlinkCard() {
  const [statusBreakdown, setStatusBreakdown] = useState<StatusRow[]>([])
  const [issuanceTrend,   setIssuanceTrend]   = useState<IssuanceSummary[]>([])
  const [loading,         setLoading]         = useState(true)
  const [error,           setError]           = useState('')

  // BlinkCard has no date params, but keep them for consistency with the pattern
  const [_from] = useState(monthStart())
  const [_to]   = useState(today())

  useEffect(() => {
    setLoading(true)
    setError('')
    apiFetch('/api/blink-card/summary')
      .then(res => {
        const body = res?.data ?? res
        const breakdown: StatusRow[]      = body?.status_breakdown  ?? []
        const trend: IssuanceTrendRow[]   = body?.issuance_trend    ?? []

        setStatusBreakdown(breakdown)

        // Aggregate issued count per month (sum across all products)
        const byMonth: Record<string, number> = {}
        trend.forEach(r => {
          byMonth[r.month] = (byMonth[r.month] ?? 0) + n(r.issued)
        })
        const sorted = Object.entries(byMonth)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, issued]) => ({ month, issued }))
        setIssuanceTrend(sorted)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const totalCards    = statusBreakdown.reduce((s, r) => s + n(r.count), 0)
  const activeCards   = statusBreakdown.find(r => r.status?.toLowerCase() === 'active')?.count   ?? 0
  const blockedCards  = statusBreakdown.find(r => r.status?.toLowerCase() === 'blocked')?.count  ?? 0
  const inactiveCards = statusBreakdown.find(r => r.status?.toLowerCase() === 'inactive')?.count ?? 0

  return (
    <Page
      dept="Operations"
      title="Blink Card"
      subtitle="Blink prepaid card programme overview"
    >
      <ErrBanner msg={error} />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard
          label="Total Cards"
          value={loading ? '—' : fmtNum(totalCards)}
          icon="credit_card"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Active Cards"
          value={loading ? '—' : fmtNum(activeCards)}
          icon="check_circle"
          accent={GREEN}
          loading={loading}
        />
        <KpiCard
          label="Blocked Cards"
          value={loading ? '—' : fmtNum(blockedCards)}
          icon="credit_card_off"
          accent={RED}
          loading={loading}
        />
        <KpiCard
          label="Inactive Cards"
          value={loading ? '—' : fmtNum(inactiveCards)}
          icon="do_not_disturb"
          accent={AMBER}
          loading={loading}
        />
      </div>

      {/* Donut + Status table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        {/* Inline donut — counts not currency, so we can't use DonutCard which shows ₦ */}
        <SectionCard title="Card Status Distribution" subtitle="Current card portfolio by status">
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex flex-col items-center gap-3 pt-2">
                <div className="w-28 h-28 skeleton rounded-full" />
                <div className="w-full space-y-2 pt-2">
                  <div className="skeleton h-3 w-full rounded" />
                  <div className="skeleton h-3 w-3/4 rounded" />
                  <div className="skeleton h-3 w-1/2 rounded" />
                </div>
              </div>
            ) : statusBreakdown.length === 0 ? (
              <p className="text-[13px] text-slate-400 py-16 text-center">No status data available</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={140}>
                  <PieChart>
                    <Pie
                      data={statusBreakdown}
                      cx="50%" cy="50%"
                      innerRadius={44} outerRadius={64}
                      dataKey="count"
                      paddingAngle={2}
                      startAngle={90} endAngle={-270}
                    >
                      {statusBreakdown.map((_, i) => (
                        <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const p = payload[0]
                        return (
                          <div className="bg-white rounded-lg border px-3 py-2.5 shadow-lg"
                            style={{ borderColor: 'rgba(15,23,42,0.1)', fontSize: 12 }}>
                            <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wider mb-1">{p.name}</p>
                            <span className="font-semibold font-mono text-slate-800">{n(p.value).toLocaleString()}</span>
                          </div>
                        )
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2 pt-1">
                  {statusBreakdown.map((d, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-sm flex-shrink-0"
                          style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                        <span className="text-[12px] text-slate-500">{d.status}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-semibold font-mono text-slate-800">
                          {n(d.count).toLocaleString()}
                        </span>
                        {totalCards > 0 && (
                          <span className="text-[11px] text-slate-400">
                            ({((n(d.count) / totalCards) * 100).toFixed(0)}%)
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </SectionCard>

        {/* Status table */}
        <SectionCard title="Status Breakdown" subtitle="Card counts by status" badge={loading ? undefined : statusBreakdown.length}>
          <DataTable<StatusRow>
            cols={STATUS_COLS}
            rows={statusBreakdown}
            loading={loading}
            emptyIcon="credit_card"
            emptyMsg="No status data available"
          />
        </SectionCard>
      </div>

      {/* Issuance trend bar chart */}
      <BarChartCard
        title="Monthly Card Issuance"
        subtitle="Total cards issued per month across all products"
        data={issuanceTrend}
        xKey="month"
        barKey="issued"
        color={NAVY}
        height={220}
        loading={loading}
      />
    </Page>
  )
}
