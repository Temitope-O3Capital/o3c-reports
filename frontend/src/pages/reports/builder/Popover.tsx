import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// Popover floats a panel under (or, near the bottom of the screen, above) the control
// that opened it. It is position: fixed rather than portalled, so it keeps the theme
// variables the app shell sets and still escapes the table's scroll container.
// It closes on Escape, on a click outside, when focus moves outside it and its anchor,
// and when the page scrolls or resizes.
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Popover({ anchorEl, onClose, width = 280, label, children }: {
  anchorEl: HTMLElement
  onClose: () => void
  width?: number
  label: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const anchorRef = useRef(anchorEl)
  anchorRef.current = anchorEl

  // Keyboard users land inside the panel when it opens, unless a field in it has already
  // taken focus with autoFocus, and go back to the control that opened it when it closes.
  // Focus is only handed back when it was in the panel or dropped to the page, so a click
  // on another field outside keeps that field focused.
  useEffect(() => {
    const panel = ref.current
    if (panel && !panel.contains(document.activeElement)) panel.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => {
      const active = document.activeElement
      const anchor = anchorRef.current
      const lost = !active || active === document.body || !!panel?.contains(active)
      if (lost && anchor.isConnected) anchor.focus()
    }
  }, [])
  const [style, setStyle] = useState<CSSProperties>({ left: 0, top: 0, width, visibility: 'hidden' })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const a = anchorEl.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = Math.min(width, vw - 16)
      // Line up with the anchor's left edge, or its right edge when that would run off screen.
      const left = Math.max(8, Math.min(a.left + w > vw - 8 ? a.right - w : a.left, vw - w - 8))
      const below = vh - a.bottom - 12
      const above = a.top - 12
      const up = below < 280 && above > below
      const maxHeight = Math.max(180, up ? above : below)
      const height = Math.min(el.scrollHeight + 2, maxHeight)
      const top = up ? a.top - 4 - height : a.bottom + 4
      // A transformed ancestor becomes the containing block of a fixed element and would
      // shift the panel, so measure where the current left/top actually land and correct.
      const r = el.getBoundingClientRect()
      const ox = r.left - (parseFloat(el.style.left) || 0)
      const oy = r.top - (parseFloat(el.style.top) || 0)
      setStyle({ left: left - ox, top: top - oy, width: w, maxHeight })
    }
    place()
    // Re-place when the content grows, e.g. once a column's values arrive.
    let frame = 0
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place) })
    ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(frame) }
  }, [anchorEl, width])

  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && (!!ref.current?.contains(t) || anchorEl.contains(t))
    const onDown = (e: MouseEvent) => { if (!inside(e.target)) closeRef.current() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) closeRef.current() }
    const onResize = () => closeRef.current()
    // Tabbing past the panel's last control closes it. A focusout with no new target is
    // ignored: that is a click on the panel's plain background, or the window losing focus.
    const onFocusOut = (e: FocusEvent) => {
      if (inside(e.target) && e.relatedTarget instanceof Node && !inside(e.relatedTarget)) closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('focusout', onFocusOut)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchorEl])

  return (
    <div ref={ref} className="rb-menu" role="dialog" aria-label={label} style={style}>
      {children}
    </div>
  )
}
