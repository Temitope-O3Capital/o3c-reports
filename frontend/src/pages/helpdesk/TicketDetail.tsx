import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, StatusBadge, Tabs, Modal, ConfirmModal, Spinner, ErrBanner,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtKobo } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, NAVY, PURPLE, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

const PRIORITY_COLOR: Record<string, string> = {
  urgent: RED, high: AMBER, medium: BLUE, low: 'var(--chart-lbl)', normal: 'var(--chart-lbl)',
}

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

interface Ticket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority: string
  channel: string
  ticket_type?: string
  customer_name?: string
  customer_email?: string
  customer_phone?: string
  customer_cif?: string
  assigned_to?: number
  assigned_to_name?: string
  sla_due_at?: string
  sla_breached?: boolean
  created_at: string
}

interface CustomerContext {
  cif_number?: string
  full_name?: string
  account_status?: string
  open_tickets?: number
  dpd?: number
  loan_balance_kobo?: number
  last_payment_date?: string
}

interface TicketDetailResp {
  ticket: Ticket
  messages: Message[]
  events: any[]
  customer_context?: CustomerContext
}

interface CardRow {
  product_name?: string
  account_status?: string
  name_on_card?: string
  account_manager?: string
}

interface EnrichedContext {
  cif?: string
  customer_name?: string
  customer_email?: string
  customer_phone?: string
  loans?: LoanRow[]
  fixed_deposits?: FDRow[]
  recent_transactions?: TxnRow[]
  collections_history?: PTPRow[]
  cards?: CardRow[]
  other_open_tickets?: number
}

interface LoanRow {
  loan_ref?: string
  product_type?: string
  status?: string
  amount_approved_kobo?: number
  total_outstanding_kobo?: number
  dpd?: number
  next_repayment_date?: string
}

interface FDRow {
  id?: number
  principal_kobo?: number
  interest_rate?: number
  tenor_days?: number
  maturity_date?: string
  status?: string
}

interface TxnRow {
  transaction_date?: string
  description?: string
  amount_kobo?: number
  transaction_type?: string
}

interface PTPRow {
  promise_date?: string
  promise_amount_kobo?: number
  ptp_status?: string
  created_at?: string
}

interface AgentItem { id: number; full_name: string }
interface KBResult { id: number; title: string; category: string; body_text?: string }
interface TicketSearchResult { id: number; ticket_ref: string; subject: string; status: string }

// ── SLA label ─────────────────────────────────────────────────────────────────

function slaLabel(sla_due_at?: string): { label: string; color: string } {
  if (!sla_due_at) return { label: 'No SLA', color: 'var(--txt3)' }
  const diff = new Date(sla_due_at).getTime() - Date.now()
  const mins = Math.round(diff / 60_000)
  if (diff < 0) return { label: `Overdue by ${Math.abs(mins)}m`, color: RED }
  if (mins < 60) return { label: `${mins}m remaining`, color: AMBER }
  const hrs = Math.round(mins / 60)
  return { label: `${hrs}h remaining`, color: hrs < 4 ? AMBER : GREEN }
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isAgent = msg.direction === 'outbound'
  const isNote = msg.is_internal_note
  const sender = msg.author_user_name || msg.author_name || (isAgent ? 'Agent' : 'Customer')
  return (
    <div style={{ display: 'flex', flexDirection: isAgent ? 'row-reverse' : 'row', gap: SP[2], marginBottom: 14 }}>
      <div style={{
        width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
        background: isAgent ? NAVY : 'var(--chip-bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: TEXT.xs, fontWeight: FW.bold, color: isAgent ? '#fff' : 'var(--txt2)',
      }}>
        {sender.charAt(0).toUpperCase()}
      </div>
      <div style={{ maxWidth: '70%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexDirection: isAgent ? 'row-reverse' : 'row', marginBottom: 3 }}>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{sender}</span>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(msg.created_at)}</span>
          {isNote && (
            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 6px', borderRadius: RADIUS.lg, background: `${AMBER}18`, color: AMBER }}>
              Internal Note
            </span>
          )}
        </div>
        <div style={{
          padding: '10px 14px', borderRadius: RADIUS.lg,
          borderTopLeftRadius: isAgent ? 10 : 2,
          borderTopRightRadius: isAgent ? 2 : 10,
          background: isNote ? `${AMBER}10` : (isAgent ? 'var(--card)' : 'var(--th-bg)'),
          border: `1px solid ${isNote ? `${AMBER}30` : 'var(--bdr)'}`,
          fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {msg.body_text}
        </div>
      </div>
    </div>
  )
}

// ── Detail row helper ─────────────────────────────────────────────────────────

function DetailRow({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: TEXT.base }}>
      <span style={{ color: 'var(--txt2)', minWidth: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--txt)', fontWeight: mono ? 700 : 400, fontFamily: mono ? 'Inter, monospace' : 'inherit' }}>
        {String(value)}
      </span>
    </div>
  )
}

function CallButton({ phone, ticketId }: { phone: string; ticketId?: number }) {
  const [calling, setCalling] = useState(false)
  async function call() {
    setCalling(true)
    try {
      await apiPost('/api/zoho/voice/call', { phone_number: phone, ...(ticketId ? { ticket_id: ticketId } : {}) })
      toast.success(`Calling ${phone}…`)
    } catch (e: any) {
      toast.error(e.message ?? 'Call failed')
    } finally {
      setCalling(false)
    }
  }
  return (
    <button onClick={call} disabled={calling} title={`Call ${phone}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: SP[1],
      padding: '2px 8px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)',
      background: calling ? 'var(--th-bg)' : `${GREEN}12`, color: GREEN,
      fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: calling ? 'wait' : 'pointer',
      verticalAlign: 'middle',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>call</span>
      {calling ? 'Calling…' : 'Call'}
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [data, setData] = useState<TicketDetailResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Enriched context (loaded on CIF availability)
  const [ctx, setCtx] = useState<EnrichedContext | null>(null)
  const [ctxLoading, setCtxLoading] = useState(false)

  // Reply
  const [replyText, setReplyText] = useState('')
  const [replyNote, setReplyNote] = useState(false)
  const [sending, setSending] = useState(false)
  const [replyErr, setReplyErr] = useState<string | null>(null)

  // Context tab
  const [tab, setTab] = useState('customer')

  // KB search
  const [kbQuery, setKbQuery] = useState('')
  const [kbResults, setKbResults] = useState<KBResult[]>([])
  const [kbSearching, setKbSearching] = useState(false)

  // Action modals
  const [transferOpen, setTransferOpen] = useState(false)
  const [escalateOpen, setEscalateOpen] = useState(false)
  const [resolveOpen, setResolveOpen] = useState(false)
  const [ptpOpen, setPtpOpen] = useState(false)
  const [statementOpen, setStatementOpen] = useState(false)
  const [escalateHeadOpen, setEscalateHeadOpen] = useState(false)
  const [disputeOpen, setDisputeOpen] = useState(false)
  const [newAppOpen, setNewAppOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [collectionsEscOpen, setCollectionsEscOpen] = useState(false)

  const [agents, setAgents] = useState<AgentItem[]>([])
  const [transferTarget, setTransferTarget] = useState('')
  const [escalateReason, setEscalateReason] = useState('')
  const [escalateHeadReason, setEscalateHeadReason] = useState('')
  const [ptpAmount, setPtpAmount] = useState('')
  const [ptpDate, setPtpDate] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  // Statement form state
  const [stmtDateFrom, setStmtDateFrom] = useState('')
  const [stmtDateTo, setStmtDateTo] = useState('')
  const [stmtEmail, setStmtEmail] = useState('')

  // Merge state
  const [mergeQuery, setMergeQuery] = useState('')
  const [mergeResults, setMergeResults] = useState<TicketSearchResult[]>([])
  const [mergeSearching, setMergeSearching] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<TicketSearchResult | null>(null)
  const [merging, setMerging] = useState(false)

  const threadEndRef = useRef<HTMLDivElement>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const resp = await apiFetch<TicketDetailResp>(`/api/helpdesk/tickets/${id}`)
      setData(resp)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadContext(cif: string) {
    if (!cif) return
    setCtxLoading(true)
    try {
      const enriched = await apiFetch<EnrichedContext>(`/api/helpdesk/tickets/${id}/context`)
      setCtx(enriched)
    } catch {
      // context enrichment is best-effort
    } finally {
      setCtxLoading(false)
    }
  }

  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [data?.messages])

  useEffect(() => {
    if (data?.ticket?.customer_cif) {
      loadContext(data.ticket.customer_cif)
    }
  }, [data?.ticket?.customer_cif]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if ((transferOpen || escalateOpen) && agents.length === 0) {
      apiFetch<any>('/api/helpdesk/agents')
        .then(r => setAgents(Array.isArray(r) ? r : []))
        .catch(() => setAgents([]))
    }
  }, [transferOpen, escalateOpen, agents.length])

  // KB search (debounced)
  const kbTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchKB = useCallback((q: string) => {
    setKbQuery(q)
    if (kbTimer.current) clearTimeout(kbTimer.current)
    if (!q.trim()) { setKbResults([]); return }
    kbTimer.current = setTimeout(async () => {
      setKbSearching(true)
      try {
        const res = await apiFetch<KBResult[]>(`/api/helpdesk/kb/search?q=${encodeURIComponent(q)}`)
        setKbResults(Array.isArray(res) ? res : [])
      } catch { setKbResults([]) } finally { setKbSearching(false) }
    }, 300)
  }, [])

  // Merge ticket search (debounced)
  const mergeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchMerge = useCallback((q: string) => {
    setMergeQuery(q)
    if (mergeTimer.current) clearTimeout(mergeTimer.current)
    if (!q.trim()) { setMergeResults([]); return }
    mergeTimer.current = setTimeout(async () => {
      setMergeSearching(true)
      try {
        const data = await apiFetch<any>(`/api/helpdesk/tickets/search?q=${encodeURIComponent(q)}&limit=5`)
        const res: TicketSearchResult[] = Array.isArray(data) ? data : (data.tickets ?? [])
        setMergeResults(res.filter(t => String(t.id) !== id))
      } catch { setMergeResults([]) } finally { setMergeSearching(false) }
    }, 300)
  }, [id])

  async function sendReply() {
    if (!replyText.trim()) return
    setSending(true)
    setReplyErr(null)
    try {
      await apiPost(`/api/helpdesk/tickets/${id}/messages`, {
        body_text: replyText,
        is_internal_note: replyNote,
      })
      setReplyText('')
      setReplyNote(false)
      await load()
    } catch (e: any) {
      setReplyErr(e.message)
    } finally {
      setSending(false)
    }
  }

  async function updateStatus(newStatus: string) {
    setActionLoading(true)
    try {
      await apiFetch(`/api/helpdesk/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      await load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleTransfer() {
    if (!transferTarget) return
    setActionLoading(true)
    try {
      await apiFetch(`/api/helpdesk/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ assigned_to: Number(transferTarget) }),
      })
      setTransferOpen(false)
      setTransferTarget('')
      toast.success('Ticket transferred')
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleEscalate() {
    if (!escalateReason.trim()) return
    setActionLoading(true)
    try {
      await apiPost(`/api/helpdesk/tickets/${id}/messages`, {
        body_text: `[ESCALATED] ${escalateReason}`,
        is_internal_note: true,
      })
      await apiFetch(`/api/helpdesk/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'in_progress', priority: 'urgent' }),
      })
      setEscalateOpen(false)
      setEscalateReason('')
      toast.success('Ticket escalated')
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleClaimTicket() {
    setActionLoading(true)
    try {
      await apiPost(`/api/helpdesk/tickets/${id}/claim`, {})
      toast.success('Ticket assigned to you')
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleLogPTP() {
    if (!ptpAmount || !ptpDate) return
    setActionLoading(true)
    try {
      const cif = data?.ticket?.customer_cif
      // Post internal note on the ticket
      await apiPost(`/api/helpdesk/tickets/${id}/messages`, {
        body_text: `[Promise Logged] Amount: ₦${ptpAmount} — Date: ${ptpDate}`,
        is_internal_note: true,
      })
      // Also create a real promise in Collections if CIF is available
      if (cif) {
        try {
          await apiPost('/api/collections/promises', {
            cif_number: cif,
            customer_name: data?.ticket?.customer_name ?? '',
            promise_amount_kobo: Math.round(parseFloat(ptpAmount) * 100),
            promise_date: ptpDate,
            source: 'helpdesk',
            source_ticket_id: Number(id),
            notes: `Logged from ticket #${data?.ticket?.ticket_ref ?? id}`,
          })
        } catch {
          // Collections promise creation is best-effort — ticket note already posted
        }
      }
      setPtpOpen(false)
      setPtpAmount('')
      setPtpDate('')
      toast.success('Promise logged')
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRaiseDispute() {
    setActionLoading(true)
    try {
      await apiPost('/api/cards/disputes', {
        cif_number: data?.ticket?.customer_cif,
        customer_name: data?.ticket?.customer_name,
        source_ticket_id: Number(id),
        source_ticket_ref: data?.ticket?.ticket_ref,
        notes: `Raised from helpdesk ticket #${data?.ticket?.ticket_ref ?? id}`,
      })
      await apiPost(`/api/helpdesk/tickets/${id}/messages`, {
        body_text: '[Dispute Raised] Card dispute case created in Cards Ops.',
        is_internal_note: true,
      })
      setDisputeOpen(false)
      toast.success('Card dispute raised')
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleEscalateCollections() {
    setActionLoading(true)
    try {
      await apiPost(`/api/helpdesk/tickets/${id}/messages`, {
        body_text: '[Escalated to Collections] This ticket has been escalated to the Collections team.',
        is_internal_note: true,
      })
      await apiFetch(`/api/helpdesk/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ queue: 'collections', priority: 'high' }),
      })
      setCollectionsEscOpen(false)
      toast.success('Escalated to Collections queue')
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleMerge() {
    if (!mergeTarget) return
    setMerging(true)
    try {
      await apiPost(`/api/helpdesk/tickets/${id}/merge`, {
        target_ticket_id: mergeTarget.id,
      })
      setMergeOpen(false)
      setMergeTarget(null)
      setMergeQuery('')
      setMergeResults([])
      toast.success(`Merged into #${mergeTarget.ticket_ref}`)
      navigate(`/helpdesk/${mergeTarget.id}`)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setMerging(false)
    }
  }

  function insertKBArticle(article: KBResult) {
    const snippet = article.body_text
      ? `${article.title}\n\n${article.body_text}`
      : article.title
    setReplyText(prev => prev ? `${prev}\n\n${snippet}` : snippet)
    setKbQuery('')
    setKbResults([])
    toast.success(`Article "${article.title}" inserted`)
  }

  if (loading) {
    return (
      <Page title="Ticket Detail">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spinner size={32} />
        </div>
      </Page>
    )
  }

  if (err || !data) {
    return (
      <Page title="Ticket Detail">
        <ErrBanner error={err ?? 'Ticket not found'} onRetry={load} />
      </Page>
    )
  }

  const { ticket, messages } = data
  const sla = slaLabel(ticket.sla_due_at)
  const prColor = PRIORITY_COLOR[ticket.priority?.toLowerCase()] ?? 'var(--chart-lbl)'

  // ── Modal footer helper ──────────────────────────────────────────────────────
  const ModalFooter = ({ onConfirm, label, disabled, danger }: { onConfirm: () => void; label: string; disabled?: boolean; danger?: boolean }) => (
    <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
      <button onClick={() => { setTransferOpen(false); setEscalateOpen(false); setPtpOpen(false); setStatementOpen(false); setEscalateHeadOpen(false); setDisputeOpen(false); setNewAppOpen(false); setMergeOpen(false); setCollectionsEscOpen(false) }}
        style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
        Cancel
      </button>
      <button onClick={onConfirm} disabled={disabled || actionLoading}
        style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: danger ? RED : NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', opacity: (disabled || actionLoading) ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        {actionLoading && <Spinner size={14} color="#fff" />}
        {label}
      </button>
    </div>
  )

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 38, padding: '0 12px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  return (
    <Page
      title={`Ticket #${ticket.ticket_ref || ticket.id}`}
      subtitle={`Customer Service → Ticket #${ticket.ticket_ref || ticket.id}`}
      actions={
        <button onClick={() => navigate('/helpdesk/tickets')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 13px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>arrow_back</span>
          Back to Queue
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'flex', gap: SP[4], height: '100%', minHeight: 0 }}>

        {/* ── Left: Conversation ───────────────────────────────────────────── */}
        <div style={{ flex: '0 0 58%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <SectionCard padding={false} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Ticket header */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt2)', fontFamily: 'Inter, monospace' }}>
                  #{ticket.ticket_ref || ticket.id}
                </span>
                {ticket.ticket_type && (
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                    {ticket.ticket_type}
                  </span>
                )}
                <StatusBadge status={ticket.status} />
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: prColor }} title={ticket.priority} />
                <span style={{ fontSize: TEXT.sm, color: sla.color, fontWeight: FW.semibold }}>{sla.label}</span>
              </div>
              <h2 style={{ margin: '6px 0 0', fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1.3 }}>
                {ticket.subject}
              </h2>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 6, marginTop: SP[3], flexWrap: 'wrap' }}>
                {['open','in_progress','pending'].includes(ticket.status) && (
                  <button onClick={() => setResolveOpen(true)}
                    style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>check_circle</span>
                    Resolve
                  </button>
                )}
                <button onClick={() => setTransferOpen(true)}
                  style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>swap_horiz</span>
                  Transfer
                </button>
                <button onClick={() => setEscalateOpen(true)}
                  style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: `1px solid ${AMBER}50`, background: `${AMBER}10`, color: AMBER, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>priority_high</span>
                  Escalate
                </button>
                <button onClick={handleClaimTicket} disabled={actionLoading}
                  style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>person_add</span>
                  Assign to Me
                </button>
                <button onClick={() => setMergeOpen(true)}
                  style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>merge</span>
                  Merge
                </button>
              </div>
            </div>

            {/* Message thread */}
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 18px' }}>
              {messages.length === 0 ? (
                <p style={{ color: 'var(--txt2)', fontSize: TEXT.base, textAlign: 'center', marginTop: 40 }}>No messages yet.</p>
              ) : (
                messages.map(m => <MessageBubble key={m.id} msg={m} />)
              )}
              <div ref={threadEndRef} />
            </div>

            {/* Reply area */}
            <div style={{ borderTop: '1px solid var(--bdr)', padding: '14px 18px', flexShrink: 0 }}>
              <ErrBanner error={replyErr} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: SP[2] }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.sm, color: 'var(--txt2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={replyNote} onChange={e => setReplyNote(e.target.checked)} style={{ accentColor: AMBER }} />
                  Internal note
                </label>
              </div>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                placeholder={replyNote ? 'Write internal note…' : 'Write a reply…'}
                rows={3}
                style={{
                  width: '100%', resize: 'vertical', padding: '10px 12px',
                  border: `1px solid ${replyNote ? `${AMBER}50` : 'var(--input-bdr)'}`,
                  borderRadius: RADIUS.md, fontSize: TEXT.base, lineHeight: 1.5,
                  background: replyNote ? `${AMBER}08` : 'var(--input-bg)',
                  color: 'var(--txt)', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
                }}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply() }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: SP[2] }}>
                <button onClick={sendReply} disabled={!replyText.trim() || sending}
                  style={{
                    padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff',
                    fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (!replyText.trim() || sending) ? 'not-allowed' : 'pointer',
                    opacity: (!replyText.trim() || sending) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: SP[2],
                  }}>
                  {sending && <Spinner size={14} color="#fff" />}
                  Send Reply
                </button>
              </div>
            </div>
          </SectionCard>
        </div>

        {/* ── Right: Context + Actions ─────────────────────────────────────── */}
        <div style={{ flex: '0 0 42%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Customer context */}
          <SectionCard title="Context" padding={false}>
            <div style={{ padding: '0 18px 4px' }}>
              <Tabs
                tabs={[
                  { key: 'customer', label: 'Customer' },
                  { key: 'loans', label: 'Loans' },
                  { key: 'fd', label: 'FDs' },
                  { key: 'transactions', label: 'Transactions' },
                  { key: 'collections', label: 'Collections' },
                  { key: 'cards', label: 'Cards' },
                ]}
                active={tab}
                onChange={setTab}
              />
            </div>
            <div style={{ padding: '0 18px 18px' }}>
              {ctxLoading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: SP[5] }}>
                  <Spinner size={20} />
                </div>
              )}
              {!ctxLoading && tab === 'customer' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <DetailRow label="Name" value={ticket.customer_name} />
                  {ticket.customer_phone ? (
                    <div style={{ display: 'flex', gap: 10, fontSize: TEXT.base, alignItems: 'center' }}>
                      <span style={{ color: 'var(--txt2)', minWidth: 110, flexShrink: 0 }}>Phone</span>
                      <span style={{ color: 'var(--txt)', display: 'flex', alignItems: 'center', gap: SP[2] }}>
                        {ticket.customer_phone}
                        <CallButton phone={ticket.customer_phone} ticketId={ticket.id} />
                      </span>
                    </div>
                  ) : null}
                  <DetailRow label="Email" value={ticket.customer_email} />
                  <DetailRow label="CIF" value={ticket.customer_cif} mono />
                  {ticket.customer_cif && (
                    <button
                      onClick={() => navigate(`/contacts/${ticket.customer_cif}`)}
                      style={{ marginTop: SP[1], padding: '5px 12px', borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>person</span>
                      Full profile →
                    </button>
                  )}
                  <DetailRow label="Account Status" value={ctx?.cif ? 'Active' : undefined} />
                  <DetailRow label="Other Open Tickets" value={ctx?.other_open_tickets !== undefined ? String(ctx.other_open_tickets) : undefined} />
                  {!ticket.customer_name && !ticket.customer_phone && (
                    <p style={{ color: 'var(--txt2)', fontSize: TEXT.base, margin: 0 }}>No customer information available.</p>
                  )}
                </div>
              )}
              {!ctxLoading && tab === 'loans' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
                  {(!ctx?.loans || ctx.loans.length === 0) ? (
                    <p style={{ color: 'var(--txt2)', fontSize: TEXT.base, margin: 0 }}>
                      {ticket.customer_cif ? 'No active loans for this customer.' : 'No CIF — loan data unavailable.'}
                    </p>
                  ) : ctx.loans.map((l, i) => (
                    <div key={i} style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY, fontFamily: 'Inter, monospace' }}>{l.loan_ref ?? 'Loan'}</span>
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.lg, background: `${BLUE}15`, color: BLUE }}>{l.status}</span>
                      </div>
                      <div style={{ display: 'flex', gap: SP[4], fontSize: TEXT.sm }}>
                        <div>
                          <div style={{ color: 'var(--txt2)' }}>Outstanding</div>
                          <div style={{ fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtKobo(l.total_outstanding_kobo ?? 0)}</div>
                        </div>
                        {(l.dpd ?? 0) > 0 && (
                          <div>
                            <div style={{ color: 'var(--txt2)' }}>DPD</div>
                            <div style={{ fontWeight: FW.bold, color: (l.dpd ?? 0) > 30 ? RED : AMBER }}>{l.dpd} days</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!ctxLoading && tab === 'fd' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
                  {(!ctx?.fixed_deposits || ctx.fixed_deposits.length === 0) ? (
                    <p style={{ color: 'var(--txt2)', fontSize: TEXT.base, margin: 0 }}>
                      {ticket.customer_cif ? 'No fixed deposits for this customer.' : 'No CIF — FD data unavailable.'}
                    </p>
                  ) : ctx.fixed_deposits.map((fd, i) => (
                    <div key={i} style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtKobo(fd.principal_kobo ?? 0)}</span>
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.lg, background: `${GREEN}15`, color: GREEN }}>{fd.status}</span>
                      </div>
                      <div style={{ display: 'flex', gap: SP[4], fontSize: TEXT.sm }}>
                        <div><div style={{ color: 'var(--txt2)' }}>Rate</div><div style={{ fontWeight: FW.semibold }}>{fd.interest_rate}%</div></div>
                        <div><div style={{ color: 'var(--txt2)' }}>Tenor</div><div style={{ fontWeight: FW.semibold }}>{fd.tenor_days}d</div></div>
                        {fd.maturity_date && <div><div style={{ color: 'var(--txt2)' }}>Matures</div><div style={{ fontWeight: FW.semibold }}>{fd.maturity_date.slice(0, 10)}</div></div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!ctxLoading && tab === 'transactions' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(!ctx?.recent_transactions || ctx.recent_transactions.length === 0) ? (
                    <p style={{ color: 'var(--txt2)', fontSize: TEXT.base, margin: 0 }}>
                      {ticket.customer_cif ? 'No recent transactions found.' : 'No CIF — transaction data unavailable.'}
                    </p>
                  ) : ctx.recent_transactions.map((t, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: i < ctx.recent_transactions!.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                      <div>
                        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{t.description ?? t.transaction_type}</div>
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{t.transaction_date ? t.transaction_date.slice(0, 10) : ''}</div>
                      </div>
                      <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: (t.transaction_type ?? '').toLowerCase().includes('debit') ? RED : GREEN }}>
                        {fmtKobo(t.amount_kobo ?? 0)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!ctxLoading && tab === 'collections' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  {(!ctx?.collections_history || ctx.collections_history.length === 0) ? (
                    <p style={{ color: 'var(--txt2)', fontSize: TEXT.base, margin: 0 }}>
                      {ticket.customer_cif ? 'No collections history.' : 'No CIF — collections data unavailable.'}
                    </p>
                  ) : ctx.collections_history.map((p, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: i < ctx.collections_history!.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                      <div>
                        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{fmtKobo(p.promise_amount_kobo ?? 0)}</div>
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{p.promise_date ? `Promise date: ${p.promise_date.slice(0, 10)}` : ''}</div>
                      </div>
                      <span style={{
                        fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.lg,
                        background: p.ptp_status === 'kept' ? `${GREEN}15` : p.ptp_status === 'broken' ? `${RED}15` : `${AMBER}15`,
                        color: p.ptp_status === 'kept' ? GREEN : p.ptp_status === 'broken' ? RED : AMBER,
                      }}>
                        {p.ptp_status ?? 'pending'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {!ctxLoading && tab === 'cards' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  {(!ctx?.cards || ctx.cards.length === 0) ? (
                    <p style={{ color: 'var(--txt2)', fontSize: TEXT.base, margin: 0 }}>
                      {ticket.customer_cif ? 'No card products for this customer.' : 'No CIF — card data unavailable.'}
                    </p>
                  ) : ctx.cards.map((c, i) => (
                    <div key={i} style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{c.product_name ?? 'Card'}</span>
                        {c.account_status && (
                          <span style={{
                            fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.lg,
                            background: c.account_status.toLowerCase() === 'active' ? `${GREEN}15` : `${AMBER}15`,
                            color: c.account_status.toLowerCase() === 'active' ? GREEN : AMBER,
                          }}>{c.account_status}</span>
                        )}
                      </div>
                      {c.name_on_card && (
                        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Name on card: <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{c.name_on_card}</span></div>
                      )}
                      {c.account_manager && (
                        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>AM: <span style={{ color: 'var(--txt)' }}>{c.account_manager}</span></div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SectionCard>

          {/* Quick actions */}
          <SectionCard title="Quick Actions">
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {[
                { label: 'Log Promise', icon: 'handshake', color: BLUE, onClick: () => setPtpOpen(true) },
                { label: 'Request Statement', icon: 'description', color: BLUE, onClick: () => {
                  const today = new Date().toISOString().slice(0, 10)
                  const from90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
                  setStmtDateFrom(from90)
                  setStmtDateTo(today)
                  setStmtEmail(ticket.customer_email ?? '')
                  setStatementOpen(true)
                }},
                { label: 'Raise Card Dispute', icon: 'credit_card_off', color: AMBER, onClick: () => setDisputeOpen(true) },
                { label: 'Escalate to Collections', icon: 'collections_bookmark', color: AMBER, onClick: () => setCollectionsEscOpen(true) },
                { label: 'Create New Application', icon: 'add_circle', color: GREEN, onClick: () => setNewAppOpen(true) },
                { label: 'Escalate to Head', icon: 'supervisor_account', color: RED, onClick: () => setEscalateHeadOpen(true) },
              ].map(a => (
                <button key={a.label} onClick={a.onClick}
                  style={{
                    width: '100%', padding: '8px 14px', border: `1px solid ${a.color}20`,
                    borderRadius: RADIUS.md, background: `${a.color}06`, color: 'var(--txt)',
                    fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: SP[2], textAlign: 'left',
                  }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: a.color }}>{a.icon}</span>
                  {a.label}
                </button>
              ))}
            </div>
          </SectionCard>

          {/* KB search */}
          <SectionCard title="Knowledge Base">
            <div>
              <div style={{ position: 'relative' }}>
                <input
                  value={kbQuery}
                  onChange={e => searchKB(e.target.value)}
                  placeholder="Search articles…"
                  style={{ ...inputStyle, paddingLeft: 36 }}
                />
                <span className="material-symbols-rounded" style={{ position: 'absolute', left: 10, top: 9, fontSize: TEXT.lg, color: 'var(--txt3)' }}>search</span>
                {kbSearching && <span style={{ position: 'absolute', right: 10, top: 11 }}><Spinner size={14} /></span>}
              </div>
              {kbResults.length > 0 && (
                <div style={{ marginTop: SP[2], border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
                  {kbResults.map((a, i) => (
                    <div key={a.id} style={{
                      padding: '9px 12px', cursor: 'pointer',
                      borderBottom: i < kbResults.length - 1 ? '1px solid var(--bdr)' : 'none',
                      background: 'var(--th-bg)',
                    }}
                      onClick={() => insertKBArticle(a)}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--th-bg)'}
                    >
                      <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: NAVY }}>{a.title}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{a.category} · Click to insert into reply</div>
                    </div>
                  ))}
                </div>
              )}
              {kbQuery && !kbSearching && kbResults.length === 0 && (
                <p style={{ fontSize: TEXT.sm, color: 'var(--txt3)', marginTop: SP[2] }}>No articles found for "{kbQuery}"</p>
              )}
            </div>
          </SectionCard>
        </div>
      </div>

      {/* ── Resolve confirm ─────────────────────────────────────────────────── */}
      <ConfirmModal
        open={resolveOpen}
        title="Resolve Ticket"
        body={`Mark ticket #${ticket.ticket_ref || ticket.id} as resolved? A CSAT survey will be sent to the customer.`}
        confirmLabel="Resolve"
        loading={actionLoading}
        onConfirm={async () => { await updateStatus('resolved'); setResolveOpen(false) }}
        onClose={() => setResolveOpen(false)}
      />

      {/* ── Transfer ────────────────────────────────────────────────────────── */}
      <Modal open={transferOpen} onClose={() => { setTransferOpen(false); setTransferTarget('') }} title="Transfer Ticket" width={400}
        footer={<ModalFooter onConfirm={handleTransfer} label="Transfer" disabled={!transferTarget} />}>
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', margin: '0 0 12px' }}>Select the agent to transfer this ticket to.</p>
        <select value={transferTarget} onChange={e => setTransferTarget(e.target.value)} style={{ ...inputStyle, height: 38 }}>
          <option value="">— Select agent —</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
      </Modal>

      {/* ── Escalate ────────────────────────────────────────────────────────── */}
      <Modal open={escalateOpen} onClose={() => { setEscalateOpen(false); setEscalateReason('') }} title="Escalate Ticket" width={440}
        footer={<ModalFooter onConfirm={handleEscalate} label="Escalate" disabled={!escalateReason.trim()} />}>
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', margin: '0 0 12px' }}>Provide a reason. This will be logged as an internal note and the ticket priority set to Urgent.</p>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={escalateReason} onChange={e => setEscalateReason(e.target.value)} rows={4} placeholder="Escalation reason…"
          style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }} />
      </Modal>

      {/* ── Log Promise ──────────────────────────────────────────────────────── */}
      <Modal open={ptpOpen} onClose={() => { setPtpOpen(false); setPtpAmount(''); setPtpDate('') }} title="Log Promise to Pay" width={420}
        footer={<ModalFooter onConfirm={handleLogPTP} label="Log Promise" disabled={!ptpAmount || !ptpDate} />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Promise Amount (₦)</label>
            <input type="number" placeholder="e.g. 50000" value={ptpAmount} onChange={e => setPtpAmount(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Promise Date</label>
            <input type="date" value={ptpDate} onChange={e => setPtpDate(e.target.value)} style={inputStyle} />
          </div>
          {ticket.customer_cif && (
            <p style={{ fontSize: TEXT.sm, color: GREEN, margin: 0 }}>
              ✓ Will also create a promise in Collections for CIF {ticket.customer_cif}
            </p>
          )}
        </div>
      </Modal>

      {/* ── Request Statement ────────────────────────────────────────────────── */}
      <Modal open={statementOpen} onClose={() => setStatementOpen(false)} title="Send Account Statement" width={420}
        footer={
          <div style={{ display: 'flex', gap: 10 }}>
            <button disabled={actionLoading || !stmtEmail || !stmtDateFrom || !stmtDateTo || !ticket.customer_cif}
              onClick={async () => {
                if (!ticket.customer_cif) { toast.error('No CIF — cannot generate statement'); return }
                setActionLoading(true)
                try {
                  await apiPost('/api/statements/send', {
                    cif: ticket.customer_cif,
                    date_from: stmtDateFrom,
                    date_to: stmtDateTo,
                    recipient_email: stmtEmail,
                    subject: `Account Statement — ${ticket.customer_name ?? ticket.customer_cif}`,
                    message: `Requested via helpdesk ticket ${ticket.ticket_ref ?? id}.`,
                  })
                  await apiPost(`/api/helpdesk/tickets/${id}/messages`, {
                    body_text: `[Statement Sent] Account statement (${stmtDateFrom} – ${stmtDateTo}) emailed to ${stmtEmail}.`,
                    is_internal_note: true,
                  })
                  setStatementOpen(false)
                  toast.success('Statement sent')
                  await load()
                } catch (e: any) { toast.error(e.message) } finally { setActionLoading(false) }
              }}
              style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: actionLoading ? 'wait' : 'pointer', opacity: actionLoading ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              {actionLoading && <Spinner size={13} color="#fff" />}
              Send Statement
            </button>
            <button onClick={() => setStatementOpen(false)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: TEXT.base }}>
          {!ticket.customer_cif && (
            <p style={{ color: AMBER, margin: 0, fontSize: TEXT.sm }}>No CIF on this ticket — statement cannot be generated without a CIF.</p>
          )}
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: SP[1] }}>Recipient Email</label>
            <input type="email" value={stmtEmail} onChange={e => setStmtEmail(e.target.value)} placeholder="customer@email.com"
              style={{ width: '100%', height: 36, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: SP[1] }}>Date From</label>
              <input type="date" value={stmtDateFrom} onChange={e => setStmtDateFrom(e.target.value)}
                style={{ width: '100%', height: 36, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: SP[1] }}>Date To</label>
              <input type="date" value={stmtDateTo} onChange={e => setStmtDateTo(e.target.value)}
                style={{ width: '100%', height: 36, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
          </div>
        </div>
      </Modal>

      {/* ── Raise Card Dispute ───────────────────────────────────────────────── */}
      <ConfirmModal open={disputeOpen} title="Raise Card Dispute"
        body={`Create a card dispute case for ${ticket.customer_name ?? 'this customer'}? This will open a dispute in Cards Ops and log a note on this ticket.`}
        confirmLabel="Raise Dispute" loading={actionLoading}
        onConfirm={handleRaiseDispute}
        onClose={() => setDisputeOpen(false)}
      />

      {/* ── Escalate to Collections ──────────────────────────────────────────── */}
      <ConfirmModal open={collectionsEscOpen} title="Escalate to Collections"
        body="Move this ticket to the Collections queue? Priority will be set to High and an internal note logged."
        confirmLabel="Escalate" loading={actionLoading}
        onConfirm={handleEscalateCollections}
        onClose={() => setCollectionsEscOpen(false)}
      />

      {/* ── New Application ──────────────────────────────────────────────────── */}
      <ConfirmModal open={newAppOpen} title="Create New Application"
        body={`Open a new credit application for ${ticket.customer_name ?? 'this customer'}${ticket.customer_cif ? ` (CIF: ${ticket.customer_cif})` : ''}? You will be taken to the credit application form.`}
        confirmLabel="Open LOS" loading={false}
        onConfirm={() => {
          setNewAppOpen(false)
          const qs = ticket.customer_cif ? `?cif=${ticket.customer_cif}` : ''
          navigate(`/los/new${qs}`)
        }}
        onClose={() => setNewAppOpen(false)}
      />

      {/* ── Escalate to Head ────────────────────────────────────────────────── */}
      <Modal open={escalateHeadOpen} onClose={() => { setEscalateHeadOpen(false); setEscalateHeadReason('') }} title="Escalate to Head" width={440}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setEscalateHeadOpen(false)}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
              Cancel
            </button>
            <button
              onClick={async () => {
                setActionLoading(true)
                try {
                  await apiPost(`/api/helpdesk/tickets/${id}/messages`, {
                    body_text: `[ESCALATED TO HEAD] ${escalateHeadReason}`,
                    is_internal_note: true,
                  })
                  await apiFetch(`/api/helpdesk/tickets/${id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ priority: 'urgent' }),
                  })
                  setEscalateHeadOpen(false)
                  setEscalateHeadReason('')
                  toast.success('Escalated to head')
                  await load()
                } catch (e: any) { toast.error(e.message) } finally { setActionLoading(false) }
              }}
              disabled={actionLoading}
              style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: SP[2], opacity: actionLoading ? 0.6 : 1 }}>
              {actionLoading && <Spinner size={14} color="#fff" />}
              Escalate
            </button>
          </div>
        }
      >
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', margin: '0 0 12px' }}>Provide a reason for escalating to the head of customer service.</p>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={escalateHeadReason} onChange={e => setEscalateHeadReason(e.target.value)} rows={4} placeholder="Reason…"
          style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }} />
      </Modal>

      {/* ── Merge ───────────────────────────────────────────────────────────── */}
      <Modal open={mergeOpen} onClose={() => { setMergeOpen(false); setMergeTarget(null); setMergeQuery(''); setMergeResults([]) }}
        title="Merge Ticket" width={500}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setMergeOpen(false)}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleMerge} disabled={!mergeTarget || merging}
              style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: SP[2], opacity: (!mergeTarget || merging) ? 0.6 : 1 }}>
              {merging && <Spinner size={14} color="#fff" />}
              Merge into Selected
            </button>
          </div>
        }
      >
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', margin: '0 0 12px' }}>
          Search for the ticket to merge <strong>#{ticket.ticket_ref || id}</strong> into. All messages will move to the target ticket; this ticket will be closed as "Merged".
        </p>
        <div style={{ position: 'relative', marginBottom: SP[3] }}>
          <input
            value={mergeQuery}
            onChange={e => searchMerge(e.target.value)}
            placeholder="Search by ref or subject…"
            style={{ ...inputStyle, paddingLeft: 36 }}
          />
          <span className="material-symbols-rounded" style={{ position: 'absolute', left: 10, top: 9, fontSize: TEXT.lg, color: 'var(--txt3)' }}>search</span>
          {mergeSearching && <span style={{ position: 'absolute', right: 10, top: 11 }}><Spinner size={14} /></span>}
        </div>
        {mergeResults.length > 0 && (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden', marginBottom: SP[3] }}>
            {mergeResults.map((t, i) => (
              <div key={t.id}
                onClick={() => setMergeTarget(t)}
                style={{
                  padding: '10px 14px', cursor: 'pointer',
                  borderBottom: i < mergeResults.length - 1 ? '1px solid var(--bdr)' : 'none',
                  background: mergeTarget?.id === t.id ? `${NAVY}08` : 'var(--card)',
                  borderLeft: mergeTarget?.id === t.id ? `3px solid ${NAVY}` : '3px solid transparent',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY, fontFamily: 'Inter, monospace' }}>#{t.ticket_ref}</span>
                  <StatusBadge status={t.status} />
                </div>
                <div style={{ fontSize: TEXT.base, color: 'var(--txt)', marginTop: 2 }}>{t.subject}</div>
              </div>
            ))}
          </div>
        )}
        {mergeTarget && (
          <div style={{ padding: '10px 14px', background: `${NAVY}08`, borderRadius: RADIUS.md, border: `1px solid ${NAVY}20` }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>
              Selected: #{mergeTarget.ticket_ref} — {mergeTarget.subject}
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>
              This ticket's messages will be moved there. This ticket will be closed.
            </div>
          </div>
        )}
      </Modal>
    </Page>
  )
}
