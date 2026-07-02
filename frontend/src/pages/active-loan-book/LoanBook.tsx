import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'

type Loan = {
  id: number
  reference: string
  applicant_name: string
  applicant_cif: string | null
  applicant_phone: string | null
  product_type: string | null
  loan_product: string | null
  disbursed_amount_kobo: number | null
  outstanding_kobo: number | null
  dpd: number | null
  next_due_date: string | null
  monthly_repayment_kobo: number | null
  maturity_date: string | null
  disbursed_at: string
  officer_name: string | null
}

type Stats = {
  summary: {
    total_loans: number; total_outstanding_kobo: number; total_disbursed_kobo: number
    current_count: number; dpd_1_30: number; dpd_31_60: number; dpd_61_90: number; dpd_90plus: number
    npl_outstanding_kobo: number
  }
  by_product: { product: string; count: number; outstanding_kobo: number }[]
}

const DPD_BUCKETS = [
  { key: '', label: 'All' },
  { key: 'current', label: 'Current' },
  { key: '1-30', label: '1–30 DPD' },
  { key: '31-60', label: '31–60 DPD' },
  { key: '61-90', label: '61–90 DPD' },
  { key: '90plus', label: '90+ DPD' },
]

const dpdColor = (dpd: number | null) => {
  if (!dpd || dpd === 0) return '#16a34a'
  if (dpd <= 30) return '#d97706'
  if (dpd <= 60) return '#ea580c'
  return '#dc2626'
}

export default function LoanBook() {
  const nav = useNavigate()
  const [loans, setLoans] = useState<Loan[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dpd, setDpd] = useState('')
  const [product, setProduct] = useState('')
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = (q = search, d = dpd, p = product) => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '200' })
    if (q) params.set('search', q)
    if (d) params.set('dpd_bucket', d)
    if (p) params.set('product', p)
    Promise.all([
      apiFetch(`/api/active-loans/?${params}`).then(r => r.json()),
      apiFetch('/api/active-loans/stats').then(r => r.json()),
    ]).then(([l, s]) => { setLoans(l); setStats(s) }).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (v: string) => {
    setSearch(v)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => load(v, dpd, product), 300)
  }

  const s = stats?.summary

  return (
    <div style={{ padding: '24px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>Active Loan Book</h1>

      {/* Stats Strip */}
      {s && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 24 }}>
          {[
            { label: 'Total Active Loans', value: fmtNum(s.total_loans) },
            { label: 'Total Outstanding', value: fmtKobo(s.total_outstanding_kobo), mono: true },
            { label: 'NPL Outstanding', value: fmtKobo(s.npl_outstanding_kobo), warn: true, mono: true },
            { label: 'Current', value: fmtNum(s.current_count), good: true },
            { label: '90+ DPD', value: fmtNum(s.dpd_90plus), bad: s.dpd_90plus > 0 },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt-2)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: k.mono ? 'DM Mono, monospace' : undefined, color: k.good ? '#16a34a' : k.warn ? '#d97706' : k.bad ? '#dc2626' : 'var(--txt)' }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* DPD Bucket Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {DPD_BUCKETS.map(b => (
          <button key={b.key} onClick={() => { setDpd(b.key); load(search, b.key, product) }}
            style={{ padding: '6px 14px', borderRadius: 20, border: '1px solid var(--bdr)', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: dpd === b.key ? '#0E2841' : 'var(--card)', color: dpd === b.key ? '#fff' : 'var(--txt)' }}>
            {b.label}
          </button>
        ))}
      </div>

      {/* Search + Product filter */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <input value={search} onChange={e => onSearch(e.target.value)} placeholder="Search name, CIF, reference…"
          style={{ flex: 1, maxWidth: 300, padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }} />
        <input value={product} onChange={e => { setProduct(e.target.value); load(search, dpd, e.target.value) }} placeholder="Filter by product…"
          style={{ width: 180, padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }} />
      </div>

      {/* Table */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--bg)' }}>
            <tr>
              {['Reference', 'Customer', 'Product', 'Disbursed', 'Outstanding', 'Monthly', 'Next Due', 'DPD', 'Officer'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--txt-2)', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: 'var(--txt-2)' }}>Loading…</td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: 'var(--txt-2)' }}>No active loans found.</td></tr>
            ) : loans.map(l => (
              <tr key={l.id} onClick={() => nav(`/active-loan-book/${l.id}`)} style={{ borderTop: '1px solid var(--bdr)', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}>
                <td style={{ padding: '10px 14px', fontFamily: 'DM Mono, monospace', color: '#2563eb', fontWeight: 600, whiteSpace: 'nowrap' }}>{l.reference}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt)', fontWeight: 500 }}>{l.applicant_name}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt-2)' }}>{l.product_type ?? l.loan_product ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt-2)', fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>{l.disbursed_amount_kobo ? fmtKobo(l.disbursed_amount_kobo) : '—'}</td>
                <td style={{ padding: '10px 14px', fontFamily: 'DM Mono, monospace', fontWeight: 600, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{l.outstanding_kobo ? fmtKobo(l.outstanding_kobo) : '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt-2)', fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>{l.monthly_repayment_kobo ? fmtKobo(l.monthly_repayment_kobo) : '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt-2)', whiteSpace: 'nowrap' }}>{l.next_due_date ? new Date(l.next_due_date).toLocaleDateString('en-GB') : '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ fontFamily: 'DM Mono, monospace', fontWeight: 700, color: dpdColor(l.dpd) }}>{l.dpd ?? 0}</span>
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt-2)' }}>{l.officer_name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
