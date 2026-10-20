import { useMemo } from 'react'
import { Button, DateFilter } from '../../../components/UI'
import { SP, TEXT, FW } from '../../../lib/design'
import { WINDOWS } from './model'

/*
  The dashboard filter bar: asking the whole board one question.

  WHAT A SLICER REACHES, AND WHY IT IS HONEST ABOUT THE REST. Each tile is an independent
  report over its own dataset, and the datasets are not a star schema — there is no model
  to propagate a selection through. So a slicer is matched BY FILTER KEY: it narrows every
  tile whose dataset declares a filter of that key, and is ignored by a tile whose dataset
  has no such thing. `available_slicers` comes from the server, computed from the board's
  own readable tiles, so the bar can only ever offer a slicer that reaches something — and
  each chip says how many tiles it reaches, because one of twelve is rarely the useful one.

  THE SELECTION IS NOT SAVED. It lives here, in the page. On a shared board a stored
  selection would let one person narrow the figures a colleague is reading without either
  of them knowing. What IS saved is which slicers the board offers (dashboards.config,
  migration 384), and that is the author's decision.
*/

export type Slicer = {
  key: string
  label: string
  kind: string
  options?: string[] | null
  tiles: number
  of_tiles: number
}

export type DashSelection = {
  values: Record<string, string>
  win: string
  from: string
  to: string
}

export const emptySelection = (): DashSelection => ({ values: {}, win: '', from: '', to: '' })

/** The query string a tile appends to its data request. Empty when nothing is selected,
 *  so an unfiltered board fetches exactly the URL it always did. */
export function selectionQuery(sel: DashSelection): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(sel.values)) {
    if (v) p.set(`f_${k}`, v)
  }
  if (sel.win) {
    p.set('win', sel.win)
    if (sel.win === 'custom') {
      if (sel.from) p.set('from', sel.from)
      if (sel.to) p.set('to', sel.to)
    }
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function isSelectionEmpty(sel: DashSelection): boolean {
  return !sel.win && !Object.values(sel.values).some(Boolean)
}

export function DashboardFilterBar({
  slicers, offered, sel, onSel, editing, onOfferedChange, hasDate,
}: {
  /** Everything this board COULD offer, from the server. */
  slicers: Slicer[]
  /** The keys the board does offer, from its saved config. */
  offered: string[]
  sel: DashSelection
  onSel: (next: DashSelection) => void
  editing: boolean
  onOfferedChange: (keys: string[]) => void
  /** Whether any tile has a date column, so a period control is worth showing. */
  hasDate: boolean
}) {
  const byKey = useMemo(() => new Map(slicers.map(s => [s.key, s])), [slicers])
  const shown = useMemo(
    () => offered.map(k => byKey.get(k)).filter((s): s is Slicer => !!s),
    [offered, byKey],
  )

  const setValue = (key: string, v: string) => {
    const values = { ...sel.values }
    if (v) values[key] = v
    else delete values[key]
    onSel({ ...sel, values })
  }

  // In edit mode the author picks which slicers the board offers; everyone else sees only
  // the chosen ones. Nothing to choose from means no tile's dataset declares a filter.
  if (editing) {
    return (
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: SP[2],
        padding: `${SP[3]}px ${SP[4]}px`, marginBottom: SP[3],
        border: '1px dashed var(--bdr)', borderRadius: 8, background: 'var(--th-bg)',
      }}>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>
          Filters this dashboard offers
        </span>
        {!slicers.length ? (
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            None of these tiles&rsquo; data sources declare a filter, so there is nothing to offer yet.
          </span>
        ) : slicers.map(s => {
          const on = offered.includes(s.key)
          return (
            <button key={s.key} type="button"
              onClick={() => onOfferedChange(on ? offered.filter(k => k !== s.key) : [...offered, s.key])}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--bdr)'}`,
                background: on ? 'var(--accent-soft)' : 'var(--card)',
                color: on ? 'var(--txt)' : 'var(--txt2)',
                fontWeight: on ? FW.semibold : undefined, fontSize: TEXT.xs,
              }}>
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>
                {on ? 'check' : 'add'}
              </span>
              {s.label}
              <i style={{ fontStyle: 'normal', color: 'var(--txt3)', fontSize: 10.5 }}>
                {s.tiles} of {s.of_tiles}
              </i>
            </button>
          )
        })}
      </div>
    )
  }

  if (!shown.length && !hasDate) return null

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: SP[2],
      padding: `${SP[3]}px ${SP[4]}px`, marginBottom: SP[3],
      border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--card)',
    }}>
      {hasDate && (
        <label className="rb-ctl" htmlFor="dash-win">
          <small>Period</small>
          <select id="dash-win" value={sel.win}
            onChange={e => onSel({ ...sel, win: e.target.value })}>
            <option value="">Each Tile&rsquo;s Own</option>
            {WINDOWS.map(w => <option key={w.k} value={w.k}>{w.label}</option>)}
          </select>
        </label>
      )}
      {sel.win === 'custom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <small style={{ fontSize: 11, color: 'var(--txt3)' }}>Dates</small>
          <DateFilter from={sel.from} to={sel.to}
            onChange={(f, t) => onSel({ ...sel, from: f, to: t })} align="left" />
        </div>
      )}

      {shown.map(s => (
        <label key={s.key} className="rb-ctl" htmlFor={`dash-f-${s.key}`}
          title={`Applies to ${s.tiles} of ${s.of_tiles} tiles`}>
          <small>{s.label}</small>
          {s.options && s.options.length ? (
            <select id={`dash-f-${s.key}`} value={sel.values[s.key] ?? ''}
              onChange={e => setValue(s.key, e.target.value)}>
              <option value="">All</option>
              {s.options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input id={`dash-f-${s.key}`} value={sel.values[s.key] ?? ''} placeholder="All"
              style={{
                height: 30, width: 130, border: 'none', outline: 'none',
                background: 'transparent', color: 'var(--txt)', font: 'inherit', fontSize: 13,
              }}
              onChange={e => setValue(s.key, e.target.value)} />
          )}
        </label>
      ))}

      {!isSelectionEmpty(sel) && (
        <Button variant="ghost" icon="filter_alt_off" onClick={() => onSel(emptySelection())}>
          Clear
        </Button>
      )}
    </div>
  )
}
