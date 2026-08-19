import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, StatusBadge, DateFilter, NameCell, ActionRow, ExpandableFilterBar } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, NAVY, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

interface LoanApp {
  id: number
  reference: string
  applicant_name: string
  product_type: string
  amount_requested_kobo: number
  stage: string
  status: string
  assigned_to_user_id: number
  assigned_officer_name?: string | null
  submitted_at: string | null
  disbursed_at: string | null
  updated_at: string
  created_at: string
}

interface StageRow { stage: string; count: number }
interface StatusRow { status: string; count: number }

interface LOSStats {
  by_status: StatusRow[]
  by_stage: StageRow[]
  total_pipeline_kobo: number
  total_disbursed_kobo: number
  open_count: number
  avg_days_to_close: number
}

const STAGE_COLORS: Record<string, { bg: string; txt: string }> = {
  draft:               { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  submitted:           { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  document_collection: { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  risk_review:         { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  risk_head_review:    { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  pending_conditions:  { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  finance_approval:    { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  booking:             { bg: 'rgba(14,40,65,.1)',    txt: '#0E2841' },
  active:              { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  declined:            { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
}

const STAGES = [
  'draft', 'submitted', 'document_collection', 'risk_review',
  'risk_head_review', 'pending_conditions', 'finance_approval', 'booking', 'active', 'declined',
]

function StagePill({ stage }: { stage: string }) {
  const s = STAGE_COLORS[stage] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  const label = stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function ProductPill({ product }: { product: string }) {
  const label = product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}



function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: RADIUS.sm,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? RED : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
    </button>
  )
}

const PER_PAGE = 25

export default function LOSQueue() {
  const navigate = useNavigate()

  const [rows,       setRows]       = useState<LoanApp[]>([])
  const [stats,      setStats]      = useState<LOSStats | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState<string | null>(null)
  const [search,     setSearch]     = useState('')
  const [fStages,    setFStages]    = useState<Set<string>>(new Set())
  const [fProducts,  setFProducts]  = useState<Set<string>>(new Set())
  const [fStatuses,  setFStatuses]  = useState<Set<string>>(new Set())
  const [fOfficers,  setFOfficers]  = useState<Set<string>>(new Set())
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  const [page,       setPage]       = useState(1)
  // M10: cursor-based pagination state
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [hasMore,    setHasMore]    = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [bulkSel,    setBulkSel]    = useState<Set<string | number>>(new Set())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const [queueRes, statsRes] = await Promise.all([
        apiFetch<{ data: LoanApp[]; next_cursor: number; has_more: boolean }>('/api/los/queue?limit=50'),
        apiFetch<{ data: LOSStats }>('/api/los/stats'),
      ])
      setRows(queueRes.data ?? [])
      setNextCursor(queueRes.next_cursor ?? null)
      setHasMore(queueRes.has_more ?? false)
      setStats(statsRes.data ?? null)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await apiFetch<{ data: LoanApp[]; next_cursor: number; has_more: boolean }>(
        `/api/los/queue?limit=50&after_id=${nextCursor}`
      )
      setRows(prev => [...prev, ...(res.data ?? [])])
      setNextCursor(res.next_cursor ?? null)
      setHasMore(res.has_more ?? false)
    } catch { /* silently ignore */ }
    finally { setLoadingMore(false) }
  }, [nextCursor, loadingMore])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['loans'] })

  // Page-level date scope — drives KPIs and table together
  const dateFiltered = useMemo(() => {
    if (!dateFrom && !dateTo) return rows
    return rows.filter(r => {
      const date = (r.submitted_at ?? r.created_at).slice(0, 10)
      if (dateFrom && date < dateFrom) return false
      if (dateTo   && date > dateTo)   return false
      return true
    })
  }, [rows, dateFrom, dateTo])

  // Derive filter options from date-scoped data
  const products = useMemo(() => [...new Set(dateFiltered.map(r => r.product_type).filter(Boolean))].sort(), [dateFiltered])
  const officers = useMemo(() => [...new Set(dateFiltered.map(r => r.assigned_officer_name).filter((n): n is string => !!n))].sort(), [dateFiltered])
  const statuses = useMemo(() => [...new Set(dateFiltered.map(r => r.status).filter(Boolean))].sort(), [dateFiltered])

  const groups: FilterGroupDef[] = [
    {
      key: 'stage', label: 'Stage',
      options: STAGES.map(s => ({
        value: s,
        label: s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        count: dateFiltered.filter(r => r.stage === s).length,
        color: STAGE_COLORS[s]?.txt,
      })),
      selected: fStages, onChange: setFStages,
    },
    {
      key: 'status', label: 'Status',
      options: statuses.map(s => ({
        value: s,
        label: s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        count: dateFiltered.filter(r => r.status === s).length,
      })),
      selected: fStatuses, onChange: setFStatuses,
    },
    {
      key: 'product', label: 'Product',
      options: products.map(p => ({
        value: p,
        label: p.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        count: dateFiltered.filter(r => r.product_type === p).length,
      })),
      selected: fProducts, onChange: setFProducts,
    },
    {
      key: 'officer', label: 'Officer',
      options: officers.map(o => ({
        value: o,
        label: o,
        count: dateFiltered.filter(r => r.assigned_officer_name === o).length,
      })),
      selected: fOfficers, onChange: setFOfficers,
    },
  ]

  const filtered = useMemo(() => dateFiltered.filter(r => {
    if (fStages.size   && !fStages.has(r.stage))                        return false
    if (fProducts.size && !fProducts.has(r.product_type))               return false
    if (fStatuses.size && !fStatuses.has(r.status))                     return false
    if (fOfficers.size && !fOfficers.has(r.assigned_officer_name ?? '')) return false
    if (search) {
      const q = search.toLowerCase()
      if (!(r.applicant_name.toLowerCase().includes(q) || r.reference?.toLowerCase().includes(q))) return false
    }
    return true
  }), [dateFiltered, fStages, fProducts, fStatuses, fOfficers, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart  = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd    = Math.min(safePage * PER_PAGE, filtered.length)

  useEffect(() => { setPage(1) }, [search, fStages, fProducts, fStatuses, fOfficers, dateFrom, dateTo])

  function toggleSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set)
    next.has(value) ? next.delete(value) : next.add(value)
    return next
  }

  function resetFilters() {
    setSearch(''); setFStages(new Set()); setFProducts(new Set())
    setFStatuses(new Set()); setFOfficers(new Set())
  }

  const dateScopedKpi = !!(dateFrom || dateTo)
  const inQueue      = dateScopedKpi ? dateFiltered.length                                                                                         : stats?.open_count ?? 0
  const pendingDocs  = dateScopedKpi ? dateFiltered.filter(r => r.stage === 'document_collection').length                                          : stats?.by_stage?.find(s => s.stage === 'document_collection')?.count ?? 0
  const awaitingRisk = dateScopedKpi ? dateFiltered.filter(r => r.stage === 'risk_review' || r.stage === 'risk_head_review').length                 : (stats?.by_stage?.find(s => s.stage === 'risk_review')?.count ?? 0) + (stats?.by_stage?.find(s => s.stage === 'risk_head_review')?.count ?? 0)
  const activeCount  = dateScopedKpi ? dateFiltered.filter(r => r.stage === 'active').length                                                       : stats?.by_stage?.find(s => s.stage === 'active')?.count ?? 0

  const cols: TableCol<LoanApp>[] = [
    {
      key: 'id', label: 'App #', width: 110,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>APP-{r.id}</span>,
    },
    {
      key: 'applicant_name', label: 'Applicant',
      render: r => <NameCell name={r.applicant_name} sub={r.reference ?? null} />,
    },
    { key: 'product_type', label: 'Product', render: r => <ProductPill product={r.product_type} /> },
    {
      key: 'amount_requested_kobo', label: 'Amount', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_requested_kobo)}</span>,
    },
    { key: 'stage', label: 'Stage', render: r => <StagePill stage={r.stage} /> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} size="sm" /> },
    {
      key: 'assigned_officer_name', label: 'Officer',
      render: r => r.assigned_officer_name
        ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.assigned_officer_name}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'disbursed_at', label: 'Disbursement Date',
      render: r => r.disbursed_at
        ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.disbursed_at)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'updated_at', label: 'Last Updated',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.updated_at)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: r => <ActionRow actions={[
        { icon: 'open_in_new', label: 'View Application', onClick: () => navigate(`/sales/applications/${r.id}`) },
        { icon: 'person_add', label: 'Assign Reviewer', onClick: () => {} },
      ]} />,
    },
  ]

  return (
    <Page
      title="Credit Applications"
      subtitle="Your assigned applications queue"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => navigate('/sales/applications/new')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '7px 15px', background: NAVY, color: '#fff',
              border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
            New Application
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="In Queue"          value={inQueue}      icon="inbox"         loading={loading} />
        <KpiCard label="Pending Docs"      value={pendingDocs}  icon="description"   loading={loading} />
        <KpiCard label="Awaiting Risk"     value={awaitingRisk} icon="shield"        loading={loading} />
        <KpiCard label="Active Loans"        value={activeCount}  icon="check_circle"  accent="#16A34A" loading={loading} />
      </div>

      <SectionCard
        title="Applications"
        badge={filtered.length}
        padding={false}
      >

        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={groups}
          onReset={resetFilters}
          resultCount={filtered.length}
          totalCount={rows.length}
          placeholder="Search by name or reference…"
        />

        <DataTable
          cols={cols}
          rows={pageRows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          onRowClick={r => navigate(`/sales/applications/${r.id}`)}
          emptyText="No applications found"
          selectable
          selectedIds={bulkSel}
          onSelect={setBulkSel}
          bulkBar={
            <>
              <button style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>Bulk Assign</button>
            </>
          }
        />

        {/* Pagination footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {filtered.length === 0
              ? 'No applications'
              : `Showing ${showStart}–${showEnd} of ${filtered.length}${hasMore ? '+' : ''} applications`}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                style={{
                  padding: '5px 12px', fontSize: TEXT.sm, borderRadius: RADIUS.sm,
                  border: '1px solid var(--bdr)', background: 'var(--card)',
                  color: 'var(--txt2)', cursor: loadingMore ? 'default' : 'pointer',
                  opacity: loadingMore ? 0.6 : 1,
                }}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <PageBtn icon="chevron_left" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} />
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let pg: number
                  if (totalPages <= 7) pg = i + 1
                  else if (safePage <= 4) pg = i + 1
                  else if (safePage >= totalPages - 3) pg = totalPages - 6 + i
                  else pg = safePage - 3 + i
                  return <PageBtn key={pg} active={pg === safePage} onClick={() => setPage(pg)}>{pg}</PageBtn>
                })}
                <PageBtn icon="chevron_right" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} />
              </div>
            )}
          </div>
        </div>

      </SectionCard>
    </Page>
  )
}
