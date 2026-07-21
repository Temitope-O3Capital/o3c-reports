import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Page, SectionCard, DataTable, Modal, ConfirmModal,
  ErrBanner, btnPrimary, btnSecondary, Spinner, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete, API, getCsrfToken } from '../../lib/api'
import { fmtNum, fmtDatetime, monthStart, today } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, SORA, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { filterInputStyle } from '../../components/UI'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContactList {
  id: number
  name: string
  description?: string
  member_count?: number
  created_at: string
  created_by_name?: string
}

interface Member {
  id: number
  cif_number?: string
  first_name?: string
  last_name?: string
  phone?: string
  email?: string
  added_at?: string
  created_at?: string
}

interface PreflightResult {
  total: number
  valid: number
  invalid: number
  errors?: string[]
}

// ── Shared input style ────────────────────────────────────────────────────────

const lbl: React.CSSProperties = {
  fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)',
  display: 'block', marginBottom: 5, fontFamily: INTER,
}
const inp = (w = '100%'): React.CSSProperties => ({
  ...filterInputStyle, width: w, boxSizing: 'border-box' as const,
})

// ── Empty contact form ────────────────────────────────────────────────────────

const emptyForm = () => ({ firstName: '', lastName: '', phone: '', email: '', cifNumber: '' })

// ── Member Drawer ──────────────────────────────────────────────────────────────

function MemberDrawer({ list, onClose, canWrite }: { list: ContactList; onClose: () => void; canWrite: boolean }) {
  const [members,      setMembers]      = useState<Member[]>([])
  const [loading,      setLoading]      = useState(true)
  const [err,          setErr]          = useState<string | null>(null)
  const [form,         setForm]         = useState(emptyForm())
  const [adding,       setAdding]       = useState(false)
  const [addErr,       setAddErr]       = useState<string | null>(null)
  const [editTarget,   setEditTarget]   = useState<Member | null>(null)
  const [editForm,     setEditForm]     = useState(emptyForm())
  const [editSaving,   setEditSaving]   = useState(false)
  const [editErr,      setEditErr]      = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)
  const [csvFile,      setCsvFile]      = useState<File | null>(null)
  const [preflight,    setPreflight]    = useState<PreflightResult | null>(null)
  const [uploading,    setUploading]    = useState(false)
  const [showCsvModal, setShowCsvModal] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadMembers = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<{ data: Member[] } | Member[]>(`/api/contact-lists/${list.id}/members?limit=500`)
      const arr = Array.isArray(res) ? res : ((res as any)?.data ?? [])
      setMembers(Array.isArray(arr) ? arr : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [list.id])

  useEffect(() => { loadMembers() }, [loadMembers])

  function memberName(m: Member) {
    return [m.first_name, m.last_name].filter(Boolean).join(' ') || m.cif_number || '—'
  }

  // ── Add contact ──────────────────────────────────────────────────────────────

  async function addContact() {
    const payload: Record<string, string> = {}
    if (form.firstName.trim()) payload.first_name = form.firstName.trim()
    if (form.lastName.trim())  payload.last_name  = form.lastName.trim()
    if (form.phone.trim())     payload.phone      = form.phone.trim()
    if (form.email.trim())     payload.email      = form.email.trim()
    if (form.cifNumber.trim()) payload.cif_number = form.cifNumber.trim()
    if (Object.keys(payload).length === 0) {
      setAddErr('Please fill in at least one field.')
      return
    }
    setAdding(true); setAddErr(null)
    try {
      await apiPost(`/api/contact-lists/${list.id}/members`, payload)
      setForm(emptyForm())
      toast.success('Contact added')
      loadMembers()
    } catch (ex: any) { setAddErr(ex.message ?? 'Failed to add contact') }
    finally { setAdding(false) }
  }

  // ── Edit contact ─────────────────────────────────────────────────────────────

  function openEdit(m: Member) {
    setEditTarget(m)
    setEditForm({
      firstName: m.first_name ?? '',
      lastName:  m.last_name  ?? '',
      phone:     m.phone      ?? '',
      email:     m.email      ?? '',
      cifNumber: m.cif_number ?? '',
    })
    setEditErr(null)
  }

  async function saveEdit() {
    if (!editTarget) return
    const payload: Record<string, string | null> = {
      first_name: editForm.firstName.trim() || null,
      last_name:  editForm.lastName.trim()  || null,
      phone:      editForm.phone.trim()     || null,
      email:      editForm.email.trim()     || null,
      cif_number: editForm.cifNumber.trim() || null,
    }
    setEditSaving(true); setEditErr(null)
    try {
      await apiPut(`/api/contact-lists/${list.id}/members/${editTarget.id}`, payload)
      setEditTarget(null)
      toast.success('Contact updated')
      loadMembers()
    } catch (ex: any) { setEditErr(ex.message ?? 'Failed to update contact') }
    finally { setEditSaving(false) }
  }

  // ── Remove contact ────────────────────────────────────────────────────────────

  async function removeMember() {
    if (!removeTarget) return
    try {
      await apiDelete(`/api/contact-lists/${list.id}/members/${removeTarget.id}`)
      setRemoveTarget(null)
      toast.success('Contact removed')
      loadMembers()
    } catch (ex: any) { toast.error(ex.message ?? 'Failed to remove') }
  }

  // ── CSV ───────────────────────────────────────────────────────────────────────

  async function postMultipart<T>(endpoint: string, file: File): Promise<T> {
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`${API}${endpoint}`, {
      method: 'POST', credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrfToken() },
      body: fd,
    })
    if (!res.ok) {
      const msg = await res.json().catch(() => ({}))
      throw new Error((msg as any)?.error ?? `HTTP ${res.status}`)
    }
    return res.json()
  }

  async function pickCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvFile(file); setPreflight(null)
    try {
      const res = await postMultipart<PreflightResult>(`/api/contact-lists/${list.id}/preflight`, file)
      setPreflight(res); setShowCsvModal(true)
    } catch (ex: any) { toast.error(ex.message ?? 'Preflight failed') }
    if (fileRef.current) fileRef.current.value = ''
  }

  async function uploadCsv() {
    if (!csvFile) return
    setUploading(true)
    try {
      await postMultipart(`/api/contact-lists/${list.id}/upload`, csvFile)
      setShowCsvModal(false); setCsvFile(null); setPreflight(null)
      toast.success('CSV imported')
      loadMembers()
    } catch (ex: any) { toast.error(ex.message ?? 'Upload failed') }
    finally { setUploading(false) }
  }

  // ── Table columns ─────────────────────────────────────────────────────────────

  const memberCols: TableCol<Member>[] = [
    {
      key: 'first_name', label: 'Name',
      render: m => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{memberName(m)}</div>
          {m.cif_number && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'monospace' }}>{m.cif_number}</div>}
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: m => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{m.phone ?? '—'}</span> },
    { key: 'email', label: 'Email', render: m => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{m.email ?? '—'}</span> },
    {
      key: 'created_at', label: 'Added',
      render: m => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(m.added_at ?? m.created_at ?? '')}</span>,
    },
    ...(canWrite ? [{
      key: 'id', label: '', align: 'right' as const,
      render: (m: Member) => (
        <div style={{ display: 'flex', gap: 5 }}>
          <button
            onClick={() => openEdit(m)}
            style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '2px 9px' }}
          >
            Edit
          </button>
          <button
            onClick={() => setRemoveTarget(m)}
            style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '2px 9px', color: RED, borderColor: `${RED}40` }}
          >
            Remove
          </button>
        </div>
      ),
    }] : []),
  ]

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 900 }} />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 580,
        background: 'var(--card)', zIndex: 901, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 32px rgba(0,0,0,.15)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 20px 16px', borderBottom: '1px solid var(--bdr)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA }}>{list.name}</div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>
              {fmtNum(members.length)} contact{members.length !== 1 ? 's' : ''}
              {list.description ? ` · ${list.description}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ ...btnSecondary, padding: '4px 10px', flexShrink: 0 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <ErrBanner error={err} onRetry={loadMembers} />

          {/* Add contact panel */}
          {canWrite && (
            <div style={{ background: 'var(--bg)', borderRadius: RADIUS.lg, padding: 16, border: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA, marginBottom: 12 }}>
                Add Contact
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>First Name</label>
                  <input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                    placeholder="First name" style={inp()} />
                </div>
                <div>
                  <label style={lbl}>Last Name</label>
                  <input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                    placeholder="Last name" style={inp()} />
                </div>
                <div>
                  <label style={lbl}>Phone</label>
                  <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="+234 800 000 0000" type="tel" style={inp()} />
                </div>
                <div>
                  <label style={lbl}>Email</label>
                  <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="prospect@email.com" type="email" style={inp()} />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>CIF Number <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional — for existing customers)</span></label>
                <input value={form.cifNumber} onChange={e => setForm(f => ({ ...f, cifNumber: e.target.value }))}
                  placeholder="Leave blank for prospects" style={inp()} />
              </div>
              {addErr && <div style={{ fontSize: TEXT.sm, color: RED, marginBottom: 8 }}>{addErr}</div>}
              <button onClick={addContact} disabled={adding} style={{ ...btnPrimary, width: '100%', justifyContent: 'center' }}>
                {adding ? <Spinner size={14} /> : <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>}
                {adding ? 'Adding…' : 'Add Contact'}
              </button>

              <div style={{ margin: '14px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 1, background: 'var(--bdr)' }} />
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', flexShrink: 0 }}>or import from CSV</span>
                <div style={{ flex: 1, height: 1, background: 'var(--bdr)' }} />
              </div>

              <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={pickCsvFile} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => fileRef.current?.click()}
                  style={{ ...btnSecondary, flex: 1, justifyContent: 'center', gap: 6, display: 'flex' }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>upload_file</span>
                  Upload CSV
                </button>
                <button
                  onClick={() => {
                    const csv = 'first_name,last_name,phone,email,cif_number\nJohn,Smith,+2348001234567,john@example.com,CIF001\nAisha,Bello,+2348091234567,aisha@example.com,\n'
                    const blob = new Blob([csv], { type: 'text/csv' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a'); a.href = url
                    a.download = 'contact-list-template.csv'
                    document.body.appendChild(a); a.click(); a.remove()
                    URL.revokeObjectURL(url)
                  }}
                  style={{ ...btnSecondary, justifyContent: 'center', gap: 5, display: 'flex', padding: '7px 11px' }}
                  title="Download CSV template"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
                  Template
                </button>
              </div>
              <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 5, textAlign: 'center' }}>
                Columns: <code>first_name, last_name, phone, email, cif_number</code> — at least one required per row.
              </p>
            </div>
          )}

          {/* Members table */}
          <div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: SORA, marginBottom: 10 }}>
              Contacts ({fmtNum(members.length)})
            </div>
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
            ) : (
              <DataTable<Member>
                cols={memberCols}
                rows={members}
                keyFn={m => m.id}
                emptyText="No contacts yet. Add someone above."
                searchKeys={['first_name', 'last_name', 'phone', 'email', 'cif_number']}
                searchPlaceholder="Filter contacts…"
                pageSize={25}
              />
            )}
          </div>
        </div>
      </div>

      {/* CSV preflight modal */}
      <Modal
        open={showCsvModal}
        onClose={() => { setShowCsvModal(false); setCsvFile(null); setPreflight(null) }}
        title="CSV Import Preview"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowCsvModal(false); setCsvFile(null); setPreflight(null) }} style={btnSecondary}>Cancel</button>
            <button
              onClick={uploadCsv}
              disabled={uploading || !preflight || preflight.valid === 0}
              style={btnPrimary}
            >
              {uploading ? 'Importing…' : `Import ${fmtNum(preflight?.valid ?? 0)} Contacts`}
            </button>
          </div>
        }
      >
        {preflight && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              {[
                ['Total Rows', preflight.total,   '#6B7280'],
                ['Valid',      preflight.valid,   GREEN],
                ['Invalid',    preflight.invalid, preflight.invalid > 0 ? RED : '#6B7280'],
              ].map(([label, val, color]) => (
                <div key={String(label)} style={{ background: 'var(--bg)', borderRadius: RADIUS.md, padding: '12px 14px', textAlign: 'center' as const }}>
                  <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: String(color), fontFamily: SORA }}>
                    {fmtNum(Number(val))}
                  </div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>
            {preflight.errors && preflight.errors.length > 0 && (
              <div style={{ background: '#FFF1F1', borderRadius: RADIUS.md, padding: 12, border: `1px solid ${RED}30` }}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: RED, marginBottom: 6 }}>Issues found:</div>
                <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: TEXT.sm, color: '#7F1D1D', lineHeight: 1.7 }}>
                  {preflight.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
                  {preflight.errors.length > 8 && <li>…and {preflight.errors.length - 8} more</li>}
                </ul>
              </div>
            )}
            {preflight.valid === 0 && (
              <div style={{ color: RED, fontSize: TEXT.base, fontWeight: FW.medium }}>
                No valid rows to import. Check your CSV format.
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Edit member modal */}
      <Modal
        open={!!editTarget}
        onClose={() => { setEditTarget(null); setEditErr(null) }}
        title="Edit Contact"
        width={440}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setEditTarget(null); setEditErr(null) }} style={btnSecondary}>Cancel</button>
            <button onClick={saveEdit} disabled={editSaving} style={btnPrimary}>
              {editSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        }
      >
        {editErr && <div style={{ color: RED, fontSize: TEXT.sm, marginBottom: 10 }}>{editErr}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={lbl}>First Name</label>
              <input value={editForm.firstName} onChange={e => setEditForm(f => ({ ...f, firstName: e.target.value }))}
                placeholder="First name" style={inp()} />
            </div>
            <div>
              <label style={lbl}>Last Name</label>
              <input value={editForm.lastName} onChange={e => setEditForm(f => ({ ...f, lastName: e.target.value }))}
                placeholder="Last name" style={inp()} />
            </div>
          </div>
          <div>
            <label style={lbl}>Phone</label>
            <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))}
              placeholder="+234 800 000 0000" type="tel" style={inp()} />
          </div>
          <div>
            <label style={lbl}>Email</label>
            <input value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
              placeholder="contact@email.com" type="email" style={inp()} />
          </div>
          <div>
            <label style={lbl}>CIF Number <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <input value={editForm.cifNumber} onChange={e => setEditForm(f => ({ ...f, cifNumber: e.target.value }))}
              placeholder="Leave blank for prospects" style={inp()} />
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!removeTarget}
        title="Remove Contact"
        body={`Remove "${memberName(removeTarget ?? ({} as Member))}" from this list? They can be re-added later.`}
        onConfirm={removeMember}
        onClose={() => setRemoveTarget(null)}
        confirmLabel="Remove"
        danger
      />
    </>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

export default function ContactLists() {
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)
  const [lists,        setLists]        = useState<ContactList[]>([])
  const [loading,      setLoading]      = useState(true)
  const [err,          setErr]          = useState<string | null>(null)
  const [showCreate,   setShowCreate]   = useState(false)
  const [name,         setName]         = useState('')
  const [desc,         setDesc]         = useState('')
  const [saving,       setSaving]       = useState(false)
  const [saveErr,      setSaveErr]      = useState<string | null>(null)
  const [editTarget,   setEditTarget]   = useState<ContactList | null>(null)
  const [editName,     setEditName]     = useState('')
  const [editDesc,     setEditDesc]     = useState('')
  const [editSaving,   setEditSaving]   = useState(false)
  const [editErr,      setEditErr]      = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ContactList | null>(null)
  const [openList,     setOpenList]     = useState<ContactList | null>(null)
  const [dateFrom,     setDateFrom]     = useState(monthStart())
  const [dateTo,       setDateTo]       = useState(today())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<ContactList[] | { data: ContactList[] }>(`/api/contact-lists?from=${dateFrom}&to=${dateTo}`)
      const arr = Array.isArray(res) ? res : ((res as any)?.data ?? [])
      setLists(Array.isArray(arr) ? arr : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function create() {
    if (!name.trim()) return
    setSaving(true); setSaveErr(null)
    try {
      await apiPost('/api/contact-lists', { name: name.trim(), description: desc.trim() || undefined })
      setShowCreate(false); setName(''); setDesc(''); load()
    } catch (ex: any) { setSaveErr(ex.message) }
    finally { setSaving(false) }
  }

  function openEdit(r: ContactList) {
    setEditTarget(r); setEditName(r.name); setEditDesc(r.description ?? ''); setEditErr(null)
  }

  async function doEdit() {
    if (!editTarget || !editName.trim()) return
    setEditSaving(true); setEditErr(null)
    try {
      await apiPut(`/api/contact-lists/${editTarget.id}`, {
        name: editName.trim(),
        description: editDesc.trim() || null,
      })
      setEditTarget(null); load()
    } catch (ex: any) { setEditErr(ex.message) }
    finally { setEditSaving(false) }
  }

  async function doDelete() {
    if (!deleteTarget) return
    try {
      await apiDelete(`/api/contact-lists/${deleteTarget.id}`)
      setDeleteTarget(null); load()
    } catch (ex: any) { toast.error(ex.message) }
  }

  function exportListsCsv(data: ContactList[]) {
    const header = ['Name', 'Description', 'Members', 'Created By', 'Created At']
    const lines = data.map(r => [
      `"${String(r.name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.description ?? '').replace(/"/g, '""')}"`,
      r.member_count != null ? String(r.member_count) : '',
      `"${String(r.created_by_name ?? '').replace(/"/g, '""')}"`,
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `contact-lists-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const totalMembers = lists.reduce((s, l) => s + Number(l.member_count ?? 0), 0)

  const cols: TableCol<ContactList>[] = [
    {
      key: 'name', label: 'List',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.name}</div>
          {r.description && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.description}</div>}
        </div>
      ),
    },
    {
      key: 'member_count', label: 'Contacts', align: 'right',
      render: r => (
        <span style={{ ...NUM, color: Number(r.member_count ?? 0) > 0 ? GREEN : 'var(--txt3)', fontWeight: FW.bold }}>
          {fmtNum(Number(r.member_count ?? 0))}
        </span>
      ),
    },
    { key: 'created_by_name', label: 'Created By', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.created_by_name ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDatetime(r.created_at)}</span> },
    {
      key: 'id', label: '', align: 'right' as const,
      render: (r: ContactList) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={e => { e.stopPropagation(); setOpenList(r) }}
            style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '3px 10px', gap: 4, display: 'flex', alignItems: 'center' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>group</span>
            Contacts
          </button>
          {canWrite && (
            <>
              <button
                onClick={e => { e.stopPropagation(); openEdit(r) }}
                style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '3px 10px' }}
              >
                Edit
              </button>
              <button
                onClick={e => { e.stopPropagation(); setDeleteTarget(r) }}
                style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '3px 10px', color: RED, borderColor: `${RED}40` }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <Page
      title="Contact Lists"
      subtitle={`${lists.length} list${lists.length !== 1 ? 's' : ''} · ${fmtNum(totalMembers)} total contacts`}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          {canWrite && (
            <button onClick={() => setShowCreate(true)} style={btnPrimary}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
              New List
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard
        title="All Lists"
        badge={lists.length}
        padding={false}
        actions={
          <button
            onClick={() => exportListsCsv(lists)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
            Export CSV
          </button>
        }
      >
        <DataTable<ContactList>
          cols={cols}
          rows={lists}
          keyFn={r => r.id}
          emptyText="No contact lists yet. Create your first list."
          skeletonRows={loading ? 5 : 0}
          searchKeys={['name', 'description', 'created_by_name']}
          searchPlaceholder="Search lists…"
          pageSize={20}
          onRowClick={r => setOpenList(r)}
        />
      </SectionCard>

      {/* Member management drawer */}
      {openList && (
        <MemberDrawer
          list={openList}
          onClose={() => { setOpenList(null); load() }}
          canWrite={canWrite}
        />
      )}

      {/* Create list modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setName(''); setDesc(''); setSaveErr(null) }}
        title="New Contact List"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowCreate(false); setName(''); setDesc(''); setSaveErr(null) }} style={btnSecondary}>Cancel</button>
            <button onClick={create} disabled={saving || !name.trim()} style={btnPrimary}>
              {saving ? 'Creating…' : 'Create List'}
            </button>
          </div>
        }
      >
        {saveErr && <div style={{ color: RED, fontSize: TEXT.sm, marginBottom: 10 }}>{saveErr}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={lbl}>List Name *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Active Prospects Q3" style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={lbl}>Description <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={desc} onChange={e => setDesc(e.target.value)} rows={3}
              placeholder="What's this list for?"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', resize: 'none', fontSize: TEXT.base }} />
          </div>
        </div>
      </Modal>

      {/* Edit list modal */}
      <Modal
        open={!!editTarget}
        onClose={() => { setEditTarget(null); setEditErr(null) }}
        title="Edit List"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setEditTarget(null); setEditErr(null) }} style={btnSecondary}>Cancel</button>
            <button onClick={doEdit} disabled={editSaving || !editName.trim()} style={btnPrimary}>
              {editSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        }
      >
        {editErr && <div style={{ color: RED, fontSize: TEXT.sm, marginBottom: 10 }}>{editErr}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={lbl}>List Name *</label>
            <input value={editName} onChange={e => setEditName(e.target.value)}
              placeholder="List name" style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={lbl}>Description <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={3}
              placeholder="What's this list for?"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', resize: 'none', fontSize: TEXT.base }} />
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete Contact List"
        body={`Delete "${deleteTarget?.name}" and all its contacts? This cannot be undone.`}
        onConfirm={doDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </Page>
  )
}
