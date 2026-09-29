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

import { useEffect, useMemo, useState } from 'react'
import { Modal, Input, Textarea, Button } from './UI'
import { apiFetch, apiPost } from '../lib/api'
import { NAVY, GREEN, AMBER, RED, RADIUS, TEXT, FW, SP, INTER } from '../lib/design'
import { fmtDate } from '../lib/fmt'
import { toast } from 'sonner'

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
  const [outcome, setOutcome]   = useState('')
  const [leadId, setLeadId]     = useState('')
  const [myLeads, setMyLeads]   = useState<{ id: number; label: string }[]>([])

  const current    = (lead?.stage ?? '').toLowerCase()
  const closedAs   = CLOSED_STAGES[current]
  const currentIdx = current in STAGE_ORDER ? STAGE_ORDER[current] : -1
  const currentLabel = closedAs ?? (JOURNEY.find(s => s.stage === current)?.label ?? null)
  const who = lead?.name?.trim() || 'this lead'

  // Reopening on another lead must not inherit the last one's half-typed note.
  useEffect(() => {
    if (!open) return
    setKind(isDay ? 'visit' : ''); setNote(''); setFollow('')
    setSubject(''); setLocation(''); setOutcome(''); setLeadId('')
    setErr(null); setSaving(false)
  }, [open, lead?.id, isDay])

  // The officer's own leads, so a day activity can be tied to one. Optional by design:
  // an employer visit that has not produced a lead yet is exactly the work that used to
  // go unrecorded, and requiring a lead would make it unloggable again.
  useEffect(() => {
    if (!open || !isDay || myLeads.length > 0) return
    let cancelled = false
    apiFetch<{ data: { id: number; first_name?: string; last_name?: string; name?: string }[] }>('/api/sales/leads?limit=100')
      .then(r => {
        if (cancelled) return
        setMyLeads((r?.data ?? []).map(l => ({
          id: l.id,
          label: (l.name || [l.first_name, l.last_name].filter(Boolean).join(' ') || `Lead ${l.id}`).trim(),
        })))
      })
      .catch(() => { /* the picker is optional; failing to load it must not block logging */ })
    return () => { cancelled = true }
  }, [open, isDay, myLeads.length])

  useEffect(() => { setErr(null) }, [kind])

  const chosenStep = useMemo(() => JOURNEY.find(s => s.kind && s.kind === kind) ?? null, [kind])
  const isForward  = !!chosenStep

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
    const stays = currentLabel ? ` ${who} stays at ${currentLabel}.` : ''
    return `Goes on the timeline.${stays}${tail}`
  })()

  function validate(): string | null {
    if (isDay) {
      if (!kind) return 'Pick what kind of activity this was.'
      if (!subject.trim()) return 'Say briefly what this was — it is what the entry reads as on your day.'
      return null
    }
    if (!kind) return 'Pick what happened.'
    return null
  }

  async function submit() {
    const problem = validate()
    if (problem) { setErr(problem); return }
    setErr(null); setSaving(true)
    try {
      if (isDay) {
        await apiPost('/api/sales/activity', {
          type: kind,
          subject: subject.trim(),
          location: location.trim(),
          body: note.trim(),
          outcome: outcome.trim(),
          contact_id: leadId ? Number(leadId) : null,
        })
        toast.success('Logged to your day')
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
        },
      )
      if (res?.moved) toast.success(`${who} moved to ${chosenStep?.label ?? 'the next step'}`)
      else toast.success(followUp ? `Logged. Follow-up set for ${fmtDate(followUp)}` : 'Logged')
      onSaved({ moved: res?.moved, to: res?.to })
    } catch (e: any) {
      const msg = e?.message || 'Could not log that'
      setErr(msg); toast.error(msg)
    } finally { setSaving(false) }
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const label: React.CSSProperties = {
    fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 6,
  }
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

            {myLeads.length > 0 && (
              <div>
                <label style={label} htmlFor="sa-lead">About A Lead? (Optional)</label>
                <select id="sa-lead" value={leadId} onChange={e => setLeadId(e.target.value)}
                  style={{
                    width: '100%', padding: '9px 11px', border: '1px solid var(--input-bdr)',
                    borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)',
                    color: 'var(--txt)', fontFamily: INTER, boxSizing: 'border-box',
                  }}>
                  <option value="">Not about a specific lead</option>
                  {myLeads.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 4 }}>
                  Linking it puts this on the lead's own history and keeps it from going stale.
                </div>
              </div>
            )}

            <Input label="Outcome (Optional)" value={outcome} onChange={e => setOutcome(e.target.value)}
              placeholder="e.g. Interested, wants a presentation" />
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
          </>
        )}

        {/* Fixed height so the form does not jump as the choice changes. */}
        <div style={{
          fontSize: TEXT.xs, color: kind ? 'var(--txt2)' : 'var(--txt3)', lineHeight: 1.45,
          minHeight: 32, display: 'flex', alignItems: 'center', gap: 7,
          padding: kind ? '8px 11px' : 0, borderRadius: RADIUS.md,
          background: kind ? (isForward ? `${NAVY}0A` : 'var(--bg2, transparent)') : 'transparent',
          border: kind && isForward ? `1px solid ${NAVY}22` : '1px solid transparent',
        }}>
          {kind && (
            <span className="material-symbols-rounded" style={{ fontSize: 15, color: isForward ? NAVY : 'var(--txt3)', flex: '0 0 auto' }}>
              {isForward ? 'trending_flat' : 'history'}
            </span>
          )}
          <span>{consequence}</span>
        </div>

        <Textarea label={isDay ? 'Detail (Optional)' : 'Notes (Optional)'} value={note} rows={3}
          onChange={e => setNote(e.target.value)}
          placeholder={isForward ? 'What was said, and anything the next person needs' : 'Anything worth knowing next time'} />

        {/* Follow-up. This is the field that was silently lost for every officer: the old
            My Dashboard form collected it and posted it to an endpoint their role could
            not reach. It now sets crm_contacts.next_action_at, which is what the
            follow-up worklist and the overdue counters actually read. */}
        {!isDay && (
          <div>
            <label style={label} htmlFor="sa-follow">Next Follow-Up (Optional)</label>
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
              Leave it empty and any follow-up already booked stays as it is.
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
