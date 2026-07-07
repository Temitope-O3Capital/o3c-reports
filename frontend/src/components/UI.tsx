import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { ReactNode, CSSProperties } from 'react'
import { NAVY, RED, GREEN, INTER, SORA, MONO, NUM } from '../lib/design'
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
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: 8, padding: '16px 18px',
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
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: 8, overflow: 'hidden', ...style,
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
  color: 'var(--txt)', fontFamily: SORA, outline: 'none', minWidth: 130,
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
          width: '100%', fontSize: 13, color: 'var(--txt)', fontFamily: SORA,
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

// ── Table toolbar search box (demo .srch pattern) ────────────────────────────
// border: var(--bdr) normally → #0EA5E9 (sky) on focus; background: var(--card)

export function TblSearch({
  value, onChange, placeholder = 'Search…', width = 160, style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** input width in px, or pass 0 to let the input flex-grow (full-width usage) */
  width?: number
  /** additional styles merged onto the wrapper div */
  style?: CSSProperties
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
      border: `1.5px solid ${focused ? '#0EA5E9' : 'var(--bdr)'}`,
      borderRadius: 8, padding: '5px 10px',
      background: 'var(--card)',
      transition: 'border-color .12s',
      ...style,
    }}>
      {/* search icon — inline so UI.tsx stays free of icons import */}
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        style={{ color: 'var(--txt3)', flexShrink: 0 }}>
        <circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>
      </svg>
      <input
        className="srch-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={{
          border: 'none', outline: 'none', background: 'none',
          fontFamily: SORA,
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
                ? `No filters applied — showing all ${rows.length} rows`
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
