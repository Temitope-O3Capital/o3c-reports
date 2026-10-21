import { DataTable } from '../../../components/UI'
import type { TableCol } from '../../../components/UI'
import { EBar, ELine, EArea, EDonut, EBarH, EFunnel, ECombo } from '../../../components/echarts'
import { CHART_SERIES } from '../../../components/charts'
import { labelFor, fmtValue, alignFor } from '../../../lib/reportFormat'
import { NAVY, FW, SP, TEXT } from '../../../lib/design'
import { resolveViz, type TileVizConfig } from './tileViz'

/*
  Drawing a tile from its config.

  ONE RENDERER, TWO CALLERS. The dashboard draws a saved tile with this; the tile builder
  draws its live preview with the same component and the same `resolveViz`. That is the
  point: what you compose is literally what the dashboard will draw, not a second
  renderer that agrees with this one only until somebody edits one of them.

  It lives here rather than in DashboardView so the builder can import it without a
  cycle — DashboardView imports the builder.

  It takes data rather than fetching it. The dashboard has already fetched for its tile
  and the builder fetches for an unsaved config, so a fetch in here would be a third
  source of truth about what a tile shows.
*/
export function TileVisual({
  viz, config, columns, rows, rowCount, height, pickKeys, onPick, activeValue,
}: {
  viz: string
  config: Record<string, any> | null
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  height: number
  /** Column keys a click is allowed to filter the board by — the board's own slicer keys.
   *  A category column outside this list is not clickable, which is what stops a click
   *  reaching a filter no dataset declares. */
  pickKeys?: string[]
  onPick?: (key: string, value: string) => void
  /** The category currently picked from THIS tile: drawn solid while the rest fade. */
  activeValue?: string | null
}) {
  const r = resolveViz(viz, columns, rows, config)
  const primary = r.seriesKeys[0] ?? columns[0] ?? ''
  const fmt = (v: number) => fmtValue(primary, v)

  // What a click sends is the row's own value, not the formatted label on the axis: the
  // board filters with an equality, and "₦1.2m" or a truncated name would match nothing.
  const canPick = !!onPick && !!r.labelKey && (pickKeys ?? []).includes(r.labelKey)
  const pick = canPick
    ? (v: unknown) => {
        // A blank category cannot be filtered by equality — that would need IS NULL — so
        // clicking (blank) does nothing rather than quietly narrowing to no rows.
        const s = v === null || v === undefined ? '' : String(v)
        if (!s.trim()) return
        onPick!(r.labelKey, s)
      }
    : undefined
  const active = activeValue || undefined

  if (viz === 'kpi') {
    // SEVERAL MEASURES BECOME A ROW OF FIGURES. "A card showing total calls, missed
    // calls" is one tile with several measures, not three tiles. The single-measure case
    // below keeps its big number, comparison and target; a comparison against one of
    // several figures would be ambiguous, so it is only offered for the single case.
    if (r.seriesKeys.length > 1) {
      return (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          gap: `${SP[3]}px ${SP[5]}px`, height: '100%', padding: `0 ${SP[4]}px`,
        }}>
          {r.seriesKeys.map(k => (
            <div key={k} style={{ minWidth: 0 }}>
              <div style={{
                fontSize: 22, fontWeight: FW.semibold, color: 'var(--txt)',
                fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.015em', lineHeight: 1.15,
              }}>
                {fmtValue(k, rows[0]?.[k])}
              </div>
              <div style={{
                marginTop: 2, fontSize: TEXT.xs, color: 'var(--txt3)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {labelFor(k)}
              </div>
            </div>
          ))}
          {rowCount > 1 && (
            <div style={{ flex: '1 1 100%', fontSize: 10.5, color: 'var(--txt3)' }}>
              First of {rowCount.toLocaleString('en-NG')} rows &middot; summarise to one row to read the whole period
            </div>
          )}
        </div>
      )
    }

    // The first row's value. A KPI tile over a multi-row source shows the first row and
    // says so, rather than silently summing rows whose meaning it cannot know — summing
    // a column of percentages or averages would invent a number.
    const v = rows[0]?.[primary]
    const cfg = (config ?? {}) as TileVizConfig
    // A comparison reads the SAME row, not a different period: the report decides what a
    // row means, and reaching across rows here would be this component inventing a
    // timeframe nobody asked for.
    const cmpKey = cfg.compare && columns.includes(cfg.compare) ? cfg.compare : undefined
    const cmpRaw = cmpKey ? rows[0]?.[cmpKey] : undefined
    const nowNum = typeof v === 'number' ? v : undefined
    const cmpNum = typeof cmpRaw === 'number' ? cmpRaw : undefined
    const delta = nowNum !== undefined && cmpNum !== undefined && cmpNum !== 0
      ? ((nowNum - cmpNum) / Math.abs(cmpNum)) * 100
      : undefined
    const goalPct = nowNum !== undefined && typeof cfg.goal === 'number' && cfg.goal !== 0
      ? Math.max(0, Math.min(100, (nowNum / cfg.goal) * 100))
      : undefined

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        height: '100%', padding: `0 ${SP[5]}px`,
      }}>
        <div style={{
          fontSize: 30, fontWeight: FW.semibold, color: 'var(--txt)',
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', lineHeight: 1.1,
        }}>
          {fmtValue(primary, v)}
        </div>
        {delta !== undefined && cmpKey && (
          <div style={{
            marginTop: SP[1], fontSize: TEXT.xs, fontWeight: FW.semibold,
            fontVariantNumeric: 'tabular-nums',
            color: delta >= 0 ? '#2F6248' : '#C0392B',
          }}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs {labelFor(cmpKey)}
          </div>
        )}
        {goalPct !== undefined && (
          <div style={{ marginTop: SP[2] }}>
            <div style={{ height: 4, borderRadius: 2, background: 'var(--bdr)', overflow: 'hidden' }}>
              <div style={{ width: `${goalPct}%`, height: '100%', background: NAVY }} />
            </div>
            <div style={{ marginTop: SP[1], fontSize: 10.5, color: 'var(--txt3)' }}>
              {goalPct.toFixed(0)}% of {fmtValue(primary, cfg.goal)}
            </div>
          </div>
        )}
        <div style={{ marginTop: SP[2], fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          {labelFor(primary)}
          {rowCount > 1 && <> · first of {rowCount.toLocaleString('en-NG')} rows</>}
        </div>
      </div>
    )
  }

  if (viz === 'table') {
    const cols: TableCol<Record<string, unknown>>[] = columns.map(c => ({
      key: c, label: labelFor(c), align: alignFor(c), sortable: true,
      render: (row: Record<string, unknown>) => fmtValue(c, row[c]),
    }))
    return (
      <div style={{ padding: SP[2], height: '100%', overflow: 'auto' }}>
        <DataTable cols={cols} rows={rows} />
      </div>
    )
  }

  if (viz === 'donut') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <EDonut
          data={r.rows} valueKey={primary} nameKey={r.labelKey}
          colorFn={(_row, i) => CHART_SERIES[i % CHART_SERIES.length]}
          size={Math.min(height + 40, 190)} legend valueFmt={fmt}
          onPick={pick} activeCat={active}
        />
      </div>
    )
  }

  if (viz === 'funnel') {
    return (
      <div style={{ padding: SP[2] }}>
        <EFunnel
          data={r.rows} nameKey={r.labelKey} valueKey={primary}
          colorFn={(_row, i) => CHART_SERIES[i % CHART_SERIES.length]}
          height={height} valueFmt={fmt}
          onPick={pick} activeCat={active}
        />
      </div>
    )
  }

  // One Series per chosen measure, coloured in the house order and named by the column's
  // label so the legend reads like the report rather than like the database. Each series
  // formats with its OWN column's rules: a count and a naira amount on one chart must
  // not both be drawn as money.
  const series = r.seriesKeys.map((k, i) => ({
    key: k, name: labelFor(k), color: CHART_SERIES[i % CHART_SERIES.length],
    fmt: (v: number) => fmtValue(k, v),
  }))

  if (viz === 'barh') {
    return (
      <div style={{ padding: SP[2] }}>
        <EBarH data={r.rows} catKey={r.labelKey} series={series} height={height}
          legend={r.legend} valueFmt={fmt} onPick={pick} activeCat={active} />
      </div>
    )
  }

  if (viz === 'combo') {
    const bars = series.filter(s => r.barKeys.includes(String(s.key)))
    const lines = series.filter(s => r.lineKeys.includes(String(s.key)))
    return (
      <div style={{ padding: SP[2] }}>
        <ECombo data={r.rows} xKey={r.labelKey} bars={bars} lines={lines}
          height={height} legend={r.legend} valueFmt={fmt}
          rightAxis={r.rightAxis} stack={r.stacked} onPick={pick} activeCat={active} />
      </div>
    )
  }

  const common = {
    data: r.rows, xKey: r.labelKey, series, height,
    valueFmt: fmt, onPick: pick, activeCat: active,
    // Undefined would let each chart apply its own rule; being explicit keeps the
    // builder's preview and the dashboard identical.
    legend: r.legend ?? series.length > 1,
  }
  if (viz === 'bar') return <div style={{ padding: SP[2] }}><EBar {...common} stack={r.stacked} /></div>
  if (viz === 'area') return <div style={{ padding: SP[2] }}><EArea {...common} stack={r.stacked} /></div>
  return <div style={{ padding: SP[2] }}><ELine {...common} /></div>
}
