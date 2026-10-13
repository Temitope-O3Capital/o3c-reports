import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, TEXT, FW, SP, RADIUS, NUM } from '../../lib/design'
import { Page, SectionCard, Spinner, DateFilter, ErrBanner, DataTable, SegmentedToggle, Select, Button } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EArea } from '../../components/echarts'
import { toast } from 'sonner'

// Every currency Aboki Forex quotes on the parallel market. MAJORS keep the big cards
// at the top of the page, because those are the three finance actually works in; the
// rest appear in the table and the history picker so they are reachable rather than
// merely stored.
const MAJORS     = ['USD', 'GBP', 'EUR']
const CURRENCIES = [...MAJORS, 'CAD', 'AUD', 'AED', 'CNY', 'GHS', 'ZAR', 'XOF', 'XAF']

// XOF and XAF are shared by eight and six countries respectively, so no single flag is
// honest for either.
const FLAG: Record<string, string> = {
  USD: '🇺🇸', GBP: '🇬🇧', EUR: '🇪🇺', CAD: '🇨🇦', AUD: '🇦🇺', AED: '🇦🇪',
  CNY: '🇨🇳', GHS: '🇬🇭', ZAR: '🇿🇦', XOF: '🌍', XAF: '🌍',
}

const CCY_NAME: Record<string, string> = {
  USD: 'US Dollar', GBP: 'Pound Sterling', EUR: 'Euro', CAD: 'Canadian Dollar',
  AUD: 'Australian Dollar', AED: 'UAE Dirham', CNY: 'Chinese Yuan', GHS: 'Ghanaian Cedi',
  ZAR: 'South African Rand', XOF: 'West African CFA Franc', XAF: 'Central African CFA Franc',
}

const CCY_COLOR: Record<string, string> = { USD: GREEN, EUR: BLUE, GBP: PURPLE }

// Aboki quotes both CFA francs per 1,000 units; they are stored per unit so the buy and
// sell columns mean the same thing for every currency. Said on the page because anyone
// checking against the site will otherwise see 2.30 where it shows 2,300.
const PER_1000_AT_SOURCE = ['XOF', 'XAF']

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

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

// Decimals follow the size of the rate: two is right for the dollar at 1,370 and loses
// the difference between a CFA franc at 2.30 and 2.35.
const fmtRate = (n: number) =>
  new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: n < 10 ? 3 : 2,
    maximumFractionDigits: n < 10 ? 3 : 2,
  }).format(n)

const historyCols: TableCol<RateHistory>[] = [
  { key: 'scraped_at', label: 'Date / Time', render: r => <span style={{ ...NUM, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtTime(r.scraped_at)}</span> },
  { key: 'currency', label: 'Currency', render: r => <span style={{ fontWeight: FW.semibold }}>{FLAG[r.currency]} {r.currency}</span> },
  { key: 'buy', label: 'Buy (₦)', align: 'right', render: r => <span style={{ ...NUM, color: CCY_COLOR[r.currency] ?? GREEN }}>₦{fmtRate(Number(r.buy))}</span> },
  { key: 'sell', label: 'Sell (₦)', align: 'right', render: r => <span style={{ ...NUM, color: NAVY }}>₦{fmtRate(Number(r.sell))}</span> },
  { key: 'spread', label: 'Spread', align: 'right', sortable: false, render: r => <span style={NUM}>₦{fmtRate(Number(r.sell) - Number(r.buy))}</span> },
  { key: 'source', label: 'Source', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.source}</span> },
]

const allRatesCols: TableCol<RateLatest>[] = [
  {
    key: 'currency', label: 'Currency',
    render: r => (
      <span style={{ fontWeight: FW.semibold, whiteSpace: 'nowrap' }}>
        {FLAG[r.currency]} {r.currency}
        <span style={{ fontWeight: FW.normal, color: 'var(--txt3)', fontSize: TEXT.xs, marginLeft: SP[2] }}>
          {CCY_NAME[r.currency]}
          {PER_1000_AT_SOURCE.includes(r.currency) && ' · quoted per 1,000 at source'}
        </span>
      </span>
    ),
  },
  { key: 'buy',  label: 'Buy (₦)',  align: 'right', render: r => <span style={{ ...NUM, color: CCY_COLOR[r.currency] ?? GREEN }}>₦{fmtRate(Number(r.buy))}</span> },
  { key: 'sell', label: 'Sell (₦)', align: 'right', render: r => <span style={{ ...NUM, color: NAVY }}>₦{fmtRate(Number(r.sell))}</span> },
  { key: 'spread', label: 'Spread', align: 'right', sortable: false, render: r => <span style={NUM}>₦{fmtRate(Number(r.sell) - Number(r.buy))}</span> },
  {
    key: 'as_of', label: 'As Of',
    render: r => (
      <span style={{ ...NUM, fontSize: TEXT.xs, color: r.is_stale ? AMBER : 'var(--txt2)', whiteSpace: 'nowrap' }}>
        {fmtTime(r.as_of)}{r.is_stale && ' · stale'}
      </span>
    ),
  },
  { key: 'source', label: 'Source', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.source}</span> },
]

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
  const [error,         setError]         = useState<string | null>(null)
  const [, setTick] = useState(0)

  // Load failures surface in an ErrBanner with a retry, the way every other
  // Finance page reports them. A toast was the only signal before: it vanishes
  // after a few seconds and leaves an empty page behind with no way to try
  // again and nothing explaining why the cards are blank. Toasts are kept for
  // the refresh ACTION, where a transient confirmation is the right shape.
  const loadLatest = useCallback(() => {
    setLoadingLatest(true)
    setError(null)
    apiFetch('/api/finance/fx-rates/latest')
      .then(d => setLatest(d.rates ?? []))
      .catch((e: any) => setError(e?.message || 'Failed to load FX rates'))
      .finally(() => setLoadingLatest(false))
  }, [])

  useEffect(() => { loadLatest() }, [loadLatest])

  // Re-render the "X ago" label every minute without re-fetching
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // Auto-poll latest rates every 5 minutes
  useEffect(() => {
    const id = setInterval(() => loadLatest(), 5 * 60_000)
    return () => clearInterval(id)
  }, [loadLatest])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await apiPost<{ inserted: number; source?: string }>('/api/finance/fx-rates/refresh', {})
      // The source comes from the response rather than being named here, so a fallback
      // to NgnRates is visible to whoever pressed the button instead of being reported
      // as the primary source.
      const from = res.source ? ` from ${res.source}` : ''
      toast.success(`Scraped ${res.inserted} rate${res.inserted !== 1 ? 's' : ''}${from}`)
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
      .catch((e: any) => setError(e?.message || 'Failed to load rate history'))
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
      loading={loadingLatest && latest.length === 0}
      skeletonKpis={3}
      subtitle="Indicative Naira parallel-market rates. Scraped hourly, display refreshes every 5 minutes."
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
          {lastUpdatedLabel && (
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>
              {lastUpdatedLabel} · scrapes hourly
            </span>
          )}
          <Button onClick={handleRefresh} loading={refreshing} icon="sync">
            {refreshing ? 'Refreshing…' : 'Refresh Now'}
          </Button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => { loadLatest(); loadHistory() }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[6] }}>

        {/* ── Rate cards ──────────────────────────────────────────────── */}
        {/* auto-fit rather than a fixed three columns, so the row stacks instead of
            squeezing on a narrow screen. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: SP[5] }}>
          {loadingLatest
            ? MAJORS.map(c => <SkeletonCard key={c} accent={CCY_COLOR[c]} />)
            : MAJORS.map(c => (
                <RateCard key={c} currency={c} rate={latest.find(x => x.currency === c)} />
              ))
          }
        </div>

        {/* ── Every currency ──────────────────────────────────────────── */}
        <SectionCard title="All Parallel Rates">
          <DataTable
            rows={CURRENCIES
              .map(c => latest.find(x => x.currency === c))
              .filter((r): r is RateLatest => Boolean(r))}
            cols={allRatesCols}
            emptyText="No Rates Yet"
          />
          <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[3], marginBottom: 0 }}>
            Rates are Naira per single unit. Aboki Forex quotes both CFA francs per 1,000,
            so the figures shown here for XOF and XAF are a thousandth of the ones on its
            page. The official CBN rate is a separate figure and is not shown here.
          </p>
        </SectionCard>

        {/* ── History ─────────────────────────────────────────────────── */}
        <SectionCard title="Rate History">

          {/* Toolbar */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[3], marginBottom: SP[5], alignItems: 'center' }}>
            {/* The three majors stay a segmented toggle, which is the quickest thing to
                hit for the currencies anyone looks at daily. The other eight go in a
                select beside it: eleven segments in one inline-flex control would be
                ~770px wide and would scroll the page sideways on a phone. */}
            <SegmentedToggle value={MAJORS.includes(currency) ? currency : ''} onChange={setCurrency}
              options={MAJORS.map(c => ({ value: c, label: `${FLAG[c]} ${c}` }))} />

            <Select
              aria-label="Other currency"
              value={MAJORS.includes(currency) ? '' : currency}
              onChange={e => { if (e.target.value) setCurrency(e.target.value) }}
              style={{ width: 'auto', minWidth: 190 }}
            >
              <option value="">Other Currency…</option>
              {CURRENCIES.filter(c => !MAJORS.includes(c)).map(c => (
                <option key={c} value={c}>{FLAG[c]} {c} · {CCY_NAME[c]}</option>
              ))}
            </Select>

            <div style={{ marginLeft: 'auto' }}>
              <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
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
              <EArea
                data={chartData}
                xKey="date"
                height={260}
                endLabel
                valueFmt={(v) => `₦${fmtRate(v)}`}
                endFmt={(v) => `₦${fmtRate(v)}`}
                axisFmt={(v) => `₦${fmtRate(v)}`}
                series={[
                  { key: 'sell', name: 'Sell: You Pay', color: NAVY },
                  { key: 'buy', name: 'Buy: You Receive', color: accentColor },
                ]}
              />

              {/* Inline legend */}
              <div style={{ display: 'flex', gap: SP[5], marginTop: SP[3] }}>
                {[
                  { color: NAVY,        label: 'Sell: You Pay' },
                  { color: accentColor, label: 'Buy: You Receive' },
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
            <div style={{ marginTop: SP[6], borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <DataTable cols={historyCols} rows={[...history].reverse()} keyFn={(_, i) => i} />
            </div>
          )}

        </SectionCard>

        {/* Disclaimer */}
        <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.7, margin: 0 }}>
          <strong>Disclaimer:</strong> Rates are sourced from community-aggregated BDC quotes, primarily
          Aboki Forex, falling back to NgnRates if that is unreachable. The Source column on each row
          records which one a rate came from. They are indicative of the Naira parallel market only.
          Not a licensed or regulated FX feed. Not suitable for settlement or customer-facing rate
          quotes without compliance review.
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
          <span style={badge(AMBER)}>No Data</span>
        </div>
        <p style={{ margin: 0, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
          Click <strong style={{ color: 'var(--txt2)' }}>Refresh Now</strong> to fetch current rates.
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
            ₦{fmtRate(buy)}
          </div>
        </div>
        <div style={{ background: 'var(--th-bg)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
          <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 8 }}>
            Sell
          </div>
          <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: NAVY, ...NUM, lineHeight: 1 }}>
            ₦{fmtRate(sell)}
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
          <span style={{ fontWeight: FW.semibold, color: 'var(--txt2)', ...NUM }}>₦{fmtRate(spread)}</span>
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
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>No Rate History Yet</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>Fetch rates to start building historical data</div>
      </div>
      <Button variant="secondary" onClick={onRefresh} loading={refreshing} icon="sync" style={{ marginTop: SP[1] }}>
        {refreshing ? 'Fetching…' : 'Fetch Now'}
      </Button>
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

