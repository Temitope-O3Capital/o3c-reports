import { useLiveData } from '../../hooks/useRealtime'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { StatusBadge, Modal, Spinner, ErrBanner, TblSearch, Avatar, Pagination } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { RED, AMBER, BLUE, NAVY, GREEN, PURPLE, MONO, SORA, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { Conversation, ConvMessage } from './Conversation'
import NewTicketForm from './NewTicket'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Ticket {
  id: number; ticket_ref: string; subject: string; status: string; priority: string; channel: string
  customer_name?: string; customer_cif?: string; customer_phone?: string
  assigned_to?: number | null; assigned_to_name?: string; sla_breached?: boolean
  message_count?: number; last_message_preview?: string; last_message_at?: string
  last_message_direction?: 'inbound' | 'outbound' | null; created_at: string; description?: string
}
interface TicketsResp { tickets: Ticket[]; total: number; pages?: number }
interface QueueSummary { open: number; unassigned: number; mine: number; awaiting_us: number; awaiting_customer: number; overdue: number }
interface Agent { id: number; full_name: string }
interface DetailResp { ticket: Ticket; messages: ConvMessage[] }

// ── Motion + accent language (shared with the full ticket view) ──────────────────
const HD_STYLE = `
@keyframes hdRowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes hdMsgIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes hdPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .3; transform: scale(.7); } }
.hd-row { animation: hdRowIn .22s ease both; transition: background .13s ease; }
.hd-msg { animation: hdMsgIn .26s cubic-bezier(.22,1,.36,1) both; }
.hd-card { transition: transform .16s cubic-bezier(.22,1,.36,1), box-shadow .16s, border-color .16s; }
.hd-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
.hd-press { transition: transform .1s ease, filter .15s ease; }
.hd-press:active { transform: scale(.97); }
.hd-press:hover { filter: brightness(1.05); }
.hd-livedot { width: 7px; height: 7px; border-radius: 50%; background: ${GREEN}; animation: hdPulse 1.8s ease-in-out infinite; display: inline-block; }
`
const CHANNEL_ACCENT: Record<string, string> = { web: BLUE, chat: BLUE, social: PURPLE, whatsapp: GREEN, email: AMBER, phone: GREEN, sms: '#0891B2' }
const channelAccent = (c?: string) => CHANNEL_ACCENT[(c ?? '').toLowerCase()] ?? NAVY
const CHANNEL_ICON: Record<string, string> = { web: 'language', chat: 'forum', social: 'public', whatsapp: 'chat', email: 'mail', phone: 'call', sms: 'sms' }
const channelIcon = (c?: string) => CHANNEL_ICON[(c ?? '').toLowerCase()] ?? 'confirmation_number'

// Card shell for the split panels — a real flex column so inner lists/threads
// scroll (SectionCard wraps children in a non-flex div, breaking the height chain).
const panelStyle: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
  borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0,
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function myUserId(): number { try { return Number(JSON.parse(localStorage.getItem('o3c_user') || '{}').id) || 0 } catch { return 0 } }
function myRole(): string { try { return String(JSON.parse(localStorage.getItem('o3c_user') || '{}').role || '') } catch { return '' } }
function isPrivileged(role: string): boolean { return /head|admin|super|manager|lead|supervisor/i.test(role) }
function ago(iso?: string | null): string {
  if (!iso) return '—'
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
function fullName(t: Ticket): string { return (t.customer_name || '').trim() || 'Unknown customer' }
function messageLine(t: Ticket): string {
  const s = (t.subject || '').trim()
  if (s && s.toLowerCase() !== 'ticket information') return s
  return (t.last_message_preview || '').trim() || s || '(no message)'
}

// 'escalated' is deliberately NOT here. It is not a legal value in
// helpdesk_tickets_status_check, so this chip matched nothing and always showed
// an empty list. Escalation is a flag now and has its own bucket chip below.
const STATUS_CHIPS = [{ value: 'open', label: 'Open' }, { value: 'pending', label: 'Pending' }, { value: 'in_progress', label: 'In Progress' }]
// Scope tabs — available to everyone, including leaf agents, because assisting on
// another team's ticket first requires being able to find it.
const SCOPE_TABS = [
  { value: 'mine',      label: 'Mine',       icon: 'assignment_ind' },
  { value: 'unassigned',label: 'Unclaimed',  icon: 'person_off' },
  { value: 'assisting', label: 'Assisting',  icon: 'volunteer_activism' },
  { value: 'all',       label: 'All tickets',icon: 'inbox' },
] as const
const CHANNEL_CHIPS = [{ value: '', label: 'All' }, { value: 'web', label: 'Web' }, { value: 'social', label: 'Social' }]
const SORT_OPTS = [
  { value: 'waiting', label: 'Longest waiting on us' }, { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' }, { value: 'updated', label: 'Recently updated' },
]

// ── Triage KPI card (clickable filter) ───────────────────────────────────────────
function TriageCard({ icon, label, value, color, active, onClick }: {
  icon: string; label: string; value: number | undefined; color: string; active: boolean; onClick: () => void
}) {
  return (
    <button className="hd-card hd-press" onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 15px', borderRadius: RADIUS.lg, textAlign: 'left',
        border: `1.5px solid ${active ? color : 'var(--card-bdr)'}`, background: active ? `${color}0E` : 'var(--card)',
        boxShadow: active ? `0 0 0 3px ${color}1c` : 'var(--card-shadow)', cursor: 'pointer', fontFamily: SORA, flex: 1, minWidth: 0,
      }}>
      <span style={{ width: 36, height: 36, borderRadius: 10, background: `${color}18`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 19, color }}>{icon}</span>
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: MONO, fontSize: 21, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1.1 }}>{value ?? '—'}</span>
        <span style={{ display: 'block', fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.semibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      </span>
    </button>
  )
}

function WaitingBadge({ t }: { t: Ticket }) {
  if (['resolved', 'closed'].includes(t.status)) return null
  if (t.last_message_direction === 'outbound') {
    return <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 7px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--txt3)' }}>Replied</span>
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 7px', borderRadius: RADIUS.full, background: `${RED}15`, color: RED }}>
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>mark_chat_unread</span>Awaiting
    </span>
  )
}

// ── Ticket row (compact — feeds the side preview) ─────────────────────────────────
function TicketRow({ t, myId, selected, checked, onCheck, onSelect, onClaim }: {
  t: Ticket; myId: number; selected: boolean; checked: boolean; onCheck: (e: React.MouseEvent) => void; onSelect: () => void; onClaim: () => void
}) {
  const accent = channelAccent(t.channel)
  const name = fullName(t)
  const isOpen = !['resolved', 'closed'].includes(t.status)
  const unassigned = t.assigned_to == null
  const mine = t.assigned_to != null && t.assigned_to === myId
  return (
    <div className="hd-row" onClick={onSelect}
      style={{ display: 'flex', alignItems: 'stretch', cursor: 'pointer', borderBottom: '1px solid var(--bdr)', background: selected ? `${NAVY}0C` : undefined }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent' }}>
      <div style={{ width: 3, background: selected ? NAVY : accent, flexShrink: 0 }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', padding: '12px 8px 0 11px', flexShrink: 0 }}>
        <input type="checkbox" checked={checked} onChange={() => {}} onClick={onCheck} style={{ cursor: 'pointer', accentColor: RED }} />
      </div>
      <div style={{ padding: '11px 9px 11px 3px', flexShrink: 0 }}><Avatar name={name} size={30} /></div>
      <div style={{ flex: 1, minWidth: 0, padding: '11px 12px 11px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{name}</span>
          <WaitingBadge t={t} />
          <span style={{ marginLeft: 'auto', flexShrink: 0 }}><StatusBadge status={t.status} size="sm" /></span>
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>{messageLine(t)}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, textTransform: 'capitalize' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13, color: accent }}>{channelIcon(t.channel)}</span>{t.channel || 'web'}
          </span>
          <span>{ago(t.last_message_at || t.created_at)}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {unassigned && isOpen ? (
              <button onClick={e => { e.stopPropagation(); onClaim() }}
                style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 9px', borderRadius: RADIUS.full, border: `1px solid ${NAVY}40`, background: `${NAVY}0D`, color: NAVY, cursor: 'pointer', fontFamily: SORA }}>Claim</button>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: mine ? NAVY : 'var(--txt3)', fontWeight: mine ? FW.semibold : FW.normal }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13 }}>support_agent</span>{mine ? 'You' : (t.assigned_to_name || '—')}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Side preview panel (live conversation) ───────────────────────────────────────
function TicketPreview({ ticketId, onChanged, onFull }: { ticketId: number; onChanged: () => void; onFull: () => void }) {
  const [data, setData] = useState<DetailResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [isNote, setIsNote] = useState(false)
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try { setData(await apiFetch<DetailResp>(`/api/helpdesk/tickets/${ticketId}`)) }
    catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [ticketId])
  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight }, [data?.messages])

  async function send() {
    if (!reply.trim()) return
    setSending(true)
    try { await apiPost(`/api/helpdesk/tickets/${ticketId}/messages`, { body_text: reply, is_internal_note: isNote }); setReply(''); setIsNote(false); await load(); onChanged() }
    catch (e: any) { toast.error(e.message ?? 'Failed to send') } finally { setSending(false) }
  }
  async function resolve() {
    setBusy(true)
    try { await apiFetch(`/api/helpdesk/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }); toast.success('Resolved'); await load(); onChanged() }
    catch (e: any) { toast.error(e.message ?? 'Failed') } finally { setBusy(false) }
  }
  async function callback() {
    setBusy(true)
    try { await apiPost('/api/call-center/queue/add-callback', { ticket_id: ticketId }); toast.success('Queued a call-back in the Support queue') }
    catch (e: any) { toast.error(e.message ?? 'Could not queue call-back') } finally { setBusy(false) }
  }

  if (loading && !data) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt2)' }}><Spinner size={18} color={NAVY} /> Loading…</div>
  if (err || !data) return <div style={{ padding: SP[5] }}><ErrBanner error={err ?? 'Not found'} onRetry={load} /></div>

  const t = data.ticket
  const accent = channelAccent(t.channel)
  const canResolve = !['resolved', 'closed'].includes(t.status)
  const fieldStyle: React.CSSProperties = { width: '100%', padding: '9px 11px', border: `1px solid ${isNote ? `${AMBER}55` : 'var(--input-bdr)'}`, borderRadius: RADIUS.md, fontSize: TEXT.base, background: isNote ? `${AMBER}08` : 'var(--input-bg)', color: 'var(--txt)', fontFamily: SORA, outline: 'none', boxSizing: 'border-box', resize: 'vertical' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '13px 18px', borderTop: `3px solid ${accent}`, borderBottom: '1px solid var(--bdr)', background: `linear-gradient(180deg, ${accent}0C, transparent 80%)`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.bold, color: accent, fontFamily: MONO, background: `${accent}16`, padding: '2px 9px', borderRadius: RADIUS.md }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{channelIcon(t.channel)}</span>{t.ticket_ref}
          </span>
          <StatusBadge status={t.status} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {canResolve && <button className="hd-press" onClick={resolve} disabled={busy} style={{ padding: '5px 12px', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA }}>Resolve</button>}
            {t.customer_phone && <button className="hd-press" onClick={callback} disabled={busy} title="Add to outbound Support queue" style={{ padding: '5px 11px', borderRadius: RADIUS.md, border: `1px solid ${GREEN}40`, background: 'none', color: GREEN, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA, display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="material-symbols-rounded" style={{ fontSize: 15 }}>phone_forwarded</span></button>}
            <button className="hd-press" onClick={onFull} title="Open full page" style={{ padding: '5px 11px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA, display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_full</span>Full page</button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: TEXT.xs, color: 'var(--txt2)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt3)' }}>person</span>{t.customer_name || 'Unknown customer'}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt3)' }}>support_agent</span>{t.assigned_to_name || 'Unassigned'}</span>
        </div>
      </div>
      {/* Thread */}
      <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', background: 'var(--th-bg)' }}>
        <Conversation ticket={t} messages={data.messages} dense />
      </div>
      {/* Composer */}
      <div style={{ borderTop: '1px solid var(--bdr)', padding: '12px 16px', flexShrink: 0, background: 'var(--card)' }}>
        <div style={{ display: 'flex', gap: 2, marginBottom: 8 }}>
          {(['Reply', 'Note'] as const).map(l => {
            const on = isNote ? l === 'Note' : l === 'Reply'
            return <button key={l} onClick={() => setIsNote(l === 'Note')} style={{ padding: '4px 11px', fontSize: TEXT.sm, fontWeight: on ? FW.bold : FW.medium, color: on ? (l === 'Note' ? AMBER : NAVY) : 'var(--txt3)', border: 'none', background: 'none', cursor: 'pointer', borderBottom: `2px solid ${on ? (l === 'Note' ? AMBER : NAVY) : 'transparent'}`, marginBottom: -1, fontFamily: SORA }}>{l}</button>
          })}
        </div>
        <textarea value={reply} onChange={e => setReply(e.target.value)} rows={2} spellCheck={false}
          placeholder={isNote ? 'Add an internal note…' : 'Type your reply…'} style={fieldStyle}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="hd-press" onClick={send} disabled={!reply.trim() || sending}
            style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: 'none', background: isNote ? AMBER : NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: (!reply.trim() || sending) ? 'not-allowed' : 'pointer', opacity: !reply.trim() ? 0.5 : 1, fontFamily: SORA, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {sending ? <Spinner size={13} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{isNote ? 'lock' : 'send'}</span>}
            {isNote ? 'Add Note' : 'Send Reply'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Tickets() {
  const navigate = useNavigate()
  const myId = useMemo(myUserId, [])
  const role = useMemo(myRole, [])
  const privileged = useMemo(() => isPrivileged(role), [role])

  const [tickets, setTickets] = useState<Ticket[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null)
  const [summary, setSummary] = useState<QueueSummary | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const PER_PAGE = 40

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  // Maps 1:1 onto the backend's ?scope=. "all" is now genuinely all tickets for
  // an agent too — cross-team assist needs you to be able to FIND a colleague's
  // ticket, not only open one you were sent a link to.
  const [view, setView] = useState<'all' | 'unassigned' | 'mine' | 'assisting'>('all')
  const [agentFilter, setAgentFilter] = useState('')
  const [bucket, setBucket] = useState('')
  const [sort, setSort] = useState('waiting')

  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [newOpen, setNewOpen] = useState(false)
  const [reassignOpen, setReassignOpen] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [reassignTarget, setReassignTarget] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (statusFilter) p.set('status', statusFilter)
      if (channelFilter) p.set('channel', channelFilter)
      if (debouncedSearch) p.set('search', debouncedSearch)
      // scope drives row-level visibility server-side; assigned_to stays as the
      // explicit "show me THIS agent's tickets" filter a supervisor picks.
      if (agentFilter) p.set('assigned_to', agentFilter)
      else p.set('scope', view)
      if (bucket) p.set('bucket', bucket)
      if (sort) p.set('sort', sort)
      p.set('exclude_channel', 'email,call'); p.set('page', String(page)); p.set('per_page', String(PER_PAGE))
      const res = await apiFetch<TicketsResp>(`/api/helpdesk/tickets?${p}`)
      const list = res.tickets ?? []
      setTickets(list); setTotal(res.total ?? 0); setPages(res.pages ?? 1); setLastLoaded(new Date())
      setSelectedId(prev => (prev && list.some(t => t.id === prev)) ? prev : (list[0]?.id ?? null))
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [statusFilter, channelFilter, debouncedSearch, view, agentFilter, bucket, sort, page])

  const loadSummary = useCallback(async () => {
    try {
      // Same scope as the list, or the chips count a set the list can't show —
      // that mismatch is why the "unassigned" chip used to display a number over
      // an empty list for leaf agents.
      const p = new URLSearchParams({ exclude_channel: 'email,call', scope: 'all' })
      if (channelFilter) p.set('channel', channelFilter)
      const raw = await apiFetch<any>(`/api/helpdesk/tickets/summary?${p}`)
      setSummary((raw?.data ?? raw) as QueueSummary)
    } catch { /* strip degrades to dashes */ }
  }, [channelFilter])

  const refreshAll = useCallback(() => { load(); loadSummary() }, [load, loadSummary])
  useEffect(() => { load() }, [load])
  useEffect(() => { loadSummary() }, [loadSummary])
  useLiveData(refreshAll, { topics: ['tickets'] })

  const searchRef = useRef(search); searchRef.current = search
  useEffect(() => { const t = setTimeout(() => { setDebouncedSearch(searchRef.current.trim()); setPage(1) }, 350); return () => clearTimeout(t) }, [search])
  useEffect(() => {
    if ((reassignOpen || privileged) && agents.length === 0) {
      apiFetch<Agent[]>('/api/helpdesk/agents').then(r => setAgents(Array.isArray(r) ? r : [])).catch(() => setAgents([]))
    }
  }, [reassignOpen, privileged, agents.length])

  function pickView(v: 'all' | 'unassigned' | 'mine' | 'assisting') { setView(v); setAgentFilter(''); setBucket(''); setPage(1) }
  function pickBucket(b: string) { setBucket(prev => prev === b ? '' : b); setView('all'); setAgentFilter(''); setPage(1) }
  function toggleCheck(id: number, e: React.MouseEvent) { e.stopPropagation(); setCheckedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n }) }

  async function handleClaim(id: number) {
    try { await apiPost(`/api/helpdesk/tickets/${id}/claim`, {}); toast.success('Ticket claimed — it’s yours'); refreshAll() }
    catch (e: any) { toast.error(e.message ?? 'Claim failed') }
  }
  async function handleBulkClose() {
    if (!checkedIds.size) return
    setActionLoading(true)
    try { await apiPost('/api/helpdesk/tickets/bulk-close', { ticket_ids: [...checkedIds] }); toast.success(`${checkedIds.size} closed`); setCheckedIds(new Set()); refreshAll() }
    catch (e: any) { setErr(e.message) } finally { setActionLoading(false) }
  }
  async function handleBulkReassign() {
    if (!reassignTarget || !checkedIds.size) return
    setActionLoading(true)
    try { await apiPost('/api/helpdesk/tickets/bulk-assign', { ticket_ids: [...checkedIds], agent_id: Number(reassignTarget) }); toast.success('Reassigned'); setCheckedIds(new Set()); setReassignOpen(false); setReassignTarget(''); refreshAll() }
    catch (e: any) { setErr(e.message) } finally { setActionLoading(false) }
  }

  const hasFilters = Boolean(statusFilter || channelFilter || search || bucket || view !== 'all' || agentFilter)
  function clearAll() { setStatusFilter(''); setChannelFilter(''); setSearch(''); setBucket(''); setView('all'); setAgentFilter(''); setPage(1) }

  const selCss: React.CSSProperties = {
    height: 34, padding: '0 28px 0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm,
    background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: 'inherit', cursor: 'pointer', appearance: 'none',
    backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%239aa5b1\' stroke-width=\'2.5\'><path d=\'M6 9l6 6 6-6\'/></svg>")',
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 9px center',
  }
  const chip = (on: boolean, color: string): React.CSSProperties => ({
    fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '4px 11px', borderRadius: RADIUS.full, cursor: 'pointer', fontFamily: SORA,
    border: `1px solid ${on ? color : 'var(--bdr)'}`, background: on ? `${color}14` : 'transparent', color: on ? color : 'var(--txt3)',
  })

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)', fontFamily: SORA }}>
      <style>{HD_STYLE}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 24px 0', flexShrink: 0 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--txt)', letterSpacing: '-0.5px' }}>Ticket Queue</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--txt2)' }}>Customer-raised web &amp; social support · email → Care · calls → Call Activity</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastLoaded && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt3)' }} title="Live — auto-refreshes"><span className="hd-livedot" />Live · {ago(lastLoaded.toISOString())}</span>}
          <button className="hd-press" onClick={refreshAll} title="Refresh" style={{ width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 19 }}>refresh</span>
          </button>
          <button className="hd-press" onClick={() => setNewOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>add</span>New Ticket
          </button>
        </div>
      </div>

      {/* KPI cards — team triage; agents only see their own queue, so these team-wide
          buckets (and the by-agent filter) are shown to heads/supervisors only. */}
      {privileged && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: SP[3], padding: '16px 24px 0', flexShrink: 0 }}>
        <TriageCard icon="inbox" label="Open" value={summary?.open} color={NAVY} active={!bucket && view === 'all' && !agentFilter} onClick={() => pickView('all')} />
        <TriageCard icon="alarm" label="Overdue" value={summary?.overdue} color={RED} active={bucket === 'overdue'} onClick={() => pickBucket('overdue')} />
        <TriageCard icon="mark_chat_unread" label="Awaiting us" value={summary?.awaiting_us} color={RED} active={bucket === 'awaiting_us'} onClick={() => pickBucket('awaiting_us')} />
        <TriageCard icon="schedule_send" label="Awaiting customer" value={summary?.awaiting_customer} color={BLUE} active={bucket === 'awaiting_customer'} onClick={() => pickBucket('awaiting_customer')} />
        <TriageCard icon="person_off" label="Unassigned" value={summary?.unassigned} color={AMBER} active={view === 'unassigned'} onClick={() => pickView(view === 'unassigned' ? 'all' : 'unassigned')} />
        <TriageCard icon="assignment_ind" label="Assigned to me" value={summary?.mine} color={PURPLE} active={view === 'mine'} onClick={() => pickView(view === 'mine' ? 'all' : 'mine')} />
      </div>
      )}

      {/* Scope tabs — shown to EVERYONE. An agent used to be pinned to their own
          rows with no way to reach a colleague's ticket, so nobody could cover for
          anyone. "All tickets" is now reachable by agents; ownership is still
          protected by the assist model on the ticket itself. */}
      <div style={{ display: 'flex', gap: 6, padding: '16px 24px 0', flexShrink: 0, flexWrap: 'wrap' }}>
        {SCOPE_TABS.map(t => {
          const active = view === t.value && !agentFilter && !bucket
          return (
            <button key={t.value} onClick={() => pickView(t.value)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 13px',
                border: `1px solid ${active ? NAVY : 'var(--bdr)'}`, borderRadius: RADIUS['2xl'],
                background: active ? NAVY : 'var(--card)', color: active ? '#fff' : 'var(--txt2)',
                fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
              }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{t.icon}</span>
              {t.label}
              {t.value === 'unassigned' && summary?.unassigned ? ` (${summary.unassigned})` : ''}
              {t.value === 'mine' && summary?.mine ? ` (${summary.mine})` : ''}
            </button>
          )
        })}
        <button onClick={() => pickBucket('escalated')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 13px',
            border: `1px solid ${bucket === 'escalated' ? RED : 'var(--bdr)'}`, borderRadius: RADIUS['2xl'],
            background: bucket === 'escalated' ? RED : 'var(--card)',
            color: bucket === 'escalated' ? '#fff' : 'var(--txt2)',
            fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>priority_high</span>
          Escalated
        </button>
      </div>

      <div style={{ padding: '0 24px 16px', flexShrink: 0 }}><ErrBanner error={err} onRetry={load} /></div>

      {/* Split: list + preview */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: SP[4], padding: '0 24px 24px' }}>
        {/* List */}
        <div style={{ ...panelStyle, width: 440, minWidth: 380, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '11px 13px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <div style={{ flex: '1 1 100%' }}><TblSearch value={search} onChange={setSearch} placeholder="Search subject, customer, ref…" width={0} /></div>
            {CHANNEL_CHIPS.map(c => <button key={c.label} onClick={() => { setChannelFilter(c.value); setPage(1) }} style={chip(channelFilter === c.value, PURPLE)}>{c.label}</button>)}
            {STATUS_CHIPS.map(s => <button key={s.value} onClick={() => { setStatusFilter(statusFilter === s.value ? '' : s.value); setPage(1) }} style={chip(statusFilter === s.value, NAVY)}>{s.label}</button>)}
            <select value={sort} onChange={e => { setSort(e.target.value); setPage(1) }} style={{ ...selCss, marginLeft: 'auto' }} title="Sort">
              {SORT_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {privileged && (
              <select value={agentFilter} onChange={e => { setAgentFilter(e.target.value); setView('all'); setPage(1) }} style={{ ...selCss, maxWidth: 150, textOverflow: 'ellipsis' }} title="Filter by agent">
                <option value="">Everyone’s tickets</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
              </select>
            )}
            {hasFilters && <button onClick={clearAll} style={{ ...chip(false, NAVY), display: 'inline-flex', alignItems: 'center', gap: 3 }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>Clear</button>}
          </div>

          {checkedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 13px', background: `${NAVY}0A`, borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>{checkedIds.size} selected</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="hd-press" onClick={() => setReassignOpen(true)} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: RADIUS.sm, padding: '4px 10px', cursor: 'pointer', fontFamily: SORA }}>Reassign</button>
                <button className="hd-press" onClick={handleBulkClose} disabled={actionLoading} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: '#fff', background: RED, border: 'none', borderRadius: RADIUS.sm, padding: '4px 10px', cursor: 'pointer', fontFamily: SORA }}>Close</button>
                <button onClick={() => setCheckedIds(new Set())} style={{ width: 24, height: 24, borderRadius: '50%', border: 'none', background: 'none', color: 'var(--txt2)', cursor: 'pointer' }}>✕</button>
              </div>
            </div>
          )}

          <div style={{ padding: '6px 13px', borderBottom: '1px solid var(--bdr)', flexShrink: 0, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.08em', fontFamily: MONO }}>{hasFilters ? 'Filtered' : 'All tickets'}</span>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: MONO }}>{tickets.length} of {total}</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && tickets.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '50px 0', color: 'var(--txt2)' }}><Spinner size={18} color={NAVY} /> Loading…</div>
            ) : tickets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--txt2)' }}>
                {view === 'unassigned' ? 'No unassigned tickets.' : view === 'mine' ? 'Nothing assigned to you.' : 'No tickets match these filters.'}
              </div>
            ) : tickets.map(t => (
              <TicketRow key={t.id} t={t} myId={myId} selected={selectedId === t.id} checked={checkedIds.has(t.id)}
                onCheck={e => toggleCheck(t.id, e)} onSelect={() => setSelectedId(t.id)} onClaim={() => handleClaim(t.id)} />
            ))}
          </div>

          <div style={{ flexShrink: 0 }}>
            <Pagination page={page} pages={pages} onPage={setPage} showRange={false} maxButtons={5} />
          </div>
        </div>

        {/* Preview */}
        <div style={{ ...panelStyle, flex: 1, minWidth: 0 }}>
          {selectedId ? (
            <TicketPreview key={selectedId} ticketId={selectedId} onChanged={refreshAll} onFull={() => navigate(`/helpdesk/${selectedId}`)} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt3)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 40, opacity: 0.3 }}>forum</span>
              <span style={{ fontSize: TEXT.base }}>Select a ticket to view the conversation</span>
            </div>
          )}
        </div>
      </div>

      {/* New ticket */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Ticket" width={640} maxHeight="78vh">
        <NewTicketForm stickyFooter onClose={() => setNewOpen(false)} onCreated={(id: number) => { setNewOpen(false); refreshAll(); setSelectedId(id) }} />
      </Modal>

      {/* Bulk reassign */}
      <Modal open={reassignOpen} onClose={() => { setReassignOpen(false); setReassignTarget('') }} title={`Reassign ${checkedIds.size} ticket${checkedIds.size !== 1 ? 's' : ''}`} width={400}
        footer={
          <>
            <button onClick={() => { setReassignOpen(false); setReassignTarget('') }} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer', fontFamily: SORA }}>Cancel</button>
            <button className="hd-press" onClick={handleBulkReassign} disabled={!reassignTarget || actionLoading} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', opacity: (!reassignTarget || actionLoading) ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SORA }}>
              {actionLoading && <Spinner size={13} color="#fff" />}Reassign
            </button>
          </>
        }>
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginTop: 0 }}>Select the agent to assign the selected tickets to.</p>
        <select value={reassignTarget} onChange={e => setReassignTarget(e.target.value)} style={{ ...selCss, width: '100%', height: 38 }}>
          <option value="">— Select agent —</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>
      </Modal>
    </div>
  )
}
