import { useEffect, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { ConfirmModal, DateFilter, TblSearch } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { RED, GREEN, NAVY, MONO, SORA } from '../../lib/design'
import { IcoTune } from '../../lib/icons'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WriteoffKPIs {
  total: number
  amount_kobo: number
  recovery_rate_pct: number
  pending: number
}

interface WriteoffRow {
  id: number
  account_cif: string
  customer_name: string | null
  outstanding_kobo: number
  dpd: number
  last_payment_date: string | null
  recovery_attempts: number
  recommended_by: string | null
}

// ── DPD badge ─────────────────────────────────────────────────────────────────

function DpdBadge({ dpd }: { dpd: number }) {
  const color = dpd > 720 ? '#7F0000' : dpd > 360 ? '#A00000' : RED
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: MONO, fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 3, background: `${color}22`, color, whiteSpace: 'nowrap' }}>
      {dpd} DPD
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

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportCsv(rows: WriteoffRow[]) {
  const header = ['CIF', 'Customer Name', 'Outstanding (₦)', 'DPD', 'Last Payment Date', 'Recovery Attempts', 'Recommended By']
  const lines = rows.map(r => [
    r.account_cif ?? '', `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
    (r.outstanding_kobo / 100).toFixed(2), r.dpd ?? '',
    r.last_payment_date ?? '', r.recovery_attempts ?? '',
    `"${String(r.recommended_by ?? '').replace(/"/g, '""')}"`,
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `writeoff-queue-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Role check ────────────────────────────────────────────────────────────────

function getUser(): { role?: string } {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') }
  catch { return {} }
}

// ── DPD range filter ──────────────────────────────────────────────────────────

const DPD_RANGES = [
  { key: '',        label: 'All DPD' },
  { key: '181-360', label: '181–360' },
  { key: '361-720', label: '361–720' },
  { key: '720+',    label: '720+' },
]

// ── Main component ────────────────────────────────────────────────────────────

type ActionModal = { type: 'approve'; row: WriteoffRow } | { type: 'return'; row: WriteoffRow } | { type: 'bulk-approve' } | null

const PAGE_SIZE = 25

export default function WriteoffQueue() {
  const [rows, setRows]         = useState<WriteoffRow[]>([])
  const [kpis, setKpis]         = useState<WriteoffKPIs | null>(null)
  const [loading, setLoading]   = useState(true)

  const [search,      setSearch]      = useState('')
  const [filterOpen,  setFilterOpen]  = useState(false)
  const [dpdRange,    setDpdRange]    = useState('')
  const [dateFrom,    setDateFrom]    = useState(monthStart())
  const [dateTo,      setDateTo]      = useState(today())
  const [sortKey,     setSortKey]     = useState<string | null>(null)
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('asc')
  const [page,        setPage]        = useState(1)

  const [checkedIds, setCheckedIds]   = useState<Set<number>>(new Set())
  const [modal,   setModal]   = useState<ActionModal>(null)
  const [acting,  setActing]  = useState(false)

  const user   = getUser()
  const canAct = user.role === 'collections_head' || user.role === 'admin'

  const load = useCallback(async () => {
    setLoading(true)
    const p = new URLSearchParams({ limit: '500' })
    if (dpdRange) p.set('dpd_range', dpdRange)
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to', dateTo)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: WriteoffRow[] }>(`/api/collections-ops/writeoffs?${p}`),
        apiFetch<{ data: WriteoffKPIs }>('/api/collections/writeoff-kpis'),
      ])
      setRows(res.data ?? [])
      setKpis(kpiRes.data)
      setCheckedIds(new Set())
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [dpdRange, dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, dpdRange, dateFrom, dateTo])

  async function handleConfirm() {
    if (!modal) return
    setActing(true)
    try {
      if (modal.type === 'approve') {
        await apiPost(`/api/collections-ops/writeoffs/${modal.row.id}/approve`, {})
        toast.success('Write-off approved')
      } else if (modal.type === 'return') {
        await apiPost(`/api/collections-ops/writeoffs/${modal.row.id}/return-recovery`, {})
        toast.success('Account returned to Recovery')
      } else if (modal.type === 'bulk-approve') {
        await apiPost('/api/collections-ops/writeoffs/bulk-approve', { ids: Array.from(checkedIds) })
        toast.success(`${checkedIds.size} write-off${checkedIds.size > 1 ? 's' : ''} approved`)
      }
      setModal(null); load()
    } catch (e: any) { toast.error(e.message ?? 'Action failed') }
    finally { setActing(false) }
  }

  function toggleCheck(id: number) { setCheckedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next }) }
  function toggleSort(key: string) { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('asc') } }

  const filtered = useMemo(() => {
    let r = [...rows]
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(x => (x.account_cif ?? '').toLowerCase().includes(q) || (x.customer_name ?? '').toLowerCase().includes(q) || (x.recommended_by ?? '').toLowerCase().includes(q))
    }
    if (sortKey) r.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sortKey] ?? ''
      const vb = (b as unknown as Record<string, unknown>)[sortKey] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return r
  }, [rows, search, sortKey, sortDir])

  const pageRows   = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page])
  const activeFilterCount = dpdRange ? 1 : 0

  const confirmTitle = modal === null ? '' : modal.type === 'approve' ? 'Approve Write-off' : modal.type === 'return' ? 'Return to Recovery' : 'Bulk Approve Write-offs'
  const confirmBody  = modal === null ? '' :
    modal.type === 'approve' ? `This will write off ${fmtKobo(modal.row.outstanding_kobo)} from CIF ${modal.row.account_cif}. This cannot be undone.` :
    modal.type === 'return'  ? `Return CIF ${modal.row.account_cif} to active Recovery queue?` :
    `Approve ${checkedIds.size} write-off${checkedIds.size > 1 ? 's' : ''}? This posts GL entries for each and cannot be undone.`

  const TH: React.CSSProperties = {
    position: 'sticky', top: 0, background: 'var(--bg)',
    fontSize: 10, fontWeight: 600, letterSpacing: '.1em',
    textTransform: 'uppercase', color: 'var(--txt3)',
    textAlign: 'left', padding: '8px 14px',
    borderTop: '1px solid var(--bdr)', borderBottom: '1px solid var(--bdr)',
    zIndex: 2, whiteSpace: 'nowrap', cursor: 'pointer',
  }
  const TD: React.CSSProperties = { padding: '0 14px', height: 42, borderBottom: '1px solid var(--bdr)', fontSize: 12.5, verticalAlign: 'middle' }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, fontFamily: SORA }}>

      {/* ── Hero ── */}
      <section style={{ display: 'flex', alignItems: 'flex-end', gap: 48, flexWrap: 'wrap', padding: '26px 28px 24px', borderBottom: '1px solid var(--bdr)' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 8, fontFamily: MONO }}>
            Write-off Queue · {dateFrom && dateTo ? `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}` : 'All time'}
          </div>
          <div style={{ fontFamily: MONO, fontWeight: 600, fontSize: 46, lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums', color: RED }}>
            {loading && !kpis ? '—' : fmtNum(kpis?.pending ?? rows.length)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500, marginTop: 8 }}>pending approval</div>
        </div>

        <div style={{ display: 'flex', gap: 40, paddingBottom: 4, flexWrap: 'wrap' }}>
          {[
            ['Total Write-offs', kpis ? fmtNum(kpis.total) : '—',                             '',  'all time'],
            ['Total Amount',     kpis ? fmtKobo(kpis.amount_kobo) : '—',                      '',  'written off'],
            ['Recovery Rate',    kpis ? kpis.recovery_rate_pct.toFixed(1) : '—',              '%', 'of written-off value'],
            ['In Queue',         fmtNum(rows.length),                                           '',  'accounts today'],
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

      {/* Info banner */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 20px', borderBottom: '1px solid var(--bdr)', background: `${RED}08` }}>
        <span style={{ fontSize: 15, color: RED, flexShrink: 0, lineHeight: 1.4 }}>⚠</span>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--txt)', lineHeight: 1.6, fontFamily: SORA }}>
          Accounts with DPD &gt; 180 days that have exhausted collection attempts.
          {canAct ? ' As Collections Head, you can approve write-offs — this triggers an irreversible GL entry.' : ' Only Collections Heads can approve write-offs.'}
        </p>
      </div>

      {/* ── Table section ── */}
      <section style={{ paddingBottom: 40 }}>

        {/* Bulk bar */}
        {canAct && checkedIds.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: '#F0F4FF', borderBottom: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: NAVY, fontFamily: MONO }}>{checkedIds.size} selected</span>
            <button onClick={() => setModal({ type: 'bulk-approve' })}
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', background: RED, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: SORA }}>
              Bulk Approve Write-offs
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', marginRight: 4, whiteSpace: 'nowrap' }}>Queue</span>

          <TblSearch value={search} onChange={setSearch} placeholder="Search CIF, customer…" />

          <button onClick={() => setFilterOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, border: `1.5px solid ${activeFilterCount > 0 ? RED : 'var(--bdr)'}`, background: 'transparent', color: activeFilterCount > 0 ? RED : 'var(--txt2)', cursor: 'pointer', fontFamily: SORA, whiteSpace: 'nowrap', position: 'relative' }}>
            <IcoTune width={14} height={14} style={{ flexShrink: 0 }} />
            Filters
            {activeFilterCount > 0 && <span style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: RED, color: '#fff', fontSize: 9, fontWeight: 700, fontFamily: MONO, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{activeFilterCount}</span>}
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
            <div style={{ padding: '20px 20px 0' }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: MONO }}>DPD Range</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {DPD_RANGES.map(opt => (
                  <button key={opt.key} onClick={() => setDpdRange(opt.key)}
                    style={{ padding: '5px 13px', borderRadius: 20, fontSize: 12, fontWeight: 600, fontFamily: SORA, cursor: 'pointer', border: `1.5px solid ${dpdRange === opt.key ? RED : 'var(--bdr)'}`, background: dpdRange === opt.key ? `${RED}1A` : 'transparent', color: dpdRange === opt.key ? RED : 'var(--txt2)' }}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{activeFilterCount === 0 ? `No filters applied — ${rows.length} rows` : '1 filter active'}</span>
              <button onClick={() => setDpdRange('')} style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SORA }}>Reset</button>
              <button onClick={() => setFilterOpen(false)} style={{ padding: '5px 16px', borderRadius: 7, border: 'none', background: RED, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto', fontFamily: SORA }}>
                Done · {filtered.length} results
              </button>
            </div>
          </div>
        )}

        {/* DPD chip */}
        {!filterOpen && dpdRange && (
          <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: `${RED}1A`, color: RED }}>
              DPD: {DPD_RANGES.find(r => r.key === dpdRange)?.label}
              <span onClick={() => setDpdRange('')} style={{ cursor: 'pointer', fontSize: 11, lineHeight: 1, marginLeft: 2 }}>✕</span>
            </span>
          </div>
        )}

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {canAct && <th style={{ ...TH, paddingLeft: 18, cursor: 'default', width: 32 }} />}
                {[
                  { key: 'account_cif',        label: 'Customer',          r: false, pl: canAct ? 0 : 28 },
                  { key: 'outstanding_kobo',    label: 'Outstanding',       r: true  },
                  { key: 'dpd',                 label: 'DPD',               r: false },
                  { key: 'last_payment_date',   label: 'Last Payment',      r: false },
                  { key: 'recovery_attempts',   label: 'Recovery Attempts', r: false },
                  { key: 'recommended_by',      label: 'Recommended By',    r: false },
                  ...(canAct ? [{ key: '__actions', label: '', r: false, nosort: true, pr: 28 }] : []),
                ].map(col => (
                  <th key={col.key} style={{ ...TH, ...('nosort' in col && col.nosort ? { cursor: 'default' } : {}), ...(col.r ? { textAlign: 'right' } : {}), ...('pl' in col && col.pl ? { paddingLeft: col.pl } : {}), ...('pr' in col && col.pr ? { paddingRight: col.pr } : {}) }}
                    onClick={'nosort' in col && col.nosort ? undefined : () => toggleSort(col.key)}>
                    {col.label}{'nosort' in col && col.nosort ? null : <SortIco active={sortKey === col.key} dir={sortDir} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: canAct ? 8 : 7 }).map((_, j) => (
                    <td key={j} style={TD}><div style={{ height: 12, borderRadius: 4, background: 'var(--bdr)', width: j === 0 ? '60%' : '75%' }} /></td>
                  ))}</tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={canAct ? 8 : 7} style={{ ...TD, textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: 12.5 }}>No accounts in write-off queue</td></tr>
              ) : pageRows.map(r => (
                <tr key={r.id}
                  onMouseEnter={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = 'var(--row-hvr)' }) }}
                  onMouseLeave={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = checkedIds.has(r.id) ? `${NAVY}08` : '' }) }}
                  style={{ background: checkedIds.has(r.id) ? `${NAVY}08` : undefined }}>
                  {canAct && (
                    <td style={{ ...TD, paddingLeft: 18, width: 32 }} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={checkedIds.has(r.id)} onChange={() => toggleCheck(r.id)} style={{ accentColor: NAVY, width: 14, height: 14, cursor: 'pointer' }} />
                    </td>
                  )}
                  <td style={{ ...TD, ...(!canAct ? { paddingLeft: 28 } : {}) }}>
                    <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--txt2)' }}>{r.account_cif}</div>
                    {r.customer_name && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 1 }}>{r.customer_name}</div>}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: RED }}>{fmtKobo(r.outstanding_kobo)}</td>
                  <td style={TD}><DpdBadge dpd={r.dpd} /></td>
                  <td style={{ ...TD, fontFamily: MONO, fontSize: 11.5, color: r.last_payment_date ? 'var(--txt)' : 'var(--txt3)' }}>
                    {r.last_payment_date ? fmtDate(r.last_payment_date) : 'Never'}
                  </td>
                  <td style={{ ...TD, fontFamily: MONO, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>{fmtNum(r.recovery_attempts)}</td>
                  <td style={{ ...TD, fontSize: 12, color: 'var(--txt)' }}>{r.recommended_by ?? '—'}</td>
                  {canAct && (
                    <td style={{ ...TD, paddingRight: 28 }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 5, whiteSpace: 'nowrap' }}>
                        <button onClick={() => setModal({ type: 'approve', row: r })}
                          style={{ padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: RED, color: '#fff', fontFamily: SORA }}>
                          Approve
                        </button>
                        <button onClick={() => setModal({ type: 'return', row: r })}
                          style={{ padding: '3px 9px', borderRadius: 5, border: '1.5px solid var(--bdr)', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: 'transparent', color: 'var(--txt2)', fontFamily: SORA }}>
                          Return
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <Pager page={page} total={filtered.length} size={PAGE_SIZE} onChange={setPage} />
      </section>

      <ConfirmModal
        open={modal !== null}
        title={confirmTitle}
        body={confirmBody}
        confirmLabel={modal?.type === 'approve' ? 'Approve Write-off' : modal?.type === 'return' ? 'Return to Recovery' : 'Bulk Approve'}
        danger={modal?.type === 'approve' || modal?.type === 'bulk-approve'}
        loading={acting}
        onConfirm={handleConfirm}
        onClose={() => setModal(null)}
      />
    </div>
  )
}
