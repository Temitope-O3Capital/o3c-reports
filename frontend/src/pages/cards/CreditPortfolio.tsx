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

interface CCKpis {
  cycle_date: string | null
  accounts: number
  total_receivables_kobo: number
  total_credit_limit_kobo: number
  utilization_pct: number
  interest_income_kobo: number
  min_payment_due_kobo: number
  overdue_kobo: number
  overdue_accounts: number
  over_limit_accounts: number
  delinquency_rate_pct: number
  avg_balance_kobo: number
  purchases_kobo: number
  cash_advance_kobo: number
}
interface UtilRow { bucket: string; count: number; outstanding_kobo: number }
interface TrendRow { cycle_date: string; interest_kobo?: number; fees_kobo?: number; outstanding_kobo?: number; overdue_kobo?: number }
interface ProductRow { product: string; accounts: number; outstanding_kobo: number; credit_limit_kobo: number; interest_kobo: number; overdue_kobo: number; min_payment_kobo: number; utilization_pct: number }

const UTIL_COLORS: Record<string, string> = {
  '0–30%': GREEN, '30–50%': BLUE, '50–80%': AMBER, '80–100%': '#EA580C', 'Over limit': RED, 'No limit': 'var(--chart-lbl)',
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

const back = { label: 'Cards', to: '/cards' }

export default function CreditCardPortfolio() {
  const [kpis, setKpis] = useState<CCKpis | null>(null)
  const [util, setUtil] = useState<UtilRow[]>([])
  const [interest, setInterest] = useState<TrendRow[]>([])
  const [recv, setRecv] = useState<TrendRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    try {
      const [k, u, it, rt, p] = await Promise.all([
        apiFetch<any>('/api/cards-credit/kpis'),
        apiFetch<any>('/api/cards-credit/utilization-distribution'),
        apiFetch<any>('/api/cards-credit/interest-trend'),
        apiFetch<any>('/api/cards-credit/receivables-trend'),
        apiFetch<any>('/api/cards-credit/by-product'),
      ])
      setKpis(k?.data ?? k)
      setUtil(Array.isArray(u) ? u : (u?.data ?? []))
      setInterest(Array.isArray(it) ? it : (it?.data ?? []))
      setRecv(Array.isArray(rt) ? rt : (rt?.data ?? []))
      setProducts(Array.isArray(p) ? p : (p?.data ?? []))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['cards'] })

  const noData = !loading && (!kpis || kpis.accounts === 0)
  const totalProdOutstanding = products.reduce((s, p) => s + p.outstanding_kobo, 0) || 1

  return (
    <Page
      title="Credit Card Portfolio"
      subtitle={kpis?.cycle_date ? `Revolving credit: cycle ${kpis.cycle_date}` : 'Revolving credit-card book, utilization and delinquency'}
      back={back}
    >
      <ErrBanner error={error} onRetry={load} />

      {loading && !kpis ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <>
          {noData && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: SP[3], padding: SP[4], borderRadius: RADIUS.md, background: 'rgba(217,119,6,.08)', border: `1.5px solid ${AMBER}22`, marginBottom: SP[4] }}>
              <span className="material-symbols-rounded" style={{ fontSize: 22, color: AMBER, flexShrink: 0, marginTop: 1 }}>info</span>
              <div>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER, marginBottom: 4, fontFamily: INTER }}>No cycle data ingested yet</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, maxWidth: 620 }}>
                  This dashboard reports revolving-credit economics from imported billing-cycle files
                  (balance, charge, interest and line-of-credit reports). No cycle data has been loaded yet.
                  Metrics will populate once cycle files are imported.
                </div>
              </div>
            </div>
          )}

          {/* Headline KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
            <KpiCard label="Receivables" value={fmtKobo(kpis?.total_receivables_kobo ?? 0)} icon="account_balance_wallet" accent={NAVY} sub={`${fmtNum(kpis?.accounts ?? 0)} accounts`} />
            <KpiCard label="Utilization" value={`${(kpis?.utilization_pct ?? 0).toFixed(1)}%`} icon="donut_large" accent={BLUE} sub={`of ${fmtKobo(kpis?.total_credit_limit_kobo ?? 0)} limit`} />
            <KpiCard label="Interest Income" value={fmtKobo(kpis?.interest_income_kobo ?? 0)} icon="trending_up" accent={GREEN} sub="this cycle" />
            <a href="/cards/at-risk" style={{ textDecoration: 'none', display: 'block' }} title="View at-risk accounts">
              <KpiCard label="Delinquency" value={`${(kpis?.delinquency_rate_pct ?? 0).toFixed(1)}%`} icon="warning" accent={RED} sub={`${fmtNum(kpis?.overdue_accounts ?? 0)} overdue · ${fmtNum(kpis?.over_limit_accounts ?? 0)} over-limit`} />
            </a>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
            <KpiCard label="Min Payment Due" value={fmtKobo(kpis?.min_payment_due_kobo ?? 0)} icon="payments" accent={AMBER} />
            <KpiCard label="Avg Balance" value={fmtKobo(kpis?.avg_balance_kobo ?? 0)} icon="bar_chart" accent={PURPLE} />
            <KpiCard label="Purchases" value={fmtKobo(kpis?.purchases_kobo ?? 0)} icon="shopping_cart" accent={BLUE} sub="this cycle" />
            <KpiCard label="Cash Advance" value={fmtKobo(kpis?.cash_advance_kobo ?? 0)} icon="local_atm" accent={NAVY} sub="this cycle" />
          </div>

          {/* Utilization distribution + Interest trend */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: 14 }}>
            <SectionCard title="Utilization Distribution" subtitle="Accounts by balance / credit-limit ratio">
              {util.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={util} margin={{ top: 4, right: 8, bottom: 10, left: 8 }} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="bucket" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
                    <YAxis width={40} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={<Tip />} cursor={{ fill: 'var(--row-hvr)' }} />
                    <Bar dataKey="count" name="Accounts" radius={[5, 5, 0, 0]}>
                      {util.map((e, i) => <Cell key={i} fill={UTIL_COLORS[e.bucket] ?? NAVY} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <Empty />}
            </SectionCard>

            <SectionCard title="Interest Income Trend" subtitle="Per billing cycle">
              {interest.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={interest} margin={{ top: 4, right: 8, bottom: 10, left: 8 }}>
                    <defs>
                      <linearGradient id="ccInt" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={GREEN} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="cycle_date" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
                    <YAxis width={64} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                    <Tooltip content={<Tip money />} />
                    <Area type="monotone" dataKey="interest_kobo" name="Interest" stroke={GREEN} strokeWidth={2} fill="url(#ccInt)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <Empty />}
            </SectionCard>
          </div>

          {/* Receivables vs overdue trend */}
          <SectionCard title="Receivables & Delinquency Trend" subtitle="Outstanding vs overdue per cycle" style={{ marginBottom: 14 }}>
            {recv.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={recv} margin={{ top: 4, right: 8, bottom: 10, left: 8 }}>
                  <defs>
                    <linearGradient id="ccRecv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={NAVY} stopOpacity={0.2} /><stop offset="100%" stopColor={NAVY} stopOpacity={0} /></linearGradient>
                    <linearGradient id="ccOver" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={RED} stopOpacity={0.25} /><stop offset="100%" stopColor={RED} stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="cycle_date" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
                  <YAxis width={64} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                  <Tooltip content={<Tip money />} />
                  <Area type="monotone" dataKey="outstanding_kobo" name="Outstanding" stroke={NAVY} strokeWidth={2} fill="url(#ccRecv)" dot={false} />
                  <Area type="monotone" dataKey="overdue_kobo" name="Overdue" stroke={RED} strokeWidth={2} fill="url(#ccOver)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <Empty />}
          </SectionCard>

          {/* By product */}
          <SectionCard title="By Product" subtitle="Revolving book by credit-card product (latest cycle)">
            {products.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Product', 'Accounts', 'Receivables', 'Utilization', 'Interest', 'Overdue'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Product' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {products.map((p, i) => {
                    const colors = [NAVY, BLUE, AMBER, GREEN, RED, PURPLE]
                    const color = colors[i % colors.length]
                    return (
                      <tr key={p.product} style={{ borderBottom: '1px solid var(--bdr)' }}>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                            <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{p.product}</span>
                          </div>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(p.accounts)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.outstanding_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{Number(p.utilization_pct).toFixed(1)}%</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(p.interest_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: p.overdue_kobo > 0 ? RED : 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(p.overdue_kobo)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : <Empty />}
          </SectionCard>
        </>
      )}
    </Page>
  )
}

function Empty({ text = 'No data' }: { text?: string }) {
  return <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: TEXT.base, fontFamily: INTER }}>{text}</div>
}
