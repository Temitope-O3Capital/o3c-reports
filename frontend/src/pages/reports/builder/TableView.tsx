import { useEffect, useRef, useState } from 'react'
import type { Dataset, ReportState, SortDir } from './model'
import { filterComplete, fmtCell, isNumeric, isTemporal, queryBase, totalable } from './model'
import { fetchTable, type TableResponse } from './api'
import { ColumnMenu } from './ColumnMenu'
import type { ValuesSelection } from './ValuesList'

const PAGE_SIZES = [100, 200, 500]

// TableView is one line per record: the columns the person chose, in their order and
// under their names, sorted and filtered from the column headers, paged through every
// matching record with totals across all of them.
export function TableView({ ds, report, onChange, onGroupBy }: {
  ds: Dataset
  report: ReportState
  onChange: (patch: Partial<ReportState>) => void
  onGroupBy: (key: string) => void
}) {
  const [pageSize, setPageSize] = useState(200)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<TableResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ key: string; el: HTMLElement } | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)

  const base = queryBase(report, ds)
  const queryKey = JSON.stringify({ ds: ds.key, base, columns: report.columns.map(c => c.key), sort: report.tableSort })
  useEffect(() => { setOffset(0) }, [queryKey])

  // The last page that loaded, and the query it answered. Turning pages of the same query
  // asks the server to skip the count and totals, which scan every matching record, and
  // keeps the ones already shown. Any change to filters, columns, sort or period is a new
  // query and fetches them again.
  const lastOk = useRef<{ queryKey: string; data: TableResponse } | null>(null)

  useEffect(() => {
    if (!report.columns.length) { setData(null); return }
    const ctl = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      const prev = lastOk.current?.queryKey === queryKey ? lastOk.current.data : null
      try {
        const r = await fetchTable(ds.key, {
          ...base, columns: report.columns.map(c => ({ key: c.key })), sort: report.tableSort, limit: pageSize, offset,
          ...(prev ? { skip_totals: true } : {}),
        }, ctl.signal)
        if (ctl.signal.aborted) return
        const next = prev ? { ...r, total: prev.total, totals: prev.totals } : r
        lastOk.current = { queryKey, data: next }
        setData(next)
      } catch (e: any) {
        if (!ctl.signal.aborted) { setError(e.message); setData(null) }
      } finally {
        if (!ctl.signal.aborted) setLoading(false)
      }
    }, 220)
    return () => { clearTimeout(timer); ctl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, offset, pageSize])

  // A column removed while its menu is open (from the field list, say) takes the menu with
  // it, so the menu never acts on a column that is gone.
  useEffect(() => {
    if (menu && !report.columns.some(c => c.key === menu.key)) setMenu(null)
  }, [menu, report.columns])

  const meta = (key: string) => ds.columns.find(c => c.key === key)
  const labelOf = (key: string) => {
    const tc = report.columns.find(c => c.key === key)
    return tc?.label || meta(key)?.label || key
  }
  const indexOf = (key: string) => report.columns.findIndex(c => c.key === key)
  const move = (from: number, to: number) => {
    if (to < 0 || to >= report.columns.length || from === to) return
    const next = [...report.columns]
    const [c] = next.splice(from, 1)
    next.splice(to, 0, c)
    onChange({ columns: next })
  }
  const remove = (key: string) => onChange({
    columns: report.columns.filter(c => c.key !== key),
    totals: report.totals.filter(k => k !== key),
    tableSort: report.tableSort.filter(s => s.key !== key),
  })
  const rename = (key: string, label: string) =>
    onChange({ columns: report.columns.map(c => (c.key === key ? (label ? { key, label } : { key }) : c)) })
  const sortDir = (key: string): SortDir | null => (report.tableSort[0]?.key === key ? report.tableSort[0].dir : null)
  const inFilter = (key: string) => report.colFilters.find(f => f.column === key && f.op === 'in')
  const filtered = (key: string) => report.colFilters.some(f => f.column === key && filterComplete(f))
  const setValues = (key: string, sel: ValuesSelection) => onChange({
    colFilters: [
      ...report.colFilters.filter(f => !(f.column === key && f.op === 'in')),
      { column: key, op: 'in', value: '', values: sel.values, include_blank: sel.blank },
    ],
  })
  const clearValues = (key: string) => onChange({ colFilters: report.colFilters.filter(f => !(f.column === key && f.op === 'in')) })

  const rows = data?.rows ?? []
  const showTotals = report.columns.some(c => report.totals.includes(c.key) && totalable(meta(c.key)?.type))

  // A render function, not a component: declared inside TableView it would remount on
  // every render and cancel a drag in progress.
  const columnsStrip = () => {
    return (
      <div className="rb-strip" aria-label="Columns">
        <span className="rb-strip-label">Columns</span>
        {report.columns.map((c, i) => (
          <span
            key={c.key}
            className={`rb-pill${drag?.from === i ? ' dragging' : ''}${drag && drag.over === i && drag.from !== i && drag.from !== i - 1 ? ' drop-target' : ''}`}
            draggable
            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.key); setDrag({ from: i, over: null }) }}
            onDragOver={e => { if (drag) { e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }) } }}
            // The drop marker sits on the target's left edge, so the column lands just before
            // the target. Dragging right, taking the column out first shifts the target left
            // by one; the column right after it has no marker because nothing would move.
            onDrop={e => { e.preventDefault(); if (drag) move(drag.from, drag.from < i ? i - 1 : i); setDrag(null) }}
            onDragEnd={() => setDrag(null)}
          >
            <span className="rb-pill-main"><span className="rb-grip" aria-hidden="true">⋮⋮</span>{labelOf(c.key)}</span>
            <button type="button" className="rb-x" aria-label={`Remove ${labelOf(c.key)}`} onClick={() => remove(c.key)}>×</button>
          </span>
        ))}
        {/* While dragging, a space after the last column takes a drop there, so a column
            can still be moved to the end. */}
        {drag && report.columns.length > 1 && (
          <span className={`rb-drop-end${drag.over === report.columns.length ? ' on' : ''}`} aria-hidden="true"
            onDragOver={e => { e.preventDefault(); if (drag.over !== report.columns.length) setDrag({ ...drag, over: report.columns.length }) }}
            onDrop={e => { e.preventDefault(); move(drag.from, report.columns.length - 1); setDrag(null) }} />
        )}
        {!report.columns.length && <span className="rb-hint">No columns yet.</span>}
      </div>
    )
  }

  if (!report.columns.length) {
    return (
      <>
        {columnsStrip()}
        <div className="rb-note"><span className="material-symbols-rounded" aria-hidden="true">touch_app</span>
          <span>Click fields on the left to add columns. Each line of the table is one record.</span></div>
      </>
    )
  }

  const menuCol = menu ? report.columns.find(c => c.key === menu.key) : undefined

  return (
    <>
      {columnsStrip()}
      {error && <div className="rb-note error"><span className="material-symbols-rounded" aria-hidden="true">error</span><span>{error}</span></div>}
      <div className={`rb-table-wrap${loading ? ' is-loading' : ''}`}>
        <table className="rb-table">
          <thead>
            <tr>
              {report.columns.map(c => {
                const m = meta(c.key)
                const dir = sortDir(c.key)
                const cls = [isNumeric(m?.type) ? 'num' : '', menu?.key === c.key ? 'active' : '', filtered(c.key) ? 'filtered' : ''].filter(Boolean).join(' ')
                return (
                  <th key={c.key} scope="col" className={cls} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                    <button type="button" className="rb-th-btn" aria-haspopup="dialog" aria-expanded={menu?.key === c.key}
                      onClick={e => setMenu(menu?.key === c.key ? null : { key: c.key, el: e.currentTarget })}>
                      {filtered(c.key) && <span className="rb-dot" title="Filtered" />}
                      <span>{labelOf(c.key)}</span>
                      {dir && <span className="rb-sort" aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>}
                      <span className="rb-caret" aria-hidden="true">▼</span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={offset + ri}>
                {report.columns.map(c => {
                  const type = meta(c.key)?.type ?? 'text'
                  const v = r[c.key]
                  const blank = v === null || v === undefined || v === ''
                  const text = fmtCell(v, type)
                  return (
                    <td key={c.key} className={[isNumeric(type) ? 'num' : '', blank ? 'blank' : ''].filter(Boolean).join(' ')} title={blank ? undefined : text}>
                      {text}
                    </td>
                  )
                })}
              </tr>
            ))}
            {!loading && data && rows.length === 0 && (
              <tr><td colSpan={report.columns.length} className="empty">No records match these filters.</td></tr>
            )}
            {!data && loading && (
              <tr><td colSpan={report.columns.length} className="empty">Loading records…</td></tr>
            )}
          </tbody>
          {showTotals && data && data.total > 0 && (
            <tfoot>
              <tr>
                {report.columns.map((c, i) => {
                  const type = meta(c.key)?.type ?? 'text'
                  const on = report.totals.includes(c.key) && totalable(type)
                  return (
                    <td key={c.key} className={on ? 'num' : ''}>
                      {on ? fmtCell(data.totals?.[c.key], type) : i === 0 ? `Total · ${data.total.toLocaleString()} Records` : ''}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div className="rb-foot">
        <span>
          {data
            ? data.total === 0
              ? 'No records'
              : <>Showing <b>{(offset + 1).toLocaleString()}–{(offset + rows.length).toLocaleString()}</b> of <b>{data.total.toLocaleString()}</b> records</>
            : loading ? 'Loading…' : ''}
        </span>
        <span className="rb-pager">
          <label htmlFor="rb-page-size">Rows per Page</label>
          <select id="rb-page-size" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setOffset(0) }}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <button type="button" aria-label="Previous page" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>‹</button>
          <button type="button" aria-label="Next page"
            disabled={!data || offset + rows.length >= data.total || loading}
            onClick={() => setOffset(offset + pageSize)}>›</button>
        </span>
      </div>
      {menu && menuCol && (() => {
        const key = menuCol.key
        const i = indexOf(key)
        const m = meta(key)
        const type = m?.type ?? 'text'
        const existing = inFilter(key)
        return (
          <ColumnMenu
            anchorEl={menu.el}
            title={labelOf(key)}
            defaultTitle={m?.label ?? key}
            onRename={label => rename(key, label)}
            sort={{ dir: sortDir(key), kind: isNumeric(type) ? 'number' : isTemporal(type) ? 'date' : 'text', onSort: dir => onChange({ tableSort: dir ? [{ key, dir }] : [] }) }}
            onMoveLeft={i > 0 ? () => { move(i, i - 1); setMenu(null) } : undefined}
            onMoveRight={i < report.columns.length - 1 ? () => { move(i, i + 1); setMenu(null) } : undefined}
            onHide={() => { setMenu(null); remove(key) }}
            onGroupBy={() => { setMenu(null); onGroupBy(key) }}
            total={totalable(type) ? {
              on: report.totals.includes(key),
              onToggle: () => onChange({ totals: report.totals.includes(key) ? report.totals.filter(k => k !== key) : [...report.totals, key] }),
            } : undefined}
            values={m ? {
              ds, column: m, base: queryBase(report, ds, key),
              selected: existing ? { values: existing.values ?? [], blank: !!existing.include_blank } : null,
              onApply: sel => { setValues(key, sel); setMenu(null) },
              onClear: () => { clearValues(key); setMenu(null) },
            } : undefined}
            onClose={() => setMenu(null)}
          />
        )
      })()}
    </>
  )
}
