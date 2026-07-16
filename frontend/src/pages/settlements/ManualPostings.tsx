import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, FilterBar, filterInputStyle, StatusBadge, Modal, ConfirmModal, btnPrimary } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { DataTable } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { roleLabel } from '../../lib/roles'
import type { WorkflowTemplate } from '../admin/WorkflowTemplates'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManualPosting {
  id: number
  ref: string
  workflow_template_id: number | null
  workflow_template_name: string | null
  type: 'Credit' | 'Debit'
  amount_kobo: number
  account: string
  description: string
  initiated_by: string
  stage: 'pending_approval' | 'approved' | 'posted' | 'rejected' | 'returned'
  approver_roles: string[]
  poster_roles: string[]
  approved_by: string | null
  approved_at: string | null
  posted_by: string | null
  posted_at: string | null
  rejected_by: string | null
  rejected_at: string | null
  rejection_reason: string | null
  created_at: string
}

// ── Stage stepper ─────────────────────────────────────────────────────────────

const STAGES = [
  { key: 'pending_approval', label: 'Raised' },
  { key: 'approved',         label: 'Approved' },
  { key: 'posted',           label: 'Posted' },
] as const

function StageStepper({ stage }: { stage: ManualPosting['stage'] }) {
  const rejected = stage === 'rejected' || stage === 'returned'
  const currentIdx = STAGES.findIndex(s => s.key === stage)
  const effectiveIdx = rejected ? 0 : currentIdx  // rejected always at step 0 visually

  const stageLabel: Record<string, { label: string; color: string }> = {
    pending_approval: { label: 'Pending Approval', color: AMBER },
    approved:         { label: 'Approved — Pending Posting', color: NAVY },
    posted:           { label: 'Posted', color: GREEN },
    rejected:         { label: 'Rejected', color: RED },
    returned:         { label: 'Returned', color: AMBER },
  }
  const { label: stageText, color: stageColor } = stageLabel[stage] ?? { label: stage, color: 'var(--txt2)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        {STAGES.map((s, i) => {
          const done   = !rejected && i < currentIdx
          const active = !rejected && i === currentIdx
          const bad    = rejected && i === 0
          const dotColor = bad ? RED : done ? GREEN : active ? NAVY : 'var(--bdr)'
          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div title={s.label} style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
              {i < STAGES.length - 1 && <div style={{ width: 14, height: 2, background: done ? GREEN : 'var(--bdr)', borderRadius: 1 }} />}
            </div>
          )
        })}
      </div>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: stageColor }}>{stageText}</span>
    </div>
  )
}

// ── Type pill ─────────────────────────────────────────────────────────────────

function TypePill({ type }: { type: string }) {
  const isCredit = type === 'Credit'
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: isCredit ? 'rgba(22,163,74,.12)' : 'rgba(192,0,0,.1)', color: isCredit ? GREEN : RED, whiteSpace: 'nowrap' }}>
      {type}
    </span>
  )
}

// ── Reason modal (reject / return) ────────────────────────────────────────────

function ReasonModal({ open, title, confirmLabel, confirmColor, onClose, onSubmit, saving }: {
  open: boolean; title: string; confirmLabel: string; confirmColor: string;
  onClose: () => void; onSubmit: (reason: string) => void; saving: boolean
}) {
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) setReason('') }, [open])
  return (
    <Modal open={open} onClose={onClose} title={title} width={420}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => onSubmit(reason)} disabled={saving || !reason.trim()}
            style={{ padding: '7px 15px', borderRadius: RADIUS.md, border: 'none', background: confirmColor, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving || !reason.trim() ? 'not-allowed' : 'pointer', opacity: saving || !reason.trim() ? 0.6 : 1 }}>
            {saving ? 'Saving…' : confirmLabel}
          </button>
        </div>
      }
    >
      <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={reason} onChange={e => setReason(e.target.value)} rows={4} placeholder="Write a reason…"
        style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' }} />
    </Modal>
  )
}

// ── New Posting modal ─────────────────────────────────────────────────────────

function NewPostingModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [templates, setTemplates]         = useState<WorkflowTemplate[]>([])
  const [templateId, setTemplateId]       = useState<number | ''>('')
  const [type, setType]                   = useState<'Credit' | 'Debit'>('Credit')
  const [amountNaira, setAmountNaira]     = useState('')
  const [account, setAccount]             = useState('')
  const [description, setDescription]     = useState('')
  const [saving, setSaving]               = useState(false)

  useEffect(() => {
    if (open) {
      apiFetch<WorkflowTemplate[]>('/api/admin/workflow-templates')
        .then(r => setTemplates(r ?? []))
        .catch(() => setTemplates([]))
      setTemplateId('')
      setType('Credit')
      setAmountNaira('')
      setAccount('')
      setDescription('')
    }
  }, [open])

  const selectedTemplate = templates.find(t => t.id === templateId) ?? null

  async function handleSubmit() {
    if (!templateId) { toast.error('Select a workflow template'); return }
    if (!amountNaira || !account || !description) { toast.error('Fill in all required fields'); return }
    setSaving(true)
    try {
      const amount_kobo = Math.round(Number(amountNaira) * 100)
      await apiPost('/api/settlements/manual-postings', { workflow_template_id: templateId, type, amount_kobo, account, description })
      toast.success('Manual posting submitted for approval')
      onSuccess()
      onClose()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Submit failed')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box',
    border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: TEXT.base,
    background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none',
  }

  return (
    <Modal open={open} onClose={onClose} title="New Manual Posting" width={540}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Submitting…' : 'Submit for Approval'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Template selector */}
        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Approval Workflow *</label>
          <select value={templateId} onChange={e => setTemplateId(Number(e.target.value) || '')}
            style={{ ...inputStyle, appearance: 'auto' }}>
            <option value="">Select a workflow template…</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        {/* Template summary */}
        {selectedTemplate && (
          <div style={{ padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)', border: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {selectedTemplate.description && <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: '0 0 4px' }}>{selectedTemplate.description}</p>}
            {[
              { label: 'Notified', roles: selectedTemplate.notify_roles, color: AMBER },
              { label: 'Approver', roles: selectedTemplate.approver_roles, color: NAVY },
              { label: 'Poster',   roles: selectedTemplate.poster_roles,   color: GREEN },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.05em', color: row.color, width: 52, flexShrink: 0, marginTop: 2 }}>{row.label}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  {row.roles.length === 0
                    ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontStyle: 'italic' }}>—</span>
                    : row.roles.map(r => (
                      <span key={r} style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, padding: '1px 6px', borderRadius: 5, background: `${row.color}12`, color: row.color }}>{roleLabel(r)}</span>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Posting details */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Type *</label>
            <select value={type} onChange={e => setType(e.target.value as 'Credit' | 'Debit')} style={{ ...inputStyle, appearance: 'auto' }}>
              <option value="Credit">Credit</option>
              <option value="Debit">Debit</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Amount ₦ (naira) *</label>
            <input type="number" value={amountNaira} onChange={e => setAmountNaira(e.target.value)}
              placeholder="0.00" min={0} step="0.01" style={inputStyle} />
          </div>
        </div>

        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Account Number *</label>
          <input type="text" value={account} onChange={e => setAccount(e.target.value)}
            placeholder="Enter account number" style={inputStyle} />
        </div>

        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Description *</label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={description} onChange={e => setDescription(e.target.value)} rows={3}
            placeholder="Reason for manual posting…"
            style={{ ...inputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical', fontFamily: "'Sora', sans-serif" }} />
        </div>

        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Supporting Document (optional)</label>
          <input type="file" style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }} />
          <p style={{ margin: '4px 0 0', fontSize: TEXT.xs, color: 'var(--txt3)' }}>File upload not yet implemented</p>
        </div>
      </div>
    </Modal>
  )
}

// ── Post confirmation modal ───────────────────────────────────────────────────

function PostConfirmModal({ posting, onClose, onDone }: { posting: ManualPosting | null; onClose: () => void; onDone: () => void }) {
  const [saving, setSaving] = useState(false)
  if (!posting) return null

  async function handlePost() {
    const p = posting
    if (!p) return
    setSaving(true)
    try {
      await apiPut(`/api/settlements/manual-postings/${p.id}/post`, {})
      toast.success('Posting executed to ledger')
      onDone()
      onClose()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Post failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfirmModal
      open
      title="Post to Ledger"
      body={`Post ${posting.ref} — ${posting.type} of ${fmtKobo(posting.amount_kobo)} to account ${posting.account}? This will write to the core banking ledger.`}
      confirmLabel="Post to Ledger"
      loading={saving}
      onConfirm={handlePost}
      onClose={onClose}
    />
  )
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

function DetailModal({ posting, onClose }: { posting: ManualPosting | null; onClose: () => void }) {
  if (!posting) return null

  function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--bdr)' }}>
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{label}</span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', textAlign: 'right', maxWidth: '60%' }}>{value}</span>
      </div>
    )
  }

  const stageColor: Record<string, string> = { pending_approval: AMBER, approved: NAVY, posted: GREEN, rejected: RED, returned: AMBER }

  return (
    <Modal open onClose={onClose} title={`Posting ${posting.ref}`} width={480}
      footer={<button onClick={onClose} style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Close</button>}
    >
      {/* Stage stepper */}
      <div style={{ marginBottom: SP[4], padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
        <StageStepper stage={posting.stage} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Row label="Reference" value={<span style={NUM}>{posting.ref}</span>} />
        <Row label="Type" value={<TypePill type={posting.type} />} />
        <Row label="Amount" value={<span style={{ ...NUM, fontWeight: 700 }}>{fmtKobo(posting.amount_kobo)}</span>} />
        <Row label="Account" value={<span style={NUM}>{posting.account}</span>} />
        <Row label="Description" value={posting.description} />
        <Row label="Workflow" value={posting.workflow_template_name ?? '—'} />
        <Row label="Initiated by" value={posting.initiated_by} />
        <Row label="Raised on" value={fmtDate(posting.created_at)} />

        {posting.approved_by && <Row label="Approved by" value={`${posting.approved_by} on ${fmtDate(posting.approved_at)}`} />}
        {posting.posted_by && <Row label="Posted by" value={`${posting.posted_by} on ${fmtDate(posting.posted_at)}`} />}
        {posting.rejected_by && <Row label="Rejected by" value={`${posting.rejected_by} on ${fmtDate(posting.rejected_at)}`} />}
        {posting.rejection_reason && (
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 7, background: 'rgba(192,0,0,0.06)', border: '1px solid rgba(192,0,0,0.12)' }}>
            <p style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: RED, margin: '0 0 3px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reason for {posting.stage}</p>
            <p style={{ fontSize: TEXT.sm, color: 'var(--txt)', margin: 0 }}>{posting.rejection_reason}</p>
          </div>
        )}

        {/* Roles */}
        <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'var(--th-bg)' }}>
          {[
            { label: 'Approver roles', roles: posting.approver_roles, color: NAVY },
            { label: 'Poster roles',   roles: posting.poster_roles,   color: GREEN },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: row.color, width: 90, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>{row.label}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {row.roles.map(r => (
                  <span key={r} style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, padding: '1px 6px', borderRadius: 5, background: `${row.color}12`, color: row.color }}>{roleLabel(r)}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ManualPostings() {
  const [rows, setRows]           = useState<ManualPosting[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [initiatorSearch, setInitiatorSearch] = useState('')

  const [newOpen, setNewOpen]             = useState(false)
  const [detail, setDetail]               = useState<ManualPosting | null>(null)
  const [approveRow, setApproveRow]       = useState<ManualPosting | null>(null)
  const [rejectRow, setRejectRow]         = useState<ManualPosting | null>(null)
  const [postRow, setPostRow]             = useState<ManualPosting | null>(null)
  const [returnRow, setReturnRow]         = useState<ManualPosting | null>(null)
  const [actionSaving, setActionSaving]   = useState(false)
  const [confirmApprove, setConfirmApprove] = useState<ManualPosting | null>(null)
  const [approveLoading, setApproveLoading] = useState(false)

  const role = useMemo<string>(() => {
    try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (statusFilter)     p.set('stage', statusFilter)
      if (initiatorSearch)  p.set('q', initiatorSearch)
      p.set('limit', '100')
      const res = await apiFetch<{ data: ManualPosting[] }>(`/api/settlements/manual-postings?${p}`)
      setRows(res.data ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, initiatorSearch])

  useEffect(() => { load() }, [load])

  async function handleApprove() {
    if (!confirmApprove) return
    setApproveLoading(true)
    try {
      await apiPut(`/api/settlements/manual-postings/${confirmApprove.id}/approve`, {})
      toast.success('Posting approved — now awaiting posting to ledger')
      setConfirmApprove(null)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setApproveLoading(false)
    }
  }

  async function handleReject(reason: string) {
    if (!rejectRow) return
    setActionSaving(true)
    try {
      await apiPut(`/api/settlements/manual-postings/${rejectRow.id}/reject`, { reason })
      toast.success('Posting rejected')
      setRejectRow(null)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Reject failed')
    } finally {
      setActionSaving(false)
    }
  }

  async function handleReturn(reason: string) {
    if (!returnRow) return
    setActionSaving(true)
    try {
      await apiPut(`/api/settlements/manual-postings/${returnRow.id}/return`, { reason })
      toast.success('Posting returned for revision')
      setReturnRow(null)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Return failed')
    } finally {
      setActionSaving(false)
    }
  }

  function exportCsv(data: ManualPosting[]) {
    const header = ['Ref', 'Workflow', 'Type', 'Amount (₦)', 'Account', 'Description', 'Initiated By', 'Stage', 'Date']
    const lines = data.map(r => [
      `"${String(r.ref ?? '').replace(/"/g, '""')}"`,
      `"${String(r.workflow_template_name ?? '').replace(/"/g, '""')}"`,
      r.type ?? '',
      r.amount_kobo !== undefined ? (r.amount_kobo / 100).toFixed(2) : '',
      `"${String(r.account ?? '').replace(/"/g, '""')}"`,
      `"${String(r.description ?? '').replace(/"/g, '""')}"`,
      `"${String(r.initiated_by ?? '').replace(/"/g, '""')}"`,
      r.stage ?? '',
      r.created_at ? r.created_at.slice(0, 10) : '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `manual-postings-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const isSettlementOfficer = !['finance_head', 'cfo', 'treasury_officer', 'finance_officer'].includes(role)

  const cols: TableCol<ManualPosting>[] = [
    {
      key: 'ref', label: 'Ref',
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, cursor: 'pointer' }} onClick={() => setDetail(r)}>{r.ref}</span>,
    },
    {
      key: 'workflow_template_name', label: 'Workflow',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.workflow_template_name ?? '—'}</span>,
    },
    {
      key: 'type', label: 'Type',
      render: r => <TypePill type={r.type} />,
    },
    {
      key: 'amount_kobo', label: 'Amount ₦', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.amount_kobo)}</span>,
    },
    {
      key: 'account', label: 'Account',
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.account}</span>,
    },
    {
      key: 'description', label: 'Description',
      render: r => <span title={r.description} style={{ fontSize: TEXT.sm, color: 'var(--txt)', display: 'block', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.description}</span>,
    },
    {
      key: 'initiated_by', label: 'Raised by',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.initiated_by}</span>,
    },
    {
      key: 'created_at', label: 'Date',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'stage', label: 'Stage', width: 140,
      render: r => <StageStepper stage={r.stage} />,
    },
    {
      key: '_actions', label: '', sortable: false, width: 180,
      render: (r) => {
        const canApprove = r.stage === 'pending_approval' && r.approver_roles.includes(role)
        const canPost    = r.stage === 'approved'         && r.poster_roles.includes(role)
        if (!canApprove && !canPost) return null

        return (
          <div style={{ display: 'flex', gap: SP[1] }} onClick={e => e.stopPropagation()}>
            {canApprove && (
              <>
                <button onClick={() => setConfirmApprove(r)}
                  style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: 'none', background: 'rgba(22,163,74,.12)', color: GREEN, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  Approve
                </button>
                <button onClick={() => setRejectRow(r)}
                  style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: 'none', background: 'rgba(192,0,0,.1)', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                  Reject
                </button>
              </>
            )}
            {canPost && (
              <>
                <button onClick={() => setPostRow(r)}
                  style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: 'none', background: `${NAVY}12`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                  Post
                </button>
                <button onClick={() => setReturnRow(r)}
                  style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: 'none', background: 'rgba(217,119,6,.12)', color: AMBER, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                  Return
                </button>
              </>
            )}
          </div>
        )
      },
    },
  ]

  // Stage filter options
  const STAGE_OPTIONS = [
    { value: '',                label: 'All stages' },
    { value: 'pending_approval',label: 'Pending Approval' },
    { value: 'approved',        label: 'Approved — Pending Posting' },
    { value: 'posted',          label: 'Posted' },
    { value: 'rejected',        label: 'Rejected' },
    { value: 'returned',        label: 'Returned' },
  ]

  const pendingCount = rows.filter(r => {
    if (r.stage === 'pending_approval' && r.approver_roles.includes(role)) return true
    if (r.stage === 'approved' && r.poster_roles.includes(role)) return true
    return false
  }).length

  return (
    <Page
      title="Manual Postings"
      subtitle="Three-stage approval workflow for ledger corrections — raise, approve, post"
      actions={
        isSettlementOfficer ? (
          <button onClick={() => setNewOpen(true)} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
            New Posting
          </button>
        ) : undefined
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Action required banner */}
      {pendingCount > 0 && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: RADIUS.lg, background: `${AMBER}10`, border: `1px solid ${AMBER}30`, marginBottom: SP[4], alignItems: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: AMBER, flexShrink: 0 }}>pending_actions</span>
          <p style={{ fontSize: TEXT.base, color: 'var(--txt)', margin: 0 }}>
            <strong>{pendingCount} posting{pendingCount > 1 ? 's' : ''}</strong> require your action.
          </p>
        </div>
      )}

      <SectionCard title="Manual Postings" badge={rows.length} padding={false} actions={<button onClick={() => exportCsv(rows)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setStatusFilter(''); setInitiatorSearch('') }}>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
              {STAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="text" value={initiatorSearch} onChange={e => setInitiatorSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              placeholder="Search initiator…" style={{ ...filterInputStyle, minWidth: 160 }} />
            <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>Apply</button>
          </FilterBar>
        </div>
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No manual postings found"
          searchKeys={['ref', 'account', 'description', 'initiated_by', 'workflow_template_name', 'stage']}
          searchPlaceholder="Search ref, account, workflow…"
          pageSize={20}
        />
      </SectionCard>

      {/* Modals */}
      <NewPostingModal open={newOpen} onClose={() => setNewOpen(false)} onSuccess={load} />

      <DetailModal posting={detail} onClose={() => setDetail(null)} />

      <ConfirmModal
        open={confirmApprove !== null}
        title="Approve Posting"
        body={`Approve ${confirmApprove?.ref ?? ''}? This moves it to the posting stage — a poster will then execute it to the ledger.`}
        confirmLabel="Approve"
        loading={approveLoading}
        onConfirm={handleApprove}
        onClose={() => setConfirmApprove(null)}
      />

      <ReasonModal
        open={rejectRow !== null}
        title="Reject Posting"
        confirmLabel="Reject"
        confirmColor={RED}
        onClose={() => setRejectRow(null)}
        onSubmit={handleReject}
        saving={actionSaving}
      />

      <PostConfirmModal
        posting={postRow}
        onClose={() => setPostRow(null)}
        onDone={load}
      />

      <ReasonModal
        open={returnRow !== null}
        title="Return Posting"
        confirmLabel="Return"
        confirmColor={AMBER}
        onClose={() => setReturnRow(null)}
        onSubmit={handleReturn}
        saving={actionSaving}
      />
    </Page>
  )
}
