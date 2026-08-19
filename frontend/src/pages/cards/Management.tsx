import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { Page, SectionCard, DataTable, ErrBanner, ExpandableFilterBar, Modal, DateFilter } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtDatetime, monthStart, today } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Cardholder {
  cif_number: string
  customer_name: string
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
  Closed:           { bg: 'rgba(107,114,128,.1)', txt: 'var(--chart-lbl)' },
  Terminated:       { bg: 'rgba(192,0,0,.1)',     txt: RED },
  'Legal Suspended':{ bg: 'rgba(124,58,237,.1)',  txt: '#7C3AED' },
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
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
      width: 28, height: 28, borderRadius: RADIUS.sm,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? NAVY : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
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
            padding: '3px 12px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.semibold,
            background: isActive ? 'rgba(192,0,0,.08)' : 'rgba(22,163,74,.1)',
            color: isActive ? RED : GREEN,
          }}
        >
          {busy ? '…' : isActive ? 'Block' : 'Unblock'}
        </button>
        <button
          onClick={e => { e.stopPropagation(); openLog() }}
          style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer', fontSize: TEXT.xs, color: 'var(--txt2)' }}
          title="Block history"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 13, verticalAlign: 'middle' }}>history</span>
        </button>
      </div>

      {/* Block reason modal */}
      {showBlock && (
        <Modal open={showBlock} title={`Block card: ${row.cif_number}`} onClose={() => { setShowBlock(false); setReason('') }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, fontSize: TEXT.base, color: 'var(--txt2)' }}>
              This will block all card activity for <strong>{row.cif_number}</strong>. Provide a reason for audit.
            </p>
            <label style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              Reason <span style={{ color: RED }}>*</span>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                rows={3}
                value={reason}
                autoFocus
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. Suspected fraud, Customer request…"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, resize: 'vertical', boxSizing: 'border-box' }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowBlock(false); setReason('') }}
                style={{ padding: '7px 16px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer', fontSize: TEXT.base }}>
                Cancel
              </button>
              <button onClick={doBlock} disabled={busy || !reason.trim()}
                style={{ padding: '7px 16px', borderRadius: RADIUS.sm, border: 'none', cursor: (busy || !reason.trim()) ? 'not-allowed' : 'pointer', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, opacity: (busy || !reason.trim()) ? 0.6 : 1 }}>
                {busy ? 'Blocking…' : 'Confirm Block'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Block log modal */}
      {showLog && (
        <Modal open={showLog} title={`Block history: ${row.cif_number}`} onClose={() => setShowLog(false)}>
          {logLoading ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>Loading…</div>
          ) : log.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>No block history for this card</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {log.map(entry => (
                <div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{
                      fontSize: TEXT.xs, fontWeight: FW.bold, padding: '1px 8px', borderRadius: RADIUS['2xl'],
                      background: entry.is_blocked ? 'rgba(192,0,0,.1)' : 'rgba(22,163,74,.1)',
                      color: entry.is_blocked ? RED : GREEN,
                    }}>{entry.is_blocked ? 'Blocked' : 'Unblocked'}</span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDatetime(entry.created_at)}</span>
                  </div>
                  <div style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{entry.reason || '—'}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
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
          style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {r.cif_number}
        </span>
      ) },
    { key: 'customer_name', label: 'Cardholder',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{r.customer_name || '—'}</span> },
    { key: 'product_name', label: 'Product',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{r.product_name || '—'}</span> },
    { key: 'card_product', label: 'Card Programme',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: SORA }}>{r.card_product || '—'}</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'created_at', label: 'Issued Date', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span> },
    { key: '_actions', label: '', render: r => <ActionCell row={r} onDone={onDone} /> },
  ]
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

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [search,    setSearch]    = useState('')
  const [fStatuses, setFStatuses] = useState(new Set<string>())
  const [fProducts, setFProducts] = useState(new Set<string>())
  const [page, setPage] = useState(1)

  // Debounce the box and search on the SERVER (by CIF and cardholder name, phone-aware)
  // — the old code filtered the current page in-memory by CIF only, so a name query or a
  // cardholder on any other page was invisible.
  const debouncedSearch = useDebouncedValue(search, 300)

  const load = useCallback(async (pg = 1) => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      p.set('limit',  String(PAGE_SIZE))
      p.set('offset', String((pg - 1) * PAGE_SIZE))
      if (fStatuses.size)  p.set('status',    [...fStatuses].join(','))
      if (fProducts.size)  p.set('card_type', [...fProducts].join(','))
      if (debouncedSearch.trim()) p.set('q', debouncedSearch.trim())
      p.set('from', dateFrom)
      p.set('to',   dateTo)
      const res = await apiFetch<ListResp>(`/api/cards/cardholders?${p}`)
      setRows(res?.data ?? [])
      setTotal(res?.total ?? 0)
      setPage(pg)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [fStatuses, fProducts, dateFrom, dateTo, debouncedSearch])

  useEffect(() => { load(1) }, [load])

  const displayed = rows

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showStart  = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const showEnd    = Math.min(page * PAGE_SIZE, total)

  return (
    <Page title="Cardholder Management" subtitle="View and manage all issued cards" actions={
      <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
    }>

      <ErrBanner error={error} onRetry={() => load(page)} />

      <SectionCard title="Cardholders" badge={total} padding={false}>

        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'status',
              label: 'Status',
              options: STATUSES.map(s => ({ value: s, label: s, color: STATUS_COLORS[s]?.txt })),
              selected: fStatuses,
              onChange: setFStatuses,
            },
            {
              key: 'product',
              label: 'Product',
              options: PRODUCTS.map(p => ({ value: p })),
              selected: fProducts,
              onChange: setFProducts,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFStatuses(new Set()); setFProducts(new Set()) }}
          onApply={() => load(1)}
          resultCount={total}
          totalCount={total}
          placeholder="Search cardholders…"
        />

        <DataTable cols={makeCols(() => load(page), navigate)} rows={displayed} keyFn={r => r.cif_number} loading={loading} emptyText="No cardholders found" />

        {/* Pagination */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
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
