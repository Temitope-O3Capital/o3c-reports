import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell, Tooltip,
  XAxis, YAxis, CartesianGrid,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Tabs, Sk } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM } from '../../lib/design'
import { today, monthStart } from '../../lib/fmt'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EODSummary {
  total_cr: number
  total_dr: number
  net_movement: number
  total_volume: number
  txn_count: number
  active_accounts: number
}

interface FDSummary {
  net_position: number
  total_principal: number
  total_interest: number
  total_inflow_ngn: number
  total_liquidated: number
}

interface TrendPoint { month: string; volume: number; count: number }
interface ProductPoint { product_code: string; product_name: string; volume: number; count: number }

interface TxnRow {
  id: number
  txn_date: string
  account_no: string
  customer: string
  txn_category: string
  amount: number
  balance: number
  sign: string
  description: string
}

interface Treasury {
  cash_position: number
  fd_liabilities: number
  net_liquidity: number
}

// ── Colours ───────────────────────────────────────────────────────────────────

const PRODUCT_COLORS = [NAVY, RED, GREEN, AMBER, BLUE, PURPLE]

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function VolumeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: 'var(--txt)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: NAVY, display: 'inline-block' }} />
        <span style={{ color: 'var(--txt2)' }}>Volume:</span>
        <span style={{ ...NUM, color: 'var(--txt)', fontWeight: 600 }}>{fmtKobo(payload[0]?.value)}</span>
      </div>
    </div>
  )
}

function DonutTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: 'var(--txt)', marginBottom: 4 }}>{d.name}</div>
      <div style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(d.value)}</div>
    </div>
  )
}

// ── Treasury card ─────────────────────────────────────────────────────────────

function TreasuryTab({ data }: { data: Treasury | null }) {
  if (!data) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--txt2)', fontSize: 13 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 32, opacity: 0.35, display: 'block', marginBottom: 8 }}>account_balance</span>
        Loading treasury position…
      </div>
    )
  }
  const rows = [
    { label: 'Cash Position (30d EOD)', value: fmtKobo(data.cash_position), icon: 'payments' },
    { label: 'FD Liabilities', value: fmtKobo(data.fd_liabilities), icon: 'savings' },
    { label: 'Net Liquidity', value: fmtKobo(data.net_liquidity), icon: 'water_drop', accent: data.net_liquidity >= 0 ? GREEN : RED },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
      {rows.map(r => (
        <div key={r.label} style={{ background: 'var(--bg)', borderRadius: 10, padding: '14px 16px', border: '1px solid var(--bdr)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16, color: (r as any).accent ?? 'var(--txt2)' }}>{r.icon}</span>
            <span style={{ fontSize: 11.5, color: 'var(--txt2)', fontWeight: 600 }}>{r.label}</span>
          </div>
          <div style={{ ...NUM, fontSize: 17, fontWeight: 700, color: (r as any).accent ?? 'var(--txt)', letterSpacing: '-0.4px' }}>{r.value}</div>
        </div>
      ))}
    </div>
  )
}

// ── Large transactions table ───────────────────────────────────────────────────

const TXN_COLS: TableCol<TxnRow>[] = [
  { key: 'txn_date', label: 'Date', render: r => fmtDate(r.txn_date) },
  { key: 'account_no', label: 'Ref', render: r => (
    <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.account_no}</span>
  )},
  { key: 'customer', label: 'Customer', sortable: true },
  { key: 'txn_category', label: 'Type', render: r => (
    <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
      {r.txn_category || r.description || '—'}
    </span>
  )},
  { key: 'amount', label: 'Amount', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: 600, color: r.sign === 'CR' ? GREEN : RED }}>{fmtKobo(r.amount)}</span> },
  { key: 'balance', label: 'Balance', align: 'right', render: r => <span style={NUM}>{fmtKobo(r.balance)}</span> },
  { key: 'sign', label: 'Channel', render: r => (
    <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: r.sign === 'CR' ? 'rgba(22,163,74,.1)' : 'rgba(192,0,0,.08)',
      color: r.sign === 'CR' ? GREEN : RED }}>
      {r.sign}
    </span>
  )},
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceOverview() {
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [eod, setEod] = useState<EODSummary | null>(null)
  const [fd, setFd] = useState<FDSummary | null>(null)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [products, setProducts] = useState<ProductPoint[]>([])
  const [txns, setTxns] = useState<TxnRow[]>([])
  const [treasury, setTreasury] = useState<Treasury | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const from = monthStart()
    const to = today()
    try {
      const [eodRes, fdRes, trendRes, prodRes, txnRes, treasuryRes] = await Promise.allSettled([
        apiFetch<EODSummary>(`/api/eod/summary?date_from=${from}&date_to=${to}`),
        apiFetch<FDSummary>(`/api/fixed-deposit/summary?date_from=${from}&date_to=${to}`),
        apiFetch<TrendPoint[]>('/api/eod/trend'),
        apiFetch<ProductPoint[]>('/api/eod/by-product'),
        apiFetch<{ data: TxnRow[] }>(`/api/eod/transactions?date_from=${from}&date_to=${to}&limit=10`),
        apiFetch<Treasury>('/api/finance/treasury'),
      ])
      if (eodRes.status === 'fulfilled') setEod(eodRes.value)
      if (fdRes.status === 'fulfilled') setFd(fdRes.value)
      if (trendRes.status === 'fulfilled') setTrend(trendRes.value ?? [])
      if (prodRes.status === 'fulfilled') setProducts(prodRes.value ?? [])
      if (txnRes.status === 'fulfilled') setTxns(txnRes.value?.data ?? [])
      if (treasuryRes.status === 'fulfilled') setTreasury(treasuryRes.value)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Derive KPIs from available data
  const interestIncomeMTD = fd?.total_interest ?? 0
  const fdOutstanding = fd?.net_position ?? 0
  const netLiquidity = eod ? eod.total_cr - eod.total_dr : 0
  const totalVolume = eod?.total_volume ?? 0

  return (
    <Page title="Finance" subtitle={eod ? `${fmtNum(eod.active_accounts)} active accounts · ${fmtNum(eod.txn_count)} transactions this period` : undefined}>
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
        <KpiCard label="Interest Income MTD" value={fmtKobo(interestIncomeMTD)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="FD Outstanding" value={fmtKobo(fdOutstanding)} icon="savings" accent={BLUE} loading={loading} />
        <KpiCard label="Total Loan Book" value={fmtKobo(totalVolume)} icon="account_balance_wallet" accent={NAVY} loading={loading} />
        <KpiCard label="Net Liquidity" value={fmtKobo(netLiquidity)} icon="water_drop"
          accent={netLiquidity >= 0 ? GREEN : RED} loading={loading} />
      </div>

      {/* Tabs */}
      <Tabs
        tabs={[{ key: 'overview', label: 'Overview' }, { key: 'treasury', label: 'Treasury' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          {/* Area chart — transaction volume trend */}
          <SectionCard title="Transaction Volume Trend" subtitle="12-month rolling">
            {loading ? <Sk h={200} /> : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={NAVY} stopOpacity={0.18} />
                      <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} width={72} />
                  <Tooltip content={<VolumeTooltip />} />
                  <Area type="monotone" dataKey="volume" stroke={NAVY} strokeWidth={2} fill="url(#volGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          {/* Donut — product mix */}
          <SectionCard title="Volume by Product" subtitle="Current period">
            {loading ? <Sk h={200} /> : products.length === 0 ? (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: 13 }}>No product data</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <ResponsiveContainer width={160} height={160}>
                  <PieChart>
                    <Pie data={products} dataKey="volume" nameKey="product_name" cx="50%" cy="50%"
                      innerRadius={44} outerRadius={72} strokeWidth={2} stroke="var(--card)">
                      {products.map((_, i) => <Cell key={i} fill={PRODUCT_COLORS[i % PRODUCT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<DonutTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {products.map((p, i) => {
                    const total = products.reduce((s, x) => s + x.volume, 0)
                    const pct = total > 0 ? ((p.volume / total) * 100).toFixed(1) : '0'
                    return (
                      <div key={p.product_code} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: PRODUCT_COLORS[i % PRODUCT_COLORS.length], flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: 'var(--txt)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.product_name || p.product_code}
                        </span>
                        <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>{pct}%</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {tab === 'overview' && (
        <SectionCard title="Today's Large Transactions" subtitle="Top 10 by amount" padding={false}>
          <DataTable
            cols={TXN_COLS}
            rows={txns}
            keyFn={(r, i) => r.id ?? i}
            loading={loading}
            emptyText="No transactions for this period"
          />
        </SectionCard>
      )}

      {tab === 'treasury' && (
        <SectionCard title="Treasury Position" subtitle="Cash, FD liabilities, net liquidity">
          <TreasuryTab data={treasury} />
        </SectionCard>
      )}
    </Page>
  )
}
