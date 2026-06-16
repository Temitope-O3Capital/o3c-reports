import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef, KpiCard,
  ErrBanner, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── Types ──────────────────────────────────────────────────────── */
interface Task {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  due_date: string | null
  is_overdue: boolean
  assigned_name: string | null
  first_name: string | null
  last_name: string | null
  contact_id: number | null
  deal_id: number | null
  created_at: string
  updated_at: string
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low']
const STATUSES   = ['open', 'in_progress', 'done', 'cancelled']

const PRIORITY_STYLE: Record<string, { bg: string; color: string; icon: string }> = {
  urgent: { bg: 'rgba(192,0,0,0.08)',   color: RED,   icon: 'priority_high' },
  high:   { bg: 'rgba(220,38,38,0.07)', color: '#DC2626', icon: 'keyboard_arrow_up' },
  medium: { bg: 'rgba(217,119,6,0.08)', color: AMBER, icon: 'drag_handle' },
  low:    { bg: 'rgba(100,116,139,0.07)', color: '#64748B', icon: 'keyboard_arrow_down' },
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  open:        { bg: 'rgba(14,40,65,0.07)',    color: NAVY },
  in_progress: { bg: 'rgba(37,99,235,0.08)',   color: '#2563EB' },
  done:        { bg: 'rgba(5,150,105,0.08)',   color: GREEN },
  cancelled:   { bg: 'rgba(100,116,139,0.08)', color: '#64748B' },
}

/* ── Priority badge ─────────────────────────────────────────────── */
function PriorityBadge({ priority }: { priority: string }) {
  const s = PRIORITY_STYLE[priority] ?? PRIORITY_STYLE.medium
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-2 py-0.5 rounded"
      style={{ background: s.bg, color: s.color }}>
      <span className="material-symbols-rounded text-[13px]">{s.icon}</span>
      {priority}
    </span>
  )
}

/* ── Task status badge ──────────────────────────────────────────── */
function TaskStatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { bg: 'rgba(14,40,65,0.06)', color: '#475569' }
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

/* ── Task modal ─────────────────────────────────────────────────── */
interface TaskModalProps {
  task: Task | null
  onClose: () => void
  onSaved: () => void
}

function TaskModal({ task, onClose, onSaved }: TaskModalProps) {
  const isEdit = !!task?.id
  const [form, setForm] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    priority: task?.priority ?? 'medium',
    status: task?.status ?? 'open',
    due_date: task?.due_date?.slice(0, 10) ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) { setErr('Title is required'); return }
    setSaving(true); setErr('')
    try {
      if (isEdit) {
        await apiPut(`/api/crm/tasks/${task!.id}`, form)
      } else {
        await apiPost('/api/crm/tasks', form)
      }
      onSaved()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h2 className="text-[14px] font-semibold text-slate-900">{isEdit ? 'Edit Task' : 'New Task'}</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100">
            <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
          </button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4">
          <ErrBanner msg={err} />

          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Title *</label>
            <input className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-slate-400 transition-colors"
              style={{ borderColor: 'rgba(15,23,42,0.18)' }}
              value={form.title} onChange={set('title')} placeholder="Task title…" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Priority</label>
              <select className="w-full px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.priority} onChange={set('priority')}>
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Status</label>
              <select className="w-full px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.status} onChange={set('status')}>
                {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Due Date</label>
            <input type="date" className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.18)' }}
              value={form.due_date} onChange={set('due_date')} />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Description</label>
            <textarea className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-none"
              style={{ borderColor: 'rgba(15,23,42,0.18)' }}
              rows={3} value={form.description} onChange={set('description')}
              placeholder="Optional details…" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-[13px] font-medium text-slate-600 hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60 transition-all"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ── Main page ──────────────────────────────────────────────────── */
export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [modal, setModal] = useState<null | 'new' | Task>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (statusFilter)   params.set('status',   statusFilter)
      if (priorityFilter) params.set('priority', priorityFilter)
      if (overdueOnly)    params.set('overdue',  'true')
      const res = await apiFetch<Task[]>(`/api/crm/tasks?${params}`)
      setTasks(res ?? [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [statusFilter, priorityFilter, overdueOnly])

  useEffect(() => { load() }, [load])

  async function markDone(task: Task) {
    try {
      await apiPut(`/api/crm/tasks/${task.id}`, { status: 'done' })
      load()
    } catch { /* ignore */ }
  }

  async function deleteTask(task: Task) {
    if (!confirm('Delete this task?')) return
    await apiDelete(`/api/crm/tasks/${task.id}`)
    load()
  }

  const open     = tasks.filter(t => t.status === 'open').length
  const overdue  = tasks.filter(t => t.is_overdue).length
  const done     = tasks.filter(t => t.status === 'done').length
  const urgent   = tasks.filter(t => t.priority === 'urgent' && t.status === 'open').length

  const cols: ColDef<Task>[] = [
    {
      key: 'title', label: 'Task',
      render: t => (
        <div className="flex items-start gap-2.5">
          <button onClick={() => markDone(t)} title="Mark done"
            className="mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors hover:border-green-500"
            style={{ borderColor: t.status === 'done' ? GREEN : 'rgba(15,23,42,0.25)', background: t.status === 'done' ? GREEN : 'transparent' }}>
            {t.status === 'done' && <span className="material-symbols-rounded text-[11px] text-white">check</span>}
          </button>
          <div>
            <p className={`text-[13px] font-medium ${t.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800'}`}>{t.title}</p>
            {t.description && <p className="text-[11px] text-slate-400 truncate max-w-xs">{t.description}</p>}
            {(t.first_name || t.last_name) && (
              <p className="text-[11px] text-slate-400 mt-0.5">
                <span className="material-symbols-rounded text-[11px] align-middle mr-0.5">person</span>
                {t.first_name} {t.last_name}
              </p>
            )}
          </div>
        </div>
      ),
    },
    { key: 'priority', label: 'Priority', render: t => <PriorityBadge priority={t.priority} /> },
    { key: 'status',   label: 'Status',   render: t => <TaskStatusBadge status={t.is_overdue && t.status !== 'done' && t.status !== 'cancelled' ? 'overdue' : t.status} /> },
    {
      key: 'due_date', label: 'Due Date',
      render: t => (
        <span className={`text-[12px] ${t.is_overdue ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
          {t.is_overdue && <span className="material-symbols-rounded text-[13px] mr-0.5 align-middle">warning</span>}
          {fmtDate(t.due_date)}
        </span>
      ),
    },
    { key: 'assigned_name', label: 'Assignee', render: t => <span className="text-slate-500 text-[12px]">{t.assigned_name ?? '—'}</span> },
    {
      key: '_actions', label: '', sortable: false,
      render: t => (
        <div className="flex items-center gap-1">
          <button onClick={() => setModal(t)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[15px] text-slate-400">edit</span>
          </button>
          <button onClick={() => deleteTask(t)}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 transition-colors">
            <span className="material-symbols-rounded text-[15px] text-red-400">delete</span>
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page dept="CRM" title="Tasks" subtitle="Manage team to-dos and follow-ups"
      actions={
        <button onClick={() => setModal('new')}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-all"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[17px]">add_task</span>
          New Task
        </button>
      }>

      <ErrBanner msg={err} />

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        <KpiCard label="Open Tasks"   value={String(open)}   icon="task_alt" loading={loading} />
        <KpiCard label="Overdue"      value={String(overdue)} icon="schedule" accent={RED} loading={loading} />
        <KpiCard label="Urgent"       value={String(urgent)}  icon="priority_high" accent={RED} loading={loading} />
        <KpiCard label="Completed"    value={String(done)}    icon="check_circle" accent={GREEN} loading={loading} />
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap items-center">
        <select className="px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}
          value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <select className="px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}
          value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="">All priorities</option>
          {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="flex items-center gap-2 text-[12px] font-medium text-slate-600 cursor-pointer">
          <input type="checkbox" checked={overdueOnly} onChange={e => setOverdueOnly(e.target.checked)}
            className="rounded" />
          Overdue only
        </label>
        {(statusFilter || priorityFilter || overdueOnly) && (
          <button onClick={() => { setStatusFilter(''); setPriorityFilter(''); setOverdueOnly(false) }}
            className="text-[12px] text-slate-400 hover:text-slate-700 transition-colors">
            Clear filters
          </button>
        )}
        <p className="ml-auto text-[12px] text-slate-400">{tasks.length} tasks</p>
      </div>

      <SectionCard title="Tasks" badge={tasks.length}>
        <DataTable<Task>
          cols={cols} rows={tasks} loading={loading}
          emptyIcon="task_alt" emptyMsg="No tasks — create one to get started" />
      </SectionCard>

      {modal !== null && (
        <TaskModal
          task={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }} />
      )}
    </Page>
  )
}
