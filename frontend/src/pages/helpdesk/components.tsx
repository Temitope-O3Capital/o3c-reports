import { NAVY, AMBER, GREEN, RED, BLUE } from '../../components/UI'

const STATUS_BADGE: Record<string, { bg: string; color: string }> = {
  open:        { bg: 'rgba(14,40,65,0.1)',    color: NAVY },
  pending:     { bg: 'rgba(217,119,6,0.1)',   color: AMBER },
  in_progress: { bg: 'rgba(37,99,235,0.1)',   color: BLUE },
  resolved:    { bg: 'rgba(5,150,105,0.1)',   color: GREEN },
  closed:      { bg: 'rgba(100,116,139,0.1)', color: 'var(--txt2)' },
}

const PRIORITY_BADGE: Record<string, { bg: string; color: string }> = {
  urgent: { bg: 'rgba(192,0,0,0.1)',    color: RED },
  high:   { bg: 'rgba(234,88,12,0.1)',  color: '#EA580C' },
  normal: { bg: 'rgba(100,116,139,0.1)',color: 'var(--txt2)' },
  low:    { bg: 'rgba(148,163,184,0.1)',color: 'var(--txt2)' },
}

export function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase().replace(/\s+/g, '_')
  const s = STATUS_BADGE[key] ?? { bg: 'rgba(14,40,65,0.06)', color: 'var(--txt2)' }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
      {status}
    </span>
  )
}

export function PriorityPill({ priority }: { priority: string }) {
  const key = priority.toLowerCase()
  const s = PRIORITY_BADGE[key] ?? { bg: 'rgba(100,116,139,0.1)', color: 'var(--txt2)' }
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}>
      {priority}
    </span>
  )
}
