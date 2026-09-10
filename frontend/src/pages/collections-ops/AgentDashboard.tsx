import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LogPaymentModal } from '../../components/LogPaymentModal'
import { BatchPaymentModal } from '../../components/BatchPaymentModal'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKoboExact, fmtNum, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'
import { WorkspaceHero, MyDaySection, MyDayTile, PresenceControl, HeroButton, LiveBadge, myUserId, relTime } from '../../components/MyWorkspace'
import { TierBadge, PctBar, tierFromPct } from '../../components/TierBadge'
import { NameCell } from '../../components/UI'

// ── Types ─────────────────────────────────────────────────────────────────────

// Shape returned by GET /api/collections-ops/agent-dashboard
interface AgentRow {
  id: number
  full_name: string
  assigned: number
  contacts_today: number
  ptps_today: number
  ptps_secured_today: number
  ptps_honoured_today: number
  payments_today: number
  collected_today_kobo: number
  portfolio_kobo: number
}

// Shape returned by GET /api/collections-ops/queue. Billing fields (credit_limit,
// min_payment, last_payment_amount) are NAIRA — ×100 for kobo formatters.
interface QueueRow {
  id: number             // assignment id — used as the path param for /contact
  account_cif: string
  customer_name: string | null
  agent_name: string | null
  dpd_bucket: string | null
  outstanding_kobo: number
  current_stage: string | null
  last_contact_at: string | null
  credit_limit: number | null
  min_payment: number | null
  last_payment_amount: number | null
}

// Shape returned by GET /api/collections-ops/promises — used only to enrich the
// PTP counters (due-today / overdue). Read defensively; a failure here must never
// blank the station, so it's fetched outside the main Promise.all.
interface PromiseRow {
  id: number
  account_cif: string
  customer_name: string | null
  outstanding_kobo: number
  promise_amount_kobo: number
  promise_date: string
  status: string          // 'Pending' | 'Kept' | 'Broken'
  agent_name: string | null
  created_at: string
}

const CONTACT_TYPES = [
  { value: 'call',     label: 'Call',   icon: 'call' },
  { value: 'sms',      label: 'SMS',    icon: 'sms' },
  { value: 'email',    label: 'Email',  icon: 'mail' },
  { value: 'visit',    label: 'Visit',  icon: 'directions_walk' },
]

const OUTCOMES = [
  { value: 'reached',      label: 'Reached' },
  { value: 'not_reached',  label: 'Not Reached' },
  { value: 'ptp',          label: 'Promise to Pay' },
  { value: 'broken_ptp',   label: 'Promise Broken' },
  { value: 'wrong_number', label: 'Wrong Number' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function dpdColour(bucket: string | null): string {
  if (!bucket) return GREEN
  if (bucket === '91-180' || bucket === '181-360' || bucket === '360+' || bucket === '90+') return '#7F1D1D'
  if (bucket.startsWith('61')) return RED
  if (bucket.startsWith('31')) return '#EA580C'
  if (bucket.startsWith('1'))  return AMBER
  return GREEN
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AgentDashboard() {
  const navigate = useNavigate()
  const [agents,   setAgents]   = useState<AgentRow[]>([])
  const [queue,    setQueue]    = useState<QueueRow[]>([])
  const [promises, setPromises] = useState<PromiseRow[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [status,   setStatus]   = useState('available')

  // Log-contact modal
  const [logRow,       setLogRow]       = useState<QueueRow | null>(null)
  const [contactType,  setContactType]  = useState('call')
  const [outcome,      setOutcome]      = useState('reached')
  const [notes,        setNotes]        = useState('')
  const [logging,      setLogging]      = useState(false)

  // Log-payment modal
  const [payRow, setPayRow] = useState<QueueRow | null>(null)

  // Batch payment upload
  const [batchOpen, setBatchOpen] = useState(false)

  const load = useCallback(async (silent = false) => {
    setError(null)
    try {
      // The station is live — every figure is CURRENT_DATE-based on the server, so there
      // is no date filter here.
      const [aRes, qRes] = await Promise.all([
        apiFetch<{ data: AgentRow[] }>(`/api/collections-ops/agent-dashboard`),
        apiFetch<{ data: QueueRow[] }>(`/api/collections-ops/queue?limit=100`),
      ])
      setAgents(Array.isArray(aRes.data) ? aRes.data : [])
      setQueue(Array.isArray(qRes.data) ? qRes.data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }

    // Promises are a best-effort enrichment for the PTP counters. Fetch them
    // separately (no date filter — overdue promises can predate the range) so a
    // failure or empty payload degrades gracefully rather than breaking the load.
    try {
      const pRes = await apiFetch<{ data: PromiseRow[] }>(`/api/collections-ops/promises?limit=200`)
      setPromises(Array.isArray(pRes.data) ? pRes.data : [])
    } catch { /* tolerate — PTP counters fall back to the dashboard row */ }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections', 'loans'] })

  const changeStatus = useCallback(async (s: string) => {
    setStatus(s)
    const uid = myUserId()
    if (!uid) return
    try { await apiFetch(`/api/helpdesk/agents/${uid}/status`, { method: 'PUT', body: JSON.stringify({ status: s }) }) }
    catch (e: any) { toast.error(e?.message || 'Could not update status') }
  }, [])

  async function handleLogContact() {
    if (!logRow) return
    setLogging(true)
    try {
      await apiPost(`/api/collections-ops/${logRow.id}/contact`, {
        contact_type: contactType,
        outcome,
        notes,
      })
      toast.success('Contact logged')
      setLogRow(null)
      setNotes('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setLogging(false) }
  }

  // Personal view: pick the signed-in agent's own row out of the array (the dashboard
  // scopes a non-head to just their own row).
  const uid = myUserId()
  const myRow = agents.find(a => a.id === uid) ?? agents[0] ?? null
  const myAssigned  = Number(myRow?.assigned ?? 0)
  const myContacts  = Number(myRow?.contacts_today ?? 0)
  const myPtps      = Number(myRow?.ptps_secured_today ?? myRow?.ptps_today ?? 0)
  const myPtpsKept  = Number(myRow?.ptps_honoured_today ?? 0)
  const myCollected = Number(myRow?.collected_today_kobo ?? 0)
  const myPayments  = Number(myRow?.payments_today ?? 0)
  const myPortfolio = Number(myRow?.portfolio_kobo ?? 0)
  const untouched = Math.max(0, myAssigned - myContacts)

  // PTPs to chase, derived from the promises feed. The list endpoint isn't
  // SQL-scoped to the agent, so scope client-side by name when we can identify
  // ourselves; fall back to the whole list otherwise. "To chase" = a pending
  // promise whose date is today or already past (unkept).
  const myName = (myRow?.full_name ?? '').trim().toLowerCase()
  const myPromises = myName
    ? promises.filter(p => (p.agent_name ?? '').trim().toLowerCase() === myName)
    : promises
  const t = today()
  const pendingPromises = myPromises.filter(p => p.status === 'Pending')
  const ptpDueToday = pendingPromises.filter(p => (p.promise_date ?? '').slice(0, 10) === t).length
  const ptpOverdue  = pendingPromises.filter(p => (p.promise_date ?? '').slice(0, 10) < t).length
  // Prefer the promises-derived count; if the feed is empty/unavailable, fall
  // back to the dashboard row (PTPs booked today that aren't yet honoured).
  const ptpsToChase = promises.length ? ptpDueToday + ptpOverdue : Math.max(0, myPtps - myPtpsKept)

  // Same column shape as the Credit Portfolio, so the officer's own queue reads like the
  // book they work — only the action buttons differ (Log Contact / Log Payment). Billing
  // fields are NAIRA; ×100 to kobo. % Paid = last payment against the minimum due.
  const queueCols: TableCol<QueueRow>[] = [
    {
      key: 'account_cif', label: 'Account / CIF',
      render: r => <NameCell name={r.customer_name || r.account_cif} sub={r.account_cif} />,
    },
    {
      key: 'dpd_bucket', label: 'DPD', align: 'center',
      render: r => {
        const c = dpdColour(r.dpd_bucket)
        return <span style={{ display: 'inline-block', minWidth: 44, textAlign: 'center', padding: '2px 9px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.bold, color: c, background: `${c}18`, border: `1px solid ${c}3A` }}>{r.dpd_bucket ?? 'Current'}</span>
      },
    },
    { key: 'credit_limit', label: 'LOC / Principal', align: 'right', render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.credit_limit != null ? fmtKoboExact(Math.round(r.credit_limit * 100)) : '—'}</span> },
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', render: r => <span style={{ ...NUM, fontWeight: 700, color: 'var(--txt)' }}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    { key: 'min_payment', label: 'Min Repayment', align: 'right', render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.min_payment != null ? fmtKoboExact(Math.round(r.min_payment * 100)) : '—'}</span> },
    { key: 'last_payment_amount', label: 'Amount Paid', align: 'right', render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: (r.last_payment_amount ?? 0) > 0 ? GREEN : 'var(--txt3)' }}>{r.last_payment_amount != null ? fmtKoboExact(Math.round(r.last_payment_amount * 100)) : '—'}</span> },
    {
      key: 'min_payment', label: '% Paid', align: 'right',
      render: r => {
        const pct = r.min_payment && r.min_payment > 0 ? Math.min(Math.round(((r.last_payment_amount ?? 0) / r.min_payment) * 100), 100) : 0
        return <PctBar pct={pct} tier={tierFromPct(pct)} />
      },
    },
    {
      key: 'account_cif', label: 'Tier',
      render: r => {
        const pct = r.min_payment && r.min_payment > 0 ? Math.min(Math.round(((r.last_payment_amount ?? 0) / r.min_payment) * 100), 100) : 0
        return <TierBadge tier={tierFromPct(pct)} />
      },
    },
    {
      key: 'current_stage', label: 'Stage',
      render: r => <span style={{ fontSize: TEXT.sm, color: r.current_stage && r.current_stage !== 'unassigned' ? 'var(--txt2)' : 'var(--txt3)', textTransform: 'capitalize' }}>{r.current_stage ? r.current_stage.replace(/_/g, ' ') : '—'}</span>,
    },
    {
      key: 'id', label: 'Actions', align: 'right',
      render: r => (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button
            onClick={e => { e.stopPropagation(); setLogRow(r); setContactType('call'); setOutcome('reached'); setNotes('') }}
            title="Log a call, SMS, email or visit"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add_call</span>Contact
          </button>
          <button
            onClick={e => { e.stopPropagation(); setPayRow(r) }}
            title="Record a payment against this account"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: RADIUS.md, border: `1.5px solid ${GREEN}`, background: `${GREEN}12`, color: GREEN, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>payments</span>Payment
          </button>
        </div>
      ),
    },
  ]

  // Only block the whole page on the very first load; live reloads keep the
  // tables visible and use their own skeleton state instead of blanking.
  if (loading && agents.length === 0 && queue.length === 0) return (
    <Page title="My Workspace">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  return (
    <Page
      title="My Workspace"
      subtitle="Your collections station: queue, promises and payments"
      actions={<LiveBadge />}
    >
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        presence={<PresenceControl status={status} onChange={changeStatus} />}
        subline={<><strong style={{ color: '#fff' }}>{fmtKoboExact(myCollected)}</strong> collected today · <strong style={{ color: '#fff' }}>{fmtKoboExact(myPortfolio)}</strong> in your book to work down</>}
        ring={{ value: myContacts, max: Math.max(1, myAssigned), unit: 'contacted' }}
        stats={[
          { label: 'My Queue', value: fmtNum(myAssigned) },
          { label: 'Contacts Today', value: fmtNum(myContacts), color: '#4ADE80' },
          { label: 'Collected Today', value: fmtKoboExact(myCollected), color: '#4ADE80' },
          { label: 'PTPs Secured', value: fmtNum(myPtps) },
          { label: 'PTPs Kept', value: fmtNum(myPtpsKept), color: '#4ADE80' },
          { label: 'Portfolio', value: fmtKoboExact(myPortfolio), color: '#FCA5A5' },
        ]}
        actions={<>
          <HeroButton icon="upload_file" label="Batch Upload" primary onClick={() => setBatchOpen(true)} />
          <HeroButton icon="format_list_bulleted" label="My Queue" onClick={() => navigate('/collections/queue?mine=1')} />
          <HeroButton icon="handshake" label="My Promises" onClick={() => navigate('/collections/promises')} />
          <HeroButton icon="account_balance_wallet" label="My Portfolio" onClick={() => navigate('/collections/portfolio')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="accounts to work today">
        <MyDayTile icon="phone_forwarded" count={fmtNum(untouched)} label="Not contacted today"
          sub={untouched > 0 ? 'reach them before day-end' : 'whole queue touched'}
          color={AMBER} urgent={untouched > 0} onClick={() => navigate('/collections/queue?mine=1')} />
        <MyDayTile icon="handshake" count={fmtNum(ptpsToChase)} label="PTPs to chase"
          sub={promises.length
            ? (ptpsToChase > 0 ? `${ptpDueToday} due today · ${ptpOverdue} overdue` : 'no promises due')
            : (ptpsToChase > 0 ? 'promises not yet kept' : 'all promises kept')}
          color={RED} urgent={ptpsToChase > 0} onClick={() => navigate('/collections/promises')} />
        <MyDayTile icon="payments" count={fmtKoboExact(myCollected)} label="Collected today"
          sub={myPayments > 0 ? `${fmtNum(myPayments)} payment${myPayments !== 1 ? 's' : ''} logged` : 'no payments yet today'}
          color={GREEN} onClick={() => navigate('/collections/queue?mine=1')} />
        <MyDayTile icon="warning" count={fmtKoboExact(myPortfolio)} label="Portfolio at risk"
          sub="outstanding in your book" color={RED} onClick={() => navigate('/collections/portfolio')} />
      </MyDaySection>

      {/* Account queue — the accounts you work */}
      <SectionCard
        title="My Account Queue"
        subtitle={myAssigned > queue.length
          ? `Showing ${fmtNum(queue.length)} of ${fmtNum(myAssigned)} accounts assigned to you`
          : 'Every account assigned to you'}
        badge={myAssigned}
        actions={<LiveBadge />}
        padding={false}
        style={{ marginBottom: 16 }}
      >
        <DataTable
          cols={queueCols}
          rows={queue}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          emptyText="No accounts in your queue"
          pageSize={20}
          searchKeys={['account_cif', 'dpd_bucket', 'current_stage']}
          searchPlaceholder="Search your accounts by CIF, DPD or stage…"
        />
      </SectionCard>

      <BatchPaymentModal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        onSuccess={() => { setBatchOpen(false); load() }}
      />

      {/* Log Payment modal */}
      <LogPaymentModal
        open={!!payRow}
        onClose={() => setPayRow(null)}
        title={`Log Payment: ${payRow?.account_cif ?? ''}`}
        endpoint={payRow ? `/api/collections-ops/${payRow.id}/payment` : ''}
        onSuccess={() => { setPayRow(null); load() }}
      />

      {/* Log Contact modal */}
      <Modal
        open={!!logRow}
        onClose={() => setLogRow(null)}
        title="Log Contact"
        width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setLogRow(null)} style={{ padding: '9px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleLogContact} disabled={logging}
              style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: logging ? 'wait' : 'pointer', opacity: logging ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {logging && <Spinner size={13} color="#fff" />}
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add_call</span>Log Contact
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Account context */}
          {logRow && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: `${SP[2]} ${SP[3]}`, background: 'var(--bg2)', borderRadius: RADIUS.md }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{logRow.customer_name || logRow.account_cif}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{logRow.account_cif}{logRow.dpd_bucket ? ` · ${logRow.dpd_bucket} DPD` : ''}</div>
              </div>
              <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtKoboExact(logRow.outstanding_kobo)}</span>
            </div>
          )}
          {/* Method — icon segmented control */}
          <div>
            <label style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 7 }}>Method</label>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${CONTACT_TYPES.length}, 1fr)`, gap: 7 }}>
              {CONTACT_TYPES.map(ct => {
                const on = contactType === ct.value
                return (
                  <button key={ct.value} onClick={() => setContactType(ct.value)}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '9px 6px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
                      border: `1.5px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? NAVY : 'var(--card)', color: on ? '#fff' : 'var(--txt2)' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{ct.icon}</span>
                    {ct.label}
                  </button>
                )
              })}
            </div>
          </div>
          {/* Outcome */}
          <div>
            <label style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 7 }}>Outcome</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {OUTCOMES.map(o => {
                const on = outcome === o.value
                return (
                  <button key={o.value} onClick={() => setOutcome(o.value)}
                    style={{ padding: '6px 13px', borderRadius: RADIUS.full, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                      border: `1.5px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? `${NAVY}12` : 'var(--card)', color: on ? NAVY : 'var(--txt2)' }}>
                    {o.label}
                  </button>
                )
              })}
            </div>
          </div>
          {/* Notes */}
          <div>
            <label style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 7 }}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="What was said, next steps…"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
