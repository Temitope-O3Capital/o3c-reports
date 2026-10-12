import { useState } from 'react'
import { Modal, Button, Input } from '../../components/UI'
import { SelectMenuField } from '../../components/SelectMenu'
import { apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { TEXT, FW, SP } from '../../lib/design'

// Put something in the diary.
//
// Opened from the lead (where the officer already knows who and where) and from the
// calendar (where they already know when), so both the contact and the day are passed
// in rather than asked for twice.
//
// The address defaults from the lead's own city and state, which is the point of making
// the call centre capture them: an officer planning Thursday should not have to go and
// find out where the customer lives.

const KINDS = [
  { value: 'visit', label: 'Visit' },
  { value: 'call', label: 'Call' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'follow_up', label: 'Follow-Up' },
]

export function PlanVisitModal({ contactId, contactName, city, state, day, officerId, onClose, onDone }: {
  contactId?: number
  contactName?: string
  city?: string
  state?: string
  /** Pre-filled when planning from a day on the calendar. */
  day?: string
  /** A head planning for one of their officers; omitted means "my own diary". */
  officerId?: number
  onClose: () => void
  onDone: () => void
}) {
  const [kind, setKind] = useState('visit')
  const [plannedFor, setPlannedFor] = useState(day ?? new Date().toISOString().slice(0, 10))
  const [time, setTime] = useState('')
  const [title, setTitle] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!plannedFor) { toast.error('Pick a day'); return }
    setSaving(true)
    try {
      await apiPost('/api/sales/visit-plans', {
        contact_id: contactId,
        officer_id: officerId,
        kind,
        planned_for: plannedFor,
        // A time is optional on purpose: most field work is planned to a day, not an
        // hour, and forcing a time would have officers typing 09:00 to mean "sometime".
        planned_at: time ? `${plannedFor}T${time}` : '',
        title: title.trim(),
        address: address.trim(),
        notes: notes.trim(),
        city, state,
      })
      toast.success(kind === 'visit' ? 'Visit planned' : 'Added to your diary')
      onDone()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save the plan')
    } finally { setSaving(false) }
  }

  const where = [city, state].filter(Boolean).join(', ')

  return (
    <Modal open onClose={onClose} title={contactName ? `Plan — ${contactName}` : 'Plan Something'} width={480}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>Add to Diary</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        {where && (
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            Location on file: <strong style={{ color: 'var(--txt)' }}>{where}</strong>
          </div>
        )}
        <SelectMenuField label="What" value={kind} onChange={setKind} options={KINDS} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <Input label="Day" type="date" value={plannedFor} onChange={e => setPlannedFor(e.target.value)} />
          <Input label="Time (Optional)" type="time" value={time} onChange={e => setTime(e.target.value)} />
        </div>
        <Input label="What For (Optional)" value={title} onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Take the card application" />
        <Input label="Address (Optional)" value={address} onChange={e => setAddress(e.target.value)}
          placeholder={where ? `Somewhere in ${where}` : 'Where you are going'} />
        <div>
          <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>
            Notes (Optional)
          </label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 8, resize: 'vertical',
              border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
              color: 'var(--txt)', fontSize: TEXT.base, boxSizing: 'border-box',
            }} />
        </div>
      </div>
    </Modal>
  )
}
