import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { Page, ErrBanner, SectionCard, btnPrimary, btnSecondary, Spinner } from '../../components/UI'
import MailRichEditor from '../../components/MailRichEditor'
import { apiFetch, apiPut } from '../../lib/api'
import { TEXT, FW, SP, GREEN } from '../../lib/design'

interface Signature { signature_text: string | null; signature_html: string | null }

function htmlToText(html: string): string {
  const d = document.createElement('div')
  d.innerHTML = DOMPurify.sanitize(html)
  return (d.textContent ?? '').trim()
}

export default function MailSignatureSettings() {
  const navigate = useNavigate()
  const [html, setHtml] = useState('<p></p>')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch<Signature>('/api/mail/signature')
      .then(s => {
        if (cancelled) return
        if (s.signature_html && s.signature_html.trim()) setHtml(s.signature_html)
        else if (s.signature_text && s.signature_text.trim()) {
          const safe = s.signature_text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
          setHtml(`<p>${safe}</p>`)
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function save() {
    setSaving(true); setErr(null); setSaved(false)
    try {
      const clean = DOMPurify.sanitize(html)
      await apiPut('/api/mail/signature', {
        signature_html: clean,
        signature_text: htmlToText(clean),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  return (
    <Page
      title="Email Signature"
      subtitle="Appended automatically to new messages, replies and forwards"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          {saved && <span style={{ fontSize: TEXT.sm, color: GREEN, fontWeight: FW.semibold, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>check_circle</span>Saved
          </span>}
          <button onClick={() => navigate('/mail/compose')} style={btnSecondary}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save signature'}
          </button>
        </div>
      }
    >
      <ErrBanner error={err} />
      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        <SectionCard title="Your signature">
          {loading ? (
            <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : (
            <MailRichEditor value={html} onChange={setHtml} minHeight={160} placeholder="Your name, role, phone, links…" />
          )}
        </SectionCard>

        {/* Live preview of how it appends */}
        <SectionCard title="Preview" subtitle="How it will look at the end of a message">
          <div style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--txt)' }}>
            <p style={{ margin: '0 0 10px', color: 'var(--txt3)' }}>…your message text…</p>
            <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
