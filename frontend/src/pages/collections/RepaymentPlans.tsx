import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  ErrBanner, Modal, Spinner, StatusBadge, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, n } from '../../lib/fmt'
import { BLUE, GREEN, RED, NAVY, AMBER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlanRow {
  id: number
  account_cif: string
  customer_name: string | null
  total_kobo: number
  paid_kobo: number
  instalment_count: number
  paid_count: number
  next_payment_date: string | null
  status: string
  agent_name: string | null
}

interface Instalment {
  id: number
  instalment_number: number
  due_date: string
  amount_kobo: number
  status: string
}

// ── Status pill for plan ──────────────────────────────────────────────────────

const PLAN_STATUS: Record<string, { bg: string; txt: string }> = {
  Active:    { bg: `${BLUE}1F`,  txt: BLUE  },
  Completed: { bg: `${GREEN}1F`, txt: GREEN },
  Defaulted: { bg: `${RED}1A`,   txt: RED   },
}

function PlanPill({ status }: { status: string }) {
  const s = PLAN_STATUS[status] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

// ── Mini progress bar ─────────────────────────────────────────────────────────

function InstalmentProgress({ paid, total }: { paid: number; total: number }) {
  const pct = total > 0 ? (paid / total) * 100 : 0
  return (
    <div>
      <div style={{ ...NUM, fontSize: 12, fontWeight: 600, color: 'var(--txt)', marginBottom: 4 }}>
        {paid}/{total}
      </div>
      <div style={{ height: 4, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden', width: 80 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? GREEN : NAVY, borderRadius: 99 }} />
      </div>
    </div>
  )
}

// ── Shared field style (matches Queue.tsx) ────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

// ── New Plan Modal ────────────────────────────────────────────────────────────

function NewPlanModal({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [cif, setCif]                     = useState('')
  const [amountNaira, setAmountNaira]     = useState('')
  const [instalmentCount, setInstalmentCount] = useState('3')
  const [firstPaymentDate, setFirstPaymentDate] = useState('')
  const [notes, setNotes]                 = useState('')
  const [saving, setSaving]               = useState(false)
  const [err, setErr]                     = useState<string | null>(null)

  function reset() {
    setCif(''); setAmountNaira(''); setInstalmentCount('3')
    setFirstPaymentDate(''); setNotes(''); setErr(null)
  }

  async function submit() {
    const kobo = Math.round(parseFloat(amountNaira) * 100)
    if (!cif.trim() || !kobo || !firstPaymentDate) return
    setSaving(true)
    setErr(null)
    try {
      await apiPost('/api/collections-ops/repayment-plans', {
        account_cif: cif.trim(),
        total_kobo: kobo,
        instalment_count: parseInt(instalmentCount, 10),
        first_payment_date: firstPaymentDate,
        notes,
      })
      toast.success('Repayment plan created')
      reset()
      onCreated()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to create plan')
    } finally {
      setSaving(false)
    }
  }

  const isValid = cif.trim().length > 0 && parseFloat(amountNaira) > 0 && firstPaymentDate.length > 0

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose() }}
      title="New Repayment Plan"
      width={560}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={() => { reset(); onClose() }}
            style={{ padding: '7px 15px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!isValid || saving}
            style={{ ...btnPrimary, opacity: !isValid || saving ? 0.6 : 1, cursor: !isValid || saving ? 'not-allowed' : 'pointer' }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            Create Plan
          </button>
        </div>
      }
    >
      <ErrBanner error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Customer CIF</label>
          <input
            type="text"
            value={cif}
            onChange={e => setCif(e.target.value)}
            placeholder="e.g. CIF-00123"
            style={{ ...fieldStyle, height: 36 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Total Amount ₦</label>
          <input
            type="number"
            value={amountNaira}
            onChange={e => setAmountNaira(e.target.value)}
            placeholder="e.g. 150000"
            min="0"
            style={{ ...fieldStyle, height: 36 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Number of Instalments</label>
          <select
            value={instalmentCount}
            onChange={e => setInstalmentCount(e.target.value)}
            style={{ ...fieldStyle, height: 36 }}
          >
            {Array.from({ length: 24 }, (_, i) => i + 1).map(n => (
              <option key={n} value={String(n)}>{n} instalment{n > 1 ? 's' : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>First Payment Date</label>
          <input
            type="date"
            value={firstPaymentDate}
            onChange={e => setFirstPaymentDate(e.target.value)}
            style={{ ...fieldStyle, height: 36 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes <span style={{ fontWeight: 400, color: 'var(--txt3)' }}>(optional)</span></label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Additional notes…"
            style={{ ...fieldStyle, resize: 'vertical' }}
          />
        </div>
      </div>
    </Modal>
  )
}

// ── Plan Detail Modal ─────────────────────────────────────────────────────────

const INST_STATUS: Record<string, { bg: string; txt: string }> = {
  Scheduled: { bg: `${BLUE}1F`,  txt: BLUE  },
  Paid:      { bg: `${GREEN}1F`, txt: GREEN },
  Missed:    { bg: `${RED}1A`,   txt: RED   },
}

function InstPill({ status }: { status: string }) {
  const s = INST_STATUS[status] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: 11, fontWeight: 600, padding: '2px 7px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

function PlanDetailModal({ plan, open, onClose, onUpdated }: {
  plan: PlanRow | null
  open: boolean
  onClose: () => void
  onUpdated: () => void
}) {
  const [instalments, setInstalments] = useState<Instalment[]>([])
  const [instLoading, setInstLoading] = useState(false)
  const [markingId, setMarkingId]     = useState<number | null>(null)

  useEffect(() => {
    if (!plan || !open) return
    setInstLoading(true)
    apiFetch<{ data: Instalment[] }>(`/api/collections-ops/repayment-plans/${plan.id}/instalments`)
      .then(res => setInstalments(res.data ?? []))
      .catch(() => setInstalments([]))
      .finally(() => setInstLoading(false))
  }, [plan, open])

  async function markPaid(instId: number) {
    setMarkingId(instId)
    try {
      await apiPut(`/api/collections-ops/repayment-plans/instalments/${instId}/paid`, {})
      toast.success('Instalment marked as Paid')
      // Refresh instalments list
      if (plan) {
        const res = await apiFetch<{ data: Instalment[] }>(`/api/collections-ops/repayment-plans/${plan.id}/instalments`)
        setInstalments(res.data ?? [])
      }
      onUpdated()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to mark instalment')
    } finally {
      setMarkingId(null)
    }
  }

  if (!plan) return null

  const remaining = n(plan.total_kobo) - n(plan.paid_kobo)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Repayment Plan Detail"
      width={640}
    >
      {/* Header summary */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, padding: '12px 16px', background: 'var(--th-bg)', borderRadius: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{plan.account_cif}</div>
          {plan.customer_name && <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>{plan.customer_name}</div>}
        </div>
        <PlanPill status={plan.status} />
      </div>

      {/* Financial summary row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Total Agreed', value: fmtKobo(plan.total_kobo) },
          { label: 'Paid So Far', value: fmtKobo(plan.paid_kobo) },
          { label: 'Remaining', value: fmtKobo(remaining) },
        ].map(({ label, value }) => (
          <div key={label} style={{ padding: '10px 12px', background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 4 }}>{label}</div>
            <div style={{ ...NUM, fontSize: 14, fontWeight: 700, color: 'var(--txt)' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Instalments */}
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', marginBottom: 10 }}>
        Instalments
      </div>

      {instLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 0', gap: 8, color: 'var(--txt2)', fontSize: 13 }}>
          <Spinner size={16} color={NAVY} /> Loading instalments…
        </div>
      ) : instalments.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--txt2)', padding: '16px 0' }}>No instalments found.</div>
      ) : (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['#', 'Due Date', 'Amount ₦', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {instalments.map((inst, idx) => (
                <tr
                  key={inst.id}
                  style={{ background: idx % 2 === 0 ? undefined : 'var(--th-bg)' }}
                >
                  <td style={{ ...NUM, padding: '9px 12px', fontSize: 12.5, fontWeight: 600, color: 'var(--txt2)' }}>
                    {inst.instalment_number}
                  </td>
                  <td style={{ padding: '9px 12px', fontSize: 12.5, color: 'var(--txt)' }}>
                    {fmtDate(inst.due_date)}
                  </td>
                  <td style={{ ...NUM, padding: '9px 12px', fontSize: 12.5, fontWeight: 600, color: 'var(--txt)' }}>
                    {fmtKobo(inst.amount_kobo)}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <InstPill status={inst.status} />
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    {inst.status === 'Scheduled' && (
                      <button
                        onClick={() => markPaid(inst.id)}
                        disabled={markingId === inst.id}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '4px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                          fontSize: 11.5, fontWeight: 600,
                          background: `${GREEN}1F`, color: GREEN,
                          opacity: markingId === inst.id ? 0.6 : 1,
                        }}
                      >
                        {markingId === inst.id && <Spinner size={11} color={GREEN} />}
                        Mark Paid
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RepaymentPlans() {
  const [rows, setRows]         = useState<PlanRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  // Filters
  const [status, setStatus] = useState('')
  const [q, setQ]           = useState('')

  // Modals
  const [showNewPlan, setShowNewPlan]   = useState(false)
  const [detailPlan, setDetailPlan]     = useState<PlanRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const p = new URLSearchParams({ limit: '100' })
    if (status)   p.set('status', status)
    if (q.trim()) p.set('q', q.trim())
    try {
      const res = await apiFetch<{ data: PlanRow[] }>(`/api/collections-ops/repayment-plans?${p}`)
      // Sort: next_payment_date asc, nulls last
      const sorted = (res.data ?? []).slice().sort((a, b) => {
        if (!a.next_payment_date && !b.next_payment_date) return 0
        if (!a.next_payment_date) return 1
        if (!b.next_payment_date) return -1
        return new Date(a.next_payment_date).getTime() - new Date(b.next_payment_date).getTime()
      })
      setRows(sorted)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load repayment plans')
    } finally {
      setLoading(false)
    }
  }, [status, q])

  useEffect(() => { load() }, [load])

  const cols: TableCol<PlanRow>[] = [
    {
      key: 'account_cif',
      label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.account_cif}</div>
          {r.customer_name && (
            <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 1 }}>{r.customer_name}</div>
          )}
        </div>
      ),
    },
    {
      key: 'total_kobo',
      label: 'Total Agreed ₦',
      align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(r.total_kobo)}</span>,
    },
    {
      key: 'paid_kobo',
      label: 'Paid So Far ₦',
      align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600, color: GREEN }}>{fmtKobo(r.paid_kobo)}</span>,
    },
    {
      key: '_remaining',
      label: 'Remaining ₦',
      sortable: false,
      align: 'right',
      render: r => {
        const rem = n(r.total_kobo) - n(r.paid_kobo)
        return <span style={{ ...NUM, fontWeight: 600, color: rem > 0 ? RED : GREEN }}>{fmtKobo(rem)}</span>
      },
    },
    {
      key: 'paid_count',
      label: 'Instalments',
      sortable: false,
      render: r => <InstalmentProgress paid={r.paid_count} total={r.instalment_count} />,
    },
    {
      key: 'next_payment_date',
      label: 'Next Payment',
      render: r => {
        if (!r.next_payment_date) return <span style={{ fontSize: 12, color: 'var(--txt2)' }}>—</span>
        const isPast = new Date(r.next_payment_date) < new Date()
        return (
          <span style={{ fontSize: 13, fontWeight: isPast ? 600 : 400, color: isPast ? RED : 'var(--txt)' }}>
            {fmtDate(r.next_payment_date)}
          </span>
        )
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: r => <PlanPill status={r.status} />,
    },
  ]

  return (
    <Page
      title="Repayment Plans"
      subtitle="Structured repayment arrangements for delinquent accounts"
      actions={
        <button onClick={() => setShowNewPlan(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Plan
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Plans" badge={rows.length} padding={false}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setStatus(''); setQ('') }}>
            <select value={status} onChange={e => setStatus(e.target.value)} style={filterInputStyle}>
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Completed">Completed</option>
              <option value="Defaulted">Defaulted</option>
            </select>
            <input
              placeholder="Search by CIF or agent…"
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              style={{ ...filterInputStyle, minWidth: 200 }}
            />
            <button
              onClick={() => load()}
              style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Apply
            </button>
          </FilterBar>
        </div>
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          onRowClick={r => setDetailPlan(r)}
          emptyText="No repayment plans found"
          skeletonRows={8}
        />
      </SectionCard>

      <NewPlanModal
        open={showNewPlan}
        onClose={() => setShowNewPlan(false)}
        onCreated={() => { setShowNewPlan(false); load() }}
      />

      <PlanDetailModal
        plan={detailPlan}
        open={detailPlan !== null}
        onClose={() => setDetailPlan(null)}
        onUpdated={load}
      />
    </Page>
  )
}
