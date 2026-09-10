import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import { toast } from 'sonner'
import {
  Page, SectionCard, Spinner, ErrBanner, DateFilter, Tabs, Modal, ConfirmModal,
  Button, EmptyState, Badge,
} from '../../components/UI'
import { EBar, ELine, EArea, EDonut } from '../../components/echarts'
import { CHART_SERIES } from '../../components/charts'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { today } from '../../lib/fmt'
import { NAVY, GREEN, BLUE, PURPLE, RED, AMBER, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'

// ── Types mirror the export registry + pivot endpoint ─────────────────────────
interface DsColumn { key: string; label: string; type: string }
interface DsFilter { key: string; label: string; kind: 'text' | 'select'; options?: string[] }
interface Dataset {
  key: string; label: string; module: string; description: string
  columns: DsColumn[]; filters?: DsFilter[]; date_label?: string; date_required?: boolean
}
interface PivotDim { key: string; label: string; role: 'row' | 'col'; type: string }
interface PivotMeasure { key: string; label: string; agg: string; type: string }
interface PivotResult {
  dimensions: PivotDim[]; measures: PivotMeasure[]
  rows: Record<string, any>[]; truncated: boolean; group_cap: number
}
interface ValueField { key: string; agg: string }
interface SavedReport {
  id: number; name: string; description: string; dataset: string; config: any
  is_public: boolean; is_mine?: boolean; created_by_name?: string
  active_schedules?: number; updated_at?: string
}
interface Schedule {
  id: number; report_id: number; report_name: string; dataset: string
  frequency: string; hour: number; day_of_week: number; day_of_month: number
  recipients: any; format: string; is_active: boolean
  last_run_at?: string; next_run_at?: string; last_status?: string; created_by_name?: string
}
type ChartKind = 'bar' | 'stacked' | 'line' | 'area' | 'pie'

const NUMERIC = new Set(['int', 'kobo', 'money', 'pct'])
const AGGS_NUM = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct']
const AGGS_TXT = ['count', 'count_distinct', 'min', 'max']

// A column filter chosen on the Filters shelf: any column + an operator + value(s).
interface ColFilter { column: string; op: string; value: string; value2?: string }

// Operators offered per column type. Text gets contains/list; numbers get comparisons +
// between; dates get on/after-style comparisons. blank/present need no value.
function opsForType(type: string): { op: string; label: string }[] {
  if (NUMERIC.has(type)) return [
    { op: 'eq', label: '=' }, { op: 'ne', label: '≠' }, { op: 'gt', label: '>' }, { op: 'gte', label: '≥' },
    { op: 'lt', label: '<' }, { op: 'lte', label: '≤' }, { op: 'between', label: 'between' },
    { op: 'blank', label: 'is blank' }, { op: 'present', label: 'is present' },
  ]
  if (type === 'date') return [
    { op: 'gte', label: 'on / after' }, { op: 'lte', label: 'on / before' }, { op: 'between', label: 'between' },
    { op: 'eq', label: 'on' }, { op: 'gt', label: 'after' }, { op: 'lt', label: 'before' },
    { op: 'blank', label: 'is blank' }, { op: 'present', label: 'is present' },
  ]
  return [
    { op: 'contains', label: 'contains' }, { op: 'eq', label: '=' }, { op: 'ne', label: '≠' },
    { op: 'starts', label: 'starts with' }, { op: 'in', label: 'in list' },
    { op: 'blank', label: 'is blank' }, { op: 'present', label: 'is present' },
  ]
}
const defaultOp = (type: string) => NUMERIC.has(type) ? 'gte' : type === 'date' ? 'gte' : 'contains'
const opNeedsValue = (op: string) => op !== 'blank' && op !== 'present'

// Friendly aggregation names — "Unique" reads better than "count distinct".
const AGG_LABEL: Record<string, string> = {
  sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count', count_distinct: 'Unique',
}
// Temporal columns can be grouped by date, time or full timestamp.
const isTemporal = (type?: string) => type === 'date' || type === 'datetime'
const grainDefault = (type?: string) => type === 'datetime' ? 'datetime' : 'date'
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const WINDOWS = [
  { k: 'last_30_days', label: 'Last 30 days' },
  { k: 'last_7_days', label: 'Last 7 days' },
  { k: 'today', label: 'Today' },
  { k: 'last_90_days', label: 'Last 90 days' },
  { k: 'this_month', label: 'This month' },
  { k: 'last_month', label: 'Last month' },
  { k: 'this_quarter', label: 'This quarter' },
  { k: 'this_year', label: 'This year' },
  { k: 'custom', label: 'Custom range…' },
]

const unwrap = (r: any) => (r && typeof r === 'object' && 'data' in r ? r.data : r)
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// resolveWindow — kept in lockstep with resolveReportWindow() in the backend so a
// preview matches what a scheduled send will produce.
function resolveWindow(w: string, custom: { from: string; to: string }): { from: string; to: string } {
  if (w === 'custom') return custom
  const now = new Date()
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const minus = (n: number) => isoDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - n))
  switch (w) {
    case 'today': return { from: isoDay(t), to: isoDay(t) }
    case 'last_7_days': return { from: minus(6), to: isoDay(t) }
    case 'last_30_days': return { from: minus(29), to: isoDay(t) }
    case 'last_90_days': return { from: minus(89), to: isoDay(t) }
    case 'this_month': return { from: isoDay(new Date(t.getFullYear(), t.getMonth(), 1)), to: isoDay(t) }
    case 'last_month': {
      const first = new Date(t.getFullYear(), t.getMonth(), 1)
      const end = new Date(first.getTime() - 86400000)
      return { from: isoDay(new Date(end.getFullYear(), end.getMonth(), 1)), to: isoDay(end) }
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3)
      return { from: isoDay(new Date(t.getFullYear(), q * 3, 1)), to: isoDay(t) }
    }
    case 'this_year': return { from: isoDay(new Date(t.getFullYear(), 0, 1)), to: isoDay(t) }
  }
  return custom
}

// ── Value formatting by column type ───────────────────────────────────────────
function fmtVal(v: any, type: string): string {
  if (v == null || v === '') return '—'
  if (NUMERIC.has(type)) {
    let n = Number(v)
    if (Number.isNaN(n)) return String(v)
    if (type === 'kobo') n = n / 100
    if (type === 'pct') return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    const dp = type === 'kobo' || type === 'money' ? 2 : 0
    return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
  }
  return String(v)
}

// ── Draggable + clickable field pill ──────────────────────────────────────────
function FieldPill({ col, onAdd }: { col: DsColumn; onAdd: (zone: 'rows' | 'cols' | 'values') => void }) {
  const numeric = NUMERIC.has(col.type)
  const mini = (label: string, zone: 'rows' | 'cols' | 'values', color: string, title: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); onAdd(zone) }}
      title={title}
      style={{ border: `1px solid ${color}55`, background: `${color}12`, color, borderRadius: RADIUS.sm, fontSize: 10, fontWeight: FW.bold, width: 18, height: 18, cursor: 'pointer', lineHeight: 1, padding: 0, flexShrink: 0 }}
    >{label}</button>
  )
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', col.key)}
      onClick={() => onAdd(numeric ? 'values' : 'rows')}
      title={`${col.label} · ${col.type} — drag to a zone, or click to add`}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', marginBottom: 5,
        background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
        fontSize: TEXT.sm, color: 'var(--txt)', cursor: 'grab', userSelect: 'none',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 2, background: numeric ? GREEN : BLUE, flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.label}</span>
      <span style={{ display: 'flex', gap: 3 }}>
        {mini('R', 'rows', NAVY, 'Add to Rows')}
        {mini('C', 'cols', PURPLE, 'Add to Columns')}
        {mini('Σ', 'values', GREEN, 'Add to Values')}
      </span>
    </div>
  )
}

// ── A drop zone (Rows / Columns / Values) ─────────────────────────────────────
function DropZone({ title, hint, accent, children, onDrop }: {
  title: string; hint: string; accent: string; children: React.ReactNode; onDrop: (key: string) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const k = e.dataTransfer.getData('text/plain'); if (k) onDrop(k) }}
      style={{
        border: `1.5px dashed ${over ? accent : 'var(--bdr)'}`, borderRadius: RADIUS.lg,
        background: over ? `${accent}0c` : 'var(--th-bg)', padding: '10px 12px', minHeight: 76,
        transition: 'background 120ms, border-color 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.04em', color: accent }}>{title}</span>
        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{hint}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{children}</div>
    </div>
  )
}

function Chip({ label, color, onRemove, children }: {
  label: string; color: string; onRemove: () => void; children?: React.ReactNode
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 9px', background: `${color}14`, border: `1px solid ${color}55`, borderRadius: RADIUS.md, fontSize: TEXT.sm, color: 'var(--txt)' }}>
      <span style={{ fontWeight: FW.semibold }}>{label}</span>
      {children}
      <button onClick={onRemove} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', fontSize: 15, lineHeight: 1, padding: '0 2px' }}>×</button>
    </span>
  )
}

// ── Recipients chip input ─────────────────────────────────────────────────────
function Recipients({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
  const commit = () => {
    const parts = text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
    const next = [...value]
    for (const p of parts) if (p.includes('@') && !next.includes(p)) next.push(p)
    onChange(next); setText('')
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '6px 8px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, background: 'var(--input-bg)', minHeight: 40 }}>
      {value.map(e => (
        <Chip key={e} label={e} color={BLUE} onRemove={() => onChange(value.filter(x => x !== e))} />
      ))}
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() } }}
        onBlur={commit}
        placeholder={value.length ? '' : 'name@o3capital.com, …'}
        style={{ flex: 1, minWidth: 160, border: 'none', outline: 'none', background: 'transparent', color: 'var(--txt)', fontSize: TEXT.sm, fontFamily: 'inherit' }}
      />
    </div>
  )
}

// ── Chart view ────────────────────────────────────────────────────────────────
function ChartView({ matrix, kind }: { matrix: Matrix; kind: ChartKind }) {
  const measIdx = useMemo(() => matrix.header.map((_, i) => i).filter(i => i >= matrix.rowDimCount), [matrix])
  const cats = useMemo(() => matrix.rawBody.map(l => l.slice(0, matrix.rowDimCount).map(String).join(' / ') || '—'), [matrix])
  const numFmt = (v: number) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })

  if (!measIdx.length) return <Note>Add a value to chart this report.</Note>

  if (kind === 'pie') {
    const ci = measIdx[0]
    const data = matrix.rawBody
      .map((l, i) => ({ name: cats[i], value: Number(l[ci]) || 0 }))
      .filter(d => d.value !== 0)
      .slice(0, 40)
    if (!data.length) return <Note>No non-zero values to plot.</Note>
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
        <EDonut data={data} valueKey="value" nameKey="name" size={340} inner={92} outer={150}
          colorFn={(_r, i) => CHART_SERIES[i % CHART_SERIES.length]} legend valueFmt={numFmt} />
      </div>
    )
  }

  const data = matrix.rawBody.map((l, i) => {
    const o: any = { __x: cats[i] }
    measIdx.forEach((ci, si) => { o['s' + si] = Number(l[ci]) || 0 })
    return o
  })
  const series = measIdx.map((ci, si) => ({ key: 's' + si, name: matrix.header[ci], color: CHART_SERIES[si % CHART_SERIES.length] }))
  const common = { data, xKey: '__x' as const, series, height: 380, valueFmt: numFmt }

  if (kind === 'line') return <ELine {...common} />
  if (kind === 'area') return <EArea {...common} stack={false} />
  return <EBar {...common} stack={kind === 'stacked'} />
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ textAlign: 'center', padding: '46px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>{children}</div>
}

interface Matrix { header: string[]; body: string[][]; rawBody: any[][]; rowDimCount: number }

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ReportBuilder() {
  const [params] = useSearchParams()
  const initialTab = (() => { const t = params.get('tab'); return t === 'saved' || t === 'schedules' ? t : 'build' })()
  const [tab, setTab] = useState(initialTab)
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [dsKey, setDsKey] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<string[]>([])
  const [cols, setCols] = useState<string[]>([])
  const [values, setValues] = useState<ValueField[]>([])
  const [filterVals, setFilterVals] = useState<Record<string, string>>({})
  const [colFilters, setColFilters] = useState<ColFilter[]>([])
  const [grains, setGrains] = useState<Record<string, string>>({}) // date/datetime col key → date|time|datetime
  const [win, setWin] = useState('last_30_days')
  const [from, setFrom] = useState(resolveWindow('last_30_days', { from: '', to: '' }).from)
  const [to, setTo] = useState(today())
  const [result, setResult] = useState<PivotResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dsError, setDsError] = useState<string | null>(null)
  const [view, setView] = useState<'table' | 'chart'>('table')
  const [chartKind, setChartKind] = useState<ChartKind>('bar')
  const debRef = useRef<any>(null)

  // Loaded saved report (for Save = update, and Schedule which needs an id).
  const [loadedId, setLoadedId] = useState<number | null>(null)
  const [reportName, setReportName] = useState('')
  const [reportDesc, setReportDesc] = useState('')
  const [isPublic, setIsPublic] = useState(false)

  const [saved, setSaved] = useState<SavedReport[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])

  // Modals
  const [saveOpen, setSaveOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [schedOpen, setSchedOpen] = useState(false)
  const [confirmDel, setConfirmDel] = useState<{ kind: 'report' | 'schedule'; id: number; name: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const ds = useMemo(() => datasets.find(d => d.key === dsKey) || null, [datasets, dsKey])
  const colByKey = useMemo(() => {
    const m = new Map<string, DsColumn>()
    ds?.columns.forEach(c => m.set(c.key, c))
    return m
  }, [ds])
  const dated = !!ds?.date_label
  const range = useMemo(() => resolveWindow(win, { from, to }), [win, from, to])

  useEffect(() => {
    apiFetch<any>('/api/reports/datasets')
      .then(r => setDatasets((Array.isArray(r) ? r : (r?.data ?? [])) as Dataset[]))
      .catch(e => setDsError(e.message))
    refreshSaved(); refreshSchedules()
  }, [])

  const refreshSaved = () => apiFetch<any>('/api/reports/saved').then(r => setSaved(unwrap(r) ?? [])).catch(() => {})
  const refreshSchedules = () => apiFetch<any>('/api/reports/schedules').then(r => setSchedules(unwrap(r) ?? [])).catch(() => {})

  // A fresh dataset choice starts a new report.
  const pickDataset = (key: string) => {
    setDsKey(key); setRows([]); setCols([]); setValues([]); setFilterVals({}); setColFilters([]); setGrains({})
    setResult(null); setError(null); setLoadedId(null); setReportName(''); setReportDesc(''); setIsPublic(false)
  }

  const addTo = (zone: 'rows' | 'cols' | 'values') => (key: string) => {
    if (!colByKey.has(key)) return
    if (zone === 'rows') setRows(p => p.includes(key) ? p : [...p, key])
    if (zone === 'cols') setCols(p => p.includes(key) ? p : [...p, key])
    if (zone === 'values') setValues(p => p.some(v => v.key === key) ? p : [...p, { key, agg: NUMERIC.has(colByKey.get(key)!.type) ? 'sum' : 'count' }])
  }

  // Drop a field into Filters — add a filter row with a type-appropriate default operator.
  // Multiple filters on the same column are allowed (e.g. amount ≥ X AND amount ≤ Y).
  const addFilter = (key: string) => {
    const c = colByKey.get(key)
    if (!c) return
    setColFilters(p => [...p, { column: key, op: defaultOp(c.type), value: '', value2: '' }])
  }
  const updateFilter = (i: number, patch: Partial<ColFilter>) =>
    setColFilters(p => p.map((x, xi) => xi === i ? { ...x, ...patch } : x))

  // For a date/timestamp dimension, choose how to group it: whole date, time-of-day, or
  // the full (normalised) timestamp.
  const grainSelect = (k: string, type: string) => (
    <select value={grains[k] ?? grainDefault(type)} onClick={e => e.stopPropagation()} title="Group this date by…"
      onChange={e => setGrains(p => ({ ...p, [k]: e.target.value }))}
      style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.sm, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT['2xs'], padding: '1px 3px', fontFamily: 'inherit' }}>
      <option value="date">Date</option>
      <option value="time">Time</option>
      <option value="datetime">Timestamp</option>
    </select>
  )

  const canRun = dsKey && (rows.length || cols.length || values.length)

  const run = useCallback(async () => {
    if (!dsKey) return
    if (!rows.length && !cols.length && !values.length) { setResult(null); return }
    setLoading(true); setError(null)
    try {
      const body = {
        rows, cols, values: values.map(v => ({ column: v.key, agg: v.agg })),
        filters: filterVals,
        col_filters: colFilters.filter(cf => !opNeedsValue(cf.op) || cf.value !== '' || (cf.value2 ?? '') !== ''),
        grains,
        date_from: dated ? range.from : '',
        date_to: dated ? range.to : '',
      }
      const r = await apiPost<any>(`/api/reports/datasets/${dsKey}/pivot`, body)
      setResult(unwrap(r) as PivotResult)
    } catch (e: any) { setError(e.message); setResult(null) }
    finally { setLoading(false) }
  }, [dsKey, rows, cols, values, filterVals, colFilters, grains, range.from, range.to, dated])

  // Live preview — debounced so each drop doesn't fire instantly.
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current)
    debRef.current = setTimeout(() => { run() }, 350)
    return () => clearTimeout(debRef.current)
  }, [run])

  // ── Pivot the long-format result into a display matrix ──────────────────────
  const matrix: Matrix | null = useMemo(() => {
    if (!result) return null
    // Defensive: an empty result may arrive with null rows/dimensions/measures — treat
    // each as an empty array so the builder shows "no rows" instead of crashing.
    const rowDims = (result.dimensions ?? []).filter(d => d.role === 'row')
    const colDims = (result.dimensions ?? []).filter(d => d.role === 'col')
    const meas = result.measures ?? []
    const keyOf = (r: Record<string, any>, dims: PivotDim[]) => dims.map(d => String(r[d.key] ?? '—')).join(' ∕ ')

    const rowTuples: string[] = []; const rowSeen = new Set<string>()
    const colTuples: string[] = []; const colSeen = new Set<string>()
    const cell = new Map<string, Record<string, any>>()
    for (const r of (result.rows ?? [])) {
      const rk = keyOf(r, rowDims); const ck = keyOf(r, colDims)
      if (!rowSeen.has(rk)) { rowSeen.add(rk); rowTuples.push(rk) }
      if (colDims.length && !colSeen.has(ck)) { colSeen.add(ck); colTuples.push(ck) }
      cell.set(rk + '||' + ck, r)
    }
    const header: string[] = [...rowDims.map(d => d.label)]
    const colGroups = colDims.length ? colTuples : ['']
    for (const cg of colGroups) for (const m of meas) header.push(colDims.length ? `${cg} · ${m.label}` : m.label)
    const body: string[][] = []; const rawBody: any[][] = []
    for (const rk of rowTuples) {
      const line: string[] = rk.split(' ∕ ')
      const rawLine: any[] = [...line]
      for (const cg of colGroups) {
        const r = cell.get(rk + '||' + cg)
        for (const m of meas) {
          const v = r ? r[m.key] : null
          line.push(fmtVal(v, m.type))
          rawLine.push(v == null ? '' : (NUMERIC.has(m.type) ? (m.type === 'kobo' ? Number(v) / 100 : Number(v)) : v))
        }
      }
      body.push(line); rawBody.push(rawLine)
    }
    return { header, body, rawBody, rowDimCount: rowDims.length }
  }, [result])

  const title = reportName || (ds ? `${ds.label} report` : 'report')

  // ── Client-side export of the current preview ───────────────────────────────
  const exportExcel = () => {
    if (!matrix) return
    const ws = XLSX.utils.aoa_to_sheet([matrix.header, ...matrix.rawBody])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Report')
    XLSX.writeFile(wb, `${title.replace(/\s+/g, '_')}.xlsx`)
  }
  const exportPDF = () => {
    if (!matrix) return
    const doc = new jsPDF({ orientation: matrix.header.length > 6 ? 'landscape' : 'portrait' })
    doc.setFontSize(14); doc.text(title, 14, 16)
    doc.setFontSize(9); doc.setTextColor(120)
    doc.text(`${dated ? `${range.from} → ${range.to}  ·  ` : ''}${matrix.body.length} rows${result?.truncated ? ' (capped)' : ''}`, 14, 22)
    autoTable(doc, {
      head: [matrix.header], body: matrix.body, startY: 26,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [14, 40, 65], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 247, 250] },
      columnStyles: Object.fromEntries(Array.from({ length: matrix.header.length }, (_, i) => [i, { halign: i < matrix.rowDimCount ? 'left' : 'right' }])),
    })
    doc.save(`${title.replace(/\s+/g, '_')}.pdf`)
  }

  // ── Config assembly + persistence ───────────────────────────────────────────
  const currentConfig = () => ({
    rows, cols, values: values.map(v => ({ column: v.key, agg: v.agg })),
    filters: filterVals, col_filters: colFilters, grains, date_window: win, date_from: from, date_to: to,
    chart: { view, kind: chartKind },
  })

  const doSave = async () => {
    if (!reportName.trim()) { toast.error('Give the report a name'); return }
    if (!dsKey) { toast.error('Pick a data source first'); return }
    setBusy(true)
    try {
      const payload = { name: reportName.trim(), description: reportDesc, dataset: dsKey, is_public: isPublic, config: currentConfig() }
      if (loadedId) {
        await apiPut(`/api/reports/saved/${loadedId}`, payload)
        toast.success('Report updated')
      } else {
        const created = unwrap(await apiPost('/api/reports/saved', payload))
        setLoadedId(created?.id ?? null)
        toast.success('Report saved')
      }
      setSaveOpen(false); refreshSaved()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }

  const loadSaved = (rep: SavedReport) => {
    const c = rep.config || {}
    setDsKey(rep.dataset)
    setRows(c.rows ?? []); setCols(c.cols ?? [])
    setValues((c.values ?? []).map((v: any) => ({ key: v.column, agg: v.agg })))
    setFilterVals(c.filters ?? {})
    setColFilters(c.col_filters ?? [])
    setGrains(c.grains ?? {})
    setWin(c.date_window || 'last_30_days')
    if (c.date_from) setFrom(c.date_from)
    if (c.date_to) setTo(c.date_to)
    if (c.chart?.view) setView(c.chart.view)
    if (c.chart?.kind) setChartKind(c.chart.kind)
    setLoadedId(rep.id); setReportName(rep.name); setReportDesc(rep.description || ''); setIsPublic(rep.is_public)
    setTab('build')
    toast.success(`Loaded "${rep.name}"`)
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
    } catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }

  const grouped = useMemo(() => {
    const g: Record<string, Dataset[]> = {}
    for (const d of datasets) (g[d.module] ??= []).push(d)
    return g
  }, [datasets])

  const visibleCols = useMemo(() => {
    if (!ds) return []
    const q = search.trim().toLowerCase()
    return q ? ds.columns.filter(c => c.label.toLowerCase().includes(q)) : ds.columns
  }, [ds, search])

  const tabs = [
    { key: 'build', label: 'Builder' },
    { key: 'saved', label: 'Saved Reports', badge: saved.length || undefined },
    { key: 'schedules', label: 'Schedules', badge: schedules.filter(s => s.is_active).length || undefined },
  ]

  return (
    <Page title="Report Builder" subtitle="Build a report by dragging or clicking fields, visualise it, then save, email or schedule it">
      <ErrBanner error={dsError} onRetry={() => location.reload()} />
      <div style={{ marginBottom: SP[4] }}><Tabs tabs={tabs} active={tab} onChange={setTab} /></div>

      {tab === 'build' && (
        <>
          {/* Toolbar */}
          <div style={{ display: 'flex', gap: SP[3], alignItems: 'center', flexWrap: 'wrap', marginBottom: SP[4] }}>
            <select value={dsKey} onChange={e => pickDataset(e.target.value)} style={{ ...sel, minWidth: 260 }}>
              <option value="">Choose a data source…</option>
              {Object.entries(grouped).map(([mod, list]) => (
                <optgroup key={mod} label={mod}>
                  {list.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                </optgroup>
              ))}
            </select>
            {dated && (
              <>
                <select value={win} onChange={e => setWin(e.target.value)} style={sel}>
                  {WINDOWS.map(w => <option key={w.k} value={w.k}>{w.label}</option>)}
                </select>
                {win === 'custom' && <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="left" />}
              </>
            )}
            {loadedId && <Badge variant="info">Editing: {reportName}</Badge>}
            <div style={{ flex: 1 }} />
            <Button variant="secondary" size="sm" icon="save" disabled={!canRun} onClick={() => setSaveOpen(true)}>{loadedId ? 'Update' : 'Save'}</Button>
            <Button variant="secondary" size="sm" icon="mail" disabled={!canRun} onClick={() => setEmailOpen(true)}>Email</Button>
            <Button variant="secondary" size="sm" icon="schedule" disabled={!canRun} onClick={() => setSchedOpen(true)}>Schedule</Button>
            <Button variant="secondary" size="sm" icon="grid_on" disabled={!matrix} onClick={exportExcel}>Excel</Button>
            <Button variant="secondary" size="sm" icon="picture_as_pdf" disabled={!matrix} onClick={exportPDF}>PDF</Button>
          </div>

          {!ds ? (
            <SectionCard title="">
              <EmptyState icon="table_chart" title="Pick a data source to start"
                description="Choose a data source above, then drag fields into Rows, Columns and Values — or click a field to add it. Build once, then save, email or schedule it." />
            </SectionCard>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: SP[4], alignItems: 'start' }}>
              {/* Field palette */}
              <SectionCard title="Fields" subtitle={ds.label}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search fields…"
                  style={{ ...inp, width: '100%', boxSizing: 'border-box', marginBottom: SP[2] }} />
                <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 2 }}>
                  {visibleCols.map(c => <FieldPill key={c.key} col={c} onAdd={(z) => addTo(z)(c.key)} />)}
                  {!visibleCols.length && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', padding: '8px 0' }}>No matching fields.</div>}
                </div>
                <div style={{ marginTop: SP[2], fontSize: TEXT['2xs'], color: 'var(--txt3)', display: 'flex', gap: SP[3] }}>
                  <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: GREEN, marginRight: 4 }} />numeric</span>
                  <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: BLUE, marginRight: 4 }} />text/date</span>
                </div>
              </SectionCard>

              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
                  <DropZone title="Rows" hint="group down" accent={NAVY} onDrop={addTo('rows')}>
                    {rows.map(k => { const c = colByKey.get(k); return (
                      <Chip key={k} label={c?.label ?? k} color={NAVY} onRemove={() => setRows(p => p.filter(x => x !== k))}>
                        {isTemporal(c?.type) && grainSelect(k, c!.type)}
                      </Chip>
                    )})}
                    {!rows.length && <span style={zoneEmpty}>drag or click fields here</span>}
                  </DropZone>
                  <DropZone title="Columns" hint="spread across" accent={PURPLE} onDrop={addTo('cols')}>
                    {cols.map(k => { const c = colByKey.get(k); return (
                      <Chip key={k} label={c?.label ?? k} color={PURPLE} onRemove={() => setCols(p => p.filter(x => x !== k))}>
                        {isTemporal(c?.type) && grainSelect(k, c!.type)}
                      </Chip>
                    )})}
                    {!cols.length && <span style={zoneEmpty}>optional</span>}
                  </DropZone>
                </div>
                <DropZone title="Values" hint="what to measure" accent={GREEN} onDrop={addTo('values')}>
                  {values.map(v => {
                    const c = colByKey.get(v.key)
                    const opts = c && NUMERIC.has(c.type) ? AGGS_NUM : AGGS_TXT
                    return (
                      <Chip key={v.key} label={c?.label ?? v.key} color={GREEN} onRemove={() => setValues(p => p.filter(x => x.key !== v.key))}>
                        <select value={v.agg} onChange={e => setValues(p => p.map(x => x.key === v.key ? { ...x, agg: e.target.value } : x))}
                          style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.sm, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT['2xs'], padding: '1px 3px', fontFamily: 'inherit' }}>
                          {opts.map(a => <option key={a} value={a}>{AGG_LABEL[a] ?? a}</option>)}
                        </select>
                      </Chip>
                    )
                  })}
                  {!values.length && <span style={zoneEmpty}>drag or click fields here — e.g. Count of ID, Sum of Amount</span>}
                </DropZone>

                <SectionCard title="Filters" subtitle="drag any field here to filter — or use the built-in ones">
                  <DropZone title="Filter by field" hint="drag a field here" accent={AMBER} onDrop={addFilter}>
                    {colFilters.length === 0 && <span style={zoneEmpty}>drag a field here to filter — e.g. Amount ≥ 100000, Status = Active, Date between …</span>}
                    {colFilters.map((cf, i) => {
                      const c = colByKey.get(cf.column)
                      const ops = c ? opsForType(c.type) : []
                      const isDate = c?.type === 'date'
                      const fSel = { border: '1px solid var(--bdr)', borderRadius: RADIUS.sm, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT['2xs'], padding: '2px 3px', fontFamily: 'inherit' as const }
                      const fInp = { border: '1px solid var(--bdr)', borderRadius: RADIUS.sm, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT['2xs'], padding: '2px 5px', width: isDate ? 122 : 92, fontFamily: 'inherit' as const }
                      return (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 5px 3px 9px', background: `${AMBER}14`, border: `1px solid ${AMBER}55`, borderRadius: RADIUS.md, fontSize: TEXT.sm }}>
                          <span style={{ fontWeight: FW.semibold }}>{c?.label ?? cf.column}</span>
                          <select value={cf.op} onChange={e => updateFilter(i, { op: e.target.value })} style={fSel}>
                            {ops.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
                          </select>
                          {opNeedsValue(cf.op) && (
                            <input value={cf.value} onChange={e => updateFilter(i, { value: e.target.value })} type={isDate ? 'date' : 'text'}
                              placeholder={cf.op === 'in' ? 'a, b, c' : c?.type === 'kobo' ? 'kobo' : 'value'} style={fInp} />
                          )}
                          {cf.op === 'between' && (
                            <>
                              <span style={{ color: 'var(--txt3)' }}>–</span>
                              <input value={cf.value2 ?? ''} onChange={e => updateFilter(i, { value2: e.target.value })} type={isDate ? 'date' : 'text'} placeholder="to" style={fInp} />
                            </>
                          )}
                          <button onClick={() => setColFilters(p => p.filter((_, x) => x !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', fontSize: 15, lineHeight: 1, padding: '0 2px' }}>×</button>
                        </span>
                      )
                    })}
                  </DropZone>
                  {(ds.filters?.length ?? 0) > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[3], alignItems: 'flex-end', marginTop: SP[3] }}>
                      {ds.filters!.map(f => (
                        <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                          {f.label}
                          {f.kind === 'select' ? (
                            <select value={filterVals[f.key] ?? ''} onChange={e => setFilterVals(p => ({ ...p, [f.key]: e.target.value }))} style={inp}>
                              <option value="">Any</option>
                              {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input value={filterVals[f.key] ?? ''} onChange={e => setFilterVals(p => ({ ...p, [f.key]: e.target.value }))} placeholder="filter…" style={inp} />
                          )}
                        </label>
                      ))}
                      {Object.values(filterVals).some(Boolean) && (
                        <button onClick={() => setFilterVals({})} style={{ ...inp, cursor: 'pointer', color: RED, border: 'none', background: 'none' }}>Clear filters</button>
                      )}
                    </div>
                  )}
                </SectionCard>

                {/* Preview / chart */}
                <SectionCard
                  title={view === 'table' ? 'Preview' : 'Chart'}
                  subtitle={result ? `${matrix?.body.length ?? 0} row${(matrix?.body.length ?? 0) === 1 ? '' : 's'}${result.truncated ? ` · capped at ${result.group_cap}` : ''}` : 'live'}
                  actions={
                    <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }}>
                      <Segmented value={view} onChange={(v) => setView(v as any)} options={[{ k: 'table', label: 'Table', icon: 'table_rows' }, { k: 'chart', label: 'Chart', icon: 'bar_chart' }]} />
                      {view === 'chart' && (
                        <select value={chartKind} onChange={e => setChartKind(e.target.value as ChartKind)} style={{ ...sel, padding: '5px 8px', fontSize: TEXT.sm }}>
                          <option value="bar">Bar</option>
                          <option value="stacked">Stacked bar</option>
                          <option value="line">Line</option>
                          <option value="area">Area</option>
                          <option value="pie">Donut</option>
                        </select>
                      )}
                    </div>
                  }
                >
                  <ErrBanner error={error} onRetry={run} />
                  {loading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size={26} /></div>
                  ) : !canRun ? (
                    <Note>Drop or click a field into Rows or Values to see the report.</Note>
                  ) : !matrix || matrix.body.length === 0 ? (
                    <Note>No rows for this selection.</Note>
                  ) : view === 'chart' ? (
                    <ChartView matrix={matrix} kind={chartKind} />
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: TEXT.sm }}>
                        <thead>
                          <tr>
                            {matrix.header.map((h, i) => (
                              <th key={i} style={{ textAlign: i < matrix.rowDimCount ? 'left' : 'right', padding: '7px 10px', borderBottom: '2px solid var(--bdr)', background: 'var(--th-bg)', position: 'sticky', top: 0, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {matrix.body.slice(0, 200).map((line, ri) => (
                            <tr key={ri}>
                              {line.map((v, ci) => (
                                <td key={ci} style={{ textAlign: ci < matrix.rowDimCount ? 'left' : 'right', padding: '6px 10px', borderBottom: '1px solid var(--bdr)', color: ci < matrix.rowDimCount ? 'var(--txt)' : 'var(--txt2)', fontWeight: ci < matrix.rowDimCount ? FW.semibold : FW.normal, whiteSpace: 'nowrap', ...(ci >= matrix.rowDimCount ? NUM : {}) }}>{v}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {matrix.body.length > 200 && (
                        <div style={{ padding: '8px 0 0', fontSize: TEXT.xs, color: 'var(--txt3)', textAlign: 'center' }}>Showing first 200 of {matrix.body.length} rows — export for the full report.</div>
                      )}
                    </div>
                  )}
                </SectionCard>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'saved' && (
        <SavedTab saved={saved} onOpen={loadSaved}
          onEmail={(rep) => { loadSaved(rep); setEmailOpen(true) }}
          onSchedule={(rep) => { loadSaved(rep); setSchedOpen(true) }}
          onDelete={(rep) => setConfirmDel({ kind: 'report', id: rep.id, name: rep.name })} />
      )}

      {tab === 'schedules' && (
        <SchedulesTab schedules={schedules}
          onToggle={async (s) => { await apiPut(`/api/reports/schedules/${s.id}`, { is_active: !s.is_active }); refreshSchedules() }}
          onDelete={(s) => setConfirmDel({ kind: 'schedule', id: s.id, name: s.report_name })} />
      )}

      {/* Save modal */}
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title={loadedId ? 'Update report' : 'Save report'}
        footer={<><Button variant="ghost" onClick={() => setSaveOpen(false)}>Cancel</Button><Button loading={busy} onClick={doSave}>{loadedId ? 'Update' : 'Save'}</Button></>}>
        <Labeled label="Report name">
          <input value={reportName} onChange={e => setReportName(e.target.value)} placeholder="e.g. Monthly loan book by product" style={{ ...inp, width: '100%', boxSizing: 'border-box' }} autoFocus />
        </Labeled>
        <Labeled label="Description (optional)">
          <textarea value={reportDesc} onChange={e => setReportDesc(e.target.value)} rows={2} spellCheck={false} style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
        </Labeled>
        <label style={{ display: 'flex', alignItems: 'center', gap: SP[2], cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt)' }}>
          <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} style={{ width: 16, height: 16, accentColor: NAVY }} />
          Share with everyone who can view reports (they can run it, not edit it)
        </label>
      </Modal>

      {/* Email modal */}
      <EmailModal open={emailOpen} onClose={() => setEmailOpen(false)} name={title}
        onSend={async (recipients, format, message) => {
          setBusy(true)
          try {
            if (loadedId) {
              await apiPost(`/api/reports/saved/${loadedId}/email`, { recipients, format, message })
            } else {
              await apiPost('/api/reports/pivot-email', {
                name: reportName || title, dataset: dsKey,
                rows, cols, values: values.map(v => ({ column: v.key, agg: v.agg })),
                filters: filterVals, date_window: win, date_from: range.from, date_to: range.to,
                recipients, format, message,
              })
            }
            toast.success(`Report emailed to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`)
            setEmailOpen(false)
          } catch (e: any) { toast.error(e.message) }
          finally { setBusy(false) }
        }} busy={busy} />

      {/* Schedule modal */}
      <ScheduleModal open={schedOpen} onClose={() => setSchedOpen(false)} needsSave={!loadedId}
        onSaveFirst={() => { setSchedOpen(false); setSaveOpen(true) }}
        onCreate={async (payload) => {
          if (!loadedId) return
          setBusy(true)
          try {
            await apiPost(`/api/reports/saved/${loadedId}/schedule`, payload)
            toast.success('Schedule created')
            setSchedOpen(false); setTab('schedules'); refreshSchedules()
          } catch (e: any) { toast.error(e.message) }
          finally { setBusy(false) }
        }} busy={busy} />

      <ConfirmModal open={!!confirmDel} title={`Delete ${confirmDel?.kind === 'report' ? 'report' : 'schedule'}?`}
        body={confirmDel ? `"${confirmDel.name}" will be permanently removed.` : ''}
        danger loading={busy} confirmLabel="Delete" onConfirm={deleteConfirmed} onClose={() => setConfirmDel(null)} />
    </Page>
  )
}

// ── Saved reports tab ──────────────────────────────────────────────────────────
function SavedTab({ saved, onOpen, onEmail, onSchedule, onDelete }: {
  saved: SavedReport[]
  onOpen: (r: SavedReport) => void; onEmail: (r: SavedReport) => void
  onSchedule: (r: SavedReport) => void; onDelete: (r: SavedReport) => void
}) {
  if (!saved.length) return (
    <SectionCard title=""><EmptyState icon="bookmark" title="No saved reports yet"
      description="Build a report on the Builder tab and hit Save — it will show up here for you (and, if shared, your team) to run, email or schedule." /></SectionCard>
  )
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: SP[3] }}>
      {saved.map(r => (
        <SectionCard key={r.id} title={r.name} subtitle={r.description || undefined}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: SP[3] }}>
            <Badge variant="neutral">{r.dataset}</Badge>
            {r.is_public && <Badge variant="info">Shared</Badge>}
            {!r.is_mine && r.created_by_name && <Badge variant="neutral">by {r.created_by_name}</Badge>}
            {!!r.active_schedules && <Badge variant="success">{r.active_schedules} schedule{r.active_schedules === 1 ? '' : 's'}</Badge>}
          </div>
          <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
            <Button size="xs" icon="open_in_new" onClick={() => onOpen(r)}>Open</Button>
            <Button size="xs" variant="secondary" icon="mail" onClick={() => onEmail(r)}>Email</Button>
            <Button size="xs" variant="secondary" icon="schedule" onClick={() => onSchedule(r)}>Schedule</Button>
            {r.is_mine !== false && <Button size="xs" variant="ghost" icon="delete" onClick={() => onDelete(r)} />}
          </div>
        </SectionCard>
      ))}
    </div>
  )
}

// ── Schedules tab ───────────────────────────────────────────────────────────────
function describeSchedule(s: Schedule): string {
  const hh = `${String(s.hour).padStart(2, '0')}:00`
  if (s.frequency === 'weekly') return `Weekly · ${DOW[s.day_of_week] ?? 'Monday'} at ${hh}`
  if (s.frequency === 'monthly') return `Monthly · day ${s.day_of_month} at ${hh}`
  return `Daily at ${hh}`
}
function recipientList(v: any): string[] {
  if (Array.isArray(v)) return v
  try { return JSON.parse(v || '[]') } catch { return [] }
}
function fmtWhen(s?: string): string {
  if (!s) return '—'
  const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function SchedulesTab({ schedules, onToggle, onDelete }: {
  schedules: Schedule[]; onToggle: (s: Schedule) => void; onDelete: (s: Schedule) => void
}) {
  if (!schedules.length) return (
    <SectionCard title=""><EmptyState icon="schedule" title="No schedules yet"
      description="Open a saved report and choose Schedule to have it emailed automatically — daily, weekly or monthly." /></SectionCard>
  )
  return (
    <SectionCard title="Scheduled deliveries" subtitle="reports emailed automatically">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: TEXT.sm }}>
          <thead>
            <tr>{['Report', 'Cadence', 'Recipients', 'Format', 'Next run', 'Last run', 'Status', ''].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '7px 10px', borderBottom: '2px solid var(--bdr)', color: 'var(--txt2)', fontWeight: FW.semibold, whiteSpace: 'nowrap' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {schedules.map(s => {
              const rec = recipientList(s.recipients)
              return (
                <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.55 }}>
                  <td style={td}>{s.report_name}</td>
                  <td style={td}>{describeSchedule(s)}</td>
                  <td style={{ ...td, maxWidth: 220, whiteSpace: 'normal' }}>{rec.join(', ') || '—'}</td>
                  <td style={td}>{s.format?.toUpperCase()}</td>
                  <td style={td}>{s.is_active ? fmtWhen(s.next_run_at) : 'Paused'}</td>
                  <td style={td}>{fmtWhen(s.last_run_at)}</td>
                  <td style={{ ...td, maxWidth: 200, whiteSpace: 'normal', color: (s.last_status || '').startsWith('error') ? RED : 'var(--txt2)' }}>{s.last_status || '—'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <Button size="xs" variant="ghost" icon={s.is_active ? 'pause' : 'play_arrow'} onClick={() => onToggle(s)}>{s.is_active ? 'Pause' : 'Resume'}</Button>
                    <Button size="xs" variant="ghost" icon="delete" onClick={() => onDelete(s)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

// ── Email modal ─────────────────────────────────────────────────────────────────
function EmailModal({ open, onClose, name, onSend, busy }: {
  open: boolean; onClose: () => void; name: string
  onSend: (recipients: string[], format: string, message: string) => void; busy: boolean
}) {
  const [recipients, setRecipients] = useState<string[]>([])
  const [format, setFormat] = useState('xlsx')
  const [message, setMessage] = useState('')
  useEffect(() => { if (open) { setRecipients([]); setMessage('') } }, [open])
  return (
    <Modal open={open} onClose={onClose} title="Email this report"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!recipients.length} onClick={() => onSend(recipients, format, message)}>Send now</Button></>}>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[3] }}>Sends <b>{name}</b> with the data attached as a spreadsheet and previewed in the email body.</div>
      <Labeled label="Recipients"><Recipients value={recipients} onChange={setRecipients} /></Labeled>
      <Labeled label="Attachment format">
        <select value={format} onChange={e => setFormat(e.target.value)} style={{ ...inp, width: '100%', boxSizing: 'border-box' }}>
          <option value="xlsx">Excel (.xlsx)</option>
          <option value="csv">CSV (.csv)</option>
        </select>
      </Labeled>
      <Labeled label="Note (optional)">
        <textarea value={message} onChange={e => setMessage(e.target.value)} rows={2} placeholder="Add a short note to the email…" spellCheck={false} style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
      </Labeled>
    </Modal>
  )
}

// ── Schedule modal ──────────────────────────────────────────────────────────────
function ScheduleModal({ open, onClose, needsSave, onSaveFirst, onCreate, busy }: {
  open: boolean; onClose: () => void; needsSave: boolean; onSaveFirst: () => void
  onCreate: (payload: any) => void; busy: boolean
}) {
  const [frequency, setFrequency] = useState('daily')
  const [hour, setHour] = useState(7)
  const [dow, setDow] = useState(1)
  const [dom, setDom] = useState(1)
  const [format, setFormat] = useState('xlsx')
  const [recipients, setRecipients] = useState<string[]>([])
  useEffect(() => { if (open) { setRecipients([]) } }, [open])

  return (
    <Modal open={open} onClose={onClose} title="Schedule this report"
      footer={needsSave ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={onSaveFirst}>Save report first</Button></>
        : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!recipients.length} onClick={() => onCreate({ frequency, hour, day_of_week: dow, day_of_month: dom, recipients, format })}>Create schedule</Button></>}>
      {needsSave ? (
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Save this report first, then schedule it — a schedule points at a saved report so it can keep running on its own.</div>
      ) : (
        <>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[3] }}>The report runs on its own and is emailed to the recipients. Times are West Africa (Lagos).</div>
          <Labeled label="Frequency">
            <select value={frequency} onChange={e => setFrequency(e.target.value)} style={{ ...inp, width: '100%', boxSizing: 'border-box' }}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </Labeled>
          <div style={{ display: 'flex', gap: SP[3] }}>
            {frequency === 'weekly' && (
              <Labeled label="Day of week" style={{ flex: 1 }}>
                <select value={dow} onChange={e => setDow(Number(e.target.value))} style={{ ...inp, width: '100%', boxSizing: 'border-box' }}>
                  {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </Labeled>
            )}
            {frequency === 'monthly' && (
              <Labeled label="Day of month" style={{ flex: 1 }}>
                <select value={dom} onChange={e => setDom(Number(e.target.value))} style={{ ...inp, width: '100%', boxSizing: 'border-box' }}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </Labeled>
            )}
            <Labeled label="Time" style={{ flex: 1 }}>
              <select value={hour} onChange={e => setHour(Number(e.target.value))} style={{ ...inp, width: '100%', boxSizing: 'border-box' }}>
                {Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </Labeled>
            <Labeled label="Format" style={{ flex: 1 }}>
              <select value={format} onChange={e => setFormat(e.target.value)} style={{ ...inp, width: '100%', boxSizing: 'border-box' }}>
                <option value="xlsx">Excel</option>
                <option value="csv">CSV</option>
              </select>
            </Labeled>
          </div>
          <Labeled label="Recipients"><Recipients value={recipients} onChange={setRecipients} /></Labeled>
        </>
      )}
    </Modal>
  )
}

// ── Small shared bits ───────────────────────────────────────────────────────────
function Labeled({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ marginBottom: SP[3], ...style }}>
      <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { k: string; label: string; icon?: string }[] }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
      {options.map(o => (
        <button key={o.k} onClick={() => onChange(o.k)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', border: 'none', cursor: 'pointer', fontSize: TEXT.sm, fontFamily: 'inherit', fontWeight: FW.semibold, background: value === o.k ? NAVY : 'var(--card)', color: value === o.k ? '#fff' : 'var(--txt2)' }}>
          {o.icon && <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </div>
  )
}

const zoneEmpty: React.CSSProperties = { fontSize: TEXT.xs, color: 'var(--txt3)', fontStyle: 'italic' }
const inp: React.CSSProperties = { padding: '7px 9px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, fontFamily: 'inherit', minWidth: 130 }
const sel: React.CSSProperties = { padding: '8px 11px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.base, fontFamily: 'inherit' }
const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--bdr)', color: 'var(--txt)' }
