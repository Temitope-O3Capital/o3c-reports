import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Modal, ConfirmModal, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, NUM, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CannedResponse {
  id: number
  title: string      // aliased from name in backend
  category: string
  body: string       // aliased from body_text in backend
  last_used_at: string | null
  created_by: string // joined from o3c_users in backend
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ['Account', 'Loans', 'Cards', 'Transfers', 'App', 'General']

// ── Category pill ──────────────────────────────────────────────────────────────

function CatPill({ cat }: { cat: string }) {
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap',
    }}>
      {cat}
    </span>
  )
}

// ── Row action button ──────────────────────────────────────────────────────────

function RowBtn({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      title={label}
      style={{
        width: 28, height: 28, borderRadius: 7, border: '1.5px solid var(--input-bdr)',
        background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color: 'var(--txt2)',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--txt2)'; (e.currentTarget as HTMLElement).style.color = 'var(--txt)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--input-bdr)'; (e.currentTarget as HTMLElement).style.color = 'var(--txt2)' }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span>
    </button>
  )
}

// ── Canned form ────────────────────────────────────────────────────────────────

interface FormState {
  title: string
  category: string
  body: string
}

function CannedForm({ form, onChange }: { form: FormState; onChange: (f: FormState) => void }) {
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)',
    borderRadius: 7, fontSize: 13, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Title</label>
        <input
          value={form.title}
          onChange={e => onChange({ ...form, title: e.target.value })}
          placeholder="Response title…"
          style={inputStyle}
        />
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Category</label>
        <select
          value={form.category}
          onChange={e => onChange({ ...form, category: e.target.value })}
          style={{ ...inputStyle, height: 36, padding: '0 10px' }}
        >
          <option value="">— Select —</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Body</label>
        <textarea
          value={form.body}
          onChange={e => onChange({ ...form, body: e.target.value })}
          rows={8}
          placeholder="Canned response text…"
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
        />
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const EMPTY_FORM: FormState = { title: '', category: '', body: '' }

export default function Canned() {
  const [rows, setRows] = useState<CannedResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Modals
  const [newOpen, setNewOpen] = useState(false)
  const [editItem, setEditItem] = useState<CannedResponse | null>(null)
  const [previewItem, setPreviewItem] = useState<CannedResponse | null>(null)
  const [deleteItem, setDeleteItem] = useState<CannedResponse | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<CannedResponse[]>('/api/helpdesk/canned-responses')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openNew() {
    setForm(EMPTY_FORM)
    setNewOpen(true)
  }

  function openEdit(r: CannedResponse) {
    setEditItem(r)
    setForm({ title: r.title, category: r.category, body: r.body })
  }

  async function handleCreate() {
    if (!form.title || !form.category || !form.body) {
      toast.error('Please fill in all fields')
      return
    }
    setSaving(true)
    try {
      await apiPost('/api/helpdesk/canned-responses', { name: form.title, category: form.category, body_text: form.body, channel: 'both' })
      toast.success('Canned response created')
      setNewOpen(false)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdate() {
    if (!editItem) return
    if (!form.title || !form.category || !form.body) {
      toast.error('Please fill in all fields')
      return
    }
    setSaving(true)
    try {
      await apiPut(`/api/helpdesk/canned-responses/${editItem.id}`, { name: form.title, category: form.category, body_text: form.body })
      toast.success('Canned response updated')
      setEditItem(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteItem) return
    setDeleting(true)
    try {
      await apiDelete(`/api/helpdesk/canned-responses/${deleteItem.id}`)
      toast.success('Deleted')
      setDeleteItem(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setDeleting(false)
    }
  }

  function exportCannedCsv(data: CannedResponse[]) {
    const header = ['Title', 'Category', 'Created By', 'Last Used']
    const lines = data.map(r => [
      `"${String(r.title ?? '').replace(/"/g, '""')}"`,
      r.category ?? '',
      `"${String(r.created_by ?? '').replace(/"/g, '""')}"`,
      r.last_used_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `canned-responses-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols: TableCol<CannedResponse>[] = [
    {
      key: 'title',
      label: 'Title',
      render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.title}</span>,
    },
    {
      key: 'category',
      label: 'Category',
      render: r => <CatPill cat={r.category} />,
    },
    {
      key: 'last_used_at',
      label: 'Last Used',
      render: r => (
        <span style={{ fontSize: 12, color: 'var(--txt2)' }}>
          {r.last_used_at ? fmtDate(r.last_used_at) : 'Never'}
        </span>
      ),
    },
    {
      key: 'created_by',
      label: 'Created By',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)', fontFamily: INTER }}>{r.created_by}</span>,
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      width: 110,
      render: r => (
        <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
          <RowBtn icon="preview" label="Preview" onClick={() => setPreviewItem(r)} />
          <RowBtn icon="edit" label="Edit" onClick={() => openEdit(r)} />
          <RowBtn icon="delete" label="Delete" onClick={() => setDeleteItem(r)} />
        </div>
      ),
    },
  ]

  const modalFooter = (onSave: () => void) => (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button
        onClick={() => { setNewOpen(false); setEditItem(null) }}
        style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving}
        style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 8 }}
      >
        {saving && <Spinner size={14} color="#fff" />}
        Save
      </button>
    </div>
  )

  return (
    <Page
      title="Canned Responses"
      subtitle="Saved replies for common queries"
      actions={
        <button onClick={openNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Response
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard padding={false} badge={rows.length} actions={<button onClick={() => exportCannedCsv(rows)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <DataTable<CannedResponse>
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No canned responses yet"
          searchKeys={['title', 'category', 'created_by']}
          searchPlaceholder="Search responses…"
          pageSize={20}

        />
      </SectionCard>

      {/* New modal */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Canned Response"
        width={540}
        footer={modalFooter(handleCreate)}
      >
        <CannedForm form={form} onChange={setForm} />
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editItem}
        onClose={() => setEditItem(null)}
        title="Edit Canned Response"
        width={540}
        footer={modalFooter(handleUpdate)}
      >
        <CannedForm form={form} onChange={setForm} />
      </Modal>

      {/* Preview modal */}
      <Modal
        open={!!previewItem}
        onClose={() => setPreviewItem(null)}
        title={previewItem?.title ?? 'Preview'}
        width={500}
      >
        {previewItem && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <CatPill cat={previewItem.category} />
            </div>
            <div style={{
              whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 13,
              color: 'var(--txt)', padding: '12px 14px',
              background: 'var(--th-bg)', borderRadius: 8,
            }}>
              {previewItem.body || <span style={{ color: 'var(--txt3)', fontStyle: 'italic' }}>No content.</span>}
            </div>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <ConfirmModal
        open={!!deleteItem}
        title="Delete canned response?"
        body={`"${deleteItem?.title}" will be permanently deleted and cannot be recovered.`}
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteItem(null)}
      />
    </Page>
  )
}
