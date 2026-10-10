import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, Modal, ErrBanner, Spinner, btnPrimary,
  KpiCard, NameCell, ActionRow, StatusBadge, TblSearch, EmptyState, Input, Button,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { SelectMenu, SelectMenuField, toOptions } from '../../components/SelectMenu'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, fmtNum } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { currentUser, isSalesHead, allRoles } from '../../hooks/useAuth'
import { toast } from 'sonner'

// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW-UPS — what this page is for
//
// crm_tasks had never held a single row in production. The table was not dead
// infrastructure, though: it is the system of record for follow-ups, and five separate
// flows write to it (an activity of type 'task', the activity hand-off status update, the
// task-routing worker, the call-centre lead follow-up, and My Dashboard), the app-wide
// ?task= modal reads it, and a notification worker mails against it. Removing the page
// would have orphaned all of that and pointed the reminder mails at a 404.
//
// It was empty because nothing ever PROMPTED a follow-up. The only way to create one was
// to leave your work, come to this page and type a to-do from memory. So the fix is two
// things, and the page is only half of it: a "Follow Up" button now sits on the lead
// drawer where the officer actually decides there needs to be one, and this page stopped
// being a generic to-do list and became the queue that work arrives in.
//
// Three things were also wrong with the page itself:
//
//  1. It defaulted its date filter to the current month and filtered on CREATED_AT, so a
//     follow-up raised last month and overdue today was invisible — the one row that most
//     needed to be seen. A follow-up list has no business being scoped to a calendar
//     month; it is scoped to what is still open. Removed the date filter entirely.
//  2. It never sent ?view, and the server read an omitted view as "all", so every rep saw
//     every follow-up in the company. Now scoped, and enforced server-side as well.
//  3. Its KPI strip counted the whole table while the list beneath showed a subset, so the
//     two never agreed.
// ─────────────────────────────────────────────────────────────────────────────

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
  linked_type?: string
  linked_id?: number
}

interface CRMUser { id: number; full_name: string }

interface TaskKPIs {
  total: number
  open: number
  overdue: number
  completed_this_month: number
}

type Scope = 'my' | 'team' | 'all'
/** Which slice of the queue is showing. 'open' is the default because that is the job. */
type Bucket = 'open' | 'overdue' | 'done' | 'all'

const BUCKETS: { value: Bucket; label: string; hint: string }[] = [
  { value: 'open',    label: 'Open',    hint: 'Still to do' },
  { value: 'overdue', label: 'Overdue', hint: 'Past their due date' },
  { value: 'done',    label: 'Done',    hint: 'Completed' },
  { value: 'all',     label: 'All',     hint: 'Every follow-up' },
]

const PRIORITIES = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high',   label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low' },
]

const PRIORITY_COLOR: Record<string, string> = {
  urgent: RED, high: AMBER, medium: BLUE, low: '#6B7280',
}

function PriorityDot({ priority }: { priority: string }) {
  const color = PRIORITY_COLOR[(priority ?? '').toLowerCase()] ?? '#6B7280'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: RADIUS.full, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', textTransform: 'capitalize' }}>{priority}</span>
    </div>
  )
}

/** How overdue, in words — "3 days late" reads faster than a date you have to subtract. */
function dueLabel(t: Task): { text: string; color: string } {
  if (!t.due_date) return { text: '—', color: 'var(--txt3)' }
  const due = new Date(t.due_date)
  const now = new Date()
  const days = Math.round((due.getTime() - now.getTime()) / 86_400_000)
  if (t.status === 'done' || t.status === 'cancelled') {
    return { text: fmtDate(t.due_date), color: 'var(--txt3)' }
  }
  if (days < 0)  return { text: `${Math.abs(days)}d late`, color: RED }
  if (days === 0) return { text: 'Today', color: AMBER }
  if (days === 1) return { text: 'Tomorrow', color: 'var(--txt)' }
  return { text: fmtDate(t.due_date), color: 'var(--txt)' }
}

const BLANK = { title: '', contact_id: '', due_date: '', priority: 'medium', assigned_to: '', description: '' }

const MGMT = new Set(['sales_head', 'head_sales', 'cmo', 'md', 'admin'])

export default function CRMTasks() {
  // Row click opens the shared ?task= modal (mounted in App.tsx) rather than a local
  // one, so the same task detail — and the same complete/snooze/reassign actions —
  // appear whether you arrived from this list, from a customer, or from the bell.
  const [params, setParams] = useSearchParams()
  const openTask = params.get('task')
  const navigate = useNavigate()

  const me = currentUser()
  // Only someone who runs a team or carries a management role can widen past their own
  // queue. The server enforces this too — this just keeps the control off the screen for
  // people it would only ever return their own rows to.
  const canWiden = isSalesHead(me) || (!!me && allRoles(me).some(r => MGMT.has(r)))

  const [tasks, setTasks]     = useState<Task[]>([])
  const [users, setUsers]     = useState<CRMUser[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const [scope,  setScope]  = useState<Scope>('my')
  const [bucket, setBucket] = useState<Bucket>('open')
  const [search, setSearch] = useState('')
  const [fPriority, setFPriority] = useState('')

  const [kpis, setKpis]         = useState<TaskKPIs | null>(null)
  const [kpiLoading, setKpiLoading] = useState(true)

  const [selected, setSelected]     = useState<Set<string | number>>(new Set())
  const [completing, setCompleting] = useState(false)

  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)

  const [editing, setEditing]     = useState<Task | null>(null)
  const [editForm, setEditForm]   = useState(BLANK)
  const [editSaving, setEditSaving] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      // No date window. A follow-up matters because it is open or late, not because it
      // was created inside an arbitrary calendar month — filtering on created_at is what
      // hid every overdue item raised before the 1st.
      const p = new URLSearchParams({ view: scope, limit: '500' })
      if (bucket === 'overdue') p.set('overdue', 'true')
      else if (bucket === 'open') p.set('status', 'open')
      else if (bucket === 'done') p.set('status', 'done')
      if (fPriority) p.set('priority', fPriority)

      const [ts, us] = await Promise.all([
        apiFetch<Task[]>(`/api/crm/tasks?${p}`),
        apiFetch<CRMUser[]>('/api/crm/users'),
      ])
      setTasks(Array.isArray(ts) ? ts : [])
      setUsers(Array.isArray(us) ? us : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [scope, bucket, fPriority])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals','crm'] })

  // The modal completes, snoozes and reassigns without this page knowing, so refresh
  // the list once it closes — otherwise a task just marked done sits there looking open.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !openTask) load()
    wasOpen.current = !!openTask
  }, [openTask, load])

  // Only the free-text search runs client-side; status, priority and scope are all served
  // so they span the whole queue rather than the page that happens to be loaded.
  const filtered = useMemo(() => {
    if (!search) return tasks
    const q = search.toLowerCase()
    return tasks.filter(t =>
      t.title?.toLowerCase().includes(q) ||
      t.assigned_name?.toLowerCase().includes(q) ||
      `${t.first_name ?? ''} ${t.last_name ?? ''}`.toLowerCase().includes(q))
  }, [tasks, search])

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: TaskKPIs }>('/api/sales/task-kpis')
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [scope])

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
      toast.success('Follow-up created')
      setNewOpen(false); setForm(BLANK); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setSaving(false) }
  }

  async function markDone(id: number) {
    try {
      await apiPut(`/api/crm/tasks/${id}`, { status: 'done' })
      setTasks(ts => ts.map(t => t.id === id ? { ...t, status: 'done' } : t))
      toast.success('Follow-up completed')
    } catch (ex: any) { toast.error(ex.message) }
  }

  async function batchComplete() {
    if (selected.size === 0) return
    setCompleting(true)
    try {
      await Promise.all([...selected].map(id => apiPut(`/api/crm/tasks/${id}`, { status: 'done' })))
      toast.success(`${selected.size} follow-up${selected.size > 1 ? 's' : ''} completed`)
      setSelected(new Set()); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setCompleting(false) }
  }

  async function deleteTask(id: number) {
    try {
      await apiFetch(`/api/crm/tasks/${id}`, { method: 'DELETE' })
      setTasks(ts => ts.filter(t => t.id !== id))
      toast.success('Follow-up deleted')
    } catch (ex: any) { toast.error(ex.message) }
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
      toast.success('Follow-up updated')
      setEditing(null); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setEditSaving(false) }
  }

  const bulkBar = (
    <button onClick={batchComplete} disabled={completing}
      style={{ ...btnPrimary, background: GREEN, padding: '5px 14px', fontSize: TEXT.sm, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {completing && <Spinner size={13} color="#fff" />}
      Mark Done
    </button>
  )

  const cols: TableCol<Task>[] = [
    {
      key: 'title', label: 'Follow-Up',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.title}</div>
          {r.description && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>{r.description.slice(0, 60)}{r.description.length > 60 ? '…' : ''}</div>}
        </div>
      ),
    },
    {
      // A follow-up raised on a lead links back to it. Without this the officer reads
      // "Call back with the card limit" and has to go and find who that was about.
      key: 'first_name', label: 'About',
      render: r => {
        const who = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()
        if (!who) return <span style={{ color: 'var(--txt3)' }}>—</span>
        return (
          <button
            onClick={e => { e.stopPropagation(); navigate(`/sales/leads?open=${r.contact_id}`) }}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
            title="Open this lead"
          >
            <NameCell name={who} avatar={false} />
          </button>
        )
      },
    },
    {
      key: 'due_date', label: 'Due',
      render: r => {
        const d = dueLabel(r)
        return <span style={{ fontSize: TEXT.sm, color: d.color, fontWeight: d.color === RED ? FW.semibold : FW.normal }}>{d.text}</span>
      },
    },
    { key: 'priority', label: 'Priority', render: r => <PriorityDot priority={r.priority} /> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.is_overdue && r.status !== 'done' ? 'overdue' : r.status} /> },
    { key: 'assigned_name', label: 'Owner', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.assigned_name ?? '—'}</span> },
    {
      key: '_actions', label: '', sortable: false,
      render: r => <ActionRow actions={[
        { icon: 'edit', label: 'Edit', onClick: () => { setEditing(r); setEditForm({ title: r.title, contact_id: String(r.contact_id ?? ''), due_date: r.due_date?.slice(0, 10) ?? '', priority: r.priority, assigned_to: String(r.assigned_to ?? ''), description: r.description ?? '' }) } },
        { icon: 'check_circle', label: 'Complete', onClick: () => markDone(r.id) },
        { icon: 'delete', label: 'Delete', danger: true, onClick: () => deleteTask(r.id) },
      ]} />,
    },
  ]

  const scopeLabel = scope === 'my' ? 'Yours' : scope === 'team' ? 'Your team' : 'Everyone'

  return (
    <Page
      loading={loading && tasks.length === 0}
      skeletonKpis={4}
      title="Follow-Ups"
      subtitle="What you promised to do next, and when it is due"
      actions={
        <button onClick={() => { setForm(BLANK); setNewOpen(true) }} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Follow-Up
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label={`Total (${scopeLabel})`} value={kpis ? fmtNum(kpis.total) : '—'} icon="task_alt" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Open" value={kpis ? fmtNum(kpis.open) : '—'} icon="pending" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Overdue" value={kpis ? fmtNum(kpis.overdue) : '—'} icon="schedule" accent={RED} loading={kpiLoading} />
        <KpiCard label="Completed This Month" value={kpis ? fmtNum(kpis.completed_this_month) : '—'} icon="check_circle" accent={GREEN} loading={kpiLoading} />
      </div>

      <SectionCard
        title={BUCKETS.find(b => b.value === bucket)?.label ?? 'Follow-Ups'}
        badge={filtered.length}
        padding={false}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <TblSearch value={search} onChange={setSearch} placeholder="Search follow-ups…" ariaLabel="Search follow-ups" width={180} />
            <SelectMenu value={bucket} onChange={v => setBucket(v as Bucket)}
              options={BUCKETS} searchable={false} ariaLabel="Which follow-ups" style={{ width: 130 }} />
            <SelectMenu value={fPriority} onChange={setFPriority} options={PRIORITIES}
              clearLabel="Any priority" searchable={false} ariaLabel="Priority" style={{ width: 140 }} />
            {canWiden && (
              <SelectMenu value={scope} onChange={v => setScope(v as Scope)} searchable={false}
                ariaLabel="Whose follow-ups" style={{ width: 140 }}
                options={[
                  { value: 'my',   label: 'Mine' },
                  { value: 'team', label: 'My Team' },
                  { value: 'all',  label: 'Everyone' },
                ]} />
            )}
          </div>
        }
      >
        {!loading && filtered.length === 0 && !search ? (
          <EmptyState
            icon="alarm_add"
            title={bucket === 'overdue' ? 'Nothing overdue' : 'No follow-ups here'}
            description={
              bucket === 'overdue'
                ? 'Every follow-up in this queue is still within its due date.'
                : 'Follow-ups are raised from the work: open a lead and use Follow Up, and it '
                  + 'lands here with a due date and shows on that lead’s history. You can also '
                  + 'create a standalone one with the button above.'
            }
            action={{ label: 'Go To Leads', onClick: () => navigate('/sales/leads'), icon: 'arrow_forward' }}
          />
        ) : (
          <DataTable<Task>
            cols={cols}
            rows={filtered}
            keyFn={r => r.id}
            onRowClick={r => setParams(p => { p.set('task', String(r.id)); return p }, { replace: false })}
            selectable
            selectedIds={selected}
            onSelect={setSelected}
            bulkBar={bulkBar}
            emptyText="No follow-ups match that search."
            skeletonRows={loading ? 6 : 0}
            pageSize={20}
          />
        )}
      </SectionCard>

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Follow-Up" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={handleCreate}>Create</Button>
          </div>
        }
      >
        <TaskForm form={form} setForm={setForm} users={users} />
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Follow-Up" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={editSaving} onClick={handleEdit}>Save</Button>
          </div>
        }
      >
        <TaskForm form={editForm} setForm={setEditForm} users={users} />
      </Modal>
    </Page>
  )
}

// ── Shared form ───────────────────────────────────────────────────────────────

function TaskForm({
  form, setForm, users,
}: {
  form: typeof BLANK
  setForm: (fn: (f: typeof BLANK) => typeof BLANK) => void
  users: CRMUser[]
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Input label="What needs doing?" required value={form.title}
        onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
        placeholder="e.g. Call back with the card limit" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <SelectMenuField label="Priority" value={form.priority}
          onChange={v => setForm(f => ({ ...f, priority: v }))} options={PRIORITIES} searchable={false} />
        <Input label="Due Date" type="date" value={form.due_date}
          onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
      </div>
      {/* The officer list is long and unbounded in a native select — SelectMenu bounds
          its height, flips only when there is genuinely no room below, and filters. */}
      <SelectMenuField label="Owner" value={form.assigned_to}
        onChange={v => setForm(f => ({ ...f, assigned_to: v }))}
        clearLabel="Unassigned"
        options={toOptions(users, u => u.id, u => u.full_name)}
        hint="Who is going to do this. Defaults to nobody, which means it will chase no one." />
      <Input label="Note (Optional)" value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        placeholder="Context worth having when this comes back up" />
    </div>
  )
}
