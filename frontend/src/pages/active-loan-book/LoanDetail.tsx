import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'

type Loan = Record<string, unknown>

const dpdColor = (dpd: unknown) => {
  const n = Number(dpd)
  if (!n || n === 0) return '#16a34a'
  if (n <= 30) return '#d97706'
  if (n <= 60) return '#ea580c'
  return '#dc2626'
}

export default function LoanDetail() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [loan, setLoan] = useState<Loan | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch(`/api/active-loans/${id}`).then(r => {
      if (!r.ok) { nav('/active-loan-book'); return null }
      return r.json()
    }).then(d => { if (d) setLoan(d) }).finally(() => setLoading(false))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={{ padding: 32, color: 'var(--txt-2)' }}>Loading…</div>
  if (!loan) return null

  const str = (k: string) => (loan[k] as string) ?? '—'
  const num = (k: string) => Number(loan[k]) || 0

  return (
    <div style={{ padding: '24px 32px' }}>
      <button onClick={() => nav('/active-loan-book')} style={{ background: 'none', border: 'none', color: 'var(--txt-2)', cursor: 'pointer', fontSize: 13, marginBottom: 16, padding: 0 }}>
        ← Back to Loan Book
      </button>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--txt)', marginBottom: 4 }}>{str('applicant_name')}</h1>
          <div style={{ fontSize: 13, color: 'var(--txt-2)', fontFamily: 'DM Mono, monospace' }}>{str('reference')}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, color: 'var(--txt-2)', marginBottom: 4 }}>DPD</div>
          <div style={{ fontSize: 32, fontWeight: 800, fontFamily: 'DM Mono, monospace', color: dpdColor(loan.dpd) }}>{num('dpd')}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Loan Details */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: 'var(--txt)' }}>Loan Details</h2>
          {[
            ['Product', str('product_type') !== '—' ? str('product_type') : str('loan_product')],
            ['CIF', str('applicant_cif')],
            ['Phone', str('applicant_phone')],
            ['Disbursed Amount', fmtKobo(num('disbursed_amount_kobo'))],
            ['Outstanding', fmtKobo(num('outstanding_kobo'))],
            ['Monthly Repayment', fmtKobo(num('monthly_repayment_kobo'))],
            ['Disbursed On', loan.disbursed_at ? new Date(loan.disbursed_at as string).toLocaleDateString('en-GB') : '—'],
            ['Next Due Date', loan.next_due_date ? new Date(loan.next_due_date as string).toLocaleDateString('en-GB') : '—'],
            ['Maturity Date', loan.maturity_date ? new Date(loan.maturity_date as string).toLocaleDateString('en-GB') : '—'],
            ['Loan Officer', str('officer_name')],
          ].map(([label, value]) => (
            <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, fontSize: 13 }}>
              <span style={{ color: 'var(--txt-2)' }}>{label}</span>
              <span style={{ color: 'var(--txt)', fontWeight: 500, fontFamily: (label as string).includes('Amount') || (label as string).includes('Repayment') || (label as string).includes('Outstanding') ? 'DM Mono, monospace' : undefined }}>{value}</span>
            </div>
          ))}
        </div>

        {/* DPD Bucket Visual */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: 'var(--txt)' }}>Portfolio Classification</h2>
          {[
            { label: 'Current (0 DPD)', range: [0, 0], color: '#16a34a' },
            { label: '1–30 DPD (Watch)', range: [1, 30], color: '#d97706' },
            { label: '31–60 DPD (Substandard)', range: [31, 60], color: '#ea580c' },
            { label: '61–90 DPD (Doubtful)', range: [61, 90], color: '#f97316' },
            { label: '90+ DPD (Loss)', range: [91, Infinity], color: '#dc2626' },
          ].map(b => {
            const dpd = num('dpd')
            const active = dpd >= b.range[0] && dpd <= b.range[1]
            return (
              <div key={b.label} style={{
                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
                padding: '10px 14px', borderRadius: 8,
                background: active ? b.color + '18' : 'transparent',
                border: `1px solid ${active ? b.color : 'transparent'}`,
              }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: b.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: active ? 700 : 400, color: active ? b.color : 'var(--txt-2)' }}>{b.label}</span>
                {active && <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: b.color }}>● Current</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
