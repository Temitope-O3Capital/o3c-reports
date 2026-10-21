import { kindOf } from '../../../lib/reportFormat'

/*
  What a tile's `config` means — in ONE place.

  The dashboard renderer and the tile builder both have to answer the same questions:
  which column is the category, which columns are the measures, in what order, how many
  rows, stacked or not. Before this module the renderer answered them by guessing (first
  text column, first numeric column) and the builder could not answer them at all, so a
  chart could not be composed — only accepted.

  THE RULE THAT MAKES THIS SAFE TO CHANGE: resolution is pure and shared. The builder
  renders its preview through `resolveViz` and saves the config it resolved; the
  dashboard renders the saved tile through the same `resolveViz`. If the two ever
  disagreed, a visual would look right while being built and draw something else once
  saved — which is precisely the bug an "it guesses" renderer invites.

  BACKWARD COMPATIBILITY IS NOT OPTIONAL. Every key here is absent on the tiles that
  already exist, and absent must mean exactly the old behaviour. `legacyValue` carries
  the single `value` key the old renderer wrote, so a tile saved before any of this
  keeps drawing the same column it always did.
*/

export type TileVizConfig = {
  /** Category / x-axis column. Absent: the first column that reads as a label. */
  label?: string
  /** Measure columns, in series order. Absent: the first numeric column, alone. */
  values?: string[]
  /** Which of `values` draw as lines in a combo. The rest draw as bars. */
  lines?: string[]
  /** Put the line series on a secondary right axis (combo only). */
  rightAxis?: boolean
  stacked?: boolean
  /** Force the legend on or off. Absent: shown when there is more than one series. */
  legend?: boolean
  /** Keep only the first N rows AFTER sorting. Absent: the visual's own cap. */
  topN?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  /** KPI only: a second column to compare the figure against. */
  compare?: string
  /** The tile's target. ONE number per tile, deliberately: it draws the KPI's progress
   *  bar and it is the same number the colouring below tests against, so a tile cannot
   *  show a bar measured from one target and a colour decided by another. */
  goal?: number
  /** Which side of the target is the good side. Absent: above. */
  goalGood?: 'above' | 'below'
  /** Colour the figure, the bars or the cells by which side of the target they fall. */
  colorByGoal?: boolean
  /** Which column the target is tested against. Absent: the measure being drawn. */
  goalCol?: string
  /** Matrix only: the column whose values become the grid's columns. */
  colBy?: string
  /** Print each value on the chart itself. */
  dataLabels?: boolean
  /** Written by the renderer before field wells existed. Read, never written now. */
  value?: string
}

export type VizKind =
  | 'kpi' | 'bar' | 'line' | 'area' | 'donut' | 'table' | 'barh' | 'combo' | 'funnel'
  | 'scatter' | 'matrix' | 'map'

/** Every kind the dashboard can draw. Must match dashVizKinds in the Go handler and the
 *  CHECK constraint from migration 381 — a kind in one and not the others is a blank tile. */
export const VIZ_KINDS: VizKind[] = [
  'table', 'matrix', 'bar', 'barh', 'line', 'area', 'combo', 'donut', 'funnel',
  'scatter', 'map', 'kpi',
]

export const VIZ_META: Record<VizKind, { label: string; icon: string; note: string; multi: boolean }> = {
  table: { label: 'Table', icon: 'table_rows', multi: false,
    note: 'Every column you picked, scrollable inside the tile.' },
  matrix: { label: 'Matrix', icon: 'grid_on', multi: false,
    note: 'A true crosstab: one field down the side, another across the top, one measure in the cells.' },
  scatter: { label: 'Scatter', icon: 'scatter_plot', multi: true,
    note: 'Two measures against each other, one point per row — for showing whether they move together.' },
  map: { label: 'Map', icon: 'map', multi: false,
    note: 'Nigeria by state, shaded by one measure. Needs a column of state names, and every spelling the data uses is already folded onto one.' },
  bar: { label: 'Column', icon: 'bar_chart', multi: true,
    note: 'One group per category. Add more than one measure to group or stack them.' },
  barh: { label: 'Bar', icon: 'align_horizontal_left', multi: true,
    note: 'Horizontal and ranked — the right choice when category names are long.' },
  line: { label: 'Line', icon: 'show_chart', multi: true,
    note: 'Best over a date. Each measure becomes its own line.' },
  area: { label: 'Area', icon: 'area_chart', multi: true,
    note: 'A line with its fill. Stack it to show composition over time.' },
  combo: { label: 'Combo', icon: 'multiline_chart', multi: true,
    note: 'Bars and lines together — a count against a rate, say, with the lines on their own axis.' },
  donut: { label: 'Donut', icon: 'donut_small', multi: false,
    note: 'Share of a whole. One measure, and only the top slices.' },
  funnel: { label: 'Funnel', icon: 'filter_alt', multi: false,
    note: 'Stage-by-stage drop-off, largest first.' },
  // multi: a card with one measure is a big single figure; with several it becomes a row
  // of figures, which is what "a card showing total calls, missed calls" asks for.
  kpi: { label: 'Figures', icon: 'numbers', multi: true,
    note: 'One measure is a single big number, with an optional comparison and target. Pick several and the tile becomes a row of figures.' },
}

/** Does this visual read a category column at all? A KPI does not. */
export function usesCategory(viz: string): boolean {
  return viz !== 'kpi'
}

/** How many series this visual can draw. */
export function maxSeries(viz: string): number {
  // A card of more than four figures stops being readable in a grid cell.
  if (viz === 'kpi') return 4
  // Scatter takes exactly two, and their ORDER is the meaning: first across, second up.
  if (viz === 'scatter') return 2
  return VIZ_META[viz as VizKind]?.multi ? 8 : 1
}

/** The default row cap per visual, when the config names no topN. These match what the
 *  renderer has always done: a donut of 40 slices is a colour wheel, not a chart. */
export function defaultCap(viz: string): number {
  if (viz === 'donut') return 8
  if (viz === 'funnel') return 10
  if (viz === 'table' || viz === 'kpi' || viz === 'matrix') return 0 // 0 = no cap
  // A scatter is the one chart where more points is the point: the shape of the cloud is
  // the finding, and 40 of them would be a different chart.
  if (viz === 'scatter') return 400
  // There are 37 states and a map draws all of them: capping at 40 would be a cap that
  // never bites, but capping at the chart default of 40 would silently drop three in a
  // report that also carries a total row.
  if (viz === 'map') return 0
  return 40
}

/** Which visuals can colour by a target. A line or an area cannot: the colour belongs to
 *  the series, and recolouring segments of one line reads as several lines. */
export function usesGoalColour(viz: string): boolean {
  return viz === 'kpi' || viz === 'table' || viz === 'bar' || viz === 'barh' || viz === 'matrix'
}

/** Which visuals can print their values on the chart. */
export function usesDataLabels(viz: string): boolean {
  return viz === 'bar' || viz === 'barh' || viz === 'line' || viz === 'area' || viz === 'combo'
}

/** The two tones a target divides the world into. The same green and red the KPI's
 *  comparison already uses, so one tile cannot speak in two palettes. */
export const GOOD = '#2F6248'
export const BAD = '#C0392B'

/**
 * The test that colours a figure, a bar or a cell against the tile's target — or
 * undefined when there is no target, no colouring asked for, or nothing to test.
 *
 * `fallbackCol` is the measure actually being drawn, so a tile with a target and no
 * explicit column colours the number it is showing rather than silently nothing.
 */
export function goalTest(
  cfg: TileVizConfig | null | undefined,
  columns: string[],
  fallbackCol: string,
): ((row: Record<string, unknown>) => 'good' | 'bad' | undefined) | undefined {
  const c = cfg ?? {}
  if (!c.colorByGoal || typeof c.goal !== 'number') return undefined
  const col = c.goalCol && columns.includes(c.goalCol) ? c.goalCol : fallbackCol
  if (!col) return undefined
  const target = c.goal
  const goodAbove = c.goalGood !== 'below'
  return (row) => {
    const v = row[col]
    // A blank or non-numeric cell is NOT bad news — it is no news, and colouring it red
    // would invent a failure out of a missing figure.
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
    const ok = goodAbove ? v >= target : v <= target
    return ok ? 'good' : 'bad'
  }
}

/** The first column that reads as a number — the same test the renderer always used. */
export function firstNumeric(cols: string[], rows: Record<string, unknown>[]): string | undefined {
  return cols.find(c => {
    const k = kindOf(c)
    if (k === 'kobo' || k === 'money' || k === 'pct' || k === 'bps' || k === 'int') return true
    return rows.some(r => typeof r[c] === 'number')
  })
}

/** The first column that reads as a label — what a chart puts on its axis. */
export function firstLabel(cols: string[], rows: Record<string, unknown>[]): string | undefined {
  const numeric = firstNumeric(cols, rows)
  return cols.find(c => c !== numeric && (kindOf(c) === 'text' || kindOf(c) === 'date'))
    ?? cols.find(c => c !== numeric)
}

/** Every column that reads as a number, for offering measures in the builder. */
export function numericColumns(cols: string[], rows: Record<string, unknown>[]): string[] {
  return cols.filter(c => {
    const k = kindOf(c)
    if (k === 'kobo' || k === 'money' || k === 'pct' || k === 'bps' || k === 'int') return true
    return rows.some(r => typeof r[c] === 'number')
  })
}

export type ResolvedViz = {
  labelKey: string
  /** Matrix only: the column whose values run across the top. '' when there is no second
   *  field to use, which is what tells the renderer to say so instead of drawing a grid
   *  one column wide. */
  colByKey: string
  dataLabels: boolean
  /** Measures actually drawn, already clamped to what this visual supports. */
  seriesKeys: string[]
  /** Of seriesKeys, those that draw as lines (combo only). */
  lineKeys: string[]
  barKeys: string[]
  rows: Record<string, unknown>[]
  stacked: boolean
  rightAxis: boolean
  legend: boolean | undefined
  /** True when rows were cut, so the tile can say so instead of implying completeness. */
  capped: boolean
  totalRows: number
}

/**
 * Turn a tile's config plus its data into exactly what the chart components need.
 *
 * Order matters and is deliberate: sort, then cap. Capping first would show the first N
 * rows the query happened to return and call them the top N.
 */
export function resolveViz(
  viz: string,
  columns: string[],
  rows: Record<string, unknown>[],
  cfg: TileVizConfig | null | undefined,
): ResolvedViz {
  const c = cfg ?? {}
  const present = (k?: string) => !!k && columns.includes(k)

  // A column named in the config but missing from the result — a renamed measure, an
  // edited report — falls back rather than drawing nothing.
  const labelKey = (present(c.label) ? c.label! : undefined)
    ?? firstLabel(columns, rows)
    ?? columns[0]
    ?? ''

  // A matrix needs a SECOND dimension for its columns. Default to the next column that
  // reads as a label and is not already the row field, so a report grouped by two things
  // draws as a crosstab without being told how.
  const numeric = numericColumns(columns, rows)
  const colByKey = viz !== 'matrix' ? '' : (
    (present(c.colBy) && c.colBy !== labelKey ? c.colBy! : undefined)
    ?? columns.find(k => k !== labelKey && !numeric.includes(k))
    ?? ''
  )

  let seriesKeys = (c.values ?? []).filter(present)
  if (!seriesKeys.length) {
    // `value` is what the pre-field-well renderer wrote. Honour it before guessing, so
    // an existing tile keeps the column it was drawing.
    const legacy = present(c.value) ? c.value! : undefined
    const guess = legacy ?? firstNumeric(columns, rows) ?? columns[0]
    seriesKeys = guess ? [guess] : []
  }
  seriesKeys = seriesKeys.slice(0, maxSeries(viz))

  const lineKeys = viz === 'combo' ? (c.lines ?? []).filter(k => seriesKeys.includes(k)) : []
  const barKeys = seriesKeys.filter(k => !lineKeys.includes(k))

  // Sort. Default: leave the report's own order alone — it already sorted, and silently
  // re-sorting would override a deliberate choice in the builder.
  let out = rows
  const sortBy = present(c.sortBy) ? c.sortBy! : undefined
  if (sortBy) {
    const dir = c.sortDir === 'asc' ? 1 : -1
    out = [...rows].sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy]
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir
    })
  }

  const cap = c.topN && c.topN > 0 ? c.topN : defaultCap(viz)
  const capped = cap > 0 && out.length > cap
  if (capped) out = out.slice(0, cap)

  return {
    labelKey,
    colByKey,
    dataLabels: !!c.dataLabels && usesDataLabels(viz),
    seriesKeys,
    lineKeys,
    barKeys,
    rows: out,
    stacked: !!c.stacked,
    rightAxis: !!c.rightAxis,
    legend: c.legend,
    capped,
    totalRows: rows.length,
  }
}

/** Strip keys a given visual cannot use, so a config does not carry settings that silently
 *  do nothing after the kind is changed. */
export function pruneForViz(viz: string, cfg: TileVizConfig): TileVizConfig {
  const out: TileVizConfig = { ...cfg }
  if (!usesCategory(viz)) { delete out.label; delete out.stacked; delete out.topN }
  if (viz !== 'combo') { delete out.lines; delete out.rightAxis }
  if (viz !== 'kpi') { delete out.compare }
  if (viz !== 'matrix') { delete out.colBy }
  if (!usesDataLabels(viz)) { delete out.dataLabels }
  // A target and its colouring go together, and both go where the visual cannot show
  // them: a line's colour belongs to its series, so recolouring segments of one line
  // would read as several lines.
  if (!usesGoalColour(viz)) {
    delete out.goal; delete out.colorByGoal; delete out.goalGood; delete out.goalCol
  }
  if (maxSeries(viz) === 1 && out.values && out.values.length > 1) {
    out.values = out.values.slice(0, 1)
  }
  if (viz === 'table') { delete out.values; delete out.label; delete out.legend }
  return out
}
