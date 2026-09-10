// Collections → Credit File. Opened from the Credit Portfolio, the Queue and the
// Watchlist by CIF.
//
// This page used to show one aggregated outstanding figure for the CIF and four
// counters. That answered "how late is this account?" but not the questions an
// officer on a call actually has: what credit is this, what was it supposed to
// repay and when, how much of each instalment has landed, and is this even the
// same customer Customer 360 is showing? It now answers all four — identity comes
// through the same party layer C360 uses, and the credit itself is broken out
// facility by facility with a schedule under each one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, SectionCard, Spinner, ErrBanner, Modal, EmptyState } from '../../components/UI'
import { LogPaymentModal } from '../../components/LogPaymentModal'
import CallsPanel from '../../components/CallsPanel'
import {
  useCreditDossier, ExposureStrip, FacilityRail, FacilityTerms, ScheduleTable,
  RepaymentLedger, CaseContext, CustomerDetails, Meter, isInternalId, type Facility,
} from '../../components/CreditFile'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { hasPage } from '../../hooks/useAuth'
import { fmtKoboExact, fmtDate, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

function getStoredRole(): string {
  try { return (JSON.parse(localStorage.getItem('o3c_user') ?? 'null') as { role?: string } | null)?.role ?? '' } catch { return '' }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AccountDetail {
  loan_id: number
  applicant_cif: string
  applicant_name: string
  product_type: string | null
  principal_kobo: number
  loan_status: string
  loan_created_at: string
  assignment_id: number | null
  agent_user_id: number | null
  agent_name: string | null
  assignment_date: string | null
  dpd_bucket: string | null
  dpd_lower: number
  outstanding_kobo: number
  current_stage: string | null
  assignment_notes: string | null
  watchlist_id: number | null
  watchlist_scenario: string | null
  watchlist_notes: string | null
  watchlist_flagged_by: string | null
  watchlist_flagged_at: string | null
  total_contacts: number
  ptps_created: number
  ptps_kept: number
  total_paid_kobo: number
  last_contact_at: string | null
  last_contact_outcome: string | null
}

interface ActivityEvent {
  id: number
  ts: string
  module: string
  actor_name: string
  actor_role: string
  action: string
  description: string
}

interface ContactEntry {
  id: number
  contact_type: string
  outcome: string
  notes: string | null
  created_at: string
  agent_name: string | null
}

interface PromiseEntry {
  id: number
  promise_amount_kobo: number
  promise_date: string
  status: string
  created_at: string
  agent_name: string | null
}

interface PaymentEntry {
  id: number
  amount_kobo: number
  payment_date: string
  payment_method: string
  channel?: string | null
  reference: string | null
  received_by_name: string | null
  status?: string | null
}

interface AgentUser { id: number; full_name: string; role: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const SCENARIOS = [
  { value: 'unreachable',         label: 'Unreachable' },
  { value: 'legal_threat',        label: 'Legal Threat' },
  { value: 'dispute',             label: 'Dispute' },
  { value: 'employer_terminated', label: 'Employer Terminated' },
  { value: 'property_risk',       label: 'Property Risk' },
  { value: 'other',               label: 'Other' },
]

const CONTACT_TYPES = [
  { value: 'phone',        label: 'Phone Call' },
  { value: 'sms',          label: 'SMS' },
  { value: 'whatsapp',     label: 'WhatsApp' },
  { value: 'email',        label: 'Email' },
  { value: 'field_visit',  label: 'Field Visit' },
]

const OUTCOMES = [
  { value: 'answered',         label: 'Answered' },
  { value: 'no_answer',        label: 'No Answer' },
  { value: 'not_reachable',    label: 'Not Reachable' },
  { value: 'promised_to_pay',  label: 'Promised to Pay' },
  { value: 'refused_to_pay',   label: 'Refused to Pay' },
]

const ACTION_META: Record<string, { label: string; color: string }> = {
  contact_logged:           { label: 'Contact',     color: NAVY  },
  promise_created:          { label: 'PTP',         color: GREEN },
  promise_honoured:         { label: 'PTP Kept',    color: GREEN },
  promise_broken:           { label: 'PTP Broken',  color: RED   },
  payment_logged:           { label: 'Payment',     color: GREEN },
  payment_approved:         { label: 'Approved',    color: GREEN },
  payment_rejected:         { label: 'Rejected',    color: RED   },
  sent_to_recovery:         { label: 'Recovery',    color: RED   },
  plan_created:             { label: 'Plan',        color: NAVY  },
  instalment_paid:          { label: 'Instalment',  color: GREEN },
  watchlist_flagged:        { label: 'Flagged',     color: AMBER },
  watchlist_resolved:       { label: 'Resolved',    color: GREEN },
  writeoff_requested:       { label: 'Write-off',   color: AMBER },
  writeoff_approved:        { label: 'Approved WO', color: RED   },
  legal_milestone_added:    { label: 'Legal',       color: NAVY  },
  bulk_reassigned:          { label: 'Reassigned',  color: NAVY  },
  bulk_sent_to_recovery:    { label: 'Bulk Rcvry',  color: RED   },
}

const POLL_INTERVAL = 10_000 // 10s

// ── Helpers ───────────────────────────────────────────────────────────────────

function dpdColor(dpd: number) {
  if (dpd > 90) return RED
  if (dpd > 60) return '#EA580C'
  if (dpd > 30) return AMBER
  return GREEN
}

function DpdBadge({ dpd, bucket }: { dpd: number; bucket: string | null }) {
  const c = dpdColor(dpd)
  return (
    <span style={{
      ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold,
      padding: '3px 10px', borderRadius: RADIUS['2xl'],
      background: `${c}18`, color: c, whiteSpace: 'nowrap',
    }}>
      {bucket ?? '0d'}
    </span>
  )
}

function ActionBadge({ action }: { action: string }) {
  const m = ACTION_META[action] ?? { label: action, color: NAVY }
  return (
    <span style={{
      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em', textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: RADIUS.full,
      background: `${m.color}18`, color: m.color, whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  )
}

const PTP_COLOR: Record<string, string> = { kept: GREEN, broken: RED, pending: AMBER }

function Btn({
  label, icon, color = NAVY, onClick, disabled = false,
}: { label: string; icon: string; color?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '7px 14px', borderRadius: RADIUS.md,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1.5px solid ${color}40`, background: `${color}10`, color,
        fontSize: TEXT.sm, fontWeight: FW.semibold, opacity: disabled ? 0.5 : 1,
        display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{icon}</span>
      {label}
    </button>
  )
}

const inputSt: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  boxSizing: 'border-box', fontFamily: 'inherit',
}

const labelSt: React.CSSProperties = {
  display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold,
  color: 'var(--txt2)', marginBottom: 6,
}

function ChipGroup<T extends string>({
  options, value, onChange, accent = NAVY,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; accent?: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm,
            fontWeight: FW.semibold, cursor: 'pointer', fontFamily: 'inherit',
            border: `1.5px solid ${value === o.value ? accent : 'var(--bdr)'}`,
            background: value === o.value ? accent : 'var(--card)',
            color: value === o.value ? '#fff' : 'var(--txt)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Tab content ───────────────────────────────────────────────────────────────

export function TimelineTab({ cif, version }: { cif: string; version: number }) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiFetch<{ data: ActivityEvent[] }>(`/api/collections/activity/cif/${cif}`)
      .then(r => setEvents(r.data ?? []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false))
  }, [cif, version])

  if (loading) return <div style={{ padding: SP[5], display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div>

  if (events.length === 0) return (
    <div style={{ padding: `${SP[8]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
      No activity recorded yet
    </div>
  )

  return (
    <div style={{ padding: `${SP[3]} 0` }}>
      {events.map((ev, i) => {
        const dot = ACTION_META[ev.action]?.color ?? NAVY
        return (
          <div key={ev.id} style={{ display: 'flex', gap: 12, padding: `0 ${SP[4]}` }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                marginTop: 14, background: dot,
                border: '2px solid var(--card)',
                boxShadow: `0 0 0 2px ${dot}40`,
              }} />
              {i < events.length - 1 && (
                <div style={{ width: 1.5, flex: 1, background: 'var(--bdr)', minHeight: 20 }} />
              )}
            </div>
            <div style={{ flex: 1, paddingTop: SP[2], paddingBottom: SP[3] }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <ActionBadge action={ev.action} />
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                  {fmtDatetime(ev.ts)}
                </span>
              </div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', marginBottom: 2 }}>
                {ev.description}
              </div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                {ev.actor_name}
                {ev.actor_role && <> · <span style={{ textTransform: 'capitalize' }}>{ev.actor_role.replace(/_/g, ' ')}</span></>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ContactsTab({ assignmentId, version }: { assignmentId: number | null; version: number }) {
  const [contacts, setContacts] = useState<ContactEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!assignmentId) { setLoading(false); return }
    setLoading(true)
    apiFetch<{ data: ContactEntry[] }>(`/api/collections-ops/${assignmentId}/contacts`)
      .then(r => setContacts(r.data ?? []))
      .catch(() => setContacts([]))
      .finally(() => setLoading(false))
  }, [assignmentId, version])

  if (loading) return <div style={{ padding: SP[5], display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div>
  if (!assignmentId) return <div style={{ padding: SP[4], color: 'var(--txt3)', fontSize: TEXT.sm }}>No assignment on record</div>

  if (contacts.length === 0) return (
    <div style={{ padding: `${SP[8]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
      No contacts logged yet
    </div>
  )

  return (
    <div>
      {contacts.map(c => (
        <div key={c.id} style={{
          padding: `${SP[3]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)',
          display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start',
        }}>
          <div>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>
              {(c.contact_type ?? '').replace(/_/g, ' ')}
              {' · '}
              <span style={{ fontWeight: FW.normal, color: 'var(--txt2)' }}>
                {(c.outcome ?? '').replace(/_/g, ' ')}
              </span>
            </div>
            {c.notes && (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: 2 }}>{c.notes}</div>
            )}
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {c.agent_name ?? '—'} · {fmtDatetime(c.created_at)}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function PromisesTab({ cif, version }: { cif: string; version: number }) {
  const [promises, setPromises] = useState<PromiseEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiFetch<{ data: PromiseEntry[] }>(`/api/collections-ops/promises?q=${encodeURIComponent(cif)}`)
      .then(r => setPromises(r.data ?? []))
      .catch(() => setPromises([]))
      .finally(() => setLoading(false))
  }, [cif, version])

  if (loading) return <div style={{ padding: SP[5], display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div>

  if (promises.length === 0) return (
    <div style={{ padding: `${SP[8]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
      No PTPs recorded
    </div>
  )

  return (
    <div>
      {promises.map(p => (
        <div key={p.id} style={{
          padding: `${SP[3]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)',
          display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center',
        }}>
          <div>
            <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>
              {fmtKoboExact(p.promise_amount_kobo)}, due {fmtDate(p.promise_date)}
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {p.agent_name ?? '—'} · {fmtDatetime(p.created_at)}
            </div>
          </div>
          <span style={{
            fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.04em',
            padding: '2px 8px', borderRadius: RADIUS.full,
            background: `${PTP_COLOR[p.status] ?? NAVY}18`, color: PTP_COLOR[p.status] ?? NAVY,
          }}>
            {p.status}
          </span>
        </div>
      ))}
    </div>
  )
}

// PaymentsTab is CIF-keyed. It used to read /collections-ops/{assignmentId}/payments,
// which could only ever see payments carrying an assignment_id — and 1,721 of the
// 1,798 rows in the book (the historical and CRM imports) carry none, so the tab
// showed nothing while the header counted them in "total paid". The CIF is the key
// collection_payments is actually stored under.
export function PaymentsTab({ cif, assignmentId, version }: { cif?: string; assignmentId: number | null; version: number }) {
  const [payments, setPayments] = useState<PaymentEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!cif && !assignmentId) { setLoading(false); return }
    setLoading(true)
    const url = cif
      ? `/api/collections-ops/payments/by-cif?cif=${encodeURIComponent(cif)}`
      : `/api/collections-ops/${assignmentId}/payments`
    apiFetch<{ data: PaymentEntry[] }>(url)
      .then(r => setPayments(r.data ?? []))
      .catch(() => setPayments([]))
      .finally(() => setLoading(false))
  }, [cif, assignmentId, version])

  if (loading) return <div style={{ padding: SP[5], display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div>
  if (!cif && !assignmentId) return <div style={{ padding: SP[4], color: 'var(--txt3)', fontSize: TEXT.sm }}>No assignment on record</div>

  if (payments.length === 0) return (
    <div style={{ padding: `${SP[8]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
      No payments recorded
    </div>
  )

  return (
    <div>
      {payments.map(p => (
        <div key={p.id} style={{
          padding: `${SP[3]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)',
          display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center',
        }}>
          <div>
            <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN, marginBottom: 2 }}>
              {fmtKoboExact(p.amount_kobo)}
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {(p.payment_method ?? p.channel ?? '').replace(/_/g, ' ')}
              {p.reference ? ` · ${p.reference}` : ''}
              {p.received_by_name ? ` · by ${p.received_by_name}` : ''}
            </div>
          </div>
          <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {fmtDate(p.payment_date)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type ModalType =
  | 'contact' | 'ptp' | 'payment'
  | 'watchlist_add' | 'watchlist_resolve'
  | 'reassign' | 'send_to_recovery'
  | null

export default function CollectionsAccountDetail() {
  const { cif } = useParams<{ cif: string }>()
  const navigate = useNavigate()
  const role = getStoredRole()
  const isHead = ['collections_head', 'head_collections', 'admin', 'management', 'md', 'coo'].includes(role)

  const [detail, setDetail]     = useState<AccountDetail | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [activeTab, setTab]     = useState<'schedule' | 'repayments' | 'timeline' | 'contacts' | 'calls' | 'promises'>('schedule')
  const [openModal, setModal]   = useState<ModalType>(null)
  const [agents, setAgents]     = useState<AgentUser[]>([])
  const [saving, setSaving]     = useState(false)
  const [version, setVersion]   = useState(0)
  const [selectedKey, setSelectedKey] = useState('')
  const pollRef                 = useRef<number | null>(null)

  const { data: credit, loading: creditLoading, error: creditError, reload: reloadCredit } = useCreditDossier(cif)

  // Log contact form
  const [ctType, setCtType]       = useState<string>('phone')
  const [ctOutcome, setCtOutcome] = useState<string>('answered')
  const [ctNotes, setCtNotes]     = useState('')

  // PTP form
  const [ptpAmount, setPtpAmount] = useState('')
  const [ptpDate,   setPtpDate]   = useState('')

  // Watchlist forms
  const [wlScenario, setWlScenario] = useState('unreachable')
  const [wlNotes, setWlNotes]       = useState('')
  const [rvStatus, setRvStatus]     = useState('resolved')
  const [rvNotes, setRvNotes]       = useState('')

  // Reassign
  const [newAgentId, setNewAgentId] = useState('')

  const loadDetail = useCallback(async (silent = false) => {
    if (!cif) return
    if (!silent) { setLoading(true); setError(null) }
    try {
      const res = await apiFetch<{ data: AccountDetail }>(`/api/collections/accounts/${cif}`)
      setDetail(res.data ?? null)
      setVersion(v => v + 1)
    } catch (e: any) {
      if (!silent) setError(e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [cif])

  const refreshAll = useCallback(() => { loadDetail(); reloadCredit() }, [loadDetail, reloadCredit])

  useEffect(() => {
    loadDetail()
    pollRef.current = window.setInterval(() => loadDetail(true), POLL_INTERVAL)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [loadDetail])

  useEffect(() => {
    if (isHead) {
      apiFetch<{ data: AgentUser[] }>('/api/admin/users')
        .then(r => setAgents(r.data ?? []))
        .catch(() => {})
    }
  }, [isHead])

  // Open on the facility this account is actually filed under.
  useEffect(() => {
    if (!credit || credit.facilities.length === 0) return
    setSelectedKey(k => (credit.facilities.some(f => f.key === k) ? k : credit.facilities[0].key))
  }, [credit])

  const selected: Facility | null = useMemo(
    () => credit?.facilities.find(f => f.key === selectedKey) ?? credit?.facilities[0] ?? null,
    [credit, selectedKey],
  )

  async function logContact() {
    if (!detail?.assignment_id) return
    setSaving(true)
    try {
      await apiPost(`/api/collections-ops/${detail.assignment_id}/contact`, {
        contact_type: ctType, outcome: ctOutcome, notes: ctNotes || null,
      })
      toast.success('Contact logged')
      setModal(null); setCtNotes(''); setCtType('phone'); setCtOutcome('answered')
      refreshAll()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function createPTP() {
    if (!detail?.assignment_id) return
    const naira = parseFloat(ptpAmount.replace(/,/g, ''))
    if (!naira || naira <= 0) { toast.error('Enter a valid amount'); return }
    if (!ptpDate) { toast.error('Select a promise date'); return }
    setSaving(true)
    try {
      await apiPost(`/api/collections-ops/${detail.assignment_id}/promise`, {
        amount_kobo: Math.round(naira * 100),
        promise_date: ptpDate,
      })
      toast.success('PTP created')
      setModal(null); setPtpAmount(''); setPtpDate('')
      refreshAll()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function addWatchlist() {
    if (!cif) return
    setSaving(true)
    try {
      await apiPost('/api/collections/watchlist', {
        account_cif: cif, scenario: wlScenario, notes: wlNotes || null,
        dpd_at_flag: detail?.dpd_lower, outstanding_kobo: detail?.outstanding_kobo,
      })
      toast.success('Added to watchlist')
      setModal(null); setWlNotes(''); setWlScenario('unreachable')
      refreshAll()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function resolveWatchlist() {
    if (!detail?.watchlist_id) return
    setSaving(true)
    try {
      await apiPut(`/api/collections/watchlist/${detail.watchlist_id}/resolve`, {
        status: rvStatus, resolution_notes: rvNotes || null,
      })
      toast.success(rvStatus === 'resolved' ? 'Flag resolved' : 'Escalated to recovery')
      setModal(null); setRvNotes(''); setRvStatus('resolved')
      refreshAll()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function reassign() {
    if (!detail?.assignment_id || !newAgentId) return
    setSaving(true)
    try {
      await apiPut(`/api/collections-ops/${detail.assignment_id}/assign`, {
        agent_id: Number(newAgentId), notes: '',
      })
      toast.success('Account reassigned')
      setModal(null); setNewAgentId('')
      refreshAll()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function sendToRecovery() {
    if (!detail?.assignment_id) return
    setSaving(true)
    try {
      await apiPost(`/api/collections-ops/${detail.assignment_id}/send-to-recovery`, {})
      toast.success('Sent to recovery')
      setModal(null)
      refreshAll()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  const collectionAgents = agents.filter(a =>
    ['collections_agent', 'collections_head', 'head_collections'].includes(a.role)
  )

  const TABS = [
    { key: 'schedule'   as const, label: 'Repayment Schedule', icon: 'calendar_month' },
    { key: 'repayments' as const, label: 'Repayments',         icon: 'payments'       },
    { key: 'timeline'   as const, label: 'Timeline',           icon: 'history'        },
    { key: 'contacts'   as const, label: 'Contacts',           icon: 'call'           },
    { key: 'calls'      as const, label: 'Calls',              icon: 'phone_in_talk'  },
    { key: 'promises'   as const, label: 'Promises',           icon: 'handshake'      },
  ]

  if (loading) return (
    <Page title="Credit File">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  if (error || !detail) return (
    <Page title="Credit File">
      <ErrBanner error={error ?? 'Account not found'} onRetry={() => loadDetail()} />
    </Page>
  )

  const d = detail
  const cust = credit?.customer
  // The collections book carries its own uploaded spelling of the name; the customer
  // master is canonical. Show the master name, and surface the book's alias so an
  // officer holding the uploaded sheet still recognises the record.
  const displayName = cust?.name || (d.applicant_name !== d.applicant_cif ? d.applicant_name : `Account ${d.applicant_cif}`)
  const bookAlias = d.applicant_name && d.applicant_name !== d.applicant_cif
    && cust?.name && d.applicant_name.toLowerCase() !== cust.name.toLowerCase()
    ? d.applicant_name : ''
  const linkedCount = (cust?.linked_ids?.length ?? 1) - 1

  // Three identifiers, and only three: the Customer ID, the card CIF, and the Udara
  // id. The account key this page was opened on is an internal handle for borrowers
  // who hold a loan and no card — it is not a CIF and is never shown as one.
  const idLine = (() => {
    const parts: string[] = []
    if (cust?.customer_id) parts.push(cust.customer_id)
    const cifs = (cust?.cifs ?? []).filter(c => !isInternalId(c))
    if (cifs.length === 1) parts.push(`CIF ${cifs[0]}`)
    else if (cifs.length > 1) parts.push(`${cifs.length} CIFs`)
    else parts.push('No card')
    const udara = cust?.udara_customers ?? []
    if (udara.length) parts.push(`Udara ${udara.join(', ')}`)
    if (d.product_type && d.product_type !== '—') parts.push(d.product_type)
    return parts.join(' · ')
  })()

  return (
    <Page
      title={displayName}
      subtitle={idLine}
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={refreshAll}
            title="Refresh"
            style={{
              padding: '6px 10px', borderRadius: RADIUS.md, cursor: 'pointer',
              border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)',
              display: 'inline-flex', alignItems: 'center',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span>
          </button>
          <button
            onClick={() => navigate(-1)}
            style={{
              padding: '6px 12px', borderRadius: RADIUS.md, cursor: 'pointer',
              border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)',
              fontSize: TEXT.sm, fontWeight: FW.semibold,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_back</span>
            Back
          </button>
          <button
            onClick={() => navigate(`/customers/${d.applicant_cif}`)}
            style={{
              padding: '6px 12px', borderRadius: RADIUS.md, cursor: 'pointer',
              border: 'none', background: NAVY, color: '#fff',
              fontSize: TEXT.sm, fontWeight: FW.semibold,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>account_circle</span>
            Customer 360
          </button>
        </div>
      }
    >
      {/* ── Identity masthead ────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl,
        padding: `${SP[4]} ${SP[5]}`, marginBottom: SP[4],
        display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: SP[6], alignItems: 'start',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: SP[3] }}>
            <DpdBadge dpd={d.dpd_lower} bucket={d.dpd_bucket} />
            <span style={{
              fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.05em',
              padding: '2px 7px', borderRadius: RADIUS.full, textTransform: 'uppercase',
              background: d.dpd_lower > 90 ? `${RED}12` : `${NAVY}10`,
              color: d.dpd_lower > 90 ? RED : NAVY,
            }}>
              {d.dpd_lower > 90 ? 'Recovery' : 'Collections'}
            </span>
            {d.current_stage && (
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontStyle: 'italic' }}>
                {d.current_stage.replace(/_/g, ' ')}
              </span>
            )}
            {d.watchlist_scenario && (
              <span style={{
                fontSize: TEXT['2xs'], fontWeight: FW.semibold,
                padding: '2px 8px', borderRadius: RADIUS.full,
                background: `${AMBER}18`, color: AMBER,
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 11 }}>flag</span>
                {SCENARIOS.find(s => s.value === d.watchlist_scenario)?.label ?? d.watchlist_scenario}
              </span>
            )}
            {linkedCount > 0 && (
              <span style={{
                fontSize: TEXT['2xs'], fontWeight: FW.semibold,
                padding: '2px 8px', borderRadius: RADIUS.full,
                background: `${PURPLE}14`, color: PURPLE,
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 11 }}>link</span>
                {linkedCount} other {linkedCount === 1 ? 'id' : 'ids'} on this customer
              </span>
            )}
          </div>

          {bookAlias && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: SP[2] }}>
              Filed in the collections book as <span style={{ fontWeight: FW.semibold, color: 'var(--txt2)' }}>{bookAlias}</span>
            </div>
          )}

          <div style={{
            display: 'grid', gap: `${SP[2]} ${SP[5]}`,
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          }}>
            <IdLine icon="badge" label="Handler" value={d.agent_name ?? 'Unassigned'}
                    sub={d.assignment_date ? `since ${fmtDate(d.assignment_date)}` : ''} />
            {cust?.phone && <IdLine icon="call" label="Phone" value={cust.phone} />}
            {cust?.email && <IdLine icon="mail" label="Email" value={cust.email} />}
            {cust?.employer && <IdLine icon="apartment" label="Employer" value={cust.employer} />}
            {d.last_contact_at && (
              <IdLine icon="history" label="Last contact" value={fmtDate(d.last_contact_at)}
                      sub={d.last_contact_outcome ? d.last_contact_outcome.replace(/_/g, ' ') : ''} />
            )}
            {(cust?.city || cust?.state) && (
              <IdLine icon="location_on" label="Location" value={[cust?.city, cust?.state].filter(Boolean).join(', ')} />
            )}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', marginBottom: 6,
            letterSpacing: '0.07em', textTransform: 'uppercase',
          }}>
            Outstanding
          </div>
          <div style={{
            ...NUM, fontSize: 34, fontWeight: FW.extrabold, lineHeight: 1,
            color: d.dpd_lower > 90 ? RED : d.dpd_lower > 30 ? AMBER : GREEN,
          }}>
            {fmtKoboExact(d.outstanding_kobo)}
          </div>
          <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 6 }}>
            {fmtKoboExact(d.total_paid_kobo)} received to date
          </div>
          <div style={{ display: 'flex', gap: SP[4], justifyContent: 'flex-end', marginTop: SP[3] }}>
            <MiniStat label="Contacts" value={d.total_contacts} />
            <MiniStat label="PTPs" value={d.ptps_created} />
            <MiniStat label="Kept" value={d.ptps_kept} color={GREEN} />
          </div>
        </div>
      </div>

      {/* ── Action bar ───────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: SP[4],
        padding: `${SP[3]} ${SP[4]}`,
        background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg,
      }}>
        {d.assignment_id && (
          <>
            <Btn label="Log Contact"  icon="call"       onClick={() => setModal('contact')} />
            <Btn label="Create PTP"   icon="handshake"  onClick={() => setModal('ptp')} />
            <Btn label="Log Payment"  icon="payments"   color={GREEN} onClick={() => setModal('payment')} />
          </>
        )}
        {d.watchlist_id ? (
          <Btn
            label="Resolve Flag" icon="flag_check" color={AMBER}
            onClick={() => { setRvStatus('resolved'); setRvNotes(''); setModal('watchlist_resolve') }}
          />
        ) : (
          <Btn
            label="Flag Watchlist" icon="flag" color={AMBER}
            onClick={() => { setWlScenario('unreachable'); setWlNotes(''); setModal('watchlist_add') }}
          />
        )}
        {isHead && d.assignment_id && (
          <>
            <div style={{ width: 1, background: 'var(--bdr)', alignSelf: 'stretch', margin: '0 4px' }} />
            <Btn label="Reassign"          icon="swap_horiz" onClick={() => { setNewAgentId(''); setModal('reassign') }} />
            {d.dpd_lower <= 90 && (
              <Btn label="Send to Recovery" icon="gavel"      color={RED} onClick={() => setModal('send_to_recovery')} />
            )}
          </>
        )}
      </div>

      {/* ── The credit itself ────────────────────────────────────────────────── */}
      {creditError && <ErrBanner error={creditError} onRetry={() => reloadCredit()} />}

      {creditLoading && !credit && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: SP[10] }}><Spinner size={26} /></div>
      )}

      {credit && (
        <>
          <CaseContext
            recovery={credit.recovery_case}
            accommodations={credit.accommodations ?? []}
            // Only offer the jump to someone who can actually open Recovery.
            onOpenRecovery={hasPage('recovery') && credit.recovery_case?.id
              ? () => navigate(`/recovery/cases/${credit.recovery_case.id}`)
              : undefined}
          />
          <CustomerDetails c={credit.customer} />
          <ExposureStrip t={credit.totals} />

          <SectionCard
            title="Facilities"
            subtitle={
              credit.facilities.length === 0
                ? 'No card or loan facility is linked to this customer'
                : `Every credit line held by ${credit.customer.name}${linkedCount > 0 ? `, across all ${credit.customer.linked_ids.length} of their ids` : ''}. Select one to see its schedule.`
            }
            padding={false}
          >
            <div style={{ padding: `${SP[4]} ${SP[4]} 0` }}>
              <FacilityRail facilities={credit.facilities} selected={selected?.key ?? ''} onSelect={setSelectedKey} />
            </div>
          </SectionCard>
        </>
      )}

      {/* ── Selected facility + working tabs ─────────────────────────────────── */}
      <SectionCard title="" padding={false} style={{ marginTop: SP[4] }}>
        {selected && (
          <div style={{
            padding: `${SP[4]} ${SP[5]} ${SP[3]}`, borderBottom: '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: SP[4], flexWrap: 'wrap',
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>
                {selected.product}
              </div>
              <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
                {selected.origin} · {selected.ref || '—'}{selected.cif ? ` · CIF ${selected.cif}` : ''}
              </div>
            </div>
            {selected.scheduled_kobo > 0 && (
              <div style={{ minWidth: 190 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--txt3)' }}>
                    Schedule paid
                  </span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color: selected.paid_pct >= 80 ? GREEN : selected.paid_pct >= 40 ? AMBER : RED }}>
                    {selected.paid_pct.toFixed(1)}%
                  </span>
                </div>
                <Meter pct={selected.paid_pct} color={selected.paid_pct >= 80 ? GREEN : selected.paid_pct >= 40 ? AMBER : RED} />
                <div style={{ ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 5 }}>
                  {fmtKoboExact(selected.paid_kobo)} of {fmtKoboExact(selected.scheduled_kobo)}
                  {selected.arrears_kobo > 0 && <span style={{ color: RED }}> · {fmtKoboExact(selected.arrears_kobo)} in arrears</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {selected && <FacilityTerms f={selected} />}

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, padding: '8px 16px', borderBottom: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '5px 14px', borderRadius: RADIUS.md, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: TEXT.sm, fontWeight: activeTab === t.key ? FW.semibold : FW.normal,
                border: activeTab === t.key ? `1.5px solid ${NAVY}` : '1.5px solid transparent',
                background: activeTab === t.key ? NAVY : 'transparent',
                color: activeTab === t.key ? '#fff' : 'var(--txt2)',
                display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', alignSelf: 'center', paddingRight: 8 }}>
            Live · updates every 10s
          </span>
        </div>

        {activeTab === 'schedule' && (
          selected
            ? <ScheduleTable f={selected} />
            : <EmptyState icon="credit_card_off" title="No facility on file"
                          description="No card or loan is linked to this CIF, so there is no schedule to show." />
        )}
        {activeTab === 'repayments' && (
          credit
            ? <RepaymentLedger repayments={credit.repayments} />
            : <div style={{ padding: SP[5], display: 'flex', justifyContent: 'center' }}><Spinner size={24} /></div>
        )}
        {activeTab === 'timeline' && <TimelineTab cif={d.applicant_cif} version={version} />}
        {activeTab === 'contacts' && <ContactsTab assignmentId={d.assignment_id} version={version} />}
        {activeTab === 'calls'    && <CallsPanel cif={d.applicant_cif} />}
        {activeTab === 'promises' && <PromisesTab cif={d.applicant_cif} version={version} />}
      </SectionCard>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}

      <Modal open={openModal === 'contact'} onClose={() => setModal(null)} title="Log Contact" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={logContact} disabled={saving} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>
              Log
            </button>
            <button onClick={() => setModal(null)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><label style={labelSt}>Contact Type</label><ChipGroup options={CONTACT_TYPES} value={ctType} onChange={setCtType} /></div>
          <div><label style={labelSt}>Outcome</label><ChipGroup options={OUTCOMES} value={ctOutcome} onChange={setCtOutcome} /></div>
          <div>
            <label style={labelSt}>Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea value={ctNotes} onChange={e => setCtNotes(e.target.value)} rows={3} placeholder="Notes from the contact…" style={{ ...inputSt, resize: 'vertical' }} />
          </div>
        </div>
      </Modal>

      <Modal open={openModal === 'ptp'} onClose={() => setModal(null)} title="Create Promise-to-Pay (PTP)" width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={createPTP} disabled={saving} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>handshake</span>
              Record PTP
            </button>
            <button onClick={() => setModal(null)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelSt}>Amount (₦)</label>
            <input type="number" min="0" step="0.01" placeholder="0.00" value={ptpAmount} onChange={e => setPtpAmount(e.target.value)} autoFocus style={{ ...inputSt, fontSize: TEXT.lg, fontWeight: FW.bold }} />
          </div>
          <div>
            <label style={labelSt}>Promise Date</label>
            <input type="date" value={ptpDate} min={new Date().toISOString().slice(0, 10)} onChange={e => setPtpDate(e.target.value)} style={inputSt} />
          </div>
        </div>
      </Modal>

      {d.assignment_id != null && (
        <LogPaymentModal
          open={openModal === 'payment'}
          onClose={() => setModal(null)}
          title={`Log Payment: ${d.applicant_cif}`}
          endpoint={`/api/collections-ops/${d.assignment_id}/payment`}
          onSuccess={() => { setModal(null); refreshAll() }}
        />
      )}

      <Modal open={openModal === 'watchlist_add'} onClose={() => setModal(null)} title={`Flag for Watchlist: ${d.applicant_cif}`} width={460}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={addWatchlist} disabled={saving} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: AMBER, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>flag</span>
              Add to Watchlist
            </button>
            <button onClick={() => setModal(null)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><label style={labelSt}>Scenario</label><ChipGroup options={SCENARIOS} value={wlScenario} onChange={setWlScenario} accent={AMBER} /></div>
          <div>
            <label style={labelSt}>Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea value={wlNotes} onChange={e => setWlNotes(e.target.value)} rows={3} placeholder="Why is this account being flagged?" style={{ ...inputSt, resize: 'vertical' }} />
          </div>
        </div>
      </Modal>

      <Modal open={openModal === 'watchlist_resolve'} onClose={() => setModal(null)} title={`Resolve Flag: ${d.applicant_cif}`} width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={resolveWatchlist} disabled={saving} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: rvStatus === 'resolved' ? GREEN : RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}
              Confirm
            </button>
            <button onClick={() => setModal(null)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelSt}>Action</label>
            <div style={{ display: 'flex', gap: 7 }}>
              {[{ value: 'resolved', label: 'Mark Resolved' }, { value: 'escalated_to_recovery', label: 'Escalate to Recovery' }].map(s => (
                <button key={s.value} onClick={() => setRvStatus(s.value)}
                  style={{ flex: 1, padding: '8px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: 'inherit', border: `1.5px solid ${rvStatus === s.value ? (s.value === 'resolved' ? GREEN : RED) : 'var(--bdr)'}`, background: rvStatus === s.value ? (s.value === 'resolved' ? GREEN : RED) : 'var(--card)', color: rvStatus === s.value ? '#fff' : 'var(--txt)' }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelSt}>Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea value={rvNotes} onChange={e => setRvNotes(e.target.value)} rows={3} placeholder="Resolution notes…" style={{ ...inputSt, resize: 'vertical' }} />
          </div>
        </div>
      </Modal>

      {isHead && (
        <Modal open={openModal === 'reassign'} onClose={() => setModal(null)} title="Reassign Account" width={420}
          footer={
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={reassign} disabled={saving || !newAgentId} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving || !newAgentId ? 'not-allowed' : 'pointer', opacity: saving || !newAgentId ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {saving && <Spinner size={13} color="#fff" />}
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>swap_horiz</span>
                Reassign
              </button>
              <button onClick={() => setModal(null)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            </div>
          }
        >
          <div>
            <label style={labelSt}>Assign to</label>
            <select value={newAgentId} onChange={e => setNewAgentId(e.target.value)} style={inputSt}>
              <option value="">Select agent</option>
              {collectionAgents.map(a => (
                <option key={a.id} value={String(a.id)}>
                  {a.full_name} ({a.role.replace(/_/g, ' ')})
                </option>
              ))}
            </select>
          </div>
        </Modal>
      )}

      {isHead && (
        <Modal open={openModal === 'send_to_recovery'} onClose={() => setModal(null)} title="Send to Recovery" width={440}
          footer={
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={sendToRecovery} disabled={saving} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {saving && <Spinner size={13} color="#fff" />}
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>gavel</span>
                Confirm
              </button>
              <button onClick={() => setModal(null)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            </div>
          }
        >
          <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0, lineHeight: 1.6 }}>
            This will escalate <strong>{d.applicant_cif}</strong> (outstanding:{' '}
            <strong>{fmtKoboExact(d.outstanding_kobo)}</strong>) to the Recovery team. The action is
            logged and will appear in the credit audit trail.
          </p>
        </Modal>
      )}
    </Page>
  )
}

// ── Masthead bits ─────────────────────────────────────────────────────────────

function IdLine({ icon, label, value, sub }: { icon: string; label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)', marginTop: 2 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--txt3)',
        }}>{label}</div>
        <div style={{
          fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{value}</div>
        {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{sub}</div>}
      </div>
    </div>
  )
}

function MiniStat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: color ?? 'var(--txt)', lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{
        fontSize: TEXT['2xs'], fontWeight: FW.semibold, letterSpacing: '0.05em',
        textTransform: 'uppercase', color: 'var(--txt3)', marginTop: 2,
      }}>{label}</div>
    </div>
  )
}
