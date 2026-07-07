import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, FilterBar, Tabs, ConfirmModal, ErrBanner, Spinner, Modal,
  filterInputStyle,
} from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, NAVY, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecoveryCase {
  id: number
  case_ref: string | null
  account_cif: string
  assigned_agent_id: number | null
  agent_name: string | null
  legal_stage: string | null
  outstanding_kobo: number
  recovered_kobo: number
  write_off_amount_kobo: number
  status: string
  opened_at: string | null
  updated_at: string
}

interface AgentUser {
  id: number
  full_name: string
  role: string
}

interface CaseDetail {
  case: RecoveryCase
  payments: { id: number; amount_kobo: number; payment_date: string; channel: string; reference?: string }[]
  visits: { id: number; visit_date: string; visit_type: string; outcome: string; notes?: string; agent_name?: string }[]
  proceedings: { id: number; proceeding_type: string; court_name?: string; filing_date: string; status: string }[]
  write_off_approval: { status: string } | null
}

// ── Status pill ───────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  active:      { bg: `${BLUE}18`,        txt: BLUE },
  legal:       { bg: 'rgba(192,0,0,.1)', txt: RED },
  closed:      { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' },
  written_off: { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_COLORS[status.toLowerCase()] ?? { bg: `${NAVY}12`, txt: NAVY }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
    </span>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5,
}

// ── Label/value row ───────────────────────────────────────────────────────────

function LV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--txt2)', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>{value ?? '—'}</span>
    </div>
  )
}

// ── Submit button ─────────────────────────────────────────────────────────────

function Btn({ children, onClick, disabled, loading: busy, danger }: {
  children: React.ReactNode; onClick: () => void
  disabled?: boolean; loading?: boolean; danger?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled || busy} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '7px 14px', borderRadius: 8, border: 'none',
      background: danger ? RED : NAVY, color: '#fff',
      fontSize: 13, fontWeight: 600,
      cursor: disabled || busy ? 'not-allowed' : 'pointer',
      opacity: disabled || busy ? 0.6 : 1,
    }}>
      {busy && <Spinner size={13} color="#fff" />}
      {children}
    </button>
  )
}

// ── Assign Agent tab ──────────────────────────────────────────────────────────

function AssignAgentTab({ caseId, agents, onDone }: {
  caseId: number; agents: AgentUser[]; onDone: () => void
}) {
  const [agentId, setAgentId] = useState('')
  const [notes, setNotes]     = useState('')
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  const recoveryAgents = agents.filter(a =>
    a.role.includes('recovery') || a.role === 'admin' || a.role === 'management'
  )

  async function submit() {
    if (!agentId) return
    setSaving(true); setErr(null)
    try {
      await apiPut(`/api/recovery-ops/cases/${caseId}/assign`, { agent_id: Number(agentId), notes })
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
        <label style={labelStyle}>Agent</label>
        <select value={agentId} onChange={e => setAgentId(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}>
          <option value="">Select agent…</option>
          {recoveryAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!agentId}>Assign Agent</Btn>
    </div>
  )
}

// ── Log Visit tab ─────────────────────────────────────────────────────────────

const VISIT_TYPES    = ['Physical Visit', 'Phone Call', 'WhatsApp', 'Email']
const VISIT_OUTCOMES = ['Customer Met', 'Not Home', 'Promised to Pay', 'Refused to Pay', 'No Response', 'Other']

function FieldVisitTab({ caseId, onDone }: { caseId: number; onDone: () => void }) {
  const [visitDate, setVisitDate] = useState('')
  const [visitType, setVisitType] = useState('Physical Visit')
  const [outcome, setOutcome]     = useState('')
  const [notes, setNotes]         = useState('')
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState<string | null>(null)

  async function submit() {
    if (!visitDate || !outcome) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/visit`, {
        visit_date: visitDate, visit_type: visitType, outcome, notes,
      })
      toast.success('Visit logged')
      setOutcome(''); setNotes(''); onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to log visit')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={labelStyle}>Visit Date</label>
        <input type="date" value={visitDate} onChange={e => setVisitDate(e.target.value)}
          style={{ ...fieldStyle, height: 36 }} />
      </div>
      <div>
        <label style={labelStyle}>Type</label>
        <select value={visitType} onChange={e => setVisitType(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}>
          {VISIT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Outcome</label>
        <select value={outcome} onChange={e => setOutcome(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}>
          <option value="">Select outcome…</option>
          {VISIT_OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          placeholder="Additional notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!visitDate || !outcome}>Log Visit</Btn>
    </div>
  )
}

// ── Legal Filing tab ──────────────────────────────────────────────────────────

const PROCEEDING_TYPES = [
  'Pre-Litigation Notice', 'Demand Letter', 'Court Filing',
  'Judgment', 'Enforcement', 'Other',
]

function AddLegalTab({ caseId, onDone }: { caseId: number; onDone: () => void }) {
  const [proceedingType,  setProceedingType]  = useState('')
  const [courtName,       setCourtName]       = useState('')
  const [caseNumber,      setCaseNumber]      = useState('')
  const [filingDate,      setFilingDate]      = useState('')
  const [nextHearingDate, setNextHearingDate] = useState('')
  const [notes,           setNotes]           = useState('')
  const [saving,          setSaving]          = useState(false)
  const [err,             setErr]             = useState<string | null>(null)

  async function submit() {
    if (!proceedingType || !filingDate) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/legal`, {
        proceeding_type: proceedingType, court_name: courtName,
        case_number: caseNumber, filing_date: filingDate,
        next_hearing_date: nextHearingDate, notes,
      })
      toast.success('Legal filing added')
      setProceedingType(''); setCourtName(''); setCaseNumber('')
      setFilingDate(''); setNextHearingDate(''); setNotes('')
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to add legal filing')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={labelStyle}>Proceeding Type</label>
        <select value={proceedingType} onChange={e => setProceedingType(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}>
          <option value="">Select type…</option>
          {PROCEEDING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={labelStyle}>Court Name</label>
          <input value={courtName} onChange={e => setCourtName(e.target.value)}
            placeholder="e.g. Federal High Court" style={{ ...fieldStyle, height: 36 }} />
        </div>
        <div>
          <label style={labelStyle}>Case Number</label>
          <input value={caseNumber} onChange={e => setCaseNumber(e.target.value)}
            placeholder="e.g. FHC/001/2025" style={{ ...fieldStyle, height: 36 }} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={labelStyle}>Filing Date <span style={{ color: RED }}>*</span></label>
          <input type="date" value={filingDate} onChange={e => setFilingDate(e.target.value)}
            style={{ ...fieldStyle, height: 36 }} />
        </div>
        <div>
          <label style={labelStyle}>Next Hearing</label>
          <input type="date" value={nextHearingDate} onChange={e => setNextHearingDate(e.target.value)}
            style={{ ...fieldStyle, height: 36 }} />
        </div>
      </div>
      <div>
        <label style={labelStyle}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          placeholder="Additional notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={submit} loading={saving} disabled={!proceedingType || !filingDate}>Add Legal Filing</Btn>
    </div>
  )
}

// ── Record Payment tab ────────────────────────────────────────────────────────

const PAYMENT_CHANNELS = ['Bank Transfer', 'Cash', 'Cheque', 'TPA', 'Legal Settlement', 'Self-Cure']

function RecordPaymentTab({ caseId, onDone }: { caseId: number; onDone: () => void }) {
  const [amountNaira,  setAmountNaira]  = useState('')
  const [channel,      setChannel]      = useState('Bank Transfer')
  const [paymentDate,  setPaymentDate]  = useState('')
  const [reference,    setReference]    = useState('')
  const [saving,       setSaving]       = useState(false)
  const [err,          setErr]          = useState<string | null>(null)

  async function submit() {
    const kobo = Math.round(parseFloat(amountNaira) * 100)
    if (!kobo || !paymentDate) return
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/payment`, {
        amount_kobo: kobo, channel, payment_date: paymentDate, reference,
      })
      toast.success('Payment recorded')
      setAmountNaira(''); setReference(''); setPaymentDate(''); onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to record payment')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={labelStyle}>Amount (₦) <span style={{ color: RED }}>*</span></label>
        <input type="number" value={amountNaira} onChange={e => setAmountNaira(e.target.value)}
          placeholder="e.g. 50000" style={{ ...fieldStyle, height: 36 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={labelStyle}>Channel</label>
          <select value={channel} onChange={e => setChannel(e.target.value)}
            style={{ ...filterInputStyle, height: 36, width: '100%' }}>
            {PAYMENT_CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Payment Date <span style={{ color: RED }}>*</span></label>
          <input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)}
            style={{ ...fieldStyle, height: 36 }} />
        </div>
      </div>
      <div>
        <label style={labelStyle}>Reference</label>
        <input value={reference} onChange={e => setReference(e.target.value)}
          placeholder="Transaction reference…" style={{ ...fieldStyle, height: 36 }} />
      </div>
      <Btn onClick={submit} loading={saving}
        disabled={!amountNaira || !paymentDate || parseFloat(amountNaira) <= 0}>
        Record Payment
      </Btn>
    </div>
  )
}

// ── Write-off tab ─────────────────────────────────────────────────────────────

function WriteOffTab({ caseId, outstanding, onDone }: { caseId: number; outstanding: number; onDone: () => void }) {
  const [amountNaira, setAmountNaira] = useState('')
  const [reason,      setReason]      = useState('')
  const [confirm,     setConfirm]     = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [err,         setErr]         = useState<string | null>(null)

  async function doWriteOff() {
    const kobo = amountNaira ? Math.round(parseFloat(amountNaira) * 100) : outstanding
    setSaving(true); setErr(null)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseId}/write-off`, { amount_kobo: kobo, reason })
      toast.success('Write-off submitted for approval')
      setAmountNaira(''); setReason(''); setConfirm(false); onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to submit write-off')
      setConfirm(false)
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div style={{
        padding: '10px 12px', borderRadius: 8,
        background: 'rgba(192,0,0,.06)', border: '1px solid rgba(192,0,0,.18)',
        fontSize: 12.5, color: RED, lineHeight: 1.5,
      }}>
        Submit a write-off request for supervisor approval. Outstanding: {fmtKobo(outstanding)}.
      </div>
      <div>
        <label style={labelStyle}>Amount (₦) — blank to write off full outstanding</label>
        <input type="number" value={amountNaira} onChange={e => setAmountNaira(e.target.value)}
          placeholder={`${(outstanding / 100).toLocaleString()}`} style={{ ...fieldStyle, height: 36 }} />
      </div>
      <div>
        <label style={labelStyle}>Reason <span style={{ color: RED }}>*</span></label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={4}
          placeholder="Explain why this account should be written off…"
          style={{ ...fieldStyle, resize: 'vertical' }} />
      </div>
      <Btn onClick={() => setConfirm(true)} disabled={!reason.trim()} danger>Submit Write-off</Btn>
      <ConfirmModal
        open={confirm} title="Submit Write-off Request"
        body={`Submit write-off for approval. Reason: "${reason.slice(0, 100)}${reason.length > 100 ? '…' : ''}"`}
        confirmLabel="Submit" danger loading={saving}
        onConfirm={doWriteOff} onClose={() => setConfirm(false)}
      />
    </div>
  )
}

// ── Case Timeline ─────────────────────────────────────────────────────────────

function CaseTimeline({ caseId }: { caseId: number }) {
  const [detail,  setDetail]  = useState<CaseDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiFetch<CaseDetail>(`/api/recovery-ops/cases/${caseId}`)
      .then(res => setDetail(res))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [caseId])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--txt2)', fontSize: 13 }}>
        <Spinner size={14} color={NAVY} /> Loading…
      </div>
    )
  }
  if (!detail) {
    return <div style={{ fontSize: 13, color: 'var(--txt2)' }}>No activity yet.</div>
  }

  type EvItem = { date: string; label: string; sub?: string; color: string }
  const events: EvItem[] = [
    ...(detail.payments ?? []).map(p => ({
      date: p.payment_date,
      label: `Payment — ${fmtKobo(p.amount_kobo)}`,
      sub: `${p.channel}${p.reference ? ` · ${p.reference}` : ''}`,
      color: GREEN,
    })),
    ...(detail.visits ?? []).map(v => ({
      date: v.visit_date,
      label: `${v.visit_type} — ${v.outcome}`,
      sub: v.notes || undefined,
      color: BLUE,
    })),
    ...(detail.proceedings ?? []).map(pr => ({
      date: pr.filing_date,
      label: `Legal — ${pr.proceeding_type}`,
      sub: pr.court_name,
      color: AMBER,
    })),
  ].sort((a, b) => (a.date > b.date ? -1 : 1))

  if (!events.length) {
    return <div style={{ fontSize: 13, color: 'var(--txt2)' }}>No activity yet.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {events.map((ev, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{
            ...NUM, fontSize: 10.5, fontWeight: 600,
            background: `${ev.color}18`, color: ev.color,
            padding: '2px 8px', borderRadius: 20,
            whiteSpace: 'nowrap', flexShrink: 0, marginTop: 1,
          }}>
            {fmtDate(ev.date)}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', lineHeight: 1.3 }}>{ev.label}</div>
            {ev.sub && <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>{ev.sub}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

const ACTION_TABS = [
  { key: 'assign',   label: 'Assign Agent' },
  { key: 'visit',    label: 'Log Visit' },
  { key: 'legal',    label: 'Legal Filing' },
  { key: 'payment',  label: 'Record Payment' },
  { key: 'writeoff', label: 'Write-off' },
]

function DetailPanel({ rc, agents, onAction }: {
  rc: RecoveryCase; agents: AgentUser[]; onAction: () => void
}) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('assign')
  const net = rc.outstanding_kobo - rc.recovered_kobo

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)', marginBottom: 2 }}>
              {rc.case_ref ?? rc.account_cif}
            </div>
            <div style={{ fontSize: 12, color: 'var(--txt2)' }}>CIF: {rc.account_cif}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusPill status={rc.status} />
            <button
              onClick={() => navigate(`/contacts/${rc.account_cif}`)}
              style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Full profile →
            </button>
          </div>
        </div>
        <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: 'var(--txt)', marginTop: 10, letterSpacing: '-0.6px' }}>
          {fmtKobo(net)}
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--txt2)', marginLeft: 8 }}>net outstanding</span>
        </div>
      </div>

      {/* Summary */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Case Summary
        </div>
        <LV label="Outstanding"    value={<span style={NUM}>{fmtKobo(rc.outstanding_kobo)}</span>} />
        <LV label="Recovered"      value={<span style={{ ...NUM, color: GREEN }}>{fmtKobo(rc.recovered_kobo)}</span>} />
        {rc.write_off_amount_kobo > 0 && (
          <LV label="Written Off" value={<span style={{ ...NUM, color: '#6B7280' }}>{fmtKobo(rc.write_off_amount_kobo)}</span>} />
        )}
        <LV label="Assigned Agent" value={rc.agent_name ?? <span style={{ color: RED }}>Unassigned</span>} />
        {rc.legal_stage && <LV label="Legal Stage" value={rc.legal_stage} />}
        <LV label="Opened" value={rc.opened_at ? fmtDate(rc.opened_at) : '—'} />
      </div>

      {/* Activity timeline */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Activity
        </div>
        <CaseTimeline key={rc.id} caseId={rc.id} />
      </div>

      {/* Actions */}
      <div style={{ padding: '16px 20px', flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Actions
        </div>
        <Tabs tabs={ACTION_TABS} active={tab} onChange={setTab} />
        {tab === 'assign'   && <AssignAgentTab   caseId={rc.id} agents={agents} onDone={onAction} />}
        {tab === 'visit'    && <FieldVisitTab     caseId={rc.id} onDone={onAction} />}
        {tab === 'legal'    && <AddLegalTab       caseId={rc.id} onDone={onAction} />}
        {tab === 'payment'  && <RecordPaymentTab  caseId={rc.id} onDone={onAction} />}
        {tab === 'writeoff' && <WriteOffTab       caseId={rc.id} outstanding={net} onDone={onAction} />}
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

  const recoveryAgents = agents.filter(a =>
    a.role.includes('recovery') || a.role === 'admin' || a.role === 'management'
  )

  async function submit() {
    if (!agentId) return
    setSaving(true); setErr(null)
    try {
      await Promise.all([...selectedIds].map(id =>
        apiPut(`/api/recovery-ops/cases/${id}/assign`, { agent_id: Number(agentId), notes })
      ))
      toast.success(`${selectedIds.size} case${selectedIds.size !== 1 ? 's' : ''} assigned`)
      setAgentId(''); setNotes(''); onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Assign failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Reassign ${selectedIds.size} Case${selectedIds.size !== 1 ? 's' : ''}`} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div>
          <label style={labelStyle}>Agent</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)}
            style={{ ...filterInputStyle, height: 36, width: '100%' }}>
            <option value="">Select agent…</option>
            {recoveryAgents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={submit} loading={saving} disabled={!agentId}>
            Assign {selectedIds.size} Case{selectedIds.size !== 1 ? 's' : ''}
          </Btn>
          <button onClick={onClose} style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Filter options ────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { label: 'All Statuses', value: '' },
  { label: 'Active',       value: 'active' },
  { label: 'Legal',        value: 'legal' },
  { label: 'Closed',       value: 'closed' },
  { label: 'Written Off',  value: 'written_off' },
]

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryCases() {
  const [cases,    setCases]    = useState<RecoveryCase[]>([])
  const [agents,   setAgents]   = useState<AgentUser[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<RecoveryCase | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [reassignOpen, setReassignOpen] = useState(false)

  const [statusFilter, setStatusFilter] = useState('')
  const [searchQ,      setSearchQ]      = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const params = new URLSearchParams({ limit: '100' })
    if (statusFilter) params.set('status', statusFilter)
    if (searchQ.trim()) params.set('q', searchQ.trim())
    try {
      const [casesRes, usersRes] = await Promise.all([
        apiFetch<{ data: RecoveryCase[] }>(`/api/recovery-ops/cases?${params}`),
        apiFetch<{ data: AgentUser[] }>('/api/admin/users'),
      ])
      setCases(casesRes.data ?? [])
      setAgents(usersRes.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load cases')
    } finally { setLoading(false) }
  }, [statusFilter, searchQ])

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
    <Page title="Recovery Cases" subtitle="Manage recovery cases and actions" noPad>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div style={{
          minWidth: 320, maxWidth: 380, width: 360,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)', flexShrink: 0,
        }}>
          {/* Filter bar */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--txt)' }}>Cases</span>
              <span style={{
                ...NUM, fontSize: 11, fontWeight: 700, padding: '1px 7px',
                borderRadius: 20, background: 'rgba(14,40,65,.08)', color: NAVY,
              }}>{cases.length}</span>
            </div>
            <FilterBar onReset={() => { setStatusFilter(''); setSearchQ('') }}>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}>
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </FilterBar>
            <input
              value={searchQ} onChange={e => setSearchQ(e.target.value)}
              placeholder="Search by CIF…"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', marginTop: 6 }}
            />
          </div>

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>{checkedIds.size} selected</span>
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
            ) : cases.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: 13 }}>
                No cases match the current filters.
              </div>
            ) : (
              cases.map(rc => {
                const isSelected = selected?.id === rc.id
                const isChecked  = checkedIds.has(rc.id)
                const net = rc.outstanding_kobo - rc.recovered_kobo
                return (
                  <div
                    key={rc.id}
                    onClick={() => setSelected(rc)}
                    style={{
                      padding: '11px 14px', borderBottom: '1px solid var(--bdr)',
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(14,40,65,0.06)' : undefined,
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                  >
                    <input
                      type="checkbox" checked={isChecked}
                      onClick={e => toggleCheck(rc.id, e)} onChange={() => {}}
                      style={{ marginTop: 3, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {rc.case_ref ?? rc.account_cif}
                        </span>
                        <StatusPill status={rc.status} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ ...NUM, fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>
                          {fmtKobo(net)}
                        </span>
                        {rc.legal_stage && (
                          <span style={{ ...NUM, fontSize: 10.5, color: AMBER }}>⚖ {rc.legal_stage}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--txt2)' }}>
                        {rc.agent_name ?? <span style={{ color: RED }}>Unassigned</span>} · {rc.account_cif}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* ── Right panel ──────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'auto' }}>
          {selected ? (
            <DetailPanel key={selected.id} rc={selected} agents={agents} onAction={load} />
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 12, color: 'var(--txt2)',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>gavel</span>
              <span style={{ fontSize: 14 }}>Select a case from the list</span>
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
        onDone={() => { setReassignOpen(false); clearChecked(); load() }}
      />
    </Page>
  )
}
