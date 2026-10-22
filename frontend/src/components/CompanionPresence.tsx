import { useCallback, useEffect, useRef, useState } from 'react'
import { CompanionAvatar } from './Companion'
import { introDue, markIntroShown, personaOf, readCompanion, roamEnabled } from '../lib/companions'
import { NAVY, TEXT, FW } from '../lib/design'

/**
 * The companion appearing outside the panel.
 *
 * This is the feature that becomes Clippy if it is built carelessly, so the rules
 * below are the feature. People using this workspace are on collections calls,
 * reconciling exceptions and making lending decisions; something that strolls past
 * mid-task is an interruption, and an interruption during a customer call is a
 * cost the product has no right to impose.
 *
 * So it may only appear when ALL of these hold:
 *
 *   - they have not switched it off. ON by default since 2026-10-22, because a
 *     feature nobody discovers is a feature nobody has — which is only
 *     defensible because every rule below still holds.
 *   - they have done nothing for IDLE_MS. Not "a while" — no key, no click, no
 *     pointer movement.
 *   - nothing is focused that they might be typing into.
 *   - no dialog is open. A modal means a decision is in progress.
 *   - the tab is actually visible.
 *   - the assistant panel is closed. It is already on screen in that case.
 *   - it has not appeared in the last COOLDOWN_MS.
 *
 * And it leaves the instant any of that stops being true. The first mouse move
 * sends it away — the person came back, and that is the end of its turn.
 *
 * It walks along the very bottom of the window, below the height of anything
 * clickable, and it never sits in the lower-right corner where the assistant
 * launcher and most toast stacks live.
 */

/** Four minutes of nothing at all. Long enough that the person has plainly stopped. */
const IDLE_MS = 4 * 60 * 1000

/** At most once every twenty minutes, however idle they are. */
const COOLDOWN_MS = 20 * 60 * 1000

/** How long it stays if left alone. */
const VISIT_MS = 14 * 1000

/**
 * An introduction stays longer, because it is three sentences rather than six
 * words and fourteen seconds is not enough to read it. Still dismissed by the
 * first mouse move like anything else.
 */
const INTRO_VISIT_MS = 26 * 1000

/** Opening the assistant from here, without this component knowing how. */
export const OPEN_ASSISTANT_EVENT = 'o3c:open-assistant'

function somethingIsFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function aDialogIsOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]')
}

export default function CompanionPresence() {
  const [visible, setVisible] = useState(false)
  const [line, setLine] = useState('')
  const lastSeen = useRef(0)
  const lastActivity = useRef(Date.now())
  const timer = useRef<number | null>(null)

  const persona = personaOf(readCompanion())

  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const goAway = useCallback(() => {
    setVisible(false)
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
  }, [])

  // Any sign of life dismisses it and restarts the idle clock.
  useEffect(() => {
    const seen = () => {
      lastActivity.current = Date.now()
      setVisible(v => {
        if (v) { if (timer.current) clearTimeout(timer.current); timer.current = null }
        return false
      })
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'focusin']
    for (const e of events) window.addEventListener(e, seen, { passive: true })
    document.addEventListener('visibilitychange', seen)
    return () => {
      for (const e of events) window.removeEventListener(e, seen)
      document.removeEventListener('visibilitychange', seen)
    }
  }, [])

  // The check. Deliberately a poll rather than a timeout chain: the conditions it
  // tests (a dialog, a focused field) can change without any event this component
  // would otherwise hear about.
  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = Date.now()
      // The same function the tests exercise, so what is verified is what runs.
      if (!presenceGuards.mayAppear(now, {
        enabled: roamEnabled(),
        visible,
        tabVisible: document.visibilityState === 'visible',
        lastActivity: lastActivity.current,
        lastSeen: lastSeen.current,
        focused: somethingIsFocused(),
        dialogOpen: aDialogIsOpen(),
      })) return

      lastSeen.current = now
      // First appearance ever, or the first in a fortnight, says who he is.
      // After that he goes back to offering a figure, because somebody who has
      // been introduced twice does not need a third time.
      const intro = introDue(now)
      if (intro) {
        setLine(persona.intro)
        markIntroShown(now)
      } else {
        setLine(persona.idleLines[Math.floor(Math.random() * persona.idleLines.length)])
      }
      setVisible(true)
      timer.current = window.setTimeout(() => setVisible(false), intro ? INTRO_VISIT_MS : VISIT_MS)
    }, 15_000)
    return () => window.clearInterval(tick)
  }, [visible, persona])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        // Bottom LEFT: the assistant launcher, toasts and most action bars live on
        // the right, and this must never be the thing between a cursor and a button.
        left: 20,
        bottom: 14,
        // Under dialogs and toasts on purpose. If something important is on screen
        // this belongs behind it.
        zIndex: 60,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        animation: reduceMotion ? 'none' : 'o3c-presence-in .5s var(--ease-out, ease-out)',
      }}
    >
      <style>{`
        @keyframes o3c-presence-in {
          from { opacity: 0; transform: translateX(-26px) }
          to   { opacity: 1; transform: translateX(0) }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes o3c-presence-in { from { opacity: 0 } to { opacity: 1 } }
        }
      `}</style>

      <button
        type="button"
        onClick={() => {
          goAway()
          window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_EVENT))
        }}
        title={`Ask ${persona.name}`}
        style={{
          border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
          lineHeight: 0, borderRadius: '50%',
        }}
      >
        <CompanionAvatar size={52} state="idle" look={persona.look} title={`Ask ${persona.name}`} />
      </button>

      <div
        style={{
          position: 'relative', maxWidth: 260, marginBottom: 7,
          background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10,
          padding: '9px 30px 9px 12px',
          fontSize: TEXT.xs, lineHeight: 1.5, color: 'var(--txt)',
          boxShadow: '0 6px 18px rgba(14,40,65,.12)',
        }}
      >
        {line}
        <button
          type="button"
          onClick={goAway}
          aria-label={`Dismiss ${persona.name}`}
          title="Not now"
          style={{
            position: 'absolute', top: 5, right: 5, width: 20, height: 20,
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'var(--txt3)', fontSize: 15, lineHeight: '20px', padding: 0,
          }}
        >
          ×
        </button>
        <div style={{
          position: 'absolute', left: -5, bottom: 11, width: 9, height: 9,
          background: 'var(--card)', borderLeft: '1px solid var(--bdr)',
          borderBottom: '1px solid var(--bdr)', transform: 'rotate(45deg)',
        }} />
      </div>
    </div>
  )
}

/** Exported for the tests, and for anything else that needs the same rule. */
export const presenceGuards = {
  somethingIsFocused,
  aDialogIsOpen,
  IDLE_MS,
  COOLDOWN_MS,
  /**
   * The whole decision in one pure function, so it can be tested without a DOM
   * timer and without waiting four minutes.
   */
  mayAppear(now: number, s: {
    enabled: boolean
    visible: boolean
    tabVisible: boolean
    lastActivity: number
    lastSeen: number
    focused: boolean
    dialogOpen: boolean
  }): boolean {
    if (!s.enabled) return false
    if (s.visible) return false
    if (!s.tabVisible) return false
    if (now - s.lastActivity < IDLE_MS) return false
    if (now - s.lastSeen < COOLDOWN_MS) return false
    if (s.focused || s.dialogOpen) return false
    return true
  },
}
