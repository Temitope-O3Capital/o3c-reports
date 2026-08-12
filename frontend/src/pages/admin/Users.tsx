import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, ExpandableFilterBar, ConfirmModal, NameCell, ActionRow, StatusBadge, avatarColor, nameInitials } from '../../components/UI'
import type { TableCol, RowAction } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'
import { roleLabel } from '../../lib/roles'

// ── Types ─────────────────────────────────────────────────────────────────────

interface User {
  id: number
  email: string
  full_name: string
  first_name: string
  last_name: string
  role: string
  extra_roles?: string[]
  department: string
  is_active: boolean
  must_change_password: boolean
  last_login?: string
  created_at: string
}

// Normalize extra_roles, which the users-list API returns as a JSON *string*
// (jsonb stringified by the db layer) while login returns it as a real array.
function asRoleArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[]
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEPARTMENTS = ['Finance', 'Operations', 'IT', 'HR', 'Sales & BD', 'Collections', 'Recovery', 'Compliance', 'Customer Service', 'Cards']


// ── Role options come from the backend (/api/admin/roles) so the dropdowns always
// reflect the live role registry — the clean built-in taxonomy AND any custom
// roles — instead of a hardcoded list that drifts. Cached module-wide.
interface RoleOpt { name: string; label: string }
let _rolesCache: RoleOpt[] | null = null
let _rolesPromise: Promise<RoleOpt[]> | null = null
function roleTier(name: string): { k: number; label: string } {
  if (name === 'admin') return { k: 0, label: 'Super Admin' }
  if (['md', 'coo', 'cfo', 'cmo'].includes(name)) return { k: 1, label: 'Executive' }
  if (['it_admin', 'bi_head', 'bi_analyst'].includes(name)) return { k: 2, label: 'IT & Analytics' }
  if (/_head$/.test(name)) return { k: 3, label: 'Department Heads' }
  if (/(_officer|_agent)$/.test(name)) return { k: 4, label: 'Officers & Agents' }
  return { k: 5, label: 'Other roles' }
}
function buildRoleGroups(roles: RoleOpt[]): { label: string; roles: RoleOpt[] }[] {
  const byTier = new Map<number, { label: string; roles: RoleOpt[] }>()
  for (const r of roles) {
    const t = roleTier(r.name)
    if (!byTier.has(t.k)) byTier.set(t.k, { label: t.label, roles: [] })
    byTier.get(t.k)!.roles.push(r)
  }
  return [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => ({
    label: g.label, roles: g.roles.sort((a, b) => a.label.localeCompare(b.label)),
  }))
}
function useRoleGroups() {
  const [roles, setRoles] = useState<RoleOpt[] | null>(_rolesCache)
  useEffect(() => {
    if (_rolesCache) { setRoles(_rolesCache); return }
    if (!_rolesPromise) {
      _rolesPromise = apiFetch<any>('/api/admin/roles')
        .then(r => { _rolesCache = (Array.isArray(r) ? r : []).map((x: any) => ({ name: x.name, label: x.label || roleLabel(x.name) })); return _rolesCache! })
        .catch(() => { _rolesPromise = null; return [] })
    }
    _rolesPromise.then(setRoles)
  }, [])
  return useMemo(() => buildRoleGroups(roles ?? []), [roles])
}

function RoleSelect({ value, onChange, style }: { value: string; onChange: (v: string) => void; style?: React.CSSProperties }) {
  const groups = useRoleGroups()
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={style}>
      {value && !groups.some(g => g.roles.some(r => r.name === value)) && <option value={value}>{roleLabel(value)}</option>}
      {groups.map(g => (
        <optgroup key={g.label} label={g.label}>
          {g.roles.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

// Multi-select for secondary (multi-team) roles: shows chosen roles as removable
// chips plus a grouped "add" dropdown. Excludes the primary role and duplicates.
function MultiRoleSelect({ value, exclude, onChange, style }: {
  value: string[]; exclude: string; onChange: (v: string[]) => void; style?: React.CSSProperties
}) {
  const groups = useRoleGroups()
  return (
    <div>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {value.map(r => (
            <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: TEXT.xs, fontWeight: FW.semibold, background: `${NAVY}12`, color: NAVY, borderRadius: RADIUS.lg, padding: '2px 4px 2px 9px' }}>
              {roleLabel(r)}
              <span className="material-symbols-rounded" onClick={() => onChange(value.filter(x => x !== r))}
                style={{ fontSize: 15, cursor: 'pointer', opacity: 0.7 }} title="Remove">close</span>
            </span>
          ))}
        </div>
      )}
      <select value="" onChange={e => { const v = e.target.value; if (v && v !== exclude && !value.includes(v)) onChange([...value, v]) }} style={style}>
        <option value="">+ Add another team…</option>
        {groups.map(g => {
          const opts = g.roles.filter(r => r.name !== exclude && !value.includes(r.name))
          if (opts.length === 0) return null
          return (
            <optgroup key={g.label} label={g.label}>
              {opts.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
            </optgroup>
          )
        })}
      </select>
    </div>
  )
}


function RolePill({ role }: { role: string }) {
  const colorFor = (r: string) => {
    if (r.includes('admin') || r === 'it_admin' || r === 'head_it') return NAVY
    if (r.includes('head') || r === 'md' || r === 'coo' || r === 'cfo') return BLUE
    if (r.includes('finance')) return '#0891B2'
    if (r.includes('risk')) return '#7C3AED'
    if (r.includes('hr')) return '#DB2777'
    if (r.includes('compliance')) return AMBER
    return '#6B7280'
  }
  const c = colorFor(role)
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, background: `${c}15`, color: c, borderRadius: RADIUS.lg, padding: '2px 9px', whiteSpace: 'nowrap' }}>
      {roleLabel(role)}
    </span>
  )
}

// ── Invite User modal ─────────────────────────────────────────────────────────

function InviteModal({ onClose, onSaved }: {
  onClose: () => void; onSaved: (pw: string, name: string) => void
}) {
  const EMAIL_DOMAIN = '@o3ccards.com'
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', role: 'call_center_agent', department: 'Operations' })
  const [extraRoles, setExtraRoles] = useState<string[]>([])
  const [emailEdited, setEmailEdited] = useState(false)
  const [saving, setSaving] = useState(false)

  // Company email convention: first initial + last name, e.g. Kwame Nahibi → knahibi@o3cards.com.
  function autoEmail(first: string, last: string): string {
    const local = ((first.trim().charAt(0) || '') + last.trim()).toLowerCase().replace(/[^a-z0-9.]/g, '')
    return local ? local + EMAIL_DOMAIN : ''
  }

  function field(k: keyof typeof form, v: string) {
    if (k === 'email') { setEmailEdited(true); setForm(f => ({ ...f, email: v })); return }
    setForm(f => {
      const next = { ...f, [k]: v }
      // Auto-fill the email from the name until the admin edits it directly.
      if (!emailEdited && (k === 'first_name' || k === 'last_name')) {
        const derived = autoEmail(k === 'first_name' ? v : f.first_name, k === 'last_name' ? v : f.last_name)
        if (derived) next.email = derived
      }
      return next
    })
  }

  async function save() {
    if (!form.first_name || !form.email) { toast.error('First name and email are required'); return }
    setSaving(true)
    try {
      const res = await apiFetch<{ full_name: string; temp_password?: string; temporary_password?: string }>(
        '/api/admin/users', { method: 'POST', body: JSON.stringify({ ...form, extra_roles: extraRoles }) }
      )
      const pw = res.temp_password ?? res.temporary_password ?? '(check email)'
      onSaved(pw, res.full_name)
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: RADIUS['2xl'], width: 500, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <h3 style={{ margin: 0, fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>Invite User</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            {[
              { label: 'First Name *', key: 'first_name' as const },
              { label: 'Last Name',    key: 'last_name'  as const },
            ].map(({ label, key }) => (
              <div key={key}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
                <input value={form[key]} onChange={e => field(key, e.target.value)}
                  style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
                />
              </div>
            ))}
          </div>

          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Email Address *</div>
            <input type="email" value={form.email} onChange={e => field('email', e.target.value)}
              placeholder="auto-filled from name — edit to override"
              style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Role</div>
              <RoleSelect value={form.role} onChange={v => field('role', v)}
                style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
              />
            </div>
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Department</div>
              <select value={form.department} onChange={e => field('department', e.target.value)}
                style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}>
                {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>

          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Additional teams <span style={{ fontWeight: FW.normal, textTransform: 'none', letterSpacing: 0 }}>(optional — for staff on more than one team)</span></div>
            <MultiRoleSelect value={extraRoles} exclude={form.role} onChange={setExtraRoles}
              style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
            />
          </div>

          <div style={{ background: 'rgba(14,40,65,.07)', borderRadius: RADIUS.md, padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            A temporary password will be generated and sent to the user's email. They must change it on first login.
          </div>
        </div>

        <div style={{ display: 'flex', gap: SP[2], marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}>
            {saving ? 'Inviting…' : 'Send Invite'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Edit User modal ───────────────────────────────────────────────────────────

function EditUserModal({ user, onClose, onSaved }: {
  user: User; onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    role:       user.role,
    department: user.department,
    is_active:  user.is_active,
  })
  const [extraRoles, setExtraRoles] = useState<string[]>(asRoleArray(user.extra_roles))
  const [saving,          setSaving]          = useState(false)
  const [resettingPw,     setResettingPw]     = useState(false)
  const [newTempPw,       setNewTempPw]       = useState<string | null>(null)
  const [confirmDeact,    setConfirmDeact]    = useState(false)

  function field(k: keyof typeof form, v: string | boolean) { setForm(f => ({ ...f, [k]: v })) }

  async function save() {
    setSaving(true)
    try {
      // Active state is changed via the deactivate/reactivate actions, not this
      // form — the update endpoint ignores is_active, so don't send it.
      const { is_active: _ignore, ...payload } = form
      await apiFetch(`/api/admin/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ ...payload, extra_roles: extraRoles }) })
      toast.success('User updated')
      onSaved()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function resetPassword() {
    setResettingPw(true)
    try {
      const res = await apiFetch<{ temporary_password: string }>(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' })
      setNewTempPw(res.temporary_password)
      toast.success('Password reset')
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setResettingPw(false)
    }
  }

  async function toggleActive() {
    const endpoint = form.is_active ? 'deactivate' : 'reactivate'
    try {
      await apiFetch(`/api/admin/users/${user.id}/${endpoint}`, { method: 'PATCH' })
      setForm(f => ({ ...f, is_active: !f.is_active }))
      toast.success(`User ${form.is_active ? 'deactivated' : 'reactivated'}`)
      setConfirmDeact(false)
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const ac = avatarColor(user.full_name)

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: RADIUS['2xl'], width: 520, boxShadow: '0 20px 60px rgba(0,0,0,.25)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: `${SP[5]} ${SP[6]}`, borderBottom: '1px solid var(--bdr)', display: 'flex', gap: SP[3], alignItems: 'center' }}>
          <div style={{ width: 46, height: 46, borderRadius: '50%', background: ac, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.lg, fontWeight: FW.bold, color: '#fff', flexShrink: 0 }}>
            {nameInitials(user.full_name)}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>{user.full_name}</div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{user.email}</div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>

        <div style={{ padding: `${SP[5]} ${SP[6]}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Role</div>
              <RoleSelect value={form.role} onChange={v => field('role', v)}
                style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
              />
            </div>
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Department</div>
              <select value={form.department} onChange={e => field('department', e.target.value)}
                style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}>
                {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Additional teams <span style={{ fontWeight: FW.normal, textTransform: 'none', letterSpacing: 0 }}>(for staff on more than one team)</span></div>
            <MultiRoleSelect value={extraRoles} exclude={form.role} onChange={setExtraRoles}
              style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
            />
          </div>

          {/* Meta info */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SP[3], marginBottom: 20, background: 'var(--input-bg)', borderRadius: RADIUS.md, padding: '12px 14px' }}>
            {[
              { label: 'Status', value: form.is_active ? 'Active' : (!user.last_login ? 'Pending Approval' : 'Inactive'), color: form.is_active ? GREEN : (!user.last_login ? '#B45309' : RED) },
              { label: 'Last Login', value: user.last_login ? fmtDate(user.last_login) : 'Never' },
              { label: 'Created', value: fmtDate(user.created_at) },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: color ?? 'var(--txt)' }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Temp PW display */}
          {newTempPw && (
            <div style={{ background: 'rgba(22,163,74,.08)', border: '1px solid rgba(22,163,74,.25)', borderRadius: RADIUS.md, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: GREEN, marginBottom: 6 }}>New temporary password (copy now):</div>
              <code style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: GREEN, letterSpacing: 1 }}>{newTempPw}</code>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
            <div style={{ display: 'flex', gap: SP[2] }}>
              <button onClick={resetPassword} disabled={resettingPw} style={{
                flex: 1, padding: '9px 0', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'transparent',
                color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER,
              }}>
                {resettingPw ? 'Resetting…' : 'Reset Password'}
              </button>

              {confirmDeact ? (
                <div style={{ flex: 1, display: 'flex', gap: SP[2] }}>
                  <button onClick={toggleActive} style={{ flex: 1, padding: '9px 0', borderRadius: RADIUS.md, border: 'none', background: form.is_active ? 'rgba(192,0,0,.1)' : 'rgba(22,163,74,.1)', color: form.is_active ? RED : GREEN, fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer' }}>
                    Confirm {form.is_active ? 'Deactivate' : (!user.last_login ? 'Approve & Send Credentials' : 'Reactivate')}
                  </button>
                  <button onClick={() => setConfirmDeact(false)} style={{ padding: '9px 14px', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.base, cursor: 'pointer' }}>No</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDeact(true)} style={{
                  flex: 1, padding: '9px 0', borderRadius: RADIUS.md, border: 'none',
                  background: form.is_active ? 'rgba(192,0,0,.08)' : 'rgba(22,163,74,.1)',
                  color: form.is_active ? RED : GREEN,
                  fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER,
                }}>
                  {form.is_active ? 'Deactivate' : (!user.last_login ? 'Approve & Activate' : 'Reactivate')}
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: SP[2], borderTop: '1px solid var(--bdr)', paddingTop: 16, marginTop: 4 }}>
              <button onClick={onClose} style={{ flex: 1, padding: '9px 0', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ flex: 2, padding: '9px 0', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


// ── PageBtn ───────────────────────────────────────────────────────────────────

function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean; onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: RADIUS.sm, border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? NAVY : 'transparent', color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
    </button>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const PER_PAGE = 25

// ── Approve pending user modal ────────────────────────────────────────────────

function ApproveModal({ user, onClose, onDone }: {
  user: User; onClose: () => void; onDone: () => void
}) {
  // Self-registered users default to the legacy call_centre role; steer to
  // call_center_agent, which actually grants the ticket pages.
  const [role, setRole] = useState(user.role === 'call_centre' ? 'call_center_agent' : user.role)
  const [saving, setSaving] = useState(false)

  async function approve() {
    setSaving(true)
    try {
      if (role !== user.role) {
        await apiFetch(`/api/admin/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ role }) })
      }
      await apiFetch(`/api/admin/users/${user.id}/reactivate`, { method: 'PATCH' })
      toast.success(`${user.full_name} approved — login details emailed`)
      onDone()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: RADIUS['2xl'], width: 460, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>Approve access request</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 42, height: 42, borderRadius: '50%', background: avatarColor(user.full_name), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: FW.bold, fontSize: TEXT.base }}>{nameInitials(user.full_name)}</div>
          <div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{user.full_name}</div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{user.email}</div>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Assign role</div>
          <RoleSelect value={role} onChange={setRole}
            style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
          />
        </div>
        <div style={{ background: 'rgba(22,163,74,.08)', borderRadius: RADIUS.md, padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: 20 }}>
          Approving activates the account and emails {user.first_name || 'the user'} a temporary password to log in.
        </div>
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
          <button onClick={approve} disabled={saving} style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Approving…' : 'Approve & send login'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AdminUsers() {
  const [rows,      setRows]      = useState<User[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [editing,   setEditing]   = useState<User | null>(null)
  const [inviting,  setInviting]  = useState(false)
  const [search,    setSearch]    = useState('')
  const [fRoles,    setFRoles]    = useState<Set<string>>(new Set())
  const [fStatuses, setFStatuses] = useState<Set<string>>(new Set())
  const [fDepts,    setFDepts]    = useState<Set<string>>(new Set())
  const [selected,  setSelected]  = useState<Set<string | number>>(new Set())
  const [page, setPage] = useState(1)
  const [deactivateOpen, setDeactivateOpen] = useState(false)
  const [approving, setApproving] = useState<User | null>(null)
  const [pendingOnly, setPendingOnly] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Backend returns a bare JSON array; tolerate a { data: [...] } wrapper too.
      const u = await apiFetch<User[] | { data?: User[] }>(`/api/admin/users`)
      setRows(Array.isArray(u) ? u : (u?.data ?? []))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['users'] })
  useEffect(() => { setPage(1) }, [search, fRoles, fStatuses, fDepts, pendingOnly])

  async function resetUserPassword(userId: number) {
    try {
      const res = await apiFetch<{ temporary_password: string }>(`/api/admin/users/${userId}/reset-password`, { method: 'POST' })
      toast.success(`Temp password: ${res.temporary_password}`, { duration: 10000 })
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  async function deactivateUser(userId: number) {
    try {
      await apiFetch(`/api/admin/users/${userId}/deactivate`, { method: 'PATCH' })
      toast.success('User deactivated')
      load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const pendingUsers = useMemo(() => rows.filter(u => !u.is_active && !u.last_login), [rows])

  const filtered = useMemo(() => rows.filter(u => {
    if (pendingOnly && !(!u.is_active && !u.last_login)) return false
    if (fRoles.size && !fRoles.has(u.role)) return false
    if (fStatuses.size && !fStatuses.has(u.is_active ? 'active' : 'inactive')) return false
    if (fDepts.size && !fDepts.has(u.department)) return false
    if (search) {
      const q = search.toLowerCase()
      return u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.includes(q)
    }
    return true
  }), [rows, search, fRoles, fStatuses, fDepts, pendingOnly])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart  = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd    = Math.min(safePage * PER_PAGE, filtered.length)

  function resetFilters() { setSearch(''); setFRoles(new Set()); setFStatuses(new Set()); setFDepts(new Set()) }

  async function batchDeactivate() {
    try {
      await Promise.all([...selected].map(id =>
        apiFetch(`/api/admin/users/${id}/deactivate`, { method: 'PATCH' })
      ))
      toast.success(`${selected.size} users deactivated`)
      setSelected(new Set()); setDeactivateOpen(false); load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const COLS: TableCol<User>[] = [
    { key: 'full_name', label: 'Name', render: u => <NameCell name={u.full_name} sub={u.email} /> },
    { key: 'role', label: 'Role', render: u => (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        <RolePill role={u.role} />
        {asRoleArray(u.extra_roles).map(r => <RolePill key={r} role={r} />)}
      </div>
    ) },
    { key: 'department', label: 'Dept', render: u => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{u.department || '—'}</span> },
    { key: 'is_active', label: 'Status', render: u => <StatusBadge status={u.is_active ? 'Active' : (!u.last_login ? 'Pending' : 'Inactive')} /> },
    { key: 'last_login', label: 'Last Login', sortable: true,
      render: u => <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{u.last_login ? fmtDatetime(u.last_login) : 'Never'}</span> },
    { key: 'created_at', label: 'Created', sortable: true,
      render: u => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDate(u.created_at)}</span> },
    { key: '_actions', label: '', sortable: false,
      render: u => {
        const pending = !u.is_active && !u.last_login
        const actions: RowAction[] = [
          ...(pending ? [{ icon: 'how_to_reg', label: 'Approve', onClick: () => setApproving(u) }] : []),
          { icon: 'edit', label: 'Edit', onClick: () => setEditing(u) },
          { icon: 'lock_reset', label: 'Reset Password', onClick: () => resetUserPassword(u.id) },
          ...(u.is_active ? [{ icon: 'person_off', label: 'Deactivate', onClick: () => deactivateUser(u.id), danger: true }] : []),
        ]
        return <ActionRow actions={actions} />
      },
    },
  ]

  const depts = [...new Set(rows.map(u => u.department).filter(Boolean))].sort()

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="User Management"
      subtitle={`${rows.filter(u => u.is_active).length} active · ${rows.filter(u => !u.is_active).length} inactive`}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setInviting(true)} style={{
            display: 'flex', alignItems: 'center', gap: SP[1], padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md,
            border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>person_add</span>
            Invite User
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {pendingUsers.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', marginBottom: 14, borderRadius: RADIUS.lg, background: 'rgba(217,119,6,.08)', border: '1px solid rgba(217,119,6,.3)' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 22, color: AMBER }}>how_to_reg</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {pendingUsers.length} {pendingUsers.length === 1 ? 'user is' : 'users are'} pending approval
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Access requests awaiting review — approve to activate and email their login.</div>
          </div>
          <button onClick={() => setPendingOnly(v => !v)}
            style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: 'none', background: AMBER, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}>
            {pendingOnly ? 'Show all users' : 'Review pending'}
          </button>
        </div>
      )}

      <SectionCard title={pendingOnly ? 'Pending Approval' : 'All Users'} badge={filtered.length} padding={false}>

        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'role',
              label: 'Role',
              options: [...new Set(rows.map(u => u.role))].sort().map(r => ({
                value: r,
                label: roleLabel(r),
              })),
              selected: fRoles,
              onChange: setFRoles,
            },
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'active',   label: 'Active',   color: GREEN },
                { value: 'inactive', label: 'Inactive', color: RED },
              ],
              selected: fStatuses,
              onChange: setFStatuses,
            },
            {
              key: 'dept',
              label: 'Department',
              options: depts.map(d => ({ value: d })),
              selected: fDepts,
              onChange: setFDepts,
            },
          ]}
          onReset={resetFilters}
          resultCount={filtered.length}
          totalCount={rows.length}
        />

        {/* Batch bar */}
        {selected.size > 0 && (
          <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--bdr)', background: '#F0F4FF', display: 'flex', gap: SP[2], alignItems: 'center' }}>
            <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: NAVY }}>{selected.size} selected</span>
            <button onClick={() => setDeactivateOpen(true)} style={{ padding: '5px 14px', borderRadius: 7, border: 'none', background: 'rgba(192,0,0,.1)', color: RED, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
              Deactivate
            </button>
            <button onClick={() => setSelected(new Set())} style={{ padding: '5px 10px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer' }}>
              Clear
            </button>
          </div>
        )}

        <DataTable
          cols={COLS} rows={pageRows} keyFn={r => r.id}
          loading={loading} emptyText="No users found"
          onRowClick={u => setEditing(u)}
          selectable selectedIds={selected} onSelect={setSelected}
        />

        {/* Pagination */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {filtered.length === 0 ? 'No users' : `Showing ${showStart}–${showEnd} of ${filtered.length}`}
          </span>
          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: SP[1] }}>
              <PageBtn icon="chevron_left" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} />
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pg: number
                if (totalPages <= 7) pg = i + 1
                else if (safePage <= 4) pg = i + 1
                else if (safePage >= totalPages - 3) pg = totalPages - 6 + i
                else pg = safePage - 3 + i
                return <PageBtn key={pg} active={pg === safePage} onClick={() => setPage(pg)}>{pg}</PageBtn>
              })}
              <PageBtn icon="chevron_right" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} />
            </div>
          )}
        </div>

      </SectionCard>

      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onSaved={(pw, name) => {
            toast.success(`${name} invited. Temp password: ${pw}`, { duration: 10000 })
            load()
          }}
        />
      )}

      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
      {approving && (
        <ApproveModal
          user={approving}
          onClose={() => setApproving(null)}
          onDone={load}
        />
      )}
      <ConfirmModal
        open={deactivateOpen}
        title={`Deactivate ${selected.size} user${selected.size !== 1 ? 's' : ''}?`}
        body="Deactivated users lose access immediately and cannot log in until reactivated."
        confirmLabel="Deactivate"
        danger
        onConfirm={batchDeactivate}
        onClose={() => setDeactivateOpen(false)}
      />
    </Page>
  )
}

