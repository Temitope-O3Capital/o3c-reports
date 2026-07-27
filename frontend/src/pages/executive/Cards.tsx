import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecCards {
  total_cards: number
  active_cards: number
  activation_rate_pct: number
  credit_book_kobo: number
  prepaid_ngn_balance_kobo: number
  prepaid_usd_balance_cents: number
  disputes_open: number
  disputes_resolved_mtd: number
  txn_volume_kobo: number
  txn_count: number
  txn_change_pct: number
  channel_mix: { channel: string; volume_kobo: number; count: number }[]
  monthly_trend: { month: string; atm: number; pos: number; web: number; transfer: number }[]
  top_merchants: { name: string; volume_kobo: number; count: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

const CH_COLOR: Record<string, string> = { ATM: NAVY, POS: BLUE, WEB: AMBER, TRANSFER: GREEN }

// ── Period filter ─────────────────────────────────────────────────────────────

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

// ── Tooltip ───────────────────────────────────────────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ExecCards() {
  const [data, setData] = useState<ExecCards | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecCards }>(`/api/executive/cards?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Cards — Executive View'
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

  const totalMerchantVol = data.top_merchants.reduce((s, m) => s + m.volume_kobo, 0) || 1

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Active Cards"        value={fmtNum(data.active_cards)}      icon="credit_card"       accent={NAVY}  />
        <KpiCard label="Transaction Volume"  value={fmtKobo(data.txn_volume_kobo)}  change={data.txn_change_pct} icon="swap_horiz" accent={BLUE}  />
        <KpiCard label="Credit Book"         value={fmtKobo(data.credit_book_kobo)} icon="account_balance"   accent={GREEN} />
        <KpiCard label="Activation Rate"     value={fmtPct(data.activation_rate_pct)} icon="trending_up"    accent={AMBER} />
      </div>

      {/* Channel mix + Monthly trend */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Channel Mix" subtitle="By transaction volume">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.channel_mix} margin={{ top: 4, right: 8, bottom: 14, left: 8 }} layout="vertical">
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
              <XAxis type="number" tickFormatter={v => fmtKobo(v)} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="channel" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} width={70} />
              <Tooltip content={<Tip fmt={fmtKobo} />} />
              <Bar dataKey="volume_kobo" name="Volume" radius={[0, 4, 4, 0]}
                fill={NAVY}
                label={false}
              >
                {data.channel_mix.map((entry, i) => (
                  <rect key={i} fill={CH_COLOR[entry.channel.toUpperCase()] ?? NAVY} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div style={{ display: 'flex', gap: SP[3], flexWrap: 'wrap', marginTop: 6 }}>
            {Object.entries(CH_COLOR).map(([ch, c]) => (
              <div key={ch} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: c }} />{ch}
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Monthly Trend" subtitle="Transaction volume by channel">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.monthly_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                {[['atm', NAVY], ['pos', BLUE], ['web', AMBER], ['transfer', GREEN]].map(([k, c]) => (
                  <linearGradient key={k} id={`grad_${k}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={c} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={70} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
                tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={fmtKobo} />} />
              {[['atm', 'ATM', NAVY], ['pos', 'POS', BLUE], ['web', 'WEB', AMBER], ['transfer', 'Transfer', GREEN]].map(([k, label, c]) => (
                <Area key={k} type="monotone" dataKey={k} name={label} stroke={c} strokeWidth={2} fill={`url(#grad_${k})`}
                  dot={{ r: 2, fill: c, strokeWidth: 0 }} activeDot={{ r: 4, fill: c, stroke: '#fff', strokeWidth: 2 }} stackId="1" />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>

      {/* Top merchants + Disputes */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: SP[3] }}>
        <SectionCard title="Top Merchants" subtitle="By transaction volume this period">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Merchant', 'Volume', 'Transactions', '% of Total'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Merchant' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.top_merchants.slice(0, 5).map((m, i) => (
                <tr key={m.name} style={{ borderBottom: '1px solid var(--bdr)' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                  <td style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 28, height: 28, borderRadius: RADIUS.md, background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY, fontFamily: INTER, flexShrink: 0 }}>{i + 1}</div>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{m.name}</span>
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(m.volume_kobo)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(m.count)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtPct((m.volume_kobo / totalMerchantVol) * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Disputes">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Open</div>
              <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: data.disputes_open > 5 ? RED : 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtNum(data.disputes_open)}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 4 }}>require resolution</div>
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Resolved MTD</div>
              <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: GREEN, fontFamily: INTER, lineHeight: 1 }}>{fmtNum(data.disputes_resolved_mtd)}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 4 }}>closed this month</div>
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                Total transactions: <span style={{ ...NUM, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(data.txn_count)}</span>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
