import { useEffect, useState } from 'react'
import {
  Page, KpiCard, SectionCard, Tabs, DataTable, Badge, Button, ErrBanner, EmptyState,
  type TableCol,
} from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct, fmtDate, fmtNum, n } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, FW, SP } from '../../lib/design'

// ── Types (mirror /api/cbs/reports/* and /api/cbs/sync/status) ────────────────

type Money = Record<string, any>
interface LoanBook {
  summary: { accounts: number; disbursed_kobo: number; outstanding_principal_kobo: number; outstanding_interest_kobo: number; outstanding_fee_kobo: number }
  by_status: { status: string; count: number; outstanding_kobo: number }[]
  by_product: { product_name: string; count: number; outstanding_kobo: number }[]
  loans: Money[]
}
interface FDBook {
  summary: { accounts: number; principal_kobo: number; accrued_kobo: number; ledger_kobo: number }
  by_status: { status: string; count: number; principal_kobo: number }[]
  by_product: { product_name: string; count: number; principal_kobo: number }[]
  maturity_ladder: { bucket: string; count: number; principal_kobo: number }[]
  fixed_deposits: Money[]
}
interface Recon {
  loans: { cbs_total: number; matched: number }
  fixed_deposits: { cbs_total: number; matched: number }
  unmatched_loans: Money[]
  unmatched_fds: Money[]
}
interface SyncStatus {
  last_run?: { status?: string; kind?: string; finished_at?: string; loans?: number; fds?: number; products?: number; error?: string }
  snapshot?: { products?: number; loans?: number; fixed_deposits?: number; linked?: number }
}

const TXT2 = 'var(--txt2)'
const TXT3 = 'var(--txt3)'

// ── Status colour mapping for loan/FD account states ──────────────────────────

function statusTone(s: string): string {
  const map: Record<string, string> = {
    Active: GREEN, Expired: AMBER, Defaulting: RED, Revoked: '#6B7280', Closed: NAVY,
  }
  return map[s] || NAVY
}
function StatusTag({ s }: { s: string }) {
  const c = statusTone(s || '—')
  return <span style={{ background: c + '18', color: c, padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: FW.semibold, whiteSpace: 'nowrap' }}>{s || '—'}</span>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CoreBanking() {
  const [tab, setTab] = useState('overview')
  const [loan, setLoan] = useState<LoanBook | null>(null)
  const [fd, setFD] = useState<FDBook | null>(null)
  const [recon, setRecon] = useState<Recon | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const [lb, fb, rc, ss] = await Promise.all([
        apiFetch<LoanBook>('/api/cbs/reports/loan-book'),
        apiFetch<FDBook>('/api/cbs/reports/fd-book'),
        apiFetch<Recon>('/api/cbs/reports/reconciliation'),
        apiFetch<SyncStatus>('/api/cbs/sync/status').catch(() => null as any),
      ])
      setLoan(lb); setFD(fb); setRecon(rc); setSync(ss)
    } catch (e: any) {
      setErr(e?.message || 'Failed to load core banking data')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function runSync() {
    setSyncing(true); setErr(null)
    try {
      await apiFetch('/api/cbs/sync', { method: 'POST' })
      await load()
    } catch (e: any) {
      setErr(e?.message || 'Sync failed (admin only)')
    } finally {
      setSyncing(false)
    }
  }

  const last = sync?.last_run
  const lastLabel = last?.finished_at
    ? `Synced ${fmtDate(last.finished_at, { dateStyle: 'medium' })}`
    : 'Not yet synced'

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'loans', label: 'Loan Book', badge: loan?.summary?.accounts },
    { key: 'fd', label: 'Fixed Deposits', badge: fd?.summary?.accounts },
    { key: 'recon', label: 'Reconciliation', badge: recon ? recon.unmatched_loans.length + recon.unmatched_fds.length : undefined },
  ]

  return (
    <Page
      title="Core Banking"
      subtitle="Live view of the Udara360 book — loans, fixed deposits, and reconciliation"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
          <Badge variant={last?.status === 'ok' ? 'success' : 'default'} dot>{lastLabel}</Badge>
          <Button variant="secondary" icon="sync" loading={syncing} onClick={runSync}>Sync now</Button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'overview' && <Overview loan={loan} fd={fd} recon={recon} loading={loading} />}
      {tab === 'loans' && <LoanTab data={loan} loading={loading} />}
      {tab === 'fd' && <FDTab data={fd} loading={loading} />}
      {tab === 'recon' && <ReconTab data={recon} loading={loading} />}
    </Page>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────

function Overview({ loan, fd, recon, loading }: { loan: LoanBook | null; fd: FDBook | null; recon: Recon | null; loading: boolean }) {
  const unmatched = recon ? recon.unmatched_loans.length + recon.unmatched_fds.length : 0
  return (
    <>
      <div style={grid(220)}>
        <KpiCard label="Loan accounts" value={fmtNum(loan?.summary.accounts)} sub="on Udara360" icon="request_quote" accent={NAVY} loading={loading} />
        <KpiCard label="Loan outstanding" value={fmtKobo(loan?.summary.outstanding_principal_kobo)} sub="principal" icon="payments" accent={RED} loading={loading} />
        <KpiCard label="Fixed deposits" value={fmtNum(fd?.summary.accounts)} sub="active + closed" icon="savings" accent={NAVY} loading={loading} />
        <KpiCard label="FD principal" value={fmtKobo(fd?.summary.principal_kobo)} sub="total booked" icon="account_balance" accent={GREEN} loading={loading} />
      </div>

      <div style={{ ...grid(320), marginTop: SP[6] }}>
        <SectionCard title="Loan book by status">
          <BreakdownBars rows={(loan?.by_status || []).map(r => ({ label: r.status, count: r.count, amount: r.outstanding_kobo }))} total={loan?.summary.outstanding_principal_kobo || 0} tone={statusTone} />
        </SectionCard>
        <SectionCard title="Data health">
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 10, margin: 0 }}>
            <dt style={{ color: TXT2 }}>Loan outstanding interest</dt><dd style={dd}>{fmtKobo(loan?.summary.outstanding_interest_kobo)}</dd>
            <dt style={{ color: TXT2 }}>FD accrued interest</dt><dd style={dd}>{fmtKobo(fd?.summary.accrued_kobo)}</dd>
            <dt style={{ color: TXT2 }}>Linked to workspace</dt><dd style={dd}>{fmtNum((recon?.loans.matched || 0) + (recon?.fixed_deposits.matched || 0))}</dd>
            <dt style={{ color: TXT2 }}>Unmatched (needs linking)</dt><dd style={{ ...dd, color: unmatched ? AMBER : GREEN }}>{fmtNum(unmatched)}</dd>
          </dl>
        </SectionCard>
      </div>
    </>
  )
}

// ── Loan Book ─────────────────────────────────────────────────────────────────

function LoanTab({ data, loading }: { data: LoanBook | null; loading: boolean }) {
  const cols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.cbs_account_number || '—'}</span> },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'outstanding_principal_kobo', label: 'Outstanding', align: 'right', render: r => fmtKobo(r.outstanding_principal_kobo) },
    { key: 'loan_amount_kobo', label: 'Disbursed', align: 'right', render: r => fmtKobo(r.loan_amount_kobo) },
    { key: 'interest_rate', label: 'Rate', align: 'right', render: r => fmtPct(r.interest_rate, 1) },
    { key: 'maturity_date', label: 'Maturity', render: r => fmtDate(r.maturity_date) },
    { key: 'officer_name', label: 'Officer' },
  ]
  return (
    <>
      <div style={grid(200)}>
        <KpiCard label="Accounts" value={fmtNum(data?.summary.accounts)} icon="request_quote" accent={NAVY} loading={loading} />
        <KpiCard label="Disbursed" value={fmtKobo(data?.summary.disbursed_kobo)} icon="north_east" accent={BLUE} loading={loading} />
        <KpiCard label="Outstanding principal" value={fmtKobo(data?.summary.outstanding_principal_kobo)} icon="payments" accent={RED} loading={loading} />
        <KpiCard label="Outstanding interest" value={fmtKobo(data?.summary.outstanding_interest_kobo)} icon="percent" accent={AMBER} loading={loading} />
      </div>
      <div style={{ ...grid(320), marginTop: SP[6], marginBottom: SP[6] }}>
        <SectionCard title="By status">
          <BreakdownBars rows={(data?.by_status || []).map(r => ({ label: r.status, count: r.count, amount: r.outstanding_kobo }))} total={data?.summary.outstanding_principal_kobo || 0} tone={statusTone} />
        </SectionCard>
        <SectionCard title="By product">
          <BreakdownBars rows={(data?.by_product || []).map(r => ({ label: r.product_name, count: r.count, amount: r.outstanding_kobo }))} total={data?.summary.outstanding_principal_kobo || 0} tone={() => NAVY} />
        </SectionCard>
      </div>
      <SectionCard title="Loan accounts" padding={false}>
        <DataTable cols={cols} rows={data?.loans || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i}
          searchKeys={['cbs_account_number', 'product_name', 'status', 'officer_name']} searchPlaceholder="Search loans…" pageSize={15} />
      </SectionCard>
    </>
  )
}

// ── Fixed Deposits ────────────────────────────────────────────────────────────

function FDTab({ data, loading }: { data: FDBook | null; loading: boolean }) {
  const cols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.cbs_account_number || '—'}</span> },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => fmtKobo(r.principal_kobo) },
    { key: 'accrued_interest_kobo', label: 'Accrued', align: 'right', render: r => fmtKobo(r.accrued_interest_kobo) },
    { key: 'interest_rate', label: 'Rate', align: 'right', render: r => fmtPct(r.interest_rate, 1) },
    { key: 'commencement_date', label: 'Start', render: r => fmtDate(r.commencement_date) },
    { key: 'maturity_date', label: 'Maturity', render: r => fmtDate(r.maturity_date) },
  ]
  return (
    <>
      <div style={grid(200)}>
        <KpiCard label="Accounts" value={fmtNum(data?.summary.accounts)} icon="savings" accent={NAVY} loading={loading} />
        <KpiCard label="Principal" value={fmtKobo(data?.summary.principal_kobo)} icon="account_balance" accent={GREEN} loading={loading} />
        <KpiCard label="Accrued interest" value={fmtKobo(data?.summary.accrued_kobo)} icon="percent" accent={AMBER} loading={loading} />
        <KpiCard label="Ledger balance" value={fmtKobo(data?.summary.ledger_kobo)} icon="account_balance_wallet" accent={BLUE} loading={loading} />
      </div>
      <div style={{ ...grid(320), marginTop: SP[6], marginBottom: SP[6] }}>
        <SectionCard title="Maturity ladder" subtitle="FDs maturing by month">
          <BreakdownBars rows={(data?.maturity_ladder || []).map(r => ({ label: r.bucket, count: r.count, amount: r.principal_kobo }))} total={data?.summary.principal_kobo || 0} tone={() => BLUE} />
        </SectionCard>
        <SectionCard title="By product">
          <BreakdownBars rows={(data?.by_product || []).map(r => ({ label: r.product_name, count: r.count, amount: r.principal_kobo }))} total={data?.summary.principal_kobo || 0} tone={() => NAVY} />
        </SectionCard>
      </div>
      <SectionCard title="Fixed deposit accounts" padding={false}>
        <DataTable cols={cols} rows={data?.fixed_deposits || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i}
          searchKeys={['cbs_account_number', 'product_name', 'status']} searchPlaceholder="Search fixed deposits…" pageSize={15} />
      </SectionCard>
    </>
  )
}

// ── Reconciliation ────────────────────────────────────────────────────────────

function ReconTab({ data, loading }: { data: Recon | null; loading: boolean }) {
  const loanCols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account' },
    { key: 'cbs_customer_id', label: 'CBS customer' },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'outstanding_principal_kobo', label: 'Outstanding', align: 'right', render: r => fmtKobo(r.outstanding_principal_kobo) },
  ]
  const fdCols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account' },
    { key: 'cbs_customer_id', label: 'CBS customer' },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => fmtKobo(r.principal_kobo) },
  ]
  const lt = data?.loans, ft = data?.fixed_deposits
  return (
    <>
      <div style={{ background: AMBER + '12', border: `1px solid ${AMBER}40`, borderRadius: 10, padding: SP[4], marginBottom: SP[6], color: TXT2, fontSize: 13 }}>
        These CBS accounts have no matching workspace record (matched on CIF). Linking connects each to a workspace
        customer so overlay data (officers, notes, approvals) and workflows attach to the right account.
      </div>
      <div style={grid(220)}>
        <KpiCard label="Loans linked" value={`${fmtNum(lt?.matched)} / ${fmtNum(lt?.cbs_total)}`} sub="matched to workspace" icon="link" accent={lt && lt.matched === lt.cbs_total ? GREEN : AMBER} loading={loading} />
        <KpiCard label="Loans unmatched" value={fmtNum(data?.unmatched_loans.length)} icon="link_off" accent={RED} loading={loading} />
        <KpiCard label="FDs linked" value={`${fmtNum(ft?.matched)} / ${fmtNum(ft?.cbs_total)}`} sub="matched to workspace" icon="link" accent={ft && ft.matched === ft.cbs_total ? GREEN : AMBER} loading={loading} />
        <KpiCard label="FDs unmatched" value={fmtNum(data?.unmatched_fds.length)} icon="link_off" accent={RED} loading={loading} />
      </div>
      <div style={{ marginTop: SP[6] }}>
        <SectionCard title="Unmatched loans" padding={false} style={{ marginBottom: SP[6] }}>
          {(!loading && data && data.unmatched_loans.length === 0)
            ? <EmptyState icon="check_circle" title="All loans linked" description="Every CBS loan maps to a workspace record." />
            : <DataTable cols={loanCols} rows={data?.unmatched_loans || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i} searchKeys={['cbs_account_number', 'cbs_customer_id', 'product_name']} pageSize={10} />}
        </SectionCard>
        <SectionCard title="Unmatched fixed deposits" padding={false}>
          {(!loading && data && data.unmatched_fds.length === 0)
            ? <EmptyState icon="check_circle" title="All FDs linked" description="Every CBS fixed deposit maps to a workspace record." />
            : <DataTable cols={fdCols} rows={data?.unmatched_fds || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i} searchKeys={['cbs_account_number', 'cbs_customer_id', 'product_name']} pageSize={10} />}
        </SectionCard>
      </div>
    </>
  )
}

// ── Shared ────────────────────────────────────────────────────────────────────

function grid(min: number): React.CSSProperties {
  return { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: SP[4] }
}

function BreakdownBars({ rows, tone }: { rows: { label: string; count: number; amount: number }[]; tone: (label: string) => string; total: number }) {
  if (!rows.length) return <EmptyState icon="inbox" title="No data" />
  const max = Math.max(...rows.map(r => n(r.amount)), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map(r => (
        <div key={r.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ fontWeight: FW.medium }}>{r.label} <span style={{ color: TXT3 }}>· {fmtNum(r.count)}</span></span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: TXT2 }}>{fmtKobo(r.amount)}</span>
          </div>
          <div style={{ height: 8, background: 'var(--th-bg, #EEF1F4)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(2, (n(r.amount) / max) * 100)}%`, height: '100%', background: tone(r.label), borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

const dd: React.CSSProperties = { textAlign: 'right', fontWeight: FW.semibold, fontVariantNumeric: 'tabular-nums', margin: 0 }
