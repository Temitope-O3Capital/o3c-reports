import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, StatusBadge, FilterBar, filterInputStyle, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Batch {
  id: number
  batch_date: string
  batch_ref: string
  batch_type: string
  total_credits: number
  total_debits: number
  txn_count: number
  exception_count: number
  status: string
}

interface Exception {
  id: number
  batch_id: number
  txn_date: string
  txn_ref: string
  amount_kobo: number
  exception_type: string
  description: string
  status: string
  batch_ref: string
  resolved_by_name: string
  resolved_at: string
  resolution_note: string
}

// ── Exception columns ─────────────────────────────────────────────────────────

function ExcCols(onResolve: (ex: Exception) => void): TableCol<Exception>[] {
  return [
    { key: 'txn_date', label: 'Date', width: 100,
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.txn_date)}</span> },
    { key: 'txn_ref', label: 'Ref',
      render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.txn_ref || '—'}</span> },
    { key: 'batch_ref', label: 'Batch',
      render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.batch_ref || '—'}</span> },
    { key: 'amount_kobo', label: 'Amount ₦', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'exception_type', label: 'Type',
      render: r => (
        <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
          background: 'rgba(192,0,0,0.08)', color: RED }}>
          {r.exception_type.replace(/_/g, ' ')}
        </span>
      )},
    { key: 'description', label: 'Description',
      render: r => <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240, fontSize: 12.5 }}>{r.description || '—'}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: '_actions', label: '', render: r => r.status === 'open' ? (
      <button onClick={e => { e.stopPropagation(); onResolve(r) }}
        style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(22,163,74,.1)',
          color: GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
        Resolve
      </button>
    ) : null },
  ]
}

// ── Batch summary columns ─────────────────────────────────────────────────────

const BATCH_COLS: TableCol<Batch>[] = [
  { key: 'batch_date', label: 'Date', width: 110,
    render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.batch_date)}</span> },
  { key: 'batch_ref', label: 'Ref',
    render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.batch_ref || '—'}</span> },
  { key: 'txn_count', label: 'Txns', align: 'right',
    render: r => <span style={NUM}>{r.txn_count.toLocaleString()}</span> },
  { key: 'total_credits', label: 'Credits ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: GREEN, fontWeight: 600 }}>{fmtKobo(r.total_credits)}</span> },
  { key: 'total_debits', label: 'Debits ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: RED, fontWeight: 600 }}>{fmtKobo(r.total_debits)}</span> },
  { key: 'exception_count', label: 'Exceptions', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: 600, color: r.exception_count > 0 ? AMBER : 'var(--txt2)' }}>{r.exception_count}</span> },
  { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
]

// ── Resolve modal ─────────────────────────────────────────────────────────────

function ResolveModal({ ex, onClose, onDone }: { ex: Exception; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      await apiPost(`/api/settlements/nip-recon/exceptions/${ex.id}/resolve`, { note })
      toast.success('Exception resolved')
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: 14, padding: 24, width: 440, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>Resolve Exception</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: 18 }}>×</button>
        </div>
        <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--bg)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--txt2)' }}>Ref</span>
            <span style={{ ...NUM, fontSize: 12, fontWeight: 600 }}>{ex.txn_ref || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--txt2)' }}>Amount</span>
            <span style={{ ...NUM, fontSize: 12, fontWeight: 600 }}>{fmtKobo(ex.amount_kobo)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'var(--txt2)' }}>Type</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: RED }}>{ex.exception_type.replace(/_/g, ' ')}</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Resolution Note</label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={3}
            placeholder="Describe how this exception was resolved…"
            style={{ ...filterInputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Mark Resolved'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NIPReconciliation() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [exceptions, setExceptions] = useState<Exception[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'exceptions' | 'batches'>('exceptions')
  const [statusFilter, setStatusFilter] = useState('open')
  const [date, setDate] = useState(today())
  const [resolving, setResolving] = useState<Exception | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (date) qs.set('date', date)
      if (statusFilter) qs.set('status', statusFilter)
      const res = await apiFetch<{ batches: Batch[]; exceptions: Exception[] }>(`/api/settlements/nip-recon?${qs}`)
      setBatches(res?.batches ?? [])
      setExceptions(res?.exceptions ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [date, statusFilter])

  useEffect(() => { load() }, [load])

  const excCols = ExcCols(setResolving)
  const openCount = exceptions.filter(e => e.status === 'open').length
  const totalExcAmount = exceptions.reduce((s, e) => s + e.amount_kobo, 0)

  function exportExceptionsCsv(data: Exception[]) {
    const header = ['Date', 'Txn Ref', 'Batch Ref', 'Amount ₦', 'Exception Type', 'Description', 'Status', 'Resolved By', 'Resolved At']
    const lines = data.map(r => [
      r.txn_date ?? '',
      r.txn_ref ?? '',
      r.batch_ref ?? '',
      (r.amount_kobo / 100).toFixed(2),
      r.exception_type ?? '',
      `"${String(r.description ?? '').replace(/"/g, '""')}"`,
      r.status ?? '',
      `"${String(r.resolved_by_name ?? '').replace(/"/g, '""')}"`,
      r.resolved_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `nip-exceptions-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  function exportBatchesCsv(data: Batch[]) {
    const header = ['Date', 'Batch Ref', 'Type', 'Txns', 'Credits ₦', 'Debits ₦', 'Exceptions', 'Status']
    const lines = data.map(r => [
      r.batch_date ?? '',
      r.batch_ref ?? '',
      r.batch_type ?? '',
      r.txn_count ?? 0,
      (r.total_credits / 100).toFixed(2),
      (r.total_debits / 100).toFixed(2),
      r.exception_count ?? 0,
      r.status ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `nip-batches-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="NIP Reconciliation"
      subtitle="Daily NIP inflows vs core banking credits — flag and resolve exceptions"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Open Exceptions</div>
          <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: openCount > 0 ? RED : GREEN }}>{openCount}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Exception Value</div>
          <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>{fmtKobo(totalExcAmount)}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Batches on Date</div>
          <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>{batches.length}</div>
        </div>
      </div>

      {/* Filters */}
      <FilterBar onReset={() => { setStatusFilter('open'); setDate(today()) }}>
        <DateFilter from={date} to={date} onChange={(f, _t) => setDate(f)} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="open">Open exceptions</option>
          <option value="resolved">Resolved</option>
          <option value="">All</option>
        </select>
        <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Apply</button>
      </FilterBar>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--bdr)', marginBottom: 16 }}>
        {(['exceptions', 'batches'] as const).map(t => {
          const labels = { exceptions: `Exceptions (${exceptions.length})`, batches: `Batch Summary (${batches.length})` }
          const active = tab === t
          return (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '8px 14px', fontSize: 13, fontWeight: active ? 600 : 500,
              color: active ? 'var(--txt)' : 'var(--txt2)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: active ? `2px solid ${RED}` : '2px solid transparent',
              marginBottom: -1,
            }}>{labels[t]}</button>
          )
        })}
      </div>

      {tab === 'exceptions' && (
        <SectionCard padding={false} actions={<button onClick={() => exportExceptionsCsv(exceptions)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
          <DataTable
            cols={excCols}
            rows={exceptions}
            keyFn={r => r.id}
            loading={loading}
            emptyText="No exceptions for this date/filter"
            searchKeys={['txn_ref', 'batch_ref', 'exception_type', 'status']}
            searchPlaceholder="Search ref, type, status…"
            pageSize={20}
          />
        </SectionCard>
      )}

      {tab === 'batches' && (
        <SectionCard padding={false} actions={<button onClick={() => exportBatchesCsv(batches)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
          <DataTable
            cols={BATCH_COLS}
            rows={batches}
            keyFn={r => r.id}
            loading={loading}
            emptyText="No batches found"
            searchKeys={['batch_ref', 'batch_type', 'status']}
            searchPlaceholder="Search ref, type, status…"
            pageSize={20}
          />
        </SectionCard>
      )}

      {resolving && (
        <ResolveModal
          ex={resolving}
          onClose={() => setResolving(null)}
          onDone={() => { setResolving(null); load() }}
        />
      )}
    </Page>
  )
}
