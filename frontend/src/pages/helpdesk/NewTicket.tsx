import { useState, useEffect, useRef } from 'react'
import { Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { RED, NAVY, GREEN, FW, RADIUS, SP, TEXT } from '../../lib/design'

export interface InitialCustomer { cif?: string; name?: string; phone?: string }

interface CustSuggest { cif: string; name: string; phone?: string; email?: string; state?: string }

// Some source names carry a stray leading title/punctuation (e.g. ". Sunday Essien").
function cleanName(n?: string) {
  return (n ?? '').replace(/^[.\s]+/, '').trim()
}

function initialsOf(name: string) {
  return (cleanName(name) || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ── Customer typeahead ────────────────────────────────────────────────────────
// Searches by name / CIF / phone and returns a full record, so picking one
// suggestion auto-fills name, CIF and phone together.
function CustomerSearch({ onPick, onManual }: { onPick: (c: CustSuggest) => void; onManual: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CustSuggest[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setResults([]); setOpen(false); setLoading(false); return }
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      apiFetch<any>(`/api/customer360/search?q=${encodeURIComponent(term)}&limit=8`)
        .then(r => {
          if (!alive) return
          const list = (r?.data ?? r) as CustSuggest[]
          setResults(Array.isArray(list) ? list : [])
          setOpen(true); setActive(-1)
        })
        .catch(() => { if (alive) { setResults([]); setOpen(true) } })
        .finally(() => { if (alive) setLoading(false) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  function choose(c: CustSuggest) { onPick(c); setQ(''); setOpen(false); setResults([]) }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <span className="material-symbols-rounded" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 18, color: 'var(--txt3)', pointerEvents: 'none' }}>search</span>
        <input
          type="text"
          value={q}
          autoFocus
          onChange={e => setQ(e.target.value)}
          onFocus={() => { if (results.length) setOpen(true) }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, results.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
            else if (e.key === 'Enter' && open && active >= 0 && results[active]) { e.preventDefault(); choose(results[active]) }
            else if (e.key === 'Escape') setOpen(false)
          }}
          placeholder="Search customer by name, CIF or phone…"
          style={{ ...inputStyle, paddingLeft: 36 }}
        />
        {loading && <div style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)' }}><Spinner size={14} /></div>}
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, boxShadow: '0 12px 30px rgba(0,0,0,0.16)', maxHeight: 264, overflowY: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: TEXT.sm, color: 'var(--txt3)' }}>{loading ? 'Searching…' : 'No matches found.'}</div>
          ) : results.map((c, i) => (
            <button
              key={c.cif + i}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', cursor: 'pointer', background: i === active ? 'var(--row-hvr)' : 'transparent', borderBottom: i < results.length - 1 ? '1px solid var(--bdr)' : 'none' }}
            >
              <div style={{ width: 30, height: 30, borderRadius: RADIUS.full, background: `${NAVY}12`, color: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, flexShrink: 0 }}>{initialsOf(c.name)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cleanName(c.name) || 'Unnamed'}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{c.cif}</span>{c.phone ? ` · ${c.phone}` : ''}{c.state ? ` · ${c.state}` : ''}
                </div>
              </div>
            </button>
          ))}
          <button type="button" onClick={onManual} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderTop: '1px solid var(--bdr)', cursor: 'pointer', background: 'var(--th-bg)', fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.semibold }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>edit</span>Enter manually (walk-in / no CIF)
          </button>
        </div>
      )}
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

const TICKET_TYPES = [
  'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Card Dispute',
  'Statement Request', 'Loan Complaint', 'FD Enquiry', 'Technical / App Issue',
  'Complaint (CBN reportable)',
] as const

type TicketType = typeof TICKET_TYPES[number]

// ── Field styles ──────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 12px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  outline: 'none', boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold,
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        <Field label="Disputed Amount (NGN)">
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
            style={{ ...inputStyle, height: 34 }}
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Account Number (optional)">
          <input
            type="text" placeholder="e.g. 0123456789"
            value={custom.account_number ?? ''}
            onChange={e => set('account_number', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Description">
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        <Field label="Amount (NGN)">
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Loan Reference">
          <input
            type="text" placeholder="e.g. LN-001234"
            value={custom.loan_reference ?? ''}
            onChange={e => set('loan_reference', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Complaint Details">
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="FD Reference (optional)">
          <input
            type="text" placeholder="e.g. FD-000456"
            value={custom.fd_reference ?? ''}
            onChange={e => set('fd_reference', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Enquiry Details">
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Device / Platform">
          <select
            value={custom.platform ?? ''}
            onChange={e => set('platform', e.target.value)}
            style={{ ...inputStyle, height: 34 }}
          >
            <option value="">— Select —</option>
            <option value="iOS">iOS</option>
            <option value="Android">Android</option>
            <option value="Web">Web</option>
            <option value="USSD">USSD</option>
          </select>
        </Field>
        <Field label="Issue Description">
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Complaint Category">
          <select
            value={custom.complaint_category ?? ''}
            onChange={e => set('complaint_category', e.target.value)}
            style={{ ...inputStyle, height: 34 }}
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
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
      <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
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
  initial,
  stickyFooter,
}: {
  onClose: () => void
  onCreated: (id: number) => void
  initial?: InitialCustomer
  stickyFooter?: boolean
}) {
  const [ticketType, setTicketType] = useState<TicketType | null>(null)
  const [customFields, setCustomFields] = useState<Record<string, string>>({})

  const [customerName, setCustomerName] = useState(cleanName(initial?.name))
  const [customerPhone, setCustomerPhone] = useState(initial?.phone ?? '')
  const [customerCif, setCustomerCif] = useState(initial?.cif ?? '')
  // picked = a customer is chosen (shown as a chip). manual = typing a walk-in
  // by hand. Otherwise the smart search typeahead is shown.
  const [picked, setPicked] = useState(Boolean(initial?.cif || cleanName(initial?.name)))
  const [manual, setManual] = useState(false)

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

  // Keep local state in sync if the initial customer resolves after mount.
  useEffect(() => {
    if (initial?.cif) setCustomerCif(initial.cif)
    if (initial?.name) setCustomerName(cleanName(initial.name))
    if (initial?.phone) setCustomerPhone(initial.phone)
    if (initial?.cif || cleanName(initial?.name)) setPicked(true)
  }, [initial?.cif, initial?.name, initial?.phone])

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
    <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[2] }}>
      {text}
    </div>
  )

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSubmit(e as any) }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <ErrBanner error={err} />

      {/* Ticket Type */}
      <div>
        {sectionHead('Ticket Type')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP[2] }}>
          {TICKET_TYPES.map(t => {
            const isSelected = ticketType === t
            return (
              <button
                key={t}
                type="button"
                onClick={() => { setTicketType(t); setCustomFields({}) }}
                style={{
                  padding: '7px 8px', borderRadius: RADIUS.md, cursor: 'pointer',
                  border: isSelected ? `2px solid ${RED}` : '2px solid var(--bdr)',
                  background: isSelected ? `${RED}08` : 'var(--th-bg)',
                  color: isSelected ? RED : 'var(--txt)',
                  fontSize: TEXT.sm, fontWeight: isSelected ? 700 : 500,
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
        {picked ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
            background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg,
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: RADIUS.full, flexShrink: 0,
              background: `${NAVY}12`, color: NAVY, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: TEXT.base, fontWeight: FW.extrabold,
            }}>
              {initialsOf(customerName)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{customerName || 'Unknown customer'}</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>
                {customerCif && <span style={{ fontFamily: 'var(--font-mono)' }}>CIF {customerCif}</span>}
                {customerPhone && <span>{customerPhone}</span>}
              </div>
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: GREEN, background: `${GREEN}14`, padding: '3px 9px', borderRadius: RADIUS.xl }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>Linked
            </span>
            <button
              type="button"
              onClick={() => { setPicked(false); setManual(false); setCustomerCif('') }}
              style={{ padding: '5px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
            >
              Change
            </button>
          </div>
        ) : manual ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
              <Field label="Customer Name">
                <input type="text" placeholder="Full name" value={customerName}
                  onChange={e => setCustomerName(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Phone Number">
                <input type="tel" placeholder="e.g. 08012345678" value={customerPhone}
                  onChange={e => setCustomerPhone(e.target.value)} style={inputStyle} />
              </Field>
            </div>
            <button type="button" onClick={() => setManual(false)}
              style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'none', color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>search</span>Search for an existing customer instead
            </button>
          </div>
        ) : (
          <CustomerSearch
            onPick={c => {
              setCustomerName(cleanName(c.name))
              setCustomerCif(c.cif)
              setCustomerPhone(c.phone ?? '')
              setPicked(true)
            }}
            onManual={() => setManual(true)}
          />
        )}
      </div>

      {/* Details */}
      <div>
        {sectionHead('Details')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
          <Field label="Subject" required>
            <input type="text" placeholder="Brief summary of the issue" value={subject}
              onChange={e => setSubject(e.target.value)} required style={inputStyle} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
            <Field label="Priority">
              <select value={priority} onChange={e => setPriority(e.target.value)}
                style={{ ...inputStyle, height: 34 }}>
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
                style={{ ...inputStyle, height: 34 }}
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
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
          placeholder="Any additional context or details…"
          rows={3}
          value={description}
          onChange={e => setDescription(e.target.value)}
          style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
        />
      </div>

      {/* Footer buttons — pinned to the bottom of the scroll area inside the modal */}
      <div style={stickyFooter ? {
        display: 'flex', gap: 10, position: 'sticky', bottom: -20, zIndex: 2,
        margin: '4px -20px -20px', padding: '12px 20px',
        background: 'var(--card)', borderTop: '1px solid var(--bdr)',
      } : { display: 'flex', gap: 10, paddingTop: 4 }}>
        <button
          type="submit"
          disabled={submitting}
          title="Cmd+Enter"
          style={{
            padding: '9px 24px', borderRadius: RADIUS.md, border: 'none',
            background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold,
            cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1,
            display: 'flex', alignItems: 'center', gap: SP[2],
          }}
        >
          {submitting && <Spinner size={15} color="#fff" />}
          Create Ticket
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: '9px 18px', borderRadius: RADIUS.md,
            border: '1px solid var(--bdr)', background: 'var(--card)',
            color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
