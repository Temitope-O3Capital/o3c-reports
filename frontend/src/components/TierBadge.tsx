import { TEXT, FW, RADIUS, NUM, RED, AMBER, GREEN, BLUE } from '../lib/design'

// The 5 payment bands, shared by the Payment Tiers page, the Credit Portfolio and the
// Agent Queue so the badge and colours mean the same thing everywhere. Bands are by
// principal repaid (loans) / minimum met (cards).
export type Tier = 'none' | 'minimal' | 'partial' | 'substantial' | 'cleared'

export const TIER_META: Record<Tier, { label: string; range: string; color: string }> = {
  none:        { label: 'None',        range: '0%',     color: RED },
  minimal:     { label: 'Minimal',     range: '1–24%',  color: '#E8590C' },
  partial:     { label: 'Partial',     range: '25–74%', color: AMBER },
  substantial: { label: 'Substantial', range: '75–99%', color: BLUE },
  cleared:     { label: 'Cleared',     range: '100%',   color: GREEN },
}
export const TIER_ORDER: Tier[] = ['none', 'minimal', 'partial', 'substantial', 'cleared']

// The single place the 5-band cutoffs live on the frontend (mirrors the backend CASE).
export function tierFromPct(pct: number): Tier {
  if (pct <= 0) return 'none'
  if (pct < 25) return 'minimal'
  if (pct < 75) return 'partial'
  if (pct < 100) return 'substantial'
  return 'cleared'
}

export function TierBadge({ tier }: { tier: Tier | string | null }) {
  const m = TIER_META[(tier ?? 'none') as Tier] ?? TIER_META.none
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 9px', borderRadius: RADIUS.full, background: `${m.color}18`, color: m.color, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  )
}

export function PctBar({ pct, tier }: { pct: number; tier: Tier | string | null }) {
  const color = (TIER_META[(tier ?? 'none') as Tier] ?? TIER_META.none).color
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      <div style={{ width: 54, height: 6, borderRadius: 3, background: 'var(--bg2)', overflow: 'hidden' }}>
        <div style={{ width: `${w}%`, height: '100%', background: color }} />
      </div>
      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, minWidth: 40, textAlign: 'right' }}>{pct}%</span>
    </div>
  )
}
