import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  ErrBanner, DateFilter, Modal, Spinner, KpiCard,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, today, monthStart } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, RED, AMBER, NUM, SORA, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CallLog {
  id: number
  agent_name: string
  customer_name: string | null
  phone: string
  call_to: string | null
  direction: string
  duration_seconds: number
  outcome: string
  ticket_id: number | null
  ticket_ref: string | null
  called_at: string
  notes: string | null
}

interface CallScriptStep { order: number; prompt: string; options?: string[] }
interface CallScript { id: number; ticket_type: string; name: string; steps: CallScriptStep[]; is_active: boolean }

// ── Constants ─────────────────────────────────────────────────────────────────

const TICKET_TYPES_CALL = [
  'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Card Dispute',
  'Statement Request', 'Loan Complaint', 'FD Enquiry', 'Technical / App Issue',
  'Complaint (CBN reportable)',
]

const OUTCOME_CFG: Record<string, { bg: string; txt: string; label: string }> = {
  completed:   { bg: `${GREEN}18`,  txt: GREEN,  label: 'Completed'   },
  missed:      { bg: `${RED}12`,    txt: RED,    label: 'Missed'      },
  transferred: { bg: `${AMBER}18`,  txt: AMBER,  label: 'Transferred' },
  escalated:   { bg: `${RED}12`,    txt: RED,    label: 'Escalated'   },
}

const OUTCOME_CHART_COLORS = [GREEN, RED, AMBER, '#7C3AED']

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(s: number | null | undefined): string {
  if (!s || s <= 0) return '—'
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d}d ago`
  return fmtDatetime(iso)
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

// ── Direction badge ───────────────────────────────────────────────────────────

function DirectionBadge({ direction }: { direction: string }) {
  const isIn = direction === 'Inbound'
  const color = isIn ? BLUE : PURPLE
  const icon  = isIn ? 'call_received' : 'call_made'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: SP[1],
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: color + '15', color, whiteSpace: 'nowrap',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>{icon}</span>
      {direction}
    </span>
  )
}

// ── Outcome pill ──────────────────────────────────────────────────────────────

function OutcomePill({ outcome }: { outcome: string }) {
  const cfg = OUTCOME_CFG[outcome.toLowerCase()] ?? { bg: 'var(--chip-bg)', txt: 'var(--txt2)', label: outcome }
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 9px', borderRadius: RADIUS['2xl'],
      background: cfg.bg, color: cfg.txt, whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  )
}

// ── Duration bar ──────────────────────────────────────────────────────────────

function DurationCell({ seconds, max }: { seconds: number; max: number }) {
  const pct = max > 0 ? Math.min((seconds / max) * 100, 100) : 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 70 }}>
      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.semibold }}>{fmtDuration(seconds)}</span>
      {seconds > 0 && (
        <div style={{ height: 3, borderRadius: 2, background: 'var(--bdr)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: GREEN, borderRadius: 2 }} />
        </div>
      )}
    </div>
  )
}

// ── Charts ────────────────────────────────────────────────────────────────────

function CallsByDayChart({ rows }: { rows: CallLog[] }) {
  const data = useMemo(() => {
    const map: Record<string, { date: string; Inbound: number; Outbound: number }> = {}
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      map[d] = { date: d.slice(5), Inbound: 0, Outbound: 0 }
    }
    rows.forEach(r => {
      const k = dayKey(r.called_at)
      if (map[k]) map[k][r.direction as 'Inbound' | 'Outbound']++
    })
    return Object.values(map)
  }, [rows])

  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={data} barSize={14} margin={{ top: 4, right: 0, bottom: 0, left: -20 }}>
        <XAxis dataKey="date" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt3)' }} tickLine={false} axisLine={false} interval={1} />
        <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt3)' }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }}
          labelStyle={{ color: 'var(--txt)', fontWeight: FW.semibold }}
        />
        <Bar dataKey="Inbound"  fill={BLUE}   radius={[3,3,0,0]} stackId="a" />
        <Bar dataKey="Outbound" fill={PURPLE} radius={[3,3,0,0]} stackId="a" />
      </BarChart>
    </ResponsiveContainer>
  )
}

function OutcomeDonut({ rows }: { rows: CallLog[] }) {
  const data = useMemo(() => {
    const counts: Record<string, number> = {}
    rows.forEach(r => {
      const k = r.outcome.toLowerCase()
      counts[k] = (counts[k] ?? 0) + 1
    })
    return Object.entries(counts).map(([outcome, count]) => ({
      name: OUTCOME_CFG[outcome]?.label ?? outcome,
      value: count,
    }))
  }, [rows])

  return (
    <ResponsiveContainer width="100%" height={160}>
      <PieChart>
        <Pie data={data} dataKey="value" innerRadius={42} outerRadius={62} paddingAngle={2} stroke="none">
          {data.map((_, i) => <Cell key={i} fill={OUTCOME_CHART_COLORS[i % OUTCOME_CHART_COLORS.length]} />)}
        </Pie>
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs }} />
        <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

// ── Zoho Sync Bar ─────────────────────────────────────────────────────────────

interface ZohoSyncStatus {
  configured: boolean
  last_sync_at: string | null
  total_imported: number
}

function ZohoSyncBar({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<ZohoSyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)

  const fetchStatus = useCallback(() => {
    apiFetch<ZohoSyncStatus>('/api/zoho/sync-status').then(setStatus).catch(() => {})
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  if (!status?.configured) return null

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await apiPost<{ imported: number; skipped: number; failed: number }>(
        '/api/zoho/voice/import-logs', {}
      )
      toast.success(`Synced ${res.imported} new call${res.imported !== 1 ? 's' : ''} from Zoho Voice`)
      fetchStatus()
      onSynced()
    } catch (e: any) {
      toast.error(e.message ?? 'Zoho sync failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: RADIUS.lg, padding: '10px 16px', marginBottom: SP[4],
      display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: GREEN, flexShrink: 0 }} />
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>Zoho Voice</span>
      </div>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
        {status.total_imported.toLocaleString()} calls imported
      </span>
      {status.last_sync_at && (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
          · Last synced {relativeTime(status.last_sync_at)} · Auto-syncs hourly
        </span>
      )}
      <div style={{ flex: 1 }} />
      <button onClick={handleSync} disabled={syncing}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '6px 13px', background: `${NAVY}0D`,
          color: NAVY, border: `1px solid ${NAVY}20`, borderRadius: RADIUS.md,
          fontSize: TEXT.sm, fontWeight: FW.semibold,
          cursor: syncing ? 'wait' : 'pointer', opacity: syncing ? 0.7 : 1,
        }}>
        {syncing
          ? <Spinner size={13} />
          : <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>sync</span>
        }
        {syncing ? 'Syncing…' : 'Sync Now'}
      </button>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Calls() {
  const navigate = useNavigate()
  const [rows, setRows]     = useState<CallLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  // Filters
  const [agentFilter, setAgentFilter] = useState('')
  const [dirFilter,   setDirFilter]   = useState('')
  const [outcome,     setOutcome]     = useState('')
  const [dateFrom,    setDateFrom]    = useState(monthStart())
  const [dateTo,      setDateTo]      = useState(today())

  // Log Call modal
  const [logOpen, setLogOpen] = useState(false)
  const [logForm, setLogForm] = useState({
    customer_name: '', phone: '', direction: 'Inbound',
    outcome_val: 'completed', duration_seconds: '', ticket_type: '', notes: '',
  })
  const [logSaving, setLogSaving] = useState(false)
  const [callScript, setCallScript] = useState<CallScript | null>(null)
  const [scriptExpanded, setScriptExpanded] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback(() => {
    const p = new URLSearchParams()
    if (agentFilter) p.set('agent', agentFilter)
    if (dirFilter)   p.set('direction', dirFilter)
    if (outcome)     p.set('outcome', outcome)
    p.set('date_from', dateFrom)
    p.set('date_to', dateTo)
    p.set('limit', '200')
    return p.toString()
  }, [agentFilter, dirFilter, outcome, dateFrom, dateTo])

  const load = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const data = await apiFetch<CallLog[]>(`/api/helpdesk/calls?${buildQS()}`, { signal: abortRef.current.signal })
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally { setLoading(false) }
  }, [buildQS])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!logOpen || !logForm.ticket_type) { setCallScript(null); return }
    apiFetch<CallScript | null>(`/api/helpdesk/call-scripts/by-type?ticket_type=${encodeURIComponent(logForm.ticket_type)}`)
      .then(r => { setCallScript(r && (r as any).id ? r : null); setScriptExpanded(true) })
      .catch(() => setCallScript(null))
  }, [logOpen, logForm.ticket_type])

  // ── KPIs computed from loaded rows ────────────────────────────────────────

  const kpis = useMemo(() => {
    const total     = rows.length
    const completed = rows.filter(r => r.outcome === 'completed').length
    const missed    = rows.filter(r => r.outcome === 'missed').length
    const withDur   = rows.filter(r => r.duration_seconds > 0)
    const avgDur    = withDur.length ? Math.round(withDur.reduce((s, r) => s + r.duration_seconds, 0) / withDur.length) : 0
    const transferred = rows.filter(r => r.outcome === 'transferred').length
    return { total, completed, missed, avgDur, transferRate: total > 0 ? (transferred / total) * 100 : 0 }
  }, [rows])

  const maxDuration = useMemo(() => Math.max(...rows.map(r => r.duration_seconds), 1), [rows])

  // ── Log Call ──────────────────────────────────────────────────────────────

  async function handleLogCall() {
    if (!logForm.phone.trim()) { toast.error('Phone number is required'); return }
    setLogSaving(true)
    try {
      await apiPost('/api/helpdesk/calls', {
        customer_name:    logForm.customer_name || undefined,
        customer_phone:   logForm.phone,
        direction:        logForm.direction,
        outcome:          logForm.outcome_val,
        duration_seconds: logForm.duration_seconds ? Number(logForm.duration_seconds) : undefined,
        ticket_type:      logForm.ticket_type || undefined,
        notes:            logForm.notes || undefined,
      })
      toast.success('Call logged')
      setLogOpen(false)
      setLogForm({ customer_name: '', phone: '', direction: 'Inbound', outcome_val: 'completed', duration_seconds: '', ticket_type: '', notes: '' })
      setCallScript(null)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to log call')
    } finally { setLogSaving(false) }
  }

  function exportCsv() {
    const header = ['Agent', 'Customer', 'Phone', 'Direction', 'Duration (s)', 'Outcome', 'Ticket', 'Called At', 'Notes']
    const lines = rows.map(r => [
      `"${(r.agent_name ?? '').replace(/"/g, '""')}"`,
      `"${(r.customer_name ?? '').replace(/"/g, '""')}"`,
      r.phone ?? '',
      r.direction ?? '',
      r.duration_seconds ?? 0,
      r.outcome ?? '',
      r.ticket_ref ?? '',
      r.called_at ?? '',
      `"${(r.notes ?? '').replace(/"/g, '""')}"`,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `call-log-${today()}.csv` })
    document.body.appendChild(a); a.click(); a.remove()
  }

  // ── Table columns ─────────────────────────────────────────────────────────

  const cols: TableCol<CallLog>[] = [
    {
      key: 'direction',
      label: '',
      width: 32,
      render: r => (
        <span className="material-symbols-rounded" style={{
          fontSize: TEXT.xl,
          color: r.direction === 'Inbound' ? BLUE : PURPLE,
        }}>
          {r.direction === 'Inbound' ? 'call_received' : 'call_made'}
        </span>
      ),
    },
    {
      key: 'agent_name',
      label: 'Agent',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.agent_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>{r.direction}</div>
        </div>
      ),
    },
    {
      key: 'customer_name',
      label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: r.customer_name ? 500 : 400 }}>
            {r.customer_name ?? <span style={{ color: 'var(--txt3)' }}>Unknown</span>}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1, fontFamily: 'monospace' }}>{r.phone}</div>
        </div>
      ),
    },
    {
      key: 'duration_seconds',
      label: 'Duration',
      align: 'right',
      render: r => <DurationCell seconds={r.duration_seconds} max={maxDuration} />,
    },
    {
      key: 'outcome',
      label: 'Outcome',
      render: r => <OutcomePill outcome={r.outcome} />,
    },
    {
      key: 'ticket_id',
      label: 'Ticket',
      render: r => r.ticket_id && r.ticket_ref ? (
        <span
          onClick={e => { e.stopPropagation(); navigate(`/helpdesk/${r.ticket_id}`) }}
          style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {r.ticket_ref}
        </span>
      ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
    {
      key: 'called_at',
      label: 'Time',
      sortable: true,
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.medium }}>{relativeTime(r.called_at)}</div>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 1 }}>{fmtDatetime(r.called_at)}</div>
        </div>
      ),
    },
    {
      key: 'notes' as any,
      label: 'Notes',
      render: r => r.notes ? (
        <span title={r.notes} style={{ fontSize: TEXT.sm, color: 'var(--txt2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', maxWidth: 200 }}>
          {r.notes}
        </span>
      ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
  ]

  const inputSt: React.CSSProperties = {
    width: '100%', height: 36, padding: '0 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box', fontFamily: SORA,
  }
  const labelSt: React.CSSProperties = {
    display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5,
  }

  return (
    <Page
      title="Call Log"
      subtitle="All inbound and outbound calls across agents"
      actions={
        <div style={{ display: 'flex', gap: SP[2] }}>
          <button onClick={exportCsv}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            Export CSV
          </button>
          <button onClick={() => setLogOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add_call</span>
            Log Call
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Zoho sync bar — only renders when Zoho credentials are configured */}
      <ZohoSyncBar onSynced={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Calls"    value={kpis.total}     icon="call"          accent={NAVY}  loading={loading} />
        <KpiCard label="Completed"      value={kpis.completed} icon="check_circle"  accent={GREEN} loading={loading}
          sub={kpis.total ? `${((kpis.completed/kpis.total)*100).toFixed(0)}% answer rate` : undefined} />
        <KpiCard label="Missed"         value={kpis.missed}    icon="call_missed"   accent={RED}   loading={loading}
          sub={kpis.total ? `${((kpis.missed/kpis.total)*100).toFixed(0)}% miss rate` : undefined} />
        <KpiCard label="Avg Duration"   value={fmtDuration(kpis.avgDur)} icon="timer" accent={BLUE} loading={loading} />
        <KpiCard label="Transfer Rate"  value={`${kpis.transferRate.toFixed(1)}%`} icon="call_split" accent={AMBER} loading={loading} />
      </div>

      {/* Charts row */}
      {!loading && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 14, marginBottom: SP[4] }}>
          <SectionCard title="Calls by Day" subtitle="Last 14 days — Inbound vs Outbound">
            <CallsByDayChart rows={rows} />
          </SectionCard>
          <SectionCard title="By Outcome">
            <OutcomeDonut rows={rows} />
          </SectionCard>
        </div>
      )}

      {/* Table */}
      <SectionCard padding={false} badge={rows.length}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setAgentFilter(''); setDirFilter(''); setOutcome(''); setDateFrom(monthStart()); setDateTo(today()) }}>
            <input
              placeholder="Agent name…"
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              style={{ ...filterInputStyle, minWidth: 150 }}
            />
            <select value={dirFilter} onChange={e => setDirFilter(e.target.value)} style={filterInputStyle}>
              <option value="">All Directions</option>
              <option value="Inbound">Inbound</option>
              <option value="Outbound">Outbound</option>
            </select>
            <select value={outcome} onChange={e => setOutcome(e.target.value)} style={filterInputStyle}>
              <option value="">All Outcomes</option>
              <option value="completed">Completed</option>
              <option value="missed">Missed</option>
              <option value="transferred">Transferred</option>
              <option value="escalated">Escalated</option>
            </select>
            <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
            <button onClick={load}
              style={{ height: 32, padding: '0 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
              Apply
            </button>
          </FilterBar>
        </div>

        <DataTable<CallLog>
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No call records found for the selected filters"
          searchKeys={['agent_name', 'customer_name', 'outcome', 'phone']}
          searchPlaceholder="Search agent, customer, phone…"
          pageSize={25}
        />
      </SectionCard>

      {/* Log Call modal */}
      <Modal
        open={logOpen}
        onClose={() => { setLogOpen(false); setCallScript(null) }}
        title="Log a Call"
        width={500}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => { setLogOpen(false); setCallScript(null) }}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleLogCall} disabled={logSaving}
              style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: logSaving ? 'wait' : 'pointer', opacity: logSaving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
              {logSaving && <Spinner size={13} color="#fff" />}
              Log Call
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SORA }}>

          {/* Customer */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={labelSt}>Customer Name</label>
              <input value={logForm.customer_name} onChange={e => setLogForm(f => ({ ...f, customer_name: e.target.value }))}
                placeholder="Full name" style={inputSt} />
            </div>
            <div>
              <label style={labelSt}>Phone Number *</label>
              <input value={logForm.phone} onChange={e => setLogForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="e.g. 08012345678" style={inputSt} />
            </div>
          </div>

          {/* Direction / Outcome / Duration */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={labelSt}>Direction</label>
              <select value={logForm.direction} onChange={e => setLogForm(f => ({ ...f, direction: e.target.value }))} style={inputSt}>
                <option value="Inbound">Inbound</option>
                <option value="Outbound">Outbound</option>
              </select>
            </div>
            <div>
              <label style={labelSt}>Outcome</label>
              <select value={logForm.outcome_val} onChange={e => setLogForm(f => ({ ...f, outcome_val: e.target.value }))} style={inputSt}>
                <option value="completed">Completed</option>
                <option value="missed">Missed</option>
                <option value="transferred">Transferred</option>
                <option value="escalated">Escalated</option>
              </select>
            </div>
            <div>
              <label style={labelSt}>Duration (seconds)</label>
              <input type="number" min={0} value={logForm.duration_seconds}
                onChange={e => setLogForm(f => ({ ...f, duration_seconds: e.target.value }))}
                placeholder="e.g. 145" style={inputSt} />
            </div>
          </div>

          {/* Ticket type */}
          <div>
            <label style={labelSt}>Ticket Type</label>
            <select value={logForm.ticket_type} onChange={e => setLogForm(f => ({ ...f, ticket_type: e.target.value }))} style={inputSt}>
              <option value="">— None —</option>
              {TICKET_TYPES_CALL.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {/* Notes */}
          <div>
            <label style={labelSt}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={logForm.notes} onChange={e => setLogForm(f => ({ ...f, notes: e.target.value }))}
              rows={3} placeholder="Call notes…"
              style={{ ...inputSt, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 }} />
          </div>

          {/* Call script panel */}
          {callScript && (
            <div style={{ border: `1px solid ${NAVY}25`, borderRadius: RADIUS.md, overflow: 'hidden' }}>
              <button type="button" onClick={() => setScriptExpanded(x => !x)}
                style={{ width: '100%', padding: '9px 14px', background: `${NAVY}08`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: SORA }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>assignment</span>
                  {callScript.name}
                </span>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{scriptExpanded ? '▲' : '▼'}</span>
              </button>
              {scriptExpanded && (
                <div style={{ padding: '10px 14px 14px', display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  {[...callScript.steps].sort((a, b) => a.order - b.order).map(step => (
                    <div key={step.order} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: NAVY, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold }}>
                        {step.order}
                      </div>
                      <div style={{ fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.5 }}>
                        {step.prompt}
                        {step.options && step.options.length > 0 && (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: SP[1] }}>
                            {step.options.map((opt, i) => (
                              <span key={i} style={{ fontSize: TEXT.xs, padding: '1px 7px', borderRadius: RADIUS.lg, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>{opt}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </Page>
  )
}
