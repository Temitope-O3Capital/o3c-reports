import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts'
import { Page, KpiCard, SectionCard, StatusBadge, EmptyState, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { useLiveData } from '../../hooks/useRealtime'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, GREEN, AMBER, RED, PURPLE, MONO, TEXT, FW, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Overview {
  counts: { inbox_total: number; inbox_unread: number; sent_total: number; drafts_total: number }
  performance: {
    total_sent: number; delivered: number; opened: number; clicked: number
    bounced: number; spam: number; delivery_rate: number; open_rate: number; bounce_rate: number
  }
  status_breakdown: { status: string; count: number }[]
  daily: { day: string; sent: number; delivered: number; opened: number }[]
  recent_sent: { id: number; subject: string; status: string; recipient: string; created_at: string }[]
  recent_inbound: { id: number; from_email: string; from_name: string; subject: string; is_read: boolean; received_at: string }[]
}

// Status → chart colour, reusing brand tokens.
const STATUS_COLOR: Record<string, string> = {
  delivered: GREEN, opened: BLUE, clicked: PURPLE, sending: AMBER,
  queued: AMBER, bounced: RED, failed: RED, spam_report: RED, unsubscribed: '#8A95A1',
}
const colorFor = (s: string) => STATUS_COLOR[s] ?? NAVY

function pct(n: number) { return `${(n ?? 0).toFixed(1)}%` }

function dayLabel(iso: string) {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function MailOverview() {
  const navigate = useNavigate()
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    try {
      const res = await apiFetch('/api/mail/overview')
      setData(unwrap<Overview>(res))
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['mail'] })

  const c = data?.counts
  const p = data?.performance
  const daily = (data?.daily ?? []).map(d => ({ ...d, label: dayLabel(d.day) }))
  const donut = (data?.status_breakdown ?? []).filter(s => s.count > 0)

  const composeBtn = (
    <button
      onClick={() => navigate('/mail/compose')}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>edit</span>
      Compose
    </button>
  )

  return (
    <Page title="Mail" subtitle="Overview of your inbox, sent mail and deliverability" actions={composeBtn}>
      {err && <ErrBanner error={err} onRetry={() => load()} />}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
        <div onClick={() => navigate('/mail/inbox')} style={{ cursor: 'pointer' }}>
          <KpiCard label="Inbox" value={fmtNum(c?.inbox_total ?? 0)} icon="inbox" accent={BLUE}
            sub={c?.inbox_unread ? `${c.inbox_unread} unread` : 'All read'} loading={loading} />
        </div>
        <div onClick={() => navigate('/mail/sent')} style={{ cursor: 'pointer' }}>
          <KpiCard label="Sent" value={fmtNum(c?.sent_total ?? 0)} icon="send" accent={NAVY}
            sub="Messages you sent" loading={loading} />
        </div>
        <div onClick={() => navigate('/mail/drafts')} style={{ cursor: 'pointer' }}>
          <KpiCard label="Drafts" value={fmtNum(c?.drafts_total ?? 0)} icon="draft" accent={AMBER}
            sub="Saved, not sent" loading={loading} />
        </div>
        <KpiCard label="Delivery rate" value={p ? pct(p.delivery_rate) : '—'} icon="mark_email_read" accent={GREEN}
          sub={p ? `${fmtNum(p.delivered)} delivered` : undefined} loading={loading} />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 16 }}>
        <SectionCard title="Send activity" subtitle="Last 14 days">
          {loading ? (
            <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>
          ) : daily.length === 0 ? (
            <EmptyState icon="mail" title="No mail sent yet" description="Your send activity will appear here once you send email." />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={daily} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={NAVY} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={NAVY} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gOpen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BLUE} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} allowDecimals={false} width={34} />
                <Tooltip
                  contentStyle={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: 'var(--txt)', fontWeight: 600 }} />
                <Area type="monotone" dataKey="sent" name="Sent" stroke={NAVY} strokeWidth={2} fill="url(#gSent)" />
                <Area type="monotone" dataKey="opened" name="Opened" stroke={BLUE} strokeWidth={2} fill="url(#gOpen)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        <SectionCard title="Status breakdown" subtitle="Your sent mail">
          {loading ? (
            <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>
          ) : donut.length === 0 ? (
            <EmptyState icon="donut_large" title="No data" description="Status mix appears here." />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={170}>
                <PieChart>
                  <Pie data={donut} dataKey="count" nameKey="status" cx="50%" cy="50%" innerRadius={44} outerRadius={68} paddingAngle={2}>
                    {donut.map((d, i) => <Cell key={i} fill={colorFor(d.status)} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                {donut.map((d, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: colorFor(d.status), flexShrink: 0 }} />
                    <span style={{ color: 'var(--txt2)', textTransform: 'capitalize' }}>{d.status.replace(/_/g, ' ')}</span>
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, color: 'var(--txt)', fontWeight: FW.semibold }}>{fmtNum(d.count)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </SectionCard>
      </div>

      {/* Deliverability funnel strip */}
      <SectionCard title="Deliverability" subtitle="Performance of your sent mail" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
          {[
            { label: 'Sent', value: p?.total_sent ?? 0, color: NAVY },
            { label: 'Delivered', value: p?.delivered ?? 0, color: GREEN, rate: p?.delivery_rate },
            { label: 'Opened', value: p?.opened ?? 0, color: BLUE, rate: p?.open_rate },
            { label: 'Clicked', value: p?.clicked ?? 0, color: PURPLE },
            { label: 'Bounced', value: p?.bounced ?? 0, color: RED, rate: p?.bounce_rate },
            { label: 'Spam', value: p?.spam ?? 0, color: '#8A95A1' },
          ].map((m, i) => (
            <div key={i} style={{ padding: '10px 12px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--bg)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
                <span style={{ fontSize: 11, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px' }}>{m.label}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1.1 }}>{fmtNum(m.value)}</div>
              {m.rate !== undefined && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>{pct(m.rate)}</div>}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Recent activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <SectionCard title="Recent inbox" badge={c?.inbox_unread || undefined} padding={false}
          actions={<button onClick={() => navigate('/mail/inbox')} style={linkBtn}>View all</button>}>
          <RecentList
            loading={loading}
            empty="No inbound messages"
            rows={(data?.recent_inbound ?? []).map(m => ({
              id: m.id, onClick: () => navigate(`/mail/${m.id}`),
              primary: m.from_name || m.from_email, secondary: m.subject || '(no subject)',
              time: m.received_at, unread: !m.is_read,
            }))}
          />
        </SectionCard>

        <SectionCard title="Recent sent" padding={false}
          actions={<button onClick={() => navigate('/mail/sent')} style={linkBtn}>View all</button>}>
          <RecentList
            loading={loading}
            empty="No sent messages"
            rows={(data?.recent_sent ?? []).map(m => ({
              id: m.id, onClick: () => navigate(`/mail/${m.id}`),
              primary: m.recipient ? `To: ${m.recipient}` : '(no recipient)', secondary: m.subject || '(no subject)',
              time: m.created_at, badge: m.status,
            }))}
          />
        </SectionCard>
      </div>
    </Page>
  )
}

// ── Recent-activity list ──────────────────────────────────────────────────────

const linkBtn: React.CSSProperties = {
  fontSize: TEXT.sm, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', fontWeight: FW.semibold,
}

interface RecentRow {
  id: number; onClick: () => void
  primary: string; secondary: string; time: string
  unread?: boolean; badge?: string
}

function RecentList({ rows, loading, empty }: { rows: RecentRow[]; loading: boolean; empty: string }) {
  if (loading) {
    return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
  }
  if (rows.length === 0) {
    return <div style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>{empty}</div>
  }
  return (
    <div>
      {rows.map(r => (
        <div key={r.id} onClick={r.onClick}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 18px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          {r.unread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: BLUE, flexShrink: 0 }} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: r.unread ? FW.semibold : FW.medium, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.primary}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{r.secondary}</div>
          </div>
          {r.badge && <StatusBadge status={r.badge} size="sm" />}
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--txt3)', flexShrink: 0, paddingLeft: SP[2] }}>{fmtDatetime(r.time)}</span>
        </div>
      ))}
    </div>
  )
}
