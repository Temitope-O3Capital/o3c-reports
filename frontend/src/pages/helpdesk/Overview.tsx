import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, fmtDate, today, monthStart } from '../../lib/fmt'
import {
  NAVY, GREEN, AMBER, RED, BLUE, PURPLE, INTER, NUM, FW, RADIUS, SP, TEXT,
} from '../../lib/design'
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, LabelList, Legend,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TicketAgent {
  agent_name: string
  open_tickets: number
  resolved_today: number
}
interface TicketStats { open: number; sla_breached: number; agents: TicketAgent[] }

interface CallSummary {
  total: number; inbound: number; outbound: number
  missed: number; connected: number
  inbound_connected: number; outbound_connected: number
  total_talk_sec: number; agents: number
  avg_duration_sec: number | null; avg_inbound_sec: number | null; avg_outbound_sec: number | null
}
interface CallDay   { day: string; inbound: number; outbound: number }
interface CallHour  { hour: number; total: number; inbound: number; outbound: number }
interface CallAgent { agent_name: string; total: number; connected: number; avg_duration_sec: number | null }

interface AgentPerf { name: string; calls: number; connected: number; avg: number | null; open: number; resolved: number }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDur(sec: number | null | undefined): string {
  if (sec == null) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
}
function fmtHours(sec: number | null | undefined): string {
  if (!sec) return '0h'
  const h = sec / 3600
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`
}
const pct = (n: number, d: number) => (d > 0 ? n / d : 0)

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0E2841', borderRadius: RADIUS.lg, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label != null && <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? p.payload?.fill ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{fmtNum(p.value)}</span>
          <span style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{p.name}</span>
        </div>
      ))}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CallCenterOverview() {
  const [from, setFrom]   = useState(monthStart())
  const [to, setTo]       = useState(today())
  const [tk, setTk]       = useState<TicketStats | null>(null)
  const [cs, setCs]       = useState<CallSummary | null>(null)
  const [byDay, setByDay]       = useState<CallDay[]>([])
  const [byHour, setByHour]     = useState<CallHour[]>([])
  const [callAgents, setCallAgents] = useState<CallAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const qs = `date_from=${from}&date_to=${to}`
    const obj = (r: any) => (r?.data ?? r)
    const arr = (r: any) => (Array.isArray(r) ? r : (r?.data ?? []))
    try {
      const [tkRes, callRes] = await Promise.all([
        apiFetch<any>(`/api/helpdesk/stats?${qs}&exclude_channel=email,call`),
        apiFetch<any>(`/api/helpdesk/calls/stats?${qs}`),
      ])
      setTk(obj(tkRes))
      const cd = obj(callRes)
      setCs(obj(cd?.summary))
      setByDay(arr(cd?.by_day))
      setByHour(arr(cd?.by_hour))
      setCallAgents(arr(cd?.by_agent))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })

  const total     = cs?.total ?? 0
  const connected = cs?.connected ?? 0
  const inbound   = cs?.inbound ?? 0
  const outbound  = cs?.outbound ?? 0
  const connectRate = pct(connected, total)
  const inAns   = pct(cs?.inbound_connected ?? 0, inbound)
  const outConn = pct(cs?.outbound_connected ?? 0, outbound)
  const activeAgents = cs?.agents ?? 0
  const avgPerAgent = activeAgents > 0 ? Math.round(total / activeAgents) : 0

  // Direction-aware disposition — the DB stores every unanswered call (inbound or
  // outbound) as outcome 'missed', but an unanswered *outbound dial* is a "no answer",
  // not a missed customer call. Splitting them keeps the Overview honest and consistent
  // with My Dashboard / the Call Log (which are already direction-aware). This is an
  // outbound-heavy centre, so the lumped figure otherwise reads as a 5-figure "missed"
  // alarm when almost all of it is just dials that didn't pick up.
  const inboundMissed = Math.max(0, inbound  - (cs?.inbound_connected  ?? 0))
  const outboundNoAns = Math.max(0, outbound - (cs?.outbound_connected ?? 0))
  const inMissRate    = pct(inboundMissed, inbound)

  // Outcome donut, rebuilt direction-aware so the three slices add up to total calls
  // (Connected + Missed-inbound + No-answer-outbound) instead of a single 'missed' blob.
  const outcomeBreakdown = [
    { key: 'connected', label: 'Connected',            count: connected,     color: GREEN },
    { key: 'missed_in', label: 'Missed (inbound)',     count: inboundMissed, color: RED },
    { key: 'noans_out', label: 'No answer (outbound)', count: outboundNoAns, color: AMBER },
  ].filter(o => o.count > 0)

  // Fill all 24 hours so gaps render as zero.
  const hourData = Array.from({ length: 24 }, (_, h) => {
    const f = byHour.find(x => x.hour === h)
    const inbound = f?.inbound ?? 0, outbound = f?.outbound ?? 0
    const label = h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`
    return { label, inbound, outbound }
  })
  const donutTotal = outcomeBreakdown.reduce((s, o) => s + o.count, 0)

  // Merge call + ticket activity per agent for the team-lead performance table.
  const agentMap = new Map<string, AgentPerf>()
  for (const a of callAgents) {
    if (!a.agent_name) continue
    agentMap.set(a.agent_name, { name: a.agent_name, calls: a.total, connected: a.connected, avg: a.avg_duration_sec, open: 0, resolved: 0 })
  }
  for (const t of (tk?.agents ?? [])) {
    const e = agentMap.get(t.agent_name) ?? { name: t.agent_name, calls: 0, connected: 0, avg: null, open: 0, resolved: 0 }
    e.open = t.open_tickets; e.resolved = t.resolved_today
    agentMap.set(t.agent_name, e)
  }
  const agentPerf = [...agentMap.values()].sort((a, b) => b.calls - a.calls || b.resolved - a.resolved)

  const Th = ({ children, right }: { children: string; right?: boolean }) => (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textAlign: right ? 'right' : 'left' }}>{children}</span>
  )
  const barLabel = { fontSize: 10, fill: 'var(--txt2)', fontFamily: INTER, fontWeight: 600 }

  return (
    <Page
      title="Call Center"
      subtitle="Calls, tickets & team performance"
      actions={<DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />}
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : (
        <>
          {/* ── KPI strip ─────────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[3] }}>
            <KpiCard label="Total Calls"    value={fmtNum(total)}                accent={NAVY}  sub={`${fmtNum(outbound)} out · ${fmtNum(inbound)} in`} />
            <KpiCard label="Connected"      value={fmtNum(connected)}            accent={GREEN} sub={`${fmtPct(connectRate)} connect rate`} />
            <KpiCard label="Missed Inbound" value={fmtNum(inboundMissed)}        accent={inMissRate >= 0.2 ? RED : AMBER} sub={`${fmtNum(outboundNoAns)} outbound no-answer`} />
            <KpiCard label="Avg Handle"     value={fmtDur(cs?.avg_duration_sec)} accent={PURPLE} />
            <KpiCard label="Talk Time"      value={fmtHours(cs?.total_talk_sec)} accent={BLUE} />
            <KpiCard label="Open Tickets"   value={fmtNum(tk?.open ?? 0)}        accent={(tk?.sla_breached ?? 0) > 5 ? RED : BLUE} sub={`${fmtNum(tk?.sla_breached ?? 0)} past SLA`} />
          </div>

          {/* ── Team-lead metric strip ────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
            <MiniStat label="Inbound Answer Rate"  value={fmtPct(inAns)}   good={inAns >= 0.8}  hint={`${fmtNum(cs?.inbound_connected ?? 0)} / ${fmtNum(cs?.inbound ?? 0)} answered`} />
            <MiniStat label="Outbound Connect Rate" value={fmtPct(outConn)} good={outConn >= 0.3} hint={`${fmtNum(cs?.outbound_connected ?? 0)} / ${fmtNum(cs?.outbound ?? 0)} connected`} />
            <MiniStat label="Active Agents"        value={fmtNum(activeAgents)} hint="made calls in range" />
            <MiniStat label="Avg Calls / Agent"    value={fmtNum(avgPerAgent)}  hint="workload balance" />
          </div>

          {/* ── Row 1: Call volume (grouped) + Inbound/Outbound split ─────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
            <SectionCard title="Call Volume" subtitle="Inbound vs outbound per day">
              {byDay.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls in this range</div>
              ) : (
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={byDay} margin={{ top: 22, right: 8, bottom: 0, left: 0 }} barGap={3} barCategoryGap="24%">
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => fmtDate(v, { month: 'short', day: 'numeric' })} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} minTickGap={16} />
                    <YAxis hide />
                    <Tooltip cursor={{ fill: 'var(--row-hvr)' }} content={(p: any) => <Tip {...p} label={p?.label ? fmtDate(p.label) : ''} />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs, fontFamily: INTER }} />
                    <Bar dataKey="inbound"  name="Inbound"  fill={BLUE} radius={[3, 3, 0, 0]} maxBarSize={34}>
                      <LabelList dataKey="inbound"  position="top" formatter={(v: number) => (v ? fmtNum(v) : '')} style={barLabel} />
                    </Bar>
                    <Bar dataKey="outbound" name="Outbound" fill={NAVY} radius={[3, 3, 0, 0]} maxBarSize={34}>
                      <LabelList dataKey="outbound" position="top" formatter={(v: number) => (v ? fmtNum(v) : '')} style={barLabel} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="Inbound vs Outbound" subtitle="Volume & connect performance">
              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
                <SplitRow label="Inbound"  icon="call_received" color={BLUE} volume={cs?.inbound ?? 0}  rate={inAns}   rateLabel="answered"  avg={cs?.avg_inbound_sec} />
                <SplitRow label="Outbound" icon="call_made"     color={NAVY} volume={cs?.outbound ?? 0} rate={outConn} rateLabel="connected" avg={cs?.avg_outbound_sec} />
              </div>
            </SectionCard>
          </div>

          {/* ── Busiest hours (inbound + outbound stacked) ─────────────────── */}
          <SectionCard title="Busiest Hours" subtitle="Inbound & outbound by hour of day — plan staffing around the peaks" style={{ marginBottom: SP[4] }}>
            {total === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No calls in this range</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={hourData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="label" interval={1} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ stroke: 'var(--chart-grid)' }} content={(p: any) => <Tip {...p} label={p?.label ?? ''} />} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs, fontFamily: INTER }} />
                  <Line type="monotone" dataKey="inbound"  name="Inbound"  stroke={BLUE} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  <Line type="monotone" dataKey="outbound" name="Outbound" stroke={NAVY} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          {/* ── Row 2: Outcomes doughnut + Agent performance ──────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: SP[4] }}>
            <SectionCard title="Call Outcomes" subtitle="Connected vs unanswered, by direction">
              {donutTotal === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls yet</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <PieChart width={160} height={160}>
                      <Pie data={outcomeBreakdown} cx={76} cy={76} innerRadius={48} outerRadius={74} dataKey="count" nameKey="label" stroke="none" paddingAngle={2} startAngle={90} endAngle={-270}>
                        {outcomeBreakdown.map((o) => <Cell key={o.key} fill={o.color} />)}
                      </Pie>
                      <Tooltip content={(p: any) => <Tip {...p} />} />
                    </PieChart>
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                      <div style={{ fontSize: TEXT.xl, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, lineHeight: 1 }}>{fmtNum(donutTotal)}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: INTER }}>calls</div>
                    </div>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2], minWidth: 0 }}>
                    {outcomeBreakdown.map((o) => (
                      <div key={o.key} style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: o.color, flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)' }}>{o.label}</span>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', ...NUM }}>{fmtNum(o.count)}</span>
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM, width: 40, textAlign: 'right' }}>{fmtPct(pct(o.count, donutTotal))}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>

            <SectionCard title="Agent Performance" subtitle={`${agentPerf.length} agent${agentPerf.length === 1 ? '' : 's'} · calls + tickets`}>
              {agentPerf.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No agent activity yet</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 60px 70px 64px 72px 64px 76px', gap: SP[2], padding: '5px 10px', background: 'var(--th-bg)', borderRadius: RADIUS.md, marginBottom: SP[1], minWidth: 560 }}>
                    <Th>Agent</Th><Th right>Calls</Th><Th right>Connected</Th><Th right>Conn %</Th><Th right>Avg Talk</Th><Th right>Open</Th><Th right>Resolved</Th>
                  </div>
                  {agentPerf.slice(0, 12).map((a, i) => {
                    const cr = pct(a.connected, a.calls)
                    return (
                      <div key={a.name || i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 60px 70px 64px 72px 64px 76px', gap: SP[2], padding: '8px 10px', borderBottom: i < Math.min(agentPerf.length, 12) - 1 ? '1px solid var(--bdr)' : 'none', minWidth: 560 }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || 'Unknown'}</span>
                        <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtNum(a.calls)}</span>
                        <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtNum(a.connected)}</span>
                        <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: a.calls === 0 ? 'var(--txt3)' : cr >= 0.3 ? GREEN : cr >= 0.15 ? AMBER : RED }}>{a.calls ? fmtPct(cr) : '—'}</span>
                        <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDur(a.avg)}</span>
                        <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: a.open > 10 ? AMBER : 'var(--txt2)' }}>{fmtNum(a.open)}</span>
                        <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: a.resolved > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(a.resolved)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </Page>
  )
}

// ── Small components ──────────────────────────────────────────────────────────

function MiniStat({ label, value, hint, good }: { label: string; value: string; hint?: string; good?: boolean }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 5 }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: good == null ? 'var(--txt)' : good ? GREEN : AMBER, lineHeight: 1.1 }}>{value}</div>
      {hint && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3, fontFamily: INTER }}>{hint}</div>}
    </div>
  )
}

function SplitRow({ label, icon, color, volume, rate, rateLabel, avg }: {
  label: string; icon: string; color: string; volume: number; rate: number; rateLabel: string; avg: number | null | undefined
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
      <span className="material-symbols-rounded" style={{ fontSize: 26, color, background: `${color}14`, borderRadius: RADIUS.md, padding: 6 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM }}>{fmtNum(volume)}</span>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{label} calls</span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden', margin: '5px 0 3px' }}>
          <div style={{ width: `${Math.min(100, Math.round(rate * 100))}%`, height: '100%', background: color, borderRadius: 3 }} />
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          <span style={{ color: 'var(--txt)', fontWeight: FW.semibold }}>{fmtPct(rate)}</span> {rateLabel} · avg {fmtDur(avg)}
        </div>
      </div>
    </div>
  )
}
