import { useState, useEffect } from 'react'
import { Modal } from './UI'
import { apiFetch } from '../lib/api'
import { RED, NAVY, FW, RADIUS, TEXT } from '../lib/design'
import { toast } from 'sonner'
import { dispositionsFor } from './LogCallModal'

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
  const [disposition, setDisposition] = useState(call.disposition ?? '')
  const [notes,       setNotes]       = useState(call.notes ?? '')
  const [resolution,  setResolution]  = useState(call.resolution ?? '')
  const [duration,    setDuration]    = useState(String(call.duration_seconds ?? ''))
  const [direction,   setDirection]   = useState((call.direction || 'outbound').toLowerCase())
  const [reason,      setReason]      = useState('')
  const [mode,        setMode]        = useState<'edit' | 'void'>('edit')
  const [saving,      setSaving]      = useState(false)

  useEffect(() => {
    setDisposition(call.disposition ?? ''); setNotes(call.notes ?? '')
    setResolution(call.resolution ?? ''); setDuration(String(call.duration_seconds ?? ''))
    setDirection((call.direction || 'outbound').toLowerCase()); setReason(''); setMode('edit')
  }, [call])

  const options = dispositionsFor((call.purpose ?? '').toLowerCase())

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
        await apiFetch(`/api/helpdesk/calls/${call.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            disposition, notes, resolution, direction,
            duration_sec: dur, reason: reason.trim(),
          }),
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
      title={`Correct call log — ${call.customer_name || call.phone || 'call'}`}
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
            {saving ? 'Saving…' : mode === 'void' ? 'Withdraw this log' : 'Save correction'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setMode('edit')} style={tab(mode === 'edit')}>Correct it</button>
          <button onClick={() => setMode('void')} style={tab(mode === 'void')}>Withdraw it</button>
        </div>

        {mode === 'void' ? (
          <>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
              The call itself stays in the record — what you are withdrawing is the
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
              <label style={lbl}>Duration (seconds)</label>
              <input value={duration} onChange={e => setDuration(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric" style={inp} />
            </div>
            <div>
              <label style={lbl}>Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} style={{ ...inp, resize: 'vertical' }} />
            </div>
            <div>
              <label style={lbl}>Resolution</label>
              <input value={resolution} onChange={e => setResolution(e.target.value)} style={inp} />
            </div>
            <div>
              <label style={lbl}>Reason for the correction (optional, shown to supervisors)</label>
              <input value={reason} onChange={e => setReason(e.target.value)}
                placeholder="e.g. picked the wrong disposition" style={inp} />
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
