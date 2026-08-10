import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, StatusBadge, Tabs, Modal, ConfirmModal, Spinner, ErrBanner, Avatar,
} from '../../components/UI'
import { Conversation } from './Conversation'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtKobo } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, PURPLE, NAVY, FW, RADIUS, SP, TEXT, MONO, SHADOW } from '../../lib/design'
import { toast } from 'sonner'

// ── "Alive & connected" visual layer ────────────────────────────────────────────
// One injected stylesheet powers the motion (messages animate in, cards lift on
// hover, the live dot pulses) shared across the ticket surfaces.
const HD_STYLE = `
@keyframes hdMsgIn { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: none; } }
@keyframes hdPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.8); } }
@keyframes hdFadeIn { from { opacity: 0; } to { opacity: 1; } }
.hd-msg { animation: hdMsgIn .28s cubic-bezier(.22,1,.36,1) both; }
.hd-lift { transition: transform .18s cubic-bezier(.22,1,.36,1), box-shadow .18s, border-color .18s; }
.hd-lift:hover { transform: translateY(-2px); box-shadow: ${'var(--shadow-md)'}; }
.hd-press { transition: transform .1s ease, filter .15s ease; }
.hd-press:active { transform: scale(.96); }
.hd-press:hover { filter: brightness(1.06); }
.hd-live { width: 7px; height: 7px; border-radius: 50%; animation: hdPulse 1.8s ease-in-out infinite; }
.hd-fade { animation: hdFadeIn .4s ease both; }
`

// Each channel gets a signature accent that threads through the header bar, the
// avatar ring and the badges — visually tying a conversation to its source.
const CHANNEL_ACCENT: Record<string, string> = {
  web: BLUE, chat: BLUE, portal: BLUE, social: PURPLE, whatsapp: GREEN,
  email: AMBER, phone: GREEN, voice: GREEN, sms: '#0891B2', zoho: NAVY,
}
const channelAccent = (c?: string) => CHANNEL_ACCENT[(c ?? '').toLowerCase()] ?? NAVY

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
  sender_name?: string
  body_text: string
  is_internal_note?: boolean
  created_at: string
  _opening?: boolean
}

interface Ticket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority: string
  channel: string
  ticket_type?: string
  description?: string
  customer_name?: string
  customer_email?: string
  customer_phone?: string
  customer_cif?: string
  assigned_to?: number
  assigned_to_name?: string
  zoho_assignee_name?: string
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

// ── Priority + channel meta ────────────────────────────────────────────────────

const TERMINAL_STATUSES = ['closed', 'resolved', 'merged', 'cancelled']
const isTerminal = (s?: string) => TERMINAL_STATUSES.includes((s ?? '').toLowerCase())

function priorityMeta(p?: string): { label: string; color: string } {
  const k = (p ?? '').toLowerCase()
  const color = PRIORITY_COLOR[k] ?? 'var(--chart-lbl)'
  const label = k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Normal'
  return { label, color }
}

const CHANNEL_ICON: Record<string, string> = {
  email: 'mail', phone: 'call', voice: 'call', whatsapp: 'chat', sms: 'sms',
  web: 'language', chat: 'forum', portal: 'language', zoho: 'headset_mic', social: 'public',
}
const channelIcon = (c?: string) => CHANNEL_ICON[(c ?? '').toLowerCase()] ?? 'confirmation_number'

// Small labelled meta cell for the ticket header strip
function MetaItem({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>{icon}</span>
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{label}</span>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {children}
      </span>
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────────────────────

// Message rendering (opening request + bubbles + inline media) is shared with the
// Ticket Queue side-preview via ./Conversation.

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
  const threadRef = useRef<HTMLDivElement>(null)

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

  async function loadContext() {
    setCtxLoading(true)
    try {
      // The endpoint resolves a CIF from phone/email when the ticket has none.
      const enriched = await apiFetch<EnrichedContext>(`/api/helpdesk/tickets/${id}/context`)
      setCtx(enriched)
    } catch {
      // context enrichment is best-effort
    } finally {
      setCtxLoading(false)
    }
  }

  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll only the thread container to its latest message — never the page
  // (scrollIntoView would drag the whole page down and open it mid-scroll).
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data?.messages])

  useEffect(() => {
    if (data?.ticket) loadContext()
  }, [data?.ticket?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
      // A customer-facing reply on a closed/resolved ticket reopens it.
      if (!replyNote && isTerminal(data?.ticket?.status)) {
        try {
          await apiFetch(`/api/helpdesk/tickets/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'open' }),
          })
          toast.success('Reply sent — ticket reopened')
        } catch { /* reply already saved; status change is best-effort */ }
      }
      setReplyText('')
      setReplyNote(false)
      await load()
    } catch (e: any) {
      setReplyErr(e.message)
    } finally {
      setSending(false)
    }
  }

  async function handleReopen() {
    setActionLoading(true)
    try {
      await apiFetch(`/api/helpdesk/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'open' }),
      })
      toast.success('Ticket reopened')
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
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
      // Also record a real promise in the Collections book when we have a CIF.
      let reachedCollections = false
      if (cif) {
        try {
          await apiPost(`/api/helpdesk/tickets/${id}/promise`, {
            amount_kobo: Math.round(parseFloat(ptpAmount) * 100),
            promise_date: ptpDate,
          })
          reachedCollections = true
        } catch {
          // Best-effort — the ticket note is already posted either way.
        }
      }
      setPtpOpen(false)
      setPtpAmount('')
      setPtpDate('')
      toast.success(reachedCollections ? 'Promise logged & sent to Collections' : 'Promise logged on ticket')
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
  const priority = priorityMeta(ticket.priority)
  const terminal = isTerminal(ticket.status)
  const accent = channelAccent(ticket.channel)
  // CIF may be resolved from phone/email by the context endpoint even when the
  // ticket has none stored — use it for the profile link and context.
  const linkedCif = ticket.customer_cif || ctx?.cif || ''
  const cifResolved = !ticket.customer_cif && !!ctx?.cif

  // ── Modal footer helper ──────────────────────────────────────────────────────
  const ModalFooter = ({ onConfirm, label, disabled, danger }: { onConfirm: () => void; label: string; disabled?: boolean; danger?: boolean }) => (
    <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
      <button onClick={() => { setTransferOpen(false); setEscalateOpen(false); setPtpOpen(false); setStatementOpen(false); setEscalateHeadOpen(false); setDisputeOpen(false); setNewAppOpen(false); setMergeOpen(false); setCollectionsEscOpen(false) }}
        style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
        Cancel
      </button>
      <button className="hd-press" onClick={onConfirm} disabled={disabled || actionLoading}
        style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: danger ? RED : NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', opacity: (disabled || actionLoading) ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: SP[2], boxShadow: SHADOW.sm }}>
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
      <style>{HD_STYLE}</style>
      <ErrBanner error={err} onRetry={load} />

      <div className="hd-fade" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: SP[4], alignItems: 'start' }}>

        {/* ── Left: Conversation ───────────────────────────────────────────── */}
        <div style={{ minWidth: 0 }}>
          <SectionCard padding={false} style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Ticket header — channel-accented hero */}
            <div style={{
              padding: '16px 18px', borderBottom: '1px solid var(--bdr)', flexShrink: 0,
              borderTop: `3px solid ${accent}`,
              background: `linear-gradient(180deg, ${accent}0C 0%, transparent 70%)`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.bold, color: accent, fontFamily: MONO, background: `${accent}16`, padding: '2px 9px', borderRadius: RADIUS.md }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{channelIcon(ticket.channel)}</span>
                  #{ticket.ticket_ref || ticket.id}
                </span>
                {ticket.ticket_type && (
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                    {ticket.ticket_type}
                  </span>
                )}
                <StatusBadge status={ticket.status} />
                {/* Labelled priority chip (replaces the near-invisible dot) */}
                <span title={`${priority.label} priority`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold,
                  padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${priority.color}15`, color: priority.color,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: priority.color }} />
                  {priority.label}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.sm, color: sla.color, fontWeight: FW.semibold }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>schedule</span>
                  {sla.label}
                </span>
              </div>

              {/* Meta strip — who / when / how */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
                <MetaItem icon="event" label="Opened">{fmtDatetime(ticket.created_at)}</MetaItem>
                <MetaItem icon={channelIcon(ticket.channel)} label="Via">{ticket.channel || '—'}</MetaItem>
                <MetaItem icon="badge" label="Assignee">
                  {ticket.assigned_to_name || ticket.zoho_assignee_name || 'Unassigned'}
                  {!ticket.assigned_to_name && ticket.zoho_assignee_name && (
                    <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.normal, marginLeft: 4 }}>(Zoho)</span>
                  )}
                </MetaItem>
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                {terminal ? (
                  <button className="hd-press" onClick={handleReopen} disabled={actionLoading}
                    style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, opacity: actionLoading ? 0.6 : 1, boxShadow: SHADOW.sm }}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>lock_open</span>
                    Reopen
                  </button>
                ) : (
                  <>
                    <button className="hd-press" onClick={() => setResolveOpen(true)}
                      style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, boxShadow: SHADOW.sm }}>
                      <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>check_circle</span>
                      Resolve
                    </button>
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
                  </>
                )}
                <button onClick={() => setMergeOpen(true)}
                  style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>merge</span>
                  Merge
                </button>
              </div>
            </div>

            {/* Message thread — a distinct canvas so bubbles read as a conversation */}
            <div ref={threadRef} style={{ maxHeight: '56vh', minHeight: 220, overflowY: 'auto', padding: '18px', background: 'var(--th-bg)' }}>
              <Conversation ticket={ticket} messages={messages} />
              <div ref={threadEndRef} />
            </div>

            {/* Reply area */}
            <div style={{ borderTop: '1px solid var(--bdr)', padding: '14px 18px', flexShrink: 0 }}>
              <ErrBanner error={replyErr} />

              {/* Segmented Reply / Internal note toggle */}
              <div style={{ display: 'inline-flex', padding: 3, gap: 3, borderRadius: RADIUS.md, background: 'var(--th-bg)', border: '1px solid var(--bdr)', marginBottom: SP[2] }}>
                {[
                  { key: false, label: 'Reply', icon: 'reply', color: NAVY },
                  { key: true, label: 'Internal note', icon: 'lock', color: AMBER },
                ].map(m => {
                  const active = replyNote === m.key
                  return (
                    <button key={m.label} onClick={() => setReplyNote(m.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: '4px 12px', borderRadius: RADIUS.sm, border: 'none',
                        cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                        background: active ? 'var(--card)' : 'transparent',
                        color: active ? m.color : 'var(--txt3)',
                        boxShadow: active ? 'var(--card-shadow)' : 'none',
                      }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{m.icon}</span>
                      {m.label}
                    </button>
                  )
                })}
              </div>

              {terminal && !replyNote && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: SP[2], padding: '6px 10px', borderRadius: RADIUS.sm, background: `${AMBER}0F`, border: `1px solid ${AMBER}30`, fontSize: TEXT.xs, color: AMBER }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>info</span>
                  This ticket is {ticket.status}. Sending a reply will reopen it.
                </div>
              )}

              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                placeholder={replyNote ? 'Write an internal note (only staff can see this)…' : 'Write a reply to the customer…'}
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: SP[2] }}>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>⌘/Ctrl + ↵ to send</span>
                <button className="hd-press" onClick={sendReply} disabled={!replyText.trim() || sending}
                  style={{
                    padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none',
                    background: replyNote ? AMBER : NAVY, color: '#fff', boxShadow: SHADOW.sm,
                    fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (!replyText.trim() || sending) ? 'not-allowed' : 'pointer',
                    opacity: (!replyText.trim() || sending) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: SP[2],
                  }}>
                  {sending && <Spinner size={14} color="#fff" />}
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{replyNote ? 'lock' : 'send'}</span>
                  {replyNote ? 'Add Note' : 'Send Reply'}
                </button>
              </div>
            </div>
          </SectionCard>
        </div>

        {/* ── Right: Context + Actions ─────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>

          {/* Customer context */}
          <SectionCard title="Context" padding={false}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 18px', margin: 0, borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ boxShadow: `0 0 0 3px ${accent}22`, borderRadius: '50%', flexShrink: 0 }}>
                <Avatar name={ticket.customer_name || 'Customer'} size={42} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {ticket.customer_name || 'Unknown customer'}
                </div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: MONO, marginTop: 2 }}>
                  {linkedCif
                    ? <>CIF {linkedCif}{cifResolved && <span style={{ color: GREEN, fontFamily: 'inherit' }}> · matched</span>}</>
                    : 'No CIF linked'}
                </div>
              </div>
              {linkedCif && (
                <button className="hd-press" onClick={() => navigate(`/customers/${encodeURIComponent(linkedCif)}`)} title="Open full customer profile"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 11px', borderRadius: RADIUS.md, border: `1px solid ${NAVY}25`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', flexShrink: 0 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>open_in_new</span>
                  Profile
                </button>
              )}
            </div>
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
                    <div key={i} className="hd-lift" style={{ background: 'var(--th-bg)', border: '1px solid var(--bdr)', boxShadow: 'var(--shadow-xs)', borderRadius: RADIUS.md, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                    <div key={i} className="hd-lift" style={{ background: 'var(--th-bg)', border: '1px solid var(--bdr)', boxShadow: 'var(--shadow-xs)', borderRadius: RADIUS.md, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                    <div key={i} className="hd-lift" style={{ background: 'var(--th-bg)', border: '1px solid var(--bdr)', boxShadow: 'var(--shadow-xs)', borderRadius: RADIUS.md, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
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
                <button key={a.label} className="hd-lift hd-press" onClick={a.onClick}
                  style={{
                    width: '100%', padding: '9px 14px', border: `1px solid ${a.color}25`,
                    borderRadius: RADIUS.md, background: `${a.color}0A`, color: 'var(--txt)',
                    fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: SP[2], textAlign: 'left',
                  }}>
                  <span style={{ width: 26, height: 26, borderRadius: 7, background: `${a.color}18`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16, color: a.color }}>{a.icon}</span>
                  </span>
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
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Promise Amount (NGN)</label>
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
          navigate(`/sales/applications/new${qs}`)
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
