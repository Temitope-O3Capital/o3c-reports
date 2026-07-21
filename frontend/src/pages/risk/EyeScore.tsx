import { useEffect, useState, useCallback, useRef } from 'react'
import { Page, KpiCard, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtPct, fmtNum, today, monthStart } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, GREEN, AMBER, RED, INTER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EyeScoreRow {
  id: number
  application_id: number
  applicant_name: string
  product_type: string
  score: number
  band: string
  top_factor: string | null
  dti_pct: number | null
  scored_at: string
}

interface EyeKPIs {
  scored_today: number
  avg_score_month: number
  high_risk_count: number
  requests_month: number
}

// ── Risk band pill ────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, { bg: string; txt: string }> = {
  Prime:        { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  'Near-Prime': { bg: 'rgba(37,99,235,.12)', txt: '#2563EB' },
  'Sub-Prime':  { bg: 'rgba(217,119,6,.12)', txt: '#D97706' },
  'High-Risk':  { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
}

function BandPill({ band }: { band: string }) {
  const s = BAND_COLORS[band] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full,
      background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{band}</span>
  )
}

function eyeScoreColor(score: number): string {
  if (score >= 700) return GREEN
  if (score >= 500) return AMBER
  return RED
}

// ── Main component ────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function EyeScore() {
  const [rows,     setRows]     = useState<EyeScoreRow[]>([])
  const [kpis,     setKpis]     = useState<EyeKPIs | null>(null)
  const [total,    setTotal]    = useState(0)
  const [offset,   setOffset]   = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [product,  setProduct]  = useState('')
  const [band,     setBand]     = useState('')

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(off))
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to', dateTo)
    if (product)  p.set('product', product)
    if (band)     p.set('band', band)
    return p.toString()
  }, [dateFrom, dateTo, product, band])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)
    try {
      const [scoreRes, kpiRes] = await Promise.all([
        apiFetch<{ data: EyeScoreRow[]; total: number }>(
          `/api/risk/eye-scores?${buildQS(off)}`,
          { signal: abortRef.current.signal },
        ),
        apiFetch<{ data: EyeKPIs }>('/api/risk/eye-kpis'),
      ])
      setRows(scoreRes.data ?? [])
      setTotal(scoreRes.total ?? 0)
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
    setDateFrom(monthStart()); setDateTo(today()); setProduct(''); setBand('')
  }

  const pages       = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const kpiLoading  = loading && !kpis

  const cols: TableCol<EyeScoreRow>[] = [
    {
      key: 'application_id', label: 'App #', width: 100,
      render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: NAVY }}>APP-{r.application_id}</span>,
    },
    {
      key: 'applicant_name', label: 'Applicant',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{r.applicant_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.product_type}</div>
        </div>
      ),
    },
    {
      key: 'score', label: 'Score', align: 'right', sortable: true,
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: eyeScoreColor(r.score) }}>
          {r.score}
        </span>
      ),
    },
    {
      key: 'band', label: 'Band',
      render: r => <BandPill band={r.band} />,
    },
    {
      key: 'top_factor', label: 'Key Factor',
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontStyle: r.top_factor ? 'normal' : 'italic' }}>
          {r.top_factor ?? 'N/A'}
        </span>
      ),
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
      key: 'scored_at', label: 'Date', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.scored_at)}</span>,
    },
  ]

  return (
    <Page
      title="Eye Credit Scores"
      subtitle="Credit scoring requests — scores, bands, and key risk factors"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={error} onRetry={() => load(0)} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard
          label="Scored Today"
          value={kpis?.scored_today ?? 0}
          icon="auto_awesome"
          accent={NAVY}
          loading={kpiLoading}
        />
        <KpiCard
          label="Avg Score (Month)"
          value={kpis ? Math.round(kpis.avg_score_month).toLocaleString() : '—'}
          sub="Eye score average"
          icon="analytics"
          accent={GREEN}
          loading={kpiLoading}
        />
        <KpiCard
          label="High Risk Count"
          value={kpis ? fmtNum(kpis.high_risk_count) : '—'}
          sub="Band = High-Risk"
          icon="error_outline"
          accent={RED}
          loading={kpiLoading}
        />
        <KpiCard
          label="Requests This Month"
          value={kpis ? fmtNum(kpis.requests_month) : '—'}
          sub="Total scoring calls"
          icon="query_stats"
          accent={AMBER}
          loading={kpiLoading}
        />
      </div>

      <SectionCard title="Score Requests" badge={total} padding={false}>
        <div style={{ padding: '12px 18px 0' }}>
          <FilterBar onReset={resetFilters}>
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
          emptyText="No score requests found"
          searchKeys={['applicant_name', 'band']}
          searchPlaceholder="Search by applicant name or score band…"
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
