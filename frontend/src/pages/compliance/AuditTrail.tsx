import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, DateFilter } from '../../components/UI'
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
  const [allLogs, setAllLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [search, setSearch]         = useState('')
  const [fModule, setFModule]       = useState(new Set<string>())
  const [fAction, setFAction]       = useState(new Set<string>())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (from) p.set('date_from', from)
      if (to)   p.set('date_to', to)
      p.set('limit', '500')
      p.set('offset', '0')
      const res = await apiFetch<{ data: { logs: AuditLog[]; total: number } }>(`/api/compliance/audit-log?${p}`)
      setAllLogs(res.data?.logs ?? [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['compliance'] })

  const uniqueModules = useMemo(() => [...new Set(allLogs.map(l => l.entity_type).filter(Boolean))] as string[], [allLogs])
  const uniqueActions = useMemo(() => [...new Set(allLogs.map(l => l.action).filter(Boolean))] as string[], [allLogs])

  const logs = useMemo(() => allLogs.filter(l => {
    if (fModule.size && !fModule.has(l.entity_type)) return false
    if (fAction.size && !fAction.has(l.action)) return false
    if (search) {
      const q = search.toLowerCase()
      if (![l.actor_name, l.action, l.entity_type].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [allLogs, fModule, fAction, search])

  async function handleExport() {
    setExporting(true)
    try {
      const p = new URLSearchParams()
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

  return (
    <Page
      title="Audit Trail"
      subtitle="Read-only log of all system actions"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
          <button
            onClick={handleExport}
            disabled={exporting}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer', opacity: exporting ? 0.7 : 1 }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>download</span>
            Export CSV
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard
        title="Audit Log"
        badge={allLogs.length}
        subtitle="Sorted by most recent · Read only"
        padding={false}
      >
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={[
            {
              key: 'module', label: 'Entity Type',
              options: uniqueModules.map(m => ({ value: m, count: allLogs.filter(l => l.entity_type === m).length })),
              selected: fModule, onChange: (next: Set<string>) => setFModule(next),
            },
            {
              key: 'action', label: 'Action',
              options: uniqueActions.map(a => ({ value: a, count: allLogs.filter(l => l.action === a).length })),
              selected: fAction, onChange: (next: Set<string>) => setFAction(next),
            },
          ]}
          onReset={() => { setSearch(''); setFModule(new Set()); setFAction(new Set()) }}
          resultCount={logs.length} totalCount={allLogs.length}
          placeholder="Search by user, action or entity…"
        />
        <DataTable<AuditLog>
          cols={cols}
          rows={logs}
          keyFn={r => r.id}
          emptyText="No audit log entries found."
          skeletonRows={loading ? 10 : 0}
          pageSize={50}
        />
      </SectionCard>
    </Page>
  )
}
