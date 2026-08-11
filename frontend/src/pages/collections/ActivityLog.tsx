import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, KpiCard, DataTable, ErrBanner, DateFilter, filterInputStyle,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
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

// ── Shared badge components ───────────────────────────────────────────────────

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

// ── Pagination controls ───────────────────────────────────────────────────────

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
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
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
          onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"
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
          onClick={() => onPage(page + 1)} disabled={page >= totalPages} aria-label="Next page"
          style={{ ...btnBase, border: '1.5px solid var(--input-bdr)', background: 'transparent', color: page >= totalPages ? 'var(--txt3)' : 'var(--txt2)' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>chevron_right</span>
        </button>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function CollectionsActivityLog() {
  const [data,    setData]    = useState<ActivityEvent[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  const [dateFrom,      setDateFrom]      = useState(monthStart())
  const [dateTo,        setDateTo]        = useState(today())
  const [filterAction,  setFilterAction]  = useState('')
  const [filterEntity,  setFilterEntity]  = useState('')
  const [page,          setPage]          = useState(1)
  const [search,        setSearch]        = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ module: 'collections', page: String(page), size: String(PAGE_SIZE) })
    if (dateFrom)     params.set('from', dateFrom)
    if (dateTo)       params.set('to', dateTo)
    if (filterAction) params.set('action', filterAction)
    if (filterEntity) params.set('entity_type', filterEntity)
    try {
      // Handler sends {data:rows,total} through respond() → double-wrapped as {data:{data,total}}.
      const res = await apiFetch<any>(`/api/collections/activity?${params}`)
      const inner = res?.data ?? res
      setData(inner?.data ?? (Array.isArray(inner) ? inner : []))
      setTotal(inner?.total ?? 0)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load activity log')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, filterAction, filterEntity, page])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['collections','loans'] })

  // Reset to page 1 when filters change (but not page itself)
  useEffect(() => { setPage(1) }, [dateFrom, dateTo, filterAction, filterEntity])

  // ── KPIs (derived from loaded page) ──────────────────────────────────────────

  const ptpsCreated    = data.filter(e => e.action === 'promise_created').length
  const contactsLogged = data.filter(e => e.action === 'contact_logged').length
  const paymentsLogged = data.filter(e => e.action === 'payment_logged').length

  // ── Client-side description search ───────────────────────────────────────────

  const displayed = useMemo(() => {
    if (!search.trim()) return data
    const q = search.toLowerCase()
    return data.filter(e => e.description.toLowerCase().includes(q))
  }, [data, search])

  // ── Table columns ─────────────────────────────────────────────────────────────

  const cols: TableCol<ActivityEvent>[] = [
    {
      key: 'ts', label: 'Timestamp',
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
          {new Date(r.ts).toLocaleString('en-NG')}
        </span>
      ),
    },
    {
      key: 'account_cif', label: 'CIF',
      render: r => r.account_cif ? (
        <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY, fontSize: TEXT.sm }}>
          {r.account_cif}
        </span>
      ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
    {
      key: 'action', label: 'Action',
      render: r => <ActionBadge action={r.action} />,
    },
    {
      key: 'description', label: 'Description',
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.5, display: 'block', maxWidth: 320 }}>
          {r.description}
        </span>
      ),
    },
    {
      key: 'actor_name', label: 'Actor',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.actor_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>{r.actor_role}</div>
        </div>
      ),
    },
    {
      key: 'entity_type', label: 'Entity Type',
      render: r => (
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {r.entity_type}
        </span>
      ),
    },
  ]

  return (
    <Page
      title="Collections Activity Log"
      subtitle="Complete audit trail of all collections team actions"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
        <KpiCard label="Total Actions"          value={loading ? '—' : total.toLocaleString('en-NG')} icon="history"   accent={NAVY}  loading={loading} />
        <KpiCard label="PTPs · this page"       value={loading ? '—' : ptpsCreated}                   icon="handshake" accent={NAVY}  loading={loading} />
        <KpiCard label="Contacts · this page"   value={loading ? '—' : contactsLogged}                icon="phone"     accent={BLUE}  loading={loading} />
        <KpiCard label="Payments · this page"   value={loading ? '—' : paymentsLogged}                icon="payments"  accent={GREEN} loading={loading} />
      </div>

      <SectionCard padding={false}>

        {/* Filter bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '12px 18px', borderBottom: '1px solid var(--bdr)',
        }}>
          {/* Description search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            height: 36, padding: '0 10px', background: 'var(--card)',
            border: '1px solid var(--bdr)', borderRadius: 8, minWidth: 220,
          }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--txt3)', flexShrink: 0 }}>
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search description…"
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

          {/* Action filter */}
          <select
            value={filterAction}
            onChange={e => setFilterAction(e.target.value)}
            style={{ ...filterInputStyle, minWidth: 170 }}
          >
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          {/* Entity type filter */}
          <select
            value={filterEntity}
            onChange={e => setFilterEntity(e.target.value)}
            style={{ ...filterInputStyle, minWidth: 150 }}
          >
            <option value="">All entity types</option>
            {[...new Set(data.map(e => e.entity_type).filter(Boolean))].sort().map(et => (
              <option key={et} value={et}>{et}</option>
            ))}
          </select>

          {(filterAction || filterEntity || search) && (
            <button
              onClick={() => { setFilterAction(''); setFilterEntity(''); setSearch('') }}
              style={{
                fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt2)',
                background: 'none', border: '1px solid var(--bdr)',
                borderRadius: RADIUS.sm, padding: '5px 10px', cursor: 'pointer',
              }}
            >
              Clear
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

        <DataTable
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={10}
          emptyText="No activity events found"
        />

        <PaginationBar page={page} total={total} size={PAGE_SIZE} onPage={p => setPage(p)} />
      </SectionCard>
    </Page>
  )
}
