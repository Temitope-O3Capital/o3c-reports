import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, ErrBanner, Spinner, Modal } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDate } from '../../lib/fmt'
import { toast } from 'sonner'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { BAND_COLOR, qaBand } from '../../lib/qa'

// ── Config / types ──────────────────────────────────────────────────────────

const DAILY_TARGET = 60 // calls-per-day goal driving the progress ring

interface MyTicket {
  id: number; ticket_ref: string; subject: string
  customer_name: string; priority: string; status: string
  created_at: string; sla_due_at: string | null
  last_message_direction?: string; awaiting_me?: boolean
}
interface MyCall { id: number; direction: string; customer: string; outcome: string; duration_sec: number | null; started_at: string }
interface AgentDash {
  open_tickets: number; resolved_today: number
  sla_breached: number; csat_score: number | null; avg_handle_time_mins: number
  awaiting_my_reply: number; queue_pending: number; callbacks_due: number
  my_calls: { calls_today: number; connected_today: number; missed_today: number; avg_talk_sec: number }
  calls_yesterday: number; rank_today: number; team_size: number
  daily_call_target: number; my_status: string
  call_by_day: { day: string; total: number; missed: number }[]
  by_hour_today: { hour: number; total: number; missed: number }[]
  recent_calls: MyCall[]
  recent_tickets: MyTicket[]
}

const STATUS_OPTS: { value: string; label: string; color: string }[] = [
  { value: 'available', label: 'Available', color: GREEN },
  { value: 'on_call',   label: 'On Call',   color: BLUE },
  { value: 'break',     label: 'Break',     color: AMBER },
  { value: 'offline',   label: 'Offline',   color: '#94A3B8' },
]
function myUserId(): number {
  try { return Number(JSON.parse(localStorage.getItem('o3c_user') || '{}').id) || 0 } catch { return 0 }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDur(sec: number | null | undefined): string {
  if (sec == null) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
}
function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}
function firstName(): string {
  try {
    const u = JSON.parse(localStorage.getItem('o3c_user') || '{}')
    return String(u.name || u.full_name || '').split(' ')[0] || 'there'
  } catch { return 'there' }
}
function relTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return fmtDate(iso)
}
const isMissed = (o: string) => ['missed', 'no_answer', 'voicemail'].includes(o)
const ordinal = (n: number) => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`
const PRIORITY_COLOR: Record<string, string> = { high: RED, medium: AMBER, low: BLUE, urgent: RED, normal: 'var(--chart-lbl)' }

// ── Small pieces ──────────────────────────────────────────────────────────────

function LiveClock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setT(new Date()), 1000); return () => clearInterval(id) }, [])
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const date = t.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 24, fontWeight: FW.extrabold, color: '#fff', ...NUM, lineHeight: 1 }}>{time}</div>
      <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.6)', fontFamily: INTER, marginTop: 3 }}>{date}</div>
    </div>
  )
}

function Ring({ value, max, size = 128, stroke = 12 }: { value: number; max: number; size?: number; stroke?: number }) {
  const p = max > 0 ? Math.min(1, value / max) : 0
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const color = p >= 1 ? GREEN : p >= 0.6 ? '#4ADE80' : '#38BDF8'
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.16)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - p)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset .7s cubic-bezier(.4,0,.2,1)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 30, fontWeight: FW.extrabold, color: '#fff', ...NUM, lineHeight: 1 }}>{fmtNum(value)}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.55)', fontFamily: INTER }}>of {max} calls</div>
      </div>
    </div>
  )
}

function HeroStat({ label, value, delta, color }: { label: string; value: string; delta?: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,.08)', borderRadius: RADIUS.lg, padding: '11px 14px', minWidth: 92 }}>
      <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.55)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
        <span style={{ ...NUM, fontSize: 22, fontWeight: FW.extrabold, color: color ?? '#fff', lineHeight: 1 }}>{value}</span>
        {delta}
      </div>
    </div>
  )
}

function StatusPill({ label, color }: { label: string; color: string }) {
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'], background: `${color}18`, color, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{label}</span>
}

function PresenceControl({ status, onChange }: { status: string; onChange: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const cur = STATUS_OPTS.find(o => o.value === status) ?? STATUS_OPTS[0]
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} title="Set your status" style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(255,255,255,.14)', color: '#fff',
        border: 'none', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '4px 11px', borderRadius: RADIUS['2xl'], cursor: 'pointer',
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: cur.color, animation: status === 'available' ? 'ccpulse 1.8s infinite' : 'none' }} />
        {cur.label}
        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>expand_more</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '112%', left: 0, zIndex: 41, background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.md, boxShadow: '0 12px 32px rgba(0,0,0,.22)', padding: 4, minWidth: 158 }}>
            {STATUS_OPTS.map(o => (
              <button key={o.value} onClick={() => { onChange(o.value); setOpen(false) }} style={{
                display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none',
                background: o.value === status ? 'var(--row-hvr)' : 'transparent', color: 'var(--txt)', fontSize: TEXT.sm,
                cursor: 'pointer', borderRadius: RADIUS.sm, textAlign: 'left', fontWeight: o.value === status ? FW.semibold : FW.normal,
              }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: o.color }} />{o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
function SlaCell({ sla_due_at }: { sla_due_at: string | null }) {
  if (!sla_due_at) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const ms = new Date(sla_due_at).getTime() - Date.now()
  if (ms < 0) return <StatusPill label="Breached" color={RED} />
  const mins = Math.floor(ms / 60_000)
  const color = ms < 7_200_000 ? RED : ms < 21_600_000 ? AMBER : GREEN
  return <span style={{ color, fontWeight: FW.semibold, fontSize: TEXT.xs }}>{mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}</span>
}
function MyDayTile({ icon, count, label, sub, color, urgent, onClick }: {
  icon: string; count: React.ReactNode; label: string; sub: string; color: string; urgent?: boolean; onClick?: () => void
}) {
  const clickable = !!onClick
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 13, padding: '15px 16px',
      background: 'var(--card)', border: `1px solid ${urgent ? color + '55' : 'var(--card-bdr)'}`,
      borderRadius: RADIUS.lg, cursor: clickable ? 'pointer' : 'default',
      boxShadow: urgent ? `inset 3px 0 0 ${color}` : 'none', transition: 'transform .12s ease, box-shadow .12s ease',
    }}
      onMouseEnter={e => { if (clickable) { const el = e.currentTarget as HTMLElement; el.style.transform = 'translateY(-2px)'; el.style.boxShadow = `${urgent ? `inset 3px 0 0 ${color}, ` : ''}0 8px 22px rgba(14,40,65,.12)` } }}
      onMouseLeave={e => { if (clickable) { const el = e.currentTarget as HTMLElement; el.style.transform = 'none'; el.style.boxShadow = urgent ? `inset 3px 0 0 ${color}` : 'none' } }}>
      <span className="material-symbols-rounded" style={{ fontSize: 23, color, background: `${color}16`, borderRadius: RADIUS.md, padding: 9, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...NUM, fontSize: 25, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1 }}>{count}</div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 1 }}>{sub}</div>
      </div>
      {clickable && <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)', flexShrink: 0 }}>chevron_right</span>}
    </div>
  )
}
function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0E2841', border: '1px solid rgba(255,255,255,.08)', borderRadius: RADIUS.lg, padding: '9px 13px', boxShadow: '0 8px 28px rgba(0,0,0,.4)' }}>
      <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.5)', fontFamily: INTER, marginBottom: 5, textTransform: 'uppercase' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: i > 0 ? 3 : 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color }} />
          <span style={{ fontSize: TEXT.sm, color: '#fff', fontWeight: FW.bold, ...NUM }}>{p.value}</span>
          <span style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.5)' }}>{p.name}</span>
        </div>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CallCenterMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<AgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [status, setStatus] = useState('available')
  const [qa, setQa] = useState<{ summary: any; recent: any[] } | null>(null)
  useEffect(() => { apiFetch<any>('/api/qa/my').then(setQa).catch(() => {}) }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/helpdesk/my-dashboard')
      const raw = r?.data ?? r ?? {}
      setStatus(raw.my_status ?? 'available')
      setD({
        open_tickets: raw.open_tickets ?? 0,
        resolved_today: raw.resolved_today ?? 0,
        sla_breached: Number(raw.sla_breached ?? 0),
        csat_score: raw.csat_score != null ? Number(raw.csat_score) : null,
        avg_handle_time_mins: Number(raw.avg_handle_time_mins ?? 0),
        awaiting_my_reply: Number(raw.awaiting_my_reply ?? 0),
        queue_pending: Number(raw.queue_pending ?? 0),
        callbacks_due: Number(raw.callbacks_due ?? 0),
        my_calls: raw.my_calls ?? { calls_today: 0, connected_today: 0, missed_today: 0, avg_talk_sec: 0 },
        calls_yesterday: raw.calls_yesterday ?? 0,
        rank_today: raw.rank_today ?? 0,
        team_size: raw.team_size ?? 0,
        daily_call_target: raw.daily_call_target ?? 60,
        my_status: raw.my_status ?? 'available',
        call_by_day: raw.call_by_day ?? [],
        by_hour_today: raw.by_hour_today ?? [],
        recent_calls: raw.recent_calls ?? [],
        recent_tickets: raw.recent_tickets ?? raw.my_tickets ?? [],
      })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })
  // Auto-refresh for a live feel.
  useEffect(() => { const id = setInterval(load, 45000); return () => clearInterval(id) }, [load])

  const changeStatus = useCallback(async (s: string) => {
    setStatus(s)
    const id = myUserId()
    if (!id) return
    try {
      await apiFetch(`/api/helpdesk/agents/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: s }) })
    } catch (e: any) { toast.error(e?.message || 'Could not update status') }
  }, [])

  if (loading && !d) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !d) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!d) return null

  const c = d.my_calls
  const connectRate = c.calls_today > 0 ? Math.round((c.connected_today / c.calls_today) * 100) : 0
  const dayDelta = c.calls_today - d.calls_yesterday
  const hourData = Array.from({ length: 24 }, (_, h) => {
    const f = d.by_hour_today.find(x => x.hour === h)
    return { label: String(h).padStart(2, '0'), total: f?.total ?? 0 }
  }).filter((_, h) => h >= 6 && h <= 20) // working window
  const peak = Math.max(1, ...hourData.map(x => x.total))
  const total14 = d.call_by_day.reduce((s, x) => s + x.total, 0)
  const liveBadge = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: GREEN, textTransform: 'uppercase', letterSpacing: '.05em' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN, animation: 'ccpulse 1.8s infinite' }} />live
    </span>
  )

  const deltaEl = (v: number) => v === 0
    ? <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.5)' }}>—</span>
    : <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: v > 0 ? '#4ADE80' : '#FCA5A5' }}>{v > 0 ? '▲' : '▼'} {Math.abs(v)}</span>

  const qbtn = (icon: string, label: string, to: string, primary = false): React.ReactNode => (
    <button onClick={() => navigate(to)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md,
      background: primary ? '#fff' : 'rgba(255,255,255,.12)', color: primary ? NAVY : '#fff',
      border: 'none', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{icon}</span>{label}
    </button>
  )

  return (
    <Page title="My Workspace" subtitle="Your live call-center station">
      <ErrBanner error={error} onRetry={load} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(120deg, #0E2841 0%, #17395c 55%, #1e4a74 100%)',
        borderRadius: RADIUS.xl, padding: '22px 26px', marginBottom: SP[4], color: '#fff',
        boxShadow: '0 10px 30px rgba(14,40,65,.28)',
      }}>
        {/* top line: greeting + status + clock */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 22, fontWeight: FW.extrabold }}>{greeting()}, {firstName()}</span>
              <PresenceControl status={status} onChange={changeStatus} />
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'rgba(255,255,255,.6)', marginTop: 5 }}>
              {d.rank_today > 0
                ? <>You're <strong style={{ color: '#fff' }}>{ordinal(d.rank_today)}</strong> on the team today {d.team_size ? `of ${d.team_size}` : ''} · keep it going 💪</>
                : 'Ready when you are — start dialing to climb the board.'}
            </div>
          </div>
          <LiveClock />
        </div>

        {/* main: ring + momentum + today activity */}
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 26, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <Ring value={c.calls_today} max={d.daily_call_target || DAILY_TARGET} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <HeroStat label="Calls Today" value={fmtNum(c.calls_today)} delta={deltaEl(dayDelta)} />
              <HeroStat label="Connected"   value={fmtNum(c.connected_today)} color="#4ADE80" delta={<span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.5)' }}>{connectRate}%</span>} />
              <HeroStat label="Missed"      value={fmtNum(c.missed_today)} color={c.missed_today > 0 ? '#FCA5A5' : '#fff'} />
              <HeroStat label="Avg Talk"    value={fmtDur(c.avg_talk_sec)} />
              <HeroStat label="Resolved"    value={fmtNum(d.resolved_today)} color="#4ADE80" />
              <HeroStat label="Open Tickets" value={fmtNum(d.open_tickets)} />
              <HeroStat label="Avg Handle"  value={d.avg_handle_time_mins > 0 ? `${d.avg_handle_time_mins}m` : '—'} />
            </div>
          </div>

          {/* today's activity sparkbars */}
          <div style={{ background: 'rgba(255,255,255,.06)', borderRadius: RADIUS.lg, padding: '12px 16px', alignSelf: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.55)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Today's activity · by hour</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 56 }}>
              {hourData.map((h, i) => (
                <div key={i} title={`${h.label}:00 — ${h.total} calls`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <div style={{ width: '100%', height: `${Math.max(3, (h.total / peak) * 46)}px`, background: h.total >= peak * 0.8 ? '#38BDF8' : 'rgba(255,255,255,.35)', borderRadius: 3, transition: 'height .5s ease' }} />
                  <span style={{ fontSize: 8, color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{h.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* quick actions */}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          <button onClick={() => setLogOpen(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md,
            background: '#fff', color: NAVY, border: 'none', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>add_call</span>Log a Call
          </button>
          {qbtn('dialpad', 'Outbound Queue', '/call-center/queue')}
          {qbtn('confirmation_number', 'Ticket Queue', '/helpdesk/tickets')}
          {qbtn('menu_book', 'Knowledge Base', '/helpdesk/knowledge-base')}
        </div>
      </div>

      {/* ── My Day: forward-looking work + quality ───────────────────────── */}
      <div style={{ marginBottom: SP[4] }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 11 }}>
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>My Day</span>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>what needs your attention now</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(212px, 1fr))', gap: SP[3] }}>
          <MyDayTile icon="reply" count={fmtNum(d.awaiting_my_reply)} label="Awaiting your reply"
            sub={d.awaiting_my_reply > 0 ? 'customers waiting on you' : "you're caught up"}
            color={AMBER} urgent={d.awaiting_my_reply > 0} onClick={() => navigate('/helpdesk/tickets')} />
          <MyDayTile icon="warning" count={fmtNum(d.sla_breached)} label="SLA breached"
            sub={d.sla_breached > 0 ? 'past due — act now' : 'all within SLA'}
            color={d.sla_breached > 0 ? RED : GREEN} urgent={d.sla_breached > 0} onClick={() => navigate('/helpdesk/tickets')} />
          <MyDayTile icon="dialpad" count={fmtNum(d.queue_pending)} label="Outbound queue"
            sub="contacts ready to dial" color={BLUE} onClick={() => navigate('/call-center/queue')} />
          {d.callbacks_due > 0 && (
            <MyDayTile icon="event_repeat" count={fmtNum(d.callbacks_due)} label="Callbacks due"
              sub="call-backs you promised" color={PURPLE} urgent onClick={() => navigate('/call-center/queue')} />
          )}
          <MyDayTile icon="sentiment_satisfied" count={d.csat_score != null ? `${d.csat_score}` : '—'} label="Your CSAT"
            sub={d.csat_score != null ? 'avg customer satisfaction' : 'no surveys scored yet'} color={PURPLE} />
        </div>
      </div>

      {/* ── Row: call volume + live feed ─────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="My Call Volume" subtitle="Calls per day — last 14 days"
          actions={<span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', ...NUM }}>{fmtNum(total14)} calls · 14d</span>}>
          {d.call_by_day.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls in the last 14 days</div>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={d.call_by_day} margin={{ top: 6, right: 10, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={NAVY} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="day" tickFormatter={v => fmtDate(v, { month: 'short', day: 'numeric' })} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTip />} />
                <Area type="monotone" dataKey="total"  name="Total"  stroke={NAVY} strokeWidth={2.4} fill="url(#volGrad)" dot={false} />
                <Area type="monotone" dataKey="missed" name="Missed" stroke={RED} strokeWidth={2} fill="transparent" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        <SectionCard title="Live Activity" subtitle="Your most recent calls" actions={liveBadge}>
          {d.recent_calls.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls yet — start dialing</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 232, overflowY: 'auto' }}>
              {d.recent_calls.map((r, i) => {
                const out = r.direction?.toLowerCase() === 'outbound'
                const missed = isMissed(r.outcome)
                return (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px', borderBottom: i < d.recent_calls.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 18, color: missed ? RED : out ? NAVY : BLUE, background: `${missed ? RED : out ? NAVY : BLUE}14`, borderRadius: RADIUS.sm, padding: 5 }}>
                      {missed ? 'call_missed' : out ? 'call_made' : 'call_received'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.customer}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{out ? 'Outbound' : 'Inbound'} · {fmtDur(r.duration_sec)}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <StatusPill label={missed ? 'Missed' : 'Done'} color={missed ? RED : GREEN} />
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3 }}>{relTime(r.started_at)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── My tickets ───────────────────────────────────────────────────── */}
      <SectionCard title="My Open Tickets" badge={d.recent_tickets.length}
        subtitle={d.awaiting_my_reply > 0 ? `${d.awaiting_my_reply} awaiting your reply — shown first` : 'Sorted by urgency'}
        actions={<button onClick={() => navigate('/helpdesk/tickets')} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: 'none', border: 'none', cursor: 'pointer' }}>View all →</button>}>
        {d.recent_tickets.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '34px 0', color: 'var(--txt2)' }}>No open tickets — you're all caught up 🎉</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {d.recent_tickets.map((t, i) => {
              const pc = PRIORITY_COLOR[t.priority?.toLowerCase()] ?? NAVY
              return (
                <div key={t.id} onClick={() => navigate(`/helpdesk/${t.id}`)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', borderBottom: i < d.recent_tickets.length - 1 ? '1px solid var(--bdr)' : 'none', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                  <div style={{ width: 3, alignSelf: 'stretch', background: pc, borderRadius: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || '(no subject)'}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}><span style={{ fontFamily: 'var(--font-mono)' }}>{t.ticket_ref}</span> · {t.customer_name || 'Unknown'}</div>
                  </div>
                  {t.awaiting_me && <StatusPill label="Awaiting you" color={AMBER} />}
                  <StatusPill label={t.priority} color={pc} />
                  <div style={{ width: 70, textAlign: 'right', flexShrink: 0 }}><SlaCell sla_due_at={t.sla_due_at} /></div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>

      {/* ── My QA scores ─────────────────────────────────────────────────── */}
      {qa && Number(qa.summary?.evaluations ?? 0) > 0 && (() => {
        const avg = Number(qa.summary?.avg_score ?? 0)
        const col = BAND_COLOR[qaBand(avg)] ?? NAVY
        const latest = qa.recent?.[0]
        return (
          <SectionCard title="My QA Scores" subtitle="How your calls have been rated by QA" style={{ marginTop: SP[4] }}
            badge={Number(qa.summary?.evaluations ?? 0)}>
            <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: SP[4] }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 0', background: `${col}0d`, border: `1px solid ${col}30`, borderRadius: RADIUS.lg }}>
                <span style={{ ...NUM, fontSize: 38, fontWeight: FW.extrabold, color: col, lineHeight: 1 }}>{avg}%</span>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: col }}>{qaBand(avg)}</span>
                <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                  <span>{Number(qa.summary?.passed ?? 0)}/{Number(qa.summary?.evaluations ?? 0)} passed</span>
                  {Number(qa.summary?.critical_errors ?? 0) > 0 && <span style={{ color: RED, fontWeight: FW.semibold }}>{qa.summary.critical_errors} critical</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {latest && (latest.strengths || latest.improvements || latest.coaching_notes) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '10px 12px', background: 'var(--th-bg)', borderRadius: RADIUS.md, fontSize: TEXT.sm, marginBottom: 4 }}>
                    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Latest feedback</span>
                    {latest.strengths && <span><b style={{ color: GREEN }}>Strengths:</b> {latest.strengths}</span>}
                    {latest.improvements && <span><b style={{ color: AMBER }}>Improve:</b> {latest.improvements}</span>}
                    {latest.coaching_notes && <span><b style={{ color: NAVY }}>Coaching:</b> {latest.coaching_notes}</span>}
                  </div>
                )}
                {qa.recent.slice(0, 5).map((r: any) => {
                  const c = BAND_COLOR[r.rating_band] ?? NAVY
                  return (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 2px', borderBottom: '1px solid var(--bdr)' }}>
                      <span style={{ ...NUM, width: 46, fontSize: TEXT.sm, fontWeight: FW.bold, color: c }}>{Number(r.total_score)}%</span>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '1px 8px', borderRadius: RADIUS['2xl'], background: `${c}18`, color: c }}>{r.rating_band}</span>
                      <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.customer_name || 'Unknown'} · {r.call_direction}</span>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: r.passed ? GREEN : RED }}>{r.passed ? 'Pass' : 'Fail'}</span>
                      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDate(r.created_at)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </SectionCard>
        )
      })()}

      <LogCallModal open={logOpen} onClose={() => setLogOpen(false)} onSaved={load} />

      <style>{`@keyframes ccpulse { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,.55) } 70% { box-shadow: 0 0 0 7px rgba(74,222,128,0) } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0) } }`}</style>
    </Page>
  )
}

// ── Log-a-call modal ──────────────────────────────────────────────────────────

const OUTCOMES = [
  { value: 'completed', label: 'Completed' },
  { value: 'missed', label: 'Missed / No answer' },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'callback', label: 'Callback requested' },
]

function LogCallModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [direction, setDirection] = useState('Outbound')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [outcome, setOutcome] = useState('completed')
  const [duration, setDuration] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() { setDirection('Outbound'); setName(''); setPhone(''); setOutcome('completed'); setDuration(''); setNotes('') }

  async function submit() {
    if (!name.trim() && !phone.trim()) { toast.error('Add a customer name or phone'); return }
    setSaving(true)
    try {
      await apiPost('/api/helpdesk/calls', {
        customer_name: name.trim(), customer_phone: phone.trim(),
        direction, outcome,
        duration_seconds: duration ? Number(duration) : undefined,
        notes: notes.trim() || undefined,
      })
      toast.success('Call logged')
      reset(); onClose(); onSaved()
    } catch (e: any) { toast.error(e?.message || 'Could not log call') }
    finally { setSaving(false) }
  }

  const fld: React.CSSProperties = { width: '100%', height: 38, padding: '0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.03em' }

  return (
    <Modal open={open} onClose={onClose} title="Log a Call" width={480}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer' }}>
            {saving && <Spinner size={13} color="#fff" />}Log Call
          </button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div>
          <label style={lbl}>Direction</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['Outbound', 'Inbound'].map(dir => (
              <button key={dir} onClick={() => setDirection(dir)} style={{
                flex: 1, padding: '9px 0', borderRadius: RADIUS.md, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: `1px solid ${direction === dir ? NAVY : 'var(--bdr)'}`, background: direction === dir ? `${NAVY}0e` : 'var(--card)', color: direction === dir ? NAVY : 'var(--txt2)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{dir === 'Outbound' ? 'call_made' : 'call_received'}</span>{dir}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div><label style={lbl}>Customer Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" style={fld} /></div>
          <div><label style={lbl}>Phone</label><input value={phone} onChange={e => setPhone(e.target.value)} placeholder="080…" style={fld} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div><label style={lbl}>Outcome</label><select value={outcome} onChange={e => setOutcome(e.target.value)} style={fld}>{OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
          <div><label style={lbl}>Duration (sec)</label><input type="number" min={0} value={duration} onChange={e => setDuration(e.target.value)} placeholder="e.g. 120" style={fld} /></div>
        </div>
        <div>
          <label style={lbl}>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What was discussed…" style={{ ...fld, height: 'auto', padding: '9px 11px', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
      </div>
    </Modal>
  )
}
