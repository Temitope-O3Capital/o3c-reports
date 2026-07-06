import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, Spinner, Tabs, StatusBadge, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, fmtKobo } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
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
  const storedUser = localStorage.getItem('auth_user')
  const userRole = storedUser ? (JSON.parse(storedUser) as AuthUser).role : ''
  const canManage = ['hr_manager', 'head_hr', 'admin', 'coo'].includes(userRole)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [depts, setDepts] = useState<Department[]>([])
  const [grades, setGrades] = useState<GradeLevel[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [deptFilter, setDeptFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [gradeFilter, setGradeFilter]   = useState('')

  const [addOpen, setAddOpen]         = useState(false)
  const [form, setForm]               = useState<Partial<Employee>>(BLANK)
  const [saving, setSaving]           = useState(false)

  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const [detail, setDetail]           = useState<Employee | null>(null)
  const [detailTab, setDetailTab]     = useState('personal')
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([])
  const [loadingLeave, setLoadingLeave]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (deptFilter)   p.set('department_id', deptFilter)
      if (statusFilter) p.set('status', statusFilter)
      if (gradeFilter)  p.set('grade_level_id', gradeFilter)
      const [emps, ds, gs] = await Promise.all([
        apiFetch<Employee[]>(`/api/hr/employees?${p}`),
        apiFetch<Department[]>('/api/hr/departments'),
        apiFetch<GradeLevel[]>('/api/hr/grade-levels'),
      ])
      setEmployees(Array.isArray(emps) ? emps : [])
      setDepts(Array.isArray(ds) ? ds : [])
      setGrades(Array.isArray(gs) ? gs : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [deptFilter, statusFilter, gradeFilter])

  useEffect(() => { load() }, [load])

  async function openDetail(emp: Employee) {
    setDetail(emp)
    setDetailTab('personal')
    setLeaveBalances([])
    setLoadingLeave(true)
    try {
      const full = await apiFetch<Employee>(`/api/hr/employees/${emp.id}`)
      setDetail(full)
      const lb = await apiFetch<LeaveBalance[]>(`/api/hr/employees/${emp.id}/leave-balance`)
      setLeaveBalances(Array.isArray(lb) ? lb : [])
    } catch { /* keep what we have */ }
    finally { setLoadingLeave(false) }
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
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<Employee>[] = [
    {
      key: 'staff_id', label: 'Staff ID',
      render: r => <span style={{ ...NUM, fontSize: 12, fontWeight: 700, color: NAVY }}>{r.staff_id ?? '—'}</span>,
    },
    {
      key: 'first_name', label: 'Name',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.first_name} {r.last_name}</span>,
    },
    {
      key: 'department', label: 'Department',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.department ?? '—'}</span>,
    },
    {
      key: 'job_title', label: 'Job Title',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.job_title ?? '—'}</span>,
    },
    {
      key: 'grade_level', label: 'Grade',
      render: r => r.grade_level ? (
        <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${BLUE}12`, color: BLUE }}>
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
        canManage ? (
          <button onClick={() => { setForm(BLANK); setAddOpen(true) }} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>
            Add Employee
          </button>
        ) : undefined
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

      <SectionCard title="Employees" badge={employees.length} padding={false} actions={<button onClick={() => exportEmployeesCsv(employees)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
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
            <button onClick={() => { setSel(new Set()) }}
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#C00000', color: 'white', cursor: 'pointer', fontSize: 12 }}>
              Deactivate Selected
            </button>
          }
        />
      </SectionCard>

      {/* Add modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Employee" width={580}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setAddOpen(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Add Employee
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {([['First Name *', 'first_name'], ['Last Name *', 'last_name'], ['Email', 'email'], ['Phone', 'phone'], ['Job Title', 'job_title']] as [string, keyof Employee][]).map(([label, key]) => (
              <div key={key}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>{label}</label>
                <input value={(form[key] as string) ?? ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} style={inputStyle} />
              </div>
            ))}
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Department</label>
              <select value={form.department_id ?? ''} onChange={e => setForm(f => ({ ...f, department_id: Number(e.target.value) || undefined }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                <option value="">— Select —</option>
                {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Grade Level</label>
              <select value={form.grade_level_id ?? ''} onChange={e => setForm(f => ({ ...f, grade_level_id: Number(e.target.value) || undefined }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                <option value="">— Select —</option>
                {grades.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Gross Salary (₦)</label>
              <input type="number" value={form.salary_kobo ? form.salary_kobo / 100 : ''} onChange={e => setForm(f => ({ ...f, salary_kobo: Math.round(Number(e.target.value) * 100) }))} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Bank Name</label>
              <input value={form.bank_name ?? ''} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Account Number</label>
              <input value={form.account_number ?? ''} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} style={inputStyle} />
            </div>
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.first_name} ${detail.last_name}` : ''} width={560}>
        {detail && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <StatusBadge status={detail.status} />
              {detail.staff_id && <span style={{ ...NUM, fontSize: 12, fontWeight: 700, color: NAVY }}>{detail.staff_id}</span>}
            </div>
            <Tabs tabs={detailTabs} active={detailTab} onChange={setDetailTab} />
            <div style={{ paddingTop: 16 }}>
              {detailTab === 'personal' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    ['Date of Birth',     detail.date_of_birth ? fmtDate(detail.date_of_birth) : '—'],
                    ['Gender',            detail.gender ?? '—'],
                    ['Phone',             detail.phone ?? '—'],
                    ['Email',             detail.email ?? '—'],
                    ['Address',           detail.address ?? '—'],
                    ['Emergency Contact', detail.emergency_contact_name ?? '—'],
                    ['Emergency Phone',   detail.emergency_contact_phone ?? '—'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                      <span style={{ color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: 'var(--txt)', fontWeight: 500 }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
              {detailTab === 'employment' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    ['Staff ID',       detail.staff_id ?? '—'],
                    ['Department',     detail.department ?? '—'],
                    ['Job Title',      detail.job_title ?? '—'],
                    ['Grade Level',    detail.grade_level ?? '—'],
                    ['Start Date',     detail.start_date ? fmtDate(detail.start_date) : '—'],
                    ['Manager',        detail.manager_name ?? '—'],
                    ['Contract Type',  detail.contract_type ?? '—'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                      <span style={{ color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: 'var(--txt)', fontWeight: 500 }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
              {detailTab === 'payroll' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    ['Bank',           detail.bank_name ?? '—'],
                    ['Account Number', detail.account_number ?? '—'],
                    ['Gross Salary',   detail.salary_kobo ? fmtKobo(detail.salary_kobo) : '—'],
                    ['Pension RSA PIN',detail.pension_rsa_pin ?? '—'],
                    ['HMO Plan',       detail.hmo_plan ?? '—'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                      <span style={{ color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: 'var(--txt)', fontWeight: 500 }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
              {detailTab === 'leave' && (
                loadingLeave ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner size={24} /></div>
                ) : leaveBalances.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--txt2)', fontSize: 13 }}>No leave balances found.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {leaveBalances.map(lb => (
                      <div key={lb.leave_type} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--th-bg)', borderRadius: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', marginBottom: 3 }}>{lb.leave_type}</div>
                          <div style={{ height: 5, background: 'var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
                            <div style={{ width: `${lb.total_days > 0 ? (lb.remaining_days / lb.total_days) * 100 : 0}%`, height: '100%', background: GREEN, borderRadius: 10 }} />
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', minWidth: 70 }}>
                          <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: GREEN }}>{lb.remaining_days}</div>
                          <div style={{ fontSize: 11, color: 'var(--txt3)' }}>of {lb.total_days} left</div>
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
