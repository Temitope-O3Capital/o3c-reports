import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, StatusBadge, filterInputStyle, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, BLUE, NAVY, INTER, SORA, NUM } from '../../lib/design'

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
  'risk_head_review', 'pending_conditions', 'finance_approval', 'booking', 'active',
]

const PRODUCTS = ['Salary Loan', 'Business Loan', 'Personal Loan']

function StagePill({ stage }: { stage: string }) {
  const s = STAGE_COLORS[stage] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  const label = stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function ProductPill({ product }: { product: string }) {
  const label = product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}


function exportLOSCsv(rows: LoanApp[]) {
  const header = ['App #', 'Applicant', 'Reference', 'Product', 'Amount (₦)', 'Stage', 'Status', 'Officer', 'Last Updated']
  const lines = rows.map(r => [
    `APP-${r.id}`,
    `"${String(r.applicant_name ?? '').replace(/"/g, '""')}"`,
    r.reference ?? '',
    `"${String(r.product_type ?? '').replace(/"/g, '""')}"`,
    (r.amount_requested_kobo / 100).toFixed(2),
    r.stage ?? '',
    r.status ?? '',
    `"${String(r.assigned_officer_name ?? '').replace(/"/g, '""')}"`,
    r.updated_at ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `loan-applications-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: 6,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? RED : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span> : children}
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
  const [filterOpen, setFilterOpen] = useState(false)
  const [fStages,    setFStages]    = useState<Set<string>>(new Set())
  const [fProducts,  setFProducts]  = useState<Set<string>>(new Set())
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  const [page,       setPage]       = useState(1)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [queueRes, statsRes] = await Promise.all([
        apiFetch<{ data: LoanApp[] }>('/api/los/queue?limit=200&offset=0'),
        apiFetch<{ data: LOSStats }>('/api/los/stats'),
      ])
      setRows(queueRes.data ?? [])
      setStats(statsRes.data ?? null)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const activeFilterCount = fStages.size + fProducts.size + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0)

  const filtered = useMemo(() => rows.filter(r => {
    if (fStages.size && !fStages.has(r.stage)) return false
    if (fProducts.size && !fProducts.has(r.product_type)) return false
    if (dateFrom && r.updated_at < dateFrom) return false
    if (dateTo && r.updated_at.slice(0, 10) > dateTo) return false
    if (search) {
      const q = search.toLowerCase()
      if (!(r.applicant_name.toLowerCase().includes(q) || r.reference?.toLowerCase().includes(q))) return false
    }
    return true
  }), [rows, fStages, fProducts, dateFrom, dateTo, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart  = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd    = Math.min(safePage * PER_PAGE, filtered.length)

  useEffect(() => { setPage(1) }, [search, fStages, fProducts, dateFrom, dateTo])

  function toggleSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set)
    next.has(value) ? next.delete(value) : next.add(value)
    return next
  }

  function resetFilters() {
    setSearch(''); setFStages(new Set()); setFProducts(new Set()); setDateFrom(''); setDateTo('')
  }

  const inQueue      = stats?.open_count ?? 0
  const pendingDocs  = stats?.by_stage?.find(s => s.stage === 'document_collection')?.count ?? 0
  const awaitingRisk = (stats?.by_stage?.find(s => s.stage === 'risk_review')?.count ?? 0)
                     + (stats?.by_stage?.find(s => s.stage === 'risk_head_review')?.count ?? 0)
  const activeCount  = stats?.by_stage?.find(s => s.stage === 'active')?.count ?? 0

  const cols: TableCol<LoanApp>[] = [
    {
      key: 'id', label: 'App #', width: 110,
      render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: NAVY }}>APP-{r.id}</span>,
    },
    {
      key: 'applicant_name', label: 'Applicant',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)', fontFamily: SORA }}>{r.applicant_name}</div>
          {r.reference && <div style={{ fontSize: 10.5, color: 'var(--txt2)', fontFamily: INTER }}>{r.reference}</div>}
        </div>
      ),
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
        ? <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{r.assigned_officer_name}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'updated_at', label: 'Last Updated',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDatetime(r.updated_at)}</span>,
    },
  ]

  return (
    <Page
      title="Loan Applications"
      subtitle="Your assigned applications queue"
      actions={
        <button
          onClick={() => navigate('/sales/applications/new')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '7px 15px', background: NAVY, color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Application
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="In Queue"          value={inQueue}      icon="inbox"         loading={loading} />
        <KpiCard label="Pending Docs"      value={pendingDocs}  icon="description"   loading={loading} />
        <KpiCard label="Awaiting Risk"     value={awaitingRisk} icon="shield"        loading={loading} />
        <KpiCard label="Disbursed Today"    value={activeCount}  icon="check_circle"  accent="#16A34A" loading={loading} />
      </div>

      <SectionCard title="Applications" badge={filtered.length} padding={false}>

        {/* Filter bar */}
        <div style={{
          padding: '12px 18px',
          borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />

          <button
            onClick={() => setFilterOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
              border: `1.5px solid ${activeFilterCount > 0 ? RED : 'var(--input-bdr)'}`,
              background: 'transparent',
              color: activeFilterCount > 0 ? RED : 'var(--txt2)',
              cursor: 'pointer', fontFamily: SORA, position: 'relative',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
            Filters
            {activeFilterCount > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                width: 16, height: 16, borderRadius: '50%',
                background: RED, color: '#fff',
                fontSize: 9, fontWeight: 700, fontFamily: INTER,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{activeFilterCount}</span>
            )}
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length} of {rows.length}
            </span>
          </div>
        </div>

        {/* Expandable filter panel */}
        {filterOpen && (
          <div style={{ borderBottom: '1px solid var(--bdr)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '20px 20px 0' }}>

              {/* Stage */}
              <div style={{ paddingRight: 20, borderRight: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>STAGE</div>
                {STAGES.map(s => {
                  const sc = STAGE_COLORS[s]
                  const count = rows.filter(r => r.stage === s).length
                  const label = s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                  return (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                      <input type="checkbox" checked={fStages.has(s)} onChange={() => setFStages(toggleSet(fStages, s))}
                        style={{ accentColor: sc?.txt ?? NAVY, width: 14, height: 14, cursor: 'pointer' }} />
                      <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: sc?.bg ?? 'var(--chip-bg)', color: sc?.txt ?? 'var(--chip-txt)' }}>{label}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                    </label>
                  )
                })}
              </div>

              {/* Product */}
              <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>PRODUCT</div>
                {PRODUCTS.map(p => {
                  const count = rows.filter(r => r.product_type.toLowerCase().includes(p.toLowerCase())).length
                  return (
                    <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                      <input type="checkbox" checked={fProducts.has(p)} onChange={() => setFProducts(toggleSet(fProducts, p))}
                        style={{ accentColor: BLUE, width: 14, height: 14, cursor: 'pointer' }} />
                      <span style={{ fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA }}>{p}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                    </label>
                  )
                })}
              </div>

              {/* Date range */}
              <div style={{ paddingLeft: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>DATE RANGE</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>From</label>
                    <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                      style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>To</label>
                    <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                      style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
                  </div>
                </div>
              </div>

            </div>

            <div style={{
              padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>
                {activeFilterCount === 0
                  ? `No filters applied — showing all ${rows.length} applications`
                  : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
              </span>
              <button onClick={resetFilters} style={{
                padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
              }}>Reset</button>
              <button onClick={() => setFilterOpen(false)} style={{
                marginLeft: 'auto', padding: '5px 16px', borderRadius: 7,
                fontSize: 12, fontWeight: 600,
                border: 'none', background: RED, color: '#fff',
                cursor: 'pointer', fontFamily: SORA,
              }}>Apply · {filtered.length} results</button>
            </div>
          </div>
        )}

        {/* Active chips */}
        {!filterOpen && activeFilterCount > 0 && (
          <div style={{
            padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          }}>
            {[...fStages].map(s => {
              const sc = STAGE_COLORS[s]
              const label = s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
              return (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: sc?.bg ?? 'var(--chip-bg)', color: sc?.txt ?? 'var(--chip-txt)' }}>
                  {label}<span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setFStages(toggleSet(fStages, s))}>close</span>
                </span>
              )
            })}
            {[...fProducts].map(p => (
              <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: 'rgba(37,99,235,.10)', color: BLUE }}>
                {p}<span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setFProducts(toggleSet(fProducts, p))}>close</span>
              </span>
            ))}
            {dateFrom && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                From {dateFrom}<span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setDateFrom('')}>close</span>
              </span>
            )}
            {dateTo && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                To {dateTo}<span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setDateTo('')}>close</span>
              </span>
            )}
            <button onClick={resetFilters} style={{ marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--txt3)', padding: 0, fontFamily: SORA }}>Clear all</button>
          </div>
        )}

        <DataTable
          cols={cols}
          rows={pageRows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          onRowClick={r => navigate(`/sales/applications/${r.id}`)}
          emptyText="No applications found"
          onExport={() => exportLOSCsv(filtered)}
        />

        {/* Pagination footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
            {filtered.length === 0
              ? 'No applications'
              : `Showing ${showStart}–${showEnd} of ${filtered.length} applications`}
          </span>
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

      </SectionCard>
    </Page>
  )
}
