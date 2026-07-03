import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, FilterBar, filterInputStyle, StatusBadge, Modal, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, BLUE, NAVY } from '../../lib/design'
import NewTicketForm from './NewTicket'

// ── Types ─────────────────────────────────────────────────────────────────────

const TICKET_TYPES = [
  'Card Dispute', 'Loan Query', 'Account Freeze', 'Transfer Issue',
  'POS Complaint', 'App Issue', 'General Inquiry', 'Complaint', 'Other',
]

const PRIORITY_COLOR: Record<string, string> = {
  urgent: RED,
  high: AMBER,
  medium: BLUE,
  low: '#9CA3AF',
  normal: '#9CA3AF',
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
  last_message_preview?: string
  last_message_at?: string
  created_at: string
}

interface TicketsResp {
  tickets: Ticket[]
  total: number
}

interface Agent {
  id: number
  full_name: string
}

// ── Priority dot ──────────────────────────────────────────────────────────────

function PriorityDot({ priority }: { priority: string }) {
  const color = PRIORITY_COLOR[priority?.toLowerCase()] ?? '#9CA3AF'
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, flexShrink: 0,
    }} title={priority} />
  )
}

// ── Type pill ─────────────────────────────────────────────────────────────────

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

// ── Ticket list row ───────────────────────────────────────────────────────────

function TicketRow({
  ticket, selected, onClick, checked, onCheck,
}: {
  ticket: Ticket
  selected: boolean
  onClick: () => void
  checked: boolean
  onCheck: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  const slaMs = ticket.sla_due_at && !ticket.sla_breached
    ? new Date(ticket.sla_due_at).getTime() - Date.now()
    : -1
  const slaWarnLabel = slaMs > 0 && slaMs < 2 * 3600 * 1000
    ? (() => { const m = Math.floor(slaMs / 60_000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m` })()
    : null

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--bdr)',
        background: selected ? `${RED}08` : 'var(--card)',
        borderLeft: selected ? `3px solid ${RED}` : '3px solid transparent',
        transition: 'background 120ms',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--card)' }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onCheck}
        onClick={e => e.stopPropagation()}
        style={{ marginTop: 2, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', fontFamily: 'Inter, sans-serif' }}>
            #{ticket.ticket_ref || `TK-${ticket.id}`}
          </span>
          <PriorityDot priority={ticket.priority} />
          {slaWarnLabel && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
              background: `${AMBER}15`, color: AMBER,
            }}>{slaWarnLabel}</span>
          )}
          {ticket.sla_breached && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
              background: `${RED}15`, color: RED,
            }}>Overdue</span>
          )}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ticket.subject}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <TypePill type={ticket.ticket_type} />
          <StatusBadge status={ticket.status} size="sm" />
        </div>
        {ticket.customer_name && (
          <div style={{ fontSize: 11.5, color: 'var(--txt2)', marginTop: 3 }}>
            {ticket.customer_name}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
          {fmtDatetime(ticket.last_message_at || ticket.created_at)}
        </div>
      </div>
    </div>
  )
}

// ── Preview panel ─────────────────────────────────────────────────────────────

function PreviewPanel({ ticket, onOpenFull }: { ticket: Ticket; onOpenFull: (id: number) => void }) {
  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt2)', fontFamily: 'Inter, sans-serif' }}>
          #{ticket.ticket_ref || `TK-${ticket.id}`}
        </span>
        <TypePill type={ticket.ticket_type} />
        <StatusBadge status={ticket.status} />
        <PriorityDot priority={ticket.priority} />
        {ticket.sla_breached && (
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: `${RED}15`, color: RED }}>
            SLA Overdue
          </span>
        )}
      </div>

      <h2 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: 'var(--txt)', lineHeight: 1.35 }}>
        {ticket.subject}
      </h2>

      {ticket.last_message_preview && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, background: 'var(--th-bg)',
          fontSize: 13, color: 'var(--txt2)', lineHeight: 1.5, marginBottom: 16,
          borderLeft: `3px solid var(--bdr)`,
        }}>
          {ticket.last_message_preview}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {ticket.customer_name && (
          <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
            <span style={{ color: 'var(--txt2)', minWidth: 90 }}>Customer</span>
            <span style={{ color: 'var(--txt)', fontWeight: 600 }}>{ticket.customer_name}</span>
          </div>
        )}
        {ticket.customer_phone && (
          <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
            <span style={{ color: 'var(--txt2)', minWidth: 90 }}>Phone</span>
            <span style={{ color: 'var(--txt)' }}>{ticket.customer_phone}</span>
          </div>
        )}
        {ticket.customer_cif && (
          <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
            <span style={{ color: 'var(--txt2)', minWidth: 90 }}>CIF</span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 700,
              padding: '2px 8px', borderRadius: 6, background: `${NAVY}12`, color: NAVY,
              fontFamily: 'Inter, monospace',
            }}>{ticket.customer_cif}</span>
          </div>
        )}
        {ticket.assigned_to_name && (
          <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
            <span style={{ color: 'var(--txt2)', minWidth: 90 }}>Assigned</span>
            <span style={{ color: 'var(--txt)' }}>{ticket.assigned_to_name}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
          <span style={{ color: 'var(--txt2)', minWidth: 90 }}>Created</span>
          <span style={{ color: 'var(--txt)' }}>{fmtDatetime(ticket.created_at)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          style={{
            padding: '8px 16px', borderRadius: 8, border: 'none',
            background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
          onClick={() => onOpenFull(ticket.id)}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_full</span>
          Open Full Detail
        </button>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Tickets() {
  const navigate = useNavigate()
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Filters
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [priority, setPriority] = useState('')
  const [agent, setAgent] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Selection
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())

  // Modals
  const [newOpen, setNewOpen] = useState(false)
  const [reassignOpen, setReassignOpen] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [reassignTarget, setReassignTarget] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const selectedTicket = tickets.find(t => t.id === selectedId) ?? null

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (type) params.set('ticket_type', type)
      if (priority) params.set('priority', priority)
      if (agent) params.set('assigned_to', agent)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      params.set('per_page', '100')
      const resp = await apiFetch<TicketsResp>(`/api/helpdesk/tickets?${params}`)
      setTickets(resp.tickets ?? [])
      setTotal(resp.total ?? 0)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [status, type, priority, agent, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  // Load agents for reassign modal
  useEffect(() => {
    if (reassignOpen && agents.length === 0) {
      apiFetch<{ agents?: Agent[] } | Agent[]>('/api/helpdesk/supervisor')
        .then(r => {
          const list = Array.isArray(r) ? r : (r as any).agents ?? []
          setAgents(list)
        })
        .catch(() => setAgents([]))
    }
  }, [reassignOpen, agents.length])

  function toggleCheck(id: number, e: React.ChangeEvent<HTMLInputElement>) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleBulkClose() {
    if (checkedIds.size === 0) return
    setActionLoading(true)
    try {
      await apiPost('/api/helpdesk/tickets/bulk-close', { ticket_ids: Array.from(checkedIds) })
      setCheckedIds(new Set())
      load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleBulkReassign() {
    if (!reassignTarget || checkedIds.size === 0) return
    setActionLoading(true)
    try {
      await apiPost('/api/helpdesk/tickets/bulk-assign', {
        ticket_ids: Array.from(checkedIds),
        agent_id: Number(reassignTarget),
      })
      setCheckedIds(new Set())
      setReassignOpen(false)
      setReassignTarget('')
      load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  function handleExport() {
    const ids = Array.from(checkedIds).join(',')
    window.open(`/api/helpdesk/tickets/export?ids=${ids}`, '_blank')
  }

  const hasBulk = checkedIds.size > 0

  return (
    <Page
      title="Tickets"
      subtitle={`${total} ticket${total !== 1 ? 's' : ''}`}
      actions={
        <button
          onClick={() => setNewOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 15px', background: NAVY, color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Ticket
        </button>
      }
      noPad
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div style={{
          width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--bdr)', background: 'var(--card)', overflow: 'hidden',
        }}>
          {/* Filters */}
          <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <FilterBar onReset={() => { setStatus(''); setType(''); setPriority(''); setAgent(''); setDateFrom(''); setDateTo('') }}>
              <select
                value={status} onChange={e => setStatus(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}
              >
                <option value="">All Status</option>
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
              <select
                value={type} onChange={e => setType(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}
              >
                <option value="">All Types</option>
                {TICKET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </FilterBar>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <select
                value={priority} onChange={e => setPriority(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}
              >
                <option value="">All Priority</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <input
                placeholder="Agent name…"
                value={agent}
                onChange={e => setAgent(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                title="From date"
                style={{ ...filterInputStyle, flex: 1 }}
              />
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                title="To date"
                style={{ ...filterInputStyle, flex: 1 }}
              />
            </div>
          </div>

          {/* Bulk bar */}
          {hasBulk && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 12px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0, flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: NAVY }}>
                {checkedIds.size} selected
              </span>
              <button
                onClick={() => setReassignOpen(true)}
                style={{ fontSize: 12, fontWeight: 600, color: NAVY, background: 'none', border: `1px solid ${NAVY}`, borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}
              >
                Reassign
              </button>
              <button
                onClick={handleBulkClose}
                disabled={actionLoading}
                style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: RED, border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}
              >
                {actionLoading ? <Spinner size={12} color="#fff" /> : 'Close'}
              </button>
              <button
                onClick={handleExport}
                style={{ fontSize: 12, fontWeight: 500, color: 'var(--txt2)', background: 'none', border: '1px solid var(--bdr)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}
              >
                Export
              </button>
              <button
                onClick={() => setCheckedIds(new Set())}
                style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
              </button>
            </div>
          )}

          {/* Ticket list */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {err && <div style={{ padding: 12 }}><ErrBanner error={err} onRetry={load} /></div>}
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                <Spinner size={24} />
              </div>
            ) : tickets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--txt2)', fontSize: 13 }}>
                No tickets found
              </div>
            ) : (
              tickets.map(ticket => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  selected={selectedId === ticket.id}
                  checked={checkedIds.has(ticket.id)}
                  onClick={() => setSelectedId(ticket.id === selectedId ? null : ticket.id)}
                  onCheck={e => toggleCheck(ticket.id, e)}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Right panel ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          {selectedTicket ? (
            <PreviewPanel
              ticket={selectedTicket}
              onOpenFull={id => navigate(`/helpdesk/${id}`)}
            />
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', color: 'var(--txt2)',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, marginBottom: 12, color: 'var(--txt3)' }}>
                inbox
              </span>
              <span style={{ fontSize: 14 }}>Select a ticket to preview</span>
            </div>
          )}
        </div>
      </div>

      {/* New Ticket modal */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Ticket"
        width={720}
      >
        <NewTicketForm
          onClose={() => setNewOpen(false)}
          onCreated={id => { setNewOpen(false); navigate(`/helpdesk/${id}`) }}
        />
      </Modal>

      {/* Reassign modal */}
      <Modal
        open={reassignOpen}
        onClose={() => { setReassignOpen(false); setReassignTarget('') }}
        title={`Reassign ${checkedIds.size} ticket${checkedIds.size !== 1 ? 's' : ''}`}
        width={400}
        footer={
          <>
            <button
              onClick={() => { setReassignOpen(false); setReassignTarget('') }}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}
            >Cancel</button>
            <button
              onClick={handleBulkReassign}
              disabled={!reassignTarget || actionLoading}
              style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (!reassignTarget || actionLoading) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              {actionLoading && <Spinner size={14} color="#fff" />}
              Reassign
            </button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: 'var(--txt2)', marginTop: 0 }}>
          Select the agent to assign the selected tickets to.
        </p>
        <select
          value={reassignTarget}
          onChange={e => setReassignTarget(e.target.value)}
          style={{ ...filterInputStyle, width: '100%', height: 38 }}
        >
          <option value="">— Select agent —</option>
          {agents.map(a => (
            <option key={a.id} value={a.id}>{a.full_name}</option>
          ))}
        </select>
      </Modal>
    </Page>
  )
}
