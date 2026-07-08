import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { Page, SectionCard, ErrBanner, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, GREEN, AMBER, RED, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MailMessage {
  id:                  number
  kind:                string
  related_type:        string | null
  related_id:          number | null
  subject:             string | null
  from_email:          string | null
  from_name:           string | null
  recipients:          any
  status:              string
  provider_message_id: string | null
  queued_at:           string | null
  delivered_at:        string | null
  opened_at:           string | null
  clicked_at:          string | null
  bounced_at:          string | null
  last_error:          string | null
  created_at:          string
  updated_at:          string
  html_body:           string | null
  text_body:           string | null
}

interface InboundReply {
  id:          number
  from_email:  string
  from_name:   string | null
  subject:     string | null
  body_text:   string | null
  body_html:   string | null
  is_read:     boolean
  received_at: string
}

interface MailEvent {
  id:          number
  event_type:  string
  event_data:  any
  occurred_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  delivered:    GREEN,
  opened:       GREEN,
  clicked:      GREEN,
  sent:         NAVY,
  queued:       '#6B7280',
  processing:   AMBER,
  failed:       RED,
  bounced:      RED,
  spam_report:  RED,
  unsubscribed: AMBER,
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return (
    <span style={{ ...NUM, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: `${c}14`, color: c }}>
      {label}
    </span>
  )
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
      <span style={{ color: 'var(--txt3)', minWidth: 80, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--txt)', fontWeight: 500 }}>{value}</span>
    </div>
  )
}

function recipientList(recipients: any): string {
  if (!recipients) return '—'
  try {
    const parsed = typeof recipients === 'string' ? JSON.parse(recipients) : recipients
    if (parsed?.to && Array.isArray(parsed.to)) {
      return parsed.to.map((r: any) => r.name ? `${r.name} <${r.email}>` : r.email).filter(Boolean).join(', ')
    }
  } catch {}
  if (Array.isArray(recipients)) {
    return recipients.map((r: any) => (typeof r === 'string' ? r : (r.Name ? `${r.Name} <${r.Email}>` : r.Email))).join(', ')
  }
  return typeof recipients === 'string' ? recipients : JSON.stringify(recipients)
}

function Avatar({ name }: { name: string }) {
  return (
    <div style={{
      width: 32, height: 32, borderRadius: '50%', background: NAVY, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 700, color: '#fff',
    }}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MailThreadDetail() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const autoReply = searchParams.get('reply') === '1'

  const [msg, setMsg]         = useState<MailMessage | null>(null)
  const [replies, setReplies] = useState<InboundReply[]>([])
  const [events, setEvents]   = useState<MailEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const [replyBody, setReplyBody] = useState('')
  const [replyCc, setReplyCc]     = useState('')
  const [showCc, setShowCc]       = useState(false)
  const [sending, setSending]     = useState(false)
  const [sendErr, setSendErr]     = useState<string | null>(null)
  const [replySent, setReplySent] = useState(false)
  const replyRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setErr(null)
    try {
      const [msgRes, repliesRes, eventsRes] = await Promise.all([
        apiFetch<MailMessage>(`/api/mail/messages/${id}`),
        apiFetch<InboundReply[]>(`/api/mail/messages/${id}/replies`).catch(() => [] as InboundReply[]),
        apiFetch<MailEvent[]>(`/api/mail/messages/${id}/events`).catch(() => [] as MailEvent[]),
      ])
      setMsg(msgRes)
      setReplies(Array.isArray(repliesRes) ? repliesRes : [])
      setEvents(Array.isArray(eventsRes) ? eventsRes : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  // Auto-focus reply box when navigated from inbox Reply button
  useEffect(() => {
    if (autoReply && replyRef.current) {
      replyRef.current.focus()
      replyRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [autoReply, loading])

  async function sendReply() {
    if (!replyBody.trim()) return
    setSending(true); setSendErr(null)
    try {
      const cc = replyCc.split(',').map(s => s.trim()).filter(Boolean).map(e => ({ Email: e, Name: '' }))
      await apiPost(`/api/mail/messages/${id}/reply`, { text_body: replyBody, cc })
      setReplyBody('')
      setReplyCc('')
      setShowCc(false)
      setReplySent(true)
      setTimeout(() => setReplySent(false), 3000)
      load()
    } catch (ex: any) { setSendErr(ex.message) }
    finally { setSending(false) }
  }

  const m = msg

  const openEvents  = events.filter(e => e.event_type === 'open' || e.event_type === 'opened')
  const clickEvents = events.filter(e => e.event_type === 'click' || e.event_type === 'clicked')

  const lastReplySender = replies.length > 0
    ? (replies[replies.length - 1].from_name ?? replies[replies.length - 1].from_email)
    : null

  return (
    <Page
      title={m?.subject ?? 'Message'}
      subtitle={m ? `${m.kind.charAt(0).toUpperCase() + m.kind.slice(1)} · ${m.status}` : 'Loading…'}
      actions={
        <button
          onClick={() => navigate('/mail')}
          style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: 13,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: INTER,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>
          Mail
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--txt3)', fontSize: 13 }}>
          Loading message…
        </div>
      )}

      {!loading && m && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>

          {/* ── Header ── */}
          <SectionCard title="Message Details">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Status badges row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                <StatusPill status={m.status} />
                {m.delivered_at && (
                  <span style={{ fontSize: 12, color: GREEN, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
                    Delivered {fmtDatetime(m.delivered_at)}
                  </span>
                )}
                {openEvents.length > 0 ? (
                  <span style={{ fontSize: 12, color: GREEN, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>mail_open</span>
                    Opened {openEvents.length > 1 ? `${openEvents.length}×` : ''} · {fmtDatetime(openEvents[0].occurred_at)}
                  </span>
                ) : m.opened_at ? (
                  <span style={{ fontSize: 12, color: GREEN, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>mail_open</span>
                    Opened {fmtDatetime(m.opened_at)}
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--txt3)', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>mail</span>
                    Not opened yet
                  </span>
                )}
                {replies.length > 0 && (
                  <span style={{ fontSize: 12, color: BLUE, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>reply</span>
                    {replies.length} repl{replies.length === 1 ? 'y' : 'ies'}
                  </span>
                )}
              </div>
              <MetaRow label="From"    value={m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email} />
              <MetaRow label="To"      value={recipientList(m.recipients)} />
              <MetaRow label="Subject" value={m.subject} />
              <MetaRow label="Sent"    value={m.created_at ? fmtDatetime(m.created_at) : null} />
              {m.last_error && <MetaRow label="Error" value={m.last_error} />}
            </div>
          </SectionCard>

          {/* ── Message body ── */}
          {(m.text_body || m.html_body) && (
            <SectionCard title="Message Body">
              {m.html_body ? (
                <div
                  style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--txt)', fontFamily: INTER }}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(m.html_body) }}
                />
              ) : (
                <pre style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--txt)', fontFamily: INTER, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                  {m.text_body}
                </pre>
              )}
            </SectionCard>
          )}

          {/* ── Delivery & tracking timeline ── */}
          <SectionCard title="Delivery & Tracking">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'Sent',      time: m.created_at,   color: NAVY,      icon: 'send' },
                { label: 'Queued',    time: m.queued_at,    color: '#6B7280',  icon: 'schedule' },
                { label: 'Delivered', time: m.delivered_at, color: GREEN,      icon: 'check_circle' },
                { label: 'Bounced',   time: m.bounced_at,   color: RED,        icon: 'error' },
              ].map(e => e.time && (
                <div key={e.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: e.color, flexShrink: 0 }}>{e.icon}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', minWidth: 90 }}>{e.label}</span>
                  <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM }}>{fmtDatetime(e.time)}</span>
                </div>
              ))}

              {/* Each open event */}
              {openEvents.length > 0 ? openEvents.map((ev, i) => (
                <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: GREEN, flexShrink: 0 }}>mail_open</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', minWidth: 90 }}>
                    Opened{openEvents.length > 1 ? ` (${i + 1}/${openEvents.length})` : ''}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM }}>{fmtDatetime(ev.occurred_at)}</span>
                </div>
              )) : m.opened_at ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: GREEN, flexShrink: 0 }}>mail_open</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', minWidth: 90 }}>Opened</span>
                  <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM }}>{fmtDatetime(m.opened_at)}</span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--bdr)', flexShrink: 0 }}>mail</span>
                  <span style={{ fontSize: 12.5, color: 'var(--txt3)', minWidth: 90 }}>Opened</span>
                  <span style={{ fontSize: 12, color: 'var(--txt3)' }}>—</span>
                </div>
              )}

              {/* Each click event */}
              {clickEvents.map((ev, i) => (
                <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: BLUE, flexShrink: 0 }}>touch_app</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', minWidth: 90 }}>
                    Link clicked{clickEvents.length > 1 ? ` (${i + 1})` : ''}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM }}>{fmtDatetime(ev.occurred_at)}</span>
                </div>
              ))}

              {openEvents.length === 0 && !m.opened_at && clickEvents.length === 0 && !m.delivered_at && !m.bounced_at && (
                <div style={{ fontSize: 13, color: 'var(--txt3)' }}>Waiting for delivery confirmation from SendGrid…</div>
              )}
            </div>
          </SectionCard>

          {/* ── Replies from recipient ── */}
          {replies.length > 0 && (
            <SectionCard title={`Replies (${replies.length})`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {replies.map(reply => (
                  <div key={reply.id} style={{
                    background: 'var(--th-bg)', borderRadius: 10,
                    border: '1px solid var(--bdr)', overflow: 'hidden',
                  }}>
                    {/* Reply header */}
                    <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--bdr)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={reply.from_name ?? reply.from_email} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
                            {reply.from_name ?? reply.from_email}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{reply.from_email}</div>
                        </div>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM, flexShrink: 0 }}>
                        {fmtDatetime(reply.received_at)}
                      </span>
                    </div>
                    {/* Reply body */}
                    <div style={{ padding: '12px 14px' }}>
                      {reply.body_html ? (
                        <div
                          style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--txt)', fontFamily: INTER }}
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(reply.body_html) }}
                        />
                      ) : (
                        <pre style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--txt)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: INTER }}>
                          {reply.body_text ?? '(no content)'}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* ── Reply form ── */}
          <SectionCard title={lastReplySender ? `Reply to ${lastReplySender}` : 'Reply'}>
            {replySent ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: GREEN, fontSize: 13, fontWeight: 600 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>check_circle</span>
                Reply sent successfully
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {showCc && (
                  <div>
                    <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER, letterSpacing: '0.05em', textTransform: 'uppercase' }}>CC</label>
                    <input
                      value={replyCc}
                      onChange={e => setReplyCc(e.target.value)}
                      placeholder="colleague@o3capital.com, another@o3capital.com"
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 13, outline: 'none', fontFamily: INTER }}
                    />
                  </div>
                )}
                <textarea
                  ref={replyRef}
                  value={replyBody}
                  onChange={e => setReplyBody(e.target.value)}
                  placeholder="Write your reply…"
                  rows={5}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 13.5, lineHeight: 1.6, resize: 'vertical', outline: 'none', fontFamily: INTER }}
                />
                {sendErr && <div style={{ fontSize: 12, color: RED }}>{sendErr}</div>}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    onClick={sendReply}
                    disabled={sending || !replyBody.trim()}
                    style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>send</span>
                    {sending ? 'Sending…' : 'Send Reply'}
                  </button>
                  <button onClick={() => setShowCc(v => !v)} style={btnSecondary}>
                    {showCc ? 'Hide CC' : 'Add CC'}
                  </button>
                </div>
              </div>
            )}
          </SectionCard>

        </div>
      )}
    </Page>
  )
}
