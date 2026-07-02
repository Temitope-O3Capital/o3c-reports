import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../../lib/api'
import { Spinner, NAVY } from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────────────────
interface CustomerPreview {
  cif_number?: string
  full_name?:  string
  email?:      string
  phone?:      string
  // c360Profile returns nested `account` object
  account?: {
    'First Name'?: string
    'Last Name'?:  string
    Email?:        string
    'Phone Number'?: string
  }
}

type FieldDef = {
  key:      string
  label:    string
  type:     'text' | 'number' | 'date' | 'select'
  options?: string[]
  half?:    boolean
}

type TypeConfig = {
  label:      string
  icon:       string
  queue:      string
  department: string
  fields?:    FieldDef[]
}

// ── Ticket type configuration ───────────────────────────────────────────────────
const TICKET_TYPE_CONFIG: Record<string, TypeConfig> = {
  general_inquiry: {
    label: 'General Inquiry', icon: 'help', queue: 'general', department: 'general',
  },
  payment_dispute: {
    label: 'Payment Dispute', icon: 'currency_exchange', queue: 'collections', department: 'collections',
    fields: [
      { key: 'transaction_date',  label: 'Transaction Date',       type: 'date',   half: true },
      { key: 'disputed_amount',   label: 'Disputed Amount (₦)',     type: 'number', half: true },
      { key: 'merchant_name',     label: 'Merchant / Description',  type: 'text' },
      { key: 'transaction_ref',   label: 'Transaction Reference',   type: 'text' },
    ],
  },
  card_block_request: {
    label: 'Card Block / Unblock', icon: 'credit_card_off', queue: 'cards_ops', department: 'cards_ops',
    fields: [
      { key: 'card_last4',   label: 'Card Last 4 Digits', type: 'text',   half: true },
      { key: 'block_reason', label: 'Reason',              type: 'select', half: true,
        options: ['Lost', 'Stolen', 'Suspected fraud', 'Other'] },
    ],
  },
  statement_request: {
    label: 'Statement Request', icon: 'description', queue: 'general', department: 'general',
    fields: [
      { key: 'period_from', label: 'Period From', type: 'date',   half: true },
      { key: 'period_to',   label: 'Period To',   type: 'date',   half: true },
      { key: 'delivery',    label: 'Delivery',    type: 'select',
        options: ['Email', 'Portal', 'Physical'] },
    ],
  },
  loan_inquiry: {
    label: 'Loan Inquiry', icon: 'savings', queue: 'loans', department: 'loans',
    fields: [
      { key: 'loan_reference', label: 'Loan Reference (if known)', type: 'text' },
      { key: 'inquiry_type',   label: 'Inquiry Type',              type: 'select',
        options: ['Repayment schedule', 'Top-up', 'Early closure', 'General'] },
    ],
  },
  account_update: {
    label: 'Account Update', icon: 'manage_accounts', queue: 'general', department: 'general',
    fields: [
      { key: 'update_type', label: 'Update Type', type: 'select',
        options: ['Phone number', 'Email address', 'Home address', 'BVN', 'Next of kin', 'Other'] },
      { key: 'new_value',   label: 'New Value',   type: 'text' },
    ],
  },
  complaint: {
    label: 'Formal Complaint', icon: 'report_problem', queue: 'management', department: 'compliance',
    fields: [
      { key: 'complaint_category',    label: 'Category', type: 'select',
        options: ['Service quality', 'Staff conduct', 'Wrong charge', 'Fraud', 'Discrimination', 'Other'] },
      { key: 'preferred_resolution',  label: 'Preferred Resolution', type: 'text' },
    ],
  },
  inbound_call: {
    label: 'Inbound Call', icon: 'call_received', queue: 'general', department: 'general',
    fields: [
      { key: 'call_duration_min', label: 'Duration (mins)', type: 'number', half: true },
      { key: 'call_outcome',      label: 'Outcome',         type: 'select', half: true,
        options: ['Resolved', 'Escalated', 'Callback required', 'No answer', 'Dropped'] },
    ],
  },
  technical_issue: {
    label: 'Technical Issue', icon: 'bug_report', queue: 'general', department: 'general',
    fields: [
      { key: 'platform',     label: 'Platform',      type: 'select',
        options: ['Mobile app', 'Web portal', 'USSD', 'Other'] },
      { key: 'error_detail', label: 'Error Message', type: 'text' },
    ],
  },
}

const TYPE_OPTIONS = Object.entries(TICKET_TYPE_CONFIG).map(([value, cfg]) => ({
  value, label: cfg.label, icon: cfg.icon,
}))

const CHANNEL_OPTIONS = [
  { value: 'email',    label: 'Email' },
  { value: 'sms',     label: 'SMS' },
  { value: 'whatsapp',label: 'WhatsApp' },
  { value: 'phone',   label: 'Phone' },
  { value: 'in_app',  label: 'In-App' },
]

const PRIORITY_OPTIONS = [
  { value: 'low',    label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high',   label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

// ── Component ──────────────────────────────────────────────────────────────────
export default function ComposeTicket({
  open, onClose, onCreated, prefillCif,
}: {
  open:       boolean
  onClose:    () => void
  onCreated:  (ticket: any) => void
  prefillCif?: string
}) {
  const [step, setStep] = useState<1 | 2>(1)

  // Step 1 — Customer
  const [cif, setCif]                     = useState(prefillCif ?? '')
  const [cifLoading, setCifL]             = useState(false)
  const [cifErr, setCifErr]               = useState('')
  const [customerPreview, setCustomerPreview] = useState<CustomerPreview | null>(null)
  const [manualName, setManualName]       = useState('')
  const [manualEmail, setManualEmail]     = useState('')
  const [manualPhone, setManualPhone]     = useState('')

  // Step 2 — Ticket
  const [ticketType, setTicketType]       = useState('')
  const [channel, setChannel]             = useState('email')
  const [subject, setSubject]             = useState('')
  const [priority, setPriority]           = useState('normal')
  const [department, setDepartment]       = useState('general')
  const [queue, setQueue]                 = useState('general')
  const [messageText, setMsgText]         = useState('')
  const [sendToCustomer, setSend]         = useState(true)
  const [customFields, setCustomFields]   = useState<Record<string, string>>({})

  // Submit
  const [submitting, setSubmitting]       = useState(false)
  const [submitErr, setSubmitErr]         = useState('')

  const step1Ref = useRef<HTMLDivElement>(null)

  // Pre-fill CIF from prop
  useEffect(() => {
    if (prefillCif) {
      setCif(prefillCif)
      lookupCif(prefillCif)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillCif])

  // Reset when closed
  useEffect(() => {
    if (!open) {
      setStep(1)
      setCif(prefillCif ?? ''); setCifErr(''); setCifL(false); setCustomerPreview(null)
      setManualName(''); setManualEmail(''); setManualPhone('')
      setTicketType(''); setChannel('email'); setSubject(''); setPriority('normal')
      setDepartment('general'); setQueue('general'); setMsgText(''); setSend(true)
      setCustomFields({}); setSubmitErr('')
    }
  }, [open, prefillCif])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  async function lookupCif(value: string) {
    if (!value.trim()) return
    setCifL(true); setCifErr(''); setCustomerPreview(null)
    try {
      const res = await apiFetch<CustomerPreview>(`/api/customer360/${value.trim()}`)
      setCustomerPreview(res)
      const name  = res.full_name ?? `${res.account?.['First Name'] ?? ''} ${res.account?.['Last Name'] ?? ''}`.trim()
      const email = res.email     ?? res.account?.Email
      const phone = res.phone     ?? res.account?.['Phone Number']
      if (name)  setManualName(name)
      if (email) setManualEmail(email)
      if (phone) setManualPhone(phone)
    } catch {
      setCifErr('Customer not found')
    } finally {
      setCifL(false)
    }
  }

  function applyTicketType(value: string) {
    setTicketType(value)
    setCustomFields({})
    if (!value) return
    const cfg = TICKET_TYPE_CONFIG[value]
    if (!cfg) return
    setDepartment(cfg.department)
    setQueue(cfg.queue)
    if (!subject || TYPE_OPTIONS.some(t => t.label === subject)) {
      setSubject(cfg.label)
    }
  }

  function setCustomField(key: string, value: string) {
    setCustomFields(prev => ({ ...prev, [key]: value }))
  }

  function step1Valid() {
    return !!(cif.trim() || manualPhone.trim())
  }

  async function handleSubmit() {
    if (!messageText.trim()) { setSubmitErr('Please enter a message'); return }
    setSubmitting(true); setSubmitErr('')
    try {
      const body: Record<string, any> = {
        channel,
        priority,
        department,
        message_text:     messageText.trim(),
        send_to_customer: sendToCustomer,
        subject:          subject.trim() || (ticketType ? TICKET_TYPE_CONFIG[ticketType]?.label : channel),
        customer_cif:     cif.trim()         || undefined,
        customer_name:    manualName.trim()   || undefined,
        customer_email:   manualEmail.trim()  || undefined,
        customer_phone:   manualPhone.trim()  || undefined,
      }
      if (ticketType) {
        body.ticket_type  = ticketType
        body.queue        = queue
        if (Object.keys(customFields).length > 0) {
          body.custom_fields = customFields
        }
      }
      const res = await apiFetch<any>('/api/helpdesk/tickets', {
        method: 'POST',
        body:   JSON.stringify(body),
      })
      // Backend returns { ticket, message } — unwrap to the flat ticket object
      onCreated(res.ticket ?? res)
    } catch (e: any) {
      setSubmitErr(e.message || 'Failed to create ticket')
    } finally {
      setSubmitting(false)
    }
  }

  const typeConfig     = ticketType ? TICKET_TYPE_CONFIG[ticketType] : null
  const hasContact     = !!(manualEmail.trim() || manualPhone.trim() || customerPreview?.email)
  const extraFields    = typeConfig?.fields ?? []
  const halfFields     = extraFields.filter(f => f.half)
  const fullFields     = extraFields.filter(f => !f.half)
  const pairsCount     = Math.ceil(halfFields.length / 2)

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-[290] bg-black/30 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center p-4"
        onClick={e => e.stopPropagation()}
      >
        <div
          className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden flex flex-col"
          style={{ maxWidth: 580, maxHeight: '92vh' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.09)' }}>
            <div>
              <h2 className="text-[16px] font-bold text-slate-900">New Ticket</h2>
              <p className="text-[12px] text-slate-400 mt-0.5">
                Step {step} of 2
                {step === 2 && ticketType && typeConfig && (
                  <span className="ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={{ background: 'rgba(14,40,65,0.07)', color: NAVY }}>
                    <span className="material-symbols-rounded text-[11px] align-[-1px] mr-0.5">{typeConfig.icon}</span>
                    {typeConfig.label}
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
            >
              <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
            </button>
          </div>

          {/* Progress bar */}
          <div className="h-0.5 bg-slate-100 flex-shrink-0">
            <div
              className="h-full transition-all duration-300"
              style={{ width: step === 1 ? '50%' : '100%', background: NAVY }}
            />
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5" ref={step1Ref}>
            {step === 1 ? (
              <div className="space-y-5">
                <p className="text-[13px] font-semibold text-slate-700">Customer Lookup</p>

                <FormField label="CIF Number (optional)">
                  <div className="flex gap-2">
                    <input
                      value={cif}
                      onChange={e => { setCif(e.target.value); setCifErr(''); setCustomerPreview(null) }}
                      onBlur={e => { if (e.target.value.trim()) lookupCif(e.target.value) }}
                      placeholder="e.g. 0001234"
                      style={inputStyle}
                    />
                    {cifLoading && <Spinner size={18} />}
                  </div>
                  {cifErr && <p className="text-[11px] text-red-600 mt-1">{cifErr}</p>}
                  {customerPreview && (
                    <div className="mt-2 px-3 py-2 rounded-lg text-[12px]"
                      style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.15)' }}>
                      <p className="font-semibold text-green-800">{manualName}</p>
                      {manualEmail && <p className="text-slate-500 mt-0.5">{manualEmail}</p>}
                    </div>
                  )}
                </FormField>

                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-slate-100" />
                  <span className="text-[11px] text-slate-400 font-medium">OR ENTER MANUALLY</span>
                  <div className="flex-1 h-px bg-slate-100" />
                </div>

                <FormField label="Full Name">
                  <input
                    value={manualName}
                    onChange={e => setManualName(e.target.value)}
                    placeholder="Customer name"
                    style={inputStyle}
                  />
                </FormField>

                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Email">
                    <input
                      type="email"
                      value={manualEmail}
                      onChange={e => setManualEmail(e.target.value)}
                      placeholder="email@example.com"
                      style={inputStyle}
                    />
                  </FormField>
                  <FormField label="Phone *">
                    <input
                      type="tel"
                      value={manualPhone}
                      onChange={e => setManualPhone(e.target.value)}
                      placeholder="+234801234…"
                      style={inputStyle}
                    />
                  </FormField>
                </div>

                {!step1Valid() && (
                  <p className="text-[12px] text-red-500">Please enter a CIF number or phone number.</p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {/* Ticket Type — full-width, prominent */}
                <FormField label="Ticket Type *">
                  <div className="grid grid-cols-3 gap-2">
                    {TYPE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => applyTicketType(opt.value)}
                        className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border text-center transition-all"
                        style={{
                          borderColor: ticketType === opt.value ? NAVY : 'rgba(15,23,42,0.12)',
                          background:  ticketType === opt.value ? 'rgba(14,40,65,0.06)' : 'white',
                          color:       ticketType === opt.value ? NAVY : '#64748B',
                        }}
                      >
                        <span className="material-symbols-rounded text-[20px]">{opt.icon}</span>
                        <span className="text-[10px] font-semibold leading-tight">{opt.label}</span>
                      </button>
                    ))}
                  </div>
                </FormField>

                {/* Routing chip — shown after type is selected */}
                {typeConfig && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-slate-400">Routes to:</span>
                    <span className="px-2 py-0.5 rounded-full font-semibold"
                      style={{ background: 'rgba(14,40,65,0.07)', color: NAVY }}>
                      {typeConfig.queue}
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500">{typeConfig.department}</span>
                  </div>
                )}

                {/* Channel + Priority */}
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Channel">
                    <select value={channel} onChange={e => setChannel(e.target.value)} style={inputStyle}>
                      {CHANNEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Priority">
                    <select value={priority} onChange={e => setPriority(e.target.value)} style={inputStyle}>
                      {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </FormField>
                </div>

                {/* Subject — always shown, auto-filled from type */}
                <FormField label="Subject">
                  <input
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                    placeholder="Ticket subject…"
                    style={inputStyle}
                  />
                </FormField>

                {/* Message */}
                <FormField label="Message *">
                  <textarea
                    value={messageText}
                    onChange={e => setMsgText(e.target.value)}
                    placeholder="Describe the issue in detail…"
                    rows={4}
                    className="resize-none"
                    style={{ ...inputStyle, display: 'block', width: '100%' }}
                  />
                </FormField>

                {/* Dynamic custom fields */}
                {extraFields.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                      Additional Details
                    </p>
                    <div className="space-y-3">
                      {/* Pair half-width fields */}
                      {pairsCount > 0 && (
                        <div className="grid grid-cols-2 gap-3">
                          {halfFields.map(f => (
                            <FormField key={f.key} label={f.label}>
                              {f.type === 'select' ? (
                                <select
                                  value={customFields[f.key] ?? ''}
                                  onChange={e => setCustomField(f.key, e.target.value)}
                                  style={inputStyle}
                                >
                                  <option value="">Select…</option>
                                  {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                              ) : (
                                <input
                                  type={f.type}
                                  value={customFields[f.key] ?? ''}
                                  onChange={e => setCustomField(f.key, e.target.value)}
                                  style={inputStyle}
                                />
                              )}
                            </FormField>
                          ))}
                        </div>
                      )}
                      {/* Full-width fields */}
                      {fullFields.map(f => (
                        <FormField key={f.key} label={f.label}>
                          {f.type === 'select' ? (
                            <select
                              value={customFields[f.key] ?? ''}
                              onChange={e => setCustomField(f.key, e.target.value)}
                              style={inputStyle}
                            >
                              <option value="">Select…</option>
                              {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input
                              type={f.type}
                              value={customFields[f.key] ?? ''}
                              onChange={e => setCustomField(f.key, e.target.value)}
                              style={inputStyle}
                            />
                          )}
                        </FormField>
                      ))}
                    </div>
                  </div>
                )}

                {hasContact && (
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={sendToCustomer}
                      onChange={e => setSend(e.target.checked)}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-[13px] text-slate-600">Also send to customer</span>
                  </label>
                )}

                {submitErr && <p className="text-[12px] text-red-600">{submitErr}</p>}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderTop: '1px solid rgba(15,23,42,0.09)' }}>
            {step === 2 ? (
              <button
                onClick={() => setStep(1)}
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Back
              </button>
            ) : (
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
            )}

            {step === 1 ? (
              <button
                onClick={() => setStep(2)}
                disabled={!step1Valid()}
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: NAVY }}
              >
                Next
                <span className="material-symbols-rounded text-[16px]">arrow_forward</span>
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={submitting || !messageText.trim()}
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: NAVY }}
              >
                {submitting ? <Spinner size={14} /> : <span className="material-symbols-rounded text-[16px]">send</span>}
                Create Ticket
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width:        '100%',
  padding:      '8px 12px',
  borderRadius: 8,
  border:       '1px solid rgba(15,23,42,0.15)',
  fontSize:     13,
  color:        '#334155',
  background:   'white',
  outline:      'none',
  boxSizing:    'border-box',
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}
