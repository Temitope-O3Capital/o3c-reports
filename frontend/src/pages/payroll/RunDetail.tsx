import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  ConfirmModal, ErrBanner, Spinner, btnPrimary, btnSecondary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Payslip modal ──────────────────────────────────────────────────────────────

interface PayslipData {
  employee_id: number
  employee_name?: string
  period_month?: number
  period_year?: number
  gross_kobo: number
  net_kobo: number
  paye_kobo: number
  pension_kobo: number
  other_deductions_kobo: number
  generated_at?: string
}

function PayslipModal({ data, period, onClose }: { data: PayslipData; period: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--card)', borderRadius: RADIUS.xl, padding: 28, width: 380, maxWidth: '95vw', border: '1px solid var(--card-bdr)', boxShadow: '0 8px 40px rgba(0,0,0,.18)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 2 }}>Payslip — {period}</div>
            {data.employee_name && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{data.employee_name}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: TEXT.xl, color: 'var(--txt3)', lineHeight: 1 }}>×</button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
          <tbody>
            {[
              { label: 'Gross Pay', value: fmtKobo(data.gross_kobo), bold: false },
              { label: 'PAYE Tax', value: `– ${fmtKobo(data.paye_kobo)}`, bold: false },
              { label: 'Pension', value: `– ${fmtKobo(data.pension_kobo)}`, bold: false },
              { label: 'Other Deductions', value: `– ${fmtKobo(data.other_deductions_kobo)}`, bold: false },
              { label: 'Net Pay', value: fmtKobo(data.net_kobo), bold: true },
            ].map(row => (
              <tr key={row.label} style={{ borderTop: '1px solid var(--bdr)' }}>
                <td style={{ padding: '8px 0', color: 'var(--txt2)', fontWeight: row.bold ? 700 : 400 }}>{row.label}</td>
                <td style={{ padding: '8px 0', textAlign: 'right', fontFamily: 'Inter, monospace', fontWeight: row.bold ? 700 : 500, color: row.bold ? GREEN : 'var(--txt)' }}>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.generated_at && (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[3], textAlign: 'center' }}>
            Generated {fmtDate(data.generated_at)}
          </div>
        )}
      </div>
    </div>
  )
}

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
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: s.bg, color: s.color }}>
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

  // C6: Payslip modal state
  const [payslip, setPayslip] = useState<PayslipData | null>(null)

  async function viewPayslip(item: PayrollItem, e: React.MouseEvent) {
    e.stopPropagation() // don't trigger row click navigation
    try {
      const data = await apiFetch<PayslipData>(`/api/payroll/payslips/${id}/${item.employee_id}`)
      setPayslip({ ...data, employee_name: item.employee_name })
    } catch {
      toast.error('Could not load payslip')
    }
  }

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
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.employee_name}</div>
          {r.staff_id && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'Inter, monospace' }}>{r.staff_id}</div>}
        </div>
      ),
    },
    {
      key: 'department', label: 'Dept',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.department ?? '—'}</span>,
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
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: GREEN }}>{fmtKobo(r.net_kobo)}</span>,
    },
    // C6: Payslip download button — only shown for paid runs
    ...(run?.status === 'paid' ? [{
      key: 'payslip' as keyof PayrollItem,
      label: '',
      render: (r: PayrollItem) => (
        <button
          onClick={e => viewPayslip(r, e)}
          style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '3px 10px' }}
        >
          Payslip
        </button>
      ),
    }] : []),
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
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[5] }}>
          {[
            { label: 'Headcount',   value: run.headcount },
            { label: 'Gross Total', value: fmtKobo(run.total_gross_kobo) },
            { label: 'Net Total',   value: fmtKobo(run.total_net_kobo) },
            { label: 'PAYE Total',  value: fmtKobo(run.total_paye_kobo) },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: '14px 18px' }}>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.medium, marginBottom: SP[1] }}>{label}</div>
              <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: 'Inter, sans-serif' }}>{value}</div>
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
            background: 'var(--th-bg)', fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)',
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

      {/* C6: Payslip modal */}
      {payslip && <PayslipModal data={payslip} period={period} onClose={() => setPayslip(null)} />}
    </Page>
  )
}
