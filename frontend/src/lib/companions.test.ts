import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMPANIONS, DEFAULT_COMPANION, introDue, markIntroShown,
  personaOf, readCompanion, roamEnabled, setRoamEnabled,
} from './companions'

beforeEach(() => {
  localStorage.clear()
})

describe('one assistant', () => {
  it('always resolves to Temitope, whatever is stored', () => {
    // A machine that chose the assistant that no longer exists must not resolve
    // to a persona that is gone; it would be undefined at every call site.
    localStorage.setItem('o3c_companion', 'esther')
    expect(readCompanion()).toBe('temitope')
    expect(personaOf(readCompanion()).name).toBe('Temitope')
  })

  it('has exactly one persona in the catalogue', () => {
    expect(Object.keys(COMPANIONS)).toEqual(['temitope'])
    expect(DEFAULT_COMPANION).toBe('temitope')
  })
})

describe('being visible by default', () => {
  it('is on when nothing has been chosen', () => {
    // The point of the change: staff were not discovering the assistant existed.
    expect(roamEnabled()).toBe(true)
  })

  it('stays off once someone turns it off', () => {
    setRoamEnabled(false)
    expect(roamEnabled()).toBe(false)
  })

  it('comes back on if they turn it on again', () => {
    setRoamEnabled(false)
    setRoamEnabled(true)
    expect(roamEnabled()).toBe(true)
  })

  it('treats an unreadable preference as on, not off', () => {
    // A private window throws on read. Defaulting to off there would silently
    // disable the feature for a whole class of session.
    localStorage.setItem('o3c_companion_roam', 'nonsense')
    expect(roamEnabled()).toBe(true)
  })
})

describe('introducing himself', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('is due the very first time, since nobody has met him', () => {
    expect(introDue()).toBe(true)
  })

  it('is not due again immediately after', () => {
    const now = Date.now()
    markIntroShown(now)
    expect(introDue(now)).toBe(false)
    expect(introDue(now + 6 * DAY)).toBe(false)
  })

  it('comes round again after a fortnight', () => {
    const now = Date.now()
    markIntroShown(now)
    expect(introDue(now + 13 * DAY)).toBe(false)
    expect(introDue(now + 15 * DAY)).toBe(true)
  })

  it('is due again if the stored timestamp is rubbish', () => {
    localStorage.setItem('o3c_companion_intro', 'tuesday')
    expect(introDue()).toBe(true)
  })

  it('says what he can do AND what he cannot', () => {
    // An introduction that only promises gets asked for magic and then blamed.
    // Staff were also going to IT for access they already had, so the line about
    // reading live data is doing real work.
    const intro = COMPANIONS.temitope.intro
    expect(intro).toContain('Temitope')
    expect(intro.toLowerCase()).toContain('live data')
    expect(intro.toLowerCase()).toMatch(/never approve|only tell you what the/)
    // Short enough to be read in the time he stays on screen.
    expect(intro.length).toBeLessThan(400)
  })
})
