import type { ReactNode } from 'react'
import { INTER, NUM, TEXT, FW, RADIUS } from '../../lib/design'

// Pieces every executive drilldown needs. Each of the seven pages had its own copy of
// the period filter and the chart tooltip, which meant a fix to one of them reached one
// page. They live here now.

export type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'

export const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' },
  { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' },
  { id: 'ytd', label: 'YTD' },
]

export function PeriodFilter({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--chip-bg)', borderRadius: RADIUS.md, padding: 3, border: '1px solid var(--bdr)' }}>
      {PERIOD_OPTIONS.map(opt => (
        <button key={opt.id} onClick={() => onChange(opt.id)} style={{
          padding: '5px 14px', borderRadius: 7, border: 'none',
          fontSize: TEXT.sm, fontWeight: period === opt.id ? FW.bold : FW.medium,
          fontFamily: INTER, cursor: 'pointer',
          background: period === opt.id ? 'var(--card)' : 'transparent',
          color: period === opt.id ? 'var(--txt)' : 'var(--txt2)',
          boxShadow: period === opt.id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          transition: 'all 130ms',
        }}>{opt.label}</button>
      ))}
    </div>
  )
}

// A labelled figure with an optional qualifier underneath. The qualifier is where the
// caveat goes — "as at 14 Jul", "of gross" — so a number is never stranded without the
// basis it was computed on.
export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: tone ?? 'var(--txt)', fontFamily: INTER, lineHeight: 1, letterSpacing: -0.6 }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// Plain, unobtrusive helper line — used for empty-state placeholders. The old colored
// caveat boxes (amber/red explanation panels) read as a work-in-progress/test module, so
// this now renders as quiet muted text; the verbose explanatory notes were removed from
// the exec pages. `tone` is accepted but ignored so existing call sites keep compiling.
export function Note({ children }: { children: ReactNode; tone?: string }) {
  return (
    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5, padding: '4px 0', fontFamily: INTER }}>{children}</div>
  )
}

// Naira axis ticks. Kobo in, short label out. Handles negatives, which a net-flow or
// net-lending axis will cross.
export function ytick(v: number) {
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (a >= 1_000_000_000_00) return `${sign}₦${(a / 1_000_000_000_00).toFixed(1)}bn`
  if (a >= 1_000_000_00) return `${sign}₦${(a / 1_000_000_00).toFixed(0)}m`
  if (a >= 1_000_00) return `${sign}₦${(a / 1_000_00).toFixed(0)}k`
  return '₦0'
}

// Ranks a list of buckets into a share-of-total bar. Returns 0 rather than NaN on an
// empty list, so a fresh period does not render Infinity%.
export function share(value: number, total: number) {
  return total > 0 ? (value / total) * 100 : 0
}
