import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard, SegmentedToggle, DateFilter, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LedgerTree } from '../../components/finance/LedgerTree'
import type { LedgerSection, LedgerLine, LedgerAccount } from '../../components/finance/LedgerTree'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtKoboWhole, fmtNum, fmtDate, fmtPct } from '../../lib/fmt'
import { GREEN, PURPLE, BLUE, AMBER, NAVY, TEXT, FW, SP } from '../../lib/design'

// Total Revenue drill-down — what the finance meeting actually asked for: card interest
// by product, loan interest by SME/Individual, interest on investments, card fees
// (including the joining fee) by product, loan fees (management/other), and Blink as its
// own standalone block. Built the same way as the three Books of Accounts (LedgerTree,
// Location as a filter, not columns) rather than its earlier branch-as-columns layout —
// one consistent ledger design across the whole module. Reads the same
// /income-statement-by-branch endpoint those pages use, grouped here by category (not raw
// statement_line) since that's the specific breakdown the finance meeting asked for, with
// product as the expandable line and branch as the account-level leaf.

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

const BRANCHES = [
  { value: '', label: 'Consolidated' },
  { value: 'lagos', label: 'Lagos' },
  { value: 'abuja', label: 'Abuja' },
] as const

const entryCols: TableCol<Entry>[] = [
  { key: 'financial_date', label: 'Date', render: r => <span>{r.financial_date ? fmtDate(r.financial_date) : '—'}</span> },
  { key: 'account_name', label: 'Account', render: r => <span>{r.account_name ?? r.fee_type ?? '—'}</span> },
  { key: 'narration', label: 'Narration', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.narration ?? r.posting_reference ?? r.loan_account ?? '—'}</span> },
  { key: 'side', label: 'Side', render: r => r.side ? <span style={{ textTransform: 'capitalize' }}>{r.side}</span> : '—' },
  { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo ?? 0) },
]

interface Drill { statement_line: string; product_label: string | null; branch: string; amount: number; postings: number }

export default function RevenueBreakdown() {
  const [branch, setBranch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [blink, setBlink] = useState<BlinkPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [drill, setDrill] = useState<Drill | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [entriesLoading, setEntriesLoading] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams()
      if (branch) q.set('branch', branch)
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
  useEffect(() => { load() }, [branch, dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  const income = useMemo(() => (data?.lines ?? []).filter(l => l.statement === 'income'), [data])

  async function openDrill(statementLine: string, productLabel: string | null, branchLabel: string, amount: number, postings: number) {
    setDrill({ statement_line: statementLine, product_label: productLabel, branch: branchLabel, amount, postings })
    setEntries(null)
    setEntriesLoading(true)
    try {
      const q = new URLSearchParams()
      q.set('statement_line', statementLine)
      q.set('product_label', productLabel ?? '')
      const branchParam = branchLabel === 'Lagos' ? 'lagos' : branchLabel === 'Abuja' ? 'abuja' : ''
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

  // One category -> one LedgerSection. Within it, product (or the tagged label for a
  // merged category) is the expandable Line; branch is the Account-level leaf — a single
  // branch (either because Location is filtered, or because the data only ever has one)
  // collapses straight to a clickable row the same way every other LedgerTree does.
  function buildSection(key: string, label: string, accent: string, rows: { statementLine: string; productLabel: string | null; lineLabel: string }[]): LedgerSection {
    const byLine = new Map<string, Line[]>()
    for (const spec of rows) {
      const matches = income.filter(l => l.statement_line === spec.statementLine && (l.product_label ?? '') === (spec.productLabel ?? ''))
      if (matches.length === 0) continue
      const arr = byLine.get(spec.lineLabel) ?? []
      arr.push(...matches)
      byLine.set(spec.lineLabel, arr)
    }
    const lines: LedgerLine[] = [...byLine.entries()].map(([lineLabel, lineRows]) => {
      const accounts: LedgerAccount[] = lineRows.map((r, i) => ({
        key: `${key}-${lineLabel}-${r.branch}-${i}`,
        label: lineRows.length === 1 ? lineLabel : r.branch,
        amount: Number(r.amount_kobo),
        postings: r.postings,
        onClick: () => openDrill(r.statement_line, r.product_label, r.branch, Number(r.amount_kobo), r.postings),
      }))
      // A single-branch line collapses straight to a clickable row (LedgerTree's own
      // rule: one account sharing the line's label) — but that only hides the chevron,
      // it doesn't wire the click. line.onClick has to be set explicitly too, or the
      // collapsed row looks clickable (underlined) but does nothing.
      const soleAccount = accounts.length === 1 && accounts[0].label === lineLabel
      return { key: lineLabel, label: lineLabel, accounts, onClick: soleAccount ? accounts[0].onClick : undefined }
    }).sort((a, b) => {
      const at = a.accounts.reduce((s, x) => s + x.amount, 0)
      const bt = b.accounts.reduce((s, x) => s + x.amount, 0)
      return bt - at
    })
    return { key, label, accent, lines }
  }

  const cardInterestSection = useMemo(() => buildSection('card-interest', 'Card Interest Income', PURPLE,
    [...new Set(income.filter(l => l.statement_line === 'Card Interest Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Card Interest Income', productLabel: p || null, lineLabel: p || 'Card Interest Income' })),
  ), [income])

  const loanInterestSection = useMemo(() => buildSection('loan-interest', 'Loan Interest Income', PURPLE,
    [...new Set(income.filter(l => l.statement_line === 'Loan Interest Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Loan Interest Income', productLabel: p || null, lineLabel: p || 'Loan Interest Income' })),
  ), [income])

  const investmentsSection = useMemo(() => buildSection('investments', 'Interest on Investments', BLUE,
    [{ statementLine: 'Interest on Investments', productLabel: null, lineLabel: 'Interest on Investments' }],
  ), [income])

  const cardFeesSection = useMemo(() => buildSection('card-fees', 'Card Fees', PURPLE, [
    ...[...new Set(income.filter(l => l.statement_line === 'Card Fee Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Card Fee Income', productLabel: p || null, lineLabel: p || 'Card Fee Income' })),
    ...[...new Set(income.filter(l => l.statement_line === 'Card Joining Fee Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Card Joining Fee Income', productLabel: p || null, lineLabel: p ? `Joining Fee — ${p}` : 'Joining Fee' })),
    ...[...new Set(income.filter(l => l.statement_line === 'Card Joining Fees').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Card Joining Fees', productLabel: p || null, lineLabel: p ? `Joining Fee — ${p}` : 'Joining Fee' })),
  ]), [income])

  const loanFeesSection = useMemo(() => buildSection('loan-fees', 'Loan Fees', PURPLE,
    [...new Set(income.filter(l => l.statement_line === 'Loan Fee Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Loan Fee Income', productLabel: p || null, lineLabel: p || 'Loan Fee Income' })),
  ), [income])

  const otherSection = useMemo(() => buildSection('other', 'Other Income', BLUE, [
    ...[...new Set(income.filter(l => l.statement_line === 'Card Penalty Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Card Penalty Income', productLabel: p || null, lineLabel: p ? `Card Penalty — ${p}` : 'Card Penalty' })),
    ...[...new Set(income.filter(l => l.statement_line === 'Other Interest Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Other Interest Income', productLabel: p || null, lineLabel: 'Other Interest' })),
    ...[...new Set(income.filter(l => l.statement_line === 'Other Income').map(l => l.product_label ?? ''))]
      .map(p => ({ statementLine: 'Other Income', productLabel: p || null, lineLabel: 'Other Income' })),
  ]), [income])

  const sections = [cardInterestSection, loanInterestSection, investmentsSection, cardFeesSection, loanFeesSection, otherSection]
    .filter(s => s.lines.length > 0)

  const totalRevenue = income.reduce((s, l) => s + Number(l.amount_kobo), 0)
  const cardRevenue = income.filter(l => l.statement_line.startsWith('Card')).reduce((s, l) => s + Number(l.amount_kobo), 0)
  const loanRevenue = income.filter(l => l.statement_line.startsWith('Loan')).reduce((s, l) => s + Number(l.amount_kobo), 0)
  const investmentOther = totalRevenue - cardRevenue - loanRevenue

  const blinkFunding = blink?.funding_by_currency ?? []
  const blinkGainLoss = (blink?.realized_sales ?? []).reduce((s, r) => s + Number(r.gain_loss_ngn_kobo ?? 0), 0)

  return (
    <Page
      title="Revenue Breakdown"
      subtitle={`What makes up Total Revenue · from ${data?.coverage_start ?? '2026-07-01'} (Udara's own ledger history floor)`}
      back={{ label: 'Finance', to: '/finance' }}
      loading={loading && !data}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)' }}>Location</span>
          <SegmentedToggle value={branch} onChange={setBranch} options={BRANCHES as any} />
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Revenue" value={fmtKoboWhole(totalRevenue)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="Card Revenue" value={fmtKoboWhole(cardRevenue)} icon="credit_card" accent={PURPLE} loading={loading} />
        <KpiCard label="Loan Revenue" value={fmtKoboWhole(loanRevenue)} icon="request_quote" accent={PURPLE} loading={loading} />
        <KpiCard label="Investments & Other" value={fmtKoboWhole(investmentOther)} icon="account_balance" accent={BLUE} loading={loading} />
      </div>

      <LedgerTree sections={sections} grandTotalLabel="Total Revenue" grandTotal={totalRevenue} fmtAmount={fmtKoboExact}
        loading={loading && !data} emptyText="No revenue lines in this period" />

      <div style={{ marginTop: SP[4] }}>
        <SectionCard title="Blink" subtitle="Standalone FX service — funding, fee split, and realized FX gain/loss">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: SP[4] }}>
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
          <a href="/finance/blink-report" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: SP[3], fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--accent)', textDecoration: 'none' }}>
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
