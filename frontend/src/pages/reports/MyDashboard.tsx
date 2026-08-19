import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunRow { status: string; row_count: number; started_at: string; report_name: string; run_by_name: string }
interface ScheduleRow { cron_expr: string; next_run_at: string | null; last_run_at: string | null; report_name: string }
interface ReportRow { id: number; name: string; module: string; is_public: boolean; updated_at: string }
interface BIDash {
  my_reports?: number; public_reports?: number
  scheduled_active?: number; scheduled_due?: number
  runs_today?: number; runs_failed_7d?: number; my_exports_7d?: number
  next_scheduled_at?: string | null
  recent_runs?: RunRow[]
  upcoming_schedules?: ScheduleRow[]
  my_report_list?: ReportRow[]
}

function runStatusColor(s: string) {
  const l = (s || '').toLowerCase()
  if (l === 'completed' || l === 'success') return GREEN
  if (l === 'failed' || l === 'error') return RED
  if (l === 'running' || l === 'pending') return BLUE
  return NAVY
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BIMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<BIDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/bi/my-dashboard')
      setD((r?.data ?? r ?? {}) as BIDash)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['reports'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !d) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !d) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!d) return null

  const myReports = d.my_reports ?? 0
  const publicReports = d.public_reports ?? 0
  const schedActive = d.scheduled_active ?? 0
  const schedDue = d.scheduled_due ?? 0
  const runsToday = d.runs_today ?? 0
  const runsFailed = d.runs_failed_7d ?? 0
  const myExports = d.my_exports_7d ?? 0
  const onSchedule = Math.max(0, schedActive - schedDue)

  const runCols: TableCol<RunRow>[] = [
    { key: 'report_name', label: 'Report', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.report_name || '(ad-hoc)'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{r.run_by_name || ''}</div>
      </div>
    )},
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={runStatusColor(r.status)} /> },
    { key: 'row_count', label: 'Rows', align: 'right', render: r => <span style={NUM}>{fmtNum(r.row_count ?? 0)}</span> },
    { key: 'started_at', label: 'Ran', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(r.started_at)}</span> },
  ]

  const schedCols: TableCol<ScheduleRow>[] = [
    { key: 'report_name', label: 'Report', render: r => <span style={{ fontWeight: FW.semibold }}>{r.report_name || '—'}</span> },
    { key: 'cron_expr', label: 'Schedule', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.cron_expr || '—'}</span> },
    { key: 'next_run_at', label: 'Next Run', render: r => r.next_run_at
      ? <span style={{ color: new Date(r.next_run_at).getTime() <= Date.now() ? AMBER : 'var(--txt2)', fontWeight: FW.semibold, fontSize: TEXT.xs }}>{fmtDatetime(r.next_run_at)}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your analytics station: reports, schedules and runs">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={schedDue > 0
          ? <><strong style={{ color: '#FCD34D' }}>{fmtNum(schedDue)}</strong> scheduled report{schedDue === 1 ? '' : 's'} due to run{runsFailed > 0 ? <> · <strong style={{ color: '#FCA5A5' }}>{fmtNum(runsFailed)}</strong> failed this week</> : ''}</>
          : d.next_scheduled_at
            ? <>All schedules on track · next run <strong style={{ color: '#fff' }}>{fmtDatetime(d.next_scheduled_at)}</strong></>
            : 'No schedules pending. Build or run a report to get started.'}
        ring={schedActive > 0 ? { value: onSchedule, max: schedActive, unit: 'on schedule' } : undefined}
        stats={[
          { label: 'My Reports', value: fmtNum(myReports) },
          { label: 'Shared Reports', value: fmtNum(publicReports) },
          { label: 'Schedules', value: fmtNum(schedActive) },
          { label: 'Due Now', value: fmtNum(schedDue), color: schedDue > 0 ? '#FCD34D' : '#fff' },
          { label: 'Runs Today', value: fmtNum(runsToday), color: '#4ADE80' },
          { label: 'Failed (7d)', value: fmtNum(runsFailed), color: runsFailed > 0 ? '#FCA5A5' : '#fff' },
        ]}
        actions={<>
          <HeroButton icon="add_chart" label="Report Builder" primary onClick={() => navigate('/bi/builder')} />
          <HeroButton icon="bookmarks" label="Saved Reports" onClick={() => navigate('/bi')} />
          <HeroButton icon="schedule" label="Scheduled" onClick={() => navigate('/bi/scheduled')} />
          <HeroButton icon="speed" label="KPI Tracker" onClick={() => navigate('/reports/kpi')} />
          <HeroButton icon="download" label="Data Export" onClick={() => navigate('/reports/export')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="analytics work waiting on you">
        <MyDayTile icon="alarm" count={fmtNum(schedDue)} label="Schedules due"
          sub={schedDue > 0 ? 'due to run now' : 'all on schedule'}
          color={AMBER} urgent={schedDue > 0} onClick={() => navigate('/bi/scheduled')} />
        <MyDayTile icon="error" count={fmtNum(runsFailed)} label="Failed runs (7d)"
          sub={runsFailed > 0 ? 'investigate & re-run' : 'no failures'}
          color={runsFailed > 0 ? RED : GREEN} urgent={runsFailed > 0} onClick={() => navigate('/bi/scheduled')} />
        <MyDayTile icon="play_circle" count={fmtNum(runsToday)} label="Runs today"
          sub="reports executed today" color={BLUE} onClick={() => navigate('/bi')} />
        <MyDayTile icon="download" count={fmtNum(myExports)} label="My exports (7d)"
          sub="data pulls this week" color={PURPLE} onClick={() => navigate('/reports/export')} />
      </MyDaySection>

      {/* Upcoming schedules */}
      <SectionCard title="Upcoming Scheduled Reports" badge={d.upcoming_schedules?.length ?? 0} style={{ marginBottom: 14 }}>
        <DataTable
          cols={schedCols}
          rows={d.upcoming_schedules ?? []}
          keyFn={(r) => `${r.report_name}-${r.cron_expr}`}
          onRowClick={() => navigate('/bi/scheduled')}
          pageSize={8}
          emptyText="No active schedules"
        />
      </SectionCard>

      {/* Recent runs */}
      <SectionCard title="Recent Runs" badge={d.recent_runs?.length ?? 0}>
        <DataTable
          cols={runCols}
          rows={d.recent_runs ?? []}
          keyFn={(r) => `${r.report_name}-${r.started_at}`}
          onRowClick={() => navigate('/bi')}
          pageSize={8}
          emptyText="No runs yet"
        />
      </SectionCard>
    </Page>
  )
}
