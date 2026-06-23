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
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Page, KpiCard, SectionCard, Spinner, ErrBanner, DateFilter, NAVY, RED, AMBER, GREEN, BLUE } from '../../components/UI'
import { today, yearStart } from '../../lib/fmt'
import ComposeTicket from './ComposeTicket'

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
  if (!first_response_at) return { text: '—', color: '#94A3B8' }
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
  return { text: '—', bg: 'transparent', color: '#94A3B8' }
}

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
}

function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase().replace(/\s+/g, '_')
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

function FilterSelect({ value, options, onChange, label }: {
  value: string; options: string[]; onChange: (v: string) => void; label: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white appearance-none pr-7 outline-none"
      style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155', minWidth: 110 }}
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
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-2xl px-5 py-3 shadow-2xl text-white text-[12px]"
      style={{ background: '#0F172A', minWidth: 520 }}>
      <span className="font-semibold">{count} selected</span>
      <div className="w-px h-5 bg-slate-600 mx-1" />

      {/* Assign to */}
      <select
        value={agentVal}
        onChange={e => setAgentVal(e.target.value)}
        className="px-2.5 py-1.5 rounded-lg text-[12px] bg-slate-700 border border-slate-600 text-white outline-none">
        <option value="">Assign to…</option>
        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <button
        disabled={!agentVal}
        onClick={() => { onAssign(Number(agentVal)); setAgentVal('') }}
        className="px-2.5 py-1.5 rounded-lg font-semibold bg-white text-slate-900 disabled:opacity-40">
        Apply
      </button>

      <div className="w-px h-5 bg-slate-600 mx-1" />

      {/* Set priority */}
      <select
        value={prioVal}
        onChange={e => setPrioVal(e.target.value)}
        className="px-2.5 py-1.5 rounded-lg text-[12px] bg-slate-700 border border-slate-600 text-white outline-none">
        <option value="">Set Priority…</option>
        {['urgent','high','normal','low'].map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <button
        disabled={!prioVal}
        onClick={() => { onPriority(prioVal); setPrioVal('') }}
        className="px-2.5 py-1.5 rounded-lg font-semibold bg-white text-slate-900 disabled:opacity-40">
        Apply
      </button>

      <div className="w-px h-5 bg-slate-600 mx-1" />

      <button onClick={onCloseSelected}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-semibold"
        style={{ background: 'rgba(5,150,105,0.25)', color: '#6EE7B7' }}>
        <span className="material-symbols-rounded text-[14px]">check_circle</span>
        Close Selected
      </button>

      <button onClick={onClear}
        className="ml-auto w-6 h-6 flex items-center justify-center rounded-full hover:bg-slate-700">
        <span className="material-symbols-rounded text-[15px] text-slate-400">close</span>
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
          className="flex items-center gap-3 bg-white rounded-xl px-4 py-3 flex-1"
          style={{ border: '1px solid rgba(15,23,42,0.07)' }}>
          <span className="material-symbols-rounded text-[20px]" style={{ color: item.color }}>{item.icon}</span>
          <div>
            <p className="text-[18px] font-bold text-slate-800 leading-tight">{item.value}</p>
            <p className="text-[11px] text-slate-400">{item.label}</p>
          </div>
        </div>
      ))}
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
  const [compose,    setCompose]    = useState(false)
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
  }, [dateFrom, dateTo])

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
      .then(setTicketPage)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [status, priority, channel, department, assignedTo, searchQ, myTickets, page, dateFrom, dateTo])

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
          <button
            onClick={() => setCompose(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
            style={{ background: NAVY }}
          >
            <span className="material-symbols-rounded text-[16px]">add</span>
            New Ticket
          </button>
        </div>
      }
    >
      {/* Quick stats bar */}
      <QuickStats stats={stats} tickets={tickets} statsLoading={statsLoading} />

      {/* Full KPI strip */}
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

      {/* Filter bar + table */}
      <SectionCard
        title="Tickets"
        badge={ticketPage?.total}
        actions={
          <button
            onClick={() => setMyTickets(m => !m)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all"
            style={{
              borderColor: myTickets ? NAVY : 'rgba(15,23,42,0.15)',
              background:  myTickets ? `${NAVY}0f` : 'white',
              color:       myTickets ? NAVY : '#64748B',
            }}
          >
            <span className="material-symbols-rounded text-[15px]">person</span>
            My Tickets
          </button>
        }
      >
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-3"
          style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
          <FilterSelect value={status}     options={STATUS_OPTIONS}   onChange={setStatus}     label="Status" />
          <FilterSelect value={priority}   options={PRIORITY_OPTIONS} onChange={setPriority}   label="Priority" />
          <FilterSelect value={channel}    options={CHANNEL_OPTIONS}  onChange={setChannel}    label="Channel" />
          <FilterSelect value={department} options={DEPT_OPTIONS}     onChange={setDepartment} label="Department" />
          <input
            value={assignedTo}
            onChange={e => setAssignedTo(e.target.value)}
            placeholder="Assigned to…"
            className="px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white outline-none"
            style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155', minWidth: 130 }}
          />
          <div className="flex-1 relative" style={{ minWidth: 180 }}>
            <span className="material-symbols-rounded text-[16px] absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              search
            </span>
            <input
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search tickets…"
              className="w-full pl-9 pr-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155' }}
            />
          </div>
        </div>

        <ErrBanner msg={err} />

        {/* Table */}
        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
          ) : tickets.length === 0 ? (
            <div className="py-16 text-center">
              <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">support_agent</span>
              <p className="text-[13px] text-slate-400">No tickets found</p>
              <p className="text-[12px] text-slate-400 mt-1">Try adjusting your filters</p>
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: '#F8FAFC', borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
                  {/* Checkbox */}
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === tickets.length && tickets.length > 0}
                      onChange={toggleAll}
                      className="rounded cursor-pointer"
                    />
                  </th>
                  {['REF', 'SUBJECT', 'CUSTOMER', 'CHANNEL', 'STATUS', 'PRIORITY', 'FRT', 'SLA'].map(h => (
                    <th key={h}
                      className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-slate-400 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tickets.map(t => {
                  const frt = frtDisplay(t.first_response_at, t.created_at)
                  const sla = slaDisplay(t)
                  const isSelected = selectedIds.has(t.id)
                  return (
                    <tr
                      key={t.id}
                      className="transition-colors hover:bg-slate-50 cursor-pointer"
                      style={{
                        borderTop: '1px solid rgba(15,23,42,0.05)',
                        background: isSelected ? 'rgba(14,40,65,0.03)' : undefined,
                      }}
                    >
                      {/* Checkbox */}
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(t.id)}
                          className="rounded cursor-pointer"
                        />
                      </td>

                      {/* Ref */}
                      <td className="px-5 py-3 whitespace-nowrap" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        <span className="font-mono text-[12px] text-slate-600">{t.ticket_ref}</span>
                      </td>

                      {/* Subject */}
                      <td className="px-5 py-3 max-w-[240px]" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        <p className="font-semibold text-slate-800 truncate">{t.subject}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {t.assigned_to_name ?? 'Unassigned'} · {relativeTime(t.last_message_at)}
                        </p>
                        {sla.text === 'BREACHED' && (
                          <span className="text-[10px] font-bold text-red-600 mt-0.5 block">⚠ SLA BREACHED</span>
                        )}
                      </td>

                      {/* Customer */}
                      <td className="px-5 py-3 whitespace-nowrap" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        <p className="text-slate-700 font-medium">{t.customer_name}</p>
                        {t.customer_cif && (
                          <span className="text-[11px] font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded mt-0.5 inline-block">
                            CIF:{t.customer_cif}
                          </span>
                        )}
                      </td>

                      {/* Channel */}
                      <td className="px-5 py-3" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        <span className="flex items-center gap-1 text-[12px] text-slate-500">
                          <span className="material-symbols-rounded text-[15px]">
                            {CHANNEL_ICON[t.channel?.toLowerCase()] ?? 'chat'}
                          </span>
                          {t.channel}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-5 py-3" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        <StatusPill status={t.status} />
                      </td>

                      {/* Priority */}
                      <td className="px-5 py-3" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        <PriorityPill priority={t.priority} />
                      </td>

                      {/* FRT */}
                      <td className="px-5 py-3 whitespace-nowrap" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        <span className="text-[12px] font-semibold" style={{ color: frt.color }}>
                          {frt.text}
                        </span>
                      </td>

                      {/* SLA */}
                      <td className="px-5 py-3 whitespace-nowrap" onClick={() => navigate(`/helpdesk/${t.id}`)}>
                        {sla.text !== '—' ? (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                            style={{ background: sla.bg, color: sla.color }}>
                            {sla.text}
                          </span>
                        ) : (
                          <span className="text-[12px] text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3"
            style={{ borderTop: '1px solid rgba(15,23,42,0.07)' }}>
            <span className="text-[12px] text-slate-400">
              Page {page} of {totalPages} · {ticketPage?.total ?? 0} tickets
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
              >
                Prev
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Compose modal */}
      <ComposeTicket
        open={compose}
        onClose={() => setCompose(false)}
        onCreated={ticket => {
          setCompose(false)
          navigate(`/helpdesk/${ticket.id}`)
        }}
      />

      {/* Bulk action bar */}
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
    </Page>
  )
}
