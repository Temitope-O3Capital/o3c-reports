import { useState, useCallback } from 'react'
import { useApi, apiFetch } from '../../hooks/useApi.js'

const PRIORITY_CLS  = { low: 'badge-grey', medium: 'badge-blue', high: 'badge-amber', urgent: 'badge-red' }
const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 }

function NewTaskModal({ onClose, onSaved }) {
  const contacts = useApi('/api/crm/contacts?limit=200')
  const [form, setForm] = useState({ title: '', description: '', due_date: '', priority: 'medium', contact_id: '' })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    await apiFetch('/api/crm/tasks', {
      method: 'POST',
      body: JSON.stringify({
        ...form,
        contact_id: form.contact_id ? Number(form.contact_id) : null,
      }),
    })
    setSaving(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}>
      <div className="card w-full max-w-md p-6 animate-fade-in" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">New Task</h2>
          <button onClick={onClose} className="btn-icon"><span className="material-symbols-rounded text-[20px]">close</span></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="form-label">Title *</label>
            <input className="form-input" required value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="What needs to be done?" />
          </div>
          <div>
            <label className="form-label">Contact (optional)</label>
            <select className="form-input" value={form.contact_id} onChange={e => setForm(f => ({ ...f, contact_id: e.target.value }))}>
              <option value="">— No contact —</option>
              {(contacts.data?.data || []).map(c => (
                <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Priority</label>
              <select className="form-input" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                {['low','medium','high','urgent'].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Due Date</label>
              <input className="form-input" type="datetime-local" value={form.due_date}
                onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="form-label">Notes</label>
            <textarea className="form-input" rows={2} value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-60">
              {saving ? 'Saving…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Tasks() {
  const [statusFilter, setStatusFilter] = useState('open')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [showMine, setShowMine] = useState(false)
  const [showNew, setShowNew]   = useState(false)

  const params = new URLSearchParams({ limit: '200' })
  if (statusFilter)  params.set('status', statusFilter)
  if (priorityFilter) params.set('priority', priorityFilter)
  if (showMine)      params.set('mine', 'true')

  const { data: tasks, loading, refetch } = useApi(`/api/crm/tasks?${params}`)

  async function markDone(id) {
    await apiFetch(`/api/crm/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'done' }) })
    refetch()
  }

  const grouped = {}
  ;(tasks || []).forEach(t => {
    const key = t.is_overdue ? 'Overdue' : t.due_date
      ? new Date(t.due_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })
      : 'No Due Date'
    ;(grouped[key] = grouped[key] || []).push(t)
  })

  const overdue = (tasks || []).filter(t => t.is_overdue).length
  const open    = (tasks || []).filter(t => t.status === 'open').length

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Tasks</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {open} open{overdue > 0 && <span className="text-red-500 ml-2">· {overdue} overdue</span>}
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn btn-primary gap-2">
          <span className="material-symbols-rounded text-[18px]">add_task</span>
          New Task
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="flex rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
          {['open','in_progress','done','all'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s === 'all' ? '' : s)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                (s === 'all' ? !statusFilter : statusFilter === s)
                  ? 'bg-primary text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}>
              {s === 'all' ? 'All' : s.replace('_',' ')}
            </button>
          ))}
        </div>
        <select className="form-input w-auto text-sm" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="">All priorities</option>
          {['urgent','high','medium','low'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={() => setShowMine(m => !m)}
          className={`btn text-sm gap-1.5 ${showMine ? 'btn-primary' : 'btn-ghost'}`}>
          <span className="material-symbols-rounded text-[16px]">person</span>
          My Tasks
        </button>
      </div>

      {/* Task groups */}
      {loading ? (
        <div className="flex items-center gap-3 text-slate-400 py-8"><div className="spinner" /> Loading…</div>
      ) : (tasks || []).length === 0 ? (
        <div className="card p-12 flex flex-col items-center text-slate-400">
          <span className="material-symbols-rounded text-[40px] mb-3 opacity-30">task_alt</span>
          <p className="text-sm">No tasks found</p>
        </div>
      ) : (
        <div className="space-y-5">
          {Object.entries(grouped).map(([group, items]) => (
            <div key={group}>
              <div className="flex items-center gap-2 mb-2">
                {group === 'Overdue' && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
                <p className={`text-[12px] font-semibold uppercase tracking-wider ${group === 'Overdue' ? 'text-red-500' : 'text-slate-400'}`}>
                  {group}
                </p>
              </div>
              <div className="card overflow-hidden">
                {items.map((task, idx) => (
                  <div key={task.id} className={`flex items-center gap-4 px-5 py-3.5 ${idx < items.length-1 ? 'border-b border-slate-100 dark:border-slate-700/50' : ''} hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors`}>
                    <button
                      onClick={() => task.status !== 'done' && markDone(task.id)}
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                        task.status === 'done'
                          ? 'bg-emerald-500 border-emerald-500'
                          : 'border-slate-300 dark:border-slate-600 hover:border-emerald-500'
                      }`}
                    >
                      {task.status === 'done' && <span className="material-symbols-rounded text-white text-[13px]">check</span>}
                    </button>

                    <div className="flex-1 min-w-0">
                      <p className={`text-[13px] font-medium ${task.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>
                        {task.title}
                      </p>
                      {(task.first_name || task.description) && (
                        <p className="text-xs text-slate-400 mt-0.5">
                          {task.first_name && `${task.first_name} ${task.last_name} · `}{task.description}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`badge ${PRIORITY_CLS[task.priority] || 'badge-grey'}`}>{task.priority}</span>
                      {task.assigned_name && (
                        <span className="text-[11px] text-slate-400 hidden sm:block">{task.assigned_name}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && <NewTaskModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refetch() }} />}
    </div>
  )
}
