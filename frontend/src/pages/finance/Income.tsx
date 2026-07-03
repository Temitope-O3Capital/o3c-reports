import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Tabs, Sk, FilterBar, filterInputStyle } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Cycle {
  id: number
  cycle_date: string
  label: string
  loaded_at: string
  loaded_by_name: string
  interest_rows: number
  charge_rows: number
}

interface IncomeSummary {
  total_interest: number
  total_charges: number
  total_balance: number
  total_loc: number
  by_product: ProductIncome[]
  by_currency: CurrencyIncome[]
}

interface ProductIncome { product: string; interest: number; charges: number }
interface CurrencyIncome { currency: string; interest: number; charges: number }

interface AccountRow {
  id: number
  account_no: string
  customer_name: string
  product: string
  currency: string
  balance: number
  interest: number
  charges: number
  cycle_date: string
}

interface TrendPoint { month: string; interest: number; charges: number }

// ── Table columns ─────────────────────────────────────────────────────────────

const ACC_COLS: TableCol<AccountRow>[] = [
  { key: 'account_no', label: 'Account', sortable: true, width: 130,
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.account_no}</span> },
  { key: 'customer_name', label: 'Customer', sortable: true,
    render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.customer_name || '—'}</span> },
  { key: 'product', label: 'Product',
    render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.product || '—'}</span> },
  { key: 'currency', label: 'CCY', align: 'center', width: 60,
    render: r => <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600 }}>{r.currency}</span> },
  { key: 'balance', label: 'Balance ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.balance)}</span> },
  { key: 'interest', label: 'Interest ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: GREEN, fontWeight: 600 }}>{fmtKobo(r.interest)}</span> },
  { key: 'charges', label: 'Charges ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: AMBER, fontWeight: 600 }}>{fmtKobo(r.charges)}</span> },
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

// ── Accrual stub ───────────────────────────────────────────────────────────────

function AccrualTab() {
  return (
    <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--txt2)', fontSize: 13 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 32, opacity: 0.35, display: 'block', marginBottom: 8 }}>calculate</span>
      Daily FD accrual view pending Wave 4G backend endpoint <code>/api/finance/fd-accrual</code>.
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceIncome() {
  const [tab, setTab] = useState('income')
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [selectedCycle, setSelectedCycle] = useState<number | null>(null)
  const [summary, setSummary] = useState<IncomeSummary | null>(null)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Load cycles
  useEffect(() => {
    apiFetch<Cycle[]>('/api/income/cycles')
      .then(data => {
        setCycles(data ?? [])
        if (data?.length) setSelectedCycle(data[0].id)
      })
      .catch(e => setError(e.message))
  }, [])

  // Load trend
  useEffect(() => {
    apiFetch<TrendPoint[]>('/api/income/trend')
      .then(data => setTrend(data ?? []))
      .catch(() => {})
  }, [])

  // Load summary + accounts when cycle changes
  useEffect(() => {
    if (!selectedCycle) { setLoading(false); return }
    setLoading(true)
    Promise.allSettled([
      apiFetch<IncomeSummary>(`/api/income/summary?cycle_id=${selectedCycle}`),
    ]).then(([summaryRes]) => {
      if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value)
    }).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [selectedCycle])

  const loadAccounts = useCallback(async () => {
    if (!selectedCycle) return
    setLoadingAccounts(true)
    try {
      const res = await apiFetch<AccountRow[]>(`/api/income/accounts?cycle_id=${selectedCycle}`)
      setAccounts(res ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingAccounts(false)
    }
  }, [selectedCycle])

  useEffect(() => {
    if (tab === 'accounts') loadAccounts()
  }, [tab, loadAccounts])

  const filteredAccounts = accounts.filter(a =>
    !search || a.account_no.includes(search) || a.customer_name.toLowerCase().includes(search.toLowerCase())
  )

  const selectedCycleMeta = cycles.find(c => c.id === selectedCycle)

  return (
    <Page
      title="Income"
      subtitle={selectedCycleMeta ? `Cycle: ${selectedCycleMeta.label} · Loaded ${fmtDate(selectedCycleMeta.loaded_at)} by ${selectedCycleMeta.loaded_by_name}` : undefined}
      actions={
        <select
          value={selectedCycle ?? ''}
          onChange={e => setSelectedCycle(Number(e.target.value))}
          style={{ ...filterInputStyle, minWidth: 200 }}
        >
          {cycles.map(c => (
            <option key={c.id} value={c.id}>{c.label} ({fmtDate(c.cycle_date)})</option>
          ))}
        </select>
      }
    >
      <ErrBanner error={error} onRetry={() => setError(null)} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
        <KpiCard label="Interest Income" value={fmtKobo(summary?.total_interest ?? 0)} icon="trending_up" accent={GREEN} loading={loading} />
        <KpiCard label="Charges" value={fmtKobo(summary?.total_charges ?? 0)} icon="receipt" accent={AMBER} loading={loading} />
        <KpiCard label="Total Balance" value={fmtKobo(summary?.total_balance ?? 0)} icon="account_balance" accent={NAVY} loading={loading} />
        <KpiCard label="LOC Outstanding" value={fmtKobo(summary?.total_loc ?? 0)} icon="credit_score" accent={RED} loading={loading} />
      </div>

      <Tabs
        tabs={[
          { key: 'income', label: 'By Product' },
          { key: 'trend', label: 'Trend' },
          { key: 'accounts', label: 'Accounts' },
          { key: 'accrual', label: 'FD Accrual' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'income' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <SectionCard title="Income by Product" subtitle="Interest vs charges">
            {loading ? <Sk h={200} /> : !summary?.by_product?.length ? (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: 13 }}>No data for this cycle</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={summary.by_product} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                  <XAxis dataKey="product" tick={{ fontSize: 11, fill: '#9AA4B8' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={72} />
                  <Tooltip content={<IncomeTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="interest" name="Interest" fill={GREEN} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="charges" name="Charges" fill={AMBER} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          <SectionCard title="By Currency">
            {loading ? <Sk h={200} /> : !summary?.by_currency?.length ? (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: 13 }}>No data</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
                {summary.by_currency.map(c => (
                  <div key={c.currency} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--bg)', borderRadius: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ ...NUM, fontWeight: 700, fontSize: 13, color: 'var(--txt)' }}>{c.currency}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 20 }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 10, color: 'var(--txt2)', marginBottom: 2 }}>Interest</div>
                        <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: GREEN }}>{fmtKobo(c.interest)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 10, color: 'var(--txt2)', marginBottom: 2 }}>Charges</div>
                        <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: AMBER }}>{fmtKobo(c.charges)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {tab === 'trend' && (
        <SectionCard title="Income Trend" subtitle="Monthly interest + charges">
          {trend.length === 0 ? (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: 13 }}>No trend data available</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9AA4B8' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} width={72} />
                <Tooltip content={<IncomeTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="interest" name="Interest" fill={GREEN} radius={[3, 3, 0, 0]} stackId="a" />
                <Bar dataKey="charges" name="Charges" fill={AMBER} radius={[3, 3, 0, 0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      )}

      {tab === 'accounts' && (
        <>
          <FilterBar>
            <input
              placeholder="Search account or customer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...filterInputStyle, minWidth: 260 }}
            />
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
        </>
      )}

      {tab === 'accrual' && <SectionCard title="FD Daily Accrual"><AccrualTab /></SectionCard>}
    </Page>
  )
}
