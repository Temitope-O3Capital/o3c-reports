import { useState, useEffect, useCallback } from 'react'
import { SectionCard } from './UI'
import { apiFetch } from '../lib/api'
import { fmtDatetime } from '../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, FW, RADIUS, SP, TEXT } from '../lib/design'
import { toast } from 'sonner'

// The supervisor's side of call-log corrections.
//
// Two things a supervisor could not see before. First, logs the workspace could
// not make sense of — a write-up saying the call was never answered sitting on a
// two-minute recorded conversation. Those used to sit in the data contradicting
// themselves with nobody told; flagging them without giving anyone a screen to
// act on would have been no better. Second, every correction and withdrawal, with
// what it replaced — because a log agents can rewrite needs to be a log someone
// can audit.

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

interface EditRow {
  id: number
  call_id: number
  action: string
  edited_name: string
  changes: Record<string, { from: any; to: any }> | null
  reason: string
  created_at: string
  customer_name: string | null
  agent_name: string
  started_at: string
  is_voided: boolean
}

const ACTION_META: Record<string, { label: string; color: string }> = {
  edit:           { label: 'Corrected', color: NAVY },
  void:           { label: 'Withdrawn', color: RED },
  restore:        { label: 'Restored',  color: GREEN },
  review_cleared: { label: 'Marked fine', color: 'var(--txt3)' },
}

export default function CallReviewPanel({ onEdit, reloadKey }: {
  onEdit?: (callId: number) => void
  reloadKey?: number
}) {
  const [review, setReview] = useState<ReviewCall[]>([])
  const [edits,  setEdits]  = useState<EditRow[]>([])
  const [busy,   setBusy]   = useState<number | null>(null)

  const load = useCallback(async (silent = false) => {
    try {
      const [rv, ed] = await Promise.allSettled([
        apiFetch<any>('/api/helpdesk/calls/needs-review'),
        apiFetch<any>('/api/helpdesk/calls/edits?limit=40'),
      ])
      const val = (r: PromiseSettledResult<any>) =>
        r.status === 'fulfilled' ? (Array.isArray(r.value) ? r.value : r.value?.data ?? []) : []
      setReview(val(rv)); setEdits(val(ed))
    } catch { if (!silent) { /* the panel is supplementary — never block the page */ } }
  }, [])

  useEffect(() => { load() }, [load, reloadKey])

  async function clearFlag(id: number) {
    setBusy(id)
    try {
      await apiFetch(`/api/helpdesk/calls/${id}/clear-review`, { method: 'POST', body: '{}' })
      toast.success('Marked as fine')
      setReview(rs => rs.filter(r => r.id !== id))
      load(true)
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

      {edits.length > 0 && (
        <SectionCard title="Corrections and withdrawals" badge={edits.length}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {edits.map(e => {
              const meta = ACTION_META[e.action] ?? { label: e.action, color: 'var(--txt2)' }
              const fields = Object.entries(e.changes ?? {})
              return (
                <div key={e.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px',
                      borderRadius: RADIUS['2xl'], background: `${meta.color}15`, color: meta.color,
                    }}>{meta.label}</span>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold }}>
                      {e.customer_name || 'Unknown'}
                    </span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                      by {e.edited_name || 'someone'} · {e.agent_name}&rsquo;s call
                    </span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>
                      {fmtDatetime(e.created_at)}
                    </span>
                  </div>
                  {/* Both sides of every change, so a correction can be read against
                      what it replaced rather than taken on trust. */}
                  {fields.length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {fields.map(([field, v]) => (
                        <div key={field} style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                          <span style={{ color: 'var(--txt3)' }}>{field.replace(/_/g, ' ')}: </span>
                          <span style={{ textDecoration: 'line-through', color: 'var(--txt3)' }}>
                            {String(v?.from ?? '—').slice(0, 70) || '—'}
                          </span>
                          {' → '}
                          <span style={{ color: 'var(--txt)' }}>{String(v?.to ?? '—').slice(0, 70) || '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {e.reason && (
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3 }}>
                      Reason: {e.reason}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}
    </>
  )
}
