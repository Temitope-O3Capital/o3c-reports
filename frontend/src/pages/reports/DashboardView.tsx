import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, Button, ErrBanner, EmptyState, Input, Modal, Badge, Sk, DataTable,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EBar, ELine, EArea, EDonut } from '../../components/echarts'
import { CHART_SERIES } from '../../components/charts'
import { apiFetch, apiPost, apiPut, apiDelete, unwrap, unwrapList } from '../../lib/api'
import { kindOf, labelFor, fmtValue, alignFor } from '../../lib/reportFormat'
import { NAVY, FW, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

/*
  A dashboard, drawn.

  THE GRID IS 12 COLUMNS AND THE ROW HEIGHT IS FIXED. Both numbers are in the schema's
  CHECK constraints (migration 358), so a tile that fits here fits there, and a layout
  dragged in the browser cannot be rejected by the database. x + w <= 12 is enforced in
  three places for that reason — here while dragging, in the handler, and in the
  constraint — which sounds excessive until you consider that the first two are advice
  and only the last one is a guarantee.

  EVERY TILE FETCHES ITS OWN DATA. A dashboard of twelve tiles is twelve requests, each
  re-checked against the viewer's access to that tile's source. The alternative — one
  endpoint returning everything — would mean one slow query blocking the whole page and
  one permission decision covering tiles that need twelve. Tiles load independently and
  fail independently: a tile whose source was deleted says so and the rest still draw.

  WHY THE TILES ARE READ-ONLY FOR NON-OWNERS. Only the author can move, add or remove
  tiles; a shared dashboard someone else arranged should not rearrange itself under them.
  Reading is wider than writing, which is the same rule the handler enforces.
*/

const GRID_COLS = 12
const ROW_H = 76          // px per grid row, matching the schema's h <= 24
const GRID_GAP = 12

interface Tile {
  id: number
  title: string
  viz: 'kpi' | 'bar' | 'line' | 'area' | 'donut' | 'table'
  config: Record<string, any> | null
  grid_x: number
  grid_y: number
  grid_w: number
  grid_h: number
  source_kind: 'report' | 'sql'
  source_name: string
  readable: boolean
  reason?: string
  dataset?: string
}

interface Board {
  id: number
  name: string
  description: string
  is_shared: boolean
  is_mine: boolean
  created_by_name: string | null
  tiles: Tile[]
}

interface TileData {
  columns: string[]
  rows: Record<string, unknown>[]
  row_count: number
  truncated: boolean
}

interface SourceList {
  reports: { id: number; name: string; description: string; dataset: string }[]
  queries: { id: number; name: string; description: string }[]
}

/** The first column whose values are numbers — the thing a chart can plot. */
function firstNumeric(cols: string[], rows: Record<string, unknown>[]): string | undefined {
  return cols.find(c => {
    const k = kindOf(c)
    if (k === 'kobo' || k === 'money' || k === 'pct' || k === 'bps' || k === 'int') return true
    return rows.some(r => typeof r[c] === 'number')
  })
}

/** The first column that reads as a label — what a chart puts on its axis. */
function firstLabel(cols: string[], rows: Record<string, unknown>[]): string | undefined {
  const numeric = firstNumeric(cols, rows)
  return cols.find(c => c !== numeric && (kindOf(c) === 'text' || kindOf(c) === 'date'))
    ?? cols.find(c => c !== numeric)
}

// ── One tile ──────────────────────────────────────────────────────────────────

function TileBody({ tile }: { tile: Tile }) {
  const [data, setData] = useState<TileData | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setErr(null)
    apiFetch(`/api/dashboards/tiles/${tile.id}/data`)
      .then(res => setData(unwrap<TileData>(res)))
      .catch(e => setErr(e?.message || 'This tile could not be loaded'))
  }, [tile.id])

  useEffect(() => { if (tile.readable) load() }, [tile.readable, load])

  // A tile the reader may not see says WHY. A blank tile reads as a broken tile, and the
  // reason is the difference between "this is not for you" and "this is faulty".
  if (!tile.readable) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', gap: SP[2], padding: SP[4], textAlign: 'center',
      }}>
        <span className="material-symbols-rounded" aria-hidden="true"
          style={{ fontSize: 20, color: 'var(--txt3)' }}>lock</span>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5, maxWidth: 240 }}>
          {tile.reason || 'You do not have access to this tile’s source'}
        </div>
      </div>
    )
  }

  if (err) {
    return (
      <div style={{ padding: SP[3] }}>
        <ErrBanner error={err} onRetry={load} />
      </div>
    )
  }
  if (!data) return <div style={{ padding: SP[4] }}><Sk h={60} /></div>
  if (!data.rows.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>No rows in this period</div>
      </div>
    )
  }

  const cfg = tile.config ?? {}
  const valueKey: string = cfg.value || firstNumeric(data.columns, data.rows) || data.columns[0]
  const labelKey: string = cfg.label || firstLabel(data.columns, data.rows) || data.columns[0]

  if (tile.viz === 'kpi') {
    // The first row's value. A KPI tile over a multi-row source shows the first row and
    // says so, rather than silently summing rows whose meaning it cannot know — summing
    // a column of percentages or averages would invent a number.
    const v = data.rows[0][valueKey]
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        height: '100%', padding: `0 ${SP[5]}px`,
      }}>
        <div style={{
          fontSize: 30, fontWeight: FW.semibold, color: 'var(--txt)',
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', lineHeight: 1.1,
        }}>
          {fmtValue(valueKey, v)}
        </div>
        <div style={{ marginTop: SP[2], fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          {labelFor(valueKey)}
          {data.row_count > 1 && <> · first of {data.row_count.toLocaleString('en-NG')} rows</>}
        </div>
      </div>
    )
  }

  if (tile.viz === 'table') {
    const cols: TableCol<Record<string, unknown>>[] = data.columns.map(c => ({
      key: c, label: labelFor(c), align: alignFor(c), sortable: true,
      render: (r: Record<string, unknown>) => fmtValue(c, r[c]),
    }))
    return (
      <div style={{ padding: SP[2], height: '100%', overflow: 'auto' }}>
        <DataTable cols={cols} rows={data.rows} />
      </div>
    )
  }

  // Charts. The row cap is 500 server-side; a chart is cut further because 500 bars is a
  // smear, not a visual, and the source is one click away for the full result.
  const rows = data.rows.slice(0, tile.viz === 'donut' ? 8 : 40)
  const chartH = Math.max(80, tile.grid_h * ROW_H - 86)
  const fmt = (v: number) => fmtValue(valueKey, v)

  if (tile.viz === 'donut') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <EDonut
          data={rows} valueKey={valueKey} nameKey={labelKey}
          colorFn={(_r, i) => CHART_SERIES[i % CHART_SERIES.length]}
          size={Math.min(chartH + 40, 190)} legend valueFmt={fmt}
        />
      </div>
    )
  }

  const series = [{ key: valueKey, name: labelFor(valueKey), color: CHART_SERIES[0] }]
  const common = { data: rows, xKey: labelKey, series, height: chartH, valueFmt: fmt, legend: false }
  if (tile.viz === 'bar') return <div style={{ padding: SP[2] }}><EBar {...common} /></div>
  if (tile.viz === 'area') return <div style={{ padding: SP[2] }}><EArea {...common} /></div>
  return <div style={{ padding: SP[2] }}><ELine {...common} /></div>
}

// ── The board ─────────────────────────────────────────────────────────────────

export default function DashboardView() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [board, setBoard] = useState<Board | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [sources, setSources] = useState<SourceList | null>(null)
  const [removing, setRemoving] = useState<Tile | null>(null)
  const [renaming, setRenaming] = useState<Tile | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const gridRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    apiFetch(`/api/dashboards/${id}`)
      .then(res => setBoard(unwrap<Board>(res)))
      .catch(e => setErr(e?.message || 'Could not load this dashboard'))
  }, [id])
  useEffect(() => { load() }, [load])

  const rowCount = useMemo(
    () => Math.max(4, ...(board?.tiles ?? []).map(t => t.grid_y + t.grid_h)),
    [board],
  )

  // ── Drag and resize ─────────────────────────────────────────────────────────
  // Pointer events rather than HTML5 drag-and-drop: the latter cannot give a live
  // preview without a drag image, and a tile that jumps on drop feels broken.
  const dragRef = useRef<{
    tileId: number; mode: 'move' | 'resize'
    startX: number; startY: number
    origin: { x: number; y: number; w: number; h: number }
  } | null>(null)

  function cellSize() {
    const w = gridRef.current?.clientWidth ?? 1200
    return { cw: (w - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS + GRID_GAP, ch: ROW_H + GRID_GAP }
  }

  function onPointerDown(e: React.PointerEvent, t: Tile, mode: 'move' | 'resize') {
    if (!editing || !board?.is_mine) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      tileId: t.id, mode, startX: e.clientX, startY: e.clientY,
      origin: { x: t.grid_x, y: t.grid_y, w: t.grid_w, h: t.grid_h },
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d || !board) return
    const { cw, ch } = cellSize()
    const dx = Math.round((e.clientX - d.startX) / cw)
    const dy = Math.round((e.clientY - d.startY) / ch)
    setBoard(b => {
      if (!b) return b
      return {
        ...b,
        tiles: b.tiles.map(t => {
          if (t.id !== d.tileId) return t
          if (d.mode === 'move') {
            // Clamped so a tile cannot be dragged off the grid — the same rule as the
            // CHECK constraint, applied while the pointer moves so the tile simply
            // stops rather than snapping back on release.
            const w = t.grid_w
            return {
              ...t,
              grid_x: Math.min(Math.max(0, d.origin.x + dx), GRID_COLS - w),
              grid_y: Math.max(0, d.origin.y + dy),
            }
          }
          return {
            ...t,
            grid_w: Math.min(Math.max(1, d.origin.w + dx), GRID_COLS - t.grid_x),
            grid_h: Math.min(Math.max(1, d.origin.h + dy), 24),
          }
        }),
      }
    })
  }

  async function onPointerUp() {
    const d = dragRef.current
    dragRef.current = null
    if (!d || !board) return
    try {
      await apiPut(`/api/dashboards/${id}/layout`, {
        tiles: board.tiles.map(t => ({
          id: t.id, grid_x: t.grid_x, grid_y: t.grid_y, grid_w: t.grid_w, grid_h: t.grid_h,
        })),
      })
    } catch (e: any) {
      toast.error(e?.message || 'Could not save the layout')
      load()  // Snap back to what the server has, rather than showing a lie.
    }
  }

  // ── Tiles ───────────────────────────────────────────────────────────────────

  function openAdd() {
    setAdding(true)
    if (!sources) {
      apiFetch('/api/dashboards/sources')
        .then(res => setSources(unwrap<SourceList>(res)))
        .catch(() => toast.error('Could not load your saved reports and queries'))
    }
  }

  async function addTile(kind: 'report' | 'sql', srcId: number, viz: Tile['viz']) {
    // Dropped at the bottom, full width of a half-grid: a new tile should be visible
    // without hunting for it, and not on top of something else.
    const y = Math.max(0, ...(board?.tiles ?? []).map(t => t.grid_y + t.grid_h))
    try {
      await apiPost(`/api/dashboards/${id}/tiles`, {
        viz,
        source_report_id: kind === 'report' ? srcId : undefined,
        source_sql_id: kind === 'sql' ? srcId : undefined,
        grid_x: 0, grid_y: y, grid_w: viz === 'kpi' ? 3 : 6, grid_h: viz === 'kpi' ? 2 : 4,
      })
      setAdding(false)
      load()
    } catch (e: any) {
      toast.error(e?.message || 'Could not add the tile')
    }
  }

  async function removeTile() {
    if (!removing) return
    try {
      await apiDelete(`/api/dashboards/tiles/${removing.id}`)
      setRemoving(null)
      load()
    } catch (e: any) {
      toast.error(e?.message || 'Could not remove the tile')
    }
  }

  async function saveTitle() {
    if (!renaming) return
    try {
      await apiPut(`/api/dashboards/tiles/${renaming.id}`, { title: newTitle })
      setRenaming(null)
      load()
    } catch (e: any) {
      toast.error(e?.message || 'Could not rename the tile')
    }
  }

  async function setViz(t: Tile, viz: Tile['viz']) {
    try {
      await apiPut(`/api/dashboards/tiles/${t.id}`, { viz })
      load()
    } catch (e: any) {
      toast.error(e?.message || 'Could not change the visual')
    }
  }

  if (err) return <Page title="Dashboard"><ErrBanner error={err} onRetry={load} /></Page>
  if (!board) {
    return <Page title="Dashboard"><Sk h={240} /></Page>
  }

  return (
    <Page
      title={board.name}
      subtitle={board.description || undefined}
      back={{ label: 'Dashboards', to: '/reports/dashboards' }}
      actions={
        <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }} className="dash-actions">
          {board.is_shared && <Badge variant="info">Shared</Badge>}
          {/* Print is the PDF route: the browser's own dialog writes a better PDF than a
              server-side renderer would, it needs no new dependency, and what you see is
              what you get. The print stylesheet below is what makes it page-shaped. */}
          <Button variant="secondary" icon="print" onClick={() => window.print()}>Export PDF</Button>
          {board.is_mine && (
            <>
              <Button variant={editing ? 'primary' : 'secondary'}
                icon={editing ? 'check' : 'open_with'}
                onClick={() => setEditing(e => !e)}>
                {editing ? 'Done' : 'Arrange'}
              </Button>
              <Button icon="add" onClick={openAdd}>Add Tile</Button>
            </>
          )}
        </div>
      }
    >
      <style>{`
        @media print {
          /* Only the board prints: no chrome, no controls, no page furniture. */
          nav, aside, header button, .dash-actions { display: none !important; }
          .dash-grid { gap: 10px !important; }
          .dash-tile { break-inside: avoid; box-shadow: none !important; }
          @page { size: A4 landscape; margin: 12mm; }
        }
      `}</style>

      {board.tiles.length === 0 ? (
        <EmptyState
          icon="dashboard_customize"
          title="This Dashboard Has No Tiles"
          description="Add a tile from a report you saved in the Report Builder, or a query you saved in the SQL Console. The tile shows that source. It does not copy it, so the figures stay in step."
          action={board.is_mine ? { label: 'Add Tile', icon: 'add', onClick: openAdd } : undefined}
        />
      ) : (
        <div
          ref={gridRef}
          className="dash-grid"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
            gridAutoRows: `${ROW_H}px`,
            gap: GRID_GAP,
            // Reserve the rows the tiles occupy so a tall tile does not collapse the grid.
            minHeight: rowCount * (ROW_H + GRID_GAP),
            touchAction: editing ? 'none' : undefined,
          }}
        >
          {board.tiles.map(t => (
            <div
              key={t.id}
              className="dash-tile"
              style={{
                gridColumn: `${t.grid_x + 1} / span ${t.grid_w}`,
                gridRow: `${t.grid_y + 1} / span ${t.grid_h}`,
                position: 'relative', minWidth: 0,
              }}
            >
              <SectionCard
                padding={false}
                style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              >
                <div
                  onPointerDown={e => onPointerDown(e, t, 'move')}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: SP[2], padding: `${SP[2]}px ${SP[3]}px`,
                    borderBottom: '1px solid var(--bdr)',
                    cursor: editing && board.is_mine ? 'grab' : 'default',
                    background: editing && board.is_mine ? 'rgba(14,40,65,0.03)' : undefined,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {t.title}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                      {t.source_kind === 'sql' ? 'Saved Query' : t.dataset || 'Saved Report'}
                    </div>
                  </div>
                  {editing && board.is_mine && (
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                      {(['kpi', 'bar', 'line', 'area', 'donut', 'table'] as const).map(v => (
                        <button
                          key={v}
                          onClick={() => setViz(t, v)}
                          title={v}
                          aria-label={`Show as ${v}`}
                          style={{
                            width: 22, height: 22, borderRadius: 5, cursor: 'pointer',
                            border: `1px solid ${t.viz === v ? NAVY : 'var(--bdr)'}`,
                            background: t.viz === v ? 'rgba(14,40,65,0.07)' : 'var(--card)',
                            display: 'grid', placeItems: 'center',
                          }}
                        >
                          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>
                            {v === 'kpi' ? 'numbers' : v === 'bar' ? 'bar_chart'
                              : v === 'line' ? 'show_chart' : v === 'area' ? 'area_chart'
                              : v === 'donut' ? 'donut_small' : 'table_rows'}
                          </span>
                        </button>
                      ))}
                      <button onClick={() => { setRenaming(t); setNewTitle(t.title) }} title="Rename"
                        aria-label="Rename tile"
                        style={{ width: 22, height: 22, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', display: 'grid', placeItems: 'center' }}>
                        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>edit</span>
                      </button>
                      <button onClick={() => setRemoving(t)} title="Remove" aria-label="Remove tile"
                        style={{ width: 22, height: 22, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', display: 'grid', placeItems: 'center' }}>
                        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>close</span>
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  <TileBody tile={t} />
                </div>

                {editing && board.is_mine && (
                  <div
                    onPointerDown={e => onPointerDown(e, t, 'resize')}
                    aria-hidden="true"
                    style={{
                      position: 'absolute', right: 2, bottom: 2, width: 16, height: 16,
                      cursor: 'nwse-resize', display: 'grid', placeItems: 'center',
                      color: 'var(--txt3)',
                    }}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>drag_handle</span>
                  </div>
                )}
              </SectionCard>
            </div>
          ))}
        </div>
      )}

      {/* ── Add a tile ── */}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a Tile" width={640}>
        {!sources ? <Sk h={120} /> : (
          <div style={{ display: 'grid', gap: SP[5] }}>
            <AddFrom
              heading="From a Saved Report"
              note="Built in the Report Builder. The tile follows the report, so a change there shows here."
              items={sources.reports.map(r => ({ id: r.id, name: r.name, sub: r.dataset }))}
              empty="You have no saved reports yet. Build one in the Report Builder and save it."
              onPick={(sid, viz) => addTile('report', sid, viz)}
            />
            <AddFrom
              heading="From a Saved Query"
              note="Saved in the SQL Console. Only the BI team can read these, whoever the dashboard is shared with."
              items={sources.queries.map(q => ({ id: q.id, name: q.name, sub: q.description }))}
              empty="No saved queries are available to you."
              onPick={(sid, viz) => addTile('sql', sid, viz)}
            />
          </div>
        )}
      </Modal>

      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="Rename Tile"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button onClick={saveTitle}>Save</Button>
          </>
        }>
        <Input label="Title" value={newTitle} onChange={e => setNewTitle(e.target.value)}
          hint="Leave it empty to use the source's own name, so a renamed report renames this tile too."
          autoFocus />
      </Modal>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Remove This Tile?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={removeTile}>Remove</Button>
          </>
        }>
        <p style={{ fontSize: TEXT.sm, lineHeight: 1.6 }}>
          <strong>{removing?.title}</strong> comes off this dashboard. The report or query it
          reads is not touched.
        </p>
      </Modal>
    </Page>
  )
}

// ── Add-tile source picker ────────────────────────────────────────────────────

function AddFrom({ heading, note, items, empty, onPick }: {
  heading: string
  note: string
  items: { id: number; name: string; sub?: string }[]
  empty: string
  onPick: (id: number, viz: Tile['viz']) => void
}) {
  const [picked, setPicked] = useState<number | null>(null)
  return (
    <div>
      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, marginBottom: 2 }}>{heading}</div>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: SP[3], lineHeight: 1.5 }}>{note}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontStyle: 'italic' }}>{empty}</div>
      ) : (
        <div style={{ display: 'grid', gap: SP[2] }}>
          {items.map(it => (
            <div key={it.id} style={{
              border: `1px solid ${picked === it.id ? NAVY : 'var(--bdr)'}`,
              borderRadius: 8, padding: SP[3],
            }}>
              <button
                onClick={() => setPicked(p => (p === it.id ? null : it.id))}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  background: 'transparent', border: 'none', padding: 0,
                }}
              >
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium }}>{it.name}</div>
                {it.sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{it.sub}</div>}
              </button>
              {picked === it.id && (
                <div style={{ display: 'flex', gap: SP[2], marginTop: SP[3], flexWrap: 'wrap' }}>
                  {(['kpi', 'bar', 'line', 'area', 'donut', 'table'] as const).map(v => (
                    <Button key={v} size="sm" variant="secondary" onClick={() => onPick(it.id, v)}>
                      {v === 'kpi' ? 'KPI' : v[0].toUpperCase() + v.slice(1)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
