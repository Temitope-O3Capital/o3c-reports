import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, Spinner, ErrBanner, Modal } from '../../components/UI'
import QAHub from './QAHub'
import PerformancePanel from './PerformancePanel'
import { AgentMatchingPanel } from '../call-center/AgentMatching'
import { BAND_COLOR, qaBand } from '../../lib/qa'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, today } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, BLUE, PURPLE, INTER, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentRow {
  id: number
  full_name: string
  helpdesk_status?: string
  open_tickets: number
  sla_breached: number
  calls_today: number
  connected_today: number
  avg_talk_sec: number
  last_reply?: string
  qa_avg_score?: number | null
  qa_evals?: number
}
interface BreachRow { id: number; ticket_ref: string; subject: string; priority: string; sla_due_at: string; assigned_to_name?: string }
interface SupervisorData {
  totals: { open: number; sla_breached: number; unassigned: number; active_agents: number }
  agents: AgentRow[]
  recent_breaches: BreachRow[]
}
interface CallStats {
  summary: { total: number; connected: number; missed: number }
  by_hour: { hour: number; inbound: number; outbound: number }[]
  by_outcome: { outcome: string; count: number }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  available: { label: 'Available', color: GREEN },
  on_call:   { label: 'On Call',   color: BLUE },
  busy:      { label: 'Busy',      color: AMBER },
  break:     { label: 'Break',     color: AMBER },
  offline:   { label: 'Offline',   color: 'var(--chart-lbl)' },
}
const statusCfg = (s?: string) => STATUS_CONFIG[s?.toLowerCase() ?? ''] ?? { label: s ?? 'Available', color: GREEN }
const isOffline = (s?: string) => (s?.toLowerCase() ?? '') === 'offline'

function fmtDur(sec: number | null | undefined): string {
  if (!sec) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
}
const pct = (n: number, d: number) => (d > 0 ? n / d : 0)
const OUTCOME_LABEL: Record<string, string> = { completed: 'Completed', missed: 'Missed', resolved: 'Resolved', no_answer: 'No Answer', voicemail: 'Voicemail' }
const OUTCOME_COLOR: Record<string, string> = { completed: GREEN, resolved: GREEN, missed: RED, no_answer: AMBER, voicemail: PURPLE }
const outcomeLabel = (o: string) => OUTCOME_LABEL[o] ?? (o ? o.replace(/_/g, ' ') : 'Unknown')

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0E2841', borderRadius: RADIUS.lg, padding: '9px 13px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label != null && <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.5)', fontFamily: INTER, marginBottom: 5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: i > 0 ? 3 : 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? p.payload?.fill }} />
          <span style={{ fontSize: TEXT.sm, color: '#fff', fontWeight: FW.bold, ...NUM }}>{fmtNum(p.value)}</span>
          <span style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.5)' }}>{p.name}</span>
        </div>
      ))}
    </div>
  )
}

function Ago({ since }: { since: Date | null }) {
  const [, tick] = useState(0)
  useEffect(() => { const id = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(id) }, [])
  if (!since) return null
  const s = Math.floor((Date.now() - since.getTime()) / 1000)
  return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>updated {s < 2 ? 'just now' : `${s}s ago`}</span>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Supervisor() {
  const [sup, setSup]     = useState<SupervisorData | null>(null)
  const [cs, setCs]       = useState<CallStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]     = useState<string | null>(null)
  const [refreshed, setRefreshed] = useState<Date | null>(null)
  const [target, setTarget] = useState(60)
  const [editingTarget, setEditingTarget] = useState(false)
  const [targetInput, setTargetInput] = useState('60')
  const [view, setView] = useState<'live' | 'perf' | 'qa'>('live')
  const [distributing, setDistributing] = useState(false)
  const [agentMatchOpen, setAgentMatchOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    try {
      const t = today()
      const [s, c, cfg] = await Promise.all([
        apiFetch<any>('/api/helpdesk/supervisor'),
        apiFetch<any>(`/api/helpdesk/calls/stats?date_from=${t}&date_to=${t}`),
        apiFetch<any>('/api/helpdesk/cc-settings').catch(() => null),
      ])
      setSup((s?.data ?? s) as SupervisorData)
      setCs((c?.data ?? c) as CallStats)
      const tg = (cfg?.data ?? cfg)?.daily_call_target
      if (tg) { setTarget(tg); setTargetInput(String(tg)) }
      setRefreshed(new Date())
    } catch (e: any) { setErr(e.message) }
    finally { if (!silent) setLoading(false) }
  }, [])

  async function saveTarget() {
    const n = Number(targetInput)
    if (!n || n <= 0) { toast.error('Enter a valid target'); return }
    try {
      await apiFetch('/api/helpdesk/cc-settings', { method: 'PUT', body: JSON.stringify({ daily_call_target: n }) })
      setTarget(n); setEditingTarget(false); toast.success('Daily target updated')
    } catch (e: any) { toast.error(e.message) }
  }

  // Load-balance the unowned open backlog across active agents (least-loaded first).
  async function distribute() {
    const n = sup?.totals.unassigned ?? 0
    if (!n) { toast.info('No unassigned tickets to distribute'); return }
    if (!window.confirm(`Distribute ${n} unassigned ticket${n === 1 ? '' : 's'} across active agents (load-balanced)?`)) return
    setDistributing(true)
    try {
      const r = await apiFetch<any>('/api/helpdesk/tickets/distribute', { method: 'POST', body: JSON.stringify({}) })
      const d = r?.data ?? r
      const assigned = d?.assigned ?? 0
      const agents = Object.keys(d?.per_agent ?? {}).length
      toast.success(`Assigned ${fmtNum(assigned)} ticket${assigned === 1 ? '' : 's'} across ${agents} agent${agents === 1 ? '' : 's'}`)
      load(true)
    } catch (e: any) { toast.error(e.message) }
    finally { setDistributing(false) }
  }

  useEffect(() => {
    load()
    timer.current = setInterval(() => load(true), 10_000) // live wallboard
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  async function setStatus(id: number, status: string) {
    if (!status) return
    try {
      await apiFetch(`/api/helpdesk/agents/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })
      setSup(prev => prev ? { ...prev, agents: prev.agents.map(a => a.id === id ? { ...a, helpdesk_status: status } : a) } : prev)
      toast.success('Status updated')
    } catch (e: any) { toast.error(e.message) }
  }

  const viewTabs = (
    <div style={{ display: 'inline-flex', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 3 }}>
      {([['live', 'Team Live'], ['perf', 'Performance'], ['qa', 'Quality (QA)']] as const).map(([v, l]) => {
        const on = view === v
        return (
          <button key={v} onClick={() => setView(v)} style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, padding: '5px 14px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: on ? 'var(--card)' : 'transparent', color: on ? NAVY : 'var(--txt2)', boxShadow: on ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}>{l}</button>
        )
      })}
    </div>
  )

  if (view === 'perf') return (
    <Page title="Supervisor" subtitle="Call-Centre performance analytics" actions={viewTabs}>
      <PerformancePanel />
    </Page>
  )

  if (view === 'qa') return (
    <Page title="Supervisor" subtitle="Call-Centre quality assurance" actions={viewTabs}>
      <QAHub />
    </Page>
  )

  if (loading && !sup) return <Page title="Supervisor" actions={viewTabs}><div style={{ display: 'flex', justifyContent: 'center', padding: 70 }}><Spinner size={30} /></div></Page>
  if (err && !sup) return <Page title="Supervisor" actions={viewTabs}><ErrBanner error={err} onRetry={() => load()} /></Page>

  const agents = sup?.agents ?? []
  const online = agents.filter(a => !isOffline(a.helpdesk_status)).length
  const calls = cs?.summary?.total ?? 0
  const connected = cs?.summary?.connected ?? 0
  const missed = cs?.summary?.missed ?? 0
  const connRate = pct(connected, calls)

  const hourData = Array.from({ length: 24 }, (_, h) => {
    const f = cs?.by_hour?.find(x => x.hour === h)
    return { label: String(h).padStart(2, '0'), inbound: f?.inbound ?? 0, outbound: f?.outbound ?? 0 }
  })
  const outcomes = cs?.by_outcome ?? []
  const donutTotal = outcomes.reduce((s, o) => s + o.count, 0)
  const sorted = [...agents].sort((a, b) => b.calls_today - a.calls_today || b.open_tickets - a.open_tickets)

  const Th = ({ children, right }: { children: string; right?: boolean }) => (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textAlign: right ? 'right' : 'left' }}>{children}</span>
  )
  const GRID = '1.5fr 132px 60px 62px 58px 74px 56px 56px 58px'

  return (
    <Page
      title="Supervisor"
      subtitle="Live team monitoring — refreshes every 10s"
      actions={
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          {viewTabs}
          {editingTarget ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.semibold }}>Daily target</span>
              <input type="number" min={1} value={targetInput} onChange={e => setTargetInput(e.target.value)} autoFocus
                onKeyDown={e => { if (e.key === 'Enter') saveTarget(); if (e.key === 'Escape') setEditingTarget(false) }}
                style={{ width: 60, height: 30, padding: '0 8px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.sm, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)' }} />
              <button onClick={saveTarget} style={{ padding: '5px 10px', borderRadius: RADIUS.sm, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Save</button>
              <button onClick={() => { setEditingTarget(false); setTargetInput(String(target)) }} style={{ padding: '5px 8px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer' }}>✕</button>
            </span>
          ) : (
            <button onClick={() => setEditingTarget(true)} title="Set the agents' daily call goal"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: RADIUS['2xl'], border: '1px solid var(--card-bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>flag</span>Goal: {target}/day
            </button>
          )}
          <button onClick={() => setAgentMatchOpen(true)} title="Reconcile Zoho agents to workspace users"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: RADIUS['2xl'], border: '1px solid var(--card-bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>link</span>Agent Matching
          </button>
          {(sup?.totals.unassigned ?? 0) > 0 && (
            <button onClick={distribute} disabled={distributing} title="Load-balance unowned open tickets across active agents"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: RADIUS['2xl'], border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: distributing ? 'wait' : 'pointer', opacity: distributing ? .7 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{distributing ? 'hourglass_empty' : 'shuffle'}</span>
              {distributing ? 'Distributing…' : `Distribute ${fmtNum(sup?.totals.unassigned ?? 0)}`}
            </button>
          )}
          <Ago since={refreshed} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: `${RED}14`, color: RED, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '4px 11px', borderRadius: RADIUS['2xl'] }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: RED, animation: 'svpulse 1.6s infinite' }} /> LIVE
          </span>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={() => load()} />

      {/* Team KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Calls Today"   value={fmtNum(calls)}       icon="call"        accent={NAVY} />
        <KpiCard label="Connect Rate"  value={fmtPct(connRate)}    icon="call_made"   accent={connRate >= 0.4 ? GREEN : connRate >= 0.2 ? AMBER : RED} />
        <KpiCard label="Missed"        value={fmtNum(missed)}      icon="call_missed" accent={missed > connected ? RED : AMBER} />
        <KpiCard label="Agents Online" value={`${online}/${agents.length}`} icon="group" accent={GREEN} />
        <KpiCard label="Queue Depth"   value={fmtNum(sup?.totals.open ?? 0)}  icon="inbox" accent={BLUE} sub={`${fmtNum(sup?.totals.unassigned ?? 0)} unassigned`} />
        <KpiCard label="SLA Breaches"  value={fmtNum(sup?.totals.sla_breached ?? 0)} icon="alarm" accent={(sup?.totals.sla_breached ?? 0) > 0 ? RED : GREEN} />
      </div>

      {/* Agent wallboard */}
      <SectionCard title="Agent Wallboard" subtitle={`${agents.length} agents · today's live activity`} style={{ marginBottom: SP[4] }}>
        {agents.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No active agents</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: SP[2], padding: '6px 10px', background: 'var(--th-bg)', borderRadius: RADIUS.md, marginBottom: SP[1], minWidth: 780 }}>
              <Th>Agent</Th><Th>Status</Th><Th right>Calls</Th><Th right>Conn.</Th><Th right>Conn %</Th><Th right>Avg Talk</Th><Th right>Open</Th><Th right>SLA</Th><Th right>QA</Th>
            </div>
            {sorted.map((a, i) => {
              const cfg = statusCfg(a.helpdesk_status)
              const cr = pct(a.connected_today, a.calls_today)
              const idle = !isOffline(a.helpdesk_status) && a.calls_today === 0 && a.open_tickets === 0
              const initials = a.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
              return (
                <div key={a.id || i} style={{ display: 'grid', gridTemplateColumns: GRID, gap: SP[2], padding: '9px 10px', alignItems: 'center', borderBottom: i < sorted.length - 1 ? '1px solid var(--bdr)' : 'none', minWidth: 780, background: a.sla_breached > 0 ? `${RED}08` : 'transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY }}>{initials}</div>
                      <span style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: '50%', background: cfg.color, border: '2px solid var(--card)' }} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.full_name}</div>
                      {idle && <span style={{ fontSize: TEXT['2xs'], color: AMBER, fontWeight: FW.semibold }}>idle · no activity yet</span>}
                    </div>
                  </div>
                  <select value={a.helpdesk_status?.toLowerCase() ?? 'available'} onChange={e => setStatus(a.id, e.target.value)}
                    style={{ height: 28, padding: '0 6px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.sm, fontSize: TEXT.xs, background: 'var(--input-bg)', color: cfg.color, fontWeight: FW.semibold, outline: 'none' }}>
                    <option value="available">Available</option>
                    <option value="on_call">On Call</option>
                    <option value="break">Break</option>
                    <option value="offline">Offline</option>
                  </select>
                  <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(a.calls_today)}</span>
                  <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtNum(a.connected_today)}</span>
                  <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: a.calls_today === 0 ? 'var(--txt3)' : cr >= 0.3 ? GREEN : cr >= 0.15 ? AMBER : RED }}>{a.calls_today ? fmtPct(cr) : '—'}</span>
                  <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDur(a.avg_talk_sec)}</span>
                  <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: a.open_tickets > 10 ? AMBER : 'var(--txt2)' }}>{fmtNum(a.open_tickets)}</span>
                  <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.bold, color: a.sla_breached > 0 ? RED : 'var(--txt3)' }}>{fmtNum(a.sla_breached)}</span>
                  <span title={a.qa_evals ? `${a.qa_evals} QA evaluation${a.qa_evals !== 1 ? 's' : ''}` : 'No QA evaluations yet'}
                    style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.bold, color: a.qa_evals ? (BAND_COLOR[qaBand(Number(a.qa_avg_score))] ?? NAVY) : 'var(--txt3)' }}>
                    {a.qa_evals ? `${Number(a.qa_avg_score)}%` : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>

      {/* Live volume + outcomes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.7fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Today's Call Volume" subtitle="Inbound & outbound by hour">
          {calls === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls yet today</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hourData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }} barCategoryGap="20%">
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="label" interval={0} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'var(--row-hvr)' }} content={(p: any) => <Tip {...p} label={p?.label != null ? `${p.label}:00` : ''} />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs, fontFamily: INTER }} />
                <Bar dataKey="inbound"  stackId="h" name="Inbound"  fill={BLUE} maxBarSize={24} />
                <Bar dataKey="outbound" stackId="h" name="Outbound" fill={NAVY} radius={[3, 3, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        <SectionCard title="Call Outcomes" subtitle="Today">
          {outcomes.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP[3] }}>
              <div style={{ position: 'relative' }}>
                <PieChart width={150} height={150}>
                  <Pie data={outcomes} cx={72} cy={72} innerRadius={46} outerRadius={70} dataKey="count" nameKey="outcome" stroke="none" paddingAngle={2} startAngle={90} endAngle={-270}>
                    {outcomes.map((o, i) => <Cell key={i} fill={OUTCOME_COLOR[o.outcome] ?? NAVY} />)}
                  </Pie>
                  <Tooltip content={(p: any) => <Tip {...p} />} />
                </PieChart>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                  <div style={{ fontSize: TEXT.xl, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, lineHeight: 1 }}>{fmtNum(donutTotal)}</div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: INTER }}>calls</div>
                </div>
              </div>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: SP[1] }}>
                {outcomes.map(o => (
                  <div key={o.outcome} style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: OUTCOME_COLOR[o.outcome] ?? NAVY }} />
                    <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt)' }}>{outcomeLabel(o.outcome)}</span>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt)', ...NUM }}>{fmtNum(o.count)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* SLA breach feed */}
      <SectionCard title="SLA Breach Feed" badge={sup?.recent_breaches?.length ?? 0} subtitle="Open tickets past their SLA deadline">
        {!sup?.recent_breaches?.length ? (
          <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--txt2)' }}>No SLA breaches — queue is healthy ✅</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {sup.recent_breaches.map((b, i) => (
              <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 2px', borderBottom: i < sup.recent_breaches.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>alarm</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.subject || '(no subject)'}</div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{b.ticket_ref} · {b.assigned_to_name || 'Unassigned'}</div>
                </div>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: RED }}>Breached</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <style>{`@keyframes svpulse { 0% { box-shadow: 0 0 0 0 rgba(192,0,0,.5) } 70% { box-shadow: 0 0 0 6px rgba(192,0,0,0) } 100% { box-shadow: 0 0 0 0 rgba(192,0,0,0) } }`}</style>

      <Modal open={agentMatchOpen} onClose={() => setAgentMatchOpen(false)} title="Agent Matching" width={780} maxHeight="82vh">
        <AgentMatchingPanel />
      </Modal>
    </Page>
  )
}
