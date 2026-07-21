import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiExport } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuditLog {
  id: number
  created_at: string
  actor_name?: string
  action: string
  entity_type: string
  entity_id?: string
  ip_address?: string
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AuditTrail() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // Filters
  const [moduleFilter, setModuleFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 50

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (moduleFilter) p.set('entity_type', moduleFilter)
      if (actionFilter) p.set('action', actionFilter)
      if (from) p.set('date_from', from)
      if (to)   p.set('date_to', to)
      p.set('limit', String(PAGE_SIZE))
      p.set('offset', String((page - 1) * PAGE_SIZE))
      const data = await apiFetch<{ logs: AuditLog[]; total: number } | AuditLog[]>(`/api/compliance/audit-log?${p}`)
      if (Array.isArray(data)) {
        setLogs(data)
        setTotal(data.length)
      } else {
        setLogs(data.logs ?? [])
        setTotal(data.total ?? 0)
      }
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [moduleFilter, actionFilter, from, to, page])

  useEffect(() => { load() }, [load])

  async function handleExport() {
    setExporting(true)
    try {
      const p = new URLSearchParams()
      if (moduleFilter) p.set('entity_type', moduleFilter)
      if (actionFilter) p.set('action', actionFilter)
      if (from) p.set('date_from', from)
      if (to)   p.set('date_to', to)
      await apiExport(`/api/compliance/audit-log/export?${p}`, 'audit-trail.csv')
    } catch (e: any) {
      toast.error(e.message)
    } finally { setExporting(false) }
  }

  const cols: TableCol<AuditLog>[] = [
    {
      key: 'created_at', label: 'Timestamp',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'Inter, monospace', whiteSpace: 'nowrap' }}>{fmtDatetime(r.created_at)}</span>,
    },
    {
      key: 'actor_name', label: 'User',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.actor_name ?? 'System'}</span>,
    },
    {
      key: 'action', label: 'Action',
      render: r => (
        <span style={{
          ...NUM, display: 'inline-flex', alignItems: 'center',
          fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
          background: r.action?.includes('delete') || r.action?.includes('remove') ? 'rgba(192,0,0,.1)' : 'rgba(14,40,65,.08)',
          color: r.action?.includes('delete') || r.action?.includes('remove') ? '#C00000' : NAVY,
        }}>
          {r.action}
        </span>
      ),
    },
    {
      key: 'entity_type', label: 'Entity Type',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.entity_type ?? '—'}</span>,
    },
    {
      key: 'entity_id', label: 'Entity ID',
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'Inter, monospace' }}>
          {r.entity_id ? `#${r.entity_id}` : '—'}
        </span>
      ),
    },
    {
      key: 'ip_address', label: 'IP',
      render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'Inter, monospace' }}>{r.ip_address ?? '—'}</span>,
    },
  ]

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <Page
      title="Audit Trail"
      subtitle="Read-only log of all system actions"
      actions={
        <button
          onClick={handleExport}
          disabled={exporting}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer', opacity: exporting ? 0.7 : 1 }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>download</span>
          Export CSV
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setModuleFilter(''); setActionFilter(''); setFrom(''); setTo(''); setPage(1) }}>
        <input placeholder="Entity type…" value={moduleFilter} onChange={e => { setModuleFilter(e.target.value); setPage(1) }}
          style={{ ...filterInputStyle, width: 140 }} />
        <input placeholder="Action…" value={actionFilter} onChange={e => { setActionFilter(e.target.value); setPage(1) }}
          style={{ ...filterInputStyle, width: 140 }} />
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(1) }} />
      </FilterBar>

      <SectionCard
        title="Audit Log"
        badge={total}
        subtitle="Sorted by most recent · Read only"
        padding={false}
      >
        <DataTable<AuditLog>
          cols={cols}
          rows={logs}
          keyFn={r => r.id}
          emptyText="No audit log entries found."
          skeletonRows={loading ? 10 : 0}
          searchKeys={['actor_name', 'action', 'entity_type']}
          searchPlaceholder="Search by user, action or entity…"
        />
        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP[2], padding: '12px 0', borderTop: '1px solid var(--bdr)' }}>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}
            >
              ←
            </button>
            <span style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: page === totalPages ? 'not-allowed' : 'pointer', opacity: page === totalPages ? 0.4 : 1 }}
            >
              →
            </button>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
