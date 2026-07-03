import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM } from '../../lib/design'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CampaignMeta {
  id: number
  name: string
  channel: string
  status: string
  contact_count: number
  sent_at?: string
  completed_at?: string
}

interface Metrics {
  total_contacts: number
  sent: number
  sent_pct: number
  delivered: number
  delivery_rate: number
  opened: number
  open_rate: number
  clicked: number
  click_rate: number
  bounced: number
  bounce_rate: number
  spam: number
  unsubscribed: number
  failed: number
}

interface TimelinePoint {
  hour: string
  opened: number
  clicked: number
  delivered: number
}

interface ContactStats {
  pending: number
  sent: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  failed: number
}

interface ReportResp {
  campaign: CampaignMeta
  metrics: Metrics
  timeline: TimelinePoint[]
  top_links: { url: string; clicks: number }[]
  contact_stats: ContactStats
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toN(v: any): number { return Number(v) || 0 }

const STATUS_META: Record<string, { color: string; label: string }> = {
  draft:     { color: '#6B7280', label: 'Draft' },
  scheduled: { color: AMBER,    label: 'Scheduled' },
  active:    { color: GREEN,    label: 'Active' },
  paused:    { color: AMBER,    label: 'Paused' },
  completed: { color: NAVY,     label: 'Completed' },
  cancelled: { color: RED,      label: 'Cancelled' },
}

const TYPE_COLOR: Record<string, string> = { email: BLUE, sms: PURPLE, multi: GREEN }

function PipelineBar({ stats, total }: { stats: ContactStats; total: number }) {
  if (!total) return null
  const segments = [
    { label: 'Sent',      value: toN(stats.sent),      color: BLUE },
    { label: 'Delivered', value: toN(stats.delivered), color: GREEN },
    { label: 'Opened',    value: toN(stats.opened),    color: NAVY },
    { label: 'Clicked',   value: toN(stats.clicked),   color: PURPLE },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {segments.map(seg => {
        const pct = Math.min(100, (seg.value / total) * 100)
        return (
          <div key={seg.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 68, fontSize: 11.5, color: 'var(--txt2)', textAlign: 'right', flexShrink: 0 }}>{seg.label}</div>
            <div style={{ flex: 1, height: 8, background: 'var(--th-bg)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: seg.color, borderRadius: 4, transition: 'width .4s' }} />
            </div>
            <div style={{ width: 60, fontSize: 11.5, ...NUM, textAlign: 'right', flexShrink: 0 }}>
              {fmtNum(seg.value)} <span style={{ color: 'var(--txt3)' }}>({fmtPct(pct)})</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CampaignReport() {
  const { id }    = useParams<{ id: string }>()
  const navigate  = useNavigate()
  const [report, setReport] = useState<ReportResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<ReportResp>(`/api/campaigns/${id}/analytics`)
      setReport(res)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  const c = report?.campaign
  const m = report?.metrics
  const cs = report?.contact_stats
  const statusMeta = STATUS_META[c?.status ?? ''] ?? { color: '#6B7280', label: c?.status ?? '' }
  const typeColor  = TYPE_COLOR[c?.channel ?? ''] ?? NAVY

  const timeline = (report?.timeline ?? []).map(t => ({
    ...t,
    hour: t.hour ? new Date(t.hour).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
  }))

  const sent = toN(m?.sent)

  const subtitle = c
    ? `${c.channel.toUpperCase()} · ${statusMeta.label}${c.sent_at ? ' · Sent ' + fmtDatetime(c.sent_at) : ''}`
    : 'Loading…'

  return (
    <Page
      title={c?.name ?? 'Campaign Report'}
      subtitle={subtitle}
      actions={
        <button onClick={() => navigate('/campaigns')}
          style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>
          All Campaigns
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Audience"     value={fmtNum(toN(m?.total_contacts))} loading={loading} />
        <KpiCard label="Sent"         value={fmtNum(toN(m?.sent))}           loading={loading} />
        <KpiCard label="Delivery Rate" value={fmtPct(toN(m?.delivery_rate))} accent={GREEN}  loading={loading} />
        <KpiCard label="Open Rate"    value={fmtPct(toN(m?.open_rate))}      accent={BLUE}   loading={loading} />
        <KpiCard label="CTR"          value={fmtPct(toN(m?.click_rate))}     accent={PURPLE} loading={loading} />
        <KpiCard label="Bounce Rate"  value={fmtPct(toN(m?.bounce_rate))}    accent={toN(m?.bounce_rate) > 2 ? RED : NAVY} loading={loading} />
      </div>

      {/* Funnel + Timeline */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Delivery Funnel">
          {cs && c ? (
            <PipelineBar stats={cs} total={toN(c.contact_count)} />
          ) : (
            <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}

          {/* Raw counts grid */}
          {m && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 20 }}>
              {[
                ['Bounced',     fmtNum(toN(m.bounced)),     RED],
                ['Spam',        fmtNum(toN(m.spam)),        RED],
                ['Unsubscribed',fmtNum(toN(m.unsubscribed)),AMBER],
                ['Failed',      fmtNum(toN(m.failed)),      '#6B7280'],
              ].map(([label, val, color]) => (
                <div key={label as string} style={{ textAlign: 'center', padding: '10px 8px', background: 'var(--th-bg)', borderRadius: 8 }}>
                  <div style={{ fontSize: 17, fontWeight: 700, color: color as string, ...NUM }}>{val}</div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Engagement Timeline" subtitle="Hourly events">
          {timeline.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={timeline} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="rptDelivGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={GREEN} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="rptOpenGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={BLUE} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={BLUE} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="rptClickGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={NAVY} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="hour" tick={{ fontSize: 9.5, fill: 'var(--txt2)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--txt2)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="delivered" stroke={GREEN} strokeWidth={2} fill="url(#rptDelivGrad)" name="Delivered" />
                <Area type="monotone" dataKey="opened"    stroke={BLUE}  strokeWidth={2} fill="url(#rptOpenGrad)"  name="Opened" />
                <Area type="monotone" dataKey="clicked"   stroke={NAVY}  strokeWidth={2} fill="url(#rptClickGrad)" name="Clicked" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              {loading ? 'Loading…' : 'No timeline data — events are tracked for email campaigns only.'}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Top links */}
      {(report?.top_links ?? []).length > 0 && (
        <SectionCard title="Top Clicked Links" subtitle={`${sent > 0 ? 'of ' + fmtNum(sent) + ' recipients' : ''}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {report!.top_links.map((link, i) => {
              const pct = sent > 0 ? (toN(link.clicks) / sent) * 100 : 0
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: `${BLUE}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: BLUE, flexShrink: 0 }}>
                    {i + 1}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: BLUE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {link.url}
                    </div>
                    <div style={{ height: 5, background: 'var(--th-bg)', borderRadius: 3, marginTop: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: BLUE, borderRadius: 3 }} />
                    </div>
                  </div>
                  <span style={{ ...NUM, fontSize: 12, fontWeight: 700, color: NAVY, flexShrink: 0 }}>
                    {fmtNum(toN(link.clicks))}
                  </span>
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
