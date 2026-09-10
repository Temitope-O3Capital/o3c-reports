import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, today } from '../../lib/fmt'
import {
  NAVY, GREEN, AMBER, RED, BLUE, PURPLE, INTER, NUM, FW, RADIUS, SP, TEXT,
} from '../../lib/design'
import { EBar, ELine, EDonut } from '../../components/echarts'

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
  inbound_missed: number; outbound_noanswer: number
  inbound_connected: number; outbound_connected: number
  total_talk_sec: number; agents: number
  avg_duration_sec: number | null; avg_inbound_sec: number | null; avg_outbound_sec: number | null
}
interface CallDay   { day: string; inbound: number; outbound: number }
interface CallHour  { hour: number; total: number; inbound: number; outbound: number }
interface CallAgent { agent_name: string; total: number; connected: number; avg_duration_sec: number | null }
interface CallPurpose {
  purpose: string; total: number; inbound: number; outbound: number
  connected: number; inbound_missed: number; outbound_noanswer: number; avg_duration_sec: number | null
}

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
// fmtPct expects a 0–100 number, but pct() returns a 0–1 ratio — so every percentage
// on this page must scale by 100 before formatting. fpct does that in one place.
const fpct = (r: number | null | undefined) => `${((Number(r) || 0) * 100).toFixed(1)}%`

// Call type / purpose → label + colour, kept in step with Calls.tsx PURPOSE_META.
const PURPOSE_LABEL: Record<string, { label: string; color: string }> = {
  marketing:   { label: 'Marketing / Leads',     color: BLUE },
  sales:       { label: 'Outbound Sales',        color: PURPLE },
  collections: { label: 'Collections',           color: RED },
  retention:   { label: 'Retention',             color: AMBER },
  other:       { label: 'Other',                 color: NAVY },
  support:     { label: 'Support',               color: GREEN },
  unspecified: { label: 'Support / Unspecified', color: GREEN },
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CallCenterOverview() {
  // Call data is historical (synced from Zoho), so default to the last 12 months —
  // a "this month" default opened the page on empty charts. Matches the Call Log.
  const [from, setFrom]   = useState(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10))
  const [to, setTo]       = useState(today())
  const [tk, setTk]       = useState<TicketStats | null>(null)
  const [cs, setCs]       = useState<CallSummary | null>(null)
  const [byDay, setByDay]       = useState<CallDay[]>([])
  const [byHour, setByHour]     = useState<CallHour[]>([])
  const [byPurpose, setByPurpose] = useState<CallPurpose[]>([])
  const [callAgents, setCallAgents] = useState<CallAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
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
      setByPurpose(arr(cd?.by_purpose))
      setCallAgents(arr(cd?.by_agent))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['tickets'] })

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
  // Direction-aware unanswered counts come straight from the backend now (outcome IN
  // missed/no_answer/voicemail, split by direction) — not inbound − inbound_connected,
  // which wrongly counted blank-outcome inbound rows as missed customer calls.
  const inboundMissed = cs?.inbound_missed ?? 0
  const outboundNoAns = cs?.outbound_noanswer ?? 0
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
  return (
    <Page
      title="Call Center"
      subtitle="Calls, tickets & team performance"
      loading={loading && !cs}
      skeletonKpis={6}
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
            <KpiCard label="Connected"      value={fmtNum(connected)}            accent={GREEN} sub={`${fpct(connectRate)} connect rate`} />
            <KpiCard label="Missed Inbound" value={fmtNum(inboundMissed)}        accent={inMissRate >= 0.2 ? RED : AMBER} sub={`${fmtNum(outboundNoAns)} outbound no-answer`} />
            <KpiCard label="Avg Handle"     value={fmtDur(cs?.avg_duration_sec)} accent={PURPLE} />
            <KpiCard label="Talk Time"      value={fmtHours(cs?.total_talk_sec)} accent={BLUE} />
            <KpiCard label="Open Tickets"   value={fmtNum(tk?.open ?? 0)}        accent={(tk?.sla_breached ?? 0) > 5 ? RED : BLUE} sub={`${fmtNum(tk?.sla_breached ?? 0)} past SLA`} />
          </div>

          {/* ── Team-lead metric strip ────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
            <MiniStat label="Inbound Answer Rate"  value={fpct(inAns)}   good={inAns >= 0.8}  hint={`${fmtNum(cs?.inbound_connected ?? 0)} / ${fmtNum(cs?.inbound ?? 0)} answered`} />
            <MiniStat label="Outbound Connect Rate" value={fpct(outConn)} good={outConn >= 0.3} hint={`${fmtNum(cs?.outbound_connected ?? 0)} / ${fmtNum(cs?.outbound ?? 0)} connected`} />
            <MiniStat label="Active Agents"        value={fmtNum(activeAgents)} hint="made calls in range" />
            <MiniStat label="Avg Calls / Agent"    value={fmtNum(avgPerAgent)}  hint="workload balance" />
          </div>

          {/* ── Row 1: Call volume (grouped) + Inbound/Outbound split ─────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
            <SectionCard title="Call Volume" subtitle="Inbound vs outbound per day">
              {byDay.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls in this range</div>
              ) : (
                <EBar
                  data={byDay.map(x => ({ label: fmtDate(x.day, { month: 'short', day: 'numeric' }), inbound: Number(x.inbound), outbound: Number(x.outbound) }))}
                  xKey="label"
                  height={230}
                  valueFmt={fmtNum}
                  axisFmt={fmtNum}
                  series={[
                    { key: 'inbound', name: 'Inbound', color: BLUE },
                    { key: 'outbound', name: 'Outbound', color: NAVY },
                  ]}
                />
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
          <SectionCard title="Busiest Hours" subtitle="Inbound & outbound by hour of day: plan staffing around the peaks" style={{ marginBottom: SP[4] }}>
            {total === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No calls in this range</div>
            ) : (
              <ELine
                data={hourData}
                xKey="label"
                height={200}
                valueFmt={fmtNum}
                axisFmt={fmtNum}
                series={[
                  { key: 'inbound', name: 'Inbound', color: BLUE },
                  { key: 'outbound', name: 'Outbound', color: NAVY },
                ]}
              />
            )}
          </SectionCard>

          {/* ── Calls by type / purpose ───────────────────────────────────── */}
          <SectionCard title="Calls by Type" subtitle="What the calls were for — volume, mix & connect rate per book" style={{ marginBottom: SP[4] }}>
            {byPurpose.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No calls in this range</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
                {byPurpose.map((p) => {
                  const meta = PURPOSE_LABEL[p.purpose] ?? { label: p.purpose, color: NAVY }
                  const cr = pct(p.connected, p.total)
                  const share = pct(p.total, total)
                  return (
                    <div key={p.purpose} style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: meta.color, flexShrink: 0 }} />
                      <span style={{ width: 150, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.label}</span>
                      <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bdr)', overflow: 'hidden', minWidth: 60 }}>
                        <div style={{ width: `${Math.round(share * 100)}%`, height: '100%', background: meta.color, borderRadius: 4 }} />
                      </div>
                      <span style={{ ...NUM, width: 92, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(p.total)}</span>
                      <span style={{ ...NUM, width: 54, textAlign: 'right', fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fpct(share)}</span>
                      <span style={{ ...NUM, width: 96, textAlign: 'right', fontSize: TEXT.xs, color: cr >= 0.3 ? GREEN : cr >= 0.15 ? AMBER : 'var(--txt2)' }}>{fpct(cr)} conn.</span>
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>

          {/* ── Row 2: Outcomes doughnut + Agent performance ──────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: SP[4] }}>
            <SectionCard title="Call Outcomes" subtitle="Connected vs unanswered, by direction">
              {donutTotal === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls yet</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
                  <div style={{ flexShrink: 0, width: 160 }}>
                    <EDonut
                      data={outcomeBreakdown}
                      valueKey="count"
                      nameKey="label"
                      colorFn={(o) => o.color}
                      size={160}
                      inner={48}
                      centerValue={fmtNum(donutTotal)}
                      centerLabel="calls"
                      valueFmt={fmtNum}
                    />
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2], minWidth: 0 }}>
                    {outcomeBreakdown.map((o) => (
                      <div key={o.key} style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: o.color, flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)' }}>{o.label}</span>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', ...NUM }}>{fmtNum(o.count)}</span>
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM, width: 40, textAlign: 'right' }}>{fpct(pct(o.count, donutTotal))}</span>
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
                        <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold, color: a.calls === 0 ? 'var(--txt3)' : cr >= 0.3 ? GREEN : cr >= 0.15 ? AMBER : RED }}>{a.calls ? fpct(cr) : '—'}</span>
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
          <span style={{ color: 'var(--txt)', fontWeight: FW.semibold }}>{fpct(rate)}</span> {rateLabel} · avg {fmtDur(avg)}
        </div>
      </div>
    </div>
  )
}
