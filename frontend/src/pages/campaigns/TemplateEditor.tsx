import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { NAVY, BLUE, INTER } from '../../lib/design'
import EmailBlockEditor, { blocksToHtml, type Block } from '../../components/EmailBlockEditor'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FormState {
  id?: number
  name: string
  channel: 'sms' | 'email'
  category: string
  sms_body: string
  email_subject: string
  email_blocks: Block[]
}

const BLANK: FormState = {
  name: '', channel: 'email', category: 'marketing',
  sms_body: '', email_subject: '', email_blocks: [],
}

const MERGE_TAGS = [
  '{{first_name}}', '{{last_name}}', '{{amount}}',
  '{{due_date}}', '{{company}}', '{{cta_url}}', '{{phone}}',
]

// ── iPhone 15 Pro Mockup ──────────────────────────────────────────────────────

function IPhoneMockup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', width: 285 }}>
      {/* Side buttons */}
      <div style={{ position: 'absolute', left: -3, top: 92, width: 3, height: 28, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
      <div style={{ position: 'absolute', left: -3, top: 130, width: 3, height: 52, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
      <div style={{ position: 'absolute', left: -3, top: 192, width: 3, height: 52, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
      <div style={{ position: 'absolute', right: -3, top: 150, width: 3, height: 72, background: '#3a3a3c', borderRadius: '0 2px 2px 0' }} />

      {/* Body */}
      <div style={{
        background: 'linear-gradient(160deg, #2d2d2f 0%, #1c1c1e 100%)',
        borderRadius: 48, padding: 10,
        boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 0 0 2px #0a0a0a, 0 50px 100px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.1)',
      }}>
        {/* Screen */}
        <div style={{ borderRadius: 38, overflow: 'hidden', background: '#fff', height: 598, display: 'flex', flexDirection: 'column', position: 'relative' }}>

          {/* Dynamic Island */}
          <div style={{
            position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
            width: 112, height: 32, background: '#000', borderRadius: 20, zIndex: 10,
            boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.06)',
          }} />

          {/* Status bar */}
          <div style={{
            height: 54, display: 'flex', alignItems: 'flex-end',
            padding: '0 22px 8px', justifyContent: 'space-between', flexShrink: 0,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: '#000', letterSpacing: -0.3 }}>9:41</span>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              {/* Cell signal */}
              <svg width="17" height="12" viewBox="0 0 17 12">
                <rect x="0"    y="8"   width="3" height="4"  rx="1" fill="#000"/>
                <rect x="4.5"  y="5.5" width="3" height="6.5" rx="1" fill="#000"/>
                <rect x="9"    y="2.5" width="3" height="9.5" rx="1" fill="#000"/>
                <rect x="13.5" y="0"   width="3" height="12"  rx="1" fill="#000" opacity="0.25"/>
              </svg>
              {/* WiFi */}
              <svg width="16" height="12" viewBox="0 0 16 12">
                <path d="M8 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill="#000"/>
                <path d="M3.2 6.3C4.6 4.9 6.2 4.2 8 4.2s3.4.7 4.8 2.1" stroke="#000" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                <path d="M.5 3.5C2.4 1.6 5 .5 8 .5s5.6 1.1 7.5 3" stroke="#000" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              </svg>
              {/* Battery */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ width: 23, height: 12, borderRadius: 3.5, border: '1px solid rgba(0,0,0,0.3)', padding: '1.5px', display: 'flex', alignItems: 'center' }}>
                  <div style={{ width: '82%', height: '100%', background: '#34C759', borderRadius: 2 }} />
                </div>
                <div style={{ width: 2, height: 5, background: 'rgba(0,0,0,0.3)', borderRadius: '0 1.5px 1.5px 0', marginLeft: -1 }} />
              </div>
            </div>
          </div>

          {/* App content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Messages App Preview ──────────────────────────────────────────────────────

function SmsAppPreview({ text }: { text: string }) {
  const ff = '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#fff', fontFamily: ff, minHeight: 0 }}>

      {/* Messages header */}
      <div style={{ background: 'rgba(242,242,247,0.92)', backdropFilter: 'blur(20px)', borderBottom: '0.5px solid rgba(0,0,0,0.15)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px 10px', gap: 6 }}>
          <span style={{ color: '#007AFF', fontSize: 16, fontWeight: 400 }}>‹</span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'linear-gradient(135deg, #C00000 0%, #8B0000 100%)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, marginBottom: 2 }}>O</div>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: '#000' }}>O3 Capital</div>
          </div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="#007AFF">
            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
          </svg>
        </div>
      </div>

      {/* Message thread */}
      <div style={{ flex: 1, padding: '10px 12px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 5, overflow: 'hidden' }}>
        <div style={{ textAlign: 'center', fontSize: 10.5, color: '#8e8e93', fontWeight: 400, marginBottom: 6 }}>
          Today 9:41 AM
        </div>

        {/* Incoming (from O3 Capital) */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5 }}>
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'linear-gradient(135deg, #C00000, #8B0000)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>O</div>
          <div style={{
            background: '#e5e5ea', color: '#000',
            borderRadius: '16px 16px 16px 4px',
            padding: '9px 13px', maxWidth: '80%',
            fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word',
            boxShadow: '0 1px 1px rgba(0,0,0,0.07)',
          }}>
            {text || <span style={{ color: '#8e8e93', fontStyle: 'italic' }}>Your message preview…</span>}
          </div>
        </div>
        <div style={{ fontSize: 10, color: '#8e8e93', paddingLeft: 30 }}>Delivered</div>
      </div>

      {/* Input bar */}
      <div style={{ padding: '6px 10px 10px', borderTop: '0.5px solid rgba(0,0,0,0.12)', display: 'flex', gap: 7, alignItems: 'center', background: '#fff', flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', border: '1.5px solid #8e8e93', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 16, color: '#8e8e93', lineHeight: 1 }}>+</span>
        </div>
        <div style={{ flex: 1, background: '#f2f2f7', borderRadius: 18, padding: '7px 12px', fontSize: 13, color: '#8e8e93', border: '0.5px solid rgba(0,0,0,0.08)' }}>
          iMessage
        </div>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#8e8e93', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M12 20V4M5 11l7-7 7 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  padding: '6px 11px', borderRadius: 7, border: '1px solid var(--bdr)',
  outline: 'none', fontSize: 13, fontFamily: 'inherit',
  boxSizing: 'border-box', background: 'var(--input-bg)', color: 'var(--txt)',
}

export default function CampaignTemplateEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [form, setForm] = useState<FormState>(() => ({
    ...BLANK,
    channel: (searchParams.get('channel') as 'sms' | 'email') ?? 'email',
    name:    searchParams.get('name') ?? '',
  }))
  const [saving, setSaving]   = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!id)

  useEffect(() => {
    if (!id) return
    apiFetch<any>(`/api/message-templates/${id}`)
      .then(t => setForm({
        id: t.id,
        name: t.name ?? '',
        channel: t.channel === 'email' ? 'email' : 'sms',
        category: t.category ?? 'marketing',
        sms_body: t.sms_body ?? '',
        email_subject: t.email_subject ?? '',
        email_blocks: Array.isArray(t.email_blocks) ? t.email_blocks : [],
      }))
      .catch(() => navigate('/campaigns/templates'))
      .finally(() => setLoading(false))
  }, [id, navigate])

  const save = useCallback(async () => {
    if (!form.name.trim()) return
    setSaving(true); setSaveErr(null)
    try {
      const body: Record<string, any> = {
        name: form.name.trim(), channel: form.channel, category: form.category,
      }
      if (form.channel === 'sms') {
        body.sms_body = form.sms_body
      } else {
        body.email_subject = form.email_subject
        const emailHtml = blocksToHtml(form.email_blocks)
        body.email_body_html = emailHtml
        body.email_body_text = emailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        body.email_blocks = form.email_blocks
      }
      if (form.id) await apiPut(`/api/message-templates/${form.id}`, body)
      else         await apiPost('/api/message-templates', body)
      navigate('/campaigns/templates')
    } catch (ex: any) { setSaveErr(ex.message) }
    finally { setSaving(false) }
  }, [form, navigate])

  function insertTag(tag: string) {
    const el = textareaRef.current
    const v  = form.sms_body
    if (!el) { setForm(f => ({ ...f, sms_body: v + tag })); return }
    const s = el.selectionStart ?? v.length
    const e = el.selectionEnd   ?? v.length
    setForm(f => ({ ...f, sms_body: v.slice(0, s) + tag + v.slice(e) }))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + tag.length, s + tag.length) })
  }

  const len  = form.sms_body.length
  const segs = len === 0 ? 1 : len <= 160 ? 1 : Math.ceil(len / 153)
  const pct  = Math.min(100, (len / 160) * 100)
  const barC = len > 160 ? '#EF4444' : len > 130 ? '#D97706' : '#16A34A'

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 14 }}>
        Loading…
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid var(--bdr)', background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}>

        {/* Back */}
        <button onClick={() => navigate('/campaigns/templates')}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--txt2)', fontFamily: INTER, flexShrink: 0 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_back</span>
          Templates
        </button>

        <div style={{ width: 1, height: 22, background: 'var(--bdr)', flexShrink: 0 }} />

        {/* Name */}
        <input
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="Template name…"
          autoFocus={!id}
          style={{ ...inp, flex: 1, minWidth: 200, fontSize: 14, fontWeight: 600 }}
        />

        {/* Channel toggle */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, background: 'var(--th-bg)', borderRadius: 8, padding: 3 }}>
          {(['sms', 'email'] as const).map(ch => (
            <button key={ch} onClick={() => setForm(f => ({ ...f, channel: ch }))}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 6, border: 'none', background: form.channel === ch ? 'var(--card)' : 'transparent', color: form.channel === ch ? BLUE : 'var(--txt3)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: INTER, boxShadow: form.channel === ch ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>
                {ch === 'sms' ? 'smartphone' : 'mail'}
              </span>
              {ch === 'sms' ? 'SMS' : 'Email'}
            </button>
          ))}
        </div>

        {/* Category */}
        <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          style={{ ...inp, fontSize: 12.5, flexShrink: 0 }}>
          <option value="marketing">Marketing</option>
          <option value="collections">Collections</option>
          <option value="onboarding">Onboarding</option>
          <option value="repayment_reminder">Repayment Reminder</option>
          <option value="general">General</option>
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {saveErr && <span style={{ fontSize: 12, color: '#EF4444' }}>{saveErr}</span>}
          <button onClick={save} disabled={saving || !form.name.trim()}
            style={{ padding: '7px 20px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: INTER, opacity: saving || !form.name.trim() ? 0.55 : 1 }}>
            {saving ? 'Saving…' : form.id ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </div>

      {/* ── Email subject strip ── */}
      {form.channel === 'email' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 18px', borderBottom: '1px solid var(--bdr)', background: 'var(--card)', flexShrink: 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, flexShrink: 0 }}>SUBJECT</span>
          <input
            value={form.email_subject}
            onChange={e => setForm(f => ({ ...f, email_subject: e.target.value }))}
            placeholder="e.g. Your O3 Capital repayment is due soon"
            style={{ ...inp, flex: 1, fontSize: 13 }}
          />
        </div>
      )}

      {/* ── Editor content ── */}
      {form.channel === 'email' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {/* Merge tag strip for email */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 14px', borderBottom: '1px solid var(--bdr)', background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, flexShrink: 0 }}>MERGE TAGS</span>
            {MERGE_TAGS.map(t => (
              <span key={t} style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--chip-bg)', color: 'var(--txt2)', fontFamily: 'monospace', cursor: 'default', userSelect: 'all' }}>{t}</span>
            ))}
          </div>
          <EmailBlockEditor
            value={{ blocks: form.email_blocks }}
            onChange={v => setForm(f => ({ ...f, email_blocks: v.blocks }))}
          />
        </div>
      ) : (
        /* ── SMS: composer + live phone preview ── */
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

          {/* Composer panel */}
          <div style={{ width: 560, flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '24px 28px', gap: 18, overflowY: 'auto', borderRight: '1px solid var(--bdr)' }}>

            {/* Merge tags */}
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 9 }}>INSERT MERGE TAG</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {MERGE_TAGS.map(t => (
                  <button key={t} onClick={() => insertTag(t)}
                    style={{ fontSize: 11.5, padding: '4px 10px', border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--chip-bg)', color: 'var(--txt2)', cursor: 'pointer', fontFamily: 'monospace' }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Textarea */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5 }}>MESSAGE BODY</div>
              <textarea
                ref={textareaRef}
                value={form.sms_body}
                onChange={e => setForm(f => ({ ...f, sms_body: e.target.value }))}
                placeholder="Hi {{first_name}}, your O3 Capital repayment of ₦{{amount}} is due on {{due_date}}. Pay now to avoid late fees."
                style={{ fontSize: 14, padding: '14px 16px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: 'monospace', resize: 'none', lineHeight: 1.75, boxSizing: 'border-box', width: '100%', flex: 1, minHeight: 260, outline: 'none' }}
              />

              {/* Character counter */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, height: 4, background: 'var(--bdr)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: barC, borderRadius: 2, transition: 'width 0.1s, background 0.2s' }} />
                </div>
                <span style={{ fontSize: 12, color: barC, fontFamily: 'monospace', fontWeight: 600, flexShrink: 0, minWidth: 130, textAlign: 'right' }}>
                  {len} / 160 · {segs} SMS{segs > 1 ? ' credits' : ''}
                </span>
              </div>
              {len > 130 && (
                <div style={{ fontSize: 12, color: len > 160 ? '#EF4444' : '#D97706', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>warning</span>
                  {len > 160 ? `${segs} SMS credits will be charged per recipient` : 'Merge tags may push this over 160 chars'}
                </div>
              )}
            </div>
          </div>

          {/* Live phone preview */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--th-bg)', padding: 40, overflow: 'auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5 }}>LIVE SMS PREVIEW</div>
              <IPhoneMockup>
                <SmsAppPreview text={form.sms_body} />
              </IPhoneMockup>
              <p style={{ fontSize: 11.5, color: 'var(--txt3)', textAlign: 'center', margin: 0, maxWidth: 260, lineHeight: 1.6 }}>
                Merge tags render as the actual value when sent to each recipient.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
