import { useEffect, useMemo, useRef, useState } from 'react'
import { NAVY, GREEN, AMBER } from '../lib/design'
import { COMPANIONS, DEFAULT_COMPANION, type CompanionLook } from '../lib/companions'

/**
 * Companion — the assistant's face.
 *
 * Why a drawn character rather than a rendered human: the model runs on CPU with
 * no GPU, so real-time lip-synced video is not available at any quality worth
 * showing. A flat illustration that reads clearly at 26px in the panel header is
 * worth more than a photoreal face that stutters, and it never lands in the
 * uncanny valley on the way.
 *
 * The states are not decoration. A turn on this hardware takes around 23 seconds,
 * and the single most useful thing the interface can do in that window is say
 * which of four quite different things is happening:
 *
 *   listening  the microphone is open and we are capturing
 *   thinking   the question is with the model, nothing to show yet
 *   speaking   words are arriving, or audio is playing
 *   offline    the service is not running; nothing you type will go anywhere
 *
 * Every animation is suppressed under prefers-reduced-motion, which this codebase
 * already honours elsewhere. The face still changes between states when motion is
 * off — it simply stops moving within them, so the state is never conveyed by
 * animation alone.
 */

export type CompanionState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'offline'

const EYE = '#17110D'
const BG_IDLE = '#E8EDF2'

/**
 * The two silhouettes.
 *
 * The faces are identical geometry, so the OUTLINE is the only thing telling the
 * characters apart — and it has to do that at 22px in a toolbar, where features
 * are three or four pixels across and effectively invisible. A first attempt put
 * detail inside the head; at size it read as a smudge, and the two were
 * indistinguishable. These work the other way round: the shape OUTSIDE the face
 * does the identifying.
 *
 * Drawn in two parts because hair sits both behind the head and on the forehead,
 * and one path cannot be on both sides of the face.
 */
const HAIR_BACK: Record<CompanionLook['hairStyle'], string> = {
  // A full afro: one continuous shape, six pixels proud of the face on every side.
  //
  // An earlier version added two braids falling beside the ears. Rendered, that is
  // a headset — a pair of vertical bars flanking a head at ear height reads as
  // headphones to everyone, every time, and no amount of colour fixes it. The halo
  // alone separates the two characters perfectly well.
  afro: 'M12 26a20 18 0 1 1 40 0 20 18 0 1 1-40 0z',
  // A close fade, barely proud of the skull, so the head keeps a clean round
  // outline. Beside the afro the difference is obvious even at 22px.
  fade: 'M16.4 27a15.6 14.5 0 1 1 31.2 0 15.6 14.5 0 1 1-31.2 0z',
}

const HAIR_FRONT: Record<CompanionLook['hairStyle'], string> = {
  // A soft, slightly peaked hairline.
  afro: 'M18.8 28.4c1.4-6.6 6.6-10.2 13.2-10.2s11.8 3.6 13.2 10.2c-2.8-4.2-7.6-6.2-13.2-6.2s-10.4 2-13.2 6.2z',
  // A straight, sharp hairline, which is what a fade actually looks like.
  fade: 'M19.6 26.2c0-5.4 5.6-8.6 12.4-8.6s12.4 3.2 12.4 8.6c-2.6-2.6-7.2-3.8-12.4-3.8s-9.8 1.2-12.4 3.8z',
}

const STATE_RING: Record<CompanionState, string> = {
  idle: 'transparent',
  listening: GREEN,
  thinking: AMBER,
  speaking: NAVY,
  offline: 'var(--bdr)',
}

/** Injected once. Scoped by the o3c-cmp- prefix so it cannot leak into the app. */
const CSS = `
@keyframes o3c-cmp-blink { 0%,92%,100%{transform:scaleY(1)} 95%,97%{transform:scaleY(.08)} }
@keyframes o3c-cmp-float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-1.1px)} }
@keyframes o3c-cmp-talk  { 0%,100%{transform:scaleY(.45)} 50%{transform:scaleY(1.5)} }
@keyframes o3c-cmp-look  { 0%,100%{transform:translateX(0)} 30%{transform:translateX(1.6px)} 65%{transform:translateX(-1.4px)} }
@keyframes o3c-cmp-pulse { 0%{opacity:.55;transform:scale(1)} 70%{opacity:0;transform:scale(1.28)} 100%{opacity:0;transform:scale(1.28)} }
@keyframes o3c-cmp-brow  { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-1.3px)} }

.o3c-cmp-eyes   { transform-origin: center; animation: o3c-cmp-blink 5.2s infinite }
.o3c-cmp-head   { transform-origin: center; animation: o3c-cmp-float 4.4s ease-in-out infinite }
.o3c-cmp-mouth  { transform-origin: center; transform-box: fill-box }
.o3c-cmp-talking .o3c-cmp-mouth { animation: o3c-cmp-talk .32s ease-in-out infinite }
.o3c-cmp-thinking .o3c-cmp-pupils { animation: o3c-cmp-look 2.6s ease-in-out infinite }
.o3c-cmp-thinking .o3c-cmp-brows  { animation: o3c-cmp-brow 2.6s ease-in-out infinite }
.o3c-cmp-ring   { transform-origin: center; transform-box: fill-box }
.o3c-cmp-listening .o3c-cmp-ring { animation: o3c-cmp-pulse 1.5s ease-out infinite }

@media (prefers-reduced-motion: reduce) {
  .o3c-cmp-eyes, .o3c-cmp-head, .o3c-cmp-mouth,
  .o3c-cmp-talking .o3c-cmp-mouth,
  .o3c-cmp-thinking .o3c-cmp-pupils,
  .o3c-cmp-thinking .o3c-cmp-brows,
  .o3c-cmp-listening .o3c-cmp-ring { animation: none !important }
}
`

let injected = false
function useCompanionStyles() {
  useEffect(() => {
    if (injected || typeof document === 'undefined') return
    const el = document.createElement('style')
    el.setAttribute('data-o3c-companion', '')
    el.textContent = CSS
    document.head.appendChild(el)
    injected = true
  }, [])
}

export function CompanionAvatar({
  state = 'idle',
  size = 26,
  level,
  title,
  look,
}: {
  state?: CompanionState
  size?: number
  /** Which character to draw. Defaults to Ada so existing call sites keep working. */
  look?: CompanionLook
  /**
   * 0..1 audio amplitude. When speech is playing we drive the mouth from the real
   * waveform rather than a fixed loop — it is not true lip-sync, but a mouth that
   * moves with the voice reads as speech, and one that loops regardless does not.
   */
  level?: number
  title?: string
}) {
  useCompanionStyles()

  const L = look ?? COMPANIONS[DEFAULT_COMPANION].look
  const talking = state === 'speaking'
  const driven = talking && typeof level === 'number'
  // Floor it: a mouth that shuts completely between syllables looks like a glitch.
  const mouthScale = driven ? 0.35 + Math.min(1, Math.max(0, level!)) * 1.5 : 1

  const cls = [
    'o3c-cmp',
    talking && !driven ? 'o3c-cmp-talking' : '',
    state === 'thinking' ? 'o3c-cmp-thinking' : '',
    state === 'listening' ? 'o3c-cmp-listening' : '',
  ].filter(Boolean).join(' ')

  const off = state === 'offline'
  const ring = STATE_RING[state]

  return (
    <svg
      className={cls}
      width={size} height={size} viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? `Assistant ${state}`}
      style={{ display: 'block', opacity: off ? 0.45 : 1, filter: off ? 'grayscale(1)' : undefined }}
    >
      {/* state ring — the pulse when listening, a static edge otherwise */}
      {ring !== 'transparent' && (
        <circle className="o3c-cmp-ring" cx="32" cy="32" r="30.5" fill="none" stroke={ring} strokeWidth="2.5" />
      )}
      <circle cx="32" cy="32" r="28" fill={BG_IDLE} />

      <g className="o3c-cmp-head">
        {/* hair behind the head first, so the face overlaps it rather than the
            other way round */}
        <path d={HAIR_BACK[L.hairStyle]} fill={L.hair} />
        {/* neck and shoulders, so the head is not floating in the circle */}
        <path d="M22 54c0-5 4.5-8 10-8s10 3 10 8v6H22z" fill={L.skinShade} />
        {/* face */}
        <ellipse cx="32" cy="31" rx="14.4" ry="16.6" fill={L.skin} />
        <path d={HAIR_FRONT[L.hairStyle]} fill={L.hair} />

        <g className="o3c-cmp-brows">
          <rect x="22.5" y="26.2" width="7" height="1.7" rx=".85" fill={L.hair} />
          <rect x="34.5" y="26.2" width="7" height="1.7" rx=".85" fill={L.hair} />
        </g>

        {/* A single small stud. The afro alone leaves the character reading as
            nobody in particular, and this is one shape rather than a pile of
            cues — no lashes, no colour change, nothing that has to be argued
            about. Femi has none, so it is also the second thing separating them. */}
        {L.earring && (
          <>
            <circle cx="18.2" cy="38.4" r="1.5" fill={L.earring} />
            <circle cx="45.8" cy="38.4" r="1.5" fill={L.earring} />
          </>
        )}

        <g className="o3c-cmp-eyes">
          {off ? (
            <>
              <rect x="22.8" y="31.4" width="6.4" height="1.6" rx=".8" fill={EYE} />
              <rect x="34.8" y="31.4" width="6.4" height="1.6" rx=".8" fill={EYE} />
            </>
          ) : (
            <g className="o3c-cmp-pupils">
              <ellipse cx="26" cy="32" rx="2.5" ry="2.9" fill={EYE} />
              <ellipse cx="38" cy="32" rx="2.5" ry="2.9" fill={EYE} />
              <circle cx="26.9" cy="31" r=".85" fill="#fff" opacity=".9" />
              <circle cx="38.9" cy="31" r=".85" fill="#fff" opacity=".9" />
            </g>
          )}
        </g>

        {/* mouth — scaled by the voice when we have it, by a loop when we do not */}
        <rect
          className="o3c-cmp-mouth"
          x="28" y="39.5" width="8" height="3.2" rx="1.6"
          fill={L.lip}
          style={driven ? { transform: `scaleY(${mouthScale})` } : undefined}
        />
      </g>

      {/* No thinking dots. They were drawn across the shoulders and read as shirt
          buttons, and the panel already prints what it is doing in words next to
          the name — the amber ring is enough of a second signal. */}
    </svg>
  )
}

/**
 * Reads the output level of a playing audio element, so the mouth can follow the
 * actual voice. Returns 0 when nothing is playing.
 *
 * One AudioContext per page, created lazily on first use: browsers refuse to start
 * one before a user gesture, and the assistant is only ever opened by a click.
 */
export function useAudioLevel(audio: HTMLAudioElement | null, active: boolean) {
  const [level, setLevel] = useState(0)
  const raf = useRef<number | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const srcRef = useRef<MediaElementAudioSourceNode | null>(null)

  useEffect(() => {
    if (!audio || !active) { setLevel(0); return }

    let cancelled = false
    try {
      if (!ctxRef.current) ctxRef.current = new AudioContext()
      const ctx = ctxRef.current
      if (ctx.state === 'suspended') void ctx.resume()

      // createMediaElementSource throws if called twice for the same element, so
      // the node is created once and reused for the life of the component.
      if (!srcRef.current) {
        srcRef.current = ctx.createMediaElementSource(audio)
        analyserRef.current = ctx.createAnalyser()
        analyserRef.current.fftSize = 256
        srcRef.current.connect(analyserRef.current)
        analyserRef.current.connect(ctx.destination)
      }
    } catch {
      // No Web Audio, or the element is cross-origin. The mouth falls back to the
      // looped animation, which is the whole reason that fallback exists.
      return
    }

    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Uint8Array(analyser.frequencyBinCount)

    const tick = () => {
      if (cancelled) return
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128))
      // /48 rather than /128: speech rarely approaches full scale, and a mouth
      // that only twitches is worse than one that overshoots a little.
      setLevel(Math.min(1, peak / 48))
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      if (raf.current) cancelAnimationFrame(raf.current)
      setLevel(0)
    }
  }, [audio, active])

  return level
}

/**
 * Works out what the face should be doing from the panel's existing state. Kept
 * here so the rule lives in one place rather than being re-derived at each call
 * site, and so it can be unit tested without rendering anything.
 */
export function companionState(opts: {
  online: boolean | null
  busy: boolean
  listening?: boolean
  streaming?: boolean
  speaking?: boolean
}): CompanionState {
  if (opts.online === false) return 'offline'
  if (opts.listening) return 'listening'
  // Audio playback wins over streaming text: if it is talking out loud, that is
  // plainly what it is doing.
  if (opts.speaking) return 'speaking'
  if (opts.streaming) return 'speaking'
  if (opts.busy) return 'thinking'
  return 'idle'
}

export function useCompanionGreeting(name: string) {
  return useMemo(() => {
    const h = new Date().getHours()
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
    return `${part}. ${name} here — ask me anything about the workspace.`
  }, [name])
}
