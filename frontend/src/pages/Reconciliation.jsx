import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { InfoTooltip, fmt, fmtNum } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem, CHIP_OFF, CHIP_ON, toISO, fmtDate, presetRange, presetLabel } from '../components/FilterBar.jsx'

/* ══════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════ */

function n(v) { return Number(v || 0) }

function fmtAmt(v) {
  const x = n(v)
  if (Math.abs(x) >= 1_000_000_000) return '₦' + (x / 1_000_000_000).toFixed(2) + 'B'
  if (Math.abs(x) >= 1_000_000)     return '₦' + (x / 1_000_000).toFixed(2) + 'M'
  if (Math.abs(x) >= 1_000)         return '₦' + (x / 1_000).toFixed(1) + 'K'
  return '₦' + x.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtExact(v) {
  return '₦' + n(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTs(s) {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return s }
}

function today() { return toISO(new Date()) }
function defaultRange() {
  const d = new Date()
  const from = new Date(d.getFullYear(), d.getMonth(), 1)
  return [toISO(from), toISO(d)]
}

/* ══════════════════════════════════════════════════════════════════
   SUB-COMPONENTS
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
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"', color: valueColor || 'rgb(var(--fg-1))' }}>
        {value}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

/* Delta badge — green if within 1%, amber if <5%, red otherwise */
function DeltaBadge({ apiVal, eodVal, label }) {
  const diff   = n(apiVal) - n(eodVal)
  const pct    = n(eodVal) !== 0 ? Math.abs(diff / n(eodVal)) * 100 : null
  const ok     = pct !== null ? pct < 1 : diff === 0
  const warn   = pct !== null ? pct < 5 : false
  const color  = ok ? '#059669' : warn ? '#D97706' : '#C00000'
  const bg     = ok ? '#F0FDF4' : warn ? '#FFFBEB' : '#FEF2F2'
  const icon   = ok ? 'check_circle' : 'warning'

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: bg, border: `1px solid ${color}22` }}>
      <span className="material-symbols-rounded" style={{ fontSize: 15, color }}>{icon}</span>
      <div>
        <p style={{ fontSize: 12, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
          {diff >= 0 ? '+' : ''}{label === 'count' ? fmtNum(diff) : fmtAmt(diff)}
          {pct !== null && <span style={{ fontWeight: 400, marginLeft: 4 }}>({pct.toFixed(1)}%)</span>}
        </p>
        <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))' }}>
          {ok ? 'Balanced' : warn ? 'Minor gap' : 'Mismatch'}
        </p>
      </div>
    </div>
  )
}

/* Comparison section: API totals vs EOD totals */
function ComparePanel({ apiData, eodData, loading }) {
  if (loading) return (
    <div className="card p-8 flex items-center justify-center gap-3 text-slate-400">
      <div className="spinner" /><span className="text-sm">Loading comparison…</span>
    </div>
  )

  return (
    <div className="card overflow-hidden mb-5">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Reconciliation</p>
        <p className="text-xs text-slate-400 mt-0.5">Processor API totals vs internal EOD ledger</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'rgb(var(--bg-subtle))' }}>
              <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>Metric</th>
              <th style={{ padding: '10px 20px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>Processor</th>
              <th style={{ padding: '10px 20px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>EOD Ledger</th>
              <th style={{ padding: '10px 20px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>Delta</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderTop: '1px solid rgb(var(--border) / 0.07)' }}>
              <td style={{ padding: '14px 20px', fontSize: 13, fontWeight: 600, color: 'rgb(var(--fg-1))' }}>Transaction Count</td>
              <td style={{ padding: '14px 20px', textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--fg-1))' }}>
                {fmtNum(apiData?.txn_count)}
              </td>
              <td style={{ padding: '14px 20px', textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--fg-1))' }}>
                {fmtNum(eodData?.txn_count)}
              </td>
              <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                <DeltaBadge apiVal={apiData?.txn_count} eodVal={eodData?.txn_count} label="count" />
              </td>
            </tr>
            <tr style={{ borderTop: '1px solid rgb(var(--border) / 0.07)' }}>
              <td style={{ padding: '14px 20px', fontSize: 13, fontWeight: 600, color: 'rgb(var(--fg-1))' }}>Total Volume (NGN)</td>
              <td style={{ padding: '14px 20px', textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--fg-1))' }}>
                {fmtExact(apiData?.total_volume_ngn ?? apiData?.total_volume)}
              </td>
              <td style={{ padding: '14px 20px', textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--fg-1))' }}>
                {fmtExact(eodData?.total_vol_ngn)}
              </td>
              <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                <DeltaBadge apiVal={apiData?.total_volume_ngn ?? apiData?.total_volume} eodVal={eodData?.total_vol_ngn} label="amount" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   PAYSTACK TAB
   ══════════════════════════════════════════════════════════════════ */

const PS_STATUS = ['', 'success', 'failed', 'abandoned']

function PaystackTab({ dateFrom, dateTo }) {
  const [summary,      setSummary]      = useState(null)
  const [txns,         setTxns]         = useState([])
  const [txnMeta,      setTxnMeta]      = useState({})
  const [settlements,  setSettlements]  = useState([])
  const [page,         setPage]         = useState(1)
  const [status,       setStatus]       = useState('')
  const [settlePage,   setSettlePage]   = useState(1)
  const [loading,      setLoading]      = useState(false)
  const [loadingTxns,  setLoadingTxns]  = useState(false)
  const [loadingSet,   setLoadingSet]   = useState(false)
  const [subTab,       setSubTab]       = useState('summary') // summary | transactions | settlements
  const PER_PAGE = 100

  const loadSummary = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const data = await apiFetch(`/api/reconciliation/paystack/summary?date_from=${dateFrom}&date_to=${dateTo}`)
      setSummary(data)
    } catch (_) { setSummary(null) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  const loadTxns = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoadingTxns(true)
    try {
      const p = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, page, per_page: PER_PAGE })
      if (status) p.set('status', status)
      const data = await apiFetch(`/api/reconciliation/paystack/transactions?${p}`)
      setTxns(Array.isArray(data.data) ? data.data : [])
      setTxnMeta(data.meta || {})
    } catch (_) { setTxns([]) }
    finally { setLoadingTxns(false) }
  }, [dateFrom, dateTo, page, status])

  const loadSettlements = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoadingSet(true)
    try {
      const p = new URLSearchParams({ from: dateFrom, to: dateTo, page: settlePage, per_page: 50 })
      const data = await apiFetch(`/api/reconciliation/paystack/settlements?${p}`)
      setSettlements(Array.isArray(data.data) ? data.data : [])
    } catch (_) { setSettlements([]) }
    finally { setLoadingSet(false) }
  }, [dateFrom, dateTo, settlePage])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { if (subTab === 'transactions') loadTxns() }, [loadTxns, subTab])
  useEffect(() => { if (subTab === 'settlements')  loadSettlements() }, [loadSettlements, subTab])

  const configured = summary?.configured !== false
  const ps  = summary?.paystack   || {}
  const eod = summary?.eod        || {}
  const delta = summary?.delta    || {}

  if (!configured && summary) {
    return (
      <div className="card p-12 flex flex-col items-center text-slate-400 gap-3">
        <span className="material-symbols-rounded text-[48px] opacity-25">payments</span>
        <p className="font-semibold text-slate-600 dark:text-slate-300">Paystack not configured</p>
        <p className="text-sm">{summary.message || 'Set PAYSTACK_SECRET_KEY in backend environment'}</p>
      </div>
    )
  }

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-5 p-1 rounded-lg" style={{ background: 'rgb(var(--bg-subtle))', display: 'inline-flex' }}>
        {['summary', 'transactions', 'settlements'].map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className={`btn btn-sm capitalize transition-all ${subTab === t ? 'btn-primary' : 'btn-ghost text-slate-500'}`}
            style={{ borderRadius: 7, height: 30, fontSize: 12 }}>
            {t === 'summary' ? 'Summary' : t === 'transactions' ? 'Transactions' : 'Settlements'}
          </button>
        ))}
      </div>

      {subTab === 'summary' && (
        <>
          {loading ? (
            <div className="flex items-center gap-3 text-slate-400 py-10"><div className="spinner" />Loading…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
                <KPI label="Total Transactions" value={fmtNum(ps.total_count)} icon="receipt_long" accent="#0E2841"
                  tooltip="Total Paystack transactions in the period (from API meta)" />
                <KPI label="Successful" value={fmtNum(ps.success)} icon="check_circle" accent="#059669"
                  tooltip="Successful transactions on first page — full count needs all pages" />
                <KPI label="Failed" value={fmtNum(ps.failed)} icon="cancel" accent="#C00000" />
                <KPI label="Volume (NGN)" value={fmtAmt(ps.total_volume_ngn)} icon="payments" accent="#8B5CF6"
                  tooltip="Total NGN volume on first page — full figure needs all pages" />
              </div>

              <ComparePanel apiData={ps} eodData={eod} loading={loading} />

              {delta.note && (
                <div className="flex items-start gap-2 p-4 rounded-xl mb-4"
                  style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                  <span className="material-symbols-rounded text-[17px] mt-0.5 flex-shrink-0" style={{ color: '#D97706' }}>info</span>
                  <p style={{ fontSize: 12, color: '#92400E' }}>{delta.note}</p>
                </div>
              )}
              {ps.error && (
                <div className="flex items-start gap-2 p-4 rounded-xl"
                  style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <span className="material-symbols-rounded text-[17px] mt-0.5 flex-shrink-0" style={{ color: '#C00000' }}>error</span>
                  <p style={{ fontSize: 12, color: '#7F1D1D' }}>Paystack API error: {ps.error}</p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {subTab === 'transactions' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between flex-wrap gap-3"
            style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <div>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Paystack Transactions</p>
              <p className="text-xs text-slate-400 mt-0.5">{fmtDate(dateFrom)} – {fmtDate(dateTo)}</p>
            </div>
            <FilterChip label={status ? status : 'Status'} active={!!status} onClear={() => { setStatus(''); setPage(1) }}>
              {PS_STATUS.map(s => (
                <DropItem key={s || 'all'} label={s || 'All'} selected={status === s} onClick={() => { setStatus(s); setPage(1) }} />
              ))}
            </FilterChip>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Currency</th>
                  <th>Status</th>
                  <th>Channel</th>
                  <th>Customer</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {loadingTxns ? (
                  <tr><td colSpan={7} className="text-center py-10 text-slate-400">
                    <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
                  </td></tr>
                ) : txns.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-10">
                    <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">receipt_long</span>
                    <p className="text-sm text-slate-400">No transactions</p>
                  </td></tr>
                ) : txns.map((t, i) => {
                  const ok = t.status === 'success'
                  return (
                    <tr key={i}>
                      <td className="font-mono text-xs text-slate-500">{t.reference}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: ok ? '#059669' : 'rgb(var(--fg-1))' }}>
                        {fmtExact(n(t.amount) / 100)}
                      </td>
                      <td className="text-xs">{t.currency}</td>
                      <td>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                          background: ok ? '#F0FDF4' : t.status === 'failed' ? '#FEF2F2' : '#FFFBEB',
                          color: ok ? '#059669' : t.status === 'failed' ? '#C00000' : '#D97706',
                        }}>
                          {t.status}
                        </span>
                      </td>
                      <td className="text-xs capitalize">{t.channel}</td>
                      <td className="text-xs text-slate-600 dark:text-slate-400">
                        {t.customer?.email || t.customer?.phone || '—'}
                      </td>
                      <td className="text-xs text-slate-500 whitespace-nowrap">{fmtTs(t.created_at || t.paid_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(txnMeta.total > PER_PAGE || page > 1) && (
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
              <p className="text-xs text-slate-400">Page {page} of {Math.ceil((txnMeta.total || 0) / PER_PAGE) || '?'}</p>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="btn btn-ghost btn-sm disabled:opacity-40">
                  <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                </button>
                <button onClick={() => setPage(p => p + 1)} disabled={txns.length < PER_PAGE}
                  className="btn btn-ghost btn-sm disabled:opacity-40">
                  <span className="material-symbols-rounded text-[17px]">chevron_right</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === 'settlements' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Paystack Settlements</p>
            <p className="text-xs text-slate-400 mt-0.5">{fmtDate(dateFrom)} – {fmtDate(dateTo)}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Settlement Date</th>
                  <th>Total Amount</th>
                  <th>Total Fees</th>
                  <th>Net Amount</th>
                  <th>Status</th>
                  <th>Bank</th>
                </tr>
              </thead>
              <tbody>
                {loadingSet ? (
                  <tr><td colSpan={6} className="text-center py-10 text-slate-400">
                    <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
                  </td></tr>
                ) : settlements.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-10">
                    <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">account_balance</span>
                    <p className="text-sm text-slate-400">No settlements in this period</p>
                  </td></tr>
                ) : settlements.map((s, i) => (
                  <tr key={i}>
                    <td className="text-xs text-slate-500 whitespace-nowrap">{fmtTs(s.settlement_date || s.createdAt)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtExact(n(s.total_amount) / 100)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', color: '#C00000' }}>{fmtExact(n(s.total_fees) / 100)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: '#059669' }}>{fmtExact(n(s.net_amount) / 100)}</td>
                    <td>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center',
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                        background: s.status === 'success' ? '#F0FDF4' : '#FFFBEB',
                        color: s.status === 'success' ? '#059669' : '#D97706',
                      }}>
                        {s.status}
                      </span>
                    </td>
                    <td className="text-xs text-slate-500">{s.bank_account?.bank_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {settlements.length >= 50 && (
            <div className="px-5 py-3 flex items-center justify-end" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
              <div className="flex gap-2">
                <button onClick={() => setSettlePage(p => Math.max(1, p - 1))} disabled={settlePage === 1}
                  className="btn btn-ghost btn-sm disabled:opacity-40">
                  <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                </button>
                <button onClick={() => setSettlePage(p => p + 1)} disabled={settlements.length < 50}
                  className="btn btn-ghost btn-sm disabled:opacity-40">
                  <span className="material-symbols-rounded text-[17px]">chevron_right</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   INTERSWITCH TAB
   ══════════════════════════════════════════════════════════════════ */

function InterspwitchTab({ dateFrom, dateTo }) {
  const [summary,     setSummary]     = useState(null)
  const [txns,        setTxns]        = useState([])
  const [page,        setPage]        = useState(1)
  const [loading,     setLoading]     = useState(false)
  const [loadingTxns, setLoadingTxns] = useState(false)
  const [subTab,      setSubTab]      = useState('summary')
  const PER_PAGE = 100

  const loadSummary = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const data = await apiFetch(`/api/reconciliation/interswitch/summary?date_from=${dateFrom}&date_to=${dateTo}`)
      setSummary(data)
    } catch (_) { setSummary(null) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  const loadTxns = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoadingTxns(true)
    try {
      const p = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, page, per_page: PER_PAGE })
      const data = await apiFetch(`/api/reconciliation/interswitch/transactions?${p}`)
      // Interswitch wraps differently — try common patterns
      const rows = data?.data?.transactions || data?.data?.items || data?.data
      setTxns(Array.isArray(rows) ? rows : [])
    } catch (_) { setTxns([]) }
    finally { setLoadingTxns(false) }
  }, [dateFrom, dateTo, page])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { if (subTab === 'transactions') loadTxns() }, [loadTxns, subTab])

  const configured = summary?.configured !== false
  const isw   = summary?.interswitch || {}
  const eod   = summary?.eod         || {}
  const delta = summary?.delta       || {}

  if (!configured && summary) {
    return (
      <div className="card p-12 flex flex-col items-center text-slate-400 gap-3">
        <span className="material-symbols-rounded text-[48px] opacity-25">account_balance</span>
        <p className="font-semibold text-slate-600 dark:text-slate-300">Interswitch not configured</p>
        <p className="text-sm">{summary.message || 'Set INTERSWITCH_CLIENT_ID, INTERSWITCH_CLIENT_SECRET, and INTERSWITCH_BASE_URL'}</p>
      </div>
    )
  }

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-5 p-1 rounded-lg" style={{ background: 'rgb(var(--bg-subtle))', display: 'inline-flex' }}>
        {['summary', 'transactions'].map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className={`btn btn-sm capitalize transition-all ${subTab === t ? 'btn-primary' : 'btn-ghost text-slate-500'}`}
            style={{ borderRadius: 7, height: 30, fontSize: 12 }}>
            {t === 'summary' ? 'Summary' : 'Transactions'}
          </button>
        ))}
      </div>

      {subTab === 'summary' && (
        <>
          {loading ? (
            <div className="flex items-center gap-3 text-slate-400 py-10"><div className="spinner" />Loading…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
                <KPI label="Transaction Count" value={fmtNum(isw.txn_count)} icon="receipt_long" accent="#0E2841" />
                <KPI label="Total Volume" value={fmtAmt(isw.total_volume)} icon="payments" accent="#8B5CF6" />
                <KPI label="EOD Volume" value={fmtAmt(eod.total_vol_ngn)} icon="account_balance" accent="#0891B2"
                  tooltip="Total volume recorded in the internal EOD ledger for the same period" />
              </div>

              <ComparePanel
                apiData={{ txn_count: isw.txn_count, total_volume_ngn: isw.total_volume }}
                eodData={eod}
                loading={loading}
              />

              {delta.volume_diff !== undefined && (
                <div className="flex items-center gap-3 flex-wrap mt-2">
                  <span className="text-xs text-slate-500">Count delta:</span>
                  <DeltaBadge apiVal={isw.txn_count} eodVal={eod.txn_count} label="count" />
                  <span className="text-xs text-slate-500 ml-4">Volume delta:</span>
                  <DeltaBadge apiVal={isw.total_volume} eodVal={eod.total_vol_ngn} label="amount" />
                </div>
              )}

              {isw.error && (
                <div className="flex items-start gap-2 p-4 rounded-xl mt-5"
                  style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <span className="material-symbols-rounded text-[17px] mt-0.5 flex-shrink-0" style={{ color: '#C00000' }}>error</span>
                  <p style={{ fontSize: 12, color: '#7F1D1D' }}>Interswitch API error: {isw.error}</p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {subTab === 'transactions' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Interswitch Transactions</p>
            <p className="text-xs text-slate-400 mt-0.5">{fmtDate(dateFrom)} – {fmtDate(dateTo)}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Transaction Ref</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Channel</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {loadingTxns ? (
                  <tr><td colSpan={6} className="text-center py-10 text-slate-400">
                    <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
                  </td></tr>
                ) : txns.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-10">
                    <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">receipt_long</span>
                    <p className="text-sm text-slate-400">No transactions returned</p>
                  </td></tr>
                ) : txns.map((t, i) => (
                  <tr key={i}>
                    <td className="text-xs text-slate-400">{(page - 1) * PER_PAGE + i + 1}</td>
                    <td className="font-mono text-xs text-slate-500">
                      {t.transactionReference || t.reference || t.txnRef || '—'}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {fmtExact(t.amount || t.transactionAmount || 0)}
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center',
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                        background: (t.responseCode || t.statusCode) === '00' ? '#F0FDF4' : '#FEF2F2',
                        color:      (t.responseCode || t.statusCode) === '00' ? '#059669' : '#C00000',
                      }}>
                        {t.responseDescription || t.status || t.responseCode || '—'}
                      </span>
                    </td>
                    <td className="text-xs capitalize">{t.channel || t.paymentMode || '—'}</td>
                    <td className="text-xs text-slate-500 whitespace-nowrap">
                      {fmtTs(t.createdAt || t.transactionDate || t.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(txns.length >= PER_PAGE || page > 1) && (
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
              <p className="text-xs text-slate-400">Page {page}</p>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="btn btn-ghost btn-sm disabled:opacity-40">
                  <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                </button>
                <button onClick={() => setPage(p => p + 1)} disabled={txns.length < PER_PAGE}
                  className="btn btn-ghost btn-sm disabled:opacity-40">
                  <span className="material-symbols-rounded text-[17px]">chevron_right</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'paystack',     label: 'Paystack',     icon: 'payments' },
  { key: 'interswitch',  label: 'Interswitch',  icon: 'account_balance' },
]

export default function Reconciliation() {
  const [tab,      setTab]      = useState('paystack')
  const [dateFrom, setDateFrom] = useState(defaultRange()[0])
  const [dateTo,   setDateTo]   = useState(defaultRange()[1])
  const [preset,   setPreset]   = useState('month')

  function handleDateChange(f, t, p) { setDateFrom(f); setDateTo(t); setPreset(p) }

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Reconciliation</h1>
          <p className="text-sm text-slate-500 mt-0.5">Match processor settlements against internal EOD ledger</p>
        </div>
      </div>

      {/* ── Date picker ── */}
      <div className="mb-6">
        <DateRangePicker
          refDate={today()}
          dateFrom={dateFrom}
          dateTo={dateTo}
          preset={preset}
          onChange={handleDateChange}
        />
      </div>

      {/* ── Processor tabs ── */}
      <div className="flex gap-2 mb-6" style={{ borderBottom: '2px solid rgb(var(--border) / 0.1)', paddingBottom: 0 }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: 'none', background: 'none', outline: 'none',
              borderBottom: tab === t.key ? '2px solid #0E2841' : '2px solid transparent',
              marginBottom: -2,
              color: tab === t.key ? '#0E2841' : 'rgb(var(--fg-3))',
              transition: 'all 0.15s',
            }}
          >
            <span className="material-symbols-rounded text-[17px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      {tab === 'paystack'    && <PaystackTab    dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'interswitch' && <InterspwitchTab dateFrom={dateFrom} dateTo={dateTo} />}
    </div>
  )
}
