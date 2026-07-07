import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Page, KpiCard, SectionCard, DataTable, FilterBar, filterInputStyle,
  ErrBanner, ConfirmModal, btnSecondary, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { AMBER, GREEN, RED, NAVY, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PromiseKPIs {
  total: number
  kept: number
  broken: number
  amount_promised_kobo: number
}

interface PTPane {
  id: number
  account_cif: string
  customer_name: string | null
  outstanding_kobo: number
  promise_amount_kobo: number
  promise_date: string
  status: string
  agent_name: string | null
  created_at: string
}

// ── Status pill ───────────────────────────────────────────────────────────────

const PTP_STATUS: Record<string, { bg: string; txt: string }> = {
  Pending: { bg: `${AMBER}1F`, txt: AMBER },
  Kept:    { bg: `${GREEN}1F`, txt: GREEN },
  Broken:  { bg: `${RED}1A`,   txt: RED   },
}

function PtpPill({ status }: { status: string }) {
  const s = PTP_STATUS[status] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportPromisesCsv(rows: PTPane[]) {
  const header = ['CIF', 'Customer Name', 'Outstanding (₦)', 'PTP Amount (₦)', 'Due Date', 'Status', 'Agent', 'Created']
  const lines = rows.map(r => [
    r.account_cif ?? '',
    `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
    (r.outstanding_kobo / 100).toFixed(2),
    (r.promise_amount_kobo / 100).toFixed(2),
    r.promise_date ?? '',
    r.status ?? '',
    `"${String(r.agent_name ?? '').replace(/"/g, '""')}"`,
    r.created_at ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `promises-to-pay-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CollectionsPromises() {
  const [rows, setRows]       = useState<PTPane[]>([])
  const [kpis, setKpis]       = useState<PromiseKPIs | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  // Filters
  const [status, setStatus]     = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo]     = useState(today())
  const [q, setQ]               = useState('')

  // Action state
  const [actionRow, setActionRow]   = useState<PTPane | null>(null)
  const [actionType, setActionType] = useState<'kept' | 'broken' | null>(null)
  const [acting, setActing]         = useState(false)

  // Selection for batch export
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const p = new URLSearchParams({ limit: '100' })
    if (status)   p.set('status', status)
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to', dateTo)
    if (q.trim()) p.set('q', q.trim())
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: PTPane[] }>(`/api/collections-ops/promises?${p}`),
        apiFetch<{ data: PromiseKPIs }>('/api/collections/promise-kpis'),
      ])
      // Sort by promise_date asc (soonest first)
      const sorted = (res.data ?? []).slice().sort(
        (a, b) => new Date(a.promise_date).getTime() - new Date(b.promise_date).getTime()
      )
      setRows(sorted)
      setKpis(kpiRes.data)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load promises')
    } finally {
      setLoading(false)
    }
  }, [status, dateFrom, dateTo, q])

  useEffect(() => { load() }, [load])

  async function doAction() {
    if (!actionRow || !actionType) return
    setActing(true)
    try {
      await apiPut(`/api/collections-ops/promises/${actionRow.id}/${actionType}`, {})
      toast.success(actionType === 'kept' ? 'Promise marked as Kept' : 'Promise marked as Broken')
      setActionRow(null)
      setActionType(null)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Action failed')
    } finally {
      setActing(false)
    }
  }

  function openAction(row: PTPane, type: 'kept' | 'broken', e: React.MouseEvent) {
    e.stopPropagation()
    setActionRow(row)
    setActionType(type)
  }

  const cols: TableCol<PTPane>[] = [
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
      render: r => <span style={{ ...NUM, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(r.outstanding_kobo)}</span>,
    },
    {
      key: 'promise_amount_kobo',
      label: 'PTP Amount ₦',
      align: 'right',
      sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: 600, color: NAVY }}>{fmtKobo(r.promise_amount_kobo)}</span>,
    },
    {
      key: 'promise_date',
      label: 'Due Date',
      sortable: true,
      render: r => <span style={{ fontSize: 13, color: 'var(--txt)' }}>{fmtDate(r.promise_date)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: r => <PtpPill status={r.status} />,
    },
    {
      key: 'agent_name',
      label: 'Agent',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{r.agent_name ?? '—'}</span>,
    },
    {
      key: 'created_at',
      label: 'Created',
      render: r => <span style={{ fontSize: 11.5, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      width: 200,
      render: r => r.status !== 'Pending' ? null : (
        <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
          <button
            onClick={e => openAction(r, 'kept', e)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
              fontSize: 11.5, fontWeight: 600,
              background: `${GREEN}1F`, color: GREEN,
            }}
          >
            Mark Kept
          </button>
          <button
            onClick={e => openAction(r, 'broken', e)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
              fontSize: 11.5, fontWeight: 600,
              background: `${RED}1A`, color: RED,
            }}
          >
            Mark Broken
          </button>
        </div>
      ),
    },
  ]

  const selectedRows = rows.filter(r => selectedIds.has(r.id))

  const bulkBar = selectedIds.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: '#F0F4FF', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: NAVY }}>{selectedIds.size} selected</span>
      <div style={{ marginLeft: 'auto' }}>
        <button
          onClick={() => exportPromisesCsv(selectedRows)}
          style={btnSecondary}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>
          Export CSV
        </button>
      </div>
    </div>
  ) : undefined

  const kpiLoading = loading && !kpis

  return (
    <Page
      title="Promises to Pay"
      subtitle="Track and manage customer payment commitments"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Total Promises" value={kpis ? fmtNum(kpis.total) : '—'} icon="handshake" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Kept" value={kpis ? fmtNum(kpis.kept) : '—'} icon="check_circle" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Broken" value={kpis ? fmtNum(kpis.broken) : '—'} icon="cancel" accent={RED} loading={kpiLoading} />
        <KpiCard label="Amount Promised ₦" value={kpis ? fmtKobo(kpis.amount_promised_kobo) : '—'} icon="payments" accent={AMBER} loading={kpiLoading} />
      </div>

      <SectionCard title="Promises" badge={rows.length} padding={false} actions={<button onClick={() => exportPromisesCsv(rows)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setStatus(''); setDateFrom(monthStart()); setDateTo(today()); setQ('') }}>
            <select value={status} onChange={e => setStatus(e.target.value)} style={filterInputStyle}>
              <option value="">All Statuses</option>
              <option value="Pending">Pending</option>
              <option value="Kept">Kept</option>
              <option value="Broken">Broken</option>
            </select>
            <input
              placeholder="Search agent…"
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              style={{ ...filterInputStyle, minWidth: 180 }}
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
          selectable
          selectedIds={selectedIds}
          onSelect={setSelectedIds}
          bulkBar={bulkBar}
          emptyText="No promises found"
          skeletonRows={8}
          rowStyle={r => {
            const s = r.status
            if (s === 'Kept')   return { background: `${GREEN}0C` }
            if (s === 'Broken') return { background: `${RED}0D` }
            if (s === 'Pending' && r.promise_date && r.promise_date < today())
              return { background: `${RED}12` }
            if (s === 'Pending') return { background: `${AMBER}0A` }
            return undefined
          }}
        />
      </SectionCard>

      {/* Mark Kept confirm */}
      <ConfirmModal
        open={actionRow !== null && actionType === 'kept'}
        title="Mark Promise as Kept"
        body={`Mark the PTP of ${actionRow ? fmtKobo(actionRow.promise_amount_kobo) : ''} from CIF ${actionRow?.account_cif ?? ''} as Kept?`}
        confirmLabel="Mark Kept"
        loading={acting}
        onConfirm={doAction}
        onClose={() => { setActionRow(null); setActionType(null) }}
      />

      {/* Mark Broken confirm */}
      <ConfirmModal
        open={actionRow !== null && actionType === 'broken'}
        title="Mark Promise as Broken"
        body={`Mark the PTP of ${actionRow ? fmtKobo(actionRow.promise_amount_kobo) : ''} from CIF ${actionRow?.account_cif ?? ''} as Broken?`}
        confirmLabel="Mark Broken"
        danger
        loading={acting}
        onConfirm={doAction}
        onClose={() => { setActionRow(null); setActionType(null) }}
      />
    </Page>
  )
}
