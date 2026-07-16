import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, SectionCard } from '../../components/UI'
import { apiFetch, API } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, TEXT, FW, SP, RADIUS } from '../../lib/design'

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

function isCashAdvance(desc: string, traceNo = ''): boolean {
  const d = desc.toLowerCase()
  const t = traceNo.toLowerCase()
  return d.includes('atm') || d.includes('cash advance') || d.includes('withdrawal') || t.startsWith('atm')
}

function inferCategory(desc: string, traceNo = '', isFC = false): string {
  if (isFC) return 'Finance'
  const d = desc.toLowerCase()
  const t = traceNo.toLowerCase()
  if (d.includes('payment') || t.startsWith('pmt')) return 'Payment'
  if (isCashAdvance(d, t)) return 'Cash Advance'
  if (d.includes('fuel') || d.includes('petrol') || d.includes('nnpc') || d.includes('filling')) return 'Fuel'
  if (d.includes('uber') || d.includes('bolt') || d.includes('transport') || d.includes('taxi')) return 'Transport'
  if (d.includes('netflix') || d.includes('spotify') || d.includes('dstv') || d.includes('subscription')) return 'Subscriptions'
  if (d.includes('pizza') || d.includes('chicken') || d.includes('burger') || d.includes('cafe') || d.includes('restaurant') || d.includes('food')) return 'Food & Dining'
  if (d.includes('jumia') || d.includes('konga') || d.includes('amazon') || d.includes('shopping')) return 'E-Commerce'
  if (d.includes('transfer')) return 'Transfer'
  if (d.includes('airtime') || d.includes('data')) return 'Airtime/Data'
  return 'Retail'
}

function KoboCell({ value, color }: { value: number; color?: string }) {
  if (!value) return <span style={{ color: '#CBD5E1' }}>—</span>
  return <span style={{ fontFamily: 'DM Mono, monospace', color }}>{fmtKobo(value)}</span>
}

// ── Send-by-email modal ───────────────────────────────────────────────────────
function SendModal({ statement, onClose }: {
  statement: Statement
  onClose: () => void
}) {
  const last4 = statement.account_number.slice(-4)
  const stmtD = new Date(statement.statement_date)
  const monthYear = stmtD.toLocaleString('en-NG', { month: 'long', year: 'numeric' })
  const pdfFilename = `O3C_CC_${last4}_${stmtD.getFullYear()}${String(stmtD.getMonth() + 1).padStart(2, '0')}.pdf`

  const buildDefaultBody = () => {
    const maskedAcct = `****${last4}`
    const stmtDate = fmtDate(statement.statement_date)
    let body = `Dear ${statement.customer_name},\n\n`
    body += `Your O3 Capital credit card statement for account ${maskedAcct} for the period ending ${stmtDate} is now available.\n\n`
    body += `Please find attached your credit card e-statement. Open the attachment to view, save and print.\n\n`
    body += `ACCOUNT SUMMARY\n`
    body += `Account Number:      ${maskedAcct}\n`
    body += `New Balance:         ${fmtKobo(statement.closing_balance_kobo)}\n`
    if (statement.min_payment_kobo) body += `Minimum Payment Due: ${fmtKobo(statement.min_payment_kobo)}\n`
    if (statement.payment_due_date) body += `Payment Due Date:    ${fmtDate(statement.payment_due_date)}\n`
    body += `\nPlease ensure payment is made on or before the due date to avoid charges.\n\n`
    body += `For enquiries, contact O3 Capital Cards:\nEmail: care@o3cards.com\n\n`
    body += `Thank you for choosing O3 Capital.\n\nRegards,\nO3 Capital Cards Team`
    return body
  }

  const defaultSubject = `O3 Capital Credit Card E-Statement (****${last4}) - ${monthYear}`

  const [step, setStep]         = useState<'compose' | 'sent'>('compose')
  const [activeTab, setActiveTab] = useState<'compose' | 'preview'>('compose')
  const [email, setEmail]       = useState('')
  const [cc, setCC]             = useState('')
  const [subject, setSubject]   = useState(defaultSubject)
  const [body, setBody]         = useState(buildDefaultBody)
  const [sending, setSending]   = useState(false)
  const [sentTo, setSentTo]     = useState('')
  const [sentAt, setSentAt]     = useState('')
  const [sentSubject, setSentSubject] = useState('')
  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => { emailRef.current?.focus() }, [])

  const send = async () => {
    const trimEmail = email.trim()
    if (!trimEmail.includes('@')) { toast.error('Enter a valid recipient email address'); return }
    setSending(true)
    try {
      await apiFetch<any>(`/api/cc-statements/${statement.id}/send`, {
        method: 'POST',
        body: JSON.stringify({
          recipient_email: trimEmail,
          cc:         cc.trim() || undefined,
          subject:    subject.trim() || defaultSubject,
          email_body: body.trim() || undefined,
        }),
      })
      setSentTo(trimEmail)
      setSentSubject(subject.trim() || defaultSubject)
      setSentAt(new Date().toLocaleString('en-NG', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }))
      setStep('sent')
    } catch (e: any) {
      toast.error(e.message || 'Failed to send email')
    } finally {
      setSending(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 11px',
    border: '1px solid #E2E8F0', borderRadius: RADIUS.sm,
    fontSize: TEXT.base, outline: 'none', boxSizing: 'border-box',
    fontFamily: 'inherit', color: '#1e293b',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: TEXT.sm,
    fontWeight: FW.semibold, color: '#475569', marginBottom: 4,
  }

  if (step === 'sent') {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ background: '#fff', borderRadius: RADIUS.lg, width: '100%', maxWidth: 520, boxShadow: '0 12px 40px rgba(0,0,0,.25)', overflow: 'hidden' }}>
          <div style={{ background: NAVY, padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="material-symbols-rounded" style={{ color: '#fff', fontSize: 20 }}>check_circle</span>
              <span style={{ color: '#fff', fontWeight: FW.bold, fontSize: TEXT.md }}>Email Sent Successfully</span>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', cursor: 'pointer', padding: 4 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
            </button>
          </div>
          <div style={{ padding: '28px 24px' }}>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: '#15803D', display: 'block', marginBottom: 8 }}>mark_email_read</span>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: NAVY }}>Statement with PDF delivered</div>
              <div style={{ fontSize: TEXT.sm, color: '#64748B', marginTop: 4 }}>The customer will receive the PDF statement as an attachment</div>
            </div>
            <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: RADIUS.md, padding: '14px 18px', marginBottom: 20, fontSize: TEXT.sm, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: '#94A3B8', width: 80, flexShrink: 0 }}>To</span>
                <span style={{ fontWeight: FW.semibold, color: NAVY }}>{sentTo}</span>
              </div>
              {cc && <div style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: '#94A3B8', width: 80, flexShrink: 0 }}>CC</span>
                <span style={{ color: '#475569' }}>{cc}</span>
              </div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: '#94A3B8', width: 80, flexShrink: 0 }}>Subject</span>
                <span style={{ color: '#475569' }}>{sentSubject}</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: '#94A3B8', width: 80, flexShrink: 0 }}>Attachment</span>
                <span style={{ color: '#475569', fontFamily: 'DM Mono, monospace', fontSize: TEXT.xs }}>{pdfFilename}</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: '#94A3B8', width: 80, flexShrink: 0 }}>Sent at</span>
                <span style={{ color: '#475569' }}>{sentAt}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setStep('compose'); setEmail(''); setCC('') }}
                style={{ padding: '9px 18px', border: '1px solid #E2E8F0', borderRadius: RADIUS.sm, background: '#fff', fontSize: TEXT.base, cursor: 'pointer', color: '#475569' }}>
                Send to another
              </button>
              <button onClick={onClose}
                style={{ padding: '9px 22px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.sm, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: RADIUS.lg, width: '100%', maxWidth: 640, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,.25)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ background: NAVY, padding: '15px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="material-symbols-rounded" style={{ color: '#fff', fontSize: 19 }}>attach_email</span>
            <span style={{ color: '#fff', fontWeight: FW.bold, fontSize: TEXT.md }}>Send Statement by Email</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', cursor: 'pointer', padding: 4 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #E2E8F0', background: '#F8FAFC', flexShrink: 0 }}>
          {(['compose', 'preview'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{
                padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
                fontSize: TEXT.sm, fontWeight: activeTab === tab ? FW.bold : FW.normal,
                color: activeTab === tab ? NAVY : '#64748B',
                borderBottom: activeTab === tab ? `2px solid ${NAVY}` : '2px solid transparent',
                marginBottom: -1,
              }}>
              {tab === 'compose' ? 'Compose' : 'Preview Email'}
            </button>
          ))}
          {/* PDF badge always visible */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingRight: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#EEF2F7', border: '1px solid #CBD5E1', borderRadius: RADIUS.xs, padding: '3px 10px' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13, color: '#C00000' }}>picture_as_pdf</span>
              <span style={{ fontSize: 11, color: '#475569', fontFamily: 'DM Mono, monospace' }}>{pdfFilename}</span>
            </div>
          </div>
        </div>

        {/* Scrollable content area */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {activeTab === 'compose' ? (
            <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 13 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
                <div>
                  <label style={labelStyle}>To (Recipient Email) *</label>
                  <input ref={emailRef} type="email" value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') send() }}
                    placeholder="customer@example.com" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>CC <span style={{ fontWeight: FW.normal, color: '#94A3B8' }}>(optional)</span></label>
                  <input type="email" value={cc}
                    onChange={e => setCC(e.target.value)}
                    placeholder="manager@o3capital.com" style={inputStyle} />
                </div>
              </div>

              <div>
                <label style={labelStyle}>Subject</label>
                <input type="text" value={subject}
                  onChange={e => setSubject(e.target.value)}
                  style={inputStyle} />
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Email Body</label>
                  <button onClick={() => setBody(buildDefaultBody())}
                    style={{ fontSize: 11, color: '#64748B', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}>
                    Reset to default
                  </button>
                </div>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  rows={10}
                  style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.6', fontFamily: 'DM Mono, monospace', fontSize: TEXT.sm }}
                />
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 3 }}>
                  This text will be sent as the email body. The PDF statement is always attached automatically.
                </div>
              </div>

              <div style={{ background: '#F0FFF4', border: '1px solid #BBF7D0', borderRadius: RADIUS.sm, padding: '10px 14px', fontSize: TEXT.xs, color: '#15803D', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, flexShrink: 0 }}>picture_as_pdf</span>
                <span><strong>{pdfFilename}</strong> will be generated and attached automatically — the customer receives the full statement as a PDF.</span>
              </div>
            </div>
          ) : (
            /* ── Preview tab ── */
            <div style={{ padding: '18px 22px' }}>
              <div style={{ background: '#F1F5F9', borderRadius: RADIUS.md, padding: '14px 16px', marginBottom: 14, fontSize: TEXT.sm, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: '#64748B', width: 56, flexShrink: 0, fontSize: TEXT.xs, paddingTop: 2 }}>FROM</span>
                  <span style={{ color: '#1e293b' }}>O3 Capital Cards &lt;noreply@o3cards.com&gt;</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: '#64748B', width: 56, flexShrink: 0, fontSize: TEXT.xs, paddingTop: 2 }}>TO</span>
                  <span style={{ color: email ? '#1e293b' : '#94A3B8' }}>{email || 'recipient@example.com'}</span>
                </div>
                {cc && <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: '#64748B', width: 56, flexShrink: 0, fontSize: TEXT.xs, paddingTop: 2 }}>CC</span>
                  <span style={{ color: '#1e293b' }}>{cc}</span>
                </div>}
                <div style={{ display: 'flex', gap: 8, borderTop: '1px solid #E2E8F0', paddingTop: 6, marginTop: 2 }}>
                  <span style={{ color: '#64748B', width: 56, flexShrink: 0, fontSize: TEXT.xs, paddingTop: 2 }}>SUBJECT</span>
                  <span style={{ color: '#1e293b', fontWeight: FW.semibold }}>{subject || defaultSubject}</span>
                </div>
              </div>

              {/* Email body preview */}
              <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: RADIUS.md, overflow: 'hidden' }}>
                {/* Mock header */}
                <div style={{ background: '#0E2841', padding: '14px 20px' }}>
                  <div>
                    <span style={{ color: '#E02828', fontSize: 18, fontWeight: 900 }}>O3</span>
                    <span style={{ color: '#fff', fontSize: 18, fontWeight: 700, marginLeft: 5 }}>Capital</span>
                  </div>
                  <div style={{ color: 'rgba(255,255,255,.4)', fontSize: 9, letterSpacing: '1.5px', textTransform: 'uppercase', marginTop: 3 }}>
                    Cards Division · Licensed by CBN
                  </div>
                </div>
                <div style={{ height: 2, background: '#C00000' }} />

                {/* Body text */}
                <div style={{ padding: '20px 22px' }}>
                  <pre style={{ fontFamily: 'inherit', fontSize: TEXT.sm, color: '#374151', lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                    {body || buildDefaultBody()}
                  </pre>
                </div>

                {/* Attachment badge */}
                <div style={{ borderTop: '1px solid #E2E8F0', background: '#EEF2F7', padding: '10px 22px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #CBD5E1', borderRadius: RADIUS.xs, padding: '6px 12px' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15, color: '#C00000' }}>picture_as_pdf</span>
                    <span style={{ fontSize: 12, color: '#475569', fontFamily: 'DM Mono, monospace' }}>{pdfFilename}</span>
                  </div>
                  <span style={{ fontSize: 11, color: '#94A3B8' }}>PDF attachment</span>
                </div>

                {/* Mock footer */}
                <div style={{ background: '#0E2841', padding: '10px 20px', textAlign: 'center', fontSize: 9, color: 'rgba(255,255,255,.4)', letterSpacing: '1px', textTransform: 'uppercase' }}>
                  O3 Capital Limited · Cards Division · CBN Licensed · care@o3cards.com
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div style={{ padding: '13px 22px', borderTop: '1px solid #E2E8F0', display: 'flex', gap: 10, justifyContent: 'flex-end', background: '#FAFAFA', flexShrink: 0 }}>
          <button onClick={onClose}
            style={{ padding: '9px 18px', border: '1px solid #E2E8F0', borderRadius: RADIUS.sm, background: '#fff', fontSize: TEXT.base, cursor: 'pointer', color: '#64748B' }}>
            Cancel
          </button>
          <button onClick={send} disabled={sending}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 22px', background: sending ? '#94A3B8' : NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.sm, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: sending ? 'default' : 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{sending ? 'hourglass_top' : 'send'}</span>
            {sending ? 'Sending…' : 'Send with PDF'}
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
      .catch((e: any) => toast.error(e.message || 'Failed to load statement'))
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

  // Compute purchases / cash advances from transaction rows (mirrors Go logic)
  const purchases = transactions.reduce((s, t) => {
    if (t.debit_kobo > 0 && !t.is_finance_charge && !isCashAdvance(t.description, t.trace_no)) return s + t.debit_kobo
    return s
  }, 0)
  const cashAdv = transactions.reduce((s, t) => {
    if (t.debit_kobo > 0 && !t.is_finance_charge && isCashAdvance(t.description, t.trace_no)) return s + t.debit_kobo
    return s
  }, 0)
  const totalPayments = transactions.reduce((s, t) => s + (t.credit_kobo ?? 0), 0)

  return (
    <>
    {showSend && statement && (
      <SendModal
        statement={statement}
        onClose={() => setShowSend(false)}
      />
    )}
    <Page
      title={statement.customer_name}
      subtitle={`Account ${statement.account_number} · Statement ${fmtDate(statement.statement_date)}`}
      actions={
        <div style={{ display: 'flex', gap: SP[2] }}>
          <button
            onClick={() => navigate('/statements/credit-cards')}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[4]}`, border: '1px solid #E2E8F0', borderRadius: RADIUS.sm, background: '#fff', fontSize: TEXT.base, cursor: 'pointer', color: '#64748B' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>arrow_back</span>
            All Statements
          </button>
          <button
            onClick={openPreview}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[4]}`, border: '1px solid #E2E8F0', borderRadius: RADIUS.sm, background: '#fff', fontSize: TEXT.base, cursor: 'pointer', color: NAVY }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>open_in_new</span>
            Preview
          </button>
          <button
            onClick={() => setShowSend(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[4]}`, background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.sm, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>send</span>
            Send by Email
          </button>
        </div>
      }
    >
      {/* Customer header */}
      <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: RADIUS.md, padding: `${SP[4]} ${SP[5]}`, marginBottom: SP[5], display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: TEXT.xs, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Customer</div>
          <div style={{ fontSize: 15, fontWeight: FW.semibold, color: NAVY, marginTop: 2 }}>{statement.customer_name}</div>
          {statement.customer_address && <div style={{ fontSize: TEXT.sm, color: '#64748B', marginTop: 2 }}>{statement.customer_address}</div>}
        </div>
        <div>
          <div style={{ fontSize: TEXT.xs, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Account</div>
          <div style={{ fontSize: 15, fontWeight: FW.semibold, color: NAVY, marginTop: 2, fontFamily: 'DM Mono, monospace' }}>{statement.account_number}</div>
        </div>
        {statement.payment_due_date && (
          <div>
            <div style={{ fontSize: TEXT.xs, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Payment Due</div>
            <div style={{ fontSize: 15, fontWeight: FW.semibold, color: RED, marginTop: 2 }}>{fmtDate(statement.payment_due_date)}</div>
          </div>
        )}
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: TEXT.xs, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Source</div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: '#475569', marginTop: 2, textTransform: 'capitalize' }}>
            {statement.source === 'db' ? 'Database Query' : `File Upload${statement.source_filename ? `: ${statement.source_filename}` : ''}`}
          </div>
          <div style={{ fontSize: TEXT.xs, color: '#94A3B8', marginTop: 2 }}>Added {fmtDate(statement.created_at)}{statement.created_by_name ? ` by ${statement.created_by_name}` : ''}</div>
        </div>
      </div>

      {/* 5-tile summary strip — mirrors PDF design */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', border: `1.5px solid ${NAVY}`, borderRadius: RADIUS.md, overflow: 'hidden', marginBottom: SP[5] }}>
        {[
          { label: 'Opening Balance', value: fmtKobo(statement.opening_balance_kobo), navy: false },
          { label: 'Purchases',       value: fmtKobo(purchases),                      navy: false, red: true },
          { label: 'Cash Advances',   value: fmtKobo(cashAdv),                        navy: false, red: true },
          { label: 'Payments',        value: fmtKobo(totalPayments),                  navy: false, green: true },
          { label: 'Closing Balance', value: fmtKobo(statement.closing_balance_kobo), navy: true },
        ].map((tile, i, arr) => (
          <div key={tile.label} style={{
            padding: '14px 16px',
            background: tile.navy ? NAVY : '#fff',
            borderRight: i < arr.length - 1 ? `1px solid ${NAVY}` : undefined,
          }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: tile.navy ? 'rgba(255,255,255,.6)' : '#999', marginBottom: 5 }}>{tile.label}</div>
            <div style={{ fontSize: 15, fontWeight: FW.bold, fontFamily: 'DM Mono, monospace', color: tile.navy ? '#fff' : tile.red ? RED : tile.green ? GREEN : NAVY, fontVariantNumeric: 'tabular-nums' }}>{tile.value}</div>
          </div>
        ))}
      </div>

      {overLimit && (
        <div style={{ background: '#FEF2F2', borderLeft: `4px solid ${RED}`, padding: `${SP[2]} ${SP[4]}`, marginBottom: SP[4], fontSize: TEXT.base, color: '#991B1B', fontWeight: FW.semibold }}>
          ⚠ Over credit limit by {fmtKobo(statement.closing_balance_kobo - statement.line_of_credit_kobo!)}
        </div>
      )}

      {/* Transactions */}
      <SectionCard>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: NAVY }}>
            Transaction Detail ({transactions.length})
          </div>
          {cards.length > 1 && (
            <select
              value={cardFilter}
              onChange={e => setCardFilter(e.target.value)}
              style={{ padding: `7px ${SP[3]}`, border: '1px solid #E2E8F0', borderRadius: RADIUS.sm, fontSize: TEXT.base, background: '#fff' }}
            >
              <option value="">All cards</option>
              {cards.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>

        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: SP[8], color: '#94A3B8', fontSize: TEXT.base }}>No transactions</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
              <thead>
                <tr style={{ background: NAVY }}>
                  {['Date', 'Reference', 'Description', 'Category', 'Charge', 'Payment'].map((h, i) => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: i >= 4 ? 'right' : 'left', fontSize: TEXT.xs, fontWeight: FW.bold, color: i === 4 ? '#ffb3b3' : i === 5 ? '#86efac' : '#fff', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, i) => (
                  <tr
                    key={t.id}
                    style={{ borderBottom: '1px solid #F1F5F9', background: t.is_finance_charge ? '#FFFBEB' : i % 2 === 1 ? '#FAFBFC' : '#fff' }}
                  >
                    <td style={{ padding: '9px 12px', color: '#888', fontSize: TEXT.sm, whiteSpace: 'nowrap' }}>
                      {t.txn_date ? fmtDate(t.txn_date) : '—'}
                      {t.posting_date && t.posting_date !== t.txn_date && (
                        <div style={{ fontSize: 10, color: '#aaa' }}>{fmtDate(t.posting_date)}</div>
                      )}
                    </td>
                    <td style={{ padding: '9px 12px', fontFamily: 'DM Mono, monospace', fontSize: TEXT.sm, color: '#64748B' }}>
                      {t.trace_no || '—'}
                    </td>
                    <td style={{ padding: '9px 12px', color: t.is_finance_charge ? AMBER : NAVY, maxWidth: 200 }}>
                      {t.description}
                      {t.is_finance_charge && (
                        <span style={{ marginLeft: 6, fontSize: TEXT.xs, background: '#FEF3C7', color: AMBER, borderRadius: RADIUS.xs, padding: '1px 6px' }}>charge</span>
                      )}
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: TEXT.xs, color: '#777' }}>
                      {inferCategory(t.description, t.trace_no, t.is_finance_charge)}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' }}>
                      <KoboCell value={t.debit_kobo} color={t.is_finance_charge ? AMBER : RED} />
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' }}>
                      <KoboCell value={t.credit_kobo} color={GREEN} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: NAVY }}>
                  <td colSpan={4} style={{ padding: '10px 12px', fontSize: TEXT.sm, color: '#fff', fontWeight: FW.bold }}>Period Totals</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: '#ffb3b3', fontWeight: FW.bold }}>
                    {fmtKobo(filtered.reduce((s, t) => s + (t.debit_kobo ?? 0), 0))}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: '#86efac', fontWeight: FW.bold }}>
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
