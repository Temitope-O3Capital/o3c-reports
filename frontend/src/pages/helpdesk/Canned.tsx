import { useState, useEffect, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, Modal, ConfirmModal, Spinner, DateFilter, NameCell, ActionRow } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
import { NAVY, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
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


// ── Canned form ────────────────────────────────────────────────────────────────

interface FormState {
  title: string
  category: string
  body: string
}

function CannedForm({ form, onChange }: { form: FormState; onChange: (f: FormState) => void }) {
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Title</label>
        <input
          value={form.title}
          onChange={e => onChange({ ...form, title: e.target.value })}
          placeholder="Response title…"
          style={inputStyle}
        />
      </div>
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Category</label>
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
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Body</label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [search,       setSearch]       = useState('')
  const [fCategories,  setFCategories]  = useState(new Set<string>())

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
      const params = new URLSearchParams()
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo)   params.set('to', dateTo)
      const data = await apiFetch<CannedResponse[]>(`/api/helpdesk/canned-responses?${params}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

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

  const displayed = useMemo(() => rows.filter(r => {
    if (fCategories.size && !fCategories.has(r.category)) return false
    if (search) {
      const q = search.toLowerCase()
      return r.title.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) || r.created_by.toLowerCase().includes(q)
    }
    return true
  }), [rows, fCategories, search])

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
      label: 'Title / Category',
      render: r => <NameCell name={r.title} sub={r.category} avatar={false} />,
    },
    {
      key: 'last_used_at',
      label: 'Last Used',
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          {r.last_used_at ? fmtDate(r.last_used_at) : 'Never'}
        </span>
      ),
    },
    {
      key: 'created_by',
      label: 'Created By',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{r.created_by}</span>,
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      width: 96,
      render: r => (
        <ActionRow actions={[
          { icon: 'preview', label: 'Preview', onClick: () => setPreviewItem(r) },
          { icon: 'edit', label: 'Edit', onClick: () => openEdit(r) },
          { icon: 'delete', label: 'Delete', onClick: () => setDeleteItem(r), danger: true },
        ]} />
      ),
    },
  ]

  const modalFooter = (onSave: () => void) => (
    <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
      <button
        onClick={() => { setNewOpen(false); setEditItem(null) }}
        style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving}
        style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', opacity: saving ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: SP[2] }}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={openNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
            New Response
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard padding={false} badge={displayed.length} actions={<button onClick={() => exportCannedCsv(displayed)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'category',
              label: 'Category',
              options: CATEGORIES.map(c => ({ value: c })),
              selected: fCategories,
              onChange: setFCategories,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFCategories(new Set()) }}
          resultCount={displayed.length}
          totalCount={rows.length}
          placeholder="Search responses…"
        />
        <DataTable<CannedResponse>
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No canned responses yet"
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
            <div style={{ marginBottom: SP[3] }}>
              <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap' }}>
                {previewItem.category}
              </span>
            </div>
            <div style={{
              whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: TEXT.base,
              color: 'var(--txt)', padding: '12px 14px',
              background: 'var(--th-bg)', borderRadius: RADIUS.md,
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
