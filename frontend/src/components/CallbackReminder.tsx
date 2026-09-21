import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPost } from '../lib/api'
import { toast } from 'sonner'
import { AMBER, GREEN, NAVY, TEXT, FW, RADIUS } from '../lib/design'
import LogCallModal from './LogCallModal'

// Global call-back reminder for call-centre agents. Polls the agent's due call-backs
// and pops a non-blocking card (bottom-right) when one is due — Call now / Snooze /
// Dismiss. The server's /callbacks/due feed is bounded (came due in the last 24h) and
// self-clearing: the moment a call exists at/after a call-back's due time it drops out
// of the feed — by the actual call ledger, not a stamp that could be missed — so a
// call-back never lingers here after it has been called and logged. Older un-dialled
// call-backs are backlog, worked from the queue's "ready" bucket rather than alarmed.

interface DueCallback {
  id: number
  source: 'lead' | 'contact'
  name: string
  phone: string
  callback_at: string
  last_disposition: string
  purpose: string
}

// The feed is a UNION of two tables with independent id sequences, so a bare id is not
// unique across it: lead #5 and contact #5 are different people. Everything that
// identifies a reminder — what has been shown, what is still due, what was dismissed —
// keys on the pair, or one of the two silently stands in for the other.
const keyOf = (r: { source: string; id: number }) => `${r.source}:${r.id}`

// The softphone sits at bottom:20 and is 48px tall. This card appears at exactly the
// moment the agent has been told to ring someone, so it must clear the dial button;
// `offset` then staggers it against its siblings, as SLAReminder/EscalationReminder do.
const BASE_BOTTOM = 80

export default function CallbackReminder({ enabled, offset = 0 }: { enabled: boolean; offset?: number }) {
  const navigate = useNavigate()
  const [queue, setQueue] = useState<DueCallback[]>([])
  const shown = useRef<Map<string, string>>(new Map()) // source:id -> callback_at we last surfaced
  const [busy, setBusy] = useState(false)
  const [logOpen, setLogOpen] = useState(false) // log-a-call modal opened from the reminder

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const poll = async () => {
      try {
        const rows = await apiFetch<DueCallback[]>('/api/call-center/callbacks/due')
        if (cancelled || !Array.isArray(rows)) return
        // Surface each call-back once per callback_at (avoids per-poll spam); a
        // re-scheduled one carries a new callback_at and re-surfaces.
        const fresh = rows.filter(r => shown.current.get(keyOf(r)) !== r.callback_at)
        fresh.forEach(r => shown.current.set(keyOf(r), r.callback_at))
        const dueKeys = new Set(rows.map(keyOf))
        setQueue(q => {
          const kept = q.filter(x => dueKeys.has(keyOf(x))) // drop ones no longer due (dialled/cleared)
          const keptKeys = new Set(kept.map(keyOf))
          return [...kept, ...fresh.filter(f => !keptKeys.has(keyOf(f)))]
        })
      } catch { /* ignore transient errors */ }
    }
    poll()
    const t = setInterval(poll, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [enabled])

  if (!enabled || queue.length === 0) return null
  const cb = queue[0]
  const dismiss = (r: DueCallback) => setQueue(q => q.filter(x => keyOf(x) !== keyOf(r)))

  async function snooze(mins: number) {
    setBusy(true)
    try {
      await apiPost(`/api/call-center/callbacks/${cb.id}/snooze`, { minutes: mins, source: cb.source })
      toast.success(`Call-back snoozed ${mins < 60 ? `${mins} min` : '1 hour'}`)
    } catch (e: any) { toast.error(e?.message ?? 'Could not snooze') }
    finally { setBusy(false); dismiss(cb) }
  }
  // Take the agent to the actual call, on the book it lives in: a lead call-back opens
  // the Leads page on that lead; a queue call-back opens the Outbound Queue on that
  // contact. Never the wrong one.
  function callNow() {
    dismiss(cb)
    if (cb.source === 'lead') navigate(`/call-center/leads?open=${cb.id}`)
    else navigate(`/call-center/queue?bucket=ready&open=${cb.id}`)
  }

  const chip: React.CSSProperties = {
    padding: '4px 10px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
    border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
    cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
  }

  return (
   <>
    <div style={{
      position: 'fixed', right: 20, bottom: BASE_BOTTOM + offset, zIndex: 9999, width: 340,
      background: 'var(--card)', border: `1px solid ${AMBER}55`, borderLeft: `4px solid ${AMBER}`,
      borderRadius: RADIUS.lg, boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: 16,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 20, color: AMBER }}>alarm</span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>Call-Back Due Now</span>
        <div style={{ flex: 1 }} />
        {queue.length > 1 && (
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>+{queue.length - 1} more</span>
        )}
        <button onClick={() => dismiss(cb)} title="Dismiss" aria-label="Dismiss this call-back reminder"
          style={{
            width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', color: 'var(--txt3)', cursor: 'pointer', fontSize: 18, lineHeight: 1,
          }}>×</button>
      </div>

      <div>
        <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{cb.name}</div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>
          {cb.phone}{cb.purpose ? ` · ${cb.purpose}` : ''}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={callNow} disabled={busy}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
            border: 'none', background: GREEN, color: '#fff', cursor: busy ? 'default' : 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>call</span> Call Now
        </button>
        {/* Log the call right here — the reminder clears the moment the call is logged
            (the server stamps the lead/contact as called), so it stops nagging. */}
        <button onClick={() => setLogOpen(true)} disabled={busy}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
            border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY, cursor: busy ? 'default' : 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>edit_note</span> Log Call
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Snooze</span>
        <button onClick={() => snooze(10)} disabled={busy} style={chip}>10m</button>
        <button onClick={() => snooze(30)} disabled={busy} style={chip}>30m</button>
        <button onClick={() => snooze(60)} disabled={busy} style={chip}>1h</button>
      </div>
    </div>

    {/* Log the call for this exact person without leaving the page. A lead call-back
        carries its leadId so logging advances the lead; a queue call-back is stamped
        by phone server-side. Either way the reminder clears once it's logged. */}
    <LogCallModal
      open={logOpen}
      initial={{
        name:      cb.name,
        phone:     cb.phone,
        direction: 'Outbound',
        purpose:   cb.source === 'lead' ? 'marketing' : (cb.purpose || 'support'),
        leadId:    cb.source === 'lead' ? cb.id : undefined,
      }}
      onClose={() => setLogOpen(false)}
      onSaved={() => { setLogOpen(false); dismiss(cb); toast.success('Call logged') }}
    />
   </>
  )
}
