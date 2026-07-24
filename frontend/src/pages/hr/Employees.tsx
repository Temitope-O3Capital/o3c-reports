import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, Spinner, Tabs, StatusBadge, btnPrimary, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, fmtKobo, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Employee {
  id: number
  staff_id?: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  department?: string
  department_id?: number
  job_title?: string
  grade_level?: string
  grade_level_id?: number
  status: string
  date_of_birth?: string
  gender?: string
  address?: string
  emergency_contact_name?: string
  emergency_contact_phone?: string
  start_date?: string
  manager_name?: string
  contract_type?: string
  bank_name?: string
  account_number?: string
  salary_kobo?: number
  pension_rsa_pin?: string
  hmo_plan?: string
}

interface LeaveBalance { leave_type: string; total_days: number; used_days: number; remaining_days: number }
interface Department { id: number; name: string }
interface GradeLevel { id: number; name: string }

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK: Partial<Employee> = {
  first_name: '', last_name: '', email: '', phone: '',
  department_id: undefined, job_title: '', grade_level_id: undefined,
  salary_kobo: 0, bank_name: '', account_number: '', contract_type: 'Full-Time',
}

export default function Employees() {
  const storedUser = localStorage.getItem('o3c_user')
  const userRole = storedUser ? (JSON.parse(storedUser) as AuthUser).role : ''
  const canManage = ['hr_manager', 'head_hr', 'admin', 'coo'].includes(userRole)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [depts, setDepts] = useState<Department[]>([])
  const [grades, setGrades] = useState<GradeLevel[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const [deptFilter, setDeptFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [gradeFilter, setGradeFilter]   = useState('')

  const [addOpen, setAddOpen]         = useState(false)
  const [form, setForm]               = useState<Partial<Employee>>(BLANK)
  const [saving, setSaving]           = useState(false)

  const [sel, setSel] = useState<Set<string | number>>(new Set())
  const [deactivateOpen, setDeactivateOpen] = useState(false)
  const [deactivating, setDeactivating]     = useState(false)

  const [detail, setDetail]           = useState<Employee | null>(null)
  const [detailTab, setDetailTab]     = useState('personal')
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([])
  const [loadingLeave, setLoadingLeave]   = useState(false)
  // M3: edit mode for employee detail modal
  const [isEditing, setIsEditing]     = useState(false)
  const [editForm, setEditForm]       = useState<Partial<Employee>>({})
  const [savingEdit, setSavingEdit]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (deptFilter)   p.set('department_id', deptFilter)
      if (statusFilter) p.set('status', statusFilter)
      if (gradeFilter)  p.set('grade_level_id', gradeFilter)
      p.set('from', dateFrom)
      p.set('to', dateTo)
      const [emps, ds, gs] = await Promise.all([
        apiFetch<{ data: Employee[] }>(`/api/hr/employees?${p}`),
        apiFetch<{ data: Department[] }>('/api/hr/departments'),
        apiFetch<{ data: GradeLevel[] }>('/api/hr/grade-levels'),
      ])
      setEmployees(Array.isArray(emps.data) ? emps.data : [])
      setDepts(Array.isArray(ds.data) ? ds.data : [])
      setGrades(Array.isArray(gs.data) ? gs.data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [deptFilter, statusFilter, gradeFilter, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function openDetail(emp: Employee) {
    setDetail(emp)
    setDetailTab('personal')
    setIsEditing(false)
    setEditForm({})
    setLeaveBalances([])
    setLoadingLeave(true)
    try {
      const full = await apiFetch<{ data: Employee }>(`/api/hr/employees/${emp.id}`)
      setDetail(full.data)
      const lb = await apiFetch<{ data: LeaveBalance[] }>(`/api/hr/employees/${emp.id}/leave-balance`)
      setLeaveBalances(Array.isArray(lb.data) ? lb.data : [])
    } catch { /* keep what we have */ }
    finally { setLoadingLeave(false) }
  }

  async function handleEditSave() {
    if (!detail) return
    setSavingEdit(true)
    try {
      await apiPut(`/api/hr/employees/${detail.id}`, editForm)
      toast.success('Employee updated')
      setIsEditing(false)
      setEditForm({})
      // Refresh detail with updated data
      const full = await apiFetch<{ data: Employee }>(`/api/hr/employees/${detail.id}`)
      setDetail(full.data)
      load()
    } catch (e: any) { toast.error(e.message ?? 'Save failed') }
    finally { setSavingEdit(false) }
  }

  function ef(field: keyof Employee) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setEditForm(prev => ({ ...prev, [field]: e.target.value }))
  }

  async function handleCreate() {
    if (!form.first_name || !form.last_name) { toast.error('First and last name are required'); return }
    setSaving(true)
    try {
      await apiPost('/api/hr/employees', form)
      toast.success('Employee added')
      setAddOpen(false); setForm(BLANK); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleDeactivate() {
    setDeactivating(true)
    try {
      await apiPost('/api/hr/employees/deactivate', { employee_ids: Array.from(sel) })
      toast.success(`${sel.size} employee${sel.size > 1 ? 's' : ''} deactivated`)
      setSel(new Set())
      setDeactivateOpen(false)
      load()
    } catch (e: any) { toast.error(e.message ?? 'Deactivation failed') }
    finally { setDeactivating(false) }
  }

  function exportEmployeesCsv(rows: Employee[]) {
    const header = ['Staff ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Department', 'Job Title', 'Grade', 'Status']
    const lines = rows.map(r => [
      r.staff_id ?? '',
      `"${String(r.first_name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.last_name ?? '').replace(/"/g, '""')}"`,
      r.email ?? '',
      r.phone ?? '',
      `"${String(r.department ?? '').replace(/"/g, '""')}"`,
      `"${String(r.job_title ?? '').replace(/"/g, '""')}"`,
      r.grade_level ?? '',
      r.status ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `employees-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<Employee>[] = [
    {
      key: 'staff_id', label: 'Staff ID',
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>{r.staff_id ?? '—'}</span>,
    },
    {
      key: 'first_name', label: 'Name',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.first_name} {r.last_name}</span>,
    },
    {
      key: 'department', label: 'Department',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.department ?? '—'}</span>,
    },
    {
      key: 'job_title', label: 'Job Title',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.job_title ?? '—'}</span>,
    },
    {
      key: 'grade_level', label: 'Grade',
      render: r => r.grade_level ? (
        <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${BLUE}12`, color: BLUE }}>
          {r.grade_level}
        </span>
      ) : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
  ]

  const detailTabs = [
    { key: 'personal',   label: 'Personal' },
    { key: 'employment', label: 'Employment' },
    { key: 'payroll',    label: 'Payroll' },
    { key: 'leave',      label: 'Leave' },
  ]

  return (
    <Page
      title="Employees"
      subtitle="Employee directory and records"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          {canManage && (
            <button onClick={() => { setForm(BLANK); setAddOpen(true) }} style={btnPrimary}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>person_add</span>
              Add Employee
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setDeptFilter(''); setStatusFilter(''); setGradeFilter('') }}>
        <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Departments</option>
          {depts.map(d => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
        </select>
        <select value={gradeFilter} onChange={e => setGradeFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Grades</option>
          {grades.map(g => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
        </select>
      </FilterBar>

      <SectionCard title="Employees" badge={employees.length} padding={false} actions={<button onClick={() => exportEmployeesCsv(employees)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>
        <DataTable<Employee>
          cols={cols}
          rows={employees}
          keyFn={r => r.id}
          onRowClick={openDetail}
          emptyText="No employees found."
          skeletonRows={loading ? 8 : 0}
          searchKeys={['first_name', 'last_name', 'email', 'department', 'job_title', 'status', 'staff_id']}
          searchPlaceholder="Search employees…"
          pageSize={20}

          selectable
          selectedIds={sel}
          onSelect={setSel}
          bulkBar={
            <button
              onClick={() => setDeactivateOpen(true)}
              style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: 'none', background: '#C00000', color: 'white', cursor: 'pointer', fontSize: TEXT.sm }}
            >
              Deactivate Selected ({sel.size})
            </button>
          }
        />
      </SectionCard>

      {/* Add modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Employee" width={580}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setAddOpen(false)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Add Employee
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            {([['First Name *', 'first_name'], ['Last Name *', 'last_name'], ['Email', 'email'], ['Phone', 'phone'], ['Job Title', 'job_title']] as [string, keyof Employee][]).map(([label, key]) => (
              <div key={key}>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>{label}</label>
                <input value={(form[key] as string) ?? ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} style={inputStyle} />
              </div>
            ))}
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Department</label>
              <select value={form.department_id ?? ''} onChange={e => setForm(f => ({ ...f, department_id: Number(e.target.value) || undefined }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                <option value="">— Select —</option>
                {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Grade Level</label>
              <select value={form.grade_level_id ?? ''} onChange={e => setForm(f => ({ ...f, grade_level_id: Number(e.target.value) || undefined }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                <option value="">— Select —</option>
                {grades.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Gross Salary (₦)</label>
              <input type="number" value={form.salary_kobo ? form.salary_kobo / 100 : ''} onChange={e => setForm(f => ({ ...f, salary_kobo: Math.round(Number(e.target.value) * 100) }))} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Bank Name</label>
              <input value={form.bank_name ?? ''} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Account Number</label>
              <input value={form.account_number ?? ''} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} style={inputStyle} />
            </div>
          </div>
        </div>
      </Modal>

      {/* Deactivate confirm modal */}
      <ConfirmModal
        open={deactivateOpen}
        title="Deactivate Employees"
        body={`Are you sure you want to deactivate ${sel.size} selected employee${sel.size > 1 ? 's' : ''}? Their status will be set to inactive.`}
        confirmLabel="Deactivate"
        danger
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateOpen(false)}
      />

      {/* Detail modal */}
      <Modal open={!!detail} onClose={() => { setDetail(null); setIsEditing(false) }} title={detail ? `${detail.first_name} ${detail.last_name}` : ''} width={580}>
        {detail && (
          <div>
            <div style={{ display: 'flex', gap: SP[2], marginBottom: SP[4], alignItems: 'center' }}>
              <StatusBadge status={detail.status} />
              {detail.staff_id && <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>{detail.staff_id}</span>}
              {canManage && !isEditing && (
                <button
                  onClick={() => { setIsEditing(true); setEditForm({ ...detail }) }}
                  style={{ marginLeft: 'auto', ...btnPrimary, padding: '5px 12px', fontSize: TEXT.sm }}
                >
                  Edit
                </button>
              )}
              {isEditing && (
                <div style={{ marginLeft: 'auto', display: 'flex', gap: SP[2] }}>
                  <button onClick={() => { setIsEditing(false); setEditForm({}) }}
                    style={{ padding: '5px 12px', fontSize: TEXT.sm, borderRadius: RADIUS.md, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)', cursor: 'pointer' }}>
                    Cancel
                  </button>
                  <button onClick={handleEditSave} disabled={savingEdit}
                    style={{ ...btnPrimary, padding: '5px 12px', fontSize: TEXT.sm, opacity: savingEdit ? 0.7 : 1 }}>
                    {savingEdit ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </div>
            {!isEditing && <Tabs tabs={detailTabs} active={detailTab} onChange={setDetailTab} />}
            <div style={{ paddingTop: 16 }}>
              {isEditing && (() => {
                const inpS: React.CSSProperties = {
                  padding: '7px 10px', border: '1px solid var(--border)', borderRadius: RADIUS.md,
                  fontSize: TEXT.sm, background: 'var(--card)', color: 'var(--text)', width: '100%',
                }
                const row = (label: string, field: keyof Employee, type = 'text') => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], fontSize: TEXT.sm }}>
                    <span style={{ color: 'var(--muted)', minWidth: 150, flexShrink: 0 }}>{label}</span>
                    <input type={type} value={String(editForm[field] ?? '')} onChange={ef(field)} style={inpS} />
                  </div>
                )
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
                    <div style={{ fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--muted)', marginBottom: 4, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>Personal</div>
                    {row('First Name', 'first_name')}
                    {row('Last Name', 'last_name')}
                    {row('Date of Birth', 'date_of_birth', 'date')}
                    {row('Gender', 'gender')}
                    {row('Phone', 'phone')}
                    {row('Email', 'email', 'email')}
                    {row('Address', 'address')}
                    {row('Emergency Contact', 'emergency_contact_name')}
                    {row('Emergency Phone', 'emergency_contact_phone')}
                    <div style={{ fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--muted)', margin: '8px 0 4px', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>Employment</div>
                    {row('Job Title', 'job_title')}
                    {row('Contract Type', 'contract_type')}
                    {row('Start Date', 'start_date', 'date')}
                    <div style={{ fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--muted)', margin: '8px 0 4px', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>Payroll</div>
                    {row('Bank', 'bank_name')}
                    {row('Account Number', 'account_number')}
                    {row('Pension RSA PIN', 'pension_rsa_pin')}
                    {row('HMO Plan', 'hmo_plan')}
                  </div>
                )
              })()}
              {!isEditing && detailTab === 'personal' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  {[
                    ['Date of Birth',     detail.date_of_birth ? fmtDate(detail.date_of_birth) : '—'],
                    ['Gender',            detail.gender ?? '—'],
                    ['Phone',             detail.phone ?? '—'],
                    ['Email',             detail.email ?? '—'],
                    ['Address',           detail.address ?? '—'],
                    ['Emergency Contact', detail.emergency_contact_name ?? '—'],
                    ['Emergency Phone',   detail.emergency_contact_phone ?? '—'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: SP[3], fontSize: TEXT.base }}>
                      <span style={{ color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
              {!isEditing && detailTab === 'employment' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  {[
                    ['Staff ID',       detail.staff_id ?? '—'],
                    ['Department',     detail.department ?? '—'],
                    ['Job Title',      detail.job_title ?? '—'],
                    ['Grade Level',    detail.grade_level ?? '—'],
                    ['Start Date',     detail.start_date ? fmtDate(detail.start_date) : '—'],
                    ['Manager',        detail.manager_name ?? '—'],
                    ['Contract Type',  detail.contract_type ?? '—'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: SP[3], fontSize: TEXT.base }}>
                      <span style={{ color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
              {!isEditing && detailTab === 'payroll' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  {[
                    ['Bank',           detail.bank_name ?? '—'],
                    ['Account Number', detail.account_number ?? '—'],
                    ['Gross Salary',   detail.salary_kobo ? fmtKobo(detail.salary_kobo) : '—'],
                    ['Pension RSA PIN',detail.pension_rsa_pin ?? '—'],
                    ['HMO Plan',       detail.hmo_plan ?? '—'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: SP[3], fontSize: TEXT.base }}>
                      <span style={{ color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
              {!isEditing && detailTab === 'leave' && (
                loadingLeave ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner size={24} /></div>
                ) : leaveBalances.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>No leave balances found.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {leaveBalances.map(lb => (
                      <div key={lb.leave_type} style={{ display: 'flex', alignItems: 'center', gap: SP[3], padding: '10px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 3 }}>{lb.leave_type}</div>
                          <div style={{ height: 5, background: 'var(--bdr)', borderRadius: RADIUS.lg, overflow: 'hidden' }}>
                            <div style={{ width: `${lb.total_days > 0 ? (lb.remaining_days / lb.total_days) * 100 : 0}%`, height: '100%', background: GREEN, borderRadius: RADIUS.lg }} />
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', minWidth: 70 }}>
                          <div style={{ ...NUM, fontSize: 15, fontWeight: FW.bold, color: GREEN }}>{lb.remaining_days}</div>
                          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>of {lb.total_days} left</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </Modal>
    </Page>
  )
}
