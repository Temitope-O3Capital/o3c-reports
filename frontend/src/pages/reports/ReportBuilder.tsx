import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { toast } from 'sonner'
import { Page, Tabs, DateFilter, ConfirmModal, Modal, Button, EmptyState } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { currentUser, hasPage } from '../../hooks/useAuth'
import './builder/builder.css'
import {
  NUMERIC, WINDOWS, emptyReport, fmtCell, fromConfig, reportForDataset, resolveWindow, toConfig,
  type Dataset, type ReportState, type View,
} from './builder/model'
import { downloadReport, fetchReportJson, unwrap } from './builder/api'
import { FieldList } from './builder/FieldList'
import { FilterBar } from './builder/FilterBar'
import { TableView } from './builder/TableView'
import { SummaryView } from './builder/SummaryView'
import { Popover } from './builder/Popover'
import { SourcePicker } from './builder/SourcePicker'
import { EmailModal, Labeled, SavedTab, ScheduleModal, SchedulesTab, type SavedReport, type Schedule } from './builder/parts'

// The unsaved draft is kept per user: on a shared machine one person's half-built report,
// on their department's data, must never be restored into someone else's session.
const LEGACY_DRAFT_KEY = 'o3c_report_builder_draft'
const draftKey = () => `${LEGACY_DRAFT_KEY}:${currentUser()?.id ?? 'anon'}`
const PDF_MAX_ROWS = 2000

export default function ReportBuilder() {
  const [params] = useSearchParams()
  const [tab, setTab] = useState(() => {
    const t = params.get('tab')
    return t === 'saved' || t === 'schedules' ? t : 'build'
  })
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [dsLoaded, setDsLoaded] = useState(false)
  const [dsError, setDsError] = useState<string | null>(null)
  const [dsKey, setDsKey] = useState('')
  const [report, setReport] = useState<ReportState>(emptyReport)
  // baseline is the report as last opened or saved, to tell whether anything changed.
  const [baseline, setBaseline] = useState('')
  const [filterRequest, setFilterRequest] = useState<{ key: string; nonce: number } | null>(null)

  const [loadedId, setLoadedId] = useState<number | null>(null)
  const [loadedMine, setLoadedMine] = useState(true)
  const [reportName, setReportName] = useState('')
  const [reportDesc, setReportDesc] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [saveAsNew, setSaveAsNew] = useState(false)

  const [saved, setSaved] = useState<SavedReport[]>([])
  const [savedError, setSavedError] = useState<string | null>(null)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [schedulesError, setSchedulesError] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  // The save dialog edits its own copy of the name, description and sharing, taken on by
  // the open report only once the save succeeds, so cancelling (a Duplicate especially)
  // leaves the open report as it was.
  const [saveForm, setSaveForm] = useState({ name: '', desc: '', isPublic: false })
  // Set when Save Report First was chosen in the schedule dialog, to go back there once saved.
  const [scheduleAfterSave, setScheduleAfterSave] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [schedOpen, setSchedOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ kind: 'report' | 'schedule'; id: number; name: string } | null>(null)
  const [confirmAction, setConfirmAction] = useState<
    { kind: 'switch'; key: string } | { kind: 'new' } | { kind: 'open'; rep: SavedReport; then: 'edit' | 'email' | 'schedule' } | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [exportMenu, setExportMenu] = useState<HTMLElement | null>(null)
  const [exporting, setExporting] = useState(false)

  const scoped = !hasPage('reports')
  const ds = useMemo(() => datasets.find(d => d.key === dsKey) ?? null, [datasets, dsKey])
  const patch = useCallback((p: Partial<ReportState>) => setReport(r => ({ ...r, ...p })), [])
  const config = useMemo(() => toConfig(report), [report])
  const configKey = useMemo(() => JSON.stringify(config), [config])
  const isDirty = !!dsKey && configKey !== baseline
  const title = reportName || (ds ? `${ds.label} Report` : 'Report')
  const canRun = !!ds && (report.view === 'table'
    ? report.columns.length > 0
    : report.rows.length + report.cols.length + report.values.length > 0)
  const grouped = useMemo(() => {
    const g: Record<string, Dataset[]> = {}
    for (const d of datasets) (g[d.module] ??= []).push(d)
    return g
  }, [datasets])

  // A list that fails to load says so, with a way to try again, rather than passing for an
  // empty one.
  const refreshSaved = () => apiFetch<any>('/api/reports/saved')
    .then(r => { setSaved(unwrap<SavedReport[]>(r) ?? []); setSavedError(null) })
    .catch(e => setSavedError(e.message))
  const refreshSchedules = () => apiFetch<any>('/api/reports/schedules')
    .then(r => { setSchedules(unwrap<Schedule[]>(r) ?? []); setSchedulesError(null) })
    .catch(e => setSchedulesError(e.message))

  useEffect(() => {
    apiFetch<any>('/api/reports/datasets')
      .then(r => { setDatasets(unwrap<Dataset[]>(r) ?? []); setDsLoaded(true) })
      .catch(e => setDsError(e.message))
    refreshSaved()
    refreshSchedules()
  }, [])

  // ── Draft ──────────────────────────────────────────────────────────────────
  const draftRestored = useRef(false)
  useEffect(() => {
    if (draftRestored.current) return
    draftRestored.current = true
    try {
      localStorage.removeItem(LEGACY_DRAFT_KEY)
      const raw = localStorage.getItem(draftKey())
      if (!raw) return
      const d = JSON.parse(raw)
      if (!d || d.v !== 2 || !d.dsKey) { localStorage.removeItem(draftKey()); return }
      setDsKey(d.dsKey)
      setReport(fromConfig(d.config))
      setBaseline(d.baseline ?? '')
      setReportName(d.reportName ?? ''); setReportDesc(d.reportDesc ?? ''); setIsPublic(!!d.isPublic)
      setLoadedId(d.loadedId ?? null); setLoadedMine(d.loadedMine ?? true)
    } catch { /* a corrupt or blocked draft is skipped, never fatal */ }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (!dsKey) { localStorage.removeItem(draftKey()); return }
        localStorage.setItem(draftKey(), JSON.stringify({
          v: 2, dsKey, config, baseline, reportName, reportDesc, isPublic, loadedId, loadedMine,
        }))
      } catch { /* storage full or unavailable — best effort */ }
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsKey, configKey, baseline, reportName, reportDesc, isPublic, loadedId, loadedMine])
  const clearDraft = () => { try { localStorage.removeItem(draftKey()) } catch { /* ignore */ } }

  // ── Starting, switching, opening ───────────────────────────────────────────
  const startReport = (key: string) => {
    const next = datasets.find(d => d.key === key)
    const r = next ? reportForDataset(next) : emptyReport()
    setDsKey(key)
    setReport(r)
    setBaseline(JSON.stringify(toConfig(r)))
    setLoadedId(null); setLoadedMine(true); setReportName(''); setReportDesc(''); setIsPublic(false)
    setFilterRequest(null)
  }

  // A restored draft can point at a data source this person can no longer use.
  useEffect(() => {
    if (!dsLoaded || !dsKey || datasets.some(d => d.key === dsKey)) return
    startReport('')
    toast.error("That data source isn't available to you, so the unsaved report was cleared.")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsLoaded, datasets, dsKey])

  const pickDataset = (key: string) => {
    if (!key || key === dsKey) return
    if (isDirty) { setConfirmAction({ kind: 'switch', key }); return }
    startReport(key)
  }
  const startNew = () => {
    if (isDirty) { setConfirmAction({ kind: 'new' }); return }
    startReport('')
  }

  const setView = (view: View) => {
    if (!ds || view === report.view) return
    if (view === 'table' && report.columns.length === 0) {
      const d = reportForDataset(ds)
      patch({ view, columns: d.columns, totals: d.totals, tableSort: d.tableSort })
      return
    }
    patch({ view })
  }
  const groupBy = (key: string) => patch({
    view: 'summary', rows: [key], cols: [],
    values: report.values.length ? report.values : [{ column: '', agg: 'count' }],
    summarySort: [], hiddenCols: [], topN: null,
  })

  const loadSaved = (rep: SavedReport) => {
    const r = fromConfig(rep.config)
    setDsKey(rep.dataset)
    setReport(r)
    setBaseline(JSON.stringify(toConfig(r)))
    setLoadedId(rep.id); setReportName(rep.name); setReportDesc(rep.description || ''); setIsPublic(rep.is_public)
    setLoadedMine(rep.is_mine !== false)
    setSaveAsNew(false)
    setFilterRequest(null)
    setTab('build')
  }
  const proceedOpen = (rep: SavedReport, then: 'edit' | 'email' | 'schedule') => {
    loadSaved(rep)
    if (then === 'email') setEmailOpen(true)
    if (then === 'schedule') { setEditingSchedule(null); setSchedOpen(true) }
  }
  // Opening a saved report replaces the one being built, so unsaved work is confirmed first.
  const openSaved = (rep: SavedReport, then: 'edit' | 'email' | 'schedule') => {
    if (isDirty) { setConfirmAction({ kind: 'open', rep, then }); return }
    proceedOpen(rep, then)
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  const openSave = (asNew: boolean) => {
    setSaveAsNew(asNew)
    setSaveForm(asNew
      ? { name: reportName ? `${reportName} (copy)` : '', desc: reportDesc, isPublic: false }
      : { name: reportName, desc: reportDesc, isPublic })
    setSaveOpen(true)
  }
  const closeSave = () => { setSaveOpen(false); setSaveAsNew(false); setScheduleAfterSave(false) }
  const doSave = async () => {
    const name = saveForm.name.trim()
    if (!name) { toast.error('Give the report a name'); return }
    if (!dsKey) { toast.error('Choose a data source first'); return }
    setBusy(true)
    try {
      const payload = { name, description: saveForm.desc, dataset: dsKey, is_public: saveForm.isPublic, config }
      if (loadedId && !saveAsNew && loadedMine) {
        await apiPut(`/api/reports/saved/${loadedId}`, payload)
        toast.success('Report saved')
      } else {
        const created = unwrap<any>(await apiPost('/api/reports/saved', payload))
        setLoadedId(created?.id ?? null)
        setLoadedMine(true)
        toast.success(saveAsNew ? 'Saved as a new report' : 'Report saved')
      }
      setReportName(name); setReportDesc(saveForm.desc); setIsPublic(saveForm.isPublic)
      setBaseline(configKey)
      setSaveOpen(false); setSaveAsNew(false); clearDraft(); refreshSaved()
      if (scheduleAfterSave) { setScheduleAfterSave(false); setEditingSchedule(null); setSchedOpen(true) }
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  const openDuplicate = () => openSave(true)
  const duplicateSaved = async (rep: SavedReport) => {
    try {
      await apiPost('/api/reports/saved', { name: `${rep.name} (copy)`, description: rep.description, dataset: rep.dataset, is_public: false, config: rep.config })
      toast.success(`Duplicated “${rep.name}”`)
      refreshSaved()
    } catch (e: any) { toast.error(e.message) }
  }
  const deleteConfirmed = async () => {
    if (!confirmDel) return
    setBusy(true)
    try {
      if (confirmDel.kind === 'report') {
        await apiDelete(`/api/reports/saved/${confirmDel.id}`)
        if (loadedId === confirmDel.id) setLoadedId(null)
        refreshSaved(); refreshSchedules()
      } else {
        await apiDelete(`/api/reports/schedules/${confirmDel.id}`)
        refreshSchedules()
      }
      toast.success('Deleted')
      setConfirmDel(null)
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  const capNote = 'The file stopped at the data source’s row limit.'
  const exportFile = async (format: 'xlsx' | 'csv') => {
    setExportMenu(null)
    if (!ds) return
    setExporting(true)
    try {
      const res = await downloadReport(format, title, ds.key, config)
      toast.success(`Downloaded ${res.filename}`, res.truncated ? { description: capNote } : undefined)
    } catch (e: any) { toast.error(e.message) } finally { setExporting(false) }
  }
  const exportPdf = async () => {
    setExportMenu(null)
    if (!ds) return
    setExporting(true)
    try {
      const j = await fetchReportJson(title, ds.key, config)
      // A Table with totals comes back with its totals line as the last row, counted in
      // row_count (the server adds it whenever the report totals any column). It is kept
      // out of the row limit, so a long PDF still ends on its totals, and out of the count.
      const totalsRow = report.view === 'table' && report.totals.length > 0 && j.columns.length > 0 && j.data.length > 0
        ? j.data[j.data.length - 1]
        : null
      const records = totalsRow ? j.data.slice(0, -1) : j.data
      const recordCount = totalsRow ? Math.max(0, j.row_count - 1) : j.row_count
      const rows = records.slice(0, PDF_MAX_ROWS)
      const cells = (row: Record<string, any>) => j.columns.map(c => fmtCell(row[c.key], c.type, true))
      const doc = new jsPDF({ orientation: j.columns.length > 6 ? 'landscape' : 'portrait' })
      doc.setFontSize(14)
      doc.text(title, 14, 16)
      doc.setFontSize(9)
      doc.setTextColor(110)
      const r = resolveWindow(report.win, { from: report.from, to: report.to })
      const period = ds.date_label ? `${ds.date_label}: ${r.from} to ${r.to}  ·  ` : ''
      const more = records.length > PDF_MAX_ROWS ? ` (first ${PDF_MAX_ROWS.toLocaleString()} shown; export to Excel for all)` : ''
      doc.text(`${period}${recordCount.toLocaleString()} rows${more}`, 14, 22)
      autoTable(doc, {
        head: [j.columns.map(c => c.label)],
        // The totals line goes at the end of the body rather than in a table foot, which
        // autoTable would repeat on every page.
        body: [...rows.map(cells), ...(totalsRow ? [cells(totalsRow)] : [])],
        didParseCell: d => {
          if (totalsRow && d.section === 'body' && d.row.index === rows.length) {
            d.cell.styles.fontStyle = 'bold'
            d.cell.styles.fillColor = [226, 232, 240]
          }
        },
        startY: 26,
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [14, 40, 65], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 247, 250] },
        columnStyles: Object.fromEntries(j.columns.map((c, i) => [i, { halign: NUMERIC.has(c.type) ? 'right' : 'left' }])),
      })
      doc.save(`${title.replace(/[^\w-]+/g, '_')}.pdf`)
    } catch (e: any) { toast.error(e.message) } finally { setExporting(false) }
  }

  const sendEmail = async (recipients: string[], format: string, message: string) => {
    setBusy(true)
    try {
      const r = unwrap<any>(await apiPost('/api/reports/pivot-email', { name: title, dataset: dsKey, config, recipients, format, message }))
      // The server counts the addresses it actually sent to, after dropping duplicates.
      const n = typeof r?.recipients === 'number' ? r.recipients : recipients.length
      toast.success(`Report emailed to ${n} recipient${n === 1 ? '' : 's'}`, r?.truncated ? { description: capNote } : undefined)
      setEmailOpen(false)
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  const tabs = [
    { key: 'build', label: 'Builder' },
    { key: 'saved', label: 'Saved Reports', badge: saved.length || undefined },
    { key: 'schedules', label: 'Schedules', badge: schedules.filter(s => s.is_active).length || undefined },
  ]

  return (
    <Page title="Report Builder" subtitle="Build a table or a summary from your data, then save, export, email or schedule it">
      <div className="rb">
        {dsError && (
          <div className="rb-note error">
            <span className="material-symbols-rounded" aria-hidden="true">error</span>
            <span>{dsError} <button type="button" className="rb-link" onClick={() => location.reload()}>Try Again</button></span>
          </div>
        )}
        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'build' && (
          <>
            <div className="rb-toolbar">
              <SourcePicker datasets={datasets} value={dsKey} onPick={pickDataset} />
              {ds?.date_label && (
                <>
                  <label className="rb-ctl" htmlFor="rb-window">
                    <small>Period on {ds.date_label}</small>
                    <select id="rb-window" value={report.win} onChange={e => patch({ win: e.target.value })}>
                      {WINDOWS.map(w => <option key={w.k} value={w.k}>{w.label}</option>)}
                    </select>
                  </label>
                  {report.win === 'custom' && <DateFilter from={report.from} to={report.to} onChange={(f, t) => patch({ from: f, to: t })} align="left" />}
                </>
              )}
              {ds && (
                <div className="rb-seg" role="group" aria-label="View">
                  <button type="button" aria-pressed={report.view === 'table'} onClick={() => setView('table')}>
                    <span className="material-symbols-rounded" aria-hidden="true">table_rows</span>Table
                  </button>
                  <button type="button" aria-pressed={report.view === 'summary'} onClick={() => setView('summary')}>
                    <span className="material-symbols-rounded" aria-hidden="true">pivot_table_chart</span>Summary
                  </button>
                </div>
              )}
              {loadedId && (
                <span className="rb-badge" title={reportName}>
                  {loadedMine ? '' : 'Shared · '}{reportName}{isDirty ? ' · Unsaved Changes' : ''}
                </span>
              )}
              <span className="rb-spacer" aria-hidden="true" />
              <div className="rb-actions">
                <button type="button" className="rb-tbtn ghost" onClick={startNew}>
                  <span className="material-symbols-rounded" aria-hidden="true">add</span>New
                </button>
                <span className="rb-divider" aria-hidden="true" />
                {loadedId && !loadedMine ? (
                  <button type="button" className="rb-tbtn primary" disabled={!canRun} onClick={openDuplicate}>
                    <span className="material-symbols-rounded" aria-hidden="true">content_copy</span>Save a Copy
                  </button>
                ) : (
                  <button type="button" className="rb-tbtn primary" disabled={!canRun || (!!loadedId && !isDirty)}
                    onClick={() => openSave(false)}>
                    <span className="material-symbols-rounded" aria-hidden="true">save</span>{loadedId ? 'Save Changes' : 'Save'}
                  </button>
                )}
                {loadedId && loadedMine && (
                  <button type="button" className="rb-tbtn" disabled={!canRun} onClick={openDuplicate}>
                    <span className="material-symbols-rounded" aria-hidden="true">content_copy</span>Duplicate
                  </button>
                )}
                <button type="button" className="rb-tbtn" disabled={!canRun || exporting} aria-haspopup="menu" aria-expanded={!!exportMenu}
                  onClick={e => setExportMenu(exportMenu ? null : e.currentTarget)}>
                  <span className="material-symbols-rounded" aria-hidden="true">download</span>{exporting ? 'Exporting…' : 'Export'}
                  <span className="rb-caret" aria-hidden="true">▼</span>
                </button>
                <button type="button" className="rb-tbtn" disabled={!canRun} onClick={() => setEmailOpen(true)}>
                  <span className="material-symbols-rounded" aria-hidden="true">mail</span>Email
                </button>
                <button type="button" className="rb-tbtn" disabled={!canRun} onClick={() => { setEditingSchedule(null); setSchedOpen(true) }}>
                  <span className="material-symbols-rounded" aria-hidden="true">schedule</span>Schedule
                </button>
              </div>
            </div>

            {exportMenu && (
              <Popover anchorEl={exportMenu} onClose={() => setExportMenu(null)} width={250} label="Export">
                <div className="rb-menu-list">
                  <button type="button" onClick={() => exportFile('xlsx')}><span>Excel</span><i>.xlsx</i></button>
                  <button type="button" onClick={() => exportFile('csv')}><span>CSV</span><i>.csv</i></button>
                  <button type="button" onClick={exportPdf}><span>PDF</span><i>.pdf</i></button>
                </div>
                <div className="rb-menu-note">
                  Exactly what’s on screen: your columns, names, order and sort, with every matching record.
                </div>
              </Popover>
            )}

            {scoped && dsLoaded && datasets.length > 0 && (
              <div className="rb-note">
                <span className="material-symbols-rounded" aria-hidden="true">shield_person</span>
                <span>You can report on your departments’ data: <b>{Object.keys(grouped).join(', ')}</b>. Other data sources aren’t available to your role.</span>
              </div>
            )}

            {dsLoaded && datasets.length === 0 ? (
              <div className="rb-body rb-empty">
                <EmptyState icon="lock" title="No Data Sources for Your Role Yet"
                  description="The Report Builder shows the data your departments cover, and none of your roles covers a data source yet. An administrator can add the module to your role in User Management." />
              </div>
            ) : !ds ? (
              <div className="rb-body rb-empty">
                <EmptyState icon="table_chart" title="Choose a Data Source"
                  description="You start with a table of its main columns. Click fields to add or remove columns, and click any column's header to see its values, filter, sort or rename it." />
              </div>
            ) : (
              <div className="rb-body">
                <FieldList ds={ds} report={report} onChange={patch} onAddFilter={key => setFilterRequest({ key, nonce: Date.now() })} />
                <div className="rb-main">
                  <FilterBar ds={ds} report={report} onChange={patch} request={filterRequest} onRequestHandled={() => setFilterRequest(null)} />
                  {report.view === 'table'
                    ? <TableView ds={ds} report={report} onChange={patch} onGroupBy={groupBy} />
                    : <SummaryView ds={ds} report={report} onChange={patch} onSwitchToTable={() => setView('table')} />}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'saved' && savedError && (
          <div className="rb-note error">
            <span className="material-symbols-rounded" aria-hidden="true">error</span>
            <span>Saved reports didn’t load: {savedError} <button type="button" className="rb-link" onClick={() => refreshSaved()}>Try Again</button></span>
          </div>
        )}
        {tab === 'saved' && (!savedError || saved.length > 0) && (
          <SavedTab saved={saved} datasets={datasets} onOpen={rep => openSaved(rep, 'edit')} onDuplicate={duplicateSaved}
            onEmail={rep => openSaved(rep, 'email')}
            onSchedule={rep => openSaved(rep, 'schedule')}
            onDelete={rep => setConfirmDel({ kind: 'report', id: rep.id, name: rep.name })} />
        )}

        {tab === 'schedules' && schedulesError && (
          <div className="rb-note error">
            <span className="material-symbols-rounded" aria-hidden="true">error</span>
            <span>Schedules didn’t load: {schedulesError} <button type="button" className="rb-link" onClick={() => refreshSchedules()}>Try Again</button></span>
          </div>
        )}
        {tab === 'schedules' && (!schedulesError || schedules.length > 0) && (
          <SchedulesTab schedules={schedules}
            onToggle={async s => {
              try {
                await apiPut(`/api/reports/schedules/${s.id}`, { is_active: !s.is_active })
                toast.success(s.is_active ? 'Schedule paused' : 'Schedule resumed')
                refreshSchedules()
              } catch (e: any) { toast.error(e.message) }
            }}
            onEdit={s => { setEditingSchedule(s); setSchedOpen(true) }}
            onRunNow={async s => {
              try {
                const r = unwrap<any>(await apiPost(`/api/reports/schedules/${s.id}/run-now`, {}))
                toast.success(r?.status ? `Sent · ${r.status}` : 'Sent')
                refreshSchedules()
              } catch (e: any) { toast.error(e.message) }
            }}
            onDelete={s => setConfirmDel({ kind: 'schedule', id: s.id, name: s.report_name })} />
        )}
      </div>

      <Modal open={saveOpen} onClose={closeSave}
        title={saveAsNew ? 'Save as a New Report' : loadedId ? 'Save Changes' : 'Save Report'}
        footer={<><Button variant="ghost" onClick={closeSave}>Cancel</Button><Button loading={busy} onClick={doSave}>{saveAsNew ? 'Save as New' : 'Save'}</Button></>}>
        {saveAsNew && <div className="rb-hint" style={{ marginBottom: 12 }}>This creates a separate copy. The original report is left as it is.</div>}
        <Labeled label="Report Name" htmlFor="rb-save-name">
          <input id="rb-save-name" className="rb-input" value={saveForm.name} onChange={e => { const v = e.target.value; setSaveForm(f => ({ ...f, name: v })) }} placeholder="e.g. Inbound calls this week" autoFocus />
        </Labeled>
        <Labeled label="Description (Optional)" htmlFor="rb-save-desc">
          <textarea id="rb-save-desc" className="rb-input" value={saveForm.desc} onChange={e => { const v = e.target.value; setSaveForm(f => ({ ...f, desc: v })) }} rows={2} style={{ resize: 'vertical' }} />
        </Labeled>
        <label htmlFor="rb-save-public" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--txt)' }}>
          <input id="rb-save-public" type="checkbox" checked={saveForm.isPublic} onChange={e => { const v = e.target.checked; setSaveForm(f => ({ ...f, isPublic: v })) }} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
          Share with colleagues who report on this data (they can open and copy it, not change it)
        </label>
      </Modal>

      <EmailModal open={emailOpen} onClose={() => setEmailOpen(false)} name={title} onSend={sendEmail} busy={busy} restricted={scoped} />

      <ScheduleModal open={schedOpen} onClose={() => { setSchedOpen(false); setEditingSchedule(null) }}
        needsSave={!loadedId && !editingSchedule} unsavedChanges={isDirty}
        initial={editingSchedule ?? undefined} restricted={scoped}
        period={!editingSchedule && ds?.date_label
          ? { label: WINDOWS.find(w => w.k === report.win)?.label ?? report.win, fixed: report.win === 'custom', from: report.from, to: report.to, dateLabel: ds.date_label }
          : undefined}
        onSaveFirst={() => { setSchedOpen(false); openSave(false); setScheduleAfterSave(true) }}
        onSubmit={async payload => {
          setBusy(true)
          try {
            if (editingSchedule) {
              await apiPut(`/api/reports/schedules/${editingSchedule.id}`, payload)
              toast.success('Schedule updated')
            } else {
              if (!loadedId) return
              await apiPost(`/api/reports/saved/${loadedId}/schedule`, payload)
              toast.success('Schedule created')
            }
            setSchedOpen(false); setEditingSchedule(null); setTab('schedules'); refreshSchedules()
          } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
        }} busy={busy} />

      <ConfirmModal open={!!confirmDel} title={`Delete ${confirmDel?.kind === 'report' ? 'Report' : 'Schedule'}?`}
        body={confirmDel ? `“${confirmDel.name}” will be permanently removed.` : ''}
        danger loading={busy} confirmLabel="Delete" onConfirm={deleteConfirmed} onClose={() => setConfirmDel(null)} />

      <ConfirmModal open={!!confirmAction}
        title={confirmAction?.kind === 'new' ? 'Start a New Report?' : 'Discard Unsaved Changes?'}
        body={confirmAction?.kind === 'open'
          ? `Opening “${confirmAction.rep.name}” replaces the report you have open now. Save first if you want to keep it.`
          : (confirmAction?.kind === 'new'
            ? 'This clears the columns, filters and settings you have now. '
            : 'Switching data source clears the columns, filters and settings you have now. ')
            + 'Save first if you want to keep them.'}
        danger confirmLabel={confirmAction?.kind === 'new' ? 'Start New' : confirmAction?.kind === 'open' ? 'Discard and Open' : 'Discard and Switch'}
        onConfirm={() => {
          if (confirmAction?.kind === 'switch') startReport(confirmAction.key)
          if (confirmAction?.kind === 'new') startReport('')
          if (confirmAction?.kind === 'open') proceedOpen(confirmAction.rep, confirmAction.then)
          setConfirmAction(null)
        }}
        onClose={() => setConfirmAction(null)} />
    </Page>
  )
}
