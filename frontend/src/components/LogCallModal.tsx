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
  'Callback Scheduled', 'Pending / Follow-up', 'Unreachable / No Answer',
]
const DISPOSITIONS_BY_PURPOSE: Record<string, string[]> = {
  '':           SUPPORT_DISPOSITIONS,
  support:      SUPPORT_DISPOSITIONS,
  marketing:    ['Interested', 'Not Interested', 'Converted', 'Callback Scheduled', 'Wrong Number', 'Do Not Call', 'Unreachable / No Answer'],
  sales:        ['Interested', 'Not Interested', 'Converted', 'Callback Scheduled', 'Wrong Number', 'Do Not Call', 'Unreachable / No Answer'],
  collections:  ['Promise to Pay', 'Paid', 'Dispute', 'Callback Scheduled', 'Escalated', 'Wrong Number', 'Unreachable / No Answer'],
}
function dispositionsFor(purpose: string): string[] {
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

export default function LogCallModal({ open, initial, onClose, onSaved }: {
  open: boolean
  initial?: LogCallInitial
  onClose: () => void
  onSaved: () => void
}) {
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

  // Reset to the caller's context each time the modal opens.
  useEffect(() => {
    if (!open) return
    const dir = initial?.direction === 'Outbound' ? 'Outbound' : initial?.direction === 'Inbound' ? 'Inbound' : 'Inbound'
    const nm = initial?.name && initial.name !== 'Unknown' ? initial.name : ''
    setForm({
      customer_name: nm, phone: initial?.phone ?? '', customer_cif: initial?.cif ?? '',
      direction: dir, outcome: 'completed', disposition: '', purpose: initial?.purpose ?? '',
      duration_seconds: '', callback_at: '', ticket_type: '', notes: '', resolution: '',
    })
    // If we already know who this is (prefilled), skip straight to the manual view so
    // the agent isn't forced back through search.
    setCustPicked(false)
    setCustManual(!!(initial?.name || initial?.phone || initial?.cif))
    setCreateTicket(false)
    setCallScript(null)
  }, [open, initial])

  // Load the call script for the chosen ticket type (shown only while a ticket type is set).
  useEffect(() => {
    if (!open || !form.ticket_type) { setCallScript(null); return }
    apiFetch<any>(`/api/helpdesk/call-scripts/by-type?ticket_type=${encodeURIComponent(form.ticket_type)}`)
      .then(r => { const s = r?.data ?? r; setCallScript(s?.id ? s : null); setScriptExpanded(true) })
      .catch(() => setCallScript(null))
  }, [open, form.ticket_type])

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

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title="Log a Call"
      width={500}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={resetAndClose}
            style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={submit} disabled={saving}
            style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
            {saving && <Spinner size={13} color="#fff" />}
            Log Call
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SORA }}>

        {/* Customer — search & autofill, with a manual (walk-in) fallback */}
        <div>
          <label style={labelSt}>Customer</label>
          {custPicked ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg }}>
              <div style={{ width: 36, height: 36, borderRadius: RADIUS.full, flexShrink: 0, background: `${NAVY}12`, color: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.sm, fontWeight: FW.extrabold }}>
                {initialsOf(form.customer_name)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{form.customer_name || 'Unknown customer'}</div>
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

        {/* Direction / Outcome / Duration */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SP[3] }}>
          <div>
            <label style={labelSt}>Direction</label>
            <select value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value }))} style={inputSt}>
              <option value="Inbound">Inbound</option>
              <option value="Outbound">Outbound</option>
            </select>
          </div>
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
            <label style={labelSt} title="Auto-captured from Zoho Voice on synced calls; enter it only for a manually logged call">Duration (sec)</label>
            <input type="number" min={0} value={form.duration_seconds}
              onChange={e => setForm(f => ({ ...f, duration_seconds: e.target.value }))}
              placeholder="auto for voice" style={inputSt} />
          </div>
        </div>

        {/* Purpose / Disposition — disposition list adapts to the purpose */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div>
            <label style={labelSt}>Call purpose / links to</label>
            <select value={form.purpose} onChange={e => setPurpose(e.target.value)} style={inputSt}>
              {CALL_PURPOSES.map(p => <option key={p.value || 'support'} value={p.value}>{p.label}</option>)}
            </select>
          </div>
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
    </Modal>
  )
}
