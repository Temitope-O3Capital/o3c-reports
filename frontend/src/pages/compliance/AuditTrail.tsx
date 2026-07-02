import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiExport } from '../../lib/api'
import { fmtDate, today, monthStart } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ErrBanner, ColDef, NAVY,
} from '../../components/UI'
import { toast } from 'sonner'

interface AuditRow {
  id: string
  actor_name: string
  actor_role: string
  action: string
  entity_type: string
  entity_id: string
  ip_address: string
  created_at: string
}

const PAGE_SIZE = 50

export default function AuditTrail() {
  // raw inputs (immediate)
  const [entityTypeRaw, setEntityTypeRaw] = useState('')
  const [actionRaw, setActionRaw] = useState('')
  // debounced values (used for API calls)
  const [entityType, setEntityType] = useState('')
  const [action, setAction] = useState('')
  const [actorId, setActorId] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [rows, setRows] = useState<AuditRow[]>([])
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actors, setActors] = useState<{ id: string; full_name: string }[]>([])

  // Load actor list for filter dropdown
  useEffect(() => {
    apiFetch<{ id: string; full_name: string }[]>('/api/admin/users')
      .then(r => setActors(Array.isArray(r) ? r : []))
      .catch(() => {})
  }, [])

  // Debounce text inputs
  useEffect(() => {
    const t = setTimeout(() => setAction(actionRaw), 400)
    return () => clearTimeout(t)
  }, [actionRaw])

  useEffect(() => {
    const t = setTimeout(() => setEntityType(entityTypeRaw), 400)
    return () => clearTimeout(t)
  }, [entityTypeRaw])

  const buildQs = useCallback((off = offset) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) })
    if (entityType) p.set('entity_type', entityType)
    if (action) p.set('action', action)
    if (actorId) p.set('actor_id', actorId)
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo) p.set('date_to', dateTo)
    return p.toString()
  }, [entityType, action, actorId, dateFrom, dateTo, offset])

  const load = useCallback(async (off = 0) => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch(`/api/compliance/audit-log?${buildQs(off)}`)
      setRows(res.data ?? res)
      setOffset(off)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [buildQs])

  useEffect(() => { load(0) }, [entityType, action, actorId, dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  async function doExport() {
    const p = new URLSearchParams()
    if (entityType) p.set('entity_type', entityType)
    if (action) p.set('action', action)
    if (actorId) p.set('actor_id', actorId)
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo) p.set('date_to', dateTo)
    try {
      await apiExport(`/api/compliance/audit-log/export?${p.toString()}`, `audit-trail-${dateFrom}-${dateTo}`)
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const cols: ColDef<AuditRow>[] = [
    { key: 'actor_name', label: 'Actor', render: r => (
      <span>
        <span className="font-medium" style={{ color: 'var(--txt)' }}>{r.actor_name || '—'}</span>
        <span className="ml-1.5 text-[11px]" style={{ color: 'var(--txt2)' }}>{r.actor_role}</span>
      </span>
    )},
    { key: 'action', label: 'Action', render: r => (
      <span className="font-mono text-[12px]" style={{ color: 'var(--txt)' }}>{r.action}</span>
    )},
    { key: 'entity_type', label: 'Entity Type', render: r => (
      <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{r.entity_type}</span>
    )},
    { key: 'entity_id', label: 'Entity ID', render: r => (
      <span className="font-mono text-[11px] truncate max-w-[120px] block" style={{ color: 'var(--txt2)' }}>{r.entity_id || '—'}</span>
    )},
    { key: 'ip_address', label: 'IP Address', render: r => (
      <span className="font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>{r.ip_address || '—'}</span>
    )},
    { key: 'created_at', label: 'Time', render: r => (
      <span className="text-[12px] whitespace-nowrap" style={{ color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>
    )},
  ]

  return (
    <Page dept="Compliance" title="Audit Trail"
      subtitle="Full log of all user actions across the platform"
      actions={
        <button onClick={doExport}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium"
          style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)', background: 'var(--card)' }}>
          <span className="material-symbols-rounded text-[15px]">download</span>
          Export CSV
        </button>
      }>

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="text" placeholder="Filter by action…" value={actionRaw}
          onChange={e => setActionRaw(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', minWidth: 180 }} />
        <input
          type="text" placeholder="Entity type…" value={entityTypeRaw}
          onChange={e => setEntityTypeRaw(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', minWidth: 150 }} />
        <select
          value={actorId} onChange={e => setActorId(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', minWidth: 160 }}>
          <option value="">All actors</option>
          {actors.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
      </div>

      <ErrBanner msg={error} />

      <SectionCard title="Audit Log" badge={rows.length}>
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="history" emptyMsg="No audit entries found" />
        <div className="flex items-center justify-between px-5 py-3"
          style={{ borderTop: '1px solid var(--bdr)' }}>
          <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>
            Showing {offset + 1}–{offset + rows.length}
          </span>
          <div className="flex gap-2">
            <button disabled={offset === 0}
              onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
              className="px-3 py-1 rounded border text-[12px] disabled:opacity-40"
              style={{ borderColor: 'var(--bdr)', color: NAVY }}>
              Previous
            </button>
            <button disabled={rows.length < PAGE_SIZE}
              onClick={() => load(offset + PAGE_SIZE)}
              className="px-3 py-1 rounded border text-[12px] disabled:opacity-40"
              style={{ borderColor: 'var(--bdr)', color: NAVY }}>
              Next
            </button>
          </div>
        </div>
      </SectionCard>
    </Page>
  )
}
