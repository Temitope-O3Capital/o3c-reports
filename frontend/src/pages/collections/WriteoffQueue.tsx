import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Page, KpiCard, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, ConfirmModal, DateFilter, NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { RED, DARKRED, GREEN, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WriteoffKPIs {
  total: number
  amount_kobo: number
  recovery_rate_pct: number
  pending: number
}

interface WriteoffRow {
  id: number
  account_cif: string
  customer_name: string | null
  outstanding_kobo: number
  dpd: number
  last_payment_date: string | null
  recovery_attempts: number
  recommended_by: string | null
}

// ── DPD badge (dark red for 181+, matches existing pattern) ──────────────────

function DpdBadge({ dpd }: { dpd: number }) {
  const color = dpd > 720 ? DARKRED : dpd > 360 ? '#A00000' : RED
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 7px', borderRadius: RADIUS['2xl'],
      background: `${color}22`, color, whiteSpace: 'nowrap',
    }}>
      {dpd} DPD
    </span>
  )
}



// ── Role check ────────────────────────────────────────────────────────────────

function getUser(): { role?: string } {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') }
  catch { return {} }
}

// ── Main component ────────────────────────────────────────────────────────────

type ActionModal =
  | { type: 'approve'; row: WriteoffRow }
  | { type: 'return'; row: WriteoffRow }
  | { type: 'bulk-approve' }
  | null

export default function WriteoffQueue() {
  const [rows, setRows]         = useState<WriteoffRow[]>([])
  const [kpis, setKpis]         = useState<WriteoffKPIs | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  // Filters
  const [fDpdRange, setFDpdRange] = useState(new Set<string>())
  const [search, setSearch]       = useState('')
  const [dateFrom, setDateFrom]   = useState(monthStart())
  const [dateTo, setDateTo]       = useState(today())

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())

  // Confirm modal
  const [modal, setModal]   = useState<ActionModal>(null)
  const [acting, setActing] = useState(false)

  const user     = getUser()
  const canAct   = user.role === 'collections_head' || user.role === 'admin'

  const fDpdRangeKey = [...fDpdRange].join(',')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    const p = new URLSearchParams({ limit: '100' })
    if (fDpdRangeKey) p.set('dpd_range', fDpdRangeKey)
    if (dateFrom)     p.set('date_from', dateFrom)
    if (dateTo)       p.set('date_to', dateTo)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: WriteoffRow[] }>(`/api/collections-ops/writeoffs?${p}`),
        apiFetch<{ data: WriteoffKPIs }>('/api/collections/writeoff-kpis'),
      ])
      setRows(res.data ?? [])
      setKpis(kpiRes.data)
      setSelectedIds(new Set())
    } catch (e: any) {
      setError(e.message ?? 'Failed to load write-off queue')
    } finally {
      setLoading(false)
    }
  }, [fDpdRangeKey, dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections','loans'] })

  const displayed = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      [r.account_cif, r.customer_name, r.recommended_by].some(
        v => v != null && String(v).toLowerCase().includes(q)
      )
    )
  }, [rows, search])

  const groups: FilterGroupDef[] = [
    {
      key: 'dpd_range',
      label: 'DPD RANGE',
      options: [
        { value: '181-360', label: '181–360 days', count: rows.filter(r => r.dpd >= 181 && r.dpd <= 360).length },
        { value: '361-720', label: '361–720 days', count: rows.filter(r => r.dpd >= 361 && r.dpd <= 720).length },
        { value: '720+',    label: '720+ days',    count: rows.filter(r => r.dpd > 720).length },
      ],
      selected: fDpdRange,
      onChange: setFDpdRange,
    },
  ]

  function resetFilters() { setFDpdRange(new Set()); setSearch('') }


  async function doApprove(id: number) {
    await apiPost(`/api/collections-ops/writeoffs/${id}/approve`, {})
    toast.success('Write-off approved')
  }

  async function doReturn(id: number) {
    await apiPost(`/api/collections-ops/writeoffs/${id}/return-recovery`, {})
    toast.success('Account returned to Recovery')
  }

  async function doBulkApprove(ids: number[]) {
    await apiPost('/api/collections-ops/writeoffs/bulk-approve', { ids })
    toast.success(`${ids.length} write-off${ids.length > 1 ? 's' : ''} approved`)
  }

  async function handleConfirm() {
    if (!modal) return
    setActing(true)
    try {
      if (modal.type === 'approve') {
        await doApprove(modal.row.id)
      } else if (modal.type === 'return') {
        await doReturn(modal.row.id)
      } else if (modal.type === 'bulk-approve') {
        await doBulkApprove(Array.from(selectedIds) as number[])
      }
      setModal(null)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Action failed')
    } finally {
      setActing(false)
    }
  }

  const cols: TableCol<WriteoffRow>[] = [
    {
      key: 'account_cif',
      label: 'Customer',
      render: r => (
        <NameCell
          name={r.customer_name ?? r.account_cif}
          sub={r.customer_name ? r.account_cif : null}
        />
      ),
    },
    {
      key: 'outstanding_kobo',
      label: 'Outstanding ₦',
      align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 700, color: RED }}>{fmtKobo(r.outstanding_kobo)}</span>,
    },
    {
      key: 'dpd',
      label: 'DPD',
      align: 'center',
      render: r => <DpdBadge dpd={r.dpd} />,
    },
    {
      key: 'last_payment_date',
      label: 'Last Payment',
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: r.last_payment_date ? 'var(--txt)' : 'var(--txt3)' }}>
          {r.last_payment_date ? fmtDate(r.last_payment_date) : 'Never'}
        </span>
      ),
    },
    {
      key: 'recovery_attempts',
      label: 'Recovery Attempts',
      align: 'center',
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: 'var(--txt2)' }}>info</span>
          <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(r.recovery_attempts)}</span>
        </div>
      ),
    },
    {
      key: 'recommended_by',
      label: 'Recommended By',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.recommended_by ?? '—'}</span>,
    },
    ...(canAct ? [{
      key: '_actions',
      label: '',
      sortable: false,
      width: 80,
      render: (r: WriteoffRow) => (
        <ActionRow actions={[
          { icon: 'check_circle', label: 'Approve Write-off',   onClick: () => setModal({ type: 'approve', row: r }), danger: true },
          { icon: 'arrow_back',   label: 'Return to Recovery',  onClick: () => setModal({ type: 'return', row: r }) },
        ]} />
      ),
    } as TableCol<WriteoffRow>] : []),
  ]

  const bulkBar = canAct && selectedIds.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: 'var(--chip-bg)', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{selectedIds.size} selected</span>
      <div style={{ marginLeft: 'auto' }}>
        <button
          onClick={() => setModal({ type: 'bulk-approve' })}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', background: RED, color: '#fff',
            border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>check_circle</span>
          Bulk Approve Write-offs
        </button>
      </div>
    </div>
  ) : undefined

  // Build confirm modal props
  const confirmTitle = modal === null ? '' :
    modal.type === 'approve' ? 'Approve Write-off' :
    modal.type === 'return'  ? 'Return to Recovery' :
    'Bulk Approve Write-offs'

  const confirmBody = modal === null ? '' :
    modal.type === 'approve'
      ? `This will write off ${fmtKobo(modal.row.outstanding_kobo)} from the loan book. This action cannot be undone.`
    : modal.type === 'return'
      ? `Return CIF ${modal.row.account_cif} to active Recovery queue?`
    : `Approve ${selectedIds.size} write-off${selectedIds.size > 1 ? 's' : ''}? This will post GL entries for each account and cannot be undone.`

  const isDanger = modal?.type === 'approve' || modal?.type === 'bulk-approve'

  const kpiLoading = loading && !kpis

  return (
    <Page
      title="Write-off Queue"
      subtitle="Recovery-originated write-offs awaiting your decision: approve to post, or return to recovery. (Collections-initiated write-offs live under Write-off Requests.)"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Write-offs" value={kpis ? fmtNum(kpis.total) : '—'} icon="delete_forever" accent={RED} loading={kpiLoading} />
        <KpiCard label="Total Amount NGN" value={kpis ? fmtKobo(kpis.amount_kobo) : '—'} icon="account_balance" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Recovery Rate %" value={kpis ? `${Number(kpis.recovery_rate_pct).toFixed(1)}%` : '—'} icon="trending_up" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Pending Approval" value={kpis ? fmtNum(kpis.pending) : '—'} icon="pending_actions" accent={AMBER} loading={kpiLoading} />
      </div>

      {/* Info banner */}
      <SectionCard padding style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: RED, flexShrink: 0, marginTop: 1 }}>warning</span>
          <p style={{ margin: 0, fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6 }}>
            Accounts with DPD &gt; 180 days that have exhausted collection attempts.
            Collections Heads can approve write-offs. This triggers a GL entry.
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Write-off Queue" badge={rows.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={groups}
          onReset={resetFilters}
          onApply={load}
          resultCount={displayed.length}
          totalCount={rows.length}
          placeholder="Search CIF, name, recommended by…"
        />
        <DataTable
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          loading={loading}
          pageSize={20}
          selectable={canAct}
          selectedIds={selectedIds}
          onSelect={canAct ? setSelectedIds : undefined}
          bulkBar={bulkBar}
          emptyText="No accounts in write-off queue"
          skeletonRows={8}
        />
      </SectionCard>

      <ConfirmModal
        open={modal !== null}
        title={confirmTitle}
        body={confirmBody}
        confirmLabel={
          modal?.type === 'approve' ? 'Approve Write-off' :
          modal?.type === 'return'  ? 'Return to Recovery' :
          'Bulk Approve'
        }
        danger={isDanger}
        loading={acting}
        onConfirm={handleConfirm}
        onClose={() => setModal(null)}
      />
    </Page>
  )
}
