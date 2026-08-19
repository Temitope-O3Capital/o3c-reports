import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, ExpandableFilterBar, Modal, ConfirmModal, DateFilter, NameCell, ActionRow } from '../../components/UI'
import type { TableCol, RowAction } from '../../components/UI'
import { DataTable } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDatetime, fmtNum, today, monthStart } from '../../lib/fmt'
import { NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
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
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: bg, color: txt, whiteSpace: 'nowrap' }}>
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
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{ padding: '7px 15px', borderRadius: RADIUS.md, border: 'none', background: '#0E2841', color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Resolve'}
          </button>
        </div>
      }
    >
      <div>
        <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Resolution Notes</label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe how this was resolved…" rows={4} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' }} />
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

  const [fReasons, setFReasons] = useState<Set<string>>(new Set())
  const [search,   setSearch]   = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const [checkedIds, setCheckedIds] = useState<Set<string | number>>(new Set())

  const [retryRow, setRetryRow] = useState<FailedTxn | null>(null)
  const [resolveRow, setResolveRow] = useState<FailedTxn | null>(null)
  const [escalateRow, setEscalateRow] = useState<FailedTxn | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (fReasons.size) p.set('reason', [...fReasons].join(','))
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
  }, [fReasons, dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['settlement_exceptions'] })

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      (r.txn_ref ?? '').toLowerCase().includes(q) ||
      (r.customer_name ?? '').toLowerCase().includes(q) ||
      (r.channel ?? '').toLowerCase().includes(q) ||
      (r.failure_reason ?? '').toLowerCase().includes(q)
    )
  }, [rows, search])

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


  const bulkBar = checkedIds.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{checkedIds.size} selected</span>
      </div>
  ) : undefined

  const cols: TableCol<FailedTxn>[] = [
    {
      key: 'txn_ref', label: 'Transaction',
      render: r => <NameCell name={r.customer_name ?? r.txn_ref} sub={r.txn_ref} avatar={false} />,
    },
    {
      key: 'amount_kobo', label: 'Amount NGN', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.amount_kobo)}</span>,
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
          style={{ fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', maxWidth: 220 }}
        >
          {r.failure_reason.length > 40 ? r.failure_reason.slice(0, 40) + '…' : r.failure_reason}
        </span>
      ),
    },
    {
      key: 'failed_at', label: 'Failed Date',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.failed_at)}</span>,
    },
    {
      key: 'retry_count', label: 'Retries', align: 'right',
      render: r => <span style={{ ...NUM }}>{fmtNum(r.retry_count)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: r => (
        <ActionRow actions={[
          { icon: 'refresh', label: 'Retry', onClick: () => setRetryRow(r) },
          { icon: 'check_circle', label: 'Resolve Manually', onClick: () => setResolveRow(r) },
          { icon: 'escalator_warning', label: 'Escalate', onClick: () => setEscalateRow(r) },
        ] satisfies RowAction[]} />
      ),
    },
  ]

  return (
    <Page
      title="Failed Transactions"
      subtitle="Investigate and action failed settlement transactions"
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Failed Transactions" badge={filtered.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[{
            key: 'reason', label: 'Failure Reason',
            options: REASON_OPTIONS.filter(o => o.value).map(o => ({ value: o.value, label: o.label })),
            selected: fReasons,
            onChange: setFReasons,
          }]}
          onReset={() => { setFReasons(new Set()); setSearch('') }}
          onApply={load}
          resultCount={filtered.length}
          totalCount={rows.length}
          placeholder="Search ref, customer, channel…"
        />
        <DataTable
          cols={cols}
          rows={filtered}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No failed transactions found"
          pageSize={20}
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
