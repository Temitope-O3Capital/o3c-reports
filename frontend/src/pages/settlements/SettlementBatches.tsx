import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, StatusBadge, FilterBar, filterInputStyle, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, today, monthStart } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Batch {
  id: number
  batch_date: string
  batch_ref: string
  batch_type: string
  total_credits: number
  total_debits: number
  txn_count: number
  exception_count: number
  status: string
  notes: string
  created_at: string
}

// ── Columns ───────────────────────────────────────────────────────────────────

const COLS: TableCol<Batch>[] = [
  { key: 'batch_date', label: 'Date', sortable: true, width: 110,
    render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.batch_date)}</span> },
  { key: 'batch_ref', label: 'Batch Ref', sortable: true,
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.batch_ref || '—'}</span> },
  { key: 'batch_type', label: 'Type',
    render: r => (
      <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
        background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
        {r.batch_type}
      </span>
    )},
  { key: 'txn_count', label: 'Txns', align: 'right', sortable: true,
    render: r => <span style={NUM}>{fmtNum(r.txn_count)}</span> },
  { key: 'total_credits', label: 'Credits ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: GREEN, fontWeight: 600 }}>{fmtKobo(r.total_credits)}</span> },
  { key: 'total_debits', label: 'Debits ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, color: RED, fontWeight: 600 }}>{fmtKobo(r.total_debits)}</span> },
  { key: 'exception_count', label: 'Exceptions', align: 'right',
    render: r => (
      <span style={{ ...NUM, fontWeight: 600, color: r.exception_count > 0 ? AMBER : 'var(--txt2)' }}>
        {r.exception_count}
      </span>
    )},
  { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettlementBatches() {
  const [rows, setRows] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
      if (statusFilter) qs.set('status', statusFilter)
      const res = await apiFetch<Batch[]>(`/api/settlements/batches?${qs}`)
      setRows(res ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, statusFilter])

  useEffect(() => { load() }, [load])

  const totalCredits = rows.reduce((s, r) => s + r.total_credits, 0)
  const totalDebits  = rows.reduce((s, r) => s + r.total_debits, 0)
  const totalExceptions = rows.reduce((s, r) => s + r.exception_count, 0)
  const openBatches = rows.filter(r => r.status === 'pending').length

  function exportBatchesCsv(data: Batch[]) {
    const header = ['Date', 'Batch Ref', 'Type', 'Txns', 'Credits ₦', 'Debits ₦', 'Exceptions', 'Status']
    const lines = data.map(r => [
      r.batch_date ?? '',
      r.batch_ref ?? '',
      r.batch_type ?? '',
      r.txn_count ?? 0,
      (r.total_credits / 100).toFixed(2),
      (r.total_debits / 100).toFixed(2),
      r.exception_count ?? 0,
      r.status ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `settlement-batches-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page title="Settlement Batches" subtitle="NIP/NIBSS daily settlement overview">
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
        <KpiCard label="Total Credits" value={fmtKobo(totalCredits)} icon="south_east" accent={GREEN} loading={loading} />
        <KpiCard label="Total Debits" value={fmtKobo(totalDebits)} icon="north_west" accent={RED} loading={loading} />
        <KpiCard label="Open Batches" value={String(openBatches)} icon="pending" accent={AMBER} loading={loading} />
        <KpiCard label="Exceptions" value={String(totalExceptions)} icon="warning" accent={totalExceptions > 0 ? RED : NAVY} loading={loading} />
      </div>

      <FilterBar onReset={() => { setStatusFilter(''); setDateFrom(monthStart()); setDateTo(today()) }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="reconciled">Reconciled</option>
          <option value="exceptions">Has Exceptions</option>
        </select>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
        <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Apply</button>
      </FilterBar>

      <SectionCard padding={false} actions={<button onClick={() => exportBatchesCsv(rows)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <DataTable
          cols={COLS}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No settlement batches for this period"
          searchKeys={['batch_ref', 'batch_type', 'status']}
          searchPlaceholder="Search ref, type, status…"
          pageSize={20}
        />
      </SectionCard>
    </Page>
  )
}
