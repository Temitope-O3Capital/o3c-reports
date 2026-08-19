import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { SectionCard, KpiCard, DataTable, filterInputStyle, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { FunnelChart, type FunnelStep } from '../marketing/FunnelChart'
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
  avg_open_rate: number   // 0–100 (percentage) from backend
  avg_click_rate: number
  avg_bounce_rate: number
  avg_delivery_rate: number
}
interface ByChannel { channel: string; sent: number; delivered: number; open_rate: number; click_rate: number; delivery_rate: number }
interface MonthlyVolume { month: string; email: number; sms: number; whatsapp: number }
interface TopCampaign { id: number; name: string; channel: string; sent: number; open_rate: number; click_rate: number; delivered_pct: number }
interface AnalyticsResp {
  summary: Summary
  by_channel: ByChannel[]
  monthly_volume: MonthlyVolume[]
  channel_split: { channel: string; count: number }[]
  top_campaigns: TopCampaign[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const WA_GREEN = '#25D366'
const CHANNEL_COLORS: Record<string, string> = { email: BLUE, sms: PURPLE, multi: GREEN, whatsapp: WA_GREEN }
const PIE_COLORS = [BLUE, PURPLE, GREEN, AMBER]

function toN(v: any): number { return Number(v) || 0 }

function ChannelTag({ channel }: { channel: string }) {
  const c = CHANNEL_COLORS[channel] ?? NAVY
  return <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}14`, color: c }}>{(channel || '—').toUpperCase()}</span>
}

// ── Performance tab body (mounted inside the Marketing Analytics hub) ────────────

export default function CampaignPerformance() {
  const navigate = useNavigate()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [channel, setChannel]   = useState('')

  const [data, setData]       = useState<AnalyticsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
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
  useLiveData(() => load(true), { topics: ['campaigns'] })

  const s = data?.summary

  // Engagement funnel — Sent → Delivered → Opened → Clicked.
  const engagement: FunnelStep[] = s ? [
    { label: 'Sent',      value: toN(s.total_sent),      color: NAVY  },
    { label: 'Delivered', value: toN(s.total_delivered), color: BLUE  },
    { label: 'Opened',    value: toN(s.total_opened),    color: AMBER },
    { label: 'Clicked',   value: toN(s.total_clicked),   color: GREEN },
  ] : []

  // Open/click tracking depends on the SendGrid Event Webhook. Surface a note
  // when we sent+delivered mail but recorded zero opens (tracking not live).
  const trackingGap = !!s && toN(s.total_delivered) > 0 && toN(s.total_opened) === 0

  const topCols: TableCol<TopCampaign>[] = [
    { key: 'name', label: 'Campaign', render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', cursor: 'pointer' }} onClick={() => navigate(`/campaigns/${r.id}/report?tab=results`)}>{r.name}</span> },
    { key: 'channel', label: 'Type', render: r => <ChannelTag channel={r.channel} /> },
    { key: 'sent',          label: 'Sent',      align: 'right', render: r => <span style={NUM}>{fmtNum(toN(r.sent))}</span> },
    { key: 'delivered_pct', label: 'Delivery',  align: 'right', render: r => <span style={{ ...NUM, color: GREEN }}>{fmtPct(toN(r.delivered_pct))}</span> },
    { key: 'open_rate',     label: 'Open Rate', align: 'right', render: r => <span style={{ ...NUM, color: BLUE }}>{fmtPct(toN(r.open_rate))}</span> },
    { key: 'click_rate',    label: 'CTR',       align: 'right', render: r => <span style={{ ...NUM, color: NAVY }}>{fmtPct(toN(r.click_rate))}</span> },
  ]
  const channelTableCols: TableCol<ByChannel>[] = [
    { key: 'channel', label: 'Channel', render: r => <ChannelTag channel={r.channel} /> },
    { key: 'sent',          label: 'Sent',      align: 'right', render: r => <span style={NUM}>{fmtNum(toN(r.sent))}</span> },
    { key: 'delivery_rate', label: 'Delivery',  align: 'right', render: r => <span style={{ ...NUM, color: GREEN }}>{fmtPct(toN(r.delivery_rate))}</span> },
    { key: 'open_rate',     label: 'Open Rate', align: 'right', render: r => <span style={{ ...NUM, color: BLUE }}>{fmtPct(toN(r.open_rate))}</span> },
    { key: 'click_rate',    label: 'CTR',       align: 'right', render: r => <span style={{ ...NUM, color: NAVY }}>{fmtPct(toN(r.click_rate))}</span> },
  ]

  const monthlyData  = (data?.monthly_volume ?? []).slice().sort((a, b) => a.month.localeCompare(b.month))
  const channelSplit = data?.channel_split ?? []

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: SP[3], marginBottom: SP[4], flexWrap: 'wrap' }}>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        <select value={channel} onChange={e => setChannel(e.target.value)} style={filterInputStyle}>
          <option value="">All Channels</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="multi">Multi</option>
        </select>
        {(dateFrom || dateTo || channel) && (
          <button onClick={() => { setDateFrom(''); setDateTo(''); setChannel('') }}
            style={{ padding: '6px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            Reset
          </button>
        )}
      </div>

      <ErrBanner error={err} onRetry={load} />

      {trackingGap && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', background: `${AMBER}0e`, border: `1px solid ${AMBER}40`, borderRadius: RADIUS.md, marginBottom: SP[4], fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16, color: AMBER }}>info</span>
          <span><strong>Opens &amp; clicks read 0 because email open-tracking isn't live yet.</strong> Sends and deliveries are accurate; open/click rates will populate once the SendGrid Event Webhook is delivering to the workspace.</span>
        </div>
      )}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard label="Campaigns"     value={fmtNum(toN(s?.total_campaigns))} icon="campaign"      loading={loading} />
        <KpiCard label="Total Sent"    value={fmtNum(toN(s?.total_sent))}      icon="send"          loading={loading} />
        <KpiCard label="Delivered"     value={fmtPct(toN(s?.avg_delivery_rate))} icon="mark_email_read" accent={GREEN} sub={`${fmtNum(toN(s?.total_delivered))} mails`} loading={loading} />
        <KpiCard label="Avg Open Rate" value={fmtPct(toN(s?.avg_open_rate))}   icon="drafts"        accent={BLUE}  loading={loading} />
        <KpiCard label="Avg CTR"       value={fmtPct(toN(s?.avg_click_rate))}  icon="ads_click"     accent={NAVY}  loading={loading} />
        <KpiCard label="Bounces"       value={fmtNum(toN(s?.total_bounced))}   icon="error"         accent={toN(s?.total_bounced) > 0 ? RED : NAVY} loading={loading} />
      </div>

      {/* Engagement funnel + Channel mix */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Engagement Funnel" subtitle="Sent, Delivered, Opened, Clicked">
          {engagement.some(e => e.value > 0)
            ? <FunnelChart steps={engagement} showCumulative />
            : <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No send data</div>}
        </SectionCard>

        <SectionCard title="Channel Mix" subtitle="Campaigns by channel">
          {channelSplit.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={channelSplit} cx="50%" cy="46%" innerRadius={46} outerRadius={74} dataKey="count" nameKey="channel">
                  {channelSplit.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Legend iconSize={9} wrapperStyle={{ fontSize: TEXT.xs }} formatter={v => String(v).toUpperCase()} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No data</div>
          )}
        </SectionCard>
      </div>

      {/* Monthly volume */}
      <SectionCard title="Monthly Send Volume" subtitle="Mails sent per month by channel" style={{ marginBottom: 14 }}>
        {monthlyData.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} />
              <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: TEXT.xs }} />
              <Bar dataKey="email"    fill={BLUE}     name="Email"    radius={[3,3,0,0]} stackId="a" />
              <Bar dataKey="sms"      fill={PURPLE}   name="SMS"      radius={[3,3,0,0]} stackId="a" />
              <Bar dataKey="whatsapp" fill={WA_GREEN} name="WhatsApp" radius={[3,3,0,0]} stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No volume data</div>
        )}
      </SectionCard>

      {/* By channel table */}
      {(data?.by_channel ?? []).length > 0 && (
        <SectionCard title="Performance by Channel" padding={false} style={{ marginBottom: 14 }}>
          <DataTable<ByChannel> cols={channelTableCols} rows={data?.by_channel ?? []} keyFn={(_, i) => i} emptyText="" skeletonRows={loading ? 3 : 0} />
        </SectionCard>
      )}

      {/* Top campaigns */}
      <SectionCard title="Top Campaigns" subtitle="Ranked by open rate" badge={(data?.top_campaigns ?? []).length} padding={false}>
        <DataTable<TopCampaign> cols={topCols} rows={data?.top_campaigns ?? []} keyFn={r => r.id} emptyText="No campaign data yet." skeletonRows={loading ? 5 : 0} />
      </SectionCard>
    </>
  )
}
