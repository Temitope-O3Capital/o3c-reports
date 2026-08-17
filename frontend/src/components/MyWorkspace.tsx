// MyWorkspace — the shared "My Dashboard" kit.
//
// Every role's personal station (Call Center, Sales, Collections, Recovery, …)
// is built from these pieces so they all look and behave identically. The pattern,
// proven on the Call Center dashboard, is: a personalized HERO (greeting + optional
// presence + live clock + daily-target ring + today's stats + quick actions), a
// "My Day" grid of action tiles, then role-specific charts and work queues.
//
// Tailoring rule (agreed): call-facing roles (call centre, collections, recovery,
// care) get the PresenceControl + a call/contact-target ring; non-call roles
// (sales, BD, cards, risk/finance/settlement/compliance/BI officers) get a
// work-target ring and no presence toggle. Everything else is shared.

import { useState, useEffect } from 'react'
import { fmtNum, fmtDate } from '../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, NUM, TEXT, FW, RADIUS, SP } from '../lib/design'

// ── Identity / time helpers ─────────────────────────────────────────────────────

export function myUserId(): number {
  try { return Number(JSON.parse(localStorage.getItem('o3c_user') || '{}').id) || 0 } catch { return 0 }
}
export function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}
export function firstName(): string {
  try {
    const u = JSON.parse(localStorage.getItem('o3c_user') || '{}')
    return String(u.name || u.full_name || '').split(' ')[0] || 'there'
  } catch { return 'there' }
}
export function relTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return fmtDate(iso)
}
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
}
export const ordinal = (n: number) => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`

// ── Live clock ──────────────────────────────────────────────────────────────────

export function LiveClock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setT(new Date()), 1000); return () => clearInterval(id) }, [])
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const date = t.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 24, fontWeight: FW.extrabold, color: '#fff', ...NUM, lineHeight: 1 }}>{time}</div>
      <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.6)', fontFamily: INTER, marginTop: 3 }}>{date}</div>
    </div>
  )
}

// ── Daily-target ring ───────────────────────────────────────────────────────────

export function Ring({ value, max, unit = 'done', size = 128, stroke = 12 }: {
  value: number; max: number; unit?: string; size?: number; stroke?: number
}) {
  const p = max > 0 ? Math.min(1, value / max) : 0
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const color = p >= 1 ? GREEN : p >= 0.6 ? '#4ADE80' : '#38BDF8'
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.16)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - p)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset .7s cubic-bezier(.4,0,.2,1)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 30, fontWeight: FW.extrabold, color: '#fff', ...NUM, lineHeight: 1 }}>{fmtNum(value)}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.55)', fontFamily: INTER }}>of {max} {unit}</div>
      </div>
    </div>
  )
}

// ── Hero stat chip ──────────────────────────────────────────────────────────────

export interface HeroStatSpec { label: string; value: string; delta?: React.ReactNode; color?: string }

export function HeroStat({ label, value, delta, color }: HeroStatSpec) {
  return (
    <div style={{ background: 'rgba(255,255,255,.08)', borderRadius: RADIUS.lg, padding: '11px 14px', minWidth: 0 }}>
      <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.55)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
        <span style={{ ...NUM, fontSize: 22, fontWeight: FW.extrabold, color: color ?? '#fff', lineHeight: 1 }}>{value}</span>
        {delta}
      </div>
    </div>
  )
}

// A ▲/▼ delta pill for hero stats (white-on-navy variant).
export function heroDelta(v: number): React.ReactNode {
  if (v === 0) return <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.5)' }}>—</span>
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: v > 0 ? '#4ADE80' : '#FCA5A5' }}>{v > 0 ? '▲' : '▼'} {Math.abs(v)}</span>
}

// ── Presence control (call-facing roles) ────────────────────────────────────────

export const PRESENCE_OPTS: { value: string; label: string; color: string }[] = [
  { value: 'available', label: 'Available', color: GREEN },
  { value: 'on_call',   label: 'On Call',   color: BLUE },
  { value: 'break',     label: 'Break',     color: AMBER },
  { value: 'offline',   label: 'Offline',   color: '#94A3B8' },
]

export function PresenceControl({ status, onChange }: { status: string; onChange: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const cur = PRESENCE_OPTS.find(o => o.value === status) ?? PRESENCE_OPTS[0]
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} title="Set your status" style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(255,255,255,.14)', color: '#fff',
        border: 'none', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '4px 11px', borderRadius: RADIUS['2xl'], cursor: 'pointer',
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: cur.color, animation: status === 'available' ? 'ccpulse 1.8s infinite' : 'none' }} />
        {cur.label}
        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>expand_more</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '112%', left: 0, zIndex: 41, background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.md, boxShadow: '0 12px 32px rgba(0,0,0,.22)', padding: 4, minWidth: 158 }}>
            {PRESENCE_OPTS.map(o => (
              <button key={o.value} onClick={() => { onChange(o.value); setOpen(false) }} style={{
                display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none',
                background: o.value === status ? 'var(--row-hvr)' : 'transparent', color: 'var(--txt)', fontSize: TEXT.sm,
                cursor: 'pointer', borderRadius: RADIUS.sm, textAlign: 'left', fontWeight: o.value === status ? FW.semibold : FW.normal,
              }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: o.color }} />{o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Hero quick-action button ────────────────────────────────────────────────────

export function HeroButton({ icon, label, onClick, primary = false }: {
  icon: string; label: string; onClick: () => void; primary?: boolean
}) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md,
      background: primary ? '#fff' : 'rgba(255,255,255,.12)', color: primary ? NAVY : '#fff',
      border: 'none', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{icon}</span>{label}
    </button>
  )
}

// ── Hero shell ──────────────────────────────────────────────────────────────────
// Composes the navy gradient banner. Pass a ring + stats + optional presence node,
// optional aside panel (e.g. HourlyActivity or a weekly sparkline), and an actions row.

export function WorkspaceHero({ presence, subline, ring, stats, aside, actions, gradient }: {
  presence?: React.ReactNode
  subline?: React.ReactNode
  ring?: { value: number; max: number; unit?: string }
  stats: HeroStatSpec[]
  aside?: React.ReactNode
  actions?: React.ReactNode
  gradient?: string
}) {
  return (
    <div style={{
      background: gradient ?? 'linear-gradient(120deg, #0E2841 0%, #17395c 55%, #1e4a74 100%)',
      borderRadius: RADIUS.xl, padding: '22px 26px', marginBottom: SP[4], color: '#fff',
      boxShadow: '0 10px 30px rgba(14,40,65,.28)',
    }}>
      <style>{`@keyframes ccpulse { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,.55) } 70% { box-shadow: 0 0 0 7px rgba(74,222,128,0) } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0) } }`}</style>

      {/* greeting + presence + clock */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22, fontWeight: FW.extrabold }}>{greeting()}, {firstName()}</span>
            {presence}
          </div>
          {subline && <div style={{ fontSize: TEXT.sm, color: 'rgba(255,255,255,.6)', marginTop: 5 }}>{subline}</div>}
        </div>
        <LiveClock />
      </div>

      {/* ring + stats + aside — stats sit in an even grid so the tiles line up in
          clean columns/rows instead of ragged flex-wrap. */}
      <div style={{ display: 'grid', gridTemplateColumns: aside ? 'minmax(0, 1fr) minmax(240px, 340px)' : '1fr', gap: 26, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, minWidth: 0 }}>
          {ring && <Ring value={ring.value} max={ring.max} unit={ring.unit} />}
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
            {stats.map((s, i) => <HeroStat key={i} {...s} />)}
          </div>
        </div>
        {aside}
      </div>

      {/* quick actions */}
      {actions && <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  )
}

// ── Hourly activity sparkbars (optional hero aside) ─────────────────────────────

export function HourlyActivity({ data, label = "Today's activity · by hour", from = 6, to = 20 }: {
  data: { hour: number; total: number }[]; label?: string; from?: number; to?: number
}) {
  const hourData = Array.from({ length: 24 }, (_, h) => {
    const f = data.find(x => x.hour === h)
    return { label: String(h).padStart(2, '0'), total: f?.total ?? 0 }
  }).filter((_, h) => h >= from && h <= to)
  const peak = Math.max(1, ...hourData.map(x => x.total))
  return (
    <div style={{ background: 'rgba(255,255,255,.06)', borderRadius: RADIUS.lg, padding: '12px 16px', alignSelf: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.55)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 56 }}>
        {hourData.map((h, i) => (
          <div key={i} title={`${h.label}:00 — ${h.total}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div style={{ width: '100%', height: `${Math.max(3, (h.total / peak) * 46)}px`, background: h.total >= peak * 0.8 ? '#38BDF8' : 'rgba(255,255,255,.35)', borderRadius: 3, transition: 'height .5s ease' }} />
            <span style={{ fontSize: 8, color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{h.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── "My Day" tile + grid ────────────────────────────────────────────────────────

export function MyDayTile({ icon, count, label, sub, color, urgent, onClick }: {
  icon: string; count: React.ReactNode; label: string; sub: string; color: string; urgent?: boolean; onClick?: () => void
}) {
  const clickable = !!onClick
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 13, padding: '15px 16px',
      background: 'var(--card)', border: `1px solid ${urgent ? color + '55' : 'var(--card-bdr)'}`,
      borderRadius: RADIUS.lg, cursor: clickable ? 'pointer' : 'default',
      boxShadow: urgent ? `inset 3px 0 0 ${color}` : 'none', transition: 'transform .12s ease, box-shadow .12s ease',
    }}
      onMouseEnter={e => { if (clickable) { const el = e.currentTarget as HTMLElement; el.style.transform = 'translateY(-2px)'; el.style.boxShadow = `${urgent ? `inset 3px 0 0 ${color}, ` : ''}0 8px 22px rgba(14,40,65,.12)` } }}
      onMouseLeave={e => { if (clickable) { const el = e.currentTarget as HTMLElement; el.style.transform = 'none'; el.style.boxShadow = urgent ? `inset 3px 0 0 ${color}` : 'none' } }}>
      <span className="material-symbols-rounded" style={{ fontSize: 23, color, background: `${color}16`, borderRadius: RADIUS.md, padding: 9, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...NUM, fontSize: 25, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1 }}>{count}</div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 1 }}>{sub}</div>
      </div>
      {clickable && <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)', flexShrink: 0 }}>chevron_right</span>}
    </div>
  )
}

export function MyDaySection({ title = 'My Day', hint = 'what needs your attention now', children }: {
  title?: string; hint?: string; children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: SP[4] }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 11 }}>
        <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{title}</span>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{hint}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(212px, 1fr))', gap: SP[3] }}>
        {children}
      </div>
    </div>
  )
}

// ── Status pill + chart tooltip ─────────────────────────────────────────────────

export function StatusPill({ label, color }: { label: string; color: string }) {
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'], background: `${color}18`, color, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{label}</span>
}

export function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0E2841', border: '1px solid rgba(255,255,255,.08)', borderRadius: RADIUS.lg, padding: '9px 13px', boxShadow: '0 8px 28px rgba(0,0,0,.4)' }}>
      <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.5)', fontFamily: INTER, marginBottom: 5, textTransform: 'uppercase' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: i > 0 ? 3 : 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color }} />
          <span style={{ fontSize: TEXT.sm, color: '#fff', fontWeight: FW.bold, ...NUM }}>{p.value}</span>
          <span style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.5)' }}>{p.name}</span>
        </div>
      ))}
    </div>
  )
}

// A small "live" badge for card headers that auto-refresh.
export function LiveBadge() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: GREEN, textTransform: 'uppercase', letterSpacing: '.05em' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN, animation: 'ccpulse 1.8s infinite' }} />live
    </span>
  )
}

// Shared accents re-exported so pages don't re-import design tokens just for these.
export { RED, AMBER, BLUE, GREEN, NAVY, PURPLE }
