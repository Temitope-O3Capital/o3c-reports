import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM } from '../../lib/design'
import { toast } from 'sonner'

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
  if (bucket.startsWith('91') || bucket === '90+') return '#7F1D1D'
  if (bucket.startsWith('61')) return RED
  if (bucket.startsWith('31')) return '#EA580C'
  if (bucket.startsWith('1'))  return AMBER
  return GREEN
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function Tile({ label, value, colour, sub }: { label: string; value: string | number; colour?: string; sub?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 110, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: colour ?? 'var(--txt)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AgentDashboard() {
  const [agents,   setAgents]   = useState<AgentRow[]>([])
  const [queue,    setQueue]    = useState<QueueRow[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // Log-contact modal
  const [logRow,       setLogRow]       = useState<QueueRow | null>(null)
  const [contactType,  setContactType]  = useState('call')
  const [outcome,      setOutcome]      = useState('reached')
  const [notes,        setNotes]        = useState('')
  const [logging,      setLogging]      = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [aRes, qRes] = await Promise.all([
        apiFetch<{ data: AgentRow[] }>('/api/collections-ops/agent-dashboard'),
        apiFetch<{ data: QueueRow[] }>('/api/collections-ops/queue?limit=100'),
      ])
      setAgents(Array.isArray(aRes.data) ? aRes.data : [])
      setQueue(Array.isArray(qRes.data) ? qRes.data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

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

  // Totals across all visible agents
  const totalAssigned  = agents.reduce((s, a) => s + Number(a.assigned ?? 0), 0)
  const totalContacts  = agents.reduce((s, a) => s + Number(a.contacts_today ?? 0), 0)
  const totalPTPs      = agents.reduce((s, a) => s + Number(a.ptps_today ?? 0), 0)
  const totalPortfolio = agents.reduce((s, a) => s + Number(a.portfolio_kobo ?? 0), 0)

  const agentCols: TableCol<AgentRow>[] = [
    {
      key: 'full_name', label: 'Agent',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.full_name}</span>,
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
      render: r => <span style={{ fontSize: 13, fontWeight: 700, color: NAVY, fontFamily: 'DM Mono, monospace' }}>{r.account_cif}</span>,
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
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.current_stage ?? '—'}</span>,
    },
    {
      key: 'last_contact_at', label: 'Last Contact',
      render: r => r.last_contact_at
        ? <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.last_contact_at)}</span>
        : <span style={{ fontSize: 12, color: 'var(--txt3)' }}>Never</span>,
    },
    {
      key: 'id', label: '',
      render: r => (
        <button
          onClick={() => { setLogRow(r); setContactType('call'); setOutcome('reached'); setNotes('') }}
          style={{ padding: '4px 11px', borderRadius: 6, border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
        >
          Log Contact
        </button>
      ),
    },
  ]

  if (loading) return (
    <Page title="Collections Dashboard">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  return (
    <Page title="Collections Agent Dashboard" subtitle="Agent performance and account queue">
      <ErrBanner error={error} onRetry={load} />

      {/* Summary tiles */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <Tile label="Total Queue"       value={totalAssigned}  />
        <Tile label="Contacts Today"    value={totalContacts}  colour={totalContacts > 0 ? GREEN : undefined} />
        <Tile label="PTPs Today"        value={totalPTPs}      colour={totalPTPs > 0 ? AMBER : undefined} />
        <Tile label="Portfolio at Risk"
          value={fmtKobo(totalPortfolio)}
          colour={RED}
          sub={`${agents.length} agent${agents.length !== 1 ? 's' : ''}`}
        />
      </div>

      {/* Agent performance table */}
      <SectionCard title="Agent Performance" badge={agents.length} padding={false} style={{ marginBottom: 16 }}>
        <DataTable
          cols={agentCols}
          rows={agents}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={6}
          emptyText="No agent data"
        />
      </SectionCard>

      {/* Queue */}
      <SectionCard title="Account Queue" badge={queue.length} padding={false}>
        <DataTable
          cols={queueCols}
          rows={queue}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          emptyText="No accounts in queue"
          pageSize={20}
        />
      </SectionCard>

      {/* Log Contact modal */}
      <Modal
        open={!!logRow}
        onClose={() => setLogRow(null)}
        title={`Log Contact — ${logRow?.account_cif ?? ''}`}
        width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleLogContact} disabled={logging}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: logging ? 'wait' : 'pointer', opacity: logging ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {logging && <Spinner size={13} color="#fff" />}
              Save
            </button>
            <button onClick={() => setLogRow(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 6 }}>Contact Method</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {CONTACT_TYPES.map(ct => (
                <button key={ct.value} onClick={() => setContactType(ct.value)}
                  style={{
                    padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
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
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 6 }}>Outcome</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {OUTCOMES.map(o => (
                <button key={o.value} onClick={() => setOutcome(o.value)}
                  style={{
                    padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
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
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Notes</label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="Optional notes…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
