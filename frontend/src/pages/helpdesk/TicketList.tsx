// INTEGRATION NOTES for App.tsx and Sidebar.tsx:
//
// Routes to add in App.tsx:
//   <Route path="/helpdesk" element={<TicketList />} />
//   <Route path="/helpdesk/:id" element={<TicketDetail />} />
//   <Route path="/helpdesk/canned" element={<CannedResponses />} />
//   <Route path="/helpdesk/stats" element={<HelpdeskStats />} />
//
// Sidebar nav item to add (in the main nav or a new "Customer Service" section):
//   { label: 'Helpdesk', to: '/helpdesk', icon: 'support_agent' }
//   { label: 'Canned Responses', to: '/helpdesk/canned', icon: 'quickreply' }
//
// Page keys for ROLE_PAGES (useAuth.ts) — roles that should access helpdesk:
//   'call_center_agent', 'call_center_head', 'collections_agent', 'collections_head',
//   'recovery_agent', 'recovery_head', 'cards_ops_officer', 'cards_ops_head',
//   'md', 'coo', 'management', 'admin'

import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Page, KpiCard, SectionCard, Spinner, ErrBanner, DateFilter, NAVY, RED, AMBER, GREEN, BLUE } from '../../components/UI'
import { StatusPill, PriorityPill } from './components'
import { today, yearStart } from '../../lib/fmt'

// ── Types ─────────────────────────────────────────────────────────────────────
interface HelpdeskStats {
  open:            number
  pending:         number
  sla_breached:    number
  resolved_today:  number
  avg_csat:        number | null
}

interface Ticket {
  id:                number
  ticket_ref:        string
  subject:           string
  status:            string
  priority:          string
  channel:           string
  department:        string
  customer_name:     string
  customer_cif:      string
  assigned_to_name:  string | null
  last_message_at:   string | null
  sla_due_at:        string | null
  sla_breached:      boolean
  first_response_at: string | null
  created_at:        string
}

interface TicketPage {
  data:  Ticket[]
  total: number
  page:  number
  pages: number
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_OPTIONS   = ['All','Open','Pending','In Progress','Resolved','Closed']
const PRIORITY_OPTIONS = ['All','Urgent','High','Normal','Low']
const CHANNEL_OPTIONS  = ['All','Email','SMS','WhatsApp','Phone','In-App']
const DEPT_OPTIONS     = [
  'All','Sales','Risk','Finance','Collections','Recovery',
  'HR','Compliance','Cards Ops','Call Center','IT','Management',
]
const PER_PAGE         = 25

// SLA threshold for FRT warning: 2 hours
const SLA_SOON_MS = 2 * 3600 * 1000

// ── Helpers ───────────────────────────────────────────────────────────────────
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function frtDisplay(first_response_at: string | null, created_at: string): {
  text: string; color: string
} {
  if (!first_response_at) return { text: '—', color: 'var(--txt2)' }
  const ms = new Date(first_response_at).getTime() - new Date(created_at).getTime()
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const text = h > 0 ? `${h}h ${m}m` : `${m}m`
  const color = ms > SLA_SOON_MS ? RED : ms > 3600000 ? AMBER : GREEN
  return { text, color }
}

function slaDisplay(t: Ticket): { text: string; bg: string; color: string } {
  if (t.sla_breached || (t.sla_due_at && new Date(t.sla_due_at).getTime() < Date.now())) {
    return { text: 'BREACHED', bg: 'rgba(192,0,0,0.1)', color: RED }
  }
  if (t.sla_due_at) {
    const diff = new Date(t.sla_due_at).getTime() - Date.now()
    if (diff < SLA_SOON_MS) {
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const label = h > 0 ? `Due in ${h}h ${m}m` : `Due in ${m}m`
      return { text: label, bg: 'rgba(217,119,6,0.1)', color: AMBER }
    }
    return { text: 'On Track', bg: 'rgba(5,150,105,0.1)', color: GREEN }
  }
  return { text: '—', bg: 'transparent', color: 'var(--txt2)' }
}

const CHANNEL_ICON: Record<string, string> = {
  email:    'email',
  sms:      'sms',
  whatsapp: 'chat',
  phone:    'call',
  'in-app': 'smartphone',
}

function FilterSelect({ value, options, onChange, label }: {
  value: string; options: string[]; onChange: (v: string) => void; label: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="px-3 py-1.5 rounded-lg border text-[12px] font-medium appearance-none pr-7 outline-none"
      style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)', minWidth: 110 }}
      aria-label={label}
    >
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

// ── Bulk action bar ───────────────────────────────────────────────────────────
interface Agent { id: number; name: string }

function BulkBar({
  count,
  agents,
  onAssign,
  onPriority,
  onClose: onCloseSelected,
  onClear,
}: {
  count: number
  agents: Agent[]
  onAssign: (agentId: number) => void
  onPriority: (p: string) => void
  onClose: () => void
  onClear: () => void
}) {
  const [agentVal, setAgentVal] = useState('')
  const [prioVal,  setPrioVal]  = useState('')

  return (
    <div className="flex items-center flex-wrap gap-2 px-3 py-2.5 flex-shrink-0 text-[12px]"
      style={{ background: '#F0F4FF', borderBottom: '1px solid var(--bdr)' }}>
      <span className="font-semibold" style={{ color: '#0E2841' }}>{count} selected</span>
      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--bdr)' }} />

      {/* Assign to */}
      <select
        value={agentVal}
        onChange={e => setAgentVal(e.target.value)}
        className="px-2 py-1 rounded-lg text-[11px] border outline-none"
        style={{ borderColor: 'var(--bdr)', background: '#fff', color: '#0E2841' }}>
        <option value="">Assign…</option>
        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <button
        disabled={!agentVal}
        onClick={() => { onAssign(Number(agentVal)); setAgentVal('') }}
        className="px-2 py-1 rounded-lg font-semibold border disabled:opacity-40 text-[11px]"
        style={{ borderColor: 'var(--bdr)', background: '#fff', color: '#0E2841' }}>
        Apply
      </button>

      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--bdr)' }} />

      {/* Set priority */}
      <select
        value={prioVal}
        onChange={e => setPrioVal(e.target.value)}
        className="px-2 py-1 rounded-lg text-[11px] border outline-none"
        style={{ borderColor: 'var(--bdr)', background: '#fff', color: '#0E2841' }}>
        <option value="">Priority…</option>
        {['urgent','high','normal','low'].map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <button
        disabled={!prioVal}
        onClick={() => { onPriority(prioVal); setPrioVal('') }}
        className="px-2 py-1 rounded-lg font-semibold border disabled:opacity-40 text-[11px]"
        style={{ borderColor: 'var(--bdr)', background: '#fff', color: '#0E2841' }}>
        Apply
      </button>

      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--bdr)' }} />

      <button onClick={onCloseSelected}
        className="flex items-center gap-1 px-2 py-1 rounded-lg font-semibold text-[11px]"
        style={{ background: 'rgba(5,150,105,0.12)', color: '#059669' }}>
        <span className="material-symbols-rounded text-[13px]">check_circle</span>
        Close
      </button>

      <button onClick={onClear}
        className="ml-auto w-6 h-6 flex items-center justify-center rounded-full hover:bg-black/[0.08]"
        style={{ color: 'var(--txt2)' }}>
        <span className="material-symbols-rounded text-[15px]">close</span>
      </button>
    </div>
  )
}

// ── Quick stats bar ───────────────────────────────────────────────────────────
function QuickStats({ stats, tickets, statsLoading }: {
  stats: HelpdeskStats | null
  tickets: Ticket[]
  statsLoading: boolean
}) {
  // Compute avg FRT from loaded tickets (today's tickets)
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayFrts = tickets.filter(t =>
    t.created_at.slice(0, 10) === todayStr && t.first_response_at != null
  )
  let avgFrtDisplay = '—'
  if (todayFrts.length > 0) {
    const avgMs = todayFrts.reduce((acc, t) => {
      return acc + (new Date(t.first_response_at!).getTime() - new Date(t.created_at).getTime())
    }, 0) / todayFrts.length
    const h = Math.floor(avgMs / 3600000)
    const m = Math.floor((avgMs % 3600000) / 60000)
    avgFrtDisplay = h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const items = [
    { label: 'Open', value: statsLoading ? '…' : String(stats?.open ?? 0), color: NAVY, icon: 'inbox' },
    { label: 'Pending', value: statsLoading ? '…' : String(stats?.pending ?? 0), color: AMBER, icon: 'schedule' },
    { label: 'Breached', value: statsLoading ? '…' : String(stats?.sla_breached ?? 0), color: RED, icon: 'alarm_off' },
    { label: 'Avg FRT Today', value: avgFrtDisplay, color: '#2563EB', icon: 'timer' },
  ]

  return (
    <div className="flex gap-4 mb-6">
      {items.map(item => (
        <div key={item.label}
          className="flex items-center gap-3 rounded-xl px-4 py-3 flex-1"
          style={{ background: 'var(--card)', border: '1px solid var(--bdr)' }}>
          <span className="material-symbols-rounded text-[20px]" style={{ color: item.color }}>{item.icon}</span>
          <div>
            <p className="text-[18px] font-bold leading-tight" style={{ color: 'var(--txt)' }}>{item.value}</p>
            <p className="text-[11px]" style={{ color: 'var(--txt2)' }}>{item.label}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Ticket preview panel (right side of split view) ──────────────────────────
function TicketPreview({ ticket: t, navigate }: { ticket: Ticket; navigate: (path: string) => void }) {
  const frt = frtDisplay(t.first_response_at, t.created_at)
  const sla = slaDisplay(t)
  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <span className="font-mono text-[11px]" style={{ color: 'var(--txt2)' }}>{t.ticket_ref}</span>
          <h2 className="text-[15px] font-bold mt-1 leading-snug" style={{ color: 'var(--txt)' }}>{t.subject}</h2>
        </div>
        <button
          onClick={() => navigate(`/helpdesk/${t.id}`)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-semibold text-white flex-shrink-0"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[14px]">open_in_new</span>
          Open
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-5">
        <StatusPill status={t.status} />
        <PriorityPill priority={t.priority} />
        <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full"
          style={{ background: 'var(--chip-bg)', color: 'var(--txt2)' }}>
          <span className="material-symbols-rounded text-[13px]">{CHANNEL_ICON[t.channel?.toLowerCase()] ?? 'chat'}</span>
          {t.channel}
        </span>
        {sla.text !== '—' && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
            style={{ background: sla.bg, color: sla.color }}>{sla.text}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-5"
        style={{ borderTop: '1px solid var(--bdr)', borderBottom: '1px solid var(--bdr)' }}>
        {([
          ['Customer',     t.customer_name],
          ['CIF',          t.customer_cif || '—'],
          ['Department',   t.department || '—'],
          ['Assigned to',  t.assigned_to_name ?? 'Unassigned'],
          ['FRT',          frt.text],
          ['Created',      fmtDate(t.created_at)],
          ['Last message', relativeTime(t.last_message_at) || '—'],
          ['SLA due',      t.sla_due_at ? fmtDate(t.sla_due_at) : '—'],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label}>
            <div className="text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--txt2)' }}>{label}</div>
            <div className="text-[13px] font-medium" style={{ color: ['—', 'Unassigned'].includes(value) ? 'var(--txt2)' : 'var(--txt)' }}>{value}</div>
          </div>
        ))}
      </div>

      <button
        onClick={() => navigate(`/helpdesk/${t.id}`)}
        className="w-full flex items-center justify-center gap-2 mt-5 py-2.5 rounded-xl text-[13px] font-semibold"
        style={{ background: NAVY, color: '#fff' }}>
        <span className="material-symbols-rounded text-[16px]">open_in_new</span>
        Open Full Ticket
      </button>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function TicketList() {
  const navigate = useNavigate()

  // Stats
  const [stats, setStats]         = useState<HelpdeskStats | null>(null)
  const [statsLoading, setStatsL] = useState(true)
  const [agents, setAgents]       = useState<Agent[]>([])

  // Tickets
  const [ticketPage, setTicketPage] = useState<TicketPage | null>(null)
  const [loading, setLoading]       = useState(true)
  const [err, setErr]               = useState('')
  const [page, setPage]             = useState(1)

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // Filters
  const [status,     setStatus]     = useState('All')
  const [priority,   setPriority]   = useState('All')
  const [channel,    setChannel]    = useState('All')
  const [department, setDepartment] = useState('All')
  const [assignedTo, setAssignedTo] = useState('')
  const [search,     setSearch]     = useState('')
  const [searchQ,    setSearchQ]    = useState('')  // debounced
  const [myTickets,  setMyTickets]  = useState(false)
  const [dateFrom,   setDateFrom]   = useState(yearStart())
  const [dateTo,     setDateTo]     = useState(today())

  // Debounce search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((val: string) => {
    setSearch(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setSearchQ(val)
      setPage(1)
    }, 300)
  }, [])

  // Sort state
  const [sortBy,  setSortBy]  = useState<'created_at' | 'priority' | 'sla_due_at'>('created_at')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [refreshKey,      setRefreshKey]      = useState(0)
  const [lastSynced,      setLastSynced]      = useState<Date | null>(null)
  const [selectedTicket,  setSelectedTicket]  = useState<Ticket | null>(null)
  function toggleSort(col: typeof sortBy) {
    setSortBy(prev => {
      if (prev === col) { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); return prev }
      setSortDir('desc'); return col
    })
    setPage(1)
  }

  // Reset page on filter change
  useEffect(() => { setPage(1) }, [status, priority, channel, department, assignedTo, myTickets])

  // Load stats
  useEffect(() => {
    setStatsL(true)
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    apiFetch<HelpdeskStats>(`/api/helpdesk/stats?${qs}`)
      .then(setStats)
      .catch(() => {})
      .finally(() => setStatsL(false))
  }, [dateFrom, dateTo, refreshKey])

  // Load agents for bulk assign
  useEffect(() => {
    apiFetch<{ id: number; full_name: string }[]>('/api/crm/users')
      .then(r => setAgents((r ?? []).map(u => ({ id: u.id, name: u.full_name }))))
      .catch(() => {})
  }, [])

  // Load tickets
  useEffect(() => {
    setLoading(true); setErr('')
    const params = new URLSearchParams()
    if (status     !== 'All') params.set('status',     status.toLowerCase().replace(/\s+/g, '_'))
    if (priority   !== 'All') params.set('priority',   priority.toLowerCase())
    if (channel    !== 'All') params.set('channel',    channel.toLowerCase())
    if (department !== 'All') params.set('department', department.toLowerCase().replace(/\s+/g, '_'))
    if (assignedTo)           params.set('assigned_to', assignedTo)
    if (searchQ)              params.set('q', searchQ)
    if (myTickets)            params.set('my_tickets', 'true')
    params.set('date_from', dateFrom)
    params.set('date_to',   dateTo)
    params.set('page',     String(page))
    params.set('per_page', String(PER_PAGE))

    apiFetch<TicketPage>(`/api/helpdesk/tickets?${params}`)
      .then(data => { setTicketPage(data); setLastSynced(new Date()) })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [status, priority, channel, department, assignedTo, searchQ, myTickets, page, dateFrom, dateTo, refreshKey])

  const tickets = ticketPage?.data ?? []
  const totalPages = ticketPage?.pages ?? 1

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
    })
  }
  function toggleAll() {
    setSelectedIds(prev =>
      prev.size === tickets.length ? new Set() : new Set(tickets.map(t => t.id))
    )
  }

  async function bulkAssign(agentId: number) {
    try {
      await apiPost('/api/helpdesk/tickets/bulk-assign', {
        ticket_ids: Array.from(selectedIds),
        agent_id: agentId,
      })
    } catch { /* ignore */ }
    setSelectedIds(new Set())
    setPage(p => p) // re-trigger load via deps — just re-set page
  }

  async function bulkPriority(p: string) {
    try {
      await apiPost('/api/helpdesk/tickets/bulk-priority', {
        ticket_ids: Array.from(selectedIds),
        priority: p,
      })
    } catch { /* ignore */ }
    setSelectedIds(new Set())
  }

  async function bulkClose() {
    try {
      await apiPost('/api/helpdesk/tickets/bulk-close', {
        ticket_ids: Array.from(selectedIds),
      })
    } catch { /* ignore */ }
    setSelectedIds(new Set())
  }

  return (
    <Page
      dept="Customer Service"
      title="Helpdesk"
      subtitle="Manage customer support tickets"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); setPage(1) }} />
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              title="Refresh tickets"
              className="flex items-center gap-1 px-3 py-2 rounded-lg border text-[12px] font-medium transition-all"
              style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)', background: 'var(--card)' }}
            >
              <span className="material-symbols-rounded text-[15px]">refresh</span>
            </button>
            {lastSynced && (
              <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--txt2)' }}>
                Synced {(() => {
                  const s = Math.floor((Date.now() - lastSynced.getTime()) / 1000)
                  if (s < 60) return 'just now'
                  if (s < 3600) return `${Math.floor(s / 60)}m ago`
                  return `${Math.floor(s / 3600)}h ago`
                })()}
              </span>
            )}
          </div>
          <button
            onClick={() => navigate('/helpdesk/new')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
            style={{ background: NAVY }}
          >
            <span className="material-symbols-rounded text-[16px]">add</span>
            New Ticket
          </button>
        </div>
      }
    >
      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <KpiCard label="Open"           value={statsLoading ? '—' : String(stats?.open ?? 0)}          icon="inbox"       accent={NAVY}  loading={statsLoading} />
        <KpiCard label="Pending"        value={statsLoading ? '—' : String(stats?.pending ?? 0)}       icon="schedule"    accent={AMBER} loading={statsLoading} />
        <KpiCard label="SLA Breached"   value={statsLoading ? '—' : String(stats?.sla_breached ?? 0)} icon="alarm_off"   accent={RED}   loading={statsLoading} />
        <KpiCard label="Resolved Today" value={statsLoading ? '—' : String(stats?.resolved_today ?? 0)} icon="task_alt"  accent={GREEN} loading={statsLoading} />
        <KpiCard
          label="Avg CSAT"
          value={stats?.avg_csat != null ? `⭐ ${Number(stats.avg_csat).toFixed(1)}` : '—'}
          icon="star" accent={AMBER} loading={statsLoading}
        />
      </div>

      {/* Split view */}
      <div className="flex rounded-[14px] border overflow-hidden"
        style={{ borderColor: 'var(--card-bdr)', background: 'var(--card)', boxShadow: 'var(--card-shadow)', minHeight: 540 }}>

        {/* ── Left list panel ── */}
        <div className="w-[380px] flex-shrink-0 flex flex-col" style={{ borderRight: '1px solid var(--bdr)' }}>

          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--bdr)' }}>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>
              Tickets
              {ticketPage?.total != null && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded text-[11px] font-bold"
                  style={{ background: 'var(--chip-bg)', color: 'var(--txt2)' }}>
                  {ticketPage.total}
                </span>
              )}
            </span>
            <button
              onClick={() => setMyTickets(m => !m)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-all"
              style={{
                borderColor: myTickets ? NAVY : 'var(--bdr)',
                background:  myTickets ? `${NAVY}0f` : 'transparent',
                color:       myTickets ? NAVY : 'var(--txt2)',
              }}>
              <span className="material-symbols-rounded text-[13px]">person</span>
              Mine
            </button>
          </div>

          {/* Status tabs */}
          <div className="flex items-center overflow-x-auto flex-shrink-0"
            style={{ borderBottom: '1px solid var(--bdr)' }}>
            {[
              { label: 'All',         val: 'All',         color: 'var(--txt2)' },
              { label: 'Open',        val: 'Open',        color: NAVY },
              { label: 'Pending',     val: 'Pending',     color: AMBER },
              { label: 'In Progress', val: 'In Progress', color: BLUE },
              { label: 'Resolved',    val: 'Resolved',    color: GREEN },
            ].map(chip => {
              const active = status === chip.val
              return (
                <button key={chip.label}
                  onClick={() => { setStatus(chip.val); setPage(1) }}
                  className="flex-shrink-0 px-3 py-2 text-[11px] font-semibold border-b-2 transition-all whitespace-nowrap"
                  style={{ borderColor: active ? chip.color : 'transparent', color: active ? chip.color : 'var(--txt2)', background: 'none' }}>
                  {chip.label}
                </button>
              )
            })}
          </div>

          {/* Search + filters */}
          <div className="flex flex-col gap-1.5 px-3 py-2 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--bdr)', background: 'var(--bg)' }}>
            <div className="relative">
              <span className="material-symbols-rounded text-[14px] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--txt2)' }}>search</span>
              <input
                value={search}
                onChange={e => handleSearchChange(e.target.value)}
                placeholder="Search tickets…"
                className="w-full pl-7 pr-3 py-1.5 rounded-lg border text-[12px] outline-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
              />
            </div>
            <div className="flex gap-1.5">
              <FilterSelect value={priority}   options={PRIORITY_OPTIONS} onChange={setPriority}   label="Priority" />
              <FilterSelect value={department} options={DEPT_OPTIONS}     onChange={setDepartment} label="Department" />
            </div>
          </div>

          <ErrBanner msg={err} />

          {selectedIds.size > 0 && (
            <BulkBar
              count={selectedIds.size}
              agents={agents}
              onAssign={bulkAssign}
              onPriority={bulkPriority}
              onClose={bulkClose}
              onClear={() => setSelectedIds(new Set())}
            />
          )}

          {/* Ticket rows */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16"><Spinner size={24} /></div>
            ) : tickets.length === 0 ? (
              <div className="py-16 text-center">
                <span className="material-symbols-rounded text-[36px] block mb-2" style={{ color: 'var(--txt3)' }}>support_agent</span>
                <p className="text-[12px]" style={{ color: 'var(--txt2)' }}>No tickets found</p>
              </div>
            ) : tickets.map(t => {
              const sla = slaDisplay(t)
              const isSelected = selectedIds.has(t.id)
              const isPreview  = selectedTicket?.id === t.id
              return (
                <div key={t.id}
                  onClick={() => setSelectedTicket(t)}
                  className="cursor-pointer transition-colors hover:bg-[var(--row-hvr)]"
                  style={{
                    borderBottom: '1px solid var(--bdr)',
                    background: isPreview ? 'var(--row-sel)' : isSelected ? 'rgba(14,40,65,0.03)' : undefined,
                  }}>
                  <div className="flex items-start gap-2 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={e => { e.stopPropagation(); toggleSelect(t.id) }}
                      onClick={e => e.stopPropagation()}
                      className="mt-0.5 rounded flex-shrink-0 cursor-pointer"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-1 mb-1">
                        <p className="text-[13px] font-semibold leading-tight truncate" style={{ color: 'var(--txt)' }}>{t.subject}</p>
                        {sla.text !== '—' && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{ background: sla.bg, color: sla.color }}>
                            {sla.text === 'BREACHED' ? '⚠' : sla.text}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <StatusPill status={t.status} />
                        <PriorityPill priority={t.priority} />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] truncate" style={{ color: 'var(--txt2)' }}>{t.customer_name}</span>
                        <span className="text-[10px] flex-shrink-0 ml-1" style={{ color: 'var(--txt3)' }}>{relativeTime(t.last_message_at)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}

            {/* Pagination */}
            {!loading && totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 px-4 py-3 text-[12px]"
                style={{ borderTop: '1px solid var(--bdr)' }}>
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                  className="px-2.5 py-1 rounded-lg font-semibold bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
                  style={{ color: 'var(--txt)' }}>Prev</button>
                <span style={{ color: 'var(--txt2)' }}>{page} / {totalPages}</span>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                  className="px-2.5 py-1 rounded-lg font-semibold bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
                  style={{ color: 'var(--txt)' }}>Next</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Right preview panel ── */}
        <div className="flex-1 overflow-y-auto">
          {!selectedTicket ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <span className="material-symbols-rounded text-[52px]" style={{ color: 'var(--txt3)' }}>support_agent</span>
              <p className="text-[13px] font-medium" style={{ color: 'var(--txt2)' }}>Select a ticket to preview</p>
            </div>
          ) : (
            <TicketPreview ticket={selectedTicket} navigate={navigate} />
          )}
        </div>
      </div>

    </Page>
  )
}
