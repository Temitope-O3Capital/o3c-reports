import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecFinance {
  total_revenue_kobo: number
  revenue_change_pct: number
  total_cost_kobo: number
  cost_change_pct: number
  net_income_kobo: number
  net_margin_pct: number
  fd_book_kobo: number
  fd_count: number
  fd_maturing_30d: number
  settlement_balance_kobo: number
  paystack_wallet_kobo: number
  monthly_pnl: { month: string; revenue: number; cost: number; net: number }[]
  revenue_breakdown: { source: string; amount_kobo: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

const DONUT_COLORS = [NAVY, RED, AMBER, GREEN, PURPLE, BLUE]

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

export default function ExecFinance() {
  const [data, setData] = useState<ExecFinance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecFinance }>(`/api/executive/finance?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Finance — Executive View'
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

  const totalRevBreakdown = data.revenue_breakdown.reduce((s, r) => s + r.amount_kobo, 0) || 1

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Revenue MTD"          value={fmtKobo(data.total_revenue_kobo)} change={data.revenue_change_pct} icon="trending_up"       accent={GREEN} />
        <KpiCard label="Net Income"           value={fmtKobo(data.net_income_kobo)}    sub={`${data.net_margin_pct.toFixed(1)}% margin`}         icon="savings"           accent={NAVY} />
        <KpiCard label="FD Book"              value={fmtKobo(data.fd_book_kobo)}        sub={`${fmtNum(data.fd_count)} active`}                  icon="account_balance"   accent={AMBER} />
        <KpiCard label="Settlement Balance"   value={fmtKobo(data.settlement_balance_kobo)}                                                      icon="payments"          accent={BLUE} />
      </div>

      {/* P&L trend + Revenue breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="P&L Trend" subtitle="Revenue vs Cost with net income">
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={data.monthly_pnl} margin={{ top: 4, right: 8, bottom: 14, left: 8 }} barCategoryGap="28%" barGap={3}>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
                tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={fmtKobo} />} />
              <Bar dataKey="revenue" name="Revenue" fill={GREEN}  radius={[3, 3, 0, 0]} />
              <Bar dataKey="cost"    name="Cost"    fill={`${RED}99`} radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="net" name="Net" stroke={NAVY} strokeWidth={2.5}
                dot={{ r: 3, fill: NAVY, strokeWidth: 0 }} activeDot={{ r: 5, fill: NAVY, stroke: '#fff', strokeWidth: 2 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Revenue Breakdown" subtitle="By source">
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], marginTop: 6 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <PieChart width={148} height={148}>
                <Pie data={data.revenue_breakdown} cx={72} cy={72} innerRadius={42} outerRadius={66}
                  dataKey="amount_kobo" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                  {data.revenue_breakdown.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<Tip fmt={fmtKobo} />} />
              </PieChart>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', fontFamily: INTER }}>TOTAL</div>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1.1 }}>{fmtKobo(totalRevBreakdown)}</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {data.revenue_breakdown.map((rb, i) => {
                const pct = Math.round((rb.amount_kobo / totalRevBreakdown) * 100)
                const color = DONUT_COLORS[i % DONUT_COLORS.length]
                return (
                  <div key={rb.source}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rb.source}</span>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{pct}%</span>
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

      {/* FD Summary */}
      <SectionCard title="Fixed Deposits Summary">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[5], padding: '4px 0' }}>
          {[
            { label: 'Total FD Book', value: fmtKobo(data.fd_book_kobo), accent: AMBER },
            { label: 'Active Deposits', value: fmtNum(data.fd_count), accent: GREEN },
            { label: 'Maturing in 30 Days', value: fmtNum(data.fd_maturing_30d), accent: data.fd_maturing_30d > 10 ? RED : AMBER },
            { label: 'Paystack Wallet', value: fmtKobo(data.paystack_wallet_kobo), accent: BLUE },
          ].map(({ label, value, accent }) => (
            <div key={label} style={{ padding: '14px 0', borderLeft: `3px solid ${accent}`, paddingLeft: SP[4] }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{value}</div>
            </div>
          ))}
        </div>
      </SectionCard>
    </Page>
  )
}
