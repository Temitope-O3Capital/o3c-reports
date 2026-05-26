import { useState, useEffect } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'

const ROLES = [
  { value: 'admin',       label: 'Admin',           desc: 'Full access to all pages and settings' },
  { value: 'management',  label: 'Management',      desc: 'All reports — read only' },
  { value: 'sales',       label: 'Sales',           desc: 'Sales & Overview' },
  { value: 'cards_ops',   label: 'Cards Ops',       desc: 'Cards, Transactions & Overview' },
  { value: 'collections', label: 'Collections',     desc: 'Collections & Recovery' },
  { value: 'recovery',    label: 'Recovery',        desc: 'Recovery & Collections' },
  { value: 'call_centre', label: 'Call Centre',     desc: 'Overview & Transactions' },
]

const DEPARTMENTS = [
  'Technology', 'Management', 'Sales', 'Collections',
  'Recovery', 'Call Centre', 'Finance', 'Operations', 'HR',
]

const ROLE_ACCESS = {
  admin:       ['Overview','Transactions','Cards','Sales','Collections','Recovery','Cohort','Settings'],
  management:  ['Overview','Transactions','Cards','Sales','Collections','Recovery','Cohort'],
  sales:       ['Sales','Overview'],
  cards_ops:   ['Cards','Transactions','Overview'],
  collections: ['Collections','Recovery'],
  recovery:    ['Recovery','Collections'],
  call_centre: ['Overview','Transactions'],
}

function RoleBadge({ role }) {
  const colours = {
    admin:       'bg-primary-50 text-primary dark:bg-primary/20 dark:text-blue-300',
    management:  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    sales:       'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    cards_ops:   'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    collections: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    recovery:    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    call_centre: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  }
  const label = ROLES.find(r => r.value === role)?.label || role
  return (
    <span className={`badge ${colours[role] || 'badge-grey'}`}>{label}</span>
  )
}

function initials(name, email) {
  return (name || email || '?').split(' ').slice(0, 2).map(w => w[0].toUpperCase()).join('')
}

const EMPTY_FORM = { full_name: '', email: '', password: '', role: 'call_centre', department: 'Operations' }

export default function Admin() {
  const [users,       setUsers]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [modal,       setModal]       = useState(null)   // null | 'create' | 'edit'
  const [deleteId,    setDeleteId]    = useState(null)
  const [form,        setForm]        = useState(EMPTY_FORM)
  const [formError,   setFormError]   = useState('')
  const [saving,      setSaving]      = useState(false)
  const [deleting,    setDeleting]    = useState(false)
  const [search,      setSearch]      = useState('')

  async function loadUsers() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch('/api/admin/users')
      setUsers(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadUsers() }, [])

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormError('')
    setModal('create')
  }

  function openEdit(user) {
    setForm({ full_name: user.full_name, email: user.email, password: '', role: user.role, department: user.department || 'Operations' })
    setModal({ type: 'edit', id: user.id })
    setFormError('')
  }

  async function handleSave() {
    if (!form.full_name.trim() || !form.email.trim()) {
      setFormError('Name and email are required.')
      return
    }
    if (modal === 'create' && !form.password) {
      setFormError('Password is required for new users.')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      if (modal === 'create') {
        await apiFetch('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify(form),
        })
      } else {
        const body = { ...form }
        if (!body.password) delete body.password
        await apiFetch(`/api/admin/users/${modal.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      }
      setModal(null)
      await loadUsers()
    } catch (e) {
      setFormError(e.message || 'Failed to save user.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await apiFetch(`/api/admin/users/${deleteId}`, { method: 'DELETE' })
      setDeleteId(null)
      await loadUsers()
    } catch (e) {
      setError(e.message)
      setDeleteId(null)
    } finally {
      setDeleting(false)
    }
  }

  const filtered = users.filter(u => {
    const q = search.toLowerCase()
    return (
      u.full_name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.role?.toLowerCase().includes(q) ||
      u.department?.toLowerCase().includes(q)
    )
  })

  const selectedRole = ROLES.find(r => r.value === form.role)

  return (
    <PageShell
      title="Settings"
      subtitle="Manage users, roles and department access"
      error={error}
      actions={
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-light text-white text-sm font-semibold rounded-lg transition-colors shadow-sm shadow-primary/20"
        >
          <span className="material-symbols-outlined text-[18px]">person_add</span>
          New User
        </button>
      }
    >
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {ROLES.slice(0, 4).map(r => {
          const count = users.filter(u => u.role === r.value).length
          return (
            <div key={r.value} className="card p-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary-50 dark:bg-primary/20 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary dark:text-blue-300 text-[18px]">person</span>
              </div>
              <div>
                <p className="text-xl font-bold text-slate-900 dark:text-white">{count}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{r.label}</p>
              </div>
            </div>
          )
        })}
      </div>

      {/* User table */}
      <div className="card mt-4 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between gap-4">
          <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
            All Users <span className="text-slate-400 font-normal">({filtered.length})</span>
          </p>
          <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-1.5 w-56">
            <span className="material-symbols-outlined text-slate-400 text-[18px]">search</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search users…"
              className="bg-transparent border-none text-sm text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none w-full"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-12 gap-3 text-slate-400">
            <div className="spinner" /> Loading users…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3 text-left">User</th>
                  <th className="px-5 py-3 text-left">Role</th>
                  <th className="px-5 py-3 text-left">Department</th>
                  <th className="px-5 py-3 text-left">Page Access</th>
                  <th className="px-5 py-3 text-left">Joined</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                      No users found
                    </td>
                  </tr>
                ) : filtered.map(user => (
                  <tr key={user.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {initials(user.full_name, user.email)}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800 dark:text-slate-200">{user.full_name}</p>
                          <p className="text-xs text-slate-400">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3"><RoleBadge role={user.role} /></td>
                    <td className="px-5 py-3 text-slate-600 dark:text-slate-400">{user.department || '—'}</td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(ROLE_ACCESS[user.role] || []).map(p => (
                          <span key={p} className="badge badge-grey">{p}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-slate-500 text-xs whitespace-nowrap">
                      {user.created_at ? new Date(user.created_at).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(user)}
                          className="icon-btn"
                          title="Edit user"
                        >
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button
                          onClick={() => setDeleteId(user.id)}
                          className="icon-btn text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                          title="Delete user"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 dark:border-slate-700">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                {modal === 'create' ? 'New User' : 'Edit User'}
              </h2>
              <button onClick={() => setModal(null)} className="icon-btn">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="p-6 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-lg px-4 py-3">
                  <span className="material-symbols-outlined text-[18px]">error</span>
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                    Full Name *
                  </label>
                  <input
                    value={form.full_name}
                    onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                    placeholder="e.g. Amara Okonkwo"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                    Email Address *
                  </label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="user@o3ccards.com"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                  Password {modal !== 'create' && <span className="normal-case font-normal">(leave blank to keep current)</span>}
                </label>
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={modal === 'create' ? 'Set a strong password' : '••••••••'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                    Role *
                  </label>
                  <select
                    value={form.role}
                    onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  >
                    {ROLES.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  {selectedRole && (
                    <p className="text-xs text-slate-400 mt-1">{selectedRole.desc}</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                    Department *
                  </label>
                  <select
                    value={form.department}
                    onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  >
                    {DEPARTMENTS.map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Access preview */}
              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg px-4 py-3">
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                  Page Access for this role
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {(ROLE_ACCESS[form.role] || []).map(p => (
                    <span key={p} className="badge badge-navy">{p}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-100 dark:border-slate-700">
              <button
                onClick={() => setModal(null)}
                className="px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-primary hover:bg-primary-light text-white rounded-lg transition-colors disabled:opacity-60"
              >
                {saving ? (
                  <><div className="spinner !w-4 !h-4 !border-white/30 !border-t-white" /> Saving…</>
                ) : (
                  <><span className="material-symbols-outlined text-[18px]">save</span> {modal === 'create' ? 'Create User' : 'Save Changes'}</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <span className="material-symbols-outlined text-red-600 dark:text-red-400">delete</span>
              </div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Delete User</h2>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
              This will permanently delete the user account. This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteId(null)}
                className="px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-accent hover:bg-accent-dark text-white rounded-lg transition-colors disabled:opacity-60"
              >
                {deleting ? (
                  <><div className="spinner !w-4 !h-4 !border-white/30 !border-t-white" /> Deleting…</>
                ) : (
                  <><span className="material-symbols-outlined text-[18px]">delete</span> Delete</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}
