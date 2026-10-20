import { describe, it, expect } from 'vitest'
import { companionState } from './Companion'

/**
 * The face is the fastest signal in the panel, so the precedence between states
 * matters more than it looks. These pin the order down, because every one of them
 * is a case where two things are true at once and only one can be shown.
 */
describe('what the companion shows when several things are true at once', () => {
  it('says offline above all else, because nothing you type will go anywhere', () => {
    expect(companionState({
      online: false, busy: true, listening: true, streaming: true, speaking: true,
    })).toBe('offline')
  })

  it('treats an unknown connection as usable rather than broken', () => {
    // online starts null while the health check is in flight. Showing a dead face
    // for that first moment would make a working assistant look down on every open.
    expect(companionState({ online: null, busy: false })).toBe('idle')
  })

  it('shows listening over thinking, so an open microphone is never hidden', () => {
    expect(companionState({ online: true, busy: true, listening: true })).toBe('listening')
  })

  it('shows speaking over streaming when audio is actually playing', () => {
    expect(companionState({
      online: true, busy: true, streaming: true, speaking: true,
    })).toBe('speaking')
  })

  it('treats arriving text as speech when there is no audio', () => {
    expect(companionState({ online: true, busy: true, streaming: true })).toBe('speaking')
  })

  it('shows thinking while the question is with the model and nothing has come back', () => {
    expect(companionState({ online: true, busy: true })).toBe('thinking')
  })

  it('rests when there is nothing to report', () => {
    expect(companionState({ online: true, busy: false })).toBe('idle')
  })

  it('does not get stuck speaking once the stream ends', () => {
    // The panel clears streaming and busy together at the end of a turn; the face
    // must fall all the way back to idle rather than holding the last state.
    expect(companionState({
      online: true, busy: false, streaming: false, speaking: false,
    })).toBe('idle')
  })
})
