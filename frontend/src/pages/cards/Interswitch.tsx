import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InterswitchSummary {
  report_date: string
  total_volume_kobo: number
  total_count: number
  channel_breakdown: { channel: string; volume_kobo: number; count: number; pct: number }[]
  product_breakdown: { product: string; volume_kobo: number; count: number }[]
  txn_type_breakdown: { type: string; count: number; volume_kobo: number }[]
  daily_trend: { date: string; atm: number; pos: number; web: number; transfer: number }[]
  top_merchants: { name: string; volume_kobo: number; count: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

const CH_COLOR: Record<string, string> = { ATM: NAVY, POS: BLUE, WEB: AMBER, TRANSFER: GREEN }

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

export default function Interswitch() {
  const [data, setData] = useState<InterswitchSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: InterswitchSummary }>(`/api/cards/interswitch/summary?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Interswitch — Card Activity'
  const back = { label: 'Cards', to: '/cards' }
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

  const avgTxn = data.total_count > 0 ? data.total_volume_kobo / data.total_count : 0
  const productsActive = data.product_breakdown.filter(p => p.count > 0).length
  const totalMerchantVol = data.top_merchants.reduce((s, m) => s + m.volume_kobo, 0) || 1
  const totalProdVol = data.product_breakdown.reduce((s, p) => s + p.volume_kobo, 0) || 1

  return (
    <Page
      title={title}
      subtitle={data.report_date ? `Report date: ${data.report_date}` : undefined}
      back={back}
      actions={actions}
    >
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Total Volume"       value={fmtKobo(data.total_volume_kobo)} icon="swap_horiz"    accent={NAVY}  />
        <KpiCard label="Total Transactions" value={fmtNum(data.total_count)}         icon="receipt_long"  accent={BLUE}  />
        <KpiCard label="Avg Transaction"    value={fmtKobo(avgTxn)}                  icon="bar_chart"     accent={AMBER} />
        <KpiCard label="Products Active"    value={fmtNum(productsActive)}            icon="credit_card"   accent={GREEN} />
      </div>

      {/* Channel breakdown bar chart */}
      <SectionCard title="Channel Breakdown" subtitle="Transaction volume by channel (ATM / POS / WEB / Transfer)" style={{ marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[6], alignItems: 'center' }}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.channel_breakdown} margin={{ top: 4, right: 8, bottom: 14, left: 8 }} barCategoryGap="35%">
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="channel" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
                tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={fmtKobo} />} />
              <Bar dataKey="volume_kobo" name="Volume" radius={[5, 5, 0, 0]}>
                {data.channel_breakdown.map((entry, i) => (
                  <rect key={i} fill={CH_COLOR[entry.channel.toUpperCase()] ?? NAVY} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
            {data.channel_breakdown.map(ch => {
              const color = CH_COLOR[ch.channel.toUpperCase()] ?? NAVY
              return (
                <div key={ch.channel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${SP[2]} ${SP[3]}`, background: `${color}0A`, borderRadius: RADIUS.md, border: `1px solid ${color}18` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{ch.channel}</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(ch.volume_kobo)}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{ch.pct.toFixed(1)}% · {fmtNum(ch.count)} txns</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </SectionCard>

      {/* Daily trend stacked area */}
      <SectionCard title="Daily Trend" subtitle="Stacked volume by channel" style={{ marginBottom: 14 }} actions={
        <div style={{ display: 'flex', gap: SP[3] }}>
          {Object.entries(CH_COLOR).map(([ch, c]) => (
            <div key={ch} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
              <div style={{ width: 10, height: 3, borderRadius: 2, background: c }} />{ch}
            </div>
          ))}
        </div>
      }>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data.daily_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
            <defs>
              {[['atm', NAVY], ['pos', BLUE], ['web', AMBER], ['transfer', GREEN]].map(([k, c]) => (
                <linearGradient key={k} id={`isw_${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={c} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
            <XAxis dataKey="date" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
              tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
            <Tooltip content={<Tip fmt={fmtKobo} />} />
            {([['atm', 'ATM', NAVY], ['pos', 'POS', BLUE], ['web', 'WEB', AMBER], ['transfer', 'Transfer', GREEN]] as [string, string, string][]).map(([k, label, c]) => (
              <Area key={k} type="monotone" dataKey={k} name={label} stroke={c} strokeWidth={1.8} fill={`url(#isw_${k})`}
                dot={false} activeDot={{ r: 4, fill: c, stroke: '#fff', strokeWidth: 2 }} stackId="1" />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>

      {/* Product breakdown + Transaction type */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Product Breakdown" subtitle="Volume by card product">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Product', 'Volume', 'Transactions', '% Share'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Product' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.product_breakdown.map((p, i) => {
                const colors = [NAVY, BLUE, AMBER, GREEN, RED, PURPLE]
                const color = colors[i % colors.length]
                const pct = ((p.volume_kobo / totalProdVol) * 100).toFixed(1)
                return (
                  <tr key={p.product} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{p.product}</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.volume_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(p.count)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{pct}%</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Transaction Type" subtitle="By transaction category">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Type', 'Count', 'Volume'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Type' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.txn_type_breakdown.map(t => (
                <tr key={t.type} style={{ borderBottom: '1px solid var(--bdr)' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                  <td style={{ padding: '10px 12px', fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{t.type}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(t.count)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(t.volume_kobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      {/* Top merchants */}
      <SectionCard title="Top Merchants" subtitle="By transaction volume">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--th-bg)' }}>
              {['#', 'Merchant', 'Volume', 'Transactions', '% of Total'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: h === '#' || h === 'Merchant' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.top_merchants.slice(0, 10).map((m, i) => (
              <tr key={m.name} style={{ borderBottom: '1px solid var(--bdr)' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                <td style={{ padding: '10px 12px', ...NUM, fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: INTER, width: 36 }}>{i + 1}</td>
                <td style={{ padding: '10px 12px', fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{m.name}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(m.volume_kobo)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(m.count)}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{((m.volume_kobo / totalMerchantVol) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </Page>
  )
}
