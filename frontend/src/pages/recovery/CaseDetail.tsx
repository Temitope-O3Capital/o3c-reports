import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Modal, ConfirmModal } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'

const POLL_INTERVAL = 10_000

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecoveryCase {
  id: number
  case_ref:               string | null
  account_cif:            string
  assigned_agent_id:      number | null
  agent_name:             string | null
  assigned_by_name:       string | null
  legal_stage:            string | null
  outstanding_kobo:       number
  recovered_kobo:         number
  write_off_amount_kobo:  number
  status:                 string
  opened_at:              string | null
  closed_at:              string | null
}

interface Payment {
  id: number; amount_kobo: number; payment_date: string
  channel: string; reference?: string; agent_name?: string; status: string
}
interface Visit {
  id: number; visit_date: string; visit_type: string; outcome: string
  notes?: string; agent_name?: string
}
interface Proceeding {
  id: number; proceeding_type: string; court_name?: string; case_number?: string
  filing_date: string; next_hearing_date?: string; status: string; notes?: string
}
interface WriteOffApproval {
  id: number; status: string; amount_kobo: number; reason: string
  approver_name?: string; approved_at?: string
}
interface ActivityEntry {
  id: number; module: string; entity_type: string; action: string
  detail?: string; created_at: string; actor_name?: string
}
interface CollContact {
  id: number; created_at: string; contact_type: string; outcome: string
  notes?: string; agent_name?: string
}
interface CollPromise {
  id: number; promised_date: string; promised_amount_kobo: number; is_kept: boolean
  notes?: string; agent_name?: string
}
interface AgentUser { id: number; full_name: string; role: string }

interface FullDetail {
  case:             RecoveryCase
  payments:         Payment[]
  proceedings:      Proceeding[]
  visits:           Visit[]
  write_off_approval: WriteOffApproval | null
  activity_log:     ActivityEntry[]
  coll_contacts:    CollContact[]
  coll_promises:    CollPromise[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStoredRole(): string {
  try {
    return (JSON.parse(localStorage.getItem('o3c_user') ?? 'null') as { role?: string } | null)?.role ?? ''
  } catch { return '' }
}

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  active:      { bg: `${BLUE}18`,           txt: BLUE },
  legal:       { bg: 'rgba(192,0,0,.10)',   txt: RED },
  closed:      { bg: 'rgba(75,85,99,.10)',  txt: '#6B7280' },
  written_off: { bg: 'rgba(75,85,99,.10)',  txt: '#6B7280' },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_COLORS[status.toLowerCase()] ?? { bg: `${NAVY}12`, txt: NAVY }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '3px 10px',
      borderRadius: RADIUS['2xl'], background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
    </span>
  )
}

function Btn({ children, onClick, disabled, loading: busy, danger, outline }: {
  children: React.ReactNode; onClick: () => void
  disabled?: boolean; loading?: boolean; danger?: boolean; outline?: boolean
}) {
  const bg = outline ? 'transparent' : danger ? RED : NAVY
  const color = outline ? NAVY : '#fff'
  const border = outline ? `1.5px solid ${NAVY}40` : 'none'
  return (
    <button onClick={onClick} disabled={disabled || busy} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '7px 14px', borderRadius: RADIUS.md, border,
      background: bg, color,
      fontSize: TEXT.base, fontWeight: FW.semibold,
      cursor: disabled || busy ? 'not-allowed' : 'pointer',
      opacity: disabled || busy ? 0.6 : 1,
    }}>
      {busy && <Spinner size={13} color={color} />}
      {children}
    </button>
  )
}

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5,
}
function LV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', width: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{value ?? '—'}</span>
    </div>
  )
}

// ── Action tab types ───────────────────────────────────────────────────────────

type ActionTab = 'visit' | 'legal' | 'payment' | 'writeoff' | 'reassign'

const VISIT_TYPES    = ['Physical Visit', 'Phone Call', 'WhatsApp', 'Email', 'Legal Notice']
const VISIT_OUTCOMES = ['Customer Met', 'Not Home', 'Promised to Pay', 'Refused to Pay', 'No Response', 'Other']
const PAY_CHANNELS   = ['Bank Transfer', 'Cash', 'Cheque', 'TPA', 'Legal Settlement', 'Self-Cure']
const LEGAL_TYPES    = ['Pre-Litigation Notice', 'Demand Letter', 'Court Filing', 'Judgment', 'Enforcement', 'Other']

// ── Timeline activity entry ────────────────────────────────────────────────────

const MODULE_COLORS: Record<string, string> = {
  collections: BLUE, recovery: AMBER, system: '#6B7280',
}
const ACTION_LABELS: Record<string, string> = {
  assigned: 'Assigned', reassigned: 'Reassigned', contact_logged: 'Contact Logged',
  ptp_created: 'PTP Created', ptp_kept: 'PTP Kept', ptp_broken: 'PTP Broken',
  payment_logged: 'Payment Recorded', watchlist_flagged: 'Added to Watchlist',
  watchlist_resolved: 'Watchlist Resolved', sent_to_recovery: 'Sent to Recovery',
  visit_logged: 'Field Visit Logged', legal_added: 'Legal Milestone Added',
  writeoff_submitted: 'Write-off Submitted', writeoff_approved: 'Write-off Approved',
  writeoff_rejected: 'Write-off Rejected',
}

function ActivityDot({ color }: { color: string }) {
  return (
    <div style={{ flexShrink: 0, width: 28, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, marginTop: 4 }} />
    </div>
  )
}

function TimelineItem({ actor, label, detail, date, color }: {
  actor?: string; label: string; detail?: string; date: string; color: string
}) {
  return (
    <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start' }}>
      <ActivityDot color={color} />
      <div style={{ flex: 1, paddingBottom: 16, paddingLeft: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{label}</span>
          <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{fmtDatetime(date)}</span>
        </div>
        {actor && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{actor}</div>}
        {detail && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 4, lineHeight: 1.5 }}>{detail}</div>}
      </div>
    </div>
  )
}

// ── Log Visit Modal ────────────────────────────────────────────────────────────

function LogVisitModal({ caseId, open, onClose, onDone }: {
  caseId: number; open: boolean; onClose: () => void; onDone: () => void
}) {
  const [visitDate, setVisitDate] = useState('')
  const [visitType, setVisitType] = useState('Physical Visit')
  const [outcome,   setOutcome]   = useState('')
  const [notes,     setNotes]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const [err,       setErr]       = useState<string | null>(null)

  async function submit() {
    if (!visitDate || !outcome) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/visit`, { visit_date: visitDate, visit_type: visitType, outcome, notes })
      toast.success('Visit logged')
      setOutcome(''); setNotes(''); setVisitDate(''); onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed') } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Log Visit / Contact" width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Date *</label>
            <input type="date" value={visitDate} onChange={e => setVisitDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} />
          </div>
          <div>
            <label style={labelStyle}>Type</label>
            <select value={visitType} onChange={e => setVisitType(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
              {VISIT_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label style={labelStyle}>Outcome *</label>
          <select value={outcome} onChange={e => setOutcome(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
            <option value="">Select outcome…</option>
            {VISIT_OUTCOMES.map(o => <option key={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            spellCheck={false} data-gramm="false" data-gramm_editor="false"
            placeholder="Additional notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={submit} loading={saving} disabled={!visitDate || !outcome}>Log Visit</Btn>
          <Btn onClick={onClose} outline>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Log Payment Modal ──────────────────────────────────────────────────────────

function LogPaymentModal({ caseId, open, onClose, onDone }: {
  caseId: number; open: boolean; onClose: () => void; onDone: () => void
}) {
  const [amount,      setAmount]      = useState('')
  const [channel,     setChannel]     = useState('Bank Transfer')
  const [paymentDate, setPaymentDate] = useState('')
  const [reference,   setReference]   = useState('')
  const [saving,      setSaving]      = useState(false)
  const [err,         setErr]         = useState<string | null>(null)

  async function submit() {
    const kobo = Math.round(parseFloat(amount) * 100)
    if (!kobo || !paymentDate) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/payment`, { amount_kobo: kobo, channel, payment_date: paymentDate, reference })
      toast.success('Payment recorded')
      setAmount(''); setReference(''); setPaymentDate(''); onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed') } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record Payment" width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div>
          <label style={labelStyle}>Amount (NGN) *</label>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="e.g. 50000" style={{ ...fieldStyle, height: 36 }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Channel</label>
            <select value={channel} onChange={e => setChannel(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
              {PAY_CHANNELS.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Date *</label>
            <input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Reference</label>
          <input value={reference} onChange={e => setReference(e.target.value)}
            placeholder="Transaction reference…" style={{ ...fieldStyle, height: 36 }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={submit} loading={saving} disabled={!amount || !paymentDate || parseFloat(amount) <= 0}>Record Payment</Btn>
          <Btn onClick={onClose} outline>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Add Legal Milestone Modal ──────────────────────────────────────────────────

function LegalModal({ caseId, open, onClose, onDone }: {
  caseId: number; open: boolean; onClose: () => void; onDone: () => void
}) {
  const [type,        setType]        = useState('')
  const [court,       setCourt]       = useState('')
  const [caseNum,     setCaseNum]     = useState('')
  const [filingDate,  setFilingDate]  = useState('')
  const [hearingDate, setHearingDate] = useState('')
  const [notes,       setNotes]       = useState('')
  const [saving,      setSaving]      = useState(false)
  const [err,         setErr]         = useState<string | null>(null)

  async function submit() {
    if (!type || !filingDate) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/legal`, {
        proceeding_type: type, court_name: court, case_number: caseNum,
        filing_date: filingDate, next_hearing_date: hearingDate, notes,
      })
      toast.success('Legal milestone added')
      setType(''); setCourt(''); setCaseNum(''); setFilingDate(''); setHearingDate(''); setNotes('')
      onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed') } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Legal Milestone" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div>
          <label style={labelStyle}>Milestone Type *</label>
          <select value={type} onChange={e => setType(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
            <option value="">Select…</option>
            {LEGAL_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Court Name</label>
            <input value={court} onChange={e => setCourt(e.target.value)}
              placeholder="e.g. Federal High Court" style={{ ...fieldStyle, height: 36 }} />
          </div>
          <div>
            <label style={labelStyle}>Case Number</label>
            <input value={caseNum} onChange={e => setCaseNum(e.target.value)}
              placeholder="e.g. FHC/001/2025" style={{ ...fieldStyle, height: 36 }} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Filing Date *</label>
            <input type="date" value={filingDate} onChange={e => setFilingDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} />
          </div>
          <div>
            <label style={labelStyle}>Next Hearing</label>
            <input type="date" value={hearingDate} onChange={e => setHearingDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            spellCheck={false} data-gramm="false" data-gramm_editor="false"
            style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={submit} loading={saving} disabled={!type || !filingDate}>Add Milestone</Btn>
          <Btn onClick={onClose} outline>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Reassign Modal ─────────────────────────────────────────────────────────────

function ReassignModal({ caseId, agents, open, onClose, onDone }: {
  caseId: number; agents: AgentUser[]
  open: boolean; onClose: () => void; onDone: () => void
}) {
  const [agentId, setAgentId] = useState('')
  const [notes,   setNotes]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [err,     setErr]     = useState<string | null>(null)

  const recoveryAgents = agents.filter(a =>
    a.role.includes('recovery') || a.role === 'admin' || a.role === 'management'
  )

  async function submit() {
    if (!agentId) return
    setSaving(true); setErr(null)
    try {
      await apiPut(`/api/recovery-ops/cases/${caseId}/assign`, { agent_id: Number(agentId), notes })
      toast.success('Case reassigned')
      setAgentId(''); setNotes(''); onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed') } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reassign Case" width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div>
          <label style={labelStyle}>Agent *</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
            <option value="">Select agent…</option>
            {recoveryAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Handover Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            spellCheck={false} data-gramm="false" data-gramm_editor="false"
            placeholder="Context for the new agent…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={submit} loading={saving} disabled={!agentId}>Reassign Case</Btn>
          <Btn onClick={onClose} outline>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Write-off Modal ────────────────────────────────────────────────────────────

function WriteOffModal({ caseId, outstanding, open, onClose, onDone }: {
  caseId: number; outstanding: number
  open: boolean; onClose: () => void; onDone: () => void
}) {
  const [amount,  setAmount]  = useState('')
  const [reason,  setReason]  = useState('')
  const [confirm, setConfirm] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [err,     setErr]     = useState<string | null>(null)

  async function doWriteOff() {
    const kobo = amount ? Math.round(parseFloat(amount) * 100) : outstanding
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/write-off`, { amount_kobo: kobo, reason })
      toast.success('Write-off submitted for approval')
      setAmount(''); setReason(''); setConfirm(false); onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed'); setConfirm(false) } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Request Write-off" width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div style={{
          padding: '10px 12px', borderRadius: RADIUS.md,
          background: `${RED}08`, border: `1px solid ${RED}25`,
          fontSize: TEXT.sm, color: RED, lineHeight: 1.5,
        }}>
          Submits for supervisor approval. Outstanding: {fmtKobo(outstanding)}.
        </div>
        <div>
          <label style={labelStyle}>Amount (NGN) — leave blank to write off full outstanding</label>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder={fmtKobo(outstanding)} style={{ ...fieldStyle, height: 36 }} />
        </div>
        <div>
          <label style={labelStyle}>Reason *</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={4}
            spellCheck={false} data-gramm="false" data-gramm_editor="false"
            placeholder="Explain why this account should be written off…"
            style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={() => setConfirm(true)} disabled={!reason.trim()} danger>Submit Write-off</Btn>
          <Btn onClick={onClose} outline>Cancel</Btn>
        </div>
        <ConfirmModal
          open={confirm} title="Submit Write-off Request"
          body={`Submit write-off for approval. Reason: "${reason.slice(0, 100)}${reason.length > 100 ? '…' : ''}"`}
          confirmLabel="Submit" danger loading={saving}
          onConfirm={doWriteOff} onClose={() => setConfirm(false)}
        />
      </div>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RecoveryCaseDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const caseId = Number(id)

  const [detail,  setDetail]  = useState<FullDetail | null>(null)
  const [agents,  setAgents]  = useState<AgentUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [activeModal, setActiveModal] = useState<ActionTab | null>(null)

  const role   = getStoredRole()
  const isHead = ['recovery_head', 'head_recovery', 'admin', 'management', 'md', 'coo'].includes(role)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [res, usersRes] = await Promise.all([
        apiFetch<{ data: FullDetail }>(`/api/recovery-ops/cases/${caseId}/full`),
        isHead ? apiFetch<{ data: AgentUser[] }>('/api/admin/users') : Promise.resolve({ data: [] }),
      ])
      setDetail(res.data)
      setAgents(usersRes.data ?? [])
      setVersion(v => v + 1)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load case')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [caseId, isHead])

  useEffect(() => {
    load()
    timerRef.current = setInterval(() => load(true), POLL_INTERVAL)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [load])

  if (loading) return (
    <Page title="Recovery Case">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  if (error || !detail) return (
    <Page title="Recovery Case">
      <ErrBanner error={error ?? 'Case not found'} onRetry={() => load()} />
    </Page>
  )

  const { case: rc, payments, proceedings, visits, write_off_approval, activity_log, coll_contacts, coll_promises } = detail
  const net = rc.outstanding_kobo - rc.recovered_kobo
  const recoveryPct = rc.outstanding_kobo > 0
    ? Math.round(100 * rc.recovered_kobo / rc.outstanding_kobo)
    : 0

  // Build unified timeline: activity_log + recovery events merged and sorted
  type TL = { date: string; label: string; actor?: string; detail?: string; color: string }
  const timeline: TL[] = [
    ...activity_log.map(a => ({
      date:   a.created_at,
      label:  ACTION_LABELS[a.action] ?? a.action.replace(/_/g, ' '),
      actor:  a.actor_name ?? undefined,
      detail: a.detail ?? undefined,
      color:  MODULE_COLORS[a.module] ?? '#6B7280',
    })),
    ...visits.map(v => ({
      date:   v.visit_date + 'T00:00:00Z',
      label:  `Visit — ${v.visit_type}: ${v.outcome}`,
      actor:  v.agent_name ?? undefined,
      detail: v.notes ?? undefined,
      color:  AMBER,
    })),
    ...proceedings.map(p => ({
      date:   p.filing_date + 'T00:00:00Z',
      label:  `Legal — ${p.proceeding_type}`,
      actor:  p.court_name ?? undefined,
      detail: p.notes ?? undefined,
      color:  RED,
    })),
    ...payments.map(p => ({
      date:   p.payment_date + 'T00:00:00Z',
      label:  `Payment — ${fmtKobo(p.amount_kobo)}`,
      actor:  p.agent_name ?? undefined,
      detail: `${p.channel}${p.reference ? ' · ' + p.reference : ''}`,
      color:  GREEN,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <Page
      title={rc.case_ref ?? rc.account_cif}
      subtitle={`Recovery case · CIF: ${rc.account_cif}`}
      actions={
        <button
          onClick={() => navigate('/recovery/cases')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: RADIUS.md,
            border: '1px solid var(--bdr)', background: 'var(--card)',
            color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_back</span>
          All Cases
        </button>
      }
    >

      {/* ── Header strip ──────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto',
        gap: SP[4], marginBottom: SP[4],
        padding: SP[4], borderRadius: RADIUS.lg,
        background: 'var(--card)', border: '1px solid var(--bdr)',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <StatusPill status={rc.status} />
            {rc.legal_stage && (
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: RED }}>
                ⚖ {rc.legal_stage}
              </span>
            )}
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              Opened {rc.opened_at ? fmtDate(rc.opened_at) : '—'}
            </span>
            {rc.closed_at && (
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>· Closed {fmtDate(rc.closed_at)}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: SP[6], flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>Net Outstanding</div>
              <div style={{ ...NUM, fontSize: 26, fontWeight: FW.bold, color: net > 0 ? RED : GREEN, letterSpacing: '-0.5px' }}>
                {fmtKobo(net)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>Total Outstanding</div>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtKobo(rc.outstanding_kobo)}</div>
            </div>
            <div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>Recovered</div>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.semibold, color: GREEN }}>
                {fmtKobo(rc.recovered_kobo)}
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.normal, marginLeft: 5 }}>({recoveryPct}%)</span>
              </div>
            </div>
            {rc.write_off_amount_kobo > 0 && (
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>Written Off</div>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.semibold, color: '#6B7280' }}>{fmtKobo(rc.write_off_amount_kobo)}</div>
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 160 }}>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 6 }}>Handler</div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
            {rc.agent_name ?? <span style={{ color: RED }}>Unassigned</span>}
          </div>
          {rc.assigned_by_name && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3 }}>Assigned by {rc.assigned_by_name}</div>
          )}
          <button
            onClick={() => navigate(`/contacts/${rc.account_cif}`)}
            style={{
              marginTop: 12, padding: '4px 10px', borderRadius: RADIUS.sm,
              border: `1px solid ${NAVY}30`, background: `${NAVY}08`,
              color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
            }}
          >
            C360 Profile →
          </button>
        </div>
      </div>

      {/* Recovery progress bar */}
      <div style={{ marginBottom: SP[4] }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Recovery progress</span>
          <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: GREEN }}>{recoveryPct}%</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--bdr)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, recoveryPct)}%`, background: GREEN, borderRadius: 4 }} />
        </div>
      </div>

      {/* Write-off approval banner */}
      {write_off_approval && (
        <div style={{
          marginBottom: SP[4], padding: `${SP[2]} ${SP[4]}`,
          borderRadius: RADIUS.md,
          background: write_off_approval.status === 'approved' ? `${GREEN}10` : `${AMBER}10`,
          border: `1px solid ${write_off_approval.status === 'approved' ? GREEN : AMBER}40`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span className="material-symbols-rounded" style={{
            fontSize: 18,
            color: write_off_approval.status === 'approved' ? GREEN : AMBER,
          }}>
            {write_off_approval.status === 'approved' ? 'check_circle' : 'pending'}
          </span>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
            Write-off {write_off_approval.status}: {fmtKobo(write_off_approval.amount_kobo)}
          </span>
          {write_off_approval.approver_name && (
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              · Approved by {write_off_approval.approver_name}
            </span>
          )}
        </div>
      )}

      {/* ── Action bar ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: SP[4], flexWrap: 'wrap',
        padding: SP[3], borderRadius: RADIUS.md,
        background: 'var(--card)', border: '1px solid var(--bdr)',
      }}>
        <Btn onClick={() => setActiveModal('visit')}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>directions_walk</span>
          Log Visit
        </Btn>
        <Btn onClick={() => setActiveModal('payment')}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>payments</span>
          Record Payment
        </Btn>
        <Btn onClick={() => setActiveModal('legal')}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>gavel</span>
          Legal Milestone
        </Btn>
        {rc.status !== 'written_off' && (
          <Btn onClick={() => setActiveModal('writeoff')} danger>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>cancel</span>
            Request Write-off
          </Btn>
        )}
        {isHead && (
          <Btn onClick={() => setActiveModal('reassign')} outline>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>swap_horiz</span>
            Reassign
          </Btn>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: GREEN }} />
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Live · updates every 10s</span>
        </div>
      </div>

      {/* ── Main grid ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: SP[4], alignItems: 'start' }}>

        {/* Left: full timeline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>

          <SectionCard title="Full Activity History" subtitle="Complete lifecycle — collections phase through recovery" badge={timeline.length}>
            {timeline.length === 0 ? (
              <div style={{ padding: `${SP[4]} 0`, color: 'var(--txt3)', fontSize: TEXT.sm }}>No activity yet.</div>
            ) : (
              <div style={{ paddingTop: SP[2] }}>
                {timeline.map((ev, i) => (
                  <TimelineItem key={i} {...ev} />
                ))}
              </div>
            )}
          </SectionCard>

          {/* Collections-phase contacts */}
          {coll_contacts.length > 0 && (
            <SectionCard title="Collections Phase — Contacts" subtitle="Contact attempts logged before recovery referral" badge={coll_contacts.length}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {coll_contacts.map(c => (
                  <div key={c.id} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                          {c.contact_type} — {c.outcome}
                        </span>
                        <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDate(c.created_at)}</span>
                      </div>
                      {c.notes && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{c.notes}</div>}
                      {c.agent_name && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>by {c.agent_name}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Collections-phase promises */}
          {coll_promises.length > 0 && (
            <SectionCard title="Collections Phase — Promises to Pay" subtitle="PTPs made before recovery referral" badge={coll_promises.length}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {coll_promises.map(p => {
                  const statusColor = p.is_kept ? GREEN : AMBER
                  return (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                            {fmtKobo(p.promised_amount_kobo)}
                          </span>
                          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>promised by {fmtDate(p.promised_date)}</span>
                        </div>
                        {p.notes && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{p.notes}</div>}
                      </div>
                      <span style={{
                        fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
                        borderRadius: RADIUS['2xl'], background: `${statusColor}18`, color: statusColor,
                      }}>
                        {p.is_kept ? 'Kept' : 'Pending'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </SectionCard>
          )}

        </div>

        {/* Right: case summary + legal + payments */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>

          <SectionCard title="Case Details">
            <LV label="Case Reference"  value={rc.case_ref} />
            <LV label="Account CIF"     value={rc.account_cif} />
            <LV label="Status"          value={<StatusPill status={rc.status} />} />
            <LV label="Handler"         value={rc.agent_name ?? <span style={{ color: RED }}>Unassigned</span>} />
            <LV label="Assigned By"     value={rc.assigned_by_name} />
            <LV label="Legal Stage"     value={rc.legal_stage} />
            <LV label="Opened"          value={rc.opened_at ? fmtDate(rc.opened_at) : '—'} />
            {rc.closed_at && <LV label="Closed" value={fmtDate(rc.closed_at)} />}
          </SectionCard>

          {/* Legal proceedings */}
          {proceedings.length > 0 && (
            <SectionCard title="Legal Proceedings" badge={proceedings.length}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {proceedings.map(p => (
                  <div key={p.id} style={{ padding: '8px 10px', borderRadius: RADIUS.md, background: `${RED}06`, border: `1px solid ${RED}20` }}>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, marginBottom: 4 }}>{p.proceeding_type}</div>
                    {p.court_name && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{p.court_name}{p.case_number ? ` · ${p.case_number}` : ''}</div>}
                    <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3 }}>
                      Filed {fmtDate(p.filing_date)}
                      {p.next_hearing_date ? ` · Hearing ${fmtDate(p.next_hearing_date)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Recovery payments */}
          {payments.length > 0 && (
            <SectionCard title="Payments Received" badge={payments.length}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {payments.map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--bdr)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: GREEN }}>{fmtKobo(p.amount_kobo)}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                        {p.channel} · {fmtDate(p.payment_date)}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Field visits */}
          {visits.length > 0 && (
            <SectionCard title="Field Visits" badge={visits.length}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {visits.map(v => (
                  <div key={v.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                        {v.visit_type} — {v.outcome}
                      </span>
                      <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDate(v.visit_date)}</span>
                    </div>
                    {v.notes && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3 }}>{v.notes}</div>}
                    {v.agent_name && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>by {v.agent_name}</div>}
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

        </div>
      </div>

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      <LogVisitModal   caseId={caseId} open={activeModal === 'visit'}   onClose={() => setActiveModal(null)} onDone={() => { setActiveModal(null); load() }} />
      <LogPaymentModal caseId={caseId} open={activeModal === 'payment'} onClose={() => setActiveModal(null)} onDone={() => { setActiveModal(null); load() }} />
      <LegalModal      caseId={caseId} open={activeModal === 'legal'}   onClose={() => setActiveModal(null)} onDone={() => { setActiveModal(null); load() }} />
      <WriteOffModal   caseId={caseId} outstanding={net} open={activeModal === 'writeoff'} onClose={() => setActiveModal(null)} onDone={() => { setActiveModal(null); load() }} />
      {isHead && (
        <ReassignModal caseId={caseId} agents={agents} open={activeModal === 'reassign'} onClose={() => setActiveModal(null)} onDone={() => { setActiveModal(null); load() }} />
      )}

    </Page>
  )
}
