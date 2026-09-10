import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Page, ExpandableFilterBar, Tabs, ConfirmModal, ErrBanner, Spinner, Modal,
  filterInputStyle, NameCell, ActionRow, KpiCard,
} from '../../components/UI'
import type { FilterGroupDef } from '../../components/UI'
import { RepaymentPatternMini } from '../../components/RepaymentPatternMini'
import { dispositionsFor } from '../../components/LogCallModal'
import CallsPanel from '../../components/CallsPanel'
import { COLLECTIONS_PAYMENT_CHANNELS } from '../../lib/paymentChannels'
import { BankLogo } from '../../components/BankLogo'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKoboExact, fmtExact, fmtNum, fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, DARKRED, NAVY, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentUser { id: number; full_name: string; role: string }

// Who can be assigned collections work. There is no dedicated collections-agent
// role yet, so the pool includes the call-centre team plus collections roles and
// the relevant heads/admin.
const isCollectionsStaff = (role: string) =>
  role.includes('collection') || role.includes('call_center') ||
  ['admin', 'management', 'head_ops'].includes(role)

function storedRole(): string {
  try { return (JSON.parse(localStorage.getItem('o3c_user') ?? 'null') as { role?: string } | null)?.role ?? '' } catch { return '' }
}
function storedUserId(): number | null {
  try { return (JSON.parse(localStorage.getItem('o3c_user') ?? 'null') as { id?: number } | null)?.id ?? null } catch { return null }
}
const HEAD_ROLES = ['collections_head', 'head_collections', 'admin', 'management', 'md', 'coo', 'head_ops']

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
  // 'card' (default) or 'loan'; and provenance: 'core' (Udara/live feed) vs
  // 'manual' (bulk-loaded from an uploaded spreadsheet — see collectionsOpsQueue).
  product_type: string | null
  data_source: string | null
  customer_id: string | null      // universal workspace id (every customer has one)
  real_cif: string | null         // the card CIF, only when the customer actually has one
  // Loan fields (product_type='loan'; from the uploaded sheet — migration 204).
  loan_ref: string | null          // Mandate ID
  officer_name: string | null
  loan_tenor: string | null
  repayment_kobo: number | null
  loan_rate: string | null
  debit_day: string | null
  disbursement_date: string | null
  maturity_date: string | null
  // Per-row enrichment (see collectionsOpsQueue). Billing values are NAIRA.
  customer_name: string | null
  full_address: string | null
  city: string | null
  state: string | null
  phone: string | null
  current_bill: number | null
  bill_balance: number | null
  min_payment: number | null
  credit_limit: number | null
  last_payment_amount: number | null
  last_payment_date: string | null
  payment_due_date: string | null
  recovery_agent_name: string | null
  recovery_status: string | null
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

// ── Source provenance badge ─────────────────────────────────────────────────
// Marks rows that were bulk-loaded from an uploaded spreadsheet, so they read as
// distinct from the Udara core-banking feed. Only shown for data_source='manual'.
// Provenance chip: Uploaded (manual spreadsheet), CCS (cards) or Udara (core loans).
function SourceBadge({ source, product }: { source: string | null; product?: string | null }) {
  const uploaded = source === 'manual'
  let label: string, color: string, txt: string, icon: string, title: string
  if (uploaded) {
    label = product === 'loan' ? 'Uploaded loan' : 'Manual upload'
    color = AMBER; txt = DARKRED; icon = 'upload_file'
    title = 'Uploaded from a spreadsheet — not from CCS or Udara'
  } else if (product === 'card') {
    label = 'CCS'; color = BLUE; txt = BLUE; icon = 'credit_card'
    title = 'From the CCS card system'
  } else {
    label = 'Udara'; color = GREEN; txt = GREEN; icon = 'verified'
    title = 'From the Udara core banking system'
  }
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: TEXT.xs, fontWeight: FW.semibold,
        padding: '1px 7px', borderRadius: RADIUS['2xl'],
        background: `${color}1A`, color: txt,
        border: `1px solid ${color}55`, whiteSpace: 'nowrap',
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{icon}</span>
      {label}
    </span>
  )
}

// The imported note carries a leading 'imp:<marker> | …' tag used for reversibility;
// strip that first segment for display so the officer sees only the loan detail.
function cleanNote(notes: string | null): string | null {
  if (!notes) return null
  if (notes.startsWith('imp:')) {
    const i = notes.indexOf(' | ')
    return i >= 0 ? notes.slice(i + 3) : null
  }
  return notes
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
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
}

// ── Log Call tab ──────────────────────────────────────────────────────────────

// Use the CENTRAL collections disposition set (shared with the call-centre log-call
// form) so the queue speaks the same workflow vocabulary — PTP / Paid / Dispute /
// Callback Scheduled / Escalated / Wrong Number / Unreachable / Call Dropped.
const DISPOSITIONS = dispositionsFor('collections')

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


// ── Log Payment tab ───────────────────────────────────────────────────────────

const PAYMENT_CHANNELS = COLLECTIONS_PAYMENT_CHANNELS

function LogPaymentTab({ assignmentId, onDone }: { assignmentId: number; onDone: () => void }) {
  const [amountNaira, setAmountNaira] = useState('')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10))
  const [channel,     setChannel]     = useState(COLLECTIONS_PAYMENT_CHANNELS[0].value)
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
          {PAYMENT_CHANNELS.map(c => {
            const on = channel === c.value
            return (
              <button key={c.value} onClick={() => setChannel(c.value)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 11px 4px 6px', borderRadius: RADIUS.md, fontSize: TEXT.xs,
                  fontWeight: FW.semibold, cursor: 'pointer',
                  border: `1.5px solid ${on ? NAVY : 'var(--bdr)'}`,
                  background: on ? `${NAVY}0E` : 'var(--card)',
                  color: on ? NAVY : 'var(--txt)',
                }}
              ><BankLogo code={c.value} size={20} />{c.label}</button>
            )
          })}
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
            <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: GREEN, ...NUM }}>{fmtKoboExact(p.amount_kobo)}</span>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>Send to recovery?</span>
        <button onClick={send} disabled={saving} style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: 'none', background: RED, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
          {saving ? 'Sending…' : 'Confirm'}
        </button>
        <button onClick={() => setConfirming(false)} style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer' }}>Cancel</button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: `1.5px solid ${RED}`, background: 'rgba(192,0,0,.06)', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>assignment_late</span>
      Send to Recovery
    </button>
  )
}

function DetailPanel({
  assignment,
  onAction,
}: {
  assignment: Assignment
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)' }}>
                {assignment.customer_name ?? `CIF: ${assignment.account_cif}`}
              </span>
              <SourceBadge source={assignment.data_source} product={assignment.product_type} />
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              {assignment.product_type === 'loan'
                ? `Customer ${assignment.customer_id ?? assignment.account_cif}${assignment.phone ? ` · ${assignment.phone}` : ''}`
                : `CIF ${assignment.real_cif ?? assignment.account_cif}${assignment.phone ? ` · ${assignment.phone}` : ''}`}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <DpdBadge bucket={assignment.dpd_bucket} />
            <button
              onClick={() => navigate(`/collections/accounts/${assignment.account_cif}`)}
              style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: `1.5px solid ${NAVY}`, background: NAVY, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
            >
              Full Detail
            </button>
            <button
              onClick={() => navigate(`/contacts/${assignment.account_cif}`)}
              style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
            >
              C360
            </button>
            {/* Account-level escalation lives with the other account actions in the
                header, not dangling under the routine call/PTP/payment tabs. */}
            <SendToRecoveryButton assignment={assignment} onDone={onAction} />
          </div>
        </div>
      </div>

      {/* Loan summary */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
          Loan Summary
        </div>
        <LV label="Outstanding" value={<span style={NUM}>{fmtKoboExact(assignment.outstanding_kobo)}</span>} />
        <LV label="DPD Bucket"  value={<DpdBadge bucket={assignment.dpd_bucket} />} />
        <LV label="Stage"       value={assignment.current_stage ?? '—'} />
        <LV label="Assigned On" value={fmtDate(assignment.assignment_date)} />
        <LV label="Last Contact" value={fmtDate(assignment.last_contact_at)} />
        <LV label="Collections Agent" value={assignment.agent_name ?? <span style={{ color: RED }}>Unassigned</span>} />
        <LV label="Recovery Agent" value={
          assignment.recovery_agent_name
            ? <span>{assignment.recovery_agent_name}{assignment.recovery_status ? ` · ${assignment.recovery_status}` : ''}</span>
            : <span style={{ color: 'var(--txt3)' }}>Not in recovery</span>
        } />
        {cleanNote(assignment.notes) && (
          <div style={{
            marginTop: 8, padding: '8px 10px', borderRadius: RADIUS.sm,
            background: 'rgba(14,40,65,0.04)', border: '1px solid var(--bdr)',
            fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.5,
          }}>
            {cleanNote(assignment.notes)}
          </div>
        )}
      </div>

      {/* Loan details — the fields from the uploaded Loan Repayment CRM sheet, in
          their own columns (migration 204), shown only for uploaded loans. */}
      {assignment.product_type === 'loan' && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
            Loan Details
          </div>
          <LV label="Customer ID"  value={assignment.customer_id ?? '—'} />
          <LV label="Mandate ID"   value={assignment.loan_ref ?? '—'} />
          <LV label="Officer"      value={assignment.officer_name ?? '—'} />
          <LV label="Approved"     value={<span style={NUM}>{fmtKoboExact(assignment.outstanding_kobo)}</span>} />
          <LV label="Repayment"    value={assignment.repayment_kobo != null ? <span style={NUM}>{fmtKoboExact(assignment.repayment_kobo)}</span> : '—'} />
          <LV label="Tenor"        value={assignment.loan_tenor ?? '—'} />
          <LV label="Rate"         value={assignment.loan_rate ? `${assignment.loan_rate}%` : '—'} />
          <LV label="Debit Day"    value={assignment.debit_day ?? '—'} />
          <LV label="Disbursed"    value={fmtDate(assignment.disbursement_date)} />
          <LV label="Matures"      value={fmtDate(assignment.maturity_date)} />
        </div>
      )}

      {/* Address & card billing */}
      {(assignment.full_address || assignment.current_bill != null || assignment.bill_balance != null ||
        assignment.min_payment != null || assignment.last_payment_amount != null) && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
            Address & Billing
          </div>
          {assignment.full_address && <LV label="Address" value={assignment.full_address} />}
          {(assignment.city || assignment.state) && (
            <LV label="City / State" value={[assignment.city, assignment.state].filter(Boolean).join(', ') || '—'} />
          )}
          {assignment.current_bill != null && <LV label="Current Bill"  value={<span style={NUM}>{fmtExact(assignment.current_bill)}</span>} />}
          {assignment.bill_balance != null && <LV label="Bill Balance"  value={<span style={NUM}>{fmtExact(assignment.bill_balance)}</span>} />}
          {assignment.min_payment  != null && <LV label="Min Payment"   value={<span style={NUM}>{fmtExact(assignment.min_payment)}</span>} />}
          {assignment.credit_limit != null && <LV label="Credit Limit"  value={<span style={NUM}>{fmtExact(assignment.credit_limit)}</span>} />}
          {assignment.payment_due_date && <LV label="Payment Due"   value={fmtDate(assignment.payment_due_date)} />}
          {assignment.last_payment_amount != null && (
            <LV label="Last Payment" value={
              <span><span style={NUM}>{fmtExact(assignment.last_payment_amount)}</span>{assignment.last_payment_date ? <span style={{ color: 'var(--txt2)', fontWeight: FW.normal }}> · {fmtDate(assignment.last_payment_date)}</span> : null}</span>
            } />
          )}
        </div>
      )}

      {/* Repayment cadence (real money-in from the transaction feed, same as C360) */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Repayment Pattern
        </div>
        <RepaymentPatternMini cif={assignment.account_cif} endpointBase="/api/collections-ops" />
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

      {/* Call-centre activity — calls the call centre has made to this customer,
          crosswalked by CIF / phone (read-only; dispositions come from the call log). */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Call Centre Activity
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 10, marginTop: 2 }}>
          Calls dialled by the call-centre / telesales team (from the phone system), matched to this customer.
        </div>
        <CallsPanel cif={assignment.account_cif} />
      </div>

      {/* Contact history */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Contact History
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 10, marginTop: 2 }}>
          Touches a collections officer logged here (call, SMS, email, visit) with the disposition and notes.
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
        {tab === 'escalate' && <EscalateTab    assignmentId={assignment.id} onDone={refreshHistory} />}
      </div>
    </div>
  )
}

function DistributeModal({ open, onClose, agents, unassignedCount, onDone }: {
  open: boolean; onClose: () => void; agents: AgentUser[]; unassignedCount: number; onDone: () => void
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState<string | null>(null)
  const pool = agents.filter(a => isCollectionsStaff(a.role))

  function toggle(id: number) {
    setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  async function submit() {
    if (picked.size === 0) return
    setSaving(true); setErr(null)
    try {
      const r = await apiPost<{ distributed: number }>('/api/collections-ops/distribute', { agent_ids: [...picked] })
      toast.success(`${r.distributed ?? 0} account(s) distributed across ${picked.size} agent(s)`)
      setPicked(new Set()); onDone()
    } catch (e: any) { setErr(e.message ?? 'Distribute failed') } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Distribute Queue" width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <p style={{ margin: 0, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          Round-robin every unassigned account across the agents you pick (largest balances spread first).
          {unassignedCount > 0 && <> <b>{unassignedCount}</b> unassigned on this page.</>}
        </p>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Agents on shift</label>
            <button onClick={() => setPicked(picked.size === pool.length ? new Set() : new Set(pool.map(a => a.id)))}
              style={{ background: 'none', border: 'none', color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
              {picked.size === pool.length && pool.length > 0 ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }}>
            {pool.length === 0 && <div style={{ padding: 14, color: 'var(--txt3)', fontSize: TEXT.sm }}>No eligible staff found.</div>}
            {pool.map(a => (
              <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}>
                <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', flex: 1 }}>{a.full_name}</span>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{a.role}</span>
              </label>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={picked.size === 0 || saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, border: 'none',
              background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: picked.size === 0 || saving ? 'not-allowed' : 'pointer', opacity: picked.size === 0 || saving ? 0.6 : 1,
            }}>
            {saving && <Spinner size={13} color="#fff" />}
            Distribute to {picked.size} agent{picked.size !== 1 ? 's' : ''}
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
  const [bulkAgentId, setBulkAgentId] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [distributeOpen, setDistributeOpen] = useState(false)
  const isHead = HEAD_ROLES.includes(storedRole())

  // Filters
  const [fDpd,     setFDpd]     = useState(new Set<string>())
  const [fContact, setFContact] = useState(new Set<string>())
  const [fProduct, setFProduct] = useState(new Set<string>())
  const [search,   setSearch]   = useState('')

  // Agent scope from the URL: ?mine=1 (this agent's own book, from the My-Dashboard
  // tiles) or ?agent=<id> (a specific agent, from the Supervisor leaderboard's "View
  // queue"). Filtered server-side via agent_id so it spans the whole queue, and shown
  // as a clearable banner. A collections_agent is already auto-scoped server-side, so
  // this mainly narrows the head/supervisor view.
  const [searchParams, setSearchParams] = useSearchParams()
  const myId = storedUserId()
  const [agentFilter, setAgentFilter] = useState<number | null>(() => {
    if (searchParams.get('mine') === '1') return myId
    const a = searchParams.get('agent')
    return a ? Number(a) : null
  })
  useEffect(() => {
    if (searchParams.get('mine') === '1') { setAgentFilter(myId); return }
    const a = searchParams.get('agent')
    setAgentFilter(a ? Number(a) : null)
  }, [searchParams, myId])

  const fDpdKey = [...fDpd].sort().join(',')
  // Product filter is single-valued server-side (card|loan); only apply when exactly
  // one is chosen — both (or none) means "all".
  const fProductKey = fProduct.size === 1 ? [...fProduct][0] : ''
  // Search on the server (CIF or agent name) so it spans the whole queue, not just the
  // loaded page of 100. Debounced to one request per pause.
  const dq = useDebouncedValue(search, 300)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: '100' })
    if (fDpdKey)     params.set('dpd_bucket', fDpdKey)
    if (fProductKey) params.set('product_type', fProductKey)
    if (dq.trim())   params.set('q', dq.trim())
    if (agentFilter) params.set('agent_id', String(agentFilter))

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
  }, [fDpdKey, fProductKey, dq, agentFilter])

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

    // Text search runs on the server now (see load); no client-side text filter here.
    return result
  }, [items, fContact])

  // Compact KPI strip — everything is derived from the page already loaded, so it
  // costs no extra request and always agrees with the list below it.
  const kpis = useMemo(() => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const untouched = items.filter(r => !r.last_contact_at || new Date(r.last_contact_at) < startOfDay).length
    const unassigned = items.filter(r => !r.agent_name).length
    const outstanding = items.reduce((sum, r) => sum + (r.outstanding_kobo || 0), 0)
    return { inQueue: items.length, untouched, unassigned, outstanding }
  }, [items])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections','loans'] })

  const groups: FilterGroupDef[] = [
    {
      key: 'product',
      label: 'PRODUCT',
      options: [{ value: 'card', label: 'Cards' }, { value: 'loan', label: 'Loans' }],
      selected: fProduct,
      onChange: setFProduct,
    },
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

  const clearAgentFilter = useCallback(() => {
    setAgentFilter(null)
    const next = new URLSearchParams(searchParams)
    next.delete('mine'); next.delete('agent')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const agentFilterName = agentFilter == null ? ''
    : agentFilter === myId ? 'your accounts'
    : `${agents.find(a => a.id === agentFilter)?.full_name ?? 'this agent'}’s accounts`

  function resetFilters() { setFDpd(new Set()); setFContact(new Set()); setFProduct(new Set()); setSearch(''); clearAgentFilter() }

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearChecked() { setCheckedIds(new Set()); setBulkAgentId('') }

  // Bulk assign, call-centre style: tick accounts in the list, pick an agent in the
  // selection bar, Assign. Replaces the per-account "Assign Agent" tab that used to
  // live in the detail panel.
  const collectionAgents = agents.filter(a => isCollectionsStaff(a.role))

  async function handleBulkAssign() {
    if (!bulkAgentId || checkedIds.size === 0) return
    setAssigning(true)
    try {
      await Promise.all([...checkedIds].map(id =>
        apiPut(`/api/collections-ops/${id}/assign`, { agent_id: Number(bulkAgentId), notes: '' })
      ))
      const name = collectionAgents.find(a => a.id === Number(bulkAgentId))?.full_name ?? 'agent'
      toast.success(`${checkedIds.size} account${checkedIds.size !== 1 ? 's' : ''} assigned to ${name}`)
      setBulkAgentId(''); setCheckedIds(new Set()); load()
    } catch (e: any) {
      toast.error(e.message ?? 'Assign failed')
    } finally { setAssigning(false) }
  }

  return (
    <Page
      title="Collections Queue"
      subtitle="Manage and work assigned collection accounts"
      noPad
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isHead && (
            <button
              onClick={() => setDistributeOpen(true)}
              title="Round-robin all unassigned accounts across selected agents"
              style={{
                padding: '6px 14px', borderRadius: RADIUS.md, cursor: 'pointer', border: 'none',
                background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>groups</span>
              Distribute Queue
            </button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

        {/* ── KPI strip ──────────────────────────────────────────────────────── */}
        <div style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--bdr)',
          flexShrink: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
        }}>
          <KpiCard label="Accounts in Queue" value={fmtNum(kpis.inQueue)} icon="account_balance" accent={NAVY} loading={loading} />
          <KpiCard label="Untouched Today"   value={fmtNum(kpis.untouched)}  sub="no contact yet today" icon="notifications_active" accent={AMBER} loading={loading} />
          <KpiCard label="Unassigned"        value={fmtNum(kpis.unassigned)} sub="awaiting an agent"    icon="person_off" accent={RED} loading={loading} />
          <KpiCard label="Outstanding in View" value={fmtKoboExact(kpis.outstanding)} icon="payments" accent={GREEN} loading={loading} />
        </div>

        {/* ── Master / detail ────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

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

          {/* Agent-scope banner — set by ?mine=1 / ?agent=<id>, clearable */}
          {agentFilter != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: `${NAVY}0D`, borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: NAVY }}>filter_alt</span>
              <span style={{ fontSize: TEXT.sm, color: NAVY, fontWeight: FW.semibold }}>Showing {agentFilterName}</span>
              <button onClick={clearAgentFilter} style={{ marginLeft: 'auto', fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt2)', background: 'none', border: '1px solid var(--bdr)', borderRadius: RADIUS.sm, padding: '3px 9px', cursor: 'pointer' }}>Clear</button>
            </div>
          )}

          {/* Batch bar — call-centre style: pick an agent, Assign the ticked accounts */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', background: `${NAVY}0D`,
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, whiteSpace: 'nowrap' }}>
                {checkedIds.size} selected
              </span>
              <select
                value={bulkAgentId}
                onChange={e => setBulkAgentId(e.target.value)}
                style={{ ...filterInputStyle, height: 30, minWidth: 0, flex: 1 }}
              >
                <option value="">Assign to…</option>
                {collectionAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
              </select>
              <button
                onClick={handleBulkAssign}
                disabled={!bulkAgentId || assigning}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
                  padding: '4px 12px', borderRadius: RADIUS.sm, border: 'none',
                  background: !bulkAgentId || assigning ? `${NAVY}66` : NAVY, color: '#fff',
                  fontSize: TEXT.sm, fontWeight: FW.semibold,
                  cursor: !bulkAgentId || assigning ? 'not-allowed' : 'pointer',
                }}
              >
                {assigning && <Spinner size={11} color="#fff" />}
                Assign
              </button>
              <button onClick={clearChecked} style={{
                width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%', flexShrink: 0,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
              </button>
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
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <NameCell
                            name={item.customer_name ?? item.account_cif}
                            sub={item.product_type === 'loan'
                              ? `Loan${item.agent_name ? ` · ${item.agent_name}` : ''}`
                              : `CIF ${item.account_cif}${item.agent_name ? ` · ${item.agent_name}` : ''}`}
                            avatar={false}
                          />
                          <div style={{ marginTop: 3 }}>
                            <SourceBadge source={item.data_source} product={item.product_type} />
                          </div>
                        </div>
                        <DpdBadge bucket={item.dpd_bucket} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                          {fmtKoboExact(item.outstanding_kobo)}
                        </span>
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                          {item.last_contact_at ? `Contact: ${fmtDate(item.last_contact_at)}` : 'No contact yet'}
                        </span>
                      </div>
                      {item.last_payment_amount != null && (
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4 }}>
                          Last paid <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtExact(item.last_payment_amount)}</span>
                          {item.last_payment_date ? ` · ${fmtDate(item.last_payment_date)}` : ''}
                        </div>
                      )}
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

        </div>{/* master / detail */}

      </div>

      <DistributeModal
        open={distributeOpen}
        onClose={() => setDistributeOpen(false)}
        agents={agents}
        unassignedCount={items.filter(a => !a.agent_name).length}
        onDone={() => { setDistributeOpen(false); load() }}
      />
    </Page>
  )
}
