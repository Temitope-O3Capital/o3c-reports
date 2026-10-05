// SalesActivityModal — the one place Sales records what happened.
//
// It replaces four separate dialogs that all called themselves "Log Activity": two
// components literally named LogActivityModal (one inside MyDay, one inside
// MyDashboard) and two more written inline in Leads and ContactDetail. They looked
// different, asked for different fields, and posted to three different endpoints.
//
// Two of them posted to /api/crm/activities, which writes crm_activities and is gated
// on the crm_* pages. A sales officer holds `sales`, not those, so every one of those
// saves was refused with a 403 before it reached the database: crm_activities held 0
// rows against app.activities' 33,341. Anything an officer logged from My Dashboard or
// a contact's page was lost, and never reached the Customer 360 timeline, the hand-off
// inbox, or the step history. Everything here goes to the sales endpoints, which write
// the shared stream through LogActivity().
//
// THE IDEA THAT MAKES THIS ONE DIALOG RATHER THAN TWO. From the officer's side, moving
// a lead forward and recording a call are the same act — saying what happened. It is
// only the system that treats them as different things. So both live in one list, in
// journey order, and the dialog states the consequence of the choice before it is
// committed: "Moves Adaeze from Contacted to Interested", or "Goes on the timeline.
// Adaeze stays at Contacted." The old Leads dialog offered a bare dropdown of kinds
// with no indication which of them would move the lead.
//
// The rail also mirrors the server's rules rather than discovering them by rejection:
// logLeadActivity refuses a stage at or behind the current one, so those are rendered
// as already passed and cannot be picked. A 409 explaining that you cannot move
// backwards is a worse way to learn it than never being offered the move.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Input, Textarea, Button, Spinner } from './UI'
import { SelectMenuField } from './SelectMenu'
import { apiFetch, apiPost } from '../lib/api'
import { useDebouncedValue } from '../hooks/useDebounce'
import { NAVY, GREEN, AMBER, RED, BLUE, RADIUS, TEXT, FW, SP, INTER } from '../lib/design'
import { fmtDate } from '../lib/fmt'
import { leadStageLabel } from '../lib/leadStages'
import { toast } from 'sonner'

// ── Dispositions ─────────────────────────────────────────────────────────────
//
// Served by GET /api/sales/activity/dispositions, keyed by activity kind. The shape
// mirrors salesDisposition in backend-go/handlers/sales_activity.go; the two rules that
// matter here (needs_note, needs_follow_up) are enforced in BOTH places on purpose — the
// browser so the officer is told before they lose their typing, the server because a rule
// enforced only in the browser is not enforced.
interface Disposition {
  code: string
  label: string
  hint: string
  needs_note?: boolean
  needs_follow_up?: boolean
  qualifies?: boolean
  closes?: boolean
  /** The stage this outcome puts a linked lead in. Empty ⇒ it decides nothing about the
   *  stage, which is what "No Answer" should do. Read here so the consequence sentence can
   *  name the move before the officer commits, rather than reporting it afterwards. */
  advances?: string
}

/** Local date-time for an <input type="datetime-local">, which has no timezone. */
function localDateTimeValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── The lead journey ──────────────────────────────────────────────────────────
//
// Mirrors leadActivityStage / leadStageShown / leadStageOrder in
// backend-go/handlers/sales_leads.go. Kept in journey order, because the order is the
// information: it is what tells an officer that Documents Requested comes after Handed
// to Sales, which a dropdown sorted by nothing in particular never did.

interface JourneyStep {
  /** The stage stored on crm_contacts.lead_stage. */
  stage: string
  label: string
  /** The activity kind that moves a lead INTO this stage; absent = not reachable here. */
  kind?: string
  /** Shown under the step once it is selected, so the commitment is never a guess. */
  hint?: string
}

const JOURNEY: JourneyStep[] = [
  { stage: 'new',                   label: 'New' },
  { stage: 'contacted',             label: 'Contacted' },
  { stage: 'qualified',             label: 'Interested',             kind: 'interested',            hint: 'They have said yes in principle. This is the step that qualifies the lead.' },
  { stage: 'handed_to_sales',       label: 'Handed to Sales',        kind: 'handed_to_sales',       hint: 'Passed to a sales officer to carry forward.' },
  { stage: 'documents_requested',   label: 'Documents Requested',    kind: 'documents_requested',   hint: 'You have asked them for what you need to proceed.' },
  { stage: 'application_submitted', label: 'Application Submitted',  kind: 'application_submitted', hint: 'Their application is in and with the credit team.' },
  { stage: 'approved',              label: 'Approved',               kind: 'approved',              hint: 'Credit has approved it. Convert the lead once it is booked.' },
]

const STAGE_ORDER: Record<string, number> = JOURNEY.reduce(
  (m, s, i) => ({ ...m, [s.stage]: i }), {} as Record<string, number>,
)

// A lead that has converted or been disqualified is closed: the server refuses every
// forward move on it, so the dialog offers only the record-only kinds and says why.
const CLOSED_STAGES: Record<string, string> = {
  converted: 'Converted',
  disqualified: 'Disqualified',
}

// Record-only kinds. These never touch the stage — the server's leadActivityStage map
// has no entry for them — and the dialog says so rather than leaving it ambiguous.
const RECORD_KINDS: { kind: string; label: string; icon: string }[] = [
  { kind: 'call',    label: 'Call',    icon: 'call' },
  { kind: 'meeting', label: 'Meeting', icon: 'groups' },
  { kind: 'email',   label: 'Email',   icon: 'mail' },
  { kind: 'note',    label: 'Note',    icon: 'sticky_note_2' },
]

// What an officer can log against their own day rather than against a lead. Matches
// salesActivityTypes in backend-go/handlers/sales_activity.go.
const DAY_KINDS: { kind: string; label: string; icon: string; blurb: string }[] = [
  { kind: 'visit',   label: 'Visit',   icon: 'directions_walk', blurb: 'You went somewhere. Record where — it is what makes a field day legible to your head.' },
  { kind: 'call',    label: 'Call',    icon: 'call',            blurb: 'A call that was not against a lead you own.' },
  { kind: 'meeting', label: 'Meeting', icon: 'groups',          blurb: 'A meeting, internal or external.' },
  { kind: 'note',    label: 'Note',    icon: 'sticky_note_2',   blurb: 'Anything else worth having on your day.' },
]

// A date input wants YYYY-MM-DD in LOCAL time. toISOString() would shift a Lagos
// afternoon into the previous day for anyone west of UTC.
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Module-scoped so LeadField and NewLeadInline below share the form's own field label
// style rather than each inventing one that drifts from it.
const label: React.CSSProperties = {
  fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 6,
}
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d) }

export interface SalesActivityLead {
  id: number
  name: string | null
  /** crm_contacts.lead_stage. Without it the rail cannot say what is already passed. */
  stage?: string | null
}

export default function SalesActivityModal({
  open, lead, officerMode, onClose, onSaved,
}: {
  open: boolean
  /** Present ⇒ logging against a lead. Absent ⇒ logging the officer's own day. */
  lead?: SalesActivityLead | null
  /** My Day: no lead, posts to /api/sales/activity with an optional lead link. */
  officerMode?: boolean
  onClose: () => void
  /** Told whether the lead moved, so the caller can refresh what actually changed. */
  onSaved: (r?: { moved?: boolean; to?: string }) => void
}) {
  const isDay = !!officerMode && !lead

  // Shared
  const [kind, setKind]       = useState('')
  const [note, setNote]       = useState('')
  const [followUp, setFollow] = useState('')
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  // Officer-mode only
  const [subject, setSubject]   = useState('')
  const [location, setLocation] = useState('')
  const [leadId, setLeadId]     = useState('')
  const [leadName, setLeadName] = useState('')

  // When it happened. The backend has always accepted a backdated occurred_at (bounded to
  // seven days, never future) and this form never sent one, so an officer who logged
  // Friday's visits on Monday had them all recorded as Monday's — which is what made the
  // supervisor's calendar disagree with the week people actually worked.
  //
  // That fix first landed on My Day only. The lead drawer kept the bug: logLeadActivity did
  // not accept an occurred_at at all, so every call written up after the fact against a lead
  // was still stamped with the moment it was typed. Both paths now carry it.
  const [when, setWhen] = useState('')

  // What came of it, from the shared vocabulary rather than a free-text box.
  const [disposition, setDisposition] = useState('')
  const [dispCatalogue, setDispCatalogue] = useState<Record<string, Disposition[]>>({})

  const current    = (lead?.stage ?? '').toLowerCase()
  const closedAs   = CLOSED_STAGES[current]
  const currentIdx = current in STAGE_ORDER ? STAGE_ORDER[current] : -1
  const currentLabel = closedAs ?? (JOURNEY.find(s => s.stage === current)?.label ?? null)
  const who = lead?.name?.trim() || 'this lead'

  // Reopening on another lead must not inherit the last one's half-typed note.
  useEffect(() => {
    if (!open) return
    setKind(isDay ? 'visit' : ''); setNote(''); setFollow('')
    setSubject(''); setLocation(''); setLeadId(''); setLeadName('')
    setDisposition('')
    // Defaults to now, so the common case (logging as you go) needs no thought and the
    // uncommon one (catching up on Monday) is one field away.
    setWhen(localDateTimeValue(new Date()))
    setErr(null); setSaving(false)
  }, [open, lead?.id, isDay])

  // The outcome vocabulary. Loaded once per open; a failure leaves the picker absent
  // rather than blocking the save, because recording that a visit happened at all is worth
  // more than recording what came of it.
  useEffect(() => {
    if (!open || Object.keys(dispCatalogue).length > 0) return
    let cancelled = false
    apiFetch<{ data: Record<string, Disposition[]> }>('/api/sales/activity/dispositions')
      .then(r => { if (!cancelled) setDispCatalogue(r?.data ?? {}) })
      .catch(() => { /* optional */ })
    return () => { cancelled = true }
  }, [open, dispCatalogue])

  const dispsForKind = dispCatalogue[kind] ?? []
  const chosenDisp   = dispsForKind.find(d => d.code === disposition) ?? null
  // Clearing on a kind change is what stops "Did Not Get Past Reception" surviving a switch
  // from Visit to Call, where the server would refuse it as not belonging to that kind.
  useEffect(() => { setDisposition('') }, [kind])

  useEffect(() => { setErr(null) }, [kind])

  const chosenStep = useMemo(() => JOURNEY.find(s => s.kind && s.kind === kind) ?? null, [kind])
  const isForward  = !!chosenStep

  // A forward step is a change of state, and it happens now: the stage move it performs is
  // stamped NOW() whatever date were typed, so offering a date there would promise
  // something crm_contacts does not record. Record-only kinds are the ones officers catch
  // up on at the end of a week, and they are the ones that take a date.
  const canBackdate = isDay || (!!kind && !isForward)

  // Where the chosen outcome would put the lead, if anywhere. Forward only and never on a
  // closed lead, mirroring advanceLeadStage so the sentence below cannot promise a move the
  // server will decline.
  const advanceIdx = chosenDisp?.advances && chosenDisp.advances in STAGE_ORDER
    ? STAGE_ORDER[chosenDisp.advances] : -1
  const willAdvance = !isDay && !closedAs && advanceIdx > currentIdx
  const advanceLabel = willAdvance ? leadStageLabel(chosenDisp!.advances!) : ''

  // The sentence under the picker. It is the whole point of merging the two lists: the
  // officer sees what the save will DO before they commit to it.
  const consequence = (() => {
    if (isDay) return DAY_KINDS.find(k => k.kind === kind)?.blurb ?? ''
    if (!kind) return 'Pick what happened. Steps down the journey move the lead; the four below only record it.'
    const tail = followUp ? ` Follow-up set for ${fmtDate(followUp)}.` : ''
    if (isForward) {
      return currentLabel
        ? `Moves ${who} from ${currentLabel} to ${chosenStep!.label}.${tail}`
        : `Moves ${who} to ${chosenStep!.label}.${tail}`
    }
    // An outcome can carry the lead forward even though the kind itself only records — that
    // is what makes the four middle stages reachable at all. Telling the officer the lead
    // "stays at Contacted" while the save is about to move it is the one thing this
    // sentence must never do.
    if (willAdvance) {
      return `Goes on the timeline and moves ${who} to ${advanceLabel}.${tail}`
    }
    const stays = currentLabel ? ` ${who} stays at ${currentLabel}.` : ''
    return `Goes on the timeline.${stays}${tail}`
  })()

  // Same two bounds the server applies to a backdated occurred_at, checked here so the
  // officer is told before they lose what they have typed rather than after. Shared by both
  // modes, because the rule is the server's and there is only one of it.
  function whenProblem(): string | null {
    if (!when) return null
    const t = new Date(when)
    if (Number.isNaN(t.getTime())) return 'That date is not a real date.'
    if (t.getTime() > Date.now() + 2 * 60_000) {
      return 'That is in the future — log what happened, not what is planned.'
    }
    if (t.getTime() < Date.now() - 7 * 86_400_000) {
      return 'That is more than a week ago. Ask your head to record it if it still needs to go on the record.'
    }
    return null
  }

  function validate(): string | null {
    if (isDay) {
      if (!kind) return 'Pick what kind of activity this was.'
      if (!subject.trim()) return 'Say briefly what this was — it is what the entry reads as on your day.'
      const w = whenProblem()
      if (w) return w
      if (chosenDisp?.needs_note && !note.trim()) {
        return `"${chosenDisp.label}" needs a note saying why — that is the part anyone reading this later actually needs.`
      }
      if (chosenDisp?.needs_follow_up && leadId && !followUp) {
        return `"${chosenDisp.label}" needs a date to come back on.`
      }
      return null
    }
    if (!kind) return 'Pick what happened.'
    // The lead branch enforced none of this: it was one line, so an officer could log a
    // "Callback Requested" against a lead with no callback date and the server had no
    // disposition to refuse it with.
    if (canBackdate) {
      const w = whenProblem()
      if (w) return w
    }
    if (chosenDisp?.needs_note && !note.trim()) {
      return `"${chosenDisp.label}" needs a note saying why — that is the part anyone reading this later actually needs.`
    }
    // Unconditional here, unlike My Day: there is always a lead to hang the date on.
    if (chosenDisp?.needs_follow_up && !followUp) {
      return `"${chosenDisp.label}" needs a date to come back on.`
    }
    return null
  }

  async function submit() {
    const problem = validate()
    if (problem) { setErr(problem); return }
    setErr(null); setSaving(true)
    try {
      if (isDay) {
        const res = await apiPost<{ ok: boolean; moved?: string }>('/api/sales/activity', {
          type: kind,
          subject: subject.trim(),
          location: location.trim(),
          body: note.trim(),
          disposition: disposition || undefined,
          contact_id: leadId ? Number(leadId) : null,
          // Sent as an absolute instant: datetime-local has no zone, so the Date is built
          // in the officer's own timezone and serialised with an offset. Sending the bare
          // local string would be read as UTC and land an hour out for Lagos.
          ...(when ? { occurred_at: new Date(when).toISOString() } : {}),
          ...(followUp && leadId ? { follow_up_at: new Date(followUp).toISOString() } : {}),
        })
        // Name whatever stage it landed on, rather than testing for one. This read
        // `res.moved === 'qualified'`, which was the only move the server could make; now that
        // an outcome can carry a lead to In Progress or Documents Requested, a hard-coded
        // comparison would let the officer watch the lead move and be told nothing.
        if (res?.moved && leadName) {
          toast.success(`Logged. ${leadName} is now ${leadStageLabel(res.moved)}.`)
        } else if (res?.moved) {
          toast.success(`Logged. The lead moved to ${leadStageLabel(res.moved)}.`)
        } else {
          toast.success('Logged to your day')
        }
        onSaved()
        return
      }
      const res = await apiPost<{ ok: boolean; moved: boolean; to?: string }>(
        `/api/sales/leads/${lead!.id}/activity`,
        {
          kind,
          note: note.trim(),
          // Omitted rather than sent empty: the server treats an absent follow-up as
          // "leave the existing one alone", which is what logging a call should do.
          ...(followUp ? { follow_up_at: followUp } : {}),
          ...(disposition ? { disposition } : {}),
          // An absolute instant, for the same reason My Day sends one: datetime-local
          // carries no zone, so the bare string would be read as UTC and land an hour out
          // for Lagos. Sent only for the kinds that can be backdated — the server refuses
          // a date on a forward step rather than quietly ignoring it.
          ...(canBackdate && when ? { occurred_at: new Date(when).toISOString() } : {}),
        },
      )
      // Name the stage the server says it landed on. chosenStep is null for a record-only
      // kind, so an outcome-driven move reported itself as "the next step" — the officer
      // watched the lead move and was told nothing about where to.
      if (res?.moved) {
        toast.success(`${who} moved to ${res.to ? leadStageLabel(res.to) : (chosenStep?.label ?? 'the next step')}`)
      } else {
        toast.success(followUp ? `Logged. Follow-up set for ${fmtDate(followUp)}` : 'Logged')
      }
      onSaved({ moved: res?.moved, to: res?.to })
    } catch (e: any) {
      const msg = e?.message || 'Could not log that'
      setErr(msg); toast.error(msg)
    } finally { setSaving(false) }
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const chip = (on: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', minHeight: 30,
    borderRadius: RADIUS.full, cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.semibold,
    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? NAVY : 'var(--card)',
    color: on ? '#fff' : 'var(--txt2)', fontFamily: INTER, transition: 'var(--transition-fast)',
  })

  const primaryLabel = saving ? 'Saving…'
    : isDay ? 'Log to My Day'
    : isForward ? `Move to ${chosenStep!.label}`
    : kind ? `Log ${RECORD_KINDS.find(k => k.kind === kind)?.label ?? 'Activity'}`
    : 'Log Activity'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isDay ? 'Log to My Day' : lead?.name ? `Log Activity: ${lead.name}` : 'Log Activity'}
      width={isDay ? 500 : 560}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ flex: 1, fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Ctrl + Enter to save</span>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={submit}
            icon={isForward ? 'trending_flat' : isDay ? 'add' : 'check'}>
            {primaryLabel}
          </Button>
        </div>
      }
    >
      <div
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit() } }}
        style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}
      >
        {/* Where the lead stands right now. Without it the rail is a list of words:
            "already passed" only means something once you can see where you are. */}
        {!isDay && currentLabel && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start',
            padding: '5px 11px', borderRadius: RADIUS.full, fontSize: TEXT.xs, fontFamily: INTER,
            background: closedAs ? `${AMBER}14` : `${NAVY}0D`,
            border: `1px solid ${closedAs ? `${AMBER}40` : `${NAVY}22`}`,
            color: closedAs ? AMBER : NAVY, fontWeight: FW.semibold,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>
              {closedAs ? 'lock' : 'flag'}
            </span>
            Currently: {currentLabel}
          </div>
        )}

        {isDay ? (
          <>
            <div>
              <label style={label}>What Was It?</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 6 }}>
                {DAY_KINDS.map(k => {
                  const on = kind === k.kind
                  return (
                    <button key={k.kind} type="button" onClick={() => setKind(k.kind)} aria-pressed={on} title={k.blurb}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                        padding: '9px 4px 8px', borderRadius: RADIUS.md, cursor: 'pointer',
                        border: `1px solid ${on ? NAVY : 'var(--bdr)'}`,
                        background: on ? `${NAVY}0F` : 'var(--card)', color: on ? NAVY : 'var(--txt2)',
                        fontFamily: INTER, fontSize: TEXT['2xs'], fontWeight: on ? FW.bold : FW.semibold,
                        transition: 'var(--transition-fast)', minWidth: 0,
                      }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 19 }}>{k.icon}</span>
                      <span>{k.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <Input label="In A Few Words" value={subject} autoFocus
              onChange={e => setSubject(e.target.value)}
              placeholder={kind === 'visit' ? 'e.g. Visited Dangote HR' : kind === 'call' ? 'e.g. Called Mr Adeyemi' : 'e.g. Met the Ikeja branch manager'}
              hint="This is what the entry reads as on your day." />

            {kind === 'visit' && (
              <Input label="Where" value={location} onChange={e => setLocation(e.target.value)}
                placeholder="e.g. Ikeja, Lagos" />
            )}

            {/* Who it was about. A searchable field rather than a <select>, because the
                queue runs to hundreds and a native dropdown of 185 names is unusable — and
                it used to be hidden entirely when the officer had no leads loaded, which is
                every officer today, since nobody owns a lead yet. A lead can now also be
                created right here: the work comes first and the record should not require
                leaving the form you are already in. */}
            <LeadField
              leadId={leadId} leadName={leadName}
              onPick={(id, name) => { setLeadId(id); setLeadName(name) }}
            />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
              <Input label="When Did This Happen?" type="datetime-local" value={when}
                onChange={e => setWhen(e.target.value)}
                hint="Defaults to now. Back-date up to a week if you are catching up." />
              {dispsForKind.length > 0 && (
                <SelectMenuField
                  label="What Came Of It?"
                  value={disposition}
                  onChange={setDisposition}
                  clearLabel="Not recorded"
                  searchable={false}
                  options={dispsForKind.map(d => ({ value: d.code, label: d.label, hint: d.hint }))}
                  hint={chosenDisp?.hint}
                />
              )}
            </div>

            {/* The two consequences a disposition can carry, surfaced the moment it is
                picked rather than as a validation error after the officer hits save. */}
            {chosenDisp?.needs_follow_up && (
              <Input label={leadId ? 'Come Back On' : 'Come Back On (Link A Lead To Set This)'}
                type="date" value={followUp} disabled={!leadId}
                onChange={e => setFollow(e.target.value)}
                hint={leadId
                  ? 'Goes on the lead as its next action, so the queue brings it back to you.'
                  : 'A follow-up date needs a lead to sit on — link one above.'} />
            )}
            {chosenDisp?.closes && (
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-start', padding: `${SP[2]} ${SP[3]}`,
                borderRadius: RADIUS.md, background: `${AMBER}12`, border: `1px solid ${AMBER}3A`,
                fontSize: TEXT.xs, color: 'var(--txt)',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, color: AMBER }}>info</span>
                <span>This outcome ends the pursuit. Say why in the note — it is what stops the
                  next campaign calling them again for the same reason.</span>
              </div>
            )}
            {chosenDisp?.qualifies && leadId && (
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-start', padding: `${SP[2]} ${SP[3]}`,
                borderRadius: RADIUS.md, background: `${GREEN}12`, border: `1px solid ${GREEN}3A`,
                fontSize: TEXT.xs, color: 'var(--txt)',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, color: GREEN }}>trending_flat</span>
                <span>Saves and moves <strong>{leadName || 'the lead'}</strong> to Interested.</span>
              </div>
            )}

            {/* The free-text "Outcome" box that used to sit here is gone. It asked for the
                same thing the disposition now captures, in prose nobody could count: a head
                could not answer "how many visits got past reception this month" from 200
                hand-typed lines, and two officers wrote the same result two ways. Anything
                that does not fit a code belongs in the shared note field below. */}
          </>
        ) : (
          <>
            {/* The journey. Steps at or behind the current one are shown as passed and
                cannot be chosen, because logLeadActivity refuses them with a 409 — being
                told after the fact that you cannot move backwards is a worse way to find
                out than never being offered it. */}
            <div>
              <label style={label}>What Happened?</label>
              {closedAs ? (
                <div style={{
                  fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5,
                  padding: '9px 11px', borderRadius: RADIUS.md,
                  background: `${AMBER}0E`, border: `1px solid ${AMBER}33`,
                }}>
                  This lead is {closedAs.toLowerCase()}, so it cannot move forward any further.
                  You can still record what happened below.
                </div>
              ) : (
                <div role="radiogroup" aria-label="Lead journey" style={{ display: 'flex', flexDirection: 'column' }}>
                  {JOURNEY.map((s, i) => {
                    const passed     = currentIdx >= 0 && i <= currentIdx
                    const selectable = !!s.kind && !passed
                    const on         = !!s.kind && s.kind === kind
                    const isNow      = i === currentIdx
                    const last       = i === JOURNEY.length - 1
                    return (
                      <button
                        key={s.stage} type="button" role="radio" aria-checked={on} disabled={!selectable}
                        onClick={() => selectable && setKind(s.kind!)}
                        title={!s.kind ? 'This stage is reached by contacting the lead, not logged here.'
                          : passed ? 'Already passed — a lead cannot move backwards.' : s.hint}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
                          padding: '7px 11px 7px 9px', borderRadius: RADIUS.md,
                          cursor: selectable ? 'pointer' : 'default',
                          border: `1px solid ${on ? NAVY : 'transparent'}`,
                          background: on ? `${NAVY}0F` : 'transparent',
                          textAlign: 'left', fontFamily: INTER, transition: 'var(--transition-fast)',
                          opacity: selectable || isNow ? 1 : 0.55,
                        }}
                      >
                        {/* The rail. The connector is what makes this read as one journey
                            rather than a list of unrelated options. */}
                        <span style={{ position: 'relative', flex: '0 0 auto', width: 18, display: 'flex', justifyContent: 'center', paddingTop: 2 }}>
                          {!last && (
                            <span aria-hidden style={{
                              position: 'absolute', top: 18, left: '50%', width: 1, height: 'calc(100% - 4px)',
                              background: passed ? `${GREEN}66` : 'var(--bdr)', transform: 'translateX(-0.5px)',
                            }} />
                          )}
                          <span style={{
                            position: 'relative', width: 16, height: 16, borderRadius: RADIUS.full,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            border: `1.5px solid ${passed ? GREEN : on ? NAVY : 'var(--bdr)'}`,
                            background: passed ? GREEN : 'var(--card)', color: '#fff', flex: '0 0 auto',
                          }}>
                            {passed && <span className="material-symbols-rounded" style={{ fontSize: 11 }}>check</span>}
                            {!passed && on && <span style={{ width: 6, height: 6, borderRadius: RADIUS.full, background: NAVY }} />}
                          </span>
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: TEXT.sm, fontWeight: on || isNow ? FW.bold : FW.semibold, color: on ? NAVY : 'var(--txt)' }}>
                              {s.label}
                            </span>
                            {isNow && <span style={{ fontSize: TEXT['2xs'], color: NAVY, fontWeight: FW.bold }}>now</span>}
                            {passed && !isNow && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>passed</span>}
                            {!s.kind && !passed && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>not logged here</span>}
                          </span>
                          {on && s.hint && (
                            <span style={{ display: 'block', fontSize: TEXT['2xs'], color: 'var(--txt2)', marginTop: 3, lineHeight: 1.45 }}>
                              {s.hint}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Record-only. Visually separated because the consequence is different in
                kind, not in degree: nothing about the lead changes. */}
            <div>
              <div style={{ ...label, marginBottom: 7 }}>…Or Just Record It</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {RECORD_KINDS.map(k => (
                  <button key={k.kind} type="button" onClick={() => setKind(k.kind)} aria-pressed={kind === k.kind}
                    style={chip(kind === k.kind)}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{k.icon}</span>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>

            {/* When it happened, and what came of it. Both of these were My Day's alone.
                The lead drawer could do neither, so an officer writing up Friday's calls on
                Monday had them stamped Monday — the bug the comment at the top of this file
                describes, fixed on one of the two paths — and the result of every one of
                those calls was free prose where My Day stored a counted code.

                Shown only for the record-only kinds: a forward step is its own outcome, and
                it happens now. */}
            {canBackdate && (
              <div style={{
                display: 'grid', gap: SP[3],
                gridTemplateColumns: dispsForKind.length > 0 ? '1fr 1fr' : '1fr',
              }}>
                <Input label="When Did This Happen?" type="datetime-local" value={when}
                  onChange={e => setWhen(e.target.value)}
                  hint="Defaults to now. Back-date up to a week if you are catching up." />
                {dispsForKind.length > 0 && (
                  <SelectMenuField
                    label="What Came Of It?"
                    value={disposition}
                    onChange={setDisposition}
                    clearLabel="Not recorded"
                    searchable={false}
                    options={dispsForKind.map(d => ({ value: d.code, label: d.label, hint: d.hint }))}
                    hint={chosenDisp?.hint}
                  />
                )}
              </div>
            )}

            {/* The consequence strip below already names an advancing outcome, so there is
                no green panel here to say it twice. This one earns its space because nothing
                else says it: a closing outcome is the end of the pursuit. */}
            {chosenDisp?.closes && (
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-start', padding: `${SP[2]} ${SP[3]}`,
                borderRadius: RADIUS.md, background: `${AMBER}12`, border: `1px solid ${AMBER}3A`,
                fontSize: TEXT.xs, color: 'var(--txt)',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, color: AMBER }}>info</span>
                <span>This outcome ends the pursuit. Say why in the note — it is what stops the
                  next campaign calling them again for the same reason.</span>
              </div>
            )}
          </>
        )}

        {/* Fixed height so the form does not jump as the choice changes. */}
        <div style={{
          fontSize: TEXT.xs, color: kind ? 'var(--txt2)' : 'var(--txt3)', lineHeight: 1.45,
          minHeight: 32, display: 'flex', alignItems: 'center', gap: 7,
          padding: kind ? '8px 11px' : 0, borderRadius: RADIUS.md,
          // --bg2 is now a defined token (lib/design.ts). It was not, and the `transparent`
          // fallback here meant this strip rendered with no background at all whenever the
          // chosen kind only records rather than moves the lead — which is most of them.
          background: kind ? (isForward ? `${NAVY}0A` : 'var(--bg2)') : 'transparent',
          border: kind && isForward ? `1px solid ${NAVY}22` : '1px solid transparent',
        }}>
          {kind && (
            <span className="material-symbols-rounded" style={{ fontSize: 15, color: isForward ? NAVY : 'var(--txt3)', flex: '0 0 auto' }}>
              {isForward ? 'trending_flat' : 'history'}
            </span>
          )}
          <span>{consequence}</span>
        </div>

        {/* Required when the chosen outcome says so — a "Not Interested" or "Not Eligible"
            with no reason is the entry that makes the next campaign repeat the mistake. */}
        <Textarea
          label={chosenDisp?.needs_note ? 'Why (Required)' : isDay ? 'Detail (Optional)' : 'Notes (Optional)'}
          value={note} rows={3}
          onChange={e => setNote(e.target.value)}
          placeholder={chosenDisp?.needs_note
            ? 'Say why — this outcome needs it.'
            : isForward ? 'What was said, and anything the next person needs' : 'Anything worth knowing next time'} />

        {/* Follow-up. This is the field that was silently lost for every officer: the old
            My Dashboard form collected it and posted it to an endpoint their role could
            not reach. It now sets crm_contacts.next_action_at, which is what the
            follow-up worklist and the overdue counters actually read. */}
        {!isDay && (
          <div>
            <label style={label} htmlFor="sa-follow">
              {chosenDisp?.needs_follow_up ? 'Come Back On (Required)' : 'Next Follow-Up (Optional)'}
            </label>
            <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
              <input id="sa-follow" type="date" value={followUp} min={isoDate(new Date())}
                onChange={e => { setFollow(e.target.value); setErr(null) }}
                style={{
                  padding: '9px 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
                  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
                  fontFamily: INTER, flex: '0 1 170px', boxSizing: 'border-box',
                }} />
              {([['Tomorrow', addDays(1)], ['Next Week', addDays(7)]] as [string, string][]).map(([l, v]) => (
                <button key={l} type="button" onClick={() => setFollow(followUp === v ? '' : v)} style={chip(followUp === v)}>{l}</button>
              ))}
              {followUp && (
                <button type="button" onClick={() => setFollow('')}
                  style={{ ...chip(false), border: 'none', color: 'var(--txt3)' }}>Clear</button>
              )}
            </div>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 5 }}>
              {chosenDisp?.needs_follow_up
                ? `"${chosenDisp.label}" needs a date to come back on — the queue is what brings it back to you.`
                : 'Leave it empty and any follow-up already booked stays as it is.'}
            </div>
          </div>
        )}

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

// ── LeadField ────────────────────────────────────────────────────────────────
//
// Who the activity was about. A search box rather than a dropdown, for two reasons that
// both came out of the data: the queue is 185 leads today and a native <select> of that
// many names cannot be used, and the previous field was hidden entirely unless leads had
// already loaded — which, with nobody yet owning a lead, meant every officer saw no lead
// field at all and every activity was logged detached from the person it was about.
//
// Searching hits /api/sales/leads?q=, which is already scoped: an officer can only find
// their own leads and the unclaimed pool, so this cannot become a way to read another
// team's book.
//
// It also creates. An officer standing outside an employer they just visited should not
// have to abandon the form, go to Leads, create the record, come back and start again —
// that is the friction that makes people log nothing.

interface LeadHit {
  id: number
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  lead_stage?: string | null
  owner_name?: string | null
}

function leadLabel(l: LeadHit): string {
  return [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || `Lead ${l.id}`
}

function LeadField({ leadId, leadName, onPick }: {
  leadId: string
  leadName: string
  onPick: (id: string, name: string) => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<LeadHit[]>([])
  const [busy, setBusy] = useState(false)
  const [openList, setOpenList] = useState(false)
  const [creating, setCreating] = useState(false)
  const dq = useDebouncedValue(q, 250)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (leadId || dq.trim().length < 2) { setHits([]); return }
    let cancelled = false
    setBusy(true)
    apiFetch<{ data: LeadHit[] }>(`/api/sales/leads?limit=8&q=${encodeURIComponent(dq.trim())}`)
      .then(r => { if (!cancelled) { setHits(r?.data ?? []); setOpenList(true) } })
      .catch(() => { if (!cancelled) setHits([]) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [dq, leadId])

  // Clicking away closes the result list without clearing what was typed.
  useEffect(() => {
    if (!openList) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpenList(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [openList])

  if (leadId) {
    return (
      <div>
        <label style={label}>About</label>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
          border: `1px solid ${NAVY}33`, borderRadius: RADIUS.md, background: `${NAVY}0A`,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 17, color: NAVY }}>person</span>
          <span style={{ flex: 1, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
            {leadName || `Lead ${leadId}`}
          </span>
          <button type="button" onClick={() => { onPick('', ''); setQ(''); setHits([]) }}
            title="Not about this lead"
            style={{
              border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)',
              display: 'inline-flex', alignItems: 'center', padding: 2,
            }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 4 }}>
          This entry will appear on {leadName || 'the lead'}'s own history.
        </div>
      </div>
    )
  }

  if (creating) {
    return <NewLeadInline initialName={q} onCancel={() => setCreating(false)}
      onCreated={(id, name) => { setCreating(false); onPick(String(id), name) }} />
  }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <label style={label} htmlFor="sa-leadsearch">About A Lead? (Optional)</label>
      <div style={{ position: 'relative' }}>
        <span className="material-symbols-rounded" style={{
          position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
          fontSize: 17, color: 'var(--txt3)', pointerEvents: 'none',
        }}>search</span>
        <input
          id="sa-leadsearch" value={q} onChange={e => setQ(e.target.value)}
          onFocus={() => { if (hits.length) setOpenList(true) }}
          placeholder="Search by name or phone…"
          style={{
            width: '100%', padding: '9px 11px 9px 32px', border: '1px solid var(--input-bdr)',
            borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)',
            color: 'var(--txt)', fontFamily: INTER, boxSizing: 'border-box',
          }} />
        {busy && (
          <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)' }}>
            <Spinner size={14} />
          </span>
        )}
      </div>

      {openList && q.trim().length >= 2 && (
        <div style={{
          position: 'absolute', zIndex: 30, left: 0, right: 0, marginTop: 4,
          background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
          boxShadow: '0 8px 24px rgba(0,0,0,.14)', maxHeight: 260, overflowY: 'auto',
        }}>
          {hits.map(h => (
            <button key={h.id} type="button"
              onClick={() => { onPick(String(h.id), leadLabel(h)); setOpenList(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none',
                background: 'none', cursor: 'pointer', padding: '8px 11px',
                borderBottom: '1px solid var(--bdr)', fontFamily: INTER,
              }}>
              <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.semibold }}>
                {leadLabel(h)}
              </div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
                {[h.phone, h.lead_stage, h.owner_name ? `with ${h.owner_name}` : 'unclaimed']
                  .filter(Boolean).join(' · ')}
              </div>
            </button>
          ))}
          {!busy && hits.length === 0 && (
            <div style={{ padding: '10px 11px', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              No lead matches “{q.trim()}”.
            </div>
          )}
          <button type="button" onClick={() => { setCreating(true); setOpenList(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
              border: 'none', background: 'none', cursor: 'pointer', padding: '9px 11px',
              color: NAVY, fontFamily: INTER, fontSize: TEXT.sm, fontWeight: FW.semibold,
            }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>person_add</span>
            Register “{q.trim()}” as a new lead
          </button>
        </div>
      )}

      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 4 }}>
        Linking it puts this on the lead's own history and stops it showing as stalled.
      </div>
    </div>
  )
}

// ── NewLeadInline ────────────────────────────────────────────────────────────
//
// The minimum createLead actually requires: a name, one way to reach them, and a source.
// Nothing else, because every extra field here is a reason to close the form and log
// nothing. The rest is enrichment and belongs on the lead itself later.
function NewLeadInline({ initialName, onCancel, onCreated }: {
  initialName: string
  onCancel: () => void
  onCreated: (id: number, name: string) => void
}) {
  // A typed search is usually the person's name, so split it rather than make them retype.
  const parts = initialName.trim().split(/\s+/)
  const [first, setFirst] = useState(parts[0] ?? '')
  const [last, setLast]   = useState(parts.slice(1).join(' '))
  const [phone, setPhone] = useState('')
  const [source, setSource] = useState('')
  const [sources, setSources] = useState<{ code: string; label: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ data: { code: string; label: string }[] }>('/api/sales/leads/sources')
      .then(r => {
        const list = r?.data ?? []
        setSources(list)
        // Default to a self-sourced code when one exists: an officer creating a lead from
        // their own visit IS the origination, and pre-selecting it saves the commonest pick.
        const self = list.find(s => /self|walk|referral/i.test(s.code))
        if (self) setSource(self.code)
      })
      .catch(() => { /* the select renders empty and the save will say what is missing */ })
  }, [])

  const save = useCallback(async () => {
    if (!first.trim() && !last.trim()) { setErr('A first or last name is required.'); return }
    if (!phone.trim()) { setErr('A phone number is required — a lead with no way to reach it is not a lead.'); return }
    if (!source) { setErr('Pick where this lead came from, so the origination is credited.'); return }
    setErr(null); setSaving(true)
    try {
      const res = await apiPost<{ id: number; possible_duplicate_of?: number | null }>('/api/sales/leads', {
        first_name: first.trim(), last_name: last.trim(),
        phone: phone.trim(), lead_source: source,
      })
      const name = [first.trim(), last.trim()].filter(Boolean).join(' ')
      // createLead warns rather than blocks on a matching phone — the same person can come
      // back as a fresh opportunity — so surface it instead of swallowing it.
      if (res?.possible_duplicate_of) {
        toast.warning('Created — but someone with this number already exists. Worth checking.')
      } else {
        toast.success(`${name} added to your leads`)
      }
      onCreated(res.id, name)
    } catch (e: any) {
      const msg = e?.message || 'Could not create the lead'
      setErr(msg); toast.error(msg)
    } finally { setSaving(false) }
  }, [first, last, phone, source, onCreated])

  return (
    <div style={{
      padding: SP[3], borderRadius: RADIUS.md, border: `1px solid ${BLUE}3A`,
      background: `${BLUE}0A`, display: 'flex', flexDirection: 'column', gap: SP[2],
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 17, color: BLUE }}>person_add</span>
        <strong style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>New lead</strong>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onCancel}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', fontSize: TEXT.xs }}>
          Cancel
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
        <Input label="First Name" value={first} onChange={e => setFirst(e.target.value)} autoFocus />
        <Input label="Last Name" value={last} onChange={e => setLast(e.target.value)} />
      </div>
      <Input label="Phone" value={phone} onChange={e => setPhone(e.target.value)}
        placeholder="e.g. 08031234567" />
      <SelectMenuField label="Where From?" value={source} onChange={setSource}
        options={sources.map(s => ({ value: s.code, label: s.label }))}
        placeholder="Pick a source" />
      {err && (
        <div style={{ fontSize: TEXT.xs, color: RED }}>{err}</div>
      )}
      <Button variant="primary" loading={saving} onClick={save} icon="check">
        Create And Link
      </Button>
    </div>
  )
}
