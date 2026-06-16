import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { fmtDate } from '../lib/fmt'
import { Page, SectionCard, DataTable, ColDef, KpiCard, ErrBanner, StatusBadge, NAVY, RED } from '../components/UI'

interface User {
  id: number
  name: string
  email: string
  role: string
  status: string
  last_login: string | null
  created_at: string
}

const ROLES = [
  'md','coo','cfo','head_it','head_hr','cmo','head_ops','head_sales',
  'head_collections','head_recovery','admin','management','sales',
  'collections','recovery','cards_ops','call_centre',
]

export default function AdminUsers() {
  const [users, setUsers]   = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')
  const [search, setSearch] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [form, setForm]     = useState({ name: '', email: '', role: 'sales', password: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch('/api/admin/users')
      setUsers(res.data ?? res ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(form) })
      setDrawerOpen(false)
      setForm({ name: '', email: '', role: 'sales', password: '' })
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function toggleStatus(u: User) {
    const action = u.status === 'active' ? 'deactivate' : 'reactivate'
    try {
      await apiFetch(`/api/admin/users/${u.id}/${action}`, { method: 'PATCH' })
      load()
    } catch (e: any) { setError(e.message) }
  }

  async function resetPassword(u: User) {
    if (!confirm(`Reset password for ${u.name}?`)) return
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' })
      alert(`Temporary password: ${(res as any).temp_password || '(see email)'}`)
    } catch (e: any) { setError(e.message) }
  }

  const filtered = users.filter(u =>
    !search ||
    u.name?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase()) ||
    u.role?.toLowerCase().includes(search.toLowerCase())
  )

  const active   = users.filter(u => u.status === 'active').length
  const inactive = users.filter(u => u.status !== 'active').length

  const cols: ColDef<User>[] = [
    { key: 'name',       label: 'Name' },
    { key: 'email',      label: 'Email' },
    { key: 'role',       label: 'Role',      render: r => (
        <span className="text-[12px] font-medium px-2 py-0.5 rounded capitalize"
          style={{ background: 'rgba(14,40,65,0.06)', color: '#475569' }}>
          {(r.role || '').replace(/_/g, ' ')}
        </span>
      )},
    { key: 'status',     label: 'Status',    render: r => <StatusBadge status={r.status || 'inactive'} /> },
    { key: 'last_login', label: 'Last Login', render: r => r.last_login ? fmtDate(r.last_login) : <span className="text-slate-400">Never</span> },
    { key: 'created_at', label: 'Created',   render: r => fmtDate(r.created_at) },
    { key: '_actions',   label: '',          sortable: false, render: r => (
        <div className="flex gap-1">
          <button onClick={() => resetPassword(r)} title="Reset password"
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[15px]">key</span>
          </button>
          <button onClick={() => toggleStatus(r)} title={r.status === 'active' ? 'Deactivate' : 'Reactivate'}
            className="p-1 rounded transition-colors"
            style={{ color: r.status === 'active' ? '#DC2626' : '#059669' }}>
            <span className="material-symbols-rounded text-[15px]">
              {r.status === 'active' ? 'person_off' : 'person_check'}
            </span>
          </button>
        </div>
      )},
  ]

  return (
    <Page dept="Admin" title="User Management" subtitle="Manage platform accounts and permissions"
      actions={
        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="material-symbols-rounded absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-slate-400">search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users…"
              className="pl-8 pr-3 py-1.5 rounded-lg border text-[12px] outline-none w-48"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
          </div>
          <button onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[14px]">person_add</span>Invite User
          </button>
        </div>
      }>
      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Users"  value={String(users.length)} icon="group"       accent={NAVY}    />
        <KpiCard loading={loading} label="Active"       value={String(active)}       icon="check_circle" accent="#059669" />
        <KpiCard loading={loading} label="Inactive"     value={String(inactive)}     icon="cancel"       accent="#64748B" />
        <KpiCard loading={loading} label="Roles"        value={String(ROLES.length)} icon="badge"        accent={RED}     />
      </div>

      <SectionCard title="All Users" badge={filtered.length}>
        <DataTable cols={cols} rows={filtered} loading={loading}
          emptyMsg="No users found" emptyIcon="person_search" />
      </SectionCard>

      {/* Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setDrawerOpen(false)}
          style={{ background: 'rgba(0,0,0,0.3)' }}>
          <div className="absolute right-0 top-0 h-full w-[380px] bg-white shadow-2xl overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="px-6 py-5 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-slate-800">Invite New User</h3>
                <button onClick={() => setDrawerOpen(false)}>
                  <span className="material-symbols-rounded text-[20px] text-slate-400">close</span>
                </button>
              </div>
            </div>
            <form className="px-6 py-5 space-y-4" onSubmit={handleCreate}>
              {[
                { label: 'Full Name', key: 'name', type: 'text', placeholder: 'e.g. Amaka Okonkwo' },
                { label: 'Email',     key: 'email', type: 'email', placeholder: 'user@o3cards.com' },
                { label: 'Temp Password', key: 'password', type: 'password', placeholder: '••••••••' },
              ].map(f => (
                <div key={f.key}>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5">{f.label}</label>
                  <input required type={f.type} placeholder={f.placeholder}
                    value={(form as any)[f.key]}
                    onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                    style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
                </div>
              ))}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5">Role</label>
                <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                  {ROLES.map(r => (
                    <option key={r} value={r}>{r.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
                  ))}
                </select>
              </div>
              <p className="text-[11.5px] text-slate-400 leading-relaxed">
                The user will be prompted to change their password on first login.
              </p>
              <button type="submit" disabled={saving}
                className="w-full py-2.5 text-[13px] font-semibold text-white rounded-lg disabled:opacity-60"
                style={{ background: NAVY }}>
                {saving ? 'Creating…' : 'Create Account'}
              </button>
            </form>
          </div>
        </div>
      )}
    </Page>
  )
}
