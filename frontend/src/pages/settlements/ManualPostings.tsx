import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, FilterBar, filterInputStyle, StatusBadge, Modal, ConfirmModal, btnPrimary } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { DataTable } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { GREEN, RED, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManualPosting {
  id: number
  ref: string
  type: 'Credit' | 'Debit'
  amount_kobo: number
  account: string
  description: string
  initiated_by: string
  status: string
  created_at: string
}

// ── Type pill ─────────────────────────────────────────────────────────────────

function TypePill({ type }: { type: string }) {
  const isCredit = type === 'Credit'
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: isCredit ? 'rgba(22,163,74,.12)' : 'rgba(192,0,0,.1)', color: isCredit ? GREEN : RED, whiteSpace: 'nowrap' }}>
      {type}
    </span>
  )
}

// ── New Posting Modal ─────────────────────────────────────────────────────────

interface NewPostingModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

function NewPostingModal({ open, onClose, onSuccess }: NewPostingModalProps) {
  const [type, setType] = useState<'Credit' | 'Debit'>('Credit')
  const [amountNaira, setAmountNaira] = useState('')
  const [account, setAccount] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  function handleClose() {
    setType('Credit')
    setAmountNaira('')
    setAccount('')
    setDescription('')
    onClose()
  }

  async function handleSubmit() {
    if (!amountNaira || !account || !description) {
      toast.error('Please fill in all required fields')
      return
    }
    setSaving(true)
    try {
      const amount_kobo = Math.round(Number(amountNaira) * 100)
      await apiPost('/api/settlements/manual-postings', { type, amount_kobo, account, description })
      toast.success('Manual posting submitted for approval')
      onSuccess()
      handleClose()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to create manual posting'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="New Manual Posting" width={520}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={handleClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{ padding: '7px 15px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Submitting…' : 'Submit for Approval'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Type</label>
          <select value={type} onChange={e => setType(e.target.value as 'Credit' | 'Debit')} style={{ ...filterInputStyle, width: '100%', height: 36 }}>
            <option value="Credit">Credit</option>
            <option value="Debit">Debit</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Amount ₦ (naira)</label>
          <input
            type="number"
            value={amountNaira}
            onChange={e => setAmountNaira(e.target.value)}
            placeholder="0.00"
            min={0}
            step="0.01"
            style={{ ...filterInputStyle, width: '100%', height: 36, boxSizing: 'border-box' }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Account Number</label>
          <input
            type="text"
            value={account}
            onChange={e => setAccount(e.target.value)}
            placeholder="Enter account number"
            style={{ ...filterInputStyle, width: '100%', height: 36, boxSizing: 'border-box' }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Description</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Reason for manual posting…" rows={3} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Supporting Document (optional)</label>
          <input type="file" style={{ fontSize: 12.5, color: 'var(--txt2)' }} />
          <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--txt3)' }}>Upload supporting document (optional) — file upload not yet implemented</p>
        </div>
      </div>
    </Modal>
  )
}

// ── Reject Modal ──────────────────────────────────────────────────────────────

interface RejectModalProps {
  open: boolean
  rowId: number | null
  onClose: () => void
  onSuccess: () => void
}

function RejectModal({ open, rowId, onClose, onSuccess }: RejectModalProps) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    if (!rowId) return
    setSaving(true)
    try {
      await apiPut(`/api/settlements/manual-postings/${rowId}/reject`, { reason })
      toast.success('Posting rejected')
      onSuccess()
      onClose()
      setReason('')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to reject posting'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reject Posting" width={400}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{ padding: '7px 15px', borderRadius: 8, border: 'none', background: '#C00000', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Rejecting…' : 'Reject Posting'}
          </button>
        </div>
      }
    >
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Reason for Rejection</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain why this posting is being rejected…" rows={4} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' }} />
      </div>
    </Modal>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportManualPostingsCsv(rows: ManualPosting[]) {
  const header = ['Ref', 'Type', 'Amount (₦)', 'Account', 'Description', 'Initiated By', 'Status', 'Date']
  const lines = rows.map(r => [
    `"${String(r.ref ?? '').replace(/"/g, '""')}"`,
    r.type ?? '',
    r.amount_kobo !== undefined ? (r.amount_kobo / 100).toFixed(2) : '',
    `"${String(r.account ?? '').replace(/"/g, '""')}"`,
    `"${String(r.description ?? '').replace(/"/g, '""')}"`,
    `"${String(r.initiated_by ?? '').replace(/"/g, '""')}"`,
    r.status ?? '',
    r.created_at ? r.created_at.slice(0, 10) : '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `manual-postings-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ManualPostings() {
  const [rows, setRows] = useState<ManualPosting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('')
  const [initiatorSearch, setInitiatorSearch] = useState('')

  const [newPostingOpen, setNewPostingOpen] = useState(false)
  const [approveRow, setApproveRow] = useState<ManualPosting | null>(null)
  const [rejectRow, setRejectRow] = useState<ManualPosting | null>(null)
  const [approveLoading, setApproveLoading] = useState(false)

  // Role from localStorage
  const role = useMemo<string>(() => {
    try {
      return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? ''
    } catch {
      return ''
    }
  }, [])

  const isFinanceHead = role === 'finance_head'

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (statusFilter) p.set('status', statusFilter)
      if (initiatorSearch) p.set('q', initiatorSearch)
      p.set('limit', '100')
      const res = await apiFetch<{ data: ManualPosting[] }>(`/api/settlements/manual-postings?${p.toString()}`)
      setRows(res.data ?? [])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load manual postings'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, initiatorSearch])

  useEffect(() => { load() }, [load])

  async function handleApprove() {
    if (!approveRow) return
    setApproveLoading(true)
    try {
      await apiPut(`/api/settlements/manual-postings/${approveRow.id}/approve`, {})
      toast.success('Posting approved')
      setApproveRow(null)
      load()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Approval failed'
      toast.error(msg)
    } finally {
      setApproveLoading(false)
    }
  }

  function exportPostingsCsv(data: ManualPosting[]) {
    const header = ['Ref', 'Type', 'Amount ₦', 'Account', 'Description', 'Initiated By', 'Status', 'Date']
    const lines = data.map(r => [
      r.ref ?? '',
      r.type ?? '',
      (r.amount_kobo / 100).toFixed(2),
      `"${String(r.account ?? '').replace(/"/g, '""')}"`,
      `"${String(r.description ?? '').replace(/"/g, '""')}"`,
      `"${String(r.initiated_by ?? '').replace(/"/g, '""')}"`,
      r.status ?? '',
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `manual-postings-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols: TableCol<ManualPosting>[] = [
    {
      key: 'ref', label: 'Ref',
      render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: '#0E2841' }}>{r.ref}</span>,
    },
    {
      key: 'type', label: 'Type',
      render: r => <TypePill type={r.type} />,
    },
    {
      key: 'amount_kobo', label: 'Amount ₦', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_kobo)}</span>,
    },
    {
      key: 'account', label: 'Account',
      render: r => <span style={{ ...NUM, fontSize: 12.5, color: 'var(--txt2)' }}>{r.account}</span>,
    },
    {
      key: 'description', label: 'Description',
      render: r => (
        <span title={r.description} style={{ fontSize: 12.5, color: 'var(--txt)', display: 'block', maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.description}
        </span>
      ),
    },
    {
      key: 'initiated_by', label: 'Initiated By',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.initiated_by}</span>,
    },
    {
      key: 'created_at', label: 'Date',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
    ...(isFinanceHead ? [{
      key: '_actions',
      label: '',
      sortable: false,
      width: 160,
      render: (r: ManualPosting) => {
        if (r.status.toLowerCase() !== 'pending approval') return null
        return (
          <div style={{ display: 'flex', gap: 5 }} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <button
              onClick={() => setApproveRow(r)}
              style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: 'rgba(22,163,74,.12)', color: GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Approve
            </button>
            <button
              onClick={() => setRejectRow(r)}
              style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: 'rgba(192,0,0,.1)', color: '#C00000', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Reject
            </button>
          </div>
        )
      },
    }] as TableCol<ManualPosting>[] : []),
  ]

  return (
    <Page
      title="Manual Postings"
      subtitle="Review and approve manual journal entries"
      actions={
        !isFinanceHead ? (
          <button onClick={() => setNewPostingOpen(true)} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Posting
          </button>
        ) : undefined
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Manual Postings" badge={rows.length} padding={false}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setStatusFilter(''); setInitiatorSearch('') }}>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
              <option value="">All statuses</option>
              <option value="Pending Approval">Pending Approval</option>
              <option value="Approved">Approved</option>
              <option value="Rejected">Rejected</option>
            </select>
            <input
              type="text"
              value={initiatorSearch}
              onChange={e => setInitiatorSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              placeholder="Search initiator…"
              style={{ ...filterInputStyle, minWidth: 180 }}
            />
            <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Apply</button>
          </FilterBar>
        </div>
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No manual postings found"
          searchKeys={['ref', 'account', 'description', 'initiated_by', 'status']}
          searchPlaceholder="Search ref, account, description…"
          pageSize={20}
          onExport={() => exportPostingsCsv(rows)}
        />
      </SectionCard>

      <NewPostingModal
        open={newPostingOpen}
        onClose={() => setNewPostingOpen(false)}
        onSuccess={load}
      />

      <ConfirmModal
        open={approveRow !== null}
        title="Approve Posting"
        body={`Approve posting ${approveRow?.ref ?? ''}? This will post the entry to the ledger.`}
        confirmLabel="Approve"
        loading={approveLoading}
        onConfirm={handleApprove}
        onClose={() => setApproveRow(null)}
      />

      <RejectModal
        open={rejectRow !== null}
        rowId={rejectRow?.id ?? null}
        onClose={() => setRejectRow(null)}
        onSuccess={load}
      />
    </Page>
  )
}
