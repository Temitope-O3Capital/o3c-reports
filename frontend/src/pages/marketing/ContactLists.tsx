import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtNum } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef, ErrBanner, NAVY,
} from '../../components/UI'
import { toast } from 'sonner'

interface ContactList {
  id: number
  name: string
  description: string
  member_count: number
  created_at: string
  updated_at: string
}

interface ListMember {
  id: number
  list_id: number
  cif_number: string
  first_name?: string
  last_name?: string
  name?: string
  phone?: string
  email?: string
  merge_data?: Record<string, any>
  created_at?: string
  added_at: string
}

interface ListForm {
  name: string
  description: string
}

interface MemberForm {
  first_name: string
  last_name: string
  email: string
  phone: string
  cif_number: string
}

const EMPTY_FORM: ListForm = { name: '', description: '' }
const EMPTY_MEMBER: MemberForm = { first_name: '', last_name: '', email: '', phone: '', cif_number: '' }

function memberName(member: ListMember) {
  return member.name || [member.first_name, member.last_name].filter(Boolean).join(' ').trim()
}

/* ── Shared modal ──────────────────────────────────────────────────── */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-[var(--card)] rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--bdr)' }}>
          <h3 className="text-[15px] font-semibold text-[color:var(--txt)]">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--chip-bg)]">
            <span className="material-symbols-rounded text-[20px] text-[color:var(--txt2)]">close</span>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  )
}

/* ── Field wrapper ─────────────────────────────────────────────────── */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-semibold text-[color:var(--txt2)] mb-1.5">{label}</label>
      {children}
    </div>
  )
}

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-[var(--input-bdr)] transition-colors'
const INPUT_STYLE = { borderColor: 'var(--bdr)' }

/* ── Members drawer ────────────────────────────────────────────────── */
function MembersDrawer({
  list,
  onClose,
}: {
  list: ContactList
  onClose: () => void
}) {
  const [members, setMembers]       = useState<ListMember[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')
  const [memberForm, setMemberForm] = useState<MemberForm>(EMPTY_MEMBER)
  const [adding, setAdding]         = useState(false)
  const [uploading, setUploading]   = useState(false)
  const fileRef                     = useRef<HTMLInputElement>(null)

  const loadMembers = useCallback(async () => {
    setLoading(true); setError('')
    try {
      // GET /{id} returns { ...list, members: [...] } — there is no separate /members endpoint.
      const res = await apiFetch(`/api/contact-lists/${list.id}`)
      const data = res.data ?? res
      setMembers(Array.isArray(data?.members) ? data.members : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [list.id])

  useEffect(() => { loadMembers() }, [loadMembers])

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault()
    if (!memberForm.email.trim() && !memberForm.phone.trim()) {
      toast.error('Add at least an email or phone number')
      return
    }
    setAdding(true)
    try {
      await apiFetch(`/api/contact-lists/${list.id}/members`, {
        method: 'POST',
        body: JSON.stringify({
          first_name: memberForm.first_name.trim() || undefined,
          last_name: memberForm.last_name.trim() || undefined,
          email: memberForm.email.trim() || undefined,
          phone: memberForm.phone.trim() || undefined,
          cif_number: memberForm.cif_number.trim() || undefined,
        }),
      })
      toast.success('Member added')
      setMemberForm(EMPTY_MEMBER)
      loadMembers()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleRemoveMember(mid: number) {
    try {
      await apiFetch(`/api/contact-lists/${list.id}/members/${mid}`, { method: 'DELETE' })
      toast.success('Member removed')
      loadMembers()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const token = localStorage.getItem('o3c_token')
      const API   = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const res   = await fetch(`${API}/api/contact-lists/${list.id}/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).detail || `Upload failed (${res.status})`)
      }
      const data = await res.json()
      toast.success(`Uploaded — ${data.inserted ?? data.imported ?? '?'} members added`)
      loadMembers()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const cols: ColDef<ListMember>[] = [
    { key: 'name',       label: 'Name',    render: r => memberName(r) || '—' },
    { key: 'email',      label: 'Email',   render: r => r.email ?? '—' },
    { key: 'phone',      label: 'Phone',   render: r => r.phone ?? '—' },
    { key: 'cif_number', label: 'CIF',     render: r => r.cif_number || '—' },
    { key: 'added_at',   label: 'Added',   render: r => fmtDate((r as any).created_at ?? r.added_at) },
    {
      key: '_remove',
      label: '',
      sortable: false,
      render: r => (
        <button
          onClick={() => handleRemoveMember(r.id)}
          title="Remove member"
          className="p-1 rounded transition-colors hover:bg-red-50"
          style={{ color: '#C00000' }}
        >
          <span className="material-symbols-rounded text-[15px]">person_remove</span>
        </button>
      ),
    },
  ]

  return (
    <div className="fixed inset-0 z-40" onClick={onClose} style={{ background: 'rgba(0,0,0,0.3)' }}>
      <div
        className="absolute right-0 top-0 h-full bg-[var(--card)] shadow-2xl overflow-y-auto flex flex-col"
        style={{ width: 'min(920px, 100vw)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drawer header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0"
          style={{ borderColor: 'var(--bdr)' }}
        >
          <div>
            <h3 className="text-[15px] font-semibold text-[color:var(--txt)]">{list.name}</h3>
            <p className="text-[12px] text-[color:var(--txt2)] mt-0.5">
              {fmtNum(list.member_count)} members
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--chip-bg)]">
            <span className="material-symbols-rounded text-[20px] text-[color:var(--txt2)]">close</span>
          </button>
        </div>

        {/* Toolbar */}
        <div
          className="px-6 py-4 border-b flex-shrink-0"
          style={{ borderColor: 'rgba(15,23,42,0.07)' }}
        >
          <form onSubmit={handleAddMember} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              {([
                ['first_name', 'First name'],
                ['last_name', 'Last name'],
                ['email', 'Email'],
                ['phone', 'Phone'],
                ['cif_number', 'CIF optional'],
              ] as const).map(([key, placeholder]) => (
                <input
                  key={key}
                  value={memberForm[key]}
                  onChange={e => setMemberForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  type={key === 'email' ? 'email' : 'text'}
                  className="px-3 py-1.5 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'var(--bdr)' }}
                />
              ))}
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <p className="text-[11px] text-[color:var(--txt2)]">Email or phone is required. CIF is optional for prospects.</p>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={adding || (!memberForm.email.trim() && !memberForm.phone.trim())}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-60"
                  style={{ background: NAVY }}
                >
                  <span className="material-symbols-rounded text-[14px]">person_add</span>
                  {adding ? 'Adding…' : 'Add Contact'}
                </button>

                {/* Hidden file input */}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleUpload}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors hover:bg-[var(--bg)] disabled:opacity-60"
                  style={{ borderColor: 'var(--bdr)', color: 'var(--txt)' }}
                >
                  <span className="material-symbols-rounded text-[14px]">upload_file</span>
                  {uploading ? 'Uploading…' : 'Upload CSV'}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Error */}
        {error && (
          <div className="px-6 pt-3">
            <ErrBanner msg={error} />
          </div>
        )}

        {/* Members table */}
        <div className="flex-1 overflow-y-auto">
          <DataTable
            cols={cols}
            rows={members}
            loading={loading}
            emptyIcon="group"
            emptyMsg="No members yet — add one or upload a CSV"
          />
        </div>
      </div>
    </div>
  )
}

/* ── Main page ─────────────────────────────────────────────────────── */
export default function ContactLists() {
  const [lists, setLists]   = useState<ContactList[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null)
  const [editing, setEditing]     = useState<ContactList | null>(null)
  const [form, setForm]           = useState<ListForm>(EMPTY_FORM)
  const [saving, setSaving]       = useState(false)

  const [confirmDelete, setConfirmDelete] = useState<ContactList | null>(null)
  const [deleting, setDeleting]           = useState(false)

  const [drawerList, setDrawerList] = useState<ContactList | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch('/api/contact-lists')
      setLists(res.data ?? res ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openCreate() {
    setForm(EMPTY_FORM)
    setEditing(null)
    setModalMode('create')
  }

  function openEdit(list: ContactList) {
    setForm({ name: list.name, description: list.description })
    setEditing(list)
    setModalMode('edit')
  }

  function closeModal() {
    setModalMode(null)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      if (modalMode === 'create') {
        await apiFetch('/api/contact-lists', {
          method: 'POST',
          body: JSON.stringify(form),
        })
        toast.success('List created')
      } else if (editing) {
        await apiFetch(`/api/contact-lists/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(form),
        })
        toast.success('List updated')
      }
      closeModal()
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await apiFetch(`/api/contact-lists/${confirmDelete.id}`, { method: 'DELETE' })
      toast.success('List deleted')
      setConfirmDelete(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setDeleting(false)
    }
  }

  const cols: ColDef<ContactList>[] = [
    { key: 'name',         label: 'Name',        render: r => (
      <span className="font-medium text-[color:var(--txt)]">{r.name}</span>
    )},
    { key: 'description',  label: 'Description', render: r => (
      <span className="text-[color:var(--txt2)]">{r.description || '—'}</span>
    )},
    { key: 'member_count', label: 'Members', right: true, render: r => (
      <span
        className="inline-flex items-center gap-1 text-[12px] font-semibold px-2 py-0.5 rounded-full"
        style={{ background: 'var(--chip-bg)', color: 'var(--txt)' }}
      >
        <span className="material-symbols-rounded text-[12px]">group</span>
        {fmtNum(r.member_count)}
      </span>
    )},
    { key: 'created_at', label: 'Created', render: r => fmtDate(r.created_at) },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: r => (
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDrawerList(r)}
            title="View members"
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-medium border transition-colors hover:bg-[var(--bg)]"
            style={{ borderColor: 'var(--bdr)', color: 'var(--txt)' }}
          >
            <span className="material-symbols-rounded text-[13px]">group</span>
            View Members
          </button>
          <button
            onClick={() => openEdit(r)}
            title="Edit list"
            className="p-1.5 rounded-lg transition-colors hover:bg-[var(--chip-bg)]"
            style={{ color: 'var(--txt2)' }}
          >
            <span className="material-symbols-rounded text-[15px]">edit</span>
          </button>
          <button
            onClick={() => setConfirmDelete(r)}
            title="Delete list"
            className="p-1.5 rounded-lg transition-colors hover:bg-red-50"
            style={{ color: '#C00000' }}
          >
            <span className="material-symbols-rounded text-[15px]">delete</span>
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page
      dept="Marketing"
      title="Contact Lists"
      subtitle="Manage segmented customer lists for targeted campaigns"
      actions={
        <button
          onClick={openCreate}
          style={{ background: NAVY }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
        >
          <span className="material-symbols-rounded text-[15px]">add</span>
          New List
        </button>
      }
    >
      <ErrBanner msg={error} />

      <SectionCard title="Contact Lists" badge={lists.length}>
        <DataTable
          cols={cols}
          rows={lists}
          loading={loading}
          emptyIcon="groups"
          emptyMsg="No contact lists yet"
        />
      </SectionCard>

      {/* Create / Edit modal */}
      {modalMode && (
        <Modal
          title={modalMode === 'create' ? 'New Contact List' : 'Edit Contact List'}
          onClose={closeModal}
        >
          <form onSubmit={handleSave} className="space-y-4">
            <Field label="Name">
              <input
                required
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Overdue Borrowers Q2"
                className={INPUT_CLS}
                style={INPUT_STYLE}
              />
            </Field>

            <Field label="Description">
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What is this list for?"
                rows={3}
                className={`${INPUT_CLS} resize-none`}
                style={INPUT_STYLE}
              />
            </Field>

            <button
              type="submit"
              disabled={saving}
              className="w-full py-2.5 text-[13px] font-semibold text-white rounded-lg disabled:opacity-60 transition-opacity"
              style={{ background: NAVY }}
            >
              {saving
                ? modalMode === 'create' ? 'Creating…' : 'Saving…'
                : modalMode === 'create' ? 'Create List' : 'Save Changes'}
            </button>
          </form>
        </Modal>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <Modal title="Delete Contact List" onClose={() => setConfirmDelete(null)}>
          <p className="text-[13px] text-[color:var(--txt2)] mb-5">
            Are you sure you want to delete <strong>{confirmDelete.name}</strong>?
            All {fmtNum(confirmDelete.member_count)} members will be removed. This cannot be undone.
          </p>
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => setConfirmDelete(null)}
              className="px-4 py-2 rounded-lg text-[13px] font-medium border transition-colors hover:bg-[var(--bg)]"
              style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)' }}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: '#0E2841' }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Modal>
      )}

      {/* Members drawer */}
      {drawerList && (
        <MembersDrawer
          list={drawerList}
          onClose={() => { setDrawerList(null); load() }}
        />
      )}
    </Page>
  )
}
