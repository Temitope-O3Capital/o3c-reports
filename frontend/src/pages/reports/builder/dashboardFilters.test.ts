import { describe, it, expect } from 'vitest'
import { selectionQuery, isSelectionEmpty, emptySelection } from './DashboardFilters'

describe('the query a tile appends', () => {
  // AN UNFILTERED BOARD MUST FETCH THE URL IT ALWAYS DID. Every tile's request is keyed
  // on this string, so an empty selection that produced "?" would change every URL on
  // every board and invalidate caching for no reason.
  it('is empty when nothing is selected', () => {
    expect(selectionQuery(emptySelection())).toBe('')
  })

  it('prefixes slicer values so they cannot collide with win, from or to', () => {
    const q = selectionQuery({ values: { state: 'Lagos' }, win: '', from: '', to: '' })
    expect(q).toBe('?f_state=Lagos')
  })

  it('carries several slicers', () => {
    const q = selectionQuery({
      values: { state: 'Lagos', direction: 'inbound' }, win: '', from: '', to: '',
    })
    expect(q).toContain('f_state=Lagos')
    expect(q).toContain('f_direction=inbound')
  })

  it('drops a blank value rather than sending an empty filter', () => {
    // exports.go skips blank filter values, so an empty slicer would be a no-op that
    // still forced every tile to re-run.
    const q = selectionQuery({ values: { state: '', direction: 'inbound' }, win: '', from: '', to: '' })
    expect(q).not.toContain('f_state')
    expect(q).toBe('?f_direction=inbound')
  })

  it('sends a named window without dates', () => {
    const q = selectionQuery({ values: {}, win: 'last_30_days', from: '2026-01-01', to: '2026-02-01' })
    // A named window is re-resolved server-side on every run, so stale dates must not
    // travel with it and override the name.
    expect(q).toBe('?win=last_30_days')
  })

  it('sends dates only for a custom window', () => {
    const q = selectionQuery({ values: {}, win: 'custom', from: '2026-01-01', to: '2026-02-01' })
    expect(q).toContain('win=custom')
    expect(q).toContain('from=2026-01-01')
    expect(q).toContain('to=2026-02-01')
  })

  it('encodes a value that would otherwise break the query string', () => {
    // URLSearchParams encodes a space as "+", which is correct for a query string and is
    // what Go's r.URL.Query() decodes back to a space. The raw value must not appear.
    const q = selectionQuery({ values: { state: 'FCT, Abuja' }, win: '', from: '', to: '' })
    expect(q).not.toContain('FCT, Abuja')
    expect(q).toBe('?f_state=FCT%2C+Abuja')
    // And it round-trips the way the server will read it.
    expect(new URLSearchParams(q.slice(1)).get('f_state')).toBe('FCT, Abuja')
  })
})

describe('whether anything is selected', () => {
  it('is empty for a fresh selection', () => {
    expect(isSelectionEmpty(emptySelection())).toBe(true)
  })

  it('is empty when every value is blank', () => {
    expect(isSelectionEmpty({ values: { state: '', outcome: '' }, win: '', from: '', to: '' })).toBe(true)
  })

  it('is not empty with a value', () => {
    expect(isSelectionEmpty({ values: { state: 'Lagos' }, win: '', from: '', to: '' })).toBe(false)
  })

  it('is not empty with only a period', () => {
    expect(isSelectionEmpty({ values: {}, win: 'this_month', from: '', to: '' })).toBe(false)
  })
})
