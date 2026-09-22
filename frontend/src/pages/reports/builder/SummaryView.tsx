import { useEffect, useMemo, useState } from 'react'
import { EBar, ELine, EArea, EDonut } from '../../../components/echarts'
import { CHART_SERIES } from '../../../components/charts'
import type { ChartKind, Dataset, Matrix, PivotResult, ReportState } from './model'
import {
  AGG_LABEL, aggsForType, buildMatrix, filterComplete, fmtCell, isNumeric, isTemporal,
  queryBase, remapMeasureIds, valueFieldLabel,
} from './model'
import { fetchPivot } from './api'
import { ColumnMenu } from './ColumnMenu'

type Zone = 'rows' | 'cols' | 'values'
const ROW_STEP = 500

// SummaryView groups records: fields in Rows down the side, fields in Columns spread
// across, Values measured in each cell. Every header opens the same column menu as the
// Table, so any column — including the ones Columns generates — can be renamed, sorted
// or hidden.
export function SummaryView({ ds, report, onChange, onSwitchToTable }: {
  ds: Dataset
  report: ReportState
  onChange: (patch: Partial<ReportState>) => void
  onSwitchToTable: () => void
}) {
  const [result, setResult] = useState<PivotResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  const [drag, setDrag] = useState<{ zone: Zone; from: number; over: number | null } | null>(null)
  const [shown, setShown] = useState(ROW_STEP)

  const base = queryBase(report, ds)
  const hasFields = report.rows.length + report.cols.length + report.values.length > 0
  const queryKey = JSON.stringify({ ds: ds.key, base, rows: report.rows, cols: report.cols, values: report.values, grains: report.grains, topN: report.topN })

  useEffect(() => {
    setShown(ROW_STEP)
    if (!hasFields) { setResult(null); setError(null); return }
    const ctl = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetchPivot(ds.key, {
          ...base, rows: report.rows, cols: report.cols, values: report.values, grains: report.grains,
          ...(report.topN ? { top_n: report.topN } : {}),
        }, ctl.signal)
        if (!ctl.signal.aborted) setResult(r)
      } catch (e: any) {
        if (!ctl.signal.aborted) { setError(e.message); setResult(null) }
      } finally {
        if (!ctl.signal.aborted) setLoading(false)
      }
    }, 280)
    return () => { clearTimeout(timer); ctl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])

  const matrix = useMemo(
    () => (result ? buildMatrix(result, report.headerLabels, report.hiddenCols, report.summarySort) : null),
    [result, report.headerLabels, report.hiddenCols, report.summarySort],
  )
  // Hidden ids outlive their columns (a field taken out of Columns, a value that no longer
  // turns up), so only the ones in this result count as hidden.
  const hiddenCount = matrix ? report.hiddenCols.filter(id => matrix.all.some(c => c.id === id)).length : 0

  // Top N ranks lines, so with Rows and Columns both empty its pill is hidden. Left set,
  // it would still cut the result where no one can see or remove it.
  useEffect(() => {
    if (report.topN && report.rows.length + report.cols.length === 0) onChange({ topN: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.topN, report.rows.length, report.cols.length])

  // A menu open on a column that is no longer in the result closes, so it never acts on
  // a column id that is gone.
  useEffect(() => {
    if (menu && !matrix?.all.some(c => c.id === menu.id)) setMenu(null)
  }, [menu, matrix])

  const meta = (key: string) => ds.columns.find(c => c.key === key)
  const reorder = <T,>(list: T[], from: number, to: number) => {
    const next = [...list]
    const [x] = next.splice(from, 1)
    next.splice(to, 0, x)
    return next
  }
  const reorderValues = (from: number, to: number) => {
    const order = reorder(report.values.map((_, i) => i), from, to)
    const oldToNew = new Map(order.map((old, ni) => [old, ni]))
    onChange({ values: order.map(o => report.values[o]), ...remapMeasureIds(report, old => oldToNew.get(old) ?? null) })
  }
  const removeValue = (i: number) => onChange({
    values: report.values.filter((_, x) => x !== i),
    ...remapMeasureIds(report, old => (old === i ? null : old > i ? old - 1 : old)),
  })
  const dragProps = (zone: Zone, i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `${zone}:${i}`); setDrag({ zone, from: i, over: null }) },
    onDragOver: (e: React.DragEvent) => { if (drag?.zone === zone) { e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }) } },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      // The drop marker sits on the target's left edge, so the pill lands just before the
      // target. Dragging right, taking the pill out first shifts the target left by one.
      const to = drag && drag.from < i ? i - 1 : i
      if (drag?.zone === zone && drag.from !== to) {
        if (zone === 'values') reorderValues(drag.from, to)
        else onChange({ [zone]: reorder(report[zone], drag.from, to) } as Partial<ReportState>)
      }
      setDrag(null)
    },
    onDragEnd: () => setDrag(null),
  })
  const pillClass = (zone: Zone, i: number, extra = '') =>
    ['rb-pill', extra, drag?.zone === zone && drag.from === i ? 'dragging' : '', drag?.zone === zone && drag.over === i && drag.from !== i && drag.from !== i - 1 ? 'drop-target' : '']
      .filter(Boolean).join(' ')
  // While dragging, a space after a zone's last pill takes a drop there, so a pill can
  // still be moved to the end.
  const endZone = (zone: Zone, len: number) => (drag?.zone === zone && len > 1 ? (
    <span className={`rb-drop-end${drag.over === len ? ' on' : ''}`} aria-hidden="true"
      onDragOver={e => { e.preventDefault(); if (drag.over !== len) setDrag({ ...drag, over: len }) }}
      onDrop={e => {
        e.preventDefault()
        if (drag.from !== len - 1) {
          if (zone === 'values') reorderValues(drag.from, len - 1)
          else onChange({ [zone]: reorder(report[zone], drag.from, len - 1) } as Partial<ReportState>)
        }
        setDrag(null)
      }} />
  ) : null)

  const dimZone = (zone: 'rows' | 'cols', label: string, hint: string) => (
    <div className="rb-strip" aria-label={label}>
      <span className="rb-strip-label">{label}</span>
      {report[zone].map((key, i) => {
        const m = meta(key)
        return (
          <span key={key} className={pillClass(zone, i)} {...dragProps(zone, i)}>
            <span className="rb-pill-main"><span className="rb-grip" aria-hidden="true">⋮⋮</span>{m?.label ?? key}</span>
            {isTemporal(m?.type) && (
              <select aria-label={`Group ${m?.label ?? key} by`} value={report.grains[key] ?? (m?.type === 'datetime' ? 'datetime' : 'date')}
                onChange={e => onChange({ grains: { ...report.grains, [key]: e.target.value } })}>
                <option value="date">by day</option>
                <option value="time">by time of day</option>
                <option value="datetime">by timestamp</option>
              </select>
            )}
            <button type="button" className="rb-x" aria-label={`Remove ${m?.label ?? key}`}
              onClick={() => onChange({ [zone]: report[zone].filter(k => k !== key) } as Partial<ReportState>)}>×</button>
          </span>
        )
      })}
      {endZone(zone, report[zone].length)}
      {!report[zone].length && <span className="rb-hint">{hint}</span>}
    </div>
  )

  const canRank = report.values.length > 0 && report.rows.length + report.cols.length > 0
  const topN = report.topN

  return (
    <>
      {dimZone('rows', 'Rows', 'Pick a field on the left, then Rows.')}
      {dimZone('cols', 'Columns', 'Optional: spread a field across the columns.')}
      <div className="rb-strip" aria-label="Values">
        <span className="rb-strip-label">Values</span>
        {report.values.map((v, i) => {
          const m = v.column ? meta(v.column) : undefined
          return (
            <span key={i} className={pillClass('values', i)} {...dragProps('values', i)}>
              <span className="rb-pill-main"><span className="rb-grip" aria-hidden="true">⋮⋮</span>{m?.label ?? 'Records'}</span>
              <select aria-label={`Measure for ${m?.label ?? 'records'}`} value={v.agg}
                onChange={e => onChange({ values: report.values.map((x, xi) => (xi === i ? { ...x, agg: e.target.value } : x)) })}>
                {aggsForType(m?.type).map(a => <option key={a} value={a}>{AGG_LABEL[a]}</option>)}
              </select>
              <button type="button" className="rb-x" aria-label={`Remove ${valueFieldLabel(v, m)}`} onClick={() => removeValue(i)}>×</button>
            </span>
          )
        })}
        {endZone('values', report.values.length)}
        {!report.values.length && <span className="rb-hint">No values: the summary lists each distinct combination once.</span>}
        {canRank && (topN ? (
          <span className="rb-pill filter">
            <span className="rb-pill-main">
              Top
              <input id="rb-topn-n" type="number" min={1} max={1000} value={topN.n} aria-label="How many to keep"
                onChange={e => onChange({ topN: { ...topN, n: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) } })} />
              by
              <select aria-label="Rank by" value={topN.measure} onChange={e => onChange({ topN: { ...topN, measure: Number(e.target.value) } })}>
                {report.values.map((v, i) => <option key={i} value={i}>{valueFieldLabel(v, v.column ? meta(v.column) : undefined)}</option>)}
              </select>
            </span>
            <button type="button" className="rb-x" aria-label="Remove Top N" onClick={() => onChange({ topN: null })}>×</button>
          </span>
        ) : (
          <span className="rb-pill add">
            <button type="button" className="rb-pill-main" onClick={() => onChange({ topN: { measure: 0, n: 10 } })}>+ Top N</button>
          </span>
        ))}
      </div>

      {error && <div className="rb-note error"><span className="material-symbols-rounded" aria-hidden="true">error</span><span>{error}</span></div>}

      {result?.truncated && !result.top_n_applied && (
        <div className="rb-note warn">
          <span className="material-symbols-rounded" aria-hidden="true">warning</span>
          <span>
            Showing the first <b>{result.group_cap.toLocaleString()}</b> of <b>{(result.group_total ?? 0).toLocaleString()}</b> lines
            {report.cols.length ? ', so columns for the lines left out are incomplete' : ''}.{' '}
            {report.values.length
              ? <button type="button" className="rb-link" onClick={() => onChange({ topN: { measure: 0, n: 20 } })}>Keep the top 20 instead</button>
              : <>Group by fewer fields, or <button type="button" className="rb-link" onClick={onSwitchToTable}>use a table</button>.</>}
          </span>
        </div>
      )}
      {result?.top_n_applied && topN && (
        <div className="rb-note">
          <span className="material-symbols-rounded" aria-hidden="true">leaderboard</span>
          <span>Top <b>{topN.n.toLocaleString()}</b> of <b>{(result.group_total ?? 0).toLocaleString()}</b> by {valueFieldLabel(report.values[topN.measure] ?? { column: '', agg: 'count' }, meta(report.values[topN.measure]?.column ?? ''))}.</span>
        </div>
      )}
      {result && !report.values.length && matrix && (result.raw_count ?? 0) > matrix.rows.length && (
        <div className="rb-note">
          <span className="material-symbols-rounded" aria-hidden="true">info</span>
          <span>
            <b>{(result.raw_count ?? 0).toLocaleString()} records</b> collapse into <b>{matrix.rows.length.toLocaleString()} lines</b>, one per distinct combination.{' '}
            <button type="button" className="rb-link" onClick={onSwitchToTable}>Show one line per record</button>
          </span>
        </div>
      )}

      {!hasFields ? (
        <div className="rb-note"><span className="material-symbols-rounded" aria-hidden="true">touch_app</span>
          <span>Pick a field on the left and add it to Rows, Columns or Values.</span></div>
      ) : (
        <>
          <div className="rb-strip split">
            <span className="rb-hint">
              {matrix ? `${matrix.rows.length.toLocaleString()} line${matrix.rows.length === 1 ? '' : 's'}` : loading ? 'Loading…' : ''}
              {hiddenCount > 0 && (
                <> · {hiddenCount} hidden column{hiddenCount === 1 ? '' : 's'} · <button type="button" className="rb-link" onClick={() => onChange({ hiddenCols: [] })}>Show All</button></>
              )}
            </span>
            <span className="rb-inline" style={{ flex: '0 0 auto' }}>
              <span className="rb-seg small" role="group" aria-label="Show as">
                <button type="button" aria-pressed={report.chart.view === 'table'} onClick={() => onChange({ chart: { ...report.chart, view: 'table' } })}>Table</button>
                <button type="button" aria-pressed={report.chart.view === 'chart'} onClick={() => onChange({ chart: { ...report.chart, view: 'chart' } })}>Chart</button>
              </span>
              {report.chart.view === 'chart' && (
                <select id="rb-chart-kind" className="rb-input" style={{ width: 'auto', padding: '4px 8px' }} value={report.chart.kind}
                  onChange={e => onChange({ chart: { ...report.chart, kind: e.target.value as ChartKind } })} aria-label="Chart type">
                  <option value="bar">Bar</option>
                  <option value="stacked">Stacked Bar</option>
                  <option value="line">Line</option>
                  <option value="area">Area</option>
                  <option value="pie">Donut</option>
                </select>
              )}
            </span>
          </div>

          {matrix && report.chart.view === 'chart' ? (
            <ChartView matrix={matrix} kind={report.chart.kind} />
          ) : matrix ? (
            <div className={`rb-table-wrap${loading ? ' is-loading' : ''}`}>
              <table className="rb-table">
                <thead>
                  <tr>
                    {matrix.cols.map(c => {
                      const num = !c.dim && isNumeric(c.type)
                      const dir = report.summarySort[0]?.key === c.id ? report.summarySort[0].dir : null
                      const filt = !!c.fieldKey && report.colFilters.some(f => f.column === c.fieldKey && filterComplete(f))
                      const cls = [num ? 'num' : '', menu?.id === c.id ? 'active' : '', filt ? 'filtered' : ''].filter(Boolean).join(' ')
                      return (
                        <th key={c.id} scope="col" className={cls} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                          <button type="button" className="rb-th-btn" aria-haspopup="dialog" aria-expanded={menu?.id === c.id}
                            onClick={e => setMenu(menu?.id === c.id ? null : { id: c.id, el: e.currentTarget })}>
                            {filt && <span className="rb-dot" title="Filtered" />}
                            <span>{c.label}</span>
                            {dir && <span className="rb-sort" aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>}
                            <span className="rb-caret" aria-hidden="true">▼</span>
                          </button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.slice(0, shown).map((r, ri) => (
                    <tr key={ri}>
                      {r.map((v, ci) => {
                        const c = matrix.cols[ci]
                        const blank = v === null || v === undefined || v === ''
                        const cls = [c.dim ? 'dim' : isNumeric(c.type) ? 'num' : '', blank ? 'blank' : ''].filter(Boolean).join(' ')
                        return <td key={ci} className={cls}>{c.dim ? String(v) : fmtCell(v, c.type)}</td>
                      })}
                    </tr>
                  ))}
                  {matrix.rows.length === 0 && (
                    <tr><td colSpan={Math.max(1, matrix.cols.length)} className="empty">No records match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : loading ? (
            <div className="rb-hint">Loading…</div>
          ) : null}

          {matrix && report.chart.view === 'table' && matrix.rows.length > shown && (
            <div className="rb-foot">
              <span>Showing <b>{shown.toLocaleString()}</b> of <b>{matrix.rows.length.toLocaleString()}</b> lines</span>
              <span className="rb-pager">
                <button type="button" style={{ padding: '0 10px' }} onClick={() => setShown(shown + ROW_STEP)}>Show {ROW_STEP} More</button>
                <button type="button" style={{ padding: '0 10px' }} onClick={() => setShown(matrix.rows.length)}>Show All</button>
              </span>
            </div>
          )}
        </>
      )}

      {menu && matrix && (() => {
        const c = matrix.all.find(x => x.id === menu.id)
        if (!c) return null
        const field = c.fieldKey ? meta(c.fieldKey) : undefined
        const existing = field ? report.colFilters.find(f => f.column === field.key && f.op === 'in') : undefined
        const dir = report.summarySort[0]?.key === c.id ? report.summarySort[0].dir : null
        return (
          <ColumnMenu
            anchorEl={menu.el}
            title={c.label}
            defaultTitle={c.defaultLabel}
            onRename={label => {
              const next = { ...report.headerLabels }
              if (label) next[c.id] = label
              else delete next[c.id]
              onChange({ headerLabels: next })
            }}
            sort={{
              dir,
              kind: c.dim ? (isTemporal(field?.type) ? 'date' : 'text') : isNumeric(c.type) ? 'number' : 'text',
              onSort: d => onChange({ summarySort: d ? [{ key: c.id, dir: d }] : [] }),
            }}
            onHide={() => { setMenu(null); onChange({ hiddenCols: [...report.hiddenCols, c.id] }) }}
            values={field ? {
              ds, column: field, base: queryBase(report, ds, field.key),
              selected: existing ? { values: existing.values ?? [], blank: !!existing.include_blank } : null,
              onApply: sel => {
                onChange({ colFilters: [...report.colFilters.filter(f => !(f.column === field.key && f.op === 'in')), { column: field.key, op: 'in', value: '', values: sel.values, include_blank: sel.blank }] })
                setMenu(null)
              },
              onClear: () => { onChange({ colFilters: report.colFilters.filter(f => !(f.column === field.key && f.op === 'in')) }); setMenu(null) },
            } : undefined}
            onClose={() => setMenu(null)}
          />
        )
      })()}
    </>
  )
}

function ChartView({ matrix, kind }: { matrix: Matrix; kind: ChartKind }) {
  const dimIdx = matrix.cols.map((c, i) => (c.dim ? i : -1)).filter(i => i >= 0)
  const measIdx = matrix.cols.map((c, i) => (!c.dim && isNumeric(c.type) ? i : -1)).filter(i => i >= 0)
  const cats = matrix.rows.map(r => dimIdx.map(i => String(r[i])).join(' / ') || 'Total')
  const num = (v: unknown, ci: number) => {
    const n = Number(v) || 0
    return matrix.cols[ci].type === 'kobo' ? n / 100 : n
  }
  const numFmt = (v: number) => Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 })

  if (!measIdx.length) return <div className="rb-note"><span className="material-symbols-rounded" aria-hidden="true">bar_chart</span><span>Add a value to chart this summary.</span></div>

  if (kind === 'pie') {
    const ci = measIdx[0]
    const data = matrix.rows
      .map((r, i) => ({ name: cats[i], value: num(r[ci], ci) }))
      .filter(d => d.value !== 0)
      .slice(0, 40)
    if (!data.length) return <div className="rb-hint">No non-zero values to plot.</div>
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
        <EDonut data={data} valueKey="value" nameKey="name" size={340} inner={92} outer={150}
          colorFn={(_r, i) => CHART_SERIES[i % CHART_SERIES.length]} legend valueFmt={numFmt} />
      </div>
    )
  }

  const data = matrix.rows.map((r, i) => {
    const o: any = { __x: cats[i] }
    measIdx.forEach((ci, si) => { o['s' + si] = num(r[ci], ci) })
    return o
  })
  const series = measIdx.map((ci, si) => ({ key: 's' + si, name: matrix.cols[ci].label, color: CHART_SERIES[si % CHART_SERIES.length] }))
  const common = { data, xKey: '__x' as const, series, height: 380, valueFmt: numFmt }
  if (kind === 'line') return <ELine {...common} />
  if (kind === 'area') return <EArea {...common} stack={false} />
  return <EBar {...common} stack={kind === 'stacked'} />
}
