import { useEffect, useMemo, useState } from 'react'
import { apiDelete, apiFetch, apiPost, apiPut } from '../../lib/api'
import { roleLabel } from '../../lib/roles'
import { ConfirmModal, ErrBanner, NAVY, RED, SectionCard, Spinner, Page } from '../../components/UI'

interface RoleRow {
  name: string
  label: string
  pages: string[]
  builtin?: boolean
  built_in?: boolean
}

const PAGE_LABELS: Record<string, string> = {
  overview: 'Overview', executive: 'Executive Dashboard', transactions: 'Transactions', income: 'Income', eod: 'EOD/EOB', uploads: 'Uploads', reconciliation: 'Reconciliation', fixed_deposit: 'Fixed Deposits', settlement: 'Settlement',
  sales: 'Sales', crm_pipeline: 'CRM Pipeline', crm_contacts: 'CRM Contacts', crm_tasks: 'CRM Tasks', crm_reports: 'CRM Reports', campaigns: 'Campaigns', contact_lists: 'Contact Lists', message_templates: 'Message Templates', statements: 'Statements',
  loans: 'Loans', los: 'LOS Queue', los_all: 'All Applications', los_assign: 'Assign Applications', los_finance: 'LOS Finance', los_finance_approve: 'Finance Approval', los_risk_review: 'Risk Review', los_risk_head: 'Risk Head Review', los_booking: 'Booking', customer360: 'Customer 360', credit_portfolio: 'Credit Portfolio',
  collections: 'Collections', collections_assign: 'Collections Assignment', collections_payment: 'Collections Payment', collections_payment_approve: 'Approve Collections Payment', recovery: 'Recovery', recovery_assign: 'Recovery Assignment', recovery_write_off: 'Write Off',
  cards: 'Cards', card_trends: 'Card Trends', mobile_app: 'Mobile App', blink_card: 'Blink Card', call_center: 'Call Center', customer_service: 'Customer Service',
  hr_employees: 'HR Employees', hr_leave: 'Leave', hr_performance: 'Performance', hr_disciplinary: 'Disciplinary', hr_payroll: 'Payroll', hr_training: 'Training',
  compliance_all: 'Compliance Admin', compliance_checklists: 'Checklists', cbn_reports: 'CBN Reports', sars: 'SARs', watch_list: 'Watch List', audit_findings: 'Audit Findings', audit_trail: 'Audit Trail', audit_export: 'Audit Export',
  kpi_dashboard: 'KPI Dashboard', reports: 'Reports', admin_users: 'Users and Roles', admin_api_keys: 'API Keys', settings: 'Settings', sync_status: 'Sync Status', risk_all: 'Risk Admin', risk_officer: 'Risk Officer Actions', risk_head: 'Risk Head Actions',
}

const REQUIRED_PAGES = Object.keys(PAGE_LABELS)

function normalizeRoles(raw: any): RoleRow[] {
  const rows = Array.isArray(raw) ? raw : (raw?.data ?? [])
  return rows.map((r: any) => ({
    name: String(r.name ?? '').trim(),
    label: String(r.label || roleLabel(String(r.name ?? ''))),
    pages: Array.isArray(r.pages) ? r.pages.map(String) : [],
    builtin: Boolean(r.builtin ?? r.built_in),
    built_in: Boolean(r.builtin ?? r.built_in),
  })).filter((r: RoleRow) => r.name)
}

function pageLabel(page: string) {
  return PAGE_LABELS[page] ?? page.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
}

export default function RoleManagement() {
  const [roles, setRoles] = useState<RoleRow[]>([])
  const [selected, setSelected] = useState<RoleRow | null>(null)
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [pages, setPages] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await apiFetch('/api/admin/roles')
      const data = normalizeRoles(res)
      setRoles(data)
      if (!selected && data.length) choose(data[0])
      if (selected) {
        const fresh = data.find(r => r.name === selected.name)
        if (fresh) choose(fresh)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const allPages = useMemo(() => {
    const set = new Set<string>(REQUIRED_PAGES)
    roles.forEach(r => r.pages.forEach(p => set.add(p)))
    return Array.from(set).sort((a, b) => pageLabel(a).localeCompare(pageLabel(b)))
  }, [roles])

  function choose(role: RoleRow) {
    setSelected(role)
    setName(role.name)
    setLabel(role.label || roleLabel(role.name))
    setPages(role.pages ?? [])
    setError('')
    setMessage('')
  }

  function startNew() {
    setSelected(null)
    setName('')
    setLabel('')
    setPages(['overview'])
    setError('')
    setMessage('')
  }

  function togglePage(page: string) {
    setPages(current => current.includes(page) ? current.filter(p => p !== page) : [...current, page])
  }

  async function save() {
    setSaving(true); setError(''); setMessage('')
    try {
      if (selected?.builtin || selected?.built_in) throw new Error('Built-in roles cannot be edited')
      const body = { name, label, pages }
      if (selected) await apiPut(`/api/admin/roles/${encodeURIComponent(selected.name)}`, body)
      else await apiPost('/api/admin/roles', body)
      setMessage(selected ? 'Role updated' : 'Role created')
      await load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!selected || selected.builtin || selected.built_in) return
    const name = selected.label || selected.name
    setConfirm({
      title: 'Delete Role',
      message: `Delete role "${name}"? This cannot be undone.`,
      onConfirm: async () => {
        setSaving(true); setError(''); setMessage('')
        try {
          await apiDelete(`/api/admin/roles/${encodeURIComponent(selected.name)}`)
          setMessage('Role deleted')
          setSelected(null)
          await load()
        } catch (e: any) {
          setError(e.message)
        } finally {
          setSaving(false)
        }
      },
    })
  }

  const isBuiltin = Boolean(selected?.builtin ?? selected?.built_in)

  return (
    <Page dept="Admin" deptPath="/admin" title="Roles & Access" subtitle="Create custom roles and control page-level access."
      actions={
        <button onClick={startNew} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white" style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[16px]">add</span>
          New Role
        </button>
      }
    >
      <ErrBanner msg={error} />
      {message && <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-[13px] font-semibold text-green-800">{message}</div>}

      <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-5 items-start">
        <SectionCard title="Role Catalogue" subtitle={`${roles.length} roles`}>
          <div className="max-h-[calc(100vh-230px)] overflow-y-auto divide-y divide-[var(--bdr)]">
            {loading ? <div className="p-8 text-center"><Spinner /></div> : roles.map(role => {
              const active = selected?.name === role.name
              return (
                <button key={role.name} onClick={() => choose(role)} className={`w-full text-left px-4 py-3 hover:bg-[var(--bg)] ${active ? 'bg-[var(--bg)]' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-bold text-[color:var(--txt)] truncate">{role.label || roleLabel(role.name)}</p>
                      <p className="text-[11px] font-mono text-[color:var(--txt2)] truncate">{role.name}</p>
                    </div>
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${role.builtin || role.built_in ? 'bg-[var(--chip-bg)] text-[color:var(--txt2)]' : 'bg-green-50 text-green-700'}`}>
                      {role.builtin || role.built_in ? 'Built-in' : 'Custom'}
                    </span>
                  </div>
                  <p className="text-[11px] text-[color:var(--txt2)] mt-1">{role.pages.length} permissions</p>
                </button>
              )
            })}
          </div>
        </SectionCard>

        <SectionCard title={selected ? (isBuiltin ? 'View Role' : 'Edit Role') : 'Create Role'} subtitle={isBuiltin ? 'Built-in roles are managed in code' : 'Custom role'} actions={
          selected && !isBuiltin ? <button onClick={remove} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold border disabled:opacity-60" style={{ borderColor: 'rgba(220,38,38,0.25)', color: RED }}>
            <span className="material-symbols-rounded text-[14px]">delete</span> Delete
          </button> : null
        }>
          <div className="p-5 space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-[11px] font-bold uppercase text-[color:var(--txt2)] mb-1">Role Name</span>
                <input value={name} disabled={Boolean(selected) || isBuiltin} onChange={e => setName(e.target.value)} className="w-full rounded-lg border border-[var(--bdr)] px-3 py-2 text-[13px] disabled:bg-[var(--bg)] disabled:text-[color:var(--txt2)]" placeholder="marketing_manager" />
              </label>
              <label className="block">
                <span className="block text-[11px] font-bold uppercase text-[color:var(--txt2)] mb-1">Display Label</span>
                <input value={label} disabled={isBuiltin} onChange={e => setLabel(e.target.value)} className="w-full rounded-lg border border-[var(--bdr)] px-3 py-2 text-[13px] disabled:bg-[var(--bg)] disabled:text-[color:var(--txt2)]" placeholder="Marketing Manager" />
              </label>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-bold text-[color:var(--txt)]">Page Permissions</p>
                <p className="text-[11px] text-[color:var(--txt2)]">{pages.length} selected</p>
              </div>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-2 max-h-[calc(100vh-430px)] overflow-y-auto pr-1">
                {allPages.map(page => {
                  const checked = pages.includes(page)
                  return (
                    <label key={page} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] ${checked ? 'bg-[var(--bg)] border-[var(--bdr)] text-[color:var(--txt)]' : 'border-[var(--bdr)] text-[color:var(--txt2)]'}`}>
                      <input type="checkbox" checked={checked} disabled={isBuiltin} onChange={() => togglePage(page)} className="w-4 h-4 accent-[#0E2841]" />
                      <span className="min-w-0 truncate">{pageLabel(page)}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            {!isBuiltin && (
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={startNew} type="button" className="px-4 py-2 rounded-lg border border-[var(--bdr)] text-[13px] font-semibold text-[color:var(--txt2)]">Clear</button>
                <button onClick={save} disabled={saving || !name.trim()} type="button" className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: NAVY }}>
                  {saving ? <Spinner size={16} /> : <span className="material-symbols-rounded text-[16px]">save</span>}
                  {selected ? 'Save Changes' : 'Create Role'}
                </button>
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          danger
          confirmLabel="Delete"
          onConfirm={() => { confirm.onConfirm(); setConfirm(null) }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Page>
  )
}
