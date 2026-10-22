import { describe, expect, it } from 'vitest'
import { asRoleArray } from './roles'
import { isChunkError } from './reportError'

// extra_roles is jsonb, and the db layer returns jsonb as TEXT, so a list endpoint
// sends a STRING while login sends a real array. Both shapes are real; a reader that
// handles only one crashes the page.
describe('asRoleArray', () => {
  it('passes a real array straight through', () => {
    expect(asRoleArray(['call_center_head', 'care_head'])).toEqual(['call_center_head', 'care_head'])
  })

  it('parses the JSON string a list endpoint actually sends', () => {
    // This exact shape crashed the People register: `(v ?? []).map` on a string.
    expect(asRoleArray('["call_center_head","care_head"]')).toEqual(['call_center_head', 'care_head'])
  })

  it('treats every empty shape as no roles rather than throwing', () => {
    for (const v of [null, undefined, '', '   ', '[]', 0, false]) {
      expect(asRoleArray(v)).toEqual([])
    }
  })

  it('returns no roles for text that is not JSON, instead of propagating a parse error', () => {
    expect(asRoleArray('admin')).toEqual([])
    expect(asRoleArray('{broken')).toEqual([])
  })

  it('refuses JSON that parses but is not a list', () => {
    // '"admin"' and '{"a":1}' are valid JSON. Returning either would hand .map a
    // non-array and move the crash one line down.
    expect(asRoleArray('"admin"')).toEqual([])
    expect(asRoleArray('{"role":"admin"}')).toEqual([])
    expect(asRoleArray('7')).toEqual([])
  })
})

// A tab that was open when a new version shipped asks for a chunk whose filename
// carried the old build's hash. Recognising it is what turns a dead error box into a
// reload, so the matcher has to cover what browsers actually say.
describe('isChunkError', () => {
  it('recognises the message Chrome produces for a missing chunk', () => {
    expect(isChunkError(new TypeError(
      'Failed to fetch dynamically imported module: https://example/assets/Supervisor-C9GVoM7W.js',
    ))).toBe(true)
  })

  it('recognises the other forms', () => {
    expect(isChunkError(new Error('Importing a module script failed.'))).toBe(true)
    expect(isChunkError(new Error('Loading chunk 42 failed'))).toBe(true)
    const named = new Error('whatever')
    named.name = 'ChunkLoadError'
    expect(isChunkError(named)).toBe(true)
  })

  it('does not claim an ordinary page fault is a stale deploy', () => {
    // Misfiring here would reload the tab on a real bug and hide it behind a loop.
    expect(isChunkError(new TypeError('o.toFixed is not a function'))).toBe(false)
    expect(isChunkError(new TypeError('(t.extra_roles ?? []).map is not a function'))).toBe(false)
    expect(isChunkError(new Error('Minified React error #130'))).toBe(false)
  })
})
