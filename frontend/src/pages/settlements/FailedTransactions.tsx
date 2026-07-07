import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, FilterBar, filterInputStyle, Modal, ConfirmModal, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { DataTable } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDatetime, fmtNum, today, monthStart } from '../../lib/fmt'
import { NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FailedTxn {
  id: number
  txn_ref: string
  amount_kobo: number
  customer_name: string | null
  channel: string
  failure_reason: string
  failed_at: string
  retry_count: number
}

// ── Channel pill ──────────────────────────────────────────────────────────────

function ChannelPill({ channel }: { channel: string }) {
  const ch = channel.toUpperCase()
  let bg: string, txt: string
  if (ch === 'NIP' || ch === 'NIBSS') {
    bg = 'rgba(37,99,235,.12)'; txt = '#2563EB'
  } else if (ch === 'CARD') {
    bg = 'rgba(124,58,237,.12)'; txt = '#7C3AED'
  } else if (ch === 'DIRECT') {
    bg = 'rgba(14,40,65,.1)'; txt = '#0E2841'
  } else {
    bg = 'var(--chip-bg)'; txt = 'var(--chip-txt)'
  }
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: bg, color: txt, whiteSpace: 'nowrap' }}>
      {channel}
    </span>
  )
}

// ── Resolve Manually Modal ────────────────────────────────────────────────────

interface ResolveModalProps {
  open: boolean
  rowId: number | null
  onClose: () => void
  onSuccess: () => void
}

function ResolveManuallyModal({ open, rowId, onClose, onSuccess }: ResolveModalProps) {
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    if (!rowId) return
    setSaving(true)
    try {
      await apiPost(`/api/settlements/failed/${rowId}/resolve`, { notes })
      toast.success('Transaction resolved manually')
      onSuccess()
      onClose()
      setNotes('')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to resolve transaction'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Resolve Manually" width={480}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{ padding: '7px 15px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Resolve'}
          </button>
        </div>
      }
    >
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Resolution Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe how this was resolved…" rows={4} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' }} />
      </div>
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const REASON_OPTIONS = [
  { value: '', label: 'All reasons' },
  { value: 'Insufficient Funds', label: 'Insufficient Funds' },
  { value: 'Account Not Found', label: 'Account Not Found' },
  { value: 'System Error', label: 'System Error' },
  { value: 'Timeout', label: 'Timeout' },
  { value: 'Duplicate', label: 'Duplicate' },
]

export default function FailedTransactions() {
  const [rows, setRows] = useState<FailedTxn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [reasonFilter, setReasonFilter] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [minNaira, setMinNaira] = useState('')
  const [maxNaira, setMaxNaira] = useState('')

  const [checkedIds, setCheckedIds] = useState<Set<string | number>>(new Set())

  const [retryRow, setRetryRow] = useState<FailedTxn | null>(null)
  const [resolveRow, setResolveRow] = useState<FailedTxn | null>(null)
  const [escalateRow, setEscalateRow] = useState<FailedTxn | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (reasonFilter) p.set('reason', reasonFilter)
      p.set('date_from', dateFrom)
      p.set('date_to', dateTo)
      p.set('limit', '100')
      const res = await apiFetch<{ data: FailedTxn[] }>(`/api/settlements/failed?${p.toString()}`)
      const sorted = [...(res.data ?? [])].sort((a, b) =>
        new Date(b.failed_at).getTime() - new Date(a.failed_at).getTime()
      )
      setRows(sorted)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load failed transactions'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [reasonFilter, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const minKobo = minNaira ? Number(minNaira) * 100 : null
    const maxKobo = maxNaira ? Number(maxNaira) * 100 : null
    return rows.filter(r => {
      if (minKobo !== null && r.amount_kobo < minKobo) return false
      if (maxKobo !== null && r.amount_kobo > maxKobo) return false
      return true
    })
  }, [rows, minNaira, maxNaira])

  async function handleRetry() {
    if (!retryRow) return
    setActionLoading(true)
    try {
      await apiPost(`/api/settlements/failed/${retryRow.id}/retry`, {})
      toast.success('Transaction queued for retry')
      setRetryRow(null)
      load()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Retry failed'
      toast.error(msg)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleEscalate() {
    if (!escalateRow) return
    setActionLoading(true)
    try {
      await apiPost(`/api/settlements/failed/${escalateRow.id}/escalate`, {})
      toast.success('Transaction escalated')
      setEscalateRow(null)
      load()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Escalation failed'
      toast.error(msg)
    } finally {
      setActionLoading(false)
    }
  }

  function handleExportCsv() {
    const toExport = checkedIds.size > 0 ? filtered.filter(r => checkedIds.has(r.id)) : filtered
    const header = ['Txn Ref', 'Amount (₦)', 'Customer', 'Channel', 'Failure Reason', 'Failed Date', 'Retry Count']
    const lines = toExport.map(r => [
      `"${String(r.txn_ref ?? '').replace(/"/g, '""')}"`,
      r.amount_kobo !== undefined ? (r.amount_kobo / 100).toFixed(2) : '',
      `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
      r.channel ?? '',
      `"${String(r.failure_reason ?? '').replace(/"/g, '""')}"`,
      r.failed_at ? r.failed_at.slice(0, 19).replace('T', ' ') : '',
      r.retry_count ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `failed-transactions-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const bulkBar = checkedIds.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{checkedIds.size} selected</span>
      <button onClick={handleExportCsv} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
        Export CSV
      </button>
    </div>
  ) : undefined

  const cols: TableCol<FailedTxn>[] = [
    {
      key: 'txn_ref', label: 'Txn Ref',
      render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: '#0E2841' }}>{r.txn_ref}</span>,
    },
    {
      key: 'amount_kobo', label: 'Amount ₦', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_kobo)}</span>,
    },
    {
      key: 'customer_name', label: 'Customer',
      render: r => <span style={{ color: 'var(--txt)' }}>{r.customer_name ?? '—'}</span>,
    },
    {
      key: 'channel', label: 'Channel',
      render: r => <ChannelPill channel={r.channel} />,
    },
    {
      key: 'failure_reason', label: 'Failure Reason',
      render: r => (
        <span
          title={r.failure_reason}
          style={{ fontSize: 12.5, color: 'var(--txt2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', maxWidth: 220 }}
        >
          {r.failure_reason.length > 40 ? r.failure_reason.slice(0, 40) + '…' : r.failure_reason}
        </span>
      ),
    },
    {
      key: 'failed_at', label: 'Failed Date',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDatetime(r.failed_at)}</span>,
    },
    {
      key: 'retry_count', label: 'Retry Count', align: 'right',
      render: r => <span style={{ ...NUM }}>{fmtNum(r.retry_count)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false, width: 240,
      render: r => (
        <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setRetryRow(r)}
            style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
          >
            Retry
          </button>
          <button
            onClick={() => setResolveRow(r)}
            style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
          >
            Resolve Manually
          </button>
          <button
            onClick={() => setEscalateRow(r)}
            style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
          >
            Escalate
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page title="Failed Transactions" subtitle="Investigate and action failed settlement transactions">
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Failed Transactions" badge={filtered.length} padding={false} actions={<button onClick={handleExportCsv} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setReasonFilter(''); setDateFrom(monthStart()); setDateTo(today()); setMinNaira(''); setMaxNaira('') }}>
            <select value={reasonFilter} onChange={e => setReasonFilter(e.target.value)} style={filterInputStyle}>
              {REASON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
            <input
              type="number"
              placeholder="Min ₦ (naira)"
              value={minNaira}
              onChange={e => setMinNaira(e.target.value)}
              style={{ ...filterInputStyle, minWidth: 110 }}
              min={0}
            />
            <input
              type="number"
              placeholder="Max ₦ (naira)"
              value={maxNaira}
              onChange={e => setMaxNaira(e.target.value)}
              style={{ ...filterInputStyle, minWidth: 110 }}
              min={0}
            />
            <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Apply</button>
          </FilterBar>
        </div>
        <DataTable
          cols={cols}
          rows={filtered}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No failed transactions found"
          pageSize={20}
          searchKeys={['txn_ref', 'customer_name', 'channel', 'failure_reason']}
          searchPlaceholder="Search ref, customer, channel…"
          selectable
          selectedIds={checkedIds}
          onSelect={setCheckedIds}
          bulkBar={bulkBar}
        />
      </SectionCard>

      <ConfirmModal
        open={retryRow !== null}
        title="Retry Transaction"
        body={`Retry transaction ${retryRow?.txn_ref ?? ''}? This will re-attempt the settlement.`}
        confirmLabel="Retry"
        loading={actionLoading}
        onConfirm={handleRetry}
        onClose={() => setRetryRow(null)}
      />

      <ConfirmModal
        open={escalateRow !== null}
        title="Escalate Transaction"
        body={`Escalate transaction ${escalateRow?.txn_ref ?? ''} to the settlement team?`}
        confirmLabel="Escalate"
        loading={actionLoading}
        onConfirm={handleEscalate}
        onClose={() => setEscalateRow(null)}
      />

      <ResolveManuallyModal
        open={resolveRow !== null}
        rowId={resolveRow?.id ?? null}
        onClose={() => setResolveRow(null)}
        onSuccess={load}
      />
    </Page>
  )
}
