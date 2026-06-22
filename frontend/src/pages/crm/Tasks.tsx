import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDate, fmtDatetime } from '../../lib/fmt'
import {
  Page, SectionCard, ErrBanner, NAVY, RED, GREEN, AMBER,
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
  linked_type: string | null
  linked_id: number | null
  created_at: string
  updated_at: string
}

interface ChecklistItem {
  id: string
  text: string
  done: boolean
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

type ViewMode = 'my' | 'team' | 'all'
type LayoutMode = 'board' | 'list'

const PRIORITIES = ['urgent', 'high', 'medium', 'low']
const STATUSES   = ['open', 'in_progress', 'done', 'cancelled']

const LINKED_TYPES = ['', 'ticket', 'loan_application', 'customer_cif', 'crm_contact', 'deal']
const LINKED_LABELS: Record<string, string> = {
  '': 'None',
  ticket: 'Ticket',
  loan_application: 'Loan Application',
  customer_cif: 'Customer CIF',
  crm_contact: 'CRM Contact',
  deal: 'Deal',
}

const PRIORITY_STYLE: Record<string, { bg: string; color: string; icon: string }> = {
  urgent: { bg: 'rgba(192,0,0,0.08)',     color: RED,       icon: 'priority_high' },
  high:   { bg: 'rgba(220,38,38,0.07)',   color: '#DC2626', icon: 'keyboard_arrow_up' },
  medium: { bg: 'rgba(217,119,6,0.08)',   color: AMBER,     icon: 'drag_handle' },
  low:    { bg: 'rgba(100,116,139,0.07)', color: '#64748B', icon: 'keyboard_arrow_down' },
}

const STATUS_STYLE: Record<string, { bg: string; color: string; colBg: string }> = {
  open:        { bg: 'rgba(14,40,65,0.07)',    color: NAVY,      colBg: 'rgba(14,40,65,0.04)' },
  in_progress: { bg: 'rgba(37,99,235,0.08)',   color: '#2563EB', colBg: 'rgba(37,99,235,0.03)' },
  done:        { bg: 'rgba(5,150,105,0.08)',   color: GREEN,     colBg: 'rgba(5,150,105,0.03)' },
  cancelled:   { bg: 'rgba(100,116,139,0.08)', color: '#64748B', colBg: 'rgba(100,116,139,0.03)' },
  overdue:     { bg: 'rgba(192,0,0,0.08)',     color: RED,       colBg: 'rgba(192,0,0,0.03)' },
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
  const s = STATUS_STYLE[status] ?? { bg: 'rgba(14,40,65,0.06)', color: '#475569', colBg: '' }
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      {snake(status)}
    </span>
  )
}

/* ── Assignee avatar ────────────────────────────────────────────── */
function Avatar({ name, size = 24 }: { name: string | null; size?: number }) {
  if (!name) return (
    <span className="flex-shrink-0 rounded-full bg-slate-200 flex items-center justify-center text-[10px] text-slate-400 font-semibold"
      style={{ width: size, height: size }}>?</span>
  )
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <span className="flex-shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
      style={{ width: size, height: size, background: NAVY }}>
      {initials}
    </span>
  )
}

/* ── Linked entity chip ─────────────────────────────────────────── */
function LinkedChip({ type, id }: { type: string | null; id: number | null }) {
  if (!type || !id) return null
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
      style={{ background: 'rgba(37,99,235,0.08)', color: '#2563EB' }}>
      <span className="material-symbols-rounded text-[11px]">link</span>
      {LINKED_LABELS[type] ?? type} #{id}
    </span>
  )
}

/* ── New Task quick modal ───────────────────────────────────────── */
interface NewTaskModalProps {
  users: CRMUser[]
  defaultStatus?: string
  onClose: () => void
  onSaved: () => void
}

function NewTaskModal({ users, defaultStatus = 'open', onClose, onSaved }: NewTaskModalProps) {
  const [form, setForm] = useState({
    title: '', description: '', priority: 'medium', status: defaultStatus,
    due_date: '', assigned_to: '', linked_type: '', linked_id: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState('')

  const set = (k: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) { setErr('Title is required'); return }
    setSaving(true); setErr('')
    try {
      await apiPost('/api/crm/tasks', {
        title:       form.title,
        description: form.description || null,
        priority:    form.priority,
        status:      form.status,
        due_date:    form.due_date || null,
        assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
        linked_type: form.linked_type || null,
        linked_id:   form.linked_id ? Number(form.linked_id) : null,
      })
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
          <h2 className="text-[14px] font-semibold text-slate-900">New Task</h2>
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
              value={form.title} onChange={set('title')} placeholder="Task title…" autoFocus />
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

          {/* Linked entity */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Link Type</label>
              <select className="w-full px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.linked_type} onChange={set('linked_type')}>
                {LINKED_TYPES.map(t => <option key={t} value={t}>{LINKED_LABELS[t]}</option>)}
              </select>
            </div>
            {form.linked_type && (
              <div>
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">Reference ID</label>
                <input type="number"
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                  value={form.linked_id} onChange={set('linked_id')} placeholder="ID or ref…" />
              </div>
            )}
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
              {saving ? 'Saving…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ── Task Detail Slide-over ─────────────────────────────────────── */
interface TaskDetailSlideoverProps {
  task: Task
  users: CRMUser[]
  onClose: () => void
  onSaved: () => void
}

function parseChecklist(desc: string | null): { checklist: ChecklistItem[]; rest: string } {
  if (!desc) return { checklist: [], rest: '' }
  const lines = desc.split('\n')
  const checklist: ChecklistItem[] = []
  const rest: string[] = []
  lines.forEach(line => {
    const m = line.match(/^- \[(x| )\] (.+)/)
    if (m) {
      checklist.push({ id: Math.random().toString(36).slice(2), text: m[2], done: m[1] === 'x' })
    } else {
      rest.push(line)
    }
  })
  return { checklist, rest: rest.join('\n').trim() }
}

function serializeChecklist(items: ChecklistItem[], rest: string): string {
  const cl = items.map(i => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n')
  return [rest, cl].filter(Boolean).join('\n\n')
}

function TaskDetailSlideover({ task, users, onClose, onSaved }: TaskDetailSlideoverProps) {
  const [editing, setEditing] = useState<Partial<Task>>(task)
  const [saving, setSaving]   = useState(false)
  const [comments, setComments] = useState<TaskComment[]>([])
  const [commentBody, setCommentBody] = useState('')
  const [sendingComment, setSendingComment] = useState(false)
  const [loadingComments, setLoadingComments] = useState(true)
  const [err, setErr] = useState('')

  const { checklist: initChecklist, rest: initRest } = useMemo(
    () => parseChecklist(task.description), [task.description]
  )
  const [checklist, setChecklist] = useState<ChecklistItem[]>(initChecklist)
  const [descRest, setDescRest]   = useState(initRest)
  const [newItem, setNewItem]     = useState('')

  useEffect(() => {
    setLoadingComments(true)
    apiFetch<TaskComment[]>(`/api/crm/tasks/${task.id}/comments`)
      .then(r => setComments(r ?? []))
      .finally(() => setLoadingComments(false))
  }, [task.id])

  async function save() {
    setSaving(true); setErr('')
    try {
      const desc = serializeChecklist(checklist, descRest)
      await apiPut(`/api/crm/tasks/${task.id}`, {
        ...editing,
        description: desc || null,
        assigned_to: editing.assigned_to ?? null,
      })
      onSaved()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  async function submitComment(e: React.FormEvent) {
    e.preventDefault()
    if (!commentBody.trim()) return
    setSendingComment(true)
    try {
      const c = await apiPost<TaskComment>(`/api/crm/tasks/${task.id}/comments`, { body: commentBody })
      setComments(prev => [...prev, c])
      setCommentBody('')
    } finally { setSendingComment(false) }
  }

  function toggleCheckItem(id: string) {
    setChecklist(cl => cl.map(i => i.id === id ? { ...i, done: !i.done } : i))
  }

  function removeCheckItem(id: string) {
    setChecklist(cl => cl.filter(i => i.id !== id))
  }

  function addCheckItem() {
    if (!newItem.trim()) return
    setChecklist(cl => [...cl, { id: Math.random().toString(36).slice(2), text: newItem.trim(), done: false }])
    setNewItem('')
  }

  const completedCount = checklist.filter(i => i.done).length

  return (
    <>
      <div className="fixed inset-0 z-40" style={{ background: 'rgba(0,0,0,0.25)' }} onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 z-50 flex flex-col bg-white shadow-2xl"
        style={{ width: 480, borderLeft: '1px solid rgba(15,23,42,0.1)' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b flex-shrink-0"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <div className="flex-1 pr-3">
            <input
              className="w-full text-[14px] font-semibold text-slate-800 outline-none border-b border-transparent focus:border-slate-300 transition-colors bg-transparent"
              value={editing.title ?? ''}
              onChange={e => setEditing(f => ({ ...f, title: e.target.value }))}
            />
          </div>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 flex-shrink-0">
            <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Meta fields */}
          <div className="px-5 py-4 grid grid-cols-2 gap-3"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Priority</label>
              <select className="w-full px-2 py-1.5 rounded-lg border text-[12px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                value={editing.priority ?? 'medium'}
                onChange={e => setEditing(f => ({ ...f, priority: e.target.value }))}>
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Status</label>
              <select className="w-full px-2 py-1.5 rounded-lg border text-[12px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                value={editing.status ?? 'open'}
                onChange={e => setEditing(f => ({ ...f, status: e.target.value }))}>
                {STATUSES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Due Date</label>
              <input type="date"
                className="w-full px-2 py-1.5 rounded-lg border text-[12px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                value={(editing.due_date ?? '').slice(0, 10)}
                onChange={e => setEditing(f => ({ ...f, due_date: e.target.value || null }))} />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Assignee</label>
              <select className="w-full px-2 py-1.5 rounded-lg border text-[12px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                value={editing.assigned_to ?? ''}
                onChange={e => setEditing(f => ({ ...f, assigned_to: e.target.value ? Number(e.target.value) : null }))}>
                <option value="">— Unassigned —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
          </div>

          {/* Linked entity */}
          <div className="px-5 py-4 grid grid-cols-2 gap-3"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Link Type</label>
              <select className="w-full px-2 py-1.5 rounded-lg border text-[12px] bg-white outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                value={editing.linked_type ?? ''}
                onChange={e => setEditing(f => ({ ...f, linked_type: e.target.value || null, linked_id: null }))}>
                {LINKED_TYPES.map(t => <option key={t} value={t}>{LINKED_LABELS[t]}</option>)}
              </select>
            </div>
            {editing.linked_type && (
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Reference ID</label>
                <input type="number"
                  className="w-full px-2 py-1.5 rounded-lg border text-[12px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                  value={editing.linked_id ?? ''}
                  onChange={e => setEditing(f => ({ ...f, linked_id: e.target.value ? Number(e.target.value) : null }))} />
              </div>
            )}
          </div>

          {/* Description */}
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Description</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-none"
              style={{ borderColor: 'rgba(15,23,42,0.18)' }}
              rows={3} value={descRest}
              onChange={e => setDescRest(e.target.value)}
              placeholder="Optional details…" />
          </div>

          {/* Checklist */}
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                Checklist
                {checklist.length > 0 && (
                  <span className="ml-1.5 text-[10px] font-semibold"
                    style={{ color: completedCount === checklist.length ? GREEN : AMBER }}>
                    {completedCount}/{checklist.length}
                  </span>
                )}
              </label>
            </div>
            {checklist.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {checklist.map(item => (
                  <div key={item.id} className="flex items-center gap-2 group">
                    <input type="checkbox" checked={item.done} onChange={() => toggleCheckItem(item.id)}
                      className="rounded cursor-pointer flex-shrink-0" />
                    <span className={`flex-1 text-[12px] ${item.done ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                      {item.text}
                    </span>
                    <button onClick={() => removeCheckItem(item.id)}
                      className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 transition-all">
                      <span className="material-symbols-rounded text-[13px] text-red-400">close</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                className="flex-1 px-2 py-1.5 rounded-lg border text-[12px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                value={newItem} onChange={e => setNewItem(e.target.value)}
                placeholder="Add subtask…"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCheckItem() } }}
              />
              <button onClick={addCheckItem}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-white"
                style={{ background: NAVY }}>
                Add
              </button>
            </div>
          </div>

          {/* Comments */}
          <div className="px-5 py-4">
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
              Comments ({comments.length})
            </label>
            <div className="space-y-3 mb-3 max-h-48 overflow-y-auto">
              {loadingComments ? (
                <div className="h-8 skeleton rounded" />
              ) : comments.length === 0 ? (
                <p className="text-[12px] text-slate-400">No comments yet</p>
              ) : comments.map(c => (
                <div key={c.id} className="bg-slate-50 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[11px] font-semibold text-slate-700">{c.author_name ?? 'Unknown'}</span>
                    <span className="text-[10px] text-slate-400">{fmtDatetime(c.created_at)}</span>
                  </div>
                  <p className="text-[12px] text-slate-600 leading-relaxed">{c.body}</p>
                </div>
              ))}
            </div>
            <form onSubmit={submitComment} className="flex gap-2">
              <textarea
                className="flex-1 px-2.5 py-2 rounded-lg border text-[12px] outline-none resize-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
                rows={2} value={commentBody} onChange={e => setCommentBody(e.target.value)}
                placeholder="Add a comment…" />
              <button type="submit" disabled={sendingComment || !commentBody.trim()}
                className="px-3 py-2 rounded-lg text-[12px] font-semibold text-white self-end disabled:opacity-50"
                style={{ background: NAVY }}>
                Post
              </button>
            </form>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 flex items-center justify-between border-t flex-shrink-0"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <ErrBanner msg={err} />
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg text-[13px] font-medium text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            <button onClick={save} disabled={saving}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

/* ── Board card ─────────────────────────────────────────────────── */
function BoardCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const pStyle = PRIORITY_STYLE[task.priority] ?? PRIORITY_STYLE.medium
  const isOverdue = task.is_overdue && task.status !== 'done' && task.status !== 'cancelled'
  return (
    <button onClick={onOpen}
      className="w-full text-left bg-white rounded-xl p-3 shadow-sm hover:shadow-md transition-shadow group"
      style={{
        border: isOverdue ? `1px solid ${RED}33` : '1px solid rgba(15,23,42,0.08)',
        borderLeft: isOverdue ? `3px solid ${RED}` : undefined,
      }}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <PriorityBadge priority={task.priority} />
        {task.is_overdue && (
          <span className="material-symbols-rounded text-[14px]" style={{ color: RED }}>warning</span>
        )}
      </div>
      <p className={`text-[13px] font-medium mb-2 leading-snug ${task.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800'}`}>
        {task.title}
      </p>
      <div className="flex items-center gap-2">
        <Avatar name={task.assigned_name} size={20} />
        {task.due_date && (
          <span className={`text-[11px] font-medium ml-auto ${isOverdue ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
            {fmtDate(task.due_date)}
          </span>
        )}
      </div>
      {(task.linked_type && task.linked_id) && (
        <div className="mt-2">
          <LinkedChip type={task.linked_type} id={task.linked_id} />
        </div>
      )}
    </button>
  )
}

/* ── Board column ───────────────────────────────────────────────── */
function BoardColumn({
  status, tasks, onOpen, onNew,
}: {
  status: string
  tasks: Task[]
  onOpen: (t: Task) => void
  onNew: () => void
}) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.open
  const LABELS: Record<string, string> = {
    open: 'To Do', in_progress: 'In Progress', done: 'Done', cancelled: 'Cancelled',
  }
  return (
    <div className="flex flex-col flex-1 min-w-[200px] rounded-xl"
      style={{ background: s.colBg, border: '1px solid rgba(15,23,42,0.07)' }}>
      <div className="flex items-center justify-between px-3 py-3"
        style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-slate-700">{LABELS[status] ?? snake(status)}</span>
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: s.bg, color: s.color }}>{tasks.length}</span>
        </div>
        <button onClick={onNew}
          className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-white transition-colors"
          title="New task">
          <span className="material-symbols-rounded text-[15px] text-slate-400">add</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2 max-h-[calc(100vh-300px)]">
        {tasks.map(t => (
          <BoardCard key={t.id} task={t} onOpen={() => onOpen(t)} />
        ))}
        {tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-slate-300">
            <span className="material-symbols-rounded text-[28px]">task_alt</span>
            <p className="text-[11px] mt-1">No tasks</p>
          </div>
        )}
      </div>
    </div>
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

/* ── Main page ──────────────────────────────────────────────────── */
export default function Tasks() {
  const [tasks,          setTasks]          = useState<Task[]>([])
  const [users,          setUsers]          = useState<CRMUser[]>([])
  const [loading,        setLoading]        = useState(true)
  const [err,            setErr]            = useState('')

  // View/layout
  const [viewMode,       setViewMode]       = useState<ViewMode>('my')
  const [layoutMode,     setLayoutMode]     = useState<LayoutMode>('board')

  // Filters
  const [search,         setSearch]         = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [statusFilter,   setStatusFilter]   = useState('')
  const [dueDateFilter,  setDueDateFilter]  = useState('')

  // Modals
  const [showNew,        setShowNew]        = useState(false)
  const [newDefaultStatus, setNewDefaultStatus] = useState('open')
  const [detailTask,     setDetailTask]     = useState<Task | null>(null)
  const [selectedIds,    setSelectedIds]    = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const params = new URLSearchParams({ limit: '500', view: viewMode })
      const res = await apiFetch<Task[]>(`/api/crm/tasks?${params}`)
      setTasks(res ?? [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [viewMode])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    apiFetch<CRMUser[]>('/api/crm/users').then(r => setUsers(r ?? []))
  }, [])

  // Client-side filtering
  const filtered = useMemo(() => {
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    const weekEnd  = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7)
    return tasks.filter(t => {
      if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false
      if (priorityFilter && t.priority !== priorityFilter) return false
      if (statusFilter && t.status !== statusFilter) return false
      if (dueDateFilter === 'overdue' && !t.is_overdue) return false
      if (dueDateFilter === 'today') {
        if (!t.due_date || t.due_date.slice(0, 10) !== todayStr) return false
      }
      if (dueDateFilter === 'week') {
        if (!t.due_date) return false
        const d = new Date(t.due_date)
        if (d < now || d > weekEnd) return false
      }
      return true
    })
  }, [tasks, search, priorityFilter, statusFilter, dueDateFilter])

  // Board grouping
  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = { open: [], in_progress: [], done: [], cancelled: [] }
    filtered.forEach(t => { (m[t.status] ??= []).push(t) })
    return m
  }, [filtered])

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

  async function markDone(task: Task) {
    await apiPut(`/api/crm/tasks/${task.id}`, { status: 'done' }); load()
  }

  async function deleteTask(task: Task) {
    if (!confirm('Delete this task?')) return
    await apiDelete(`/api/crm/tasks/${task.id}`); load()
  }

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
    })
  }

  const open    = tasks.filter(t => t.status === 'open').length
  const overdue = tasks.filter(t => t.is_overdue).length
  const done    = tasks.filter(t => t.status === 'done').length
  const urgent  = tasks.filter(t => t.priority === 'urgent' && t.status === 'open').length

  const VIEW_TABS: { id: ViewMode; label: string }[] = [
    { id: 'my',   label: 'My Tasks' },
    { id: 'team', label: 'Team Tasks' },
    { id: 'all',  label: 'All Tasks' },
  ]

  return (
    <Page dept="Tasks" title="Tasks" subtitle="Cross-department task management"
      actions={
        <div className="flex items-center gap-2">
          {/* Board / List toggle */}
          <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            {(['board', 'list'] as const).map(mode => (
              <button key={mode} onClick={() => setLayoutMode(mode)}
                className="w-8 h-8 flex items-center justify-center transition-colors"
                style={{ background: layoutMode === mode ? NAVY : 'white' }}>
                <span className="material-symbols-rounded text-[17px]"
                  style={{ color: layoutMode === mode ? 'white' : '#94A3B8' }}>
                  {mode === 'board' ? 'view_kanban' : 'format_list_bulleted'}
                </span>
              </button>
            ))}
          </div>

          <button onClick={() => { setNewDefaultStatus('open'); setShowNew(true) }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-all"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[17px]">add_task</span>
            New Task
          </button>
        </div>
      }>

      <ErrBanner msg={err} />

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-4">
        {[
          { label: 'Open Tasks', value: open,    icon: 'task_alt',      accent: undefined },
          { label: 'Overdue',    value: overdue,  icon: 'schedule',      accent: RED },
          { label: 'Urgent',     value: urgent,   icon: 'priority_high', accent: RED },
          { label: 'Completed',  value: done,     icon: 'check_circle',  accent: GREEN },
        ].map(k => (
          <div key={k.label} className="bg-white rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ border: '1px solid rgba(15,23,42,0.07)' }}>
            <span className="material-symbols-rounded text-[22px]"
              style={{ color: k.accent ?? NAVY }}>
              {k.icon}
            </span>
            <div>
              <p className="text-[20px] font-bold text-slate-800 leading-tight">{k.value}</p>
              <p className="text-[11px] text-slate-400">{k.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* View tabs */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex rounded-xl border overflow-hidden text-[12px] font-semibold"
          style={{ borderColor: 'rgba(15,23,42,0.12)' }}>
          {VIEW_TABS.map(({ id, label }) => (
            <button key={id} onClick={() => setViewMode(id)}
              className="px-4 py-2 transition-colors"
              style={{
                background: viewMode === id ? NAVY : 'white',
                color:      viewMode === id ? 'white' : '#64748B',
                borderRight: id !== 'all' ? '1px solid rgba(15,23,42,0.12)' : undefined,
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative">
          <span className="material-symbols-rounded text-[15px] absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">search</span>
          <input
            className="pl-8 pr-3 py-2 rounded-lg border text-[12px] outline-none bg-white"
            style={{ borderColor: 'rgba(15,23,42,0.15)', minWidth: 200 }}
            value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…" />
        </div>
        <select className="px-3 py-2 rounded-lg border text-[12px] bg-white outline-none"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}
          value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="">All priorities</option>
          {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        {layoutMode === 'list' && (
          <select className="px-3 py-2 rounded-lg border text-[12px] bg-white outline-none"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
          </select>
        )}
        <select className="px-3 py-2 rounded-lg border text-[12px] bg-white outline-none"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}
          value={dueDateFilter} onChange={e => setDueDateFilter(e.target.value)}>
          <option value="">All due dates</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Due this week</option>
        </select>
        {(search || priorityFilter || statusFilter || dueDateFilter) && (
          <button
            onClick={() => { setSearch(''); setPriorityFilter(''); setStatusFilter(''); setDueDateFilter('') }}
            className="text-[12px] text-slate-400 hover:text-slate-700 transition-colors">
            Clear filters
          </button>
        )}
        <p className="ml-auto text-[12px] text-slate-400">{filtered.length} tasks</p>
      </div>

      {/* Board view */}
      {layoutMode === 'board' && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {STATUSES.map(status => (
            <BoardColumn
              key={status}
              status={status}
              tasks={byStatus[status] ?? []}
              onOpen={t => setDetailTask(t)}
              onNew={() => { setNewDefaultStatus(status); setShowNew(true) }}
            />
          ))}
        </div>
      )}

      {/* List view */}
      {layoutMode === 'list' && (
        <SectionCard title="Tasks" badge={filtered.length}>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-7 h-7 border-2 rounded-full animate-spin"
                style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: NAVY }} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-16 gap-2 text-slate-400">
              <span className="material-symbols-rounded text-[40px]">task_alt</span>
              <p className="text-[13px]">No tasks — create one to get started</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr style={{ background: '#F8FAFC', borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
                    <th className="px-4 py-3 w-10">
                      <input type="checkbox"
                        checked={selectedIds.size === filtered.length && filtered.length > 0}
                        onChange={e => {
                          setSelectedIds(e.target.checked ? new Set(filtered.map(t => t.id)) : new Set())
                        }}
                        className="rounded cursor-pointer" />
                    </th>
                    {['PRIORITY', 'TITLE', 'ASSIGNEE', 'DUE DATE', 'STATUS', 'LINKED TO', ''].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-slate-400 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => {
                    const isOverdue = t.is_overdue && t.status !== 'done' && t.status !== 'cancelled'
                    return (
                      <tr key={t.id}
                        className="transition-colors hover:bg-slate-50 cursor-pointer"
                        style={{
                          borderTop: '1px solid rgba(15,23,42,0.05)',
                          borderLeft: isOverdue ? `3px solid ${RED}` : '3px solid transparent',
                        }}
                        onClick={() => setDetailTask(t)}>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <input type="checkbox"
                            checked={selectedIds.has(t.id)}
                            onChange={() => toggleSelect(t.id)}
                            className="rounded cursor-pointer" />
                        </td>
                        <td className="px-4 py-3"><PriorityBadge priority={t.priority} /></td>
                        <td className="px-4 py-3 max-w-[260px]">
                          <p className={`font-medium truncate ${t.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                            {t.title}
                          </p>
                          {t.description && (
                            <p className="text-[11px] text-slate-400 truncate">{t.description}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <Avatar name={t.assigned_name} size={22} />
                            <span className="text-slate-500 text-[12px]">{t.assigned_name ?? '—'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`text-[12px] ${isOverdue ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
                            {isOverdue && (
                              <span className="material-symbols-rounded text-[13px] mr-0.5 align-middle">warning</span>
                            )}
                            {fmtDate(t.due_date)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <TaskStatusBadge
                            status={isOverdue ? 'overdue' : t.status} />
                        </td>
                        <td className="px-4 py-3">
                          <LinkedChip type={t.linked_type} id={t.linked_id} />
                        </td>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <button onClick={() => markDone(t)} title="Mark done"
                              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-green-50 transition-colors">
                              <span className="material-symbols-rounded text-[15px] text-green-400">check_circle</span>
                            </button>
                            <button onClick={() => deleteTask(t)} title="Delete"
                              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 transition-colors">
                              <span className="material-symbols-rounded text-[15px] text-red-400">delete</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      {/* Modals */}
      {showNew && (
        <NewTaskModal
          users={users}
          defaultStatus={newDefaultStatus}
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); load() }} />
      )}

      {detailTask && (
        <TaskDetailSlideover
          task={detailTask}
          users={users}
          onClose={() => setDetailTask(null)}
          onSaved={() => { setDetailTask(null); load() }} />
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
