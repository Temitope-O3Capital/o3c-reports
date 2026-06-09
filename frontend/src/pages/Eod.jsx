import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../hooks/useApi.js'
import { ProgressListCard, AreaChartCard, InfoTooltip, fmt, fmtNum } from '../components/Charts.jsx'

/* ══════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════ */

const TXN_COLORS = {
  'Transfer Out':             '#C00000',
  'Transfer In':              '#10B981',
  'Purchase':                 '#3B82F6',
  'Utility Payment':          '#8B5CF6',
  'Cash Advance':             '#F59E0B',
  'Bank Payment':             '#0891B2',
  'Purchase Reversal':        '#94A3B8',
  'Cash Advance Reversal':    '#94A3B8',
  'Bank Payment Reversal':    '#94A3B8',
  'Utility Payment Reversal': '#94A3B8',
  'Other':                    '#64748B',
}
function txnColor(cat) { return TXN_COLORS[cat] || '#64748B' }

function fmtAmt(v) {
  const n = Number(v || 0)
  if (Math.abs(n) >= 1_000_000_000) return '₦' + (n / 1_000_000_000).toFixed(2) + 'B'
  if (Math.abs(n) >= 1_000_000)     return '₦' + (n / 1_000_000).toFixed(2) + 'M'
  if (Math.abs(n) >= 1_000)         return '₦' + (n / 1_000).toFixed(1) + 'K'
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtExact(v) {
  return '₦' + Number(v || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function toISO(d) {
  // Use local date parts — toISOString() is UTC and shifts dates in UTC+ timezones
  const yr  = d.getFullYear()
  const mo  = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${yr}-${mo}-${day}`
}

function fmtDate(s) {
  if (!s) return '—'
  return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtDateLong(s) {
  if (!s) return '—'
  return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
}

function quarterOf(d) { return Math.floor(d.getMonth() / 3) }

/* ── Compute preset ranges relative to a reference date ── */
function presetRange(preset, ref) {
  const d  = new Date(ref + 'T00:00:00')
  const yr = d.getFullYear()
  const mo = d.getMonth()
  const q  = quarterOf(d)

  if (preset === 'month') {
    return [toISO(new Date(yr, mo, 1)), toISO(new Date(yr, mo + 1, 0))]
  }
  if (preset === 'quarter') {
    return [toISO(new Date(yr, q * 3, 1)), toISO(new Date(yr, q * 3 + 3, 0))]
  }
  if (preset === 'year') {
    return [`${yr}-01-01`, `${yr}-12-31`]
  }
  return [null, null]
}

function presetLabel(preset, dateFrom, dateTo, ref) {
  if (!dateFrom || !dateTo) return 'Select period'
  if (preset === 'custom') {
    if (dateFrom === dateTo) return fmtDate(dateFrom)
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
  }
  const d = new Date(ref + 'T00:00:00')
  if (preset === 'month')   return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  if (preset === 'quarter') return `Q${quarterOf(d) + 1} ${d.getFullYear()}`
  if (preset === 'year')    return `${d.getFullYear()}`
  return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
}

/* ══════════════════════════════════════════════════════════════════
   DATE RANGE PICKER
   ══════════════════════════════════════════════════════════════════ */

function DateRangePicker({ uploads, dateFrom, dateTo, preset, onChange }) {
  const [open, setOpen]         = useState(false)
  const [localPreset, setLP]    = useState(preset)
  const [customFrom, setCF]     = useState(dateFrom || '')
  const [customTo,   setCT]     = useState(dateTo   || '')
  const ref = useRef()

  // latest loaded date is the reference for preset calculations
  const refDate = uploads.length > 0 ? uploads[0].txn_date : toISO(new Date())

  // Set of dates that have data (for styling in picker)
  const loadedDates = new Set(uploads.map(u => u.txn_date))

  useEffect(() => {
    if (!open) return
    function h(e) { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  function applyPreset(p) {
    setLP(p)
    if (p !== 'custom') {
      const [f, t] = presetRange(p, refDate)
      onChange(f, t, p)
      setOpen(false)
    }
  }

  function applyCustom() {
    if (customFrom && customTo) {
      const f = customFrom <= customTo ? customFrom : customTo
      const t = customFrom <= customTo ? customTo   : customFrom
      onChange(f, t, 'custom')
      setOpen(false)
    }
  }

  const PRESETS = [
    { key: 'month',   label: 'This Month',   sub: presetRange('month',   refDate).map(fmtDate).join(' – ') },
    { key: 'quarter', label: 'This Quarter', sub: presetRange('quarter', refDate).map(fmtDate).join(' – ') },
    { key: 'year',    label: 'This Year',    sub: presetRange('year',    refDate).map(fmtDate).join(' – ') },
    { key: 'custom',  label: 'Custom Range', sub: 'Pick start & end date' },
  ]

  const displayLabel = presetLabel(preset, dateFrom, dateTo, refDate)
  const subLabel     = dateFrom && dateTo && preset !== 'month' && preset !== 'quarter' && preset !== 'year'
    ? null
    : dateFrom && dateTo
      ? `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
      : null

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          height: 44, padding: '0 16px',
          borderRadius: 10, border: '1px solid rgb(var(--border) / 0.18)',
          background: open ? 'rgb(var(--bg-subtle))' : 'rgb(var(--bg-surface))',
          cursor: 'pointer', outline: 'none', minWidth: 220,
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: '#0E2841', flexShrink: 0 }}>date_range</span>
        <div style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'rgb(var(--fg-1))', lineHeight: 1.3, letterSpacing: '-0.01em' }}>
            {displayLabel}
          </p>
          {subLabel && (
            <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginTop: 1, textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 500 }}>
              {subLabel}
            </p>
          )}
        </div>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'rgb(var(--fg-3))', flexShrink: 0 }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 60,
          background: 'rgb(var(--bg-surface))',
          border: '1px solid rgb(var(--border) / 0.12)',
          borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.14)',
          width: 320, overflow: 'hidden',
        }}>
          {/* Preset list */}
          <div style={{ padding: '8px 0' }}>
            <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgb(var(--fg-3))', padding: '4px 16px 6px' }}>
              Quick select
            </p>
            {PRESETS.map(p => {
              const active = preset === p.key
              return (
                <button key={p.key}
                  onClick={() => applyPreset(p.key)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    width: '100%', padding: '10px 16px', cursor: 'pointer', textAlign: 'left',
                    background: active ? 'rgb(14 40 65 / 0.06)' : 'transparent',
                    borderLeft: active ? '3px solid #0E2841' : '3px solid transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgb(var(--bg-subtle))' }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  <div>
                    <p style={{ fontSize: 13, fontWeight: active ? 700 : 500, color: active ? '#0E2841' : 'rgb(var(--fg-1))', lineHeight: 1.3 }}>
                      {p.label}
                    </p>
                    <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 1 }}>{p.sub}</p>
                  </div>
                  {active && <span className="material-symbols-rounded" style={{ fontSize: 16, color: '#0E2841' }}>check</span>}
                </button>
              )
            })}
          </div>

          {/* Custom date inputs */}
          {(localPreset === 'custom' || preset === 'custom') && (
            <div style={{ padding: '12px 16px 16px', borderTop: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--bg-subtle))' }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                Custom range
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <div>
                  <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginBottom: 4 }}>From</p>
                  <input type="date" className="form-input text-sm" value={customFrom}
                    onChange={e => setCF(e.target.value)} style={{ width: '100%' }} />
                </div>
                <div>
                  <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginBottom: 4 }}>To</p>
                  <input type="date" className="form-input text-sm" value={customTo}
                    onChange={e => setCT(e.target.value)} style={{ width: '100%' }} />
                </div>
              </div>
              <button onClick={applyCustom} disabled={!customFrom || !customTo}
                className="btn btn-primary w-full gap-2 disabled:opacity-50">
                <span className="material-symbols-rounded text-[16px]">check</span>Apply Range
              </button>
            </div>
          )}

          {/* Available days summary */}
          {uploads.length > 0 && (
            <div style={{ padding: '10px 16px', borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
              <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 12, verticalAlign: 'middle', marginRight: 4 }}>info</span>
                Data loaded for <strong>{uploads.length}</strong> day{uploads.length > 1 ? 's' : ''} ·{' '}
                {fmtDate(uploads[uploads.length - 1].txn_date)} – {fmtDate(uploads[0].txn_date)}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   FILTER CHIPS
   ══════════════════════════════════════════════════════════════════ */

const CHIP_BASE = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  height: 34, padding: '0 12px', borderRadius: 8, border: '1px solid',
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  transition: 'all 0.12s', userSelect: 'none', outline: 'none',
}
const CHIP_OFF = { ...CHIP_BASE, background: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg-2))', borderColor: 'rgb(var(--border) / 0.2)' }
const CHIP_ON  = { ...CHIP_BASE, background: '#0E2841', color: '#fff', borderColor: '#0E2841' }
const CHIP_DR  = { ...CHIP_BASE, background: '#FEF2F2', color: '#C00000', borderColor: '#FECACA' }
const CHIP_CR  = { ...CHIP_BASE, background: '#F0FDF4', color: '#059669', borderColor: '#BBF7D0' }

function DropItem({ label, selected, onClick, dot }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '8px 14px', fontSize: 13, textAlign: 'left',
        color: selected ? '#0E2841' : 'rgb(var(--fg-2))', fontWeight: selected ? 600 : 400,
        background: hov && !selected ? 'rgb(var(--bg-subtle))' : selected ? 'rgb(14 40 65 / 0.05)' : 'transparent',
        cursor: 'pointer', gap: 10,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />}
        {label}
      </div>
      {selected && <span className="material-symbols-rounded" style={{ fontSize: 14, color: '#0E2841' }}>check</span>}
    </button>
  )
}

function FilterChip({ label, active, onClear, children, maxH = 260 }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    function h(e) { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={active ? CHIP_ON : CHIP_OFF} onClick={() => setOpen(v => !v)}>
        {label}
        {active
          ? <span className="material-symbols-rounded" style={{ fontSize: 14, lineHeight: 1, opacity: 0.75, marginLeft: 2 }}
              onClick={e => { e.stopPropagation(); onClear(); setOpen(false) }}>close</span>
          : <span className="material-symbols-rounded" style={{ fontSize: 14, lineHeight: 1, opacity: 0.4 }}>expand_more</span>}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 50,
          background: 'rgb(var(--bg-surface))', borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)', border: '1px solid rgb(var(--border) / 0.1)',
          minWidth: 190, overflow: 'hidden',
        }}>
          <div style={{ maxHeight: maxH, overflowY: 'auto', paddingTop: 4, paddingBottom: 4 }}>
            {children}
          </div>
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   KPI CARD
   ══════════════════════════════════════════════════════════════════ */

function KPI({ label, value, sub, icon, accent = '#0E2841', tooltip, valueColor }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"', color: valueColor || 'rgb(var(--fg-1))' }}>
        {value}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

/* ── Branch summary card ── */
function BranchCard({ branches }) {
  if (!branches?.length) return (
    <div className="card p-5 flex items-center justify-center">
      <p className="text-sm text-slate-400">No branch data</p>
    </div>
  )
  return (
    <div className="card p-5">
      <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>By Branch</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {branches.map((b, i) => {
          const net    = Number(b.total_cr) - Number(b.total_dr)
          const isPos  = net >= 0
          const pctDr  = Number(b.total_dr) + Number(b.total_cr) > 0
            ? (Number(b.total_dr) / (Number(b.total_dr) + Number(b.total_cr))) * 100
            : 50
          return (
            <div key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'rgb(var(--fg-1))', lineHeight: 1.3 }}>{b.branch_name}</p>
                  <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 2 }}>
                    {Number(b.txn_count).toLocaleString()} txns · {Number(b.accounts).toLocaleString()} accounts
                  </p>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: isPos ? '#059669' : '#C00000', fontVariantNumeric: 'tabular-nums' }}>
                  {isPos ? '+' : ''}{fmtAmt(net)}
                </span>
              </div>
              {/* DR/CR bar */}
              <div style={{ height: 6, borderRadius: 3, background: 'rgb(var(--bg-subtle))', overflow: 'hidden', display: 'flex' }}>
                <div style={{ width: `${pctDr}%`, background: '#C00000', opacity: 0.7 }} />
                <div style={{ flex: 1, background: '#10B981', opacity: 0.7 }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 10, color: '#C00000', fontVariantNumeric: 'tabular-nums' }}>DR {fmtAmt(b.total_dr)}</span>
                <span style={{ fontSize: 10, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>CR {fmtAmt(b.total_cr)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */

export default function Eod() {
  const navigate = useNavigate()
  const [uploads,     setUploads]     = useState([])
  const [dateFrom,    setDateFrom]    = useState(null)
  const [dateTo,      setDateTo]      = useState(null)
  const [preset,      setPreset]      = useState('month')
  const [summary,     setSummary]     = useState(null)
  const [byProduct,   setByProduct]   = useState([])
  const [byType,      setByType]      = useState([])
  const [byBranch,    setByBranch]    = useState([])
  const [trend,       setTrend]       = useState([])
  const [txns,        setTxns]        = useState([])
  const [totalRows,   setTotalRows]   = useState(0)
  const [loading,     setLoading]     = useState(false)
  const [loadingTbl,  setLoadingTbl]  = useState(false)
  const [exporting,   setExporting]   = useState(false)
  const [page,        setPage]        = useState(0)

  // Filters
  const [branch,   setBranch]   = useState('')
  const [product,  setProduct]  = useState('')
  const [txnType,  setTxnType]  = useState('')
  const [sign,     setSign]     = useState('')
  const [search,   setSearch]   = useState('')

  const PAGE_SIZE = 200

  async function loadUploads() {
    try {
      const data = await apiFetch('/api/eod/uploads')
      setUploads(data)
      if (data.length && !dateFrom) {
        // Default to the month of the latest upload
        const refDate = data[0].txn_date
        const [f, t]  = presetRange('month', refDate)
        setDateFrom(f); setDateTo(t); setPreset('month')
      }
    } catch (_) {}
  }

  useEffect(() => { loadUploads() }, [])

  function handleDateChange(f, t, p) {
    setDateFrom(f); setDateTo(t); setPreset(p)
    setPage(0)
  }

  const loadSummary = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const p = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
      if (branch)  p.set('branch', branch)
      if (product) p.set('product', product)
      if (txnType) p.set('txn_type', txnType)
      if (sign)    p.set('sign', sign)

      const [sum, prod, typ, br, tr] = await Promise.all([
        apiFetch(`/api/eod/summary?${p}`),
        apiFetch(`/api/eod/by-product?date_from=${dateFrom}&date_to=${dateTo}${branch ? `&branch=${branch}` : ''}${txnType ? `&txn_type=${txnType}` : ''}${sign ? `&sign=${sign}` : ''}`),
        apiFetch(`/api/eod/by-type?date_from=${dateFrom}&date_to=${dateTo}${branch ? `&branch=${branch}` : ''}${product ? `&product=${product}` : ''}${sign ? `&sign=${sign}` : ''}`),
        apiFetch(`/api/eod/by-branch?date_from=${dateFrom}&date_to=${dateTo}`),
        apiFetch(`/api/eod/trend?date_from=${dateFrom}&date_to=${dateTo}`),
      ])
      setSummary(sum); setByProduct(prod); setByType(typ); setByBranch(br); setTrend(tr)
    } finally { setLoading(false) }
  }, [dateFrom, dateTo, branch, product, txnType, sign])

  useEffect(() => { loadSummary() }, [loadSummary])

  const loadTxns = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoadingTbl(true)
    try {
      const p = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      if (branch)  p.set('branch', branch)
      if (product) p.set('product', product)
      if (txnType) p.set('txn_type', txnType)
      if (sign)    p.set('sign', sign)
      if (search)  p.set('q', search)
      const res = await apiFetch(`/api/eod/transactions?${p}`)
      setTxns(res.data || []); setTotalRows(res.total || 0)
    } finally { setLoadingTbl(false) }
  }, [dateFrom, dateTo, branch, product, txnType, sign, search, page])

  useEffect(() => { loadTxns() }, [loadTxns])

  async function exportCSV() {
    if (!dateFrom || !dateTo) return
    setExporting(true)
    try {
      const p = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
      if (branch)  p.set('branch', branch)
      if (product) p.set('product', product)
      if (txnType) p.set('txn_type', txnType)
      if (sign)    p.set('sign', sign)
      if (search)  p.set('q', search)
      const API   = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const token = localStorage.getItem('o3c_token')
      const res   = await fetch(`${API}/api/eod/transactions/export?${p}`, { headers: { Authorization: `Bearer ${token}` } })
      const blob  = await res.blob()
      const url   = URL.createObjectURL(blob)
      const a     = document.createElement('a')
      a.href = url; a.download = `eod_${dateFrom}_${dateTo}.csv`; a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }

  function resetFilters() { setBranch(''); setProduct(''); setTxnType(''); setSign(''); setSearch(''); setPage(0) }

  const s = summary || {}
  const net    = Number(s.net_movement || 0)
  const netPos = net >= 0
  const activeFilters = [branch, product, txnType, sign].filter(Boolean).length
  const allCategories = [...new Set(byType.map(r => r.txn_category))]
  const refDate = uploads.length > 0 ? uploads[0].txn_date : toISO(new Date())

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">EOD Report</h1>
          <p className="text-sm text-slate-500 mt-0.5">Daily financial card account transactions</p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <button onClick={() => window.print()} className="btn btn-ghost gap-1.5 text-sm">
            <span className="material-symbols-rounded text-[17px]">print</span>PDF
          </button>
          <button onClick={exportCSV} disabled={exporting || !dateFrom}
            className="btn btn-primary gap-1.5 text-sm disabled:opacity-60">
            {exporting
              ? <><div className="spinner" style={{ width: 13, height: 13, borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.25)' }} />Exporting…</>
              : <><span className="material-symbols-rounded text-[17px]">download</span>Export CSV</>}
          </button>
        </div>
      </div>

      {/* ── Empty state ── */}
      {uploads.length === 0 && (
        <div className="card p-12 flex flex-col items-center text-slate-400">
          <span className="material-symbols-rounded text-[48px] opacity-25 mb-4">receipt_long</span>
          <p className="font-semibold text-slate-600 dark:text-slate-300">No EOD files loaded yet</p>
          <p className="text-sm mt-1 mb-5">Upload EODTXN files to generate this report.</p>
          <button onClick={() => navigate('/uploads')} className="btn btn-primary gap-2">
            <span className="material-symbols-rounded text-[17px]">upload_file</span>Go to Data Uploads
          </button>
        </div>
      )}

      {uploads.length > 0 && (
        <>
          {/* ── Filter bar ── */}
          <div className="no-print mb-6">
            {/* Row 1: Date range + search */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
              <DateRangePicker
                uploads={uploads}
                dateFrom={dateFrom}
                dateTo={dateTo}
                preset={preset}
                onChange={handleDateChange}
              />
              <div style={{ flex: 1 }} />
              <div style={{ position: 'relative' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'rgb(var(--fg-3))', pointerEvents: 'none' }}>search</span>
                <input className="form-input" style={{ paddingLeft: 32, height: 34, fontSize: 13, width: 210 }}
                  placeholder="CIF, account, customer…"
                  value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} />
              </div>
            </div>

            {/* Row 2: Filter chips */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {/* Branch */}
              <FilterChip label={branch ? (s.branches?.find(b => b.branch_code === branch)?.branch_name || branch) : 'Branch'} active={!!branch} onClear={() => setBranch('')}>
                <DropItem label="All Branches" selected={!branch} onClick={() => { setBranch(''); setPage(0) }} />
                {(s.branches || []).map(b => (
                  <DropItem key={b.branch_code} label={b.branch_name} selected={branch === b.branch_code} onClick={() => { setBranch(b.branch_code); setPage(0) }} />
                ))}
              </FilterChip>

              {/* Product */}
              <FilterChip label={product ? (s.products?.find(p => p.product_code === product)?.product_name || product) : 'Product'} active={!!product} onClear={() => setProduct('')} maxH={220}>
                <DropItem label="All Products" selected={!product} onClick={() => { setProduct(''); setPage(0) }} />
                {(s.products || []).map(p => (
                  <DropItem key={p.product_code} label={p.product_name} selected={product === p.product_code} onClick={() => { setProduct(p.product_code); setPage(0) }} />
                ))}
              </FilterChip>

              {/* Txn Type */}
              <FilterChip label={txnType || 'Type'} active={!!txnType} onClear={() => setTxnType('')} maxH={280}>
                <DropItem label="All Types" selected={!txnType} onClick={() => { setTxnType(''); setPage(0) }} />
                {allCategories.map(cat => (
                  <DropItem key={cat} label={cat} selected={txnType === cat} onClick={() => { setTxnType(cat); setPage(0) }} dot={txnColor(cat)} />
                ))}
              </FilterChip>

              <div style={{ width: 1, height: 20, background: 'rgb(var(--border) / 0.15)' }} />

              {/* DR/CR */}
              <button style={sign === 'DR' ? CHIP_DR : CHIP_OFF} onClick={() => { setSign(sign === 'DR' ? '' : 'DR'); setPage(0) }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_upward</span>Debits only
              </button>
              <button style={sign === 'CR' ? CHIP_CR : CHIP_OFF} onClick={() => { setSign(sign === 'CR' ? '' : 'CR'); setPage(0) }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_downward</span>Credits only
              </button>

              {/* Clear */}
              {(activeFilters > 0 || search) && (
                <>
                  <div style={{ width: 1, height: 20, background: 'rgb(var(--border) / 0.15)' }} />
                  <button onClick={resetFilters}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, color: 'rgb(var(--fg-3))', cursor: 'pointer', background: 'none', border: 'none', padding: '4px 2px' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#C00000'}
                    onMouseLeave={e => e.currentTarget.style.color = 'rgb(var(--fg-3))'}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>filter_alt_off</span>
                    Clear filters
                  </button>
                </>
              )}
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-3 text-slate-400 py-10"><div className="spinner" />Loading report…</div>
          ) : (
            <>
              {/* ── KPI Row ── */}
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-5">
                <KPI label="Total Volume"    value={fmtAmt(s.total_volume)}   icon="payments"       accent="#0E2841" tooltip="Combined value of all DR and CR transactions in the selected period" />
                <KPI label="Net Movement"    value={(netPos ? '+' : '') + fmtAmt(net)} icon="swap_vert" accent={netPos ? '#059669' : '#C00000'}
                  valueColor={netPos ? '#059669' : '#C00000'}
                  tooltip="Total credits minus total debits — positive means more money came in than went out" />
                <KPI label="Total Debits"    value={fmtAmt(s.total_dr)}   icon="arrow_upward"   accent="#C00000" tooltip="Sum of all debit transactions in the period" />
                <KPI label="Total Credits"   value={fmtAmt(s.total_cr)}   icon="arrow_downward" accent="#059669" tooltip="Sum of all credit transactions in the period" />
                <KPI label="Transactions"    value={fmtNum(s.txn_count)}  icon="receipt_long"   accent="#8B5CF6"
                  tooltip="Total number of transaction lines in the selected period"
                  sub={s.days_covered > 1 ? `across ${s.days_covered} days` : undefined} />
                <KPI label="Active Accounts" value={fmtNum(s.active_accounts)} icon="credit_card" accent="#0891B2"
                  tooltip="Distinct card accounts that had at least one transaction"
                  sub={`${fmtNum(s.active_cifs)} customers`} />
              </div>

              {/* ── Charts row ── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
                <ProgressListCard
                  title="Transaction Types"
                  data={byType.map(r => ({ ...r, _label: r.txn_category, _value: Number(r.total_volume) }))}
                  nameKey="_label"
                  valueKey="_value"
                  currency
                  maxItems={10}
                />
                <ProgressListCard
                  title="By Product"
                  data={byProduct.map(r => ({ ...r, _label: r.product_name || r.product_code, _value: Number(r.total_volume) }))}
                  nameKey="_label"
                  valueKey="_value"
                  currency
                  maxItems={10}
                />
                <BranchCard branches={byBranch} />
              </div>

              {/* ── Trend chart ── */}
              {trend.length > 1 && (
                <div className="mb-5">
                  <AreaChartCard
                    title={`Daily Volume — ${presetLabel(preset, dateFrom, dateTo, refDate)}`}
                    data={trend}
                    xKey="label"
                    areas={[
                      { key: 'total_dr', label: 'Debits',  color: '#C00000' },
                      { key: 'total_cr', label: 'Credits', color: '#10B981' },
                    ]}
                    height={200}
                    currency
                  />
                </div>
              )}

              {/* ── Transaction table ── */}
              <div className="card overflow-hidden">
                <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Transactions</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {dateFrom === dateTo ? fmtDateLong(dateFrom) : `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`}
                    </p>
                  </div>
                  <span className="badge badge-grey">{totalRows.toLocaleString()} rows</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Customer</th>
                        <th>Account</th>
                        <th>Product</th>
                        <th>Type</th>
                        <th>Card</th>
                        <th>Merchant</th>
                        <th>Description</th>
                        <th className="text-right">Amount</th>
                        <th>DR/CR</th>
                        <th className="text-right">Balance</th>
                        <th>Trace #</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingTbl ? (
                        <tr><td colSpan={12} className="text-center py-10 text-slate-400">
                          <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
                        </td></tr>
                      ) : txns.length === 0 ? (
                        <tr><td colSpan={12} className="text-center py-10">
                          <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">receipt_long</span>
                          <p className="text-sm text-slate-400">No transactions for this period or filter combination</p>
                        </td></tr>
                      ) : txns.map((t, i) => {
                        const isDr = t.sign === 'DR'
                        return (
                          <tr key={i}>
                            <td className="text-xs text-slate-500 whitespace-nowrap">
                              {fmtDate(t.txn_date)}
                            </td>
                            <td>
                              <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate max-w-[130px]" title={t.customer}>
                                {t.customer || <span className="text-slate-300">—</span>}
                              </p>
                              <p className="text-xs text-slate-400 font-mono">{t.cif}</p>
                            </td>
                            <td className="font-mono text-xs text-slate-500">{t.account_no}</td>
                            <td className="text-xs text-slate-600 dark:text-slate-400 max-w-[90px] truncate" title={t.product_name}>
                              {t.product_name}
                            </td>
                            <td>
                              <span style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 20,
                                background: txnColor(t.txn_category) + '15',
                                color: txnColor(t.txn_category), whiteSpace: 'nowrap',
                              }}>
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: txnColor(t.txn_category), flexShrink: 0 }} />
                                {t.txn_category}
                              </span>
                            </td>
                            <td className="font-mono text-xs text-slate-400">{t.card_num || '—'}</td>
                            <td className="text-xs text-slate-600 dark:text-slate-400 max-w-[110px] truncate" title={t.merchant_name}>
                              {t.merchant_name || '—'}
                            </td>
                            <td className="text-xs text-slate-500">{t.description}</td>
                            <td className="text-right">
                              <p style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"', color: isDr ? '#C00000' : '#059669' }}>
                                {fmtExact(t.amount)}
                              </p>
                            </td>
                            <td>
                              <span style={{
                                display: 'inline-flex', alignItems: 'center',
                                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                                background: isDr ? 'rgb(192 0 0 / 0.08)' : 'rgb(5 150 105 / 0.08)',
                                color: isDr ? '#C00000' : '#059669',
                              }}>
                                {isDr ? '↑ DR' : '↓ CR'}
                              </span>
                            </td>
                            <td className="text-right text-xs tabular-nums" style={{ fontFeatureSettings: '"tnum"', color: Number(t.balance) < 0 ? '#C00000' : 'rgb(var(--fg-2))' }}>
                              {fmtExact(t.balance)}
                            </td>
                            <td className="font-mono text-xs text-slate-400">{t.trace_num}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {totalRows > PAGE_SIZE && (
                  <div className="px-5 py-3 flex items-center justify-between no-print" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
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
            </>
          )}
        </>
      )}
    </div>
  )
}
