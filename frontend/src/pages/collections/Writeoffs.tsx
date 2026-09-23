import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Page, KpiCard, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, ConfirmModal, DateFilter, NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { LiveBadge } from '../../components/MyWorkspace'
import { apiFetch, apiPut } from '../../lib/api'
import { useFocusParam } from '../../hooks/useFocusParam'
import { fmtKoboExact, fmtNum, today, monthStart } from '../../lib/fmt'
import { RED, DARKRED, GREEN, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// A write-off is raised from the recovery case, then travels the HOP → COO → CFO
// chain (recovery_write_off_approvals). This page is that one queue: it shows every
// write-off with its stage/status and lets the current approver act on it.

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

function ApprovalsPane() {
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
      setRows(list); setKpis(kpiRes.data)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load write-off queue')
    } finally {
      setLoading(false)
    }
  }, [fDpdRangeKey, dateFrom, dateTo, statusTab])

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
        toast.success(isFinal ? 'Write-off approved and posted' : 'Approved: sent to the next approver')
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
    { key: 'amount_kobo', label: 'Write-Off ₦', align: 'right', render: r => <span style={{ ...NUM, fontWeight: 700, color: RED }}>{fmtKoboExact(r.amount_kobo)}</span> },
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
          { icon: 'person_search', label: 'Review Debtor (Customer 360)', onClick: () => navigate(`/customers/${r.account_cif}`) },
          ...(canApproveRow(r) ? [
            { icon: 'check_circle', label: r.required_role === 'cfo' ? 'Approve & Post Write-off' : 'Approve: Send to Next Approver', onClick: () => setModal({ type: 'approve', row: r }), danger: true },
            { icon: 'cancel',       label: 'Reject Write-Off',onClick: () => setModal({ type: 'reject', row: r }) },
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
        <KpiCard label="Total Write-Offs" value={kpis ? fmtNum(kpis.total) : '—'} icon="delete_forever" accent={RED} loading={kpiLoading} />
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

      <SectionCard title="Recovery-originated Write-Offs" badge={rows.length} padding={false}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch} groups={groups} onReset={resetFilters} onApply={load}
          resultCount={displayed.length} totalCount={rows.length}
          placeholder="Search CIF, name, recommended by…"
        />
        <DataTable
          cols={cols} rows={displayed} keyFn={r => r.id} loading={loading} pageSize={20}
          focusId={focus} emptyText="No Write-offs Awaiting Approval" skeletonRows={8}
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
//  PAGE
// ════════════════════════════════════════════════════════════════════════════════

// One unified Write-offs workflow. The old two-tab split (Approvals vs Requests) is
// retired: the "Requests" flow (collections_writeoff_requests) was never used (0 rows),
// and a write-off is a single thing — raised from the recovery case, then it travels the
// HOP → COO → CFO chain. This page is that one queue: raise happens on the case; here you
// see every write-off with its stage/status and act when it's your turn.
export default function CollectionsWriteoffs() {
  return (
    <Page
      title="Write-Offs"
      subtitle="Every write-off request and its HOP → COO → CFO approval, in one place"
      actions={<LiveBadge />}
    >
      <ApprovalsPane />
    </Page>
  )
}
