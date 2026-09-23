import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, EmptyState, Badge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import StatTile from './StatTile'
import { apiFetch, unwrap, unwrapList } from '../../lib/api'
import { fmt, fmtExact, fmtKoboExact, fmtNum, fmtDate, fmtPct } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP } from '../../lib/design'

// The End-of-Day report is DERIVED — computed from the live transaction feed,
// the CBS position snapshot, FX and the reconciliation queues. There is no file
// to upload. Naira figures come from the transaction feed; kobo figures from the
// CBS/snapshot books — each is formatted with the matching helper.

interface EODDate { date: string; txn_count: number }

interface EOD {
  as_of: string
  generated_at: string
  prev_date?: string
  flags?: string[]
  movements?: { txn_count: number; credit_count: number; debit_count: number; credit_ngn: number; debit_ngn: number; net_ngn: number }
  // The previous business day's movements, for the day-over-day deltas on the
  // KPI strip. prev_date used to come back alone, with no figures behind it, so
  // no comparison could be drawn from it.
  prev_movements?: { txn_count: number; credit_ngn: number; debit_ngn: number; net_ngn: number }
  by_channel?: { channel: string; txn_count: number; credit_ngn: number; debit_ngn: number; volume_ngn: number }[]
  by_product?: { product_name: string; txn_count: number; volume_ngn: number }[]
  // card_interest is transaction-derived; loan_interest is scheduled accrual.
  // Split so the report can say which is which instead of blending two bases.
  income?: { card_interest_ngn: number; loan_interest_ngn: number; interest_ngn: number; fee_ngn: number; penalty_ngn: number; total_ngn: number }
  position?: Record<string, any>
  new_business?: { loans_count: number; loans_kobo: number; fd_count: number; fd_kobo: number }
  // *_unknown_count is how many of the counted maturities the workspace holds no
  // value for — Udara zeroes principal on closure, so a Closed deposit's payout
  // is unknown, not zero. Without it a ₦0 on an old date reads as "nothing
  // matured" when deposits really did mature.
  maturities?: {
    today_count: number; today_kobo: number; today_unknown_count?: number
    next7_count: number; next7_kobo: number; next7_unknown_count?: number
    list?: any[]
  }
  fx?: { currency: string; buy: number; sell: number; as_of: string }[]
  rails?: { paystack_in_count: number; paystack_in_kobo: number }
  exceptions?: { recon_open_count: number; recon_open_kobo: number; settlement_open_count: number }
}

const CHANNEL_COLS: TableCol<any>[] = [
  { key: 'channel', label: 'Channel', render: r => <span style={{ fontWeight: FW.medium, textTransform: 'capitalize' }}>{r.channel}</span> },
  { key: 'txn_count', label: 'Txns', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.txn_count)}</span> },
  { key: 'credit_ngn', label: 'Credits', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: GREEN }}>{fmt(r.credit_ngn)}</span> },
  { key: 'debit_ngn', label: 'Debits', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: RED }}>{fmt(r.debit_ngn)}</span> },
  { key: 'volume_ngn', label: 'Volume', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmt(r.volume_ngn)}</span> },
]

const PRODUCT_COLS: TableCol<any>[] = [
  { key: 'product_name', label: 'Product', sortable: true },
  { key: 'txn_count', label: 'Txns', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.txn_count)}</span> },
  { key: 'volume_ngn', label: 'Volume NGN', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmt(r.volume_ngn)}</span> },
]

const MATURITY_COLS: TableCol<any>[] = [
  { key: 'customer_name', label: 'Customer', render: r => <span style={{ fontWeight: FW.medium }}>{r.customer_name || '—'}</span> },
  { key: 'maturity_date', label: 'Matures', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
  { key: 'interest_rate', label: 'Rate', align: 'right', render: r => <span style={NUM}>{r.interest_rate != null ? fmtPct(r.interest_rate) : '—'}</span> },
  { key: 'principal_kobo', label: 'Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.principal_kobo)}</span> },
]

export default function FinanceEOD() {
  const [dates, setDates] = useState<EODDate[]>([])
  const [asOf, setAsOf] = useState<string>('')
  const [eod, setEod] = useState<EOD | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch('/api/finance/eod/dates')
      .then(r => setDates(unwrapList<EODDate>(r)))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch(`/api/finance/eod${asOf ? `?date=${asOf}` : ''}`)
      const data = unwrap<EOD>(r)
      setEod(data)
      if (!asOf && data?.as_of) setAsOf(data.as_of)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [asOf])

  useEffect(() => { load() }, [load])

  const mv = eod?.movements
  const prevMv = eod?.prev_movements
  const inc = eod?.income
  const pos = eod?.position
  const nb = eod?.new_business
  const mat = eod?.maturities

  // Day-over-day percentage change. Undefined when there is no previous figure
  // to compare against, so the card shows no delta rather than a bogus one — a
  // net flow that crosses zero would otherwise render a meaningless percentage.
  const prevLabel = eod?.prev_date ? `vs ${fmtDate(eod.prev_date)}` : undefined
  const dod = (cur?: number, prev?: number): number | undefined => {
    if (prev === undefined || prev === null || !Number(prev)) return undefined
    return ((Number(cur ?? 0) - Number(prev)) / Math.abs(Number(prev))) * 100
  }

  // Move the as-of date across the list of dates that actually have activity.
  const idx = dates.findIndex(d => d.date === asOf)
  const step = (delta: number) => {
    const t = idx + delta
    if (t >= 0 && t < dates.length) setAsOf(dates[t].date)
  }

  return (
    <Page
      title="End of Day"
      loading={loading && !eod}
      skeletonKpis={4}
      subtitle={eod ? `As of ${fmtDate(eod.as_of)} · derived from live data (no upload)` : 'Daily position & movement report'}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => step(1)} disabled={idx < 0 || idx >= dates.length - 1} title="Older day"
            style={navBtn(idx < 0 || idx >= dates.length - 1)}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>chevron_left</span>
          </button>
          <select value={asOf} onChange={e => setAsOf(e.target.value)}
            style={{ height: 32, padding: '0 10px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold }}>
            {dates.length === 0 && asOf && <option value={asOf}>{fmtDate(asOf)}</option>}
            {dates.map(d => <option key={d.date} value={d.date}>{fmtDate(d.date)} · {fmtNum(d.txn_count)} txns</option>)}
          </select>
          <button onClick={() => step(-1)} disabled={idx <= 0} title="Newer day" style={navBtn(idx <= 0)}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>chevron_right</span>
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Movement KPI strip (naira, from the transaction feed), with day-over-day
          deltas against the previous business day. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Credits (In)" value={fmt(mv?.credit_ngn ?? 0)} sub={`${fmtNum(mv?.credit_count ?? 0)} txns`}
          change={dod(mv?.credit_ngn, prevMv?.credit_ngn)} changePeriod={prevLabel} icon="south_east" accent={GREEN} loading={loading} />
        <KpiCard label="Debits (Out)" value={fmt(mv?.debit_ngn ?? 0)} sub={`${fmtNum(mv?.debit_count ?? 0)} txns`}
          change={dod(mv?.debit_ngn, prevMv?.debit_ngn)} changePeriod={prevLabel} icon="north_west" accent={RED} loading={loading} />
        <KpiCard label="Net Flow" value={fmt(mv?.net_ngn ?? 0)}
          change={dod(mv?.net_ngn, prevMv?.net_ngn)} changePeriod={prevLabel} icon="trending_up" accent={(mv?.net_ngn ?? 0) >= 0 ? GREEN : RED} loading={loading} />
        <KpiCard label="Transactions" value={fmtNum(mv?.txn_count ?? 0)} sub="posted this day"
          change={dod(mv?.txn_count, prevMv?.txn_count)} changePeriod={prevLabel} icon="swap_horiz" accent={NAVY} loading={loading} />
      </div>

      {/* Income earned + Position (mixed units, each labelled) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
        <SectionCard title="Income Earned" subtitle="Card interest & fees (transaction-derived) · loan interest (scheduled accrual)">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <StatTile label="Card Interest" value={fmt(inc?.card_interest_ngn ?? 0)} color={BLUE} sub="from transaction codes" />
            <StatTile label="Loan Interest" value={fmt(inc?.loan_interest_ngn ?? 0)} color={NAVY} sub="due per schedule (accrual)" />
            <StatTile label="Fees" value={fmt(inc?.fee_ngn ?? 0)} color={PURPLE} />
            <StatTile label="Penalty" value={fmt(inc?.penalty_ngn ?? 0)} color={AMBER} />
            <StatTile label="Total Income" value={fmt(inc?.total_ngn ?? 0)} color={GREEN} sub="same basis as the Income Statement" />
          </div>
        </SectionCard>

        {/* Portfolio Position — every tile here comes from the CBS snapshot for
            this date, so all four are genuinely as-of.

            The fourth tile read "Accrued Interest (FD)" off
            outstanding_interest_kobo. That column sits in the snapshot's LOAN
            block, beside outstanding_principal_kobo and npl_kobo; the snapshot
            has no FD accrual column at all. So the report showed ₦18.0m of loan
            interest receivable under an FD label, against a real FD accrual of
            ₦895.2m — the wrong book, understated ~50x. It is now named for the
            book it comes from. FD accrual is only available live, not as-of, so
            it stays on Treasury and Fixed Deposits rather than being faked here
            from today's register. */}
        <SectionCard title="Portfolio Position" subtitle={pos?.snapshot_date ? `CBS book as of ${fmtDate(pos.snapshot_date)}` : 'CBS book'}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <StatTile label="Loan Book" value={fmtKoboExact(pos?.outstanding_principal_kobo ?? 0)} sub={`${fmtNum(pos?.loans_active ?? 0)} active · ${fmtNum(pos?.borrowers_active ?? 0)} borrowers`} />
            {/* performing_kobo was in the payload and rendered nowhere; showing it
                beside NPL is what makes the ratio legible as a split of the book. */}
            <StatTile label="NPL Ratio" value={fmtPct(pos?.npl_ratio_pct ?? 0)} color={(pos?.npl_ratio_pct ?? 0) > 5 ? RED : AMBER}
              sub={`${fmtKoboExact(pos?.npl_kobo ?? 0)} NPL · ${fmtKoboExact(pos?.performing_kobo ?? 0)} performing`} />
            <StatTile label="FD Book (Liability)" value={fmtKoboExact(pos?.fd_principal_kobo ?? 0)} color={AMBER} sub={`${fmtNum(pos?.fd_active_count ?? 0)} active · owed to depositors`} />
            <StatTile label="Loan Interest Receivable" value={fmtKoboExact(pos?.outstanding_interest_kobo ?? 0)} color={BLUE} sub="earned on the loan book" />
          </div>
        </SectionCard>
      </div>

      {/* Movement breakdowns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
        <SectionCard title="Movement by Channel" padding={false}>
          <DataTable cols={CHANNEL_COLS} rows={eod?.by_channel ?? []} keyFn={(r, i) => r.channel ?? i} loading={loading} emptyText="No movement on this day" />
        </SectionCard>
        <SectionCard title="Movement by Product" padding={false}>
          <DataTable cols={PRODUCT_COLS} rows={eod?.by_product ?? []} keyFn={(r, i) => r.product_name ?? i} loading={loading} emptyText="No movement on this day" pageSize={8} />
        </SectionCard>
      </div>

      {/* Maturities + New business + Rails/Exceptions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
        <SectionCard title="FD Maturities" subtitle="Due on this day and within 7 days" padding={false}>
          {/* *_unknown_count is surfaced in the sub-label: Udara zeroes principal
              on closure, so for a Closed deposit the payout is unknown rather
              than nil. Saying so is what stops a ₦0 on an old date being read as
              "nothing matured". The backend has always sent these counts. */}
          <div style={{ display: 'flex', gap: 10, padding: '14px 16px 4px' }}>
            <StatTile
              label="Maturing Today"
              value={fmtKoboExact(mat?.today_kobo ?? 0)}
              sub={`${fmtNum(mat?.today_count ?? 0)} deposits${(mat?.today_unknown_count ?? 0) > 0 ? ` · ${fmtNum(mat!.today_unknown_count!)} value unknown` : ''}`}
              color={AMBER}
            />
            <StatTile
              label="Next 7 Days"
              value={fmtKoboExact(mat?.next7_kobo ?? 0)}
              sub={`${fmtNum(mat?.next7_count ?? 0)} deposits${(mat?.next7_unknown_count ?? 0) > 0 ? ` · ${fmtNum(mat!.next7_unknown_count!)} value unknown` : ''}`}
            />
          </div>
          <DataTable cols={MATURITY_COLS} rows={mat?.list ?? []} keyFn={(r, i) => i} loading={loading} emptyText="No maturities in the next 7 days" pageSize={6} />
        </SectionCard>

        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          <SectionCard title="New Business Booked">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <StatTile label="Loans" value={fmtKoboExact(nb?.loans_kobo ?? 0)} sub={`${fmtNum(nb?.loans_count ?? 0)} booked`} />
              <StatTile label="Fixed Deposits" value={fmtKoboExact(nb?.fd_kobo ?? 0)} sub={`${fmtNum(nb?.fd_count ?? 0)} opened`} />
            </div>
          </SectionCard>
          {/* settlement_open_count was returned by the API and rendered nowhere,
              so an open settlement break never appeared on the day's report. */}
          <SectionCard title="Rails & Exceptions">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <StatTile label="Paystack In" value={fmtKoboExact(eod?.rails?.paystack_in_kobo ?? 0)} sub={`${fmtNum(eod?.rails?.paystack_in_count ?? 0)} settled`} color={GREEN} />
              <StatTile label="Recon Exceptions" value={fmtNum(eod?.exceptions?.recon_open_count ?? 0)} sub={`${fmtKoboExact(eod?.exceptions?.recon_open_kobo ?? 0)} open`} color={(eod?.exceptions?.recon_open_count ?? 0) > 0 ? RED : 'var(--txt)'} />
              <StatTile label="Settlement Exceptions" value={fmtNum(eod?.exceptions?.settlement_open_count ?? 0)} sub="unresolved as of this date" color={(eod?.exceptions?.settlement_open_count ?? 0) > 0 ? RED : 'var(--txt)'} />
            </div>
          </SectionCard>
        </div>
      </div>

      {/* FX + data caveats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: SP[4] }}>
        <SectionCard title="FX (Parallel Market)" subtitle={eod?.fx?.[0]?.as_of ? `as of ${eod.fx[0].as_of}` : undefined}>
          {(eod?.fx ?? []).length === 0
            ? <EmptyState icon="currency_exchange" title="No FX Rates" />
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {eod!.fx!.map(fx => (
                  <div key={fx.currency} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8 }}>
                    <span style={{ fontWeight: FW.bold }}>{fx.currency}/NGN</span>
                    <span style={{ ...NUM, fontSize: TEXT.sm }}>
                      <span style={{ color: 'var(--txt3)' }}>buy </span>{fmtExact(fx.buy)}
                      <span style={{ color: 'var(--txt3)', marginLeft: 10 }}>sell </span>{fmtExact(fx.sell)}
                    </span>
                  </div>
                ))}
              </div>
            )}
        </SectionCard>

        <SectionCard title="About This Report">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}>
              This End-of-Day is computed from data the workspace already holds. The live transaction
              feed, the CBS position snapshot, the loan repayment schedule, live FX and the reconciliation
              queues. Nothing is uploaded. Movement and income figures come from the transaction feed and
              the loan schedule; position, maturity and rail figures come from the CBS books. Every figure
              on the page is shown in naira.
            </p>
            {(eod?.flags ?? []).map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Badge variant="warning" dot>Note</Badge>
                <span>{f}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}

function navBtn(disabled: boolean): React.CSSProperties {
  return {
    height: 32, width: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)',
    color: disabled ? 'var(--txt3)' : 'var(--txt)', cursor: disabled ? 'not-allowed' : 'pointer',
  }
}
