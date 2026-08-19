import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Page, KpiCard, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, ConfirmModal, btnSecondary, DateFilter,
  NameCell, ActionRow, StatusBadge,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { AMBER, GREEN, RED, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

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



// ── Main component ────────────────────────────────────────────────────────────

export default function CollectionsPromises() {
  const [rows, setRows]       = useState<PTPane[]>([])
  const [kpis, setKpis]       = useState<PromiseKPIs | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  // Filters
  const [fStatus, setFStatus]   = useState(new Set<string>())
  const [search, setSearch]     = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo]     = useState(today())

  // Action state
  const [actionRow, setActionRow]   = useState<PTPane | null>(null)
  const [actionType, setActionType] = useState<'kept' | 'broken' | null>(null)
  const [acting, setActing]         = useState(false)

  // Selection for batch export
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())

  const fStatusKey = [...fStatus].join(',')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    const p = new URLSearchParams({ limit: '100' })
    if (fStatusKey) p.set('status', fStatusKey)
    if (dateFrom)   p.set('date_from', dateFrom)
    if (dateTo)     p.set('date_to', dateTo)
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
  }, [fStatusKey, dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections','loans'] })

  const displayed = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      [r.account_cif, r.customer_name, r.agent_name, r.promise_date].some(
        v => v != null && String(v).toLowerCase().includes(q)
      )
    )
  }, [rows, search])

  const groups: FilterGroupDef[] = [
    {
      key: 'status',
      label: 'STATUS',
      options: [
        { value: 'Pending', color: AMBER, count: rows.filter(r => r.status === 'Pending').length },
        { value: 'Kept',    color: GREEN, count: rows.filter(r => r.status === 'Kept').length },
        { value: 'Broken',  color: RED,   count: rows.filter(r => r.status === 'Broken').length },
      ],
      selected: fStatus,
      onChange: setFStatus,
    },
  ]

  function resetFilters() { setFStatus(new Set()); setSearch('') }

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


  const cols: TableCol<PTPane>[] = [
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
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtKobo(r.outstanding_kobo)}</span>,
    },
    {
      key: 'promise_amount_kobo',
      label: 'PTP Amount NGN',
      align: 'right',
      sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: NAVY }}>{fmtKobo(r.promise_amount_kobo)}</span>,
    },
    {
      key: 'promise_date',
      label: 'Due Date',
      sortable: true,
      render: r => <span style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{fmtDate(r.promise_date)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: r => <StatusBadge status={r.status} />,
    },
    {
      key: 'agent_name',
      label: 'Agent',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.agent_name ?? '—'}</span>,
    },
    {
      key: 'created_at',
      label: 'Created',
      render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      width: 90,
      render: r => r.status !== 'Pending' ? null : (
        <ActionRow actions={[
          { icon: 'check_circle', label: 'Mark Kept',   onClick: () => { setActionRow(r); setActionType('kept') } },
          { icon: 'cancel',       label: 'Mark Broken', onClick: () => { setActionRow(r); setActionType('broken') }, danger: true },
        ]} />
      ),
    },
  ]

  const selectedRows = rows.filter(r => selectedIds.has(r.id))

  const bulkBar = selectedIds.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: 'var(--chip-bg)', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{selectedIds.size} selected</span>
      <div style={{ marginLeft: 'auto' }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Promises" value={kpis ? fmtNum(kpis.total) : '—'} icon="handshake" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Kept" value={kpis ? fmtNum(kpis.kept) : '—'} icon="check_circle" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Broken" value={kpis ? fmtNum(kpis.broken) : '—'} icon="cancel" accent={RED} loading={kpiLoading} />
        <KpiCard label="Amount Promised ₦" value={kpis ? fmtKobo(kpis.amount_promised_kobo) : '—'} icon="payments" accent={AMBER} loading={kpiLoading} />
      </div>

      <SectionCard title="Promises" badge={rows.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={groups}
          onReset={resetFilters}
          onApply={load}
          resultCount={displayed.length}
          totalCount={rows.length}
          placeholder="Search CIF, name, agent…"
        />
        <DataTable
          cols={cols}
          rows={displayed}
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
