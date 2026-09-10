import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { AMBER, RED, GREEN, NAVY, TEXT, FW, RADIUS } from '../lib/design'

// Global SLA reminder for helpdesk/care staff. Polls tickets whose SLA is about to
// breach (or already has) and pops a non-blocking card (bottom-right). It surfaces a
// ticket once when it enters "due soon" and again if it flips to "breached", then
// clears itself once the ticket drops out of the due list.

interface DueSla {
  id: number
  ticket_ref: string
  subject: string
  priority: string
  customer_name: string
  sla_due_at: string
  sla_breached: boolean
  seconds_left: number
}

// Humanize a countdown: positive → "in 2h 5m" / "in 42m"; non-positive → "overdue by 12m".
function fmtCountdown(secondsLeft: number): string {
  const overdue = secondsLeft <= 0
  const total = Math.abs(secondsLeft)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const body = h > 0 ? `${h}h ${m}m` : `${m}m`
  return overdue ? `overdue by ${body}` : `in ${body}`
}

export default function SLAReminder({ enabled, offset = 0 }: { enabled: boolean; offset?: number }) {
  const navigate = useNavigate()
  const [queue, setQueue] = useState<DueSla[]>([])
  const shown = useRef<Map<number, string>>(new Map()) // id -> "<breached>" state we last surfaced

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const poll = async () => {
      try {
        const raw = await apiFetch<any>('/api/helpdesk/sla/due')
        const rows: DueSla[] = Array.isArray(raw) ? raw : (raw?.data ?? [])
        if (cancelled || !Array.isArray(rows)) return
        // Key on breach state so a ticket re-surfaces when it flips due-soon → breached.
        const stateKey = (r: DueSla) => (r.sla_breached || r.seconds_left <= 0 ? 'breached' : 'due')
        const fresh = rows.filter(r => shown.current.get(r.id) !== stateKey(r))
        fresh.forEach(r => shown.current.set(r.id, stateKey(r)))
        const dueIds = new Set(rows.map(r => r.id))
        setQueue(q => {
          const kept = q.filter(x => dueIds.has(x.id)) // drop ones no longer due (answered/cleared)
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

  const breached = cb.sla_breached || cb.seconds_left <= 0
  const accent = breached ? RED : AMBER
  const title = breached ? 'SLA breached' : 'SLA due soon'

  function openTicket() {
    dismiss(cb.id)
    navigate(`/helpdesk/${cb.id}`)
  }
  function goToCare() {
    dismiss(cb.id)
    navigate('/care/inbox')
  }

  return (
    <div style={{
      position: 'fixed', right: 20, bottom: 20 + offset, zIndex: 9999, width: 340,
      background: 'var(--card)', border: `1px solid ${accent}55`, borderLeft: `4px solid ${accent}`,
      borderRadius: RADIUS.lg, boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: 16,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 20, color: accent }}>timer</span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        {queue.length > 1 && (
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>+{queue.length - 1} more</span>
        )}
        <button onClick={() => dismiss(cb.id)} title="Dismiss"
          style={{ background: 'none', border: 'none', color: 'var(--txt3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
      </div>

      <div>
        <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{cb.ticket_ref}</span> · {cb.subject}
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          {cb.customer_name}
        </div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: accent, marginTop: 2 }}>
          {fmtCountdown(cb.seconds_left)}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={openTicket}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
            border: 'none', background: GREEN, color: '#fff', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> Open ticket
        </button>
        <button onClick={goToCare}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
            border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>inbox</span> Go to Care
        </button>
      </div>
    </div>
  )
}
