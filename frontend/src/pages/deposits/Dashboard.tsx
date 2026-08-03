import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell,
} from 'recharts'
import { Page, KpiCard, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { NAVY, BLUE, AMBER, GREEN, RED, PURPLE, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ───────────────────────────────────────────────────────────────────────

interface FDKpis {
  total_principal_kobo: number
  total_ledger_kobo: number
  total_accrued_interest_kobo: number
  active_count: number
  unique_customers: number
  weighted_avg_rate: number
  weighted_avg_tenor_days: number
  annualized_interest_expense_kobo: number
  maturing_30d_count: number
  maturing_30d_kobo: number
  new_this_month_count: number
}
interface LadderRow { bucket: string; count: number; principal_kobo: number; accrued_interest_kobo: number }
interface TrendRow  { date: string; active_count: number; principal_kobo: number; ledger_kobo: number }
interface ProductRow { product: string; count: number; principal_kobo: number; accrued_interest_kobo: number; avg_rate: number; annual_interest_kobo: number }
interface TenorRow  { bucket: string; count: number; principal_kobo: number }

const LADDER_COLORS: Record<string, string> = {
  'Overdue': RED, '0–30d': AMBER, '31–60d': BLUE, '61–90d': BLUE,
  '91–180d': NAVY, '181–365d': PURPLE, '365d+': GREEN,
}

function Tip({ active, payload, label, money }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: NAVY, borderRadius: RADIUS.lg, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)' }}>
      {label && <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.5)', fontFamily: INTER, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 4 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff' }} />
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{money ? fmtKobo(p.value) : fmtNum(p.value)}</span>
          {p.name && payload.length > 1 && <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.5)', fontFamily: INTER }}>{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

export default function DepositsDashboard() {
  const [kpis, setKpis] = useState<FDKpis | null>(null)
  const [ladder, setLadder] = useState<LadderRow[]>([])
  const [trend, setTrend] = useState<TrendRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [tenor, setTenor] = useState<TenorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [k, l, t, p, tn] = await Promise.all([
        apiFetch<any>('/api/fd-book/kpis'),
        apiFetch<any>('/api/fd-book/maturity-ladder'),
        apiFetch<any>('/api/fd-book/book-trend'),
        apiFetch<any>('/api/fd-book/by-product'),
        apiFetch<any>('/api/fd-book/tenor-distribution'),
      ])
      setKpis(k?.data ?? k)
      setLadder(Array.isArray(l) ? l : (l?.data ?? []))
      setTrend(Array.isArray(t) ? t : (t?.data ?? []))
      setProducts(Array.isArray(p) ? p : (p?.data ?? []))
      setTenor(Array.isArray(tn) ? tn : (tn?.data ?? []))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['fixed_deposits', 'finance'] })

  const totalProdPrincipal = products.reduce((s, p) => s + p.principal_kobo, 0) || 1

  return (
    <Page title="Fixed Deposits" subtitle="Deposit book, maturities and cost of funds — live from core banking (Udara)">
      <ErrBanner error={error} onRetry={load} />

      {loading && !kpis ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <>
          {/* Headline KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
            <KpiCard label="Deposit Book" value={fmtKobo(kpis?.total_ledger_kobo ?? 0)} icon="savings" accent={NAVY} sub={`${fmtNum(kpis?.active_count ?? 0)} active`} />
            <KpiCard label="Accrued Interest" value={fmtKobo(kpis?.total_accrued_interest_kobo ?? 0)} icon="trending_up" accent={AMBER} />
            <KpiCard label="Weighted Avg Rate" value={`${(kpis?.weighted_avg_rate ?? 0).toFixed(2)}%`} icon="percent" accent={GREEN} sub={`${Math.round(kpis?.weighted_avg_tenor_days ?? 0)}d avg tenor`} />
            <KpiCard label="Annual Interest Expense" value={fmtKobo(kpis?.annualized_interest_expense_kobo ?? 0)} icon="account_balance_wallet" accent={RED} sub="cost of funds (run-rate)" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
            <KpiCard label="Principal Book" value={fmtKobo(kpis?.total_principal_kobo ?? 0)} icon="account_balance" accent={BLUE} />
            <KpiCard label="Unique Depositors" value={fmtNum(kpis?.unique_customers ?? 0)} icon="group" accent={PURPLE} />
            <KpiCard label="Maturing in 30d" value={fmtKobo(kpis?.maturing_30d_kobo ?? 0)} icon="event" accent={AMBER} sub={`${fmtNum(kpis?.maturing_30d_count ?? 0)} deposits`} />
            <KpiCard label="New This Month" value={fmtNum(kpis?.new_this_month_count ?? 0)} icon="add_circle" accent={GREEN} />
          </div>

          {/* Maturity ladder */}
          <SectionCard title="Maturity Ladder" subtitle="Active principal by time-to-maturity" style={{ marginBottom: 14 }}>
            {ladder.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={ladder} margin={{ top: 4, right: 8, bottom: 10, left: 8 }} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
                  <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                  <Tooltip content={<Tip money />} cursor={{ fill: 'var(--row-hvr)' }} />
                  <Bar dataKey="principal_kobo" name="Principal" radius={[5, 5, 0, 0]}>
                    {ladder.map((e, i) => <Cell key={i} fill={LADDER_COLORS[e.bucket] ?? NAVY} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <Empty />}
          </SectionCard>

          {/* Book trend */}
          <SectionCard title="Deposit Book Trend" subtitle="Book size over time (daily snapshot)" style={{ marginBottom: 14 }}>
            {trend.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 10, left: 8 }}>
                  <defs>
                    <linearGradient id="fdBook" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={NAVY} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={NAVY} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
                  <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                  <Tooltip content={<Tip money />} />
                  <Area type="monotone" dataKey="ledger_kobo" name="Book" stroke={NAVY} strokeWidth={2} fill="url(#fdBook)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <Empty text="No snapshot history yet — the book trend fills in one point per day." />}
          </SectionCard>

          {/* By product + tenor */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: SP[3] }}>
            <SectionCard title="By Product" subtitle="Active book, weighted rate & annual interest">
              {products.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--th-bg)' }}>
                      {['Product', 'Deposits', 'Principal', 'Avg Rate', '% Book'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Product' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p, i) => {
                      const colors = [NAVY, BLUE, AMBER, GREEN, RED, PURPLE]
                      const color = colors[i % colors.length]
                      const pct = ((p.principal_kobo / totalProdPrincipal) * 100).toFixed(1)
                      return (
                        <tr key={p.product} style={{ borderBottom: '1px solid var(--bdr)' }}>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                              <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{p.product}</span>
                            </div>
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(p.count)}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.principal_kobo)}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{Number(p.avg_rate).toFixed(2)}%</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{pct}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : <Empty />}
            </SectionCard>

            <SectionCard title="Tenor Distribution" subtitle="Active principal by original tenor">
              {tenor.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={tenor} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                    <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} />
                    <XAxis type="number" tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="bucket" type="category" width={72} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={<Tip money />} cursor={{ fill: 'var(--row-hvr)' }} />
                    <Bar dataKey="principal_kobo" name="Principal" fill={BLUE} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <Empty />}
            </SectionCard>
          </div>
        </>
      )}
    </Page>
  )
}

function Empty({ text = 'No data' }: { text?: string }) {
  return <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: TEXT.base, fontFamily: INTER }}>{text}</div>
}
