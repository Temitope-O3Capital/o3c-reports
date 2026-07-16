import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, SectionCard } from '../../components/UI'
import { apiFetch, API } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER } from '../../lib/design'

interface Statement {
  id: number
  customer_name: string
  customer_address?: string
  account_number: string
  statement_date: string
  payment_due_date?: string
  line_of_credit_kobo?: number
  opening_balance_kobo: number
  total_debit_kobo: number
  total_credit_kobo: number
  closing_balance_kobo: number
  min_payment_kobo?: number
  finance_charge_kobo?: number
  source: string
  source_filename?: string
  created_at: string
  created_by_name?: string
}

interface Transaction {
  id: number
  card_pan?: string
  txn_date?: string
  posting_date?: string
  trace_no?: string
  description: string
  debit_kobo: number
  credit_kobo: number
  is_finance_charge: boolean
  seq: number
}

function KoboCell({ value, color }: { value: number; color?: string }) {
  if (!value) return <span style={{ color: '#CBD5E1' }}>—</span>
  return <span style={{ fontFamily: 'DM Mono, monospace', color }}>{fmtKobo(value)}</span>
}

function Metric({ label, value, color, warn }: { label: string; value: string; color?: string; warn?: boolean }) {
  return (
    <div style={{ padding: '14px 18px', background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8 }}>
      <div style={{ fontSize: 11, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? NAVY, fontFamily: 'DM Mono, monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
        {value}
        {warn && <span className="material-symbols-rounded" style={{ fontSize: 16, color: RED }}>warning</span>}
      </div>
    </div>
  )
}

// ── Send-by-email modal ───────────────────────────────────────────────────────
function SendModal({ statementId, customerName, onClose }: {
  statementId: number
  customerName: string
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [subject, setSubject] = useState('')
  const [sending, setSending] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  useEffect(() => { emailRef.current?.focus() }, [])

  const send = async () => {
    if (!email.includes('@')) { toast.error('Enter a valid email address'); return }
    setSending(true)
    try {
      const res = await apiFetch(`/api/cc-statements/${statementId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_email: email, subject }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? 'Send failed')
      toast.success(`Statement emailed to ${email}`)
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 10, width: 440, padding: 28, boxShadow: '0 8px 32px rgba(0,0,0,.2)' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: NAVY, marginBottom: 4 }}>Send Statement by Email</div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 20 }}>Statement for {customerName} will be sent as a formatted email.</div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 5 }}>Recipient Email *</label>
          <input
            ref={emailRef}
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send() }}
            placeholder="customer@example.com"
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, outline: 'none' }}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 5 }}>Subject (optional)</label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Auto-generated if blank"
            style={{ width: '100%', padding: '9px 12px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, outline: 'none' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#64748B' }}>
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending}
            style={{ padding: '8px 20px', background: sending ? '#94A3B8' : NAVY, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: sending ? 'default' : 'pointer' }}
          >
            {sending ? 'Sending…' : 'Send Email'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main detail page ──────────────────────────────────────────────────────────
export default function CCStatementDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [statement, setStatement] = useState<Statement | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [cardFilter, setCardFilter] = useState('')
  const [showSend, setShowSend] = useState(false)

  const openPreview = async () => {
    try {
      // Use raw fetch: apiFetch always JSON-parses; the render endpoint returns HTML.
      const res = await fetch(`${API}/api/cc-statements/${id}/render`, { credentials: 'include' })
      if (!res.ok) throw new Error('Could not load preview')
      const html = await res.text()
      const blob = new Blob([html], { type: 'text/html' })
      window.open(URL.createObjectURL(blob), '_blank')
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  useEffect(() => {
    if (!id) return
    setLoading(true)
    apiFetch<any>(`/api/cc-statements/${id}`)
      .then(d => {
        const payload = d.data ?? d
        setStatement(payload.statement ?? null)
        setTransactions(payload.transactions ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return (
    <Page title="Loading…">
      <div style={{ textAlign: 'center', padding: 60, color: '#94A3B8' }}>Loading statement…</div>
    </Page>
  )

  if (!statement) return (
    <Page title="Not Found">
      <div style={{ textAlign: 'center', padding: 60, color: '#94A3B8' }}>Statement not found.</div>
    </Page>
  )

  const overLimit = statement.line_of_credit_kobo && statement.closing_balance_kobo > statement.line_of_credit_kobo

  // Group transactions by card PAN
  const cards = [...new Set(transactions.map(t => t.card_pan).filter(Boolean))] as string[]
  const filtered = cardFilter
    ? transactions.filter(t => t.card_pan === cardFilter)
    : transactions

  const nonFinanceCount = transactions.filter(t => !t.is_finance_charge).length

  return (
    <>
    {showSend && statement && (
      <SendModal
        statementId={statement.id}
        customerName={statement.customer_name}
        onClose={() => setShowSend(false)}
      />
    )}
    <Page
      title={statement.customer_name}
      subtitle={`Account ${statement.account_number} · Statement ${fmtDate(statement.statement_date)}`}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => navigate('/statements/credit-cards')}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#64748B' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_back</span>
            All Statements
          </button>
          <button
            onClick={openPreview}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: NAVY }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span>
            Preview
          </button>
          <button
            onClick={() => setShowSend(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: NAVY, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>
            Send by Email
          </button>
        </div>
      }
    >
      {/* Customer header */}
      <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, padding: '16px 20px', marginBottom: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Customer</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: NAVY, marginTop: 2 }}>{statement.customer_name}</div>
          {statement.customer_address && <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{statement.customer_address}</div>}
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Account</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: NAVY, marginTop: 2, fontFamily: 'DM Mono, monospace' }}>{statement.account_number}</div>
        </div>
        {statement.payment_due_date && (
          <div>
            <div style={{ fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Payment Due</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: RED, marginTop: 2 }}>{fmtDate(statement.payment_due_date)}</div>
          </div>
        )}
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Source</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginTop: 2, textTransform: 'capitalize' }}>
            {statement.source === 'db' ? 'Database Query' : `File Upload${statement.source_filename ? `: ${statement.source_filename}` : ''}`}
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>Added {fmtDate(statement.created_at)}{statement.created_by_name ? ` by ${statement.created_by_name}` : ''}</div>
        </div>
      </div>

      {/* Cycle summary metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Metric label="Opening Balance"  value={fmtKobo(statement.opening_balance_kobo)} />
        <Metric label="Total Debits"     value={fmtKobo(statement.total_debit_kobo)}     color={RED} />
        <Metric label="Total Credits"    value={fmtKobo(statement.total_credit_kobo)}    color={GREEN} />
        {(statement.finance_charge_kobo ?? 0) > 0 && (
          <Metric label="Finance Charge" value={fmtKobo(statement.finance_charge_kobo!)} color={AMBER} />
        )}
        <Metric label="Closing Balance"  value={fmtKobo(statement.closing_balance_kobo)} color={overLimit ? RED : NAVY} warn={!!overLimit} />
        {statement.line_of_credit_kobo && (
          <Metric label="Line of Credit" value={fmtKobo(statement.line_of_credit_kobo)} />
        )}
        {statement.min_payment_kobo && (
          <Metric label="Min Payment"    value={fmtKobo(statement.min_payment_kobo)}     color={RED} />
        )}
        <Metric label="Transactions"     value={String(nonFinanceCount)} />
      </div>

      {overLimit && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: RED }}>warning</span>
          <span style={{ color: '#991B1B', fontWeight: 500 }}>
            Over credit limit by {fmtKobo(statement.closing_balance_kobo - statement.line_of_credit_kobo!)}
          </span>
        </div>
      )}

      {/* Transactions */}
      <SectionCard>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>
            Transactions ({transactions.length})
          </div>
          {cards.length > 1 && (
            <select
              value={cardFilter}
              onChange={e => setCardFilter(e.target.value)}
              style={{ padding: '7px 12px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, background: '#fff' }}
            >
              <option value="">All cards</option>
              {cards.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>

        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: '#94A3B8', fontSize: 13 }}>No transactions</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['#', 'Txn Date', 'Posting', 'Trace No.', 'Card', 'Description', 'Debit', 'Credit'].map(h => (
                    <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr
                    key={t.id}
                    style={{ borderBottom: '1px solid #F1F5F9', background: t.is_finance_charge ? '#FFFBEB' : undefined }}
                  >
                    <td style={{ padding: '10px 12px', color: '#94A3B8', fontSize: 12 }}>{t.seq}</td>
                    <td style={{ padding: '10px 12px', fontFamily: 'DM Mono, monospace', fontSize: 12 }}>
                      {t.txn_date ? fmtDate(t.txn_date) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontFamily: 'DM Mono, monospace', fontSize: 12 }}>
                      {t.posting_date ? fmtDate(t.posting_date) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontFamily: 'DM Mono, monospace', fontSize: 12, color: '#64748B' }}>
                      {t.trace_no || '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontFamily: 'DM Mono, monospace', fontSize: 11, color: '#64748B' }}>
                      {t.card_pan || '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: t.is_finance_charge ? 600 : undefined, color: t.is_finance_charge ? AMBER : NAVY }}>
                      {t.description}
                      {t.is_finance_charge && (
                        <span style={{ marginLeft: 6, fontSize: 11, background: '#FEF3C7', color: AMBER, borderRadius: 4, padding: '1px 6px' }}>charge</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <KoboCell value={t.debit_kobo} color={RED} />
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <KoboCell value={t.credit_kobo} color={GREEN} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--th-bg)', fontWeight: 700 }}>
                  <td colSpan={6} style={{ padding: '10px 12px', fontSize: 12, color: '#475569' }}>Totals</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: RED }}>
                    {fmtKobo(filtered.reduce((s, t) => s + (t.debit_kobo ?? 0), 0))}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: GREEN }}>
                    {fmtKobo(filtered.reduce((s, t) => s + (t.credit_kobo ?? 0), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </SectionCard>
    </Page>
    </>
  )
}
