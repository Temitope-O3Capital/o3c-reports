import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { ErrBanner, StatusBadge, KpiCard, Page, SectionCard, DataTable, NAVY, RED, GREEN, AMBER } from '../../components/UI'
import type { ColDef } from '../../components/UI'

interface TrainingRow {
  id: string; training_ref: string; title: string; description: string; trainer: string
  training_date: string; duration_hours: number; department: string
  max_participants: number; enrolled_count: number; status: string; created_at: string
}
interface AddForm {
  title: string; description: string; trainer: string; training_date: string
  duration_hours: string; department: string; max_participants: string
}

const EMPTY_ADD: AddForm = {
  title: '', description: '', trainer: '', training_date: '',
  duration_hours: '', department: '', max_participants: '',
}

export default function Training() {
  const [rows, setRows]         = useState<TrainingRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [statusF, setStatusF]   = useState('')
  const [deptF, setDeptF]       = useState('')

  const [showAdd, setShowAdd]   = useState(false)
  const [addForm, setAddForm]   = useState<AddForm>(EMPTY_ADD)
  const [adding, setAdding]     = useState(false)
  const [addErr, setAddErr]     = useState('')

  const [attending, setAttending] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (statusF) params.set('status', statusF)
      if (deptF)   params.set('dept', deptF)
      const res = await apiFetch<{ data: TrainingRow[] }>(`/api/hr/training?${params}`)
      setRows(res.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusF, deptF])

  useEffect(() => { load() }, [load])

  async function markAttend(id: string) {
    setAttending(id)
    try {
      await apiPut(`/api/hr/training/${id}/attend`, {})
      load()
    } catch {}
    finally { setAttending(null) }
  }

  async function submitAdd() {
    setAdding(true); setAddErr('')
    try {
      await apiPost('/api/hr/training', {
        ...addForm,
        duration_hours:   Number(addForm.duration_hours),
        max_participants: Number(addForm.max_participants),
      })
      setShowAdd(false)
      setAddForm(EMPTY_ADD)
      load()
    } catch (e: any) {
      setAddErr(e.message)
    } finally {
      setAdding(false)
    }
  }

  const scheduled  = rows.filter(r => r.status === 'scheduled').length
  const completed  = rows.filter(r => r.status === 'completed').length
  const totalHours = rows.reduce((s, r) => s + (r.duration_hours || 0), 0)

  // Unique departments from data for filter
  const depts = Array.from(new Set(rows.map(r => r.department).filter(Boolean)))

  const cols: ColDef<TrainingRow>[] = [
    { key: 'training_ref',    label: 'Ref',         render: r => <span className="font-mono text-[12px] text-[color:var(--txt2)]">{r.training_ref}</span> },
    { key: 'title',           label: 'Title',       render: r => <span className="font-semibold text-[color:var(--txt)]">{r.title}</span> },
    { key: 'trainer',         label: 'Trainer' },
    { key: 'department',      label: 'Department',  render: r => r.department || '—' },
    { key: 'training_date',   label: 'Date',        render: r => fmtDate(r.training_date) },
    { key: 'duration_hours',  label: 'Hours',       right: true, render: r => `${r.duration_hours}h` },
    {
      key: 'enrolled',
      label: 'Enrolled',
      right: true,
      render: r => (
        <span className={r.enrolled_count >= r.max_participants ? 'text-red-600 font-semibold' : ''}>
          {r.enrolled_count} / {r.max_participants}
        </span>
      ),
    },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    {
      key: 'attend', label: '', sortable: false,
      render: r => r.status === 'scheduled' ? (
        <button onClick={() => markAttend(r.id)} disabled={attending === r.id || r.enrolled_count >= r.max_participants}
          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-white disabled:opacity-50"
          style={{ background: GREEN }}>
          {attending === r.id ? '…' : 'Attend'}
        </button>
      ) : null,
    },
  ]

  return (
    <Page
      dept="HR"
      title="Training & Development"
      actions={
        <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white" style={{ background: NAVY }}
          onClick={() => { setShowAdd(true); setAddForm(EMPTY_ADD) }}>
          <span className="material-symbols-rounded text-[15px] align-middle mr-1">add</span>
          Schedule Training
        </button>
      }
    >
      <ErrBanner msg={error} />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <KpiCard label="Upcoming Sessions" value={String(scheduled)}  icon="school"       accent={NAVY}  loading={loading && !rows.length} />
        <KpiCard label="Completed"         value={String(completed)}  icon="task_alt"     accent={GREEN} loading={loading && !rows.length} />
        <KpiCard label="Total Hours Planned" value={`${totalHours}h`} icon="timer"        accent={AMBER} loading={loading && !rows.length} />
      </div>

      <SectionCard
        title="Training Sessions"
        actions={
          <div className="flex gap-2">
            <select className="px-3 py-1.5 rounded-lg border border-[var(--bdr)] text-[12px] focus:outline-none"
              value={statusF} onChange={e => setStatusF(e.target.value)}>
              <option value="">All Statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            {depts.length > 0 && (
              <select className="px-3 py-1.5 rounded-lg border border-[var(--bdr)] text-[12px] focus:outline-none"
                value={deptF} onChange={e => setDeptF(e.target.value)}>
                <option value="">All Depts</option>
                {depts.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </div>
        }
      >
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="school" emptyMsg="No training sessions found" />
      </SectionCard>

      {/* Schedule training modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div role="dialog" aria-modal="true" aria-labelledby="training-add-title" className="bg-[var(--card)] rounded-2xl shadow-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 id="training-add-title" className="text-[16px] font-bold text-[color:var(--txt)]">Schedule Training Session</h2>
              <button onClick={() => setShowAdd(false)} className="text-[color:var(--txt2)] hover:text-[color:var(--txt)]">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={addErr} />
            <div className="space-y-3">
              {[
                ['Title *',       'title',           'text',   ''],
                ['Trainer *',     'trainer',         'text',   ''],
                ['Department',    'department',      'text',   ''],
                ['Date *',        'training_date',   'date',   ''],
                ['Duration (hrs)*','duration_hours', 'number', ''],
                ['Max Participants *','max_participants','number',''],
              ].map(([label, key, type, ph]) => (
                <div key={key}>
                  <label htmlFor={`training-${key}`} className="block text-[12px] font-semibold text-[color:var(--txt2)] mb-1">{label}</label>
                  <input id={`training-${key}`} type={type as string} placeholder={ph as string}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--bdr)] text-[13px] focus:outline-none"
                    value={(addForm as any)[key]} onChange={e => setAddForm(f => ({ ...f, [key]: e.target.value }))} />
                </div>
              ))}
              <div>
                <label htmlFor="training-description" className="block text-[12px] font-semibold text-[color:var(--txt2)] mb-1">Description</label>
                <textarea id="training-description" rows={3} className="w-full px-3 py-2 rounded-lg border border-[var(--bdr)] text-[13px] focus:outline-none"
                  value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-[color:var(--txt)] bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: NAVY }}
                disabled={adding || !addForm.title || !addForm.trainer || !addForm.training_date || !addForm.duration_hours || !addForm.max_participants}
                onClick={submitAdd}>
                {adding ? 'Scheduling…' : 'Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
