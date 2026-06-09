import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../hooks/useApi.js'
import { ProgressListCard, AreaChartCard, InfoTooltip, fmt, fmtNum } from '../components/Charts.jsx'

/* ══════════════════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════════════════ */

const TXN_COLORS = {
  'Transfer Out':           '#C00000',
  'Transfer In':            '#10B981',
  'Purchase':               '#3B82F6',
  'Utility Payment':        '#8B5CF6',
  'Cash Advance':           '#F59E0B',
  'Bank Payment':           '#0891B2',
  'Purchase Reversal':      '#94A3B8',
  'Cash Advance Reversal':  '#94A3B8',
  'Bank Payment Reversal':  '#94A3B8',
  'Utility Payment Reversal': '#94A3B8',
  'Other':                  '#64748B',
}

function txnColor(cat) { return TXN_COLORS[cat] || '#64748B' }

function fmtAmt(v) {
  const n = Number(v || 0)
  if (Math.abs(n) >= 1_000_000) return '₦' + (n / 1_000_000).toFixed(2) + 'M'
  if (Math.abs(n) >= 1_000)     return '₦' + (n / 1_000).toFixed(1) + 'K'
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtExact(v) {
  return '₦' + Number(v || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/* ══════════════════════════════════════════════════════════════════
   FILTER PRIMITIVES  (same style as Income report)
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
        color: selected ? '#0E2841' : 'rgb(var(--fg-2))',
        fontWeight: selected ? 600 : 400,
        background: hov && !selected ? 'rgb(var(--bg-subtle))' : selected ? 'rgb(14 40 65 / 0.05)' : 'transparent',
        cursor: 'pointer', transition: 'background 0.1s', gap: 10,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />}
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

/* ── Day Navigator with picker ── */
function DayNavigator({ uploads, uploadId, onChange }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const ref = useRef()
  const idx     = uploads.findIndex(u => u.id === uploadId)
  const current = uploads[idx]
  const canPrev = idx < uploads.length - 1
  const canNext = idx > 0

  useEffect(() => {
    if (!pickerOpen) return
    function h(e) { if (!ref.current?.contains(e.target)) setPickerOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [pickerOpen])

  function fmtD(d) {
    if (!d) return '—'
    return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  }

  function fmtShort(d) {
    if (!d) return '—'
    const dt = new Date(d + 'T00:00:00')
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  const navBtn = (enabled, onClick, icon) => (
    <button disabled={!enabled} onClick={onClick} style={{
      width: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgb(var(--fg-2))', opacity: enabled ? 1 : 0.25,
      cursor: enabled ? 'pointer' : 'default',
      background: 'transparent', border: 'none', outline: 'none', flexShrink: 0,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{icon}</span>
    </button>
  )

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch' }}>
      <div style={{
        display: 'inline-flex', alignItems: 'stretch',
        borderRadius: 10, border: '1px solid rgb(var(--border) / 0.18)',
        background: 'rgb(var(--bg-surface))', overflow: 'hidden',
      }}>
        {navBtn(canPrev, () => onChange(uploads[idx + 1].id), 'chevron_left')}
        <button onClick={() => setPickerOpen(v => !v)} style={{
          padding: '7px 18px', textAlign: 'center', minWidth: 200,
          borderLeft: '1px solid rgb(var(--border) / 0.12)',
          borderRight: '1px solid rgb(var(--border) / 0.12)',
          background: pickerOpen ? 'rgb(var(--bg-subtle))' : 'transparent',
          cursor: 'pointer', border: 'none', outline: 'none',
          borderLeft: '1px solid rgb(var(--border) / 0.12)',
          borderRight: '1px solid rgb(var(--border) / 0.12)',
        }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: 'rgb(var(--fg-1))', lineHeight: 1.3, letterSpacing: '-0.01em' }}>
            {current ? fmtD(current.txn_date) : '—'}
          </p>
          <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 500 }}>
            {current ? `${(current.txn_count || 0).toLocaleString()} transactions` : 'Click to select'}
          </p>
        </button>
        {navBtn(canNext, () => onChange(uploads[idx - 1].id), 'chevron_right')}
      </div>

      {pickerOpen && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: '50%',
          transform: 'translateX(-50%)', zIndex: 60,
          background: 'rgb(var(--bg-surface))', borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
          border: '1px solid rgb(var(--border) / 0.12)',
          minWidth: 280, maxHeight: 340, overflowY: 'auto', padding: '6px 0',
        }}>
          <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgb(var(--fg-3))', padding: '6px 14px 4px' }}>
            Select day
          </p>
          {uploads.map(u => {
            const sel = u.id === uploadId
            return (
              <button key={u.id} onClick={() => { onChange(u.id); setPickerOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '9px 14px', cursor: 'pointer', textAlign: 'left',
                  background: sel ? 'rgb(14 40 65 / 0.06)' : 'transparent',
                }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: sel ? 700 : 500, color: sel ? '#0E2841' : 'rgb(var(--fg-1))', lineHeight: 1.3 }}>
                    {fmtD(u.txn_date)}
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ fontSize: 10, fontWeight: 500, color: '#059669', background: 'rgb(5 150 105 / 0.08)', padding: '2px 7px', borderRadius: 20 }}>
                    {(u.txn_count || 0).toLocaleString()} txns
                  </span>
                  {sel && <span className="material-symbols-rounded" style={{ fontSize: 16, color: '#0E2841' }}>check</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── KPI Card ── */
function KPI({ label, value, sub, icon, accent = '#0E2841', tooltip, valueStyle }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"', color: valueStyle?.color || 'rgb(var(--fg-1))' }}>
        {value}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

/* ── Branch summary card ── */
function BranchCard({ branches }) {
  if (!branches?.length) return null
  return (
    <div className="card p-5">
      <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 14 }}>
        By Branch
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {branches.map((b, i) => {
          const net    = Number(b.total_cr) - Number(b.total_dr)
          const isPos  = net >= 0
          return (
            <div key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--fg-1))' }}>{b.branch_name}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: isPos ? '#059669' : '#C00000', fontVariantNumeric: 'tabular-nums' }}>
                  {isPos ? '+' : ''}{fmtAmt(net)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <span style={{ fontSize: 11, color: '#C00000' }}>DR {fmtAmt(b.total_dr)}</span>
                <span style={{ fontSize: 11, color: '#059669' }}>CR {fmtAmt(b.total_cr)}</span>
                <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{Number(b.txn_count).toLocaleString()} txns</span>
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
  const [uploadId,    setUploadId]    = useState(null)
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
      if (data.length && !uploadId) setUploadId(data[0].id)
    } catch (_) {}
  }

  useEffect(() => { loadUploads() }, [])

  const loadSummary = useCallback(async () => {
    if (!uploadId) return
    setLoading(true)
    try {
      const p = new URLSearchParams({ upload_id: uploadId })
      if (branch)  p.set('branch', branch)
      if (product) p.set('product', product)
      if (txnType) p.set('txn_type', txnType)
      if (sign)    p.set('sign', sign)

      const [sum, prod, typ, br, tr] = await Promise.all([
        apiFetch(`/api/eod/summary?${p}`),
        apiFetch(`/api/eod/by-product?upload_id=${uploadId}${branch ? `&branch=${branch}` : ''}${sign ? `&sign=${sign}` : ''}`),
        apiFetch(`/api/eod/by-type?upload_id=${uploadId}${branch ? `&branch=${branch}` : ''}${product ? `&product=${product}` : ''}`),
        apiFetch(`/api/eod/by-branch?upload_id=${uploadId}`),
        apiFetch('/api/eod/trend'),
      ])
      setSummary(sum); setByProduct(prod); setByType(typ); setByBranch(br); setTrend(tr)
    } finally { setLoading(false) }
  }, [uploadId, branch, product, txnType, sign])

  useEffect(() => { loadSummary() }, [loadSummary])

  const loadTxns = useCallback(async () => {
    if (!uploadId) return
    setLoadingTbl(true)
    try {
      const p = new URLSearchParams({ upload_id: uploadId, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      if (branch)  p.set('branch', branch)
      if (product) p.set('product', product)
      if (txnType) p.set('txn_type', txnType)
      if (sign)    p.set('sign', sign)
      if (search)  p.set('q', search)
      const res = await apiFetch(`/api/eod/transactions?${p}`)
      setTxns(res.data || []); setTotalRows(res.total || 0)
    } finally { setLoadingTbl(false) }
  }, [uploadId, branch, product, txnType, sign, search, page])

  useEffect(() => { loadTxns() }, [loadTxns])

  async function exportCSV() {
    if (!uploadId) return
    setExporting(true)
    try {
      const p = new URLSearchParams({ upload_id: uploadId })
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
      a.href = url; a.download = `eod_${currentUpload?.txn_date || uploadId}.csv`; a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }

  function resetFilters() { setBranch(''); setProduct(''); setTxnType(''); setSign(''); setSearch(''); setPage(0) }

  const currentUpload = uploads.find(u => u.id === uploadId)
  const s = summary || {}
  const net = Number(s.net_movement || 0)
  const netPos = net >= 0
  const activeFilters = [branch, product, txnType, sign].filter(Boolean).length

  // Distinct categories for filter dropdown
  const allCategories = [...new Set(byType.map(r => r.txn_category))]

  // ProgressListCard data enriched with DR/CR breakdown label
  const typeChartData = byType.map(r => ({
    ...r,
    _label: r.txn_category,
    _value: Number(r.total_volume),
  }))

  const productChartData = byProduct.map(r => ({
    ...r,
    _label: r.product_name || r.product_code,
    _value: Number(r.total_volume),
  }))

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
          <button onClick={exportCSV} disabled={exporting || !uploadId}
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
            {/* Row 1: Day navigator + search */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
              <DayNavigator uploads={uploads} uploadId={uploadId} onChange={id => { setUploadId(id); setPage(0) }} />
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
              <FilterChip label={branch ? (s.branches?.find(b => b.code === branch)?.name || branch) : 'Branch'} active={!!branch} onClear={() => setBranch('')}>
                <DropItem label="All Branches" selected={!branch} onClick={() => { setBranch(''); setPage(0) }} />
                {(s.branches || []).map(b => (
                  <DropItem key={b.code} label={b.name} selected={branch === b.code} onClick={() => { setBranch(b.code); setPage(0) }} />
                ))}
              </FilterChip>

              {/* Product */}
              <FilterChip label={product ? (s.products?.find(p => p.code === product)?.name || product) : 'Product'} active={!!product} onClear={() => setProduct('')} maxH={220}>
                <DropItem label="All Products" selected={!product} onClick={() => { setProduct(''); setPage(0) }} />
                {(s.products || []).map(p => (
                  <DropItem key={p.code} label={p.name} selected={product === p.code} onClick={() => { setProduct(p.code); setPage(0) }} />
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

              {/* DR/CR toggle */}
              <button style={sign === 'DR' ? CHIP_DR : CHIP_OFF} onClick={() => { setSign(sign === 'DR' ? '' : 'DR'); setPage(0) }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_upward</span>Debits
              </button>
              <button style={sign === 'CR' ? CHIP_CR : CHIP_OFF} onClick={() => { setSign(sign === 'CR' ? '' : 'CR'); setPage(0) }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_downward</span>Credits
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
                    Clear {activeFilters + (search ? 1 : 0)} filter{(activeFilters + (search ? 1 : 0)) > 1 ? 's' : ''}
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
                <KPI label="Total Volume"    value={fmtAmt(s.total_volume)}   icon="payments"        accent="#0E2841" tooltip="Combined value of all DR and CR transactions for the day" />
                <KPI label="Net Movement"    value={(netPos ? '+' : '') + fmtAmt(net)} icon="swap_vert" accent={netPos ? '#059669' : '#C00000'}
                  valueStyle={{ color: netPos ? '#059669' : '#C00000' }}
                  tooltip="Total credits minus total debits — positive means more money flowed in than out" />
                <KPI label="Total Debits"    value={fmtAmt(s.total_dr)}   icon="arrow_upward"    accent="#C00000" tooltip="Sum of all debit (DR) transactions" />
                <KPI label="Total Credits"   value={fmtAmt(s.total_cr)}   icon="arrow_downward"  accent="#059669" tooltip="Sum of all credit (CR) transactions" />
                <KPI label="Txn Count"       value={fmtNum(s.txn_count)}  icon="receipt_long"    accent="#8B5CF6" tooltip="Total number of individual transaction lines for the day" sub={`avg ${fmtAmt(s.avg_txn_value)} / txn`} />
                <KPI label="Active Accounts" value={fmtNum(s.active_accounts)} icon="credit_card" accent="#0891B2" tooltip="Number of distinct card accounts that had at least one transaction" sub={`${fmtNum(s.active_cifs)} customers`} />
              </div>

              {/* ── Charts row ── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
                <ProgressListCard
                  title="Transaction Types"
                  data={typeChartData}
                  nameKey="_label"
                  valueKey="_value"
                  currency
                  maxItems={10}
                />
                <ProgressListCard
                  title="By Product"
                  data={productChartData}
                  nameKey="_label"
                  valueKey="_value"
                  currency
                  maxItems={10}
                />
                <BranchCard branches={byBranch} />
              </div>

              {/* ── Trend (if multiple days) ── */}
              {trend.length > 1 && (
                <div className="mb-5">
                  <AreaChartCard
                    title="Daily Volume — December"
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
                      {currentUpload ? new Date(currentUpload.txn_date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''}
                    </p>
                  </div>
                  <span className="badge badge-grey">{totalRows.toLocaleString()} rows</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Account</th>
                        <th>Product</th>
                        <th>Branch</th>
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
                          <p className="text-sm text-slate-400">No transactions match the current filters</p>
                        </td></tr>
                      ) : txns.map((t, i) => {
                        const isDr = t.sign === 'DR'
                        return (
                          <tr key={i}>
                            <td>
                              <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate max-w-[140px]" title={t.customer}>
                                {t.customer || <span className="text-slate-300">—</span>}
                              </p>
                              <p className="text-xs text-slate-400 font-mono">{t.cif}</p>
                            </td>
                            <td className="font-mono text-xs text-slate-500">{t.account_no}</td>
                            <td className="text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap max-w-[100px] truncate" title={t.product_name}>
                              {t.product_name}
                            </td>
                            <td className="text-xs text-slate-500 whitespace-nowrap">{t.branch_name}</td>
                            <td>
                              <span style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 20,
                                background: txnColor(t.txn_category) + '15',
                                color: txnColor(t.txn_category),
                                whiteSpace: 'nowrap',
                              }}>
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: txnColor(t.txn_category), flexShrink: 0 }} />
                                {t.txn_category}
                              </span>
                            </td>
                            <td className="font-mono text-xs text-slate-400">{t.card_num || '—'}</td>
                            <td className="text-xs text-slate-600 dark:text-slate-400 max-w-[120px] truncate" title={t.merchant_name}>
                              {t.merchant_name || '—'}
                            </td>
                            <td className="text-xs text-slate-500">{t.description}</td>
                            <td className="text-right">
                              <p style={{
                                fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                fontFeatureSettings: '"tnum"',
                                color: isDr ? '#C00000' : '#059669',
                              }}>
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
                            <td className="text-right tabular-nums text-xs text-slate-500" style={{ fontFeatureSettings: '"tnum"' }}>
                              {Number(t.balance) < 0
                                ? <span style={{ color: '#C00000' }}>{fmtExact(t.balance)}</span>
                                : fmtExact(t.balance)}
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
