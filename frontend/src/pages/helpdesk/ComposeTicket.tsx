import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../../lib/api'
import { Spinner, NAVY } from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────────────────
interface CustomerPreview {
  cif_number: string
  full_name: string
  email?: string
  phone?: string
}

// ── Constants ──────────────────────────────────────────────────────────────────
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

const DEPT_OPTIONS = [
  { value: 'cards_ops',   label: 'Cards Ops' },
  { value: 'loans',       label: 'Loans' },
  { value: 'collections', label: 'Collections' },
  { value: 'recovery',    label: 'Recovery' },
  { value: 'general',     label: 'General' },
  { value: 'compliance',  label: 'Compliance' },
]

// ── Component ──────────────────────────────────────────────────────────────────
export default function ComposeTicket({
  open, onClose, onCreated, prefillCif,
}: {
  open: boolean
  onClose: () => void
  onCreated: (ticket: any) => void
  prefillCif?: string
}) {
  const [step, setStep] = useState<1 | 2>(1)

  // Step 1 — Customer
  const [cif, setCif]           = useState(prefillCif ?? '')
  const [cifLoading, setCifL]   = useState(false)
  const [cifErr, setCifErr]     = useState('')
  const [customerPreview, setCustomerPreview] = useState<CustomerPreview | null>(null)
  const [manualName, setManualName]   = useState('')
  const [manualEmail, setManualEmail] = useState('')
  const [manualPhone, setManualPhone] = useState('')

  // Step 2 — Message
  const [channel, setChannel]     = useState('email')
  const [subject, setSubject]     = useState('')
  const [priority, setPriority]   = useState('normal')
  const [department, setDepartment] = useState('general')
  const [messageText, setMsgText] = useState('')
  const [sendToCustomer, setSend] = useState(true)

  // Submit
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr]   = useState('')

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
      setCif(prefillCif ?? '')
      setCifErr(''); setCifL(false); setCustomerPreview(null)
      setManualName(''); setManualEmail(''); setManualPhone('')
      setChannel('email'); setSubject(''); setPriority('normal')
      setDepartment('general'); setMsgText(''); setSend(true)
      setSubmitErr('')
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
      if (res.full_name) setManualName(res.full_name)
      if (res.email)     setManualEmail(res.email)
      if (res.phone)     setManualPhone(res.phone)
    } catch {
      setCifErr('Customer not found')
    } finally {
      setCifL(false)
    }
  }

  function step1Valid() {
    // Need at least CIF or phone
    if (cif.trim() || manualPhone.trim()) return true
    return false
  }

  async function handleSubmit() {
    if (!messageText.trim()) { setSubmitErr('Please enter a message'); return }
    setSubmitting(true); setSubmitErr('')
    try {
      const body: Record<string, any> = {
        channel,
        priority,
        department,
        message_text: messageText.trim(),
        send_to_customer: sendToCustomer,
        customer_cif:   cif.trim() || undefined,
        customer_name:  manualName.trim() || undefined,
        customer_email: manualEmail.trim() || undefined,
        customer_phone: manualPhone.trim() || undefined,
      }
      if (channel === 'email') body.subject = subject.trim()
      const ticket = await apiFetch('/api/helpdesk/tickets', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      onCreated(ticket)
    } catch (e: any) {
      setSubmitErr(e.message || 'Failed to create ticket')
    } finally {
      setSubmitting(false)
    }
  }

  const hasContact = !!(manualEmail.trim() || manualPhone.trim() || customerPreview?.email || customerPreview?.phone)

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
          style={{ maxWidth: 560, maxHeight: '90vh' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4"
            style={{ borderBottom: '1px solid rgba(15,23,42,0.09)' }}>
            <div>
              <h2 className="text-[16px] font-bold text-slate-900">New Ticket</h2>
              <p className="text-[12px] text-slate-400 mt-0.5">Step {step} of 2</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
            >
              <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
            </button>
          </div>

          {/* Progress bar */}
          <div className="h-0.5 bg-slate-100">
            <div
              className="h-full transition-all"
              style={{ width: step === 1 ? '50%' : '100%', background: NAVY }}
            />
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5" ref={step1Ref}>
            {step === 1 ? (
              <div className="space-y-5">
                <p className="text-[13px] font-semibold text-slate-700">Customer Lookup</p>

                {/* CIF */}
                <FormField label="CIF Number (optional)">
                  <div className="flex gap-2">
                    <input
                      value={cif}
                      onChange={e => { setCif(e.target.value); setCifErr(''); setCustomerPreview(null) }}
                      onBlur={e => { if (e.target.value.trim()) lookupCif(e.target.value) }}
                      placeholder="e.g. 0001234"
                      className="flex-1 input-field"
                      style={inputStyle}
                    />
                    {cifLoading && <Spinner size={18} />}
                  </div>
                  {cifErr && <p className="text-[11px] text-red-600 mt-1">{cifErr}</p>}
                  {customerPreview && (
                    <div className="mt-2 px-3 py-2 rounded-lg text-[12px]"
                      style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.15)' }}>
                      <p className="font-semibold text-green-800">{customerPreview.full_name}</p>
                      {customerPreview.email && <p className="text-slate-500 mt-0.5">{customerPreview.email}</p>}
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
                  <p className="text-[12px] text-red-600">Please enter a CIF number or phone number.</p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-[13px] font-semibold text-slate-700">Message Details</p>

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

                <FormField label="Department">
                  <select value={department} onChange={e => setDepartment(e.target.value)} style={inputStyle}>
                    {DEPT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </FormField>

                {channel === 'email' && (
                  <FormField label="Subject">
                    <input
                      value={subject}
                      onChange={e => setSubject(e.target.value)}
                      placeholder="Ticket subject…"
                      style={inputStyle}
                    />
                  </FormField>
                )}

                <FormField label="Message *">
                  <textarea
                    value={messageText}
                    onChange={e => setMsgText(e.target.value)}
                    placeholder="Describe the issue…"
                    rows={5}
                    className="resize-none"
                    style={{ ...inputStyle, display: 'block', width: '100%' }}
                  />
                </FormField>

                {hasContact && (
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={sendToCustomer}
                      onChange={e => setSend(e.target.checked)}
                      className="w-4 h-4 rounded accent-navy"
                    />
                    <span className="text-[13px] text-slate-600">Also send to customer</span>
                  </label>
                )}

                {submitErr && <p className="text-[12px] text-red-600">{submitErr}</p>}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4"
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

// ── Helpers ──────────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid rgba(15,23,42,0.15)',
  fontSize: 13,
  color: '#334155',
  background: 'white',
  outline: 'none',
  boxSizing: 'border-box',
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
