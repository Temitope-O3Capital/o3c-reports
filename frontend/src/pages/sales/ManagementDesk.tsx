import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  SectionCard, Button, Spinner, EmptyState, Avatar, DataTable, Modal, Input, Textarea,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { SelectMenu, SelectMenuField } from '../../components/SelectMenu'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtDate } from '../../lib/fmt'
import { currentUser } from '../../hooks/useAuth'

// Needs Attention — what is waiting on a judgement, and the conversation about it.
//
// REBUILT. The first version was a column of full-width cards with a 280px margin pinned
// beside a 1fr body: prose on 200-character lines, no density, no filters, and nothing
// scannable. Worse, its "Ask — and get an answer" button called the same handler as
// Comment and did nothing at all, while its own helper text claimed it created an owned
// question with an answer due. Nobody used the page — zero notes, zero reviews — and the
// zeros were the honest verdict.
//
// This is the house table with its column-header filter menus: one row per subject,
// sortable, filterable by module and review state, searchable. A row expands beneath the
// table into the narrative, the figures, the verbs and the thread, and collapses from the
// row. Type is a step up throughout, because this is read by the MD and the old page set
// its body at 12px.
//
// ASK IS REAL NOW (migration 394). It names who owes the answer — which is NOT the subject
// of the note, since a question about an officer's week is normally asked of their head —
// carries a date to answer by, notifies that person at high priority, and stays open until
// somebody replies. The verbs that follow are the only ones here, deliberately: management
// reads and judges, it does not operate. Reassigning a lead belongs to the head who owns
// it, so "move that" is expressed as asking them to.

interface Figure { label: string; value: string; bad?: boolean }

interface Subject {
  subject_type: string
  subject_key: string
  module: string
  label: string
  title: string
  narrative: string
  figures: Figure[]
  period_start?: string
  period_end?: string
  verbs: string[]
  review_state: string
  reviewed_by?: string
  reviewed_at?: string
  open_threads: number
  open_asks: number
  overdue_asks: number
  notes: number
  severity: string
}

interface Note {
  id: number
  thread_root_id: number | null
  body: string
  status: string
  created_at: string
  author_user_id: number
  author_name: string
  author_role: string
  asked_user_id?: number | null
  asked_name?: string | null
  due_at?: string | null
  answer_overdue?: boolean
}

interface Officer { id: number; full_name: string; role?: string }

/** Flat fields so the table's own filters and search can reach them. */
interface Row extends Subject {
  state_label: string
  module_label: string
}

const SEV: Record<string, string> = { urgent: RED, watch: AMBER, quiet: 'var(--txt3)' }

const REVIEW_LABEL: Record<string, string> = {
  needs_review: 'Unreviewed', reviewed: 'Reviewed', acknowledged: 'Acknowledged',
  escalated: 'Escalated', closed: 'Closed',
}

const REVIEW_COLOUR: Record<string, string> = {
  needs_review: 'var(--txt3)', reviewed: GREEN, acknowledged: GREEN,
  escalated: RED, closed: 'var(--txt3)',
}

const EYEBROW = {
  fontSize: TEXT.xs,
  fontWeight: FW.semibold,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.07em',
  color: 'var(--txt3)',
}

export default function ManagementDesk() {
  const me = currentUser()
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [officers, setOfficers] = useState<Officer[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState('')
  const [asking, setAsking] = useState<Subject | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await apiFetch<{
        data: { subjects: Subject[]; from: string; to: string }
      }>('/api/management/inbox')
      setSubjects(Array.isArray(r.data?.subjects) ? r.data.subjects : [])
      setFrom(r.data?.from ?? '')
      setTo(r.data?.to ?? '')
    } catch {
      toast.error('Could not open the desk')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // The people an ask can be addressed to. /api/sales/officers is the shared officer list;
  // it is gated sales+crm_contacts, which every role that can open this desk holds.
  useEffect(() => {
    apiFetch<{ data: Officer[] }>('/api/sales/officers')
      .then(r => setOfficers(Array.isArray(r) ? r : (r?.data ?? [])))
      .catch(() => setOfficers([]))
  }, [])

  const rows: Row[] = useMemo(() => subjects
    .map(s => ({
      ...s,
      state_label: REVIEW_LABEL[s.review_state] ?? s.review_state,
      module_label: s.module.charAt(0).toUpperCase() + s.module.slice(1),
    }))
    .filter(r => !stateFilter || r.review_state === stateFilter),
    [subjects, stateFilter])

  const open = rows.find(r => `${r.subject_type}:${r.subject_key}` === openKey) ?? null

  const counts = useMemo(() => ({
    total: subjects.length,
    unreviewed: subjects.filter(s => s.review_state === 'needs_review').length,
    urgent: subjects.filter(s => s.severity === 'urgent').length,
    asks: subjects.reduce((a, s) => a + (s.open_asks ?? 0), 0),
    overdue: subjects.reduce((a, s) => a + (s.overdue_asks ?? 0), 0),
  }), [subjects])

  const cols: TableCol<Row>[] = [
    {
      key: 'title', label: 'What Needs You', sortable: true,
      render: r => (
        <div style={{ minWidth: 0, borderLeft: `3px solid ${SEV[r.severity] ?? SEV.quiet}`, paddingLeft: SP[3] }}>
          <div style={{
            fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)',
            lineHeight: 1.35, textWrap: 'balance',
          }}>{r.title}</div>
          <div style={{ ...EYEBROW, marginTop: 3 }}>
            {r.module_label} · {r.label}
            {r.period_start && <> · week of {fmtDate(r.period_start)}</>}
          </div>
        </div>
      ),
    },
    {
      key: 'figures', label: 'Evidence', sortable: false, width: 230,
      render: r => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${SP[1]} ${SP[4]}` }}>
          {r.figures.slice(0, 3).map(f => (
            <div key={f.label}>
              <div style={{ ...EYEBROW, letterSpacing: '0.04em' }}>{f.label}</div>
              <div style={{
                ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold,
                color: f.bad ? RED : 'var(--txt)', lineHeight: 1.15,
              }}>{f.value}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'state_label', label: 'Review', sortable: true, width: 150,
      render: r => (
        <div>
          <span style={{
            ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, textTransform: 'uppercase',
            letterSpacing: '0.05em', padding: `3px ${SP[2]}`, borderRadius: RADIUS.sm,
            border: `1px solid ${REVIEW_COLOUR[r.review_state] ?? 'var(--txt3)'}`,
            color: REVIEW_COLOUR[r.review_state] ?? 'var(--txt3)', whiteSpace: 'nowrap',
          }}>{REVIEW_LABEL[r.review_state] ?? r.review_state}</span>
          {r.reviewed_by && (
            <div style={{ ...EYEBROW, marginTop: 3, letterSpacing: '0.04em' }}>{r.reviewed_by}</div>
          )}
        </div>
      ),
    },
    {
      key: 'open_threads', label: 'Conversation', sortable: true, width: 160,
      render: r => (
        <div style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>
          {r.notes === 0
            ? <span style={{ color: 'var(--txt3)' }}>No notes</span>
            : <>
                <b style={{ ...NUM, color: 'var(--txt)' }}>{r.notes}</b> note{r.notes === 1 ? '' : 's'}
                {r.open_asks > 0 && (
                  <div style={{
                    ...EYEBROW, marginTop: 3, letterSpacing: '0.04em',
                    color: r.overdue_asks > 0 ? RED : AMBER,
                  }}>
                    {r.open_asks} awaiting an answer
                    {r.overdue_asks > 0 && ` · ${r.overdue_asks} overdue`}
                  </div>
                )}
              </>}
        </div>
      ),
    },
    {
      key: '_open', label: '', sortable: false, width: 56, align: 'right',
      render: r => (
        <span className="material-symbols-rounded" style={{
          fontSize: 22,
          color: openKey === `${r.subject_type}:${r.subject_key}` ? NAVY : 'var(--txt3)',
        }}>
          {openKey === `${r.subject_type}:${r.subject_key}` ? 'expand_less' : 'expand_more'}
        </span>
      ),
    },
  ]

  return (
    <div style={{ maxWidth: 1340, margin: '0 auto', display: 'grid', gap: SP[5] }}>
      <header>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: SP[3],
          alignItems: 'baseline', justifyContent: 'space-between',
        }}>
          <h1 style={{
            margin: 0, fontSize: TEXT['3xl'], fontWeight: FW.bold,
            color: 'var(--txt)', letterSpacing: '-0.01em',
          }}>Needs Attention</h1>
          <span style={{ ...NUM, fontSize: TEXT.base, color: 'var(--txt3)' }}>
            {me?.name}
            {from && to && <> · week of {fmtDate(from)} to {fmtDate(to)}</>}
          </span>
        </div>
        <p style={{
          margin: `${SP[1]} 0 0`, fontSize: TEXT.md, color: 'var(--txt2)',
          lineHeight: 1.6, maxWidth: '76ch',
        }}>
          Each item stays here until it gets a judgement — a note, an acknowledgement, or a
          question with somebody's name on it. Nothing on this page reassigns or closes
          anything; that stays with the head who owns the work.
        </p>
      </header>

      {/* The figures, large. Unreviewed and awaiting-an-answer are different things and
          are never added together. */}
      <div style={{
        display: 'grid', gap: SP[3],
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      }}>
        <Figure label="Waiting on you" value={counts.total} colour={NAVY} />
        <Figure label="Unreviewed" value={counts.unreviewed} colour={AMBER} />
        <Figure label="Urgent" value={counts.urgent} colour={RED} />
        <Figure
          label={counts.overdue > 0 ? 'Answers overdue' : 'Awaiting an answer'}
          value={counts.overdue > 0 ? counts.overdue : counts.asks}
          colour={counts.overdue > 0 ? RED : 'var(--txt2)'}
        />
      </div>

      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: SP[3], alignItems: 'center',
        padding: SP[3], borderRadius: RADIUS.md,
        background: 'var(--card)', border: '1px solid var(--bdr)',
      }}>
        <div style={{ width: 220 }}>
          <SelectMenu
            value={stateFilter} onChange={setStateFilter}
            options={Object.entries(REVIEW_LABEL).map(([k, v]) => ({
              value: k, label: v,
              hint: String(subjects.filter(s => s.review_state === k).length),
            }))}
            clearLabel="Any Review State"
            ariaLabel="Filter by review state" leadingIcon="rule"
          />
        </div>
        <span style={{ fontSize: TEXT.base, color: 'var(--txt3)' }}>
          Module and review state can also be filtered from the column headers.
        </span>
      </div>

      {loading ? (
        <div style={{ padding: SP[10], textAlign: 'center' }}><Spinner /></div>
      ) : (
        <DataTable<Row>
          cols={cols}
          rows={rows}
          keyFn={r => `${r.subject_type}:${r.subject_key}`}
          onRowClick={r => setOpenKey(k =>
            k === `${r.subject_type}:${r.subject_key}` ? null : `${r.subject_type}:${r.subject_key}`)}
          searchKeys={['title', 'narrative', 'module_label']}
          searchPlaceholder="Search what needs you…"
          filters={[
            { key: 'module_label', label: 'Module' },
            { key: 'state_label', label: 'Review' },
          ]}
          emptyText={
            <EmptyState
              icon="task_alt"
              title="Nothing Needs You"
              description={
                'No subject is waiting on a judgement. Leave and declared public holidays ' +
                'are already taken out of the working-week test, so this is a real result ' +
                'rather than a quiet calendar. An empty desk is the intended state.'
              }
            />
          }
        />
      )}

      {open && (
        <SubjectDetail
          s={open}
          onClose={() => setOpenKey(null)}
          onAsk={() => setAsking(open)}
          onChanged={() => void load(true)}
        />
      )}

      {asking && (
        <AskModal
          s={asking}
          officers={officers}
          onClose={() => setAsking(null)}
          onDone={() => { setAsking(null); void load(true) }}
        />
      )}
    </div>
  )
}

function Figure({ label, value, colour }: { label: string; value: number; colour: string }) {
  return (
    <SectionCard padding={false}>
      <div style={{ padding: SP[4] }}>
        <div style={EYEBROW}>{label}</div>
        <div style={{
          ...NUM, marginTop: SP[1], fontSize: TEXT['3xl'], fontWeight: FW.bold,
          color: value > 0 ? colour : 'var(--txt3)', lineHeight: 1.05,
        }}>{value}</div>
      </div>
    </SectionCard>
  )
}

function SubjectDetail({ s, onClose, onAsk, onChanged }: {
  s: Subject; onClose: () => void; onAsk: () => void; onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)

  const review = async (state: string) => {
    setBusy(true)
    try {
      await apiPost(
        `/api/management/subjects/${s.subject_type}/${encodeURIComponent(s.subject_key)}/review`,
        { state, period_start: s.period_start ?? '', period_end: s.period_end ?? '' })
      toast.success(state === 'escalated' ? 'Escalated' : 'Acknowledged')
      onChanged()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not record that')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard padding={false} style={{ borderTop: `3px solid ${SEV[s.severity] ?? SEV.quiet}` }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: SP[3], alignItems: 'baseline',
        justifyContent: 'space-between', padding: `${SP[4]} ${SP[5]}`,
        borderBottom: '1px solid var(--bdr)',
      }}>
        <h2 style={{
          margin: 0, fontSize: TEXT['2xl'], fontWeight: FW.bold,
          color: 'var(--txt)', textWrap: 'balance', maxWidth: '60ch',
        }}>{s.title}</h2>
        <Button variant="secondary" icon="close" onClick={onClose}>Collapse</Button>
      </div>

      <div style={{ padding: SP[5], display: 'grid', gap: SP[5] }}>
        <p style={{
          margin: 0, fontSize: TEXT.lg, lineHeight: 1.7, color: 'var(--txt2)', maxWidth: '78ch',
        }}>{s.narrative}</p>

        {s.figures.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: `${SP[3]} ${SP[6]}`,
            paddingTop: SP[4], borderTop: '1px solid var(--bdr)',
          }}>
            {s.figures.map(f => (
              <div key={f.label}>
                <div style={EYEBROW}>{f.label}</div>
                <div style={{
                  ...NUM, marginTop: 2, fontSize: TEXT['2xl'], fontWeight: FW.bold,
                  color: f.bad ? RED : 'var(--txt)',
                }}>{f.value}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
          {s.verbs.includes('ask') && (
            <Button variant="primary" icon="help" onClick={onAsk}>Ask someone</Button>
          )}
          {s.verbs.includes('acknowledge') && s.review_state === 'needs_review' && (
            <Button variant="secondary" icon="check" disabled={busy}
              onClick={() => void review('acknowledged')}>Acknowledge</Button>
          )}
          {s.verbs.includes('escalate') && s.review_state !== 'escalated' && (
            <Button variant="secondary" icon="priority_high" disabled={busy}
              onClick={() => void review('escalated')}>Escalate</Button>
          )}
        </div>

        <Thread subject={s} onChanged={onChanged} />
      </div>
    </SectionCard>
  )
}

function Thread({ subject, onChanged }: { subject: Subject; onChanged: () => void }) {
  const [notes, setNotes] = useState<Note[]>([])
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const path =
    `/api/management/subjects/${subject.subject_type}/${encodeURIComponent(subject.subject_key)}/notes`

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<Note[] | { data?: Note[] }>(path)
      setNotes(Array.isArray(r) ? r : (r?.data ?? []))
    } catch {
      toast.error('Could not load the thread')
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => { void load() }, [load])

  const roots = notes.filter(n => n.thread_root_id === null)

  const send = async () => {
    const text = body.trim()
    if (!text) return
    setBusy(true)
    try {
      await apiPost(path, {
        body: text,
        // A reply answers the most recent thread, which is what marks it answered.
        thread_root_id: roots.length > 0 ? roots[roots.length - 1].id : null,
        period_start: subject.period_start ?? '',
        period_end: subject.period_end ?? '',
      })
      setBody('')
      await load()
      onChanged()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save the note')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ paddingTop: SP[4], borderTop: '1px solid var(--bdr)' }}>
      <div style={{ ...EYEBROW, marginBottom: SP[3] }}>The conversation</div>

      {loading ? <Spinner /> : roots.length === 0 ? (
        <p style={{ margin: 0, fontSize: TEXT.base, color: 'var(--txt3)' }}>
          Nothing said yet. A note here is visible to the person it is about, and they can
          answer it.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: SP[4] }}>
          {roots.map(root => (
            <div key={root.id} style={{ display: 'grid', gap: SP[2] }}>
              <NoteLine n={root} isRoot />
              {notes.filter(n => n.thread_root_id === root.id).map(reply => (
                <div key={reply.id} style={{ paddingLeft: SP[6] }}>
                  <NoteLine n={reply} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: SP[4], display: 'grid', gap: SP[2], maxWidth: 760 }}>
        <Textarea
          id={`note-${subject.subject_type}-${subject.subject_key}`}
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Leave a note…"
          rows={3}
        />
        <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }}>
          <Button variant="primary" disabled={busy || !body.trim()} onClick={() => void send()}>
            {roots.length > 0 ? 'Reply' : 'Add note'}
          </Button>
          <span style={{ fontSize: TEXT.base, color: 'var(--txt3)' }}>
            Notes cannot be edited once sent.
          </span>
        </div>
      </div>
    </div>
  )
}

function NoteLine({ n, isRoot }: { n: Note; isRoot?: boolean }) {
  const awaiting = isRoot && n.status === 'open' && !!n.asked_user_id
  return (
    <div style={{
      paddingLeft: SP[3],
      borderLeft: `3px solid ${n.answer_overdue ? RED : awaiting ? AMBER : 'var(--bdr)'}`,
    }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: SP[2], alignItems: 'center',
        fontSize: TEXT.base, color: 'var(--txt3)',
      }}>
        <Avatar name={n.author_name} size={22} />
        <b style={{ color: 'var(--txt)', fontWeight: FW.semibold }}>{n.author_name}</b>
        {n.created_at && <span>{fmtDate(n.created_at)}</span>}
        {/* An ask says who owes the answer. Without this a question is indistinguishable
            from a remark, which is exactly how the old button looked like a comment. */}
        {n.asked_name && (
          <span style={{ color: n.answer_overdue ? RED : AMBER, fontWeight: FW.medium }}>
            → asked {n.asked_name}
            {n.due_at && <> · by {fmtDate(n.due_at)}</>}
            {n.answer_overdue && ' · overdue'}
          </span>
        )}
        {isRoot && n.status === 'answered' && (
          <span style={{ color: GREEN, fontWeight: FW.medium }}>· answered</span>
        )}
      </div>
      <p style={{
        margin: `${SP[1]} 0 0`, fontSize: TEXT.md, lineHeight: 1.65,
        color: 'var(--txt)', overflowWrap: 'anywhere', maxWidth: '78ch',
      }}>{n.body}</p>
    </div>
  )
}

/** Ask: a question with a named recipient and a date, which is what makes it an ask. */
function AskModal({ s, officers, onClose, onDone }: {
  s: Subject; officers: Officer[]; onClose: () => void; onDone: () => void
}) {
  const [who, setWho] = useState('')
  const [due, setDue] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!who || !text.trim()) return
    setBusy(true)
    try {
      await apiPost(
        `/api/management/subjects/${s.subject_type}/${encodeURIComponent(s.subject_key)}/notes`,
        {
          body: text.trim(),
          asked_user_id: Number(who),
          // A bare date becomes end of that working day rather than midnight, which is how
          // a question asked on Monday reads as already overdue on Monday morning.
          due_at: due ? new Date(`${due}T17:00:00`).toISOString() : '',
          period_start: s.period_start ?? '',
          period_end: s.period_end ?? '',
        })
      toast.success('Asked. They have been notified.')
      onDone()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not send the question')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Ask someone" width={620}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!who || !text.trim()} onClick={submit}>
            Send the question
          </Button>
        </div>
      }
    >
      <p style={{
        margin: `0 0 ${SP[4]}`, fontSize: TEXT.md, lineHeight: 1.65, color: 'var(--txt2)',
      }}>
        About <b style={{ color: 'var(--txt)' }}>{s.title}</b>. They are notified, and the
        question stays open on this item until somebody answers it.
      </p>

      <div style={{ display: 'grid', gap: SP[4] }}>
        <SelectMenuField
          label="Who owes the answer" required searchable
          value={who} onChange={setWho}
          options={officers
            .slice()
            .sort((a, b) => a.full_name.localeCompare(b.full_name))
            .map(o => ({ value: String(o.id), label: o.full_name, hint: o.role?.replace(/_/g, ' ') }))}
          placeholder="Choose a person…"
          hint="Usually the head who owns the work, not the officer the item is about — they are the one who can answer it."
        />
        <Input
          label="Answer by" type="date" value={due}
          onChange={e => setDue(e.target.value)}
          hint="Optional. Without a date the question stays open but can never read as overdue."
        />
        <Textarea
          label="The question" required value={text} rows={4}
          onChange={e => setText(e.target.value)}
          placeholder="What do you need to know?"
        />
      </div>
    </Modal>
  )
}
