import { snake } from '../../lib/labels'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch, apiPost } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, StatusBadge, KpiCard, Page, Pagination, FilterBar, NAVY, RED, GREEN } from '../../components/UI'

// ── Types ─────────────────────────────────────────────────────────
interface Department { id: string; name: string }
interface Employee {
  id: string; staff_id: string; first_name: string; last_name: string
  email?: string; phone?: string; department_id?: string; department_name?: string
  job_title?: string; grade?: string; employment_type?: string
  employment_date?: string; salary_kobo?: number; status: string
}
interface LeaveBalance { leave_type: string; total_days: number; used_days: number; remaining: number }
interface DashStats { total_active: number; on_leave: number; exiting_this_month: number }

interface AddForm {
  staff_id: string; first_name: string; last_name: string; email: string; phone: string
  department_id: string; job_title: string; employment_type: string
  employment_date: string; salary_kobo: string
}

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern']

export default function Employees() {
  const [employees, setEmployees]     = useState<Employee[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [stats, setStats]             = useState<DashStats | null>(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')

  const [search, setSearch]           = useState('')
  const [deptF, setDeptF]             = useState('')
  const [statusF, setStatusF]         = useState('active')
  const [page, setPage]               = useState(0)
  const limit = 50

  // Sidebar
  const [selected, setSelected]       = useState<Employee | null>(null)
  const [leaveBalance, setLeaveBalance] = useState<LeaveBalance[]>([])
  const [lbLoading, setLbLoading]     = useState(false)

  // Add modal
  const [showAdd, setShowAdd]         = useState(false)
  const [addForm, setAddForm]         = useState<AddForm>({
    staff_id: '', first_name: '', last_name: '', email: '', phone: '',
    department_id: '', job_title: '', employment_type: 'full_time',
    employment_date: '', salary_kobo: '',
  })
  const [adding, setAdding]           = useState(false)
  const [addErr, setAddErr]           = useState('')
  const [reloadKey, setReloadKey]     = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    async function load() {
      try {
        const params = new URLSearchParams({
          status: statusF,
          limit: String(limit),
          offset: String(page * limit),
          ...(search ? { q: search } : {}),
        })
        const [rEmp, rDept, rDash] = await Promise.allSettled([
          apiFetch<{ data: Employee[] }>(`/api/hr/employees?${params}`),
          apiFetch<Department[]>('/api/hr/departments'),
          apiFetch<DashStats>('/api/hr/dashboard'),
        ])
        if (!active) return
        if (rEmp.status === 'fulfilled') setEmployees(rEmp.value.data ?? [])
        if (rDept.status === 'fulfilled') setDepartments(Array.isArray(rDept.value) ? rDept.value : [])
        if (rDash.status === 'fulfilled') setStats(rDash.value)
        if ([rEmp, rDept, rDash].every(r => r.status === 'rejected')) {
          setError((rEmp as PromiseRejectedResult).reason?.message ?? 'Failed to load')
        }
      } catch (e: any) { if (active) setError(e.message) }
      finally { if (active) setLoading(false) }
    }
    load()
    return () => { active = false }
  }, [statusF, page, search, reloadKey])

  async function selectEmployee(emp: Employee) {
    setSelected(emp)
    setLbLoading(true)
    try {
      const res = await apiFetch<LeaveBalance[]>(`/api/hr/employees/${emp.id}/leave-balance`)
      setLeaveBalance(Array.isArray(res) ? res : [])
    } catch { setLeaveBalance([]) }
    finally { setLbLoading(false) }
  }

  function setAdd(k: keyof AddForm, v: string) {
    setAddForm(f => ({ ...f, [k]: v }))
  }

  async function submitAdd() {
    setAdding(true); setAddErr('')
    try {
      await apiPost('/api/hr/employees', {
        ...addForm,
        salary_kobo: addForm.salary_kobo ? Math.round(parseFloat(addForm.salary_kobo) * 100) : undefined,
        department_id: addForm.department_id || undefined,
      })
      setShowAdd(false)
      setAddForm({ staff_id: '', first_name: '', last_name: '', email: '', phone: '', department_id: '', job_title: '', employment_type: 'full_time', employment_date: '', salary_kobo: '' })
      toast.success('Employee added successfully')
      setReloadKey(k => k + 1)
    } catch (e: any) {
      setAddErr(e.message)
    } finally {
      setAdding(false)
    }
  }

  const filtered = deptF ? employees.filter(e => e.department_id === deptF) : employees

  return (
    <Page
      dept="HR"
      title="Employee Directory"
      actions={
        <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white" style={{ background: NAVY }} onClick={() => setShowAdd(true)}>
          <span className="material-symbols-rounded text-[15px] align-middle mr-1" aria-hidden="true">person_add</span>
          Add Employee
        </button>
      }
    >
      <ErrBanner msg={error} />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <KpiCard label="Active Staff" value={String(stats?.total_active ?? '—')} icon="group" accent={GREEN} loading={loading && !stats} />
        <KpiCard label="On Leave" value={String(stats?.on_leave ?? '—')} icon="event_busy" accent="#D97706" loading={loading && !stats} />
        <KpiCard label="Exiting This Month" value={String(stats?.exiting_this_month ?? '—')} icon="logout" accent="#C00000" loading={loading && !stats} />
      </div>

      <div className="flex gap-5">
        {/* Table section */}
        <div className="flex-1 min-w-0">
          <FilterBar>
            <input className="w-full max-w-xs px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              placeholder="Search by name or staff ID…" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} />
            <select className="px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={deptF} onChange={e => setDeptF(e.target.value)}>
              <option value="">All Departments</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select className="px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={statusF} onChange={e => { setStatusF(e.target.value); setPage(0) }}>
              <option value="active">Active</option>
              <option value="">All</option>
            </select>
          </FilterBar>

          <div className="card overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                      {['Staff ID','Name','Department','Job Title','Grade','Status','Start Date',''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--txt2)', fontFamily: "'Inter', ui-sans-serif, sans-serif", fontSize: 10 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr><td colSpan={8} className="px-4 py-14 text-center text-[13px]" style={{ color: 'var(--txt2)' }}>No employees found</td></tr>
                    ) : filtered.map(emp => (
                      <tr key={emp.id} className="cursor-pointer" style={{ borderBottom: '1px solid var(--bdr)', transition: 'background .1s' }} onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'} onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''} onClick={() => selectEmployee(emp)}>
                        <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>{emp.staff_id}</td>
                        <td className="px-4 py-3 font-semibold" style={{ color: 'var(--txt)' }}>{emp.first_name} {emp.last_name}</td>
                        <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{emp.department_name ?? '—'}</td>
                        <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{emp.job_title ?? '—'}</td>
                        <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{emp.grade ?? '—'}</td>
                        <td className="px-4 py-3"><StatusBadge status={emp.status} /></td>
                        <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{fmtDate(emp.employment_date)}</td>
                        <td className="px-4 py-3">
                          <button style={{ color: 'var(--txt2)' }}><span className="material-symbols-rounded text-[18px]">chevron_right</span></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination page={page} hasMore={employees.length >= limit} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
          </div>
        </div>

        {/* Employee sidebar */}
        {selected && (
          <div className="w-72 flex-shrink-0 space-y-4">
            <div className="card p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px]" style={{ background: NAVY }}>
                  {selected.first_name.charAt(0)}
                </div>
                <div>
                  <p className="text-[14px] font-bold" style={{ color: 'var(--txt)' }}>{selected.first_name} {selected.last_name}</p>
                  <p className="text-[11px] font-mono" style={{ color: 'var(--txt2)' }}>{selected.staff_id}</p>
                </div>
              </div>
              <div className="space-y-2">
                {[
                  ['Email', selected.email ?? '—'],
                  ['Phone', selected.phone ?? '—'],
                  ['Title', selected.job_title ?? '—'],
                  ['Department', selected.department_name ?? '—'],
                  ['Grade', selected.grade ?? '—'],
                  ['Type', snake(selected.employment_type ?? '—')],
                  ['Salary', selected.salary_kobo ? fmt(selected.salary_kobo / 100) + '/mo' : '—'],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{k}</span>
                    <span className="text-[12px] text-right max-w-[60%] truncate" style={{ color: 'var(--txt)' }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* Leave balance */}
            <div className="card p-4">
              <p className="text-[12px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--txt2)' }}>Leave Balance</p>
              {lbLoading ? <Spinner size={20} /> : leaveBalance.length === 0 ? (
                <p className="text-[12px]" style={{ color: 'var(--txt2)' }}>No leave data</p>
              ) : leaveBalance.map((lb, i) => (
                <div key={i} className="mb-3">
                  <div className="flex justify-between mb-1">
                    <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{lb.leave_type}</span>
                    <span className="text-[12px] font-semibold" style={{ color: 'var(--txt)' }}>{lb.remaining} / {lb.total_days} days</span>
                  </div>
                  <div className="h-1.5 rounded-full" style={{ background: 'var(--chip-bg)' }}>
                    <div className="h-full rounded-full" style={{ width: `${lb.total_days > 0 ? (lb.used_days / lb.total_days) * 100 : 0}%`, background: NAVY }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Add Employee modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={e => { if (e.target === e.currentTarget) setShowAdd(false) }}>
          <div role="dialog" aria-modal="true" aria-labelledby="add-emp-title"
            className="rounded-2xl shadow-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card)' }}>
            <div className="flex items-center justify-between mb-5">
              <h2 id="add-emp-title" className="text-[16px] font-bold" style={{ color: 'var(--txt)' }}>Add Employee</h2>
              <button onClick={() => setShowAdd(false)} style={{ color: 'var(--txt2)' }} aria-label="Close">
                <span className="material-symbols-rounded text-[20px]" aria-hidden="true">close</span>
              </button>
            </div>
            <ErrBanner msg={addErr} />
            <div className="grid grid-cols-2 gap-4">
              {[
                ['Staff ID *', 'staff_id', 'text', 'e.g. STF0042'],
                ['First Name *', 'first_name', 'text', ''],
                ['Last Name *', 'last_name', 'text', ''],
                ['Email', 'email', 'email', ''],
                ['Phone', 'phone', 'tel', ''],
                ['Job Title', 'job_title', 'text', ''],
                ['Start Date', 'employment_date', 'date', ''],
                ['Monthly Salary (₦)', 'salary_kobo', 'number', ''],
              ].map(([label, key, type, placeholder]) => (
                <div key={key}>
                  <label htmlFor={`emp-${key}`} className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>{label}</label>
                  <input id={`emp-${key}`} type={type as string} placeholder={placeholder as string}
                    className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                    value={(addForm as any)[key]} onChange={e => setAdd(key as keyof AddForm, e.target.value)} />
                </div>
              ))}
              <div>
                <label htmlFor="emp-department_id" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Department</label>
                <select id="emp-department_id" className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.department_id} onChange={e => setAdd('department_id', e.target.value)}>
                  <option value="">Select…</option>
                  {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="emp-employment_type" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Employment Type</label>
                <select id="emp-employment_type" className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.employment_type} onChange={e => setAdd('employment_type', e.target.value)}>
                  {EMPLOYMENT_TYPES.map(t => <option key={t} value={t}>{snake(t)}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-[color:var(--txt)] bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: NAVY }} disabled={adding || !addForm.staff_id || !addForm.first_name || !addForm.last_name} onClick={submitAdd}>
                {adding ? 'Adding…' : 'Add Employee'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
