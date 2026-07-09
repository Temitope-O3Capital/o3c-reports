import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { ErrBanner } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, RED, NUM, SORA, MONO } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InboundMessage {
  id:          number
  from_email:  string
  from_name:   string | null
  to_email:    string | null
  subject:     string | null
  body_text:   string | null
  body_html:   string | null
  is_read:     boolean
  received_at: string
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
  return name.split(/[\s;,]+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?'
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
    if (p?.to && Array.isArray(p.to)) {
      return p.to.map((r: any) => r.name ?? r.email).filter(Boolean).join('; ')
    }
  } catch {}
  if (Array.isArray(recipients)) return recipients.map((r: any) => r.Name || r.Email || r).join('; ')
  return ''
}

function folderFromPath(pathname: string): Folder {
  if (pathname.startsWith('/mail/sent'))   return 'sent'
  if (pathname.startsWith('/mail/drafts')) return 'drafts'
  return 'inbox'
}

// ── Avatar ────────────────────────────────────────────────────────────────────

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

// ── Compose modal ─────────────────────────────────────────────────────────────

interface ComposeProps {
  initialTo:   string
  initialSubj: string
  initialBody?: string
  onClose:     () => void
  onSent:      () => void
}

function ComposeModal({ initialTo, initialSubj, initialBody = '', onClose, onSent }: ComposeProps) {
  const [to,      setTo]      = useState(initialTo)
  const [subj,    setSubj]    = useState(initialSubj)
  const [body,    setBody]    = useState(initialBody)
  const [sending, setSending] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [activeDraftId, setActiveDraftId] = useState<number | null>(null)

  async function send() {
    if (!to.trim() || !subj.trim() || !body.trim()) return
    setSending(true); setErr(null)
    try {
      await apiPost('/api/mail/send', {
        to: parseAddresses(to), cc: [], bcc: [],
        subject: subj, text_body: body,
        html_body: `<html><body><p>${body.replace(/\n/g, '</p><p>')}</p></body></html>`,
        send_copy_to_sender: true,
      })
      if (activeDraftId) {
        await apiDelete(`/api/mail/drafts/${activeDraftId}`).catch(() => {})
      }
      onSent()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSending(false) }
  }

  async function saveDraft() {
    setSaving(true); setErr(null); setSaved(false)
    try {
      const payload: Record<string, any> = {
        subject: subj,
        to_addrs: to ? parseAddresses(to) : [],
        text_body: body,
      }
      if (activeDraftId) payload.id = activeDraftId
      const saved_draft = await apiPost<{ id: number }>('/api/mail/drafts', payload)
      if (saved_draft?.id && !activeDraftId) setActiveDraftId(saved_draft.id)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  function handleClose() {
    setActiveDraftId(null)
    onClose()
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%', border: 'none', outline: 'none', background: 'none',
    color: 'var(--txt)', fontFamily: SORA, fontSize: 13,
    padding: '11px 16px', borderBottom: '1px solid var(--bdr)',
    boxSizing: 'border-box',
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) handleClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
    >
      <div style={{ width: 560, maxWidth: '94vw', background: 'var(--card)', borderRadius: 6, overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', background: NAVY, color: '#fff', padding: '11px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: SORA }}>
          New message
          <button onClick={handleClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <input placeholder="To" value={to} onChange={e => setTo(e.target.value)} style={fieldStyle} />
        <input placeholder="Subject" value={subj} onChange={e => setSubj(e.target.value)} style={fieldStyle} />
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
          placeholder="Write your message…"
          value={body}
          onChange={e => setBody(e.target.value)}
          style={{ ...fieldStyle, height: 200, resize: 'vertical', borderBottom: 'none', lineHeight: 1.6 }}
        />
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--bdr)', alignItems: 'center' }}>
          <button
            onClick={send}
            disabled={sending || !to.trim() || !subj.trim() || !body.trim()}
            style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, opacity: sending ? 0.6 : 1 }}>
            {sending ? 'Sending…' : 'Send'}
          </button>
          <button
            onClick={saveDraft}
            disabled={saving}
            style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save draft'}
          </button>
          {err && <span style={{ fontSize: 12, color: RED }}>{err}</span>}
        </div>
      </div>
    </div>
  )
}


// ── Normalised item for display ───────────────────────────────────────────────

interface MailItemData {
  id:          number
  displayFrom: string   // name shown in list (sender, or "To: X" for sent)
  avatarName:  string   // name used for avatar initials
  time:        string
  subject:     string
  preview:     string
  isUnread:    boolean
  replyTo:     string   // pre-fill To when replying
  rawInbound?: InboundMessage
  rawDraft?:   Draft
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MailInbox() {
  const location = useLocation()
  const navigate = useNavigate()
  const folder: Folder = folderFromPath(location.pathname)

  const [inbox,  setInbox]   = useState<InboundMessage[]>([])
  const [sent,   setSent]    = useState<SentMessage[]>([])
  const [drafts, setDrafts]  = useState<Draft[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const [selId, setSelId]           = useState<number | null>(null)
  const [sentDetail, setSentDetail] = useState<SentDetail | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)

  const [composeOpen, setComposeOpen] = useState(false)
  const [composeTo,   setComposeTo]   = useState('')
  const [composeSubj, setComposeSubj] = useState('')
  const [composeBody, setComposeBody] = useState('')

  const [page,    setPage]    = useState(1)
  const [hasMore, setHasMore] = useState(false)

  const loadFolder = useCallback(async () => {
    setLoading(true); setErr(null); setSelId(null); setSentDetail(null); setPage(1)
    try {
      if (folder === 'inbox') {
        const res = await apiFetch<InboundMessage[]>('/api/mail/inbox?limit=50&offset=0')
        const arr = Array.isArray(res) ? res : []
        setInbox(arr)
        setHasMore(arr.length === 50)
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

  // Normalise items for the current folder
  const items: MailItemData[] = (() => {
    if (folder === 'inbox') {
      return inbox.map(m => {
        const sender = m.from_name ?? m.from_email
        return {
          id:          m.id,
          displayFrom: sender,
          avatarName:  sender,
          time:        fmtShort(m.received_at),
          subject:     m.subject ?? '(no subject)',
          preview:     m.body_text?.slice(0, 100) ?? '',
          isUnread:    !m.is_read,
          replyTo:     m.from_email,
          rawInbound:  m,
        }
      })
    }
    if (folder === 'sent') {
      return sent.map(m => {
        const recipient = recipientDisplay(m.recipients) || (m.from_email ?? '')
        return {
          id:          m.id,
          displayFrom: `To: ${recipient}`,
          avatarName:  recipient,
          time:        fmtShort(m.created_at),
          subject:     m.subject ?? '(no subject)',
          preview:     '',
          isUnread:    false,
          replyTo:     '',
        }
      })
    }
    // drafts
    return drafts.map(m => {
      const toNames = (m.to_addrs ?? []).map(a => a.Name || a.Email).join('; ')
      return {
        id:          m.id,
        displayFrom: 'Draft',
        avatarName:  'Draft',
        time:        fmtShort(m.updated_at),
        subject:     m.subject ?? '(no subject)',
        preview:     m.text_body?.slice(0, 100) ?? '',
        isUnread:    false,
        replyTo:     (m.to_addrs ?? []).map(a => a.Email).join(', '),
        rawDraft:    m,
      }
    })
  })()

  const selItem    = selId !== null ? (items.find(it => it.id === selId) ?? null) : null
  const selInbound = selItem?.rawInbound ?? null
  const selDraft   = selItem?.rawDraft ?? null
  const selSent    = folder === 'sent' ? (sent.find(s => s.id === selId) ?? null) : null
  const unreadCount = inbox.filter(m => !m.is_read).length

  function openItem(item: MailItemData) {
    setSelId(item.id)
    setSentDetail(null)

    if (folder === 'inbox' && item.rawInbound && !item.rawInbound.is_read) {
      setInbox(prev => prev.map(m => m.id === item.id ? { ...m, is_read: true } : m))
      apiPut(`/api/mail/inbox/${item.id}/read`, {}).catch(() => {})
    }

    if (folder === 'sent') {
      setBodyLoading(true)
      apiFetch<SentDetail>(`/api/mail/messages/${item.id}`)
        .then(d => setSentDetail(d))
        .catch(() => setSentDetail(null))
        .finally(() => setBodyLoading(false))
    }
  }

  function openCompose(to = '', subj = '', body = '') {
    setComposeTo(to); setComposeSubj(subj); setComposeBody(body); setComposeOpen(true)
  }

  async function loadMoreInbox() {
    const nextPage = page + 1
    const offset = (nextPage - 1) * 50
    try {
      const res = await apiFetch<InboundMessage[]>(`/api/mail/inbox?limit=50&offset=${offset}`)
      const arr = Array.isArray(res) ? res : []
      setInbox(prev => [...prev, ...arr])
      setPage(nextPage)
      setHasMore(arr.length === 50)
    } catch { /* ignore */ }
  }

  // Reader body
  function renderBody() {
    if (folder === 'inbox' && selInbound) {
      if (selInbound.body_html) return <div style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', fontFamily: SORA }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selInbound.body_html) }} />
      return <pre style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', whiteSpace: 'pre-line', margin: 0, fontFamily: SORA }}>{selInbound.body_text ?? '(no content)'}</pre>
    }
    if (folder === 'sent') {
      if (bodyLoading) return <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: SORA }}>Loading…</div>
      if (sentDetail?.html_body) return <div style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', fontFamily: SORA }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(sentDetail.html_body) }} />
      if (sentDetail?.text_body) return <pre style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', whiteSpace: 'pre-line', margin: 0, fontFamily: SORA }}>{sentDetail.text_body}</pre>
      return null
    }
    if (folder === 'drafts' && selDraft) {
      const body = selDraft.text_body ?? selDraft.html_body
      if (!body) return null
      return <pre style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 640, color: 'var(--txt)', whiteSpace: 'pre-line', margin: 0, fontFamily: SORA }}>{body}</pre>
    }
    return null
  }

  // Reader meta (from/to and timestamp)
  function readerMetaLabel(): { name: string; time: string } {
    if (folder === 'inbox' && selInbound) {
      return { name: selInbound.from_name ?? selInbound.from_email, time: fmtDatetime(selInbound.received_at) }
    }
    if (folder === 'sent' && selSent) {
      const recipient = recipientDisplay(selSent.recipients)
      return { name: `To: ${recipient}`, time: fmtDatetime(selSent.created_at) }
    }
    if (folder === 'drafts' && selDraft) {
      return { name: 'Draft', time: fmtDatetime(selDraft.updated_at) }
    }
    return { name: selItem?.avatarName ?? '', time: selItem?.time ?? '' }
  }

  const folderLabel = folder === 'sent' ? 'Sent' : folder.charAt(0).toUpperCase() + folder.slice(1)
  const folderCount = folder === 'inbox'
    ? `${items.length} · ${unreadCount} unread`
    : String(items.length)

  const meta = readerMetaLabel()

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)', fontFamily: SORA }}>

      {/* Page title */}
      <div style={{ padding: '20px 24px 0', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)', fontFamily: SORA, lineHeight: 1.2 }}>Mail</div>
          <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 2, fontFamily: SORA }}>Inbox, sent messages and drafts</div>
        </div>
      </div>

      {err && <div style={{ padding: '0 24px' }}><ErrBanner error={err} onRetry={loadFolder} /></div>}

      {/* Split pane */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', marginTop: 16 }}>

        {/* ── Left: list pane ── */}
        <div style={{ width: 390, minWidth: 300, flexShrink: 0, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* List head */}
          <div style={{ padding: '14px 18px 10px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', fontFamily: SORA }}>{folderLabel}</span>
            <span style={{ ...NUM, fontSize: 11, color: 'var(--txt3)' }}>{folderCount}</span>
            <button
              onClick={() => openCompose()}
              style={{
                marginLeft: 'auto', padding: '5px 11px', borderRadius: 7,
                border: 'none', background: NAVY, color: '#fff',
                fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: SORA,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
              Compose
            </button>
          </div>

          {/* Item list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={{ padding: '11px 18px', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ height: 12, background: 'var(--bdr)', borderRadius: 4, marginBottom: 7, width: `${50 + (i % 3) * 15}%`, opacity: 0.5 }} />
                  <div style={{ height: 10, background: 'var(--bdr)', borderRadius: 4, width: `${65 + (i % 2) * 20}%`, opacity: 0.4 }} />
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
                    padding: '11px 18px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer',
                    background: isSel ? 'var(--row-hvr)' : 'transparent',
                    boxShadow: isSel ? `inset 3px 0 0 ${BLUE}` : 'none',
                    transition: 'background .1s',
                  }}
                  onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: item.isUnread ? 7 : 0 }}>
                      {item.isUnread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: BLUE, display: 'inline-block', flexShrink: 0 }} />}
                      {item.displayFrom}
                    </span>
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10.5, color: 'var(--txt3)', flexShrink: 0, paddingLeft: 8 }}>
                      {item.time}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2, color: 'var(--txt)', fontFamily: SORA, fontWeight: item.isUnread ? 600 : 400 }}>
                    {item.subject}
                  </div>
                  {item.preview && (
                    <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: SORA }}>
                      {item.preview}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Load more — inbox only */}
          {folder === 'inbox' && hasMore && !loading && (
            <button
              onClick={loadMoreInbox}
              style={{ width: '100%', padding: '10px', background: 'none', border: 'none', borderTop: '1px solid var(--bdr)', color: 'var(--txt2)', fontSize: 12.5, cursor: 'pointer', fontFamily: SORA }}>
              Load more
            </button>
          )}
        </div>

        {/* ── Right: reader pane ── */}
        {selItem ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', minWidth: 0 }}>
            {/* Subject */}
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: 'var(--txt)', fontFamily: SORA }}>
              {selItem.subject}
            </div>
            {/* Meta row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14, borderBottom: '1px solid var(--bdr)', marginBottom: 18, fontSize: 12, color: 'var(--txt2)', fontFamily: SORA }}>
              <Avatar name={selItem.avatarName} />
              <strong style={{ fontFamily: SORA, color: 'var(--txt)' }}>{meta.name}</strong>
              <span style={{ fontFamily: MONO, color: 'var(--txt3)', marginLeft: 'auto' }}>·&nbsp;{meta.time}</span>
            </div>
            {/* Body */}
            {renderBody()}
            {/* Actions */}
            <div style={{ marginTop: 22, display: 'flex', gap: 8 }}>
              <button
                onClick={() => navigate(`/mail/${selId}?reply=1`)}
                style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>reply</span>
                Reply
              </button>
              <button
                onClick={() => {
                  const sender = selItem.rawInbound?.from_name ?? selItem.rawInbound?.from_email ?? selItem.displayFrom
                  const date   = selItem.time
                  const origBody = selItem.rawInbound?.body_text ?? ''
                  const fwdBody = `\n\n---------- Forwarded message ----------\nFrom: ${sender}\nDate: ${date}\n\n${origBody}`
                  openCompose('', `Fwd: ${selItem.subject}`, fwdBody)
                }}
                style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>forward</span>
                Forward
              </button>
              {folder === 'sent' && selId !== null && (
                <button
                  onClick={() => navigate(`/mail/${selId}`)}
                  style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>
                  Full thread
                </button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 12.5, fontFamily: SORA }}>
            Select a message to read
          </div>
        )}
      </div>

      {/* Compose modal */}
      {composeOpen && (
        <ComposeModal
          initialTo={composeTo}
          initialSubj={composeSubj}
          initialBody={composeBody}
          onClose={() => { setComposeOpen(false); setComposeBody('') }}
          onSent={() => { setComposeOpen(false); setComposeBody(''); if (folder === 'sent') loadFolder() }}
        />
      )}
    </div>
  )
}
