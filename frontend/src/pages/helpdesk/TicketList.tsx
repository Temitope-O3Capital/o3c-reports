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
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Page, KpiCard, SectionCard, Spinner, ErrBanner, DateFilter, NAVY, RED, AMBER, GREEN, BLUE } from '../../components/UI'
import { today, monthStart } from '../../lib/fmt'
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
  id:               number
  ticket_ref:       string
  subject:          string
  status:           string
  priority:         string
  channel:          string
  department:       string
  customer_name:    string
  customer_cif:     string
  assigned_to_name: string | null
  last_message_at:  string | null
  sla_due_at:       string | null
  created_at:       string
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
const DEPT_OPTIONS     = ['All','Cards Ops','Loans','Collections','Recovery','General','Compliance']
const PER_PAGE         = 25

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

function slaStatus(sla_due_at: string | null): 'breached' | 'soon' | null {
  if (!sla_due_at) return null
  const diff = new Date(sla_due_at).getTime() - Date.now()
  if (diff < 0)          return 'breached'
  if (diff < 3600000)    return 'soon'
  return null
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

// ── Main Component ────────────────────────────────────────────────────────────
export default function TicketList() {
  const navigate = useNavigate()

  // Stats
  const [stats, setStats]         = useState<HelpdeskStats | null>(null)
  const [statsLoading, setStatsL] = useState(true)

  // Tickets
  const [ticketPage, setTicketPage] = useState<TicketPage | null>(null)
  const [loading, setLoading]       = useState(true)
  const [err, setErr]               = useState('')
  const [page, setPage]             = useState(1)

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
  const [dateFrom,   setDateFrom]   = useState(monthStart())
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

  // Load stats (re-runs on date change)
  useEffect(() => {
    setStatsL(true)
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    apiFetch<HelpdeskStats>(`/api/helpdesk/stats?${qs}`)
      .then(setStats)
      .catch(() => {})
      .finally(() => setStatsL(false))
  }, [dateFrom, dateTo])

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
      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <KpiCard
          label="Open"
          value={statsLoading ? '—' : String(stats?.open ?? 0)}
          icon="inbox"
          accent={NAVY}
          loading={statsLoading}
        />
        <KpiCard
          label="Pending"
          value={statsLoading ? '—' : String(stats?.pending ?? 0)}
          icon="schedule"
          accent={AMBER}
          loading={statsLoading}
        />
        <KpiCard
          label="SLA Breached"
          value={statsLoading ? '—' : String(stats?.sla_breached ?? 0)}
          icon="alarm_off"
          accent={RED}
          loading={statsLoading}
        />
        <KpiCard
          label="Resolved Today"
          value={statsLoading ? '—' : String(stats?.resolved_today ?? 0)}
          icon="task_alt"
          accent={GREEN}
          loading={statsLoading}
        />
        <KpiCard
          label="Avg CSAT"
          value={stats?.avg_csat != null ? `⭐ ${Number(stats.avg_csat).toFixed(1)}` : '—'}
          icon="star"
          accent={AMBER}
          loading={statsLoading}
        />
      </div>

      {/* Filter bar */}
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
                  {['REF', 'SUBJECT', 'CUSTOMER', 'CHANNEL', 'STATUS', 'PRIORITY'].map(h => (
                    <th key={h}
                      className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-slate-400 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tickets.map(t => {
                  const sla = slaStatus(t.sla_due_at)
                  return (
                    <tr
                      key={t.id}
                      onClick={() => navigate(`/helpdesk/${t.id}`)}
                      className="transition-colors hover:bg-slate-50 cursor-pointer"
                      style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}
                    >
                      {/* Ref */}
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className="font-mono text-[12px] text-slate-600">{t.ticket_ref}</span>
                      </td>

                      {/* Subject */}
                      <td className="px-5 py-3 max-w-[240px]">
                        <p className="font-semibold text-slate-800 truncate">{t.subject}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {t.assigned_to_name ?? 'Unassigned'} · {relativeTime(t.last_message_at)}
                        </p>
                        {sla === 'breached' && (
                          <span className="text-[10px] font-bold text-red-600 mt-0.5 block">⚠ SLA BREACHED</span>
                        )}
                        {sla === 'soon' && (
                          <span className="text-[10px] font-bold text-amber-600 mt-0.5 block">🕐 SLA DUE SOON</span>
                        )}
                      </td>

                      {/* Customer */}
                      <td className="px-5 py-3 whitespace-nowrap">
                        <p className="text-slate-700 font-medium">{t.customer_name}</p>
                        {t.customer_cif && (
                          <span className="text-[11px] font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded mt-0.5 inline-block">
                            CIF:{t.customer_cif}
                          </span>
                        )}
                      </td>

                      {/* Channel */}
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-1 text-[12px] text-slate-500">
                          <span className="material-symbols-rounded text-[15px]">
                            {CHANNEL_ICON[t.channel?.toLowerCase()] ?? 'chat'}
                          </span>
                          {t.channel}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-5 py-3"><StatusPill status={t.status} /></td>

                      {/* Priority */}
                      <td className="px-5 py-3"><PriorityPill priority={t.priority} /></td>
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
    </Page>
  )
}
