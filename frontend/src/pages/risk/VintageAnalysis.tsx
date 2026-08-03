import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, ExpandableFilterBar, ErrBanner, Sk, DateFilter } from '../../components/UI'
import type { FilterGroupDef } from '../../components/UI'
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
    <td style={{ padding: '10px 16px', textAlign: 'right', background: s.bg, borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: s.color }}>{s.text}</span>
    </td>
  )
}

// ── Sparkline: div-based bar chart for 4 time points ─────────────────────────

function Sparkline({ values }: { values: (number | null)[] }) {
  const known = values.filter((v): v is number => v !== null)
  if (!known.length) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>—</span>

  const max = Math.max(...known, 1)
  // trend arrow based on first vs last known value
  const first = known[0]
  const last  = known[known.length - 1]
  const arrow = last > first + 0.5 ? '↑' : last < first - 0.5 ? '↓' : '→'
  const arrowColor = arrow === '↑' ? RED : arrow === '↓' ? GREEN : AMBER

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3 }}>
      {values.map((v, i) => {
        const h = v !== null ? Math.max(4, Math.round((v / max) * 28)) : 4
        const bg = v === null ? 'var(--bdr)' : v < 5 ? GREEN : v <= 15 ? AMBER : RED
        return (
          <div
            key={i}
            title={v !== null ? `${fmtPct(v, 1)}` : 'N/A'}
            style={{ width: 8, height: h, borderRadius: 2, background: bg, transition: 'height 0.2s' }}
          />
        )
      })}
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: arrowColor, marginLeft: 4, lineHeight: 1 }}>{arrow}</span>
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
          <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }}><Sk h={14} w={56} /></td>
          <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }} />
        </tr>
      ))}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VintageAnalysis() {
  const navigate = useNavigate()
  const [rows,      setRows]      = useState<VintageRow[]>([])
  const [kpis,      setKpis]      = useState<VintageKPIs | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [fProducts, setFProducts] = useState(new Set<string>())
  const [search,    setSearch]    = useState('')
  const [dateFrom,  setDateFrom]  = useState(monthStart())
  const [dateTo,    setDateTo]    = useState(today())

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback(() => {
    const p = new URLSearchParams()
    if (fProducts.size) p.set('product', [...fProducts].join(','))
    if (dateFrom) p.set('from', dateFrom)
    if (dateTo)   p.set('to', dateTo)
    return p.toString()
  }, [fProducts, dateFrom, dateTo])

  const load = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const [vintageRes, kpiRes] = await Promise.all([
        apiFetch<{ data: VintageRow[] }>(`/api/risk/vintage?${buildQS()}`, { signal: abortRef.current.signal }),
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
  useLiveData(load, { topics: ['loans'] })

  const kpiLoading = loading && !kpis

  const filteredRows = useMemo(() =>
    search ? rows.filter(r => r.booking_month.toLowerCase().includes(search.toLowerCase())) : rows,
    [rows, search],
  )

  const avg6m  = kpis?.avg_par30_6m  != null ? fmtPct(kpis.avg_par30_6m,  1) : 'N/A'
  const avg12m = kpis?.avg_par30_12m != null ? fmtPct(kpis.avg_par30_12m, 1) : 'N/A'

  function parAccent(val: number | null | undefined): string {
    if (val == null) return NAVY
    if (val < 5)   return GREEN
    if (val <= 15) return AMBER
    return RED
  }

  // Best: lowest long-term PAR; Worst: highest long-term PAR
  const { bestMonth, worstMonth } = useMemo(() => {
    if (!rows.length) return { bestMonth: null, worstMonth: null }
    const scored = rows
      .map(r => ({ month: r.booking_month, rate: r.par30_12m ?? r.par30_6m }))
      .filter((r): r is { month: string; rate: number } => r.rate !== null)
    if (!scored.length) return { bestMonth: null, worstMonth: null }
    scored.sort((a, b) => a.rate - b.rate)
    return { bestMonth: scored[0].month, worstMonth: scored[scored.length - 1].month }
  }, [rows])

  // Portfolio average row (computed from all data, not filtered)
  const avgRow = useMemo(() => {
    if (!rows.length) return null
    const avg = (key: keyof VintageRow): number | null => {
      const vals = rows.map(r => r[key] as number | null).filter((v): v is number => v !== null)
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null
    }
    return {
      par30_1m:  avg('par30_1m'),
      par30_3m:  avg('par30_3m'),
      par30_6m:  avg('par30_6m'),
      par30_12m: avg('par30_12m'),
      cohort_count: rows.reduce((s, r) => s + r.cohort_count, 0),
    }
  }, [rows])

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
        <KpiCard
          label="Total Cohorts"
          value={loading ? '…' : fmtNum(rows.length)}
          loading={false}
          accent={NAVY}
          icon="calendar_month"
          sub="Booking month cohorts"
        />
        <KpiCard
          label="Avg PAR30 at 6m"
          value={avg6m}
          loading={kpiLoading}
          accent={parAccent(kpis?.avg_par30_6m)}
          icon="monitoring"
          sub="Portfolio 6-month mark"
        />
        <KpiCard
          label="Avg PAR30 at 12m"
          value={avg12m}
          loading={kpiLoading}
          accent={parAccent(kpis?.avg_par30_12m)}
          icon="error_outline"
          sub="Portfolio 12-month mark"
        />
        <KpiCard
          label="Best Vintage"
          value={loading ? '…' : bestMonth ?? 'N/A'}
          loading={false}
          accent={GREEN}
          icon="emoji_events"
          sub="Lowest long-term PAR30"
        />
      </div>

      {/* Worst vintage callout alert */}
      {worstMonth && !loading && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: SP[3],
          padding: `${SP[3]} ${SP[4]}`,
          borderRadius: RADIUS.md,
          background: 'rgba(192,0,0,.07)',
          border: `1px solid ${RED}40`,
          marginBottom: SP[4],
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>warning</span>
          <span style={{ fontSize: TEXT.sm, color: RED, fontWeight: FW.semibold }}>
            Watch: <strong>{worstMonth}</strong> is the worst-performing vintage by PAR30.
          </span>
        </div>
      )}

      <SectionCard title="Vintage Cohort Matrix" badge={filteredRows.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'product',
              label: 'Product',
              options: [
                { value: 'Salary Loan' },
                { value: 'Business Loan' },
                { value: 'Personal Loan' },
              ],
              selected: fProducts,
              onChange: setFProducts,
            } as FilterGroupDef,
          ]}
          onReset={() => { setFProducts(new Set()); setSearch('') }}
          onApply={load}
          resultCount={filteredRows.length}
          totalCount={rows.length}
        />

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Booking Month', 'Count', 'PAR30 at 1m', 'PAR30 at 3m', 'PAR30 at 6m', 'PAR30 at 12m', 'Trend', ''].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: h === 'Booking Month' || h === 'Trend' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows count={8} />
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13, borderBottom: '1px solid var(--bdr)' }}>
                    No vintage data found
                  </td>
                </tr>
              ) : (
                <>
                  {filteredRows.map(row => {
                    const isBest  = row.booking_month === bestMonth
                    const isWorst = row.booking_month === worstMonth
                    const rowBg   = isBest ? 'rgba(22,163,74,.06)' : isWorst ? 'rgba(192,0,0,.05)' : 'transparent'
                    return (
                      <tr
                        key={row.booking_month}
                        style={{ background: rowBg, cursor: 'pointer' }}
                        onClick={() => navigate(`/operations/risk/vintage/${encodeURIComponent(row.booking_month)}`)}
                        onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = isBest ? 'rgba(22,163,74,.12)' : isWorst ? 'rgba(192,0,0,.09)' : 'var(--row-hvr)'}
                        onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = rowBg}
                      >
                        <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: NAVY }}>{row.booking_month}</span>
                            {isBest && (
                              <span style={{ fontSize: 10, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: 'rgba(22,163,74,.15)', color: GREEN }}>BEST</span>
                            )}
                            {isWorst && (
                              <span style={{ fontSize: 10, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: 'rgba(192,0,0,.12)', color: RED }}>WATCH</span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(row.cohort_count)}</span>
                        </td>
                        <ParCell value={row.par30_1m} />
                        <ParCell value={row.par30_3m} />
                        <ParCell value={row.par30_6m} />
                        <ParCell value={row.par30_12m} />
                        <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }}>
                          <Sparkline values={[row.par30_1m, row.par30_3m, row.par30_6m, row.par30_12m]} />
                        </td>
                        <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', textAlign: 'center' }}>
                          <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)' }}>chevron_right</span>
                        </td>
                      </tr>
                    )
                  })}

                  {/* Portfolio Average row — not clickable */}
                  {avgRow && (
                    <tr style={{ background: 'var(--th-bg)', borderTop: `2px solid ${NAVY}30` }}>
                      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY, fontFamily: INTER }}>Portfolio Avg</span>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(avgRow.cohort_count)}</span>
                      </td>
                      <ParCell value={avgRow.par30_1m} />
                      <ParCell value={avgRow.par30_3m} />
                      <ParCell value={avgRow.par30_6m} />
                      <ParCell value={avgRow.par30_12m} />
                      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }}>
                        <Sparkline values={[avgRow.par30_1m, avgRow.par30_3m, avgRow.par30_6m, avgRow.par30_12m]} />
                      </td>
                      <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }} />
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 8 }}>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>Trend:</span>
            {([
              { arrow: '↑', label: 'Worsening', color: RED },
              { arrow: '↓', label: 'Improving',  color: GREEN },
              { arrow: '→', label: 'Stable',     color: AMBER },
            ]).map(t => (
              <div key={t.arrow} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: t.color }}>{t.arrow}</span>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{t.label}</span>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>
    </Page>
  )
}
