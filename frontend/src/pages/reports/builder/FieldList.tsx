import { useMemo, useState } from 'react'
import type { Dataset, ReportState } from './model'
import { isNumeric, typeTag } from './model'

// FieldList is every field in the data source. In Table view a click adds or removes
// the field as a column; in Summary view it offers Rows, Columns or Values. The funnel
// beside each field adds a filter on it.
export function FieldList({ ds, report, onChange, onAddFilter }: {
  ds: Dataset
  report: ReportState
  onChange: (patch: Partial<ReportState>) => void
  onAddFilter: (key: string) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const fields = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? ds.columns.filter(c => c.label.toLowerCase().includes(s)) : ds.columns
  }, [ds, q])

  const inTable = new Set(report.columns.map(c => c.key))
  const inSummary = new Set([...report.rows, ...report.cols, ...report.values.map(v => v.column)])
  const table = report.view === 'table'

  const toggleColumn = (key: string) => {
    const col = ds.columns.find(c => c.key === key)
    if (inTable.has(key)) {
      onChange({
        columns: report.columns.filter(c => c.key !== key),
        totals: report.totals.filter(k => k !== key),
        tableSort: report.tableSort.filter(s => s.key !== key),
      })
    } else {
      const money = col && (col.type === 'kobo' || col.type === 'money')
      onChange({ columns: [...report.columns, { key }], totals: money ? [...report.totals, key] : report.totals })
    }
  }

  const addTo = (key: string, zone: 'rows' | 'cols' | 'values') => {
    const col = ds.columns.find(c => c.key === key)
    if (zone === 'values') {
      onChange({ values: [...report.values, { column: key, agg: isNumeric(col?.type) ? 'sum' : 'count' }] })
    } else if (zone === 'rows') {
      onChange({ rows: [...report.rows.filter(k => k !== key), key], cols: report.cols.filter(k => k !== key) })
    } else {
      onChange({ cols: [...report.cols.filter(k => k !== key), key], rows: report.rows.filter(k => k !== key) })
    }
    setOpen(null)
  }

  return (
    <aside className="rb-fields" aria-label="Fields">
      <div className="rb-fields-head"><span>Fields</span><span>{ds.columns.length}</span></div>
      <input id="rb-field-search" className="rb-input" value={q} onChange={e => setQ(e.target.value)}
        placeholder="Search fields…" aria-label="Search fields" />
      <div className="rb-field-list">
        {fields.map(c => {
          const on = table ? inTable.has(c.key) : inSummary.has(c.key)
          return (
            <div key={c.key}>
              <div className="rb-field-row">
                <button
                  type="button"
                  className="rb-field"
                  data-in={on}
                  aria-pressed={table ? on : undefined}
                  aria-expanded={table ? undefined : open === c.key}
                  title={table ? (on ? `Remove ${c.label} from the table` : `Add ${c.label} to the table`) : `Add ${c.label} to the summary`}
                  onClick={() => (table ? toggleColumn(c.key) : setOpen(open === c.key ? null : c.key))}
                >
                  <span>{c.label}</span><i>{typeTag(c.type)}</i>
                </button>
                <button type="button" className="rb-field-filter" title={`Filter by ${c.label}`} aria-label={`Filter by ${c.label}`}
                  onClick={() => onAddFilter(c.key)}>
                  <span className="material-symbols-rounded" aria-hidden="true">filter_alt</span>
                </button>
              </div>
              {!table && open === c.key && (
                <div className="rb-field-zones">
                  <button type="button" disabled={report.rows.includes(c.key)} onClick={() => addTo(c.key, 'rows')}>Rows</button>
                  <button type="button" disabled={report.cols.includes(c.key)} onClick={() => addTo(c.key, 'cols')}>Columns</button>
                  <button type="button" onClick={() => addTo(c.key, 'values')}>Values</button>
                </div>
              )}
            </div>
          )
        })}
        {!fields.length && <div className="rb-hint">No fields match “{q}”.</div>}
      </div>
    </aside>
  )
}
