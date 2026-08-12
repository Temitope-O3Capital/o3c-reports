import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecFD {
  fd_book_kobo: number
  fd_count: number
  accrued_interest_kobo: number
  avg_rate_pct: number
  maturing_30d: number
  maturing_90d: number
  maturity_ladder: { month: string; payout_kobo: number }[]
  product_breakdown: { product: string; count: number; principal_kobo: number }[]
  tenor_breakdown: { bucket: string; count: number; principal_kobo: number }[]
  top_deposits: { account: string; product: string; principal_kobo: number; rate: number; maturity: string }[]
  // A deposit book is funding, so these two answer what it costs and how exposed the
  // book is if the largest depositors leave.
  cost_of_funds_monthly_kobo?: number
  top10_share_pct?: number
  top10_value_kobo?: number
}

const DONUT_COLORS = [NAVY, AMBER, GREEN, PURPLE, BLUE, RED]

function Tip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: NAVY, borderRadius: RADIUS.lg, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{fmt ? fmt(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function ExecFixedDeposits() {
  const [data, setData] = useState<ExecFD | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecFD }>('/api/executive/fixed-deposits')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const title = 'Fixed Deposits — Executive View'
  const back = { label: 'Executive Overview', to: '/' }

  if (loading) return (
    <Page title={title} back={back}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title={title} back={back}>
      <ErrBanner error={error} onRetry={() => load()} />
    </Page>
  )
  if (!data) return null

  const totalPrincipal = data.product_breakdown.reduce((s, p) => s + p.principal_kobo, 0) || 1
  const maxTenor = Math.max(1, ...data.tenor_breakdown.map(t => t.principal_kobo))

  return (
    <Page title={title} back={back}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Total FD Book"     value={fmtKobo(data.fd_book_kobo)}           sub={`${fmtNum(data.fd_count)} active deposits`}     icon="savings"          accent={AMBER} />
        <KpiCard label="Accrued Interest"  value={fmtKobo(data.accrued_interest_kobo)}  sub="payable at maturity"                            icon="trending_up"      accent={GREEN} />
        <KpiCard label="Avg Rate"          value={fmtPct(data.avg_rate_pct)}            sub="weighted book rate"                             icon="percent"          accent={NAVY} />
        <KpiCard label="Maturing 30 Days"  value={fmtNum(data.maturing_30d)}            sub={`${fmtNum(data.maturing_90d)} within 90d`}      icon="event"            accent={data.maturing_30d > 10 ? RED : BLUE} />
      </div>

      {/* Funding cost and concentration — the two questions a deposit book raises. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard
          label="Cost of Funds / Month"
          value={data.cost_of_funds_monthly_kobo != null ? fmtKobo(data.cost_of_funds_monthly_kobo) : '—'}
          sub="interest accruing to depositors"
          icon="payments" accent={AMBER}
        />
        <KpiCard
          label="Top 10 Depositors"
          value={data.top10_share_pct != null ? fmtPct(data.top10_share_pct) : '—'}
          sub={data.top10_value_kobo != null ? `${fmtKobo(data.top10_value_kobo)} of the book` : 'concentration'}
          icon="donut_large"
          accent={(data.top10_share_pct ?? 0) > 30 ? RED : GREEN}
        />
      </div>

      {/* Maturity ladder + Product mix */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Maturity Ladder" subtitle="Expected payouts (principal + accrued) per month — next 12 months">
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={data.maturity_ladder} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                <linearGradient id="gradFdLadder" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={AMBER} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={AMBER} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
                tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={fmtKobo} />} />
              <Area type="monotone" dataKey="payout_kobo" name="Payout" stroke={AMBER} strokeWidth={2.2} fill="url(#gradFdLadder)"
                dot={{ r: 3, fill: AMBER, strokeWidth: 0 }} activeDot={{ r: 5, fill: AMBER, stroke: '#fff', strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Book by Product" subtitle="Active deposits by principal">
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], marginTop: 6 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <PieChart width={148} height={148}>
                <Pie data={data.product_breakdown} cx={72} cy={72} innerRadius={42} outerRadius={66}
                  dataKey="principal_kobo" stroke="none" paddingAngle={3} startAngle={90} endAngle={-270}>
                  {data.product_breakdown.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<Tip fmt={fmtKobo} />} />
              </PieChart>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1.1 }}>{fmtKobo(totalPrincipal)}</div>
                <div style={{ fontSize: 9, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>total book</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {data.product_breakdown.map((p, i) => {
                const pct = Math.round((p.principal_kobo / totalPrincipal) * 100)
                const color = DONUT_COLORS[i % DONUT_COLORS.length]
                return (
                  <div key={p.product}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.product}</span>
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

      {/* Tenor mix + Top deposits */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: SP[3] }}>
        <SectionCard title="Tenor Mix" subtitle="Active book by term">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
            {data.tenor_breakdown.map((t, i) => {
              const color = DONUT_COLORS[i % DONUT_COLORS.length]
              const pct = Math.round((t.principal_kobo / maxTenor) * 100)
              return (
                <div key={t.bucket}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium }}>{t.bucket}</span>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{fmtKobo(t.principal_kobo)}</span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, ...NUM, minWidth: 34, textAlign: 'right' }}>{fmtNum(t.count)}</span>
                  </div>
                  <div style={{ height: 5, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 99 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>

        <SectionCard title="Largest Deposits" subtitle="Top 10 active by principal">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bdr)' }}>
                  {['Account', 'Product', 'Principal', 'Rate', 'Maturity'].map((h, i) => (
                    <th key={h} style={{ textAlign: i > 1 ? 'right' : 'left', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 10px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.top_deposits.map((d, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, ...NUM, padding: '8px 10px' }}>{d.account}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: SORA, padding: '8px 10px' }}>{d.product}</td>
                    <td style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM, padding: '8px 10px', textAlign: 'right' }}>{fmtKobo(d.principal_kobo)}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, ...NUM, padding: '8px 10px', textAlign: 'right' }}>{fmtPct(d.rate)}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, ...NUM, padding: '8px 10px', textAlign: 'right' }}>{d.maturity}</td>
                  </tr>
                ))}
                {data.top_deposits.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: 'var(--txt3)', fontSize: TEXT.sm, fontFamily: INTER }}>No active deposits</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
