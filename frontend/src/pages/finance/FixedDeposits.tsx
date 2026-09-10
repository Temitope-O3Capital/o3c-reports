import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, DataTable, Tabs, Pagination, ErrBanner, EmptyState, StatusBadge, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EBar, EArea } from '../../components/echarts'
import { apiFetch, unwrap, unwrapList } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum, fmtDate, fmtPct } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP } from '../../lib/design'

// Fixed Deposits — a READ-ONLY view of the live CBS deposit register
// (cbs_fixed_deposits, ~₦17.84bn book). The legacy workspace ops book
// (fd_transactions) and all of its manual booking / rollover / liquidate /
// early-withdrawal actions are retired: this page only reads and displays.
//
// Money contract: every *_kobo field (and the accrual list's `principal`) is in
// minor units — format with fmtKobo. Rates are already percentages — fmtPct.

// ── Response shapes ─────────────────────────────────────────────────────────
// /api/fd-book/kpis → WRAPPED object (respond → unwrap)
interface FDKpis {
  total_principal_kobo: number
  total_ledger_kobo: number
  total_accrued_interest_kobo: number
  active_count: number
  unique_customers: number
  weighted_avg_rate: number
  weighted_avg_tenor_days: number
  annualized_interest_expense_kobo: number
  maturing_30d_count: number
  maturing_30d_kobo: number
  new_this_month_count: number
}
// /api/fd-book/maturity-ladder → WRAPPED array (respond → unwrapList)
interface LadderBucket { bucket: string; count: number; principal_kobo: number; accrued_interest_kobo: number }
// /api/fd-book/book-trend → WRAPPED array
interface TrendPoint { date: string; active_count: number; principal_kobo: number; ledger_kobo: number }
// /api/fd-book/by-product → WRAPPED array
interface ProductRow { product: string; count: number; principal_kobo: number; accrued_interest_kobo: number; avg_rate: number; annual_interest_kobo: number }
// /api/fd-book/tenor-distribution → WRAPPED array
interface TenorBucket { bucket: string; count: number; principal_kobo: number }
// /api/fd-book/list → WRAPPED, DOUBLE-nested { data: { data: rows, total } } (respond wrapping a {data,total} map)
interface ListRow {
  cbs_account_number: string
  cbs_customer_id: string
  product_name: string
  status: string
  principal_kobo: number
  accrued_interest_kobo: number
  ledger_balance_kobo: number
  interest_rate: number
  tenor_days: number
  commencement_date: string
  date_booked: string
  maturity_date: string
}
// /api/finance/fd-accrual → BARE array (jsonRows → unwrapList defensively)
interface AccrualRow {
  id: string
  customer_name: string
  principal: number
  rate: number
  start_date: string
  maturity_date: string
  tenor_days: number
  days_elapsed: number
  accrued_interest_kobo: number
  daily_interest_kobo: number
}

const koboFmt = (v: number) => fmtKobo(v)

const PAGE_SIZE = 50

// ── Register columns (server-paginated) ─────────────────────────────────────
const LIST_COLS: TableCol<ListRow>[] = [
  {
    key: 'cbs_customer_id', label: 'Customer',
    render: r => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.cbs_customer_id || '—'}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>{r.cbs_account_number || '—'}</div>
      </div>
    ),
  },
  { key: 'product_name', label: 'Product', render: r => <span style={{ fontSize: TEXT.sm }}>{r.product_name || '—'}</span> },
  { key: 'principal_kobo', label: 'Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.principal_kobo)}</span> },
  { key: 'accrued_interest_kobo', label: 'Accrued', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: BLUE }}>{fmtKoboExact(r.accrued_interest_kobo)}</span> },
  { key: 'interest_rate', label: 'Rate', align: 'right', render: r => <span style={NUM}>{r.interest_rate != null ? fmtPct(r.interest_rate) : '—'}</span> },
  { key: 'tenor_days', label: 'Tenor', align: 'right', render: r => <span style={NUM}>{r.tenor_days != null ? `${fmtNum(r.tenor_days)}d` : '—'}</span> },
  { key: 'commencement_date', label: 'Commenced', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.commencement_date)}</span> },
  { key: 'maturity_date', label: 'Matures', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
  { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status || 'unknown'} size="sm" /> },
]

// ── Accrual columns (client-paginated bare list) ────────────────────────────
const ACCRUAL_COLS: TableCol<AccrualRow>[] = [
  { key: 'customer_name', label: 'Customer', render: r => <span style={{ fontWeight: FW.medium }}>{r.customer_name || '—'}</span> },
  { key: 'principal', label: 'Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.principal)}</span> },
  { key: 'rate', label: 'Rate', align: 'right', render: r => <span style={NUM}>{r.rate != null ? fmtPct(r.rate) : '—'}</span> },
  { key: 'start_date', label: 'Start', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.start_date)}</span> },
  { key: 'maturity_date', label: 'Matures', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
  { key: 'tenor_days', label: 'Tenor', align: 'right', render: r => <span style={NUM}>{r.tenor_days != null ? `${fmtNum(r.tenor_days)}d` : '—'}</span> },
  { key: 'days_elapsed', label: 'Elapsed', align: 'right', render: r => <span style={NUM}>{r.days_elapsed != null ? `${fmtNum(r.days_elapsed)}d` : '—'}</span> },
  { key: 'daily_interest_kobo', label: 'Daily interest', align: 'right', render: r => <span style={{ ...NUM, color: AMBER }}>{fmtKoboExact(r.daily_interest_kobo)}</span> },
  { key: 'accrued_interest_kobo', label: 'Accrued', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: BLUE }}>{fmtKoboExact(r.accrued_interest_kobo)}</span> },
]

const PRODUCT_COLS: TableCol<ProductRow>[] = [
  { key: 'product', label: 'Product', render: r => <span style={{ fontWeight: FW.medium }}>{r.product || '—'}</span> },
  { key: 'count', label: 'Deposits', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.count)}</span> },
  { key: 'principal_kobo', label: 'Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.principal_kobo)}</span> },
  { key: 'avg_rate', label: 'Avg rate', align: 'right', render: r => <span style={NUM}>{fmtPct(r.avg_rate)}</span> },
  { key: 'annual_interest_kobo', label: 'Annual interest', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: AMBER }}>{fmtKoboExact(r.annual_interest_kobo)}</span> },
]

type TabKey = 'overview' | 'register' | 'accrual'

export default function FixedDeposits() {
  const [tab, setTab] = useState<TabKey>('overview')

  const [kpis, setKpis] = useState<FDKpis | null>(null)
  const [ladder, setLadder] = useState<LadderBucket[]>([])
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [byProduct, setByProduct] = useState<ProductRow[]>([])
  const [tenor, setTenor] = useState<TenorBucket[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Register (server-paginated)
  const [listRows, setListRows] = useState<ListRow[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listPage, setListPage] = useState(1)
  const [listLoading, setListLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')

  // Accrual (bare list, client-paginated)
  const [accrual, setAccrual] = useState<AccrualRow[]>([])
  const [accrualLoading, setAccrualLoading] = useState(false)
  const [accrualLoaded, setAccrualLoaded] = useState(false)

  const loadOverview = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [k, l, t, p, tn] = await Promise.all([
        apiFetch('/api/fd-book/kpis'),
        apiFetch('/api/fd-book/maturity-ladder'),
        apiFetch('/api/fd-book/book-trend'),
        apiFetch('/api/fd-book/by-product'),
        apiFetch('/api/fd-book/tenor-distribution'),
      ])
      setKpis(unwrap<FDKpis>(k))
      setLadder(unwrapList<LadderBucket>(l))
      setTrend(unwrapList<TrendPoint>(t))
      setByProduct(unwrapList<ProductRow>(p))
      setTenor(unwrapList<TenorBucket>(tn))
    } catch (e: any) {
      setError(e?.message || 'Failed to load deposit book')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadOverview() }, [loadOverview])

  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const offset = (listPage - 1) * PAGE_SIZE
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (query.trim()) qs.set('q', query.trim())
      const res = await apiFetch(`/api/fd-book/list?${qs.toString()}`)
      // respond() wraps a {data,total} map → outer.data = { data: rows, total }
      const inner = unwrap<{ data?: ListRow[]; total?: number }>(res)
      setListRows(unwrapList<ListRow>(inner))
      setListTotal(Number(inner?.total ?? 0))
    } catch (e: any) {
      setError(e?.message || 'Failed to load register')
    } finally {
      setListLoading(false)
    }
  }, [listPage, query])

  useEffect(() => { if (tab === 'register') loadList() }, [tab, loadList])

  const loadAccrual = useCallback(async () => {
    setAccrualLoading(true)
    try {
      const res = await apiFetch('/api/finance/fd-accrual')
      setAccrual(unwrapList<AccrualRow>(res))
      setAccrualLoaded(true)
    } catch (e: any) {
      setError(e?.message || 'Failed to load accrual')
    } finally {
      setAccrualLoading(false)
    }
  }, [])

  useEffect(() => { if (tab === 'accrual' && !accrualLoaded) loadAccrual() }, [tab, accrualLoaded, loadAccrual])

  const runSearch = () => { setQuery(search); setListPage(1) }
  const listPages = Math.max(1, Math.ceil(listTotal / PAGE_SIZE))

  return (
    <Page title="Fixed Deposits" subtitle="Live CBS deposit book" loading={loading && !kpis} skeletonKpis={6}>
      <ErrBanner error={error} onRetry={loadOverview} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Book Size" value={fmtKoboExact(kpis?.total_principal_kobo ?? 0)} sub={`${fmtNum(kpis?.unique_customers ?? 0)} customers`} icon="savings" accent={NAVY} loading={loading} />
        <KpiCard label="Active Deposits" value={fmtNum(kpis?.active_count ?? 0)} sub={`${fmtNum(kpis?.new_this_month_count ?? 0)} new this month`} icon="account_balance" accent={GREEN} loading={loading} />
        <KpiCard label="Accrued Interest" value={fmtKoboExact(kpis?.total_accrued_interest_kobo ?? 0)} sub={`${fmtKoboExact(kpis?.annualized_interest_expense_kobo ?? 0)}/yr run-rate`} icon="trending_up" accent={BLUE} loading={loading} />
        <KpiCard label="Avg Rate" value={fmtPct(kpis?.weighted_avg_rate ?? 0)} sub="principal-weighted" icon="percent" accent={PURPLE} loading={loading} />
        <KpiCard label="Avg Tenor" value={`${fmtNum(kpis?.weighted_avg_tenor_days ?? 0)} days`} sub="principal-weighted" icon="schedule" accent={AMBER} loading={loading} />
        <KpiCard label="Maturing 30d" value={fmtKoboExact(kpis?.maturing_30d_kobo ?? 0)} sub={`${fmtNum(kpis?.maturing_30d_count ?? 0)} deposits`} icon="event_upcoming" accent={AMBER} loading={loading} />
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'register', label: 'Register', badge: listTotal || undefined },
          { key: 'accrual', label: 'Accrual' },
        ]}
        active={tab}
        onChange={k => setTab(k as TabKey)}
      />

      {/* ── Overview ───────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
            <SectionCard title="Maturity ladder" subtitle="Active principal by days to maturity">
              {ladder.length === 0
                ? <EmptyState icon="event" title={loading ? 'Loading…' : 'No maturity data'} />
                : <EBar<LadderBucket> data={ladder} xKey="bucket" series={[{ key: 'principal_kobo', name: 'Principal', color: NAVY }]} height={240} valueFmt={koboFmt} axisFmt={koboFmt} legend={false} />}
            </SectionCard>

            <SectionCard title="Tenor distribution" subtitle="Active principal by original tenor">
              {tenor.length === 0
                ? <EmptyState icon="bar_chart" title={loading ? 'Loading…' : 'No tenor data'} />
                : <EBar<TenorBucket> data={tenor} xKey="bucket" series={[{ key: 'principal_kobo', name: 'Principal', color: BLUE }]} height={240} valueFmt={koboFmt} axisFmt={koboFmt} legend={false} />}
            </SectionCard>
          </div>

          {trend.length > 0 && (
            <SectionCard title="Book size over time" subtitle="Daily CBS portfolio snapshot (last 90 days)" style={{ marginBottom: SP[5] }}>
              <EArea<TrendPoint> data={trend} xKey="date" series={[{ key: 'principal_kobo', name: 'Principal', color: GREEN }]} height={240} valueFmt={koboFmt} axisFmt={koboFmt} xTickSize={10} />
            </SectionCard>
          )}

          <SectionCard title="Book by product" subtitle="Active deposits split by FD product" padding={false}>
            <DataTable cols={PRODUCT_COLS} rows={byProduct} keyFn={(r, i) => r.product ?? i} loading={loading} emptyText="No products in the deposit book" pageSize={10} />
          </SectionCard>
        </>
      )}

      {/* ── Register ───────────────────────────────────────────────────────── */}
      {tab === 'register' && (
        <SectionCard
          title="Deposit register"
          subtitle="Live CBS fixed-deposit records"
          padding={false}
          actions={
            <SearchInput
              value={search}
              onChange={setSearch}
              onClear={() => { setSearch(''); setQuery(''); setListPage(1) }}
              onSearch={runSearch}
              placeholder="Search account, customer, product…"
              minWidth={260}
            />
          }
        >
          <DataTable cols={LIST_COLS} rows={listRows} keyFn={(r, i) => r.cbs_account_number ?? i} loading={listLoading} emptyText="No deposits found" />
          <Pagination
            page={listPage}
            pages={listPages}
            total={listTotal}
            pageSize={PAGE_SIZE}
            onPage={setListPage}
          />
        </SectionCard>
      )}

      {/* ── Accrual ────────────────────────────────────────────────────────── */}
      {tab === 'accrual' && (
        <SectionCard title="Interest accrual" subtitle="Per-deposit daily interest, highest accrued first" padding={false}>
          <DataTable
            cols={ACCRUAL_COLS}
            rows={accrual}
            keyFn={(r, i) => r.id ?? i}
            loading={accrualLoading}
            emptyText="No accruing deposits"
            searchKeys={['customer_name']}
            searchPlaceholder="Search customer…"
            pageSize={15}
          />
        </SectionCard>
      )}
    </Page>
  )
}
