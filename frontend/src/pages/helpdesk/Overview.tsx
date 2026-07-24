import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, today, monthStart } from '../../lib/fmt'
import {
  NAVY, GREEN, AMBER, RED, BLUE, PURPLE, INTER, NUM, FW, RADIUS, SP, TEXT,
} from '../../lib/design'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface HdStats {
  open: number
  sla_breached: number
  avg_first_response_hours: number
  avg_csat: number
  agents: InboundAgentRow[]
}

interface InboundAgentRow {
  agent_name: string
  open_tickets: number
  resolved_today: number
  avg_csat: number | null
  avg_handle_time_min: number | null
  escalations: number
}

interface TmKpis {
  total_calls: number
  connected: number
  ptp_count: number
  conversion_rate_pct: number
}

interface CsatPoint  { date: string; csat_score: number }
interface TypeDist   { ticket_type: string; count: number }
interface Disposition { disposition: string; count: number }

interface OutboundAgent {
  agent_name: string
  calls: number
  connected: number
  ptp_count: number
  conversion_pct: number
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tip({ active, payload, label, fmt }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  fmt?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const f = fmt ?? (v => String(v))
  return (
    <div style={{ background: '#0E2841', borderRadius: RADIUS.lg, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{f(p.value)}</span>
          {p.name && payload.length > 1 && <span style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

const DONUT_COLORS = [BLUE, AMBER, GREEN, RED, PURPLE, NAVY]

const DISP_LABEL: Record<string, string> = {
  converted: 'Converted', not_interested: 'Not Interested',
  callback: 'Callback', no_answer: 'No Answer', skipped: 'Skipped',
}
const DISP_COLOR: Record<string, string> = {
  converted: GREEN, not_interested: RED,
  callback: AMBER, no_answer: PURPLE, skipped: 'var(--txt3)',
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ContactCentreOverview() {
  const [hd, setHd]           = useState<HdStats | null>(null)
  const [tm, setTm]           = useState<TmKpis | null>(null)
  const [csat, setCsat]       = useState<CsatPoint[]>([])
  const [types, setTypes]     = useState<TypeDist[]>([])
  const [disp, setDisp]       = useState<Disposition[]>([])
  const [outAgents, setOutAgents] = useState<OutboundAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const from = monthStart(); const to = today()
    const qs = `date_from=${from}&date_to=${to}`
    try {
      const [hdRes, tmRes, csatRes, typeRes, dispRes, outRes] = await Promise.all([
        apiFetch<HdStats>('/api/helpdesk/stats'),
        apiFetch<TmKpis>('/api/telemarketing/performance-kpis'),
        apiFetch<{ data: CsatPoint[] }>(`/api/helpdesk/csat-trend?${qs}`),
        apiFetch<{ data: TypeDist[] }>(`/api/helpdesk/type-distribution?${qs}`),
        apiFetch<{ data: Disposition[] }>('/api/telemarketing/by-disposition'),
        apiFetch<{ data: OutboundAgent[] }>('/api/telemarketing/agent-performance'),
      ])
      setHd(hdRes)
      setTm(tmRes)
      setCsat(csatRes.data ?? [])
      setTypes(typeRes.data ?? [])
      setDisp(dispRes.data ?? [])
      setOutAgents(outRes.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const donutTotal = types.reduce((s, t) => s + t.count, 0)
  const csatColor  = (v: number) => v >= 4 ? GREEN : v >= 3 ? AMBER : RED

  const Th = ({ children, right }: { children: string; right?: boolean }) => (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textAlign: right ? 'right' : 'left' }}>
      {children}
    </span>
  )

  return (
    <Page title="Contact Centre" subtitle="Inbound & outbound performance · month to date">
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : (
        <>
          {/* ── KPI strip ─────────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[5] }}>
            {/* Inbound */}
            <KpiCard label="Open Tickets"      value={fmtNum(hd?.open ?? 0)}          accent={RED}   />
            <KpiCard label="SLA Breaches"      value={fmtNum(hd?.sla_breached ?? 0)}  accent={(hd?.sla_breached ?? 0) > 5 ? RED : AMBER} />
            <KpiCard label="Avg CSAT"          value={`${(hd?.avg_csat ?? 0).toFixed(1)}★`} accent={csatColor(hd?.avg_csat ?? 0)} />
            {/* Outbound */}
            <KpiCard label="Calls Made"        value={fmtNum(tm?.total_calls ?? 0)}   accent={NAVY}  />
            <KpiCard label="Connected"         value={fmtNum(tm?.connected ?? 0)}     accent={BLUE}  />
            <KpiCard label="Conversion Rate"   value={fmtPct((tm?.conversion_rate_pct ?? 0) / 100)} accent={GREEN} />
          </div>

          {/* ── Row 1: CSAT trend + Ticket type donut ────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
            <SectionCard title="CSAT Trend" subtitle="Daily satisfaction score — inbound tickets (0–5)">
              {csat.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No data yet</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={csat} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
                    <XAxis dataKey="date" tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 5]} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => v.toFixed(1)} />} />
                    <Line type="monotone" dataKey="csat_score" stroke={GREEN} strokeWidth={2.2} name="CSAT"
                      dot={{ r: 3, fill: GREEN, strokeWidth: 0 }} activeDot={{ r: 5, fill: GREEN, stroke: '#fff', strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="Ticket Types" subtitle="Distribution by category">
              {types.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No tickets yet</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP[3] }}>
                  <div style={{ position: 'relative' }}>
                    <PieChart width={140} height={140}>
                      <Pie data={types} cx={66} cy={66} innerRadius={40} outerRadius={62} dataKey="count"
                        stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                        {types.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                      </Pie>
                    </PieChart>
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
                      <div style={{ fontSize: TEXT.xl, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, lineHeight: 1 }}>{donutTotal}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: INTER }}>tickets</div>
                    </div>
                  </div>
                  <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: SP[1] }}>
                    {types.map((t, i) => (
                      <div key={t.ticket_type} style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt)' }}>{t.ticket_type}</span>
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt)', ...NUM }}>{t.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>
          </div>

          {/* ── Row 2: Outbound disposition + Outbound agent snapshot ───── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
            <SectionCard title="Outbound Disposition" subtitle="Call outcomes — telemarketing & campaign calls">
              {disp.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No calls yet</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={disp} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }} barCategoryGap="25%">
                    <XAxis type="number" tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="disposition" width={96}
                      tickFormatter={(v: string) => DISP_LABEL[v] ?? v}
                      tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v} calls`} />} />
                    <Bar dataKey="count" radius={[0, 5, 5, 0]} name="Calls">
                      {disp.map((d, i) => <Cell key={i} fill={DISP_COLOR[d.disposition] ?? BLUE} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </SectionCard>

            <SectionCard title="Outbound Agent Snapshot" subtitle="Telemarketing & campaign call agents">
              {outAgents.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No data yet</div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 52px 60px 56px', gap: SP[2], padding: '5px 10px', background: 'var(--th-bg)', borderRadius: RADIUS.md, marginBottom: SP[1] }}>
                    <Th>Agent</Th><Th right>Calls</Th><Th right>Connected</Th><Th right>Conv%</Th>
                  </div>
                  {outAgents.slice(0, 6).map((a, i) => (
                    <div key={a.agent_name} style={{ display: 'grid', gridTemplateColumns: '1fr 52px 60px 56px', gap: SP[2], padding: '8px 10px', borderBottom: i < Math.min(outAgents.length, 6) - 1 ? '1px solid var(--bdr)' : 'none' }}>
                      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.agent_name}</span>
                      <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm }}>{a.calls}</span>
                      <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm }}>{a.connected}</span>
                      <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: a.conversion_pct >= 15 ? GREEN : a.conversion_pct >= 8 ? AMBER : RED }}>
                        {a.conversion_pct}%
                      </span>
                    </div>
                  ))}
                </>
              )}
            </SectionCard>
          </div>

          {/* ── Row 3: Inbound agent snapshot ────────────────────────────── */}
          <SectionCard title="Inbound Agent Snapshot" subtitle="Call centre agents — tickets handled today">
            {!hd?.agents?.length ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No agent data</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 72px 96px 72px 80px 72px', gap: SP[2], padding: '5px 10px', background: 'var(--th-bg)', borderRadius: RADIUS.md, marginBottom: SP[1] }}>
                  <Th>Agent</Th><Th right>Open</Th><Th right>Resolved Today</Th><Th right>CSAT</Th><Th right>Avg Handle</Th><Th right>Escalations</Th>
                </div>
                {hd.agents.map((a, i) => (
                  <div key={a.agent_name} style={{ display: 'grid', gridTemplateColumns: '1fr 72px 96px 72px 80px 72px', gap: SP[2], padding: '9px 10px', borderBottom: i < hd.agents.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.agent_name}</span>
                    <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: a.open_tickets > 10 ? AMBER : 'var(--txt)' }}>{a.open_tickets}</span>
                    <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: GREEN }}>{a.resolved_today}</span>
                    <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: a.avg_csat != null ? csatColor(a.avg_csat) : 'var(--txt3)' }}>
                      {a.avg_csat != null ? `${a.avg_csat.toFixed(1)}★` : '—'}
                    </span>
                    <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                      {a.avg_handle_time_min != null ? `${a.avg_handle_time_min}m` : '—'}
                    </span>
                    <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, color: a.escalations > 0 ? RED : 'var(--txt3)' }}>
                      {a.escalations}
                    </span>
                  </div>
                ))}
              </>
            )}
          </SectionCard>
        </>
      )}
    </Page>
  )
}
