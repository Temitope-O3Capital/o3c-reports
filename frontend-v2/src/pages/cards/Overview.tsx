import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtPct, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DateFilter,
  BarChartCard, DonutCard, StatusBadge,
  ErrBanner, ExportBtn, Sk, NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'

const PRODUCT_COLORS: Record<string, string> = {
  'PREP':             NAVY,
  'Amex Naira':       RED,
  'Amex USD':         AMBER,
  'Classic Accounts': '#6366F1',
}

const STATUS_TRACK: Record<string, { color: string; bg: string }> = {
  open:         { color: GREEN,    bg: 'rgba(5,150,105,0.08)' },
  active:       { color: GREEN,    bg: 'rgba(5,150,105,0.08)' },
  terminated:   { color: RED,      bg: 'rgba(192,0,0,0.07)' },
  'legal acti': { color: '#7C3AED', bg: 'rgba(139,92,246,0.08)' },
  suspended:    { color: AMBER,    bg: 'rgba(217,119,6,0.08)' },
  inactive:     { color: '#94A3B8', bg: 'rgba(100,116,139,0.08)' },
  closed:       { color: '#475569', bg: 'rgba(71,85,105,0.07)' },
}
function statusStyle(s: string) {
  return STATUS_TRACK[(s || '').toLowerCase()] ?? { color: '#94A3B8', bg: 'rgba(15,23,42,0.06)' }
}

/* ── Portfolio health grid ───────────────────────────────────── */
function PortfolioHealthGrid({ data, loading }: { data: any[]; loading: boolean }) {
  const total = data.reduce((s, r) => s + n(r.count), 0)
  return (
    <SectionCard title="Portfolio by Status" subtitle="Full status breakdown of all issued cards">
      <div className="px-5 py-4 space-y-3">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5"><Sk w="w-28" /><Sk h="h-2" /></div>
            ))
          : data.length === 0
          ? <p className="text-[13px] text-slate-400 py-8 text-center">No data</p>
          : data.map((row, i) => {
              const status = row['Account Status'] || row.status || ''
              const count  = n(row.count)
              const share  = total > 0 ? (count / total) * 100 : 0
              const sty    = statusStyle(status)
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: sty.color }} />
                      <span className="text-[12px] font-semibold text-slate-700 capitalize">
                        {status || 'Unknown'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-400 kpi-number">{share.toFixed(1)}%</span>
                      <span className="kpi-number text-[14px] font-bold text-slate-800">{count.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${share}%`, background: sty.color }} />
                  </div>
                </div>
              )
            })}
        {!loading && total > 0 && (
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2"
            style={{ borderTop: '1px solid rgba(15,23,42,0.06)' }}>
            <span>Total cards</span>
            <span className="kpi-number font-semibold text-slate-600">{total.toLocaleString()}</span>
          </div>
        )}
      </div>
    </SectionCard>
  )
}

/* ── Product mix grid ────────────────────────────────────────── */
function ProductGrid({ data, loading }: { data: any[]; loading: boolean }) {
  const total = data.reduce((s, r) => s + n(r.count), 0)
  const COLORS = [NAVY, RED, AMBER, '#6366F1', BLUE, GREEN]
  return (
    <SectionCard title="Cards by Product" subtitle="All-time issuance per product">
      <div className="px-5 py-4">
        {loading
          ? <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="space-y-2"><Sk w="w-32" /><Sk h="h-2" /></div>)}</div>
          : (
            <>
              {/* Visual breakdown */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                {data.map((row, i) => {
                  const name  = row['Product Name'] || '—'
                  const count = n(row.count)
                  const share = total > 0 ? (count / total) * 100 : 0
                  const color = PRODUCT_COLORS[name] || COLORS[i % COLORS.length]
                  return (
                    <div key={i} className="rounded-xl p-3" style={{ background: `${color}08` }}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                        <span className="text-[11px] font-semibold text-slate-600 truncate">{name}</span>
                      </div>
                      <p className="kpi-number text-[20px] font-bold text-slate-900">{fmtNum(count)}</p>
                      <p className="text-[11px] text-slate-400">{share.toFixed(1)}% of total</p>
                    </div>
                  )
                })}
              </div>
              {/* Total */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-3"
                style={{ borderTop: '1px solid rgba(15,23,42,0.06)' }}>
                <span>Total issued</span>
                <span className="kpi-number font-semibold text-slate-600">{fmtNum(total)}</span>
              </div>
            </>
          )}
      </div>
    </SectionCard>
  )
}

/* ── Main Page ───────────────────────────────────────────────── */
export default function CardsOverview() {
  const [from,      setFrom]      = useState(monthStart())
  const [to,        setTo]        = useState(today())

  const [kpis,      setKpis]      = useState<any>(null)
  const [byStatus,  setByStatus]  = useState<any[]>([])
  const [byProd,    setByProd]    = useState<any[]>([])
  const [volByType, setVolByType] = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = `?date_from=${from}&date_to=${to}`
      const [k, bs, bp, vt] = await Promise.all([
        apiFetch(`/api/cards/kpis${qs}`),
        apiFetch('/api/cards/by-status'),
        apiFetch('/api/cards/by-product'),
        apiFetch(`/api/cards/volume-by-type${qs}`),
      ])
      setKpis(k.data || {})
      setByStatus(bs.data || [])
      setByProd(bp.data || [])
      setVolByType(vt.data || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const d = kpis || {}

  const donutData = byStatus
    .filter(r => n(r.count) > 0)
    .map(r => ({
      name: r['Account Status'] || r.status || 'Unknown',
      value: n(r.count),
    }))

  async function doExport() {
    setExporting(true)
    try {
      const { apiExport } = await import('../../lib/api')
      await apiExport(`/api/cards/volume-by-type?date_from=${from}&date_to=${to}`, 'cards_overview')
    } finally { setExporting(false) }
  }

  return (
    <Page dept="Cards & Ops" title="Cards Overview"
      subtitle="Portfolio health, product mix, and transaction volume"
      actions={
        <div className="flex items-center gap-2">
          <ExportBtn onClick={doExport} loading={exporting} />
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
        </div>
      }>
      <ErrBanner msg={error} />

      {/* Primary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Issued"     value={fmtNum(d.total_issued)}    icon="credit_card"  accent={NAVY}  loading={loading} />
        <KpiCard label="Active Cards"     value={fmtNum(d.active)}          icon="check_circle" accent={GREEN}
          sub={`${fmtPct(d.activation_rate)} activation`} loading={loading} />
        <KpiCard label="Inactive Cards"   value={fmtNum(d.inactive)}        icon="cancel"       accent={RED}   loading={loading} />
        <KpiCard label="Unique Merchants" value={fmtNum(d.unique_merchants)} icon="storefront"  accent={AMBER} loading={loading} />
      </div>

      {/* Product KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        <KpiCard label="PREP"          value={fmtNum(d.prep)}             icon="wallet"      accent={NAVY}    loading={loading} />
        <KpiCard label="Amex Naira"    value={fmtNum(d.amex_naira)}       icon="payments"    accent={RED}     loading={loading} />
        <KpiCard label="Amex USD"      value={fmtNum(d.amex_usd)}         icon="language"    accent={AMBER}   loading={loading} />
        <KpiCard label="Classic"       value={fmtNum(d.classic_accounts)} icon="credit_card" accent="#6366F1" loading={loading} />
      </div>

      {/* Status breakdown + Product breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <PortfolioHealthGrid data={byStatus} loading={loading} />
        <ProductGrid data={byProd} loading={loading} />
      </div>

      {/* Donut + Volume Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <DonutCard
          title="Status Distribution"
          subtitle="Portfolio composition by account status"
          data={donutData}
          nameKey="name"
          valueKey="value"
          colors={[GREEN, RED, AMBER, '#7C3AED', '#94A3B8', '#475569']}
          loading={loading}
        />
        <BarChartCard
          title="Transaction Volume by Card Type"
          subtitle={`${from} – ${to}`}
          data={volByType}
          xKey="Product Name"
          barKey="volume"
          color={NAVY}
          currency
          height={240}
          loading={loading}
        />
      </div>

      {/* Volume summary table */}
      {(volByType.length > 0 || loading) && (
        <div className="mt-4">
          <SectionCard title="Spend by Card Type" subtitle={`Transaction volume ${from} – ${to}`}>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    {['Card Type', 'Transactions', 'Volume', 'Share'].map((col, i) => (
                      <th key={col}
                        className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap ${i > 0 ? 'text-right' : 'text-left'}`}
                        style={{ background: NAVY, color: 'rgba(255,255,255,0.6)' }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: 4 }).map((_, i) => (
                        <tr key={i} style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                          {Array.from({ length: 4 }).map((_, j) => (
                            <td key={j} className="px-5 py-3.5"><Sk /></td>
                          ))}
                        </tr>
                      ))
                    : (() => {
                        const volTotal = volByType.reduce((s, r) => s + n(r.volume), 0)
                        return volByType.map((row, i) => {
                          const share = volTotal > 0 ? (n(row.volume) / volTotal * 100).toFixed(1) : '0.0'
                          return (
                            <tr key={i} className="hover:bg-slate-50 transition-colors"
                              style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                              <td className="px-5 py-3 font-semibold text-slate-800">
                                {row['Product Name'] || '—'}
                              </td>
                              <td className="px-5 py-3 text-right kpi-number text-slate-600">
                                {n(row.txn_count).toLocaleString()}
                              </td>
                              <td className="px-5 py-3 text-right kpi-number font-semibold text-slate-800">
                                {fmt(row.volume)}
                              </td>
                              <td className="px-5 py-3 text-right">
                                <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded"
                                  style={{ background: 'rgba(15,23,42,0.06)', color: '#475569' }}>
                                  {share}%
                                </span>
                              </td>
                            </tr>
                          )
                        })
                      })()}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}
    </Page>
  )
}
