import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, DataTable, Spinner, ErrBanner, NAVY, ColDef } from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────────────────
interface CannedResponse {
  id: number
  name: string
  channel: string
  category: string
  subject?: string
  body_text: string
  body_html?: string
}

// ── Constants ──────────────────────────────────────────────────────────────────
const CHANNEL_OPTIONS = [
  { value: 'email', label: 'Email' },
  { value: 'sms',   label: 'SMS' },
  { value: 'both',  label: 'Both' },
]

// ── Main component ─────────────────────────────────────────────────────────────
export default function CannedResponses() {
  const [rows, setRows]         = useState<CannedResponse[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState('')
  const [modalOpen, setModal]   = useState(false)
  const [editing, setEditing]   = useState<CannedResponse | null>(null)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  function load() {
    setLoading(true); setErr('')
    apiFetch<CannedResponse[]>('/api/helpdesk/canned-responses')
      .then(setRows)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    setDeleting(true)
    try {
      await apiFetch(`/api/helpdesk/canned-responses/${id}`, { method: 'DELETE' })
      setDeleteId(null)
      load()
    } catch (e: any) {
      setErr(e.message || 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  const cols: ColDef<CannedResponse>[] = [
    {
      key: 'name',
      label: 'Name',
      render: row => (
        <span className="font-semibold text-slate-800">{row.name}</span>
      ),
    },
    {
      key: 'channel',
      label: 'Channel',
      render: row => <ChannelBadge channel={row.channel} />,
    },
    {
      key: 'category',
      label: 'Category',
      render: row => row.category
        ? <span className="text-slate-600 text-[12px]">{row.category}</span>
        : <span className="text-slate-300">—</span>,
    },
    {
      key: 'body_text',
      label: 'Preview',
      sortable: false,
      render: row => (
        <span className="text-[12px] text-slate-500 truncate block max-w-[280px]">
          {row.body_text?.slice(0, 80)}{(row.body_text?.length ?? 0) > 80 ? '…' : ''}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: row => (
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={() => { setEditing(row); setModal(true) }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors text-slate-600 hover:bg-slate-100"
          >
            <span className="material-symbols-rounded text-[13px]">edit</span>
            Edit
          </button>
          <button
            onClick={() => setDeleteId(row.id)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors text-red-600 hover:bg-red-50"
          >
            <span className="material-symbols-rounded text-[13px]">delete</span>
            Delete
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page
      dept="Customer Service"
      title="Canned Responses"
      subtitle="Pre-written replies for common queries"
      actions={
        <button
          onClick={() => { setEditing(null); setModal(true) }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}
        >
          <span className="material-symbols-rounded text-[16px]">add</span>
          New Canned Response
        </button>
      }
    >
      <ErrBanner msg={err} />
      <SectionCard title="All Responses" badge={rows.length}>
        {loading ? (
          <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
        ) : (
          <DataTable
            cols={cols}
            rows={rows}
            loading={false}
            emptyIcon="quickreply"
            emptyMsg="No canned responses yet"
          />
        )}
      </SectionCard>

      {/* Create / Edit modal */}
      {modalOpen && (
        <CannedModal
          initial={editing}
          onClose={() => { setModal(false); setEditing(null) }}
          onSaved={() => { setModal(false); setEditing(null); load() }}
        />
      )}

      {/* Delete confirm */}
      {deleteId !== null && (
        <DeleteConfirm
          onCancel={() => setDeleteId(null)}
          onConfirm={() => handleDelete(deleteId)}
          loading={deleting}
        />
      )}
    </Page>
  )
}

// ── Channel badge ──────────────────────────────────────────────────────────────
function ChannelBadge({ channel }: { channel: string }) {
  const map: Record<string, { label: string; bg: string; color: string }> = {
    email: { label: 'Email', bg: 'rgba(37,99,235,0.1)',  color: '#2563EB' },
    sms:   { label: 'SMS',   bg: 'rgba(217,119,6,0.1)',  color: '#D97706' },
    both:  { label: 'Both',  bg: 'rgba(14,40,65,0.08)', color: '#475569' },
  }
  const s = map[channel?.toLowerCase()] ?? { label: channel, bg: 'rgba(14,40,65,0.06)', color: '#475569' }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

// ── Create / Edit modal ────────────────────────────────────────────────────────
function CannedModal({
  initial, onClose, onSaved,
}: {
  initial: CannedResponse | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial

  const [name, setName]         = useState(initial?.name ?? '')
  const [channel, setChannel]   = useState(initial?.channel ?? 'email')
  const [category, setCategory] = useState(initial?.category ?? '')
  const [subject, setSubject]   = useState(initial?.subject ?? '')
  const [bodyText, setBodyText] = useState(initial?.body_text ?? '')
  const [bodyHtml, setBodyHtml] = useState(initial?.body_html ?? '')
  const [autoHtml, setAutoHtml] = useState(!initial?.body_html)

  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState('')

  // Auto-generate HTML from plain text
  const derivedHtml = bodyText.split('\n').map(l => `<p>${l || '&nbsp;'}</p>`).join('')

  async function handleSave() {
    if (!name.trim())     { setErr('Name is required'); return }
    if (!bodyText.trim()) { setErr('Body text is required'); return }
    setSaving(true); setErr('')
    const payload = {
      name: name.trim(),
      channel,
      category: category.trim(),
      subject: subject.trim() || undefined,
      body_text: bodyText.trim(),
      body_html: autoHtml ? derivedHtml : (bodyHtml.trim() || undefined),
    }
    try {
      if (isEdit) {
        await apiFetch(`/api/helpdesk/canned-responses/${initial!.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        })
      } else {
        await apiFetch('/api/helpdesk/canned-responses', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      }
      onSaved()
    } catch (e: any) {
      setErr(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[290] bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden flex flex-col"
          style={{ maxWidth: 540, maxHeight: '90vh' }}>
          <div className="flex items-center justify-between px-6 py-4"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.09)' }}>
            <h2 className="text-[16px] font-bold text-slate-900">
              {isEdit ? 'Edit Canned Response' : 'New Canned Response'}
            </h2>
            <button onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
              <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            <ErrBanner msg={err} />

            <ModalField label="Name *">
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. Card Activation Instructions"
                style={inputStyle} />
            </ModalField>

            <div className="grid grid-cols-2 gap-3">
              <ModalField label="Channel">
                <select value={channel} onChange={e => setChannel(e.target.value)} style={inputStyle}>
                  {CHANNEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </ModalField>
              <ModalField label="Category">
                <input value={category} onChange={e => setCategory(e.target.value)}
                  placeholder="e.g. Card Issues"
                  style={inputStyle} />
              </ModalField>
            </div>

            {(channel === 'email' || channel === 'both') && (
              <ModalField label="Subject (email only)">
                <input value={subject} onChange={e => setSubject(e.target.value)}
                  placeholder="Email subject line"
                  style={inputStyle} />
              </ModalField>
            )}

            <ModalField label="Body (plain text) *">
              <textarea
                value={bodyText}
                onChange={e => setBodyText(e.target.value)}
                placeholder="Plain text body…"
                rows={6}
                className="resize-y"
                style={{ ...inputStyle, display: 'block', width: '100%' }}
              />
            </ModalField>

            <div>
              <label className="flex items-center gap-2.5 cursor-pointer select-none mb-3">
                <input
                  type="checkbox"
                  checked={autoHtml}
                  onChange={e => setAutoHtml(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-[13px] text-slate-600">Auto-generate HTML from plain text</span>
              </label>

              {!autoHtml && (
                <ModalField label="Body (HTML)">
                  <textarea
                    value={bodyHtml}
                    onChange={e => setBodyHtml(e.target.value)}
                    placeholder="<p>Custom HTML…</p>"
                    rows={5}
                    className="resize-y font-mono text-[12px]"
                    style={{ ...inputStyle, display: 'block', width: '100%' }}
                  />
                </ModalField>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 px-6 py-4"
            style={{ borderTop: '1px solid rgba(15,23,42,0.09)' }}>
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-600 hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-50"
              style={{ background: NAVY }}>
              {saving ? <Spinner size={14} /> : <span className="material-symbols-rounded text-[15px]">save</span>}
              {isEdit ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Delete confirm ─────────────────────────────────────────────────────────────
function DeleteConfirm({
  onCancel, onConfirm, loading,
}: {
  onCancel: () => void
  onConfirm: () => void
  loading: boolean
}) {
  return (
    <>
      <div className="fixed inset-0 z-[390] bg-black/30 backdrop-blur-[2px]" onClick={onCancel} />
      <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-6 w-full" style={{ maxWidth: 360 }}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(192,0,0,0.08)' }}>
              <span className="material-symbols-rounded text-red-600">delete</span>
            </div>
            <div>
              <p className="font-semibold text-slate-800">Delete Canned Response</p>
              <p className="text-[12px] text-slate-400 mt-0.5">This cannot be undone.</p>
            </div>
          </div>
          <div className="flex gap-3 justify-end">
            <button onClick={onCancel}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-600 hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button onClick={onConfirm} disabled={loading}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-50"
              style={{ background: '#C00000' }}>
              {loading ? <Spinner size={14} /> : null}
              Delete
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid rgba(15,23,42,0.15)',
  fontSize: 13,
  color: '#334155',
  background: 'white',
  outline: 'none',
  boxSizing: 'border-box',
}

function ModalField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}
