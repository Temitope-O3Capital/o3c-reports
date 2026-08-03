import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  Modal, ConfirmModal, ErrBanner, Spinner, StatusBadge, btnPrimary, DateFilter,
  NameCell, ActionRow,
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
  staff_id?: string
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

  const [search, setSearch]   = useState('')
  const [fType, setFType]     = useState(new Set<string>())
  const [fStatus, setFStatus] = useState(new Set<string>())

  const [newOpen, setNewOpen]       = useState(false)
  const [form, setForm]             = useState(BLANK)
  const [saving, setSaving]         = useState(false)

  const [rejectEntry, setRejectEntry]   = useState<Leave | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting]       = useState(false)


  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
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
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['hr','payroll'] })

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
    try {
      await apiPut(`/api/hr/leave/${id}/approve`, {})
      toast.success('Leave approved')
      load()
    } catch (e: any) { toast.error(e.message) }
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

  const uniqueTypes = useMemo(() => leaveTypes.map(t => t.name), [leaveTypes])

  const filtered = useMemo(() => leaves.filter(r => {
    if (fType.size && !fType.has(r.leave_type)) return false
    if (fStatus.size && !fStatus.has(r.status)) return false
    if (search) {
      const q = search.toLowerCase()
      if (![r.employee_name, r.leave_type, r.status].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [leaves, fType, fStatus, search])

  const cols: TableCol<Leave>[] = [
    {
      key: 'employee_name', label: 'Employee',
      render: r => <NameCell name={r.employee_name} sub={r.staff_id ?? null} />,
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
      key: 'id' as const, label: '', sortable: false,
      render: (r: Leave) => r.status === 'pending' ? (
        <ActionRow actions={[
          { icon: 'check_circle', label: 'Approve', onClick: () => handleApprove(r.id) },
          { icon: 'cancel', label: 'Decline', onClick: () => { setRejectEntry(r); setRejectReason('') }, danger: true },
        ]} />
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

      <SectionCard title="Leave Requests" badge={leaves.length} padding={false} actions={<button onClick={() => exportLeaveCsv(leaves)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={[
            {
              key: 'type', label: 'Leave Type',
              options: uniqueTypes.map(t => ({ value: t, color: TYPE_COLORS[t], count: leaves.filter(r => r.leave_type === t).length })),
              selected: fType, onChange: (next: Set<string>) => setFType(next),
            },
            {
              key: 'status', label: 'Status',
              options: [
                { value: 'pending',  label: 'Pending',  color: AMBER, count: leaves.filter(r => r.status === 'pending').length },
                { value: 'approved', label: 'Approved', color: GREEN, count: leaves.filter(r => r.status === 'approved').length },
                { value: 'declined', label: 'Declined', color: '#C00000', count: leaves.filter(r => r.status === 'declined').length },
              ],
              selected: fStatus, onChange: (next: Set<string>) => setFStatus(next),
            },
          ]}
          onReset={() => { setSearch(''); setFType(new Set()); setFStatus(new Set()) }}
          resultCount={filtered.length} totalCount={leaves.length}
          placeholder="Search leave requests…"
        />
        <DataTable<Leave>
          cols={cols}
          rows={filtered}
          keyFn={r => r.id}
          emptyText="No leave requests found."
          skeletonRows={loading ? 6 : 0}
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
