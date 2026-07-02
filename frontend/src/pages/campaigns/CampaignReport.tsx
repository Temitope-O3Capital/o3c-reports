import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { apiFetch, apiExport } from '../../lib/api'
import { fmtNum, fmtDate } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef,
  ErrBanner, StatusBadge, ExportBtn, Spinner,
  NAVY, GREEN,
} from '../../components/UI'

const AMBER = '#F59E0B'
const RED   = '#C00000'

/* ── Types ──────────────────────────────────────────────────────── */

interface Metrics {
  sent: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  spam: number
}

interface CampaignSummary {
  id: number
  name: string
  channel: string
  status: string
  contact_count: number
  sent_at?: string | null
  completed_at?: string | null
}

interface TimelinePoint {
  ts: string
  hour?: string
  delivered: number
  opened: number
  clicked: number
}

interface TopLink {
  url: string
  clicks: number
}

interface Analytics {
  campaign: CampaignSummary
  metrics: Metrics
  timeline: TimelinePoint[]
  top_links: TopLink[]
}

interface ContactRow {
  name: string
  cif_number: string
  email: string
  phone: string
  email_status: string
  sms_status: string
  sent_at: string | null
  opened_at: string | null
  clicked_at: string | null
  bounced_at: string | null
  clicked_urls: string[]
}

interface ContactsPage {
  total: number
  page: number
  per_page: number
  contacts: ContactRow[]
}

/* ── Metric card ────────────────────────────────────────────────── */

function MetricCard({
  label, value, pct, positive = true,
}: { label: string; value: number; pct: number; positive?: boolean }) {
  const border = positive ? GREEN : RED
  const barBg  = positive ? 'rgba(22,101,52,0.12)' : 'rgba(220,38,38,0.10)'
  const barFill = positive ? GREEN : RED

  return (
    <div
      className="card px-4 py-4 flex flex-col gap-1"
      style={{ borderLeft: `3px solid ${border}` }}
    >
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em]" style={{ color: 'var(--txt2)' }}>{label}</p>
      <p className="text-[24px] font-bold leading-none kpi-number" style={{ color: 'var(--txt)' }}>
        {value.toLocaleString()}
      </p>
      <p className="text-[11px] font-medium" style={{ color: 'var(--txt2)' }}>{pct.toFixed(1)}%</p>
      <div className="mt-1 h-1.5 rounded-full" style={{ background: barBg }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(pct, 100)}%`, background: barFill }}
        />
      </div>
    </div>
  )
}

/* ── Funnel bar ─────────────────────────────────────────────────── */

function FunnelBar({ label, value, pct, color }: { label: string; value: number; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className="w-24 text-[12px] shrink-0" style={{ color: 'var(--txt2)' }}>{label}</div>
      <div className="flex-1 rounded-full h-3" style={{ background: 'var(--chip-bg)' }}>
        <div className="h-3 rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
      </div>
      <div className="w-24 text-right text-[12px] font-semibold shrink-0" style={{ color: 'var(--txt)' }}>
        {value.toLocaleString()}{' '}
        <span style={{ color: 'var(--txt2)' }}>{pct.toFixed(1)}%</span>
      </div>
    </div>
  )
}

/* ── Event status badge ─────────────────────────────────────────── */

const EVENT_STYLES: Record<string, { bg: string; color: string }> = {
  delivered: { bg: 'rgba(22,101,52,0.09)',   color: GREEN },
  opened:    { bg: 'rgba(14,40,65,0.09)',    color: NAVY  },
  clicked:   { bg: 'rgba(245,158,11,0.12)',  color: AMBER },
  bounced:   { bg: 'rgba(220,38,38,0.08)',   color: RED   },
  spam:      { bg: 'rgba(220,38,38,0.08)',   color: RED   },
  sent:      { bg: 'rgba(14,40,65,0.06)',    color: 'var(--txt2)' },
  pending:   { bg: 'rgba(14,40,65,0.06)',    color: 'var(--txt2)' },
}

function EventBadge({ status }: { status: string | null | undefined }) {
  const key = (status || 'pending').toLowerCase()
  const s = EVENT_STYLES[key] ?? { bg: 'rgba(14,40,65,0.06)', color: 'var(--txt2)' }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.color, display: 'inline-block', flexShrink: 0 }} />
      {key.charAt(0).toUpperCase() + key.slice(1)}
    </span>
  )
}

/* ── Channel badge ──────────────────────────────────────────────── */

function CampaignChannelBadge({ channel }: { channel?: string | null }) {
  const ch = (channel || '').toLowerCase()
  const isSms = ch === 'sms'
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded"
      style={{
        background: isSms ? 'rgba(14,40,65,0.07)' : 'rgba(37,99,235,0.08)',
        color: isSms ? '#475569' : '#1D4ED8',
      }}
    >
      <span className="material-symbols-rounded text-[11px]">{isSms ? 'sms' : 'mail'}</span>
      {(channel || 'email').toUpperCase()}
    </span>
  )
}

/* ── Custom chart tooltip ───────────────────────────────────────── */

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="rounded-lg border px-3 py-2.5 shadow-lg"
      style={{ borderColor: 'var(--bdr)', fontSize: 12, background: 'var(--card)' }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--txt2)' }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.color }} />
          <span className="text-[11px] capitalize" style={{ color: 'var(--txt2)' }}>{p.name}</span>
          <span className="font-semibold font-mono ml-auto pl-3" style={{ color: 'var(--txt)' }}>{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Main page ──────────────────────────────────────────────────── */

export default function CampaignReport() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()

  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [contacts,  setContacts]  = useState<ContactsPage | null>(null)
  const [page,      setPage]      = useState(1)
  const [search,    setSearch]    = useState('')
  const [loading,   setLoading]   = useState(true)
  const [cLoading,  setCLoading]  = useState(true)
  const [error,     setError]     = useState('')
  const [exporting, setExporting] = useState(false)

  // Fetch analytics
  useEffect(() => {
    if (!id) return
    let alive = true
    setLoading(true); setError('')
    apiFetch(`/api/campaigns/${id}/analytics`)
      .then(d => { if (alive) setAnalytics(d) })
      .catch((e: any) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id])

  // Fetch contacts (paged)
  const loadContacts = useCallback(() => {
    if (!id) return
    setCLoading(true)
    const qs = new URLSearchParams({ page: String(page), per_page: '50' })
    if (search) qs.set('search', search)
    apiFetch(`/api/campaigns/${id}/contacts-report?${qs}`)
      .then(d => setContacts(d))
      .catch(() => {})
      .finally(() => setCLoading(false))
  }, [id, page, search])

  useEffect(() => { loadContacts() }, [loadContacts])

  async function handleExport() {
    if (!id) return
    setExporting(true)
    try {
      await apiExport(`/api/campaigns/${id}/contacts-report?format=csv`, `campaign-report-${id}`)
    } catch {}
    finally { setExporting(false) }
  }

  const m = analytics?.metrics
  const campaign = analytics?.campaign
  const sent       = m?.sent ?? 0
  const delivered  = m?.delivered ?? 0
  const opened     = m?.opened ?? 0
  const clicked    = m?.clicked ?? 0
  const bounced    = m?.bounced ?? 0
  const spam       = m?.spam ?? 0

  const deliveredPct = sent > 0 ? (delivered / sent) * 100 : 0
  const openPct      = sent > 0 ? (opened / sent) * 100 : 0
  const clickPct     = sent > 0 ? (clicked / sent) * 100 : 0
  const bouncePct    = sent > 0 ? (bounced / sent) * 100 : 0
  const spamPct      = sent > 0 ? (spam / sent) * 100 : 0

  // Funnel: percentages relative to sent
  const funnelSteps = [
    { label: 'Sent',      value: sent,      pct: 100,        color: NAVY  },
    { label: 'Delivered', value: delivered,  pct: deliveredPct, color: GREEN },
    { label: 'Opened',    value: opened,     pct: openPct,    color: '#2563EB' },
    { label: 'Clicked',   value: clicked,    pct: clickPct,   color: AMBER },
  ]

  // Timeline data formatted for recharts
  const timelineData = (analytics?.timeline ?? []).map(pt => ({
    time: new Date(pt.ts || pt.hour || '').toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }),
    delivered: pt.delivered,
    opened:    pt.opened,
    clicked:   pt.clicked,
  }))

  const totalPages = contacts ? Math.ceil(contacts.total / 50) : 1

  const contactCols: ColDef<ContactRow>[] = [
    { key: 'name',         label: 'Name',         render: r => r.name || '—' },
    { key: 'cif_number',   label: 'CIF',          render: r => (
        <span className="font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>{r.cif_number || '—'}</span>
      ),
    },
    { key: 'email',        label: 'Email',         render: r => r.email || '—' },
    { key: 'phone',        label: 'Phone',         render: r => r.phone || '—' },
    { key: 'email_status', label: 'Email Status', render: r => <EventBadge status={r.email_status} /> },
    { key: 'sms_status',   label: 'SMS Status',   render: r => <EventBadge status={r.sms_status} /> },
    { key: 'sent_at',      label: 'Sent At',      render: r => r.sent_at ? fmtDate(r.sent_at) : '—' },
    { key: 'opened_at',    label: 'Opened At',    render: r => r.opened_at ? fmtDate(r.opened_at) : '—' },
    { key: 'clicked_at',   label: 'Clicked At',   render: r => r.clicked_at ? fmtDate(r.clicked_at) : '—' },
    { key: 'bounced_at',   label: 'Bounced At',   render: r => r.bounced_at ? fmtDate(r.bounced_at) : '—' },
    { key: 'clicked_urls', label: 'Links', render: r => r.clicked_urls?.length
        ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(245,158,11,0.12)', color: AMBER }}
            title={r.clicked_urls.join('\n')}
          >
            {r.clicked_urls.length} link{r.clicked_urls.length !== 1 ? 's' : ''}
          </span>
        )
        : <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>—</span>
    },
  ]

  return (
    <Page
      dept="Campaigns"
      title={loading ? 'Loading…' : `Campaign: ${campaign?.name ?? ''}`}
      subtitle="Detailed delivery and engagement analytics"
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={() => nav('/campaigns')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-colors"
            style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)', background: 'var(--card)' }}
          >
            <span className="material-symbols-rounded text-[14px]">arrow_back</span>
            Back
          </button>
          {campaign && <CampaignChannelBadge channel={campaign.channel} />}
          {campaign && <StatusBadge status={campaign.status} />}
          <ExportBtn onClick={handleExport} loading={exporting} />
        </div>
      }
    >
      <ErrBanner msg={error} />

      {/* ── KPI strip ── */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card px-4 py-4 animate-pulse">
              <div className="h-3 rounded w-3/4 mb-2" style={{ background: 'var(--chip-bg)' }} />
              <div className="h-7 rounded w-1/2 mb-1" style={{ background: 'var(--chip-bg)' }} />
              <div className="h-2 rounded w-full mt-3" style={{ background: 'var(--bg)' }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-5">
          <MetricCard label="Sent"      value={sent}      pct={100}        positive />
          <MetricCard label="Delivered" value={delivered}  pct={deliveredPct} positive />
          <MetricCard label="Open Rate" value={opened}    pct={openPct}    positive />
          <MetricCard label="Click Rate"value={clicked}   pct={clickPct}   positive />
          <MetricCard label="Bounced"   value={bounced}   pct={bouncePct}  positive={false} />
          <MetricCard label="Spam"      value={spam}      pct={spamPct}    positive={false} />
        </div>
      )}

      {/* ── Timeline chart ── */}
      <SectionCard title="Delivery Timeline" subtitle="Hourly engagement activity" className="mb-5">
        <div className="px-5 py-4">
          {loading ? (
            <div className="flex items-end gap-1.5 h-48">
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${20 + (i % 6) * 12}%` }} />
              ))}
            </div>
          ) : timelineData.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-[13px]" style={{ color: 'var(--txt2)' }}>
              No timeline data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={timelineData} margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} width={44}
                  tickFormatter={(v) => fmtNum(v)} />
                <Tooltip content={<ChartTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Line type="monotone" dataKey="delivered" stroke={NAVY}  strokeWidth={2} dot={false} activeDot={{ r: 3.5 }} />
                <Line type="monotone" dataKey="opened"    stroke={GREEN} strokeWidth={2} dot={false} activeDot={{ r: 3.5 }} />
                <Line type="monotone" dataKey="clicked"   stroke={AMBER} strokeWidth={2} dot={false} activeDot={{ r: 3.5 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </SectionCard>

      {/* ── Funnel + Top Links ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <SectionCard title="Event Funnel">
          <div className="px-5 py-4">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 mb-4">
                  <div className="w-24 h-3 skeleton rounded" />
                  <div className="flex-1 h-3 skeleton rounded-full" />
                  <div className="w-20 h-3 skeleton rounded" />
                </div>
              ))
            ) : (
              funnelSteps.map(s => (
                <FunnelBar key={s.label} label={s.label} value={s.value} pct={s.pct} color={s.color} />
              ))
            )}
          </div>
        </SectionCard>

        <SectionCard title="Top Clicked Links">
          <div className="px-5 py-4 space-y-2">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-4 h-3 skeleton rounded" />
                  <div className="flex-1 h-3 skeleton rounded" />
                  <div className="w-10 h-3 skeleton rounded" />
                </div>
              ))
            ) : (analytics?.top_links ?? []).length === 0 ? (
              <p className="text-[13px] py-4 text-center" style={{ color: 'var(--txt2)' }}>No link clicks recorded yet</p>
            ) : (
              (analytics?.top_links ?? []).map((link, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span
                    className="text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ background: 'var(--chip-bg)', color: 'var(--txt2)' }}
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 text-[12px] truncate" style={{ color: 'var(--txt2)' }} title={link.url}>{link.url}</span>
                  <span
                    className="text-[11px] font-semibold font-mono px-2 py-0.5 rounded"
                    style={{ background: 'var(--chip-bg)', color: NAVY }}
                  >
                    {fmtNum(link.clicks)}
                  </span>
                </div>
              ))
            )}
          </div>
        </SectionCard>
      </div>

      {/* ── Contact-level report ── */}
      <SectionCard
        title="Contact-Level Report"
        badge={contacts?.total}
        actions={
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Search contacts…"
              className="px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
            />
          </div>
        }
      >
        <DataTable
          cols={contactCols}
          rows={contacts?.contacts ?? []}
          loading={cLoading}
          emptyMsg="No contact data yet"
          emptyIcon="people"
        />

        {/* Pagination */}
        {contacts && contacts.total > 50 && (
          <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: 'var(--bdr)' }}>
            <button
              disabled={page <= 1 || cLoading}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors disabled:opacity-40"
              style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)' }}
            >
              ← Prev
            </button>
            <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>
              Page {page} of {totalPages}{cLoading && <Spinner size={14} />}
            </span>
            <button
              disabled={page >= totalPages || cLoading}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors disabled:opacity-40"
              style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)' }}
            >
              Next →
            </button>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
