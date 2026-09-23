import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, ErrBanner, EmptyState, Sk, DateFilter } from '../../components/UI'
import { EArea, EBar } from '../../components/echarts'
import StatTile from './StatTile'
import { apiFetch, unwrap, unwrapList } from '../../lib/api'
import { fmt, fmtKoboExact, fmtKobo, fmtNum, fmtDate, fmtPct, today } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, BLUE, TEXT, FW, SP } from '../../lib/design'

// Treasury — the cash-flow & balance-sheet view for Finance. Naira figures come
// from the transaction feed (net/inflow/outflow, flow_trend); kobo figures from
// the CBS deposit & loan books (FD liabilities, loan book, NPL). Each is formatted
// with the matching helper — *_ngn via fmt, *_kobo via fmtKobo — never mixed.

interface FlowPoint {
  date: string
  inflow_ngn: number
  outflow_ngn: number
  net_ngn: number
}

interface TreasuryData {
  net_flow_ngn: number
  inflow_ngn: number
  outflow_ngn: number
  fd_liabilities_kobo: number
  fd_accrued_kobo: number
  active_fds: number
  // Deposits past their maturity date and still Active — payable NOW. The API
  // has always returned these; nothing rendered them, so the one number on this
  // page with a deadline attached to it was the one number you could not see.
  past_due_fds: number
  past_due_kobo: number
  loan_book_kobo: number
  npl_kobo: number
  // Interest receivable on the LOAN book (cbs_portfolio_snapshot). Not FD
  // accrual — see fd_accrued_kobo for that.
  loan_interest_kobo: number
  flow_trend: FlowPoint[]
  // The window the flow figures actually cover, echoed by the API so the page
  // labels its charts from the data instead of hard-coding "30d".
  flow_from?: string
  flow_to?: string
}

// /api/fd-book/maturity-ladder → wrapped ({ data, data_source, data_as_of }),
// read with unwrapList. Each row: { bucket, count, principal_kobo, accrued_interest_kobo }.
interface MaturityBucket {
  bucket: string
  count: number
  principal_kobo: number
  accrued_interest_kobo: number
}

// Local rather than added to lib/fmt: only this page needs it, and fmt.ts is
// edited by every module at once.
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function Treasury() {
  const [data, setData] = useState<TreasuryData | null>(null)
  const [ladder, setLadder] = useState<MaturityBucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Cash-flow window. The page had no control at all: every flow figure was a
  // fixed trailing 30 days and the only hint was the "(30d)" baked into four KPI
  // labels, so a treasurer asking "what did last quarter look like" had nowhere
  // to ask it.
  const [from, setFrom] = useState(daysAgo(30))
  const [to, setTo] = useState(today())

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [tr, ml] = await Promise.all([
        apiFetch(`/api/finance/treasury?date_from=${from}&date_to=${to}`),
        apiFetch('/api/fd-book/maturity-ladder').catch(() => null),
      ])
      setData(unwrap<TreasuryData>(tr))
      setLadder(unwrapList<MaturityBucket>(ml).map(b => ({ ...b, principal_kobo: Number(b.principal_kobo) })))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const netFlow = data?.net_flow_ngn ?? 0
  const loanBook = Number(data?.loan_book_kobo ?? 0)
  const npl = Number(data?.npl_kobo ?? 0)
  const nplRatio = loanBook > 0 ? (npl / loanBook) * 100 : 0

  // Daily cash-flow series — short date label for the x-axis, naira values coerced
  // from possible numeric strings so the canvas plots them.
  const flowData = (data?.flow_trend ?? []).map(p => ({
    label: fmtDate(p.date, { day: '2-digit', month: 'short' }),
    inflow_ngn: Number(p.inflow_ngn),
    outflow_ngn: Number(p.outflow_ngn),
  }))

  // Taken from the window the API says it covered, falling back to the filter
  // while the first response is still in flight.
  const flowPeriod = `${fmtDate(data?.flow_from ?? from)} – ${fmtDate(data?.flow_to ?? to)}`

  return (
    <Page
      title="Treasury"
      subtitle="Cash flow position · deposit & loan books"
      loading={loading && !data}
      skeletonKpis={6}
      actions={
        // Labelled, because it governs the flow half only — the books below have
        // no history to filter and stay a position as of now.
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, whiteSpace: 'nowrap' }}>Cash-flow period</span>
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip — naira flow (from the feed) + book positions (from CBS, kobo) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Net Flow" value={fmt(netFlow)} sub={flowPeriod} icon="trending_up" accent={netFlow >= 0 ? GREEN : RED} loading={loading} />
        <KpiCard label="Inflow" value={fmt(data?.inflow_ngn ?? 0)} sub={flowPeriod} icon="south_east" accent={GREEN} loading={loading} />
        <KpiCard label="Outflow" value={fmt(data?.outflow_ngn ?? 0)} sub={flowPeriod} icon="north_west" accent={RED} loading={loading} />
        <KpiCard
          label="FD Liabilities"
          value={fmtKoboExact(data?.fd_liabilities_kobo ?? 0)}
          sub={`${fmtNum(data?.active_fds ?? 0)} active · ${fmtKoboExact(data?.fd_accrued_kobo ?? 0)} accrued`}
          icon="savings"
          accent={BLUE}
          loading={loading}
        />
        <KpiCard label="Loan Book" value={fmtKoboExact(loanBook)} icon="account_balance" accent={NAVY} loading={loading} />
        <KpiCard
          label="NPL"
          value={fmtKoboExact(npl)}
          sub={`${fmtPct(nplRatio)} of book`}
          icon="warning"
          accent={nplRatio > 5 ? RED : AMBER}
          loading={loading}
        />
      </div>

      {/* Cash flow trend — inflow vs outflow, naira */}
      <div style={{ marginBottom: SP[5] }}>
        <SectionCard title="Cash Flow" subtitle={`Daily inflow vs outflow · ${flowPeriod} · from the transaction feed`}>
          {loading
            ? <Sk h={240} />
            : flowData.length === 0
              ? <EmptyState icon="show_chart" title="No Cash-Flow Data" description="No transaction movement in the trailing window." />
              : (
                <EArea
                  data={flowData}
                  xKey="label"
                  series={[
                    { key: 'inflow_ngn', name: 'Inflow', color: GREEN },
                    { key: 'outflow_ngn', name: 'Outflow', color: RED },
                  ]}
                  height={240}
                  valueFmt={fmt}
                  axisFmt={fmt}
                />
              )}
        </SectionCard>
      </div>

      {/* Maturity ladder — upcoming FD deposit liabilities, kobo */}
      <div style={{ marginBottom: SP[5] }}>
        <SectionCard title="Maturity Ladder" subtitle="Upcoming FD maturities by days-to-maturity · deposit liabilities">
          {loading
            ? <Sk h={220} />
            : ladder.length === 0
              ? <EmptyState icon="event" title="No Upcoming Maturities" description="No active deposits with a scheduled maturity date." />
              : (
                <EBar
                  data={ladder}
                  xKey="bucket"
                  series={[{ key: 'principal_kobo', name: 'Principal', color: BLUE }]}
                  height={220}
                  valueFmt={fmtKobo}
                  axisFmt={fmtKobo}
                />
              )}
        </SectionCard>
      </div>

      {/* Position — the balance-sheet view (all kobo books).
          Assets and liabilities are separated rather than listed as four
          like-looking tiles: the FD lines are money owed to depositors, and
          sitting them next to the loan book in the same neutral treatment read
          as four assets. */}
      <SectionCard title="Position" subtitle="Deposit & loan books · CBS/kobo">
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Assets</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: SP[4] }}>
          <StatTile label="Loan Book" value={fmtKoboExact(loanBook)} color={NAVY} sub="outstanding principal" />
          <StatTile label="Loan Interest Receivable" value={fmtKoboExact(data?.loan_interest_kobo ?? 0)} color={BLUE} sub="earned on the loan book" />
          <StatTile label="NPL" value={fmtKoboExact(npl)} color={nplRatio > 5 ? RED : AMBER} sub={`${fmtPct(nplRatio)} of loan book`} />
        </div>

        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Liabilities · owed to depositors</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <StatTile label="FD Book" value={fmtKoboExact(data?.fd_liabilities_kobo ?? 0)} color={AMBER} sub={`${fmtNum(data?.active_fds ?? 0)} active deposits`} />
          <StatTile label="Accrued FD Interest" value={fmtKoboExact(data?.fd_accrued_kobo ?? 0)} color={AMBER} sub="cost of funds owed · not income" />
          <StatTile
            label="Past Due: Payable Now"
            value={fmtKoboExact(data?.past_due_kobo ?? 0)}
            color={(data?.past_due_fds ?? 0) > 0 ? RED : 'var(--txt)'}
            sub={`${fmtNum(data?.past_due_fds ?? 0)} deposit${(data?.past_due_fds ?? 0) === 1 ? '' : 's'} past maturity, still active`}
          />
        </div>
      </SectionCard>
    </Page>
  )
}
