import { describe, it, expect } from 'vitest'
import { presenceGuards } from './CompanionPresence'

const { mayAppear, IDLE_MS, COOLDOWN_MS } = presenceGuards

const NOW = 1_800_000_000_000

/** Everything satisfied: switched on, long idle, nothing in the way. */
const ready = {
  enabled: true,
  visible: false,
  tabVisible: true,
  lastActivity: NOW - IDLE_MS - 1,
  lastSeen: NOW - COOLDOWN_MS - 1,
  focused: false,
  dialogOpen: false,
}

/**
 * These are the whole feature. An avatar that walks across the screen is trivial;
 * one that knows when NOT to is the difference between a companion and the reason
 * people disable things. Each case below is a moment where appearing would be an
 * intrusion rather than company.
 */
describe('when the companion may appear', () => {
  it('appears when everything is satisfied', () => {
    expect(mayAppear(NOW, ready)).toBe(true)
  })

  it('never appears unless the person switched it on', () => {
    // The default. Nobody should meet this feature by surprise.
    expect(mayAppear(NOW, { ...ready, enabled: false })).toBe(false)
  })

  it('stays away while someone is typing', () => {
    // A focused field means a sentence in progress — a note on a call, a customer
    // reference. Appearing beside it is the Clippy failure exactly.
    expect(mayAppear(NOW, { ...ready, focused: true })).toBe(false)
  })

  it('stays away while a dialog is open', () => {
    // A modal means a decision is in progress: an approval, a write-off, a
    // confirmation. Nothing else may ask for attention during that.
    expect(mayAppear(NOW, { ...ready, dialogOpen: true })).toBe(false)
  })

  it('waits the full idle period, not almost', () => {
    expect(mayAppear(NOW, { ...ready, lastActivity: NOW - IDLE_MS + 1 })).toBe(false)
    expect(mayAppear(NOW, { ...ready, lastActivity: NOW - IDLE_MS })).toBe(true)
  })

  it('will not come back inside the cooldown however idle the person is', () => {
    // Otherwise a long lunch would be a queue of interruptions on return.
    expect(mayAppear(NOW, {
      ...ready,
      lastActivity: NOW - 10 * 60 * 60 * 1000,
      lastSeen: NOW - COOLDOWN_MS + 1,
    })).toBe(false)
  })

  it('does not appear to an unwatched tab', () => {
    // Appearing in a background tab burns the cooldown on nobody, and the person
    // returns to a companion that has already been and gone.
    expect(mayAppear(NOW, { ...ready, tabVisible: false })).toBe(false)
  })

  it('does not stack a second appearance on top of itself', () => {
    expect(mayAppear(NOW, { ...ready, visible: true })).toBe(false)
  })

  it('is idle-gated by a margin a person would actually notice', () => {
    // Guards the constant itself. A short idle window would mean appearing during
    // a pause for thought, which reads as being watched rather than accompanied.
    expect(IDLE_MS).toBeGreaterThanOrEqual(3 * 60 * 1000)
    expect(COOLDOWN_MS).toBeGreaterThan(IDLE_MS)
  })
})
