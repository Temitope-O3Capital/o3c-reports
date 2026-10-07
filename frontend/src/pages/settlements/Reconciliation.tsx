import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, ErrBanner, StatusBadge, DateFilter, SectionCard, KpiCard, DataTable,
  Pagination, EmptyState, SegmentedToggle, Badge, Button,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum, fmtDate, today, monthStart } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { humanLabel } from '../../lib/labels'
import { ELine } from '../../components/echarts'

/*
  PROVIDERS — the two payment rails, in detail.

  CCS is the master ledger. Interswitch and Paystack are providers whose activity
  has to roll up to it, and they arrive by completely different means: Interswitch
  as uploaded settlement reports, Paystack live from its API. This page is the drill
  behind the Settlement Position summary.

  It replaces "Processor Reconciliation", which hand-rolled its own table styles,
  pager, filter pills and KPI cards instead of using the house components, and whose
  Interswitch tab was wrong in a way no amount of restyling would fix — see the
  Interswitch section below.
*/

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

interface EodSummary { txn_count: number; total_vol_kobo: number }

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

interface PsPagedResponse<T> { data: T[]; meta: { total: number; page: number; perPage: number } }
interface BalanceLedger { data: LedgerEntry[]; meta?: { total: number; page: number; perPage: number } }

/*
  The Interswitch summary, rebuilt.

  The old shape compared an "interswitch" count against the internal EOD ledger.
  Both halves were wrong: the source was app.interswitch_txns, a back-compat VIEW
  over ccs_transactions (migration 126 renamed the table because it "never held
  Interswitch data"), and the counterparty for a payment provider is the MASTER
  ledger, not the EOD ledger. So the screen reported CCS-vs-ledger under the heading
  "Interswitch EOD", and the real uploaded settlement feed appeared nowhere.
*/
interface IswSummary {
  has_data: boolean
  fetched_at?: string
  source?: string
  master_note?: string
  interswitch?: {
    txn_count: number; gross_kobo: number; fees_kobo: number
    legs: number; days_with_data: number
  }
  ccs?: { txn_count: number; total_vol_kobo: number; days_with_data: number }
  tie_out?: { matched: number; comparable: number; no_master_data: number; pct: number }
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

function useFetch<T = unknown>(url: string | null): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData]       = useState<T | null>(null)
  const [loading, setLoading] = useState(!!url)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!url) { setData(null); setLoading(false); return }
    let cancelled = false
    setLoading(true); setError(null)
    apiFetch<T>(url)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [url])

  return { data, loading, error }
}

const FROM_KEY = 'ps_recon_from'
const TO_KEY   = 'ps_recon_to'
const PER_PAGE = 50

/* A labelled figure. Used where a KpiCard would be too heavy — inside a card that
   already has its own heading. */
function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.semibold, color: tone ?? 'var(--txt)' }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

/* Agreement between two figures, as a word and a colour rather than a bare delta —
   "Match" is the thing a reconciler is looking for and it should be readable at a
   glance without comparing two numbers by eye. */
function DeltaBadge({ apiVal, eodVal, isCount = false }: { apiVal: number; eodVal: number; isCount?: boolean }) {
  const diff = apiVal - eodVal
  if (diff === 0) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: GREEN, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>check_circle</span>
        Match
      </span>
    )
  }
  const base = Math.max(Math.abs(eodVal), 1)
  const pct  = (Math.abs(diff) / base) * 100
  const tone = pct >= 5 ? RED : AMBER
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: tone, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>
        {pct >= 5 ? 'error' : 'warning'}
      </span>
      <span style={NUM}>
        {diff > 0 ? '+' : '−'}{isCount ? fmtNum(Math.abs(diff)) : fmtKoboExact(Math.abs(diff))}
      </span>
      <span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}>({pct.toFixed(1)}%)</span>
    </span>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERSWITCH
// ═══════════════════════════════════════════════════════════════════════════════

function InterswitchPanel({ from, to }: { from: string; to: string }) {
  const navigate = useNavigate()
  const [data, setData]       = useState<IswSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setData(await apiFetch<IswSummary>(
        `/api/reconciliation/interswitch/summary?date_from=${from}&date_to=${to}`))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load Interswitch settlement')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  if (error) return <ErrBanner error={error} onRetry={load} />

  const isw = data?.interswitch
  const ccs = data?.ccs
  const tie = data?.tie_out
  const tiePct = n(tie?.pct)
  const gap = n(tie?.no_master_data)

  if (!loading && !data?.has_data) {
    return (
      <SectionCard>
        <EmptyState icon="upload_file"
          title={`No Interswitch settlement report covers ${fmtDate(from)} – ${fmtDate(to)}`}
          description="Interswitch has no API — its settlement data arrives as uploaded reports. Upload the report for these dates to reconcile them."
          action={{ label: 'Upload Settlement Report', icon: 'upload_file',
            onClick: () => navigate('/reports/uploads/interswitch') }} />
      </SectionCard>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3] }}>
        <KpiCard label="Settlement Gross" value={fmtKobo(isw?.gross_kobo)}
          sub={`${fmtNum(isw?.txn_count)} transactions · ${fmtNum(isw?.legs)} legs`}
          icon="credit_card" accent={BLUE} loading={loading && !data} />
        <KpiCard label="Fees & Charges" value={fmtKobo(Math.abs(n(isw?.fees_kobo)))}
          sub={n(isw?.fees_kobo) < 0 ? 'deducted from gross' : 'added to gross'}
          icon="price_change" accent={AMBER} loading={loading && !data} />
        <KpiCard label="CCS Master" value={fmtNum(ccs?.txn_count)}
          sub={`${fmtNum(ccs?.days_with_data)} days with data`}
          icon="account_balance_wallet" accent={NAVY} loading={loading && !data} />
        <KpiCard label="Tied to Master"
          value={n(tie?.comparable) > 0 ? `${tiePct.toFixed(1)}%` : '—'}
          sub={gap > 0
            ? `${fmtNum(tie?.matched)} of ${fmtNum(tie?.comparable)} · ${fmtNum(gap)} awaiting CCS`
            : `${fmtNum(tie?.matched)} of ${fmtNum(tie?.comparable)} by STAN`}
          icon="link" accent={tiePct >= 90 ? GREEN : tiePct >= 60 ? AMBER : RED}
          loading={loading && !data} />
      </div>

      {data?.master_note && (
        <div role="note" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3], padding: SP[4],
          borderRadius: RADIUS.lg, background: 'var(--card)',
          border: '1px solid var(--card-bdr)', borderLeft: `4px solid ${AMBER}`,
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 20, color: AMBER, flexShrink: 0 }}>cloud_off</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 'var(--lh-relaxed)' }}>
            {data.master_note}
          </div>
        </div>
      )}

      <SectionCard
        title="Interswitch Settlement vs the CCS Master"
        subtitle={`${fmtDate(from)} – ${fmtDate(to)} · uploaded settlement reports, matched on STAN`}
        actions={
          <div style={{ display: 'flex', gap: SP[2] }}>
            <Button size="sm" variant="secondary" icon="upload_file"
              onClick={() => navigate('/reports/uploads/interswitch')}>Upload Report</Button>
            <Button size="sm" variant="secondary" icon="play_arrow"
              onClick={() => navigate('/settlements/workbench')}>Reconcile</Button>
          </div>
        }
      >
        <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', marginBottom: SP[4] }}>
          <Stat label="Interswitch transactions" value={fmtNum(isw?.txn_count)}
            sub={`${fmtNum(isw?.days_with_data)} days covered`} />
          <Stat label="Matched to a CCS record" value={fmtNum(tie?.matched)} tone={GREEN} />
          <Stat label="Unmatched, master present" value={fmtNum(Math.max(n(tie?.comparable) - n(tie?.matched), 0))}
            tone={RED} sub="real breaks" />
          <Stat label="On days CCS does not cover" value={fmtNum(gap)}
            tone="#5B7A94" sub="feed gap, not a break" />
        </div>

        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0, lineHeight: 'var(--lh-relaxed)' }}>
          Matched on <strong>STAN</strong> — the last six digits of the Interswitch RRN, zero-padded to
          meet the CCS trace — and dated on the transaction&apos;s own timestamp rather than the
          settlement date, because <strong>Interswitch settles T+1</strong>. Matching on the settlement
          date instead resolves one transaction in 4,275. Where both feeds hold data the rate is
          97–98%; the shortfall across a wider period is the CCS feed stopping, not money going missing.
        </p>
      </SectionCard>
    </div>
  )
}

/* One row of the processor-vs-ledger comparison. The two figures are carried as
   numbers rather than as a pre-rendered badge so the table holds data, not markup. */
interface CompareRow {
  metric: string
  source: string
  ledger: string
  apiVal: number
  eodVal: number
  isCount: boolean
}

const compareCols: TableCol<CompareRow>[] = [
  { key: 'metric', label: 'Metric', render: r => (
    <span style={{ fontWeight: FW.semibold }}>{r.metric}</span>) },
  { key: 'source', label: 'Paystack (Source)', align: 'right', render: r => (
    <span style={{ ...NUM, fontWeight: FW.bold }}>{r.source}</span>) },
  { key: 'ledger', label: 'EOD Ledger', align: 'right', render: r => (
    <span style={{ ...NUM, fontWeight: FW.bold }}>{r.ledger}</span>) },
  { key: 'match', label: 'Agreement', align: 'right', render: r => (
    <DeltaBadge apiVal={r.apiVal} eodVal={r.eodVal} isCount={r.isCount} />) },
]

// ═══════════════════════════════════════════════════════════════════════════════
// PAYSTACK
// ═══════════════════════════════════════════════════════════════════════════════

type PSSubTab = 'summary' | 'flow' | 'transactions' | 'settlements' | 'transfers' | 'fees' | 'refunds' | 'disputes'

const PS_SUBTABS: { value: PSSubTab; label: string }[] = [
  { value: 'summary',      label: 'Summary' },
  // 'Flow' is the old Settlement Position page, folded in here. It was a separate
  // top-level screen showing Paystack money movement — which is provider detail,
  // not a module-level position, and the module-level position now lives on the
  // landing page. Keeping it as its own nav entry split one provider's story
  // across two screens.
  { value: 'flow',         label: 'Money Flow' },
  { value: 'transactions', label: 'Transactions' },
  { value: 'settlements',  label: 'Settlements' },
  { value: 'transfers',    label: 'Transfers' },
  { value: 'fees',         label: 'Fees & Ledger' },
  { value: 'refunds',      label: 'Refunds' },
  { value: 'disputes',     label: 'Disputes' },
]

// ── Money-flow types (from the retired Settlement Position page) ──────────────

interface FlowTotals {
  funding_in_kobo: number; funding_in_n: number; fees_kobo: number
  transfers_out_kobo: number; transfers_out_n: number
  settled_kobo: number; settled_n: number; net_kobo: number
}
interface FlowPoint {
  day: string; funding_in_kobo: number; transfers_out_kobo: number; settled_kobo: number
}
interface FlowResp {
  period: { from: string; to: string }
  totals: FlowTotals
  series: FlowPoint[]
  unreconciled: { open_n: number; open_value_kobo: number; aged_30d_n: number }
}
interface FunnelRow {
  channel: string; attempts: number; success: number; abandoned: number
  failed: number; success_kobo: number; lost_kobo: number; completion_pct: number
}

/* Series slots are assigned in fixed order and never cycled, so a colour means the
   same thing every time the chart is drawn. */
const FLOW_SERIES = [
  { key: 'funding_in_kobo',    name: 'Funding In',      color: GREEN },
  { key: 'transfers_out_kobo', name: 'Transfers Out',   color: BLUE },
  { key: 'settled_kobo',       name: 'Settled to Bank', color: PURPLE },
] as const

function nairaAxis(v: number) {
  if (v >= 1_000_000_00) return `₦${(v / 1_000_000_00).toFixed(0)}m`
  if (v >= 1_000_00) return `₦${(v / 1_000_00).toFixed(0)}k`
  return v === 0 ? '0' : ''
}

/* Completion is a rate, so it gets a single-hue treatment rather than a
   categorical colour, and the poor performers are called out in status colour. */
function completionColor(pct: number) {
  return pct >= 60 ? GREEN : pct >= 30 ? AMBER : RED
}

function PaystackPanel({ from, to }: { from: string; to: string }) {
  const [sub, setSub] = useState<PSSubTab>('summary')
  const [txnPage, setTxnPage]         = useState(1)
  const [txnStatus, setTxnStatus]     = useState('')
  const [settlePage, setSettlePage]   = useState(1)
  const [xfrPage, setXfrPage]         = useState(1)
  const [xfrStatus, setXfrStatus]     = useState('')
  const [ledgerPage, setLedgerPage]   = useState(1)
  const [ledgerDir, setLedgerDir]     = useState<'all' | 'credit' | 'debit'>('all')
  const [refundPage, setRefundPage]   = useState(1)
  const [disputePage, setDisputePage] = useState(1)

  useEffect(() => {
    setTxnPage(1); setSettlePage(1); setXfrPage(1)
    setLedgerPage(1); setRefundPage(1); setDisputePage(1)
  }, [from, to])

  const txnP = new URLSearchParams({ date_from: from, date_to: to, page: String(txnPage), per_page: String(PER_PAGE) })
  if (txnStatus) txnP.set('status', txnStatus)
  const xfrP = new URLSearchParams({ from, to, page: String(xfrPage), per_page: String(PER_PAGE) })
  if (xfrStatus) xfrP.set('status', xfrStatus)

  const { data: summary, loading: loadingSum, error: sumErr } =
    useFetch<ReconSummaryResponse>(`/api/reconciliation/paystack/summary?date_from=${from}&date_to=${to}`)
  const { data: balance } = useFetch<BalanceLedger>('/api/reconciliation/paystack/balance')
  const { data: txnData, loading: loadingTxns } = useFetch<PsPagedResponse<PsTxn>>(
    sub === 'transactions' ? `/api/reconciliation/paystack/transactions?${txnP}` : null)
  const { data: settleData, loading: loadingSett } = useFetch<PsPagedResponse<PsSettlement>>(
    sub === 'settlements' ? `/api/reconciliation/paystack/settlements?from=${from}&to=${to}&page=${settlePage}&per_page=${PER_PAGE}` : null)
  const { data: xfrData, loading: loadingXfr } = useFetch<PsPagedResponse<Record<string, unknown>>>(
    sub === 'transfers' ? `/api/reconciliation/paystack/transfers?${xfrP}` : null)
  const { data: ledgerData, loading: loadingLedger } = useFetch<BalanceLedger>(
    sub === 'fees' ? `/api/reconciliation/paystack/ledger?page=${ledgerPage}&per_page=${PER_PAGE}` : null)
  const { data: refundData, loading: loadingRef } = useFetch<PsPagedResponse<Record<string, unknown>>>(
    sub === 'refunds' ? `/api/reconciliation/paystack/refunds?page=${refundPage}&per_page=${PER_PAGE}` : null)
  const { data: disputeData, loading: loadingDisp } = useFetch<PsPagedResponse<Record<string, unknown>>>(
    sub === 'disputes' ? `/api/reconciliation/paystack/disputes?page=${disputePage}&per_page=${PER_PAGE}` : null)
  const { data: flowData, loading: loadingFlow } = useFetch<FlowResp>(
    sub === 'flow' ? `/api/paystack/position?date_from=${from}&date_to=${to}` : null)
  const { data: funnelData, loading: loadingFunnel } = useFetch<{ data: FunnelRow[] }>(
    sub === 'flow' ? `/api/paystack/funnel?date_from=${from}&date_to=${to}` : null)

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
      <SectionCard>
        <EmptyState icon="key_off" title="Paystack Is Not Configured"
          description={summary.message || 'Set PAYSTACK_SECRET_KEY in the backend environment to pull live data.'} />
      </SectionCard>
    )
  }

  const subNav = (
    <div style={{ marginBottom: SP[5], overflowX: 'auto', paddingBottom: 2 }}>
      <SegmentedToggle<PSSubTab> value={sub} onChange={setSub} options={PS_SUBTABS} />
    </div>
  )

  // ── Columns ─────────────────────────────────────────────────────────────────

  const txnCols: TableCol<PsTxn>[] = [
    { key: 'reference', label: 'Reference', width: 190, render: t => (
      <div style={{ minWidth: 0 }}>
        <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>{t.reference}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtTs(t.paid_at || t.created_at)}</div>
      </div>
    ) },
    { key: 'customer', label: 'Customer', render: t => {
      const c = t.customer || {}, a = t.authorization || {}
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ')
      return (
        <div style={{ minWidth: 0 }}>
          {name && <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{name}</div>}
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{c.email || '—'}</div>
          {a.last4 && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {a.card_type} ····{a.last4}{a.bank ? ` · ${a.bank}` : ''}
            </div>
          )}
        </div>
      )
    } },
    { key: 'amount', label: 'Gross', align: 'right', sortable: true, width: 125,
      render: t => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKoboExact(n(t.amount))}</span> },
    { key: 'fees', label: 'Paystack Cut', align: 'right', sortable: true, width: 120,
      render: t => {
        const f = n(t.fees)
        return <span style={{ ...NUM, fontWeight: FW.semibold, color: f > 0 ? RED : 'var(--txt3)' }}>
          {f > 0 ? fmtKoboExact(f) : '—'}</span>
      } },
    { key: 'net', label: 'O3C Net', align: 'right', width: 125, render: t => (
      <span style={{ ...NUM, fontWeight: FW.bold, color: t.status === 'success' ? GREEN : 'var(--txt3)' }}>
        {t.status === 'success' ? fmtKoboExact(n(t.amount) - n(t.fees)) : '—'}
      </span>
    ) },
    { key: 'channel', label: 'Channel', width: 110, render: t => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{humanLabel(t.channel || '—')}</span>
    ) },
    { key: 'status', label: 'Status', width: 110,
      render: t => <StatusBadge status={t.status || 'pending'} size="sm" /> },
  ]

  const settleCols: TableCol<PsSettlement>[] = [
    { key: 'settlement_date', label: 'Settlement Date', width: 170, sortable: true, render: s => (
      <span style={{ fontWeight: FW.medium, whiteSpace: 'nowrap' }}>{fmtTs(s.settlement_date || s.createdAt)}</span>
    ) },
    { key: 'total_processed', label: 'Gross Collected', align: 'right', sortable: true,
      render: s => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(n(s.total_processed))}</span> },
    { key: 'total_fees', label: 'Paystack Fees', align: 'right', sortable: true,
      render: s => <span style={{ ...NUM, color: RED }}>{fmtKoboExact(n(s.total_fees))}</span> },
    { key: 'net', label: 'Net Settled to Bank', align: 'right', render: s => (
      <span style={{ ...NUM, fontWeight: FW.bold, color: GREEN }}>
        {fmtKoboExact(n(s.effective_amount ?? s.total_amount))}
      </span>
    ) },
    { key: 'status', label: 'Status', width: 110,
      render: s => <StatusBadge status={s.status || 'pending'} size="sm" /> },
  ]

  const xfrCols: TableCol<Record<string, unknown>>[] = [
    { key: 'reference', label: 'Reference', width: 185, render: t => (
      <div style={{ minWidth: 0 }}>
        <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>{String(t.reference || '—')}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          {fmtTs(String(t.transferred_at || t.createdAt || ''))}
        </div>
      </div>
    ) },
    { key: 'initiator', label: 'Initiated By', render: t => {
      const o = t.o3c_initiator as Record<string, unknown> | null | undefined
      const narration = String(t.reason || '—')
      if (!o) {
        return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontStyle: 'italic' }}>{narration}</span>
      }
      return (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
            {String(o.applicant_name || '—')}
          </div>
          {/* Coerced: these come off an `unknown` bag, and `unknown && Element` is
              not a ReactNode. */}
          {!!o.applicant_cif && <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>{String(o.applicant_cif)}</div>}
          {!!o.loan_ref && <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{String(o.loan_ref)}</div>}
        </div>
      )
    } },
    { key: 'recipient', label: 'Recipient', render: t => {
      const r = (t.recipient as Record<string, unknown>) || {}
      const d = (r.details as Record<string, unknown>) || {}
      return (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
            {String(d.account_name || (r.name as string) || '—')}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {String(d.bank_name || '')} {d.account_number ? `· ${String(d.account_number)}` : ''}
          </div>
        </div>
      )
    } },
    { key: 'amount', label: 'Amount', align: 'right', sortable: true, width: 125,
      render: t => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKoboExact(n(t.amount))}</span> },
    { key: 'fee', label: 'Fee', align: 'right', width: 115, render: t => {
      // Paystack does not return a per-transfer fee through the transfers API, so a
      // success with no fee_charged is priced from the published schedule and marked
      // 'est.' rather than silently shown as zero.
      const amt = n(t.amount)
      const actual = n(t.fee_charged)
      const xferEst = amt <= 500000 ? 1000 : amt <= 5000000 ? 2500 : 5000
      const stampEst = amt >= 1000000 ? 5000 : 0
      const fee = actual > 0 ? actual : (t.status === 'success' ? xferEst + stampEst : 0)
      const isEst = actual === 0 && t.status === 'success'
      if (fee <= 0) return <span style={{ color: 'var(--txt3)' }}>—</span>
      return (
        <span style={{ ...NUM, fontWeight: FW.semibold, color: RED }}>
          {fmtKoboExact(fee)}
          {isEst && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 4 }}>est.</span>}
        </span>
      )
    } },
    { key: 'wallet', label: 'Wallet Debited', align: 'right', width: 130, render: t => {
      const amt = n(t.amount)
      const actual = n(t.fee_charged)
      const xferEst = amt <= 500000 ? 1000 : amt <= 5000000 ? 2500 : 5000
      const stampEst = amt >= 1000000 ? 5000 : 0
      const fee = actual > 0 ? actual : (t.status === 'success' ? xferEst + stampEst : 0)
      return (
        <span style={{ ...NUM, fontWeight: FW.bold, color: t.status === 'success' ? RED : 'var(--txt3)' }}>
          {t.status === 'success' ? fmtKoboExact(amt + fee) : '—'}
        </span>
      )
    } },
    { key: 'status', label: 'Status', width: 110,
      render: t => <StatusBadge status={String(t.status || 'pending')} size="sm" /> },
  ]

  const LEDGER_TYPE: Record<string, string> = {
    Transfer_Charge: 'Transfer Fee', Transfer_Stamp_Duty_Charge: 'Stamp Duty',
    Transfer: 'Transfer', Settlement: 'Settlement', Refund: 'Refund', Chargeback: 'Chargeback',
  }

  const ledgerCols: TableCol<LedgerEntry>[] = [
    { key: 'model_responsible', label: 'Type', width: 140, render: r => {
      const diff = n(r.difference)
      const isCharge = r.model_responsible?.includes('Charge')
      const tone = isCharge ? RED : diff < 0 ? NAVY : GREEN
      const label = LEDGER_TYPE[r.model_responsible ?? ''] || r.model_responsible || '—'
      return (
        <span style={{
          fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
          borderRadius: 999, background: `${tone}14`, color: tone, whiteSpace: 'nowrap',
        }}>{label}</span>
      )
    } },
    { key: 'reason', label: 'Reason / Reference', render: r => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{String(r.reason || '—')}</span>
    ) },
    { key: 'difference', label: 'Change', align: 'right', sortable: true, width: 130, render: r => {
      const d = n(r.difference)
      return (
        <span style={{ ...NUM, fontWeight: FW.semibold, color: d > 0 ? GREEN : d < 0 ? RED : 'var(--txt3)' }}>
          {d !== 0 ? `${d > 0 ? '+' : ''}${fmtKoboExact(d)}` : '—'}
        </span>
      )
    } },
    { key: 'balance', label: 'Running Balance', align: 'right', width: 150, render: r => (
      <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(n(r.balance ?? r.closing_balance))}</span>
    ) },
    { key: 'created_at', label: 'Date', width: 160, render: r => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
        {fmtTs(r.createdAt as string || r.created_at)}
      </span>
    ) },
  ]

  const refundCols: TableCol<Record<string, unknown>>[] = [
    { key: 'amount', label: 'Amount', align: 'right', sortable: true, width: 130,
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: RED }}>{fmtKoboExact(n(r.amount))}</span> },
    { key: 'customer', label: 'Customer', render: r => {
      const c = (r.customer as Record<string, unknown>) || {}
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || String(c.email || '—')
      return <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold }}>{name}</span>
    } },
    { key: 'transaction_reference', label: 'Transaction Reference', render: r => (
      <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
        {String(r.transaction_reference || r.bank_reference || '—')}
      </span>
    ) },
    { key: 'refunded_at', label: 'Date', width: 160, render: r => (
      <span style={{ fontSize: TEXT.sm, whiteSpace: 'nowrap' }}>
        {fmtTs(String(r.refunded_at || r.createdAt || ''))}
      </span>
    ) },
    { key: 'status', label: 'Status', width: 110,
      render: r => <StatusBadge status={String(r.status || 'pending')} size="sm" /> },
  ]

  const disputeCols: TableCol<Record<string, unknown>>[] = [
    { key: 'transaction_reference', label: 'Txn Reference', width: 180, render: d => (
      <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
        {String(d.transaction_reference || '—')}
      </span>
    ) },
    { key: 'customer', label: 'Customer', render: d => {
      const c = (d.customer as Record<string, unknown>) || {}
      return <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold }}>{String(c.email || '—')}</span>
    } },
    { key: 'refund_amount', label: 'Refund Amount', align: 'right', sortable: true, width: 140,
      render: d => <span style={{ ...NUM, fontWeight: FW.semibold, color: RED }}>{fmtKoboExact(n(d.refund_amount))}</span> },
    { key: 'category', label: 'Category', render: d => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{humanLabel(String(d.category || '—'))}</span>
    ) },
    { key: 'status', label: 'Status', width: 110,
      render: d => <StatusBadge status={String(d.status || 'pending')} size="sm" /> },
    { key: 'resolution', label: 'Resolution', render: d => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', textTransform: 'capitalize' }}>
        {String(d.resolution || '—').replace(/-/g, ' ')}
      </span>
    ) },
    { key: 'dueAt', label: 'Due', width: 150, render: d => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtTs(String(d.dueAt || ''))}</span>
    ) },
  ]

  // ── Sub-panels ──────────────────────────────────────────────────────────────

  if (sub === 'summary') {
    const psCount  = n(ps?.total_count)
    const eodCount = n(eod?.txn_count)
    const psVol    = n(ps?.total_volume_kobo)
    const eodVol   = n(eod?.total_vol_kobo)

    return (
      <div>
        {subNav}

        {/* Live wallet balance — the one figure that is true right now rather than
            for the selected period, so it is set apart from everything below. */}
        <div style={{
          background: NAVY, borderRadius: RADIUS.xl, padding: `${SP[5]} ${SP[5]}`,
          display: 'flex', alignItems: 'center', gap: SP[4], marginBottom: SP[5], flexWrap: 'wrap',
        }}>
          <div aria-hidden="true" style={{
            width: 44, height: 44, borderRadius: RADIUS.lg, background: 'rgba(255,255,255,0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 24, color: '#fff' }}>
              account_balance_wallet
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: TEXT.xs, fontWeight: FW.semibold, textTransform: 'uppercase',
              letterSpacing: '0.06em', color: 'rgba(255,255,255,0.55)', marginBottom: 4,
            }}>Live Paystack Wallet Balance</div>
            <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.bold, color: '#fff', lineHeight: 1 }}>
              {liveBalKobo > 0 ? fmtKoboExact(liveBalKobo) : '—'}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{
              fontSize: TEXT.xs, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase',
              letterSpacing: '0.08em', marginBottom: 3,
            }}>Period</div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'rgba(255,255,255,0.85)' }}>
              {fmtDate(from)} – {fmtDate(to)}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3], marginBottom: SP[5] }}>
          <KpiCard label="Collected (Paystack)" value={fmtKobo(psVol)}
            sub={`${fmtNum(psCount)} transactions`} icon="arrow_downward" accent={GREEN}
            loading={loadingSum && !summary} />
          <KpiCard label="Collected (Ledger)" value={fmtKoboExact(eodVol)}
            sub={`${fmtNum(eodCount)} ledger entries`} icon="account_balance" accent={NAVY}
            loading={loadingSum && !summary} />
          <KpiCard label="Successful" value={fmtNum(ps?.success)}
            sub={`${fmtNum(ps?.failed)} failed or abandoned`} icon="check_circle" accent={GREEN}
            loading={loadingSum && !summary} />
          <KpiCard label="Count Agreement"
            value={psCount - eodCount === 0 ? 'Match' : `${psCount - eodCount > 0 ? '+' : '−'}${fmtNum(Math.abs(psCount - eodCount))}`}
            sub={psCount - eodCount === 0 ? 'Paystack and ledger agree'
              : psCount > eodCount ? 'Paystack shows more' : 'Ledger shows more'}
            icon={psCount - eodCount === 0 ? 'check_circle' : 'warning'}
            accent={psCount - eodCount === 0 ? GREEN : RED}
            loading={loadingSum && !summary} />
        </div>

        <SectionCard title="Processor vs Ledger"
          subtitle="Paystack API totals against the internal EOD ledger for the same period">
          <DataTable<CompareRow>
            cols={compareCols}
            rows={[
              {
                metric: 'Transaction Count', source: fmtNum(psCount), ledger: fmtNum(eodCount),
                apiVal: psCount, eodVal: eodCount, isCount: true,
              },
              {
                metric: 'Total Volume', source: fmtKoboExact(psVol), ledger: fmtKoboExact(eodVol),
                apiVal: psVol, eodVal: eodVol, isCount: false,
              },
            ]}
            keyFn={r => r.metric}
            loading={loadingSum && !summary} skeletonRows={2}
          />
        </SectionCard>

        {ps?.error && (
          <div role="alert" style={{
            display: 'flex', gap: SP[2], padding: SP[4], marginTop: SP[4], borderRadius: RADIUS.lg,
            background: 'rgba(192,0,0,0.06)', border: `1px solid ${RED}33`,
          }}>
            <span className="material-symbols-rounded" aria-hidden="true"
              style={{ fontSize: 20, color: RED, flexShrink: 0 }}>error</span>
            <div style={{ fontSize: TEXT.sm, color: RED }}>Paystack API error: {ps.error}</div>
          </div>
        )}
      </div>
    )
  }

  if (sub === 'flow') {
    const ft = flowData?.totals
    const series = flowData?.series ?? []
    const funnel = funnelData?.data ?? []

    const funnelCols: TableCol<FunnelRow>[] = [
      { key: 'channel', label: 'Channel', sortable: true,
        render: r => <span style={{ fontWeight: FW.medium }}>{humanLabel(r.channel || 'unknown')}</span> },
      { key: 'attempts', label: 'Attempts', align: 'right', sortable: true,
        render: r => <span style={NUM}>{fmtNum(r.attempts)}</span> },
      { key: 'success', label: 'Succeeded', align: 'right', sortable: true,
        render: r => <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtNum(r.success)}</span> },
      { key: 'abandoned', label: 'Abandoned', align: 'right', sortable: true,
        render: r => <span style={{ ...NUM, color: AMBER }}>{fmtNum(r.abandoned)}</span> },
      { key: 'failed', label: 'Failed', align: 'right', sortable: true,
        render: r => <span style={{ ...NUM, color: RED }}>{fmtNum(r.failed)}</span> },
      { key: 'success_kobo', label: 'Collected', align: 'right', sortable: true,
        render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.success_kobo)}</span> },
      { key: 'lost_kobo', label: 'Lost', align: 'right', sortable: true,
        render: r => <span style={{ ...NUM, color: RED }}>{fmtKobo(r.lost_kobo)}</span> },
      { key: 'completion_pct', label: 'Completion', align: 'right', sortable: true, width: 110,
        render: r => {
          const p = Number(r.completion_pct ?? 0)
          return <span style={{ ...NUM, color: completionColor(p), fontWeight: FW.semibold }}>{p.toFixed(1)}%</span>
        } },
    ]

    return (
      <div>
        {subNav}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3], marginBottom: SP[5] }}>
          <KpiCard label="Funding In" value={fmtKobo(ft?.funding_in_kobo)}
            sub={`${fmtNum(ft?.funding_in_n)} successful`} icon="arrow_downward" accent={GREEN}
            loading={loadingFlow && !flowData} />
          <KpiCard label="Transfers Out" value={fmtKobo(ft?.transfers_out_kobo)}
            sub={`${fmtNum(ft?.transfers_out_n)} sent`} icon="arrow_upward" accent={BLUE}
            loading={loadingFlow && !flowData} />
          <KpiCard label="Settled to Bank" value={fmtKobo(ft?.settled_kobo)}
            sub={`${fmtNum(ft?.settled_n)} settlements · fees ${fmtKobo(ft?.fees_kobo)}`}
            icon="account_balance" accent={PURPLE} loading={loadingFlow && !flowData} />
          <KpiCard label="Net Movement" value={fmtKobo(ft?.net_kobo)}
            sub={Number(ft?.net_kobo ?? 0) >= 0 ? 'wallet grew over the period' : 'wallet drained over the period'}
            icon="swap_vert" accent={Number(ft?.net_kobo ?? 0) >= 0 ? GREEN : AMBER}
            loading={loadingFlow && !flowData} />
        </div>

        <SectionCard title="Daily Money Movement"
          subtitle={`Funding in, transfers out and bank settlements by day · ${fmtDate(from)} – ${fmtDate(to)}`}
          style={{ marginBottom: SP[4] }}>
          {loadingFlow && !flowData ? (
            <div style={{ height: 260 }} />
          ) : series.length === 0 ? (
            <EmptyState icon="show_chart" title="No movement in this period"
              description="Nothing came in, went out or settled on these dates." />
          ) : (
            <ELine
              data={series}
              xKey="day"
              height={260}
              valueFmt={fmtKobo}
              axisFmt={nairaAxis}
              series={FLOW_SERIES.map(s => ({ key: s.key, name: s.name, color: s.color })) as any}
            />
          )}
        </SectionCard>

        <SectionCard title="Funding Funnel by Channel" padding={false}
          subtitle="Where customers abandon or fail — completion is the share of attempts that succeeded">
          <DataTable cols={funnelCols} rows={funnel} keyFn={r => r.channel}
            loading={loadingFunnel && !funnelData} skeletonRows={5}
            emptyText={<EmptyState icon="filter_alt" title="No funding attempts"
              description="No customer tried to fund a wallet in this period." />} />
        </SectionCard>
      </div>
    )
  }

  if (sub === 'transactions') return (
    <div>
      {subNav}
      <SectionCard title="Incoming Transactions" padding={false}
        subtitle={`Money received from customers · ${fmtDate(from)} – ${fmtDate(to)}`}
        actions={
          <SegmentedToggle<string> value={txnStatus}
            onChange={v => { setTxnStatus(v); setTxnPage(1) }}
            options={[
              { value: '', label: 'All' },
              { value: 'success', label: 'Successful' },
              { value: 'failed', label: 'Failed' },
              { value: 'abandoned', label: 'Abandoned' },
            ]} />
        }>
        <DataTable cols={txnCols} rows={txnData?.data ?? []} keyFn={(t, i) => t.reference || i}
          loading={loadingTxns} skeletonRows={8}
          emptyText={<EmptyState icon="receipt_long" title="No transactions"
            description="No funding attempts fall in this period." />} />
        <Pagination page={txnPage} pages={Math.max(1, Math.ceil(n(txnData?.meta?.total) / PER_PAGE))}
          total={n(txnData?.meta?.total)} pageSize={PER_PAGE} onPage={setTxnPage} />
      </SectionCard>
    </div>
  )

  if (sub === 'settlements') return (
    <div>
      {subNav}
      <SectionCard title="Settlements to Bank" padding={false}
        subtitle={`Net amounts Paystack disbursed to the O3 account · ${fmtDate(from)} – ${fmtDate(to)}`}>
        <DataTable cols={settleCols} rows={settleData?.data ?? []} keyFn={(s, i) => s.id || i}
          loading={loadingSett} skeletonRows={8}
          emptyText={<EmptyState icon="account_balance" title="No settlements"
            description="Paystack disbursed nothing in this period." />} />
        <Pagination page={settlePage} pages={Math.max(1, Math.ceil(n(settleData?.meta?.total) / PER_PAGE))}
          total={n(settleData?.meta?.total)} pageSize={PER_PAGE} onPage={setSettlePage} />
      </SectionCard>
    </div>
  )

  if (sub === 'transfers') return (
    <div>
      {subNav}
      <SectionCard title="Outbound Transfers" padding={false}
        subtitle={`Money sent from the Paystack wallet · ${fmtDate(from)} – ${fmtDate(to)}`}
        actions={
          <SegmentedToggle<string> value={xfrStatus}
            onChange={v => { setXfrStatus(v); setXfrPage(1) }}
            options={[
              { value: '', label: 'All' },
              { value: 'success', label: 'Successful' },
              { value: 'failed', label: 'Failed' },
              { value: 'pending', label: 'Pending' },
              { value: 'reversed', label: 'Reversed' },
            ]} />
        }>
        <DataTable cols={xfrCols} rows={xfrData?.data ?? []}
          keyFn={(t, i) => String(t.reference ?? i)}
          loading={loadingXfr} skeletonRows={8}
          emptyText={<EmptyState icon="send" title="No transfers"
            description="Nothing left the wallet in this period." />} />
        <Pagination page={xfrPage} pages={Math.max(1, Math.ceil(n(xfrData?.meta?.total) / PER_PAGE))}
          total={n(xfrData?.meta?.total)} pageSize={PER_PAGE} onPage={setXfrPage} />
        <p style={{ fontSize: TEXT.xs, color: 'var(--txt2)', padding: `0 ${SP[4]} ${SP[3]}`, lineHeight: 'var(--lh-relaxed)' }}>
          Fees marked <em>est.</em> are priced from the published schedule — Paystack does not return a
          per-transfer fee through the transfers API. <strong>Initiated By</strong> shows the borrower
          name, CIF and loan reference for disbursements; other transfers show the narration instead.
        </p>
      </SectionCard>
    </div>
  )

  if (sub === 'fees') {
    const tiles = [
      { key: 'Transfer_Charge', label: 'Transfer Fees', icon: 'price_change', accent: RED },
      { key: 'Transfer_Stamp_Duty_Charge', label: 'Stamp Duty', icon: 'receipt', accent: AMBER },
      { key: 'Transfer', label: 'Transfer Debits', icon: 'send', accent: NAVY },
      { key: '__credits__', label: 'Wallet Funded', icon: 'account_balance_wallet', accent: GREEN },
    ]
    return (
      <div>
        {subNav}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3], marginBottom: SP[4] }}>
          {tiles.map(({ key, label, icon, accent }) => {
            const rows = key === '__credits__'
              ? allLedger.filter(r => n(r.difference) > 0)
              : allLedger.filter(r => r.model_responsible === key)
            const total = rows.reduce((s, r) => s + Math.abs(n(r.difference)), 0)
            return (
              <KpiCard key={key} label={label} icon={icon} accent={accent}
                value={total > 0 ? fmtKoboExact(total) : '—'}
                sub={`${rows.length} entries on this page`} loading={loadingLedger && !ledgerData} />
            )
          })}
        </div>
        <SectionCard title="Balance Ledger" padding={false}
          subtitle="Every debit and credit against the Paystack wallet, with the running balance"
          actions={
            <SegmentedToggle<'all' | 'credit' | 'debit'> value={ledgerDir} onChange={setLedgerDir}
              options={[
                { value: 'all', label: 'All' },
                { value: 'credit', label: 'Credits' },
                { value: 'debit', label: 'Debits' },
              ]} />
          }>
          <DataTable cols={ledgerCols} rows={filteredLedger} keyFn={(r, i) => i}
            loading={loadingLedger} skeletonRows={8}
            emptyText={<EmptyState icon="price_change" title="No ledger entries"
              description="Nothing moved against the wallet on this page." />} />
          <Pagination page={ledgerPage} pages={Math.max(1, Math.ceil(n(ledgerData?.meta?.total) / PER_PAGE))}
            total={n(ledgerData?.meta?.total)} pageSize={PER_PAGE} onPage={setLedgerPage} />
        </SectionCard>
      </div>
    )
  }

  if (sub === 'refunds') return (
    <div>
      {subNav}
      <SectionCard title="Refunds" padding={false}
        subtitle={`Transactions reversed back to customers · ${fmtNum(n(refundData?.meta?.total))} total`}>
        <DataTable cols={refundCols} rows={(refundData?.data ?? []) as Record<string, unknown>[]}
          keyFn={(r, i) => String(r.id ?? i)} loading={loadingRef} skeletonRows={6}
          emptyText={<EmptyState icon="undo" title="No refunds"
            description="Nothing has been refunded to a customer." />} />
        <Pagination page={refundPage} pages={Math.max(1, Math.ceil(n(refundData?.meta?.total) / PER_PAGE))}
          total={n(refundData?.meta?.total)} pageSize={PER_PAGE} onPage={setRefundPage} />
      </SectionCard>
    </div>
  )

  return (
    <div>
      {subNav}
      <SectionCard title="Disputes & Chargebacks" padding={false}
        subtitle="Transactions disputed by customers or their issuing banks">
        <DataTable cols={disputeCols} rows={(disputeData?.data ?? []) as Record<string, unknown>[]}
          keyFn={(d, i) => String(d.id ?? i)} loading={loadingDisp} skeletonRows={6}
          emptyText={<EmptyState icon="gavel" title="No disputes"
            description="No transaction has been disputed." />} />
        <Pagination page={disputePage} pages={Math.max(1, Math.ceil(n(disputeData?.meta?.total) / PER_PAGE))}
          total={n(disputeData?.meta?.total)} pageSize={PER_PAGE} onPage={setDisputePage} />
      </SectionCard>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════════

type Provider = 'interswitch' | 'paystack'

export default function Providers() {
  const [provider, setProvider] = useState<Provider>('interswitch')
  // The period survives a navigation away and back — a reconciler works one period
  // for a long stretch and re-picking it on every visit is pure friction.
  const [from, setFrom] = useState(() => sessionStorage.getItem(FROM_KEY) ?? monthStart())
  const [to, setTo]     = useState(() => sessionStorage.getItem(TO_KEY)   ?? today())

  function handleFrom(v: string) { setFrom(v); sessionStorage.setItem(FROM_KEY, v) }
  function handleTo(v: string)   { setTo(v);   sessionStorage.setItem(TO_KEY, v) }

  return (
    <Page
      title="Providers"
      subtitle="Interswitch settles the card rails; Paystack settles the mobile app. Both must roll up to CCS."
      actions={<DateFilter from={from} to={to} onChange={(f, t) => { handleFrom(f); handleTo(t) }} align="right" />}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], marginBottom: SP[5], flexWrap: 'wrap' }}>
        <SegmentedToggle<Provider>
          value={provider} onChange={setProvider}
          options={[
            { value: 'interswitch', label: 'Interswitch' },
            { value: 'paystack',    label: 'Paystack' },
          ]}
        />
        <Badge variant="default">
          {provider === 'interswitch' ? 'Uploaded settlement reports' : 'Live API'}
        </Badge>
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
          {provider === 'interswitch'
            ? 'Card rails: POS, ATM, web, bill payment, agency banking'
            : 'Mobile app rails: wallet funding in, transfers out'}
        </span>
      </div>

      {provider === 'interswitch'
        ? <InterswitchPanel from={from} to={to} />
        : <PaystackPanel from={from} to={to} />}
    </Page>
  )
}
