import { useEffect, useState } from 'react'
import { SectionCard } from './UI'
import { CompanionAvatar, type CompanionState } from './Companion'
import {
  COMPANIONS, readCompanion, writeCompanion, roamEnabled, setRoamEnabled,
  type CompanionId, type Persona,
} from '../lib/companions'
import { NAVY, GREEN, TEXT, FW, SP } from '../lib/design'

/**
 * Choosing a companion.
 *
 * Shown large and moving, rather than as two small static headshots beside radio
 * buttons. The thing being chosen is a character that will sit in the corner of
 * the screen all day; a 26px thumbnail tells you nothing about what that is like
 * to have around.
 *
 * Each card cycles the face through the states it will actually show in use —
 * resting, listening, thinking, speaking — so the motion on display is the motion
 * you get, not a showreel. Under prefers-reduced-motion the cycling stops and the
 * face rests, because a settings page is the last place that should be fighting
 * someone's accessibility preference.
 */

/** The order the preview walks, with how long to hold each. */
const CYCLE: { state: CompanionState; ms: number }[] = [
  { state: 'idle', ms: 2600 },
  { state: 'listening', ms: 2000 },
  { state: 'thinking', ms: 2600 },
  { state: 'speaking', ms: 3200 },
]

/** One line each, written in the voice the persona actually produces. */
const SAMPLE: Record<CompanionId, { q: string; a: string }> = {
  esther: {
    q: 'What did we collect last month?',
    a: '₦41.2m across 318 accounts. That is settled payments only — six more are '
      + 'pending clearance and would add about ₦900k, and it excludes the two '
      + 'accounts still under dispute.',
  },
  temitope: {
    q: 'What did we collect last month?',
    a: '₦41.2m last month, across 318 accounts — up 7% on September. '
      + 'Want the breakdown by officer?',
  },
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

function Card({ p, chosen, onChoose, animate }: {
  p: Persona
  chosen: boolean
  onChoose: () => void
  animate: boolean
}) {
  const state = useCycledState(animate)
  const sample = SAMPLE[p.id]

  return (
    <div
      onClick={onChoose}
      role="radio"
      aria-checked={chosen}
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChoose() } }}
      style={{
        flex: '1 1 300px', minWidth: 0, cursor: 'pointer',
        border: `1.5px solid ${chosen ? NAVY : 'var(--bdr)'}`,
        borderRadius: 10, padding: SP[4],
        background: chosen ? 'var(--card)' : 'var(--bg)',
        boxShadow: chosen ? '0 0 0 3px rgba(14,40,65,.08)' : 'none',
        transition: 'border-color .14s, box-shadow .14s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
        {/* Vector, so this is pin-sharp at any size — including on a 4K display,
            where a bitmap portrait would be the one soft thing on the page. */}
        <CompanionAvatar size={96} state={state} look={p.look} title={`${p.name}, ${state}`} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.lg, fontWeight: FW.semibold as any, color: 'var(--txt)' }}>
            {p.name}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>{p.blurb}</div>
          <div style={{
            fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 6,
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: state === 'listening' ? GREEN : state === 'idle' ? 'var(--txt3)' : NAVY,
            }} />
            {state === 'idle' ? 'Resting' : state === 'listening' ? 'Listening'
              : state === 'thinking' ? 'Thinking' : 'Speaking'}
          </div>
        </div>
      </div>

      {/* The same question to both, so the difference is the answer and not the
          example. This is what people are actually choosing between. */}
      <div style={{
        borderTop: '1px solid var(--bdr)', paddingTop: 11, marginTop: 4,
        fontSize: TEXT.xs, lineHeight: 1.55,
      }}>
        <div style={{ color: 'var(--txt3)', marginBottom: 5 }}>“{sample.q}”</div>
        <div style={{ color: 'var(--txt)' }}>{sample.a}</div>
      </div>

      <button
        type="button"
        onClick={e => { e.stopPropagation(); onChoose() }}
        style={{
          marginTop: 13, width: '100%', padding: '8px 12px', borderRadius: 6,
          border: `1px solid ${chosen ? NAVY : 'var(--bdr)'}`,
          background: chosen ? NAVY : 'transparent',
          color: chosen ? '#fff' : 'var(--txt)',
          fontSize: TEXT.xs, fontWeight: FW.medium as any, cursor: 'pointer',
        }}
      >
        {chosen ? `${p.name} is your assistant` : `Choose ${p.name}`}
      </button>
    </div>
  )
}

export default function CompanionPicker() {
  const [id, setId] = useState<CompanionId>(() => readCompanion())
  const [roam, setRoam] = useState(() => roamEnabled())

  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  function choose(next: CompanionId) {
    setId(next)
    writeCompanion(next)
  }

  return (
    <>
      <SectionCard
        title="Your Assistant"
        subtitle="Both answer from the same live data and will always give you the same figures. What differs is how they say it. Saved on this device."
      >
        <div role="radiogroup" aria-label="Assistant" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {(['esther', 'temitope'] as CompanionId[]).map(k => (
            <Card
              key={k}
              p={COMPANIONS[k]}
              chosen={id === k}
              onChoose={() => choose(k)}
              animate={!reduceMotion}
            />
          ))}
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
              Allow {COMPANIONS[id].name} to appear on screen
            </span>
            <br />
            Off by default, and worth leaving off if you spend your day on calls.
            When on, {COMPANIONS[id].pronoun} only appears after a few minutes of no
            typing or clicking, never over a dialog, and never while a call is being
            logged. One click sends {COMPANIONS[id].pronoun === 'she' ? 'her' : 'him'} away.
          </span>
        </label>
      </SectionCard>
    </>
  )
}
