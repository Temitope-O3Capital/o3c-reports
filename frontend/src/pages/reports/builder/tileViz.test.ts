import { describe, it, expect } from 'vitest'
import {
  resolveViz, pruneForViz, goalTest, VIZ_KINDS, VIZ_META, maxSeries, defaultCap,
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
    // `goal` used to be dropped here too, when a target only drew a KPI's progress bar.
    // It now colours bars and cells as well, so a bar chart keeps it; what a visual
    // cannot use is still dropped, which is covered below.
    expect(p.goal).toBe(100)
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

  it('offers exactly the twelve kinds the backend accepts', () => {
    // Mirrors dashVizKinds in handlers/dashboards.go and the CHECK from migration 386.
    // A Go test reads THIS array and compares it with that map, so the two cannot drift.
    expect([...VIZ_KINDS].sort()).toEqual(
      ['area', 'bar', 'barh', 'combo', 'donut', 'funnel', 'kpi', 'line', 'map',
        'matrix', 'scatter', 'table'],
    )
  })
})

describe('a matrix', () => {
  // A crosstab needs two fields. Without a second one it would be a grid one column
  // wide, so the renderer is told there is none and says so rather than drawing that.
  it('picks a second label column for its columns', () => {
    const r = resolveViz('matrix', COLUMNS, ROWS, { label: 'officer_name' })
    expect(r.labelKey).toBe('officer_name')
    expect(r.colByKey).toBe('state')
  })

  it('honours an explicit colBy', () => {
    const r = resolveViz('matrix', COLUMNS, ROWS, { label: 'state', colBy: 'officer_name' })
    expect(r.colByKey).toBe('officer_name')
  })

  it('never uses the row field as its own columns', () => {
    const r = resolveViz('matrix', COLUMNS, ROWS, { label: 'state', colBy: 'state' })
    expect(r.colByKey).not.toBe('state')
  })

  it('reports no column field when there is only one label column', () => {
    const r = resolveViz('matrix', ['state', 'tickets'], ROWS, { label: 'state' })
    expect(r.colByKey).toBe('')
  })

  it('leaves colByKey empty for every other visual', () => {
    expect(resolveViz('bar', COLUMNS, ROWS, { colBy: 'state' }).colByKey).toBe('')
  })

  // A matrix is read, not glanced at, so it is not cut to 40 rows like a chart.
  it('is not row-capped', () => {
    expect(defaultCap('matrix')).toBe(0)
  })
})

describe('a scatter', () => {
  it('takes exactly two measures, in order', () => {
    expect(maxSeries('scatter')).toBe(2)
    const r = resolveViz('scatter', COLUMNS, ROWS, { values: ['tickets', 'amount_kobo'] })
    expect(r.seriesKeys).toEqual(['tickets', 'amount_kobo'])
  })

  // The one chart where more points is the point: the shape of the cloud is the finding.
  it('keeps far more points than a column chart', () => {
    expect(defaultCap('scatter')).toBeGreaterThan(defaultCap('bar'))
  })
})

describe('a map', () => {
  it('draws every state rather than the chart default of forty', () => {
    // There are 37 states. A cap of 40 would never bite on a clean report and would
    // silently drop three from one that also carries a total row.
    expect(defaultCap('map')).toBe(0)
  })
})

describe('colouring by a target', () => {
  it('does nothing without both a target and the switch', () => {
    expect(goalTest({ goal: 20 }, COLUMNS, 'tickets')).toBeUndefined()
    expect(goalTest({ colorByGoal: true }, COLUMNS, 'tickets')).toBeUndefined()
    expect(goalTest(null, COLUMNS, 'tickets')).toBeUndefined()
  })

  it('reads the measure being drawn when no column is named', () => {
    const t = goalTest({ goal: 20, colorByGoal: true }, COLUMNS, 'tickets')!
    expect(t({ tickets: 30 })).toBe('good')
    expect(t({ tickets: 20 })).toBe('good')   // at the target counts as meeting it
    expect(t({ tickets: 10 })).toBe('bad')
  })

  it('inverts for a measure where lower is better', () => {
    const t = goalTest({ goal: 20, colorByGoal: true, goalGood: 'below' }, COLUMNS, 'tickets')!
    expect(t({ tickets: 10 })).toBe('good')
    expect(t({ tickets: 30 })).toBe('bad')
  })

  it('tests the named column instead when one is given', () => {
    const t = goalTest({ goal: 400, colorByGoal: true, goalCol: 'amount_kobo' }, COLUMNS, 'tickets')!
    // tickets would fail this target; amount_kobo passes, and amount_kobo is the one asked for.
    expect(t({ tickets: 1, amount_kobo: 900 })).toBe('good')
  })

  it('falls back to the drawn measure if the named column is gone', () => {
    // A renamed or removed measure must not silently stop the colouring.
    const t = goalTest({ goal: 20, colorByGoal: true, goalCol: 'deleted_col' }, COLUMNS, 'tickets')!
    expect(t({ tickets: 30 })).toBe('good')
  })

  // A MISSING FIGURE IS NO NEWS, NOT BAD NEWS. Colouring a blank cell red invents a
  // failure out of an absence, which is the one thing a traffic light must never do.
  it('leaves a blank or non-numeric figure uncoloured', () => {
    const t = goalTest({ goal: 20, colorByGoal: true }, COLUMNS, 'tickets')!
    expect(t({ tickets: null })).toBeUndefined()
    expect(t({ tickets: undefined })).toBeUndefined()
    expect(t({ tickets: '30' })).toBeUndefined()
    expect(t({})).toBeUndefined()
    expect(t({ tickets: NaN })).toBeUndefined()
  })

  it('treats a zero target as a real target rather than as absent', () => {
    const t = goalTest({ goal: 0, colorByGoal: true }, COLUMNS, 'tickets')!
    expect(t({ tickets: 1 })).toBe('good')
    expect(t({ tickets: -1 })).toBe('bad')
  })
})

describe('data labels', () => {
  it('are off unless asked for', () => {
    expect(resolveViz('bar', COLUMNS, ROWS, null).dataLabels).toBe(false)
  })

  it('are on where the chart can print them', () => {
    expect(resolveViz('bar', COLUMNS, ROWS, { dataLabels: true }).dataLabels).toBe(true)
    expect(resolveViz('barh', COLUMNS, ROWS, { dataLabels: true }).dataLabels).toBe(true)
  })

  it('are ignored where it cannot', () => {
    // A donut and a table have nowhere to put them, and a setting that does nothing is
    // worse than no setting.
    expect(resolveViz('donut', COLUMNS, ROWS, { dataLabels: true }).dataLabels).toBe(false)
    expect(resolveViz('table', COLUMNS, ROWS, { dataLabels: true }).dataLabels).toBe(false)
  })
})

describe('the target survives a change of visual only where it can be shown', () => {
  const targeted: TileVizConfig = {
    label: 'state', colBy: 'officer_name', values: ['tickets'], dataLabels: true,
    goal: 20, goalGood: 'below', goalCol: 'tickets', colorByGoal: true,
  }

  it('keeps it on a visual that can show it', () => {
    for (const k of ['kpi', 'table', 'bar', 'barh', 'matrix']) {
      expect(pruneForViz(k, targeted).goal).toBe(20)
      expect(pruneForViz(k, targeted).colorByGoal).toBe(true)
    }
  })

  it('drops it and its colouring where it cannot', () => {
    // A line's colour belongs to its series: recolouring segments of one line would read
    // as several lines.
    for (const k of ['line', 'area', 'combo', 'donut', 'funnel', 'scatter']) {
      const out = pruneForViz(k, targeted)
      expect(out.goal).toBeUndefined()
      expect(out.colorByGoal).toBeUndefined()
      expect(out.goalGood).toBeUndefined()
      expect(out.goalCol).toBeUndefined()
    }
  })

  it('drops colBy off anything but a matrix, and dataLabels off a donut', () => {
    expect(pruneForViz('bar', targeted).colBy).toBeUndefined()
    expect(pruneForViz('matrix', targeted).colBy).toBe('officer_name')
    expect(pruneForViz('donut', targeted).dataLabels).toBeUndefined()
    expect(pruneForViz('bar', targeted).dataLabels).toBe(true)
  })
})
