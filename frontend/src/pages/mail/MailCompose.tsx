import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import RecipientAutocomplete from '../../components/RecipientAutocomplete'
import SenderPicker from '../../components/SenderPicker'

const NAVY = '#0E2841'

interface Recipient { email: string; name?: string }

function RecipientTag({ email, onRemove }: { email: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-medium bg-slate-100 text-slate-700 flex-shrink-0">
      {email}
      <button onClick={onRemove} className="hover:text-red-500 ml-0.5">
        <span className="material-symbols-rounded text-[13px]">close</span>
      </button>
    </span>
  )
}

export default function MailCompose() {
  const navigate      = useNavigate()
  const [params]      = useSearchParams()

  const [to,      setTo]      = useState<Recipient[]>([])
  const [toInput, setToInput] = useState(params.get('to') ?? '')
  const [cc,      setCc]      = useState<Recipient[]>([])
  const [ccInput, setCcInput] = useState('')
  const [showCc,  setShowCc]  = useState(false)
  const [subject, setSubject] = useState(params.get('subject') ?? '')
  const [body,    setBody]    = useState('')
  const [sender,  setSender]  = useState<{ address: string; name: string } | null>(null)
  const [sending, setSending] = useState(false)

  function addRecipient(field: 'to' | 'cc', email: string, name?: string) {
    if (!email.includes('@')) return
    if (field === 'to') {
      if (!to.find(r => r.email === email)) setTo(prev => [...prev, { email, name }])
      setToInput('')
    } else {
      if (!cc.find(r => r.email === email)) setCc(prev => [...prev, { email, name }])
      setCcInput('')
    }
  }

  function handleToKeyDown(e: React.KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ',') && toInput.trim()) {
      e.preventDefault()
      addRecipient('to', toInput.trim())
    }
  }

  function handleCcKeyDown(e: React.KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ',') && ccInput.trim()) {
      e.preventDefault()
      addRecipient('cc', ccInput.trim())
    }
  }

  async function send() {
    if (to.length === 0) { toast.error('Add at least one recipient'); return }
    if (!subject.trim()) { toast.error('Subject is required'); return }
    if (!body.trim())    { toast.error('Message body is required'); return }
    setSending(true)
    try {
      await apiFetch('/api/mail/send', {
        method: 'POST',
        body: JSON.stringify({
          to:       to.map(r => ({ email: r.email, name: r.name })),
          cc:       cc.map(r => ({ email: r.email, name: r.name })),
          subject,
          html_body: `<div style="font-family:sans-serif;font-size:14px;color:#1e293b;line-height:1.7">${body.replace(/\n/g, '<br>')}</div>`,
          text_body: body,
          from_address: sender?.address,
          from_name:    sender?.name,
          send_copy_to_sender: true,
        }),
      })
      toast.success('Email sent')
      navigate('/mail/sent')
    } catch (e: any) {
      toast.error(e.message ?? 'Send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 w-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-[13px] text-slate-500 hover:text-slate-800 transition-colors">
          <span className="material-symbols-rounded text-[16px]">arrow_back</span>
          Back
        </button>
        <h1 className="text-[18px] font-bold text-slate-900">New Message</h1>
      </div>

      <div className="rounded-2xl border shadow-sm overflow-hidden"
        style={{ borderColor: 'rgba(15,23,42,0.1)' }}>

        {/* From */}
        <div className="px-5 py-3 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <SenderPicker
            purpose="general"
            label=""
            value={sender}
            onChange={setSender}
          />
        </div>

        {/* To */}
        <div className="px-5 py-3 border-b flex items-start gap-3"
          style={{ borderColor: 'rgba(15,23,42,0.08)', minHeight: 44 }}>
          <span className="text-[12px] font-semibold text-slate-400 pt-2 w-8 flex-shrink-0">To</span>
          <div className="flex-1 flex flex-wrap gap-1.5 items-center">
            {to.map(r => (
              <RecipientTag key={r.email} email={r.email}
                onRemove={() => setTo(prev => prev.filter(x => x.email !== r.email))} />
            ))}
            <div className="flex-1 min-w-[180px]">
              <RecipientAutocomplete
                value={toInput}
                onChange={setToInput}
                onSelect={s => addRecipient('to', s.email, s.name)}
                placeholder="recipient@example.com"
              />
            </div>
          </div>
          {!showCc && (
            <button onClick={() => setShowCc(true)}
              className="text-[11px] text-slate-400 hover:text-slate-600 flex-shrink-0 pt-2">Cc</button>
          )}
        </div>

        {/* Cc */}
        {showCc && (
          <div className="px-5 py-3 border-b flex items-start gap-3"
            style={{ borderColor: 'rgba(15,23,42,0.08)', minHeight: 44 }}>
            <span className="text-[12px] font-semibold text-slate-400 pt-2 w-8 flex-shrink-0">Cc</span>
            <div className="flex-1 flex flex-wrap gap-1.5 items-center">
              {cc.map(r => (
                <RecipientTag key={r.email} email={r.email}
                  onRemove={() => setCc(prev => prev.filter(x => x.email !== r.email))} />
              ))}
              <div className="flex-1 min-w-[180px]">
                <RecipientAutocomplete
                  value={ccInput}
                  onChange={setCcInput}
                  onSelect={s => addRecipient('cc', s.email, s.name)}
                  placeholder="cc@example.com"
                />
              </div>
            </div>
          </div>
        )}

        {/* Subject */}
        <div className="px-5 py-3 border-b flex items-center gap-3"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <span className="text-[12px] font-semibold text-slate-400 w-8 flex-shrink-0">Re</span>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 text-[14px] font-medium text-slate-900 outline-none bg-transparent placeholder:text-slate-300"
          />
        </div>

        {/* Body */}
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Write your message…"
          rows={16}
          className="w-full px-5 py-4 text-[14px] text-slate-800 outline-none resize-none placeholder:text-slate-300 leading-relaxed"
          style={{ fontFamily: 'inherit' }}
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-t"
          style={{ borderColor: 'rgba(15,23,42,0.08)', background: '#FAFAFA' }}>
          <div className="flex items-center gap-2">
            <button
              onClick={send}
              disabled={sending}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}>
              <span className="material-symbols-rounded text-[15px]">send</span>
              {sending ? 'Sending…' : 'Send'}
            </button>
            <label className="flex items-center gap-1.5 text-[12px] text-slate-500 cursor-pointer select-none">
              <input type="checkbox" className="rounded" defaultChecked />
              Send me a copy
            </label>
          </div>
          <button onClick={() => navigate(-1)}
            className="text-[12px] text-slate-400 hover:text-red-500 transition-colors">
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}
