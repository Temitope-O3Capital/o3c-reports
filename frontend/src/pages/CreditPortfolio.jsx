import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { InfoTooltip, fmtNum } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem, CHIP_OFF, CHIP_ON, toISO, fmtDate, presetRange } from '../components/FilterBar.jsx'

/* ══════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════ */

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function today() { return toISO(new Date()) }
function thisMonthRange() {
  const d = new Date()
  return [toISO(new Date(d.getFullYear(), d.getMonth(), 1)), toISO(d)]
}

function n(v) { return Number(v || 0) }

function fmtAmt(v) {
  const x = n(v)
  if (Math.abs(x) >= 1_000_000_000) return '₦' + (x / 1_000_000_000).toFixed(2) + 'B'
  if (Math.abs(x) >= 1_000_000)     return '₦' + (x / 1_000_000).toFixed(2) + 'M'
  if (Math.abs(x) >= 1_000)         return '₦' + (x / 1_000).toFixed(1) + 'K'
  return '₦' + x.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtExact(v) {
  return '₦' + n(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDateShort(s) {
  if (!s) return '—'
  try { return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return s }
}

const STATUS_META = {
  pending:    { color: '#F59E0B', bg: '#FFFBEB', label: 'Pending' },
  approved:   { color: '#059669', bg: '#F0FDF4', label: 'Approved' },
  declined:   { color: '#C00000', bg: '#FEF2F2', label: 'Declined' },
  incomplete: { color: '#8B5CF6', bg: '#F5F3FF', label: 'Incomplete' },
  disbursed:  { color: '#0891B2', bg: '#ECFEFF', label: 'Disbursed' },
  returned:   { color: '#64748B', bg: '#F8FAFC', label: 'Returned' },
  written_off:{ color: '#1E293B', bg: '#F1F5F9', label: 'Written Off' },
}

const PMT_STATUS_META = {
  pending:     { color: '#94A3B8', bg: '#F8FAFC'  },
  partial:     { color: '#F59E0B', bg: '#FFFBEB'  },
  paid:        { color: '#059669', bg: '#F0FDF4'  },
  overdue:     { color: '#C00000', bg: '#FEF2F2'  },
  restructured:{ color: '#8B5CF6', bg: '#F5F3FF'  },
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { color: '#64748B', bg: '#F8FAFC', label: status }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: m.bg, color: m.color, whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  )
}

function TypeBadge({ type }) {
  const isCard = (type || '').toLowerCase() === 'card'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
      background: isCard ? '#EFF6FF' : '#FFF7ED',
      color: isCard ? '#2563EB' : '#C2410C',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>
        {isCard ? 'credit_card' : 'account_balance'}
      </span>
      {isCard ? 'Card' : 'Loan'}
    </span>
  )
}

/* ══════════════════════════════════════════════════════════════════
   KPI
   ══════════════════════════════════════════════════════════════════ */

function KPI({ label, value, sub, icon, accent = '#0E2841', valueColor, tooltip }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: valueColor || 'rgb(var(--fg-1))' }}>
        {value}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   APPLICATION FORM (drawer-style modal)
   ══════════════════════════════════════════════════════════════════ */

const LOCATIONS = ['Lagos', 'Abuja']
const STATUSES  = ['pending', 'approved', 'declined', 'incomplete', 'disbursed', 'returned', 'written_off']
const APP_TYPES = ['new', 'return']

function ApplicationForm({ initial, onSave, onClose }) {
  const [form, setForm] = useState({
    date_received: today(), customer_name: '', company: '', type: 'loan',
    requested_amount: '', status: 'pending', approved_amount: '', declined_reason: '',
    date_processed: '', disbursed_amount: '', disbursed_date: '',
    mandate: '', loan_id: '', tenor: '', rate: '', repayment_amount: '',
    maturity_date: '', location: 'Lagos', account_officer: '', introducer: '',
    application_type: 'new', notes: '',
    ...initial,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const payload = { ...form }
      // convert numeric strings
      for (const k of ['requested_amount','approved_amount','disbursed_amount','repayment_amount','tenor','rate']) {
        if (payload[k] === '') payload[k] = null
        else payload[k] = Number(payload[k])
      }
      // nullify empty date strings
      for (const k of ['date_processed','disbursed_date','maturity_date']) {
        if (payload[k] === '') payload[k] = null
      }
      const url = initial?.id
        ? `/api/credit-portfolio/applications/${initial.id}`
        : '/api/credit-portfolio/applications'
      const method = initial?.id ? 'PUT' : 'POST'
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}${url}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Save failed')
      }
      const saved = await res.json()
      onSave(saved)
    } catch(e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const inp = (label, key, type = 'text', opts = {}) => (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</label>
      <input type={type} className="form-input w-full" style={{ height: 34, fontSize: 13 }}
        value={form[key] ?? ''} onChange={e => set(key, e.target.value)} {...opts} />
    </div>
  )

  const sel = (label, key, options) => (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</label>
      <select className="form-input w-full" style={{ height: 34, fontSize: 13 }}
        value={form[key] ?? ''} onChange={e => set(key, e.target.value)}>
        {options.map(o => (
          <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div style={{ flex: 1, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)' }} />
      <div className="flex flex-col h-full overflow-y-auto" style={{ width: 520, background: 'rgb(var(--bg-surface))', boxShadow: '-4px 0 32px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-5 flex-shrink-0" style={{ borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
          <div>
            <p className="text-base font-semibold text-slate-900 dark:text-white">
              {initial?.id ? 'Edit Application' : 'Book New Application'}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">Credit Portfolio</p>
          </div>
          <button onClick={onClose} className="btn-icon">
            <span className="material-symbols-rounded text-[20px]">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            {/* Section: Basic */}
            <div className="col-span-2">
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgb(var(--fg-3))', marginBottom: 12, borderBottom: '1px solid rgb(var(--border) / 0.1)', paddingBottom: 6 }}>
                Application Details
              </p>
            </div>
            {inp('Date Received', 'date_received', 'date')}
            {sel('Type', 'type', [{ value: 'loan', label: 'Loan' }, { value: 'card', label: 'Credit Card' }])}
            <div className="col-span-2">{inp('Customer Name', 'customer_name', 'text', { required: true, placeholder: 'Full name or company' })}</div>
            {inp('Company', 'company', 'text', { placeholder: 'Employer or business name' })}
            {inp('Requested Amount (₦)', 'requested_amount', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}
            {sel('Status', 'status', STATUSES.map(s => ({ value: s, label: STATUS_META[s]?.label || s })))}
            {sel('Application Type', 'application_type', APP_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })))}
            {sel('Location', 'location', ['', ...LOCATIONS].map(l => ({ value: l, label: l || '— Select —' })))}
            {inp('Account Officer', 'account_officer', 'text')}
            {inp('Introducer', 'introducer', 'text')}

            {/* Section: Decision */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgb(var(--fg-3))', marginBottom: 12, borderBottom: '1px solid rgb(var(--border) / 0.1)', paddingBottom: 6 }}>
                Decision
              </p>
            </div>
            {inp('Approved Amount (₦)', 'approved_amount', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}
            {inp('Date Processed', 'date_processed', 'date')}
            <div className="col-span-2">{inp('Declined Reason', 'declined_reason', 'text', { placeholder: 'Leave blank if approved' })}</div>

            {/* Section: Disbursement */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgb(var(--fg-3))', marginBottom: 12, borderBottom: '1px solid rgb(var(--border) / 0.1)', paddingBottom: 6 }}>
                Disbursement
              </p>
            </div>
            {inp('Disbursed Amount (₦)', 'disbursed_amount', 'number', { placeholder: '0.00', min: 0, step: '0.01' })}
            {inp('Disbursed Date', 'disbursed_date', 'date')}
            {inp('Loan ID', 'loan_id', 'text', { placeholder: 'e.g. LOAN/45664395' })}
            {inp('Mandate', 'mandate', 'text')}

            {/* Section: Loan Terms */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgb(var(--fg-3))', marginBottom: 12, borderBottom: '1px solid rgb(var(--border) / 0.1)', paddingBottom: 6 }}>
                Loan Terms
              </p>
            </div>
            {inp('Tenor (months)', 'tenor', 'number', { placeholder: '0', min: 1 })}
            {inp('Rate (% p.a.)', 'rate', 'number', { placeholder: '0.00', step: '0.01' })}
            {inp('Monthly Repayment (₦)', 'repayment_amount', 'number', { placeholder: '0.00', step: '0.01' })}
            {inp('Maturity Date', 'maturity_date', 'date')}

            {/* Notes */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Notes</label>
              <textarea className="form-input w-full" rows={3} style={{ fontSize: 13, resize: 'vertical' }}
                value={form.notes ?? ''} onChange={e => set('notes', e.target.value)} />
            </div>
          </div>

          {error && (
            <div className="mt-4 p-3 rounded-lg text-sm" style={{ background: '#FEF2F2', color: '#C00000', border: '1px solid #FECACA' }}>
              {error}
            </div>
          )}
        </form>

        <div className="flex-shrink-0 px-6 py-4 flex justify-end gap-3" style={{ borderTop: '1px solid rgb(var(--border) / 0.1)' }}>
          <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="btn btn-primary gap-2 disabled:opacity-60">
            {saving ? <><div className="spinner" style={{ width: 13, height: 13, borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.25)' }} />Saving…</>
              : <><span className="material-symbols-rounded text-[17px]">save</span>{initial?.id ? 'Update' : 'Book Application'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   REPAYMENT MODAL
   ══════════════════════════════════════════════════════════════════ */

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const CUR_YEAR = new Date().getFullYear()
const MONTH_OPTIONS = MONTHS.flatMap(m => [`${m} ${CUR_YEAR}`, `${m} ${CUR_YEAR - 1}`])

function RepaymentModal({ application, onClose, onSaved }) {
  const [form, setForm] = useState({
    payment_month: MONTH_OPTIONS[new Date().getMonth()],
    expected_amount: application?.repayment_amount || '',
    paid_amount: '', payment_date: today(),
    payment_status: 'paid', dpd: '', comment: '', action_taken: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const payload = {
        ...form,
        expected_amount: form.expected_amount ? Number(form.expected_amount) : null,
        paid_amount: form.paid_amount ? Number(form.paid_amount) : null,
        dpd: form.dpd ? Number(form.dpd) : 0,
        payment_date: form.payment_date || null,
      }
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}/api/credit-portfolio/applications/${application.id}/repayments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Failed')
      onSaved(); onClose()
    } catch(e) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}
      style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)' }}>
      <div className="card p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-base font-semibold text-slate-900 dark:text-white">Record Payment</p>
            <p className="text-xs text-slate-400 mt-0.5">{application?.customer_name}</p>
          </div>
          <button onClick={onClose} className="btn-icon"><span className="material-symbols-rounded text-[20px]">close</span></button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Payment Month</label>
            <select className="form-input w-full" style={{ height: 34, fontSize: 13 }}
              value={form.payment_month} onChange={e => set('payment_month', e.target.value)}>
              {MONTH_OPTIONS.map(m => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Expected (₦)</label>
              <input type="number" className="form-input w-full" style={{ height: 34, fontSize: 13 }} min={0} step="0.01"
                value={form.expected_amount} onChange={e => set('expected_amount', e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Paid (₦)</label>
              <input type="number" className="form-input w-full" style={{ height: 34, fontSize: 13 }} min={0} step="0.01"
                value={form.paid_amount} onChange={e => set('paid_amount', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Payment Date</label>
              <input type="date" className="form-input w-full" style={{ height: 34, fontSize: 13 }}
                value={form.payment_date} onChange={e => set('payment_date', e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Status</label>
              <select className="form-input w-full" style={{ height: 34, fontSize: 13 }}
                value={form.payment_status} onChange={e => set('payment_status', e.target.value)}>
                {Object.entries(PMT_STATUS_META).map(([k]) => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>DPD (Days Past Due)</label>
            <input type="number" className="form-input w-full" style={{ height: 34, fontSize: 13 }} min={0}
              value={form.dpd} onChange={e => set('dpd', e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Comment</label>
            <input type="text" className="form-input w-full" style={{ height: 34, fontSize: 13 }}
              value={form.comment} onChange={e => set('comment', e.target.value)}
              placeholder="e.g. Part payment, Restructured" />
          </div>
          {error && <p style={{ fontSize: 12, color: '#C00000' }}>{error}</p>}
          <div className="flex justify-end gap-3 mt-1">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary gap-2 disabled:opacity-60">
              {saving ? 'Saving…' : <><span className="material-symbols-rounded text-[17px]">save</span>Record Payment</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'dashboard',    label: 'Dashboard',    icon: 'dashboard' },
  { key: 'applications', label: 'Applications', icon: 'folder_open' },
  { key: 'loans',        label: 'Active Loans', icon: 'account_balance' },
  { key: 'cards',        label: 'Credit Cards', icon: 'credit_card' },
  { key: 'collateral',   label: 'Collateral',   icon: 'security' },
  { key: 'overdue',      label: 'Collections',  icon: 'warning' },
]

/* ── Dashboard ── */
function DashboardTab({ dateFrom, dateTo }) {
  const [summary,    setSummary]    = useState(null)
  const [pipeline,   setPipeline]   = useState([])
  const [byOfficer,  setByOfficer]  = useState([])
  const [loading,    setLoading]    = useState(false)

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const p = `date_from=${dateFrom}&date_to=${dateTo}`
      const [sum, pipe, ofc] = await Promise.all([
        apiFetch(`/api/credit-portfolio/summary?${p}`),
        apiFetch(`/api/credit-portfolio/pipeline?${p}`),
        apiFetch(`/api/credit-portfolio/by-officer?${p}`),
      ])
      setSummary(sum); setPipeline(Array.isArray(pipe) ? pipe : [])
      setByOfficer(Array.isArray(ofc) ? ofc : [])
    } finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="flex items-center gap-3 text-slate-400 py-12"><div className="spinner" />Loading…</div>
  if (!summary) return null

  const s = summary
  const approvalRate = n(s.approval_rate).toFixed(1)
  const pipelineByStatus = STATUSES.map(st => {
    const match = pipeline.find(p => p.status === st)
    return { status: st, ...STATUS_META[st], count: n(match?.count), total_approved: n(match?.total_approved), total_disbursed: n(match?.total_disbursed) }
  }).filter(p => p.count > 0)

  return (
    <div>
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-4 mb-5">
        <KPI label="Total Applications" value={fmtNum(s.total_applications)} icon="folder_open" accent="#0E2841" />
        <KPI label="Approved" value={fmtNum(s.approved)} icon="check_circle" accent="#059669" valueColor="#059669" />
        <KPI label="Declined" value={fmtNum(s.declined)} icon="cancel" accent="#C00000" valueColor="#C00000" />
        <KPI label="Disbursed" value={fmtNum(s.disbursed)} icon="payments" accent="#0891B2"
          sub={fmtAmt(s.total_disbursed)} />
        <KPI label="Approval Rate" value={`${approvalRate}%`} icon="percent" accent="#8B5CF6"
          valueColor={Number(approvalRate) >= 50 ? '#059669' : '#D97706'} />
        <KPI label="Overdue Loans" value={fmtNum(s.overdue_loans)} icon="warning" accent="#C00000"
          valueColor={n(s.overdue_loans) > 0 ? '#C00000' : 'rgb(var(--fg-1))'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        {/* Pipeline funnel */}
        <div className="card p-5 lg:col-span-1">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>Pipeline by Status</p>
          <div className="flex flex-col gap-3">
            {pipelineByStatus.map(p => (
              <div key={p.status}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: p.color }}>{p.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--fg-1))' }}>{fmtNum(p.count)}</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'rgb(var(--bg-subtle))', overflow: 'hidden' }}>
                  <div style={{ width: `${n(s.total_applications) > 0 ? (p.count / n(s.total_applications)) * 100 : 0}%`, height: '100%', background: p.color, borderRadius: 3 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* By Officer */}
        <div className="card overflow-hidden lg:col-span-2">
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Account Officer Performance</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Officer</th>
                  <th className="text-right">Applications</th>
                  <th className="text-right">Approved</th>
                  <th className="text-right">Disbursed</th>
                  <th className="text-right">Total Disbursed</th>
                </tr>
              </thead>
              <tbody>
                {byOfficer.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-8 text-slate-400 text-sm">No data</td></tr>
                ) : byOfficer.slice(0, 10).map((o, i) => (
                  <tr key={i}>
                    <td className="font-medium text-slate-800 dark:text-slate-100">{o.account_officer || '—'}</td>
                    <td className="text-right tabular-nums">{fmtNum(o.total)}</td>
                    <td className="text-right tabular-nums" style={{ color: '#059669' }}>{fmtNum(o.approved)}</td>
                    <td className="text-right tabular-nums" style={{ color: '#0891B2' }}>{fmtNum(o.disbursed)}</td>
                    <td className="text-right tabular-nums font-semibold">{fmtAmt(o.total_disbursed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Applications / Loans / Cards shared table ── */
function ApplicationsTab({ type, dateFrom, dateTo }) {
  const [apps,    setApps]    = useState([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(false)
  const [offset,  setOffset]  = useState(0)
  const [status,  setStatus]  = useState('')
  const [location, setLocation] = useState('')
  const [search,  setSearch]  = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editApp, setEditApp]  = useState(null)
  const [repayApp, setRepayApp] = useState(null)
  const LIMIT = 100

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ limit: LIMIT, offset, date_from: dateFrom, date_to: dateTo })
      if (type)     p.set('type', type)
      if (status)   p.set('status', status)
      if (location) p.set('location', location)
      if (search)   p.set('q', search)
      const data = await apiFetch(`/api/credit-portfolio/applications?${p}`)
      setApps(Array.isArray(data.data) ? data.data : [])
      setTotal(Number(data.total || 0))
    } finally { setLoading(false) }
  }, [type, dateFrom, dateTo, status, location, search, offset])

  useEffect(() => { load() }, [load])

  async function deleteApp(id) {
    if (!confirm('Delete this application?')) return
    const token = localStorage.getItem('o3c_token')
    await fetch(`${API}/api/credit-portfolio/applications/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
    })
    load()
  }

  const typeLabel = type === 'loan' ? 'Loan' : type === 'card' ? 'Card' : 'Application'

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div style={{ position: 'relative' }}>
            <span className="material-symbols-rounded" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: 'rgb(var(--fg-3))', pointerEvents: 'none' }}>search</span>
            <input className="form-input" style={{ paddingLeft: 30, height: 34, fontSize: 13, width: 200 }}
              placeholder="Customer, company, loan ID…"
              value={search} onChange={e => { setSearch(e.target.value); setOffset(0) }} />
          </div>
          <FilterChip label={status ? (STATUS_META[status]?.label || status) : 'Status'} active={!!status} onClear={() => { setStatus(''); setOffset(0) }}>
            <DropItem label="All Statuses" selected={!status} onClick={() => { setStatus(''); setOffset(0) }} />
            {STATUSES.map(s => <DropItem key={s} label={STATUS_META[s]?.label || s} selected={status === s} onClick={() => { setStatus(s); setOffset(0) }} />)}
          </FilterChip>
          <FilterChip label={location || 'Location'} active={!!location} onClear={() => { setLocation(''); setOffset(0) }}>
            <DropItem label="All Locations" selected={!location} onClick={() => { setLocation(''); setOffset(0) }} />
            {LOCATIONS.map(l => <DropItem key={l} label={l} selected={location === l} onClick={() => { setLocation(l); setOffset(0) }} />)}
          </FilterChip>
        </div>
        <button onClick={() => { setEditApp(null); setFormOpen(true) }} className="btn btn-primary gap-2">
          <span className="material-symbols-rounded text-[17px]">add</span>
          Book {typeLabel}
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{total.toLocaleString()} records</p>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                {!type && <th>Type</th>}
                <th>Status</th>
                <th className="text-right">Requested</th>
                <th className="text-right">Approved</th>
                <th className="text-right">Disbursed</th>
                <th>Officer</th>
                <th>Location</th>
                <th>Maturity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="text-center py-10 text-slate-400">
                  <div className="flex items-center justify-center gap-2"><div className="spinner" />Loading…</div>
                </td></tr>
              ) : apps.length === 0 ? (
                <tr><td colSpan={11} className="text-center py-12">
                  <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">folder_open</span>
                  <p className="text-sm text-slate-400">No applications found</p>
                </td></tr>
              ) : apps.map(a => (
                <tr key={a.id}>
                  <td className="text-xs text-slate-500 whitespace-nowrap">{fmtDateShort(a.date_received)}</td>
                  <td>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100 max-w-[150px] truncate" title={a.customer_name}>{a.customer_name}</p>
                    {a.company && <p className="text-xs text-slate-400 truncate max-w-[150px]" title={a.company}>{a.company}</p>}
                  </td>
                  {!type && <td><TypeBadge type={a.type} /></td>}
                  <td><StatusBadge status={a.status} /></td>
                  <td className="text-right tabular-nums text-sm">{a.requested_amount ? fmtAmt(a.requested_amount) : '—'}</td>
                  <td className="text-right tabular-nums text-sm" style={{ color: '#059669' }}>{a.approved_amount ? fmtAmt(a.approved_amount) : '—'}</td>
                  <td className="text-right tabular-nums text-sm font-semibold" style={{ color: '#0891B2' }}>{a.disbursed_amount ? fmtAmt(a.disbursed_amount) : '—'}</td>
                  <td className="text-xs text-slate-500">{a.account_officer || '—'}</td>
                  <td className="text-xs text-slate-500">{a.location || '—'}</td>
                  <td className="text-xs text-slate-500 whitespace-nowrap">{a.maturity_date ? fmtDateShort(a.maturity_date) : '—'}</td>
                  <td>
                    <div className="flex items-center gap-1">
                      {(a.status === 'disbursed' || a.status === 'approved') && a.type === 'loan' && (
                        <button onClick={() => setRepayApp(a)} className="btn-icon" title="Record payment" style={{ color: '#059669' }}>
                          <span className="material-symbols-rounded text-[16px]">payments</span>
                        </button>
                      )}
                      <button onClick={() => { setEditApp(a); setFormOpen(true) }} className="btn-icon" title="Edit">
                        <span className="material-symbols-rounded text-[16px]">edit</span>
                      </button>
                      <button onClick={() => deleteApp(a.id)} className="btn-icon" title="Delete" style={{ color: '#C00000' }}>
                        <span className="material-symbols-rounded text-[16px]">delete</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total > LIMIT && (
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-xs text-slate-400">Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}</p>
            <div className="flex gap-2">
              <button onClick={() => setOffset(o => Math.max(0, o - LIMIT))} disabled={offset === 0} className="btn btn-ghost btn-sm disabled:opacity-40">
                <span className="material-symbols-rounded text-[17px]">chevron_left</span>
              </button>
              <button onClick={() => setOffset(o => o + LIMIT)} disabled={offset + LIMIT >= total} className="btn btn-ghost btn-sm disabled:opacity-40">
                <span className="material-symbols-rounded text-[17px]">chevron_right</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {formOpen && (
        <ApplicationForm
          initial={editApp}
          onClose={() => { setFormOpen(false); setEditApp(null) }}
          onSave={() => { setFormOpen(false); setEditApp(null); load() }}
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

/* ── Collateral tab ── */
function CollateralTab({ dateFrom, dateTo }) {
  const [apps,    setApps]    = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    apiFetch(`/api/credit-portfolio/applications?status=disbursed&limit=200&date_from=${dateFrom}&date_to=${dateTo}`)
      .then(d => setApps(Array.isArray(d.data) ? d.data : []))
      .catch(() => setApps([]))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo])

  if (loading) return <div className="flex items-center gap-3 text-slate-400 py-12"><div className="spinner" />Loading…</div>

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Security & Collateral</p>
        <p className="text-xs text-slate-400 mt-0.5">Disbursed loans — open an application to manage security records</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead><tr>
            <th>Customer</th><th>Disbursed</th><th>Maturity</th><th>Officer</th><th>Location</th><th>Loan ID</th><th></th>
          </tr></thead>
          <tbody>
            {apps.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-12">
                <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">security</span>
                <p className="text-sm text-slate-400">No disbursed loans in this period</p>
              </td></tr>
            ) : apps.map(a => (
              <tr key={a.id}>
                <td>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{a.customer_name}</p>
                  {a.company && <p className="text-xs text-slate-400">{a.company}</p>}
                </td>
                <td className="tabular-nums text-sm font-semibold">{fmtAmt(a.disbursed_amount)}</td>
                <td className="text-xs text-slate-500">{fmtDateShort(a.maturity_date)}</td>
                <td className="text-xs text-slate-500">{a.account_officer || '—'}</td>
                <td className="text-xs text-slate-500">{a.location || '—'}</td>
                <td className="font-mono text-xs text-slate-400">{a.loan_id || '—'}</td>
                <td>
                  <a href={`#app-${a.id}`} className="btn btn-ghost btn-sm gap-1 text-xs">
                    <span className="material-symbols-rounded text-[14px]">open_in_new</span>Details
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Collections / Overdue tab ── */
function OverdueTab() {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    apiFetch('/api/credit-portfolio/overdue')
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex items-center gap-3 text-slate-400 py-12"><div className="spinner" />Loading…</div>

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Collections — Overdue Accounts</p>
          <p className="text-xs text-slate-400 mt-0.5">Loans with DPD &gt; 0 or overdue payment status</p>
        </div>
        {rows.length > 0 && <span className="badge" style={{ background: '#FEF2F2', color: '#C00000', border: '1px solid #FECACA' }}>{rows.length} overdue</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead><tr>
            <th>Customer</th><th>Month</th><th className="text-right">Expected</th><th className="text-right">Paid</th><th>DPD</th><th>Status</th><th>Comment</th><th>Action</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12">
                <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">check_circle</span>
                <p className="text-sm text-slate-400">No overdue accounts</p>
              </td></tr>
            ) : rows.map((r, i) => {
              const m = PMT_STATUS_META[r.payment_status] || {}
              return (
                <tr key={i}>
                  <td>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.customer_name}</p>
                    {r.account_officer && <p className="text-xs text-slate-400">{r.account_officer}</p>}
                  </td>
                  <td className="text-xs text-slate-500">{r.payment_month}</td>
                  <td className="text-right tabular-nums text-sm">{fmtAmt(r.expected_amount)}</td>
                  <td className="text-right tabular-nums text-sm" style={{ color: n(r.paid_amount) >= n(r.expected_amount) ? '#059669' : '#C00000' }}>
                    {fmtAmt(r.paid_amount)}
                  </td>
                  <td>
                    <span style={{ fontWeight: 700, color: n(r.dpd) > 30 ? '#C00000' : '#D97706', fontVariantNumeric: 'tabular-nums' }}>
                      {r.dpd > 0 ? `${r.dpd}d` : '—'}
                    </span>
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center',
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                      background: m.bg || '#F8FAFC', color: m.color || '#64748B',
                    }}>
                      {r.payment_status}
                    </span>
                  </td>
                  <td className="text-xs text-slate-500">{r.comment || '—'}</td>
                  <td className="text-xs text-slate-500">{r.action_taken || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */

const STATUSES_CONST = ['pending', 'approved', 'declined', 'incomplete', 'disbursed', 'returned', 'written_off']

export default function CreditPortfolio() {
  const [tab,      setTab]      = useState('dashboard')
  const [dateFrom, setDateFrom] = useState(thisMonthRange()[0])
  const [dateTo,   setDateTo]   = useState(thisMonthRange()[1])
  const [preset,   setPreset]   = useState('month')

  function handleDateChange(f, t, p) { setDateFrom(f); setDateTo(t); setPreset(p) }

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">

      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Credit Portfolio</h1>
          <p className="text-sm text-slate-500 mt-0.5">Loan and credit card applications, repayments, collateral, and collections</p>
        </div>
      </div>

      <div className="mb-6">
        <DateRangePicker
          refDate={today()}
          dateFrom={dateFrom} dateTo={dateTo} preset={preset}
          onChange={handleDateChange}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-6 overflow-x-auto" style={{ borderBottom: '2px solid rgb(var(--border) / 0.1)' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 18px',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'none', outline: 'none',
              borderBottom: tab === t.key ? '2px solid #0E2841' : '2px solid transparent',
              marginBottom: -2, color: tab === t.key ? '#0E2841' : 'rgb(var(--fg-3))',
              transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}>
            <span className="material-symbols-rounded text-[17px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard'    && <DashboardTab   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'applications' && <ApplicationsTab type={null}   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'loans'        && <ApplicationsTab type="loan"   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'cards'        && <ApplicationsTab type="card"   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'collateral'   && <CollateralTab   dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 'overdue'      && <OverdueTab />}
    </div>
  )
}
