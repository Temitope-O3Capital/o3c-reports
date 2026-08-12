import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, ComposedChart, Bar, Line, BarChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts'
import { SectionCard, KpiCard, Spinner, ErrBanner, DateFilter } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtDate, today } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, BLUE, PURPLE, INTER, NUM, MONO, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { BAND_COLOR, qaBand } from '../../lib/qa'

const num = (v: any) => Number(v ?? 0) || 0
function fmtDur(s: number | null | undefined) {
  if (!s || s <= 0) return '—'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

interface Stats {
  summary: any
  by_day: { day: string; total: number; inbound: number; outbound: number; connected: number }[]
  by_hour: { hour: number; total: number; inbound: number; outbound: number }[]
  by_agent: any[]
  talk_distribution: { bucket: string; count: number }[]
}

export default function PerformancePanel() {
  const [from, setFrom] = useState(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))
  const [to, setTo] = useState(today())
  const [d, setD] = useState<Stats | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    // Read either envelope shape ({data:…} or bare) so this panel can't silently
    // blank if /calls/stats is ever switched to the wrapped respond() helper.
    try { setD(unwrap<Stats>(await apiFetch<any>(`/api/helpdesk/calls/stats?date_from=${from}&date_to=${to}`))) }
    catch (e: any) { setErr(e.message) }
  }, [from, to])
  useEffect(() => { load() }, [load])

  const s = d?.summary ?? {}
  const total = num(s.total)
  const connectRate = total > 0 ? Math.round((num(s.connected) / total) * 100) : 0
  const missRate = total > 0 ? Math.round((num(s.missed) / total) * 100) : 0
  const outShare = total > 0 ? Math.round((num(s.outbound) / total) * 100) : 0

  const trend = useMemo(() => (d?.by_day ?? []).map(x => ({
    date: x.day, rate: num(x.total) > 0 ? Math.round((num(x.connected) / num(x.total)) * 100) : 0, calls: num(x.total),
  })), [d])
  const hours = useMemo(() => Array.from({ length: 24 }, (_, h) => {
    const f = (d?.by_hour ?? []).find(x => num(x.hour) === h)
    return { label: String(h).padStart(2, '0'), inbound: num(f?.inbound), outbound: num(f?.outbound) }
  }), [d])
  const dist = useMemo(() => (d?.talk_distribution ?? []).map(x => ({ bucket: x.bucket, count: num(x.count) })), [d])
  const DIST_COLORS = [RED, AMBER, GREEN, BLUE]
  const agents = useMemo(() => [...(d?.by_agent ?? [])].sort((a, b) => num(b.total) - num(a.total)), [d])

  const loading = !d
  const TH: React.CSSProperties = { padding: '9px 14px', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }
  const TD: React.CSSProperties = { padding: '10px 14px', fontSize: TEXT.sm, borderBottom: '1px solid var(--bdr)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      </div>
      <ErrBanner error={err} onRetry={load} />

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3] }}>
        <KpiCard label="Total Calls"     value={total.toLocaleString()} icon="call" accent={NAVY} loading={loading} sub={`${num(s.agents)} agents`} />
        <KpiCard label="Connect Rate"    value={`${connectRate}%`} icon="check_circle" accent={GREEN} loading={loading} sub={`${num(s.connected).toLocaleString()} connected`} />
        <KpiCard label="No Answer"       value={`${missRate}%`} icon="call_missed" accent={RED} loading={loading} sub={`${num(s.missed).toLocaleString()} missed`} />
        <KpiCard label="Avg Talk"        value={fmtDur(num(s.avg_duration_sec))} icon="timer" accent={BLUE} loading={loading} sub="per connected call" />
        <KpiCard label="Outbound Share"  value={`${outShare}%`} icon="call_made" accent={PURPLE} loading={loading} sub={`${num(s.outbound).toLocaleString()} out · ${num(s.inbound).toLocaleString()} in`} />
        <KpiCard label="Unique Customers" value={num(s.unique_customers).toLocaleString()} icon="groups" accent={AMBER} loading={loading} sub="distinct numbers" />
      </div>

      {/* Connect-rate trend + talk distribution (not on the Overview) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: SP[4] }}>
        <SectionCard title="Connect Rate Trend" subtitle="Daily connect rate — quality of contact over time">
          {trend.length === 0 ? <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls in range</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(v: string) => fmtDate(v, { month: 'short', day: 'numeric' })} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} minTickGap={44} />
                <YAxis domain={[0, 100]} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }} labelFormatter={(v: string) => fmtDate(v)} />
                <Line type="monotone" dataKey="rate" name="Connect %" stroke={GREEN} strokeWidth={2.4} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
        <SectionCard title="Talk-Time Distribution" subtitle="Length of connected calls">
          {dist.length === 0 ? <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No connected calls</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dist} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'var(--row-hvr)' }} contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }} />
                <Bar dataKey="count" name="Calls" radius={[4, 4, 0, 0]} maxBarSize={54}>
                  {dist.map((_, i) => <Cell key={i} fill={DIST_COLORS[i % DIST_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>

      {/* Busiest hours */}
      <SectionCard title="Busiest Hours" subtitle="Inbound & outbound by hour of day">
        {total === 0 ? <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No calls in range</div> : (
          <ResponsiveContainer width="100%" height={190}>
            <ComposedChart data={hours} margin={{ top: 4, right: 8, left: -18, bottom: 0 }} barCategoryGap="20%">
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="label" interval={1} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: 'var(--row-hvr)' }} contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs, fontFamily: INTER }} />
              <Bar dataKey="inbound" stackId="h" name="Inbound" fill={BLUE} maxBarSize={26} />
              <Bar dataKey="outbound" stackId="h" name="Outbound" fill={NAVY} radius={[3, 3, 0, 0]} maxBarSize={26} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </SectionCard>

      {/* Agent performance — now with QA */}
      <SectionCard title="Agent Performance" badge={agents.length} padding={false}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ ...TH, textAlign: 'left' }}>Agent</th>
              {['Calls', 'Conn %', 'Missed', 'Out / In', 'Avg Talk', 'QA'].map(h => <th key={h} style={{ ...TH, textAlign: 'right' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', padding: 40 }}><Spinner size={18} /></td></tr>
                : agents.length === 0 ? <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', padding: 40, color: 'var(--txt2)' }}>No calls in range</td></tr>
                : agents.map((a, i) => {
                  const t = num(a.total), conn = num(a.connected)
                  const cr = t > 0 ? Math.round((conn / t) * 100) : 0
                  const qaAvg = a.qa_avg != null ? Number(a.qa_avg) : null
                  return (
                    <tr key={a.agent_name || i}>
                      <td style={{ ...TD, fontWeight: FW.semibold, color: 'var(--txt)' }}>{a.agent_name || 'Unknown'}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt)' }}>{t.toLocaleString()}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', fontWeight: FW.semibold, color: cr >= 30 ? GREEN : cr >= 15 ? AMBER : RED }}>{cr}%</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: num(a.missed) > 0 ? 'var(--txt2)' : 'var(--txt3)' }}>{num(a.missed).toLocaleString()}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{num(a.outbound)} / {num(a.inbound)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{fmtDur(num(a.avg_duration_sec))}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        {qaAvg != null
                          ? <span title={`${a.qa_evals} evaluation${num(a.qa_evals) !== 1 ? 's' : ''}`} style={{ ...({ fontFamily: MONO } as any), fontSize: TEXT.sm, fontWeight: FW.bold, color: BAND_COLOR[qaBand(qaAvg)] ?? NAVY }}>{qaAvg}%</span>
                          : <span style={{ color: 'var(--txt3)' }}>—</span>}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  )
}
