import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ErrBanner, Spinner, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Task {
  id: number
  title: string
  status: string
  priority: string
  due_date?: string
  assigned_name?: string
  assigned_to?: number
  contact_id?: number
  first_name?: string
  last_name?: string
  is_overdue?: boolean
  description?: string
}

interface CRMUser { id: number; full_name: string }

// ── Helpers ────────────────────────────────────────────────────────────────────

const PRIORITY_DOT: Record<string, string> = {
  urgent: RED, high: AMBER, medium: BLUE, low: '#6B7280',
}

const STATUS_STYLE: Record<string, { color: string; bg: string }> = {
  open:      { color: BLUE,     bg: `${BLUE}12` },
  done:      { color: GREEN,    bg: 'rgba(22,163,74,.12)' },
  cancelled: { color: '#6B7280', bg: 'rgba(75,85,99,.1)' },
}

function PriorityDot({ priority }: { priority: string }) {
  const color = PRIORITY_DOT[priority.toLowerCase()] ?? '#6B7280'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--txt2)', textTransform: 'capitalize' }}>{priority}</span>
    </div>
  )
}

function StatusPill({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue && status === 'open') {
    return <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${RED}12`, color: RED }}>Overdue</span>
  }
  const s = STATUS_STYLE[status.toLowerCase()] ?? STATUS_STYLE.open
  return <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
}

const BLANK = { title: '', contact_id: '', due_date: '', priority: 'medium', assigned_to: '', description: '' }

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CRMTasks() {
  const [tasks, setTasks]     = useState<Task[]>([])
  const [users, setUsers]     = useState<CRMUser[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const [statusFilter,   setStatusFilter]   = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [overdueFilter,  setOverdueFilter]  = useState(false)

  const [selected, setSelected]     = useState<Set<string | number>>(new Set())
  const [completing, setCompleting] = useState(false)

  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)

  const [editing, setEditing]     = useState<Task | null>(null)
  const [editForm, setEditForm]   = useState(BLANK)
  const [editSaving, setEditSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (statusFilter)   p.set('status',   statusFilter)
      if (priorityFilter) p.set('priority', priorityFilter)
      if (overdueFilter)  p.set('overdue',  'true')
      const [ts, us] = await Promise.all([
        apiFetch<Task[]>(`/api/crm/tasks?${p}`),
        apiFetch<CRMUser[]>('/api/crm/users'),
      ])
      setTasks(Array.isArray(ts) ? ts : [])
      setUsers(Array.isArray(us) ? us : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [statusFilter, priorityFilter, overdueFilter])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    if (!form.title) { toast.error('Title is required'); return }
    setSaving(true)
    try {
      const body: any = { title: form.title, priority: form.priority }
      if (form.due_date)    body.due_date    = form.due_date
      if (form.description) body.description = form.description
      if (form.assigned_to) body.assigned_to = Number(form.assigned_to)
      if (form.contact_id)  body.contact_id  = Number(form.contact_id)
      await apiPost('/api/crm/tasks', body)
      toast.success('Task created')
      setNewOpen(false); setForm(BLANK); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setSaving(false) }
  }

  async function markDone(id: number) {
    try {
      await apiPut(`/api/crm/tasks/${id}`, { status: 'done' })
      setTasks(ts => ts.map(t => t.id === id ? { ...t, status: 'done' } : t))
      toast.success('Task completed')
    } catch (ex: any) { toast.error(ex.message) }
  }

  async function batchComplete() {
    if (selected.size === 0) return
    setCompleting(true)
    try {
      await Promise.all([...selected].map(id => apiPut(`/api/crm/tasks/${id}`, { status: 'done' })))
      toast.success(`${selected.size} task${selected.size > 1 ? 's' : ''} completed`)
      setSelected(new Set()); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setCompleting(false) }
  }

  async function handleEdit() {
    if (!editing) return
    setEditSaving(true)
    try {
      const body: any = { title: editForm.title, priority: editForm.priority }
      if (editForm.due_date)    body.due_date    = editForm.due_date
      if (editForm.description) body.description = editForm.description
      if (editForm.assigned_to) body.assigned_to = Number(editForm.assigned_to)
      await apiPut(`/api/crm/tasks/${editing.id}`, body)
      toast.success('Task updated')
      setEditing(null); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setEditSaving(false) }
  }

  const bulkBar = selected.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{selected.size} selected</span>
      <button onClick={batchComplete} disabled={completing}
        style={{ ...btnPrimary, background: GREEN, padding: '5px 14px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {completing && <Spinner size={13} color="#fff" />}
        Mark Done
      </button>
    </div>
  ) : null

  const cols: TableCol<Task>[] = [
    {
      key: 'title', label: 'Task',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.title}</div>
          {r.description && <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 1 }}>{r.description.slice(0, 60)}{r.description.length > 60 ? '…' : ''}</div>}
        </div>
      ),
    },
    {
      key: 'first_name', label: 'Related',
      render: r => (r.first_name || r.last_name)
        ? <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.first_name} {r.last_name}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'due_date', label: 'Due',
      render: r => r.due_date
        ? <span style={{ fontSize: 12.5, color: r.is_overdue && r.status !== 'done' ? RED : 'var(--txt)' }}>{fmtDate(r.due_date)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    { key: 'priority', label: 'Priority', render: r => <PriorityDot priority={r.priority} /> },
    { key: 'status',   label: 'Status',   render: r => <StatusPill status={r.status} overdue={r.is_overdue} /> },
    { key: 'assigned_name', label: 'Owner', render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.assigned_name ?? '—'}</span> },
    {
      key: 'id', label: '',
      render: r => r.status !== 'done' ? (
        <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
          <button onClick={() => markDone(r.id)}
            style={{ padding: '3px 10px', borderRadius: 6, border: `1.5px solid ${GREEN}40`, background: 'transparent', color: GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
            Done
          </button>
          <button onClick={() => { setEditing(r); setEditForm({ title: r.title, contact_id: String(r.contact_id ?? ''), due_date: r.due_date ?? '', priority: r.priority, assigned_to: String(r.assigned_to ?? ''), description: r.description ?? '' }) }}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
            Edit
          </button>
        </div>
      ) : null,
    },
  ]

  return (
    <Page
      title="CRM Tasks"
      subtitle="Activity tasks and follow-ups"
      actions={
        <button onClick={() => { setForm(BLANK); setNewOpen(true) }} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Task
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setStatusFilter(''); setPriorityFilter(''); setOverdueFilter(false) }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--txt2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={overdueFilter} onChange={e => setOverdueFilter(e.target.checked)} />
          Overdue only
        </label>
      </FilterBar>

      <SectionCard title="Tasks" badge={tasks.length} padding={false}>
        <DataTable<Task>
          cols={cols}
          rows={tasks}
          keyFn={r => r.id}
          selectable
          selectedIds={selected}
          onSelect={setSelected}
          bulkBar={bulkBar}
          emptyText="No tasks found."
          skeletonRows={loading ? 6 : 0}
        />
      </SectionCard>

      {/* New Task modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Task" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Create
            </button>
          </div>
        }
      >
        <TaskForm form={form} setForm={setForm} users={users} inputStyle={inputStyle} />
      </Modal>

      {/* Edit modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Task" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleEdit} disabled={editSaving} style={{ ...btnPrimary, opacity: editSaving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {editSaving && <Spinner size={14} color="#fff" />}
              Save
            </button>
          </div>
        }
      >
        <TaskForm form={editForm} setForm={setEditForm} users={users} inputStyle={inputStyle} />
      </Modal>
    </Page>
  )
}

// ── Shared form component ─────────────────────────────────────────────────────

function TaskForm({
  form, setForm, users, inputStyle,
}: {
  form: typeof BLANK
  setForm: (fn: (f: typeof BLANK) => typeof BLANK) => void
  users: CRMUser[]
  inputStyle: React.CSSProperties
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Title *</label>
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={inputStyle} placeholder="Task title…" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Priority</label>
          <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
            style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Due Date</label>
          <input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
            style={{ ...inputStyle, height: 36 }} />
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Assignee</label>
        <select value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}
          style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
          <option value="">— Unassigned —</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes</label>
        <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          rows={3} placeholder="Task notes or details…" style={{ ...inputStyle, resize: 'vertical' }} />
      </div>
    </div>
  )
}
