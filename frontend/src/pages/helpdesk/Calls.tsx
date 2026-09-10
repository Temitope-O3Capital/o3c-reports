import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { EArea, EDonut } from '../../components/echarts'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar, Pagination,
  ErrBanner, DateFilter, Modal, Spinner, KpiCard, NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { RecordingPlayer, RecordingModal } from '../../components/RecordingPlayer'
import { fmtDatetime, fmtDate, today } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, RED, AMBER, NUM, SORA, FW, RADIUS, SP, TEXT } from '../../lib/design'
import QAEvaluation from './QAEvaluation'
import { BAND_COLOR } from '../../lib/qa'
import { toast } from 'sonner'
import LogCallModal, { LogCallInitial, dispositionCopy } from '../../components/LogCallModal'
import CallLogEditModal from '../../components/CallLogEditModal'
import CallReviewPanel from '../../components/CallReviewPanel'
import { hasPage } from '../../hooks/useAuth'

function myRole(): string { try { return String(JSON.parse(localStorage.getItem('o3c_user') || '{}').role || '') } catch { return '' } }
// Who may correct someone else's write-up. Mirrors the server rule; the server is
// the one that enforces it — this only decides whether the control is offered.
const CAN_SUPERVISE = /head|admin|super|manager|lead|supervisor/i.test(myRole())
// QA evaluation is a call-centre function and /api/qa is gated to `call_center` on the
// server, so only offer the Evaluate control to a supervisor who actually holds that
// page — otherwise a helpdesk-only head (care/finance/…) sees a button that 403s.
const CAN_EVALUATE = CAN_SUPERVISE && hasPage('call_center')
function myUserId(): number { try { return Number(JSON.parse(localStorage.getItem('o3c_user') || '{}').id) || -1 } catch { return -1 } }
const CURRENT_USER_ID = myUserId()

// Rows fetched per server page of the call log. Uniform page size = uniform table
// height, so paging no longer makes the card grow/shrink between pages.
const PAGE_SIZE = 20

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
  recording_filename: string | null
  has_recording: boolean
  source_system: string | null
  qa_evaluation_id: number | null
  qa_score: number | null
  qa_band: string | null
  qa_passed: boolean | null
  // How many times this agent rang this number within 15 minutes either side —
  // counted server-side so it stays correct across pagination.
  episode_calls?: number | null
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
  // Counts keyed by the SAME category the table pill shows (direction folded in),
  // so the Outcome filter and the donut speak the pill's language, not the raw
  // telephony outcome. See RESULT_CFG.
  by_result?: { cat: string; count: number }[]
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
  retention:   { label: 'Retention',         color: AMBER },
  other:       { label: 'Other',             color: NAVY },
  unspecified: { label: 'Support / Unspecified', color: GREEN },
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
  escalated:   { bg: `${RED}12`,   txt: RED,   label: 'Escalated',   chart: PURPLE },
}

const OUTCOME_CHART_FALLBACK = [PURPLE, BLUE, AMBER, GREEN, RED]

// The displayed-result vocabulary — one entry per label the OutcomePill can show,
// with direction already folded in (inbound-unanswered = "Missed", outbound = "No
// Answer"). The Outcome filter options and the By-Outcome donut are both built from
// this, so what you filter and chart is exactly what you see in the table. Colours
// mirror the pill's text colour for each label.
const RESULT_CFG: Record<string, { label: string; color: string }> = {
  connected:   { label: 'Connected',   color: GREEN },
  resolved:    { label: 'Resolved',    color: GREEN },
  missed:      { label: 'Missed',      color: RED },
  no_answer:   { label: 'No Answer',   color: 'var(--txt2)' },
  transferred: { label: 'Transferred', color: AMBER },
  escalated:   { label: 'Escalated',   color: RED },
}

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

function OutcomePill({ outcome, direction, durationSec, hasRecording, sourceSystem }: {
  outcome: string | null; direction?: string; durationSec?: number | null; hasRecording?: boolean; sourceSystem?: string | null
}) {
  let o = (outcome ?? '').toLowerCase()
  // Zoho Desk writes a call record for activity that never reached the phone.
  // A 'completed' dial shorter than 5 seconds with no recording never became a
  // conversation — showing it as "Connected" tells the agent a call happened when
  // it dropped on ring. A manually logged call-centre row is exempt (the agent
  // recorded a real interaction regardless of the stored duration).
  if (o === 'completed' && (durationSec ?? 0) < 5 && !hasRecording && (sourceSystem ?? '') !== 'call_center') o = 'missed'
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
  // No Y-axis: the exact figure is on hover, and the latest value is stamped on each
  // line's endpoint (endLabel) — a single reference number that stays readable
  // even across a 365-day range, instead of a scale rail down the side.
  const data = useMemo(() => series.map(d => ({
    date: fmtDate(d.day, { month: 'short', day: 'numeric' }),
    Inbound: num(d.inbound),
    Outbound: num(d.outbound),
  })), [series])

  return (
    <EArea
      data={data}
      xKey="date"
      height={180}
      stack
      endLabel
      hideYAxis
      valueFmt={(v) => v.toLocaleString()}
      endFmt={(v) => v.toLocaleString()}
      series={[
        { key: 'Outbound', name: 'Outbound', color: PURPLE },
        { key: 'Inbound', name: 'Inbound', color: BLUE },
      ]}
    />
  )
}

function OutcomeDonut({ series }: { series: NonNullable<CallStats['by_result']> }) {
  const data = useMemo(() => series.map(o => {
    const cfg = RESULT_CFG[(o.cat || '').toLowerCase()]
    // Only pass a concrete colour to the canvas; RESULT_CFG carries CSS vars
    // (e.g. var(--txt2)) for pill text that ECharts can't read, so fall those
    // back to the categorical palette below.
    const c = cfg?.color
    return { name: cfg?.label ?? (o.cat || 'Other'), value: num(o.count), color: c && !c.startsWith('var(') ? c : undefined }
  }), [series])

  return (
    <EDonut
      data={data}
      valueKey="value"
      nameKey="name"
      colorFn={(o, i) => o.color ?? OUTCOME_CHART_FALLBACK[i % OUTCOME_CHART_FALLBACK.length]}
      size={180}
      inner={46}
      legend
      valueFmt={(v) => v.toLocaleString()}
    />
  )
}

// ── Zoho Sync Bar ─────────────────────────────────────────────────────────────

// ── Main component ─────────────────────────────────────────────────────────────

export default function Calls() {
  const navigate = useNavigate()
  const [rows, setRows]     = useState<CallLog[]>([])
  const [stats, setStats]   = useState<CallStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  // Server-side pagination: the log holds tens of thousands of calls, so the table
  // pages through the whole filtered set on the server (one page fetched at a time)
  // rather than client-slicing a single capped batch — which only ever reached the
  // most-recent few hundred. `total` is the exact filtered count (COUNT(*) OVER())
  // returned by the list query itself, so it matches the rows and excludes
  // merged/voided (which the stats total counts, and so must not drive paging).
  const [page,  setPage]  = useState(1)
  const [total, setTotal] = useState(0)
  // Supervisor "view agent" drawer target.
  // Per-call detail modal (everything logged about one call).
  const [viewCall, setViewCall] = useState<CallLog | null>(null)
  const [playCall, setPlayCall] = useState<CallLog | null>(null)
  // Filters
  const [search, setSearch] = useState('')
  // Search hits the server (caller name, number or agent). Debounced so typing
  // doesn't fire a fetch per keystroke — the box stays responsive, the query waits
  // for a pause.
  const dq = useDebouncedValue(search, 400)
  const [fDirs,       setFDirs]       = useState(new Set<string>())
  // Outcome filter is keyed by the displayed pill category (see RESULT_CFG), sent to
  // the server as ?result= so "Missed" filters the calls that actually show as missed.
  const [fResults,    setFResults]    = useState(new Set<string>())
  // Call type / purpose filter (marketing, support, sales, collections, retention,
  // other) — sent to the server as ?purpose= so the log, KPIs and charts all narrow
  // to one book at once.
  const [fPurposes,   setFPurposes]   = useState(new Set<string>())
  // Default to the last 12 months — call data is historical (synced from Zoho),
  // so a "this month" default would show nothing.
  const [dateFrom,    setDateFrom]    = useState(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10))
  const [dateTo,      setDateTo]      = useState(today())
  // Duplicates: one conversation reaches us as several rows (Zoho records per
  // activity). The log collapses those to one row per call by default; a supervisor
  // can flip to the full per-attempt audit view.
  const [showAllLegs, setShowAllLegs] = useState(false)

  // QA evaluation modal (opened from a call's Evaluate action)
  const [evalCall, setEvalCall] = useState<CallLog | null>(null)
  const [editCall, setEditCall] = useState<CallLog | null>(null)
  // Bumped after a correction so the review panel refetches — a call just fixed
  // should leave the flagged list immediately, not on the next page load.
  const [reviewKey, setReviewKey] = useState(0)

  // Log Call modal — the form itself is the shared components/LogCallModal.
  const [logOpen, setLogOpen] = useState(false)
  const [logInitial, setLogInitial] = useState<LogCallInitial | undefined>(undefined)

  const abortRef = useRef<AbortController | null>(null)

  // Shared filter — the log table, KPI strip and charts all move together.
  const filterQS = useCallback(() => {
    const p = new URLSearchParams()
    if (dq.trim()) p.set('search', dq.trim())
    if (fDirs.size)    p.set('direction', [...fDirs].join(','))
    if (fResults.size) p.set('result', [...fResults].join(','))
    if (fPurposes.size) p.set('purpose', [...fPurposes].join(','))
    p.set('date_from', dateFrom)
    p.set('date_to', dateTo)
    if (showAllLegs) p.set('collapse', '0')
    return p
  }, [dq, fDirs, fResults, fPurposes, dateFrom, dateTo, showAllLegs])

  // silent: a background refresh must not blank the table. Showing skeletons every
  // time the change-feed ticks is what made the page look like it was breaking
  // underneath people — and worse, it discarded whatever they were reading.
  const load = useCallback(async (silent = false) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    if (!silent) setLoading(true)
    setError(null)
    try {
      const p = filterQS()
      p.set('limit', String(PAGE_SIZE))
      p.set('offset', String((page - 1) * PAGE_SIZE))
      const data = await apiFetch<(CallLog & { total_count?: number })[]>(`/api/helpdesk/calls?${p}`, { signal: abortRef.current.signal })
      const list = Array.isArray(data) ? data : []
      setRows(list)
      // total_count rides on every row (window count over the full filtered set).
      // Keep the prior total if a non-first page comes back empty mid-transition, so
      // the pager doesn't flicker to zero.
      if (list.length) setTotal(Number(list[0].total_count) || 0)
      else if (page === 1) setTotal(0)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally { setLoading(false) }
  }, [filterQS, page])

  // KPIs + charts come from a server-side aggregate over the FULL filtered set —
  // never from the 200-row table page (which would badly under-count 98k calls).
  const loadStats = useCallback(async () => {
    try {
      const raw = await apiFetch<any>(`/api/helpdesk/calls/stats?${filterQS()}`)
      setStats((raw?.data ?? raw) as CallStats)
    } catch { /* non-fatal — KPI cards fall back to dashes */ }
  }, [filterQS])

  // A new filter/date/search set changes what "page 1" means, so jump back to it —
  // otherwise you could be stranded on page 40 of a result that now has 3 pages.
  // setPage(1) is a no-op when already on page 1, so this won't double-fetch there.
  useEffect(() => { setPage(1) }, [dq, fDirs, fResults, fPurposes, dateFrom, dateTo, showAllLegs])

  // Reload on every filter/page change, but only show skeletons on the FIRST load.
  // Subsequent loads (paging especially) run silent so the table keeps its current
  // rows and simply swaps them in — it never collapses to 8 skeleton rows and back,
  // which is what read as the table "zooming out" on each page change.
  const firstLoad = useRef(true)
  useEffect(() => { load(!firstLoad.current); firstLoad.current = false }, [load])
  useEffect(() => { loadStats() }, [loadStats])
  // Throttle live refreshes: the change-feed ticks on every call event, and during a
  // drop storm that reordered the log under the supervisor constantly. Coalesce to at
  // most once every 30s so the table stays readable; a filter/date change still
  // refreshes immediately via the effect above.
  const liveThrottle = useRef(0)
  useLiveData(() => {
    const now = Date.now()
    if (now - liveThrottle.current < 30_000) return
    liveThrottle.current = now
    load(true); loadStats()
  }, { topics: ['calls', 'tickets'] })

  // ── KPIs computed from loaded rows ────────────────────────────────────────

  const kpis = useMemo(() => {
    const s = stats?.summary
    const total     = num(s?.total)
    const connected = num(s?.connected)
    const missed    = num(s?.missed)
    const outbound  = num(s?.outbound)
    const inbound   = num(s?.inbound)
    // Use the backend's avg_duration_sec: it averages over exactly the connected calls
    // whose duration is in the 0–4h sane range. Recomputing total_talk_sec/connected
    // here understated it, because total_talk_sec excludes out-of-range durations that
    // `connected` still counts, so the denominator's population was the larger one.
    const avgTalk   = num(s?.avg_duration_sec)
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

  // Outcome filter options are the displayed pill categories that actually occur in
  // the data — so the choices read exactly like the Outcome column ("Missed", "No
  // Answer", "Connected") instead of the raw telephony vocabulary, and selecting one
  // returns precisely the rows that show that pill.
  const outcomeOpts = useMemo(() =>
    (stats?.by_result ?? [])
      .filter(o => RESULT_CFG[(o.cat ?? '').toLowerCase()])
      .map(o => {
        const cfg = RESULT_CFG[(o.cat ?? '').toLowerCase()]
        return { value: (o.cat ?? '').toLowerCase(), label: cfg.label, color: cfg.color }
      })
  , [stats])

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
      render: r => <OutcomePill outcome={r.outcome} direction={r.direction} durationSec={r.duration_seconds} hasRecording={r.has_recording} sourceSystem={r.source_system} />,
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
          {/* One conversation reaches us as several rows, because Zoho records
              activity rather than calls. This table keeps every row — it is the
              audit view — but says plainly when a row is one leg of a single
              dialling episode, so four rows no longer read as four calls. */}
          {(r.episode_calls ?? 0) > 1 && (
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 12 }}>repeat</span>
              one of {r.episode_calls} attempts
            </div>
          )}
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
          // Correct or withdraw the log. Offered on your own calls, and on any call
          // to a supervisor; the API enforces the same rule, and every change is
          // recorded with what it replaced. Available on ANY call (not only ones
          // with a write-up) — you still need to withdraw a spurious/duplicate
          // Zoho record or add a missing write-up.
          ...((r.agent_id === CURRENT_USER_ID || CAN_SUPERVISE) ? [{
            icon: 'edit', label: 'Correct or withdraw this call',
            onClick: () => setEditCall(r),
          }] : []),
          // Play the Zoho Voice recording in-app (streamed). Shown for a connected call
          // even without an attached recording — the player then offers "Fetch from Zoho"
          // to pull it on demand. Missed/0-sec calls (never recorded) get no button.
          ...((r.has_recording || (r.outcome === 'completed' && (r.duration_seconds ?? 0) > 0)) ? [{
            icon: r.has_recording ? 'play_circle' : 'cloud_sync',
            label: r.has_recording ? 'Play recording' : 'Fetch recording from Zoho',
            onClick: () => setPlayCall(r),
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
      loading={loading && rows.length === 0}
      skeletonKpis={5}
      actions={
        <div style={{ display: 'flex', gap: SP[2] }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={() => openLog()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add_call</span>
            Log Call
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

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
            <OutcomeDonut series={stats?.by_result ?? []} />
          </SectionCard>
        </div>
      ) : null}

      {/* Table */}
      <SectionCard padding={false} title="Call Records"
        subtitle={`${total.toLocaleString()} ${showAllLegs ? `call record${total !== 1 ? 's' : ''}` : `call${total !== 1 ? 's' : ''} · duplicate attempts collapsed`} in range`}
        actions={
          <button
            onClick={() => setShowAllLegs(v => !v)}
            title="Zoho logs several rows per call. Collapsed shows one row per conversation; All attempts shows every dialing leg (audit view)."
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.md,
              border: '1px solid var(--bdr)', background: showAllLegs ? NAVY : 'var(--card)',
              color: showAllLegs ? '#fff' : 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{showAllLegs ? 'unfold_more' : 'unfold_less'}</span>
            {showAllLegs ? 'Showing all attempts' : 'Duplicates collapsed'}
          </button>
        }>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
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
              selected: fResults,
              onChange: setFResults,
            },
            {
              key: 'purpose',
              label: 'Type',
              options: [
                { value: 'Marketing', color: BLUE },
                { value: 'Sales', color: PURPLE },
                { value: 'Collections', color: RED },
                { value: 'Retention', color: AMBER },
                { value: 'Other', color: NAVY },
              ],
              selected: fPurposes,
              onChange: setFPurposes,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFDirs(new Set()); setFResults(new Set()); setFPurposes(new Set()) }}
          onApply={load}
          resultCount={total}
          totalCount={Math.max(kpis.total, total)}
          placeholder="Search caller, number, or agent…"
        />

        {/* No client pageSize: the rows ARE one server page, so the table renders them
            all and the server pager below drives navigation over the whole log. */}
        <DataTable<CallLog>
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={PAGE_SIZE}
          emptyText="No call records found for the selected filters"
        />
        {/* Self-hides at a single page; renders its own top border + padding. */}
        <Pagination
          page={page}
          pages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          total={total}
          pageSize={PAGE_SIZE}
          onPage={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
        />
      </SectionCard>

      {/* Flagged logs and the correction trail. Supervisors only — and the panel
          renders nothing at all when both lists are empty, so it stays out of the
          way on a clean day. */}
      {CAN_SUPERVISE && (
        <CallReviewPanel
          reloadKey={reviewKey}
          onEdit={id => {
            const row = rows.find(r => r.id === id)
            // The flagged call may not be on the page currently loaded, so fall
            // back to the little the panel already knows rather than doing nothing.
            setEditCall(row ?? ({ id, agent_name: '', customer_name: null, phone: '',
              direction: 'outbound', duration_seconds: 0, disposition: null,
              purpose: null, notes: null, resolution: null } as unknown as CallLog))
          }}
        />
      )}

      {editCall && (
        <CallLogEditModal
          call={{
            id: editCall.id, agent_name: editCall.agent_name, customer_name: editCall.customer_name,
            phone: editCall.phone, direction: editCall.direction,
            duration_seconds: editCall.duration_seconds, disposition: editCall.disposition,
            purpose: editCall.purpose, notes: editCall.notes, resolution: editCall.resolution,
          }}
          onClose={() => setEditCall(null)}
          onSaved={() => { load(); loadStats(); setReviewKey(k => k + 1) }}
        />
      )}

      {evalCall && (
        <QAEvaluation
          call={{ id: evalCall.id, agent_name: evalCall.agent_name, customer_name: evalCall.customer_name, phone: evalCall.phone, direction: evalCall.direction, called_at: evalCall.called_at, duration_seconds: evalCall.duration_seconds, has_recording: evalCall.has_recording }}
          onClose={() => setEvalCall(null)}
          onSaved={() => { load(); loadStats() }}
        />
      )}

      <LogCallModal open={logOpen} initial={logInitial}
        onClose={() => setLogOpen(false)} onSaved={() => { load(); loadStats() }} />
      <CallDetailModal call={viewCall} onClose={() => setViewCall(null)}
        onEvaluate={CAN_EVALUATE ? c => {
          // Close the detail modal, then open QA once its exit animation has
          // finished — sequencing the two so their transitions don't overlap
          // (the overlap is what read as a shaky/flashing hand-off).
          setViewCall(null)
          setTimeout(() => setEvalCall(c), 200)
        } : undefined}
        onOpenTicket={id => { setViewCall(null); navigate(`/helpdesk/${id}`) }} />

      <RecordingModal
        callId={playCall?.id ?? null}
        title={`Recording · ${playCall?.customer_name ?? playCall?.phone ?? 'Call'}`}
        subtitle={playCall ? `${playCall.direction}${playCall.phone ? ` · ${playCall.phone}` : ''}${playCall.agent_name ? ` · ${playCall.agent_name}` : ''}` : undefined}
        onClose={() => setPlayCall(null)}
      />
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
          <OutcomePill outcome={call.outcome} direction={call.direction} durationSec={call.duration_seconds} hasRecording={call.has_recording} sourceSystem={call.source_system} />
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

        {/* Call recording (Zoho Voice, streamed on demand) */}
        {call.has_recording && (
          <div>
            <div style={secLbl}>Call recording</div>
            <RecordingPlayer callId={call.id} autoPlay={false} />
          </div>
        )}

        {/* What the agent logged — using the SAME contextual field labels the agent saw
            in the Log-Call form (driven by the call's purpose + disposition), not the
            one-size-fits-all "complaint / resolution". */}
        {(() => {
          const copy = dispositionCopy(call.disposition ?? '', call.purpose ?? '')
          const res = (call.resolution ?? '').trim()
          return (
            <>
              <div>
                <div style={secLbl}>{copy.notesLabel}</div>
                <div style={noteBox}>{(call.notes ?? '').trim() || <span style={{ color: 'var(--txt3)' }}>Nothing logged.</span>}</div>
              </div>
              {/* Only show the response field when this disposition actually uses one
                  (or the agent recorded something), so a "Paid"/"Wrong Number" call
                  doesn't show an empty "resolution" box. */}
              {(!copy.hideRes || res) && (
                <div>
                  <div style={secLbl}>{copy.resLabel || 'Outcome'}</div>
                  <div style={noteBox}>{res || <span style={{ color: 'var(--txt3)' }}>Nothing logged.</span>}</div>
                </div>
              )}
            </>
          )
        })()}
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
  recent_calls: { id: number; direction: string; customer: string; phone: string; outcome: string; duration_sec: number | null; started_at: string; ticket_id: number | null; has_recording?: boolean }[]
}

function AgentDetailModal({ agent, dateFrom, dateTo, onClose, onOpenTicket }: {
  agent: { id: number; name: string } | null; dateFrom: string; dateTo: string
  onClose: () => void; onOpenTicket: (id: number) => void
}) {
  const [data, setData] = useState<AgentDetail | null>(null)
  const [loading, setLoading] = useState(false)
  // Recent call whose recording is open in the streaming player (stacks over this drawer).
  const [playRc, setPlayRc] = useState<AgentDetail['recent_calls'][number] | null>(null)

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
                      {/* Play the recording in-app (same streaming player as the log);
                          stop the row's ticket-open click from firing underneath it. */}
                      {rc.has_recording ? (
                        <button title="Play recording" onClick={e => { e.stopPropagation(); setPlayRc(rc) }}
                          style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: GREEN, cursor: 'pointer' }}>
                          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>play_circle</span>
                        </button>
                      ) : <span style={{ width: 24, flexShrink: 0 }} />}
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
      <RecordingModal
        callId={playRc?.id ?? null}
        title={`Recording · ${playRc?.customer ?? playRc?.phone ?? 'Call'}`}
        subtitle={playRc ? `${playRc.direction}${playRc.phone ? ` · ${playRc.phone}` : ''}` : undefined}
        onClose={() => setPlayRc(null)}
      />
    </Modal>
  )
}
