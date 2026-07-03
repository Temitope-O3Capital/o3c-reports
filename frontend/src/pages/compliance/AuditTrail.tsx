import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiExport } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuditLog {
  id: number
  created_at: string
  user_name?: string
  action: string
  module: string
  resource_type?: string
  resource_id?: string
  old_value?: string
  new_value?: string
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
      if (moduleFilter) p.set('module', moduleFilter)
      if (actionFilter) p.set('action', actionFilter)
      if (from) p.set('from', from)
      if (to)   p.set('to', to)
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
      if (moduleFilter) p.set('module', moduleFilter)
      if (actionFilter) p.set('action', actionFilter)
      if (from) p.set('from', from)
      if (to)   p.set('to', to)
      await apiExport(`/api/compliance/audit-log/export?${p}`, 'audit-trail.csv')
    } catch (e: any) {
      toast.error(e.message)
    } finally { setExporting(false) }
  }

  const cols: TableCol<AuditLog>[] = [
    {
      key: 'created_at', label: 'Timestamp',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: 'Inter, monospace', whiteSpace: 'nowrap' }}>{fmtDatetime(r.created_at)}</span>,
    },
    {
      key: 'user_name', label: 'User',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.user_name ?? 'System'}</span>,
    },
    {
      key: 'action', label: 'Action',
      render: r => (
        <span style={{
          ...NUM, display: 'inline-flex', alignItems: 'center',
          fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
          background: r.action?.includes('delete') || r.action?.includes('remove') ? 'rgba(192,0,0,.1)' : 'rgba(14,40,65,.08)',
          color: r.action?.includes('delete') || r.action?.includes('remove') ? '#C00000' : NAVY,
        }}>
          {r.action}
        </span>
      ),
    },
    {
      key: 'module', label: 'Module',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.module}</span>,
    },
    {
      key: 'resource_type', label: 'Resource',
      render: r => (
        <span style={{ fontSize: 12.5, color: 'var(--txt2)', fontFamily: 'Inter, monospace' }}>
          {r.resource_type ?? '—'}{r.resource_id ? ` #${r.resource_id}` : ''}
        </span>
      ),
    },
    {
      key: 'old_value', label: 'Old Value',
      render: r => r.old_value ? (
        <span style={{ fontSize: 11.5, color: '#C00000', fontFamily: 'Inter, monospace', maxWidth: 120, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.old_value}
        </span>
      ) : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'new_value', label: 'New Value',
      render: r => r.new_value ? (
        <span style={{ fontSize: 11.5, color: '#16A34A', fontFamily: 'Inter, monospace', maxWidth: 120, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.new_value}
        </span>
      ) : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'ip_address', label: 'IP',
      render: r => <span style={{ fontSize: 11.5, color: 'var(--txt3)', fontFamily: 'Inter, monospace' }}>{r.ip_address ?? '—'}</span>,
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
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer', opacity: exporting ? 0.7 : 1 }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
          Export CSV
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setModuleFilter(''); setActionFilter(''); setFrom(''); setTo(''); setPage(1) }}>
        <input placeholder="Module…" value={moduleFilter} onChange={e => { setModuleFilter(e.target.value); setPage(1) }}
          style={{ ...filterInputStyle, width: 140 }} />
        <input placeholder="Action…" value={actionFilter} onChange={e => { setActionFilter(e.target.value); setPage(1) }}
          style={{ ...filterInputStyle, width: 140 }} />
        <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1) }}
          style={{ ...filterInputStyle, width: 140 }} />
        <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1) }}
          style={{ ...filterInputStyle, width: 140 }} />
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
        />
        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 0', borderTop: '1px solid var(--bdr)' }}>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}
            >
              ←
            </button>
            <span style={{ fontSize: 13, color: 'var(--txt2)' }}>Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: page === totalPages ? 'not-allowed' : 'pointer', opacity: page === totalPages ? 0.4 : 1 }}
            >
              →
            </button>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
