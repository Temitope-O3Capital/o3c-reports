import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, StatusBadge, KpiCard, Page, SectionCard, DataTable, NAVY, RED, GREEN, AMBER } from '../../components/UI'
import type { ColDef } from '../../components/UI'

interface LeaveType { id: string; name: string; is_paid: boolean; max_days_per_year: number }
interface LeaveRow {
  id: string; employee_id: string; first_name: string; last_name: string; staff_id: string
  leave_type_id: string; leave_type_name: string; start_date: string; end_date: string
  days_requested: number; reason: string; status: string; approved_by: string | null
  approval_notes: string | null; created_at: string
}
interface ApproveForm { notes: string }
interface AddForm {
  employee_id: string; leave_type_id: string; start_date: string
  end_date: string; days_requested: string; reason: string
}

const EMPTY_ADD: AddForm = {
  employee_id: '', leave_type_id: '', start_date: '', end_date: '', days_requested: '', reason: '',
}

export default function Leave() {
  const [rows, setRows]           = useState<LeaveRow[]>([])
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [statusF, setStatusF]     = useState('')

  // Approve / decline modal
  const [action, setAction]       = useState<{ row: LeaveRow; type: 'approve' | 'decline' } | null>(null)
  const [actionForm, setActionForm] = useState<ApproveForm>({ notes: '' })
  const [actioning, setActioning] = useState(false)
  const [actionErr, setActionErr] = useState('')

  // Add request modal
  const [showAdd, setShowAdd]     = useState(false)
  const [addForm, setAddForm]     = useState<AddForm>(EMPTY_ADD)
  const [adding, setAdding]       = useState(false)
  const [addErr, setAddErr]       = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ limit: '100', ...(statusF ? { status: statusF } : {}) })
      const [rLeaves, rTypes] = await Promise.allSettled([
        apiFetch<{ data: LeaveRow[] }>(`/api/hr/leave?${params}`),
        apiFetch<LeaveType[]>('/api/hr/leave-types'),
      ])
      if (rLeaves.status === 'fulfilled') setRows(rLeaves.value.data ?? [])
      if (rTypes.status === 'fulfilled') setLeaveTypes(Array.isArray(rTypes.value) ? rTypes.value : [])
      if (rLeaves.status === 'rejected' && rTypes.status === 'rejected')
        setError((rLeaves as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [statusF])

  useEffect(() => { load() }, [load])

  async function submitAction() {
    if (!action) return
    setActioning(true); setActionErr('')
    try {
      const endpoint = action.type === 'approve'
        ? `/api/hr/leave/${action.row.id}/approve`
        : `/api/hr/leave/${action.row.id}/decline`
      await apiPut(endpoint, { notes: actionForm.notes })
      setAction(null)
      load()
    } catch (e: any) {
      setActionErr(e.message)
    } finally {
      setActioning(false)
    }
  }

  async function submitAdd() {
    setAdding(true); setAddErr('')
    try {
      await apiPost('/api/hr/leave', {
        ...addForm,
        days_requested: Number(addForm.days_requested),
      })
      setShowAdd(false)
      setAddForm(EMPTY_ADD)
      load()
    } catch (e: any) {
      setAddErr(e.message)
    } finally {
      setAdding(false)
    }
  }

  const pending  = rows.filter(r => r.status === 'pending').length
  const approved = rows.filter(r => r.status === 'approved').length
  const declined = rows.filter(r => r.status === 'declined').length

  const cols: ColDef<LeaveRow>[] = [
    { key: 'staff_id',       label: 'Staff ID',    render: r => <span className="font-mono text-[12px] text-slate-500">{r.staff_id}</span> },
    { key: 'name',           label: 'Employee',    render: r => <span className="font-semibold text-slate-800">{r.first_name} {r.last_name}</span> },
    { key: 'leave_type_name',label: 'Type' },
    { key: 'start_date',     label: 'From',        render: r => fmtDate(r.start_date) },
    { key: 'end_date',       label: 'To',          render: r => fmtDate(r.end_date) },
    { key: 'days_requested', label: 'Days',        right: true },
    { key: 'status',         label: 'Status',      render: r => <StatusBadge status={r.status} /> },
    { key: 'created_at',     label: 'Requested',   render: r => fmtDate(r.created_at) },
    {
      key: 'actions', label: '', sortable: false,
      render: r => r.status === 'pending' ? (
        <div className="flex gap-2">
          <button onClick={() => { setAction({ row: r, type: 'approve' }); setActionForm({ notes: '' }) }}
            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-white" style={{ background: GREEN }}>
            Approve
          </button>
          <button onClick={() => { setAction({ row: r, type: 'decline' }); setActionForm({ notes: '' }) }}
            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-white" style={{ background: RED }}>
            Decline
          </button>
        </div>
      ) : null,
    },
  ]

  return (
    <Page
      dept="HR"
      title="Leave Management"
      actions={
        <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white" style={{ background: NAVY }}
          onClick={() => { setShowAdd(true); setAddForm(EMPTY_ADD) }}>
          <span className="material-symbols-rounded text-[15px] align-middle mr-1">add</span>
          Request Leave
        </button>
      }
    >
      <ErrBanner msg={error} />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <KpiCard label="Pending Approval" value={String(pending)}  icon="hourglass_empty" accent={AMBER} loading={loading && !rows.length} />
        <KpiCard label="Approved"         value={String(approved)} icon="check_circle"    accent={GREEN} loading={loading && !rows.length} />
        <KpiCard label="Declined"         value={String(declined)} icon="cancel"          accent={RED}   loading={loading && !rows.length} />
      </div>

      <SectionCard
        title="Leave Requests"
        actions={
          <select className="px-3 py-1.5 rounded-lg border border-slate-200 text-[12px] focus:outline-none"
            value={statusF} onChange={e => setStatusF(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
          </select>
        }
      >
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="event_busy" emptyMsg="No leave requests found" />
      </SectionCard>

      {/* Approve / decline modal */}
      {action && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setAction(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="leave-action-title" className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 id="leave-action-title" className="text-[16px] font-bold text-slate-800 capitalize">{action.type} Leave Request</h2>
              <button onClick={() => setAction(null)} className="text-slate-400 hover:text-slate-700">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <p className="text-[13px] text-slate-600 mb-1">
              <span className="font-semibold">{action.row.first_name} {action.row.last_name}</span> — {action.row.leave_type_name}
            </p>
            <p className="text-[12px] text-slate-400 mb-4">
              {fmtDate(action.row.start_date)} to {fmtDate(action.row.end_date)} ({action.row.days_requested} days)
            </p>
            <ErrBanner msg={actionErr} />
            <div className="mb-4">
              <label htmlFor="leave-notes" className="block text-[12px] font-semibold text-slate-500 mb-1">Notes (optional)</label>
              <textarea id="leave-notes" rows={3} className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                value={actionForm.notes} onChange={e => setActionForm({ notes: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setAction(null)}>Cancel</button>
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: action.type === 'approve' ? GREEN : RED }}
                disabled={actioning} onClick={submitAction}>
                {actioning ? 'Saving…' : action.type === 'approve' ? 'Approve' : 'Decline'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add leave request modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div role="dialog" aria-modal="true" aria-labelledby="leave-add-title" className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg">
            <div className="flex items-center justify-between mb-5">
              <h2 id="leave-add-title" className="text-[16px] font-bold text-slate-800">New Leave Request</h2>
              <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-700">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={addErr} />
            <div className="space-y-3">
              {[
                ['Employee ID *', 'employee_id', 'text', 'UUID or staff ref'],
                ['Start Date *',  'start_date',  'date', ''],
                ['End Date *',    'end_date',    'date', ''],
                ['Days *',        'days_requested', 'number', ''],
              ].map(([label, key, type, ph]) => (
                <div key={key}>
                  <label htmlFor={`leave-add-${key}`} className="block text-[12px] font-semibold text-slate-500 mb-1">{label}</label>
                  <input id={`leave-add-${key}`} type={type as string} placeholder={ph as string}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                    value={(addForm as any)[key]} onChange={e => setAddForm(f => ({ ...f, [key]: e.target.value }))} />
                </div>
              ))}
              <div>
                <label htmlFor="leave-add-type" className="block text-[12px] font-semibold text-slate-500 mb-1">Leave Type *</label>
                <select id="leave-add-type" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                  value={addForm.leave_type_id} onChange={e => setAddForm(f => ({ ...f, leave_type_id: e.target.value }))}>
                  <option value="">Select type…</option>
                  {leaveTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.name} (max {t.max_days_per_year} days/yr{t.is_paid ? ', paid' : ''})</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="leave-add-reason" className="block text-[12px] font-semibold text-slate-500 mb-1">Reason</label>
                <textarea id="leave-add-reason" rows={3} className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                  value={addForm.reason} onChange={e => setAddForm(f => ({ ...f, reason: e.target.value }))} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: NAVY }}
                disabled={adding || !addForm.employee_id || !addForm.leave_type_id || !addForm.start_date || !addForm.end_date || !addForm.days_requested}
                onClick={submitAdd}>
                {adding ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
