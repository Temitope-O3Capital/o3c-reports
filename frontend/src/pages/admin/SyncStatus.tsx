import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, NUM, INTER, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SyncRun {
  id: number
  started_at: string
  finished_at: string
  status: string
  rows_synced: number
  error_msg?: string
  created_at: string
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  success:  { bg: 'rgba(22,163,74,.1)',  txt: GREEN },
  error:    { bg: 'rgba(192,0,0,.1)',    txt: RED },
  running:  { bg: 'rgba(37,99,235,.1)', txt: '#2563EB' },
  partial:  { bg: 'rgba(217,119,6,.12)', txt: AMBER },
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
      background: c.bg, color: c.txt, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{status}</span>
  )
}

function durationStr(start: string, end: string): string {
  if (!start || !end) return '—'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

// ── Columns ───────────────────────────────────────────────────────────────────

const COLS: TableCol<SyncRun>[] = [
  { key: 'created_at', label: 'Run Time', sortable: true,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.created_at)}</span> },
  { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
  { key: 'rows_synced', label: 'Rows Synced', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.rows_synced)}</span> },
  { key: '_duration', label: 'Duration', align: 'right',
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{durationStr(r.started_at, r.finished_at)}</span> },
  { key: 'error_msg', label: 'Error',
    render: r => r.error_msg ? (
      <span style={{ fontSize: TEXT.sm, color: RED, fontFamily: 'monospace' }}>{r.error_msg.slice(0, 80)}</span>
    ) : <span style={{ color: 'var(--txt3)' }}>—</span> },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminSyncStatus() {
  const [rows,    setRows]    = useState<SyncRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<SyncRun[]>('/api/settings/sync-status')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function triggerSync() {
    try {
      await apiFetch('/api/settings/sync-status', {
        method: 'POST',
        body: JSON.stringify({ status: 'running', rows_synced: 0 }),
      })
      toast.success('Sync run registered')
      load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const lastRun = rows[0]
  const successRate = rows.length > 0
    ? Math.round((rows.filter(r => r.status === 'success').length / rows.length) * 100)
    : 0

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Sync Status"
      subtitle="MSSQL → PostgreSQL sync run history"
      actions={
        <button onClick={triggerSync} style={{
          display: 'flex', alignItems: 'center', gap: SP[1], padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md,
          border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>sync</span>
          Log Sync Run
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 20 }}>
        {[
          { label: 'Total Runs', value: rows.length },
          { label: 'Last Status', value: lastRun?.status ?? '—', color: lastRun ? STATUS_COLORS[lastRun.status]?.txt : 'var(--txt)' },
          { label: 'Success Rate', value: `${successRate}%`, color: successRate >= 80 ? GREEN : successRate >= 50 ? AMBER : RED },
          { label: 'Last Rows', value: lastRun ? fmtNum(lastRun.rows_synced) : '—' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 6 }}>{label}</div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: color ?? 'var(--txt)' }}>{value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="Run History" badge={rows.length} padding={false}>
        <DataTable cols={COLS} rows={rows} keyFn={r => r.id} loading={loading} emptyText="No sync runs recorded" />
      </SectionCard>
    </Page>
  )
}
