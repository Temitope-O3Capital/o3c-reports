import { useState, useRef, useEffect } from 'react'
import { MERGE_FIELDS } from '../lib/personalize'
import { TEXT, FW, RADIUS } from '../lib/design'

// A compact "Personalize" dropdown that inserts a {{merge_tag}} at the caret of
// the field it's attached to. Clicking a field inserts {{key}}; the small chip
// inserts {{key|fallback}} so blanks degrade gracefully.
export default function PersonalizeMenu({
  onPick,
  label = 'Personalize',
  align = 'left',
}: {
  onPick: (token: string) => void
  label?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onMouseDown={e => e.preventDefault()}
        onClick={() => setOpen(o => !o)}
        title="Insert a personalization field"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px',
          borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)',
          color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>alternate_email</span>
        {label}
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{open ? 'expand_less' : 'expand_more'}</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', zIndex: 50,
            [align]: 0, width: 250, maxHeight: 300, overflowY: 'auto',
            background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
            boxShadow: '0 12px 32px rgba(0,0,0,0.18)', padding: 5,
          } as React.CSSProperties}
        >
          <div style={{ fontSize: 10, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.08em', padding: '6px 8px 4px' }}>
            Insert field
          </div>
          {MERGE_FIELDS.map(f => (
            <div
              key={f.key}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <button
                type="button" onMouseDown={e => e.preventDefault()}
                onClick={() => { onPick(`{{${f.key}}}`); setOpen(false) }}
                style={{ flex: 1, textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
              >
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)' }}>{f.label}</div>
                <div style={{ fontSize: 10.5, fontFamily: 'monospace', color: 'var(--txt3)' }}>{`{{${f.key}}}`}</div>
              </button>
              {f.fallback && (
                <button
                  type="button" onMouseDown={e => e.preventDefault()}
                  title={`Insert with fallback "${f.fallback}"`}
                  onClick={() => { onPick(`{{${f.key}|${f.fallback}}}`); setOpen(false) }}
                  style={{ fontSize: 10, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'var(--chip-bg)', border: 'none', borderRadius: RADIUS.full, padding: '2px 8px', cursor: 'pointer', flexShrink: 0 }}
                >
                  +fallback
                </button>
              )}
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: 'var(--txt3)', padding: '6px 8px', borderTop: '1px solid var(--bdr)', marginTop: 4, lineHeight: 1.4 }}>
            Fallback shows when the field is blank, e.g. <span style={{ fontFamily: 'monospace' }}>{'{{first_name|there}}'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
