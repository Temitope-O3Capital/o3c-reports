import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { Page, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { AMBER, GREEN, RED, TEXT, FW, SP, RADIUS, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MailAddress { Email: string; Name: string }

interface OutboxRow {
  id:           number
  subject:      string
  status:       'pending' | 'sent' | 'recalled' | 'failed' | string
  send_after:   string
  error_text?:  string
  created_at:   string
  sent_at?:     string
  mail_id?:     number
  seconds_left: number
  to_addrs:     any
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function parseAddrs(raw: any): MailAddress[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(String(raw)) } catch { return [] }
}

function firstRecipient(raw: any): string {
  const addrs = parseAddrs(raw)
  if (!addrs.length) return '—'
  const a = addrs[0]
  const extra = addrs.length > 1 ? ` +${addrs.length - 1}` : ''
  return (a.Email || a.Name || '—') + extra
}

// Status pill colouring per the module spec.
function statusStyle(status: string): { bg: string; txt: string; label: string } {
  switch (status) {
    case 'pending':  return { bg: `${AMBER}18`, txt: AMBER, label: 'Pending' }
    case 'sent':     return { bg: `${GREEN}18`, txt: GREEN, label: 'Sent' }
    case 'failed':   return { bg: `${RED}14`,   txt: RED,   label: 'Failed' }
    case 'recalled': return { bg: 'var(--chip-bg)', txt: 'var(--txt3)', label: 'Recalled' }
    default:         return { bg: 'var(--chip-bg)', txt: 'var(--txt3)', label: status || '—' }
  }
}

function StatusPill({ status }: { status: string }) {
  const s = statusStyle(status)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.semibold,
      padding: '2px 9px', borderRadius: 20,
      background: s.bg, color: s.txt, whiteSpace: 'nowrap',
      fontFamily: INTER,
    }}>
      {s.label}
    </span>
  )
}

// ── Main component ───────────────────────────────────────────────────────────────

export default function MailOutbox() {
  const [rows, setRows]       = useState<OutboxRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [recalling, setRecalling] = useState<Set<number>>(new Set())

  // Anchor the live countdown to the last successful poll: server-supplied
  // seconds_left, less the wall-clock seconds elapsed since we received it.
  const fetchedAt = useRef<number>(Date.now())
  const [, setTick] = useState(0)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const raw = await apiFetch<any>('/api/mail/outbox', { silent: true })
      const list: OutboxRow[] = Array.isArray(raw) ? raw : (raw?.data ?? [])
      setRows(list)
      fetchedAt.current = Date.now()
      setErr(null)
    } catch (ex: any) {
      // Only surface the error on the initial load; a transient poll failure
      // should not blank a working screen.
      if (!opts?.silent) setErr(ex?.message ?? 'Could not load the outbox')
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  // Initial load + 5s poll.
  useEffect(() => {
    load()
    const t = setInterval(() => load({ silent: true }), 5000)
    return () => clearInterval(t)
  }, [load])

  // 1s tick to advance the visible countdown between polls.
  useEffect(() => {
    const hasPending = rows.some(r => r.status === 'pending')
    if (!hasPending) return
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [rows])

  function remainingFor(row: OutboxRow): number {
    const elapsed = Math.floor((Date.now() - fetchedAt.current) / 1000)
    return Math.max(0, row.seconds_left - elapsed)
  }

  async function recall(id: number) {
    setRecalling(prev => new Set(prev).add(id))
    try {
      await apiPost(`/api/mail/outbox/${id}/cancel`, {})
      toast.success('Message recalled')
      await load({ silent: true })
    } catch (ex: any) {
      toast.error(ex?.message ?? 'Could not recall — it may already have sent')
      await load({ silent: true })
    } finally {
      setRecalling(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────────

  const thBase: React.CSSProperties = {
    padding: '10px 14px', fontSize: 11, fontWeight: 700,
    color: 'var(--txt2)', textTransform: 'uppercase', fontFamily: INTER,
    letterSpacing: '0.6px', whiteSpace: 'nowrap', textAlign: 'left',
    borderBottom: '1px solid var(--bdr)',
  }
  const tdBase: React.CSSProperties = {
    padding: '12px 14px', fontSize: TEXT.sm, color: 'var(--txt)',
    borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
  }

  return (
    <Page title="Outbox" subtitle="Messages held briefly so you can undo — recall before they send">
      <ErrBanner error={err} onRetry={() => load()} />

      <div style={{
        background: 'var(--card)', border: '1px solid var(--card-bdr)',
        boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, overflow: 'hidden',
      }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '48px 0' }}>
            <Spinner />
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Loading…</span>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '56px 20px', textAlign: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 40, color: 'var(--txt3)' }}>outbox</span>
            <div style={{ marginTop: SP[2], fontSize: TEXT.base, color: 'var(--txt3)' }}>Nothing waiting to send.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thBase}>Recipient</th>
                  <th style={thBase}>Subject</th>
                  <th style={thBase}>Status</th>
                  <th style={thBase}>Queued</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Countdown</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const isPending = row.status === 'pending'
                  const left = isPending ? remainingFor(row) : 0
                  const busy = recalling.has(row.id)
                  return (
                    <tr key={row.id}>
                      <td style={{ ...tdBase, fontWeight: FW.semibold, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {firstRecipient(row.to_addrs)}
                      </td>
                      <td style={{ ...tdBase, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.subject || '(no subject)'}
                        {row.status === 'failed' && row.error_text && (
                          <div style={{ fontSize: TEXT.xs, color: RED, marginTop: 2 }}>{row.error_text}</div>
                        )}
                      </td>
                      <td style={tdBase}><StatusPill status={row.status} /></td>
                      <td style={{ ...tdBase, color: 'var(--txt3)', fontSize: TEXT.xs, whiteSpace: 'nowrap' }}>
                        {fmtDatetime(row.created_at)}
                      </td>
                      <td style={{ ...tdBase, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {isPending ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: SP[3], justifyContent: 'flex-end' }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, color: AMBER, fontWeight: FW.semibold, minWidth: 34, textAlign: 'right' }}>
                              {left}s
                            </span>
                            <button
                              onClick={() => recall(row.id)}
                              disabled={busy}
                              style={{
                                padding: '5px 12px', borderRadius: RADIUS.md,
                                border: `1.5px solid ${RED}`, background: 'transparent',
                                color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold,
                                cursor: busy ? 'default' : 'pointer', fontFamily: INTER,
                                opacity: busy ? 0.6 : 1,
                              }}>
                              {busy ? 'Recalling…' : 'Recall'}
                            </button>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--txt3)', fontSize: TEXT.xs }}>—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  )
}
