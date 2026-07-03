import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Tabs, Sk, FilterBar, filterInputStyle } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CycleDate { cycle_date: string }

interface SummaryRow {
  cycle_date: string
  product_code: string
  product_name: string
  category: string
  card_type: string
  account_count: number
  overdue_accounts: number
  total_outstanding_kobo: number
  total_overdue_kobo: number
  total_interest_kobo: number
  total_fees_kobo: number
  total_penalty_kobo: number
  total_credit_limit_kobo: number
  total_purchases_kobo: number
  total_cash_advance_kobo: number
}

interface AccountRow {
  id: number
  account_number: string
  cif: string
  product_name: string
  category: string
  currency: string
  outstanding_balance_kobo: number
  interest_charged_kobo: number
  fees_kobo: number
  penalty_kobo: number
  overdue_amount_kobo: number
}

// ── Table columns ─────────────────────────────────────────────────────────────

const ACC_COLS: TableCol<AccountRow>[] = [
  { key: 'account_number', label: 'Account', sortable: true, width: 140,
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.account_number}</span> },
  { key: 'cif', label: 'CIF', width: 90,
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.cif}</span> },
  { key: 'product_name', label: 'Product', sortable: true,
    render: r => <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{r.product_name || r.category || '—'}</span> },
  { key: 'currency', label: 'CCY', align: 'center', width: 55,
    render: r => <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600 }}>{r.currency}</span> },
  { key: 'outstanding_balance_kobo', label: 'Outstanding', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.outstanding_balance_kobo)}</span> },
  { key: 'interest_charged_kobo', label: 'Interest', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: GREEN, fontWeight: 600 }}>{fmtKobo(r.interest_charged_kobo)}</span> },
  { key: 'fees_kobo', label: 'Fees', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: AMBER, fontWeight: 600 }}>{fmtKobo(r.fees_kobo)}</span> },
  { key: 'penalty_kobo', label: 'Penalty', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: RED, fontWeight: 600 }}>{fmtKobo(r.penalty_kobo)}</span> },
]

// ── Tooltip ───────────────────────────────────────────────────────────────────

function IncomeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: 'var(--txt)', marginBottom: 6 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.fill, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, color: 'var(--txt)', fontWeight: 600 }}>{fmtKobo(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceIncome() {
  const [tab, setTab] = useState('income')
  const [cycleDates, setCycleDates] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState<string>('')
  const [allSummary, setAllSummary] = useState<SummaryRow[]>([])
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [accountsTotal, setAccountsTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [accountOffset, setAccountOffset] = useState(0)
  const PAGE = 200

  // Load cycle dates
  useEffect(() => {
    apiFetch<CycleDate[]>('/api/cards/cycle-dates')
      .then(data => {
        const dates = (data ?? []).map(d => d.cycle_date)
        setCycleDates(dates)
        if (dates.length) setSelectedDate(dates[0])
      })
      .catch(e => setError(e.message))
  }, [])

  // Load all summary rows (for both current cycle view and trend)
  useEffect(() => {
    if (!cycleDates.length) return
    setLoading(true)
    apiFetch<SummaryRow[]>('/api/cards/cycle-summary')
      .then(data => setAllSummary(data ?? []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [cycleDates.length])

  // Current cycle rows
  const cycleRows = useMemo(
    () => allSummary.filter(r => r.cycle_date === selectedDate),
    [allSummary, selectedDate]
  )

  // KPIs — sum across all products for selected cycle
  const kpis = useMemo(() => ({
    interest:  cycleRows.reduce((s, r) => s + r.total_interest_kobo, 0),
    charges:   cycleRows.reduce((s, r) => s + r.total_fees_kobo + r.total_penalty_kobo, 0),
    outstanding: cycleRows.reduce((s, r) => s + r.total_outstanding_kobo, 0),
    creditLimit: cycleRows.reduce((s, r) => s + r.total_credit_limit_kobo, 0),
  }), [cycleRows])

  // By product chart data
  const byProduct = useMemo(() =>
    cycleRows
      .filter(r => r.total_interest_kobo > 0 || r.total_fees_kobo > 0)
      .map(r => ({
        product: r.product_name,
        interest: r.total_interest_kobo,
        charges: r.total_fees_kobo + r.total_penalty_kobo,
      }))
      .sort((a, b) => (b.interest + b.charges) - (a.interest + a.charges))
      .slice(0, 12),
    [cycleRows]
  )

  // By category breakdown (prepaid vs credit)
  const byCategory = useMemo(() => {
    const map: Record<string, { interest: number; charges: number; outstanding: number }> = {}
    for (const r of cycleRows) {
      const cat = r.category || 'other'
      if (!map[cat]) map[cat] = { interest: 0, charges: 0, outstanding: 0 }
      map[cat].interest    += r.total_interest_kobo
      map[cat].charges     += r.total_fees_kobo + r.total_penalty_kobo
      map[cat].outstanding += r.total_outstanding_kobo
    }
    return Object.entries(map).map(([cat, v]) => ({ cat, ...v }))
  }, [cycleRows])

  // Trend — group by cycle_date
  const trend = useMemo(() => {
    const map: Record<string, { interest: number; charges: number }> = {}
    for (const r of allSummary) {
      if (!map[r.cycle_date]) map[r.cycle_date] = { interest: 0, charges: 0 }
      map[r.cycle_date].interest += r.total_interest_kobo
      map[r.cycle_date].charges  += r.total_fees_kobo + r.total_penalty_kobo
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ month: fmtDate(date), ...v }))
  }, [allSummary])

  // Load accounts
  const loadAccounts = useCallback(async (offset = 0) => {
    if (!selectedDate) return
    setLoadingAccounts(true)
    try {
      const res = await apiFetch<{ data: AccountRow[]; total: number }>(
        `/api/cards/cycle-data?cycle_date=${selectedDate}&limit=${PAGE}&offset=${offset}`
      )
      setAccounts(res?.data ?? [])
      setAccountsTotal(res?.total ?? 0)
      setAccountOffset(offset)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingAccounts(false)
    }
  }, [selectedDate])

  useEffect(() => {
    if (tab === 'accounts') loadAccounts(0)
  }, [tab, loadAccounts])

  const filteredAccounts = search
    ? accounts.filter(a =>
        a.account_number.includes(search) ||
        a.cif.includes(search) ||
        (a.product_name ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : accounts

  return (
    <Page
      title="Income Statement"
      subtitle="Card billing cycle — interest, fees & charges"
      actions={
        <select
          value={selectedDate}
          onChange={e => { setSelectedDate(e.target.value); setTab('income') }}
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
        <KpiCard label="Interest Income" value={fmtKobo(kpis.interest)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="Fees & Penalties" value={fmtKobo(kpis.charges)} icon="receipt" accent={AMBER} loading={loading} />
        <KpiCard label="Outstanding Balance" value={fmtKobo(kpis.outstanding)} icon="account_balance" accent={NAVY} loading={loading} />
        <KpiCard label="Credit Limit in Use" value={fmtKobo(kpis.creditLimit)} icon="credit_score" accent={RED} loading={loading} />
      </div>

      <Tabs
        tabs={[
          { key: 'income', label: 'By Product' },
          { key: 'category', label: 'Prepaid vs Credit' },
          { key: 'trend', label: 'Trend' },
          { key: 'accounts', label: 'Accounts' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'income' && (
        <SectionCard title="Income by Product" subtitle="Interest vs fees + penalties">
          {loading ? <Sk h={260} /> : !byProduct.length ? (
            <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: 13 }}>
              No income data for this cycle
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={byProduct} margin={{ top: 4, right: 4, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                <XAxis dataKey="product" tick={{ fontSize: 10, fill: '#9AA4B8' }} angle={-35} textAnchor="end" interval={0} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={80} />
                <Tooltip content={<IncomeTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="interest" name="Interest" fill={GREEN} radius={[3, 3, 0, 0]} />
                <Bar dataKey="charges" name="Fees & Penalties" fill={AMBER} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      )}

      {tab === 'category' && (
        <SectionCard title="Prepaid vs Credit">
          {loading ? <Sk h={160} /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
              {byCategory.map(c => (
                <div key={c.cat} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--bg)', borderRadius: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--txt)', textTransform: 'capitalize' }}>{c.cat}</span>
                  <div style={{ display: 'flex', gap: 28 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: 'var(--txt2)', marginBottom: 2 }}>Interest</div>
                      <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: GREEN }}>{fmtKobo(c.interest)}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: 'var(--txt2)', marginBottom: 2 }}>Fees & Penalties</div>
                      <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: AMBER }}>{fmtKobo(c.charges)}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: 'var(--txt2)', marginBottom: 2 }}>Outstanding</div>
                      <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: NAVY }}>{fmtKobo(c.outstanding)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {tab === 'trend' && (
        <SectionCard title="Income Trend" subtitle="Monthly interest + fees across all cycles">
          {loading ? <Sk h={240} /> : !trend.length ? (
            <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: 13 }}>No trend data</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9AA4B8' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={80} />
                <Tooltip content={<IncomeTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="interest" name="Interest" fill={GREEN} radius={[3, 3, 0, 0]} stackId="a" />
                <Bar dataKey="charges" name="Fees & Penalties" fill={AMBER} radius={[3, 3, 0, 0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      )}

      {tab === 'accounts' && (
        <>
          <FilterBar>
            <input
              placeholder="Search account, CIF or product…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...filterInputStyle, minWidth: 260 }}
            />
            <span style={{ fontSize: 12, color: 'var(--txt2)', marginLeft: 'auto' }}>
              {accountsTotal.toLocaleString()} accounts · showing {accountOffset + 1}–{Math.min(accountOffset + PAGE, accountsTotal)}
            </span>
          </FilterBar>
          <SectionCard padding={false}>
            <DataTable
              cols={ACC_COLS}
              rows={filteredAccounts}
              keyFn={(r, i) => r.id ?? i}
              loading={loadingAccounts}
              emptyText="No accounts for this cycle"
            />
          </SectionCard>
          {accountsTotal > PAGE && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 12 }}>
              <button
                disabled={accountOffset === 0}
                onClick={() => loadAccounts(accountOffset - PAGE)}
                style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: accountOffset === 0 ? 'not-allowed' : 'pointer', opacity: accountOffset === 0 ? 0.4 : 1 }}
              >← Prev</button>
              <button
                disabled={accountOffset + PAGE >= accountsTotal}
                onClick={() => loadAccounts(accountOffset + PAGE)}
                style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: accountOffset + PAGE >= accountsTotal ? 'not-allowed' : 'pointer', opacity: accountOffset + PAGE >= accountsTotal ? 0.4 : 1 }}
              >Next →</button>
            </div>
          )}
        </>
      )}
    </Page>
  )
}
