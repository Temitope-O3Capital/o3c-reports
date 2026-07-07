import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Page, KpiCard, SectionCard, DataTable, FilterBar, filterInputStyle,
  ErrBanner, ConfirmModal, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { RED, DARKRED, GREEN, AMBER, NAVY, NUM } from '../../lib/design'

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
      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
      background: `${color}22`, color, whiteSpace: 'nowrap',
    }}>
      {dpd} DPD
    </span>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportWriteoffCsv(rows: WriteoffRow[]) {
  const header = ['CIF', 'Customer Name', 'Outstanding (₦)', 'DPD', 'Last Payment Date', 'Recovery Attempts', 'Recommended By']
  const lines = rows.map(r => [
    r.account_cif ?? '',
    `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
    (r.outstanding_kobo / 100).toFixed(2),
    r.dpd ?? '',
    r.last_payment_date ?? '',
    r.recovery_attempts ?? '',
    `"${String(r.recommended_by ?? '').replace(/"/g, '""')}"`,
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `writeoff-queue-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
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
  const [dpdRange, setDpdRange] = useState('')
  const [q, setQ]               = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo]     = useState(today())

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())

  // Confirm modal
  const [modal, setModal]   = useState<ActionModal>(null)
  const [acting, setActing] = useState(false)

  const user     = getUser()
  const canAct   = user.role === 'collections_head' || user.role === 'admin'

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const p = new URLSearchParams({ limit: '100' })
    if (dpdRange) p.set('dpd_range', dpdRange)
    if (q.trim()) p.set('q', q.trim())
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to', dateTo)
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
  }, [dpdRange, q, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

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
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.account_cif}</div>
          {r.customer_name && (
            <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 1 }}>{r.customer_name}</div>
          )}
        </div>
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
        <span style={{ fontSize: 12.5, color: r.last_payment_date ? 'var(--txt)' : 'var(--txt3)' }}>
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
          <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt2)' }}>info</span>
          <span style={{ ...NUM, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{fmtNum(r.recovery_attempts)}</span>
        </div>
      ),
    },
    {
      key: 'recommended_by',
      label: 'Recommended By',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{r.recommended_by ?? '—'}</span>,
    },
    ...(canAct ? [{
      key: '_actions',
      label: 'Actions',
      sortable: false,
      width: 240,
      render: (r: WriteoffRow) => (
        <div style={{ display: 'flex', gap: 6 }} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
          <button
            onClick={() => setModal({ type: 'approve', row: r })}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
              fontSize: 11.5, fontWeight: 600, background: RED, color: '#fff',
            }}
          >
            Approve Write-off
          </button>
          <button
            onClick={() => setModal({ type: 'return', row: r })}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 7, cursor: 'pointer',
              fontSize: 11.5, fontWeight: 500,
              background: 'var(--card)', color: 'var(--txt)',
              border: '1px solid var(--bdr)',
            }}
          >
            Return to Recovery
          </button>
        </div>
      ),
    } as TableCol<WriteoffRow>] : []),
  ]

  const bulkBar = canAct && selectedIds.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: '#F0F4FF', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: NAVY }}>{selectedIds.size} selected</span>
      <div style={{ marginLeft: 'auto' }}>
        <button
          onClick={() => setModal({ type: 'bulk-approve' })}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', background: RED, color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
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
      subtitle="Accounts recommended for write-off after exhausting collection attempts"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Total Write-offs" value={kpis ? fmtNum(kpis.total) : '—'} icon="delete_forever" accent={RED} loading={kpiLoading} />
        <KpiCard label="Total Amount ₦" value={kpis ? fmtKobo(kpis.amount_kobo) : '—'} icon="account_balance" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Recovery Rate %" value={kpis ? `${kpis.recovery_rate_pct.toFixed(1)}%` : '—'} icon="trending_up" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Pending Approval" value={kpis ? fmtNum(kpis.pending) : '—'} icon="pending_actions" accent={AMBER} loading={kpiLoading} />
      </div>

      {/* Info banner */}
      <SectionCard padding style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED, flexShrink: 0, marginTop: 1 }}>warning</span>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--txt)', lineHeight: 1.6 }}>
            Accounts with DPD &gt; 180 days that have exhausted collection attempts.
            Collections Heads can approve write-offs — this triggers a GL entry.
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Write-off Queue" badge={rows.length} padding={false} actions={<button onClick={() => exportWriteoffCsv(rows)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setDpdRange(''); setQ('') }}>
            <select value={dpdRange} onChange={e => setDpdRange(e.target.value)} style={filterInputStyle}>
              <option value="">All DPD</option>
              <option value="181-360">181–360 days</option>
              <option value="361-720">361–720 days</option>
              <option value="720+">720+ days</option>
            </select>
            <input
              placeholder="Search by CIF or agent…"
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              style={{ ...filterInputStyle, minWidth: 200 }}
            />
            <button
              onClick={() => load()}
              style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Apply
            </button>
          </FilterBar>
        </div>
        <DataTable
          cols={cols}
          rows={rows}
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
