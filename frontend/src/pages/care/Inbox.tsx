import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Page, Spinner, ErrBanner, TblSearch, StatusBadge } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, FW, RADIUS, SP, TEXT, SORA } from '../../lib/design'
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
  description_preview?: string
  description?: string
}

interface Message {
  id: number
  direction: 'inbound' | 'outbound'
  author_name?: string
  author_user_name?: string
  body_text: string
  body_html?: string
  is_internal_note?: boolean
  created_at: string
}

interface DetailResp {
  ticket: MailTicket & { customer_phone?: string; assigned_to?: number; assigned_to_name?: string }
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

// ── Customer history (read-only context + internal notes) ─────────────────────

interface HistTicket {
  id: number; ticket_ref: string; channel: string; status: string; priority?: string
  subject: string; created_at: string; last_at?: string; assigned_to_name?: string
}
interface HistCall {
  id: number; direction: string; outcome: string; duration_sec: number
  agent_name?: string; customer_name?: string; started_at: string
}

const CHANNEL_ICON: Record<string, string> = {
  call: 'call', email: 'mail', sms: 'sms', whatsapp: 'chat', social: 'groups', web: 'language',
}

// One prior ticket — read-only thread, expandable, with an internal-note box.
function HistoryTicket({ t }: { t: HistTicket }) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Message[] | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  function toggle() {
    setOpen(o => !o)
    if (msgs === null) {
      apiFetch<DetailResp>(`/api/helpdesk/tickets/${t.id}`)
        .then(d => setMsgs(d.messages ?? []))
        .catch(() => setMsgs([]))
    }
  }
  async function saveNote() {
    if (!note.trim()) return
    setSaving(true)
    try {
      await apiPost(`/api/helpdesk/tickets/${t.id}/messages`, { body_text: note.trim(), is_internal_note: true })
      toast.success('Note added')
      setNote('')
      setMsgs(null); if (open) { apiFetch<DetailResp>(`/api/helpdesk/tickets/${t.id}`).then(d => setMsgs(d.messages ?? [])).catch(() => {}) }
    } catch (e: any) { toast.error(e.message ?? 'Failed to add note') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, marginBottom: 8, overflow: 'hidden' }}>
      <button type="button" onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>{CHANNEL_ICON[t.channel] ?? 'confirmation_number'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || '(no subject)'}</div>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{t.channel} · {t.assigned_to_name || 'unassigned'} · {fmtDate(t.last_at || t.created_at)}</div>
        </div>
        <StatusBadge status={t.status} size="sm" />
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--bdr)', padding: '8px 10px', background: 'var(--th-bg)' }}>
          {msgs === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 10 }}><Spinner size={13} /></div>
          ) : msgs.length === 0 ? (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', padding: '4px 0' }}>No messages.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
              {msgs.map(m => (
                <div key={m.id} style={{ fontSize: TEXT.xs, color: 'var(--txt2)', paddingLeft: 8, borderLeft: `2px solid ${m.is_internal_note ? AMBER : m.direction === 'outbound' ? NAVY : 'var(--bdr)'}` }}>
                  <span style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{m.is_internal_note ? 'Note' : m.direction === 'outbound' ? (m.author_user_name || m.author_name || 'Agent') : 'Customer'}</span>
                  <span style={{ color: 'var(--txt3)' }}> · {fmtDatetime(m.created_at)}</span>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 1 }}>{m.body_text}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add internal note…"
              onKeyDown={e => { if (e.key === 'Enter') saveNote() }}
              style={{ flex: 1, height: 30, padding: '0 8px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.sm, fontSize: TEXT.xs, background: 'var(--input-bg)', color: 'var(--txt)' }} />
            <button type="button" onClick={saveNote} disabled={saving || !note.trim()}
              style={{ padding: '0 10px', border: 'none', borderRadius: RADIUS.sm, background: NAVY, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.bold, cursor: saving || !note.trim() ? 'not-allowed' : 'pointer', opacity: saving || !note.trim() ? 0.6 : 1 }}>Note</button>
          </div>
        </div>
      )}
    </div>
  )
}

function CustomerHistory({ cif, email, excludeId }: { cif?: string; email?: string; excludeId: number }) {
  const [data, setData] = useState<{ tickets: HistTicket[]; calls: HistCall[] } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const p = new URLSearchParams()
    if (cif) p.set('cif', cif)
    if (email) p.set('email', email)
    p.set('exclude', String(excludeId))
    apiFetch<any>(`/api/helpdesk/customer-history?${p}`)
      .then(r => setData((r?.data ?? r) as { tickets: HistTicket[]; calls: HistCall[] }))
      .catch(() => setData({ tickets: [], calls: [] }))
      .finally(() => setLoading(false))
  }, [cif, email, excludeId])

  return (
    <div style={{ width: 340, minWidth: 300, borderLeft: '1px solid var(--bdr)', background: 'var(--card)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflowY: 'auto' }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>Customer History</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Read-only · add internal notes</div>
      </div>
      <div style={{ padding: '12px 14px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}><Spinner size={16} /></div>
        ) : !cif && !email ? (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>No CIF or email on this mail — can't match prior history.</div>
        ) : (
          <>
            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
              Other Tickets ({data?.tickets.length ?? 0})
            </div>
            {(data?.tickets.length ?? 0) === 0 ? (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 14 }}>No other tickets.</div>
            ) : (
              <div style={{ marginBottom: 14 }}>{data!.tickets.map(t => <HistoryTicket key={t.id} t={t} />)}</div>
            )}

            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
              Recent Calls ({data?.calls.length ?? 0})
            </div>
            {(data?.calls.length ?? 0) === 0 ? (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>No calls on record.</div>
            ) : data!.calls.map(c => {
              const inbound = c.direction === 'inbound'
              const dur = c.duration_sec > 0 ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s` : '—'
              return (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: inbound ? BLUE : PURPLE }}>{inbound ? 'call_received' : 'call_made'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt)', fontWeight: FW.medium }}>{c.agent_name || 'Agent'} · {c.outcome}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(c.started_at)}</div>
                  </div>
                  <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{dur}</span>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

// Renders an HTML email body inside a sandboxed iframe (no allow-scripts, so email
// markup can't run JavaScript) — the standard safe way to display untrusted email
// HTML. The app CSP allows inline styles + https/data images, so formatting and
// images render; the frame auto-sizes to its content up to a cap, then scrolls.
function HtmlMessage({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [h, setH] = useState(60)
  const srcDoc = `<!doctype html><html><head><base target="_blank"><meta name="color-scheme" content="light"><style>
    html,body{margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2733;background:#fff;padding:14px 16px;overflow-wrap:anywhere;word-break:break-word}
    body *{max-width:100%}
    /* Neutralise the full-width / rounded grey backdrops email templates wrap content
       in — in this narrow pane they render as big empty grey blocks. Whiten the outer
       wrapper(s) and drop their rounding so the message reads as clean content. */
    body > *{background-color:#fff!important;background-image:none!important;border-radius:0!important}
    body > * > table,table[width="100%"]{background-color:#fff!important;background-image:none!important}
    p{margin:0 0 10px}
    img{height:auto!important}
    table{border-collapse:collapse}
    td,th{word-break:break-word}
    a{color:#0E2841;text-decoration:underline}
    blockquote,.gmail_quote{margin:10px 0;padding:2px 0 2px 12px;border-left:3px solid #e6e8eb;color:#6b7280}
    hr{border:none;border-top:1px solid #edf0f2;margin:14px 0}
    pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0}
  </style></head><body>${html}</body></html>`
  function measure() {
    try {
      const doc = ref.current?.contentDocument
      if (doc?.body) setH(Math.min(760, Math.max(44, doc.documentElement?.scrollHeight || doc.body.scrollHeight)))
    } catch { /* sandboxed access denied — keep default height */ }
  }
  function onLoad() { measure(); setTimeout(measure, 400); setTimeout(measure, 1200) }
  return (
    <div style={{ maxWidth: '82%', width: '82%', borderRadius: RADIUS.lg, overflow: 'hidden', border: '1px solid var(--bdr)', background: '#fff' }}>
      <iframe ref={ref} title="message" sandbox="allow-same-origin" srcDoc={srcDoc} onLoad={onLoad}
        style={{ width: '100%', height: h, border: 'none', display: 'block', background: '#fff' }} />
    </div>
  )
}

// ── Reading pane ──────────────────────────────────────────────────────────────
function MailThread({ ticketId, onReplied }: { ticketId: number; onReplied: () => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<DetailResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<{ filename: string; content_type: string; content: string; size: number }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [cannedOpen, setCannedOpen] = useState(false)
  const [canned, setCanned] = useState<CannedResponse[]>([])
  const [cannedLoaded, setCannedLoaded] = useState(false)

  function toggleCanned() {
    setCannedOpen(o => !o)
    if (!cannedLoaded) {
      apiFetch<any>('/api/helpdesk/canned-responses?channel=email')
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

  // Read picked files as base64 for the message attachments payload (matches the
  // backend MailAttachment shape). Enforces the same 10 MB / 10-file limits.
  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const picked: { filename: string; content_type: string; content: string; size: number }[] = []
    for (const f of Array.from(files)) {
      if (f.size > 10 * 1024 * 1024) { toast.error(`${f.name} is larger than 10 MB`); continue }
      try {
        const b64 = await new Promise<string>((res, rej) => {
          const rd = new FileReader()
          rd.onload = () => res(String(rd.result).split(',')[1] ?? '')
          rd.onerror = () => rej(rd.error)
          rd.readAsDataURL(f)
        })
        picked.push({ filename: f.name, content_type: f.type || 'application/octet-stream', content: b64, size: f.size })
      } catch { toast.error(`Could not read ${f.name}`) }
    }
    setAttachments(prev => {
      const next = [...prev, ...picked]
      if (next.length > 10) { toast.error('Maximum 10 attachments'); return next.slice(0, 10) }
      return next
    })
    if (fileRef.current) fileRef.current.value = ''
  }

  async function send() {
    if (!reply.trim()) return
    setSending(true)
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/messages`, {
        body_text: reply.trim(), channel: 'email',
        attachments: attachments.map(({ filename, content_type, content }) => ({ filename, content_type, content })),
      })
      toast.success('Reply sent')
      setReply('')
      setAttachments([])
      load()
      onReplied()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to send reply')
    } finally {
      setSending(false)
    }
  }

  async function claim() {
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/claim`, {})
      toast.success('Assigned to you')
      load(); onReplied()
    } catch (e: any) { toast.error(e.message ?? 'Failed to assign') }
  }

  async function setStatus(status: string) {
    try {
      await apiFetch(`/api/helpdesk/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      toast.success(status === 'resolved' ? 'Marked resolved' : 'Reopened')
      load(); onReplied()
    } catch (e: any) { toast.error(e.message ?? 'Failed to update') }
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={22} /></div>
  if (!data) return <div style={{ padding: 40, color: 'var(--txt2)' }}>Could not load this mail.</div>

  const t = data.ticket
  const msgs = data.messages ?? []
  // Some mails — especially system-notification emails — arrive with the body on the
  // ticket itself (description) and no separate message row. Surface that so a mail
  // with real content never renders blank; only a truly empty notification shows the
  // hint below.
  const displayMsgs: Message[] = msgs.length > 0
    ? msgs
    : (t.description
        ? [{ id: -1, direction: 'inbound', author_name: t.customer_name, body_text: t.description, created_at: t.created_at }]
        : [])

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
            <button onClick={() => setHistoryOpen(o => !o)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: historyOpen ? NAVY : 'var(--txt2)', background: historyOpen ? `${NAVY}12` : 'none', border: `1px solid ${historyOpen ? NAVY + '30' : 'var(--bdr)'}`, borderRadius: RADIUS.md, padding: '4px 9px', cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>history</span>Context
            </button>
            <button onClick={() => navigate(`/helpdesk/${t.id}`)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'none', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '4px 9px', cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>Ticket
            </button>
          </div>
        </div>
        {/* Assignee + workflow actions */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
            {t.assigned_to_name ? `Assigned to ${t.assigned_to_name}` : 'Unassigned'}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {!t.assigned_to && (
              <button onClick={claim}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: RADIUS.md, padding: '5px 10px', cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>person_add</span>Assign to me
              </button>
            )}
            {['resolved', 'closed'].includes(t.status) ? (
              <button onClick={() => setStatus('open')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'none', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '5px 10px', cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>replay</span>Reopen
              </button>
            ) : (
              <button onClick={() => setStatus('resolved')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.bold, color: '#fff', background: GREEN, border: 'none', borderRadius: RADIUS.md, padding: '5px 12px', cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check</span>Resolve
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Body: conversation + reply on the left, customer history rail on the right */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
      {/* Conversation */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {displayMsgs.length === 0 && <div style={{ color: 'var(--txt3)', textAlign: 'center', padding: 40 }}>This mail has no message body — it may be a system notification (e.g. a registration or transaction alert).</div>}
        {displayMsgs.map(m => {
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
              {m.body_html && !m.is_internal_note ? (
                <HtmlMessage html={m.body_html} />
              ) : (
                <div style={{
                  maxWidth: '78%', padding: '10px 14px', borderRadius: RADIUS.lg, fontSize: TEXT.sm, lineHeight: 1.55,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: m.is_internal_note ? `${AMBER}10` : agent ? NAVY : 'var(--th-bg)',
                  color: agent && !m.is_internal_note ? '#fff' : 'var(--txt)',
                  border: agent && !m.is_internal_note ? 'none' : '1px solid var(--bdr)',
                }}>
                  {m.body_text || '(empty)'}
                </div>
              )}
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
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {attachments.map((a, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.xs, color: 'var(--txt2)', maxWidth: 240 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14, color: NAVY }}>attach_file</span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.filename}</span>
                <span style={{ color: 'var(--txt3)', flexShrink: 0 }}>{(a.size / 1024).toFixed(0)}KB</span>
                <button type="button" onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  style={{ display: 'inline-flex', border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--txt3)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
                </button>
              </span>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" multiple hidden onChange={e => onPickFiles(e.target.files)} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <div style={{ display: 'inline-flex', gap: 8 }}>
            <button onClick={toggleCanned} type="button"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: cannedOpen ? `${NAVY}12` : 'transparent', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>bolt</span>
              Canned
            </button>
            <button onClick={() => fileRef.current?.click()} type="button"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'transparent', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>attach_file</span>
              Attach
            </button>
          </div>
          <button onClick={send} disabled={sending || !reply.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.bold, cursor: sending || !reply.trim() ? 'not-allowed' : 'pointer', opacity: sending || !reply.trim() ? 0.6 : 1, fontFamily: SORA }}>
            {sending ? <Spinner size={13} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>}
            Send Reply
          </button>
        </div>
      </div>
        </div>
        {historyOpen && <CustomerHistory cif={t.customer_cif} email={t.customer_email} excludeId={t.id} />}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function CareInbox() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [items, setItems] = useState<MailTicket[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // Selection is mirrored to ?mail= so the Dashboard/Supervisor and notifications
  // can deep-link straight to a specific mail.
  const mailParam = searchParams.get('mail')
  const [selected, setSelected] = useState<number | null>(mailParam ? Number(mailParam) : null)
  const selectMail = useCallback((id: number) => {
    setSelected(id)
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('mail', String(id)); return p }, { replace: true })
  }, [setSearchParams])
  const [status, setStatus] = useState('open')
  const [owner, setOwner] = useState<'all' | 'mine' | 'unassigned'>('all')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const params = new URLSearchParams({ channel: 'email', per_page: '100' })
      if (status) params.set('status', status)
      if (owner === 'mine') params.set('assigned_to', 'me')
      else if (owner === 'unassigned') params.set('assigned_to', 'unassigned')
      if (debounced) params.set('search', debounced)
      const resp = await apiFetch<{ tickets: MailTicket[]; total: number }>(`/api/helpdesk/tickets?${params}`)
      setItems(resp.tickets ?? [])
      setTotal(resp.total ?? 0)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [status, owner, debounced])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })
  useEffect(() => {
    const h = setTimeout(() => setDebounced(search.trim()), 350)
    return () => clearTimeout(h)
  }, [search])
  // Follow the ?mail= param when it changes underneath us (deep-link while mounted).
  useEffect(() => {
    if (mailParam && Number(mailParam) !== selected) setSelected(Number(mailParam))
  }, [mailParam]) // eslint-disable-line react-hooks/exhaustive-deps

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
            {/* Owner filter */}
            <div style={{ display: 'flex', gap: SP[1], marginBottom: SP[2] }}>
              {(['all', 'mine', 'unassigned'] as const).map(o => {
                const on = owner === o
                return (
                  <button key={o} onClick={() => setOwner(o)}
                    style={{ flex: 1, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '4px 0', borderRadius: RADIUS.md, textTransform: 'capitalize', border: `1px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? NAVY : 'transparent', color: on ? '#fff' : 'var(--txt2)', cursor: 'pointer' }}>
                    {o === 'all' ? 'All' : o === 'mine' ? 'Mine' : 'Unassigned'}
                  </button>
                )
              })}
            </div>
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
                <div key={m.id} onClick={() => selectMail(m.id)}
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
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{m.last_message_preview || m.description_preview || m.customer_email || m.ticket_ref}</div>
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
