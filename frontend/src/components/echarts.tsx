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
// ─────────────────────────────────────────────────────────────────────────────
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'

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

// The rounded "Rails" tooltip card, as an HTML string for ECharts' formatter.
export function tipCard(t: ChartTokens, title: string | null, rows: { color: string; name?: string; value: string }[]) {
  const head = title
    ? `<div style="font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${t.txt3};padding-bottom:7px;margin-bottom:7px;border-bottom:1px solid ${t.bdr}">${title}</div>`
    : ''
  const body = rows
    .map((r) => {
      const nm = r.name
        ? `<span style="font-size:12px;color:${t.txt2};flex:1;white-space:nowrap">${r.name}</span>`
        : ''
      return `<div style="display:flex;align-items:center;gap:9px">
        <span style="width:9px;height:9px;border-radius:3px;background:${r.color};flex-shrink:0"></span>
        ${nm}
        <span style="font-size:13px;font-weight:700;color:${t.txt};font-variant-numeric:tabular-nums;margin-left:${r.name ? 'auto' : '0'}">${r.value}</span>
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
export function EChart({ option, height }: { option: any | ((t: ChartTokens) => any); height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const tokens = useChartTokens(ref)
  const opt = useMemo(() => (typeof option === 'function' ? option(tokens) : option), [option, tokens])
  return (
    <div ref={ref} style={{ width: '100%', height }}>
      <ReactECharts option={opt} style={{ width: '100%', height: '100%' }} notMerge lazyUpdate opts={{ renderer: 'canvas' }} />
    </div>
  )
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

function seriesRow<T extends Record<string, any>>(kind: 'bar' | 'line' | 'area', data: T[], s: Series<T>, extra: any = {}) {
  const name = s.name ?? String(s.key)
  if (kind === 'bar') {
    return {
      type: 'bar', name, barMaxWidth: 40,
      itemStyle: { borderRadius: [4, 4, 0, 0], color: s.color },
      data: data.map((d, i) => (s.colorFn ? { value: d[s.key], itemStyle: { color: s.colorFn(d, i), borderRadius: [4, 4, 0, 0] } } : d[s.key])),
      ...extra,
    }
  }
  // line / area
  return {
    type: 'line', name, smooth: true, smoothMonotone: 'x', showSymbol: false,
    lineStyle: { width: 2.5, color: s.color }, itemStyle: { color: s.color },
    areaStyle: kind === 'area' && s.color ? { color: grad(s.color) } : undefined,
    data: data.map((d) => d[s.key]),
    ...extra,
  }
}

// ── Vertical bar — single, grouped, or stacked ───────────────────────────────
export function EBar<T extends Record<string, any>>({
  data, xKey, series, stack = false, height = 200, legend,
  valueFmt = (v) => String(v), axisFmt, xTickSize = 11, leftMargin = 8,
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
}) {
  const showLegend = legend ?? series.length > 1
  const option = useMemo(
    () => (t: ChartTokens) => ({
      grid: { top: showLegend ? 30 : 14, right: 12, bottom: 24, left: leftMargin, containLabel: true },
      legend: showLegend ? legendCfg(t) : undefined,
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
        formatter: axisTip(t, series, valueFmt),
      },
      xAxis: axisCat(t, data.map((d) => d[xKey]), xTickSize),
      yAxis: axisVal(t, axisFmt),
      series: series.map((s) => seriesRow('bar', data, s, stack ? { stack: 'total' } : {})),
      animationDuration: 700,
    }),
    [data, xKey, series, stack, showLegend, valueFmt, axisFmt, xTickSize, leftMargin],
  )
  return <EChart option={option} height={height} />
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
  valueFmt = (v) => String(v), axisFmt, xTickSize = 11, leftMargin = 8,
}: {
  data: T[]; xKey: keyof T; series: Series<T>[]; stack?: boolean; height?: number
  endLabel?: boolean; endFmt?: (v: number) => string; dots?: boolean; hideYAxis?: boolean
  valueFmt?: (v: number) => string; axisFmt?: (v: number) => string; xTickSize?: number; leftMargin?: number
}) {
  const option = useMemo(
    () => (t: ChartTokens) => {
      const cat = axisCat(t, data.map((d) => d[xKey]), xTickSize)
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
        })),
        animationDuration: 700,
      }
    },
    [data, xKey, series, stack, endLabel, endFmt, dots, hideYAxis, valueFmt, axisFmt, xTickSize, leftMargin],
  )
  return <EChart option={option} height={height} />
}

// ── Smooth multi-series line ─────────────────────────────────────────────────
export function ELine<T extends Record<string, any>>({
  data, xKey, series, height = 220, endLabel = false, endFmt, hideYAxis = false,
  valueFmt = (v) => String(v), axisFmt, xTickSize = 11, leftMargin = 8,
}: {
  data: T[]; xKey: keyof T; series: Series<T>[]; height?: number
  endLabel?: boolean; endFmt?: (v: number) => string; hideYAxis?: boolean
  valueFmt?: (v: number) => string; axisFmt?: (v: number) => string; xTickSize?: number; leftMargin?: number
}) {
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
      series: series.map((s) => seriesRow('line', data, s,
        endLabel ? { endLabel: endChip(t, s.color, endFmt ?? s.fmt ?? valueFmt) } : {})),
      animationDuration: 700,
    }),
    [data, xKey, series, endLabel, endFmt, hideYAxis, valueFmt, axisFmt, xTickSize, leftMargin],
  )
  return <EChart option={option} height={height} />
}

// ── Horizontal bar — ranked categories (long labels) ─────────────────────────
export function EBarH<T extends Record<string, any>>({
  data, catKey, series, height = 260, legend, barMax = 24,
  valueFmt = (v) => String(v), axisFmt,
}: {
  data: T[]
  catKey: keyof T
  series: Series<T>[]
  height?: number
  legend?: boolean
  barMax?: number
  valueFmt?: (v: number) => string
  axisFmt?: (v: number) => string
}) {
  const showLegend = legend ?? series.length > 1
  const option = useMemo(
    () => (t: ChartTokens) => ({
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
        itemStyle: { borderRadius: [0, 4, 4, 0], color: s.color },
        data: data.map((d, i) => (s.colorFn
          ? { value: d[s.key], itemStyle: { color: s.colorFn(d, i), borderRadius: [0, 4, 4, 0] } }
          : d[s.key])),
      })),
      animationDuration: 700,
    }),
    [data, catKey, series, showLegend, barMax, valueFmt, axisFmt],
  )
  return <EChart option={option} height={height} />
}

// ── Donut — hover-expand slice; center label OR legend ───────────────────────
export function EDonut<T extends Record<string, any>>({
  data, valueKey, nameKey, colorFn, size = 148, inner = 42, outer = 66, centerSize = 18,
  centerValue, centerLabel, legend = false, valueFmt = (v) => String(v), nameFmt, showPercent = true,
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
}) {
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
          data: data.map((d, i) => ({ name: d[nameKey], value: d[valueKey], itemStyle: { color: colorFn(d, i) } })),
          emphasis: { scale: true, scaleSize: 8, itemStyle: { shadowBlur: 10, shadowColor: 'rgba(8,15,35,0.22)' } },
        },
      ],
      animationDuration: 700,
    }),
    [data, valueKey, nameKey, colorFn, size, inner, outer, centerSize, centerValue, centerLabel, legend, valueFmt, nameFmt, showPercent],
  )
  return <EChart option={option} height={size} />
}

// ── Funnel — pipeline / stage conversion ─────────────────────────────────────
export function EFunnel<T extends Record<string, any>>({
  data, nameKey, valueKey, colorFn, height = 240, valueFmt = (v) => String(v), showValueLabel = true,
}: {
  data: T[]
  nameKey: keyof T
  valueKey: keyof T
  colorFn?: (row: T, i: number) => string
  height?: number
  valueFmt?: (v: number) => string
  showValueLabel?: boolean
}) {
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
          data: data.map((d, i) => ({
            name: String(d[nameKey]), value: Number(d[valueKey]),
            itemStyle: colorFn ? { color: colorFn(d, i) } : undefined,
          })),
        },
      ],
      animationDuration: 700,
    }),
    [data, nameKey, valueKey, colorFn, valueFmt, showValueLabel],
  )
  return <EChart option={option} height={height} />
}

// ── Combo — bars / areas + line(s), optional right axis ──────────────────────
export function ECombo<T extends Record<string, any>>({
  data, xKey, bars = [], areas = [], lines = [], height = 240, legend,
  valueFmt = (v) => String(v), axisFmt, rightAxis = false, rightFmt, stack = false, xTickSize = 11, leftMargin = 8,
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
}) {
  const allSeries = [...bars, ...areas, ...lines]
  const showLegend = legend ?? allSeries.length > 1
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
        ...bars.map((s) => seriesRow('bar', data, s, stack ? { stack: 'total' } : {})),
        ...areas.map((s) => seriesRow('area', data, s)),
        ...lines.map((s) => ({ ...seriesRow('line', data, s), yAxisIndex: rightAxis ? 1 : 0 })),
      ],
      animationDuration: 700,
    }),
    [data, xKey, bars, areas, lines, showLegend, valueFmt, axisFmt, rightAxis, rightFmt, stack, xTickSize, leftMargin],
  )
  return <EChart option={option} height={height} />
}
