import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Page, ErrBanner, btnPrimary, btnSecondary, filterInputStyle } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MailAddress { Email: string; Name: string }

interface Draft {
  id:         number
  subject:    string | null
  to_addrs:   MailAddress[] | null
  from_email: string | null
  from_name:  string | null
  html_body:  string | null
  text_body:  string | null
}

interface Signature { signature_text: string | null; signature_html: string | null }

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseAddresses(raw: string): MailAddress[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ Email: s, Name: '' }))
}

function labelStyle(): React.CSSProperties {
  return { fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MailCompose() {
  const navigate       = useNavigate()
  const [params]       = useSearchParams()
  const draftId        = params.get('draft')

  const [to, setTo]           = useState(params.get('to') ?? '')
  const [cc, setCc]           = useState('')
  const [bcc, setBcc]         = useState('')
  const [subject, setSubject] = useState(params.get('subject') ?? '')
  const [body, setBody]       = useState('')
  const [showCc, setShowCc]   = useState(false)
  const [showBcc, setShowBcc] = useState(false)

  const [activeDraftId, setActiveDraftId] = useState<number | null>(draftId ? Number(draftId) : null)
  const [sending, setSending]   = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [err, setErr]           = useState<string | null>(null)
  const [sent, setSent]         = useState(false)

  // Load draft or signature on mount
  useEffect(() => {
    if (draftId) {
      apiFetch<Draft>(`/api/mail/drafts/${draftId}`)
        .then(d => {
          setSubject(d.subject ?? '')
          setTo((d.to_addrs ?? []).map(a => a.Email).join(', '))
          setBody(d.text_body ?? d.html_body ?? '')
        })
        .catch(() => {})
      return
    }
    apiFetch<Signature>('/api/mail/signature')
      .then(s => { if (s.signature_text) setBody('\n\n-- \n' + s.signature_text) })
      .catch(() => {})
  }, [draftId])

  async function send() {
    if (!to.trim() || !subject.trim() || !body.trim()) return
    setSending(true); setErr(null)
    try {
      await apiPost('/api/mail/send', {
        to:        parseAddresses(to),
        cc:        cc  ? parseAddresses(cc)  : [],
        bcc:       bcc ? parseAddresses(bcc) : [],
        subject,
        text_body: body,
        send_copy_to_sender: true,
      })
      setSent(true)
    } catch (ex: any) { setErr(ex.message) }
    finally { setSending(false) }
  }

  async function saveDraft() {
    setSavingDraft(true); setErr(null)
    try {
      const payload: Record<string, any> = {
        subject,
        to_addrs:  to  ? parseAddresses(to)  : [],
        cc_addrs:  cc  ? parseAddresses(cc)  : [],
        bcc_addrs: bcc ? parseAddresses(bcc) : [],
        text_body: body,
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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginTop: 60 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 52, color: '#10B981' }}>check_circle</span>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--txt)' }}>Message sent</div>
          <div style={{ fontSize: 14, color: 'var(--txt3)' }}>Your email has been delivered successfully.</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button onClick={() => { setSent(false); setTo(''); setSubject(''); setBody('') }} style={btnSecondary}>
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

  return (
    <Page
      title="Compose"
      subtitle="New message"
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate(-1)} style={btnSecondary}>Discard</button>
          <button onClick={saveDraft} disabled={savingDraft} style={btnSecondary}>
            {savingDraft ? 'Saving…' : 'Save Draft'}
          </button>
          <button
            onClick={send}
            disabled={sending || !to.trim() || !subject.trim() || !body.trim()}
            style={btnPrimary}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      }
    >
      <ErrBanner error={err} />

      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Header card */}
        <div style={{ background: 'var(--card)', borderRadius: 12, border: '1px solid var(--bdr)', overflow: 'hidden' }}>
          {/* To */}
          <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--bdr)', padding: '10px 16px', gap: 12 }}>
            <span style={{ ...labelStyle(), marginBottom: 0, paddingTop: 3, minWidth: 36 }}>To</span>
            <div style={{ flex: 1 }}>
              <input
                value={to}
                onChange={e => setTo(e.target.value)}
                placeholder="recipient@example.com, another@example.com"
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', border: 'none', background: 'transparent', padding: '2px 0', fontSize: 13 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, paddingTop: 2 }}>
              {!showCc  && <button onClick={() => setShowCc(true)}  style={{ fontSize: 11.5, color: NAVY, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Cc</button>}
              {!showBcc && <button onClick={() => setShowBcc(true)} style={{ fontSize: 11.5, color: NAVY, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Bcc</button>}
            </div>
          </div>

          {/* Cc */}
          {showCc && (
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--bdr)', padding: '10px 16px', gap: 12 }}>
              <span style={{ ...labelStyle(), marginBottom: 0, minWidth: 36 }}>Cc</span>
              <input
                value={cc}
                onChange={e => setCc(e.target.value)}
                placeholder="cc@example.com"
                style={{ ...filterInputStyle, flex: 1, border: 'none', background: 'transparent', padding: '2px 0', fontSize: 13 }}
              />
            </div>
          )}

          {/* Bcc */}
          {showBcc && (
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--bdr)', padding: '10px 16px', gap: 12 }}>
              <span style={{ ...labelStyle(), marginBottom: 0, minWidth: 36 }}>Bcc</span>
              <input
                value={bcc}
                onChange={e => setBcc(e.target.value)}
                placeholder="bcc@example.com"
                style={{ ...filterInputStyle, flex: 1, border: 'none', background: 'transparent', padding: '2px 0', fontSize: 13 }}
              />
            </div>
          )}

          {/* Subject */}
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--bdr)', padding: '10px 16px', gap: 12 }}>
            <span style={{ ...labelStyle(), marginBottom: 0, minWidth: 36 }}>Subject</span>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Subject"
              style={{ ...filterInputStyle, flex: 1, border: 'none', background: 'transparent', padding: '2px 0', fontSize: 13, fontWeight: 600 }}
            />
          </div>

          {/* Body */}
          <div style={{ padding: '12px 16px' }}>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Write your message here…"
              rows={18}
              style={{
                width: '100%', boxSizing: 'border-box',
                border: 'none', background: 'transparent',
                resize: 'vertical', fontSize: 13.5,
                lineHeight: 1.7, color: 'var(--txt)',
                fontFamily: INTER, outline: 'none',
              }}
            />
          </div>
        </div>
      </div>
    </Page>
  )
}
