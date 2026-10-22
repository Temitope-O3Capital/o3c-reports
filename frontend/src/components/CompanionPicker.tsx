import { useEffect, useState } from 'react'
import { SectionCard } from './UI'
import { CompanionAvatar, type CompanionState } from './Companion'
import { COMPANIONS, DEFAULT_COMPANION, roamEnabled, setRoamEnabled } from '../lib/companions'
import { NAVY, TEXT, FW, SP } from '../lib/design'

/**
 * The assistant, and the one setting that belongs to it.
 *
 * This was a chooser between two characters. There is one assistant now, so there
 * is nothing to choose, and a radio group with a single option is worse than no
 * radio group at all.
 *
 * What is kept is the part that was actually informative: the face shown large and
 * moving, cycling the states it will really show in use — resting, listening,
 * thinking, speaking — so the motion on display is the motion you get. A 26px
 * thumbnail tells you nothing about what it is like to have something in the
 * corner of your screen all day.
 *
 * Under prefers-reduced-motion the cycling stops and the face rests, because a
 * settings page is the last place that should fight someone's accessibility
 * preference.
 */

/** The order the preview walks, with how long to hold each. */
const CYCLE: { state: CompanionState; ms: number }[] = [
  { state: 'idle', ms: 2600 },
  { state: 'listening', ms: 2000 },
  { state: 'thinking', ms: 2600 },
  { state: 'speaking', ms: 3200 },
]

/**
 * Written in the voice the assistant actually produces, including the half that
 * used to belong to the other one: the figure first, then what it does not cover.
 */
const SAMPLE = {
  q: 'What did we collect last month?',
  a: '₦41.2m last month, across 318 accounts — up 7% on September. That is settled '
    + 'payments only: six more are pending clearance, worth about ₦900k, and the two '
    + 'accounts under dispute are excluded.',
}

function useCycledState(enabled: boolean): CompanionState {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(() => setI(n => (n + 1) % CYCLE.length), CYCLE[i].ms)
    return () => clearTimeout(t)
  }, [i, enabled])
  return enabled ? CYCLE[i].state : 'idle'
}

export default function CompanionPicker() {
  const [roam, setRoam] = useState(() => roamEnabled())

  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const p = COMPANIONS[DEFAULT_COMPANION]
  const state = useCycledState(!reduceMotion)

  return (
    <>
      <SectionCard
        title="Your Assistant"
        subtitle="Answers from the same live data every colleague sees, and gives everyone the same figures."
      >
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 18, flexWrap: 'wrap',
            border: `1.5px solid ${NAVY}`, borderRadius: 10, padding: SP[4],
            background: 'var(--card)',
          }}
        >
          {/* Vector, so this is pin-sharp at any size — including on a 4K display,
              where a bitmap portrait would be the one soft thing on the page. */}
          <CompanionAvatar size={96} state={state} look={p.look} title={`${p.name}, ${state}`} />
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <div style={{ fontSize: TEXT.lg, fontWeight: FW.semibold as any, color: 'var(--txt)' }}>
              {p.name}
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 12 }}>
              {p.blurb}
            </div>
            <div style={{ fontSize: TEXT.xs, lineHeight: 1.6 }}>
              <div style={{ color: 'var(--txt2)', marginBottom: 4 }}>“{SAMPLE.q}”</div>
              <div style={{ color: 'var(--txt)' }}>{SAMPLE.a}</div>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="On-Screen Presence"
        subtitle="Let your assistant appear outside the panel when you have been idle for a while."
      >
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={roam}
            onChange={e => { setRoam(e.target.checked); setRoamEnabled(e.target.checked) }}
            style={{ marginTop: 3 }}
          />
          <span style={{ fontSize: TEXT.xs, lineHeight: 1.6, color: 'var(--txt2)' }}>
            <span style={{ color: 'var(--txt)', fontWeight: FW.medium as any }}>
              Allow {p.name} to appear on screen
            </span>
            <br />
            Off by default, and worth leaving off if you spend your day on calls.
            When on, he only appears after a few minutes of no typing or clicking,
            never over a dialog, and never while a call is being logged. One click
            sends him away.
          </span>
        </label>
      </SectionCard>
    </>
  )
}
