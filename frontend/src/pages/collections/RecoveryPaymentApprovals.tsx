import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Page, SectionCard, DataTable, ErrBanner, Spinner, Modal,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingPayment {
  id: number
  case_id: number
  account_cif: string
  amount_kobo: number
  payment_date: string
  channel: string
  reference: string | null
  status: string
  created_at: string
  posted_by_name: string | null
}

// ── Review Modal ──────────────────────────────────────────────────────────────

function ReviewModal({
  payment, onClose, onSuccess,
}: { payment: PendingPayment | null; onClose: () => void; onSuccess: () => void }) {
  const [action, setAction]         = useState<'approve' | 'reject'>('approve')
  const [rejectionReason, setRejectionReason] = useState('')
  const [saving, setSaving]         = useState(false)

  async function handleReview() {
    if (!payment) return
    setSaving(true)
    try {
      if (action === 'approve') {
        await apiPut(`/api/recovery-ops/payments/${payment.id}/approve`, {})
        toast.success('Payment approved — GL entry posted to loan account')
      } else {
        if (!rejectionReason.trim()) {
          toast.error('Provide a rejection reason')
          setSaving(false)
          return
        }
        await apiPut(`/api/recovery-ops/payments/${payment.id}/reject`, {
          rejection_reason: rejectionReason,
        })
        toast.success('Payment rejected')
      }
      setRejectionReason('')
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
      open={payment !== null}
      onClose={() => { setRejectionReason(''); setAction('approve'); onClose() }}
      title={`Review Recovery Payment — ${payment?.account_cif ?? ''}`}
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
            {action === 'approve' ? 'Approve & Post to Account' : 'Reject Payment'}
          </button>
          <button
            onClick={() => { setRejectionReason(''); setAction('approve'); onClose() }}
            style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      }
    >
      {payment && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Payment summary */}
          <div style={{ background: 'var(--canvas)', borderRadius: RADIUS.md, padding: `${SP[3]} ${SP[4]}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['Amount', fmtKobo(payment.amount_kobo)],
              ['Payment Date', fmtDate(payment.payment_date)],
              ['Channel', payment.channel],
              ['Reference', payment.reference ?? '—'],
              ['Logged By', payment.posted_by_name ?? '—'],
              ['Logged At', fmtDate(payment.created_at)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', minWidth: 110 }}>{k}</span>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: k === 'Amount' ? FW.bold : FW.normal }}>{v}</span>
              </div>
            ))}
          </div>

          <div style={{ padding: `${SP[2]} ${SP[3]}`, background: `${AMBER}0C`, border: `1px solid ${AMBER}30`, borderRadius: RADIUS.md }}>
            <p style={{ margin: 0, fontSize: TEXT.sm, color: AMBER, fontWeight: FW.semibold }}>
              Approval posts a GL journal (Dr Cash / Cr Loan Receivable) and updates the recovery case balance.
            </p>
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

          {action === 'reject' && (
            <div>
              <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>
                Rejection Reason <span style={{ color: RED }}>*</span>
              </label>
              <textarea
                value={rejectionReason}
                onChange={e => setRejectionReason(e.target.value)}
                rows={3}
                placeholder="Why is this payment being rejected?"
                style={{ ...inputStyle, resize: 'vertical' }}
                autoFocus
              />
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RecoveryPaymentApprovals() {
  const [rows, setRows]         = useState<PendingPayment[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<PendingPayment | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: PendingPayment[] }>('/api/recovery-ops/payments/pending')
      setRows(res.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const totalPendingKobo = rows.reduce((s, r) => s + r.amount_kobo, 0)

  const cols: TableCol<PendingPayment>[] = [
    {
      key: 'account_cif', label: 'Account (CIF)',
      render: r => (
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>{r.account_cif}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Case #{r.case_id}</div>
        </div>
      ),
    },
    {
      key: 'amount_kobo', label: 'Amount', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: GREEN }}>{fmtKobo(r.amount_kobo)}</span>,
    },
    {
      key: 'payment_date', label: 'Payment Date',
      render: r => <span style={{ fontSize: TEXT.sm }}>{fmtDate(r.payment_date)}</span>,
    },
    {
      key: 'channel', label: 'Channel',
      render: r => <span style={{ fontSize: TEXT.sm, textTransform: 'capitalize' }}>{r.channel.replace(/_/g, ' ')}</span>,
    },
    {
      key: 'reference', label: 'Reference',
      render: r => <span style={{ fontSize: TEXT.xs, fontFamily: 'var(--font-mono)', color: 'var(--txt2)' }}>{r.reference ?? '—'}</span>,
    },
    {
      key: 'posted_by_name', label: 'Logged By',
      render: r => <span style={{ fontSize: TEXT.sm }}>{r.posted_by_name ?? '—'}</span>,
    },
    {
      key: 'created_at', label: 'Logged At',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'id', label: '',
      render: r => (
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
    },
  ]

  return (
    <Page
      title="Recovery Payment Approvals"
      subtitle="Recovery payments pending collections officer approval before hitting the loan account"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: SP[3], marginBottom: SP[4], maxWidth: 480 }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}` }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', marginBottom: 4 }}>Pending Payments</div>
          <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: AMBER, lineHeight: 1 }}>{rows.length}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}` }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', marginBottom: 4 }}>Total Pending Value</div>
          <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: GREEN, lineHeight: 1 }}>{fmtKobo(totalPendingKobo)}</div>
        </div>
      </div>

      {/* Info banner */}
      <div style={{ padding: `${SP[3]} ${SP[4]}`, background: `${NAVY}06`, border: `1px solid ${NAVY}20`, borderRadius: RADIUS.md, marginBottom: SP[4], display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: NAVY, flexShrink: 0, marginTop: 1 }}>info</span>
        <p style={{ margin: 0, fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6 }}>
          Recovery agents log payments for analytics and tracking. A collections officer must approve each payment before it
          is posted to the GL and updates the loan recovery balance.
        </p>
      </div>

      <SectionCard title="Pending Approvals" badge={rows.length} padding={false}>
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={6}
          pageSize={20}
          searchKeys={['account_cif', 'channel', 'reference']}
          searchPlaceholder="Search CIF, channel, reference…"
          emptyText="No recovery payments pending approval"
        />
      </SectionCard>

      <ReviewModal
        payment={reviewing}
        onClose={() => setReviewing(null)}
        onSuccess={() => { setReviewing(null); load() }}
      />
    </Page>
  )
}
