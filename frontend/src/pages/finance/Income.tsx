import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import {
  Page, SectionCard, DataTable, ErrBanner, Sk, Tabs, FilterBar, filterInputStyle, KpiCard,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, PURPLE, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Summary {
  cycle_date: string
  card_interest_kobo: number
  card_fees_kobo: number
  card_penalty_kobo: number
  card_purchases_kobo: number
  card_cash_advance_kobo: number
  loan_disbursed_kobo: number
  active_loans: number
  fee_type_income_kobo: number
}

interface SummaryRow {
  cycle_date: string
  product_code: string
  product_name: string
  category: string
  total_interest_kobo: number
  total_fees_kobo: number
  total_penalty_kobo: number
  total_purchases_kobo: number
  total_cash_advance_kobo: number
  account_count: number
}

interface ChartRow { type: string; current: number; previous: number }

interface LoanRow {
  id: number
  loan_ref: string
  product: string
  disbursed_amount_kobo: number
  rate_pct: number
  disbursed_at: string
  maturity_date: string
  status: string
  days_active: number
  interest_earned_kobo: number
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
  membership: NAVY, reissue: BLUE ?? '#0EA5E9', maintenance: GREEN,
  joining: AMBER, blink: PURPLE ?? '#7C3AED', other: '#9AA4B8',
}

// ── Pill helpers ──────────────────────────────────────────────────────────────

function TypePill({ type, color }: { type: string; color: string }) {
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: color + '1A', color,
    }}>{type}</span>
  )
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--txt)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.fill, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--txt2)' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 36, opacity: 0.3, display: 'block', marginBottom: 10 }}>{icon}</span>
      <div style={{ fontSize: 13 }}>{message}</div>
    </div>
  )
}

// ── Loan columns ──────────────────────────────────────────────────────────────

const LOAN_COLS: TableCol<LoanRow>[] = [
  { key: 'loan_ref', label: 'Ref', width: 110,
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.loan_ref || `#${r.id}`}</span> },
  { key: 'product', label: 'Product', sortable: true,
    render: r => <span style={{ fontSize: 13, color: 'var(--txt)' }}>{r.product || '—'}</span> },
  { key: 'disbursed_amount_kobo', label: 'Disbursed', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.disbursed_amount_kobo)}</span> },
  { key: 'rate_pct', label: 'Rate %', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{Number(r.rate_pct).toFixed(2)}%</span> },
  { key: 'days_active', label: 'Days Active', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{r.days_active}</span> },
  { key: 'interest_earned_kobo', label: 'Interest Earned', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: 600, color: GREEN }}>{fmtKobo(r.interest_earned_kobo)}</span> },
  { key: 'disbursed_at', label: 'Disbursed', sortable: true,
    render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.disbursed_at)}</span> },
  { key: 'maturity_date', label: 'Matures', sortable: true,
    render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
]

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

  // Load summary KPIs + chart whenever cycle changes
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

  // Load loans when tab active
  const loadLoans = useCallback(() => {
    apiFetch<LoanRow[]>('/api/finance/income/loans')
      .then(d => setLoans(d ?? []))
      .catch(() => {})
  }, [])

  // Load fee types when tab active
  const loadFees = useCallback(() => {
    const params = feeTypeFilter ? `?fee_type=${feeTypeFilter}` : ''
    apiFetch<FeeTypeResponse>(`/api/finance/income/fee-types${params}`)
      .then(d => setFeeData(d))
      .catch(() => {})
  }, [feeTypeFilter])

  useEffect(() => { if (tab === 'loans') loadLoans() }, [tab, loadLoans])
  useEffect(() => { if (tab === 'fees') loadFees() }, [tab, loadFees])

  // Cards breakdown: sort by interest desc
  const productRows = useMemo(() =>
    [...cycleData].sort((a, b) => b.total_interest_kobo - a.total_interest_kobo),
    [cycleData]
  )

  const chartProducts = useMemo(() =>
    productRows
      .filter(r => r.total_interest_kobo > 0 || r.total_fees_kobo > 0)
      .slice(0, 12)
      .map(r => ({
        product: r.product_name,
        interest: r.total_interest_kobo,
        fees: r.total_fees_kobo,
        penalty: r.total_penalty_kobo,
      })),
    [productRows]
  )

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

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
        <KpiCard label="Card Interest" value={fmtKobo(summary?.card_interest_kobo ?? 0)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="Card Fees & Penalties" value={fmtKobo((summary?.card_fees_kobo ?? 0) + (summary?.card_penalty_kobo ?? 0))} icon="receipt_long" accent={AMBER} loading={loading} />
        <KpiCard label="Fee Type Income" value={fmtKobo(summary?.fee_type_income_kobo ?? 0)} icon="loyalty" accent={NAVY} loading={loading} />
        <KpiCard label="Loan Interest Earned" value={loading ? '…' : loans.length ? fmtKobo(loans.reduce((s, r) => s + r.interest_earned_kobo, 0)) : '₦0'} icon="account_balance" accent={BLUE ?? GREEN} loading={loading} />
      </div>

      <Tabs
        tabs={[
          { key: 'cards',  label: 'Card Interest & Charges' },
          { key: 'loans',  label: 'Loans' },
          { key: 'fees',   label: 'Fee Types' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {/* ── CARDS TAB ───────────────────────────────────────────────────────── */}
      {tab === 'cards' && (
        <>
          {/* Current vs previous chart */}
          <SectionCard title="Income by Type" subtitle="Current cycle vs previous cycle" style={{ marginBottom: 16 }}>
            {loading ? <Sk h={200} /> : !chart.length ? (
              <EmptyState icon="bar_chart" message="No chart data available" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                  <XAxis dataKey="type" tick={{ fontSize: 12, fill: '#9AA4B8' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={84} />
                  <Tooltip content={<ChartTip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="current"  name="Current cycle"  fill={NAVY}    radius={[3,3,0,0]} />
                  <Bar dataKey="previous" name="Previous cycle" fill="#9AA4B8" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          {/* By product chart */}
          <SectionCard title="By Product" subtitle="Interest · Fees · Penalty" style={{ marginBottom: 16 }}>
            {loading ? <Sk h={240} /> : !chartProducts.length ? (
              <EmptyState icon="donut_large" message="No product data for this cycle" />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartProducts} margin={{ top: 4, right: 4, left: 0, bottom: 48 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                  <XAxis dataKey="product" tick={{ fontSize: 10, fill: '#9AA4B8' }} angle={-35} textAnchor="end" interval={0} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={84} />
                  <Tooltip content={<ChartTip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="interest" name="Interest"  fill={GREEN} radius={[3,3,0,0]} />
                  <Bar dataKey="fees"     name="Fees"      fill={AMBER} radius={[3,3,0,0]} />
                  <Bar dataKey="penalty"  name="Penalty"   fill={RED}   radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          {/* Product table */}
          <SectionCard padding={false}>
            {loading ? <Sk h={260} /> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Product', 'Category', 'Accounts', 'Interest', 'Fees', 'Penalty', 'Purchases', 'Cash Advance'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Product' || h === 'Category' ? 'left' : 'right', color: 'var(--txt2)', fontWeight: 600, fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {productRows.map(r => (
                    <tr key={r.product_code}
                      style={{ borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ padding: '10px 14px', fontWeight: 500, color: 'var(--txt)' }}>{r.product_name}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12,
                          background: r.category === 'prepaid' ? 'rgba(14,40,65,.08)' : 'rgba(192,0,0,.08)',
                          color: r.category === 'prepaid' ? NAVY : RED, textTransform: 'capitalize' }}>
                          {r.category}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{Number(r.account_count).toLocaleString()}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: GREEN, fontWeight: 600 }}>{fmtKobo(r.total_interest_kobo)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: AMBER }}>{fmtKobo(r.total_fees_kobo)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: RED }}>{fmtKobo(r.total_penalty_kobo)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.total_purchases_kobo)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.total_cash_advance_kobo)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: 'var(--th-bg)', fontWeight: 700 }}>
                    <td style={{ padding: '10px 14px', color: 'var(--txt)' }} colSpan={2}>Total</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM }}>{productRows.reduce((s,r) => s + Number(r.account_count), 0).toLocaleString()}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: GREEN }}>{fmtKobo(productRows.reduce((s,r) => s + r.total_interest_kobo, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: AMBER }}>{fmtKobo(productRows.reduce((s,r) => s + r.total_fees_kobo, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: RED }}>{fmtKobo(productRows.reduce((s,r) => s + r.total_penalty_kobo, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{fmtKobo(productRows.reduce((s,r) => s + r.total_purchases_kobo, 0))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{fmtKobo(productRows.reduce((s,r) => s + r.total_cash_advance_kobo, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </SectionCard>
        </>
      )}

      {/* ── LOANS TAB ───────────────────────────────────────────────────────── */}
      {tab === 'loans' && (
        loans.length === 0 ? (
          <SectionCard>
            <EmptyState icon="account_balance" message="No disbursed loans yet. Loan interest income will appear here once loans are active." />
          </SectionCard>
        ) : (
          <SectionCard padding={false}>
            <DataTable
              cols={LOAN_COLS}
              rows={loans}
              keyFn={r => r.id}
              emptyText="No disbursed loans"
            />
          </SectionCard>
        )
      )}

      {/* ── FEE TYPES TAB ───────────────────────────────────────────────────── */}
      {tab === 'fees' && (
        <>
          {/* Fee type summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
            {FEE_TYPES.map(ft => {
              const s = feeData?.summary?.find(r => r.fee_type === ft)
              const color = FEE_COLORS[ft]
              return (
                <div key={ft}
                  onClick={() => setFeeTypeFilter(feeTypeFilter === ft ? '' : ft)}
                  style={{
                    background: 'var(--card)', border: `1px solid ${feeTypeFilter === ft ? color : 'var(--bdr)'}`,
                    borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
                    boxShadow: feeTypeFilter === ft ? `0 0 0 2px ${color}33` : 'none',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color }}>{FEE_LABELS[ft]}</span>
                    {s ? (
                      <span style={{ fontSize: 11, color: 'var(--txt2)' }}>{Number(s.count).toLocaleString()} txns</span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--txt2)' }}>—</span>
                    )}
                  </div>
                  <div style={{ ...NUM, fontSize: 18, fontWeight: 700, color: s ? color : 'var(--txt2)' }}>
                    {s ? fmtKobo(s.total_kobo) : '₦0'}
                  </div>
                  {!s && (
                    <div style={{ fontSize: 10, color: 'var(--txt2)', marginTop: 4 }}>Pending data source</div>
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
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Date', 'Fee Type', 'Product', 'Amount', 'Currency'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Amount' ? 'right' : 'left', color: 'var(--txt2)', fontWeight: 600, fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {feeData.detail.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ padding: '10px 14px', ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.fee_date)}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <TypePill type={FEE_LABELS[r.fee_type] ?? r.fee_type} color={FEE_COLORS[r.fee_type] ?? '#9AA4B8'} />
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--txt)' }}>{r.product_name || '—'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, fontWeight: 600, color: NAVY }}>{fmtKobo(r.amount_kobo)}</td>
                      <td style={{ padding: '10px 14px', ...NUM, fontSize: 11.5, color: 'var(--txt2)' }}>{r.currency}</td>
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
