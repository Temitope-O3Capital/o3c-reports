import { useState, useEffect } from 'react'
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, DataTable, KpiCard, Spinner, ErrBanner, DateFilter, NAVY, RED, GREEN, AMBER, BLUE, ColDef } from '../../components/UI'
import { today, monthStart } from '../../lib/fmt'

// ── Types ──────────────────────────────────────────────────────────────────────
interface AgentRow {
  agent_id: number
  agent_name: string
  open_tickets: number
  resolved_today: number
  avg_csat: number | null
}

interface ChannelCount {
  channel: string
  count: number
}

interface StatusCount {
  status: string
  count: number
}

interface HelpdeskStatsData {
  // Summary
  open: number
  pending: number
  in_progress: number
  resolved_today: number
  sla_breached: number
  avg_first_response_hours: number | null
  avg_csat: number | null
  // Charts
  by_status: StatusCount[]
  by_channel: ChannelCount[]
  // Leaderboard
  agents: AgentRow[]
}

// ── Constants ──────────────────────────────────────────────────────────────────
const STATUS_COLORS = [NAVY, AMBER, BLUE, GREEN, '#94A3B8']
const CHANNEL_COLORS = [NAVY, BLUE, GREEN, AMBER, RED, '#8B5CF6']

const STATUS_LABELS: Record<string, string> = {
  open:        'Open',
  pending:     'Pending',
  in_progress: 'In Progress',
  resolved:    'Resolved',
  closed:      'Closed',
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function HelpdeskStats() {
  const [data, setData]       = useState<HelpdeskStatsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const todayStr = today()
  const isPeriodToday = dateFrom === todayStr && dateTo === todayStr
  const resolvedLabel = isPeriodToday ? 'Resolved Today' : 'Resolved (Period)'

  useEffect(() => {
    setLoading(true); setErr('')
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    apiFetch<HelpdeskStatsData>(`/api/helpdesk/stats?${qs}`)
      .then(setData)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo])

  const agentCols: ColDef<AgentRow>[] = [
    {
      key: 'agent_name',
      label: 'Agent',
      render: row => <span className="font-semibold text-slate-800">{row.agent_name}</span>,
    },
    {
      key: 'open_tickets',
      label: 'Open Tickets',
      right: true,
      render: row => (
        <span className="font-mono font-semibold text-slate-700">{row.open_tickets}</span>
      ),
    },
    {
      key: 'resolved_today',
      label: resolvedLabel,
      right: true,
      render: row => (
        <span className="font-mono font-semibold text-slate-700">{row.resolved_today}</span>
      ),
    },
    {
      key: 'avg_csat',
      label: 'Avg CSAT',
      right: true,
      render: row => row.avg_csat != null
        ? <span className="font-semibold text-amber-600">⭐ {Number(row.avg_csat).toFixed(1)}</span>
        : <span className="text-slate-300">—</span>,
    },
  ]

  // Prepare status donut data
  const statusData = (data?.by_status ?? []).map(d => ({
    name: STATUS_LABELS[d.status] ?? d.status,
    value: d.count,
  }))

  // Prepare channel bar data with capitalised label (null-safe)
  const channelData = (data?.by_channel ?? []).map(d => ({
    channel: (d.channel ?? 'unknown').charAt(0).toUpperCase() + (d.channel ?? 'unknown').slice(1).replace(/_/g, ' '),
    count: d.count,
  }))

  return (
    <Page
      dept="Customer Service"
      title="Helpdesk Analytics"
      subtitle="Support team performance and ticket trends"
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />}
    >
      <ErrBanner msg={err} />

      {/* ── Status Overview ── */}
      <SectionCard title="Status Overview" className="mb-6">
        <div className="px-5 py-4">
          {loading ? (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-16 skeleton rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-6">
              <OverviewStat label="Open"              value={data?.open ?? 0}                     color={NAVY} />
              <OverviewStat label="Pending"           value={data?.pending ?? 0}                  color={AMBER} />
              <OverviewStat label="In Progress"       value={data?.in_progress ?? 0}              color={BLUE} />
              <OverviewStat label={resolvedLabel}     value={data?.resolved_today ?? 0}           color={GREEN} />
              <OverviewStat label="SLA Breached"      value={data?.sla_breached ?? 0}             color={RED} />
              <div className="flex flex-col justify-center">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                  Avg First Response
                </p>
                <p className="text-[22px] font-bold text-slate-900 kpi-number">
                  {data?.avg_first_response_hours != null
                    ? `${Number(data.avg_first_response_hours).toFixed(1)}h`
                    : '—'}
                </p>
              </div>
              <div className="flex flex-col justify-center">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                  Avg CSAT
                </p>
                <p className="text-[22px] font-bold text-amber-600 kpi-number">
                  {data?.avg_csat != null ? `⭐ ${Number(data.avg_csat).toFixed(1)}` : '—'}
                </p>
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Charts row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Status donut */}
        <SectionCard title="By Status">
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex flex-col items-center gap-3 pt-2">
                <div className="w-32 h-32 skeleton rounded-full" />
                <div className="w-full space-y-2"><div className="h-3 skeleton rounded" /><div className="h-3 skeleton rounded w-3/4" /></div>
              </div>
            ) : statusData.length === 0 ? (
              <p className="text-center text-slate-400 text-[13px] py-8">No data</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie
                      data={statusData}
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={70}
                      dataKey="value"
                      paddingAngle={2}
                      startAngle={90}
                      endAngle={450}
                    >
                      {statusData.map((_, i) => (
                        <Cell key={i} fill={STATUS_COLORS[i % STATUS_COLORS.length]} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        return (
                          <div className="bg-white rounded-lg border px-3 py-2 shadow-lg text-[12px]"
                            style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
                            <p className="font-semibold text-slate-700">{payload[0].name}</p>
                            <p className="font-mono font-bold text-slate-900">{payload[0].value}</p>
                          </div>
                        )
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2 pt-2">
                  {statusData.map((d, i) => {
                    const total = statusData.reduce((s, r) => s + r.value, 0)
                    return (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-sm flex-shrink-0"
                            style={{ background: STATUS_COLORS[i % STATUS_COLORS.length] }} />
                          <span className="text-[12px] text-slate-500">{d.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-semibold font-mono text-slate-800">{d.value}</span>
                          {total > 0 && (
                            <span className="text-[11px] text-slate-400">
                              ({((d.value / total) * 100).toFixed(0)}%)
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </SectionCard>

        {/* Channel bar chart */}
        <SectionCard title="By Channel">
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex items-end gap-3 h-48">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${30 + i * 12}%` }} />
                ))}
              </div>
            ) : channelData.length === 0 ? (
              <p className="text-center text-slate-400 text-[13px] py-8">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={channelData} margin={{ top: 16, right: 12, left: 0, bottom: 4 }} barSize={28}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis
                    dataKey="channel"
                    tick={{ fontSize: 11, fill: '#94A3B8' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#94A3B8' }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                    width={36}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      return (
                        <div className="bg-white rounded-lg border px-3 py-2 shadow-lg text-[12px]"
                          style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
                          <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wider mb-1">{label}</p>
                          <p className="font-mono font-bold text-slate-900">{payload[0].value} tickets</p>
                        </div>
                      )
                    }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {channelData.map((_, i) => (
                      <Cell key={i} fill={CHANNEL_COLORS[i % CHANNEL_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </SectionCard>
      </div>

      {/* ── Agent Leaderboard ── */}
      <SectionCard
        title="Agent Leaderboard"
        subtitle="Performance this period"
        badge={data?.agents.length}
      >
        {loading ? (
          <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
        ) : (
          <DataTable
            cols={agentCols}
            rows={data?.agents ?? []}
            loading={false}
            emptyIcon="group"
            emptyMsg="No agent data available"
          />
        )}
      </SectionCard>
    </Page>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function OverviewStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">{label}</p>
      <p className="text-[26px] font-bold kpi-number" style={{ color }}>{value}</p>
    </div>
  )
}
