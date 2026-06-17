import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, StatusBadge, KpiCard, Page, SectionCard, GREEN, RED, AMBER, NAVY } from '../../components/UI'

interface SyncRun {
  id: string; started_at: string; finished_at: string | null
  status: string; rows_synced: number | null; error_msg: string | null; created_at: string
}

function duration(started: string, finished: string | null): string {
  if (!finished) return 'Running…'
  const ms = new Date(finished).getTime() - new Date(started).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

const STATUS_ICON: Record<string, string> = {
  success: 'check_circle',
  failed:  'cancel',
  partial: 'warning',
}

const STATUS_COLOR: Record<string, string> = {
  success: GREEN,
  failed:  RED,
  partial: AMBER,
}

export default function SyncStatus() {
  const [runs, setRuns]       = useState<SyncRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch<SyncRun[]>('/api/settings/sync-status')
      setRuns(Array.isArray(res) ? res : (res as any).data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const successCount = runs.filter(r => r.status === 'success').length
  const failedCount  = runs.filter(r => r.status === 'failed').length
  const lastRun      = runs[0] ?? null
  const totalRows    = runs.reduce((s, r) => s + (r.rows_synced ?? 0), 0)

  return (
    <Page
      dept="Admin"
      title="Sync Status"
      actions={
        <button onClick={load} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] flex items-center gap-1.5">
          <span className="material-symbols-rounded text-[16px]">refresh</span>
          Refresh
        </button>
      }
    >
      <ErrBanner msg={error} />

      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard label="Last Run Status" value={lastRun?.status ?? '—'} icon={STATUS_ICON[lastRun?.status ?? ''] ?? 'sync'} accent={STATUS_COLOR[lastRun?.status ?? ''] ?? NAVY} loading={loading && !runs.length} />
        <KpiCard label="Successes (last 10)" value={String(successCount)} icon="check_circle" accent={GREEN} loading={loading && !runs.length} />
        <KpiCard label="Failures (last 10)"  value={String(failedCount)}  icon="cancel"       accent={RED}   loading={loading && !runs.length} />
        <KpiCard label="Rows Synced (last 10)" value={totalRows.toLocaleString()} icon="table_rows" accent={NAVY} loading={loading && !runs.length} />
      </div>

      <SectionCard title="Recent Sync Runs" subtitle="Last 10 runs">
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-slate-400">
            <span className="material-symbols-rounded text-[40px] mb-2">sync_disabled</span>
            <p className="text-[13px]">No sync runs recorded yet.</p>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            {runs.map((run, i) => {
              const color = STATUS_COLOR[run.status] ?? '#64748B'
              const icon  = STATUS_ICON[run.status]  ?? 'sync'
              return (
                <div key={run.id} className="relative flex gap-4">
                  {/* Timeline line */}
                  {i < runs.length - 1 && (
                    <div className="absolute left-[13px] top-8 bottom-0 w-px" style={{ background: 'rgba(14,40,65,0.1)' }} />
                  )}

                  {/* Icon */}
                  <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ background: `${color}15`, border: `1.5px solid ${color}30` }}>
                    <span className="material-symbols-rounded text-[14px]" style={{ color }}>{icon}</span>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 pb-4">
                    <div className="flex items-center gap-3 flex-wrap mb-1">
                      <StatusBadge status={run.status} />
                      <span className="text-[12px] text-slate-500">{fmtDate(run.started_at, { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                      <span className="text-[11px] text-slate-400">
                        {new Date(run.started_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 mt-1.5">
                      <span className="flex items-center gap-1 text-[12px] text-slate-600">
                        <span className="material-symbols-rounded text-[14px] text-slate-400">timer</span>
                        {duration(run.started_at, run.finished_at)}
                      </span>
                      {run.rows_synced != null && (
                        <span className="flex items-center gap-1 text-[12px] text-slate-600">
                          <span className="material-symbols-rounded text-[14px] text-slate-400">table_rows</span>
                          {run.rows_synced.toLocaleString()} rows synced
                        </span>
                      )}
                    </div>
                    {run.error_msg && (
                      <div className="mt-2 px-3 py-2 rounded-lg text-[12px] text-red-700"
                        style={{ background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.15)' }}>
                        <span className="font-semibold">Error: </span>{run.error_msg}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
