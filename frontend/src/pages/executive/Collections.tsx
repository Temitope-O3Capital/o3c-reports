import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ComposedChart,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecCollections {
  collected_mtd_kobo: number
  collected_change_pct: number
  collection_rate_pct: number
  promise_rate_pct: number
  par30_count: number
  par60_count: number
  par90_count: number
  par30_value_kobo: number
  par60_value_kobo: number
  par90_value_kobo: number
  writeoff_mtd_kobo: number
  recovery_rate_pct: number
  monthly_trend: { month: string; collected: number; target: number; rate: number }[]
  dpd_breakdown: { bucket: string; count: number; value_kobo: number }[]
  top_agents: { name: string; collected_kobo: number; count: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

const DPD_COLORS: Record<string, string> = {
  'Current': GREEN,
  '1-30': AMBER,
  '31-60': RED,
  '61-90': PURPLE,
  '90+': '#7F0000',
}

const PERF_COLORS = [RED, NAVY, AMBER, GREEN, PURPLE, BLUE]

function PeriodFilter({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--chip-bg)', borderRadius: RADIUS.md, padding: 3, border: '1px solid var(--bdr)' }}>
      {PERIOD_OPTIONS.map(opt => (
        <button key={opt.id} onClick={() => onChange(opt.id)} style={{
          padding: '5px 14px', borderRadius: 7, border: 'none',
          fontSize: TEXT.sm, fontWeight: period === opt.id ? FW.bold : FW.medium,
          fontFamily: INTER, cursor: 'pointer',
          background: period === opt.id ? 'var(--card)' : 'transparent',
          color: period === opt.id ? 'var(--txt)' : 'var(--txt2)',
          boxShadow: period === opt.id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          transition: 'all 130ms',
        }}>{opt.label}</button>
      ))}
    </div>
  )
}

function Tip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: NAVY, borderRadius: RADIUS.lg, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{fmt ? fmt(p.value) : p.value}</span>
          {p.name && payload.length > 1 && <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

export default function ExecCollections() {
  const [data, setData] = useState<ExecCollections | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecCollections }>(`/api/executive/collections?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Collections — Executive View'
  const back = { label: 'Executive Overview', to: '/' }
  const actions = <PeriodFilter period={period} onChange={p => { setPeriod(p); load(p) }} />

  if (loading) return (
    <Page title={title} back={back} actions={actions}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title={title} back={back} actions={actions}>
      <ErrBanner error={error} onRetry={() => load(period)} />
    </Page>
  )
  if (!data) return null

  const agentMax = data.top_agents[0]?.collected_kobo ?? 1

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Collected MTD"    value={fmtKobo(data.collected_mtd_kobo)}    change={data.collected_change_pct} icon="payments"         accent={GREEN}  />
        <KpiCard label="Collection Rate"  value={fmtPct(data.collection_rate_pct)}    sub={`Promise rate: ${fmtPct(data.promise_rate_pct)}`}     icon="trending_up"      accent={BLUE}   />
        <KpiCard label="PAR30 Value"      value={fmtKobo(data.par30_value_kobo)}      sub={`${fmtNum(data.par30_count)} accounts`}                icon="warning"          accent={AMBER}  />
        <KpiCard label="Recovery Rate"    value={fmtPct(data.recovery_rate_pct)}      sub={`Write-off: ${fmtKobo(data.writeoff_mtd_kobo)}`}       icon="restore"          accent={PURPLE} />
      </div>

      {/* Collections trend + DPD breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Collections Trend" subtitle="Collected vs target by month">
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={data.monthly_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                <linearGradient id="gradCollected" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={GREEN} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
                tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={fmtKobo} />} />
              <Area type="monotone" dataKey="collected" name="Collected" stroke={GREEN} strokeWidth={2.2} fill="url(#gradCollected)"
                dot={{ r: 3, fill: GREEN, strokeWidth: 0 }} activeDot={{ r: 5, fill: GREEN, stroke: '#fff', strokeWidth: 2 }} />
              <Line type="monotone" dataKey="target" name="Target" stroke={AMBER} strokeWidth={2}
                strokeDasharray="5 4" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="DPD Breakdown" subtitle="Accounts by days past due">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.dpd_breakdown} margin={{ top: 4, right: 8, bottom: 14, left: 8 }} layout="vertical">
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
              <XAxis type="number" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="bucket" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} width={48} />
              <Tooltip content={<Tip fmt={fmtNum} />} />
              <Bar dataKey="count" name="Accounts" radius={[0, 4, 4, 0]}>
                {data.dpd_breakdown.map((entry, i) => (
                  <rect key={i} fill={DPD_COLORS[entry.bucket] ?? NAVY} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>

      {/* PAR summary + Top agents */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: SP[3] }}>
        <SectionCard title="PAR Summary">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4], paddingTop: 4 }}>
            {[
              { label: 'PAR30 (1–30 days)', count: data.par30_count, value: data.par30_value_kobo, color: AMBER },
              { label: 'PAR60 (31–60 days)', count: data.par60_count, value: data.par60_value_kobo, color: RED },
              { label: 'PAR90 (60+ days)',   count: data.par90_count, value: data.par90_value_kobo, color: PURPLE },
            ].map(({ label, count, value, color }) => (
              <div key={label} style={{ borderLeft: `3px solid ${color}`, paddingLeft: SP[3] }}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtKobo(value)}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 3 }}>{fmtNum(count)} accounts</div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Top Collections Agents" subtitle="By amount collected this period">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
            {data.top_agents.slice(0, 5).map((agent, i) => {
              const color = PERF_COLORS[i % PERF_COLORS.length]
              const initials = agent.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
              return (
                <div key={agent.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, width: 16, flexShrink: 0, textAlign: 'right' }}>#{i + 1}</span>
                    <div style={{ width: 30, height: 30, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, flexShrink: 0 }}>{initials}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(agent.collected_kobo)}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(agent.count)} accounts</div>
                    </div>
                  </div>
                  <div style={{ height: 4, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width: `${(agent.collected_kobo / agentMax) * 100}%`, height: '100%', background: color, borderRadius: 99 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
