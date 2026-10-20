import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, Button, ErrBanner, EmptyState, Input, Modal, Badge, Sk, DataTable,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EBar, ELine, EArea, EDonut, EBarH, EFunnel, ECombo } from '../../components/echarts'
import { CHART_SERIES } from '../../components/charts'
import { apiFetch, apiPost, apiPut, apiDelete, unwrap, unwrapList } from '../../lib/api'
import { labelFor, fmtValue, alignFor } from '../../lib/reportFormat'
import { NAVY, FW, SP, TEXT } from '../../lib/design'
import { TileBuilder, type TileBuilderEdit } from './builder/TileBuilder'
import { VIZ_KINDS, VIZ_META, type VizKind } from './builder/tileViz'
// One renderer for a tile, shared with the builder's live preview. See TileVisual.tsx.
import { TileVisual } from './builder/TileVisual'
import {
  DashboardFilterBar, emptySelection, selectionQuery,
  type DashSelection, type Slicer,
} from './builder/DashboardFilters'
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
  viz: VizKind
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
  // Set only when this tile's report was written by the dashboard for it alone, which is
  // what makes it safe to edit here: a tile on a library report is edited in the Report
  // Builder, where its other tiles and schedules are in view.
  tile_only?: boolean
  report_config?: Record<string, any> | null
}

interface Board {
  id: number
  name: string
  description: string
  is_shared: boolean
  is_mine: boolean
  created_by_name: string | null
  tiles: Tile[]
  /** Which slicers this board offers, and its default period (migration 384). */
  config: { slicers?: string[]; period?: { win?: string; from?: string; to?: string } } | null
  /** Which slicers it COULD offer, computed by the server from its own readable tiles. */
  available_slicers: Slicer[]
}

interface TileData {
  columns: string[]
  rows: Record<string, unknown>[]
  row_count: number
  truncated: boolean
  /** Board filters this tile honoured, and those its dataset could not. */
  applied_filters?: string[] | null
  ignored_filters?: string[] | null
}

interface SourceList {
  reports: { id: number; name: string; description: string; dataset: string }[]
  queries: { id: number; name: string; description: string }[]
}

/** The first column whose values are numbers — the thing a chart can plot. */
// firstNumeric and firstLabel moved to builder/tileViz.ts, where the builder reads them
// too: they are the fallback a tile uses when its config names no columns, so the two
// screens have to agree about what "no choice made" draws.

// ── One tile ──────────────────────────────────────────────────────────────────

function TileBody({ tile, query, selectedKeys }: {
  tile: Tile
  /** The board's filter selection, as a query string. Empty when nothing is selected. */
  query: string
  /** Which slicer keys are selected, so the tile can say if it could not honour one. */
  selectedKeys: string[]
}) {
  const [data, setData] = useState<TileData | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setErr(null)
    apiFetch(`/api/dashboards/tiles/${tile.id}/data${query}`)
      .then(res => setData(unwrap<TileData>(res)))
      .catch(e => setErr(e?.message || 'This tile could not be loaded'))
  }, [tile.id, query])

  useEffect(() => { if (tile.readable) load() }, [tile.readable, load])

  // Which of the board's selected filters this tile could not answer. The server tells
  // us rather than the page guessing: it knows which filters the dataset declares.
  const ignored = (data?.ignored_filters ?? []).filter(k => selectedKeys.includes(k))

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

  return (
    <>
      {/* A TILE THAT COULD NOT ANSWER THE BOARD'S QUESTION SAYS SO. Without this, a
          board filtered to Lagos would show this tile's national figure under a Lagos
          heading, which is the one outcome that actively misleads. */}
      {ignored.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: `2px ${SP[3]}px`, fontSize: 10.5, color: '#8a6a16',
        }} title={`This tile's data source has no ${ignored.join(' or ')} filter`}>
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>
            filter_alt_off
          </span>
          Not filtered by {ignored.join(', ')}
        </div>
      )}
      <TileVisual
        viz={tile.viz} config={tile.config} columns={data.columns} rows={data.rows}
        rowCount={data.row_count} height={Math.max(80, tile.grid_h * ROW_H - 86)}
      />
    </>
  )
}


// ── The board ─────────────────────────────────────────────────────────────────

export default function DashboardView() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [board, setBoard] = useState<Board | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  // null = closed. { edit: null } = building a new tile; { edit } = reopening the builder
  // on a tile whose report this dashboard owns.
  const [building, setBuilding] = useState<{ edit: TileBuilderEdit | null } | null>(null)
  // The board's filter selection. Deliberately NOT persisted: on a shared dashboard a
  // stored selection would let one person reframe a colleague's figures. See
  // builder/DashboardFilters.tsx.
  const [sel, setSel] = useState<DashSelection>(emptySelection)
  const [sources, setSources] = useState<SourceList | null>(null)
  const [removing, setRemoving] = useState<Tile | null>(null)
  const [renaming, setRenaming] = useState<Tile | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailTo, setEmailTo] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailNote, setEmailNote] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
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

  // One query string for every tile, so they all answer the same question and React
  // re-fetches them together when it changes.
  const filterQuery = useMemo(() => selectionQuery(sel), [sel])
  const selectedKeys = useMemo(() => Object.keys(sel.values).filter(k => sel.values[k]), [sel])
  const offered = useMemo(() => board?.config?.slicers ?? [], [board])
  // A period control is only worth showing if some tile actually reads a date.
  const anyDated = useMemo(
    () => (board?.available_slicers ?? []).length > 0 || (board?.tiles ?? []).some(t => t.dataset),
    [board],
  )

  // The board's default period applies on first load, then the viewer owns the selection.
  const defaultsApplied = useRef(false)
  useEffect(() => {
    if (defaultsApplied.current || !board) return
    defaultsApplied.current = true
    const p = board.config?.period
    if (p?.win) setSel(s => ({ ...s, win: p.win!, from: p.from ?? '', to: p.to ?? '' }))
  }, [board])

  async function saveOffered(keys: string[]) {
    if (!board) return
    // Optimistic, because toggling a chip should feel immediate; a failure reloads the
    // board rather than leaving the bar showing something that was not saved.
    setBoard(b => (b ? { ...b, config: { ...(b.config ?? {}), slicers: keys } } : b))
    try {
      await apiPut(`/api/dashboards/${id}`, { config: { ...(board.config ?? {}), slicers: keys } })
    } catch (e: any) {
      toast.error(e?.message || 'Could not save which filters this dashboard offers')
      load()
    }
  }

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

  // Rendering runs a real browser server-side, so this is slow by nature — a few
  // seconds for a board of charts. The button shows a spinner rather than the page
  // pretending something instant happened.
  async function sendDashboard() {
    const to = emailTo.split(',').map(s => s.trim()).filter(Boolean)
    if (!to.length) return
    setEmailBusy(true)
    try {
      const r = unwrap<any>(await apiPost(`/api/dashboards/${id}/email`, {
        recipients: to, subject: emailSubject, message: emailNote,
      }))
      const n = typeof r?.recipients === 'number' ? r.recipients : to.length
      toast.success(`Dashboard emailed to ${n} recipient${n === 1 ? '' : 's'}`)
      setEmailOpen(false)
      setEmailTo(''); setEmailSubject(''); setEmailNote('')
    } catch (e: any) {
      toast.error(e?.message || 'Could not email the dashboard')
    } finally {
      setEmailBusy(false)
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
          {/* Two routes to the same PDF, and they share the print stylesheet below.
              Print opens the browser's own dialog for the person looking at the board.
              Email asks the server to print it headlessly and attach it — the same page,
              the same stylesheet, rendered as the sender so it can never show a
              recipient more than the sender can see. */}
          <Button variant="secondary" icon="print" onClick={() => window.print()}>Export PDF</Button>
          <Button variant="secondary" icon="mail" onClick={() => setEmailOpen(true)}>Email</Button>
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

      {/* One question for the whole board. Hidden when there is nothing to ask and the
          author is not configuring it. */}
      {board.tiles.length > 0 && (
        <div className="dash-actions">
          <DashboardFilterBar
            slicers={board.available_slicers ?? []}
            offered={offered}
            sel={sel}
            onSel={setSel}
            editing={editing && board.is_mine}
            onOfferedChange={saveOffered}
            hasDate={anyDated}
          />
        </div>
      )}

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
                      {/* Driven by VIZ_KINDS so this row cannot fall behind the renderer
                          when a kind is added — the old hardcoded list of six was already
                          three short of what the chart library could draw. */}
                      {VIZ_KINDS.map(v => (
                        <button
                          key={v}
                          onClick={() => setViz(t, v)}
                          title={VIZ_META[v].label}
                          aria-label={`Show as ${VIZ_META[v].label}`}
                          style={{
                            width: 22, height: 22, borderRadius: 5, cursor: 'pointer',
                            border: `1px solid ${t.viz === v ? NAVY : 'var(--bdr)'}`,
                            background: t.viz === v ? 'rgba(14,40,65,0.07)' : 'var(--card)',
                            display: 'grid', placeItems: 'center',
                          }}
                        >
                          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>
                            {VIZ_META[v].icon}
                          </span>
                        </button>
                      ))}
                      {/* Only a tile whose report this dashboard wrote can be reopened in the
                          builder. A tile on a library report deliberately has no such button:
                          editing that report belongs in the Report Builder, where the other
                          tiles and schedules depending on it are visible. */}
                      {t.tile_only && (
                        <button
                          onClick={() => setBuilding({
                            edit: {
                              tileId: t.id, name: t.title, viz: t.viz,
                              dataset: t.dataset ?? '', config: t.report_config ?? {},
                              // The tile's own config: how it draws, as opposed to what
                              // it reads. Reopening the builder restores both.
                              vizConfig: t.config ?? {},
                            },
                          })}
                          title="Edit this tile's data" aria-label="Edit this tile's data"
                          style={{ width: 22, height: 22, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', display: 'grid', placeItems: 'center' }}>
                          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>tune</span>
                        </button>
                      )}
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
                  <TileBody tile={t} query={filterQuery} selectedKeys={selectedKeys} />
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

      {/* ── Build a tile from a data source ── */}
      {building && (
        <TileBuilder
          dashboardId={String(id)}
          nextY={Math.max(0, ...(board.tiles ?? []).map(t => t.grid_y + t.grid_h))}
          editing={building.edit}
          onClose={() => setBuilding(null)}
          onSaved={() => { setBuilding(null); load() }}
        />
      )}

      {/* ── Add a tile ── */}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a Tile" width={640}>
        {!sources ? <Sk h={120} /> : (
          <div style={{ display: 'grid', gap: SP[5] }}>
            {/* BUILD FROM DATA, WITHOUT PUTTING A QUERY ON THE TILE. A tile never carries
                its own SQL — that is what stops a shared dashboard becoming a way to run
                anything under whatever access the dashboard happened to have. Choosing a
                data source here does not break that: the server writes the report and
                points the tile at it, so the tile still holds a foreign key and every
                read is still re-checked against the viewer. See TileBuilder.tsx. */}
            <div style={{
              border: '1px solid var(--bdr)', borderRadius: 8, padding: SP[3],
              display: 'flex', gap: SP[3], alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
                <b style={{ color: 'var(--txt)' }}>Start from a data source.</b> Pick the table,
                choose columns and filters the same way as the Report Builder, and say how the
                tile should draw it.
              </div>
              <div style={{ display: 'flex', gap: SP[2], flexShrink: 0 }}>
                <Button icon="add_chart" onClick={() => { setAdding(false); setBuilding({ edit: null }) }}>
                  Build From Data
                </Button>
              </div>
            </div>
            {/* The two paths differ in what you end up with, so both stay on offer: a tile
                built here belongs to this dashboard, while a report built in the Report
                Builder can be reused on other dashboards, emailed and scheduled. */}
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5, marginTop: -SP[3] }}>
              A tile built here belongs to this dashboard. For something you want to reuse,
              email or put on a schedule,{' '}
              <button type="button" onClick={() => nav('/reports/builder')} style={{
                background: 'none', border: 'none', padding: 0, font: 'inherit',
                color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline',
              }}>build a saved report</button>{' '}instead — it then appears below.
            </div>
            <AddFrom
              heading="From a Saved Report"
              note="Built in the Report Builder. The tile follows the report, so a change there shows here."
              items={sources.reports.map(r => ({ id: r.id, name: r.name, sub: r.dataset }))}
              empty="No saved reports yet. Build one in the Report Builder and save it — it shows up here straight away."
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

      <Modal open={emailOpen} onClose={() => setEmailOpen(false)} title="Email This Dashboard"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEmailOpen(false)}>Cancel</Button>
            <Button loading={emailBusy} disabled={!emailTo.trim()} onClick={sendDashboard}>Send Now</Button>
          </>
        }>
        <p style={{ fontSize: TEXT.sm, lineHeight: 1.6, marginTop: 0 }}>
          The server prints this dashboard and attaches it as a PDF. It renders as{' '}
          <strong>you</strong>, so a recipient sees exactly the tiles you can see — a tile
          whose data you cannot open is not in the file.
        </p>
        <Input label="Recipients" value={emailTo} onChange={e => setEmailTo(e.target.value)}
          hint="Separate several with commas." autoFocus />
        <Input label="Subject (Optional)" value={emailSubject} maxLength={200}
          onChange={e => setEmailSubject(e.target.value)}
          placeholder={`Dashboard: ${board.name}`} />
        <Input label="Note (Optional)" value={emailNote} onChange={e => setEmailNote(e.target.value)}
          hint="Appears above the attachment in the email." />
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
