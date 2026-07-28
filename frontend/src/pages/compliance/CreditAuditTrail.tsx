import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import {
  Page, SectionCard, KpiCard, ErrBanner, DateFilter, Spinner, filterInputStyle,
} from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { monthStart, today } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, TEXT, FW, RADIUS, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActivityEvent {
  id: number
  ts: string
  module: 'collections' | 'recovery' | 'risk'
  actor_id: number
  actor_name: string
  actor_role: string
  entity_type: string
  entity_id: string
  account_cif: string | null
  action: string
  description: string
  previous_state?: string | null
  new_state?: string | null
}

interface ActivityPage {
  data: ActivityEvent[]
  total: number
  page: number
  size: number
}

// ── Action label / color maps ─────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  contact_logged:              'Contact Logged',
  promise_created:             'PTP Created',
  promise_honoured:            'PTP Honoured',
  promise_broken:              'PTP Broken',
  payment_logged:              'Payment Logged',
  payment_approved:            'Payment Approved',
  payment_rejected:            'Payment Rejected',
  writeoff_requested:          'Write-off Requested',
  writeoff_request_approved:   'Write-off Approved',
  writeoff_request_rejected:   'Write-off Rejected',
  writeoff_approved:           'Write-off Approved',
  watchlist_flagged:           'Watchlist Flagged',
  watchlist_resolved:          'Watchlist Resolved',
  sent_to_recovery:            'Sent to Recovery',
  field_visit_logged:          'Field Visit',
  debt_sale_created:           'Debt Sale Created',
  plan_created:                'Repayment Plan Created',
  instalment_paid:             'Instalment Paid',
  legal_milestone_added:       'Legal Milestone',
}

const ACTION_COLORS: Record<string, string> = {
  contact_logged:              BLUE,
  promise_created:             NAVY,
  promise_honoured:            GREEN,
  promise_broken:              RED,
  payment_logged:              BLUE,
  payment_approved:            GREEN,
  payment_rejected:            RED,
  writeoff_requested:          AMBER,
  writeoff_request_approved:   RED,
  writeoff_request_rejected:   AMBER,
  writeoff_approved:           RED,
  watchlist_flagged:           AMBER,
  watchlist_resolved:          GREEN,
  sent_to_recovery:            RED,
  field_visit_logged:          BLUE,
  debt_sale_created:           '#7C3AED',
  plan_created:                NAVY,
  instalment_paid:             GREEN,
  legal_milestone_added:       '#7C3AED',
}

// ── Badge components ──────────────────────────────────────────────────────────

function ActionBadge({ action }: { action: string }) {
  const label = ACTION_LABELS[action] ?? action
  const color = ACTION_COLORS[action] ?? 'var(--txt2)'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
      borderRadius: RADIUS['2xl'], background: `${color}18`, color,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function ModuleBadge({ module }: { module: string }) {
  const map: Record<string, { label: string; color: string }> = {
    collections: { label: 'Collections', color: NAVY },
    recovery:    { label: 'Recovery',    color: RED },
    risk:        { label: 'Risk',        color: '#7C3AED' },
  }
  const { label, color } = map[module] ?? { label: module, color: 'var(--txt2)' }
  return (
    <span style={{
      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em',
      textTransform: 'uppercase', padding: '2px 7px',
      borderRadius: RADIUS['2xl'], background: `${color}12`, color, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

// ── JSON state detail panel ───────────────────────────────────────────────────

function StateDetail({ prev, next }: { prev: string | null | undefined; next: string | null | undefined }) {
  function tryParse(s: string | null | undefined): string {
    if (!s) return ''
    try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
  }

  const prevStr = tryParse(prev)
  const nextStr = tryParse(next)

  if (!prevStr && !nextStr) return null

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: prevStr && nextStr ? '1fr 1fr' : '1fr',
      gap: 16, padding: 16, background: 'var(--canvas)',
    }}>
      {prevStr && (
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            BEFORE
          </div>
          <pre style={{
            fontSize: TEXT.xs, color: 'var(--txt2)', overflow: 'auto', maxHeight: 200,
            margin: 0, padding: '10px 12px', background: 'var(--card)',
            border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
            fontFamily: 'var(--font-mono)', lineHeight: 1.5,
          }}>
            {prevStr}
          </pre>
        </div>
      )}
      {nextStr && (
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            AFTER
          </div>
          <pre style={{
            fontSize: TEXT.xs, color: 'var(--txt2)', overflow: 'auto', maxHeight: 200,
            margin: 0, padding: '10px 12px', background: 'var(--card)',
            border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
            fontFamily: 'var(--font-mono)', lineHeight: 1.5,
          }}>
            {nextStr}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Pagination ────────────────────────────────────────────────────────────────

function PaginationBar({
  page, total, size, onPage,
}: {
  page: number; total: number; size: number; onPage: (p: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / size))
  if (totalPages <= 1) return null

  const pages: (number | null)[] = []
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 2 && i <= page + 2)) {
      pages.push(i)
    } else if (pages[pages.length - 1] !== null) {
      pages.push(null)
    }
  }

  const btnBase = {
    minWidth: 28, height: 28, borderRadius: 6, fontSize: 12, fontWeight: 600,
    cursor: 'pointer', display: 'inline-flex' as const, alignItems: 'center' as const, justifyContent: 'center' as const,
    padding: '0 6px',
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '12px 18px', borderTop: '1px solid var(--bdr)',
      justifyContent: 'space-between',
    }}>
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
        {total.toLocaleString('en-NG')} total events · Page {page} of {totalPages}
      </span>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={() => onPage(page - 1)} disabled={page <= 1}
          style={{ ...btnBase, border: '1.5px solid var(--input-bdr)', background: 'transparent', color: page <= 1 ? 'var(--txt3)' : 'var(--txt2)' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>chevron_left</span>
        </button>
        {pages.map((p, i) =>
          p === null ? (
            <span key={`ellipsis-${i}`} style={{ ...btnBase, border: 'none', background: 'transparent', color: 'var(--txt3)', cursor: 'default' }}>…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              style={{
                ...btnBase,
                border: p === page ? 'none' : '1.5px solid var(--input-bdr)',
                background: p === page ? RED : 'transparent',
                color: p === page ? '#fff' : 'var(--txt2)',
              }}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPage(page + 1)} disabled={page >= totalPages}
          style={{ ...btnBase, border: '1.5px solid var(--input-bdr)', background: 'transparent', color: page >= totalPages ? 'var(--txt3)' : 'var(--txt2)' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>chevron_right</span>
        </button>
      </div>
    </div>
  )
}

// ── CSV export helper ─────────────────────────────────────────────────────────

function exportCsv(rows: ActivityEvent[]) {
  const headers = ['ID', 'Timestamp', 'Module', 'Actor', 'Role', 'CIF', 'Action', 'Entity Type', 'Entity ID', 'Description']
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`
  const lines = [
    headers.join(','),
    ...rows.map(r => [
      r.id,
      escape(new Date(r.ts).toLocaleString('en-NG')),
      r.module,
      escape(r.actor_name),
      escape(r.actor_role),
      r.account_cif ?? '',
      r.action,
      r.entity_type,
      r.entity_id,
      escape(r.description),
    ].join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `credit-audit-trail_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── Table cell styles ─────────────────────────────────────────────────────────

const thStyle = {
  padding: '10px 14px', fontSize: 10, fontWeight: 700,
  color: 'var(--txt2)', textTransform: 'uppercase' as const,
  letterSpacing: '0.6px', whiteSpace: 'nowrap' as const,
  borderBottom: '1px solid var(--bdr)', textAlign: 'left' as const,
  fontFamily: 'var(--font-sans)',
}

const tdStyle = {
  padding: '10px 14px', fontSize: 13, color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle' as const,
}

// ── Module filter chips ───────────────────────────────────────────────────────

const MODULE_OPTIONS = [
  { key: '', label: 'All' },
  { key: 'collections', label: 'Collections' },
  { key: 'recovery', label: 'Recovery' },
  { key: 'risk', label: 'Risk' },
]

const MODULE_COLORS: Record<string, string> = {
  collections: NAVY,
  recovery: RED,
  risk: '#7C3AED',
}

// ── Main component ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function CreditAuditTrail() {
  const [data,        setData]        = useState<ActivityEvent[]>([])
  const [total,       setTotal]       = useState(0)
  const [loading,     setLoading]     = useState(true)
  const [err,         setErr]         = useState<string | null>(null)
  const [expandedRow, setExpandedRow] = useState<number | null>(null)

  // Filters
  const [dateFrom,     setDateFrom]     = useState(monthStart())
  const [dateTo,       setDateTo]       = useState(today())
  const [filterModule, setFilterModule] = useState('')
  const [filterAction, setFilterAction] = useState('')
  const [filterActorId, setFilterActorId] = useState('')
  const [filterCif,    setFilterCif]    = useState('')
  const [filterEntity, setFilterEntity] = useState('')
  const [page,         setPage]         = useState(1)
  const [search,       setSearch]       = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) })
    if (dateFrom)       params.set('from', dateFrom)
    if (dateTo)         params.set('to', dateTo)
    if (filterModule)   params.set('module', filterModule)
    if (filterAction)   params.set('action', filterAction)
    if (filterActorId.trim()) params.set('actor_id', filterActorId.trim())
    if (filterCif.trim())     params.set('cif', filterCif.trim())
    if (filterEntity)   params.set('entity_type', filterEntity)
    try {
      const res = await apiFetch<ActivityPage>(`/api/collections/activity?${params}`)
      setData(res.data ?? [])
      setTotal(res.total ?? 0)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load audit trail')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, filterModule, filterAction, filterActorId, filterCif, filterEntity, page])

  useEffect(() => { load() }, [load])

  // Reset to page 1 when non-page filters change
  useEffect(() => {
    setPage(1)
  }, [dateFrom, dateTo, filterModule, filterAction, filterActorId, filterCif, filterEntity])

  // ── KPIs ──────────────────────────────────────────────────────────────────────

  const uniqueActors    = useMemo(() => new Set(data.map(e => e.actor_id)).size, [data])
  const accountsTouched = useMemo(() => new Set(data.filter(e => e.account_cif).map(e => e.account_cif)).size, [data])
  const writeoffEvents  = data.filter(e => e.action.includes('writeoff')).length

  // ── Client-side description search ───────────────────────────────────────────

  const displayed = useMemo(() => {
    if (!search.trim()) return data
    const q = search.toLowerCase()
    return data.filter(e =>
      e.description.toLowerCase().includes(q) ||
      (e.account_cif ?? '').toLowerCase().includes(q) ||
      e.actor_name.toLowerCase().includes(q)
    )
  }, [data, search])

  function toggleRow(id: number) {
    setExpandedRow(prev => prev === id ? null : id)
  }

  function clearFilters() {
    setFilterModule(''); setFilterAction(''); setFilterActorId('')
    setFilterCif(''); setFilterEntity(''); setSearch('')
  }

  const hasFilters = !!(filterModule || filterAction || filterActorId || filterCif || filterEntity || search)

  return (
    <Page
      title="Credit Audit Trail"
      subtitle="Full regulatory audit trail across Collections, Recovery, and Risk"
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Compliance badge */}
          <span style={{
            fontSize: TEXT.xs, fontWeight: FW.bold, letterSpacing: '0.05em',
            textTransform: 'uppercase', padding: '3px 10px',
            borderRadius: RADIUS['2xl'], background: `${NAVY}12`, color: NAVY,
            border: `1px solid ${NAVY}20`,
          }}>
            Regulatory View
          </span>
          <button
            onClick={() => exportCsv(displayed)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 13px', borderRadius: RADIUS.md,
              border: '1.5px solid var(--bdr)', background: 'var(--card)',
              color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold,
              cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>
            Export CSV
          </button>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        </div>
      }
    >

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
        <KpiCard label="Total Events"      value={loading ? '—' : total.toLocaleString('en-NG')} icon="history"       accent={NAVY}  loading={loading} />
        <KpiCard label="Unique Actors"     value={loading ? '—' : uniqueActors}                  icon="people"        accent={BLUE}  loading={loading} />
        <KpiCard label="Accounts Touched"  value={loading ? '—' : accountsTouched}               icon="account_balance" accent={AMBER} loading={loading} />
        <KpiCard label="Write-off Events"  value={loading ? '—' : writeoffEvents}                icon="remove_circle" accent={RED}   loading={loading} />
      </div>

      <SectionCard padding={false}>

        {/* Filter bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '12px 18px', borderBottom: '1px solid var(--bdr)',
        }}>
          {/* Module chips */}
          <div style={{ display: 'flex', gap: 4 }}>
            {MODULE_OPTIONS.map(opt => {
              const active = filterModule === opt.key
              const color = opt.key ? MODULE_COLORS[opt.key] : NAVY
              return (
                <button
                  key={opt.key}
                  onClick={() => setFilterModule(opt.key)}
                  style={{
                    padding: '4px 11px', borderRadius: RADIUS.md, fontSize: TEXT.xs,
                    fontWeight: FW.semibold, cursor: 'pointer',
                    border: `1.5px solid ${active ? color : 'var(--bdr)'}`,
                    background: active ? `${color}14` : 'var(--card)',
                    color: active ? color : 'var(--txt2)',
                    transition: 'all 100ms',
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>

          {/* Search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            height: 36, padding: '0 10px', background: 'var(--card)',
            border: '1px solid var(--bdr)', borderRadius: 8, minWidth: 200,
          }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--txt3)', flexShrink: 0 }}>
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search description, CIF, actor…"
              style={{
                border: 'none', background: 'transparent', outline: 'none',
                flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--txt)',
                fontFamily: "'Sora', ui-sans-serif, sans-serif",
              }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: 'var(--txt3)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
              </button>
            )}
          </div>

          {/* Action select */}
          <select value={filterAction} onChange={e => setFilterAction(e.target.value)} style={{ ...filterInputStyle, minWidth: 160 }}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>

          {/* Entity type select */}
          <select value={filterEntity} onChange={e => setFilterEntity(e.target.value)} style={{ ...filterInputStyle, minWidth: 140 }}>
            <option value="">All entity types</option>
            {[...new Set(data.map(e => e.entity_type).filter(Boolean))].sort().map(et => (
              <option key={et} value={et}>{et}</option>
            ))}
          </select>

          {/* Actor ID input */}
          <input
            value={filterActorId}
            onChange={e => setFilterActorId(e.target.value)}
            placeholder="Actor ID"
            style={{ ...filterInputStyle, minWidth: 100 }}
          />

          {/* CIF input */}
          <input
            value={filterCif}
            onChange={e => setFilterCif(e.target.value)}
            placeholder="Account CIF"
            style={{ ...filterInputStyle, minWidth: 120 }}
          />

          {hasFilters && (
            <button
              onClick={clearFilters}
              style={{
                fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt2)',
                background: 'none', border: '1px solid var(--bdr)',
                borderRadius: RADIUS.sm, padding: '5px 10px', cursor: 'pointer',
              }}
            >
              Clear all
            </button>
          )}

          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt2)' }}>
            {displayed.length !== data.length
              ? `${displayed.length} of ${data.length} on this page`
              : `${total.toLocaleString('en-NG')} total`
            }
          </span>
        </div>

        {err && (
          <div style={{ padding: '12px 18px' }}>
            <ErrBanner error={err} onRetry={load} />
          </div>
        )}

        {/* Manual table with expandable rows */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                <th style={thStyle}>Timestamp</th>
                <th style={thStyle}>Module</th>
                <th style={thStyle}>Actor</th>
                <th style={thStyle}>CIF</th>
                <th style={thStyle}>Action</th>
                <th style={{ ...thStyle, minWidth: 260 }}>Description</th>
                <th style={thStyle}>Entity</th>
                <th style={{ ...thStyle, width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ padding: '40px 0', textAlign: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--txt2)' }}>
                      <Spinner size={18} color={NAVY} />
                      <span style={{ fontSize: TEXT.sm }}>Loading audit trail…</span>
                    </div>
                  </td>
                </tr>
              ) : displayed.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '48px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
                    No audit events found for the selected filters.
                  </td>
                </tr>
              ) : displayed.map(r => {
                const isExpanded = expandedRow === r.id
                const hasDetail = !!(r.previous_state || r.new_state)
                return (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => hasDetail && toggleRow(r.id)}
                      style={{ cursor: hasDetail ? 'pointer' : 'default', borderBottom: isExpanded ? 'none' : '1px solid var(--bdr)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
                    >
                      <td style={tdStyle}>
                        <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          {new Date(r.ts).toLocaleString('en-NG')}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <ModuleBadge module={r.module} />
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.actor_name}</div>
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>{r.actor_role}</div>
                      </td>
                      <td style={tdStyle}>
                        {r.account_cif ? (
                          <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY, fontSize: TEXT.sm }}>{r.account_cif}</span>
                        ) : (
                          <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <ActionBadge action={r.action} />
                      </td>
                      <td style={{ ...tdStyle, maxWidth: 360 }}>
                        <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.5 }}>
                          {r.description}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                          {r.entity_type}#{r.entity_id}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        {hasDetail && (
                          <span
                            className="material-symbols-rounded"
                            style={{ fontSize: 16, color: 'var(--txt3)', transition: 'transform 120ms', display: 'block', transform: isExpanded ? 'rotate(180deg)' : 'none' }}
                          >
                            expand_more
                          </span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr style={{ borderBottom: '1px solid var(--bdr)' }}>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <StateDetail prev={r.previous_state} next={r.new_state} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        <PaginationBar page={page} total={total} size={PAGE_SIZE} onPage={p => { setPage(p); setExpandedRow(null) }} />
      </SectionCard>
    </Page>
  )
}
