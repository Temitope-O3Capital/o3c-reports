import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, EmptyState } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, NUM, TEXT, FW, RADIUS } from '../../lib/design'
import { useLiveData } from '../../hooks/useRealtime'
import { toast } from 'sonner'

// Escalation worklist.
//
// Escalation used to be a status string that the database rejected — 'escalated'
// is not in helpdesk_tickets_status_check — so every attempt to escalate failed
// and none of the 35,035 tickets was ever in that state. There was nothing to
// list. Now an escalation names a person, carries a reason and stays open until
// somebody closes it, which makes this a real queue.

interface Escalation {
  id: number
  ticket_ref: string
  subject: string
  priority: string
  status: string
  escalated_at: string
  escalation_reason: string | null
  escalation_resolved_at: string | null
  escalated_by_name: string | null
  escalated_to_name: string | null
  resolved_by_name: string | null
  owner_name: string | null
  hours_open: number
}

// Anything sitting more than a working day is the thing this page exists to surface.
function ageColour(hours: number): string {
  if (hours >= 24) return RED
  if (hours >= 4) return AMBER
  return GREEN
}

export default function Escalations() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<Escalation[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [includeResolved, setIncludeResolved] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const res = await apiFetch<any>(`/api/helpdesk/escalations${includeResolved ? '?include_resolved=1' : ''}`)
      setRows((res?.data ?? res ?? []) as Escalation[])
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [includeResolved])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['tickets'] })

  async function clearEscalation(id: number) {
    setBusy(id)
    try {
      await apiPost(`/api/helpdesk/tickets/${id}/escalation/resolve`, {})
      toast.success('Escalation cleared')
      await load()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(null) }
  }

  const open = rows.filter(r => !r.escalation_resolved_at)
  const stale = open.filter(r => Number(r.hours_open) >= 24)

  return (
    <Page
      title="Escalations"
      subtitle="Tickets an agent could not resolve alone"
      actions={
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: TEXT.sm, color: 'var(--txt2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={includeResolved} onChange={e => setIncludeResolved(e.target.checked)} />
          Include cleared
        </label>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 18 }}>
        {[
          { label: 'Open escalations', value: fmtNum(open.length), colour: open.length ? AMBER : GREEN, icon: 'priority_high' },
          { label: 'Waiting over 24h', value: fmtNum(stale.length), colour: stale.length ? RED : GREEN, icon: 'alarm' },
          { label: 'Longest open', value: open.length ? `${Math.max(...open.map(r => Number(r.hours_open) || 0)).toFixed(1)}h` : '—', colour: NAVY, icon: 'hourglass_top' },
        ].map(m => (
          <div key={m.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{m.label}</span>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: m.colour }}>{m.icon}</span>
            </div>
            <div style={{ ...NUM, fontSize: 22, fontWeight: FW.extrabold, color: m.colour, letterSpacing: -0.5 }}>{m.value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="Escalation queue" subtitle={`${fmtNum(rows.length)} shown · oldest first`}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={26} /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon="check_circle" title="Nothing escalated"
            description="When an agent hits something they can't resolve, it lands here with a reason and stays until someone closes it." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((r, i) => {
              const done = Boolean(r.escalation_resolved_at)
              const colour = done ? 'var(--txt3)' : ageColour(Number(r.hours_open))
              return (
                <div key={r.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 2px',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--bdr)' : 'none',
                  opacity: done ? 0.6 : 1,
                }}>
                  <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: colour, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={() => navigate(`/helpdesk/${r.id}`)}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>
                        {r.ticket_ref}
                      </button>
                      <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{r.subject}</span>
                    </div>
                    {r.escalation_reason && (
                      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3 }}>{r.escalation_reason}</div>
                    )}
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span>{r.escalated_by_name || 'Someone'} to {r.escalated_to_name || 'supervisors'}</span>
                      <span>· {fmtDatetime(r.escalated_at)}</span>
                      {r.owner_name && <span>· owned by {r.owner_name}</span>}
                      {done && r.resolved_by_name && <span>· cleared by {r.resolved_by_name}</span>}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: 'right' }}>
                    <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: colour, marginBottom: 6 }}>
                      {Number(r.hours_open).toFixed(1)}h
                    </div>
                    {!done && (
                      <button onClick={() => clearEscalation(r.id)} disabled={busy === r.id}
                        style={{ padding: '5px 11px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                        {busy === r.id ? 'Clearing…' : 'Clear'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
