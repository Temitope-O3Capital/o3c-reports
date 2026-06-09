import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { ProgressListCard, AreaChartCard, fmt, fmtNum } from '../components/Charts.jsx'

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function n(v) { return Number(v || 0) }

/* ── KPI Card ────────────────────────────────────────────────────────────── */
function KPI({ label, value, icon, sub, accent = '#0E2841' }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>
          {label}
        </p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p className="text-[26px] font-bold tracking-tight leading-none font-mono tabular-nums text-slate-900 dark:text-white">
        {value}
      </p>
      {sub && <p className="text-xs text-slate-400 mt-2">{sub}</p>}
    </div>
  )
}

/* ── Upload zone ─────────────────────────────────────────────────────────── */
function UploadZone({ onUploaded }) {
  const [files,   setFiles]   = useState([])
  const [label,   setLabel]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState('')
  const inputRef = useRef()

  function onDrop(e) {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer?.files || [])
    setFiles(f => [...f, ...dropped])
  }

  async function upload() {
    if (!files.length) return
    setLoading(true); setError(''); setSuccess('')
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      fd.append('cycle_label', label)
      const token = localStorage.getItem('o3c_token')
      const API   = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const res   = await fetch(`${API}/api/income/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      const counts = Object.entries(data.loaded)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ')
      setSuccess(`Cycle "${data.label}" loaded — ${counts}`)
      setFiles([])
      onUploaded(data.cycle_id)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card p-6 mb-6 no-print">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Upload Cycle Files</p>
          <p className="text-xs text-slate-400 mt-0.5">
            Drop cyc_int_rpt, cyc_chg_rpt, cyc_bal_rpt, cyc_loc_rpt and/or cust_file
          </p>
        </div>
      </div>

      {/* Drop zone */}
      <div
        className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl p-8 text-center cursor-pointer hover:border-primary/40 hover:bg-primary-50/30 transition-colors mb-4"
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <span className="material-symbols-rounded text-[36px] text-slate-300 dark:text-slate-600 block mb-2">upload_file</span>
        <p className="text-sm text-slate-500">
          {files.length > 0
            ? <span className="text-primary dark:text-primary-100 font-medium">{files.length} file{files.length > 1 ? 's' : ''} selected</span>
            : 'Click or drag cycle files here'}
        </p>
        <input ref={inputRef} type="file" multiple className="hidden"
          accept=".csv,application/octet-stream"
          onChange={e => setFiles(f => [...f, ...Array.from(e.target.files)])} />
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {files.map((f, i) => (
            <span key={i} className="badge badge-grey gap-1">
              {f.name}
              <button className="ml-0.5 hover:text-red-500" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="form-label">Cycle Label (optional)</label>
          <input className="form-input" placeholder="e.g. May 2026" value={label}
            onChange={e => setLabel(e.target.value)} />
        </div>
        <button
          onClick={upload}
          disabled={loading || !files.length}
          className="btn btn-primary gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading ? <><div className="spinner" style={{ width: 14, height: 14, borderTopColor: 'rgba(255,255,255,0.9)', borderColor: 'rgba(255,255,255,0.25)' }} /> Processing…</> : <><span className="material-symbols-rounded text-[17px]">upload</span> Load Files</>}
        </button>
      </div>

      {error   && <div className="mt-3 flex items-center gap-2 text-red-600 text-sm bg-red-50 dark:bg-red-900/15 border border-red-100 rounded-xl px-4 py-3"><span className="material-symbols-rounded text-[16px]">error</span>{error}</div>}
      {success && <div className="mt-3 flex items-center gap-2 text-emerald-700 text-sm bg-emerald-50 dark:bg-emerald-900/15 border border-emerald-100 rounded-xl px-4 py-3"><span className="material-symbols-rounded text-[16px]">check_circle</span>{success}</div>}
    </div>
  )
}

/* ── Main Page ───────────────────────────────────────────────────────────── */
export default function Income() {
  const [cycles,      setCycles]      = useState([])
  const [cycleId,     setCycleId]     = useState(null)
  const [summary,     setSummary]     = useState(null)
  const [byProduct,   setByProduct]   = useState([])
  const [accounts,    setAccounts]    = useState([])
  const [totalRows,   setTotalRows]   = useState(0)
  const [trend,       setTrend]       = useState([])
  const [loading,     setLoading]     = useState(false)
  const [loadingAcc,  setLoadingAcc]  = useState(false)
  const [exporting,   setExporting]   = useState(false)

  // Filters
  const [product,      setProduct]     = useState('')
  const [currency,     setCurrency]    = useState('')
  const [hasOverdue,   setHasOverdue]  = useState(false)
  const [hasInterest,  setHasInterest] = useState(false)
  const [search,       setSearch]      = useState('')
  const [page,         setPage]        = useState(0)

  const PAGE_SIZE = 200

  // Load cycles list
  async function loadCycles() {
    const data = await apiFetch('/api/income/cycles')
    setCycles(data)
    if (data.length && !cycleId) setCycleId(data[0].id)
  }

  useEffect(() => { loadCycles() }, [])

  // Load summary + products when cycle/filters change
  const loadReport = useCallback(async () => {
    if (!cycleId) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ cycle_id: cycleId })
      if (product)  params.set('product', product)
      if (currency) params.set('currency', currency)

      const [sum, prod, tr] = await Promise.all([
        apiFetch(`/api/income/summary?${params}`),
        apiFetch(`/api/income/by-product?${params}`),
        apiFetch('/api/income/trend'),
      ])
      setSummary(sum)
      setByProduct(prod)
      setTrend(tr)
    } finally {
      setLoading(false)
    }
  }, [cycleId, product, currency])

  useEffect(() => { loadReport() }, [loadReport])

  // Load accounts table
  const loadAccounts = useCallback(async () => {
    if (!cycleId) return
    setLoadingAcc(true)
    try {
      const params = new URLSearchParams({
        cycle_id: cycleId, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
      })
      if (product)     params.set('product', product)
      if (currency)    params.set('currency', currency)
      if (hasOverdue)  params.set('has_overdue', 'true')
      if (hasInterest) params.set('has_interest', 'true')
      if (search)      params.set('q', search)
      const res = await apiFetch(`/api/income/accounts?${params}`)
      setAccounts(res.data || [])
      setTotalRows(res.total || 0)
    } finally {
      setLoadingAcc(false)
    }
  }, [cycleId, product, currency, hasOverdue, hasInterest, search, page])

  useEffect(() => { loadAccounts() }, [loadAccounts])

  // CSV export
  async function exportCSV() {
    if (!cycleId) return
    setExporting(true)
    try {
      const params = new URLSearchParams({ cycle_id: cycleId })
      if (product)     params.set('product', product)
      if (currency)    params.set('currency', currency)
      if (hasOverdue)  params.set('has_overdue', 'true')
      if (hasInterest) params.set('has_interest', 'true')
      if (search)      params.set('q', search)
      const API   = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const token = localStorage.getItem('o3c_token')
      const res   = await fetch(`${API}/api/income/accounts/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `income_${currentCycle?.label || cycleId}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const currentCycle = cycles.find(c => c.id === cycleId)
  const s = summary || {}

  const chargeData = s.total_charges ? [
    { name: 'Fees',         value: n(s.fees) },
    { name: 'Interest',     value: n(s.charge_interest) },
    { name: 'Penalty',      value: n(s.penalty) },
    { name: 'Purchase',     value: n(s.purchase) },
    { name: 'Cash Advance', value: n(s.cash_advance) },
  ].filter(r => r.value > 0) : []

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Income Report</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {currentCycle ? `Cycle: ${currentCycle.label} · ${currentCycle.cycle_date}` : 'Select a cycle below'}
          </p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <button onClick={() => window.print()} className="btn btn-ghost gap-1.5 text-sm">
            <span className="material-symbols-rounded text-[17px]">print</span>
            PDF
          </button>
          <button onClick={exportCSV} disabled={exporting || !cycleId} className="btn btn-primary gap-1.5 text-sm disabled:opacity-60">
            {exporting
              ? <><div className="spinner" style={{ width: 13, height: 13, borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.25)' }} /> Exporting…</>
              : <><span className="material-symbols-rounded text-[17px]">download</span> Export CSV</>}
          </button>
        </div>
      </div>

      {/* ── Upload ── */}
      <UploadZone onUploaded={id => { loadCycles(); setCycleId(id) }} />

      {cycles.length === 0 && (
        <div className="card p-12 flex flex-col items-center text-slate-400">
          <span className="material-symbols-rounded text-[48px] opacity-25 mb-3">upload_file</span>
          <p className="font-medium">No cycles loaded yet</p>
          <p className="text-sm mt-1">Upload your cycle files above to generate the report</p>
        </div>
      )}

      {cycles.length > 0 && (
        <>
          {/* ── Filters ── */}
          <div className="flex flex-wrap gap-3 mb-6 no-print">
            {/* Cycle selector */}
            <select className="form-input w-auto text-sm font-medium"
              value={cycleId || ''} onChange={e => { setCycleId(Number(e.target.value)); setPage(0) }}>
              {cycles.map(c => (
                <option key={c.id} value={c.id}>{c.label} — {c.cycle_date}</option>
              ))}
            </select>

            {/* Product filter */}
            <select className="form-input w-auto text-sm" value={product}
              onChange={e => { setProduct(e.target.value); setPage(0) }}>
              <option value="">All Products</option>
              {(s.products || []).map(p => <option key={p} value={p}>{p}</option>)}
            </select>

            {/* Currency */}
            <select className="form-input w-auto text-sm" value={currency}
              onChange={e => { setCurrency(e.target.value); setPage(0) }}>
              <option value="">NGN + USD</option>
              <option value="NGN">NGN</option>
              <option value="USD">USD</option>
            </select>

            {/* Toggle filters */}
            <button onClick={() => { setHasOverdue(v => !v); setPage(0) }}
              className={`btn text-sm gap-1.5 ${hasOverdue ? 'btn-primary' : 'btn-ghost'}`}>
              <span className="material-symbols-rounded text-[16px]">warning</span>
              Overdue only
            </button>
            <button onClick={() => { setHasInterest(v => !v); setPage(0) }}
              className={`btn text-sm gap-1.5 ${hasInterest ? 'btn-primary' : 'btn-ghost'}`}>
              <span className="material-symbols-rounded text-[16px]">percent</span>
              Has interest
            </button>

            {/* Search */}
            <div className="relative">
              <span className="material-symbols-rounded text-[16px] text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">search</span>
              <input className="form-input pl-8 text-sm" placeholder="CIF or name…"
                value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} />
            </div>
          </div>

          {/* ── Print header (hidden on screen) ── */}
          <div className="hidden print:block mb-6">
            <p className="text-lg font-bold">O3C Cards — Income Report · {currentCycle?.label}</p>
            <p className="text-sm text-slate-500">Generated {today}{product ? ` · Product: ${product}` : ''}{currency ? ` · Currency: ${currency}` : ''}</p>
          </div>

          {loading ? (
            <div className="flex items-center gap-3 text-slate-400 py-10"><div className="spinner" /> Loading report…</div>
          ) : (
            <>
              {/* ── KPI Cards — Row 1: Income ── */}
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Income</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
                <KPI label="Total Interest"    value={fmt(s.interest)}       icon="percent"          accent="#0E2841" />
                <KPI label="Fees Collected"    value={fmt(s.fees)}           icon="receipt"          accent="#8B5CF6" />
                <KPI label="Cash Advance Fees" value={fmt(s.cash_advance)}   icon="atm"              accent="#C00000" />
                <KPI label="Purchase Fees"     value={fmt(s.purchase)}       icon="shopping_cart"    accent="#0891B2" />
              </div>

              {/* ── KPI Cards — Row 2: Portfolio ── */}
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Portfolio</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <KPI label="Outstanding Balance" value={fmt(s.outstanding_bal)}  icon="account_balance"  accent="#10B981"
                  sub={`${fmtNum(s.total_accounts)} accounts`} />
                <KPI label="Total Overdue"       value={fmt(s.overdue)}           icon="warning"          accent="#F59E0B"
                  sub={`${fmtNum(s.overdue_accounts)} accounts overdue`} />
                <KPI label="Total LOC Extended"  value={fmt(s.loc_total)}         icon="credit_card"      accent="#0E2841" />
                <KPI label="LOC Utilisation"     value={`${s.loc_utilisation ?? 0}%`} icon="donut_large" accent={n(s.loc_utilisation) > 80 ? '#C00000' : '#10B981'}
                  sub={`${fmt(s.outstanding_bal)} of ${fmt(s.loc_total)}`} />
              </div>

              {/* ── Charts ── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                <ProgressListCard
                  title="Interest by Product"
                  data={byProduct.filter(r => n(r.interest) > 0)}
                  nameKey="product_name"
                  valueKey="interest"
                  currency
                  maxItems={10}
                />
                <ProgressListCard
                  title="Outstanding Balance by Product"
                  data={byProduct.filter(r => n(r.outstanding_bal) > 0)}
                  nameKey="product_name"
                  valueKey="outstanding_bal"
                  currency
                  maxItems={10}
                />
                <ProgressListCard
                  title="Charges Breakdown"
                  data={chargeData}
                  nameKey="name"
                  valueKey="value"
                  currency
                  maxItems={6}
                />
              </div>

              {trend.length > 1 && (
                <div className="mb-6">
                  <AreaChartCard
                    title="Interest Income — Month over Month"
                    data={trend}
                    xKey="label"
                    areas={[
                      { key: 'interest',    label: 'Interest',    color: '#0E2841' },
                      { key: 'outstanding_bal', label: 'Outstanding', color: '#C00000' },
                    ]}
                    height={200}
                    currency
                  />
                </div>
              )}

              {/* ── Account Table ── */}
              <div className="card overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700/50 flex items-center justify-between no-print">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    Account Detail
                  </p>
                  <span className="badge badge-grey">{totalRows.toLocaleString()} accounts</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>CIF</th>
                        <th>Customer</th>
                        <th>Product</th>
                        <th>CCY</th>
                        <th className="text-right">Interest</th>
                        <th className="text-right">Fees</th>
                        <th className="text-right">Cash Adv</th>
                        <th className="text-right">Purchase</th>
                        <th className="text-right">Penalty</th>
                        <th className="text-right">Outstanding</th>
                        <th className="text-right">Overdue</th>
                        <th className="text-right">Min Payment</th>
                        <th className="text-right">LOC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingAcc ? (
                        <tr><td colSpan={13} className="text-center py-10 text-slate-400">
                          <div className="flex items-center justify-center gap-2"><div className="spinner" /> Loading…</div>
                        </td></tr>
                      ) : accounts.length === 0 ? (
                        <tr><td colSpan={13} className="text-center py-10">
                          <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">table_view</span>
                          <p className="text-sm text-slate-400">No accounts match the current filters</p>
                        </td></tr>
                      ) : accounts.map((row, i) => {
                        const isOverdue = n(row.overdue) > 0
                        return (
                          <tr key={i}>
                            <td className="font-mono text-xs text-slate-500">{row.cif}</td>
                            <td className="font-medium text-slate-800 dark:text-slate-100">
                              {row.first_name || row.last_name
                                ? `${row.first_name} ${row.last_name}`.trim()
                                : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="text-slate-600 dark:text-slate-400 whitespace-nowrap">{row.product_name}</td>
                            <td><span className="badge badge-grey text-[10px]">{row.currency}</span></td>
                            <td className={`text-right font-mono tabular-nums ${n(row.interest) > 0 ? 'text-slate-800 dark:text-slate-100 font-semibold' : 'text-slate-300'}`}>
                              {n(row.interest) > 0 ? fmt(row.interest) : '—'}
                            </td>
                            <td className="text-right font-mono tabular-nums text-slate-600">{n(row.fees) > 0 ? fmt(row.fees) : '—'}</td>
                            <td className="text-right font-mono tabular-nums text-slate-600">{n(row.cash_advance) > 0 ? fmt(row.cash_advance) : '—'}</td>
                            <td className="text-right font-mono tabular-nums text-slate-600">{n(row.purchase) > 0 ? fmt(row.purchase) : '—'}</td>
                            <td className="text-right font-mono tabular-nums text-slate-600">{n(row.penalty) > 0 ? fmt(row.penalty) : '—'}</td>
                            <td className="text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">{n(row.outstanding_bal) > 0 ? fmt(row.outstanding_bal) : '—'}</td>
                            <td className={`text-right font-mono tabular-nums font-semibold ${isOverdue ? 'text-red-500' : 'text-slate-300'}`}>
                              {isOverdue ? fmt(row.overdue) : '—'}
                            </td>
                            <td className="text-right font-mono tabular-nums text-slate-600">{n(row.min_payment) > 0 ? fmt(row.min_payment) : '—'}</td>
                            <td className="text-right font-mono tabular-nums text-slate-500">{n(row.current_loc) > 0 ? fmt(row.current_loc) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalRows > PAGE_SIZE && (
                  <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-700/50 flex items-center justify-between no-print">
                    <p className="text-xs text-slate-400">
                      Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalRows)} of {totalRows.toLocaleString()}
                    </p>
                    <div className="flex gap-2">
                      <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                        className="btn btn-ghost btn-sm disabled:opacity-40">
                        <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                      </button>
                      <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= totalRows}
                        className="btn btn-ghost btn-sm disabled:opacity-40">
                        <span className="material-symbols-rounded text-[17px]">chevron_right</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Print footer */}
              <div className="hidden print:block mt-8 pt-4 border-t border-slate-200 text-[10px] text-slate-400">
                <span>O3C Cards — Income Report · {currentCycle?.label} · Confidential</span>
                <span className="ml-4">Generated {today}</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
