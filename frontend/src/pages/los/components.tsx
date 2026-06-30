import { snake } from '../../lib/labels'

export const STAGE_COLORS: Record<string, { bg: string; text: string }> = {
  draft:               { bg: 'rgba(107,114,128,0.12)', text: '#6B7280' },
  submitted:           { bg: 'rgba(37,99,235,0.10)',   text: '#2563EB' },
  document_collection: { bg: 'rgba(124,58,237,0.10)',  text: '#7C3AED' },
  risk_review:         { bg: 'rgba(217,119,6,0.12)',   text: '#D97706' },
  risk_head_review:    { bg: 'rgba(234,88,12,0.12)',   text: '#EA580C' },
  pending_conditions:  { bg: 'rgba(79,70,229,0.10)',   text: '#4F46E5' },
  finance_approval:    { bg: 'rgba(14,165,233,0.10)',  text: '#0EA5E9' },
  booking:             { bg: 'rgba(16,185,129,0.12)',  text: '#10B981' },
  active:              { bg: 'rgba(5,150,105,0.10)',   text: '#059669' },
  declined:            { bg: 'rgba(192,0,0,0.09)',     text: '#C00000' },
}

export function StageBadge({ stage }: { stage: string }) {
  const c = STAGE_COLORS[stage] ?? { bg: 'rgba(14,40,65,0.07)', text: '#475569' }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: c.bg, color: c.text }}
    >
      {snake(stage)}
    </span>
  )
}
