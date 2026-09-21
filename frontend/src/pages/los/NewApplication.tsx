import { useState, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { Page, Spinner } from '../../components/UI'
import { apiPost } from '../../lib/api'
import { NAVY, RED, GREEN, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PersonalInfo {
  full_name:  string
  // The customer number, when this application is for someone already on the book.
  // Without it the detail page hides Credit File and Customer 360 and shows
  // "· no CIF yet", and nothing can be matched back to the core system.
  cif:        string
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
  monthly_obligation: string // existing monthly debt service, naira; sent as kobo
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
    full_name: '', cif: '', dob: '', gender: '', phone: '', email: '', bvn: '', nin: '', address: '',
  },
  employment: {
    employer: '', job_title: '', monthly_salary: '', monthly_obligation: '', employment_type: '', start_date: '',
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
                  ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: '#fff' }}>check</span>
                  : <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color: active ? '#fff' : 'var(--txt3)' }}>{i + 1}</span>
                }
              </div>
              <span style={{
                fontSize: TEXT.xs, fontWeight: active ? FW.semibold : FW.normal,
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
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', resize: 'vertical',
  boxSizing: 'border-box', minHeight: 80,
}

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
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
      <Field label="CIF">
        <input style={inputStyle} value={data.cif} onChange={set('cif')} placeholder="Existing customer number, if any" />
      </Field>
      <Field label="BVN" required>
        <input style={inputStyle} value={data.bvn} onChange={set('bvn')} placeholder="11-digit BVN" maxLength={11} />
      </Field>
      <Field label="NIN">
        <input style={inputStyle} value={data.nin} onChange={set('nin')} placeholder="11-digit NIN" maxLength={11} />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Address" required>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={textareaStyle} value={data.address} onChange={set('address')} placeholder="Residential address" />
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
      <Field label="Existing Monthly Repayments (₦)">
        {/* Total of any loans the applicant is already servicing. Phoenix
            receives this as monthly_obligation_kobo and it is the direct
            input to DTI — left blank it reads as zero debt, which
            overstates affordability. */}
        <input
          type="number"
          style={inputStyle}
          value={data.monthly_obligation}
          onChange={set('monthly_obligation')}
          placeholder="e.g. 40000 — leave blank if none"
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
            <option value="credit_card">Credit Card</option>
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
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={textareaStyle} value={data.purpose} onChange={set('purpose')} placeholder="Describe the purpose of this loan" />
        </Field>
      </div>
    </div>
  )
}

// ── Step 4 — Documents ────────────────────────────────────────────────────────

// Keys match DOC_SLOTS in ApplicationDetail.tsx exactly. This list used 'id' where the
// detail page uses 'government_id', which was harmless only while nothing here ever
// uploaded: the same document would have filed itself under a slot the detail page
// does not render.
const DOC_SLOTS = [
  { key: 'government_id', label: 'Government-Issued ID',      icon: 'badge' },
  { key: 'payslip',       label: 'Latest Payslip',            icon: 'receipt_long' },
  { key: 'bank_statement',label: 'Bank Statement (6 months)', icon: 'account_balance' },
  { key: 'offer_letter',  label: 'Employment Offer Letter',   icon: 'description' },
]

const MAX_DOC_BYTES = 10 * 1024 * 1024

// Step 4 was a mock: a disabled Upload button, a hardcoded "Pending" pill and the words
// "No file selected" that never changed. Staff walked through a quarter of the wizard
// that did nothing. Files are held here and attached after submit, because a document
// needs an application id to belong to.
function Step4({ files, onPick }: {
  files: Record<string, File | null>
  onPick: (key: string, file: File | null) => void
}) {
  return (
    <div>
      <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[5], lineHeight: 1.6 }}>
        Attach the required documents below. Accepted formats: PDF, JPG, PNG (max 10 MB each).
        They are uploaded when you submit the application.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {DOC_SLOTS.map(slot => {
          const f = files[slot.key] ?? null
          return (
            <div key={slot.key} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 16px', borderRadius: RADIUS.lg,
              border: '1px solid var(--bdr)', background: 'var(--card)',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: RADIUS.lg,
                background: 'var(--chip-bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: 'var(--txt2)' }}>
                  {slot.icon}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{slot.label}</div>
                <div
                  title={f?.name}
                  style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {f ? `${f.name} · ${(f.size / 1024 / 1024).toFixed(2)} MB` : 'No file selected'}
                </div>
              </div>
              <span style={{
                fontSize: TEXT.xs, fontWeight: FW.semibold,
                padding: '2px 8px', borderRadius: RADIUS['2xl'],
                background: f ? 'rgba(22,163,74,.12)' : 'rgba(217,119,6,.12)',
                color: f ? GREEN : '#D97706', flexShrink: 0,
              }}>
                {f ? 'Ready' : 'Pending'}
              </span>
              {f && (
                <button
                  onClick={() => onPick(slot.key, null)}
                  title="Remove"
                  style={{
                    display: 'flex', alignItems: 'center', padding: 4, borderRadius: RADIUS.md,
                    border: 'none', background: 'none', color: 'var(--txt2)', cursor: 'pointer',
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>close</span>
                </button>
              )}
              <label style={{
                padding: '6px 14px', borderRadius: RADIUS.md,
                border: '1px solid var(--bdr)', background: 'var(--input-bg)',
                fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)',
                cursor: 'pointer', flexShrink: 0,
              }}>
                {f ? 'Replace' : 'Upload'}
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  style={{ display: 'none' }}
                  onChange={ev => {
                    const picked = ev.target.files?.[0] ?? null
                    if (picked && picked.size > MAX_DOC_BYTES) {
                      toast.error(`${picked.name} is larger than 10 MB`)
                    } else {
                      onPick(slot.key, picked)
                    }
                    // Clear the input so re-picking the same file still fires onChange.
                    ev.target.value = ''
                  }}
                />
              </label>
            </div>
          )
        })}
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
        <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{title}</span>
        <button
          onClick={onEdit}
          style={{
            fontSize: TEXT.sm, fontWeight: FW.medium, color: '#2563EB',
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
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>
              {label}
            </div>
            <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{value || '—'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Step5({ form, docs, goTo }: { form: FormData; docs: Record<string, File | null>; goTo: (s: number) => void }) {
  const p = form.personal
  const e = form.employment
  const l = form.loan
  const attached = DOC_SLOTS.filter(s => docs[s.key])

  return (
    <div>
      <ReviewSection
        title="Personal Information"
        step={0}
        onEdit={() => goTo(0)}
        data={{
          'Full Name': p.full_name,
          'CIF': p.cif,
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
          // Existing obligations drive DTI, which is the input most likely to change a
          // decision. Step 2 collects it and the review step used to leave it out, so
          // the officer confirmed a picture of affordability the application did not have.
          'Existing Monthly Repayments': e.monthly_obligation ? `₦${Number(e.monthly_obligation).toLocaleString('en-NG')}` : '',
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
      <ReviewSection
        title="Documents"
        step={3}
        onEdit={() => goTo(3)}
        data={
          attached.length === 0
            ? { 'Attached': 'None' }
            : Object.fromEntries(attached.map(s => [s.label, docs[s.key]!.name]))
        }
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
      if (Number(l.amount) <= 0) return 'Amount must be greater than zero'
      if (Number(l.amount) > 5_000_000) return 'Amount exceeds the maximum allowed (₦5,000,000)'
      if (!l.tenor_months)  return 'Tenor is required'
      if (Number(l.tenor_months) < 1 || Number(l.tenor_months) > 360) return 'Tenor must be between 1 and 360 months'
      if (!l.purpose)       return 'Purpose is required'
      return null
    default:
      return null
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NewApplication() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [step,       setStep]       = useState(0)
  const [form,       setForm]       = useState<FormData>(INIT)
  const [docs,       setDocs]       = useState<Record<string, File | null>>({})
  const [stepError,  setStepError]  = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Four pages carefully assemble these parameters — the BD pipeline sends
  // contact/employer/product, Book Customer and the helpdesk ticket send cif, the CRM
  // pipeline sends contact — and this page read none of them. An officer who clicked
  // "Create Application" from a lead retyped everything that was already on screen.
  useEffect(() => {
    const contact  = searchParams.get('contact')  ?? ''
    const employer = searchParams.get('employer') ?? ''
    const product  = searchParams.get('product')  ?? ''
    const cif      = searchParams.get('cif')      ?? ''
    if (!contact && !employer && !product && !cif) return
    setForm(f => ({
      personal:   { ...f.personal,   full_name: contact || f.personal.full_name, cif: cif || f.personal.cif },
      employment: { ...f.employment, employer: employer || f.employment.employer },
      loan:       { ...f.loan,       product_type: product || f.loan.product_type },
    }))
  }, [searchParams])

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
      // C2: send ALL collected fields. interest_rate_bps is intentionally omitted
      // so the backend can compute or default it rather than receiving a hardcoded 0.
      const payload = {
        // Step 1 — identity
        applicant_name:        form.personal.full_name,
        applicant_cif:         form.personal.cif.trim(),
        applicant_email:       form.personal.email,
        applicant_phone:       form.personal.phone,
        bvn:                   form.personal.bvn,
        nin:                   form.personal.nin,
        date_of_birth:         form.personal.dob,
        // Gender is a REQUIRED field on step 1 and was never sent — this payload
        // claimed to carry "ALL collected fields" but omitted it, so a mandatory
        // answer was collected, shown back on the review step, and thrown away.
        gender:                form.personal.gender,
        address:               form.personal.address,
        // Step 2 — employment
        employer:              form.employment.employer,
        job_title:             form.employment.job_title,
        employment_type:       form.employment.employment_type,
        employment_start_date: form.employment.start_date,
        monthly_income_kobo:   Math.round(Number(form.employment.monthly_salary) * 100),
        monthly_obligation_kobo: form.employment.monthly_obligation
          ? Math.round(Number(form.employment.monthly_obligation) * 100)
          : 0,
        // Step 3 — loan request
        product_type:          form.loan.product_type,
        amount_requested_kobo: Math.round(Number(form.loan.amount) * 100),
        tenor_months:          Number(form.loan.tenor_months),
        purpose:               form.loan.purpose,
      }
      const res = await apiPost<{ data: { id: number; reference: string } }>('/api/los', payload)
      const appID = res.data.id

      // A document needs an application to belong to, so the files staged on step 4 are
      // uploaded now. A failed upload must not discard the application that was just
      // created: report how many failed and continue to the detail page, whose
      // documents panel can retry the same slots.
      const staged = Object.entries(docs).filter((e): e is [string, File] => e[1] instanceof File)
      let failed = 0
      for (const [docType, file] of staged) {
        try {
          const token = localStorage.getItem('o3c_token') ?? ''
          const fd = new FormData()
          fd.append('file', file)
          fd.append('doc_type', docType)
          const up = await fetch(`/api/los/${appID}/documents`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
          })
          if (!up.ok) failed++
        } catch { failed++ }
      }

      toast.success(`Application ${res.data.reference} created`)
      if (failed > 0) {
        toast.error(`${failed} of ${staged.length} documents did not upload — retry from the application page`)
      }
      navigate(`/sales/applications/${appID}`)
    } catch (e: any) {
      setStepError(e.message ?? 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const btnBase: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    padding: '8px 18px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
    cursor: 'pointer', border: 'none',
  }

  return (
    <Page
      title="New Credit Application"
      subtitle="Applications / New"
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {/* Breadcrumb */}
        <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[5] }}>
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
            {step === 3 && <Step4 files={docs} onPick={(k, f) => setDocs(d => ({ ...d, [k]: f }))} />}
            {step === 4 && <Step5 form={form} docs={docs} goTo={goTo} />}
          </div>

          {/* Validation error */}
          {stepError && (
            <div style={{
              marginTop: 16, padding: '10px 14px', borderRadius: RADIUS.md,
              background: 'rgba(192,0,0,0.08)', border: '1px solid rgba(192,0,0,0.2)',
              fontSize: TEXT.base, color: RED,
            }}>
              {stepError}
            </div>
          )}

          {/* Navigation */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 28 }}>
            <div>
              {step > 0 && (
                <button onClick={handleBack} style={{ ...btnBase, background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>arrow_back</span>
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
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>arrow_forward</span>
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  style={{ ...btnBase, background: GREEN, color: '#fff', opacity: submitting ? 0.7 : 1, cursor: submitting ? 'wait' : 'pointer' }}
                >
                  {submitting && <Spinner size={14} color="#fff" />}
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>send</span>
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
