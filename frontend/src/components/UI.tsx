import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { ReactNode, CSSProperties, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { NAVY, RED, GREEN, INTER, SORA, NUM, TEXT, FW, SP, RADIUS, SHADOW, TRANSITION } from '../lib/design'
import { today, monthStart, yearStart, fmtDate } from '../lib/fmt'

// ── Skeleton ──────────────────────────────────────────────────────────────────

export function Sk({ w = '100%', h = 16, radius = 4 }: { w?: string | number; h?: number | string; radius?: number }) {
  return (
    <span className="sk" style={{ width: typeof w === 'number' ? `${w}px` : w, height: h, borderRadius: radius }} />
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

export function Spinner({ size = 20, color = RED }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <circle cx="12" cy="12" r="10" stroke={color} strokeOpacity=".2" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// ── Error banner ──────────────────────────────────────────────────────────────

export function ErrBanner({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px', borderRadius: 8, marginBottom: 16,
      background: 'rgba(192,0,0,0.08)', border: '1px solid rgba(192,0,0,0.18)',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: RED, flexShrink: 0 }}>error</span>
      <span style={{ fontSize: 13, color: RED, flex: 1 }}>{error}</span>
      {onRetry && (
        <button onClick={onRetry} style={{
          fontSize: 12, fontWeight: 600, color: RED,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '2px 6px', borderRadius: 4, textDecoration: 'underline',
        }}>Retry</button>
      )}
    </div>
  )
}

// ── Page shell ────────────────────────────────────────────────────────────────

interface PageProps {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  noPad?: boolean
  back?: { label: string; to: string }
}

export function Page({ title, subtitle, actions, children, noPad, back }: PageProps) {
  const hasHeader = !!title || !!actions
  return (
    <div className="page-fade" style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)',
    }}>
      {back && (
        <div style={{ padding: '14px 24px 0', flexShrink: 0 }}>
          <a href={back.to} onClick={e => { e.preventDefault(); window.history.back() }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--txt2)', textDecoration: 'none', fontWeight: 500 }}
            onMouseEnter={e => (e.currentTarget.style.color = NAVY)}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--txt2)')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>
            {back.label}
          </a>
        </div>
      )}
      {hasHeader && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
          padding: back ? '8px 24px 0' : '20px 24px 0', flexShrink: 0,
        }}>
          {title && (
            <div>
              <h1 style={{
                margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--txt)',
                letterSpacing: '-0.5px', lineHeight: 1.2,
              }}>{title}</h1>
              {subtitle && (
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--txt2)', lineHeight: 1.4 }}>
                  {subtitle}
                </p>
              )}
            </div>
          )}
          {actions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: title ? undefined : 'auto' }}>
              {actions}
            </div>
          )}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: noPad ? 0 : '16px 24px 24px' }}>
        {children}
      </div>
    </div>
  )
}

// ── KPI card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string
  value: string | number
  sub?: string
  change?: number
  changePeriod?: string
  icon?: string
  accent?: string
  loading?: boolean
}

export function KpiCard({ label, value, sub, change, changePeriod, icon, accent = NAVY, loading }: KpiCardProps) {
  const positive = (change ?? 0) >= 0
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)',
      boxShadow: 'var(--card-shadow)', borderRadius: 12, padding: '16px 18px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', letterSpacing: '0.3px', textTransform: 'uppercase' }}>
          {label}
        </span>
        {icon && (
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: `${accent}18`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16, color: accent }}>{icon}</span>
          </div>
        )}
      </div>

      {loading ? <Sk h={28} w="60%" /> : (
        <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: 'var(--txt)', letterSpacing: '-0.6px', lineHeight: 1.2 }}>
          {value}
        </div>
      )}

      {(sub || change !== undefined) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {change !== undefined && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 2,
              fontSize: 11.5, fontWeight: 600, fontFamily: INTER,
              color: positive ? GREEN : RED,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>
                {positive ? 'arrow_upward' : 'arrow_downward'}
              </span>
              {Math.abs(change).toFixed(1)}%
            </span>
          )}
          {(sub || changePeriod) && (
            <span style={{ fontSize: 11.5, color: 'var(--txt2)' }}>{sub ?? changePeriod}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Section card ──────────────────────────────────────────────────────────────

interface SectionCardProps {
  title?: string
  subtitle?: string
  badge?: number | string
  actions?: ReactNode
  children: ReactNode
  padding?: boolean
  style?: CSSProperties
}

export function SectionCard({ title, subtitle, badge, actions, children, padding = true, style }: SectionCardProps) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)',
      boxShadow: 'var(--card-shadow)', borderRadius: 12, overflow: 'hidden', ...style,
    }}>
      {(title || actions) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '14px 18px', borderBottom: '1px solid var(--bdr)',
        }}>
          <div>
            {title && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)', letterSpacing: '-0.2px' }}>
                  {title}
                </span>
                {badge !== undefined && (
                  <span style={{ ...NUM, fontSize: 11, fontWeight: 600, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '1px 7px', borderRadius: 20 }}>
                    {badge}
                  </span>
                )}
              </div>
            )}
            {subtitle && <span style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 1, display: 'block' }}>{subtitle}</span>}
          </div>
          {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{actions}</div>}
        </div>
      )}
      <div style={padding ? { padding: '16px 18px' } : undefined}>{children}</div>
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, { bg: string; txt: string }> = {
  // green — positive / terminal success
  active:           { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  approved:         { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  completed:        { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  resolved:         { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  won:              { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  kept:             { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  disbursed:        { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  issued:           { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  paid:             { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  matched:          { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  verified:         { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  hired:            { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  cleared:          { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  settled:          { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  recovered:        { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  // amber — in-flight / attention
  pending:          { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  reviewing:        { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  investigating:    { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  qualified:        { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  proposal:         { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  negotiation:      { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  due_soon:         { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  expiring:         { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  partial:          { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  on_hold:          { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  deferred:         { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  probation:        { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  // blue — neutral in-progress / informational
  submitted:        { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  open:             { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  in_progress:      { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  processing:       { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  under_review:     { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  prospect:         { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  scheduled:        { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  running:          { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  sending:          { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  // grey — neutral / terminal closed
  draft:            { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  inactive:         { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  closed:           { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  archived:         { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  cancelled:        { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  withdrawn:        { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  dismissed:        { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  lost:             { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  written_off:      { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  none:             { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  // red — failed / urgent / negative
  declined:         { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  failed:           { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  overdue:          { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  broken:           { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  rejected:         { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  blocked:          { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  expired:          { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  defaulted:        { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  written_off_bad:  { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
  // purple — workflow / escalated
  escalated:        { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  legal:            { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  litigation:       { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  under_litigation: { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  // card / settlement workflow statuses
  recommended:      { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  pending_review:   { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  provisional_credit: { bg: 'rgba(217,119,6,.12)', txt: '#D97706' },
  filed:            { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  dispatched:       { bg: 'rgba(14,40,65,.1)',    txt: '#0E2841' },
  posted:           { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  pending_approval: { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  returned:         { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  posting:          { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
}

export function StatusBadge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const key = (status ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  const s = STATUS_MAP[key] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: 600,
      padding: size === 'sm' ? '1px 6px' : '2px 8px',
      borderRadius: 20, background: s.bg, color: s.txt,
      letterSpacing: '0.1px', whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

// ── Avatar ────────────────────────────────────────────────────────────────────

const AVATAR_PALETTE = [
  '#C00000', '#2563EB', '#16A34A', '#D97706',
  '#7C3AED', '#0891B2', '#DB2777', '#EA580C',
]

export function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

export function nameInitials(name: string): string {
  return (name ?? '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const color = avatarColor(name)
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: color, color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size <= 28 ? 10 : 12, fontWeight: 700, fontFamily: INTER,
      flexShrink: 0, userSelect: 'none', letterSpacing: '0.3px',
    }}>
      {nameInitials(name)}
    </div>
  )
}

// ── NameCell ──────────────────────────────────────────────────────────────────

export function NameCell({
  name, sub, avatar = true,
}: { name: string; sub?: string | null; avatar?: boolean }) {
  const n = name || '—'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {avatar && <Avatar name={n} />}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--txt)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {n}
        </div>
        {sub && (
          <div style={{
            fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pill ──────────────────────────────────────────────────────────────────────
// Flexible colored pill for stage / type / category fields where StatusBadge's
// auto-mapping doesn't apply (e.g. pipeline stages with brand-specific colors).

export function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.semibold,
      padding: '2px 10px', borderRadius: 20,
      background: bg, color,
      whiteSpace: 'nowrap', textTransform: 'capitalize',
      letterSpacing: '0.1px',
    }}>
      {String(label).replace(/_/g, ' ')}
    </span>
  )
}

// ── ActionRow ─────────────────────────────────────────────────────────────────
// Renders a row of small icon-buttons at the end of a table row.
// Each action must call e.stopPropagation() is handled internally.

export interface RowAction {
  icon: string
  label: string
  onClick: () => void
  danger?: boolean
}

export function ActionRow({ actions }: { actions: RowAction[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}
      onClick={e => e.stopPropagation()}>
      {actions.map(a => (
        <button
          key={a.label}
          title={a.label}
          onClick={e => { e.stopPropagation(); a.onClick() }}
          style={{
            width: 28, height: 28, borderRadius: RADIUS.sm,
            border: 'none', background: 'transparent',
            color: a.danger ? RED : 'var(--txt2)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 120ms',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background =
              a.danger ? 'rgba(192,0,0,.1)' : 'var(--row-hvr)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{a.icon}</span>
        </button>
      ))}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

interface TabItem { key: string; label: string; badge?: number }

export function Tabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (key: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--bdr)', marginBottom: 16 }}>
      {tabs.map(t => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px',
              fontSize: 13, fontWeight: isActive ? 600 : 500,
              color: isActive ? 'var(--txt)' : 'var(--txt2)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: isActive ? `2px solid ${RED}` : '2px solid transparent',
              marginBottom: -1, transition: 'color 120ms, border-color 120ms', whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--txt)' }}
            onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--txt2)' }}
          >
            {t.label}
            {t.badge !== undefined && (
              <span style={{
                ...NUM, fontSize: 10.5, fontWeight: 600, padding: '0 5px', borderRadius: 20,
                background: isActive ? `${RED}18` : 'var(--chip-bg)',
                color: isActive ? RED : 'var(--chip-txt)',
              }}>{t.badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

export function FilterBar({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      marginBottom: 14, padding: '10px 14px',
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: 10,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)', flexShrink: 0 }}>filter_list</span>
      {children}
      {onReset && (
        <button onClick={onReset} style={{
          marginLeft: 'auto', fontSize: 12, fontWeight: 500,
          color: 'var(--txt2)', background: 'none', border: 'none',
          cursor: 'pointer', padding: '4px 8px', borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 13 }}>close</span>Reset
        </button>
      )}
    </div>
  )
}

// filterInputStyle — uses card bg + bdr tokens to match the C360 search bar look
export const filterInputStyle: CSSProperties = {
  height: 36, padding: '0 10px', border: '1px solid var(--bdr)',
  borderRadius: 8, fontSize: 12.5, background: 'var(--card)',
  color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', minWidth: 130,
}

// ── Search icon SVG (shared by SearchInput and TblSearch) ─────────────────────

function SrchIco() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      style={{ color: 'var(--txt3)', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>
    </svg>
  )
}

// ── Search input ──────────────────────────────────────────────────────────────
// Matches the C360 bar look: var(--card) bg, var(--bdr) border → #0EA5E9 on focus

export function SearchInput({
  value, onChange, onClear, onSearch, placeholder = 'Search…', minWidth = 220, style,
}: {
  value: string
  onChange: (v: string) => void
  onClear?: () => void
  onSearch?: () => void
  placeholder?: string
  minWidth?: number | string
  style?: CSSProperties
}) {
  const [focused, setFocused] = useState(false)
  const handleClear = onClear ?? (() => onChange(''))
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      height: 36, padding: '0 10px',
      background: 'var(--card)',
      border: `1px solid ${focused ? '#0EA5E9' : 'var(--bdr)'}`,
      borderRadius: 8, minWidth,
      transition: 'border-color .12s',
      ...style,
    }}>
      <SrchIco />
      <input
        className="srch-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onSearch ? e => { if (e.key === 'Enter') onSearch() } : undefined}
        placeholder={placeholder}
        style={{
          border: 'none', background: 'transparent', outline: 'none', boxShadow: 'none',
          flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--txt)',
          fontFamily: "'Sora', ui-sans-serif, sans-serif",
        }}
      />
      {value && (
        <button onClick={handleClear} style={{
          border: 'none', background: 'none', cursor: 'pointer', padding: 0,
          display: 'flex', color: 'var(--txt3)', flexShrink: 0,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
        </button>
      )}
    </div>
  )
}

// ── Expandable filter bar (BD Pipeline pattern) ───────────────────────────────
// Usage: drop inside a SectionCard padding={false} — renders toolbar + panel + chips.
// Pass onApply for server-side tables (triggers re-fetch); omit for client-side tables.

export interface FilterOption {
  value: string
  label?: string       // display text — falls back to value
  count?: number       // shown on right
  color?: string       // renders a colored pill instead of plain text
  avatarName?: string  // renders avatar circle (uses avatarColor + nameInitials)
}

export interface FilterGroupDef {
  key: string
  label: string
  options: FilterOption[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
}

export function ExpandableFilterBar({
  search, onSearch,
  groups, onReset, onApply,
  resultCount, totalCount,
  placeholder = 'Search…',
  maxCols = 3,
}: {
  search: string
  onSearch: (v: string) => void
  groups: FilterGroupDef[]
  onReset: () => void
  onApply?: () => void  // undefined = instant client-side; defined = server-side (shows Apply button)
  resultCount: number
  totalCount: number
  placeholder?: string
  maxCols?: number      // how many filter groups sit side-by-side in the panel (default 3)
}) {
  const [open, setOpen] = useState(false)
  // Per-group search text — lets long option lists (e.g. 30+ states) stay compact.
  const [optQuery, setOptQuery] = useState<Record<string, string>>({})
  const activeCount = groups.reduce((s, g) => s + g.selected.size, 0)
  const cols = Math.max(1, Math.min(groups.length, maxCols))
  const LONG_LIST = 8  // groups with more options than this get a search box + scroll

  return (
    <>
      {/* ── toolbar row ────────────────────────────────────────────────────── */}
      <div style={{
        padding: '10px 18px',
        borderBottom: (open || activeCount > 0) ? 'none' : '1px solid var(--bdr)',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <SearchInput value={search} onChange={onSearch} onClear={() => onSearch('')} placeholder={placeholder} />

        {groups.length > 0 && (
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 13px', borderRadius: RADIUS.md,
              fontSize: TEXT.sm, fontWeight: FW.semibold,
              border: `1.5px solid ${activeCount > 0 ? RED : 'var(--input-bdr)'}`,
              background: 'transparent', color: activeCount > 0 ? RED : 'var(--txt2)',
              cursor: 'pointer', fontFamily: "'Sora', sans-serif",
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
            Filters
            {activeCount > 0 && (
              <span style={{
                minWidth: 17, height: 17, borderRadius: '999px',
                background: RED, color: '#fff',
                fontSize: 10, fontWeight: 700, fontFamily: "'Inter', sans-serif",
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>{activeCount}</span>
            )}
          </button>
        )}

        <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: "'Inter', sans-serif" }}>
          {resultCount === totalCount ? `${totalCount} results` : `${resultCount} of ${totalCount}`}
        </span>
      </div>

      {/* ── expandable panel ───────────────────────────────────────────────── */}
      {open && (
        <div style={{ borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, padding: '20px 20px 0' }}>
            {groups.map((group, gi) => (
              <div key={group.key} style={{
                paddingRight: gi < groups.length - 1 ? 20 : 0,
                paddingLeft: gi > 0 ? 20 : 0,
                borderRight: gi < groups.length - 1 ? '1px solid var(--bdr)' : 'none',
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
                  letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12,
                  fontFamily: "'Inter', sans-serif",
                }}>{group.label}</div>

                {(() => {
                  const isLong = group.options.length > LONG_LIST
                  const gq = (optQuery[group.key] ?? '').toLowerCase().trim()
                  const visible = gq
                    ? group.options.filter(o => (o.label ?? o.value).toLowerCase().includes(gq))
                    : group.options
                  return (
                    <>
                      {isLong && (
                        <input
                          value={optQuery[group.key] ?? ''}
                          onChange={e => setOptQuery(q => ({ ...q, [group.key]: e.target.value }))}
                          placeholder={`Search ${group.label.toLowerCase()}…`}
                          spellCheck={false}
                          style={{
                            width: '100%', boxSizing: 'border-box', marginBottom: 10,
                            padding: '5px 9px', fontSize: TEXT.xs, fontFamily: "'Inter', sans-serif",
                            border: '1px solid var(--input-bdr)', borderRadius: RADIUS.sm,
                            background: 'var(--input-bg)', color: 'var(--txt)',
                          }}
                        />
                      )}
                      <div style={isLong ? { maxHeight: 208, overflowY: 'auto', paddingRight: 6, marginRight: -6 } : undefined}>
                        {group.options.length === 0 ? (
                          <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>None available</span>
                        ) : visible.length === 0 ? (
                          <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No matches</span>
                        ) : visible.map(opt => {
                          const label = opt.label ?? opt.value
                          const checked = group.selected.has(opt.value)
                          return (
                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(group.selected)
                          next.has(opt.value) ? next.delete(opt.value) : next.add(opt.value)
                          group.onChange(next)
                        }}
                        style={{ accentColor: opt.color ?? RED, width: 14, height: 14, cursor: 'pointer', flexShrink: 0 }}
                      />
                      {opt.avatarName ? (
                        <>
                          <div style={{
                            width: 22, height: 22, borderRadius: '999px',
                            background: avatarColor(opt.avatarName), flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 10, fontWeight: 700, color: '#fff', fontFamily: "'Inter', sans-serif",
                          }}>{nameInitials(opt.avatarName)}</div>
                          <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: "'Sora', sans-serif", flex: 1 }}>{label}</span>
                        </>
                      ) : opt.color ? (
                        <span style={{
                          fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: '999px',
                          background: `${opt.color}18`, color: opt.color,
                          textTransform: 'capitalize' as const, whiteSpace: 'nowrap' as const, flex: 1,
                        }}>{label}</span>
                      ) : (
                        <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: "'Sora', sans-serif", flex: 1 }}>{label}</span>
                      )}
                      {opt.count !== undefined && (
                        <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: "'Inter', sans-serif", flexShrink: 0 }}>
                          {opt.count}
                        </span>
                      )}
                    </label>
                          )
                        })}
                      </div>
                    </>
                  )
                })()}
              </div>
            ))}
          </div>

          {/* panel footer */}
          <div style={{
            padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: "'Sora', sans-serif" }}>
              {activeCount === 0
                ? `No filters applied, showing all ${totalCount}`
                : `${activeCount} filter${activeCount !== 1 ? 's' : ''} active`}
            </span>
            <button
              onClick={onReset}
              style={{
                padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                color: 'var(--txt2)', cursor: 'pointer', fontFamily: "'Sora', sans-serif",
              }}
            >Reset</button>
            <button
              onClick={() => { setOpen(false); onApply?.() }}
              style={{
                marginLeft: 'auto', padding: '5px 16px', borderRadius: RADIUS.md,
                fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: 'none', background: RED, color: '#fff',
                cursor: 'pointer', fontFamily: "'Sora', sans-serif",
              }}
            >{onApply ? `Apply · ${resultCount} results` : `Done · ${resultCount}`}</button>
          </div>
        </div>
      )}

      {/* ── active filter chips (panel closed) ─────────────────────────────── */}
      {!open && activeCount > 0 && (
        <div style={{
          padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
          {groups.flatMap(group =>
            [...group.selected].map(value => {
              const opt = group.options.find(o => o.value === value)
              const label = opt?.label ?? value
              const color = opt?.color
              return (
                <span key={`${group.key}:${value}`} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: '999px',
                  fontSize: TEXT.xs, fontWeight: FW.semibold,
                  background: color ? `${color}18` : 'var(--chip-bg)',
                  color: color ?? 'var(--chip-txt)',
                }}>
                  {label}
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 13, cursor: 'pointer' }}
                    onClick={() => {
                      const next = new Set(group.selected)
                      next.delete(value)
                      group.onChange(next)
                      onApply?.()
                    }}
                  >close</span>
                </span>
              )
            })
          )}
          <button
            onClick={() => { onReset(); onApply?.() }}
            style={{
              marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer',
              fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', padding: 0,
              fontFamily: "'Sora', sans-serif",
            }}
          >Clear all</button>
        </div>
      )}
    </>
  )
}

// ── Table toolbar search (fixed-width variant; same visual as SearchInput) ────

export function TblSearch({
  value, onChange, placeholder = 'Search…', width = 160, style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  width?: number
  style?: CSSProperties
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
      border: `1px solid ${focused ? '#0EA5E9' : 'var(--bdr)'}`,
      borderRadius: 8, padding: '5px 10px',
      background: 'var(--card)',
      transition: 'border-color .12s',
      ...style,
    }}>
      <SrchIco />
      <input
        className="srch-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={{
          border: 'none', outline: 'none', background: 'none',
          fontFamily: "'Sora', ui-sans-serif, sans-serif",
          fontSize: 12.5, color: 'var(--txt)',
          ...(width ? { width } : { flex: 1, minWidth: 0 }),
        }}
      />
    </div>
  )
}

// ── DataTable ─────────────────────────────────────────────────────────────────

export interface TableCol<T = any> {
  key: string
  label: string
  sortable?: boolean
  width?: string | number
  align?: 'left' | 'right' | 'center'
  render?: (row: T, idx: number) => ReactNode
}

export interface FilterDef<T = any> {
  key: string           // data field to filter on
  label: string         // panel column header
  accentColor?: string  // checkbox accent (defaults to NAVY)
  getLabel?: (val: string) => string                        // transform raw value for display
  chipStyle?: (val: string) => { bg: string; txt: string } // per-value chip colours (e.g. status pills)
}

interface DataTableProps<T> {
  cols: TableCol<T>[]
  rows: T[]
  keyFn?: (row: T, idx: number) => string | number
  onRowClick?: (row: T) => void
  selectable?: boolean
  selectedIds?: Set<string | number>
  onSelect?: (ids: Set<string | number>) => void
  bulkBar?: ReactNode
  emptyText?: string
  loading?: boolean
  skeletonRows?: number
  rowStyle?: (row: T, idx: number) => CSSProperties | undefined
  searchKeys?: string[]
  searchPlaceholder?: string
  pageSize?: number
  filters?: FilterDef<T>[]
}

function _PgBtn({ children, active, disabled, onClick, icon }: {
  children?: ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: 6,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? RED : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon
        ? <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span>
        : children}
    </button>
  )
}

// Shared numbered pagination (chevrons + windowed page numbers) — the house
// standard used by DataTable, exposed for server-paginated lists/tables too.
export function Pagination({ page, pages, total, pageSize, onPage, showRange = true, maxButtons = 7 }: {
  page: number; pages: number; total?: number; pageSize?: number
  onPage: (p: number) => void; showRange?: boolean; maxButtons?: number
}) {
  if (pages <= 1) return null
  const safe = Math.min(Math.max(1, page), pages)
  const win = Math.min(pages, Math.max(3, maxButtons))
  const label = (total != null && pageSize)
    ? `Showing ${(safe - 1) * pageSize + 1}–${Math.min(safe * pageSize, total)} of ${total.toLocaleString()}`
    : `Page ${safe} of ${pages}`
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
      {showRange
        ? <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{label}</span>
        : <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: INTER }}>{safe} / {pages}</span>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <_PgBtn icon="chevron_left" disabled={safe === 1} onClick={() => onPage(safe - 1)} />
        {Array.from({ length: win }, (_, i) => {
          let pg: number
          if (pages <= win) pg = i + 1
          else if (safe <= Math.ceil(win / 2)) pg = i + 1
          else if (safe >= pages - Math.floor(win / 2)) pg = pages - win + 1 + i
          else pg = safe - Math.floor(win / 2) + i
          return <_PgBtn key={pg} active={pg === safe} onClick={() => onPage(pg)}>{pg}</_PgBtn>
        })}
        <_PgBtn icon="chevron_right" disabled={safe === pages} onClick={() => onPage(safe + 1)} />
      </div>
    </div>
  )
}

function _toggleFSet(prev: Record<string, Set<string>>, key: string, val: string): Record<string, Set<string>> {
  const cur = prev[key] ?? new Set<string>()
  const next = new Set(cur)
  next.has(val) ? next.delete(val) : next.add(val)
  return { ...prev, [key]: next }
}

export function DataTable<T extends Record<string, any>>({
  cols, rows, keyFn, onRowClick,
  selectable, selectedIds: extSel, onSelect,
  bulkBar, emptyText = 'No records found', loading, skeletonRows = 8, rowStyle,
  searchKeys, searchPlaceholder = 'Search…', pageSize, filters,
}: DataTableProps<T>) {
  const [sortKey,       setSortKey]       = useState<string | null>(null)
  const [sortDir,       setSortDir]       = useState<'asc' | 'desc'>('asc')
  const [internalSel,   setInternalSel]   = useState<Set<string | number>>(new Set())
  const [search,        setSearch]        = useState('')
  const [page,          setPage]          = useState(1)
  const [filterOpen,    setFilterOpen]    = useState(false)
  const [activeFilters, setActiveFilters] = useState<Record<string, Set<string>>>({})

  useEffect(() => { setPage(1) }, [rows, search, activeFilters])

  const selectedIds   = extSel ?? internalSel
  const setSelectedIds = onSelect ?? setInternalSel

  const toggleSort = useCallback((key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }, [sortKey])

  // Derive unique options for each filter from the base rows (unfiltered)
  const filterOptions = useMemo(() => {
    if (!filters?.length) return {} as Record<string, string[]>
    const opts: Record<string, string[]> = {}
    for (const f of filters) {
      opts[f.key] = [...new Set(rows.map(r => String(r[f.key] ?? '')).filter(Boolean))].sort()
    }
    return opts
  }, [rows, filters])

  const activeFilterCount = Object.values(activeFilters).reduce((n, s) => n + s.size, 0)

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    return [...rows].sort((a, b) => {
      const va = a[sortKey] ?? '', vb = b[sortKey] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortKey, sortDir])

  const filtered = useMemo(() => {
    let result = sorted
    if (filters?.length) {
      for (const f of filters) {
        const sel = activeFilters[f.key]
        if (sel?.size) result = result.filter(r => sel.has(String(r[f.key] ?? '')))
      }
    }
    if (searchKeys?.length && search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(row => searchKeys.some(k => String(row[k] ?? '').toLowerCase().includes(q)))
    }
    return result
  }, [sorted, search, searchKeys, activeFilters, filters])

  const totalPages  = pageSize ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1
  const safePage    = pageSize ? Math.min(Math.max(1, page), totalPages) : 1
  const displayRows = pageSize ? filtered.slice((safePage - 1) * pageSize, safePage * pageSize) : filtered

  const getKey = (row: T, i: number) => keyFn ? keyFn(row, i) : (row.id ?? i)

  function toggleAll() {
    setSelectedIds(selectedIds.size === rows.length ? new Set() : new Set(rows.map((r, i) => getKey(r, i))))
  }
  function toggleRow(id: string | number) {
    const next = new Set(selectedIds); next.has(id) ? next.delete(id) : next.add(id); setSelectedIds(next)
  }
  function resetFilters() { setSearch(''); setActiveFilters({}) }

  const showBar = !!(searchKeys?.length || filters?.length)

  const thBase: CSSProperties = {
    padding: '11px 14px', fontSize: 10, fontWeight: 700,
    color: 'var(--txt2)', textTransform: 'uppercase', fontFamily: INTER,
    letterSpacing: '0.6px', whiteSpace: 'nowrap', userSelect: 'none',
    borderBottom: '1px solid var(--bdr)',
  }
  const tdBase: CSSProperties = {
    padding: '12px 14px', fontSize: 13, color: 'var(--txt)',
    borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
  }

  return (
    <div style={{ overflow: 'hidden' }}>

      {/* Filter bar */}
      {showBar && (
        <div style={{
          padding: '12px 18px',
          borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          {!!searchKeys?.length && (
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={searchPlaceholder}
            />
          )}

          {!!filters?.length && (
            <button
              onClick={() => setFilterOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                border: `1.5px solid ${activeFilterCount > 0 ? RED : 'var(--input-bdr)'}`,
                background: 'transparent',
                color: activeFilterCount > 0 ? RED : 'var(--txt2)',
                cursor: 'pointer', fontFamily: SORA, position: 'relative',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
              Filters
              {activeFilterCount > 0 && (
                <span style={{
                  position: 'absolute', top: -6, right: -6,
                  width: 16, height: 16, borderRadius: '50%',
                  background: RED, color: '#fff',
                  fontSize: 9, fontWeight: 700, fontFamily: INTER,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{activeFilterCount}</span>
              )}
            </button>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length} of {rows.length}
            </span>
          </div>
        </div>
      )}

      {/* Expandable filter panel */}
      {filterOpen && !!filters?.length && (
        <div style={{ borderBottom: '1px solid var(--bdr)' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(filters.length, 4)}, 1fr)`,
            padding: '20px 20px 0',
          }}>
            {filters.map((f, fi) => {
              const opts = filterOptions[f.key] ?? []
              const sel  = activeFilters[f.key] ?? new Set<string>()
              const isLast = fi === filters.length - 1
              return (
                <div key={f.key} style={{
                  ...(fi > 0 ? { paddingLeft: 20 } : {}),
                  ...(!isLast ? { paddingRight: 20, borderRight: '1px solid var(--bdr)' } : {}),
                }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER,
                  }}>{f.label}</div>
                  {opts.length === 0
                    ? <span style={{ fontSize: 12, color: 'var(--txt3)' }}>No values</span>
                    : opts.map(val => {
                      const display = f.getLabel
                        ? f.getLabel(val)
                        : val.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                      const chip  = f.chipStyle?.(val)
                      const count = rows.filter(r => String(r[f.key] ?? '') === val).length
                      return (
                        <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={sel.has(val)}
                            onChange={() => setActiveFilters(p => _toggleFSet(p, f.key, val))}
                            style={{ accentColor: f.accentColor ?? chip?.txt ?? NAVY, width: 14, height: 14, cursor: 'pointer' }}
                          />
                          {chip ? (
                            <span style={{
                              fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
                              borderRadius: 20, background: chip.bg, color: chip.txt,
                            }}>{display}</span>
                          ) : (
                            <span style={{ fontSize: 12, color: 'var(--txt)', fontFamily: INTER }}>{display}</span>
                          )}
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER, flexShrink: 0 }}>{count}</span>
                        </label>
                      )
                    })
                  }
                </div>
              )
            })}
          </div>

          <div style={{
            padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>
              {activeFilterCount === 0
                ? `No filters applied, showing all ${rows.length} rows`
                : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
            </span>
            <button onClick={resetFilters} style={{
              padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
              border: '1.5px solid var(--input-bdr)', background: 'transparent',
              color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
            }}>Reset</button>
            <button onClick={() => setFilterOpen(false)} style={{
              marginLeft: 'auto', padding: '5px 16px', borderRadius: 7,
              fontSize: 12, fontWeight: 600,
              border: 'none', background: RED, color: '#fff',
              cursor: 'pointer', fontFamily: SORA,
            }}>Done · {filtered.length} results</button>
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {!filterOpen && activeFilterCount > 0 && !!filters?.length && (
        <div style={{
          padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
          {filters.map(f =>
            [...(activeFilters[f.key] ?? new Set<string>())].map(val => {
              const display = f.getLabel
                ? f.getLabel(val)
                : val.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
              const chip = f.chipStyle?.(val)
              return (
                <span key={`${f.key}:${val}`} style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px',
                  borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                  background: chip?.bg ?? 'var(--chip-bg)',
                  color: chip?.txt ?? 'var(--chip-txt)',
                }}>
                  {display}
                  <span
                    className="material-symbols-rounded"
                    style={{ fontSize: 12, cursor: 'pointer' }}
                    onClick={() => setActiveFilters(p => _toggleFSet(p, f.key, val))}
                  >close</span>
                </span>
              )
            })
          )}
          <button onClick={resetFilters} style={{
            marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 11.5, fontWeight: 600, color: 'var(--txt3)', padding: 0, fontFamily: SORA,
          }}>Clear all</button>
        </div>
      )}

      {/* Bulk selection bar */}
      {selectable && selectedIds.size > 0 && (
        <div style={{
          background: '#F0F4FF', borderBottom: '1px solid var(--bdr)',
          padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ ...NUM, fontSize: 12.5, fontWeight: 700, color: NAVY }}>{selectedIds.size} selected</span>
          <div style={{ display: 'flex', gap: 7 }}>{bulkBar}</div>
          <button onClick={() => setSelectedIds(new Set())} style={{
            marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer',
            color: 'var(--txt2)', display: 'flex', alignItems: 'center', gap: 3,
            fontSize: 12, fontFamily: INTER,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--th-bg)' }}>
              {selectable && (
                <th style={{ ...thBase, width: 40 }}>
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && selectedIds.size === rows.length}
                    ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < rows.length }}
                    onChange={toggleAll}
                    style={{ width: 15, height: 15, cursor: 'pointer', accentColor: RED }}
                  />
                </th>
              )}
              {cols.map(col => (
                <th
                  key={col.key}
                  onClick={col.sortable !== false && !loading ? () => toggleSort(col.key) : undefined}
                  style={{
                    ...thBase, width: col.width, textAlign: col.align ?? 'left',
                    cursor: col.sortable !== false ? 'pointer' : 'default',
                    color: sortKey === col.key ? 'var(--txt)' : 'var(--txt2)',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {col.label}
                    {col.sortable !== false && (
                      <span style={{ color: RED, opacity: sortKey === col.key ? 1 : 0.3, fontSize: 11 }}>
                        {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i}>
                  {selectable && <td style={tdBase}><Sk w={16} h={16} radius={3} /></td>}
                  {cols.map(col => <td key={col.key} style={tdBase}><Sk h={14} /></td>)}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={cols.length + (selectable ? 1 : 0)} style={{ ...tdBase, textAlign: 'center', color: 'var(--txt2)', padding: '40px 12px' }}>
                  {emptyText}
                </td>
              </tr>
            ) : (
              displayRows.map((row, i) => {
                const id    = getKey(row, i)
                const isSel = selectedIds.has(id)
                const rs    = rowStyle?.(row, i)
                const rowBg = (isSel ? 'var(--row-sel)' : rs?.background) as string | undefined
                return (
                  <tr
                    key={id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    style={{ ...rs, background: rowBg, cursor: onRowClick ? 'pointer' : undefined }}
                    onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = (rs?.background as string) ?? '' }}
                  >
                    {selectable && (
                      <td style={tdBase} onClick={e => { e.stopPropagation(); toggleRow(id) }}>
                        <input type="checkbox" checked={isSel} onChange={() => toggleRow(id)} style={{ width: 15, height: 15, cursor: 'pointer', accentColor: RED }} />
                      </td>
                    )}
                    {cols.map(col => (
                      <td key={col.key} style={{ ...tdBase, textAlign: col.align ?? 'left' }}>
                        {col.render ? col.render(row, i) : (row[col.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {!!pageSize && filtered.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
            {`Showing ${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)} of ${filtered.length.toLocaleString()}`}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <_PgBtn icon="chevron_left" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} />
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              let pg: number
              if (totalPages <= 7)          pg = i + 1
              else if (safePage <= 4)        pg = i + 1
              else if (safePage >= totalPages - 3) pg = totalPages - 6 + i
              else                           pg = safePage - 3 + i
              return <_PgBtn key={pg} active={pg === safePage} onClick={() => setPage(pg)}>{pg}</_PgBtn>
            })}
            <_PgBtn icon="chevron_right" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Confirm modal ─────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  open: boolean
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}

export function ConfirmModal({ open, title, body, confirmLabel = 'Confirm', danger, loading, onConfirm, onClose, children }: ConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  // See Modal: onClose is usually an inline arrow, so keep it in a ref rather than as
  // an effect dependency — otherwise every keystroke in a child field re-ran the focus
  // effect and yanked focus back to the first control.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const el = dialogRef.current
    if (!el) return
    el.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab') return
      const el = dialogRef.current
      if (!el) return
      const focusable = el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) { e.preventDefault(); return }
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus() } }
      else            { if (document.activeElement === last)  { e.preventDefault(); first?.focus() } }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div ref={dialogRef} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{title}</h3>
        {body && <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--txt2)', lineHeight: 1.55 }}>{body}</p>}
        {children && <div style={{ marginBottom: 16 }}>{children}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: danger ? RED : NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            {loading && <Spinner size={14} color="#fff" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Generic modal ─────────────────────────────────────────────────────────────

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  width?: number
  maxHeight?: string
  children: ReactNode
  footer?: ReactNode
}

export function Modal({ open, onClose, title, width = 520, maxHeight, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Keep the latest onClose without making it a dependency of the effects below.
  // onClose is almost always an inline arrow (`() => setOpen(false)`), so it gets a
  // fresh identity on every parent re-render — including every keystroke in a field.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Autofocus the first field ONCE, when the dialog opens. This used to also depend
  // on `onClose`, so a keystroke → parent re-render → new onClose → effect re-ran →
  // focus was yanked back to the first field mid-typing ("it jumps when typing").
  useEffect(() => {
    if (!open) return
    const el = dialogRef.current
    if (!el) return
    // Prefer the first form field (skip the header ✕) so create/edit forms land
    // ready to type; fall back to the first focusable for field-less dialogs.
    const firstField = el.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')
    const first = el.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ;(firstField ?? first)?.focus()
  }, [open])

  // Escape-to-close + tab focus trap. Recomputes the focusable set on each keypress
  // (cheap, and correct as the form's fields change) so it never goes stale.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab') return
      const el = dialogRef.current
      if (!el) return
      const focusable = el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) { e.preventDefault(); return }
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus() } }
      else            { if (document.activeElement === last)  { e.preventDefault(); first?.focus() } }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div ref={dialogRef} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 14, overflow: 'hidden', width: '100%', maxWidth: width, maxHeight: maxHeight ? `min(${maxHeight}, calc(100vh - 48px))` : 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{title}</h3>
          <button onClick={onClose} style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', borderRadius: 6, color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>{children}</div>
        {footer && (
          <div style={{ padding: '14px 20px', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Date filter (calendar range picker) ──────────────────────────────────────

function _dfPad(n: number) { return String(n).padStart(2, '0') }
function _dfIso(y: number, m: number, d: number) { return `${y}-${_dfPad(m)}-${_dfPad(d)}` }
function _dfPrevYM(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${_dfPad(m - 1)}`
}
function _dfNextYM(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${_dfPad(m + 1)}`
}
function _dfMonthLabel(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' })
}
function _dfRelDay(offset: number) {
  const d = new Date(); d.setDate(d.getDate() + offset)
  return _dfIso(d.getFullYear(), d.getMonth() + 1, d.getDate())
}
function _dfThisQuarter(): [string, string] {
  const d = new Date(), y = d.getFullYear(), q = Math.floor(d.getMonth() / 3)
  return [_dfIso(y, q * 3 + 1, 1), today()]
}
function _dfLastQuarter(): [string, string] {
  const d = new Date()
  let y = d.getFullYear(), q = Math.floor(d.getMonth() / 3) - 1
  if (q < 0) { q = 3; y -= 1 }
  const sm = q * 3 + 1, em = sm + 2
  return [_dfIso(y, sm, 1), _dfIso(y, em, new Date(y, em, 0).getDate())]
}

const DF_PRESET_GROUPS: { label: string; get: () => [string, string] }[][] = [
  [{ label: 'All time', get: () => ['', ''] }],
  [
    { label: 'Today',        get: () => { const t = today(); return [t, t] } },
    { label: 'Last 7 days',  get: () => [_dfRelDay(-6), today()] },
    { label: 'Last 30 days', get: () => [_dfRelDay(-29), today()] },
    { label: 'Last 90 days', get: () => [_dfRelDay(-89), today()] },
  ],
  [
    { label: 'This week', get: () => {
      const d = new Date(), dow = d.getDay()
      const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
      return [_dfIso(mon.getFullYear(), mon.getMonth() + 1, mon.getDate()), today()]
    }},
    { label: 'This month',   get: () => [monthStart(), today()] },
    { label: 'Last month',   get: () => {
      const d = new Date()
      const pm = d.getMonth() === 0 ? 12 : d.getMonth()
      const py = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear()
      return [_dfIso(py, pm, 1), _dfIso(py, pm, new Date(d.getFullYear(), d.getMonth(), 0).getDate())]
    }},
  ],
  [
    { label: 'This quarter', get: _dfThisQuarter },
    { label: 'Last quarter', get: _dfLastQuarter },
    { label: 'This year',    get: () => [yearStart(), today()] },
  ],
]

const DF_WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const CELL = 30  // px per calendar cell

function DFMonthGrid({ ym, lo, hi, pendingStart, onDay, onHover }: {
  ym: string; lo: string; hi: string; pendingStart: string | null
  onDay: (iso: string) => void; onHover: (iso: string | null) => void
}) {
  const [y, m] = ym.split('-').map(Number)
  const firstDow = new Date(y, m - 1, 1).getDay()           // 0 = Sun
  const offset   = firstDow === 0 ? 6 : firstDow - 1        // Mon-based
  const daysCount = new Date(y, m, 0).getDate()
  const t = today()

  const cells: (number | null)[] = [
    ...Array(offset).fill(null),
    ...Array.from({ length: daysCount }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div style={{ userSelect: 'none' }}>
      <p style={{ textAlign: 'center', fontSize: 12.5, fontWeight: 700, color: 'var(--txt)', marginBottom: 8, letterSpacing: '-0.1px' }}>
        {_dfMonthLabel(ym)}
      </p>
      {/* Weekday headers */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(7, ${CELL}px)`, marginBottom: 2 }}>
        {DF_WEEKDAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--txt3)', height: 22, lineHeight: '22px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{d}</div>
        ))}
      </div>
      {/* Day rows */}
      {Array.from({ length: cells.length / 7 }, (_, wi) => (
        <div key={wi} style={{ display: 'grid', gridTemplateColumns: `repeat(7, ${CELL}px)` }}>
          {cells.slice(wi * 7, wi * 7 + 7).map((day, di) => {
            if (!day) return <div key={di} style={{ height: CELL }} />
            const iso   = _dfIso(y, m, day)
            const isLo  = !!lo && iso === lo
            const isHi  = !!hi && iso === hi && lo !== hi
            const mid   = !!lo && !!hi && lo !== hi && iso > lo && iso < hi
            const single = !!lo && lo === hi && iso === lo
            const filled = isLo || isHi || single
            const hasBg  = isLo || isHi || mid          // range strip shown
            const isToday = iso === t
            const isPend  = !!pendingStart && iso === pendingStart && !lo

            return (
              <div key={di}
                style={{ position: 'relative', height: CELL, cursor: 'pointer' }}
                onClick={() => onDay(iso)}
                onMouseEnter={() => onHover(iso)}
                onMouseLeave={() => onHover(null)}
              >
                {/* Range strip — connects start to end with a background band */}
                {hasBg && (
                  <div style={{
                    position: 'absolute', top: 4, bottom: 4,
                    left:  isLo ? '50%' : 0,
                    right: isHi ? '50%' : 0,
                    background: 'rgba(14,40,65,0.09)',
                    zIndex: 0,
                  }} />
                )}
                {/* Day circle */}
                <div style={{
                  position: 'relative', zIndex: 1,
                  width: 26, height: 26, borderRadius: '50%',
                  margin: '2px auto',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: filled || isToday ? 700 : 400,
                  background: filled ? NAVY : isPend ? 'rgba(14,40,65,0.12)' : 'transparent',
                  color: filled ? '#fff' : isToday ? NAVY : 'var(--txt)',
                  border: isToday && !filled ? `1.5px solid ${NAVY}` : 'none',
                  boxSizing: 'border-box' as const,
                  transition: 'background 80ms',
                }}>
                  {day}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function DateFilter({ from, to, onChange, align = 'left' }: {
  from: string; to: string; onChange: (f: string, t: string) => void; align?: 'left' | 'right'
}) {
  const now     = new Date()
  const initYM  = from ? from.slice(0, 7) : `${now.getFullYear()}-${_dfPad(now.getMonth() + 1)}`

  const [open,         setOpen]         = useState(false)
  const [viewYM,       setViewYM]       = useState(initYM)
  const [pendingStart, setPendingStart] = useState<string | null>(null)
  const [hover,        setHover]        = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false); setPendingStart(null); setHover(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Reset view to 'from' month whenever it changes
  useEffect(() => { if (from && open) setViewYM(from.slice(0, 7)) }, [from])

  // Effective lo/hi: during range selection show hover preview
  const effFrom = pendingStart ?? from
  const effTo   = pendingStart ? (hover ?? pendingStart) : to
  const lo = effFrom && effTo ? (effFrom <= effTo ? effFrom : effTo) : (effFrom || effTo)
  const hi = effFrom && effTo ? (effFrom <= effTo ? effTo   : effFrom) : (effFrom || effTo)

  function handleDayClick(iso: string) {
    if (!pendingStart) {
      setPendingStart(iso)
    } else {
      const [f, t] = iso >= pendingStart ? [pendingStart, iso] : [iso, pendingStart]
      onChange(f, t); setPendingStart(null); setHover(null); setOpen(false)
    }
  }

  function applyPreset(f: string, t: string) {
    onChange(f, t); setPendingStart(null); setHover(null); setOpen(false)
  }

  const month2 = _dfNextYM(viewYM)

  const btnLabel = !from && !to
    ? 'All time'
    : from === to
      ? fmtDate(from)
      : `${fmtDate(from)} – ${fmtDate(to)}`

  const navBtn: CSSProperties = {
    width: 28, height: 28, borderRadius: 6, border: '1px solid var(--bdr)',
    background: 'var(--card)', cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)',
  }

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      {/* Trigger button */}
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', borderRadius: 7, fontSize: 12.5, fontWeight: 500,
        border: `1.5px solid ${open ? NAVY : 'var(--input-bdr)'}`,
        background: open ? `rgba(14,40,65,0.04)` : 'var(--card)',
        color: 'var(--txt)', cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'border-color 120ms, background 120ms',
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 15, color: open ? NAVY : 'var(--txt3)', transition: 'color 120ms' }}>calendar_month</span>
        <span style={{ color: !from && !to ? 'var(--txt3)' : 'var(--txt)' }}>{btnLabel}</span>
        <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)' }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', ...(align === 'right' ? { right: 0 } : { left: 0 }), zIndex: 500,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
          display: 'flex', overflow: 'hidden',
        }}>

          {/* Presets column */}
          <div style={{ width: 136, borderRight: '1px solid var(--bdr)', padding: '10px 0', flexShrink: 0 }}>
            {DF_PRESET_GROUPS.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && <div style={{ height: 1, background: 'var(--bdr)', margin: '4px 0' }} />}
                {group.map(p => {
                  const [f, t] = p.get()
                  const active = f === from && t === to
                  return (
                    <button key={p.label} onClick={() => applyPreset(f, t)} style={{
                      display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                      padding: '6px 12px', background: 'transparent', border: 'none',
                      cursor: 'pointer', fontSize: 12.5, fontWeight: active ? 600 : 400,
                      color: active ? NAVY : 'var(--txt)', textAlign: 'left',
                    }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 13, color: active ? NAVY : 'transparent', flexShrink: 0 }}>check</span>
                      {p.label}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Calendar area */}
          <div style={{ padding: '14px 16px 12px' }}>
            {/* Month navigation */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <button onClick={() => setViewYM(_dfPrevYM(viewYM))} style={navBtn}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>chevron_left</span>
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={() => setViewYM(_dfNextYM(viewYM))} style={navBtn}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>chevron_right</span>
              </button>
            </div>

            {/* Two months side by side */}
            <div style={{ display: 'flex', gap: 16 }}>
              <DFMonthGrid ym={viewYM} lo={lo} hi={hi} pendingStart={pendingStart}
                onDay={handleDayClick} onHover={setHover} />
              <div style={{ width: 1, background: 'var(--bdr)', flexShrink: 0 }} />
              <DFMonthGrid ym={month2} lo={lo} hi={hi} pendingStart={pendingStart}
                onDay={handleDayClick} onHover={setHover} />
            </div>

            {/* Footer */}
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 8, minHeight: 34 }}>
              {pendingStart ? (
                <span style={{ fontSize: 12, color: 'var(--txt3)', flex: 1 }}>
                  Click a second day to complete the range
                </span>
              ) : (from || to) ? (
                <>
                  <span style={{ fontSize: 12.5, color: 'var(--txt2)', flex: 1 }}>
                    {from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`}
                  </span>
                  <button onClick={() => applyPreset('', '')} style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)',
                    background: 'var(--card)', color: 'var(--txt2)', fontSize: 12,
                    cursor: 'pointer', fontWeight: 500,
                  }}>Clear</button>
                </>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--txt3)', flex: 1 }}>
                  Click a day to start selecting a range
                </span>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

// ── Shared button styles ──────────────────────────────────────────────────────

// ── Button style objects (kept for backwards compat with inline usage) ────────
export const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: SP[2],
  padding: `${SP[2]} ${SP[4]}`, background: NAVY, color: '#fff',
  border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
  cursor: 'pointer', whiteSpace: 'nowrap',
}
export const btnSecondary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: SP[2],
  padding: `${SP[2]} ${SP[3]}`, background: 'var(--card)', color: 'var(--txt)',
  border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.medium,
  cursor: 'pointer', whiteSpace: 'nowrap',
}
export const btnDanger: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: SP[2],
  padding: `${SP[2]} ${SP[4]}`, background: RED, color: '#fff',
  border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
  cursor: 'pointer', whiteSpace: 'nowrap',
}

// ── Button component ──────────────────────────────────────────────────────────

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
type BtnSize    = 'xs' | 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: BtnSize
  icon?: string
  iconRight?: string
  loading?: boolean
  children?: ReactNode
}

const BTN_BASE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  gap: SP[1], border: 'none', borderRadius: RADIUS.md,
  fontFamily: 'var(--font-sans)', fontWeight: FW.semibold,
  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  position: 'relative', userSelect: 'none',
}
const BTN_VARIANTS: Record<BtnVariant, CSSProperties> = {
  primary:   { background: NAVY,            color: '#fff',           border: `1px solid ${NAVY}` },
  secondary: { background: 'var(--card)',   color: 'var(--txt)',     border: '1px solid var(--bdr)' },
  danger:    { background: RED,             color: '#fff',           border: `1px solid ${RED}` },
  ghost:     { background: 'transparent',   color: 'var(--txt2)',    border: '1px solid transparent' },
}
const BTN_SIZES: Record<BtnSize, CSSProperties> = {
  xs: { fontSize: TEXT.xs,   padding: `${SP[1]} ${SP[2]}`,  gap: SP[1] },
  sm: { fontSize: TEXT.sm,   padding: `5px ${SP[3]}`,       gap: SP[1] },
  md: { fontSize: TEXT.base, padding: `${SP[2]} ${SP[4]}`,  gap: SP[2] },
  lg: { fontSize: TEXT.md,   padding: `${SP[3]} ${SP[5]}`,  gap: SP[2] },
}

export function Button({ variant = 'primary', size = 'md', icon, iconRight, loading, children, style, disabled, ...rest }: ButtonProps) {
  const iconSz = size === 'xs' || size === 'sm' ? 14 : 16
  return (
    <button
      disabled={disabled || loading}
      style={{ ...BTN_BASE, ...BTN_VARIANTS[variant], ...BTN_SIZES[size], ...style }}
      {...rest}
    >
      {loading
        ? <Spinner size={iconSz} color={variant === 'secondary' || variant === 'ghost' ? NAVY : '#fff'} />
        : icon && <span className="material-symbols-rounded" style={{ fontSize: iconSz }}>{icon}</span>}
      {children}
      {!loading && iconRight && <span className="material-symbols-rounded" style={{ fontSize: iconSz }}>{iconRight}</span>}
    </button>
  )
}

// ── Form field wrapper ────────────────────────────────────────────────────────

interface FieldProps {
  label?: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactNode
  style?: CSSProperties
}

export function Field({ label, hint, error, required, children, style }: FieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1], ...style }}>
      {label && (
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)', lineHeight: 'var(--lh-snug)' }}>
          {label}
          {required && <span style={{ color: RED, marginLeft: SP[1] }}>*</span>}
        </label>
      )}
      {children}
      {error
        ? <span style={{ fontSize: TEXT.xs, color: RED, display: 'flex', alignItems: 'center', gap: SP[1] }}>
            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>error</span>{error}
          </span>
        : hint && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 'var(--lh-base)' }}>{hint}</span>
      }
    </div>
  )
}

// ── Input ─────────────────────────────────────────────────────────────────────

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  prefix?: string   // material icon name
  suffix?: string   // material icon name
  wrapStyle?: CSSProperties
}

const INPUT_BASE: CSSProperties = {
  display: 'block', width: '100%',
  padding: `${SP[2]} ${SP[3]}`,
  background: 'var(--input-bg)', color: 'var(--txt)',
  border: '1.5px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, fontFamily: 'var(--font-sans)',
  outline: 'none', appearance: 'none',
}
const INPUT_ERROR: CSSProperties = { borderColor: RED }

export function Input({ label, hint, error, prefix, suffix, wrapStyle, style, ...rest }: InputProps) {
  const hasIcon = prefix || suffix
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} style={wrapStyle}>
      <div style={{ position: 'relative' }}>
        {prefix && (
          <span className="material-symbols-rounded" style={{
            position: 'absolute', left: SP[3], top: '50%', transform: 'translateY(-50%)',
            fontSize: 16, color: 'var(--txt3)', pointerEvents: 'none',
          }}>{prefix}</span>
        )}
        <input
          style={{
            ...INPUT_BASE,
            ...(error ? INPUT_ERROR : {}),
            ...(hasIcon ? { paddingLeft: prefix ? SP[8] : SP[3], paddingRight: suffix ? SP[8] : SP[3] } : {}),
            ...style,
          }}
          {...rest}
        />
        {suffix && (
          <span className="material-symbols-rounded" style={{
            position: 'absolute', right: SP[3], top: '50%', transform: 'translateY(-50%)',
            fontSize: 16, color: 'var(--txt3)', pointerEvents: 'none',
          }}>{suffix}</span>
        )}
      </div>
    </Field>
  )
}

// ── Select ────────────────────────────────────────────────────────────────────

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  hint?: string
  error?: string
  wrapStyle?: CSSProperties
  children: ReactNode
}

export function Select({ label, hint, error, wrapStyle, style, children, ...rest }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} style={wrapStyle}>
      <div style={{ position: 'relative' }}>
        <select
          style={{
            ...INPUT_BASE,
            paddingRight: SP[8],
            cursor: 'pointer',
            ...(error ? INPUT_ERROR : {}),
            ...style,
          }}
          {...rest}
        >
          {children}
        </select>
        <span className="material-symbols-rounded" style={{
          position: 'absolute', right: SP[3], top: '50%', transform: 'translateY(-50%)',
          fontSize: 16, color: 'var(--txt3)', pointerEvents: 'none',
        }}>expand_more</span>
      </div>
    </Field>
  )
}

// ── Textarea ──────────────────────────────────────────────────────────────────

interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
  wrapStyle?: CSSProperties
}

export function Textarea({ label, hint, error, wrapStyle, style, ...rest }: TextareaFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} style={wrapStyle}>
      <textarea
        style={{
          ...INPUT_BASE,
          resize: 'vertical',
          minHeight: 80,
          lineHeight: 'var(--lh-relaxed)',
          ...(error ? INPUT_ERROR : {}),
          ...style,
        }}
        {...rest}
      />
    </Field>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  action?: { label: string; onClick: () => void; icon?: string }
  style?: CSSProperties
}

export function EmptyState({ icon = 'inbox', title, description, action, style }: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: `${SP[12]} ${SP[8]}`, gap: SP[3], textAlign: 'center', ...style,
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: RADIUS.xl,
        background: 'var(--th-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: SP[1],
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 22, color: 'var(--txt3)' }}>{icon}</span>
      </div>
      <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', lineHeight: 'var(--lh-snug)' }}>{title}</div>
      {description && (
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 'var(--lh-relaxed)', maxWidth: 320 }}>{description}</div>
      )}
      {action && (
        <Button variant="secondary" size="sm" icon={action.icon} onClick={action.onClick} style={{ marginTop: SP[2] }}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

// ── Divider ───────────────────────────────────────────────────────────────────

export function Divider({ label, style }: { label?: string; style?: CSSProperties }) {
  if (!label) return <hr style={{ border: 'none', borderTop: '1px solid var(--bdr)', margin: `${SP[4]} 0`, ...style }} />
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], margin: `${SP[4]} 0`, ...style }}>
      <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--bdr)' }} />
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.medium, whiteSpace: 'nowrap', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
      <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--bdr)' }} />
    </div>
  )
}

// ── Badge ─────────────────────────────────────────────────────────────────────

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'
const BADGE_COLORS: Record<BadgeVariant, { bg: string; txt: string }> = {
  default: { bg: 'var(--chip-bg)',          txt: 'var(--chip-txt)' },
  success: { bg: 'rgba(22,163,74,.1)',       txt: '#15803d' },
  warning: { bg: 'rgba(217,119,6,.1)',       txt: '#b45309' },
  danger:  { bg: 'rgba(192,0,0,.1)',         txt: '#c00000' },
  info:    { bg: 'rgba(37,99,235,.1)',       txt: '#1d4ed8' },
  neutral: { bg: 'var(--th-bg)',             txt: 'var(--txt2)' },
}

export function Badge({ children, variant = 'default', dot, style }: {
  children: ReactNode; variant?: BadgeVariant; dot?: boolean; style?: CSSProperties
}) {
  const { bg, txt } = BADGE_COLORS[variant]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: SP[1],
      padding: `2px ${SP[2]}`, borderRadius: RADIUS.full,
      fontSize: TEXT.xs, fontWeight: FW.semibold,
      background: bg, color: txt, whiteSpace: 'nowrap', ...style,
    }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />}
      {children}
    </span>
  )
}
