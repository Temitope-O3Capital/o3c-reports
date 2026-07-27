import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecRisk {
  portfolio_outstanding_kobo: number
  npl_rate_pct: number
  concentration_top10_pct: number
  avg_loan_size_kobo: number
  new_accounts_mtd: number
  churn_rate_pct: number
  dpd_trend: { month: string; par30: number; par60: number; par90: number }[]
  product_concentration: { product: string; outstanding_kobo: number; count: number }[]
  vintage_performance: { vintage: string; par30_rate: number; par90_rate: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

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

export default function ExecRisk() {
  const [data, setData] = useState<ExecRisk | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecRisk }>(`/api/executive/risk?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Risk — Executive View'
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

  const maxConcentration = data.product_concentration[0]?.outstanding_kobo ?? 1
  const DPD_LEGEND = (
    <div style={{ display: 'flex', gap: SP[3] }}>
      {[{ c: AMBER, l: 'PAR30' }, { c: RED, l: 'PAR60' }, { c: PURPLE, l: 'PAR90' }].map(({ c, l }) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
          <div style={{ width: 10, height: 3, borderRadius: 2, background: c }} />{l}
        </div>
      ))}
    </div>
  )

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Portfolio Outstanding"  value={fmtKobo(data.portfolio_outstanding_kobo)} icon="account_balance_wallet" accent={NAVY} />
        <KpiCard label="NPL Rate"               value={fmtPct(data.npl_rate_pct)}                 icon="warning"               accent={data.npl_rate_pct > 5 ? RED : AMBER} />
        <KpiCard label="Top-10 Concentration"   value={fmtPct(data.concentration_top10_pct)}      icon="donut_large"           accent={data.concentration_top10_pct > 30 ? RED : BLUE} />
        <KpiCard label="Avg Loan Size"          value={fmtKobo(data.avg_loan_size_kobo)}          icon="payments"              accent={GREEN} />
      </div>

      {/* DPD trend + Product concentration */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="DPD Trend" subtitle="PAR30 / PAR60 / PAR90 last 12 months" actions={DPD_LEGEND}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.dpd_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }} barCategoryGap="30%" barGap={3}>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={36} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={(v: number) => `${v} accounts`} />} />
              <Bar dataKey="par30" name="PAR30 (1–30d)"  fill={AMBER}  radius={[3, 3, 0, 0]} />
              <Bar dataKey="par60" name="PAR60 (31–60d)" fill={RED}    radius={[3, 3, 0, 0]} />
              <Bar dataKey="par90" name="PAR90 (60d+)"   fill={PURPLE} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Product Concentration" subtitle="Portfolio by outstanding balance">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
            {data.product_concentration.map((p, i) => {
              const colors = [NAVY, BLUE, AMBER, GREEN, RED, PURPLE]
              const color = colors[i % colors.length]
              const pct = Math.round((p.outstanding_kobo / maxConcentration) * 100)
              return (
                <div key={p.product}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{p.product}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.outstanding_kobo)}</span>
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginLeft: 6 }}>{fmtNum(p.count)}</span>
                    </div>
                  </div>
                  <div style={{ height: 6, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 99 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>
      </div>

      {/* Vintage analysis */}
      <SectionCard title="Vintage Performance" subtitle="PAR30 and PAR90 rates by origination cohort">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Vintage', 'PAR30 Rate', 'PAR90 Rate', 'Health'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Vintage' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.vintage_performance.map(v => {
                const health = v.par90_rate < 2 ? { label: 'Good', color: GREEN } : v.par90_rate < 5 ? { label: 'Watch', color: AMBER } : { label: 'Stressed', color: RED }
                return (
                  <tr key={v.vintage} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={{ padding: '10px 12px', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{v.vintage}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: v.par30_rate > 5 ? AMBER : 'var(--txt)', fontFamily: INTER }}>{fmtPct(v.par30_rate)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: v.par90_rate > 5 ? RED : 'var(--txt)', fontFamily: INTER }}>{fmtPct(v.par90_rate)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: INTER, padding: '2px 9px', borderRadius: 99, background: `${health.color}15`, color: health.color, border: `1px solid ${health.color}25` }}>
                        {health.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </Page>
  )
}
