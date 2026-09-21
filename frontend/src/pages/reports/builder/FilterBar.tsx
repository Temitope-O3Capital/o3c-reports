import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ColFilter, Dataset, DsColumn, DsFilter, ReportState } from './model'
import {
  defaultOp, describeFilter, filterComplete, inputToKobo, isNumeric, koboToInput,
  opNeedsValue, opsForType, queryBase, typeTag,
} from './model'
import { Popover } from './Popover'
import { ValuesList } from './ValuesList'

type Target = { kind: 'add' } | { kind: 'col'; index: number } | { kind: 'declared'; key: string }

// FilterBar is the report's one filter row. Each filter reads as a sentence on a pill;
// clicking it opens its editor. The data source's built-in filters sit at the end as
// suggestions.
export function FilterBar({ ds, report, onChange, request, onRequestHandled }: {
  ds: Dataset
  report: ReportState
  onChange: (patch: Partial<ReportState>) => void
  request: { key: string; nonce: number } | null
  onRequestHandled: () => void
}) {
  const [open, setOpen] = useState<{ target: Target; el: HTMLElement } | null>(null)
  const pillRefs = useRef<(HTMLElement | null)[]>([])
  const pendingOpen = useRef<number | null>(null)
  const declared = ds.filters ?? []
  const colOf = (key: string) => ds.columns.find(c => c.key === key)

  const addFilterFor = (key: string) => {
    const col = colOf(key)
    if (!col) return
    pendingOpen.current = report.colFilters.length
    onChange({ colFilters: [...report.colFilters, { column: key, op: defaultOp(col.type), value: '', value2: '', values: [] }] })
  }
  // A filter added from the field list or the picker opens its editor once its pill exists.
  useEffect(() => {
    const i = pendingOpen.current
    if (i === null) return
    const el = pillRefs.current[i]
    if (el && report.colFilters[i]) {
      pendingOpen.current = null
      setOpen({ target: { kind: 'col', index: i }, el })
    }
  })
  // The request is handed back as handled at once: kept, it would open a filter again
  // whenever this bar remounts, such as on returning from Saved Reports.
  useEffect(() => {
    if (request) {
      onRequestHandled()
      addFilterFor(request.key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const removeCol = (i: number) => onChange({ colFilters: report.colFilters.filter((_, x) => x !== i) })
  const updateCol = (i: number, f: ColFilter) => onChange({ colFilters: report.colFilters.map((x, xi) => (xi === i ? f : x)) })
  const setDeclared = (key: string, value: string) => onChange({ filters: { ...report.filters, [key]: value } })

  // Closing an editor on a filter that was never finished removes it.
  const close = () => {
    if (open?.target.kind === 'col') {
      const f = report.colFilters[open.target.index]
      if (f && !filterComplete(f)) removeCol(open.target.index)
    }
    setOpen(null)
  }

  let editor: ReactNode = null
  if (open?.target.kind === 'add') {
    editor = <FieldPicker ds={ds} onPick={key => { setOpen(null); addFilterFor(key) }} />
  } else if (open?.target.kind === 'declared') {
    const key = open.target.key
    const f = declared.find(x => x.key === key)
    if (f) {
      editor = (
        <DeclaredEditor key={key} f={f} value={report.filters[key] ?? ''}
          onApply={v => { setDeclared(key, v); setOpen(null) }}
          onClear={() => { setDeclared(key, ''); setOpen(null) }} />
      )
    }
  } else if (open?.target.kind === 'col') {
    const i = open.target.index
    const f = report.colFilters[i]
    const col = f && colOf(f.column)
    if (f && col) {
      editor = (
        <ColFilterEditor key={`${i}:${f.column}`} ds={ds} col={col} filter={f} base={queryBase(report, ds, f.column)}
          onApply={nf => { updateCol(i, nf); setOpen(null) }}
          onRemove={() => { removeCol(i); setOpen(null) }} />
      )
    }
  }

  return (
    <div className="rb-strip" aria-label="Filters">
      <span className="rb-strip-label">Filters</span>
      {declared.filter(f => (report.filters[f.key] ?? '') !== '').map(f => (
        <span key={`d:${f.key}`} className="rb-pill filter">
          <button type="button" className="rb-pill-main"
            onClick={e => setOpen({ target: { kind: 'declared', key: f.key }, el: e.currentTarget })}>
            {f.label} is {report.filters[f.key]}
          </button>
          <button type="button" className="rb-x" aria-label={`Remove the ${f.label} filter`} onClick={() => setDeclared(f.key, '')}>×</button>
        </span>
      ))}
      {report.colFilters.map((f, i) => {
        const col = colOf(f.column)
        const done = filterComplete(f)
        return (
          <span key={i} ref={el => { pillRefs.current[i] = el }} className={`rb-pill ${done ? 'filter' : 'draft'}`}>
            <button type="button" className="rb-pill-main"
              onClick={e => setOpen({ target: { kind: 'col', index: i }, el: e.currentTarget.parentElement as HTMLElement })}>
              {done ? describeFilter(f, col) : `${col?.label ?? f.column}: choose…`}
            </button>
            <button type="button" className="rb-x" aria-label="Remove filter" onClick={() => removeCol(i)}>×</button>
          </span>
        )
      })}
      {declared.filter(f => (report.filters[f.key] ?? '') === '').map(f => (
        <span key={`s:${f.key}`} className="rb-pill add">
          <button type="button" className="rb-pill-main"
            onClick={e => setOpen({ target: { kind: 'declared', key: f.key }, el: e.currentTarget })}>
            + {f.label}
          </button>
        </span>
      ))}
      <span className="rb-pill add">
        <button type="button" className="rb-pill-main" onClick={e => setOpen({ target: { kind: 'add' }, el: e.currentTarget })}>
          + Filter
        </button>
      </span>
      {open && editor && (
        <Popover anchorEl={open.el} onClose={close} width={open.target.kind === 'col' ? 296 : 264} label="Filter">
          {editor}
        </Popover>
      )}
    </div>
  )
}

function FieldPicker({ ds, onPick }: { ds: Dataset; onPick: (key: string) => void }) {
  const [q, setQ] = useState('')
  const cols = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? ds.columns.filter(c => c.label.toLowerCase().includes(s)) : ds.columns
  }, [ds, q])
  return (
    <>
      <div className="rb-menu-search">
        <input id="rb-filter-field-search" autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder="Filter by which field?" aria-label="Search fields to filter by" />
      </div>
      <div className="rb-menu-list">
        {cols.map(c => (
          <button key={c.key} type="button" onClick={() => onPick(c.key)}>
            <span>{c.label}</span><i>{typeTag(c.type)}</i>
          </button>
        ))}
        {!cols.length && <div className="rb-menu-note">No fields match “{q}”.</div>}
      </div>
    </>
  )
}

function DeclaredEditor({ f, value, onApply, onClear }: {
  f: DsFilter; value: string; onApply: (v: string) => void; onClear: () => void
}) {
  const [v, setV] = useState(value)
  return (
    <>
      <div className="rb-menu-form">
        <label htmlFor={`rb-declared-${f.key}`}>
          {f.label}
          {f.kind === 'select' ? (
            <select id={`rb-declared-${f.key}`} value={v} onChange={e => setV(e.target.value)}>
              <option value="">Any</option>
              {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input id={`rb-declared-${f.key}`} autoFocus value={v} onChange={e => setV(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onApply(v) }} />
          )}
        </label>
      </div>
      <div className="rb-menu-foot">
        <button type="button" className="rb-btn danger" onClick={onClear}>Clear</button>
        <button type="button" className="rb-btn primary" onClick={() => onApply(v)}>Apply</button>
      </div>
    </>
  )
}

function ColFilterEditor({ ds, col, filter, base, onApply, onRemove }: {
  ds: Dataset; col: DsColumn; filter: ColFilter; base: object
  onApply: (f: ColFilter) => void; onRemove: () => void
}) {
  // Money is stored in kobo but typed in naira. The draft holds the naira text exactly as
  // typed, converting only on Apply: converting on every keystroke rounds away a trailing
  // "." or "0" and the digits being typed disappear.
  const kobo = col.type === 'kobo'
  const [draft, setDraft] = useState<ColFilter>(() => (kobo
    ? { ...filter, value: koboToInput(filter.value ?? ''), value2: koboToInput(filter.value2 ?? '') }
    : filter))
  const apply = (d: ColFilter) => onApply(kobo && d.op !== 'in'
    ? { ...d, value: inputToKobo(d.value.trim()), value2: inputToKobo((d.value2 ?? '').trim()) }
    : d)
  const ops = opsForType(col.type)
  const setOp = (op: string) => setDraft(d => ({ ...d, op, ...(op === 'in' ? {} : { values: [], include_blank: false }) }))

  const header = (
    <div className="rb-menu-form">
      <label htmlFor={`rb-filter-op-${col.key}`}>
        {col.label}
        <select id={`rb-filter-op-${col.key}`} value={draft.op} onChange={e => setOp(e.target.value)}>
          {ops.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
        </select>
      </label>
      {draft.op !== 'in' && opNeedsValue(draft.op) && <ValueInputs col={col} draft={draft} setDraft={setDraft} onSubmit={() => filterComplete(draft) && apply(draft)} />}
    </div>
  )

  if (draft.op === 'in') {
    return (
      <>
        {header}
        <ValuesList ds={ds} column={col} base={base}
          selected={{ values: draft.values ?? [], blank: !!draft.include_blank }}
          onApply={sel => onApply({ ...draft, op: 'in', value: '', value2: '', values: sel.values, include_blank: sel.blank })}
          onClear={onRemove} />
      </>
    )
  }
  return (
    <>
      {header}
      <div className="rb-menu-foot">
        <button type="button" className="rb-btn danger" onClick={onRemove}>Remove</button>
        <button type="button" className="rb-btn primary" disabled={!filterComplete(draft)} onClick={() => apply(draft)}>Apply</button>
      </div>
    </>
  )
}

function ValueInputs({ col, draft, setDraft, onSubmit }: {
  col: DsColumn
  draft: ColFilter
  setDraft: (fn: (d: ColFilter) => ColFilter) => void
  onSubmit: () => void
}) {
  const t = col.type
  const kind = t === 'date' ? 'date'
    : t === 'datetime' ? (draft.op === 'eq' ? 'date' : 'datetime-local')
    : isNumeric(t) ? 'number' : 'text'
  const money = t === 'kobo' || t === 'money'

  const field = (which: 'value' | 'value2', placeholder: string) => {
    const input = (
      <input
        id={`rb-filter-${which}-${col.key}`}
        type={kind}
        step={money ? '0.01' : undefined}
        value={draft[which] ?? ''}
        placeholder={placeholder}
        aria-label={which === 'value' ? (draft.op === 'between' ? 'From' : 'Value') : 'To'}
        autoFocus={which === 'value'}
        onChange={e => { const v = e.target.value; setDraft(d => ({ ...d, [which]: v })) }}
        onKeyDown={e => { if (e.key === 'Enter') onSubmit() }}
      />
    )
    return money ? <span className="rb-prefix"><span aria-hidden="true">₦</span>{input}</span> : input
  }

  if (draft.op === 'between') {
    return <div className="rb-inline">{field('value', 'from')}{field('value2', 'to')}</div>
  }
  return field('value', kind === 'text' ? 'Type a value' : '')
}
