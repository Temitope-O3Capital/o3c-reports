import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Page, Spinner } from '../../components/UI'
import { apiPost } from '../../lib/api'
import { NAVY, RED, GREEN, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PersonalInfo {
  full_name:  string
  dob:        string
  gender:     string
  phone:      string
  email:      string
  bvn:        string
  nin:        string
  address:    string
}

interface Employment {
  employer:         string
  job_title:        string
  monthly_salary:   string  // display in naira, sent as kobo
  employment_type:  string
  start_date:       string
}

interface LoanRequest {
  product_type: string
  amount:       string  // display in naira, sent as kobo
  tenor_months: string
  purpose:      string
}

interface FormData {
  personal:   PersonalInfo
  employment: Employment
  loan:       LoanRequest
}

const INIT: FormData = {
  personal: {
    full_name: '', dob: '', gender: '', phone: '', email: '', bvn: '', nin: '', address: '',
  },
  employment: {
    employer: '', job_title: '', monthly_salary: '', employment_type: '', start_date: '',
  },
  loan: {
    product_type: '', amount: '', tenor_months: '', purpose: '',
  },
}

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS = ['Personal Info', 'Employment', 'Credit Request', 'Documents', 'Review']

function StepIndicator({ current }: { current: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 28 }}>
      {STEPS.map((label, i) => {
        const done    = i < current
        const active  = i === current
        const isLast  = i === STEPS.length - 1
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', flex: isLast ? 0 : 1 }}>
            {/* Circle */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: done ? GREEN : active ? NAVY : 'var(--chip-bg)',
                border: `2px solid ${done ? GREEN : active ? NAVY : 'var(--bdr)'}`,
                transition: 'all 200ms',
              }}>
                {done
                  ? <span className="material-symbols-rounded" style={{ fontSize: 14, color: '#fff' }}>check</span>
                  : <span style={{ ...NUM, fontSize: 11, fontWeight: 700, color: active ? '#fff' : 'var(--txt3)' }}>{i + 1}</span>
                }
              </div>
              <span style={{
                fontSize: 11, fontWeight: active ? 600 : 400,
                color: active ? 'var(--txt)' : 'var(--txt2)',
                whiteSpace: 'nowrap',
              }}>
                {label}
              </span>
            </div>
            {/* Connector */}
            {!isLast && (
              <div style={{
                flex: 1, height: 2, margin: '0 4px', marginBottom: 18,
                background: done ? GREEN : 'var(--bdr)',
                transition: 'background 200ms',
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Form field helper ─────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px',
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', resize: 'vertical',
  boxSizing: 'border-box', minHeight: 80,
}

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
      {label}{required && <span style={{ color: RED }}> *</span>}
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <FieldLabel label={label} required={required} />
      {children}
    </div>
  )
}

// ── Step 1 — Personal Info ────────────────────────────────────────────────────

function Step1({ data, onChange }: { data: PersonalInfo; onChange: (d: PersonalInfo) => void }) {
  const set = (k: keyof PersonalInfo) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange({ ...data, [k]: e.target.value })
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 20px' }}>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Full Name" required>
          <input style={inputStyle} value={data.full_name} onChange={set('full_name')} placeholder="As on ID document" />
        </Field>
      </div>
      <Field label="Date of Birth" required>
        <input type="date" style={inputStyle} value={data.dob} onChange={set('dob')} />
      </Field>
      <Field label="Gender" required>
        <select style={inputStyle} value={data.gender} onChange={set('gender')}>
          <option value="">Select gender</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="other">Other</option>
        </select>
      </Field>
      <Field label="Phone" required>
        <input style={inputStyle} value={data.phone} onChange={set('phone')} placeholder="08XXXXXXXXX" />
      </Field>
      <Field label="Email">
        <input type="email" style={inputStyle} value={data.email} onChange={set('email')} placeholder="applicant@email.com" />
      </Field>
      <Field label="BVN" required>
        <input style={inputStyle} value={data.bvn} onChange={set('bvn')} placeholder="11-digit BVN" maxLength={11} />
      </Field>
      <Field label="NIN">
        <input style={inputStyle} value={data.nin} onChange={set('nin')} placeholder="11-digit NIN" maxLength={11} />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Address" required>
          <textarea style={textareaStyle} value={data.address} onChange={set('address')} placeholder="Residential address" />
        </Field>
      </div>
    </div>
  )
}

// ── Step 2 — Employment ───────────────────────────────────────────────────────

function Step2({ data, onChange }: { data: Employment; onChange: (d: Employment) => void }) {
  const set = (k: keyof Employment) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...data, [k]: e.target.value })
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 20px' }}>
      <Field label="Employer Name" required>
        <input style={inputStyle} value={data.employer} onChange={set('employer')} placeholder="Company / organisation name" />
      </Field>
      <Field label="Job Title" required>
        <input style={inputStyle} value={data.job_title} onChange={set('job_title')} placeholder="e.g. Senior Accountant" />
      </Field>
      <Field label="Monthly Salary (₦)" required>
        <input
          type="number"
          style={inputStyle}
          value={data.monthly_salary}
          onChange={set('monthly_salary')}
          placeholder="e.g. 150000"
          min={0}
        />
      </Field>
      <Field label="Employment Type" required>
        <select style={inputStyle} value={data.employment_type} onChange={set('employment_type')}>
          <option value="">Select type</option>
          <option value="permanent">Permanent</option>
          <option value="contract">Contract</option>
          <option value="self_employed">Self-employed</option>
        </select>
      </Field>
      <Field label="Employment Start Date" required>
        <input type="date" style={inputStyle} value={data.start_date} onChange={set('start_date')} />
      </Field>
    </div>
  )
}

// ── Step 3 — Loan Request ─────────────────────────────────────────────────────

function Step3({ data, onChange }: { data: LoanRequest; onChange: (d: LoanRequest) => void }) {
  const set = (k: keyof LoanRequest) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange({ ...data, [k]: e.target.value })
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 20px' }}>
      <Field label="Product Type" required>
        <select style={inputStyle} value={data.product_type} onChange={set('product_type')}>
          <option value="">Select product</option>
          <option value="salary_loan">Salary Loan</option>
          <option value="business_loan">Business Loan</option>
          <option value="personal_loan">Personal Loan</option>
        </select>
      </Field>
      <Field label="Amount Requested (₦)" required>
        <input
          type="number"
          style={inputStyle}
          value={data.amount}
          onChange={set('amount')}
          placeholder="e.g. 500000"
          min={0}
        />
      </Field>
      <Field label="Tenor (months)" required>
        <input
          type="number"
          style={inputStyle}
          value={data.tenor_months}
          onChange={set('tenor_months')}
          placeholder="e.g. 12"
          min={1}
          max={360}
        />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Purpose" required>
          <textarea style={textareaStyle} value={data.purpose} onChange={set('purpose')} placeholder="Describe the purpose of this loan" />
        </Field>
      </div>
    </div>
  )
}

// ── Step 4 — Documents ────────────────────────────────────────────────────────

const DOC_SLOTS = [
  { key: 'id',            label: 'Government-Issued ID',     icon: 'badge' },
  { key: 'payslip',       label: 'Latest Payslip',           icon: 'receipt_long' },
  { key: 'bank_statement',label: 'Bank Statement (6 months)', icon: 'account_balance' },
  { key: 'offer_letter',  label: 'Employment Offer Letter',  icon: 'description' },
]

function Step4() {
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--txt2)', marginBottom: 20, lineHeight: 1.6 }}>
        Upload the required documents below. Document upload will be fully enabled in the next release — slots are shown for tracking purposes.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {DOC_SLOTS.map(slot => (
          <div key={slot.key} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '14px 16px', borderRadius: 10,
            border: '1px solid var(--bdr)', background: 'var(--card)',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9,
              background: 'var(--chip-bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt2)' }}>
                {slot.icon}
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{slot.label}</div>
              <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>No file selected</div>
            </div>
            <span style={{
              fontSize: 11.5, fontWeight: 600,
              padding: '2px 8px', borderRadius: 20,
              background: 'rgba(217,119,6,.12)', color: '#D97706',
            }}>
              Pending
            </span>
            <button
              disabled
              style={{
                padding: '6px 14px', borderRadius: 8,
                border: '1px solid var(--bdr)', background: 'var(--input-bg)',
                fontSize: 12.5, fontWeight: 500, color: 'var(--txt2)',
                cursor: 'not-allowed', opacity: 0.6,
              }}
            >
              Upload
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Step 5 — Review ───────────────────────────────────────────────────────────

function ReviewSection({
  title, data, onEdit, step,
}: {
  title: string
  data: Record<string, string>
  onEdit: () => void
  step: number
}) {
  return (
    <div style={{
      border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden', marginBottom: 14,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', background: 'var(--th-bg)',
        borderBottom: '1px solid var(--bdr)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{title}</span>
        <button
          onClick={onEdit}
          style={{
            fontSize: 12, fontWeight: 500, color: '#2563EB',
            background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
          }}
        >
          Edit (Step {step + 1})
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        {Object.entries(data).filter(([, v]) => v).map(([label, value], i) => (
          <div key={label} style={{
            padding: '9px 16px',
            borderBottom: i < Object.entries(data).length - 2 ? '1px solid var(--bdr)' : undefined,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>
              {label}
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--txt)', fontWeight: 500 }}>{value || '—'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Step5({ form, goTo }: { form: FormData; goTo: (s: number) => void }) {
  const p = form.personal
  const e = form.employment
  const l = form.loan

  return (
    <div>
      <ReviewSection
        title="Personal Information"
        step={0}
        onEdit={() => goTo(0)}
        data={{
          'Full Name': p.full_name,
          'Date of Birth': p.dob,
          'Gender': p.gender,
          'Phone': p.phone,
          'Email': p.email,
          'BVN': p.bvn,
          'NIN': p.nin,
          'Address': p.address,
        }}
      />
      <ReviewSection
        title="Employment Details"
        step={1}
        onEdit={() => goTo(1)}
        data={{
          'Employer': e.employer,
          'Job Title': e.job_title,
          'Monthly Salary': e.monthly_salary ? `₦${Number(e.monthly_salary).toLocaleString('en-NG')}` : '',
          'Employment Type': e.employment_type,
          'Start Date': e.start_date,
        }}
      />
      <ReviewSection
        title="Credit Request"
        step={2}
        onEdit={() => goTo(2)}
        data={{
          'Product': l.product_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          'Amount': l.amount ? `₦${Number(l.amount).toLocaleString('en-NG')}` : '',
          'Tenor': l.tenor_months ? `${l.tenor_months} months` : '',
          'Purpose': l.purpose,
        }}
      />
    </div>
  )
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateStep(step: number, form: FormData): string | null {
  const p = form.personal
  const e = form.employment
  const l = form.loan
  switch (step) {
    case 0:
      if (!p.full_name) return 'Full name is required'
      if (!p.dob)       return 'Date of birth is required'
      if (!p.gender)    return 'Gender is required'
      if (!p.phone)     return 'Phone is required'
      if (!p.bvn)       return 'BVN is required'
      if (!p.address)   return 'Address is required'
      return null
    case 1:
      if (!e.employer)         return 'Employer name is required'
      if (!e.job_title)        return 'Job title is required'
      if (!e.monthly_salary)   return 'Monthly salary is required'
      if (!e.employment_type)  return 'Employment type is required'
      if (!e.start_date)       return 'Employment start date is required'
      return null
    case 2:
      if (!l.product_type)  return 'Product type is required'
      if (!l.amount)        return 'Amount is required'
      if (!l.tenor_months)  return 'Tenor is required'
      if (!l.purpose)       return 'Purpose is required'
      return null
    default:
      return null
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NewApplication() {
  const navigate = useNavigate()
  const [step,       setStep]       = useState(0)
  const [form,       setForm]       = useState<FormData>(INIT)
  const [stepError,  setStepError]  = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const updatePersonal   = (d: PersonalInfo)  => setForm(f => ({ ...f, personal: d }))
  const updateEmployment = (d: Employment)    => setForm(f => ({ ...f, employment: d }))
  const updateLoan       = (d: LoanRequest)   => setForm(f => ({ ...f, loan: d }))

  function goTo(s: number) {
    setStepError(null)
    setStep(s)
  }

  function handleNext() {
    const err = validateStep(step, form)
    if (err) { setStepError(err); return }
    setStepError(null)
    setStep(s => s + 1)
  }

  function handleBack() {
    setStepError(null)
    setStep(s => s - 1)
  }

  async function handleSubmit() {
    setSubmitting(true)
    setStepError(null)
    try {
      const payload = {
        applicant_name:       form.personal.full_name,
        applicant_email:      form.personal.email,
        applicant_phone:      form.personal.phone,
        product_type:         form.loan.product_type,
        amount_requested_kobo: Math.round(Number(form.loan.amount) * 100),
        tenor_months:         Number(form.loan.tenor_months),
        interest_rate_bps:    0,
        purpose:              form.loan.purpose,
        employer:             form.employment.employer,
        monthly_income_kobo:  Math.round(Number(form.employment.monthly_salary) * 100),
      }
      const res = await apiPost<{ data: { id: number; reference: string } }>('/api/los/', payload)
      toast.success(`Application ${res.data.reference} created`)
      navigate(`/sales/applications/${res.data.id}`)
    } catch (e: any) {
      setStepError(e.message ?? 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const btnBase: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    padding: '8px 18px', borderRadius: 8, fontSize: 13.5, fontWeight: 600,
    cursor: 'pointer', border: 'none',
  }

  return (
    <Page
      title="New Credit Application"
      subtitle="Applications / New"
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {/* Breadcrumb */}
        <div style={{ fontSize: 13, color: 'var(--txt2)', marginBottom: 20 }}>
          <Link to="/sales/applications" style={{ color: '#2563EB', textDecoration: 'none' }}>Applications</Link>
          <span style={{ margin: '0 6px' }}>{'/'}</span>
          <span>New Application</span>
        </div>

        <div style={{
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderRadius: 14, padding: '28px 32px',
          boxShadow: 'var(--card-shadow)',
        }}>
          <StepIndicator current={step} />

          {/* Step content */}
          <div style={{ minHeight: 300 }}>
            {step === 0 && <Step1 data={form.personal}   onChange={updatePersonal} />}
            {step === 1 && <Step2 data={form.employment} onChange={updateEmployment} />}
            {step === 2 && <Step3 data={form.loan}       onChange={updateLoan} />}
            {step === 3 && <Step4 />}
            {step === 4 && <Step5 form={form} goTo={goTo} />}
          </div>

          {/* Validation error */}
          {stepError && (
            <div style={{
              marginTop: 16, padding: '10px 14px', borderRadius: 8,
              background: 'rgba(192,0,0,0.08)', border: '1px solid rgba(192,0,0,0.2)',
              fontSize: 13, color: RED,
            }}>
              {stepError}
            </div>
          )}

          {/* Navigation */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 28 }}>
            <div>
              {step > 0 && (
                <button onClick={handleBack} style={{ ...btnBase, background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_back</span>
                  Back
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Link to="/sales/applications" style={{ ...btnBase, background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)', textDecoration: 'none' }}>
                Cancel
              </Link>
              {step < STEPS.length - 1 ? (
                <button onClick={handleNext} style={{ ...btnBase, background: NAVY, color: '#fff' }}>
                  Next
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_forward</span>
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  style={{ ...btnBase, background: GREEN, color: '#fff', opacity: submitting ? 0.7 : 1, cursor: submitting ? 'wait' : 'pointer' }}
                >
                  {submitting && <Spinner size={14} color="#fff" />}
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>
                  Submit Application
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}
