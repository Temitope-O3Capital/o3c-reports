import { useState, useEffect, useCallback } from 'react'
import { Modal, Spinner } from './UI'
import { apiFetch, apiPost } from '../lib/api'
import { NAVY, GREEN, AMBER, SORA, FW, RADIUS, SP, TEXT } from '../lib/design'
import { toast } from 'sonner'
import { CustomerSearch, CustSuggest, cleanName, initialsOf } from './CustomerSearch'

// ─────────────────────────────────────────────────────────────────────────────
// One Log-a-Call modal, shared by the Call Log and the agent My-Dashboard so the
// two can never drift again. Everything the agent used to type by hand is mapped
// from the fields they DO pick:
//
//   • Direction  → renames the "no answer" outcome (Missed inbound / No Answer outbound)
//   • Purpose    → narrows the Disposition list to that book, and seeds the ticket type
//   • Outcome    → auto-selects the matching Disposition (missed → No Answer, etc.)
//   • Disposition→ auto-opens a follow-up ticket + reveals the callback time when needed
//
// so a normal call is: pick the customer, pick direction, pick outcome — done.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogCallInitial {
  name?: string
  phone?: string
  cif?: string
  direction?: string   // 'Inbound' | 'Outbound'
  purpose?: string     // '' | 'marketing' | 'sales' | 'collections' | 'support'
  // leadId links the call to a call-centre lead, so logging it also advances the
  // lead (status, callback, DNC) in the same request. The Leads page used to run
  // its own four-field form against a separate endpoint, which is how the two
  // flows drifted apart.
  leadId?: number
}

// A real call on this number that the agent could be writing up — see
// GET /api/helpdesk/calls/candidates.
export interface CallCandidate {
  id: number
  direction: string
  outcome: string
  duration_sec: number | null
  started_at: string
  customer_name?: string | null
  customer_cif?: string | null
  agent_name?: string | null
  has_recording?: boolean
  is_mine?: boolean
}

// Purpose = which book the call belongs to. Kept in step with helpdesk/Calls.tsx.
export const CALL_PURPOSES: { value: string; label: string }[] = [
  { value: '',            label: 'Support / Service' },
  { value: 'marketing',   label: 'Marketing / Leads' },
  { value: 'sales',       label: 'Outbound Sales' },
  { value: 'collections', label: 'Collections' },
]

// Disposition (business result) adapts to the call's purpose — a support call and a
// collections call don't share outcomes, so the agent only ever sees the relevant few.
const SUPPORT_DISPOSITIONS = [
  'Resolved', 'Closed', 'Information Provided', 'Escalated', 'Complaint Logged',
  'Callback Scheduled', 'Pending / Follow-up', 'Unreachable / No Answer', 'Call Dropped',
]
const DISPOSITIONS_BY_PURPOSE: Record<string, string[]> = {
  '':           SUPPORT_DISPOSITIONS,
  support:      SUPPORT_DISPOSITIONS,
  // 'Not Eligible' and 'Not Ready Yet' used to be forced into 'Not Interested',
  // which closes the lead. They are different outcomes: not eligible is a decline
  // on our side, not ready is a timing objection worth calling back.
  marketing:    ['Interested', 'Not Ready Yet', 'Not Eligible', 'Not Interested', 'Converted', 'Callback Scheduled', 'Wrong Number', 'Do Not Call', 'Unreachable / No Answer', 'Call Dropped'],
  sales:        ['Interested', 'Not Ready Yet', 'Not Eligible', 'Not Interested', 'Converted', 'Callback Scheduled', 'Wrong Number', 'Do Not Call', 'Unreachable / No Answer', 'Call Dropped'],
  collections:  ['Promise to Pay', 'Paid', 'Dispute', 'Callback Scheduled', 'Escalated', 'Wrong Number', 'Unreachable / No Answer', 'Call Dropped'],
}
export function dispositionsFor(purpose: string): string[] {
  return DISPOSITIONS_BY_PURPOSE[purpose] ?? SUPPORT_DISPOSITIONS
}

// Dispositions that mean the call isn't finished — these auto-check "open a ticket".
const FOLLOWUP_DISPOSITIONS = new Set([
  'Escalated', 'Complaint Logged', 'Callback Scheduled', 'Pending / Follow-up',
  'Unreachable / No Answer', 'Promise to Pay', 'Dispute',
])
// The one disposition that needs a time (a callback with no time is a broken promise).
const CALLBACK_DISPOSITION = 'Callback Scheduled'

function dispositionPriority(d: string): 'high' | 'medium' | 'low' {
  return d === 'Escalated' || d === 'Complaint Logged' ? 'high' : 'medium'
}

// A ticket raised off a call inherits the purpose's natural ticket type, so the agent
// doesn't re-pick what the call already told us.
const TICKET_TYPE_FOR_PURPOSE: Record<string, string> = {
  marketing:   'Pitching / Marketing',
  sales:       'Pitching / Marketing',
  collections: 'Collection',
}
const TICKET_TYPES_CALL = [
  'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Failed Transaction',
  'Card Dispute', 'Statement Request', 'Loan Complaint', 'Collection',
  'FD Enquiry', 'App Download', 'Technical / App Issue', 'Pitching / Marketing',
  'Complaint (CBN reportable)', 'Others',
]

// outcome → the disposition it implies. Only the mechanical ones; a "completed" call's
// business result is a human judgement, so we leave that to the agent.
function autoDispositionFor(outcome: string, purpose: string): string | null {
  const list = dispositionsFor(purpose)
  switch (outcome) {
    case 'missed':
    case 'voicemail':
      return list.includes('Unreachable / No Answer') ? 'Unreachable / No Answer' : null
    case 'escalated':
      return list.includes('Escalated') ? 'Escalated' : null
    default:
      return null
  }
}

interface CallScriptStep { order: number; prompt: string; options?: string[] }
interface CallScript { id: number; ticket_type: string; name: string; steps: CallScriptStep[]; is_active: boolean }

// CallLogForm is the single implementation of "log a call" — every field, every
// auto-mapping rule and the submit itself. LogCallModal wraps it in a dialog; the
// Leads page renders it inline. They are the same code, which is the point: the
// Leads page used to carry a four-field copy that captured no CIF, no disposition
// and no ticket, and the two could drift apart indefinitely.
export function CallLogForm({ open, initial, onClose, onSaved, variant = 'modal' }: {
  open: boolean
  initial?: LogCallInitial
  onClose: () => void
  onSaved: () => void
  /** 'inline' drops the dialog chrome and the customer picker for a page that
   *  already shows who the call is with (the lead detail pane). */
  variant?: 'modal' | 'inline'
}) {
  const inline = variant === 'inline'
  const [form, setForm] = useState({
    customer_name: '', phone: '', customer_cif: '', direction: 'Inbound',
    outcome: 'completed', disposition: '', purpose: '', duration_seconds: '',
    callback_at: '', ticket_type: '', notes: '', resolution: '',
  })
  const [custPicked, setCustPicked] = useState(false)
  const [custManual, setCustManual] = useState(false)
  const [createTicket, setCreateTicket] = useState(false)
  const [saving, setSaving] = useState(false)
  const [callScript, setCallScript] = useState<CallScript | null>(null)
  const [scriptExpanded, setScriptExpanded] = useState(false)

  // Draft key — one per call context, so two agents (or two leads) never share a
  // draft and reopening the same lead restores that lead's own unsent notes.
  const draftKey = `o3c_calldraft_${initial?.leadId ?? ''}_${initial?.cif ?? ''}_${initial?.phone ?? ''}`

  // Seed the form when the context CHANGES — not on every re-render.
  //
  // This effect used to depend on `initial`, which callers build as an object
  // literal, so it was a new reference on every parent render. A background
  // refresh re-rendered the page, `initial` looked "new", and the form reset —
  // wiping whatever the agent had typed mid-call. Depending on the primitive
  // values means it fires only when the call being logged actually changes.
  //
  // Anything unsent is restored from the draft, so a refresh, a stray reload or a
  // closed tab no longer costs an agent their notes.
  const seedKey = `${open}|${initial?.leadId ?? ''}|${initial?.cif ?? ''}|${initial?.phone ?? ''}|${initial?.direction ?? ''}|${initial?.purpose ?? ''}`
  useEffect(() => {
    if (!open) return
    const dir = initial?.direction === 'Outbound' ? 'Outbound' : initial?.direction === 'Inbound' ? 'Inbound' : 'Inbound'
    const nm = initial?.name && initial.name !== 'Unknown' ? initial.name : ''
    const fresh = {
      customer_name: nm, phone: initial?.phone ?? '', customer_cif: initial?.cif ?? '',
      direction: dir, outcome: 'completed', disposition: '', purpose: initial?.purpose ?? '',
      duration_seconds: '', callback_at: '', ticket_type: '', notes: '', resolution: '',
    }
    let restored = false
    try {
      const saved = localStorage.getItem(draftKey)
      if (saved) {
        const d = JSON.parse(saved)
        // Only restore a draft with something actually in it; a blank one is noise.
        if (d && (d.notes || d.resolution || d.disposition)) {
          setForm({ ...fresh, ...d })
          restored = true
        }
      }
    } catch { /* a corrupt draft must never block logging a call */ }
    if (!restored) setForm(fresh)

    setCustPicked(false)
    setCustManual(!!(initial?.name || initial?.phone || initial?.cif))
    setCreateTicket(false)
    setCallScript(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey])


  // Persist the draft as it is typed. Debounced so a fast typist is not writing to
  // localStorage on every keystroke, and only for a form with real content.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      try {
        if (form.notes || form.resolution || form.disposition || form.duration_seconds) {
          localStorage.setItem(draftKey, JSON.stringify(form))
        }
      } catch { /* storage full or blocked — the form still works */ }
    }, 400)
    return () => clearTimeout(t)
  }, [open, form, draftKey])

  // Load the call script for the chosen ticket type (shown only while a ticket type is set).
  useEffect(() => {
    if (!open || !form.ticket_type) { setCallScript(null); return }
    apiFetch<any>(`/api/helpdesk/call-scripts/by-type?ticket_type=${encodeURIComponent(form.ticket_type)}`)
      .then(r => { const s = r?.data ?? r; setCallScript(s?.id ? s : null); setScriptExpanded(true) })
      .catch(() => setCallScript(null))
  }, [open, form.ticket_type])


  // ── Duration ───────────────────────────────────────────────────────────────
  //
  // Agents talk through Zoho Voice and log the call here afterwards. Asking them
  // to type the duration in seconds meant nobody ever did: every manually logged
  // call in the book has a NULL duration. So the form fills it in two ways, and
  // the agent can still override by typing.
  //
  //  1. Auto-match — look up the agent's most recent real call on this number and
  //     take its duration. That is the call they are logging.
  //  2. Live timer — for a call happening right now, start it and it fills as the
  //     conversation runs.
  const [durSource, setDurSource] = useState<'' | 'matched' | 'timer' | 'manual'>('')
  const [matchedCall, setMatchedCall] = useState<CallCandidate | null>(null)
  const [candidates, setCandidates] = useState<CallCandidate[]>([])
  const [timerFrom, setTimerFrom] = useState<number | null>(null)

  // Which call is this?
  //
  // The auto-match has to pick a window and no window is right: too wide and a
  // second attempt on a number inherits the first attempt's write-up; too narrow
  // and an agent writing up a call an hour later loses the duration and recording
  // entirely. The agent knows which call it is, so ask them — but only when the
  // answer is not obvious.
  useEffect(() => {
    if (!open) { setMatchedCall(null); setCandidates([]); return }
    const phone = form.phone.trim()
    if (!phone) { setMatchedCall(null); setCandidates([]); return }
    let alive = true
    apiFetch<any>(`/api/helpdesk/calls/candidates?phone=${encodeURIComponent(phone)}`)
      .then(res => {
        if (!alive) return
        const list: CallCandidate[] = Array.isArray(res) ? res : (res?.data ?? [])
        setCandidates(list)
        // Auto-select only when it is genuinely unambiguous: the most recent call
        // is recent AND actually connected. Otherwise leave it to the agent rather
        // than stamping a guess on their work.
        const best = list.find(c => (c.duration_sec ?? 0) > 5) ?? null
        const fresh = best && (Date.now() - new Date(best.started_at).getTime()) < 15 * 60_000
        if (best && fresh) selectCall(best)
      })
      .catch(() => { if (alive) { setMatchedCall(null); setCandidates([]) } })
    return () => { alive = false }
  }, [open, form.phone])

  // Attach to a specific call: adopt its duration, and its identity if we have none.
  function selectCall(c: CallCandidate | null) {
    setMatchedCall(c)
    if (!c) { setDurSource(s => (s === 'matched' ? '' : s)); return }
    if (c.duration_sec != null && c.duration_sec > 0) {
      setForm(f => ({ ...f, duration_seconds: String(c.duration_sec) }))
      setDurSource('matched')
    }
    setForm(f => ({
      ...f,
      direction: c.direction ? (c.direction.toLowerCase() === 'inbound' ? 'Inbound' : 'Outbound') : f.direction,
      customer_name: f.customer_name || c.customer_name || '',
      customer_cif: f.customer_cif || c.customer_cif || '',
    }))
  }

  // Live timer tick.
  useEffect(() => {
    if (timerFrom == null) return
    const id = setInterval(() => {
      setForm(f => ({ ...f, duration_seconds: String(Math.round((Date.now() - timerFrom) / 1000)) }))
    }, 1000)
    return () => clearInterval(id)
  }, [timerFrom])

  const dispositions = dispositionsFor(form.purpose)

  // ── Field auto-mapping ────────────────────────────────────────────────────
  const setPurpose = useCallback((purpose: string) => {
    setForm(f => {
      // Keep the disposition only if it still exists in the new purpose's list.
      const keep = dispositionsFor(purpose).includes(f.disposition) ? f.disposition : ''
      return { ...f, purpose, disposition: keep }
    })
  }, [])

  const setOutcome = useCallback((outcome: string) => {
    setForm(f => {
      const auto = autoDispositionFor(outcome, f.purpose)
      const disposition = auto ?? f.disposition
      return { ...f, outcome, disposition }
    })
  }, [])

  const setDisposition = useCallback((disposition: string) => {
    setForm(f => ({
      ...f,
      disposition,
      // Opening a follow-up ticket is auto-checked for dispositions that need one;
      // give the ticket the purpose's natural type if none is set yet.
      ticket_type: f.ticket_type || TICKET_TYPE_FOR_PURPOSE[f.purpose] || '',
    }))
    setCreateTicket(FOLLOWUP_DISPOSITIONS.has(disposition) && disposition !== CALLBACK_DISPOSITION
      ? true
      : createTicket)
  }, [createTicket])

  const needsCallback = form.disposition === CALLBACK_DISPOSITION
  // Display label: an unanswered inbound is a "Missed" call; an unanswered outbound dial
  // is "No Answer" (the customer didn't pick — not the agent's miss).
  const noAnswerLabel = form.direction === 'Inbound' ? 'Missed' : 'No Answer'

  function resetAndClose() {
    setCallScript(null)
    onClose()
  }

  async function submit() {
    if (!form.phone.trim() && !form.customer_cif.trim() && !form.customer_name.trim()) {
      toast.error('Add a customer (search) or a phone number'); return
    }
    if (createTicket && !form.ticket_type) {
      toast.error('Pick a ticket type to open a linked ticket'); return
    }
    if (needsCallback && !form.callback_at) {
      toast.error('Pick the date & time for the callback'); return
    }
    setSaving(true)
    try {
      // Optionally open a real follow-up ticket first (full pipeline: SLA, assignment,
      // first message) and link the call to it.
      let ticketRef: string | undefined
      if (createTicket) {
        const tRes = await apiPost<{ ticket?: { ticket_ref?: string } }>('/api/helpdesk/tickets', {
          channel:        'phone',
          subject:        `${form.ticket_type} — ${form.customer_name || form.phone || 'caller'}`,
          ticket_type:    form.ticket_type,
          priority:       dispositionPriority(form.disposition),
          customer_name:  form.customer_name || undefined,
          customer_cif:   form.customer_cif || undefined,
          customer_phone: form.phone || undefined,
          message_text:   form.notes.trim() || `Follow-up from call · ${form.disposition || 'logged'}`,
          custom_fields:  { disposition: form.disposition || '', resolution: form.resolution || '', source: 'call_log' },
        })
        ticketRef = tRes?.ticket?.ticket_ref
      }
      await apiPost('/api/helpdesk/calls', {
        customer_name:    form.customer_name || undefined,
        customer_cif:     form.customer_cif || undefined,
        customer_phone:   form.phone || undefined,
        direction:        form.direction,
        outcome:          form.outcome,
        disposition:      form.disposition || undefined,
        purpose:          form.purpose || undefined,
        duration_seconds: form.duration_seconds ? Number(form.duration_seconds) : undefined,
        ticket_type:      form.ticket_type || undefined,
        notes:            form.notes || undefined,
        resolution:       form.resolution || undefined,
        ticket_ref:       ticketRef,
        // Advances the lead in the same write when the call came from Leads.
        lead_id:          initial?.leadId,
        // Attach these notes to the real Voice call rather than creating a second
        // record. Without this the recording and duration live on one row and the
        // notes on another, and neither is the whole call.
        merge_call_id:    matchedCall?.id,
        callback_at:      needsCallback && form.callback_at ? form.callback_at : undefined,
      })
      // A scheduled callback drops into the outbound queue for this number.
      if (needsCallback && form.phone.trim()) {
        try {
          await apiPost('/api/call-center/queue/add-callback', {
            name: form.customer_name.trim(), phone: form.phone.trim(), cif: form.customer_cif.trim(),
            callback_at: form.callback_at, notes: form.notes.trim(),
          })
        } catch { /* the call itself logged; surface only the primary result */ }
      }
      // Submitted successfully — the draft has served its purpose.
      try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
      toast.success(ticketRef ? `Call logged · ticket ${ticketRef} opened`
        : needsCallback ? 'Call logged · callback scheduled' : 'Call logged')
      resetAndClose()
      onSaved()
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to log call')
    } finally { setSaving(false) }
  }

  const inputSt: React.CSSProperties = {
    width: '100%', height: 36, padding: '0 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box', fontFamily: SORA,
  }
  const labelSt: React.CSSProperties = {
    display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5,
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  //
  // The body is identical in both variants; only the chrome differs. Inline mode
  // has no dialog, no Cancel, and no customer picker — the lead pane above it
  // already names who is being called.
  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SORA }}>

        {/* Customer — search & autofill, with a manual (walk-in) fallback.
            Hidden inline: the lead pane directly above already shows the name,
            number and CIF, so repeating a picker there is noise. The name is
            still editable inline when the lead has none — see below. */}
        {!inline && (
        <div>
          <label style={labelSt}>Customer</label>
          {custPicked ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg }}>
              <div style={{ width: 36, height: 36, borderRadius: RADIUS.full, flexShrink: 0, background: `${NAVY}12`, color: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.sm, fontWeight: FW.extrabold }}>
                {initialsOf(form.customer_name)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* A linked record with no name still needs one — an inbound call
                    from an unknown number used to render "Unknown customer" with
                    no way to type who it actually was. */}
                {form.customer_name ? (
                  <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{form.customer_name}</div>
                ) : (
                  <input
                    value={form.customer_name}
                    onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
                    placeholder="Add the caller's name"
                    autoFocus
                    style={{ ...inputSt, height: 28, fontWeight: FW.bold, padding: '0 8px' }}
                  />
                )}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>
                  {form.customer_cif && <span style={{ fontFamily: 'var(--font-mono)' }}>CIF {form.customer_cif}</span>}
                  {form.phone && <span>{form.phone}</span>}
                </div>
              </div>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: GREEN, background: `${GREEN}14`, padding: '3px 9px', borderRadius: RADIUS.xl }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>Linked
              </span>
              <button type="button"
                onClick={() => { setForm(f => ({ ...f, customer_cif: '' })); setCustPicked(false); setCustManual(false) }}
                style={{ padding: '5px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                Change
              </button>
            </div>
          ) : custManual ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
                <input value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
                  placeholder="Customer name" style={inputSt} />
                <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="Phone e.g. 08012345678" style={inputSt} />
              </div>
              <button type="button" onClick={() => setCustManual(false)}
                style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'none', color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>search</span>Search for an existing customer instead
              </button>
            </div>
          ) : (
            <CustomerSearch
              autoFocus={false}
              onPick={(c: CustSuggest) => {
                setForm(f => ({ ...f, customer_name: cleanName(c.name), customer_cif: c.cif, phone: c.phone ?? f.phone }))
                setCustPicked(true)
              }}
              onManual={() => setCustManual(true)}
            />
          )}
        </div>
        )}

        {/* Inline: the lead may have no name yet, and the agent learns it on the
            call. This is the one customer field worth keeping in the lead pane. */}
        {inline && !form.customer_name && (
          <div>
            <label style={labelSt}>Caller name</label>
            <input value={form.customer_name}
              onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
              placeholder="Add the name once you have it" style={inputSt} />
          </div>
        )}

{/* Direction / Outcome / Duration.
            Inline (leads) drops Direction: working a lead list is outbound dialling
            by definition, and re-picking it on every call is a field the agent
            would set identically a hundred times a day. */}
        <div style={{ display: 'grid', gridTemplateColumns: inline ? '1fr 1fr' : '1fr 1fr 1fr', gap: SP[3] }}>
          {!inline && (
          <div>
            <label style={labelSt}>Direction</label>
            <select value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value }))} style={inputSt}>
              <option value="Inbound">Inbound</option>
              <option value="Outbound">Outbound</option>
            </select>
          </div>
          )}
          <div>
            <label style={labelSt}>Outcome</label>
            <select value={form.outcome} onChange={e => setOutcome(e.target.value)} style={inputSt}>
              <option value="completed">Connected</option>
              <option value="missed">{noAnswerLabel}</option>
              <option value="voicemail">Voicemail</option>
              <option value="transferred">Transferred</option>
              <option value="escalated">Escalated</option>
            </select>
          </div>
          <div>
            <label style={labelSt}>Duration</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="number" min={0} value={form.duration_seconds}
                onChange={e => { setForm(f => ({ ...f, duration_seconds: e.target.value })); setDurSource('manual'); setTimerFrom(null) }}
                placeholder="seconds" style={{ ...inputSt, flex: 1, minWidth: 0 }} />
              <button type="button"
                title={timerFrom == null ? 'Start timing this call' : 'Stop the timer'}
                onClick={() => {
                  if (timerFrom == null) { setTimerFrom(Date.now()); setDurSource('timer') }
                  else { setTimerFrom(null); setDurSource('manual') }
                }}
                style={{
                  flexShrink: 0, width: 34, borderRadius: RADIUS.md, cursor: 'pointer',
                  border: `1px solid ${timerFrom == null ? 'var(--bdr)' : GREEN}`,
                  background: timerFrom == null ? 'var(--card)' : `${GREEN}14`,
                  color: timerFrom == null ? 'var(--txt2)' : GREEN,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                <span className="material-symbols-rounded" style={{ fontSize: 17 }}>
                  {timerFrom == null ? 'timer' : 'stop_circle'}
                </span>
              </button>
            </div>
            {/* Say where the number came from — an auto-filled duration the agent
                cannot account for is one they will not trust. */}
{matchedCall && (
              <div style={{ fontSize: TEXT['2xs'], color: GREEN, marginTop: 3, lineHeight: 1.4 }}>
                Attaching to the {new Date(matchedCall.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} call
                {matchedCall.has_recording && ' · recorded'}
              </div>
            )}
            {durSource === 'timer' && (
              <div style={{ fontSize: TEXT['2xs'], color: GREEN, marginTop: 3 }}>Timing…</div>
            )}
            {!durSource && (
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3 }}>
                Auto-fills from Voice
              </div>
            )}
          </div>
        </div>

{/* Purpose / Disposition — the disposition list adapts to the purpose.
            Inline (leads) drops Purpose: a lead call is a marketing call, set from
            the lead itself, and the disposition list is already narrowed to that
            book. */}
        <div style={{ display: 'grid', gridTemplateColumns: inline ? '1fr' : '1fr 1fr', gap: SP[3] }}>
          {!inline && (
          <div>
            <label style={labelSt}>Call purpose / links to</label>
            <select value={form.purpose} onChange={e => setPurpose(e.target.value)} style={inputSt}>
              {CALL_PURPOSES.map(p => <option key={p.value || 'support'} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          )}
          <div>
            <label style={labelSt}>Disposition</label>
            <select value={form.disposition} onChange={e => setDisposition(e.target.value)} style={inputSt}>
              <option value="">— Select —</option>
              {dispositions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        {/* Callback time — only when the disposition is a scheduled callback */}
        {needsCallback && (
          <div style={{ padding: 12, background: `${AMBER}0d`, borderRadius: RADIUS.md, border: `1px solid ${AMBER}28` }}>
            <label style={labelSt}>Call back at</label>
            <input type="datetime-local" value={form.callback_at}
              onChange={e => setForm(f => ({ ...f, callback_at: e.target.value }))} style={inputSt} />
          </div>
        )}

        {/* Open a linked follow-up ticket (auto-checked for follow-up dispositions) */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm, color: 'var(--txt)', cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={createTicket} onChange={e => setCreateTicket(e.target.checked)} style={{ accentColor: NAVY, width: 15, height: 15 }} />
          Open a linked follow-up ticket
          {createTicket && !form.ticket_type && <span style={{ color: AMBER, fontSize: TEXT.xs }}>— pick a ticket type below</span>}
        </label>

        {/* Ticket type — only shown when a ticket is being opened */}
        {createTicket && (
          <div>
            <label style={labelSt}>Ticket Type</label>
            <select value={form.ticket_type} onChange={e => setForm(f => ({ ...f, ticket_type: e.target.value }))} style={inputSt}>
              <option value="">— Select —</option>
              {TICKET_TYPES_CALL.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}

        {/* Customer complaint / summary */}
        <div>
          <label style={labelSt}>Customer complaint / summary</label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            rows={3} placeholder="What the customer called about…"
            style={{ ...inputSt, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 }} />
        </div>

        {/* Agent response / resolution */}
        <div>
          <label style={labelSt}>Agent response / resolution</label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.resolution} onChange={e => setForm(f => ({ ...f, resolution: e.target.value }))}
            rows={3} placeholder="What you did / how it was resolved…"
            style={{ ...inputSt, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 }} />
        </div>

        {/* Call script panel (by ticket type) */}
        {callScript && (
          <div style={{ border: `1px solid ${NAVY}25`, borderRadius: RADIUS.md, overflow: 'hidden' }}>
            <button type="button" onClick={() => setScriptExpanded(x => !x)}
              style={{ width: '100%', padding: '9px 14px', background: `${NAVY}08`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: SORA }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>assignment</span>
                {callScript.name}
              </span>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{scriptExpanded ? '▲' : '▼'}</span>
            </button>
            {scriptExpanded && (
              <div style={{ padding: '10px 14px 14px', display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                {[...callScript.steps].sort((a, b) => a.order - b.order).map(step => (
                  <div key={step.order} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: NAVY, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold }}>
                      {step.order}
                    </div>
                    <div style={{ fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.5 }}>
                      {step.prompt}
                      {step.options && step.options.length > 0 && (
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: SP[1] }}>
                          {step.options.map((opt, i) => (
                            <span key={i} style={{ fontSize: TEXT.xs, padding: '1px 7px', borderRadius: RADIUS.lg, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>{opt}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
  )

  const actions = (
    <div style={{ display: 'flex', gap: SP[2], justifyContent: inline ? 'stretch' : 'flex-end' }}>
      {!inline && (
        <button onClick={resetAndClose}
          style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
          Cancel
        </button>
      )}
      <button onClick={submit} disabled={saving}
        style={{
          padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY,
          color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
          cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: SP[2],
          flex: inline ? 1 : undefined,
        }}>
        {saving && <Spinner size={13} color="#fff" />}
        Log Call
      </button>
    </div>
  )

  if (inline) {
    if (!open) return null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {body}
        {actions}
      </div>
    )
  }

  return (
    <Modal open={open} onClose={resetAndClose} title="Log a Call" width={500} footer={actions}>
      {body}
    </Modal>
  )
}

// LogCallModal is the dialog form of CallLogForm, used everywhere a call is logged
// from a list or a header action.
export default function LogCallModal(props: {
  open: boolean
  initial?: LogCallInitial
  onClose: () => void
  onSaved: () => void
}) {
  return <CallLogForm {...props} variant="modal" />
}

/**
 * How an outcome should read, given the direction of the call.
 *
 * "Missed" is a word about US: nobody here picked up. On an OUTBOUND dial the
 * customer did not answer, which is "No Answer" — not a miss by the agent, and
 * agents reasonably objected to seeing their own outbound calls described that
 * way in a lead's history.
 *
 * Zoho stores one value ("missed") for both, so the label has to be derived at
 * display time rather than stored.
 */
export function callOutcomeLabel(
  outcome?: string | null,
  direction?: string | null,
  durationSec?: number | null,
  hasRecording?: boolean | null,
): string {
  const o = (outcome ?? '').trim().toLowerCase()
  const outbound = (direction ?? '').trim().toLowerCase() === 'outbound'

  // Zoho Desk writes a call record for activity that never reached the phone —
  // 970 of today's rows have no duration AND no recording, and 40 of those are
  // marked 'completed'. Rendering those as "Connected" tells an agent a
  // conversation happened when none did. If nothing was said and nothing was
  // recorded, it was a dial, not a call.
  const empty = !durationSec && !hasRecording
  if (o === 'completed' && empty) return outbound ? 'No Answer' : 'Not Connected'

  switch (o) {
    case 'missed':
    case 'no_answer':
    case 'no answer':
      return outbound ? 'No Answer' : 'Missed'
    case 'completed':
      return 'Connected'
    case 'voicemail':
      return 'Voicemail'
    case '':
      return outbound ? 'Outbound' : 'Inbound'
  }
  // Anything else: title-case whatever was stored rather than hiding it.
  return o.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
}

// ── Grouping a dialling episode into one conversation ─────────────────────────
//
// Zoho Desk writes a call record per activity, not per conversation. One attempt
// on a lead routinely lands as four rows — 13:02, 13:03, 13:03, 13:08 — of which
// three have no duration and no recording because nothing reached the phone. Read
// literally that is "4 calls", three of them contradicting each other, and it is
// what made a single unanswered dial look like a lead being harassed.
//
// A conversation is a run of calls in the same direction whose starts are within
// `windowMin` of each other. The representative is the leg where something
// actually happened; the rest become an attempt count. A write-up on any leg is
// surfaced on the group, so folding rows in never hides what an agent typed.

export interface GroupableCall {
  id:                 number
  started_at:         string | null
  direction:          string | null
  outcome:            string | null
  duration_sec:       number | null
  recording_filename: string | null
  disposition?:       string | null
  notes?:             string | null
}

export interface CallConversation<T extends GroupableCall> {
  call:      T       // the leg worth showing
  members:   T[]     // every leg, oldest first
  attempts:  number  // how many times the number was dialled in this episode
  firstAt:   string | null
  notes:     string  // the write-up from whichever leg carries one
  disposition: string
}

const callConnected = (c: GroupableCall) => (c.duration_sec ?? 0) > 0 || !!c.recording_filename
const wroteUp = (c: GroupableCall) => !!(c.notes?.trim() || c.disposition?.trim())

export function groupCallConversations<T extends GroupableCall>(
  calls: T[], windowMin = 15,
): CallConversation<T>[] {
  const ms = (c: T) => (c.started_at ? new Date(c.started_at).getTime() : 0)
  const sorted = [...calls].sort((a, b) => ms(a) - ms(b))
  const gap = windowMin * 60_000

  const groups: T[][] = []
  for (const c of sorted) {
    const g = groups[groups.length - 1]
    const prev = g?.[g.length - 1]
    const sameLeg = prev
      && (prev.direction ?? '').toLowerCase() === (c.direction ?? '').toLowerCase()
      // A call with no timestamp cannot be shown to belong to the episode beside
      // it, so it stands alone rather than being absorbed on a guess.
      && ms(prev) > 0 && ms(c) > 0
      && ms(c) - ms(prev) <= gap
    if (sameLeg) g.push(c)
    else groups.push([c])
  }

  return groups.map(members => {
    // Rank: a real conversation beats a dial; among dials, one carrying a
    // write-up beats a bare artefact row; ties go to the longer call.
    const rank = (c: T) => (callConnected(c) ? 2 : 0) + (wroteUp(c) ? 1 : 0)
    const call = members.reduce((best, c) => {
      const d = rank(c) - rank(best)
      return d > 0 || (d === 0 && (c.duration_sec ?? 0) > (best.duration_sec ?? 0)) ? c : best
    }, members[0])
    const withNotes = members.find(c => c.notes?.trim())
    const withDisp  = members.find(c => c.disposition?.trim())
    return {
      call,
      members,
      attempts:    members.length,
      firstAt:     members[0].started_at,
      notes:       withNotes?.notes?.trim() ?? '',
      disposition: withDisp?.disposition?.trim() ?? '',
    }
  }).reverse()  // newest episode first
}
