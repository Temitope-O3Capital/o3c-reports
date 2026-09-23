import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Sk, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EBar, EDonut } from '../../components/echarts'
import { apiFetch, unwrap } from '../../lib/api'
import { fmt, fmtKoboExact, fmtNum, fmtDate, fmtPct, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, BLUE, AMBER, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// Finance Overview — a broad standalone dashboard over live sources: the
// transaction-derived income statement, the treasury position, movement feed and
// the daily EOD. Treasury and Sales Commissions are now their own full pages.

const PALETTE = [PURPLE, NAVY, AMBER, BLUE, GREEN, RED, '#5B7A94']

interface IncomeTotals { interest_ngn: number; fee_ngn: number; penalty_ngn: number; total_ngn: number; txn_count: number }
// card_interest_ngn / loan_interest_ngn are split on every trend point so the
// chart can show which book earned the money. interest_ngn is their sum.
interface TrendPoint {
  date: string
  card_interest_ngn: number; loan_interest_ngn: number
  interest_ngn: number; fee_ngn: number; penalty_ngn: number; total_ngn: number
}
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
// Assets and liabilities from the books of record (migration 282). Not the
// general ledger — that holds only workspace-originated collections postings and
// had no Liability class at all until 282. Amounts are kobo/cents in each line's
// OWN currency; net_position is assets minus liabilities and is explicitly NOT
// equity, because this database has no capital or reserves source.
interface PositionLine {
  currency: string; side: 'Asset' | 'Liability' | string
  line: string; gl_code: string; amount_kobo: number; items: number
}
interface PositionTotal {
  currency: string; assets_kobo: number; liabilities_kobo: number; net_position_kobo: number
}
interface Position {
  lines: PositionLine[]
  totals: PositionTotal[]
  as_of?: { cards?: string | null; cbs?: string | null }
  gl_entries?: number
  basis?: string
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
  const [position, setPosition] = useState<Position | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    const qs = `date_from=${dateFrom}&date_to=${dateTo}`
    try {
      const [incRes, treasRes, eodRes, txnRes, posRes] = await Promise.allSettled([
        apiFetch(`/api/finance/income-statement?${qs}`),
        apiFetch('/api/finance/treasury'),
        apiFetch('/api/finance/eod'),
        // The movement feed follows the page's date filter too. It used to ignore
        // it and always return the newest ten rows, so moving the range changed
        // the revenue panels and left this table sitting on today.
        apiFetch(`/api/finance/transactions?limit=10&${qs}`),
        apiFetch('/api/finance/position'),
      ])
      if (incRes.status === 'fulfilled') setIncome(unwrap<IncomeStmt>(incRes.value))
      if (treasRes.status === 'fulfilled') setTreasury(unwrap<Treasury>(treasRes.value))
      if (eodRes.status === 'fulfilled') setEod(unwrap<EODLite>(eodRes.value))
      if (txnRes.status === 'fulfilled') setTxns(Array.isArray((txnRes.value as any)?.data) ? (txnRes.value as any).data : [])
      if (posRes.status === 'fulfilled') setPosition(unwrap<Position>(posRes.value))
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
  //
  // Card and loan interest are stacked separately. They used to be collapsed into
  // one "Interest" bar built from card income alone, so the chart summed to less
  // than the Total Revenue KPI directly above it — the loan book's contribution
  // was in the headline and missing from the picture.
  const monthly = useMemo(() => {
    const m = new Map<string, { month: string; label: string; card_interest_ngn: number; loan_interest_ngn: number; fee_ngn: number; penalty_ngn: number }>()
    for (const t of trend) {
      const key = String(t.date).slice(0, 7)
      const cur = m.get(key) ?? { month: key, label: monthLabel(key), card_interest_ngn: 0, loan_interest_ngn: 0, fee_ngn: 0, penalty_ngn: 0 }
      cur.card_interest_ngn += Number(t.card_interest_ngn || 0)
      cur.loan_interest_ngn += Number(t.loan_interest_ngn || 0)
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
      actions={
        // Labelled because it does not govern the whole page: revenue and the
        // movement feed follow it, while the balance-sheet strip is a position as
        // of now, Net Flow is a fixed trailing 30 days and Movement by Channel is
        // the latest settled day. Each of those says its own window on its own
        // card; the filter now says what it actually drives.
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, whiteSpace: 'nowrap' }}>Revenue &amp; movement period</span>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        </div>
      }
    >
      {/* onRetry is called with the click event; `load` takes (silent) as its
          first argument, so passing it bare made a retry run in silent mode with
          no spinner. */}
      <ErrBanner error={error} onRetry={() => load()} />

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

      {/* Secondary KPI strip — balance-sheet positions, NOT period income.
          These four used to sit in an unlabelled strip below the revenue KPIs,
          and "Accrued FD Interest" carried the same BLUE accent as "Interest
          Income" two rows above it with no sub-label. Both FD figures are money
          O3 OWES depositors — ₦19.6bn of principal and ₦0.9bn accrued at the
          time of writing — so rendering the accrual in the income colour read
          the largest number on the page as earnings. Both now carry the AMBER
          liability accent and say whose money it is. */}
      <p style={{ margin: `0 0 ${SP[2]}`, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Balance Sheet Position · Not Period Income
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="FD Book (Liability)" value={fmtKoboExact(treasury?.fd_liabilities_kobo ?? 0)} sub={`${fmtNum(treasury?.active_fds ?? 0)} active · owed to depositors`} icon="savings" accent={AMBER} loading={loading} />
        <KpiCard label="Loan Book (Asset)" value={fmtKoboExact(loanBook)} sub={`${fmtNum(eod?.position?.loans_active ?? 0)} active · ${fmtNum(eod?.position?.borrowers_active ?? 0)} borrowers`} icon="account_balance_wallet" accent={NAVY} loading={loading} />
        <KpiCard label="NPL Ratio" value={fmtPct(nplRatio)} sub={`${fmtKoboExact(npl)} of book`} icon="warning" accent={nplRatio > 5 ? RED : AMBER} loading={loading} />
        <KpiCard label="Accrued FD Interest (Liability)" value={fmtKoboExact(treasury?.fd_accrued_kobo ?? 0)} sub="cost of funds owed · not income" icon="savings" accent={AMBER} loading={loading} />
      </div>

      {/* Financial position.
          There was no balance sheet anywhere in the workspace, and there could
          not have been one: the general ledger holds 1,802 rows — all collections
          payments the workspace posted itself — against a chart of accounts with
          no Liability class, so the ₦19.6bn deposit book had no account it could
          even have been booked to. This is assembled from the same live books of
          record every other figure here reads. It is a POSITION, not equity: no
          capital or reserves source exists in this database, so assets minus
          liabilities is labelled as what it is and nothing is invented to make
          it balance. Currencies are never merged — there is no FX rate policy. */}
      {(position?.lines?.length ?? 0) > 0 && (
        <SectionCard
          title="Financial Position"
          subtitle={`Assets and liabilities from the live books of record · not the general ledger${position?.as_of?.cards ? ` · cards to ${fmtDate(position.as_of.cards)}` : ''}`}
          style={{ marginBottom: SP[4] }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            {(position?.totals ?? []).map(t => {
              const sym = t.currency === 'USD' ? '$' : t.currency === 'NGN' ? '₦' : `${t.currency} `
              const money = (kobo: number) =>
                `${sym}${(Number(kobo || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              const lines = (position?.lines ?? []).filter(l => l.currency === t.currency)
              return (
                <div key={t.currency}>
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                    {t.currency}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
                    {(['Asset', 'Liability'] as const).map(side => (
                      <div key={side}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 5, borderBottom: `2px solid ${side === 'Asset' ? NAVY : AMBER}` }}>
                          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                            {side === 'Asset' ? 'Assets' : 'Liabilities'}
                          </span>
                          <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>
                            {money(side === 'Asset' ? t.assets_kobo : t.liabilities_kobo)}
                          </span>
                        </div>
                        {lines.filter(l => l.side === side).map(l => (
                          <div key={l.line} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--bdr)' }}>
                            <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                              {l.line}
                              <span style={{ color: 'var(--txt3)', marginLeft: 5 }}>{l.gl_code} · {fmtNum(l.items)}</span>
                            </span>
                            <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt)' }}>{money(l.amount_kobo)}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8, paddingTop: 7, borderTop: '1px solid var(--bdr)' }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>
                      Net Position <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(assets − liabilities; not equity)</span>
                    </span>
                    <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: t.net_position_kobo >= 0 ? GREEN : RED }}>
                      {money(t.net_position_kobo)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: SP[3], fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.55 }}>
            Drawn from the loan, deposit and card books, not from the general ledger — which holds
            only {fmtNum(position?.gl_entries ?? 0)} workspace-originated postings. Each currency stands alone;
            no exchange rate is applied. Net position is not equity: this database holds no capital or
            reserves source, so none is shown.
          </div>
        </SectionCard>
      )}

      {/* Revenue by month + revenue by product */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Revenue by Month" subtitle="Card interest · loan interest · fees · penalty — stacks to Total Revenue">
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
                { key: 'card_interest_ngn', name: 'Card Interest', color: BLUE },
                { key: 'loan_interest_ngn', name: 'Loan Interest', color: NAVY },
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

      {/* Movement by channel.
          A "Portfolio Position" card used to sit beside this one, repeating Loan
          Book, NPL, FD Book and Accrued FD Interest — the same four figures as the
          balance-sheet KPI strip higher up the SAME page, and a third time over in
          Financial Position above. Three renderings of one set of numbers, each
          free to drift. The strip and Financial Position keep them; the card is
          gone, and the two figures only it carried (active loans, borrowers) moved
          onto the Loan Book KPI. */}
      <div style={{ marginBottom: SP[4] }}>
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
      </div>

      {/* Recent transactions */}
      <SectionCard title="Recent Transactions" subtitle="Latest movements on the feed" padding={false}>
        <DataTable cols={TXN_COLS} rows={txns} keyFn={(r, i) => i} loading={loading} emptyText="No transactions" />
      </SectionCard>
    </Page>
  )
}
