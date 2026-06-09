import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../hooks/useApi.js'
import { InfoTooltip } from '../components/Charts.jsx'
import { ProgressListCard, AreaChartCard, fmt, fmtNum } from '../components/Charts.jsx'

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function n(v) { return Number(v || 0) }

function fmtCycleDate(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/* ══════════════════════════════════════════════════════════════════
   FILTER COMPONENTS
   ══════════════════════════════════════════════════════════════════ */

const CHIP_BASE = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  height: 34, padding: '0 12px', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  transition: 'all 0.12s', userSelect: 'none', border: '1px solid',
  outline: 'none',
}
const CHIP_DEFAULT = { ...CHIP_BASE, background: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg-2))', borderColor: 'rgb(var(--border) / 0.2)' }
const CHIP_ACTIVE  = { ...CHIP_BASE, background: '#0E2841', color: '#fff', borderColor: '#0E2841' }

/* ── Dropdown item inside a FilterChip ── */
function DropdownItem({ label, selected, onClick }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '8px 14px', fontSize: 13, textAlign: 'left',
        color: selected ? '#0E2841' : 'rgb(var(--fg-2))',
        fontWeight: selected ? 600 : 400,
        background: hov && !selected ? 'rgb(var(--bg-subtle))' : selected ? 'rgb(14 40 65 / 0.05)' : 'transparent',
        cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      {label}
      {selected && <span className="material-symbols-rounded" style={{ fontSize: 14, color: '#0E2841' }}>check</span>}
    </button>
  )
}

/* ── Dropdown chip — opens a popover on click ── */
function FilterChip({ label, active, onClear, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()

  useEffect(() => {
    if (!open) return
    function handle(e) { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={active ? CHIP_ACTIVE : CHIP_DEFAULT} onClick={() => setOpen(v => !v)}>
        {label}
        {active ? (
          <span
            className="material-symbols-rounded"
            style={{ fontSize: 14, lineHeight: 1, opacity: 0.75, marginLeft: 2 }}
            onClick={e => { e.stopPropagation(); onClear(); setOpen(false) }}
          >close</span>
        ) : (
          <span className="material-symbols-rounded" style={{ fontSize: 14, lineHeight: 1, opacity: 0.4 }}>expand_more</span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 50,
          background: 'rgb(var(--bg-surface))', borderRadius: 10, minWidth: 180,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)', border: '1px solid rgb(var(--border) / 0.1)',
          overflow: 'hidden',
        }}>
          <div style={{ paddingTop: 4, paddingBottom: 4 }}>{children}</div>
        </div>
      )}
    </div>
  )
}

/* ── Toggle chip ── */
function ToggleChip({ label, icon, active, onClick }) {
  return (
    <button style={active ? CHIP_ACTIVE : CHIP_DEFAULT} onClick={onClick}>
      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span>
      {label}
    </button>
  )
}

/* ── Active filter pill (shown in summary row) ── */
function ActivePill({ label, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px 3px 10px', borderRadius: 6,
      fontSize: 12, fontWeight: 500,
      background: 'rgb(14 40 65 / 0.08)', color: '#0E2841',
      border: '1px solid rgb(14 40 65 / 0.12)',
    }}>
      {label}
      <button onClick={onRemove} style={{ lineHeight: 1, display: 'flex', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 13, opacity: 0.55 }}>close</span>
      </button>
    </span>
  )
}

/* ── Period Navigator ── */
function PeriodNavigator({ cycles, cycleId, onChange }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef()
  const idx     = cycles.findIndex(c => c.id === cycleId)
  const current = cycles[idx]
  const canPrev = idx < cycles.length - 1
  const canNext = idx > 0

  useEffect(() => {
    if (!pickerOpen) return
    function handle(e) { if (!pickerRef.current?.contains(e.target)) setPickerOpen(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [pickerOpen])

  const navBtn = (enabled, onClick, icon) => (
    <button
      disabled={!enabled} onClick={onClick}
      style={{
        width: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgb(var(--fg-2))', opacity: enabled ? 1 : 0.25,
        cursor: enabled ? 'pointer' : 'default',
        background: 'transparent', border: 'none', outline: 'none', flexShrink: 0,
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{icon}</span>
    </button>
  )

  return (
    <div ref={pickerRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch' }}>
      <div style={{
        display: 'inline-flex', alignItems: 'stretch',
        borderRadius: 10, border: '1px solid rgb(var(--border) / 0.18)',
        background: 'rgb(var(--bg-surface))', overflow: 'hidden',
      }}>
        {navBtn(canPrev, () => onChange(cycles[idx + 1].id), 'chevron_left')}

        <button
          onClick={() => setPickerOpen(v => !v)}
          style={{
            padding: '7px 18px', textAlign: 'center', minWidth: 168,
            borderLeft: '1px solid rgb(var(--border) / 0.12)',
            borderRight: '1px solid rgb(var(--border) / 0.12)',
            background: pickerOpen ? 'rgb(var(--bg-subtle))' : 'transparent',
            cursor: 'pointer', border: 'none', outline: 'none',
            borderLeft: '1px solid rgb(var(--border) / 0.12)',
            borderRight: '1px solid rgb(var(--border) / 0.12)',
          }}
        >
          <p style={{ fontSize: 15, fontWeight: 700, color: 'rgb(var(--fg-1))', lineHeight: 1.3, letterSpacing: '-0.01em' }}>
            {current?.label || '—'}
          </p>
          <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginTop: 2, letterSpacing: '0.03em', textTransform: 'uppercase', fontWeight: 500 }}>
            {current?.cycle_date ? fmtCycleDate(current.cycle_date) : 'Click to select'}
          </p>
        </button>

        {navBtn(canNext, () => onChange(cycles[idx - 1].id), 'chevron_right')}
      </div>

      {/* Cycle picker dropdown */}
      {pickerOpen && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: '50%',
          transform: 'translateX(-50%)', zIndex: 60,
          background: 'rgb(var(--bg-surface))',
          border: '1px solid rgb(var(--border) / 0.12)',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
          minWidth: 260, maxHeight: 320, overflowY: 'auto',
          padding: '6px 0',
        }}>
          <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgb(var(--fg-3))', padding: '6px 14px 4px' }}>
            Select billing cycle
          </p>
          {cycles.map(c => {
            const isSelected = c.id === cycleId
            const hasData    = Number(c.interest_rows) > 0 || Number(c.charge_rows) > 0
            return (
              <button key={c.id}
                onClick={() => { onChange(c.id); setPickerOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '9px 14px', cursor: 'pointer',
                  background: isSelected ? 'rgb(14 40 65 / 0.06)' : 'transparent',
                  textAlign: 'left',
                }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: isSelected ? 700 : 500, color: isSelected ? '#0E2841' : 'rgb(var(--fg-1))', lineHeight: 1.3 }}>
                    {c.label}
                  </p>
                  <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 1 }}>
                    {fmtCycleDate(c.cycle_date)}
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {hasData ? (
                    <span style={{ fontSize: 10, fontWeight: 500, color: '#059669', background: 'rgb(5 150 105 / 0.08)', padding: '2px 7px', borderRadius: 20 }}>
                      {(Number(c.interest_rows) || 0).toLocaleString()} rows
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: 'rgb(var(--fg-3))', background: 'rgb(var(--bg-subtle))', padding: '2px 7px', borderRadius: 20 }}>
                      empty
                    </span>
                  )}
                  {isSelected && <span className="material-symbols-rounded" style={{ fontSize: 16, color: '#0E2841' }}>check</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── Full filter bar ── */
function FilterBar({
  cycles, cycleId, onCycleChange,
  products, product, onProduct,
  currency, onCurrency,
  hasOverdue, onOverdue,
  hasInterest, onInterest,
  search, onSearch,
}) {
  const active = [product, currency, hasOverdue, hasInterest].filter(Boolean)

  function clearAll() {
    onProduct(''); onCurrency(''); onOverdue(false); onInterest(false); onSearch('')
  }

  return (
    <div className="no-print" style={{ marginBottom: 24 }}>
      {/* Row 1: Period + search row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <PeriodNavigator cycles={cycles} cycleId={cycleId} onChange={onCycleChange} />

        <div style={{ flex: 1 }} />

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <span className="material-symbols-rounded" style={{
            fontSize: 16, position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            color: 'rgb(var(--fg-3))', pointerEvents: 'none',
          }}>search</span>
          <input
            className="form-input"
            style={{ paddingLeft: 32, height: 34, fontSize: 13, width: 200 }}
            placeholder="CIF or name…"
            value={search}
            onChange={e => onSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Row 2: Filter chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Product */}
        <FilterChip
          label={product || 'Product'}
          active={!!product}
          onClear={() => onProduct('')}
        >
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            <DropdownItem label="All Products" selected={!product} onClick={() => onProduct('')} />
            {products.map(p => (
              <DropdownItem key={p} label={p} selected={product === p} onClick={() => onProduct(p)} />
            ))}
          </div>
        </FilterChip>

        {/* Currency */}
        <FilterChip
          label={currency === 'NGN' ? '🇳🇬 NGN' : currency === 'USD' ? '🇺🇸 USD' : 'Currency'}
          active={!!currency}
          onClear={() => onCurrency('')}
        >
          {[['', '🌍  NGN + USD'], ['NGN', '🇳🇬  NGN'], ['USD', '🇺🇸  USD']].map(([val, lbl]) => (
            <DropdownItem key={val} label={lbl} selected={currency === val} onClick={() => onCurrency(val)} />
          ))}
        </FilterChip>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: 'rgb(var(--border) / 0.15)' }} />

        <ToggleChip label="Overdue only" icon="warning" active={hasOverdue} onClick={() => onOverdue(!hasOverdue)} />
        <ToggleChip label="Has interest"  icon="percent" active={hasInterest} onClick={() => onInterest(!hasInterest)} />

        {/* Clear all */}
        {active.length > 0 && (
          <>
            <div style={{ width: 1, height: 20, background: 'rgb(var(--border) / 0.15)' }} />
            <button
              onClick={clearAll}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 12, fontWeight: 500, color: 'rgb(var(--fg-3))',
                cursor: 'pointer', background: 'none', border: 'none', padding: '4px 2px',
                transition: 'color 0.12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#C00000' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'rgb(var(--fg-3))' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>filter_alt_off</span>
              Clear {active.length} filter{active.length > 1 ? 's' : ''}
            </button>
          </>
        )}
      </div>

      {/* Row 3: Active filter summary pills */}
      {active.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Filtered by:
          </span>
          {product    && <ActivePill label={product}              onRemove={() => onProduct('')} />}
          {currency   && <ActivePill label={currency === 'NGN' ? '🇳🇬 NGN' : '🇺🇸 USD'}   onRemove={() => onCurrency('')} />}
          {hasOverdue && <ActivePill label="Overdue only"         onRemove={() => onOverdue(false)} />}
          {hasInterest&& <ActivePill label="Has interest"         onRemove={() => onInterest(false)} />}
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   KPI CARD
   ══════════════════════════════════════════════════════════════════ */
function KPI({ label, value, icon, sub, accent = '#0E2841', tooltip }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>
            {label}
          </p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p className="text-[26px] font-bold tracking-tight leading-none tabular-nums text-slate-900 dark:text-white" style={{ fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"' }}>
        {value}
      </p>
      {sub && <p className="text-xs text-slate-400 mt-2">{sub}</p>}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */
export default function Income() {
  const navigate = useNavigate()
  const [cycles,     setCycles]     = useState([])
  const [cycleId,    setCycleId]    = useState(null)
  const [summary,    setSummary]    = useState(null)
  const [byProduct,  setByProduct]  = useState([])
  const [accounts,   setAccounts]   = useState([])
  const [totalRows,  setTotalRows]  = useState(0)
  const [trend,      setTrend]      = useState([])
  const [loading,    setLoading]    = useState(false)
  const [loadingAcc, setLoadingAcc] = useState(false)
  const [exporting,  setExporting]  = useState(false)

  // Filters
  const [product,     setProduct]     = useState('')
  const [currency,    setCurrency]    = useState('')
  const [hasOverdue,  setHasOverdue]  = useState(false)
  const [hasInterest, setHasInterest] = useState(false)
  const [search,      setSearch]      = useState('')
  const [page,        setPage]        = useState(0)

  const PAGE_SIZE = 200

  async function loadCycles() {
    const data = await apiFetch('/api/income/cycles')
    setCycles(data)
    if (data.length && !cycleId) {
      const withData = data.find(c => Number(c.interest_rows) > 0 || Number(c.charge_rows) > 0)
      setCycleId((withData || data[0]).id)
    }
  }

  useEffect(() => { loadCycles() }, [])

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
      setSummary(sum); setByProduct(prod); setTrend(tr)
    } finally { setLoading(false) }
  }, [cycleId, product, currency])

  useEffect(() => { loadReport() }, [loadReport])

  const loadAccounts = useCallback(async () => {
    if (!cycleId) return
    setLoadingAcc(true)
    try {
      const params = new URLSearchParams({ cycle_id: cycleId, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      if (product)     params.set('product', product)
      if (currency)    params.set('currency', currency)
      if (hasOverdue)  params.set('has_overdue', 'true')
      if (hasInterest) params.set('has_interest', 'true')
      if (search)      params.set('q', search)
      const res = await apiFetch(`/api/income/accounts?${params}`)
      setAccounts(res.data || []); setTotalRows(res.total || 0)
    } finally { setLoadingAcc(false) }
  }, [cycleId, product, currency, hasOverdue, hasInterest, search, page])

  useEffect(() => { loadAccounts() }, [loadAccounts])

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
        headers: { Authorization: `Bearer ${token}` },
      })
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `income_${currentCycle?.label || cycleId}.csv`; a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }

  function resetFilters(page0 = true) { if (page0) setPage(0) }

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
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Income Report</h1>
          <p className="text-sm text-slate-500 mt-0.5">Monthly billing cycle analysis</p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <button onClick={() => window.print()} className="btn btn-ghost gap-1.5 text-sm">
            <span className="material-symbols-rounded text-[17px]">print</span>PDF
          </button>
          <button onClick={exportCSV} disabled={exporting || !cycleId}
            className="btn btn-primary gap-1.5 text-sm disabled:opacity-60">
            {exporting
              ? <><div className="spinner" style={{ width: 13, height: 13, borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.25)' }} />Exporting…</>
              : <><span className="material-symbols-rounded text-[17px]">download</span>Export CSV</>}
          </button>
        </div>
      </div>

      {/* ── Empty state ── */}
      {cycles.length === 0 && (
        <div className="card p-12 flex flex-col items-center text-slate-400">
          <span className="material-symbols-rounded text-[48px] opacity-25 mb-4">payments</span>
          <p className="font-semibold text-slate-600 dark:text-slate-300">No cycles loaded yet</p>
          <p className="text-sm mt-1 mb-5">Upload income cycle files to generate this report.</p>
          <button onClick={() => navigate('/uploads')} className="btn btn-primary gap-2">
            <span className="material-symbols-rounded text-[17px]">upload_file</span>
            Go to Data Uploads
          </button>
        </div>
      )}

      {cycles.length > 0 && (
        <>
          {/* ── Filter bar ── */}
          <FilterBar
            cycles={cycles} cycleId={cycleId}
            onCycleChange={id => { setCycleId(id); setPage(0) }}
            products={s.products || []}
            product={product}       onProduct={v => { setProduct(v); setPage(0) }}
            currency={currency}     onCurrency={v => { setCurrency(v); setPage(0) }}
            hasOverdue={hasOverdue}  onOverdue={v => { setHasOverdue(v); setPage(0) }}
            hasInterest={hasInterest} onInterest={v => { setHasInterest(v); setPage(0) }}
            search={search}         onSearch={v => { setSearch(v); setPage(0) }}
          />

          {/* ── Print header ── */}
          <div className="hidden print:block mb-6">
            <p className="text-lg font-bold">O3C Cards — Income Report · {currentCycle?.label}</p>
            <p className="text-sm text-slate-500">
              Generated {today}
              {product ? ` · Product: ${product}` : ''}
              {currency ? ` · Currency: ${currency}` : ''}
              {hasOverdue ? ' · Overdue only' : ''}
            </p>
          </div>

          {loading ? (
            <div className="flex items-center gap-3 text-slate-400 py-10">
              <div className="spinner" /> Loading report…
            </div>
          ) : (
            <>
              {/* ── KPI Row 1: Income ── */}
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Income</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
                <KPI label="Total Interest"    value={fmt(s.interest)}     icon="percent"       accent="#0E2841" tooltip="Sum of interest charges billed to all accounts in this billing cycle" />
                <KPI label="Fees Collected"    value={fmt(s.fees)}         icon="receipt"       accent="#8B5CF6" tooltip="Administrative and processing fees charged to accounts this cycle" />
                <KPI label="Cash Advance Fees" value={fmt(s.cash_advance)} icon="atm"           accent="#C00000" tooltip="Fees applied to cash advance transactions drawn this cycle" />
                <KPI label="Purchase Fees"     value={fmt(s.purchase)}     icon="shopping_cart" accent="#0891B2" tooltip="Fees applied to purchase transactions made this cycle" />
              </div>

              {/* ── KPI Row 2: Portfolio ── */}
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Portfolio</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <KPI label="Outstanding Balance" value={fmt(s.outstanding_bal)}       icon="account_balance" accent="#10B981"
                  sub={`${fmtNum(s.total_accounts)} accounts`}
                  tooltip="Total outstanding balance across all active accounts in this cycle" />
                <KPI label="Total Overdue"        value={fmt(s.overdue)}               icon="warning"         accent="#F59E0B"
                  sub={`${fmtNum(s.overdue_accounts)} accounts overdue`}
                  tooltip="Sum of overdue amounts across accounts that have missed their minimum payment" />
                <KPI label="Total LOC Extended"   value={fmt(s.loc_total)}             icon="credit_card"     accent="#0E2841"
                  tooltip="Total credit lines extended to all cardholders in this cycle" />
                <KPI label="LOC Utilisation"      value={`${s.loc_utilisation ?? 0}%`} icon="donut_large"     accent={n(s.loc_utilisation) > 80 ? '#C00000' : '#10B981'}
                  sub={`${fmt(s.outstanding_bal)} of ${fmt(s.loc_total)}`}
                  tooltip="Outstanding balance as a percentage of total credit lines — high utilisation (>80%) signals credit risk" />
              </div>

              {/* ── Charts ── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                <ProgressListCard title="Interest by Product"
                  data={byProduct.filter(r => n(r.interest) > 0)} nameKey="product_name" valueKey="interest" currency maxItems={10} />
                <ProgressListCard title="Outstanding Balance by Product"
                  data={byProduct.filter(r => n(r.outstanding_bal) > 0)} nameKey="product_name" valueKey="outstanding_bal" currency maxItems={10} />
                <ProgressListCard title="Charges Breakdown"
                  data={chargeData} nameKey="name" valueKey="value" currency maxItems={6} />
              </div>

              {trend.length > 1 && (
                <div className="mb-6">
                  <AreaChartCard
                    title="Interest Income — Month over Month"
                    data={trend} xKey="label"
                    areas={[
                      { key: 'interest',        label: 'Interest',     color: '#0E2841' },
                      { key: 'outstanding_bal', label: 'Outstanding',  color: '#C00000' },
                    ]}
                    height={200} currency
                  />
                </div>
              )}

              {/* ── Account Table ── */}
              <div className="card overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700/50 flex items-center justify-between no-print">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Account Detail</p>
                  <span className="badge badge-grey">{totalRows.toLocaleString()} accounts</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>CIF</th><th>Customer</th><th>Product</th><th>CCY</th>
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
                            <td><span className="badge badge-grey text-[10px]">{row.currency === 'NGN' ? '🇳🇬 NGN' : row.currency === 'USD' ? '🇺🇸 USD' : row.currency}</span></td>
                            <td className={`text-right tabular-nums ${n(row.interest) > 0 ? 'text-slate-800 dark:text-slate-100 font-semibold' : 'text-slate-300'}`}>
                              {n(row.interest) > 0 ? fmt(row.interest) : '—'}
                            </td>
                            <td className="text-right tabular-nums text-slate-600">{n(row.fees) > 0 ? fmt(row.fees) : '—'}</td>
                            <td className="text-right tabular-nums text-slate-600">{n(row.cash_advance) > 0 ? fmt(row.cash_advance) : '—'}</td>
                            <td className="text-right tabular-nums text-slate-600">{n(row.purchase) > 0 ? fmt(row.purchase) : '—'}</td>
                            <td className="text-right tabular-nums text-slate-600">{n(row.penalty) > 0 ? fmt(row.penalty) : '—'}</td>
                            <td className="text-right tabular-nums text-slate-700 dark:text-slate-300">{n(row.outstanding_bal) > 0 ? fmt(row.outstanding_bal) : '—'}</td>
                            <td className={`text-right tabular-nums font-semibold ${isOverdue ? 'text-red-500' : 'text-slate-300'}`}>
                              {isOverdue ? fmt(row.overdue) : '—'}
                            </td>
                            <td className="text-right tabular-nums text-slate-600">{n(row.min_payment) > 0 ? fmt(row.min_payment) : '—'}</td>
                            <td className="text-right tabular-nums text-slate-500">{n(row.current_loc) > 0 ? fmt(row.current_loc) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

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
