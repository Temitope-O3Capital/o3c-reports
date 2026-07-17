import { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, TEXT, FW, SP, RADIUS, NUM } from '../../lib/design'
import { Page, SectionCard, Spinner } from '../../components/UI'
import { toast } from 'sonner'

const CURRENCIES = ['USD', 'EUR', 'GBP']
const FLAG: Record<string, string>   = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧' }
const CCY_COLOR: Record<string, string> = { USD: GREEN, EUR: BLUE, GBP: PURPLE }

interface RateLatest {
  currency: string
  buy:      number
  sell:     number
  source:   string
  as_of:    string
  is_stale: boolean
}

interface RateHistory {
  source:     string
  currency:   string
  buy:        number
  sell:       number
  scraped_at: string
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

export default function FXRates() {
  const [latest,       setLatest]       = useState<RateLatest[]>([])
  const [history,      setHistory]      = useState<RateHistory[]>([])
  const [currency,     setCurrency]     = useState('USD')
  const [from,         setFrom]         = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10)
  })
  const [to,           setTo]           = useState(() => new Date().toISOString().slice(0, 10))
  const [loadingLatest, setLoadingLatest] = useState(true)
  const [loadingHist,   setLoadingHist]   = useState(false)
  const [refreshing,    setRefreshing]    = useState(false)
  const [, setTick] = useState(0)

  const loadLatest = useCallback(() => {
    setLoadingLatest(true)
    apiFetch('/api/finance/fx-rates/latest')
      .then(d => setLatest(d.rates ?? []))
      .catch(() => toast.error('Failed to load FX rates'))
      .finally(() => setLoadingLatest(false))
  }, [])

  useEffect(() => { loadLatest() }, [loadLatest])

  // Re-render the "X ago" label every minute without re-fetching
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await apiPost<{ inserted: number }>('/api/finance/fx-rates/refresh', {})
      toast.success(`Scraped ${res.inserted} rate${res.inserted !== 1 ? 's' : ''} from NgnRates.com`)
      loadLatest()
    } catch (e: any) {
      toast.error('Refresh failed: ' + (e.message ?? 'unknown error'))
    } finally {
      setRefreshing(false)
    }
  }, [loadLatest])

  const loadHistory = useCallback(() => {
    setLoadingHist(true)
    apiFetch(`/api/finance/fx-rates/history?currency=${currency}&from=${from}&to=${to}`)
      .then(d => setHistory(d.rows ?? []))
      .catch(() => toast.error('Failed to load history'))
      .finally(() => setLoadingHist(false))
  }, [currency, from, to])

  useEffect(() => { loadHistory() }, [loadHistory])

  const chartData = history.map(r => ({
    date: fmtDate(r.scraped_at),
    buy:  +Number(r.buy).toFixed(2),
    sell: +Number(r.sell).toFixed(2),
  }))

  const accentColor = CCY_COLOR[currency] ?? NAVY

  const lastUpdatedLabel = (() => {
    const ts = latest[0]?.as_of
    if (!ts) return null
    const diffMs  = Date.now() - new Date(ts).getTime()
    const diffMin = Math.floor(diffMs / 60_000)
    if (diffMin < 1)  return 'Updated just now'
    if (diffMin < 60) return `Updated ${diffMin} min ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24)  return `Updated ${diffHr} hr ago`
    return `Updated ${Math.floor(diffHr / 24)} days ago`
  })()

  return (
    <Page
      title="FX Parallel Rates"
      subtitle="Indicative Naira parallel-market rates — aggregated BDC quotes, not a licensed FX feed."
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
          {lastUpdatedLabel && (
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>
              {lastUpdatedLabel} · auto-refreshes hourly
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              height: 36, padding: '0 16px', borderRadius: RADIUS.md, border: 'none',
              background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
              cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.65 : 1,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>sync</span>
            {refreshing ? 'Refreshing…' : 'Refresh Now'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[6] }}>

        {/* ── Rate cards ──────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP[5] }}>
          {loadingLatest
            ? CURRENCIES.map(c => <SkeletonCard key={c} accent={CCY_COLOR[c]} />)
            : CURRENCIES.map(c => (
                <RateCard key={c} currency={c} rate={latest.find(x => x.currency === c)} />
              ))
          }
        </div>

        {/* ── History ─────────────────────────────────────────────────── */}
        <SectionCard title="Rate History">

          {/* Toolbar */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[3], marginBottom: SP[5], alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 4, background: 'var(--th-bg)', padding: 4, borderRadius: RADIUS.lg }}>
              {CURRENCIES.map(c => (
                <button
                  key={c}
                  onClick={() => setCurrency(c)}
                  style={{
                    padding: '5px 14px', borderRadius: RADIUS.md, border: 'none', cursor: 'pointer',
                    fontSize: TEXT.sm, fontWeight: FW.semibold,
                    background: currency === c ? 'var(--card)' : 'transparent',
                    color:      currency === c ? CCY_COLOR[c] : 'var(--txt3)',
                    boxShadow:  currency === c ? '0 1px 3px rgba(0,0,0,.10)' : 'none',
                    transition: 'all .12s',
                  }}
                >
                  {FLAG[c]} {c}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={INPUT_S} />
              <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} style={INPUT_S} />
              <button onClick={loadHistory} style={BTN_OUTLINE}>Apply</button>
            </div>
          </div>

          {/* Chart */}
          {loadingHist ? (
            <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spinner />
            </div>
          ) : chartData.length === 0 ? (
            <EmptyHistory onRefresh={handleRefresh} refreshing={refreshing} />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fxGradSell" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={NAVY}        stopOpacity={0.14} />
                      <stop offset="95%" stopColor={NAVY}        stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="fxGradBuy" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={accentColor} stopOpacity={0.12} />
                      <stop offset="95%" stopColor={accentColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--txt3)' }}
                    axisLine={false} tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--txt3)' }}
                    width={86} tickFormatter={v => `₦${fmt(v)}`}
                    domain={['auto', 'auto']} axisLine={false} tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--card)', border: '1px solid var(--bdr)',
                      borderRadius: RADIUS.md, fontSize: 12,
                    }}
                    formatter={(v: number, name: string) => [
                      `₦${fmt(v)}`, name === 'buy' ? 'Buy (you receive)' : 'Sell (you pay)',
                    ]}
                  />
                  <Area type="monotone" dataKey="sell" stroke={NAVY}        strokeWidth={2} fill="url(#fxGradSell)" dot={false} />
                  <Area type="monotone" dataKey="buy"  stroke={accentColor} strokeWidth={2} fill="url(#fxGradBuy)"  dot={false} />
                </AreaChart>
              </ResponsiveContainer>

              {/* Inline legend */}
              <div style={{ display: 'flex', gap: SP[5], marginTop: SP[3] }}>
                {[
                  { color: NAVY,        label: 'Sell — you pay' },
                  { color: accentColor, label: 'Buy — you receive' },
                ].map(({ color, label }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                    <div style={{ width: 22, height: 3, borderRadius: 2, background: color }} />
                    {label}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* History table */}
          {!loadingHist && history.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: SP[6], borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Date / Time', 'Currency', 'Buy (₦)', 'Sell (₦)', 'Spread', 'Source'].map(h => (
                      <th key={h} style={{
                        padding: '8px 12px', textAlign: 'left', fontWeight: FW.semibold,
                        color: 'var(--txt3)', fontSize: TEXT.xs, textTransform: 'uppercase',
                        letterSpacing: '.4px', whiteSpace: 'nowrap',
                        borderBottom: '1px solid var(--bdr)',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().map((r, i) => {
                    const spread = Number(r.sell) - Number(r.buy)
                    return (
                      <tr
                        key={i}
                        style={{ borderBottom: '1px solid var(--bdr)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}
                      >
                        <td style={{ padding: '9px 12px', color: 'var(--txt2)', whiteSpace: 'nowrap', ...NUM }}>{fmtTime(r.scraped_at)}</td>
                        <td style={{ padding: '9px 12px', fontWeight: FW.semibold, color: 'var(--txt)' }}>{FLAG[r.currency]} {r.currency}</td>
                        <td style={{ padding: '9px 12px', color: CCY_COLOR[r.currency] ?? GREEN, ...NUM }}>₦{fmt(Number(r.buy))}</td>
                        <td style={{ padding: '9px 12px', color: NAVY, ...NUM }}>₦{fmt(Number(r.sell))}</td>
                        <td style={{ padding: '9px 12px', color: 'var(--txt2)', ...NUM }}>₦{fmt(spread)}</td>
                        <td style={{ padding: '9px 12px', color: 'var(--txt3)', fontSize: TEXT.xs }}>{r.source}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

        </SectionCard>

        {/* Disclaimer */}
        <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.7, margin: 0 }}>
          <strong>Disclaimer:</strong> Rates are sourced from community-aggregated BDC quotes (NgnRates.com).
          They are indicative of the Naira parallel market only — not a licensed or regulated FX feed.
          Not suitable for settlement or customer-facing rate quotes without compliance review.
        </p>

      </div>
    </Page>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function RateCard({ currency, rate }: { currency: string; rate?: RateLatest }) {
  const accent = CCY_COLOR[currency] ?? NAVY

  if (!rate) {
    return (
      <div style={card(accent)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[4] }}>
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>
            {FLAG[currency]} {currency}/NGN
          </span>
          <span style={badge(AMBER)}>No data</span>
        </div>
        <p style={{ margin: 0, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
          Click <strong style={{ color: 'var(--txt2)' }}>Refresh Rates</strong> to fetch current rates.
        </p>
      </div>
    )
  }

  const buy    = Number(rate.buy)
  const sell   = Number(rate.sell)
  const spread = sell - buy
  const mid    = (buy + sell) / 2
  const spreadPct = mid > 0 ? ((spread / mid) * 100).toFixed(2) : '0.00'

  return (
    <div style={card(accent)}>
      {/* Pair + badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[5] }}>
        <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>
          {FLAG[currency]} {currency}/NGN
        </span>
        <span style={badge(rate.is_stale ? AMBER : accent)}>
          {rate.is_stale ? 'Stale' : 'Live'}
        </span>
      </div>

      {/* Buy / Sell boxes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        <div style={{ background: 'var(--th-bg)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
          <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 8 }}>
            Buy
          </div>
          <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: accent, ...NUM, lineHeight: 1 }}>
            ₦{fmt(buy)}
          </div>
        </div>
        <div style={{ background: 'var(--th-bg)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
          <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 8 }}>
            Sell
          </div>
          <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: NAVY, ...NUM, lineHeight: 1 }}>
            ₦{fmt(sell)}
          </div>
        </div>
      </div>

      {/* Spread + timestamp */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginTop: SP[4], paddingTop: SP[3], borderTop: '1px solid var(--bdr)',
      }}>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          Spread{' '}
          <span style={{ fontWeight: FW.semibold, color: 'var(--txt2)', ...NUM }}>₦{fmt(spread)}</span>
          <span style={{ marginLeft: 4 }}>({spreadPct}%)</span>
        </div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textAlign: 'right' }}>
          {fmtTime(rate.as_of)}
        </div>
      </div>
    </div>
  )
}

function EmptyHistory({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  return (
    <div style={{ height: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SP[3] }}>
      <span className="material-symbols-rounded" style={{ fontSize: 42, color: 'var(--txt3)' }}>currency_exchange</span>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>No rate history yet</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>Fetch rates to start building historical data</div>
      </div>
      <button
        onClick={onRefresh}
        disabled={refreshing}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, marginTop: SP[1],
          padding: '7px 18px', borderRadius: RADIUS.md,
          border: `1.5px solid ${NAVY}`, background: 'transparent',
          color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold,
          cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.65 : 1,
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>sync</span>
        {refreshing ? 'Fetching…' : 'Fetch Now'}
      </button>
    </div>
  )
}

function SkeletonCard({ accent }: { accent: string }) {
  return (
    <div style={{ ...card(accent), opacity: 0.6, animation: 'pulse 1.4s ease-in-out infinite' }}>
      <div style={{ height: 16, width: '55%', borderRadius: RADIUS.sm, background: 'var(--th-bg)', marginBottom: SP[5] }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        {[0, 1].map(i => (
          <div key={i} style={{ background: 'var(--th-bg)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
            <div style={{ height: 10, width: '40%', borderRadius: RADIUS.xs, background: 'var(--bdr)', marginBottom: 10 }} />
            <div style={{ height: 28, width: '80%', borderRadius: RADIUS.sm, background: 'var(--bdr)' }} />
          </div>
        ))}
      </div>
      <div style={{ height: 10, width: '60%', borderRadius: RADIUS.xs, background: 'var(--th-bg)', marginTop: SP[4] }} />
    </div>
  )
}

// ── Style helpers ────────────────────────────────────────────────────────────

function card(accent: string): React.CSSProperties {
  return {
    background:    'var(--card)',
    borderTop:     `3px solid ${accent}`,
    borderRight:   '1px solid var(--bdr)',
    borderBottom:  '1px solid var(--bdr)',
    borderLeft:    '1px solid var(--bdr)',
    borderRadius:  RADIUS.xl,
    padding:       '20px 20px 16px',
  }
}

function badge(color: string): React.CSSProperties {
  return {
    fontSize: TEXT.xs, fontWeight: FW.bold,
    padding: '3px 9px', borderRadius: RADIUS.full,
    background: `${color}1A`, color,
  }
}

const INPUT_S: React.CSSProperties = {
  height: 34, padding: '0 10px', borderRadius: RADIUS.md,
  border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
  color: 'var(--txt)', fontSize: TEXT.sm, outline: 'none',
}

const BTN_OUTLINE: React.CSSProperties = {
  height: 34, padding: '0 14px', borderRadius: RADIUS.md,
  border: '1.5px solid var(--bdr)', background: 'var(--card)',
  color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
}
