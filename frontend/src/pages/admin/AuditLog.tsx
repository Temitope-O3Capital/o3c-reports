import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, INTER, SORA, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogEntry {
  id: number
  page: string
  action: string
  detail: string
  ip: string
  ts: string
  full_name?: string
  email?: string
  role?: string
}


// ── Columns ───────────────────────────────────────────────────────────────────

const COLS: TableCol<LogEntry>[] = [
  { key: 'ts', label: 'Time', sortable: true, width: 155,
    render: r => <span style={{ ...NUM, fontSize: 11.5, color: 'var(--txt2)' }}>{fmtDatetime(r.ts)}</span> },
  { key: 'full_name', label: 'User',
    render: r => (
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.full_name ?? r.email ?? 'Unknown'}</div>
        {r.role && <div style={{ fontSize: 11.5, color: 'var(--txt3)', textTransform: 'capitalize' }}>{r.role.replace(/_/g, ' ')}</div>}
      </div>
    ),
  },
  { key: 'page', label: 'Module',
    render: r => <span style={{ fontSize: 12, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: 6, padding: '2px 9px', fontWeight: 600 }}>{r.page}</span> },
  { key: 'action', label: 'Action',
    render: r => <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)' }}>{r.action}</span> },
  { key: 'detail', label: 'Detail',
    render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.detail || '—'}</span> },
  { key: 'ip', label: 'IP', width: 120,
    render: r => <span style={{ ...NUM, fontSize: 11.5, color: 'var(--txt3)' }}>{r.ip || '—'}</span> },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminAuditLog() {
  const [rows,    setRows]    = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')
  const [pageFilter, setPageFilter] = useState('')
  const [limit, setLimit]     = useState(200)

  const load = useCallback(async (lim = limit) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<LogEntry[]>(`/api/admin/activity?limit=${lim}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [limit])

  useEffect(() => { load() }, [load])

  const pages = [...new Set(rows.map(r => r.page))].sort()

  const displayed = useMemo(() => {
    return rows.filter(r => {
      if (pageFilter && r.page !== pageFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          (r.full_name ?? '').toLowerCase().includes(q) ||
          (r.email ?? '').toLowerCase().includes(q) ||
          r.action.toLowerCase().includes(q) ||
          (r.detail ?? '').toLowerCase().includes(q) ||
          r.page.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [rows, search, pageFilter])

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Audit Log"
      subtitle="All platform activity — user actions, logins, data changes"
      actions={
        <select
          value={limit}
          onChange={e => { setLimit(Number(e.target.value)); load(Number(e.target.value)) }}
          style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
        >
          <option value={100}>Last 100</option>
          <option value={200}>Last 200</option>
          <option value={500}>Last 500</option>
          <option value={1000}>Last 1000</option>
        </select>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Activity Log" badge={displayed.length} padding={false}>

        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select
            value={pageFilter} onChange={e => setPageFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
          >
            <option value="">All modules</option>
            {pages.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
            {displayed.length} of {rows.length} entries
          </span>
        </div>

        <DataTable cols={COLS} rows={displayed} keyFn={r => r.id} loading={loading} emptyText="No activity found" />
      </SectionCard>
    </Page>
  )
}
