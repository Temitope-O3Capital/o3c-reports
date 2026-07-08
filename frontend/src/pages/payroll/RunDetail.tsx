import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  ConfirmModal, ErrBanner, Spinner, btnPrimary, btnSecondary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PayrollRun {
  id: number
  period_year: number
  period_month: number
  status: string
  headcount: number
  total_gross_kobo: number
  total_net_kobo: number
  total_paye_kobo: number
  total_pension_kobo: number
  total_nhf_kobo: number
  created_at?: string
  created_by_name?: string
  approved_by_name?: string
  approved_at?: string
  paid_at?: string
  notes?: string
}

interface PayrollItem {
  id: number
  employee_id: number
  employee_name: string
  staff_id?: string
  department?: string
  grade_level?: string
  job_title?: string
  bank_name?: string
  account_number?: string
  gross_kobo: number
  basic_kobo: number
  housing_kobo: number
  transport_kobo: number
  other_allowance_kobo: number
  paye_kobo: number
  employee_pension_kobo: number
  nhf_kobo: number
  loan_deduction_kobo: number
  other_deduction_kobo: number
  net_kobo: number
  notes?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  draft:    { color: 'var(--txt2)', bg: 'rgba(75,85,99,.1)', label: 'Draft' },
  review:   { color: AMBER,    bg: `${AMBER}18`,          label: 'In Review' },
  approved: { color: BLUE,     bg: `${BLUE}12`,           label: 'Approved' },
  paid:     { color: GREEN,    bg: 'rgba(22,163,74,.12)', label: 'Paid' },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.draft
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function RunDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const storedUser = localStorage.getItem('auth_user')
  const role: string = storedUser ? String((JSON.parse(storedUser) as AuthUser).role) : ''

  const [run, setRun] = useState<PayrollRun | null>(null)
  const [items, setItems] = useState<PayrollItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [deptFilter, setDeptFilter] = useState('')

  // Action states
  const [submitOpen, setSubmitOpen] = useState(false)
  const [approveOpen, setApproveOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [actioning, setActioning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [r, its] = await Promise.all([
        apiFetch<PayrollRun>(`/api/payroll/runs/${id}`),
        apiFetch<PayrollItem[]>(`/api/payroll/runs/${id}/items`),
      ])
      setRun(Array.isArray(r) ? r[0] : r)
      setItems(Array.isArray(its) ? its : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function doAction(endpoint: string, onSuccess: string) {
    setActioning(true)
    try {
      await apiPost(`/api/payroll/runs/${id}/${endpoint}`, {})
      toast.success(onSuccess)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setActioning(false) }
  }

  // Role gates
  const canSubmit  = (role === 'payroll_officer' || role === 'hr_manager' || role === 'admin') && run?.status === 'draft'
  const canApprove = (role === 'payroll_manager' || role === 'cfo' || role === 'admin') && run?.status === 'review'
  const canPay     = (role === 'finance_officer' || role === 'finance_head' || role === 'cfo' || role === 'admin') && run?.status === 'approved'

  // Filter by department
  const depts = [...new Set(items.map(i => i.department ?? '').filter(Boolean))]
  const filtered = deptFilter ? items.filter(i => i.department === deptFilter) : items

  // Totals row (filtered)
  const totals = filtered.reduce((acc, i) => ({
    gross: acc.gross + i.gross_kobo,
    paye:  acc.paye  + i.paye_kobo,
    nhf:   acc.nhf   + i.nhf_kobo,
    pension: acc.pension + i.employee_pension_kobo,
    loan: acc.loan + i.loan_deduction_kobo,
    other: acc.other + i.other_deduction_kobo,
    net:   acc.net   + i.net_kobo,
  }), { gross: 0, paye: 0, nhf: 0, pension: 0, loan: 0, other: 0, net: 0 })

  const cols: TableCol<PayrollItem>[] = [
    {
      key: 'employee_name', label: 'Employee',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.employee_name}</div>
          {r.staff_id && <div style={{ fontSize: 11.5, color: 'var(--txt3)', fontFamily: 'Inter, monospace' }}>{r.staff_id}</div>}
        </div>
      ),
    },
    {
      key: 'department', label: 'Dept',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.department ?? '—'}</span>,
    },
    {
      key: 'gross_kobo', label: 'Gross', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.gross_kobo)}</span>,
    },
    {
      key: 'paye_kobo', label: 'PAYE', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.paye_kobo)}</span>,
    },
    {
      key: 'nhf_kobo', label: 'NHF', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.nhf_kobo)}</span>,
    },
    {
      key: 'employee_pension_kobo', label: 'Pension', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.employee_pension_kobo)}</span>,
    },
    {
      key: 'loan_deduction_kobo', label: 'Loan Ded.', align: 'right',
      render: r => r.loan_deduction_kobo > 0
        ? <span style={{ ...NUM, color: AMBER }}>{fmtKobo(r.loan_deduction_kobo)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'other_deduction_kobo', label: 'Other Ded.', align: 'right',
      render: r => r.other_deduction_kobo > 0
        ? <span style={{ ...NUM, color: AMBER }}>{fmtKobo(r.other_deduction_kobo)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'net_kobo', label: 'Net Pay', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 700, color: GREEN }}>{fmtKobo(r.net_kobo)}</span>,
    },
  ]

  if (loading && !run) {
    return (
      <Page title="Payroll Run" back={{ label: 'Payroll', to: '/payroll' }}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spinner size={32} />
        </div>
      </Page>
    )
  }

  const period = run ? `${MONTHS[run.period_month]} ${run.period_year}` : '—'

  return (
    <Page
      title={`Payroll — ${period}`}
      subtitle={run ? `${run.headcount} employees${run.created_at ? ` · Created ${fmtDate(run.created_at)}` : ''}` : ''}
      back={{ label: 'Payroll', to: '/payroll' }}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {run && <StatusPill status={run.status} />}
          {canSubmit && (
            <button onClick={() => setSubmitOpen(true)} style={btnPrimary}>
              Submit for Approval
            </button>
          )}
          {canApprove && (
            <button onClick={() => setApproveOpen(true)} style={btnPrimary}>
              Approve Run
            </button>
          )}
          {canPay && (
            <button onClick={() => setPayOpen(true)} style={{ ...btnPrimary, background: GREEN }}>
              Mark as Paid
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Run summary strip */}
      {run && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
          {[
            { label: 'Headcount',   value: run.headcount },
            { label: 'Gross Total', value: fmtKobo(run.total_gross_kobo) },
            { label: 'Net Total',   value: fmtKobo(run.total_net_kobo) },
            { label: 'PAYE Total',  value: fmtKobo(run.total_paye_kobo) },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '14px 18px' }}>
              <div style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--txt)', fontFamily: 'Inter, sans-serif' }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      <SectionCard
        title="Payroll Items"
        badge={filtered.length}
        subtitle={deptFilter ? `Showing ${deptFilter} only` : 'All departments'}
        padding={false}
        actions={
          <FilterBar onReset={() => setDeptFilter('')}>
            <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={filterInputStyle}>
              <option value="">All Departments</option>
              {depts.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </FilterBar>
        }
      >
        <DataTable<PayrollItem>
          cols={cols}
          rows={filtered}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/payroll/runs/${id}/items/${r.id}`)}
          emptyText="No payroll items found."
          skeletonRows={loading ? 8 : 0}
        />

        {/* Totals row */}
        {filtered.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr',
            padding: '10px 16px', borderTop: '2px solid var(--bdr)',
            background: 'var(--th-bg)', fontSize: 12.5, fontWeight: 700, color: 'var(--txt)',
            fontFamily: 'Inter, sans-serif',
          }}>
            <span>Total ({filtered.length})</span>
            <span />
            <span style={{ textAlign: 'right' }}>{fmtKobo(totals.gross)}</span>
            <span style={{ textAlign: 'right' }}>{fmtKobo(totals.paye)}</span>
            <span style={{ textAlign: 'right' }}>{fmtKobo(totals.nhf)}</span>
            <span style={{ textAlign: 'right' }}>{fmtKobo(totals.pension)}</span>
            <span style={{ textAlign: 'right', color: totals.loan > 0 ? AMBER : 'var(--txt)' }}>{totals.loan > 0 ? fmtKobo(totals.loan) : '—'}</span>
            <span style={{ textAlign: 'right', color: totals.other > 0 ? AMBER : 'var(--txt)' }}>{totals.other > 0 ? fmtKobo(totals.other) : '—'}</span>
            <span style={{ textAlign: 'right', color: GREEN }}>{fmtKobo(totals.net)}</span>
          </div>
        )}
      </SectionCard>

      {/* Confirm modals */}
      <ConfirmModal
        open={submitOpen}
        title="Submit for approval?"
        body={`This will submit the ${period} payroll run for manager approval. You will not be able to edit items after submission.`}
        confirmLabel={actioning ? 'Submitting…' : 'Submit'}
        loading={actioning}
        onConfirm={() => { setSubmitOpen(false); doAction('submit', 'Submitted for approval') }}
        onClose={() => setSubmitOpen(false)}
      />
      <ConfirmModal
        open={approveOpen}
        title="Approve payroll run?"
        body={`Approve the ${period} payroll run for ${run?.headcount} employees? Net total: ${fmtKobo(run?.total_net_kobo ?? 0)}`}
        confirmLabel={actioning ? 'Approving…' : 'Approve'}
        loading={actioning}
        onConfirm={() => { setApproveOpen(false); doAction('approve', 'Payroll approved') }}
        onClose={() => setApproveOpen(false)}
      />
      <ConfirmModal
        open={payOpen}
        title="Mark as paid?"
        body={`Confirm that ${period} payroll (${fmtKobo(run?.total_net_kobo ?? 0)} net) has been disbursed to all ${run?.headcount} employees.`}
        confirmLabel={actioning ? 'Processing…' : 'Mark Paid'}
        loading={actioning}
        onConfirm={() => { setPayOpen(false); doAction('pay', 'Payroll marked as paid') }}
        onClose={() => setPayOpen(false)}
      />
    </Page>
  )
}
