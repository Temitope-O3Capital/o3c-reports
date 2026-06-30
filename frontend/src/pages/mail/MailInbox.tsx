import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'
import { sanitizeHtml } from '../../lib/sanitize'
import { Spinner, ErrBanner, NAVY } from '../../components/UI'

const NAVY_STR = '#0E2841'

interface InboundMessage {
  id:          number
  from_email:  string
  from_name:   string | null
  subject:     string
  body_text:   string | null
  body_html:   string | null
  received_at: string
  is_read:     boolean
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

export default function MailInbox() {
  const [messages, setMessages] = useState<InboundMessage[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState('')
  const [selected, setSelected] = useState<InboundMessage | null>(null)

  useEffect(() => {
    setLoading(true); setErr('')
    apiFetch('/api/mail/inbox')
      .then(data => setMessages((data as any) ?? []))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex h-full">
      {/* Message list */}
      <div className="w-[320px] flex-shrink-0 border-r overflow-y-auto"
        style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        <div className="px-4 py-3 border-b flex items-center justify-between"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h2 className="text-[14px] font-bold text-slate-800">Inbox</h2>
          <span className="text-[11px] text-slate-400">{messages.length} messages</span>
        </div>

        <ErrBanner msg={err} />

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size={24} />
          </div>
        )}

        {!loading && messages.length === 0 && !err && (
          <div className="flex flex-col items-center py-16 gap-3 text-slate-400">
            <span className="material-symbols-rounded text-[40px]">inbox</span>
            <p className="text-[13px]">No messages in inbox</p>
            <p className="text-[11px] text-slate-300 text-center px-6">
              Emails sent to your inbound address will appear here.
            </p>
          </div>
        )}

        {messages.map(m => (
          <div key={m.id}
            onClick={() => setSelected(m)}
            className={`px-4 py-3 cursor-pointer border-b transition-colors ${selected?.id === m.id ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
            style={{ borderColor: 'rgba(15,23,42,0.06)' }}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {!m.is_read && (
                  <span className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: NAVY_STR }} />
                )}
                <p className={`text-[13px] truncate ${m.is_read ? 'text-slate-600' : 'font-semibold text-slate-900'}`}>
                  {m.from_name || m.from_email}
                </p>
              </div>
              <span className="text-[11px] text-slate-400 flex-shrink-0">{relTime(m.received_at)}</span>
            </div>
            <p className={`text-[12px] truncate mt-0.5 ${m.is_read ? 'text-slate-400' : 'text-slate-700'}`}>
              {m.subject}
            </p>
            <p className="text-[11px] text-slate-400 truncate mt-0.5">
              {(m.body_text ?? '').slice(0, 80)}
            </p>
          </div>
        ))}
      </div>

      {/* Message detail */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
            <span className="material-symbols-rounded text-[48px]">mail_open</span>
            <p className="text-[14px]">Select a message to read</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-8 py-8">
            <h1 className="text-[18px] font-bold text-slate-900 mb-4">{selected.subject}</h1>
            <div className="flex items-center gap-3 mb-6 pb-4 border-b"
              style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white"
                style={{ background: NAVY_STR }}>
                {(selected.from_name || selected.from_email).charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="text-[13px] font-semibold text-slate-800">
                  {selected.from_name || selected.from_email}
                </p>
                <p className="text-[12px] text-slate-400">{selected.from_email} · {relTime(selected.received_at)}</p>
              </div>
            </div>
            {selected.body_html ? (
              <div
                className="prose prose-sm max-w-none text-slate-700"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.body_html) }}
              />
            ) : (
              <pre className="text-[13px] text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                {selected.body_text}
              </pre>
            )}
            <div className="mt-8 pt-4 border-t flex gap-2" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
              <a
                href={`/mail/compose?to=${encodeURIComponent(selected.from_email)}&subject=${encodeURIComponent('Re: ' + selected.subject)}`}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
                style={{ background: NAVY_STR }}>
                <span className="material-symbols-rounded text-[15px]">reply</span>
                Reply
              </a>
              <button
                onClick={() => setSelected(null)}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-slate-600 border"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
