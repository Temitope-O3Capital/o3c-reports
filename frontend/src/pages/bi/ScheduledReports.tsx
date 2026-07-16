import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, Modal, ConfirmModal, btnPrimary, btnSecondary, btnDanger } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, NUM, INTER, MONO, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReportDef {
  id:     number
  name:   string
  module: string
}

interface Schedule {
  id:              number
  report_id:       number
  report_name:     string
  module:          string
  cron_expr:       string
  recipients:      string[] | null
  format:          string
  is_active:       boolean
  last_run_at:     string | null
  next_run_at:     string | null
  created_at:      string
  created_by_name: string | null
}

const CRON_PRESETS = [
  { label: 'Daily at 7am',    value: '0 7 * * *' },
  { label: 'Weekly (Mon 8am)', value: '0 8 * * 1' },
  { label: 'Monthly (1st 8am)', value: '0 8 1 * *' },
]

const FORMAT_OPTS = ['csv', 'json']

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ScheduledReports() {
  const navigate = useNavigate()
  const [schedules,  setSchedules]  = useState<Schedule[]>([])
  const [reports,    setReports]    = useState<ReportDef[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [showNew,    setShowNew]    = useState(false)
  const [deleting,   setDeleting]   = useState<Schedule | null>(null)

  // New schedule form
  const [formReport,    setFormReport]    = useState('')
  const [formCron,      setFormCron]      = useState('0 7 * * *')
  const [formRecip,     setFormRecip]     = useState('')
  const [formFormat,    setFormFormat]    = useState('csv')
  const [saving,        setSaving]        = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [scheds, reps] = await Promise.all([
        apiFetch<Schedule[]>('/api/bi/scheduled'),
        apiFetch<ReportDef[]>('/api/bi/reports'),
      ])
      setSchedules(scheds ?? [])
      setReports(reps ?? [])
      if ((reps ?? []).length > 0 && !formReport) {
        setFormReport(String((reps as ReportDef[])[0].id))
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [formReport])

  useEffect(() => { load() }, [load])

  const createSchedule = async () => {
    if (!formReport || !formCron.trim()) { toast.error('Select a report and enter a cron expression'); return }
    const recipients = formRecip.split(',').map(s => s.trim()).filter(Boolean)
    setSaving(true)
    try {
      await apiPost(`/api/bi/reports/${formReport}/schedule`, {
        cron_expr:  formCron.trim(),
        recipients,
        format:     formFormat,
      })
      toast.success('Schedule created')
      setShowNew(false)
      setFormCron('0 7 * * *'); setFormRecip(''); setFormFormat('csv')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const deleteSchedule = async () => {
    if (!deleting) return
    try {
      await apiFetch(`/api/bi/scheduled/${deleting.id}`, { method: 'DELETE' })
      toast.success('Schedule deleted')
      setDeleting(null)
      load()
    } catch (e: any) { toast.error(e.message); setDeleting(null) }
  }

  const COLS: TableCol<Schedule>[] = [
    { key: 'report_name', label: 'Report', render: r => (
      <div>
        <div style={{ fontWeight: FW.bold, fontSize: TEXT.base }}>{r.report_name}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.module}</div>
      </div>
    )},
    { key: 'cron_expr', label: 'Schedule', render: r => (
      <div>
        <div style={{ fontFamily: MONO, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>{r.cron_expr}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{cronLabel(r.cron_expr)}</div>
      </div>
    )},
    { key: 'format',    label: 'Format',    render: r => <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, textTransform: 'uppercase' }}>{r.format}</span> },
    { key: 'is_active', label: 'Status',    render: r => (
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md,
        background: r.is_active ? `${GREEN}18` : 'var(--bdr)', color: r.is_active ? GREEN : 'var(--txt3)' }}>
        {r.is_active ? 'Active' : 'Paused'}
      </span>
    )},
    { key: 'last_run_at', label: 'Last Run', render: r => r.last_run_at
      ? <span style={{ fontSize: TEXT.sm, ...NUM }}>{fmtDate(r.last_run_at)}</span>
      : <span style={{ color: 'var(--txt3)' }}>Never</span>
    },
    { key: 'next_run_at', label: 'Next Run', render: r => r.next_run_at
      ? <span style={{ fontSize: TEXT.sm, ...NUM }}>{fmtDate(r.next_run_at)}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span>
    },
    { key: 'recipients', label: 'Recipients', render: r => {
      const recs = r.recipients ?? []
      return <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{recs.length > 0 ? recs.join(', ') : '—'}</span>
    }},
    { key: 'id', label: '', render: r => (
      <button onClick={() => setDeleting(r)} style={{ padding: '4px 10px', fontSize: TEXT.sm, fontWeight: FW.semibold,
        borderRadius: RADIUS.sm, border: 'none', background: `${RED}12`, color: RED, cursor: 'pointer', fontFamily: INTER }}>
        Delete
      </button>
    )},
  ]

  const inpStyle: React.CSSProperties = {
    padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER, width: '100%', boxSizing: 'border-box',
  }

  return (
    <Page
      title="Scheduled Reports"
      subtitle="Automate report delivery to email recipients"
      back={{ label: 'BI Overview', to: '/bi' }}
      actions={<button onClick={() => setShowNew(true)} style={btnPrimary}>+ New Schedule</button>}
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <SectionCard title="Schedules" badge={schedules.length}>
          <DataTable cols={COLS} rows={schedules} keyFn={r => r.id}
            emptyText="No scheduled reports yet. Create one to automate report delivery." />
        </SectionCard>
      )}

      {/* New schedule modal */}
      {showNew && (
        <Modal open={showNew} title="New Scheduled Report" onClose={() => setShowNew(false)} width={580}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Report *
              </label>
              {reports.length === 0 ? (
                <div style={{ fontSize: TEXT.base, color: 'var(--txt3)', padding: '8px 0' }}>
                  No saved reports. <button onClick={() => navigate('/bi/builder')} style={{ color: NAVY, fontWeight: FW.bold, background: 'none', border: 'none', cursor: 'pointer', fontFamily: INTER }}>Create one first</button>.
                </div>
              ) : (
                <select value={formReport} onChange={e => setFormReport(e.target.value)} style={inpStyle}>
                  {reports.map(r => <option key={r.id} value={r.id}>{r.name} ({r.module})</option>)}
                </select>
              )}
            </div>

            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Schedule (cron expression) *
              </label>
              <input value={formCron} onChange={e => setFormCron(e.target.value)}
                placeholder="0 7 * * *" style={{ ...inpStyle, fontFamily: MONO }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {CRON_PRESETS.map(p => (
                  <button key={p.value} onClick={() => setFormCron(p.value)}
                    style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: `1px solid var(--bdr)`,
                      background: formCron === p.value ? `${NAVY}12` : 'none', color: NAVY,
                      fontSize: TEXT.xs, cursor: 'pointer', fontFamily: INTER, fontWeight: FW.semibold }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Recipients (comma-separated emails)
              </label>
              <input value={formRecip} onChange={e => setFormRecip(e.target.value)}
                placeholder="alice@o3capital.ng, bob@o3capital.ng" style={inpStyle} />
            </div>

            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Export Format
              </label>
              <select value={formFormat} onChange={e => setFormFormat(e.target.value)} style={inpStyle}>
                {FORMAT_OPTS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', marginTop: SP[2] }}>
              <button onClick={() => setShowNew(false)} style={btnSecondary}>Cancel</button>
              <button onClick={createSchedule} disabled={saving || !formReport} style={btnPrimary}>
                {saving ? 'Creating…' : 'Create Schedule'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmModal
        open={!!deleting}
        title={`Delete schedule for "${deleting?.report_name}"?`}
        body="This will stop all future automated deliveries for this schedule."
        confirmLabel="Delete"
        danger
        onConfirm={deleteSchedule}
        onClose={() => setDeleting(null)}
      />
    </Page>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cronLabel(expr: string): string {
  const presets: Record<string, string> = {
    '0 7 * * *':   'Daily at 7:00 AM',
    '0 8 * * 1':   'Every Monday at 8:00 AM',
    '0 8 1 * *':   '1st of every month at 8:00 AM',
    '0 6 * * 1-5': 'Weekdays at 6:00 AM',
  }
  return presets[expr] ?? 'Custom schedule'
}
