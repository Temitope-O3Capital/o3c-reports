import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, Modal, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LogPaymentModal } from '../../components/LogPaymentModal'
import { BatchPaymentModal } from '../../components/BatchPaymentModal'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, monthStart, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'
import { WorkspaceHero, MyDaySection, MyDayTile, PresenceControl, HeroButton, myUserId, ordinal } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

// Shape returned by GET /api/collections-ops/agent-dashboard
interface AgentRow {
  id: number
  full_name: string
  assigned: number
  contacts_today: number
  ptps_today: number
  ptps_honoured_today: number
  portfolio_kobo: number
}

// Shape returned by GET /api/collections-ops/queue
interface QueueRow {
  id: number             // assignment id — used as the path param for /contact
  account_cif: string
  agent_name: string | null
  dpd_bucket: string | null
  outstanding_kobo: number
  current_stage: string | null
  last_contact_at: string | null
}

const CONTACT_TYPES = [
  { value: 'call',     label: 'Phone Call' },
  { value: 'sms',      label: 'SMS' },
  { value: 'email',    label: 'Email' },
  { value: 'visit',    label: 'Field Visit' },
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
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [status,   setStatus]   = useState('available')

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

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

  const load = useCallback(async () => {
    setError(null)
    const qs = `?from=${dateFrom}&to=${dateTo}`
    try {
      const [aRes, qRes] = await Promise.all([
        apiFetch<{ data: AgentRow[] }>(`/api/collections-ops/agent-dashboard${qs}`),
        apiFetch<{ data: QueueRow[] }>(`/api/collections-ops/queue?limit=100&from=${dateFrom}&to=${dateTo}`),
      ])
      setAgents(Array.isArray(aRes.data) ? aRes.data : [])
      setQueue(Array.isArray(qRes.data) ? qRes.data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['collections', 'loans'] })

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

  // Personal view: pick the signed-in agent's own row out of the team array, and
  // rank them among peers by today's contacts (mirrors the Call Center leaderboard).
  const uid = myUserId()
  const myRow = agents.find(a => a.id === uid) ?? null
  const myAssigned  = Number(myRow?.assigned ?? 0)
  const myContacts  = Number(myRow?.contacts_today ?? 0)
  const myPtps      = Number(myRow?.ptps_today ?? 0)
  const myPtpsKept  = Number(myRow?.ptps_honoured_today ?? 0)
  const myPortfolio = Number(myRow?.portfolio_kobo ?? 0)
  const ranked = [...agents].sort((a, b) => Number(b.contacts_today) - Number(a.contacts_today))
  const myRank = myRow ? ranked.findIndex(a => a.id === myRow.id) + 1 : 0
  const untouched = Math.max(0, myAssigned - myContacts)
  const ptpsToChase = Math.max(0, myPtps - myPtpsKept)

  const agentCols: TableCol<AgentRow>[] = [
    {
      key: 'full_name', label: 'Agent',
      render: r => (
        <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          {r.full_name}
          {r.id === uid && <span style={{ marginLeft: 7, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: NAVY, background: `${NAVY}14`, borderRadius: RADIUS['2xl'], padding: '1px 7px' }}>You</span>}
        </span>
      ),
    },
    {
      key: 'assigned', label: 'Queue', align: 'right',
      render: r => <span style={NUM}>{Number(r.assigned)}</span>,
    },
    {
      key: 'contacts_today', label: 'Contacts Today', align: 'right',
      render: r => <span style={{ ...NUM, color: Number(r.contacts_today) > 0 ? GREEN : 'var(--txt3)' }}>{Number(r.contacts_today)}</span>,
    },
    {
      key: 'ptps_today', label: 'PTPs Today', align: 'right',
      render: r => <span style={NUM}>{Number(r.ptps_today)}</span>,
    },
    {
      key: 'ptps_honoured_today', label: 'PTPs Kept', align: 'right',
      render: r => <span style={{ ...NUM, color: Number(r.ptps_honoured_today) > 0 ? GREEN : 'var(--txt3)' }}>{Number(r.ptps_honoured_today)}</span>,
    },
    {
      key: 'portfolio_kobo', label: 'Portfolio', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.portfolio_kobo)}</span>,
    },
  ]

  const queueCols: TableCol<QueueRow>[] = [
    {
      key: 'account_cif', label: 'Account',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: NAVY, fontFamily: 'DM Mono, monospace' }}>{r.account_cif}</span>,
    },
    {
      key: 'dpd_bucket', label: 'DPD',
      render: r => (
        <span style={{ fontWeight: 700, color: dpdColour(r.dpd_bucket) }}>
          {r.dpd_bucket ?? 'Current'}
        </span>
      ),
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 700 }}>{fmtKobo(r.outstanding_kobo)}</span>,
    },
    {
      key: 'current_stage', label: 'Stage',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.current_stage ?? '—'}</span>,
    },
    {
      key: 'last_contact_at', label: 'Last Contact',
      render: r => r.last_contact_at
        ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.last_contact_at)}</span>
        : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Never</span>,
    },
    {
      key: 'id', label: '',
      render: r => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={e => { e.stopPropagation(); setLogRow(r); setContactType('call'); setOutcome('reached'); setNotes('') }}
            style={{ padding: '4px 11px', borderRadius: RADIUS.sm, border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            Log Contact
          </button>
          <button
            onClick={e => { e.stopPropagation(); setPayRow(r) }}
            style={{ padding: '4px 11px', borderRadius: RADIUS.sm, border: `1.5px solid ${GREEN}40`, background: `${GREEN}0A`, color: GREEN, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            Log Payment
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
      subtitle="Your collections station — queue, promises and payments"
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setBatchOpen(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: '6px',
              border: `1.5px solid ${GREEN}40`, background: `${GREEN}0A`,
              color: GREEN, fontSize: '13px', fontWeight: 600, cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>upload_file</span>
            Batch Upload
          </button>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        presence={<PresenceControl status={status} onChange={changeStatus} />}
        subline={myRank > 0
          ? <>You're <strong style={{ color: '#fff' }}>{ordinal(myRank)}</strong> on the team today of {agents.length} · <strong style={{ color: '#fff' }}>{fmtKobo(myPortfolio)}</strong> in your book</>
          : <>{fmtKobo(myPortfolio)} in your book — start working it down 💪</>}
        ring={{ value: myContacts, max: Math.max(1, myAssigned), unit: 'contacted' }}
        stats={[
          { label: 'My Queue', value: fmtNum(myAssigned) },
          { label: 'Contacts Today', value: fmtNum(myContacts), color: '#4ADE80' },
          { label: 'PTPs Today', value: fmtNum(myPtps) },
          { label: 'PTPs Kept', value: fmtNum(myPtpsKept), color: '#4ADE80' },
          { label: 'Portfolio', value: fmtKobo(myPortfolio), color: '#FCA5A5' },
        ]}
        actions={<>
          <HeroButton icon="upload_file" label="Batch Upload" primary onClick={() => setBatchOpen(true)} />
          <HeroButton icon="format_list_bulleted" label="Agent Queue" onClick={() => navigate('/collections/queue')} />
          <HeroButton icon="handshake" label="Promises to Pay" onClick={() => navigate('/collections/promises')} />
          <HeroButton icon="account_balance_wallet" label="Credit Portfolio" onClick={() => navigate('/collections/portfolio')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="accounts to work today">
        <MyDayTile icon="phone_forwarded" count={fmtNum(untouched)} label="Not contacted today"
          sub={untouched > 0 ? 'reach them before day-end' : 'whole queue touched'}
          color={AMBER} urgent={untouched > 0} onClick={() => navigate('/collections/queue')} />
        <MyDayTile icon="handshake" count={fmtNum(ptpsToChase)} label="PTPs to chase"
          sub={ptpsToChase > 0 ? 'promises not yet kept' : 'all promises kept'}
          color={PURPLE} urgent={ptpsToChase > 0} onClick={() => navigate('/collections/promises')} />
        <MyDayTile icon="trending_up" count={fmtNum(myContacts)} label="Contacts today"
          sub="calls & visits logged" color={GREEN} />
        <MyDayTile icon="warning" count={fmtKobo(myPortfolio)} label="Portfolio at risk"
          sub="outstanding in your book" color={RED} onClick={() => navigate('/collections/portfolio')} />
      </MyDaySection>

      {/* Account queue — the accounts you work */}
      <SectionCard title="My Account Queue" badge={queue.length} padding={false} style={{ marginBottom: 16 }}>
        <DataTable
          cols={queueCols}
          rows={queue}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          emptyText="No accounts in queue"
          pageSize={20}
          searchKeys={['account_cif', 'agent_name', 'dpd_bucket']}
          searchPlaceholder="Search CIF, agent, DPD…"
        />
      </SectionCard>

      {/* Team leaderboard — see where you rank */}
      <SectionCard title="Team Leaderboard" subtitle="Today's activity across the collections team" badge={agents.length} padding={false}>
        <DataTable
          cols={agentCols}
          rows={ranked}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={6}
          emptyText="No agent data"
          searchKeys={['full_name']}
          searchPlaceholder="Search agent…"
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
        title={`Log Payment — ${payRow?.account_cif ?? ''}`}
        endpoint={payRow ? `/api/collections-ops/${payRow.id}/payment` : ''}
        onSuccess={() => { setPayRow(null); load() }}
      />

      {/* Log Contact modal */}
      <Modal
        open={!!logRow}
        onClose={() => setLogRow(null)}
        title={`Log Contact — ${logRow?.account_cif ?? ''}`}
        width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleLogContact} disabled={logging}
              style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: logging ? 'wait' : 'pointer', opacity: logging ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {logging && <Spinner size={13} color="#fff" />}
              Save
            </button>
            <button onClick={() => setLogRow(null)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>Contact Method</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {CONTACT_TYPES.map(ct => (
                <button key={ct.value} onClick={() => setContactType(ct.value)}
                  style={{
                    padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                    border: `1.5px solid ${contactType === ct.value ? NAVY : 'var(--bdr)'}`,
                    background: contactType === ct.value ? NAVY : 'var(--card)',
                    color: contactType === ct.value ? '#fff' : 'var(--txt)',
                  }}>
                  {ct.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>Outcome</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {OUTCOMES.map(o => (
                <button key={o.value} onClick={() => setOutcome(o.value)}
                  style={{
                    padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                    border: `1.5px solid ${outcome === o.value ? NAVY : 'var(--bdr)'}`,
                    background: outcome === o.value ? NAVY : 'var(--card)',
                    color: outcome === o.value ? '#fff' : 'var(--txt)',
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="Optional notes…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
