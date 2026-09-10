import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'

// ── Types (pivot Report Builder — see backend savedMyDashboard) ─────────────────

interface DeliveryRow { report_name: string; last_status?: string; last_run_at?: string; format?: string }
interface UpcomingRow {
  report_name: string; frequency: string; hour: number
  day_of_week: number; day_of_month: number
  next_run_at: string | null; last_run_at: string | null; format?: string
}
interface ReportRow { id: number; name: string; dataset: string; is_public: boolean; updated_at: string }
interface Dash {
  my_reports?: number; shared_reports?: number
  scheduled_active?: number; scheduled_due?: number
  delivered_today?: number; failed_recent?: number
  next_scheduled_at?: string | null
  upcoming_schedules?: UpcomingRow[]
  recent_deliveries?: DeliveryRow[]
  my_report_list?: ReportRow[]
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function describeSchedule(s: UpcomingRow): string {
  const hh = `${String(s.hour ?? 0).padStart(2, '0')}:00`
  if (s.frequency === 'weekly') return `Weekly · ${DOW[s.day_of_week] ?? 'Monday'} at ${hh}`
  if (s.frequency === 'monthly') return `Monthly · day ${s.day_of_month} at ${hh}`
  return `Daily at ${hh}`
}
function statusColor(s?: string) {
  const l = (s || '').toLowerCase()
  if (l.startsWith('sent')) return GREEN
  if (l.startsWith('error')) return RED
  return NAVY
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BIMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<Dash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (_silent = false) => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/reports/my-dashboard')
      setD((r?.data ?? r ?? {}) as Dash)
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
  const sharedReports = d.shared_reports ?? 0
  const schedActive = d.scheduled_active ?? 0
  const schedDue = d.scheduled_due ?? 0
  const deliveredToday = d.delivered_today ?? 0
  const failed = d.failed_recent ?? 0
  const onSchedule = Math.max(0, schedActive - schedDue)

  const goSaved = () => navigate('/reports/builder?tab=saved')
  const goSchedules = () => navigate('/reports/builder?tab=schedules')

  const upcomingCols: TableCol<UpcomingRow>[] = [
    { key: 'report_name', label: 'Report', render: r => <span style={{ fontWeight: FW.semibold }}>{r.report_name || '—'}</span> },
    { key: 'frequency', label: 'Schedule', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{describeSchedule(r)}</span> },
    { key: 'next_run_at', label: 'Next Run', render: r => r.next_run_at
      ? <span style={{ color: new Date(r.next_run_at).getTime() <= Date.now() ? AMBER : 'var(--txt2)', fontWeight: FW.semibold, fontSize: TEXT.xs }}>{fmtDatetime(r.next_run_at)}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  const deliveryCols: TableCol<DeliveryRow>[] = [
    { key: 'report_name', label: 'Report', render: r => <span style={{ fontWeight: FW.semibold }}>{r.report_name || '—'}</span> },
    { key: 'last_status', label: 'Result', render: r => <StatusPill label={(r.last_status || '—').split(' ·')[0]} color={statusColor(r.last_status)} /> },
    { key: 'last_run_at', label: 'Sent', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(r.last_run_at || '')}</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your analytics station: saved reports, schedules and deliveries">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={schedDue > 0
          ? <><strong style={{ color: '#FCD34D' }}>{fmtNum(schedDue)}</strong> scheduled report{schedDue === 1 ? '' : 's'} due to run{failed > 0 ? <> · <strong style={{ color: '#FCA5A5' }}>{fmtNum(failed)}</strong> failed this week</> : ''}</>
          : d.next_scheduled_at
            ? <>All schedules on track · next run <strong style={{ color: '#fff' }}>{fmtDatetime(d.next_scheduled_at)}</strong></>
            : 'No schedules pending. Build a report to get started.'}
        ring={schedActive > 0 ? { value: onSchedule, max: schedActive, unit: 'on schedule' } : undefined}
        stats={[
          { label: 'My Reports', value: fmtNum(myReports) },
          { label: 'Shared Reports', value: fmtNum(sharedReports) },
          { label: 'Schedules', value: fmtNum(schedActive) },
          { label: 'Due Now', value: fmtNum(schedDue), color: schedDue > 0 ? '#FCD34D' : '#fff' },
          { label: 'Sent Today', value: fmtNum(deliveredToday), color: '#4ADE80' },
          { label: 'Failed (7d)', value: fmtNum(failed), color: failed > 0 ? '#FCA5A5' : '#fff' },
        ]}
        actions={<>
          <HeroButton icon="add_chart" label="Report Builder" primary onClick={() => navigate('/reports/builder')} />
          <HeroButton icon="bookmarks" label="Saved Reports" onClick={goSaved} />
          <HeroButton icon="schedule" label="Scheduled" onClick={goSchedules} />
          <HeroButton icon="speed" label="KPI Tracker" onClick={() => navigate('/reports/kpi')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="analytics work waiting on you">
        <MyDayTile icon="alarm" count={fmtNum(schedDue)} label="Schedules due"
          sub={schedDue > 0 ? 'due to run now' : 'all on schedule'}
          color={AMBER} urgent={schedDue > 0} onClick={goSchedules} />
        <MyDayTile icon="error" count={fmtNum(failed)} label="Failed sends (7d)"
          sub={failed > 0 ? 'investigate & re-run' : 'no failures'}
          color={failed > 0 ? RED : GREEN} urgent={failed > 0} onClick={goSchedules} />
        <MyDayTile icon="mark_email_read" count={fmtNum(deliveredToday)} label="Sent today"
          sub="reports emailed today" color={BLUE} onClick={goSchedules} />
        <MyDayTile icon="bookmarks" count={fmtNum(myReports)} label="My reports"
          sub="saved report definitions" color={PURPLE} onClick={goSaved} />
      </MyDaySection>

      {/* Upcoming schedules */}
      <SectionCard title="Upcoming Scheduled Reports" badge={d.upcoming_schedules?.length ?? 0} style={{ marginBottom: 14 }}>
        <DataTable
          cols={upcomingCols}
          rows={d.upcoming_schedules ?? []}
          keyFn={(r) => `${r.report_name}-${r.frequency}-${r.hour}`}
          onRowClick={goSchedules}
          pageSize={8}
          emptyText="No active schedules"
        />
      </SectionCard>

      {/* Recent deliveries */}
      <SectionCard title="Recent Deliveries" badge={d.recent_deliveries?.length ?? 0}>
        <DataTable
          cols={deliveryCols}
          rows={d.recent_deliveries ?? []}
          keyFn={(r) => `${r.report_name}-${r.last_run_at}`}
          onRowClick={goSchedules}
          pageSize={8}
          emptyText="No deliveries yet"
        />
      </SectionCard>
    </Page>
  )
}
