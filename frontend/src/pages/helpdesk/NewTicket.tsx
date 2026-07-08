import { useState, useEffect } from 'react'
import { Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { RED, NAVY } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

const TICKET_TYPES = [
  'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Card Dispute',
  'Statement Request', 'Loan Complaint', 'FD Enquiry', 'Technical / App Issue',
  'Complaint (CBN reportable)',
] as const

type TicketType = typeof TICKET_TYPES[number]

// ── Field styles ──────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px',
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  outline: 'none', boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600,
  color: 'var(--txt2)', marginBottom: 5,
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle}>
        {label}
        {required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  )
}

// ── Dynamic fields by ticket type ─────────────────────────────────────────────

function DynamicFields({
  type, custom, setCustom,
}: {
  type: TicketType
  custom: Record<string, string>
  setCustom: (v: Record<string, string>) => void
}) {
  function set(key: string, val: string) {
    setCustom({ ...custom, [key]: val })
  }

  if (type === 'Card Dispute') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Card Number (last 4 digits)">
          <input
            type="text" maxLength={4} placeholder="e.g. 4242"
            value={custom.card_number ?? ''}
            onChange={e => set('card_number', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Transaction Date">
          <input
            type="date"
            value={custom.transaction_date ?? ''}
            onChange={e => set('transaction_date', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Disputed Amount (₦)">
          <input
            type="number" placeholder="e.g. 15000"
            value={custom.disputed_amount ?? ''}
            onChange={e => set('disputed_amount', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Dispute Type">
          <select
            value={custom.dispute_type ?? ''}
            onChange={e => set('dispute_type', e.target.value)}
            style={{ ...inputStyle, height: 38 }}
          >
            <option value="">— Select —</option>
            <option value="Chargeback">Chargeback</option>
            <option value="Unauthorised">Unauthorised</option>
            <option value="Double charge">Double charge</option>
          </select>
        </Field>
      </div>
    )
  }

  if (type === 'Balance Enquiry') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Account Number (optional)">
          <input
            type="text" placeholder="e.g. 0123456789"
            value={custom.account_number ?? ''}
            onChange={e => set('account_number', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Description">
          <textarea
            placeholder="Describe the balance enquiry…"
            rows={3}
            value={custom.description ?? ''}
            onChange={e => set('description', e.target.value)}
            style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    )
  }

  if (type === 'Payment Confirmation') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Transaction Reference">
          <input
            type="text" placeholder="e.g. TXN-000123"
            value={custom.transaction_ref ?? ''}
            onChange={e => set('transaction_ref', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Transaction Date">
          <input
            type="date"
            value={custom.transaction_date ?? ''}
            onChange={e => set('transaction_date', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Amount (₦)">
          <input
            type="number" placeholder="e.g. 50000"
            value={custom.amount ?? ''}
            onChange={e => set('amount', e.target.value)}
            style={inputStyle}
          />
        </Field>
      </div>
    )
  }

  if (type === 'Statement Request') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Statement Period From">
          <input
            type="date"
            value={custom.period_from ?? ''}
            onChange={e => set('period_from', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Statement Period To">
          <input
            type="date"
            value={custom.period_to ?? ''}
            onChange={e => set('period_to', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Delivery Email">
          <input
            type="email" placeholder="Email to send statement to"
            value={custom.delivery_email ?? ''}
            onChange={e => set('delivery_email', e.target.value)}
            style={inputStyle}
          />
        </Field>
      </div>
    )
  }

  if (type === 'Loan Complaint') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Loan Reference">
          <input
            type="text" placeholder="e.g. LN-001234"
            value={custom.loan_reference ?? ''}
            onChange={e => set('loan_reference', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Complaint Details">
          <textarea
            placeholder="Describe the loan complaint…"
            rows={3}
            value={custom.complaint_details ?? ''}
            onChange={e => set('complaint_details', e.target.value)}
            style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    )
  }

  if (type === 'FD Enquiry') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="FD Reference (optional)">
          <input
            type="text" placeholder="e.g. FD-000456"
            value={custom.fd_reference ?? ''}
            onChange={e => set('fd_reference', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Enquiry Details">
          <textarea
            placeholder="Describe the FD enquiry…"
            rows={3}
            value={custom.enquiry_details ?? ''}
            onChange={e => set('enquiry_details', e.target.value)}
            style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    )
  }

  if (type === 'Technical / App Issue') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Device / Platform">
          <select
            value={custom.platform ?? ''}
            onChange={e => set('platform', e.target.value)}
            style={{ ...inputStyle, height: 38 }}
          >
            <option value="">— Select —</option>
            <option value="iOS">iOS</option>
            <option value="Android">Android</option>
            <option value="Web">Web</option>
            <option value="USSD">USSD</option>
          </select>
        </Field>
        <Field label="Issue Description">
          <textarea
            placeholder="Describe the technical issue…"
            rows={3}
            value={custom.issue_description ?? ''}
            onChange={e => set('issue_description', e.target.value)}
            style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    )
  }

  if (type === 'Complaint (CBN reportable)') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Complaint Category">
          <select
            value={custom.complaint_category ?? ''}
            onChange={e => set('complaint_category', e.target.value)}
            style={{ ...inputStyle, height: 38 }}
          >
            <option value="">— Select —</option>
            <option value="Fraud / Unauthorized Transaction">Fraud / Unauthorized Transaction</option>
            <option value="Customer Service Failure">Customer Service Failure</option>
            <option value="Product / Service Defect">Product / Service Defect</option>
            <option value="Billing / Charges Dispute">Billing / Charges Dispute</option>
            <option value="Account Management">Account Management</option>
            <option value="Other">Other</option>
          </select>
        </Field>
        <Field label="Complaint Details">
          <textarea
            placeholder="Describe the complaint in detail…"
            rows={4}
            value={custom.complaint_details ?? ''}
            onChange={e => set('complaint_details', e.target.value)}
            style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    )
  }

  return (
    <Field label="Description">
      <textarea
        placeholder="Describe the issue…"
        rows={4}
        value={custom.description ?? ''}
        onChange={e => set('description', e.target.value)}
        style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
      />
    </Field>
  )
}

// ── Form component (used inside a Modal in Tickets.tsx) ───────────────────────

export default function NewTicketForm({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [ticketType, setTicketType] = useState<TicketType | null>(null)
  const [customFields, setCustomFields] = useState<Record<string, string>>({})

  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerCif, setCustomerCif] = useState('')

  const [subject, setSubject] = useState('')
  const [priority, setPriority] = useState('medium')
  const [agentId, setAgentId] = useState<number | null>(null)
  const [agents, setAgents] = useState<{ id: number; full_name: string }[]>([])
  const [description, setDescription] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ id: number; full_name: string }[]>('/api/helpdesk/agents')
      .then(r => setAgents(Array.isArray(r) ? r : []))
      .catch(() => setAgents([]))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ticketType) { setErr('Please select a ticket type.'); return }
    if (!subject.trim()) { setErr('Subject is required.'); return }
    if (!description.trim() && !customFields.description) { setErr('Description is required.'); return }

    setSubmitting(true)
    setErr(null)
    try {
      const body = {
        channel: 'portal',
        subject: subject.trim(),
        ticket_type: ticketType,
        priority,
        customer_name: customerName || undefined,
        customer_phone: customerPhone || undefined,
        customer_cif: customerCif || undefined,
        message_text: description.trim() || Object.entries(customFields)
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
          .join('\n'),
        custom_fields: customFields,
        ...(agentId != null ? { assigned_to: agentId } : {}),
      }
      const resp = await apiPost<{ ticket: { id: number } }>('/api/helpdesk/tickets', body)
      const newId = resp?.ticket?.id
      if (newId) {
        onCreated(newId)
      } else {
        onClose()
      }
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const sectionHead = (text: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12 }}>
      {text}
    </div>
  )

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <ErrBanner error={err} />

      {/* Ticket Type */}
      <div>
        {sectionHead('Ticket Type')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {TICKET_TYPES.map(t => {
            const isSelected = ticketType === t
            return (
              <button
                key={t}
                type="button"
                onClick={() => { setTicketType(t); setCustomFields({}) }}
                style={{
                  padding: '10px 8px', borderRadius: 9, cursor: 'pointer',
                  border: isSelected ? `2px solid ${RED}` : '2px solid var(--bdr)',
                  background: isSelected ? `${RED}08` : 'var(--th-bg)',
                  color: isSelected ? RED : 'var(--txt)',
                  fontSize: 12.5, fontWeight: isSelected ? 700 : 500,
                  transition: 'border 120ms, background 120ms', textAlign: 'center',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.borderColor = `${RED}60` }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.borderColor = 'var(--bdr)' }}
              >
                {t}
              </button>
            )
          })}
        </div>
      </div>

      {/* Customer */}
      <div>
        {sectionHead('Customer')}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Customer Name">
            <input type="text" placeholder="Full name" value={customerName}
              onChange={e => setCustomerName(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Phone Number">
            <input type="tel" placeholder="e.g. 08012345678" value={customerPhone}
              onChange={e => setCustomerPhone(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="CIF Number (optional)">
            <input type="text" placeholder="Customer CIF" value={customerCif}
              onChange={e => setCustomerCif(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </div>

      {/* Details */}
      <div>
        {sectionHead('Details')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Subject" required>
            <input type="text" placeholder="Brief summary of the issue" value={subject}
              onChange={e => setSubject(e.target.value)} required style={inputStyle} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Priority">
              <select value={priority} onChange={e => setPriority(e.target.value)}
                style={{ ...inputStyle, height: 38 }}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
            <Field label="Assign to Agent (optional)">
              <select
                value={agentId ?? ''}
                onChange={e => setAgentId(e.target.value ? Number(e.target.value) : null)}
                style={{ ...inputStyle, height: 38 }}
              >
                <option value="">— Unassigned —</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
              </select>
            </Field>
          </div>
        </div>
      </div>

      {/* Dynamic fields */}
      {ticketType && (
        <div>
          {sectionHead(`${ticketType} Details`)}
          <DynamicFields type={ticketType} custom={customFields} setCustom={setCustomFields} />
        </div>
      )}

      {/* Description */}
      <div>
        {sectionHead('Additional Description')}
        <textarea
          placeholder="Any additional context or details…"
          rows={4}
          value={description}
          onChange={e => setDescription(e.target.value)}
          style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
        />
      </div>

      {/* Footer buttons */}
      <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '9px 24px', borderRadius: 8, border: 'none',
            background: NAVY, color: '#fff', fontSize: 13.5, fontWeight: 700,
            cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1,
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {submitting && <Spinner size={15} color="#fff" />}
          Create Ticket
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: '9px 18px', borderRadius: 8,
            border: '1px solid var(--bdr)', background: 'var(--card)',
            color: 'var(--txt)', fontSize: 13.5, fontWeight: 500, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
