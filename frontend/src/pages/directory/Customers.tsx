import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, KpiCard, Avatar, EmptyState, ExpandableFilterBar, Pagination } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, GREEN, BLUE, AMBER, PURPLE, RED, MONO, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DirectoryRow {
  cif:            string
  first_name:     string
  last_name:      string
  phone:          string
  email:          string
  state:          string
  city:           string
  account_status: string
  created_at:     string
  product_count:  number
  active_products:number
  product_lines:  string
}

interface Summary { total: number; active: number; with_email: number; with_phone: number; states: number }
interface FacetVal { v: string; n?: number }
interface Facets   { states: FacetVal[]; statuses: FacetVal[]; product_lines: FacetVal[]; total: number }

const PAGE_SIZE = 50

// Product-line labels for the filter panel — the four lines in app.accounts.
const LINE_LABEL: Record<string, string> = {
  prepaid: 'Prepaid', credit_card: 'Credit Card', deposit: 'Deposit', other: 'Other',
}

// Status → pill colors. Most customers have a blank status; those render as a dash.
const STATUS_META: Record<string, { color: string; bg: string }> = {
  active:      { color: GREEN,     bg: `${GREEN}18` },
  open:        { color: BLUE,      bg: `${BLUE}16` },
  suspended:   { color: AMBER,     bg: `${AMBER}1e` },
  'legal acti':{ color: RED,       bg: `${RED}14` },
  terminated:  { color: '#6B7280', bg: 'rgba(107,114,128,.13)' },
  inactive:    { color: '#6B7280', bg: 'rgba(107,114,128,.13)' },
}

// ── Small presentational helpers ────────────────────────────────────────────────

function fullName(r: DirectoryRow) {
  return `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '—'
}
function joinYear(iso: string) {
  return iso && iso.length >= 4 ? iso.slice(0, 4) : '—'
}
function pctLabel(n?: number, d?: number) {
  if (!d || d === 0 || n == null) return '—'
  return `${Math.round((n / d) * 100)}% of shown`
}

function StatusPill({ status }: { status: string }) {
  const s = (status ?? '').trim()
  if (!s) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const m = STATUS_META[s.toLowerCase()] ?? { color: '#6B7280', bg: 'rgba(107,114,128,.13)' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: FW.semibold,
      padding: '2px 9px', borderRadius: 20, background: m.bg, color: m.color,
      whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{s.toLowerCase() === 'legal acti' ? 'Legal Action' : s.toLowerCase()}</span>
  )
}

// ── Main component ──────────────────────────────────────────────────────────────

export default function CustomerDirectory() {
  const navigate = useNavigate()
  // Keep module context: from Care, open profiles under /care/customers so the
  // sidebar stays on Care rather than jumping to Call Center.
  const base = useLocation().pathname.startsWith('/care') ? '/care/customers' : '/customers'

  const [rows,    setRows]    = useState<DirectoryRow[]>([])
  const [total,   setTotal]   = useState(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [facets,  setFacets]  = useState<Facets | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  const [search,    setSearch]    = useState('')
  const [debounced, setDebounced] = useState('')
  const [offset,    setOffset]    = useState(0)

  // Multi-select filter groups (Sets), mirroring the app's ExpandableFilterBar pattern.
  const [fStates,   setFStates]   = useState<Set<string>>(new Set())
  const [fStatuses, setFStatuses] = useState<Set<string>>(new Set())
  const [fLines,    setFLines]    = useState<Set<string>>(new Set())
  const [fContact,  setFContact]  = useState<Set<string>>(new Set())  // 'email' | 'phone'

  // Any filter/search change returns to the first page.
  const set = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setOffset(0) }

  // Debounce the search box.
  const searchRef = useRef(search)
  searchRef.current = search
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(searchRef.current); setOffset(0) }, 300)
    return () => clearTimeout(t)
  }, [search])

  // Facets load once.
  useEffect(() => {
    apiFetch<Facets>('/api/customer360/directory/facets')
      .then(f => setFacets(f))
      .catch(() => {/* toolbar degrades gracefully without facets */})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (debounced)      p.set('q', debounced)
      if (fStates.size)   p.set('state', [...fStates].join(','))
      if (fStatuses.size) p.set('status', [...fStatuses].join(','))
      if (fLines.size)    p.set('product_line', [...fLines].join(','))
      if (fContact.has('email')) p.set('has_email', '1')
      if (fContact.has('phone')) p.set('has_phone', '1')
      const res = await apiFetch<{ data: DirectoryRow[]; total: number; summary: Summary }>(`/api/customer360/directory?${p}`)
      setRows(Array.isArray(res?.data) ? res.data : [])
      setTotal(res?.total ?? 0)
      setSummary(res?.summary ?? null)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [debounced, offset, fStates, fStatuses, fLines, fContact])

  useEffect(() => { load() }, [load])

  const page      = Math.floor(offset / PAGE_SIZE) + 1
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const from      = total === 0 ? 0 : offset + 1
  const to        = Math.min(offset + PAGE_SIZE, total)
  const baseTotal = facets?.total ?? total

  const resetFilters = () => {
    setSearch(''); setDebounced('')
    setFStates(new Set()); setFStatuses(new Set()); setFLines(new Set()); setFContact(new Set())
    setOffset(0)
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  const TH: React.CSSProperties = {
    textAlign: 'left', padding: '9px 16px', fontSize: TEXT.xs, fontWeight: FW.bold,
    color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.04em',
    background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
  }
  const TD: React.CSSProperties = {
    padding: '10px 16px', fontSize: TEXT.sm, color: 'var(--txt)',
    borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
  }

  return (
    <Page title="Customer Directory" subtitle={`${fmtNum(baseTotal)} customer${baseTotal === 1 ? '' : 's'} across the O3 base`}>
      <ErrBanner error={err} onRetry={load} />

      {/* ── KPI strip ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Customers"    value={fmtNum(summary?.total ?? 0)}      icon="groups"       accent={NAVY}   loading={!summary} />
        <KpiCard label="Active"       value={fmtNum(summary?.active ?? 0)}     icon="check_circle" accent={GREEN}  sub={pctLabel(summary?.active, summary?.total)}     loading={!summary} />
        <KpiCard label="With Email"   value={fmtNum(summary?.with_email ?? 0)} icon="mail"         accent={BLUE}   sub={pctLabel(summary?.with_email, summary?.total)} loading={!summary} />
        <KpiCard label="With Phone"   value={fmtNum(summary?.with_phone ?? 0)} icon="call"         accent={PURPLE} sub={pctLabel(summary?.with_phone, summary?.total)} loading={!summary} />
        <KpiCard label="States"       value={fmtNum(summary?.states ?? 0)}     icon="map"          accent={AMBER}  sub="represented"                                   loading={!summary} />
      </div>

      <SectionCard title="All Customers" badge={total} padding={false}>
        {/* ── House filter bar (search + expandable multi-select panel) ────── */}
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          placeholder="Search name, phone, email, CIF…"
          groups={[
            {
              key: 'state', label: 'State',
              options: (facets?.states ?? []).map(s => ({ value: s.v, label: s.v })),
              selected: fStates, onChange: set(setFStates),
            },
            {
              key: 'status', label: 'Status',
              options: (facets?.statuses ?? []).map(s => ({
                value: s.v, label: s.v, count: s.n,
                color: STATUS_META[s.v.toLowerCase()]?.color,
              })),
              selected: fStatuses, onChange: set(setFStatuses),
            },
            {
              key: 'product', label: 'Product',
              options: (facets?.product_lines ?? []).map(s => ({
                value: s.v, label: LINE_LABEL[s.v] ?? s.v, count: s.n,
              })),
              selected: fLines, onChange: set(setFLines),
            },
            {
              key: 'contact', label: 'Contact',
              options: [
                { value: 'email', label: 'Has email', color: BLUE },
                { value: 'phone', label: 'Has phone', color: PURPLE },
              ],
              selected: fContact, onChange: set(setFContact),
            },
          ]}
          onReset={resetFilters}
          resultCount={total}
          totalCount={baseTotal}
          maxCols={4}
        />

        {/* ── Table ───────────────────────────────────────────────────────── */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: '30%' }}>Customer</th>
                <th style={{ ...TH, width: '28%' }}>Contact</th>
                <th style={{ ...TH, width: '20%' }}>Location</th>
                <th style={TH}>Status</th>
                <th style={{ ...TH, textAlign: 'right' }}>Joined</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ ...TD, textAlign: 'center', padding: SP[10] }}>
                    <div style={{ display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ ...TD, padding: 0 }}>
                    <EmptyState
                      icon="person_search"
                      title="No customers found"
                      description="No one matches these filters. Try clearing them."
                    />
                  </td>
                </tr>
              ) : (
                rows.map(r => {
                  const name = fullName(r)
                  return (
                    <tr
                      key={r.cif}
                      onClick={() => navigate(`${base}/${encodeURIComponent(r.cif)}`)}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Customer — CIF now lives under the name, not a far-right column */}
                      <td style={TD}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          <Avatar name={name} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>CIF {r.cif}</div>
                          </div>
                        </div>
                      </td>

                      {/* Contact */}
                      <td style={{ ...TD, color: 'var(--txt2)' }}>
                        {(r.email || r.phone) ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {r.email
                              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)' }}>mail</span>{r.email}
                                </span>
                              : <span style={{ color: 'var(--txt3)', fontSize: TEXT.xs }}>No email</span>}
                            {r.phone
                              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: TEXT.xs }}>
                                  <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)' }}>call</span>{r.phone}
                                </span>
                              : <span style={{ color: 'var(--txt3)', fontSize: TEXT.xs }}>No phone</span>}
                          </div>
                        ) : <span style={{ color: 'var(--txt3)' }}>—</span>}
                      </td>

                      {/* Location */}
                      <td style={{ ...TD, color: 'var(--txt2)' }}>
                        {r.state || r.city ? (
                          <div>
                            <div style={{ textTransform: 'capitalize' }}>{(r.state || '—').toLowerCase()}</div>
                            {r.city && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'capitalize' }}>{r.city.toLowerCase()}</div>}
                          </div>
                        ) : <span style={{ color: 'var(--txt3)' }}>—</span>}
                      </td>

                      {/* Status */}
                      <td style={TD}><StatusPill status={r.account_status} /></td>

                      {/* Joined */}
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{joinYear(r.created_at)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ──────────────────────────────────────────────────── */}
        <Pagination page={page} pages={pageCount} total={total} pageSize={PAGE_SIZE} onPage={p => setOffset((p - 1) * PAGE_SIZE)} />
      </SectionCard>
    </Page>
  )
}
