// Report Builder model: the report definition, the Summary matrix, filters and value
// formatting.
//
// buildMatrix mirrors buildPivotMatrix in backend-go/handlers/pivot_matrix.go. Column ids,
// default names, column order and sort must stay identical to it: a rename, hide or sort
// is saved by column id, and files, emails and schedules are drawn by the server from the
// same definition.

export type View = 'table' | 'summary'
export type ChartKind = 'bar' | 'stacked' | 'line' | 'area' | 'pie'
export type SortDir = 'asc' | 'desc'

export interface DsColumn { key: string; label: string; type: string }
export interface DsFilter { key: string; label: string; kind: 'text' | 'select'; options?: string[] }
export interface Dataset {
  key: string; label: string; module: string; description: string
  columns: DsColumn[]; filters?: DsFilter[]; date_label?: string; date_required?: boolean; max_rows?: number
}

export interface ColFilter {
  column: string
  op: string
  value: string
  value2?: string
  values?: string[]
  include_blank?: boolean
}
export interface TableColumn { key: string; label?: string }
export interface SortSpec { key: string; dir: SortDir }
export interface ValueField { column: string; agg: string; label?: string }
export interface TopN { measure: number; n: number }

// ReportState is everything a report is, in both views. Switching between Table and
// Summary keeps the other view's settings, so switching back loses nothing.
export interface ReportState {
  view: View
  // Table
  columns: TableColumn[]
  totals: string[]
  tableSort: SortSpec[]
  // Summary
  rows: string[]
  cols: string[]
  values: ValueField[]
  grains: Record<string, string>
  headerLabels: Record<string, string>
  hiddenCols: string[]
  summarySort: SortSpec[]
  topN: TopN | null
  // Both
  filters: Record<string, string>
  colFilters: ColFilter[]
  win: string
  from: string
  to: string
  chart: { view: 'table' | 'chart'; kind: ChartKind }
}

// ── Dates ────────────────────────────────────────────────────────────────────

export const WINDOWS = [
  { k: 'today', label: 'Today' },
  { k: 'yesterday', label: 'Yesterday' },
  { k: 'this_week', label: 'This Week' },
  { k: 'last_week', label: 'Last Week (Mon–Sun)' },
  { k: 'last_work_week', label: 'Last Working Week (Mon–Fri)' },
  { k: 'last_7_days', label: 'Last 7 Days' },
  { k: 'last_30_days', label: 'Last 30 Days' },
  { k: 'last_90_days', label: 'Last 90 Days' },
  { k: 'this_month', label: 'This Month' },
  { k: 'last_month', label: 'Last Month' },
  { k: 'this_quarter', label: 'This Quarter' },
  { k: 'last_quarter', label: 'Last Quarter' },
  { k: 'this_year', label: 'This Year' },
  { k: 'custom', label: 'Custom Range…' },
]

export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// resolveWindow — kept in lockstep with resolveReportWindow() in the backend so a
// preview matches what a scheduled send produces.
export function resolveWindow(w: string, custom: { from: string; to: string }): { from: string; to: string } {
  if (w === 'custom') return custom
  // "Today" is the calendar day in Lagos (UTC+1 all year, no daylight saving), as on the
  // server, so a browser set to another timezone still previews the days a schedule sends.
  // The Lagos date is then held as a local midnight, so the local date arithmetic below
  // works on that day.
  const lagos = new Date(Date.now() + 3600_000)
  const t = new Date(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate())
  const minus = (n: number) => isoDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - n))
  // Weeks start on Monday, as in the backend.
  const monday = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7))
  const fromMonday = (n: number) => isoDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + n))
  switch (w) {
    case 'today': return { from: isoDay(t), to: isoDay(t) }
    case 'yesterday': return { from: minus(1), to: minus(1) }
    case 'this_week': return { from: isoDay(monday), to: isoDay(t) }
    case 'last_week': return { from: fromMonday(-7), to: fromMonday(-1) }
    case 'last_work_week': return { from: fromMonday(-7), to: fromMonday(-3) }
    case 'last_7_days': return { from: minus(6), to: isoDay(t) }
    case 'last_30_days': return { from: minus(29), to: isoDay(t) }
    case 'last_90_days': return { from: minus(89), to: isoDay(t) }
    case 'this_month': return { from: isoDay(new Date(t.getFullYear(), t.getMonth(), 1)), to: isoDay(t) }
    case 'last_month': {
      // Day 0 of this month is the last day of the previous one. Subtracting 24 hours
      // instead lands on the wrong day across a daylight-saving change.
      const end = new Date(t.getFullYear(), t.getMonth(), 0)
      return { from: isoDay(new Date(end.getFullYear(), end.getMonth(), 1)), to: isoDay(end) }
    }
    case 'this_quarter': {
      const q = Math.floor(t.getMonth() / 3)
      return { from: isoDay(new Date(t.getFullYear(), q * 3, 1)), to: isoDay(t) }
    }
    case 'last_quarter': {
      const q = Math.floor(t.getMonth() / 3)
      return { from: isoDay(new Date(t.getFullYear(), q * 3 - 3, 1)), to: isoDay(new Date(t.getFullYear(), q * 3, 0)) }
    }
    case 'this_year': return { from: isoDay(new Date(t.getFullYear(), 0, 1)), to: isoDay(t) }
  }
  return custom
}

// ── Field types ──────────────────────────────────────────────────────────────

export const NUMERIC = new Set(['int', 'kobo', 'money', 'pct'])
export const isNumeric = (t?: string) => !!t && NUMERIC.has(t)
export const isTemporal = (t?: string) => t === 'date' || t === 'datetime'
export const totalable = (t?: string) => t === 'int' || t === 'kobo' || t === 'money'

const TYPE_TAG: Record<string, string> = {
  text: 'abc', int: '123', kobo: '₦', money: '₦', pct: '%', date: 'date', datetime: 'date·time', bool: 'yes/no',
}
export const typeTag = (t: string) => TYPE_TAG[t] ?? t

export const AGG_LABEL: Record<string, string> = {
  sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count', count_distinct: 'Unique Count',
}
export function aggsForType(type?: string): string[] {
  if (!type) return ['count']
  // Min and max of a yes/no field mean nothing, and a sum of percentages is not a
  // percentage; the server refuses both, so they are not offered.
  if (type === 'bool') return ['count', 'count_distinct']
  if (type === 'pct') return ['avg', 'min', 'max', 'count', 'count_distinct']
  if (isNumeric(type)) return ['sum', 'avg', 'min', 'max', 'count', 'count_distinct']
  return ['count', 'count_distinct', 'min', 'max']
}
export function valueFieldLabel(v: ValueField, col?: DsColumn): string {
  if (v.label) return v.label
  if (!v.column) return 'Count of Records'
  return `${AGG_LABEL[v.agg] ?? v.agg} of ${col?.label ?? v.column}`
}

// ── Formatting ───────────────────────────────────────────────────────────────

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

function toDate(v: unknown): Date | null {
  const s = String(v)
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s)
  return Number.isNaN(d.getTime()) ? null : d
}
export function fmtDate(v: unknown): string {
  const d = toDate(v)
  return d ? `${pad(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}` : String(v)
}
export function fmtDateTime(v: unknown): string {
  const d = toDate(v)
  return d ? `${pad(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : String(v)
}

// fmtCell renders one value. `naira` is true when kobo has already been converted, as it
// is in the server's json render.
export function fmtCell(v: unknown, type: string, naira = false): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  switch (type) {
    case 'kobo':
      return Number.isNaN(n) ? String(v) : (naira ? n : n / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    case 'money':
      return Number.isNaN(n) ? String(v) : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    case 'pct':
      return Number.isNaN(n) ? String(v) : `${n.toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`
    case 'int':
      return Number.isNaN(n) ? String(v) : n.toLocaleString('en-GB', { maximumFractionDigits: 2 })
    case 'date':
      return fmtDate(v)
    case 'datetime':
      return fmtDateTime(v)
    case 'bool':
      return v === true || v === 'true' ? 'Yes' : v === false || v === 'false' ? 'No' : String(v)
  }
  return String(v)
}

export function fmtUniqueValue(v: string | null, type: string): string {
  if (v === null || v === '') return '(blank)'
  if (isTemporal(type)) return fmtDate(v)
  if (isNumeric(type) || type === 'bool') return fmtCell(v, type)
  return v
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface OpDef { op: string; label: string }

export function opsForType(type: string): OpDef[] {
  if (isNumeric(type)) return [
    { op: 'gte', label: 'at least' }, { op: 'lte', label: 'at most' }, { op: 'between', label: 'between' },
    { op: 'eq', label: 'equal to' }, { op: 'ne', label: 'not equal to' },
    { op: 'gt', label: 'more than' }, { op: 'lt', label: 'less than' },
    { op: 'in', label: 'is one of (pick values)' },
    { op: 'blank', label: 'is blank' }, { op: 'present', label: 'is not blank' },
  ]
  if (isTemporal(type)) return [
    { op: 'between', label: 'between' }, { op: 'gte', label: 'on or after' }, { op: 'lte', label: 'on or before' },
    { op: 'eq', label: 'on' }, { op: 'in', label: 'on one of (pick days)' },
    { op: 'blank', label: 'is blank' }, { op: 'present', label: 'is not blank' },
  ]
  return [
    { op: 'in', label: 'is one of (pick values)' }, { op: 'contains', label: 'contains' },
    { op: 'eq', label: 'is exactly' }, { op: 'ne', label: 'is not' }, { op: 'starts', label: 'starts with' },
    { op: 'blank', label: 'is blank' }, { op: 'present', label: 'is not blank' },
  ]
}
export const defaultOp = (type: string) => isNumeric(type) ? 'gte' : isTemporal(type) ? 'between' : 'in'
export const opNeedsValue = (op: string) => op !== 'blank' && op !== 'present'

export function filterComplete(f: ColFilter): boolean {
  if (!opNeedsValue(f.op)) return true
  if (f.op === 'in') return (f.values?.length ?? 0) > 0 || !!f.include_blank
  if (f.op === 'between') return !!f.value?.trim() && !!f.value2?.trim()
  return !!f.value?.trim()
}

// Money fields are stored in kobo; people type naira.
export const koboToInput = (v: string) => (v === '' || Number.isNaN(Number(v)) ? v : String(Number(v) / 100))
export const inputToKobo = (v: string) => (v === '' || Number.isNaN(Number(v)) ? v : String(Math.round(Number(v) * 100)))

function filterValueText(v: string | undefined, type: string): string {
  if (!v) return '…'
  if (type === 'kobo') return '₦' + fmtCell(v, 'kobo')
  if (type === 'money') return '₦' + fmtCell(v, 'money')
  if (type === 'int' || type === 'pct') return fmtCell(v, type)
  if (isTemporal(type)) return v.length > 10 ? fmtDateTime(v) : fmtDate(v)
  if (type === 'bool') return v === 'true' ? 'Yes' : v === 'false' ? 'No' : v
  return v
}

// describeFilter is the sentence on a filter pill: "Disposition is 3 values",
// "Loan Amount at least ₦100,000.00", "Started between 12 Sep 2026 and 14 Sep 2026".
export function describeFilter(f: ColFilter, col?: DsColumn): string {
  const name = col?.label ?? f.column
  const type = col?.type ?? 'text'
  const show = (v?: string) => filterValueText(v, type)
  const dated = isTemporal(type)
  switch (f.op) {
    case 'in': {
      const parts = [...(f.values ?? []).map(v => fmtUniqueValue(v, type)), ...(f.include_blank ? ['(blank)'] : [])]
      if (parts.length === 1) return `${name} is ${parts[0]}`
      if (parts.length === 2) return `${name} is ${parts[0]} or ${parts[1]}`
      return `${name} is ${parts.length} values`
    }
    case 'blank': return `${name} is blank`
    case 'present': return `${name} is not blank`
    case 'eq': return dated ? `${name} on ${show(f.value)}` : `${name} is ${show(f.value)}`
    case 'ne': return `${name} is not ${show(f.value)}`
    case 'contains': return `${name} contains “${f.value}”`
    case 'starts': return `${name} starts with “${f.value}”`
    case 'gt': return dated ? `${name} after ${show(f.value)}` : `${name} more than ${show(f.value)}`
    case 'gte': return dated ? `${name} on or after ${show(f.value)}` : `${name} at least ${show(f.value)}`
    case 'lt': return dated ? `${name} before ${show(f.value)}` : `${name} less than ${show(f.value)}`
    case 'lte': return dated ? `${name} on or before ${show(f.value)}` : `${name} at most ${show(f.value)}`
    case 'between': return `${name} between ${show(f.value)} and ${show(f.value2)}`
  }
  return name
}

// queryBase is the date range and filters every query for this report shares.
// exceptColumn drops that column's own value list, so its header menu can show every
// value to tick, not only the ones already ticked.
export function queryBase(s: ReportState, ds: Dataset, exceptColumn?: string) {
  const r = resolveWindow(s.win, { from: s.from, to: s.to })
  const dated = !!ds.date_label
  return {
    date_from: dated ? r.from : '',
    date_to: dated ? r.to : '',
    filters: Object.fromEntries(Object.entries(s.filters).filter(([, v]) => String(v ?? '').trim() !== '')),
    col_filters: s.colFilters.filter(filterComplete).filter(f => !(exceptColumn && f.column === exceptColumn && f.op === 'in')),
  }
}

// ── Report definition ────────────────────────────────────────────────────────

export function emptyReport(): ReportState {
  const r = resolveWindow('last_30_days', { from: '', to: '' })
  return {
    view: 'table', columns: [], totals: [], tableSort: [],
    rows: [], cols: [], values: [], grains: {}, headerLabels: {}, hiddenCols: [], summarySort: [], topN: null,
    filters: {}, colFilters: [], win: 'last_30_days', from: r.from, to: r.to,
    chart: { view: 'table', kind: 'bar' },
  }
}

// reportForDataset opens a data source in a working state: a table of its first
// columns, newest first, with money columns totalled.
export function reportForDataset(ds: Dataset): ReportState {
  const base = emptyReport()
  const temporal = ds.columns.find(c => isTemporal(c.type))
  const picked = ds.columns.slice(0, 6)
  if (temporal && !picked.some(c => c.key === temporal.key)) picked.unshift(temporal)
  return {
    ...base,
    columns: picked.map(c => ({ key: c.key })),
    totals: picked.filter(c => c.type === 'kobo' || c.type === 'money').map(c => c.key),
    tableSort: temporal ? [{ key: temporal.key, dir: 'desc' }] : [],
  }
}

export function parseJson(raw: unknown): any {
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(String(raw)) } catch { return {} }
}
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

// toConfig is the saved form, and exactly what the server renders files, emails and
// schedules from. `sort` is the active view's; both views' sorts are kept so switching
// view does not lose one.
export function toConfig(s: ReportState) {
  return {
    view: s.view,
    columns: s.columns,
    totals: s.totals,
    sort: s.view === 'table' ? s.tableSort : s.summarySort,
    table_sort: s.tableSort,
    summary_sort: s.summarySort,
    rows: s.rows,
    cols: s.cols,
    values: s.values,
    grains: s.grains,
    header_labels: s.headerLabels,
    hidden_cols: s.hiddenCols,
    ...(s.topN ? { top_n: s.topN } : {}),
    filters: s.filters,
    col_filters: s.colFilters.filter(filterComplete),
    date_window: s.win,
    date_from: s.from,
    date_to: s.to,
    chart: s.chart,
  }
}

// fromConfig reads any saved report, including ones saved before Table view existed:
// those have no view (a Summary) and may carry renamed row fields as dim_labels.
export function fromConfig(raw: unknown): ReportState {
  const c = parseJson(raw)
  const base = emptyReport()
  const view: View = c.view === 'table' ? 'table' : 'summary'
  const headerLabels: Record<string, string> = { ...(c.header_labels ?? {}) }
  for (const [k, v] of Object.entries(c.dim_labels ?? {})) {
    if (!headerLabels['r:' + k] && v) headerLabels['r:' + k] = String(v)
  }
  const sort = arr<SortSpec>(c.sort)
  const chartView = c.chart?.view === 'chart' ? 'chart' : 'table'
  return {
    ...base,
    view,
    columns: arr<TableColumn>(c.columns),
    totals: arr<string>(c.totals),
    tableSort: Array.isArray(c.table_sort) ? c.table_sort : view === 'table' ? sort : [],
    summarySort: Array.isArray(c.summary_sort) ? c.summary_sort : view === 'summary' ? sort : [],
    rows: arr<string>(c.rows),
    cols: arr<string>(c.cols),
    values: arr<any>(c.values).map(v => ({ column: v.column ?? v.key ?? '', agg: v.agg ?? 'count', ...(v.label ? { label: v.label } : {}) })),
    grains: c.grains ?? {},
    headerLabels,
    hiddenCols: arr<string>(c.hidden_cols),
    topN: c.top_n && Number(c.top_n.n) > 0 ? { measure: Number(c.top_n.measure) || 0, n: Number(c.top_n.n) } : null,
    filters: c.filters ?? {},
    colFilters: arr<ColFilter>(c.col_filters),
    win: c.date_window || base.win,
    from: c.date_from || base.from,
    to: c.date_to || base.to,
    chart: { view: chartView, kind: (c.chart?.kind as ChartKind) ?? 'bar' },
  }
}

// ── Summary matrix (mirror of pivot_matrix.go) ───────────────────────────────

export interface PivotDim { key: string; label: string; role: 'row' | 'col'; type: string }
export interface PivotMeasure { key: string; label: string; agg: string; type: string }
export interface PivotResult {
  dimensions: PivotDim[] | null
  measures: PivotMeasure[] | null
  rows: Record<string, any>[] | null
  truncated: boolean
  group_cap: number
  raw_count?: number
  group_total?: number
  top_n_applied?: boolean
}
export interface MatrixCol { id: string; label: string; defaultLabel: string; type: string; dim: boolean; fieldKey?: string }
export interface Matrix { cols: MatrixCol[]; rows: any[][]; all: MatrixCol[] }

const SEP = '\u001f'
const BLANK = '(blank)'
const valueKey = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const cellBlank = (v: unknown) => v === null || v === undefined || v === ''

export function compareCells(x: unknown, y: unknown, numeric: boolean, desc: boolean): number {
  const xb = cellBlank(x), yb = cellBlank(y)
  if (xb || yb) return xb === yb ? 0 : xb ? 1 : -1
  let c = 0
  if (numeric) {
    const fx = Number(x), fy = Number(y)
    c = fx < fy ? -1 : fx > fy ? 1 : 0
  } else {
    const sx = String(x), sy = String(y)
    c = sx < sy ? -1 : sx > sy ? 1 : 0
  }
  return desc ? -c : c
}

export function buildMatrix(res: PivotResult, labels: Record<string, string>, hidden: string[], sort: SortSpec[]): Matrix {
  const dims = res.dimensions ?? []
  const meas = res.measures ?? []
  const rowDims = dims.filter(d => !(d.role === 'col' && meas.length > 0))
  const colDims = meas.length > 0 ? dims.filter(d => d.role === 'col') : []
  const tuple = (r: Record<string, any>, ds: PivotDim[]) => {
    const keys = ds.map(d => valueKey(r[d.key]))
    return { key: keys.join(SEP), names: keys.map(k => (k === '' ? BLANK : k)) }
  }

  const rowOrder: string[] = []
  const rowsBy = new Map<string, { names: string[]; cells: Map<string, Record<string, any>> }>()
  const colNames = new Map<string, string[]>()
  const colKeys: string[] = []
  for (const r of res.rows ?? []) {
    const rt = tuple(r, rowDims)
    const ct = tuple(r, colDims)
    let acc = rowsBy.get(rt.key)
    if (!acc) {
      acc = { names: rt.names, cells: new Map() }
      rowsBy.set(rt.key, acc)
      rowOrder.push(rt.key)
    }
    acc.cells.set(ct.key, r)
    if (colDims.length && !colNames.has(ct.key)) {
      colNames.set(ct.key, ct.names)
      colKeys.push(ct.key)
    }
  }
  colKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const cols: MatrixCol[] = rowDims.map(d => {
    const fieldKey = d.key.replace(/^d_/, '')
    return { id: 'r:' + fieldKey, label: d.label, defaultLabel: d.label, type: 'text', dim: true, fieldKey }
  })
  const refs: { colKey: string; measKey: string }[] = []
  if (!colDims.length) {
    meas.forEach((m, i) => {
      cols.push({ id: 'm:' + i, label: m.label, defaultLabel: m.label, type: m.type, dim: false })
      refs.push({ colKey: '', measKey: m.key })
    })
  } else {
    for (const ck of colKeys) {
      meas.forEach((m, i) => {
        let label = (colNames.get(ck) ?? []).join(' · ')
        if (meas.length > 1) label += ' · ' + m.label
        cols.push({ id: `c:${ck}|m:${i}`, label, defaultLabel: label, type: m.type, dim: false })
        refs.push({ colKey: ck, measKey: m.key })
      })
    }
  }

  let rows = rowOrder.map(rk => {
    const acc = rowsBy.get(rk)!
    return [...acc.names, ...refs.map(ref => {
      const cell = acc.cells.get(ref.colKey)
      return cell ? cell[ref.measKey] ?? null : null
    })]
  })

  for (const c of cols) {
    const l = labels[c.id]?.trim()
    if (l) c.label = l
  }

  if (sort.length) {
    const idx = cols.findIndex(c => c.id === sort[0].key)
    if (idx >= 0) {
      const numeric = !cols[idx].dim && isNumeric(cols[idx].type)
      const desc = sort[0].dir === 'desc'
      rows = [...rows].sort((a, b) => compareCells(a[idx], b[idx], numeric, desc))
    }
  }

  const hide = new Set(hidden)
  const keep = cols.map((c, i) => (hide.has(c.id) ? -1 : i)).filter(i => i >= 0)
  if (keep.length === cols.length) return { cols, rows, all: cols }
  return { cols: keep.map(i => cols[i]), rows: rows.map(r => keep.map(i => r[i])), all: cols }
}

// remapMeasureIds keeps renames, hidden columns, the sort and Top N attached to the
// right measure when Values are reordered or one is removed — measure columns are
// identified by their position.
export function remapMeasureIds(
  s: ReportState,
  map: (old: number) => number | null,
): Pick<ReportState, 'headerLabels' | 'hiddenCols' | 'summarySort' | 'topN'> {
  const remap = (id: string): string | null => {
    const m = /^(m:|.*\|m:)(\d+)$/.exec(id)
    if (!m) return id
    const n = map(Number(m[2]))
    return n === null ? null : m[1] + n
  }
  const headerLabels: Record<string, string> = {}
  for (const [id, label] of Object.entries(s.headerLabels)) {
    const next = remap(id)
    if (next !== null) headerLabels[next] = label
  }
  const summarySort: SortSpec[] = []
  for (const x of s.summarySort) {
    const key = remap(x.key)
    if (key !== null) summarySort.push({ ...x, key })
  }
  let topN: TopN | null = null
  if (s.topN) {
    const n = map(s.topN.measure)
    topN = n === null ? null : { ...s.topN, measure: n }
  }
  return {
    headerLabels,
    hiddenCols: s.hiddenCols.map(remap).filter((x): x is string => x !== null),
    summarySort,
    topN,
  }
}
