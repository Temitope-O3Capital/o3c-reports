import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, KpiCard, SectionCard, DataTable, DateFilter, ErrBanner, EmptyState, Badge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmt, fmtExact, fmtNum, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP } from '../../lib/design'
import { EArea, EBar } from '../../components/echarts'

// The Income Statement is DERIVED — computed live from the transaction feed by
// revenue code (interest · fees · penalty). Every *_ngn value arrives already in
// NAIRA (major units), so it is formatted with fmt()/fmtExact() — never fmtKobo,
// never divided by 100. This is a top-line revenue statement: there is no expense
// or GL data behind it, so it is not a full profit-and-loss.

interface IncomeBucket {
  interest_ngn: number
  fee_ngn: number
  penalty_ngn: number
  total_ngn: number
  txn_count: number
}

interface TrendRow {
  date: string
  interest_ngn: number
  fee_ngn: number
  penalty_ngn: number
  total_ngn: number
}

interface ProductRow {
  product_name: string
  interest_ngn: number
  fee_ngn: number
  penalty_ngn: number
  total_ngn: number
}

interface CategoryRow {
  category: 'interest' | 'fee' | 'penalty' | string
  amount_ngn: number
  txn_count: number
}

interface IncomeStatement {
  from: string
  to: string
  totals: IncomeBucket
  prev: IncomeBucket
  trend: TrendRow[]
  by_product: ProductRow[]
  by_category: CategoryRow[]
}

// Percentage change vs the preceding equal-length window. Guarded for prev=0 so a
// window that follows a zero-revenue period doesn't render a meaningless ∞% delta.
function pctChange(cur: number, prev: number): number | undefined {
  if (!prev) return undefined
  return ((cur - prev) / prev) * 100
}

const CAT_META: Record<string, { label: string; color: string }> = {
  interest: { label: 'Interest', color: BLUE },
  fee: { label: 'Fees', color: PURPLE },
  penalty: { label: 'Penalty', color: AMBER },
}

const PRODUCT_COLS: TableCol<ProductRow>[] = [
  { key: 'product_name', label: 'Product', sortable: true, render: r => <span style={{ fontWeight: FW.medium }}>{r.product_name || '—'}</span> },
  { key: 'interest_ngn', label: 'Interest', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: BLUE }}>{fmt(r.interest_ngn)}</span> },
  { key: 'fee_ngn', label: 'Fees', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: PURPLE }}>{fmt(r.fee_ngn)}</span> },
  { key: 'penalty_ngn', label: 'Penalty', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: AMBER }}>{fmt(r.penalty_ngn)}</span> },
  { key: 'total_ngn', label: 'Total', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmt(r.total_ngn)}</span> },
]

export default function FinanceIncome() {
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')
  const [inc, setInc] = useState<IncomeStatement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const qs = from && to ? `?date_from=${from}&date_to=${to}` : ''
      const r = await apiFetch(`/api/finance/income-statement${qs}`)
      const data = unwrap<IncomeStatement>(r)
      setInc(data)
      // Seed the date filter from the response on first load (no params sent).
      if (!from && data?.from) setFrom(data.from)
      if (!to && data?.to) setTo(data.to)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const totals = inc?.totals
  const prev = inc?.prev

  // Daily trend — a short display date drives the x-axis; the numeric keys are
  // plotted directly (already naira).
  const trendData = useMemo(
    () => (inc?.trend ?? []).map(t => ({
      ...t,
      dlabel: fmtDate(t.date, { day: '2-digit', month: 'short' }),
    })),
    [inc?.trend],
  )

  // Product table pre-sorted by total revenue, descending.
  const productRows = useMemo(
    () => [...(inc?.by_product ?? [])].sort((a, b) => Number(b.total_ngn) - Number(a.total_ngn)),
    [inc?.by_product],
  )

  const categoryTotal = useMemo(
    () => (inc?.by_category ?? []).reduce((s, c) => s + Number(c.amount_ngn), 0),
    [inc?.by_category],
  )

  const catChartData = useMemo(
    () => (inc?.by_category ?? []).map(c => ({
      name: CAT_META[c.category]?.label ?? c.category,
      amount_ngn: Number(c.amount_ngn),
      color: CAT_META[c.category]?.color ?? BLUE,
    })),
    [inc?.by_category],
  )

  const isEmpty = !loading && (!totals || Number(totals.total_ngn) === 0)

  return (
    <Page
      title="Income Statement"
      loading={loading && !inc}
      skeletonKpis={4}
      subtitle={
        inc
          ? `${fmtDate(inc.from)} – ${fmtDate(inc.to)} · transaction-derived revenue (top-line)`
          : 'Transaction-derived revenue (top-line)'
      }
      actions={
        <DateFilter from={from} to={to} align="right" onChange={(f, t) => { setFrom(f); setTo(t) }} />
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip — revenue by stream with period-over-period deltas */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Total Revenue" value={fmt(totals?.total_ngn ?? 0)} sub={`${fmtNum(totals?.txn_count ?? 0)} txns`}
          change={pctChange(Number(totals?.total_ngn ?? 0), Number(prev?.total_ngn ?? 0))} changePeriod="vs prev period"
          icon="payments" accent={GREEN} loading={loading} />
        <KpiCard label="Interest Income" value={fmt(totals?.interest_ngn ?? 0)}
          change={pctChange(Number(totals?.interest_ngn ?? 0), Number(prev?.interest_ngn ?? 0))} changePeriod="vs prev period"
          icon="trending_up" accent={BLUE} loading={loading} />
        <KpiCard label="Fee Income" value={fmt(totals?.fee_ngn ?? 0)}
          change={pctChange(Number(totals?.fee_ngn ?? 0), Number(prev?.fee_ngn ?? 0))} changePeriod="vs prev period"
          icon="receipt_long" accent={PURPLE} loading={loading} />
        <KpiCard label="Penalty Income" value={fmt(totals?.penalty_ngn ?? 0)}
          change={pctChange(Number(totals?.penalty_ngn ?? 0), Number(prev?.penalty_ngn ?? 0))} changePeriod="vs prev period"
          icon="gavel" accent={AMBER} loading={loading} />
      </div>

      {isEmpty ? (
        <SectionCard title="Revenue trend">
          <EmptyState icon="show_chart" title="No revenue in this period"
            description="No interest, fee or penalty transactions were posted in the selected window. Try widening the date range." />
        </SectionCard>
      ) : (
        <>
          {/* Revenue trend — stacked daily composition */}
          <SectionCard title="Revenue trend" subtitle="Daily revenue by stream (interest · fees · penalty)" style={{ marginBottom: SP[5] }}>
            {trendData.length === 0
              ? <EmptyState icon="show_chart" title="No daily data" />
              : (
                <EArea
                  data={trendData}
                  xKey="dlabel"
                  stack
                  height={260}
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

          {/* Composition + product breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: SP[4], marginBottom: SP[5] }}>
            <SectionCard title="Revenue by category" subtitle="Share of total revenue">
              {catChartData.length === 0
                ? <EmptyState icon="donut_small" title="No category data" />
                : (
                  <>
                    <EBar
                      data={catChartData}
                      xKey="name"
                      height={160}
                      legend={false}
                      valueFmt={fmt}
                      axisFmt={fmt}
                      series={[{ key: 'amount_ngn', name: 'Revenue', colorFn: (row: any) => row.color }]}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                      {(inc?.by_category ?? []).map(c => {
                        const meta = CAT_META[c.category] ?? { label: c.category, color: BLUE }
                        const share = categoryTotal ? (Number(c.amount_ngn) / categoryTotal) * 100 : 0
                        return (
                          <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ width: 9, height: 9, borderRadius: 3, background: meta.color, flexShrink: 0 }} />
                            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', flex: 1 }}>{meta.label}</span>
                            <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt3)' }}>{share.toFixed(1)}%</span>
                            <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, minWidth: 92, textAlign: 'right' }}>{fmt(c.amount_ngn)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
            </SectionCard>

            <SectionCard title="Revenue by product" subtitle="Interest, fees and penalty per product line" padding={false}>
              <DataTable
                cols={PRODUCT_COLS}
                rows={productRows}
                keyFn={(r, i) => r.product_name ?? i}
                loading={loading}
                emptyText="No product revenue in this period"
                pageSize={12}
              />
            </SectionCard>
          </div>
        </>
      )}

      {/* Honest scope note */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6 }}>
        <Badge variant="info" dot style={{ flexShrink: 0, marginTop: 1 }}>Note</Badge>
        <span>
          This is a top-line revenue statement derived from transaction revenue codes (interest, fees and penalty).
          There is no expense or general-ledger data behind it, so it is not a full profit-and-loss.
          All figures are exact naira from the live transaction feed — total revenue for the period is {fmtExact(totals?.total_ngn ?? 0)}.
        </span>
      </div>
    </Page>
  )
}
