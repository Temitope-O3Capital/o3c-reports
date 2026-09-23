import { useEffect, useState } from 'react'
import {
  Page, KpiCard, SectionCard, Tabs, DataTable, Badge, ErrBanner, EmptyState, Modal, Spinner,
  type TableCol,
} from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { useLiveData } from '../../hooks/useRealtime'
import { fmtKobo, fmtPct, fmtDate, fmtDatetime, fmtNum, n } from '../../lib/fmt'
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
interface CustomerList {
  summary: { total: number; linked: number; with_phone: number; with_email: number }
  customers: Money[]
}
interface CustomerDetail {
  cbs: Money
  workspace: Money
  in_workspace: boolean
  loans: Money[]
  fixed_deposits: Money[]
  repayments: Money[]
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
  const [cust, setCust] = useState<CustomerList | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // The Udara customer id whose detail modal is open (null = closed). NOT a CIF — that
  // is a cards identifier in a separate namespace that collides on the same 8-digit
  // shape for a different person. Every table that carries a Udara customer id opens
  // the same modal, so the Udara-vs-workspace detail view is reached identically from
  // Loans, Fixed Deposits, and Customers.
  const [openUdaraId, setOpenUdaraId] = useState<string | null>(null)

  // load pulls all report data. Pass silent=true for the background auto-refresh so
  // the view updates in place without flashing skeletons or surfacing transient errors.
  async function load(silent = false) {
    if (!silent) setLoading(true)
    if (!silent) setErr(null)
    try {
      const [lb, fb, rc, cl, ss] = await Promise.all([
        apiFetch<LoanBook>('/api/cbs/reports/loan-book'),
        apiFetch<FDBook>('/api/cbs/reports/fd-book'),
        apiFetch<Recon>('/api/cbs/reports/reconciliation'),
        apiFetch<CustomerList>('/api/cbs/reports/customers'),
        apiFetch<SyncStatus>('/api/cbs/sync/status').catch(() => null as any),
      ])
      setLoan(lb); setFD(fb); setRecon(rc); setCust(cl); setSync(ss)
    } catch (e: any) {
      if (!silent) setErr(e?.message || 'Failed to load Udara data')
    } finally {
      if (!silent) setLoading(false)
    }
  }
  // Initial load, then ride the app-wide realtime layer: the 'cbs' change-feed topic
  // fires within ~4s of a snapshot sync, and useLiveData also refetches on window focus.
  useEffect(() => { load() }, [])
  useLiveData(() => load(true), { topics: ['cbs'] })

  const last = sync?.last_run
  const lastLabel = last?.finished_at
    ? `Live · Synced ${fmtDatetime(last.finished_at)}`
    : 'Not Yet Synced'

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'customers', label: 'Customers', badge: cust?.summary?.total },
    { key: 'loans', label: 'Loan Book', badge: loan?.summary?.accounts },
    { key: 'fd', label: 'Fixed Deposits', badge: fd?.summary?.accounts },
    { key: 'recon', label: 'Reconciliation', badge: recon ? (recon.unmatched_loans?.length ?? 0) + (recon.unmatched_fds?.length ?? 0) : undefined },
  ]

  return (
    <Page
      title="Udara"
      loading={loading && !loan}
      skeletonKpis={4}
      subtitle="Live view of the Udara360 core banking system: customers, loans, fixed deposits, and reconciliation"
      actions={
        <Badge variant={last?.status === 'ok' ? 'success' : 'default'} dot>{lastLabel}</Badge>
      }
    >
      <ErrBanner error={err} onRetry={load} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'overview' && <Overview loan={loan} fd={fd} recon={recon} cust={cust} loading={loading} />}
      {tab === 'customers' && <CustomerTab data={cust} loading={loading} onOpen={setOpenUdaraId} />}
      {tab === 'loans' && <LoanTab data={loan} loading={loading} onOpen={setOpenUdaraId} />}
      {tab === 'fd' && <FDTab data={fd} loading={loading} onOpen={setOpenUdaraId} />}
      {tab === 'recon' && <ReconTab data={recon} loading={loading} onOpen={setOpenUdaraId} />}

      <CustomerModal udaraId={openUdaraId} onClose={() => setOpenUdaraId(null)} />
    </Page>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────

function Overview({ loan, fd, recon, cust, loading }: { loan: LoanBook | null; fd: FDBook | null; recon: Recon | null; cust: CustomerList | null; loading: boolean }) {
  const unmatched = recon ? (recon.unmatched_loans?.length ?? 0) + (recon.unmatched_fds?.length ?? 0) : 0
  const cs = cust?.summary
  return (
    <>
      <div style={grid(220)}>
        <KpiCard label="Customers" value={fmtNum(cs?.total)} sub="on Udara360" icon="groups" accent={NAVY} loading={loading} />
        <KpiCard label="Loan Outstanding" value={fmtKobo(loan?.summary.outstanding_principal_kobo)} sub={`${fmtNum(loan?.summary.accounts)} loans`} icon="payments" accent={RED} loading={loading} />
        <KpiCard label="FD Principal" value={fmtKobo(fd?.summary.principal_kobo)} sub={`${fmtNum(fd?.summary.accounts)} deposits`} icon="savings" accent={GREEN} loading={loading} />
        <KpiCard label="Contact Captured" value={fmtNum(cs?.with_phone)} sub={`of ${fmtNum(cs?.total)} have a phone`} icon="contact_phone" accent={BLUE} loading={loading} />
      </div>

      <div style={{ ...grid(320), marginTop: SP[6] }}>
        <SectionCard title="Loan Book by Status">
          <BreakdownBars rows={(loan?.by_status || []).map(r => ({ label: r.status, count: r.count, amount: r.outstanding_kobo }))} total={loan?.summary.outstanding_principal_kobo || 0} tone={statusTone} />
        </SectionCard>
        <SectionCard title="Data Health">
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 10, margin: 0 }}>
            <dt style={{ color: TXT2 }}>Customers Linked to a Workspace Profile</dt><dd style={dd}>{fmtNum(cs?.linked)} / {fmtNum(cs?.total)}</dd>
            <dt style={{ color: TXT2 }}>Customers with an Email on File</dt><dd style={dd}>{fmtNum(cs?.with_email)}</dd>
            <dt style={{ color: TXT2 }}>Facilities Linked to Workspace</dt><dd style={dd}>{fmtNum((recon?.loans.matched || 0) + (recon?.fixed_deposits.matched || 0))}</dd>
            <dt style={{ color: TXT2 }}>Facilities Unmatched</dt><dd style={{ ...dd, color: unmatched ? AMBER : GREEN }}>{fmtNum(unmatched)}</dd>
          </dl>
        </SectionCard>
      </div>
    </>
  )
}

// ── Customers ─────────────────────────────────────────────────────────────────

function CustomerTab({ data, loading, onOpen }: { data: CustomerList | null; loading: boolean; onOpen: (cif: string) => void }) {
  const cols: TableCol[] = [
    { key: 'name', label: 'Customer', render: r => <span style={{ fontWeight: FW.medium }}>{r.name || '—'}</span> },
    { key: 'customer_type', label: 'Type', render: r => <span style={{ color: TXT2, fontSize: 12 }}>{r.customer_type || '—'}</span> },
    { key: 'phone', label: 'Phone', render: r => r.phone || <span style={{ color: TXT3 }}>—</span> },
    { key: 'email', label: 'Email', render: r => r.email || <span style={{ color: TXT3 }}>—</span> },
    { key: 'state', label: 'State', render: r => r.state || <span style={{ color: TXT3 }}>—</span> },
    { key: 'in_workspace', label: 'Workspace', render: r => r.in_workspace
        ? <span style={{ background: GREEN + '18', color: GREEN, padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: FW.semibold }}>{r.cust_id || 'Linked'}</span>
        : <span style={{ background: AMBER + '18', color: AMBER, padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: FW.semibold }}>Udara Only</span> },
    { key: 'card_count', label: 'Cards', align: 'right', render: r => fmtNum(r.card_count) },
    { key: 'loan_count', label: 'Loans', align: 'right', render: r => fmtNum(r.loan_count) },
    { key: 'fd_count', label: 'FDs', align: 'right', render: r => fmtNum(r.fd_count) },
  ]
  const s = data?.summary
  return (
    <>
      <div style={grid(220)}>
        <KpiCard label="Customers" value={fmtNum(s?.total)} sub="on Udara360" icon="groups" accent={NAVY} loading={loading} />
        <KpiCard label="Linked to Workspace" value={`${fmtNum(s?.linked)} / ${fmtNum(s?.total)}`} sub="resolve to a CUST profile" icon="link" accent={s && s.linked === s.total ? GREEN : AMBER} loading={loading} />
        <KpiCard label="With Phone" value={fmtNum(s?.with_phone)} icon="contact_phone" accent={BLUE} loading={loading} />
        <KpiCard label="With Email" value={fmtNum(s?.with_email)} icon="mail" accent={BLUE} loading={loading} />
      </div>
      <SectionCard title="Udara Customer Master" subtitle="Every customer on Udara360, with the contact detail Udara holds and their workspace link. Click a row for the full profile." padding={false} style={{ marginTop: SP[6] }}>
        <DataTable cols={cols} rows={data?.customers || []} loading={loading} keyFn={(r, i) => r.cbs_customer_id || i}
          onRowClick={r => r.cbs_customer_id && onOpen(r.cbs_customer_id)}
          searchKeys={['name', 'phone', 'email', 'state', 'cust_id', 'cbs_customer_id']} searchPlaceholder="Search customers…" pageSize={20} />
      </SectionCard>
    </>
  )
}

// ── Loan Book ─────────────────────────────────────────────────────────────────

function LoanTab({ data, loading, onOpen }: { data: LoanBook | null; loading: boolean; onOpen: (cif: string) => void }) {
  const cols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.cbs_account_number || '—'}</span> },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'outstanding_principal_kobo', label: 'Outstanding', align: 'right', render: r => fmtKobo(r.outstanding_principal_kobo) },
    { key: 'loan_amount_kobo', label: 'Disbursed', align: 'right', render: r => fmtKobo(r.loan_amount_kobo) },
    // What the borrower has actually paid, from the Udara general ledger. Everything
    // else on this row is the loan's own snapshot; this is the only observed fact.
    { key: 'repaid_principal_kobo', label: 'Repaid', align: 'right', render: r =>
        n(r.repayment_legs) > 0
          ? <span title={`${n(r.repayment_legs)} ledger posting(s)${r.last_repaid_on ? `, last ${fmtDate(r.last_repaid_on)}` : ''}${n(r.repaid_interest_kobo) > 0 ? ` · interest ${fmtKobo(r.repaid_interest_kobo)}` : ''}`}
                  style={{ color: GREEN, fontWeight: FW.semibold }}>{fmtKobo(r.repaid_principal_kobo)}</span>
          : <span style={{ color: TXT3 }}>—</span> },
    { key: 'interest_rate', label: 'Rate', align: 'right', render: r => fmtPct(r.interest_rate, 1) },
    { key: 'date_booked', label: 'Booked', render: r => fmtDate(r.date_booked ?? r.start_date) },
    { key: 'maturity_date', label: 'Maturity', render: r => fmtDate(r.maturity_date) },
    { key: 'officer_name', label: 'Officer' },
    { key: 'is_restructure', label: 'Lineage', render: r => r.is_restructure
        ? <LineageTag kind="restructure" prior={r.prior_account} priorAmount={r.prior_amount_kobo} />
        : <span style={{ color: TXT3 }}>—</span> },
  ]
  return (
    <>
      <div style={grid(200)}>
        <KpiCard label="Accounts" value={fmtNum(data?.summary.accounts)} icon="request_quote" accent={NAVY} loading={loading} />
        <KpiCard label="Disbursed" value={fmtKobo(data?.summary.disbursed_kobo)} icon="north_east" accent={BLUE} loading={loading} />
        <KpiCard label="Outstanding Principal" value={fmtKobo(data?.summary.outstanding_principal_kobo)} icon="payments" accent={RED} loading={loading} />
        <KpiCard label="Outstanding Interest" value={fmtKobo(data?.summary.outstanding_interest_kobo)} icon="percent" accent={AMBER} loading={loading} />
      </div>
      <div style={{ ...grid(320), marginTop: SP[6], marginBottom: SP[6] }}>
        <SectionCard title="By Status">
          <BreakdownBars rows={(data?.by_status || []).map(r => ({ label: r.status, count: r.count, amount: r.outstanding_kobo }))} total={data?.summary.outstanding_principal_kobo || 0} tone={statusTone} />
        </SectionCard>
        <SectionCard title="By Product">
          <BreakdownBars rows={(data?.by_product || []).map(r => ({ label: r.product_name, count: r.count, amount: r.outstanding_kobo }))} total={data?.summary.outstanding_principal_kobo || 0} tone={() => NAVY} />
        </SectionCard>
      </div>
      <SectionCard title="Loan Accounts" subtitle="Click a loan for the full Udara + workspace customer profile." padding={false}>
        <DataTable cols={cols} rows={data?.loans || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i}
          onRowClick={r => r.cbs_customer_id && onOpen(r.cbs_customer_id)}
          searchKeys={['cbs_account_number', 'customer_name', 'product_name', 'status', 'officer_name']} searchPlaceholder="Search loans…" pageSize={15} />
      </SectionCard>
    </>
  )
}

// ── Fixed Deposits ────────────────────────────────────────────────────────────

function FDTab({ data, loading, onOpen }: { data: FDBook | null; loading: boolean; onOpen: (cif: string) => void }) {
  const cols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.cbs_account_number || '—'}</span> },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => fmtKobo(r.principal_kobo) },
    { key: 'accrued_interest_kobo', label: 'Accrued', align: 'right', render: r => fmtKobo(r.accrued_interest_kobo) },
    { key: 'interest_rate', label: 'Rate', align: 'right', render: r => fmtPct(r.interest_rate, 1) },
    { key: 'date_booked', label: 'Booked', render: r => fmtDate(r.date_booked ?? r.commencement_date) },
    { key: 'maturity_date', label: 'Maturity', render: r => fmtDate(r.maturity_date) },
    { key: 'officer_name', label: 'Officer', render: r => (r.officer_name || '').trim() || '—' },
    { key: 'is_rollover', label: 'Lineage', render: r => r.is_rollover
        ? <LineageTag kind="rollover" prior={r.prior_account} />
        : r.lineage_ambiguous_reason
          // The chain could not be drawn — one deposit split into several, or several
          // merged into one. Shown rather than left blank, because a blank here reads as
          // "fresh money" and this is the one case where we know it might not be.
          ? <span
              title={`Rollover chain unclear: ${r.lineage_ambiguous_reason}. This deposit is not counted as a rollover, so some of it may be money that was already on the book.`}
              style={{ background: AMBER + '18', color: AMBER, padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: FW.semibold, whiteSpace: 'nowrap' }}
            >
              Chain Unclear
            </span>
          : <span style={{ color: TXT3 }}>—</span> },
  ]
  return (
    <>
      <div style={grid(200)}>
        <KpiCard label="Accounts" value={fmtNum(data?.summary.accounts)} icon="savings" accent={NAVY} loading={loading} />
        <KpiCard label="Principal" value={fmtKobo(data?.summary.principal_kobo)} icon="account_balance" accent={GREEN} loading={loading} />
        <KpiCard label="Accrued Interest" value={fmtKobo(data?.summary.accrued_kobo)} icon="percent" accent={AMBER} loading={loading} />
        <KpiCard label="Ledger Balance" value={fmtKobo(data?.summary.ledger_kobo)} icon="account_balance_wallet" accent={BLUE} loading={loading} />
      </div>
      <div style={{ ...grid(320), marginTop: SP[6], marginBottom: SP[6] }}>
        <SectionCard title="Maturity Ladder" subtitle="FDs maturing by month">
          <BreakdownBars rows={(data?.maturity_ladder || []).map(r => ({ label: r.bucket, count: r.count, amount: r.principal_kobo }))} total={data?.summary.principal_kobo || 0} tone={() => BLUE} />
        </SectionCard>
        <SectionCard title="By Product">
          <BreakdownBars rows={(data?.by_product || []).map(r => ({ label: r.product_name, count: r.count, amount: r.principal_kobo }))} total={data?.summary.principal_kobo || 0} tone={() => NAVY} />
        </SectionCard>
      </div>
      <SectionCard title="Fixed Deposit Accounts" subtitle="Click a deposit for the full Udara + workspace customer profile." padding={false}>
        <DataTable cols={cols} rows={data?.fixed_deposits || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i}
          onRowClick={r => r.cbs_customer_id && onOpen(r.cbs_customer_id)}
          searchKeys={['cbs_account_number', 'customer_name', 'product_name', 'status', 'officer_name']} searchPlaceholder="Search fixed deposits…" pageSize={15} />
      </SectionCard>
    </>
  )
}

// ── Reconciliation ────────────────────────────────────────────────────────────

function ReconTab({ data, loading, onOpen }: { data: Recon | null; loading: boolean; onOpen: (cif: string) => void }) {
  const loanCols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account' },
    { key: 'customer_name', label: 'Customer (per CBS)', render: r => r.customer_name || '—' },
    { key: 'cbs_customer_id', label: 'Udara ID' },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'outstanding_principal_kobo', label: 'Outstanding', align: 'right', render: r => fmtKobo(r.outstanding_principal_kobo) },
  ]
  const fdCols: TableCol[] = [
    { key: 'cbs_account_number', label: 'Account' },
    { key: 'customer_name', label: 'Customer (per CBS)', render: r => r.customer_name || '—' },
    { key: 'cbs_customer_id', label: 'Udara ID' },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <StatusTag s={r.status} /> },
    { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => fmtKobo(r.principal_kobo) },
  ]
  const lt = data?.loans, ft = data?.fixed_deposits
  return (
    <>
      <div style={{ background: AMBER + '12', border: `1px solid ${AMBER}40`, borderRadius: 10, padding: SP[4], marginBottom: SP[6], color: TXT2, fontSize: 13 }}>
        Accounts are matched to the workspace customer master through the party crosswalk. The ones below belong to
        customers not yet linked, likely created directly in Udara. Add them to the master (or link manually) so
        overlay data (officers, notes, approvals) and workflows attach to the right customer.
      </div>
      <div style={grid(220)}>
        <KpiCard label="Loans Linked" value={`${fmtNum(lt?.matched)} / ${fmtNum(lt?.cbs_total)}`} sub="matched to workspace" icon="link" accent={lt && lt.matched === lt.cbs_total ? GREEN : AMBER} loading={loading} />
        <KpiCard label="Loans Unmatched" value={fmtNum(data?.unmatched_loans?.length)} icon="link_off" accent={RED} loading={loading} />
        <KpiCard label="FDs Linked" value={`${fmtNum(ft?.matched)} / ${fmtNum(ft?.cbs_total)}`} sub="matched to workspace" icon="link" accent={ft && ft.matched === ft.cbs_total ? GREEN : AMBER} loading={loading} />
        <KpiCard label="FDs Unmatched" value={fmtNum(data?.unmatched_fds?.length)} icon="link_off" accent={RED} loading={loading} />
      </div>
      <div style={{ marginTop: SP[6] }}>
        <SectionCard title="Unmatched Loans" padding={false} style={{ marginBottom: SP[6] }}>
          {(!loading && data && (data.unmatched_loans?.length ?? 0) === 0)
            ? <EmptyState icon="check_circle" title="All Loans Linked" description="Every CBS loan maps to a workspace record." />
            : <DataTable cols={loanCols} rows={data?.unmatched_loans || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i} onRowClick={r => r.cbs_customer_id && onOpen(r.cbs_customer_id)} searchKeys={['cbs_account_number', 'cbs_customer_id', 'product_name']} pageSize={10} />}
        </SectionCard>
        <SectionCard title="Unmatched Fixed Deposits" padding={false}>
          {(!loading && data && (data.unmatched_fds?.length ?? 0) === 0)
            ? <EmptyState icon="check_circle" title="All FDs Linked" description="Every CBS fixed deposit maps to a workspace record." />
            : <DataTable cols={fdCols} rows={data?.unmatched_fds || []} loading={loading} keyFn={(r, i) => r.cbs_account_number || i} onRowClick={r => r.cbs_customer_id && onOpen(r.cbs_customer_id)} searchKeys={['cbs_account_number', 'cbs_customer_id', 'product_name']} pageSize={10} />}
        </SectionCard>
      </div>
    </>
  )
}

// ── Customer detail modal ───────────────────────────────────────────────────

function CustomerModal({ udaraId, onClose }: { udaraId: string | null; onClose: () => void }) {
  const [data, setData] = useState<CustomerDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!udaraId) { setData(null); return }
    let live = true
    setLoading(true); setErr(null); setData(null)
    apiFetch<CustomerDetail>(`/api/cbs/reports/customer/${encodeURIComponent(udaraId)}`)
      .then(d => { if (live) setData(d) })
      .catch(e => { if (live) setErr(e?.message || 'Failed to load customer') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [udaraId])

  const c = data?.cbs || {}
  const w = data?.workspace || {}
  const title = (c.name as string) || 'Customer'

  return (
    <Modal open={!!udaraId} onClose={onClose} title={title} width={760} maxHeight="82vh">
      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: SP[6] }}><Spinner /></div>}
      {err && <div style={{ color: RED, fontSize: 13, padding: SP[3] }}>{err}</div>}
      {data && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[5] }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {c.customer_type && <Badge variant="default">{c.customer_type}</Badge>}
            {data.in_workspace
              ? <Badge variant="success" dot>In Workspace · {w.cust_id}</Badge>
              : <Badge variant="warning" dot>Udara Only: No Workspace Profile Yet</Badge>}
            <span style={{ color: TXT3, fontSize: 12, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>Udara ID {c.cbs_customer_id}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: SP[5] }}>
            <Panel title="On Udara360" accent={NAVY}>
              <Field label="Phone" value={c.phone} />
              <Field label="Email" value={c.email} />
              <Field label="Address" value={c.address} />
              <Field label="State / LGA" value={[c.state, c.lga].filter(Boolean).join(' · ')} />
              <Field label="BVN" value={c.bvn} />
              <Field label="NIN" value={c.nin} />
              <Field label="Date of Birth" value={c.date_of_birth ? fmtDate(c.date_of_birth) : ''} />
              <Field label="Gender" value={c.gender} />
              {c.customer_type === 'Individual'
                ? <Field label="Occupation" value={[c.occupation, c.employer_name].filter(Boolean).join(' · ')} />
                : <Field label="Business" value={[c.nature_of_business, c.registration_number].filter(Boolean).join(' · ')} />}
              {c.customer_type !== 'Individual' && <Field label="Contact Person" value={[c.contact_person_name, c.contact_person_phone].filter(Boolean).join(' · ')} />}
              {c.nok_name && <Field label="Next of Kin" value={[c.nok_name, c.nok_relationship, c.nok_phone].filter(Boolean).join(' · ')} />}
            </Panel>

            <Panel title="In the Workspace" accent={GREEN}>
              {data.in_workspace ? (
                <>
                  <Field label="Customer ID" value={w.cust_id} />
                  <Field label="Name" value={w.party_name} />
                  <Field label="Type" value={w.party_type} />
                  <Field label="Cards Held" value={fmtNum(w.card_count)} />
                  <Field label="Primary Phone" value={w.primary_phone} />
                  <Field label="Primary Email" value={w.primary_email} />
                  <Field label="BVN" value={w.party_bvn} />
                </>
              ) : (
                <div style={{ color: TXT2, fontSize: 13, lineHeight: 1.5 }}>
                  This Udara customer has no linked workspace profile yet. Their contact detail above is captured from
                  Udara and can be used to create a customer record.
                </div>
              )}
            </Panel>
          </div>

          {(data.loans?.length > 0 || data.fixed_deposits?.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
              {data.loans?.length > 0 && (
                <FacilityList title="Loans" rows={data.loans.map(l => ({
                  acct: l.cbs_account_number, product: l.product_name, status: l.status,
                  amount: l.outstanding_principal_kobo, sub: l.officer_name,
                  lineage: l.is_restructure ? 'restructure' : undefined,
                  prior: l.prior_account, priorAmount: l.prior_amount_kobo,
                  superseded: l.was_restructured_into,
                }))} />
              )}
              {data.fixed_deposits?.length > 0 && (
                <FacilityList title="Fixed Deposits" rows={data.fixed_deposits.map(f => ({
                  acct: f.cbs_account_number, product: f.product_name, status: f.status,
                  amount: f.principal_kobo, sub: f.maturity_date ? `matures ${fmtDate(f.maturity_date)}` : '',
                  lineage: f.is_rollover ? 'rollover' : undefined,
                  prior: f.prior_account,
                  superseded: f.was_rolled_into,
                }))} />
              )}
            </div>
          )}

          {/* Money actually received, straight off the Udara general ledger. Held back
              from every screen until now because these postings carry no workspace loan
              application to join to. */}
          {data.repayments?.length > 0 && (
            <div style={{ marginTop: SP[3] }}>
              <Panel title="Repayments Received" accent={GREEN}>
                {data.repayments.map((p: Money, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: TXT2 }}>
                      {fmtDate(p.financial_date)}
                      <span style={{ color: TXT3 }}>
                        {' · '}{p.component === 'interest' ? 'Interest' : 'Principal'}
                        {p.posting_reference ? ` · ${p.posting_reference}` : ''}
                      </span>
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: FW.semibold, color: GREEN }}>
                      {fmtKobo(p.amount_kobo)}
                    </span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--bdr)', paddingTop: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: FW.semibold, color: TXT2 }}>Total Received</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: FW.semibold }}>
                    {fmtKobo(data.repayments.reduce((s: number, p: Money) => s + n(p.amount_kobo), 0))}
                  </span>
                </div>
              </Panel>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function Panel({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: accent + '10', color: accent, fontWeight: FW.semibold, fontSize: 12, letterSpacing: 0.3, textTransform: 'uppercase', borderBottom: `1px solid ${accent}22` }}>{title}</div>
      <div style={{ padding: SP[3], display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: any }) {
  const v = value === 0 || value ? String(value) : ''
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, fontSize: 13 }}>
      <span style={{ color: TXT3 }}>{label}</span>
      <span style={{ color: v ? 'var(--txt)' : TXT3, fontWeight: v ? FW.medium : FW.normal, wordBreak: 'break-word' }}>{v || '—'}</span>
    </div>
  )
}

// LineageTag marks a facility that continues an earlier one, or was itself continued.
// This is the answer to "why does this customer have two loans?" — usually they do not:
// they have one loan, twice. Amber for the live successor, which is what people act on;
// grey for the retired predecessor.
function LineageTag({ kind, prior, priorAmount }: { kind: 'restructure' | 'rollover' | 'superseded'; prior?: any; priorAmount?: any }) {
  const meta = {
    restructure: { label: 'Restructured', color: AMBER, tip: prior ? `Continues ${prior}${priorAmount ? ` · originally ${fmtKobo(priorAmount)}` : ''}: existing debt on new terms, not new lending` : 'Existing debt on new terms' },
    rollover:    { label: 'Rollover',     color: AMBER, tip: prior ? `Continues ${prior}: the same money rolled, not a new deposit` : 'The same money rolled forward' },
    superseded:  { label: 'Superseded',   color: TXT3,  tip: 'Replaced by a later facility for the same customer' },
  }[kind]
  return (
    <span title={meta.tip} style={{
      background: meta.color === TXT3 ? 'var(--chip-bg)' : meta.color + '18',
      color: meta.color, padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: FW.semibold, whiteSpace: 'nowrap', cursor: 'help',
    }}>{meta.label}</span>
  )
}

function FacilityList({ title, rows }: { title: string; rows: { acct: any; product: any; status: any; amount: any; sub: any; lineage?: any; prior?: any; priorAmount?: any; superseded?: any }[] }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: FW.semibold, color: TXT2, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r, i) => (
          <div key={r.acct || i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: TXT2 }}>{r.acct}</span>
            <span style={{ fontWeight: FW.medium }}>{r.product}</span>
            <StatusTag s={r.status} />
            {r.lineage && <LineageTag kind={r.lineage} prior={r.prior} priorAmount={r.priorAmount} />}
            {r.superseded && !r.lineage && <LineageTag kind="superseded" />}
            <span style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: FW.semibold }}>{fmtKobo(r.amount)}</span>
              {r.sub && <span style={{ color: TXT3, fontSize: 11 }}>{r.sub}</span>}
            </span>
            {r.prior && (
              <div style={{ flexBasis: '100%', color: TXT3, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                continues {r.prior}{r.priorAmount ? ` · originally ${fmtKobo(r.priorAmount)}` : ''}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Shared ────────────────────────────────────────────────────────────────────

function grid(min: number): React.CSSProperties {
  return { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: SP[4] }
}

function BreakdownBars({ rows, tone }: { rows: { label: string; count: number; amount: number }[]; tone: (label: string) => string; total: number }) {
  if (!rows.length) return <EmptyState icon="inbox" title="No Data" />
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
