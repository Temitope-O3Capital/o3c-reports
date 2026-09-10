import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPost } from '../lib/api'
import { toast } from 'sonner'
import { AMBER, GREEN, NAVY, TEXT, FW, RADIUS } from '../lib/design'
import LogCallModal from './LogCallModal'

// Global call-back reminder for call-centre agents. Polls the agent's due call-backs
// and pops a non-blocking card (bottom-right) when one is due — Call now / Snooze /
// Dismiss. The server auto-snoozes an un-dialled call-back every 10 min so it keeps
// re-surfacing, and drops it from "due" the moment the agent logs the call, at which
// point this popup clears itself.

interface DueCallback {
  id: number
  source: 'lead' | 'contact'
  name: string
  phone: string
  callback_at: string
  last_disposition: string
  purpose: string
}

export default function CallbackReminder({ enabled }: { enabled: boolean }) {
  const navigate = useNavigate()
  const [queue, setQueue] = useState<DueCallback[]>([])
  const shown = useRef<Map<number, string>>(new Map()) // id -> callback_at we last surfaced
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
        const fresh = rows.filter(r => shown.current.get(r.id) !== r.callback_at)
        fresh.forEach(r => shown.current.set(r.id, r.callback_at))
        const dueIds = new Set(rows.map(r => r.id))
        setQueue(q => {
          const kept = q.filter(x => dueIds.has(x.id)) // drop ones no longer due (dialled/cleared)
          const keptIds = new Set(kept.map(x => x.id))
          return [...kept, ...fresh.filter(f => !keptIds.has(f.id))]
        })
      } catch { /* ignore transient errors */ }
    }
    poll()
    const t = setInterval(poll, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [enabled])

  if (!enabled || queue.length === 0) return null
  const cb = queue[0]
  const dismiss = (id: number) => setQueue(q => q.filter(x => x.id !== id))

  async function snooze(mins: number) {
    setBusy(true)
    try {
      await apiPost(`/api/call-center/callbacks/${cb.id}/snooze`, { minutes: mins, source: cb.source })
      toast.success(`Call-back snoozed ${mins < 60 ? `${mins} min` : '1 hour'}`)
    } catch (e: any) { toast.error(e?.message ?? 'Could not snooze') }
    finally { setBusy(false); dismiss(cb.id) }
  }
  // Take the agent to the actual call, on the book it lives in: a lead call-back opens
  // the Leads page on that lead; a queue call-back opens the Outbound Queue on that
  // contact. Never the wrong one.
  function callNow() {
    dismiss(cb.id)
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
      position: 'fixed', right: 20, bottom: 20, zIndex: 9999, width: 340,
      background: 'var(--card)', border: `1px solid ${AMBER}55`, borderLeft: `4px solid ${AMBER}`,
      borderRadius: RADIUS.lg, boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: 16,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 20, color: AMBER }}>alarm</span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>Call-back due now</span>
        <div style={{ flex: 1 }} />
        {queue.length > 1 && (
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>+{queue.length - 1} more</span>
        )}
        <button onClick={() => dismiss(cb.id)} title="Dismiss"
          style={{ background: 'none', border: 'none', color: 'var(--txt3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
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
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>call</span> Call now
        </button>
        {/* Log the call right here — the reminder clears the moment the call is logged
            (the server stamps the lead/contact as called), so it stops nagging. */}
        <button onClick={() => setLogOpen(true)} disabled={busy}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
            border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY, cursor: busy ? 'default' : 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>edit_note</span> Log call
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
        purpose:   cb.source === 'lead' ? 'marketing' : (cb.purpose || undefined),
        leadId:    cb.source === 'lead' ? cb.id : undefined,
      }}
      onClose={() => setLogOpen(false)}
      onSaved={() => { setLogOpen(false); dismiss(cb.id); toast.success('Call logged') }}
    />
   </>
  )
}
