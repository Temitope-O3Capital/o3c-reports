import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Modal, Button, DateFilter, EmptyState } from '../../../components/UI'
import { apiFetch, apiPost, apiPut, unwrap } from '../../../lib/api'
import './builder.css'
import {
  WINDOWS, emptyReport, fromConfig, reportForDataset, toConfig,
  type Dataset, type ReportState, type View,
} from './model'
import { FieldList } from './FieldList'
import { FilterBar } from './FilterBar'
import { TableView } from './TableView'
import { SummaryView } from './SummaryView'
import { SourcePicker } from './SourcePicker'
import { TileVizPanel } from './TileVizPanel'
import { pruneForViz, type TileVizConfig, type VizKind } from './tileViz'

/*
  Building a dashboard tile from a data source, with the Report Builder's own controls.

  WHY THIS IS NOT "SQL ON A TILE". A tile reads a saved report and never carries a query;
  that is what lets a shared dashboard re-check every tile against the person looking at
  it. This screen keeps that intact by having the dashboard WRITE the report: on save the
  server inserts one pivot_reports row flagged tile_only and a tile pointing at it, in a
  single statement (see handlers/dashboard_from_dataset.go). So the tile still holds a
  foreign key, and nothing about the read path changes.

  The report it writes is hidden from the saved-reports library and from the tile source
  picker, because a dashboard of twelve charts should not put twelve entries nobody chose
  to create into the place people browse for reports.

  WHY THE COMPONENTS ARE REUSED RATHER THAN REBUILT. FieldList, FilterBar, TableView and
  SummaryView are the same ones the Report Builder renders, fed the same ReportState. A
  second, simpler field picker written just for dashboards would drift from the real one
  within a release — and it would not get Related Data, the column menus, or the summary
  grid for free.
*/

export type TileBuilderEdit = {
  tileId: number
  name: string
  viz: string
  dataset: string
  /** The report config: what the tile reads. */
  config: unknown
  /** The tile config: how the tile draws it. */
  vizConfig?: unknown
}

export function TileBuilder({ dashboardId, nextY, editing, onClose, onSaved }: {
  dashboardId: string
  nextY: number
  editing?: TileBuilderEdit | null
  onClose: () => void
  onSaved: () => void
}) {
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [dsLoaded, setDsLoaded] = useState(false)
  const [dsError, setDsError] = useState<string | null>(null)
  const [dsKey, setDsKey] = useState(editing?.dataset ?? '')
  const [report, setReport] = useState<ReportState>(
    () => (editing ? fromConfig(editing.config) : emptyReport()),
  )
  const [filterRequest, setFilterRequest] = useState<{ key: string; nonce: number } | null>(null)
  const [title, setTitle] = useState(editing?.name ?? '')
  const [viz, setViz] = useState<string>(editing?.viz ?? 'bar')
  const [busy, setBusy] = useState(false)
  // Set once the title has been typed in, so picking a source stops overwriting it.
  const [titleTouched, setTitleTouched] = useState(!!editing)

  // Two steps, because they are two different jobs: what the tile reads, then how it
  // draws. Power-BI-shaped, and it keeps the dialog from being a wall of controls.
  const [step, setStep] = useState<'data' | 'visual'>('data')
  const [vizCfg, setVizCfg] = useState<TileVizConfig>(
    () => ((editing?.vizConfig ?? {}) as TileVizConfig),
  )
  // The preview: real rows, run through the same path the saved tile will use.
  const [pv, setPv] = useState<{
    columns: string[]; rows: Record<string, unknown>[]; rowCount: number; trimmed: boolean
  }>({ columns: [], rows: [], rowCount: 0, trimmed: false })
  const [pvLoading, setPvLoading] = useState(false)
  const [pvError, setPvError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<any>('/api/reports/datasets')
      .then(r => { setDatasets(unwrap<Dataset[]>(r) ?? []); setDsLoaded(true) })
      .catch(e => setDsError(e?.message || 'Could not load the data sources'))
  }, [])

  const ds = useMemo(() => datasets.find(d => d.key === dsKey) ?? null, [datasets, dsKey])
  const patch = useCallback((p: Partial<ReportState>) => setReport(r => ({ ...r, ...p })), [])

  // The shape the preview depends on. Stringified so the effect below fires when the
  // report actually changes, not on every keystroke that leaves it equivalent.
  const cfgKey = useMemo(() => (dsKey ? JSON.stringify(toConfig(report)) : ''), [dsKey, report])

  // Fetch the preview only while the Visual step is open: it is a real report run, and
  // running it on every edit of the Data step would be a query per keystroke.
  useEffect(() => {
    if (step !== 'visual' || !dsKey || !cfgKey) return
    let alive = true
    setPvLoading(true)
    setPvError(null)
    apiPost('/api/dashboards/tile-preview', { dataset: dsKey, config: JSON.parse(cfgKey) })
      .then(res => {
        if (!alive) return
        const d = unwrap<any>(res) ?? {}
        setPv({
          columns: Array.isArray(d.columns) ? d.columns : [],
          rows: Array.isArray(d.rows) ? d.rows : [],
          rowCount: typeof d.row_count === 'number' ? d.row_count : 0,
          trimmed: !!d.preview_trimmed,
        })
      })
      .catch(e => { if (alive) setPvError(e?.message || 'That shape could not be run') })
      .finally(() => { if (alive) setPvLoading(false) })
    return () => { alive = false }
  }, [step, dsKey, cfgKey])

  // Changing the visual drops settings the new kind cannot use, so a config never carries
  // options that silently do nothing.
  const changeViz = useCallback((v: VizKind) => {
    setViz(v)
    setVizCfg(c => pruneForViz(v, c))
  }, [])

  // The same rule the Report Builder uses: a table needs columns, a summary needs
  // something on at least one axis.
  const hasShape = !!ds && (report.view === 'table'
    ? report.columns.length > 0
    : report.rows.length + report.cols.length + report.values.length > 0)
  const canSave = hasShape && title.trim().length > 0 && !busy

  function pickDataset(key: string) {
    if (!key || key === dsKey) return
    const next = datasets.find(d => d.key === key)
    setDsKey(key)
    setReport(next ? reportForDataset(next) : emptyReport())
    setFilterRequest(null)
    // A tile nobody has named yet takes the source's name, which is right far more often
    // than an empty box. Once it has been edited by hand it is left alone.
    if (!titleTouched && next) setTitle(next.label)
  }

  function setView(v: View) {
    if (!ds || v === report.view) return
    if (v === 'table' && report.columns.length === 0) {
      const d = reportForDataset(ds)
      patch({ view: v, columns: d.columns, totals: d.totals, tableSort: d.tableSort })
    } else {
      patch({ view: v })
    }
    // A table of rows is not a bar chart, and a summary usually is. Nudge the visual to
    // match the shape being built, without locking the choice.
    const next = v === 'table' && viz !== 'table' ? 'table'
      : v === 'summary' && viz === 'table' ? 'bar'
        : viz
    if (next !== viz) changeViz(next as VizKind)
    // The shape changed, so columns chosen against the old one may not exist any more.
    // Clearing is honest: resolveViz falls back to its automatic choice until the wells
    // are set again, rather than silently drawing a column that is no longer there.
    setVizCfg(c => ({ ...c, label: undefined, values: undefined, lines: undefined, sortBy: undefined, compare: undefined }))
  }

  const groupBy = (key: string) => patch({
    view: 'summary', rows: [key], cols: [],
    values: report.values.length ? report.values : [{ column: '', agg: 'count' }],
    summarySort: [], hiddenCols: [], topN: null,
  })

  async function save() {
    const name = title.trim()
    if (!name) { toast.error('Give the tile a title'); return }
    if (!dsKey) { toast.error('Choose a data source first'); return }
    setBusy(true)
    try {
      const config = toConfig(report)
      // Pruned on the way out as well as on every change, so a config saved while the
      // kind was being switched cannot carry settings the final kind ignores.
      const viz_config = pruneForViz(viz, vizCfg)
      if (editing) {
        await apiPut(`/api/dashboards/tiles/${editing.tileId}/dataset`, { name, config, viz, viz_config })
        toast.success('Tile updated')
      } else {
        await apiPost(`/api/dashboards/${dashboardId}/tiles/from-dataset`, {
          name, dataset: dsKey, config, viz, viz_config,
          grid_x: 0, grid_y: nextY,
          grid_w: viz === 'kpi' ? 3 : 6,
          grid_h: viz === 'kpi' ? 2 : 4,
        })
        toast.success('Tile added')
      }
      onSaved()
    } catch (e: any) {
      toast.error(e?.message || 'Could not save the tile')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={1240}
      title={editing ? `Edit “${editing.name}”` : 'Build a Tile From Data'}
      footer={
        <div className="rb-tile-foot">
          <label className="rb-ctl rb-tile-name" htmlFor="rb-tile-title">
            <small>Tile Title</small>
            <input id="rb-tile-title" value={title} maxLength={120}
              placeholder={ds ? ds.label : 'Name this tile…'}
              onChange={e => { setTitle(e.target.value); setTitleTouched(true) }} />
          </label>
          <span className="rb-spacer" aria-hidden="true" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          {step === 'data' ? (
            <Button icon="arrow_forward" disabled={!hasShape} onClick={() => setStep('visual')}>
              Choose the Visual
            </Button>
          ) : (
            <Button onClick={save} disabled={!canSave}>
              {busy ? 'Saving…' : editing ? 'Save Tile' : 'Add to Dashboard'}
            </Button>
          )}
        </div>
      }
    >
      {dsError && (
        <div className="rb-note error">
          <span className="material-symbols-rounded" aria-hidden="true">error</span>
          <span>{dsError}</span>
        </div>
      )}

      <div className="rb-toolbar">
        {!editing && <SourcePicker datasets={datasets} value={dsKey} onPick={pickDataset} />}
        {editing && ds && (
          <span className="rb-ctl rb-ctl-static">
            <small>Source</small>
            <b>{ds.label}</b>
          </span>
        )}
        {ds?.date_label && (
          <div className="rb-period">
            <label className="rb-ctl" htmlFor="rb-tile-window">
              <small>Period on {ds.date_label}</small>
              <select id="rb-tile-window" value={report.win} onChange={e => patch({ win: e.target.value })}>
                {WINDOWS.map(w => <option key={w.k} value={w.k}>{w.label}</option>)}
              </select>
            </label>
            {report.win === 'custom' && (
              <div className="rb-period-sub">
                <small>Dates</small>
                <DateFilter from={report.from} to={report.to} onChange={(f, t) => patch({ from: f, to: t })} align="left" />
              </div>
            )}
          </div>
        )}
        {ds && step === 'data' && (
          <div className="rb-seg" role="group" aria-label="Shape">
            <button type="button" aria-pressed={report.view === 'table'} onClick={() => setView('table')}>
              <span className="material-symbols-rounded" aria-hidden="true">table_rows</span>Rows
            </button>
            <button type="button" aria-pressed={report.view === 'summary'} onClick={() => setView('summary')}>
              <span className="material-symbols-rounded" aria-hidden="true">pivot_table_chart</span>Summary
            </button>
          </div>
        )}
        <span className="rb-spacer" aria-hidden="true" />
        {/* Two steps, not one scrolling wall: choose what the tile reads, then compose how
            it draws. The Visual step is disabled until the data has a shape, because
            field wells over no columns are a row of empty selects. */}
        {ds && (
          <div className="rb-seg rb-steps" role="group" aria-label="Step">
            <button type="button" aria-pressed={step === 'data'} onClick={() => setStep('data')}>
              <span className="material-symbols-rounded" aria-hidden="true">dataset</span>1 · Data
            </button>
            <button type="button" aria-pressed={step === 'visual'} disabled={!hasShape}
              title={hasShape ? undefined : 'Pick columns, or a grouping and a measure, first'}
              onClick={() => setStep('visual')}>
              <span className="material-symbols-rounded" aria-hidden="true">insights</span>2 · Visual
            </button>
          </div>
        )}
      </div>

      {!dsLoaded && !dsError ? (
        <div className="rb-body rb-empty">
          <EmptyState icon="hourglass_empty" title="Loading Your Data Sources" description="One moment." />
        </div>
      ) : dsLoaded && datasets.length === 0 ? (
        <div className="rb-body rb-empty">
          <EmptyState icon="lock" title="No Data Sources for Your Role Yet"
            description="A tile reads the data your departments cover, and none of your roles covers a data source yet. An administrator can add the module to your role in User Management." />
        </div>
      ) : !ds ? (
        <div className="rb-body rb-empty">
          <EmptyState icon="table_chart" title="Choose a Data Source"
            description="Pick a source and you get a table of its main columns. Click fields to add or remove them, drag to reorder, and click a column header to filter, sort or rename it. Then choose how the tile should draw it." />
        </div>
      ) : step === 'visual' ? (
        <div className="rb-body rb-body-tile">
          <TileVizPanel
            viz={viz} onViz={changeViz} cfg={vizCfg} onCfg={setVizCfg}
            columns={pv.columns} rows={pv.rows} rowCount={pv.rowCount}
            loading={pvLoading} error={pvError} trimmed={pv.trimmed}
          />
        </div>
      ) : (
        <div className="rb-body rb-body-tile">
          <FieldList ds={ds} report={report} onChange={patch}
            onAddFilter={key => setFilterRequest({ key, nonce: Date.now() })} />
          <div className="rb-main">
            <FilterBar ds={ds} report={report} onChange={patch} request={filterRequest}
              onRequestHandled={() => setFilterRequest(null)} />
            {report.view === 'table'
              ? <TableView ds={ds} report={report} onChange={patch} onGroupBy={groupBy} />
              : <SummaryView ds={ds} report={report} onChange={patch} onSwitchToTable={() => setView('table')} />}
          </div>
        </div>
      )}
    </Modal>
  )
}
