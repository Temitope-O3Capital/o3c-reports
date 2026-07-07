import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, SearchInput, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, INTER, SORA, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Cardholder {
  cif_number: string
  product_name: string
  status: string
  card_product: string
  created_at: string
}

interface ListResp { data: Cardholder[]; total: number }

// ── Status colours ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  Open:             { bg: 'rgba(22,163,74,.1)',   txt: GREEN },
  Active:           { bg: 'rgba(22,163,74,.1)',   txt: GREEN },
  Inactive:         { bg: 'rgba(217,119,6,.12)',  txt: AMBER },
  Closed:           { bg: 'rgba(107,114,128,.1)', txt: '#6B7280' },
  Terminated:       { bg: 'rgba(192,0,0,.1)',     txt: RED },
  'Legal Suspended':{ bg: 'rgba(124,58,237,.1)',  txt: '#7C3AED' },
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: c.bg, color: c.txt, whiteSpace: 'nowrap',
    }}>{status || '—'}</span>
  )
}


function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: 6,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? NAVY : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span> : children}
    </button>
  )
}

// ── Block log types ───────────────────────────────────────────────────────────

interface BlockLogEntry {
  id:              number
  cif_number:      string
  reason:          string
  is_blocked:      boolean
  created_at:      string
  unblocked_at:    string | null
  blocked_by_name: string | null
}

// ── Block / Unblock action ────────────────────────────────────────────────────

function ActionCell({ row, onDone }: { row: Cardholder; onDone: () => void }) {
  const [busy,        setBusy]        = useState(false)
  const [showBlock,   setShowBlock]   = useState(false)
  const [showLog,     setShowLog]     = useState(false)
  const [reason,      setReason]      = useState('')
  const [log,         setLog]         = useState<BlockLogEntry[]>([])
  const [logLoading,  setLogLoading]  = useState(false)

  const isActive = row.status === 'Open' || row.status === 'Active'

  async function doBlock() {
    if (!reason.trim()) { toast.error('Enter a block reason'); return }
    setBusy(true)
    try {
      await apiFetch(`/api/cards/cardholders/${row.cif_number}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      toast.success('Card blocked')
      setShowBlock(false)
      setReason('')
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    }
    setBusy(false)
  }

  async function doUnblock() {
    setBusy(true)
    try {
      await apiFetch(`/api/cards/cardholders/${row.cif_number}/unblock`, { method: 'POST' })
      toast.success('Card unblocked')
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    }
    setBusy(false)
  }

  async function openLog() {
    setShowLog(true)
    setLogLoading(true)
    try {
      const res = await apiFetch<{ data: BlockLogEntry[] }>(`/api/cards/cardholders/${row.cif_number}/block-log`)
      setLog(res.data ?? [])
    } catch {
      setLog([])
    }
    setLogLoading(false)
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={e => { e.stopPropagation(); isActive ? setShowBlock(true) : doUnblock() }}
          disabled={busy}
          style={{
            padding: '3px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
            background: isActive ? 'rgba(192,0,0,.08)' : 'rgba(22,163,74,.1)',
            color: isActive ? RED : GREEN,
          }}
        >
          {busy ? '…' : isActive ? 'Block' : 'Unblock'}
        </button>
        <button
          onClick={e => { e.stopPropagation(); openLog() }}
          style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer', fontSize: 11.5, color: 'var(--txt2)' }}
          title="Block history"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 13, verticalAlign: 'middle' }}>history</span>
        </button>
      </div>

      {/* Block reason modal */}
      {showBlock && (
        <Modal open={showBlock} title={`Block card — ${row.cif_number}`} onClose={() => { setShowBlock(false); setReason('') }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--txt2)' }}>
              This will block all card activity for <strong>{row.cif_number}</strong>. Provide a reason for audit.
            </p>
            <label style={{ fontSize: 12, color: 'var(--txt2)' }}>
              Reason <span style={{ color: RED }}>*</span>
              <textarea
                rows={3}
                value={reason}
                autoFocus
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. Suspected fraud, Customer request…"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowBlock(false); setReason('') }}
                style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={doBlock} disabled={busy || !reason.trim()}
                style={{ padding: '7px 16px', borderRadius: 6, border: 'none', cursor: (busy || !reason.trim()) ? 'not-allowed' : 'pointer', background: RED, color: '#fff', fontSize: 13, fontWeight: 600, opacity: (busy || !reason.trim()) ? 0.6 : 1 }}>
                {busy ? 'Blocking…' : 'Confirm Block'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Block log modal */}
      {showLog && (
        <Modal open={showLog} title={`Block history — ${row.cif_number}`} onClose={() => setShowLog(false)}>
          {logLoading ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--txt2)', fontSize: 13 }}>Loading…</div>
          ) : log.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--txt2)', fontSize: 13 }}>No block history for this card</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {log.map(entry => (
                <div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 20,
                      background: entry.is_blocked ? 'rgba(192,0,0,.1)' : 'rgba(22,163,74,.1)',
                      color: entry.is_blocked ? RED : GREEN,
                    }}>{entry.is_blocked ? 'Blocked' : 'Unblocked'}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--txt2)' }}>{fmtDatetime(entry.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--txt)' }}>{entry.reason || '—'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--txt2)' }}>
                    By {entry.blocked_by_name ?? 'System'}
                    {entry.unblocked_at && <> · Unblocked {fmtDatetime(entry.unblocked_at)}</>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}

// ── Columns ───────────────────────────────────────────────────────────────────

function makeCols(onDone: () => void, navigate: (path: string) => void): TableCol<Cardholder>[] {
  return [
    { key: 'cif_number', label: 'CIF Number',
      render: r => (
        <span
          onClick={() => navigate(`/contacts/${r.cif_number}`)}
          style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: NAVY, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {r.cif_number}
        </span>
      ) },
    { key: 'product_name', label: 'Product',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA }}>{r.product_name || '—'}</span> },
    { key: 'card_product', label: 'Card Programme',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)', fontFamily: SORA }}>{r.card_product || '—'}</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'created_at', label: 'Issued Date', sortable: true,
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span> },
    { key: '_actions', label: '', render: r => <ActionCell row={r} onDone={onDone} /> },
  ]
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportCardholdersCsv(rows: Cardholder[]) {
  const header = ['CIF Number', 'Product', 'Card Programme', 'Status', 'Issued Date']
  const lines = rows.map(r => [
    `"${String(r.cif_number ?? '').replace(/"/g, '""')}"`,
    `"${String(r.product_name ?? '').replace(/"/g, '""')}"`,
    `"${String(r.card_product ?? '').replace(/"/g, '""')}"`,
    r.status ?? '',
    r.created_at ? r.created_at.slice(0, 10) : '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `cardholders-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50
const STATUSES = ['Open', 'Active', 'Inactive', 'Closed', 'Terminated', 'Legal Suspended']
const PRODUCTS = ['PREP', 'Amex Naira', 'Amex USD', 'Classic Accounts']

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CardsManagement() {
  const navigate = useNavigate()
  const [rows, setRows]       = useState<Cardholder[]>([])
  const [total, setTotal]     = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [filterOpen,   setFilterOpen]   = useState(false)
  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [productFilter, setProductFilter] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async (pg = 1) => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      p.set('limit',  String(PAGE_SIZE))
      p.set('offset', String((pg - 1) * PAGE_SIZE))
      if (statusFilter)  p.set('status',    statusFilter)
      if (productFilter) p.set('card_type', productFilter)
      const res = await apiFetch<ListResp>(`/api/cards/cardholders?${p}`)
      setRows(res?.data ?? [])
      setTotal(res?.total ?? 0)
      setPage(pg)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, productFilter])

  useEffect(() => { load(1) }, [load])

  const displayed = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(r => r.cif_number.toLowerCase().includes(q))
  }, [rows, search])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showStart  = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const showEnd    = Math.min(page * PAGE_SIZE, total)

  const activeFilterCount = (statusFilter ? 1 : 0) + (productFilter ? 1 : 0)

  function apply() {
    setFilterOpen(false)
    load(1)
  }

  function clearFilters() {
    setStatusFilter('')
    setProductFilter('')
  }

  return (
    <Page title="Cardholder Management" subtitle="View and manage all issued cards">

      <ErrBanner error={error} onRetry={() => load(page)} />

      <SectionCard title="Cardholders" badge={total} padding={false} actions={<button onClick={() => exportCardholdersCsv(displayed)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>

        {/* Toolbar */}
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <button
            onClick={() => setFilterOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 9,
              border: `1.5px solid ${filterOpen || activeFilterCount > 0 ? NAVY : 'var(--input-bdr)'}`,
              background: filterOpen ? `${NAVY}10` : 'transparent',
              color: filterOpen || activeFilterCount > 0 ? NAVY : 'var(--txt2)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: INTER,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>tune</span>
            Filters
            {activeFilterCount > 0 && (
              <span style={{ background: NAVY, color: '#fff', borderRadius: 10, fontSize: 10.5, fontWeight: 700, padding: '1px 6px', lineHeight: '16px' }}>
                {activeFilterCount}
              </span>
            )}
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
            {total.toLocaleString()} total
          </span>
        </div>

        {/* Filter panel */}
        {filterOpen && (
          <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--bdr)', background: '#F0F4FF' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>

              {/* Status */}
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>Status</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5 }}>
                    <input type="radio" checked={statusFilter === ''} onChange={() => setStatusFilter('')} /> All statuses
                  </label>
                  {STATUSES.map(s => (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5 }}>
                      <input type="radio" checked={statusFilter === s} onChange={() => setStatusFilter(s)} />
                      <span style={{ color: STATUS_COLORS[s]?.txt ?? 'var(--txt)' }}>{s}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Product */}
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>Product</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5 }}>
                    <input type="radio" checked={productFilter === ''} onChange={() => setProductFilter('')} /> All products
                  </label>
                  {PRODUCTS.map(p => (
                    <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5 }}>
                      <input type="radio" checked={productFilter === p} onChange={() => setProductFilter(p)} />
                      {p}
                    </label>
                  ))}
                </div>
              </div>

              {/* Apply */}
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={apply} style={{
                  padding: '9px 0', borderRadius: 9, border: 'none', background: NAVY, color: '#fff',
                  fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER,
                }}>Apply Filters</button>
                {activeFilterCount > 0 && (
                  <button onClick={() => { clearFilters(); setFilterOpen(false) }} style={{
                    padding: '7px 0', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent',
                    color: 'var(--txt2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: INTER,
                  }}>Clear All</button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Active chips */}
        {activeFilterCount > 0 && (
          <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {statusFilter && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, background: `${NAVY}12`, color: NAVY, borderRadius: 16, padding: '3px 10px', fontSize: 11.5, fontWeight: 600 }}>
                Status: {statusFilter}
                <button onClick={() => { setStatusFilter(''); load(1) }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: NAVY, display: 'flex', padding: 0 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 13 }}>close</span>
                </button>
              </span>
            )}
            {productFilter && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, background: `${NAVY}12`, color: NAVY, borderRadius: 16, padding: '3px 10px', fontSize: 11.5, fontWeight: 600 }}>
                Product: {productFilter}
                <button onClick={() => { setProductFilter(''); load(1) }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: NAVY, display: 'flex', padding: 0 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 13 }}>close</span>
                </button>
              </span>
            )}
          </div>
        )}

        <DataTable cols={makeCols(() => load(page), navigate)} rows={displayed} keyFn={r => r.cif_number} loading={loading} emptyText="No cardholders found" />

        {/* Pagination */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
          <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
            {total === 0 ? 'No records' : `Showing ${showStart}–${showEnd} of ${total.toLocaleString()}`}
          </span>
          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 4 }}>
              <PageBtn icon="chevron_left" disabled={page === 1} onClick={() => load(page - 1)} />
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pg: number
                if (totalPages <= 7) pg = i + 1
                else if (page <= 4) pg = i + 1
                else if (page >= totalPages - 3) pg = totalPages - 6 + i
                else pg = page - 3 + i
                return <PageBtn key={pg} active={pg === page} onClick={() => load(pg)}>{pg}</PageBtn>
              })}
              <PageBtn icon="chevron_right" disabled={page === totalPages} onClick={() => load(page + 1)} />
            </div>
          )}
        </div>

      </SectionCard>
    </Page>
  )
}
