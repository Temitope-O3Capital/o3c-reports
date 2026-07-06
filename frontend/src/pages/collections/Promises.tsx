import { useEffect, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { ConfirmModal, DateFilter, TblSearch } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { AMBER, GREEN, RED, NAVY, MONO, SORA } from '../../lib/design'
import { IcoTune } from '../../lib/icons'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PromiseKPIs {
  total: number
  kept: number
  broken: number
  amount_promised_kobo: number
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

// ── Status pill ───────────────────────────────────────────────────────────────

const PTP_STYLE: Record<string, { bg: string; color: string }> = {
  Pending: { bg: `${AMBER}22`, color: '#92400E' },
  Kept:    { bg: `${GREEN}1F`, color: '#14532D' },
  Broken:  { bg: `${RED}1A`,   color: RED },
}

function PtpPill({ status }: { status: string }) {
  const s = PTP_STYLE[status] ?? { bg: 'rgba(75,85,99,.1)', color: '#6B7280' }
  return (
    <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', borderRadius: 3, padding: '2px 7px', background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  )
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIco({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <span style={{ color: RED, opacity: active ? 1 : 0.3, fontSize: 10, marginLeft: 3, verticalAlign: 'middle' }}>
      {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportCsv(rows: PTPane[]) {
  const header = ['CIF', 'Customer', 'Outstanding (₦)', 'Amount (₦)', 'Due Date', 'Status', 'Agent', 'Created']
  const lines = rows.map(r => [
    r.account_cif, `"${(r.customer_name ?? '').replace(/"/g, '""')}"`,
    (r.outstanding_kobo / 100).toFixed(2), (r.promise_amount_kobo / 100).toFixed(2),
    r.promise_date, r.status, `"${(r.agent_name ?? '').replace(/"/g, '""')}"`, r.created_at,
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `promises-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Pagination bar ────────────────────────────────────────────────────────────

function Pager({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size))
  if (pages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: MONO }}>
        {(page - 1) * size + 1}–{Math.min(page * size, total)} of {total}
      </span>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <button onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: page === 1 ? 'default' : 'pointer', fontFamily: SORA, opacity: page === 1 ? 0.4 : 1 }}>
          ← Prev
        </button>
        <span style={{ fontSize: 12, fontFamily: MONO, fontWeight: 600, color: 'var(--txt)', minWidth: 64, textAlign: 'center' }}>
          {page} / {pages}
        </span>
        <button onClick={() => onChange(Math.min(pages, page + 1))} disabled={page === pages}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: page === pages ? 'default' : 'pointer', fontFamily: SORA, opacity: page === pages ? 0.4 : 1 }}>
          Next →
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const PAGE_SIZE = 25

export default function CollectionsPromises() {
  const [rows, setRows]   = useState<PTPane[]>([])
  const [kpis, setKpis]   = useState<PromiseKPIs | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]     = useState<string | null>(null)

  // Table state
  const [search,     setSearch]     = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [statusSel,  setStatusSel]  = useState<Set<string>>(new Set())
  const [dateFrom,   setDateFrom]   = useState(monthStart())
  const [dateTo,     setDateTo]     = useState(today())
  const [sortKey,    setSortKey]    = useState<string | null>(null)
  const [sortDir,    setSortDir]    = useState<'asc' | 'desc'>('asc')
  const [page,       setPage]       = useState(1)

  // Action state
  const [actionRow,  setActionRow]  = useState<PTPane | null>(null)
  const [actionType, setActionType] = useState<'kept' | 'broken' | null>(null)
  const [acting,     setActing]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const p = new URLSearchParams({ limit: '500' })
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to', dateTo)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: PTPane[] }>(`/api/collections-ops/promises?${p}`),
        apiFetch<{ data: PromiseKPIs }>('/api/collections/promise-kpis'),
      ])
      const sorted = (res.data ?? []).slice().sort(
        (a, b) => new Date(a.promise_date).getTime() - new Date(b.promise_date).getTime()
      )
      setRows(sorted)
      setKpis(kpiRes.data)
    } catch (e: any) { setErr(e.message ?? 'Failed to load promises') }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, statusSel, dateFrom, dateTo])

  async function doAction() {
    if (!actionRow || !actionType) return
    setActing(true)
    try {
      await apiPut(`/api/collections-ops/promises/${actionRow.id}/${actionType}`, {})
      toast.success(actionType === 'kept' ? 'Marked as Kept' : 'Marked as Broken')
      setActionRow(null); setActionType(null); load()
    } catch (e: any) { toast.error(e.message ?? 'Action failed') }
    finally { setActing(false) }
  }

  function toggleStatus(v: string) {
    setStatusSel(prev => { const next = new Set(prev); next.has(v) ? next.delete(v) : next.add(v); return next })
  }
  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }
  function resetFilters() { setSearch(''); setStatusSel(new Set()) }

  const activeCount = statusSel.size

  const filtered = useMemo(() => {
    let r = [...rows]
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(x => (x.account_cif ?? '').toLowerCase().includes(q) || (x.customer_name ?? '').toLowerCase().includes(q) || (x.agent_name ?? '').toLowerCase().includes(q))
    }
    if (statusSel.size) r = r.filter(x => statusSel.has(x.status))
    if (sortKey) r.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sortKey] ?? ''
      const vb = (b as unknown as Record<string, unknown>)[sortKey] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return r
  }, [rows, search, statusSel, sortKey, sortDir])

  const availableStatuses = useMemo(() => Array.from(new Set(rows.map(r => r.status))).filter(Boolean).sort(), [rows])
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  type Chip = { key: string; label: string; clear: () => void }
  const chips: Chip[] = [...statusSel].map(v => ({ key: v, label: v, clear: () => toggleStatus(v) }))

  const statusCount = (s: string) => rows.filter(r => r.status === s).length

  const metricKept    = kpis?.kept    ?? rows.filter(r => r.status === 'Kept').length
  const metricBroken  = kpis?.broken  ?? rows.filter(r => r.status === 'Broken').length
  const metricTotal   = kpis?.total   ?? rows.length
  const metricAmt     = kpis?.amount_promised_kobo ?? rows.reduce((s, r) => s + r.promise_amount_kobo, 0)
  const keptRate      = metricTotal > 0 ? ((metricKept / metricTotal) * 100).toFixed(1) : '0.0'

  if (err) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontFamily: SORA }}>{err}</div>
  }

  const TH: React.CSSProperties = {
    position: 'sticky', top: 0, background: 'var(--bg)',
    fontSize: 10, fontWeight: 600, letterSpacing: '.1em',
    textTransform: 'uppercase', color: 'var(--txt3)',
    textAlign: 'left', padding: '8px 14px',
    borderTop: '1px solid var(--bdr)', borderBottom: '1px solid var(--bdr)',
    zIndex: 2, whiteSpace: 'nowrap', cursor: 'pointer',
  }
  const TD: React.CSSProperties = {
    padding: '0 14px', height: 38, borderBottom: '1px solid var(--bdr)',
    fontSize: 12.5, whiteSpace: 'nowrap',
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, fontFamily: SORA }}>

      {/* ── Hero ── */}
      <section style={{ display: 'flex', alignItems: 'flex-end', gap: 48, flexWrap: 'wrap', padding: '26px 28px 24px', borderBottom: '1px solid var(--bdr)' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 8, fontFamily: MONO }}>
            Promises to Pay · {dateFrom && dateTo ? `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}` : 'All time'}
          </div>
          <div style={{ fontFamily: MONO, fontWeight: 600, fontSize: 46, lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>
            {loading && !kpis ? '—' : fmtNum(metricTotal)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500, marginTop: 8 }}>
            {keptRate}% kept · {fmtNum(metricBroken)} broken
          </div>
        </div>

        <div style={{ display: 'flex', gap: 40, paddingBottom: 4, flexWrap: 'wrap' }}>
          {[
            ['Kept',           String(metricKept),   '',  'promises honoured'],
            ['Broken',         String(metricBroken), '',  'promises missed'],
            ['Kept Rate',      keptRate,             '%', '30-day period'],
            ['Amount Promised', fmtKobo(metricAmt),  '',  'total committed'],
          ].map(([lbl, val, unit, sub]) => (
            <div key={lbl}>
              <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--txt3)', fontWeight: 600, marginBottom: 5, fontFamily: MONO }}>{lbl}</div>
              <div style={{ fontFamily: MONO, fontSize: 19, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>
                {loading && !kpis ? '—' : val}
                <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>{unit}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 3 }}>{sub}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Table section ── */}
      <section style={{ paddingBottom: 40 }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', marginRight: 4, whiteSpace: 'nowrap' }}>Promises</span>

          <TblSearch value={search} onChange={setSearch} placeholder="Search name, CIF, agent…" />

          <button
            onClick={() => setFilterOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, border: `1.5px solid ${activeCount > 0 ? RED : 'var(--bdr)'}`, background: 'transparent', color: activeCount > 0 ? RED : 'var(--txt2)', cursor: 'pointer', fontFamily: SORA, whiteSpace: 'nowrap', position: 'relative' }}
          >
            <IcoTune width={14} height={14} style={{ flexShrink: 0 }} />
            Filters
            {activeCount > 0 && (
              <span style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: RED, color: '#fff', fontSize: 9, fontWeight: 700, fontFamily: MONO, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{activeCount}</span>
            )}
          </button>

          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />

          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: MONO, whiteSpace: 'nowrap' }}>
            {filtered.length} of {rows.length}
          </span>

          <button onClick={() => exportCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: SORA, whiteSpace: 'nowrap' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV
          </button>
        </div>

        {/* Filter panel */}
        {filterOpen && (
          <div style={{ borderBottom: '1px solid var(--bdr)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', padding: '20px 20px 0' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: MONO }}>Status</div>
                {availableStatuses.length === 0
                  ? <div style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>No data yet</div>
                  : availableStatuses.map(v => (
                    <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                      <input type="checkbox" checked={statusSel.has(v)} onChange={() => toggleStatus(v)} style={{ accentColor: NAVY, width: 14, height: 14, cursor: 'pointer', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: 'var(--txt)' }}>{v}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: MONO }}>{statusCount(v)}</span>
                    </label>
                  ))
                }
              </div>
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--txt3)' }}>
                {activeCount === 0 ? `No filters applied — ${rows.length} rows` : `${activeCount} filter${activeCount !== 1 ? 's' : ''} active`}
              </span>
              <button onClick={resetFilters} style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SORA }}>Reset</button>
              <button onClick={() => setFilterOpen(false)} style={{ padding: '5px 16px', borderRadius: 7, border: 'none', background: RED, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto', fontFamily: SORA }}>
                Done · {filtered.length} results
              </button>
            </div>
          </div>
        )}

        {/* Active chips */}
        {!filterOpen && chips.length > 0 && (
          <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {chips.map(c => (
              <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: `${NAVY}18`, color: NAVY }}>
                {c.label}
                <span onClick={c.clear} style={{ cursor: 'pointer', fontSize: 11, lineHeight: 1, marginLeft: 2 }}>✕</span>
              </span>
            ))}
            <button onClick={resetFilters} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--txt3)', padding: 0, fontFamily: SORA }}>Clear all</button>
          </div>
        )}

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[
                  { key: 'account_cif',        label: 'CIF',         r: false, pl: 28 },
                  { key: 'customer_name',       label: 'Customer',    r: false },
                  { key: 'promise_date',        label: 'Due Date',    r: false },
                  { key: 'outstanding_kobo',    label: 'Outstanding', r: true  },
                  { key: 'promise_amount_kobo', label: 'Amount',      r: true  },
                  { key: 'agent_name',          label: 'Agent',       r: false },
                  { key: '__status',            label: 'Status',      r: false, nosort: true },
                  { key: '__actions',           label: '',            r: false, nosort: true, pr: 28 },
                ].map(col => (
                  <th key={col.key} style={{ ...TH, ...(col.nosort ? { cursor: 'default' } : {}), ...(col.r ? { textAlign: 'right' } : {}), ...(col.pl ? { paddingLeft: col.pl } : {}), ...(col.pr ? { paddingRight: col.pr } : {}) }}
                    onClick={col.nosort ? undefined : () => toggleSort(col.key)}>
                    {col.label}{!col.nosort && <SortIco active={sortKey === col.key} dir={sortDir} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} style={TD}><div style={{ height: 12, borderRadius: 4, background: 'var(--bdr)', width: j === 1 ? '55%' : '70%' }} /></td>
                  ))}</tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: 12.5 }}>No records match the current filters</td></tr>
              ) : pageRows.map(r => (
                <tr key={r.id}
                  style={{ cursor: 'default' }}
                  onMouseEnter={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = 'var(--row-hvr)' }) }}
                  onMouseLeave={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = '' }) }}
                >
                  <td style={{ ...TD, paddingLeft: 28, fontFamily: MONO, fontSize: 11.5, color: 'var(--txt2)' }}>{r.account_cif}</td>
                  <td style={{ ...TD, fontWeight: 600, color: 'var(--txt)' }}>{r.customer_name ?? '—'}</td>
                  <td style={{ ...TD, fontFamily: MONO, fontSize: 11.5, color: 'var(--txt2)' }}>
                    {r.promise_date ? fmtDate(r.promise_date) : '—'}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{fmtKobo(r.outstanding_kobo)}</td>
                  <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: NAVY }}>{fmtKobo(r.promise_amount_kobo)}</td>
                  <td style={{ ...TD, fontSize: 12, color: 'var(--txt2)' }}>{r.agent_name ?? '—'}</td>
                  <td style={TD}><PtpPill status={r.status} /></td>
                  <td style={{ ...TD, paddingRight: 28 }}>
                    {r.status === 'Pending' && (
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button onClick={e => { e.stopPropagation(); setActionRow(r); setActionType('kept') }}
                          style={{ padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: `${GREEN}1F`, color: '#14532D', fontFamily: SORA }}>
                          Kept
                        </button>
                        <button onClick={e => { e.stopPropagation(); setActionRow(r); setActionType('broken') }}
                          style={{ padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: `${RED}1A`, color: RED, fontFamily: SORA }}>
                          Broken
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <Pager page={page} total={filtered.length} size={PAGE_SIZE} onChange={setPage} />
      </section>

      {/* Confirm kept */}
      <ConfirmModal
        open={actionRow !== null && actionType === 'kept'}
        title="Mark Promise as Kept"
        body={`Mark the promise of ${actionRow ? fmtKobo(actionRow.promise_amount_kobo) : ''} from CIF ${actionRow?.account_cif ?? ''} as Kept?`}
        confirmLabel="Mark Kept" loading={acting}
        onConfirm={doAction} onClose={() => { setActionRow(null); setActionType(null) }}
      />

      {/* Confirm broken */}
      <ConfirmModal
        open={actionRow !== null && actionType === 'broken'}
        title="Mark Promise as Broken"
        body={`Mark the promise of ${actionRow ? fmtKobo(actionRow.promise_amount_kobo) : ''} from CIF ${actionRow?.account_cif ?? ''} as Broken?`}
        confirmLabel="Mark Broken" danger loading={acting}
        onConfirm={doAction} onClose={() => { setActionRow(null); setActionType(null) }}
      />
    </div>
  )
}
