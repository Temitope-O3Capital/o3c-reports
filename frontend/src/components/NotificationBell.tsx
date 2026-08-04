import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, API } from '../lib/api'
import { MONO, RED, BLUE, AMBER, GREEN } from '../lib/design'
import { IcoBell } from '../lib/icons'
import { announce, primeAudio, getSoundPref, setSoundPref, getVoiceMode, setVoiceMode, playChime, speak, currentVoiceName, type VoiceMode } from '../lib/notifyEffects'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Notification {
  id:          number
  type:        string
  severity?:   'red' | 'blue' | 'amber' | 'green'
  title:       string
  body:        string
  link?:       string
  action_url?: string   // backend field name
  read_at:     string | null
  created_at:  string
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
  const [soundOn, setSoundOn] = useState(getSoundPref())
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>(getVoiceMode())
  const panelRef = useRef<HTMLDivElement>(null)
  // Track ids we've already seen so realtime pushes only chime for genuinely-new
  // notifications (never on initial load, reconnect replays, or duplicates).
  const seenIds = useRef<Set<number>>(new Set())
  const primed = useRef(false)

  const load = useCallback(async () => {
    try {
      // Backend returns { notifications: [...], unread_count, total }.
      const data = await apiFetch<{ notifications?: Notification[]; items?: Notification[]; unread_count: number }>('/api/notifications', { silent: true })
      const list = data.notifications ?? data.items ?? []
      list.forEach(n => seenIds.current.add(n.id)) // baseline — don't chime for these
      setItems(list)
      setUnread(data.unread_count ?? 0)
    } catch {}
  }, [])

  useEffect(() => {
    load()
    // Polling kept as a safety net (also re-syncs the authoritative unread count).
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  // ── Real-time push via SSE ──────────────────────────────────────────────────
  // Opens an EventSource that streams notifications created after connect (~4s
  // latency). Reconnects with a fresh ticket if the stream drops or the ticket
  // expires. Polling above stays as a fallback and count reconciliation.
  useEffect(() => {
    let es: EventSource | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    async function connect() {
      if (closed) return
      try {
        const { ticket } = await apiFetch<{ ticket: string }>('/api/notifications/sse-ticket', { method: 'POST', silent: true })
        if (closed) return
        es = new EventSource(`${API}/api/notifications/sse?ticket=${encodeURIComponent(ticket)}`)
        es.onmessage = ev => {
          try {
            const n = JSON.parse(ev.data) as Notification
            if (!n || typeof n.id !== 'number') return
            if (seenIds.current.has(n.id)) return // duplicate / replay — ignore
            seenIds.current.add(n.id)
            setItems(prev => [n, ...prev].slice(0, 50))
            if (!n.read_at) setUnread(c => c + 1)
            announce(n.title) // chime + (opt-in) spoken title
          } catch { /* ignore keepalives / malformed frames */ }
        }
        es.onerror = () => {
          // The browser would auto-retry with the same (possibly expired) ticket;
          // close and reconnect manually so we mint a fresh ticket.
          es?.close(); es = null
          if (!closed && !retry) retry = setTimeout(() => { retry = null; connect() }, 5000)
        }
      } catch {
        if (!closed && !retry) retry = setTimeout(() => { retry = null; connect() }, 5000)
      }
    }

    connect()
    return () => { closed = true; es?.close(); if (retry) clearTimeout(retry) }
  }, [])

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
    const link = n.link ?? n.action_url
    if (link) navigate(link)
  }

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        onClick={() => { if (!primed.current) { primeAudio(); primed.current = true } setOpen(o => !o) }}
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
        <IcoBell size={16} />
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
                  background: SEVERITY_COLOR[n.severity ?? ''] ?? GREEN,
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

          {/* Sound / voice opt-in — per-user, saved on this device */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            padding: '10px 16px', borderTop: '1px solid var(--bdr)',
            background: 'var(--row-hvr)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => { const v = !soundOn; setSoundOn(v); setSoundPref(v); if (v) { primeAudio(); playChime() } }}
                title={`Chime: ${soundOn ? 'on' : 'off'}`}
                style={chipStyle(soundOn)}
              >
                <span style={{ fontSize: 13, opacity: soundOn ? 1 : 0.5 }}>🔔</span> Sound
                <span style={dotStyle(soundOn)} />
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt3)', fontFamily: "'Sora', sans-serif", marginRight: 2 }}>🗣️ Voice</span>
                {(['off', 'female', 'male'] as VoiceMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => {
                      setVoiceModeState(m); setVoiceMode(m)
                      if (m !== 'off') { primeAudio(); speak('You have a new notification', m) }
                    }}
                    title={m === 'off' ? 'Voice off' : `${m} voice — ${currentVoiceName(m)}`}
                    style={segStyle(voiceMode === m)}
                  >
                    {m === 'off' ? 'Off' : m === 'female' ? '♀ Female' : '♂ Male'}
                  </button>
                ))}
              </div>

              <button
                onClick={() => {
                  primeAudio()
                  if (soundOn) playChime()
                  const g: VoiceMode = voiceMode === 'off' ? 'female' : voiceMode
                  speak('This is a test alert from your O3 Capital Workspace.', g)
                }}
                title="Play a test alert with the current settings"
                style={{
                  marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
                  padding: '4px 12px', borderRadius: 999, cursor: 'pointer',
                  border: 'none', background: BLUE, color: '#fff',
                  fontSize: 11.5, fontWeight: 700, fontFamily: "'Sora', sans-serif",
                }}
              >
                ▶ Test
              </button>
            </div>
            <span style={{ fontSize: 10.5, color: 'var(--txt3)', fontFamily: MONO }}>
              Saved on this device · Nigerian voice on Edge/Chrome; falls back otherwise
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Toggle styles ─────────────────────────────────────────────────────────────

function chipStyle(on: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
    border: `1px solid ${on ? BLUE : 'var(--bdr)'}`,
    background: on ? `${BLUE}14` : 'var(--card)',
    color: on ? BLUE : 'var(--txt3)',
    fontSize: 12, fontWeight: 600, fontFamily: "'Sora', sans-serif",
    transition: 'all 120ms',
  }
}
function dotStyle(on: boolean): React.CSSProperties {
  return { width: 6, height: 6, borderRadius: '50%', background: on ? GREEN : 'var(--txt3)', marginLeft: 2 }
}
function segStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 9px', borderRadius: 7, cursor: 'pointer',
    border: `1px solid ${active ? BLUE : 'var(--bdr)'}`,
    background: active ? `${BLUE}14` : 'var(--card)',
    color: active ? BLUE : 'var(--txt3)',
    fontSize: 11.5, fontWeight: 600, fontFamily: "'Sora', sans-serif",
    transition: 'all 120ms',
  }
}
