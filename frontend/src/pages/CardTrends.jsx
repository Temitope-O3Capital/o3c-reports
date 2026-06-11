import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { BarChartCard, LineChartCard, DonutCard, fmtNum, pct } from '../components/Charts.jsx'
import { FilterChip, DropItem, fmtDate } from '../components/FilterBar.jsx'
import PageShell from '../components/PageShell.jsx'

/* ── Year presets ── */
function yr(y) { return { dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` } }
const YEAR_PRESETS = [
  { label: 'All Time',  dateFrom: '', dateTo: '' },
  { label: '2023',      ...yr(2023) },
  { label: '2024',      ...yr(2024) },
  { label: '2025',      ...yr(2025) },
  { label: '2026',      ...yr(2026) },
  { label: '2024–2026', dateFrom: '2024-01-01', dateTo: '2026-12-31' },
]

/* ── Status colour map ── */
const STATUS_COLORS = {
  open:         '#059669',
  active:       '#059669',
  terminated:   '#C00000',
  'legal acti': '#7C3AED',
  inactive:     '#94A3B8',
  suspended:    '#D97706',
  hot:          '#F59E0B',
  undefined:    '#CBD5E1',
}
function statusColor(s) {
  return STATUS_COLORS[(s || '').toLowerCase()] || '#94A3B8'
}

/* ── KPI card ── */
function KPI({ label, value, sub, icon, accent = '#0E2841', highlight }) {
  return (
    <div className="card p-5" style={highlight ? { borderLeft: `3px solid ${accent}` } : {}}>
      <div className="flex items-start justify-between mb-3">
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}14` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-1))' }}>{value ?? '—'}</p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

/* ── Inline progress bar for tables ── */
function RateBar({ rate }) {
  const r = Number(rate || 0)
  const color = r >= 70 ? '#059669' : r >= 40 ? '#D97706' : '#C00000'
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgb(var(--bg-subtle))' }}>
        <div style={{ width: `${Math.min(r, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span className="text-xs font-mono font-semibold tabular-nums" style={{ color, minWidth: 38, textAlign: 'right' }}>{r.toFixed(1)}%</span>
    </div>
  )
}

export default function CardTrends() {
  /* ── Filter state ── */
  const [dateFrom,     setDateFrom]     = useState('')
  const [dateTo,       setDateTo]       = useState('')
  const [preset,       setPreset]       = useState('All Time')
  const [product,      setProduct]      = useState('')
  const [cardProgram,  setCardProgram]  = useState('')

  /* ── Data state ── */
  const [kpis,         setKpis]         = useState(null)
  const [issuance,     setIssuance]     = useState([])
  const [health,       setHealth]       = useState([])
  const [statusDist,   setStatusDist]   = useState([])
  const [byProduct,    setByProduct]    = useState([])
  const [byProgram,    setByProgram]    = useState([])
  const [programs,     setPrograms]     = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [dataSource,   setDataSource]   = useState(null)

  /* Load filter options once */
  useEffect(() => {
    apiFetch('/api/card-trends/programs').then(r => setPrograms(r?.data || [])).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const p = new URLSearchParams()
    if (dateFrom)    p.set('date_from',    dateFrom)
    if (dateTo)      p.set('date_to',      dateTo)
    if (product)     p.set('product',      product)
    if (cardProgram) p.set('card_program', cardProgram)
    const qs = p.toString() ? `?${p}` : ''

    const bpParams = new URLSearchParams()
    if (dateFrom)    bpParams.set('date_from', dateFrom)
    if (dateTo)      bpParams.set('date_to',   dateTo)
    if (cardProgram) bpParams.set('card_program', cardProgram)
    const bpQs = bpParams.toString() ? `?${bpParams}` : ''

    const pgParams = new URLSearchParams()
    if (dateFrom) pgParams.set('date_from', dateFrom)
    if (dateTo)   pgParams.set('date_to',   dateTo)
    const pgQs = pgParams.toString() ? `?${pgParams}` : ''

    // allSettled so one failing endpoint (e.g. by-program before sync runs) doesn't kill the page
    const results = await Promise.allSettled([
      apiFetch(`/api/card-trends/kpis${qs}`),
      apiFetch(`/api/card-trends/issuance-trend${qs}`),
      apiFetch(`/api/card-trends/portfolio-health${qs}`),
      apiFetch(`/api/card-trends/status-distribution${qs}`),
      apiFetch(`/api/card-trends/by-product${bpQs}`),
      apiFetch(`/api/card-trends/by-program${pgQs}`),
    ])

    const ok  = (r, fb = {}) => r.status === 'fulfilled' ? r.value : fb
    const [k, is, h, sd, bp, pg] = results

    const kData = ok(k, {}).data || {}
    setKpis(kData)
    setDataSource(ok(k, {}).data_source || null)
    setIssuance(ok(is, {}).data   || [])
    setHealth(ok(h, {}).data      || [])
    setStatusDist(ok(sd, {}).data || [])
    setByProduct(ok(bp, {}).data  || [])
    setByProgram(ok(pg, {}).data  || [])

    const failed = results.filter(r => r.status === 'rejected')
    if (failed.length === results.length) {
      setError('Failed to load card data. Please try again.')
    }
    setLoading(false)
  }, [dateFrom, dateTo, product, cardProgram])

  useEffect(() => { load() }, [load])

  function applyPreset(p) { setPreset(p.label); setDateFrom(p.dateFrom); setDateTo(p.dateTo) }

  const d = kpis || {}
  const rangeLabel = dateFrom && dateTo ? `${dateFrom} – ${dateTo}` : 'All time'

  /* Donut data: map status rows to {name, value, fill} */
  const donutData = statusDist.map(r => ({
    name:  r.status || 'Unknown',
    value: Number(r.count || 0),
    fill:  statusColor(r.status),
  }))

  return (
    <PageShell
      title="Card Portfolio"
      subtitle="Issuance trends, portfolio health, program and product breakdown"
      source={dataSource}
      error={error}
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period — year presets only, no calendar picker conflict */}
          <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'rgb(var(--bg-subtle))', border: '1px solid rgb(var(--border) / 0.1)' }}>
            {YEAR_PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all"
                style={preset === p.label ? {
                  background: 'rgb(var(--bg-surface))',
                  color: 'rgb(var(--navy))',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
                } : {
                  color: 'rgb(var(--fg-3))',
                  background: 'transparent'
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Card Program (BLINK) */}
          <FilterChip
            label={cardProgram ? cardProgram.slice(0, 22) + (cardProgram.length > 22 ? '…' : '') : 'Card Program'}
            active={!!cardProgram}
            onClear={() => setCardProgram('')}
          >
            <DropItem label="All Programs" selected={!cardProgram} onClick={() => setCardProgram('')} />
            {programs.map(pg => (
              <DropItem key={pg} label={pg} selected={cardProgram === pg} onClick={() => setCardProgram(pg)} />
            ))}
          </FilterChip>

          {/* Product */}
          <FilterChip label={product || 'Product'} active={!!product} onClear={() => setProduct('')}>
            <DropItem label="All Products" selected={!product} onClick={() => setProduct('')} />
            {byProduct.map(r => {
              const n = r['Product Name'] || r.Product_Name || ''
              return n ? <DropItem key={n} label={n} selected={product === n} onClick={() => setProduct(n)} /> : null
            })}
          </FilterChip>
        </div>
      }
    >

      {/* ── Section 1: Portfolio KPIs ── */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <KPI label="Total Issued"     value={fmtNum(d.total_issued)}   icon="credit_card"   accent="#0E2841" highlight />
        <KPI label="Active"           value={fmtNum(d.active)}         icon="check_circle"  accent="#059669" sub={`${pct(d.activation_rate)} activation`} highlight />
        <KPI label="Inactive"         value={fmtNum(d.inactive)}       icon="do_not_disturb" accent="#94A3B8" />
        <KPI label="Terminated"       value={fmtNum(d.terminated)}     icon="cancel"        accent="#C00000" />
        <KPI label="Legal / Suspended" value={fmtNum(d.legal_suspended)} icon="gavel"       accent="#7C3AED" />
        <KPI label="Issued This Month" value={fmtNum(d.issued_mtd)}    icon="add_card"      accent="#D97706" />
      </div>

      {/* ── Section 2: Issuance Trend + Status Donut ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <LineChartCard
            title="Monthly Card Issuance"
            subtitle={rangeLabel}
            data={issuance}
            xKey="month"
            lines={[{ key: 'issued', label: 'Cards Issued', color: '#0E2841' }]}
            height={260}
          />
        </div>
        <div className="card p-5 flex flex-col">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>
            Portfolio Status Mix
          </p>
          {loading ? (
            <div className="flex justify-center py-8"><div className="spinner" /></div>
          ) : statusDist.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No data</p>
          ) : (
            <div className="space-y-2.5 flex-1 overflow-y-auto">
              {(() => {
                const total = statusDist.reduce((s, r) => s + Number(r.count || 0), 0)
                return statusDist.map((row, i) => {
                  const share = total > 0 ? (Number(row.count) / total * 100) : 0
                  const color = statusColor(row.status)
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{row.status || 'Unknown'}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono tabular-nums text-slate-500">{Number(row.count).toLocaleString()}</span>
                          <span className="font-semibold" style={{ color }}>{share.toFixed(1)}%</span>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgb(var(--bg-subtle))' }}>
                        <div style={{ width: `${share}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.6s ease' }} />
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>
      </div>

      {/* ── Section 3: Portfolio Health — Active vs Inactive by cohort ── */}
      <div className="mt-4">
        <BarChartCard
          title="Portfolio Health — Active vs Inactive by Issuance Month"
          subtitle={`${rangeLabel} · each bar shows current status of cards issued that month`}
          data={health}
          xKey="month"
          bars={[
            { key: 'active',   label: 'Active',   color: '#059669' },
            { key: 'inactive', label: 'Inactive', color: '#C00000' },
          ]}
          height={300}
          stacked
        />
      </div>

      {/* ── Section 4: Card Program (BLINK) Breakdown ── */}
      {byProgram.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-rounded text-[18px]" style={{ color: 'rgb(var(--navy))' }}>credit_score</span>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Card Program Breakdown</p>
              <span className="badge badge-grey text-[10px]">BLINK & all programs</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Card Program</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Active</th>
                  <th className="text-right">Inactive</th>
                  <th className="text-right">Activation Rate</th>
                </tr>
              </thead>
              <tbody>
                {byProgram.map((row, i) => (
                  <tr key={i}>
                    <td className="font-medium text-slate-800 dark:text-slate-200 max-w-xs truncate">{row.program || '—'}</td>
                    <td className="text-right font-mono tabular-nums">{Number(row.total || 0).toLocaleString()}</td>
                    <td className="text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">{Number(row.active || 0).toLocaleString()}</td>
                    <td className="text-right font-mono tabular-nums text-slate-500">{Number(row.inactive || 0).toLocaleString()}</td>
                    <td className="text-right"><RateBar rate={row.activation_rate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Section 5: Product Breakdown ── */}
      {byProduct.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Product Breakdown</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Active</th>
                  <th className="text-right">Inactive</th>
                  <th className="text-right">Activation Rate</th>
                </tr>
              </thead>
              <tbody>
                {byProduct.map((row, i) => {
                  const name = row['Product Name'] || row.Product_Name || '—'
                  return (
                    <tr key={i}>
                      <td className="font-medium text-slate-800 dark:text-slate-200">{name}</td>
                      <td className="text-right font-mono tabular-nums">{Number(row.total || 0).toLocaleString()}</td>
                      <td className="text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">{Number(row.active || 0).toLocaleString()}</td>
                      <td className="text-right font-mono tabular-nums text-slate-500">{Number(row.inactive || 0).toLocaleString()}</td>
                      <td className="text-right"><RateBar rate={row.activation_rate} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageShell>
  )
}
