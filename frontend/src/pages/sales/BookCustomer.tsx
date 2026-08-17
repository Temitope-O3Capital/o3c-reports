import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, Sk, Button } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, n } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// The account officer's view of one customer.
//
// Sales used to link straight into Customer 360 at /customers/:cif. That page is
// owned by the Contact Centre and is built around the question "why is this person
// calling" — tickets and call history first. It also threw the sidebar into the Call
// Center section, so an officer working their book was bounced out of Sales on every
// row click and had to navigate back in.
//
// The relationship questions are different ones: what do they hold, what have I got
// in flight for them, what should I sell them next, and is anything about to go
// wrong. Same data, same /api/sales/book/{cif} endpoint — which already scopes to the
// caller's own book — arranged around the officer's job rather than the agent's.

interface Customer {
  cif: string
  full_name: string
  email: string
  phone: string
  state: string
  city: string
  acquired_on: string | null
  acquired_on_source: string
  officer_id: number | null
  officer_name: string | null
}
interface Account {
  account_no: string; product_name: string; card_program: string; status: string
  opened_date: string | null; card_limit: number; current_dr_balance: number; days_overdue: number
}
interface Loan {
  cbs_account_number: string; product_name: string; status: string
  loan_amount_kobo: number; outstanding_principal_kobo: number
  outstanding_interest_kobo: number; outstanding_fee_kobo: number
  interest_rate: number; start_date: string | null; maturity_date: string | null
}
interface FixedDeposit {
  cbs_account_number: string; product_name: string; status: string
  principal_kobo: number; accrued_interest_kobo: number; interest_rate: number
  commencement_date: string | null; maturity_date: string | null
}
interface Application {
  id: number; reference: string; product_type: string; stage: string; status: string
  amount_requested_kobo: number; amount_approved_kobo: number; created_at: string
}
interface Ticket {
  id: number; ticket_ref: string; subject: string; status: string; priority: string; created_at: string
}
interface RecentCall {
  id: number; called_at: string; direction: string; duration_seconds: number
  agent_name: string; outcome: string; purpose: string
}
interface Profile {
  customer: Customer
  accounts: Account[]
  loans: Loan[]
  fixed_deposits: FixedDeposit[]
  applications: Application[]
  tickets: Ticket[]
  recent_calls: RecentCall[]
}

// Call length as m:ss — helpdesk_calls stores it in whole seconds.
function fmtDuration(sec: number) {
  if (!sec || sec < 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// How firm the acquisition date is. cust_file carries no date, so most of the book
// has one inferred from the first account — saying which is the difference between a
// fact and a guess, and the officer is the person who can correct it.
const SOURCE_LABEL: Record<string, string> = {
  account_created: 'recorded',
  first_account: 'inferred from first account',
  first_seen: 'first seen in feed',
  unknown: 'unknown',
}

function Pill({ text, tone }: { text: string; tone: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: RADIUS.sm,
      background: `${tone}1A`, color: tone, fontSize: TEXT.xs, fontWeight: FW.bold,
      whiteSpace: 'nowrap',
    }}>{text}</span>
  )
}

function statusTone(s: string) {
  const v = (s || '').toLowerCase()
  if (['open', 'active', 'approved', 'booked'].includes(v)) return GREEN
  if (['closed', 'declined', 'cancelled', 'lost'].includes(v)) return RED
  return AMBER
}

export default function SalesBookCustomer() {
  const { cif = '' } = useParams()
  const navigate = useNavigate()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<{ data: Profile }>(`/api/sales/book/${encodeURIComponent(cif)}`)
      setProfile(res.data)
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load this customer')
    } finally {
      setLoading(false)
    }
  }, [cif])

  useEffect(() => { load() }, [load])

  const c = profile?.customer
  const loans = profile?.loans ?? []
  const fds = profile?.fixed_deposits ?? []
  const accounts = profile?.accounts ?? []
  const apps = profile?.applications ?? []
  const tickets = profile?.tickets ?? []
  const recentCalls = profile?.recent_calls ?? []

  const cardBalance = accounts.reduce((s, a) => s + n(a.current_dr_balance), 0)
  const outstanding = loans.reduce(
    (s, l) => s + n(l.outstanding_principal_kobo) + n(l.outstanding_interest_kobo) + n(l.outstanding_fee_kobo), 0)
  const fdPrincipal = fds.reduce((s, f) => s + n(f.principal_kobo), 0)
  const maxDpd = accounts.reduce((s, a) => Math.max(s, n(a.days_overdue)), 0)
  const openApps = apps.filter(a => !['booked', 'declined', 'cancelled'].includes((a.stage || '').toLowerCase()))

  const ACCOUNT_COLS: TableCol<Account>[] = [
    { key: 'account_no', label: 'Account', render: r => <span style={NUM}>{r.account_no}</span> },
    { key: 'product_name', label: 'Product' },
    { key: 'card_program', label: 'Programme' },
    { key: 'status', label: 'Status', render: r => <Pill text={r.status || '—'} tone={statusTone(r.status)} /> },
    { key: 'card_limit', label: 'Limit', align: 'right', render: r => <span style={NUM}>{fmtKobo(n(r.card_limit))}</span> },
    { key: 'current_dr_balance', label: 'Balance', align: 'right', render: r => <span style={NUM}>{fmtKobo(n(r.current_dr_balance))}</span> },
    {
      key: 'days_overdue', label: 'DPD', align: 'right',
      render: r => n(r.days_overdue) > 0
        ? <Pill text={`${fmtNum(r.days_overdue)}d`} tone={n(r.days_overdue) > 30 ? RED : AMBER} />
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    { key: 'opened_date', label: 'Opened', render: r => fmtDate(r.opened_date) },
  ]

  const LOAN_COLS: TableCol<Loan>[] = [
    { key: 'cbs_account_number', label: 'Account', render: r => <span style={NUM}>{r.cbs_account_number}</span> },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <Pill text={r.status || '—'} tone={statusTone(r.status)} /> },
    { key: 'loan_amount_kobo', label: 'Amount', align: 'right', render: r => <span style={NUM}>{fmtKobo(n(r.loan_amount_kobo))}</span> },
    {
      key: 'outstanding_principal_kobo', label: 'Outstanding', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(
        n(r.outstanding_principal_kobo) + n(r.outstanding_interest_kobo) + n(r.outstanding_fee_kobo))}</span>,
    },
    { key: 'interest_rate', label: 'Rate', align: 'right', render: r => r.interest_rate ? `${r.interest_rate}%` : '—' },
    { key: 'maturity_date', label: 'Matures', render: r => fmtDate(r.maturity_date) },
  ]

  const FD_COLS: TableCol<FixedDeposit>[] = [
    { key: 'cbs_account_number', label: 'Account', render: r => <span style={NUM}>{r.cbs_account_number}</span> },
    { key: 'product_name', label: 'Product' },
    { key: 'status', label: 'Status', render: r => <Pill text={r.status || '—'} tone={statusTone(r.status)} /> },
    { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => <span style={NUM}>{fmtKobo(n(r.principal_kobo))}</span> },
    { key: 'accrued_interest_kobo', label: 'Accrued', align: 'right', render: r => <span style={NUM}>{fmtKobo(n(r.accrued_interest_kobo))}</span> },
    { key: 'interest_rate', label: 'Rate', align: 'right', render: r => r.interest_rate ? `${r.interest_rate}%` : '—' },
    { key: 'maturity_date', label: 'Matures', render: r => fmtDate(r.maturity_date) },
  ]

  const APP_COLS: TableCol<Application>[] = [
    { key: 'reference', label: 'Reference', render: r => <span style={NUM}>{r.reference || r.id}</span> },
    { key: 'product_type', label: 'Product' },
    { key: 'stage', label: 'Stage', render: r => <Pill text={r.stage || '—'} tone={statusTone(r.stage)} /> },
    { key: 'amount_requested_kobo', label: 'Requested', align: 'right', render: r => <span style={NUM}>{fmtKobo(n(r.amount_requested_kobo))}</span> },
    { key: 'amount_approved_kobo', label: 'Approved', align: 'right', render: r => <span style={NUM}>{fmtKobo(n(r.amount_approved_kobo))}</span> },
    { key: 'created_at', label: 'Raised', render: r => fmtDate(r.created_at) },
  ]

  const CALL_COLS: TableCol<RecentCall>[] = [
    { key: 'called_at', label: 'When', render: r => fmtDate(r.called_at) },
    {
      key: 'direction', label: 'Direction',
      render: r => <Pill text={r.direction || '—'} tone={(r.direction || '').toLowerCase() === 'inbound' ? BLUE : GREEN} />,
    },
    { key: 'duration_seconds', label: 'Duration', align: 'right', render: r => <span style={NUM}>{fmtDuration(n(r.duration_seconds))}</span> },
    { key: 'agent_name', label: 'Agent', render: r => r.agent_name || '—' },
    { key: 'outcome', label: 'Outcome', render: r => r.outcome || '—' },
  ]

  const TICKET_COLS: TableCol<Ticket>[] = [
    { key: 'ticket_ref', label: 'Ref', render: r => <span style={NUM}>{r.ticket_ref || r.id}</span> },
    { key: 'subject', label: 'Subject' },
    { key: 'status', label: 'Status', render: r => <Pill text={r.status || '—'} tone={statusTone(r.status)} /> },
    { key: 'priority', label: 'Priority' },
    { key: 'created_at', label: 'Raised', render: r => fmtDate(r.created_at) },
  ]

  if (loading) {
    return <Page title="Customer" subtitle={cif}><Sk h={140} /><div style={{ height: SP[4] }} /><Sk h={280} /></Page>
  }

  if (err) {
    return (
      <Page title="Customer" subtitle={cif}>
        <div style={{ background: 'var(--card)', border: `1px solid ${RED}33`, borderLeft: `3px solid ${RED}`, borderRadius: RADIUS.xl, padding: '18px 20px' }}>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 6 }}>{err}</div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: 12 }}>
            A customer only opens for the officer who holds them, or for a sales head.
          </div>
          <Button onClick={() => navigate('/sales/book')}>Back to my book</Button>
        </div>
      </Page>
    )
  }

  return (
    <Page
      title={c?.full_name || cif}
      subtitle={`CIF ${cif}${c?.officer_name ? ` · Account officer: ${c.officer_name}` : ' · No account officer'}`}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={() => navigate('/sales/book')}>Back to book</Button>
          <Button onClick={() => navigate(`/sales/applications/new?cif=${encodeURIComponent(cif)}`)}>
            Raise application
          </Button>
        </div>
      }
    >
      {/* Identity strip. Contact details are the officer's working tools, so they sit
          above the product tables rather than behind a tab. */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '16px 18px', marginBottom: SP[4] }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 18 }}>
          {[
            ['Phone', c?.phone || '—'],
            ['Email', c?.email || '—'],
            ['Location', [c?.city, c?.state].filter(Boolean).join(', ') || '—'],
            ['Acquired', c?.acquired_on ? fmtDate(c.acquired_on) : '—'],
          ].map(([label, value]) => (
            <div key={label}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: TEXT.base, color: 'var(--txt)', wordBreak: 'break-word' }}>{value}</div>
            </div>
          ))}
        </div>
        {c?.acquired_on_source && c.acquired_on_source !== 'account_created' && (
          <div style={{ marginTop: 12, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            Acquisition date {SOURCE_LABEL[c.acquired_on_source] ?? c.acquired_on_source} — the customer feed carries no date of its own.
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Cards" value={fmtNum(accounts.length)} sub={fmtKobo(cardBalance)} />
        <KpiCard label="Loans" value={fmtNum(loans.length)} sub={`${fmtKobo(outstanding)} outstanding`} />
        <KpiCard label="Fixed deposits" value={fmtNum(fds.length)} sub={fmtKobo(fdPrincipal)} />
        <KpiCard label="Open applications" value={fmtNum(openApps.length)} sub={`${apps.length} all time`} />
        <KpiCard
          label="Worst DPD"
          value={maxDpd > 0 ? `${fmtNum(maxDpd)}d` : '—'}
          sub={maxDpd > 30 ? 'In arrears' : maxDpd > 0 ? 'Watch' : 'Current'}
          accent={maxDpd > 30 ? RED : maxDpd > 0 ? AMBER : GREEN}
        />
      </div>

      <SectionCard title="Cards" badge={accounts.length} padding={false}>
        <DataTable cols={ACCOUNT_COLS} rows={accounts} keyFn={r => r.account_no} emptyText="No cards on this customer" />
      </SectionCard>

      <div style={{ height: SP[4] }} />
      <SectionCard title="Loans" badge={loans.length} padding={false}>
        <DataTable cols={LOAN_COLS} rows={loans} keyFn={r => r.cbs_account_number} emptyText="No loans in Udara for this customer" />
      </SectionCard>

      <div style={{ height: SP[4] }} />
      <SectionCard title="Fixed deposits" badge={fds.length} padding={false}>
        <DataTable cols={FD_COLS} rows={fds} keyFn={r => r.cbs_account_number} emptyText="No fixed deposits in Udara for this customer" />
      </SectionCard>

      <div style={{ height: SP[4] }} />
      <SectionCard title="Applications" badge={apps.length} padding={false}>
        <DataTable
          cols={APP_COLS}
          rows={apps}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/sales/applications/${r.id}`)}
          emptyText="Nothing raised for this customer yet"
        />
      </SectionCard>

      {/* Recent calls: telephony matched to this person by phone (last 10 digits),
          across every card they hold. Context for the officer's next conversation. */}
      <div style={{ height: SP[4] }} />
      <SectionCard title="Recent calls" badge={recentCalls.length} padding={false}>
        <DataTable cols={CALL_COLS} rows={recentCalls} keyFn={r => r.id} emptyText="No calls logged for this customer" />
      </SectionCard>

      {/* Support history is context, not the officer's queue — hence last, and only
          when there is something to show. */}
      {tickets.length > 0 && (
        <>
          <div style={{ height: SP[4] }} />
          <SectionCard title="Support history" badge={tickets.length} padding={false}>
            <DataTable cols={TICKET_COLS} rows={tickets} keyFn={r => r.id} emptyText="No tickets" />
          </SectionCard>
        </>
      )}

      <div style={{ marginTop: SP[5], fontSize: TEXT.xs, color: 'var(--txt3)' }}>
        Loans and fixed deposits come from Udara; cards and identity from the customer feed.
        {' '}
        <button
          onClick={() => navigate(`/customers/${encodeURIComponent(cif)}`)}
          style={{ background: 'none', border: 'none', color: BLUE, cursor: 'pointer', padding: 0, font: 'inherit' }}
        >
          Open the full 360° view →
        </button>
      </div>
    </Page>
  )
}
