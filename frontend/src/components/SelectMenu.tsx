import { useState, useMemo, useEffect, useRef, useId, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'
import { RED, TEXT, FW, SP, RADIUS, SHADOW } from '../lib/design'

// ── SelectMenu — one dropdown, positioned and bounded ─────────────────────────
//
// WHY THIS EXISTS. A native <select> hands its popup to the browser, which decides
// both where it opens and how tall it gets. On a list of any real length that means
// the menu flips above the field and runs the full height of the viewport, so the
// officer picker on a form near the bottom of a page opened upward over the fields
// you had just filled in, with 20+ unbounded rows and nothing to scroll.
//
// The behaviour here is the part the native control will not give us:
//   • It opens DOWNWARD by default and flips up only when there is genuinely not
//     enough room below AND more room above — not merely because the field sits in
//     the lower half of the screen.
//   • Its height is capped and the list scrolls inside that cap, so the menu never
//     covers the page it belongs to.
//   • Long lists get a filter box, because picking one of 20 officers by eye is the
//     actual complaint behind "the list gets too long".
//
// It renders through a portal at position:fixed so it is never clipped by a card's
// overflow and never trapped under a modal's stacking context, and it re-measures on
// scroll and resize so it stays attached to its field.
//
// Keyboard and screen-reader behaviour matches the native control it replaces:
// Up/Down/Home/End move the active option, Enter and Space commit, Escape closes and
// restores focus to the trigger, and typing jumps to the next matching option.

export interface SelectOption {
  value: string
  label: string
  /** Optional second line — an officer's role, a team's member count. */
  hint?: string
  disabled?: boolean
  /** Renders as a non-selectable heading above this option. */
  group?: string
}

interface SelectMenuProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  /** Shown as a first, always-selectable option — e.g. "All officers". */
  clearLabel?: string
  disabled?: boolean
  /** Force the filter box on or off. Default: on when there are more than 8 options. */
  searchable?: boolean
  id?: string
  ariaLabel?: string
  style?: CSSProperties
  /** Width of the menu. Defaults to the trigger's width. */
  menuWidth?: number
  leadingIcon?: string
}

/** Height the menu will not exceed, and the gap it keeps from the viewport edge. */
const MAX_MENU_H = 320
const VIEWPORT_GAP = 12
const ROW_H = 36

export function SelectMenu({
  value, onChange, options, placeholder = 'Select…', clearLabel,
  disabled, searchable, id, ariaLabel, style, menuWidth, leadingIcon,
}: SelectMenuProps) {
  const uid = useId()
  const triggerId = id ?? `${uid}trigger`
  const listboxId = `${uid}listbox`

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number; flipped: boolean } | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Type-ahead buffer for the no-search-box case, mirroring a native select.
  const typeAhead = useRef({ buf: '', at: 0 })

  const showSearch = searchable ?? options.length > 8

  // The option list the menu actually renders: the optional clear row, then whatever
  // survives the filter. Matching on label AND hint means typing a role ("head")
  // finds people, not just names.
  const items = useMemo<SelectOption[]>(() => {
    const base = clearLabel ? [{ value: '', label: clearLabel }, ...options] : options
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter(o =>
      o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q))
  }, [options, clearLabel, query])

  const selected = useMemo(
    () => options.find(o => o.value === value) ?? (value === '' && clearLabel ? { value: '', label: clearLabel } : undefined),
    [options, value, clearLabel])

  // ── Positioning ─────────────────────────────────────────────────────────────
  //
  // Measured against the VIEWPORT, not the document, because the menu is fixed.
  // The flip rule is deliberately conservative: prefer below, and only go above when
  // below cannot fit a usable menu and above is genuinely roomier. A menu that flips
  // on a 1px difference is more disorienting than one that scrolls.
  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - VIEWPORT_GAP
    const above = r.top - VIEWPORT_GAP
    const wanted = Math.min(MAX_MENU_H, items.length * ROW_H + (showSearch ? 48 : 0) + 8)

    const flipped = below < Math.min(wanted, 160) && above > below
    const maxH = Math.max(120, Math.min(wanted, flipped ? above : below))
    const width = menuWidth ?? r.width

    // Keep the menu on screen horizontally even when the trigger sits at the edge.
    const left = Math.max(VIEWPORT_GAP, Math.min(r.left, window.innerWidth - width - VIEWPORT_GAP))

    setPos({ top: flipped ? r.top - maxH - 4 : r.bottom + 4, left, width, maxH, flipped })
  }, [items.length, showSearch, menuWidth])

  // Place before paint so the menu never appears in the wrong spot for a frame.
  useLayoutEffect(() => { if (open) place() }, [open, place])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => place()
    // Capture phase: any ancestor scrolling moves the trigger, not just the window.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, place])

  // Outside click / focus-out closes.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // On open, start on the current selection and focus the filter if there is one.
  useEffect(() => {
    if (!open) { setQuery(''); return }
    const i = items.findIndex(o => o.value === value)
    setActiveIdx(i >= 0 ? i : 0)
    if (showSearch) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active option in view as the keyboard walks the list.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  const commit = useCallback((opt: SelectOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    close()
  }, [onChange, close])

  const step = useCallback((dir: 1 | -1) => {
    setActiveIdx(cur => {
      const n = items.length
      if (n === 0) return 0
      let i = cur
      // Skip disabled rows rather than parking the cursor on something unusable.
      for (let k = 0; k < n; k++) {
        i = (i + dir + n) % n
        if (!items[i]?.disabled) return i
      }
      return cur
    })
  }, [items])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); step(1); break
      case 'ArrowUp': e.preventDefault(); step(-1); break
      case 'Home': e.preventDefault(); setActiveIdx(0); break
      case 'End': e.preventDefault(); setActiveIdx(items.length - 1); break
      case 'Enter':
      case ' ': {
        // Space is a literal character while typing in the filter box.
        if (e.key === ' ' && showSearch) return
        e.preventDefault()
        const opt = items[activeIdx]
        if (opt) commit(opt)
        break
      }
      case 'Escape': e.preventDefault(); close(); break
      case 'Tab': close(false); break
      default: {
        if (showSearch || e.key.length !== 1) return
        // Native-select type-ahead: letters typed within a second accumulate.
        const now = Date.now()
        const t = typeAhead.current
        t.buf = now - t.at > 1000 ? e.key : t.buf + e.key
        t.at = now
        const hit = items.findIndex(o => o.label.toLowerCase().startsWith(t.buf.toLowerCase()))
        if (hit >= 0) setActiveIdx(hit)
      }
    }
  }

  const triggerStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: SP[2], width: '100%',
    padding: `8px ${SP[3]}`, minHeight: 38,
    background: 'var(--card)', color: selected ? 'var(--txt)' : 'var(--txt3)',
    border: `1px solid ${open ? RED : 'var(--bdr)'}`, borderRadius: RADIUS.md,
    fontSize: TEXT.base, fontFamily: 'inherit', textAlign: 'left',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
    outline: 'none', boxShadow: open ? `0 0 0 3px color-mix(in srgb, ${RED} 18%, transparent)` : 'none',
    ...style,
  }

  return (
    <>
      <button
        ref={triggerRef} id={triggerId} type="button" disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)} onKeyDown={onKeyDown}
        role="combobox" aria-expanded={open} aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined} aria-label={ariaLabel}
        style={triggerStyle}
      >
        {leadingIcon && (
          <span className="material-symbols-rounded" aria-hidden
            style={{ fontSize: 16, color: 'var(--txt3)' }}>{leadingIcon}</span>
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label ?? placeholder}
        </span>
        <span className="material-symbols-rounded" aria-hidden style={{
          fontSize: 18, color: 'var(--txt3)', flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease',
        }}>expand_more</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef} style={{
            position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
            maxHeight: pos.maxH, zIndex: 9999,
            background: 'var(--card)', border: '1px solid var(--bdr)',
            borderRadius: RADIUS.md, boxShadow: SHADOW.lg,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          {showSearch && (
            <div style={{ padding: SP[2], borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
              <input
                ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
                onKeyDown={onKeyDown} placeholder="Search…" aria-label="Filter options"
                style={{
                  width: '100%', padding: `6px ${SP[2]}`, fontSize: TEXT.sm, fontFamily: 'inherit',
                  background: 'var(--bg)', color: 'var(--txt)',
                  border: '1px solid var(--bdr)', borderRadius: RADIUS.sm, outline: 'none',
                }}
              />
            </div>
          )}

          <div ref={listRef} id={listboxId} role="listbox" aria-activedescendant={`${uid}opt${activeIdx}`}
            style={{ overflowY: 'auto', flex: 1, padding: SP[1] }}>
            {items.length === 0 && (
              <div style={{ padding: `${SP[3]} ${SP[3]}`, fontSize: TEXT.sm, color: 'var(--txt3)' }}>
                No matches
              </div>
            )}
            {items.map((o, i) => {
              const isSel = o.value === value
              const isActive = i === activeIdx
              const prevGroup = i > 0 ? items[i - 1]?.group : undefined
              return (
                <div key={`${o.value}-${i}`}>
                  {o.group && o.group !== prevGroup && (
                    <div style={{
                      padding: `${SP[2]} ${SP[2]} 4px`, fontSize: TEXT['2xs'], fontWeight: FW.semibold,
                      color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.06em',
                    }}>{o.group}</div>
                  )}
                  <div
                    id={`${uid}opt${i}`} data-idx={i} role="option"
                    aria-selected={isSel} aria-disabled={o.disabled || undefined}
                    onMouseEnter={() => !o.disabled && setActiveIdx(i)}
                    onClick={() => commit(o)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: SP[2],
                      padding: `7px ${SP[2]}`, borderRadius: RADIUS.sm,
                      fontSize: TEXT.base, lineHeight: 1.3,
                      color: o.disabled ? 'var(--txt3)' : 'var(--txt)',
                      background: isActive && !o.disabled ? 'var(--bg)' : 'transparent',
                      cursor: o.disabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontWeight: isSel ? FW.semibold : FW.normal,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{o.label}</div>
                      {o.hint && (
                        <div style={{
                          fontSize: TEXT.xs, color: 'var(--txt3)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{o.hint}</div>
                      )}
                    </div>
                    {isSel && (
                      <span className="material-symbols-rounded" aria-hidden
                        style={{ fontSize: 16, color: RED, flexShrink: 0 }}>check</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ── Labelled wrapper ──────────────────────────────────────────────────────────
// Mirrors the Field/label treatment the native Select wrapper gives, so swapping one
// for the other does not change a form's vertical rhythm.
export function SelectMenuField({
  label, hint, error, required, wrapStyle, ...rest
}: SelectMenuProps & { label?: string; hint?: string; error?: string; required?: boolean; wrapStyle?: CSSProperties }) {
  const uid = useId()
  const id = rest.id ?? `${uid}sm`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...wrapStyle }}>
      {label && (
        <label htmlFor={id} style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)' }}>
          {label}{required && <span style={{ color: RED }}> *</span>}
        </label>
      )}
      <SelectMenu {...rest} id={id} ariaLabel={rest.ariaLabel ?? label} />
      {(hint || error) && (
        <div style={{ fontSize: TEXT.xs, color: error ? RED : 'var(--txt3)' }}>{error || hint}</div>
      )}
    </div>
  )
}

/** Build options from a list of records — the common officer/team case. */
export function toOptions<T>(
  rows: T[],
  value: (r: T) => string | number,
  label: (r: T) => string,
  hint?: (r: T) => string | undefined,
): SelectOption[] {
  return rows.map(r => ({
    value: String(value(r)),
    label: label(r),
    hint: hint?.(r),
  }))
}

export default SelectMenu
