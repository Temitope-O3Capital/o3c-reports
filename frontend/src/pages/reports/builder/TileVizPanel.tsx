import { useMemo } from 'react'
import { Sk, EmptyState } from '../../../components/UI'
import { labelFor } from '../../../lib/reportFormat'
import { TileVisual } from './TileVisual'
import {
  VIZ_KINDS, VIZ_META, maxSeries, numericColumns, usesCategory, defaultCap,
  usesGoalColour, usesDataLabels,
  type TileVizConfig, type VizKind,
} from './tileViz'

/*
  The field wells: saying which column is the category and which are the measures.

  THIS IS THE GAP THIS PANEL CLOSES. The renderer always read `label` and `value` out of a
  tile's config — but nothing could set them, so every chart took the first text column
  and the first numeric column, chosen by column order. A report with three measures drew
  one of them and there was no way to say which, nor to draw all three.

  The preview beside the wells is the REAL renderer (TileVisual) over REAL rows from the
  server, run through the same resolver the dashboard uses. So this is not an impression
  of the tile; it is the tile.
*/

export function TileVizPanel({
  viz, onViz, cfg, onCfg, columns, rows, rowCount, loading, error, trimmed,
}: {
  viz: string
  onViz: (v: VizKind) => void
  cfg: TileVizConfig
  onCfg: (next: TileVizConfig) => void
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  loading: boolean
  error: string | null
  trimmed: boolean
}) {
  const nums = useMemo(() => numericColumns(columns, rows), [columns, rows])
  // Anything not obviously a measure can still be a category — an id, a date, a flag.
  const cats = useMemo(() => columns.filter(c => !nums.includes(c)).concat(nums.length ? [] : columns), [columns, nums])
  const meta = VIZ_META[viz as VizKind]
  const limit = maxSeries(viz)
  const values = cfg.values ?? []

  const set = (p: Partial<TileVizConfig>) => onCfg({ ...cfg, ...p })

  function toggleValue(k: string) {
    const has = values.includes(k)
    if (has) {
      const next = values.filter(v => v !== k)
      set({ values: next, lines: (cfg.lines ?? []).filter(v => v !== k) })
      return
    }
    // At the limit, the newest choice replaces the oldest rather than being refused —
    // silently ignoring a click reads as a broken control.
    const next = limit === 1 ? [k] : [...values, k].slice(-limit)
    set({ values: next })
  }

  function toggleLine(k: string) {
    const lines = cfg.lines ?? []
    set({ lines: lines.includes(k) ? lines.filter(v => v !== k) : [...lines, k] })
  }

  const cap = cfg.topN && cfg.topN > 0 ? cfg.topN : defaultCap(viz)

  return (
    <div className="rb-vizpanel">
      <div className="rb-wells">
        <div className="rb-well">
          <div className="rb-well-head">Visual</div>
          <div className="rb-viz-row" role="group" aria-label="Visual">
            {VIZ_KINDS.map(v => (
              <button key={v} type="button" className={v === viz ? 'on' : undefined}
                aria-pressed={v === viz} onClick={() => onViz(v)} title={VIZ_META[v].note}>
                <span className="material-symbols-rounded" aria-hidden="true">{VIZ_META[v].icon}</span>
                {VIZ_META[v].label}
              </button>
            ))}
          </div>
          {meta && <p className="rb-viz-note">{meta.note}</p>}
        </div>

        {viz === 'table' ? (
          <div className="rb-well">
            <p className="rb-viz-note">
              A table draws every column you picked on the Data step, in that order. Change the
              columns there and this tile follows.
            </p>
          </div>
        ) : viz === 'matrix' ? (
          <>
            <div className="rb-well">
              <label className="rb-well-head" htmlFor="rb-well-cat">Down The Side</label>
              <select id="rb-well-cat" className="rb-well-sel"
                value={cfg.label ?? ''} onChange={e => set({ label: e.target.value || undefined })}>
                <option value="">Choose automatically</option>
                {cats.map(c => <option key={c} value={c}>{labelFor(c)}</option>)}
              </select>
              <label className="rb-well-head" htmlFor="rb-well-colby" style={{ marginTop: 10 }}>
                Across The Top
              </label>
              <select id="rb-well-colby" className="rb-well-sel"
                value={cfg.colBy ?? ''} onChange={e => set({ colBy: e.target.value || undefined })}>
                <option value="">Choose automatically</option>
                {cats.filter(c => c !== cfg.label).map(c => (
                  <option key={c} value={c}>{labelFor(c)}</option>
                ))}
              </select>
              <p className="rb-viz-note">
                A cell holds one figure, looked up rather than added up. If the report groups by
                anything besides these two fields, the tile says so instead of summing rows whose
                meaning it cannot know.
              </p>
            </div>
            <div className="rb-well">
              <div className="rb-well-head">Value In Each Cell</div>
              {!nums.length ? (
                <p className="rb-viz-note">
                  Add a measure on the Data step &mdash; a count or a sum &mdash; and it will
                  appear here.
                </p>
              ) : (
                <div className="rb-well-list">
                  {nums.map(k => (
                    <label key={k} className={values.includes(k) ? 'on' : undefined}>
                      <input type="radio" name="rb-well-values"
                        checked={values.includes(k)} onChange={() => toggleValue(k)} />
                      <span>{labelFor(k)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {usesCategory(viz) && (
              <div className="rb-well">
                <label className="rb-well-head" htmlFor="rb-well-cat">
                  {viz === 'donut' || viz === 'funnel' ? 'Slice By'
                    : viz === 'scatter' ? 'Name Each Point'
                    : 'Axis'}
                </label>
                <select id="rb-well-cat" className="rb-well-sel"
                  value={cfg.label ?? ''} onChange={e => set({ label: e.target.value || undefined })}>
                  <option value="">Choose automatically</option>
                  {cats.map(c => <option key={c} value={c}>{labelFor(c)}</option>)}
                </select>
              </div>
            )}

            <div className="rb-well">
              <div className="rb-well-head">
                {viz === 'scatter' ? 'Values · Across, Then Up'
                  : limit === 1 ? 'Value'
                  : `Values${values.length ? ` · ${values.length} of ${limit}` : ''}`}
              </div>
              {viz === 'scatter' && (
                <p className="rb-viz-note">
                  Order is the meaning here: the first measure runs across, the second runs up.
                </p>
              )}
              {!nums.length ? (
                <p className="rb-viz-note">
                  This shape has no numeric column yet. Add a measure on the Data step — a count
                  or a sum — and it will appear here.
                </p>
              ) : (
                <div className="rb-well-list">
                  {nums.map(k => {
                    const on = values.includes(k)
                    return (
                      <label key={k} className={on ? 'on' : undefined}>
                        <input type={limit === 1 ? 'radio' : 'checkbox'} name="rb-well-values"
                          checked={on} onChange={() => toggleValue(k)} />
                        <span>{labelFor(k)}</span>
                        {viz === 'combo' && on && (
                          <button type="button" className="rb-well-asline"
                            aria-pressed={(cfg.lines ?? []).includes(k)}
                            onClick={e => { e.preventDefault(); toggleLine(k) }}
                            title="Draw this measure as a line instead of a bar">
                            {(cfg.lines ?? []).includes(k) ? 'Line' : 'Bar'}
                          </button>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
              {!values.length && nums.length > 0 && (
                <p className="rb-viz-note">Nothing chosen, so the first numeric column is drawn.</p>
              )}
            </div>

            <div className="rb-well">
              <div className="rb-well-head">Options</div>
              <div className="rb-well-opts">
                {(viz === 'bar' || viz === 'area' || viz === 'combo') && (
                  <label>
                    <input type="checkbox" checked={!!cfg.stacked}
                      onChange={e => set({ stacked: e.target.checked || undefined })} />
                    <span>Stack the series</span>
                  </label>
                )}
                {viz === 'combo' && (
                  <label>
                    <input type="checkbox" checked={!!cfg.rightAxis}
                      onChange={e => set({ rightAxis: e.target.checked || undefined })} />
                    <span>Lines on their own axis</span>
                  </label>
                )}
                <label>
                  <input type="checkbox" checked={cfg.legend !== false}
                    onChange={e => set({ legend: e.target.checked ? undefined : false })} />
                  <span>Show the legend</span>
                </label>
                {usesDataLabels(viz) && (
                  <label>
                    <input type="checkbox" checked={!!cfg.dataLabels}
                      onChange={e => set({ dataLabels: e.target.checked || undefined })} />
                    <span>Print each value on the chart</span>
                  </label>
                )}
              </div>

              {usesCategory(viz) && (
                <div className="rb-well-row">
                  <label className="rb-ctl" htmlFor="rb-well-top">
                    <small>Show</small>
                    <input id="rb-well-top" type="number" min={1} max={500} value={cfg.topN ?? ''}
                      placeholder={String(cap)}
                      onChange={e => {
                        const n = parseInt(e.target.value, 10)
                        set({ topN: Number.isFinite(n) && n > 0 ? n : undefined })
                      }} />
                  </label>
                  <label className="rb-ctl" htmlFor="rb-well-sort">
                    <small>Ordered By</small>
                    <select id="rb-well-sort" value={cfg.sortBy ?? ''}
                      onChange={e => set({ sortBy: e.target.value || undefined })}>
                      <option value="">The Report&rsquo;s Own Order</option>
                      {columns.map(c => <option key={c} value={c}>{labelFor(c)}</option>)}
                    </select>
                  </label>
                  {cfg.sortBy && (
                    <label className="rb-ctl" htmlFor="rb-well-dir">
                      <small>Direction</small>
                      <select id="rb-well-dir" value={cfg.sortDir ?? 'desc'}
                        onChange={e => set({ sortDir: e.target.value === 'asc' ? 'asc' : 'desc' })}>
                        <option value="desc">Highest First</option>
                        <option value="asc">Lowest First</option>
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>

            {viz === 'kpi' && (
              <div className="rb-well">
                <div className="rb-well-head">Comparison</div>
                <div className="rb-well-row">
                  <label className="rb-ctl" htmlFor="rb-well-cmp">
                    <small>Against Column</small>
                    <select id="rb-well-cmp" value={cfg.compare ?? ''}
                      onChange={e => set({ compare: e.target.value || undefined })}>
                      <option value="">None</option>
                      {nums.filter(c => c !== (cfg.values?.[0])).map(c => (
                        <option key={c} value={c}>{labelFor(c)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="rb-viz-note">
                  The comparison reads the same row, so it is a figure the report already returns
                  beside the value — last month's total next to this month's, say. It does not
                  re-run the report over a different period.
                </p>
              </div>
            )}
          </>
        )}

        {/* ONE TARGET PER TILE. It draws the card's progress bar and it is the same number
            the colouring tests against, so a tile can never show a bar measured from one
            target and a colour decided by another. */}
        {usesGoalColour(viz) && (
          <div className="rb-well">
            <div className="rb-well-head">Target</div>
            <div className="rb-well-row">
              <label className="rb-ctl" htmlFor="rb-well-goal">
                <small>Target</small>
                <input id="rb-well-goal" type="number" value={cfg.goal ?? ''} placeholder="None"
                  onChange={e => {
                    const n = parseFloat(e.target.value)
                    set({ goal: Number.isFinite(n) ? n : undefined })
                  }} />
              </label>
              {typeof cfg.goal === 'number' && (
                <>
                  <label className="rb-ctl" htmlFor="rb-well-goaldir">
                    <small>Good When</small>
                    <select id="rb-well-goaldir" value={cfg.goalGood ?? 'above'}
                      onChange={e => set({ goalGood: e.target.value === 'below' ? 'below' : undefined })}>
                      <option value="above">At Or Above It</option>
                      <option value="below">At Or Below It</option>
                    </select>
                  </label>
                  <label className="rb-ctl" htmlFor="rb-well-goalcol">
                    <small>Measured On</small>
                    <select id="rb-well-goalcol" value={cfg.goalCol ?? ''}
                      onChange={e => set({ goalCol: e.target.value || undefined })}>
                      <option value="">The Value Being Drawn</option>
                      {nums.map(c => <option key={c} value={c}>{labelFor(c)}</option>)}
                    </select>
                  </label>
                </>
              )}
            </div>
            {typeof cfg.goal === 'number' && (
              <div className="rb-well-opts">
                <label>
                  <input type="checkbox" checked={!!cfg.colorByGoal}
                    onChange={e => set({ colorByGoal: e.target.checked || undefined })} />
                  <span>
                    {viz === 'kpi' ? 'Colour the figure by it'
                      : viz === 'table' || viz === 'matrix' ? 'Colour the cells by it'
                      : 'Colour the bars by it'}
                  </span>
                </label>
              </div>
            )}
            <p className="rb-viz-note">
              A blank or non-numeric figure is left uncoloured rather than marked as a failure:
              a missing number is no news, not bad news.
            </p>
          </div>
        )}
      </div>

      <div className="rb-preview">
        <div className="rb-preview-head">
          <span>Preview</span>
          {!loading && !error && (
            <i>
              {rowCount.toLocaleString('en-NG')} row{rowCount === 1 ? '' : 's'}
              {trimmed && ' · preview shows the first 200'}
            </i>
          )}
        </div>
        <div className="rb-preview-body">
          {loading ? <Sk h={220} />
            : error ? (
              <div className="rb-note error">
                <span className="material-symbols-rounded" aria-hidden="true">error</span>
                <span>{error}</span>
              </div>
            ) : !columns.length ? (
              <EmptyState icon="query_stats" title="Nothing to Draw Yet"
                description="Shape the data on the Data step: pick columns, or a grouping and a measure. The tile appears here as soon as there is something to draw." />
            ) : (
              <TileVisual viz={viz} config={cfg} columns={columns} rows={rows}
                rowCount={rowCount} height={240} />
            )}
        </div>
      </div>
    </div>
  )
}
