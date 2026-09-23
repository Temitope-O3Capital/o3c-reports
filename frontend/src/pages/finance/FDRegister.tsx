import { Fragment, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { SectionCard, ExpandableFilterBar, StatusBadge, Pill, EmptyState, Pagination, Sk } from '../../components/UI'
import { fmtKoboExact, fmtCount, fmtDate, fmtPct } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM, TEXT, FW, INTER } from '../../lib/design'

// Fixed-Deposit register, grouped one row per customer.
//
// Why this shape: a customer holding several deposits used to occupy several rows that
// read as duplicates — SULE BABA (Udara ID 00000412) genuinely holds 2876365421, 8046093429
// and 10000041201. The active book is 230 deposits across 142 customers, so grouping
// collapses it to one row each. 97 of those 142 hold exactly ONE deposit, which is why a
// single-deposit customer gets no disclosure control: its row already *is* the deposit,
// and carries the account number, product, tenor and commencement inline. Only a
// customer with more than one deposit becomes expandable.
//
// READ-ONLY, like the page that hosts it — no booking / rollover / liquidation here.

// ── Data ──────────────────────────────────────────────────────────────────────
// One row of /api/cbs/reports/fd-book → fixed_deposits. That endpoint is used rather
// than /api/fd-book/list because grouping needs the WHOLE register in one shot, and
// the list endpoint cannot give it: limit is clamped to 200, so 380 deposits take two
// OFFSET pages, and its ORDER BY ends on maturity_date with no tiebreaker — deposits
// sharing a maturity date can reshuffle between the two queries and be served twice or
// not at all. Fine for a page of a flat table; not fine when the page totals money per
// customer. Both endpoints are gated on the same `fixed_deposit` page, so this is not a
// wider grant. Dates arrive as timestamps; only the YYYY-MM-DD head is ever used.
export interface FDDeposit {
  cbs_account_number: string
  cbs_customer_id: string
  customer_name: string | null
  product_name: string | null
  status: string
  principal_kobo: number
  accrued_interest_kobo: number
  ledger_balance_kobo: number
  interest_rate: number | null
  tenor_days: number | null
  date_booked: string | null
  commencement_date: string | null
  maturity_date: string | null
  // Account officer. Udara carries `accountOfficerName` on all 380 deposits (20 distinct
  // officers); the backend is exposing it as `officer_name` — the name cbs_loans already
  // uses for the same idea. Optional on purpose: if the backend half lands after this
  // one, the officer column and filter simply hide themselves rather than showing a
  // column of dashes.
  officer_name?: string | null
  account_officer_name?: string | null
}

/** The account officer on a deposit; '' when the backend has not supplied one. */
export const officerOf = (d: FDDeposit): string =>
  String(d.officer_name ?? d.account_officer_name ?? '').trim()

interface FDCustomer {
  cif: string
  name: string
  deposits: FDDeposit[]
  principal_kobo: number
  accrued_kobo: number
  /** Principal-weighted, NOT a contractual rate — see the Rate column. */
  blended_rate: number | null
  rate_lo: number | null
  rate_hi: number | null
  product: string
  /** Every distinct officer across this customer's deposits, in first-seen order. */
  officers: string[]
  next_maturity: string
  next_days: number | null
  past_due: number
  due_30: number
  haystack: string
}

const DUE_SOON_DAYS = 30
const PAGE_SIZE = 25

const num = (v: unknown) => { const x = Number(v); return isFinite(x) ? x : 0 }
const dayKey = (s?: string | null) => (s ? String(s).slice(0, 10) : '')

/** Whole days from today to a YYYY-MM-DD date; negative means already past. */
function daysUntil(d: string): number {
  const [y, m, dd] = d.split('-').map(Number)
  if (!y || !m || !dd) return 0
  const now = new Date()
  const target = new Date(y, m - 1, dd).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((target - today) / 86_400_000)
}

function maturityNote(days: number): string {
  if (days < 0) return `${fmtCount(-days)} days past due`
  if (days === 0) return 'matures today'
  if (days === 1) return 'in 1 day'
  return `in ${fmtCount(days)} days`
}

function maturityTone(days: number | null): string {
  if (days == null) return 'var(--txt3)'
  if (days < 0) return RED
  if (days <= DUE_SOON_DAYS) return AMBER
  return 'var(--txt3)'
}

/** Group a flat deposit list by customer (cbs_customer_id is the identity). */
function groupByCustomer(rows: FDDeposit[]): FDCustomer[] {
  const byCif = new Map<string, FDDeposit[]>()
  for (const d of rows) {
    const cif = (d.cbs_customer_id ?? '').trim() || '—'
    const bucket = byCif.get(cif)
    if (bucket) bucket.push(d)
    else byCif.set(cif, [d])
  }

  const out: FDCustomer[] = []
  for (const [cif, deposits] of byCif) {
    deposits.sort((a, b) => num(b.principal_kobo) - num(a.principal_kobo))

    // Udara's own name, kept exactly as stored (it is trimmed, never re-cased).
    const name = (deposits.find(d => (d.customer_name ?? '').trim())?.customer_name ?? '').trim()

    let principal = 0, accrued = 0, rateWeight = 0, ratePrincipal = 0
    let rateLo: number | null = null, rateHi: number | null = null
    let nextMaturity = '', pastDue = 0, dueSoon = 0
    const products = new Set<string>()
    const officers = new Set<string>()

    for (const d of deposits) {
      const p = num(d.principal_kobo)
      principal += p
      accrued += num(d.accrued_interest_kobo)

      if (d.interest_rate != null && p > 0) {
        const r = num(d.interest_rate)
        rateWeight += p * r
        ratePrincipal += p
        rateLo = rateLo == null ? r : Math.min(rateLo, r)
        rateHi = rateHi == null ? r : Math.max(rateHi, r)
      }

      const prod = (d.product_name ?? '').trim()
      if (prod) products.add(prod)

      // Held per deposit, not per customer: today every customer's deposits sit with a
      // single officer, but nothing in the data guarantees it, so a split book is shown
      // as such rather than silently picking one name.
      const off = officerOf(d)
      if (off) officers.add(off)

      const mat = dayKey(d.maturity_date)
      if (mat && (!nextMaturity || mat < nextMaturity)) nextMaturity = mat
      // Only a live deposit can be past due or falling due — a Closed one has
      // already been paid out, and counting it would raise a false alarm.
      if (mat && d.status === 'Active') {
        const dd = daysUntil(mat)
        if (dd < 0) pastDue++
        else if (dd <= DUE_SOON_DAYS) dueSoon++
      }
    }

    const productList = [...products]
    const officerList = [...officers]
    out.push({
      cif,
      name: name || cif,
      deposits,
      principal_kobo: principal,
      accrued_kobo: accrued,
      blended_rate: ratePrincipal > 0 ? rateWeight / ratePrincipal : null,
      rate_lo: rateLo,
      rate_hi: rateHi,
      product: productList.length === 1 ? productList[0] : productList.length ? `${fmtCount(productList.length)} products` : '—',
      officers: officerList,
      next_maturity: nextMaturity,
      next_days: nextMaturity ? daysUntil(nextMaturity) : null,
      past_due: pastDue,
      due_30: dueSoon,
      haystack: [name, cif, ...deposits.map(d => d.cbs_account_number), ...productList, ...officerList].join(' ').toLowerCase(),
    })
  }
  return out
}

// ── Table chrome (matches DataTable so the register reads as one system) ──────

const thBase: CSSProperties = {
  padding: '11px 14px', fontSize: 11, fontWeight: 700,
  color: 'var(--txt2)', textTransform: 'uppercase', fontFamily: INTER,
  letterSpacing: '0.6px', whiteSpace: 'nowrap', userSelect: 'none',
  borderBottom: '1px solid var(--bdr)', textAlign: 'left',
}
const tdBase: CSSProperties = {
  padding: '12px 14px', fontSize: 13.5, color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
}
const subText: CSSProperties = { fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }

type SortKey = 'name' | 'officer' | 'count' | 'principal_kobo' | 'accrued_kobo' | 'blended_rate' | 'next_maturity'

interface ColDef {
  key: SortKey | 'expand' | 'product' | 'attention'
  label: string
  align?: 'left' | 'right'
  sortable?: boolean
  width?: number
}

/** The Officer column appears only once the deposits actually carry an officer. */
function columns(withOfficer: boolean): ColDef[] {
  return [
    { key: 'expand', label: '', width: 38 },
    { key: 'name', label: 'Customer', sortable: true },
    { key: 'product', label: 'Product' },
    ...(withOfficer ? [{ key: 'officer', label: 'Account Officer', sortable: true } as ColDef] : []),
    { key: 'count', label: 'Deposits', align: 'right', sortable: true },
    { key: 'principal_kobo', label: 'Principal', align: 'right', sortable: true },
    { key: 'accrued_kobo', label: 'Accrued Interest', align: 'right', sortable: true },
    { key: 'blended_rate', label: 'Rate', align: 'right', sortable: true },
    { key: 'next_maturity', label: 'Next Maturity', sortable: true },
    { key: 'attention', label: 'Attention' },
  ]
}

function SortHeader({ col, sortKey, sortDir, onSort }: {
  col: ColDef; sortKey: SortKey; sortDir: 'asc' | 'desc'; onSort: (k: SortKey) => void
}) {
  const active = col.sortable === true && sortKey === col.key
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
      style={{ ...thBase, width: col.width, textAlign: col.align ?? 'left', color: active ? 'var(--txt)' : 'var(--txt2)' }}
    >
      {col.sortable ? (
        <button
          type="button"
          onClick={() => onSort(col.key as SortKey)}
          title={`Sort by ${col.label}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: 0, margin: 0, border: 'none', background: 'none',
            font: 'inherit', color: 'inherit', letterSpacing: 'inherit',
            textTransform: 'inherit', textAlign: 'inherit', cursor: 'pointer',
          }}
        >
          {col.label}
          <span aria-hidden="true" style={{ color: RED, opacity: active ? 1 : 0.3, fontSize: 11 }}>
            {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </button>
      ) : col.label}
    </th>
  )
}

/** Attention toggle shown in the card header, so urgency is never hidden in a collapsed row. */
function AttentionToggle({ on, count, label, color, onClick }: {
  on: boolean; count: number; label: string; color: string; onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      disabled={count === 0}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 11px', borderRadius: 8,
        fontSize: 12.5, fontWeight: FW.semibold, fontFamily: INTER,
        border: `1.5px solid ${on ? color : 'var(--input-bdr)'}`,
        background: on ? `${color}14` : 'transparent',
        color: count === 0 ? 'var(--txt3)' : on ? color : 'var(--txt2)',
        cursor: count === 0 ? 'default' : 'pointer', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtCount(count)}</span>
      {label}
    </button>
  )
}

// ── Per-deposit detail (only rendered for customers holding more than one) ────

function DepositTable({ deposits, withOfficer }: { deposits: FDDeposit[]; withOfficer: boolean }) {
  const sub: CSSProperties = { ...thBase, padding: '8px 12px', fontSize: 10.5, borderBottom: '1px solid var(--bdr)' }
  const cell: CSSProperties = { ...tdBase, padding: '9px 12px', fontSize: 13 }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', margin: '4px 0 10px' }}>
      <thead>
        <tr>
          <th style={sub}>Account</th>
          <th style={sub}>Product</th>
          {withOfficer && <th style={sub}>Account Officer</th>}
          <th style={{ ...sub, textAlign: 'right' }}>Principal</th>
          <th style={{ ...sub, textAlign: 'right' }}>Rate</th>
          <th style={{ ...sub, textAlign: 'right' }}>Tenor</th>
          <th style={sub}>Commenced</th>
          <th style={sub}>Matures</th>
          <th style={{ ...sub, textAlign: 'right' }}>Accrued</th>
          <th style={sub}>Status</th>
        </tr>
      </thead>
      <tbody>
        {deposits.map(d => {
          const mat = dayKey(d.maturity_date)
          const days = mat ? daysUntil(mat) : null
          const live = d.status === 'Active'
          return (
            <tr key={d.cbs_account_number} style={{ background: 'var(--card)' }}>
              <td style={cell}><span style={{ ...NUM, fontWeight: FW.semibold, color: NAVY }}>{d.cbs_account_number || '—'}</span></td>
              <td style={cell}><span style={{ fontSize: TEXT.sm }}>{d.product_name || '—'}</span></td>
              {withOfficer && (
                <td style={cell}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{officerOf(d) || '—'}</span></td>
              )}
              <td style={{ ...cell, textAlign: 'right' }}><span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(d.principal_kobo)}</span></td>
              <td style={{ ...cell, textAlign: 'right' }}><span style={NUM}>{d.interest_rate != null ? fmtPct(d.interest_rate) : '—'}</span></td>
              <td style={{ ...cell, textAlign: 'right' }}><span style={NUM}>{d.tenor_days != null ? `${fmtCount(d.tenor_days)}d` : '—'}</span></td>
              <td style={cell}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(dayKey(d.commencement_date))}</span></td>
              <td style={cell}>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(mat)}</div>
                {days != null && live && (days < 0 || days <= DUE_SOON_DAYS) && (
                  <div style={{ ...subText, color: maturityTone(days), fontWeight: FW.semibold }}>{maturityNote(days)}</div>
                )}
              </td>
              <td style={{ ...cell, textAlign: 'right' }}><span style={{ ...NUM, color: BLUE }}>{fmtKoboExact(d.accrued_interest_kobo)}</span></td>
              <td style={cell}><StatusBadge status={d.status || 'unknown'} size="sm" /></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Register ──────────────────────────────────────────────────────────────────

export default function FDRegister({ deposits, loading }: { deposits: FDDeposit[]; loading: boolean }) {
  const [search, setSearch] = useState('')
  const [fStatus, setFStatus] = useState<Set<string>>(new Set(['Active']))
  const [fProduct, setFProduct] = useState<Set<string>>(new Set())
  const [fOfficer, setFOfficer] = useState<Set<string>>(new Set())
  const [onlyPastDue, setOnlyPastDue] = useState(false)
  const [onlyDueSoon, setOnlyDueSoon] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('principal_kobo')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)

  const statusOptions = useMemo(() => {
    const seen = new Map<string, number>()
    for (const d of deposits) {
      const s = (d.status ?? '').trim() || 'Unknown'
      seen.set(s, (seen.get(s) ?? 0) + 1)
    }
    return [...seen].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({
      value, count, color: value === 'Active' ? GREEN : NAVY,
    }))
  }, [deposits])

  const productOptions = useMemo(() => {
    const seen = new Map<string, number>()
    for (const d of deposits) {
      const p = (d.product_name ?? '').trim()
      if (p) seen.set(p, (seen.get(p) ?? 0) + 1)
    }
    return [...seen].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }))
  }, [deposits])

  const officerOptions = useMemo(() => {
    const seen = new Map<string, number>()
    for (const d of deposits) {
      const o = officerOf(d)
      if (o) seen.set(o, (seen.get(o) ?? 0) + 1)
    }
    // Busiest desk first; officer names are shown exactly as Udara stores them.
    return [...seen].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }))
  }, [deposits])

  const withOfficer = officerOptions.length > 0
  const COLS = useMemo(() => columns(withOfficer), [withOfficer])

  // Deposits are filtered first, then grouped, so every customer-level total
  // describes exactly the deposits in scope rather than the whole book.
  const customers = useMemo(() => {
    const scoped = deposits.filter(d =>
      (!fStatus.size || fStatus.has((d.status ?? '').trim() || 'Unknown')) &&
      (!fProduct.size || fProduct.has((d.product_name ?? '').trim())) &&
      (!fOfficer.size || fOfficer.has(officerOf(d)))
    )
    return groupByCustomer(scoped)
  }, [deposits, fStatus, fProduct, fOfficer])

  const pastDueCustomers = useMemo(() => customers.filter(c => c.past_due > 0).length, [customers])
  const dueSoonCustomers = useMemo(() => customers.filter(c => c.due_30 > 0).length, [customers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = customers
    if (q) out = out.filter(c => c.haystack.includes(q))
    if (onlyPastDue) out = out.filter(c => c.past_due > 0)
    if (onlyDueSoon) out = out.filter(c => c.due_30 > 0)

    const dir = sortDir === 'asc' ? 1 : -1
    return [...out].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'officer': cmp = (a.officers[0] ?? '').localeCompare(b.officers[0] ?? ''); break
        case 'count': cmp = a.deposits.length - b.deposits.length; break
        case 'principal_kobo': cmp = a.principal_kobo - b.principal_kobo; break
        case 'accrued_kobo': cmp = a.accrued_kobo - b.accrued_kobo; break
        case 'blended_rate': cmp = (a.blended_rate ?? -1) - (b.blended_rate ?? -1); break
        case 'next_maturity':
          // Customers with no maturity date sort last in either direction.
          if (!a.next_maturity || !b.next_maturity) cmp = (a.next_maturity ? 0 : 1) - (b.next_maturity ? 0 : 1) || 0
          else cmp = a.next_maturity.localeCompare(b.next_maturity)
          break
      }
      return cmp === 0 ? a.name.localeCompare(b.name) : cmp * dir
    })
  }, [customers, search, onlyPastDue, onlyDueSoon, sortKey, sortDir])

  const totals = useMemo(() => {
    let principal = 0, accrued = 0, count = 0, rateWeight = 0, ratePrincipal = 0
    for (const c of filtered) {
      principal += c.principal_kobo
      accrued += c.accrued_kobo
      count += c.deposits.length
      if (c.blended_rate != null) { rateWeight += c.blended_rate * c.principal_kobo; ratePrincipal += c.principal_kobo }
    }
    return { principal, accrued, count, rate: ratePrincipal > 0 ? rateWeight / ratePrincipal : null }
  }, [filtered])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pages)
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'name' || k === 'next_maturity' ? 'asc' : 'desc') }
    setPage(1)
  }
  function toggleOpen(cif: string) {
    setOpen(prev => { const next = new Set(prev); next.has(cif) ? next.delete(cif) : next.add(cif); return next })
  }
  function reset() {
    setSearch(''); setFStatus(new Set(['Active'])); setFProduct(new Set()); setFOfficer(new Set())
    setOnlyPastDue(false); setOnlyDueSoon(false); setPage(1)
  }

  return (
    <SectionCard
      title="Deposit Register"
      subtitle="One row per customer: expand a customer to see each deposit"
      padding={false}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AttentionToggle on={onlyPastDue} count={pastDueCustomers} label="Past Due" color={RED}
            onClick={() => { setOnlyPastDue(v => !v); setPage(1) }} />
          <AttentionToggle on={onlyDueSoon} count={dueSoonCustomers} label="Due ≤30d" color={AMBER}
            onClick={() => { setOnlyDueSoon(v => !v); setPage(1) }} />
        </div>
      }
    >
      <ExpandableFilterBar
        search={search}
        onSearch={v => { setSearch(v); setPage(1) }}
        groups={[
          {
            key: 'status', label: 'Status',
            options: statusOptions.map(o => ({ value: o.value, count: o.count, color: o.color })),
            selected: fStatus,
            onChange: s => { setFStatus(s); setPage(1) },
          },
          {
            key: 'product', label: 'Product',
            options: productOptions.map(o => ({ value: o.value, count: o.count })),
            selected: fProduct,
            onChange: s => { setFProduct(s); setPage(1) },
          },
          ...(withOfficer ? [{
            key: 'officer', label: 'Account Officer',
            options: officerOptions.map(o => ({ value: o.value, count: o.count })),
            selected: fOfficer,
            onChange: (s: Set<string>) => { setFOfficer(s); setPage(1) },
          }] : []),
        ]}
        onReset={reset}
        resultCount={filtered.length}
        totalCount={customers.length}
        placeholder={withOfficer ? 'Search customer, Udara ID, account, product, officer…' : 'Search customer, Udara ID, account, product…'}
        maxCols={3}
      />

      {loading ? (
        <div style={{ padding: 18 }}>
          {Array.from({ length: 8 }).map((_, i) => <div key={i} style={{ padding: '8px 0' }}><Sk h={14} /></div>)}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="savings"
          title="No Customers Found"
          description="No deposit holder matches the current search and filters."
        />
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {COLS.map(c => <SortHeader key={c.key} col={c} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />)}
                </tr>
              </thead>
              <tbody>
                {visible.map(c => {
                  const many = c.deposits.length > 1
                  const only = many ? null : c.deposits[0]
                  const isOpen = open.has(c.cif)
                  return (
                    <Fragment key={c.cif}>
                      <tr
                        onClick={many ? () => toggleOpen(c.cif) : undefined}
                        style={{
                          cursor: many ? 'pointer' : 'default',
                          background: isOpen ? 'var(--th-bg)' : undefined,
                          transition: 'background 120ms',
                        }}
                        onMouseEnter={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                        onMouseLeave={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.background = '' }}
                      >
                        {/* Disclosure — rendered only when there is something to disclose. */}
                        <td style={{ ...tdBase, paddingRight: 0 }}>
                          {many ? (
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${c.name}`}
                              onClick={e => { e.stopPropagation(); toggleOpen(c.cif) }}
                              style={{
                                width: 24, height: 24, border: 'none', background: 'none', padding: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: 'var(--txt2)', cursor: 'pointer',
                              }}
                            >
                              <span className="material-symbols-rounded" aria-hidden="true" style={{
                                fontSize: 19, transition: 'transform 160ms', transform: isOpen ? 'rotate(90deg)' : 'none',
                              }}>chevron_right</span>
                            </button>
                          ) : null}
                        </td>

                        <td style={tdBase}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--txt)' }}>{c.name}</div>
                            <div style={subText}>
                              {`Udara ID ${c.cif}`}
                              {only && only.cbs_account_number ? ` · ${only.cbs_account_number}` : ''}
                            </div>
                          </div>
                        </td>

                        <td style={tdBase}>
                          <div style={{ fontSize: TEXT.sm }}>{many ? c.product : (only?.product_name || '—')}</div>
                          {only && (only.tenor_days != null || only.commencement_date) && (
                            <div style={subText}>
                              {only.tenor_days != null ? `${fmtCount(only.tenor_days)}d` : ''}
                              {only.tenor_days != null && only.commencement_date ? ' from ' : ''}
                              {only.commencement_date ? fmtDate(dayKey(only.commencement_date)) : ''}
                            </div>
                          )}
                        </td>

                        {/* One officer is the normal case — every customer's deposits
                            currently sit with a single desk. A customer split across
                            desks says so instead of showing one name as if it owned
                            the whole relationship. */}
                        {withOfficer && (
                          <td style={tdBase}>
                            {c.officers.length === 0 ? <span style={{ color: 'var(--txt3)' }}>—</span>
                              : c.officers.length === 1 ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{c.officers[0]}</span>
                              : (
                                <div title={c.officers.join(', ')}>
                                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{`${fmtCount(c.officers.length)} officers`}</div>
                                  <div style={subText}>{c.officers.join(', ')}</div>
                                </div>
                              )}
                          </td>
                        )}

                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          <span style={{ ...NUM, color: many ? 'var(--txt)' : 'var(--txt3)', fontWeight: many ? FW.semibold : FW.normal }}>
                            {fmtCount(c.deposits.length)}
                          </span>
                        </td>

                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(c.principal_kobo)}</span>
                        </td>

                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          <span style={{ ...NUM, color: BLUE }}>{fmtKoboExact(c.accrued_kobo)}</span>
                        </td>

                        {/* Rate: one deposit shows its contractual rate. Several show a
                            principal-weighted blend, marked as such — 24% on ₦890m and 6%
                            on ₦1.5bn is not a rate anyone agreed to. */}
                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          {c.blended_rate == null ? <span style={NUM}>—</span> : many ? (
                            <div title={`Principal-weighted across ${fmtCount(c.deposits.length)} deposits (${fmtPct(c.rate_lo)} – ${fmtPct(c.rate_hi)})`}>
                              <div style={NUM}>{`~${fmtPct(c.blended_rate)}`}</div>
                              <div style={subText}>
                                {c.rate_lo != null && c.rate_hi != null && c.rate_lo !== c.rate_hi
                                  ? `blended ${fmtPct(c.rate_lo)}–${fmtPct(c.rate_hi)}`
                                  : 'blended'}
                              </div>
                            </div>
                          ) : <span style={NUM}>{fmtPct(c.blended_rate)}</span>}
                        </td>

                        <td style={tdBase}>
                          {c.next_maturity ? (
                            <>
                              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(c.next_maturity)}</div>
                              {c.next_days != null && (
                                <div style={{ ...subText, color: maturityTone(c.next_days), fontWeight: c.next_days <= DUE_SOON_DAYS ? FW.semibold : FW.normal }}>
                                  {maturityNote(c.next_days)}
                                </div>
                              )}
                            </>
                          ) : <span style={{ color: 'var(--txt3)' }}>—</span>}
                        </td>

                        <td style={tdBase}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                            {c.past_due > 0 && <Pill label={`${fmtCount(c.past_due)} past due`} color={RED} bg="rgba(192,0,0,.10)" />}
                            {c.due_30 > 0 && <Pill label={`${fmtCount(c.due_30)} due ≤30d`} color={AMBER} bg="rgba(217,119,6,.12)" />}
                            {c.past_due === 0 && c.due_30 === 0 && (
                              only && only.status !== 'Active'
                                ? <StatusBadge status={only.status || 'unknown'} size="sm" />
                                : <span style={{ color: 'var(--txt3)' }}>—</span>
                            )}
                          </div>
                        </td>
                      </tr>

                      {many && isOpen && (
                        <tr>
                          <td colSpan={COLS.length} style={{ padding: '0 18px 6px 46px', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                            <DepositTable deposits={c.deposits} withOfficer={withOfficer} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--th-bg)' }}>
                  <td style={{ ...tdBase, borderBottom: 'none' }} />
                  <td style={{ ...tdBase, borderBottom: 'none', fontWeight: FW.semibold, fontSize: TEXT.sm }}>
                    {`${fmtCount(filtered.length)} customers`}
                  </td>
                  <td style={{ ...tdBase, borderBottom: 'none' }} />
                  {withOfficer && <td style={{ ...tdBase, borderBottom: 'none' }} />}
                  <td style={{ ...tdBase, borderBottom: 'none', textAlign: 'right' }}>
                    <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtCount(totals.count)}</span>
                  </td>
                  <td style={{ ...tdBase, borderBottom: 'none', textAlign: 'right' }}>
                    <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKoboExact(totals.principal)}</span>
                  </td>
                  <td style={{ ...tdBase, borderBottom: 'none', textAlign: 'right' }}>
                    <span style={{ ...NUM, fontWeight: FW.semibold, color: BLUE }}>{fmtKoboExact(totals.accrued)}</span>
                  </td>
                  <td style={{ ...tdBase, borderBottom: 'none', textAlign: 'right' }}>
                    <span style={NUM}>{totals.rate == null ? '—' : `~${fmtPct(totals.rate)}`}</span>
                  </td>
                  <td style={{ ...tdBase, borderBottom: 'none' }} colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>

          <Pagination page={safePage} pages={pages} total={filtered.length} pageSize={PAGE_SIZE} onPage={setPage} />
        </>
      )}
    </SectionCard>
  )
}
