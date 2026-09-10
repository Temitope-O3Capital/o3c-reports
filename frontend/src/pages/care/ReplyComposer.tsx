import { useEffect, useRef, useState } from 'react'
import { Spinner, Modal } from '../../components/UI'
import MailRichEditor from '../../components/MailRichEditor'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, RED, BLUE, FW, RADIUS, TEXT } from '../../lib/design'
import { toast } from 'sonner'
import DOMPurify from 'dompurify'
import { CannedResponse, HOLD_SECONDS, htmlToText, parseAddrs, signatureHtml } from './mailUtils'

// The email reply — a modal composer opened from a Reply / Reply all / Templates
// bar, shared by the Care inbox reading pane and the full-page mail view. Rich
// text, Cc/Bcc, templates, attachments, and a 30s pre-dispatch hold so a just-sent
// reply can still be recalled from the floating bar.
export default function ReplyComposer({ ticketId, customerName, customerEmail, ccRecipients = [], onSent }: {
  ticketId: number
  customerName?: string
  customerEmail?: string
  ccRecipients?: string[]
  onSent: () => void
}) {
  const [open, setOpen] = useState(false)
  const [replyHtml, setReplyHtml] = useState('<p></p>')
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<{ filename: string; content_type: string; content: string; size: number }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [cannedOpen, setCannedOpen] = useState(false)
  const [canned, setCanned] = useState<CannedResponse[]>([])
  const [cannedLoaded, setCannedLoaded] = useState(false)
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showBcc, setShowBcc] = useState(false)
  const [undo, setUndo] = useState<{ msgId: number; secs: number } | null>(null)

  const hasCc = ccRecipients.length > 0

  // Prime the composer with the agent's signature once per ticket.
  useEffect(() => {
    let cancelled = false
    apiFetch<{ signature_text?: string | null; signature_html?: string | null }>('/api/mail/signature')
      .then(s => { if (!cancelled) setReplyHtml('<p></p>' + signatureHtml(s || {})) })
      .catch(() => { /* no signature */ })
    return () => { cancelled = true }
  }, [ticketId])

  useEffect(() => {
    if (!undo) return
    if (undo.secs <= 0) { setUndo(null); return }
    const t = setTimeout(() => setUndo(u => (u ? { ...u, secs: u.secs - 1 } : null)), 1000)
    return () => clearTimeout(t)
  }, [undo])

  function openReply(all: boolean, withTemplates = false) {
    setCc(all ? ccRecipients.join(', ') : '')
    setOpen(true)
    if (withTemplates && !cannedOpen) toggleCanned()
  }

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
    let html = c.body_html && c.body_html.trim()
      ? c.body_html
      : '<p>' + (c.body || c.body_text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>'
    html = html.replace(/\{\{\s*customer_name\s*\}\}/gi, customerName || 'there')
    setReplyHtml(prev => (htmlToText(prev) ? prev + html : html))
    setCannedOpen(false)
    apiPost(`/api/helpdesk/canned-responses/${c.id}/use`, {}).catch(() => {})
  }

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
    const text = htmlToText(replyHtml)
    if (!text) { toast.error('Write a message first'); return }
    setSending(true)
    try {
      const clean = DOMPurify.sanitize(replyHtml)
      const msg: any = await apiPost(`/api/helpdesk/tickets/${ticketId}/messages`, {
        body_text: text, body_html: clean, channel: 'email',
        cc: cc ? parseAddrs(cc) : [], bcc: bcc ? parseAddrs(bcc) : [],
        hold_seconds: HOLD_SECONDS,
        attachments: attachments.map(({ filename, content_type, content }) => ({ filename, content_type, content })),
      })
      setUndo({ msgId: Number(msg?.id) || 0, secs: HOLD_SECONDS })
      setReplyHtml('<p></p>')
      setAttachments([]); setCc(''); setBcc(''); setShowBcc(false); setOpen(false); setCannedOpen(false)
      onSent()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to send reply')
    } finally {
      setSending(false)
    }
  }

  async function recall() {
    if (!undo || !undo.msgId) return
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/messages/${undo.msgId}/recall`, {})
      toast.success('Reply recalled')
      setUndo(null); onSent()
    } catch (e: any) { toast.error(e.message ?? 'Too late to recall'); setUndo(null) }
  }

  const ghostBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold,
    color: 'var(--txt2)', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '7px 12px', cursor: 'pointer',
  }
  const addrInput: React.CSSProperties = {
    flex: 1, height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.sm, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)',
  }

  return (
    <>
      {/* Reply action bar */}
      <div style={{ borderTop: '1px solid var(--bdr)', padding: '12px 22px', background: 'var(--card)', flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => openReply(false)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.bold, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>reply</span>Reply
        </button>
        {hasCc && (
          <button onClick={() => openReply(true)} title={`Also copies ${ccRecipients.join(', ')}`} style={{ ...ghostBtn, padding: '9px 14px' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>reply_all</span>Reply all
            <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>· {ccRecipients.length}</span>
          </button>
        )}
        <button onClick={() => openReply(false, true)} style={{ ...ghostBtn, padding: '9px 14px' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>bolt</span>Use a template
        </button>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>Replies hold {HOLD_SECONDS}s so you can undo</span>
      </div>

      {/* Floating undo/recall bar (modal has closed by now) */}
      {undo && (
        <div style={{ position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 60, padding: '10px 14px', background: 'var(--card)', border: `1px solid ${NAVY}40`, borderRadius: RADIUS.lg, boxShadow: '0 12px 34px rgba(0,0,0,0.22)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY }}>schedule_send</span>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>Reply sends in <strong>{undo.secs}s</strong></span>
          <button onClick={recall}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: RED, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.bold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>undo</span>Recall
          </button>
        </div>
      )}

      {/* Composer modal */}
      <Modal open={open} onClose={() => setOpen(false)} title="Reply by email" width={640} maxHeight="86vh"
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 8 }}>
            <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={toggleCanned} type="button" style={{ ...ghostBtn, ...(cannedOpen ? { color: NAVY, borderColor: `${NAVY}30`, background: `${NAVY}0c` } : {}) }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>bolt</span>Templates
              </button>
              <button onClick={() => fileRef.current?.click()} type="button" style={ghostBtn}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>attach_file</span>Attach
              </button>
              {!showBcc && <button onClick={() => setShowBcc(true)} type="button" style={ghostBtn}>Bcc</button>}
            </div>
            <button onClick={send} disabled={sending}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 20px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.bold, cursor: sending ? 'not-allowed' : 'pointer', opacity: sending ? 0.6 : 1 }}>
              {sending ? <Spinner size={13} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>}
              Send Reply
            </button>
          </div>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Recipients */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', width: 32, fontWeight: FW.semibold }}>To</span>
              <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', padding: '6px 10px', background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.sm, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {customerName ? `${customerName} · ` : ''}{customerEmail || 'the customer'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', width: 32, fontWeight: FW.semibold }}>Cc</span>
              <input value={cc} onChange={e => setCc(e.target.value)} placeholder="cc@example.com, another@example.com" style={addrInput} />
            </div>
            {showBcc && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', width: 32, fontWeight: FW.semibold }}>Bcc</span>
                <input value={bcc} onChange={e => setBcc(e.target.value)} placeholder="bcc@example.com" style={addrInput} />
              </div>
            )}
          </div>

          {/* Template picker (inline) */}
          {cannedOpen && (
            <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, maxHeight: 210, overflowY: 'auto' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--bdr)', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Email Templates</div>
              {!cannedLoaded ? (
                <div style={{ padding: 16, textAlign: 'center' }}><Spinner size={14} /></div>
              ) : canned.length === 0 ? (
                <div style={{ padding: '12px', fontSize: TEXT.sm, color: 'var(--txt3)' }}>No templates yet. Add them in Care → Email Templates.</div>
              ) : canned.map(c => (
                <button key={c.id} type="button" onClick={() => insertCanned(c)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{c.title || c.name}</span>
                    {c.category && <span style={{ fontSize: TEXT['2xs'], color: BLUE, background: `${BLUE}14`, padding: '1px 6px', borderRadius: RADIUS.xl }}>{c.category}</span>}
                  </div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{c.subject || htmlToText(c.body_html || '') || c.body || c.body_text}</div>
                </button>
              ))}
            </div>
          )}

          <MailRichEditor value={replyHtml} onChange={setReplyHtml} minHeight={200}
            placeholder={`Reply to ${customerName || 'the customer'} by email…`} />

          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
        </div>
      </Modal>
    </>
  )
}
