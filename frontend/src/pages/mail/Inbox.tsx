import { useState, useEffect, useCallback } from 'react'
import { ErrBanner } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, GREEN, NUM, SORA, MONO } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InboundMessage {
  id:                  number
  mail_message_id:     number | null
  from_email:          string
  from_name:           string | null
  to_email:            string | null
  subject:             string | null
  body_text:           string | null
  body_html:           string | null
  is_read:             boolean
  received_at:         string
}

interface SentMessage {
  id:          number
  subject:     string | null
  from_email:  string | null
  from_name:   string | null
  recipients:  any
  status:      string
  created_at:  string
}

interface SentDetail {
  html_body: string | null
  text_body: string | null
  subject:   string | null
}

interface Draft {
  id:         number
  subject:    string | null
  to_addrs:   { Email: string; Name: string }[] | null
  text_body:  string | null
  html_body:  string | null
  updated_at: string
}

type Folder = 'inbox' | 'sent' | 'drafts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?'
}

function fmtShort(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function parseAddresses(raw: string) {
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ Email: s, Name: '' }))
}

function recipientDisplay(recipients: any): string {
  if (!recipients) return ''
  try {
    const p = typeof recipients === 'string' ? JSON.parse(recipients) : recipients
    if (p?.to && Array.isArray(p.to)) return p.to.map((r: any) => r.name ?? r.email).filter(Boolean).join(', ')
  } catch {}
  if (Array.isArray(recipients)) return recipients.map((r: any) => r.Name || r.Email || r).join(', ')
  return ''
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Avatar({ name }: { name: string }) {
  return (
    <div style={{
      width: 26, height: 26, minWidth: 26, borderRadius: '50%',
      background: BLUE, color: '#fff', fontFamily: SORA,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 10, fontWeight: 600,
    }}>
      {initials(name)}
    </div>
  )
}

interface ComposeModalProps {
  initialTo: string
  initialSubj: string
  onClose: () => void
  onSent: () => void
}

function ComposeModal({ initialTo, initialSubj, onClose, onSent }: ComposeModalProps) {
  const [to,      setTo]      = useState(initialTo)
  const [subj,    setSubj]    = useState(initialSubj)
  const [body,    setBody]    = useState('')
  const [sending, setSending] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [saved,   setSaved]   = useState(false)

  async function send() {
    if (!to.trim() || !subj.trim() || !body.trim()) return
    setSending(true); setErr(null)
    try {
      await apiPost('/api/mail/send', {
        to: parseAddresses(to), cc: [], bcc: [],
        subject: subj, text_body: body, send_copy_to_sender: true,
      })
      onSent()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSending(false) }
  }

  async function saveDraft() {
    setSaving(true); setErr(null); setSaved(false)
    try {
      await apiPost('/api/mail/drafts', {
        subject: subj,
        to_addrs: to ? parseAddresses(to) : [],
        text_body: body,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', border: 'none', outline: 'none', background: 'none',
    color: 'var(--txt)', fontFamily: SORA, fontSize: 13,
    padding: '11px 16px', borderBottom: '1px solid var(--bdr)',
    boxSizing: 'border-box',
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
      }}
    >
      <div style={{ width: 560, maxWidth: '94vw', background: 'var(--card)', borderRadius: 6, overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,.35)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', background: NAVY, color: '#fff', padding: '11px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: SORA }}>
          New message
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        {/* Fields */}
        <input placeholder="To" value={to} onChange={e => setTo(e.target.value)} style={inputStyle} />
        <input placeholder="Subject" value={subj} onChange={e => setSubj(e.target.value)} style={inputStyle} />
        <textarea
          placeholder="Write your message…"
          value={body}
          onChange={e => setBody(e.target.value)}
          style={{ ...inputStyle, height: 200, resize: 'vertical', borderBottom: 'none', lineHeight: 1.6 }}
        />
        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--bdr)', alignItems: 'center' }}>
          <button
            onClick={send}
            disabled={sending || !to.trim() || !subj.trim() || !body.trim()}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none',
              background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', fontFamily: SORA, opacity: sending ? 0.6 : 1,
            }}>
            {sending ? 'Sending…' : 'Send'}
          </button>
          <button
            onClick={saveDraft}
            disabled={saving}
            style={{
              padding: '7px 14px', borderRadius: 7, border: '1px solid var(--bdr)',
              background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', fontFamily: SORA, opacity: saving ? 0.6 : 1,
            }}>
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save draft'}
          </button>
          {err && <span style={{ fontSize: 12, color: '#EF4444', marginLeft: 4 }}>{err}</span>}
        </div>
      </div>
    </div>
  )
}

// ── Mail item ─────────────────────────────────────────────────────────────────

interface MailItemData {
  id:       number
  from:     string
  time:     string
  subject:  string
  preview:  string
  isUnread: boolean
  toAddr:   string
  rawInbound?: InboundMessage
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MailInbox() {
  const [folder, setFolder]       = useState<Folder>('inbox')
  const [inbox, setInbox]         = useState<InboundMessage[]>([])
  const [sent, setSent]           = useState<SentMessage[]>([])
  const [drafts, setDrafts]       = useState<Draft[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [selId, setSelId]         = useState<number | null>(null)
  const [sentBody, setSentBody]   = useState<SentDetail | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeTo, setComposeTo]     = useState('')
  const [composeSubj, setComposeSubj] = useState('')

  const loadFolder = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      if (folder === 'inbox') {
        const res = await apiFetch<InboundMessage[]>('/api/mail/inbox')
        setInbox(Array.isArray(res) ? res : [])
      } else if (folder === 'sent') {
        const res = await apiFetch<SentMessage[]>('/api/mail/messages')
        setSent(Array.isArray(res) ? res : [])
      } else {
        const res = await apiFetch<Draft[]>('/api/mail/drafts')
        setDrafts(Array.isArray(res) ? res : [])
      }
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [folder])

  useEffect(() => { loadFolder() }, [loadFolder])

  // Build normalized item list for the current folder
  const items: MailItemData[] = (() => {
    if (folder === 'inbox') {
      return inbox.map(m => ({
        id:       m.id,
        from:     m.from_name ?? m.from_email,
        time:     fmtShort(m.received_at),
        subject:  m.subject ?? '(no subject)',
        preview:  m.body_text?.slice(0, 100) ?? '',
        isUnread: !m.is_read,
        toAddr:   m.to_email ?? '',
        rawInbound: m,
      }))
    }
    if (folder === 'sent') {
      return sent.map(m => ({
        id:      m.id,
        from:    m.from_name ?? m.from_email ?? 'Me',
        time:    fmtShort(m.created_at),
        subject: m.subject ?? '(no subject)',
        preview: recipientDisplay(m.recipients) ? `To: ${recipientDisplay(m.recipients)}` : '',
        isUnread: false,
        toAddr:  recipientDisplay(m.recipients),
      }))
    }
    // drafts
    return drafts.map(m => ({
      id:      m.id,
      from:    'Draft',
      time:    fmtShort(m.updated_at),
      subject: m.subject ?? '(no subject)',
      preview: m.text_body?.slice(0, 100) ?? '',
      isUnread: false,
      toAddr:  (m.to_addrs ?? []).map(a => a.Name || a.Email).join(', '),
    }))
  })()

  const selItem = selId !== null ? (items.find(it => it.id === selId) ?? null) : null
  const unreadCount = inbox.filter(m => !m.is_read).length

  // Find the raw inbound/draft for the selected item
  const selInbound = selItem?.rawInbound ?? null
  const selDraft   = folder === 'drafts' ? (drafts.find(d => d.id === selId) ?? null) : null
  const selSent    = folder === 'sent'   ? (sent.find(s => s.id === selId) ?? null) : null

  function openItem(item: MailItemData) {
    setSelId(item.id)
    setSentBody(null)

    if (folder === 'inbox' && item.rawInbound && !item.rawInbound.is_read) {
      setInbox(prev => prev.map(m => m.id === item.id ? { ...m, is_read: true } : m))
      apiPut(`/api/mail/inbox/${item.id}/read`, {}).catch(() => {})
    }

    if (folder === 'sent') {
      setBodyLoading(true)
      apiFetch<SentDetail>(`/api/mail/messages/${item.id}`)
        .then(d => setSentBody(d))
        .catch(() => setSentBody(null))
        .finally(() => setBodyLoading(false))
    }
  }

  function openCompose(to = '', subj = '') {
    setComposeTo(to); setComposeSubj(subj); setComposeOpen(true)
  }

  // ── Reader pane body ─────────────────────────────────────────────────────────

  function renderReaderBody() {
    if (folder === 'inbox' && selInbound) {
      const html = selInbound.body_html
      const text = selInbound.body_text
      if (html) return <div style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', fontFamily: SORA }} dangerouslySetInnerHTML={{ __html: html }} />
      return <pre style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', whiteSpace: 'pre-line', margin: 0, fontFamily: SORA }}>{text ?? '(no content)'}</pre>
    }
    if (folder === 'sent') {
      if (bodyLoading) return <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: SORA }}>Loading…</div>
      const html = sentBody?.html_body
      const text = sentBody?.text_body
      if (html) return <div style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', fontFamily: SORA }} dangerouslySetInnerHTML={{ __html: html }} />
      if (text) return <pre style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', whiteSpace: 'pre-line', margin: 0, fontFamily: SORA }}>{text}</pre>
      return <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: SORA }}>(no body)</div>
    }
    if (folder === 'drafts' && selDraft) {
      const text = selDraft.text_body ?? selDraft.html_body
      return <pre style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', whiteSpace: 'pre-line', margin: 0, fontFamily: SORA }}>{text ?? '(no content)'}</pre>
    }
    return null
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const folderLabel = folder.charAt(0).toUpperCase() + folder.slice(1)
  const folderCountLabel = folder === 'inbox'
    ? `${items.length} · ${unreadCount} unread`
    : String(items.length)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)', fontFamily: SORA }}>

      {/* Page title bar */}
      <div style={{ padding: '20px 24px 0', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)', fontFamily: SORA, lineHeight: 1.2 }}>Mail</div>
          <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 2, fontFamily: SORA }}>Inbox, sent messages and drafts</div>
        </div>
      </div>

      {err && (
        <div style={{ padding: '0 24px' }}>
          <ErrBanner error={err} onRetry={loadFolder} />
        </div>
      )}

      {/* Split pane */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', marginTop: 16 }}>

        {/* ── Left pane: list ── */}
        <div style={{
          width: 390, minWidth: 300, flexShrink: 0,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {/* List head */}
          <div style={{ padding: '14px 18px 10px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', fontFamily: SORA }}>{folderLabel}</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--txt3)' }}>{folderCountLabel}</span>
            <button
              onClick={() => openCompose()}
              style={{
                marginLeft: 'auto', padding: '5px 11px', borderRadius: 7,
                border: 'none', background: NAVY, color: '#fff',
                fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: SORA,
                display: 'flex', alignItems: 'center', gap: 5,
              }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
              Compose
            </button>
          </div>

          {/* Folder tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--bdr)', padding: '0 18px', flexShrink: 0 }}>
            {(['inbox', 'sent', 'drafts'] as const).map(f => (
              <button
                key={f}
                onClick={() => { setFolder(f); setSelId(null) }}
                style={{
                  border: 'none', background: 'none', padding: '8px 12px 7px',
                  fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: SORA,
                  color: folder === f ? BLUE : 'var(--txt3)',
                  borderBottom: folder === f ? `2px solid ${BLUE}` : '2px solid transparent',
                  textTransform: 'capitalize',
                }}>
                {f}{f === 'inbox' && unreadCount > 0 ? ` (${unreadCount})` : ''}
              </button>
            ))}
          </div>

          {/* Item list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={{ padding: '11px 18px', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ height: 12, background: 'var(--bdr)', borderRadius: 4, marginBottom: 7, width: `${50 + (i % 3) * 15}%` }} />
                  <div style={{ height: 10, background: 'var(--bdr)', borderRadius: 4, width: `${65 + (i % 2) * 20}%` }} />
                </div>
              ))
            ) : items.length === 0 ? (
              <div style={{ padding: '40px 18px', textAlign: 'center', color: 'var(--txt3)', fontSize: 13, fontFamily: SORA }}>
                {folder === 'inbox' ? 'Your inbox is empty' : folder === 'sent' ? 'No sent messages' : 'No drafts'}
              </div>
            ) : items.map(item => {
              const isSel = item.id === selId
              return (
                <div
                  key={item.id}
                  onClick={() => openItem(item)}
                  style={{
                    padding: '11px 18px',
                    borderBottom: '1px solid var(--bdr)',
                    cursor: 'pointer',
                    background: isSel ? 'var(--row-hvr)' : 'transparent',
                    boxShadow: isSel ? `inset 3px 0 0 ${BLUE}` : 'none',
                    transition: 'background .1s',
                  }}
                  onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: item.isUnread ? 7 : 0 }}>
                      {item.isUnread && (
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: BLUE, display: 'inline-block', flexShrink: 0 }} />
                      )}
                      {item.from}
                    </span>
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10.5, color: 'var(--txt3)', flexShrink: 0 }}>{item.time}</span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2, color: 'var(--txt)', fontFamily: SORA, fontWeight: item.isUnread ? 600 : 400 }}>
                    {item.subject}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: SORA }}>
                    {item.preview}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Right pane: reader ── */}
        {selItem ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: 'var(--txt)', fontFamily: SORA }}>
              {selItem.subject}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14,
              borderBottom: '1px solid var(--bdr)', marginBottom: 18,
              fontSize: 12, color: 'var(--txt2)', fontFamily: SORA,
            }}>
              <Avatar name={selItem.from} />
              <strong style={{ fontFamily: SORA }}>{selItem.from}</strong>
              {selItem.toAddr && <span style={{ color: 'var(--txt3)' }}>→ {selItem.toAddr}</span>}
              <span style={{ fontFamily: MONO, color: 'var(--txt3)', marginLeft: 'auto' }}>
                {folder === 'inbox' && selInbound ? fmtDatetime(selInbound.received_at)
                  : folder === 'sent' && selSent ? fmtDatetime(selSent.created_at)
                  : folder === 'drafts' && selDraft ? fmtDatetime(selDraft.updated_at)
                  : selItem.time}
              </span>
            </div>

            {renderReaderBody()}

            {/* Actions */}
            {folder !== 'drafts' && (
              <div style={{ marginTop: 22, display: 'flex', gap: 8 }}>
                <button
                  onClick={() => openCompose(
                    folder === 'inbox' ? (selInbound?.from_email ?? '') : '',
                    `Re: ${selItem.subject}`,
                  )}
                  style={{
                    padding: '7px 14px', borderRadius: 7, border: 'none',
                    background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', fontFamily: SORA,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>reply</span>
                  Reply
                </button>
                <button
                  onClick={() => openCompose('', `Fwd: ${selItem.subject}`)}
                  style={{
                    padding: '7px 14px', borderRadius: 7, border: '1px solid var(--bdr)',
                    background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', fontFamily: SORA,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>forward</span>
                  Forward
                </button>
              </div>
            )}
            {folder === 'drafts' && selDraft && (
              <div style={{ marginTop: 22 }}>
                <button
                  onClick={() => openCompose(
                    (selDraft.to_addrs ?? []).map(a => a.Email).join(', '),
                    selDraft.subject ?? '',
                  )}
                  style={{
                    padding: '7px 14px', borderRadius: 7, border: 'none',
                    background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', fontFamily: SORA,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                  Edit &amp; Send
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--txt3)', fontSize: 12.5, fontFamily: SORA,
          }}>
            Select a message to read
          </div>
        )}
      </div>

      {/* Compose modal */}
      {composeOpen && (
        <ComposeModal
          initialTo={composeTo}
          initialSubj={composeSubj}
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setComposeOpen(false)
            if (folder === 'sent') loadFolder()
          }}
        />
      )}
    </div>
  )
}
