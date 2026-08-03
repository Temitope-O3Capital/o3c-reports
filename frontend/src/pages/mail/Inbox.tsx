import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { ErrBanner } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, NUM, SORA, MONO, TEXT, FW, SP } from '../../lib/design'

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

function parseToAddrs(raw: any): { Email: string; Name: string }[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(String(raw)) } catch { return [] }
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

// Plain-text body inside the white reading card (dark text on white).
const preBody: React.CSSProperties = {
  fontSize: TEXT.base, lineHeight: 1.7, color: '#1a1a1a',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: SORA,
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ name }: { name: string }) {
  return (
    <div style={{
      width: 26, height: 26, minWidth: 26, borderRadius: '50%',
      background: BLUE, color: '#fff', fontFamily: SORA,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: TEXT['2xs'], fontWeight: FW.semibold,
    }}>
      {initials(name)}
    </div>
  )
}

// ── Quote / forward builders (produce HTML for the rich composer) ──────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The body of the original message as HTML (prefer html, fall back to text).
function originalBodyHtml(html: string | null | undefined, text: string | null | undefined): string {
  if (html && html.trim()) return DOMPurify.sanitize(html)
  if (text && text.trim()) return `<p>${escHtml(text).replace(/\n/g, '<br>')}</p>`
  return ''
}

// Gmail-style "On <date>, <sender> wrote:" quoted block.
function buildReplyQuote(sender: string, date: string, bodyHtml: string): string {
  return `<br><div class="o3c-quote">${escHtml(`On ${date}, ${sender} wrote:`)}` +
    `<blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #d0d7de;color:#57606a;">${bodyHtml}</blockquote></div>`
}

// Forwarded-message header block.
function buildForward(sender: string, date: string, subject: string, to: string, bodyHtml: string): string {
  const hdr = [
    'From: ' + sender,
    'Date: ' + date,
    'Subject: ' + subject,
    to ? 'To: ' + to : '',
  ].filter(Boolean).map(escHtml).join('<br>')
  return `<br><div class="o3c-fwd">---------- Forwarded message ----------<br>${hdr}</div><br>${bodyHtml}`
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
      const toNames = parseToAddrs(m.to_addrs).map(a => a.Name || a.Email).join('; ')
      return {
        id:          m.id,
        displayFrom: 'Draft',
        avatarName:  'Draft',
        time:        fmtShort(m.updated_at),
        subject:     m.subject ?? '(no subject)',
        preview:     m.text_body?.slice(0, 100) ?? '',
        isUnread:    false,
        replyTo:     parseToAddrs(m.to_addrs).map(a => a.Email).join(', '),
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

  function reStr(s: string | null | undefined, prefix: 're' | 'fwd'): string {
    const subj = s ?? '(no subject)'
    const re = /^(re|fwd?):/i.test(subj)
    if (prefix === 're') return re ? subj : `Re: ${subj}`
    return /^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`
  }

  // Reply / Reply-all to the selected inbound message.
  function doReply(all: boolean) {
    if (!selInbound) return
    const sender = selInbound.from_name ? `${selInbound.from_name} <${selInbound.from_email}>` : selInbound.from_email
    const quote = buildReplyQuote(sender, fmtDatetime(selInbound.received_at), originalBodyHtml(selInbound.body_html, selInbound.body_text))
    navigate('/mail/compose', { state: {
      mode: all ? 'replyall' : 'reply',
      to: selInbound.from_email,
      subject: reStr(selInbound.subject, 're'),
      quotedHtml: quote,
    } })
  }

  // Forward the selected message (inbound or sent).
  function doForward() {
    if (!selItem) return
    let sender = '', date = selItem.time, subject = selItem.subject, toLine = '', bodyHtml = ''
    if (folder === 'inbox' && selInbound) {
      sender = selInbound.from_name ? `${selInbound.from_name} <${selInbound.from_email}>` : selInbound.from_email
      date = fmtDatetime(selInbound.received_at)
      toLine = selInbound.to_email ?? ''
      bodyHtml = originalBodyHtml(selInbound.body_html, selInbound.body_text)
    } else if (folder === 'sent' && selSent) {
      sender = selSent.from_name ?? selSent.from_email ?? ''
      date = fmtDatetime(selSent.created_at)
      toLine = recipientDisplay(selSent.recipients)
      bodyHtml = originalBodyHtml(sentDetail?.html_body, sentDetail?.text_body)
    }
    const fwd = buildForward(sender, date, subject, toLine, bodyHtml)
    navigate('/mail/compose', { state: { mode: 'forward', subject: reStr(subject, 'fwd'), quotedHtml: fwd } })
  }

  function editDraft() {
    if (selDraft) navigate(`/mail/compose?draft=${selDraft.id}`)
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

  // Inner body content (HTML rendered sanitised; plain text kept as <pre>).
  function bodyInner() {
    if (folder === 'inbox' && selInbound) {
      if (selInbound.body_html) return <div className="mail-body-html" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selInbound.body_html) }} />
      return <pre style={preBody}>{selInbound.body_text ?? '(no content)'}</pre>
    }
    if (folder === 'sent') {
      if (bodyLoading) return <div style={{ fontSize: TEXT.base, color: 'var(--txt3)' }}>Loading…</div>
      if (sentDetail?.html_body) return <div className="mail-body-html" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(sentDetail.html_body) }} />
      if (sentDetail?.text_body) return <pre style={preBody}>{sentDetail.text_body}</pre>
      return <div style={{ fontSize: TEXT.base, color: 'var(--txt3)' }}>(no content)</div>
    }
    if (folder === 'drafts' && selDraft) {
      // Drafts now render HTML (rich composer stores html_body); text is a fallback.
      if (selDraft.html_body && selDraft.html_body.trim()) return <div className="mail-body-html" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selDraft.html_body) }} />
      if (selDraft.text_body) return <pre style={preBody}>{selDraft.text_body}</pre>
      return <div style={{ fontSize: TEXT.base, color: 'var(--txt3)' }}>(empty draft)</div>
    }
    return null
  }

  // Reader body wrapped in a white card (Gmail-style reading surface).
  function renderBody() {
    return (
      <div style={{
        background: '#fff', color: '#1a1a1a', border: '1px solid var(--bdr)',
        borderRadius: 12, padding: '22px 26px', maxWidth: 760,
        fontSize: TEXT.base, lineHeight: 1.7,
        boxShadow: 'var(--card-shadow)', overflowWrap: 'anywhere',
      }}>
        {bodyInner()}
      </div>
    )
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
          <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA, lineHeight: 1.2 }}>Mail</div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2, fontFamily: SORA }}>Inbox, sent messages and drafts</div>
        </div>
      </div>

      {err && <div style={{ padding: '0 24px' }}><ErrBanner error={err} onRetry={loadFolder} /></div>}

      {/* Split pane */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', marginTop: 16 }}>

        {/* ── Left: list pane ── */}
        <div style={{ width: 390, minWidth: 300, flexShrink: 0, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* List head */}
          <div style={{ padding: '14px 18px 10px', display: 'flex', alignItems: 'center', gap: SP[2], flexShrink: 0 }}>
            <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{folderLabel}</span>
            <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{folderCount}</span>
            <button
              onClick={() => navigate('/mail/compose')}
              style={{
                marginLeft: 'auto', padding: '5px 11px', borderRadius: 7,
                border: 'none', background: NAVY, color: '#fff',
                fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>edit</span>
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
              <div style={{ padding: '40px 18px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base, fontFamily: SORA }}>
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
                    <span style={{ fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: item.isUnread ? 7 : 0 }}>
                      {item.isUnread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: BLUE, display: 'inline-block', flexShrink: 0 }} />}
                      {item.displayFrom}
                    </span>
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10.5, color: 'var(--txt3)', flexShrink: 0, paddingLeft: SP[2] }}>
                      {item.time}
                    </span>
                  </div>
                  <div style={{ fontSize: TEXT.sm, marginTop: 2, color: 'var(--txt)', fontFamily: SORA, fontWeight: item.isUnread ? FW.semibold : FW.normal }}>
                    {item.subject}
                  </div>
                  {item.preview && (
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: SORA }}>
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
              style={{ width: '100%', padding: '10px', background: 'none', border: 'none', borderTop: '1px solid var(--bdr)', color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer', fontFamily: SORA }}>
              Load more
            </button>
          )}
        </div>

        {/* ── Right: reader pane ── */}
        {selItem ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: `${SP[6]} ${SP[8]}`, minWidth: 0 }}>
            {/* Subject */}
            <div style={{ fontSize: TEXT.lg, fontWeight: FW.semibold, marginBottom: SP[3], color: 'var(--txt)', fontFamily: SORA }}>
              {selItem.subject}
            </div>
            {/* Meta row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14, borderBottom: '1px solid var(--bdr)', marginBottom: 18, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: SORA }}>
              <Avatar name={selItem.avatarName} />
              <strong style={{ fontFamily: SORA, color: 'var(--txt)' }}>{meta.name}</strong>
              <span style={{ fontFamily: MONO, color: 'var(--txt3)', marginLeft: 'auto' }}>·&nbsp;{meta.time}</span>
            </div>
            {/* Body */}
            {renderBody()}
            {/* Actions */}
            <div style={{ marginTop: 22, display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
              {folder === 'inbox' && (
                <>
                  <button onClick={() => doReply(false)} style={btnSolid}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>reply</span>
                    Reply
                  </button>
                  <button onClick={() => doReply(true)} style={btnGhost}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>reply_all</span>
                    Reply all
                  </button>
                  <button onClick={doForward} style={btnGhost}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>forward</span>
                    Forward
                  </button>
                  <button onClick={() => navigate(`/mail/${selId}`)} style={btnGhost}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>open_in_new</span>
                    Open thread
                  </button>
                </>
              )}
              {folder === 'sent' && (
                <>
                  <button onClick={doForward} style={btnSolid}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>forward</span>
                    Forward
                  </button>
                  {selId !== null && (
                    <button onClick={() => navigate(`/mail/${selId}`)} style={btnGhost}>
                      <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>open_in_new</span>
                      Full thread
                    </button>
                  )}
                </>
              )}
              {folder === 'drafts' && (
                <button onClick={editDraft} style={btnSolid}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>edit</span>
                  Edit draft
                </button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.sm, fontFamily: SORA }}>
            Select a message to read
          </div>
        )}
      </div>

      {/* Sanitised HTML email body styling (scoped to the white reading card). */}
      <style>{`
        .mail-body-html { color: #1a1a1a; }
        .mail-body-html img { max-width: 100%; height: auto; }
        .mail-body-html a { color: #2563EB; }
        .mail-body-html table { max-width: 100%; }
        .mail-body-html blockquote { border-left: 2px solid #d0d7de; margin: 0 0 0 8px; padding-left: 12px; color: #57606a; }
        .mail-body-html .o3c-quote, .mail-body-html .o3c-fwd { color: #57606a; }
      `}</style>
    </div>
  )
}

// Reader action buttons.
const btnSolid: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff',
  fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA,
  display: 'flex', alignItems: 'center', gap: 5,
}
const btnGhost: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
  fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA,
  display: 'flex', alignItems: 'center', gap: 5,
}
