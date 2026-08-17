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
import {
  WorkspaceHero, MyDaySection, MyDayTile, PresenceControl, StatusPill, ChartTip,
  HourlyActivity, HeroButton, LiveBadge, heroDelta, fmtDur, relTime, ordinal, myUserId,
} from '../../components/MyWorkspace'
import NewTicketForm from './NewTicket'
import ScheduleCallbackModal from '../../components/ScheduleCallbackModal'
import LogCallModal, { LogCallInitial } from '../../components/LogCallModal'

// ── Config / types ──────────────────────────────────────────────────────────

const DAILY_TARGET = 60 // calls-per-day goal driving the progress ring

interface MyTicket {
  id: number; ticket_ref: string; subject: string
  customer_name: string; priority: string; status: string
  created_at: string; sla_due_at: string | null
  last_message_direction?: string; awaiting_me?: boolean
}
interface MyCall {
  id: number; direction: string; customer: string; phone?: string; purpose?: string
  customer_cif?: string; outcome: string; duration_sec: number | null; started_at: string; ticket_id?: number | null
}
interface AgentDash {
  open_tickets: number; resolved_today: number
  sla_breached: number; csat_score: number | null; avg_handle_time_mins: number
  awaiting_my_reply: number; queue_pending: number; callbacks_due: number
  my_calls: {
    calls_today: number; outbound_today: number; inbound_today: number
    connected_today: number; missed_today: number; no_answer_today: number
    avg_talk_sec: number; talk_time_sec: number
  }
  calls_yesterday: number; rank_today: number; team_size: number
  daily_call_target: number; my_status: string
  call_this_week: { day: string; dow: string; total: number; missed: number }[]
  by_hour_today: { hour: number; total: number; missed: number }[]
  recent_calls: MyCall[]
  recent_tickets: MyTicket[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOT_ANSWERED = ['missed', 'no_answer', 'voicemail']
// A "missed call" is an INBOUND call we didn't answer. An unanswered OUTBOUND dial is
// "No answer" — the customer didn't pick, which is not the agent's miss.
function callDisposition(direction?: string, outcome?: string): { label: string; color: string; icon: string } {
  const answered = !NOT_ANSWERED.includes((outcome || '').toLowerCase())
  const inbound = (direction || '').toLowerCase() === 'inbound'
  if (answered)  return { label: 'Done', color: GREEN, icon: inbound ? 'call_received' : 'call_made' }
  if (inbound)   return { label: 'Missed', color: RED, icon: 'call_missed' }
  return { label: 'No answer', color: 'var(--txt3)', icon: 'call_made' }
}
const PRIORITY_COLOR: Record<string, string> = { high: RED, medium: AMBER, low: BLUE, urgent: RED, normal: 'var(--chart-lbl)' }
const PURPOSE_META: Record<string, { label: string; color: string }> = {
  marketing:   { label: 'Marketing',   color: BLUE },
  collections: { label: 'Collections', color: AMBER },
  support:     { label: 'Support',     color: PURPLE },
}

function SlaCell({ sla_due_at }: { sla_due_at: string | null }) {
  if (!sla_due_at) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const ms = new Date(sla_due_at).getTime() - Date.now()
  if (ms < 0) return <StatusPill label="Breached" color={RED} />
  const mins = Math.floor(ms / 60_000)
  const color = ms < 7_200_000 ? RED : ms < 21_600_000 ? AMBER : GREEN
  return <span style={{ color, fontWeight: FW.semibold, fontSize: TEXT.xs }}>{mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}</span>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CallCenterMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<AgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [logInitial, setLogInitial] = useState<LogCallInitial | undefined>(undefined)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [ticketInitial, setTicketInitial] = useState<{ cif?: string; name?: string; phone?: string } | undefined>(undefined)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [status, setStatus] = useState('available')
  const [qa, setQa] = useState<{ summary: any; recent: any[] } | null>(null)
  useEffect(() => { apiFetch<any>('/api/qa/my').then(setQa).catch(() => {}) }, [])

  // Open the Log-a-Call modal, optionally pre-filled for a specific call/number.
  const openLog = useCallback((initial?: LogCallInitial) => {
    setLogInitial(initial); setLogOpen(true)
  }, [])

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
        my_calls: raw.my_calls ?? { calls_today: 0, outbound_today: 0, inbound_today: 0, connected_today: 0, missed_today: 0, no_answer_today: 0, avg_talk_sec: 0, talk_time_sec: 0 },
        calls_yesterday: raw.calls_yesterday ?? 0,
        rank_today: raw.rank_today ?? 0,
        team_size: raw.team_size ?? 0,
        daily_call_target: raw.daily_call_target ?? 60,
        my_status: raw.my_status ?? 'available',
        call_this_week: raw.call_this_week ?? [],
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
  const totalWeek = d.call_this_week.reduce((s, x) => s + Number(x.total), 0)

  return (
    <Page title="My Workspace" subtitle="Your live call-center station">
      <ErrBanner error={error} onRetry={load} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <WorkspaceHero
        presence={<PresenceControl status={status} onChange={changeStatus} />}
        subline={d.rank_today > 0
          ? <>You're <strong style={{ color: '#fff' }}>{ordinal(d.rank_today)}</strong> on the team today {d.team_size ? `of ${d.team_size}` : ''} · keep it going 💪</>
          : 'Ready when you are — start dialing to climb the board.'}
        ring={{ value: c.calls_today, max: d.daily_call_target || DAILY_TARGET, unit: 'calls' }}
        stats={[
          { label: 'Calls Today', value: fmtNum(c.calls_today), delta: heroDelta(dayDelta) },
          { label: 'Outbound', value: fmtNum(c.outbound_today) },
          { label: 'Inbound', value: fmtNum(c.inbound_today) },
          { label: 'Connected', value: fmtNum(c.connected_today), color: '#4ADE80', delta: <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.5)' }}>{connectRate}%</span> },
          { label: 'No Answer', value: fmtNum(c.no_answer_today), delta: <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.5)' }}>outbound</span> },
          { label: 'Missed', value: fmtNum(c.missed_today), color: Number(c.missed_today) > 0 ? '#FCA5A5' : '#fff', delta: <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.5)' }}>inbound</span> },
          { label: 'Talk Time', value: fmtDur(c.talk_time_sec) },
          { label: 'Avg Talk', value: fmtDur(c.avg_talk_sec) },
          { label: 'Resolved', value: fmtNum(d.resolved_today), color: '#4ADE80' },
          { label: 'Open Tickets', value: fmtNum(d.open_tickets) },
          { label: 'Avg Handle', value: d.avg_handle_time_mins > 0 ? `${d.avg_handle_time_mins}m` : '—' },
        ]}
        aside={<HourlyActivity data={d.by_hour_today} />}
        actions={<>
          <HeroButton icon="add_call" label="Log a Call" primary onClick={() => openLog()} />
          <HeroButton icon="note_add" label="New Ticket" onClick={() => { setTicketInitial(undefined); setTicketOpen(true) }} />
          <HeroButton icon="event_upcoming" label="Schedule Callback" onClick={() => setScheduleOpen(true)} />
          <HeroButton icon="dialpad" label="Outbound Queue" onClick={() => navigate('/call-center/queue')} />
          <HeroButton icon="confirmation_number" label="Ticket Queue" onClick={() => navigate('/helpdesk/tickets')} />
          <HeroButton icon="call_log" label="Call Log" onClick={() => navigate('/helpdesk/calls')} />
          <HeroButton icon="menu_book" label="Knowledge Base" onClick={() => navigate('/helpdesk/knowledge-base')} />
        </>}
      />

      {/* ── My Day: forward-looking work + quality ───────────────────────── */}
      <MyDaySection>
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
      </MyDaySection>

      {/* ── This week's call volume (Sun–Sat) ────────────────────────────── */}
      <SectionCard title="My Call Volume" subtitle="This week · Sunday–Saturday" style={{ marginBottom: SP[4] }}
        actions={<span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', ...NUM }}>{fmtNum(totalWeek)} calls this week</span>}>
        {d.call_this_week.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls this week yet</div>
        ) : (
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={d.call_this_week} margin={{ top: 6, right: 10, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={NAVY} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="dow" tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTip />} />
              <Area type="monotone" dataKey="total"  name="Calls"        stroke={NAVY} strokeWidth={2.4} fill="url(#volGrad)" dot={{ r: 2.5, fill: NAVY }} />
              <Area type="monotone" dataKey="missed" name="Missed (in)"  stroke={RED} strokeWidth={2} fill="transparent" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </SectionCard>

      {/* ── My Call Log ──────────────────────────────────────────────────── */}
      <SectionCard title="My Call Log" subtitle="Your most recent calls" badge={d.recent_calls.length} style={{ marginBottom: SP[4] }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <LiveBadge />
            <button onClick={() => navigate('/helpdesk/calls')} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: 'none', border: 'none', cursor: 'pointer' }}>Full log →</button>
          </div>
        }>
        {d.recent_calls.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls yet — start dialing</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 420, overflowY: 'auto' }}>
            {d.recent_calls.map((r, i) => {
              const out = r.direction?.toLowerCase() === 'outbound'
              const disp = callDisposition(r.direction, r.outcome)
              const pm = r.purpose ? PURPOSE_META[r.purpose] : undefined
              return (
                <div key={r.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 4px', borderBottom: i < d.recent_calls.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 18, color: disp.color === 'var(--txt3)' ? (out ? NAVY : BLUE) : disp.color, background: `${disp.color === 'var(--txt3)' ? (out ? NAVY : BLUE) : disp.color}14`, borderRadius: RADIUS.sm, padding: 5, flexShrink: 0 }}>
                    {disp.icon}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.customer}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span>{out ? 'Outbound' : 'Inbound'}</span>
                      {r.phone && <><span>·</span><span style={{ fontFamily: 'var(--font-mono)' }}>{r.phone}</span></>}
                      <span>·</span><span>{fmtDur(r.duration_sec)}</span>
                    </div>
                  </div>
                  {pm && <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${pm.color}16`, color: pm.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{pm.label}</span>}
                  <StatusPill label={disp.label} color={disp.color === 'var(--txt3)' ? 'var(--txt3)' : disp.color} />
                  <div style={{ width: 58, textAlign: 'right', flexShrink: 0, fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{relTime(r.started_at)}</div>
                  {/* Log a report for this number — opens the modal pre-filled. */}
                  <button title="Log a report for this call" onClick={() => openLog({ name: r.customer, phone: r.phone, cif: r.customer_cif })}
                    style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: NAVY, fontSize: TEXT['2xs'], fontWeight: FW.semibold, cursor: 'pointer' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit_note</span>Log
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>

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

      <LogCallModal open={logOpen} initial={logInitial} onClose={() => setLogOpen(false)} onSaved={load} />

      <ScheduleCallbackModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} onSaved={load} />

      {/* New-ticket modal — raise a ticket without leaving the dashboard. */}
      <Modal open={ticketOpen} onClose={() => setTicketOpen(false)} title="New Ticket" width={620}>
        <NewTicketForm
          initial={ticketInitial}
          onClose={() => setTicketOpen(false)}
          onCreated={id => { setTicketOpen(false); navigate(`/helpdesk/${id}`) }}
        />
      </Modal>
    </Page>
  )
}

