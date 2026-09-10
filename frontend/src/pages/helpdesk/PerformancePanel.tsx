import { useState, useEffect, useCallback, useMemo } from 'react'
import { CHART_SERIES } from '../../components/charts'
import { EBar, ELine } from '../../components/echarts'
import { SectionCard, KpiCard, Spinner, ErrBanner, DateFilter } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtDate, today } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, BLUE, PURPLE, NUM, MONO, FW, SP, TEXT } from '../../lib/design'
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
  by_purpose?: { purpose: string; total: number; inbound: number; outbound: number; connected: number; inbound_missed: number; outbound_noanswer: number; avg_duration_sec: number | null }[]
  talk_distribution: { bucket: string; count: number }[]
}

// Call type / purpose → label + colour, in step with Calls.tsx / Overview.
const PURPOSE_LABEL: Record<string, { label: string; color: string }> = {
  marketing: { label: 'Marketing / Leads', color: BLUE },
  sales: { label: 'Outbound Sales', color: PURPLE },
  collections: { label: 'Collections', color: RED },
  retention: { label: 'Retention', color: AMBER },
  other: { label: 'Other', color: NAVY },
  support: { label: 'Support', color: GREEN },
  unspecified: { label: 'Support / Unspecified', color: GREEN },
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
  const DIST_COLORS = CHART_SERIES
  const agents = useMemo(() => [...(d?.by_agent ?? [])].sort((a, b) => num(b.total) - num(a.total)), [d])
  const purposes = useMemo(() => [...(d?.by_purpose ?? [])].sort((a, b) => num(b.total) - num(a.total)), [d])

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
        <SectionCard title="Connect Rate Trend" subtitle="Daily connect rate: quality of contact over time">
          {trend.length === 0 ? <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No calls in range</div> : (
            <ELine
              data={trend.map(x => ({ ...x, label: fmtDate(x.date, { month: 'short', day: 'numeric' }) }))}
              xKey="label"
              height={200}
              endLabel
              hideYAxis
              valueFmt={(v) => `${v}%`}
              endFmt={(v) => `${v}%`}
              series={[{ key: 'rate', name: 'Connect %', color: GREEN }]}
            />
          )}
        </SectionCard>
        <SectionCard title="Talk-Time Distribution" subtitle="Length of connected calls">
          {dist.length === 0 ? <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No connected calls</div> : (
            <EBar
              data={dist}
              xKey="bucket"
              height={200}
              legend={false}
              valueFmt={(v) => v.toLocaleString()}
              axisFmt={(v) => v.toLocaleString()}
              series={[{ key: 'count', name: 'Calls', colorFn: (_r, i) => DIST_COLORS[i % DIST_COLORS.length] }]}
            />
          )}
        </SectionCard>
      </div>

      {/* Busiest hours */}
      <SectionCard title="Busiest Hours" subtitle="Inbound & outbound by hour of day">
        {total === 0 ? <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt2)' }}>No calls in range</div> : (
          <EBar
            data={hours}
            xKey="label"
            height={190}
            stack
            valueFmt={(v) => v.toLocaleString()}
            axisFmt={(v) => v.toLocaleString()}
            series={[
              { key: 'inbound', name: 'Inbound', color: BLUE },
              { key: 'outbound', name: 'Outbound', color: NAVY },
            ]}
          />
        )}
      </SectionCard>

      {/* Calls by type / purpose — every metric per book */}
      <SectionCard title="Calls by Type" subtitle="Volume, mix, connect rate & handle time per book" badge={purposes.length} padding={false}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ ...TH, textAlign: 'left' }}>Type</th>
              {['Total', '% Mix', 'Connected', 'Conn %', 'Out / In', 'Missed In', 'Avg Talk'].map(h => <th key={h} style={{ ...TH, textAlign: 'right' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', padding: 40 }}><Spinner size={18} /></td></tr>
                : purposes.length === 0 ? <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', padding: 40, color: 'var(--txt2)' }}>No calls in range</td></tr>
                : purposes.map((p) => {
                  const t = num(p.total), conn = num(p.connected)
                  const cr = t > 0 ? Math.round((conn / t) * 100) : 0
                  const mix = total > 0 ? Math.round((t / total) * 100) : 0
                  const meta = PURPOSE_LABEL[p.purpose] ?? { label: p.purpose, color: NAVY }
                  return (
                    <tr key={p.purpose}>
                      <td style={{ ...TD, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: meta.color, marginRight: 8, verticalAlign: 'middle' }} />{meta.label}
                      </td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt)', fontWeight: FW.semibold }}>{t.toLocaleString()}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt3)' }}>{mix}%</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{conn.toLocaleString()}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', fontWeight: FW.semibold, color: cr >= 30 ? GREEN : cr >= 15 ? AMBER : RED }}>{cr}%</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{num(p.outbound)} / {num(p.inbound)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: num(p.inbound_missed) > 0 ? 'var(--txt2)' : 'var(--txt3)' }}>{num(p.inbound_missed).toLocaleString()}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{fmtDur(num(p.avg_duration_sec))}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
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
