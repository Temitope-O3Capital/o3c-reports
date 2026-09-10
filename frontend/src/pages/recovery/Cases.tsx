import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, ExpandableFilterBar, Tabs, ConfirmModal, ErrBanner, Spinner, Modal,
  filterInputStyle, NameCell, ActionRow, StatusBadge, Pagination,
} from '../../components/UI'
import type { FilterGroupDef } from '../../components/UI'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { hasPage } from '../../hooks/useAuth'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKoboExact, fmtExact, fmtDate } from '../../lib/fmt'
import { RED, DARKRED, NAVY, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'
import { RepaymentPatternMini } from '../../components/RepaymentPatternMini'
import { TierBadge, tierFromPct } from '../../components/TierBadge'

// Marks a case bulk-loaded from an uploaded spreadsheet (data_source='manual'),
// so it reads as distinct from the Udara core-banking feed.
function ManualBadge({ source }: { source: string | null }) {
  if (source !== 'manual') return null
  return (
    <span
      title="Uploaded from a spreadsheet — not synced from Udara core banking"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: TEXT['2xs'], fontWeight: FW.bold, color: DARKRED,
        background: `${AMBER}1A`, border: `1px solid ${AMBER}55`,
        padding: '1px 6px', borderRadius: RADIUS.full, whiteSpace: 'nowrap',
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 11 }}>upload_file</span>
      Manual
    </span>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecoveryCase {
  id: number
  case_ref: string | null
  account_cif: string
  customer_name: string | null
  product_type: string | null        // 'card' | 'loan'
  data_source: string | null         // 'core' (Udara/feed) | 'manual' (uploaded spreadsheet)
  officer_name: string | null        // loan account officer (loans only; not a system user)
  loan_ref: string | null
  loan_amount_kobo: number | null
  maturity_date: string | null
  assigned_agent_id: number | null
  agent_name: string | null
  legal_stage: string | null
  outstanding_kobo: number
  recovered_kobo: number
  write_off_amount_kobo: number
  status: string
  opened_at: string | null
  updated_at: string
  // Per-row enrichment (see recoveryOpsCases). Billing values are NAIRA.
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
  collections_agent_name: string | null
  last_call_agent: string | null
  last_call_at: string | null
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
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
      borderRadius: RADIUS['2xl'], background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
    </span>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5,
}

// ── Label/value row ───────────────────────────────────────────────────────────

function LV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{value ?? '—'}</span>
    </div>
  )
}

// Compact inline "label value" used on the case list cards for credit terms.
function Term({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', whiteSpace: 'nowrap' }}>
      {label} <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: valueColor ?? 'var(--txt2)' }}>{value}</span>
    </span>
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
      padding: '7px 14px', borderRadius: RADIUS.md, border: 'none',
      background: danger ? RED : NAVY, color: '#fff',
      fontSize: TEXT.base, fontWeight: FW.semibold,
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
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} rows={3}
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
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} rows={3}
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
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} rows={3}
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
        <label style={labelStyle}>Amount (NGN) <span style={{ color: RED }}>*</span></label>
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
        padding: '10px 12px', borderRadius: RADIUS.md,
        background: 'rgba(192,0,0,.06)', border: '1px solid rgba(192,0,0,.18)',
        fontSize: TEXT.sm, color: RED, lineHeight: 1.5,
      }}>
        Submit a write-off request for supervisor approval. Outstanding: {fmtKoboExact(outstanding)}.
      </div>
      <div>
        <label style={labelStyle}>Amount (NGN): blank to write off full outstanding</label>
        <input type="number" value={amountNaira} onChange={e => setAmountNaira(e.target.value)}
          placeholder={fmtKoboExact(outstanding)} style={{ ...fieldStyle, height: 36 }} />
      </div>
      <div>
        <label style={labelStyle}>Reason <span style={{ color: RED }}>*</span></label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={reason} onChange={e => setReason(e.target.value)} rows={4}
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
    apiFetch<{ data: CaseDetail }>(`/api/recovery-ops/cases/${caseId}`)
      .then(res => setDetail(res.data ?? null))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [caseId])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--txt2)', fontSize: TEXT.base }}>
        <Spinner size={14} color={NAVY} /> Loading…
      </div>
    )
  }
  if (!detail) {
    return <div style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>No activity yet.</div>
  }

  type EvItem = { date: string; label: string; sub?: string; color: string }
  const events: EvItem[] = [
    ...(detail.payments ?? []).map(p => ({
      date: p.payment_date,
      label: `Payment: ${fmtKoboExact(p.amount_kobo)}`,
      sub: `${p.channel}${p.reference ? ` · ${p.reference}` : ''}`,
      color: GREEN,
    })),
    ...(detail.visits ?? []).map(v => ({
      date: v.visit_date,
      label: `${v.visit_type}: ${v.outcome}`,
      sub: v.notes || undefined,
      color: BLUE,
    })),
    ...(detail.proceedings ?? []).map(pr => ({
      date: pr.filing_date,
      label: `Legal: ${pr.proceeding_type}`,
      sub: pr.court_name,
      color: AMBER,
    })),
  ].sort((a, b) => (a.date > b.date ? -1 : 1))

  if (!events.length) {
    return <div style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>No activity yet.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {events.map((ev, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{
            ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.semibold,
            background: `${ev.color}18`, color: ev.color,
            padding: '2px 8px', borderRadius: RADIUS['2xl'],
            whiteSpace: 'nowrap', flexShrink: 0, marginTop: 1,
          }}>
            {fmtDate(ev.date)}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', lineHeight: 1.3 }}>{ev.label}</div>
            {ev.sub && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{ev.sub}</div>}
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

function DetailPanel({ rc, agents, onAction, canAssign }: {
  rc: RecoveryCase; agents: AgentUser[]; onAction: () => void; canAssign: boolean
}) {
  const navigate = useNavigate()
  // Agents can't assign, so drop the Assign Agent tab and default to Log Visit.
  const tabs = canAssign ? ACTION_TABS : ACTION_TABS.filter(t => t.key !== 'assign')
  const [tab, setTab] = useState(canAssign ? 'assign' : 'visit')
  const net = rc.outstanding_kobo - rc.recovered_kobo

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>
                {rc.customer_name ?? rc.case_ref ?? rc.account_cif}
              </span>
              {rc.product_type === 'loan' && (
                <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: PURPLE, background: `${PURPLE}18`, padding: '1px 6px', borderRadius: RADIUS.full }}>LOAN</span>
              )}
              <ManualBadge source={rc.data_source} />
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{rc.case_ref ? `${rc.case_ref} · ` : ''}{rc.product_type === 'loan' ? 'Mandate' : 'CIF'} {rc.account_cif}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <StatusPill status={rc.status} />
            <button
              onClick={() => navigate(`/recovery/cases/${rc.id}`)}
              style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
            >
              Full Detail
            </button>
            {/* Customer-360 is CIF-keyed; loans have no CIF (account is a mandate). */}
            {rc.product_type !== 'loan' && (
              <button
                onClick={() => navigate(`/customers/${encodeURIComponent(rc.account_cif)}`)}
                style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
              >
                C360
              </button>
            )}
          </div>
        </div>
        <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', marginTop: 10, letterSpacing: '-0.6px' }}>
          {fmtKoboExact(net)}
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.normal, color: 'var(--txt2)', marginLeft: 8 }}>net outstanding</span>
        </div>
      </div>

      {/* Summary */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Case Summary
        </div>
        <LV label="Outstanding"    value={<span style={NUM}>{fmtKoboExact(rc.outstanding_kobo)}</span>} />
        <LV label="Recovered"      value={<span style={{ ...NUM, color: GREEN }}>{fmtKoboExact(rc.recovered_kobo)}</span>} />
        {rc.write_off_amount_kobo > 0 && (
          <LV label="Written Off" value={<span style={{ ...NUM, color: '#6B7280' }}>{fmtKoboExact(rc.write_off_amount_kobo)}</span>} />
        )}
        <LV label="Recovery Agent" value={rc.agent_name ?? <span style={{ color: RED }}>Unassigned</span>} />
        {rc.product_type !== 'loan' && (
          <LV label="Collections Agent" value={rc.collections_agent_name ?? <span style={{ color: 'var(--txt3)' }}>No collections agent</span>} />
        )}
        {rc.product_type === 'loan' && (
          <>
            {rc.officer_name && <LV label="Loan Officer" value={rc.officer_name} />}
            {rc.loan_ref && <LV label="Loan Ref" value={rc.loan_ref} />}
            {rc.loan_amount_kobo != null && <LV label="Approved Amount" value={<span style={NUM}>{fmtKoboExact(rc.loan_amount_kobo)}</span>} />}
            {rc.maturity_date && <LV label="Maturity" value={fmtDate(rc.maturity_date)} />}
          </>
        )}
        {rc.legal_stage && <LV label="Legal Stage" value={rc.legal_stage} />}
        <LV label="Opened" value={rc.opened_at ? fmtDate(rc.opened_at) : '—'} />
      </div>

      {/* Address & card billing */}
      {(rc.full_address || rc.phone || rc.current_bill != null || rc.bill_balance != null ||
        rc.min_payment != null || rc.last_payment_amount != null) && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
            Address & Billing
          </div>
          {rc.full_address && <LV label="Address" value={rc.full_address} />}
          {(rc.city || rc.state) && (
            <LV label="City / State" value={[rc.city, rc.state].filter(Boolean).join(', ') || '—'} />
          )}
          {rc.phone && <LV label="Phone" value={rc.phone} />}
          {rc.current_bill != null && <LV label="Current Bill"  value={<span style={NUM}>{fmtExact(rc.current_bill)}</span>} />}
          {rc.bill_balance != null && <LV label="Bill Balance"  value={<span style={NUM}>{fmtExact(rc.bill_balance)}</span>} />}
          {rc.min_payment  != null && <LV label="Min Payment"   value={<span style={NUM}>{fmtExact(rc.min_payment)}</span>} />}
          {rc.credit_limit != null && <LV label="Credit Limit"  value={<span style={NUM}>{fmtExact(rc.credit_limit)}</span>} />}
          {rc.last_payment_amount != null && (
            <LV label="Last Payment" value={
              <span><span style={NUM}>{fmtExact(rc.last_payment_amount)}</span>{rc.last_payment_date ? <span style={{ color: 'var(--txt2)', fontWeight: FW.normal }}> · {fmtDate(rc.last_payment_date)}</span> : null}</span>
            } />
          )}
        </div>
      )}

      {/* Repayment cadence (real money-in from the transaction feed, same as C360).
          Cards only — a loan's account_cif is a mandate, not a customer CIF. */}
      {rc.product_type !== 'loan' && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
            Repayment Pattern
          </div>
          <RepaymentPatternMini cif={rc.account_cif} endpointBase="/api/recovery-ops" />
        </div>
      )}

      {/* Activity timeline */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Activity
        </div>
        <CaseTimeline key={rc.id} caseId={rc.id} />
      </div>

      {/* Actions */}
      <div style={{ padding: '16px 20px', flex: 1 }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
          Actions
        </div>
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
        {canAssign && tab === 'assign' && <AssignAgentTab caseId={rc.id} agents={agents} onDone={onAction} />}
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
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Assignment notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={submit} loading={saving} disabled={!agentId}>
            Assign {selectedIds.size} Case{selectedIds.size !== 1 ? 's' : ''}
          </Btn>
          <button onClick={onClose} style={{
            padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Filter options ────────────────────────────────────────────────────────────

const CASE_STATUS_OPTIONS = [
  { value: 'active',      label: 'Active',      color: BLUE },
  { value: 'legal',       label: 'Legal',       color: RED },
  { value: 'closed',      label: 'Closed' },
  { value: 'written_off', label: 'Written Off' },
]

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryCases() {
  const navigate = useNavigate()
  const [cases,    setCases]    = useState<RecoveryCase[]>([])
  const [agents,   setAgents]   = useState<AgentUser[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [selected, setSelected] = useState<RecoveryCase | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [reassignOpen, setReassignOpen] = useState(false)

  const [fStatus,  setFStatus]  = useState(new Set<string>())
  const [fProduct, setFProduct] = useState(new Set<string>())   // 'card' / 'loan'
  const [search,   setSearch]   = useState('')
  const [page,     setPage]     = useState(1)
  const [total,    setTotal]    = useState(0)
  const PAGE_SIZE = 50
  const dq = useDebouncedValue(search.trim(), 300)

  const fStatusKey = [...fStatus].sort().join(',')
  // A single selection filters to that product; selecting both (or none) = all.
  const fProductKey = fProduct.size === 1 ? [...fProduct][0] : ''

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
    if (fStatusKey)  params.set('status', fStatusKey)
    if (fProductKey) params.set('product_type', fProductKey)
    if (dq)          params.set('q', dq)
    // The agent list is only needed for the (head-only) assign action. Fetch it
    // independently so a 403 for a recovery agent — who has no admin access — can
    // never blank the whole case list, which is what the shared Promise.all did.
    try {
      const casesRes = await apiFetch<{ data: RecoveryCase[]; total: number }>(`/api/recovery-ops/cases?${params}`)
      setCases(casesRes.data ?? [])
      setTotal(casesRes.total ?? (casesRes.data ?? []).length)
      setSelected(prev => prev ? (casesRes.data ?? []).find(r => r.id === prev.id) ?? null : null)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load cases')
    } finally { setLoading(false) }
    try {
      const usersRes = await apiFetch<{ data: AgentUser[] }>('/api/recovery-ops/agents')
      setAgents(usersRes.data ?? [])
    } catch { /* non-fatal: assign dropdown just stays empty */ }
  }, [fStatusKey, fProductKey, dq, page])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['recovery'] })

  // Changing a filter or the search resets to the first page of the (new) queue.
  useEffect(() => { setPage(1) }, [fStatusKey, fProductKey, dq])

  // Head-only: seed recovery cases from the severe delinquency book. Recovery's
  // analogue of Collections' "Generate Assignments" — without it the module stays
  // empty because the collections->recovery hand-off is rarely run in bulk.
  // Assigning/reassigning cases is a supervisor capability — gated on the recovery_assign
  // page, exactly as the backend scopes the case list. A plain agent can view and work
  // their own cases but cannot assign, so all assign UI is hidden for them.
  const canAssign = useMemo(() => hasPage('recovery_assign'), [])
  const [generating, setGenerating] = useState(false)
  async function generateCases() {
    if (generating) return
    setGenerating(true)
    try {
      const res = await apiPost<{ data: { created: number } }>('/api/recovery-ops/generate-cases', {})
      const n = res?.data?.created ?? 0
      toast.success(n > 0 ? `${n} recovery case${n === 1 ? '' : 's'} opened from the delinquency book` : 'No new cases — every severe delinquency is already in recovery')
      await load(true)
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to generate cases')
    } finally { setGenerating(false) }
  }

  // Manual: move a specific customer into recovery by CIF (any DPD).
  const [addOpen, setAddOpen] = useState(false)
  const [addCif,  setAddCif]  = useState('')
  const [adding,  setAdding]  = useState(false)
  async function addCustomer() {
    const cif = addCif.trim()
    if (!cif || adding) return
    setAdding(true)
    try {
      const res = await apiPost<{ data: { case_id: number; case_ref: string; existing: boolean } }>('/api/recovery-ops/cases', { cif })
      const d = res?.data
      toast.success(d?.existing ? `${cif} is already in recovery (${d.case_ref})` : `Recovery case ${d?.case_ref} opened for ${cif}`)
      setAddOpen(false); setAddCif('')
      if (d?.case_id) navigate(`/recovery/cases/${d.case_id}`)
      else await load(true)
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to open case')
    } finally { setAdding(false) }
  }

  // Search + pagination are server-side now, so `cases` is already the current page of
  // the filtered queue; render it directly. Chip counts are omitted because they would
  // otherwise reflect only the current page, not the whole queue.
  const displayed = cases

  const groups: FilterGroupDef[] = [
    {
      key: 'status',
      label: 'STATUS',
      options: CASE_STATUS_OPTIONS.map(o => ({ ...o })),
      selected: fStatus,
      onChange: setFStatus,
    },
    {
      key: 'product',
      label: 'PRODUCT',
      options: [
        { value: 'card', label: 'Cards' },
        { value: 'loan', label: 'Loans', color: PURPLE },
      ],
      selected: fProduct,
      onChange: setFProduct,
    },
  ]

  function resetFilters() { setFStatus(new Set()); setFProduct(new Set()); setSearch('') }

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
      title="Recovery Cases"
      subtitle="Manage recovery cases and actions"
      noPad
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canAssign && (
            <button onClick={() => setAddOpen(true)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md,
              border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>
              Add Customer
            </button>
          )}
          {canAssign && (
            <button onClick={generateCases} disabled={generating} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md,
              border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
              cursor: generating ? 'not-allowed' : 'pointer', opacity: generating ? 0.6 : 1, whiteSpace: 'nowrap',
            }}>
              {generating ? <Spinner size={13} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 16 }}>playlist_add</span>}
              Generate Cases
            </button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div style={{
          minWidth: 320, maxWidth: 380, width: 360,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)', flexShrink: 0,
        }}>
          {/* Filter bar */}
          <ExpandableFilterBar
            search={search}
            onSearch={setSearch}
            groups={groups}
            onReset={resetFilters}
            onApply={load}
            resultCount={cases.length}
            totalCount={total}
            placeholder="Search CIF, case ref, agent…"
          />

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>{checkedIds.size} selected</span>
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
                No cases match the current filters.
              </div>
            ) : (
              displayed.map(rc => {
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
                    {canAssign && (
                      <input
                        type="checkbox" checked={isChecked}
                        onClick={e => toggleCheck(rc.id, e)} onChange={() => {}}
                        style={{ marginTop: 3, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                          <NameCell
                            name={rc.customer_name ?? rc.case_ref ?? rc.account_cif}
                            sub={rc.case_ref ? `${rc.case_ref} · ${rc.product_type === 'loan' ? 'Mandate' : 'CIF'} ${rc.account_cif}` : rc.account_cif}
                            avatar={false}
                          />
                          {rc.product_type === 'loan' && (
                            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: PURPLE, background: `${PURPLE}18`, padding: '1px 6px', borderRadius: RADIUS.full, flexShrink: 0 }}>LOAN</span>
                          )}
                          <ManualBadge source={rc.data_source} />
                        </div>
                        <StatusBadge status={rc.status} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                          {fmtKoboExact(net)}
                        </span>
                        {rc.legal_stage && (
                          <span style={{ ...NUM, fontSize: TEXT['2xs'], color: AMBER }}>⚖ {rc.legal_stage}</span>
                        )}
                      </div>
                      {/* Credit terms — same set as the Credit Portfolio, adapted to a case:
                          LOC/Principal, Min Repayment, % recovered and a payment-tier badge. */}
                      {(() => {
                        const isLoan = rc.product_type === 'loan'
                        const loc = isLoan ? Number(rc.loan_amount_kobo ?? 0) : Math.round(Number(rc.credit_limit ?? 0) * 100)
                        const minRep = isLoan ? rc.outstanding_kobo : Math.round(Number(rc.min_payment ?? 0) * 100)
                        const pctRec = rc.outstanding_kobo > 0 ? Math.round((rc.recovered_kobo / rc.outstanding_kobo) * 100) : 0
                        return (
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 12px', marginBottom: 4 }}>
                            <Term label={isLoan ? 'Principal' : 'LOC'} value={fmtKoboExact(loc)} />
                            <Term label="Min Rep" value={fmtKoboExact(minRep)} />
                            <Term label="Recovered" value={`${fmtKoboExact(rc.recovered_kobo)} · ${pctRec}%`} valueColor={rc.recovered_kobo > 0 ? GREEN : undefined} />
                            <TierBadge tier={tierFromPct(pctRec)} />
                          </div>
                        )
                      })()}
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4 }}>
                        {rc.agent_name
                          ? rc.agent_name
                          : rc.product_type === 'loan' && rc.officer_name
                            ? `Officer: ${rc.officer_name}`
                            : <span style={{ color: RED }}>Unassigned</span>}
                      </div>
                      {rc.last_call_agent && (
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span className="material-symbols-rounded" style={{ fontSize: 13, color: BLUE }}>call</span>
                          Call centre: {rc.last_call_agent}{rc.last_call_at ? ` · ${fmtDate(rc.last_call_at)}` : ''}
                        </div>
                      )}
                      {rc.last_payment_amount != null && (
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4 }}>
                          Last paid <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtExact(rc.last_payment_amount)}</span>
                          {rc.last_payment_date ? ` · ${fmtDate(rc.last_payment_date)}` : ''}
                        </div>
                      )}
                      <ActionRow actions={[
                        { icon: 'open_in_full', label: 'Full Detail', onClick: () => navigate(`/recovery/cases/${rc.id}`) },
                        ...(canAssign ? [{ icon: 'person_add', label: 'Assign Agent', onClick: () => setSelected(rc) }] : []),
                      ]} />
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Pagination — compact to fit the narrow master list (the whole-queue
              total is already shown in the filter bar above as "N of TOTAL"). */}
          <Pagination
            page={page}
            pages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
            onPage={setPage}
            showRange={false}
            maxButtons={3}
          />
        </div>

        {/* ── Right panel ──────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'auto' }}>
          {selected ? (
            <DetailPanel key={selected.id} rc={selected} agents={agents} onAction={load} canAssign={canAssign} />
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 12, color: 'var(--txt2)',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>gavel</span>
              <span style={{ fontSize: TEXT.md }}>Select a case from the list</span>
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

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Move Customer to Recovery" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
            Open a recovery case for a specific customer by CIF — regardless of DPD. Their
            outstanding and days-past-due are pulled from the delinquency book, and the
            account is taken out of the collections queue.
          </div>
          <input
            value={addCif}
            onChange={e => setAddCif(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addCustomer() }}
            placeholder="Customer CIF"
            autoFocus
            style={{ ...filterInputStyle, width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setAddOpen(false)} style={{
              padding: '8px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
              background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
            }}>Cancel</button>
            <button onClick={addCustomer} disabled={!addCif.trim() || adding} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: RADIUS.md,
              border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
              cursor: (!addCif.trim() || adding) ? 'not-allowed' : 'pointer', opacity: (!addCif.trim() || adding) ? 0.6 : 1,
            }}>
              {adding && <Spinner size={13} color="#fff" />}
              Open Case
            </button>
          </div>
        </div>
      </Modal>
    </Page>
  )
}
