import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../hooks/useApi.js'

const SOURCES   = ['walk_in','referral','digital','telesales','branch','event','partner','other']
const STATUSES  = ['lead','prospect','customer','churned','inactive']
const GENDERS   = ['Male','Female','Other']
const ID_TYPES  = ['NIN','BVN','Passport','Drivers License','Voters Card']
const INCOME_RANGES = ['Below ₦100k','₦100k–₦300k','₦300k–₦500k','₦500k–₦1M','Above ₦1M']
const PRODUCTS  = ['Prepaid','Credit','International USD','Business Loan']

const STATUS_CLS = {
  lead:     'badge-grey',
  prospect: 'badge-blue',
  customer: 'badge-green',
  churned:  'badge-red',
  inactive: 'badge-amber',
}

function initials(c) {
  return [(c.first_name || '?')[0], (c.last_name || '')[0]].join('').toUpperCase()
}

function ContactModal({ contact, onClose, onSaved }) {
  const isEdit = !!contact?.id
  const [form, setForm] = useState(contact || {
    first_name: '', last_name: '', phone: '', email: '',
    state: '', city: '', address: '', date_of_birth: '',
    gender: '', occupation: '', employer: '', income_range: '',
    id_type: '', id_number: '', source: 'walk_in', cif_number: '',
    status: 'lead', tags: '', notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  function set(k) { return e => setForm(f => ({ ...f, [k]: e.target.value })) }

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const url    = isEdit ? `/api/crm/contacts/${contact.id}` : '/api/crm/contacts'
      const method = isEdit ? 'PUT' : 'POST'
      const saved  = await apiFetch(url, { method, body: JSON.stringify(form) })
      onSaved(saved)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const Field = ({ label, name, type = 'text', placeholder }) => (
    <div>
      <label className="form-label">{label}</label>
      <input className="form-input" type={type} placeholder={placeholder}
        value={form[name] || ''} onChange={set(name)} />
    </div>
  )

  const Select = ({ label, name, options }) => (
    <div>
      <label className="form-label">{label}</label>
      <select className="form-input" value={form[name] || ''} onChange={set(name)}>
        <option value="">—</option>
        {options.map(o => <option key={o} value={o.toLowerCase().replace(/\s+/g,'_')}>{o}</option>)}
      </select>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-auto"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}>
      <div className="card w-full max-w-2xl p-6 animate-fade-in my-4" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">
            {isEdit ? 'Edit Contact' : 'Add New Contact'}
          </h2>
          <button onClick={onClose} className="btn-icon"><span className="material-symbols-rounded text-[20px]">close</span></button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-red-600 bg-red-50 dark:bg-red-900/15 border border-red-100 rounded-xl px-4 py-3 mb-4 text-sm">
            <span className="material-symbols-rounded text-[16px]">error</span>{error}
          </div>
        )}

        <form onSubmit={submit}>
          {/* Personal */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Personal Info</p>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Field label="First Name *" name="first_name" />
            <Field label="Last Name *"  name="last_name" />
            <Field label="Phone"        name="phone" type="tel" />
            <Field label="Email"        name="email" type="email" />
            <Field label="Date of Birth" name="date_of_birth" type="date" />
            <div>
              <label className="form-label">Gender</label>
              <select className="form-input" value={form.gender || ''} onChange={set('gender')}>
                <option value="">—</option>
                {GENDERS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>

          {/* Address */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Location</p>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Field label="State" name="state" />
            <Field label="City"  name="city" />
            <div className="col-span-2"><Field label="Address" name="address" /></div>
          </div>

          {/* Employment */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Employment</p>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Field label="Occupation" name="occupation" />
            <Field label="Employer"   name="employer" />
            <div>
              <label className="form-label">Income Range</label>
              <select className="form-input" value={form.income_range || ''} onChange={set('income_range')}>
                <option value="">—</option>
                {INCOME_RANGES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>

          {/* ID */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Identification</p>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="form-label">ID Type</label>
              <select className="form-input" value={form.id_type || ''} onChange={set('id_type')}>
                <option value="">—</option>
                {ID_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <Field label="ID Number" name="id_number" />
          </div>

          {/* CRM */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">CRM</p>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="form-label">Source</label>
              <select className="form-input" value={form.source || 'walk_in'} onChange={set('source')}>
                {SOURCES.map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Status</label>
              <select className="form-input" value={form.status || 'lead'} onChange={set('status')}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <Field label="CIF Number (if issued)" name="cif_number" />
            <Field label="Tags (comma-separated)" name="tags" />
          </div>

          <div className="mb-5">
            <label className="form-label">Notes</label>
            <textarea className="form-input" rows={3} value={form.notes || ''} onChange={set('notes')}
              placeholder="Any additional notes about this contact…" />
          </div>

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={saving || !form.first_name || !form.last_name}
              className="btn btn-primary disabled:opacity-60">
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Contacts() {
  const navigate = useNavigate()
  const [contacts, setContacts] = useState([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [q, setQ]               = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [modal, setModal]       = useState(null)  // null | 'new' | contact object

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (q) params.set('q', q)
      if (statusFilter) params.set('status', statusFilter)
      const res = await apiFetch(`/api/crm/contacts?${params}`)
      setContacts(res.data || [])
      setTotal(res.total || 0)
    } finally {
      setLoading(false)
    }
  }, [q, statusFilter])

  useEffect(() => { load() }, [load])

  function onSaved() { setModal(null); load() }

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Contacts</h1>
          <p className="text-sm text-slate-500 mt-0.5">{total.toLocaleString()} total contacts</p>
        </div>
        <button onClick={() => setModal('new')} className="btn btn-primary gap-2">
          <span className="material-symbols-rounded text-[18px]">person_add</span>
          Add Contact
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <span className="material-symbols-rounded text-[18px] text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">search</span>
          <input className="form-input pl-9" placeholder="Search name, phone, CIF…"
            value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="form-input w-auto" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Phone</th>
                <th>Source</th>
                <th>Status</th>
                <th>State</th>
                <th>Deals</th>
                <th>Tasks</th>
                <th>Assigned To</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-400">
                  <div className="flex items-center justify-center gap-2"><div className="spinner" /> Loading…</div>
                </td></tr>
              ) : contacts.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-12">
                  <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">contacts</span>
                  <p className="text-sm text-slate-400">No contacts found</p>
                </td></tr>
              ) : contacts.map(c => (
                <tr key={c.id} className="cursor-pointer" onClick={() => navigate(`/crm/contacts/${c.id}`)}>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0"
                        style={{ background: `hsl(${(c.id * 47) % 360} 55% 45%)` }}>
                        {initials(c)}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-800 dark:text-slate-100">{c.first_name} {c.last_name}</p>
                        {c.email && <p className="text-xs text-slate-400">{c.email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="text-slate-600 dark:text-slate-400">{c.phone || '—'}</td>
                  <td><span className="badge badge-grey">{(c.source || '').replace(/_/g,' ')}</span></td>
                  <td><span className={`badge ${STATUS_CLS[c.status] || 'badge-grey'}`}>{c.status}</span></td>
                  <td className="text-slate-500">{c.state || '—'}</td>
                  <td className="text-slate-600 tabular-nums">{c.deal_count || 0}</td>
                  <td className="tabular-nums">
                    <span className={c.open_tasks > 0 ? 'text-amber-600 font-semibold' : 'text-slate-400'}>
                      {c.open_tasks || 0}
                    </span>
                  </td>
                  <td className="text-slate-500">{c.assigned_name || '—'}</td>
                  <td>
                    <button onClick={e => { e.stopPropagation(); setModal(c) }}
                      className="btn-icon opacity-0 group-hover:opacity-100">
                      <span className="material-symbols-rounded text-[18px]">edit</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <ContactModal
          contact={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}
