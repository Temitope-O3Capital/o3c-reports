import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { today, monthStart } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, BLUE, PURPLE, INTER, NUM } from '../../lib/design'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CsatPoint     { date: string; csat_score: number; ticket_count: number }
interface HandlePoint   { ticket_type: string; avg_minutes: number }
interface ResolutionPoint { agent_name: string; resolution_pct: number }
interface TypeDistPoint { ticket_type: string; count: number }
interface Agent         { id: number; full_name: string }

interface LeaderRow {
  agent_name: string
  tickets_handled: number
  tickets_resolved: number
  avg_csat: number | null
  avg_handle_min: number | null
  sla_breaches: number
}

interface SLAByAgentRow {
  agent_name: string
  total: number
  breached: number
  breach_pct: number
}

interface BusyHourRow { hour: number; ticket_count: number }
interface ChannelRow  { channel: string; count: number }

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function Tip({ active, payload, label, fmt }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  fmt?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const f = fmt ?? (v => String(v))
  return (
    <div style={{ background: '#0E2841', borderRadius: 10, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && (
        <div style={{ fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          {label}
        </div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: INTER, ...NUM }}>{f(p.value)}</span>
          {p.name && payload.length > 1 && (
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{p.name}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function DonutCenter({ total }: { total: number }) {
  return (
    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--txt)', ...NUM, lineHeight: 1 }}>{total}</div>
      <div style={{ fontSize: 9, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>tickets</div>
    </div>
  )
}

const DONUT_COLORS = [NAVY, BLUE, AMBER, GREEN, RED, PURPLE]
const HOURS_24 = Array.from({ length: 24 }, (_, i) => i)

// ── Main component ─────────────────────────────────────────────────────────────

export default function HelpdeskStats() {
  const [dateFrom, setDateFrom]       = useState(monthStart())
  const [dateTo, setDateTo]           = useState(today())
  const [agentFilter, setAgentFilter] = useState('')
  const [agents, setAgents]           = useState<Agent[]>([])

  const [csatTrend, setCsatTrend]     = useState<CsatPoint[]>([])
  const [handleTime, setHandleTime]   = useState<HandlePoint[]>([])
  const [resolution, setResolution]   = useState<ResolutionPoint[]>([])
  const [typeDist, setTypeDist]       = useState<TypeDistPoint[]>([])
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([])
  const [slaByAgent, setSlaByAgent]   = useState<SLAByAgentRow[]>([])
  const [busyHours, setBusyHours]     = useState<BusyHourRow[]>([])
  const [channels, setChannels]       = useState<ChannelRow[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    apiFetch<Agent[] | { data: Agent[] }>('/api/helpdesk/agents')
      .then(r => setAgents(Array.isArray(r) ? r : (r as any).data ?? []))
      .catch(() => setAgents([]))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
      if (agentFilter) qs.set('agent', agentFilter)
      const s = qs.toString()

      const dateQs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }).toString()

      const [ct, ht, res, td, lb, sla, bh, ch] = await Promise.all([
        apiFetch<{ data: CsatPoint[] }>(`/api/helpdesk/csat-trend?${s}`),
        apiFetch<{ data: HandlePoint[] }>(`/api/helpdesk/handle-time-by-type?${s}`),
        apiFetch<{ data: ResolutionPoint[] }>(`/api/helpdesk/resolution-by-agent?${dateQs}`),
        apiFetch<{ data: TypeDistPoint[] }>(`/api/helpdesk/type-distribution?${s}`),
        apiFetch<{ data: LeaderRow[] }>(`/api/helpdesk/stats/leaderboard?${dateQs}`),
        apiFetch<{ data: SLAByAgentRow[] }>(`/api/helpdesk/stats/sla-by-agent?${dateQs}`),
        apiFetch<{ data: BusyHourRow[] }>(`/api/helpdesk/stats/busiest-hours?${s}`),
        apiFetch<{ data: ChannelRow[] }>(`/api/helpdesk/stats/channel-breakdown?${s}`),
      ])
      setCsatTrend(ct.data ?? [])
      setHandleTime(ht.data ?? [])
      setResolution(res.data ?? [])
      setTypeDist(td.data ?? [])
      setLeaderboard(lb.data ?? [])
      setSlaByAgent(sla.data ?? [])
      setBusyHours(bh.data ?? [])
      setChannels(ch.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, agentFilter])

  useEffect(() => { load() }, [load])

  const donutTotal = typeDist.reduce((s, d) => s + d.count, 0)

  // Normalise busyHours into a full 0-23 array for the heatmap
  const hourMap = Object.fromEntries(busyHours.map(r => [r.hour, r.ticket_count]))
  const heatmapData = HOURS_24.map(h => ({ hour: `${String(h).padStart(2, '0')}:00`, ticket_count: hourMap[h] ?? 0 }))
  const maxCount = Math.max(...heatmapData.map(d => d.ticket_count), 1)

  const EmptyState = ({ msg }: { msg: string }) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '30px 0', gap: 6 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 32, color: 'var(--txt3)' }}>bar_chart</span>
      <span style={{ fontSize: 13, color: 'var(--txt2)' }}>{msg}</span>
    </div>
  )

  return (
    <Page title="Customer Support Stats" subtitle="CSAT, handle time and resolution metrics">
      {/* Page-level filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}
          style={{ height: 32, borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, padding: '0 10px', cursor: 'pointer' }}>
          <option value="">All agents</option>
          {agents.map(a => <option key={a.id} value={String(a.id)}>{a.full_name}</option>)}
        </select>
      </div>

      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spinner size={32} />
        </div>
      ) : (
        <>
          {/* ── Row 1: CSAT trend + Handle time ──────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <SectionCard title="CSAT Trend" subtitle="Daily satisfaction score (0–5)">
              {csatTrend.length === 0 ? <EmptyState msg="No CSAT data yet" /> : (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={csatTrend} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 5]} tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => v.toFixed(1)} />} />
                    <Line type="monotone" dataKey="csat_score" stroke={GREEN} strokeWidth={2.2} name="CSAT" dot={{ r: 3, fill: GREEN, strokeWidth: 0 }} activeDot={{ r: 5, fill: GREEN, stroke: '#fff', strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="Avg Handle Time" subtitle="Minutes per ticket type">
              {handleTime.length === 0 ? <EmptyState msg="No handle time data yet" /> : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={handleTime} margin={{ top: 4, right: 8, bottom: 0, left: -18 }} barCategoryGap="30%">
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
                    <XAxis dataKey="ticket_type" tick={{ fontSize: 9, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v.toFixed(0)} min`} />} />
                    <Bar dataKey="avg_minutes" fill={NAVY} radius={[5, 5, 0, 0]} name="Avg minutes" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionCard>
          </div>

          {/* ── Row 2: Resolution rate + Type distribution ─────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <SectionCard title="Resolution Rate by Agent" subtitle="% of tickets resolved">
              {resolution.length === 0 ? <EmptyState msg="No resolution data yet" /> : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={resolution} margin={{ top: 4, right: 8, bottom: 0, left: -18 }} barCategoryGap="30%">
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
                    <XAxis dataKey="agent_name" tick={{ fontSize: 9, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v.toFixed(0)}%`} />} />
                    <Bar dataKey="resolution_pct" radius={[5, 5, 0, 0]} name="Resolution %">
                      {resolution.map((e, i) => (
                        <Cell key={i} fill={e.resolution_pct >= 80 ? GREEN : e.resolution_pct >= 60 ? AMBER : RED} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="Ticket Type Distribution" subtitle="Count by category">
              {typeDist.length === 0 ? <EmptyState msg="No tickets yet" /> : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <PieChart width={148} height={148}>
                      <Pie data={typeDist} cx={70} cy={70} innerRadius={42} outerRadius={66} dataKey="count" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                        {typeDist.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                      </Pie>
                      <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v} tickets`} />} />
                    </PieChart>
                    <DonutCenter total={donutTotal} />
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {typeDist.map((d, i) => (
                      <div key={d.ticket_type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 10, height: 10, borderRadius: 3, background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: 12, color: 'var(--txt)', fontWeight: 500 }}>{d.ticket_type}</span>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--txt)', ...NUM }}>{d.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>
          </div>

          {/* ── Row 3: Channel breakdown + SLA by agent ─────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <SectionCard title="Channel Breakdown" subtitle="Tickets by source channel">
              {channels.length === 0 ? <EmptyState msg="No channel data yet" /> : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={channels} margin={{ top: 4, right: 8, bottom: 0, left: -18 }} barCategoryGap="30%">
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
                    <XAxis dataKey="channel" tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v} tickets`} />} />
                    <Bar dataKey="count" fill={BLUE} radius={[5, 5, 0, 0]} name="Tickets" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="SLA Breach Rate by Agent" subtitle="% of tickets that breached SLA">
              {slaByAgent.length === 0 ? <EmptyState msg="No SLA data yet" /> : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={slaByAgent} margin={{ top: 4, right: 8, bottom: 0, left: -18 }} barCategoryGap="30%">
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
                    <XAxis dataKey="agent_name" tick={{ fontSize: 9, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v}%`} />} />
                    <Bar dataKey="breach_pct" radius={[5, 5, 0, 0]} name="Breach %">
                      {slaByAgent.map((e, i) => (
                        <Cell key={i} fill={e.breach_pct > 20 ? RED : e.breach_pct > 10 ? AMBER : GREEN} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionCard>
          </div>

          {/* ── Row 4: Busiest hours heatmap ─────────────────────────────── */}
          <SectionCard title="Busiest Hours" subtitle="Ticket volume by hour of day (WAT)" style={{ marginBottom: 16 }}>
            {heatmapData.every(d => d.ticket_count === 0) ? <EmptyState msg="No hourly data yet" /> : (
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', padding: '8px 0' }}>
                {heatmapData.map(d => {
                  const pct = d.ticket_count / maxCount
                  const color = pct > 0.7 ? RED : pct > 0.4 ? AMBER : pct > 0 ? BLUE : 'var(--bdr)'
                  return (
                    <div key={d.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }} title={`${d.hour}: ${d.ticket_count} tickets`}>
                      <div style={{ fontSize: 10, color: 'var(--txt2)', fontFamily: INTER }}>{d.ticket_count || ''}</div>
                      <div style={{ width: '100%', borderRadius: 4, background: color, height: Math.max(4, pct * 80), transition: 'height 300ms' }} />
                      <div style={{ fontSize: 9, color: 'var(--txt3)', fontFamily: INTER, writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                        {d.hour.slice(0, 5)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>

          {/* ── Row 5: Leaderboard ───────────────────────────────────────── */}
          <SectionCard title="Agent Leaderboard" subtitle="Top agents by tickets resolved this period">
            {leaderboard.length === 0 ? <EmptyState msg="No leaderboard data yet" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {/* Header */}
                <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr 80px 80px 80px 80px 80px', gap: 8, padding: '6px 12px', background: 'var(--th-bg)', borderRadius: 8, marginBottom: 4 }}>
                  {['#', 'Agent', 'Handled', 'Resolved', 'Handle Time', 'CSAT', 'SLA Breaches'].map(h => (
                    <span key={h} style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textAlign: h === '#' ? 'center' : 'right' }}>
                      {h === '#' ? '' : h}
                    </span>
                  ))}
                </div>
                {leaderboard.map((row, i) => (
                  <div key={row.agent_name} style={{
                    display: 'grid', gridTemplateColumns: '32px 1fr 80px 80px 80px 80px 80px', gap: 8,
                    padding: '10px 12px', borderBottom: i < leaderboard.length - 1 ? '1px solid var(--bdr)' : 'none',
                    background: i === 0 ? `${GREEN}06` : 'transparent',
                  }}>
                    <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: i === 0 ? '#F59E0B' : i === 1 ? 'var(--chart-lbl)' : i === 2 ? '#92400E' : 'var(--txt3)' }}>
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{row.agent_name}</div>
                    <div style={{ ...NUM, textAlign: 'right', fontSize: 13 }}>{row.tickets_handled}</div>
                    <div style={{ ...NUM, textAlign: 'right', fontSize: 13, fontWeight: 700, color: GREEN }}>{row.tickets_resolved}</div>
                    <div style={{ ...NUM, textAlign: 'right', fontSize: 13, color: 'var(--txt2)' }}>
                      {row.avg_handle_min != null ? `${row.avg_handle_min}m` : '—'}
                    </div>
                    <div style={{ ...NUM, textAlign: 'right', fontSize: 13, fontWeight: 600, color: row.avg_csat != null ? (row.avg_csat >= 4 ? GREEN : row.avg_csat >= 3 ? AMBER : RED) : 'var(--txt3)' }}>
                      {row.avg_csat != null ? `${Number(row.avg_csat).toFixed(1)}★` : '—'}
                    </div>
                    <div style={{ ...NUM, textAlign: 'right', fontSize: 13, color: row.sla_breaches > 0 ? RED : GREEN }}>
                      {row.sla_breaches}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </Page>
  )
}
