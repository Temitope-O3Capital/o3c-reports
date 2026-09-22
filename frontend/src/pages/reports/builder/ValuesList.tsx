import { useEffect, useState } from 'react'
import type { Dataset, DsColumn } from './model'
import { fmtUniqueValue } from './model'
import { fetchUniques, type UniquesResponse } from './api'

export interface ValuesSelection { values: string[]; blank: boolean }

const BLANK_KEY = '\u0000blank'

// ValuesList is a column's unique values with how many records hold each, under the
// report's other filters. Ticking values and pressing Show filters the report to them.
export function ValuesList({ ds, column, base, selected, onApply, onClear }: {
  ds: Dataset
  column: DsColumn
  base: object
  selected: ValuesSelection | null
  onApply: (sel: ValuesSelection) => void
  onClear: () => void
}) {
  const [search, setSearch] = useState('')
  const [data, setData] = useState<UniquesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set([...(selected?.values ?? []), ...(selected?.blank ? [BLANK_KEY] : [])]),
  )
  const baseKey = JSON.stringify(base)

  useEffect(() => {
    const ctl = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetchUniques(ds.key, { ...base, column: column.key, search, limit: 100 }, ctl.signal)
        if (!ctl.signal.aborted) setData(r)
      } catch (e: any) {
        if (!ctl.signal.aborted) setError(e.message)
      } finally {
        if (!ctl.signal.aborted) setLoading(false)
      }
    }, search ? 250 : 0)
    return () => { clearTimeout(timer); ctl.abort() }
    // base is compared by value through baseKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds.key, column.key, baseKey, search])

  const items = data?.values ?? []
  const toggle = (k: string) => setChecked(prev => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })
  const count = checked.size

  return (
    <>
      <div className="rb-menu-search">
        <input
          id={`rb-values-search-${column.key}`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={data ? `Search ${data.distinct_total.toLocaleString()} value${data.distinct_total === 1 ? '' : 's'}…` : 'Search values…'}
          aria-label={`Search ${column.label} values`}
        />
      </div>
      <div className="rb-values" role="listbox" aria-multiselectable="true" aria-label={`${column.label} values`}>
        {error ? (
          <div className="rb-menu-note rb-error">{error}</div>
        ) : loading && !data ? (
          <div className="rb-menu-note">Loading values…</div>
        ) : items.length === 0 ? (
          <div className="rb-menu-note">{search ? `No values match “${search}”.` : 'No values under the current filters.'}</div>
        ) : items.map(it => {
          const k = it.value === null ? BLANK_KEY : it.value
          const on = checked.has(k)
          return (
            <button key={k} type="button" role="option" aria-selected={on}
              className={`rb-val${it.value === null ? ' blank' : ''}`} onClick={() => toggle(k)}>
              <span className={`rb-box${on ? ' on' : ''}`} aria-hidden="true" />
              <span className="rb-val-label" title={fmtUniqueValue(it.value, column.type)}>{fmtUniqueValue(it.value, column.type)}</span>
              <span className="rb-count">{it.count.toLocaleString()}</span>
            </button>
          )
        })}
      </div>
      {data?.more && (
        <div className="rb-menu-note">
          The {items.length} most common of {data.distinct_total.toLocaleString()} values. Search to find others.
        </div>
      )}
      <div className="rb-menu-foot">
        <button type="button" className="rb-btn ghost" onClick={() => { setChecked(new Set()); onClear() }}>Clear</button>
        <button type="button" className="rb-btn primary" disabled={count === 0}
          onClick={() => onApply({ values: [...checked].filter(k => k !== BLANK_KEY), blank: checked.has(BLANK_KEY) })}>
          {count === 0 ? 'Tick Values to Show' : `Show ${count} Value${count === 1 ? '' : 's'}`}
        </button>
      </div>
    </>
  )
}
