// Shared design system — React components
// Use alongside design.ts for charts and status pills.

import { INTER, SORA, NUM, PILL_STYLES } from './design'

// ── Chart tooltip ─────────────────────────────────────────────────────────────
interface TipProps {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  fmt?: (v: number) => string
}
export function Tip({ active, payload, label, fmt }: TipProps) {
  if (!active || !payload?.length) return null
  const f = fmt ?? (v => String(v))
  return (
    <div style={{ background: '#0E2841', borderRadius: 10, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && (
        <div style={{ fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: .5, textTransform: 'uppercase' }}>
          {label}
        </div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: INTER, ...NUM }}>{f(p.value)}</span>
          {p.name && payload.length > 1 && (
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.4)', fontFamily: SORA }}>{p.name}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Sparkline SVG ─────────────────────────────────────────────────────────────
export function Spark({ data, color }: { data: number[]; color: string }) {
  const W = 80, H = 24, pd = 2
  const max = Math.max(...data), min = Math.min(...data), rng = max - min || 1
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - pd - ((v - min) / rng) * (H - pd * 2)}`).join(' ')
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`sg${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={.2} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#sg${color.slice(1)})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Status pill ───────────────────────────────────────────────────────────────
export function Pill({ s, dark }: { s: string; dark: boolean }) {
  const p = PILL_STYLES[s] ?? PILL_STYLES.Lost
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
      letterSpacing: .2, whiteSpace: 'nowrap', fontFamily: INTER,
      background: dark ? p.dkBg : p.bg,
      color: dark ? p.dkTxt : p.txt,
    }}>
      {s}
    </span>
  )
}
