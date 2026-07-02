import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, n, today, yearStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DateFilter,
  AreaChartCard, BarChartCard,
  ErrBanner, ExportBtn, Sk, NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend,
} from 'recharts'

/* ── Status colour ───────────────────────────────────────────── */
const STATUS_COLOR: Record<string, string> = {
  open:         GREEN,
  active:       GREEN,
  terminated:   RED,
  'legal acti': '#7C3AED',
  inactive:     '#94A3B8',
  suspended:    AMBER,
  closed:       '#475569',
  hot:          '#F59E0B',
}
function statusColor(s: string) {
  return STATUS_COLOR[(s || '').toLowerCase()] ?? '#94A3B8'
}

/* ── Rate progress bar ───────────────────────────────────────── */
function RateBar({ rate }: { rate: number }) {
  const r = Number(rate || 0)
  const color = r >= 70 ? GREEN : r >= 40 ? AMBER : RED
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
        <div style={{ width: `${Math.min(r, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span className="kpi-number text-[12px] font-semibold" style={{ color, minWidth: 38, textAlign: 'right' }}>
        {r.toFixed(1)}%
      </span>
    </div>
  )
}

/* ── Status Distribution Panel ───────────────────────────────── */
function StatusDistPanel({ data, loading }: { data: any[]; loading: boolean }) {
  const total = data.reduce((s, r) => s + n(r.count), 0)
  return (
    <SectionCard title="Portfolio Status Mix" subtitle="Current status of all cards in the selected period">
      <div className="px-5 py-4 space-y-3">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5"><Sk w="w-28" /><Sk h="h-1.5" /></div>
            ))
          : data.length === 0
          ? <p className="text-[13px] py-8 text-center" style={{ color: 'var(--txt2)' }}>No data</p>
          : data.map((row, i) => {
              const share = total > 0 ? n(row.count) / total * 100 : 0
              const color = statusColor(row.status)
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                      <span className="text-[12px] font-medium capitalize" style={{ color: 'var(--txt)' }}>
                        {row.status || 'Unknown'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="kpi-number" style={{ color: 'var(--txt2)' }}>{n(row.count).toLocaleString()}</span>
                      <span className="font-semibold kpi-number" style={{ color }}>{share.toFixed(1)}%</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
                    <div style={{ width: `${share}%`, height: '100%', background: color, borderRadius: 3,
                      transition: 'width 0.6s ease' }} />
                  </div>
                </div>
              )
            })}
      </div>
    </SectionCard>
  )
}

/* ── Stacked Active/Inactive by month ────────────────────────── */
function PortfolioHealthChart({ data, loading }: { data: any[]; loading: boolean }) {
  return (
    <SectionCard title="Active vs Inactive by Issuance Month"
      subtitle="Current card status grouped by the month they were issued">
      <div className="px-5 py-4">
        {loading ? (
          <div className="flex items-end gap-1.5" style={{ height: 280 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${30 + (i % 5) * 14}%` }} />
            ))}
          </div>
        ) : data.length === 0 ? (
          <p className="text-[13px] py-16 text-center" style={{ color: 'var(--txt2)' }}>No data</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 4 }} barSize={14}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                tickFormatter={v => fmtNum(v)} width={44}
                domain={[(dataMin: number) => dataMin < 0 ? Math.floor(dataMin * 1.12) : 0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 10]} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  return (
                    <div className="rounded-lg border px-3 py-2.5 shadow-lg"
                      style={{ background: 'var(--card)', borderColor: 'var(--bdr)', fontSize: 12 }}>
                      <p className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--txt2)' }}>{label}</p>
                      {payload.map((p: any, i: number) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.fill }} />
                          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
                          <span className="font-semibold kpi-number" style={{ color: 'var(--txt)' }}>{fmtNum(p.value)}</span>
                        </div>
                      ))}
                    </div>
                  )
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <Bar dataKey="active"   name="Active"   fill={GREEN}  radius={[2, 2, 0, 0]} stackId="a" />
              <Bar dataKey="inactive" name="Inactive" fill={RED}    radius={[2, 2, 0, 0]} stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </SectionCard>
  )
}

/* ── Main Page ───────────────────────────────────────────────── */
export default function CardsTrends() {
  const [from,       setFrom]       = useState(yearStart())
  const [to,         setTo]         = useState(today())
  const [product,    setProduct]    = useState('')

  const [kpis,       setKpis]       = useState<any>(null)
  const [issuance,   setIssuance]   = useState<any[]>([])
  const [health,     setHealth]     = useState<any[]>([])
  const [statusDist, setStatusDist] = useState<any[]>([])
  const [byProduct,  setByProduct]  = useState<any[]>([])
  const [byProgram,  setByProgram]  = useState<any[]>([])
  const [allProducts, setAllProducts] = useState<string[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [exporting,    setExporting]    = useState(false)
  const [prodSortKey,  setProdSortKey]  = useState<string | null>(null)
  const [prodSortDir,  setProdSortDir]  = useState<'asc' | 'desc'>('asc')

  const toggleProdSort = (key: string) => {
    if (prodSortKey === key) setProdSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setProdSortKey(key); setProdSortDir('asc') }
  }

  /* Load product list once */
  useEffect(() => {
    apiFetch('/api/card-trends/by-product')
      .then(r => setAllProducts(
        (r?.data || []).map((row: any) => row['Product Name'] || '').filter(Boolean)
      ))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const p = new URLSearchParams({ date_from: from, date_to: to })
    if (product) p.set('product', product)
    const qs  = `?${p}`
    const dqs = `?date_from=${from}&date_to=${to}`

    const results = await Promise.allSettled([
      apiFetch(`/api/card-trends/kpis${qs}`),
      apiFetch(`/api/card-trends/issuance-trend${qs}`),
      apiFetch(`/api/card-trends/portfolio-health${qs}`),
      apiFetch(`/api/card-trends/status-distribution${qs}`),
      apiFetch(`/api/card-trends/by-product${dqs}`),
      apiFetch(`/api/card-trends/by-program${dqs}`),
    ])

    const val = (r: PromiseSettledResult<any>, fb: any = {}) =>
      r.status === 'fulfilled' ? (r.value || fb) : fb
    const [k, is, h, sd, bp, pg] = results

    setKpis(val(k).data        || {})
    setIssuance(val(is).data   || [])
    setHealth(val(h).data      || [])
    setStatusDist(val(sd).data || [])
    setByProduct(val(bp).data  || [])
    setByProgram(val(pg).data  || [])

    if (results.every(r => r.status === 'rejected'))
      setError('Failed to load data. Please try again.')
    setLoading(false)
  }, [from, to, product])

  useEffect(() => { load() }, [load])

  const d = kpis || {}

  async function doExport() {
    setExporting(true)
    try {
      const { apiExport } = await import('../../lib/api')
      await apiExport(`/api/card-trends/by-product?date_from=${from}&date_to=${to}`, 'card_trends')
    } finally { setExporting(false) }
  }

  return (
    <Page dept="Cards & Ops" title="Card Trends"
      subtitle="Issuance trends, portfolio health, and product breakdown"
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          <ExportBtn onClick={doExport} loading={exporting} />
          {/* Product filter */}
          {allProducts.length > 0 && (
            <div className="relative">
              <select
                value={product}
                onChange={e => setProduct(e.target.value)}
                className="appearance-none pl-3 pr-8 py-1.5 rounded-lg border text-[12px] font-medium outline-none cursor-pointer"
                style={{ background: 'var(--input-bg)', borderColor: product ? NAVY : 'var(--input-bdr)', color: 'var(--txt)' }}>
                <option value="">All Products</option>
                {allProducts.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <span className="material-symbols-rounded text-[14px] absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--txt2)' }}>
                expand_more
              </span>
            </div>
          )}
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
        </div>
      }>
      <ErrBanner msg={error} />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <KpiCard label="Total Issued"       value={fmtNum(d.total_issued)}    icon="credit_card"    accent={NAVY}    loading={loading} />
        <KpiCard label="Active"             value={fmtNum(d.active)}          icon="check_circle"   accent={GREEN}
          sub={`${fmtPct(d.activation_rate)} activation`} loading={loading} />
        <KpiCard label="Inactive"           value={fmtNum(d.inactive)}        icon="do_not_disturb" accent="#94A3B8" loading={loading} />
        <KpiCard label="Terminated"         value={fmtNum(d.terminated)}      icon="cancel"         accent={RED}     loading={loading} />
        <KpiCard label="Legal / Suspended"  value={fmtNum(d.legal_suspended)} icon="gavel"          accent="#7C3AED" loading={loading} />
        <KpiCard label="Issued This Month"  value={fmtNum(d.issued_mtd)}      icon="add_card"       accent={AMBER}   loading={loading} />
      </div>

      {/* Issuance Trend + Status Mix */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Card Issuance"
            subtitle={product ? `Product: ${product}` : 'All products'}
            data={issuance}
            xKey="month"
            areaKey="issued"
            color={NAVY}
            height={260}
            loading={loading}
          />
        </div>
        <StatusDistPanel data={statusDist} loading={loading} />
      </div>

      {/* Active vs Inactive by Issuance Month */}
      <div className="mt-4">
        <PortfolioHealthChart data={health} loading={loading} />
      </div>

      {/* Card Program Breakdown */}
      {(byProgram.length > 0 || loading) && (
        <div className="mt-4">
          <SectionCard title="Card Program Breakdown"
            subtitle="Activation performance by card program (BLINK, etc.)">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    {['Card Program', 'Total', 'Active', 'Inactive', 'Activation Rate'].map((col, i) => (
                      <th key={col}
                        className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap ${i > 0 ? 'text-right' : 'text-left'}`}
                        style={{ background: 'var(--th-bg)', color: 'var(--txt2)', fontFamily: "'Inter', ui-sans-serif, sans-serif", fontSize: 10 }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: 3 }).map((_, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--bdr)' }}>
                          {Array.from({ length: 5 }).map((_, j) => <td key={j} className="px-5 py-3.5"><Sk /></td>)}
                        </tr>
                      ))
                    : byProgram.map((row, i) => (
                        <tr key={i} className="transition-colors"
                          style={{ borderTop: '1px solid var(--bdr)' }}>
                          <td className="px-5 py-3 font-semibold" style={{ color: 'var(--txt)' }}>{row.program || '—'}</td>
                          <td className="px-5 py-3 text-right kpi-number" style={{ color: 'var(--txt)' }}>{n(row.total).toLocaleString()}</td>
                          <td className="px-5 py-3 text-right kpi-number font-semibold" style={{ color: GREEN }}>{n(row.active).toLocaleString()}</td>
                          <td className="px-5 py-3 text-right kpi-number" style={{ color: 'var(--txt2)' }}>{n(row.inactive).toLocaleString()}</td>
                          <td className="px-5 py-3 text-right"><RateBar rate={n(row.activation_rate)} /></td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}

      {/* Product Breakdown Table */}
      <div className="mt-4">
        <SectionCard title="Product Breakdown"
          subtitle="Click a row to filter all charts by that product">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  {([['Product','Product Name','left'],['Total Issued','total','right'],['Active','active','right'],['Inactive','inactive','right'],['Activation Rate','activation_rate','right']] as [string,string,string][]).map(([col, k, align]) => (
                    <th key={col}
                      className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap text-${align}`}
                      style={{ background: 'var(--th-bg)', color: prodSortKey === k ? 'var(--txt)' : 'var(--txt2)', cursor: 'pointer' }}
                      onClick={() => toggleProdSort(k)}>
                      {col}<span style={{ marginLeft: 3, color: '#C00000', opacity: prodSortKey === k ? 1 : 0.3 }}>{prodSortKey === k ? (prodSortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                        {Array.from({ length: 5 }).map((_, j) => <td key={j} className="px-5 py-3.5"><Sk /></td>)}
                      </tr>
                    ))
                  : (() => {
                      const sortedByProduct = prodSortKey
                        ? [...byProduct].sort((a, b) => {
                            const va = (a as any)[prodSortKey] ?? ''
                            const vb = (b as any)[prodSortKey] ?? ''
                            const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))
                            return prodSortDir === 'asc' ? cmp : -cmp
                          })
                        : byProduct
                      return sortedByProduct.map((row, i) => {
                      const name    = row['Product Name'] || '—'
                      const active  = product === name
                      return (
                        <tr key={i}
                          className="transition-colors cursor-pointer"
                          style={{
                            borderTop: '1px solid var(--bdr)',
                            background: active ? `${NAVY}06` : undefined,
                          }}
                          onClick={() => setProduct(product === name ? '' : name)}>
                          <td className="px-5 py-3 font-semibold" style={{ color: 'var(--txt)' }}>
                            <div className="flex items-center gap-2">
                              {active && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: NAVY }} />}
                              {name}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right kpi-number" style={{ color: 'var(--txt)' }}>{n(row.total).toLocaleString()}</td>
                          <td className="px-5 py-3 text-right kpi-number font-semibold" style={{ color: GREEN }}>{n(row.active).toLocaleString()}</td>
                          <td className="px-5 py-3 text-right kpi-number" style={{ color: 'var(--txt2)' }}>{n(row.inactive).toLocaleString()}</td>
                          <td className="px-5 py-3 text-right"><RateBar rate={n(row.activation_rate)} /></td>
                        </tr>
                      )
                    })
                  })()}
              </tbody>
            </table>
          </div>
          {!loading && !product && (
            <p className="text-[11px] px-5 py-3" style={{ color: 'var(--txt2)', borderTop: '1px solid var(--bdr)' }}>
              Click any row to filter all charts by that product
            </p>
          )}
        </SectionCard>
      </div>
    </Page>
  )
}
