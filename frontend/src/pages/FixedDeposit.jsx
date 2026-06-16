import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { InfoTooltip, fmtNum } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem, toISO } from '../components/FilterBar.jsx'

/* ══════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════ */

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function today() { return toISO(new Date()) }
function thisYearRange() {
  const d = new Date()
  return [toISO(new Date(d.getFullYear(), 0, 1)), toISO(d)]
}

function n(v) { return Number(v || 0) }

function fmtAmt(v, currency = 'NGN') {
  const x = n(v)
  const sym = currency === 'USD' ? '$' : '₦'
  if (Math.abs(x) >= 1_000_000_000) return sym + (x / 1_000_000_000).toFixed(2) + 'B'
  if (Math.abs(x) >= 1_000_000)     return sym + (x / 1_000_000).toFixed(2) + 'M'
  if (Math.abs(x) >= 1_000)         return sym + (x / 1_000).toFixed(1) + 'K'
  return sym + x.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDateShort(s) {
  if (!s) return '—'
  try { return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return s }
}

const TYPE_META = {
  inflow:      { color: '#059669', bg: '#F0FDF4', label: 'Inflow',      icon: 'arrow_downward' },
  liquidation: { color: '#C00000', bg: '#FEF2F2', label: 'Liquidation', icon: 'arrow_upward'   },
}

function TypeBadge({ type }) {
  const m = TYPE_META[type] || { color: '#64748B', bg: '#F8FAFC', label: type, icon: 'swap_horiz' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: m.bg, color: m.color, whiteSpace: 'nowrap',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{m.icon}</span>
      {m.label}
    </span>
  )
}

/* ══════════════════════════════════════════════════════════════════
   KPI CARD
   ══════════════════════════════════════════════════════════════════ */

function KPI({ label, value, sub, icon, accent = '#0E2841', valueColor, tooltip }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: valueColor || 'rgb(var(--fg-1))' }}>
        {value}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   TRANSACTION FORM (drawer)
   ══════════════════════════════════════════════════════════════════ */

const LOCATIONS = ['Lagos', 'Abuja']
const CURRENCIES = ['NGN', 'USD']

function TransactionForm({ initial, onSave, onClose }) {
  const [form, setForm] = useState({
    transaction_date: today(),
    customer_name: '',
    transaction_type: 'inflow',
    principal: '',
    interest_paid: '',
    gross_amount: '',
    usd_amount: '',
    ngn_amount: '',
    currency: 'NGN',
    location: 'Lagos',
    account_officer: '',
    maturity_date: '',
    tenor_days: '',
    rate: '',
    notes: '',
    ...initial,
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const payload = { ...form }
      for (const k of ['principal','interest_paid','gross_amount','usd_amount','ngn_amount','rate']) {
        payload[k] = payload[k] !== '' ? Number(payload[k]) : null
      }
      payload.tenor_days = payload.tenor_days !== '' ? Number(payload.tenor_days) : null
      for (const k of ['maturity_date']) {
        if (payload[k] === '') payload[k] = null
      }

      const url = initial?.id
        ? `/api/fixed-deposit/transactions/${initial.id}`
        : '/api/fixed-deposit/transactions'
      const method = initial?.id ? 'PUT' : 'POST'
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Save failed')
      const saved = await res.json()
      onSave(saved)
    } catch(e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const inp = (label, key, type = 'text', opts = {}) => (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</label>
      <input type={type} className="form-input w-full" style={{ height: 34, fontSize: 13 }}
        value={form[key] ?? ''} onChange={e => set(key, e.target.value)} {...opts} />
    </div>
  )

  const sel = (label, key, options) => (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</label>
      <select className="form-input w-full" style={{ height: 34, fontSize: 13 }}
        value={form[key] ?? ''} onChange={e => set(key, e.target.value)}>
        {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div style={{ flex: 1, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)' }} />
      <div className="flex flex-col h-full overflow-y-auto" style={{ width: 500, background: 'rgb(var(--bg-surface))', boxShadow: '-4px 0 32px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between px-6 py-5 flex-shrink-0" style={{ borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
          <div>
            <p className="text-base font-semibold text-slate-900 dark:text-white">
              {initial?.id ? 'Edit Transaction' : 'Book FD Transaction'}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">Fixed Deposit</p>
          </div>
          <button onClick={onClose} className="btn-icon">
            <span className="material-symbols-rounded text-[20px]">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">

            {/* Basic */}
            <div className="col-span-2">
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgb(var(--fg-3))', marginBottom: 12, borderBottom: '1px solid rgb(var(--border) / 0.1)', paddingBottom: 6 }}>
                Transaction Details
              </p>
            </div>
            {inp('Date', 'transaction_date', 'date')}
            {sel('Type', 'transaction_type', [
              { value: 'inflow', label: 'Inflow (New Deposit)' },
              { value: 'liquidation', label: 'Liquidation (Matured)' },
            ])}
            <div className="col-span-2">{inp('Customer Name', 'customer_name', 'text', { required: true, placeholder: 'Full name or company' })}</div>
            {sel('Currency', 'currency', CURRENCIES.map(c => ({ value: c, label: c })))}
            {sel('Location', 'location', ['', ...LOCATIONS].map(l => ({ value: l, label: l || '— Select —' })))}
            {inp('Account Officer', 'account_officer', 'text')}
            {inp('Maturity Date', 'maturity_date', 'date')}

            {/* Amounts */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgb(var(--fg-3))', marginBottom: 12, borderBottom: '1px solid rgb(var(--border) / 0.1)', paddingBottom: 6 }}>
                Amounts
              </p>
            </div>
            {inp('Principal', 'principal', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}
            {inp('Interest Paid', 'interest_paid', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}
            {inp('Gross Amount', 'gross_amount', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}
            {inp('NGN Amount', 'ngn_amount', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}
            {inp('USD Amount', 'usd_amount', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}

            {/* Terms */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgb(var(--fg-3))', marginBottom: 12, borderBottom: '1px solid rgb(var(--border) / 0.1)', paddingBottom: 6 }}>
                Terms
              </p>
            </div>
            {inp('Tenor (days)', 'tenor_days', 'number', { placeholder: '0', min: 1 })}
            {inp('Rate (% p.a.)', 'rate', 'number', { placeholder: '0.00', step: '0.01' })}

            {/* Notes */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Notes</label>
              <textarea className="form-input w-full" rows={3} style={{ fontSize: 13, resize: 'vertical' }}
                value={form.notes ?? ''} onChange={e => set('notes', e.target.value)} />
            </div>
          </div>

          {error && (
            <div className="mt-4 p-3 rounded-lg text-sm" style={{ background: '#FEF2F2', color: '#C00000', border: '1px solid #FECACA' }}>
              {error}
            </div>
          )}
        </form>

        <div className="flex-shrink-0 px-6 py-4 flex justify-end gap-3" style={{ borderTop: '1px solid rgb(var(--border) / 0.1)' }}>
          <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="btn btn-primary gap-2 disabled:opacity-60">
            {saving
              ? <><div className="spinner" style={{ width: 13, height: 13, borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.25)' }} />Saving…</>
              : <><span className="material-symbols-rounded text-[17px]">save</span>{initial?.id ? 'Update' : 'Book Transaction'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════════════════════ */

/* ── Dashboard tab ── */
function DashboardTab({ dateFrom, dateTo }) {
  const [summary,  setSummary]  = useState(null)
  const [trend,    setTrend]    = useState([])
  const [byLoc,    setByLoc]    = useState([])
  const [loading,  setLoading]  = useState(false)

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const p = `date_from=${dateFrom}&date_to=${dateTo}`
      const [sum, tr, loc] = await Promise.all([
        apiFetch(`/api/fixed-deposit/summary?${p}`),
        apiFetch(`/api/fixed-deposit/trend?${p}`),
        apiFetch(`/api/fixed-deposit/by-location?${p}`),
      ])
      setSummary(sum)
      setTrend(Array.isArray(tr) ? tr : [])
      setByLoc(Array.isArray(loc) ? loc : [])
    } finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="flex items-center gap-3 text-slate-400 py-12"><div className="spinner" />Loading…</div>
  if (!summary) return null

  const s = summary
  const netPos = n(s.net_position)
  const inflow  = n(s.total_inflow_ngn)
  const liquid  = n(s.total_liquidated)
  const maxTrend = Math.max(...trend.flatMap(r => [n(r.inflow), n(r.liquidation)]), 1)

  return (
    <div>
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-4 mb-5">
        <KPI label="Total Inflows" value={fmtAmt(inflow)} icon="arrow_downward" accent="#059669" valueColor="#059669"
          sub={`${fmtNum(s.inflow_count)} transactions`} />
        <KPI label="Total Liquidations" value={fmtAmt(liquid)} icon="arrow_upward" accent="#C00000" valueColor="#C00000"
          sub={`${fmtNum(s.liquidation_count)} transactions`} />
        <KPI label="Total Interest" value={fmtAmt(s.total_interest)} icon="percent" accent="#8B5CF6" />
        <KPI label="USD Inflows" value={fmtAmt(s.total_inflow_usd, 'USD')} icon="currency_exchange" accent="#0891B2" />
        <KPI label="Net Position" value={fmtAmt(netPos)} icon="account_balance_wallet"
          accent={netPos >= 0 ? '#059669' : '#C00000'} valueColor={netPos >= 0 ? '#059669' : '#C00000'}
          tooltip="Total NGN inflows minus total liquidations" />
        <KPI label="All Transactions" value={fmtNum(s.total_transactions)} icon="receipt_long" accent="#0E2841" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        {/* Trend chart */}
        <div className="card p-5 lg:col-span-2">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>
            Monthly Trend — Inflows vs Liquidations
          </p>
          {trend.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">No trend data</p>
          ) : (
            <div className="flex flex-col gap-3">
              {trend.map((row, i) => (
                <div key={i}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-2))' }}>{row.label}</span>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <span style={{ fontSize: 11, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>+{fmtAmt(row.inflow)}</span>
                      <span style={{ fontSize: 11, color: '#C00000', fontVariantNumeric: 'tabular-nums' }}>−{fmtAmt(row.liquidation)}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 2 }}>
                    {/* Inflow bar */}
                    <div style={{ height: 8, borderRadius: 2, background: '#D1FAE5', flex: 1, overflow: 'hidden' }}>
                      <div style={{ width: `${(n(row.inflow) / maxTrend) * 100}%`, height: '100%', background: '#059669', borderRadius: 2 }} />
                    </div>
                    {/* Liquidation bar */}
                    <div style={{ height: 8, borderRadius: 2, background: '#FEE2E2', flex: 1, overflow: 'hidden' }}>
                      <div style={{ width: `${(n(row.liquidation) / maxTrend) * 100}%`, height: '100%', background: '#C00000', borderRadius: 2 }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-5 mt-4">
            <div className="flex items-center gap-1.5"><div style={{ width: 10, height: 10, borderRadius: 2, background: '#059669' }} /><span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>Inflow</span></div>
            <div className="flex items-center gap-1.5"><div style={{ width: 10, height: 10, borderRadius: 2, background: '#C00000' }} /><span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>Liquidation</span></div>
          </div>
        </div>

        {/* By location */}
        <div className="card p-5">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>
            By Location
          </p>
          <div className="flex flex-col gap-4">
            {byLoc.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-6">No data</p>
            ) : byLoc.map((loc, i) => (
              <div key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--fg-2))' }}>{loc.location}</span>
                  <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{fmtNum(Number(loc.inflow_count) + Number(loc.liquidation_count))} txn</span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <div style={{ flex: n(loc.total_inflow), height: 6, borderRadius: 2, background: '#059669', opacity: 0.85 }} />
                  <div style={{ flex: n(loc.total_liquidated), height: 6, borderRadius: 2, background: '#C00000', opacity: 0.75 }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                  <span style={{ fontSize: 10, color: '#059669' }}>{fmtAmt(loc.total_inflow)} in</span>
                  <span style={{ fontSize: 10, color: '#C00000' }}>{fmtAmt(loc.total_liquidated)} out</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Transactions tab ── */
function TransactionsTab({ dateFrom, dateTo }) {
  const [rows,     setRows]     = useState([])
  const [total,    setTotal]    = useState(0)
  const [loading,  setLoading]  = useState(false)
  const [type,     setType]     = useState('')
  const [location, setLocation] = useState('')
  const [search,   setSearch]   = useState('')
  const [offset,   setOffset]   = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [editRow,  setEditRow]  = useState(null)
  const LIMIT = 200

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ limit: LIMIT, offset, date_from: dateFrom, date_to: dateTo })
      if (type)     p.set('type', type)
      if (location) p.set('location', location)
      if (search)   p.set('q', search)
      const data = await apiFetch(`/api/fixed-deposit/transactions?${p}`)
      setRows(Array.isArray(data.data) ? data.data : [])
      setTotal(Number(data.total || 0))
    } finally { setLoading(false) }
  }, [type, location, search, offset, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function deleteTxn(id) {
    if (!confirm('Delete this transaction?')) return
    const token = localStorage.getItem('o3c_token')
    await fetch(`${API}/api/fixed-deposit/transactions/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
    })
    load()
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div style={{ position: 'relative' }}>
            <span className="material-symbols-rounded" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: 'rgb(var(--fg-3))', pointerEvents: 'none' }}>search</span>
            <input className="form-input" style={{ paddingLeft: 30, height: 34, fontSize: 13, width: 200 }}
              placeholder="Customer name…"
              value={search} onChange={e => { setSearch(e.target.value); setOffset(0) }} />
          </div>
          <FilterChip label={type ? TYPE_META[type]?.label || type : 'Type'} active={!!type} onClear={() => { setType(''); setOffset(0) }}>
            <DropItem label="All Types" selected={!type} onClick={() => { setType(''); setOffset(0) }} />
            {Object.entries(TYPE_META).map(([k, m]) => (
              <DropItem key={k} label={m.label} selected={type === k} onClick={() => { setType(k); setOffset(0) }} />
            ))}
          </FilterChip>
          <FilterChip label={location || 'Location'} active={!!location} onClear={() => { setLocation(''); setOffset(0) }}>
            <DropItem label="All Locations" selected={!location} onClick={() => { setLocation(''); setOffset(0) }} />
            {LOCATIONS.map(l => <DropItem key={l} label={l} selected={location === l} onClick={() => { setLocation(l); setOffset(0) }} />)}
          </FilterChip>
        </div>
        <button onClick={() => { setEditRow(null); setFormOpen(true) }} className="btn btn-primary gap-2">
          <span className="material-symbols-rounded text-[17px]">add</span>
          Book Transaction
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{total.toLocaleString()} transactions</p>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Type</th>
                <th className="text-right">NGN Amount</th>
                <th className="text-right">Principal</th>
                <th className="text-right">Interest</th>
                <th className="text-right">Gross</th>
                <th>Currency</th>
                <th>Rate</th>
                <th>Tenor</th>
                <th>Maturity</th>
                <th>Location</th>
                <th>Officer</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={14} className="text-center py-10 text-slate-400">
                  <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={14} className="text-center py-12">
                  <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">savings</span>
                  <p className="text-sm text-slate-400">No transactions found</p>
                </td></tr>
              ) : rows.map(r => (
                <tr key={r.id}>
                  <td className="text-xs text-slate-500 whitespace-nowrap">{fmtDateShort(r.transaction_date)}</td>
                  <td>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100 max-w-[140px] truncate" title={r.customer_name}>{r.customer_name}</p>
                  </td>
                  <td><TypeBadge type={r.transaction_type} /></td>
                  <td className="text-right tabular-nums text-sm font-semibold">{r.ngn_amount ? fmtAmt(r.ngn_amount) : '—'}</td>
                  <td className="text-right tabular-nums text-sm">{r.principal ? fmtAmt(r.principal) : '—'}</td>
                  <td className="text-right tabular-nums text-sm" style={{ color: '#8B5CF6' }}>{r.interest_paid ? fmtAmt(r.interest_paid) : '—'}</td>
                  <td className="text-right tabular-nums text-sm">{r.gross_amount ? fmtAmt(r.gross_amount) : '—'}</td>
                  <td>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: r.currency === 'USD' ? '#EFF6FF' : '#F0FDF4', color: r.currency === 'USD' ? '#2563EB' : '#059669' }}>
                      {r.currency || 'NGN'}
                    </span>
                  </td>
                  <td className="text-xs text-slate-500 tabular-nums">{r.rate ? `${r.rate}%` : '—'}</td>
                  <td className="text-xs text-slate-500 tabular-nums">{r.tenor_days ? `${r.tenor_days}d` : '—'}</td>
                  <td className="text-xs text-slate-500 whitespace-nowrap">{fmtDateShort(r.maturity_date)}</td>
                  <td className="text-xs text-slate-500">{r.location || '—'}</td>
                  <td className="text-xs text-slate-500">{r.account_officer || '—'}</td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditRow(r); setFormOpen(true) }} className="btn-icon" title="Edit">
                        <span className="material-symbols-rounded text-[16px]">edit</span>
                      </button>
                      <button onClick={() => deleteTxn(r.id)} className="btn-icon" title="Delete" style={{ color: '#C00000' }}>
                        <span className="material-symbols-rounded text-[16px]">delete</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total > LIMIT && (
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-xs text-slate-400">Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}</p>
            <div className="flex gap-2">
              <button onClick={() => setOffset(o => Math.max(0, o - LIMIT))} disabled={offset === 0} className="btn btn-ghost btn-sm disabled:opacity-40">
                <span className="material-symbols-rounded text-[17px]">chevron_left</span>
              </button>
              <button onClick={() => setOffset(o => o + LIMIT)} disabled={offset + LIMIT >= total} className="btn btn-ghost btn-sm disabled:opacity-40">
                <span className="material-symbols-rounded text-[17px]">chevron_right</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {formOpen && (
        <TransactionForm
          initial={editRow}
          onClose={() => { setFormOpen(false); setEditRow(null) }}
          onSave={() => { setFormOpen(false); setEditRow(null); load() }}
        />
      )}
    </div>
  )
}

/* ── By Officer tab ── */
function ByOfficerTab({ dateFrom, dateTo }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    apiFetch(`/api/fixed-deposit/by-officer?date_from=${dateFrom}&date_to=${dateTo}`)
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo])

  if (loading) return <div className="flex items-center gap-3 text-slate-400 py-12"><div className="spinner" />Loading…</div>

  const maxInflow = Math.max(...rows.map(r => n(r.total_inflow)), 1)

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Performance by Account Officer</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead><tr>
            <th>Account Officer</th>
            <th className="text-right">Inflows</th>
            <th className="text-right">Total Inflow</th>
            <th className="text-right">Liquidations</th>
            <th className="text-right">Total Liquidated</th>
            <th style={{ width: 160 }}>Share</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-slate-400 text-sm">No data</td></tr>
            ) : rows.map((r, i) => (
              <tr key={i}>
                <td className="font-medium text-slate-800 dark:text-slate-100">{r.account_officer || '—'}</td>
                <td className="text-right tabular-nums text-sm">{fmtNum(r.inflow_count)}</td>
                <td className="text-right tabular-nums text-sm font-semibold" style={{ color: '#059669' }}>{fmtAmt(r.total_inflow)}</td>
                <td className="text-right tabular-nums text-sm">{fmtNum(r.liquidation_count)}</td>
                <td className="text-right tabular-nums text-sm" style={{ color: '#C00000' }}>{fmtAmt(r.total_liquidated)}</td>
                <td>
                  <div style={{ height: 6, borderRadius: 3, background: 'rgb(var(--bg-subtle))', overflow: 'hidden' }}>
                    <div style={{ width: `${(n(r.total_inflow) / maxInflow) * 100}%`, height: '100%', background: '#059669', borderRadius: 3 }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'dashboard',    label: 'Dashboard',    icon: 'dashboard' },
  { key: 'transactions', label: 'Transactions', icon: 'receipt_long' },
  { key: 'by-officer',   label: 'By Officer',   icon: 'person' },
]

export default function FixedDeposit() {
  const [tab,      setTab]      = useState('dashboard')
  const [dateFrom, setDateFrom] = useState(thisYearRange()[0])
  const [dateTo,   setDateTo]   = useState(thisYearRange()[1])
  const [preset,   setPreset]   = useState('year')

  function handleDateChange(f, t, p) { setDateFrom(f); setDateTo(t); setPreset(p) }

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">

      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Fixed Deposit</h1>
          <p className="text-sm text-slate-500 mt-0.5">Track inflows, liquidations, and FD portfolio performance</p>
        </div>
      </div>

      <div className="mb-6">
        <DateRangePicker
          refDate={today()}
          dateFrom={dateFrom} dateTo={dateTo} preset={preset}
          onChange={handleDateChange}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-6 overflow-x-auto" style={{ borderBottom: '2px solid rgb(var(--border) / 0.1)' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 18px',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'none', outline: 'none',
              borderBottom: tab === t.key ? '2px solid #0E2841' : '2px solid transparent',
              marginBottom: -2, color: tab === t.key ? '#0E2841' : 'rgb(var(--fg-3))',
              transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}>
            <span className="material-symbols-rounded text-[17px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard'    && <DashboardTab    dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'transactions' && <TransactionsTab dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'by-officer'   && <ByOfficerTab    dateFrom={dateFrom} dateTo={dateTo} />}
    </div>
  )
}
