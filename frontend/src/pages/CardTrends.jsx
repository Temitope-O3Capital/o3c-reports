import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { BarChartCard, LineChartCard, fmtNum, pct } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem, toISO, presetRange } from '../components/FilterBar.jsx'
import PageShell from '../components/PageShell.jsx'

function initRange() {
  const [f, t] = presetRange('year', toISO(new Date()))
  return { dateFrom: f, dateTo: t, preset: 'year' }
}

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

function KPI({ label, value, sub, icon, accent = '#0E2841' }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}14` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-1))' }}>
        {value ?? '—'}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

function RateBar({ rate }) {
  const r = Number(rate || 0)
  const color = r >= 70 ? '#059669' : r >= 40 ? '#D97706' : '#C00000'
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgb(var(--bg-subtle))' }}>
        <div style={{ width: `${Math.min(r, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span className="text-xs font-mono font-semibold tabular-nums" style={{ color, minWidth: 38, textAlign: 'right' }}>
        {r.toFixed(1)}%
      </span>
    </div>
  )
}

export default function CardTrends() {
  const init = initRange()
  const [dateFrom,   setDateFrom]   = useState(init.dateFrom)
  const [dateTo,     setDateTo]     = useState(init.dateTo)
  const [preset,     setPreset]     = useState(init.preset)
  const [product,    setProduct]    = useState('')

  const [kpis,       setKpis]       = useState(null)
  const [issuance,   setIssuance]   = useState([])
  const [health,     setHealth]     = useState([])
  const [statusDist, setStatusDist] = useState([])
  const [byProduct,  setByProduct]  = useState([])
  const [byProgram,  setByProgram]  = useState([])
  const [allProducts, setAllProducts] = useState([])  // full product list for filter
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [dataSource, setDataSource] = useState(null)

  /* Load full product list once — independent of filters */
  useEffect(() => {
    apiFetch('/api/card-trends/by-product')
      .then(r => setAllProducts((r?.data || []).map(row => row['Product Name'] || row.Product_Name || '').filter(Boolean)))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const p = new URLSearchParams()
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to',   dateTo)
    if (product)  p.set('product',   product)
    const qs = p.toString() ? `?${p}` : ''

    // by-product and by-program use date filter only (not product — they ARE the product breakdown)
    const dp = new URLSearchParams()
    if (dateFrom) dp.set('date_from', dateFrom)
    if (dateTo)   dp.set('date_to',   dateTo)
    const dQs = dp.toString() ? `?${dp}` : ''

    const results = await Promise.allSettled([
      apiFetch(`/api/card-trends/kpis${qs}`),
      apiFetch(`/api/card-trends/issuance-trend${qs}`),
      apiFetch(`/api/card-trends/portfolio-health${qs}`),
      apiFetch(`/api/card-trends/status-distribution${qs}`),
      apiFetch(`/api/card-trends/by-product${dQs}`),
      apiFetch(`/api/card-trends/by-program${dQs}`),
    ])

    const val = (r, fb = {}) => r.status === 'fulfilled' ? (r.value || fb) : fb
    const [k, is, h, sd, bp, pg] = results

    setKpis(val(k).data        || {})
    setDataSource(val(k).data_source || null)
    setIssuance(val(is).data   || [])
    setHealth(val(h).data      || [])
    setStatusDist(val(sd).data || [])
    setByProduct(val(bp).data  || [])
    setByProgram(val(pg).data  || [])

    if (results.every(r => r.status === 'rejected'))
      setError('Failed to load data. Please try again.')
    setLoading(false)
  }, [dateFrom, dateTo, product])

  useEffect(() => { load() }, [load])

  function handleDateChange(f, t, p) { setDateFrom(f); setDateTo(t); setPreset(p) }

  const d = kpis || {}

  return (
    <PageShell
      title="Card Portfolio"
      subtitle="Issuance trends, portfolio health and product breakdown"
      source={dataSource}
      error={error}
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          <DateRangePicker
            dateFrom={dateFrom}
            dateTo={dateTo}
            preset={preset}
            onChange={handleDateChange}
          />
          <FilterChip label={product || 'All Products'} active={!!product} onClear={() => setProduct('')}>
            <DropItem label="All Products" selected={!product} onClick={() => setProduct('')} />
            {allProducts.map(n => (
              <DropItem key={n} label={n} selected={product === n} onClick={() => setProduct(n)} />
            ))}
          </FilterChip>
        </div>
      }
    >

      {/* ── Section 1: Portfolio KPIs ── */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <KPI label="Total Issued"      value={fmtNum(d.total_issued)}    icon="credit_card"    accent="#0E2841" />
        <KPI label="Active"            value={fmtNum(d.active)}          icon="check_circle"   accent="#059669" sub={`${pct(d.activation_rate)} activation`} />
        <KPI label="Inactive"          value={fmtNum(d.inactive)}        icon="do_not_disturb" accent="#94A3B8" />
        <KPI label="Terminated"        value={fmtNum(d.terminated)}      icon="cancel"         accent="#C00000" />
        <KPI label="Legal / Suspended" value={fmtNum(d.legal_suspended)} icon="gavel"          accent="#7C3AED" />
        <KPI label="Issued This Month" value={fmtNum(d.issued_mtd)}      icon="add_card"       accent="#D97706" />
      </div>

      {/* ── Section 2: Issuance Trend + Status Mix ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <LineChartCard
            title="Monthly Card Issuance"
            subtitle={product ? `Product: ${product}` : 'All products'}
            data={issuance}
            xKey="month"
            lines={[{ key: 'issued', label: 'Cards Issued', color: '#0E2841' }]}
            height={260}
          />
        </div>

        {/* Status mix panel */}
        <div className="card p-5 flex flex-col">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>
            Portfolio Status Mix
          </p>
          {loading ? (
            <div className="flex justify-center py-8"><div className="spinner" /></div>
          ) : statusDist.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No data</p>
          ) : (() => {
            const total = statusDist.reduce((s, r) => s + Number(r.count || 0), 0)
            return (
              <div className="space-y-3 flex-1">
                {statusDist.map((row, i) => {
                  const share = total > 0 ? Number(row.count) / total * 100 : 0
                  const color = statusColor(row.status)
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full" style={{ background: color }} />
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
                })}
              </div>
            )
          })()}
        </div>
      </div>

      {/* ── Section 3: Active vs Inactive by issuance cohort ── */}
      <div className="mt-4">
        <BarChartCard
          title="Active vs Inactive — by Issuance Month"
          subtitle={`${product ? `Product: ${product} · ` : ''}Current status of cards grouped by when they were issued`}
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

      {/* ── Section 4: Card Program (BLINK) breakdown ── */}
      {byProgram.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <span className="material-symbols-rounded text-[18px]" style={{ color: 'rgb(var(--navy))' }}>credit_score</span>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Card Program Breakdown</p>
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
                    <td className="font-medium text-slate-800 dark:text-slate-200">{row.program || '—'}</td>
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

      {/* ── Section 5: Product breakdown ── */}
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
                  <th className="text-right">Total Issued</th>
                  <th className="text-right">Active</th>
                  <th className="text-right">Inactive</th>
                  <th className="text-right">Activation Rate</th>
                </tr>
              </thead>
              <tbody>
                {byProduct.map((row, i) => {
                  const name = row['Product Name'] || row.Product_Name || '—'
                  return (
                    <tr key={i}
                      className={product === name ? 'bg-primary/5 dark:bg-primary/10' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setProduct(product === name ? '' : name)}
                    >
                      <td className="font-medium text-slate-800 dark:text-slate-200">
                        <div className="flex items-center gap-2">
                          {product === name && <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
                          {name}
                        </div>
                      </td>
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
          {!product && <p className="text-xs text-slate-400 px-6 py-3">Click any row to filter all charts by that product</p>}
        </div>
      )}
    </PageShell>
  )
}
