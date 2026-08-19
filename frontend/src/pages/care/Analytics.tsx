import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback } from 'react'
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, FW, RADIUS, SP, TEXT, NUM } from '../../lib/design'

// Care Analytics — mail-channel trends, agent leaderboard, CSAT & peak hours.
// A self-contained tab body inside the Care hub; loads its own data per window.

interface Summary {
  received: number
  resolved: number
  resolution_rate: number | null
  open_backlog: number
  avg_first_response_mins: number | null
  avg_resolution_hours: number | null
  csat_avg: number | null
  csat_count: number
}
interface VolumeRow { date: string; received: number; resolved: number }
interface RespRow { date: string; avg_first_mins: number }
interface HourRow { hour: number; n: number }
interface StatusRow { status: string; n: number }
interface AgentRow {
  agent_name: string
  resolved: number
  avg_first_response_mins: number | null
  avg_handle_mins: number | null
  csat: number | null
}
interface CareAnalyticsResp {
  summary: Summary
  volume: VolumeRow[]
  response_trend: RespRow[]
  by_hour: HourRow[]
  status_mix: StatusRow[]
  agents: AgentRow[]
  days: number
}

const WINDOWS = [7, 30, 90] as const

function fmtMins(m: number | null | undefined): string {
  if (m == null) return '—'
  if (m < 60) return `${Math.round(m)}m`
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
}
function fmtPct1(n: number | null | undefined): string {
  return n == null ? '—' : `${Number(n).toFixed(1)}%`
}
function shortDate(iso: string): string {
  // 'YYYY-MM-DD' → 'DD Mon'
  const [, m, d] = iso.split('-')
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${mon[(parseInt(m, 10) || 1) - 1]}`
}
function fmtHour(h: number): string {
  const am = h < 12
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}${am ? 'a' : 'p'}`
}

const STATUS_COLOR: Record<string, string> = {
  open: NAVY, pending: AMBER, resolved: GREEN, closed: PURPLE,
}

const AXIS = { fontSize: 11, fill: 'var(--txt3)' }

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '8px 10px', fontSize: TEXT.xs, boxShadow: '0 6px 20px rgba(0,0,0,0.12)' }}>
      <div style={{ fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--txt2)' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block' }} />
          <span style={{ textTransform: 'capitalize' }}>{p.name}:</span>
          <span style={{ ...NUM, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function CareAnalytics() {
  const [days, setDays] = useState<number>(30)
  const [d, setD] = useState<CareAnalyticsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const r = await apiFetch<any>(`/api/helpdesk/care-analytics?days=${days}`)
      setD((r?.data ?? r) as CareAnalyticsResp)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [days])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['tickets'] })

  const s = d?.summary

  return (
    <>
      {/* Window selector */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: SP[1], marginBottom: SP[3] }}>
        {WINDOWS.map(wd => {
          const on = days === wd
          return (
            <button key={wd} onClick={() => setDays(wd)}
              style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '5px 12px', borderRadius: RADIUS.md, border: `1px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? NAVY : 'transparent', color: on ? '#fff' : 'var(--txt2)', cursor: 'pointer' }}>
              {wd}d
            </button>
          )
        })}
      </div>

      <ErrBanner error={err} onRetry={load} />

      {loading && !d ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div>
      ) : s && d && (
        <>
          {/* KPI strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
            <KpiCard label="Mails Received" value={fmtNum(s.received)} icon="inbox" accent={NAVY} sub={`last ${days} days`} />
            <KpiCard label="Resolved" value={fmtNum(s.resolved)} icon="check_circle" accent={GREEN} sub={`${fmtPct1(s.resolution_rate)} of received`} />
            <KpiCard label="Avg 1st Response" value={fmtMins(s.avg_first_response_mins)} icon="timer" accent={BLUE} sub="time to first reply" />
            <KpiCard label="Avg Resolution" value={s.avg_resolution_hours == null ? '—' : `${Number(s.avg_resolution_hours).toFixed(1)}h`} icon="schedule" accent={AMBER} sub="open to resolved" />
            <KpiCard label="Open Backlog" value={fmtNum(s.open_backlog)} icon="pending_actions" accent={RED} sub="unresolved now" />
            <KpiCard label="CSAT" value={s.csat_avg == null ? '—' : Number(s.csat_avg).toFixed(2)} icon="sentiment_satisfied" accent={PURPLE} sub={`${fmtNum(s.csat_count)} rated`} />
          </div>

          {/* Volume + response trend */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginBottom: SP[4], alignItems: 'start' }}>
            <SectionCard title="Mail Volume" subtitle="Received vs resolved per day">
              {d.volume.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={d.volume} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gRecv" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={NAVY} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={NAVY} stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="gResv" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={GREEN} stopOpacity={0.24} />
                        <stop offset="100%" stopColor={GREEN} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                    <XAxis dataKey="date" tick={AXIS} tickFormatter={shortDate} minTickGap={24} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} allowDecimals={false} axisLine={false} tickLine={false} width={34} />
                    <Tooltip content={<ChartTip />} labelFormatter={shortDate} />
                    <Area type="monotone" dataKey="received" name="Received" stroke={NAVY} strokeWidth={2} fill="url(#gRecv)" />
                    <Area type="monotone" dataKey="resolved" name="Resolved" stroke={GREEN} strokeWidth={2} fill="url(#gResv)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="First-Response Time" subtitle="Avg minutes to first reply, by day">
              {d.response_trend.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={d.response_trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                    <XAxis dataKey="date" tick={AXIS} tickFormatter={shortDate} minTickGap={24} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} allowDecimals={false} axisLine={false} tickLine={false} width={34} />
                    <Tooltip content={<ChartTip />} labelFormatter={shortDate} />
                    <Line type="monotone" dataKey="avg_first_mins" name="Avg mins" stroke={BLUE} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </SectionCard>
          </div>

          {/* Peak hours + status mix */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginBottom: SP[4], alignItems: 'start' }}>
            <SectionCard title="Peak Inbound Hours" subtitle="When customers email (by hour of day)">
              {d.by_hour.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={d.by_hour} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                    <XAxis dataKey="hour" tick={AXIS} tickFormatter={fmtHour} axisLine={false} tickLine={false} interval={1} />
                    <YAxis tick={AXIS} allowDecimals={false} axisLine={false} tickLine={false} width={34} />
                    <Tooltip content={<ChartTip />} labelFormatter={(h: number) => fmtHour(h)} />
                    <Bar dataKey="n" name="Mails" fill={NAVY} radius={[3, 3, 0, 0]} maxBarSize={22} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="Status Mix" subtitle={`Email tickets, last ${days} days`}>
              {d.status_mix.length === 0 ? <Empty /> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
                  {(() => {
                    const tot = d.status_mix.reduce((a, r) => a + r.n, 0) || 1
                    return d.status_mix.map(r => {
                      const pct = (r.n / tot) * 100
                      const c = STATUS_COLOR[r.status] || BLUE
                      return (
                        <div key={r.status}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.xs, marginBottom: 3 }}>
                            <span style={{ textTransform: 'capitalize', color: 'var(--txt2)', fontWeight: FW.semibold }}>{r.status}</span>
                            <span style={{ ...NUM, color: 'var(--txt)' }}>{fmtNum(r.n)} · {pct.toFixed(0)}%</span>
                          </div>
                          <div style={{ height: 7, borderRadius: 4, background: 'var(--th-bg)', overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: c, borderRadius: 4 }} />
                          </div>
                        </div>
                      )
                    })
                  })()}
                </div>
              )}
            </SectionCard>
          </div>

          {/* Agent leaderboard */}
          <SectionCard title="Agent Leaderboard" subtitle={`Resolved & responsiveness, last ${days} days`}>
            {d.agents.length === 0 ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No agent activity in this window.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--txt3)', fontSize: TEXT.xs }}>
                      <th style={{ padding: '6px 8px', fontWeight: FW.semibold }}>Agent</th>
                      <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Resolved</th>
                      <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Avg 1st Reply</th>
                      <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Avg Handle</th>
                      <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>CSAT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.agents.map((a, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--bdr)' }}>
                        <td style={{ padding: '8px', fontWeight: FW.semibold, color: 'var(--txt)' }}>{a.agent_name}</td>
                        <td style={{ ...NUM, padding: '8px', textAlign: 'right', color: 'var(--txt)' }}>{fmtNum(a.resolved)}</td>
                        <td style={{ ...NUM, padding: '8px', textAlign: 'right', color: 'var(--txt2)' }}>{fmtMins(a.avg_first_response_mins)}</td>
                        <td style={{ ...NUM, padding: '8px', textAlign: 'right', color: 'var(--txt2)' }}>{fmtMins(a.avg_handle_mins)}</td>
                        <td style={{ ...NUM, padding: '8px', textAlign: 'right', fontWeight: FW.bold, color: a.csat == null ? 'var(--txt3)' : a.csat >= 4 ? GREEN : a.csat >= 3 ? AMBER : RED }}>
                          {a.csat == null ? '—' : Number(a.csat).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </>
  )
}

function Empty() {
  return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No data in this window.</div>
}
