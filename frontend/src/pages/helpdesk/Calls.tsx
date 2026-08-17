import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  AreaChart, Area, CartesianGrid,
} from 'recharts'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, DateFilter, Modal, Spinner, KpiCard, NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtDate, today } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, RED, AMBER, NUM, SORA, FW, RADIUS, SP, TEXT } from '../../lib/design'
import QAEvaluation from './QAEvaluation'
import { BAND_COLOR } from '../../lib/qa'
import { toast } from 'sonner'
import { CustomerSearch, CustSuggest, cleanName, initialsOf } from '../../components/CustomerSearch'
import ScheduleCallbackModal from '../../components/ScheduleCallbackModal'

function myRole(): string { try { return String(JSON.parse(localStorage.getItem('o3c_user') || '{}').role || '') } catch { return '' } }
const CAN_EVALUATE = /head|admin|super|manager|lead|supervisor/i.test(myRole())

// ── Types ─────────────────────────────────────────────────────────────────────

interface CallLog {
  id: number
  agent_id: number | null
  agent_name: string
  customer_name: string | null
  phone: string
  call_to: string | null
  direction: string
  duration_seconds: number
  outcome: string
  disposition: string | null
  purpose: string | null
  ticket_type: string | null
  ticket_id: number | null
  ticket_ref: string | null
  called_at: string
  notes: string | null
  resolution: string | null
  customer_cif: string | null
  recording_url: string | null
  qa_evaluation_id: number | null
  qa_score: number | null
  qa_band: string | null
  qa_passed: boolean | null
}

interface CallScriptStep { order: number; prompt: string; options?: string[] }
interface CallScript { id: number; ticket_type: string; name: string; steps: CallScriptStep[]; is_active: boolean }

// Server-side aggregates over the FULL filtered dataset (not just the loaded page).
interface CallStats {
  summary: {
    total: number; inbound: number; outbound: number
    missed: number; connected: number
    inbound_connected: number; outbound_connected: number; resolved: number
    total_talk_sec: number; agents: number
    avg_duration_sec: number | null; avg_inbound_sec: number | null; avg_outbound_sec: number | null
  }
  by_outcome: { outcome: string; count: number }[]
  by_day: { day: string; total: number; inbound: number; outbound: number }[]
  by_hour: { hour: number; total: number; inbound: number; outbound: number }[]
}
const num = (v: any): number => Number(v ?? 0) || 0

// ── Constants ─────────────────────────────────────────────────────────────────

const TICKET_TYPES_CALL = [
  'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Failed Transaction',
  'Card Dispute', 'Statement Request', 'Loan Complaint', 'Collection',
  'FD Enquiry', 'App Download', 'Technical / App Issue', 'Pitching / Marketing',
  'Complaint (CBN reportable)', 'Others',
]

// Call disposition = the business result of the call. Kept distinct from Outcome
// (connection status: completed/missed/…), which drives the KPIs and Zoho mapping.
const DISPOSITIONS = [
  'Resolved', 'Closed', 'Information Provided', 'Callback Scheduled', 'Escalated',
  'Complaint Logged', 'Pending / Follow-up', 'Unreachable / No Answer',
  'Wrong Number', 'Not Interested',
]

// Call purpose = which book/queue the call belongs to. Lets a call logged here be
// linked to where it actually falls (a marketing/leads dial, a collections chase, an
// outbound sales pitch) rather than every call reading as generic "support". Codes are
// stored lower-case to match the outbound queue + Zoho voice import.
const PURPOSES: { value: string; label: string }[] = [
  { value: '',            label: 'Support / Service' },   // default — no explicit book
  { value: 'marketing',   label: 'Marketing / Leads' },
  { value: 'sales',       label: 'Outbound Sales' },
  { value: 'collections', label: 'Collections' },
]
const PURPOSE_META: Record<string, { label: string; color: string }> = {
  marketing:   { label: 'Marketing / Leads', color: BLUE },
  sales:       { label: 'Outbound Sales',    color: PURPLE },
  collections: { label: 'Collections',       color: RED },
  support:     { label: 'Support',           color: GREEN },
}

// Dispositions that imply the call needs follow-up work — these pre-check the
// "open a linked ticket" box (the agent can still override it either way).
const FOLLOWUP_DISPOSITIONS = new Set([
  'Escalated', 'Complaint Logged', 'Callback Scheduled', 'Pending / Follow-up', 'Unreachable / No Answer',
])
function dispositionPriority(d: string): 'high' | 'medium' | 'low' {
  return d === 'Escalated' || d === 'Complaint Logged' ? 'high' : 'medium'
}

// Zoho-sourced calls only carry `completed` (connected) and `missed` (no answer);
// the other values exist for the live AT flow. "Connected" reads truer than
// "Completed" for a dialer-heavy operation.
const OUTCOME_CFG: Record<string, { bg: string; txt: string; label: string; chart: string }> = {
  completed:   { bg: `${GREEN}18`, txt: GREEN, label: 'Connected',   chart: GREEN },
  connected:   { bg: `${GREEN}18`, txt: GREEN, label: 'Connected',   chart: GREEN },
  resolved:    { bg: `${GREEN}18`, txt: GREEN, label: 'Resolved',    chart: GREEN },
  missed:      { bg: `${RED}12`,   txt: RED,   label: 'No Answer',   chart: RED   },
  no_answer:   { bg: `${RED}12`,   txt: RED,   label: 'No Answer',   chart: RED   },
  voicemail:   { bg: `${AMBER}18`, txt: AMBER, label: 'Voicemail',   chart: AMBER },
  transferred: { bg: `${AMBER}18`, txt: AMBER, label: 'Transferred', chart: AMBER },
  escalated:   { bg: `${RED}12`,   txt: RED,   label: 'Escalated',   chart: '#7C3AED' },
}

const OUTCOME_CHART_FALLBACK = ['#7C3AED', BLUE, AMBER, GREEN, RED]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(s: number | null | undefined): string {
  if (!s || s <= 0) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
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

function OutcomePill({ outcome, direction }: { outcome: string | null; direction?: string }) {
  const o = (outcome ?? '').toLowerCase()
  const base = OUTCOME_CFG[o]
  let bg = base?.bg ?? 'var(--chip-bg)'
  let txt = base?.txt ?? 'var(--txt2)'
  let label = base?.label ?? (outcome || '—')
  // A no-answer outcome is a "Missed" call only on INBOUND. An unanswered OUTBOUND
  // dial is "No Answer" — the customer didn't pick, not the agent's miss.
  if (['missed', 'no_answer', 'voicemail'].includes(o)) {
    if ((direction ?? '').toLowerCase() === 'inbound') { bg = `${RED}12`; txt = RED; label = 'Missed' }
    else { bg = 'var(--chip-bg)'; txt = 'var(--txt2)'; label = 'No Answer' }
  }
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 9px', borderRadius: RADIUS['2xl'],
      background: bg, color: txt, whiteSpace: 'nowrap',
    }}>
      {label}
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

function CallVolumeChart({ series }: { series: CallStats['by_day'] }) {
  const data = useMemo(() => series.map(d => ({
    date: d.day,
    Inbound: num(d.inbound),
    Outbound: num(d.outbound),
  })), [series])

  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PURPLE} stopOpacity={0.35} />
            <stop offset="100%" stopColor={PURPLE} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BLUE} stopOpacity={0.35} />
            <stop offset="100%" stopColor={BLUE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
        <XAxis dataKey="date" tickFormatter={(v: string) => fmtDate(v, { month: 'short', day: 'numeric' })} tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt3)' }} tickLine={false} axisLine={false} minTickGap={44} />
        <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt3)' }} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
        <Tooltip
          contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }}
          labelStyle={{ color: 'var(--txt)', fontWeight: FW.semibold }}
          labelFormatter={(v: string) => fmtDate(v)}
        />
        <Area type="monotone" dataKey="Outbound" stackId="1" stroke={PURPLE} fill="url(#gOut)" strokeWidth={2} />
        <Area type="monotone" dataKey="Inbound"  stackId="1" stroke={BLUE}   fill="url(#gIn)"  strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function OutcomeDonut({ series }: { series: CallStats['by_outcome'] }) {
  const data = useMemo(() => series.map(o => {
    const cfg = OUTCOME_CFG[(o.outcome || '').toLowerCase()]
    return { name: cfg?.label ?? (o.outcome || 'Unknown'), value: num(o.count), color: cfg?.chart }
  }), [series])

  return (
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Pie data={data} dataKey="value" innerRadius={46} outerRadius={66} paddingAngle={2} stroke="none">
          {data.map((d, i) => <Cell key={i} fill={d.color ?? OUTCOME_CHART_FALLBACK[i % OUTCOME_CHART_FALLBACK.length]} />)}
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
      toast.success(`Synced ${res.imported} new call${res.imported !== 1 ? 's' : ''} from Zoho Desk`)
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
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>Zoho Desk</span>
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
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Managed in Admin → Sync &amp; Workers</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Calls() {
  const navigate = useNavigate()
  const [rows, setRows]     = useState<CallLog[]>([])
  const [stats, setStats]   = useState<CallStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  // Supervisor "view agent" drawer target.
  const [viewAgent, setViewAgent] = useState<{ id: number; name: string } | null>(null)
  // Per-call detail modal (everything logged about one call).
  const [viewCall, setViewCall] = useState<CallLog | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // Filters
  const [agentFilter, setAgentFilter] = useState('')
  const [fDirs,       setFDirs]       = useState(new Set<string>())
  const [fOutcomes,   setFOutcomes]   = useState(new Set<string>())
  // Default to the last 12 months — call data is historical (synced from Zoho),
  // so a "this month" default would show nothing.
  const [dateFrom,    setDateFrom]    = useState(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10))
  const [dateTo,      setDateTo]      = useState(today())

  // QA evaluation modal (opened from a call's Evaluate action)
  const [evalCall, setEvalCall] = useState<CallLog | null>(null)

  // Log Call modal
  const [logOpen, setLogOpen] = useState(false)
  const [logForm, setLogForm] = useState({
    customer_name: '', phone: '', customer_cif: '', direction: 'Inbound',
    outcome_val: 'completed', disposition: '', duration_seconds: '',
    purpose: '', ticket_type: '', notes: '', resolution: '',
  })
  // Customer picker state: picked = a customer chosen (chip); manual = typing a
  // walk-in by hand; otherwise the search typeahead shows.
  const [custPicked, setCustPicked] = useState(false)
  const [custManual, setCustManual] = useState(false)
  // Whether to also open a linked follow-up ticket when the call is logged.
  const [createTicket, setCreateTicket] = useState(false)
  const [logSaving, setLogSaving] = useState(false)
  const [callScript, setCallScript] = useState<CallScript | null>(null)
  const [scriptExpanded, setScriptExpanded] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  // Shared filter — the log table, KPI strip and charts all move together.
  const filterQS = useCallback(() => {
    const p = new URLSearchParams()
    if (agentFilter) p.set('agent', agentFilter)
    if (fDirs.size)     p.set('direction', [...fDirs].join(','))
    if (fOutcomes.size) p.set('outcome', [...fOutcomes].join(','))
    p.set('date_from', dateFrom)
    p.set('date_to', dateTo)
    return p
  }, [agentFilter, fDirs, fOutcomes, dateFrom, dateTo])

  const load = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const p = filterQS(); p.set('limit', '200')
      const data = await apiFetch<CallLog[]>(`/api/helpdesk/calls?${p}`, { signal: abortRef.current.signal })
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally { setLoading(false) }
  }, [filterQS])

  // KPIs + charts come from a server-side aggregate over the FULL filtered set —
  // never from the 200-row table page (which would badly under-count 98k calls).
  const loadStats = useCallback(async () => {
    try {
      const raw = await apiFetch<any>(`/api/helpdesk/calls/stats?${filterQS()}`)
      setStats((raw?.data ?? raw) as CallStats)
    } catch { /* non-fatal — KPI cards fall back to dashes */ }
  }, [filterQS])

  useEffect(() => { load(); loadStats() }, [load, loadStats])
  useLiveData(() => { load(); loadStats() }, { topics: ['tickets'] })

  useEffect(() => {
    if (!logOpen || !logForm.ticket_type) { setCallScript(null); return }
    apiFetch<any>(`/api/helpdesk/call-scripts/by-type?ticket_type=${encodeURIComponent(logForm.ticket_type)}`)
      .then(r => { const s = r?.data ?? r; setCallScript(s?.id ? s : null); setScriptExpanded(true) })
      .catch(() => setCallScript(null))
  }, [logOpen, logForm.ticket_type])

  // ── KPIs computed from loaded rows ────────────────────────────────────────

  const kpis = useMemo(() => {
    const s = stats?.summary
    const total     = num(s?.total)
    const connected = num(s?.connected)
    const missed    = num(s?.missed)
    const outbound  = num(s?.outbound)
    const inbound   = num(s?.inbound)
    const talkSec   = num(s?.total_talk_sec)
    // Average talk time over calls that actually connected (missed calls carry 0s
    // duration and would otherwise drag the mean toward zero).
    const avgTalk   = connected > 0 ? Math.round(talkSec / connected) : 0
    return {
      total, connected, missed, outbound, inbound, avgTalk,
      connectRate: total > 0 ? (connected / total) * 100 : 0,
      missRate:    total > 0 ? (missed / total) * 100 : 0,
      outboundPct: total > 0 ? (outbound / total) * 100 : 0,
      agents: num(s?.agents),
    }
  }, [stats])

  // Cap the bar scale so one corrupt long-duration call can't flatten every bar.
  const maxDuration = useMemo(() => Math.min(Math.max(...rows.map(r => r.duration_seconds), 1), 1800), [rows])

  // Outcome filter options come from the actual data (deduped by label), so we
  // never show duplicate ("Connected"×2) or non-existent ("Voicemail") choices.
  const outcomeOpts = useMemo(() => {
    const seen = new Set<string>()
    return (stats?.by_outcome ?? []).map(o => {
      const key = (o.outcome ?? '').toLowerCase()
      const cfg = OUTCOME_CFG[key]
      return { value: key, label: cfg?.label ?? (o.outcome || 'Unknown'), color: cfg?.txt ?? 'var(--txt2)' }
    }).filter(o => o.value && !seen.has(o.label) && !!seen.add(o.label))
  }, [stats])

  // ── Log Call ──────────────────────────────────────────────────────────────

  function resetLogForm() {
    setLogForm({
      customer_name: '', phone: '', customer_cif: '', direction: 'Inbound',
      outcome_val: 'completed', disposition: '', duration_seconds: '',
      purpose: '', ticket_type: '', notes: '', resolution: '',
    })
    setCustPicked(false); setCustManual(false); setCreateTicket(false)
  }

  async function handleLogCall() {
    // A call needs at least a way to identify the caller — a linked customer (CIF)
    // or a phone number.
    if (!logForm.phone.trim() && !logForm.customer_cif.trim()) {
      toast.error('Add a customer (search) or a phone number'); return
    }
    if (createTicket && !logForm.ticket_type) {
      toast.error('Pick a ticket type to open a linked ticket'); return
    }
    setLogSaving(true)
    try {
      // Optionally spin up a follow-up ticket first — this reuses the full ticket
      // pipeline (SLA clock, auto-assignment, first message) rather than a thin
      // insert — then link the call to it via ticket_ref below.
      let ticketRef: string | undefined
      if (createTicket) {
        const complaint = logForm.notes.trim()
        const tRes = await apiPost<{ ticket?: { ticket_ref?: string } }>('/api/helpdesk/tickets', {
          channel:        'phone',
          subject:        `${logForm.ticket_type} — ${logForm.customer_name || logForm.phone || 'caller'}`,
          ticket_type:    logForm.ticket_type,
          priority:       dispositionPriority(logForm.disposition),
          customer_name:  logForm.customer_name || undefined,
          customer_cif:   logForm.customer_cif || undefined,
          customer_phone: logForm.phone || undefined,
          message_text:   complaint || `Follow-up from call · ${logForm.disposition || 'logged'}`,
          custom_fields:  { disposition: logForm.disposition || '', resolution: logForm.resolution || '', source: 'call_log' },
        })
        ticketRef = tRes?.ticket?.ticket_ref
      }
      await apiPost('/api/helpdesk/calls', {
        customer_name:    logForm.customer_name || undefined,
        customer_cif:     logForm.customer_cif || undefined,
        customer_phone:   logForm.phone || undefined,
        direction:        logForm.direction,
        outcome:          logForm.outcome_val,
        disposition:      logForm.disposition || undefined,
        purpose:          logForm.purpose || undefined,
        duration_seconds: logForm.duration_seconds ? Number(logForm.duration_seconds) : undefined,
        ticket_type:      logForm.ticket_type || undefined,
        notes:            logForm.notes || undefined,
        resolution:       logForm.resolution || undefined,
        ticket_ref:       ticketRef,
      })
      toast.success(ticketRef ? `Call logged · ticket ${ticketRef} opened` : 'Call logged')
      setLogOpen(false)
      resetLogForm()
      setCallScript(null)
      load(); loadStats()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to log call')
    } finally { setLogSaving(false) }
  }

  function exportCsv() {
    const header = ['Agent', 'Customer', 'Phone', 'Direction', 'Duration (s)', 'Outcome', 'Disposition', 'Purpose', 'Ticket', 'Called At', 'Complaint / Summary', 'Resolution']
    const lines = rows.map(r => [
      `"${(r.agent_name ?? '').replace(/"/g, '""')}"`,
      `"${(r.customer_name ?? '').replace(/"/g, '""')}"`,
      r.phone ?? '',
      r.direction ?? '',
      r.duration_seconds ?? 0,
      r.outcome ?? '',
      `"${(r.disposition ?? '').replace(/"/g, '""')}"`,
      `"${(PURPOSE_META[(r.purpose ?? '').toLowerCase()]?.label ?? '')}"`,
      r.ticket_ref ?? '',
      r.called_at ?? '',
      `"${(r.notes ?? '').replace(/"/g, '""')}"`,
      `"${(r.resolution ?? '').replace(/"/g, '""')}"`,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `call-log-${today()}.csv` })
    document.body.appendChild(a); a.click(); a.remove()
  }

  // ── Table columns ─────────────────────────────────────────────────────────

  const cols: TableCol<CallLog>[] = [
    {
      key: 'agent_name',
      label: 'Agent',
      render: r => <NameCell name={r.agent_name} sub={r.direction} avatar={false} />,
    },
    {
      key: 'customer_name',
      label: 'Caller',
      render: r => <NameCell name={r.customer_name ?? 'Unknown Caller'} sub={r.phone} />,
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
      render: r => <OutcomePill outcome={r.outcome} direction={r.direction} />,
    },
    {
      key: 'disposition' as any,
      label: 'Disposition',
      render: r => r.disposition ? (
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{r.disposition}</span>
      ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
    {
      key: 'purpose' as any,
      label: 'Purpose',
      render: r => {
        const meta = PURPOSE_META[(r.purpose ?? '').toLowerCase()]
        return meta ? (
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${meta.color}14`, color: meta.color, whiteSpace: 'nowrap' }}>{meta.label}</span>
        ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>
      },
    },
    {
      key: 'qa_score' as any,
      label: 'QA',
      align: 'center',
      render: r => r.qa_score != null ? (
        <span title={`${r.qa_band ?? ''} · ${r.qa_passed ? 'Pass' : 'Fail'}`}
          style={{ ...NUM, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: TEXT.sm, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${BAND_COLOR[r.qa_band ?? ''] ?? NAVY}18`, color: BAND_COLOR[r.qa_band ?? ''] ?? NAVY }}>
          <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{r.qa_passed ? 'verified' : 'error' }</span>{r.qa_score}%
        </span>
      ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
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
      label: 'Summary',
      render: r => {
        const complaint = (r.notes ?? '').trim()
        const resolution = (r.resolution ?? '').trim()
        if (!complaint && !resolution) return <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>
        // Tooltip carries both sides of the call; the cell shows the complaint
        // (falling back to the resolution for calls that only recorded an action).
        const tip = [complaint && `Complaint: ${complaint}`, resolution && `Resolution: ${resolution}`].filter(Boolean).join('\n\n')
        return (
          <span title={tip} style={{ fontSize: TEXT.sm, color: 'var(--txt2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', maxWidth: 220 }}>
            {complaint || resolution}
            {resolution && <span title="Resolution recorded" style={{ marginLeft: 5, color: GREEN, fontWeight: FW.bold }}>✓</span>}
          </span>
        )
      },
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      width: 64,
      render: r => (
        <ActionRow actions={[
          // Open the full record of THIS call — every field plus exactly what the
          // agent logged (complaint, resolution, disposition, purpose, QA, recording).
          {
            icon: 'info', label: 'View call details',
            onClick: () => setViewCall(r),
          },
          // Supervisors can additionally open the agent's overall snapshot.
          ...(CAN_EVALUATE && r.agent_id ? [{
            icon: 'badge', label: 'Agent snapshot',
            onClick: () => setViewAgent({ id: r.agent_id as number, name: r.agent_name }),
          }] : []),
          // Log a report for this number — pre-fills the Log-a-Call form so the agent
          // just records the outcome/notes for that customer.
          {
            icon: 'edit_note', label: 'Log a report',
            onClick: () => {
              setLogForm(f => ({
                ...f,
                customer_name: r.customer_name || '',
                phone: (r.phone as string) || '',
                customer_cif: (r.customer_cif as string) || '',
                direction: r.direction || 'Inbound',
              }))
              setCustPicked(false); setCustManual(true)
              setLogOpen(true)
            },
          },
          // Evaluators can score the call against the QA rubric.
          ...(CAN_EVALUATE ? [{
            icon: 'grade', label: r.qa_evaluation_id ? 'Re-evaluate call (QA)' : 'Evaluate call (QA)',
            onClick: () => setEvalCall(r),
          }] : []),
          // Only offer a recording when one actually exists on the call.
          ...(r.recording_url ? [{
            icon: 'play_circle', label: 'View Recording',
            onClick: () => window.open(r.recording_url as string, '_blank', 'noopener'),
          }] : []),
          {
            icon: 'add_comment', label: 'Create Ticket',
            onClick: () => {
              const q = new URLSearchParams()
              if (r.customer_cif) q.set('cif', r.customer_cif)
              if (r.customer_name) q.set('name', r.customer_name)
              if (r.phone) q.set('phone', r.phone)
              navigate(`/helpdesk/new?${q.toString()}`)
            },
          },
        ]} />
      ),
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
      subtitle={CAN_EVALUATE ? 'All inbound and outbound calls across agents' : 'Your inbound and outbound calls'}
      actions={
        <div style={{ display: 'flex', gap: SP[2] }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
          <button onClick={exportCsv}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            Export CSV
          </button>
          <button onClick={() => setScheduleOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>event_upcoming</span>
            Schedule Callback
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

      {/* KPI strip — over the full filtered dataset, not the loaded page */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Calls"    value={kpis.total.toLocaleString()} icon="call" accent={NAVY} loading={loading}
          sub={`${kpis.agents} agent${kpis.agents !== 1 ? 's' : ''}`} />
        <KpiCard label="Connect Rate"   value={`${kpis.connectRate.toFixed(0)}%`} icon="check_circle" accent={GREEN} loading={loading}
          sub={`${kpis.connected.toLocaleString()} connected`} />
        <KpiCard label="No Answer"      value={`${kpis.missRate.toFixed(0)}%`} icon="call_missed" accent={RED} loading={loading}
          sub={`${kpis.missed.toLocaleString()} calls`} />
        <KpiCard label="Outbound Share" value={`${kpis.outboundPct.toFixed(0)}%`} icon="call_made" accent={PURPLE} loading={loading}
          sub={`${kpis.outbound.toLocaleString()} out · ${kpis.inbound.toLocaleString()} in`} />
        <KpiCard label="Avg Talk Time"  value={fmtDuration(kpis.avgTalk)} icon="timer" accent={BLUE} loading={loading}
          sub="per connected call" />
      </div>

      {/* Charts row — gated on stats (not the table load), with a skeleton so they
          don't pop in blank after a delay. */}
      {!stats ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 14, marginBottom: SP[4] }}>
          <SectionCard title="Call Volume"><div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={20} /></div></SectionCard>
          <SectionCard title="By Outcome"><div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={20} /></div></SectionCard>
        </div>
      ) : kpis.total > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 14, marginBottom: SP[4] }}>
          <SectionCard title="Call Volume" subtitle="Inbound vs Outbound over the selected range">
            <CallVolumeChart series={stats?.by_day ?? []} />
          </SectionCard>
          <SectionCard title="By Outcome">
            <OutcomeDonut series={stats?.by_outcome ?? []} />
          </SectionCard>
        </div>
      ) : null}

      {/* Table */}
      <SectionCard padding={false} title="Call Records"
        subtitle={kpis.total > rows.length ? `Most recent ${rows.length} shown · KPIs & charts cover all ${kpis.total.toLocaleString()}` : `${rows.length} call${rows.length !== 1 ? 's' : ''}`}>
        <ExpandableFilterBar
          search={agentFilter}
          onSearch={setAgentFilter}
          groups={[
            {
              key: 'direction',
              label: 'Direction',
              options: [
                { value: 'Inbound', color: BLUE },
                { value: 'Outbound', color: PURPLE },
              ],
              selected: fDirs,
              onChange: setFDirs,
            },
            {
              key: 'outcome',
              label: 'Outcome',
              options: outcomeOpts,
              selected: fOutcomes,
              onChange: setFOutcomes,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setAgentFilter(''); setFDirs(new Set()); setFOutcomes(new Set()) }}
          onApply={load}
          resultCount={rows.length}
          totalCount={Math.max(kpis.total, rows.length)}
          placeholder="Search by agent name…"
        />

        <DataTable<CallLog>
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No call records found for the selected filters"
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

          {/* Customer — search & autofill, with a manual (walk-in) fallback */}
          <div>
            <label style={labelSt}>Customer</label>
            {custPicked ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg }}>
                <div style={{ width: 36, height: 36, borderRadius: RADIUS.full, flexShrink: 0, background: `${NAVY}12`, color: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.sm, fontWeight: FW.extrabold }}>
                  {initialsOf(logForm.customer_name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{logForm.customer_name || 'Unknown customer'}</div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>
                    {logForm.customer_cif && <span style={{ fontFamily: 'var(--font-mono)' }}>CIF {logForm.customer_cif}</span>}
                    {logForm.phone && <span>{logForm.phone}</span>}
                  </div>
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: GREEN, background: `${GREEN}14`, padding: '3px 9px', borderRadius: RADIUS.xl }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>Linked
                </span>
                <button type="button"
                  onClick={() => { setLogForm(f => ({ ...f, customer_cif: '' })); setCustPicked(false); setCustManual(false) }}
                  style={{ padding: '5px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                  Change
                </button>
              </div>
            ) : custManual ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
                  <input value={logForm.customer_name} onChange={e => setLogForm(f => ({ ...f, customer_name: e.target.value }))}
                    placeholder="Customer name" style={inputSt} />
                  <input value={logForm.phone} onChange={e => setLogForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="Phone e.g. 08012345678" style={inputSt} />
                </div>
                <button type="button" onClick={() => setCustManual(false)}
                  style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'none', color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>search</span>Search for an existing customer instead
                </button>
              </div>
            ) : (
              <CustomerSearch
                autoFocus={false}
                onPick={(c: CustSuggest) => {
                  setLogForm(f => ({ ...f, customer_name: cleanName(c.name), customer_cif: c.cif, phone: c.phone ?? f.phone }))
                  setCustPicked(true)
                }}
                onManual={() => setCustManual(true)}
              />
            )}
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
              <label style={labelSt} title="Auto-captured from Zoho Voice on synced calls; enter it only for a manually logged call">Duration (sec)</label>
              <input type="number" min={0} value={logForm.duration_seconds}
                onChange={e => setLogForm(f => ({ ...f, duration_seconds: e.target.value }))}
                placeholder="auto for voice" style={inputSt} />
            </div>
          </div>

          {/* Purpose — links the call to the book it belongs to (leads, outbound
              sales, collections, support) so it isn't filed as generic "support". */}
          <div>
            <label style={labelSt}>Call purpose / links to</label>
            <select value={logForm.purpose} onChange={e => setLogForm(f => ({ ...f, purpose: e.target.value }))} style={inputSt}>
              {PURPOSES.map(p => <option key={p.value || 'support'} value={p.value}>{p.label}</option>)}
            </select>
          </div>

          {/* Ticket type + Disposition */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={labelSt}>Ticket Type</label>
              <select value={logForm.ticket_type} onChange={e => setLogForm(f => ({ ...f, ticket_type: e.target.value }))} style={inputSt}>
                <option value="">— None —</option>
                {TICKET_TYPES_CALL.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={labelSt}>Disposition</label>
              <select value={logForm.disposition} onChange={e => { const v = e.target.value; setLogForm(f => ({ ...f, disposition: v })); setCreateTicket(FOLLOWUP_DISPOSITIONS.has(v)) }} style={inputSt}>
                <option value="">— Select —</option>
                {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          {/* Optional: open a linked follow-up ticket (auto-checked for follow-up dispositions) */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm, color: 'var(--txt)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={createTicket} onChange={e => setCreateTicket(e.target.checked)} style={{ accentColor: NAVY, width: 15, height: 15 }} />
            Open a linked follow-up ticket
            {createTicket && !logForm.ticket_type && <span style={{ color: AMBER, fontSize: TEXT.xs }}>— pick a ticket type above</span>}
          </label>

          {/* Customer complaint / summary */}
          <div>
            <label style={labelSt}>Customer complaint / summary</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={logForm.notes} onChange={e => setLogForm(f => ({ ...f, notes: e.target.value }))}
              rows={3} placeholder="What the customer called about…"
              style={{ ...inputSt, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 }} />
          </div>

          {/* Agent response / resolution */}
          <div>
            <label style={labelSt}>Agent response / resolution</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={logForm.resolution} onChange={e => setLogForm(f => ({ ...f, resolution: e.target.value }))}
              rows={3} placeholder="What you did / how it was resolved…"
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

      {evalCall && (
        <QAEvaluation
          call={{ id: evalCall.id, agent_name: evalCall.agent_name, customer_name: evalCall.customer_name, phone: evalCall.phone, direction: evalCall.direction, called_at: evalCall.called_at, duration_seconds: evalCall.duration_seconds }}
          onClose={() => setEvalCall(null)}
          onSaved={() => { load(); loadStats() }}
        />
      )}

      <CallDetailModal call={viewCall} onClose={() => setViewCall(null)}
        onEvaluate={CAN_EVALUATE ? c => { setViewCall(null); setEvalCall(c) } : undefined}
        onOpenTicket={id => { setViewCall(null); navigate(`/helpdesk/${id}`) }} />
      <AgentDetailModal agent={viewAgent} dateFrom={dateFrom} dateTo={dateTo} onClose={() => setViewAgent(null)} onOpenTicket={id => { setViewAgent(null); navigate(`/helpdesk/${id}`) }} />
      <ScheduleCallbackModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} onSaved={() => { load(); loadStats() }} />
    </Page>
  )
}

// ── Call detail (per-call read view) ──────────────────────────────────────────
// Everything logged about a single call — the identifiers, the connection facts,
// and the two things the agent actually wrote (the complaint and the resolution) —
// so a supervisor can read a call without hunting across columns.

function CallDetailModal({ call, onClose, onEvaluate, onOpenTicket }: {
  call: CallLog | null
  onClose: () => void
  onEvaluate?: (c: CallLog) => void
  onOpenTicket: (id: number) => void
}) {
  if (!call) return null
  const purpose = PURPOSE_META[(call.purpose ?? '').toLowerCase()]

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{children}</div>
    </div>
  )
  const secLbl: React.CSSProperties = { fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 7 }
  const noteBox: React.CSSProperties = { fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.55, background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '10px 12px', whiteSpace: 'pre-wrap' }

  return (
    <Modal open={!!call} onClose={onClose} title={`Call · ${call.customer_name ?? 'Unknown Caller'}`} width={620}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', width: '100%' }}>
          {call.recording_url && (
            <button onClick={() => window.open(call.recording_url as string, '_blank', 'noopener')}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>play_circle</span>Recording
            </button>
          )}
          {onEvaluate && (
            <button onClick={() => onEvaluate(call)}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>grade</span>{call.qa_evaluation_id ? 'Re-evaluate (QA)' : 'Evaluate (QA)'}
            </button>
          )}
          <button onClick={onClose}
            style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
            Close
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4], fontFamily: SORA }}>
        {/* Header chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <DirectionBadge direction={call.direction} />
          <OutcomePill outcome={call.outcome} direction={call.direction} />
          {call.disposition && (
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--txt2)' }}>{call.disposition}</span>
          )}
          {purpose && (
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${purpose.color}14`, color: purpose.color }}>{purpose.label}</span>
          )}
          {call.qa_score != null && (
            <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${BAND_COLOR[call.qa_band ?? ''] ?? NAVY}18`, color: BAND_COLOR[call.qa_band ?? ''] ?? NAVY }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{call.qa_passed ? 'verified' : 'error'}</span>{call.qa_score}%
            </span>
          )}
        </div>

        {/* Facts grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px 20px' }}>
          <Field label="Agent">{call.agent_name || '—'}</Field>
          <Field label="Caller">{call.customer_name || 'Unknown Caller'}</Field>
          <Field label="Phone"><span style={{ fontFamily: 'var(--font-mono)' }}>{call.phone || '—'}</span></Field>
          <Field label="CIF">{call.customer_cif ? <span style={{ fontFamily: 'var(--font-mono)' }}>{call.customer_cif}</span> : '—'}</Field>
          <Field label="Duration">{fmtDuration(call.duration_seconds)}</Field>
          <Field label="When">{fmtDatetime(call.called_at)}</Field>
          <Field label="Ticket type">{call.ticket_type || '—'}</Field>
          <Field label="Ticket">
            {call.ticket_id && call.ticket_ref ? (
              <span onClick={() => onOpenTicket(call.ticket_id as number)}
                style={{ ...NUM, color: NAVY, fontWeight: FW.bold, cursor: 'pointer', textDecoration: 'underline' }}>{call.ticket_ref}</span>
            ) : '—'}
          </Field>
        </div>

        {/* What the agent logged */}
        <div>
          <div style={secLbl}>Customer complaint / summary</div>
          <div style={noteBox}>{(call.notes ?? '').trim() || <span style={{ color: 'var(--txt3)' }}>Nothing logged.</span>}</div>
        </div>
        <div>
          <div style={secLbl}>Agent response / resolution</div>
          <div style={noteBox}>{(call.resolution ?? '').trim() || <span style={{ color: 'var(--txt3)' }}>Nothing logged.</span>}</div>
        </div>
      </div>
    </Modal>
  )
}

// ── Agent detail (supervisor drawer) ──────────────────────────────────────────

interface AgentDetail {
  agent:   { id: number; full_name: string; status: string; role: string; department: string; email: string; phone: string }
  calls:   { total: number; outbound: number; inbound: number; connected: number; missed: number; no_answer: number; avg_talk_sec: number; talk_time_sec: number }
  tickets: { open: number; resolved: number }
  qa:      { evaluations: number; avg_score: number | null; pass_rate: number | null }
  recent_calls: { id: number; direction: string; customer: string; phone: string; outcome: string; duration_sec: number | null; started_at: string; ticket_id: number | null }[]
}

function AgentDetailModal({ agent, dateFrom, dateTo, onClose, onOpenTicket }: {
  agent: { id: number; name: string } | null; dateFrom: string; dateTo: string
  onClose: () => void; onOpenTicket: (id: number) => void
}) {
  const [data, setData] = useState<AgentDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!agent) { setData(null); return }
    let alive = true
    setLoading(true)
    apiFetch<AgentDetail>(`/api/helpdesk/agents/${agent.id}/detail?date_from=${dateFrom}&date_to=${dateTo}`)
      .then(d => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [agent, dateFrom, dateTo])

  if (!agent) return null
  const c = data?.calls
  const connectRate = c && num(c.total) > 0 ? Math.round((num(c.connected) / num(c.total)) * 100) : 0

  const Stat = ({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) => (
    <div style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '9px 11px' }}>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ ...NUM, fontSize: 19, fontWeight: FW.extrabold, color: color ?? 'var(--txt)', marginTop: 3, lineHeight: 1 }}>{value}</div>
    </div>
  )
  const secLbl: React.CSSProperties = { fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 7 }

  return (
    <Modal open={!!agent} onClose={onClose} title={`Agent · ${agent.name}`} width={660}>
      {loading && !data ? (
        <div style={{ padding: 44, textAlign: 'center' }}><Spinner size={26} /></div>
      ) : data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.semibold }}>{data.agent.role || '—'}{data.agent.department ? ` · ${data.agent.department}` : ''}</span>
            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 9px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--chip-txt)', textTransform: 'capitalize' }}>{data.agent.status}</span>
            {data.agent.email && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{data.agent.email}</span>}
            {data.agent.phone && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{data.agent.phone}</span>}
          </div>

          <div>
            <div style={secLbl}>Call performance{dateFrom || dateTo ? ' · selected range' : ''}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: SP[2] }}>
              <Stat label="Total"          value={num(c?.total).toLocaleString()} />
              <Stat label="Outbound"       value={num(c?.outbound).toLocaleString()} color={BLUE} />
              <Stat label="Inbound"        value={num(c?.inbound).toLocaleString()} color={NAVY} />
              <Stat label="Connected"      value={num(c?.connected).toLocaleString()} color={GREEN} />
              <Stat label="Connect rate"   value={`${connectRate}%`} color={GREEN} />
              <Stat label="Missed (in)"    value={num(c?.missed).toLocaleString()} color={RED} />
              <Stat label="No answer (out)" value={num(c?.no_answer).toLocaleString()} color={AMBER} />
              <Stat label="Talk time"      value={fmtDuration(num(c?.talk_time_sec))} color={PURPLE} />
            </div>
          </div>

          <div>
            <div style={secLbl}>Tickets & QA</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: SP[2] }}>
              <Stat label="Open tickets" value={num(data.tickets.open).toLocaleString()} />
              <Stat label="Resolved"     value={num(data.tickets.resolved).toLocaleString()} color={GREEN} />
              <Stat label="QA avg"       value={data.qa.avg_score != null ? `${data.qa.avg_score}%` : '—'} />
              <Stat label="QA pass"      value={data.qa.pass_rate != null ? `${data.qa.pass_rate}%` : '—'} />
              <Stat label="Evaluations"  value={num(data.qa.evaluations).toLocaleString()} />
            </div>
          </div>

          <div>
            <div style={secLbl}>Recent calls</div>
            {data.recent_calls.length === 0 ? (
              <div style={{ color: 'var(--txt3)', fontSize: TEXT.sm, padding: '6px 0' }}>No calls in range.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 236, overflowY: 'auto' }}>
                {data.recent_calls.map((rc, i) => {
                  const inbound = (rc.direction || '').toLowerCase() === 'inbound'
                  const answered = !['missed', 'no_answer', 'voicemail'].includes((rc.outcome || '').toLowerCase())
                  const label = answered ? 'Done' : inbound ? 'Missed' : 'No answer'
                  const col = answered ? GREEN : inbound ? RED : 'var(--txt3)'
                  return (
                    <div key={rc.id} onClick={() => { if (rc.ticket_id) onOpenTicket(rc.ticket_id) }}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 2px', borderBottom: i < data.recent_calls.length - 1 ? '1px solid var(--bdr)' : 'none', cursor: rc.ticket_id ? 'pointer' : 'default' }}>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rc.customer}</span>
                      {rc.phone && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{rc.phone}</span>}
                      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{inbound ? 'In' : 'Out'} · {fmtDuration(rc.duration_sec)}</span>
                      <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: col, width: 62, textAlign: 'right' }}>{label}</span>
                      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', width: 74, textAlign: 'right' }}>{fmtDate(rc.started_at)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ padding: 24, color: 'var(--txt3)' }}>Could not load this agent.</div>
      )}
    </Modal>
  )
}
