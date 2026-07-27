import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecSales {
  pipeline_value_kobo: number
  pipeline_count: number
  conversions_mtd: number
  conversion_rate_pct: number
  calls_made_mtd: number
  meetings_held_mtd: number
  targets_achieved_pct: number
  monthly_trend: { month: string; calls: number; conversions: number; value_kobo: number }[]
  top_performers: { name: string; conversions: number; value_kobo: number }[]
  pipeline_stages: { stage: string; count: number; value_kobo: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

const STAGE_COLORS = [
  { stage: 'Prospect',  color: '#C5CDD8' },
  { stage: 'Engaged',   color: '#6D8FAF' },
  { stage: 'Proposal',  color: '#1E5285' },
  { stage: 'Won',       color: GREEN },
]

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

export default function ExecSales() {
  const [data, setData] = useState<ExecSales | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecSales }>(`/api/executive/sales?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Sales — Executive View'
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

  const perfMax = data.top_performers[0]?.value_kobo ?? 1
  const totalPipeline = data.pipeline_stages.reduce((s, st) => s + st.count, 0) || 1

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Pipeline Value"    value={fmtKobo(data.pipeline_value_kobo)} sub={`${fmtNum(data.pipeline_count)} prospects`} icon="monetization_on"  accent={NAVY}  />
        <KpiCard label="Conversions MTD"   value={fmtNum(data.conversions_mtd)}                                                        icon="check_circle"      accent={GREEN} />
        <KpiCard label="Conversion Rate"   value={fmtPct(data.conversion_rate_pct)}                                                    icon="trending_up"       accent={BLUE}  />
        <KpiCard label="Target Achievement" value={fmtPct(data.targets_achieved_pct)} sub={`${fmtNum(data.meetings_held_mtd)} meetings`} icon="flag"            accent={data.targets_achieved_pct >= 80 ? GREEN : AMBER} />
      </div>

      {/* Sales trend + Pipeline funnel */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Sales Activity Trend" subtitle="Calls and conversions by month">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.monthly_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                <linearGradient id="gradCalls" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BLUE} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradConv" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={GREEN} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={40} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip />} />
              <Area type="monotone" dataKey="calls" name="Calls" stroke={BLUE} strokeWidth={2} fill="url(#gradCalls)"
                dot={{ r: 2, fill: BLUE, strokeWidth: 0 }} activeDot={{ r: 4, fill: BLUE, stroke: '#fff', strokeWidth: 2 }} />
              <Area type="monotone" dataKey="conversions" name="Conversions" stroke={GREEN} strokeWidth={2.2} fill="url(#gradConv)"
                dot={{ r: 3, fill: GREEN, strokeWidth: 0 }} activeDot={{ r: 5, fill: GREEN, stroke: '#fff', strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Pipeline Funnel" subtitle="Prospect to Won" actions={
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: INTER, ...NUM, padding: '2px 9px', borderRadius: 99, background: `${NAVY}12`, color: NAVY, border: `1px solid ${NAVY}20` }}>
            {fmtNum(totalPipeline)} total
          </span>
        }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
            {data.pipeline_stages.map((st, i) => {
              const stageColor = STAGE_COLORS.find(s => s.stage.toLowerCase() === st.stage.toLowerCase())?.color ?? NAVY
              const width = `${Math.round((st.count / totalPipeline) * 100)}%`
              return (
                <div key={st.stage}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 9, height: 9, borderRadius: 2, background: stageColor, flexShrink: 0 }} />
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{st.stage}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtNum(st.count)}</span>
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginLeft: 6 }}>{fmtKobo(st.value_kobo)}</span>
                    </div>
                  </div>
                  <div style={{ height: 8, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width, height: '100%', background: stageColor, borderRadius: 99, transition: 'width 600ms ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>
      </div>

      {/* Top performers */}
      <SectionCard title="Top Performers" subtitle="By conversion value this period">
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
          {data.top_performers.slice(0, 5).map((p, i) => {
            const color = PERF_COLORS[i % PERF_COLORS.length]
            const initials = p.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
            return (
              <div key={p.name}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                  <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, width: 16, flexShrink: 0, textAlign: 'right' }}>#{i + 1}</span>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, flexShrink: 0 }}>{initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.value_kobo)}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{p.conversions} conversions</div>
                  </div>
                </div>
                <div style={{ height: 4, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{ width: `${(p.value_kobo / perfMax) * 100}%`, height: '100%', background: color, borderRadius: 99 }} />
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>
    </Page>
  )
}
