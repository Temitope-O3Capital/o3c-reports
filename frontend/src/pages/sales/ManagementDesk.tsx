import { useCallback, useEffect, useMemo, useState } from 'react'
import { SectionCard, Button, Spinner, EmptyState, Avatar } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtDate } from '../../lib/fmt'
import { currentUser } from '../../hooks/useAuth'

// The Desk — what needs a judgement this week, and the conversation about it.
//
// WHY THIS IS NOT THE SUPERVISOR SCREEN. A head operates and opens Team (Live) many times a
// day; this is opened once and read. The two are deliberately different compositions over the
// same data rather than one screen with its buttons hidden, because hiding a control is not
// removing it — there is no assign, reassign or close here at all. The MD's version of
// "reassign that" is Ask, which lands as an owned question with an answer due.
//
// WHY EVERY ITEM LEADS WITH A SENTENCE. A wall of figures with no implied action is what makes
// an executive stop opening a page. Each item says what happened in words, carries its
// evidence underneath, and offers only the verbs that actually exist.
//
// THE STATE THAT MATTERS MOST IS "CANNOT SIGN IN". An officer with no access is not an idle
// officer, and the two need opposite responses, so they are never merged into one count and
// the narrative always says which it is. The same reasoning drives the working-days figure:
// the server has already taken leave and declared public holidays out of it, because the
// first time this page tells the MD somebody was quiet during a week they were on approved
// leave, it is finished as a management tool.

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
}

const SEV: Record<string, string> = { urgent: RED, watch: AMBER, quiet: 'var(--txt3)' }

const REVIEW_LABEL: Record<string, string> = {
  needs_review: 'Unreviewed',
  reviewed: 'Reviewed',
  acknowledged: 'Acknowledged',
  escalated: 'Escalated',
  closed: 'Closed',
}

const REVIEW_COLOUR: Record<string, string> = {
  needs_review: 'var(--txt3)',
  reviewed: GREEN,
  acknowledged: GREEN,
  escalated: RED,
  closed: 'var(--txt3)',
}

const EYEBROW = {
  fontSize: TEXT['2xs'],
  fontWeight: FW.semibold,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--txt3)',
}

export default function ManagementDesk() {
  const user = currentUser()
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await apiFetch<{ data: { subjects: Subject[]; from: string; to: string } }>(
        '/api/management/inbox')
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

  // Counted separately and never summed. "Assigned to someone who cannot sign in" and
  // "quiet week with a live book" are different problems with different owners.
  const counts = useMemo(() => {
    const noAccess = subjects.filter(s => s.severity === 'urgent').length
    return {
      total: subjects.length,
      noAccess,
      quiet: subjects.length - noAccess,
      openThreads: subjects.reduce((a, s) => a + s.open_threads, 0),
    }
  }, [subjects])

  if (loading) {
    return <div style={{ padding: SP[8], textAlign: 'center' }}><Spinner /></div>
  }

  return (
    <div style={{ display: 'grid', gap: SP[5] }}>
      <header style={{ borderBottom: `2px solid ${NAVY}`, paddingBottom: SP[3] }}>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: SP[3],
          alignItems: 'baseline', justifyContent: 'space-between',
        }}>
          <h1 style={{
            margin: 0, fontSize: TEXT['2xl'], fontWeight: FW.semibold, color: 'var(--txt)',
          }}>Needs Attention</h1>
          <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {user?.name} &middot; week of {from ? fmtDate(from) : '—'} to {to ? fmtDate(to) : '—'}
          </span>
        </div>

        {/* One line of state, not a tile wall. The three numbers never merge. */}
        <div style={{
          marginTop: SP[3], display: 'flex', flexWrap: 'wrap',
          gap: `${SP[1]} ${SP[5]}`, fontSize: TEXT.sm, color: 'var(--txt2)',
        }}>
          <span>
            <b style={{ ...NUM, color: 'var(--txt)' }}>{counts.total}</b> waiting on a judgement
          </span>
          {counts.noAccess > 0 && (
            <span><b style={{ ...NUM, color: RED }}>{counts.noAccess}</b> cannot sign in</span>
          )}
          {counts.quiet > 0 && (
            <span><b style={{ ...NUM, color: AMBER }}>{counts.quiet}</b> quiet with a live book</span>
          )}
          {counts.openThreads > 0 && (
            <span>
              <b style={{ ...NUM, color: 'var(--txt)' }}>{counts.openThreads}</b> questions unanswered
            </span>
          )}
        </div>
      </header>

      {subjects.length === 0 ? (
        <EmptyState
          icon="task_alt"
          title="Nothing Needs You This Week"
          description={
            `No officer went a full working week without recorded activity while holding live ` +
            `leads, between ${from ? fmtDate(from) : 'the start of the week'} and ` +
            `${to ? fmtDate(to) : 'its end'}. Leave and declared public holidays are already ` +
            `taken out, so this is a real result rather than a quiet calendar. An empty desk ` +
            `is the intended state.`
          }
        />
      ) : (
        subjects.map(s => {
          const id = `${s.subject_type}:${s.subject_key}`
          return (
            <SubjectCard
              key={id}
              s={s}
              expanded={open === id}
              onToggle={() => setOpen(o => (o === id ? null : id))}
              onChanged={() => void load(true)}
            />
          )
        })
      )}
    </div>
  )
}

function SubjectCard({ s, expanded, onToggle, onChanged }: {
  s: Subject
  expanded: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const rail = SEV[s.severity] ?? SEV.quiet
  const [busy, setBusy] = useState(false)

  const review = async (state: string) => {
    setBusy(true)
    try {
      await apiPost(
        `/api/management/subjects/${s.subject_type}/${encodeURIComponent(s.subject_key)}/review`,
        { state, period_start: s.period_start ?? '', period_end: s.period_end ?? '' })
      toast.success(state === 'escalated' ? 'Escalated' : 'Acknowledged')
      onChanged()
    } catch {
      toast.error('Could not record that')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard padding={false} style={{ borderLeft: `3px solid ${rail}`, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 0,
      }}>
        <div style={{ padding: SP[5], flex: '1 1 420px', minWidth: 0 }}>
          <div style={{ ...EYEBROW, display: 'flex', gap: SP[2], flexWrap: 'wrap', marginBottom: SP[2] }}>
            <span style={{ color: NAVY }}>{s.module}</span>
            <span>&middot;</span>
            <span>{s.label}</span>
            {s.period_start && <><span>&middot;</span><span>{fmtDate(s.period_start)}</span></>}
          </div>

          <h3 style={{
            margin: 0, marginBottom: SP[2], fontSize: TEXT.lg,
            fontWeight: FW.semibold, color: 'var(--txt)', textWrap: 'balance',
          }}>{s.title}</h3>

          <p style={{
            fontSize: TEXT.sm, lineHeight: 1.6, color: 'var(--txt2)',
            margin: 0, maxWidth: '62ch',
          }}>{s.narrative}</p>

          <dl style={{
            display: 'flex', flexWrap: 'wrap', gap: `${SP[2]} ${SP[6]}`, margin: 0,
            marginTop: SP[3], paddingTop: SP[3], borderTop: '1px solid var(--bdr)',
          }}>
            {s.figures.map(f => (
              <div key={f.label}>
                <dt style={EYEBROW}>{f.label}</dt>
                <dd style={{
                  ...NUM, margin: 0, marginTop: 2, fontSize: TEXT.lg,
                  fontWeight: FW.semibold, color: f.bad ? RED : 'var(--txt)',
                }}>{f.value}</dd>
              </div>
            ))}
          </dl>

          <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap', marginTop: SP[3] }}>
            {s.verbs.includes('ask') && (
              <Button variant="primary" onClick={onToggle}>Ask &mdash; and get an answer</Button>
            )}
            {s.verbs.includes('comment') && (
              <Button variant="secondary" onClick={onToggle}>
                {s.notes > 0 ? `Notes (${s.notes})` : 'Comment'}
              </Button>
            )}
            {s.verbs.includes('acknowledge') && s.review_state === 'needs_review' && (
              <Button variant="secondary" disabled={busy} onClick={() => void review('acknowledged')}>
                Acknowledge
              </Button>
            )}
            {s.verbs.includes('escalate') && s.review_state !== 'escalated' && (
              <Button variant="secondary" disabled={busy} onClick={() => void review('escalated')}>
                Escalate
              </Button>
            )}
          </div>

          <p style={{
            fontSize: TEXT['2xs'], color: 'var(--txt3)', fontStyle: 'italic',
            marginTop: SP[2], marginBottom: 0,
          }}>
            Asking creates an owned question with an answer due. Nothing on this page
            reassigns or closes anything &mdash; that stays with the head.
          </p>
        </div>

        {/* The margin. The review state and the thread, given a column rather than treated
            as an afterthought: on this page the note IS the product. */}
        <aside style={{
          borderLeft: '1px solid var(--bdr)', background: 'var(--bg2)',
          padding: SP[3], flex: '0 1 280px', minWidth: 0,
          display: 'flex', flexDirection: 'column', gap: SP[2],
        }}>
          <span style={EYEBROW}>Review</span>
          <span style={{
            ...NUM, fontSize: TEXT['2xs'], textTransform: 'uppercase', letterSpacing: '0.05em',
            padding: `2px ${SP[2]}`, borderRadius: RADIUS.sm, alignSelf: 'flex-start',
            border: `1px solid ${REVIEW_COLOUR[s.review_state] ?? 'var(--txt3)'}`,
            color: REVIEW_COLOUR[s.review_state] ?? 'var(--txt3)',
          }}>
            {REVIEW_LABEL[s.review_state] ?? s.review_state}
            {s.open_threads > 0 && ` · ${s.open_threads} open`}
          </span>
          {s.reviewed_by && (
            <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
              {s.reviewed_by}{s.reviewed_at ? ` · ${fmtDate(s.reviewed_at)}` : ''}
            </span>
          )}
          {expanded
            ? <Thread subject={s} onChanged={onChanged} />
            : (
              <Button variant="ghost" onClick={onToggle} style={{ justifyContent: 'flex-start' }}>
                {s.notes > 0 ? `Read ${s.notes} note${s.notes === 1 ? '' : 's'}` : 'Add a note…'}
              </Button>
            )}
        </aside>
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
      const r = await apiFetch<Note[]>(path)
      setNotes(Array.isArray(r) ? r : [])
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
        // Replying to the most recent thread keeps one conversation per subject rather
        // than a wall of unconnected first notes. A reply also marks that thread answered.
        thread_root_id: roots.length > 0 ? roots[roots.length - 1].id : null,
        period_start: subject.period_start ?? '',
        period_end: subject.period_end ?? '',
      })
      setBody('')
      await load()
      onChanged()
    } catch {
      toast.error('Could not save the note')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2], minWidth: 0 }}>
      <span style={EYEBROW}>Thread</span>

      {loading ? <Spinner /> : roots.length === 0 ? (
        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>No notes yet.</span>
      ) : roots.map(root => (
        <div key={root.id} style={{ display: 'grid', gap: 6 }}>
          <NoteLine n={root} isRoot />
          {notes.filter(n => n.thread_root_id === root.id).map(reply => (
            <div key={reply.id} style={{ paddingLeft: SP[2] }}>
              <NoteLine n={reply} />
            </div>
          ))}
        </div>
      ))}

      <textarea
        id={`note-${subject.subject_type}-${subject.subject_key}`}
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Ask a question, or leave a note…"
        rows={3}
        style={{
          width: '100%', fontSize: TEXT.xs, padding: SP[2], borderRadius: RADIUS.sm,
          border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
          color: 'var(--txt)', resize: 'vertical', fontFamily: 'inherit',
        }}
      />
      <Button variant="primary" disabled={busy || !body.trim()} onClick={() => void send()}>
        {roots.length > 0 ? 'Reply' : 'Send'}
      </Button>
      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
        The officer is told, and can answer here. Notes cannot be edited once sent.
      </span>
    </div>
  )
}

function NoteLine({ n, isRoot }: { n: Note; isRoot?: boolean }) {
  return (
    <div style={{
      fontSize: TEXT.xs, lineHeight: 1.5, paddingLeft: SP[2],
      borderLeft: `2px solid ${isRoot && n.status === 'open' ? AMBER : 'var(--bdr)'}`,
    }}>
      <span style={{
        ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)',
        display: 'flex', gap: 6, alignItems: 'center',
      }}>
        <Avatar name={n.author_name} size={16} />
        {n.author_name}
        {isRoot && n.status === 'open' && <span style={{ color: AMBER }}>· awaiting an answer</span>}
      </span>
      <p style={{ margin: 0, marginTop: 2, color: 'var(--txt2)', overflowWrap: 'anywhere' }}>
        {n.body}
      </p>
    </div>
  )
}
