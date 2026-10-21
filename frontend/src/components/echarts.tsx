// ─────────────────────────────────────────────────────────────────────────────
// ECharts wrapper — the workspace's chart toolkit for the Recharts→ECharts port.
//
// Why a wrapper: ECharts draws to <canvas>, so it can't read our CSS custom
// properties the way Recharts' SVG does. `useChartTokens` resolves the live
// token values (card, borders, text, grid, chart labels) from the DOM and
// re-reads them on every render, so charts stay in lock-step with light/dark for
// free. Text renders in Segoe (the app's family); the tooltip mirrors the
// existing <ChartTooltip> "Rails" card (rounded, soft shadow, colour-dot rows).
//
// Components: EBar (single / grouped / stacked), EArea, ELine, EDonut. For
// anything bespoke, use the exported <EChart option={…}> with the token helpers
// (useChartTokens, baseTooltip, tipCard, axisCat, axisVal, CHART_FONT).
//
// CLICKING A CHART IS OPT-IN. `onPick` (and `activeCat`, which dims everything
// else) exist for the dashboard's cross-filtering. Every chart on every page that
// passes neither renders byte-for-byte what it rendered before: no cursor change,
// no click handler bound, no per-datum objects in the series data. That matters
// here more than usual — this file is imported by around fifty pages.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
// Only for registerMap, which is the one thing echarts-for-react does not expose. It
// already pulls the full library in, so this import adds nothing to the bundle.
import * as echarts from 'echarts'

// Canvas can't read CSS vars, so mirror --font-sans as a concrete family (Segoe).
export const CHART_FONT = "var(--font-sans)"

export type ChartTokens = {
  card: string; bdr: string; txt: string; txt2: string; txt3: string
  grid: string; lbl: string; rowHvr: string; shadow: string
}

const FALLBACK: ChartTokens = {
  card: '#FFFFFF', bdr: '#E8EBF2', txt: '#0F1623', txt2: '#4C5865', txt3: '#697585',
  grid: '#E8EBF2', lbl: '#9AA4B8', rowHvr: '#F8F9FC',
  shadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 18px rgba(0,0,0,0.05)',
}

// Resolves the live CSS token values from a DOM node. The theme vars live on :root,
// so any element (including the document root) yields the correct values.
function readTokens(el: Element | null): ChartTokens {
  if (!el || typeof getComputedStyle !== 'function') return FALLBACK
  const cs = getComputedStyle(el)
  const get = (k: string, fb: string) => cs.getPropertyValue(k).trim() || fb
  return {
    card: get('--card', FALLBACK.card),
    bdr: get('--bdr', FALLBACK.bdr),
    txt: get('--txt', FALLBACK.txt),
    txt2: get('--txt2', FALLBACK.txt2),
    txt3: get('--txt3', FALLBACK.txt3),
    grid: get('--chart-grid', FALLBACK.grid),
    lbl: get('--chart-lbl', FALLBACK.lbl),
    rowHvr: get('--row-hvr', FALLBACK.rowHvr),
    shadow: get('--card-shadow', FALLBACK.shadow),
  }
}

// Reads the resolved CSS tokens. Initialised from :root synchronously so a chart
// paints in the correct theme on its FIRST frame (no light→dark flash / redraw),
// then refined from the chart's own node. No dep array → a theme toggle (which
// rewrites the vars) is picked up automatically; the equality guard stops the
// update once values are stable, so there's no render loop.
export function useChartTokens(ref: React.RefObject<HTMLElement>): ChartTokens {
  const [tokens, setTokens] = useState<ChartTokens>(() =>
    readTokens(typeof document !== 'undefined' ? document.documentElement : null),
  )
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const next = readTokens(el)
    setTokens((prev) =>
      (Object.keys(next) as (keyof ChartTokens)[]).some((k) => prev[k] !== next[k]) ? next : prev,
    )
  })
  return tokens
}

// Tooltip titles, series names and values often come straight from data (a customer's
// name, a free-text disposition), and ECharts renders the formatter's string as HTML,
// so every interpolated piece is escaped before it goes in.
const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The rounded "Rails" tooltip card, as an HTML string for ECharts' formatter.
export function tipCard(t: ChartTokens, title: string | null, rows: { color: string; name?: string; value: string }[]) {
  const head = title
    ? `<div style="font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${t.txt3};padding-bottom:7px;margin-bottom:7px;border-bottom:1px solid ${t.bdr}">${escapeHtml(title)}</div>`
    : ''
  const body = rows
    .map((r) => {
      const nm = r.name
        ? `<span style="font-size:12px;color:${t.txt2};flex:1;white-space:nowrap">${escapeHtml(r.name)}</span>`
        : ''
      return `<div style="display:flex;align-items:center;gap:9px">
        <span style="width:9px;height:9px;border-radius:3px;background:${escapeHtml(r.color)};flex-shrink:0"></span>
        ${nm}
        <span style="font-size:13px;font-weight:700;color:${t.txt};font-variant-numeric:tabular-nums;margin-left:${r.name ? 'auto' : '0'}">${escapeHtml(r.value)}</span>
      </div>`
    })
    .join('')
  return `<div style="font-family:${CHART_FONT};padding:10px 12px;min-width:150px">
    ${head}<div style="display:flex;flex-direction:column;gap:7px">${body}</div></div>`
}

export function baseTooltip(t: ChartTokens) {
  return {
    backgroundColor: t.card,
    borderColor: t.bdr,
    borderWidth: 1,
    padding: 0,
    // Render into <body> so the card is never clipped by a small chart container.
    appendToBody: true,
    confine: true,
    extraCssText: `border-radius:10px;box-shadow:${t.shadow};z-index:9999;`,
    textStyle: { color: t.txt, fontFamily: CHART_FONT },
  }
}

// Shared axis configs.
export const axisCat = (t: ChartTokens, categories: any[], fontSize = 11) => ({
  type: 'category' as const, data: categories, boundaryGap: true,
  axisLine: { show: false }, axisTick: { show: false },
  // 'auto' shows every label when they fit (months, channels, buckets) and thins
  // them to avoid overlap on dense series (daily trends over a long range).
  axisLabel: { color: t.lbl, fontSize, fontFamily: CHART_FONT, interval: 'auto', hideOverlap: true },
})
export const axisVal = (t: ChartTokens, fmt?: (v: number) => string) => ({
  type: 'value' as const,
  axisLine: { show: false }, axisTick: { show: false },
  axisLabel: { color: t.lbl, fontSize: 10, fontFamily: CHART_FONT, formatter: fmt ? (v: number) => fmt(v) : undefined },
  splitLine: { lineStyle: { color: t.grid } },
})

const legendCfg = (t: ChartTokens, pos: 'top' | 'bottom' = 'top') => ({
  [pos]: 0, right: pos === 'top' ? 0 : undefined, left: pos === 'bottom' ? 'center' : undefined,
  icon: 'circle', itemWidth: 8, itemHeight: 8, itemGap: 14,
  textStyle: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT },
})

// Soft top→transparent area gradient. Uses rgba() (not 8-digit hex, which ECharts'
// canvas colour parser doesn't reliably accept — that silently drops the fill).
const grad = (hex: string) => {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return {
    type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [{ offset: 0, color: `rgba(${r},${g},${b},0.22)` }, { offset: 1, color: `rgba(${r},${g},${b},0.02)` }],
  }
}

// Raw chart — for bespoke option objects. `option` may be a plain object or a
// function of the resolved tokens (so it re-themes with light/dark automatically).
// `onEvents` is passed straight to echarts-for-react; omitted, nothing is bound.
export function EChart({ option, height, onEvents }: {
  option: any | ((t: ChartTokens) => any)
  height: number
  onEvents?: Record<string, (p: any) => void>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const tokens = useChartTokens(ref)
  const opt = useMemo(() => (typeof option === 'function' ? option(tokens) : option), [option, tokens])
  return (
    <div ref={ref} style={{ width: '100%', height }}>
      <ReactECharts option={opt} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate
        opts={{ renderer: 'canvas' }} onEvents={onEvents} />
    </div>
  )
}

// ── Clicking a datum ─────────────────────────────────────────────────────────
// What a click hands back is the ROW'S OWN VALUE at the category key, looked up in
// the caller's data by dataIndex — never ECharts' rendered label. The label is a
// string the axis may have formatted or truncated; filtering on it would match
// nothing, silently. A chart with no onPick binds no handler at all.
export type Pick<T> = (value: unknown, row: T, index: number) => void

function pickEvents<T extends Record<string, any>>(data: T[], key: keyof T, onPick?: Pick<T>) {
  if (!onPick) return undefined
  return {
    click: (p: any) => {
      const row = data[p?.dataIndex]
      if (!row) return
      onPick(row[key], row, p.dataIndex)
    },
  }
}

// The opacity one datum should draw at: faded when a category is selected and this is
// not it, undefined otherwise. Returning undefined rather than 1 is what lets the charts
// keep their plain series data (a bare number per point) when nothing is selected.
const DIM = 0.25
function dimOf(activeCat: unknown, v: unknown): number | undefined {
  if (activeCat === undefined || activeCat === null || activeCat === '') return undefined
  return String(v ?? '') === String(activeCat) ? undefined : DIM
}

// The same test as a per-row function, or undefined when nothing is selected — the
// charts that build series through `seriesRow` branch on its presence.
function dimmer<T extends Record<string, any>>(data: T[], key: keyof T, activeCat: unknown) {
  if (activeCat === undefined || activeCat === null || activeCat === '') return undefined
  return (row: T, _i?: number) => dimOf(activeCat, row[key])
}

// One plotted metric. `color` is a flat colour; `colorFn` gives per-datum colour;
// `fmt` overrides the chart's valueFmt for this series' tooltip (dual-unit charts).
export type Series<T> = { key: keyof T; name?: string; color?: string; colorFn?: (row: T, i: number) => string; fmt?: (v: number) => string }

// Shared axis-tooltip formatter: title = category, one row per series, each using
// its own `fmt` if set, else the chart-wide valueFmt.
const axisTip = <T,>(t: ChartTokens, series: Series<T>[], valueFmt: (v: number) => string) =>
  (ps: any[]) => tipCard(t, String(ps[0].axisValue), ps.map((p) => {
    const s = series.find((x) => (x.name ?? String(x.key)) === p.seriesName)
    return { color: p.color, name: series.length > 1 ? p.seriesName : undefined, value: (s?.fmt ?? valueFmt)(Number(p.value)) }
  }))

// Values printed on the chart itself. Opt-in: a dense series labelled at every point is
// unreadable, so this is a caller's decision, never a default. hideOverlap drops the ones
// that would collide rather than stacking text on text.
export function valueLabel(t: ChartTokens, position: 'top' | 'right' | 'inside', fmt: (v: number) => string) {
  return {
    show: true,
    position,
    // Inside a bar the label sits on the series colour, so it has to be light; outside it
    // sits on the card and takes the normal text token.
    color: position === 'inside' ? '#fff' : t.txt2,
    fontSize: 10, fontFamily: CHART_FONT,
    formatter: (p: any) => (typeof p.value === 'number' ? fmt(p.value) : ''),
    hideOverlap: true,
  }
}

function seriesRow<T extends Record<string, any>>(
  kind: 'bar' | 'line' | 'area', data: T[], s: Series<T>, extra: any = {},
  dim?: (row: T, i: number) => number | undefined,
) {
  const name = s.name ?? String(s.key)
  if (kind === 'bar') {
    const br = [4, 4, 0, 0]
    return {
      type: 'bar', name, barMaxWidth: 40,
      itemStyle: { borderRadius: br, color: s.color },
      data: data.map((d, i) => {
        const o = dim?.(d, i)
        if (!s.colorFn && o === undefined) return d[s.key]
        return {
          value: d[s.key],
          itemStyle: {
            ...(s.colorFn ? { color: s.colorFn(d, i) } : {}),
            borderRadius: br,
            ...(o === undefined ? {} : { opacity: o }),
          },
        }
      }),
      ...extra,
    }
  }
  // line / area. A continuous line cannot be half faded — dimming the unselected
  // stretches would just make the line look broken — so the selected point is
  // marked instead, which is also the only readable cue on a dense date axis.
  return {
    type: 'line', name, smooth: true, smoothMonotone: 'x', showSymbol: !!dim,
    lineStyle: { width: 2.5, color: s.color }, itemStyle: { color: s.color },
    areaStyle: kind === 'area' && s.color ? { color: grad(s.color) } : undefined,
    data: dim
      ? data.map((d, i) => ({ value: d[s.key], symbolSize: dim(d, i) === undefined ? 9 : 0 }))
      : data.map((d) => d[s.key]),
    ...extra,
  }
}

// ── Vertical bar — single, grouped, or stacked ───────────────────────────────
export function EBar<T extends Record<string, any>>({
  data, xKey, series, stack = false, height = 200, legend,
  valueFmt = (v) => String(v), axisFmt, xTickSize = 11, leftMargin = 8, onPick, activeCat,
  labels = false,
}: {
  data: T[]
  xKey: keyof T
  series: Series<T>[]
  stack?: boolean
  height?: number
  legend?: boolean          // default: auto (on when >1 series). Set false to suppress.
  valueFmt?: (v: number) => string
  axisFmt?: (v: number) => string
  xTickSize?: number
  leftMargin?: number
  onPick?: Pick<T>          // opt-in: makes a column clickable
  activeCat?: unknown       // the picked category, drawn solid while the rest fade
  labels?: boolean          // print each value on the chart
}) {
  const showLegend = legend ?? series.length > 1
  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => {
      const dim = dimmer(data, xKey, activeCat)
      return {
        grid: { top: showLegend ? 30 : 14, right: 12, bottom: 24, left: leftMargin, containLabel: true },
        legend: showLegend ? legendCfg(t) : undefined,
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
          formatter: axisTip(t, series, valueFmt),
        },
        xAxis: axisCat(t, data.map((d) => d[xKey]), xTickSize),
        yAxis: axisVal(t, axisFmt),
        series: series.map((s) => seriesRow('bar', data, s, {
          ...(stack ? { stack: 'total' } : {}), ...(clickable ? { cursor: 'pointer' } : {}),
          ...(labels ? { label: valueLabel(t, stack ? 'inside' : 'top', s.fmt ?? valueFmt) } : {}),
        }, dim)),
        animationDuration: 700,
      }
    },
    [data, xKey, series, stack, showLegend, valueFmt, axisFmt, xTickSize, leftMargin, clickable, activeCat, labels],
  )
  return <EChart option={option} height={height} onEvents={pickEvents(data, xKey, onPick)} />
}

// The "Rails" endpoint chip: stamps a series' last value at the line's end.
function endChip(t: ChartTokens, color: string | undefined, fmt: (v: number) => string) {
  return {
    show: true, formatter: (p: any) => fmt(Number(p.value)),
    color: color, fontSize: 11, fontWeight: 700, fontFamily: CHART_FONT,
    backgroundColor: t.card, borderColor: color, borderWidth: 1, borderRadius: 9, padding: [3, 7],
  }
}

// ── Smooth area (gradient fill) ──────────────────────────────────────────────
export function EArea<T extends Record<string, any>>({
  data, xKey, series, stack = false, height = 220, endLabel = false, endFmt, dots = false, hideYAxis = false,
  valueFmt = (v) => String(v), axisFmt, xTickSize = 11, leftMargin = 8, onPick, activeCat, labels = false,
}: {
  data: T[]; xKey: keyof T; series: Series<T>[]; stack?: boolean; height?: number
  endLabel?: boolean; endFmt?: (v: number) => string; dots?: boolean; hideYAxis?: boolean
  valueFmt?: (v: number) => string; axisFmt?: (v: number) => string; xTickSize?: number; leftMargin?: number
  onPick?: Pick<T>; activeCat?: unknown; labels?: boolean
}) {
  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => {
      const cat = axisCat(t, data.map((d) => d[xKey]), xTickSize)
      const dim = dimmer(data, xKey, activeCat)
      return {
        grid: { top: series.length > 1 ? 30 : 14, right: endLabel ? 80 : 14, bottom: 24, left: leftMargin, containLabel: true },
        legend: series.length > 1 && !endLabel ? legendCfg(t) : undefined,
        tooltip: { trigger: 'axis', ...baseTooltip(t), formatter: axisTip(t, series, valueFmt) },
        // boundaryGap:false makes the area span edge-to-edge; align the first/last
        // labels inward so a month centred on the plot edge isn't half clipped.
        xAxis: { ...cat, boundaryGap: false, axisLabel: { ...cat.axisLabel, alignMinLabel: 'left', alignMaxLabel: 'right' } },
        yAxis: hideYAxis ? { ...axisVal(t, axisFmt), axisLabel: { show: false } } : axisVal(t, axisFmt),
        series: series.map((s) => seriesRow('area', data, s, {
          ...(stack ? { stack: 'total' } : {}),
          ...(dots ? { showSymbol: true, symbolSize: 5 } : {}),
          ...(endLabel ? { endLabel: endChip(t, s.color, endFmt ?? s.fmt ?? valueFmt) } : {}),
          // A line series reports a click only when the pointer lands on a symbol,
          // and symbols are off by default — so the line itself becomes the target.
          ...(clickable ? { cursor: 'pointer', triggerLineEvent: true } : {}),
          ...(labels ? { label: valueLabel(t, 'top', s.fmt ?? valueFmt) } : {}),
        }, dim)),
        animationDuration: 700,
      }
    },
    [data, xKey, series, stack, endLabel, endFmt, dots, hideYAxis, valueFmt, axisFmt, xTickSize, leftMargin, clickable, activeCat, labels],
  )
  return <EChart option={option} height={height} onEvents={pickEvents(data, xKey, onPick)} />
}

// ── Smooth multi-series line ─────────────────────────────────────────────────
export function ELine<T extends Record<string, any>>({
  data, xKey, series, height = 220, endLabel = false, endFmt, hideYAxis = false,
  valueFmt = (v) => String(v), axisFmt, xTickSize = 11, leftMargin = 8, onPick, activeCat, labels = false,
}: {
  data: T[]; xKey: keyof T; series: Series<T>[]; height?: number
  endLabel?: boolean; endFmt?: (v: number) => string; hideYAxis?: boolean
  valueFmt?: (v: number) => string; axisFmt?: (v: number) => string; xTickSize?: number; leftMargin?: number
  onPick?: Pick<T>; activeCat?: unknown; labels?: boolean
}) {
  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => ({
      grid: { top: series.length > 1 && !endLabel ? 30 : 14, right: endLabel ? 80 : 14, bottom: 24, left: leftMargin, containLabel: true },
      legend: series.length > 1 && !endLabel ? legendCfg(t) : undefined,
      tooltip: {
        trigger: 'axis', ...baseTooltip(t),
        formatter: axisTip(t, series, valueFmt),
      },
      xAxis: { ...axisCat(t, data.map((d) => d[xKey]), xTickSize), boundaryGap: false },
      yAxis: hideYAxis ? { ...axisVal(t, axisFmt), axisLabel: { show: false } } : axisVal(t, axisFmt),
      series: series.map((s) => seriesRow('line', data, s, {
        ...(endLabel ? { endLabel: endChip(t, s.color, endFmt ?? s.fmt ?? valueFmt) } : {}),
        ...(clickable ? { cursor: 'pointer', triggerLineEvent: true } : {}),
        ...(labels ? { label: valueLabel(t, 'top', s.fmt ?? valueFmt) } : {}),
      }, dimmer(data, xKey, activeCat))),
      animationDuration: 700,
    }),
    [data, xKey, series, endLabel, endFmt, hideYAxis, valueFmt, axisFmt, xTickSize, leftMargin, clickable, activeCat, labels],
  )
  return <EChart option={option} height={height} onEvents={pickEvents(data, xKey, onPick)} />
}

// ── Horizontal bar — ranked categories (long labels) ─────────────────────────
export function EBarH<T extends Record<string, any>>({
  data, catKey, series, height = 260, legend, barMax = 24,
  valueFmt = (v) => String(v), axisFmt, onPick, activeCat, labels = false,
}: {
  data: T[]
  catKey: keyof T
  series: Series<T>[]
  height?: number
  legend?: boolean
  barMax?: number
  valueFmt?: (v: number) => string
  axisFmt?: (v: number) => string
  onPick?: Pick<T>
  activeCat?: unknown
  labels?: boolean
}) {
  const showLegend = legend ?? series.length > 1
  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => {
      const dim = dimmer(data, catKey, activeCat)
      const br = [0, 4, 4, 0]
      return {
        grid: { top: showLegend ? 28 : 8, right: 16, bottom: 8, left: 8, containLabel: true },
        legend: showLegend ? legendCfg(t) : undefined,
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
          formatter: axisTip(t, series, valueFmt),
        },
        xAxis: axisVal(t, axisFmt),
        yAxis: {
          type: 'category', inverse: true, data: data.map((d) => d[catKey]),
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: t.lbl, fontSize: 11, fontFamily: CHART_FONT },
        },
        series: series.map((s) => ({
          type: 'bar', name: s.name ?? String(s.key), barMaxWidth: barMax,
          itemStyle: { borderRadius: br, color: s.color },
          ...(clickable ? { cursor: 'pointer' } : {}),
          ...(labels ? { label: valueLabel(t, 'right', s.fmt ?? valueFmt) } : {}),
          data: data.map((d, i) => {
            const o = dim?.(d, i)
            if (!s.colorFn && o === undefined) return d[s.key]
            return {
              value: d[s.key],
              itemStyle: {
                ...(s.colorFn ? { color: s.colorFn(d, i) } : {}),
                borderRadius: br,
                ...(o === undefined ? {} : { opacity: o }),
              },
            }
          }),
        })),
        animationDuration: 700,
      }
    },
    [data, catKey, series, showLegend, barMax, valueFmt, axisFmt, clickable, activeCat, labels],
  )
  return <EChart option={option} height={height} onEvents={pickEvents(data, catKey, onPick)} />
}

// ── Donut — hover-expand slice; center label OR legend ───────────────────────
export function EDonut<T extends Record<string, any>>({
  data, valueKey, nameKey, colorFn, size = 148, inner = 42, outer = 66, centerSize = 18,
  centerValue, centerLabel, legend = false, valueFmt = (v) => String(v), nameFmt, showPercent = true,
  onPick, activeCat,
}: {
  data: T[]
  valueKey: keyof T
  nameKey: keyof T
  colorFn: (row: T, i: number) => string
  size?: number
  inner?: number
  outer?: number
  centerSize?: number
  centerValue?: string
  centerLabel?: string
  legend?: boolean
  valueFmt?: (v: number) => string
  nameFmt?: (name: any) => string
  showPercent?: boolean
  onPick?: Pick<T>
  activeCat?: unknown
}) {
  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => ({
      tooltip: {
        trigger: 'item', ...baseTooltip(t),
        formatter: (p: any) => tipCard(t, null, [{ color: p.color, name: nameFmt ? nameFmt(p.name) : p.name, value: showPercent ? `${valueFmt(Number(p.value))} · ${p.percent}%` : valueFmt(Number(p.value)) }]),
      },
      legend: legend ? legendCfg(t, 'bottom') : undefined,
      // Centre label — graphic text renders on top of the ring; textVerticalAlign
      // 'middle' means `top` is the text's centre, so the two lines sit in the hole
      // regardless of centerSize.
      graphic: centerValue
        ? [
            {
              type: 'text', left: 'center', top: (legend ? size * 0.42 : size / 2) - (centerLabel ? 8 : 0),
              style: { text: centerValue, fill: t.txt, fontSize: centerSize, fontWeight: 800, fontFamily: CHART_FONT, textAlign: 'center', textVerticalAlign: 'middle' },
            },
            ...(centerLabel
              ? [{
                  type: 'text', left: 'center', top: (legend ? size * 0.42 : size / 2) + 9,
                  style: { text: centerLabel, fill: t.txt2, fontSize: 9, fontFamily: CHART_FONT, textAlign: 'center', textVerticalAlign: 'middle' },
                }]
              : []),
          ]
        : undefined,
      series: [
        {
          type: 'pie',
          // Cap the outer radius so the hover-expand (emphasis.scale) has room to grow
          // outward without being clipped at the canvas edge.
          radius: [inner, Math.min(outer, size / 2 - 12)],
          center: ['50%', legend ? '44%' : '50%'],
          startAngle: 90,
          padAngle: 3,
          itemStyle: { borderRadius: 3 },
          label: { show: false },
          labelLine: { show: false },
          ...(clickable ? { cursor: 'pointer' } : {}),
          data: data.map((d, i) => {
            const o = dimOf(activeCat, d[nameKey])
            return {
              name: d[nameKey], value: d[valueKey],
              itemStyle: { color: colorFn(d, i), ...(o === undefined ? {} : { opacity: o }) },
            }
          }),
          emphasis: { scale: true, scaleSize: 8, itemStyle: { shadowBlur: 10, shadowColor: 'rgba(8,15,35,0.22)' } },
        },
      ],
      animationDuration: 700,
    }),
    [data, valueKey, nameKey, colorFn, size, inner, outer, centerSize, centerValue, centerLabel, legend, valueFmt, nameFmt, showPercent, clickable, activeCat],
  )
  return <EChart option={option} height={size} onEvents={pickEvents(data, nameKey, onPick)} />
}

// ── Funnel — pipeline / stage conversion ─────────────────────────────────────
export function EFunnel<T extends Record<string, any>>({
  data, nameKey, valueKey, colorFn, height = 240, valueFmt = (v) => String(v), showValueLabel = true,
  onPick, activeCat,
}: {
  data: T[]
  nameKey: keyof T
  valueKey: keyof T
  colorFn?: (row: T, i: number) => string
  height?: number
  valueFmt?: (v: number) => string
  showValueLabel?: boolean
  onPick?: Pick<T>
  activeCat?: unknown
}) {
  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => ({
      tooltip: {
        trigger: 'item', ...baseTooltip(t),
        formatter: (p: any) => tipCard(t, null, [{ color: p.color, name: p.name, value: valueFmt(Number(p.value)) }]),
      },
      series: [
        {
          type: 'funnel', left: '6%', right: '6%', top: 8, bottom: 8, minSize: '16%', gap: 2, sort: 'descending',
          label: {
            show: true, position: 'inside', color: '#fff', fontFamily: CHART_FONT, fontSize: 11, fontWeight: 600,
            formatter: (p: any) => (showValueLabel ? `${p.name}  ${valueFmt(Number(p.value))}` : `${p.name}`),
          },
          labelLine: { show: false },
          itemStyle: { borderColor: t.card, borderWidth: 2 },
          emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(8,15,35,0.22)' } },
          ...(clickable ? { cursor: 'pointer' } : {}),
          data: data.map((d, i) => {
            const o = dimOf(activeCat, d[nameKey])
            return {
              name: String(d[nameKey]), value: Number(d[valueKey]),
              itemStyle: {
                ...(colorFn ? { color: colorFn(d, i) } : {}),
                ...(o === undefined ? {} : { opacity: o }),
              },
            }
          }),
        },
      ],
      animationDuration: 700,
    }),
    [data, nameKey, valueKey, colorFn, valueFmt, showValueLabel, clickable, activeCat],
  )
  return <EChart option={option} height={height} onEvents={pickEvents(data, nameKey, onPick)} />
}

// ── Combo — bars / areas + line(s), optional right axis ──────────────────────
export function ECombo<T extends Record<string, any>>({
  data, xKey, bars = [], areas = [], lines = [], height = 240, legend,
  valueFmt = (v) => String(v), axisFmt, rightAxis = false, rightFmt, stack = false, xTickSize = 11, leftMargin = 8,
  onPick, activeCat, labels = false,
}: {
  data: T[]
  xKey: keyof T
  bars?: Series<T>[]
  areas?: Series<T>[]          // gradient area(s) on the left axis
  lines?: Series<T>[]
  height?: number
  legend?: boolean
  valueFmt?: (v: number) => string
  axisFmt?: (v: number) => string
  rightAxis?: boolean          // put the line series on a secondary right axis
  rightFmt?: (v: number) => string
  stack?: boolean              // stack the bar series
  xTickSize?: number
  leftMargin?: number
  onPick?: Pick<T>
  activeCat?: unknown
  labels?: boolean
}) {
  const allSeries = [...bars, ...areas, ...lines]
  const showLegend = legend ?? allSeries.length > 1
  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => ({
      grid: { top: showLegend ? 30 : 14, right: rightAxis ? 48 : 14, bottom: 24, left: leftMargin, containLabel: true },
      legend: showLegend ? legendCfg(t) : undefined,
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
        formatter: axisTip(t, allSeries, valueFmt),
      },
      xAxis: { ...axisCat(t, data.map((d) => d[xKey]), xTickSize), boundaryGap: areas.length > 0 ? false : true },
      yAxis: rightAxis
        ? [axisVal(t, axisFmt), { ...axisVal(t, rightFmt ?? axisFmt), splitLine: { show: false } }]
        : axisVal(t, axisFmt),
      series: [
        ...bars.map((s) => seriesRow('bar', data, s, {
          ...(stack ? { stack: 'total' } : {}), ...(clickable ? { cursor: 'pointer' } : {}),
          ...(labels ? { label: valueLabel(t, stack ? 'inside' : 'top', s.fmt ?? valueFmt) } : {}),
        }, dimmer(data, xKey, activeCat))),
        ...areas.map((s) => seriesRow('area', data, s, {
          ...(clickable ? { cursor: 'pointer', triggerLineEvent: true } : {}),
          ...(labels ? { label: valueLabel(t, 'top', s.fmt ?? valueFmt) } : {}),
        }, dimmer(data, xKey, activeCat))),
        ...lines.map((s) => ({
          ...seriesRow('line', data, s, {
            ...(clickable ? { cursor: 'pointer', triggerLineEvent: true } : {}),
            ...(labels ? { label: valueLabel(t, 'top', s.fmt ?? valueFmt) } : {}),
          }, dimmer(data, xKey, activeCat)),
          yAxisIndex: rightAxis ? 1 : 0,
        })),
      ],
      animationDuration: 700,
    }),
    [data, xKey, bars, areas, lines, showLegend, valueFmt, axisFmt, rightAxis, rightFmt, stack, xTickSize, leftMargin, clickable, activeCat, labels],
  )
  return <EChart option={option} height={height} onEvents={pickEvents(data, xKey, onPick)} />
}

// ── Scatter — two measures against each other ────────────────────────────────
// One point per row, so this is the one chart where MORE points is the point: the shape
// of the cloud is the finding. `nameKey` names a point in its tooltip (a state, an
// officer) — it is not an axis, so there is no category to click; a scatter filters by
// nothing and says what each dot is.
export function EScatter<T extends Record<string, any>>({
  data, xKey, yKey, nameKey, height = 240, color,
  xFmt = (v) => String(v), yFmt = (v) => String(v), xLabel, yLabel, symbolSize = 9,
}: {
  data: T[]
  xKey: keyof T
  yKey: keyof T
  nameKey?: keyof T
  height?: number
  color?: string
  xFmt?: (v: number) => string
  yFmt?: (v: number) => string
  xLabel?: string
  yLabel?: string
  symbolSize?: number
}) {
  const option = useMemo(
    () => (t: ChartTokens) => ({
      // Room at the bottom and left for the axis names, which a scatter needs in a way a
      // category chart does not: without them two numeric axes are unreadable.
      grid: { top: 14, right: 18, bottom: yLabel || xLabel ? 34 : 24, left: 8, containLabel: true },
      tooltip: {
        trigger: 'item', ...baseTooltip(t),
        formatter: (p: any) => {
          const row = data[p.dataIndex]
          const title = nameKey && row ? String(row[nameKey] ?? '') : null
          return tipCard(t, title || null, [
            { color: p.color, name: xLabel ?? String(xKey), value: xFmt(Number(p.value?.[0])) },
            { color: p.color, name: yLabel ?? String(yKey), value: yFmt(Number(p.value?.[1])) },
          ])
        },
      },
      xAxis: {
        ...axisVal(t, xFmt), scale: true,
        name: xLabel, nameLocation: 'middle', nameGap: 26,
        nameTextStyle: { color: t.txt3, fontSize: 10.5, fontFamily: CHART_FONT },
      },
      yAxis: {
        ...axisVal(t, yFmt), scale: true,
        name: yLabel, nameLocation: 'middle', nameGap: 42,
        nameTextStyle: { color: t.txt3, fontSize: 10.5, fontFamily: CHART_FONT },
      },
      series: [
        {
          type: 'scatter', symbolSize,
          itemStyle: { color: color, opacity: 0.75 },
          emphasis: { itemStyle: { opacity: 1, shadowBlur: 8, shadowColor: 'rgba(8,15,35,0.25)' } },
          data: data.map((d) => [d[xKey], d[yKey]]),
        },
      ],
      animationDuration: 700,
    }),
    [data, xKey, yKey, nameKey, color, xFmt, yFmt, xLabel, yLabel, symbolSize],
  )
  return <EChart option={option} height={height} />
}

// ── Nigeria, by state ────────────────────────────────────────────────────────
//
// THE BOUNDARY FILE IS FETCHED, NOT BUNDLED. It is 107 KB of coordinates that only a
// board with a map tile needs, so bundling it would charge every page in the workspace
// for a visual almost none of them draw. It is fetched once per page load and registered
// with ECharts; a second map tile on the same board reuses the registration.
//
// WHY THE STATE NAMES LINE UP. The file's `name` is the canonical state name — the same
// 37 values app.canon_state folds every spelling onto (migration 376, and 383 for the
// speed), with "Abuja Federal Capital Territory" renamed to FCT to match. That is what
// makes a choropleth honest here: a report's states and the map's states are the same
// list, so a state failing to colour means no data, never a spelling mismatch.
//
// The geometry is simplified to about 550 m of detail, which is a quarter of a pixel at
// the size a tile draws. Each state was simplified on its own, so a shared border can
// drift by that much on each side; pushing the tolerance further opens visible slivers
// between neighbours.
export const NIGERIA_MAP = 'o3c-nigeria-states'
const NIGERIA_GEO_URL = '/geo/nigeria-states.json'

let nigeriaMapLoad: Promise<boolean> | null = null
function loadNigeriaMap(): Promise<boolean> {
  if (!nigeriaMapLoad) {
    nigeriaMapLoad = fetch(NIGERIA_GEO_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((geo) => { echarts.registerMap(NIGERIA_MAP, geo); return true })
      .catch(() => {
        // Clear the memo so a later tile can try again rather than every map on the
        // board being permanently dead because one request failed.
        nigeriaMapLoad = null
        return false
      })
  }
  return nigeriaMapLoad
}

export function ENigeriaMap<T extends Record<string, any>>({
  data, nameKey, valueKey, height = 280, valueFmt = (v) => String(v),
  low = '#E3E8EF', high = '#0E2841', onPick, activeCat,
}: {
  data: T[]
  nameKey: keyof T
  valueKey: keyof T
  height?: number
  valueFmt?: (v: number) => string
  low?: string
  high?: string
  onPick?: Pick<T>
  activeCat?: unknown
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => {
    let alive = true
    loadNigeriaMap().then((ok) => { if (alive) setState(ok ? 'ready' : 'failed') })
    return () => { alive = false }
  }, [])

  const clickable = !!onPick
  const option = useMemo(
    () => (t: ChartTokens) => {
      const vals = data.map((d) => Number(d[valueKey])).filter((v) => Number.isFinite(v))
      const min = vals.length ? Math.min(...vals) : 0
      const max = vals.length ? Math.max(...vals) : 1
      return {
        tooltip: {
          trigger: 'item', ...baseTooltip(t),
          formatter: (p: any) => tipCard(t, String(p.name), [{
            color: p.color,
            // A state the report returned no row for is not zero — it is unknown, and
            // saying "No data" is the difference between the two.
            value: p.value === undefined || p.value === null || Number.isNaN(p.value)
              ? 'No data' : valueFmt(Number(p.value)),
          }]),
        },
        visualMap: {
          type: 'continuous', min, max: max === min ? min + 1 : max,
          left: 4, bottom: 4, orient: 'vertical', itemWidth: 8, itemHeight: 64,
          calculable: false, inRange: { color: [low, high] },
          text: [valueFmt(max), valueFmt(min)],
          textStyle: { color: t.txt3, fontSize: 9.5, fontFamily: CHART_FONT },
        },
        series: [
          {
            type: 'map', map: NIGERIA_MAP, nameProperty: 'name', roam: false,
            left: 6, right: 6, top: 6, bottom: 6,
            ...(clickable ? { cursor: 'pointer' } : {}),
            // areaColor is what a state with no row draws as, so "no data" reads as a
            // neutral shape rather than as the bottom of the scale.
            itemStyle: { areaColor: t.rowHvr, borderColor: t.card, borderWidth: 0.6 },
            label: { show: false },
            emphasis: {
              label: { show: false },
              itemStyle: { shadowBlur: 6, shadowColor: 'rgba(8,15,35,0.25)' },
            },
            select: { disabled: true },
            data: data.map((d) => {
              const o = dimOf(activeCat, d[nameKey])
              return {
                name: String(d[nameKey] ?? ''), value: d[valueKey],
                ...(o === undefined ? {} : { itemStyle: { opacity: o } }),
              }
            }),
          },
        ],
        animationDuration: 500,
      }
    },
    [data, nameKey, valueKey, valueFmt, low, high, clickable, activeCat],
  )

  if (state === 'failed') {
    return (
      <div style={{
        display: 'grid', placeItems: 'center', height,
        fontSize: 12, color: 'var(--txt3)', textAlign: 'center', padding: 16,
      }}>
        The state boundaries could not be loaded, so this tile cannot draw its map.
      </div>
    )
  }
  if (state === 'loading') {
    return <div style={{ display: 'grid', placeItems: 'center', height, fontSize: 12, color: 'var(--txt3)' }}>
      Loading the map&hellip;
    </div>
  }
  // The click carries the region name, which here IS the row's own value: the names come
  // from our own boundary file and the canonical state list, not from an axis format.
  return (
    <EChart option={option} height={height}
      onEvents={onPick ? {
        click: (p: any) => {
          const row = data.find((d) => String(d[nameKey] ?? '') === String(p?.name ?? ''))
          if (row) onPick(row[nameKey], row, data.indexOf(row))
        },
      } : undefined} />
  )
}
