import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, SearchInput, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, monthStart, today } from '../../lib/fmt'
import { NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

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
    render: r => <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDatetime(r.ts)}</span> },
  { key: 'full_name', label: 'User',
    render: r => (
      <div>
        <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{r.full_name ?? r.email ?? 'Unknown'}</div>
        {r.role && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'capitalize' }}>{r.role.replace(/_/g, ' ')}</div>}
      </div>
    ),
  },
  { key: 'page', label: 'Module',
    render: r => <span style={{ fontSize: TEXT.sm, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: RADIUS.sm, padding: '2px 9px', fontWeight: FW.semibold }}>{r.page}</span> },
  { key: 'action', label: 'Action',
    render: r => <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.action}</span> },
  { key: 'detail', label: 'Detail',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.detail || '—'}</span> },
  { key: 'ip', label: 'IP', width: 120,
    render: r => <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.ip || '—'}</span> },
]

// ── Export ────────────────────────────────────────────────────────────────────

function exportAuditLogCsv(rows: LogEntry[]) {
  const header = ['Time', 'User', 'Email', 'Role', 'Module', 'Action', 'Detail', 'IP']
  const lines = rows.map(r => [
    r.ts ?? '',
    `"${String(r.full_name ?? '').replace(/"/g, '""')}"`,
    `"${String(r.email ?? '').replace(/"/g, '""')}"`,
    r.role ?? '',
    r.page ?? '',
    `"${String(r.action ?? '').replace(/"/g, '""')}"`,
    `"${String(r.detail ?? '').replace(/"/g, '""')}"`,
    r.ip ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminAuditLog() {
  const [rows,    setRows]    = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')
  const [pageFilter, setPageFilter] = useState('')
  const [limit, setLimit]     = useState(200)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async (lim = limit) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<{ data: LogEntry[] }>(`/api/admin/activity?limit=${lim}&from=${dateFrom}&to=${dateTo}`)
      setRows(data.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [limit, dateFrom, dateTo])

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <select
            value={limit}
            onChange={e => { setLimit(Number(e.target.value)); load(Number(e.target.value)) }}
            style={{ padding: '7px 12px', borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
          >
            <option value={100}>Last 100</option>
            <option value={200}>Last 200</option>
            <option value={500}>Last 500</option>
            <option value={1000}>Last 1000</option>
          </select>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Activity Log" badge={displayed.length} padding={false} actions={<button onClick={() => exportAuditLogCsv(displayed)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>

        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: SP[2], alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select
            value={pageFilter} onChange={e => setPageFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
          >
            <option value="">All modules</option>
            {pages.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {displayed.length} of {rows.length} entries
          </span>
        </div>

        <DataTable cols={COLS} rows={displayed} keyFn={r => r.id} loading={loading} emptyText="No activity found" pageSize={20} />
      </SectionCard>
    </Page>
  )
}
