import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, CardLink, ErrBanner, EmptyState, Sk, DateFilter } from '../../components/UI'
import { EArea, EBar } from '../../components/echarts'
import StatTile from './StatTile'
import { apiFetch, unwrap, unwrapList } from '../../lib/api'
import { fmt, fmtWhole, fmtKoboWhole, fmtKoboExact, fmtKobo, fmtNum, fmtDate, fmtPct, today } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, BLUE, TEXT, FW, SP } from '../../lib/design'
import { useIsMobile } from '../../hooks/useMediaQuery'

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
  // Linked from the Settlements module, which already owns posting/reconciliation
  // (see backend-go/handlers/finance.go's header comment) — not rebuilt here.
  settlements?: {
    pending_manual_postings: number; pending_manual_postings_kobo: number
    open_nip_exceptions: number; open_nip_exceptions_kobo: number
    settled_today_kobo: number; failed_settlements: number
  }
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
  const navigate = useNavigate()
  const isMobile = useIsMobile()
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

      {/* KPI strip — naira flow (from the feed) + book positions (from CBS, kobo).
          Fixed at three across rather than auto-fit: six cards packed as many-per-row
          as would fit left a single orphan on the second row. Three-by-two is even. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Net Flow" value={fmtWhole(netFlow)} sub={flowPeriod} icon="trending_up" accent={netFlow >= 0 ? GREEN : RED} loading={loading}
          numericValue={netFlow} formatValue={fmtWhole} trend={(data?.flow_trend ?? []).map(p => Number(p.net_ngn))} />
        <KpiCard label="Inflow" value={fmtWhole(data?.inflow_ngn ?? 0)} sub={flowPeriod} icon="south_east" accent={GREEN} loading={loading}
          numericValue={Number(data?.inflow_ngn ?? 0)} formatValue={fmtWhole} trend={flowData.map(p => p.inflow_ngn)} />
        <KpiCard label="Outflow" value={fmtWhole(data?.outflow_ngn ?? 0)} sub={flowPeriod} icon="north_west" accent={RED} loading={loading}
          numericValue={Number(data?.outflow_ngn ?? 0)} formatValue={fmtWhole} trend={flowData.map(p => p.outflow_ngn)} />
        <KpiCard
          label="FD Liabilities"
          value={fmtKoboWhole(data?.fd_liabilities_kobo ?? 0)}
          sub={`${fmtNum(data?.active_fds ?? 0)} active · ${fmtKoboWhole(data?.fd_accrued_kobo ?? 0)} accrued`}
          icon="savings"
          accent={BLUE}
          loading={loading}
          numericValue={Number(data?.fd_liabilities_kobo ?? 0)} formatValue={fmtKoboWhole}
        />
        <KpiCard label="Loan Book" value={fmtKoboWhole(loanBook)} icon="account_balance" accent={NAVY} loading={loading}
          numericValue={loanBook} formatValue={fmtKoboWhole} />
        <KpiCard
          label="NPL"
          value={fmtKoboWhole(npl)}
          sub={`${fmtPct(nplRatio)} of book`}
          icon="warning"
          accent={nplRatio > 5 ? RED : AMBER}
          loading={loading}
          numericValue={npl} formatValue={fmtKoboWhole}
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
      <SectionCard title="Position" subtitle="Deposit & loan books · CBS/kobo"
        actions={<CardLink label="Full Balance Sheet" onClick={() => navigate('/finance/balance-sheet')} />}
      >
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Assets</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SP[3], marginBottom: SP[4] }}>
          <StatTile label="Loan Book" value={fmtKoboExact(loanBook)} color={NAVY} sub="outstanding principal" />
          <StatTile label="Loan Interest Receivable" value={fmtKoboExact(data?.loan_interest_kobo ?? 0)} color={BLUE} sub="earned on the loan book" />
          <StatTile label="NPL" value={fmtKoboExact(npl)} color={nplRatio > 5 ? RED : AMBER} sub={`${fmtPct(nplRatio)} of loan book`} />
        </div>

        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Liabilities · owed to depositors</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SP[3] }}>
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

      {/* Linked from Settlements, which already owns posting/reconciliation — see this
          file's header comment. A read-only summary, not a second posting workflow. */}
      <SectionCard title="Posting & Reconciliation" subtitle="From the Settlements module" style={{ marginTop: SP[4] }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SP[3] }}>
          <StatTile
            label="Pending Manual Postings"
            value={fmtNum(data?.settlements?.pending_manual_postings ?? 0)}
            color={(data?.settlements?.pending_manual_postings ?? 0) > 0 ? AMBER : 'var(--txt)'}
            sub={fmtKoboExact(data?.settlements?.pending_manual_postings_kobo ?? 0)}
          />
          <StatTile
            label="Open NIP Exceptions"
            value={fmtNum(data?.settlements?.open_nip_exceptions ?? 0)}
            color={(data?.settlements?.open_nip_exceptions ?? 0) > 0 ? RED : 'var(--txt)'}
            sub={fmtKoboExact(data?.settlements?.open_nip_exceptions_kobo ?? 0)}
          />
          <StatTile label="Settled Today" value={fmtKoboExact(data?.settlements?.settled_today_kobo ?? 0)} color={GREEN} />
          <StatTile
            label="Failed Settlements"
            value={fmtNum(data?.settlements?.failed_settlements ?? 0)}
            color={(data?.settlements?.failed_settlements ?? 0) > 0 ? RED : 'var(--txt)'}
          />
        </div>
        <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[3] }}>
          Posting and reconciliation happen in Settlements — this is a read-only summary.
        </p>
      </SectionCard>
    </Page>
  )
}
