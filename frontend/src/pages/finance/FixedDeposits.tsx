import { useEffect, useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, Tabs, ErrBanner, EmptyState } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EBar, EArea } from '../../components/echarts'
import FDRegister, { officerOf } from './FDRegister'
import OfficerCorrections from './OfficerCorrections'
import type { FDDeposit } from './FDRegister'
import { apiFetch, unwrap, unwrapList } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtCount, fmtDate, fmtPct } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP } from '../../lib/design'

// Fixed Deposits — a READ-ONLY view of the live CBS deposit register
// (cbs_fixed_deposits; ₦19.61bn across 229 active deposits at the time of
// writing — the book moves, so treat the figure as a scale, not a constant).
// The legacy workspace ops book
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
// /api/cbs/reports/fd-book → BARE object { summary, by_status, by_product,
// maturity_ladder, fixed_deposits }. The register tab reads `fixed_deposits`: it is the
// whole CBS register in one unpaginated call, and the only source that carries Udara's
// own customer name, which the grouped view needs. Gated on the same `fixed_deposit`
// page as /api/fd-book/*, so no extra access is implied.
interface CBSFDBook { fixed_deposits?: FDDeposit[] }
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

// The register is grouped from /api/cbs/reports/fd-book, which returns the whole book
// in one stable call but no account officer. The officer lives on /api/fd-book/list as
// `officer_name` (Udara's raw->>'accountOfficerName' crosswalked through
// app.cbs_officer_map to the workspace user). So page that endpoint once and graft the
// officer on by account number — the two read the same cbs_fixed_deposits rows and
// account numbers are unique across all 380. Self-disabling: the moment the grouped
// source starts returning an officer of its own, this is never called again.
//
// Best-effort throughout. An officer we cannot resolve costs a name in one column; it
// must never cost the register itself, so every failure path returns the rows unchanged.
// NOTE: fdBookList's ORDER BY has no tiebreaker, so a deposit sharing a maturity date
// with another can in principle fall between the two pages and come back without an
// officer. Harmless here (the cell shows "—"), and it goes away entirely once either
// the list ORDER BY gains a tiebreaker or the grouped source carries the officer.
async function graftOfficers(rows: FDDeposit[]): Promise<FDDeposit[]> {
  const byAccount = new Map<string, string>()
  try {
    const LIMIT = 200
    for (let offset = 0; offset < 5_000; offset += LIMIT) {
      const res = await apiFetch(`/api/fd-book/list?limit=${LIMIT}&offset=${offset}`)
      // respond() wraps a {data,total} map → outer.data = { data: rows, total }
      const inner = unwrap<{ data?: FDDeposit[]; total?: number }>(res)
      const page = unwrapList<FDDeposit>(inner)
      for (const r of page) {
        const officer = officerOf(r)
        if (officer && r?.cbs_account_number) byAccount.set(String(r.cbs_account_number), officer)
      }
      if (page.length < LIMIT || offset + LIMIT >= Number(inner?.total ?? 0)) break
    }
  } catch {
    return rows
  }
  if (!byAccount.size) return rows
  return rows.map(r => {
    const officer = byAccount.get(String(r.cbs_account_number))
    return officer ? { ...r, officer_name: officer } : r
  })
}

// ── Accrual columns (client-paginated bare list) ────────────────────────────
const ACCRUAL_COLS: TableCol<AccrualRow>[] = [
  { key: 'customer_name', label: 'Customer', render: r => <span style={{ fontWeight: FW.medium }}>{r.customer_name || '—'}</span> },
  { key: 'principal', label: 'Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.principal)}</span> },
  { key: 'rate', label: 'Rate', align: 'right', render: r => <span style={NUM}>{r.rate != null ? fmtPct(r.rate) : '—'}</span> },
  { key: 'start_date', label: 'Start', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.start_date)}</span> },
  { key: 'maturity_date', label: 'Matures', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
  { key: 'tenor_days', label: 'Tenor', align: 'right', render: r => <span style={NUM}>{r.tenor_days != null ? `${fmtCount(r.tenor_days)}d` : '—'}</span> },
  { key: 'days_elapsed', label: 'Elapsed', align: 'right', render: r => <span style={NUM}>{r.days_elapsed != null ? `${fmtCount(r.days_elapsed)}d` : '—'}</span> },
  { key: 'daily_interest_kobo', label: 'Daily Interest', align: 'right', render: r => <span style={{ ...NUM, color: AMBER }}>{fmtKoboExact(r.daily_interest_kobo)}</span> },
  { key: 'accrued_interest_kobo', label: 'Accrued', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: BLUE }}>{fmtKoboExact(r.accrued_interest_kobo)}</span> },
]

const PRODUCT_COLS: TableCol<ProductRow>[] = [
  { key: 'product', label: 'Product', render: r => <span style={{ fontWeight: FW.medium }}>{r.product || '—'}</span> },
  { key: 'count', label: 'Deposits', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtCount(r.count)}</span> },
  { key: 'principal_kobo', label: 'Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.principal_kobo)}</span> },
  { key: 'avg_rate', label: 'Avg Rate', align: 'right', render: r => <span style={NUM}>{fmtPct(r.avg_rate)}</span> },
  { key: 'annual_interest_kobo', label: 'Annual Interest', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: AMBER }}>{fmtKoboExact(r.annual_interest_kobo)}</span> },
]

type TabKey = 'overview' | 'register' | 'accrual' | 'officers'
const TAB_KEYS: TabKey[] = ['overview', 'register', 'accrual', 'officers']
const isTabKey = (v: string | null): v is TabKey => !!v && (TAB_KEYS as string[]).includes(v)

export default function FixedDeposits() {
  // The URL is the source of truth for the tab, not local state. FD maturity alerts
  // deep-link to /deposits?tab=register&q=<account number> (handlers/account_alerts.go
  // fdDeepLink), and App.tsx redirects the retired /finance/fd-* routes to ?tab= too;
  // while the tab lived only in useState every one of those links silently landed on
  // Overview. Switching tabs writes the key back so a link is shareable, with
  // { replace: true } so tabbing around does not fill the back button with the same page.
  const [params, setParams] = useSearchParams()
  const tab: TabKey = isTabKey(params.get('tab')) ? (params.get('tab') as TabKey) : 'overview'
  const setTab = useCallback((key: string) => {
    setParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('tab', key)
      // `q` is a register-scoped filter; carrying it onto another tab would leave an
      // invisible filter set on a screen with no search box to clear it from.
      if (key !== 'register') next.delete('q')
      return next
    }, { replace: true })
  }, [setParams])

  // Deep-link filter for the register. FDRegister owns its own search box, so rather
  // than reaching into its state this narrows the rows handed to it and shows a
  // clearable chip saying so — the officer can see exactly what they are looking at and
  // get back to the whole book in one click.
  const q = (params.get('q') ?? '').trim()
  const clearQ = useCallback(() => {
    setParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('q')
      return next
    }, { replace: true })
  }, [setParams])

  const [kpis, setKpis] = useState<FDKpis | null>(null)
  const [ladder, setLadder] = useState<LadderBucket[]>([])
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [byProduct, setByProduct] = useState<ProductRow[]>([])
  const [tenor, setTenor] = useState<TenorBucket[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Register — the whole CBS register, loaded once and grouped per customer client-side
  const [register, setRegister] = useState<FDDeposit[]>([])
  const [registerLoading, setRegisterLoading] = useState(false)
  const [registerLoaded, setRegisterLoaded] = useState(false)

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

  const loadRegister = useCallback(async () => {
    setRegisterLoading(true)
    try {
      const res = await apiFetch<CBSFDBook>('/api/cbs/reports/fd-book')
      let rows = Array.isArray(res?.fixed_deposits) ? res.fixed_deposits : []
      if (rows.length && !rows.some(officerOf)) rows = await graftOfficers(rows)
      setRegister(rows)
      setRegisterLoaded(true)
    } catch (e: any) {
      setError(e?.message || 'Failed to load register')
    } finally {
      setRegisterLoading(false)
    }
  }, [])

  useEffect(() => { if (tab === 'register' && !registerLoaded) loadRegister() }, [tab, registerLoaded, loadRegister])

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

  // Rows the register renders under a ?q= deep link. Matched on the same fields
  // FDRegister's own search box matches (account number, Udara customer id, customer
  // name) so arriving by link and typing the string by hand behave the same way.
  const registerRows = useMemo(() => {
    if (!q) return register
    const needle = q.toLowerCase()
    return register.filter(d =>
      String(d.cbs_account_number ?? '').toLowerCase().includes(needle) ||
      String(d.cbs_customer_id ?? '').toLowerCase().includes(needle) ||
      String(d.customer_name ?? '').toLowerCase().includes(needle))
  }, [register, q])

  return (
    <Page title="Fixed Deposits" subtitle="Live CBS deposit book" loading={loading && !kpis} skeletonKpis={6}>
      <ErrBanner error={error} onRetry={loadOverview} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Book Size" value={fmtKoboExact(kpis?.total_principal_kobo ?? 0)} sub={`${fmtCount(kpis?.unique_customers ?? 0)} customers`} icon="savings" accent={NAVY} loading={loading} />
        <KpiCard label="Active Deposits" value={fmtCount(kpis?.active_count ?? 0)} sub={`${fmtCount(kpis?.new_this_month_count ?? 0)} new this month`} icon="account_balance" accent={GREEN} loading={loading} />
        <KpiCard label="Accrued Interest" value={fmtKoboExact(kpis?.total_accrued_interest_kobo ?? 0)} sub={`${fmtKoboExact(kpis?.annualized_interest_expense_kobo ?? 0)}/yr run-rate`} icon="trending_up" accent={BLUE} loading={loading} />
        <KpiCard label="Avg Rate" value={fmtPct(kpis?.weighted_avg_rate ?? 0)} sub="principal-weighted" icon="percent" accent={PURPLE} loading={loading} />
        <KpiCard label="Avg Tenor" value={`${fmtCount(kpis?.weighted_avg_tenor_days ?? 0)} days`} sub="principal-weighted" icon="schedule" accent={AMBER} loading={loading} />
        <KpiCard label="Maturing 30d" value={fmtKoboExact(kpis?.maturing_30d_kobo ?? 0)} sub={`${fmtCount(kpis?.maturing_30d_count ?? 0)} deposits`} icon="event_upcoming" accent={AMBER} loading={loading} />
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          // The register opens on the Active book, so the badge counts the customers
          // holding it — the same figure the KPI strip shows, and the row count now
          // that the register is one row per customer.
          { key: 'register', label: 'Register', badge: kpis?.unique_customers || undefined },
          { key: 'accrual', label: 'Accrual' },
          // The officer on a deposit comes from Udara and could not be corrected
          // anywhere until migration 284 — Udara's API has no endpoint that can
          // change one. This is where a wrong one gets fixed.
          { key: 'officers', label: 'Officer Corrections' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {/* ── Overview ───────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
            <SectionCard title="Maturity Ladder" subtitle="Active principal by days to maturity">
              {ladder.length === 0
                ? <EmptyState icon="event" title={loading ? 'Loading…' : 'No Maturity Data'} />
                : <EBar<LadderBucket> data={ladder} xKey="bucket" series={[{ key: 'principal_kobo', name: 'Principal', color: NAVY }]} height={240} valueFmt={koboFmt} axisFmt={koboFmt} legend={false} />}
            </SectionCard>

            <SectionCard title="Tenor Distribution" subtitle="Active principal by original tenor">
              {tenor.length === 0
                ? <EmptyState icon="bar_chart" title={loading ? 'Loading…' : 'No Tenor Data'} />
                : <EBar<TenorBucket> data={tenor} xKey="bucket" series={[{ key: 'principal_kobo', name: 'Principal', color: BLUE }]} height={240} valueFmt={koboFmt} axisFmt={koboFmt} legend={false} />}
            </SectionCard>
          </div>

          {trend.length > 0 && (
            <SectionCard title="Book Size Over Time" subtitle="Daily CBS portfolio snapshot (last 90 days)" style={{ marginBottom: SP[5] }}>
              <EArea<TrendPoint> data={trend} xKey="date" series={[{ key: 'principal_kobo', name: 'Principal', color: GREEN }]} height={240} valueFmt={koboFmt} axisFmt={koboFmt} xTickSize={10} />
            </SectionCard>
          )}

          <SectionCard title="Book by Product" subtitle="Active deposits split by FD product" padding={false}>
            <DataTable cols={PRODUCT_COLS} rows={byProduct} keyFn={(r, i) => r.product ?? i} loading={loading} emptyText="No products in the deposit book" pageSize={10} />
          </SectionCard>
        </>
      )}

      {/* ── Register ───────────────────────────────────────────────────────── */}
      {tab === 'register' && (
        <>
          {q && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[3],
              padding: '7px 12px', background: 'var(--card)', border: '1px solid var(--bdr)',
              borderRadius: 999, width: 'fit-content', maxWidth: '100%',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: AMBER }}>filter_alt</span>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                Filtered To <span style={{ ...NUM, fontWeight: FW.semibold, color: 'var(--txt)' }}>{q}</span>
                {' · '}{fmtCount(registerRows.length)} of {fmtCount(register.length)} deposits
              </span>
              <button
                type="button" onClick={clearQ} title="Show the whole register"
                style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--txt3)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
              </button>
            </div>
          )}
          <FDRegister deposits={registerRows} loading={registerLoading && !registerLoaded} />
        </>
      )}

      {/* ── Accrual ────────────────────────────────────────────────────────── */}
      {tab === 'accrual' && (
        <SectionCard title="Interest Accrual" subtitle="Per-deposit daily interest, highest accrued first" padding={false}>
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

      {/* ── Officer corrections ────────────────────────────────────────────── */}
      {tab === 'officers' && <OfficerCorrections />}
    </Page>
  )
}
