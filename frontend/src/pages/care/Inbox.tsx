import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, Spinner, ErrBanner, TblSearch, StatusBadge } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, FW, RADIUS, SP, TEXT, SORA } from '../../lib/design'
import { toast } from 'sonner'

// Care = customer mail. These are helpdesk tickets on the 'email' channel, shown
// as an email inbox. The ticket stays the system of record underneath.

interface MailTicket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority: string
  customer_name?: string
  customer_email?: string
  customer_cif?: string
  created_at: string
  last_message_at?: string
  last_message_preview?: string
}

interface Message {
  id: number
  direction: 'inbound' | 'outbound'
  author_name?: string
  author_user_name?: string
  body_text: string
  is_internal_note?: boolean
  created_at: string
}

interface DetailResp {
  ticket: MailTicket & { customer_phone?: string }
  messages: Message[]
}

interface CannedResponse {
  id: number
  title?: string
  name?: string
  category?: string
  body?: string
  body_text?: string
}

const STATUS_FILTERS = ['open', 'pending', 'resolved', 'closed'] as const

function initials(name?: string) {
  return (name || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ── Reading pane ──────────────────────────────────────────────────────────────
function MailThread({ ticketId, onReplied }: { ticketId: number; onReplied: () => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<DetailResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [cannedOpen, setCannedOpen] = useState(false)
  const [canned, setCanned] = useState<CannedResponse[]>([])
  const [cannedLoaded, setCannedLoaded] = useState(false)

  function toggleCanned() {
    setCannedOpen(o => !o)
    if (!cannedLoaded) {
      apiFetch<any>('/api/helpdesk/canned-responses')
        .then(r => setCanned((Array.isArray(r) ? r : (r?.data ?? [])) as CannedResponse[]))
        .catch(() => setCanned([]))
        .finally(() => setCannedLoaded(true))
    }
  }
  function insertCanned(c: CannedResponse) {
    let text = c.body || c.body_text || ''
    const tk = data?.ticket
    if (tk) {
      text = text
        .replace(/\{\{\s*customer_name\s*\}\}/gi, tk.customer_name || 'there')
        .replace(/\{\{\s*ticket_ref\s*\}\}/gi, tk.ticket_ref || '')
    }
    setReply(prev => (prev.trim() ? prev.trimEnd() + '\n\n' + text : text))
    setCannedOpen(false)
    apiPost(`/api/helpdesk/canned-responses/${c.id}/use`, {}).catch(() => {}) // best-effort usage tracking
  }

  const load = useCallback(() => {
    setLoading(true)
    apiFetch<DetailResp>(`/api/helpdesk/tickets/${ticketId}`)
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [ticketId])

  useEffect(() => { load() }, [load])

  async function send() {
    if (!reply.trim()) return
    setSending(true)
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/messages`, { body_text: reply.trim(), channel: 'email' })
      toast.success('Reply sent')
      setReply('')
      load()
      onReplied()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to send reply')
    } finally {
      setSending(false)
    }
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={22} /></div>
  if (!data) return <div style={{ padding: 40, color: 'var(--txt2)' }}>Could not load this mail.</div>

  const t = data.ticket
  const msgs = data.messages ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--bdr)', background: 'var(--card)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 4 }}>{t.subject || '(no subject)'}</div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              {t.customer_name || 'Unknown'}{t.customer_email ? ` · ${t.customer_email}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <StatusBadge status={t.status} size="sm" />
            {t.customer_cif && (
              <button onClick={() => navigate(`/customers/${t.customer_cif}`)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: RADIUS.md, padding: '4px 9px', cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>person</span>Customer 360
              </button>
            )}
            <button onClick={() => navigate(`/helpdesk/${t.id}`)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'none', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '4px 9px', cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>Ticket
            </button>
          </div>
        </div>
      </div>

      {/* Conversation */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {msgs.length === 0 && <div style={{ color: 'var(--txt3)', textAlign: 'center', padding: 40 }}>No messages on this mail yet.</div>}
        {msgs.map(m => {
          const agent = m.direction === 'outbound'
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: agent ? 'flex-end' : 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', background: agent ? `${NAVY}14` : `${BLUE}14`, color: agent ? NAVY : BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: FW.bold }}>
                  {initials(agent ? (m.author_user_name || m.author_name || 'O3') : (t.customer_name || '?'))}
                </div>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                  {agent ? (m.author_user_name || m.author_name || 'O3 Care') : (t.customer_name || 'Customer')}
                </span>
                <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(m.created_at)}</span>
                {m.is_internal_note && <span style={{ fontSize: TEXT['2xs'], color: AMBER, fontWeight: FW.bold }}>internal note</span>}
              </div>
              <div style={{
                maxWidth: '78%', padding: '10px 14px', borderRadius: RADIUS.lg, fontSize: TEXT.sm, lineHeight: 1.55,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: m.is_internal_note ? `${AMBER}10` : agent ? NAVY : 'var(--th-bg)',
                color: agent && !m.is_internal_note ? '#fff' : 'var(--txt)',
                border: agent && !m.is_internal_note ? 'none' : '1px solid var(--bdr)',
              }}>
                {m.body_text || '(empty)'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Reply */}
      <div style={{ borderTop: '1px solid var(--bdr)', padding: '12px 22px', background: 'var(--card)', flexShrink: 0, position: 'relative' }}>
        {/* Canned response picker */}
        {cannedOpen && (
          <div style={{ position: 'absolute', bottom: 'calc(100% - 6px)', left: 22, right: 22, zIndex: 20, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, boxShadow: '0 -8px 30px rgba(0,0,0,0.16)', maxHeight: 260, overflowY: 'auto' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--bdr)', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Canned Responses</div>
            {!cannedLoaded ? (
              <div style={{ padding: 16, textAlign: 'center' }}><Spinner size={14} /></div>
            ) : canned.length === 0 ? (
              <div style={{ padding: '12px', fontSize: TEXT.sm, color: 'var(--txt3)' }}>None yet — add them in Call Center → Canned Responses.</div>
            ) : canned.map(c => (
              <button key={c.id} type="button" onClick={() => insertCanned(c)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{c.title || c.name}</span>
                  {c.category && <span style={{ fontSize: TEXT['2xs'], color: BLUE, background: `${BLUE}14`, padding: '1px 6px', borderRadius: RADIUS.xl }}>{c.category}</span>}
                </div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{c.body || c.body_text}</div>
              </button>
            ))}
          </div>
        )}
        <textarea
          spellCheck={false}
          value={reply}
          onChange={e => setReply(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send() }}
          rows={3}
          placeholder={`Reply to ${t.customer_name || 'customer'} by email…  (Cmd/Ctrl+Enter to send)`}
          style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <button onClick={toggleCanned} type="button"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: cannedOpen ? `${NAVY}12` : 'transparent', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>bolt</span>
            Canned
          </button>
          <button onClick={send} disabled={sending || !reply.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.bold, cursor: sending || !reply.trim() ? 'not-allowed' : 'pointer', opacity: sending || !reply.trim() ? 0.6 : 1, fontFamily: SORA }}>
            {sending ? <Spinner size={13} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>}
            Send Reply
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function CareInbox() {
  const [items, setItems] = useState<MailTicket[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [status, setStatus] = useState('open')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const params = new URLSearchParams({ channel: 'email', per_page: '100' })
      if (status) params.set('status', status)
      if (debounced) params.set('search', debounced)
      const resp = await apiFetch<{ tickets: MailTicket[]; total: number }>(`/api/helpdesk/tickets?${params}`)
      setItems(resp.tickets ?? [])
      setTotal(resp.total ?? 0)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [status, debounced])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })
  useEffect(() => {
    const h = setTimeout(() => setDebounced(search.trim()), 350)
    return () => clearTimeout(h)
  }, [search])

  return (
    <Page title="Care Inbox" subtitle="Customer mail — handled as tickets" noPad>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        {/* Mail list */}
        <div style={{ width: 380, minWidth: 320, maxWidth: 420, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', background: 'var(--card)', flexShrink: 0 }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>Inbox</span>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{total} mail{total !== 1 ? 's' : ''}</span>
            </div>
            <TblSearch value={search} onChange={setSearch} placeholder="Search sender, subject, ref…" width={0} style={{ marginBottom: SP[2] }} />
            <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
              {STATUS_FILTERS.map(s => {
                const on = status === s
                return (
                  <button key={s} onClick={() => setStatus(on ? '' : s)}
                    style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS.full, textTransform: 'capitalize', border: `1px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? `${NAVY}12` : 'transparent', color: on ? NAVY : 'var(--txt3)', cursor: 'pointer' }}>
                    {s}
                  </button>
                )
              })}
            </div>
          </div>

          {err && <div style={{ padding: '10px 14px' }}><ErrBanner error={err} onRetry={load} /></div>}

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={16} /></div>
            ) : items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: TEXT.base }}>No mail in this view.</div>
            ) : items.map(m => {
              const on = selected === m.id
              const pColor = m.priority === 'urgent' || m.priority === 'high' ? RED : m.priority === 'medium' || m.priority === 'normal' ? AMBER : GREEN
              return (
                <div key={m.id} onClick={() => setSelected(m.id)}
                  style={{ display: 'flex', gap: 10, padding: '11px 14px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer', background: on ? `${NAVY}08` : undefined, borderLeft: `3px solid ${on ? NAVY : 'transparent'}` }}
                  onMouseEnter={e => { if (!on) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!on) (e.currentTarget as HTMLElement).style.background = '' }}>
                  <div style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, background: `${pColor}18`, color: pColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold }}>
                    {initials(m.customer_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.customer_name || 'Unknown'}</span>
                      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', flexShrink: 0 }}>{fmtDate(m.last_message_at || m.created_at)}</span>
                    </div>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{m.subject || '(no subject)'}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{m.last_message_preview || m.customer_email || m.ticket_ref}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Reading pane */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)' }}>
          {selected ? (
            <MailThread key={selected} ticketId={selected} onReplied={load} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 52, color: 'var(--txt3)' }}>mail</span>
              <span style={{ fontSize: TEXT.md }}>Select a mail to read and reply</span>
            </div>
          )}
        </div>
      </div>
    </Page>
  )
}
