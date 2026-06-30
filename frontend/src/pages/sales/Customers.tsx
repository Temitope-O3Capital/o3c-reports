import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import {
  Page, SectionCard, DateFilter, StatusBadge,
  ErrBanner, ExportBtn, Sk, NAVY,
} from '../../components/UI'

interface Customer {
  'CIF Number': string
  'First Name': string
  'Last Name': string
  State: string
  City: string
  'Job Title': string
  'Account Created Date': string
  'Product Name': string
  'Account Status': string
  'Account Manager': string
}

const STATUS_FILTER_OPTIONS = [
  { value: 'all',      label: 'All' },
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
]

export default function Customers() {
  const [from,         setFrom]         = useState(monthStart())
  const [to,           setTo]           = useState(today())
  const [data,         setData]         = useState<Customer[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [exporting,    setExporting]    = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await apiFetch('/api/sales/customers?limit=500')
      setData(r.data || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    return data.filter(c => {
      const q = search.toLowerCase()
      const matchSearch = !q || [
        c['First Name'], c['Last Name'], c['CIF Number'],
        c.State, c.City, c['Account Manager'], c['Product Name'],
      ].some(v => v?.toLowerCase().includes(q))

      const s = (c['Account Status'] || '').toLowerCase()
      const matchStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active'   && (s === 'open' || s === 'active')) ||
        (statusFilter === 'inactive' && s !== 'open' && s !== 'active')

      return matchSearch && matchStatus
    })
  }, [data, search, statusFilter])

  function initials(c: Customer) {
    const first = (c['First Name'] || '').trim()
    const last  = (c['Last Name']  || '').trim()
    if (first && last) return (first[0] + last[0]).toUpperCase()
    if (first) return first[0].toUpperCase()
    return '?'
  }

  function avatarColor(cif: string) {
    const h = [...(cif || '0')].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
    return `hsl(${(h * 37) % 360} 50% 45%)`
  }

  async function doExport() {
    setExporting(true)
    try {
      const { apiExport } = await import('../../lib/api')
      await apiExport('/api/sales/customers?limit=500', 'customers')
    } finally { setExporting(false) }
  }

  /* Aggregate stats */
  const activeCount   = data.filter(c => ['open','active'].includes((c['Account Status'] || '').toLowerCase())).length
  const stateCount    = new Set(data.map(c => c.State).filter(Boolean)).size
  const productCounts = data.reduce<Record<string, number>>((acc, c) => {
    const p = c['Product Name'] || 'Unknown'
    acc[p] = (acc[p] || 0) + 1
    return acc
  }, {})

  return (
    <Page dept="Sales" title="Customers"
      subtitle="Customer directory with search, status, and profile data"
      actions={
        <div className="flex items-center gap-2">
          <ExportBtn onClick={doExport} loading={exporting} />
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
        </div>
      }>
      <ErrBanner msg={error} />

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {[
          { label: 'Total Customers', value: fmtNum(data.length), icon: 'groups',      color: NAVY },
          { label: 'Active',          value: fmtNum(activeCount), icon: 'check_circle', color: '#059669' },
          { label: 'Inactive',        value: fmtNum(data.length - activeCount), icon: 'cancel', color: '#C00000' },
          { label: 'States Covered',  value: fmtNum(stateCount), icon: 'location_on',  color: '#2563EB' },
        ].map(item => (
          <div key={item.label} className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400">{item.label}</p>
              <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                style={{ background: `${item.color}12` }}>
                <span className="material-symbols-rounded text-[15px]" style={{ color: item.color }}>{item.icon}</span>
              </div>
            </div>
            {loading ? <Sk w="w-20" h="h-6" /> : (
              <p className="kpi-number text-[22px] text-slate-900">{item.value}</p>
            )}
          </div>
        ))}
      </div>

      {/* Product breakdown pills */}
      {!loading && Object.keys(productCounts).length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {Object.entries(productCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => (
            <span key={name}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium"
              style={{ background: `${NAVY}08`, color: NAVY }}>
              <span className="material-symbols-rounded text-[13px]">credit_card</span>
              {name}
              <span className="kpi-number text-[11px] font-bold">{fmtNum(count)}</span>
            </span>
          ))}
        </div>
      )}

      {/* Customer table */}
      <SectionCard
        title="Customer Directory"
        subtitle={`${filtered.length} of ${data.length} customers`}
        badge={filtered.length}
        actions={
          <div className="flex items-center gap-2">
            {/* Status toggle */}
            <div className="flex rounded-lg overflow-hidden text-[11px] font-semibold"
              style={{ border: '1px solid rgba(15,23,42,0.12)' }}>
              {STATUS_FILTER_OPTIONS.map(f => (
                <button key={f.value}
                  onClick={() => setStatusFilter(f.value)}
                  className="px-3 py-1.5 transition-colors"
                  style={{
                    background: statusFilter === f.value ? NAVY : 'transparent',
                    color: statusFilter === f.value ? '#fff' : '#64748B',
                  }}>
                  {f.label}
                </button>
              ))}
            </div>
            {/* Search */}
            <div className="relative">
              <span className="material-symbols-rounded text-[14px] absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                search
              </span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Name, CIF, state…"
                className="pl-8 pr-3 py-1.5 rounded-lg border text-[12px] outline-none bg-white"
                style={{ borderColor: 'rgba(15,23,42,0.15)', width: 180 }}
              />
            </div>
          </div>
        }>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                {['Customer', 'Location', 'Product', 'Status', 'Manager', 'Joined'].map(col => (
                  <th key={col}
                    className="px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-left whitespace-nowrap"
                    style={{ background: NAVY, color: 'rgba(255,255,255,0.6)' }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j} className="px-5 py-3.5"><Sk /></td>
                      ))}
                    </tr>
                  ))
                : filtered.length === 0
                ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-14 text-center">
                      <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">person_search</span>
                      <p className="text-[13px] text-slate-400">No customers match your filters</p>
                    </td>
                  </tr>
                )
                : filtered.map((c, i) => (
                  <tr key={i} className="hover:bg-slate-50 transition-colors"
                    style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                    {/* Customer */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                          style={{ background: avatarColor(c['CIF Number']) }}>
                          {initials(c)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-800 truncate">
                            {[c['First Name'], c['Last Name']].filter(Boolean).join(' ') || '—'}
                          </p>
                          <p className="text-[11px] text-slate-400 kpi-number">{c['CIF Number']}</p>
                        </div>
                      </div>
                    </td>
                    {/* Location */}
                    <td className="px-5 py-3">
                      <p className="text-slate-700">{c.State || '—'}</p>
                      {c.City && c.City !== c.State && (
                        <p className="text-[11px] text-slate-400">{c.City}</p>
                      )}
                    </td>
                    {/* Product */}
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded"
                        style={{ background: `${NAVY}08`, color: NAVY }}>
                        {c['Product Name'] || '—'}
                      </span>
                    </td>
                    {/* Status */}
                    <td className="px-5 py-3">
                      <StatusBadge status={
                        (c['Account Status'] || '').toLowerCase() === 'open' ? 'active' : (c['Account Status'] || 'inactive')
                      } />
                    </td>
                    {/* Manager */}
                    <td className="px-5 py-3 text-slate-500">{c['Account Manager'] || '—'}</td>
                    {/* Joined */}
                    <td className="px-5 py-3 text-[12px] text-slate-400 kpi-number whitespace-nowrap">
                      {fmtDate(c['Account Created Date'])}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!loading && data.length >= 200 && (
          <div className="px-5 py-3 text-[11px] text-slate-400 flex items-center gap-1"
            style={{ borderTop: '1px solid rgba(15,23,42,0.05)', background: 'rgba(15,23,42,0.01)' }}>
            <span className="material-symbols-rounded text-[14px]">info</span>
            Showing up to 500 most recent. Export for full dataset.
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
