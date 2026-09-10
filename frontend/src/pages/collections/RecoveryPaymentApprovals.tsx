import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Page, SectionCard, KpiCard, DataTable, ExpandableFilterBar,
  Modal, ErrBanner, Spinner, Pill,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { LiveBadge } from '../../components/MyWorkspace'
import { apiFetch, apiPut } from '../../lib/api'
import { useFocusParam } from '../../hooks/useFocusParam'
import { fmtKoboExact, fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

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
  stage_label: string     // "Awaiting Head of Operations" | "Awaiting COO" (COO final for payments)
  required_role: string   // head_ops | coo — role due to sign THIS stage
  created_at: string
  posted_by_name: string | null
}

// Payments run HOP → COO (CFO removed from payments); COO is the final stage that
// posts the GL. Mirrored from the backend so the UI can gate per stage.
const PAYMENT_FINAL_ROLE = 'coo'
function getUser(): { role?: string } {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') } catch { return {} }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Whole days elapsed since an ISO timestamp (floored, never negative).
function ageDays(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime()
  return ms > 0 ? Math.floor(ms / 86_400_000) : 0
}

const prettyChannel = (c: string) => c.replace(/_/g, ' ')

// ── Review Modal ──────────────────────────────────────────────────────────────

function ReviewModal({
  payment, onClose, onSuccess,
}: { payment: PendingPayment | null; onClose: () => void; onSuccess: () => void }) {
  const navigate = useNavigate()
  const [action, setAction]         = useState<'approve' | 'reject'>('approve')
  const [rejectionReason, setRejectionReason] = useState('')
  const [saving, setSaving]         = useState(false)

  const role = getUser().role ?? ''
  const canAct = payment != null && (role === payment.required_role || role === 'admin')
  const isFinal = payment?.required_role === PAYMENT_FINAL_ROLE

  function reset() { setRejectionReason(''); setAction('approve') }

  async function handleReview() {
    if (!payment) return
    if (action === 'reject' && !rejectionReason.trim()) {
      toast.error('Provide a rejection reason')
      return
    }
    setSaving(true)
    try {
      if (action === 'approve') {
        await apiPut(`/api/recovery-ops/payments/${payment.id}/approve`, {})
        toast.success(isFinal ? 'Payment approved — GL posted to loan account' : 'Approved — sent to the next approver')
      } else {
        await apiPut(`/api/recovery-ops/payments/${payment.id}/reject`, {
          rejection_reason: rejectionReason,
        })
        toast.success('Payment rejected')
      }
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

  const accent = action === 'approve' ? GREEN : RED

  return (
    <Modal
      open={payment !== null}
      onClose={() => { reset(); onClose() }}
      title={`Review Recovery Payment — ${payment?.account_cif ?? ''}`}
      width={480}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          {canAct && (
            <button
              onClick={handleReview}
              disabled={saving}
              style={{
                padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none',
                background: accent, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
                cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {saving && <Spinner size={13} color="#fff" />}
              {action === 'approve' ? (isFinal ? 'Approve & Post to Account' : 'Approve — Send to Next') : 'Reject Payment'}
            </button>
          )}
          <button
            onClick={() => { reset(); onClose() }}
            style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
          >
            {canAct ? 'Cancel' : 'Close'}
          </button>
        </div>
      }
    >
      {payment && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Amount headline */}
          <div style={{ background: 'var(--canvas)', borderRadius: RADIUS.md, padding: `${SP[3]} ${SP[4]}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Payment Amount</span>
            <span style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: GREEN, lineHeight: 1 }}>{fmtKoboExact(payment.amount_kobo)}</span>
          </div>

          {/* Payment summary */}
          <div style={{ background: 'var(--canvas)', borderRadius: RADIUS.md, padding: `${SP[3]} ${SP[4]}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['Case', `#${payment.case_id}`],
              ['Payment Date', fmtDate(payment.payment_date)],
              ['Channel', prettyChannel(payment.channel)],
              ['Reference', payment.reference ?? '—'],
              ['Logged By', payment.posted_by_name ?? '—'],
              ['Logged At', fmtDate(payment.created_at)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', minWidth: 110 }}>{k}</span>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', textTransform: k === 'Channel' ? 'capitalize' : 'none' }}>{v}</span>
              </div>
            ))}
          </div>

          {/* Stage + review-the-record link */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '3px 9px', borderRadius: RADIUS['2xl'], background: `${canAct ? GREEN : AMBER}1F`, color: canAct ? GREEN : AMBER }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{canAct ? 'how_to_reg' : 'schedule'}</span>
              {payment.stage_label}
            </span>
            <button onClick={() => navigate(`/customers/${payment.account_cif}`)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: RADIUS.md, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>person_search</span>
              Review debtor (Customer 360)
            </button>
          </div>

          <div style={{ padding: `${SP[2]} ${SP[3]}`, background: `${AMBER}0C`, border: `1px solid ${AMBER}30`, borderRadius: RADIUS.md }}>
            <p style={{ margin: 0, fontSize: TEXT.sm, color: AMBER, fontWeight: FW.semibold }}>
              {isFinal
                ? 'Final (COO) approval posts a GL journal (Dr Cash / Cr Loan Receivable) and updates the recovery case balance.'
                : 'Approval advances this payment to the next approver in the HOP → COO chain. The GL is posted only on the final COO approval.'}
            </p>
          </div>

          {!canAct ? (
            <div style={{ padding: `${SP[2]} ${SP[3]}`, background: 'var(--canvas)', borderRadius: RADIUS.md, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              This payment is {payment.stage_label.toLowerCase()} — it isn't your stage to action. You can review the record above.
            </div>
          ) : (
          /* Approve / reject segmented control */
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
          )}

          {canAct && action === 'reject' && (
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
  const role = getUser().role ?? ''
  const focus = useFocusParam()
  const [rows, setRows]           = useState<PendingPayment[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<PendingPayment | null>(null)
  const [search, setSearch]       = useState('')
  const [fChannels, setFChannels] = useState(new Set<string>())
  const [statusTab, setStatusTab] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: PendingPayment[] }>(`/api/recovery-ops/payments/pending?status=${statusTab}`)
      setRows(res.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusTab])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['recovery_payments', 'recovery'] })

  // Deep-link from a notification: open the Review modal on the exact payment.
  useEffect(() => {
    if (focus && rows.length) {
      const r = rows.find(x => String(x.id) === String(focus))
      if (r) setReviewing(r)
    }
  }, [focus, rows])

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalPendingKobo = useMemo(() => rows.reduce((s, r) => s + r.amount_kobo, 0), [rows])
  const oldestDays = useMemo(() => rows.length
    ? Math.max(...rows.map(r => ageDays(r.created_at)))
    : 0, [rows])
  const distinctChannels = useMemo(() => new Set(rows.map(r => r.channel)), [rows])

  // ── Channel filter options (from live data) ────────────────────────────────
  const channelOptions = useMemo(
    () => Array.from(distinctChannels).sort().map(c => ({ value: c, label: prettyChannel(c) })),
    [distinctChannels],
  )

  // ── Client-side filter (channel + free-text search) ────────────────────────
  const displayed = useMemo(() => rows.filter(r => {
    if (fChannels.size && !fChannels.has(r.channel)) return false
    if (search) {
      const q = search.toLowerCase()
      return r.account_cif.toLowerCase().includes(q)
        || (r.reference ?? '').toLowerCase().includes(q)
        || r.channel.toLowerCase().includes(q)
    }
    return true
  }), [rows, fChannels, search])

  const cols: TableCol<PendingPayment>[] = [
    {
      key: 'account_cif', label: 'Account',
      render: r => (
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>{r.account_cif}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Case #{r.case_id}</div>
        </div>
      ),
    },
    {
      key: 'amount_kobo', label: 'Amount', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: GREEN }}>{fmtKoboExact(r.amount_kobo)}</span>,
    },
    {
      key: 'payment_date', label: 'Payment Date',
      render: r => <span style={{ fontSize: TEXT.sm }}>{fmtDate(r.payment_date)}</span>,
    },
    {
      key: 'channel', label: 'Channel',
      render: r => <Pill label={r.channel} color={BLUE} bg={`${BLUE}14`} />,
    },
    {
      key: 'reference', label: 'Reference',
      render: r => <span style={{ fontSize: TEXT.xs, fontFamily: 'var(--font-mono)', color: 'var(--txt2)' }}>{r.reference ?? '—'}</span>,
    },
    {
      key: 'stage_label', label: 'Approval Stage',
      render: r => {
        const mine = role === r.required_role || role === 'admin'
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${mine ? GREEN : AMBER}1F`, color: mine ? GREEN : AMBER, whiteSpace: 'nowrap' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{mine ? 'how_to_reg' : 'schedule'}</span>
            {(r.stage_label ?? '').replace('Awaiting ', '')}
          </span>
        )
      },
    },
    {
      key: 'posted_by_name', label: 'Logged By',
      render: r => <span style={{ fontSize: TEXT.sm }}>{r.posted_by_name ?? '—'}</span>,
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
      loading={loading && rows.length === 0}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px,1fr))', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="Pending Payments" value={fmtNum(rows.length)} icon="pending_actions" accent={AMBER} loading={loading} />
        <KpiCard label="Total Pending Value" value={fmtKoboExact(totalPendingKobo)} icon="payments" accent={GREEN} loading={loading} />
        <KpiCard label="Oldest Waiting" value={rows.length ? `${oldestDays}d` : '—'} sub="since logged" icon="hourglass_top" accent={oldestDays > 3 ? RED : BLUE} loading={loading} />
        <KpiCard label="Channels" value={fmtNum(distinctChannels.size)} icon="account_tree" accent={PURPLE} loading={loading} />
      </div>

      {/* Info banner */}
      <div style={{ padding: `${SP[3]} ${SP[4]}`, background: `${NAVY}06`, border: `1px solid ${NAVY}20`, borderRadius: RADIUS.md, marginBottom: SP[4], display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: NAVY, flexShrink: 0, marginTop: 1 }}>info</span>
        <p style={{ margin: 0, fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6 }}>
          Recovery agents log payments for tracking. A collections officer must approve each one before it posts to the GL and updates the loan recovery balance.
        </p>
      </div>

      <div style={{ display: 'inline-flex', gap: 4, background: 'var(--chip-bg)', padding: 3, borderRadius: RADIUS.md, marginBottom: SP[3] }}>
        {(['pending', 'approved', 'rejected', 'all'] as const).map(s => (
          <button key={s} onClick={() => setStatusTab(s)}
            style={{ padding: '5px 13px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold, textTransform: 'capitalize',
              background: statusTab === s ? 'var(--card)' : 'transparent', color: statusTab === s ? NAVY : 'var(--txt2)', boxShadow: statusTab === s ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}>
            {s}
          </button>
        ))}
      </div>

      <SectionCard title={statusTab === 'pending' ? 'Pending Approvals' : `${statusTab[0].toUpperCase()}${statusTab.slice(1)} Payments`} badge={displayed.length} padding={false} actions={<LiveBadge />}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'channel',
              label: 'Channel',
              options: channelOptions,
              selected: fChannels,
              onChange: setFChannels,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFChannels(new Set()) }}
          resultCount={displayed.length}
          totalCount={rows.length}
          placeholder="Search CIF, reference, channel…"
        />
        <DataTable
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={6}
          pageSize={20}
          focusId={focus}
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
