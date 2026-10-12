import { useEffect, useRef, useState } from 'react'
import { Modal, Button, Input, Spinner } from '../../components/UI'
import { SelectMenuField } from '../../components/SelectMenu'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { TEXT, FW, SP, RADIUS, NAVY, AMBER } from '../../lib/design'

// Put something in the diary.
//
// Opened from three places, and it has to behave differently in each:
//
//   the lead      — who is already known, so no picker. This is the common path.
//   the calendar  — the day is known, the person is not, so it must ask. A plan with
//                   nobody attached is refused by the server, because closing it would
//                   log work against no record and it could never carry an address.
//   a supervisor  — planning into somebody else's week, so it also asks whose.
//
// The address defaults from the lead's own city and state, which is the whole point of
// making the call centre capture them: an officer planning Thursday should not have to
// go and find out where the customer lives.

const KINDS = [
  { value: 'visit', label: 'Visit' },
  { value: 'call', label: 'Call' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'follow_up', label: 'Follow-Up' },
]

interface LeadHit {
  id: number
  first_name?: string
  last_name?: string
  phone?: string
  city?: string
  state?: string
  lead_stage?: string
}
export interface PlanOfficer { id: number; full_name: string }

export function PlanVisitModal({
  contactId, contactName, city, state, day, officerId, officers, onClose, onDone,
}: {
  contactId?: number
  contactName?: string
  city?: string
  state?: string
  /** Pre-filled when planning from a day on the calendar. */
  day?: string
  /** A head planning into one officer's diary; omitted means "my own". */
  officerId?: number
  /** When given, the head may choose whose diary this lands in. */
  officers?: PlanOfficer[]
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
  const [whose, setWhose] = useState(officerId ? String(officerId) : '')

  // The person this is for. Fixed when the modal came from a lead; searched otherwise.
  const [picked, setPicked] = useState<LeadHit | null>(
    contactId ? { id: contactId, first_name: contactName, city, state } : null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<LeadHit[]>([])
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (contactId || picked) return
    if (query.trim().length < 2) { setHits([]); return }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await apiFetch<any>(`/api/sales/leads?q=${encodeURIComponent(query.trim())}&limit=8`)
        setHits((res?.data ?? res ?? []).slice(0, 8))
      } catch { setHits([]) } finally { setSearching(false) }
    }, 250)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [query, contactId, picked])

  const who = picked
    ? [picked.first_name, picked.last_name].filter(Boolean).join(' ') || `Lead ${picked.id}`
    : ''
  const where = [picked?.city, picked?.state].filter(Boolean).join(', ')

  async function save() {
    if (!picked) { toast.error('Pick the lead or customer this is for'); return }
    if (!plannedFor) { toast.error('Pick a day'); return }
    setSaving(true)
    try {
      await apiPost('/api/sales/visit-plans', {
        contact_id: picked.id,
        officer_id: whose ? Number(whose) : undefined,
        kind,
        planned_for: plannedFor,
        // A time is optional on purpose: most field work is planned to a day, not an
        // hour, and forcing one would have officers typing 09:00 to mean "sometime".
        planned_at: time ? `${plannedFor}T${time}` : '',
        title: title.trim(),
        address: address.trim(),
        notes: notes.trim(),
        city: picked.city, state: picked.state,
      })
      toast.success(kind === 'visit' ? 'Visit planned' : 'Added to the diary')
      onDone()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save the plan')
    } finally { setSaving(false) }
  }

  const labelSt: React.CSSProperties = {
    display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5,
  }

  return (
    <Modal open onClose={onClose} title={contactName ? `Plan — ${contactName}` : 'Plan Something'} width={500}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!picked} onClick={save}>Add to Diary</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>

        {/* Who it is for. Fixed and stated when the lead is already known; searched
            when it is not, because the server refuses a plan attached to nobody. */}
        {picked ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: SP[2], padding: `${SP[2]} ${SP[3]}`,
            borderRadius: RADIUS.md, background: 'var(--th-bg)', border: '1px solid var(--bdr)',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17, color: NAVY }}>person</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{who}</div>
              <div style={{ fontSize: TEXT.xs, color: where ? 'var(--txt2)' : AMBER }}>
                {where || 'No location on file — add an address below'}
              </div>
            </div>
            {!contactId && (
              <Button size="xs" variant="ghost" onClick={() => { setPicked(null); setQuery('') }}>Change</Button>
            )}
          </div>
        ) : (
          <div>
            <label style={labelSt}>Who Is It For</label>
            <Input value={query} onChange={e => setQuery(e.target.value)} autoFocus
              placeholder="Search your leads by name or phone…" />
            {searching && <div style={{ padding: SP[2] }}><Spinner size={14} /></div>}
            {hits.length > 0 && (
              <div style={{
                marginTop: 6, border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
                overflow: 'hidden', background: 'var(--card)',
              }}>
                {hits.map(h => {
                  const nm = [h.first_name, h.last_name].filter(Boolean).join(' ') || `Lead ${h.id}`
                  const wh = [h.city, h.state].filter(Boolean).join(', ')
                  return (
                    <button key={h.id} onClick={() => { setPicked(h); setHits([]) }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '8px 11px',
                        border: 'none', borderBottom: '1px solid var(--bdr)', cursor: 'pointer',
                        background: 'transparent', color: 'var(--txt)', fontSize: TEXT.sm,
                      }}>
                      <div style={{ fontWeight: FW.semibold }}>{nm}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                        {[wh, h.phone].filter(Boolean).join(' · ') || 'No location on file'}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
            {query.trim().length >= 2 && !searching && hits.length === 0 && (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 6 }}>
                Nothing matched. You can only plan against leads in your own book.
              </div>
            )}
          </div>
        )}

        {/* Whose diary. Only a head sees this; an officer plans their own week. */}
        {officers && officers.length > 0 && (
          <SelectMenuField label="Whose Diary" value={whose} onChange={setWhose}
            options={[{ value: '', label: 'Mine' },
              ...officers.map(o => ({ value: String(o.id), label: o.full_name }))]} />
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
          <label style={labelSt}>Notes (Optional)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 8, resize: 'vertical',
              border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
              color: 'var(--txt)', fontSize: TEXT.base, boxSizing: 'border-box',
              fontFamily: 'inherit',
            }} />
        </div>
      </div>
    </Modal>
  )
}
