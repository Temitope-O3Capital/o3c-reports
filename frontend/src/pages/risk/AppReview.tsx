import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiExport } from '../../lib/api'
import { fmtKobo, fmtDate, fmtPct, fmtNum, today, monthStart } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, GREEN, AMBER, RED, INTER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReviewKPIs {
  reviewed: number
  approved: number
  declined: number
  pending: number
}

interface RiskApp {
  id: number
  reference: string
  applicant_name: string
  employer_name: string | null
  eye_score: number | null
  risk_band: string | null
  monthly_income_kobo: number
  dti_pct: number | null
  amount_requested_kobo: number
  product_type: string
  submitted_at: string | null
}

// ── Risk band pill ────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, { bg: string; txt: string }> = {
  Prime:       { bg: 'rgba(22,163,74,.12)',   txt: '#16A34A' },
  'Near-Prime': { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  'Sub-Prime':  { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  'High-Risk':  { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
}

function BandPill({ band }: { band: string | null }) {
  if (!band) return <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>—</span>
  const s = BAND_COLORS[band] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full,
      background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{band}</span>
  )
}

function ProductPill({ product }: { product: string }) {
  const label = product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function eyeScoreColor(score: number | null): string {
  if (score === null) return 'var(--txt2)'
  if (score >= 700) return GREEN
  if (score >= 500) return AMBER
  return RED
}

// ── Main component ────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

export default function RiskAppReview() {
  const navigate = useNavigate()

  const [rows,     setRows]     = useState<RiskApp[]>([])
  const [kpis,     setKpis]     = useState<ReviewKPIs | null>(null)
  const [total,    setTotal]    = useState(0)
  const [offset,   setOffset]   = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [stage,    setStage]    = useState('')
  const [product,  setProduct]  = useState('')
  const [band,     setBand]     = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [selected, setSelected] = useState<Set<string | number>>(new Set())

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(off))
    if (stage)    p.set('stage', stage)
    if (product)  p.set('product', product)
    if (band)     p.set('band', band)
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to', dateTo)
    return p.toString()
  }, [stage, product, band, dateFrom, dateTo])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: RiskApp[]; total: number }>(
          `/api/risk/applications?${buildQS(off)}`,
          { signal: abortRef.current.signal },
        ),
        apiFetch<{ data: ReviewKPIs }>('/api/risk/review-kpis'),
      ])
      setRows(res.data ?? [])
      setTotal(res.total ?? 0)
      setOffset(off)
      setKpis(kpiRes.data)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [buildQS])

  useEffect(() => { load(0) }, [load])

  function resetFilters() {
    setStage(''); setProduct(''); setBand('')
    setDateFrom(monthStart()); setDateTo(today())
  }

  const pages      = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  const cols: TableCol<RiskApp>[] = [
    {
      key: 'reference', label: 'App #', width: 110,
      render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: NAVY }}>{r.reference}</span>,
    },
    {
      key: 'applicant_name', label: 'Applicant',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{r.applicant_name}</div>
          {r.employer_name && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.employer_name}</div>}
        </div>
      ),
    },
    {
      key: 'eye_score', label: 'Eye Score', align: 'right', sortable: true,
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: eyeScoreColor(r.eye_score) }}>
          {r.eye_score ?? '—'}
        </span>
      ),
    },
    {
      key: 'risk_band', label: 'Risk Band',
      render: r => <BandPill band={r.risk_band} />,
    },
    {
      key: 'monthly_income_kobo', label: 'Monthly Income', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.monthly_income_kobo)}</span>,
    },
    {
      key: 'dti_pct', label: 'DTI %', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontWeight: 600, color: r.dti_pct !== null && r.dti_pct > 40 ? RED : 'var(--txt)' }}>
          {r.dti_pct !== null ? fmtPct(r.dti_pct) : '—'}
        </span>
      ),
    },
    {
      key: 'amount_requested_kobo', label: 'Amount Requested', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_requested_kobo)}</span>,
    },
    {
      key: 'product_type', label: 'Product',
      render: r => <ProductPill product={r.product_type} />,
    },
    {
      key: 'submitted_at', label: 'Submitted', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.submitted_at)}</span>,
    },
  ]

  const bulkBar = selected.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
        {selected.size} selected
      </span>
      <button
        onClick={() => apiExport(`/api/risk/applications/export?${buildQS(0)}`, 'risk-applications.csv')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV
      </button>
    </div>
  ) : null

  const kpiLoading = loading && !kpis

  return (
    <Page
      title="App Review"
      subtitle="Risk review queue — applications pending credit decision"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => apiExport(`/api/risk/applications/export?${buildQS(0)}`, 'risk-applications.csv')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>Export CSV
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load(0)} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Reviewed" value={kpis ? fmtNum(kpis.reviewed) : '—'} icon="fact_check" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Approved" value={kpis ? fmtNum(kpis.approved) : '—'} icon="check_circle" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Declined" value={kpis ? fmtNum(kpis.declined) : '—'} icon="cancel" accent={RED} loading={kpiLoading} />
        <KpiCard label="Pending" value={kpis ? fmtNum(kpis.pending) : '—'} icon="pending" accent={AMBER} loading={kpiLoading} />
      </div>

      <SectionCard title="Applications" badge={total} padding={false}>
        <div style={{ padding: '12px 18px 0' }}>
          <FilterBar onReset={resetFilters}>
            <select value={stage} onChange={e => setStage(e.target.value)} style={filterInputStyle}>
              <option value="">All stages</option>
              <option value="Risk Review">Risk Review</option>
              <option value="Pending Committee">Pending Committee</option>
              <option value="Referred">Referred</option>
            </select>
            <select value={product} onChange={e => setProduct(e.target.value)} style={filterInputStyle}>
              <option value="">All products</option>
              <option value="Salary Loan">Salary Loan</option>
              <option value="Business Loan">Business Loan</option>
              <option value="Personal Loan">Personal Loan</option>
            </select>
            <select value={band} onChange={e => setBand(e.target.value)} style={filterInputStyle}>
              <option value="">All bands</option>
              <option value="Prime">Prime</option>
              <option value="Near-Prime">Near-Prime</option>
              <option value="Sub-Prime">Sub-Prime</option>
              <option value="High-Risk">High-Risk</option>
            </select>
            <button
              onClick={() => load(0)}
              style={{ height: 32, padding: '0 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
            >Apply</button>
          </FilterBar>
        </div>

        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          onRowClick={r => navigate(`/sales/applications/${r.id}`)}
          selectable
          selectedIds={selected}
          onSelect={setSelected}
          bulkBar={bulkBar}
          emptyText="No applications found"
        />

        {pages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
              Page {currentPage} of {pages} · {total.toLocaleString()} records
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.5 : 1, fontSize: TEXT.sm }}
              >← Prev</button>
              <button
                onClick={() => load(offset + PAGE_SIZE)}
                disabled={currentPage >= pages}
                style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: currentPage >= pages ? 'not-allowed' : 'pointer', opacity: currentPage >= pages ? 0.5 : 1, fontSize: TEXT.sm }}
              >Next →</button>
            </div>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
