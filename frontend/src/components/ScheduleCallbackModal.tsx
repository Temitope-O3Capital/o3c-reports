import { useState, useEffect } from 'react'
import { Modal, Spinner } from './UI'
import { CustomerSearch, cleanName } from './CustomerSearch'
import { apiPost } from '../lib/api'
import { NAVY, FW, RADIUS, SP, TEXT } from '../lib/design'
import { toast } from 'sonner'

// Schedule a call-back for a customer. It creates a support contact in the outbound
// queue with a callback time, assigned to whoever schedules it, so it surfaces in
// THEIR queue (the "ready" bucket) when due. Shared by the dashboard and call log.
export default function ScheduleCallbackModal({ open, onClose, onSaved, initial }: {
  open: boolean
  onClose: () => void
  onSaved?: () => void
  initial?: { name?: string; phone?: string; cif?: string }
}) {
  const [name, setName]   = useState('')
  const [phone, setPhone] = useState('')
  const [cif, setCif]     = useState('')
  const [when, setWhen]   = useState('') // datetime-local; empty = call back ASAP
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(initial?.name && initial.name !== 'Unknown' ? cleanName(initial.name) : '')
    setPhone(initial?.phone ?? '')
    setCif(initial?.cif ?? '')
    setWhen(''); setNotes('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!phone.trim()) { toast.error('A phone number is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/call-center/queue/add-callback', {
        name: name.trim(), phone: phone.trim(), cif: cif.trim(),
        callback_at: when, // ISO local (e.g. 2026-08-14T15:30); server casts to timestamptz
        notes: notes.trim(),
      })
      toast.success(when ? 'Callback scheduled' : 'Callback added to your queue')
      onClose(); onSaved?.()
    } catch (e: any) { toast.error(e?.message || 'Could not schedule callback') }
    finally { setSaving(false) }
  }

  const fld: React.CSSProperties = { width: '100%', height: 38, padding: '0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.03em' }

  return (
    <Modal open={open} onClose={onClose} title="Schedule a callback" width={480}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer' }}>
            {saving && <Spinner size={13} color="#fff" />}Schedule
          </button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div>
          <label style={lbl}>Find customer</label>
          <CustomerSearch autoFocus placeholder="Search name, CIF or phone…"
            onPick={c => { setName(cleanName(c.name)); setPhone(c.phone ?? ''); setCif(c.cif ?? '') }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div><label style={lbl}>Customer</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" style={fld} /></div>
          <div><label style={lbl}>Phone</label><input value={phone} onChange={e => setPhone(e.target.value)} placeholder="080…" style={fld} /></div>
        </div>
        <div>
          <label style={lbl}>Call back at <span style={{ textTransform: 'none', color: 'var(--txt3)', fontWeight: FW.normal }}>(leave blank for ASAP)</span></label>
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={fld} />
        </div>
        <div>
          <label style={lbl}>Note</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="e.g. ask for Mr X after 3pm; promised to pay Friday…" style={{ ...fld, height: 'auto', padding: '9px 11px', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
      </div>
    </Modal>
  )
}
