import { useMemo, useState } from 'react'
import type { Dataset, DsColumn, ReportState } from './model'
import { isNumeric, typeTag } from './model'

// FieldList is every field in the data source. In Table view a click adds or removes
// the field as a column; in Summary view it offers Rows, Columns or Values. The funnel
// beside each field adds a filter on it.
//
// RELATED DATA. Below the data source's own fields sit the curated relationships it can
// reach (export_joins.go). Picking a field from one joins the relationship and adds the
// field in a single click, after which it behaves exactly like a native field — because
// the server has expanded the dataset and every downstream path sees one flat column
// list. Only relationships the server offered are shown, and it offers only those whose
// other dataset this person may open.
export function FieldList({ ds, report, onChange, onAddFilter }: {
  ds: Dataset
  report: ReportState
  onChange: (patch: Partial<ReportState>) => void
  onAddFilter: (key: string) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [openRel, setOpenRel] = useState<string | null>(null)

  const relations = ds.relations ?? []
  const active = useMemo(() => new Set(report.relations), [report.relations])

  // The fields that exist RIGHT NOW: the source's own, plus those of every relationship
  // already joined. Everything below looks a field up in here, so a joined field is not
  // a special case once it has been added.
  const liveCols: DsColumn[] = useMemo(() => {
    const out = [...ds.columns]
    for (const r of relations) if (active.has(r.key)) out.push(...r.columns)
    return out
  }, [ds.columns, relations, active])

  const fields = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? liveCols.filter(c => c.label.toLowerCase().includes(s)) : liveCols
  }, [liveCols, q])

  const inTable = new Set(report.columns.map(c => c.key))
  const inSummary = new Set([...report.rows, ...report.cols, ...report.values.map(v => v.column)])
  const table = report.view === 'table'

  const colByKey = (key: string) => liveCols.find(c => c.key === key)

  const addColumn = (key: string, col?: DsColumn) => {
    const c = col ?? colByKey(key)
    const money = c && (c.type === 'kobo' || c.type === 'money')
    onChange({ columns: [...report.columns, { key }], totals: money ? [...report.totals, key] : report.totals })
  }

  const toggleColumn = (key: string) => {
    if (inTable.has(key)) {
      onChange({
        columns: report.columns.filter(c => c.key !== key),
        totals: report.totals.filter(k => k !== key),
        tableSort: report.tableSort.filter(s => s.key !== key),
      })
    } else {
      addColumn(key)
    }
  }

  const addTo = (key: string, zone: 'rows' | 'cols' | 'values', col?: DsColumn) => {
    const c = col ?? colByKey(key)
    if (zone === 'values') {
      onChange({ values: [...report.values, { column: key, agg: isNumeric(c?.type) ? 'sum' : 'count' }] })
    } else if (zone === 'rows') {
      onChange({ rows: [...report.rows.filter(k => k !== key), key], cols: report.cols.filter(k => k !== key) })
    } else {
      onChange({ cols: [...report.cols.filter(k => k !== key), key], rows: report.rows.filter(k => k !== key) })
    }
    setOpen(null)
  }

  // Joining and then adding, in one click — the relationship on its own does nothing
  // visible, so making someone turn it on and then find the field would be two steps to
  // achieve what they already asked for.
  const addFromRelation = (relKey: string, col: DsColumn) => {
    const rels = active.has(relKey) ? report.relations : [...report.relations, relKey]
    if (table) {
      const money = col.type === 'kobo' || col.type === 'money'
      onChange({
        relations: rels,
        columns: [...report.columns, { key: col.key }],
        totals: money ? [...report.totals, col.key] : report.totals,
      })
    } else {
      onChange({ relations: rels, rows: [...report.rows, col.key] })
    }
    setOpenRel(null)
  }

  // Dropping a relationship MUST take its fields with it. A report still naming
  // "loan__dpd" after the join is gone asks the server for a column it no longer
  // declares, and the whole report fails rather than losing one column.
  const removeRelation = (relKey: string) => {
    const rel = relations.find(r => r.key === relKey)
    if (!rel) return
    const gone = new Set(rel.columns.map(c => c.key))
    onChange({
      relations: report.relations.filter(k => k !== relKey),
      columns: report.columns.filter(c => !gone.has(c.key)),
      totals: report.totals.filter(k => !gone.has(k)),
      tableSort: report.tableSort.filter(s => !gone.has(s.key)),
      rows: report.rows.filter(k => !gone.has(k)),
      cols: report.cols.filter(k => !gone.has(k)),
      values: report.values.filter(v => !gone.has(v.column)),
      colFilters: report.colFilters.filter(f => !gone.has(f.column)),
    })
  }

  return (
    <aside className="rb-fields" aria-label="Fields">
      <div className="rb-fields-head"><span>Fields</span><span>{liveCols.length}</span></div>
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

      {relations.length > 0 && (
        <div className="rb-rel">
          <div className="rb-fields-head"><span>Related Data</span><span>{relations.length}</span></div>
          {relations.map(r => {
            const on = active.has(r.key)
            return (
              <div key={r.key} className="rb-rel-group" data-on={on}>
                <div className="rb-field-row">
                  <button type="button" className="rb-field" data-in={on} aria-expanded={openRel === r.key}
                    title={r.note}
                    onClick={() => setOpenRel(openRel === r.key ? null : r.key)}>
                    <span>{r.label}</span><i>{on ? 'joined' : `${r.columns.length} fields`}</i>
                  </button>
                  {on && (
                    <button type="button" className="rb-field-filter" title={`Remove ${r.label} and its fields`}
                      aria-label={`Remove ${r.label} and its fields`} onClick={() => removeRelation(r.key)}>
                      <span className="material-symbols-rounded" aria-hidden="true">link_off</span>
                    </button>
                  )}
                </div>
                {openRel === r.key && (
                  <div className="rb-rel-body">
                    <p className="rb-hint">{r.note}</p>
                    {r.columns.map(c => (
                      <button key={c.key} type="button" className="rb-rel-field"
                        disabled={table ? inTable.has(c.key) : inSummary.has(c.key)}
                        title={`Add ${c.label}`}
                        onClick={() => addFromRelation(r.key, c)}>
                        <span>{c.label.includes(' · ') ? c.label.split(' · ').slice(1).join(' · ') : c.label}</span>
                        <i>{typeTag(c.type)}</i>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}
