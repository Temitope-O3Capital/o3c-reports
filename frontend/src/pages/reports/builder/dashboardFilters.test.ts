import { describe, it, expect } from 'vitest'
import {
  selectionQuery, isSelectionEmpty, emptySelection, crossFilterKeys, tileQuery,
  type Slicer, type CrossFilter,
} from './DashboardFilters'

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

const slicer = (key: string): Slicer =>
  ({ key, label: key, kind: 'text', options: null, tiles: 1, of_tiles: 3 })

describe('what a click is allowed to filter', () => {
  // THE SAFETY PROPERTY. A click becomes an ordinary f_<key> slicer, so the only thing
  // standing between a chart's category column and a filter is this list. A column the
  // board does not declare as a slicer must never be clickable, or a click would ask for
  // a filter no dataset has and every tile would answer with nothing.
  it('offers only keys the board actually declares', () => {
    const keys = crossFilterKeys([slicer('state'), slicer('direction')], emptySelection())
    expect(keys).toEqual(['state', 'direction'])
    expect(keys).not.toContain('hangup_cause')
  })

  it('withholds a key the filter bar already has a value for', () => {
    // The bar is asking a narrower question on that field and the viewer can see the
    // control. A click could only contradict it or be silently dropped.
    const keys = crossFilterKeys(
      [slicer('state'), slicer('direction')],
      { values: { state: 'Lagos' }, win: '', from: '', to: '' },
    )
    expect(keys).toEqual(['direction'])
  })

  it('offers nothing when the board declares no slicers', () => {
    expect(crossFilterKeys([], emptySelection())).toEqual([])
  })
})

describe('the query each tile asks with a click in play', () => {
  const cross: CrossFilter =
    { tileId: 7, tileTitle: 'Calls by Direction', key: 'direction', label: 'Direction', value: 'inbound' }

  // THE TILE YOU CLICKED IS NOT NARROWED BY ITS OWN CLICK. Filtering it would leave the
  // single bar that was clicked — nothing left to click, and no way back but Clear.
  it('leaves the tile the click came from alone', () => {
    expect(tileQuery(emptySelection(), cross, 7)).toBe('')
  })

  it('narrows every other tile', () => {
    expect(tileQuery(emptySelection(), cross, 8)).toBe('?f_direction=inbound')
  })

  it('is exactly the bar’s own query when nothing was clicked', () => {
    // An unfiltered board must fetch the URL it always did, cross-filtering or not.
    const sel = { values: { state: 'Lagos' }, win: 'this_month', from: '', to: '' }
    expect(tileQuery(sel, null, 7)).toBe(selectionQuery(sel))
    expect(tileQuery(emptySelection(), null, 7)).toBe('')
  })

  it('carries the bar’s selection and the click together', () => {
    const q = tileQuery({ values: { state: 'Lagos' }, win: 'this_month', from: '', to: '' }, cross, 8)
    expect(q).toContain('f_state=Lagos')
    expect(q).toContain('f_direction=inbound')
    expect(q).toContain('win=this_month')
  })

  it('does not mutate the selection it was handed', () => {
    // The selection is React state shared by every tile; writing the cross-filter into it
    // would make the click look like something the viewer typed, and persist it.
    const sel = { values: { state: 'Lagos' }, win: '', from: '', to: '' }
    tileQuery(sel, cross, 8)
    expect(sel.values).toEqual({ state: 'Lagos' })
  })
})
