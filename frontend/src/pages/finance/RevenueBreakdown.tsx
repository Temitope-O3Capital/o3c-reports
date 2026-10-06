import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, DateFilter, KpiCard, SegmentedToggle } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtNum, today } from '../../lib/fmt'
import { NUM, TEXT, SP, GREEN, PURPLE, BLUE } from '../../lib/design'

// Total Revenue drill-down, opened from the Finance Overview page's Total Revenue
// KpiCard. Every interest/fee line here reads Udara's own GL (app.cbs_gl_postings,
// joined to app.gl_account_lines — migration 342), not a derived estimate. Card
// joining fees and loan management fees come from the new manual-entry tables
// (app.fee_income / app.loan_fee_income) because no reliable upstream source for
// either exists — see migration 341. Those two lines show an explicit "no entries
// recorded yet" rather than a fabricated number until Finance starts using the
// capture screens.

interface GLLine { statement_line: string; product_label: string | null; amount_kobo: number; postings: number }
interface FeeLine { fee_type: string; amount_kobo: number; entries: number }
interface LoanFeeLine { fee_type: string; segment: string; amount_kobo: number; entries: number }
interface Breakdown {
  gl_lines: GLLine[]
  card_fees: FeeLine[]
  loan_fees: LoanFeeLine[]
  branch: string
  coverage_start: string
  sector_note: string
}

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
] as const

function groupBy<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const cur = m.get(k) ?? []
    cur.push(r)
    m.set(k, cur)
  }
  return m
}

export default function RevenueBreakdown() {
  const [branch, setBranch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState(today())
  const [data, setData] = useState<Breakdown | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams()
      if (branch) q.set('branch', branch)
      if (dateFrom) q.set('date_from', dateFrom)
      if (dateTo) q.set('date_to', dateTo)
      const res = await apiFetch(`/api/finance/revenue-breakdown?${q.toString()}`)
      setData(unwrap<Breakdown>(res))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load revenue breakdown')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [branch, dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  const glByLine = useMemo(() => groupBy(data?.gl_lines ?? [], g => g.statement_line), [data])

  const cols: TableCol<GLLine>[] = [
    { key: 'product_label', label: 'Product', render: r => r.product_label ?? '—' },
    { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo) },
    { key: 'postings', label: 'Postings', align: 'right', render: r => fmtNum(r.postings) },
  ]

  const cardFeeTotal = (data?.card_fees ?? []).reduce((s, f) => s + Number(f.amount_kobo), 0)
  const loanFeeTotal = (data?.loan_fees ?? []).reduce((s, f) => s + Number(f.amount_kobo), 0)
  const joiningFeeEntries = (data?.card_fees ?? []).filter(f => f.fee_type === 'joining')
  const joiningFeeTotal = joiningFeeEntries.reduce((s, f) => s + Number(f.amount_kobo), 0)
  const managementFeeEntries = (data?.loan_fees ?? []).filter(f => f.fee_type === 'management')
  const managementFeeTotal = managementFeeEntries.reduce((s, f) => s + Number(f.amount_kobo), 0)

  const grandTotal = (data?.gl_lines ?? []).reduce((s, g) => s + Number(g.amount_kobo), 0) + cardFeeTotal + loanFeeTotal

  return (
    <Page
      title="Revenue Breakdown"
      subtitle={`What makes up Total Revenue · from ${data?.coverage_start ?? '2026-07-01'} (Udara's own ledger history floor) · ${fmtKoboExact(grandTotal)}`}
      back={{ label: 'Finance', to: '/finance' }}
      loading={loading && !data}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
          <SegmentedToggle value={branch} onChange={setBranch} options={BRANCHES as any} />
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Revenue" value={fmtKoboExact(grandTotal)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="Card Fee Income" value={fmtKoboExact(cardFeeTotal)} icon="credit_card" accent={PURPLE} loading={loading} />
        <KpiCard label="Loan Fee Income" value={fmtKoboExact(loanFeeTotal)} icon="request_quote" accent={PURPLE} loading={loading} />
        <KpiCard label="Interest Income" value={fmtKoboExact((data?.gl_lines ?? [])
          .filter(g => g.statement_line.includes('Interest'))
          .reduce((s, g) => s + Number(g.amount_kobo), 0))} icon="account_balance" accent={BLUE} loading={loading} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: SP[4] }}>
        <SectionCard title="Card Interest Income" subtitle="By product">
          <DataTable cols={cols} rows={glByLine.get('Card Interest Income') ?? []} keyFn={(r, i) => `${r.product_label}-${i}`} />
        </SectionCard>

        <SectionCard title="Loan Interest Income" subtitle="SME vs Individual">
          <DataTable cols={cols} rows={glByLine.get('Loan Interest Income') ?? []} keyFn={(r, i) => `${r.product_label}-${i}`} />
        </SectionCard>

        <SectionCard title="Interest on Investments" subtitle="With other financial institutions">
          <DataTable cols={cols} rows={glByLine.get('Interest on Investments') ?? []} keyFn={(r, i) => `inv-${i}`} />
        </SectionCard>

        <SectionCard title="Card Fee Income" subtitle="By product, excludes joining fees (below)">
          <DataTable cols={cols} rows={glByLine.get('Card Fee Income') ?? []} keyFn={(r, i) => `${r.product_label}-${i}`} />
        </SectionCard>

        <SectionCard title="Card Joining Fees" subtitle={
          joiningFeeEntries.length === 0
            ? 'No entries recorded yet — see note below'
            : `${joiningFeeEntries.length} approved manual entr${joiningFeeEntries.length === 1 ? 'y' : 'ies'}`
        }>
          <div style={BIGNUM}>{fmtKoboExact(joiningFeeTotal)}</div>
          {joiningFeeEntries.length === 0 && (
            <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[2] }}>
              Udara's own GL carries only 3 one-off manual corrections for this, ever — not a
              real feed. Record a joining fee via Fee Income capture (Finance menu) to see it
              here.
            </p>
          )}
        </SectionCard>

        <SectionCard title="Loan Fee Income" subtitle="Management fee vs other">
          <div style={BIGNUM}>{fmtKoboExact(loanFeeTotal)}</div>
          {managementFeeEntries.length === 0 && (
            <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[2] }}>
              No management-fee entries recorded yet. Udara's product config has loan fees
              switched off entirely, so this has no reliable upstream source either — record
              it via Loan Fee Income capture (Finance menu).
            </p>
          )}
        </SectionCard>

        <SectionCard title="Other Income" subtitle="Unclassified / miscellaneous">
          <DataTable cols={cols} rows={glByLine.get('Other Income') ?? []} keyFn={(r, i) => `other-${i}`} />
        </SectionCard>
      </div>

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4] }}>{data?.sector_note}</p>
    </Page>
  )
}

const BIGNUM = { ...NUM, fontSize: 22, fontWeight: 700, color: 'var(--txt)', letterSpacing: '-0.6px' }
