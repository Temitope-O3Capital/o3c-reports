import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { Page, ErrBanner, btnPrimary, btnSecondary } from '../../components/UI'
import MailRichEditor from '../../components/MailRichEditor'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'
import { NAVY, RED, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MailAddress { Email: string; Name: string }

interface Draft {
  id:         number
  subject:    string | null
  to_addrs:   MailAddress[] | null
  cc_addrs:   MailAddress[] | null
  bcc_addrs:  MailAddress[] | null
  from_email: string | null
  from_name:  string | null
  html_body:  string | null
  text_body:  string | null
}

interface Signature { signature_text: string | null; signature_html: string | null }

// Prefill passed via router state from the Inbox reader (reply / reply-all / forward).
interface Prefill {
  mode?:    'reply' | 'replyall' | 'forward'
  to?:      string
  cc?:      string
  subject?: string
  quotedHtml?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseAddresses(raw: string): MailAddress[] {
  return splitAddresses(raw).map(s => ({ Email: s, Name: '' }))
}

// Semicolons as well as commas — Outlook separates with semicolons, and pasting a
// list from there produced one "address" containing everybody, which the API then
// rejected with an unhelpful error.
function splitAddresses(raw: string): string[] {
  return raw.split(/[,;]/).map(s => s.trim()).filter(Boolean)
}

// Deliberately permissive. The purpose is to catch a typo or a stray paste before the
// send round-trips and fails, not to adjudicate RFC 5322 — over-strict client-side
// validation rejects addresses that are actually deliverable.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function invalidAddresses(raw: string): string[] {
  return splitAddresses(raw).filter(a => !EMAIL_RE.test(a))
}

function htmlToText(html: string): string {
  const d = document.createElement('div')
  d.innerHTML = DOMPurify.sanitize(html)
  return (d.textContent ?? '').trim()
}

// Build the signature block as HTML, preferring a stored HTML signature and
// falling back to plain text (line breaks preserved).
function signatureHtml(s: Signature): string {
  if (s.signature_html && s.signature_html.trim()) {
    return `<br><br><div class="o3c-sig">${s.signature_html}</div>`
  }
  if (s.signature_text && s.signature_text.trim()) {
    const safe = s.signature_text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
    return `<br><br><div class="o3c-sig">-- <br>${safe}</div>`
  }
  return ''
}

function labelStyle(): React.CSSProperties {
  return { fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1], fontFamily: INTER }
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MailCompose() {
  const navigate       = useNavigate()
  const location       = useLocation()
  const [params]       = useSearchParams()
  const draftId        = params.get('draft')
  const prefill        = (location.state ?? null) as Prefill | null

  const [to, setTo]           = useState(prefill?.to ?? params.get('to') ?? '')
  const [cc, setCc]           = useState(prefill?.cc ?? '')
  const [bcc, setBcc]         = useState('')
  const [subject, setSubject] = useState(prefill?.subject ?? params.get('subject') ?? '')
  const [body, setBody]       = useState('')
  const [showCc, setShowCc]   = useState(!!prefill?.cc)
  const [showBcc, setShowBcc] = useState(false)

  const [activeDraftId, setActiveDraftId] = useState<number | null>(draftId ? Number(draftId) : null)
  const [sending, setSending]   = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [err, setErr]           = useState<string | null>(null)
  const [sent, setSent]         = useState(false)

  const modeLabel = prefill?.mode === 'forward' ? 'Forward'
    : prefill?.mode === 'replyall' ? 'Reply all'
    : prefill?.mode === 'reply' ? 'Reply' : 'New message'

  // Assemble the initial body once: draft > (reply/forward quote + signature) > signature.
  useEffect(() => {
    let cancelled = false
    async function init() {
      if (draftId) {
        try {
          const d = await apiFetch<Draft>(`/api/mail/drafts/${draftId}`)
          if (cancelled) return
          setSubject(d.subject ?? '')
          setTo((d.to_addrs ?? []).map(a => a.Email).join(', '))
          if (d.cc_addrs?.length) { setCc(d.cc_addrs.map(a => a.Email).join(', ')); setShowCc(true) }
          if (d.bcc_addrs?.length) { setBcc(d.bcc_addrs.map(a => a.Email).join(', ')); setShowBcc(true) }
          setBody(d.html_body ?? (d.text_body ? `<p>${d.text_body.replace(/\n/g, '<br>')}</p>` : '<p></p>'))
        } catch { /* ignore */ }
        return
      }
      let sig = ''
      try {
        const s = await apiFetch<Signature>('/api/mail/signature')
        sig = signatureHtml(s)
      } catch { /* no signature */ }
      if (cancelled) return
      const quote = prefill?.quotedHtml ?? ''
      setBody('<p></p>' + sig + quote)
    }
    init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId])

  async function send() {
    if (!to.trim() || !subject.trim() || htmlToText(body) === '') return
    setSending(true); setErr(null)
    try {
      await apiPost('/api/mail/send', {
        to:        parseAddresses(to),
        cc:        cc  ? parseAddresses(cc)  : [],
        bcc:       bcc ? parseAddresses(bcc) : [],
        subject,
        html_body: DOMPurify.sanitize(body),
        send_copy_to_sender: true,
      })
      if (activeDraftId) await apiDelete(`/api/mail/drafts/${activeDraftId}`).catch(() => {})
      setSent(true)
    } catch (ex: any) { setErr(ex.message) }
    finally { setSending(false) }
  }

  // Discard is destructive and sits next to Save Draft, so it confirms whenever there
  // is anything to lose. It stays silent on an untouched composer — a confirm dialog
  // for discarding nothing is the kind of prompt people learn to click through.
  function discard() {
    const hasContent = to.trim() || cc.trim() || bcc.trim() || subject.trim() || htmlToText(body) !== ''
    if (hasContent && !window.confirm('Discard this message? Anything not saved as a draft will be lost.')) return
    navigate(-1)
  }

  async function saveDraft() {
    setSavingDraft(true); setErr(null)
    try {
      const payload: Record<string, any> = {
        subject,
        to_addrs:  to  ? parseAddresses(to)  : [],
        cc_addrs:  cc  ? parseAddresses(cc)  : [],
        bcc_addrs: bcc ? parseAddresses(bcc) : [],
        html_body: DOMPurify.sanitize(body),
        text_body: htmlToText(body),
      }
      if (activeDraftId) payload.id = activeDraftId
      const saved = await apiPost<{ id: number }>('/api/mail/drafts', payload)
      if (saved?.id && !activeDraftId) setActiveDraftId(saved.id)
    } catch (ex: any) { setErr(ex.message) }
    finally { setSavingDraft(false) }
  }

  if (sent) {
    return (
      <Page title="Compose" subtitle="Message sent">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP[4], marginTop: 60 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 52, color: '#10B981' }}>check_circle</span>
          <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)' }}>Message sent</div>
          <div style={{ fontSize: TEXT.md, color: 'var(--txt3)' }}>Your email has been delivered successfully.</div>
          <div style={{ display: 'flex', gap: 10, marginTop: SP[2] }}>
            <button onClick={() => { setSent(false); setTo(''); setCc(''); setBcc(''); setSubject(''); setBody('<p></p>'); setActiveDraftId(null) }} style={btnSecondary}>
              Compose Another
            </button>
            <button onClick={() => navigate('/mail/inbox')} style={btnPrimary}>
              Back to Inbox
            </button>
          </div>
        </div>
      </Page>
    )
  }

  // Say WHY Send is unavailable. A greyed-out button with no explanation is the most
  // common complaint about compose screens, and the reason is always knowable here.
  const badTo   = invalidAddresses(to)
  const badCc   = invalidAddresses(cc)
  const badBcc  = invalidAddresses(bcc)
  const bodyEmpty = htmlToText(body) === '' && !/<img\s/i.test(body)

  const blockedReason =
    !to.trim()          ? 'Add at least one recipient'
    : badTo.length      ? `Not a valid address: ${badTo[0]}`
    : badCc.length      ? `Not a valid Cc address: ${badCc[0]}`
    : badBcc.length     ? `Not a valid Bcc address: ${badBcc[0]}`
    : !subject.trim()   ? 'Add a subject'
    : bodyEmpty         ? 'Write a message'
    : null

  const canSend = !blockedReason

  return (
    <Page
      title="Compose"
      subtitle={modeLabel}
      actions={
        <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }}>
          {blockedReason && (
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginRight: SP[1] }}>{blockedReason}</span>
          )}
          <button onClick={discard} style={btnSecondary}>Discard</button>
          <button onClick={saveDraft} disabled={savingDraft} style={btnSecondary}>
            {savingDraft ? 'Saving…' : 'Save Draft'}
          </button>
          <button
            onClick={send}
            disabled={sending || !canSend}
            title={blockedReason ?? 'Send'}
            style={{ ...btnPrimary, opacity: sending || !canSend ? 0.6 : 1, cursor: canSend && !sending ? 'pointer' : 'default' }}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      }
    >
      <ErrBanner error={err} />

      {/* Centred, not left-hugging. `maxWidth` alone pins a block to the left edge of
          the page container, which left the composer stranded against the sidebar with
          a wide empty gutter to its right. `margin: 0 auto` is what actually centres it.
          960 is wide enough that a signature or a pasted table is not cramped. */}
      <div style={{ maxWidth: 960, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        {/* Header card: recipients + subject */}
        <div style={{ background: 'var(--card)', borderRadius: RADIUS.xl, border: '1px solid var(--bdr)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--bdr)', padding: '10px 16px', gap: SP[3] }}>
            <span style={{ ...labelStyle(), marginBottom: 0, paddingTop: 3, minWidth: 36 }}>To</span>
            <input value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com, another@example.com"
              style={{ flex: 1, border: 'none', background: 'transparent', padding: '2px 0', fontSize: TEXT.base, color: badTo.length ? RED : 'var(--txt)', outline: 'none', fontFamily: INTER }} />
            <div style={{ display: 'flex', gap: SP[2], paddingTop: 2 }}>
              {!showCc  && <button onClick={() => setShowCc(true)}  style={ccBtn}>Cc</button>}
              {!showBcc && <button onClick={() => setShowBcc(true)} style={ccBtn}>Bcc</button>}
            </div>
          </div>

          {showCc && (
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--bdr)', padding: '10px 16px', gap: SP[3] }}>
              <span style={{ ...labelStyle(), marginBottom: 0, minWidth: 36 }}>Cc</span>
              <input value={cc} onChange={e => setCc(e.target.value)} placeholder="cc@example.com"
                style={{ flex: 1, border: 'none', background: 'transparent', padding: '2px 0', fontSize: TEXT.base, color: 'var(--txt)', outline: 'none', fontFamily: INTER }} />
            </div>
          )}

          {showBcc && (
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--bdr)', padding: '10px 16px', gap: SP[3] }}>
              <span style={{ ...labelStyle(), marginBottom: 0, minWidth: 36 }}>Bcc</span>
              <input value={bcc} onChange={e => setBcc(e.target.value)} placeholder="bcc@example.com"
                style={{ flex: 1, border: 'none', background: 'transparent', padding: '2px 0', fontSize: TEXT.base, color: 'var(--txt)', outline: 'none', fontFamily: INTER }} />
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', gap: SP[3] }}>
            <span style={{ ...labelStyle(), marginBottom: 0, minWidth: 36 }}>Subject</span>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject"
              style={{ flex: 1, border: 'none', background: 'transparent', padding: '2px 0', fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', outline: 'none', fontFamily: INTER }} />
          </div>
        </div>

        {/* Rich-text body */}
        <MailRichEditor value={body} onChange={setBody} minHeight={280} />
      </div>
    </Page>
  )
}

const ccBtn: React.CSSProperties = {
  fontSize: TEXT.xs, color: NAVY, background: 'none', border: 'none', cursor: 'pointer', fontWeight: FW.semibold,
}
