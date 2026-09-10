import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Sk, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EBar, EDonut } from '../../components/echarts'
import { apiFetch, unwrap } from '../../lib/api'
import { fmt, fmtKoboExact, fmtKobo, fmtNum, fmtDate, fmtPct, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, BLUE, AMBER, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// Finance Overview — a broad standalone dashboard over live sources: the
// transaction-derived income statement, the treasury position, movement feed and
// the daily EOD. Treasury and Sales Commissions are now their own full pages.

const PALETTE = [PURPLE, NAVY, AMBER, BLUE, GREEN, RED, '#5B7A94']

interface IncomeTotals { interest_ngn: number; fee_ngn: number; penalty_ngn: number; total_ngn: number; txn_count: number }
interface TrendPoint { date: string; interest_ngn: number; fee_ngn: number; penalty_ngn: number; total_ngn: number }
interface IncomeStmt {
  totals?: IncomeTotals
  prev?: IncomeTotals
  trend?: TrendPoint[]
  by_product?: { product_name: string; total_ngn: number }[]
}
interface Treasury {
  net_flow_ngn: number; inflow_ngn: number; outflow_ngn: number
  fd_liabilities_kobo: number; fd_accrued_kobo: number; active_fds: number
  loan_book_kobo: number; npl_kobo: number
}
interface EODLite {
  by_channel?: { channel: string; volume_ngn: number }[]
  position?: Record<string, any>
}
interface TxnRow {
  txn_date: string; description: string; channel: string; product_name: string
  account_no: string; money_in: boolean; amount_debit: number; amount_credit: number; account_balance: number
}

function pctChange(cur: number, prev: number): number | undefined {
  if (!prev) return undefined
  return ((cur - prev) / prev) * 100
}

function monthLabel(ym: string): string {
  try { return new Date(ym + '-01').toLocaleDateString('en-NG', { month: 'short', year: 'numeric' }) }
  catch { return ym }
}

// Default window: the last 6 calendar months, so the monthly revenue chart has
// several bars (income posts in monthly billing lumps, not daily).
function sixMonthsAgoStart(): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 5)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function Tile({ label, value, color = 'var(--txt)', sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ padding: '12px 16px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--card)' }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: FW.semibold }}>{label}</div>
      <div style={{ ...NUM, fontSize: 20, fontWeight: FW.bold, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

const TXN_COLS: TableCol<TxnRow>[] = [
  { key: 'txn_date', label: 'Date', render: r => fmtDate(r.txn_date) },
  { key: 'account_no', label: 'Account', render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.account_no || '—'}</span> },
  { key: 'description', label: 'Description', render: r => (
    <span style={{ maxWidth: 300, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{r.description || '—'}</span>
  )},
  { key: 'channel', label: 'Channel', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--chip-txt)', textTransform: 'capitalize' }}>{r.channel || '—'}</span>
  )},
  { key: 'amount_credit', label: 'Amount', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: r.money_in ? GREEN : RED }}>{r.money_in ? fmt(r.amount_credit) : fmt(r.amount_debit)}</span> },
  { key: 'money_in', label: 'Dir', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: r.money_in ? 'rgba(22,163,74,.1)' : 'rgba(192,0,0,.08)', color: r.money_in ? GREEN : RED }}>{r.money_in ? 'CR' : 'DR'}</span>
  )},
]

export default function FinanceOverview() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(sixMonthsAgoStart())
  const [dateTo, setDateTo] = useState(today())

  const [income, setIncome] = useState<IncomeStmt | null>(null)
  const [treasury, setTreasury] = useState<Treasury | null>(null)
  const [eod, setEod] = useState<EODLite | null>(null)
  const [txns, setTxns] = useState<TxnRow[]>([])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    const qs = `date_from=${dateFrom}&date_to=${dateTo}`
    try {
      const [incRes, treasRes, eodRes, txnRes] = await Promise.allSettled([
        apiFetch(`/api/finance/income-statement?${qs}`),
        apiFetch('/api/finance/treasury'),
        apiFetch('/api/finance/eod'),
        apiFetch(`/api/finance/transactions?limit=10`),
      ])
      if (incRes.status === 'fulfilled') setIncome(unwrap<IncomeStmt>(incRes.value))
      if (treasRes.status === 'fulfilled') setTreasury(unwrap<Treasury>(treasRes.value))
      if (eodRes.status === 'fulfilled') setEod(unwrap<EODLite>(eodRes.value))
      if (txnRes.status === 'fulfilled') setTxns(Array.isArray((txnRes.value as any)?.data) ? (txnRes.value as any).data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['finance', 'manual_postings'] })

  const totals = income?.totals
  const prev = income?.prev
  const trend = income?.trend ?? []
  const byProduct = income?.by_product ?? []
  const byChannel = eod?.by_channel ?? []

  const loanBook = treasury?.loan_book_kobo ?? 0
  const npl = treasury?.npl_kobo ?? 0
  const nplRatio = loanBook > 0 ? (npl / loanBook) * 100 : 0

  // Aggregate the daily trend into monthly buckets — income lands in monthly
  // billing lumps, so daily granularity is a spiky, unreadable needle.
  const monthly = useMemo(() => {
    const m = new Map<string, { month: string; label: string; interest_ngn: number; fee_ngn: number; penalty_ngn: number }>()
    for (const t of trend) {
      const key = String(t.date).slice(0, 7)
      const cur = m.get(key) ?? { month: key, label: monthLabel(key), interest_ngn: 0, fee_ngn: 0, penalty_ngn: 0 }
      cur.interest_ngn += Number(t.interest_ngn || 0)
      cur.fee_ngn += Number(t.fee_ngn || 0)
      cur.penalty_ngn += Number(t.penalty_ngn || 0)
      m.set(key, cur)
    }
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month))
  }, [trend])

  const channelData = useMemo(
    () => byChannel.map(c => ({ channel: String(c.channel), volume_ngn: Number(c.volume_ngn) })),
    [byChannel],
  )

  return (
    <Page title="Finance" subtitle={totals ? `${fmt(totals.total_ngn)} revenue · ${fmtNum(totals.txn_count)} income events this period` : 'Revenue, treasury & movement overview'}
      loading={loading && !income}
      skeletonKpis={4}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Primary KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Revenue" value={fmt(totals?.total_ngn ?? 0)} icon="trending_up" accent={GREEN}
          change={pctChange(totals?.total_ngn ?? 0, prev?.total_ngn ?? 0)} changePeriod="vs prev period" loading={loading} />
        <KpiCard label="Interest Income" value={fmt(totals?.interest_ngn ?? 0)} icon="account_balance" accent={BLUE}
          change={pctChange(totals?.interest_ngn ?? 0, prev?.interest_ngn ?? 0)} changePeriod="vs prev period" loading={loading} />
        <KpiCard label="Fee Income" value={fmt(totals?.fee_ngn ?? 0)} icon="receipt_long" accent={PURPLE}
          change={pctChange(totals?.fee_ngn ?? 0, prev?.fee_ngn ?? 0)} changePeriod="vs prev period" loading={loading} />
        <KpiCard label="Net Flow (30d)" value={fmt(treasury?.net_flow_ngn ?? 0)} icon="water_drop"
          accent={(treasury?.net_flow_ngn ?? 0) >= 0 ? GREEN : RED} loading={loading} />
      </div>

      {/* Secondary KPI strip (balance-sheet) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="FD Book" value={fmtKoboExact(treasury?.fd_liabilities_kobo ?? 0)} sub={`${fmtNum(treasury?.active_fds ?? 0)} active`} icon="savings" accent={AMBER} loading={loading} />
        <KpiCard label="Loan Book" value={fmtKoboExact(loanBook)} sub={`NPL ${fmtKoboExact(npl)}`} icon="account_balance_wallet" accent={NAVY} loading={loading} />
        <KpiCard label="NPL Ratio" value={fmtPct(nplRatio)} icon="warning" accent={nplRatio > 5 ? RED : AMBER} loading={loading} />
        <KpiCard label="Accrued FD Interest" value={fmtKoboExact(treasury?.fd_accrued_kobo ?? 0)} icon="percent" accent={BLUE} loading={loading} />
      </div>

      {/* Revenue by month + revenue by product */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Revenue by Month" subtitle="Interest · fees · penalty (billing-cycle income)">
          {loading ? <Sk h={220} /> : monthly.length === 0 ? (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No income in this period</div>
          ) : (
            <EBar
              data={monthly}
              xKey="label"
              height={220}
              stack
              valueFmt={fmt}
              axisFmt={fmt}
              series={[
                { key: 'interest_ngn', name: 'Interest', color: BLUE },
                { key: 'fee_ngn', name: 'Fees', color: PURPLE },
                { key: 'penalty_ngn', name: 'Penalty', color: AMBER },
              ]}
            />
          )}
        </SectionCard>

        <SectionCard title="Revenue by Product" subtitle="Current period">
          {loading ? <Sk h={220} /> : byProduct.length === 0 ? (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No product data</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
              <EDonut
                data={byProduct.map(p => ({ product_name: p.product_name, total_ngn: Number(p.total_ngn) }))}
                valueKey="total_ngn"
                nameKey="product_name"
                colorFn={(_, i) => PALETTE[i % PALETTE.length]}
                size={160}
                valueFmt={fmt}
              />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                {byProduct.slice(0, 6).map((p, i) => {
                  const total = byProduct.reduce((s, x) => s + Number(x.total_ngn), 0)
                  const pct = total > 0 ? ((Number(p.total_ngn) / total) * 100).toFixed(1) : '0'
                  return (
                    <div key={p.product_name} style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
                      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.product_name}</span>
                      <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{pct}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Movement by channel + portfolio position */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Movement by Channel" subtitle="Latest settled day">
          {loading ? <Sk h={200} /> : channelData.length === 0 ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No movement</div>
          ) : (
            <EBar
              data={channelData}
              xKey="channel"
              height={200}
              legend={false}
              valueFmt={fmt}
              axisFmt={fmt}
              series={[{ key: 'volume_ngn', name: 'Volume', color: NAVY }]}
            />
          )}
        </SectionCard>

        <SectionCard title="Portfolio Position" subtitle="Live CBS book">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Tile label="Loan Book" value={fmtKoboExact(loanBook)} sub={`${fmtNum(eod?.position?.loans_active ?? 0)} active · ${fmtNum(eod?.position?.borrowers_active ?? 0)} borrowers`} />
            <Tile label="NPL" value={fmtKoboExact(npl)} color={nplRatio > 5 ? RED : AMBER} sub={`${fmtPct(nplRatio)} of book`} />
            <Tile label="FD Book" value={fmtKoboExact(treasury?.fd_liabilities_kobo ?? 0)} sub={`${fmtNum(treasury?.active_fds ?? 0)} active`} />
            <Tile label="Accrued FD Interest" value={fmtKoboExact(treasury?.fd_accrued_kobo ?? 0)} color={BLUE} />
          </div>
        </SectionCard>
      </div>

      {/* Recent transactions */}
      <SectionCard title="Recent Transactions" subtitle="Latest movements on the feed" padding={false}>
        <DataTable cols={TXN_COLS} rows={txns} keyFn={(r, i) => i} loading={loading} emptyText="No transactions" />
      </SectionCard>
    </Page>
  )
}
