import { useEffect, useState, useCallback, useRef } from 'react'
import { Page, SectionCard, FilterBar, filterInputStyle, ErrBanner, Sk, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtPct, fmtNum, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, RED, NAVY, INTER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface VintageRow {
  booking_month: string
  cohort_count: number
  par30_1m: number | null
  par30_3m: number | null
  par30_6m: number | null
  par30_12m: number | null
}

interface VintageKPIs {
  avg_par30_6m: number | null
  avg_par30_12m: number | null
}

// ── Cell colouring for PAR % values ──────────────────────────────────────────

function parCell(value: number | null): { bg: string; color: string; text: string } {
  if (value === null) return { bg: 'transparent', color: 'var(--txt3)', text: 'N/A' }
  if (value < 5)   return { bg: 'rgba(22,163,74,.10)',  color: GREEN, text: fmtPct(value, 1) }
  if (value <= 15) return { bg: 'rgba(217,119,6,.10)',  color: AMBER, text: fmtPct(value, 1) }
  return            { bg: 'rgba(192,0,0,.10)',           color: RED,   text: fmtPct(value, 1) }
}

// ── PAR % table cell ──────────────────────────────────────────────────────────

function ParCell({ value }: { value: number | null }) {
  const s = parCell(value)
  return (
    <td style={{
      padding: '10px 16px',
      textAlign: 'right',
      background: s.bg,
      borderBottom: '1px solid var(--bdr)',
    }}>
      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: s.color }}>
        {s.text}
      </span>
    </td>
  )
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function InlineKpi({ label, value, loading, accent, icon, sub }: {
  label: string; value: string; loading: boolean; accent?: string; icon?: string; sub?: string
}) {
  const ac = accent ?? NAVY
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
      borderRadius: RADIUS.xl, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6,
      borderTop: `3px solid ${ac}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', letterSpacing: '0.4px', textTransform: 'uppercase' }}>{label}</span>
        {icon && (
          <div style={{ width: 26, height: 26, borderRadius: RADIUS.md, background: `${ac}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14, color: ac }}>{icon}</span>
          </div>
        )}
      </div>
      {loading
        ? <Sk h={28} w="55%" />
        : <span style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.bold, color: 'var(--txt)', letterSpacing: '-0.7px', lineHeight: 1.2 }}>{value}</span>
      }
      {sub && !loading && (
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{sub}</span>
      )}
    </div>
  )
}

// ── Skeleton rows for loading state ──────────────────────────────────────────

function SkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <tr key={i}>
          <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }}><Sk h={14} w={80} /></td>
          <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', textAlign: 'right' }}><Sk h={14} w={40} /></td>
          {[0, 1, 2, 3].map(j => (
            <td key={j} style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', textAlign: 'right' }}><Sk h={14} w={48} /></td>
          ))}
        </tr>
      ))}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VintageAnalysis() {
  const [rows,     setRows]    = useState<VintageRow[]>([])
  const [kpis,     setKpis]    = useState<VintageKPIs | null>(null)
  const [loading,  setLoading] = useState(true)
  const [error,    setError]   = useState<string | null>(null)
  const [product,  setProduct] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback(() => {
    const p = new URLSearchParams()
    if (product)  p.set('product', product)
    if (dateFrom) p.set('from', dateFrom)
    if (dateTo)   p.set('to', dateTo)
    return p.toString()
  }, [product, dateFrom, dateTo])

  const load = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)
    try {
      const [vintageRes, kpiRes] = await Promise.all([
        apiFetch<{ data: VintageRow[] }>(
          `/api/risk/vintage?${buildQS()}`,
          { signal: abortRef.current.signal },
        ),
        apiFetch<{ data: VintageKPIs }>(`/api/risk/vintage-kpis?${buildQS()}`),
      ])
      setRows(vintageRes.data ?? [])
      setKpis(kpiRes.data)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [buildQS])

  useEffect(() => { load() }, [load])

  const kpiLoading = loading && !kpis

  const avg6m  = kpis?.avg_par30_6m  !== null && kpis?.avg_par30_6m  !== undefined ? fmtPct(kpis.avg_par30_6m,  1) : 'N/A'
  const avg12m = kpis?.avg_par30_12m !== null && kpis?.avg_par30_12m !== undefined ? fmtPct(kpis.avg_par30_12m, 1) : 'N/A'

  // Accent colour based on PAR rate value
  function parAccent(val: number | null | undefined): string {
    if (val === null || val === undefined) return NAVY
    if (val < 5)   return GREEN
    if (val <= 15) return AMBER
    return RED
  }

  // Best performing vintage = row with lowest non-null par30_12m (fallback: par30_6m)
  const bestVintage = (() => {
    if (!rows.length) return 'N/A'
    const scored = rows
      .map(r => ({ month: r.booking_month, rate: r.par30_12m ?? r.par30_6m }))
      .filter(r => r.rate !== null)
    if (!scored.length) return 'N/A'
    scored.sort((a, b) => (a.rate as number) - (b.rate as number))
    return scored[0].month
  })()

  return (
    <Page
      title="Vintage Analysis"
      subtitle="PAR30 cohort performance by booking month"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* 4-card KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <InlineKpi
          label="Total Cohorts Analyzed"
          value={loading ? '…' : fmtNum(rows.length)}
          loading={false}
          accent={NAVY}
          icon="calendar_month"
          sub="Booking month cohorts"
        />
        <InlineKpi
          label="Avg 30-DPD Rate (6m)"
          value={avg6m}
          loading={kpiLoading}
          accent={parAccent(kpis?.avg_par30_6m)}
          icon="monitoring"
          sub="PAR30 at 6-month mark"
        />
        <InlineKpi
          label="Avg 30-DPD Rate (12m)"
          value={avg12m}
          loading={kpiLoading}
          accent={parAccent(kpis?.avg_par30_12m)}
          icon="error_outline"
          sub="PAR30 at 12-month mark"
        />
        <InlineKpi
          label="Best Performing Vintage"
          value={loading ? '…' : bestVintage}
          loading={false}
          accent={GREEN}
          icon="emoji_events"
          sub="Lowest long-term DPD"
        />
      </div>

      <SectionCard title="Vintage Cohort Matrix" badge={rows.length} padding={false}>
        {/* FilterBar lives inside the card, above the table */}
        <div style={{ padding: '12px 18px 0' }}>
          <FilterBar onReset={() => setProduct('')}>
            <select value={product} onChange={e => setProduct(e.target.value)} style={filterInputStyle}>
              <option value="">All products</option>
              <option value="Salary Loan">Salary Loan</option>
              <option value="Business Loan">Business Loan</option>
              <option value="Personal Loan">Personal Loan</option>
            </select>
            <button
              onClick={load}
              style={{ height: 32, padding: '0 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
            >Apply</button>
          </FilterBar>
        </div>

        {/* Custom table — cells need per-value backgrounds */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                  Booking Month
                </th>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                  Count
                </th>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                  PAR30 at 1m
                </th>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                  PAR30 at 3m
                </th>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                  PAR30 at 6m
                </th>
                <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                  PAR30 at 12m
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows count={8} />
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13, borderBottom: '1px solid var(--bdr)' }}>
                    No vintage data found
                  </td>
                </tr>
              ) : (
                rows.map((row, idx) => (
                  <tr
                    key={row.booking_month}
                    style={{ background: idx % 2 === 0 ? 'transparent' : 'transparent' }}
                    onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: NAVY }}>{row.booking_month}</span>
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                        {fmtNum(row.cohort_count)}
                      </span>
                    </td>
                    <ParCell value={row.par30_1m} />
                    <ParCell value={row.par30_3m} />
                    <ParCell value={row.par30_6m} />
                    <ParCell value={row.par30_12m} />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>PAR30 colour guide:</span>
          {([
            { label: '< 5%',   bg: 'rgba(22,163,74,.10)',  color: GREEN },
            { label: '5–15%',  bg: 'rgba(217,119,6,.10)',  color: AMBER },
            { label: '> 15%',  bg: 'rgba(192,0,0,.10)',    color: RED   },
            { label: 'N/A',    bg: 'transparent',          color: 'var(--txt3)' },
          ] as const).map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 24, height: 14, borderRadius: RADIUS.xs, background: item.bg, border: '1px solid var(--bdr)' }} />
              <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: item.color }}>{item.label}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    </Page>
  )
}
