import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecHR {
  headcount: number
  headcount_change: number
  new_hires_mtd: number
  departures_mtd: number
  attrition_rate_pct: number
  leaves_pending: number
  leaves_active: number
  payroll_cost_kobo: number
  payroll_change_pct: number
  dept_breakdown: { dept: string; count: number }[]
  headcount_trend: { month: string; count: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

const DONUT_COLORS = [NAVY, BLUE, AMBER, GREEN, RED, PURPLE, '#0891B2', '#059669']

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

export default function ExecHR() {
  const [data, setData] = useState<ExecHR | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecHR }>(`/api/executive/hr?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'HR — Executive View'
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

  const totalDept = data.dept_breakdown.reduce((s, d) => s + d.count, 0) || 1

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Headcount"       value={fmtNum(data.headcount)}              sub={`${data.headcount_change >= 0 ? '+' : ''}${data.headcount_change} from last month`}  icon="groups"        accent={NAVY}  />
        <KpiCard label="New Hires MTD"   value={fmtNum(data.new_hires_mtd)}          sub={`${data.departures_mtd} departures`}                                                  icon="person_add"    accent={GREEN} />
        <KpiCard label="Attrition Rate"  value={fmtPct(data.attrition_rate_pct)}                                                                                               icon="person_remove" accent={data.attrition_rate_pct > 5 ? RED : AMBER} />
        <KpiCard label="Payroll Cost MTD" value={fmtKobo(data.payroll_cost_kobo)}    change={data.payroll_change_pct}                                                           icon="payments"      accent={BLUE}  />
      </div>

      {/* Headcount trend + Dept breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Headcount Trend" subtitle="Staff count by month">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.headcount_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                <linearGradient id="gradHC" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={40} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={(v: number) => `${v} employees`} />} />
              <Area type="monotone" dataKey="count" name="Headcount" stroke={NAVY} strokeWidth={2.2} fill="url(#gradHC)"
                dot={{ r: 3, fill: NAVY, strokeWidth: 0 }} activeDot={{ r: 5, fill: NAVY, stroke: '#fff', strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Department Breakdown" subtitle="Staff by department">
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], marginTop: 6 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <PieChart width={148} height={148}>
                <Pie data={data.dept_breakdown} cx={72} cy={72} innerRadius={42} outerRadius={66}
                  dataKey="count" nameKey="dept" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                  {data.dept_breakdown.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<Tip fmt={(v: number) => `${v} employees`} />} />
              </PieChart>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(data.headcount)}</div>
                <div style={{ fontSize: 9, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>employees</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {data.dept_breakdown.map((dept, i) => {
                const pct = Math.round((dept.count / totalDept) * 100)
                const color = DONUT_COLORS[i % DONUT_COLORS.length]
                return (
                  <div key={dept.dept}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dept.dept}</span>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{dept.count}</span>
                    </div>
                    <div style={{ height: 3, background: 'var(--bdr)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Leaves summary */}
      <SectionCard title="Leave Summary">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[5], padding: '4px 0' }}>
          <div style={{ padding: '14px 0', borderLeft: `3px solid ${AMBER}`, paddingLeft: SP[4] }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Pending Approval</div>
            <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: data.leaves_pending > 5 ? AMBER : 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(data.leaves_pending)}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 4 }}>require manager action</div>
          </div>
          <div style={{ padding: '14px 0', borderLeft: `3px solid ${BLUE}`, paddingLeft: SP[4] }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Currently on Leave</div>
            <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(data.leaves_active)}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 4 }}>employees absent today</div>
          </div>
          <div style={{ padding: '14px 0', borderLeft: `3px solid ${GREEN}`, paddingLeft: SP[4] }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Net Active Staff</div>
            <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(data.headcount - data.leaves_active)}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 4 }}>working today</div>
          </div>
        </div>
      </SectionCard>
    </Page>
  )
}
