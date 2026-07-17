import { useState, useEffect, useCallback } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, GREEN, AMBER, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { Page, SectionCard, Spinner } from '../../components/UI'
import { toast } from 'sonner'

const CURRENCIES = ['USD', 'EUR', 'GBP']

const FLAG: Record<string, string> = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧' }

interface RateLatest {
  currency: string
  buy: number
  sell: number
  source: string
  as_of: string
  is_stale: boolean
}

interface RateHistory {
  source: string
  currency: string
  buy: number
  sell: number
  scraped_at: string
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

export default function FXRates() {
  const [latest, setLatest]     = useState<RateLatest[]>([])
  const [history, setHistory]   = useState<RateHistory[]>([])
  const [currency, setCurrency] = useState('USD')
  const [from, setFrom]         = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10)
  })
  const [to, setTo]             = useState(() => new Date().toISOString().slice(0, 10))
  const [loadingLatest, setLoadingLatest] = useState(true)
  const [loadingHist, setLoadingHist]     = useState(false)
  const [refreshing, setRefreshing]       = useState(false)

  const loadLatest = useCallback(() => {
    setLoadingLatest(true)
    apiFetch('/api/finance/fx-rates/latest')
      .then(d => setLatest(d.rates ?? []))
      .catch(() => toast.error('Failed to load FX rates'))
      .finally(() => setLoadingLatest(false))
  }, [])

  // Latest rates
  useEffect(() => { loadLatest() }, [loadLatest])

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

  // History
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
    buy:  +r.buy.toFixed(2),
    sell: +r.sell.toFixed(2),
  }))

  const refreshBtn = (
    <button
      onClick={handleRefresh}
      disabled={refreshing}
      style={{ ...BTN, display: 'flex', alignItems: 'center', gap: 6, opacity: refreshing ? 0.65 : 1, cursor: refreshing ? 'not-allowed' : 'pointer' }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>sync</span>
      {refreshing ? 'Refreshing…' : 'Refresh Rates'}
    </button>
  )

  return (
    <Page
      title="FX Parallel Rates"
      subtitle="Indicative Naira parallel-market rates — aggregated BDC quotes, not a licensed FX feed."
      actions={refreshBtn}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[6] }}>

      {/* Latest rate cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: SP[4] }}>
        {loadingLatest
          ? CURRENCIES.map(c => <SkeletonCard key={c} />)
          : CURRENCIES.map(c => {
              const r = latest.find(x => x.currency === c)
              return <RateCard key={c} currency={c} rate={r} />
            })
        }
      </div>

      {/* History chart */}
      <SectionCard title="Rate History">
        {/* Controls */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[3], marginBottom: SP[5], alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {CURRENCIES.map(c => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                style={{
                  padding: '6px 16px', borderRadius: RADIUS['2xl'], border: 'none', cursor: 'pointer',
                  fontFamily: "'Sora', sans-serif", fontSize: TEXT.base, fontWeight: FW.semibold,
                  background: currency === c ? NAVY : 'var(--th-bg)',
                  color: currency === c ? '#fff' : 'var(--txt2)',
                  transition: 'background .12s',
                }}
              >{c}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={INPUT} />
            <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>to</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={INPUT} />
            <button onClick={loadHistory} style={BTN}>Apply</button>
          </div>
        </div>

        {loadingHist
          ? <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>
          : chartData.length === 0
            ? <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No data for selected range</div>
            : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" />
                  <XAxis dataKey="date" tick={{ fontSize: TEXT.xs, fill: 'var(--txt3)' }} />
                  <YAxis tick={{ fontSize: TEXT.xs, fill: 'var(--txt3)' }} width={72}
                    tickFormatter={v => `₦${fmt(v)}`} domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm }}
                    formatter={(v: number, name: string) => [`₦${fmt(v)}`, name === 'buy' ? 'Buy' : 'Sell']}
                  />
                  <Legend formatter={v => v === 'buy' ? 'Buy' : 'Sell'} />
                  <Line type="monotone" dataKey="buy"  stroke={GREEN} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="sell" stroke={NAVY}  strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )
        }

        {/* History table */}
        {!loadingHist && chartData.length > 0 && (
          <div style={{ marginTop: SP[5], overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Date / Time', 'Currency', 'Buy (₦)', 'Sell (₦)', 'Source'].map(h => (
                    <th key={h} style={{ padding: `${SP[2]} ${SP[3]}`, textAlign: 'left', fontWeight: FW.bold, color: 'var(--txt3)', fontSize: TEXT.xs, textTransform: 'uppercase', letterSpacing: '.4px', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}>
                    <td style={{ padding: `${SP[2]} ${SP[3]}`, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtTime(r.scraped_at)}</td>
                    <td style={{ padding: `${SP[2]} ${SP[3]}`, fontWeight: FW.semibold, color: 'var(--txt)' }}>{FLAG[r.currency]} {r.currency}</td>
                    <td style={{ padding: `${SP[2]} ${SP[3]}`, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>₦{fmt(r.buy)}</td>
                    <td style={{ padding: `${SP[2]} ${SP[3]}`, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>₦{fmt(r.sell)}</td>
                    <td style={{ padding: `${SP[2]} ${SP[3]}`, color: 'var(--txt3)' }}>{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Disclaimer */}
      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.6, borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
        <strong>Disclaimer:</strong> Rates are sourced from community-aggregated BDC quotes (NgnRates.com, AbokiForex). They are indicative of the Naira parallel market only and are not a licensed or regulated FX feed. Not suitable for settlement or customer-facing rate quotes without compliance review.
      </p>

      </div>
    </Page>
  )
}

function RateCard({ currency, rate }: { currency: string; rate?: RateLatest }) {
  if (!rate) {
    return (
      <div style={CARD}>
        <div style={{ fontWeight: FW.bold, fontSize: TEXT.lg, color: 'var(--txt2)' }}>{FLAG[currency]} {currency}/NGN</div>
        <div style={{ color: 'var(--txt3)', fontSize: TEXT.base, marginTop: SP[2] }}>No data yet</div>
      </div>
    )
  }

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: FW.bold, fontSize: TEXT.lg, color: 'var(--txt)' }}>{FLAG[currency]} {currency}/NGN</div>
        {rate.is_stale
          ? <span style={BADGE_STALE}>Stale</span>
          : <span style={BADGE_LIVE}>Live</span>
        }
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginTop: SP[4] }}>
        <div>
          <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Buy</div>
          <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.bold, color: GREEN, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>₦{fmt(rate.buy)}</div>
        </div>
        <div>
          <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Sell</div>
          <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.bold, color: NAVY, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>₦{fmt(rate.sell)}</div>
        </div>
      </div>

      <div style={{ marginTop: SP[3], fontSize: TEXT.xs, color: 'var(--txt3)' }}>
        {rate.source} · {fmtTime(rate.as_of)}
      </div>
    </div>
  )
}

function SkeletonCard() {
  return (
    <div style={{ ...CARD, animation: 'pulse 1.4s ease-in-out infinite' }}>
      {[80, 120, 60].map((w, i) => (
        <div key={i} style={{ height: 16, borderRadius: RADIUS.sm, background: 'var(--th-bg)', width: w, marginBottom: 10 }} />
      ))}
    </div>
  )
}

const CARD: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--bdr)',
  borderRadius: RADIUS.xl,
  padding: '18px 20px',
}

const BADGE_LIVE: React.CSSProperties = {
  fontSize: TEXT.xs, fontWeight: FW.bold, padding: '3px 9px', borderRadius: RADIUS['2xl'],
  background: `${GREEN}18`, color: GREEN,
}

const BADGE_STALE: React.CSSProperties = {
  fontSize: TEXT.xs, fontWeight: FW.bold, padding: '3px 9px', borderRadius: RADIUS['2xl'],
  background: `${AMBER}18`, color: AMBER,
}

const INPUT: React.CSSProperties = {
  height: 34, padding: '0 10px', borderRadius: RADIUS.md,
  border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
  color: 'var(--txt)', fontSize: TEXT.base, fontFamily: "'Sora', sans-serif", outline: 'none',
}

const BTN: React.CSSProperties = {
  height: 34, padding: '0 16px', borderRadius: RADIUS.md, border: 'none',
  background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
  cursor: 'pointer', fontFamily: "'Sora', sans-serif",
}
