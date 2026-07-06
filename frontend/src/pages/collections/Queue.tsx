import { useEffect, useState, useCallback } from 'react'
import {
  ErrBanner, ConfirmModal, Spinner, Modal, TblSearch,
} from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, MONO, SORA } from '../../lib/design'
import { IcoTune } from '../../lib/icons'
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

// ── DPD helpers ───────────────────────────────────────────────────────────────

function dpdColor(bucket: string): string {
  if (bucket === '0')     return GREEN
  if (bucket === '1-30')  return AMBER
  if (bucket === '31-60' || bucket === '61-90') return RED
  return '#7F0000'
}

function DpdBadge({ bucket }: { bucket: string }) {
  const color = dpdColor(bucket)
  return (
    <span style={{
      fontFamily: MONO, display: 'inline-flex', alignItems: 'center',
      fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 3,
      background: `${color}18`, color, whiteSpace: 'nowrap',
    }}>
      DPD {bucket}
    </span>
  )
}

// ── Shared field style ────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: SORA, outline: 'none', boxSizing: 'border-box',
}

// ── Section title style ───────────────────────────────────────────────────────

const SEC_TITLE: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '.1em',
  textTransform: 'uppercase', color: 'var(--txt3)',
  fontFamily: MONO, marginBottom: 12,
}

// ── LV row ───────────────────────────────────────────────────────────────────

function LV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--txt3)', fontFamily: MONO, width: 100, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>{value ?? '—'}</span>
    </div>
  )
}

// ── Shared small button ───────────────────────────────────────────────────────

function Btn({ children, onClick, disabled, loading: btnLoading, danger, secondary }: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  danger?: boolean
  secondary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || btnLoading}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '7px 14px', borderRadius: 7, border: secondary ? '1.5px solid var(--bdr)' : 'none',
        background: secondary ? 'transparent' : danger ? RED : NAVY,
        color: secondary ? 'var(--txt2)' : '#fff',
        fontSize: 12.5, fontWeight: 600, fontFamily: SORA,
        cursor: disabled || btnLoading ? 'not-allowed' : 'pointer',
        opacity: disabled || btnLoading ? 0.6 : 1,
      }}
    >
      {btnLoading && <Spinner size={13} color={secondary ? NAVY : '#fff'} />}
      {children}
    </button>
  )
}

// ── Log Call tab ──────────────────────────────────────────────────────────────

const DISPOSITIONS = [
  'Answered — Interested', 'Answered — Not Interested',
  'No Answer', 'Wrong Number', 'Promise to Pay', 'Callback Requested',
]

function LogCallTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [disposition, setDisposition] = useState(DISPOSITIONS[0])
  const [notes, setNotes]   = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)

  async function submit() {
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/collections-ops/${assignmentId}/contact`, { contact_type: 'call', outcome: disposition, notes })
      setNotes(''); setDisposition(DISPOSITIONS[0]); onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed to log call') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Disposition</label>
        <select value={disposition} onChange={e => setDisposition(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
          {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Add call notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!disposition}>Log Call</Btn>
    </div>
  )
}

// ── Record PTP tab ────────────────────────────────────────────────────────────

function RecordPTPTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [amountNaira, setAmountNaira] = useState('')
  const [ptpDate, setPtpDate]         = useState('')
  const [saving, setSaving]           = useState(false)
  const [err, setErr]                 = useState<string | null>(null)

  async function submit() {
    const kobo = Math.round(parseFloat(amountNaira) * 100)
    if (!kobo || !ptpDate) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/collections-ops/${assignmentId}/promise`, { amount_kobo: kobo, promise_date: ptpDate })
      setAmountNaira(''); setPtpDate(''); onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed to record PTP') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Promise Amount (₦)</label>
        <input type="number" value={amountNaira} onChange={e => setAmountNaira(e.target.value)} placeholder="e.g. 50000" style={{ ...fieldStyle, height: 36 }} />
      </div>
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Promise Date</label>
        <input type="date" value={ptpDate} onChange={e => setPtpDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!amountNaira || !ptpDate || parseFloat(amountNaira) <= 0}>Record PTP</Btn>
    </div>
  )
}

// ── Escalate tab ──────────────────────────────────────────────────────────────

function EscalateTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [reason, setReason]   = useState('')
  const [confirm, setConfirm] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  async function doEscalate() {
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/collections-ops/${assignmentId}/contact`, { contact_type: 'escalation', outcome: 'Escalated to Recovery', notes: reason })
      setReason(''); setConfirm(false); onDone()
    } catch (e: any) { setErr(e.message ?? 'Escalation failed'); setConfirm(false) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Escalation Reason</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={4} placeholder="Describe why this account needs escalation to Recovery…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={() => setConfirm(true)} disabled={!reason.trim()} danger>Escalate to Recovery</Btn>
      <ConfirmModal
        open={confirm} title="Escalate to Recovery"
        body={`This will escalate the account to the Recovery team. Reason: "${reason.slice(0, 120)}${reason.length > 120 ? '…' : ''}"`}
        confirmLabel="Escalate" danger loading={saving}
        onConfirm={doEscalate} onClose={() => setConfirm(false)}
      />
    </div>
  )
}

// ── Assign Agent tab ──────────────────────────────────────────────────────────

function AssignAgentTab({ assignmentId, agents, onDone }: { assignmentId: number; agents: AgentUser[]; onDone: () => void }) {
  const [agentId, setAgentId] = useState('')
  const [notes, setNotes]     = useState('')
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  const collectionAgents = agents.filter(a => a.role.includes('collection') || a.role === 'admin' || a.role === 'management')

  async function submit() {
    if (!agentId) return
    setSaving(true); setErr(null)
    try {
      await apiPut(`/api/collections-ops/${assignmentId}/assign`, { agent_id: Number(agentId), notes })
      toast.success('Agent assigned'); setNotes(''); onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed to assign agent') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Agent</label>
        <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
          <option value="">Select agent…</option>
          {collectionAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!agentId}>Assign Agent</Btn>
    </div>
  )
}

// ── Send to Recovery ──────────────────────────────────────────────────────────

function SendToRecovery({ assignment, onDone }: { assignment: Assignment; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving]         = useState(false)

  const eligible = ['91-180', '181-360', '360+'].includes(assignment.dpd_bucket)
  if (!eligible) return null

  async function send() {
    setSaving(true)
    try {
      const res = await apiPost<{ case_ref: string }>(`/api/collections-ops/${assignment.id}/send-to-recovery`, {})
      toast.success(`Recovery case ${res?.case_ref ?? ''} created`); onDone()
    } catch (e: any) { toast.error(e.message ?? 'Failed to send to recovery') }
    finally { setSaving(false); setConfirming(false) }
  }

  if (confirming) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, padding: '10px 12px', borderRadius: 7, border: `1px solid ${RED}30`, background: `${RED}08` }}>
        <span style={{ fontSize: 12, color: 'var(--txt2)', flex: 1 }}>Send to recovery?</span>
        <button onClick={send} disabled={saving} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: RED, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SORA }}>
          {saving ? 'Sending…' : 'Confirm'}
        </button>
        <button onClick={() => setConfirming(false)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt2)', fontSize: 12, cursor: 'pointer', fontFamily: SORA }}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      style={{ marginTop: 16, width: '100%', padding: '8px 14px', borderRadius: 7, border: `1.5px solid ${RED}40`, background: `${RED}08`, color: RED, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, textAlign: 'left' }}
    >
      → Send to Recovery
    </button>
  )
}

// ── Action tabs ───────────────────────────────────────────────────────────────

const ACTION_TABS = [
  { key: 'call', label: 'Log Call' },
  { key: 'ptp',  label: 'Record PTP' },
  { key: 'assign', label: 'Assign Agent' },
  { key: 'escalate', label: 'Escalate' },
]

// ── Right detail panel ────────────────────────────────────────────────────────

function DetailPanel({ assignment, agents, onAction }: { assignment: Assignment; agents: AgentUser[]; onAction: () => void }) {
  const [tab, setTab] = useState('call')
  const [contacts] = useState<ContactEntry[]>([])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', fontFamily: SORA }}>

      {/* Customer strip */}
      <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: 'var(--txt)', letterSpacing: '-.01em' }}>
              {assignment.account_cif}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 3 }}>
              {assignment.agent_name ? `Assigned · ${assignment.agent_name}` : 'Unassigned'}
            </div>
          </div>
          <DpdBadge bucket={assignment.dpd_bucket} />
        </div>
      </div>

      {/* Loan summary */}
      <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
        <div style={SEC_TITLE}>Loan Summary</div>
        <LV label="Outstanding" value={<span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 14 }}>{fmtKobo(assignment.outstanding_kobo)}</span>} />
        <LV label="DPD Bucket"  value={<DpdBadge bucket={assignment.dpd_bucket} />} />
        <LV label="Stage"       value={assignment.current_stage} />
        <LV label="Assigned On" value={fmtDate(assignment.assignment_date)} />
        <LV label="Last Contact" value={assignment.last_contact_at ? fmtDate(assignment.last_contact_at) : 'Never'} />
        {assignment.notes && (
          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: `${NAVY}08`, border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--txt)', lineHeight: 1.5 }}>
            {assignment.notes}
          </div>
        )}
      </div>

      {/* Contact history */}
      {contacts.length > 0 && (
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <div style={SEC_TITLE}>Contact History</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {contacts.map(c => (
              <div key={c.id} style={{ padding: '9px 12px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--bg)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>{c.outcome}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--txt3)', fontFamily: MONO }}>{fmtDate(c.created_at)}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--txt3)', textTransform: 'capitalize' }}>{c.contact_type}</div>
                {c.notes && <div style={{ fontSize: 12, color: 'var(--txt)', marginTop: 4, lineHeight: 1.5 }}>{c.notes}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action tabs */}
      <div style={{ padding: '16px 22px', flex: 1 }}>
        <div style={SEC_TITLE}>Actions</div>

        {/* Tab nav */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid var(--bdr)', paddingBottom: 0 }}>
          {ACTION_TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '6px 11px', fontSize: 12, fontWeight: tab === t.key ? 600 : 500,
                color: tab === t.key ? NAVY : 'var(--txt2)',
                border: 'none', background: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${tab === t.key ? NAVY : 'transparent'}`,
                marginBottom: -1, fontFamily: SORA,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'call'     && <LogCallTab     assignmentId={assignment.id} onDone={onAction} />}
        {tab === 'ptp'      && <RecordPTPTab   assignmentId={assignment.id} onDone={onAction} />}
        {tab === 'assign'   && <AssignAgentTab assignmentId={assignment.id} agents={agents} onDone={onAction} />}
        {tab === 'escalate' && <EscalateTab    assignmentId={assignment.id} onDone={onAction} />}

        <SendToRecovery assignment={assignment} onDone={onAction} />
      </div>
    </div>
  )
}

// ── Bulk reassign modal ───────────────────────────────────────────────────────

function ReassignModal({ open, onClose, selectedIds, agents, onDone }: {
  open: boolean; onClose: () => void
  selectedIds: Set<number>; agents: AgentUser[]; onDone: () => void
}) {
  const [agentId, setAgentId] = useState('')
  const [notes, setNotes]     = useState('')
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  const collectionAgents = agents.filter(a => a.role.includes('collection') || a.role === 'admin' || a.role === 'management')

  async function submit() {
    if (!agentId) return
    setSaving(true); setErr(null)
    try {
      await Promise.all([...selectedIds].map(id => apiPut(`/api/collections-ops/${id}/assign`, { agent_id: Number(agentId), notes })))
      toast.success(`${selectedIds.size} account${selectedIds.size !== 1 ? 's' : ''} reassigned`)
      setAgentId(''); setNotes(''); onDone()
    } catch (e: any) { setErr(e.message ?? 'Reassign failed') }
    finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Reassign ${selectedIds.size} Account${selectedIds.size !== 1 ? 's' : ''}`} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Agent</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
            <option value="">Select agent…</option>
            {collectionAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={submit} loading={saving} disabled={!agentId}>Assign {selectedIds.size} Account{selectedIds.size !== 1 ? 's' : ''}</Btn>
          <Btn onClick={onClose} secondary>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const DPD_BUCKETS = ['1-30', '31-60', '61-90', '91-180', '181-360']

export default function CollectionsQueue() {
  const [items,   setItems]   = useState<Assignment[]>([])
  const [agents,  setAgents]  = useState<AgentUser[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [selected,     setSelected]     = useState<Assignment | null>(null)
  const [checkedIds,   setCheckedIds]   = useState<Set<number>>(new Set())
  const [reassignOpen, setReassignOpen] = useState(false)

  const [search,     setSearch]     = useState('')
  const [dpdFilter,  setDpdFilter]  = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [queueRes, usersRes] = await Promise.all([
        apiFetch<{ data: Assignment[] }>('/api/collections-ops/queue?limit=100'),
        apiFetch<{ data: AgentUser[] }>('/api/admin/users'),
      ])
      setItems(queueRes.data ?? [])
      setAgents(usersRes.data ?? [])
    } catch (e: any) { setErr(e.message ?? 'Failed to load queue') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function toggleDpd(bucket: string) {
    setDpdFilter(prev => {
      const next = new Set(prev); next.has(bucket) ? next.delete(bucket) : next.add(bucket)
      return next
    })
  }

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  const filtered = (() => {
    let r = [...items]
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(x => x.account_cif.toLowerCase().includes(q) || (x.agent_name ?? '').toLowerCase().includes(q))
    }
    if (dpdFilter.size) r = r.filter(x => dpdFilter.has(x.dpd_bucket))
    return r
  })()

  const activeCount = dpdFilter.size

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, fontFamily: SORA }}>

      {/* ── Left + right split ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left panel */}
        <div style={{
          width: 360, minWidth: 300, maxWidth: 400, flexShrink: 0,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)',
        }}>
          {/* Search + filter toolbar */}
          <div style={{ padding: '10px 12px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            {/* Search */}
            <TblSearch
              value={search}
              onChange={setSearch}
              placeholder="Search CIF or agent…"
              width={0}
              style={{ marginBottom: 8, flexShrink: 1 }}
            />

            {/* DPD filter chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {DPD_BUCKETS.map(b => {
                const on = dpdFilter.has(b)
                return (
                  <button
                    key={b}
                    onClick={() => toggleDpd(b)}
                    style={{
                      fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                      border: `1px solid ${on ? dpdColor(b) : 'var(--bdr)'}`,
                      background: on ? `${dpdColor(b)}18` : 'transparent',
                      color: on ? dpdColor(b) : 'var(--txt3)',
                      cursor: 'pointer', fontFamily: SORA,
                    }}
                  >
                    {b}
                  </button>
                )
              })}
              {dpdFilter.size > 0 && (
                <button onClick={() => setDpdFilter(new Set())} style={{ fontSize: 10.5, fontWeight: 500, padding: '2px 8px', borderRadius: 99, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt3)', cursor: 'pointer', fontFamily: SORA }}>
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: '#F0F4FF', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>{checkedIds.size} selected</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => setReassignOpen(true)} style={{ fontSize: 11.5, fontWeight: 600, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer', fontFamily: SORA }}>
                  Reassign
                </button>
                <button onClick={() => setCheckedIds(new Set())} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%', fontSize: 14 }}>
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Count bar */}
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--bdr)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.08em', fontFamily: MONO }}>
              {activeCount > 0 ? 'Filtered' : 'All accounts'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--txt3)', fontFamily: MONO }}>{filtered.length} of {items.length}</span>
          </div>

          {/* Error */}
          {err && <div style={{ padding: '10px 12px' }}><ErrBanner error={err} onRetry={load} /></div>}

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: 13 }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: 13 }}>
                No accounts match the current filters.
              </div>
            ) : filtered.map(item => {
              const isSelected = selected?.id === item.id
              const isChecked  = checkedIds.has(item.id)
              return (
                <div
                  key={item.id}
                  onClick={() => setSelected(item)}
                  style={{
                    padding: '11px 12px', borderBottom: '1px solid var(--bdr)',
                    cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 8,
                    background: isSelected ? `${NAVY}08` : undefined,
                    borderLeft: `3px solid ${isSelected ? NAVY : 'transparent'}`,
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                >
                  <input
                    type="checkbox" checked={isChecked}
                    onClick={e => toggleCheck(item.id, e)} onChange={() => {}}
                    style={{ marginTop: 4, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                      <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.account_cif}
                      </span>
                      <DpdBadge bucket={item.dpd_bucket} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtKobo(item.outstanding_kobo)}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--txt3)' }}>
                        {item.last_contact_at ? fmtDate(item.last_contact_at) : 'No contact'}
                      </span>
                    </div>
                    {item.agent_name && (
                      <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>{item.agent_name}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          {selected ? (
            <DetailPanel key={selected.id} assignment={selected} agents={agents} onAction={load} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt3)' }}>
              <IcoTune width={32} height={32} style={{ opacity: 0.3 }} />
              <span style={{ fontSize: 13 }}>Select an account from the list</span>
            </div>
          )}
        </div>
      </div>

      {/* Bulk reassign modal */}
      <ReassignModal
        open={reassignOpen} onClose={() => setReassignOpen(false)}
        selectedIds={checkedIds} agents={agents}
        onDone={() => { setReassignOpen(false); setCheckedIds(new Set()); load() }}
      />
    </div>
  )
}
