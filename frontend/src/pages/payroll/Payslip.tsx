import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { Page, Spinner, ErrBanner } from '../../components/UI'

const NAVY  = '#0E2841'
const INTER = "'Inter', ui-sans-serif, sans-serif"
const MONO  = "'DM Mono', ui-monospace, monospace"

function Row({ label, value, bold, red }: { label: string; value: string; bold?: boolean; red?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: 13, color: bold ? 'var(--txt)' : 'var(--txt2)', fontFamily: INTER, fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontSize: 13, fontFamily: MONO, fontWeight: bold ? 700 : 400, color: red ? '#C00000' : 'var(--txt)' }}>{value}</span>
    </div>
  )
}

function monthName(y: number, m: number) {
  return new Date(y, m - 1, 1).toLocaleString('en-NG', { month: 'long', year: 'numeric' })
}

export default function Payslip() {
  const { runId, itemId } = useParams()
  const [run,  setRun]  = useState<any>(null)
  const [item, setItem] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    Promise.all([
      apiFetch(`/api/payroll/runs/${runId}`).then(r => r.json()),
      apiFetch(`/api/payroll/runs/${runId}/items`).then(r => r.json()),
    ]).then(([r, items]) => {
      setRun(r)
      const found = Array.isArray(items) ? items.find((i: any) => String(i.id) === itemId) : null
      if (!found) setErr('Payslip not found')
      else setItem(found)
    }).catch(() => setErr('Failed to load payslip')).finally(() => setLoading(false))
  }, [runId, itemId])

  return (
    <Page title="Payslip" dept="Payroll Run" deptPath={`/payroll/runs/${runId}`}>
      {loading && <Spinner />}
      {err && <ErrBanner msg={err} />}
      {run && item && (
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div className="card" style={{ padding: 32 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28, paddingBottom: 20, borderBottom: '2px solid var(--bdr)' }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: NAVY, letterSpacing: -0.5 }}>O3 Capital</div>
                <div style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>Salary Payslip — {monthName(run.period_year, run.period_month)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>Status</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: run.status === 'paid' ? '#166534' : 'var(--txt)', marginTop: 2, textTransform: 'capitalize' }}>{run.status}</div>
                {run.paid_at && <div style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>{fmtDate(run.paid_at)}</div>}
              </div>
            </div>

            {/* Employee info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 28, padding: '16px 0', borderBottom: '1px solid var(--bdr)' }}>
              {[
                ['Employee', item.employee_name],
                ['Staff ID', item.staff_id ?? '—'],
                ['Job Title', item.job_title ?? '—'],
                ['Department', item.department ?? '—'],
                ['Grade Level', item.grade_level ?? '—'],
                ['Bank', item.bank_name ? `${item.bank_name} · ${item.account_number ?? '—'}` : '—'],
              ].map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--txt2)', fontFamily: INTER, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Earnings */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: NAVY, fontFamily: INTER, marginBottom: 10 }}>Earnings</div>
              <Row label="Basic Salary"       value={fmtKobo(item.basic_kobo)} />
              <Row label="Housing Allowance"  value={fmtKobo(item.housing_kobo)} />
              <Row label="Transport Allowance" value={fmtKobo(item.transport_kobo)} />
              {item.other_allowance_kobo > 0 && <Row label="Other Allowances" value={fmtKobo(item.other_allowance_kobo)} />}
              <Row label="Gross Pay" value={fmtKobo(item.gross_kobo)} bold />
            </div>

            {/* Deductions */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: '#C00000', fontFamily: INTER, marginBottom: 10 }}>Deductions</div>
              <Row label="PAYE (Income Tax)"   value={fmtKobo(item.paye_kobo)}              red />
              <Row label="Pension (Employee 8%)" value={fmtKobo(item.employee_pension_kobo)} red />
              <Row label="NHF (2.5% Basic)"    value={fmtKobo(item.nhf_kobo)}               red />
              {item.loan_deduction_kobo > 0 && <Row label="Staff Loan Repayment" value={fmtKobo(item.loan_deduction_kobo)} red />}
              {item.other_deduction_kobo > 0 && <Row label="Other Deductions" value={fmtKobo(item.other_deduction_kobo)} red />}
              <Row label="Total Deductions"
                value={fmtKobo(item.paye_kobo + item.employee_pension_kobo + item.nhf_kobo + item.loan_deduction_kobo + item.other_deduction_kobo)}
                bold red />
            </div>

            {/* Net */}
            <div style={{ background: NAVY, borderRadius: 12, padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)', fontFamily: INTER }}>NET PAY</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', fontFamily: MONO, letterSpacing: -0.5 }}>{fmtKobo(item.net_kobo)}</div>
            </div>

            {item.notes && (
              <div style={{ marginTop: 20, padding: '12px 16px', background: 'var(--chip-bg)', borderRadius: 9, fontSize: 12.5, color: 'var(--txt2)', fontFamily: INTER }}>
                Note: {item.notes}
              </div>
            )}

            <div style={{ marginTop: 24, fontSize: 11, color: 'var(--txt2)', fontFamily: INTER, textAlign: 'center' }}>
              This payslip was generated on {fmtDate(new Date().toISOString())} · O3 Capital Management Ltd
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
