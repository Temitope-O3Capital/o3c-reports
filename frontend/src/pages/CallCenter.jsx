import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { InfoTooltip, fmtNum } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem, CHIP_OFF, toISO, fmtDate, presetRange } from '../components/FilterBar.jsx'

/* ══════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════ */

function today() { return toISO(new Date()) }

function defaultRange() {
  const d    = new Date()
  const from = new Date(d.getFullYear(), d.getMonth(), 1)
  return [toISO(from), toISO(d)]
}

function fmtMins(mins) {
  if (!mins && mins !== 0) return '—'
  const m = Math.round(Number(mins))
  if (m < 60)  return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r > 0 ? `${h}h ${r}m` : `${h}h`
}

function fmtTs(s) {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return s }
}

/* ══════════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ══════════════════════════════════════════════════════════════════ */

function KPI({ label, value, sub, icon, accent = '#0E2841', valueColor, tooltip }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"', color: valueColor || 'rgb(var(--fg-1))' }}>
        {value}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

/* Horizontal bar for channel/status breakdown */
function BreakdownBar({ items, total, colorMap }) {
  if (!items?.length) return null
  return (
    <div>
      {/* Stacked bar */}
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', marginBottom: 16 }}>
        {items.map((it, i) => {
          const pct = total > 0 ? (Number(it.total || it.count || 0) / total) * 100 : 0
          return (
            <div key={i} style={{ width: `${pct}%`, background: colorMap[i % colorMap.length] }} title={`${it.label}: ${Math.round(pct)}%`} />
          )
        })}
      </div>
      {/* Legend rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((it, i) => {
          const cnt = Number(it.total || it.count || 0)
          const pct = total > 0 ? ((cnt / total) * 100).toFixed(1) : '0.0'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: colorMap[i % colorMap.length], flexShrink: 0 }} />
                <p style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--fg-1))', textTransform: 'capitalize' }}>{it.label}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))', fontVariantNumeric: 'tabular-nums' }}>{pct}%</p>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'rgb(var(--fg-1))', fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>{fmtNum(cnt)}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const STATUS_COLORS  = ['#0E2841', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#C00000', '#64748B']
const CHANNEL_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#0E2841', '#0891B2']

/* ══════════════════════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'overview',  label: 'Overview',    icon: 'dashboard'     },
  { key: 'tickets',   label: 'Tickets',     icon: 'confirmation_number' },
  { key: 'agents',    label: 'Agents',      icon: 'people'        },
  { key: 'channels',  label: 'By Channel',  icon: 'forum'         },
]

/* ── Overview tab ── */
function OverviewTab({ dateFrom, dateTo }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const d = await apiFetch(`/api/call-center/summary?date_from=${dateFrom}&date_to=${dateTo}`)
      setData(d)
    } catch { setData(null) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return (
    <div className="flex items-center gap-3 text-slate-400 py-12"><div className="spinner" />Loading…</div>
  )
  if (!data) return null

  if (data.configured === false) {
    return (
      <div className="card p-12 flex flex-col items-center text-slate-400 gap-3">
        <span className="material-symbols-rounded text-[48px] opacity-25">headset_mic</span>
        <p className="font-semibold text-slate-600 dark:text-slate-300">Zoho Desk not configured</p>
        <p className="text-sm text-center max-w-xs">{data.message || 'Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, and ZOHO_ORG_ID in the backend environment.'}</p>
      </div>
    )
  }

  const totalTickets = Number(data.total_tickets || 0)
  const statusItems  = Object.entries(data.by_status  || {}).map(([label, count]) => ({ label, total: count }))
    .sort((a, b) => Number(b.total) - Number(a.total))
  const channelItems = Object.entries(data.by_channel || {}).map(([label, v]) => ({ label, total: typeof v === 'object' ? v.total : v }))
    .sort((a, b) => Number(b.total) - Number(a.total))

  return (
    <div>
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-5">
        <KPI label="Total Tickets"    value={fmtNum(data.total_tickets)}      icon="confirmation_number" accent="#0E2841"
          tooltip="All tickets created in the selected period" />
        <KPI label="Open"             value={fmtNum(data.open_tickets)}        icon="radio_button_unchecked" accent="#F59E0B"
          valueColor="#D97706" />
        <KPI label="Resolved"         value={fmtNum(data.resolved_tickets)}    icon="check_circle" accent="#059669"
          valueColor="#059669" />
        <KPI label="Avg Response"     value={fmtMins(data.avg_response_time_mins)} icon="timer" accent="#8B5CF6"
          tooltip="Average time from ticket creation to first agent response" />
        <KPI label="Avg Resolution"   value={fmtMins(data.avg_resolution_time_mins)} icon="hourglass_bottom" accent="#0891B2"
          tooltip="Average time from creation to ticket closure" />
        <KPI label="Agents Active"    value={fmtNum(data.agent_count)}         icon="people" accent="#3B82F6" />
      </div>

      {/* Status + Channel breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <div className="card p-5">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>
            By Status
          </p>
          <BreakdownBar items={statusItems} total={totalTickets} colorMap={STATUS_COLORS} />
        </div>
        <div className="card p-5">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>
            By Channel
          </p>
          <BreakdownBar items={channelItems} total={totalTickets} colorMap={CHANNEL_COLORS} />
        </div>
      </div>

      {/* Agent leaderboard */}
      {data.agent_leaderboard?.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Agent Leaderboard</p>
            <p className="text-xs text-slate-400 mt-0.5">Resolved tickets in the selected period</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>#</th>
                  <th>Agent</th>
                  <th className="text-right">Resolved</th>
                  <th className="text-right">Avg Response</th>
                </tr>
              </thead>
              <tbody>
                {data.agent_leaderboard.map((ag, i) => (
                  <tr key={i}>
                    <td>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 700,
                        background: i < 3 ? '#0E284115' : 'rgb(var(--bg-subtle))',
                        color: i < 3 ? '#0E2841' : 'rgb(var(--fg-3))',
                      }}>
                        {i + 1}
                      </span>
                    </td>
                    <td>
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{ag.name || ag.agent_name || '—'}</p>
                      <p className="text-xs text-slate-400">{ag.email || ''}</p>
                    </td>
                    <td className="text-right font-semibold tabular-nums">{fmtNum(ag.resolved_count || ag.resolved)}</td>
                    <td className="text-right text-sm text-slate-500 tabular-nums">{fmtMins(ag.avg_response_mins)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Tickets tab ── */
const TICKET_STATUSES = ['', 'Open', 'On Hold', 'Escalated', 'Closed']
const TICKET_PRIORITIES = ['', 'Low', 'Medium', 'High', 'Urgent']
const TICKET_CHANNELS   = ['', 'Phone', 'Email', 'Chat', 'Social', 'Web', 'API']

function TicketsTab({ dateFrom, dateTo }) {
  const [tickets,  setTickets]  = useState([])
  const [loading,  setLoading]  = useState(false)
  const [page,     setPage]     = useState(1)
  const [status,   setStatus]   = useState('')
  const [channel,  setChannel]  = useState('')
  const [priority, setPriority] = useState('')
  const PER_PAGE = 100

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const p = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, page, per_page: PER_PAGE })
      if (status)   p.set('status', status)
      if (channel)  p.set('channel', channel)
      if (priority) p.set('priority', priority)
      const data = await apiFetch(`/api/call-center/tickets?${p}`)
      setTickets(Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []))
    } catch { setTickets([]) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo, page, status, channel, priority])

  useEffect(() => { load() }, [load])

  function statusColor(s) {
    const m = { 'Open': '#F59E0B', 'Closed': '#059669', 'Escalated': '#C00000', 'On Hold': '#8B5CF6' }
    return m[s] || '#64748B'
  }
  function priorityColor(p) {
    const m = { 'Urgent': '#C00000', 'High': '#F59E0B', 'Medium': '#3B82F6', 'Low': '#94A3B8' }
    return m[p] || '#64748B'
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between flex-wrap gap-3"
        style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Tickets</p>
          <p className="text-xs text-slate-400 mt-0.5">{fmtDate(dateFrom)} – {fmtDate(dateTo)}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <FilterChip label={status || 'Status'} active={!!status} onClear={() => { setStatus(''); setPage(1) }}>
            {TICKET_STATUSES.map(s => (
              <DropItem key={s || 'all'} label={s || 'All Statuses'} selected={status === s} onClick={() => { setStatus(s); setPage(1) }} />
            ))}
          </FilterChip>
          <FilterChip label={channel || 'Channel'} active={!!channel} onClear={() => { setChannel(''); setPage(1) }}>
            {TICKET_CHANNELS.map(c => (
              <DropItem key={c || 'all'} label={c || 'All Channels'} selected={channel === c} onClick={() => { setChannel(c); setPage(1) }} />
            ))}
          </FilterChip>
          <FilterChip label={priority || 'Priority'} active={!!priority} onClear={() => { setPriority(''); setPage(1) }}>
            {TICKET_PRIORITIES.map(p => (
              <DropItem key={p || 'all'} label={p || 'All Priorities'} selected={priority === p} onClick={() => { setPriority(p); setPage(1) }} />
            ))}
          </FilterChip>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticket #</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Channel</th>
              <th>Assignee</th>
              <th>Created</th>
              <th>Response Time</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="text-center py-10 text-slate-400">
                <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
              </td></tr>
            ) : tickets.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-10">
                <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">confirmation_number</span>
                <p className="text-sm text-slate-400">No tickets for this period and filter</p>
              </td></tr>
            ) : tickets.map((t, i) => (
              <tr key={i}>
                <td className="font-mono text-xs text-slate-500">#{t.ticketNumber || t.id}</td>
                <td>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100 max-w-[220px] truncate" title={t.subject}>
                    {t.subject || '—'}
                  </p>
                </td>
                <td>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center',
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                    background: statusColor(t.status) + '18',
                    color: statusColor(t.status),
                  }}>
                    {t.status || '—'}
                  </span>
                </td>
                <td>
                  {t.priority && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center',
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
                      background: priorityColor(t.priority) + '15',
                      color: priorityColor(t.priority),
                    }}>
                      {t.priority}
                    </span>
                  )}
                </td>
                <td className="text-xs text-slate-500 capitalize">{t.channel || '—'}</td>
                <td className="text-xs text-slate-600 dark:text-slate-400">
                  {t.assignee?.name || t.assignedTo || '—'}
                </td>
                <td className="text-xs text-slate-500 whitespace-nowrap">{fmtTs(t.createdTime)}</td>
                <td className="text-xs tabular-nums text-slate-500">{fmtMins(t.response_time_mins)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(tickets.length >= PER_PAGE || page > 1) && (
        <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
          <p className="text-xs text-slate-400">Page {page}</p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="btn btn-ghost btn-sm disabled:opacity-40">
              <span className="material-symbols-rounded text-[17px]">chevron_left</span>
            </button>
            <button onClick={() => setPage(p => p + 1)} disabled={tickets.length < PER_PAGE}
              className="btn btn-ghost btn-sm disabled:opacity-40">
              <span className="material-symbols-rounded text-[17px]">chevron_right</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Agents tab ── */
function AgentsTab() {
  const [agents,  setAgents]  = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    apiFetch('/api/call-center/agents')
      .then(d => setAgents(Array.isArray(d.data) ? d.data : (Array.isArray(d) ? d : [])))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Support Agents</p>
        <p className="text-xs text-slate-400 mt-0.5">Current queue and today's resolution counts</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Email</th>
              <th>Role</th>
              <th className="text-right">Open Tickets</th>
              <th className="text-right">Resolved Today</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center py-10 text-slate-400">
                <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
              </td></tr>
            ) : agents.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-10">
                <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">people</span>
                <p className="text-sm text-slate-400">No agent data available</p>
              </td></tr>
            ) : agents.map((ag, i) => {
              const online = ag.availability === 'ONLINE' || ag.status === 'Online'
              return (
                <tr key={i}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <div style={{
                        width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                        background: '#0E284118',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 700, color: '#0E2841',
                      }}>
                        {(ag.name || ag.firstName || '?').charAt(0).toUpperCase()}
                      </div>
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {ag.name || `${ag.firstName || ''} ${ag.lastName || ''}`.trim() || '—'}
                      </p>
                    </div>
                  </td>
                  <td className="text-xs text-slate-500">{ag.email || '—'}</td>
                  <td className="text-xs text-slate-500 capitalize">{ag.roleKey || ag.role || '—'}</td>
                  <td className="text-right">
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: Number(ag.open_tickets) > 10 ? '#C00000' : 'rgb(var(--fg-1))' }}>
                      {ag.open_tickets ?? '—'}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{ag.resolved_today ?? '—'}</td>
                  <td>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                      background: online ? '#F0FDF4' : 'rgb(var(--bg-subtle))',
                      color: online ? '#059669' : 'rgb(var(--fg-3))',
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: online ? '#059669' : '#94A3B8' }} />
                      {online ? 'Online' : (ag.availability || ag.status || 'Offline')}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── By-Channel tab ── */
function ByChannelTab({ dateFrom, dateTo }) {
  const [data,    setData]    = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const res = await apiFetch(`/api/call-center/by-channel?date_from=${dateFrom}&date_to=${dateTo}`)
      const rows = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : [])
      setData(rows)
    } catch { setData([]) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const total = data.reduce((s, r) => s + Number(r.total || 0), 0)

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Channel Breakdown</p>
        <p className="text-xs text-slate-400 mt-0.5">{fmtDate(dateFrom)} – {fmtDate(dateTo)}</p>
      </div>
      {loading ? (
        <div className="flex items-center gap-3 text-slate-400 py-10 px-6"><div className="spinner" />Loading…</div>
      ) : data.length === 0 ? (
        <div className="py-10 flex flex-col items-center text-slate-400">
          <span className="material-symbols-rounded text-[36px] opacity-25 mb-2">forum</span>
          <p className="text-sm">No channel data for this period</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="text-right">Total</th>
                <th className="text-right">Open</th>
                <th className="text-right">Resolved</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {data.sort((a, b) => Number(b.total) - Number(a.total)).map((ch, i) => {
                const pct = total > 0 ? (Number(ch.total) / total) * 100 : 0
                return (
                  <tr key={i}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: CHANNEL_COLORS[i % CHANNEL_COLORS.length], flexShrink: 0 }} />
                        <p className="text-sm font-medium capitalize">{ch.channel || ch.label || '—'}</p>
                      </div>
                    </td>
                    <td className="text-right font-semibold tabular-nums">{fmtNum(ch.total)}</td>
                    <td className="text-right tabular-nums" style={{ color: '#D97706' }}>{fmtNum(ch.open)}</td>
                    <td className="text-right tabular-nums" style={{ color: '#059669' }}>{fmtNum(ch.resolved)}</td>
                    <td style={{ minWidth: 140 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgb(var(--bg-subtle))', overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: CHANNEL_COLORS[i % CHANNEL_COLORS.length], borderRadius: 3 }} />
                        </div>
                        <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {pct.toFixed(1)}%
                        </p>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */

export default function CallCenter() {
  const [tab,      setTab]      = useState('overview')
  const [dateFrom, setDateFrom] = useState(defaultRange()[0])
  const [dateTo,   setDateTo]   = useState(defaultRange()[1])
  const [preset,   setPreset]   = useState('month')

  function handleDateChange(f, t, p) { setDateFrom(f); setDateTo(t); setPreset(p) }

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Call Center</h1>
          <p className="text-sm text-slate-500 mt-0.5">Zoho Desk ticket volumes, SLA, agent performance and channels</p>
        </div>
      </div>

      {/* ── Date picker ── */}
      <div className="mb-6">
        <DateRangePicker
          refDate={today()}
          dateFrom={dateFrom}
          dateTo={dateTo}
          preset={preset}
          onChange={handleDateChange}
        />
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-2 mb-6" style={{ borderBottom: '2px solid rgb(var(--border) / 0.1)', paddingBottom: 0 }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: 'none', background: 'none', outline: 'none',
              borderBottom: tab === t.key ? '2px solid #0E2841' : '2px solid transparent',
              marginBottom: -2,
              color: tab === t.key ? '#0E2841' : 'rgb(var(--fg-3))',
              transition: 'all 0.15s',
            }}
          >
            <span className="material-symbols-rounded text-[17px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      {tab === 'overview' && <OverviewTab  dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'tickets'  && <TicketsTab   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'agents'   && <AgentsTab />}
      {tab === 'channels' && <ByChannelTab dateFrom={dateFrom} dateTo={dateTo} />}
    </div>
  )
}
