import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, SectionCard, Button, Select } from '../../components/UI'
import { apiFetch, API } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, MONO, TEXT, FW, SP, RADIUS } from '../../lib/design'

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
  if (!value) return <span style={{ color: 'var(--txt3)' }}>—</span>
  return <span style={{ fontFamily: MONO, color }}>{fmtKobo(value)}</span>
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

  const [step, setStep]       = useState<'compose' | 'sent'>('compose')
  const [email, setEmail]     = useState('')
  const [cc, setCC]           = useState('')
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody]       = useState(buildDefaultBody)
  const [bodyOpen, setBodyOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo]   = useState('')
  const [sentAt, setSentAt]   = useState('')
  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => { emailRef.current?.focus() }, [])

  const send = async () => {
    const trimEmail = email.trim()
    if (!trimEmail.includes('@')) { toast.error('Enter a valid recipient email'); return }
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
    width: '100%', padding: `${SP[2]} ${SP[3]}`,
    border: '1.5px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, outline: 'none', boxSizing: 'border-box',
    fontFamily: 'var(--font-sans)', color: 'var(--txt)',
    background: 'var(--input-bg)',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold,
    color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5,
  }

  // ── Sent confirmation ──
  if (step === 'sent') {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ background: 'var(--card)', borderRadius: RADIUS.lg, width: '100%', maxWidth: 480, boxShadow: '0 20px 60px rgba(0,0,0,.3)', overflow: 'hidden' }}>
          {/* Success header */}
          <div style={{ background: '#14532D', padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="material-symbols-rounded" style={{ color: '#86efac', fontSize: 22 }}>mark_email_read</span>
              <span style={{ color: '#fff', fontWeight: FW.bold, fontSize: TEXT.md }}>Statement Delivered</span>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.5)', cursor: 'pointer', padding: 4 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
            </button>
          </div>

          <div style={{ padding: '24px' }}>
            {/* Delivery receipt */}
            <div style={{ background: 'var(--bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden', marginBottom: 20 }}>
              {[
                { label: 'To', value: sentTo },
                ...(cc ? [{ label: 'CC', value: cc }] : []),
                { label: 'Subject', value: subject || defaultSubject },
                { label: 'Attachment', value: pdfFilename },
                { label: 'Sent', value: sentAt },
              ].map((row, i, arr) => (
                <div key={row.label} style={{ display: 'flex', gap: 12, padding: '10px 14px', borderBottom: i < arr.length - 1 ? '1px solid var(--bdr)' : undefined }}>
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em', width: 72, flexShrink: 0, paddingTop: 1 }}>{row.label}</span>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: row.label === 'Attachment' ? 'var(--font-mono)' : undefined }}>{row.value}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => { setStep('compose'); setEmail(''); setCC('') }}>
                Send to another
              </Button>
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Compose ──
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: RADIUS.lg, width: '100%', maxWidth: 580, maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)', overflow: 'hidden' }}>

        {/* Navy header — statement summary */}
        <div style={{ background: NAVY, padding: '18px 22px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="material-symbols-rounded" style={{ color: '#fff', fontSize: 18 }}>attach_email</span>
              <span style={{ color: '#fff', fontWeight: FW.bold, fontSize: TEXT.md }}>Send Statement by Email</span>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.5)', cursor: 'pointer', padding: 2, lineHeight: 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
            </button>
          </div>
          {/* Statement quick-facts strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: 'rgba(255,255,255,.1)', borderRadius: RADIUS.sm, overflow: 'hidden' }}>
            {[
              { label: 'Customer', value: statement.customer_name },
              { label: 'Account', value: `****${last4}` },
              { label: 'Closing Balance', value: fmtKobo(statement.closing_balance_kobo) },
            ].map(f => (
              <div key={f.label} style={{ padding: '8px 12px', background: 'rgba(0,0,0,.2)' }}>
                <div style={{ fontSize: 9, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,.45)', marginBottom: 3 }}>{f.label}</div>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: '#fff', fontFamily: f.label === 'Account' || f.label === 'Closing Balance' ? 'var(--font-mono)' : undefined }}>{f.value}</div>
              </div>
            ))}
          </div>
          {statement.payment_due_date && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'rgba(255,200,150,.9)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>schedule</span>
              Payment due {fmtDate(statement.payment_due_date)}
              {statement.min_payment_kobo ? ` · Min ${fmtKobo(statement.min_payment_kobo)}` : ''}
            </div>
          )}
        </div>

        {/* Form */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* To / CC row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
            <div>
              <label style={labelStyle}>To *</label>
              <input ref={emailRef} type="email" value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !cc) send() }}
                placeholder="customer@example.com"
                style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>CC <span style={{ fontWeight: FW.normal, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
              <input type="email" value={cc}
                onChange={e => setCC(e.target.value)}
                placeholder="e.g. manager@o3capital.com"
                style={inputStyle} />
            </div>
          </div>

          {/* Subject */}
          <div>
            <label style={labelStyle}>Subject</label>
            <input type="text" value={subject}
              onChange={e => setSubject(e.target.value)}
              style={inputStyle} />
          </div>

          {/* PDF attachment badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '10px 14px' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 22, color: RED, flexShrink: 0 }}>picture_as_pdf</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pdfFilename}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>PDF statement — auto-generated and attached</div>
            </div>
            <span className="material-symbols-rounded" style={{ fontSize: 16, color: GREEN, flexShrink: 0 }}>check_circle</span>
          </div>

          {/* Collapsible email body */}
          <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
            <button
              onClick={() => setBodyOpen(o => !o)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--bg)', border: 'none', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>edit_note</span>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>
                  {bodyOpen ? 'Edit message body' : 'Customise message body'}
                </span>
              </div>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)', transform: bodyOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}>
                expand_more
              </span>
            </button>
            {bodyOpen && (
              <div style={{ padding: '0 14px 14px', background: 'var(--card)' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                  <button onClick={() => setBody(buildDefaultBody())}
                    style={{ fontSize: TEXT.xs, color: 'var(--txt3)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}>
                    Reset to default
                  </button>
                </div>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  rows={9}
                  style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.65', fontFamily: 'var(--font-mono)', fontSize: TEXT.sm }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center', background: 'var(--bg)', flexShrink: 0 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', flex: 1 }}>
            Statement for <strong style={{ color: 'var(--txt2)' }}>{statement.customer_name}</strong> · {monthYear}
          </span>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button icon={sending ? 'hourglass_top' : 'send'} onClick={send} loading={sending}>
            {sending ? 'Sending…' : 'Send Statement'}
          </Button>
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
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--txt3)' }}>Loading statement…</div>
    </Page>
  )

  if (!statement) return (
    <Page title="Not Found">
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--txt3)' }}>Statement not found.</div>
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

  // Running balance per filtered row (mirrors PDF logic)
  const balances: number[] = []
  let runBal = statement.opening_balance_kobo ?? 0
  for (const t of filtered) {
    runBal += (t.debit_kobo ?? 0) - (t.credit_kobo ?? 0)
    balances.push(runBal)
  }

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
          <Button variant="secondary" icon="arrow_back" onClick={() => navigate('/statements/credit-cards')}>
            All Statements
          </Button>
          <Button variant="secondary" icon="open_in_new" onClick={openPreview}>
            Preview
          </Button>
          <Button icon="send" onClick={() => setShowSend(true)}>
            Send by Email
          </Button>
        </div>
      }
    >
      {/* Customer header */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: `${SP[4]} ${SP[5]}`, marginBottom: SP[5], display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Customer</div>
          <div style={{ fontSize: 15, fontWeight: FW.semibold, color: NAVY, marginTop: 2 }}>{statement.customer_name}</div>
          {statement.customer_address && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{statement.customer_address}</div>}
        </div>
        <div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Account</div>
          <div style={{ fontSize: 15, fontWeight: FW.semibold, color: NAVY, marginTop: 2, fontFamily: MONO }}>{statement.account_number}</div>
        </div>
        {statement.payment_due_date && (
          <div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Payment Due</div>
            <div style={{ fontSize: 15, fontWeight: FW.semibold, color: RED, marginTop: 2 }}>{fmtDate(statement.payment_due_date)}</div>
          </div>
        )}
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Source</div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt2)', marginTop: 2, textTransform: 'capitalize' }}>
            {statement.source === 'db' ? 'Database Query' : `File Upload${statement.source_filename ? `: ${statement.source_filename}` : ''}`}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>Added {fmtDate(statement.created_at)}{statement.created_by_name ? ` by ${statement.created_by_name}` : ''}</div>
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
            background: tile.navy ? NAVY : 'var(--card)',
            borderRight: i < arr.length - 1 ? `1px solid ${NAVY}` : undefined,
          }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: tile.navy ? 'rgba(255,255,255,.6)' : 'var(--txt3)', marginBottom: 5 }}>{tile.label}</div>
            <div style={{ fontSize: 15, fontWeight: FW.bold, fontFamily: MONO, color: tile.navy ? '#fff' : tile.red ? RED : tile.green ? GREEN : NAVY, fontVariantNumeric: 'tabular-nums' }}>{tile.value}</div>
          </div>
        ))}
      </div>

      {overLimit && (
        <div style={{ background: 'rgba(192,0,0,.06)', borderLeft: `4px solid ${RED}`, padding: `${SP[2]} ${SP[4]}`, marginBottom: SP[4], fontSize: TEXT.base, color: RED, fontWeight: FW.semibold }}>
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
            <Select value={cardFilter} onChange={e => setCardFilter(e.target.value)}>
              <option value="">All cards</option>
              {cards.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
          )}
        </div>

        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: SP[8], color: 'var(--txt3)', fontSize: TEXT.base }}>No transactions</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
              <thead>
                <tr style={{ background: NAVY }}>
                  {[
                    { label: 'Date',        right: false, color: '#fff' },
                    { label: 'Reference',   right: false, color: '#fff' },
                    { label: 'Description', right: false, color: '#fff' },
                    { label: 'Category',    right: false, color: '#fff' },
                    { label: 'Debit',       right: true,  color: '#ffb3b3' },
                    { label: 'Credit',      right: true,  color: '#86efac' },
                    { label: 'Balance',     right: true,  color: 'rgba(255,255,255,.7)' },
                  ].map(col => (
                    <th key={col.label} style={{ padding: '10px 12px', textAlign: col.right ? 'right' : 'left', fontSize: TEXT.xs, fontWeight: FW.bold, color: col.color, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, i) => (
                  <tr
                    key={t.id}
                    style={{ borderBottom: '1px solid var(--bdr)', background: t.is_finance_charge ? 'rgba(217,119,6,.06)' : i % 2 === 1 ? 'var(--row-hvr)' : undefined }}
                  >
                    <td style={{ padding: '9px 12px', color: 'var(--txt3)', fontSize: TEXT.sm, whiteSpace: 'nowrap' }}>
                      {t.txn_date ? fmtDate(t.txn_date) : '—'}
                      {t.posting_date && t.posting_date !== t.txn_date && (
                        <div style={{ fontSize: 10, color: 'var(--txt3)' }}>{fmtDate(t.posting_date)}</div>
                      )}
                    </td>
                    <td style={{ padding: '9px 12px', fontFamily: MONO, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                      {t.trace_no || '—'}
                    </td>
                    <td style={{ padding: '9px 12px', color: t.is_finance_charge ? AMBER : 'var(--txt)', maxWidth: 200 }}>
                      {t.description}
                      {t.is_finance_charge && (
                        <span style={{ marginLeft: 6, fontSize: TEXT.xs, background: '#FEF3C7', color: AMBER, borderRadius: RADIUS.xs, padding: '1px 6px' }}>charge</span>
                      )}
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                      {inferCategory(t.description, t.trace_no, t.is_finance_charge)}
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' }}>
                      <KoboCell value={t.debit_kobo} color={t.is_finance_charge ? AMBER : RED} />
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' }}>
                      <KoboCell value={t.credit_kobo} color={GREEN} />
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                      {fmtKobo(balances[i])}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: NAVY }}>
                  <td colSpan={4} style={{ padding: '10px 12px', fontSize: TEXT.sm, color: '#fff', fontWeight: FW.bold }}>Period Totals</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: '#ffb3b3', fontWeight: FW.bold }}>
                    {fmtKobo(filtered.reduce((s, t) => s + (t.debit_kobo ?? 0), 0))}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: '#86efac', fontWeight: FW.bold }}>
                    {fmtKobo(filtered.reduce((s, t) => s + (t.credit_kobo ?? 0), 0))}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: '#fff', fontWeight: FW.bold }}>
                    {fmtKobo(statement.closing_balance_kobo)}
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
