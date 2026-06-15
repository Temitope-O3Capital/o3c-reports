import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'

/* ── Add contacts modal ── */
function AddContactModal({ list, onClose, onAdded }) {
  const [tab, setTab] = useState('manual') // 'manual' | 'csv'
  const [form, setForm] = useState({ first_name: '', last_name: '', phone: '', email: '', cif_number: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [csvFile, setCsvFile] = useState(null)
  const [csvResult, setCsvResult] = useState(null)

  const saveManual = async () => {
    if (!form.phone && !form.email) return setError('Phone or email is required')
    setSaving(true); setError('')
    try {
      await apiFetch(`/api/contact-lists/${list.id}/members`, {
        method: 'POST', body: JSON.stringify(form),
      })
      onAdded()
    } catch (e) { setError(e.message || 'Failed to add contact') } finally { setSaving(false) }
  }

  const uploadCsv = async () => {
    if (!csvFile) return setError('Select a CSV file first')
    setSaving(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', csvFile)
      const res = await apiFetch(`/api/contact-lists/${list.id}/upload-csv`, {
        method: 'POST', body: fd, isFormData: true,
      })
      setCsvResult(res)
    } catch (e) { setError(e.message || 'Upload failed') } finally { setSaving(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: 500, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>Add Contacts — {list.name}</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          <div className="flex gap-2 mb-5">
            {[['manual', 'Add Manually'], ['csv', 'Upload CSV']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => { setTab(k); setError(''); setCsvResult(null) }}
                style={{
                  fontSize: 12, fontWeight: 600, padding: '6px 16px', borderRadius: 999, cursor: 'pointer',
                  border: `1.5px solid ${tab === k ? '#0E2841' : 'rgb(var(--border) / 0.2)'}`,
                  background: tab === k ? '#0E2841' : 'transparent',
                  color: tab === k ? '#fff' : 'rgb(var(--fg-2))',
                }}>{l}</button>
            ))}
          </div>

          {error && <p style={{ color: '#C00000', fontSize: 13, marginBottom: 12 }}>{error}</p>}

          {tab === 'manual' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">First Name</label>
                  <input className="form-input" value={form.first_name}
                    onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} />
                </div>
                <div>
                  <label className="form-label">Last Name</label>
                  <input className="form-input" value={form.last_name}
                    onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="form-label">Phone</label>
                <input className="form-input" placeholder="08012345678" value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Email</label>
                <input className="form-input" type="email" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">CIF Number</label>
                <input className="form-input" placeholder="Optional" value={form.cif_number}
                  onChange={e => setForm(f => ({ ...f, cif_number: e.target.value }))} />
              </div>
            </div>
          )}

          {tab === 'csv' && !csvResult && (
            <div>
              <p style={{ fontSize: 12, color: 'rgb(var(--fg-2))', marginBottom: 12 }}>
                CSV must have headers: <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>first_name, last_name, phone, email, cif_number</code>
              </p>
              <input type="file" accept=".csv" style={{ fontSize: 13 }}
                onChange={e => setCsvFile(e.target.files[0])} />
            </div>
          )}

          {csvResult && (
            <div style={{ padding: 16, background: 'rgb(var(--bg-muted))', borderRadius: 8 }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#166534', marginBottom: 6 }}>Upload complete</p>
              <p style={{ fontSize: 13 }}>Imported: {csvResult.imported} · Skipped: {csvResult.skipped} · Errors: {csvResult.errors}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5" style={{ borderTop: '1px solid rgb(var(--border) / 0.1)' }}>
          <button className="btn btn-ghost" onClick={onClose}>{csvResult ? 'Close' : 'Cancel'}</button>
          {!csvResult && (
            <button className="btn btn-primary" onClick={tab === 'manual' ? saveManual : uploadCsv} disabled={saving}>
              {saving ? 'Saving…' : (tab === 'manual' ? 'Add Contact' : 'Upload')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── List detail modal (view members) ── */
function ListDetailModal({ list, onClose }) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const PER_PAGE = 25

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ page, per_page: PER_PAGE })
      if (search.trim()) qs.set('q', search.trim())
      const res = await apiFetch(`/api/contact-lists/${list.id}/members?${qs}`)
      setMembers(res.items || [])
      setTotal(res.total || 0)
    } catch { setMembers([]) } finally { setLoading(false) }
  }, [list.id, page, search])

  useEffect(() => { load() }, [load])

  const removeMember = async (memberId) => {
    if (!confirm('Remove this contact from the list?')) return
    try {
      await apiFetch(`/api/contact-lists/${list.id}/members/${memberId}`, { method: 'DELETE' })
      load()
    } catch (e) { alert(e.message || 'Failed') }
  }

  const totalPages = Math.ceil(total / PER_PAGE)

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div className="card" style={{ width: '100%', maxWidth: 720, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
          <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 700 }}>{list.name}</h2>
              <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))', marginTop: 2 }}>{total.toLocaleString()} contact{total !== 1 ? 's' : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>
                Add Contacts
              </button>
              <button className="btn btn-icon btn-ghost" onClick={onClose}>
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
              </button>
            </div>
          </div>

          <div className="p-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <input className="form-input" style={{ maxWidth: 280, fontSize: 12 }}
              placeholder="Search by name, phone, email…"
              value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div className="flex justify-center py-12"><div className="spinner" /></div>
            ) : members.length === 0 ? (
              <div className="p-12 text-center">
                <span className="material-symbols-rounded" style={{ fontSize: 40, color: 'rgb(var(--fg-4))', display: 'block', marginBottom: 8 }}>person_off</span>
                <p style={{ fontSize: 14, color: 'rgb(var(--fg-3))' }}>No contacts yet</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'rgb(var(--bg-muted))' }}>
                    {['Name', 'Phone', 'Email', 'CIF', ''].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={m.id} style={{ borderTop: i > 0 ? '1px solid rgb(var(--border) / 0.07)' : 'none' }}>
                      <td style={{ padding: '10px 16px', fontWeight: 500 }}>{[m.first_name, m.last_name].filter(Boolean).join(' ') || '—'}</td>
                      <td style={{ padding: '10px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m.phone || '—'}</td>
                      <td style={{ padding: '10px 16px', fontSize: 12 }}>{m.email || '—'}</td>
                      <td style={{ padding: '10px 16px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m.cif_number || '—'}</td>
                      <td style={{ padding: '10px 16px' }}>
                        <button className="btn btn-icon btn-ghost btn-sm" title="Remove"
                          style={{ color: '#C00000' }} onClick={() => removeMember(m.id)}>
                          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>remove_circle_outline</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between p-4" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
              <span style={{ fontSize: 12, color: 'rgb(var(--fg-3))' }}>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
                <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {addOpen && (
        <AddContactModal list={list} onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); load() }} />
      )}
    </>
  )
}

/* ── Create list modal ── */
function CreateListModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!name.trim()) return setError('List name is required')
    setSaving(true); setError('')
    try {
      const list = await apiFetch('/api/contact-lists', {
        method: 'POST', body: JSON.stringify({ name: name.trim(), description: desc.trim() }),
      })
      onCreated(list)
    } catch (e) { setError(e.message || 'Failed') } finally { setSaving(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: 420 }}>
        <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>New Contact List</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <p style={{ color: '#C00000', fontSize: 13 }}>{error}</p>}
          <div>
            <label className="form-label">List Name *</label>
            <input className="form-input" placeholder="e.g. Collections June 2026"
              value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && save()} />
          </div>
          <div>
            <label className="form-label">Description</label>
            <input className="form-input" placeholder="Optional note about this list"
              value={desc} onChange={e => setDesc(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-3 p-5" style={{ borderTop: '1px solid rgb(var(--border) / 0.1)' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Creating…' : 'Create List'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Main page ── */
export default function ContactLists() {
  const [lists, setLists] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [detailList, setDetailList] = useState(null)
  const [deleting, setDeleting] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await apiFetch('/api/contact-lists')
      setLists(data || [])
    } catch (e) { setError(e.message || 'Failed to load contact lists') } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const doDelete = async (list) => {
    if (!confirm(`Delete "${list.name}"? All contacts in this list will also be removed.`)) return
    setDeleting(list.id)
    try {
      await apiFetch(`/api/contact-lists/${list.id}`, { method: 'DELETE' })
      setLists(ls => ls.filter(l => l.id !== list.id))
    } catch (e) { alert(e.message || 'Delete failed') } finally { setDeleting(null) }
  }

  return (
    <PageShell
      title="Contact Lists"
      subtitle="Manage subscriber lists for SMS and email campaigns"
      error={error}
      actions={
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>add</span>
          New List
        </button>
      }
    >
      {loading ? (
        <div className="flex justify-center py-16"><div className="spinner" /></div>
      ) : lists.length === 0 ? (
        <div className="card p-12 text-center">
          <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'rgb(var(--fg-4))', display: 'block', marginBottom: 12 }}>group</span>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--fg-2))', marginBottom: 4 }}>No contact lists yet</p>
          <p style={{ fontSize: 13, color: 'rgb(var(--fg-3))', marginBottom: 16 }}>Create lists to segment your audience for targeted campaigns</p>
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>Create First List</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {lists.map(list => (
            <div key={list.id} className="card p-5">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="flex-1 min-w-0">
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{list.name}</h3>
                  {list.description && (
                    <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{list.description}</p>
                  )}
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button className="btn btn-icon btn-ghost btn-sm" title="Delete"
                    style={{ color: '#C00000' }} disabled={deleting === list.id} onClick={() => doDelete(list)}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span>
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'rgb(var(--fg-3))' }}>group</span>
                  <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{(list.member_count || 0).toLocaleString()}</span>
                  <span style={{ fontSize: 12, color: 'rgb(var(--fg-3))' }}>contact{list.member_count !== 1 ? 's' : ''}</span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setDetailList(list)}>
                  View members
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>chevron_right</span>
                </button>
              </div>

              {list.created_at && (
                <p style={{ fontSize: 10, color: 'rgb(var(--fg-4))', marginTop: 10 }}>
                  Created {new Date(list.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {list.created_by_name ? ` · ${list.created_by_name}` : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateListModal
          onClose={() => setCreateOpen(false)}
          onCreated={(list) => { setLists(ls => [list, ...ls]); setCreateOpen(false) }}
        />
      )}

      {detailList && (
        <ListDetailModal list={detailList} onClose={() => { setDetailList(null); load() }} />
      )}
    </PageShell>
  )
}
