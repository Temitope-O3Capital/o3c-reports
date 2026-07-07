import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

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
}

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// ── Main component ─────────────────────────────────────────────────────────────

export default function PayslipView() {
  const { runId, itemId } = useParams<{ runId: string; itemId: string }>()

  const [item, setItem] = useState<PayrollItem | null>(null)
  const [period, setPeriod] = useState<{ year: number; month: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true); setErr(null)
      try {
        const [runData, items] = await Promise.all([
          apiFetch<any>(`/api/payroll/runs/${runId}`),
          apiFetch<PayrollItem[]>(`/api/payroll/runs/${runId}/items`),
        ])
        const run = Array.isArray(runData) ? runData[0] : runData
        setPeriod({ year: run.period_year, month: run.period_month })
        const found = (Array.isArray(items) ? items : []).find(i => String(i.id) === itemId)
        if (!found) throw new Error('Payslip not found')
        setItem(found)
      } catch (e: any) { setErr(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [runId, itemId])

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
      <Spinner size={36} />
    </div>
  )
  if (err) return <ErrBanner error={err} />
  if (!item || !period) return null

  const periodLabel = `${MONTHS[period.month]} ${period.year}`
  const employerPension = Math.round(item.gross_kobo * 0.10)
  const totalDeductions = item.paye_kobo + item.employee_pension_kobo + item.nhf_kobo
    + item.loan_deduction_kobo + item.other_deduction_kobo

  const earnings = [
    { label: 'Basic Salary',        amount: item.basic_kobo },
    { label: 'Housing Allowance',   amount: item.housing_kobo },
    { label: 'Transport Allowance', amount: item.transport_kobo },
    { label: 'Other Allowances',    amount: item.other_allowance_kobo },
  ].filter(e => e.amount > 0)

  const deductions = [
    { label: 'PAYE Tax',            amount: item.paye_kobo },
    { label: 'Pension (Employee)',  amount: item.employee_pension_kobo },
    { label: 'NHF',                 amount: item.nhf_kobo },
    ...(item.loan_deduction_kobo > 0 ? [{ label: 'Loan Repayment', amount: item.loan_deduction_kobo }] : []),
    ...(item.other_deduction_kobo > 0 ? [{ label: 'Other Deductions', amount: item.other_deduction_kobo }] : []),
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#F4F6F8', padding: '32px 16px', fontFamily: "'Sora', 'Inter', sans-serif" }}>
      {/* Print / Download actions */}
      <div style={{ maxWidth: 680, margin: '0 auto 16px', display: 'flex', gap: 8, justifyContent: 'flex-end' }} className="no-print">
        <button
          onClick={() => window.print()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>print</span>
          Print
        </button>
      </div>

      {/* Payslip card */}
      <div id="payslip" style={{ maxWidth: 680, margin: '0 auto', background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 4px 24px rgba(0,0,0,.07)' }}>
        {/* Header */}
        <div style={{ background: NAVY, color: '#fff', padding: '28px 32px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px' }}>O3 Capital</div>
              <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>Pay Advice — {periodLabel}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 2 }}>CONFIDENTIAL</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Payslip for {periodLabel}</div>
            </div>
          </div>
        </div>

        {/* Employee info */}
        <div style={{ padding: '20px 32px', borderBottom: '1px solid #E5E7EB', background: '#F9FAFB' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              ['Employee Name',  item.employee_name],
              ['Staff ID',       item.staff_id ?? '—'],
              ['Department',     item.department ?? '—'],
              ['Job Title',      item.job_title ?? '—'],
              ['Grade Level',    item.grade_level ?? '—'],
              ['Bank / Account', item.bank_name ? `${item.bank_name} — ${item.account_number ?? ''}` : '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: 10.5, color: '#6B7280', fontWeight: 600, marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 13, color: '#111827', fontWeight: label === 'Employee Name' ? 700 : 400 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Earnings & Deductions side by side */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          {/* Earnings */}
          <div style={{ padding: '20px 24px 20px 32px', borderRight: '1px solid #E5E7EB' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: NAVY, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Earnings</div>
            {earnings.map(e => (
              <div key={e.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 13 }}>
                <span style={{ color: '#374151' }}>{e.label}</span>
                <span style={{ ...NUM, fontWeight: 500 }}>{fmtKobo(e.amount)}</span>
              </div>
            ))}
            <div style={{ borderTop: '1.5px solid #E5E7EB', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: NAVY }}>Gross Pay</span>
              <span style={{ ...NUM, fontWeight: 700, color: NAVY }}>{fmtKobo(item.gross_kobo)}</span>
            </div>
          </div>

          {/* Deductions */}
          <div style={{ padding: '20px 32px 20px 24px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#C00000', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Deductions</div>
            {deductions.map(d => (
              <div key={d.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 13 }}>
                <span style={{ color: '#374151' }}>{d.label}</span>
                <span style={{ ...NUM, fontWeight: 500, color: AMBER }}>{fmtKobo(d.amount)}</span>
              </div>
            ))}
            <div style={{ borderTop: '1.5px solid #E5E7EB', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#C00000' }}>Total Deductions</span>
              <span style={{ ...NUM, fontWeight: 700, color: '#C00000' }}>{fmtKobo(totalDeductions)}</span>
            </div>
          </div>
        </div>

        {/* Net Pay highlight */}
        <div style={{ margin: '0 32px 24px', background: `${GREEN}10`, border: `1.5px solid ${GREEN}30`, borderRadius: 10, padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, color: GREEN, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Net Pay</div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>Amount to be credited to bank account</div>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: GREEN, fontFamily: 'Inter, sans-serif' }}>{fmtKobo(item.net_kobo)}</div>
        </div>

        {/* Employer contributions */}
        <div style={{ margin: '0 32px 24px', borderTop: '1px solid #E5E7EB', paddingTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Employer Contributions</div>
          <div style={{ display: 'flex', gap: 24, fontSize: 12.5, color: '#374151' }}>
            <div>
              <span style={{ color: '#6B7280' }}>Employer Pension (10%): </span>
              <span style={NUM}>{fmtKobo(employerPension)}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 32px', background: '#F9FAFB', borderTop: '1px solid #E5E7EB', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--chart-lbl)' }}>This is a computer-generated payslip and does not require a signature.</span>
          <span style={{ fontSize: 11, color: 'var(--chart-lbl)' }}>O3 Capital · {periodLabel}</span>
        </div>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          #payslip { box-shadow: none; border-radius: 0; max-width: 100%; }
        }
      `}</style>
    </div>
  )
}
