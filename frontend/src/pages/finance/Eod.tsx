import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiExport } from '../../lib/api'
import { fmt, fmtNum, fmtExact, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, SectionCard, DateFilter, AreaChartCard, ProgressList, Spinner, ErrBanner, ExportBtn,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── Transaction category colors ── */
const TXN_COLORS: Record<string, string> = {
  'Transfer Out': RED,
  'Transfer In': GREEN,
  'Purchase': '#3B82F6',
  'Utility Payment': '#8B5CF6',
  'Cash Advance': AMBER,
  'Bank Payment': '#0891B2',
  'Purchase Reversal': '#94A3B8',
  'Cash Advance Reversal': '#94A3B8',
  'Bank Payment Reversal': '#94A3B8',
  'Account Fee': '#94A3B8',
  'Other': '#64748B',
}
function txnColor(cat: string) { return TXN_COLORS[cat] ?? '#64748B' }

/* ── Branch card ── */
function BranchCard({ branches, loading }: { branches: any[]; loading: boolean }) {
  return (
    <SectionCard title="By Branch" subtitle="DR/CR split">
      <div className="px-5 py-4 space-y-4">
        {loading
          ? Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="skeleton h-3 w-32 rounded" />
                <div className="skeleton h-1.5 rounded-full" />
              </div>
            ))
          : branches.length === 0
          ? <p className="text-sm text-slate-400 py-4 text-center">No branch data</p>
          : branches.map((b: any, i: number) => {
            const net = n(b.total_cr) - n(b.total_dr)
            const isPos = net >= 0
            const pctDr = n(b.total_dr) + n(b.total_cr) > 0
              ? (n(b.total_dr) / (n(b.total_dr) + n(b.total_cr))) * 100
              : 50
            return (
              <div key={i}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="text-[13px] font-semibold text-slate-800 leading-snug">{b.branch_name}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {fmtNum(b.txn_count)} txns · {fmtNum(b.accounts)} accounts
                    </p>
                  </div>
                  <span className="text-[13px] font-bold tabular-nums" style={{ color: isPos ? GREEN : RED }}>
                    {isPos ? '+' : ''}{fmt(net)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden flex" style={{ background: 'rgba(14,40,65,0.07)' }}>
                  <div style={{ width: `${pctDr}%`, background: RED, opacity: 0.7 }} />
                  <div style={{ flex: 1, background: GREEN, opacity: 0.7 }} />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[11px] tabular-nums" style={{ color: RED }}>DR {fmt(b.total_dr)}</span>
                  <span className="text-[11px] tabular-nums" style={{ color: GREEN }}>CR {fmt(b.total_cr)}</span>
                </div>
              </div>
            )
          })
        }
      </div>
    </SectionCard>
  )
}

const PAGE_SIZE = 200

export default function Eod() {
  const [uploads, setUploads] = useState<any[]>([])
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())

  const [summary, setSummary] = useState<any>(null)
  const [byProduct, setByProduct] = useState<any[]>([])
  const [byType, setByType] = useState<any[]>([])
  const [byBranch, setByBranch] = useState<any[]>([])
  const [trend, setTrend] = useState<any[]>([])
  const [txns, setTxns] = useState<any[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [page, setPage] = useState(0)

  // Filters
  const [branch, setBranch] = useState('')
  const [product, setProduct] = useState('')
  const [txnType, setTxnType] = useState('')
  const [sign, setSign] = useState('')
  const [search, setSearch] = useState('')

  const [loadingUploads, setLoadingUploads] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadingTbl, setLoadingTbl] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoadingUploads(true)
    apiFetch('/api/eod/uploads')
      .then((data: any[]) => { setUploads(data) })
      .catch(() => {})
      .finally(() => setLoadingUploads(false))
  }, [])

  const loadSummary = useCallback(async () => {
    if (!from || !to) return
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({ date_from: from, date_to: to })
      if (branch) p.set('branch', branch)
      if (product) p.set('product', product)
      if (txnType) p.set('txn_type', txnType)
      if (sign) p.set('sign', sign)
      const [rSum, rProd, rTyp, rBr, rTr] = await Promise.allSettled([
        apiFetch(`/api/eod/summary?${p}`),
        apiFetch(`/api/eod/by-product?date_from=${from}&date_to=${to}${branch ? `&branch=${branch}` : ''}${txnType ? `&txn_type=${txnType}` : ''}${sign ? `&sign=${sign}` : ''}`),
        apiFetch(`/api/eod/by-type?date_from=${from}&date_to=${to}${branch ? `&branch=${branch}` : ''}${product ? `&product=${product}` : ''}${sign ? `&sign=${sign}` : ''}`),
        apiFetch(`/api/eod/by-branch?date_from=${from}&date_to=${to}`),
        apiFetch(`/api/eod/trend?date_from=${from}&date_to=${to}`),
      ])
      if (rSum.status === 'fulfilled') setSummary(rSum.value)
      if (rProd.status === 'fulfilled') setByProduct(rProd.value)
      if (rTyp.status === 'fulfilled') setByType(rTyp.value)
      if (rBr.status === 'fulfilled') setByBranch(rBr.value)
      if (rTr.status === 'fulfilled') setTrend(rTr.value)
      if ([rSum, rProd, rTyp, rBr, rTr].every(r => r.status === 'rejected')) setError('Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to, branch, product, txnType, sign])

  const loadTxns = useCallback(async () => {
    if (!from || !to) return
    setLoadingTbl(true)
    try {
      const p = new URLSearchParams({ date_from: from, date_to: to, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
      if (branch) p.set('branch', branch)
      if (product) p.set('product', product)
      if (txnType) p.set('txn_type', txnType)
      if (sign) p.set('sign', sign)
      if (search) p.set('q', search)
      const res = await apiFetch(`/api/eod/transactions?${p}`)
      setTxns(res.data || []); setTotalRows(res.total || 0)
    } finally { setLoadingTbl(false) }
  }, [from, to, branch, product, txnType, sign, search, page])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { loadTxns() }, [loadTxns])

  function resetFilters() { setBranch(''); setProduct(''); setTxnType(''); setSign(''); setSearch(''); setPage(0) }

  const s = summary || {}
  const net = n(s.net_movement)
  const netPos = net >= 0
  const activeFilters = [branch, product, txnType, sign].filter(Boolean).length
  const allCategories = [...new Set(byType.map((r: any) => r.txn_category))]

  if (loadingUploads) {
    return (
      <Page dept="Finance" title="EOD Report" subtitle="Daily financial card account transactions">
        <div className="card p-12 flex flex-col items-center gap-3 text-slate-400">
          <Spinner size={28} /><p className="text-sm">Loading…</p>
        </div>
      </Page>
    )
  }

  if (uploads.length === 0) {
    return (
      <Page dept="Finance" title="EOD Report" subtitle="Daily financial card account transactions">
        <div className="card p-12 flex flex-col items-center text-slate-400 gap-3">
          <span className="material-symbols-rounded text-[48px] opacity-25">receipt_long</span>
          <p className="font-semibold text-slate-700">No EOD files loaded yet</p>
          <p className="text-sm">Upload EODTXN files to generate this report.</p>
          <a href="/uploads"
            className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[17px]">upload_file</span>
            Go to Data Uploads
          </a>
        </div>
      </Page>
    )
  }

  return (
    <Page dept="Finance" title="EOD Report"
      subtitle="Daily financial card account transactions"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); setPage(0) }} />
          <ExportBtn
            onClick={async () => {
              setExporting(true)
              const p = new URLSearchParams({ date_from: from, date_to: to })
              if (branch) p.set('branch', branch)
              if (product) p.set('product', product)
              if (txnType) p.set('txn_type', txnType)
              if (sign) p.set('sign', sign)
              if (search) p.set('q', search)
              await apiExport(`/api/eod/transactions/export?${p}`, `eod_${from}_${to}`)
              setExporting(false)
            }}
            loading={exporting}
          />
        </div>
      }>

      <ErrBanner msg={error} />

      {/* ── Filter chips ── */}
      <div className="mb-5">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Branch */}
          <select value={branch} onChange={e => { setBranch(e.target.value); setPage(0) }}
            className="px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white"
            style={{ borderColor: branch ? NAVY : 'rgba(15,23,42,0.15)', color: '#334155' }}>
            <option value="">All Branches</option>
            {(s.branches || []).map((b: any) => (
              <option key={b.branch_code} value={b.branch_code}>{b.branch_name}</option>
            ))}
          </select>

          {/* Product */}
          <select value={product} onChange={e => { setProduct(e.target.value); setPage(0) }}
            className="px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white"
            style={{ borderColor: product ? NAVY : 'rgba(15,23,42,0.15)', color: '#334155' }}>
            <option value="">All Products</option>
            {(s.products || []).map((p: any) => (
              <option key={p.product_code} value={p.product_code}>{p.product_name}</option>
            ))}
          </select>

          {/* Type */}
          <select value={txnType} onChange={e => { setTxnType(e.target.value); setPage(0) }}
            className="px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white"
            style={{ borderColor: txnType ? NAVY : 'rgba(15,23,42,0.15)', color: '#334155' }}>
            <option value="">All Types</option>
            {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>

          {/* DR / CR toggles */}
          <button
            onClick={() => { setSign(sign === 'DR' ? '' : 'DR'); setPage(0) }}
            className="px-3 py-1.5 rounded-lg border text-[12px] font-semibold transition-all"
            style={{
              background: sign === 'DR' ? 'rgba(192,0,0,0.06)' : '#fff',
              borderColor: sign === 'DR' ? RED : 'rgba(15,23,42,0.15)',
              color: sign === 'DR' ? RED : '#64748B',
            }}>
            ↑ Debits only
          </button>
          <button
            onClick={() => { setSign(sign === 'CR' ? '' : 'CR'); setPage(0) }}
            className="px-3 py-1.5 rounded-lg border text-[12px] font-semibold transition-all"
            style={{
              background: sign === 'CR' ? 'rgba(5,150,105,0.06)' : '#fff',
              borderColor: sign === 'CR' ? GREEN : 'rgba(15,23,42,0.15)',
              color: sign === 'CR' ? GREEN : '#64748B',
            }}>
            ↓ Credits only
          </button>

          {/* Search */}
          <div className="relative ml-auto">
            <span className="material-symbols-rounded absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-slate-400 pointer-events-none">
              search
            </span>
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0) }}
              placeholder="CIF, account, customer…"
              className="pl-8 pr-3 py-1.5 rounded-lg border text-[12px] w-52 outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            />
          </div>

          {(activeFilters > 0 || search) && (
            <button onClick={resetFilters}
              className="text-[12px] font-medium text-slate-400 hover:text-red-500 flex items-center gap-1 transition-colors">
              <span className="material-symbols-rounded text-[14px]">filter_alt_off</span>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {loading
        ? <div className="flex items-center gap-3 py-10 text-slate-400"><Spinner />Loading report…</div>
        : (
          <>
            {/* KPI Row */}
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-5">
              {[
                { label: 'Total Volume', value: fmt(s.total_volume), icon: 'payments', accent: NAVY },
                { label: 'Net Movement', value: (netPos ? '+' : '') + fmt(net), icon: 'swap_vert', accent: netPos ? GREEN : RED, valueColor: netPos ? GREEN : RED },
                { label: 'Total Debits', value: fmt(s.total_dr), icon: 'arrow_upward', accent: RED },
                { label: 'Total Credits', value: fmt(s.total_cr), icon: 'arrow_downward', accent: GREEN },
                { label: 'Transactions', value: fmtNum(s.txn_count), icon: 'receipt_long', accent: '#8B5CF6', sub: s.days_covered > 1 ? `${s.days_covered} days` : undefined },
                { label: 'Active Accounts', value: fmtNum(s.active_accounts), icon: 'credit_card', accent: '#0891B2', sub: `${fmtNum(s.active_cifs)} customers` },
              ].map(({ label, value, icon, accent, valueColor, sub }: any) => (
                <div key={label} className="card p-5">
                  <div className="flex items-start justify-between mb-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400">{label}</p>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}12` }}>
                      <span className="material-symbols-rounded text-[16px]" style={{ color: accent }}>{icon}</span>
                    </div>
                  </div>
                  <p className="kpi-number text-[22px] leading-none" style={{ color: valueColor || '#0F172A' }}>{value}</p>
                  {sub && <p className="text-[11px] text-slate-400 mt-2">{sub}</p>}
                </div>
              ))}
            </div>

            {/* Charts row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
              <ProgressList
                title="Transaction Types"
                data={byType.map((r: any) => ({ label: r.txn_category, value: n(r.total_volume) }))}
                nameKey="label"
                valueKey="value"
                currency
                loading={false}
              />
              <ProgressList
                title="By Product"
                data={byProduct.map((r: any) => ({ label: r.product_name || r.product_code, value: n(r.total_volume) }))}
                nameKey="label"
                valueKey="value"
                currency
                loading={false}
              />
              <BranchCard branches={byBranch} loading={false} />
            </div>

            {trend.length > 1 && (
              <div className="mb-5">
                <AreaChartCard
                  title="Daily Volume"
                  subtitle="Credits vs Debits"
                  data={trend}
                  xKey="label"
                  areaKey="total_volume"
                  color={NAVY}
                  currency
                  height={200}
                  loading={false}
                />
              </div>
            )}

            {/* Transaction table */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3.5 flex items-center justify-between"
                style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
                <div>
                  <p className="text-[14px] font-semibold text-slate-800">Transactions</p>
                  <p className="text-[12px] text-slate-400 mt-0.5">{fmtDate(from)} – {fmtDate(to)}</p>
                </div>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(14,40,65,0.07)', color: '#475569' }}>
                  {totalRows.toLocaleString()} rows
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr style={{ background: NAVY }}>
                      {['Date', 'Customer', 'Account', 'Product', 'Type', 'Card', 'Merchant', 'Description', 'Amount', 'DR/CR', 'Balance', 'Trace #']
                        .map((h, i) => (
                          <th key={h} className={`px-4 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap ${i >= 8 ? 'text-right' : 'text-left'}`}
                            style={{ color: 'rgba(255,255,255,0.7)' }}>{h}</th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loadingTbl
                      ? <tr><td colSpan={12} className="px-5 py-10 text-center text-slate-400">
                          <div className="flex items-center justify-center gap-2"><Spinner />Loading…</div>
                        </td></tr>
                      : txns.length === 0
                      ? <tr><td colSpan={12} className="px-5 py-14 text-center">
                          <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">receipt_long</span>
                          <p className="text-[13px] text-slate-400">No transactions for this period or filter combination</p>
                        </td></tr>
                      : txns.map((t: any, i: number) => {
                        const isDr = t.sign === 'DR'
                        return (
                          <tr key={i} className="hover:bg-slate-50 transition-colors"
                            style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmtDate(t.txn_date)}</td>
                            <td className="px-4 py-3">
                              <p className="text-[13px] font-medium text-slate-800 truncate max-w-[120px]">{t.customer || <span className="text-slate-300">—</span>}</p>
                              <p className="text-[11px] text-slate-400 font-mono">{t.cif}</p>
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-slate-500">{t.account_no}</td>
                            <td className="px-4 py-3 text-xs text-slate-600 max-w-[80px] truncate" title={t.product_name}>{t.product_name}</td>
                            <td className="px-4 py-3">
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
                                style={{ background: txnColor(t.txn_category) + '15', color: txnColor(t.txn_category) }}>
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: txnColor(t.txn_category), flexShrink: 0, display: 'inline-block' }} />
                                {t.txn_category}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-slate-400">{t.card_num || '—'}</td>
                            <td className="px-4 py-3 text-xs text-slate-600 max-w-[100px] truncate" title={t.merchant_name}>{t.merchant_name || '—'}</td>
                            <td className="px-4 py-3 text-xs text-slate-500">{t.description}</td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-mono font-semibold text-[13px]" style={{ color: isDr ? RED : GREEN }}>
                                {fmtExact(t.amount)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded"
                                style={{ background: isDr ? 'rgba(192,0,0,0.08)' : 'rgba(5,150,105,0.08)', color: isDr ? RED : GREEN }}>
                                {isDr ? '↑ DR' : '↓ CR'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right text-xs tabular-nums"
                              style={{ color: n(t.balance) < 0 ? RED : '#475569' }}>
                              {fmtExact(t.balance)}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-slate-400">{t.trace_num}</td>
                          </tr>
                        )
                      })
                    }
                  </tbody>
                </table>
              </div>
              {totalRows > PAGE_SIZE && (
                <div className="px-5 py-3 flex items-center justify-between"
                  style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                  <p className="text-xs text-slate-400">
                    Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalRows)} of {totalRows.toLocaleString()}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                      className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40"
                      style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                      <span className="material-symbols-rounded text-[17px]">chevron_left</span>
                    </button>
                    <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= totalRows}
                      className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40"
                      style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                      <span className="material-symbols-rounded text-[17px]">chevron_right</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )
      }
    </Page>
  )
}
