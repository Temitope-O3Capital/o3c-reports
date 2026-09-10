import { useEffect, useRef, useState, useCallback } from 'react'
import { Modal } from './UI'
import { API, apiFetch, apiPost, unwrap } from '../lib/api'
import { NAVY, RED, AMBER, TEXT, FW, RADIUS } from '../lib/design'

// Plays a call's Zoho Voice recording in-app. Recordings aren't stored in our DB — only
// the filename is — so the audio is fetched live from Zoho and cached locally on first
// play (and pre-warmed in the background for recent calls). The link to Zoho's audio
// host can be slow, so instead of hanging a bare <audio> element on a multi-minute
// fetch, the player first asks a cheap status endpoint whether the recording is ready,
// still downloading, or genuinely missing — and only mounts the <audio> once it's ready.
// A "downloading" state polls itself and plays automatically the moment it lands.
//
// Shared so the Call Log, the per-call detail modal, an agent's My Dashboard and the
// supervisor drawer all behave identically and can never drift apart.

type Phase = 'checking' | 'ready' | 'downloading' | 'missing' | 'unavailable'

export function RecordingPlayer({ callId, autoPlay = true }: { callId: number; autoPlay?: boolean }) {
  // ?v busts browsers/CDN that cached a truncated recording under the previous URL. Bump
  // this whenever the caching semantics change so every poisoned copy is abandoned at once.
  const audioSrc = `${API}/api/helpdesk/calls/${callId}/recording?v=3`
  const [phase, setPhase] = useState<Phase>('checking')
  const [message, setMessage] = useState('')
  const timer = useRef<number | null>(null)
  const alive = useRef(true)

  const fails = useRef(0)
  const check = useCallback(async () => {
    try {
      // The backend wraps this as { data: { status, message }, … } via respond(); apiFetch
      // returns the raw body and does NOT unwrap, so read the payload through unwrap() —
      // otherwise data.status is always undefined and the player reports "unavailable" for
      // every call regardless of the real state.
      const raw = await apiFetch(`/api/helpdesk/calls/${callId}/recording/status`)
      if (!alive.current) return
      fails.current = 0
      const data = unwrap<{ status?: Phase; message?: string }>(raw)
      const known: Phase[] = ['ready', 'downloading', 'missing', 'unavailable']
      const s: Phase = known.includes(data?.status as Phase) ? (data!.status as Phase) : 'unavailable'
      setPhase(s)
      setMessage(data?.message || '')
      // Keep polling while it warms in the background; it'll flip to "ready" on its own.
      if (s === 'downloading') timer.current = window.setTimeout(check, 6000)
    } catch {
      if (!alive.current) return
      // A single blip (a slow revalidation, a momentary network drop) shouldn't flip a
      // perfectly good recording to "unavailable" — that's the flicker where a call plays,
      // shows unavailable, then plays again. Retry a couple of times before giving up.
      fails.current += 1
      if (fails.current < 3) {
        timer.current = window.setTimeout(check, 1500)
        return
      }
      setPhase('unavailable')
      setMessage('The recording could not be reached. Please try again.')
    }
  }, [callId])

  useEffect(() => {
    alive.current = true
    setPhase('checking'); setMessage('')
    check()
    return () => { alive.current = false; if (timer.current) window.clearTimeout(timer.current) }
  }, [check])

  const retry = () => { if (timer.current) window.clearTimeout(timer.current); setPhase('checking'); check() }

  // Force a live pull from Zoho for THIS call — attaches the recording filename if the
  // 60s sync hasn't yet, then warms the cache. Lets an agent grab a recording that isn't
  // showing instead of waiting on the auto-sync (or being stuck with no option at all).
  const [fetching, setFetching] = useState(false)
  const fetchLive = async () => {
    if (timer.current) window.clearTimeout(timer.current)
    setFetching(true); setPhase('checking'); setMessage('Pulling the recording from Zoho…')
    try { await apiPost(`/api/helpdesk/calls/${callId}/fetch-recording`, {}) } catch { /* status re-check reports the outcome */ }
    setFetching(false)
    check()
  }

  if (phase === 'ready') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls autoPlay={autoPlay} preload={autoPlay ? 'auto' : 'none'} src={audioSrc} style={{ width: '100%' }} />
        <a href={audioSrc} download={`recording-${callId}.wav`}
          style={{ fontSize: TEXT.xs, color: NAVY, fontWeight: FW.semibold, textDecoration: 'none', alignSelf: 'flex-end' }}>
          Download
        </a>
      </div>
    )
  }

  const tone = phase === 'downloading' ? AMBER : phase === 'checking' ? NAVY : RED
  const icon = phase === 'downloading' ? 'cloud_download' : phase === 'checking' ? 'hourglass_top' : phase === 'missing' ? 'voice_over_off' : 'error'
  const title = phase === 'downloading' ? 'Fetching recording…' : phase === 'checking' ? 'Checking recording…' : phase === 'missing' ? 'No recording' : 'Recording unavailable'
  const fallback = phase === 'missing'
    ? 'No recording is stored for this call.'
    : phase === 'checking' ? '' : 'The recording service is slow right now. Please try again in a moment.'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: RADIUS.md, background: `${tone}0F`, border: `1px solid ${tone}33` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: tone, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{icon}</span>
        {title}
      </div>
      {(message || fallback) && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>{message || fallback}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {phase !== 'missing' && phase !== 'checking' && (
          <button onClick={retry}
            style={{ padding: '6px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>refresh</span>
            {phase === 'downloading' ? 'Check now' : 'Retry'}
          </button>
        )}
        {/* Force a live pull from Zoho — the "pull it now" provision for a recording that
            hasn't auto-appeared. Offered on both the no-recording and unavailable states. */}
        {(phase === 'missing' || phase === 'unavailable') && (
          <button onClick={fetchLive} disabled={fetching}
            style={{ padding: '6px 12px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: fetching ? 'wait' : 'pointer', opacity: fetching ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>cloud_sync</span>
            {fetching ? 'Fetching…' : 'Fetch from Zoho'}
          </button>
        )}
      </div>
    </div>
  )
}

// A small modal wrapper around the player. Pass a callId to open it; null keeps it closed.
export function RecordingModal({ callId, title, subtitle, onClose }: {
  callId: number | null; title?: string; subtitle?: string; onClose: () => void
}) {
  if (callId == null) return null
  return (
    <Modal open onClose={onClose} title={title ?? 'Recording'} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
        {subtitle && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{subtitle}</div>}
        <RecordingPlayer callId={callId} />
      </div>
    </Modal>
  )
}
