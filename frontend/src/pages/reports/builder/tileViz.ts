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
  /** KPI only: a second column to compare the figure against, and a fixed target. */
  compare?: string
  goal?: number
  /** Written by the renderer before field wells existed. Read, never written now. */
  value?: string
}

export type VizKind = 'kpi' | 'bar' | 'line' | 'area' | 'donut' | 'table' | 'barh' | 'combo' | 'funnel'

/** Every kind the dashboard can draw. Must match dashVizKinds in the Go handler and the
 *  CHECK constraint from migration 381 — a kind in one and not the others is a blank tile. */
export const VIZ_KINDS: VizKind[] = [
  'table', 'bar', 'barh', 'line', 'area', 'combo', 'donut', 'funnel', 'kpi',
]

export const VIZ_META: Record<VizKind, { label: string; icon: string; note: string; multi: boolean }> = {
  table: { label: 'Table', icon: 'table_rows', multi: false,
    note: 'Every column you picked, scrollable inside the tile.' },
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
  kpi: { label: 'Single Figure', icon: 'numbers', multi: false,
    note: 'One number, large. Add a comparison to show the change beside it.' },
}

/** Does this visual read a category column at all? A KPI does not. */
export function usesCategory(viz: string): boolean {
  return viz !== 'kpi'
}

/** How many series this visual can draw. */
export function maxSeries(viz: string): number {
  return VIZ_META[viz as VizKind]?.multi ? 8 : 1
}

/** The default row cap per visual, when the config names no topN. These match what the
 *  renderer has always done: a donut of 40 slices is a colour wheel, not a chart. */
export function defaultCap(viz: string): number {
  if (viz === 'donut') return 8
  if (viz === 'funnel') return 10
  if (viz === 'table' || viz === 'kpi') return 0 // 0 = no cap
  return 40
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
  if (viz !== 'kpi') { delete out.compare; delete out.goal }
  if (maxSeries(viz) === 1 && out.values && out.values.length > 1) {
    out.values = out.values.slice(0, 1)
  }
  if (viz === 'table') { delete out.values; delete out.label; delete out.legend }
  return out
}
