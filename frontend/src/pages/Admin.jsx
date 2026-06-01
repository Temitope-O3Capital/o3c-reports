import { useState, useEffect } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

const ROLES = [
  { value: 'admin',       label: 'Admin',       desc: 'Full access — all pages and settings',     icon: 'admin_panel_settings' },
  { value: 'management',  label: 'Management',  desc: 'All reports, read-only',                   icon: 'groups' },
  { value: 'sales',       label: 'Sales',       desc: 'Sales & Overview',                         icon: 'trending_up' },
  { value: 'cards_ops',   label: 'Cards Ops',   desc: 'Cards, Transactions & Overview',           icon: 'credit_card' },
  { value: 'collections', label: 'Collections', desc: 'Collections & Recovery',                   icon: 'account_balance_wallet' },
  { value: 'recovery',    label: 'Recovery',    desc: 'Recovery & Collections',                   icon: 'gavel' },
  { value: 'call_centre', label: 'Call Centre', desc: 'Overview & Transactions',                  icon: 'headset_mic' },
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

const ROLE_COLOUR = {
  admin:       'bg-primary-50   text-primary    dark:bg-primary/20    dark:text-blue-300',
  management:  'bg-purple-50    text-purple-700 dark:bg-purple-900/20  dark:text-purple-300',
  sales:       'bg-emerald-50   text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
  cards_ops:   'bg-blue-50      text-blue-700   dark:bg-blue-900/20    dark:text-blue-300',
  collections: 'bg-amber-50     text-amber-700  dark:bg-amber-900/20   dark:text-amber-400',
  recovery:    'bg-red-50       text-red-700    dark:bg-red-900/20     dark:text-red-400',
  call_centre: 'bg-slate-100    text-slate-600  dark:bg-slate-700      dark:text-slate-300',
}

const EMPTY_FORM = { full_name: '', email: '', password: '', role: 'call_centre', department: 'Operations' }

/* ═══════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════ */

function Avatar({ name, email }) {
  const initials = (name || email || '?')
    .split(' ').slice(0, 2).map(w => w[0]?.toUpperCase()).join('')
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
      style={{ backgroundColor: 'rgb(var(--navy))' }}>
      {initials}
    </div>
  )
}

function RoleBadge({ role }) {
  const label = ROLES.find(r => r.value === role)?.label || role
  return <span className={`badge ${ROLE_COLOUR[role] || 'badge-grey'}`}>{label}</span>
}

function AccessChips({ role }) {
  const pages = ROLE_ACCESS[role] || []
  const visible = pages.slice(0, 3)
  const overflow = pages.length - visible.length
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map(p => (
        <span key={p} className="badge badge-grey">{p}</span>
      ))}
      {overflow > 0 && (
        <span className="badge badge-grey">+{overflow}</span>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   USER MODAL (create + edit)
   ═══════════════════════════════════════════════════════════════ */

function UserModal({ mode, userId, initial, onSave, onClose }) {
  const [form,      setForm]      = useState(initial)
  const [error,     setError]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const isCreate = mode === 'create'
  const selectedRole = ROLES.find(r => r.value === form.role)

  async function handleSave() {
    if (!form.full_name.trim() || !form.email.trim()) {
      setError('Name and email are required.')
      return
    }
    if (isCreate && !form.password) {
      setError('Password is required for new users.')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (isCreate) {
        await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(form) })
      } else {
        const body = { ...form }
        if (!body.password) delete body.password
        await apiFetch(`/api/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify(body) })
      }
      onSave()
    } catch (e) {
      setError(e.message || 'Failed to save user.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg animate-fade-in"
        style={{
          background: 'rgb(var(--bg-surface))',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid rgb(var(--border) / 0.08)',
        }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">
              {isCreate ? 'New User' : 'Edit User'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isCreate ? 'Create a new account and assign a role' : 'Update account details and permissions'}
            </p>
          </div>
          <button onClick={onClose} className="btn-icon">
            <span className="material-symbols-rounded text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm"
              style={{
                background: 'rgb(239 68 68 / 0.06)',
                border: '1px solid rgb(239 68 68 / 0.15)',
                color: '#DC2626',
              }}>
              <span className="material-symbols-rounded text-[16px] flex-shrink-0">error</span>
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Full Name *</label>
              <input
                value={form.full_name}
                onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                placeholder="e.g. Amara Okonkwo"
                className="form-input"
              />
            </div>
            <div>
              <label className="form-label">Email *</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="user@o3ccards.com"
                className="form-input"
              />
            </div>
          </div>

          <div>
            <label className="form-label">
              Password
              {!isCreate && (
                <span className="font-normal text-slate-400 ml-1">(leave blank to keep current)</span>
              )}
            </label>
            <input
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder={isCreate ? 'Set a strong password' : '••••••••'}
              className="form-input"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Role *</label>
              <select
                value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className="form-input"
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
              <label className="form-label">Department *</label>
              <select
                value={form.department}
                onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                className="form-input"
              >
                {DEPARTMENTS.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Access preview */}
          <div className="rounded-lg px-4 py-3"
            style={{ background: 'rgb(var(--bg-subtle))', border: '1px solid rgb(var(--border) / 0.06)' }}>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2"
              style={{ color: 'rgb(var(--fg-3))' }}>
              Page access for this role
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(ROLE_ACCESS[form.role] || []).map(p => (
                <span key={p} className="badge badge-navy">{p}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Footer — tinted, Stripe-style */}
        <div
          className="flex items-center justify-end gap-3 px-6 py-4 rounded-b-xl"
          style={{
            borderTop: '1px solid rgb(var(--border) / 0.08)',
            background: 'rgb(var(--bg-subtle))',
          }}
        >
          <button onClick={onClose} className="btn btn-ghost text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn btn-primary gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: 'white' }} />
                Saving…
              </>
            ) : (
              <>
                <span className="material-symbols-rounded text-[16px]">
                  {isCreate ? 'person_add' : 'save'}
                </span>
                {isCreate ? 'Create User' : 'Save Changes'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   DELETE CONFIRMATION MODAL
   ═══════════════════════════════════════════════════════════════ */

function DeleteModal({ user, onConfirm, onClose, deleting }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm animate-fade-in"
        style={{
          background: 'rgb(var(--bg-surface))',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid rgb(var(--border) / 0.08)',
        }}>

        <div className="px-6 py-6">
          <div className="flex items-center gap-3.5 mb-4">
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgb(239 68 68 / 0.08)' }}>
              <span className="material-symbols-rounded text-[20px] text-red-500">delete</span>
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">Delete User</h2>
              <p className="text-xs text-slate-400 mt-0.5">This action cannot be undone</p>
            </div>
          </div>

          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            You're about to permanently delete{' '}
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              {user?.full_name || user?.email}
            </span>.
            They will lose all access immediately.
          </p>
        </div>

        <div
          className="flex items-center justify-end gap-3 px-6 py-4 rounded-b-xl"
          style={{
            borderTop: '1px solid rgb(var(--border) / 0.08)',
            background: 'rgb(var(--bg-subtle))',
          }}
        >
          <button onClick={onClose} className="btn btn-ghost text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="btn gap-2 text-sm font-semibold text-white px-4 py-2 disabled:opacity-60"
            style={{ background: '#DC2626', borderRadius: 'var(--r-md)' }}
          >
            {deleting ? (
              <>
                <div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: 'white' }} />
                Deleting…
              </>
            ) : (
              <>
                <span className="material-symbols-rounded text-[16px]">delete</span>
                Delete User
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════ */

export default function Admin() {
  const [users,    setUsers]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [modal,    setModal]    = useState(null)   // null | { mode: 'create'|'edit', id?, initial }
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [search,   setSearch]   = useState('')

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

  async function handleDelete() {
    setDeleting(true)
    try {
      await apiFetch(`/api/admin/users/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      await loadUsers()
    } catch (e) {
      setError(e.message)
      setDeleteTarget(null)
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

  /* Stats derived from users */
  const totalUsers = users.length
  const adminCount = users.filter(u => u.role === 'admin' || u.role === 'management').length
  const activeRoles = [...new Set(users.map(u => u.role))].length
  const deptCount  = [...new Set(users.map(u => u.department).filter(Boolean))].length

  const STATS = [
    { icon: 'group',               label: 'Total Users',      value: totalUsers },
    { icon: 'admin_panel_settings',label: 'Admins & Mgmt',    value: adminCount },
    { icon: 'badge',               label: 'Active Roles',     value: activeRoles, sub: `of ${ROLES.length}` },
    { icon: 'apartment',           label: 'Departments',      value: deptCount },
  ]

  return (
    <PageShell
      title="Settings"
      subtitle="Manage user accounts, roles and department access"
      error={error}
      actions={
        <button
          onClick={() => setModal({ mode: 'create', initial: EMPTY_FORM })}
          className="btn btn-primary gap-2 text-sm"
        >
          <span className="material-symbols-rounded text-[17px]">person_add</span>
          New User
        </button>
      }
    >
      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STATS.map(s => (
          <div key={s.label} className="card p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgb(var(--navy) / 0.07)' }}>
              <span className="material-symbols-rounded text-[20px]"
                style={{ color: 'rgb(var(--navy))' }}>
                {s.icon}
              </span>
            </div>
            <div>
              <p className="text-[22px] font-semibold leading-none text-slate-900 dark:text-white font-mono tabular-nums">
                {s.value}
                {s.sub && (
                  <span className="text-sm font-normal text-slate-400 ml-1">{s.sub}</span>
                )}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Role map ── */}
      <div className="card mt-4 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider mb-4"
          style={{ color: 'rgb(var(--fg-3))' }}>
          Role distribution
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {ROLES.map(r => {
            const count = users.filter(u => u.role === r.value).length
            return (
              <div key={r.value}
                className="rounded-lg px-3 py-2.5 text-center"
                style={{ background: 'rgb(var(--bg-subtle))' }}>
                <span className="material-symbols-rounded text-[18px] text-slate-400 dark:text-slate-500">{r.icon}</span>
                <p className="text-lg font-semibold leading-tight mt-1 text-slate-800 dark:text-slate-100 font-mono">{count}</p>
                <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">{r.label}</p>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── User table ── */}
      <div className="card mt-4 overflow-hidden">
        {/* Table header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4"
          style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            All Users
            <span className="ml-2 px-1.5 py-0.5 text-xs font-normal rounded-full"
              style={{ background: 'rgb(var(--bg-subtle))', color: 'rgb(var(--fg-3))' }}>
              {filtered.length}
            </span>
          </p>
          <div className="relative">
            <span className="material-symbols-rounded text-[15px] pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
              style={{ color: 'rgb(var(--fg-3))' }}>
              search
            </span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search users…"
              className="form-input pl-8 py-1.5 text-xs w-44"
            />
          </div>
        </div>

        {/* Table body */}
        {loading ? (
          <div className="flex items-center justify-center gap-3 py-16"
            style={{ color: 'rgb(var(--fg-3))' }}>
            <div className="spinner" />
            <span className="text-sm">Loading users…</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Department</th>
                  <th>Page Access</th>
                  <th>Joined</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="flex flex-col items-center justify-center py-12 gap-2"
                        style={{ color: 'rgb(var(--fg-3))' }}>
                        <span className="material-symbols-rounded text-[36px] opacity-30">group</span>
                        <p className="text-sm">No users found</p>
                      </div>
                    </td>
                  </tr>
                ) : filtered.map(user => (
                  <tr key={user.id}>
                    {/* User */}
                    <td>
                      <div className="flex items-center gap-3">
                        <Avatar name={user.full_name} email={user.email} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                            {user.full_name}
                          </p>
                          <p className="text-xs text-slate-400 truncate">{user.email}</p>
                        </div>
                      </div>
                    </td>

                    {/* Role */}
                    <td><RoleBadge role={user.role} /></td>

                    {/* Department */}
                    <td className="text-sm" style={{ color: 'rgb(var(--fg-2))' }}>
                      {user.department || '—'}
                    </td>

                    {/* Page access */}
                    <td><AccessChips role={user.role} /></td>

                    {/* Joined */}
                    <td className="text-xs whitespace-nowrap" style={{ color: 'rgb(var(--fg-3))' }}>
                      {user.created_at
                        ? new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
                        : '—'}
                    </td>

                    {/* Actions */}
                    <td>
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          onClick={() => setModal({
                            mode: 'edit',
                            id: user.id,
                            initial: {
                              full_name:  user.full_name,
                              email:      user.email,
                              password:   '',
                              role:       user.role,
                              department: user.department || 'Operations',
                            },
                          })}
                          className="icon-btn"
                          title="Edit user"
                        >
                          <span className="material-symbols-rounded text-[16px]">edit</span>
                        </button>
                        <button
                          onClick={() => setDeleteTarget(user)}
                          className="icon-btn"
                          title="Delete user"
                          style={{ color: '#F87171' }}
                          onMouseEnter={e => {
                            e.currentTarget.style.background = 'rgb(239 68 68 / 0.07)'
                            e.currentTarget.style.color = '#DC2626'
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = ''
                            e.currentTarget.style.color = '#F87171'
                          }}
                        >
                          <span className="material-symbols-rounded text-[16px]">delete</span>
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

      {/* ── Modals ── */}
      {modal && (
        <UserModal
          mode={modal.mode}
          userId={modal.id}
          initial={modal.initial}
          onSave={() => { setModal(null); loadUsers() }}
          onClose={() => setModal(null)}
        />
      )}

      {deleteTarget && (
        <DeleteModal
          user={deleteTarget}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}
    </PageShell>
  )
}
