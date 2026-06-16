import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtExact, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, SectionCard, DateFilter, StatusBadge, Spinner, ErrBanner,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── Helpers ── */
function fmtTs(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return s }
}

/* ── Delta badge ── */
function DeltaBadge({ apiVal, eodVal, isCount = false }: { apiVal: number; eodVal: number; isCount?: boolean }) {
  const diff = apiVal - eodVal
  const pct = eodVal !== 0 ? Math.abs(diff / eodVal) * 100 : null
  const ok = pct !== null ? pct < 1 : diff === 0
  const warn = pct !== null ? pct < 5 : false
  const color = ok ? GREEN : warn ? AMBER : RED
  const bg = ok ? 'rgba(5,150,105,0.06)' : warn ? 'rgba(217,119,6,0.06)' : 'rgba(192,0,0,0.06)'

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-bold"
      style={{ background: bg, color, border: `1px solid ${color}22` }}>
      <span className="material-symbols-rounded text-[14px]">{ok ? 'check_circle' : 'warning'}</span>
      {diff >= 0 ? '+' : ''}{isCount ? fmtNum(diff) : fmtExact(diff)}
      {pct !== null && <span className="font-normal opacity-75">({pct.toFixed(1)}%)</span>}
      <span className="font-normal">{ok ? '· Balanced' : warn ? '· Minor gap' : '· Mismatch'}</span>
    </span>
  )
}

/* ── Comparison table ── */
function ComparePanel({ ps, eod, loading }: { ps: any; eod: any; loading: boolean }) {
  if (loading) return (
    <div className="card p-8 flex items-center justify-center gap-3 text-slate-400">
      <Spinner /><span className="text-sm">Loading comparison…</span>
    </div>
  )
  return (
    <div className="card overflow-hidden mb-5">
      <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
        <p className="text-[14px] font-semibold text-slate-800">Reconciliation</p>
        <p className="text-[12px] text-slate-400 mt-0.5">Processor API totals vs internal EOD ledger</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr style={{ background: NAVY }}>
              {['Metric', 'Processor', 'EOD Ledger', 'Delta'].map((h, i) => (
                <th key={h} className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] ${i > 0 ? 'text-right' : 'text-left'}`}
                  style={{ color: 'rgba(255,255,255,0.7)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
              <td className="px-5 py-4 font-semibold text-slate-800">Transaction Count</td>
              <td className="px-5 py-4 text-right font-mono font-bold text-slate-900">{fmtNum(n(ps?.total_count))}</td>
              <td className="px-5 py-4 text-right font-mono font-bold text-slate-900">{fmtNum(n(eod?.txn_count))}</td>
              <td className="px-5 py-4 text-right">
                <DeltaBadge apiVal={n(ps?.total_count)} eodVal={n(eod?.txn_count)} isCount />
              </td>
            </tr>
            <tr style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
              <td className="px-5 py-4 font-semibold text-slate-800">Total Volume (NGN)</td>
              <td className="px-5 py-4 text-right font-mono font-bold text-slate-900">
                {fmtExact(n(ps?.total_volume_ngn ?? ps?.total_volume))}
              </td>
              <td className="px-5 py-4 text-right font-mono font-bold text-slate-900">
                {fmtExact(n(eod?.total_vol_ngn))}
              </td>
              <td className="px-5 py-4 text-right">
                <DeltaBadge apiVal={n(ps?.total_volume_ngn ?? ps?.total_volume)} eodVal={n(eod?.total_vol_ngn)} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ══════════════════════════════
   PAYSTACK TAB
══════════════════════════════ */
const PS_STATUSES = ['', 'success', 'failed', 'abandoned']
const PER_PAGE = 100

function PaystackTab({ from, to }: { from: string; to: string }) {
  const [subTab, setSubTab] = useState<'summary' | 'transactions' | 'settlements'>('summary')
  const [summary, setSummary] = useState<any>(null)
  const [txns, setTxns] = useState<any[]>([])
  const [txnMeta, setTxnMeta] = useState<any>({})
  const [settlements, setSettlements] = useState<any[]>([])
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [settlePage, setSettlePage] = useState(1)
  const [loadingSum, setLoadingSum] = useState(false)
  const [loadingTxns, setLoadingTxns] = useState(false)
  const [loadingSet, setLoadingSet] = useState(false)

  const loadSummary = useCallback(async () => {
    setLoadingSum(true)
    try {
      const data = await apiFetch(`/api/reconciliation/paystack/summary?date_from=${from}&date_to=${to}`)
      setSummary(data)
    } catch { setSummary(null) }
    finally { setLoadingSum(false) }
  }, [from, to])

  const loadTxns = useCallback(async () => {
    setLoadingTxns(true)
    try {
      const p = new URLSearchParams({ date_from: from, date_to: to, page: String(page), per_page: String(PER_PAGE) })
      if (status) p.set('status', status)
      const data = await apiFetch(`/api/reconciliation/paystack/transactions?${p}`)
      setTxns(Array.isArray(data.data) ? data.data : [])
      setTxnMeta(data.meta || {})
    } catch { setTxns([]) }
    finally { setLoadingTxns(false) }
  }, [from, to, page, status])

  const loadSettlements = useCallback(async () => {
    setLoadingSet(true)
    try {
      const p = new URLSearchParams({ from, to, page: String(settlePage), per_page: '50' })
      const data = await apiFetch(`/api/reconciliation/paystack/settlements?${p}`)
      setSettlements(Array.isArray(data.data) ? data.data : [])
    } catch { setSettlements([]) }
    finally { setLoadingSet(false) }
  }, [from, to, settlePage])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { if (subTab === 'transactions') loadTxns() }, [loadTxns, subTab])
  useEffect(() => { if (subTab === 'settlements') loadSettlements() }, [loadSettlements, subTab])

  const ps = summary?.paystack || {}
  const eod = summary?.eod || {}
  const delta = summary?.delta || {}
  const configured = summary?.configured !== false

  if (summary && !configured) {
    return (
      <div className="card p-12 flex flex-col items-center text-slate-400 gap-3">
        <span className="material-symbols-rounded text-[48px] opacity-25">payments</span>
        <p className="font-semibold text-slate-600">Paystack not configured</p>
        <p className="text-sm">{summary.message || 'Set PAYSTACK_SECRET_KEY in backend environment'}</p>
      </div>
    )
  }

  return (
    <div>
      {/* Sub-tab switcher */}
      <div className="flex gap-1 mb-5 p-1 rounded-lg bg-slate-100 inline-flex">
        {(['summary', 'transactions', 'settlements'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className="px-3 py-1.5 rounded-md text-[12px] font-semibold capitalize transition-all"
            style={{
              background: subTab === t ? '#fff' : 'transparent',
              color: subTab === t ? NAVY : '#64748B',
              boxShadow: subTab === t ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}>
            {t === 'summary' ? 'Summary' : t === 'transactions' ? 'Transactions' : 'Settlements'}
          </button>
        ))}
      </div>

      {subTab === 'summary' && (
        loadingSum
          ? <div className="flex items-center gap-3 py-10 text-slate-400"><Spinner />Loading…</div>
          : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
                {[
                  { label: 'Total Transactions', value: fmtNum(ps.total_count), icon: 'receipt_long', accent: NAVY },
                  { label: 'Successful', value: fmtNum(ps.success), icon: 'check_circle', accent: GREEN },
                  { label: 'Failed', value: fmtNum(ps.failed), icon: 'cancel', accent: RED },
                  { label: 'Volume (NGN)', value: fmtExact(ps.total_volume_ngn), icon: 'payments', accent: '#8B5CF6' },
                ].map(({ label, value, icon, accent }) => (
                  <div key={label} className="card p-5">
                    <div className="flex items-start justify-between mb-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400">{label}</p>
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${accent}12` }}>
                        <span className="material-symbols-rounded text-[16px]" style={{ color: accent }}>{icon}</span>
                      </div>
                    </div>
                    <p className="kpi-number text-[22px] leading-none text-slate-900">{value}</p>
                  </div>
                ))}
              </div>
              <ComparePanel ps={ps} eod={eod} loading={false} />
              {delta.note && (
                <div className="flex items-start gap-2 p-4 rounded-xl mb-4"
                  style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                  <span className="material-symbols-rounded text-[17px] mt-0.5 text-amber-600 flex-shrink-0">info</span>
                  <p className="text-[12px] text-amber-800">{delta.note}</p>
                </div>
              )}
              {ps.error && (
                <div className="flex items-start gap-2 p-4 rounded-xl"
                  style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <span className="material-symbols-rounded text-[17px] mt-0.5 text-red-600 flex-shrink-0">error</span>
                  <p className="text-[12px] text-red-800">Paystack API error: {ps.error}</p>
                </div>
              )}
            </>
          )
      )}

      {subTab === 'transactions' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 flex items-center justify-between flex-wrap gap-3"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <div>
              <p className="text-[14px] font-semibold text-slate-800">Paystack Transactions</p>
              <p className="text-[12px] text-slate-400 mt-0.5">{fmtDate(from)} – {fmtDate(to)}</p>
            </div>
            <select value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}
              className="px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
              <option value="">All Statuses</option>
              {PS_STATUSES.slice(1).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: NAVY }}>
                  {['Reference', 'Amount', 'CCY', 'Status', 'Channel', 'Customer', 'Date'].map(h => (
                    <th key={h} className="px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-left"
                      style={{ color: 'rgba(255,255,255,0.7)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadingTxns
                  ? <tr><td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                      <div className="flex items-center justify-center gap-2"><Spinner />Loading…</div>
                    </td></tr>
                  : txns.length === 0
                  ? <tr><td colSpan={7} className="px-5 py-14 text-center">
                      <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">receipt_long</span>
                      <p className="text-[13px] text-slate-400">No transactions</p>
                    </td></tr>
                  : txns.map((t: any, i: number) => {
                    const ok = t.status === 'success'
                    return (
                      <tr key={i} className="hover:bg-slate-50 transition-colors"
                        style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                        <td className="px-5 py-3 font-mono text-xs text-slate-500">{t.reference}</td>
                        <td className="px-5 py-3 font-mono font-semibold" style={{ color: ok ? GREEN : '#334155' }}>
                          {fmtExact(n(t.amount) / 100)}
                        </td>
                        <td className="px-5 py-3 text-xs text-slate-500">{t.currency}</td>
                        <td className="px-5 py-3"><StatusBadge status={t.status || 'pending'} /></td>
                        <td className="px-5 py-3 text-xs capitalize text-slate-600">{t.channel}</td>
                        <td className="px-5 py-3 text-xs text-slate-600">
                          {t.customer?.email || t.customer?.phone || '—'}
                        </td>
                        <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">
                          {fmtTs(t.created_at || t.paid_at)}
                        </td>
                      </tr>
                    )
                  })
                }
              </tbody>
            </table>
          </div>
          {(n(txnMeta.total) > PER_PAGE || page > 1) && (
            <div className="px-5 py-3 flex items-center justify-between"
              style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
              <p className="text-xs text-slate-400">Page {page} of {Math.ceil(n(txnMeta.total) / PER_PAGE) || '?'}</p>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40 hover:bg-slate-50"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                  <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                </button>
                <button onClick={() => setPage(p => p + 1)} disabled={txns.length < PER_PAGE}
                  className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40 hover:bg-slate-50"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                  <span className="material-symbols-rounded text-[17px]">chevron_right</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === 'settlements' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <p className="text-[14px] font-semibold text-slate-800">Paystack Settlements</p>
            <p className="text-[12px] text-slate-400 mt-0.5">{fmtDate(from)} – {fmtDate(to)}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: NAVY }}>
                  {['Settlement Date', 'Total Amount', 'Total Fees', 'Net Amount', 'Status', 'Bank'].map(h => (
                    <th key={h} className="px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-left"
                      style={{ color: 'rgba(255,255,255,0.7)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadingSet
                  ? <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                      <div className="flex items-center justify-center gap-2"><Spinner />Loading…</div>
                    </td></tr>
                  : settlements.length === 0
                  ? <tr><td colSpan={6} className="px-5 py-14 text-center">
                      <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">account_balance</span>
                      <p className="text-[13px] text-slate-400">No settlements in this period</p>
                    </td></tr>
                  : settlements.map((s: any, i: number) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors"
                      style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                      <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {fmtTs(s.settlement_date || s.createdAt)}
                      </td>
                      <td className="px-5 py-3 font-mono font-semibold">{fmtExact(n(s.total_amount) / 100)}</td>
                      <td className="px-5 py-3 font-mono" style={{ color: RED }}>{fmtExact(n(s.total_fees) / 100)}</td>
                      <td className="px-5 py-3 font-mono font-bold" style={{ color: GREEN }}>{fmtExact(n(s.net_amount) / 100)}</td>
                      <td className="px-5 py-3"><StatusBadge status={s.status || 'pending'} /></td>
                      <td className="px-5 py-3 text-xs text-slate-500">{s.bank_account?.bank_name || '—'}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
          {settlements.length >= 50 && (
            <div className="px-5 py-3 flex items-center justify-end"
              style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
              <div className="flex gap-2">
                <button onClick={() => setSettlePage(p => Math.max(1, p - 1))} disabled={settlePage === 1}
                  className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                  <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                </button>
                <button onClick={() => setSettlePage(p => p + 1)} disabled={settlements.length < 50}
                  className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
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

/* ══════════════════════════════
   INTERSWITCH TAB
══════════════════════════════ */
function InterspwitchTab({ from, to }: { from: string; to: string }) {
  const [subTab, setSubTab] = useState<'summary' | 'transactions'>('summary')
  const [summary, setSummary] = useState<any>(null)
  const [txns, setTxns] = useState<any[]>([])
  const [page, setPage] = useState(1)
  const [loadingSum, setLoadingSum] = useState(false)
  const [loadingTxns, setLoadingTxns] = useState(false)

  const loadSummary = useCallback(async () => {
    setLoadingSum(true)
    try {
      const data = await apiFetch(`/api/reconciliation/interswitch/summary?date_from=${from}&date_to=${to}`)
      setSummary(data)
    } catch { setSummary(null) }
    finally { setLoadingSum(false) }
  }, [from, to])

  const loadTxns = useCallback(async () => {
    setLoadingTxns(true)
    try {
      const p = new URLSearchParams({ date_from: from, date_to: to, page: String(page), per_page: String(PER_PAGE) })
      const data = await apiFetch(`/api/reconciliation/interswitch/transactions?${p}`)
      const rows = data?.data?.transactions || data?.data?.items || data?.data
      setTxns(Array.isArray(rows) ? rows : [])
    } catch { setTxns([]) }
    finally { setLoadingTxns(false) }
  }, [from, to, page])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { if (subTab === 'transactions') loadTxns() }, [loadTxns, subTab])

  const isw = summary?.interswitch || {}
  const eod = summary?.eod || {}
  const configured = summary?.configured !== false

  if (summary && !configured) {
    return (
      <div className="card p-12 flex flex-col items-center text-slate-400 gap-3">
        <span className="material-symbols-rounded text-[48px] opacity-25">account_balance</span>
        <p className="font-semibold text-slate-600">Interswitch not configured</p>
        <p className="text-sm">{summary.message || 'Set INTERSWITCH_CLIENT_ID, INTERSWITCH_CLIENT_SECRET, INTERSWITCH_BASE_URL'}</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex gap-1 mb-5 p-1 rounded-lg bg-slate-100 inline-flex">
        {(['summary', 'transactions'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className="px-3 py-1.5 rounded-md text-[12px] font-semibold capitalize transition-all"
            style={{
              background: subTab === t ? '#fff' : 'transparent',
              color: subTab === t ? NAVY : '#64748B',
              boxShadow: subTab === t ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}>
            {t === 'summary' ? 'Summary' : 'Transactions'}
          </button>
        ))}
      </div>

      {subTab === 'summary' && (
        loadingSum
          ? <div className="flex items-center gap-3 py-10 text-slate-400"><Spinner />Loading…</div>
          : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
                {[
                  { label: 'Transaction Count', value: fmtNum(isw.txn_count), icon: 'receipt_long', accent: NAVY },
                  { label: 'Total Volume', value: fmtExact(isw.total_volume), icon: 'payments', accent: '#8B5CF6' },
                  { label: 'EOD Volume', value: fmtExact(eod.total_vol_ngn), icon: 'account_balance', accent: '#0891B2' },
                ].map(({ label, value, icon, accent }) => (
                  <div key={label} className="card p-5">
                    <div className="flex items-start justify-between mb-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400">{label}</p>
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${accent}12` }}>
                        <span className="material-symbols-rounded text-[16px]" style={{ color: accent }}>{icon}</span>
                      </div>
                    </div>
                    <p className="kpi-number text-[22px] leading-none text-slate-900">{value}</p>
                  </div>
                ))}
              </div>
              <ComparePanel
                ps={{ total_count: isw.txn_count, total_volume_ngn: isw.total_volume }}
                eod={eod}
                loading={false}
              />
              {isw.error && (
                <div className="flex items-start gap-2 p-4 rounded-xl mt-3"
                  style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <span className="material-symbols-rounded text-[17px] mt-0.5 text-red-600 flex-shrink-0">error</span>
                  <p className="text-[12px] text-red-800">Interswitch API error: {isw.error}</p>
                </div>
              )}
            </>
          )
      )}

      {subTab === 'transactions' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <p className="text-[14px] font-semibold text-slate-800">Interswitch Transactions</p>
            <p className="text-[12px] text-slate-400 mt-0.5">{fmtDate(from)} – {fmtDate(to)}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: NAVY }}>
                  {['#', 'Transaction Ref', 'Amount', 'Status', 'Channel', 'Date'].map(h => (
                    <th key={h} className="px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-left"
                      style={{ color: 'rgba(255,255,255,0.7)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadingTxns
                  ? <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                      <div className="flex items-center justify-center gap-2"><Spinner />Loading…</div>
                    </td></tr>
                  : txns.length === 0
                  ? <tr><td colSpan={6} className="px-5 py-14 text-center">
                      <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">receipt_long</span>
                      <p className="text-[13px] text-slate-400">No transactions returned</p>
                    </td></tr>
                  : txns.map((t: any, i: number) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors"
                      style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                      <td className="px-5 py-3 text-xs text-slate-400">{(page - 1) * PER_PAGE + i + 1}</td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-500">
                        {t.transactionReference || t.reference || t.txnRef || '—'}
                      </td>
                      <td className="px-5 py-3 font-mono font-semibold">
                        {fmtExact(t.amount || t.transactionAmount || 0)}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={(t.responseCode || t.statusCode) === '00' ? 'paid' : 'declined'} />
                      </td>
                      <td className="px-5 py-3 text-xs capitalize text-slate-600">{t.channel || t.paymentMode || '—'}</td>
                      <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {fmtTs(t.createdAt || t.transactionDate || t.created_at)}
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
          {(txns.length >= PER_PAGE || page > 1) && (
            <div className="px-5 py-3 flex items-center justify-between"
              style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
              <p className="text-xs text-slate-400">Page {page}</p>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                  <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                </button>
                <button onClick={() => setPage(p => p + 1)} disabled={txns.length < PER_PAGE}
                  className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
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

/* ══════════════════════════════
   MAIN PAGE
══════════════════════════════ */
const TABS = [
  { key: 'paystack', label: 'Paystack', icon: 'payments' },
  { key: 'interswitch', label: 'Interswitch', icon: 'account_balance' },
] as const

type TabKey = typeof TABS[number]['key']

export default function Reconciliation() {
  const [tab, setTab] = useState<TabKey>('paystack')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [error] = useState('')

  return (
    <Page dept="Finance" title="Reconciliation"
      subtitle="Match processor settlements against internal EOD ledger"
      actions={
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      }>

      <ErrBanner msg={error} />

      {/* Processor selector */}
      <div className="flex gap-0 mb-6 border-b-2" style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 text-[13px] font-semibold transition-all"
            style={{
              borderBottom: tab === t.key ? `2px solid ${NAVY}` : '2px solid transparent',
              marginBottom: -2,
              color: tab === t.key ? NAVY : '#94A3B8',
            }}>
            <span className="material-symbols-rounded text-[17px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'paystack' && <PaystackTab from={from} to={to} />}
      {tab === 'interswitch' && <InterspwitchTab from={from} to={to} />}
    </Page>
  )
}
