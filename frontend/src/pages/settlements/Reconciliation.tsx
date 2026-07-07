import { useState, useEffect, useCallback } from 'react'
import { Page, ErrBanner, StatusBadge } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum, fmtDate, today, monthStart } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PsSummary {
  configured: boolean
  message?: string
  total_count: number
  success: number
  failed: number
  total_volume_kobo: number
  error?: string
}

interface EodSummary {
  txn_count: number
  total_vol_kobo: number
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
  settlement_date?: string
  createdAt?: string
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
  balance?: number
  closing_balance: number
  created_at: string
  createdAt?: string
  model_responsible?: string
  reason?: string
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function n(v: unknown): number {
  const x = Number(v)
  return isNaN(x) ? 0 : x
}

function fmtTs(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return s }
}

// ── Shared table styles ───────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px', fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'rgba(255,255,255,0.75)', textAlign: 'left', whiteSpace: 'nowrap',
  background: NAVY,
}
const TD_STYLE: React.CSSProperties = {
  padding: '11px 14px', fontSize: 13, color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
}

// ── Delta badge ───────────────────────────────────────────────────────────────

function DeltaBadge({ apiVal, eodVal, isCount = false }: { apiVal: number; eodVal: number; isCount?: boolean }) {
  const diff = apiVal - eodVal
  const pct  = eodVal !== 0 ? Math.abs(diff / eodVal) * 100 : null
  const ok   = pct !== null ? pct < 1   : diff === 0
  const warn = pct !== null && pct < 5
  const color = ok ? GREEN : warn ? AMBER : RED
  const bg    = ok ? 'rgba(22,163,74,0.07)' : warn ? 'rgba(217,119,6,0.07)' : 'rgba(192,0,0,0.07)'
  const sign  = diff >= 0 ? '+' : ''
  const label = isCount ? sign + fmtNum(diff) : sign + fmtKoboExact(Math.abs(diff))
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: bg, color, border: `1px solid ${color}22` }}>
      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{ok ? 'check_circle' : 'warning'}</span>
      {label}
      {pct !== null && <span style={{ fontWeight: 400, opacity: 0.75 }}>({pct.toFixed(1)}%)</span>}
      <span style={{ fontWeight: 400 }}>{ok ? '· Balanced' : warn ? '· Minor gap' : '· Mismatch'}</span>
    </span>
  )
}

// ── KPI mini card ─────────────────────────────────────────────────────────────

function MiniKpi({ label, value, icon, accent, sub }: { label: string; value: string; icon: string; accent: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px', borderTop: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt2)' }}>{label}</span>
        <div style={{ width: 26, height: 26, borderRadius: 7, background: `${accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14, color: accent }}>{icon}</span>
        </div>
      </div>
      <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: 'var(--txt)', lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ── Pager ─────────────────────────────────────────────────────────────────────

function Pager({ page, total, perPage, onChange }: { page: number; total: number; perPage: number; onChange: (p: number) => void }) {
  const pages = Math.ceil(total / perPage) || 1
  if (pages <= 1 && page === 1) return null
  return (
    <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: 12, color: 'var(--txt2)' }}>Page {page} of {pages} · {fmtNum(total)} total</span>
      <div style={{ display: 'flex', gap: 6 }}>
        {[['chevron_left', Math.max(1, page - 1), page === 1], ['chevron_right', Math.min(pages, page + 1), page >= pages]].map(([icon, p, disabled], i) => (
          <button key={i} onClick={() => !disabled && onChange(p as number)} disabled={!!disabled}
            style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{icon as string}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Filter pills ──────────────────────────────────────────────────────────────

function FilterPills<T extends string>({ value, options, onChange }: { value: T; options: { label: string; value: T }[]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 9, background: 'var(--th-bg)' }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)}
          style={{ padding: '4px 12px', borderRadius: 7, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 120ms',
            background: value === o.value ? 'var(--card)' : 'transparent',
            color: value === o.value ? NAVY : 'var(--txt2)',
            boxShadow: value === o.value ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Data hook ─────────────────────────────────────────────────────────────────

function useFetch<T = unknown>(url: string | null): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetch = useCallback(() => {
    if (!url) return
    let cancelled = false
    setLoading(true)
    setError(null)
    apiFetch(url)
      .then(d => { if (!cancelled) setData(d as T) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Error') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [url])
  useEffect(() => { fetch() }, [fetch])
  return { data, loading, error }
}

// ── Date range state (persisted in sessionStorage) ────────────────────────────

const FROM_KEY = 'ps_recon_from'
const TO_KEY   = 'ps_recon_to'

// ═══════════════════════════════════════════════════════════════════════════════
// PAYSTACK TAB
// ═══════════════════════════════════════════════════════════════════════════════

const PER_PAGE = 50

const PS_SUBTABS = [
  { key: 'summary',      label: 'Summary',       icon: 'dashboard' },
  { key: 'transactions', label: 'Transactions',   icon: 'receipt_long' },
  { key: 'settlements',  label: 'Settlements',    icon: 'account_balance' },
  { key: 'transfers',    label: 'Transfers',      icon: 'send' },
  { key: 'fees',         label: 'Fees & Ledger',  icon: 'price_change' },
  { key: 'refunds',      label: 'Refunds',        icon: 'undo' },
  { key: 'disputes',     label: 'Disputes',       icon: 'gavel' },
] as const
type PSSubTab = typeof PS_SUBTABS[number]['key']

function PaystackTab({ from, to }: { from: string; to: string }) {
  const [sub, setSub] = useState<PSSubTab>('summary')
  const [txnPage, setTxnPage]     = useState(1)
  const [txnStatus, setTxnStatus] = useState('')
  const [settlePage, setSettlePage] = useState(1)
  const [xfrPage, setXfrPage]     = useState(1)
  const [xfrStatus, setXfrStatus] = useState('')
  const [ledgerPage, setLedgerPage] = useState(1)
  const [ledgerDir, setLedgerDir]  = useState<'all' | 'credit' | 'debit'>('all')
  const [refundPage, setRefundPage] = useState(1)
  const [disputePage, setDisputePage] = useState(1)

  useEffect(() => {
    setTxnPage(1); setSettlePage(1); setXfrPage(1)
    setLedgerPage(1); setRefundPage(1); setDisputePage(1)
  }, [from, to])

  const summaryURL = `/api/reconciliation/paystack/summary?date_from=${from}&date_to=${to}`
  const balanceURL = `/api/reconciliation/paystack/balance`

  const txnP = new URLSearchParams({ date_from: from, date_to: to, page: String(txnPage), per_page: '50' })
  if (txnStatus) txnP.set('status', txnStatus)

  const xfrP = new URLSearchParams({ from, to, page: String(xfrPage), per_page: '50' })
  if (xfrStatus) xfrP.set('status', xfrStatus)

  const { data: summary, loading: loadingSum, error: sumErr } = useFetch<ReconSummaryResponse>(summaryURL)
  const { data: balance }                                       = useFetch<BalanceLedger>(balanceURL)
  const { data: txnData,    loading: loadingTxns }   = useFetch<PsPagedResponse<PsTxn>>(sub === 'transactions' ? `/api/reconciliation/paystack/transactions?${txnP}` : null)
  const { data: settleData, loading: loadingSett }   = useFetch<PsPagedResponse<PsSettlement>>(sub === 'settlements' ? `/api/reconciliation/paystack/settlements?from=${from}&to=${to}&page=${settlePage}&per_page=50` : null)
  const { data: xfrData,    loading: loadingXfr }    = useFetch<PsPagedResponse<Record<string, unknown>>>(sub === 'transfers' ? `/api/reconciliation/paystack/transfers?${xfrP}` : null)
  const { data: ledgerData, loading: loadingLedger } = useFetch<BalanceLedger>(sub === 'fees' ? `/api/reconciliation/paystack/ledger?page=${ledgerPage}&per_page=50` : null)
  const { data: refundData, loading: loadingRef }    = useFetch<PsPagedResponse<Record<string, unknown>>>(sub === 'refunds' ? `/api/reconciliation/paystack/refunds?page=${refundPage}&per_page=50` : null)
  const { data: disputeData, loading: loadingDisp }  = useFetch<PsPagedResponse<Record<string, unknown>>>(sub === 'disputes' ? `/api/reconciliation/paystack/disputes?page=${disputePage}&per_page=50` : null)

  const ps  = summary?.paystack ?? null
  const eod = summary?.eod ?? null
  const balArr = balance?.data ?? []
  const liveBalKobo = n(balArr[0]?.balance ?? balArr[0]?.closing_balance)

  const allLedger = ledgerData?.data ?? []
  const filteredLedger = allLedger.filter(r => {
    const d = n(r.difference)
    if (ledgerDir === 'credit') return d > 0
    if (ledgerDir === 'debit')  return d < 0
    return true
  })

  if (sumErr) return <ErrBanner error={sumErr} />
  if (summary && !summary.configured) {
    return (
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 48, textAlign: 'center' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)', display: 'block', marginBottom: 10 }}>payments</span>
        <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--txt)', margin: '0 0 6px' }}>Paystack not configured</p>
        <p style={{ fontSize: 13, color: 'var(--txt2)', margin: 0 }}>{summary.message || 'Set PAYSTACK_SECRET_KEY in backend environment'}</p>
      </div>
    )
  }

  // ── Sub-tab bar ────────────────────────────────────────────────────────────

  const tabBar = (
    <div style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 11, background: 'var(--th-bg)', marginBottom: 20, flexWrap: 'wrap' }}>
      {PS_SUBTABS.map(t => (
        <button key={t.key} onClick={() => setSub(t.key)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 120ms',
            background: sub === t.key ? 'var(--card)' : 'transparent',
            color: sub === t.key ? NAVY : 'var(--txt2)',
            boxShadow: sub === t.key ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{t.icon}</span>
          {t.label}
        </button>
      ))}
    </div>
  )

  // ── SUMMARY ────────────────────────────────────────────────────────────────

  if (sub === 'summary') return (
    <div>
      {tabBar}
      {loadingSum ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</div> : (
        <>
          {/* Live balance banner */}
          <div style={{ background: NAVY, borderRadius: 14, padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 22, color: '#fff' }}>account_balance_wallet</span>
            </div>
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.5)', margin: '0 0 4px' }}>Live Paystack Wallet Balance</p>
              <p style={{ ...NUM, fontSize: 28, fontWeight: 700, color: '#fff', margin: 0, lineHeight: 1 }}>{liveBalKobo > 0 ? fmtKoboExact(liveBalKobo) : '—'}</p>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 3px' }}>Period</p>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)', margin: 0 }}>{fmtDate(from)} – {fmtDate(to)}</p>
            </div>
          </div>

          {/* KPI grid — Total In / Total Out / Unmatched Credits / Unmatched Debits */}
          {(() => {
            const psCount  = n(ps?.total_count)
            const eodCount = n(eod?.txn_count)
            const psVol    = n(ps?.total_volume_kobo)
            const eodVol   = n(eod?.total_vol_kobo)
            const countDiff = psCount - eodCount
            const volDiff   = psVol - eodVol
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
                <MiniKpi label="Total In (Paystack)" icon="arrow_downward" accent={GREEN}
                  value={fmtKobo(psVol)} sub={`${fmtNum(psCount)} transactions`} />
                <MiniKpi label="Total In (Ledger)" icon="account_balance" accent={NAVY}
                  value={fmtKoboExact(eodVol)} sub={`${fmtNum(eodCount)} ledger entries`} />
                <MiniKpi label="Unmatched Credits"
                  icon={countDiff > 0 ? 'warning' : 'check_circle'}
                  accent={countDiff > 0 ? RED : GREEN}
                  value={countDiff > 0 ? `+${fmtNum(countDiff)}` : '0'}
                  sub={countDiff > 0 ? 'Paystack shows more' : 'Counts match'} />
                <MiniKpi label="Unmatched Debits"
                  icon={countDiff < 0 ? 'warning' : 'check_circle'}
                  accent={countDiff < 0 ? RED : GREEN}
                  value={countDiff < 0 ? fmtNum(Math.abs(countDiff)) : '0'}
                  sub={countDiff < 0 ? 'Ledger shows more' : volDiff !== 0 ? `₦ diff: ${fmtKoboExact(Math.abs(volDiff))}` : 'Volumes match'} />
              </div>
            )
          })()}

          {/* Compare panel */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)' }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Processor vs Ledger — Reconciliation</p>
              <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>Paystack API totals vs internal EOD ledger · matched = <span style={{ color: GREEN, fontWeight: 600 }}>green</span> · gap ≥ 5% = <span style={{ color: RED, fontWeight: 600 }}>red</span></p>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Metric', 'Paystack (Source)', 'EOD Ledger', 'Match Status'].map((h, i) => (
                      <th key={h} style={{ ...TH_STYLE, textAlign: i > 0 ? 'right' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ ...TD_STYLE, fontWeight: 600 }}>Transaction Count</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 700 }}>{fmtNum(n(ps?.total_count))}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 700 }}>{fmtNum(n(eod?.txn_count))}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                      <DeltaBadge apiVal={n(ps?.total_count)} eodVal={n(eod?.txn_count)} isCount />
                    </td>
                  </tr>
                  <tr>
                    <td style={{ ...TD_STYLE, fontWeight: 600 }}>Total Volume ₦</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 700 }}>{fmtKoboExact(n(ps?.total_volume_kobo))}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 700 }}>{fmtKoboExact(n(eod?.total_vol_kobo))}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                      <DeltaBadge apiVal={n(ps?.total_volume_kobo)} eodVal={n(eod?.total_vol_kobo)} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {ps?.error && (
            <div style={{ display: 'flex', gap: 8, padding: 14, borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: RED, flexShrink: 0, marginTop: 1 }}>error</span>
              <p style={{ fontSize: 12, color: '#991B1B', margin: 0 }}>Paystack API error: {ps.error}</p>
            </div>
          )}
        </>
      )}
    </div>
  )

  // ── TRANSACTIONS ───────────────────────────────────────────────────────────

  if (sub === 'transactions') return (
    <div>
      {tabBar}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Incoming Transactions</p>
            <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>Money received from customers via Paystack · {fmtDate(from)} – {fmtDate(to)}</p>
          </div>
          <FilterPills value={txnStatus as any} options={[{ label: 'All', value: '' }, { label: 'Successful', value: 'success' }, { label: 'Failed', value: 'failed' }, { label: 'Abandoned', value: 'abandoned' }]} onChange={v => { setTxnStatus(v); setTxnPage(1) }} />
        </div>
        <div style={{ padding: '8px 16px', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 16, fontSize: 11, color: 'var(--txt2)' }}>
          <span>Gross = customer paid</span>
          <span style={{ color: RED, fontWeight: 600 }}>Red = Paystack cut</span>
          <span style={{ color: GREEN, fontWeight: 600 }}>Green = O3C net received</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Reference & Date', 'Customer', 'Gross', 'Paystack Cut', 'O3C Net', 'Channel', 'Status'].map((h, i) => (
                <th key={h} style={{ ...TH_STYLE, textAlign: i >= 2 && i <= 4 ? 'right' : 'left' }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {loadingTxns ? (
                <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
              ) : !txnData?.data?.length ? (
                <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--txt2)' }}>No transactions in this period</td></tr>
              ) : txnData.data.map((t, i) => {
                const cust = t.customer || {}
                const auth = t.authorization || {}
                const gross = n(t.amount)
                const fees = n(t.fees)
                const net = gross - fees
                const custName = [cust.first_name, cust.last_name].filter(Boolean).join(' ')
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}>
                    <td style={TD_STYLE}>
                      <p style={{ ...NUM, fontSize: 11.5, color: 'var(--txt2)', margin: '0 0 2px' }}>{t.reference}</p>
                      <p style={{ fontSize: 11, color: 'var(--txt3)', margin: 0 }}>{fmtTs(t.paid_at || t.created_at)}</p>
                    </td>
                    <td style={TD_STYLE}>
                      {custName && <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>{custName}</p>}
                      <p style={{ fontSize: 11.5, color: 'var(--txt2)', margin: '0 0 2px' }}>{cust.email || '—'}</p>
                      {auth.last4 && <p style={{ fontSize: 11, color: 'var(--txt3)', margin: 0 }}>{auth.card_type} ····{auth.last4}{auth.bank ? ` · ${auth.bank}` : ''}</p>}
                    </td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 700, fontSize: 14 }}>{fmtKoboExact(gross)}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 600, fontSize: 13, color: fees > 0 ? RED : 'var(--txt3)' }}>{fees > 0 ? fmtKoboExact(fees) : '—'}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 700, fontSize: 14, color: t.status === 'success' ? GREEN : 'var(--txt3)' }}>{t.status === 'success' ? fmtKoboExact(net) : '—'}</td>
                    <td style={TD_STYLE}><span style={{ fontSize: 12, color: 'var(--txt2)' }}>{t.channel}</span></td>
                    <td style={TD_STYLE}><StatusBadge status={t.status || 'pending'} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <Pager page={txnPage} total={n(txnData?.meta?.total)} perPage={PER_PAGE} onChange={setTxnPage} />
      </div>
    </div>
  )

  // ── SETTLEMENTS ────────────────────────────────────────────────────────────

  if (sub === 'settlements') return (
    <div>
      {tabBar}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)' }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Paystack Settlements</p>
          <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>Net amounts disbursed to your bank account · {fmtDate(from)} – {fmtDate(to)}</p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Settlement Date', 'Gross Collected', 'Paystack Fees', 'Net Settled to Bank', 'Status'].map((h, i) => (
              <th key={h} style={{ ...TH_STYLE, textAlign: i >= 1 && i <= 3 ? 'right' : 'left' }}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {loadingSett ? <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
                : !settleData?.data?.length ? <tr><td colSpan={5} style={{ padding: 40, textAlign: 'center', color: 'var(--txt2)' }}>No settlements in this period</td></tr>
                : settleData.data.map((s, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}>
                    <td style={{ ...TD_STYLE, fontWeight: 500, whiteSpace: 'nowrap' }}>{fmtTs(s.settlement_date || s.createdAt)}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 600 }}>{fmtKoboExact(n(s.total_processed))}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, color: RED }}>{fmtKoboExact(n(s.total_fees))}</td>
                    <td style={{ ...TD_STYLE, textAlign: 'right', ...NUM, fontWeight: 700, fontSize: 14, color: GREEN }}>{fmtKoboExact(n(s.effective_amount ?? s.total_amount))}</td>
                    <td style={TD_STYLE}><StatusBadge status={s.status || 'pending'} /></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <Pager page={settlePage} total={n(settleData?.meta?.total)} perPage={PER_PAGE} onChange={setSettlePage} />
      </div>
    </div>
  )

  // ── TRANSFERS ──────────────────────────────────────────────────────────────

  if (sub === 'transfers') return (
    <div>
      {tabBar}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Outbound Transfers</p>
            <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>Money sent from your Paystack wallet · {fmtDate(from)} – {fmtDate(to)}</p>
          </div>
          <FilterPills value={xfrStatus as any} options={[{ label: 'All', value: '' }, { label: 'Successful', value: 'success' }, { label: 'Failed', value: 'failed' }, { label: 'Pending', value: 'pending' }, { label: 'Reversed', value: 'reversed' }]} onChange={v => { setXfrStatus(v); setXfrPage(1) }} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Reference & Date', 'Initiated By', 'Recipient', 'Bank / Account', 'Amount', 'Fee *', 'Wallet Debited', 'Status'].map(h => (
              <th key={h} style={TH_STYLE}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {loadingXfr ? <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
                : !xfrData?.data?.length ? <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: 'var(--txt2)' }}>No transfers in this period</td></tr>
                : xfrData!.data.map((t, i) => {
                  const recip = (t.recipient as Record<string, unknown>) || {}
                  const details = (recip.details as Record<string, unknown>) || {}
                  const o3ci = t.o3c_initiator as Record<string, unknown> | null | undefined
                  const amt = n(t.amount)
                  const feeActual = n(t.fee_charged)
                  const xferEst = amt <= 500000 ? 1000 : amt <= 5000000 ? 2500 : 5000
                  const stampEst = amt >= 1000000 ? 5000 : 0
                  const fee = feeActual > 0 ? feeActual : (t.status === 'success' ? (xferEst + stampEst) : 0)
                  const isEst = feeActual === 0 && t.status === 'success'
                  const net = amt + fee
                  const narration = String(t.reason || '—')
                  const initName = o3ci ? String(o3ci.applicant_name || '—') : null
                  const initCif  = o3ci ? String(o3ci.applicant_cif  || '') : null
                  const initRef  = o3ci ? String(o3ci.loan_ref        || '') : null
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'var(--row-hvr)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}>
                      <td style={TD_STYLE}>
                        <p style={{ ...NUM, fontSize: 11.5, color: 'var(--txt2)', margin: '0 0 2px' }}>{String(t.reference || '—')}</p>
                        <p style={{ fontSize: 11, color: 'var(--txt3)', margin: '0 0 2px' }}>{fmtTs(String(t.transferred_at || t.createdAt || ''))}</p>
                        <p style={{ fontSize: 10.5, color: 'var(--txt3)', margin: 0, fontStyle: 'italic', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{narration}</p>
                      </td>
                      <td style={TD_STYLE}>
                        {initName
                          ? <>
                              <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>{initName}</p>
                              {initCif  && <p style={{ ...NUM, fontSize: 11, color: 'var(--txt2)', margin: '0 0 2px' }}>{initCif}</p>}
                              {initRef  && <p style={{ ...NUM, fontSize: 10.5, color: 'var(--txt3)', margin: 0 }}>{initRef}</p>}
                            </>
                          : <p style={{ fontSize: 11.5, color: 'var(--txt3)', fontStyle: 'italic', margin: 0 }}>{narration}</p>
                        }
                      </td>
                      <td style={TD_STYLE}>
                        <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>{String(details.account_name || (recip.name as string) || '—')}</p>
                        <p style={{ fontSize: 11, color: 'var(--txt3)', margin: 0 }}>{String(recip.type || '')}</p>
                      </td>
                      <td style={TD_STYLE}>
                        <p style={{ fontSize: 12.5, color: 'var(--txt)', margin: '0 0 2px' }}>{String(details.bank_name || '—')}</p>
                        <p style={{ ...NUM, fontSize: 11, color: 'var(--txt3)', margin: 0 }}>{String(details.account_number || '—')}</p>
                      </td>
                      <td style={{ ...TD_STYLE, ...NUM, fontWeight: 700, fontSize: 14 }}>{fmtKoboExact(amt)}</td>
                      <td style={{ ...TD_STYLE, ...NUM, fontWeight: 600, fontSize: 13, color: fee > 0 ? RED : 'var(--txt3)' }}>
                        {fee > 0 ? <>{fmtKoboExact(fee)}{isEst && <span style={{ fontSize: 11, color: 'var(--txt3)', marginLeft: 4 }}>est.</span>}</> : '—'}
                      </td>
                      <td style={{ ...TD_STYLE, ...NUM, fontWeight: 700, fontSize: 14, color: t.status === 'success' ? RED : 'var(--txt3)' }}>{t.status === 'success' ? fmtKoboExact(net) : '—'}</td>
                      <td style={TD_STYLE}><StatusBadge status={String(t.status || 'pending')} /></td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
        <Pager page={xfrPage} total={n(xfrData?.meta?.total)} perPage={PER_PAGE} onChange={setXfrPage} />
        <p style={{ fontSize: 11, color: 'var(--txt2)', padding: '0 14px 10px' }}>
          * Fees marked <em>est.</em> are estimated from the standard schedule (₦10 / ₦25 / ₦50) — Paystack does not return per-transfer fee breakdowns via the transfers API. "Initiated By" shows the borrower name, CIF, and loan reference for loan disbursements; non-loan transfers (salary, vendor, etc.) show the transfer narration instead.
        </p>
      </div>
    </div>
  )

  // ── FEES & LEDGER ──────────────────────────────────────────────────────────

  if (sub === 'fees') return (
    <div>
      {tabBar}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { key: 'Transfer_Charge', label: 'Transfer Fees', icon: 'price_change', accent: RED },
          { key: 'Transfer_Stamp_Duty_Charge', label: 'Stamp Duty', icon: 'receipt', accent: AMBER },
          { key: 'Transfer', label: 'Transfer Debits', icon: 'send', accent: NAVY },
          { key: '__credits__', label: 'Wallet Funded', icon: 'account_balance_wallet', accent: GREEN },
        ].map(({ key, label, icon, accent }) => {
          const rows = key === '__credits__' ? allLedger.filter(r => n(r.difference) > 0) : allLedger.filter(r => r.model_responsible === key)
          const total = rows.reduce((s, r) => s + Math.abs(n(r.difference)), 0)
          return <MiniKpi key={key} label={label} icon={icon} accent={accent} value={total > 0 ? fmtKoboExact(total) : '—'} sub={`${rows.length} entries this page`} />
        })}
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Balance Ledger</p>
            <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>Every debit and credit to your Paystack wallet with running balance</p>
          </div>
          <FilterPills value={ledgerDir} options={[{ label: 'All', value: 'all' }, { label: 'Credits (+)', value: 'credit' }, { label: 'Debits (−)', value: 'debit' }]} onChange={v => setLedgerDir(v)} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Type', 'Reason / Reference', 'Change', 'Running Balance', 'Date'].map(h => (
              <th key={h} style={TH_STYLE}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {loadingLedger ? <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
                : filteredLedger.length === 0 ? <tr><td colSpan={5} style={{ padding: 40, textAlign: 'center', color: 'var(--txt2)' }}>No ledger entries</td></tr>
                : filteredLedger.map((row, i) => {
                  const diff = n(row.difference)
                  const isDebit = diff < 0
                  const isCharge = row.model_responsible?.includes('Charge')
                  const typeMap: Record<string, string> = { Transfer_Charge: 'Transfer Fee', Transfer_Stamp_Duty_Charge: 'Stamp Duty', Transfer: 'Transfer', Settlement: 'Settlement', Refund: 'Refund', Chargeback: 'Chargeback' }
                  const typeLabel = typeMap[row.model_responsible ?? ''] || row.model_responsible || '—'
                  const tagColor = isCharge ? RED : isDebit ? NAVY : GREEN
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'var(--row-hvr)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}>
                      <td style={TD_STYLE}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 7px', borderRadius: 6, background: `${tagColor}10`, color: tagColor }}>{typeLabel}</span>
                      </td>
                      <td style={{ ...TD_STYLE, fontSize: 11.5, color: 'var(--txt2)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.reason || '—'}</td>
                      <td style={{ ...TD_STYLE, ...NUM, fontWeight: 600, fontSize: 12, color: diff > 0 ? GREEN : diff < 0 ? RED : 'var(--txt3)' }}>
                        {diff !== 0 ? `${diff > 0 ? '+' : ''}${fmtKoboExact(diff)}` : '—'}
                      </td>
                      <td style={{ ...TD_STYLE, ...NUM, fontSize: 12.5, fontWeight: 600 }}>{fmtKoboExact(n(row.balance ?? row.closing_balance))}</td>
                      <td style={{ ...TD_STYLE, fontSize: 11.5, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtTs(row.createdAt || row.created_at)}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
        <Pager page={ledgerPage} total={n(ledgerData?.meta?.total)} perPage={PER_PAGE} onChange={setLedgerPage} />
      </div>
    </div>
  )

  // ── REFUNDS ────────────────────────────────────────────────────────────────

  if (sub === 'refunds') return (
    <div>
      {tabBar}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)' }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Refunds</p>
          <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>Transactions reversed back to customers · {fmtNum(n(refundData?.meta?.total))} total</p>
        </div>
        {loadingRef ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</div>
          : !refundData?.data?.length ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--txt2)' }}>No refunds found</div>
          : (refundData.data as Record<string, unknown>[]).map((rf, i) => {
            const cust = (rf.customer as Record<string, unknown>) || {}
            const custName = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || String(cust.email || '—')
            return (
              <div key={i} style={{ padding: '14px 18px', borderBottom: '1px solid var(--bdr)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <p style={{ ...NUM, fontSize: 20, fontWeight: 700, color: RED, margin: '0 0 2px' }}>{fmtKoboExact(n(rf.amount))}</p>
                    <p style={{ fontSize: 11.5, color: 'var(--txt2)', margin: 0 }}>Refunded to customer</p>
                  </div>
                  <StatusBadge status={String(rf.status || 'pending')} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px' }}>
                  <div>
                    <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--txt2)', margin: '0 0 2px' }}>Customer</p>
                    <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', margin: 0 }}>{custName}</p>
                  </div>
                  <div>
                    <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--txt2)', margin: '0 0 2px' }}>Transaction Reference</p>
                    <p style={{ ...NUM, fontSize: 11.5, color: 'var(--txt)', margin: 0 }}>{String(rf.transaction_reference || rf.bank_reference || '—')}</p>
                  </div>
                  <div>
                    <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--txt2)', margin: '0 0 2px' }}>Date</p>
                    <p style={{ fontSize: 12.5, color: 'var(--txt)', margin: 0 }}>{fmtTs(String(rf.refunded_at || rf.createdAt || ''))}</p>
                  </div>
                </div>
              </div>
            )
          })
        }
        <Pager page={refundPage} total={n(refundData?.meta?.total)} perPage={PER_PAGE} onChange={setRefundPage} />
      </div>
    </div>
  )

  // ── DISPUTES ───────────────────────────────────────────────────────────────

  return (
    <div>
      {tabBar}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bdr)' }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Disputes &amp; Chargebacks</p>
          <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>Transactions disputed by customers or issuing banks</p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Txn Reference', 'Customer', 'Refund Amount', 'Category', 'Status', 'Resolution', 'Due Date', 'Resolved'].map(h => (
              <th key={h} style={TH_STYLE}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {loadingDisp ? <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
                : !disputeData?.data?.length ? <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: 'var(--txt2)' }}>No disputes found</td></tr>
                : (disputeData.data as Record<string, unknown>[]).map((d, i) => {
                  const cust = (d.customer as Record<string, unknown>) || {}
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'var(--row-hvr)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}>
                      <td style={{ ...TD_STYLE, ...NUM, fontSize: 11.5, color: 'var(--txt2)' }}>{String(d.transaction_reference || '—')}</td>
                      <td style={{ ...TD_STYLE, fontSize: 12.5, fontWeight: 600 }}>{String(cust.email || '—')}</td>
                      <td style={{ ...TD_STYLE, ...NUM, fontWeight: 600, color: RED }}>{fmtKoboExact(n(d.refund_amount))}</td>
                      <td style={{ ...TD_STYLE, fontSize: 12, textTransform: 'capitalize', color: 'var(--txt2)' }}>{String(d.category || '—').replace(/_/g, ' ')}</td>
                      <td style={TD_STYLE}><StatusBadge status={String(d.status || 'pending')} /></td>
                      <td style={{ ...TD_STYLE, fontSize: 12, textTransform: 'capitalize', color: 'var(--txt2)' }}>{String(d.resolution || '—').replace(/-/g, ' ')}</td>
                      <td style={{ ...TD_STYLE, fontSize: 11.5, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtTs(String(d.dueAt || ''))}</td>
                      <td style={{ ...TD_STYLE, fontSize: 11.5, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtTs(String(d.resolvedAt || ''))}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
        <Pager page={disputePage} total={n(disputeData?.meta?.total)} perPage={PER_PAGE} onChange={setDisputePage} />
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERSWITCH TAB
// ═══════════════════════════════════════════════════════════════════════════════

function InterspwitchTab() {
  const steps = [
    { icon: 'call', title: 'Contact your Interswitch account manager', detail: 'Call 01-2715555 or email merchantsupport@interswitchgroup.com. Tell them you need reporting API credentials for your existing merchant account.' },
    { icon: 'vpn_key', title: 'Request specific credentials', detail: 'Merchant ID (MID) · Client ID · Client Secret · Reporting API base URL. Your account type is: Card acquiring (Web, POS, ATM).' },
    { icon: 'settings', title: 'Add credentials to Platform Settings', detail: 'Once received, go to Admin → Platform Settings → API Credentials and add INTERSWITCH_CLIENT_ID, INTERSWITCH_CLIENT_SECRET, and INTERSWITCH_BASE_URL.' },
    { icon: 'dashboard', title: 'Live data loads automatically', detail: 'This tab will immediately show Web, POS, and ATM transaction data, settlement reports, and reconciliation against your internal ledger.' },
  ]

  const capabilities = ['Web card transactions', 'POS terminal settlements', 'ATM withdrawals', 'Transaction line items', 'Processor vs ledger reconciliation', 'Interchange fees breakdown']

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ background: NAVY, padding: '22px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 13, background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 24, color: '#fff' }}>account_balance</span>
          </div>
          <div>
            <p style={{ fontSize: 17, fontWeight: 700, color: '#fff', margin: '0 0 3px' }}>Interswitch Integration Pending</p>
            <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.6)', margin: 0 }}>Merchant credentials needed to activate Web, POS &amp; ATM reconciliation</p>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: 'rgba(217,119,6,0.25)', color: '#FCD34D' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#FCD34D', display: 'inline-block' }} />
              Awaiting Credentials
            </span>
          </div>
        </div>
      </div>

      {/* Capabilities */}
      <div style={{ padding: '16px 28px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--txt2)', margin: '0 0 10px' }}>Once connected, this tab will show</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {capabilities.map(c => (
            <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 8, fontSize: 12, fontWeight: 500, color: 'var(--txt)', background: 'var(--card)', border: '1px solid var(--bdr)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13, color: NAVY }}>check</span>
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* Steps */}
      <div style={{ padding: '20px 28px' }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', margin: '0 0 16px' }}>How to activate</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <div style={{ width: 34, height: 34, borderRadius: '50%', background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 17, color: NAVY }}>{s.icon}</span>
                </div>
                {i < steps.length - 1 && <div style={{ width: 1, flex: 1, minHeight: 20, marginTop: 4, marginBottom: 4, background: 'var(--bdr)' }} />}
              </div>
              <div style={{ paddingBottom: i < steps.length - 1 ? 20 : 0 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', margin: '6px 0 3px' }}>{s.title}</p>
                <p style={{ fontSize: 12.5, color: 'var(--txt2)', margin: 0, lineHeight: 1.55 }}>{s.detail}</p>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: `${NAVY}06`, border: `1px solid ${NAVY}14`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>support_agent</span>
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', margin: '0 0 2px' }}>Interswitch Merchant Support</p>
            <p style={{ fontSize: 12, color: 'var(--txt2)', margin: 0 }}>01-2715555 &nbsp;·&nbsp; merchantsupport@interswitchgroup.com</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

const TABS = [
  { key: 'paystack',    label: 'Paystack',    icon: 'payments' },
  { key: 'interswitch', label: 'Interswitch', icon: 'account_balance' },
] as const
type TabKey = typeof TABS[number]['key']

export default function ProcessorReconciliation() {
  const [tab, setTab] = useState<TabKey>('paystack')
  const [from, setFrom] = useState(() => sessionStorage.getItem(FROM_KEY) ?? monthStart())
  const [to, setTo]     = useState(() => sessionStorage.getItem(TO_KEY)   ?? today())

  function handleFrom(v: string) { setFrom(v); sessionStorage.setItem(FROM_KEY, v) }
  function handleTo(v: string)   { setTo(v);   sessionStorage.setItem(TO_KEY, v) }

  return (
    <Page
      title="Processor Reconciliation"
      subtitle="Paystack and Interswitch settlement data vs internal EOD ledger"
      actions={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>From</span>
          <input type="date" value={from} onChange={e => handleFrom(e.target.value)}
            style={{ height: 32, padding: '0 10px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 13 }} />
          <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>To</span>
          <input type="date" value={to} onChange={e => handleTo(e.target.value)}
            style={{ height: 32, padding: '0 10px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 13 }} />
        </div>
      }
    >
      {/* Tab strip */}
      <div style={{ display: 'flex', borderBottom: '2px solid var(--bdr)', marginBottom: 20, gap: 0 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', fontSize: 13.5, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', transition: 'color 150ms',
              color: tab === t.key ? NAVY : 'var(--txt2)',
              borderBottom: tab === t.key ? `2px solid ${NAVY}` : '2px solid transparent',
              marginBottom: -2,
            }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'paystack' && <PaystackTab from={from} to={to} />}
      {tab === 'interswitch' && <InterspwitchTab />}
    </Page>
  )
}
