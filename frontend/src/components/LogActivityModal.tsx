// LogActivityModal — the manual "log an activity" surface for the workspace activity
// stream (POST /api/activities). Lets an agent record what isn't a phone call: a note,
// a document collected, a hand-off to another team, or a follow-up — against a lead,
// contact, customer (CIF) or application. Kept generic so it drops onto the Leads page,
// Customer 360, or any team's detail view with the right anchor.
//
// Each type is a different KIND of record with a different consequence, and the form
// says so rather than offering one subject/body box for all four:
//   • Note      — written down, nothing else happens.
//   • Hand Off  — the receiving team is notified and it stays open until they answer.
//   • Document  — the file is stored against the person and opens from the timeline.
//   • Follow-Up — a real crm_task with an owner and a due date, not a task-shaped note.
//
// Sales is deliberately absent from the hand-off team list: a lead goes to Sales through
// the pane's stage-gated, supervisor-approved Forward to Sales flow, which creates the
// record Sales actually works from. Two paths with different rules meant two truths.

import { useEffect, useRef, useState } from 'react'
import { Modal } from './UI'
import { apiFetch, apiPost } from '../lib/api'
import { NAVY, RADIUS, TEXT, FW, SP, RED, GREEN, AMBER, INTER } from '../lib/design'
import { fmtDate } from '../lib/fmt'
import { toast } from 'sonner'

// Whatever anchors the caller has — send all that apply; the row is matched by them.
export interface LogActivityAnchor {
  lead_id?: number
  contact_id?: number
  cif?: string
  application_id?: number
  phone?: string
}

type ActType = 'note' | 'step' | 'handoff' | 'document' | 'task'

const TYPES: { v: ActType; label: string; icon: string; blurb: string }[] = [
  // First, because it is the one agents were missing. They had been editing old call logs
  // to record later developments — 43 calls had their outcome overwritten days after the
  // call, one of them Interested → Converted — because there was no way to say "this has
  // happened since". This is that way.
  { v: 'step',     label: 'Step',      icon: 'timeline',      blurb: 'Where this customer has got to. Dated when it happened, and it leaves the call logs alone.' },
  { v: 'note',     label: 'Note',      icon: 'sticky_note_2', blurb: 'Written to the timeline. Nobody is notified.' },
  { v: 'handoff',  label: 'Hand Off',  icon: 'swap_horiz',    blurb: 'The team is notified and it stays open until they answer.' },
  { v: 'document', label: 'Document',  icon: 'description',   blurb: 'Stored against this person and opens from the timeline.' },
  { v: 'task',     label: 'Follow-Up', icon: 'task_alt',      blurb: 'A real task in your queue, due on the date you set.' },
]

// What the dialog opens on.
//
// Step, for two reasons. It is the FIRST tile, and a selector whose highlighted option is
// not the one the body is showing reads as a glitch — the tiles said Step while the form
// said Note. And it is the action agents were missing: they were rewriting old call logs
// to record later developments because there was nowhere to say "this happened since", so
// the form should open on the answer rather than make them go and find it.
//
// Safe to open on: a step cannot be submitted until one is chosen and dated, so nothing is
// recorded by merely landing here. A caller meaning something else passes initialType —
// CallLogEditModal opens onto 'step' explicitly, and a note-first surface can ask for 'note'.
const DEFAULT_TYPE: ActType = 'step'

// The journey vocabulary comes from the API (GET /api/customer-steps) rather than being
// duplicated here. The call-centre disposition list was defined twice and the two copies
// had drifted apart before anyone noticed.
interface CustomerStep {
  code: string
  label: string
  hint: string
  needs_note?: boolean
  terminal?: boolean
  won?: boolean
}

// Sales is handled by Forward to Sales — see the file header.
const TEAMS: { v: string; label: string }[] = [
  { v: 'risk', label: 'Risk' }, { v: 'finance', label: 'Finance' },
  { v: 'ops', label: 'Operations' }, { v: 'collections', label: 'Collections' },
  { v: 'recovery', label: 'Recovery' }, { v: 'care', label: 'Customer Care' },
]

// The documents this business actually collects. Free text here meant the same payslip
// was filed four ways and no one could report on what was outstanding.
const DOC_TYPES = [
  'ID Card / NIN', 'Passport Photograph', 'Payslip', 'Bank Statement',
  'Employment Letter', 'Utility Bill', 'Signed Mandate', 'Other',
]

// The backend parses a 20MB multipart form; anything larger fails after the whole file
// has been pushed up the wire, so refuse it here where the agent can still do something.
const MAX_MB = 20
const OK_EXT = /\.(pdf|png|jpe?g|webp|heic|doc|docx|xls|xlsx|csv|txt)$/i

// A date input wants YYYY-MM-DD in local time — toISOString() would shift a Lagos
// afternoon into the previous day for anyone west of UTC.
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d) }

export default function LogActivityModal({ open, anchor, onClose, onSaved, about, initialType, callId }: {
  open: boolean
  anchor: LogActivityAnchor
  onClose: () => void
  onSaved: () => void
  about?: string   // who this is about, shown in the dialog title
  // Which tab to open on. The call-log edit form opens straight onto 'step' when it turns
  // an agent away from rewriting a call, so the alternative is one click and not a hunt.
  initialType?: ActType
  // The call a step followed from, so the timeline can show the conversation and what came
  // of it as one thread rather than two unrelated rows.
  callId?: number
}) {
  const [type, setType]       = useState<ActType>(initialType ?? DEFAULT_TYPE)
  const [targetTeam, setTeam] = useState('risk')
  const [subject, setSubject] = useState('')
  const [body, setBody]       = useState('')
  const [docType, setDocType] = useState(DOC_TYPES[0])
  const [file, setFile]       = useState<File | null>(null)
  const [dueDate, setDue]     = useState(addDays(1))
  const [urgent, setUrgent]   = useState(false)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)
  // type=step: which step, and when it actually happened (usually not today — an agent
  // records Friday's branch visit on Monday).
  const [steps, setSteps]     = useState<CustomerStep[]>([])
  const [stepCode, setStep]   = useState('')
  const [stepOn, setStepOn]   = useState(isoDate(new Date()))
  // step code -> the date it is already on the record for this customer.
  const [done, setDone]       = useState<Record<string, string>>({})
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const isHandoff  = type === 'handoff'
  const isDocument = type === 'document'
  const isTask     = type === 'task'
  const isStep     = type === 'step'
  const step       = steps.find(s => s.code === stepCode)

  // Reopening the dialog on another person must not inherit the last one's half-typed
  // note — the anchor changed, so everything anchored to it is stale.
  useEffect(() => {
    if (!open) return
    setType(initialType ?? DEFAULT_TYPE); setTeam('risk'); setSubject(''); setBody('')
    setDocType(DOC_TYPES[0]); setFile(null); setDue(addDays(1)); setUrgent(false)
    setStep(''); setStepOn(isoDate(new Date()))
    setErr(null); setSaving(false)
  }, [open, anchor.lead_id, anchor.contact_id, anchor.cif, anchor.phone])

  // Fetched once the dialog is open, and only once: the vocabulary does not change while
  // an agent is typing. A failure leaves the list empty, which validate() then reports as
  // plainly as it can — better than silently offering nothing and looking broken.
  useEffect(() => {
    if (!open || steps.length > 0) return
    let cancelled = false
    apiFetch<{ data: CustomerStep[] }>('/api/customer-steps')
      .then(r => { if (!cancelled) setSteps(r?.data ?? []) })
      .catch(() => { if (!cancelled) setSteps([]) })
    return () => { cancelled = true }
  }, [open, steps.length])

  // Where this customer has already got to.
  //
  // Without it an agent is picking from eleven steps with no idea which are already on the
  // record, so the same step gets logged twice and the journey reads backwards. Loaded
  // only when the Step tab is actually open, so the common note/hand-off case pays nothing
  // for it. A failure is silent: not knowing the history is a worse form the agent can
  // still use, not an error worth blocking them with.
  useEffect(() => {
    if (!open || !isStep) return
    const q = anchor.lead_id ? `lead_id=${anchor.lead_id}`
      : anchor.contact_id ? `contact_id=${anchor.contact_id}`
      : anchor.cif ? `cif=${encodeURIComponent(anchor.cif)}`
      : anchor.phone ? `phone=${encodeURIComponent(anchor.phone)}`
      : ''
    if (!q) return
    let cancelled = false
    apiFetch<{ data: { type: string; outcome: string | null; occurred_at: string }[] }>(`/api/activities?${q}`)
      .then(r => {
        if (cancelled) return
        const seen: Record<string, string> = {}
        for (const a of r?.data ?? []) {
          if (a.type !== 'step' || !a.outcome) continue
          // Keep the most recent date per step, so a step recorded twice shows the latest.
          if (!seen[a.outcome] || a.occurred_at > seen[a.outcome]) seen[a.outcome] = a.occurred_at
        }
        setDone(seen)
      })
      .catch(() => { if (!cancelled) setDone({}) })
    return () => { cancelled = true }
  }, [open, isStep, anchor.lead_id, anchor.contact_id, anchor.cif, anchor.phone])

  // Changing type changes what is being asked for; a validation error about the old
  // form would sit there accusing a field that is no longer on screen.
  useEffect(() => { setErr(null) }, [type])

  function validate(): string | null {
    if (isHandoff) {
      if (!subject.trim()) return 'Say what you are handing over.'
      return null
    }
    if (isDocument) {
      if (file) {
        if (file.size > MAX_MB * 1024 * 1024) return `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_MB}MB.`
        if (!OK_EXT.test(file.name)) return 'Attach a PDF, image, Office document or CSV.'
      }
      return null
    }
    if (isTask) {
      if (!subject.trim()) return 'Give the follow-up a title. It is what you will see in your queue.'
      if (!dueDate)        return 'A follow-up needs a date, or it is just a note.'
      return null
    }
    if (isStep) {
      if (steps.length === 0) return 'The step list could not be loaded. Close this and try again.'
      if (!step)              return 'Pick where this customer has got to.'
      if (!stepOn)            return 'Say when it happened. A step with no date cannot be put in order.'
      // A future date is how a mistyped year pins a step to the top of every timeline
      // for ever. The server refuses it too.
      if (stepOn > isoDate(new Date())) return 'That date is in the future. Record a step once it has actually happened.'
      // Only "Dropped Off" demands prose, and it is the only place a churn reason is ever
      // captured — a drop-off nobody explained records that we lost someone and teaches
      // us nothing.
      if (step.needs_note && body.trim().length < 15) {
        return `"${step.label}" needs a short reason. It is the only place we ever capture it.`
      }
      return null
    }
    if (!subject.trim() && !body.trim()) return 'Add a subject or a note.'
    return null
  }

  async function submit() {
    const problem = validate()
    if (problem) { setErr(problem); firstFieldRef.current?.focus(); return }
    setErr(null)
    if (isDocument && file) { await uploadDocument(); return }
    setSaving(true)
    try {
      const res = await apiPost<{ id: number; notified?: number }>('/api/activities', {
        ...anchor,
        type,
        // A step's subject is derived server-side from its code, so two spellings of the
        // same step cannot end up on one timeline.
        subject: isDocument ? `Document collected: ${docType}` : isStep ? '' : subject.trim(),
        body: body.trim(),
        // The step code is the authoritative field; `outcome` is where the server reads it.
        outcome: isStep ? step?.code : undefined,
        // Midday local, so the step sorts inside the day it happened rather than at
        // midnight, which reads as the day before in a timeline grouped by date.
        occurred_at: isStep ? new Date(`${stepOn}T12:00:00`).toISOString() : undefined,
        // Links the step to the call it followed from, when the caller knows it.
        call_id: isStep ? callId : undefined,
        target_team: isHandoff ? targetTeam : undefined,
        // A follow-up is a real task: due by close of business on the day chosen, so it
        // is not born overdue the way a bare midnight date would be.
        due_at:   isTask ? `${dueDate}T17:00:00` : undefined,
        priority: isTask ? (urgent ? 'urgent' : 'medium') : undefined,
      })
      if (isHandoff) {
        const team = TEAMS.find(t => t.v === targetTeam)?.label ?? targetTeam
        const n = res?.notified ?? 0
        if (n > 0) toast.success(`Handed to ${team}: ${n} ${n === 1 ? 'person' : 'people'} notified`)
        else toast.warning(`Handed to ${team}, but nobody on that team is set up to be notified. It is waiting in their hand-off inbox`)
      } else if (isTask) {
        toast.success(`Follow-up set for ${fmtDate(dueDate)}`)
      } else if (isStep) {
        toast.success(`${step?.label} recorded for ${fmtDate(stepOn)}`)
      } else {
        toast.success('Activity logged')
      }
      onSaved()
    } catch (e: any) {
      const msg = e?.message || 'Could not log activity'
      setErr(msg); toast.error(msg)
    } finally { setSaving(false) }
  }

  // A document upload is multipart, not JSON — mirrors the LOS document upload (Bearer
  // token + FormData). It stores the file against the lead/contact and emits the activity.
  // The note travels with it: it used to be collected here and silently dropped.
  async function uploadDocument() {
    if (!file) return
    setSaving(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('doc_type', docType)
      form.append('note', body.trim())
      if (anchor.lead_id != null) form.append('lead_id', String(anchor.lead_id))
      if (anchor.contact_id != null) form.append('contact_id', String(anchor.contact_id))
      if (anchor.cif) form.append('cif', anchor.cif)
      if (anchor.phone) form.append('phone', anchor.phone)
      const token = localStorage.getItem('o3c_token') ?? ''
      const res = await fetch('/api/activities/document', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error || e?.detail || 'Upload failed') }
      toast.success(`${docType} uploaded`)
      onSaved()
    } catch (e: any) {
      const msg = e?.message || 'Could not upload the document'
      setErr(msg); toast.error(msg)
    } finally { setSaving(false) }
  }

  const field: React.CSSProperties = {
    width: '100%', padding: '9px 11px', border: `1px solid ${err ? `${RED}66` : 'var(--input-bdr)'}`,
    borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: INTER, outline: 'none', boxSizing: 'border-box',
  }
  const label: React.CSSProperties = {
    fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5,
  }
  const chip = (on: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', minHeight: 32,
    borderRadius: RADIUS.full, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? NAVY : 'var(--card)',
    color: on ? '#fff' : 'var(--txt2)', fontFamily: INTER, transition: 'var(--transition-fast)',
  })

  const blurb = TYPES.find(t => t.v === type)?.blurb ?? ''
  const primaryLabel = saving ? 'Saving…'
    : isHandoff ? `Hand Off to ${TEAMS.find(t => t.v === targetTeam)?.label ?? 'Team'}`
    : isDocument ? (file ? 'Upload Document' : 'Log Document Collected')
    : isTask ? 'Set Follow-Up'
    // Names the step being recorded, so the agent confirms the thing itself rather than
    // a generic verb, and sees their choice once more before it is written.
    : isStep ? (step ? `Record: ${step.label}` : 'Record Step')
    : 'Log Note'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={about ? (isStep ? `Record a Step: ${about}` : `Log an Activity: ${about}`) : isStep ? 'Record a Step' : 'Log an Activity'}
      width={isStep ? 580 : 520}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ flex: 1, fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Ctrl + Enter to save</span>
          <button onClick={onClose} disabled={saving}
            style={{ padding: '9px 16px', minHeight: 40, borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
                     background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold,
                     cursor: saving ? 'default' : 'pointer', fontFamily: INTER }}>
            Cancel
          </button>
          <button onClick={submit} disabled={saving}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                     padding: '9px 18px', minHeight: 40, background: saving ? `${NAVY}80` : NAVY, color: '#fff',
                     border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.bold,
                     cursor: saving ? 'not-allowed' : 'pointer', fontFamily: INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>
              {isHandoff ? 'swap_horiz' : isDocument && file ? 'upload_file' : isTask ? 'task_alt' : isStep ? 'timeline' : 'check'}
            </span>
            {primaryLabel}
          </button>
        </div>
      }
    >
      <div
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit() } }}
        style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}
      >
        {/* What kind of record this is — and what it will do.
            Tiles rather than pills: these are five genuinely different acts with
            different consequences, and the choice deserves the weight. Equal-width and
            single-row so the set reads as one control, and the consequence line below
            holds its height so the form does not jump as you move across them. */}
        <div>
          <div style={{ display: 'grid', // auto-fit so the row wraps to two lines at phone width instead of squeezing
            // "Follow-Up" and "Document" into an ellipsis.
            gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))', gap: 6 }}>
            {TYPES.map(t => {
              const on = type === t.v
              return (
                <button
                  key={t.v} type="button" onClick={() => setType(t.v)} aria-pressed={on}
                  title={t.blurb}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    padding: '9px 4px 8px', borderRadius: RADIUS.md, cursor: 'pointer',
                    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`,
                    background: on ? `${NAVY}0F` : 'var(--card)',
                    color: on ? NAVY : 'var(--txt2)',
                    fontFamily: INTER, fontSize: TEXT['2xs'], fontWeight: on ? FW.bold : FW.semibold,
                    transition: 'var(--transition-fast)', minWidth: 0,
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 19 }}>{t.icon}</span>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                    {t.label}
                  </span>
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 8, lineHeight: 1.45, minHeight: 34 }}>
            {blurb}
          </div>
        </div>

        {isHandoff && (
          <div>
            <label style={label} htmlFor="la-team">Hand Off To</label>
            <select id="la-team" value={targetTeam} onChange={e => setTeam(e.target.value)} style={field}>
              {TEAMS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 4 }}>
              Going to Sales? Use Forward to Sales on the lead instead. It carries the approval.
            </div>
          </div>
        )}

        {isDocument ? (
          <div>
            <label style={label} htmlFor="la-doctype">Document</label>
            <select id="la-doctype" value={docType} onChange={e => setDocType(e.target.value)} style={field}>
              {DOC_TYPES.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        ) : isStep ? (
          // A step is picked, not typed: a free-text box asks the agent to invent the
          // structure, which is why type='note' had one row in the whole table. The
          // wording of each option comes from the server.
          // And it is picked off a RAIL rather than a dropdown, because the journey is
          // genuinely a sequence: the order carries information the agent needs. The rail
          // also marks what is ALREADY on the record, which a dropdown cannot — without
          // that, eleven identical-looking options get logged twice and the timeline reads
          // backwards. The connector line and the ordering are content, not decoration.
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
            <div>
              <label style={label}>Where Have They Got To?</label>
              {steps.length === 0 ? (
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', padding: '10px 0' }}>Loading the journey…</div>
              ) : (
                <div role="radiogroup" aria-label="Customer step" style={{ display: 'flex', flexDirection: 'column' }}>
                  {steps.map((s, i) => {
                    const on      = s.code === stepCode
                    const already = done[s.code]
                    const last    = i === steps.length - 1
                    // A terminal step ends the relationship AND closes the outbound
                    // contact, so it is coloured by what it means: a win green, a loss red,
                    // everything mid-journey the house navy.
                    const accent  = !s.terminal ? NAVY : s.won ? GREEN : RED
                    return (
                      <button
                        key={s.code} type="button" role="radio" aria-checked={on}
                        onClick={() => { setStep(s.code); setErr(null) }}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
                          padding: '8px 11px 8px 9px', borderRadius: RADIUS.md, cursor: 'pointer',
                          border: `1px solid ${on ? accent : 'transparent'}`,
                          background: on ? `${accent}0F` : 'transparent',
                          textAlign: 'left', fontFamily: INTER, transition: 'var(--transition-fast)',
                          // A terminal step is a different kind of act, so it is set apart
                          // rather than sitting flush with the steps that carry on.
                          marginTop: s.terminal && !steps[i - 1]?.terminal ? 7 : 0,
                        }}
                      >
                        {/* The rail. The connector is what makes this read as one sequence
                            rather than a list of unrelated choices. */}
                        <span style={{ position: 'relative', flex: '0 0 auto', width: 18, display: 'flex', justifyContent: 'center', paddingTop: 2 }}>
                          {!last && (
                            <span aria-hidden style={{
                              position: 'absolute', top: 18, left: '50%', width: 1, height: 'calc(100% - 4px)',
                              background: 'var(--bdr)', transform: 'translateX(-0.5px)',
                            }} />
                          )}
                          <span style={{
                            position: 'relative', width: 16, height: 16, borderRadius: RADIUS.full,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            border: `1.5px solid ${already || on ? accent : 'var(--bdr)'}`,
                            background: already ? accent : 'var(--card)', color: '#fff', flex: '0 0 auto',
                          }}>
                            {already && <span className="material-symbols-rounded" style={{ fontSize: 11 }}>check</span>}
                            {!already && on && <span style={{ width: 6, height: 6, borderRadius: RADIUS.full, background: accent }} />}
                          </span>
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: TEXT.sm, fontWeight: on ? FW.bold : FW.semibold, color: on ? accent : 'var(--txt)' }}>
                              {s.label}
                            </span>
                            {/* Already on the record, with its date. This is the thing a
                                dropdown could not show, and the reason steps got logged twice. */}
                            {already && (
                              <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
                                recorded {fmtDate(already.slice(0, 10))}
                              </span>
                            )}
                          </span>
                          {/* Shown for the selected step only, so the rail stays scannable
                              while the commitment is never a guess. */}
                          {on && (
                            <span style={{ display: 'block', fontSize: TEXT['2xs'], color: 'var(--txt2)', marginTop: 3, lineHeight: 1.45 }}>
                              {s.hint}
                              {s.terminal && ' This ends the journey, so it also stops any further calls to them.'}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <div>
              <label style={label} htmlFor="la-step-on">When Did It Happen?</label>
              <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
                <input id="la-step-on" type="date" value={stepOn} max={isoDate(new Date())}
                  onChange={e => { setStepOn(e.target.value); setErr(null) }}
                  style={{ ...field, width: 'auto', flex: '0 1 170px' }} />
                {[['Today', addDays(0)], ['Yesterday', addDays(-1)]].map(([l, v]) => (
                  <button key={l} type="button" onClick={() => { setStepOn(v); setErr(null) }}
                    style={{ ...chip(stepOn === v), padding: '4px 11px', minHeight: 30, fontSize: TEXT.xs }}>{l}</button>
                ))}
              </div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 5 }}>
                The date it actually happened, not today. It is what puts this in the right
                place on their timeline.
              </div>
            </div>
          </div>
        ) : (
          <div>
            <label style={label} htmlFor="la-subject">
              {isHandoff ? 'What Are You Handing Over?' : isTask ? 'Follow-Up' : 'Subject'}
            </label>
            <input
              id="la-subject" ref={firstFieldRef} value={subject} onChange={e => setSubject(e.target.value)}
              placeholder={
                isHandoff ? 'e.g. Credit card application. Documents attached'
                : isTask  ? 'e.g. Call back after payday to confirm the limit'
                : 'Short summary'
              }
              style={field}
            />
          </div>
        )}

        {isTask && (
          <div style={{ display: 'flex', gap: SP[3], flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 180px' }}>
              <label style={label} htmlFor="la-due">Due</label>
              <input id="la-due" type="date" value={dueDate} min={isoDate(new Date())}
                onChange={e => setDue(e.target.value)} style={field} />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {[['Today', addDays(0)], ['Tomorrow', addDays(1)], ['Next Week', addDays(7)]].map(([l, v]) => (
                  <button key={l} onClick={() => setDue(v)} style={{ ...chip(dueDate === v), padding: '3px 9px', minHeight: 26, fontSize: TEXT['2xs'] }}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{ flex: '0 0 auto', paddingBottom: 2 }}>
              <label style={label}>Priority</label>
              <button onClick={() => setUrgent(u => !u)} aria-pressed={urgent} style={chip(urgent)}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>priority_high</span>
                {urgent ? 'Urgent' : 'Normal'}
              </button>
            </div>
          </div>
        )}

        {isDocument && (
          <div>
            <label style={label} htmlFor="la-file">File (Optional: Attach The Document)</label>
            <input id="la-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx,.csv,.txt"
              onChange={e => { setFile(e.target.files?.[0] ?? null); setErr(null) }}
              style={{ ...field, padding: '7px 10px' }} />
            {file
              ? <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>{file.name} · {(file.size / 1024).toFixed(0)} KB</div>
              : <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 4 }}>No file? It is logged as a note that the document was collected.</div>}
          </div>
        )}

        <div>
          <label style={label} htmlFor="la-body">
            {isTask ? 'Details (Optional)'
              : isDocument ? 'Note (Optional)'
              // Only Dropped Off requires it, and saying so is what stops the field being
              // treated as optional on the one step where it is the whole point.
              : isStep ? (step?.needs_note ? 'Why Did They Drop Off?' : 'Details (Optional)')
              : 'Details'}
          </label>
          <textarea
            id="la-body" spellCheck rows={isTask || isDocument ? 3 : 4} value={body} onChange={e => setBody(e.target.value)}
            placeholder={
              isHandoff ? 'Context for whoever picks this up'
              : isStep && step?.needs_note ? 'The reason they withdrew — this is the only place we ever capture it'
              : isStep ? 'Anything worth knowing about this step'
              : 'Context for whoever reads this next'
            }
            style={{ ...field, resize: 'vertical' }}
          />
        </div>

        {err && (
          <div role="alert" style={{
            display: 'flex', alignItems: 'flex-start', gap: 7, padding: '8px 11px', borderRadius: RADIUS.md,
            background: `${RED}0E`, border: `1px solid ${RED}33`, color: RED, fontSize: TEXT.sm,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16, marginTop: 1 }}>error</span>
            <span>{err}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
