import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, Sk, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost, apiExport } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { INTER, NUM, FW, RADIUS, SP, TEXT, AMBER } from '../../lib/design'
import { toast } from 'sonner'

/*
  Data Export — the single place data leaves the workspace.

  Everything on this page is driven by GET /api/reports/datasets: the dataset
  list, the columns, the filters and the row caps all come from the backend
  registry, so adding a dataset there needs no change here.

  The previous version of this page was decorative. It listed nine datasets the
  backend had never heard of, offered a field checklist the API ignored, and
  called GET on an endpoint registered only for POST — so every click returned
  405 and the page had never produced a file.
*/

// ── Types (mirror handlers/export_datasets.go) ────────────────────────────────

type ColType = 'text' | 'int' | 'kobo' | 'money' | 'pct' | 'date' | 'datetime' | 'bool'

interface DatasetCol { key: string; label: string; type: ColType }
interface DatasetFilter {
  key: string
  label: string
  kind: 'text' | 'select'
  options?: string[]
}
interface Dataset {
  key: string
  label: string
  module: string
  description: string
  columns: DatasetCol[]
  filters?: DatasetFilter[]
  date_label?: string
  date_required: boolean
  max_rows: number
}

interface ExportLogRow {
  id: number
  report_type: string
  dataset_label: string
  format: string
  status: string
  row_count: number
  created_at: string
  created_by: string
  created_by_role: string
}

interface PreviewResult {
  columns: DatasetCol[]
  rows: Record<string, unknown>[]
  row_count: number
  total: number
  max_rows: number
}

const FORMATS: { value: string; label: string }[] = [
  { value: 'csv',  label: 'CSV' },
  { value: 'xlsx', label: 'Excel (XLSX)' },
  { value: 'json', label: 'JSON' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function unwrapList<T>(res: any): T[] {
  if (Array.isArray(res)) return res
  if (res && Array.isArray(res.data)) return res.data
  return []
}

/** Render a preview cell using the same conventions as the exported file. */
function previewCell(v: unknown, type: ColType): string {
  if (v === null || v === undefined) return '—'
  if (type === 'kobo')  return (Number(v) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (type === 'money' || type === 'pct') return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (type === 'bool')  return v ? 'Yes' : 'No'
  if (type === 'date' && typeof v === 'string') return v.slice(0, 10)
  if (type === 'datetime' && typeof v === 'string') return v.replace('T', ' ').slice(0, 16)
  return String(v)
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DataExport() {
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [loadingSets, setLoadingSets] = useState(true)
  const [datasetKey, setDatasetKey] = useState('')

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [format, setFormat] = useState('csv')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [filters, setFilters] = useState<Record<string, string>>({})

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [logs, setLogs] = useState<ExportLogRow[]>([])
  const [logsLoading, setLogsLoading] = useState(true)

  const dataset = useMemo(
    () => datasets.find(d => d.key === datasetKey) ?? null,
    [datasets, datasetKey],
  )

  // Load the registry once.
  useEffect(() => {
    let alive = true
    apiFetch<any>('/api/reports/datasets')
      .then(res => {
        if (!alive) return
        const list = unwrapList<Dataset>(res)
        setDatasets(list)
        if (list.length > 0) setDatasetKey(list[0].key)
      })
      .catch(e => alive && setError(e.message ?? 'Could not load datasets'))
      .finally(() => alive && setLoadingSets(false))
    return () => { alive = false }
  }, [])

  // Changing dataset resets the selection to "everything", which is what an
  // operator almost always wants, and clears filters that no longer apply.
  useEffect(() => {
    if (!dataset) return
    setChecked(new Set(dataset.columns.map(c => c.key)))
    setFilters({})
    setPreview(null)
    setError(null)
  }, [dataset])

  const loadLogs = useCallback(async () => {
    setLogsLoading(true)
    try {
      const res = await apiFetch<any>('/api/reports/exports/log?limit=25')
      setLogs(unwrapList<ExportLogRow>(res))
    } catch {
      // The history is context, not the job — never block the page on it.
    } finally {
      setLogsLoading(false)
    }
  }, [])

  useEffect(() => { loadLogs() }, [loadLogs])

  function toggleField(key: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function requestBody() {
    return {
      format,
      date_from: dateFrom,
      date_to: dateTo,
      // An empty list means "all columns" server-side; send the explicit
      // selection only when it is genuinely a subset.
      columns: dataset && checked.size === dataset.columns.length
        ? []
        : Array.from(checked),
      filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== '')),
    }
  }

  async function runPreview() {
    if (!dataset) return
    setPreviewing(true); setError(null)
    try {
      const res = await apiPost<any>(`/api/reports/datasets/${dataset.key}/preview`, {
        ...requestBody(), limit: 25,
      })
      setPreview((res?.data ?? res) as PreviewResult)
    } catch (e: any) {
      setError(e.message ?? 'Preview failed')
      setPreview(null)
    } finally {
      setPreviewing(false)
    }
  }

  async function runExport() {
    if (!dataset) return
    if (checked.size === 0) { toast.error('Select at least one column'); return }
    if (dataset.date_required && (!dateFrom || !dateTo)) {
      toast.error(`${dataset.label} needs a start and end date`)
      return
    }
    setExporting(true); setError(null)
    try {
      const res = await apiExport(`/api/reports/datasets/${dataset.key}/download`, {
        method: 'POST',
        body: requestBody(),
        fallbackName: `${dataset.key}.${format === 'xlsx' ? 'xlsx' : format}`,
      })
      if (res.truncated) {
        // Never let a capped file pass for the whole book.
        toast.warning(
          `Capped at ${dataset.max_rows.toLocaleString()} rows. Narrow the date range or filters for the full set.`,
          { duration: 10000 },
        )
      } else {
        toast.success(`Exported ${res.rows.toLocaleString()} rows`)
      }
      loadLogs()
    } catch (e: any) {
      setError(e.message ?? 'Export failed')
      toast.error(e.message ?? 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', width: '100%',
    boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase',
    letterSpacing: 0.5, fontFamily: INTER, display: 'block', marginBottom: 6,
  }

  // Group datasets by module so the picker reads like the workspace does.
  const grouped = useMemo(() => {
    const m = new Map<string, Dataset[]>()
    for (const d of datasets) {
      if (!m.has(d.module)) m.set(d.module, [])
      m.get(d.module)!.push(d)
    }
    return Array.from(m.entries())
  }, [datasets])

  return (
    <Page
      title="Data Export"
      subtitle="Every data extract in the workspace is produced here, and every extract is logged"
    >
      <ErrBanner error={error} />

      <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 140px)', minHeight: 520 }}>

        {/* ── Config panel ── */}
        <div style={{
          width: 320, flexShrink: 0, borderRight: '1px solid var(--bdr)',
          background: 'var(--card)', padding: SP[5], overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: SP[5],
        }}>
          <div>
            <label style={labelStyle} htmlFor="dataset">Dataset</label>
            {loadingSets ? <Sk h={32} /> : (
              <select id="dataset" value={datasetKey} onChange={e => setDatasetKey(e.target.value)} style={inputStyle}>
                {grouped.map(([mod, items]) => (
                  <optgroup key={mod} label={mod}>
                    {items.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
            {dataset && (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 6, lineHeight: 1.5 }}>
                {dataset.description}
              </div>
            )}
          </div>

          {dataset && (
            <>
              {dataset.date_label && (
                <div>
                  <label style={labelStyle}>
                    {dataset.date_label}
                    {dataset.date_required && (
                      <span style={{ color: AMBER, marginLeft: 4, textTransform: 'none' }}>· required</span>
                    )}
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <input type="date" aria-label="From" value={dateFrom}
                      onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
                    <input type="date" aria-label="To" value={dateTo}
                      onChange={e => setDateTo(e.target.value)} style={inputStyle} />
                  </div>
                </div>
              )}

              {(dataset.filters ?? []).length > 0 && (
                <div>
                  <label style={labelStyle}>Filters</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(dataset.filters ?? []).map(f => (
                      f.kind === 'select' ? (
                        <select key={f.key} aria-label={f.label} style={inputStyle}
                          value={filters[f.key] ?? ''}
                          onChange={e => setFilters(p => ({ ...p, [f.key]: e.target.value }))}>
                          <option value="">{f.label}: any</option>
                          {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input key={f.key} style={inputStyle} placeholder={f.label}
                          value={filters[f.key] ?? ''}
                          onChange={e => setFilters(p => ({ ...p, [f.key]: e.target.value }))} />
                      )
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label style={labelStyle} htmlFor="format">Format</label>
                <select id="format" value={format} onChange={e => setFormat(e.target.value)} style={inputStyle}>
                  {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>
                    Columns ({checked.size}/{dataset.columns.length})
                  </label>
                  <div style={{ display: 'flex', gap: SP[2] }}>
                    <button type="button" onClick={() => setChecked(new Set(dataset.columns.map(c => c.key)))}
                      style={{ fontSize: TEXT.xs, color: 'var(--txt2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: INTER }}>
                      All
                    </button>
                    <button type="button" onClick={() => setChecked(new Set())}
                      style={{ fontSize: TEXT.xs, color: 'var(--txt2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: INTER }}>
                      None
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {dataset.columns.map(c => {
                    const on = checked.has(c.key)
                    return (
                      <label key={c.key} style={{
                        display: 'flex', alignItems: 'center', gap: SP[2], cursor: 'pointer',
                        padding: '5px 8px', borderRadius: RADIUS.md,
                        background: on ? 'rgba(14,40,65,.04)' : 'transparent',
                      }}>
                        <input type="checkbox" checked={on} onChange={() => toggleField(c.key)}
                          style={{ width: 15, height: 15, accentColor: '#0E2841', cursor: 'pointer', flexShrink: 0 }} />
                        <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: on ? 500 : 400 }}>
                          {c.label}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                <button type="button" onClick={runPreview} disabled={previewing}
                  style={{ ...btnSecondary, width: '100%', justifyContent: 'center' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>visibility</span>
                  {previewing ? 'Loading…' : 'Preview'}
                </button>
                <button type="button" onClick={runExport} disabled={exporting || checked.size === 0}
                  style={{ ...btnPrimary, width: '100%', justifyContent: 'center' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
                  {exporting ? 'Exporting…' : 'Export'}
                </button>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textAlign: 'center', lineHeight: 1.5 }}>
                  Capped at {dataset.max_rows.toLocaleString()} rows. Exports are recorded
                  against your name.
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Results ── */}
        <div style={{ flex: 1, padding: SP[5], overflow: 'auto', display: 'flex', flexDirection: 'column', gap: SP[4] }}>

          {preview && (
            <SectionCard
              title="Preview"
              subtitle={
                preview.total > preview.row_count
                  ? `Showing ${preview.row_count} of ${preview.total.toLocaleString()} matching rows`
                  : `${preview.row_count.toLocaleString()} matching row${preview.row_count === 1 ? '' : 's'}`
              }
            >
              {preview.rows.length === 0 ? (
                <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', padding: '8px 0' }}>
                  No rows match these filters. The export would be empty.
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: TEXT.sm, minWidth: '100%' }}>
                    <thead>
                      <tr>
                        {preview.columns.map(c => (
                          <th key={c.key} style={{
                            textAlign: c.type === 'text' ? 'left' : 'right',
                            padding: '6px 12px', whiteSpace: 'nowrap',
                            borderBottom: '1px solid var(--bdr)', color: 'var(--txt2)',
                            fontFamily: INTER, fontWeight: FW.semibold, fontSize: TEXT.xs,
                            textTransform: 'uppercase', letterSpacing: 0.4,
                          }}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, i) => (
                        <tr key={i}>
                          {preview.columns.map(c => (
                            <td key={c.key} style={{
                              padding: '6px 12px', whiteSpace: 'nowrap',
                              borderBottom: '1px solid var(--bdr)',
                              textAlign: c.type === 'text' ? 'left' : 'right',
                              ...(c.type === 'text' ? {} : NUM),
                              color: 'var(--txt)',
                            }}>{previewCell(row[c.key], c.type)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}

          {!preview && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SP[3] }}>
              <div style={{
                width: 56, height: 56, borderRadius: RADIUS['2xl'], background: 'rgba(14,40,65,.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: 'var(--txt3)' }}>download</span>
              </div>
              <div style={{ textAlign: 'center', maxWidth: 380 }}>
                <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: SP[1] }}>
                  Choose a dataset
                </div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6 }}>
                  Preview it first to confirm you are pulling the right rows, then export
                  as CSV, Excel or JSON.
                </div>
              </div>
            </div>
          )}

          <SectionCard title="Recent Exports" subtitle="Everything extracted from the workspace, by whom">
            {logsLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Array.from({ length: 4 }).map((_, i) => <Sk key={i} h={24} />)}
              </div>
            ) : logs.length === 0 ? (
              <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', padding: '8px 0' }}>
                No exports recorded yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {logs.map(log => (
                  <div key={log.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: `${SP[2]} ${SP[3]}`,
                    borderRadius: RADIUS.md, background: 'var(--bg)', border: '1px solid var(--bdr)',
                  }}>
                    <span className="material-symbols-rounded"
                      style={{ fontSize: TEXT.lg, color: 'var(--txt3)', flexShrink: 0 }}>description</span>
                    <span style={{ flex: 1, fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>
                      {log.dataset_label || log.report_type}
                    </span>
                    <span style={{
                      fontSize: TEXT['2xs'], fontFamily: INTER, textTransform: 'uppercase',
                      letterSpacing: 0.4, color: 'var(--txt3)',
                    }}>{log.format}</span>
                    {log.status !== 'ok' && (
                      <span style={{
                        fontSize: TEXT['2xs'], fontFamily: INTER, padding: '1px 6px',
                        borderRadius: RADIUS.sm, background: 'rgba(245,158,11,.12)', color: AMBER,
                      }}>{log.status}</span>
                    )}
                    <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                      {(log.row_count ?? 0).toLocaleString()} rows
                    </span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, minWidth: 110 }}>
                      {log.created_by || '—'}
                    </span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
                      {fmtDatetime(log.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </Page>
  )
}
