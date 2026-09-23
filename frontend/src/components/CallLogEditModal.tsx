import { useState, useEffect } from 'react'
import { Modal } from './UI'
import { apiFetch } from '../lib/api'
import { RED, NAVY, FW, RADIUS, TEXT } from '../lib/design'
import { toast } from 'sonner'
import { dispositionsFor, dispositionCopy } from './LogCallModal'

// Correcting a call log after the fact.
//
// An agent who picks the wrong disposition, or whose write-up lands on the wrong
// call, previously had no way to fix it — so the mistake stayed in the record and
// in the lead's status. This is that correction, and its counterpart: withdrawing
// a log that should not exist.
//
// Withdrawing is a VOID, not a delete. The call still happened; what is being
// retracted is the agent's account of it. The row stays, struck out, visible to a
// supervisor with the reason attached, and restorable. Every change here is
// written to helpdesk_call_edits with the previous value, so a correction can
// always be read back against what it replaced.

export interface EditableCall {
  id:            number
  agent_name?:   string
  customer_name: string | null
  phone?:        string
  direction:     string
  duration_seconds?: number | null
  disposition:   string | null
  purpose?:      string | null
  notes:         string | null
  resolution?:   string | null
}

export default function CallLogEditModal({ call, onClose, onSaved }: {
  call: EditableCall
  onClose: () => void
  onSaved: () => void
}) {
  // What the form was seeded with. save() sends only the fields that actually differ
  // from this, so a field the form never loaded cannot be written back as a blank.
  const seeded = {
    disposition: call.disposition ?? '',
    notes:       call.notes ?? '',
    resolution:  call.resolution ?? '',
    duration:    String(call.duration_seconds ?? ''),
    direction:   (call.direction || 'outbound').toLowerCase(),
  }
  // The review queue carries no resolution, so a call opened from there has a field
  // this form genuinely does not know. undefined is "not loaded" — a different thing
  // from "empty", which is what it used to be saved back to the record as.
  const resolutionKnown = call.resolution !== undefined

  const [disposition, setDisposition] = useState(seeded.disposition)
  const [notes,       setNotes]       = useState(seeded.notes)
  const [resolution,  setResolution]  = useState(seeded.resolution)
  const [duration,    setDuration]    = useState(seeded.duration)
  const [direction,   setDirection]   = useState(seeded.direction)
  const [reason,      setReason]      = useState('')
  const [mode,        setMode]        = useState<'edit' | 'void'>('edit')
  const [saving,      setSaving]      = useState(false)

  // Keyed on the call's id, not the object: callers build `call` as an object literal,
  // so depending on the object reset the form on every parent re-render — including a
  // background refresh arriving while the supervisor was typing the correction.
  useEffect(() => {
    setDisposition(call.disposition ?? ''); setNotes(call.notes ?? '')
    setResolution(call.resolution ?? ''); setDuration(String(call.duration_seconds ?? ''))
    setDirection((call.direction || 'outbound').toLowerCase()); setReason(''); setMode('edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id])

  const purpose = (call.purpose ?? '').toLowerCase()
  const options = dispositionsFor(purpose)
  // Same field mapping the log form uses — driven by the disposition being edited —
  // so correcting a call reads as the same form the agent filled, not a generic one.
  const copy = dispositionCopy(disposition, purpose)

  async function save() {
    setSaving(true)
    try {
      if (mode === 'void') {
        // The reason is required by the API, not just the form: a log withdrawn
        // without one tells a supervisor nothing when they find it later.
        await apiFetch(`/api/helpdesk/calls/${call.id}/void`, {
          method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
        })
        toast.success('Log withdrawn')
      } else {
        const dur = duration.trim() === '' ? undefined : Math.max(0, parseInt(duration, 10) || 0)
        // Only what the supervisor actually changed. The API writes every field it is
        // given, so sending the whole form blanked anything this modal never loaded —
        // which is how correcting a flagged call erased the agent's write-up.
        const patch: Record<string, unknown> = { reason: reason.trim() }
        if (disposition !== seeded.disposition) patch.disposition = disposition
        if (notes !== seeded.notes) patch.notes = notes
        if (resolutionKnown && resolution !== seeded.resolution) patch.resolution = resolution
        if (direction !== seeded.direction) patch.direction = direction
        if (dur !== undefined && String(dur) !== seeded.duration) patch.duration_sec = dur
        if (Object.keys(patch).length === 1) {
          toast.error('Nothing has been changed yet')
          return
        }
        await apiFetch(`/api/helpdesk/calls/${call.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })
        toast.success('Call log corrected')
      }
      onSaved(); onClose()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base,
    border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', boxSizing: 'border-box',
  }
  const lbl: React.CSSProperties = {
    display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4,
  }
  const tab = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
    borderRadius: RADIUS.md, border: '1px solid ' + (active ? 'transparent' : 'var(--bdr)'),
    background: active ? (mode === 'void' ? `${RED}12` : `${NAVY}0F`) : 'transparent',
    color: active ? (mode === 'void' ? RED : NAVY) : 'var(--txt2)',
  })

  return (
    <Modal open onClose={onClose} width={520}
      title={`Correct Call Log: ${call.customer_name || call.phone || 'call'}`}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving || (mode === 'void' && !reason.trim())}
            style={{
              padding: '8px 18px', borderRadius: RADIUS.md, border: 'none',
              background: mode === 'void' ? RED : NAVY, color: '#fff', fontSize: TEXT.base,
              fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer',
              opacity: saving || (mode === 'void' && !reason.trim()) ? 0.6 : 1,
            }}>
            {saving ? 'Saving…' : mode === 'void' ? 'Withdraw This Log' : 'Save Correction'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setMode('edit')} style={tab(mode === 'edit')}>Correct It</button>
          <button onClick={() => setMode('void')} style={tab(mode === 'void')}>Withdraw It</button>
        </div>

        {mode === 'void' ? (
          <>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
              The call itself stays in the record. What you are withdrawing is the
              write-up. It disappears from the call log and the lead's history, and
              a supervisor can see it and put it back.
            </div>
            <div>
              <label style={lbl}>Why is this being withdrawn? (required)</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
                placeholder="e.g. logged against the wrong customer" style={{ ...inp, resize: 'vertical' }} autoFocus />
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Disposition</label>
                <select value={disposition} onChange={e => setDisposition(e.target.value)} style={inp}>
                  <option value="">—</option>
                  {options.map(d => <option key={d} value={d}>{d}</option>)}
                  {/* A disposition stored before it was in the list stays selectable
                      rather than silently resetting to blank on save. */}
                  {disposition && !options.includes(disposition) && <option value={disposition}>{disposition}</option>}
                </select>
              </div>
              <div>
                <label style={lbl}>Direction</label>
                <select value={direction} onChange={e => setDirection(e.target.value)} style={inp}>
                  <option value="outbound">Outbound</option>
                  <option value="inbound">Inbound</option>
                </select>
              </div>
            </div>
            <div>
              <label style={lbl}>Duration (Seconds)</label>
              <input value={duration} onChange={e => setDuration(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric" style={inp} />
            </div>
            <div>
              <label style={lbl}>{copy.notesLabel}</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} placeholder={copy.notesPh} style={{ ...inp, resize: 'vertical' }} />
            </div>
            {/* Only shown when its current value was loaded: offering an empty box for
                a write-up we cannot see invites a supervisor to overwrite it blind. */}
            {!copy.hideRes && resolutionKnown && (
              <div>
                <label style={lbl}>{copy.resLabel}</label>
                <input value={resolution} onChange={e => setResolution(e.target.value)} placeholder={copy.resPh} style={inp} />
              </div>
            )}
            <div>
              <label style={lbl}>Reason for the Correction (Optional, Shown to Supervisors)</label>
              <input value={reason} onChange={e => setReason(e.target.value)}
                placeholder="e.g. picked the wrong disposition" style={inp} />
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
