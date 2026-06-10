import { useState, useEffect, useRef } from 'react'

/* ═══════════════════════════════════════════════════════════════
   DATE HELPERS
   ═══════════════════════════════════════════════════════════════ */

export function toISO(d) {
  const yr  = d.getFullYear()
  const mo  = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${yr}-${mo}-${day}`
}

export function fmtDate(s) {
  if (!s) return '—'
  return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function quarterOf(d) { return Math.floor(d.getMonth() / 3) }

export function presetRange(preset, ref) {
  const d  = new Date(ref + 'T00:00:00')
  const yr = d.getFullYear()
  const mo = d.getMonth()
  const q  = quarterOf(d)
  if (preset === 'month')   return [toISO(new Date(yr, mo, 1)),       toISO(new Date(yr, mo + 1, 0))]
  if (preset === 'quarter') return [toISO(new Date(yr, q * 3, 1)),    toISO(new Date(yr, q * 3 + 3, 0))]
  if (preset === 'year')    return [`${yr}-01-01`,                     `${yr}-12-31`]
  return [null, null]
}

export function presetLabel(preset, dateFrom, dateTo, ref) {
  if (!dateFrom || !dateTo) return 'Select period'
  if (preset === 'custom') {
    if (dateFrom === dateTo) return fmtDate(dateFrom)
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
  }
  const d = new Date(ref + 'T00:00:00')
  if (preset === 'month')   return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  if (preset === 'quarter') return `Q${quarterOf(d) + 1} ${d.getFullYear()}`
  if (preset === 'year')    return `${d.getFullYear()}`
  return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
}

/* ═══════════════════════════════════════════════════════════════
   DATE RANGE PICKER
   Reusable dropdown with This Month / Quarter / Year / Custom.

   Props:
     dateFrom, dateTo, preset   — controlled values
     onChange(from, to, preset) — called when user commits a selection
     refDate                    — ISO date string used as "today" for
                                  preset calculations (defaults to today)
     footer                     — optional <ReactNode> shown at the bottom
                                  of the dropdown (e.g. "N days loaded")
   ═══════════════════════════════════════════════════════════════ */

export function DateRangePicker({ dateFrom, dateTo, preset, onChange, refDate, footer }) {
  const today = toISO(new Date())
  const ref_  = refDate || today

  const [open,       setOpen] = useState(false)
  const [localPreset, setLP]  = useState(preset)
  const [customFrom,  setCF]  = useState(dateFrom || '')
  const [customTo,    setCT]  = useState(dateTo   || '')
  const wrapRef = useRef()

  useEffect(() => {
    if (!open) return
    function h(e) { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  function applyPreset(p) {
    setLP(p)
    if (p !== 'custom') {
      const [f, t] = presetRange(p, ref_)
      onChange(f, t, p)
      setOpen(false)
    }
  }

  function applyCustom() {
    if (customFrom && customTo) {
      const f = customFrom <= customTo ? customFrom : customTo
      const t = customFrom <= customTo ? customTo   : customFrom
      onChange(f, t, 'custom')
      setOpen(false)
    }
  }

  const PRESETS = [
    { key: 'month',   label: 'This Month',   sub: presetRange('month',   ref_).map(fmtDate).join(' – ') },
    { key: 'quarter', label: 'This Quarter', sub: presetRange('quarter', ref_).map(fmtDate).join(' – ') },
    { key: 'year',    label: 'This Year',    sub: presetRange('year',    ref_).map(fmtDate).join(' – ') },
    { key: 'custom',  label: 'Custom Range', sub: 'Pick start & end date' },
  ]

  const displayLabel = presetLabel(preset, dateFrom, dateTo, ref_)
  const subLabel     = dateFrom && dateTo && (preset === 'month' || preset === 'quarter' || preset === 'year')
    ? `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
    : null

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          height: 44, padding: '0 16px',
          borderRadius: 10, border: '1px solid rgb(var(--border) / 0.18)',
          background: open ? 'rgb(var(--bg-subtle))' : 'rgb(var(--bg-surface))',
          cursor: 'pointer', outline: 'none', minWidth: 220,
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: '#0E2841', flexShrink: 0 }}>date_range</span>
        <div style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'rgb(var(--fg-1))', lineHeight: 1.3, letterSpacing: '-0.01em' }}>
            {displayLabel}
          </p>
          {subLabel && (
            <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginTop: 1, textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 500 }}>
              {subLabel}
            </p>
          )}
        </div>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'rgb(var(--fg-3))', flexShrink: 0 }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 60,
          background: 'rgb(var(--bg-surface))',
          border: '1px solid rgb(var(--border) / 0.12)',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
          width: 260, overflow: 'hidden',
        }}>
          <div style={{ padding: '6px 0' }}>
            {PRESETS.map(p => {
              const active   = preset === p.key
              const isCustom = p.key === 'custom'
              return (
                <div key={p.key}>
                  <button
                    onClick={() => applyPreset(p.key)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      width: '100%', padding: '9px 14px', cursor: 'pointer', textAlign: 'left',
                      background: active ? 'rgb(14 40 65 / 0.06)' : 'transparent',
                      borderLeft: active ? '3px solid #0E2841' : '3px solid transparent',
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgb(var(--bg-subtle))' }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 13, fontWeight: active ? 700 : 500, color: active ? '#0E2841' : 'rgb(var(--fg-1))' }}>
                        {p.label}
                      </p>
                      {!isCustom && (
                        <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.sub}
                        </p>
                      )}
                    </div>
                    {active && !isCustom && <span className="material-symbols-rounded" style={{ fontSize: 15, color: '#0E2841', flexShrink: 0, marginLeft: 8 }}>check</span>}
                    {isCustom && <span className="material-symbols-rounded" style={{ fontSize: 15, color: 'rgb(var(--fg-3))', flexShrink: 0, marginLeft: 8 }}>
                      {localPreset === 'custom' ? 'expand_less' : 'expand_more'}
                    </span>}
                  </button>

                  {isCustom && localPreset === 'custom' && (
                    <div style={{ padding: '4px 14px 12px', background: 'rgb(var(--bg-subtle))' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div>
                          <p style={{ fontSize: 10, fontWeight: 600, color: 'rgb(var(--fg-3))', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>From</p>
                          <input type="date" className="form-input" value={customFrom}
                            onChange={e => setCF(e.target.value)}
                            style={{ width: '100%', fontSize: 12, height: 32 }} />
                        </div>
                        <div>
                          <p style={{ fontSize: 10, fontWeight: 600, color: 'rgb(var(--fg-3))', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>To</p>
                          <input type="date" className="form-input" value={customTo}
                            onChange={e => setCT(e.target.value)}
                            style={{ width: '100%', fontSize: 12, height: 32 }} />
                        </div>
                        <button onClick={applyCustom} disabled={!customFrom || !customTo}
                          className="btn btn-primary gap-1.5 disabled:opacity-50"
                          style={{ width: '100%', height: 32, fontSize: 12, justifyContent: 'center', marginTop: 2 }}>
                          <span className="material-symbols-rounded text-[14px]">check</span>Apply
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {footer && (
            <div style={{ padding: '8px 14px', borderTop: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--bg-subtle))' }}>
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   FILTER CHIP + DROP ITEM
   ═══════════════════════════════════════════════════════════════ */

const CHIP_BASE = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  height: 34, padding: '0 12px', borderRadius: 8, border: '1px solid',
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  transition: 'all 0.12s', userSelect: 'none', outline: 'none',
}
export const CHIP_OFF = { ...CHIP_BASE, background: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg-2))',  borderColor: 'rgb(var(--border) / 0.2)' }
export const CHIP_ON  = { ...CHIP_BASE, background: '#0E2841',                color: '#fff',             borderColor: '#0E2841' }

export function DropItem({ label, selected, onClick, dot }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '8px 14px', fontSize: 13, textAlign: 'left',
        color: selected ? '#0E2841' : 'rgb(var(--fg-2))', fontWeight: selected ? 600 : 400,
        background: hov && !selected ? 'rgb(var(--bg-subtle))' : selected ? 'rgb(14 40 65 / 0.05)' : 'transparent',
        cursor: 'pointer', gap: 10,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />}
        {label}
      </div>
      {selected && <span className="material-symbols-rounded" style={{ fontSize: 14, color: '#0E2841' }}>check</span>}
    </button>
  )
}

export function FilterChip({ label, active, onClear, children, maxH = 260 }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    function h(e) { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={active ? CHIP_ON : CHIP_OFF} onClick={() => setOpen(v => !v)}>
        {label}
        {active
          ? <span className="material-symbols-rounded" style={{ fontSize: 14, lineHeight: 1, opacity: 0.75, marginLeft: 2 }}
              onClick={e => { e.stopPropagation(); onClear(); setOpen(false) }}>close</span>
          : <span className="material-symbols-rounded" style={{ fontSize: 14, lineHeight: 1, opacity: 0.4 }}>expand_more</span>}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 50,
          background: 'rgb(var(--bg-surface))', borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)', border: '1px solid rgb(var(--border) / 0.1)',
          minWidth: 190, overflow: 'hidden',
        }}>
          <div style={{ maxHeight: maxH, overflowY: 'auto', paddingTop: 4, paddingBottom: 4 }}>
            {children}
          </div>
        </div>
      )}
    </div>
  )
}
