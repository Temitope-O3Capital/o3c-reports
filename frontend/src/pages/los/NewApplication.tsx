import { snake } from '../../lib/labels'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost } from '../../lib/api'
import { ErrBanner, Page, NAVY, RED } from '../../components/UI'

const PRODUCT_TYPES = ['prepaid_card', 'credit_card', 'usd_card', 'business_loan', 'personal_loan']

interface FormData {
  // Step 1
  applicant_name: string
  phone: string
  email: string
  cif: string
  // Step 2
  product_type: string
  amount_requested_kobo: string   // stored as naira string, converted on submit
  tenor_months: string
  purpose: string
  employer: string
  monthly_income_kobo: string
}

const INITIAL: FormData = {
  applicant_name: '', phone: '', email: '', cif: '',
  product_type: '', amount_requested_kobo: '', tenor_months: '',
  purpose: '', employer: '', monthly_income_kobo: '',
}

const STEPS = ['Applicant Details', 'Product & Loan', 'Review & Submit']

export default function NewApplication() {
  const nav = useNavigate()
  const [step, setStep]     = useState(0)
  const [form, setForm]     = useState<FormData>(INITIAL)
  const [error, setError]   = useState('')
  const [saving, setSaving] = useState(false)

  function set(k: keyof FormData, v: string) {
    setForm(f => ({ ...f, [k]: v }))
  }

  function canAdvance() {
    if (step === 0) return form.applicant_name.trim() && form.phone.trim()
    if (step === 1) return form.product_type && form.amount_requested_kobo && form.tenor_months
    return true
  }

  async function submit() {
    setSaving(true); setError('')
    try {
      const payload = {
        applicant_name:        form.applicant_name,
        phone:                 form.phone,
        email:                 form.email || undefined,
        cif:                   form.cif || undefined,
        product_type:          form.product_type,
        amount_requested_kobo: Math.round(parseFloat(form.amount_requested_kobo) * 100),
        tenor_months:          parseInt(form.tenor_months),
        purpose:               form.purpose || undefined,
        employer:              form.employer || undefined,
        monthly_income_kobo:   form.monthly_income_kobo
                                 ? Math.round(parseFloat(form.monthly_income_kobo) * 100)
                                 : undefined,
      }
      const res = await apiPost<{ data: { id: string } }>('/api/los', payload)
      nav(`/sales/applications/${res.data.id}`)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Page dept="LOS" title="New Application">
      <div className="max-w-2xl mx-auto">
        {/* Step indicator */}
        <div className="flex items-center gap-0 mb-8">
          {STEPS.map((s, i) => (
            <div key={i} className="flex items-center flex-1 last:flex-none">
              <div className="flex items-center gap-2 shrink-0">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-bold"
                  style={{
                    background: i < step ? '#059669' : i === step ? NAVY : 'rgba(14,40,65,0.08)',
                    color: i <= step ? '#fff' : '#94A3B8',
                  }}
                >
                  {i < step ? <span className="material-symbols-rounded text-[16px]">check</span> : i + 1}
                </div>
                <span className="text-[12px] font-semibold hidden sm:block" style={{ color: i === step ? NAVY : '#94A3B8' }}>
                  {s}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="flex-1 h-px mx-3" style={{ background: i < step ? '#059669' : 'rgba(14,40,65,0.12)' }} />
              )}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-black/[0.06] p-6 shadow-sm">
          <ErrBanner msg={error} />

          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-[16px] font-bold text-slate-800 mb-4">Applicant Details</h2>
              <div>
                <label htmlFor="los-applicant_name" className="block text-[12px] font-semibold text-slate-500 mb-1">Full Name *</label>
                <input id="los-applicant_name" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                  value={form.applicant_name} onChange={e => set('applicant_name', e.target.value)} placeholder="e.g. John Adebayo" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="los-phone" className="block text-[12px] font-semibold text-slate-500 mb-1">Phone Number *</label>
                  <input id="los-phone" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                    value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="08012345678" />
                </div>
                <div>
                  <label htmlFor="los-email" className="block text-[12px] font-semibold text-slate-500 mb-1">Email</label>
                  <input id="los-email" type="email" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                    value={form.email} onChange={e => set('email', e.target.value)} placeholder="john@example.com" />
                </div>
              </div>
              <div>
                <label htmlFor="los-cif" className="block text-[12px] font-semibold text-slate-500 mb-1">CIF Number (if existing customer)</label>
                <input id="los-cif" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                  value={form.cif} onChange={e => set('cif', e.target.value)} placeholder="Leave blank for new customer" />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-[16px] font-bold text-slate-800 mb-4">Product & Loan Details</h2>
              <div>
                <label htmlFor="los-product_type" className="block text-[12px] font-semibold text-slate-500 mb-1">Product Type *</label>
                <select id="los-product_type" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                  value={form.product_type} onChange={e => set('product_type', e.target.value)}>
                  <option value="">Select product…</option>
                  {PRODUCT_TYPES.map(p => <option key={p} value={p}>{snake(p)}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="los-amount" className="block text-[12px] font-semibold text-slate-500 mb-1">Amount Requested (₦) *</label>
                  <input id="los-amount" type="number" min="0" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                    value={form.amount_requested_kobo} onChange={e => set('amount_requested_kobo', e.target.value)} placeholder="500000" />
                  <p className="text-[11px] text-slate-400 mt-0.5">Enter in Naira (e.g. 500000 = ₦500,000)</p>
                </div>
                <div>
                  <label htmlFor="los-tenor" className="block text-[12px] font-semibold text-slate-500 mb-1">Tenor (months) *</label>
                  <input id="los-tenor" type="number" min="1" max="60" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                    value={form.tenor_months} onChange={e => set('tenor_months', e.target.value)} placeholder="12" />
                </div>
              </div>
              <div>
                <label htmlFor="los-purpose" className="block text-[12px] font-semibold text-slate-500 mb-1">Loan Purpose</label>
                <input id="los-purpose" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                  value={form.purpose} onChange={e => set('purpose', e.target.value)} placeholder="e.g. Working capital" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="los-employer" className="block text-[12px] font-semibold text-slate-500 mb-1">Employer / Business</label>
                  <input id="los-employer" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                    value={form.employer} onChange={e => set('employer', e.target.value)} placeholder="Employer name" />
                </div>
                <div>
                  <label htmlFor="los-income" className="block text-[12px] font-semibold text-slate-500 mb-1">Monthly Income (₦)</label>
                  <input id="los-income" type="number" min="0" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                    value={form.monthly_income_kobo} onChange={e => set('monthly_income_kobo', e.target.value)} placeholder="200000" />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-[16px] font-bold text-slate-800 mb-4">Review & Submit</h2>
              <div className="space-y-3">
                {[
                  ['Applicant Name', form.applicant_name],
                  ['Phone', form.phone],
                  ['Email', form.email || '—'],
                  ['CIF', form.cif || '—'],
                  ['Product', snake(form.product_type || '—')],
                  ['Amount Requested', form.amount_requested_kobo ? `₦${parseFloat(form.amount_requested_kobo).toLocaleString()}` : '—'],
                  ['Tenor', form.tenor_months ? `${form.tenor_months} months` : '—'],
                  ['Purpose', form.purpose || '—'],
                  ['Employer', form.employer || '—'],
                  ['Monthly Income', form.monthly_income_kobo ? `₦${parseFloat(form.monthly_income_kobo).toLocaleString()}` : '—'],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-[12px] font-semibold text-slate-500">{k}</span>
                    <span className="text-[13px] text-slate-800 capitalize">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Nav buttons */}
          <div className="flex justify-between mt-6 pt-4 border-t border-slate-100">
            <button
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
              disabled={step === 0}
              onClick={() => setStep(s => s - 1)}
            >
              Back
            </button>
            {step < 2 ? (
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-40"
                style={{ background: NAVY }}
                disabled={!canAdvance()}
                onClick={() => setStep(s => s + 1)}
              >
                Next
              </button>
            ) : (
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}
                disabled={saving}
                onClick={submit}
              >
                {saving ? 'Submitting…' : 'Submit Application'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Page>
  )
}
