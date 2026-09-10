import { useState, useEffect, useCallback } from 'react'
import { SectionCard } from './UI'
import { apiFetch } from '../lib/api'
import { fmtDatetime } from '../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, FW, RADIUS, SP, TEXT } from '../lib/design'
import { toast } from 'sonner'

// The supervisor's side of call-log corrections: surfaces logs the workspace could
// not make sense of — a write-up saying the call was never answered sitting on a
// two-minute recorded conversation. Those used to sit in the data contradicting
// themselves with nobody told. The supervisor corrects the log, or marks it fine.

interface ReviewCall {
  id: number
  agent_name: string
  customer_name: string | null
  customer_phone: string | null
  started_at: string
  duration_sec: number | null
  direction: string | null
  disposition: string | null
  notes: string | null
  review_reason: string | null
  has_recording: boolean
}

export default function CallReviewPanel({ onEdit, reloadKey }: {
  onEdit?: (callId: number) => void
  reloadKey?: number
}) {
  const [review, setReview] = useState<ReviewCall[]>([])
  const [busy,   setBusy]   = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<any>('/api/helpdesk/calls/needs-review')
      setReview(Array.isArray(r) ? r : r?.data ?? [])
    } catch { /* the panel is supplementary — never block the page */ }
  }, [])

  useEffect(() => { load() }, [load, reloadKey])

  async function clearFlag(id: number) {
    setBusy(id)
    try {
      await apiFetch(`/api/helpdesk/calls/${id}/clear-review`, { method: 'POST', body: '{}' })
      toast.success('Marked as fine')
      setReview(rs => rs.filter(r => r.id !== id))
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusy(null) }
  }

  const dur = (s: number | null) => (s && s > 0 ? `${Math.floor(s / 60)}m ${s % 60}s` : '—')

  return (
    <>
      {review.length > 0 && (
        <SectionCard title="Call logs needing a decision" badge={review.length}>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[3], lineHeight: 1.5 }}>
            The write-up on these calls contradicts what the call itself shows, and
            no other call on the number matches it. Nothing has been changed — correct
            the log, or mark it fine if it reads right to you.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {review.map(c => (
              <div key={c.id} style={{
                display: 'flex', gap: SP[3], alignItems: 'flex-start', padding: '10px 0',
                borderBottom: '1px solid var(--bdr)',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER, marginTop: 2 }}>flag</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: FW.semibold, fontSize: TEXT.base }}>
                      {c.customer_name || c.customer_phone || 'Unknown'}
                    </span>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: RED }}>{c.disposition}</span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>{dur(c.duration_sec)}</span>
                    {c.has_recording && <span style={{ fontSize: TEXT['2xs'], color: GREEN }}>recorded</span>}
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>{fmtDatetime(c.started_at)}</span>
                  </div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.4 }}>
                    {c.review_reason}
                  </div>
                  {c.notes && (
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3, fontStyle: 'italic' }}>
                      “{c.notes.slice(0, 160)}{c.notes.length > 160 ? '…' : ''}”
                    </div>
                  )}
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3 }}>{c.agent_name}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {onEdit && (
                    <button onClick={() => onEdit(c.id)} style={{
                      padding: '5px 12px', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                      borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff',
                    }}>Correct</button>
                  )}
                  <button onClick={() => clearFlag(c.id)} disabled={busy === c.id} style={{
                    padding: '5px 12px', fontSize: TEXT.sm, fontWeight: FW.semibold,
                    cursor: busy === c.id ? 'wait' : 'pointer', borderRadius: RADIUS.md,
                    border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)',
                  }}>Looks right</button>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </>
  )
}
