import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, CartesianGrid, Tooltip, Legend, LabelList,
} from 'recharts'
import {
  Page, SectionCard, DataTable, ErrBanner, Sk, Tabs, FilterBar, filterInputStyle, KpiCard,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtCurrencyMinor, fmtKoboExact, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Summary {
  cycle_date: string
  // NGN fields (amounts in kobo)
  card_interest_ngn: number
  card_fees_ngn: number
  card_penalty_ngn: number
  card_outstanding_ngn: number
  card_billed_ngn: number
  card_credit_limit_ngn: number
  card_purchases_ngn: number
  card_cash_advance_ngn: number
  card_accounts_ngn: number
  // USD fields (amounts in cents)
  card_interest_usd: number
  card_fees_usd: number
  card_penalty_usd: number
  card_outstanding_usd: number
  card_billed_usd: number
  card_credit_limit_usd: number
  card_purchases_usd: number
  card_cash_advance_usd: number
  card_accounts_usd: number
  // Loans & fees
  loan_disbursed_kobo: number
  active_loans: number
  fee_type_income_kobo: number
}

interface SummaryRow {
  cycle_date: string
  product_code: string
  product_name: string
  category: string
  currency: string
  total_interest_kobo: number
  total_fees_kobo: number
  total_penalty_kobo: number
  total_purchases_kobo: number
  total_cash_advance_kobo: number
  total_outstanding_kobo: number
  total_credit_limit_kobo: number
  account_count: number
}

interface ChartRow { type: string; current: number; previous: number }

interface LoanRow {
  id: number
  loan_ref: string
  applicant_name: string
  product: string
  disbursed_amount_kobo: number
  rate_pct: number
  disbursed_at: string
  maturity_date: string
  status: string
  days_active: number
  interest_earned_kobo: number
  maturity_status: string
}

interface FeeTypeSummary { fee_type: string; count: number; total_kobo: number }
interface FeeTypeDetail {
  fee_date: string; fee_type: string; product_name: string; amount_kobo: number; currency: string
}
interface FeeTypeResponse { summary: FeeTypeSummary[]; detail: FeeTypeDetail[] }

// ── Config ────────────────────────────────────────────────────────────────────

const FEE_TYPES = ['membership', 'reissue', 'maintenance', 'joining', 'blink', 'other']

const FEE_LABELS: Record<string, string> = {
  membership: 'Membership Fee', reissue: 'Re-issue Fee',
  maintenance: 'Maintenance Fee', joining: 'Joining Fee',
  blink: 'Blink Fee', other: 'Other Fee',
}

const FEE_COLORS: Record<string, string> = {
  membership: NAVY, reissue: BLUE, maintenance: GREEN,
  joining: AMBER, blink: PURPLE, other: 'var(--chart-lbl)',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function n(v: unknown): number { return Number(v ?? 0) }

function TypePill({ type, color }: { type: string; color: string }) {
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'], background: color + '1A', color }}>
      {type}
    </span>
  )
}

function CurrencyBadge({ currency }: { currency: string }) {
  const isUsd = currency === 'USD'
  return (
    <span style={{
      fontSize: 10.5, fontWeight: FW.bold, padding: '1px 7px', borderRadius: RADIUS.lg, letterSpacing: 0.3,
      background: isUsd ? 'rgba(37,99,235,.1)' : 'rgba(22,163,74,.1)',
      color: isUsd ? BLUE : GREEN,
    }}>{currency}</span>
  )
}

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.md, padding: '10px 14px', fontSize: TEXT.sm }}>
      <div style={{ fontWeight: FW.semibold, marginBottom: SP[1], color: 'var(--txt)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.fill, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtKoboExact(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--txt2)' }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], opacity: 0.3, display: 'block', marginBottom: 10 }}>{icon}</span>
      <div style={{ fontSize: TEXT.base }}>{message}</div>
    </div>
  )
}

// ── Loan columns ──────────────────────────────────────────────────────────────

const MATURITY_STATUS_COLORS: Record<string, string> = {
  'Matured': 'var(--chart-lbl)',
  'Active': GREEN,
  'Maturing Soon': '#D97706',
  'Unknown': 'var(--chart-lbl)',
}

const LOAN_COLS: TableCol<LoanRow>[] = [
  { key: 'loan_ref', label: 'Ref', width: 120,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.loan_ref || `#${r.id}`}</span> },
  { key: 'applicant_name', label: 'Borrower', sortable: true,
    render: r => <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{r.applicant_name || '—'}</span> },
  { key: 'disbursed_amount_kobo', label: 'Principal', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.disbursed_amount_kobo)}</span> },
  { key: 'rate_pct', label: 'Rate %', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{Number(r.rate_pct).toFixed(2)}%</span> },
  { key: 'maturity_status', label: 'Status', sortable: true,
    render: r => {
      const color = MATURITY_STATUS_COLORS[r.maturity_status] ?? 'var(--chart-lbl)'
      return (
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 9px', borderRadius: RADIUS['2xl'], background: color + '1A', color }}>
          {r.maturity_status}
        </span>
      )
    }},
  { key: 'days_active', label: 'Tenor Days', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{r.days_active}</span> },
  { key: 'interest_earned_kobo', label: 'Interest Earned', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: GREEN }}>{fmtKoboExact(r.interest_earned_kobo)}</span> },
  { key: 'disbursed_at', label: 'Disbursed', sortable: true,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.disbursed_at)}</span> },
  { key: 'maturity_date', label: 'Matures', sortable: true,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
]

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCardCsv(rows: SummaryRow[], cycleDate: string) {
  const header = ['Product', 'Currency', 'Category', 'Accounts', 'Outstanding', 'Interest', 'Fees', 'Penalty', 'Credit Limit']
  const lines = rows.map(r => [
    `"${(r.product_name || r.product_code).replace(/"/g, '""')}"`,
    r.currency,
    r.category || '',
    n(r.account_count),
    (n(r.total_outstanding_kobo) / 100).toFixed(2),
    (n(r.total_interest_kobo) / 100).toFixed(2),
    (n(r.total_fees_kobo) / 100).toFixed(2),
    (n(r.total_penalty_kobo) / 100).toFixed(2),
    (n(r.total_credit_limit_kobo) / 100).toFixed(2),
  ].join(','))
  const csv = [header.join(','), ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `card-income-${cycleDate}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function exportLoansCsv(rows: LoanRow[]) {
  const header = ['Ref', 'Borrower', 'Product', 'Principal (NGN)', 'Rate %', 'Status', 'Tenor Days', 'Interest Earned (NGN)', 'Disbursed Date', 'Maturity Date']
  const lines = rows.map(r => [
    r.loan_ref || r.id,
    `"${(r.applicant_name || '').replace(/"/g, '""')}"`,
    `"${(r.product || '').replace(/"/g, '""')}"`,
    (n(r.disbursed_amount_kobo) / 100).toFixed(2),
    Number(r.rate_pct).toFixed(2),
    r.maturity_status,
    r.days_active,
    (n(r.interest_earned_kobo) / 100).toFixed(2),
    r.disbursed_at,
    r.maturity_date,
  ].join(','))
  const csv = [header.join(','), ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `loans-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceIncome() {
  const [tab, setTab]               = useState('cards')
  const [summary, setSummary]       = useState<Summary | null>(null)
  const [cycleData, setCycleData]   = useState<SummaryRow[]>([])
  const [cycleDates, setCycleDates] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [chart, setChart]           = useState<ChartRow[]>([])
  const [loans, setLoans]           = useState<LoanRow[]>([])
  const [feeData, setFeeData]       = useState<FeeTypeResponse | null>(null)
  const [feeTypeFilter, setFeeTypeFilter] = useState('')
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  // Load cycle dates
  useEffect(() => {
    apiFetch<{ cycle_date: string }[]>('/api/cards/cycle-dates')
      .then(d => {
        const dates = (d ?? []).map(x => x.cycle_date)
        setCycleDates(dates)
        if (dates.length) setSelectedDate(dates[0])
      })
      .catch(e => setError(e.message))
  }, [])

  // Load summary KPIs + chart + cycle rows whenever cycle changes
  useEffect(() => {
    if (!selectedDate) return
    setLoading(true)
    Promise.all([
      apiFetch<Summary>(`/api/finance/income/summary?cycle_date=${selectedDate}`),
      apiFetch<ChartRow[]>('/api/finance/income/chart'),
      apiFetch<SummaryRow[]>(`/api/cards/cycle-summary?cycle_date=${selectedDate}`),
    ])
      .then(([s, c, rows]) => {
        setSummary(s)
        setChart(c ?? [])
        setCycleData(rows ?? [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [selectedDate])

  const loadLoans = useCallback(() => {
    apiFetch<LoanRow[]>('/api/finance/income/loans')
      .then(d => setLoans(d ?? []))
      .catch(() => {})
  }, [])

  const loadFees = useCallback(() => {
    const params = feeTypeFilter ? `?fee_type=${feeTypeFilter}` : ''
    apiFetch<FeeTypeResponse>(`/api/finance/income/fee-types${params}`)
      .then(d => setFeeData(d))
      .catch(() => {})
  }, [feeTypeFilter])

  useEffect(() => { if (tab === 'loans') loadLoans() }, [tab, loadLoans])
  useEffect(() => { if (tab === 'fees') loadFees() }, [tab, loadFees])

  // NGN rows sorted by outstanding desc; USD rows after
  const ngnRows = useMemo(() =>
    cycleData.filter(r => r.currency === 'NGN').sort((a, b) => n(b.total_outstanding_kobo) - n(a.total_outstanding_kobo)),
    [cycleData])

  const usdRows = useMemo(() =>
    cycleData.filter(r => r.currency === 'USD').sort((a, b) => n(b.total_outstanding_kobo) - n(a.total_outstanding_kobo)),
    [cycleData])

  const allProductRows = useMemo(() => [...ngnRows, ...usdRows], [ngnRows, usdRows])

  const chartProducts = useMemo(() =>
    ngnRows
      .filter(r => n(r.total_interest_kobo) > 0 || n(r.total_fees_kobo) > 0)
      .slice(0, 12)
      .map(r => ({
        product: r.product_name,
        interest: n(r.total_interest_kobo),
        fees: n(r.total_fees_kobo),
        penalty: n(r.total_penalty_kobo),
      })),
    [ngnRows])

  const s = summary

  return (
    <Page
      title="Income Statement"
      subtitle="Cards · Loans · Fees"
      actions={
        <select
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          style={{ ...filterInputStyle, minWidth: 180 }}
        >
          {cycleDates.map(d => (
            <option key={d} value={d}>Cycle: {fmtDate(d)}</option>
          ))}
        </select>
      }
    >
      <ErrBanner error={error} onRetry={() => setError(null)} />

      {/* ── Top KPI strip — income items ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard
          label="Card Interest (NGN)"
          value={fmtKoboExact(s?.card_interest_ngn ?? 0)}
          icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard
          label="Card Fees & Penalty (NGN)"
          value={fmtKoboExact(n(s?.card_fees_ngn) + n(s?.card_penalty_ngn))}
          icon="receipt_long" accent={AMBER} loading={loading} />
        <KpiCard
          label="Card Income (USD)"
          value={fmtCurrencyMinor(n(s?.card_interest_usd) + n(s?.card_fees_usd) + n(s?.card_penalty_usd), 'USD')}
          icon="attach_money" accent={BLUE} loading={loading} />
        <KpiCard
          label="Loan Interest Earned"
          value={loading ? '…' : loans.length
            ? fmtKoboExact(loans.reduce((acc, r) => acc + n(r.interest_earned_kobo), 0))
            : '₦0.00'}
          icon="account_balance" accent={NAVY} loading={loading} />
      </div>

      <Tabs
        tabs={[
          { key: 'cards',  label: 'Cards' },
          { key: 'loans',  label: 'Loans' },
          { key: 'fees',   label: 'Fee Types' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {/* ── CARDS TAB ───────────────────────────────────────────────────────── */}
      {tab === 'cards' && (
        <>
          {/* Balance KPI section — NGN vs USD separated */}
          <SectionCard title="Card Balances" subtitle="Outstanding, billed & credit limits" style={{ marginBottom: SP[4] }}>
            {loading ? <Sk h={100} /> : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
                {/* NGN balances */}
                {[
                  { label: 'NGN Outstanding',   value: fmtKoboExact(s?.card_outstanding_ngn ?? 0),   color: NAVY },
                  { label: 'NGN Billed Balance', value: fmtKoboExact(s?.card_billed_ngn ?? 0),       color: NAVY },
                  { label: 'NGN Credit Limits',  value: fmtKoboExact(s?.card_credit_limit_ngn ?? 0), color: 'var(--txt2)' },
                  { label: 'USD Outstanding',    value: fmtCurrencyMinor(s?.card_outstanding_usd ?? 0, 'USD'),   color: BLUE },
                  { label: 'USD Billed Balance', value: fmtCurrencyMinor(s?.card_billed_usd ?? 0, 'USD'),       color: BLUE },
                  { label: 'USD Credit Limits',  value: fmtCurrencyMinor(s?.card_credit_limit_usd ?? 0, 'USD'), color: 'var(--txt2)' },
                ].map(k => (
                  <div key={k.label} style={{ background: 'var(--bg)', borderRadius: RADIUS.md, padding: '12px 14px', border: '1px solid var(--bdr)' }}>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: SP[1] }}>{k.label}</div>
                    <div style={{ ...NUM, fontSize: 15, fontWeight: FW.bold, color: k.color }}>{k.value}</div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* Income by Type — data labels, no Y axis (values differ in scale between cycles) */}
          <SectionCard title="Income by Type" subtitle="NGN · Current cycle vs previous cycle" style={{ marginBottom: SP[4] }}>
            {loading ? <Sk h={220} /> : !chart.length ? (
              <EmptyState icon="bar_chart" message="No chart data available" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chart} margin={{ top: 32, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="type" tick={{ fontSize: TEXT.sm, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTip />} />
                  <Legend wrapperStyle={{ fontSize: TEXT.xs }} />
                  <Bar dataKey="current" name="Current cycle" fill={NAVY} radius={[3,3,0,0]}>
                    <LabelList dataKey="current" position="top"
                      formatter={(v: number) => fmtKoboExact(v)}
                      style={{ fontSize: 9.5, fill: NAVY, fontFamily: 'Inter', fontVariantNumeric: 'tabular-nums' }} />
                  </Bar>
                  <Bar dataKey="previous" name="Previous cycle" fill="var(--chart-lbl)" radius={[3,3,0,0]}>
                    <LabelList dataKey="previous" position="top"
                      formatter={(v: number) => fmtKoboExact(v)}
                      style={{ fontSize: 9.5, fill: 'var(--chart-lbl)', fontFamily: 'Inter', fontVariantNumeric: 'tabular-nums' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          {/* Cards — by product, NGN only */}
          {chartProducts.length > 0 && (
            <SectionCard title="Cards" subtitle="NGN interest · fees · penalty by product" style={{ marginBottom: SP[4] }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartProducts} margin={{ top: 28, right: 8, left: 8, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="product" tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)' }} interval={0} textAnchor="middle" axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTip />} />
                  <Legend wrapperStyle={{ fontSize: TEXT.xs }} />
                  <Bar dataKey="interest" name="Interest" fill={GREEN} radius={[3,3,0,0]}>
                    <LabelList dataKey="interest" position="top"
                      formatter={(v: number) => v > 0 ? fmtKoboExact(v) : ''}
                      style={{ fontSize: 8.5, fill: GREEN, fontFamily: 'Inter', fontVariantNumeric: 'tabular-nums' }} />
                  </Bar>
                  <Bar dataKey="fees"    name="Fees"    fill={AMBER} radius={[3,3,0,0]}>
                    <LabelList dataKey="fees" position="top"
                      formatter={(v: number) => v > 0 ? fmtKoboExact(v) : ''}
                      style={{ fontSize: 8.5, fill: AMBER, fontFamily: 'Inter', fontVariantNumeric: 'tabular-nums' }} />
                  </Bar>
                  <Bar dataKey="penalty" name="Penalty" fill={RED}   radius={[3,3,0,0]}>
                    <LabelList dataKey="penalty" position="top"
                      formatter={(v: number) => v > 0 ? fmtKoboExact(v) : ''}
                      style={{ fontSize: 8.5, fill: RED, fontFamily: 'Inter', fontVariantNumeric: 'tabular-nums' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </SectionCard>
          )}

          {/* Aggregate KPI cards per currency */}
          {!loading && allProductRows.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
              {[
                { label: 'NGN Accounts',   value: ngnRows.reduce((s,r) => s + n(r.account_count), 0).toLocaleString(), icon: 'credit_card',   color: NAVY },
                { label: 'NGN Interest',   value: fmtKoboExact(ngnRows.reduce((s,r) => s + n(r.total_interest_kobo), 0)), icon: 'trending_up', color: GREEN },
                { label: 'NGN Fees',       value: fmtKoboExact(ngnRows.reduce((s,r) => s + n(r.total_fees_kobo), 0)),     icon: 'receipt_long', color: AMBER },
                { label: 'NGN Penalty',    value: fmtKoboExact(ngnRows.reduce((s,r) => s + n(r.total_penalty_kobo), 0)),  icon: 'warning_amber', color: RED },
              ].map(k => (
                <div key={k.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 11 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: k.color, opacity: 0.8 }}>{k.icon}</span>
                  <div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 2 }}>{k.label}</div>
                    <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{k.value}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && usdRows.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
              {[
                { label: 'USD Accounts',  value: usdRows.reduce((s,r) => s + n(r.account_count), 0).toLocaleString(),                                                          icon: 'credit_card',   color: BLUE },
                { label: 'USD Interest',  value: fmtCurrencyMinor(usdRows.reduce((s,r) => s + n(r.total_interest_kobo), 0), 'USD'), icon: 'trending_up',  color: BLUE },
                { label: 'USD Fees',      value: fmtCurrencyMinor(usdRows.reduce((s,r) => s + n(r.total_fees_kobo), 0),     'USD'), icon: 'receipt_long', color: BLUE },
                { label: 'USD Outstanding', value: fmtCurrencyMinor(usdRows.reduce((s,r) => s + n(r.total_outstanding_kobo), 0), 'USD'), icon: 'account_balance', color: BLUE },
              ].map(k => (
                <div key={k.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 11 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: k.color, opacity: 0.8 }}>{k.icon}</span>
                  <div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 2 }}>{k.label}</div>
                    <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: k.color }}>{k.value}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Product table — NGN first, then USD, with exact values */}
          <SectionCard padding={false}
            title="Products"
            actions={allProductRows.length > 0 ? (
              <button
                onClick={() => exportCardCsv(allProductRows, selectedDate)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 12px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)',
                  background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)',
                }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>
                Export CSV
              </button>
            ) : undefined}
          >
            {loading ? <Sk h={260} /> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Product', 'CCY', 'Category', 'Accounts', 'Outstanding', 'Interest', 'Fees', 'Penalty', 'Credit Limit'].map(h => (
                      <th key={h} style={{
                        padding: '11px 14px',
                        textAlign: ['Product', 'CCY', 'Category'].includes(h) ? 'left' : 'right',
                        color: 'var(--txt2)', fontWeight: FW.semibold, fontSize: TEXT.sm,
                        borderBottom: '1px solid var(--bdr)',
                        whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allProductRows.length === 0 ? (
                    <tr><td colSpan={9} style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No data for this cycle</td></tr>
                  ) : allProductRows.map(r => (
                    <tr key={`${r.product_code}-${r.currency}`}
                      style={{ borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ padding: '11px 14px', fontWeight: FW.medium, color: 'var(--txt)' }}>{r.product_name || r.product_code}</td>
                      <td style={{ padding: '11px 14px' }}><CurrencyBadge currency={r.currency} /></td>
                      <td style={{ padding: '11px 14px' }}>
                        {r.category ? (
                          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.xl,
                            background: r.category === 'prepaid' ? 'rgba(14,40,65,.08)' : 'rgba(192,0,0,.08)',
                            color: r.category === 'prepaid' ? NAVY : RED, textTransform: 'capitalize' as const }}>
                            {r.category}
                          </span>
                        ) : <span style={{ color: 'var(--txt2)' }}>—</span>}
                      </td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{n(r.account_count).toLocaleString()}</td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontWeight: FW.semibold }}>{fmtCurrencyMinor(r.total_outstanding_kobo, r.currency)}</td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtCurrencyMinor(r.total_interest_kobo, r.currency)}</td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, color: AMBER }}>{fmtCurrencyMinor(r.total_fees_kobo, r.currency)}</td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, color: RED }}>{fmtCurrencyMinor(r.total_penalty_kobo, r.currency)}</td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{fmtCurrencyMinor(r.total_credit_limit_kobo, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>
        </>
      )}

      {/* ── LOANS TAB ───────────────────────────────────────────────────────── */}
      {tab === 'loans' && (
        <>
          {/* Portfolio KPI strip */}
          {loans.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[4] }}>
              {[
                {
                  label: 'Total Portfolio',
                  value: fmtKoboExact(loans.reduce((s, r) => s + n(r.disbursed_amount_kobo), 0)),
                  icon: 'account_balance', color: NAVY,
                },
                {
                  label: 'Total Interest Earned',
                  value: fmtKoboExact(loans.reduce((s, r) => s + n(r.interest_earned_kobo), 0)),
                  icon: 'trending_up', color: GREEN,
                },
                {
                  label: 'Avg Rate (p.a.)',
                  value: (loans.reduce((s, r) => s + n(r.rate_pct), 0) / loans.length).toFixed(2) + '%',
                  icon: 'percent', color: AMBER,
                },
                {
                  label: 'Active / Matured',
                  value: `${loans.filter(r => r.maturity_status === 'Active').length} / ${loans.filter(r => r.maturity_status === 'Matured').length}`,
                  icon: 'donut_large', color: BLUE,
                },
              ].map(k => (
                <div key={k.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 11 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: k.color, opacity: 0.8 }}>{k.icon}</span>
                  <div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 2 }}>{k.label}</div>
                    <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{k.value}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <SectionCard padding={false} actions={loans.length > 0 ? (
            <button onClick={() => exportLoansCsv(loans)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
              Export CSV
            </button>
          ) : undefined}>
            <DataTable
              cols={LOAN_COLS}
              rows={loans}
              keyFn={r => r.id}
              emptyText="No disbursed loans yet. Interest income will appear here once loans are active."
              searchKeys={['loan_ref', 'applicant_name', 'product', 'maturity_status']}
              searchPlaceholder="Search by borrower, ref, product…"
              pageSize={20}
            />
          </SectionCard>
        </>
      )}

      {/* ── FEE TYPES TAB ───────────────────────────────────────────────────── */}
      {tab === 'fees' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[3], marginBottom: SP[4] }}>
            {FEE_TYPES.map(ft => {
              const fs = feeData?.summary?.find(r => r.fee_type === ft)
              const color = FEE_COLORS[ft]
              return (
                <div key={ft}
                  onClick={() => setFeeTypeFilter(feeTypeFilter === ft ? '' : ft)}
                  style={{
                    background: 'var(--card)', border: `1px solid ${feeTypeFilter === ft ? color : 'var(--bdr)'}`,
                    borderRadius: RADIUS.lg, padding: '14px 16px', cursor: 'pointer',
                    boxShadow: feeTypeFilter === ft ? `0 0 0 2px ${color}33` : 'none',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SP[1] }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color }}>{FEE_LABELS[ft]}</span>
                    {fs ? (
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{n(fs.count).toLocaleString()} txns</span>
                    ) : (
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>—</span>
                    )}
                  </div>
                  <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold, color: fs ? color : 'var(--txt2)' }}>
                    {fs ? fmtKoboExact(fs.total_kobo) : '₦0.00'}
                  </div>
                  {!fs && (
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginTop: SP[1] }}>Pending data source</div>
                  )}
                </div>
              )
            })}
          </div>

          <FilterBar>
            <select
              value={feeTypeFilter}
              onChange={e => setFeeTypeFilter(e.target.value)}
              style={{ ...filterInputStyle, minWidth: 180 }}
            >
              <option value="">All fee types</option>
              {FEE_TYPES.map(ft => <option key={ft} value={ft}>{FEE_LABELS[ft]}</option>)}
            </select>
          </FilterBar>

          {!feeData?.detail?.length ? (
            <SectionCard>
              <EmptyState
                icon="loyalty"
                message="Fee type income will appear here once a fee-type report is connected. The fee_income table is ready to receive data."
              />
            </SectionCard>
          ) : (
            <SectionCard padding={false}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Date', 'Fee Type', 'Product', 'Amount', 'Currency'].map(h => (
                      <th key={h} style={{ padding: '11px 14px', textAlign: h === 'Amount' ? 'right' : 'left', color: 'var(--txt2)', fontWeight: FW.semibold, fontSize: TEXT.sm, borderBottom: '1px solid var(--bdr)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {feeData.detail.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ padding: '11px 14px', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.fee_date)}</td>
                      <td style={{ padding: '11px 14px' }}>
                        <TypePill type={FEE_LABELS[r.fee_type] ?? r.fee_type} color={FEE_COLORS[r.fee_type] ?? 'var(--chart-lbl)'} />
                      </td>
                      <td style={{ padding: '11px 14px', color: 'var(--txt)' }}>{r.product_name || '—'}</td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontWeight: FW.semibold, color: NAVY }}>{fmtCurrencyMinor(r.amount_kobo, r.currency || 'NGN')}</td>
                      <td style={{ padding: '11px 14px' }}><CurrencyBadge currency={r.currency || 'NGN'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          )}
        </>
      )}
    </Page>
  )
}
