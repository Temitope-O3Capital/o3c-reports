import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard, DateFilter, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate, fmtPct } from '../../lib/fmt'
import { GREEN, PURPLE, BLUE, AMBER, NAVY, TEXT, FW, SP } from '../../lib/design'

// Total Revenue drill-down — what the finance meeting actually asked for: card interest
// by product, loan interest by SME/Individual, interest on investments, card fees
// (including the joining fee) by product, loan fees (management/other), and Blink as its
// own standalone line. Branch is laid out as columns (Lagos | Abuja | Total) rather than a
// filter toggle, per the finance meeting's own framing of this specific page — unlike the
// three Books of Accounts (Balance Sheet/Income Statement/Cash Flow), which are fixed
// single-column ledgers with Location as a filter. Reads the same
// /income-statement-by-branch endpoint those pages use (no branch param = every branch in
// one response), grouped here by statement_line/product_label with branch pivoted into
// columns, plus Blink's own fee/FX summary folded in as its own section.

interface Line { branch: string; statement_line: string; product_label: string | null; statement: 'income' | 'expense'; amount_kobo: number; postings: number }
interface Payload { lines: Line[]; totals: { branch: string; statement: string; amount_kobo: number }[]; coverage_start: string }

interface Entry {
  id: number; financial_date?: string; narration?: string; posting_reference?: string
  account_number?: string; account_name?: string; side?: string; amount_kobo?: number
  fee_type?: string; branch_name?: string; loan_account?: string
}

interface BlinkFeeSplit { total_fee_pct: number; bluesalt_cut_pct: number; vat_rate_pct: number; o3_share_pct: number }
interface BlinkCurrencyRow { currency: string; fx_total: number; ngn_total: number; events: number }
interface BlinkSaleRow { gain_loss_ngn_kobo?: number }
interface BlinkPayload { funding_by_currency: BlinkCurrencyRow[]; realized_sales: BlinkSaleRow[]; fee_split: BlinkFeeSplit }

const entryCols: TableCol<Entry>[] = [
  { key: 'financial_date', label: 'Date', render: r => <span>{r.financial_date ? fmtDate(r.financial_date) : '—'}</span> },
  { key: 'account_name', label: 'Account', render: r => <span>{r.account_name ?? r.fee_type ?? '—'}</span> },
  { key: 'narration', label: 'Narration', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.narration ?? r.posting_reference ?? r.loan_account ?? '—'}</span> },
  { key: 'side', label: 'Side', render: r => r.side ? <span style={{ textTransform: 'capitalize' }}>{r.side}</span> : '—' },
  { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo ?? 0) },
]

interface PivotRow { detail: string; byBranch: Record<string, number>; byBranchPostings: Record<string, number>; total: number; statement_line: string; product_label: string | null }

function pivotByBranch(lines: Line[], branches: string[]): PivotRow[] {
  const byDetail = new Map<string, PivotRow>()
  for (const l of lines) {
    const key = `${l.statement_line}::${l.product_label ?? ''}`
    let row = byDetail.get(key)
    if (!row) {
      row = { detail: l.product_label ?? l.statement_line, byBranch: {}, byBranchPostings: {}, total: 0, statement_line: l.statement_line, product_label: l.product_label }
      byDetail.set(key, row)
    }
    row.byBranch[l.branch] = (row.byBranch[l.branch] ?? 0) + Number(l.amount_kobo)
    row.byBranchPostings[l.branch] = (row.byBranchPostings[l.branch] ?? 0) + Number(l.postings)
    row.total += Number(l.amount_kobo)
  }
  return [...byDetail.values()].sort((a, b) => b.total - a.total)
}

export default function RevenueBreakdown() {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [blink, setBlink] = useState<BlinkPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [drill, setDrill] = useState<{ statement_line: string; product_label: string | null; branch: string; amount: number; postings: number } | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [entriesLoading, setEntriesLoading] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams()
      if (dateFrom) q.set('date_from', dateFrom)
      if (dateTo) q.set('date_to', dateTo)
      const [incRes, blinkRes] = await Promise.allSettled([
        apiFetch(`/api/finance/income-statement-by-branch?${q.toString()}`),
        apiFetch('/api/finance/blink-report'),
      ])
      if (incRes.status === 'fulfilled') setData(unwrap<Payload>(incRes.value))
      else setError(incRes.reason?.message ?? 'Failed to load revenue breakdown')
      if (blinkRes.status === 'fulfilled') setBlink(unwrap<BlinkPayload>(blinkRes.value))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  const income = useMemo(() => (data?.lines ?? []).filter(l => l.statement === 'income'), [data])
  const branches = useMemo(() => {
    const set = new Set(income.map(l => l.branch))
    const order = ['Lagos', 'Abuja']
    return [...order.filter(b => set.has(b)), ...[...set].filter(b => !order.includes(b))]
  }, [income])

  const section = (statementLine: string) => pivotByBranch(income.filter(l => l.statement_line === statementLine), branches)

  // When a section table merges more than one statement_line (Card Fees folds in the
  // joining fee; Other Income folds in penalties/other-interest), prefix each row with
  // where it came from — a bare product label like "Prepaid" reads as a product name,
  // not "a penalty on the Prepaid product."
  const tagged = (statementLine: string, label: string) =>
    section(statementLine).map(r => ({ ...r, detail: r.product_label ? `${label} — ${r.product_label}` : label }))

  const cardInterest = useMemo(() => section('Card Interest Income'), [income, branches])
  const loanInterest = useMemo(() => section('Loan Interest Income'), [income, branches])
  const investments = useMemo(() => section('Interest on Investments'), [income, branches])
  const cardFees = useMemo(() => [...section('Card Fee Income'), ...tagged('Card Joining Fee Income', 'Joining Fee'), ...tagged('Card Joining Fees', 'Joining Fee')], [income, branches])
  const loanFees = useMemo(() => [...section('Loan Fee Income')], [income, branches])
  const other = useMemo(() => [...tagged('Card Penalty Income', 'Card Penalty'), ...tagged('Other Interest Income', 'Other Interest'), ...section('Other Income')], [income, branches])

  const totalRevenue = income.reduce((s, l) => s + Number(l.amount_kobo), 0)
  const cardRevenue = [...cardInterest, ...cardFees].reduce((s, r) => s + r.total, 0)
  const loanRevenue = [...loanInterest, ...loanFees].reduce((s, r) => s + r.total, 0)
  const investmentOther = [...investments, ...other].reduce((s, r) => s + r.total, 0)

  const blinkFunding = blink?.funding_by_currency ?? []
  const blinkGainLoss = (blink?.realized_sales ?? []).reduce((s, r) => s + Number(r.gain_loss_ngn_kobo ?? 0), 0)

  async function openDrill(row: PivotRow, branch: string) {
    const amount = row.byBranch[branch] ?? 0
    const postings = row.byBranchPostings[branch] ?? 0
    setDrill({ statement_line: row.statement_line, product_label: row.product_label, branch, amount, postings })
    setEntries(null)
    setEntriesLoading(true)
    try {
      const q = new URLSearchParams()
      q.set('statement_line', row.statement_line)
      q.set('product_label', row.product_label ?? '')
      const branchParam = branch === 'Lagos' ? 'lagos' : branch === 'Abuja' ? 'abuja' : ''
      if (branchParam) q.set('branch', branchParam)
      if (dateFrom) q.set('date_from', dateFrom)
      if (dateTo) q.set('date_to', dateTo)
      const res = await apiFetch(`/api/finance/income-statement-by-branch/entries?${q.toString()}`)
      setEntries(unwrap<{ entries: Entry[] }>(res).entries)
    } catch {
      setEntries([])
    } finally {
      setEntriesLoading(false)
    }
  }

  function colsFor(rows: PivotRow[]): TableCol<PivotRow>[] {
    const cols: TableCol<PivotRow>[] = [{ key: 'detail', label: 'Detail' }]
    for (const b of branches) {
      cols.push({
        key: b, label: b, align: 'right',
        render: r => (r.byBranch[b] ? (
          <span style={{ cursor: 'pointer', color: NAVY, textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}
            onClick={() => openDrill(r, b)}>
            {fmtKoboExact(r.byBranch[b])}
          </span>
        ) : <span style={{ color: 'var(--txt3)' }}>—</span>),
      })
    }
    cols.push({ key: 'total', label: 'Total', align: 'right', render: r => <strong>{fmtKoboExact(r.total)}</strong> })
    return cols
  }

  const Section = ({ title, subtitle, rows }: { title: string; subtitle?: string; rows: PivotRow[] }) => (
    <SectionCard title={title} subtitle={subtitle ?? fmtKoboExact(rows.reduce((s, r) => s + r.total, 0))}>
      <DataTable cols={colsFor(rows)} rows={rows} keyFn={(r, i) => `${title}-${i}`} emptyText="No lines in this period" />
    </SectionCard>
  )

  return (
    <Page
      title="Revenue Breakdown"
      subtitle={`What makes up Total Revenue · from ${data?.coverage_start ?? '2026-07-01'} (Udara's own ledger history floor)`}
      back={{ label: 'Finance', to: '/finance' }}
      loading={loading && !data}
      skeletonKpis={4}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Revenue" value={fmtKoboExact(totalRevenue)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="Card Revenue" value={fmtKoboExact(cardRevenue)} icon="credit_card" accent={PURPLE} loading={loading} />
        <KpiCard label="Loan Revenue" value={fmtKoboExact(loanRevenue)} icon="request_quote" accent={PURPLE} loading={loading} />
        <KpiCard label="Investments & Other" value={fmtKoboExact(investmentOther)} icon="account_balance" accent={BLUE} loading={loading} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        <Section title="Card Interest Income" subtitle={`By product · ${fmtKoboExact(cardInterest.reduce((s, r) => s + r.total, 0))}`} rows={cardInterest} />
        <Section title="Loan Interest Income" subtitle={`SME vs Individual · ${fmtKoboExact(loanInterest.reduce((s, r) => s + r.total, 0))}`} rows={loanInterest} />
        <Section title="Interest on Investments" rows={investments} />
        <Section title="Card Fees" subtitle={`By product, including the joining fee · ${fmtKoboExact(cardFees.reduce((s, r) => s + r.total, 0))}`} rows={cardFees} />
        <Section title="Loan Fees" subtitle={`Management vs other · ${fmtKoboExact(loanFees.reduce((s, r) => s + r.total, 0))}`} rows={loanFees} />
        <Section title="Other Income" subtitle="Card penalties, other interest, unclassified" rows={other} />

        <SectionCard title="Blink" subtitle="Standalone FX service — funding, fee split, and realized FX gain/loss">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[4] }}>
            <div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 4 }}>O3's Net Fee Share</div>
              <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold }}>{fmtPct(blink?.fee_split.o3_share_pct ?? 0)}</div>
            </div>
            <div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 4 }}>FX Funded (all currencies, all-time)</div>
              <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold }}>{fmtNum(blinkFunding.reduce((s, c) => s + Number(c.events), 0))} events</div>
            </div>
            <div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 4 }}>Realized FX Gain/Loss</div>
              <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: blinkGainLoss >= 0 ? GREEN : AMBER }}>{fmtKoboExact(blinkGainLoss)}</div>
            </div>
          </div>
          <a href="/finance/blink-report" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: SP[3], fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, textDecoration: 'none' }}>
            Full Blink FX Report <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_forward</span>
          </a>
        </SectionCard>
      </div>

      <Modal open={!!drill} onClose={() => setDrill(null)}
        title={drill ? `${drill.statement_line}${drill.product_label ? ' — ' + drill.product_label : ''} · ${drill.branch}` : ''} width={760}>
        {drill && (
          <>
            <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 0 }}>
              {fmtKoboExact(drill.amount)} across {drill.postings} postings
            </p>
            <DataTable cols={entryCols} rows={entries ?? []} keyFn={(r, i) => r.id ?? i} loading={entriesLoading}
              emptyText="No entries found for this line" />
          </>
        )}
      </Modal>
    </Page>
  )
}
