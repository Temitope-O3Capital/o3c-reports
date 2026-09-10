import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, TEXT, FW, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// Care Outbox — replies still inside their recall window (and any that failed to
// send). Watch the countdown and recall a reply before it leaves.

interface OutRow {
  id: number
  ticket_id: number
  channel: string
  body_text: string
  send_state: 'pending' | 'sending' | 'sent' | 'recalled' | 'failed'
  send_after: string
  error_text?: string
  created_at: string
  author_name?: string
  seconds_left: number
  ticket_ref: string
  subject: string
  customer_name?: string
  customer_email?: string
}

const STATE_COLOR: Record<string, string> = {
  pending: AMBER, sending: AMBER, sent: GREEN, recalled: '#94A3B8', failed: RED,
}

export default function CareOutbox() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<OutRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const busy = useRef<Set<number>>(new Set())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    try {
      const raw = await apiFetch<any>('/api/helpdesk/outbox')
      const list = Array.isArray(raw) ? raw : (raw?.data ?? [])
      setRows(list as OutRow[])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => { load(true); setNow(Date.now()) }, 5000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(t); clearInterval(tick) }
  }, [load])

  async function recall(row: OutRow) {
    if (busy.current.has(row.id)) return
    busy.current.add(row.id)
    try {
      await apiPost(`/api/helpdesk/tickets/${row.ticket_id}/messages/${row.id}/recall`, {})
      toast.success(`Recalled reply on ${row.ticket_ref}`)
      load(true)
    } catch (e: any) { toast.error(e.message ?? 'Too late to recall') }
    finally { busy.current.delete(row.id) }
  }

  // Live countdown anchored to the last poll's seconds_left.
  function secsLeft(row: OutRow): number {
    const anchor = new Date(row.send_after).getTime()
    return Math.max(0, Math.round((anchor - now) / 1000))
  }

  return (
    <Page title="Outbox" subtitle="Replies held briefly so you can undo — recall one before it sends">
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={22} /></div>
      ) : err ? (
        <ErrBanner error={err} onRetry={load} />
      ) : rows.length === 0 ? (
        <SectionCard>
          <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 42, color: 'var(--txt3)' }}>outbox</span>
            <div style={{ fontSize: TEXT.md, marginTop: 8 }}>Nothing waiting to send.</div>
          </div>
        </SectionCard>
      ) : (
        <SectionCard padding={false}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map(row => {
              const left = secsLeft(row)
              const pending = row.send_state === 'pending' || row.send_state === 'sending'
              return (
                <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--bdr)' }}>
                  <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'capitalize', color: STATE_COLOR[row.send_state] || 'var(--txt2)', background: `${STATE_COLOR[row.send_state] || '#999'}14`, borderRadius: RADIUS.full, padding: '3px 10px', minWidth: 70, textAlign: 'center' }}>
                    {row.send_state}
                  </span>
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => navigate(`/care/inbox?mail=${row.ticket_id}`)}>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.subject || '(no subject)'} <span style={{ color: 'var(--txt3)', fontWeight: FW.medium }}>· {row.ticket_ref}</span>
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      To {row.customer_name || row.customer_email || 'customer'} · {row.body_text?.slice(0, 80)}
                    </div>
                    {row.send_state === 'failed' && row.error_text && (
                      <div style={{ fontSize: TEXT['2xs'], color: RED, marginTop: 2 }}>{row.error_text}</div>
                    )}
                  </div>
                  {pending && (
                    <>
                      <span style={{ fontSize: TEXT.xs, color: left <= 5 ? RED : 'var(--txt2)', fontWeight: FW.bold, minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {left}s
                      </span>
                      <button onClick={() => recall(row)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: 'none', color: RED, border: `1px solid ${RED}40`, borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.bold, cursor: 'pointer' }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>undo</span>Recall
                      </button>
                    </>
                  )}
                  {!pending && (
                    <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(row.created_at)}</span>
                  )}
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
