import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { MONO, RED, BLUE, AMBER, GREEN } from '../lib/design'
import { IcoBell } from '../lib/icons'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Notification {
  id:         number
  type:       string
  severity:   'red' | 'blue' | 'amber' | 'green'
  title:      string
  body:       string
  link:       string
  read_at:    string | null
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<string, string> = {
  red: RED, blue: BLUE, amber: AMBER, green: GREEN,
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffH = Math.floor(diffMs / 3_600_000)
    if (diffH < 1)  return `${Math.max(1, Math.floor(diffMs / 60_000))}m ago`
    if (diffH < 24) return `${diffH}h ago`
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  } catch { return '' }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NotificationBell() {
  const navigate = useNavigate()
  const [open,   setOpen]   = useState(false)
  const [items,  setItems]  = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ items: Notification[]; unread_count: number }>('/api/notifications', { silent: true })
      setItems(data.items ?? [])
      setUnread(data.unread_count ?? 0)
    } catch {}
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function markAllRead() {
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST' })
      setItems(prev => prev.map(i => ({ ...i, read_at: i.read_at ?? new Date().toISOString() })))
      setUnread(0)
    } catch {}
  }

  function handleClick(n: Notification) {
    if (!n.read_at) {
      setItems(prev => prev.map(i => i.id === n.id ? { ...i, read_at: new Date().toISOString() } : i))
      setUnread(c => Math.max(0, c - 1))
    }
    setOpen(false)
    if (n.link) navigate(n.link)
  }

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Notifications"
        style={{
          position: 'relative', width: 34, height: 34,
          borderRadius: 5, border: '1px solid var(--bdr)', background: 'var(--card)',
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--txt2)',
          transition: 'border-color .12s, color .12s',
        }}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--txt3)'; el.style.color = 'var(--txt)'
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--bdr)'; el.style.color = 'var(--txt2)'
        }}
      >
        <IcoBell width={16} height={16} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5,
            minWidth: 16, height: 16, borderRadius: 8,
            background: RED, color: '#fff',
            fontSize: 9.5, fontWeight: 600, fontFamily: MONO,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
          }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0,
          width: 340, background: 'var(--card)',
          border: '1px solid var(--bdr)', borderRadius: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          zIndex: 9500, overflow: 'hidden',
        }}>
          {/* Panel header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderBottom: '1px solid var(--bdr)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', fontFamily: "'Sora', sans-serif" }}>
              Notifications
            </span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  fontSize: 12, color: BLUE, border: 'none', background: 'none',
                  cursor: 'pointer', fontFamily: "'Sora', sans-serif", padding: 0, fontWeight: 500,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Items */}
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--txt3)', fontSize: 13 }}>
                No notifications
              </div>
            ) : items.map(n => (
              <div
                key={n.id}
                onClick={() => handleClick(n)}
                style={{
                  display: 'flex', gap: 12, padding: '12px 16px',
                  cursor: 'pointer',
                  background: n.read_at ? 'transparent' : `${BLUE}0A`,
                  borderBottom: '1px solid var(--bdr)',
                  transition: 'background 120ms',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = n.read_at ? 'transparent' : `${BLUE}0A` }}
              >
                {/* Severity dot */}
                <div style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 5,
                  background: SEVERITY_COLOR[n.severity] ?? GREEN,
                }} />
                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 600, color: 'var(--txt)',
                    marginBottom: 3, fontFamily: "'Sora', sans-serif",
                    lineHeight: 1.35,
                  }}>
                    {n.title}
                  </div>
                  <div style={{
                    fontSize: 11.5, color: 'var(--txt2)', lineHeight: 1.4,
                    marginBottom: 5,
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}>
                    {n.body}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--txt3)', fontFamily: MONO }}>
                    {fmtTime(n.created_at)}
                  </div>
                </div>
                {/* Unread dot */}
                {!n.read_at && (
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: BLUE, flexShrink: 0, marginTop: 7,
                  }} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
