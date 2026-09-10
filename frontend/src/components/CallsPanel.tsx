import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { fmtDatetime } from '../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, GREEN, RED, AMBER } from '../lib/design'
import { Spinner } from './UI'

// One call-centre call for a customer, from GET /api/collections/calls/cif/{cif}.
interface CallRow {
  id: number
  started_at: string
  direction: string
  duration_sec: number | null
  outcome: string
  disposition: string
  purpose: string
  agent_name: string
  notes: string
}

function fmtDur(sec: number | null): string {
  if (!sec || sec <= 0) return '—'
  const m = Math.floor(sec / 60), s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/**
 * CallsPanel surfaces the call-centre's calls for a customer inside a collections /
 * recovery detail view, so the officer working the case can see what has already been
 * dialled — the call log is otherwise only reachable from Customer 360. Read-only: the
 * calls themselves are still logged in the call centre; steps taken here are logged
 * separately via the step-logger.
 */
export default function CallsPanel({ cif }: { cif: string }) {
  const [rows, setRows] = useState<CallRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    apiFetch<{ data: CallRow[] }>(`/api/collections/calls/cif/${encodeURIComponent(cif)}`)
      .then(r => { if (live) setRows(Array.isArray(r?.data) ? r.data : []) })
      .catch(() => { if (live) setRows([]) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [cif])

  if (loading) return <div style={{ padding: SP[5], textAlign: 'center' }}><Spinner size={16} /></div>
  if (!rows.length) return <div style={{ padding: SP[5], textAlign: 'center', fontSize: TEXT.sm, color: 'var(--txt3)' }}>No call-centre calls found for this customer.</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(c => {
        const outbound = (c.direction || '').toLowerCase() === 'outbound'
        return (
          <div key={c.id} style={{ display: 'flex', gap: 10, padding: `${SP[3]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17, color: outbound ? NAVY : GREEN, marginTop: 1 }}>
              {outbound ? 'call_made' : 'call_received'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                  {outbound ? 'Outbound' : 'Inbound'} call
                </span>
                {c.disposition && <Pill text={c.disposition} color={NAVY} />}
                {c.outcome && <Pill text={c.outcome} color={c.outcome.toLowerCase().includes('connect') || c.outcome.toLowerCase().includes('answer') ? GREEN : AMBER} />}
                {c.purpose && <Pill text={c.purpose} color={RED} />}
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>{fmtDatetime(c.started_at)}</span>
              </div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
                {c.agent_name || 'Unknown agent'} · {fmtDur(c.duration_sec)}
              </div>
              {c.notes && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 4 }}>{c.notes}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.full, background: `${color}14`, color, textTransform: 'capitalize' }}>
      {text.replace(/_/g, ' ')}
    </span>
  )
}
