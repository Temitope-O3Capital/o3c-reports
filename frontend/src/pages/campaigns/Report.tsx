import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, ErrBanner, Modal, btnPrimary, btnSecondary, filterInputStyle } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtPct, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'
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
  const sent      = toN(stats.sent)
  const delivered = toN(stats.delivered)
  const opened    = toN(stats.opened)
  const clicked   = toN(stats.clicked)

  // Each stage expressed as % of the PREVIOUS stage (true funnel)
  const delivPct  = sent      > 0 ? Math.min(100, (delivered / sent)      * 100) : 0
  const openPct   = delivered > 0 ? Math.min(100, (opened    / delivered) * 100) : 0
  const clickPct  = opened    > 0 ? Math.min(100, (clicked   / opened)    * 100) : 0
  // Bar widths decrease — each bar is that stage's cumulative retention of the original audience
  const sentBarW  = sent      > 0 ? Math.min(100, (sent      / total) * 100) : 0
  const delivBarW = sent      > 0 ? Math.min(sentBarW,  (delivered / total) * 100) : 0
  const openBarW  = sent      > 0 ? Math.min(delivBarW, (opened    / total) * 100) : 0
  const clickBarW = sent      > 0 ? Math.min(openBarW,  (clicked   / total) * 100) : 0

  const rows = [
    { label: 'Sent',      value: sent,      barW: sentBarW,  stagePct: sent > 0 ? Math.min(100, (sent / total) * 100) : 0, dropLabel: null, color: BLUE },
    { label: 'Delivered', value: delivered, barW: delivBarW, stagePct: delivPct, dropLabel: `${fmtPct(100 - delivPct)} drop`, color: GREEN },
    { label: 'Opened',    value: opened,    barW: openBarW,  stagePct: openPct,  dropLabel: `${fmtPct(100 - openPct)} drop`,  color: NAVY },
    { label: 'Clicked',   value: clicked,   barW: clickBarW, stagePct: clickPct, dropLabel: `${fmtPct(100 - clickPct)} drop`, color: PURPLE },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((row, i) => (
        <div key={row.label}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
            <div style={{ width: 68, fontSize: TEXT.xs, color: 'var(--txt2)', textAlign: 'right', flexShrink: 0 }}>{row.label}</div>
            <div style={{ flex: 1, height: 10, background: 'var(--th-bg)', borderRadius: RADIUS.xs, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${row.barW}%`, background: row.color, borderRadius: 4, transition: 'width .4s' }} />
            </div>
            <div style={{ width: 90, fontSize: TEXT.xs, ...NUM, textAlign: 'right', flexShrink: 0 }}>
              {fmtNum(row.value)} <span style={{ color: 'var(--txt3)' }}>({fmtPct(i === 0 ? row.stagePct : row.stagePct)})</span>
            </div>
          </div>
          {i > 0 && row.dropLabel && (
            <div style={{ paddingLeft: 78, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              of prev stage · <span style={{ color: row.stagePct < 50 ? RED : 'var(--txt3)' }}>{row.dropLabel}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Push to Telemarketers modal ────────────────────────────────────────────────

interface TMCampaign { id: number; name: string }

interface PushModalProps {
  campaignId: string
  open: boolean
  onClose: () => void
}

const SEGMENTS = [
  { value: 'all',            label: 'All contacts' },
  { value: 'email_opened',   label: 'Email opened only' },
  { value: 'email_clicked',  label: 'Email clicked only' },
  { value: 'sms_delivered',  label: 'SMS delivered only' },
]

function PushToTelemarketingModal({ campaignId, open, onClose }: PushModalProps) {
  const [tmCampaigns, setTmCampaigns]     = useState<TMCampaign[]>([])
  const [selectedTmId, setSelectedTmId]   = useState('')
  const [newCampaignName, setNewCampaignName] = useState('')
  const [segment, setSegment]             = useState('all')
  const [assignedTo, setAssignedTo]       = useState('')
  const [agents, setAgents]               = useState<{ id: number; full_name: string }[]>([])
  const [pushing, setPushing]             = useState(false)
  const [pushErr, setPushErr]             = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    apiFetch<TMCampaign[]>('/api/telemarketing/campaigns').then(r => setTmCampaigns(Array.isArray(r) ? r : [])).catch(() => {})
    apiFetch<{ id: number; full_name: string }[]>('/api/admin/users?role=telemarketing_agent&limit=100').then(r => setAgents(Array.isArray(r) ? r : [])).catch(() => {})
  }, [open])

  async function push() {
    setPushing(true); setPushErr(null)
    try {
      const body: Record<string, any> = { segment }
      if (selectedTmId === 'new') {
        body.new_campaign_name = newCampaignName || undefined
      } else if (selectedTmId) {
        body.telemarketing_campaign_id = Number(selectedTmId)
      }
      if (assignedTo) body.assigned_to = Number(assignedTo)
      const res = await apiPost<{ created: number; skipped_dnc: number; telemarketing_campaign_id: number }>(
        `/api/campaigns/${campaignId}/push-to-telemarketing`, body
      )
      toast.success(`${res.created} lead${res.created !== 1 ? 's' : ''} pushed to telemarketers${res.skipped_dnc > 0 ? ` · ${res.skipped_dnc} skipped (DNC)` : ''}`)
      onClose()
    } catch (ex: any) { setPushErr(ex.message) }
    finally { setPushing(false) }
  }

  function handleClose() {
    setSelectedTmId(''); setNewCampaignName(''); setSegment('all'); setAssignedTo(''); setPushErr(null)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Push to Telemarketers"
      width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={handleClose} style={btnSecondary}>Cancel</button>
          <button onClick={push} disabled={pushing} style={{ ...btnPrimary, background: '#7C3AED' }}>
            {pushing ? 'Pushing…' : 'Push Contacts'}
          </button>
        </div>
      }
    >
      {pushErr && <div style={{ color: '#EF4444', fontSize: TEXT.sm, marginBottom: SP[3] }}>{pushErr}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
            Contact Segment
          </label>
          <select value={segment} onChange={e => setSegment(e.target.value)} style={{ ...filterInputStyle, width: '100%' }}>
            {SEGMENTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>
            Choose which contacts from this campaign to hand off. Only contacts with a phone number are included; DNC numbers are automatically excluded.
          </div>
        </div>

        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
            Telemarketing Campaign
          </label>
          <select value={selectedTmId} onChange={e => setSelectedTmId(e.target.value)} style={{ ...filterInputStyle, width: '100%' }}>
            <option value="">Auto-create from campaign name</option>
            <option value="new">Create new…</option>
            {tmCampaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select>
        </div>

        {selectedTmId === 'new' && (
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
              New Campaign Name
            </label>
            <input
              value={newCampaignName}
              onChange={e => setNewCampaignName(e.target.value)}
              placeholder="e.g. Q3 Follow-up Calls"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }}
            />
          </div>
        )}

        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
            Assign to Agent (optional)
          </label>
          <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} style={{ ...filterInputStyle, width: '100%' }}>
            <option value="">Unassigned — pool pickup</option>
            {agents.map(a => <option key={a.id} value={String(a.id)}>{a.full_name}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CampaignReport() {
  const { id }    = useParams<{ id: string }>()
  const navigate  = useNavigate()
  const [report, setReport] = useState<ReportResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [pushOpen, setPushOpen] = useState(false)

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
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate('/campaigns')}
            style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>
            All Campaigns
          </button>
          {c && (
            <button onClick={() => setPushOpen(true)}
              style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: 'none', background: '#7C3AED', color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontFamily: INTER }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>
              Push to Telemarketers
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[5] }}>
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
            <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
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
                <div key={label as string} style={{ textAlign: 'center', padding: '10px 8px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
                  <div style={{ fontSize: 17, fontWeight: FW.bold, color: color as string, ...NUM }}>{val}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{label}</div>
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
                <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: TEXT.xs }} />
                <Area type="monotone" dataKey="delivered" stroke={GREEN} strokeWidth={2} fill="url(#rptDelivGrad)" name="Delivered" />
                <Area type="monotone" dataKey="opened"    stroke={BLUE}  strokeWidth={2} fill="url(#rptOpenGrad)"  name="Opened" />
                <Area type="monotone" dataKey="clicked"   stroke={NAVY}  strokeWidth={2} fill="url(#rptClickGrad)" name="Clicked" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
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
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: `${BLUE}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: BLUE, flexShrink: 0 }}>
                    {i + 1}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.sm, color: BLUE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {link.url}
                    </div>
                    <div style={{ height: 5, background: 'var(--th-bg)', borderRadius: 3, marginTop: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: BLUE, borderRadius: 3 }} />
                    </div>
                  </div>
                  <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY, flexShrink: 0 }}>
                    {fmtNum(toN(link.clicks))}
                  </span>
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}

      {id && (
        <PushToTelemarketingModal
          campaignId={id}
          open={pushOpen}
          onClose={() => setPushOpen(false)}
        />
      )}
    </Page>
  )
}
