// INTEGRATION: Add to App.tsx:
//   import TicketDetail from './pages/helpdesk/TicketDetail'
//   import ComposeTicket from './pages/helpdesk/ComposeTicket'
//   import CannedResponses from './pages/helpdesk/CannedResponses'
//   import HelpdeskStats from './pages/helpdesk/HelpdeskStats'
//   <Route path="/helpdesk/:id" element={<TicketDetail />} />
//   <Route path="/helpdesk/canned" element={<CannedResponses />} />
//   <Route path="/helpdesk/stats" element={<HelpdeskStats />} />

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, fmtKobo } from '../../lib/fmt'
import { sanitizeHtml } from '../../lib/sanitize'
import { Spinner, ErrBanner, ConfirmModal, NAVY, AMBER, RED, GREEN, BLUE } from '../../components/UI'
import { StatusPill, PriorityPill } from './components'
import { toast } from 'sonner'

// Wire Zoho: add <script src="https://voice.zoho.com/api/v1/sdk.js"></script> to index.html once VITE_ZOHO_ORG_ID is set

// ── Types ──────────────────────────────────────────────────────────────────────
interface Message {
  id: number
  ticket_id: number
  direction: 'inbound' | 'outbound'
  channel: string
  author_user_id?: number
  author_name?: string
  body_text?: string
  body_html?: string
  attachments: any[]
  is_internal_note: boolean
  created_at: string
}

interface TicketEvent {
  id: number
  user_id?: number
  event_type: string
  old_value?: string
  new_value?: string
  ts: string
}

interface CustomerContext {
  cif_number?: string
  full_name?: string
  email?: string
  phone?: string
  account_status?: string
  open_tickets?: number
  dpd?: number
  loan_balance_kobo?: number
}

interface CannedResponse {
  id: number
  name: string
  body_text: string
  subject?: string
  channel?: string
  category?: string
}

interface Ticket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority: string
  channel: string
  department: string
  zoho_department_name?: string
  description?: string
  customer_name: string
  customer_cif: string
  customer_email?: string
  customer_phone?: string
  assigned_to_name?: string | null
  assigned_to_id?: number | null
  tags?: string[]
  sla_due_at?: string | null
  csat_score?: number | null
  zoho_ticket_id?: string
  zoho_thread_count?: number
  created_at: string
}

interface TicketDetailData {
  ticket: Ticket
  messages: Message[]
  events: TicketEvent[]
  customer_context: CustomerContext | null
}

interface Agent {
  id: number
  name: string
}

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String).map(s => s.trim()).filter(Boolean)
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        return normalizeTags(JSON.parse(trimmed))
      } catch {
        // Fall through to CSV parsing.
      }
    }
    return trimmed.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

// ── Constants ──────────────────────────────────────────────────────────────────
const STATUS_OPTIONS = [
  { value: 'open',        label: 'Open' },
  { value: 'pending',     label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved',    label: 'Resolved' },
  { value: 'closed',      label: 'Closed' },
]

const PRIORITY_OPTIONS = [
  { value: 'low',    label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high',   label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

const DEPT_OPTIONS = [
  { value: 'cards_ops',   label: 'Cards Ops' },
  { value: 'loans',       label: 'Loans' },
  { value: 'collections', label: 'Collections' },
  { value: 'recovery',    label: 'Recovery' },
  { value: 'general',     label: 'General' },
  { value: 'compliance',  label: 'Compliance' },
]

const CHANNEL_ICON: Record<string, string> = {
  email:    'email',
  sms:      'sms',
  whatsapp: 'chat',
  phone:    'call',
  'in-app': 'smartphone',
  in_app:   'smartphone',
}

// ── Sub-components ──────────────────────────────────────────────────────────────
function SLACountdown({ dueAt }: { dueAt: string | null | undefined }) {
  const [label, setLabel] = useState('')
  useEffect(() => {
    if (!dueAt) { setLabel(''); return }
    const calc = () => {
      const diff = new Date(dueAt).getTime() - Date.now()
      if (diff < 0) { setLabel('BREACHED'); return }
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      setLabel(`${h}h ${m}m left`)
    }
    calc()
    const t = setInterval(calc, 60000)
    return () => clearInterval(t)
  }, [dueAt])
  if (!label) return null
  const breached = label === 'BREACHED'
  return (
    <span className={`text-[12px] font-semibold ${breached ? 'text-red-600' : 'text-amber-600'}`}>
      {breached ? '⚠ SLA BREACHED' : `⏱ ${label}`}
    </span>
  )
}


// ── Main component ─────────────────────────────────────────────────────────────
export default function TicketDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [data, setData]           = useState<TicketDetailData | null>(null)
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState('')

  const [canned, setCanned]       = useState<CannedResponse[]>([])
  const [agents, setAgents]       = useState<Agent[]>([])

  const [fetchingThreads, setFetchingThreads] = useState(false)

  // Reply box
  const [replyMode, setReplyMode] = useState<'reply' | 'note'>('reply')
  const [body, setBody]           = useState('')
  const [sending, setSending]     = useState(false)
  const [sendErr, setSendErr]     = useState('')

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    if (type === 'error') toast.error(msg)
    else toast.success(msg)
  }

  // Confirm before closing/resolving
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null)

  // Tags local state
  const [tagInput, setTagInput]   = useState('')
  const [showTagInput, setShowTagInput] = useState(false)
  const tagRef = useRef<HTMLInputElement>(null)

  // Patch in-flight guard
  const patchingRef = useRef(false)

  // Right panel
  const [rightTab, setRightTab]         = useState<'context' | 'actions'>('context')
  const [c360, setC360]                 = useState<any | null>(null)
  const [c360Loading, setC360Loading]   = useState(false)
  const [assignId, setAssignId]         = useState<number | null>(null)
  const [ptpOpen, setPtpOpen]           = useState(false)
  const [ptpAmount, setPtpAmount]       = useState('')
  const [ptpDate, setPtpDate]           = useState('')
  const [ptpSaving, setPtpSaving]       = useState(false)
  const [stmtOpen, setStmtOpen]         = useState(false)
  const [stmtFrom, setStmtFrom]         = useState('')
  const [stmtTo, setStmtTo]             = useState('')
  const [stmtSaving, setStmtSaving]     = useState(false)
  const [escalating, setEscalating]     = useState(false)

  // Load ticket
  const load = useCallback(() => {
    if (!id) return
    setLoading(true); setErr('')
    apiFetch<TicketDetailData>(`/api/helpdesk/tickets/${id}`)
      .then(setData)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { load() }, [load])

  // Load canned responses & agents
  useEffect(() => {
    apiFetch<CannedResponse[]>('/api/helpdesk/canned-responses').then(setCanned).catch(() => {})
    apiFetch<any[]>('/api/admin/users')
      .catch(() => apiFetch<any[]>('/api/users'))
      .then(rows => setAgents((rows ?? []).map(u => ({ id: u.id, name: u.name ?? u.full_name ?? u.email ?? `User ${u.id}` }))))
      .catch(() => {})
  }, [])

  // Fetch Customer 360 profile once the ticket CIF is known
  useEffect(() => {
    const cif = data?.ticket?.customer_cif
    if (!cif) return
    setC360Loading(true)
    apiFetch<any>(`/api/customer360/${cif}`)
      .then(setC360)
      .catch(() => {})
      .finally(() => setC360Loading(false))
  }, [data?.ticket?.customer_cif])

  // Fetch the collection assignment ID the first time the Actions tab is opened
  useEffect(() => {
    if (rightTab !== 'actions') return
    const cif = data?.ticket?.customer_cif
    if (!cif) return
    apiFetch<any[]>(`/api/collections-ops/queue?account_cif=${encodeURIComponent(cif)}&limit=1`)
      .then(rows => { if (rows?.length) setAssignId(Number(rows[0].id)) })
      .catch(() => {})
  }, [rightTab, data?.ticket?.customer_cif])

  // Patch ticket field immediately on change
  async function patchTicket(field: string, value: string) {
    if (!id || patchingRef.current) return
    patchingRef.current = true
    try {
      await apiFetch(`/api/helpdesk/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: value }),
      })
      // Optimistically update local data
      setData(prev => {
        if (!prev) return prev
        return { ...prev, ticket: { ...prev.ticket, [field]: value } }
      })
    } catch (e: any) {
      showToast(e.message || 'Update failed', 'error')
    } finally {
      patchingRef.current = false
    }
  }

  // Send reply / internal note
  async function sendMessage(sendMethod: 'email' | 'sms' | 'default') {
    if (!id || !body.trim()) return
    setSending(true); setSendErr('')
    try {
      await apiFetch(`/api/helpdesk/tickets/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body_text: body.trim(),
          is_internal_note: replyMode === 'note',
          channel: sendMethod === 'default' ? data?.ticket.channel : sendMethod,
        }),
      })
      setBody('')
      showToast('Message sent')
      // Reload messages
      load()
    } catch (e: any) {
      setSendErr(e.message || 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  // Add tag
  async function addTag() {
    if (!id || !tagInput.trim()) return
    const current = normalizeTags(data?.ticket.tags)
    if (current.includes(tagInput.trim())) { setTagInput(''); setShowTagInput(false); return }
    const next = [...current, tagInput.trim()]
    setTagInput(''); setShowTagInput(false)
    await patchTicket('tags', next.join(','))
    load()
  }

  // Remove tag
  async function removeTag(tag: string) {
    if (!id) return
    const next = normalizeTags(data?.ticket.tags).filter(t => t !== tag)
    await patchTicket('tags', next.join(','))
    load()
  }

  async function logPromiseToPay() {
    if (!ptpAmount || !ptpDate || !assignId) return
    setPtpSaving(true)
    try {
      await apiFetch(`/api/collections-ops/${assignId}/promise`, {
        method: 'POST',
        body: JSON.stringify({
          promised_amount_kobo: Math.round(parseFloat(ptpAmount) * 100),
          promised_date: ptpDate,
        }),
      })
      setPtpOpen(false); setPtpAmount(''); setPtpDate('')
      showToast('Promise to pay logged')
    } catch (e: any) {
      showToast(e.message || 'Failed to log promise', 'error')
    } finally {
      setPtpSaving(false)
    }
  }

  async function requestStatement() {
    if (!stmtFrom || !stmtTo || !ticket) return
    if (!ticket.customer_email) { showToast('No email address on this ticket', 'error'); return }
    setStmtSaving(true)
    try {
      await apiFetch('/api/statements/send', {
        method: 'POST',
        body: JSON.stringify({
          cif:             ticket.customer_cif,
          date_from:       stmtFrom,
          date_to:         stmtTo,
          recipient_email: ticket.customer_email,
          subject:         'Your Account Statement',
          message:         'Please find your account statement attached.',
        }),
      })
      setStmtOpen(false); setStmtFrom(''); setStmtTo('')
      showToast('Statement sent to customer')
    } catch (e: any) {
      showToast(e.message || 'Failed to send statement', 'error')
    } finally {
      setStmtSaving(false)
    }
  }

  async function escalateToSupervisor() {
    if (!id || escalating) return
    setEscalating(true)
    try {
      await apiFetch(`/api/helpdesk/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ priority: 'urgent' }),
      })
      await apiFetch(`/api/helpdesk/tickets/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body_text:        '⚠ Escalated to Supervisor — priority set to Urgent.',
          is_internal_note: true,
          channel:          ticket?.channel ?? 'email',
        }),
      })
      load()
      showToast('Ticket escalated to supervisor')
    } catch (e: any) {
      showToast(e.message || 'Escalation failed', 'error')
    } finally {
      setEscalating(false)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-[60vh]">
      <Spinner size={32} />
    </div>
  )

  if (err || !data) return (
    <div className="px-8 py-7"><ErrBanner msg={err || 'Ticket not found'} /></div>
  )

  const { ticket, messages, events, customer_context: ctx } = data
  const tags = normalizeTags(ticket.tags)

  return (
    <div className="flex flex-col h-full" style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3"
        style={{ background: 'var(--card)', borderBottom: '1px solid var(--bdr)' }}>
        <button
          onClick={() => navigate('/helpdesk')}
          className="flex items-center gap-1 text-[12px] font-medium transition-colors flex-shrink-0"
          style={{ color: 'var(--txt2)' }}
        >
          <span className="material-symbols-rounded text-[16px]">arrow_back</span>
        </button>
        <span className="font-mono text-[12px] px-2 py-0.5 rounded-md font-semibold flex-shrink-0"
          style={{ background: 'var(--chip-bg)', color: NAVY }}>
          {ticket.ticket_ref}
        </span>
        <span className="font-semibold text-[14px] truncate min-w-0" style={{ color: 'var(--txt)' }}>
          {ticket.subject}
        </span>
        <div className="flex items-center gap-2 ml-auto flex-shrink-0">
          <span className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded text-[14px]">
              {CHANNEL_ICON[ticket.channel?.toLowerCase()] ?? 'chat'}
            </span>
            {ticket.channel}
          </span>
          <PriorityPill priority={ticket.priority} />
          <StatusPill status={ticket.status} />
          {ticket.sla_due_at && (
            <div className="px-2 py-0.5 rounded-lg flex-shrink-0"
              style={{ background: 'rgba(217,119,6,0.08)' }}>
              <SLACountdown dueAt={ticket.sla_due_at} />
            </div>
          )}
        </div>
      </div>

      {/* Body: three columns */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT SIDEBAR */}
        <aside className="w-64 border-r flex-shrink-0 overflow-y-auto"
          style={{ background: 'var(--card)', borderColor: 'var(--bdr)' }}>
          <div className="p-4 space-y-4">
            {/* Status */}
            <SideField label="Status">
              <select
                value={ticket.status.toLowerCase().replace(/\s+/g, '_')}
                onChange={e => {
                  const v = e.target.value
                  if (v === 'closed' || v === 'resolved') {
                    setConfirmStatus(v)
                  } else {
                    patchTicket('status', v)
                  }
                }}
                className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium outline-none appearance-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
              >
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </SideField>

            {/* Priority */}
            <SideField label="Priority">
              <select
                value={ticket.priority.toLowerCase()}
                onChange={e => patchTicket('priority', e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium outline-none appearance-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
              >
                {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </SideField>

            {/* Channel (display only) */}
            <SideField label="Channel">
              <span className="flex items-center gap-1 text-[12px] text-[color:var(--txt2)]">
                <span className="material-symbols-rounded text-[14px]">
                  {CHANNEL_ICON[ticket.channel?.toLowerCase()] ?? 'chat'}
                </span>
                {ticket.channel}
              </span>
            </SideField>

            {/* Department */}
            <SideField label="Department">
              {ticket.zoho_department_name && !DEPT_OPTIONS.find(o => o.value === ticket.department?.toLowerCase().replace(/\s+/g, '_')) ? (
                <p className="text-[12px] font-medium px-2 py-1.5 rounded-lg border"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}>
                  {ticket.zoho_department_name}
                </p>
              ) : (
                <select
                  value={ticket.department?.toLowerCase().replace(/\s+/g, '_') ?? 'general'}
                  onChange={e => patchTicket('department', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium bg-[var(--card)] outline-none appearance-none"
                  style={{ borderColor: 'var(--bdr)', color: 'var(--txt)' }}
                >
                  {DEPT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
            </SideField>

            {/* Tags */}
            <SideField label="Tags">
              <div className="flex flex-wrap gap-1">
                {tags.map(tag => (
                  <span key={tag}
                    className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{ background: 'var(--chip-bg)', color: NAVY }}>
                    {tag}
                    <button onClick={() => removeTag(tag)}
                      className="ml-0.5 hover:text-red-600 transition-colors">
                      <span className="material-symbols-rounded text-[11px]">close</span>
                    </button>
                  </span>
                ))}
                {showTagInput ? (
                  <input
                    ref={tagRef}
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addTag(); if (e.key === 'Escape') setShowTagInput(false) }}
                    onBlur={addTag}
                    placeholder="tag name…"
                    autoFocus
                    className="text-[11px] px-1.5 py-0.5 rounded border outline-none w-20"
                    style={{ borderColor: 'rgba(14,40,65,0.2)' }}
                  />
                ) : (
                  <button
                    onClick={() => setShowTagInput(true)}
                    className="text-[11px] px-1.5 py-0.5 rounded-full font-medium text-[color:var(--txt2)] hover:text-[color:var(--txt2)] transition-colors"
                    style={{ border: '1px dashed rgba(15,23,42,0.2)' }}>
                    + add
                  </button>
                )}
              </div>
            </SideField>

            {/* Assigned To */}
            <SideField label="Assigned To">
              {agents.length > 0 ? (
                <select
                  value={ticket.assigned_to_id ?? (ticket as any).assigned_to ?? ''}
                  onChange={e => patchTicket('assigned_to', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium bg-[var(--card)] outline-none appearance-none"
                  style={{ borderColor: 'var(--bdr)', color: 'var(--txt)' }}
                >
                  <option value="">Unassigned</option>
                  {agents.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                </select>
              ) : (
                <input
                  defaultValue={ticket.assigned_to_name ?? ''}
                  onBlur={e => patchTicket('assigned_to_name', e.target.value)}
                  placeholder="Enter name…"
                  className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium outline-none"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
                />
              )}
            </SideField>

            {/* SLA */}
            <SideField label="SLA">
              <SLACountdown dueAt={ticket.sla_due_at} />
              {!ticket.sla_due_at && <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>No SLA set</span>}
            </SideField>

            {/* CSAT — shown when Zoho has a rating */}
            {ticket.csat_score != null && (
              <SideField label="CSAT Rating">
                <div className="flex items-center gap-1">
                  {[1,2,3,4,5].map(n => (
                    <span key={n} className="text-[16px]"
                      style={{ color: n <= (ticket.csat_score ?? 0) ? '#F59E0B' : 'var(--txt3)' }}>
                      ★
                    </span>
                  ))}
                  <span className="text-[12px] ml-1" style={{ color: 'var(--txt2)' }}>{ticket.csat_score}/5</span>
                </div>
              </SideField>
            )}

            <div className="pt-1" style={{ borderTop: '1px solid var(--bdr)' }}>
              <p className="text-[11px] mb-0.5" style={{ color: 'var(--txt2)' }}>Created</p>
              <p className="text-[12px]" style={{ color: 'var(--txt)' }}>{fmtDate(ticket.created_at)}</p>
            </div>
          </div>
        </aside>

        {/* MIDDLE: Messages + Reply */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5" style={{ background: 'var(--bg)' }}>

            {/* Description bubble — shown when ticket has a description but no thread messages yet */}
            {ticket.description && messages.length === 0 && (
              <div className="flex items-end gap-2.5">
                <MsgAvatar name={ticket.customer_name || 'Customer'} color="var(--txt2)" />
                <div className="max-w-[78%]">
                  <p className="text-[11px] font-semibold mb-1 ml-1" style={{ color: 'var(--txt2)' }}>
                    {ticket.customer_name || 'Customer'} · {fmtDate(ticket.created_at)} · Original message
                  </p>
                  <div className="rounded-2xl rounded-bl-md px-4 py-3 shadow-sm border"
                    style={{ background: 'var(--card)', borderColor: 'var(--bdr)' }}>
                    <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--txt)' }}>{ticket.description}</p>
                  </div>
                </div>
              </div>
            )}

            {messages.length === 0 && events.length === 0 && !ticket.description && (
              <div className="flex flex-col items-center justify-center py-12" style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[40px] mb-2" style={{ color: 'var(--txt3)' }}>chat</span>
                <p className="text-[13px]">No messages yet</p>
                <p className="text-[12px] mt-1">Send the first reply below</p>
              </div>
            )}

            {messages.map(msg => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            {events.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 py-2">
                  <div className="flex-1 h-px" style={{ background: 'rgba(15,23,42,0.08)' }} />
                  <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--txt2)' }}>Activity</span>
                  <div className="flex-1 h-px" style={{ background: 'rgba(15,23,42,0.08)' }} />
                </div>
                {events.map(ev => (
                  <div key={ev.id} className="flex items-center gap-2 py-1">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--bdr)' }} />
                    <span className="text-[11px] flex-1" style={{ color: 'var(--txt2)' }}>
                      {ev.event_type === 'created'
                        ? 'Ticket created'
                        : `${ev.event_type.replace(/_/g, ' ')}: ${ev.old_value ?? '—'} → ${ev.new_value ?? '—'}`}
                    </span>
                    <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--txt2)' }}>
                      {new Date(ev.ts).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reply box */}
          <div className="border-t flex-shrink-0"
            style={{ background: 'var(--card)', borderColor: 'var(--bdr)' }}>
            {/* Tab row */}
            <div className="flex items-center gap-1 px-5 pt-3 pb-0">
              <TabBtn active={replyMode === 'reply'} onClick={() => setReplyMode('reply')} label="Reply" />
              <TabBtn active={replyMode === 'note'}  onClick={() => setReplyMode('note')}  label="Internal Note" />

              {/* Canned responses */}
              {canned.length > 0 && (
                <div className="ml-auto">
                  <CannedPicker
                    responses={canned}
                    channel={ticket.channel}
                    onSelect={text => setBody(prev => prev ? prev + '\n\n' + text : text)}
                  />
                </div>
              )}
            </div>

            {/* Textarea */}
            <div className="px-5 pt-3 pb-2">
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                onKeyDown={e => {
                  if (e.ctrlKey && e.key === 'Enter' && body.trim() && !sending) {
                    e.preventDefault()
                    sendMessage(replyMode === 'note' ? 'default' : 'email')
                  }
                }}
                placeholder={replyMode === 'note' ? 'Add an internal note — not visible to customer…' : 'Type your reply to the customer…'}
                rows={4}
                className="w-full px-3 py-2.5 rounded-xl border text-[13px] resize-none outline-none transition-colors"
                style={{
                  borderColor: replyMode === 'note' ? '#FDE68A' : 'rgba(15,23,42,0.15)',
                  background: replyMode === 'note' ? '#FFFBEB' : 'white',
                  color: 'var(--txt)',
                }}
              />
              <div className="flex items-center justify-between mt-1">
                {sendErr
                  ? <p className="text-[12px] text-red-600">{sendErr}</p>
                  : <span />}
                <span className="text-[11px] text-[color:var(--txt2)]">{body.length} chars</span>
              </div>
            </div>

            {/* Send buttons */}
            <div className="flex items-center gap-2 px-5 pb-4">
              {replyMode === 'reply' ? (
                <>
                  <SendBtn
                    label="Send Email"
                    icon="email"
                    onClick={() => sendMessage('email')}
                    disabled={sending || !body.trim()}
                    primary
                  />
                  <SendBtn
                    label="Send SMS"
                    icon="sms"
                    onClick={() => sendMessage('sms')}
                    disabled={sending || !body.trim()}
                  />
                </>
              ) : (
                <SendBtn
                  label="Add Note"
                  icon="lock"
                  onClick={() => sendMessage('default')}
                  disabled={sending || !body.trim()}
                  primary
                  amber
                />
              )}
              {sending && <Spinner size={16} />}
            </div>
          </div>
        </main>

        {/* RIGHT: Customer 360 + Actions */}
        <aside className="w-64 bg-[var(--card)] border-l flex-shrink-0 flex flex-col overflow-hidden"
          style={{ borderColor: 'rgba(15,23,42,0.09)' }}>

          {/* Customer header — always visible */}
          <div className="px-4 pt-4 pb-3 flex-shrink-0" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
            <p className="font-semibold text-[color:var(--txt)] text-[14px] leading-snug">
              {ticket.customer_name}
            </p>
            {ticket.customer_cif && (
              <span className="text-[11px] font-mono bg-[var(--chip-bg)] text-[color:var(--txt2)] px-1.5 py-0.5 rounded mt-1 inline-block">
                CIF: {ticket.customer_cif}
              </span>
            )}
            {ticket.customer_email && (
              <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--txt2)] mt-1.5">
                <span className="material-symbols-rounded text-[13px]">email</span>
                <span className="truncate">{ticket.customer_email}</span>
              </div>
            )}
            {ticket.customer_phone && (
              <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--txt2)] mt-1">
                <span className="material-symbols-rounded text-[13px]">phone</span>
                <span>{ticket.customer_phone}</span>
              </div>
            )}
          </div>

          {/* Tab switcher */}
          <div className="flex flex-shrink-0" style={{ borderBottom: '1px solid rgba(15,23,42,0.09)' }}>
            {(['context', 'actions'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setRightTab(tab)}
                className="flex-1 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors"
                style={{
                  color: rightTab === tab ? NAVY : 'var(--txt2)',
                  borderBottom: rightTab === tab ? `2px solid ${NAVY}` : '2px solid transparent',
                  background: 'transparent',
                }}
              >
                {tab === 'context' ? '360' : 'Actions'}
              </button>
            ))}
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto">

            {/* ── 360 context tab ────────────────────────────────────────── */}
            {rightTab === 'context' && (
              <div className="p-4 space-y-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--txt2)] mb-2">Phone</p>
                  <ZohoDialer ticket={ticket} />
                </div>

                <div style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }} className="pt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--txt2)] mb-2">
                    Financial Summary
                  </p>
                  {c360Loading ? (
                    <div className="space-y-1.5">
                      {[...Array(4)].map((_, i) => (
                        <div key={i} className="skeleton h-4 rounded w-full" />
                      ))}
                    </div>
                  ) : c360?.financial_summary ? (
                    <div className="space-y-2">
                      <Ctx360Item label="DPD Bucket"    value={String(c360.financial_summary.dpd_bucket ?? ctx?.dpd ?? '—')} />
                      <Ctx360Item label="Recovery Bal." value={fmtKobo(c360.financial_summary.recovery_outstanding_kobo ?? ctx?.loan_balance_kobo)} />
                      <Ctx360Item label="Loan Approved" value={fmtKobo(c360.financial_summary.loan_approved_kobo)} />
                      <Ctx360Item label="Open Tickets"  value={String(ctx?.open_tickets ?? '—')} />
                    </div>
                  ) : ctx ? (
                    <div className="space-y-2">
                      <Ctx360Item label="Account Status" value={ctx.account_status ?? '—'} />
                      <Ctx360Item label="Loan Balance"   value={fmtKobo(ctx.loan_balance_kobo)} />
                      <Ctx360Item label="DPD"            value={String(ctx.dpd ?? 0)} />
                      <Ctx360Item label="Open Tickets"   value={String(ctx.open_tickets ?? 0)} />
                    </div>
                  ) : (
                    <p className="text-[12px] text-[color:var(--txt2)]">No financial data</p>
                  )}
                </div>

                {/* Products */}
                {(c360?.products as any[])?.length > 0 && (
                  <div style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }} className="pt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--txt2)] mb-2">Products</p>
                    <div className="space-y-1.5">
                      {(c360.products as any[]).slice(0, 3).map((p: any, i: number) => (
                        <div key={i} className="flex items-center justify-between gap-1">
                          <span className="text-[12px] text-[color:var(--txt2)] truncate">
                            {p['Product Name'] ?? p.Product_Name ?? '—'}
                          </span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                            (p['Account Status'] ?? p.Account_Status ?? '').toLowerCase().includes('active')
                              ? 'bg-green-50 text-green-700' : 'bg-[var(--chip-bg)] text-[color:var(--txt2)]'
                          }`}>
                            {(p['Account Status'] ?? p.Account_Status ?? '—').slice(0, 8)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent Loan Apps */}
                {(c360?.loan_apps as any[])?.length > 0 && (
                  <div style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }} className="pt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--txt2)] mb-2">Loans</p>
                    <div className="space-y-2">
                      {(c360.loan_apps as any[]).slice(0, 2).map((la: any) => (
                        <div key={la.id} className="rounded-lg p-2" style={{ background: 'rgba(14,40,65,0.04)' }}>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-mono text-[color:var(--txt2)] truncate">{la.reference ?? '—'}</span>
                            <span className="text-[10px] font-semibold text-[color:var(--txt2)] ml-1">{la.stage ?? la.status ?? '—'}</span>
                          </div>
                          <p className="text-[12px] font-semibold text-[color:var(--txt)] mt-0.5">
                            {fmtKobo(la.amount_approved_kobo ?? la.amount_requested_kobo)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent Transactions */}
                {(c360?.transactions as any[])?.length > 0 && (
                  <div style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }} className="pt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--txt2)] mb-2">
                      Recent Transactions
                    </p>
                    <div className="space-y-2">
                      {(c360.transactions as any[]).slice(0, 3).map((tx: any, i: number) => (
                        <div key={i} className="flex items-start justify-between gap-1">
                          <div className="min-w-0">
                            <p className="text-[11px] text-[color:var(--txt2)] truncate">
                              {tx.Description ?? tx['Description'] ?? '—'}
                            </p>
                            <p className="text-[10px] text-[color:var(--txt2)]">
                              {tx['Transaction Date'] ?? tx.Transaction_Date ?? ''}
                            </p>
                          </div>
                          <span className="text-[11px] font-semibold text-[color:var(--txt)] whitespace-nowrap">
                            {tx.Amount ?? tx['Amount'] ?? '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {ticket.customer_cif && (
                  <button
                    onClick={() => navigate(`/customers/${ticket.customer_cif}`)}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold border transition-all"
                    style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}
                  >
                    <span className="material-symbols-rounded text-[15px]">open_in_new</span>
                    View Full Profile
                  </button>
                )}
              </div>
            )}

            {/* ── Actions tab ───────────────────────────────────────────── */}
            {rightTab === 'actions' && (
              <div className="p-4 space-y-2">

                {/* Log Promise to Pay */}
                <ActionSection>
                  <ActionBtn
                    icon="handshake"
                    label="Log Promise to Pay"
                    color="#16A34A"
                    onClick={() => setPtpOpen(o => !o)}
                  />
                  {ptpOpen && (
                    <div className="mt-2 space-y-1.5 pt-2" style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }}>
                      {assignId === null && (
                        <p className="text-[11px] text-amber-600">No active collection case found for this CIF.</p>
                      )}
                      <label className="block">
                        <span className="text-[11px] text-[color:var(--txt2)]">Amount (₦)</span>
                        <input
                          type="number" min="0"
                          value={ptpAmount}
                          onChange={e => setPtpAmount(e.target.value)}
                          placeholder="0.00"
                          className="w-full mt-0.5 px-2 py-1.5 rounded-lg border text-[12px] outline-none"
                          style={{ borderColor: 'var(--bdr)' }}
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-[color:var(--txt2)]">Promise Date</span>
                        <input
                          type="date"
                          value={ptpDate}
                          onChange={e => setPtpDate(e.target.value)}
                          className="w-full mt-0.5 px-2 py-1.5 rounded-lg border text-[12px] outline-none"
                          style={{ borderColor: 'var(--bdr)' }}
                        />
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={logPromiseToPay}
                          disabled={ptpSaving || !ptpAmount || !ptpDate || !assignId}
                          className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold text-white disabled:opacity-50"
                          style={{ background: '#16A34A' }}
                        >
                          {ptpSaving ? 'Saving…' : 'Log PTP'}
                        </button>
                        <button
                          onClick={() => { setPtpOpen(false); setPtpAmount(''); setPtpDate('') }}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[color:var(--txt2)] hover:bg-[var(--chip-bg)]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </ActionSection>

                {/* Escalate to Collections */}
                <ActionSection>
                  <ActionBtn
                    icon="assignment_ind"
                    label="Escalate to Collections"
                    color={AMBER}
                    onClick={async () => {
                      await patchTicket('department', 'collections')
                      await apiFetch(`/api/helpdesk/tickets/${id}/messages`, {
                        method: 'POST',
                        body: JSON.stringify({
                          body_text:        '⚠ Ticket escalated to Collections department.',
                          is_internal_note: true,
                          channel:          ticket.channel,
                        }),
                      })
                      load()
                      showToast('Escalated to Collections')
                    }}
                  />
                </ActionSection>

                {/* Create Application */}
                <ActionSection>
                  <ActionBtn
                    icon="add_circle"
                    label="Create Application"
                    color={NAVY}
                    onClick={() => navigate(`/los/new${ticket.customer_cif ? `?cif=${ticket.customer_cif}` : ''}`)}
                  />
                </ActionSection>

                {/* Request Statement */}
                <ActionSection>
                  <ActionBtn
                    icon="description"
                    label="Request Statement"
                    color={BLUE}
                    onClick={() => setStmtOpen(o => !o)}
                  />
                  {stmtOpen && (
                    <div className="mt-2 space-y-1.5 pt-2" style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }}>
                      {!ticket.customer_email && (
                        <p className="text-[11px] text-amber-600">No email address on this ticket.</p>
                      )}
                      <label className="block">
                        <span className="text-[11px] text-[color:var(--txt2)]">From</span>
                        <input
                          type="date"
                          value={stmtFrom}
                          onChange={e => setStmtFrom(e.target.value)}
                          className="w-full mt-0.5 px-2 py-1.5 rounded-lg border text-[12px] outline-none"
                          style={{ borderColor: 'var(--bdr)' }}
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-[color:var(--txt2)]">To</span>
                        <input
                          type="date"
                          value={stmtTo}
                          onChange={e => setStmtTo(e.target.value)}
                          className="w-full mt-0.5 px-2 py-1.5 rounded-lg border text-[12px] outline-none"
                          style={{ borderColor: 'var(--bdr)' }}
                        />
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={requestStatement}
                          disabled={stmtSaving || !stmtFrom || !stmtTo || !ticket.customer_email}
                          className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold text-white disabled:opacity-50"
                          style={{ background: BLUE }}
                        >
                          {stmtSaving ? 'Sending…' : 'Send'}
                        </button>
                        <button
                          onClick={() => { setStmtOpen(false); setStmtFrom(''); setStmtTo('') }}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[color:var(--txt2)] hover:bg-[var(--chip-bg)]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </ActionSection>

                {/* Escalate to Supervisor */}
                <ActionSection>
                  <ActionBtn
                    icon="supervisor_account"
                    label={escalating ? 'Escalating…' : 'Escalate to Supervisor'}
                    color={RED}
                    disabled={escalating}
                    onClick={escalateToSupervisor}
                  />
                </ActionSection>

                <p className="text-[11px] text-[color:var(--txt2)] text-center pt-1">
                  All actions are logged internally.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {confirmStatus && (
        <ConfirmModal
          title={confirmStatus === 'closed' ? 'Close Ticket?' : 'Resolve Ticket?'}
          message={`Mark this ticket as ${confirmStatus}? This action will be logged.`}
          confirmLabel={confirmStatus === 'closed' ? 'Close' : 'Resolve'}
          danger={confirmStatus === 'closed'}
          onConfirm={() => { patchTicket('status', confirmStatus); setConfirmStatus(null) }}
          onCancel={() => setConfirmStatus(null)}
        />
      )}
    </div>
  )
}

// ── Zoho Voice dialer shell ────────────────────────────────────────────────────
function ZohoDialer({ ticket }: { ticket: Ticket }) {
  const phoneNumber = ticket.customer_phone
  const telHref = phoneNumber ? `tel:${phoneNumber.replace(/[^\d+]/g, '')}` : undefined
  const [logOpen,    setLogOpen]    = useState(false)
  const [logNote,    setLogNote]    = useState('')
  const [logDur,     setLogDur]     = useState('')
  const [logSaving,  setLogSaving]  = useState(false)
  const [calling,    setCalling]    = useState(false)
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'done' | 'error'>('idle')

  // Use Zoho Voice WebSDK if loaded; otherwise fall back to backend REST proxy
  const hasSDK = typeof (window as any).ZohoVoice !== 'undefined'

  async function initiateCall() {
    if (!phoneNumber) return
    if (hasSDK) {
      ;(window as any).ZohoVoice.makeCall({ phoneNumber })
      setCallStatus('calling')
      return
    }
    setCalling(true); setCallStatus('calling')
    try {
      await apiPost('/api/zoho/voice/call', { phone_number: phoneNumber, ticket_id: ticket.id })
      setCallStatus('done')
    } catch { setCallStatus('error') }
    finally { setCalling(false) }
  }

  async function submitLog(e: React.FormEvent) {
    e.preventDefault()
    if (!logNote.trim()) return
    setLogSaving(true)
    try {
      await apiPost('/api/helpdesk/calls', {
        customer_phone: phoneNumber ?? '',
        duration_sec:   logDur ? Number(logDur) : null,
        notes:          logNote,
        direction:      'outbound',
        outcome:        'resolved',
        customer_name:  ticket.customer_name ?? '',
        customer_cif:   ticket.customer_cif ?? '',
        customer_email: ticket.customer_email ?? '',
        ticket_ref:     ticket.ticket_ref ?? '',
      })
      setLogOpen(false); setLogNote(''); setLogDur(''); setCallStatus('idle')
    } catch { /* ignore */ }
    finally { setLogSaving(false) }
  }

  return (
    <div className="space-y-2">
      {telHref && (
        <a
          href={telHref}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: GREEN }}>
          <span className="material-symbols-rounded text-[16px]">phone_in_talk</span>
          Call Phone
        </a>
      )}
      <button
        onClick={initiateCall}
        disabled={!phoneNumber || calling}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-semibold border disabled:opacity-50"
        style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}>
        <span className="material-symbols-rounded text-[16px]">
          {calling ? 'progress_activity' : 'call'}
        </span>
        {calling ? 'Calling…' : hasSDK ? 'Call via Browser' : 'Initiate Call'}
      </button>

      {callStatus === 'done' && (
        <p className="text-[11px] text-center font-medium" style={{ color: GREEN }}>
          Call initiated — log it below when done
        </p>
      )}
      {callStatus === 'error' && (
        <p className="text-[11px] text-center text-red-500">
          Call failed — check Admin → Integrations
        </p>
      )}

      <button
        onClick={() => setLogOpen(o => !o)}
        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-semibold border transition-all"
        style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}>
        <span className="material-symbols-rounded text-[14px]">edit_note</span>
        Log Call
      </button>

      {logOpen && (
        <form onSubmit={submitLog} className="space-y-2 pt-1">
          <input
            type="number"
            min="0"
            value={logDur}
            onChange={e => setLogDur(e.target.value)}
            placeholder="Duration (secs)"
            className="w-full px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
            style={{ borderColor: 'var(--bdr)' }}
          />
          <textarea
            rows={2}
            value={logNote}
            onChange={e => setLogNote(e.target.value)}
            placeholder="Call notes…"
            className="w-full px-2.5 py-1.5 rounded-lg border text-[12px] outline-none resize-none"
            style={{ borderColor: 'var(--bdr)' }}
          />
          <div className="flex gap-2">
            <button type="submit" disabled={logSaving || !logNote.trim()}
              className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold text-white disabled:opacity-50"
              style={{ background: NAVY }}>
              {logSaving ? 'Saving…' : 'Save Log'}
            </button>
            <button type="button" onClick={() => setLogOpen(false)}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[color:var(--txt2)] hover:bg-[var(--chip-bg)]">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
function SideField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--txt2)] mb-1.5">{label}</p>
      {children}
    </div>
  )
}

function Ctx360Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-[color:var(--txt2)]">{label}</span>
      <span className="text-[12px] font-semibold text-[color:var(--txt)]">{value}</span>
    </div>
  )
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-t-lg text-[12px] font-semibold transition-colors"
      style={{
        background: active ? 'rgba(14,40,65,0.07)' : 'transparent',
        color: active ? NAVY : 'var(--txt2)',
        borderBottom: active ? `2px solid ${NAVY}` : '2px solid transparent',
      }}
    >
      {label}
    </button>
  )
}

function SendBtn({
  label, icon, onClick, disabled, primary = false, amber = false,
}: {
  label: string; icon: string; onClick: () => void; disabled: boolean; primary?: boolean; amber?: boolean
}) {
  const bg = amber ? AMBER : (primary ? NAVY : 'white')
  const color = (primary || amber) ? 'white' : 'var(--txt2)'
  const border = (primary || amber) ? 'transparent' : 'rgba(15,23,42,0.15)'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-semibold transition-all disabled:opacity-50"
      style={{ background: bg, color, border: `1px solid ${border}` }}
    >
      <span className="material-symbols-rounded text-[15px]">{icon}</span>
      {label}
    </button>
  )
}

function MsgAvatar({ name, color }: { name: string; color: string }) {
  const initials = (name ?? '?').split(' ').map(w => w[0] ?? '').slice(0, 2).join('').toUpperCase()
  return (
    <span className="flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full text-[11px] font-bold text-white"
      style={{ background: color }}>
      {initials}
    </span>
  )
}

function MessageBubble({ msg }: { msg: Message }) {
  const time = new Date(msg.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })

  if (msg.is_internal_note) {
    return (
      <div className="mx-auto max-w-[88%]">
        <div className="rounded-xl px-4 py-3 relative" style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="material-symbols-rounded text-[14px] text-amber-600">lock</span>
            <span className="text-[11px] font-bold text-amber-700 uppercase tracking-wider">Internal Note</span>
            {msg.author_name && <span className="text-[11px] text-amber-600">· {msg.author_name}</span>}
            <span className="text-[11px] text-amber-400 ml-auto">{time}</span>
          </div>
          <p className="text-[13px] text-amber-900 whitespace-pre-wrap leading-relaxed">{msg.body_text}</p>
        </div>
      </div>
    )
  }

  const isInbound = msg.direction === 'inbound'
  const name = msg.author_name ?? (isInbound ? 'Customer' : 'Agent')

  if (isInbound) {
    return (
      <div className="flex items-end gap-2.5 max-w-[85%]">
        <MsgAvatar name={name} color="var(--txt2)" />
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[11px] font-semibold text-[color:var(--txt2)]">{name}</span>
            <span className="text-[11px] text-[color:var(--txt2)]">{time}</span>
          </div>
          <div className="rounded-2xl rounded-bl-md px-4 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap"
            style={{ background: 'var(--card)', border: '1px solid rgba(15,23,42,0.12)', color: 'var(--txt)' }}>
            {msg.body_text || (msg.body_html ? <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.body_html) }} /> : '—')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-end gap-2.5 max-w-[85%] ml-auto flex-row-reverse">
      <MsgAvatar name={name} color={NAVY} />
      <div className="flex flex-col items-end">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[11px] text-[color:var(--txt2)]">{time}</span>
          <span className="text-[11px] font-semibold text-[color:var(--txt2)]">{name}</span>
        </div>
        <div className="rounded-2xl rounded-br-md px-4 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-white"
          style={{ background: NAVY }}>
          {msg.body_text || (msg.body_html ? <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.body_html) }} /> : '—')}
        </div>
      </div>
    </div>
  )
}

function ActionSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden border" style={{ borderColor: 'var(--bdr)' }}>
      <div className="p-2.5">{children}</div>
    </div>
  )
}

function ActionBtn({
  icon, label, color, onClick, disabled = false,
}: {
  icon: string; label: string; color: string; onClick: () => void; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 px-1 py-1 rounded-lg text-[12px] font-semibold transition-all disabled:opacity-50 hover:opacity-80"
      style={{ color }}
    >
      <span className="material-symbols-rounded text-[18px]">{icon}</span>
      {label}
    </button>
  )
}

function CannedPicker({
  responses, channel, onSelect,
}: {
  responses: CannedResponse[]; channel: string; onSelect: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Filter by channel
  const filtered = responses.filter(r =>
    !r.channel || r.channel === 'both' || r.channel === channel.toLowerCase()
  )

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (filtered.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-[var(--card)] transition-all"
        style={{ borderColor: open ? NAVY : 'rgba(15,23,42,0.15)', color: 'var(--txt2)' }}
      >
        <span className="material-symbols-rounded text-[14px]">quickreply</span>
        Canned
        <span className="material-symbols-rounded text-[14px]">{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-1.5 z-[400] bg-[var(--card)] rounded-xl border shadow-xl overflow-hidden"
          style={{ minWidth: 240, maxHeight: 280, overflowY: 'auto', borderColor: 'var(--bdr)' }}
        >
          {filtered.map(r => (
            <button
              key={r.id}
              onClick={() => { onSelect(r.body_text); setOpen(false) }}
              className="w-full text-left px-4 py-2.5 hover:bg-[var(--bg)] transition-colors"
              style={{ borderBottom: '1px solid rgba(15,23,42,0.05)' }}
            >
              <p className="text-[12px] font-semibold text-[color:var(--txt)]">{r.name}</p>
              {r.category && <p className="text-[11px] text-[color:var(--txt2)] mt-0.5">{r.category}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
