import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, MONO, SORA } from '../../lib/design'
import { IcoTune } from '../../lib/icons'
import { DateFilter, TblSearch } from '../../components/UI'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortfolioKPIs {
  par30_kobo: number
  par60_kobo: number
  par90_kobo: number
  total_outstanding_kobo: number
  total_accounts: number
  delinquent_accounts: number
  current_rate_pct: number
}

interface PTPane {
  id: number
  account_cif: string
  customer_name: string | null
  outstanding_kobo: number
  promise_amount_kobo: number
  promise_date: string
  status: string
  agent_name: string | null
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtKoboShort(kobo: number): string {
  const n = kobo / 100
  if (n >= 1_000_000_000) return `₦${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000)     return `₦${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)         return `₦${(n / 1_000).toFixed(1)}K`
  return `₦${n.toFixed(0)}`
}

// ── Bucket pill ───────────────────────────────────────────────────────────────

const BUCKET_STYLE: Record<string, { bg: string; color: string }> = {
  Pending: { bg: `${AMBER}22`, color: '#92400E' },
  Kept:    { bg: `${GREEN}1F`, color: '#14532D' },
  Broken:  { bg: `${RED}1A`,   color: RED },
}

function PtpPill({ status }: { status: string }) {
  const s = BUCKET_STYLE[status] ?? { bg: 'rgba(75,85,99,.1)', color: '#6B7280' }
  return (
    <span style={{
      display: 'inline-block', fontSize: 10.5, fontWeight: 700,
      letterSpacing: '.04em', borderRadius: 3, padding: '2px 7px',
      background: s.bg, color: s.color, whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIco({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <span style={{
      color: RED, opacity: active ? 1 : 0.3,
      fontSize: 10, marginLeft: 3, verticalAlign: 'middle',
    }}>
      {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CollectionsOverview() {
  const [heroVal, setHeroVal] = useState(0)
  const [kpis, setKpis]   = useState<PortfolioKPIs | null>(null)
  const [rows, setRows]   = useState<PTPane[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]     = useState<string | null>(null)
  const heroTarget = useRef(0)

  // ── Table state ─────────────────────────────────────────────────────────────
  const [search,      setSearch]      = useState('')
  const [filterOpen,  setFilterOpen]  = useState(false)
  const [statusSel,   setStatusSel]   = useState<Set<string>>(new Set())
  const [dateFrom,    setDateFrom]    = useState('')
  const [dateTo,      setDateTo]      = useState('')
  const [sortKey,     setSortKey]     = useState<string | null>(null)
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('asc')
  const [page,        setPage]        = useState(1)
  const PAGE_SIZE = 25
  const [tooltip, setTooltip]         = useState<{ label: string; val: string; pct: string; x: number; y: number } | null>(null)

  // ── Load ─────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [kpiRes, promRes] = await Promise.all([
        apiFetch<{ data: PortfolioKPIs }>('/api/collections/portfolio-kpis'),
        apiFetch<{ data: PTPane[] }>('/api/collections-ops/promises?limit=200'),
      ])
      setKpis(kpiRes.data)
      setRows(promRes.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load collections data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ── Animate hero counter ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!kpis) return
    const target = kpis.total_outstanding_kobo
    heroTarget.current = target
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) { setHeroVal(target); return }
    const dur = 900; const t0 = performance.now(); let raf: number
    function tick(now: number) {
      const p    = Math.min((now - t0) / dur, 1)
      const ease = 1 - Math.pow(1 - p, 3)
      setHeroVal(Math.round(target * ease))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [kpis])

  // ── Derived metrics ───────────────────────────────────────────────────────────

  const today    = todayISO()
  const total    = kpis?.total_outstanding_kobo ?? 1
  const par30Pct = kpis ? ((kpis.par30_kobo / total) * 100).toFixed(1) : '—'
  const ptpToday = rows.filter(r => r.promise_date === today).length
  const kept     = rows.filter(r => r.status === 'Kept').length
  const keptRate = rows.length > 0 ? ((kept / rows.length) * 100).toFixed(1) : '—'
  const collectedMTD = rows
    .filter(r => r.status === 'Kept')
    .reduce((s, r) => s + r.promise_amount_kobo, 0)

  // PAR bar widths (guard against zero total)
  const currentPct = kpis ? Math.round(kpis.current_rate_pct) : 0
  const par30W     = kpis ? Math.round((kpis.par30_kobo / total) * 100) : 0
  const par60W     = kpis ? Math.round((kpis.par60_kobo / total) * 100) : 0
  const par90W     = kpis ? Math.max(0, 100 - currentPct - par30W - par60W) : 0

  // ── Filter / sort pipeline ───────────────────────────────────────────────────

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function toggleStatus(v: string) {
    setStatusSel(prev => {
      const next = new Set(prev); next.has(v) ? next.delete(v) : next.add(v)
      return next
    })
  }

  function resetFilters() {
    setSearch(''); setStatusSel(new Set()); setDateFrom(''); setDateTo('')
  }

  const activeCount = statusSel.size + (dateFrom || dateTo ? 1 : 0)

  // Reset page on filter change
  useEffect(() => { setPage(1) }, [search, statusSel, dateFrom, dateTo, sortKey, sortDir])

  const filtered = (() => {
    let r = [...rows]
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(x =>
        (x.account_cif   ?? '').toLowerCase().includes(q) ||
        (x.customer_name ?? '').toLowerCase().includes(q) ||
        (x.agent_name    ?? '').toLowerCase().includes(q)
      )
    }
    if (statusSel.size) r = r.filter(x => statusSel.has(x.status))
    if (dateFrom)       r = r.filter(x => x.promise_date >= dateFrom)
    if (dateTo)         r = r.filter(x => x.promise_date <= dateTo)
    if (sortKey) r.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sortKey] ?? ''
      const vb = (b as unknown as Record<string, unknown>)[sortKey] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return r
  })()

  // Active chips
  type Chip = { key: string; label: string; clear: () => void }
  const chips: Chip[] = [
    ...[...statusSel].map(v => ({ key: `st:${v}`, label: v, clear: () => toggleStatus(v) })),
    ...((dateFrom || dateTo) ? [{
      key: 'date',
      label: dateFrom === dateTo && dateFrom
        ? fmtDate(dateFrom)
        : `${dateFrom ? fmtDate(dateFrom) : '…'} – ${dateTo ? fmtDate(dateTo) : '…'}`,
      clear: () => { setDateFrom(''); setDateTo('') },
    }] : []),
  ]

  const statusCounts = (s: string) => rows.filter(r => r.status === s).length

  // Derive available statuses from actual data
  const availableStatuses = useMemo(() => {
    const seen = new Set(rows.map(r => r.status))
    return ['Pending', 'Kept', 'Broken'].filter(s => seen.has(s) || statusSel.has(s))
  }, [rows, statusSel])

  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)

  // ── Inline styles for shared elements ────────────────────────────────────────

  const S = {
    scroll: { flex: 1, overflowY: 'auto' as const, minHeight: 0 },

    hero: {
      display: 'flex', alignItems: 'flex-end', gap: 56, flexWrap: 'wrap' as const,
      padding: '26px 28px 24px', borderBottom: '1px solid var(--bdr)',
    },
    heroLabel: {
      fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em',
      textTransform: 'uppercase' as const, color: 'var(--txt3)', marginBottom: 8,
      fontFamily: MONO,
    },
    heroFigure: {
      fontFamily: MONO, fontWeight: 600, fontSize: 46,
      lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' as const,
      color: 'var(--txt)',
    },
    heroDelta: { fontSize: 12, color: RED, fontWeight: 600, marginTop: 8 },
    heroSecondary: { display: 'flex', gap: 40, paddingBottom: 4, flexWrap: 'wrap' as const },

    mLabel: {
      fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase' as const,
      color: 'var(--txt3)', fontWeight: 600, marginBottom: 5, fontFamily: MONO,
    },
    mValue: {
      fontFamily: MONO, fontSize: 19, fontWeight: 600,
      fontVariantNumeric: 'tabular-nums' as const, color: 'var(--txt)',
    },
    mSub: { fontSize: 11, color: 'var(--txt2)', marginTop: 3 },

    parSection: { padding: '20px 28px 22px', borderBottom: '1px solid var(--bdr)' },
    secHead: { display: 'flex', alignItems: 'baseline' as const, gap: 12, marginBottom: 14 },
    secTitle: { fontSize: 13, fontWeight: 600, color: 'var(--txt)' },
    secNote: { fontSize: 11, color: 'var(--txt3)' },
    parBar: { display: 'flex', height: 34, borderRadius: 3, overflow: 'hidden' },
    parLegend: { display: 'flex', gap: 28, marginTop: 12, flexWrap: 'wrap' as const },

    tblBar: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '12px 18px', borderBottom: '1px solid var(--bdr)',
      flexWrap: 'wrap' as const, fontFamily: SORA,
    },
    tblTitle: { fontSize: 14, fontWeight: 600, color: 'var(--txt)', marginRight: 4, whiteSpace: 'nowrap' as const },

    fltBtn: (active: boolean) => ({
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
      border: `1.5px solid ${active ? RED : 'var(--bdr)'}`,
      background: 'transparent',
      color: active ? RED : 'var(--txt2)',
      cursor: 'pointer', fontFamily: SORA, whiteSpace: 'nowrap' as const,
      position: 'relative' as const,
    }),
    fltPip: {
      position: 'absolute' as const, top: -6, right: -6,
      width: 16, height: 16, borderRadius: '50%',
      background: RED, color: '#fff', fontSize: 9,
      fontWeight: 700, fontFamily: MONO,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    tblCountR: {
      marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)',
      fontFamily: MONO, whiteSpace: 'nowrap' as const,
    },

    fltPanel: { borderBottom: '1px solid var(--bdr)' },
    fltGrid: { display: 'grid', gridTemplateColumns: '1fr', padding: '20px 20px 0' },
    fltColTitle: {
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
      letterSpacing: '.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: MONO,
    },
    fltRow: {
      display: 'flex', alignItems: 'center', gap: 9,
      marginBottom: 9, cursor: 'pointer',
    } as React.CSSProperties,
    fLabel: { fontSize: 12, color: 'var(--txt)' },
    fCount: { marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: MONO },
    fltFoot: {
      padding: '14px 20px', borderTop: '1px solid var(--bdr)',
      marginTop: 16, display: 'flex', alignItems: 'center', gap: 12,
    },
    fltStatus: { fontSize: 12, color: 'var(--txt3)' },
    fltReset: {
      padding: '5px 12px', borderRadius: 7,
      border: '1.5px solid var(--bdr)', background: 'transparent',
      color: 'var(--txt2)', fontSize: 12, fontWeight: 600,
      cursor: 'pointer', fontFamily: SORA,
    } as React.CSSProperties,
    fltDone: {
      padding: '5px 16px', borderRadius: 7, border: 'none',
      background: RED, color: '#fff', fontSize: 12, fontWeight: 600,
      cursor: 'pointer', marginLeft: 'auto', fontFamily: SORA,
    } as React.CSSProperties,

    chipsBar: {
      padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const,
    },
    aChip: {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600,
      background: `${NAVY}18`, color: NAVY,
    } as React.CSSProperties,
    chipX: { cursor: 'pointer', fontSize: 11, lineHeight: 1, marginLeft: 2 },
    clearAll: {
      border: 'none', background: 'none', cursor: 'pointer',
      fontSize: 11.5, fontWeight: 600, color: 'var(--txt3)',
      padding: 0, fontFamily: SORA,
    } as React.CSSProperties,

    thead: {
      position: 'sticky' as const, top: 0, background: 'var(--bg)',
      fontSize: 10, fontWeight: 600, letterSpacing: '.1em',
      textTransform: 'uppercase' as const, color: 'var(--txt3)',
      textAlign: 'left' as const, padding: '8px 14px',
      borderTop: '1px solid var(--bdr)', borderBottom: '1px solid var(--bdr)',
      zIndex: 2, whiteSpace: 'nowrap' as const, cursor: 'pointer',
    },
    theadNs: { cursor: 'default' },
    td: {
      padding: '0 14px', height: 38, borderBottom: '1px solid var(--bdr)',
      fontSize: 12.5, whiteSpace: 'nowrap' as const,
    },
  }

  // ── Error / skeleton ─────────────────────────────────────────────────────────

  if (err) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontFamily: SORA }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: RED, marginBottom: 8 }}>{err}</div>
          <button onClick={load} style={{ fontFamily: SORA, fontSize: 12, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  // ── PAR bar segments ─────────────────────────────────────────────────────────

  const PAR_SEGS = [
    { width: `${currentPct}%`, bg: NAVY,      label: 'Current',    val: fmtKoboShort((total - (kpis?.par30_kobo ?? 0) - (kpis?.par60_kobo ?? 0) - (kpis?.par90_kobo ?? 0))), pct: `${currentPct}%` },
    { width: `${par30W}%`,     bg: '#0EA5E9',  label: '1–30 DPD',  val: fmtKoboShort(kpis?.par30_kobo ?? 0), pct: `${par30W}%` },
    { width: `${par60W}%`,     bg: '#B45309',  label: '31–60 DPD', val: fmtKoboShort(kpis?.par60_kobo ?? 0), pct: `${par60W}%` },
    { width: `${par90W}%`,     bg: RED,        label: '61–90+ DPD',val: fmtKoboShort(kpis?.par90_kobo ?? 0), pct: `${par90W}%` },
  ]

  // ── Formatted hero value ─────────────────────────────────────────────────────

  const heroNaira = Math.floor(heroVal / 100).toLocaleString('en-NG')

  return (
    <div style={S.scroll}>

      {/* ── Hero ── */}
      <section style={S.hero}>
        <div>
          <div style={S.heroLabel}>Portfolio at Risk · All Accounts</div>
          <div style={S.heroFigure}>
            <span style={{ fontSize: 24, color: 'var(--txt2)', fontWeight: 500, verticalAlign: 18, marginRight: 2 }}>₦</span>
            {loading && !kpis ? '—' : heroNaira}
          </div>
          <div style={S.heroDelta}>
            {par30W > 0 ? `▲ ${par30Pct}% in 1–30 DPD bucket` : 'Portfolio data loaded'}
          </div>
        </div>

        <div style={S.heroSecondary}>
          {[
            ['PAR 30',           `${par30Pct}`,              '%', 'target ≤ 5.0%'],
            ['Promises Today',   String(ptpToday),           '',  rows.length > 0 ? `${rows.length} total active` : '—'],
            ['Kept Rate',        `${keptRate}`,              '%', '30-day rolling'],
            ['Collected MTD',    fmtKoboShort(collectedMTD), '',  'kept promises'],
          ].map(([lbl, val, unit, sub]) => (
            <div key={lbl}>
              <div style={S.mLabel}>{lbl}</div>
              <div style={S.mValue}>
                {loading && !kpis ? '—' : val}
                <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>{unit}</span>
              </div>
              <div style={S.mSub}>{sub}</div>
            </div>
          ))}
        </div>

      </section>

      {/* ── PAR bar ── */}
      <section style={S.parSection}>
        <div style={S.secHead}>
          <div style={S.secTitle}>Delinquency aging</div>
          <div style={S.secNote}>
            Outstanding principal by DPD bucket · as at {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} WAT
          </div>
        </div>

        <div style={S.parBar}>
          {loading && !kpis ? (
            <div style={{ flex: 1, background: 'var(--bdr)', borderRadius: 3 }} />
          ) : PAR_SEGS.map(seg => (
            <div key={seg.label}
              style={{ width: seg.width, background: seg.bg, transition: 'filter .12s', flexShrink: 0, cursor: 'default' }}
              onMouseMove={e => setTooltip({ label: seg.label, val: seg.val, pct: seg.pct, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setTooltip(null)}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.12)' }}
            />
          ))}
        </div>

        <div style={S.parLegend}>
          {PAR_SEGS.map(seg => (
            <div key={seg.label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: seg.bg, display: 'inline-block', flexShrink: 0, alignSelf: 'center' }} />
              <span style={{ fontSize: 11, color: 'var(--txt2)', fontWeight: 500 }}>{seg.label}</span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>{loading && !kpis ? '—' : seg.val}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--txt3)' }}>{loading && !kpis ? '' : seg.pct}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Floating PAR tooltip */}
      {tooltip && (
        <div style={{ position: 'fixed', left: tooltip.x + 14, top: tooltip.y - 12, zIndex: 200, pointerEvents: 'none', background: NAVY, color: '#fff', padding: '8px 13px', borderRadius: 8, fontSize: 12, fontFamily: SORA, boxShadow: '0 6px 24px rgba(0,0,0,.35)', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{tooltip.label}</div>
          <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700 }}>{tooltip.val}</div>
          <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.6)', marginTop: 1 }}>{tooltip.pct} of portfolio</div>
        </div>
      )}

      {/* ── Promise Queue Table section ── */}
      <section style={{ paddingBottom: 40 }}>

        {/* Toolbar */}
        <div style={S.tblBar}>
          <span style={S.tblTitle}>Promises to Pay</span>

          {/* Search */}
          <TblSearch value={search} onChange={setSearch} placeholder="Search name, CIF, agent…" />

          {/* Filters button */}
          <button style={S.fltBtn(activeCount > 0)} onClick={() => setFilterOpen(o => !o)}>
            <IcoTune width={14} height={14} style={{ flexShrink: 0 }} />
            Filters
            {activeCount > 0 && <span style={S.fltPip}>{activeCount}</span>}
          </button>

          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />

          <span style={S.tblCountR}>{filtered.length} of {rows.length}</span>
        </div>

        {/* Expandable filter panel */}
        {filterOpen && (
          <div style={S.fltPanel}>
            <div style={S.fltGrid}>
              <div>
                <div style={S.fltColTitle}>Status</div>
                {(availableStatuses.length > 0 ? availableStatuses : ['Pending', 'Kept', 'Broken']).map(v => (
                  <label key={v} style={S.fltRow}>
                    <input
                      type="checkbox"
                      checked={statusSel.has(v)}
                      onChange={() => toggleStatus(v)}
                      style={{ accentColor: NAVY, width: 14, height: 14, cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span style={S.fLabel}>{v}</span>
                    <span style={S.fCount}>{statusCounts(v)}</span>
                  </label>
                ))}
              </div>
            </div>
            <div style={S.fltFoot}>
              <span style={S.fltStatus}>
                {activeCount === 0
                  ? `No filters applied — showing all ${rows.length} rows`
                  : `${activeCount} filter${activeCount !== 1 ? 's' : ''} active`}
              </span>
              <button style={S.fltReset} onClick={resetFilters}>Reset</button>
              <button style={S.fltDone} onClick={() => setFilterOpen(false)}>
                Done · {filtered.length} results
              </button>
            </div>
          </div>
        )}

        {/* Active chips */}
        {!filterOpen && chips.length > 0 && (
          <div style={S.chipsBar}>
            {chips.map(c => (
              <span key={c.key} style={S.aChip}>
                {c.label}
                <span style={S.chipX} onClick={c.clear}>✕</span>
              </span>
            ))}
            <button style={S.clearAll} onClick={resetFilters}>Clear all</button>
          </div>
        )}

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[
                  { key: 'account_cif',         label: 'CIF',         r: false },
                  { key: 'customer_name',        label: 'Customer',    r: false },
                  { key: 'promise_date',         label: 'Due Date',    r: false },
                  { key: 'outstanding_kobo',     label: 'Outstanding', r: true  },
                  { key: 'promise_amount_kobo',  label: 'Amount',      r: true  },
                  { key: 'agent_name',           label: 'Agent',       r: false },
                  { key: '__status',             label: 'Status',      r: false, nosort: true },
                ].map(col => (
                  <th
                    key={col.key}
                    style={{
                      ...S.thead,
                      ...(col.nosort ? S.theadNs : {}),
                      ...(col.r ? { textAlign: 'right' } : {}),
                      ...(col.key === 'account_cif' ? { paddingLeft: 28 } : {}),
                      ...(col.key === '__status'    ? { paddingRight: 28 } : {}),
                    }}
                    onClick={col.nosort ? undefined : () => toggleSort(col.key)}
                  >
                    {col.label}
                    {!col.nosort && (
                      <SortIco active={sortKey === col.key} dir={sortDir} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} style={S.td}>
                        <div style={{ height: 12, borderRadius: 4, background: 'var(--bdr)', width: j === 1 ? '60%' : j === 0 ? '50%' : '70%' }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ ...S.td, textAlign: 'center', padding: '32px', color: 'var(--txt3)', fontSize: 12.5 }}>
                    No records match the current filters
                  </td>
                </tr>
              ) : pageRows.map(r => (
                <tr
                  key={r.id}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={e => {
                    const cells = (e.currentTarget as HTMLElement).querySelectorAll('td')
                    cells.forEach(td => { (td as HTMLElement).style.background = 'var(--row-hvr)' })
                  }}
                  onMouseLeave={e => {
                    const cells = (e.currentTarget as HTMLElement).querySelectorAll('td')
                    cells.forEach(td => { (td as HTMLElement).style.background = '' })
                  }}
                >
                  <td style={{ ...S.td, paddingLeft: 28, fontFamily: MONO, fontSize: 11.5, color: 'var(--txt2)' }}>
                    {r.account_cif}
                  </td>
                  <td style={{ ...S.td, fontWeight: 600, color: 'var(--txt)' }}>
                    {r.customer_name ?? '—'}
                  </td>
                  <td style={{ ...S.td, fontFamily: MONO, fontSize: 11.5, color: 'var(--txt2)' }}>
                    {r.promise_date ? fmtDate(r.promise_date) : '—'}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', fontFamily: MONO, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtKobo(r.outstanding_kobo)}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', fontFamily: MONO, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtKobo(r.promise_amount_kobo)}
                  </td>
                  <td style={{ ...S.td, fontSize: 12, color: 'var(--txt2)' }}>
                    {r.agent_name ?? '—'}
                  </td>
                  <td style={{ ...S.td, paddingRight: 28 }}>
                    <PtpPill status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderTop: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: MONO }}>
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: page === 1 ? 'default' : 'pointer', opacity: page === 1 ? 0.4 : 1, fontSize: 13 }}>
                ←
              </button>
              <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: MONO, padding: '0 10px' }}>
                {page} / {totalPages}
              </span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: page >= totalPages ? 'default' : 'pointer', opacity: page >= totalPages ? 0.4 : 1, fontSize: 13 }}>
                →
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
