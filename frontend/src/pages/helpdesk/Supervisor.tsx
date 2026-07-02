import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'

const NAVY = '#0E2841'
const RED  = '#C00000'

interface Totals  { open: number; sla_breached: number; unassigned: number; active_agents: number }
interface Agent   { id: number; full_name: string; open_tickets: number; sla_breached: number; last_reply: string | null }
interface Queue   { queue: string; open: number; sla_breached: number; unassigned: number }
interface Breach  { id: number; ticket_ref: string; subject: string; priority: string; sla_due_at: string; assigned_to_name: string | null }

export default function Supervisor() {
  const [totals,  setTotals]  = useState<Totals>({ open: 0, sla_breached: 0, unassigned: 0, active_agents: 0 })
  const [agents,  setAgents]  = useState<Agent[]>([])
  const [queues,  setQueues]  = useState<Queue[]>([])
  const [breaches,setBreaches]= useState<Breach[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRef, setLastRef] = useState('')

  async function load() {
    try {
      const d = await apiFetch('/api/helpdesk/supervisor')
      setTotals(d.totals ?? { open: 0, sla_breached: 0, unassigned: 0, active_agents: 0 })
      setAgents(d.agents ?? [])
      setQueues(d.queues ?? [])
      setBreaches(d.recent_breaches ?? [])
      setLastRef(new Date().toLocaleTimeString())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Auto-refresh every 60 s
  useEffect(() => {
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  const kpis = [
    { label: 'Open Tickets',   value: totals.open,          icon: 'confirmation_number', color: NAVY },
    { label: 'SLA Breached',   value: totals.sla_breached,  icon: 'timer_off',           color: RED  },
    { label: 'Unassigned',     value: totals.unassigned,    icon: 'person_off',          color: '#B45309' },
    { label: 'Active Agents',  value: totals.active_agents, icon: 'headset_mic',         color: '#059669' },
  ]

  const maxLoad = Math.max(...agents.map(a => Number(a.open_tickets) || 0), 1)

  return (
    <div style={{ background: '#F4F6F8', minHeight: '100vh', padding: '28px 32px' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-bold" style={{ color: NAVY }}>Supervisor View</h1>
          <p className="text-[13px] text-slate-400 mt-0.5">Live helpdesk monitoring</p>
        </div>
        <div className="flex items-center gap-3">
          {lastRef && <span className="text-[12px] text-slate-400">Refreshed {lastRef}</span>}
          <button onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors"
            style={{ background: 'rgba(14,40,65,0.06)', color: NAVY }}>
            <span className="material-symbols-rounded text-[15px]">refresh</span>
            Refresh
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpis.map(k => (
          <div key={k.label} className="bg-white rounded-xl p-4 shadow-sm"
            style={{ border: '1px solid rgba(15,23,42,0.07)' }}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{k.label}</p>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: `${k.color}12` }}>
                <span className="material-symbols-rounded text-[17px]" style={{ color: k.color }}>{k.icon}</span>
              </div>
            </div>
            <p className="text-[28px] font-bold" style={{ color: loading ? '#CBD5E1' : k.color }}>
              {loading ? '—' : k.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Agent load grid */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm"
          style={{ border: '1px solid rgba(15,23,42,0.07)' }}>
          <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(15,23,42,0.07)' }}>
            <h2 className="text-[14px] font-semibold" style={{ color: NAVY }}>Agent Load</h2>
          </div>
          {loading ? (
            <div className="px-5 py-8 text-center text-slate-400 text-sm">Loading…</div>
          ) : agents.length === 0 ? (
            <div className="px-5 py-8 text-center text-slate-400 text-sm">No active agents</div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.05)' }}>
              {agents.map(a => {
                const pct = Math.round((Number(a.open_tickets) / maxLoad) * 100)
                const breachPct = Number(a.open_tickets) > 0
                  ? Math.round((Number(a.sla_breached) / Number(a.open_tickets)) * 100)
                  : 0
                return (
                  <div key={a.id} className="px-5 py-3.5 flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0"
                      style={{ background: NAVY }}>
                      {(a.full_name || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[13px] font-medium text-slate-700 truncate">{a.full_name}</span>
                        <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                          <span className="text-[12px] text-slate-500">{a.open_tickets} open</span>
                          {Number(a.sla_breached) > 0 && (
                            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{ background: 'rgba(192,0,0,0.08)', color: RED }}>
                              {a.sla_breached} breached
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#F1F5F9' }}>
                        <div className="h-full rounded-full transition-all"
                          style={{
                            width: `${pct}%`,
                            background: breachPct > 30 ? RED : NAVY,
                          }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Queue breakdown */}
        <div className="bg-white rounded-xl shadow-sm"
          style={{ border: '1px solid rgba(15,23,42,0.07)' }}>
          <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(15,23,42,0.07)' }}>
            <h2 className="text-[14px] font-semibold" style={{ color: NAVY }}>Queues</h2>
          </div>
          {loading ? (
            <div className="px-5 py-8 text-center text-slate-400 text-sm">Loading…</div>
          ) : queues.length === 0 ? (
            <div className="px-5 py-8 text-center text-slate-400 text-sm">No open queues</div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.05)' }}>
              {queues.map(q => (
                <div key={q.queue} className="px-5 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] font-medium text-slate-700 capitalize">
                      {q.queue.replace(/_/g, ' ')}
                    </span>
                    <span className="text-[13px] font-semibold" style={{ color: NAVY }}>{q.open}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-slate-400">
                    {Number(q.sla_breached) > 0 && (
                      <span style={{ color: RED }}>{q.sla_breached} breached</span>
                    )}
                    {Number(q.unassigned) > 0 && (
                      <span style={{ color: '#B45309' }}>{q.unassigned} unassigned</span>
                    )}
                    {Number(q.sla_breached) === 0 && Number(q.unassigned) === 0 && (
                      <span style={{ color: '#059669' }}>All assigned, SLA OK</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* SLA breach feed */}
      {(breaches.length > 0 || loading) && (
        <div className="mt-4 bg-white rounded-xl shadow-sm"
          style={{ border: '1px solid rgba(192,0,0,0.18)' }}>
          <div className="px-5 py-4 border-b flex items-center gap-2"
            style={{ borderColor: 'rgba(192,0,0,0.12)' }}>
            <span className="material-symbols-rounded text-[17px]" style={{ color: RED }}>timer_off</span>
            <h2 className="text-[14px] font-semibold" style={{ color: RED }}>SLA Breaches</h2>
          </div>
          <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.05)' }}>
            {breaches.map(b => {
              const minsOverdue = Math.round((Date.now() - new Date(b.sla_due_at).getTime()) / 60_000)
              return (
                <a key={b.id} href={`/helpdesk/${b.id}`}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-red-50 transition-colors cursor-pointer">
                  <span className="text-[12px] font-mono text-slate-400 flex-shrink-0">{b.ticket_ref || `#${b.id}`}</span>
                  <span className="text-[13px] text-slate-700 flex-1 truncate">{b.subject}</span>
                  <span className="text-[12px] flex-shrink-0" style={{ color: RED }}>{minsOverdue}m overdue</span>
                  <span className="text-[12px] text-slate-400 flex-shrink-0">{b.assigned_to_name || 'Unassigned'}</span>
                </a>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
