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
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtKobo } from '../../lib/fmt'
import { Spinner, ErrBanner, NAVY, AMBER, RED, GREEN, BLUE } from '../../components/UI'

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
  customer_name: string
  customer_cif: string
  customer_email?: string
  customer_phone?: string
  assigned_to_name?: string | null
  assigned_to_id?: number | null
  tags?: string[]
  sla_due_at?: string | null
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

const STATUS_BADGE: Record<string, { bg: string; color: string }> = {
  open:        { bg: 'rgba(14,40,65,0.1)',    color: NAVY },
  pending:     { bg: 'rgba(217,119,6,0.1)',   color: AMBER },
  in_progress: { bg: 'rgba(37,99,235,0.1)',   color: BLUE },
  resolved:    { bg: 'rgba(5,150,105,0.1)',   color: GREEN },
  closed:      { bg: 'rgba(100,116,139,0.1)', color: '#64748B' },
}

const PRIORITY_BADGE: Record<string, { bg: string; color: string }> = {
  urgent: { bg: 'rgba(192,0,0,0.1)',    color: RED },
  high:   { bg: 'rgba(234,88,12,0.1)',  color: '#EA580C' },
  normal: { bg: 'rgba(100,116,139,0.1)',color: '#475569' },
  low:    { bg: 'rgba(148,163,184,0.1)',color: '#94A3B8' },
}

const CHANNEL_ICON: Record<string, string> = {
  email:    'email',
  sms:      'sms',
  whatsapp: 'chat',
  phone:    'call',
  'in-app': 'smartphone',
  in_app:   'smartphone',
}

// ── Sub-components ──────────────────────────────────────────────────────────────
function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase().replace(/[\s-]+/g, '_')
  const s = STATUS_BADGE[key] ?? { bg: 'rgba(14,40,65,0.06)', color: '#475569' }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
      {status}
    </span>
  )
}

function PriorityPill({ priority }: { priority: string }) {
  const key = priority.toLowerCase()
  const s = PRIORITY_BADGE[key] ?? { bg: 'rgba(100,116,139,0.1)', color: '#64748B' }
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}>
      {priority}
    </span>
  )
}

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

function Toast({ msg, type }: { msg: string; type: 'success' | 'error' }) {
  if (!msg) return null
  const bg = type === 'success' ? 'rgba(5,150,105,0.95)' : 'rgba(192,0,0,0.95)'
  return (
    <div
      className="fixed bottom-6 right-6 z-[500] flex items-center gap-2 px-4 py-3 rounded-xl text-white text-[13px] font-semibold shadow-xl"
      style={{ background: bg }}
    >
      <span className="material-symbols-rounded text-[16px]">
        {type === 'success' ? 'check_circle' : 'error'}
      </span>
      {msg}
    </div>
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

  // Reply box
  const [replyMode, setReplyMode] = useState<'reply' | 'note'>('reply')
  const [body, setBody]           = useState('')
  const [sending, setSending]     = useState(false)
  const [sendErr, setSendErr]     = useState('')

  // Toast
  const [toast, setToast]         = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

  // Tags local state
  const [tagInput, setTagInput]   = useState('')
  const [showTagInput, setShowTagInput] = useState(false)
  const tagRef = useRef<HTMLInputElement>(null)

  // Patch in-flight guard
  const patchingRef = useRef(false)

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
    apiFetch<Agent[]>('/api/admin/users').catch(() => apiFetch<Agent[]>('/api/users')).then(setAgents).catch(() => {})
  }, [])

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
    const current = data?.ticket.tags ?? []
    if (current.includes(tagInput.trim())) { setTagInput(''); setShowTagInput(false); return }
    const next = [...current, tagInput.trim()]
    setTagInput(''); setShowTagInput(false)
    await patchTicket('tags', next.join(','))
    load()
  }

  // Remove tag
  async function removeTag(tag: string) {
    if (!id) return
    const next = (data?.ticket.tags ?? []).filter(t => t !== tag)
    await patchTicket('tags', next.join(','))
    load()
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

  return (
    <div className="flex flex-col h-full" style={{ minHeight: '100vh', background: '#F4F6F8' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3.5 bg-white"
        style={{ borderBottom: '1px solid rgba(15,23,42,0.09)' }}>
        <button
          onClick={() => navigate('/helpdesk')}
          className="flex items-center gap-1 text-[12px] font-medium text-slate-500 hover:text-slate-800 transition-colors"
        >
          <span className="material-symbols-rounded text-[16px]">arrow_back</span>
          Helpdesk
        </button>
        <span className="text-slate-300">/</span>
        <span className="font-mono text-[13px] text-slate-500">{ticket.ticket_ref}</span>
        <span className="text-slate-300">·</span>
        <span className="font-semibold text-slate-800 text-[14px] truncate max-w-[360px]">
          {ticket.subject}
        </span>
        <div className="flex items-center gap-2 ml-auto flex-shrink-0">
          <span className="flex items-center gap-1 text-[12px] text-slate-500">
            <span className="material-symbols-rounded text-[14px]">
              {CHANNEL_ICON[ticket.channel?.toLowerCase()] ?? 'chat'}
            </span>
            {ticket.channel}
          </span>
          <PriorityPill priority={ticket.priority} />
          <StatusPill status={ticket.status} />
        </div>
      </div>

      {/* Body: three columns */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT SIDEBAR */}
        <aside className="w-52 bg-white border-r flex-shrink-0 overflow-y-auto"
          style={{ borderColor: 'rgba(15,23,42,0.09)' }}>
          <div className="p-4 space-y-4">
            {/* Status */}
            <SideField label="Status">
              <select
                value={ticket.status.toLowerCase().replace(/\s+/g, '_')}
                onChange={e => patchTicket('status', e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium bg-white outline-none appearance-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155' }}
              >
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </SideField>

            {/* Priority */}
            <SideField label="Priority">
              <select
                value={ticket.priority.toLowerCase()}
                onChange={e => patchTicket('priority', e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium bg-white outline-none appearance-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155' }}
              >
                {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </SideField>

            {/* Channel (display only) */}
            <SideField label="Channel">
              <span className="flex items-center gap-1 text-[12px] text-slate-600">
                <span className="material-symbols-rounded text-[14px]">
                  {CHANNEL_ICON[ticket.channel?.toLowerCase()] ?? 'chat'}
                </span>
                {ticket.channel}
              </span>
            </SideField>

            {/* Department */}
            <SideField label="Department">
              <select
                value={ticket.department?.toLowerCase().replace(/\s+/g, '_') ?? 'general'}
                onChange={e => patchTicket('department', e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium bg-white outline-none appearance-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155' }}
              >
                {DEPT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </SideField>

            {/* Tags */}
            <SideField label="Tags">
              <div className="flex flex-wrap gap-1">
                {(ticket.tags ?? []).map(tag => (
                  <span key={tag}
                    className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{ background: 'rgba(14,40,65,0.08)', color: NAVY }}>
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
                    className="text-[11px] px-1.5 py-0.5 rounded-full font-medium text-slate-400 hover:text-slate-600 transition-colors"
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
                  value={ticket.assigned_to_id ?? ''}
                  onChange={e => patchTicket('assigned_to_id', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium bg-white outline-none appearance-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155' }}
                >
                  <option value="">Unassigned</option>
                  {agents.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                </select>
              ) : (
                <input
                  defaultValue={ticket.assigned_to_name ?? ''}
                  onBlur={e => patchTicket('assigned_to_name', e.target.value)}
                  placeholder="Enter name…"
                  className="w-full px-2 py-1.5 rounded-lg border text-[12px] font-medium bg-white outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155' }}
                />
              )}
            </SideField>

            {/* SLA */}
            <SideField label="SLA">
              <SLACountdown dueAt={ticket.sla_due_at} />
              {!ticket.sla_due_at && <span className="text-[12px] text-slate-400">No SLA set</span>}
            </SideField>

            <div className="pt-1" style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }}>
              <p className="text-[11px] text-slate-400 mb-0.5">Created</p>
              <p className="text-[12px] text-slate-600">{fmtDate(ticket.created_at)}</p>
            </div>
          </div>
        </aside>

        {/* MIDDLE: Messages + Reply */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            {messages.map(msg => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}

            {/* Timeline */}
            {events.length > 0 && (
              <div className="mt-6 space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Timeline</p>
                {events.map(e => (
                  <div key={e.id} className="flex items-center gap-2 text-[12px] text-slate-400">
                    <span className="material-symbols-rounded text-[14px]" style={{ color: '#CBD5E1' }}>circle</span>
                    <span>
                      {e.event_type === 'created'
                        ? 'Ticket created'
                        : `${e.event_type}: ${e.old_value ?? '—'} → ${e.new_value}`}
                    </span>
                    <span className="ml-auto whitespace-nowrap">
                      {new Date(e.ts).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reply box */}
          <div className="bg-white border-t flex-shrink-0"
            style={{ borderColor: 'rgba(15,23,42,0.09)' }}>
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
                placeholder={replyMode === 'note' ? 'Add an internal note (not visible to customer)…' : 'Type your reply…'}
                rows={4}
                className="w-full px-3 py-2.5 rounded-xl border text-[13px] resize-none outline-none transition-colors"
                style={{
                  borderColor: 'rgba(15,23,42,0.15)',
                  background: replyMode === 'note' ? '#FFFBEB' : 'white',
                  color: '#334155',
                }}
              />
              {sendErr && <p className="text-[12px] text-red-600 mt-1">{sendErr}</p>}
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

        {/* RIGHT: Customer 360 */}
        <aside className="w-64 bg-white border-l flex-shrink-0 overflow-y-auto"
          style={{ borderColor: 'rgba(15,23,42,0.09)' }}>
          <div className="p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">
              Customer 360
            </p>

            {/* Customer name & CIF */}
            <div className="mb-4">
              <p className="font-semibold text-slate-800 text-[14px] leading-snug">
                {ctx?.full_name ?? ticket.customer_name}
              </p>
              {(ctx?.cif_number ?? ticket.customer_cif) && (
                <span className="text-[11px] font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded mt-1 inline-block">
                  CIF: {ctx?.cif_number ?? ticket.customer_cif}
                </span>
              )}
            </div>

            {/* Contact */}
            {ticket.customer_email && (
              <div className="flex items-center gap-1.5 text-[12px] text-slate-500 mb-1.5">
                <span className="material-symbols-rounded text-[14px]">email</span>
                <span className="truncate">{ticket.customer_email}</span>
              </div>
            )}
            {ticket.customer_phone && (
              <div className="flex items-center gap-1.5 text-[12px] text-slate-500 mb-3">
                <span className="material-symbols-rounded text-[14px]">phone</span>
                <span>{ticket.customer_phone}</span>
              </div>
            )}

            <div style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }} className="pt-3 space-y-2.5">
              {ctx ? (
                <>
                  <Ctx360Item label="Account Status" value={ctx.account_status ?? '—'} />
                  <Ctx360Item label="Loan Balance" value={fmtKobo(ctx.loan_balance_kobo)} />
                  <Ctx360Item label="DPD" value={String(ctx.dpd ?? 0)} />
                  <Ctx360Item label="Open Tickets" value={String(ctx.open_tickets ?? 0)} />
                </>
              ) : (
                <p className="text-[12px] text-slate-400">No profile data</p>
              )}
            </div>

            {ticket.customer_cif && (
              <button
                onClick={() => navigate(`/customers/${ticket.customer_cif}`)}
                className="mt-4 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold border transition-all"
                style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}
              >
                <span className="material-symbols-rounded text-[15px]">open_in_new</span>
                View Profile
              </button>
            )}
          </div>
        </aside>
      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
function SideField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">{label}</p>
      {children}
    </div>
  )
}

function Ctx360Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-slate-400">{label}</span>
      <span className="text-[12px] font-semibold text-slate-700">{value}</span>
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
        color: active ? NAVY : '#64748B',
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
  const color = (primary || amber) ? 'white' : '#475569'
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

function MessageBubble({ msg }: { msg: Message }) {
  const time = new Date(msg.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })

  if (msg.is_internal_note) {
    return (
      <div className="rounded-xl border px-4 py-3" style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[12px]">🔒</span>
          <span className="text-[12px] font-semibold text-amber-700">Internal note</span>
          {msg.author_name && (
            <span className="text-[11px] text-slate-400">· {msg.author_name}</span>
          )}
          <span className="text-[11px] text-slate-400 ml-auto">{time}</span>
        </div>
        <p className="text-[13px] text-slate-700 whitespace-pre-wrap">{msg.body_text}</p>
      </div>
    )
  }

  const isInbound = msg.direction === 'inbound'

  return (
    <div className={`${isInbound ? '' : 'flex flex-col items-end'}`}>
      <div className="flex items-center gap-2 mb-1">
        {isInbound ? (
          <>
            <span className="text-[11px] font-semibold text-slate-500">
              {msg.author_name ?? 'Customer'}
            </span>
            <span className="text-[11px] text-slate-400">{time}</span>
          </>
        ) : (
          <>
            <span className="text-[11px] text-slate-400">{time}</span>
            <span className="text-[11px] font-semibold text-slate-500">
              {msg.author_name ?? 'Agent'}
            </span>
          </>
        )}
      </div>
      <div
        className={`rounded-xl border px-4 py-3 max-w-[85%] text-[13px] text-slate-700 whitespace-pre-wrap`}
        style={{
          background: isInbound ? 'white' : 'rgba(14,40,65,0.05)',
          borderColor: isInbound ? 'rgba(15,23,42,0.1)' : 'rgba(14,40,65,0.1)',
        }}
      >
        {msg.body_text || (msg.body_html ? <span dangerouslySetInnerHTML={{ __html: msg.body_html }} /> : '—')}
      </div>
    </div>
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
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white transition-all"
        style={{ borderColor: open ? NAVY : 'rgba(15,23,42,0.15)', color: '#475569' }}
      >
        <span className="material-symbols-rounded text-[14px]">quickreply</span>
        Canned
        <span className="material-symbols-rounded text-[14px]">{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-1.5 z-[400] bg-white rounded-xl border shadow-xl overflow-hidden"
          style={{ minWidth: 240, maxHeight: 280, overflowY: 'auto', borderColor: 'rgba(15,23,42,0.1)' }}
        >
          {filtered.map(r => (
            <button
              key={r.id}
              onClick={() => { onSelect(r.body_text); setOpen(false) }}
              className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors"
              style={{ borderBottom: '1px solid rgba(15,23,42,0.05)' }}
            >
              <p className="text-[12px] font-semibold text-slate-700">{r.name}</p>
              {r.category && <p className="text-[11px] text-slate-400 mt-0.5">{r.category}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
