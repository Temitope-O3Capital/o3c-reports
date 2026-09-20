import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { EArea, EBar } from '../../components/echarts'
import { fmtUsdCents } from '../../lib/currency'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InterswitchSummary {
  report_date: string
  total_volume_kobo: number
  total_count: number
  channel_breakdown: { channel: string; volume_kobo: number; count: number; pct: number }[]
  product_breakdown: { product: string; volume_kobo: number; count: number }[]
  txn_type_breakdown: { type: string; count: number; volume_kobo: number }[]
  daily_trend: { date: string; atm: number; pos: number; web: number; bills: number; repayment: number; fees: number }[]
  top_merchants: { name: string; volume_kobo: number; count: number }[]
  // Dollar cards, in cents. CCS posts them in US dollars, so every figure above
  // is naira cards only and these are reported on their own.
  usd_count?: number
  usd_volume_cents?: number
  usd_channel_breakdown?: { channel: string; volume_cents: number; count: number }[]
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

// Keys are the channel label upper-cased (see the lookup below). The labels come
// from app.card_txn_codes.category via iswChannelCase — they used to be
// ATM/POS/WEB/Transfer, a classification that matched no code in this feed and
// reported everything as Transfer.
const CH_COLOR: Record<string, string> = {
  'ATM / CASH': NAVY,
  'POS / PURCHASE': BLUE,
  'WEB TRANSFER': AMBER,
  'BILL PAYMENT': GREEN,
  'REPAYMENT': PURPLE,
  'FEES & INTEREST': RED,
  'OTHER': '#94A3B8',
}

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

export default function Interswitch() {
  const [data, setData] = useState<InterswitchSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<any>(`/api/cards/interswitch/summary?period=${p}`)
      const d = r?.data ?? r ?? {}
      setData({ ...d,
        product_breakdown:  d.product_breakdown ?? [],
        txn_type_breakdown: d.txn_type_breakdown ?? [],
        daily_trend:        d.daily_trend ?? [],
        top_merchants:      d.top_merchants ?? [],
      })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Interswitch: Card Activity'
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
        <KpiCard label="Total Volume (₦)"       value={fmtKoboExact(data.total_volume_kobo)} icon="swap_horiz"    accent={NAVY}  />
        <KpiCard label="Total Transactions" value={fmtNum(data.total_count)}         icon="receipt_long"  accent={BLUE}  />
        <KpiCard label="Avg Transaction"    value={fmtKoboExact(avgTxn)}                  icon="bar_chart"     accent={AMBER} />
        <KpiCard label="Products Active"    value={fmtNum(productsActive)}            icon="credit_card"   accent={GREEN} />
      </div>

      {(data.usd_count ?? 0) > 0 && (
        <SectionCard title="USD Cards" subtitle="Posted by CCS in US dollars, so kept out of every naira figure on this page" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div>
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1.1 }}>{fmtUsdCents(data.usd_volume_cents ?? 0)}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>{fmtNum(data.usd_count ?? 0)} transactions</div>
            </div>
            <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {(data.usd_channel_breakdown ?? []).map(ch => (
                <div key={ch.channel} style={{ display: 'flex', justifyContent: 'space-between', gap: SP[3], fontSize: TEXT.sm, fontFamily: INTER }}>
                  <span style={{ color: 'var(--txt)' }}>{ch.channel}</span>
                  <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtUsdCents(ch.volume_cents)} · {fmtNum(ch.count)} txns</span>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      )}

      {/* Channel breakdown bar chart */}
      <SectionCard title="Channel Breakdown" subtitle="Volume by what the customer did — cash, purchase, transfer, bills, repayment, charges" style={{ marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[6], alignItems: 'center' }}>
          <EBar
            data={data.channel_breakdown}
            xKey="channel"
            series={[{ key: 'volume_kobo', name: 'Volume', color: NAVY, colorFn: (e) => CH_COLOR[e.channel.toUpperCase()] ?? NAVY }]}
            height={200}
            valueFmt={(v) => fmtKoboExact(v)}
            axisFmt={(v) => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
            legend={false}
          />
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
                    <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKoboExact(ch.volume_kobo)}</div>
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
        <EArea
          data={data.daily_trend}
          xKey="date"
          series={[
            { key: 'atm', name: 'ATM / Cash', color: NAVY },
            { key: 'pos', name: 'POS / Purchase', color: BLUE },
            { key: 'web', name: 'Web Transfer', color: AMBER },
            { key: 'bills', name: 'Bill Payment', color: GREEN },
            { key: 'repayment', name: 'Repayment', color: PURPLE },
            { key: 'fees', name: 'Fees & Interest', color: RED },
          ]}
          height={220}
          stack
          endLabel
          endFmt={(v) => fmtKobo(v)}
          valueFmt={(v) => fmtKoboExact(v)}
        />
      </SectionCard>

      {/* Product breakdown + Transaction type */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Product Breakdown" subtitle="Naira card volume by product">
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
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKoboExact(p.volume_kobo)}</td>
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
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKoboExact(t.volume_kobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      {/* Top merchants */}
      <SectionCard title="Top Merchants" subtitle="Card purchases on naira cards, by volume">
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
                <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKoboExact(m.volume_kobo)}</td>
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
