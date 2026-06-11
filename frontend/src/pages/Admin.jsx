import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'

/* All pages that can be granted to a custom role */
const ALL_PAGES = [
  { key: 'overview',       label: 'Overview' },
  { key: 'transactions',   label: 'Transactions' },
  { key: 'cards',          label: 'Cards' },
  { key: 'collections',    label: 'Collections' },
  { key: 'recovery',       label: 'Recovery' },
  { key: 'income',         label: 'Income Report' },
  { key: 'eod',            label: 'EOD Report' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'call_center',    label: 'Call Center' },
  { key: 'cohort',         label: 'Cohort' },
  { key: 'uploads',        label: 'Data Uploads' },
  { key: 'admin',          label: 'Admin / Settings' },
  { key: 'crm_pipeline',   label: 'CRM Pipeline' },
  { key: 'crm_contacts',   label: 'CRM Contacts' },
  { key: 'crm_tasks',      label: 'CRM Tasks' },
  { key: 'crm_requests',   label: 'CRM Requests' },
  { key: 'crm_reports',    label: 'CRM Reports' },
]

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

const ROLES = [
  // Executive
  { value: 'md',               label: 'MD / CEO',            group: 'Executive',   desc: 'Managing Director — all dashboards',                  icon: 'stars' },
  { value: 'coo',              label: 'COO',                  group: 'Executive',   desc: 'Chief Operating Officer — operations reports',        icon: 'account_tree' },
  { value: 'cfo',              label: 'CFO',                  group: 'Executive',   desc: 'Chief Financial Officer — financial reports',         icon: 'finance' },
  { value: 'cmo',              label: 'CMO',                  group: 'Executive',   desc: 'Chief Marketing Officer — sales & CRM',               icon: 'campaign' },
  // Unit Heads
  { value: 'head_it',          label: 'Head of IT',           group: 'Unit Heads',  desc: 'Full access including admin settings',                icon: 'computer' },
  { value: 'head_ops',         label: 'Head of Operations',   group: 'Unit Heads',  desc: 'Operations, cards, transactions & income',           icon: 'precision_manufacturing' },
  { value: 'head_hr',          label: 'Head of HR',           group: 'Unit Heads',  desc: 'Overview and sales metrics',                         icon: 'people' },
  { value: 'head_sales',       label: 'Head of Sales',        group: 'Unit Heads',  desc: 'Sales, CRM pipeline and executive reports',          icon: 'trending_up' },
  { value: 'head_collections', label: 'Head of Collections',  group: 'Unit Heads',  desc: 'Collections, recovery & executive reports',          icon: 'account_balance_wallet' },
  { value: 'head_recovery',    label: 'Head of Recovery',     group: 'Unit Heads',  desc: 'Recovery, collections & executive reports',          icon: 'gavel' },
  // Junior Staff
  { value: 'admin',            label: 'Admin',                group: 'Staff', desc: 'Full system access including settings',              icon: 'admin_panel_settings' },
  { value: 'management',       label: 'Management',           group: 'Staff', desc: 'All reports, read-only',                            icon: 'groups' },
  { value: 'sales',            label: 'Sales',                group: 'Staff', desc: 'Sales, Overview and CRM',                           icon: 'sell' },
  { value: 'cards_ops',        label: 'Cards Ops',            group: 'Staff', desc: 'Cards, Transactions & Overview',                    icon: 'credit_card' },
  { value: 'collections',      label: 'Collections',          group: 'Staff', desc: 'Collections & Recovery',                            icon: 'receipt_long' },
  { value: 'recovery',         label: 'Recovery',             group: 'Staff', desc: 'Recovery & Collections',                            icon: 'handshake' },
  { value: 'call_centre',      label: 'Call Centre',          group: 'Staff', desc: 'Overview, Transactions & Call Center module',       icon: 'headset_mic' },
]

const DEPARTMENTS = [
  'Technology', 'Management', 'Executive', 'Sales', 'Collections',
  'Recovery', 'Call Centre', 'Finance', 'Operations', 'HR',
]

const ROLE_ACCESS = {
  md:               ['Overview','Transactions','Cards','Collections','Recovery','Cohort','Executive','Income','Reconciliation','Call Center','Uploads','Sales & CRM'],
  coo:              ['Overview','Transactions','Cards','Collections','Recovery','Cohort','Executive','Income','Reconciliation','Call Center','Uploads','Sales & CRM'],
  cfo:              ['Overview','Income','Collections','Recovery','Executive','Transactions','Reconciliation','Uploads'],
  cmo:              ['Overview','Executive','Uploads','Sales & CRM'],
  head_it:          ['Overview','Transactions','Cards','Collections','Recovery','Cohort','Executive','Income','Reconciliation','Call Center','Uploads','Settings','Sales & CRM'],
  head_ops:         ['Overview','Transactions','Cards','Cohort','Executive','Income','Reconciliation','Uploads','CRM'],
  head_hr:          ['Overview','Sales','Uploads'],
  head_sales:       ['Overview','Executive','Uploads','Sales & CRM'],
  head_collections: ['Collections','Recovery','Overview','Executive','Reconciliation','Uploads','CRM'],
  head_recovery:    ['Recovery','Collections','Overview','Executive','Uploads','CRM'],
  admin:            ['Overview','Transactions','Cards','Collections','Recovery','Cohort','Executive','Income','Reconciliation','Call Center','Uploads','Settings','Sales & CRM'],
  management:       ['Overview','Transactions','Cards','Collections','Recovery','Cohort','Executive','Income','Reconciliation','Call Center','Uploads','Sales & CRM'],
  sales:            ['Overview','Uploads','Sales & CRM'],
  cards_ops:        ['Cards','Transactions','Overview','Uploads'],
  collections:      ['Collections','Recovery','Reconciliation','Uploads','CRM'],
  recovery:         ['Recovery','Collections','Uploads','CRM'],
  call_centre:      ['Overview','Transactions','Call Center','Uploads'],
}

const ROLE_COLOUR = {
  md:               'bg-indigo-50    text-indigo-700  dark:bg-indigo-900/20   dark:text-indigo-300',
  coo:              'bg-violet-50    text-violet-700  dark:bg-violet-900/20   dark:text-violet-300',
  cfo:              'bg-emerald-50   text-emerald-700 dark:bg-emerald-900/20  dark:text-emerald-400',
  cmo:              'bg-fuchsia-50   text-fuchsia-700 dark:bg-fuchsia-900/20  dark:text-fuchsia-300',
  head_it:          'bg-sky-50       text-sky-700     dark:bg-sky-900/20      dark:text-sky-300',
  head_ops:         'bg-cyan-50      text-cyan-700    dark:bg-cyan-900/20     dark:text-cyan-300',
  head_hr:          'bg-pink-50      text-pink-700    dark:bg-pink-900/20     dark:text-pink-300',
  head_sales:       'bg-teal-50      text-teal-700    dark:bg-teal-900/20     dark:text-teal-400',
  head_collections: 'bg-amber-50     text-amber-700   dark:bg-amber-900/20    dark:text-amber-400',
  head_recovery:    'bg-orange-50    text-orange-700  dark:bg-orange-900/20   dark:text-orange-400',
  admin:            'bg-primary-50   text-primary     dark:bg-primary/20      dark:text-blue-300',
  management:       'bg-purple-50    text-purple-700  dark:bg-purple-900/20   dark:text-purple-300',
  sales:            'bg-teal-50      text-teal-700    dark:bg-teal-900/20     dark:text-teal-400',
  cards_ops:        'bg-blue-50      text-blue-700    dark:bg-blue-900/20     dark:text-blue-300',
  collections:      'bg-amber-50     text-amber-700   dark:bg-amber-900/20    dark:text-amber-400',
  recovery:         'bg-red-50       text-red-700     dark:bg-red-900/20      dark:text-red-400',
  call_centre:      'bg-slate-100    text-slate-600   dark:bg-slate-700       dark:text-slate-300',
}

const EMPTY_FORM = { full_name: '', email: '', role: 'call_centre', department: 'Operations' }

/* ═══════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════ */

function Avatar({ name, email }) {
  const initials = (name || email || '?').split(' ').slice(0, 2).map(w => w[0]?.toUpperCase()).join('')
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
      style={{ backgroundColor: 'rgb(var(--navy))' }}>
      {initials}
    </div>
  )
}

function RoleBadge({ role }) {
  const label = ROLES.find(r => r.value === role)?.label || role
  return <span className={`badge ${ROLE_COLOUR[role] || 'badge-grey'} capitalize`}>{label}</span>
}

function AccessChips({ role }) {
  const pages = ROLE_ACCESS[role] || []
  const visible = pages.slice(0, 3)
  const overflow = pages.length - visible.length
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map(p => <span key={p} className="badge badge-grey">{p}</span>)}
      {overflow > 0 && <span className="badge badge-grey">+{overflow}</span>}
    </div>
  )
}

/* ── Generated-password banner ── */
function TempPasswordBanner({ password, onDismiss }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(password)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="rounded-xl px-5 py-4 mb-5"
      style={{ background: 'rgb(16 185 129 / 0.07)', border: '1px solid rgb(16 185 129 / 0.2)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="material-symbols-rounded text-[18px] text-emerald-600 flex-shrink-0 mt-0.5">check_circle</span>
          <div>
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">User created successfully</p>
            <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
              Share this temporary password with the new user. They will be prompted to change it on first login.
            </p>
            <div className="flex items-center gap-2 mt-2.5">
              <code className="px-3 py-1.5 rounded-lg text-sm font-mono font-semibold tracking-wide"
                style={{ background: 'rgb(16 185 129 / 0.12)', color: '#065F46' }}>
                {password}
              </code>
              <button onClick={copy}
                className="btn btn-ghost btn-sm gap-1.5 text-emerald-700 hover:bg-emerald-100/50">
                <span className="material-symbols-rounded text-[14px]">
                  {copied ? 'check' : 'content_copy'}
                </span>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
        <button onClick={onDismiss} className="btn-icon flex-shrink-0">
          <span className="material-symbols-rounded text-[18px] text-slate-400">close</span>
        </button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   USER MODAL (create + edit)
   ═══════════════════════════════════════════════════════════════ */

function UserModal({ mode, userId, initial, onSave, onClose, customRoles = [] }) {
  const [form,        setForm]       = useState(initial)
  const [error,       setError]      = useState('')
  const [saving,      setSaving]     = useState(false)
  const [isCustom,    setIsCustom]   = useState(false)
  const [customLabel, setCustomLabel]= useState('')
  const [customPages, setCustomPages]= useState([])
  const isCreate = mode === 'create'

  const allRoles     = [...ROLES, ...customRoles.map(r => ({ value: r.name, label: r.label, group: 'Custom', desc: `Custom role — ${r.pages?.length || 0} pages`, icon: 'badge' }))]
  const selectedRole = allRoles.find(r => r.value === form.role)
  const execRoles    = ROLES.filter(r => r.group === 'Executive')
  const headRoles    = ROLES.filter(r => r.group === 'Unit Heads')
  const staffRoles   = ROLES.filter(r => r.group === 'Staff')

  function togglePage(key) {
    setCustomPages(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }

  async function handleSave() {
    if (!form.full_name.trim() || !form.email.trim()) { setError('Name and email are required.'); return }
    if (isCustom && !customLabel.trim()) { setError('Custom role name is required.'); return }
    setSaving(true); setError('')
    try {
      let roleToUse = form.role
      if (isCustom) {
        const slug = customLabel.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
        await apiFetch('/api/admin/roles', {
          method: 'POST',
          body: JSON.stringify({ name: slug, label: customLabel.trim(), pages: customPages }),
        })
        roleToUse = slug
      }
      const payload = { ...form, role: roleToUse }
      let result
      if (isCreate) {
        result = await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) })
      } else {
        const body = { ...payload }
        if (!body.password) delete body.password
        result = await apiFetch(`/api/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify(body) })
      }
      onSave(result)
    } catch (e) {
      setError(e.message || 'Failed to save user.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg animate-fade-in"
        style={{ background: 'rgb(var(--bg-surface))', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-xl)', border: '1px solid rgb(var(--border) / 0.08)' }}>

        <div className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">
              {isCreate ? 'New User' : 'Edit User'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isCreate
                ? 'A temporary password will be generated automatically'
                : 'Update account details and permissions'}
            </p>
          </div>
          <button onClick={onClose} className="btn-icon">
            <span className="material-symbols-rounded text-[20px]">close</span>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm"
              style={{ background: 'rgb(239 68 68 / 0.06)', border: '1px solid rgb(239 68 68 / 0.15)', color: '#DC2626' }}>
              <span className="material-symbols-rounded text-[16px] flex-shrink-0">error</span>
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Full Name *</label>
              <input value={form.full_name}
                onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                placeholder="e.g. Amara Okonkwo" className="form-input" autoFocus />
            </div>
            <div>
              <label className="form-label">Email *</label>
              <input type="email" value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="user@o3cards.com" className="form-input" />
            </div>
          </div>

          {/* Only show manual password on edit */}
          {!isCreate && (
            <div>
              <label className="form-label">
                Password
                <span className="font-normal text-slate-400 ml-1">(leave blank to keep current)</span>
              </label>
              <input type="password" value={form.password || ''}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="••••••••" className="form-input" />
            </div>
          )}

          {isCreate && (
            <div className="flex items-center gap-2.5 rounded-lg px-4 py-3 text-xs"
              style={{ background: 'rgb(var(--bg-subtle))', color: 'rgb(var(--fg-3))' }}>
              <span className="material-symbols-rounded text-[15px]">key</span>
              A temporary password will be generated and shown after creation. The user must change it on first login.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Role *</label>
              {!isCustom ? (
                <>
                  <select value={form.role}
                    onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                    className="form-input">
                    <optgroup label="Executive">
                      {execRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </optgroup>
                    <optgroup label="Unit Heads">
                      {headRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </optgroup>
                    <optgroup label="Staff">
                      {staffRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </optgroup>
                    {customRoles.length > 0 && (
                      <optgroup label="Custom">
                        {customRoles.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
                      </optgroup>
                    )}
                  </select>
                  {selectedRole && <p className="text-xs text-slate-400 mt-1">{selectedRole.desc}</p>}
                  <button type="button" onClick={() => setIsCustom(true)}
                    className="text-xs text-primary dark:text-primary-100 mt-1 hover:underline">
                    + Create new role
                  </button>
                </>
              ) : (
                <div className="space-y-2">
                  <input
                    value={customLabel}
                    onChange={e => setCustomLabel(e.target.value)}
                    placeholder="e.g. Head of BI"
                    className="form-input"
                    autoFocus
                  />
                  <button type="button" onClick={() => setIsCustom(false)}
                    className="text-xs text-slate-400 hover:underline">
                    ← Pick existing role
                  </button>
                  <div className="rounded-lg p-3" style={{ background: 'rgb(var(--bg-subtle))', border: '1px solid rgb(var(--border) / 0.08)' }}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'rgb(var(--fg-3))' }}>Page access</p>
                    <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                      {ALL_PAGES.map(p => (
                        <label key={p.key} className="flex items-center gap-2 cursor-pointer text-xs py-0.5">
                          <input type="checkbox" checked={customPages.includes(p.key)}
                            onChange={() => togglePage(p.key)}
                            className="rounded" />
                          {p.label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div>
              <label className="form-label">Department</label>
              <select value={form.department}
                onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                className="form-input">
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          {/* Access preview */}
          <div className="rounded-lg px-4 py-3"
            style={{ background: 'rgb(var(--bg-subtle))', border: '1px solid rgb(var(--border) / 0.06)' }}>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'rgb(var(--fg-3))' }}>
              Page access for this role
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(ROLE_ACCESS[form.role] || []).map(p => (
                <span key={p} className="badge badge-navy">{p}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 rounded-b-xl"
          style={{ borderTop: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--bg-subtle))' }}>
          <button onClick={onClose} className="btn btn-ghost text-sm px-4 py-2">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="btn btn-primary gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
            {saving ? (
              <><div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: 'white' }} />Saving…</>
            ) : (
              <><span className="material-symbols-rounded text-[16px]">{isCreate ? 'person_add' : 'save'}</span>{isCreate ? 'Create User' : 'Save Changes'}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   DELETE MODAL
   ═══════════════════════════════════════════════════════════════ */

function DeleteModal({ user, onConfirm, onClose, deleting }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm animate-fade-in"
        style={{ background: 'rgb(var(--bg-surface))', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-xl)', border: '1px solid rgb(var(--border) / 0.08)' }}>
        <div className="px-6 py-6">
          <div className="flex items-center gap-3.5 mb-4">
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgb(239 68 68 / 0.08)' }}>
              <span className="material-symbols-rounded text-[20px] text-red-500">delete</span>
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">Remove Staff Member</h2>
              <p className="text-xs text-slate-400 mt-0.5">They cannot log in — historical data is preserved</p>
            </div>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            You're about to permanently delete{' '}
            <span className="font-semibold text-slate-800 dark:text-slate-200">{user?.full_name || user?.email}</span>.
            They will lose all access immediately.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 rounded-b-xl"
          style={{ borderTop: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--bg-subtle))' }}>
          <button onClick={onClose} className="btn btn-ghost text-sm px-4 py-2">Cancel</button>
          <button onClick={onConfirm} disabled={deleting}
            className="btn gap-2 text-sm font-semibold text-white px-4 py-2 disabled:opacity-60"
            style={{ background: '#DC2626', borderRadius: 'var(--r-md)' }}>
            {deleting
              ? <><div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: 'white' }} />Deleting…</>
              : <><span className="material-symbols-rounded text-[16px]">delete</span>Delete User</>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   RESET PASSWORD MODAL
   ═══════════════════════════════════════════════════════════════ */

function ResetPasswordModal({ user, onDone, onClose }) {
  const [loading,  setLoading]  = useState(false)
  const [tempPw,   setTempPw]   = useState(null)
  const [copied,   setCopied]   = useState(false)

  async function doReset() {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' })
      setTempPw(res.temp_password)
    } catch (e) {
      onClose()
    } finally {
      setLoading(false)
    }
  }

  function copy() {
    navigator.clipboard.writeText(tempPw)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm animate-fade-in"
        style={{ background: 'rgb(var(--bg-surface))', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-xl)', border: '1px solid rgb(var(--border) / 0.08)' }}>
        <div className="px-6 py-6">
          <div className="flex items-center gap-3.5 mb-4">
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgb(245 158 11 / 0.1)' }}>
              <span className="material-symbols-rounded text-[20px] text-amber-500">lock_reset</span>
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">Reset Password</h2>
              <p className="text-xs text-slate-400 mt-0.5">{user?.full_name}</p>
            </div>
          </div>

          {!tempPw ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              This will reset their password to the default and require them to change it on next login.
            </p>
          ) : (
            <div>
              <p className="text-sm text-emerald-700 dark:text-emerald-400 mb-3">
                Password reset successfully. Share this temporary password with the user:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono font-semibold tracking-wide"
                  style={{ background: 'rgb(var(--bg-subtle))', color: 'rgb(var(--fg-1))' }}>
                  {tempPw}
                </code>
                <button onClick={copy} className="btn btn-ghost btn-sm gap-1">
                  <span className="material-symbols-rounded text-[14px]">{copied ? 'check' : 'content_copy'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 rounded-b-xl"
          style={{ borderTop: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--bg-subtle))' }}>
          {tempPw ? (
            <button onClick={() => { onDone(); onClose() }} className="btn btn-primary gap-2">
              <span className="material-symbols-rounded text-[16px]">check</span>Done
            </button>
          ) : (
            <>
              <button onClick={onClose} className="btn btn-ghost text-sm px-4 py-2">Cancel</button>
              <button onClick={doReset} disabled={loading}
                className="btn gap-2 text-sm font-semibold text-white px-4 py-2 disabled:opacity-60"
                style={{ background: '#D97706', borderRadius: 'var(--r-md)' }}>
                {loading
                  ? <><div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: 'white' }} />Resetting…</>
                  : <><span className="material-symbols-rounded text-[16px]">lock_reset</span>Reset Password</>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════ */

export default function Admin() {
  const [users,          setUsers]          = useState([])
  const [customRoles,    setCustomRoles]    = useState([])
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState(null)
  const [modal,          setModal]          = useState(null)
  const [deleteTarget,   setDeleteTarget]   = useState(null)
  const [resetTarget,    setResetTarget]    = useState(null)
  const [deleting,       setDeleting]       = useState(false)
  const [search,         setSearch]         = useState('')
  const [tempPwBanner,   setTempPwBanner]   = useState(null)
  const [activity,       setActivity]       = useState([])
  const [activityLoad,   setActivityLoad]   = useState(false)
  const [activitySearch, setActivitySearch] = useState('')

  async function loadUsers() {
    setLoading(true); setError(null)
    try {
      const [u, r] = await Promise.all([
        apiFetch('/api/admin/users'),
        apiFetch('/api/admin/roles').catch(() => []),
      ])
      setUsers(u)
      setCustomRoles(r)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadActivity() {
    setActivityLoad(true)
    try {
      const rows = await apiFetch('/api/admin/activity?limit=500')
      setActivity(rows)
    } catch { /* non-critical */ } finally {
      setActivityLoad(false)
    }
  }

  useEffect(() => { loadUsers(); loadActivity() }, [])

  async function handleDelete() {
    setDeleting(true)
    try {
      await apiFetch(`/api/admin/users/${deleteTarget.id}/remove`, { method: 'PATCH' })
      setDeleteTarget(null)
      await loadUsers()
    } catch (e) {
      setError(e.message)
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  function handleCreateSave(result) {
    setModal(null)
    if (result?.temp_password) setTempPwBanner(result.temp_password)
    loadUsers()
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

  const pendingCount = users.filter(u => u.must_change_password).length
  const totalUsers   = users.length
  const adminCount   = users.filter(u => u.role === 'admin' || u.role === 'head_it').length
  const deptCount    = [...new Set(users.map(u => u.department).filter(Boolean))].length

  const STATS = [
    { icon: 'group',               label: 'Total Users',      value: totalUsers },
    { icon: 'admin_panel_settings',label: 'Admins & IT',      value: adminCount },
    { icon: 'lock_clock',          label: 'Pending First Login', value: pendingCount, warn: pendingCount > 0 },
    { icon: 'apartment',           label: 'Departments',      value: deptCount },
  ]

  return (
    <PageShell
      title="Settings"
      subtitle="Manage user accounts, roles and department access"
      error={error}
      actions={
        <button onClick={() => setModal({ mode: 'create', initial: EMPTY_FORM })}
          className="btn btn-primary gap-2 text-sm">
          <span className="material-symbols-rounded text-[17px]">person_add</span>New User
        </button>
      }
    >
      {tempPwBanner && (
        <TempPasswordBanner password={tempPwBanner} onDismiss={() => setTempPwBanner(null)} />
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STATS.map(s => (
          <div key={s.label} className="card p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: s.warn ? 'rgb(245 158 11 / 0.1)' : 'rgb(var(--navy) / 0.07)' }}>
              <span className="material-symbols-rounded text-[20px]"
                style={{ color: s.warn ? '#D97706' : 'rgb(var(--navy))' }}>{s.icon}</span>
            </div>
            <div>
              <p className="text-[22px] font-semibold leading-none text-slate-900 dark:text-white tabular-nums">
                {s.value}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Role distribution */}
      <div className="card mt-4 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: 'rgb(var(--fg-3))' }}>
          Role distribution
        </p>
        {[
          ['Executive', ROLES.filter(r => r.group === 'Executive')],
          ['Unit Heads', ROLES.filter(r => r.group === 'Unit Heads')],
          ['Staff', ROLES.filter(r => r.group === 'Staff')],
        ].map(([group, roles]) => (
          <div key={group} className="mb-3 last:mb-0">
            <p className="text-[10px] text-slate-400 uppercase tracking-widest mb-2">{group}</p>
            <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-7 gap-2">
              {roles.map(r => {
                const count = users.filter(u => u.role === r.value).length
                return (
                  <div key={r.value} className="rounded-lg px-3 py-2.5 text-center"
                    style={{ background: 'rgb(var(--bg-subtle))' }}>
                    <span className="material-symbols-rounded text-[16px] text-slate-400 dark:text-slate-500">{r.icon}</span>
                    <p className="text-lg font-semibold leading-tight mt-1 text-slate-800 dark:text-slate-100">{count}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">{r.label}</p>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* User table */}
      <div className="card mt-4 overflow-hidden">
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
              style={{ color: 'rgb(var(--fg-3))' }}>search</span>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search users…" className="form-input pl-8 py-1.5 text-xs w-44" />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-3 py-16" style={{ color: 'rgb(var(--fg-3))' }}>
            <div className="spinner" /><span className="text-sm">Loading users…</span>
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
                  <th>Last Login</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={7}>
                    <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: 'rgb(var(--fg-3))' }}>
                      <span className="material-symbols-rounded text-[36px] opacity-30">group</span>
                      <p className="text-sm">No users found</p>
                    </div>
                  </td></tr>
                ) : filtered.map(u => (
                  <tr key={u.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <Avatar name={u.full_name} email={u.email} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{u.full_name}</p>
                          <p className="text-xs text-slate-400 truncate">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td><RoleBadge role={u.role} /></td>
                    <td className="text-sm" style={{ color: 'rgb(var(--fg-2))' }}>{u.department || '—'}</td>
                    <td><AccessChips role={u.role} /></td>
                    <td className="text-xs whitespace-nowrap" style={{ color: 'rgb(var(--fg-3))' }}>
                      {u.last_login
                        ? new Date(u.last_login).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
                        : <span className="text-slate-300 dark:text-slate-600">Never</span>}
                    </td>
                    <td>
                      {u.must_change_password ? (
                        <span className="badge text-xs bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 gap-1">
                          <span className="material-symbols-rounded text-[11px]">schedule</span>
                          First login pending
                        </span>
                      ) : u.is_active === false ? (
                        <span className="badge text-xs bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 gap-1">
                          <span className="material-symbols-rounded text-[11px]">block</span>
                          Deactivated
                        </span>
                      ) : (
                        <span className="badge text-xs bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 gap-1">
                          <span className="material-symbols-rounded text-[11px]">check_circle</span>
                          Active
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          onClick={() => setModal({ mode: 'edit', id: u.id, initial: { full_name: u.full_name, email: u.email, password: '', role: u.role, department: u.department || 'Operations' } })}
                          className="icon-btn" title="Edit user">
                          <span className="material-symbols-rounded text-[16px]">edit</span>
                        </button>
                        <button
                          onClick={() => setResetTarget(u)}
                          className="icon-btn" title="Reset password"
                          style={{ color: '#D97706' }}>
                          <span className="material-symbols-rounded text-[16px]">lock_reset</span>
                        </button>
                        {u.is_active !== false ? (
                          <button
                            onClick={async () => { await apiFetch(`/api/admin/users/${u.id}/deactivate`, { method: 'PATCH' }); loadUsers() }}
                            className="icon-btn" title="Deactivate — blocks login, preserves data"
                            style={{ color: '#D97706' }}>
                            <span className="material-symbols-rounded text-[16px]">block</span>
                          </button>
                        ) : (
                          <button
                            onClick={async () => { await apiFetch(`/api/admin/users/${u.id}/reactivate`, { method: 'PATCH' }); loadUsers() }}
                            className="icon-btn" title="Reactivate"
                            style={{ color: '#059669' }}>
                            <span className="material-symbols-rounded text-[16px]">check_circle</span>
                          </button>
                        )}
                        <button
                          onClick={() => setDeleteTarget(u)}
                          className="icon-btn" title="Remove from system (soft-delete, data preserved)"
                          style={{ color: '#F87171' }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'rgb(239 68 68 / 0.07)'; e.currentTarget.style.color = '#DC2626' }}
                          onMouseLeave={e => { e.currentTarget.style.background = ''; e.currentTarget.style.color = '#F87171' }}>
                          <span className="material-symbols-rounded text-[16px]">person_remove</span>
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

      {/* Staff Activity */}
      <div className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between gap-4 px-5 py-4"
          style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-rounded text-[18px]" style={{ color: 'rgb(var(--navy))' }}>monitoring</span>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Staff Activity</p>
            <span className="px-1.5 py-0.5 text-xs font-normal rounded-full"
              style={{ background: 'rgb(var(--bg-subtle))', color: 'rgb(var(--fg-3))' }}>
              {activity.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <span className="material-symbols-rounded text-[15px] pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{ color: 'rgb(var(--fg-3))' }}>search</span>
              <input value={activitySearch} onChange={e => setActivitySearch(e.target.value)}
                placeholder="Filter by user or page…" className="form-input pl-8 py-1.5 text-xs w-48" />
            </div>
            <button onClick={loadActivity} className="icon-btn" title="Refresh">
              <span className="material-symbols-rounded text-[16px]">refresh</span>
            </button>
          </div>
        </div>
        {activityLoad ? (
          <div className="flex items-center justify-center gap-3 py-10" style={{ color: 'rgb(var(--fg-3))' }}>
            <div className="spinner" /><span className="text-sm">Loading activity…</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Page</th>
                  <th>Action</th>
                  <th>Detail</th>
                  <th>IP</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {activity.filter(a => {
                  const q = activitySearch.toLowerCase()
                  return !q || a.full_name?.toLowerCase().includes(q) || a.page?.toLowerCase().includes(q) || a.action?.toLowerCase().includes(q)
                }).length === 0 ? (
                  <tr><td colSpan={6}>
                    <div className="flex flex-col items-center justify-center py-10 gap-2" style={{ color: 'rgb(var(--fg-3))' }}>
                      <span className="material-symbols-rounded text-[36px] opacity-30">monitoring</span>
                      <p className="text-sm">No activity recorded yet</p>
                    </div>
                  </td></tr>
                ) : activity.filter(a => {
                  const q = activitySearch.toLowerCase()
                  return !q || a.full_name?.toLowerCase().includes(q) || a.page?.toLowerCase().includes(q) || a.action?.toLowerCase().includes(q)
                }).slice(0, 200).map(a => (
                  <tr key={a.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <Avatar name={a.full_name} email={a.email} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{a.full_name || '—'}</p>
                          <p className="text-xs text-slate-400 truncate">{a.email || ''}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="badge badge-grey capitalize text-xs">{a.page || '—'}</span>
                    </td>
                    <td className="text-xs capitalize" style={{ color: 'rgb(var(--fg-2))' }}>{a.action || 'view'}</td>
                    <td className="text-xs max-w-[200px] truncate" style={{ color: 'rgb(var(--fg-3))' }} title={a.detail}>{a.detail || '—'}</td>
                    <td className="text-xs font-mono" style={{ color: 'rgb(var(--fg-3))' }}>{a.ip || '—'}</td>
                    <td className="text-xs whitespace-nowrap" style={{ color: 'rgb(var(--fg-3))' }}>
                      {a.ts ? new Date(a.ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modals */}
      {modal && (
        <UserModal
          mode={modal.mode}
          userId={modal.id}
          initial={modal.initial}
          customRoles={customRoles}
          onSave={modal.mode === 'create' ? handleCreateSave : () => { setModal(null); loadUsers() }}
          onClose={() => setModal(null)}
        />
      )}
      {deleteTarget && (
        <DeleteModal user={deleteTarget} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} deleting={deleting} />
      )}
      {resetTarget && (
        <ResetPasswordModal user={resetTarget} onDone={loadUsers} onClose={() => setResetTarget(null)} />
      )}
    </PageShell>
  )
}
