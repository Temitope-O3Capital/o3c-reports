import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtExact, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, DateFilter, StatusBadge, ChannelBadge, Spinner,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── API response types ───────────────────────────────────────────────────── */
interface PsSummary {
  configured: boolean
  message?: string
  total_count: number
  success: number
  failed: number
  total_volume_kobo: number
  total_volume_ngn: number
  error?: string
}

interface EodSummary {
  txn_count: number
  total_dr_ngn: number
  total_cr_ngn: number
  total_vol_ngn: number
}

interface ReconSummaryResponse {
  configured: boolean
  message?: string
  paystack?: PsSummary
  eod?: EodSummary
}

interface PsTxn {
  id: number
  reference: string
  amount: number
  fees?: number
  status: string
  channel: string
  currency: string
  customer?: { email?: string; first_name?: string; last_name?: string }
  authorization?: { last4?: string; card_type?: string; bank?: string }
  created_at: string
  paid_at?: string
}

interface PsSettlement {
  id: number
  settled_by?: string
  settlement_date?: string
  createdAt?: string
  domain?: string
  status: string
  total_amount?: number
  total_fees?: number
  total_processed?: number
  net_amount?: number
  effective_amount?: number
}

interface LedgerEntry {
  description: string
  amount: number
  difference?: number
  closing_balance: number
  created_at: string
  model_responsible?: string
  [key: string]: unknown
}

interface PsPagedResponse<T> {
  data: T[]
  meta: { total: number; page: number; perPage: number }
}

interface BalanceLedger {
  data: LedgerEntry[]
  meta?: { total: number; page: number; perPage: number }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function fmtTs(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return s }
}

/** Convert kobo integer to formatted ₦ string */
function kobo(v: unknown): string {
  return fmtExact(n(v) / 100)
}

/* ── KPI card ────────────────────────────────────────────────────────────── */
function KpiCard({ label, value, icon, accent, sub, large }: {
  label: string; value: string; icon: string; accent: string; sub?: string; large?: boolean
}) {
  return (
    <div className="card p-5 flex flex-col gap-2" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400">{label}</p>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${accent}18` }}>
          <span className="material-symbols-rounded text-[15px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p className={`kpi-number leading-none text-slate-900 ${large ? 'text-[28px]' : 'text-[22px]'}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  )
}

/* ── Delta badge ─────────────────────────────────────────────────────────── */
function DeltaBadge({ apiVal, eodVal, isCount = false }: {
  apiVal: number; eodVal: number; isCount?: boolean
}) {
  const diff = apiVal - eodVal
  const pct = eodVal !== 0 ? Math.abs(diff / eodVal) * 100 : null
  const ok = pct !== null ? pct < 1 : diff === 0
  const warn = pct !== null && pct < 5
  const color = ok ? GREEN : warn ? AMBER : RED
  const bg = ok ? 'rgba(5,150,105,0.06)' : warn ? 'rgba(217,119,6,0.06)' : 'rgba(192,0,0,0.06)'
  const sign = diff >= 0 ? '+' : ''
  const label = isCount ? sign + fmtNum(diff) : sign + fmtExact(Math.abs(diff))
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-bold"
      style={{ background: bg, color, border: `1px solid ${color}22` }}>
      <span className="material-symbols-rounded text-[14px]">{ok ? 'check_circle' : 'warning'}</span>
      {label}
      {pct !== null && <span className="font-normal opacity-75">({pct.toFixed(1)}%)</span>}
      <span className="font-normal">{ok ? '· Balanced' : warn ? '· Minor gap' : '· Mismatch'}</span>
    </span>
  )
}

/* ── Reconciliation comparison table ─────────────────────────────────────── */
function ComparePanel({ ps, eod }: { ps: PsSummary | null; eod: EodSummary | null }) {
  return (
    <div className="card overflow-hidden mb-5">
      <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
        <p className="text-[14px] font-semibold text-slate-800">Processor vs Ledger Reconciliation</p>
        <p className="text-[12px] text-slate-400 mt-0.5">Paystack API totals vs internal EOD ledger</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr style={{ background: NAVY }}>
              {['Metric', 'Paystack (Source)', 'EOD Ledger', 'Delta'].map((h, i) => (
                <th key={h} className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] ${i > 0 ? 'text-right' : 'text-left'}`}
                  style={{ color: 'rgba(255,255,255,0.7)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
              <td className="px-5 py-4 font-semibold text-slate-800">Transaction Count</td>
              <td className="px-5 py-4 text-right font-mono font-bold">{fmtNum(n(ps?.total_count))}</td>
              <td className="px-5 py-4 text-right font-mono font-bold">{fmtNum(n(eod?.txn_count))}</td>
              <td className="px-5 py-4 text-right">
                <DeltaBadge apiVal={n(ps?.total_count)} eodVal={n(eod?.txn_count)} isCount />
              </td>
            </tr>
            <tr style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
              <td className="px-5 py-4 font-semibold text-slate-800">Total Volume (NGN)</td>
              <td className="px-5 py-4 text-right font-mono font-bold">{fmtExact(n(ps?.total_volume_ngn))}</td>
              <td className="px-5 py-4 text-right font-mono font-bold">{fmtExact(n(eod?.total_vol_ngn))}</td>
              <td className="px-5 py-4 text-right">
                <DeltaBadge apiVal={n(ps?.total_volume_ngn)} eodVal={n(eod?.total_vol_ngn)} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Paginator ───────────────────────────────────────────────────────────── */
function Pager({ page, total, perPage, onChange }: {
  page: number; total: number; perPage: number; onChange: (p: number) => void
}) {
  const pages = Math.ceil(total / perPage) || 1
  if (pages <= 1 && page === 1) return null
  return (
    <div className="px-5 py-3 flex items-center justify-between"
      style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
      <p className="text-xs text-slate-400">Page {page} of {pages} · {fmtNum(total)} total</p>
      <div className="flex gap-2">
        <button onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1}
          className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40 hover:bg-slate-50"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
          <span className="material-symbols-rounded text-[17px]">chevron_left</span>
        </button>
        <button onClick={() => onChange(Math.min(pages, page + 1))} disabled={page >= pages}
          className="w-8 h-8 flex items-center justify-center rounded-lg border text-slate-500 disabled:opacity-40 hover:bg-slate-50"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
          <span className="material-symbols-rounded text-[17px]">chevron_right</span>
        </button>
      </div>
    </div>
  )
}

/* ── Table helpers ───────────────────────────────────────────────────────── */
function THead({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr style={{ background: NAVY }}>
        {cols.map(h => (
          <th key={h} className="px-4 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-left whitespace-nowrap"
            style={{ color: 'rgba(255,255,255,0.7)' }}>{h}</th>
        ))}
      </tr>
    </thead>
  )
}

function Empty({ icon, msg, cols }: { icon: string; msg: string; cols: number }) {
  return (
    <tr><td colSpan={cols} className="px-5 py-14 text-center">
      <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">{icon}</span>
      <p className="text-[13px] text-slate-400">{msg}</p>
    </td></tr>
  )
}

function Loading({ cols }: { cols: number }) {
  return (
    <tr><td colSpan={cols} className="px-5 py-10 text-center text-slate-400">
      <div className="flex items-center justify-center gap-2"><Spinner />Loading…</div>
    </td></tr>
  )
}

/* ── Filter pill group ───────────────────────────────────────────────────── */
function FilterPills<T extends string>({ value, options, onChange }: {
  value: T; options: { label: string; value: T }[]; onChange: (v: T) => void
}) {
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-slate-100" style={{ display: 'inline-flex' }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className="px-3 py-1 rounded-md text-[12px] font-semibold transition-all"
          style={{
            background: value === o.value ? '#fff' : 'transparent',
            color: value === o.value ? NAVY : '#64748B',
            boxShadow: value === o.value ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── data hook ───────────────────────────────────────────────────────────── */
function usePSFetch<T = any>(url: string | null): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    setLoading(true)
    apiFetch(url)
      .then(d => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [url])
  return { data, loading }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PAYSTACK TAB
═══════════════════════════════════════════════════════════════════════════ */
const PER_PAGE = 50
const PS_SUB_TABS = [
  { key: 'summary',      label: 'Summary',      icon: 'dashboard' },
  { key: 'transactions', label: 'Transactions',  icon: 'receipt_long' },
  { key: 'settlements',  label: 'Settlements',   icon: 'account_balance' },
  { key: 'transfers',    label: 'Transfers',     icon: 'send' },
  { key: 'fees',         label: 'Fees & Ledger', icon: 'price_change' },
  { key: 'refunds',      label: 'Refunds',       icon: 'undo' },
  { key: 'disputes',     label: 'Disputes',      icon: 'gavel' },
] as const
type PSSubTab = typeof PS_SUB_TABS[number]['key']

function PaystackTab({ from, to }: { from: string; to: string }) {
  const [sub, setSub] = useState<PSSubTab>('summary')

  const [txnPage, setTxnPage]     = useState(1)
  const [txnStatus, setTxnStatus] = useState('')
  const [settlePage, setSettlePage] = useState(1)
  const [xfrPage, setXfrPage]     = useState(1)
  const [xfrStatus, setXfrStatus] = useState('')
  const [ledgerPage, setLedgerPage] = useState(1)
  const [ledgerDir, setLedgerDir] = useState<'all' | 'credit' | 'debit'>('all')
  const [refundPage, setRefundPage] = useState(1)
  const [disputePage, setDisputePage] = useState(1)

  // reset all pages when date range changes
  useEffect(() => {
    setTxnPage(1); setSettlePage(1); setXfrPage(1)
    setLedgerPage(1); setRefundPage(1); setDisputePage(1)
  }, [from, to])

  // URL builders — null means "don't fetch yet"
  const summaryURL = `/api/reconciliation/paystack/summary?date_from=${from}&date_to=${to}`
  const balanceURL = `/api/reconciliation/paystack/balance`

  const txnP = new URLSearchParams({ date_from: from, date_to: to, page: String(txnPage), per_page: '50' })
  if (txnStatus) txnP.set('status', txnStatus)
  const txnURL = sub === 'transactions' ? `/api/reconciliation/paystack/transactions?${txnP}` : null

  const settleURL = sub === 'settlements'
    ? `/api/reconciliation/paystack/settlements?from=${from}&to=${to}&page=${settlePage}&per_page=50`
    : null

  const xfrP = new URLSearchParams({ from, to, page: String(xfrPage), per_page: '50' })
  if (xfrStatus) xfrP.set('status', xfrStatus)
  const xfrURL = sub === 'transfers' ? `/api/reconciliation/paystack/transfers?${xfrP}` : null

  const ledgerURL  = sub === 'fees'     ? `/api/reconciliation/paystack/ledger?page=${ledgerPage}&per_page=50`   : null
  const refundURL  = sub === 'refunds'  ? `/api/reconciliation/paystack/refunds?page=${refundPage}&per_page=50`  : null
  const disputeURL = sub === 'disputes' ? `/api/reconciliation/paystack/disputes?page=${disputePage}&per_page=50`: null

  const { data: summary, loading: loadingSum } = usePSFetch<ReconSummaryResponse>(summaryURL)
  const { data: balance }                       = usePSFetch<BalanceLedger>(balanceURL)
  const { data: txnData, loading: loadingTxns } = usePSFetch<PsPagedResponse<PsTxn>>(txnURL)
  const { data: settleData, loading: loadingSett } = usePSFetch<PsPagedResponse<PsSettlement>>(settleURL)
  const { data: xfrData, loading: loadingXfr }  = usePSFetch<PsPagedResponse<Record<string, any>>>(xfrURL)
  const { data: ledgerData, loading: loadingLedger } = usePSFetch<BalanceLedger>(ledgerURL)
  const { data: refundData, loading: loadingRef }    = usePSFetch<PsPagedResponse<Record<string, any>>>(refundURL)
  const { data: disputeData, loading: loadingDisp }  = usePSFetch<PsPagedResponse<Record<string, any>>>(disputeURL)

  const ps  = summary?.paystack ?? null
  const eod = summary?.eod ?? null
  const balArr = balance?.data ?? []
  const liveBalKobo = n(balArr[0]?.balance)

  const allLedger = ledgerData?.data ?? []
  const filteredLedger = allLedger.filter(r => {
    const d = n(r.difference)
    if (ledgerDir === 'credit') return d > 0
    if (ledgerDir === 'debit')  return d < 0
    return true
  })

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
      {/* ── sub-tab bar ── */}
      <div className="flex flex-wrap gap-1 mb-5 p-1 rounded-xl bg-slate-100" style={{ display: 'inline-flex' }}>
        {PS_SUB_TABS.map(t => (
          <button key={t.key} onClick={() => setSub(t.key)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all"
            style={{
              background: sub === t.key ? '#fff' : 'transparent',
              color: sub === t.key ? NAVY : '#64748B',
              boxShadow: sub === t.key ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}>
            <span className="material-symbols-rounded text-[14px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* ══ SUMMARY ══ */}
      {sub === 'summary' && (
        loadingSum
          ? <div className="flex items-center gap-3 py-10 text-slate-400"><Spinner />Loading…</div>
          : <>
            {/* Top: live balance banner */}
            <div className="card p-5 mb-5 flex items-center gap-5"
              style={{ background: NAVY, border: 'none' }}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.1)' }}>
                <span className="material-symbols-rounded text-[24px] text-white fill-icon">account_balance_wallet</span>
              </div>
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-white/50">Live Paystack Wallet Balance</p>
                <p className="kpi-number text-[32px] leading-tight text-white">{liveBalKobo > 0 ? fmtExact(liveBalKobo / 100) : '—'}</p>
              </div>
              <div className="ml-auto text-right">
                <p className="text-[11px] text-white/40 uppercase tracking-widest">Period</p>
                <p className="text-[13px] font-semibold text-white/80">{fmtDate(from)} – {fmtDate(to)}</p>
              </div>
            </div>

            {/* KPI grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
              <KpiCard label="Total Transactions" icon="receipt_long" accent={NAVY}
                value={fmtNum(n(ps?.total_count))}
                sub={`Incoming payments via Paystack`} />
              <KpiCard label="Successful" icon="check_circle" accent={GREEN}
                value={fmtNum(n(ps?.success))}
                sub={`Fully settled`} />
              <KpiCard label="Abandoned / Failed" icon="cancel" accent={RED}
                value={fmtNum(n(ps?.total_count) - n(ps?.success))}
                sub={`Not completed`} />
              <KpiCard label="Gross Volume" icon="payments" accent="#7C3AED"
                value={fmtExact(n(ps?.total_volume_ngn))}
                sub={`Total collected (incl. fees)`} />
            </div>

            <ComparePanel ps={ps} eod={eod} />

            {ps?.error && (
              <div className="flex items-start gap-2 p-4 rounded-xl"
                style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                <span className="material-symbols-rounded text-[17px] mt-0.5 text-red-600 flex-shrink-0">error</span>
                <p className="text-[12px] text-red-800">Paystack API error: {ps.error}</p>
              </div>
            )}
          </>
      )}

      {/* ══ TRANSACTIONS (money in) ══ */}
      {sub === 'transactions' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 flex items-center justify-between flex-wrap gap-3"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <div>
              <p className="text-[14px] font-semibold text-slate-800">Incoming Transactions</p>
              <p className="text-[12px] text-slate-400 mt-0.5">
                Money received <strong>from customers</strong> via Paystack · {fmtDate(from)} – {fmtDate(to)}
              </p>
            </div>
            <FilterPills
              value={txnStatus}
              options={[
                { label: 'All', value: '' },
                { label: 'Successful', value: 'success' },
                { label: 'Failed', value: 'failed' },
                { label: 'Abandoned', value: 'abandoned' },
              ]}
              onChange={v => { setTxnStatus(v); setTxnPage(1) }}
            />
          </div>
          {/* Fee legend */}
          <div className="px-5 py-2.5 flex items-center gap-4 text-[11px]"
            style={{ background: '#F8FAFC', borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <span className="text-slate-400">How to read fee columns:</span>
            <span className="flex items-center gap-1 text-slate-600 font-medium">
              <span style={{ width: 8, height: 8, borderRadius: 2, background: '#64748B', display: 'inline-block' }} />
              Gross = customer paid
            </span>
            <span className="flex items-center gap-1 font-medium" style={{ color: RED }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: RED, display: 'inline-block' }} />
              Paystack cut
            </span>
            <span className="flex items-center gap-1 font-medium" style={{ color: GREEN }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: GREEN, display: 'inline-block' }} />
              O3C net (received)
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <THead cols={['Reference & Date', 'Customer', 'Gross', 'Paystack Cut', 'O3C Net', 'Channel', 'Status']} />
              <tbody>
                {loadingTxns ? <Loading cols={7} />
                  : !(txnData?.data?.length)
                  ? <Empty icon="receipt_long" msg="No transactions in this period" cols={7} />
                  : txnData.data.map((t, i) => {
                    const cust    = (t as Record<string, any>).customer || {}
                    const auth    = (t as Record<string, any>).authorization || {}
                    const gross   = n(t.amount)
                    const fees    = n(t.fees)
                    const net     = gross - fees
                    const custName = [cust.first_name, cust.last_name].filter(Boolean).join(' ')
                    const cardInfo = auth.last4
                      ? `${auth.card_type || 'Card'} ····${auth.last4}${auth.bank ? ` · ${auth.bank}` : ''}`
                      : null
                    return (
                      <tr key={i} className="hover:bg-slate-50 transition-colors"
                        style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                        <td className="px-4 py-3.5">
                          <p className="font-mono text-[11px] text-slate-500">{t.reference}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">{fmtTs(t.paid_at || t.created_at)}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          {custName && <p className="text-[12px] font-semibold text-slate-700">{custName}</p>}
                          <p className="text-[11px] text-slate-500">{cust.email || '—'}</p>
                          {cardInfo && <p className="text-[10px] text-slate-400 mt-0.5">{cardInfo}</p>}
                        </td>
                        <td className="px-4 py-3.5 font-mono font-bold text-[14px] text-slate-700">
                          {kobo(gross)}
                        </td>
                        <td className="px-4 py-3.5 font-mono font-semibold text-[13px]"
                          style={{ color: fees > 0 ? RED : '#94A3B8' }}>
                          {fees > 0 ? kobo(fees) : '—'}
                        </td>
                        <td className="px-4 py-3.5 font-mono font-bold text-[14px]"
                          style={{ color: t.status === 'success' ? GREEN : '#94A3B8' }}>
                          {t.status === 'success' ? kobo(net) : '—'}
                        </td>
                        <td className="px-4 py-3.5">
                          <ChannelBadge channel={t.channel} />
                        </td>
                        <td className="px-4 py-3.5">
                          <StatusBadge status={t.status || 'pending'} />
                        </td>
                      </tr>
                    )
                  })
                }
              </tbody>
            </table>
          </div>
          <Pager page={txnPage} total={n(txnData?.meta?.total)} perPage={PER_PAGE} onChange={setTxnPage} />
        </div>
      )}

      {/* ══ SETTLEMENTS ══ */}
      {sub === 'settlements' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <p className="text-[14px] font-semibold text-slate-800">Paystack Settlements</p>
            <p className="text-[12px] text-slate-400 mt-0.5">
              Daily net amounts disbursed to your bank account by Paystack · {fmtDate(from)} – {fmtDate(to)}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <THead cols={['Settlement Date', 'Gross Collected', 'Paystack Fees', 'Net Settled to Bank', 'Status']} />
              <tbody>
                {loadingSett ? <Loading cols={5} />
                  : !(settleData?.data?.length)
                  ? <Empty icon="account_balance" msg="No settlements in this period" cols={5} />
                  : settleData.data.map((s, i) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors"
                      style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                      <td className="px-4 py-3.5 text-[12px] text-slate-700 whitespace-nowrap font-medium">
                        {fmtTs(s.settlement_date || s.createdAt)}
                      </td>
                      <td className="px-4 py-3.5 font-mono font-semibold text-slate-700">{kobo(s.total_processed)}</td>
                      <td className="px-4 py-3.5 font-mono text-[12px]" style={{ color: RED }}>{kobo(s.total_fees)}</td>
                      <td className="px-4 py-3.5 font-mono font-bold text-[14px]" style={{ color: GREEN }}>
                        {kobo(s.effective_amount ?? s.total_amount)}
                      </td>
                      <td className="px-4 py-3.5"><StatusBadge status={s.status || 'pending'} /></td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
          <Pager page={settlePage} total={n(settleData?.meta?.total)} perPage={PER_PAGE} onChange={setSettlePage} />
        </div>
      )}

      {/* ══ TRANSFERS (money out) ══ */}
      {sub === 'transfers' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 flex items-center justify-between flex-wrap gap-3"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <div>
              <p className="text-[14px] font-semibold text-slate-800">Outbound Transfers</p>
              <p className="text-[12px] text-slate-400 mt-0.5">
                Money sent <strong>from your Paystack wallet</strong> to external bank accounts · {fmtDate(from)} – {fmtDate(to)}
              </p>
            </div>
            <FilterPills
              value={xfrStatus}
              options={[
                { label: 'All', value: '' },
                { label: 'Successful', value: 'success' },
                { label: 'Failed', value: 'failed' },
                { label: 'Pending', value: 'pending' },
                { label: 'Reversed', value: 'reversed' },
              ]}
              onChange={v => { setXfrStatus(v); setXfrPage(1) }}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <THead cols={['Reference & Date', 'Recipient', 'Bank / Account', 'Amount Sent', 'Paystack Fee *', 'Wallet Debited', 'Status', 'Reason']} />
              <tbody>
                {loadingXfr ? <Loading cols={9} />
                  : !(xfrData?.data?.length)
                  ? <Empty icon="send" msg="No transfers in this period" cols={9} />
                  : xfrData!.data.map((t, i) => {
                    const recip   = t.recipient || {}
                    const details = recip.details || {}
                    const amt     = n(t.amount)
                    // Use actual fees from ledger if backend matched them; else estimate
                    const actual    = t.actual_fees
                    const feeActual = actual ? Math.round(n(actual.total) * 100) : n(t.fee_charged)
                    // Estimate: transfer fee (₦10/₦25/₦50) + stamp duty ₦50 for ≥ ₦10,000
                    const xferEst   = amt <= 500000 ? 1000 : amt <= 5000000 ? 2500 : 5000
                    const stampEst  = amt >= 1000000 ? 5000 : 0  // ₦50 stamp duty for ≥ ₦10,000
                    const feeEst    = xferEst + stampEst
                    const fee       = feeActual > 0 ? feeActual : (t.status === 'success' ? feeEst : 0)
                    const isEst     = !actual && feeActual === 0 && t.status === 'success'
                    const net       = amt + fee   // wallet debited = transfer amount + fees on top
                    return (
                      <tr key={i} className="hover:bg-slate-50 transition-colors"
                        style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                        <td className="px-4 py-3.5">
                          <p className="font-mono text-[11px] text-slate-500">{t.reference}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">{fmtTs(t.transferred_at || t.createdAt)}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="text-[12px] font-semibold text-slate-700">{details.account_name || recip.name || '—'}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">{recip.type ? `${recip.type}` : ''}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="text-[12px] text-slate-600">{details.bank_name || '—'}</p>
                          <p className="font-mono text-[10px] text-slate-400 mt-0.5">{details.account_number || '—'}</p>
                        </td>
                        <td className="px-4 py-3.5 font-mono font-bold text-[14px] text-slate-700">{kobo(amt)}</td>
                        <td className="px-4 py-3.5 font-mono font-semibold text-[13px]" style={{ color: fee > 0 ? RED : '#94A3B8' }}>
                          {fee > 0 ? (
                            <span title={actual
                              ? `Transfer fee: ₦${(n(actual.transfer_fee)).toFixed(2)} · Stamp duty: ₦${(n(actual.stamp_duty)).toFixed(2)}`
                              : `Estimated: transfer fee + ${amt >= 1000000 ? '₦50 stamp duty' : 'no stamp duty'}`}>
                              {kobo(fee)}
                              {isEst && <span className="text-[10px] text-slate-400 ml-1">est.</span>}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3.5 font-mono font-bold text-[14px]" style={{ color: t.status === 'success' ? RED : '#94A3B8' }}>
                          {t.status === 'success' ? kobo(net) : '—'}
                        </td>
                        <td className="px-4 py-3.5"><StatusBadge status={t.status || 'pending'} /></td>
                        <td className="px-4 py-3.5 text-[11px] text-slate-500 max-w-[140px] truncate">{t.reason || '—'}</td>
                      </tr>
                    )
                  })
                }
              </tbody>
            </table>
          </div>
          <Pager page={xfrPage} total={n(xfrData?.meta?.total)} perPage={PER_PAGE} onChange={setXfrPage} />
          <p className="text-[11px] text-slate-400 px-4 pb-3">
            * Paystack does not return per-transfer fees via API — fees marked <em>est.</em> are calculated from the standard schedule (₦10 / ₦25 / ₦50) and deducted from your Paystack balance, not from the transfer amount.
          </p>
        </div>
      )}

      {/* ══ FEES & LEDGER ══ */}
      {sub === 'fees' && (
        <div>
          {/* Fee summary cards */}
          <div className="grid grid-cols-3 gap-4 mb-5">
            {[
              { key: 'Transfer_Charge', label: 'Transfer Fees', icon: 'price_change', accent: RED },
              { key: 'Transfer_Stamp_Duty_Charge', label: 'Stamp Duty', icon: 'receipt', accent: AMBER },
              { key: 'Transfer', label: 'Transfers (Debits)', icon: 'send', accent: NAVY },
              { key: '__credits__', label: 'Wallet Funded', icon: 'account_balance_wallet', accent: GREEN },
            ].map(({ key, label, icon, accent }) => {
              const rows = key === '__credits__'
                ? allLedger.filter((r: any) => n(r.difference) > 0)
                : allLedger.filter(r => r.model_responsible === key)
              const total = key === '__credits__'
                ? rows.reduce((s: number, r: any) => s + n(r.difference), 0)
                : rows.reduce((s: number, r: any) => s + Math.abs(n(r.difference)), 0)
              return (
                <KpiCard key={key} label={label} icon={icon} accent={accent}
                  value={total > 0 ? fmtExact(total / 100) : '—'}
                  sub={`${rows.length} entries this page`} />
              )
            })}
          </div>

          <div className="card overflow-hidden">
            <div className="px-5 py-3.5 flex items-center justify-between flex-wrap gap-3"
              style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
              <div>
                <p className="text-[14px] font-semibold text-slate-800">Balance Ledger (Funding Log)</p>
                <p className="text-[12px] text-slate-400 mt-0.5">Every debit and credit to your Paystack wallet with running balance</p>
              </div>
              <FilterPills
                value={ledgerDir}
                options={[
                  { label: 'All', value: 'all' },
                  { label: 'Credits (+)', value: 'credit' },
                  { label: 'Debits (−)', value: 'debit' },
                ]}
                onChange={v => setLedgerDir(v)}
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <THead cols={['Type', 'Reason / Reference', 'Change', 'Running Balance', 'Date']} />
                <tbody>
                  {loadingLedger ? <Loading cols={5} />
                    : filteredLedger.length === 0
                    ? <Empty icon="price_change" msg="No ledger entries" cols={5} />
                    : filteredLedger.map((row: any, i: number) => {
                      const diff    = n(row.difference)
                      const isDebit = diff < 0
                      const typeMap: Record<string, string> = {
                        Transfer_Charge: 'Transfer Fee',
                        Transfer_Stamp_Duty_Charge: 'Stamp Duty',
                        Transfer: 'Transfer',
                        Settlement: 'Settlement',
                        Refund: 'Refund',
                        Chargeback: 'Chargeback',
                      }
                      const typeLabel = typeMap[row.model_responsible] || row.model_responsible || '—'
                      const isCharge = row.model_responsible?.includes('Charge')
                      return (
                        <tr key={i} className="hover:bg-slate-50 transition-colors"
                          style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold"
                              style={{
                                background: isCharge ? 'rgba(192,0,0,0.07)' : isDebit ? 'rgba(14,40,65,0.07)' : 'rgba(5,150,105,0.07)',
                                color: isCharge ? RED : isDebit ? NAVY : GREEN,
                              }}>
                              {typeLabel}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-[11px] text-slate-500 max-w-[220px] truncate">{row.reason || '—'}</td>
                          <td className="px-4 py-3 font-mono font-semibold text-[12px]"
                            style={{ color: diff > 0 ? GREEN : diff < 0 ? RED : '#94A3B8' }}>
                            {diff !== 0 ? `${diff > 0 ? '+' : ''}${fmtExact(diff / 100)}` : '—'}
                          </td>
                          <td className="px-4 py-3 font-mono text-[12px] font-semibold text-slate-700">
                            {fmtExact(n(row.balance) / 100)}
                          </td>
                          <td className="px-4 py-3 text-[11px] text-slate-500 whitespace-nowrap">
                            {fmtTs(row.createdAt)}
                          </td>
                        </tr>
                      )
                    })
                  }
                </tbody>
              </table>
            </div>
            <Pager page={ledgerPage} total={n(ledgerData?.meta?.total)} perPage={PER_PAGE} onChange={setLedgerPage} />
          </div>
        </div>
      )}

      {/* ══ REFUNDS ══ */}
      {sub === 'refunds' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <p className="text-[14px] font-semibold text-slate-800">Refunds</p>
            <p className="text-[12px] text-slate-400 mt-0.5">Transactions reversed back to customers · {fmtNum(n(refundData?.meta?.total))} total</p>
          </div>

          {loadingRef
            ? <div className="flex items-center justify-center gap-2 py-12 text-slate-400"><Spinner />Loading…</div>
            : !(refundData?.data?.length)
            ? <div className="py-14 text-center">
                <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">undo</span>
                <p className="text-[13px] text-slate-400">No refunds found</p>
              </div>
            : refundData!.data.map((rf, i) => {
              const cust = rf.customer || {}
              const custName = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || cust.email || '—'
              return (
                <div key={i} className="px-5 py-4 hover:bg-slate-50 transition-colors"
                  style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
                  {/* Header row */}
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="kpi-number text-[22px]" style={{ color: RED }}>{kobo(rf.amount)}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">Refunded to customer</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <ChannelBadge channel={rf.refund_channel || rf.refund_type} />
                      <StatusBadge status={rf.status || 'pending'} />
                    </div>
                  </div>
                  {/* Detail grid — 2 columns, no horizontal scroll */}
                  <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Customer</p>
                      <p className="text-[12px] font-semibold text-slate-700">{custName}</p>
                      {cust.email && custName !== cust.email && (
                        <p className="text-[11px] text-slate-400">{cust.email}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Transaction Reference</p>
                      <p className="font-mono text-[11px] text-slate-600">{rf.transaction_reference || rf.bank_reference || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Deducted from Wallet</p>
                      <p className="font-mono text-[12px] font-semibold text-slate-700">
                        {rf.deducted_amount != null ? kobo(rf.deducted_amount) : '—'}
                        {rf.fully_deducted === false && (
                          <span className="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(217,119,6,0.1)', color: AMBER }}>Partial</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Date</p>
                      <p className="text-[12px] text-slate-600">{fmtTs(rf.refunded_at || rf.createdAt)}</p>
                    </div>
                    {(rf.customer_note || rf.merchant_note) && (
                      <div className="col-span-2">
                        <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Note</p>
                        <p className="text-[12px] text-slate-600">{rf.customer_note || rf.merchant_note}</p>
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          }
          <Pager page={refundPage} total={n(refundData?.meta?.total)} perPage={PER_PAGE} onChange={setRefundPage} />
        </div>
      )}

      {/* ══ DISPUTES ══ */}
      {sub === 'disputes' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <p className="text-[14px] font-semibold text-slate-800">Disputes & Chargebacks</p>
            <p className="text-[12px] text-slate-400 mt-0.5">Transactions disputed by customers or issuing banks</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <THead cols={['Txn Reference', 'Customer', 'Refund Amount', 'Category', 'Status', 'Resolution', 'Due Date', 'Resolved']} />
              <tbody>
                {loadingDisp ? <Loading cols={8} />
                  : !(disputeData?.data?.length)
                  ? <Empty icon="gavel" msg="No disputes found" cols={8} />
                  : disputeData!.data.map((d, i) => {
                    const cust = d.customer || {}
                    return (
                      <tr key={i} className="hover:bg-slate-50 transition-colors"
                        style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                        <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{d.transaction_reference || '—'}</td>
                        <td className="px-4 py-3">
                          <p className="text-[12px] font-semibold text-slate-700">{cust.email || '—'}</p>
                        </td>
                        <td className="px-4 py-3 font-mono font-semibold" style={{ color: RED }}>{kobo(d.refund_amount)}</td>
                        <td className="px-4 py-3 text-[11px] capitalize text-slate-600">{(d.category || '—').replace(/_/g, ' ')}</td>
                        <td className="px-4 py-3"><StatusBadge status={d.status || 'pending'} /></td>
                        <td className="px-4 py-3 text-[11px] capitalize text-slate-600">{(d.resolution || '—').replace(/-/g, ' ')}</td>
                        <td className="px-4 py-3 text-[11px] text-slate-500 whitespace-nowrap">{fmtTs(d.dueAt)}</td>
                        <td className="px-4 py-3 text-[11px] text-slate-500 whitespace-nowrap">{fmtTs(d.resolvedAt)}</td>
                      </tr>
                    )
                  })
                }
              </tbody>
            </table>
          </div>
          <Pager page={disputePage} total={n(disputeData?.meta?.total)} perPage={PER_PAGE} onChange={setDisputePage} />
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   INTERSWITCH TAB
═══════════════════════════════════════════════════════════════════════════ */
function InterspwitchTab() {
  const steps = [
    {
      icon: 'call',
      title: 'Contact your Interswitch account manager',
      detail: 'Call 01-2715555 or email merchantsupport@interswitchgroup.com. Tell them you need reporting API credentials for your existing merchant account.',
    },
    {
      icon: 'vpn_key',
      title: 'Request these specific credentials',
      detail: 'Merchant ID (MID) · Client ID · Client Secret · Reporting API base URL. Your account type is: Card acquiring (Web, POS, ATM).',
    },
    {
      icon: 'settings',
      title: 'Add credentials to Platform Settings',
      detail: 'Once received, go to Admin → Platform Settings → API Credentials and add INTERSWITCH_CLIENT_ID, INTERSWITCH_CLIENT_SECRET, and INTERSWITCH_BASE_URL.',
    },
    {
      icon: 'dashboard',
      title: 'Live data loads automatically',
      detail: 'This tab will immediately show Web, POS, and ATM transaction data, settlement reports, and reconciliation against your internal ledger.',
    },
  ]

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="px-8 py-6" style={{ background: NAVY }}>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.1)' }}>
            <span className="material-symbols-rounded text-[28px] text-white">account_balance</span>
          </div>
          <div>
            <p className="text-white font-bold text-[18px]">Interswitch Integration Pending</p>
            <p className="text-white/60 text-[13px] mt-0.5">
              Merchant credentials needed to activate Web, POS &amp; ATM reconciliation
            </p>
          </div>
          <div className="ml-auto">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold"
              style={{ background: 'rgba(217,119,6,0.2)', color: '#FCD34D' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#FCD34D', display: 'inline-block' }} />
              Awaiting Credentials
            </span>
          </div>
        </div>
      </div>

      {/* What you'll get */}
      <div className="px-8 py-5" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)', background: '#F8FAFC' }}>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mb-3">Once connected, this tab will show</p>
        <div className="flex flex-wrap gap-2">
          {[
            { icon: 'globe', label: 'Web card transactions' },
            { icon: 'point_of_sale', label: 'POS terminal settlements' },
            { icon: 'atm', label: 'ATM withdrawals' },
            { icon: 'receipt_long', label: 'Transaction line items' },
            { icon: 'balance', label: 'Processor vs ledger reconciliation' },
            { icon: 'price_change', label: 'Interchange fees breakdown' },
          ].map(({ icon, label }) => (
            <span key={label} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-slate-600"
              style={{ background: '#fff', border: '1px solid rgba(15,23,42,0.1)' }}>
              <span className="material-symbols-rounded text-[14px]" style={{ color: NAVY }}>{icon}</span>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Steps */}
      <div className="px-8 py-6">
        <p className="text-[13px] font-semibold text-slate-700 mb-5">How to activate</p>
        <div className="flex flex-col gap-0">
          {steps.map((s, i) => (
            <div key={i} className="flex gap-4">
              {/* Step line */}
              <div className="flex flex-col items-center flex-shrink-0">
                <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-[13px]"
                  style={{ background: `${NAVY}12`, color: NAVY }}>
                  <span className="material-symbols-rounded text-[18px]">{s.icon}</span>
                </div>
                {i < steps.length - 1 && (
                  <div className="w-px flex-1 my-1" style={{ background: 'rgba(15,23,42,0.1)', minHeight: 24 }} />
                )}
              </div>
              {/* Content */}
              <div className={`pb-6 ${i === steps.length - 1 ? '' : ''}`}>
                <p className="text-[13px] font-semibold text-slate-800 mt-1.5">{s.title}</p>
                <p className="text-[12px] text-slate-500 mt-1 leading-relaxed">{s.detail}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Contact card */}
        <div className="mt-2 p-4 rounded-xl flex items-center gap-4"
          style={{ background: 'rgba(14,40,65,0.04)', border: '1px solid rgba(14,40,65,0.1)' }}>
          <span className="material-symbols-rounded text-[22px]" style={{ color: NAVY }}>support_agent</span>
          <div>
            <p className="text-[12px] font-semibold text-slate-700">Interswitch Merchant Support</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              01-2715555 &nbsp;·&nbsp; merchantsupport@interswitchgroup.com
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════════════════════ */
const TABS = [
  { key: 'paystack',    label: 'Paystack',    icon: 'payments' },
  { key: 'interswitch', label: 'Interswitch', icon: 'account_balance' },
] as const
type TabKey = typeof TABS[number]['key']

export default function Reconciliation() {
  const [tab, setTab]   = useState<TabKey>('paystack')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo]     = useState(today())

  return (
    <Page dept="Finance" title="Reconciliation"
      subtitle="Match processor settlements against internal EOD ledger"
      actions={<DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />}>

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

      {tab === 'paystack'    && <PaystackTab from={from} to={to} />}
      {tab === 'interswitch' && <InterspwitchTab />}
    </Page>
  )
}
