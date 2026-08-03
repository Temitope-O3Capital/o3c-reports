import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Page, SectionCard, DataTable, ErrBanner, Spinner, Modal,
  NameCell,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WriteoffRequest {
  id: number
  account_cif: string
  writeoff_type: string
  reason: string
  reason_notes: string | null
  amount_kobo: number | null
  percentage: number | null
  outstanding_kobo: number | null
  status: string
  review_notes: string | null
  reviewed_at: string | null
  created_at: string
  requested_by_name: string | null
  reviewed_by_name: string | null
}

const WRITEOFF_TYPES = [
  { value: 'full',            label: 'Full Write-off',        desc: '100% of outstanding' },
  { value: 'partial_amount',  label: 'Partial Amount',        desc: 'Specific NGN amount' },
  { value: 'percentage',      label: 'Percentage',            desc: '% of outstanding' },
  { value: 'principal_only',  label: 'Principal Only',        desc: 'Write off principal, not interest' },
  { value: 'interest_only',   label: 'Interest Only',         desc: 'Write off interest, keep principal' },
]

const REASONS = [
  { value: 'bad_debt',        label: 'Bad Debt' },
  { value: 'deceased',        label: 'Customer Deceased' },
  { value: 'fraud',           label: 'Fraud / Identity Theft' },
  { value: 'natural_disaster',label: 'Natural Disaster' },
  { value: 'regulatory',      label: 'Regulatory Directive' },
  { value: 'other',           label: 'Other' },
]

type StatusFilter = 'pending' | 'approved' | 'rejected'

function statusColor(s: string): string {
  if (s === 'approved') return GREEN
  if (s === 'rejected') return RED
  return AMBER
}

function StatusPill({ status }: { status: string }) {
  const color = statusColor(status)
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px',
      borderRadius: RADIUS['2xl'], background: `${color}18`, color,
      textTransform: 'capitalize',
    }}>
      {status}
    </span>
  )
}

function typeLabel(v: string) {
  return WRITEOFF_TYPES.find(t => t.value === v)?.label ?? v
}
function reasonLabel(v: string) {
  return REASONS.find(r => r.value === v)?.label ?? v
}

function getUser(): { role?: string } {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') }
  catch { return {} }
}

// ── Create Request Modal ──────────────────────────────────────────────────────

function CreateRequestModal({
  open, onClose, onSuccess,
}: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [cif, setCif]                 = useState('')
  const [woType, setWoType]           = useState('full')
  const [reason, setReason]           = useState('bad_debt')
  const [reasonNotes, setReasonNotes] = useState('')
  const [amountNaira, setAmountNaira] = useState('')
  const [pct, setPct]                 = useState('')
  const [outstanding, setOutstanding] = useState('')
  const [saving, setSaving]           = useState(false)

  function reset() {
    setCif(''); setWoType('full'); setReason('bad_debt')
    setReasonNotes(''); setAmountNaira(''); setPct(''); setOutstanding('')
  }

  async function handleSave() {
    if (!cif.trim()) { toast.error('CIF is required'); return }
    setSaving(true)
    try {
      const body: Record<string, any> = {
        account_cif: cif.trim(),
        writeoff_type: woType,
        reason,
        reason_notes: reasonNotes,
        outstanding_kobo: outstanding ? Math.round(parseFloat(outstanding) * 100) : 0,
      }
      if (woType === 'partial_amount' || woType === 'principal_only' || woType === 'interest_only') {
        const n = parseFloat(amountNaira)
        if (!n || n <= 0) { toast.error('Enter a valid amount'); setSaving(false); return }
        body.amount_kobo = Math.round(n * 100)
      }
      if (woType === 'percentage') {
        const p = parseFloat(pct)
        if (!p || p <= 0 || p > 100) { toast.error('Enter a valid percentage (1–100)'); setSaving(false); return }
        body.percentage = p
      }
      await apiPost('/api/collections-ops/writeoff-requests', body)
      toast.success('Write-off request submitted')
      reset()
      onSuccess()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6,
  }

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose() }}
      title="Request Write-off"
      width={520}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none',
              background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>
            Submit Request
          </button>
          <button
            onClick={() => { reset(); onClose() }}
            style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>Account CIF</label>
          <input
            type="text"
            value={cif}
            onChange={e => setCif(e.target.value)}
            placeholder="e.g. CIF-001234"
            style={inputStyle}
            autoFocus
          />
        </div>

        <div>
          <label style={labelStyle}>Write-off Type</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {WRITEOFF_TYPES.map(t => (
              <label
                key={t.value}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                  padding: '8px 12px', borderRadius: RADIUS.md,
                  border: `1.5px solid ${woType === t.value ? RED : 'var(--bdr)'}`,
                  background: woType === t.value ? `${RED}08` : 'var(--card)',
                }}
              >
                <input
                  type="radio"
                  checked={woType === t.value}
                  onChange={() => setWoType(t.value)}
                  style={{ marginTop: 2, accentColor: RED }}
                />
                <div>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: woType === t.value ? RED : 'var(--txt)' }}>{t.label}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{t.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {(woType === 'partial_amount' || woType === 'principal_only' || woType === 'interest_only') && (
          <div>
            <label style={labelStyle}>Amount (₦)</label>
            <input type="number" min="0" step="0.01" placeholder="0.00" value={amountNaira} onChange={e => setAmountNaira(e.target.value)} style={{ ...inputStyle, fontWeight: FW.bold }} />
          </div>
        )}

        {woType === 'percentage' && (
          <div>
            <label style={labelStyle}>Percentage (%)</label>
            <input type="number" min="0.01" max="100" step="0.01" placeholder="e.g. 50" value={pct} onChange={e => setPct(e.target.value)} style={inputStyle} />
          </div>
        )}

        <div>
          <label style={labelStyle}>Outstanding Balance (₦) <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
          <input type="number" min="0" step="0.01" placeholder="Current outstanding amount" value={outstanding} onChange={e => setOutstanding(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Reason</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {REASONS.map(r => (
              <button
                key={r.value}
                onClick={() => setReason(r.value)}
                style={{
                  padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                  border: `1.5px solid ${reason === r.value ? NAVY : 'var(--bdr)'}`,
                  background: reason === r.value ? NAVY : 'var(--card)',
                  color: reason === r.value ? '#fff' : 'var(--txt)',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Supporting Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
          <textarea
            value={reasonNotes}
            onChange={e => setReasonNotes(e.target.value)}
            rows={3}
            placeholder="Provide any additional context for the reviewer…"
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>
      </div>
    </Modal>
  )
}

// ── Review Modal (admin / collections_head) ───────────────────────────────────

function ReviewModal({
  request, onClose, onSuccess,
}: { request: WriteoffRequest | null; onClose: () => void; onSuccess: () => void }) {
  const [action, setAction]     = useState<'approve' | 'reject'>('approve')
  const [notes, setNotes]       = useState('')
  const [saving, setSaving]     = useState(false)

  async function handleReview() {
    if (!request) return
    setSaving(true)
    try {
      if (action === 'approve') {
        await apiPut(`/api/collections-ops/writeoff-requests/${request.id}/approve`, { review_notes: notes })
        toast.success('Write-off request approved — GL entry posted')
      } else {
        await apiPut(`/api/collections-ops/writeoff-requests/${request.id}/reject`, { review_notes: notes })
        toast.success('Write-off request rejected')
      }
      setNotes('')
      onSuccess()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box',
  }

  return (
    <Modal
      open={request !== null}
      onClose={() => { setNotes(''); onClose() }}
      title={`Review Write-off — ${request?.account_cif ?? ''}`}
      width={460}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleReview}
            disabled={saving}
            style={{
              padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none',
              background: action === 'approve' ? GREEN : RED,
              color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            {action === 'approve' ? 'Approve' : 'Reject'}
          </button>
          <button
            onClick={() => { setNotes(''); onClose() }}
            style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      }
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--canvas)', borderRadius: RADIUS.md, padding: `${SP[3]} ${SP[4]}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['Type', typeLabel(request.writeoff_type)],
              ['Reason', reasonLabel(request.reason)],
              ['Outstanding', request.outstanding_kobo ? fmtKobo(request.outstanding_kobo) : '—'],
              ...(request.writeoff_type === 'partial_amount' || request.writeoff_type === 'principal_only' || request.writeoff_type === 'interest_only'
                ? [['Amount', request.amount_kobo ? fmtKobo(request.amount_kobo) : '—']] : []),
              ...(request.writeoff_type === 'percentage'
                ? [['Percentage', `${request.percentage}%`]] : []),
              ['Requested By', request.requested_by_name ?? '—'],
              ['Submitted', fmtDate(request.created_at)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', minWidth: 110 }}>{k}</span>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{v}</span>
              </div>
            ))}
            {request.reason_notes && (
              <div style={{ marginTop: 4, padding: `${SP[2]} ${SP[3]}`, background: 'var(--card)', borderRadius: RADIUS.md, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                {request.reason_notes}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 7 }}>
            {(['approve', 'reject'] as const).map(a => (
              <button
                key={a}
                onClick={() => setAction(a)}
                style={{
                  flex: 1, padding: '8px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                  border: `1.5px solid ${action === a ? (a === 'approve' ? GREEN : RED) : 'var(--bdr)'}`,
                  background: action === a ? (a === 'approve' ? GREEN : RED) : 'var(--card)',
                  color: action === a ? '#fff' : 'var(--txt)',
                }}
              >
                {a === 'approve' ? 'Approve' : 'Reject'}
              </button>
            ))}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>
              Review Notes <span style={{ fontWeight: 400, color: 'var(--txt3)' }}>(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Notes for requester…"
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WriteoffRequests() {
  const [rows, setRows]             = useState<WriteoffRequest[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [statusTab, setStatusTab]   = useState<StatusFilter>('pending')
  const [createOpen, setCreateOpen] = useState(false)
  const [reviewing, setReviewing]   = useState<WriteoffRequest | null>(null)

  const user   = getUser()
  const canAct = user.role === 'collections_head' || user.role === 'admin'

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: WriteoffRequest[] }>(
        `/api/collections-ops/writeoff-requests?status=${statusTab}`,
      )
      setRows(res.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusTab])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['collections','loans'] })

  const STATUS_TABS: { key: StatusFilter; label: string }[] = [
    { key: 'pending',  label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
  ]

  const cols: TableCol<WriteoffRequest>[] = [
    {
      key: 'account_cif', label: 'Account',
      render: r => (
        <NameCell
          name={r.account_cif}
          sub={r.requested_by_name ?? undefined}
        />
      ),
    },
    {
      key: 'writeoff_type', label: 'Type',
      render: r => <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>{typeLabel(r.writeoff_type)}</span>,
    },
    {
      key: 'reason', label: 'Reason',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{reasonLabel(r.reason)}</span>,
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right',
      render: r => <span style={{ ...NUM, color: RED }}>{r.outstanding_kobo ? fmtKobo(r.outstanding_kobo) : '—'}</span>,
    },
    {
      key: 'amount_kobo', label: 'Write-off Amount', align: 'right',
      render: r => {
        if (r.writeoff_type === 'full') return <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Full</span>
        if (r.writeoff_type === 'percentage') return <span style={{ ...NUM }}>{r.percentage}%</span>
        return <span style={NUM}>{r.amount_kobo ? fmtKobo(r.amount_kobo) : '—'}</span>
      },
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusPill status={r.status} />,
    },
    {
      key: 'created_at', label: 'Submitted',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    ...(canAct && statusTab === 'pending' ? [{
      key: '_actions',
      label: '',
      sortable: false,
      render: (r: WriteoffRequest) => (
        <button
          onClick={e => { e.stopPropagation(); setReviewing(r) }}
          style={{
            padding: '4px 11px', borderRadius: RADIUS.sm, cursor: 'pointer',
            border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY,
            fontSize: TEXT.xs, fontWeight: FW.semibold, whiteSpace: 'nowrap',
          }}
        >
          Review
        </button>
      ),
    } as TableCol<WriteoffRequest>] : []),
  ]

  return (
    <Page
      title="Write-off Requests"
      subtitle="Collections-initiated write-off requests pending admin approval"
      actions={
        <button
          onClick={() => setCreateOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[4]}`,
            borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff',
            fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          Request Write-off
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="" badge={rows.length} padding={false}>
        {/* Status tabs */}
        <div style={{ display: 'flex', gap: 2, padding: '8px 16px', borderBottom: '1px solid var(--bdr)' }}>
          {STATUS_TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setStatusTab(t.key)}
              style={{
                padding: '5px 16px', borderRadius: RADIUS.md, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: TEXT.sm, fontWeight: statusTab === t.key ? FW.semibold : FW.normal,
                border: statusTab === t.key ? `1.5px solid ${NAVY}` : '1.5px solid transparent',
                background: statusTab === t.key ? NAVY : 'transparent',
                color: statusTab === t.key ? '#fff' : 'var(--txt2)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <DataTable
          key={statusTab}
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={6}
          pageSize={20}
          searchKeys={['account_cif', 'writeoff_type', 'reason']}
          searchPlaceholder="Search CIF, type, reason…"
          emptyText={`No ${statusTab} write-off requests`}
        />
      </SectionCard>

      <CreateRequestModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={() => { setCreateOpen(false); load() }}
      />

      <ReviewModal
        request={reviewing}
        onClose={() => setReviewing(null)}
        onSuccess={() => { setReviewing(null); load() }}
      />
    </Page>
  )
}
