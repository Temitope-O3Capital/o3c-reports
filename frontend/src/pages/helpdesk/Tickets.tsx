import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { StatusBadge, Modal, Spinner, ErrBanner, TblSearch } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, BLUE, NAVY, GREEN, PURPLE, MONO, SORA } from '../../lib/design'
import NewTicketForm from './NewTicket'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

const TICKET_TYPES = [
  'Card Dispute', 'Loan Query', 'Account Freeze', 'Transfer Issue',
  'POS Complaint', 'App Issue', 'General Inquiry', 'Complaint', 'Other',
]

const PRIORITY_COLOR: Record<string, string> = {
  urgent: RED, high: AMBER, medium: BLUE, low: 'var(--chart-lbl)', normal: 'var(--chart-lbl)',
}

interface Ticket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority: string
  channel: string
  ticket_type?: string
  customer_name?: string
  customer_cif?: string
  customer_phone?: string
  assigned_to_name?: string
  sla_breached?: boolean
  sla_due_at?: string
  last_message_at?: string
  created_at: string
}

interface TicketsResp { tickets: Ticket[]; total: number }

interface Message {
  id: number
  direction: 'inbound' | 'outbound'
  channel: string
  author_name?: string
  author_user_name?: string
  body_text: string
  is_internal_note?: boolean
  created_at: string
}

interface TicketDetailResp {
  ticket: Ticket
  messages: Message[]
  events?: any[]
}

interface Agent { id: number; full_name: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function ticketDisplayRef(t: Ticket): string {
  if (t.ticket_ref?.startsWith('ZOHO-'))
    return `#${t.ticket_ref.replace('ZOHO-', '').slice(-8)}`
  return `#${t.ticket_ref || t.id}`
}

// ── Small shared components ───────────────────────────────────────────────────

function PriorityDot({ priority }: { priority: string }) {
  const color = PRIORITY_COLOR[priority?.toLowerCase()] ?? 'var(--chart-lbl)'
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, flexShrink: 0,
    }} title={priority} />
  )
}

function TypePill({ type }: { type?: string }) {
  if (!type) return null
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 20,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap',
    }}>{type}</span>
  )
}

// ── Filter chips ──────────────────────────────────────────────────────────────

const STATUS_CHIPS = [
  { value: 'open',        label: 'Open' },
  { value: 'pending',     label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved',    label: 'Resolved' },
  { value: 'closed',      label: 'Closed' },
]

const PRIORITY_CHIPS = [
  { value: 'urgent', color: RED },
  { value: 'high',   color: AMBER },
  { value: 'normal', color: 'var(--chart-lbl)' },
  { value: 'low',    color: 'var(--chart-lbl)' },
]

// ── Compact ticket row (left panel) ──────────────────────────────────────────

function TicketRow({
  ticket, isSelected, isChecked, onSelect, onCheck,
}: {
  ticket: Ticket
  isSelected: boolean
  isChecked: boolean
  onSelect: () => void
  onCheck: (e: React.MouseEvent) => void
}) {
  const slaMs = ticket.sla_due_at && !ticket.sla_breached
    ? new Date(ticket.sla_due_at).getTime() - Date.now() : -1
  const slaWarnLabel = slaMs > 0 && slaMs < 2 * 3600 * 1000
    ? (() => { const m = Math.floor(slaMs / 60_000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m` })()
    : null

  return (
    <div
      onClick={onSelect}
      style={{
        padding: '10px 12px', borderBottom: '1px solid var(--bdr)',
        cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 8,
        background: isSelected ? `${NAVY}08` : undefined,
        borderLeft: `3px solid ${isSelected ? NAVY : 'transparent'}`,
      }}
      onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <input
        type="checkbox" checked={isChecked} onChange={() => {}}
        onClick={onCheck}
        style={{ marginTop: 3, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', fontFamily: MONO }}>
              {ticketDisplayRef(ticket)}
            </span>
            <PriorityDot priority={ticket.priority} />
            {slaWarnLabel && (
              <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 4px', borderRadius: 3, background: `${AMBER}15`, color: AMBER }}>
                {slaWarnLabel}
              </span>
            )}
            {ticket.sla_breached && (
              <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 4px', borderRadius: 3, background: `${RED}15`, color: RED }}>
                Overdue
              </span>
            )}
          </div>
          <StatusBadge status={ticket.status} size="sm" />
        </div>
        <div style={{
          fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', marginBottom: 4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {ticket.subject}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 3 }}>
          <TypePill type={ticket.ticket_type} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--txt2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ticket.customer_name ?? '—'}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--txt3)', flexShrink: 0 }}>
            {fmtDatetime(ticket.last_message_at || ticket.created_at)}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Message bubble (right panel) ─────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isAgent = msg.direction === 'outbound'
  const isNote  = msg.is_internal_note
  const sender  = msg.author_user_name || msg.author_name || (isAgent ? 'Agent' : 'Customer')
  return (
    <div style={{ display: 'flex', flexDirection: isAgent ? 'row-reverse' : 'row', gap: 8, marginBottom: 14 }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        background: isAgent ? NAVY : 'var(--chip-bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, color: isAgent ? '#fff' : 'var(--txt2)',
      }}>
        {sender.charAt(0).toUpperCase()}
      </div>
      <div style={{ maxWidth: '72%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: isAgent ? 'row-reverse' : 'row', marginBottom: 3 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt)' }}>{sender}</span>
          <span style={{ fontSize: 10.5, color: 'var(--txt3)' }}>{fmtDatetime(msg.created_at)}</span>
          {isNote && (
            <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 10, background: `${AMBER}18`, color: AMBER }}>
              Note
            </span>
          )}
        </div>
        <div style={{
          padding: '9px 13px', borderRadius: 10,
          borderTopLeftRadius: isAgent ? 10 : 2, borderTopRightRadius: isAgent ? 2 : 10,
          background: isNote ? `${AMBER}10` : (isAgent ? 'var(--card)' : 'var(--th-bg)'),
          border: `1px solid ${isNote ? `${AMBER}30` : 'var(--bdr)'}`,
          fontSize: 13, color: 'var(--txt)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {msg.body_text}
        </div>
      </div>
    </div>
  )
}

// ── Right panel — ticket detail ───────────────────────────────────────────────

function TicketPanel({
  ticketId, onUpdate, onOpenFull,
}: {
  ticketId: number
  onUpdate: () => void
  onOpenFull: () => void
}) {
  const [data,    setData]    = useState<TicketDetailResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  const [replyText, setReplyText] = useState('')
  const [isNote,    setIsNote]    = useState(false)
  const [sending,   setSending]   = useState(false)
  const [replyErr,  setReplyErr]  = useState<string | null>(null)

  const [actionLoading,  setActionLoading]  = useState(false)
  const [transferOpen,   setTransferOpen]   = useState(false)
  const [agents,         setAgents]         = useState<Agent[]>([])
  const [transferTarget, setTransferTarget] = useState('')

  const threadEndRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const resp = await apiFetch<TicketDetailResp>(`/api/helpdesk/tickets/${ticketId}`)
      setData(resp)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [ticketId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (data?.messages?.length) {
      setTimeout(() => threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    }
  }, [data?.messages?.length])

  useEffect(() => {
    if (transferOpen && agents.length === 0) {
      apiFetch<any>('/api/helpdesk/agents')
        .then(r => setAgents(Array.isArray(r) ? r : []))
        .catch(() => setAgents([]))
    }
  }, [transferOpen, agents.length])

  async function sendReply() {
    if (!replyText.trim()) return
    setSending(true); setReplyErr(null)
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/messages`, {
        body_text: replyText, is_internal_note: isNote,
      })
      setReplyText(''); setIsNote(false)
      await load(); onUpdate()
    } catch (e: any) { setReplyErr(e.message) }
    finally { setSending(false) }
  }

  async function updateStatus(status: string) {
    setActionLoading(true)
    try {
      await apiFetch(`/api/helpdesk/tickets/${ticketId}`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      })
      toast.success(`Ticket marked as ${status}`)
      await load(); onUpdate()
    } catch (e: any) { toast.error(e.message ?? 'Action failed') }
    finally { setActionLoading(false) }
  }

  async function handleTransfer() {
    if (!transferTarget) return
    setActionLoading(true)
    try {
      await apiFetch(`/api/helpdesk/tickets/${ticketId}`, {
        method: 'PATCH', body: JSON.stringify({ assigned_to: Number(transferTarget) }),
      })
      setTransferOpen(false); setTransferTarget('')
      toast.success('Ticket transferred')
      await load(); onUpdate()
    } catch (e: any) { toast.error(e.message ?? 'Transfer failed') }
    finally { setActionLoading(false) }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt2)', fontSize: 13 }}>
      <Spinner size={18} color={NAVY} /> Loading ticket…
    </div>
  )

  if (err || !data) return (
    <div style={{ padding: 24 }}>
      <ErrBanner error={err ?? 'Ticket not found'} onRetry={load} />
    </div>
  )

  const { ticket, messages = [] } = data
  const canResolve = !['resolved', 'closed'].includes(ticket.status)

  const sla = (() => {
    if (!ticket.sla_due_at) return null
    const diff = new Date(ticket.sla_due_at).getTime() - Date.now()
    const mins = Math.round(diff / 60_000)
    if (diff < 0) return { label: `Overdue by ${Math.abs(mins)}m`, color: RED }
    if (mins < 60) return { label: `${mins}m remaining`, color: AMBER }
    const hrs = Math.round(mins / 60)
    return { label: `${hrs}h remaining`, color: hrs < 4 ? AMBER : GREEN }
  })()

  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
    fontFamily: SORA, outline: 'none', boxSizing: 'border-box', resize: 'vertical' as const,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontFamily: SORA }}>

      {/* ── Header ── */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)', flexShrink: 0, background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', fontFamily: MONO }}>
                {ticketDisplayRef(ticket)}
              </span>
              <StatusBadge status={ticket.status} />
              <PriorityDot priority={ticket.priority} />
              {ticket.sla_breached && (
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: `${RED}15`, color: RED }}>SLA Overdue</span>
              )}
              {sla && !ticket.sla_breached && (
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: `${sla.color}15`, color: sla.color }}>{sla.label}</span>
              )}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)', lineHeight: 1.3 }}>
              {ticket.subject}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start' }}>
            {canResolve && (
              <button
                onClick={() => updateStatus('resolved')} disabled={actionLoading}
                style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: GREEN, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, opacity: actionLoading ? 0.7 : 1 }}
              >
                Resolve
              </button>
            )}
            <button
              onClick={onOpenFull}
              style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'none', color: 'var(--txt2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>open_in_full</span>
              Full View
            </button>
          </div>
        </div>

        {/* Metadata strip */}
        <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
          {[
            { icon: 'person',        val: ticket.customer_name || '—' },
            { icon: 'support_agent', val: ticket.assigned_to_name || 'Unassigned' },
            { icon: 'category',      val: ticket.ticket_type || ticket.channel || '—' },
            { icon: 'schedule',      val: fmtDatetime(ticket.created_at) },
          ].map(({ icon, val }) => (
            <span key={icon} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13, color: 'var(--txt3)' }}>{icon}</span>
              {val}
            </span>
          ))}
          <button
            onClick={() => setTransferOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: NAVY, fontWeight: 600, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 5, padding: '2px 8px', cursor: 'pointer', fontFamily: SORA }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>swap_horiz</span>
            Transfer
          </button>
          {!canResolve && ticket.status === 'resolved' && (
            <button
              onClick={() => updateStatus('closed')} disabled={actionLoading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: RED, fontWeight: 600, background: 'none', border: `1px solid ${RED}30`, borderRadius: 5, padding: '2px 8px', cursor: 'pointer', fontFamily: SORA }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 12 }}>check_circle</span>
              Close
            </button>
          )}
        </div>
      </div>

      {/* ── Message thread ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt3)', fontSize: 13 }}>
            No messages yet.
          </div>
        ) : (
          messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)
        )}
        <div ref={threadEndRef} />
      </div>

      {/* ── Reply composer ── */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--bdr)', flexShrink: 0, background: 'var(--card)' }}>
        {replyErr && <ErrBanner error={replyErr} />}
        <div style={{ display: 'flex', gap: 2, marginBottom: 8 }}>
          {(['Reply', 'Note'] as const).map(label => (
            <button
              key={label}
              onClick={() => setIsNote(label === 'Note')}
              style={{
                padding: '4px 10px', fontSize: 12, fontWeight: (isNote ? label === 'Note' : label === 'Reply') ? 600 : 500,
                color: (isNote ? label === 'Note' : label === 'Reply') ? NAVY : 'var(--txt2)',
                border: 'none', background: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${(isNote ? label === 'Note' : label === 'Reply') ? NAVY : 'transparent'}`,
                marginBottom: -1, fontFamily: SORA,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <textarea
          value={replyText} onChange={e => setReplyText(e.target.value)}
          rows={3} placeholder={isNote ? 'Add an internal note…' : 'Type your reply…'}
          style={{ ...fieldStyle, marginBottom: 8 }}
          onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) sendReply() }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={sendReply} disabled={!replyText.trim() || sending}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none',
              background: isNote ? AMBER : NAVY, color: '#fff',
              fontSize: 12.5, fontWeight: 600, cursor: sending || !replyText.trim() ? 'not-allowed' : 'pointer',
              opacity: !replyText.trim() ? 0.5 : 1, fontFamily: SORA,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {sending && <Spinner size={13} color="#fff" />}
            {isNote ? 'Add Note' : 'Send Reply'}
          </button>
        </div>
      </div>

      {/* Transfer modal */}
      <Modal open={transferOpen} onClose={() => { setTransferOpen(false); setTransferTarget('') }} title="Transfer Ticket" width={380}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Assign to agent</label>
            <select value={transferTarget} onChange={e => setTransferTarget(e.target.value)} style={{ ...fieldStyle, height: 36, resize: 'none' }}>
              <option value="">Select agent…</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setTransferOpen(false); setTransferTarget('') }} style={{ padding: '7px 14px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: 13, cursor: 'pointer', fontFamily: SORA }}>Cancel</button>
            <button onClick={handleTransfer} disabled={!transferTarget || actionLoading} style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !transferTarget ? 0.5 : 1, fontFamily: SORA, display: 'flex', alignItems: 'center', gap: 6 }}>
              {actionLoading && <Spinner size={13} color="#fff" />}
              Transfer
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Tickets() {
  const navigate = useNavigate()

  const [tickets,  setTickets]  = useState<Ticket[]>([])
  const [total,    setTotal]    = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null)

  const [search,      setSearch]      = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')

  const [selectedId,   setSelectedId]   = useState<number | null>(null)
  const [checkedIds,   setCheckedIds]   = useState<Set<number>>(new Set())
  const [newOpen,      setNewOpen]      = useState(false)
  const [reassignOpen, setReassignOpen] = useState(false)
  const [agents,       setAgents]       = useState<Agent[]>([])
  const [reassignTarget, setReassignTarget] = useState('')
  const [actionLoading,  setActionLoading]  = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (priorityFilter) params.set('priority', priorityFilter)
      params.set('per_page', '200')
      const resp = await apiFetch<TicketsResp>(`/api/helpdesk/tickets?${params}`)
      setTickets(resp.tickets ?? [])
      setTotal(resp.total ?? 0)
      setLastLoaded(new Date())
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [statusFilter, priorityFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (reassignOpen && agents.length === 0) {
      apiFetch<{ agents?: Agent[] } | Agent[]>('/api/helpdesk/supervisor')
        .then(r => { const list = Array.isArray(r) ? r : (r as any).agents ?? []; setAgents(list) })
        .catch(() => setAgents([]))
    }
  }, [reassignOpen, agents.length])

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function handleBulkClose() {
    if (checkedIds.size === 0) return
    setActionLoading(true)
    try {
      await apiPost('/api/helpdesk/tickets/bulk-close', { ticket_ids: Array.from(checkedIds) })
      setCheckedIds(new Set()); load()
      toast.success(`${checkedIds.size} ticket${checkedIds.size !== 1 ? 's' : ''} closed`)
    } catch (e: any) { setErr(e.message) }
    finally { setActionLoading(false) }
  }

  async function handleBulkReassign() {
    if (!reassignTarget || checkedIds.size === 0) return
    setActionLoading(true)
    try {
      await apiPost('/api/helpdesk/tickets/bulk-assign', { ticket_ids: Array.from(checkedIds), agent_id: Number(reassignTarget) })
      setCheckedIds(new Set()); setReassignOpen(false); setReassignTarget(''); load()
      toast.success('Tickets reassigned')
    } catch (e: any) { setErr(e.message) }
    finally { setActionLoading(false) }
  }

  const filtered = (() => {
    if (!search.trim()) return tickets
    const q = search.toLowerCase()
    return tickets.filter(t =>
      t.subject.toLowerCase().includes(q) ||
      (t.customer_name ?? '').toLowerCase().includes(q) ||
      (t.assigned_to_name ?? '').toLowerCase().includes(q) ||
      ticketDisplayRef(t).toLowerCase().includes(q)
    )
  })()

  const fieldStyle: React.CSSProperties = {
    padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
    fontFamily: SORA, outline: 'none', boxSizing: 'border-box' as const,
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, fontFamily: SORA }}>

      {/* ── Page header ── */}
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid var(--bdr)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--card)',
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--txt)', letterSpacing: '-.02em' }}>Tickets</div>
          <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 1 }}>{total} ticket{total !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastLoaded && (
            <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>
              {(() => { const m = Math.floor((Date.now() - lastLoaded.getTime()) / 60_000); return m === 0 ? 'Just loaded' : `${m}m ago` })()}
            </span>
          )}
          <button onClick={load} title="Refresh" style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span>
          </button>
          <button
            onClick={() => setNewOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SORA }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Ticket
          </button>
        </div>
      </div>

      {/* ── Split panel ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left panel */}
        <div style={{
          width: 360, minWidth: 300, maxWidth: 400, flexShrink: 0,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)',
        }}>

          {/* Search + filter chips */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <TblSearch
              value={search} onChange={setSearch}
              placeholder="Search subject, customer, ref…"
              width={0} style={{ marginBottom: 8 }}
            />

            {/* Status chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {STATUS_CHIPS.map(({ value, label }) => {
                const on = statusFilter === value
                return (
                  <button key={value} onClick={() => setStatusFilter(on ? '' : value)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`,
                    background: on ? `${NAVY}12` : 'transparent',
                    color: on ? NAVY : 'var(--txt3)',
                    cursor: 'pointer', fontFamily: SORA,
                  }}>
                    {label}
                  </button>
                )
              })}
            </div>

            {/* Priority chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {PRIORITY_CHIPS.map(({ value, color }) => {
                const on = priorityFilter === value
                return (
                  <button key={value} onClick={() => setPriorityFilter(on ? '' : value)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    border: `1px solid ${on ? color : 'var(--bdr)'}`,
                    background: on ? `${color}18` : 'transparent',
                    color: on ? color : 'var(--txt3)',
                    cursor: 'pointer', fontFamily: SORA, textTransform: 'capitalize',
                  }}>
                    {value}
                  </button>
                )
              })}
              {(statusFilter || priorityFilter || search) && (
                <button onClick={() => { setStatusFilter(''); setPriorityFilter(''); setSearch('') }} style={{
                  fontSize: 10.5, fontWeight: 500, padding: '2px 8px', borderRadius: 99,
                  border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt3)', cursor: 'pointer', fontFamily: SORA,
                }}>Clear</button>
              )}
            </div>
          </div>

          {/* Bulk bar */}
          {checkedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: '#F0F4FF', borderBottom: '1px solid var(--bdr)', flexShrink: 0, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>{checkedIds.size} selected</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => setReassignOpen(true)} style={{ fontSize: 11.5, fontWeight: 600, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer', fontFamily: SORA }}>
                  Reassign
                </button>
                <button onClick={handleBulkClose} disabled={actionLoading} style={{ fontSize: 11.5, fontWeight: 600, color: '#fff', background: RED, border: 'none', borderRadius: 6, padding: '3px 9px', cursor: 'pointer', fontFamily: SORA, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {actionLoading ? <Spinner size={11} color="#fff" /> : null} Close
                </button>
                <button onClick={() => setCheckedIds(new Set())} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%', fontSize: 14 }}>✕</button>
              </div>
            </div>
          )}

          {/* Count bar */}
          <div style={{ padding: '5px 12px', borderBottom: '1px solid var(--bdr)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.08em', fontFamily: MONO }}>
              {statusFilter || priorityFilter || search ? 'Filtered' : 'All tickets'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--txt3)', fontFamily: MONO }}>{filtered.length} of {tickets.length}</span>
          </div>

          {err && <div style={{ padding: '10px 12px' }}><ErrBanner error={err} onRetry={load} /></div>}

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: 13 }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: 13 }}>
                No tickets match the current filters.
              </div>
            ) : filtered.map(ticket => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                isSelected={selectedId === ticket.id}
                isChecked={checkedIds.has(ticket.id)}
                onSelect={() => setSelectedId(ticket.id)}
                onCheck={e => toggleCheck(ticket.id, e)}
              />
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          {selectedId ? (
            <TicketPanel
              key={selectedId}
              ticketId={selectedId}
              onUpdate={load}
              onOpenFull={() => navigate(`/helpdesk/${selectedId}`)}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt3)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 36, opacity: 0.3 }}>confirmation_number</span>
              <span style={{ fontSize: 13 }}>Select a ticket to view the conversation</span>
            </div>
          )}
        </div>
      </div>

      {/* New ticket modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Ticket" width={720}>
        <NewTicketForm onClose={() => setNewOpen(false)} onCreated={id => { setNewOpen(false); setSelectedId(id); load() }} />
      </Modal>

      {/* Bulk reassign modal */}
      <Modal
        open={reassignOpen}
        onClose={() => { setReassignOpen(false); setReassignTarget('') }}
        title={`Reassign ${checkedIds.size} ticket${checkedIds.size !== 1 ? 's' : ''}`}
        width={400}
        footer={
          <>
            <button onClick={() => { setReassignOpen(false); setReassignTarget('') }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer', fontFamily: SORA }}>Cancel</button>
            <button onClick={handleBulkReassign} disabled={!reassignTarget || actionLoading} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (!reassignTarget || actionLoading) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 8, fontFamily: SORA }}>
              {actionLoading && <Spinner size={14} color="#fff" />}
              Reassign
            </button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: 'var(--txt2)', marginTop: 0 }}>Select the agent to assign the selected tickets to.</p>
        <select value={reassignTarget} onChange={e => setReassignTarget(e.target.value)} style={{ ...fieldStyle, width: '100%', height: 38 }}>
          <option value="">— Select agent —</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
      </Modal>
    </div>
  )
}
