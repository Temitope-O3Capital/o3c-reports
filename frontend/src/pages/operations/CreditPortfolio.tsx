import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import {
  Page, KpiCard, SectionCard, DataTable, ColDef,
  DateFilter, AreaChartCard, StatusBadge, ErrBanner, Spinner,
  NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmt, fmtNum, fmtDate, fmtPct, n, today, monthStart } from '../../lib/fmt'

/* ── Types ─────────────────────────────────────────────────────── */

interface Application {
  id: number
  date_received: string
  customer_name: string
  company?: string
  type: 'loan' | 'card'
  requested_amount?: number
  status: string
  approved_amount?: number
  declined_reason?: string
  date_processed?: string
  disbursed_amount?: number
  disbursed_date?: string
  mandate?: string
  loan_id?: string
  tenor?: number
  rate?: number
  repayment_amount?: number
  maturity_date?: string
  location?: string
  account_officer?: string
  introducer?: string
  application_type?: string
  notes?: string
}

interface Repayment {
  id: number
  payment_month: string
  expected_amount?: number
  paid_amount?: number
  payment_date?: string
  dpd?: number
  payment_status: string
  comment?: string
  action_taken?: string
}

interface Collateral {
  id: number
  security_type?: string
  vehicle_info?: string
  last_location?: string
  guarantor_name?: string
  guarantor_phone?: string
  guarantor_email?: string
  guarantor_address?: string
  notes?: string
}

interface Summary {
  total_applications: number
  approved: number
  declined: number
  pending: number
  incomplete: number
  disbursed: number
  total_requested: number
  total_approved: number
  total_disbursed: number
  loan_count: number
  card_count: number
  approval_rate: number
  overdue_loans: number
}

interface OfficerRow {
  account_officer: string
  total: number
  approved: number
  declined: number
  disbursed: number
  total_disbursed: number
}

interface PipelineRow {
  status: string
  type: string
  count: number
  total_approved: number
  total_disbursed: number
}

interface OverdueRow {
  id: number
  customer_name: string
  account_officer?: string
  payment_month: string
  expected_amount?: number
  paid_amount?: number
  dpd?: number
  payment_status: string
  comment?: string
  action_taken?: string
}

/* ── Constants ─────────────────────────────────────────────────── */

const TABS = ['Dashboard', 'Applications', 'Active Loans', 'Collateral', 'Collections']

const APP_STATUSES = ['pending', 'approved', 'declined', 'incomplete', 'disbursed', 'returned', 'written_off']
const LOCATIONS    = ['Lagos', 'Abuja']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const CUR_YEAR     = new Date().getFullYear()
const MONTH_OPTIONS = MONTHS.flatMap(m => [`${m} ${CUR_YEAR}`, `${m} ${CUR_YEAR - 1}`])

/* ── Field helpers ─────────────────────────────────────────────── */

function fld(
  label: string,
  key: keyof Application,
  form: Partial<Application>,
  set: (k: keyof Application, v: string) => void,
  type = 'text',
  opts: React.InputHTMLAttributes<HTMLInputElement> = {},
) {
  return (
    <div>
      <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>
        {label}
      </label>
      <input
        type={type}
        value={(form[key] as string) ?? ''}
        onChange={e => set(key, e.target.value)}
        className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none transition-all"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
        {...opts}
      />
    </div>
  )
}

function sel(
  label: string,
  key: keyof Application,
  options: { value: string; label: string }[],
  form: Partial<Application>,
  set: (k: keyof Application, v: string) => void,
) {
  return (
    <div>
      <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>
        {label}
      </label>
      <select
        value={(form[key] as string) ?? ''}
        onChange={e => set(key, e.target.value)}
        className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function FormSection({ title }: { title: string }) {
  return (
    <div className="col-span-2 mt-4">
      <p className="text-[11px] font-bold uppercase tracking-widest pb-2"
        style={{ color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>
        {title}
      </p>
    </div>
  )
}

/* ── Application Drawer ─────────────────────────────────────────── */

interface AppDrawerProps {
  initial?: Application | null
  onClose: () => void
  onSaved: () => void
}

function AppDrawer({ initial, onClose, onSaved }: AppDrawerProps) {
  const blank: Partial<Application> = {
    date_received: today(), customer_name: '', company: '', type: 'loan',
    requested_amount: undefined, status: 'pending', approved_amount: undefined,
    declined_reason: '', date_processed: '', disbursed_amount: undefined,
    disbursed_date: '', mandate: '', loan_id: '', tenor: undefined, rate: undefined,
    repayment_amount: undefined, maturity_date: '', location: 'Lagos',
    account_officer: '', introducer: '', application_type: 'new', notes: '',
  }
  const [form, setForm] = useState<Partial<Application>>(initial ? { ...blank, ...initial } : blank)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function set(k: keyof Application, v: string) {
    setForm(f => ({ ...f, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setErr('')
    try {
      const payload: Record<string, unknown> = { ...form }
      for (const k of ['requested_amount', 'approved_amount', 'disbursed_amount', 'repayment_amount', 'tenor', 'rate']) {
        const v = payload[k]
        payload[k] = v !== '' && v != null ? Number(v) : null
      }
      for (const k of ['date_processed', 'disbursed_date', 'maturity_date']) {
        if (payload[k] === '') payload[k] = null
      }
      if (initial?.id) {
        await apiPut(`/api/credit-portfolio/applications/${initial.id}`, payload)
      } else {
        await apiPost('/api/credit-portfolio/applications', payload)
      }
      onSaved()
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40" onClick={onClose} style={{ background: 'rgba(0,0,0,0.3)' }}>
      <div className="absolute right-0 top-0 h-full w-[500px] shadow-2xl overflow-y-auto flex flex-col" style={{ background: 'var(--card)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-5 flex-shrink-0" style={{ borderBottom: '1px solid var(--bdr)' }}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[15px] font-semibold" style={{ color: 'var(--txt)' }}>
                {initial?.id ? 'Edit Application' : 'Book New Application'}
              </h3>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>Credit Portfolio</p>
            </div>
            <button onClick={onClose}>
              <span className="material-symbols-rounded text-[20px]" style={{ color: 'var(--txt2)' }}>close</span>
            </button>
          </div>
        </div>

        <form className="flex-1 px-6 py-5 overflow-y-auto" onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-4">
            <FormSection title="Application Details" />
            {fld('Date Received', 'date_received', form, set, 'date')}
            {sel('Type', 'type', [{ value: 'loan', label: 'Loan' }, { value: 'card', label: 'Credit Card' }], form, set)}
            <div className="col-span-2">
              {fld('Customer Name', 'customer_name', form, set, 'text', { required: true, placeholder: 'Full name or company' })}
            </div>
            {fld('Company', 'company', form, set, 'text', { placeholder: 'Employer or business name' })}
            {fld('Requested Amount (₦)', 'requested_amount', form, set, 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {sel('Status', 'status', APP_STATUSES.map(s => ({ value: s, label: snake(s) })), form, set)}
            {sel('Application Type', 'application_type', [{ value: 'new', label: 'New' }, { value: 'return', label: 'Return' }], form, set)}
            {sel('Location', 'location', [{ value: '', label: '— Select —' }, ...LOCATIONS.map(l => ({ value: l, label: l }))], form, set)}
            {fld('Account Officer', 'account_officer', form, set)}
            {fld('Introducer', 'introducer', form, set)}

            <FormSection title="Decision" />
            {fld('Approved Amount (₦)', 'approved_amount', form, set, 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {fld('Date Processed', 'date_processed', form, set, 'date')}
            <div className="col-span-2">
              {fld('Declined Reason', 'declined_reason', form, set, 'text', { placeholder: 'Leave blank if approved' })}
            </div>

            <FormSection title="Disbursement" />
            {fld('Disbursed Amount (₦)', 'disbursed_amount', form, set, 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {fld('Disbursed Date', 'disbursed_date', form, set, 'date')}
            {fld('Loan ID', 'loan_id', form, set, 'text', { placeholder: 'e.g. LOAN/45664395' })}
            {fld('Mandate', 'mandate', form, set)}

            <FormSection title="Loan Terms" />
            {fld('Tenor (months)', 'tenor', form, set, 'number', { placeholder: '0', min: 1 })}
            {fld('Rate (% p.a.)', 'rate', form, set, 'number', { placeholder: '0.00', step: 0.01 })}
            {fld('Monthly Repayment (₦)', 'repayment_amount', form, set, 'number', { placeholder: '0.00', step: 0.01 })}
            {fld('Maturity Date', 'maturity_date', form, set, 'date')}

            <div className="col-span-2 mt-2">
              <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>Notes</label>
              <textarea
                value={form.notes ?? ''}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-y"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
              />
            </div>
          </div>

          {err && <ErrBanner msg={err} />}
        </form>

        <div className="flex-shrink-0 px-6 py-4 flex justify-end gap-3"
          style={{ borderTop: '1px solid var(--bdr)' }}>
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-[13px] font-medium rounded-lg border"
            style={{ color: 'var(--txt2)', borderColor: 'var(--bdr)' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving}
            className="px-4 py-2 text-[13px] font-semibold text-white rounded-lg flex items-center gap-1.5 disabled:opacity-60"
            style={{ background: NAVY }}>
            {saving ? <><Spinner size={14} />Saving…</> : <>{initial?.id ? 'Update' : 'Book Application'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Repayment Modal ────────────────────────────────────────────── */

interface RepaymentModalProps {
  application: Application
  onClose: () => void
  onSaved: () => void
}

function RepaymentModal({ application, onClose, onSaved }: RepaymentModalProps) {
  const [form, setForm] = useState({
    payment_month: MONTH_OPTIONS[new Date().getMonth()],
    expected_amount: String(application.repayment_amount ?? ''),
    paid_amount: '', payment_date: today(),
    payment_status: 'paid', dpd: '', comment: '', action_taken: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function setF(k: string, v: string) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setErr('')
    try {
      const payload = {
        ...form,
        expected_amount: form.expected_amount ? Number(form.expected_amount) : null,
        paid_amount: form.paid_amount ? Number(form.paid_amount) : null,
        dpd: form.dpd ? Number(form.dpd) : 0,
        payment_date: form.payment_date || null,
      }
      await apiPost(`/api/credit-portfolio/applications/${application.id}/repayments`, payload)
      onSaved()
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  const ifield = (label: string, key: string, type = 'text', opts: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={(form as Record<string, string>)[key]} onChange={e => setF(key, e.target.value)}
        className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} {...opts} />
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose} style={{ background: 'rgba(0,0,0,0.35)' }}>
      <div className="rounded-xl shadow-2xl w-full max-w-md p-6" style={{ background: 'var(--card)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-[15px] font-semibold" style={{ color: 'var(--txt)' }}>Record Payment</p>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>{application.customer_name}</p>
          </div>
          <button onClick={onClose}>
            <span className="material-symbols-rounded text-[20px]" style={{ color: 'var(--txt2)' }}>close</span>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>Payment Month</label>
            <select value={form.payment_month} onChange={e => setF('payment_month', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}>
              {MONTH_OPTIONS.map(m => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {ifield('Expected (₦)', 'expected_amount', 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {ifield('Paid (₦)', 'paid_amount', 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {ifield('Payment Date', 'payment_date', 'date')}
            <div>
              <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>Status</label>
              <select value={form.payment_status} onChange={e => setF('payment_status', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}>
                {['pending', 'partial', 'paid', 'overdue'].map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
          {ifield('DPD (Days Past Due)', 'dpd', 'number', { placeholder: '0', min: 0 })}
          {ifield('Comment', 'comment', 'text', { placeholder: 'e.g. Part payment, Restructured' })}
          {err && <ErrBanner msg={err} />}
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-[13px] font-medium rounded-lg border"
              style={{ color: 'var(--txt2)', borderColor: 'var(--bdr)' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-[13px] font-semibold text-white rounded-lg flex items-center gap-1.5 disabled:opacity-60"
              style={{ background: NAVY }}>
              {saving ? <><Spinner size={14} />Saving…</> : 'Record Payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ── Collateral Drawer ──────────────────────────────────────────── */

interface CollateralDrawerProps {
  applicationId: number
  initial?: Collateral | null
  onClose: () => void
  onSaved: () => void
}

function CollateralDrawer({ applicationId, initial, onClose, onSaved }: CollateralDrawerProps) {
  const blank = {
    security_type: '', vehicle_info: '', last_location: '',
    guarantor_name: '', guarantor_phone: '', guarantor_email: '',
    guarantor_address: '', notes: '',
  }
  const [form, setForm] = useState(initial ? { ...blank, ...initial } : blank)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function setF(k: string, v: string) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setErr('')
    try {
      if (initial?.id) {
        await apiPut(`/api/credit-portfolio/collateral/${initial.id}`, form)
      } else {
        await apiPost(`/api/credit-portfolio/applications/${applicationId}/collateral`, form)
      }
      onSaved(); onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const cf = (label: string, key: string) => (
    <div>
      <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>{label}</label>
      <input type="text" value={(form as Record<string, string>)[key] ?? ''} onChange={e => setF(key, e.target.value)}
        className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
    </div>
  )

  return (
    <div className="fixed inset-0 z-40" onClick={onClose} style={{ background: 'rgba(0,0,0,0.3)' }}>
      <div className="absolute right-0 top-0 h-full w-[420px] shadow-2xl overflow-y-auto flex flex-col" style={{ background: 'var(--card)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-5 flex-shrink-0" style={{ borderBottom: '1px solid var(--bdr)' }}>
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--txt)' }}>
              {initial?.id ? 'Edit Security' : 'Add Security / Collateral'}
            </h3>
            <button onClick={onClose}>
              <span className="material-symbols-rounded text-[20px]" style={{ color: 'var(--txt2)' }}>close</span>
            </button>
          </div>
        </div>
        <form className="flex-1 px-6 py-5 space-y-4" onSubmit={handleSubmit}>
          {cf('Security Type', 'security_type')}
          {cf('Vehicle Info', 'vehicle_info')}
          {cf('Last Location', 'last_location')}
          <p className="text-[11px] font-bold uppercase tracking-widest pt-2"
            style={{ color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)', paddingBottom: 6 }}>
            Guarantor
          </p>
          {cf('Guarantor Name', 'guarantor_name')}
          {cf('Guarantor Phone', 'guarantor_phone')}
          {cf('Guarantor Email', 'guarantor_email')}
          {cf('Guarantor Address', 'guarantor_address')}
          <div>
            <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>Notes</label>
            <textarea value={form.notes ?? ''} onChange={e => setF('notes', e.target.value)}
              rows={3} className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-y"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
          </div>
          {err && <ErrBanner msg={err} />}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-[13px] font-medium rounded-lg border"
              style={{ color: 'var(--txt2)', borderColor: 'var(--bdr)' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-[13px] font-semibold text-white rounded-lg flex items-center gap-1.5 disabled:opacity-60"
              style={{ background: NAVY }}>
              {saving ? <><Spinner size={14} />Saving…</> : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ── Tab: Dashboard ─────────────────────────────────────────────── */

function DashboardTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [summary,   setSummary]   = useState<Summary | null>(null)
  const [byOfficer, setByOfficer] = useState<OfficerRow[]>([])
  const [pipeline,  setPipeline]  = useState<PipelineRow[]>([])
  const [loading,   setLoading]   = useState(false)
  const [err,       setErr]       = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = `date_from=${dateFrom}&date_to=${dateTo}`
      const [rSum, rPipe, rOfc] = await Promise.allSettled([
        apiFetch<Summary>(`/api/credit-portfolio/summary?${p}`),
        apiFetch<PipelineRow[]>(`/api/credit-portfolio/pipeline?${p}`),
        apiFetch<OfficerRow[]>(`/api/credit-portfolio/by-officer?${p}`),
      ])
      if (rSum.status === 'fulfilled') setSummary(rSum.value)
      if (rPipe.status === 'fulfilled') setPipeline(Array.isArray(rPipe.value) ? rPipe.value : [])
      if (rOfc.status === 'fulfilled') setByOfficer(Array.isArray(rOfc.value) ? rOfc.value : [])
      if ([rSum, rPipe, rOfc].every(r => r.status === 'rejected')) setErr('Failed to load')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Load failed')
    } finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="flex items-center gap-3 text-[color:var(--txt2)] py-16"><Spinner />Loading dashboard…</div>

  const s = summary
  const approvalRate = n(s?.approval_rate)
  const totalApps    = n(s?.total_applications)

  const byStatusData = APP_STATUSES.map(st => {
    const match = pipeline.find(p => p.status === st)
    return { status: st, count: n(match?.count), total_disbursed: n(match?.total_disbursed) }
  }).filter(p => p.count > 0)

  const officerCols: ColDef<OfficerRow>[] = [
    { key: 'account_officer', label: 'Officer' },
    { key: 'total',           label: 'Applications', right: true, render: r => fmtNum(r.total) },
    { key: 'approved',        label: 'Approved',     right: true, render: r => <span style={{ color: GREEN }}>{fmtNum(r.approved)}</span> },
    { key: 'disbursed',       label: 'Disbursed',    right: true, render: r => <span style={{ color: BLUE }}>{fmtNum(r.disbursed)}</span> },
    { key: 'total_disbursed', label: 'Total Disbursed', right: true, render: r => <span className="font-semibold">{fmt(r.total_disbursed)}</span> },
  ]

  return (
    <div className="space-y-5">
      <ErrBanner msg={err} />
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Applications" value={fmtNum(s?.total_applications)} icon="folder_open" accent={NAVY} loading={!s} />
        <KpiCard label="Approved"           value={fmtNum(s?.approved)}           icon="check_circle" accent={GREEN} loading={!s} />
        <KpiCard label="Declined"           value={fmtNum(s?.declined)}           icon="cancel"       accent={RED}   loading={!s} />
        <KpiCard label="Disbursed"          value={fmtNum(s?.disbursed)}          icon="payments"     accent={BLUE}
          sub={fmt(s?.total_disbursed)} loading={!s} />
        <KpiCard label="Approval Rate"      value={fmtPct(approvalRate)}          icon="percent"      accent="#8B5CF6"
          sub="of all applications" loading={!s} />
        <KpiCard label="Overdue Loans"      value={fmtNum(s?.overdue_loans)}      icon="warning"      accent={RED}    loading={!s} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <SectionCard title="Pipeline by Status" subtitle="Application funnel">
          <div className="px-5 py-4 space-y-3">
            {byStatusData.length === 0
              ? <p className="text-[13px] text-center py-6" style={{ color: 'var(--txt2)' }}>No data in this period</p>
              : byStatusData.map(p => (
                  <div key={p.status}>
                    <div className="flex justify-between mb-1.5">
                      <StatusBadge status={p.status} />
                      <span className="text-[12px] font-semibold text-[color:var(--txt)] tabular-nums">{fmtNum(p.count)}</span>
                    </div>
                    <div className="h-1.5 rounded-full" style={{ background: 'var(--chip-bg)' }}>
                      <div className="h-full rounded-full" style={{
                        width: `${totalApps > 0 ? (p.count / totalApps) * 100 : 0}%`,
                        background: NAVY,
                      }} />
                    </div>
                  </div>
                ))}
          </div>
        </SectionCard>

        <div className="lg:col-span-2">
          <SectionCard title="Account Officer Performance" subtitle="Applications, approvals and disbursements">
            <DataTable cols={officerCols} rows={byOfficer.slice(0, 10)} emptyMsg="No officer data" />
          </SectionCard>
        </div>
      </div>
    </div>
  )
}

/* ── Tab: Applications ──────────────────────────────────────────── */

interface ApplicationsTabProps {
  typeFilter?: 'loan' | null
  dateFrom: string
  dateTo: string
  label: string
}

function ApplicationsTab({ typeFilter, dateFrom, dateTo, label }: ApplicationsTabProps) {
  const [apps,     setApps]     = useState<Application[]>([])
  const [total,    setTotal]    = useState(0)
  const [loading,  setLoading]  = useState(false)
  const [err,      setErr]      = useState('')
  const [offset,   setOffset]   = useState(0)
  const [search,   setSearch]   = useState('')
  const [status,   setStatus]   = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editApp,    setEditApp]    = useState<Application | null>(null)
  const [repayApp,   setRepayApp]   = useState<Application | null>(null)
  const LIMIT = 100

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = new URLSearchParams({ limit: String(LIMIT), offset: String(offset), date_from: dateFrom, date_to: dateTo })
      if (typeFilter) p.set('type', typeFilter)
      if (status)     p.set('status', status)
      if (search)     p.set('q', search)
      const data = await apiFetch<{ data: Application[]; total: number }>(`/api/credit-portfolio/applications?${p}`)
      setApps(Array.isArray(data.data) ? data.data : [])
      setTotal(Number(data.total ?? 0))
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Load failed')
    } finally { setLoading(false) }
  }, [typeFilter, dateFrom, dateTo, status, search, offset])

  useEffect(() => { load() }, [load])

  async function deleteApp(id: number) {
    if (!confirm('Delete this application?')) return
    await apiDelete(`/api/credit-portfolio/applications/${id}`)
    load()
  }

  const cols: ColDef<Application>[] = [
    { key: 'date_received',  label: 'Date',      render: r => <span className="text-[12px] text-[color:var(--txt2)] whitespace-nowrap">{fmtDate(r.date_received)}</span> },
    { key: 'customer_name',  label: 'Customer',  render: r => (
      <div>
        <p className="text-[13px] font-medium text-[color:var(--txt)] max-w-[140px] truncate">{r.customer_name}</p>
        {r.company && <p className="text-[11px] text-[color:var(--txt2)] truncate max-w-[140px]">{r.company}</p>}
      </div>
    )},
    { key: 'status',         label: 'Status',    render: r => <StatusBadge status={r.status} /> },
    { key: 'requested_amount', label: 'Requested', right: true, render: r => <span className="tabular-nums text-[13px]">{r.requested_amount ? fmt(r.requested_amount) : '—'}</span> },
    { key: 'approved_amount',  label: 'Approved',  right: true, render: r => <span className="tabular-nums text-[13px]" style={{ color: GREEN }}>{r.approved_amount ? fmt(r.approved_amount) : '—'}</span> },
    { key: 'disbursed_amount', label: 'Disbursed', right: true, render: r => <span className="tabular-nums text-[13px] font-semibold" style={{ color: BLUE }}>{r.disbursed_amount ? fmt(r.disbursed_amount) : '—'}</span> },
    { key: 'account_officer',  label: 'Officer',   render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.account_officer || '—'}</span> },
    { key: 'location',         label: 'Location',  render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.location || '—'}</span> },
    { key: 'maturity_date',    label: 'Maturity',  render: r => <span className="text-[12px] text-[color:var(--txt2)] whitespace-nowrap">{r.maturity_date ? fmtDate(r.maturity_date) : '—'}</span> },
    { key: '_actions', label: '', sortable: false, render: r => (
      <div className="flex items-center gap-1">
        {(r.status === 'disbursed' || r.status === 'approved') && r.type === 'loan' && (
          <button onClick={() => setRepayApp(r)} title="Record payment"
            className="p-1 rounded hover:bg-[var(--chip-bg)]" style={{ color: GREEN }}>
            <span className="material-symbols-rounded text-[16px]">payments</span>
          </button>
        )}
        <button onClick={() => { setEditApp(r); setDrawerOpen(true) }} title="Edit"
          className="p-1 rounded hover:bg-[var(--chip-bg)] text-[color:var(--txt2)]">
          <span className="material-symbols-rounded text-[16px]">edit</span>
        </button>
        <button onClick={() => deleteApp(r.id)} title="Delete"
          className="p-1 rounded hover:bg-[var(--chip-bg)]" style={{ color: RED }}>
          <span className="material-symbols-rounded text-[16px]">delete</span>
        </button>
      </div>
    )},
  ]

  return (
    <div>
      <ErrBanner msg={err} />
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <span className="material-symbols-rounded absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-[color:var(--txt2)] pointer-events-none">search</span>
            <input
              className="pl-8 pr-3 py-1.5 rounded-lg border text-[13px] outline-none w-52"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
              placeholder="Customer, company, loan ID…"
              value={search}
              onChange={e => { setSearch(e.target.value); setOffset(0) }}
            />
          </div>
          <select value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }}
            className="px-3 py-1.5 rounded-lg border text-[13px] outline-none"
            style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: status ? NAVY : 'var(--txt2)' }}>
            <option value="">All Statuses</option>
            {APP_STATUSES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
          </select>
        </div>
        <button onClick={() => { setEditApp(null); setDrawerOpen(true) }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[17px]">add</span>
          Book {label}
        </button>
      </div>

      <SectionCard title={`${total.toLocaleString()} records`}>
        <DataTable cols={cols} rows={apps} loading={loading} emptyIcon="folder_open" emptyMsg="No applications found" />
        {total > LIMIT && (
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid var(--bdr)' }}>
            <p className="text-[12px]" style={{ color: 'var(--txt2)' }}>Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}</p>
            <div className="flex gap-2">
              <button onClick={() => setOffset(o => Math.max(0, o - LIMIT))} disabled={offset === 0}
                className="p-1.5 rounded-lg border disabled:opacity-40" style={{ borderColor: 'var(--bdr)' }}>
                <span className="material-symbols-rounded text-[16px]">chevron_left</span>
              </button>
              <button onClick={() => setOffset(o => o + LIMIT)} disabled={offset + LIMIT >= total}
                className="p-1.5 rounded-lg border disabled:opacity-40" style={{ borderColor: 'var(--bdr)' }}>
                <span className="material-symbols-rounded text-[16px]">chevron_right</span>
              </button>
            </div>
          </div>
        )}
      </SectionCard>

      {drawerOpen && (
        <AppDrawer
          initial={editApp}
          onClose={() => { setDrawerOpen(false); setEditApp(null) }}
          onSaved={() => { load() }}
        />
      )}
      {repayApp && (
        <RepaymentModal
          application={repayApp}
          onClose={() => setRepayApp(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}

/* ── Tab: Collateral ────────────────────────────────────────────── */

function CollateralTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [apps,       setApps]       = useState<Application[]>([])
  const [loading,    setLoading]    = useState(false)
  const [err,        setErr]        = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selApp,     setSelApp]     = useState<Application | null>(null)
  const [collateral, setCollateral] = useState<Collateral[]>([])
  const [colLoading, setColLoading] = useState(false)
  const [editCol,    setEditCol]    = useState<Collateral | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const data = await apiFetch<{ data: Application[] }>(`/api/credit-portfolio/applications?status=disbursed&limit=200&date_from=${dateFrom}&date_to=${dateTo}`)
      setApps(Array.isArray(data.data) ? data.data : [])
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Load failed')
    } finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function loadCollateral(app: Application) {
    setSelApp(app); setColLoading(true)
    try {
      const rows = await apiFetch<Collateral[]>(`/api/credit-portfolio/applications/${app.id}/collateral`)
      setCollateral(Array.isArray(rows) ? rows : [])
    } finally { setColLoading(false) }
  }

  async function deleteCollateral(cid: number) {
    if (!confirm('Delete this collateral record?')) return
    await apiDelete(`/api/credit-portfolio/collateral/${cid}`)
    if (selApp) loadCollateral(selApp)
  }

  const appCols: ColDef<Application>[] = [
    { key: 'customer_name',  label: 'Customer',  render: r => <span className="font-medium text-[color:var(--txt)]">{r.customer_name}</span> },
    { key: 'disbursed_amount', label: 'Disbursed', right: true, render: r => <span className="font-semibold tabular-nums">{fmt(r.disbursed_amount)}</span> },
    { key: 'maturity_date',  label: 'Maturity',  render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.maturity_date ? fmtDate(r.maturity_date) : '—'}</span> },
    { key: 'account_officer', label: 'Officer',  render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.account_officer || '—'}</span> },
    { key: 'loan_id',        label: 'Loan ID',   render: r => <span className="font-mono text-[12px] text-[color:var(--txt2)]">{r.loan_id || '—'}</span> },
    { key: '_view', label: '', sortable: false, render: r => (
      <button onClick={() => loadCollateral(r)}
        className="flex items-center gap-1 text-[12px] font-medium px-3 py-1 rounded-lg border"
        style={{ borderColor: 'var(--bdr)', color: NAVY }}>
        <span className="material-symbols-rounded text-[14px]">security</span>
        Security
      </button>
    )},
  ]

  const colCols: ColDef<Collateral>[] = [
    { key: 'security_type',   label: 'Type',           render: r => <span className="text-[13px]">{r.security_type || '—'}</span> },
    { key: 'vehicle_info',    label: 'Vehicle',         render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.vehicle_info || '—'}</span> },
    { key: 'guarantor_name',  label: 'Guarantor',       render: r => <span className="text-[13px]">{r.guarantor_name || '—'}</span> },
    { key: 'guarantor_phone', label: 'Guarantor Phone', render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.guarantor_phone || '—'}</span> },
    { key: 'notes',           label: 'Notes',           render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.notes || '—'}</span> },
    { key: '_actions', label: '', sortable: false, render: r => (
      <div className="flex gap-1">
        <button onClick={() => { setEditCol(r); setDrawerOpen(true) }} className="p-1 rounded hover:bg-[var(--chip-bg)] text-[color:var(--txt2)]">
          <span className="material-symbols-rounded text-[16px]">edit</span>
        </button>
        <button onClick={() => deleteCollateral(r.id)} className="p-1 rounded hover:bg-[var(--chip-bg)]" style={{ color: RED }}>
          <span className="material-symbols-rounded text-[16px]">delete</span>
        </button>
      </div>
    )},
  ]

  return (
    <div className="space-y-5">
      <ErrBanner msg={err} />
      <SectionCard title="Disbursed Loans" subtitle="Click Security to view and manage collateral for each loan">
        <DataTable cols={appCols} rows={apps} loading={loading} emptyIcon="security" emptyMsg="No disbursed loans in this period" />
      </SectionCard>

      {selApp && (
        <SectionCard
          title={`Security — ${selApp.customer_name}`}
          subtitle={selApp.loan_id || ''}
          actions={
            <button onClick={() => { setEditCol(null); setDrawerOpen(true) }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white"
              style={{ background: NAVY }}>
              <span className="material-symbols-rounded text-[15px]">add</span>Add Security
            </button>
          }
        >
          {colLoading
            ? <div className="px-5 py-6 flex items-center gap-2 text-[color:var(--txt2)]"><Spinner />Loading…</div>
            : <DataTable cols={colCols} rows={collateral} emptyIcon="lock" emptyMsg="No collateral records" />
          }
        </SectionCard>
      )}

      {drawerOpen && selApp && (
        <CollateralDrawer
          applicationId={selApp.id}
          initial={editCol}
          onClose={() => { setDrawerOpen(false); setEditCol(null) }}
          onSaved={() => { if (selApp) loadCollateral(selApp) }}
        />
      )}
    </div>
  )
}

/* ── Tab: Collections ───────────────────────────────────────────── */

function CollectionsTab() {
  const [rows,    setRows]    = useState<OverdueRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err,     setErr]     = useState('')
  const [repayApp, setRepayApp] = useState<Application | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const data = await apiFetch<OverdueRow[]>('/api/credit-portfolio/overdue')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Load failed')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const cols: ColDef<OverdueRow>[] = [
    { key: 'customer_name', label: 'Customer', render: r => (
      <div>
        <p className="font-medium text-[color:var(--txt)] text-[13px]">{r.customer_name}</p>
        {r.account_officer && <p className="text-[11px] text-[color:var(--txt2)]">{r.account_officer}</p>}
      </div>
    )},
    { key: 'payment_month',   label: 'Month',    render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.payment_month}</span> },
    { key: 'expected_amount', label: 'Expected',  right: true, render: r => <span className="tabular-nums text-[13px]">{fmt(r.expected_amount)}</span> },
    { key: 'paid_amount',     label: 'Paid',      right: true, render: r => (
      <span className="tabular-nums text-[13px] font-semibold"
        style={{ color: n(r.paid_amount) >= n(r.expected_amount) ? GREEN : RED }}>
        {fmt(r.paid_amount)}
      </span>
    )},
    { key: 'dpd', label: 'DPD', render: r => (
      <span className="font-bold tabular-nums"
        style={{ color: n(r.dpd) > 30 ? RED : AMBER }}>
        {n(r.dpd) > 0 ? `${r.dpd}d` : '—'}
      </span>
    )},
    { key: 'payment_status', label: 'Status',  render: r => <StatusBadge status={r.payment_status} /> },
    { key: 'comment',        label: 'Comment', render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.comment || '—'}</span> },
    { key: 'action_taken',   label: 'Action',  render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.action_taken || '—'}</span> },
    { key: '_pay', label: '', sortable: false, render: r => (
      <button onClick={() => setRepayApp(r as unknown as Application)}
        className="flex items-center gap-1 text-[12px] font-medium px-2.5 py-1 rounded-lg"
        style={{ background: 'rgba(5,150,105,0.1)', color: GREEN }}>
        <span className="material-symbols-rounded text-[14px]">payments</span>
        Record
      </button>
    )},
  ]

  return (
    <div>
      <ErrBanner msg={err} />
      <SectionCard
        title="Overdue Accounts"
        subtitle="Loans with DPD > 0 or overdue payment status"
        badge={rows.length > 0 ? `${rows.length} overdue` : undefined}
      >
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="check_circle" emptyMsg="No overdue accounts" />
      </SectionCard>

      {repayApp && (
        <RepaymentModal
          application={repayApp}
          onClose={() => setRepayApp(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}

/* ── Main Page ──────────────────────────────────────────────────── */

export default function CreditPortfolio() {
  const [tab,      setTab]      = useState(0)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  return (
    <Page
      dept="Operations"
      title="Credit Portfolio"
      subtitle="Loan and credit card applications, repayments, collateral, and collections"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
      }
    >
      {/* Tab header */}
      <div className="flex gap-0 mb-5 border-b" style={{ borderColor: 'var(--bdr)' }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)}
            className="px-4 py-2.5 text-[13px] font-medium transition-colors"
            style={{
              borderBottom: tab === i ? `2px solid ${NAVY}` : '2px solid transparent',
              color: tab === i ? NAVY : 'var(--txt2)',
              marginBottom: '-1px',
            }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 0 && <DashboardTab   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 1 && <ApplicationsTab typeFilter={null}   dateFrom={dateFrom} dateTo={dateTo} label="Application" />}
      {tab === 2 && <ApplicationsTab typeFilter="loan"   dateFrom={dateFrom} dateTo={dateTo} label="Loan" />}
      {tab === 3 && <CollateralTab   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 4 && <CollectionsTab />}
    </Page>
  )
}
