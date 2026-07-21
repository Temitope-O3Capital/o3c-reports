import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, Spinner, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum, monthStart, today } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, BLUE, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SupervisorData {
  totals: { open: number; sla_breached: number; unassigned: number; active_agents: number }
  agents: AgentRow[]
  queues: QueueRow[]
  recent_breaches: BreachRow[]
  by_type?: TypePoint[]
  hourly_queue?: HourlyPoint[]
}

interface AgentRow {
  id: number
  full_name: string
  open_tickets: number
  sla_breached: number
  last_reply?: string
  current_ticket_ref?: string
  helpdesk_status?: string
}

interface TypePoint    { ticket_type: string; count: number }
interface HourlyPoint  { hour: string; count: number }
interface QueueRow     { queue: string; open: number; sla_breached: number; unassigned: number }
interface BreachRow    { id: number; ticket_ref: string; subject: string; priority: string; sla_due_at: string; assigned_to_name?: string }

interface StatsData {
  open: number
  sla_breached: number
  avg_first_response_hours: number
  avg_csat: number
  agents?: AgentStat[]
}

interface AgentStat {
  agent_name: string
  open_tickets: number
  resolved_today: number
  avg_csat: number | null
  avg_handle_time_min?: number | null
  escalations?: number | null
}

// ── Status pill ───────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  available: { label: 'Available', color: GREEN,   bg: `${GREEN}18` },
  on_call:   { label: 'On Call',   color: BLUE,    bg: `${BLUE}18` },
  break:     { label: 'Break',     color: AMBER,   bg: `${AMBER}18` },
  offline:   { label: 'Offline',   color: 'var(--chart-lbl)', bg: '#F3F4F6' },
  busy:      { label: 'Busy',      color: AMBER,   bg: `${AMBER}18` },
}

function statusCfg(s?: string) {
  return STATUS_CONFIG[s?.toLowerCase() ?? ''] ?? { label: s ?? 'Unknown', color: 'var(--chart-lbl)', bg: '#F3F4F6' }
}

// ── Agent status card ─────────────────────────────────────────────────────────

function AgentCard({ agent, onStatusChange }: { agent: AgentRow; onStatusChange: (id: number, status: string) => void }) {
  const derived = agent.sla_breached > 0 ? 'busy' : agent.open_tickets > 0 ? 'busy' : 'available'
  const cfg = agent.helpdesk_status ? statusCfg(agent.helpdesk_status) : statusCfg(derived)
  const initials = agent.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
          background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: TEXT.base, fontWeight: FW.bold, color: NAVY,
        }}>
          {initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {agent.full_name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: cfg.color, display: 'inline-block' }} />
            <span style={{ fontSize: TEXT.xs, color: cfg.color, fontWeight: FW.semibold }}>{cfg.label}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: SP[3] }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: agent.open_tickets > 0 ? AMBER : 'var(--txt)', fontFamily: 'Inter, sans-serif' }}>
            {agent.open_tickets}
          </div>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontWeight: FW.medium }}>Open</div>
        </div>
        {agent.sla_breached > 0 && (
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: RED, fontFamily: 'Inter, sans-serif' }}>{agent.sla_breached}</div>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontWeight: FW.medium }}>Breached</div>
          </div>
        )}
      </div>

      {/* Supervisor-controlled status override */}
      <select
        value={agent.helpdesk_status ?? ''}
        onChange={e => onStatusChange(agent.id, e.target.value)}
        style={{
          width: '100%', height: 30, padding: '0 8px', border: '1px solid var(--input-bdr)',
          borderRadius: RADIUS.sm, fontSize: TEXT.xs, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none',
        }}
      >
        <option value="">— Set status —</option>
        <option value="available">Available</option>
        <option value="on_call">On Call</option>
        <option value="break">Break</option>
        <option value="offline">Offline</option>
      </select>

      {(agent.current_ticket_ref || agent.last_reply) && (
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', borderTop: '1px solid var(--bdr)', paddingTop: SP[2], display: 'flex', flexDirection: 'column', gap: 3 }}>
          {agent.current_ticket_ref && (
            <span>Active: <span style={{ fontWeight: FW.semibold, color: BLUE }}>#{agent.current_ticket_ref}</span></span>
          )}
          {agent.last_reply && <span>Last reply: {fmtDatetime(agent.last_reply)}</span>}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Supervisor() {
  const [supervisor, setSupervisor] = useState<SupervisorData | null>(null)
  const [stats, setStats]           = useState<StatsData | null>(null)
  const [loading, setLoading]       = useState(true)
  const [err, setErr]               = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    const qs = `?from=${dateFrom}&to=${dateTo}`
    try {
      const [sup, st] = await Promise.all([
        apiFetch<SupervisorData>(`/api/helpdesk/supervisor${qs}`),
        apiFetch<StatsData>(`/api/helpdesk/stats${qs}`),
      ])
      setSupervisor(sup)
      setStats(st)
      setLastRefresh(new Date())
    } catch (e: any) {
      setErr(e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => {
    load()
    // Auto-refresh every 10 seconds
    intervalRef.current = setInterval(() => load(true), 10_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [load])

  async function handleStatusChange(agentId: number, status: string) {
    if (!status) return
    try {
      await apiFetch(`/api/helpdesk/agents/${agentId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      })
      // Optimistic update
      setSupervisor(prev => {
        if (!prev) return prev
        return {
          ...prev,
          agents: prev.agents.map(a => a.id === agentId ? { ...a, helpdesk_status: status } : a),
        }
      })
      toast.success('Agent status updated')
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  // ── Agent performance table columns ─────────────────────────────────────────
  const agentPerfCols: TableCol<AgentStat>[] = [
    { key: 'agent_name', label: 'Agent' },
    {
      key: 'open_tickets', label: 'Open', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: r.open_tickets > 0 ? AMBER : 'var(--txt)' }}>{r.open_tickets}</span>,
    },
    {
      key: 'resolved_today', label: 'Resolved Today', align: 'right',
      render: r => <span style={NUM}>{r.resolved_today}</span>,
    },
    {
      key: 'avg_handle_time_min', label: 'Avg Handle (min)', align: 'right',
      render: r => r.avg_handle_time_min != null
        ? <span style={NUM}>{fmtNum(r.avg_handle_time_min)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'escalations', label: 'Escalations', align: 'right',
      render: r => r.escalations != null
        ? <span style={{ ...NUM, color: r.escalations > 0 ? RED : 'var(--txt)' }}>{r.escalations}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'avg_csat', label: 'Avg CSAT', align: 'right',
      render: r => r.avg_csat !== null && r.avg_csat !== undefined ? (
        <span style={{ ...NUM, color: Number(r.avg_csat) >= 4 ? GREEN : Number(r.avg_csat) >= 3 ? AMBER : RED, fontWeight: FW.semibold }}>
          {Number(r.avg_csat).toFixed(1)} / 5
        </span>
      ) : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
  ]

  // ── SLA breach feed columns ──────────────────────────────────────────────────
  const breachCols: TableCol<BreachRow>[] = [
    {
      key: 'ticket_ref', label: 'Ticket',
      render: r => (
        <Link to={`/helpdesk/${r.id}`} style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: BLUE, textDecoration: 'none', fontFamily: 'Inter, monospace' }}>
          #{r.ticket_ref}
        </Link>
      ),
    },
    {
      key: 'subject', label: 'Subject',
      render: r => (
        <span style={{ fontSize: TEXT.base, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240, display: 'block' }}>
          {r.subject}
        </span>
      ),
    },
    {
      key: 'priority', label: 'Priority',
      render: r => {
        const color = r.priority === 'urgent' ? RED : r.priority === 'high' ? AMBER : 'var(--txt2)'
        return <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color }}>{r.priority}</span>
      },
    },
    {
      key: 'sla_due_at', label: 'Overdue By',
      render: r => {
        const mins = Math.round((Date.now() - new Date(r.sla_due_at).getTime()) / 60_000)
        const hrs = Math.floor(mins / 60)
        return <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: RED }}>{hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`}</span>
      },
    },
    {
      key: 'assigned_to_name', label: 'Agent',
      render: r => <span style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>{r.assigned_to_name ?? 'Unassigned'}</span>,
    },
  ]

  const supervisorAgents = supervisor?.agents ?? []
  const recentBreaches   = supervisor?.recent_breaches ?? []
  const statsAgents: AgentStat[] = stats?.agents ?? []

  if (loading) {
    return (
      <Page title="Supervisor Dashboard" subtitle="Live agent and queue health">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spinner size={32} />
        </div>
      </Page>
    )
  }

  return (
    <Page
      title="Supervisor Dashboard"
      subtitle="Live agent and queue health"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          {lastRefresh && (
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
              Updated {lastRefresh.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={() => load()}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 13px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>refresh</span>
            Refresh
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={() => load()} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Queue Depth"          value={supervisor?.totals.open ?? stats?.open ?? 0}                                     icon="inbox"    accent={NAVY} />
        <KpiCard label="SLA Breached Today"   value={supervisor?.totals.sla_breached ?? stats?.sla_breached ?? 0}                     icon="alarm"    accent={RED} />
        <KpiCard label="Avg First Response"   value={stats ? `${(stats.avg_first_response_hours * 60).toFixed(0)} min` : '—'}         icon="schedule" accent={AMBER} />
        <KpiCard label="CSAT Today"           value={stats?.avg_csat ? `${stats.avg_csat.toFixed(1)} / 5` : '—'}                     icon="star"     accent={GREEN} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
        {/* Agent status grid */}
        <SectionCard title="Agent Status" badge={supervisorAgents.length} subtitle="Live workload · supervisor can override status">
          {supervisorAgents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>No active agents found.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: SP[3] }}>
              {supervisorAgents.map(a => (
                <AgentCard key={a.id} agent={a} onStatusChange={handleStatusChange} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* SLA breach feed */}
        <SectionCard title="SLA Breach Feed" badge={recentBreaches.length} subtitle="Open tickets past their SLA deadline" padding={false}>
          {recentBreaches.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: SP[2] }}>
              <span className="material-symbols-rounded" style={{ fontSize: 36, color: GREEN }}>check_circle</span>
              <span style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>No SLA breaches — great work!</span>
            </div>
          ) : (
            <div style={{ padding: '4px 0' }}>
              {recentBreaches.map(b => (
                <div key={b.id} style={{ display: 'flex', alignItems: 'flex-start', gap: SP[3], padding: '10px 18px', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ width: 4, height: 36, borderRadius: RADIUS.xs, background: RED, flexShrink: 0, marginTop: 3 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                      <Link to={`/helpdesk/${b.id}`} style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: BLUE, textDecoration: 'none', fontFamily: 'Inter, monospace' }}>
                        #{b.ticket_ref}
                      </Link>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: RED }}>
                        {(() => {
                          const mins = Math.round((Date.now() - new Date(b.sla_due_at).getTime()) / 60_000)
                          const hrs = Math.floor(mins / 60)
                          return hrs > 0 ? `${hrs}h ${mins % 60}m overdue` : `${mins}m overdue`
                        })()}
                      </span>
                    </div>
                    <div style={{ fontSize: TEXT.base, color: 'var(--txt)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {b.subject}
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>{b.assigned_to_name ?? 'Unassigned'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Agent performance table */}
      <SectionCard title="Agent Performance Today" padding={false}>
        <DataTable<AgentStat>
          cols={agentPerfCols}
          rows={statsAgents}
          keyFn={r => r.agent_name}
          emptyText="No agent performance data available."
          skeletonRows={4}
          searchKeys={['agent_name']}
          searchPlaceholder="Search agent…"
        />
      </SectionCard>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginTop: SP[4] }}>
        <SectionCard title="Tickets by Type" subtitle="Today's volume by category">
          {(supervisor?.by_type ?? []).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>No data yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={supervisor!.by_type} margin={{ top: 4, right: 8, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="ticket_type" tick={{ fontSize: TEXT.xs, fill: 'var(--txt2)' }} interval={0} textAnchor="middle" />
                <YAxis tick={{ fontSize: TEXT.xs, fill: 'var(--txt2)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Bar dataKey="count" fill={NAVY} radius={[4, 4, 0, 0]} name="Tickets" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        <SectionCard title="Queue Depth (Last 8h)" subtitle="Open tickets per hour">
          {(supervisor?.hourly_queue ?? []).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>No data yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={supervisor!.hourly_queue} margin={{ top: 4, right: 8, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="hour" tick={{ fontSize: TEXT.xs, fill: 'var(--txt2)' }} interval={0} textAnchor="middle" />
                <YAxis tick={{ fontSize: TEXT.xs, fill: 'var(--txt2)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Line type="monotone" dataKey="count" stroke={RED} strokeWidth={2} dot={{ r: 3 }} name="Open" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>

      {/* Queue breakdown */}
      {(supervisor?.queues ?? []).length > 0 && (
        <SectionCard title="Queue Breakdown" padding={false} style={{ marginTop: SP[4] }}>
          <DataTable<QueueRow>
            cols={[
              { key: 'queue', label: 'Queue' },
              {
                key: 'open', label: 'Open', align: 'right',
                render: r => <span style={{ fontFamily: 'Inter, sans-serif', fontWeight: FW.semibold }}>{r.open}</span>,
              },
              {
                key: 'sla_breached', label: 'Breached', align: 'right',
                render: r => <span style={{ fontFamily: 'Inter, sans-serif', fontWeight: FW.semibold, color: r.sla_breached > 0 ? RED : 'var(--txt)' }}>{r.sla_breached}</span>,
              },
              {
                key: 'unassigned', label: 'Unassigned', align: 'right',
                render: r => <span style={{ fontFamily: 'Inter, sans-serif', color: r.unassigned > 0 ? AMBER : 'var(--txt)' }}>{r.unassigned}</span>,
              },
            ]}
            rows={supervisor?.queues ?? []}
            keyFn={r => r.queue}
            emptyText="No queue data."
          />
        </SectionCard>
      )}
    </Page>
  )
}
