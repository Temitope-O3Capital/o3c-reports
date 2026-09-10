import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { SectionCard, KpiCard, DataTable, filterInputStyle, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { FunnelChart, type FunnelStep } from '../marketing/FunnelChart'
import { EBar, EDonut } from '../../components/echarts'

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

// The campaign → lead → sales → customer funnel (GET /api/campaigns/conversion-funnel).
interface ConvCampaign {
  campaign_id: number; campaign_name: string; channel: string
  leads: number; contacted: number; interested: number; forwarded: number; converted: number
}
interface ConversionResp {
  campaigns: ConvCampaign[]
  funnel: { stage: string; count: number }[]
  leads: number
  converted: number
  conversion_rate: number
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
  const [conv, setConv]       = useState<ConversionResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (dateFrom) p.set('date_from', dateFrom)
      if (dateTo)   p.set('date_to',   dateTo)
      if (channel)  p.set('channel',   channel)
      const [res, cf] = await Promise.all([
        apiFetch<AnalyticsResp>(`/api/campaigns/analytics?${p}`),
        apiFetch<ConversionResp>(`/api/campaigns/conversion-funnel?${p}`).catch(() => null),
      ])
      setData(res)
      setConv(cf)
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

  // Lead → Customer conversion funnel: campaign leads → contacted → interested →
  // forwarded → converted. The stages come from the server so the labels stay in step.
  const CONV_COLORS = [NAVY, BLUE, AMBER, PURPLE, GREEN]
  const convSteps: FunnelStep[] = (conv?.funnel ?? []).map((s, i) => ({
    label: s.stage, value: toN(s.count), color: CONV_COLORS[i % CONV_COLORS.length],
  }))
  const convHasData = convSteps.some(s => s.value > 0)
  const convCols: TableCol<ConvCampaign>[] = [
    { key: 'campaign_name', label: 'Campaign', render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', cursor: 'pointer' }} onClick={() => navigate(`/campaigns/${r.campaign_id}/report?tab=results`)}>{r.campaign_name}</span> },
    { key: 'channel', label: 'Type', render: r => <ChannelTag channel={r.channel} /> },
    { key: 'leads',      label: 'Leads',      align: 'right', render: r => <span style={NUM}>{fmtNum(toN(r.leads))}</span> },
    { key: 'contacted',  label: 'Contacted',  align: 'right', render: r => <span style={{ ...NUM, color: BLUE }}>{fmtNum(toN(r.contacted))}</span> },
    { key: 'interested', label: 'Interested', align: 'right', render: r => <span style={{ ...NUM, color: AMBER }}>{fmtNum(toN(r.interested))}</span> },
    { key: 'forwarded',  label: 'Forwarded',  align: 'right', render: r => <span style={{ ...NUM, color: PURPLE }}>{fmtNum(toN(r.forwarded))}</span> },
    { key: 'converted',  label: 'Converted',  align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: GREEN }}>{fmtNum(toN(r.converted))}</span> },
    { key: '_rate',      label: 'Conv. rate', align: 'right', render: r => {
        const rate = toN(r.leads) > 0 ? (toN(r.converted) / toN(r.leads)) * 100 : 0
        return <span style={{ ...NUM, color: rate > 0 ? GREEN : 'var(--txt3)' }}>{fmtPct(rate)}</span>
      } },
  ]

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
            <EDonut
              data={channelSplit.map(r => ({ channel: String(r.channel).toUpperCase(), count: Number(r.count) }))}
              valueKey="count"
              nameKey="channel"
              colorFn={(_, i) => PIE_COLORS[i % PIE_COLORS.length]}
              size={200}
              inner={46}
              outer={74}
              legend
              valueFmt={(v) => fmtNum(v)}
            />
          ) : (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No data</div>
          )}
        </SectionCard>
      </div>

      {/* Monthly volume */}
      <SectionCard title="Monthly Send Volume" subtitle="Mails sent per month by channel" style={{ marginBottom: 14 }}>
        {monthlyData.length > 0 ? (
          <EBar
            data={monthlyData}
            xKey="month"
            height={220}
            stack
            valueFmt={(v) => fmtNum(v)}
            axisFmt={(v) => fmtNum(v)}
            series={[
              { key: 'email', name: 'Email', color: BLUE },
              { key: 'sms', name: 'SMS', color: PURPLE },
              { key: 'whatsapp', name: 'WhatsApp', color: GREEN },
            ]}
          />
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

      {/* Lead → Customer conversion. Engagement (above) ends at the click; this picks
          up where a click becomes a lead and follows it to a booked customer. */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Lead → Customer Funnel" subtitle="Campaign leads → contacted → interested → forwarded → converted">
          {convHasData
            ? <FunnelChart steps={convSteps} showCumulative />
            : <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base, textAlign: 'center', padding: 16 }}>
                No campaign leads have been pushed to the call centre in this window yet. Push a campaign to the call centre to start tracking conversions here.
              </div>}
        </SectionCard>
        <SectionCard title="Conversion" subtitle="Campaign leads that became customers">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], padding: '8px 4px' }}>
            <div>
              <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: GREEN, lineHeight: 1.1 }}>{fmtPct(toN(conv?.conversion_rate))}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>overall conversion rate</div>
            </div>
            <div style={{ display: 'flex', gap: SP[3] }}>
              <div>
                <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(toN(conv?.leads))}</div>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>leads</div>
              </div>
              <div>
                <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold, color: GREEN }}>{fmtNum(toN(conv?.converted))}</div>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>customers</div>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Per-campaign conversion breakdown */}
      <SectionCard title="Conversion by Campaign" subtitle="How many people each campaign turned into customers" badge={(conv?.campaigns ?? []).length} padding={false} style={{ marginBottom: 14 }}>
        <DataTable<ConvCampaign> cols={convCols} rows={conv?.campaigns ?? []} keyFn={r => r.campaign_id} emptyText="No campaigns have been pushed to the call centre yet." skeletonRows={loading ? 4 : 0} />
      </SectionCard>

      {/* Top campaigns */}
      <SectionCard title="Top Campaigns" subtitle="Ranked by open rate" badge={(data?.top_campaigns ?? []).length} padding={false}>
        <DataTable<TopCampaign> cols={topCols} rows={data?.top_campaigns ?? []} keyFn={r => r.id} emptyText="No campaign data yet." skeletonRows={loading ? 5 : 0} />
      </SectionCard>
    </>
  )
}
