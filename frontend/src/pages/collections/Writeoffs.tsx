import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Page, Tabs, KpiCard, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, ConfirmModal, DateFilter, NameCell, ActionRow, Modal, Spinner,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { LiveBadge } from '../../components/MyWorkspace'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { useFocusParam } from '../../hooks/useFocusParam'
import { fmtKoboExact, fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { RED, DARKRED, GREEN, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// Two distinct write-off flows, unified onto one page as tabs:
//   • Approvals — recovery-originated write-offs a head approves/returns (was Write-off Queue).
//   • Requests  — collections-initiated write-off requests, raised here via a modal and
//                 approved/rejected by a head (was Write-off Requests).
// The two live in separate tables (recovery_write_off_approvals vs collections_writeoff_requests)
// with separate endpoints, so they stay separate panes rather than one merged table.

function getUser(): { role?: string } {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') }
  catch { return {} }
}

// ════════════════════════════════════════════════════════════════════════════════
//  APPROVALS PANE — recovery-originated write-offs (approve to post / return)
// ════════════════════════════════════════════════════════════════════════════════

interface WriteoffKPIs { total: number; amount_kobo: number; recovery_rate_pct: number; pending: number }
interface WriteoffRow {
  id: number
  account_cif: string
  customer_name: string | null
  outstanding_kobo: number
  amount_kobo: number
  reason: string | null
  status: string
  stage_label: string        // "Awaiting Head of Operations" | "Awaiting COO" | "Awaiting CFO"
  required_role: string      // role that must sign THIS stage: head_ops | coo | cfo
  dpd: number
  last_payment_date: string | null
  recovery_attempts: number
  recommended_by: string | null
}

function DpdBadge({ dpd }: { dpd: number }) {
  const color = dpd > 720 ? DARKRED : dpd > 360 ? '#A00000' : RED
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 7px', borderRadius: RADIUS['2xl'], background: `${color}22`, color, whiteSpace: 'nowrap' }}>
      {dpd} DPD
    </span>
  )
}

type ApprovalModal =
  | { type: 'approve'; row: WriteoffRow }
  | { type: 'reject'; row: WriteoffRow }
  | null

// The write-off approval chain, mirrored from the backend (recovery_ops.go
// stageProgressions) so the UI can render each stage and colour the current one.
const WRITEOFF_CHAIN: { role: string; label: string }[] = [
  { role: 'head_ops', label: 'HOP' },
  { role: 'coo',      label: 'COO' },
  { role: 'cfo',      label: 'CFO' },
]

// Shows the request's position in the HOP → COO → CFO chain, highlighting the stage that
// is currently waiting and (when `mine`) flagging that it's the viewer's turn to act.
function StageBadge({ row, mine }: { row: WriteoffRow; mine: boolean }) {
  const idx = WRITEOFF_CHAIN.findIndex(s => s.role === row.required_role)
  const color = mine ? GREEN : AMBER
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${color}1F`, color, whiteSpace: 'nowrap' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{mine ? 'how_to_reg' : 'schedule'}</span>
        {row.stage_label.replace('Awaiting ', '')}
      </span>
      <span style={{ fontSize: 10, color: 'var(--txt3)', fontFamily: NUM.fontFamily as string, whiteSpace: 'nowrap' }}>
        {idx >= 0 ? `${idx + 1}/${WRITEOFF_CHAIN.length}` : ''}
      </span>
    </div>
  )
}

function ApprovalsPane({ onCount }: { onCount: (n: number) => void }) {
  const [rows, setRows]       = useState<WriteoffRow[]>([])
  const [kpis, setKpis]       = useState<WriteoffKPIs | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [fDpdRange, setFDpdRange] = useState(new Set<string>())
  const [search, setSearch]       = useState('')
  const [dateFrom, setDateFrom]   = useState(monthStart())
  const [dateTo, setDateTo]       = useState(today())

  const [modal, setModal]   = useState<ApprovalModal>(null)
  const [acting, setActing] = useState(false)
  const [statusTab, setStatusTab] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')

  const navigate = useNavigate()
  const focus = useFocusParam()
  const user = getUser()
  // Anyone in the chain (or admin) sees the action column; the individual Approve button
  // is enabled per-row only for the approver whose turn it actually is (required_role).
  const isApprover = ['head_ops', 'coo', 'cfo', 'admin'].includes(user.role ?? '')
  const canApproveRow = (r: WriteoffRow) => user.role === r.required_role || user.role === 'admin'
  const fDpdRangeKey = [...fDpdRange].join(',')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    const p = new URLSearchParams({ limit: '100', status: statusTab })
    if (fDpdRangeKey) p.set('dpd_range', fDpdRangeKey)
    if (dateFrom)     p.set('date_from', dateFrom)
    if (dateTo)       p.set('date_to', dateTo)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: WriteoffRow[] }>(`/api/collections-ops/writeoffs?${p}`),
        apiFetch<{ data: WriteoffKPIs }>('/api/collections/writeoff-kpis'),
      ])
      const list = res.data ?? []
      setRows(list); setKpis(kpiRes.data); onCount(statusTab === 'pending' ? list.length : list.filter(x => x.status !== 'approved' && x.status !== 'rejected').length)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load write-off queue')
    } finally {
      setLoading(false)
    }
  }, [fDpdRangeKey, dateFrom, dateTo, statusTab, onCount])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['writeoffs', 'collections'] })

  const displayed = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r => [r.account_cif, r.customer_name, r.recommended_by].some(v => v != null && String(v).toLowerCase().includes(q)))
  }, [rows, search])

  const groups: FilterGroupDef[] = [{
    key: 'dpd_range', label: 'DPD RANGE',
    options: [
      { value: '181-360', label: '181–360 days', count: rows.filter(r => r.dpd >= 181 && r.dpd <= 360).length },
      { value: '361-720', label: '361–720 days', count: rows.filter(r => r.dpd >= 361 && r.dpd <= 720).length },
      { value: '720+',    label: '720+ days',    count: rows.filter(r => r.dpd > 720).length },
    ],
    selected: fDpdRange, onChange: setFDpdRange,
  }]
  function resetFilters() { setFDpdRange(new Set()); setSearch('') }

  async function handleConfirm() {
    if (!modal) return
    setActing(true)
    try {
      if (modal.type === 'approve') {
        // Multi-stage chain: this advances the request to the next approver, or — at the
        // final (CFO) stage — posts the GL write-off. The backend enforces the role.
        await apiPut(`/api/recovery-ops/write-off/${modal.row.id}/approve`, {})
        const isFinal = modal.row.required_role === WRITEOFF_CHAIN[WRITEOFF_CHAIN.length - 1].role
        toast.success(isFinal ? 'Write-off approved and posted' : 'Approved — sent to the next approver')
      } else if (modal.type === 'reject') {
        await apiPut(`/api/recovery-ops/write-off/${modal.row.id}/reject`, {})
        toast.success('Write-off rejected')
      }
      setModal(null); load()
    } catch (e: any) { toast.error(e.message ?? 'Action failed') }
    finally { setActing(false) }
  }

  const cols: TableCol<WriteoffRow>[] = [
    { key: 'account_cif', label: 'Customer', render: r => <NameCell name={r.customer_name ?? r.account_cif} sub={r.customer_name ? r.account_cif : null} /> },
    { key: 'amount_kobo', label: 'Write-off ₦', align: 'right', render: r => <span style={{ ...NUM, fontWeight: 700, color: RED }}>{fmtKoboExact(r.amount_kobo)}</span> },
    { key: 'outstanding_kobo', label: 'Outstanding ₦', align: 'right', render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    { key: 'stage_label', label: 'Approval Stage', render: r => <StageBadge row={r} mine={canApproveRow(r)} /> },
    { key: 'dpd', label: 'DPD', align: 'center', render: r => <DpdBadge dpd={r.dpd} /> },
    { key: 'recommended_by', label: 'Requested By', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.recommended_by ?? '—'}</span> },
    ...(isApprover ? [{
      key: '_actions', label: '', sortable: false, width: 116,
      render: (r: WriteoffRow) => (
        <ActionRow actions={[
          // Review the debtor's full picture (balances, history, recovery activity) before
          // signing — Customer 360 is reachable by every approver (HOP/COO/CFO).
          { icon: 'person_search', label: 'Review debtor (Customer 360)', onClick: () => navigate(`/customers/${r.account_cif}`) },
          ...(canApproveRow(r) ? [
            { icon: 'check_circle', label: r.required_role === 'cfo' ? 'Approve & post write-off' : 'Approve — send to next approver', onClick: () => setModal({ type: 'approve', row: r }), danger: true },
            { icon: 'cancel',       label: 'Reject write-off', onClick: () => setModal({ type: 'reject', row: r }) },
          ] : []),
        ]} />
      ),
    } as TableCol<WriteoffRow>] : []),
  ]

  const isFinalStage = modal?.type === 'approve' && modal.row.required_role === 'cfo'
  const confirmTitle = modal === null ? '' : modal.type === 'approve' ? (isFinalStage ? 'Approve & Post Write-off' : 'Approve Write-off') : 'Reject Write-off'
  const confirmBody = modal === null ? '' : modal.type === 'approve'
    ? (isFinalStage
        ? `Final approval. This posts a GL write-off of ${fmtKoboExact(modal.row.amount_kobo)} and closes the recovery case. This cannot be undone.`
        : `Approve the ${fmtKoboExact(modal.row.amount_kobo)} write-off for ${modal.row.customer_name ?? modal.row.account_cif} and send it to the next approver in the chain?`)
    : `Reject the ${fmtKoboExact(modal.row.amount_kobo)} write-off request for ${modal.row.customer_name ?? modal.row.account_cif}? The requester will be notified.`
  const isDanger = modal?.type === 'approve' && isFinalStage
  const kpiLoading = loading && !kpis

  return (
    <>
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: SP[3], flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', gap: 4, background: 'var(--chip-bg)', padding: 3, borderRadius: RADIUS.md }}>
          {(['pending', 'approved', 'rejected', 'all'] as const).map(s => (
            <button key={s} onClick={() => setStatusTab(s)}
              style={{ padding: '5px 13px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold, textTransform: 'capitalize',
                background: statusTab === s ? 'var(--card)' : 'transparent', color: statusTab === s ? NAVY : 'var(--txt2)', boxShadow: statusTab === s ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}>
              {s}
            </button>
          ))}
        </div>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 16 }}>
        <KpiCard label="Total Write-offs" value={kpis ? fmtNum(kpis.total) : '—'} icon="delete_forever" accent={RED} loading={kpiLoading} />
        <KpiCard label="Total Amount NGN" value={kpis ? fmtKoboExact(kpis.amount_kobo) : '—'} icon="account_balance" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Recovery Rate %" value={kpis ? `${Number(kpis.recovery_rate_pct).toFixed(1)}%` : '—'} icon="trending_up" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Pending Approval" value={kpis ? fmtNum(kpis.pending) : '—'} icon="pending_actions" accent={AMBER} loading={kpiLoading} />
      </div>

      <div style={{ padding: `${SP[3]} ${SP[4]}`, background: `${RED}08`, border: `1px solid ${RED}22`, borderRadius: RADIUS.md, marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: RED, flexShrink: 0, marginTop: 1 }}>warning</span>
        <p style={{ margin: 0, fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6 }}>
          Recovery-recommended accounts (DPD &gt; 180) that have exhausted collection attempts. Approving posts a GL write-off entry and closes the recovery case — it cannot be undone.
        </p>
      </div>

      <SectionCard title="Recovery-originated write-offs" badge={rows.length} padding={false}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch} groups={groups} onReset={resetFilters} onApply={load}
          resultCount={displayed.length} totalCount={rows.length}
          placeholder="Search CIF, name, recommended by…"
        />
        <DataTable
          cols={cols} rows={displayed} keyFn={r => r.id} loading={loading} pageSize={20}
          focusId={focus} emptyText="No write-offs awaiting approval" skeletonRows={8}
        />
      </SectionCard>

      <ConfirmModal
        open={modal !== null} title={confirmTitle} body={confirmBody}
        confirmLabel={modal?.type === 'approve' ? (isFinalStage ? 'Approve & Post' : 'Approve') : 'Reject'}
        danger={isDanger} loading={acting} onConfirm={handleConfirm} onClose={() => setModal(null)}
      />
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
//  REQUESTS PANE — collections-initiated write-off requests (raise via modal / review)
// ════════════════════════════════════════════════════════════════════════════════

interface WriteoffRequest {
  id: number
  account_cif: string
  writeoff_type: string
  reason: string
  reason_notes: string | null
  amount_kobo: number | null
  percentage: number | null
  outstanding_kobo: number | null
  status: string
  review_notes: string | null
  reviewed_at: string | null
  created_at: string
  requested_by_name: string | null
  reviewed_by_name: string | null
}

const WRITEOFF_TYPES = [
  { value: 'full',           label: 'Full Write-off',  desc: '100% of outstanding' },
  { value: 'partial_amount', label: 'Partial Amount',  desc: 'Specific NGN amount' },
  { value: 'percentage',     label: 'Percentage',      desc: '% of outstanding' },
  { value: 'principal_only', label: 'Principal Only',  desc: 'Write off principal, not interest' },
  { value: 'interest_only',  label: 'Interest Only',   desc: 'Write off interest, keep principal' },
]
const REASONS = [
  { value: 'bad_debt', label: 'Bad Debt' }, { value: 'deceased', label: 'Customer Deceased' },
  { value: 'fraud', label: 'Fraud / Identity Theft' }, { value: 'natural_disaster', label: 'Natural Disaster' },
  { value: 'regulatory', label: 'Regulatory Directive' }, { value: 'other', label: 'Other' },
]
type StatusFilter = 'pending' | 'approved' | 'rejected'
const statusColor = (s: string) => s === 'approved' ? GREEN : s === 'rejected' ? RED : AMBER
const typeLabel   = (v: string) => WRITEOFF_TYPES.find(t => t.value === v)?.label ?? v
const reasonLabel = (v: string) => REASONS.find(r => r.value === v)?.label ?? v

function ReqStatusPill({ status }: { status: string }) {
  const color = statusColor(status)
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'], background: `${color}18`, color, textTransform: 'capitalize' }}>{status}</span>
}

const reqInput: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
const reqLabel: React.CSSProperties = { display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }

function CreateRequestModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [cif, setCif] = useState('')
  const [woType, setWoType] = useState('full')
  const [reason, setReason] = useState('bad_debt')
  const [reasonNotes, setReasonNotes] = useState('')
  const [amountNaira, setAmountNaira] = useState('')
  const [pct, setPct] = useState('')
  const [outstanding, setOutstanding] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() { setCif(''); setWoType('full'); setReason('bad_debt'); setReasonNotes(''); setAmountNaira(''); setPct(''); setOutstanding('') }

  async function handleSave() {
    if (!cif.trim()) { toast.error('CIF is required'); return }
    setSaving(true)
    try {
      const body: Record<string, any> = {
        account_cif: cif.trim(), writeoff_type: woType, reason, reason_notes: reasonNotes,
        outstanding_kobo: outstanding ? Math.round(parseFloat(outstanding) * 100) : 0,
      }
      if (woType === 'partial_amount' || woType === 'principal_only' || woType === 'interest_only') {
        const n = parseFloat(amountNaira)
        if (!n || n <= 0) { toast.error('Enter a valid amount'); setSaving(false); return }
        body.amount_kobo = Math.round(n * 100)
      }
      if (woType === 'percentage') {
        const p = parseFloat(pct)
        if (!p || p <= 0 || p > 100) { toast.error('Enter a valid percentage (1–100)'); setSaving(false); return }
        body.percentage = p
      }
      await apiPost('/api/collections-ops/writeoff-requests', body)
      toast.success('Write-off request submitted')
      reset(); onSuccess()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="Request Write-off" width={520}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {saving && <Spinner size={13} color="#fff" />}
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>
            Submit Request
          </button>
          <button onClick={() => { reset(); onClose() }} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={reqLabel}>Account CIF</label>
          <input type="text" value={cif} onChange={e => setCif(e.target.value)} placeholder="e.g. CIF-001234" style={reqInput} autoFocus />
        </div>
        <div>
          <label style={reqLabel}>Write-off Type</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {WRITEOFF_TYPES.map(t => (
              <label key={t.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '8px 12px', borderRadius: RADIUS.md, border: `1.5px solid ${woType === t.value ? RED : 'var(--bdr)'}`, background: woType === t.value ? `${RED}08` : 'var(--card)' }}>
                <input type="radio" checked={woType === t.value} onChange={() => setWoType(t.value)} style={{ marginTop: 2, accentColor: RED }} />
                <div>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: woType === t.value ? RED : 'var(--txt)' }}>{t.label}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{t.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        {(woType === 'partial_amount' || woType === 'principal_only' || woType === 'interest_only') && (
          <div>
            <label style={reqLabel}>Amount (₦)</label>
            <input type="number" min="0" step="0.01" placeholder="0.00" value={amountNaira} onChange={e => setAmountNaira(e.target.value)} style={{ ...reqInput, fontWeight: FW.bold }} />
          </div>
        )}
        {woType === 'percentage' && (
          <div>
            <label style={reqLabel}>Percentage (%)</label>
            <input type="number" min="0.01" max="100" step="0.01" placeholder="e.g. 50" value={pct} onChange={e => setPct(e.target.value)} style={reqInput} />
          </div>
        )}
        <div>
          <label style={reqLabel}>Outstanding Balance (₦) <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
          <input type="number" min="0" step="0.01" placeholder="Current outstanding amount" value={outstanding} onChange={e => setOutstanding(e.target.value)} style={reqInput} />
        </div>
        <div>
          <label style={reqLabel}>Reason</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {REASONS.map(r => (
              <button key={r.value} onClick={() => setReason(r.value)}
                style={{ padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', border: `1.5px solid ${reason === r.value ? NAVY : 'var(--bdr)'}`, background: reason === r.value ? NAVY : 'var(--card)', color: reason === r.value ? '#fff' : 'var(--txt)' }}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={reqLabel}>Supporting Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
          <textarea value={reasonNotes} onChange={e => setReasonNotes(e.target.value)} rows={3} placeholder="Provide any additional context for the reviewer…" style={{ ...reqInput, resize: 'vertical' }} />
        </div>
      </div>
    </Modal>
  )
}

function ReviewRequestModal({ request, onClose, onSuccess }: { request: WriteoffRequest | null; onClose: () => void; onSuccess: () => void }) {
  const [action, setAction] = useState<'approve' | 'reject'>('approve')
  const [notes, setNotes]   = useState('')
  const [saving, setSaving] = useState(false)

  async function handleReview() {
    if (!request) return
    setSaving(true)
    try {
      if (action === 'approve') { await apiPut(`/api/collections-ops/writeoff-requests/${request.id}/approve`, { review_notes: notes }); toast.success('Write-off request approved. GL entry posted') }
      else { await apiPut(`/api/collections-ops/writeoff-requests/${request.id}/reject`, { review_notes: notes }); toast.success('Write-off request rejected') }
      setNotes(''); onSuccess()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  return (
    <Modal open={request !== null} onClose={() => { setNotes(''); onClose() }} title={`Review Write-off: ${request?.account_cif ?? ''}`} width={460}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleReview} disabled={saving}
            style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: action === 'approve' ? GREEN : RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {saving && <Spinner size={13} color="#fff" />}
            {action === 'approve' ? 'Approve' : 'Reject'}
          </button>
          <button onClick={() => { setNotes(''); onClose() }} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
        </div>
      }>
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--canvas)', borderRadius: RADIUS.md, padding: `${SP[3]} ${SP[4]}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['Type', typeLabel(request.writeoff_type)],
              ['Reason', reasonLabel(request.reason)],
              ['Outstanding', request.outstanding_kobo ? fmtKoboExact(request.outstanding_kobo) : '—'],
              ...(request.writeoff_type === 'partial_amount' || request.writeoff_type === 'principal_only' || request.writeoff_type === 'interest_only' ? [['Amount', request.amount_kobo ? fmtKoboExact(request.amount_kobo) : '—']] : []),
              ...(request.writeoff_type === 'percentage' ? [['Percentage', `${request.percentage}%`]] : []),
              ['Requested By', request.requested_by_name ?? '—'],
              ['Submitted', fmtDate(request.created_at)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', minWidth: 110 }}>{k}</span>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{v}</span>
              </div>
            ))}
            {request.reason_notes && (
              <div style={{ marginTop: 4, padding: `${SP[2]} ${SP[3]}`, background: 'var(--card)', borderRadius: RADIUS.md, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{request.reason_notes}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            {(['approve', 'reject'] as const).map(a => (
              <button key={a} onClick={() => setAction(a)}
                style={{ flex: 1, padding: '8px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', border: `1.5px solid ${action === a ? (a === 'approve' ? GREEN : RED) : 'var(--bdr)'}`, background: action === a ? (a === 'approve' ? GREEN : RED) : 'var(--card)', color: action === a ? '#fff' : 'var(--txt)' }}>
                {a === 'approve' ? 'Approve' : 'Reject'}
              </button>
            ))}
          </div>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>Review Notes <span style={{ fontWeight: 400, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Notes for requester…" style={{ ...reqInput, resize: 'vertical' }} />
          </div>
        </div>
      )}
    </Modal>
  )
}

function RequestsPane({ onCount }: { onCount: (n: number) => void }) {
  const [rows, setRows]           = useState<WriteoffRequest[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [statusTab, setStatusTab] = useState<StatusFilter>('pending')
  const [createOpen, setCreateOpen] = useState(false)
  const [reviewing, setReviewing] = useState<WriteoffRequest | null>(null)

  const user   = getUser()
  const canAct = user.role === 'collections_head' || user.role === 'admin'

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const res = await apiFetch<{ data: WriteoffRequest[] }>(`/api/collections-ops/writeoff-requests?status=${statusTab}`)
      const list = res.data ?? []
      setRows(list)
      if (statusTab === 'pending') onCount(list.length)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [statusTab, onCount])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections', 'loans'] })

  const STATUS_TABS: { key: StatusFilter; label: string }[] = [
    { key: 'pending', label: 'Pending' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' },
  ]

  const cols: TableCol<WriteoffRequest>[] = [
    { key: 'account_cif', label: 'Account', render: r => <NameCell name={r.account_cif} sub={r.requested_by_name ?? undefined} /> },
    { key: 'writeoff_type', label: 'Type', render: r => <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>{typeLabel(r.writeoff_type)}</span> },
    { key: 'reason', label: 'Reason', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{reasonLabel(r.reason)}</span> },
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', render: r => <span style={{ ...NUM, color: RED }}>{r.outstanding_kobo ? fmtKoboExact(r.outstanding_kobo) : '—'}</span> },
    { key: 'amount_kobo', label: 'Write-off Amount', align: 'right', render: r => {
      if (r.writeoff_type === 'full') return <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Full</span>
      if (r.writeoff_type === 'percentage') return <span style={NUM}>{r.percentage}%</span>
      return <span style={NUM}>{r.amount_kobo ? fmtKoboExact(r.amount_kobo) : '—'}</span>
    } },
    { key: 'status', label: 'Status', render: r => <ReqStatusPill status={r.status} /> },
    { key: 'created_at', label: 'Submitted', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span> },
    ...(canAct && statusTab === 'pending' ? [{
      key: '_actions', label: '', sortable: false,
      render: (r: WriteoffRequest) => (
        <button onClick={e => { e.stopPropagation(); setReviewing(r) }}
          style={{ padding: '4px 11px', borderRadius: RADIUS.sm, cursor: 'pointer', border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, whiteSpace: 'nowrap' }}>
          Review
        </button>
      ),
    } as TableCol<WriteoffRequest>] : []),
  ]

  return (
    <>
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: SP[3] }}>
        <button onClick={() => setCreateOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          Request Write-off
        </button>
      </div>

      <SectionCard badge={rows.length} padding={false}>
        <div style={{ display: 'flex', gap: 2, padding: '8px 16px', borderBottom: '1px solid var(--bdr)' }}>
          {STATUS_TABS.map(t => (
            <button key={t.key} onClick={() => setStatusTab(t.key)}
              style={{ padding: '5px 16px', borderRadius: RADIUS.md, cursor: 'pointer', fontFamily: 'inherit', fontSize: TEXT.sm, fontWeight: statusTab === t.key ? FW.semibold : FW.normal, border: statusTab === t.key ? `1.5px solid ${NAVY}` : '1.5px solid transparent', background: statusTab === t.key ? NAVY : 'transparent', color: statusTab === t.key ? '#fff' : 'var(--txt2)' }}>
              {t.label}
            </button>
          ))}
        </div>
        <DataTable
          key={statusTab} cols={cols} rows={rows} keyFn={r => r.id} loading={loading} skeletonRows={6} pageSize={20}
          searchKeys={['account_cif', 'writeoff_type', 'reason']} searchPlaceholder="Search CIF, type, reason…"
          emptyText={`No ${statusTab} write-off requests`}
        />
      </SectionCard>

      <CreateRequestModal open={createOpen} onClose={() => setCreateOpen(false)} onSuccess={() => { setCreateOpen(false); load() }} />
      <ReviewRequestModal request={reviewing} onClose={() => setReviewing(null)} onSuccess={() => { setReviewing(null); load() }} />
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
//  PAGE — tabs over the two panes
// ════════════════════════════════════════════════════════════════════════════════

// One unified Write-offs workflow. The old two-tab split (Approvals vs Requests) is
// retired: the "Requests" flow (collections_writeoff_requests) was never used (0 rows),
// and a write-off is a single thing — raised from the recovery case, then it travels the
// HOP → COO → CFO chain. This page is that one queue: raise happens on the case; here you
// see every write-off with its stage/status and act when it's your turn.
export default function CollectionsWriteoffs() {
  const [, setCount] = useState<number>(0)
  return (
    <Page
      title="Write-offs"
      subtitle="Every write-off request and its HOP → COO → CFO approval, in one place"
      actions={<LiveBadge />}
    >
      <ApprovalsPane onCount={setCount} />
    </Page>
  )
}
