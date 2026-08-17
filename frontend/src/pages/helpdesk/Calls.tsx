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
import LogCallModal, { LogCallInitial } from '../../components/LogCallModal'

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

// Call purpose = which book/queue the call belongs to (marketing/sales/collections);
// used to colour the Purpose column, CSV and detail view. The Log-a-Call form itself
// lives in the shared components/LogCallModal.tsx so it can never drift from My-Dashboard.
const PURPOSE_META: Record<string, { label: string; color: string }> = {
  marketing:   { label: 'Marketing / Leads', color: BLUE },
  sales:       { label: 'Outbound Sales',    color: PURPLE },
  collections: { label: 'Collections',       color: RED },
  support:     { label: 'Support',           color: GREEN },
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
  // Per-call detail modal (everything logged about one call).
  const [viewCall, setViewCall] = useState<CallLog | null>(null)
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

  // Log Call modal — the form itself is the shared components/LogCallModal.
  const [logOpen, setLogOpen] = useState(false)
  const [logInitial, setLogInitial] = useState<LogCallInitial | undefined>(undefined)

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
  // The form is the shared LogCallModal; opening it just seeds an optional prefill.

  function openLog(initial?: LogCallInitial) {
    setLogInitial(initial)
    setLogOpen(true)
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
          // Log a report for this number — pre-fills the Log-a-Call form so the agent
          // just records the outcome/notes for that customer.
          {
            icon: 'edit_note', label: 'Log a report',
            onClick: () => openLog({
              name: r.customer_name || undefined,
              phone: r.phone || undefined,
              cif: r.customer_cif || undefined,
              direction: r.direction || 'Inbound',
              purpose: r.purpose || undefined,
            }),
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

  return (
    <Page
      title="Call Log"
      subtitle={CAN_EVALUATE ? 'All inbound and outbound calls across agents' : 'Your inbound and outbound calls'}
      actions={
        <div style={{ display: 'flex', gap: SP[2] }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
          <button onClick={() => openLog()}
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

      {evalCall && (
        <QAEvaluation
          call={{ id: evalCall.id, agent_name: evalCall.agent_name, customer_name: evalCall.customer_name, phone: evalCall.phone, direction: evalCall.direction, called_at: evalCall.called_at, duration_seconds: evalCall.duration_seconds }}
          onClose={() => setEvalCall(null)}
          onSaved={() => { load(); loadStats() }}
        />
      )}

      <LogCallModal open={logOpen} initial={logInitial}
        onClose={() => setLogOpen(false)} onSaved={() => { load(); loadStats() }} />
      <CallDetailModal call={viewCall} onClose={() => setViewCall(null)}
        onEvaluate={CAN_EVALUATE ? c => { setViewCall(null); setEvalCall(c) } : undefined}
        onOpenTicket={id => { setViewCall(null); navigate(`/helpdesk/${id}`) }} />
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
