import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveData } from '../../hooks/useRealtime'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { Page, SectionCard, Tabs, DataTable, KpiCard, ErrBanner, Spinner, Modal, ExpandableFilterBar, NameCell } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

interface DueRow {
  cif: string
  customer_name: string | null
  reference: string
  source: 'card' | 'loan'
  origin: string              // CCS | Udara | Uploaded
  product_name: string | null
  outstanding_kobo: number
  due_date: string            // YYYY-MM-DD
  days_until: number
  weekday: string
}

const ORIGIN_META: Record<string, { color: string; title: string }> = {
  CCS:      { color: BLUE,  title: 'From the CCS card system' },
  Udara:    { color: GREEN, title: 'From the Udara core banking system' },
  Uploaded: { color: AMBER, title: 'Uploaded from a spreadsheet' },
}
function OriginChip({ origin }: { origin: string }) {
  const m = ORIGIN_META[origin] ?? { color: NAVY, title: origin }
  return (
    <span title={m.title} style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 7px', borderRadius: RADIUS['2xl'], background: `${m.color}18`, color: m.color, whiteSpace: 'nowrap' }}>
      {origin || '—'}
    </span>
  )
}
function ProductChip({ source }: { source: string }) {
  const isCard = source === 'card'
  const color = isCard ? PURPLE : NAVY
  return (
    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.sm, background: `${color}14`, color, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
      {isCard ? 'Card' : 'Loan'}
    </span>
  )
}

// ── date helpers (local, TZ-safe) ──────────────────────────────────────────
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function ymd(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function weekSunday(offset: number) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay() + offset * 7); return d }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function firstOfMonth(offset: number) { const d = new Date(); d.setHours(0, 0, 0, 0); return new Date(d.getFullYear(), d.getMonth() + offset, 1) }
function prettyRange(sun: Date) {
  const sat = addDays(sun, 6)
  const m = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${m(sun)} – ${m(sat)}, ${sat.getFullYear()}`
}
// Build the 5–6 week grid (starts on the Sunday on/before the 1st) that renders a month.
function buildMonthCells(first: Date): Date[] {
  const start = addDays(first, -first.getDay())
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const totalCells = Math.ceil((first.getDay() + daysInMonth) / 7) * 7
  return Array.from({ length: totalCells }, (_, i) => addDays(start, i))
}

// ── heatmap ─────────────────────────────────────────────────────────────────
// Colour each day by its outstanding amount, relative to the busiest day in view.
// 5-step navy ramp (GitHub-style); the darkest two steps flip text to white.
const NAVY_RGB = '14,40,65'
const HEAT_ALPHA = [0.09, 0.20, 0.36, 0.56, 0.80]
function heatLevel(ratio: number): number {
  if (ratio <= 0) return -1
  return ratio < 0.2 ? 0 : ratio < 0.4 ? 1 : ratio < 0.65 ? 2 : ratio < 0.85 ? 3 : 4
}
function heatBg(level: number) { return level < 0 ? 'var(--card)' : `rgba(${NAVY_RGB},${HEAT_ALPHA[level]})` }
function heatStrong(level: number) { return level >= 3 }

// Filter a row-set by the shared Source/Product chips + search.
function useFacilityFilter(rows: DueRow[], fSource: Set<string>, fProduct: Set<string>, q: string) {
  return useMemo(() => rows.filter(r => {
    if (fSource.size && !fSource.has((r.origin || '').toLowerCase())) return false
    if (fProduct.size && !fProduct.has(r.source === 'card' ? 'cards' : 'loans')) return false
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      if (!(`${r.customer_name ?? ''} ${r.cif} ${r.reference}`.toLowerCase().includes(s))) return false
    }
    return true
  }), [rows, fSource, fProduct, q])
}

function facilityCols(navigate: (p: string) => void, mode: 'day' | 'overdue'): TableCol<DueRow>[] {
  const timing: TableCol<DueRow> = mode === 'overdue'
    ? {
        key: 'days_until', label: 'Days Overdue', align: 'right', sortable: true,
        render: r => { const d = -r.days_until; const color = d > 90 ? RED : d > 30 ? AMBER : '#EA580C'; return <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color }}>{fmtNum(d)}d</span> },
      }
    : {
        key: 'due_date', label: 'Due', align: 'right', sortable: true,
        render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.due_date)}</span>,
      }
  return [
    {
      key: 'customer_name', label: 'Account / CIF', sortable: true,
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ProductChip source={r.source} />
          <NameCell name={r.customer_name || r.cif} sub={`${r.cif} · ${r.reference}`} />
        </div>
      ),
    },
    { key: 'origin', label: 'Source', sortable: true, render: r => <OriginChip origin={r.origin} /> },
    { key: 'product_name', label: 'Product', sortable: true, render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.product_name || '—'}</span> },
    timing,
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    {
      key: 'reference', label: '', sortable: false,
      render: r => (
        <button onClick={e => { e.stopPropagation(); navigate(`/collections/accounts/${r.cif}`) }}
          style={{ padding: '3px 9px', borderRadius: RADIUS.sm, cursor: 'pointer', border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, whiteSpace: 'nowrap' }}>
          Open
        </button>
      ),
    },
  ]
}

const SOURCE_OPTS = [
  { value: 'ccs',      label: 'CCS (cards)',   color: BLUE },
  { value: 'udara',    label: 'Udara (loans)', color: GREEN },
  { value: 'uploaded', label: 'Uploaded',      color: AMBER },
]
const PRODUCT_OPTS = [
  { value: 'cards', label: 'Cards', color: PURPLE },
  { value: 'loans', label: 'Loans', color: NAVY },
]

export default function CollectionsDueSchedule() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'week' | 'overdue'>('week')

  // ── Calendar (week / month) ──
  const [calMode, setCalMode] = useState<'week' | 'month'>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const sunday = useMemo(() => weekSunday(weekOffset), [weekOffset])
  const monthAnchor = useMemo(() => firstOfMonth(monthOffset), [monthOffset])
  const monthCells = useMemo(() => buildMonthCells(monthAnchor), [monthAnchor])
  const range = useMemo(() => {
    if (calMode === 'week') return { from: ymd(sunday), to: ymd(addDays(sunday, 6)) }
    return { from: ymd(monthCells[0]), to: ymd(monthCells[monthCells.length - 1]) }
  }, [calMode, sunday, monthCells])

  const [dueRows, setDueRows] = useState<DueRow[] | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Modal (per-day) filters
  const [mSource, setMSource] = useState<Set<string>>(new Set())
  const [mProduct, setMProduct] = useState<Set<string>>(new Set())
  const [mSearch, setMSearch] = useState('')

  // ── Overdue ──
  const [overdue, setOverdue] = useState<DueRow[] | null>(null)
  const [oSource, setOSource] = useState<Set<string>>(new Set())
  const [oProduct, setOProduct] = useState<Set<string>>(new Set())
  const [oSearch, setOSearch] = useState('')
  const oDq = useDebouncedValue(oSearch, 250)

  const loadDue = useCallback(async (silent = false) => {
    if (!silent) setDueRows(null); setError(null)
    try {
      const res = await apiFetch<{ data: DueRow[] }>(`/api/collections/due-schedule?window=week&from=${range.from}&to=${range.to}`)
      setDueRows(res.data ?? [])
    } catch (e: any) { setError(e.message) }
  }, [range])

  const loadOverdue = useCallback(async (silent = false) => {
    if (!silent && overdue === null) setOverdue(null)
    try {
      const res = await apiFetch<{ data: DueRow[] }>('/api/collections/due-schedule?window=overdue')
      setOverdue(res.data ?? [])
    } catch (e: any) { setError(e.message) }
  }, [overdue])

  useEffect(() => { if (tab === 'week') loadDue() }, [tab, loadDue])
  useEffect(() => { if (tab === 'overdue' && overdue === null) loadOverdue() }, [tab, overdue, loadOverdue])
  useLiveData(() => { if (tab === 'week') loadDue(true); else loadOverdue(true) }, { topics: ['collections', 'loans'] })

  // Per-day aggregates for the calendar.
  const byDay = useMemo(() => {
    const m: Record<string, { count: number; kobo: number }> = {}
    for (const r of (dueRows ?? [])) {
      const k = r.due_date
      ;(m[k] ??= { count: 0, kobo: 0 })
      m[k].count += 1
      m[k].kobo += r.outstanding_kobo || 0
    }
    return m
  }, [dueRows])

  // Busiest day in view drives the heatmap scale.
  const maxDayKobo = useMemo(() => Object.values(byDay).reduce((mx, v) => Math.max(mx, v.kobo), 0), [byDay])

  const dayRows = useMemo(() => (dueRows ?? []).filter(r => r.due_date === selectedDay), [dueRows, selectedDay])
  const dayFiltered = useFacilityFilter(dayRows, mSource, mProduct, mSearch)

  const overdueFiltered = useFacilityFilter(overdue ?? [], oSource, oProduct, oDq)

  const dueTotal = (dueRows ?? []).reduce((s, r) => s + (r.outstanding_kobo || 0), 0)
  const overdueTotal = (overdue ?? []).reduce((s, r) => s + (r.outstanding_kobo || 0), 0)

  const todayY = ymd(new Date())
  const openDay = (key: string) => { setSelectedDay(key); setMSource(new Set()); setMProduct(new Set()); setMSearch('') }
  const rangeLabel = calMode === 'week' ? prettyRange(sunday) : monthAnchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const kpiLabel = calMode === 'week' ? (weekOffset === 0 ? 'Due This Week' : 'Due (week shown)') : (monthOffset === 0 ? 'Due This Month' : 'Due (month shown)')

  return (
    <Page title="Repayments Due" subtitle="Loans and credit cards due this week, and everything already overdue — across CCS, Udara and uploaded">
      <ErrBanner error={error} onRetry={() => (tab === 'week' ? loadDue() : loadOverdue())} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label={kpiLabel} value={fmtNum(dueRows?.length ?? 0)} sub={fmtKoboExact(dueTotal)} icon="event_upcoming" accent={NAVY} loading={dueRows === null} />
        <KpiCard label="Overdue" value={fmtNum(overdue?.length ?? 0)} sub={fmtKoboExact(overdueTotal)} icon="running_with_errors" accent={RED} loading={overdue === null} />
      </div>

      <div style={{ marginBottom: SP[3] }}>
        <Tabs tabs={[{ key: 'week', label: 'Due This Week' }, { key: 'overdue', label: 'Overdue' }]} active={tab} onChange={k => setTab(k as 'week' | 'overdue')} />
      </div>

      {tab === 'week' && (
        <SectionCard
          title={calMode === 'week' ? 'This Week' : 'This Month'}
          subtitle="Cells shade darker with the amount due; click a day to see its facilities"
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'inline-flex', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
                {(['week', 'month'] as const).map(m => (
                  <button key={m} onClick={() => setCalMode(m)}
                    style={{
                      padding: '4px 12px', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', border: 'none',
                      textTransform: 'capitalize',
                      background: calMode === m ? NAVY : 'var(--card)', color: calMode === m ? '#fff' : 'var(--txt2)',
                    }}>
                    {m}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => (calMode === 'week' ? setWeekOffset(o => o - 1) : setMonthOffset(o => o - 1))} style={navBtn}><span className="material-symbols-rounded" style={{ fontSize: 18 }}>chevron_left</span></button>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', minWidth: 150, textAlign: 'center' }}>{rangeLabel}</span>
                <button onClick={() => (calMode === 'week' ? setWeekOffset(o => o + 1) : setMonthOffset(o => o + 1))} style={navBtn}><span className="material-symbols-rounded" style={{ fontSize: 18 }}>chevron_right</span></button>
                {((calMode === 'week' && weekOffset !== 0) || (calMode === 'month' && monthOffset !== 0)) && (
                  <button onClick={() => (calMode === 'week' ? setWeekOffset(0) : setMonthOffset(0))} style={{ ...navBtn, width: 'auto', padding: '0 10px', fontSize: TEXT.xs, fontWeight: FW.semibold }}>{calMode === 'week' ? 'This week' : 'This month'}</button>
                )}
              </div>
            </div>
          }
        >
          {dueRows === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>
          ) : calMode === 'week' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: SP[2] }}>
              {Array.from({ length: 7 }, (_, i) => {
                const d = addDays(sunday, i)
                const key = ymd(d)
                const agg = byDay[key] ?? { count: 0, kobo: 0 }
                const isToday = key === todayY
                const has = agg.count > 0
                const lvl = has ? heatLevel(maxDayKobo > 0 ? agg.kobo / maxDayKobo : 0) : -1
                const strong = heatStrong(lvl)
                return (
                  <button
                    key={key}
                    onClick={() => has && openDay(key)}
                    disabled={!has}
                    style={{
                      textAlign: 'left', cursor: has ? 'pointer' : 'default',
                      border: `1px solid ${isToday ? NAVY : 'var(--bdr)'}`, borderRadius: RADIUS.lg,
                      background: has ? heatBg(lvl) : 'var(--card)', padding: '10px 12px',
                      minHeight: 104, display: 'flex', flexDirection: 'column', gap: 4,
                      opacity: has ? 1 : 0.6, transition: 'box-shadow .15s',
                    }}
                    onMouseEnter={e => { if (has) (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 10px rgba(14,40,65,.18)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: strong ? 'rgba(255,255,255,.85)' : isToday ? NAVY : 'var(--txt2)' }}>{DAY_ABBR[i]}</span>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: strong ? '#fff' : isToday ? NAVY : 'var(--txt3)' }}>{d.getDate()}</span>
                    </div>
                    {has ? (
                      <div style={{ marginTop: 'auto' }}>
                        <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: strong ? '#fff' : 'var(--txt)' }}>{fmtNum(agg.count)}</div>
                        <div style={{ fontSize: TEXT.xs, color: strong ? 'rgba(255,255,255,.7)' : 'var(--txt3)' }}>due</div>
                        <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: strong ? '#fff' : NAVY, marginTop: 4 }}>{fmtKoboExact(agg.kobo)}</div>
                      </div>
                    ) : (
                      <span style={{ marginTop: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)' }}>Nothing due</span>
                    )}
                    {isToday && <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: strong ? '#fff' : NAVY }}>TODAY</span>}
                  </button>
                )
              })}
            </div>
          ) : (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: SP[2], marginBottom: 6 }}>
                {DAY_ABBR.map(d => <div key={d} style={{ textAlign: 'center', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{d}</div>)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: SP[2] }}>
                {monthCells.map(d => {
                  const key = ymd(d)
                  const agg = byDay[key] ?? { count: 0, kobo: 0 }
                  const isToday = key === todayY
                  const inMonth = d.getMonth() === monthAnchor.getMonth()
                  const has = agg.count > 0
                  const lvl = has ? heatLevel(maxDayKobo > 0 ? agg.kobo / maxDayKobo : 0) : -1
                  const strong = heatStrong(lvl)
                  return (
                    <button
                      key={key}
                      onClick={() => has && openDay(key)}
                      disabled={!has}
                      style={{
                        textAlign: 'left', cursor: has ? 'pointer' : 'default',
                        border: `1px solid ${isToday ? NAVY : 'var(--bdr)'}`, borderRadius: RADIUS.md,
                        background: has ? heatBg(lvl) : 'var(--card)', padding: '6px 8px',
                        minHeight: 72, display: 'flex', flexDirection: 'column', gap: 2,
                        opacity: inMonth ? (has ? 1 : 0.7) : 0.4, transition: 'box-shadow .15s',
                      }}
                      onMouseEnter={e => { if (has) (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 10px rgba(14,40,65,.18)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color: strong ? '#fff' : isToday ? NAVY : 'var(--txt2)' }}>{d.getDate()}</span>
                        {isToday && <span style={{ fontSize: 7, fontWeight: FW.bold, color: strong ? '#fff' : NAVY, letterSpacing: '0.05em' }}>TODAY</span>}
                      </div>
                      {has && (
                        <div style={{ marginTop: 'auto' }}>
                          <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.extrabold, color: strong ? '#fff' : 'var(--txt)', lineHeight: 1 }}>{fmtNum(agg.count)}</div>
                          <div style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: strong ? 'rgba(255,255,255,.85)' : NAVY, marginTop: 2 }}>{fmtKoboExact(agg.kobo)}</div>
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {dueRows !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: SP[3], justifyContent: 'flex-end' }}>
              <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Less</span>
              {[0, 1, 2, 3, 4].map(l => <span key={l} title={`heat ${l + 1}`} style={{ width: 14, height: 14, borderRadius: 3, background: heatBg(l), border: '1px solid var(--bdr)' }} />)}
              <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>More due</span>
            </div>
          )}
        </SectionCard>
      )}

      {tab === 'overdue' && (
        <SectionCard title="Overdue Facilities" subtitle="Past their due date, most overdue first" badge={overdueFiltered.length} padding={false}>
          <ExpandableFilterBar
            search={oSearch}
            onSearch={setOSearch}
            maxCols={2}
            groups={[
              { key: 'source',  label: 'Source',  options: SOURCE_OPTS,  selected: oSource,  onChange: setOSource },
              { key: 'product', label: 'Product', options: PRODUCT_OPTS, selected: oProduct, onChange: setOProduct },
            ] as FilterGroupDef[]}
            onReset={() => { setOSearch(''); setOSource(new Set()); setOProduct(new Set()) }}
            resultCount={overdueFiltered.length}
            totalCount={overdue?.length ?? 0}
            placeholder="Search CIF, customer or reference…"
          />
          <DataTable
            cols={facilityCols(navigate, 'overdue')}
            rows={overdueFiltered}
            keyFn={r => `${r.source}-${r.reference}`}
            loading={overdue === null}
            skeletonRows={10}
            pageSize={25}
            emptyText="Nothing overdue"
            onRowClick={r => navigate(`/collections/accounts/${r.cif}`)}
          />
        </SectionCard>
      )}

      {/* Per-day table modal */}
      <Modal
        open={selectedDay !== null}
        onClose={() => setSelectedDay(null)}
        title={selectedDay ? `Due ${DAY_FULL[new Date(selectedDay + 'T00:00:00').getDay()]}, ${fmtDate(selectedDay)}` : ''}
        width={920}
        maxHeight="86vh"
      >
        <ExpandableFilterBar
          search={mSearch}
          onSearch={setMSearch}
          maxCols={2}
          groups={[
            { key: 'source',  label: 'Source',  options: SOURCE_OPTS,  selected: mSource,  onChange: setMSource },
            { key: 'product', label: 'Product', options: PRODUCT_OPTS, selected: mProduct, onChange: setMProduct },
          ] as FilterGroupDef[]}
          onReset={() => { setMSearch(''); setMSource(new Set()); setMProduct(new Set()) }}
          resultCount={dayFiltered.length}
          totalCount={dayRows.length}
          placeholder="Search CIF, customer or reference…"
        />
        <DataTable
          cols={facilityCols(navigate, 'day')}
          rows={dayFiltered}
          keyFn={r => `${r.source}-${r.reference}`}
          pageSize={15}
          emptyText="No facilities match"
          onRowClick={r => navigate(`/collections/accounts/${r.cif}`)}
        />
      </Modal>
    </Page>
  )
}

const navBtn: React.CSSProperties = {
  width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', cursor: 'pointer',
}
