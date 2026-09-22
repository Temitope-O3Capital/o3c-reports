import { useMemo, useState } from 'react'
import type { Dataset } from './model'
import { Popover } from './Popover'

// SourcePicker chooses the report's data source from a searchable list of fixed height,
// grouped by module. A native select grows to the height of the screen once there are
// many data sources.
export function SourcePicker({ datasets, value, onPick }: {
  datasets: Dataset[]
  value: string
  onPick: (key: string) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [q, setQ] = useState('')
  const current = datasets.find(d => d.key === value)

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const by = new Map<string, Dataset[]>()
    for (const d of datasets) {
      if (s && !`${d.label} ${d.module} ${d.description ?? ''}`.toLowerCase().includes(s)) continue
      const list = by.get(d.module) ?? []
      list.push(d)
      by.set(d.module, list)
    }
    return [...by.entries()]
  }, [datasets, q])

  const close = () => { setAnchor(null); setQ('') }
  const pick = (key: string) => { close(); onPick(key) }

  return (
    <>
      <button type="button" id="rb-source" className="rb-ctl rb-ctl-btn" aria-haspopup="listbox" aria-expanded={!!anchor}
        onClick={e => (anchor ? close() : setAnchor(e.currentTarget))}>
        <small>Source</small>
        <b title={current?.label}>{current?.label ?? 'Choose a Data Source…'}</b>
        <span className="rb-caret" aria-hidden="true">▼</span>
      </button>
      {anchor && (
        <Popover anchorEl={anchor} onClose={close} width={340} label="Choose a data source">
          <div className="rb-menu-search">
            <input id="rb-source-search" autoFocus value={q} onChange={e => setQ(e.target.value)}
              placeholder={`Search ${datasets.length} data sources…`} aria-label="Search data sources"
              onKeyDown={e => { if (e.key === 'Enter' && groups.length) pick(groups[0][1][0].key) }} />
          </div>
          <div className="rb-menu-list rb-source-list" role="listbox" aria-label="Data sources">
            {groups.map(([mod, list]) => (
              <div key={mod} role="group" aria-label={mod}>
                <div className="rb-menu-group">{mod}</div>
                {list.map(d => (
                  <button key={d.key} type="button" role="option" aria-selected={d.key === value}
                    className={d.key === value ? 'on' : undefined} title={d.description || undefined} onClick={() => pick(d.key)}>
                    <span>{d.label}</span>
                    {d.key === value && <i>Current</i>}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <div className="rb-menu-note">No data sources match “{q}”.</div>}
          </div>
        </Popover>
      )}
    </>
  )
}
