import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, Spinner, StatusBadge, btnPrimary, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Leave {
  id: number
  employee_name: string
  employee_id: number
  leave_type: string
  start_date: string
  end_date: string
  days: number
  status: string
  reason?: string
  applied_at: string
  approved_by_name?: string
}

interface LeaveType { id: number; name: string; max_days: number }

// ── Helpers ────────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  Annual: BLUE, Sick: AMBER, Maternity: '#7C3AED', Paternity: '#0891B2', Emergency: RED,
}

function TypePill({ type }: { type: string }) {
  const color = TYPE_COLORS[type] ?? NAVY
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${color}14`, color }}>
      {type}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK = { employee_id: '', leave_type_id: '', start_date: '', end_date: '', reason: '' }

export default function Leave() {
  const storedUser = localStorage.getItem('auth_user')
  const userRole = storedUser ? (JSON.parse(storedUser) as AuthUser).role : ''
  const canApprove = ['hr_manager', 'hr_officer', 'head_hr', 'admin'].includes(userRole)

  const [leaves, setLeaves]         = useState<Leave[]>([])
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([])
  const [loading, setLoading]       = useState(true)
  const [err, setErr]               = useState<string | null>(null)

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const [typeFilter, setTypeFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [newOpen, setNewOpen]       = useState(false)
  const [form, setForm]             = useState(BLANK)
  const [saving, setSaving]         = useState(false)

  const [rejectEntry, setRejectEntry]   = useState<Leave | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting]       = useState(false)

  const [approving, setApproving] = useState<number | null>(null)

  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (typeFilter)   p.set('leave_type', typeFilter)
      if (statusFilter) p.set('status', statusFilter)
      p.set('from', dateFrom)
      p.set('to', dateTo)
      const [ls, ts] = await Promise.all([
        apiFetch<{ data: Leave[] }>(`/api/hr/leave?${p}`),
        apiFetch<{ data: LeaveType[] }>('/api/hr/leave-types'),
      ])
      setLeaves(Array.isArray(ls.data) ? ls.data : [])
      setLeaveTypes(Array.isArray(ts.data) ? ts.data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [typeFilter, statusFilter, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    if (!form.start_date || !form.end_date || !form.leave_type_id) { toast.error('All required fields must be filled'); return }
    setSaving(true)
    try {
      await apiPost('/api/hr/leave', form)
      toast.success('Leave request submitted')
      setNewOpen(false); setForm(BLANK); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleApprove(id: number) {
    setApproving(id)
    try {
      await apiPut(`/api/hr/leave/${id}/approve`, {})
      toast.success('Leave approved')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setApproving(null) }
  }

  async function handleReject() {
    if (!rejectEntry) return
    setRejecting(true)
    try {
      await apiPut(`/api/hr/leave/${rejectEntry.id}/decline`, { reason: rejectReason })
      toast.success('Leave declined')
      setRejectEntry(null); setRejectReason(''); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setRejecting(false) }
  }

  async function handleBatchApprove() {
    const ids = Array.from(sel) as number[]
    await Promise.all(ids.map(id => apiPut(`/api/hr/leave/${id}/approve`, {}).catch(() => null)))
    toast.success(`${ids.length} leave request(s) approved`)
    setSel(new Set()); load()
  }

  async function handleBatchDecline() {
    const ids = Array.from(sel) as number[]
    await Promise.all(ids.map(id => apiPut(`/api/hr/leave/${id}/decline`, { reason: '' }).catch(() => null)))
    toast.success(`${ids.length} leave request(s) declined`)
    setSel(new Set()); load()
  }

  function exportLeaveCsv(rows: Leave[]) {
    const header = ['Employee', 'Leave Type', 'From', 'To', 'Days', 'Status', 'Applied']
    const lines = rows.map(r => [
      `"${String(r.employee_name ?? '').replace(/"/g, '""')}"`,
      r.leave_type ?? '',
      r.start_date ?? '',
      r.end_date ?? '',
      r.days ?? 0,
      r.status ?? '',
      r.applied_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `leave-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<Leave>[] = [
    {
      key: 'employee_name', label: 'Employee',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.employee_name}</span>,
    },
    {
      key: 'leave_type', label: 'Type',
      render: r => <TypePill type={r.leave_type} />,
    },
    {
      key: 'start_date', label: 'From',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDate(r.start_date)}</span>,
    },
    {
      key: 'end_date', label: 'To',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDate(r.end_date)}</span>,
    },
    {
      key: 'days', label: 'Days', align: 'right',
      render: r => <span style={NUM}>{r.days}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
    {
      key: 'applied_at', label: 'Applied',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDate(r.applied_at)}</span>,
    },
    ...(canApprove ? [{
      key: 'id' as const, label: '',
      render: (r: Leave) => r.status === 'pending' ? (
        <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
          <button
            onClick={() => handleApprove(r.id)}
            disabled={approving === r.id}
            style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: `1.5px solid ${GREEN}40`, background: 'transparent', color: GREEN, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            {approving === r.id ? '…' : 'Approve'}
          </button>
          <button
            onClick={() => { setRejectEntry(r); setRejectReason('') }}
            style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: '1.5px solid rgba(192,0,0,.3)', background: 'transparent', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            Decline
          </button>
        </div>
      ) : null,
    }] : []),
  ]

  return (
    <Page
      title="Leave Management"
      subtitle="Employee leave requests and approvals"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={() => { setForm(BLANK); setNewOpen(true) }} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
            New Request
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setTypeFilter(''); setStatusFilter('') }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Types</option>
          {leaveTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="declined">Declined</option>
        </select>
      </FilterBar>

      <SectionCard title="Leave Requests" badge={leaves.length} padding={false} actions={<button onClick={() => exportLeaveCsv(leaves)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>
        <DataTable<Leave>
          cols={cols}
          rows={leaves}
          keyFn={r => r.id}
          emptyText="No leave requests found."
          skeletonRows={loading ? 6 : 0}
          searchKeys={['employee_name', 'leave_type', 'status']}
          searchPlaceholder="Search leave requests…"
          pageSize={20}

          selectable
          selectedIds={sel}
          onSelect={setSel}
          bulkBar={
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={handleBatchApprove}
                style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: 'none', background: GREEN, color: 'white', cursor: 'pointer', fontSize: TEXT.sm }}>
                Approve Selected
              </button>
              <button onClick={handleBatchDecline}
                style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: 'none', background: '#C00000', color: 'white', cursor: 'pointer', fontSize: TEXT.sm }}>
                Decline Selected
              </button>
            </div>
          }
        />
      </SectionCard>

      {/* New Request modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Leave Request" width={440}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Submit Request
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Leave Type *</label>
            <select value={form.leave_type_id} onChange={e => setForm(f => ({ ...f, leave_type_id: e.target.value }))}
              style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
              <option value="">— Select —</option>
              {leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>From *</label>
              <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} style={{ ...inputStyle, height: 36 }} />
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>To *</label>
              <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} style={{ ...inputStyle, height: 36 }} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Reason</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} rows={3}
              style={{ ...inputStyle, resize: 'vertical' }} placeholder="Optional reason…" />
          </div>
        </div>
      </Modal>

      {/* Decline modal */}
      <Modal open={!!rejectEntry} onClose={() => setRejectEntry(null)} title="Decline Leave Request" width={400}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setRejectEntry(null)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleReject} disabled={rejecting} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', opacity: rejecting ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {rejecting && <Spinner size={14} color="#fff" />}
              Decline
            </button>
          </div>
        }
      >
        <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[3] }}>
          Declining {rejectEntry?.employee_name}'s {rejectEntry?.leave_type} leave request.
        </div>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
          placeholder="Reason for declining (optional)…"
          style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
      </Modal>
    </Page>
  )
}
