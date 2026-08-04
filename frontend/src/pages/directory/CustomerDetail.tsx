import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, ErrBanner, Spinner, SectionCard } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, MONO, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────
// The account / products / transactions objects come straight from the source
// system with human-readable, space-separated keys — typed with quoted keys.

interface AccountRec {
  'CIF Number'?:  string | null
  'First Name'?:  string | null
  'Last Name'?:   string | null
  'Email'?:       string | null
  'Phone Number'?:string | null
  'Birthday'?:    string | null
  'State'?:       string | null
  'City'?:        string | null
  'Job Title'?:   string | null
}

interface ProductRec {
  'Product Name'?:    string | null
  'Account Status'?:  string | null
  'Name On Card'?:    string | null
  'Account Manager'?: string | null
}

interface TransactionRec {
  'Transaction Date'?: string | null
  'Amount'?:           number | string | null
  'Description'?:      string | null
  'Merchant_Name'?:    string | null
}

interface LoanApp {
  id:                    number
  reference:             string
  product_type:          string
  amount_requested_kobo: number
  amount_approved_kobo:  number
  status:                string
  stage:                 string
  created_at:            string
}

interface RecoveryCase {
  id:                     number
  case_ref:               string
  status:                 string
  total_outstanding_kobo: number
  total_recovered_kobo:   number
  created_at:             string
}

interface FinancialSummary {
  dpd_bucket?:                 string | null
  recovery_outstanding_kobo?:  number | null
  loan_approved_kobo?:         number | null
}

interface CardPosition {
  cards:             number
  outstanding_kobo:  number
  credit_limit_kobo: number
  overdue_kobo:      number
  min_payment_kobo:  number
  interest_kobo:     number
  cycle_date:        string | null
}

interface CardAccount {
  account_number:           string
  product:                  string
  outstanding_balance_kobo: number
  credit_limit_kobo:        number
  overdue_amount_kobo:      number
  minimum_payment_kobo:     number
  total_interest_kobo:      number
  utilization_pct:          number | string
  cycle_date:               string
}

interface C360Profile {
  account:           AccountRec | null
  products:          ProductRec[]
  transactions:      TransactionRec[]
  loan_apps:         LoanApp[]
  recovery_cases:    RecoveryCase[]
  card_position:     CardPosition | null
  card_accounts:     CardAccount[]
  financial_summary: FinancialSummary | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEC_TITLE: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em',
  textTransform: 'uppercase', color: 'var(--txt3)',
  marginBottom: 12, fontFamily: MONO,
}

function dpdColor(bucket: string | null | undefined): string {
  if (!bucket || bucket === 'Current') return GREEN
  if (bucket === '1-30') return AMBER
  return RED
}

// The Amount field may arrive as naira (units) or kobo (minor units). Heuristic:
// integer-valued magnitudes ≥ 100000 are treated as kobo; otherwise render raw.
function looksLikeKobo(v: number | string | null | undefined): boolean {
  const n = Number(v)
  return isFinite(n) && Number.isInteger(n) && Math.abs(n) >= 100_000
}

function fmtAmount(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!isFinite(n)) return String(v)
  if (looksLikeKobo(v)) return fmtKobo(n)
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ width: 130, fontSize: TEXT.sm, color: 'var(--txt3)', fontWeight: FW.semibold, flexShrink: 0 }}>{label}</div>
      <div style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{value}</div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CustomerDetail() {
  const { cif }  = useParams<{ cif: string }>()
  const navigate = useNavigate()

  const [data,    setData]    = useState<C360Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!cif) return
    setLoading(true); setError(null)
    try {
      // Backend wraps the profile in { data: {...} } (respond helper); unwrap it.
      const raw = await apiFetch<any>(`/api/customer360/${encodeURIComponent(cif)}`)
      setData((raw?.data ?? raw) as C360Profile)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [cif])

  useEffect(() => { load() }, [load])

  const BackLink = (
    <button
      onClick={() => navigate('/customers')}
      style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, cursor: 'pointer', fontFamily: 'inherit' }}
    >
      ← Back to directory
    </button>
  )

  if (loading) return <Page title="Customer" subtitle="" actions={BackLink}><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>
  if (error || !data) return <Page title="Customer" subtitle="" actions={BackLink}><ErrBanner error={error ?? 'Not found'} onRetry={load} /></Page>

  const { account, financial_summary } = data
  const products       = data.products ?? []
  const transactions   = data.transactions ?? []
  const loan_apps      = data.loan_apps ?? []
  const recovery_cases = data.recovery_cases ?? []
  const card_position  = data.card_position ?? null
  const card_accounts  = data.card_accounts ?? []

  const firstName = account?.['First Name'] ?? ''
  const lastName  = account?.['Last Name'] ?? ''
  const fullName  = `${firstName} ${lastName}`.trim() || 'Customer'
  const acctCif   = account?.['CIF Number'] ?? cif ?? ''
  const phone     = account?.['Phone Number'] ?? ''
  const email     = account?.['Email'] ?? ''
  const state     = account?.['State'] ?? ''
  const city      = account?.['City'] ?? ''
  const jobTitle  = account?.['Job Title'] ?? ''
  const location  = [city, state].filter(Boolean).join(', ')
  const dpdBucket = financial_summary?.dpd_bucket ?? null

  const TH: React.CSSProperties = {
    textAlign: 'left', padding: '8px 12px', fontSize: TEXT.xs, fontWeight: FW.bold,
    color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.04em',
    background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
  }
  const TD: React.CSSProperties = {
    padding: '9px 12px', fontSize: TEXT.sm, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)',
  }

  return (
    <Page title={fullName} subtitle={jobTitle || undefined} actions={BackLink}>
      {/* Identity header card */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: `${SP[5]} ${SP[6]}`, marginBottom: SP[5] }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
          <div style={{ width: 56, height: 56, borderRadius: RADIUS.full, background: `${NAVY}15`, border: `2px solid ${NAVY}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: NAVY, flexShrink: 0 }}>
            {(firstName.charAt(0) || 'C').toUpperCase()}{(lastName.charAt(0) || '').toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)' }}>{fullName}</h2>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', background: 'var(--row-hvr)', padding: `2px ${SP[2]}`, borderRadius: RADIUS.sm, fontFamily: MONO }}>CIF: {acctCif}</span>
              {dpdBucket && (
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 10px', borderRadius: RADIUS.lg, background: `${dpdColor(dpdBucket)}18`, color: dpdColor(dpdBucket) }}>
                  DPD: {dpdBucket}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 20, marginTop: 8, flexWrap: 'wrap' }}>
              {phone && <a href={`tel:${phone}`} style={{ fontSize: TEXT.base, color: NAVY, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}><span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>{phone}</a>}
              {email && <a href={`mailto:${email}`} style={{ fontSize: TEXT.base, color: NAVY, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}><span className="material-symbols-rounded" style={{ fontSize: 15 }}>mail</span>{email}</a>}
              {location && <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', display: 'flex', alignItems: 'center', gap: 4 }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>location_on</span>{location}</span>}
            </div>
          </div>
          {/* Financial summary tiles */}
          <div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
            {[
              ...(card_position && card_position.cards > 0 ? [{ label: 'Card Balance', value: fmtKobo(card_position.outstanding_kobo), color: card_position.overdue_kobo > 0 ? RED : NAVY }] : []),
              { label: 'Loan Approved', value: financial_summary?.loan_approved_kobo != null ? fmtKobo(financial_summary.loan_approved_kobo) : '—', color: BLUE },
              { label: 'Recovery O/S',  value: financial_summary?.recovery_outstanding_kobo != null ? fmtKobo(financial_summary.recovery_outstanding_kobo) : '—', color: AMBER },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ textAlign: 'center', padding: `${SP[2]} ${SP[3]}`, background: `${color}08`, borderRadius: RADIUS.lg, border: `1px solid ${color}20`, minWidth: 96 }}>
                <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color, ...NUM }}>{value}</div>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Account details */}
        {account && (
          <div style={{ marginTop: SP[4], display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px' }}>
            <div>
              <InfoRow label="Phone"     value={phone} />
              <InfoRow label="Email"     value={email} />
              <InfoRow label="Job Title" value={jobTitle} />
            </div>
            <div>
              <InfoRow label="State"    value={state} />
              <InfoRow label="City"     value={city} />
              <InfoRow label="Birthday" value={account['Birthday'] ? fmtDate(account['Birthday']) : null} />
            </div>
          </div>
        )}
      </div>

      {/* Products */}
      <SectionCard title="Products" badge={products.length} padding={false} style={{ marginBottom: SP[5] }}>
        {products.length === 0 ? (
          <div style={{ textAlign: 'center', padding: SP[10], color: 'var(--txt3)', fontSize: TEXT.base }}>No products on record</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Product</th>
                  <th style={TH}>Status</th>
                  <th style={TH}>Name On Card</th>
                  <th style={TH}>Account Manager</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p, i) => (
                  <tr key={i}>
                    <td style={{ ...TD, fontWeight: FW.semibold }}>{p['Product Name'] || '—'}</td>
                    <td style={{ ...TD, color: 'var(--txt2)' }}>{p['Account Status'] || '—'}</td>
                    <td style={{ ...TD, color: 'var(--txt2)' }}>{p['Name On Card'] || '—'}</td>
                    <td style={{ ...TD, color: 'var(--txt2)' }}>{p['Account Manager'] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Credit Card position (latest billing cycle) */}
      {card_position && card_position.cards > 0 && (
        <SectionCard
          title="Credit Cards"
          badge={card_position.cards}
          padding={false}
          style={{ marginBottom: SP[5] }}
        >
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: `${SP[3]} 12px`, borderBottom: '1px solid var(--bdr)' }}>
            {[
              { label: 'Balance',     value: fmtKobo(card_position.outstanding_kobo), color: NAVY },
              { label: 'Credit Limit',value: fmtKobo(card_position.credit_limit_kobo), color: BLUE },
              { label: 'Min Payment', value: fmtKobo(card_position.min_payment_kobo),  color: AMBER },
              { label: 'Overdue',     value: fmtKobo(card_position.overdue_kobo),      color: card_position.overdue_kobo > 0 ? RED : GREEN },
              { label: 'Interest',    value: fmtKobo(card_position.interest_kobo),     color: 'var(--txt2)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ minWidth: 120 }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
                <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color, ...NUM, marginTop: 2 }}>{value}</div>
              </div>
            ))}
            {card_position.cycle_date && (
              <div style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: MONO }}>Cycle {card_position.cycle_date}</div>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Account</th>
                  <th style={TH}>Product</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Balance</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Limit</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Util</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Min Pymt</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {card_accounts.map((c, i) => {
                  const util = Number(c.utilization_pct)
                  return (
                    <tr key={i}>
                      <td style={{ ...TD, ...NUM, color: 'var(--txt2)' }}>{c.account_number}</td>
                      <td style={{ ...TD, fontWeight: FW.semibold }}>{c.product}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right' }}>{fmtKobo(c.outstanding_balance_kobo)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{fmtKobo(c.credit_limit_kobo)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: util >= 90 ? RED : util >= 70 ? AMBER : 'var(--txt2)', fontWeight: FW.semibold }}>{util.toFixed(0)}%</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: 'var(--txt2)' }}>{fmtKobo(c.minimum_payment_kobo)}</td>
                      <td style={{ ...TD, ...NUM, textAlign: 'right', color: c.overdue_amount_kobo > 0 ? RED : 'var(--txt3)' }}>{fmtKobo(c.overdue_amount_kobo)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* Recent Transactions */}
      <SectionCard title="Recent Transactions" badge={transactions.length} padding={false} style={{ marginBottom: SP[5] }}>
        {transactions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: SP[10], color: 'var(--txt3)', fontSize: TEXT.base }}>No transactions on record</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Date</th>
                  <th style={TH}>Description</th>
                  <th style={TH}>Merchant</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, i) => (
                  <tr key={i}>
                    <td style={{ ...TD, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtDate(t['Transaction Date'])}</td>
                    <td style={{ ...TD }}>{t['Description'] || '—'}</td>
                    <td style={{ ...TD, color: 'var(--txt2)' }}>{t['Merchant_Name'] || '—'}</td>
                    <td style={{ ...TD, ...NUM, textAlign: 'right', fontWeight: FW.semibold }}>{fmtAmount(t['Amount'])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Loan Applications */}
      <SectionCard title="Loan Applications" badge={loan_apps.length} padding={false} style={{ marginBottom: SP[5] }}>
        {loan_apps.length === 0 ? (
          <div style={{ textAlign: 'center', padding: SP[10], color: 'var(--txt3)', fontSize: TEXT.base }}>No loan applications</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Reference</th>
                  <th style={TH}>Product</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Requested</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Approved</th>
                  <th style={TH}>Status</th>
                  <th style={TH}>Stage</th>
                  <th style={TH}>Created</th>
                </tr>
              </thead>
              <tbody>
                {loan_apps.map(l => (
                  <tr key={l.id}>
                    <td style={{ ...TD, ...NUM, color: 'var(--txt2)' }}>{l.reference}</td>
                    <td style={{ ...TD, fontWeight: FW.semibold }}>{l.product_type}</td>
                    <td style={{ ...TD, ...NUM, textAlign: 'right' }}>{fmtKobo(l.amount_requested_kobo)}</td>
                    <td style={{ ...TD, ...NUM, textAlign: 'right' }}>{fmtKobo(l.amount_approved_kobo)}</td>
                    <td style={{ ...TD, color: 'var(--txt2)', textTransform: 'capitalize' }}>{l.status}</td>
                    <td style={{ ...TD, color: 'var(--txt2)', textTransform: 'capitalize' }}>{l.stage}</td>
                    <td style={{ ...TD, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{fmtDate(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Recovery Cases */}
      <SectionCard title="Recovery Cases" badge={recovery_cases.length} padding={false}>
        {recovery_cases.length === 0 ? (
          <div style={{ textAlign: 'center', padding: SP[10], color: 'var(--txt3)', fontSize: TEXT.base }}>No recovery cases</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>Case Ref</th>
                  <th style={TH}>Status</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Outstanding</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Recovered</th>
                  <th style={TH}>Created</th>
                </tr>
              </thead>
              <tbody>
                {recovery_cases.map(c => (
                  <tr key={c.id}>
                    <td style={{ ...TD, ...NUM, color: 'var(--txt2)' }}>{c.case_ref}</td>
                    <td style={{ ...TD, color: 'var(--txt2)', textTransform: 'capitalize' }}>{c.status}</td>
                    <td style={{ ...TD, ...NUM, textAlign: 'right', color: RED }}>{fmtKobo(c.total_outstanding_kobo)}</td>
                    <td style={{ ...TD, ...NUM, textAlign: 'right', color: GREEN }}>{fmtKobo(c.total_recovered_kobo)}</td>
                    <td style={{ ...TD, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{fmtDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
