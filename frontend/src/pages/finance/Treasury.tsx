import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, ErrBanner, EmptyState, Sk } from '../../components/UI'
import { EArea, EBar } from '../../components/echarts'
import { apiFetch, unwrap, unwrapList } from '../../lib/api'
import { fmt, fmtKoboExact, fmtKobo, fmtNum, fmtDate, fmtPct } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP } from '../../lib/design'

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
  loan_book_kobo: number
  npl_kobo: number
  flow_trend: FlowPoint[]
}

// /api/fd-book/maturity-ladder → wrapped ({ data, data_source, data_as_of }),
// read with unwrapList. Each row: { bucket, count, principal_kobo, accrued_interest_kobo }.
interface MaturityBucket {
  bucket: string
  count: number
  principal_kobo: number
  accrued_interest_kobo: number
}

function MiniStat({ label, value, color = 'var(--txt)', sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ padding: '12px 16px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--card)' }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: FW.semibold }}>{label}</div>
      <div style={{ ...NUM, fontSize: 20, fontWeight: FW.bold, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function Treasury() {
  const [data, setData] = useState<TreasuryData | null>(null)
  const [ladder, setLadder] = useState<MaturityBucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [tr, ml] = await Promise.all([
        apiFetch('/api/finance/treasury'),
        apiFetch('/api/fd-book/maturity-ladder').catch(() => null),
      ])
      setData(unwrap<TreasuryData>(tr))
      setLadder(unwrapList<MaturityBucket>(ml).map(b => ({ ...b, principal_kobo: Number(b.principal_kobo) })))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

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

  return (
    <Page title="Treasury" subtitle="Cash flow position · deposit & loan books" loading={loading && !data} skeletonKpis={6}>
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip — naira flow (from the feed) + book positions (from CBS, kobo) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Net Flow (30d)" value={fmt(netFlow)} icon="trending_up" accent={netFlow >= 0 ? GREEN : RED} loading={loading} />
        <KpiCard label="Inflow (30d)" value={fmt(data?.inflow_ngn ?? 0)} icon="south_east" accent={GREEN} loading={loading} />
        <KpiCard label="Outflow (30d)" value={fmt(data?.outflow_ngn ?? 0)} icon="north_west" accent={RED} loading={loading} />
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
        <SectionCard title="Cash flow (30 days)" subtitle="Daily inflow vs outflow · from the transaction feed">
          {loading
            ? <Sk h={240} />
            : flowData.length === 0
              ? <EmptyState icon="show_chart" title="No cash-flow data" description="No transaction movement in the trailing window." />
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
        <SectionCard title="Maturity ladder" subtitle="Upcoming FD maturities by days-to-maturity · deposit liabilities">
          {loading
            ? <Sk h={220} />
            : ladder.length === 0
              ? <EmptyState icon="event" title="No upcoming maturities" description="No active deposits with a scheduled maturity date." />
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

      {/* Position — the balance-sheet view (all kobo books) */}
      <SectionCard title="Position" subtitle="Deposit & loan books · CBS/kobo">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <MiniStat label="Loan book" value={fmtKoboExact(loanBook)} color={NAVY} />
          <MiniStat label="NPL" value={fmtKoboExact(npl)} color={nplRatio > 5 ? RED : AMBER} sub={`${fmtPct(nplRatio)} of loan book`} />
          <MiniStat label="FD book" value={fmtKoboExact(data?.fd_liabilities_kobo ?? 0)} color={BLUE} sub={`${fmtNum(data?.active_fds ?? 0)} active`} />
          <MiniStat label="Accrued FD interest" value={fmtKoboExact(data?.fd_accrued_kobo ?? 0)} color={PURPLE} />
        </div>
      </SectionCard>
    </Page>
  )
}
