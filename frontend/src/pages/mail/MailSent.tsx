import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { sanitizeHtml } from '../../lib/sanitize'
import { Spinner, ErrBanner } from '../../components/UI'

const NAVY  = '#0E2841'
const GREEN = '#166534'
const RED   = '#C00000'
const AMBER = '#F59E0B'

const STATUS_COLOR: Record<string, string> = {
  delivered:   GREEN,
  opened:      '#2563EB',
  clicked:     '#7C3AED',
  bounced:     RED,
  dropped:     RED,
  spam_report: RED,
  sending:     AMBER,
  failed:      RED,
  queued:      AMBER,
}

function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? '#64748B'
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full text-white"
      style={{ background: color }}>
      {status}
    </span>
  )
}

interface MailMessage {
  id:           number
  kind:         string
  subject:      string
  from_email:   string
  from_name:    string
  recipients:   any
  status:       string
  created_at:   string
  delivered_at: string | null
  opened_at:    string | null
  clicked_at:   string | null
  last_error:   string | null
  html_body?:   string
  text_body?:   string
  thread_id?:   number | null
  parent_id?:   number | null
}

function fmtTs(ts: string | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function toList(r: any): string {
  if (!r) return '—'
  const to = r.to ?? []
  if (to.length === 0) return '—'
  return to.length === 1 ? (to[0].name ? `${to[0].name} <${to[0].email}>` : to[0].email)
    : `${to[0].email} +${to.length - 1}`
}

export default function MailSent() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState('')
  const [selected, setSelected] = useState<MailMessage | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)

  useEffect(() => {
    setLoading(true); setErr('')
    apiFetch('/api/mail/messages')
      .then(data => setMessages(((data as any).data ?? data ?? []) as MailMessage[]))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function selectMessage(m: MailMessage) {
    setSelected(m)
    if (!m.html_body) {
      setBodyLoading(true)
      try {
        const full: any = await apiFetch(`/api/mail/messages/${m.id}`)
        setSelected({ ...m, ...full })
        setMessages(prev => prev.map(x => x.id === m.id ? { ...x, ...full } : x))
      } catch {
        // keep without body
      } finally {
        setBodyLoading(false)
      }
    }
  }

  return (
    <div className="flex h-full">
      {/* List pane */}
      <div className="w-[320px] flex-shrink-0 border-r overflow-y-auto"
        style={{ borderColor: 'var(--bdr)' }}>
        <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-[var(--card)] z-10"
          style={{ borderColor: 'var(--bdr)' }}>
          <h2 className="text-[14px] font-bold text-[color:var(--txt)]">Sent</h2>
          <span className="text-[11px] text-[color:var(--txt2)]">{messages.length}</span>
        </div>

        <ErrBanner msg={err} />

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size={24} />
          </div>
        )}

        {!loading && messages.length === 0 && !err && (
          <div className="flex flex-col items-center py-16 gap-3 text-[color:var(--txt2)]">
            <span className="material-symbols-rounded text-[40px]">send</span>
            <p className="text-[13px]">No sent mail yet</p>
          </div>
        )}

        {messages.map(m => (
          <div key={m.id}
            onClick={() => selectMessage(m)}
            className={`px-4 py-3 cursor-pointer border-b transition-colors ${selected?.id === m.id ? 'bg-[var(--chip-bg)]' : 'hover:bg-[var(--bg)]'}`}
            style={{ borderColor: 'rgba(15,23,42,0.06)' }}>
            <div className="flex items-start justify-between gap-2 mb-0.5">
              <p className="text-[13px] font-medium text-[color:var(--txt)] truncate flex-1">
                {m.subject || '(no subject)'}
              </p>
              <StatusPill status={m.status} />
            </div>
            <p className="text-[11px] text-[color:var(--txt2)] truncate">To: {toList(m.recipients)}</p>
            <p className="text-[11px] text-[color:var(--txt2)] mt-0.5">{fmtTs(m.created_at)}</p>
          </div>
        ))}
      </div>

      {/* Detail pane */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[color:var(--txt2)]">
            <span className="material-symbols-rounded text-[48px]">outgoing_mail</span>
            <p className="text-[14px]">Select a message to view</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-8 py-8">
            {/* Action buttons */}
            <div className="flex items-center gap-2 mb-5">
              <button
                type="button"
                onClick={() => navigate(`/mail/compose?reply_to=${selected.id}`)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[color:var(--txt2)] hover:bg-[var(--chip-bg)] transition-colors border"
                style={{ borderColor: 'var(--bdr)' }}
              >
                <span className="material-symbols-rounded text-[15px]">reply</span>
                Reply
              </button>
              <button
                type="button"
                onClick={() => navigate(`/mail/compose?forward=${selected.id}`)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[color:var(--txt2)] hover:bg-[var(--chip-bg)] transition-colors border"
                style={{ borderColor: 'var(--bdr)' }}
              >
                <span className="material-symbols-rounded text-[15px]">forward</span>
                Forward
              </button>
              <div className="flex-1" />
              <StatusPill status={selected.status} />
            </div>

            {/* Subject */}
            <h1 className="text-[20px] font-bold text-[color:var(--txt)] mb-4">
              {selected.subject || '(no subject)'}
            </h1>

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-4 mb-6 p-4 rounded-xl text-[12px]"
              style={{ background: 'rgba(14,40,65,0.04)' }}>
              <div>
                <span className="text-[color:var(--txt2)]">From</span>
                <p className="font-medium text-[color:var(--txt)] mt-0.5">
                  {selected.from_name ? `${selected.from_name} <${selected.from_email}>` : selected.from_email}
                </p>
              </div>
              <div>
                <span className="text-[color:var(--txt2)]">To</span>
                <p className="font-medium text-[color:var(--txt)] mt-0.5">{toList(selected.recipients)}</p>
              </div>
              <div>
                <span className="text-[color:var(--txt2)]">Sent</span>
                <p className="font-medium text-[color:var(--txt)] mt-0.5">{fmtTs(selected.created_at)}</p>
              </div>
              <div>
                <span className="text-[color:var(--txt2)]">Delivered</span>
                <p className="font-medium mt-0.5" style={{ color: selected.delivered_at ? GREEN : '#94a3b8' }}>
                  {fmtTs(selected.delivered_at)}
                </p>
              </div>
              <div>
                <span className="text-[color:var(--txt2)]">Opened</span>
                <p className="font-medium mt-0.5" style={{ color: selected.opened_at ? '#2563EB' : '#94a3b8' }}>
                  {fmtTs(selected.opened_at)}
                </p>
              </div>
              <div>
                <span className="text-[color:var(--txt2)]">Clicked</span>
                <p className="font-medium mt-0.5" style={{ color: selected.clicked_at ? '#7C3AED' : '#94a3b8' }}>
                  {fmtTs(selected.clicked_at)}
                </p>
              </div>
            </div>

            {selected.last_error && (
              <div className="mb-4 p-3 rounded-lg text-[12px] text-red-700"
                style={{ background: 'rgba(192,0,0,0.07)' }}>
                <span className="font-semibold">Error:</span> {selected.last_error}
              </div>
            )}

            {/* Body */}
            {bodyLoading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner size={24} />
              </div>
            ) : selected.html_body ? (
              <div
                className="rounded-xl border overflow-hidden"
                style={{ borderColor: 'var(--bdr)' }}
              >
                <div
                  className="px-6 py-5 prose prose-sm max-w-none text-[color:var(--txt)]"
                  style={{ fontFamily: 'inherit', fontSize: 14, lineHeight: 1.75 }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.html_body) }}
                />
              </div>
            ) : selected.text_body ? (
              <div className="rounded-xl border px-6 py-5 text-[14px] text-[color:var(--txt)] whitespace-pre-wrap leading-relaxed"
                style={{ borderColor: 'var(--bdr)', fontFamily: 'inherit' }}>
                {selected.text_body}
              </div>
            ) : (
              <p className="text-[12px] text-[color:var(--txt2)] italic">
                Message body not available — only delivery metadata is tracked.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
