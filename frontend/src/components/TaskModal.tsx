import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Modal, Button, Select, Spinner } from './UI'
import { apiFetch, apiPut, apiPost } from '../lib/api'
import { fmtDatetime } from '../lib/fmt'
import { RED, GREEN, AMBER, BLUE, TEXT, FW, SP, RADIUS } from '../lib/design'

// The global task modal.
//
// Tasks used to live only on /sales/tasks — a destination you had to remember to
// visit, and the one place the work was guaranteed NOT to be in front of you. This
// component is mounted once at the app shell and driven entirely by ?task=<id>, so a
// task can be opened over whatever page you are already on: the customer's book entry,
// the lead, the application. Notifications carry that same link (see taskActionURL in
// the Go handlers), which is what makes "click the bell, land on the work" possible.
//
// Because the state lives in the URL, a task is also linkable — it can be pasted into
// a chat, and browser back closes it rather than leaving the page.

interface Task {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  due_date: string | null
  assigned_to: number | null
  assignee_name: string | null
  creator_name: string | null
  contact_name: string | null
  contact_cif: string | null
  deal_title: string | null
  action_url: string | null
  created_at: string
}

interface Comment {
  id: number
  body: string
  created_at: string
  author_name: string | null
}

interface CRMUser { id: number; full_name: string }

function toneFor(priority: string, overdue: boolean) {
  if (overdue) return RED
  if ((priority || '').toLowerCase() === 'high') return AMBER
  return BLUE
}

// Snooze offsets, in hours. Anything longer than a week is really a re-plan, which
// belongs on the task's own due-date field rather than behind a one-click button.
const SNOOZE = [
  { label: '1 hour', hours: 1 },
  { label: 'Tomorrow', hours: 24 },
  { label: 'Next week', hours: 24 * 7 },
]

export default function TaskModal() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const taskId = params.get('task')

  const [task, setTask] = useState<Task | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [users, setUsers] = useState<CRMUser[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [comment, setComment] = useState('')

  const close = useCallback(() => {
    const next = new URLSearchParams(params)
    next.delete('task')
    setParams(next, { replace: true })
  }, [params, setParams])

  const load = useCallback(async () => {
    if (!taskId) return
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<{ data: Task }>(`/api/crm/tasks/${taskId}`)
      setTask(res.data)
      // Comments and the assignee list are secondary — a failure on either should
      // leave the task itself readable rather than blanking the modal.
      apiFetch<Comment[]>(`/api/crm/tasks/${taskId}/comments`)
        .then(c => setComments(Array.isArray(c) ? c : []))
        .catch(() => setComments([]))
      apiFetch<CRMUser[]>('/api/crm/users')
        .then(u => setUsers(Array.isArray(u) ? u : []))
        .catch(() => setUsers([]))
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load this task')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    if (taskId) load()
    else { setTask(null); setComments([]); setErr(null); setComment('') }
  }, [taskId, load])

  async function patch(body: Record<string, unknown>, success: string) {
    if (!task) return
    setBusy(true)
    try {
      await apiPut(`/api/crm/tasks/${task.id}`, body)
      toast.success(success)
      close()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not update the task')
    } finally {
      setBusy(false)
    }
  }

  async function addComment() {
    if (!task || !comment.trim()) return
    setBusy(true)
    try {
      await apiPost(`/api/crm/tasks/${task.id}/comments`, { body: comment.trim() })
      setComment('')
      const c = await apiFetch<Comment[]>(`/api/crm/tasks/${task.id}/comments`)
      setComments(Array.isArray(c) ? c : [])
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not add the comment')
    } finally {
      setBusy(false)
    }
  }

  function snooze(hours: number) {
    const d = new Date(Date.now() + hours * 3600 * 1000)
    patch({ due_date: d.toISOString() }, `Snoozed until ${fmtDatetime(d.toISOString())}`)
  }

  if (!taskId) return null

  const overdue = !!task?.due_date && new Date(task.due_date) < new Date()
  const done = ['done', 'cancelled'].includes((task?.status ?? '').toLowerCase())
  // Only offer "open the record" when it would actually move you somewhere. On the
  // record's own page the link is a no-op and just adds noise.
  const recordUrl = task?.action_url?.split('?')[0]
  const canGoToRecord = !!recordUrl && recordUrl !== location.pathname

  return (
    <Modal
      open
      onClose={close}
      title={task?.title ?? 'Task'}
      width={560}
      footer={
        task && !done ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button onClick={() => patch({ status: 'done' }, 'Task completed')} disabled={busy}>
              {busy && <Spinner size={13} color="#fff" />} Complete
            </Button>
            {SNOOZE.map(s => (
              <Button key={s.hours} variant="secondary" onClick={() => snooze(s.hours)} disabled={busy}>
                {s.label}
              </Button>
            ))}
            {canGoToRecord && (
              <Button variant="secondary" onClick={() => { close(); navigate(task.action_url!) }}>
                Open record
              </Button>
            )}
          </div>
        ) : (
          <Button variant="secondary" onClick={close}>Close</Button>
        )
      }
    >
      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner size={28} /></div>}

      {err && (
        <div style={{ background: `${RED}0F`, border: `1px solid ${RED}33`, borderRadius: RADIUS.md, padding: '12px 14px', fontSize: TEXT.base, color: 'var(--txt)' }}>
          {err}
        </div>
      )}

      {task && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{
              padding: '3px 9px', borderRadius: RADIUS.sm, fontSize: TEXT.xs, fontWeight: FW.bold,
              background: `${toneFor(task.priority, overdue)}1A`, color: toneFor(task.priority, overdue),
            }}>
              {overdue ? 'Overdue' : (task.priority || 'medium')}
            </span>
            <span style={{
              padding: '3px 9px', borderRadius: RADIUS.sm, fontSize: TEXT.xs, fontWeight: FW.bold,
              background: done ? `${GREEN}1A` : 'var(--th-bg)', color: done ? GREEN : 'var(--txt2)',
            }}>
              {task.status}
            </span>
            {task.due_date && (
              <span style={{ fontSize: TEXT.sm, color: overdue ? RED : 'var(--txt2)' }}>
                Due {fmtDatetime(task.due_date)}
              </span>
            )}
          </div>

          {task.description && (
            <div style={{ fontSize: TEXT.base, color: 'var(--txt)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
              {task.description}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, padding: '12px 0', borderTop: '1px solid var(--bdr)', borderBottom: '1px solid var(--bdr)' }}>
            {[
              ['Assigned to', task.assignee_name || 'Unassigned'],
              ['Raised by', task.creator_name || '—'],
              ['About', task.contact_name || task.deal_title || '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{value}</div>
              </div>
            ))}
          </div>

          {!done && users.length > 0 && (
            <div>
              <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>
                Reassign
              </label>
              <Select
                value={String(task.assigned_to ?? '')}
                onChange={e => patch({ assigned_to: Number(e.target.value) }, 'Task reassigned')}
              >
                <option value="">— Select —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </Select>
            </div>
          )}

          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>
              Notes {comments.length > 0 && `(${comments.length})`}
            </div>
            {comments.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10, maxHeight: 180, overflowY: 'auto' }}>
                {comments.map(c => (
                  <div key={c.id} style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '8px 10px' }}>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>
                      {c.author_name || 'Unknown'} · {fmtDatetime(c.created_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                spellCheck={false}
                value={comment}
                onChange={e => setComment(e.target.value)}
                rows={2}
                placeholder="Add a note…"
                style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
              />
              <Button variant="secondary" onClick={addComment} disabled={busy || !comment.trim()}>Add</Button>
            </div>
          </div>

          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            Raised {fmtDatetime(task.created_at)}
          </div>
        </div>
      )}
      <div style={{ height: SP[1] }} />
    </Modal>
  )
}
