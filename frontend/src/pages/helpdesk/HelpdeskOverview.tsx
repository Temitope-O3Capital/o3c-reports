import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPost } from '../../lib/api'
import { Page, KpiCard, SectionCard, Spinner, ErrBanner, NAVY, RED, AMBER, GREEN, BLUE } from '../../components/UI'
import { StatusPill } from './components'
import { toast } from 'sonner'
import ComposeTicket from './ComposeTicket'

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
  assigned_to_name: string | null
  last_message_at: string | null
  sla_due_at: string | null
  sla_breached: boolean
  first_response_at: string | null
  created_at: string
  updated_at?: string
}

interface TicketPage {
  data: Ticket[]
  total: number
}

interface HelpdeskStats {
  open: number
  pending: number
  sla_breached: number
  resolved_today: number
  avg_csat: number | null
  in_progress?: number
}

const PRIORITY_DOT: Record<string, string> = {
  urgent: RED,
  high:   '#EA580C',
  normal: '#94A3B8',
  low:    GREEN,
}

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

function slaCountdown(sla_due_at: string | null, sla_breached: boolean): { text: string; color: string } {
  if (sla_breached || (sla_due_at && new Date(sla_due_at).getTime() < Date.now())) {
    return { text: 'BREACHED', color: RED }
  }
  if (!sla_due_at) return { text: '', color: 'var(--txt2)' }
  const diff = new Date(sla_due_at).getTime() - Date.now()
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const text = h > 0 ? `${h}h ${m}m` : `${m}m`
  if (diff < 3600000)   return { text, color: RED }
  if (diff < 14400000)  return { text, color: AMBER }
  return { text, color: GREEN }
}

function PriorityDot({ priority }: { priority: string }) {
  const color = PRIORITY_DOT[priority.toLowerCase()] ?? '#94A3B8'
  return (
    <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
  )
}

function TicketCard({
  ticket,
  onNavigate,
  action,
}: {
  ticket: Ticket
  onNavigate: (id: number) => void
  action?: React.ReactNode
}) {
  const sla = slaCountdown(ticket.sla_due_at, ticket.sla_breached)
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--bg)] group"
      style={{ borderTop: '1px solid var(--bdr)' }}
      onClick={() => onNavigate(ticket.id)}
    >
      <PriorityDot priority={ticket.priority} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--txt)' }}>{ticket.subject}</p>
          <StatusPill status={ticket.status} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{ticket.customer_name}</span>
          <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>·</span>
          <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{relativeTime(ticket.last_message_at || ticket.created_at)}</span>
          {sla.text && (
            <>
              <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>·</span>
              <span className="text-[11px] font-semibold" style={{ color: sla.color }}>
                {sla.text === 'BREACHED' ? '⚠ SLA BREACHED' : `SLA: ${sla.text}`}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
        {action}
        <span className="material-symbols-rounded text-[16px] transition-colors" style={{ color: 'var(--txt3)' }}>
          arrow_forward
        </span>
      </div>
    </div>
  )
}

function SLAWarningCard({ ticket, onNavigate }: { ticket: Ticket; onNavigate: (id: number) => void }) {
  const sla = slaCountdown(ticket.sla_due_at, ticket.sla_breached)
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-red-50"
      style={{ borderTop: '1px solid rgba(192,0,0,0.08)', background: 'rgba(192,0,0,0.02)' }}
      onClick={() => onNavigate(ticket.id)}
    >
      <span className="material-symbols-rounded text-[18px]" style={{ color: RED }}>alarm</span>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--txt)' }}>{ticket.subject}</p>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--txt2)' }}>{ticket.customer_name} · {ticket.ticket_ref}</p>
      </div>
      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full flex-shrink-0"
        style={{ background: 'rgba(192,0,0,0.1)', color: RED }}>
        {sla.text === 'BREACHED' ? 'BREACHED' : `${sla.text} left`}
      </span>
    </div>
  )
}

export default function HelpdeskOverview() {
  const navigate = useNavigate()

  const [stats, setStats]           = useState<HelpdeskStats | null>(null)
  const [statsLoading, setStatsL]   = useState(true)

  const [myQueue, setMyQueue]       = useState<Ticket[]>([])
  const [myLoading, setMyLoading]   = useState(true)

  const [teamQueue, setTeamQueue]   = useState<Ticket[]>([])
  const [teamLoading, setTeamLoad]  = useState(true)

  const [slaWarn, setSlaWarn]       = useState<Ticket[]>([])
  const [slaLoading, setSlaLoad]    = useState(true)

  const [recent, setRecent]         = useState<Ticket[]>([])
  const [recentLoading, setRecLoad] = useState(true)

  const [compose, setCompose]       = useState(false)
  const [claiming, setClaiming]     = useState<number | null>(null)

  const load = useCallback(() => {
    setStatsL(true)
    apiFetch<HelpdeskStats>('/api/helpdesk/stats')
      .then(setStats).catch(() => {}).finally(() => setStatsL(false))

    setMyLoading(true)
    apiFetch<TicketPage>('/api/helpdesk/tickets?assigned_to=me&status=open&per_page=10')
      .then(r => setMyQueue(r?.data ?? [])).catch(() => {}).finally(() => setMyLoading(false))

    setTeamLoad(true)
    apiFetch<TicketPage>('/api/helpdesk/tickets?assigned_to=unassigned&status=open&per_page=10')
      .then(r => setTeamQueue(r?.data ?? [])).catch(() => {}).finally(() => setTeamLoad(false))

    setSlaLoad(true)
    apiFetch<TicketPage>('/api/helpdesk/tickets?sla_breached=true&per_page=20')
      .then(r => setSlaWarn(r?.data ?? [])).catch(() => {}).finally(() => setSlaLoad(false))

    setRecLoad(true)
    apiFetch<TicketPage>('/api/helpdesk/tickets?per_page=10')
      .then(r => setRecent(r?.data ?? [])).catch(() => {}).finally(() => setRecLoad(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function claimTicket(ticketId: number) {
    setClaiming(ticketId)
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/claim`, {})
      toast.success('Ticket claimed')
      load()
    } catch (e: any) {
      toast.error(e.message || 'Failed to claim ticket')
    } finally {
      setClaiming(null)
    }
  }

  const slaWarnings = slaWarn.filter(t =>
    t.sla_breached ||
    (t.sla_due_at && new Date(t.sla_due_at).getTime() - Date.now() < 2 * 3600000)
  )

  return (
    <Page
      dept="Customer Service"
      title="Helpdesk"
      subtitle="Your support queue at a glance"
      actions={
        <button
          onClick={() => setCompose(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}
        >
          <span className="material-symbols-rounded text-[16px]">add</span>
          New Ticket
        </button>
      }
    >
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <KpiCard loading={statsLoading} label="Open"           value={String(stats?.open ?? 0)}           icon="inbox"     accent={NAVY}  />
        <KpiCard loading={statsLoading} label="My Open"        value={String(myQueue.length)}             icon="person"    accent={BLUE}  />
        <KpiCard loading={statsLoading} label="SLA Breached"   value={String(stats?.sla_breached ?? 0)}  icon="alarm_off" accent={RED}   />
        <KpiCard loading={statsLoading} label="Resolved Today" value={String(stats?.resolved_today ?? 0)} icon="task_alt" accent={GREEN} />
      </div>

      {/* SLA Warnings (only shown when there are any) */}
      {(slaLoading || slaWarnings.length > 0) && (
        <SectionCard
          title="SLA Warnings"
          badge={slaWarnings.length}
          className="mb-6"
          actions={
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(192,0,0,0.1)', color: RED }}>
              Urgent
            </span>
          }
        >
          {slaLoading ? (
            <div className="flex items-center justify-center py-8"><Spinner size={24} /></div>
          ) : slaWarnings.length === 0 ? null : (
            slaWarnings.map(t => (
              <SLAWarningCard key={t.id} ticket={t} onNavigate={id => navigate(`/helpdesk/${id}`)} />
            ))
          )}
        </SectionCard>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* My Queue */}
        <SectionCard
          title="My Queue"
          badge={myQueue.length}
          actions={
            <button
              onClick={() => navigate('/helpdesk/tickets?assigned_to=me')}
              className="text-[12px] font-medium transition-colors" style={{ color: 'var(--txt2)' }}
            >
              View all
            </button>
          }
        >
          {myLoading ? (
            <div className="flex items-center justify-center py-10"><Spinner size={24} /></div>
          ) : myQueue.length === 0 ? (
            <div className="py-10 text-center">
              <span className="material-symbols-rounded text-[36px] block mb-2" style={{ color: 'var(--txt3)' }}>inbox</span>
              <p className="text-[13px]" style={{ color: 'var(--txt2)' }}>Your queue is empty</p>
            </div>
          ) : (
            myQueue.map(t => (
              <TicketCard
                key={t.id}
                ticket={t}
                onNavigate={id => navigate(`/helpdesk/${id}`)}
              />
            ))
          )}
        </SectionCard>

        {/* Team Queue */}
        <SectionCard
          title="Team Queue"
          badge={teamQueue.length}
          subtitle="Unassigned open tickets"
          actions={
            <button
              onClick={() => navigate('/helpdesk/tickets?assigned_to=unassigned')}
              className="text-[12px] font-medium transition-colors" style={{ color: 'var(--txt2)' }}
            >
              View all
            </button>
          }
        >
          {teamLoading ? (
            <div className="flex items-center justify-center py-10"><Spinner size={24} /></div>
          ) : teamQueue.length === 0 ? (
            <div className="py-10 text-center">
              <span className="material-symbols-rounded text-[36px] block mb-2" style={{ color: 'var(--txt3)' }}>group</span>
              <p className="text-[13px]" style={{ color: 'var(--txt2)' }}>No unassigned tickets</p>
            </div>
          ) : (
            teamQueue.map(t => (
              <TicketCard
                key={t.id}
                ticket={t}
                onNavigate={id => navigate(`/helpdesk/${id}`)}
                action={
                  <button
                    disabled={claiming === t.id}
                    onClick={e => { e.stopPropagation(); claimTicket(t.id) }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all disabled:opacity-50"
                    style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY, background: 'var(--card)' }}
                  >
                    <span className="material-symbols-rounded text-[13px]">
                      {claiming === t.id ? 'progress_activity' : 'person_add'}
                    </span>
                    {claiming === t.id ? 'Claiming…' : 'Claim'}
                  </button>
                }
              />
            ))
          )}
        </SectionCard>
      </div>

      {/* Recent Activity */}
      <SectionCard
        title="Recent Activity"
        subtitle="Last 10 tickets updated"
        actions={
          <button
            onClick={() => navigate('/helpdesk/tickets')}
            className="text-[12px] font-medium transition-colors" style={{ color: 'var(--txt2)' }}
          >
            All tickets
          </button>
        }
      >
        {recentLoading ? (
          <div className="flex items-center justify-center py-10"><Spinner size={24} /></div>
        ) : recent.length === 0 ? (
          <div className="py-10 text-center">
            <span className="material-symbols-rounded text-[36px] block mb-2" style={{ color: 'var(--txt3)' }}>history</span>
            <p className="text-[13px]" style={{ color: 'var(--txt2)' }}>No recent activity</p>
          </div>
        ) : (
          recent.map(t => (
            <TicketCard
              key={t.id}
              ticket={t}
              onNavigate={id => navigate(`/helpdesk/${id}`)}
            />
          ))
        )}
      </SectionCard>

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
