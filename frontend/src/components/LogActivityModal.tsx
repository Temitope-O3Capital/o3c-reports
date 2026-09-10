// LogActivityModal — the manual "log an activity" surface for the workspace activity
// stream (POST /api/activities). Lets an agent record what isn't a phone call: a note,
// a document collected, a hand-off to another team, or a follow-up task — against a lead,
// contact, customer (CIF) or application. Kept generic so it drops onto the Leads page,
// Customer 360, or any team's detail view with the right anchor.

import { useState } from 'react'
import { Modal } from './UI'
import { apiPost } from '../lib/api'
import { NAVY, RADIUS, TEXT, FW, SP } from '../lib/design'
import { toast } from 'sonner'

// Whatever anchors the caller has — send all that apply; the row is matched by them.
export interface LogActivityAnchor {
  lead_id?: number
  contact_id?: number
  cif?: string
  application_id?: number
  phone?: string
}

const TYPES: { v: string; label: string; icon: string }[] = [
  { v: 'note',     label: 'Note',              icon: 'sticky_note_2' },
  { v: 'handoff',  label: 'Hand off to a team', icon: 'swap_horiz' },
  { v: 'document', label: 'Document collected', icon: 'description' },
  { v: 'task',     label: 'Task / follow-up',   icon: 'task_alt' },
]

const TEAMS: { v: string; label: string }[] = [
  { v: 'sales', label: 'Sales' }, { v: 'risk', label: 'Risk' }, { v: 'finance', label: 'Finance' },
  { v: 'ops', label: 'Operations' }, { v: 'collections', label: 'Collections' },
  { v: 'recovery', label: 'Recovery' }, { v: 'care', label: 'Customer Care' },
]

export default function LogActivityModal({ open, anchor, onClose, onSaved }: {
  open: boolean
  anchor: LogActivityAnchor
  onClose: () => void
  onSaved: () => void
}) {
  const [type, setType]           = useState('note')
  const [targetTeam, setTeam]     = useState('risk')
  const [subject, setSubject]     = useState('')
  const [body, setBody]           = useState('')
  const [saving, setSaving]       = useState(false)

  const isHandoff = type === 'handoff'

  async function submit() {
    if (!subject.trim() && !body.trim()) { toast.error('Add a subject or a note'); return }
    setSaving(true)
    try {
      await apiPost('/api/activities', {
        ...anchor,
        type,
        subject: subject.trim(),
        body: body.trim(),
        target_team: isHandoff ? targetTeam : undefined,
      })
      toast.success(isHandoff ? `Handed off to ${TEAMS.find(t => t.v === targetTeam)?.label ?? targetTeam}` : 'Activity logged')
      setSubject(''); setBody(''); setType('note')
      onSaved()
    } catch (e: any) {
      toast.error(e?.message || 'Could not log activity')
    } finally { setSaving(false) }
  }

  const field: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: 'var(--font-sans)', outline: 'none', boxSizing: 'border-box',
  }

  return (
    <Modal open={open} onClose={onClose} title="Log an activity" width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        {/* Type picker */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TYPES.map(t => {
            const on = type === t.v
            return (
              <button key={t.v} onClick={() => setType(t.v)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px',
                borderRadius: RADIUS.full, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: `1px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? NAVY : 'var(--card)',
                color: on ? '#fff' : 'var(--txt2)', fontFamily: 'inherit',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{t.icon}</span>{t.label}
              </button>
            )
          })}
        </div>

        {isHandoff && (
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Hand off to</label>
            <select value={targetTeam} onChange={e => setTeam(e.target.value)} style={field}>
              {TEAMS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </div>
        )}

        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            {isHandoff ? 'What are you handing over?' : 'Subject'}
          </label>
          <input
            value={subject} onChange={e => setSubject(e.target.value)}
            placeholder={isHandoff ? 'e.g. Credit card application — documents attached' : type === 'document' ? 'e.g. ID, payslip, bank statement collected' : 'Short summary'}
            style={field}
          />
        </div>

        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Details</label>
          <textarea
            spellCheck rows={4} value={body} onChange={e => setBody(e.target.value)}
            placeholder="Context for whoever reads this next"
            style={{ ...field, resize: 'vertical' }}
          />
        </div>

        <button
          onClick={submit}
          disabled={saving}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '10px 0', background: saving ? `${NAVY}80` : NAVY, color: '#fff',
            border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.md, fontWeight: FW.bold,
            cursor: saving ? 'not-allowed' : 'pointer', width: '100%', fontFamily: 'inherit',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{isHandoff ? 'swap_horiz' : 'add'}</span>
          {saving ? 'Saving…' : isHandoff ? 'Hand off' : 'Log activity'}
        </button>
      </div>
    </Modal>
  )
}
