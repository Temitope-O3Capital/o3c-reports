import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef,
  StatusBadge, ErrBanner, Spinner, NAVY, AMBER,
} from '../../components/UI'

/* ── Constants ──────────────────────────────────────────────────── */
const STATUSES      = ['lead', 'prospect', 'customer', 'churned', 'inactive']
const SOURCES       = ['walk_in', 'referral', 'digital', 'telesales', 'branch', 'event', 'partner', 'other']
const GENDERS       = ['Male', 'Female', 'Other']
const ID_TYPES      = ['NIN', 'BVN', 'Passport', 'Drivers License', 'Voters Card']
const INCOME_RANGES = ['Below ₦100k', '₦100k–₦300k', '₦300k–₦500k', '₦500k–₦1M', 'Above ₦1M']

/* ── Types ──────────────────────────────────────────────────────── */
interface Contact {
  id: number
  first_name: string
  last_name: string
  phone: string | null
  email: string | null
  state: string | null
  city: string | null
  source: string
  status: string
  cif_number: string | null
  assigned_name: string | null
  deal_count: number
  open_tasks: number
  activity_count: number
  updated_at: string
  tags: string | null
}

type ModalMode = null | 'new' | Contact

/* ── Avatar ─────────────────────────────────────────────────────── */
function Avatar({ c }: { c: Contact }) {
  const initials = ((c.first_name?.[0] ?? '') + (c.last_name?.[0] ?? '')).toUpperCase()
  const hue = (c.id * 47) % 360
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0"
      style={{ background: `hsl(${hue} 50% 42%)` }}>
      {initials}
    </div>
  )
}

/* ── Contact modal ──────────────────────────────────────────────── */
interface ModalProps {
  contact: Contact | null
  onClose: () => void
  onSaved: () => void
}

function ContactModal({ contact, onClose, onSaved }: ModalProps) {
  const isEdit = !!contact?.id
  const blank = {
    first_name: '', last_name: '', phone: '', email: '',
    state: '', city: '', address: '', date_of_birth: '',
    gender: '', occupation: '', employer: '', income_range: '',
    id_type: '', id_number: '', source: 'walk_in', cif_number: '',
    status: 'lead', tags: '', notes: '',
  }
  const [form, setForm] = useState<Record<string, string>>(contact ? { ...blank, ...contact as any } : blank)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setErr('')
    try {
      if (isEdit) {
        await apiPut(`/api/crm/contacts/${contact!.id}`, form)
      } else {
        await apiPost('/api/crm/contacts', form)
      }
      onSaved()
    } catch (ex: any) {
      setErr(ex.message)
    } finally {
      setSaving(false)
    }
  }

  const Field = ({ label, name, type = 'text', placeholder }: { label: string; name: string; type?: string; placeholder?: string }) => (
    <div>
      <label className="block text-[11px] font-semibold text-slate-500 mb-1">{label}</label>
      <input className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-[#0E2841] transition-colors"
        style={{ borderColor: 'rgba(15,23,42,0.18)' }}
        type={type} placeholder={placeholder}
        value={form[name] ?? ''} onChange={set(name)} />
    </div>
  )

  const Select = ({ label, name, options }: { label: string; name: string; options: string[] }) => (
    <div>
      <label className="block text-[11px] font-semibold text-slate-500 mb-1">{label}</label>
      <select className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-[#0E2841] bg-white transition-colors"
        style={{ borderColor: 'rgba(15,23,42,0.18)' }}
        value={form[name] ?? ''} onChange={set(name)}>
        <option value="">—</option>
        {options.map(o => <option key={o} value={o}>{snake(o)}</option>)}
      </select>
    </div>
  )

  const Section = ({ label }: { label: string }) => (
    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400 mb-3 mt-5">{label}</p>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-auto shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h2 className="text-[15px] font-semibold text-slate-900">
            {isEdit ? 'Edit Contact' : 'Add New Contact'}
          </h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[20px] text-slate-500">close</span>
          </button>
        </div>

        <form onSubmit={submit} className="px-6 pb-6">
          <ErrBanner msg={err} />

          <Section label="Personal Info" />
          <div className="grid grid-cols-2 gap-3 mb-1">
            <Field label="First Name *" name="first_name" />
            <Field label="Last Name *" name="last_name" />
            <Field label="Phone" name="phone" type="tel" />
            <Field label="Email" name="email" type="email" />
            <Field label="Date of Birth" name="date_of_birth" type="date" />
            <Select label="Gender" name="gender" options={GENDERS} />
          </div>

          <Section label="Location" />
          <div className="grid grid-cols-2 gap-3 mb-1">
            <Field label="State" name="state" />
            <Field label="City" name="city" />
            <div className="col-span-2"><Field label="Address" name="address" /></div>
          </div>

          <Section label="Employment" />
          <div className="grid grid-cols-2 gap-3 mb-1">
            <Field label="Occupation" name="occupation" />
            <Field label="Employer" name="employer" />
            <Select label="Income Range" name="income_range" options={INCOME_RANGES} />
          </div>

          <Section label="Identification" />
          <div className="grid grid-cols-2 gap-3 mb-1">
            <Select label="ID Type" name="id_type" options={ID_TYPES} />
            <Field label="ID Number" name="id_number" />
          </div>

          <Section label="CRM" />
          <div className="grid grid-cols-2 gap-3 mb-1">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Source</label>
              <select className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none bg-white"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.source ?? 'walk_in'} onChange={set('source')}>
                {SOURCES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Status</label>
              <select className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none bg-white"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.status ?? 'lead'} onChange={set('status')}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <Field label="CIF Number" name="cif_number" placeholder="If card issued" />
            <Field label="Tags" name="tags" placeholder="comma-separated" />
          </div>

          <div className="mt-4">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Notes</label>
            <textarea className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-none"
              style={{ borderColor: 'rgba(15,23,42,0.18)' }}
              rows={3} value={form.notes ?? ''} onChange={set('notes')}
              placeholder="Additional notes about this contact…" />
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-[13px] font-medium text-slate-600 hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button type="submit"
              disabled={saving || !form.first_name || !form.last_name}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-60"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ── Main page ──────────────────────────────────────────────────── */
export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [modal, setModal] = useState<ModalMode>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (q) params.set('q', q)
      if (statusFilter) params.set('status', statusFilter)
      const res = await apiFetch<{ data: Contact[]; total: number }>(`/api/crm/contacts?${params}`)
      setContacts(res.data ?? [])
      setTotal(res.total ?? 0)
    } catch (ex: any) {
      setErr(ex.message)
    } finally {
      setLoading(false)
    }
  }, [q, statusFilter])

  useEffect(() => { load() }, [load])

  const cols: ColDef<Contact>[] = [
    {
      key: 'first_name', label: 'Contact',
      render: c => (
        <div className="flex items-center gap-3">
          <Avatar c={c} />
          <div>
            <p className="font-semibold text-slate-800 text-[13px]">{c.first_name} {c.last_name}</p>
            {c.email && <p className="text-[11px] text-slate-400">{c.email}</p>}
          </div>
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: c => <span className="text-slate-600 font-mono text-[12px]">{c.phone ?? '—'}</span> },
    {
      key: 'source', label: 'Source',
      render: c => (
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded"
          style={{ background: 'rgba(14,40,65,0.06)', color: '#475569' }}>
          {snake(c.source ?? '')}
        </span>
      ),
    },
    { key: 'status', label: 'Status', render: c => <StatusBadge status={c.status} /> },
    { key: 'state', label: 'State', render: c => <span className="text-slate-500">{c.state ?? '—'}</span> },
    {
      key: 'deal_count', label: 'Deals', right: true,
      render: c => <span className="kpi-number text-[13px] text-slate-700">{c.deal_count ?? 0}</span>,
    },
    {
      key: 'open_tasks', label: 'Open Tasks', right: true,
      render: c => (
        <span className={`kpi-number text-[13px] font-semibold ${(c.open_tasks ?? 0) > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
          {c.open_tasks ?? 0}
        </span>
      ),
    },
    { key: 'assigned_name', label: 'Assigned To', render: c => <span className="text-slate-500">{c.assigned_name ?? '—'}</span> },
    {
      key: 'updated_at', label: 'Last Updated', sortable: false,
      render: c => <span className="text-slate-400 text-[12px]">{fmtDate(c.updated_at)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: c => (
        <button onClick={e => { e.stopPropagation(); setModal(c) }}
          className="w-7 h-7 flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 hover:bg-slate-100 transition-all">
          <span className="material-symbols-rounded text-[16px] text-slate-500">edit</span>
        </button>
      ),
    },
  ]

  return (
    <Page dept="CRM" title="Contacts" subtitle={`${total.toLocaleString()} total contacts`}
      actions={
        <button onClick={() => setModal('new')}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-all"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[17px]">person_add</span>
          Add Contact
        </button>
      }>

      <ErrBanner msg={err} />

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <span className="material-symbols-rounded text-[17px] text-slate-400 absolute left-3 top-1/2 -translate-y-1/2">search</span>
          <input
            className="w-full pl-9 pr-3 py-2 rounded-lg border text-[13px] outline-none focus:border-slate-400 transition-colors bg-white"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            placeholder="Search name, phone, email, CIF…"
            value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select
          className="px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}
          value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {(q || statusFilter) && (
          <button onClick={() => { setQ(''); setStatusFilter('') }}
            className="px-3 py-2 rounded-lg border text-[12px] text-slate-500 bg-white hover:bg-slate-50 transition-colors"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            Clear
          </button>
        )}
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-5 gap-3 mb-5">
        {STATUSES.map(s => {
          const count = contacts.filter(c => c.status === s).length
          return (
            <button key={s} onClick={() => setStatusFilter(statusFilter === s ? '' : s)}
              className="card p-3 text-left transition-all hover:shadow-md"
              style={{ borderColor: statusFilter === s ? NAVY : undefined, borderWidth: statusFilter === s ? 1.5 : 1 }}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400 mb-1">{s}</p>
              <p className="kpi-number text-[20px] text-slate-800">{count}</p>
            </button>
          )
        })}
      </div>

      <SectionCard title="All Contacts" badge={total}>
        <DataTable<Contact>
          cols={cols}
          rows={contacts}
          loading={loading}
          emptyIcon="contacts"
          emptyMsg="No contacts found — try adjusting your search or filters" />
      </SectionCard>

      {modal !== null && (
        <ContactModal
          contact={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }} />
      )}
    </Page>
  )
}
