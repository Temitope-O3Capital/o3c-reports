import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDate, fmtDatetime } from '../../lib/fmt'
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
  assigned_to: number | null
  assigned_name: string | null
  first_name: string | null
  last_name: string | null
  contact_id: number | null
  deal_id: number | null
  created_at: string
  updated_at: string
}

interface TaskComment {
  id: number
  task_id: number
  author_name: string | null
  body: string
  created_at: string
}

interface CRMUser {
  id: number
  full_name: string
  role: string
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low']
const STATUSES   = ['open', 'in_progress', 'done', 'cancelled']

const PRIORITY_STYLE: Record<string, { bg: string; color: string; icon: string }> = {
  urgent: { bg: 'rgba(192,0,0,0.08)',     color: RED,       icon: 'priority_high' },
  high:   { bg: 'rgba(220,38,38,0.07)',   color: '#DC2626', icon: 'keyboard_arrow_up' },
  medium: { bg: 'rgba(217,119,6,0.08)',   color: AMBER,     icon: 'drag_handle' },
  low:    { bg: 'rgba(100,116,139,0.07)', color: '#64748B', icon: 'keyboard_arrow_down' },
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  open:        { bg: 'rgba(14,40,65,0.07)',    color: NAVY },
  in_progress: { bg: 'rgba(37,99,235,0.08)',   color: '#2563EB' },
  done:        { bg: 'rgba(5,150,105,0.08)',   color: GREEN },
  cancelled:   { bg: 'rgba(100,116,139,0.08)', color: '#64748B' },
  overdue:     { bg: 'rgba(192,0,0,0.08)',     color: RED },
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

/* ── Status badge ───────────────────────────────────────────────── */
function TaskStatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { bg: 'rgba(14,40,65,0.06)', color: '#475569' }
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      {snake(status)}
    </span>
  )
}

/* ── Task create / edit modal ───────────────────────────────────── */
interface TaskModalProps {
  task: Task | null
  users: CRMUser[]
  onClose: () => void
  onSaved: () => void
}

function TaskModal({ task, users, onClose, onSaved }: TaskModalProps) {
  const isEdit = !!task?.id
  const [form, setForm] = useState({
    title:       task?.title ?? '',
    description: task?.description ?? '',
    priority:    task?.priority ?? 'medium',
    status:      task?.status ?? 'open',
    due_date:    task?.due_date?.slice(0, 10) ?? '',
    assigned_to: task?.assigned_to?.toString() ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')

  const set = (k: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) { setErr('Title is required'); return }
    setSaving(true); setErr('')
    const payload = {
      title:       form.title,
      description: form.description || null,
      priority:    form.priority,
      status:      form.status,
      due_date:    form.due_date || null,
      assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
    }
    try {
      if (isEdit) await apiPut(`/api/crm/tasks/${task!.id}`, payload)
      else         await apiPost('/api/crm/tasks', payload)
      onSaved()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h2 className="text-[14px] font-semibold text-slate-900">
            {isEdit ? 'Edit Task' : 'New Task'}
          </h2>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100">
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
                {STATUSES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Due Date</label>
              <input type="date"
                className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.due_date} onChange={set('due_date')} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Assign To</label>
              <select className="w-full px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.assigned_to} onChange={set('assigned_to')}>
                <option value="">— Unassigned —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
          </div>

          {isEdit && task?.first_name && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px]"
              style={{ background: 'rgba(14,40,65,0.05)' }}>
              <span className="material-symbols-rounded text-[15px]" style={{ color: NAVY }}>person</span>
              <span className="text-slate-500">Linked contact:</span>
              <span className="font-semibold text-slate-700">
                {task.first_name} {task.last_name}
              </span>
            </div>
          )}

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

/* ── Comments drawer ────────────────────────────────────────────── */
function CommentsDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const [comments, setComments] = useState<TaskComment[]>([])
  const [body,     setBody]     = useState('')
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)

  useEffect(() => {
    setLoading(true)
    apiFetch<TaskComment[]>(`/api/crm/tasks/${task.id}/comments`)
      .then(r => setComments(r ?? []))
      .finally(() => setLoading(false))
  }, [task.id])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setSaving(true)
    try {
      const c = await apiPost<TaskComment>(`/api/crm/tasks/${task.id}/comments`, { body })
      setComments(prev => [...prev, c])
      setBody('')
    } finally { setSaving(false) }
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 z-50 w-96 bg-white shadow-2xl flex flex-col"
        style={{ borderLeft: '1px solid rgba(15,23,42,0.1)' }}>

        <div className="flex items-start justify-between px-5 py-4 border-b flex-shrink-0"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <div>
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">
              Task notes
            </p>
            <p className="text-[13px] font-semibold text-slate-800 leading-snug">{task.title}</p>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 flex-shrink-0 ml-2">
            <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <div className="space-y-3">
              {[1, 2].map(i => (
                <div key={i} className="space-y-1.5">
                  <div className="h-2.5 skeleton w-24 rounded" />
                  <div className="h-4 skeleton rounded" />
                </div>
              ))}
            </div>
          ) : comments.length === 0 ? (
            <div className="flex flex-col items-center py-12 gap-2 text-slate-400">
              <span className="material-symbols-rounded text-[36px]">chat_bubble_outline</span>
              <p className="text-[12px]">No notes yet — add one below</p>
            </div>
          ) : comments.map(c => (
            <div key={c.id}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[11px] font-semibold text-slate-700">
                  {c.author_name ?? 'Unknown'}
                </span>
                <span className="text-[10px] text-slate-400">{fmtDatetime(c.created_at)}</span>
              </div>
              <p className="text-[12px] text-slate-600 leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>

        <form onSubmit={submit} className="px-5 py-4 border-t flex-shrink-0"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <textarea
            className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-none"
            style={{ borderColor: 'rgba(15,23,42,0.18)' }}
            rows={3} value={body} onChange={e => setBody(e.target.value)}
            placeholder="Add a note…" />
          <div className="flex justify-end mt-2">
            <button type="submit" disabled={saving || !body.trim()}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-50 transition-all"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : 'Add Note'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}

/* ── Bulk action bar ────────────────────────────────────────────── */
function BulkActionBar({
  count, users, onAssign, onMarkDone, onClear,
}: {
  count: number
  users: CRMUser[]
  onAssign: (userId: number | null) => void
  onMarkDone: () => void
  onClear: () => void
}) {
  const [target, setTarget] = useState('')

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3
                    bg-slate-900 text-white rounded-2xl px-5 py-3 shadow-2xl"
      style={{ minWidth: 420 }}>
      <span className="text-[13px] font-semibold">{count} selected</span>
      <div className="w-px h-5 bg-slate-600 mx-1" />

      <select
        className="px-3 py-1.5 rounded-lg text-[12px] bg-slate-700 border border-slate-600 text-white outline-none"
        value={target} onChange={e => setTarget(e.target.value)}>
        <option value="">Assign to…</option>
        <option value="0">Unassign</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
      </select>
      <button
        disabled={target === ''}
        onClick={() => onAssign(target === '0' ? null : Number(target))}
        className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-white text-slate-900 disabled:opacity-40 transition-opacity">
        Apply
      </button>

      <div className="w-px h-5 bg-slate-600 mx-1" />
      <button onClick={onMarkDone}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
        style={{ background: 'rgba(5,150,105,0.25)', color: '#6EE7B7' }}>
        <span className="material-symbols-rounded text-[14px]">check_circle</span>
        Mark Done
      </button>

      <button onClick={onClear}
        className="ml-2 w-6 h-6 flex items-center justify-center rounded-full hover:bg-slate-700 transition-colors">
        <span className="material-symbols-rounded text-[15px] text-slate-400">close</span>
      </button>
    </div>
  )
}

/* ── Calendar view ──────────────────────────────────────────────── */
function CalendarView({
  tasks, month, onPrev, onNext, onTask,
}: {
  tasks: Task[]
  month: Date
  onPrev: () => void
  onNext: () => void
  onTask: (t: Task) => void
}) {
  const year  = month.getFullYear()
  const mon   = month.getMonth()
  const label = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

  const firstDay    = new Date(year, mon, 1).getDay()
  const daysInMonth = new Date(year, mon + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const byDate = useMemo(() => {
    const m: Record<string, Task[]> = {}
    tasks.forEach(t => {
      if (!t.due_date) return
      const d = t.due_date.slice(0, 10)
      ;(m[d] ??= []).push(t)
    })
    return m
  }, [tasks])

  const now      = new Date()
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  return (
    <SectionCard title="Calendar">
      <div className="px-5 pb-5">
        <div className="flex items-center justify-between py-3 mb-2">
          <button onClick={onPrev}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[18px] text-slate-500">chevron_left</span>
          </button>
          <span className="text-[14px] font-semibold text-slate-800">{label}</span>
          <button onClick={onNext}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[18px] text-slate-500">chevron_right</span>
          </button>
        </div>

        <div className="grid grid-cols-7 mb-1">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
            <div key={d} className="text-center text-[10px] font-semibold text-slate-400 py-1">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            if (!day) return <div key={i} />
            const dateKey  = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            const dayTasks = byDate[dateKey] ?? []
            const isToday  = dateKey === todayKey
            const shown    = dayTasks.slice(0, 2)
            const extra    = dayTasks.length - shown.length

            return (
              <div key={i} className="min-h-[72px] rounded-lg p-1.5 transition-colors"
                style={{
                  background: isToday ? 'rgba(14,40,65,0.06)' : 'transparent',
                  border: isToday
                    ? `1px solid ${NAVY}`
                    : '1px solid rgba(15,23,42,0.07)',
                }}>
                <p className="text-[11px] font-semibold mb-1"
                  style={{ color: isToday ? NAVY : '#94A3B8' }}>
                  {day}
                </p>
                <div className="space-y-0.5">
                  {shown.map(t => {
                    const pStyle = PRIORITY_STYLE[t.priority] ?? PRIORITY_STYLE.medium
                    return (
                      <button key={t.id} onClick={() => onTask(t)}
                        className="w-full text-left text-[10px] font-medium px-1.5 py-0.5 rounded truncate transition-opacity hover:opacity-80"
                        style={{ background: pStyle.bg, color: pStyle.color }}>
                        {t.title}
                      </button>
                    )
                  })}
                  {extra > 0 && (
                    <p className="text-[10px] text-slate-400 pl-1">+{extra} more</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </SectionCard>
  )
}

/* ── Main page ──────────────────────────────────────────────────── */
export default function Tasks() {
  const [tasks,          setTasks]          = useState<Task[]>([])
  const [users,          setUsers]          = useState<CRMUser[]>([])
  const [loading,        setLoading]        = useState(true)
  const [err,            setErr]            = useState('')
  const [statusFilter,   setStatusFilter]   = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [overdueOnly,    setOverdueOnly]    = useState(false)
  const [showMine,       setShowMine]       = useState(false)
  const [viewMode,       setViewMode]       = useState<'list' | 'calendar'>('list')
  const [modal,          setModal]          = useState<null | 'new' | Task>(null)
  const [commentTask,    setCommentTask]    = useState<Task | null>(null)
  const [selectedIds,    setSelectedIds]    = useState<Set<number>>(new Set())
  const [calMonth,       setCalMonth]       = useState(() => {
    const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (statusFilter)   params.set('status',   statusFilter)
      if (priorityFilter) params.set('priority', priorityFilter)
      if (overdueOnly)    params.set('overdue',  'true')
      if (showMine)       params.set('mine',     'true')
      const res = await apiFetch<Task[]>(`/api/crm/tasks?${params}`)
      setTasks(res ?? [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [statusFilter, priorityFilter, overdueOnly, showMine])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    apiFetch<CRMUser[]>('/api/crm/users').then(r => setUsers(r ?? []))
  }, [])

  async function markDone(task: Task) {
    try { await apiPut(`/api/crm/tasks/${task.id}`, { status: 'done' }); load() }
    catch { /* ignore */ }
  }

  async function deleteTask(task: Task) {
    if (!confirm('Delete this task?')) return
    await apiDelete(`/api/crm/tasks/${task.id}`)
    load()
  }

  async function bulkAssign(userId: number | null) {
    await apiPost('/api/crm/tasks/bulk-assign', {
      task_ids:    Array.from(selectedIds),
      assigned_to: userId,
    })
    setSelectedIds(new Set()); load()
  }

  async function bulkMarkDone() {
    await Promise.all(
      Array.from(selectedIds).map(id => apiPut(`/api/crm/tasks/${id}`, { status: 'done' }))
    )
    setSelectedIds(new Set()); load()
  }

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const open    = tasks.filter(t => t.status === 'open').length
  const overdue = tasks.filter(t => t.is_overdue).length
  const done    = tasks.filter(t => t.status === 'done').length
  const urgent  = tasks.filter(t => t.priority === 'urgent' && t.status === 'open').length

  const cols: ColDef<Task>[] = [
    {
      key: '_sel' as keyof Task, label: '', sortable: false,
      render: t => (
        <input type="checkbox"
          checked={selectedIds.has(t.id)}
          onChange={() => toggleSelect(t.id)}
          className="rounded cursor-pointer"
          onClick={e => e.stopPropagation()} />
      ),
    },
    {
      key: 'title', label: 'Task',
      render: t => (
        <div className="flex items-start gap-2.5">
          <button onClick={() => markDone(t)} title="Mark done"
            className="mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors hover:border-green-500"
            style={{
              borderColor: t.status === 'done' ? GREEN : 'rgba(15,23,42,0.25)',
              background:  t.status === 'done' ? GREEN : 'transparent',
            }}>
            {t.status === 'done' && (
              <span className="material-symbols-rounded text-[11px] text-white">check</span>
            )}
          </button>
          <div>
            <p className={`text-[13px] font-medium ${t.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800'}`}>
              {t.title}
            </p>
            {t.description && (
              <p className="text-[11px] text-slate-400 truncate max-w-xs">{t.description}</p>
            )}
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
    {
      key: 'status', label: 'Status',
      render: t => (
        <TaskStatusBadge
          status={t.is_overdue && t.status !== 'done' && t.status !== 'cancelled' ? 'overdue' : t.status} />
      ),
    },
    {
      key: 'due_date', label: 'Due Date',
      render: t => (
        <span className={`text-[12px] ${t.is_overdue ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
          {t.is_overdue && (
            <span className="material-symbols-rounded text-[13px] mr-0.5 align-middle">warning</span>
          )}
          {fmtDate(t.due_date)}
        </span>
      ),
    },
    {
      key: 'assigned_name', label: 'Assignee',
      render: t => <span className="text-slate-500 text-[12px]">{t.assigned_name ?? '—'}</span>,
    },
    {
      key: 'id' as keyof Task, label: '', sortable: false,
      render: t => (
        <div className="flex items-center gap-1">
          <button onClick={() => setCommentTask(t)} title="Notes"
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[15px] text-slate-400">chat_bubble_outline</span>
          </button>
          <button onClick={() => setModal(t)} title="Edit"
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[15px] text-slate-400">edit</span>
          </button>
          <button onClick={() => deleteTask(t)} title="Delete"
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
        <div className="flex items-center gap-2">
          {/* My / All toggle */}
          <div className="flex rounded-lg border overflow-hidden text-[12px] font-semibold"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            {(['All Tasks', 'My Tasks'] as const).map((label, i) => {
              const active = (label === 'My Tasks') === showMine
              return (
                <button key={label} onClick={() => setShowMine(label === 'My Tasks')}
                  className="px-3 py-1.5 transition-colors"
                  style={{
                    background: active ? NAVY : 'white',
                    color:      active ? 'white' : '#475569',
                    borderRight: i === 0 ? '1px solid rgba(15,23,42,0.15)' : undefined,
                  }}>
                  {label}
                </button>
              )
            })}
          </div>

          {/* List / Calendar toggle */}
          <div className="flex rounded-lg border overflow-hidden"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            {(['list', 'calendar'] as const).map(mode => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className="w-8 h-8 flex items-center justify-center transition-colors"
                style={{ background: viewMode === mode ? NAVY : 'white' }}>
                <span className="material-symbols-rounded text-[17px]"
                  style={{ color: viewMode === mode ? 'white' : '#94A3B8' }}>
                  {mode === 'list' ? 'format_list_bulleted' : 'calendar_month'}
                </span>
              </button>
            ))}
          </div>

          <button onClick={() => setModal('new')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-all"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[17px]">add_task</span>
            New Task
          </button>
        </div>
      }>

      <ErrBanner msg={err} />

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        <KpiCard label="Open Tasks" value={String(open)}    icon="task_alt"      loading={loading} />
        <KpiCard label="Overdue"    value={String(overdue)} icon="schedule"      accent={RED}   loading={loading} />
        <KpiCard label="Urgent"     value={String(urgent)}  icon="priority_high" accent={RED}   loading={loading} />
        <KpiCard label="Completed"  value={String(done)}    icon="check_circle"  accent={GREEN} loading={loading} />
      </div>

      {viewMode === 'calendar' ? (
        <CalendarView
          tasks={tasks}
          month={calMonth}
          onPrev={() => setCalMonth(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          onNext={() => setCalMonth(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          onTask={t => setModal(t)}
        />
      ) : (
        <>
          {/* Filters */}
          <div className="flex gap-3 mb-5 flex-wrap items-center">
            <select className="px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
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
        </>
      )}

      {modal !== null && (
        <TaskModal
          task={modal === 'new' ? null : modal}
          users={users}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }} />
      )}

      {commentTask && (
        <CommentsDrawer task={commentTask} onClose={() => setCommentTask(null)} />
      )}

      {selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          users={users}
          onAssign={bulkAssign}
          onMarkDone={bulkMarkDone}
          onClear={() => setSelectedIds(new Set())} />
      )}
    </Page>
  )
}
