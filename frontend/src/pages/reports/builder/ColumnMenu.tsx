import { useEffect, useState } from 'react'
import { Popover } from './Popover'
import { ValuesList, type ValuesSelection } from './ValuesList'
import type { Dataset, DsColumn, SortDir } from './model'

const SORT_LABELS = {
  text: ['Sort A → Z', 'Sort Z → A'],
  number: ['Low → High', 'High → Low'],
  date: ['Oldest First', 'Newest First'],
} as const

interface Action { key: string; label: string; icon: string; onClick: () => void; pressed?: boolean; disabled?: boolean }

// ColumnMenu opens from a column header: rename the column, sort, hide or move it,
// and — for a column backed by a field — tick its unique values to filter the report.
export function ColumnMenu({
  anchorEl, title, defaultTitle, onRename, sort, onHide, onMoveLeft, onMoveRight, onGroupBy, total, values, onClose,
}: {
  anchorEl: HTMLElement
  title: string
  defaultTitle: string
  onRename?: (label: string) => void
  sort?: { dir: SortDir | null; kind: 'text' | 'number' | 'date'; onSort: (dir: SortDir | null) => void }
  onHide?: () => void
  onMoveLeft?: () => void
  onMoveRight?: () => void
  onGroupBy?: () => void
  total?: { on: boolean; onToggle: () => void }
  values?: {
    ds: Dataset; column: DsColumn; base: object; selected: ValuesSelection | null
    onApply: (sel: ValuesSelection) => void; onClear: () => void
  }
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  useEffect(() => { if (!editing) setDraft(title) }, [title, editing])

  // An empty name, or the field's own name, resets the column to its default.
  const commit = () => {
    setEditing(false)
    const v = draft.trim()
    if (!onRename || v === title) return
    onRename(v === defaultTitle ? '' : v)
  }

  const actions: Action[] = []
  if (sort) {
    const [asc, desc] = SORT_LABELS[sort.kind]
    actions.push(
      { key: 'asc', label: asc, icon: 'arrow_upward', pressed: sort.dir === 'asc', onClick: () => sort.onSort(sort.dir === 'asc' ? null : 'asc') },
      { key: 'desc', label: desc, icon: 'arrow_downward', pressed: sort.dir === 'desc', onClick: () => sort.onSort(sort.dir === 'desc' ? null : 'desc') },
    )
  }
  if (onMoveLeft || onMoveRight) {
    actions.push(
      { key: 'left', label: 'Move Left', icon: 'west', disabled: !onMoveLeft, onClick: () => onMoveLeft?.() },
      { key: 'right', label: 'Move Right', icon: 'east', disabled: !onMoveRight, onClick: () => onMoveRight?.() },
    )
  }
  if (onHide) actions.push({ key: 'hide', label: 'Hide Column', icon: 'visibility_off', onClick: onHide })
  if (onGroupBy) actions.push({ key: 'group', label: 'Group by This', icon: 'pivot_table_chart', onClick: onGroupBy })
  if (total) actions.push({ key: 'total', label: total.on ? 'Hide Total' : 'Show Total', icon: 'functions', pressed: total.on, onClick: total.onToggle })

  return (
    <Popover anchorEl={anchorEl} onClose={onClose} width={286} label={`${title} column`}>
      <div className="rb-menu-title">
        {editing ? (
          <input
            id="rb-rename-input"
            className="rb-rename"
            autoFocus
            value={draft}
            aria-label="Column name"
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { e.stopPropagation(); setDraft(title); setEditing(false) }
            }}
          />
        ) : (
          <b title={title}>{title}</b>
        )}
        {onRename && !editing && (
          <button type="button" className="rb-link" onClick={() => { setDraft(title); setEditing(true) }}>Rename</button>
        )}
      </div>
      {onRename && !editing && title !== defaultTitle && (
        <div className="rb-menu-sub">
          Renamed from “{defaultTitle}” · <button type="button" className="rb-link" onClick={() => onRename('')}>Reset</button>
        </div>
      )}
      {actions.length > 0 && (
        <div className="rb-menu-actions">
          {actions.map(a => (
            <button key={a.key} type="button" aria-pressed={a.pressed === undefined ? undefined : a.pressed} disabled={a.disabled} onClick={a.onClick}>
              <span className="material-symbols-rounded" aria-hidden="true">{a.icon}</span>{a.label}
            </button>
          ))}
        </div>
      )}
      {values && <ValuesList key={values.column.key} {...values} />}
    </Popover>
  )
}
