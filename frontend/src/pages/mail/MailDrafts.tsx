import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { sanitizeHtml } from '../../lib/sanitize'
import { Spinner, ErrBanner } from '../../components/UI'

interface Draft {
  id:         number
  subject:    string
  to_addrs:   { email: string; name?: string }[]
  html_body:  string | null
  text_body:  string | null
  updated_at: string
}

function fmtTs(ts: string) {
  return new Date(ts).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function toLabel(addrs: { email: string; name?: string }[]) {
  if (!addrs || addrs.length === 0) return 'No recipients'
  return addrs.length === 1 ? (addrs[0].name || addrs[0].email) : `${addrs[0].email} +${addrs.length - 1}`
}

function excerpt(html: string | null, text: string | null): string {
  const src = text ?? (html ?? '')
  const plain = src.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > 120 ? plain.slice(0, 120) + '…' : plain
}

export default function MailDrafts() {
  const navigate = useNavigate()
  const [drafts,   setDrafts]   = useState<Draft[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState('')
  const [selected, setSelected] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  useEffect(() => {
    setLoading(true); setErr('')
    apiFetch('/api/mail/drafts')
      .then((d: any) => setDrafts((d.data ?? d ?? []) as Draft[]))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function deleteDraft(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setDeleting(id)
    try {
      await apiFetch(`/api/mail/drafts/${id}`, { method: 'DELETE' })
      setDrafts(prev => prev.filter(d => d.id !== id))
      if (selected?.id === id) setSelected(null)
      toast.success('Draft deleted')
    } catch {
      toast.error('Failed to delete draft')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="flex h-full">
      {/* List pane */}
      <div className="w-[320px] flex-shrink-0 border-r overflow-y-auto"
        style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-white z-10"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h2 className="text-[14px] font-bold text-slate-800">Drafts</h2>
          <span className="text-[11px] text-slate-400">{drafts.length}</span>
        </div>

        <ErrBanner msg={err} />

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size={24} />
          </div>
        )}

        {!loading && drafts.length === 0 && !err && (
          <div className="flex flex-col items-center py-16 gap-3 text-slate-400">
            <span className="material-symbols-rounded text-[40px]">draft</span>
            <p className="text-[13px]">No drafts</p>
          </div>
        )}

        {drafts.map(d => (
          <div key={d.id}
            onClick={() => setSelected(d)}
            className={`px-4 py-3 cursor-pointer border-b transition-colors group relative ${selected?.id === d.id ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
            style={{ borderColor: 'rgba(15,23,42,0.06)' }}>
            <div className="flex items-start justify-between gap-2 mb-0.5">
              <p className="text-[13px] font-medium text-amber-700 truncate flex-1">
                {d.subject || '(no subject)'}
              </p>
              <button
                type="button"
                onClick={e => deleteDraft(d.id, e)}
                disabled={deleting === d.id}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-slate-400 hover:text-red-500 flex-shrink-0"
                title="Delete draft"
              >
                {deleting === d.id
                  ? <span className="material-symbols-rounded text-[14px] animate-spin">refresh</span>
                  : <span className="material-symbols-rounded text-[14px]">delete</span>
                }
              </button>
            </div>
            <p className="text-[11px] text-slate-400 truncate">To: {toLabel(d.to_addrs)}</p>
            <p className="text-[11px] text-slate-300 mt-0.5 truncate">
              {excerpt(d.html_body, d.text_body)}
            </p>
            <p className="text-[11px] text-slate-400 mt-1">{fmtTs(d.updated_at)}</p>
          </div>
        ))}
      </div>

      {/* Preview / edit pane */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
            <span className="material-symbols-rounded text-[48px]">draft</span>
            <p className="text-[14px]">Select a draft to preview</p>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-8 py-8">
            <div className="flex items-center gap-3 mb-5">
              <h1 className="text-[20px] font-bold text-slate-900 flex-1">
                {selected.subject || '(no subject)'}
              </h1>
              <button
                type="button"
                onClick={() => navigate(`/mail/compose?draft_id=${selected.id}`)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
                style={{ background: '#0E2841' }}
              >
                <span className="material-symbols-rounded text-[15px]">edit</span>
                Edit draft
              </button>
            </div>

            <div className="p-4 rounded-xl text-[12px] mb-5 space-y-2"
              style={{ background: 'rgba(14,40,65,0.04)' }}>
              <div className="flex gap-3">
                <span className="text-slate-400 w-8">To</span>
                <span className="text-slate-700 font-medium">{toLabel(selected.to_addrs)}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-slate-400 w-8">Last saved</span>
                <span className="text-slate-500">{fmtTs(selected.updated_at)}</span>
              </div>
            </div>

            {selected.html_body ? (
              <div className="rounded-xl border px-6 py-5"
                style={{ borderColor: 'rgba(15,23,42,0.08)', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.75 }}
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.html_body) }}
              />
            ) : selected.text_body ? (
              <div className="rounded-xl border px-6 py-5 text-[14px] text-slate-700 whitespace-pre-wrap leading-relaxed"
                style={{ borderColor: 'rgba(15,23,42,0.08)', fontFamily: 'inherit' }}>
                {selected.text_body}
              </div>
            ) : (
              <p className="text-[13px] text-slate-400 italic">Empty draft</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
