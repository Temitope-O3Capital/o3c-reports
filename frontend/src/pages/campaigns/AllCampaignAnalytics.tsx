import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, today, monthStart } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef, KpiCard, ErrBanner, DateFilter,
  NAVY, GREEN,
} from '../../components/UI'

const AMBER = '#F59E0B'

/* ── Types ──────────────────────────────────────────────────────── */

interface AggMetrics {
  total_campaigns: number
  total_sent: number
  avg_open_rate: number
  avg_click_rate: number
}

interface MonthlyBucket {
  month: string
  email: number
  sms: number
  whatsapp: number
}

interface ChannelSplit {
  channel: string
  count: number
}

interface TopCampaign {
  id: number
  name: string
  channel: string
  sent: number
  delivered: number
  delivered_pct: number
  open_rate: number
  click_rate: number
}

interface AggAnalytics {
  metrics: AggMetrics
  monthly_volume: MonthlyBucket[]
  channel_split: ChannelSplit[]
  top_campaigns: TopCampaign[]
}

/* ── Channel colours ────────────────────────────────────────────── */

const CHANNEL_COLORS: Record<string, string> = {
  email:     NAVY,
  sms:       AMBER,
  whatsapp:  '#16A34A',
}

function channelColor(ch: string): string {
  return CHANNEL_COLORS[ch.toLowerCase()] ?? '#94A3B8'
}

/* ── Custom bar chart tooltip ───────────────────────────────────── */

function BarTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="bg-white rounded-lg border px-3 py-2.5 shadow-lg"
      style={{ borderColor: 'rgba(15,23,42,0.1)', fontSize: 12 }}
    >
      <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wider mb-1.5">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.fill }} />
          <span className="text-slate-500 text-[11px] capitalize">{p.name}</span>
          <span className="font-semibold font-mono text-slate-800 ml-auto pl-3">{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Pie tooltip ────────────────────────────────────────────────── */

function PieTip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  const total = payload[0]?.payload?.total ?? 1
  return (
    <div
      className="bg-white rounded-lg border px-3 py-2.5 shadow-lg"
      style={{ borderColor: 'rgba(15,23,42,0.1)', fontSize: 12 }}
    >
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.payload.fill }} />
        <span className="text-slate-700 font-semibold capitalize">{p.name}</span>
      </div>
      <p className="font-mono font-bold text-slate-900 mt-1">{fmtNum(p.value)}</p>
      <p className="text-[11px] text-slate-400">{((p.value / total) * 100).toFixed(1)}% of total</p>
    </div>
  )
}

/* ── Main page ──────────────────────────────────────────────────── */

export default function AllCampaignAnalytics() {
  const [dateFrom, setDateFrom] = useState(monthStart)
  const [dateTo,   setDateTo]   = useState(today)
  const [data,     setData]     = useState<AggAnalytics | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    apiFetch(`/api/campaigns/analytics?${qs}`)
      .then(d => { if (alive) setData(d) })
      .catch((e: any) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [dateFrom, dateTo])

  const m = data?.metrics
  const channelSplitWithTotal = (data?.channel_split ?? []).map(cs => ({
    ...cs,
    fill: channelColor(cs.channel),
    total: (data?.channel_split ?? []).reduce((s, x) => s + x.count, 0),
  }))

  const topCols: ColDef<TopCampaign>[] = [
    { key: '_rank', label: '#', sortable: false,
      render: (_, i?: number) => (
        <span className="text-[12px] font-semibold text-slate-400">{(i ?? 0) + 1}</span>
      ),
    },
    { key: 'name', label: 'Campaign' },
    { key: 'channel', label: 'Channel',
      render: r => (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded"
          style={{ background: r.channel === 'sms' ? 'rgba(14,40,65,0.07)' : 'rgba(37,99,235,0.08)',
            color: r.channel === 'sms' ? '#475569' : '#1D4ED8' }}
        >
          <span className="material-symbols-rounded text-[11px]">{r.channel === 'sms' ? 'sms' : 'mail'}</span>
          {r.channel.toUpperCase()}
        </span>
      ),
    },
    { key: 'sent',          label: 'Sent',       right: true, render: r => fmtNum(r.sent) },
    { key: 'delivered_pct', label: 'Delivered',  right: true, render: r => fmtPct(r.delivered_pct) },
    { key: 'open_rate',     label: 'Open Rate',  right: true, render: r => fmtPct(r.open_rate) },
    { key: 'click_rate',    label: 'Click Rate', right: true, render: r => fmtPct(r.click_rate) },
  ]

  // DataTable doesn't pass row index to render — work around by using a rank field
  const topCampaignsWithRank = (data?.top_campaigns ?? []).map((c, i) => ({ ...c, _rank: i + 1 }))

  return (
    <Page
      dept="Campaigns"
      title="Campaign Analytics"
      subtitle="Aggregate performance across all campaigns"
      actions={
        <DateFilter
          from={dateFrom}
          to={dateTo}
          onChange={(f, t) => { setDateFrom(f); setDateTo(t) }}
        />
      }
    >
      <ErrBanner msg={error} />

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Campaigns" value={String(m?.total_campaigns ?? 0)} icon="campaign"     accent={NAVY}    />
        <KpiCard loading={loading} label="Total Sent"      value={fmtNum(m?.total_sent ?? 0)}      icon="send"         accent="#2563EB" />
        <KpiCard loading={loading} label="Avg Open Rate"   value={fmtPct(m?.avg_open_rate ?? 0)}   icon="mark_email_read" accent={GREEN} />
        <KpiCard loading={loading} label="Avg Click Rate"  value={fmtPct(m?.avg_click_rate ?? 0)}  icon="ads_click"    accent={AMBER}   />
      </div>

      {/* ── Monthly volume + Channel split ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
        {/* Monthly bar chart — spans 2 cols */}
        <SectionCard title="Monthly Campaign Volume" subtitle="Messages dispatched per month by channel" className="lg:col-span-2">
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex items-end gap-3 h-48">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${25 + i * 12}%` }} />
                ))}
              </div>
            ) : (data?.monthly_volume ?? []).length === 0 ? (
              <div className="flex items-center justify-center h-48 text-slate-400 text-[13px]">
                No monthly data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data?.monthly_volume ?? []} margin={{ top: 10, right: 12, left: 0, bottom: 4 }} barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} width={44}
                    tickFormatter={v => fmtNum(v)} />
                  <Tooltip content={<BarTip />} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  <Bar dataKey="email"     name="Email"     fill={NAVY}      radius={[3, 3, 0, 0]} />
                  <Bar dataKey="sms"       name="SMS"       fill={AMBER}     radius={[3, 3, 0, 0]} />
                  <Bar dataKey="whatsapp"  name="WhatsApp"  fill="#16A34A"   radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </SectionCard>

        {/* Channel donut */}
        <SectionCard title="Channel Split" subtitle="Share of campaigns by channel">
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex flex-col items-center gap-3 pt-2">
                <div className="w-28 h-28 skeleton rounded-full" />
                <div className="w-full space-y-2 pt-2">
                  <div className="h-3 skeleton rounded" />
                  <div className="h-3 skeleton rounded w-3/4" />
                </div>
              </div>
            ) : channelSplitWithTotal.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-slate-400 text-[13px]">
                No channel data
              </div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={140}>
                  <PieChart>
                    <Pie
                      data={channelSplitWithTotal}
                      dataKey="count"
                      nameKey="channel"
                      cx="50%" cy="50%"
                      innerRadius={44} outerRadius={64}
                      paddingAngle={2}
                      startAngle={90} endAngle={-270}
                    >
                      {channelSplitWithTotal.map((entry, i) => (
                        <Cell key={i} fill={entry.fill} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2 pt-1">
                  {channelSplitWithTotal.map((d, i) => {
                    const total = channelSplitWithTotal.reduce((s, x) => s + x.count, 0)
                    return (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: d.fill }} />
                          <span className="text-[12px] text-slate-500 capitalize">{d.channel}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-semibold font-mono text-slate-800">{fmtNum(d.count)}</span>
                          {total > 0 && (
                            <span className="text-[11px] text-slate-400">({((d.count / total) * 100).toFixed(0)}%)</span>
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
      </div>

      {/* ── Top campaigns ── */}
      <SectionCard title="Top Campaigns" subtitle="Ranked by open rate" badge={topCampaignsWithRank.length}>
        <DataTable
          cols={topCols}
          rows={topCampaignsWithRank}
          loading={loading}
          emptyMsg="No campaign data for selected period"
          emptyIcon="campaign"
        />
      </SectionCard>
    </Page>
  )
}
