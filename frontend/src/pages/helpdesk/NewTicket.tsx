import { useState } from 'react'
import { Spinner, ErrBanner } from '../../components/UI'
import { apiPost } from '../../lib/api'
import { RED, NAVY } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

const TICKET_TYPES = [
  'Card Dispute', 'Loan Query', 'Account Freeze', 'Transfer Issue',
  'POS Complaint', 'App Issue', 'General Inquiry', 'Complaint', 'Other',
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

  if (type === 'Loan Query') {
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
        <Field label="Query Details">
          <textarea
            placeholder="Describe the loan query…"
            rows={3}
            value={custom.query_details ?? ''}
            onChange={e => set('query_details', e.target.value)}
            style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    )
  }

  if (type === 'Account Freeze') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Reason">
          <textarea
            placeholder="Reason for account freeze…"
            rows={3}
            value={custom.reason ?? ''}
            onChange={e => set('reason', e.target.value)}
            style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
          />
        </Field>
        <Field label="Authorised By">
          <input
            type="text" placeholder="Name of authorising officer"
            value={custom.authorised_by ?? ''}
            onChange={e => set('authorised_by', e.target.value)}
            style={inputStyle}
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
  const [assignedAgent, setAssignedAgent] = useState('')
  const [description, setDescription] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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
        ...(assignedAgent ? { assigned_agent: assignedAgent } : {}),
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
              <input type="text" placeholder="Agent name" value={assignedAgent}
                onChange={e => setAssignedAgent(e.target.value)} style={inputStyle} />
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
