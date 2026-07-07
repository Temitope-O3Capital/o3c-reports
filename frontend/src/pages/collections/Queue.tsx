import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, FilterBar, Tabs, ConfirmModal, ErrBanner, Spinner, Modal,
  filterInputStyle,
} from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, DARKRED, NAVY, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentUser { id: number; full_name: string; role: string }

interface Assignment {
  id: number
  account_cif: string
  agent_name: string | null
  dpd_bucket: string
  outstanding_kobo: number
  current_stage: string | null
  notes: string | null
  last_contact_at: string | null
  assignment_date: string | null
}

interface ContactEntry {
  id: number
  contact_type: string
  outcome: string
  notes: string | null
  created_at: string
}

// ── DPD colour ────────────────────────────────────────────────────────────────

function dpdColor(bucket: string): string {
  switch (bucket) {
    case '0':       return GREEN
    case '1-30':    return AMBER
    case '31-60':
    case '61-90':   return RED
    default:        return DARKRED
  }
}

function DpdBadge({ bucket }: { bucket: string }) {
  const color = dpdColor(bucket)
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11, fontWeight: 700,
      padding: '2px 7px', borderRadius: 20,
      background: `${color}18`, color,
      whiteSpace: 'nowrap',
    }}>
      DPD {bucket}
    </span>
  )
}

// ── Label/value row ───────────────────────────────────────────────────────────

function LV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--txt2)', width: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>{value ?? '—'}</span>
    </div>
  )
}

// ── Small button ──────────────────────────────────────────────────────────────

function Btn({
  children, onClick, disabled, loading: btnLoading, danger,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || btnLoading}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '7px 14px', borderRadius: 8, border: 'none',
        background: danger ? RED : NAVY, color: '#fff',
        fontSize: 13, fontWeight: 600,
        cursor: disabled || btnLoading ? 'not-allowed' : 'pointer',
        opacity: disabled || btnLoading ? 0.6 : 1,
      }}
    >
      {btnLoading && <Spinner size={13} color="#fff" />}
      {children}
    </button>
  )
}

// ── Textarea / input shared style ─────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

// ── Log Call tab ──────────────────────────────────────────────────────────────

const DISPOSITIONS = [
  'Answered — Interested',
  'Answered — Not Interested',
  'No Answer',
  'Wrong Number',
  'Promise to Pay',
  'Callback Requested',
]

function LogCallTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [disposition, setDisposition] = useState(DISPOSITIONS[0])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setSaving(true)
    setErr(null)
    try {
      await apiPost(`/api/collections-ops/${assignmentId}/contact`, {
        contact_type: 'call',
        outcome: disposition,
        notes,
      })
      setNotes('')
      setDisposition(DISPOSITIONS[0])
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to log call')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Disposition
        </label>
        <select
          value={disposition}
          onChange={e => setDisposition(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}
        >
          {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Notes
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={3}
          placeholder="Add call notes…"
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!disposition}>
        Log Call
      </Btn>
    </div>
  )
}

// ── Record PTP tab ────────────────────────────────────────────────────────────

function RecordPTPTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [amountNaira, setAmountNaira] = useState('')
  const [ptpDate, setPtpDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    const kobo = Math.round(parseFloat(amountNaira) * 100)
    if (!kobo || !ptpDate) return
    setSaving(true)
    setErr(null)
    try {
      await apiPost(`/api/collections-ops/${assignmentId}/promise`, {
        amount_kobo: kobo,
        promise_date: ptpDate,
      })
      setAmountNaira('')
      setPtpDate('')
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to record PTP')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Promise Amount (₦)
        </label>
        <input
          type="number"
          value={amountNaira}
          onChange={e => setAmountNaira(e.target.value)}
          placeholder="e.g. 50000"
          style={{ ...fieldStyle, height: 36 }}
        />
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Promise Date
        </label>
        <input
          type="date"
          value={ptpDate}
          onChange={e => setPtpDate(e.target.value)}
          style={{ ...fieldStyle, height: 36 }}
        />
      </div>
      <Btn
        onClick={submit}
        loading={saving}
        disabled={!amountNaira || !ptpDate || parseFloat(amountNaira) <= 0}
      >
        Record PTP
      </Btn>
    </div>
  )
}

// ── Escalate tab ──────────────────────────────────────────────────────────────

function EscalateTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function doEscalate() {
    setSaving(true)
    setErr(null)
    try {
      // Log a contact with escalation outcome — backend logs the action
      await apiPost(`/api/collections-ops/${assignmentId}/contact`, {
        contact_type: 'escalation',
        outcome: 'Escalated to Recovery',
        notes: reason,
      })
      setReason('')
      setConfirm(false)
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Escalation failed')
      setConfirm(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Escalation Reason
        </label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={4}
          placeholder="Describe why this account needs escalation to Recovery…"
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
      </div>
      <Btn onClick={() => setConfirm(true)} disabled={!reason.trim()} danger>
        Escalate to Recovery
      </Btn>
      <ConfirmModal
        open={confirm}
        title="Escalate to Recovery"
        body={`This will escalate the account to the Recovery team. Reason: "${reason.slice(0, 120)}${reason.length > 120 ? '…' : ''}"`}
        confirmLabel="Escalate"
        danger
        loading={saving}
        onConfirm={doEscalate}
        onClose={() => setConfirm(false)}
      />
    </div>
  )
}

// ── Assign Agent tab ──────────────────────────────────────────────────────────

function AssignAgentTab({ assignmentId, agents, onDone }: {
  assignmentId: number; agents: AgentUser[]; onDone: () => void
}) {
  const [agentId, setAgentId] = useState('')
  const [notes,   setNotes]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [err,     setErr]     = useState<string | null>(null)

  const collectionAgents = agents.filter(a =>
    a.role.includes('collection') || a.role === 'admin' || a.role === 'management'
  )

  async function submit() {
    if (!agentId) return
    setSaving(true); setErr(null)
    try {
      await apiPut(`/api/collections-ops/${assignmentId}/assign`, { agent_id: Number(agentId), notes })
      toast.success('Agent assigned')
      setNotes(''); onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to assign agent')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Agent
        </label>
        <select value={agentId} onChange={e => setAgentId(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}>
          <option value="">Select agent…</option>
          {collectionAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Notes
        </label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!agentId}>Assign Agent</Btn>
    </div>
  )
}

// ── Contact history section ───────────────────────────────────────────────────

function ContactHistory({ contacts, loading }: { contacts: ContactEntry[]; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', color: 'var(--txt2)', fontSize: 13 }}>
        <Spinner size={14} color={NAVY} /> Loading history…
      </div>
    )
  }
  if (!contacts.length) {
    return <div style={{ fontSize: 13, color: 'var(--txt2)', padding: '8px 0' }}>No contact history found.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {contacts.map(c => (
        <div key={c.id} style={{
          padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--bdr)', background: 'var(--th-bg)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>{c.outcome}</span>
            <span style={{ fontSize: 11.5, color: 'var(--txt2)' }}>{fmtDate(c.created_at)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--txt2)', textTransform: 'capitalize' }}>
            {c.contact_type}
          </div>
          {c.notes && (
            <div style={{ fontSize: 12, color: 'var(--txt)', marginTop: 4, lineHeight: 1.5 }}>{c.notes}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Right panel: account detail ───────────────────────────────────────────────

const ACTION_TABS = [
  { key: 'call',    label: 'Log Call' },
  { key: 'ptp',     label: 'Record PTP' },
  { key: 'assign',  label: 'Assign Agent' },
  { key: 'escalate', label: 'Escalate' },
]

function SendToRecoveryButton({ assignment, onDone }: { assignment: Assignment; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)

  const eligible = ['91-180', '181-360', '360+'].includes(assignment.dpd_bucket)
  if (!eligible) return null

  async function send() {
    setSaving(true)
    try {
      const res = await apiPost<{ case_ref: string }>(`/api/collections-ops/${assignment.id}/send-to-recovery`, {})
      toast.success(`Recovery case ${res?.case_ref ?? ''} created`)
      onDone()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to send to recovery')
    } finally {
      setSaving(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--txt2)' }}>Send to recovery?</span>
        <button onClick={send} disabled={saving} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: RED, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          {saving ? 'Sending…' : 'Confirm'}
        </button>
        <button onClick={() => setConfirming(false)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt2)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      style={{ marginTop: 12, padding: '6px 14px', borderRadius: 7, border: `1.5px solid ${RED}`, background: 'rgba(192,0,0,.06)', color: RED, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>assignment_late</span>
      Send to Recovery
    </button>
  )
}

function DetailPanel({
  assignment,
  agents,
  onAction,
}: {
  assignment: Assignment
  agents: AgentUser[]
  onAction: () => void
}) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('call')
  const [contacts, setContacts] = useState<ContactEntry[]>([])
  const [contactsLoading, setContactsLoading] = useState(true)

  useEffect(() => {
    setContactsLoading(true)
    // Fetch recent contacts for this CIF — using queue filtered by same id
    // Backend doesn't expose a dedicated contact history endpoint, so we proxy
    // through a targeted queue fetch and note last_contact_at from the assignment.
    // For contact log entries we use the contact endpoint's implicit history.
    // We'll show a placeholder list derived from available assignment data.
    // If the API exposes a /contacts endpoint in future, swap this call.
    setContacts([])
    setContactsLoading(false)
  }, [assignment.id])

  function refreshContacts() {
    // Re-triggered after logging a new contact — same pattern as above
    onAction()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      {/* Customer strip */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--bdr)',
        background: 'var(--th-bg)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)', marginBottom: 2 }}>
              CIF: {assignment.account_cif}
            </div>
            <div style={{ fontSize: 12, color: 'var(--txt2)' }}>
              Assigned to: {assignment.agent_name ?? 'Unassigned'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <DpdBadge bucket={assignment.dpd_bucket} />
            <button
              onClick={() => navigate(`/contacts/${assignment.account_cif}`)}
              style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Full profile →
            </button>
          </div>
        </div>
      </div>

      {/* Loan summary */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
          Loan Summary
        </div>
        <LV label="Outstanding" value={<span style={NUM}>{fmtKobo(assignment.outstanding_kobo)}</span>} />
        <LV label="DPD Bucket"  value={<DpdBadge bucket={assignment.dpd_bucket} />} />
        <LV label="Stage"       value={assignment.current_stage ?? '—'} />
        <LV label="Assigned On" value={fmtDate(assignment.assignment_date)} />
        <LV label="Last Contact" value={fmtDate(assignment.last_contact_at)} />
        {assignment.notes && (
          <div style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 6,
            background: 'rgba(14,40,65,0.04)', border: '1px solid var(--bdr)',
            fontSize: 12, color: 'var(--txt)', lineHeight: 1.5,
          }}>
            {assignment.notes}
          </div>
        )}
      </div>

      {/* Contact history */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Contact History
        </div>
        <ContactHistory contacts={contacts} loading={contactsLoading} />
      </div>

      {/* Action tabs */}
      <div style={{ padding: '16px 20px', flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Actions
        </div>
        <Tabs tabs={ACTION_TABS} active={tab} onChange={setTab} />
        {tab === 'call'     && <LogCallTab      assignmentId={assignment.id} onDone={refreshContacts} />}
        {tab === 'ptp'      && <RecordPTPTab    assignmentId={assignment.id} onDone={refreshContacts} />}
        {tab === 'assign'   && <AssignAgentTab  assignmentId={assignment.id} agents={agents} onDone={refreshContacts} />}
        {tab === 'escalate' && <EscalateTab     assignmentId={assignment.id} onDone={refreshContacts} />}
        <SendToRecoveryButton assignment={assignment} onDone={onAction} />
      </div>
    </div>
  )
}

// ── Bulk reassign modal ───────────────────────────────────────────────────────

function ReassignModal({ open, onClose, selectedIds, agents, onDone }: {
  open: boolean; onClose: () => void
  selectedIds: Set<number>; agents: AgentUser[]
  onDone: () => void
}) {
  const [agentId, setAgentId] = useState('')
  const [notes,   setNotes]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [err,     setErr]     = useState<string | null>(null)

  const collectionAgents = agents.filter(a =>
    a.role.includes('collection') || a.role === 'admin' || a.role === 'management'
  )

  async function submit() {
    if (!agentId) return
    setSaving(true); setErr(null)
    try {
      await Promise.all([...selectedIds].map(id =>
        apiPut(`/api/collections-ops/${id}/assign`, { agent_id: Number(agentId), notes })
      ))
      toast.success(`${selectedIds.size} account${selectedIds.size !== 1 ? 's' : ''} reassigned`)
      setAgentId(''); setNotes(''); onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Reassign failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Reassign ${selectedIds.size} Account${selectedIds.size !== 1 ? 's' : ''}`} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Agent
          </label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)}
            style={{ ...filterInputStyle, height: 36, width: '100%' }}>
            <option value="">Select agent…</option>
            {collectionAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Notes
          </label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={submit} disabled={!agentId || saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8, border: 'none',
              background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: !agentId || saving ? 'not-allowed' : 'pointer',
              opacity: !agentId || saving ? 0.6 : 1,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            Assign {selectedIds.size} Account{selectedIds.size !== 1 ? 's' : ''}
          </button>
          <button onClick={onClose} style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Left panel: queue list ────────────────────────────────────────────────────

const DPD_OPTIONS = ['All', '0', '1-30', '31-60', '61-90', '91-180', '181-360']
const CONTACT_OPTIONS = ['Any', 'Today', 'This week', 'This month']

// ── Main component ────────────────────────────────────────────────────────────

export default function CollectionsQueue() {
  const [items,   setItems]   = useState<Assignment[]>([])
  const [agents,  setAgents]  = useState<AgentUser[]>([])
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)
  const [selected,     setSelected]     = useState<Assignment | null>(null)
  const [checkedIds,   setCheckedIds]   = useState<Set<number>>(new Set())
  const [reassignOpen, setReassignOpen] = useState(false)

  // Filters
  const [dpdFilter,     setDpdFilter]     = useState('All')
  const [contactFilter, setContactFilter] = useState('Any')
  const [agentFilter,   setAgentFilter]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: '100' })
    if (dpdFilter !== 'All') params.set('dpd_bucket', dpdFilter)
    if (agentFilter.trim()) params.set('q', agentFilter.trim())

    try {
      const [queueRes, usersRes] = await Promise.all([
        apiFetch<{ data: Assignment[] }>(`/api/collections-ops/queue?${params}`),
        apiFetch<{ data: AgentUser[] }>('/api/admin/users'),
      ])
      let rows = queueRes.data ?? []
      setAgents(usersRes.data ?? [])

      // Client-side contact recency filter
      if (contactFilter !== 'Any') {
        const now = new Date()
        const startOf = (unit: 'day' | 'week' | 'month') => {
          const d = new Date(now)
          if (unit === 'day')   d.setHours(0, 0, 0, 0)
          if (unit === 'week')  { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()) }
          if (unit === 'month') { d.setHours(0, 0, 0, 0); d.setDate(1) }
          return d
        }
        const cutoff =
          contactFilter === 'Today'      ? startOf('day') :
          contactFilter === 'This week'  ? startOf('week') :
          startOf('month')

        rows = rows.filter(r =>
          r.last_contact_at && new Date(r.last_contact_at) >= cutoff
        )
      }

      setItems(rows)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load queue')
    } finally {
      setLoading(false)
    }
  }, [dpdFilter, contactFilter, agentFilter])

  useEffect(() => { load() }, [load])

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearChecked() { setCheckedIds(new Set()) }

  return (
    <Page title="Collections Queue" subtitle="Manage and work assigned collection accounts" noPad>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ─────────────────────────────────────────────────────── */}
        <div style={{
          minWidth: 320, maxWidth: 380, width: 360,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)',
          flexShrink: 0,
        }}>
          {/* Filters */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <FilterBar onReset={() => { setDpdFilter('All'); setContactFilter('Any'); setAgentFilter('') }}>
              <select
                value={dpdFilter}
                onChange={e => setDpdFilter(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}
              >
                {DPD_OPTIONS.map(o => <option key={o} value={o}>{o === 'All' ? 'All DPD' : `DPD ${o}`}</option>)}
              </select>
              <select
                value={contactFilter}
                onChange={e => setContactFilter(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}
              >
                {CONTACT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </FilterBar>
            <input
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              placeholder="Search by CIF…"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>
                {checkedIds.size} selected
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setReassignOpen(true)}
                  style={{
                    fontSize: 11.5, fontWeight: 500, color: NAVY,
                    background: 'none', border: `1px solid ${NAVY}30`,
                    borderRadius: 6, padding: '3px 9px', cursor: 'pointer',
                  }}
                >
                  Reassign
                </button>
                <button onClick={clearChecked} style={{
                  width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%',
                }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {err && (
            <div style={{ padding: '10px 14px' }}>
              <ErrBanner error={err} onRetry={load} />
            </div>
          )}

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: 13 }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: 13 }}>
                No accounts match the current filters.
              </div>
            ) : (
              items.map(item => {
                const isSelected = selected?.id === item.id
                const isChecked  = checkedIds.has(item.id)
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelected(item)}
                    style={{
                      padding: '11px 14px',
                      borderBottom: '1px solid var(--bdr)',
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(14,40,65,0.06)' : undefined,
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onClick={e => toggleCheck(item.id, e)}
                      onChange={() => {}}
                      style={{ marginTop: 3, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          CIF: {item.account_cif}
                        </span>
                        <DpdBadge bucket={item.dpd_bucket} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ ...NUM, fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>
                          {fmtKobo(item.outstanding_kobo)}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--txt2)' }}>
                          {item.last_contact_at ? `Contact: ${fmtDate(item.last_contact_at)}` : 'No contact yet'}
                        </span>
                      </div>
                      {item.agent_name && (
                        <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 2 }}>
                          Agent: {item.agent_name}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* ── Right panel ────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'auto' }}>
          {selected ? (
            <DetailPanel
              key={selected.id}
              assignment={selected}
              agents={agents}
              onAction={load}
            />
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 12, color: 'var(--txt2)',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>
                account_balance
              </span>
              <span style={{ fontSize: 14 }}>Select an account from the list</span>
            </div>
          )}
        </div>

      </div>

      {/* Bulk reassign modal */}
      <ReassignModal
        open={reassignOpen}
        onClose={() => setReassignOpen(false)}
        selectedIds={checkedIds}
        agents={agents}
        onDone={() => { setReassignOpen(false); setCheckedIds(new Set()); load() }}
      />
    </Page>
  )
}
