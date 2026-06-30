import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  ErrBanner, StatusBadge, KpiCard, Page, SectionCard, DataTable,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'
import type { ColDef } from '../../components/UI'
import { roleLabel } from '../../lib/roles'

// ── Types ──────────────────────────────────────────────────────────────────────

interface User {
  id: string
  email: string
  full_name: string
  first_name: string
  last_name: string
  role: string
  department: string
  is_active: boolean
  last_login: string | null
  must_change_password: boolean
  created_at: string
  deleted_at: string | null
}

interface CreateForm {
  first_name: string; last_name: string
  email: string; role: string; department: string
}
interface EditForm {
  first_name: string; last_name: string
  email: string; role: string; department: string; is_active: boolean
}

interface Activity {
  id: string; page: string; action: string; detail: string
  ip: string; resource: string; method: string; ts: string
}
interface Session {
  id: string; ip_address: string; user_agent: string
  logged_in_at: string; last_active_at: string
}
interface RoleOption {
  name: string
  label?: string
  pages?: string[]
  builtin?: boolean
  built_in?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROLES = [
  'md','coo','cfo','cmo','executive',
  'sales_officer','sales_head',
  'risk_officer','risk_head',
  'finance_officer','finance_head',
  'cards_ops_officer','cards_ops_head',
  'collections_agent','collections_head',
  'recovery_agent','recovery_head',
  'call_center_agent','call_center_head',
  'hr_officer','hr_manager',
  'compliance_officer','compliance_head','internal_control_head',
  'it_admin',
]

const FALLBACK_ROLE_OPTIONS: RoleOption[] = ROLES.map(name => ({ name, label: roleLabel(name), builtin: true }))

function normalizeRoleOptions(raw: any): RoleOption[] {
  const rows = Array.isArray(raw) ? raw : (raw?.data ?? [])
  const opts = rows
    .map((r: any) => ({
      name: String(r.name ?? '').trim(),
      label: String(r.label ?? roleLabel(String(r.name ?? ''))),
      pages: Array.isArray(r.pages) ? r.pages : [],
      builtin: Boolean(r.builtin ?? r.built_in),
      built_in: Boolean(r.builtin ?? r.built_in),
    }))
    .filter((r: RoleOption) => r.name)
  return opts.length ? opts : FALLBACK_ROLE_OPTIONS
}

function roleChoices(options: RoleOption[], selected?: string): RoleOption[] {
  if (!selected || options.some(r => r.name === selected)) return options
  return [{ name: selected, label: roleLabel(selected) }, ...options]
}

const EMPTY_CREATE: CreateForm = {
  first_name: '', last_name: '', email: '', role: 'sales_officer', department: '',
}

// ── Input helper ──────────────────────────────────────────────────────────────

function Field({
  label, value, onChange, type = 'text', required = false, disabled = false,
}: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; required?: boolean; disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        required={required}
        disabled={disabled}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none disabled:bg-slate-50 disabled:text-slate-400"
        style={{ borderColor: 'rgba(15,23,42,0.15)' }}
      />
    </div>
  )
}

function SelectField({
  label, value, onChange, children,
}: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none bg-white"
        style={{ borderColor: 'rgba(15,23,42,0.15)' }}
      >
        {children}
      </select>
    </div>
  )
}

// ── User Drawer (profile + activity + sessions) ───────────────────────────────

function UserDrawer({
  user, roles, onClose, onSaved,
}: {
  user: User; roles: RoleOption[]; onClose: () => void; onSaved: () => void
}) {
  const [tab, setTab] = useState<'profile' | 'sessions' | 'activity'>('profile')
  const [form, setForm] = useState<EditForm>({
    first_name: user.first_name || user.full_name.split(' ')[0] || '',
    last_name:  user.last_name  || user.full_name.split(' ').slice(1).join(' ') || '',
    email:      user.email,
    role:       user.role,
    department: user.department || '',
    is_active:  user.is_active,
  })
  const [saving, setSaving]   = useState(false)
  const [saveErr, setSaveErr] = useState('')

  const [activity, setActivity] = useState<Activity[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [loadingAct, setLoadingAct] = useState(false)
  const [loadingSes, setLoadingSes] = useState(false)

  const [resetting, setResetting]   = useState(false)
  const [resetPw,   setResetPw]     = useState<string | null>(null)

  useEffect(() => {
    if (tab === 'activity' && activity.length === 0) {
      setLoadingAct(true)
      apiFetch(`/api/admin/users/${user.id}/activity`)
        .then(r => setActivity(r.data ?? r))
        .catch(() => {})
        .finally(() => setLoadingAct(false))
    }
    if (tab === 'sessions' && sessions.length === 0) {
      setLoadingSes(true)
      apiFetch(`/api/admin/users/${user.id}/sessions`)
        .then(r => setSessions(r.data ?? r))
        .catch(() => {})
        .finally(() => setLoadingSes(false))
    }
  }, [tab, user.id])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setSaveErr('')
    try {
      await apiPut(`/api/admin/users/${user.id}`, {
        first_name: form.first_name,
        last_name:  form.last_name,
        email:      form.email,
        role:       form.role,
        department: form.department,
      })
      // handle active toggle separately
      if (form.is_active !== user.is_active) {
        const action = form.is_active ? 'reactivate' : 'deactivate'
        await apiFetch(`/api/admin/users/${user.id}/${action}`, { method: 'PATCH' })
      }
      onSaved(); onClose()
    } catch (err: any) {
      setSaveErr(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    setResetting(true); setResetPw(null)
    try {
      const res = await apiPost(`/api/admin/users/${user.id}/reset-password`, {})
      setResetPw((res as any).temp_password)
    } catch {}
    finally { setResetting(false) }
  }

  const actCols: ColDef<Activity>[] = [
    { key: 'ts',     label: 'Time',    render: r => <span className="text-[11px] text-slate-400 whitespace-nowrap">{fmtDate(r.ts)}</span> },
    { key: 'page',   label: 'Module',  render: r => <span className="text-[12px] font-medium">{r.page || '—'}</span> },
    { key: 'action', label: 'Action',  render: r => <span className="text-[12px]">{r.action}</span> },
    { key: 'detail', label: 'Detail',  render: r => <span className="text-[11px] text-slate-500 truncate max-w-[200px] block">{r.detail || '—'}</span> },
    { key: 'ip',     label: 'IP',      render: r => <span className="font-mono text-[11px] text-slate-400">{r.ip || '—'}</span> },
  ]

  const sesCols: ColDef<Session>[] = [
    { key: 'logged_in_at',  label: 'Login Time',   render: r => <span className="text-[12px] whitespace-nowrap">{fmtDate(r.logged_in_at)}</span> },
    { key: 'last_active_at',label: 'Last Active',  render: r => <span className="text-[11px] text-slate-400 whitespace-nowrap">{fmtDate(r.last_active_at)}</span> },
    { key: 'ip_address',    label: 'IP Address',   render: r => <span className="font-mono text-[12px]">{r.ip_address || '—'}</span> },
    { key: 'user_agent',    label: 'Browser / Device', render: r => {
      const ua = r.user_agent || ''
      const browser = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : ua.includes('Edge') ? 'Edge' : 'Unknown'
      const os = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : ua.includes('Linux') ? 'Linux' : ua.includes('Android') ? 'Android' : ua.includes('iPhone') ? 'iOS' : 'Unknown'
      return <span className="text-[12px] text-slate-600">{browser} · {os}</span>
    }},
  ]

  const TABS = [
    { id: 'profile',  label: 'Profile' },
    { id: 'sessions', label: 'Login Sessions' },
    { id: 'activity', label: 'Audit Trail' },
  ] as const

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 40 }}
        onClick={onClose}
      />
      {/* Drawer */}
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 520,
        background: '#fff', zIndex: 50, display: 'flex', flexDirection: 'column',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
      }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[15px] flex-shrink-0"
            style={{ background: NAVY }}>
            {(form.first_name[0] || '?').toUpperCase()}{(form.last_name[0] || '').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-bold text-slate-800 truncate">
              {form.first_name} {form.last_name}
            </p>
            <p className="text-[12px] text-slate-400 truncate">{user.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${user.is_active ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {user.is_active ? 'Active' : 'Inactive'}
            </span>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
              <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 flex-shrink-0 px-6"
          style={{ borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="px-3 py-3 text-[13px] font-semibold transition-colors"
              style={{
                color:       tab === t.id ? NAVY : '#94a3b8',
                borderBottom: tab === t.id ? `2px solid ${NAVY}` : '2px solid transparent',
                marginBottom: -1,
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Profile tab ── */}
          {tab === 'profile' && (
            <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="First Name" value={form.first_name} onChange={v => setForm(f => ({ ...f, first_name: v }))} required />
                <Field label="Last Name"  value={form.last_name}  onChange={v => setForm(f => ({ ...f, last_name: v }))} />
              </div>
              <Field label="Email Address" type="email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} required />
              <SelectField label="Role" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))}>
                {roleChoices(roles, form.role).map(r => <option key={r.name} value={r.name}>{r.label || roleLabel(r.name)}</option>)}
              </SelectField>
              <Field label="Department" value={form.department} onChange={v => setForm(f => ({ ...f, department: v }))} />

              {/* Active toggle */}
              <div className="flex items-center justify-between rounded-xl p-4"
                style={{ background: 'rgba(15,23,42,0.03)', border: '1px solid rgba(15,23,42,0.08)' }}>
                <div>
                  <p className="text-[13px] font-semibold text-slate-700">Account Status</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">Inactive users cannot log in</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
                  style={{
                    position: 'relative', width: 44, height: 24, borderRadius: 12,
                    background: form.is_active ? '#22c55e' : '#cbd5e1',
                    border: 'none', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0,
                  }}>
                  <span style={{
                    position: 'absolute', top: 2, left: form.is_active ? 22 : 2,
                    width: 20, height: 20, borderRadius: '50%',
                    background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* Meta info */}
              <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-400 pt-1">
                <div><span className="font-semibold text-slate-500">Created</span><br />{fmtDate(user.created_at)}</div>
                <div><span className="font-semibold text-slate-500">Last Login</span><br />{user.last_login ? fmtDate(user.last_login) : 'Never'}</div>
                <div><span className="font-semibold text-slate-500">Must Change PW</span><br />{user.must_change_password ? 'Yes' : 'No'}</div>
                <div><span className="font-semibold text-slate-500">Role</span><br />{roleLabel(user.role)}</div>
              </div>

              {saveErr && <p className="text-[12px] text-red-600 bg-red-50 px-3 py-2 rounded-lg">{saveErr}</p>}

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button type="submit" disabled={saving}
                  className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold text-white disabled:opacity-60"
                  style={{ background: NAVY }}>
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
                <button type="button" onClick={handleReset} disabled={resetting}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-semibold border transition-colors disabled:opacity-60"
                  style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#475569' }}>
                  <span className="material-symbols-rounded text-[15px]">lock_reset</span>
                  {resetting ? 'Resetting…' : 'Reset PW'}
                </button>
              </div>

              {resetPw && (
                <div className="rounded-xl p-4 mt-2"
                  style={{ background: '#ECFDF5', border: '1px solid #A7F3D0' }}>
                  <p className="text-[12px] font-semibold text-green-800 mb-1">Temporary password generated</p>
                  <p className="font-mono text-[14px] font-bold text-green-900 tracking-widest select-all">{resetPw}</p>
                  <p className="text-[11px] text-green-700 mt-1">Share this with the user. It expires on next login.</p>
                </div>
              )}
            </form>
          )}

          {/* ── Sessions tab ── */}
          {tab === 'sessions' && (
            <div className="p-4">
              {loadingSes ? (
                <div className="flex justify-center py-16">
                  <div className="w-6 h-6 rounded-full border-2 animate-spin" style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: NAVY }} />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center py-16 gap-3 text-slate-400">
                  <span className="material-symbols-rounded text-[40px]">devices</span>
                  <p className="text-[13px]">No login sessions recorded yet</p>
                  <p className="text-[11px] text-center">Sessions are recorded on each login going forward</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((s, i) => (
                    <div key={s.id} className="rounded-xl p-4 flex items-start gap-3"
                      style={{ background: i === 0 ? 'rgba(14,40,65,0.03)' : '#fff', border: '1px solid rgba(15,23,42,0.07)' }}>
                      <span className="material-symbols-rounded text-[20px] mt-0.5 flex-shrink-0"
                        style={{ color: i === 0 ? NAVY : '#94a3b8' }}>
                        {s.user_agent?.includes('Mobile') || s.user_agent?.includes('Android') || s.user_agent?.includes('iPhone') ? 'smartphone' : 'laptop_mac'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {i === 0 && <span className="text-[10px] font-bold bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Most Recent</span>}
                          <p className="text-[12px] font-semibold text-slate-700">{fmtDate(s.logged_in_at)}</p>
                        </div>
                        <p className="font-mono text-[11px] text-slate-500 mt-0.5">{s.ip_address || 'Unknown IP'}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                          {(() => {
                            const ua = s.user_agent || ''
                            const browser = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : ua.includes('Edge') ? 'Edge' : 'Unknown Browser'
                            const os = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : ua.includes('Linux') ? 'Linux' : ua.includes('Android') ? 'Android' : ua.includes('iPhone') ? 'iOS' : 'Unknown OS'
                            return `${browser} on ${os}`
                          })()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Activity tab ── */}
          {tab === 'activity' && (
            <div className="p-4">
              {loadingAct ? (
                <div className="flex justify-center py-16">
                  <div className="w-6 h-6 rounded-full border-2 animate-spin" style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: NAVY }} />
                </div>
              ) : activity.length === 0 ? (
                <div className="flex flex-col items-center py-16 gap-3 text-slate-400">
                  <span className="material-symbols-rounded text-[40px]">history</span>
                  <p className="text-[13px]">No activity recorded for this user</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {activity.map(a => (
                    <div key={a.id} className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 transition-colors">
                      <span className="material-symbols-rounded text-[14px] mt-0.5 flex-shrink-0 text-slate-400">
                        {a.method === 'DELETE' ? 'delete' : a.method === 'POST' ? 'add_circle' : a.method === 'PUT' ? 'edit' : 'visibility'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[12px] font-semibold text-slate-700">{a.action || a.page}</span>
                          {a.resource && <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{a.resource}</span>}
                        </div>
                        {a.detail && <p className="text-[11px] text-slate-400 truncate mt-0.5">{a.detail}</p>}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-[10px] text-slate-300 whitespace-nowrap">{fmtDate(a.ts)}</p>
                        {a.ip && <p className="font-mono text-[10px] text-slate-300">{a.ip}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

// ── Create User Modal ─────────────────────────────────────────────────────────

function CreateModal({
  roles, onClose, onCreated,
}: {
  roles: RoleOption[]; onClose: () => void; onCreated: (pw: string, name: string) => void
}) {
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true); setErr('')
    try {
      const res = await apiPost('/api/admin/users', form)
      onCreated((res as any).temp_password, form.first_name + ' ' + form.last_name)
      onClose()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 480,
        boxShadow: '0 24px 60px rgba(0,0,0,0.18)' }}>
        <h3 className="text-[16px] font-bold text-slate-800 mb-5">Create New User</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First Name" value={form.first_name} onChange={v => setForm(f => ({ ...f, first_name: v }))} required />
            <Field label="Last Name"  value={form.last_name}  onChange={v => setForm(f => ({ ...f, last_name: v }))} />
          </div>
          <Field label="Email Address" type="email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} required />
          <SelectField label="Role" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))}>
            {roleChoices(roles, form.role).map(r => <option key={r.name} value={r.name}>{r.label || roleLabel(r.name)}</option>)}
          </SelectField>
          <Field label="Department" value={form.department} onChange={v => setForm(f => ({ ...f, department: v }))} />
          {err && <p className="text-[12px] text-red-600 bg-red-50 px-3 py-2 rounded-lg">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold border"
              style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#64748b' }}>
              Cancel
            </button>
            <button type="submit" disabled={creating}
              className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}>
              {creating ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UserManagement() {
  const [users, setUsers]     = useState<User[]>([])
  const [roles, setRoles]     = useState<RoleOption[]>(FALLBACK_ROLE_OPTIONS)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [search, setSearch]   = useState('')

  const [showCreate, setShowCreate]   = useState(false)
  const [newPwResult, setNewPwResult] = useState<{ name: string; pw: string } | null>(null)

  const [drawerUser, setDrawerUser] = useState<User | null>(null)

  const [delTarget, setDelTarget] = useState<User | null>(null)
  const [deleting, setDeleting]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [userRes, roleRes] = await Promise.all([
        apiFetch('/api/admin/users'),
        apiFetch('/api/admin/roles').catch(() => FALLBACK_ROLE_OPTIONS),
      ])
      setUsers(Array.isArray(userRes) ? userRes : (userRes.data ?? []))
      setRoles(normalizeRoleOptions(roleRes))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDelete() {
    if (!delTarget) return
    setDeleting(true)
    try {
      await apiDelete(`/api/admin/users/${delTarget.id}`)
      setDelTarget(null); load()
    } catch {}
    finally { setDeleting(false) }
  }

  const filtered = users.filter(u => {
    const q = search.toLowerCase()
    return !q
      || u.full_name.toLowerCase().includes(q)
      || u.email.toLowerCase().includes(q)
      || u.role.toLowerCase().includes(q)
      || (u.department || '').toLowerCase().includes(q)
  })

  const active   = users.filter(u => u.is_active && !u.deleted_at).length
  const inactive = users.filter(u => !u.is_active).length

  const cols: ColDef<User>[] = [
    {
      key: 'name', label: 'Name',
      render: r => (
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0"
            style={{ background: NAVY }}>
            {(r.first_name?.[0] || r.full_name?.[0] || '?').toUpperCase()}
            {(r.last_name?.[0] || '').toUpperCase()}
          </div>
          <div>
            <p className="text-[13px] font-semibold text-slate-800">
              {r.first_name || r.last_name
                ? `${r.first_name} ${r.last_name}`.trim()
                : r.full_name}
            </p>
            <p className="text-[11px] text-slate-400">{r.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role', label: 'Role',
      render: r => (
        <span className="text-[12px] font-medium text-slate-700">{roleLabel(r.role)}</span>
      ),
    },
    {
      key: 'department', label: 'Department',
      render: r => <span className="text-[12px] text-slate-500">{r.department || '—'}</span>,
    },
    {
      key: 'is_active', label: 'Status',
      render: r => (
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
          r.deleted_at ? 'bg-red-50 text-red-600'
          : r.is_active ? 'bg-green-50 text-green-700'
          : 'bg-amber-50 text-amber-700'
        }`}>
          <span className="w-1.5 h-1.5 rounded-full"
            style={{ background: r.deleted_at ? '#ef4444' : r.is_active ? '#22c55e' : '#f59e0b' }} />
          {r.deleted_at ? 'Removed' : r.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'last_login', label: 'Last Login',
      render: r => <span className="text-[11px] text-slate-400">{r.last_login ? fmtDate(r.last_login) : 'Never'}</span>,
    },
    {
      key: 'actions', label: '',
      render: r => (
        <div className="flex items-center gap-1 justify-end">
          <button onClick={() => setDrawerUser(r)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors hover:bg-slate-100"
            style={{ color: NAVY }}>
            <span className="material-symbols-rounded text-[13px]">manage_accounts</span>
            Manage
          </button>
          <button onClick={() => setDelTarget(r)}
            className="p-1.5 rounded-lg hover:bg-red-50 transition-colors"
            style={{ color: '#ef4444' }}>
            <span className="material-symbols-rounded text-[14px]">delete</span>
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page
      dept="Admin"
      title="User Management"
      subtitle="Manage platform access, roles, and audit trails"
      actions={
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold text-white"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[16px]">person_add</span>
          Add User
        </button>
      }>

      <ErrBanner msg={error} />

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <KpiCard label="Total Users"   value={String(users.length)} icon="group"             accent={NAVY}  loading={loading} />
        <KpiCard label="Active"        value={String(active)}       icon="check_circle"       accent={GREEN} loading={loading} />
        <KpiCard label="Inactive"      value={String(inactive)}     icon="pause_circle"       accent={AMBER} loading={loading} />
      </div>

      {/* Temp password banner */}
      {newPwResult && (
        <div className="rounded-xl p-4 mb-4 flex items-start gap-3"
          style={{ background: '#ECFDF5', border: '1px solid #A7F3D0' }}>
          <span className="material-symbols-rounded text-green-600 text-[20px] mt-0.5">key</span>
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-green-800">
              Account created for {newPwResult.name}
            </p>
            <p className="text-[12px] text-green-700 mt-0.5">
              Temporary password: <span className="font-mono font-bold tracking-widest">{newPwResult.pw}</span>
            </p>
            <p className="text-[11px] text-green-600 mt-0.5">Share this with the user — they must change it on first login.</p>
          </div>
          <button onClick={() => setNewPwResult(null)} className="text-green-500 hover:text-green-700">
            <span className="material-symbols-rounded text-[16px]">close</span>
          </button>
        </div>
      )}

      <SectionCard
        title="All Users"
        subtitle={`${filtered.length} of ${users.length}`}
        actions={
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[12px]"
            style={{ borderColor: 'rgba(15,23,42,0.12)' }}>
            <span className="material-symbols-rounded text-[14px] text-slate-400">search</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, email, role…"
              className="outline-none bg-transparent w-48 text-slate-700 placeholder-slate-300"
            />
          </div>
        }>
        <DataTable
          cols={cols}
          rows={filtered}
          loading={loading}
          emptyIcon="person_off"
          emptyMsg="No users found"
        />
      </SectionCard>

      {/* Modals */}
      {showCreate && (
        <CreateModal
          roles={roles}
          onClose={() => setShowCreate(false)}
          onCreated={(pw, name) => { setNewPwResult({ pw, name }); load() }}
        />
      )}

      {drawerUser && (
        <UserDrawer
          user={drawerUser}
          roles={roles}
          onClose={() => setDrawerUser(null)}
          onSaved={load}
        />
      )}

      {/* Delete confirm */}
      {delTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, width: '100%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 className="text-[15px] font-bold text-slate-800 mb-2">Remove User?</h3>
            <p className="text-[13px] text-slate-500 mb-6">
              <strong>{delTarget.full_name}</strong> ({delTarget.email}) will be deactivated and removed from the platform. This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDelTarget(null)}
                className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold border"
                style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#64748b' }}>
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}>
                {deleting ? 'Removing…' : 'Remove User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
