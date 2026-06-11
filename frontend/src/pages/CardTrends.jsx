import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { BarChartCard, LineChartCard, fmtNum, pct } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem } from '../components/FilterBar.jsx'
import PageShell from '../components/PageShell.jsx'

const PRODUCTS = ['PREP', 'Amex Naira', 'Amex USD', 'Classic Accounts', 'Prestige Accounts', 'Platinum Accounts', 'Business Accounts']

/* Year preset helpers */
function yearRange(y) {
  return { dateFrom: `${y}-01-01`, dateTo: `${y}-12-31` }
}
const YEAR_PRESETS = [
  { label: 'All Time',   dateFrom: '',           dateTo: '' },
  { label: '2024',       ...yearRange(2024) },
  { label: '2025',       ...yearRange(2025) },
  { label: '2026',       ...yearRange(2026) },
  { label: '2024–2026',  dateFrom: '2024-01-01', dateTo: '2026-12-31' },
]

function KPI({ label, value, sub, icon, accent = '#0E2841' }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${accent}14` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-1))' }}>{value ?? '—'}</p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

export default function CardTrends() {
  const [product,    setProduct]    = useState('')
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  const [preset,     setPreset]     = useState('All Time')

  const [kpis,       setKpis]       = useState(null)
  const [creation,   setCreation]   = useState([])
  const [cohort,     setCohort]     = useState([])
  const [byProduct,  setByProduct]  = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [dataSource, setDataSource] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const p = new URLSearchParams()
    if (product)  p.set('product',   product)
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to',   dateTo)
    const qs = p.toString() ? `?${p}` : ''

    try {
      const [k, cr, co, bp] = await Promise.all([
        apiFetch(`/api/card-trends/kpis${qs}`),
        apiFetch(`/api/card-trends/creation-trend${qs}`),
        apiFetch(`/api/card-trends/status-by-cohort${qs}`),
        apiFetch(`/api/card-trends/by-product${qs}`),
      ])
      setKpis(k.data || {}); setDataSource(k.data_source)
      setCreation(cr.data || [])
      setCohort(co.data || [])
      setByProduct(bp.data || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [product, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  function applyPreset(p) {
    setPreset(p.label)
    setDateFrom(p.dateFrom)
    setDateTo(p.dateTo)
  }

  const d = kpis || {}
  const rangeLabel = dateFrom && dateTo ? `${dateFrom} – ${dateTo}` : 'All time'

  return (
    <PageShell
      title="Card Trends"
      subtitle="Issuance, activation and deactivation over time"
      source={dataSource}
      error={error}
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          {/* Year / date range picker */}
          <FilterChip
            label={preset}
            active={!!dateFrom || !!dateTo}
            onClear={() => applyPreset(YEAR_PRESETS[0])}
          >
            {YEAR_PRESETS.map(p => (
              <DropItem key={p.label} label={p.label} selected={preset === p.label} onClick={() => applyPreset(p)} />
            ))}
          </FilterChip>

          {/* Custom date range */}
          <DateRangePicker
            dateFrom={dateFrom}
            dateTo={dateTo}
            preset={null}
            onChange={(f, t) => { setDateFrom(f); setDateTo(t); setPreset('Custom') }}
          />

          {/* Product filter */}
          <FilterChip label={product || 'All Products'} active={!!product} onClear={() => setProduct('')}>
            <DropItem label="All Products" selected={!product} onClick={() => setProduct('')} />
            {PRODUCTS.map(p => <DropItem key={p} label={p} selected={product === p} onClick={() => setProduct(p)} />)}
          </FilterChip>
        </div>
      }
    >
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPI label="Total Issued"      value={fmtNum(d.total_issued)}      icon="credit_card"  accent="#0E2841" sub={rangeLabel} />
        <KPI label="Active Cards"      value={fmtNum(d.total_active)}      icon="check_circle" accent="#059669" sub={`${pct(d.activation_rate)} activation rate`} />
        <KPI label="Deactivated"       value={fmtNum(d.total_deactivated)} icon="cancel"       accent="#C00000" />
        <KPI label="Issued This Month" value={fmtNum(d.created_mtd)}       icon="add_card"     accent="#D97706" />
      </div>

      {/* Creation Trend */}
      <div className="mt-4">
        <LineChartCard
          title="Monthly Card Issuance"
          subtitle={`${product ? `${product} · ` : ''}${rangeLabel}`}
          data={creation}
          xKey="month"
          lines={[{ key: 'cards_created', label: 'Cards Issued', color: '#0E2841' }]}
          height={280}
        />
      </div>

      {/* Active vs Deactivated by Cohort */}
      <div className="mt-4">
        <BarChartCard
          title="Issued vs Active vs Deactivated — by Month"
          subtitle={`${product ? `${product} · ` : ''}${rangeLabel} · each bar shows current status of cards issued that month`}
          data={cohort}
          xKey="month"
          bars={[
            { key: 'active',      label: 'Active',      color: '#059669' },
            { key: 'deactivated', label: 'Deactivated', color: '#C00000' },
          ]}
          height={300}
          stacked
        />
      </div>

      {/* By-product breakdown table */}
      {byProduct.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Product Breakdown
              {(dateFrom || dateTo) && <span className="ml-2 text-xs font-normal text-slate-400">{rangeLabel}</span>}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Total Issued</th>
                  <th className="text-right">Active</th>
                  <th className="text-right">Deactivated</th>
                  <th className="text-right">Activation Rate</th>
                </tr>
              </thead>
              <tbody>
                {byProduct.map((row, i) => {
                  const name = row['Product Name'] || row['Product_Name'] || '—'
                  const rate = Number(row.activation_rate || 0)
                  return (
                    <tr key={i}>
                      <td className="font-medium text-slate-800 dark:text-slate-200">{name}</td>
                      <td className="text-right font-mono tabular-nums">{Number(row.total || 0).toLocaleString()}</td>
                      <td className="text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">{Number(row.active || 0).toLocaleString()}</td>
                      <td className="text-right font-mono tabular-nums text-red-600 dark:text-red-400">{Number(row.deactivated || 0).toLocaleString()}</td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgb(var(--bg-subtle))' }}>
                            <div style={{ width: `${Math.min(rate, 100)}%`, height: '100%', background: rate >= 70 ? '#059669' : rate >= 40 ? '#D97706' : '#C00000', borderRadius: 3 }} />
                          </div>
                          <span className="text-xs font-mono tabular-nums font-semibold" style={{ color: rate >= 70 ? '#059669' : rate >= 40 ? '#D97706' : '#C00000' }}>
                            {rate.toFixed(1)}%
                          </span>
                        </div>
                      </td>
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
