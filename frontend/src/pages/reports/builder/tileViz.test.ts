import { describe, it, expect } from 'vitest'
import {
  resolveViz, pruneForViz, VIZ_KINDS, VIZ_META, maxSeries, defaultCap,
  type TileVizConfig,
} from './tileViz'

// A summary result in the shape the server returns: dimensions first, then measures.
const COLUMNS = ['officer_name', 'state', 'tickets', 'amount_kobo']
const ROWS = [
  { officer_name: 'A', state: 'Lagos', tickets: 10, amount_kobo: 500 },
  { officer_name: 'B', state: 'FCT', tickets: 30, amount_kobo: 100 },
  { officer_name: 'C', state: 'Rivers', tickets: 20, amount_kobo: 900 },
]

describe('what a tile with no config draws', () => {
  // THE BACK-COMPATIBILITY GUARANTEE. Every tile that already exists has no config at
  // all, and must keep drawing exactly what it drew before field wells existed: the
  // first label-ish column and the first numeric one.
  it('falls back to the first label and the first numeric column', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, null)
    expect(r.labelKey).toBe('officer_name')
    expect(r.seriesKeys).toEqual(['tickets'])
  })

  it('honours the single `value` key the old renderer used to write', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { value: 'amount_kobo' })
    expect(r.seriesKeys).toEqual(['amount_kobo'])
  })

  it('prefers an explicit `values` list over the legacy key', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { value: 'amount_kobo', values: ['tickets'] })
    expect(r.seriesKeys).toEqual(['tickets'])
  })
})

describe('a column that has gone away', () => {
  // A measure renamed on the Data step, or a report edited elsewhere. Drawing nothing is
  // the one outcome that must not happen.
  it('falls back rather than drawing a missing column', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { label: 'deleted_col', values: ['also_gone'] })
    expect(r.labelKey).toBe('officer_name')
    expect(r.seriesKeys).toEqual(['tickets'])
  })

  it('keeps the columns that do still exist', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { values: ['tickets', 'gone', 'amount_kobo'] })
    expect(r.seriesKeys).toEqual(['tickets', 'amount_kobo'])
  })
})

describe('series limits per visual', () => {
  it('clamps a single-series visual to one measure', () => {
    const r = resolveViz('donut', COLUMNS, ROWS, { values: ['tickets', 'amount_kobo'] })
    expect(r.seriesKeys).toEqual(['tickets'])
  })

  it('allows several measures on a multi-series visual', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { values: ['tickets', 'amount_kobo'] })
    expect(r.seriesKeys).toEqual(['tickets', 'amount_kobo'])
  })

  it('agrees with VIZ_META about which kinds take more than one', () => {
    for (const k of VIZ_KINDS) {
      expect(maxSeries(k) > 1).toBe(VIZ_META[k].multi)
    }
  })
})

describe('sort then cap, in that order', () => {
  // Capping first would take whatever rows the query returned and call them the top N.
  it('sorts before cutting, so topN really is the top', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { sortBy: 'tickets', sortDir: 'desc', topN: 2 })
    expect(r.rows.map(x => x.officer_name)).toEqual(['B', 'C'])
    expect(r.capped).toBe(true)
    expect(r.totalRows).toBe(3)
  })

  it('ascending reverses it', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { sortBy: 'tickets', sortDir: 'asc', topN: 2 })
    expect(r.rows.map(x => x.officer_name)).toEqual(['A', 'C'])
  })

  it('leaves the report order alone when nothing is chosen', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, null)
    expect(r.rows.map(x => x.officer_name)).toEqual(['A', 'B', 'C'])
  })

  it('sorts text columns too', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { sortBy: 'state', sortDir: 'asc' })
    expect(r.rows.map(x => x.state)).toEqual(['FCT', 'Lagos', 'Rivers'])
  })

  it('does not mutate the rows it was given', () => {
    const rows = [...ROWS]
    resolveViz('bar', COLUMNS, rows, { sortBy: 'tickets', sortDir: 'desc' })
    expect(rows.map(x => x.officer_name)).toEqual(['A', 'B', 'C'])
  })
})

describe('row caps', () => {
  it('uses the visual default when no topN is set', () => {
    expect(defaultCap('donut')).toBe(8)
    expect(defaultCap('bar')).toBe(40)
    // A table and a KPI are not capped here: the table scrolls, the KPI reads one row.
    expect(defaultCap('table')).toBe(0)
    expect(defaultCap('kpi')).toBe(0)
  })

  it('reports capped only when rows were actually cut', () => {
    expect(resolveViz('bar', COLUMNS, ROWS, null).capped).toBe(false)
    expect(resolveViz('bar', COLUMNS, ROWS, { topN: 1 }).capped).toBe(true)
  })
})

describe('combo splits bars from lines', () => {
  it('puts named measures on lines and the rest on bars', () => {
    const r = resolveViz('combo', COLUMNS, ROWS, {
      values: ['tickets', 'amount_kobo'], lines: ['amount_kobo'],
    })
    expect(r.barKeys).toEqual(['tickets'])
    expect(r.lineKeys).toEqual(['amount_kobo'])
  })

  it('ignores a line that is not one of the chosen measures', () => {
    const r = resolveViz('combo', COLUMNS, ROWS, { values: ['tickets'], lines: ['amount_kobo'] })
    expect(r.lineKeys).toEqual([])
    expect(r.barKeys).toEqual(['tickets'])
  })

  it('treats lines as empty for every other visual', () => {
    const r = resolveViz('bar', COLUMNS, ROWS, { values: ['tickets'], lines: ['tickets'] })
    expect(r.lineKeys).toEqual([])
  })
})

describe('pruning a config when the visual changes', () => {
  // Dead config is how a setting comes to look applied while doing nothing.
  const full: TileVizConfig = {
    label: 'officer_name', values: ['tickets', 'amount_kobo'], lines: ['amount_kobo'],
    rightAxis: true, stacked: true, legend: false, topN: 5,
    sortBy: 'tickets', sortDir: 'desc', compare: 'amount_kobo', goal: 100,
  }

  it('drops combo-only keys off a bar', () => {
    const p = pruneForViz('bar', full)
    expect(p.lines).toBeUndefined()
    expect(p.rightAxis).toBeUndefined()
  })

  it('drops KPI-only keys off a chart', () => {
    const p = pruneForViz('bar', full)
    expect(p.compare).toBeUndefined()
    expect(p.goal).toBeUndefined()
  })

  it('drops category keys off a KPI', () => {
    const p = pruneForViz('kpi', full)
    expect(p.label).toBeUndefined()
    expect(p.stacked).toBeUndefined()
    expect(p.topN).toBeUndefined()
    expect(p.compare).toBe('amount_kobo')
  })

  it('clamps the measure list for a single-series visual', () => {
    expect(pruneForViz('donut', full).values).toEqual(['tickets'])
  })

  it('leaves a table with no field choices to be ignored', () => {
    const p = pruneForViz('table', full)
    expect(p.values).toBeUndefined()
    expect(p.label).toBeUndefined()
  })

  it('does not mutate the config it was given', () => {
    pruneForViz('kpi', full)
    expect(full.label).toBe('officer_name')
    expect(full.values).toEqual(['tickets', 'amount_kobo'])
  })
})

describe('every offered kind is described', () => {
  it('has metadata for each kind, so no button renders unlabelled', () => {
    for (const k of VIZ_KINDS) {
      expect(VIZ_META[k]).toBeDefined()
      expect(VIZ_META[k].label.length).toBeGreaterThan(0)
      expect(VIZ_META[k].icon.length).toBeGreaterThan(0)
      expect(VIZ_META[k].note.length).toBeGreaterThan(0)
    }
  })

  it('offers exactly the nine kinds the backend accepts', () => {
    // Mirrors dashVizKinds in handlers/dashboards.go and the CHECK from migration 381.
    expect([...VIZ_KINDS].sort()).toEqual(
      ['area', 'bar', 'barh', 'combo', 'donut', 'funnel', 'kpi', 'line', 'table'],
    )
  })
})
