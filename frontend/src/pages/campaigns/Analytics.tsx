import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, DataTable, FilterBar, filterInputStyle, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM } from '../../lib/design'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Summary {
  total_campaigns: number
  total_sent: number
  total_delivered: number
  total_opened: number
  total_clicked: number
  total_bounced: number
  total_unsubscribed: number
  avg_open_rate: number
  avg_click_rate: number
  avg_bounce_rate: number
  avg_delivery_rate: number
}

interface ByChannel {
  channel: string
  sent: number
  delivered: number
  open_rate: number
  click_rate: number
  delivery_rate: number
}

interface MonthlyVolume {
  month: string
  email: number
  sms: number
}

interface TopCampaign {
  id: number
  name: string
  channel: string
  sent: number
  open_rate: number
  click_rate: number
  delivered_pct: number
}

interface AnalyticsResp {
  summary: Summary
  by_channel: ByChannel[]
  monthly_volume: MonthlyVolume[]
  channel_split: { channel: string; count: number }[]
  top_campaigns: TopCampaign[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const CHANNEL_COLORS: Record<string, string> = { email: BLUE, sms: PURPLE, multi: GREEN, whatsapp: GREEN }
const PIE_COLORS = [BLUE, PURPLE, GREEN, AMBER]

function toN(v: any): number { return Number(v) || 0 }

// ── Main component ─────────────────────────────────────────────────────────────

export default function CampaignAnalytics() {
  const navigate = useNavigate()
  const [data, setData]       = useState<AnalyticsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [channel, setChannel]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (dateFrom) p.set('date_from', dateFrom)
      if (dateTo)   p.set('date_to',   dateTo)
      if (channel)  p.set('channel',   channel)
      const res = await apiFetch<AnalyticsResp>(`/api/campaigns/analytics?${p}`)
      setData(res)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo, channel])

  useEffect(() => { load() }, [load])

  const s = data?.summary
  const topCols: TableCol<TopCampaign>[] = [
    {
      key: 'name', label: 'Campaign',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', cursor: 'pointer' }}
        onClick={() => navigate(`/campaigns/${r.id}/report`)}>{r.name}</span>,
    },
    {
      key: 'channel', label: 'Type',
      render: r => {
        const c = CHANNEL_COLORS[r.channel] ?? NAVY
        return <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${c}14`, color: c }}>{r.channel.toUpperCase()}</span>
      },
    },
    { key: 'sent',         label: 'Sent',      align: 'right', render: r => <span style={NUM}>{fmtNum(toN(r.sent))}</span> },
    { key: 'delivered_pct',label: 'Delivery',  align: 'right', render: r => <span style={{ ...NUM, color: GREEN }}>{fmtPct(toN(r.delivered_pct))}</span> },
    { key: 'open_rate',    label: 'Open Rate', align: 'right', render: r => <span style={{ ...NUM, color: BLUE }}>{fmtPct(toN(r.open_rate))}</span> },
    { key: 'click_rate',   label: 'CTR',       align: 'right', render: r => <span style={{ ...NUM, color: NAVY }}>{fmtPct(toN(r.click_rate))}</span> },
  ]

  const channelTableCols: TableCol<ByChannel>[] = [
    {
      key: 'channel', label: 'Channel',
      render: r => {
        const c = CHANNEL_COLORS[r.channel] ?? NAVY
        return <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${c}14`, color: c }}>{r.channel.toUpperCase()}</span>
      },
    },
    { key: 'sent',         label: 'Sent',      align: 'right', render: r => <span style={NUM}>{fmtNum(toN(r.sent))}</span> },
    { key: 'delivery_rate',label: 'Delivery',  align: 'right', render: r => <span style={{ ...NUM, color: GREEN }}>{fmtPct(toN(r.delivery_rate))}</span> },
    { key: 'open_rate',    label: 'Open Rate', align: 'right', render: r => <span style={{ ...NUM, color: BLUE }}>{fmtPct(toN(r.open_rate))}</span> },
    { key: 'click_rate',   label: 'CTR',       align: 'right', render: r => <span style={{ ...NUM, color: NAVY }}>{fmtPct(toN(r.click_rate))}</span> },
  ]

  const monthlyData = (data?.monthly_volume ?? []).slice().sort((a, b) => a.month.localeCompare(b.month))
  const channelSplit = data?.channel_split ?? []

  return (
    <Page title="Campaign Analytics" subtitle="Aggregate performance across all campaigns">
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setDateFrom(''); setDateTo(''); setChannel('') }}>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
        <select value={channel} onChange={e => setChannel(e.target.value)} style={filterInputStyle}>
          <option value="">All Channels</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="multi">Multi</option>
        </select>
      </FilterBar>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Campaigns"     value={fmtNum(toN(s?.total_campaigns))} loading={loading} />
        <KpiCard label="Total Sent"    value={fmtNum(toN(s?.total_sent))}      loading={loading} />
        <KpiCard label="Delivered"     value={fmtNum(toN(s?.total_delivered))} accent={GREEN} loading={loading} />
        <KpiCard label="Avg Open Rate" value={fmtPct(toN(s?.avg_open_rate))}   accent={BLUE}  loading={loading} />
        <KpiCard label="Avg CTR"       value={fmtPct(toN(s?.avg_click_rate))}  accent={NAVY}  loading={loading} />
        <KpiCard label="Bounces"       value={fmtNum(toN(s?.total_bounced))}   accent={toN(s?.total_bounced) > 0 ? RED : NAVY} loading={loading} />
      </div>

      {/* Monthly volume + Channel split */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Monthly Send Volume">
          {monthlyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={monthlyData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} />
                <YAxis tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="email" fill={BLUE}   name="Email" radius={[3,3,0,0]} stackId="a" />
                <Bar dataKey="sms"   fill={PURPLE} name="SMS"   radius={[3,3,0,0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              No volume data
            </div>
          )}
        </SectionCard>

        <SectionCard title="Channel Mix">
          {channelSplit.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie data={channelSplit} cx="50%" cy="44%" innerRadius={48} outerRadius={75} dataKey="count" nameKey="channel">
                  {channelSplit.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Legend iconSize={9} wrapperStyle={{ fontSize: 11 }} formatter={v => String(v).toUpperCase()} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              No data
            </div>
          )}
        </SectionCard>
      </div>

      {/* By channel table */}
      {(data?.by_channel ?? []).length > 0 && (
        <SectionCard title="Performance by Channel" padding={false} style={{ marginBottom: 14 }}>
          <DataTable<ByChannel>
            cols={channelTableCols}
            rows={data?.by_channel ?? []}
            keyFn={(_, i) => i}
            emptyText=""
            skeletonRows={loading ? 3 : 0}
          />
        </SectionCard>
      )}

      {/* Top campaigns */}
      <SectionCard title="Top Campaigns" subtitle="By open rate" badge={(data?.top_campaigns ?? []).length} padding={false}>
        <DataTable<TopCampaign>
          cols={topCols}
          rows={data?.top_campaigns ?? []}
          keyFn={r => r.id}
          emptyText="No campaign data yet."
          skeletonRows={loading ? 5 : 0}
        />
      </SectionCard>
    </Page>
  )
}
