import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { NAVY, TEXT, FW, RADIUS, SP } from '../lib/design'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  fullPagePath?: string
  children: React.ReactNode
}

export function Drawer({ open, onClose, title, fullPagePath, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const navigate  = useNavigate()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(14,40,65,0.45)',
          backdropFilter: 'blur(2px)',
          zIndex: 400,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 220ms ease',
        }}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(560px, 100vw)',
          background: 'var(--bg)',
          boxShadow: '-4px 0 32px rgba(0,0,0,0.18)',
          zIndex: 401,
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 240ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: SP[3],
          padding: `${SP[4]} ${SP[5]}`,
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            title="Close"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, borderRadius: RADIUS.lg,
              border: '1px solid var(--border)', background: 'var(--surface)',
              cursor: 'pointer', flexShrink: 0, color: 'var(--text-muted)',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>

          <span style={{
            fontSize: TEXT.base, fontWeight: FW.semibold,
            color: 'var(--text)', flex: 1, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {title}
          </span>

          {fullPagePath && (
            <button
              onClick={() => { onClose(); navigate(fullPagePath) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: TEXT.sm, fontWeight: FW.medium,
                color: NAVY, background: 'none', border: 'none',
                cursor: 'pointer', flexShrink: 0, padding: '4px 0',
              }}
            >
              Open full page
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_full</span>
            </button>
          )}
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: SP[5] }}>
          {open && children}
        </div>
      </div>
    </>
  )
}
