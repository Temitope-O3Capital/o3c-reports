import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { NAVY, RED, GREEN, INTER, SORA, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Role {
  name: string
  label: string
  pages: string[]
  built_in: boolean
  user_count?: number
  id?: number
}

// ── Page groups for permissions UI ────────────────────────────────────────────

const PAGE_GROUPS: { label: string; pages: string[] }[] = [
  { label: 'Executive',    pages: ['overview','executive'] },
  { label: 'Sales & BD',   pages: ['sales','crm_pipeline','crm_contacts','crm_tasks','crm_requests','crm_reports','cohort'] },
  { label: 'Loans (LOS)',  pages: ['loans','los_all','credit_portfolio'] },
  { label: 'Risk',         pages: ['credit_portfolio','income'] },
  { label: 'Collections',  pages: ['collections','recovery'] },
  { label: 'Cards',        pages: ['cards','card_trends','blink_card','mobile_app'] },
  { label: 'Finance',      pages: ['income','transactions','fixed_deposit','eod','settlement','reconciliation'] },
  { label: 'Contact Centre', pages: ['call_center','helpdesk','helpdesk_stats','helpdesk_canned'] },
  { label: 'HR',           pages: ['hr_employees','hr_leave','hr_performance','hr_disciplinary','hr_training'] },
  { label: 'Compliance',   pages: ['compliance_checklists','watch_list','sars','cbn_reports','audit_findings','audit_trail'] },
  { label: 'Campaigns',    pages: ['campaigns','campaign_analytics','contact_lists','message_templates'] },
  { label: 'Reports',      pages: ['reports','statements','kpi'] },
  { label: 'Admin',        pages: ['admin_users','admin_api_keys','settings','sync_status'] },
  { label: 'Misc',         pages: ['uploads'] },
]

function pageLabel(p: string): string {
  return p.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── Role modal ────────────────────────────────────────────────────────────────

function RoleModal({ role, users, onClose, onSaved }: {
  role: Role | null; users: { role: string; full_name: string }[]
  onClose: () => void; onSaved: () => void
}) {
  const isNew = !role || !role.name
  const [name,   setName]   = useState(role?.name  ?? '')
  const [label,  setLabel]  = useState(role?.label ?? '')
  const [pages,  setPages]  = useState<Set<string>>(new Set(role?.pages ?? []))
  const [saving, setSaving] = useState(false)

  const affected = users.filter(u => u.role === role?.name)

  function togglePage(p: string) {
    setPages(prev => {
      const s = new Set(prev)
      if (s.has(p)) s.delete(p); else s.add(p)
      return s
    })
  }

  function toggleGroup(groupPages: string[]) {
    const allOn = groupPages.every(p => pages.has(p))
    setPages(prev => {
      const s = new Set(prev)
      if (allOn) groupPages.forEach(p => s.delete(p))
      else groupPages.forEach(p => s.add(p))
      return s
    })
  }

  async function save() {
    if (!name.trim()) { toast.error('Role name is required'); return }
    setSaving(true)
    try {
      const body = { name, label, pages: [...pages] }
      if (isNew) {
        await apiFetch('/api/admin/roles', { method: 'POST', body: JSON.stringify(body) })
        toast.success('Role created')
      } else {
        await apiFetch(`/api/admin/roles/${encodeURIComponent(role!.name)}`, { method: 'PUT', body: JSON.stringify(body) })
        toast.success('Role updated')
      }
      onSaved()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function deleteRole() {
    if (affected.length > 0) { toast.error('Cannot delete role with assigned users'); return }
    if (!confirm(`Delete role "${role?.name}"?`)) return
    try {
      await apiFetch(`/api/admin/roles/${encodeURIComponent(role!.name)}`, { method: 'DELETE' })
      toast.success('Role deleted')
      onSaved()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, overflow: 'auto', padding: '20px' }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--bdr)' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>{isNew ? 'Create Role' : `Role: ${role?.label || role?.name}`}</h3>
            {role?.built_in && <div style={{ fontSize: 12, color: NAVY, fontWeight: 600, marginTop: 3 }}>Built-in role — name cannot be changed</div>}
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>

          {/* Name + label */}
          {(isNew || !role?.built_in) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Role Key *</div>
                <input
                  value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                  placeholder="e.g. risk_analyst"
                  disabled={!isNew}
                  style={{ display: 'block', width: '100%', padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: isNew ? 'var(--input-bg)' : 'var(--bdr)', fontSize: 13, color: 'var(--txt)', fontFamily: 'monospace', boxSizing: 'border-box', outline: 'none' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Display Label</div>
                <input
                  value={label} onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. Risk Analyst"
                  style={{ display: 'block', width: '100%', padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
                />
              </div>
            </div>
          )}

          {/* Page permissions */}
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 12 }}>
            Page Permissions ({pages.size} granted)
          </div>

          {role?.built_in ? (
            <div style={{ background: 'var(--input-bg)', borderRadius: 8, padding: 12, fontSize: 12.5, color: 'var(--txt2)', marginBottom: 16 }}>
              Built-in roles have fixed permissions defined in code. Only custom roles can have their permissions changed.
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[...pages].map(p => (
                  <span key={p} style={{ fontSize: 11, fontWeight: 600, background: `${NAVY}12`, color: NAVY, borderRadius: 10, padding: '2px 8px' }}>{pageLabel(p)}</span>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {PAGE_GROUPS.map(group => {
                const allOn = group.pages.every(p => pages.has(p))
                const someOn = group.pages.some(p => pages.has(p))
                return (
                  <div key={group.label} style={{ border: '1.5px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px',
                      background: someOn ? `${NAVY}08` : 'var(--input-bg)', cursor: 'pointer', userSelect: 'none',
                    }}>
                      <input
                        type="checkbox" checked={allOn} onChange={() => toggleGroup(group.pages)}
                        ref={el => { if (el) el.indeterminate = someOn && !allOn }}
                        style={{ cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{group.label}</span>
                      <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{group.pages.filter(p => pages.has(p)).length}/{group.pages.length}</span>
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--bdr)' }}>
                      {group.pages.map(p => (
                        <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5 }}>
                          <input type="checkbox" checked={pages.has(p)} onChange={() => togglePage(p)} style={{ cursor: 'pointer' }} />
                          {pageLabel(p)}
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Affected users preview */}
          {affected.length > 0 && (
            <div style={{ marginTop: 20, border: '1px solid var(--bdr)', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 8 }}>
                {affected.length} user{affected.length !== 1 ? 's' : ''} with this role
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {affected.map(u => (
                  <span key={u.full_name} style={{ fontSize: 12, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: 10, padding: '2px 9px' }}>{u.full_name}</span>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 24px', borderTop: '1px solid var(--bdr)' }}>
          <div>
            {role && !role.built_in && !isNew && (
              <button onClick={deleteRole} style={{ padding: '9px 16px', borderRadius: 9, border: 'none', background: 'rgba(192,0,0,.08)', color: RED, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>
                Delete Role
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
            {!role?.built_in && (
              <button onClick={save} disabled={saving} style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER }}>
                {saving ? 'Saving…' : isNew ? 'Create Role' : 'Save Changes'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}


// ── Export ────────────────────────────────────────────────────────────────────

function exportRolesCsv(rows: Role[]) {
  const header = ['Role Key', 'Label', 'Type', 'User Count', 'Page Count']
  const lines = rows.map(r => [
    `"${String(r.name ?? '').replace(/"/g, '""')}"`,
    `"${String(r.label ?? '').replace(/"/g, '""')}"`,
    r.built_in ? 'Built-in' : 'Custom',
    r.user_count ?? 0,
    r.pages.length,
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `roles-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminRoles() {
  const [roles,   setRoles]   = useState<Role[]>([])
  const [users,   setUsers]   = useState<{ role: string; full_name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [editing, setEditing] = useState<Role | null | false>(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, u] = await Promise.all([
        apiFetch<Role[]>('/api/admin/roles'),
        apiFetch<{ role: string; full_name: string }[]>('/api/admin/users'),
      ])
      const roleList = Array.isArray(r) ? r : []
      const userList = Array.isArray(u) ? u : []

      // Attach user counts
      const counts: Record<string, number> = {}
      for (const user of userList) counts[user.role] = (counts[user.role] ?? 0) + 1
      setRoles(roleList.map(role => ({ ...role, user_count: counts[role.name] ?? 0 })))
      setUsers(userList)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const displayed = roles

  const COLS: TableCol<Role>[] = [
    { key: 'name', label: 'Role Key',
      render: r => (
        <div>
          <div style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 600, color: 'var(--txt)' }}>{r.name}</div>
          {r.label && r.label !== r.name && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.label}</div>}
        </div>
      ),
    },
    { key: 'user_count', label: 'Users', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 700, color: (r.user_count ?? 0) > 0 ? NAVY : 'var(--txt3)' }}>{r.user_count ?? 0}</span> },
    { key: 'pages', label: 'Permissions', align: 'right',
      render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{r.pages.length} pages</span> },
    { key: 'built_in', label: 'Type',
      render: r => (
        <span style={{ fontSize: 11.5, fontWeight: 600, color: r.built_in ? NAVY : GREEN, background: r.built_in ? `${NAVY}10` : `${GREEN}12`, borderRadius: 10, padding: '2px 9px' }}>
          {r.built_in ? 'Built-in' : 'Custom'}
        </span>
      ),
    },
  ]

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Roles"
      subtitle="Role-based access control — page permissions per role"
      actions={
        <button onClick={() => setEditing(null)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9,
          border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          Create Role
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="All Roles" badge={roles.length} padding={false} actions={<button onClick={() => exportRolesCsv(displayed)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <DataTable
          cols={COLS}
          rows={displayed}
          keyFn={r => r.name}
          loading={loading}
          emptyText="No roles found"
          onRowClick={r => setEditing(r)}
          searchKeys={['name', 'label']}
          searchPlaceholder="Search roles…"
          pageSize={20}
        />
      </SectionCard>

      {editing !== false && (
        <RoleModal
          role={editing}
          users={users}
          onClose={() => setEditing(false)}
          onSaved={load}
        />
      )}
    </Page>
  )
}
