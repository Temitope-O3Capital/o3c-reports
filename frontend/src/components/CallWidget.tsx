import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { NAVY, RED, GREEN, INTER } from '../lib/design'
import type { AuthUser } from '../hooks/useAuth'

// ── Constants ─────────────────────────────────────────────────────────────────

const CALL_ROLES = new Set(['call_center_agent', 'call_center_head', 'admin', 'super_admin'])

type CallState = 'idle' | 'dialing' | 'active' | 'incoming' | 'ended'

interface IncomingCall { phone: string; ticketId: number }

const PAD_KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#']

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2,'0')}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CallWidget({ user }: { user: AuthUser }) {
  if (!CALL_ROLES.has(user.role as string)) return null

  const navigate = useNavigate()
  const [expanded,        setExpanded]        = useState(false)
  const [dialNum,         setDialNum]         = useState('')
  const [callState,       setCallState]       = useState<CallState>('idle')
  const [incoming,        setIncoming]        = useState<IncomingCall | null>(null)
  const [activePhone,     setActivePhone]     = useState('')
  const [activeTicketId,  setActiveTicketId]  = useState<number | null>(null)
  const [elapsed,         setElapsed]         = useState(0)
  const [muted,           setMuted]           = useState(false)
  const [voiceConnected,  setVoiceConnected]  = useState(false)
  const [dialing,         setDialing]         = useState(false)
  const [error,           setError]           = useState('')

  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef     = useRef<EventSource | null>(null)
  const cleanupRef = useRef(false)

  // ── Voice status ─────────────────────────────────────────────────────────

  useEffect(() => {
    apiFetch<{ connected: boolean }>('/api/voice/status', { silent: true })
      .then(d => setVoiceConnected(d.connected ?? false))
      .catch(() => {})
  }, [])

  // ── SSE — inbound call listener ──────────────────────────────────────────

  const connectSSE = useCallback(async () => {
    if (cleanupRef.current) return
    try {
      // Use raw fetch so a 401 here never triggers the global signOut/session-expired flow.
      const base = (import.meta.env.VITE_API_URL as string) ?? ''
      const res = await fetch(`${base}/api/notifications/sse-ticket`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': document.cookie.match(/(?:^|;\s*)o3c_csrf=([^;]+)/)?.[1] ?? '',
        },
      })
      if (!res.ok || cleanupRef.current) {
        // 401 or server error — retry silently without signing the user out
        if (!cleanupRef.current) setTimeout(connectSSE, 15000)
        return
      }
      const { ticket } = await res.json() as { ticket: string }
      if (!ticket || cleanupRef.current) return

      const es = new EventSource(`${base}/api/notifications/sse?ticket=${encodeURIComponent(ticket)}`)
      esRef.current = es

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data as string) as Record<string, unknown>
          if (data.type === 'inbound_call') {
            const rawBody = (data.body as string) ?? ''
            const phone = rawBody.startsWith('Caller: ')
              ? rawBody.slice('Caller: '.length)
              : rawBody || 'Unknown'
            const ticketId = typeof data.entity_id === 'number' ? data.entity_id : 0
            setIncoming({ phone, ticketId })
            setCallState('incoming')
            setExpanded(true)
          }
        } catch {}
      }

      es.onerror = () => {
        es.close()
        esRef.current = null
        if (!cleanupRef.current) setTimeout(connectSSE, 6000)
      }
    } catch {
      if (!cleanupRef.current) setTimeout(connectSSE, 12000)
    }
  }, [])

  useEffect(() => {
    cleanupRef.current = false
    connectSSE()
    return () => {
      cleanupRef.current = true
      esRef.current?.close()
    }
  }, [connectSSE])

  // ── Call timer ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (callState === 'active') {
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [callState])

  // ── Actions ──────────────────────────────────────────────────────────────

  async function dial() {
    const num = dialNum.trim()
    if (!num) return
    setDialing(true)
    setError('')
    try {
      await apiFetch('/api/zoho/voice/call', {
        method: 'POST',
        body: JSON.stringify({ phone_number: num }),
      } as RequestInit)
      setActivePhone(num)
      setActiveTicketId(null)
      setCallState('active')
      setMuted(false)
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Call failed')
    } finally {
      setDialing(false)
    }
  }

  function answerIncoming() {
    if (!incoming) return
    setActivePhone(incoming.phone)
    setActiveTicketId(incoming.ticketId || null)
    setIncoming(null)
    setCallState('active')
    setMuted(false)
  }

  function declineIncoming() {
    setIncoming(null)
    setCallState('idle')
  }

  function endCall() {
    setCallState('ended')
    setTimeout(() => {
      setCallState('idle')
      setActivePhone('')
      setActiveTicketId(null)
      setDialNum('')
      setMuted(false)
    }, 1800)
  }

  function pressKey(k: string) {
    setDialNum(n => n + k)
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const isIncoming = callState === 'incoming'
  const isActive   = callState === 'active'
  const isEnded    = callState === 'ended'

  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9100, fontFamily: INTER }}>

      {/* Incoming call panel — always visible when ringing */}
      {isIncoming && incoming && (
        <div style={{
          position: 'absolute', bottom: 62, right: 0,
          width: 290, background: NAVY,
          borderRadius: 16, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
          border: '1px solid rgba(255,255,255,0.12)',
        }}>
          {/* Pulse ring */}
          <div style={{
            padding: '22px 20px 18px', textAlign: 'center',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
              <div style={{
                position: 'absolute', width: 56, height: 56, borderRadius: '50%',
                background: `${GREEN}30`,
                animation: 'callPulse 1.4s ease-out infinite',
              }} />
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: GREEN, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 22, color: '#fff' }}>call</span>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
              Incoming call
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>
              {incoming.phone}
            </div>
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: 0 }}>
            <button
              onClick={declineIncoming}
              style={{
                flex: 1, padding: '13px 0', border: 'none', cursor: 'pointer',
                background: 'transparent', color: RED, fontSize: 13, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                borderRight: '1px solid rgba(255,255,255,0.1)',
                transition: 'background 120ms',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(192,0,0,0.15)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>call_end</span>
              Decline
            </button>
            <button
              onClick={answerIncoming}
              style={{
                flex: 1, padding: '13px 0', border: 'none', cursor: 'pointer',
                background: 'transparent', color: GREEN, fontSize: 13, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                transition: 'background 120ms',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(22,163,74,0.15)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>call</span>
              Answer
            </button>
          </div>
        </div>
      )}

      {/* Active call panel */}
      {(isActive || isEnded) && expanded && (
        <div style={{
          position: 'absolute', bottom: 62, right: 0,
          width: 270, background: NAVY,
          borderRadius: 16, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
          border: '1px solid rgba(255,255,255,0.12)',
        }}>
          <div style={{ padding: '18px 18px 14px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: isEnded ? 'rgba(255,255,255,0.3)' : GREEN,
              }} />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
                {isEnded ? 'Call ended' : fmtElapsed(elapsed)}
              </span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>{activePhone}</div>
            {activeTicketId ? (
              <button
                onClick={() => navigate(`/helpdesk/tickets/${activeTicketId}`)}
                style={{
                  marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.5)',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  textDecoration: 'underline',
                }}
              >
                View ticket #{activeTicketId}
              </button>
            ) : null}
          </div>

          {/* Controls */}
          {isActive && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '12px 18px' }}>
              <button
                onClick={() => setMuted(m => !m)}
                title={muted ? 'Unmute' : 'Mute'}
                style={{
                  width: 40, height: 40, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: muted ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.09)',
                  color: muted ? '#fff' : 'rgba(255,255,255,0.65)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 120ms',
                }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
                  {muted ? 'mic_off' : 'mic'}
                </span>
              </button>

              <button
                onClick={endCall}
                title="End call"
                style={{
                  width: 48, height: 48, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: RED, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: `0 4px 16px ${RED}60`,
                  transition: 'opacity 120ms',
                }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 22 }}>call_end</span>
              </button>

              {activeTicketId ? (
                <button
                  onClick={() => navigate(`/helpdesk/tickets/${activeTicketId}`)}
                  title="View ticket"
                  style={{
                    width: 40, height: 40, borderRadius: '50%', border: 'none', cursor: 'pointer',
                    background: 'rgba(255,255,255,0.09)',
                    color: 'rgba(255,255,255,0.65)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background 120ms',
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
                </button>
              ) : (
                <div style={{ width: 40 }} />
              )}
            </div>
          )}
        </div>
      )}

      {/* Dial pad panel */}
      {expanded && callState === 'idle' && (
        <div style={{
          position: 'absolute', bottom: 62, right: 0,
          width: 260, background: NAVY,
          borderRadius: 16, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
          border: '1px solid rgba(255,255,255,0.12)',
        }}>
          {/* Number display */}
          <div style={{
            padding: '16px 16px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="tel"
                value={dialNum}
                onChange={e => setDialNum(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') dial() }}
                placeholder="+234..."
                style={{
                  flex: 1, background: 'transparent', border: 'none', outline: 'none',
                  fontSize: 18, fontWeight: 700, color: '#fff',
                  fontFamily: INTER, letterSpacing: '0.04em',
                }}
              />
              {dialNum && (
                <button
                  onClick={() => setDialNum(n => n.slice(0, -1))}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(255,255,255,0.45)', padding: 4,
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>backspace</span>
                </button>
              )}
            </div>

            {/* Voice connection status */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: voiceConnected ? GREEN : 'rgba(255,255,255,0.25)',
              }} />
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em' }}>
                {voiceConnected ? 'Voice connected' : 'Voice not connected'}
              </span>
              {!voiceConnected && (
                <button
                  onClick={() => navigate('/settings')}
                  style={{
                    fontSize: 10.5, color: 'rgba(255,255,255,0.55)', background: 'none',
                    border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
                    fontFamily: INTER,
                  }}
                >
                  Connect
                </button>
              )}
            </div>
          </div>

          {/* Keypad */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 1, background: 'rgba(255,255,255,0.06)',
          }}>
            {PAD_KEYS.map(k => (
              <button
                key={k}
                onClick={() => pressKey(k)}
                style={{
                  padding: '13px 0', border: 'none', cursor: 'pointer',
                  background: NAVY, color: '#fff',
                  fontSize: 17, fontWeight: k === '*' || k === '#' ? 400 : 600,
                  fontFamily: INTER,
                  transition: 'background 80ms',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = NAVY }}
              >
                {k}
              </button>
            ))}
          </div>

          {/* Dial button */}
          <div style={{ padding: '12px 20px 14px' }}>
            {error && (
              <div style={{ fontSize: 11, color: '#FF8080', marginBottom: 8, textAlign: 'center' }}>{error}</div>
            )}
            <button
              onClick={dial}
              disabled={!dialNum.trim() || dialing}
              style={{
                width: '100%', padding: '11px 0', borderRadius: 10, border: 'none',
                background: !dialNum.trim() || dialing ? 'rgba(22,163,74,0.4)' : GREEN,
                color: '#fff', fontSize: 14, fontWeight: 600,
                cursor: !dialNum.trim() || dialing ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'background 120ms',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>call</span>
              {dialing ? 'Dialling…' : 'Dial'}
            </button>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => {
          if (isIncoming) return  // incoming alert stays until actioned
          setExpanded(e => !e)
        }}
        title={expanded ? 'Close phone' : 'Open phone'}
        style={{
          width: 48, height: 48, borderRadius: '50%',
          border: 'none', cursor: isIncoming ? 'default' : 'pointer',
          background: isIncoming ? GREEN : (isActive || isEnded) ? GREEN : NAVY,
          color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: isIncoming
            ? `0 0 0 4px ${GREEN}40, 0 4px 20px rgba(0,0,0,0.35)`
            : '0 4px 20px rgba(0,0,0,0.35)',
          transition: 'box-shadow 200ms, background 200ms',
          animation: isIncoming ? 'ringShake 0.5s ease-in-out infinite' : 'none',
          position: 'relative',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 22 }}>
          {isActive || isEnded ? 'call' : 'phone_in_talk'}
        </span>
        {/* Voice connected dot */}
        {voiceConnected && !isActive && !isIncoming && !isEnded && (
          <span style={{
            position: 'absolute', top: 3, right: 3,
            width: 9, height: 9, borderRadius: '50%',
            background: GREEN, border: '2px solid ' + NAVY,
          }} />
        )}
      </button>

      {/* Keyframe animations */}
      <style>{`
        @keyframes callPulse {
          0%   { transform: scale(1);   opacity: 0.8; }
          70%  { transform: scale(1.8); opacity: 0; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes ringShake {
          0%, 100% { transform: rotate(0deg); }
          20%       { transform: rotate(-12deg); }
          40%       { transform: rotate(12deg); }
          60%       { transform: rotate(-8deg); }
          80%       { transform: rotate(8deg); }
        }
      `}</style>
    </div>
  )
}
