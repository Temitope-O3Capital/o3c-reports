import { useState, useMemo, useCallback } from 'react'
import type { ReactNode, CSSProperties } from 'react'
import { NAVY, RED, GREEN, INTER, NUM } from '../lib/design'

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
  active:      { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  approved:    { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  completed:   { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  resolved:    { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  won:         { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  kept:        { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  disbursed:   { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  issued:      { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  pending:     { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  reviewing:   { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  investigating: { bg: 'rgba(217,119,6,.12)',txt: '#D97706' },
  submitted:   { bg: 'rgba(37,99,235,.12)', txt: '#2563EB' },
  open:        { bg: 'rgba(37,99,235,.12)', txt: '#2563EB' },
  in_progress: { bg: 'rgba(37,99,235,.12)', txt: '#2563EB' },
  draft:       { bg: 'rgba(75,85,99,.1)',   txt: '#6B7280' },
  inactive:    { bg: 'rgba(75,85,99,.1)',   txt: '#6B7280' },
  closed:      { bg: 'rgba(75,85,99,.1)',   txt: '#6B7280' },
  archived:    { bg: 'rgba(75,85,99,.1)',   txt: '#6B7280' },
  declined:    { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
  failed:      { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
  overdue:     { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
  broken:      { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
  rejected:    { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
  blocked:     { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
}

export function StatusBadge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const key = status.toLowerCase().replace(/[\s-]+/g, '_')
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

export const filterInputStyle: CSSProperties = {
  height: 36, padding: '0 10px', border: '1px solid var(--input-bdr)',
  borderRadius: 8, fontSize: 13, background: 'var(--input-bg)',
  color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', minWidth: 130,
}

// ── Search input ──────────────────────────────────────────────────────────────

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
  const handleClear = onClear ?? (() => onChange(''))
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      height: 36, padding: '0 10px',
      background: 'var(--input-bg)', border: '1px solid var(--input-bdr)',
      borderRadius: 8, minWidth, ...style,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)', flexShrink: 0 }}>search</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onSearch ? e => { if (e.key === 'Enter') onSearch() } : undefined}
        placeholder={placeholder}
        style={{
          border: 'none', background: 'transparent', outline: 'none', boxShadow: 'none',
          width: '100%', fontSize: 13, color: 'var(--txt)', fontFamily: "'Sora', sans-serif",
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

// ── DataTable ─────────────────────────────────────────────────────────────────

export interface TableCol<T = any> {
  key: string
  label: string
  sortable?: boolean
  width?: string | number
  align?: 'left' | 'right' | 'center'
  render?: (row: T, idx: number) => ReactNode
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
}

export function DataTable<T extends Record<string, any>>({
  cols, rows, keyFn, onRowClick,
  selectable, selectedIds: extSel, onSelect,
  bulkBar, emptyText = 'No records found', loading, skeletonRows = 8, rowStyle,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [internalSel, setInternalSel] = useState<Set<string | number>>(new Set())

  const selectedIds = extSel ?? internalSel
  const setSelectedIds = onSelect ?? setInternalSel

  const toggleSort = useCallback((key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }, [sortKey])

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    return [...rows].sort((a, b) => {
      const va = a[sortKey] ?? '', vb = b[sortKey] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortKey, sortDir])

  const getKey = (row: T, i: number) => keyFn ? keyFn(row, i) : (row.id ?? i)

  function toggleAll() {
    setSelectedIds(selectedIds.size === rows.length ? new Set() : new Set(rows.map((r, i) => getKey(r, i))))
  }
  function toggleRow(id: string | number) {
    const next = new Set(selectedIds)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelectedIds(next)
  }

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
      {selectable && selectedIds.size > 0 && (
        <div style={{
          background: '#F0F4FF', borderBottom: '1px solid var(--bdr)',
          padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ ...NUM, fontSize: 12.5, fontWeight: 700, color: NAVY }}>{selectedIds.size} selected</span>
          <div style={{ display: 'flex', gap: 7 }}>
            {bulkBar}
          </div>
          <button onClick={() => setSelectedIds(new Set())} style={{
            marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer',
            color: 'var(--txt2)', display: 'flex', alignItems: 'center', gap: 3,
            fontSize: 12, fontFamily: INTER,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>Clear
          </button>
        </div>
      )}

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
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={cols.length + (selectable ? 1 : 0)} style={{ ...tdBase, textAlign: 'center', color: 'var(--txt2)', padding: '40px 12px' }}>
                  {emptyText}
                </td>
              </tr>
            ) : (
              sorted.map((row, i) => {
                const id = getKey(row, i)
                const isSel = selectedIds.has(id)
                const rs = rowStyle?.(row, i)
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
  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
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
  children: ReactNode
  footer?: ReactNode
}

export function Modal({ open, onClose, title, width = 520, children, footer }: ModalProps) {
  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 14, width: '100%', maxWidth: width, maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
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

// ── Shared button styles ──────────────────────────────────────────────────────

export const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  padding: '7px 15px', background: NAVY, color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap',
}
export const btnSecondary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  padding: '7px 13px', background: 'var(--card)', color: 'var(--txt)',
  border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, fontWeight: 500,
  cursor: 'pointer', whiteSpace: 'nowrap',
}
export const btnDanger: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  padding: '7px 15px', background: RED, color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap',
}
