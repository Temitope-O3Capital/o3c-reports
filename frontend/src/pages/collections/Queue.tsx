import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, ExpandableFilterBar, Tabs, ConfirmModal, ErrBanner, Spinner, Modal,
  filterInputStyle, DateFilter, NameCell, ActionRow,
} from '../../components/UI'
import type { FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, monthStart, today } from '../../lib/fmt'
import { GREEN, AMBER, RED, DARKRED, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
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
  agent_name: string | null
}

interface PaymentEntry {
  id: number
  amount_kobo: number
  payment_date: string
  payment_method: string | null
  reference: string | null
  received_by_name: string | null
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
      fontSize: TEXT.xs, fontWeight: FW.bold,
      padding: '2px 7px', borderRadius: RADIUS['2xl'],
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
    <div style={{ display: 'flex', gap: SP[2], marginBottom: SP[2] }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', width: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{value ?? '—'}</span>
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
        padding: '7px 14px', borderRadius: RADIUS.md, border: 'none',
        background: danger ? RED : NAVY, color: '#fff',
        fontSize: TEXT.base, fontWeight: FW.semibold,
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
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
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
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
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
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Notes
        </label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Promise Amount (NGN)
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
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
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
      const res = await apiPost<{ case_ref: string }>(`/api/collections-ops/${assignmentId}/send-to-recovery`, { notes: reason })
      toast.success(`Recovery case ${res?.case_ref ?? ''} created`)
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
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Escalation Reason
        </label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Agent
        </label>
        <select value={agentId} onChange={e => setAgentId(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}>
          <option value="">Select agent…</option>
          {collectionAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Notes
        </label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!agentId}>Assign Agent</Btn>
    </div>
  )
}

// ── Log Payment tab ───────────────────────────────────────────────────────────

const PAYMENT_CHANNELS = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cash',          label: 'Cash' },
  { value: 'pos',           label: 'POS' },
  { value: 'mobile_money',  label: 'Mobile Money' },
  { value: 'cheque',        label: 'Cheque' },
]

function LogPaymentTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [amountNaira, setAmountNaira] = useState('')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10))
  const [channel,     setChannel]     = useState('bank_transfer')
  const [reference,   setReference]   = useState('')
  const [saving,      setSaving]      = useState(false)
  const [err,         setErr]         = useState<string | null>(null)

  async function submit() {
    const naira = parseFloat(amountNaira)
    if (!naira || naira <= 0 || !paymentDate) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/collections-ops/${assignmentId}/payment`, {
        amount_kobo:  Math.round(naira * 100),
        payment_date: paymentDate,
        channel,
        reference: reference.trim() || null,
      })
      toast.success('Payment logged')
      setAmountNaira(''); setReference('')
      setPaymentDate(new Date().toISOString().slice(0, 10))
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to log payment')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Amount (₦)</label>
        <input
          type="number" min="0" step="0.01" placeholder="0.00"
          value={amountNaira} onChange={e => setAmountNaira(e.target.value)}
          style={{ ...fieldStyle, height: 36, fontSize: TEXT.lg, fontWeight: FW.bold }}
          autoFocus
        />
      </div>
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Payment Date</label>
        <input
          type="date"
          value={paymentDate}
          max={new Date().toISOString().slice(0, 10)}
          onChange={e => setPaymentDate(e.target.value)}
          style={{ ...fieldStyle, height: 36 }}
        />
      </div>
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Channel</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PAYMENT_CHANNELS.map(c => (
            <button key={c.value} onClick={() => setChannel(c.value)}
              style={{
                padding: '4px 11px', borderRadius: RADIUS.md, fontSize: TEXT.xs,
                fontWeight: FW.semibold, cursor: 'pointer',
                border: `1.5px solid ${channel === c.value ? NAVY : 'var(--bdr)'}`,
                background: channel === c.value ? NAVY : 'var(--card)',
                color: channel === c.value ? '#fff' : 'var(--txt)',
              }}
            >{c.label}</button>
          ))}
        </div>
      </div>
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Reference <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span>
        </label>
        <input
          type="text" placeholder="e.g. TRF-2025-00123"
          value={reference} onChange={e => setReference(e.target.value)}
          style={{ ...fieldStyle, height: 36 }}
        />
      </div>
      <button
        onClick={submit}
        disabled={saving || !amountNaira || parseFloat(amountNaira) <= 0 || !paymentDate}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 14px', borderRadius: RADIUS.md, border: 'none',
          background: GREEN, color: '#fff',
          fontSize: TEXT.base, fontWeight: FW.semibold,
          cursor: saving || !amountNaira ? 'not-allowed' : 'pointer',
          opacity: saving || !amountNaira ? 0.6 : 1,
        }}
      >
        {saving && <Spinner size={13} color="#fff" />}
        Log Payment
      </button>
    </div>
  )
}

// ── Payment history section ───────────────────────────────────────────────────

function PaymentHistory({ payments, loading }: { payments: PaymentEntry[]; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], padding: '12px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>
        <Spinner size={14} color={GREEN} /> Loading payments…
      </div>
    )
  }
  if (!payments.length) {
    return <div style={{ fontSize: TEXT.base, color: 'var(--txt3)', padding: '8px 0' }}>No payments recorded.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {payments.map(p => (
        <div key={p.id} style={{
          padding: '10px 12px', borderRadius: 8,
          border: `1px solid ${GREEN}30`, background: `${GREEN}06`,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
            <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: GREEN, ...NUM }}>{fmtKobo(p.amount_kobo)}</span>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{fmtDate(p.payment_date)}</span>
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', display: 'flex', gap: 8 }}>
            <span style={{ textTransform: 'capitalize' }}>{(p.payment_method ?? 'unknown').replace(/_/g, ' ')}</span>
            {p.reference && <span>· Ref: {p.reference}</span>}
            {p.received_by_name && <span>· {p.received_by_name}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Contact history section ───────────────────────────────────────────────────

function ContactHistory({ contacts, loading }: { contacts: ContactEntry[]; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], padding: '12px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>
        <Spinner size={14} color={NAVY} /> Loading history…
      </div>
    )
  }
  if (!contacts.length) {
    return <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', padding: '8px 0' }}>No contact history found.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {contacts.map(c => (
        <div key={c.id} style={{
          padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--bdr)', background: 'var(--th-bg)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{c.outcome}</span>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDate(c.created_at)}</span>
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', textTransform: 'capitalize', display: 'flex', gap: 6 }}>
            <span>{c.contact_type}</span>
            {c.agent_name && <span>· {c.agent_name}</span>}
          </div>
          {c.notes && (
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', marginTop: 4, lineHeight: 1.5 }}>{c.notes}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Right panel: account detail ───────────────────────────────────────────────

const ACTION_TABS = [
  { key: 'call',     label: 'Log Call' },
  { key: 'ptp',      label: 'Record PTP' },
  { key: 'payment',  label: 'Log Payment' },
  { key: 'assign',   label: 'Assign Agent' },
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
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Send to recovery?</span>
        <button onClick={send} disabled={saving} style={{ padding: '4px 12px', borderRadius: RADIUS.sm, border: 'none', background: RED, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
          {saving ? 'Sending…' : 'Confirm'}
        </button>
        <button onClick={() => setConfirming(false)} style={{ padding: '4px 10px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer' }}>Cancel</button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      style={{ marginTop: 12, padding: '6px 14px', borderRadius: RADIUS.md, border: `1.5px solid ${RED}`, background: 'rgba(192,0,0,.06)', color: RED, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>assignment_late</span>
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
  const [tab,             setTab]             = useState('call')
  const [contacts,        setContacts]        = useState<ContactEntry[]>([])
  const [contactsLoading, setContactsLoading] = useState(true)
  const [payments,        setPayments]        = useState<PaymentEntry[]>([])
  const [paymentsLoading, setPaymentsLoading] = useState(true)

  const loadHistory = useCallback(async (id: number) => {
    setContactsLoading(true)
    setPaymentsLoading(true)
    try {
      const [cRes, pRes] = await Promise.all([
        apiFetch<{ data: ContactEntry[] }>(`/api/collections-ops/${id}/contacts`),
        apiFetch<{ data: PaymentEntry[] }>(`/api/collections-ops/${id}/payments`),
      ])
      setContacts(Array.isArray(cRes.data) ? cRes.data : [])
      setPayments(Array.isArray(pRes.data) ? pRes.data : [])
    } catch {
      setContacts([]); setPayments([])
    } finally {
      setContactsLoading(false); setPaymentsLoading(false)
    }
  }, [])

  useEffect(() => { loadHistory(assignment.id) }, [assignment.id, loadHistory])

  function refreshHistory() {
    loadHistory(assignment.id)
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
            <div style={{ fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 2 }}>
              CIF: {assignment.account_cif}
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              Assigned to: {assignment.agent_name ?? 'Unassigned'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <DpdBadge bucket={assignment.dpd_bucket} />
            <button
              onClick={() => navigate(`/contacts/${assignment.account_cif}`)}
              style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
            >
              Full profile →
            </button>
          </div>
        </div>
      </div>

      {/* Loan summary */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
          Loan Summary
        </div>
        <LV label="Outstanding" value={<span style={NUM}>{fmtKobo(assignment.outstanding_kobo)}</span>} />
        <LV label="DPD Bucket"  value={<DpdBadge bucket={assignment.dpd_bucket} />} />
        <LV label="Stage"       value={assignment.current_stage ?? '—'} />
        <LV label="Assigned On" value={fmtDate(assignment.assignment_date)} />
        <LV label="Last Contact" value={fmtDate(assignment.last_contact_at)} />
        {assignment.notes && (
          <div style={{
            marginTop: 8, padding: '8px 10px', borderRadius: RADIUS.sm,
            background: 'rgba(14,40,65,0.04)', border: '1px solid var(--bdr)',
            fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.5,
          }}>
            {assignment.notes}
          </div>
        )}
      </div>

      {/* Payment history */}
      {payments.length > 0 && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
            Payment History
          </div>
          <PaymentHistory payments={payments} loading={paymentsLoading} />
        </div>
      )}

      {/* Contact history */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Contact History
        </div>
        <ContactHistory contacts={contacts} loading={contactsLoading} />
      </div>

      {/* Action tabs */}
      <div style={{ padding: '16px 20px', flex: 1 }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Actions
        </div>
        <Tabs tabs={ACTION_TABS} active={tab} onChange={setTab} />
        {tab === 'call'     && <LogCallTab     assignmentId={assignment.id} onDone={refreshHistory} />}
        {tab === 'ptp'      && <RecordPTPTab   assignmentId={assignment.id} onDone={refreshHistory} />}
        {tab === 'payment'  && <LogPaymentTab  assignmentId={assignment.id} onDone={refreshHistory} />}
        {tab === 'assign'   && <AssignAgentTab assignmentId={assignment.id} agents={agents} onDone={refreshHistory} />}
        {tab === 'escalate' && <EscalateTab    assignmentId={assignment.id} onDone={refreshHistory} />}
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
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Agent
          </label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)}
            style={{ ...filterInputStyle, height: 36, width: '100%' }}>
            <option value="">Select agent…</option>
            {collectionAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Notes
          </label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={submit} disabled={!agentId || saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: RADIUS.md, border: 'none',
              background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: !agentId || saving ? 'not-allowed' : 'pointer',
              opacity: !agentId || saving ? 0.6 : 1,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            Assign {selectedIds.size} Account{selectedIds.size !== 1 ? 's' : ''}
          </button>
          <button onClick={onClose} style={{
            padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Left panel: queue list ────────────────────────────────────────────────────

const DPD_VALUES    = ['0', '1-30', '31-60', '61-90', '91-180', '181-360']
const CONTACT_VALUES = ['Today', 'This week', 'This month']

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
  const [fDpd,     setFDpd]     = useState(new Set<string>())
  const [fContact, setFContact] = useState(new Set<string>())
  const [search,   setSearch]   = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const fDpdKey = [...fDpd].sort().join(',')

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: '100' })
    if (fDpdKey)  params.set('dpd_bucket', fDpdKey)
    if (dateFrom) params.set('from', dateFrom)
    if (dateTo)   params.set('to', dateTo)

    try {
      const [queueRes, usersRes] = await Promise.all([
        apiFetch<{ data: Assignment[] }>(`/api/collections-ops/queue?${params}`),
        apiFetch<{ data: AgentUser[] }>('/api/admin/users'),
      ])
      setAgents(usersRes.data ?? [])
      setItems(queueRes.data ?? [])
      setSelected(prev => prev ? (queueRes.data ?? []).find(r => r.id === prev.id) ?? null : null)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load queue')
    } finally {
      setLoading(false)
    }
  }, [fDpdKey, dateFrom, dateTo])

  const displayed = useMemo(() => {
    let result = items

    // Client-side contact recency filter
    if (fContact.size) {
      const now = new Date()
      const startOf = (unit: 'day' | 'week' | 'month') => {
        const d = new Date(now)
        if (unit === 'day')   d.setHours(0, 0, 0, 0)
        if (unit === 'week')  { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()) }
        if (unit === 'month') { d.setHours(0, 0, 0, 0); d.setDate(1) }
        return d
      }
      result = result.filter(r => {
        if (!r.last_contact_at) return false
        const cd = new Date(r.last_contact_at)
        return (
          (fContact.has('Today')      && cd >= startOf('day'))   ||
          (fContact.has('This week')  && cd >= startOf('week'))  ||
          (fContact.has('This month') && cd >= startOf('month'))
        )
      })
    }

    // Client-side text search
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(item =>
        ['account_cif', 'dpd_bucket', 'agent_name'].some(k =>
          String((item as any)[k] ?? '').toLowerCase().includes(q)
        )
      )
    }

    return result
  }, [items, fContact, search])

  useEffect(() => { load() }, [load])

  const groups: FilterGroupDef[] = [
    {
      key: 'dpd',
      label: 'DPD BUCKET',
      options: DPD_VALUES.map(v => ({ value: v, label: `DPD ${v}` })),
      selected: fDpd,
      onChange: setFDpd,
    },
    {
      key: 'contact',
      label: 'LAST CONTACT',
      options: CONTACT_VALUES.map(v => ({ value: v })),
      selected: fContact,
      onChange: setFContact,
    },
  ]

  function resetFilters() { setFDpd(new Set()); setFContact(new Set()); setSearch('') }

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
    <Page
      title="Collections Queue"
      subtitle="Manage and work assigned collection accounts"
      noPad
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
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
          <ExpandableFilterBar
            search={search}
            onSearch={setSearch}
            groups={groups}
            onReset={resetFilters}
            onApply={load}
            resultCount={displayed.length}
            totalCount={items.length}
            placeholder="Search CIF, DPD, agent…"
          />

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>
                {checkedIds.size} selected
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setReassignOpen(true)}
                  style={{
                    fontSize: TEXT.xs, fontWeight: FW.medium, color: NAVY,
                    background: 'none', border: `1px solid ${NAVY}30`,
                    borderRadius: RADIUS.sm, padding: '3px 9px', cursor: 'pointer',
                  }}
                >
                  Reassign
                </button>
                <button onClick={clearChecked} style={{
                  width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%',
                }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : displayed.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: TEXT.base }}>
                No accounts match the current filters.
              </div>
            ) : (
              displayed.map(item => {
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
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                        <NameCell name={item.account_cif} sub={item.agent_name ?? null} avatar={false} />
                        <DpdBadge bucket={item.dpd_bucket} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                          {fmtKobo(item.outstanding_kobo)}
                        </span>
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                          {item.last_contact_at ? `Contact: ${fmtDate(item.last_contact_at)}` : 'No contact yet'}
                        </span>
                      </div>
                      <ActionRow actions={[
                        { icon: 'phone',       label: 'Call',       onClick: () => setSelected(item) },
                        { icon: 'handshake',   label: 'Record PTP', onClick: () => setSelected(item) },
                        { icon: 'visibility',  label: 'View',       onClick: () => setSelected(item) },
                      ]} />
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
              <span style={{ fontSize: TEXT.md }}>Select an account from the list</span>
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
