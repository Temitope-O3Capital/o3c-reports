import { useLiveData } from "../../hooks/useRealtime"
import { useSearchParams } from 'react-router-dom'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react' 
import {
  Page, ErrBanner, Spinner, TblSearch, filterInputStyle, ConfirmModal, Modal, NameCell,
} from '../../components/UI'
import { apiFetch, apiPost, apiPatch, apiBlob } from '../../lib/api'
import { fmtDatetime, fmtCount } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'
import { CallLogForm, callOutcomeLabel, groupCallConversations, type CallConversation } from '../../components/LogCallModal'
import LogActivityModal from '../../components/LogActivityModal'
import HandoffActions, { HandoffStatusChip, type HandoffViewer } from '../../components/HandoffActions'
import CallLogEditModal, { type EditableCall } from '../../components/CallLogEditModal'
import { RecordingModal } from '../../components/RecordingPlayer'
import { PRODUCT_LINES, PRODUCT_SUBS } from '../../lib/products'
import { isCallCentreSupervisor } from '../../lib/roles'

// Heads/supervisors distribute and (re)assign leads; agents only work their own book.
// Answered once for the whole module in lib/roles — the regex this replaced matched on
// the word "head", so md/coo/cfo/cmo fell through it and the COO got an agent's view.
function isHeadRole(): boolean {
  return isCallCentreSupervisor()
}

// Which logged calls a user may correct: their own, or anyone's if they supervise.
// The backend is the real gate (owner-or-supervisor); this just keeps the control
// off calls it would refuse.
function myFullName(): string {
  try { const u = JSON.parse(localStorage.getItem('o3c_user') || '{}'); return String(u.full_name || u.name || '') } catch { return '' }
}
function canCorrectCall(agentName: string | null | undefined): boolean {
  return isHeadRole() || (!!agentName && agentName.trim() === myFullName().trim())
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Lead {
  id:              number
  campaign_id:     number | null
  campaign_name:   string | null
  customer_cif:    string | null
  customer_name:   string
  customer_phone:  string | null
  employer:        string | null
  email:           string | null
  address:         string | null
  state:           string | null
  lead_score:      number
  status:          string
  assigned_to:     number | null
  agent_name:      string | null
  last_called_at:  string | null
  callback_at:     string | null
  notes:           string | null
  created_at:      string
  forwarded_at:    string | null
  // last_outcome is the RAW telephony value ('completed', 'missed'). It is never
  // rendered directly — leadOutcomeLabel below turns it into something an agent
  // can read, using the duration and recording to tell a conversation from a dial.
  last_outcome:            string | null
  last_disposition:        string | null
  last_call_direction:     string | null
  last_call_duration_sec:  number | null
  last_call_recorded:      boolean | null
}

// The agent's own disposition is the truth when there is one; otherwise label the
// raw outcome the same way the call history does, so the two never disagree.
function leadOutcomeLabel(lead: Lead): string {
  const d = lead.last_disposition?.trim()
  if (d) return d
  if (!lead.last_outcome?.trim()) return ''
  return callOutcomeLabel(
    lead.last_outcome, lead.last_call_direction,
    lead.last_call_duration_sec, lead.last_call_recorded,
  )
}

interface CCCampaign { id: number; name: string }
interface CCAgent    { id: number; full_name: string }

// Real, whole-scope status totals for the KPI cards (not per-page). distributable =
// unassigned+pending (gates Distribute); recallable = assigned+pending (gates Recall).
interface LeadSummary {
  pending: number; interested: number; callbacks: number; converted: number
  unassigned: number; distributable: number; recallable: number
}
const ZERO_SUMMARY: LeadSummary = { pending: 0, interested: 0, callbacks: 0, converted: 0, unassigned: 0, distributable: 0, recallable: 0 }

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pending:     '#6B7280',
  interested:  '#0D9488',  // a warm lead worth chasing — distinct from the green "converted"
  called:      BLUE,
  not_ready:   '#6366F1',  // reached, but "not now" — a timing pile of its own
  callback:    AMBER,
  no_answer:   'var(--chart-lbl)',
  converted:   GREEN,
  dnc:         RED,
  // Distinct from 'not interested': a decline on our side (closed) and a timing
  // objection worth calling back are different states of the same lead.
  closed:      '#6B7280',
  invalid:     '#9CA3AF',
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return (
    <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}14`, color: c }}>
      {label}
    </span>
  )
}

// The private four-outcome vocabulary that used to live here is gone: lead calls
// now use the shared disposition list from LogCallModal, narrowed to the
// marketing book. OUTCOME_COLOR below still maps the historic values stored on
// existing leads.

const OUTCOME_COLOR: Record<string, string> = {
  interested:     GREEN,
  converted:      GREEN,
  not_interested: RED,
  callback:       AMBER,
  no_answer:      'var(--chart-lbl)',
  voicemail:      'var(--chart-lbl)',
  dnc:            RED,
}

// The dot has to agree with the label printed beside it, so both read the same thing:
// the agent's disposition when there is one, else the labelled telephony outcome.
// Keying OUTCOME_COLOR with last_outcome directly ('completed'/'missed') matched
// nothing and painted every dot grey.
function leadOutcomeColor(lead: Lead): string {
  const l = leadOutcomeLabel(lead).toLowerCase()
  if (l.includes('not interested') || l.includes('do not call') || l.includes('wrong number')) return OUTCOME_COLOR.not_interested
  if (l.includes('interested') || l.includes('converted') || l.includes('resolved')) return OUTCOME_COLOR.interested
  if (l.includes('callback') || l.includes('not ready') || l.includes('promise')) return OUTCOME_COLOR.callback
  if (l.includes('no answer') || l.includes('missed') || l.includes('not connected') || l.includes('voicemail')) return OUTCOME_COLOR.no_answer
  if (l.includes('connected') || l.includes('dropped')) return BLUE
  return '#6B7280'
}

// ── Lead call panel ───────────────────────────────────────────────────────────
// The Leads page used to carry its own four-field "Log Call" form (outcome,
// callback, duration, notes) posting to /api/call-center/leads/{id}/disposition,
// while every other screen used the shared Log-a-Call flow. A lead call therefore
// never captured a CIF, a disposition, a purpose or a follow-up ticket, and the
// two could drift apart indefinitely.
//
// It is still inline — that is the right shape for a detail pane, and it is one
// fewer click than a dialog — but it is now literally the same component the
// modal renders, tailored to leads: no customer picker (the pane above shows the
// lead), no direction (working a lead list is outbound), no purpose (marketing).
function LeadCallPanel({ lead, onDone }: { lead: Lead; onDone: (disposition?: string) => void }) {
  return (
    <CallLogForm
      open
      variant="inline"
      onClose={() => { /* inline: nothing to dismiss */ }}
      onSaved={onDone}
      initial={{
        name:      lead.customer_name,
        phone:     lead.customer_phone ?? undefined,
        cif:       lead.customer_cif ?? undefined,
        direction: 'Outbound',
        purpose:   'marketing',
        leadId:    lead.id,
      }}
    />
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

// Edit a lead's identity — the way a number-only import gets a name and details.
function EditLeadModal({ open, lead, onClose, onSaved }: {
  open: boolean; lead: Lead; onClose: () => void; onSaved: () => void
}) {
  const [name, setName]         = useState('')
  const [employer, setEmployer] = useState('')
  const [email, setEmail]       = useState('')
  const [cif, setCif]           = useState('')
  const [address, setAddress]   = useState('')
  const [state, setState]       = useState('')
  const [saving, setSaving]     = useState(false)

  useEffect(() => {
    if (!open) return
    setName(lead.customer_name === lead.customer_phone ? '' : (lead.customer_name ?? ''))
    setEmployer(lead.employer ?? '')
    setEmail(lead.email ?? '')
    setCif(lead.customer_cif ?? '')
    setAddress(lead.address ?? '')
    setState(lead.state ?? '')
  }, [open, lead])

  async function save() {
    setSaving(true)
    try {
      await apiFetch(`/api/call-center/leads/${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          customer_name: name.trim() || lead.customer_phone || '',
          employer, email, customer_cif: cif, address, state,
        }),
      })
      toast.success('Lead updated')
      onSaved()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }

  return (
    <Modal open={open} onClose={onClose} title="Edit Lead" width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {lead.customer_phone && <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Phone <strong style={{ color: 'var(--txt)', fontFamily: 'var(--font-mono)' }}>{lead.customer_phone}</strong></div>}
        <div><label style={lbl}>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" style={inp} autoFocus /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={lbl}>Employer</label><input value={employer} onChange={e => setEmployer(e.target.value)} style={inp} /></div>
          <div><label style={lbl}>Email</label><input value={email} onChange={e => setEmail(e.target.value)} style={inp} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={lbl}>State</label><input value={state} onChange={e => setState(e.target.value)} placeholder="e.g. Lagos" style={inp} /></div>
          <div><label style={lbl}>CIF (If a Customer)</label><input value={cif} onChange={e => setCif(e.target.value)} style={inp} /></div>
        </div>
        <div><label style={lbl}>Address</label><input value={address} onChange={e => setAddress(e.target.value)} style={inp} /></div>
      </div>
    </Modal>
  )
}

// Hand a worked lead to Sales. Only a supervisor may forward — the backend 403s an
// agent (call_center_forwards.go), who signals interest by dispositioning the lead
// "Interested" instead. The forwarded lead is then trackable under Forwarded Leads.
function ForwardToSalesModal({ open, lead, onClose, onDone }: {
  open: boolean; lead: Lead; onClose: () => void; onDone: () => void
}) {
  const [product, setProduct] = useState('')
  const [notes, setNotes]     = useState('')
  const [saving, setSaving]   = useState(false)
  const inp: CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }
  useEffect(() => { if (open) { setProduct(''); setNotes('') } }, [open])
  async function submit() {
    setSaving(true)
    try {
      await apiPost(`/api/call-center/leads/${lead.id}/forward`, { product_interest: product, notes })
      toast.success('Forwarded to Sales: track it under Forwarded Leads')
      onDone()
    } catch (e: any) { toast.error(e.message || 'Could not forward') }
    finally { setSaving(false) }
  }
  const canSubmit = !!product && !saving
  return (
    <Modal open={open} onClose={onClose} title="Forward to Sales" width={480}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={!canSubmit} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.6, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>forward</span>{saving ? 'Forwarding…' : 'Forward to Sales'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Lead summary card — what Sales is receiving */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: RADIUS.lg, background: 'var(--th-bg)', border: '1px solid var(--bdr)' }}>
          <div style={{ width: 38, height: 38, borderRadius: '50%', background: `${GREEN}18`, color: GREEN, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>handshake</span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{lead.customer_name}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>{lead.customer_phone || (lead.customer_cif ? `CIF ${lead.customer_cif}` : '—')}</div>
          </div>
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
          Sales picks this up, claims it and works it to conversion. You can follow it under <strong>Forwarded to Sales</strong> until they convert or close it.
        </div>
        <div><label style={lbl}>Product Interest <span style={{ color: RED }}>*</span></label>
          <select value={product} onChange={e => setProduct(e.target.value)} style={inp} autoFocus>
            <option value="">Which product is this lead for?</option>
            {PRODUCT_LINES.map(pl => (
              <optgroup key={pl.line} label={pl.label}>
                {PRODUCT_SUBS.filter(s => s.line === pl.line).map(s => (
                  <option key={s.code} value={s.code}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div><label style={lbl}>Notes for Sales</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What did the customer say? Why is this a good lead?" style={{ ...inp, resize: 'vertical' }} /></div>
      </div>
    </Modal>
  )
}

interface LeadCall {
  id: number; started_at: string | null; direction: string | null; outcome: string | null
  duration_sec: number | null; agent_name: string; notes: string; disposition: string
  resolution?: string | null
  recording_filename: string | null
}

// A non-call activity on a lead — a note, a document collected, a hand-off to another
// team, or a decision that came back. Distinct from the call history above it.
interface LeadActivity {
  id: number; type: string; subject: string | null; body: string | null; outcome: string | null
  actor_name: string | null; actor_team: string | null; target_team: string | null
  status: string | null; occurred_at: string
  actor_user_id: number | null
  // An activity that shadows a record elsewhere points at it: a follow-up at its
  // crm_task, a document at the stored file. The status/due/owner of a task are read
  // live off that task, so ticking it off in the CRM shows here too.
  entity_type: string | null; entity_id: string | null
  due_at: string | null; task_priority: string | null; assignee_name: string | null
}

const ACT_ICON: Record<string, string> = {
  handoff: 'swap_horiz', decision: 'gavel', note: 'sticky_note_2', document: 'description',
  stage_change: 'trending_up', task: 'task_alt', compliance_flag: 'flag',
  handoff_update: 'assignment_turned_in',
}

// One lead history holds two different kinds of record. They are told apart three
// ways, never by colour alone: shape (a call sits in a round medallion, an activity
// in a rounded square), icon, and a word — so the distinction survives a mono
// screen, a colour-blind reader, and a dark theme.
type TimelineItem =
  | { kind: 'call'; key: string; at: string | null; conv: CallConversation<LeadCall> }
  | { kind: 'act';  key: string; at: string;        act: LeadActivity }

type TimelineTab = 'all' | 'calls' | 'activity'

// Activity types and team names arrive as snake_case codes ('stage_change',
// 'customer_care'). They are labels, not data values, so they read as Title Case.
const titleWords = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())

// Acronyms the word-by-word capitaliser gets wrong: it turns 'sla_breach' into
// "Sla Breach", and one row in app.activities is already stored with that spelling.
const fixAcronyms = (s: string) =>
  s.replace(/\b(sla|dnc|cif|npl|kyc|sms|ussd)\b/gi, m => m.toUpperCase())

// A subject is either a written line ("Answered Not Interested", "Hand-off to Sales
// cancelled") or a bare code whose writer never labelled it ('stage_changed',
// 'application.created', 'offer_issued'). Only the codes get re-cased, because Title
// Casing a written line turns "Hand-off to Sales cancelled" into "Hand-Off To Sales
// Cancelled". A code is recognised by having no space in it.
const actTitle = (a: LeadActivity) => {
  const s = (a.subject ?? '').trim()
  if (!s) return fixAcronyms(titleWords(a.type))
  return /\s/.test(s) ? fixAcronyms(s) : fixAcronyms(titleWords(s.replace(/\./g, '_')))
}

// The call-centre disposition trigger writes TWO shadows of every call it records: a
// type='call' row (migration 251) and a stage_change for the move that same call
// caused, landing 19 milliseconds later. This page builds its own, richer call list
// from helpdesk_calls/call_center_dispositions, so both shadows restate an entry the
// timeline already shows: 6,051 stage_change rows across the book read "Moved by a
// call-centre call: Call Dropped" directly beneath the dropped call.
//
// Re-grades are the exception and stay. "The last call recorded Not Interested, and
// only an interested call qualifies a lead" is the one thing on this timeline an agent
// cannot work out from the calls above it.
const CALL_MIRROR =
  /^(Moved|Advanced) by a call-centre call|^Derived from call-centre activity/
const isCallMirror = (a: LeadActivity) =>
  a.type === 'call' ||
  (a.type === 'stage_change' && CALL_MIRROR.test((a.body ?? '').trim()))

function DetailPanel({ lead, onRefresh, onLogged }: { lead: Lead; onRefresh: () => void; onLogged: () => void }) {
  const [editOpen, setEditOpen] = useState(false)
  const [fwdOpen, setFwdOpen]   = useState(false)
  // A logged call being corrected/withdrawn (edit + void live in one modal).
  const [editCall, setEditCall] = useState<EditableCall | null>(null)
  // A recorded call the agent wants to play back (streams in a modal).
  const [playCallId, setPlayCallId] = useState<number | null>(null)
  // The log form is open by default only for a lead with no history — otherwise
  // reopening a lead lands you on what happened, not on a blank form.
  const [logOpen, setLogOpen] = useState(false)
  // A lead imported as a bare number shows its phone as the "name" — flag that so the
  // Edit control is obvious for exactly the rows that need a real name.
  const nameless = !lead.customer_name || lead.customer_name === lead.customer_phone

  // This lead's call history — refetched (via callKey) after a call is logged so the
  // agent sees the call they just logged, right here.
  const [calls, setCalls] = useState<LeadCall[]>([])
  const [callKey, setCallKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    apiFetch<LeadCall[]>(`/api/call-center/leads/${lead.id}/calls`)
      .then(r => {
        if (cancelled) return
        const list = Array.isArray(r) ? r : []
        setCalls(list)
        // A lead nobody has called yet opens straight into the form; one with
        // history opens into the history.
        setLogOpen(list.length === 0)
      })
      .catch(() => { if (!cancelled) setCalls([]) })
    return () => { cancelled = true }
  }, [lead.id, callKey])

  // Zoho emits a row per activity, not per conversation, so one attempt on a lead
  // arrived here as four rows with three contradictory outcomes. Group the legs of
  // a dialling episode into the conversation they actually were.
  const conversations = useMemo(() => groupCallConversations(calls), [calls])

  // Non-call activity for this lead — matched by lead id AND phone, so a hand-off logged
  // here and any reflect-back both surface. Refetched (actKey) after logging one.
  const [activities, setActivities] = useState<LeadActivity[]>([])
  const [actKey, setActKey] = useState(0)
  const [actOpen, setActOpen] = useState(false)
  // Who is looking. The server sends it with the list so the timeline can tell whether
  // THIS user is the team a hand-off is waiting on, without the frontend keeping its
  // own copy of the role→team mapping to drift out of step with the backend's.
  const [viewer, setViewer] = useState<HandoffViewer | null>(null)
  useEffect(() => {
    let cancelled = false
    const p = new URLSearchParams({ lead_id: String(lead.id) })
    if (lead.customer_phone) p.set('phone', lead.customer_phone)
    apiFetch<{ data: LeadActivity[]; viewer?: HandoffViewer }>(`/api/activities?${p.toString()}`)
      .then(r => {
        if (cancelled) return
        // Both shadows of a call the timeline already shows come out here: see
        // isCallMirror above for which rows those are, and why re-grades survive it.
        setActivities((r?.data ?? []).filter(a => !isCallMirror(a)))
        setViewer(r?.viewer ?? null)
      })
      .catch(() => { if (!cancelled) setActivities([]) })
    return () => { cancelled = true }
  }, [lead.id, lead.customer_phone, actKey])

  // Open a collected document. The file is served to an authenticated session, so it
  // is fetched as a blob rather than linked — and the tab is opened BEFORE the await,
  // or the browser treats the later window.open as an unrequested popup and blocks it.
  async function openDocument(docID: string) {
    const tab = window.open('', '_blank', 'noopener')
    try {
      const blob = await apiBlob(`/api/activities/documents/${docID}/content`)
      const url = URL.createObjectURL(blob)
      if (tab) tab.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e: any) {
      tab?.close()
      toast.error(e?.message || 'Could not open the document')
    }
  }

  // Tick a follow-up off from the record it was raised on. The write lands on the task
  // itself (crm_tasks), which is why the timeline shows it done straight after.
  async function completeTask(activityID: number) {
    try {
      await apiPatch(`/api/activities/${activityID}/status`, { status: 'done' })
      toast.success('Follow-up done')
      setActKey(k => k + 1)
    } catch (e: any) {
      toast.error(e?.message || 'Could not close the follow-up')
    }
  }

  // One history, not two. A call and a note are both "what happened to this lead",
  // and reading them in two separate lists meant reconstructing the order in your
  // head — the note that explains a call sat in a different box. They merge into a
  // single newest-first timeline (the order every other feed in the workspace uses,
  // and the order /api/activities already returns), each entry carrying what it is.
  const timeline = useMemo<TimelineItem[]>(() => {
    const ms = (s: string | null) => (s ? new Date(s).getTime() : 0)
    const items: TimelineItem[] = [
      ...conversations.map(c => ({ kind: 'call' as const, key: `c${c.call.id}`, at: c.firstAt, conv: c })),
      ...activities.map(a => ({ kind: 'act' as const, key: `a${a.id}`, at: a.occurred_at, act: a })),
    ]
    return items.sort((x, y) => ms(y.at) - ms(x.at))
  }, [conversations, activities])
  const [tab, setTab] = useState<TimelineTab>('all')
  const shownItems = timeline.filter(i => tab === 'all' || (tab === 'calls' ? i.kind === 'call' : i.kind === 'act'))

  // The two things an agent can record, as equals.
  const actionBtn: CSSProperties = {
    flex: 1, minHeight: 44, padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md,
    fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    transition: 'var(--transition-fast)',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Contact header */}
      <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: nameless ? 'var(--txt3)' : 'var(--txt)' }}>{nameless ? 'Unnamed Lead' : lead.customer_name}</div>
          <button onClick={() => setEditOpen(true)} title="Edit lead details"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: RADIUS.md, border: `1px solid ${nameless ? AMBER : 'var(--bdr)'}`, background: nameless ? `${AMBER}12` : 'var(--card)', color: nameless ? AMBER : 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>{nameless ? 'Add Name' : 'Edit'}
          </button>
        </div>
        <EditLeadModal open={editOpen} lead={lead} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); onRefresh() }} />
        <ForwardToSalesModal open={fwdOpen} lead={lead} onClose={() => setFwdOpen(false)} onDone={() => { setFwdOpen(false); onRefresh() }} />
        {lead.customer_phone && (
          <div style={{ fontSize: TEXT.md, color: NAVY, fontWeight: FW.semibold, marginBottom: SP[1] }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, verticalAlign: 'middle', marginRight: 4 }}>call</span>
            {lead.customer_phone}
          </div>
        )}
        <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap', marginTop: 6 }}>
          <StatusPill status={lead.status} />
          {lead.campaign_name && (
            <span style={{ fontSize: TEXT.xs, background: `${PURPLE}14`, color: PURPLE, padding: '2px 8px', borderRadius: RADIUS['2xl'], fontWeight: FW.semibold }}>
              {lead.campaign_name}
            </span>
          )}
          {lead.agent_name && (
            <span style={{ fontSize: TEXT.xs, background: `${NAVY}10`, color: NAVY, padding: '2px 8px', borderRadius: RADIUS['2xl'], fontWeight: FW.semibold }}>
              {lead.agent_name}
            </span>
          )}
          {/* Forwarding is stage-gated: only a lead an agent has warmed up
              ('interested', or a live 'callback') may go to Sales. Cold leads show
              nothing. Agents see a status chip; supervisors get the action. */}
          {(() => {
            const warm = lead.status === 'interested' || lead.status === 'callback'
            if (lead.forwarded_at) return (
              <span style={{ fontSize: TEXT.xs, background: `${GREEN}18`, color: GREEN, padding: '2px 9px', borderRadius: RADIUS['2xl'], fontWeight: FW.bold, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13 }}>forward_to_inbox</span> Forwarded to Sales
              </span>
            )
            if (!warm) return null
            if (isHeadRole()) return (
              <button onClick={() => setFwdOpen(true)}
                style={{ fontSize: TEXT.xs, background: GREEN, color: '#fff', padding: '3px 11px', borderRadius: RADIUS['2xl'], fontWeight: FW.bold, border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13 }}>forward</span> Forward to Sales
              </button>
            )
            return (
              <span style={{ fontSize: TEXT.xs, background: `${AMBER}16`, color: AMBER, padding: '2px 9px', borderRadius: RADIUS['2xl'], fontWeight: FW.semibold }}>
                Interested · Awaiting Supervisor Forward
              </span>
            )
          })()}
        </div>
      </div>

      {/* Lead info */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Lead Info</div>
        {[
          ['CIF',          lead.customer_cif],
          ['Employer',     lead.employer],
          ['State',        lead.state],
          ['Lead Score',   String(lead.lead_score ?? 0)],
          ['Assigned To',  lead.agent_name],
          ['Last Called',  lead.last_called_at ? fmtDatetime(lead.last_called_at) : null],
          ['Callback At',  lead.callback_at ? fmtDatetime(lead.callback_at) : null],
          ['Last Outcome', leadOutcomeLabel(lead)],
          ['Notes',        lead.notes],
        ].map(([label, value]) =>
          value ? (
            <div key={label as string} style={{ display: 'flex', gap: SP[2], marginBottom: 7 }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', minWidth: 90, flexShrink: 0 }}>{label}</span>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
            </div>
          ) : null
        )}
      </div>

      {/* Record something on this lead. The two things an agent can record — a call
          and everything that isn't a call — sit side by side as equals, so neither
          is buried under the other's history. Logging a call expands the inline
          form in place (one fewer click than a dialog); logging an activity opens
          the shared modal.
          The call form is collapsed by default once this lead has history: the
          common case on reopening a lead is READING what happened, not writing a
          new call, and a form sitting open invites a duplicate log. */}
      <div style={{ padding: `${SP[4]} ${SP[5]}` }}>
        <div style={{ display: 'flex', gap: SP[2] }}>
          <button onClick={() => setLogOpen(o => !o)} aria-expanded={logOpen}
            style={{ ...actionBtn, border: 'none', background: NAVY, color: '#fff',
                     boxShadow: logOpen ? 'none' : '0 1px 2px rgba(14,40,65,0.20)',
                     opacity: logOpen ? 0.92 : 1 }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>{logOpen ? 'expand_less' : 'add_call'}</span>
            {logOpen ? 'Close Call Form' : calls.length > 0 ? 'Log Another Call' : 'Log Call'}
          </button>
          <button onClick={() => setActOpen(true)}
            style={{ ...actionBtn, border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>bolt</span>
            Log Activity
          </button>
        </div>

        {logOpen && (
          <div style={{ marginTop: SP[3] }}>
            <LeadCallPanel
              lead={lead}
              onDone={(disposition) => {
                // A "Call Dropped" means the line died within seconds and nothing was
                // discussed — the agent will redial this SAME person now, so keep them
                // on this lead (it stays 'pending') and just refresh it in place, rather
                // than auto-advancing to the next lead the way a worked call does.
                if ((disposition ?? '').toLowerCase().includes('drop')) {
                  setCallKey(k => k + 1) // show the just-logged drop in the history
                  onRefresh()            // refresh the lead's own row (still pending)
                  toast.success('Call dropped: lead kept as pending. Redial when ready.')
                  return
                }
                // A worked call moves the agent to the next lead automatically. The panel
                // remounts on the new lead, so the reload/reset are that lead's concern.
                onLogged()
              }}
            />
          </div>
        )}
      </div>

      {/* History — the calls and the activity on one spine, newest first. The filter
          is a lens on that one list, not a second feed: "Calls" answers "did we
          reach them?" without pretending the notes happened somewhere else. */}
      <div style={{ padding: `0 ${SP[5]} ${SP[5]}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[3] }}>
          <div style={{ flex: 1, fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            History{timeline.length ? ` (${timeline.length})` : ''}
          </div>
          {/* Only worth a filter once there is something of both kinds to separate. */}
          {conversations.length > 0 && activities.length > 0 && (
            <div role="tablist" aria-label="Filter history" style={{
              display: 'inline-flex', gap: 2, padding: 2, background: 'var(--th-bg)',
              border: '1px solid var(--bdr)', borderRadius: RADIUS.full,
            }}>
              {([['all', 'All', timeline.length], ['calls', 'Calls', conversations.length], ['activity', 'Activity', activities.length]] as [TimelineTab, string, number][])
                .map(([v, label, n]) => {
                  const on = tab === v
                  return (
                    <button key={v} role="tab" aria-selected={on} onClick={() => setTab(v)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 11px',
                        borderRadius: RADIUS.full, border: 'none', cursor: 'pointer', fontFamily: INTER,
                        fontSize: TEXT.xs, fontWeight: on ? FW.bold : FW.semibold,
                        background: on ? 'var(--card)' : 'transparent',
                        color: on ? 'var(--txt)' : 'var(--txt3)',
                        boxShadow: on ? '0 1px 2px rgba(0,0,0,0.10)' : 'none',
                        transition: 'var(--transition-fast)',
                      }}>
                      {label}<span style={{ ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{n}</span>
                    </button>
                  )
                })}
            </div>
          )}
        </div>

        {shownItems.length === 0 ? (
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', padding: '8px 0' }}>
            {tab === 'calls'    ? 'No calls logged yet.'
           : tab === 'activity' ? 'Nothing logged beyond the calls. Notes, documents, hand-offs and re-grades show here.'
           : 'Nothing logged yet. Calls, notes, documents and hand-offs all show here.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {shownItems.map((item, i) => {
              const last = i === shownItems.length - 1
              const isCall = item.kind === 'call'
              const c = item.kind === 'call' ? item.conv.call : null
              // A dial that never connected is not a green tick. Empty means no
              // duration and no recording — nothing was said.
              const connected = !!c && ((c.duration_sec ?? 0) > 0 || !!c.recording_filename)
              const inbound   = (c?.direction || '').toLowerCase() === 'inbound'
              const col   = isCall ? (connected ? GREEN : RED) : 'var(--accent)'
              const tint  = isCall ? `${connected ? GREEN : RED}14` : 'var(--accent-soft)'
              const tag: CSSProperties = { fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.4px', textTransform: 'uppercase', color: col }

              return (
                <div key={item.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0' }}>
                  {/* The spine: one continuous line through the medallions, so the
                      record reads as a single sequence rather than two stacked lists. */}
                  <div style={{ position: 'relative', width: 30, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                    {!last && <span aria-hidden="true" style={{ position: 'absolute', top: 32, bottom: -20, left: 14, width: 2, background: 'var(--bdr)' }} />}
                    <span className="material-symbols-rounded" aria-hidden="true"
                      style={{
                        width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 17, color: col, background: tint, border: `1px solid ${tint}`,
                        // Shape carries the distinction on its own — a call is round,
                        // an activity is a rounded square — so it survives greyscale
                        // and a colour-blind reader, not just the colour.
                        borderRadius: isCall ? RADIUS.full : RADIUS.md, flexShrink: 0,
                      }}>{isCall ? (inbound ? 'call_received' : 'call_made') : (ACT_ICON[item.act.type] ?? 'bolt')}</span>
                  </div>

                  {item.kind === 'call' ? (() => {
                    const { attempts, firstAt, notes, disposition } = item.conv
                    const call = item.conv.call
                    const dur = call.duration_sec ? `${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s` : null
                    return (
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{disposition || callOutcomeLabel(call.outcome, call.direction, call.duration_sec, !!call.recording_filename)}</span>
                          {dur && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>{dur}</span>}
                          {/* The legs that reached nothing are still counted, so an
                              episode that took four dials to connect still says so. */}
                          {attempts > 1 && (
                            <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
                              {attempts} attempts{connected ? ', last connected' : ''}
                            </span>
                          )}
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{firstAt ? fmtDatetime(firstAt) : ''}</span>
                            {call.recording_filename && (
                              <button
                                title="Play the call recording"
                                aria-label="Play the call recording"
                                onClick={() => setPlayCallId(call.id)}
                                style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'none', cursor: 'pointer', color: GREEN, padding: 2, borderRadius: RADIUS.sm }}
                              >
                                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>play_circle</span>
                              </button>
                            )}
                            {canCorrectCall(call.agent_name) && (
                              <button
                                title="Correct or withdraw this call log"
                                aria-label="Correct or withdraw this call log"
                                onClick={() => setEditCall({
                                  id: call.id,
                                  customer_name: lead.customer_name,
                                  phone: lead.customer_phone ?? undefined,
                                  direction: call.direction || 'outbound',
                                  duration_seconds: call.duration_sec,
                                  disposition: disposition || call.disposition || null,
                                  resolution: call.resolution,
                                  purpose: 'marketing',
                                  notes: notes ?? call.notes ?? null,
                                })}
                                style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 2, borderRadius: RADIUS.sm }}
                              >
                                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                              </button>
                            )}
                          </span>
                        </div>
                        {notes && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.45 }}>{notes}</div>}
                        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={tag}>{inbound ? 'Inbound Call' : 'Call'}</span>
                          <span>{call.agent_name || 'Agent'}{call.recording_filename ? ' · Recorded' : ''}</span>
                        </div>
                      </div>
                    )
                  })() : (() => {
                    const a = item.act
                    // Three activities carry a life of their own beyond the note: a
                    // hand-off waiting on a team, a follow-up that is really a task, and
                    // a document that is really a file. Each shows its own state and the
                    // one action that moves it, here, where the agent already is.
                    const isHandoff = a.type === 'handoff'
                    const isTask    = a.entity_type === 'crm_task'
                    const isDoc     = a.entity_type === 'lead_document' && !!a.entity_id
                    const taskDone  = isTask && ['done', 'cancelled'].includes((a.status || '').toLowerCase())
                    const overdue   = isTask && !taskDone && !!a.due_at && new Date(a.due_at) < new Date()
                    const stateChip: CSSProperties = {
                      fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 8px', borderRadius: RADIUS.full,
                      textTransform: 'uppercase', letterSpacing: '0.3px',
                    }
                    return (
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{
                            fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)',
                            textDecoration: taskDone ? 'line-through' : 'none', opacity: taskDone ? 0.6 : 1,
                          }}>
                            {actTitle(a)}
                            {a.target_team ? ` → ${titleWords(a.target_team)}` : ''}
                          </span>
                          {isHandoff ? <HandoffStatusChip status={a.status} />
                            : isTask ? (
                              <span style={{
                                ...stateChip,
                                background: taskDone ? `${GREEN}14` : overdue ? `${RED}14` : 'var(--accent-soft)',
                                color:      taskDone ? GREEN        : overdue ? RED        : 'var(--accent)',
                              }}>{taskDone ? 'Done' : overdue ? 'Overdue' : 'Open'}</span>
                            ) : a.status ? (
                              <span style={{ ...stateChip, background: 'var(--accent-soft)', color: 'var(--accent)' }}>{titleWords(a.status)}</span>
                            ) : null}
                          {a.outcome && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'capitalize' }}>{a.outcome.replace(/_/g, ' ')}</span>}
                          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>{fmtDatetime(a.occurred_at)}</span>
                        </div>
                        {a.body && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.45 }}>{a.body}</div>}
                        {isTask && a.due_at && (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4, fontSize: TEXT.xs, color: overdue ? RED : 'var(--txt2)', fontWeight: overdue ? FW.semibold : FW.normal }}>
                            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>event</span>
                            Due {fmtDatetime(a.due_at)}
                            {a.assignee_name ? ` · ${a.assignee_name}` : ''}
                            {a.task_priority === 'urgent' && <span style={{ ...stateChip, background: `${RED}14`, color: RED }}>Urgent</span>}
                          </div>
                        )}
                        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={tag}>{fixAcronyms(titleWords(a.type))}</span>
                          <span>{a.actor_name || 'Staff'}{a.actor_team ? ` · ${titleWords(a.actor_team)}` : ''}</span>
                        </div>
                        {(isDoc || (isTask && !taskDone) || isHandoff) && (
                          <div style={{ marginTop: 7, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {isDoc && (
                              <button onClick={() => openDocument(a.entity_id!)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', minHeight: 30, borderRadius: RADIUS.md, border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>
                                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span> Open Document
                              </button>
                            )}
                            {isTask && !taskDone && (
                              <button onClick={() => completeTask(a.id)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', minHeight: 30, borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>
                                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>task_alt</span> Mark Done
                              </button>
                            )}
                            {isHandoff && (
                              <HandoffActions
                                handoff={{ id: a.id, status: a.status, target_team: a.target_team, actor_user_id: a.actor_user_id }}
                                viewer={viewer}
                                onDone={() => setActKey(k => k + 1)}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <LogActivityModal
        open={actOpen}
        about={nameless ? (lead.customer_phone ?? 'Unnamed Lead') : lead.customer_name}
        anchor={{ lead_id: lead.id, cif: lead.customer_cif ?? undefined, phone: lead.customer_phone ?? undefined }}
        onClose={() => setActOpen(false)}
        onSaved={() => { setActOpen(false); setActKey(k => k + 1) }}
      />

      {editCall && (
        <CallLogEditModal
          call={editCall}
          onClose={() => setEditCall(null)}
          onSaved={() => { setEditCall(null); setCallKey(k => k + 1); onRefresh() }}
        />
      )}

      <RecordingModal
        callId={playCallId}
        title="Call Recording"
        subtitle={lead.customer_name}
        onClose={() => setPlayCallId(null)}
      />
    </div>
  )
}

// ── Import leads modal (heads/supervisors) ─────────────────────────────────────

// A lead is not a customer: no CIF (that is the card book's identity key, issued on
// conversion) and no employer. Phone is the only required column — everything else
// helps the agent, but a lead with no number cannot be called at all.
const LEAD_TEMPLATE = 'phone,name,email,address,state\n08012345678,Jane Doe,jane@example.com,"12 Adeola Odeku Victoria Island",Lagos\n08087654321,John Smith,,,FCT\n'

const NEW_CAMPAIGN = '__new__'

// A header row is optional in an uploaded file — drop it so it isn't imported as a lead.
function isHeaderLine(line: string): boolean {
  return /(^|,)\s*"?phone"?\s*(,|$)/i.test(line) || (/name/i.test(line) && /phone/i.test(line))
}

// Canonical Nigerian phone: 0 + the last 10 digits. The Go importer and
// app.normalise_ng_phone do exactly the same thing; this runs client-side purely so
// the uploader can see what will happen before committing to it.
function normaliseNGPhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length < 10) return ''
  return '0' + digits.slice(-10)
}

// Split one CSV line, honouring double quotes so an address containing a comma
// survives. The previous parser split on every comma, so "12 Adeola Odeku, VI"
// silently became two columns and shifted email into address.
function splitCSVLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim()); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

interface ParsedLead { phone: string; name: string; email: string; address: string; state: string; rawPhone: string }

function ImportLeadsModal({ open, onClose, onDone, campaigns, onCampaignCreated }: {
  open: boolean; onClose: () => void; onDone: () => void; campaigns: CCCampaign[]
  onCampaignCreated: () => void
}) {
  const [campaignId, setCampaignId] = useState('')
  const [newCampaign, setNewCampaign] = useState('')
  const [raw, setRaw] = useState('')
  const [fileName, setFileName] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const creatingCampaign = campaignId === NEW_CAMPAIGN

  // Column order follows the template: phone, name, email, address, state. Only phone
  // is required — a lead with no number cannot be called, which is the whole point of
  // the outbound queue, so those rows are counted out loudly rather than imported
  // as unreachable dead weight.
  const allRows = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .filter(l => !isHeaderLine(l))
    .map(line => {
      const [phone = '', name = '', email = '', address = '', state = ''] = splitCSVLine(line)
      return { phone: normaliseNGPhone(phone), name, email, address, state, rawPhone: phone } as ParsedLead
    })
  const parsed  = allRows.filter(l => l.phone !== '')
  const rejected = allRows.filter(l => l.phone === '')

  function reset() {
    setRaw(''); setFileName(''); setCampaignId(''); setNewCampaign(''); setErr(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  // Escape or a mis-click beside the dialog used to bin a prepared upload — a 5,000-row
  // file and the campaign it was going to — without a word. Ask when there is something
  // to lose; an empty dialog still closes on the spot.
  function requestClose() {
    if (raw) { setDiscardConfirm(true); return }
    reset(); onClose()
  }

  function downloadTemplate() {
    const blob = new Blob([LEAD_TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'lead-list-template.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    // Replaces rather than appends. Appending was reasonable next to a paste box
    // the agent could see; with that box gone, picking a second file would
    // silently merge two lists with nothing on screen to show it had happened.
    reader.onload = () => {
      setRaw(String(reader.result ?? '').trim())
      setFileName(file.name)
    }
    reader.onerror = () => setErr('Could not read that file')
    reader.readAsText(file)
  }

  async function submit() {
    if (parsed.length === 0) { setErr('Add at least one row with a name or phone'); return }
    if (creatingCampaign && !newCampaign.trim()) { setErr('Name the new campaign'); return }
    setSaving(true); setErr(null)
    try {
      // Create the campaign first (marketing lead lists), then import into it.
      let targetCampaignId: number | undefined
      if (creatingCampaign) {
        const c = await apiPost<{ id: number }>('/api/call-center/campaigns', { name: newCampaign.trim(), purpose: 'marketing' })
        targetCampaignId = c?.id
        onCampaignCreated()
      } else if (campaignId) {
        targetCampaignId = Number(campaignId)
      }
      // Send only the four lead fields; rawPhone is a client-side display aid.
      const body: Record<string, any> = {
        leads: parsed.map(l => ({ phone: l.phone, name: l.name, email: l.email, address: l.address, state: l.state })),
      }
      if (targetCampaignId) body.campaign_id = targetCampaignId
      const res = await apiPost<{ inserted: number; attached: number; skipped: number; no_phone: number }>('/api/call-center/leads/import', body)
      // Name what happened. "12 skipped" alone leaves the uploader guessing whether
      // they were duplicates or bad rows; "attached" covers existing leads a re-upload
      // pulls into the chosen campaign.
      const bits = [`${res.inserted ?? 0} lead(s) uploaded`]
      if (res.attached) bits.push(`${res.attached} existing added to this campaign`)
      const dupes = (res.skipped ?? 0) - (res.no_phone ?? 0)
      if (dupes > 0) bits.push(`${dupes} already on the list`)
      if (res.no_phone) bits.push(`${res.no_phone} with no valid phone`)
      toast.success(bits.join(' · '))
      reset(); onDone(); onClose()
    } catch (e: any) { setErr(e.message ?? 'Upload failed') }
    finally { setSaving(false) }
  }

  return (
    <>
    <Modal open={open} onClose={requestClose} title="Upload Lead List" width={480}
      footer={
        <>
          <button onClick={requestClose} style={{ padding: '8px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving || parsed.length === 0}
            style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (saving || !parsed.length) ? 'not-allowed' : 'pointer', opacity: (saving || !parsed.length) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {saving && <Spinner size={13} color="#fff" />}Upload{parsed.length ? ` ${parsed.length}` : ''}
          </button>
        </>
      }
    >
      <ErrBanner error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Campaign — pick an existing one or create a new one inline */}
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Campaign</label>
          <select value={campaignId} onChange={e => setCampaignId(e.target.value)}
            style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }}>
            <option value="">No Campaign</option>
            {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            <option value={NEW_CAMPAIGN}>+ New Campaign…</option>
          </select>
          {creatingCampaign && (
            <input value={newCampaign} onChange={e => setNewCampaign(e.target.value)} autoFocus
              placeholder="New campaign name" spellCheck={false}
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', marginTop: 6 }} />
          )}
        </div>

        {/* Template + file upload */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={downloadTemplate}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            Download Template
          </button>
          <button type="button" onClick={() => fileRef.current?.click()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>upload_file</span>
            Upload CSV File
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onPickFile} style={{ display: 'none' }} />
        </div>

        {fileName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.sm, color: 'var(--txt)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: GREEN }}>description</span>
            <span style={{ fontWeight: FW.semibold }}>{fileName}</span>
            <button type="button" onClick={() => { setRaw(''); setFileName(''); if (fileRef.current) fileRef.current.value = '' }}
              style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--txt2)', cursor: 'pointer', fontSize: TEXT.xs }}>Remove</button>
          </div>
        )}
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
          {parsed.length} valid row(s) detected · duplicates by phone are skipped
        </div>
      </div>
    </Modal>
    <ConfirmModal
      open={discardConfirm}
      title="Discard This Upload?"
      body={`${fileName || 'The list you prepared'} and the campaign you picked will be cleared, and the ${parsed.length} row(s) ready to go will not be uploaded.`}
      confirmLabel="Discard"
      danger
      onConfirm={() => { setDiscardConfirm(false); reset(); onClose() }}
      onClose={() => setDiscardConfirm(false)}
    />
    </>
  )
}

// ── Assign-to-agent modal (heads) ──────────────────────────────────────────────
// Count-based hand-off of unassigned pending leads to one agent — the same "Assign to
// agent" action the Outbound Queue offers, for parity.

const ASSIGN_PRESETS = [20, 50, 100, 200]

function AssignLeadsModal({ open, onClose, onDone, agents, campaigns, defaultCampaignId }: {
  open: boolean; onClose: () => void; onDone: () => void
  agents: CCAgent[]; campaigns: CCCampaign[]; defaultCampaignId: string
}) {
  const [agentId, setAgentId] = useState('')
  const [count, setCount] = useState(50)
  const [campaignId, setCampaignId] = useState(defaultCampaignId)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (open) { setCampaignId(defaultCampaignId); setAgentId(''); setErr(null) } }, [open, defaultCampaignId])

  async function submit() {
    if (!agentId) { setErr('Pick an agent'); return }
    if (!count || count < 1) { setErr('Enter a count'); return }
    setSaving(true); setErr(null)
    try {
      const body: Record<string, any> = { agent_id: Number(agentId), count }
      if (campaignId) body.campaign_id = Number(campaignId)
      const res = await apiPost<any>('/api/call-center/leads/assign-batch', body)
      const d: any = (res as any)?.data ?? res
      const name = agents.find(a => a.id === Number(agentId))?.full_name ?? 'agent'
      toast.success(`Assigned ${d.assigned ?? 0} lead(s) to ${name}`)
      onClose(); onDone()
    } catch (e: any) { setErr(e.message ?? 'Assign failed') }
    finally { setSaving(false) }
  }

  const fld: React.CSSProperties = { width: '100%', height: 38, padding: '0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.03em' }

  return (
    <Modal open={open} onClose={onClose} title="Assign Leads to an Agent" width={460}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer' }}>
            {saving && <Spinner size={13} color="#fff" />}Assign {count}
          </button>
        </div>
      }>
      <ErrBanner error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div>
          <label style={lbl}>Agent</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={fld}>
            <option value="">Select an Agent…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>How Many</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {ASSIGN_PRESETS.map(p => (
              <button key={p} onClick={() => setCount(p)} style={{
                padding: '7px 13px', borderRadius: RADIUS.md, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: `1px solid ${count === p ? NAVY : 'var(--bdr)'}`, background: count === p ? `${NAVY}0e` : 'var(--card)', color: count === p ? NAVY : 'var(--txt2)',
              }}>{p}</button>
            ))}
            <input type="number" min={1} max={5000} value={count} onChange={e => setCount(Math.max(1, Math.min(5000, Number(e.target.value) || 0)))}
              style={{ ...fld, width: 90, height: 34 }} title="Custom count" />
          </div>
        </div>
        {campaigns.length > 0 && (
          <div>
            <label style={lbl}>Campaign</label>
            <select value={campaignId} onChange={e => setCampaignId(e.target.value)} style={fld}>
              <option value="">All Campaigns</option>
              {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          Assigns the highest-scored, oldest unassigned pending leads that aren’t already assigned.
        </div>
      </div>
    </Modal>
  )
}

// ── Supervisor team panel ──────────────────────────────────────────────────────
// What a supervisor sees that an agent doesn't: the whole floor at a glance — who
// holds how many leads, what's become of them, and who's actually at their desk —
// so distribution is a decision, not a guess. Lives in the right pane when no lead
// is open; refreshes live so it's never stale during a calling session.

interface TeamAgent {
  id: number; full_name: string; status: string; online: boolean
  assigned: number; pending: number; callbacks: number; converted: number
  called_today: number  // distinct LEADS in her book called today (lead-book progress)
  dials_today: number   // raw calls today (activity — repeats, support, inbound included)
}
interface TeamTotals { total: number; unassigned: number; pending: number; interested: number; callbacks: number; converted: number }

function presence(a: TeamAgent): { dot: string; label: string } {
  if (a.online && a.status === 'available') return { dot: GREEN, label: 'Online' }
  if (a.status === 'break') return { dot: AMBER, label: 'On Break' }
  return { dot: 'var(--txt3)', label: 'Offline' }
}

function TeamPanel({ campaignId }: { campaignId: string }) {
  const [agents, setAgents] = useState<TeamAgent[]>([])
  const [totals, setTotals] = useState<TeamTotals | null>(null)
  const [loading, setLoading] = useState(true)
  // A failed fetch must not read "No agents on the team yet" — that is a claim about
  // the floor, not about the request.
  const [teamErr, setTeamErr] = useState<string | null>(null)

  const load = useCallback(() => {
    const p = campaignId ? `?campaign_id=${campaignId}` : ''
    apiFetch<{ agents: TeamAgent[]; totals: TeamTotals }>(`/api/call-center/leads/team${p}`)
      .then(r => { setAgents(Array.isArray(r?.agents) ? r.agents : []); setTotals(r?.totals ?? null); setTeamErr(null) })
      .catch(e => setTeamErr(e.message ?? 'Failed to load the team'))
      .finally(() => setLoading(false))
  }, [campaignId])

  useEffect(() => { setLoading(true); load() }, [load])
  // A wallboard is only useful if it's live — poll on a timer and on call/CRM events.
  useEffect(() => { const t = setInterval(load, 15_000); return () => clearInterval(t) }, [load])
  useLiveData(load, { topics: ['calls', 'crm', 'cc_leads'] })

  const col: CSSProperties = { padding: '8px 10px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }
  const head: CSSProperties = { padding: '8px 10px', textAlign: 'right', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.03em', position: 'sticky', top: 0, background: 'var(--card)' }

  const totalCards: { label: string; value: number; color: string }[] = totals ? [
    { label: 'Total Leads', value: totals.total,      color: 'var(--txt)' },
    { label: 'Unassigned',  value: totals.unassigned, color: RED },
    { label: 'Pending',     value: totals.pending,    color: '#6B7280' },
    { label: 'Interested',  value: totals.interested, color: '#0D9488' },
    { label: 'Callbacks',   value: totals.callbacks,  color: AMBER },
    { label: 'Converted',   value: totals.converted,  color: GREEN },
  ] : []

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>groups</span>
          <span style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>Team</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: GREEN, background: `${GREEN}14`, padding: '2px 8px', borderRadius: RADIUS.full }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN }} /> Live
          </span>
        </div>
        {/* Floor totals */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {totalCards.map(c => (
            <div key={c.label} style={{ flex: '1 1 90px', textAlign: 'center', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '8px 4px' }}>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: c.color }}>{fmtCount(c.value)}</div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{c.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-agent workload */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {teamErr && <div style={{ padding: '12px 20px 0' }}><ErrBanner error={teamErr} onRetry={load} /></div>}
        {loading && agents.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
            <Spinner size={16} color={NAVY} /> Loading team…
          </div>
        ) : teamErr && agents.length === 0 ? null : agents.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt3)', fontSize: TEXT.base }}>No agents on the team yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...head, textAlign: 'left' }}>Agent</th>
                <th style={head}>Assigned</th>
                <th style={head}>Pending</th>
                <th style={head}>Called Today</th>
                <th style={head}>Converted</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => {
                const p = presence(a)
                return (
                  <tr key={a.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '8px 10px', textAlign: 'left' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span title={p.label} style={{ width: 8, height: 8, borderRadius: '50%', background: p.dot, flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.full_name}</div>
                          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{p.label}{a.callbacks ? ` · ${a.callbacks} callback${a.callbacks === 1 ? '' : 's'}` : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td style={col}>{fmtCount(a.assigned)}</td>
                    <td style={{ ...col, color: a.pending ? 'var(--txt)' : 'var(--txt3)' }}>{fmtCount(a.pending)}</td>
                    <td style={col}>
                      <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: a.called_today ? FW.bold : FW.medium, color: a.called_today ? NAVY : 'var(--txt3)' }}>{fmtCount(a.called_today)}</div>
                      {a.dials_today > 0 && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtCount(a.dials_today)} dial{a.dials_today === 1 ? '' : 's'}</div>}
                    </td>
                    <td style={{ ...col, color: a.converted ? GREEN : 'var(--txt3)' }}>{fmtCount(a.converted)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

// The agent's working position on this page — campaign/status/search filters, which
// page they're on, and the lead they were last on — kept in sessionStorage so leaving
// for another screen and coming back drops them exactly where they stopped instead of
// resetting to the top of an unfiltered list. Per-tab (sessionStorage) so two tabs don't
// fight, and it clears when the browser session ends.
const LEADS_VIEW_KEY = 'o3c_cc_leads_view'
interface LeadsView { campaignId: string; status: string; search: string; offset: number; selectedId: number | null }
function readLeadsView(): Partial<LeadsView> {
  try { return JSON.parse(sessionStorage.getItem(LEADS_VIEW_KEY) || '{}') } catch { return {} }
}
function writeLeadsView(v: LeadsView) {
  try { sessionStorage.setItem(LEADS_VIEW_KEY, JSON.stringify(v)) } catch { /* private mode / quota — non-fatal */ }
}

export default function CallCenterLeads() {
  // Restore the agent's last working position (read once on mount).
  const savedView = useRef(readLeadsView()).current

  const [leads, setLeads]         = useState<Lead[]>([])
  const [campaigns, setCampaigns] = useState<CCCampaign[]>([])
  const [agents, setAgents]       = useState<CCAgent[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [selected, setSelected]   = useState<Lead | null>(null)

  // Filters — seeded from the saved view so a return lands on the same slice.
  const [campaignId, setCampaignId] = useState(savedView.campaignId ?? '')
  const [status, setStatus]         = useState(savedView.status ?? '')
  const [search, setSearch]         = useState(savedView.search ?? '')

  // Pagination — real server-side paging, so a campaign of any size loads fully.
  const [offset, setOffset] = useState(savedView.offset ?? 0)
  const [total, setTotal]   = useState(0)
  // Status-breakdown totals for the KPI cards — computed server-side over the whole
  // filtered scope (NOT just the current page), so the cards show real figures.
  const [summary, setSummary] = useState<LeadSummary>(ZERO_SUMMARY)

  const isHead = isHeadRole()

  // Selection
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [assignAgentId, setAssignAgentId] = useState('')

  // Assign actions
  const [assigning, setAssigning]       = useState(false)
  const [distributing, setDistributing] = useState(false)
  const [distributeConfirm, setDistributeConfirm] = useState(false)
  // Supervisor opts to take an equal share of the leads to call herself. Off by
  // default — she distributes, she doesn't have to receive.
  const [includeSelf, setIncludeSelf] = useState(false)
  const [recalling, setRecalling]       = useState(false)
  const [recallConfirm, setRecallConfirm] = useState(false)
  const [importOpen, setImportOpen]     = useState(false)
  const [assignOpen, setAssignOpen]     = useState(false)

  const dq = useDebouncedValue(search, 300) // one request per pause, not per keystroke
  // silent: a background refresh must not blank the list underneath the agent —
  // and must not remount the log form they are typing into.
  // Overlapping loads are routine — live events on top of the 15s poll — so a slower
  // earlier response must not land last and paint a stale page over the current one.
  // Only the newest request may write to the view.
  const loadSeq = useRef(0)
  const load = useCallback(async (refreshSelected?: number, silent = false): Promise<Lead[]> => {
    const seq = ++loadSeq.current
    if (!silent) setLoading(true)
    setErr(null)
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (campaignId) p.set('campaign_id', campaignId)
    if (status)     p.set('status', status)
    if (dq)         p.set('search', dq)
    try {
      // The endpoint returns a paginated envelope {data,total}; tolerate a bare array
      // for safety in case of a stale build.
      const res = await apiFetch<{ data: Lead[]; total: number; summary?: LeadSummary } | Lead[]>(`/api/call-center/leads?${p}`)
      const fresh = Array.isArray(res) ? res : (res?.data ?? [])
      if (seq !== loadSeq.current) return fresh // superseded — a newer load owns the view
      setLeads(fresh)
      setTotal(Array.isArray(res) ? fresh.length : (res?.total ?? fresh.length))
      // Real totals from the server. Fall back to per-page counts only if an older
      // build didn't send them, so the cards degrade rather than vanish.
      setSummary(!Array.isArray(res) && res?.summary ? res.summary : {
        pending:       fresh.filter(l => l.status === 'pending').length,
        interested:    fresh.filter(l => l.status === 'interested').length,
        callbacks:     fresh.filter(l => l.status === 'callback').length,
        converted:     fresh.filter(l => l.status === 'converted').length,
        unassigned:    fresh.filter(l => !l.assigned_to).length,
        distributable: fresh.filter(l => !l.assigned_to && l.status === 'pending').length,
        recallable:    fresh.filter(l => l.assigned_to && l.status === 'pending').length,
      })
      if (refreshSelected !== undefined) {
        const updated = fresh.find(l => l.id === refreshSelected)
        setSelected(prev => updated ?? prev)
      }
      return fresh
    } catch (ex: any) {
      if (seq !== loadSeq.current) return []
      setErr(ex.message); return []
    }
    finally { if (seq === loadSeq.current) setLoading(false) }
  }, [campaignId, status, dq, offset])

  // Auto-advance: after logging a call on a lead, move straight to the next lead so an
  // agent works top-to-bottom without hunting. Past the end of a page it steps onto the
  // next one; only past the end of the LAST page has the agent been through the whole
  // assigned book, and only then does it wrap to the top and say so. If a status filter
  // is on, worked leads drop out on reload, so this walks down the shrinking pile.
  const advanceToTop = useRef(false) // open the top of the page being stepped onto
  async function handleAdvanceLead() {
    const prev = selected
    const prevList = leads
    const fresh = await load(undefined, true)
    let next: Lead | null = null
    if (prev) {
      const prevIdx = prevList.findIndex(l => l.id === prev.id)
      const below = prevIdx >= 0 ? prevList.slice(prevIdx + 1) : []
      for (const l of below) {
        const stillThere = fresh.find(x => x.id === l.id)
        if (stillThere) { next = stillThere; break }
      }
      // The worked lead itself dropped out (a status filter excluded it): take
      // whatever now sits where it was, so the list keeps flowing down.
      if (!next && prevIdx >= 0 && !fresh.find(x => x.id === prev.id)) {
        next = fresh[prevIdx] ?? null
      }
    }
    if (!next) {
      // The end of THIS page is not the end of the book: step onto the next page and
      // open its first lead. Choosing only from the 100 rows in front of it looped an
      // agent with 250 leads back to lead 1, and leads 101+ were never served at all.
      if (offset + PAGE_SIZE < total) { advanceToTop.current = true; setOffset(offset + PAGE_SIZE); return }
      // Genuinely through the whole book — wrap to the first page and say so.
      if (offset > 0) {
        advanceToTop.current = true
        setOffset(0)
        toast.success('Back to the top: you’ve been through this list once')
        return
      }
      next = fresh.find(l => l.id !== prev?.id) ?? null
      if (next) toast.success('Back to the top: you’ve been through this list once')
    }
    if (!next) { setSelected(null); return }  // list is empty / fully worked
    setSelected(next)
  }

  // The page the auto-advance stepped onto is loaded by the offset change, so opening
  // its first lead has to wait for that page to arrive.
  useEffect(() => {
    if (!advanceToTop.current || loading) return
    advanceToTop.current = false
    if (leads.length) setSelected(leads[0])
  }, [leads, loading])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(undefined, true), { topics: ['calls', 'crm', 'cc_leads'] })

  // Deep-link from the call-back popup: ?open=<leadId> selects that lead so the agent
  // lands straight on the call to make (its detail panel + log-call form).
  const [sp] = useSearchParams()
  const openId = sp.get('open')
  useEffect(() => {
    if (!openId || !leads.length) return
    const m = leads.find(l => String(l.id) === openId)
    if (m) setSelected(m)
  }, [openId, leads])

  // Restore the lead the agent was last on (once, after its page loads) so coming back
  // reopens the same lead. A ?open= deep-link takes precedence over the saved position.
  const restoredSel = useRef(false)
  useEffect(() => {
    if (restoredSel.current) return
    if (openId || savedView.selectedId == null) { restoredSel.current = true; return }
    if (!leads.length) return
    const m = leads.find(l => l.id === savedView.selectedId)
    if (m) setSelected(m)
    restoredSel.current = true // whether found or not, only attempt once
  }, [leads, openId, savedView.selectedId])

  // Persist the working position on every change, so it's current when they leave.
  useEffect(() => {
    writeLeadsView({ campaignId, status, search, offset, selectedId: selected?.id ?? null })
  }, [campaignId, status, search, offset, selected])

  // Filters change → back to the first page. Skips the initial mount so it doesn't
  // wipe a restored offset before the agent has touched anything.
  const filterFirstRun = useRef(true)
  useEffect(() => {
    if (filterFirstRun.current) { filterFirstRun.current = false; return }
    setOffset(0)
  }, [campaignId, status, dq])

  // These feed the campaign and agent pickers. A failure used to be swallowed, so the
  // picker came up empty and a supervisor read that as "no campaigns yet" rather than
  // "this didn't load". One toast each is proportionate — both fetch once, on mount.
  const loadCampaigns = useCallback(() => {
    apiFetch<CCCampaign[]>('/api/call-center/campaigns')
      .then(r => setCampaigns(Array.isArray(r) ? r : []))
      .catch((e: any) => toast.error(e?.message || 'Could not load campaigns'))
  }, [])

  useEffect(() => {
    loadCampaigns()
    apiFetch<CCAgent[]>('/api/call-center/agents')
      .then(r => setAgents(Array.isArray(r) ? r : []))
      .catch((e: any) => toast.error(e?.message || 'Could not load agents'))
  }, [loadCampaigns])

  // Silent: correcting a call mid-conversation must not blank the list to "Loading…".
  function handleRefresh() {
    load(selected?.id, true)
  }

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearChecked() {
    setCheckedIds(new Set())
    setAssignAgentId('')
  }

  // Keyboard access to the list. The rows were <div onClick> only, so an agent working
  // without a mouse could not reach a lead — and therefore could not log a call at all.
  // Up/Down walk the rows, Enter opens one. Arrowing deliberately doesn't open: every
  // open refetches that lead's call history and activity.
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  function onRowKey(e: React.KeyboardEvent, idx: number) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      rowRefs.current[idx + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSelected(leads[idx])
    }
  }
  // Roving tabIndex — one tab stop for the whole list, landing on the open lead.
  const rovingIdx = Math.max(0, leads.findIndex(l => l.id === selected?.id))

  async function handleAssign() {
    if (!assignAgentId || checkedIds.size === 0) return
    setAssigning(true)
    try {
      const res = await apiPost<{ assigned: number }>('/api/call-center/leads/bulk-assign', {
        lead_ids: [...checkedIds],
        agent_id: Number(assignAgentId),
      })
      const agentName = agents.find(a => a.id === Number(assignAgentId))?.full_name ?? 'agent'
      toast.success(`${res.assigned} lead(s) assigned to ${agentName}`)
      clearChecked()
      load()
    } catch (ex: any) {
      toast.error(ex.message ?? 'Assign failed')
    } finally {
      setAssigning(false)
    }
  }

  async function handleDistribute() {
    setDistributing(true)
    setDistributeConfirm(false)
    try {
      const body: Record<string, any> = {}
      if (campaignId) body.campaign_id = Number(campaignId)
      if (includeSelf) body.include_me = true
      const res = await apiPost<{ distributed: number; online_only?: boolean; breakdown: { agent_name: string; count: number }[] }>(
        '/api/call-center/leads/distribute', body
      )
      if (res.distributed === 0) {
        toast.info('No unassigned pending leads to distribute')
      } else {
        const summary = res.breakdown.map(b => `${b.agent_name}: ${b.count}`).join(', ')
        toast.success(`${res.distributed} leads distributed ${res.online_only ? 'to online agents' : '(nobody online, spread across all)'}: ${summary}`)
        load()
      }
      setIncludeSelf(false)
    } catch (ex: any) {
      toast.error(ex.message ?? 'Distribute failed')
    } finally {
      setDistributing(false)
    }
  }

  // Recall pulls handed-out but not-yet-worked (pending) leads back to the pool so the
  // supervisor can distribute again — e.g. after a bad round that landed on offline
  // agents. Only pending leads are recalled; anyone mid-conversation keeps their lead.
  async function handleRecall() {
    setRecalling(true)
    setRecallConfirm(false)
    try {
      const body: Record<string, any> = {}
      if (campaignId) body.campaign_id = Number(campaignId)
      const res = await apiPost<any>('/api/call-center/leads/recall', body)
      const d: any = (res as any)?.data ?? res
      if (!d.recalled) toast.info('No handed-out pending leads to recall')
      else toast.success(`${d.recalled} lead(s) recalled to the pool. Ready to redistribute`)
      load()
    } catch (ex: any) {
      toast.error(ex.message ?? 'Recall failed')
    } finally {
      setRecalling(false)
    }
  }

  // KPI cards read the server summary (whole scope), not the current page.
  const { pending, interested, callbacks, converted, unassigned, distributable, recallable } = summary

  const selectedCampaignName = campaigns.find(c => String(c.id) === campaignId)?.name ?? 'All Campaigns'

  return (
    <Page title="Leads" subtitle="Contacts pushed from email & SMS campaigns, or uploaded here" noPad
      actions={
        isHead ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
            <button onClick={() => setImportOpen(true)} title="Upload a lead list"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>upload_file</span>
              Upload Leads
            </button>
            <button onClick={() => setAssignOpen(true)} title="Assign a batch of leads to one agent"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: NAVY, color: '#fff', border: `1px solid ${NAVY}`, borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>assignment_ind</span>
              Assign to Agent
            </button>
          </div>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div style={{ width: 380, minWidth: 320, maxWidth: 420, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', background: 'var(--card)', flexShrink: 0 }}>
          {/* Header */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 10 }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', flex: 1 }}>Marketing Leads</span>
              <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '1px 7px', borderRadius: RADIUS['2xl'] }}>
                {fmtCount(total)}
              </span>
              {/* Recall + Distribute — heads/supervisors only. Recall pulls a bad
                  distribution back to the pool; Distribute hands the pool out. */}
              {isHead && (
              <button
                onClick={() => setRecallConfirm(true)}
                disabled={recalling || recallable === 0}
                title={recallable === 0 ? 'No handed-out pending leads to recall' : `Recall ${recallable} handed-out pending lead(s) to the pool`}
                style={{
                  display: 'flex', alignItems: 'center', gap: SP[1],
                  padding: '4px 9px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold,
                  border: `1px solid ${AMBER}40`, background: 'none',
                  color: recallable === 0 ? 'var(--txt3)' : AMBER,
                  cursor: recallable === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {recalling ? <Spinner size={12} color={AMBER} /> : (
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>undo</span>
                )}
                Recall
              </button>
              )}
              {/* Distribute button — heads/supervisors only. */}
              {isHead && (
              <button
                onClick={() => setDistributeConfirm(true)}
                disabled={distributing || distributable === 0}
                title={distributable === 0 ? 'No unassigned pending leads' : `Distribute ${distributable} unassigned pending lead(s) round-robin`}
                style={{
                  display: 'flex', alignItems: 'center', gap: SP[1],
                  padding: '4px 9px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold,
                  border: `1px solid ${NAVY}30`, background: 'none',
                  color: distributable === 0 ? 'var(--txt3)' : NAVY,
                  cursor: distributable === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {distributing ? <Spinner size={12} color={NAVY} /> : (
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>shuffle</span>
                )}
                Distribute
              </button>
              )}
            </div>

            {/* Mini stats */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[
                { label: 'Pending',    value: pending,    color: '#6B7280' },
                { label: 'Interested', value: interested, color: '#0D9488' },
                { label: 'Callbacks',  value: callbacks,  color: AMBER },
                { label: 'Converted',  value: converted,  color: GREEN },
                { label: 'Unassigned', value: unassigned, color: RED },
              ].map(s => (
                <div key={s.label} style={{ flex: 1, textAlign: 'center', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '6px 2px' }}>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Search */}
            <TblSearch value={search} onChange={setSearch}
              placeholder="Search name, phone…" width={0} style={{ marginBottom: SP[2] }} />

            {/* Campaign dropdown */}
            {campaigns.length > 0 && (
              <select value={campaignId} onChange={e => setCampaignId(e.target.value)}
                style={{ width: '100%', marginBottom: 6, padding: '6px 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none' }}>
                <option value="">All Campaigns</option>
                {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            )}

            {/* Status chips */}
            <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
              {[
                { value: 'pending',    label: 'Pending',       color: '#6B7280' },
                { value: 'interested', label: 'Interested',    color: '#0D9488' },
                { value: 'not_ready',  label: 'Not Ready Yet', color: '#6366F1' },
                { value: 'called',     label: 'Called',        color: BLUE },
                { value: 'callback',   label: 'Callback',      color: AMBER },
                { value: 'no_answer',  label: 'No Answer',     color: RED },
                { value: 'converted',  label: 'Converted',     color: GREEN },
                { value: 'dnc',        label: 'DNC',           color: PURPLE },
                // closed and invalid are set by the backend (a decline on our side, and
                // a bad number) — without chips those leads could never be filtered to.
                { value: 'closed',     label: 'Closed',        color: STATUS_COLOR.closed },
                { value: 'invalid',    label: 'Invalid',       color: STATUS_COLOR.invalid },
              ].map(({ value, label, color }) => {
                const on = status === value
                return (
                  <button key={value} onClick={() => setStatus(on ? '' : value)} style={{
                    fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full,
                    border: `1px solid ${on ? color : 'var(--bdr)'}`,
                    background: on ? `${color}18` : 'transparent',
                    color: on ? color : 'var(--txt3)', cursor: 'pointer',
                  }}>{label}</button>
                )
              })}
              {(status || search || campaignId) && (
                <button onClick={() => { setStatus(''); setSearch(''); setCampaignId('') }} style={{
                  fontSize: TEXT['2xs'], fontWeight: FW.medium, padding: '2px 8px', borderRadius: RADIUS.full,
                  border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt3)', cursor: 'pointer',
                }}>Clear</button>
              )}
            </div>
          </div>

          {/* Batch (re)assign bar — heads/supervisors only. */}
          {isHead && checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 10px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, whiteSpace: 'nowrap' }}>
                {checkedIds.size} selected
              </span>
              <select
                value={assignAgentId}
                onChange={e => setAssignAgentId(e.target.value)}
                style={{ flex: 1, padding: `${SP[1]} ${SP[2]}`, borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none', minWidth: 0 }}
              >
                <option value="">Assign To…</option>
                {agents.map(a => <option key={a.id} value={String(a.id)}>{a.full_name}</option>)}
              </select>
              <button
                onClick={handleAssign}
                disabled={!assignAgentId || assigning}
                style={{
                  padding: '4px 10px', borderRadius: RADIUS.sm, border: 'none',
                  background: !assignAgentId || assigning ? `${NAVY}40` : NAVY,
                  color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                  cursor: !assignAgentId || assigning ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {assigning && <Spinner size={11} color="#fff" />}
                Assign
              </button>
              <button
                onClick={clearChecked}
                style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%', flexShrink: 0 }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
              </button>
            </div>
          )}

          {/* onRetry is called with no argument on purpose: passing load straight in
              handed the click event to it as `refreshSelected`. */}
          {err && <div style={{ padding: '8px 14px' }}><ErrBanner error={err} onRetry={() => load()} /></div>}

          {/* Lead list — a listbox, so it can be worked from the keyboard */}
          <div role="listbox" aria-label="Marketing leads" style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : err ? null : leads.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: TEXT.base }}>
                No leads yet. Push contacts from a campaign report.
              </div>
            ) : leads.map((lead, idx) => {
              const isSelected = selected?.id === lead.id
              const isChecked  = checkedIds.has(lead.id)
              const oc = leadOutcomeColor(lead)
              return (
                <div
                  key={lead.id}
                  ref={el => { rowRefs.current[idx] = el }}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={idx === rovingIdx ? 0 : -1}
                  onClick={() => setSelected(lead)}
                  onKeyDown={e => onRowKey(e, idx)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 0,
                    borderBottom: '1px solid var(--bdr)', cursor: 'pointer',
                    background: isSelected ? `${NAVY}08` : undefined,
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                >
                  {/* Checkbox */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', padding: '12px 8px', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onClick={e => toggleCheck(lead.id, e)}
                      onChange={() => {}}
                      style={{ marginTop: 1, cursor: 'pointer', accentColor: NAVY }}
                    />
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 10px 2px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 3 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <NameCell name={lead.customer_name} sub={lead.customer_phone ?? undefined} avatar={false} />
                      </div>
                      <StatusPill status={lead.status} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {lead.campaign_name && (
                        <span style={{ fontSize: TEXT['2xs'], color: PURPLE }}>{lead.campaign_name}</span>
                      )}
                      {lead.agent_name ? (
                        <span style={{ fontSize: TEXT['2xs'], color: NAVY, fontWeight: FW.semibold }}>
                          <span className="material-symbols-rounded" style={{ fontSize: TEXT.xs, verticalAlign: 'middle' }}>person</span>
                          {' '}{lead.agent_name}
                        </span>
                      ) : (
                        <StatusPill status="unassigned" />
                      )}
                    </div>
                    {(lead.last_outcome || lead.last_called_at) && (
                      <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginTop: 3 }}>
                        {lead.last_outcome && (
                          <span style={{ fontSize: TEXT['2xs'], color: oc, fontWeight: FW.semibold }}>{leadOutcomeLabel(lead)}</span>
                        )}
                        {lead.last_called_at && (
                          <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(lead.last_called_at)}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Pagination — real server-side paging over the whole campaign */}
          {total > PAGE_SIZE && (
            <div style={{ flexShrink: 0, borderTop: '1px solid var(--bdr)', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>
                {fmtCount(offset + 1)}–{fmtCount(Math.min(offset + PAGE_SIZE, total))} of {fmtCount(total)}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: offset === 0 ? 'default' : 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', color: offset === 0 ? 'var(--txt3)' : 'var(--txt)', opacity: offset === 0 ? 0.5 : 1 }}>Prev</button>
                <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: offset + PAGE_SIZE >= total ? 'default' : 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', color: offset + PAGE_SIZE >= total ? 'var(--txt3)' : 'var(--txt)', opacity: offset + PAGE_SIZE >= total ? 0.5 : 1 }}>Next</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right panel ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {selected ? (
            <>
              {/* A supervisor works a lead, then steps back to the whole floor. */}
              {isHead && (
                <button onClick={() => setSelected(null)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start', margin: '8px 0 0 12px', padding: '4px 10px', border: '1px solid var(--bdr)', background: 'var(--card)', color: NAVY, borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>groups</span>
                  Back to Team
                </button>
              )}
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <DetailPanel key={selected.id} lead={selected} onRefresh={handleRefresh} onLogged={handleAdvanceLead} />
              </div>
            </>
          ) : isHead ? (
            // A supervisor's home on this page is the team, not a blank prompt.
            <TeamPanel campaignId={campaignId} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: SP[3], color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>contacts</span>
              <span style={{ fontSize: TEXT.md }}>Select a lead to log a call</span>
            </div>
          )}
        </div>
      </div>

      {/* Upload lead list — heads/supervisors */}
      <ImportLeadsModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} campaigns={campaigns} onCampaignCreated={loadCampaigns} />

      {/* Assign a batch of leads to one agent (heads) */}
      <AssignLeadsModal open={assignOpen} onClose={() => setAssignOpen(false)} onDone={load}
        agents={agents} campaigns={campaigns} defaultCampaignId={campaignId} />

      {/* Distribute confirm modal */}
      <ConfirmModal
        open={distributeConfirm}
        title="Distribute Leads Round-Robin"
        body={`Assign all ${distributable} unassigned pending lead(s) from "${selectedCampaignName}" evenly across the agents online right now?`}
        confirmLabel="Distribute"
        loading={distributing}
        onConfirm={handleDistribute}
        onClose={() => { setDistributeConfirm(false); setIncludeSelf(false) }}
      >
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
          fontSize: TEXT.sm, fontWeight: FW.semibold, lineHeight: 1.4,
          padding: '9px 11px', borderRadius: RADIUS.md,
          border: `1px solid ${includeSelf ? NAVY : 'var(--bdr)'}`,
          background: includeSelf ? `${NAVY}0c` : 'transparent',
          color: includeSelf ? NAVY : 'var(--txt2)',
        }}>
          <input type="checkbox" checked={includeSelf} onChange={e => setIncludeSelf(e.target.checked)}
            style={{ marginTop: 1, accentColor: NAVY, cursor: 'pointer', flexShrink: 0 }} />
          <span>Include Me as a Caller
            <span style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt3)' }}>
              I take an equal share of the leads to call myself
            </span>
          </span>
        </label>
      </ConfirmModal>

      {/* Recall confirm modal — undo a distribution */}
      <ConfirmModal
        open={recallConfirm}
        title="Recall Leads to the Pool"
        body={`Pull all ${recallable} handed-out but not-yet-worked (pending) lead(s) from "${selectedCampaignName}" back to the unassigned pool so you can distribute again? Leads already being worked (called, callback, converted) keep their agent.`}
        confirmLabel="Recall"
        loading={recalling}
        onConfirm={handleRecall}
        onClose={() => setRecallConfirm(false)}
      />
    </Page>
  )
}
