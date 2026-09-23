// HandoffActions — the controls that let a hand-off finish.
//
// A hand-off used to be write-once: status was stamped 'open' at creation and nothing
// in the app could ever move it, so the raiser had no way to learn what happened and
// the receiving team had no way to say. These buttons drive
// PATCH /api/activities/{id}/status, which writes a reflect-back onto the person's
// timeline and tells the raiser. Shared by the lead's history and the hand-off inbox
// so both offer exactly the same verbs with the same rules.

import { useState } from 'react'
import { Modal } from './UI'
import { apiPatch } from '../lib/api'
import { GREEN, AMBER, NAVY, RED, RADIUS, TEXT, FW, SP, INTER } from '../lib/design'
import { toast } from 'sonner'

export interface HandoffLike {
  id: number
  status: string | null
  target_team: string | null
  actor_user_id?: number | null
}

export interface HandoffViewer {
  user_id: number
  team: string
}

// How a hand-off's state reads, and the colour it carries wherever it is shown.
export const HANDOFF_STATUS: Record<string, { label: string; color: string }> = {
  open:        { label: 'Open',        color: AMBER },
  accepted:    { label: 'Accepted',    color: NAVY  },
  in_progress: { label: 'In Progress', color: NAVY  },
  resolved:    { label: 'Resolved',    color: GREEN },
  returned:    { label: 'Returned',    color: RED   },
  cancelled:   { label: 'Cancelled',   color: '#6B7280' },
}

export const handoffOpen = (status: string | null | undefined) =>
  !['resolved', 'returned', 'cancelled'].includes((status || 'open').toLowerCase())

export function HandoffStatusChip({ status }: { status: string | null | undefined }) {
  const s = (status || 'open').toLowerCase()
  const meta = HANDOFF_STATUS[s] ?? { label: s.replace(/_/g, ' '), color: '#6B7280' }
  return (
    <span style={{
      fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 8px', borderRadius: RADIUS.full,
      background: `${meta.color}14`, color: meta.color, textTransform: 'uppercase', letterSpacing: '0.3px',
    }}>{meta.label}</span>
  )
}

export default function HandoffActions({ handoff, viewer, onDone }: {
  handoff: HandoffLike
  viewer: HandoffViewer | null
  onDone: () => void
}) {
  // Which verb we are asking for a note about; null = no dialog open.
  const [asking, setAsking] = useState<'resolved' | 'returned' | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const status = (handoff.status || 'open').toLowerCase()
  if (!handoffOpen(status) || !viewer) return null

  // The receiving team does the work; the raiser may only call it off. The server
  // enforces both — this just keeps buttons off the screens that would be refused.
  const onTeam = !!handoff.target_team && viewer.team === handoff.target_team
  const isRaiser = !!handoff.actor_user_id && viewer.user_id === handoff.actor_user_id
  if (!onTeam && !isRaiser) return null

  async function send(next: string, withNote?: string) {
    setBusy(true)
    try {
      await apiPatch(`/api/activities/${handoff.id}/status`, { status: next, note: withNote ?? '' })
      toast.success(
        next === 'accepted' ? 'Accepted: the raiser has been told'
        : next === 'resolved' ? 'Resolved: the raiser has been told'
        : next === 'returned' ? 'Returned to the raiser'
        : 'Hand-off cancelled')
      setAsking(null); setNote('')
      onDone()
    } catch (e: any) {
      toast.error(e?.message || 'Could not update the hand-off')
    } finally { setBusy(false) }
  }

  const btn = (color: string, filled: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', minHeight: 30,
    borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, fontFamily: INTER,
    border: filled ? 'none' : `1px solid ${color}`, background: filled ? color : 'var(--card)',
    color: filled ? '#fff' : color, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
  })

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {onTeam && status === 'open' && (
          <button disabled={busy} onClick={() => send('accepted')} style={btn(NAVY, false)}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>how_to_reg</span> Accept
          </button>
        )}
        {onTeam && (
          <button disabled={busy} onClick={() => { setAsking('resolved'); setNote('') }} style={btn(GREEN, true)}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>task_alt</span> Resolve
          </button>
        )}
        {onTeam && (
          <button disabled={busy} onClick={() => { setAsking('returned'); setNote('') }} style={btn(AMBER, false)}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>undo</span> Return
          </button>
        )}
        {isRaiser && !onTeam && (
          <button disabled={busy} onClick={() => send('cancelled')} style={btn('#6B7280', false)}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span> Cancel Hand-Off
          </button>
        )}
      </div>

      {/* Closing a hand-off without saying what happened leaves the raiser chasing
          someone — the server refuses it, and this is where the agent is asked. */}
      <Modal
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking === 'returned' ? 'Return This Hand-Off' : 'Resolve This Hand-Off'}
        width={440}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setAsking(null)} disabled={busy}
              style={{ padding: '9px 16px', minHeight: 40, borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
                       background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold,
                       cursor: 'pointer', fontFamily: INTER }}>
              Cancel
            </button>
            <button
              onClick={() => { if (note.trim()) send(asking!, note.trim()) }}
              disabled={busy || !note.trim()}
              style={{ padding: '9px 18px', minHeight: 40, borderRadius: RADIUS.md, border: 'none',
                       background: note.trim() ? (asking === 'returned' ? AMBER : GREEN) : 'var(--bdr)',
                       color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, fontFamily: INTER,
                       cursor: note.trim() && !busy ? 'pointer' : 'not-allowed' }}>
              {busy ? 'Saving…' : asking === 'returned' ? 'Return It' : 'Resolve It'}
            </button>
          </div>
        }
      >
        <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          {asking === 'returned' ? 'Why Are You Returning It?' : 'What Happened?'}
        </label>
        <textarea
          spellCheck rows={4} value={note} onChange={e => setNote(e.target.value)}
          placeholder={asking === 'returned'
            ? 'e.g. Wrong team: this is an Ops request, not Risk'
            : 'e.g. Reviewed and approved. Customer is eligible for the ₦500k limit'}
          style={{ width: '100%', padding: '9px 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
                   fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER,
                   outline: 'none', boxSizing: 'border-box', resize: 'vertical' }}
        />
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 6 }}>
          This goes back to whoever raised it, and onto the customer's timeline.
        </div>
      </Modal>
    </>
  )
}
