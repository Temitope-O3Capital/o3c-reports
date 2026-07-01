import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPut } from '../lib/api'
import { fmt } from '../lib/fmt'
import { Page, ErrBanner, NAVY, RED, AMBER, GREEN } from '../components/UI'

interface ApprovalItem {
  module: string        // "LOS" | "Write-off" | "Leave" | "Compliance"
  item_id: number
  reference: string
  title: string
  description: string
  stage: string
  amount_kobo?: number
  requested_by: string
  waiting_days: number
  priority: string      // "high" | "medium" | "normal"
}

interface Summary {
  los: number
  write_offs: number
  leave: number
  compliance: number
  total: number
}

const MODULES = ['All', 'LOS', 'Write-off', 'Leave', 'Compliance'] as const
type ModuleTab = typeof MODULES[number]

/* ── Module badge config ────────────────────────────────────────── */
const MODULE_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  LOS:        { bg: NAVY,      text: '#fff',    icon: 'description' },
  'Write-off': { bg: RED,       text: '#fff',    icon: 'money_off' },
  Leave:      { bg: GREEN,     text: '#fff',    icon: 'event_available' },
  Compliance: { bg: '#7C3AED', text: '#fff',    icon: 'verified_user' },
}

/* ── Priority badge config ──────────────────────────────────────── */
const PRIORITY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  high:   { bg: '#FEF2F2', text: '#B91C1C', label: 'High' },
  medium: { bg: '#FFFBEB', text: '#92400E', label: 'Medium' },
  normal: { bg: '#F1F5F9', text: '#475569', label: 'Normal' },
}

/* ── Review link map ────────────────────────────────────────────── */
function reviewPath(item: ApprovalItem): string {
  switch (item.module) {
    case 'LOS':        return `/sales/applications/${item.item_id}`
    case 'Write-off':  return '/recovery/cases'
    case 'Leave':      return '/hr/leave'
    case 'Compliance': return '/compliance/findings'
    default:           return '/'
  }
}

/* ── Compact summary chip ───────────────────────────────────────── */
function SummaryChip({
  label, count, color, icon,
}: {
  label: string; count: number; color: string; icon: string
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
      style={{ background: `${color}10`, border: `1px solid ${color}25` }}>
      <span className="material-symbols-rounded text-[15px]" style={{ color }}>{icon}</span>
      <span className="text-[12px] font-semibold" style={{ color: '#334155' }}>{label}</span>
      <span className="text-[12px] font-bold tabular-nums" style={{ color }}>{count}</span>
    </div>
  )
}

/* ── Module badge ───────────────────────────────────────────────── */
function ModuleBadge({ module }: { module: string }) {
  const cfg = MODULE_COLORS[module] ?? { bg: '#64748B', text: '#fff', icon: 'pending' }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-bold tracking-wide"
      style={{ background: cfg.bg, color: cfg.text }}>
      <span className="material-symbols-rounded text-[12px]">{cfg.icon}</span>
      {module}
    </span>
  )
}

/* ── Priority badge ─────────────────────────────────────────────── */
function PriorityBadge({ priority }: { priority: string }) {
  const cfg = PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.normal
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold"
      style={{ background: cfg.bg, color: cfg.text }}>
      {cfg.label}
    </span>
  )
}

/* ── Approval card ──────────────────────────────────────────────── */
function ApprovalCard({ item, onActioned }: { item: ApprovalItem; onActioned?: () => void }) {
  const navigate = useNavigate()
  const hasAmount = item.amount_kobo != null && item.amount_kobo > 0
  const [acting, setActing] = useState<'approve' | 'decline' | null>(null)
  const [actErr, setActErr] = useState('')

  async function leaveAction(action: 'approve' | 'decline') {
    setActing(action); setActErr('')
    try {
      await apiPut(`/api/hr/leave/${item.item_id}/${action}`, {})
      onActioned?.()
    } catch (e: any) {
      setActErr(e.message || `${action} failed`)
      setActing(null)
    }
  }

  return (
    <div className="card px-5 py-4 flex items-start gap-4">
      {/* Left */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <ModuleBadge module={item.module} />
          <span className="text-[11px] font-mono text-slate-400">{item.reference}</span>
          <span className="text-[11px] text-slate-300">·</span>
          <span className="text-[11px] text-slate-400">{item.stage}</span>
        </div>
        <p className="text-[14px] font-semibold text-slate-800 leading-snug truncate">{item.title}</p>
        <p className="text-[12px] text-slate-500 mt-0.5 line-clamp-2">{item.description}</p>
        <p className="text-[11px] text-slate-400 mt-1.5">
          Requested by <span className="font-medium text-slate-600">{item.requested_by}</span>
        </p>
        {actErr && <p className="text-[11px] text-red-500 mt-1">{actErr}</p>}
      </div>

      {/* Center */}
      <div className="flex flex-col items-end gap-2 shrink-0">
        <PriorityBadge priority={item.priority} />
        <span className="text-[11px] font-medium"
          style={{ color: item.waiting_days >= 7 ? '#C00000' : item.waiting_days >= 3 ? '#D97706' : '#64748B' }}>
          <span className="material-symbols-rounded text-[13px] align-middle mr-0.5"
            style={{ color: item.waiting_days >= 7 ? '#C00000' : item.waiting_days >= 3 ? '#D97706' : '#94A3B8' }}>
            {item.waiting_days >= 7 ? 'warning' : 'schedule'}
          </span>
          {item.waiting_days}d waiting
        </span>
        {hasAmount && (
          <span className="text-[12px] font-semibold font-mono text-slate-700">
            {fmt((item.amount_kobo as number) / 100)}
          </span>
        )}
      </div>

      {/* Right */}
      <div className="shrink-0 self-center flex flex-col gap-1.5 items-end">
        {item.module === 'Leave' ? (
          <>
            <button
              disabled={!!acting}
              onClick={() => leaveAction('approve')}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ background: GREEN }}>
              <span className="material-symbols-rounded text-[14px]">check</span>
              {acting === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button
              disabled={!!acting}
              onClick={() => leaveAction('decline')}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ background: RED }}>
              <span className="material-symbols-rounded text-[14px]">close</span>
              {acting === 'decline' ? 'Declining…' : 'Decline'}
            </button>
          </>
        ) : (
          <button
            onClick={() => navigate(reviewPath(item))}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[14px]">open_in_new</span>
            Review
          </button>
        )}
      </div>
    </div>
  )
}

/* ── Empty state ────────────────────────────────────────────────── */
function EmptyState() {
  return (
    <div className="card flex flex-col items-center justify-center py-20 text-center">
      <span className="material-symbols-rounded text-[52px] text-slate-200 mb-3">task_alt</span>
      <p className="text-[15px] font-semibold text-slate-600">No pending approvals</p>
      <p className="text-[13px] text-slate-400 mt-1">All caught up!</p>
    </div>
  )
}

/* ── Main component ─────────────────────────────────────────────── */
export default function Approvals() {
  const [items, setItems]     = useState<ApprovalItem[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [filter, setFilter]   = useState<ModuleTab>('All')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [p, s] = await Promise.allSettled([
        apiFetch('/api/approvals/pending'),
        apiFetch('/api/approvals/summary'),
      ])
      if (p.status === 'fulfilled') {
        const raw = p.value.data ?? p.value
        setItems(Array.isArray(raw) ? raw : [])
      }
      if (s.status === 'fulfilled') {
        setSummary(s.value.data ?? s.value)
      }
      if ([p, s].every(r => r.status === 'rejected')) {
        setError((p as PromiseRejectedResult).reason?.message ?? 'Failed to load')
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = filter === 'All'
    ? items
    : items.filter(i => i.module === filter)

  const total = summary?.total ?? items.length

  return (
    <Page dept="Platform" title="Approvals" subtitle="Items pending your review and action">
      <ErrBanner msg={error} />

      {/* Summary chips */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 w-28 rounded-xl skeleton" />
          ))
        ) : summary ? (
          <>
            <SummaryChip label="LOS"        count={summary.los}       color={NAVY}      icon="description" />
            <SummaryChip label="Write-offs" count={summary.write_offs} color={RED}       icon="money_off" />
            <SummaryChip label="Leave"      count={summary.leave}     color={GREEN}     icon="event_available" />
            <SummaryChip label="Compliance" count={summary.compliance} color="#7C3AED"  icon="verified_user" />
          </>
        ) : null}

        {!loading && total > 0 && (
          <div className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-semibold"
            style={{ background: 'rgba(14,40,65,0.07)', color: NAVY }}>
            <span className="material-symbols-rounded text-[14px]">pending_actions</span>
            {total} total pending
          </div>
        )}
      </div>

      {/* Module filter tabs */}
      <div className="flex gap-1 mb-5 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        {MODULES.map(tab => {
          const active = filter === tab
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className="px-4 py-2 text-[12px] font-semibold relative transition-colors"
              style={{ color: active ? NAVY : '#94A3B8' }}>
              {tab}
              {active && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t"
                  style={{ background: NAVY }} />
              )}
            </button>
          )
        })}
      </div>

      {/* Items list */}
      {loading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4 flex gap-4 items-start">
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-48 rounded" />
                <div className="skeleton h-3 w-full rounded" />
                <div className="skeleton h-3 w-3/4 rounded" />
              </div>
              <div className="skeleton h-8 w-16 rounded-lg" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map(item => (
            <ApprovalCard key={`${item.module}-${item.item_id}`} item={item} onActioned={load} />
          ))}
        </div>
      )}
    </Page>
  )
}
