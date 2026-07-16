import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, ConfirmModal, btnPrimary, btnDanger, btnSecondary } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReportDef {
  id:               number
  name:             string
  description:      string | null
  module:           string
  date_range:       string
  is_public:        boolean
  run_count:        number
  last_run_at:      string | null
  created_at:       string
  created_by_name:  string | null
}

interface Run {
  id:               number
  report_id:        number
  report_name:      string
  status:           'running' | 'completed' | 'failed'
  row_count:        number | null
  error_message:    string | null
  started_at:       string
  finished_at:      string | null
  run_by_name:      string | null
}

const MODULE_COLORS: Record<string, string> = {
  LOS: NAVY, Collections: RED, CRM: BLUE, Finance: GREEN,
  HR: AMBER, Helpdesk: '#7C3AED', Campaigns: '#EC4899', Compliance: '#DC2626',
}

function ModulePill({ module }: { module: string }) {
  const color = MODULE_COLORS[module] ?? NAVY
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md,
      background: `${color}18`, color }}>
      {module}
    </span>
  )
}

function RunStatusPill({ status }: { status: string }) {
  const s = status === 'completed'
    ? { bg: `${GREEN}18`, color: GREEN }
    : status === 'running'
      ? { bg: `${BLUE}18`, color: BLUE }
      : { bg: `${RED}15`, color: RED }
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md, ...s }}>{status}</span>
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function BIOverview() {
  const navigate = useNavigate()
  const [reports, setReports] = useState<ReportDef[]>([])
  const [runs,    setRuns]    = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ReportDef | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [reps, runList] = await Promise.all([
        apiFetch<ReportDef[]>('/api/bi/reports'),
        apiFetch<Run[]>('/api/bi/runs'),
      ])
      setReports(reps ?? [])
      setRuns(runList ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const runReport = async (id: number) => {
    try {
      await apiFetch(`/api/bi/reports/${id}/run`, { method: 'POST', body: '{}' })
      toast.success('Report run complete')
      load()
    } catch (e: any) { toast.error(e.message) }
  }

  const deleteReport = async () => {
    if (!deleting) return
    try {
      await apiFetch(`/api/bi/reports/${deleting.id}`, { method: 'DELETE' })
      toast.success('Report deleted')
      setDeleting(null)
      load()
    } catch (e: any) { toast.error(e.message); setDeleting(null) }
  }

  const REPORT_COLS: TableCol<ReportDef>[] = [
    { key: 'name', label: 'Report', render: r => (
      <div>
        <div style={{ fontWeight: FW.bold, fontSize: TEXT.base }}>{r.name}</div>
        {r.description && <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{r.description}</div>}
      </div>
    )},
    { key: 'module',      label: 'Module',    render: r => <ModulePill module={r.module} /> },
    { key: 'date_range',  label: 'Range',     render: r => <span style={{ fontSize: TEXT.sm }}>{r.date_range.replace(/_/g, ' ')}</span> },
    { key: 'run_count',   label: 'Runs',      render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{r.run_count}</span> },
    { key: 'last_run_at', label: 'Last Run',  render: r => r.last_run_at
      ? <span style={{ fontSize: TEXT.sm, ...NUM }}>{fmtDate(r.last_run_at)}</span>
      : <span style={{ color: 'var(--txt3)' }}>Never</span>
    },
    { key: 'is_public', label: '', render: r => r.is_public
      ? <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: GREEN }}>Public</span>
      : null
    },
    { key: 'id', label: '', render: r => (
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button onClick={() => runReport(r.id)} style={{ ...btnSecondary, padding: '4px 10px', fontSize: TEXT.sm }}>
          Run
        </button>
        <button onClick={() => navigate(`/bi/builder/${r.id}`)} style={{ ...btnSecondary, padding: '4px 10px', fontSize: TEXT.sm }}>
          Edit
        </button>
        <button onClick={() => window.open(`/api/bi/reports/${r.id}/export`, '_blank')}
          style={{ ...btnSecondary, padding: '4px 10px', fontSize: TEXT.sm }}>
          CSV
        </button>
        <button onClick={() => setDeleting(r)} style={{ padding: '4px 10px', fontSize: TEXT.sm, fontWeight: FW.semibold,
          borderRadius: RADIUS.sm, border: 'none', background: `${RED}12`, color: RED, cursor: 'pointer', fontFamily: INTER }}>
          Delete
        </button>
      </div>
    )},
  ]

  const RUN_COLS: TableCol<Run>[] = [
    { key: 'report_name', label: 'Report', render: r => <span style={{ fontWeight: FW.semibold }}>{r.report_name}</span> },
    { key: 'status',      label: 'Status', render: r => <RunStatusPill status={r.status} /> },
    { key: 'row_count',   label: 'Rows',   render: r => <span style={{ ...NUM }}>{r.row_count ?? '—'}</span> },
    { key: 'started_at',  label: 'Started', render: r => <span style={{ fontSize: TEXT.sm, ...NUM }}>{fmtDatetime(r.started_at)}</span> },
    { key: 'run_by_name', label: 'By',     render: r => <span style={{ fontSize: TEXT.sm }}>{r.run_by_name ?? '—'}</span> },
    { key: 'error_message', label: '', render: r => r.error_message
      ? <span style={{ fontSize: TEXT.xs, color: RED, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{r.error_message}</span>
      : null
    },
  ]

  return (
    <Page
      title="BI Reports"
      subtitle="Saved cross-module reports and run history"
      actions={<button onClick={() => navigate('/bi/builder')} style={btnPrimary}>+ New Report</button>}
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <>
          <SectionCard title="Saved Reports" badge={reports.length}
            actions={<button onClick={() => navigate('/bi/scheduled')} style={{ ...btnSecondary, fontSize: TEXT.sm }}>Scheduled Reports</button>}>
            <DataTable cols={REPORT_COLS} rows={reports} keyFn={r => r.id} emptyText="No saved reports yet — create your first report." />
          </SectionCard>

          <SectionCard title="Recent Runs" badge={runs.length}>
            <DataTable cols={RUN_COLS} rows={runs} keyFn={r => r.id} emptyText="No report runs yet" />
          </SectionCard>
        </>
      )}

      <ConfirmModal
        open={!!deleting}
        title={`Delete "${deleting?.name}"?`}
        body="This will permanently delete the report definition and all run history. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={deleteReport}
        onClose={() => setDeleting(null)}
      />
    </Page>
  )
}
