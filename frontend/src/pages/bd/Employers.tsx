import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useMemo, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Modal, Spinner, ExpandableFilterBar, DateFilter, NameCell, ActionRow } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'
import { fmtDate, fmtNum, fmtKobo } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

interface Employer {
  id: number; name: string; sector: string
  mou_status: string; mou_date: string | null; mou_expiry: string | null
  staff_count: number; monthly_payroll_kobo: number; credit_limit_kobo: number
  lead_count: number; contact_name: string
  contact_email: string; contact_phone: string; address: string | null
  notes: string | null; is_active: boolean; created_at: string
}

// Common employer sectors (datalist suggestions — free text still allowed).
const SECTOR_OPTIONS = [
  'Banking & Finance', 'Oil & Gas', 'Manufacturing', 'Public Sector',
  'Telecommunications', 'Healthcare', 'Education', 'Retail & FMCG',
  'Technology', 'Construction', 'Hospitality', 'Transport & Logistics',
  'Agriculture', 'Professional Services',
]

interface StaffMember {
  id: number; employer_id: number; full_name: string
  job_title: string | null; department: string | null
  phone: string | null; email: string | null; created_at: string
}

interface SalesAgent {
  id: number; full_name: string; role: string; email: string
}

const MOU_COLORS: Record<string, string> = {
  signed: GREEN, pending: AMBER, expired: RED, none: '#6B7280',
}

const MOU_STATUSES = ['signed', 'pending', 'expired', 'none']

function MOUPill({ status }: { status: string }) {
  const c = MOU_COLORS[status?.toLowerCase()] ?? '#6B7280'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
      background: `${c}18`, color: c, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{status || 'None'}</span>
  )
}


function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: RADIUS.sm,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? RED : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
    </button>
  )
}

// ── Input style ───────────────────────────────────────────────────────────────

const IS: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  outline: 'none', boxSizing: 'border-box', fontFamily: SORA,
}

// ── Add Employer modal ────────────────────────────────────────────────────────

interface AddEmployerForm {
  name: string; sector: string; staff_count: string
  monthly_payroll_naira: string; credit_limit_naira: string
  mou_status: string; mou_date: string; mou_expiry: string
  contact_name: string; contact_email: string; contact_phone: string
  address: string; notes: string
}

const EMPTY_FORM: AddEmployerForm = {
  name: '', sector: '', staff_count: '',
  monthly_payroll_naira: '', credit_limit_naira: '',
  mou_status: 'none', mou_date: '', mou_expiry: '',
  contact_name: '', contact_email: '', contact_phone: '', address: '', notes: '',
}

function AddEmployerModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<AddEmployerForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const set = (k: keyof AddEmployerForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))
  const nairaToKobo = (v: string) => (v ? Math.round(Number(v) * 100) : 0)

  async function submit() {
    if (!form.name.trim()) { toast.error('Employer name is required'); return }
    if (form.mou_status === 'signed' && !form.mou_date) { toast.error('MOU date is required for a signed MOU'); return }
    setSaving(true)
    try {
      await apiPost('/api/bd/employers', {
        name: form.name.trim(),
        sector: form.sector || null,
        staff_count: form.staff_count ? Number(form.staff_count) : 0,
        monthly_payroll_kobo: nairaToKobo(form.monthly_payroll_naira),
        credit_limit_kobo: nairaToKobo(form.credit_limit_naira),
        mou_status: form.mou_status,
        mou_date: form.mou_date || null,
        mou_expiry: form.mou_expiry || null,
        contact_name: form.contact_name || null,
        contact_phone: form.contact_phone || null,
        contact_email: form.contact_email || null,
        address: form.address || null,
        notes: form.notes || null,
      })
      toast.success('Employer registered')
      onSaved()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to create employer')
    } finally {
      setSaving(false)
    }
  }

  const F = ({ label, k, type = 'text', list, placeholder, prefix }: { label: string; k: keyof AddEmployerForm; type?: string; list?: string; placeholder?: string; prefix?: string }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label}</label>
      <div style={{ position: 'relative' }}>
        {prefix && <span style={{ position: 'absolute', left: 10, top: 0, height: 36, display: 'flex', alignItems: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>{prefix}</span>}
        <input type={type} value={form[k]} list={list} placeholder={placeholder} onChange={set(k)} style={{ ...IS, paddingLeft: prefix ? 24 : 10 }} />
      </div>
    </div>
  )

  return (
    <Modal
      open
      title="Register Employer"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving && <Spinner size={14} color="#fff" />}
            Register
          </button>
        </>
      }
    >
      <datalist id="sector-list">{SECTOR_OPTIONS.map(s => <option key={s} value={s} />)}</datalist>

      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 8 }}>Company</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1/-1' }}><F label="Employer Name *" k="name" /></div>
        <F label="Sector" k="sector" list="sector-list" placeholder="Search or type…" />
        <F label="Staff Count" k="staff_count" type="number" />
        <F label="Monthly Payroll" k="monthly_payroll_naira" type="number" prefix="₦" placeholder="0" />
        <F label="Credit Limit" k="credit_limit_naira" type="number" prefix="₦" placeholder="0" />
        <div style={{ gridColumn: '1/-1' }}><F label="Address" k="address" /></div>
      </div>

      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', margin: '18px 0 8px' }}>MOU</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>MOU Status</label>
          <select value={form.mou_status} onChange={set('mou_status')} style={{ ...IS, height: 36 }}>
            <option value="none">None</option>
            <option value="pending">Pending</option>
            <option value="signed">Signed</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <F label="MOU Date" k="mou_date" type="date" />
        <F label="MOU Expiry" k="mou_expiry" type="date" />
      </div>

      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', margin: '18px 0 8px' }}>Primary Contact</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <F label="Contact Name" k="contact_name" />
        <F label="Contact Phone" k="contact_phone" />
        <div style={{ gridColumn: '1/-1' }}><F label="Contact Email" k="contact_email" type="email" /></div>
        <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Notes</label>
          <textarea value={form.notes} onChange={set('notes')} rows={2} style={{ ...IS, height: 'auto', resize: 'vertical', padding: '8px 10px' }} />
        </div>
      </div>
    </Modal>
  )
}

// ── Employer detail modal ─────────────────────────────────────────────────────

function EmployerDetailModal({ employer, onClose }: { employer: Employer; onClose: () => void }) {
  const mouColor = MOU_COLORS[employer.mou_status?.toLowerCase()] ?? '#6B7280'
  const row = (label: string, value: React.ReactNode) => (
    <div key={label} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', minWidth: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{value ?? '—'}</span>
    </div>
  )

  return (
    <Modal open title={employer.name} width={500} onClose={onClose}
      footer={<button onClick={onClose} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Close</button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {row('Sector', employer.sector)}
        {row('Staff Count', fmtNum(employer.staff_count))}
        {row('Monthly Payroll', employer.monthly_payroll_kobo ? fmtKobo(employer.monthly_payroll_kobo) : null)}
        {row('Credit Limit', employer.credit_limit_kobo ? fmtKobo(employer.credit_limit_kobo) : null)}
        {row('Leads', fmtNum(employer.lead_count))}
        {row('MOU Status', <span style={{ fontWeight: FW.semibold, color: mouColor, textTransform: 'capitalize' }}>{employer.mou_status || 'None'}</span>)}
        {row('MOU Date', employer.mou_date ? fmtDate(employer.mou_date) : null)}
        {row('MOU Expiry', employer.mou_expiry ? fmtDate(employer.mou_expiry) : null)}
        {row('Address', employer.address)}
        <div style={{ marginTop: 14, padding: `${SP[3]} 14px`, borderRadius: RADIUS.lg, background: 'var(--th-bg)', border: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 8 }}>Contact</div>
          {row('Name', employer.contact_name)}
          {row('Phone', employer.contact_phone)}
          {row('Email', employer.contact_email)}
        </div>
        {employer.notes && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)', fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.5 }}>
            {employer.notes}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Staff Roster modal ────────────────────────────────────────────────────────

const EMPTY_STAFF = { full_name: '', job_title: '', department: '', phone: '', email: '' }

function StaffRosterModal({
  employer, onClose, onAssign,
}: {
  employer: Employer
  onClose: () => void
  onAssign: (staff: StaffMember[]) => void
}) {
  const [staff, setStaff]   = useState<StaffMember[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm]     = useState(EMPTY_STAFF)
  const [adding, setAdding]  = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const data = await apiFetch<any>(`/api/bd/employers/${employer.id}/staff`)
      setStaff(Array.isArray(data) ? data : (data?.data ?? []))
    } finally {
      setLoading(false)
    }
  }, [employer.id])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals','crm'] })

  const set = (k: keyof typeof EMPTY_STAFF) =>
    (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function addStaff() {
    if (!form.full_name.trim()) { toast.error('Full name is required'); return }
    setAdding(true)
    try {
      await apiPost(`/api/bd/employers/${employer.id}/staff`, {
        full_name: form.full_name.trim(),
        job_title: form.job_title.trim() || null,
        department: form.department.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
      })
      toast.success('Staff member added')
      setForm(EMPTY_STAFF)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to add staff member')
    } finally {
      setAdding(false)
    }
  }

  async function removeStaff(id: number) {
    setDeleting(id)
    try {
      await apiDelete(`/api/bd/employers/${employer.id}/staff/${id}`)
      toast.success('Staff member removed')
      setStaff(prev => prev.filter(s => s.id !== id))
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to remove staff')
    } finally {
      setDeleting(null)
    }
  }

  const SF = ({ label, k, type = 'text' }: { label: string; k: keyof typeof EMPTY_STAFF; type?: string }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={form[k]} onChange={set(k)} style={{ ...IS, height: 32 }} />
    </div>
  )

  return (
    <Modal
      open
      title={`Staff Roster: ${employer.name}`}
      width={640}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Close</button>
          <button
            onClick={() => onAssign(staff)}
            disabled={staff.length === 0}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: staff.length === 0 ? 'not-allowed' : 'pointer', opacity: staff.length === 0 ? 0.5 : 1 }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>person_add</span>
            Assign to Sales
          </button>
        </>
      }
    >
      {/* Add staff form */}
      <div style={{ padding: '10px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', marginBottom: 14 }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 8 }}>Add Staff Member</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
          <div style={{ gridColumn: '1/-1' }}><SF label="Full Name *" k="full_name" /></div>
          <SF label="Job Title" k="job_title" />
          <SF label="Department" k="department" />
          <SF label="Phone" k="phone" type="tel" />
          <SF label="Email" k="email" type="email" />
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button
              onClick={addStaff}
              disabled={adding}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', height: 32, borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: adding ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
            >
              {adding ? <Spinner size={12} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 14 }}>add</span>}
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Staff list */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner size={22} /></div>
      ) : staff.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--txt3)', fontSize: TEXT.sm }}>No staff added yet</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {staff.map((s, i) => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 4px',
              borderBottom: i < staff.length - 1 ? '1px solid var(--bdr)' : 'none',
            }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: `${NAVY}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY }}>person</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{s.full_name}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                  {[s.job_title, s.department].filter(Boolean).join(' · ')}
                </div>
              </div>
              {s.phone && <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{s.phone}</span>}
              <button
                onClick={() => removeStaff(s.id)}
                disabled={deleting === s.id}
                style={{ padding: '4px 6px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: RED, cursor: deleting === s.id ? 'wait' : 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>delete</span>
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
        {staff.length} staff member{staff.length !== 1 ? 's' : ''} · You can assign the full company without a complete roster
      </div>
    </Modal>
  )
}

// ── Assign to Sales modal ─────────────────────────────────────────────────────

function AssignToSalesModal({
  employer, staff, onClose, onDone,
}: {
  employer: Employer
  staff: StaffMember[]
  onClose: () => void
  onDone: () => void
}) {
  const [agents, setAgents]             = useState<SalesAgent[]>([])
  const [agentId, setAgentId]           = useState<string>('')
  const [assignType, setAssignType]     = useState<'full_company' | 'specific_staff'>('full_company')
  const [selectedStaff, setSelectedStaff] = useState<Set<number>>(new Set())
  const [notes, setNotes]               = useState('')
  const [saving, setSaving]             = useState(false)

  useEffect(() => {
    apiFetch<SalesAgent[]>('/api/admin/users?limit=200')
      .then(r => setAgents((r ?? []).filter(u => u.role === 'sales_officer' || u.role === 'sales_head')))
      .catch(() => {})
  }, [])

  function toggleStaff(id: number) {
    setSelectedStaff(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function submit() {
    if (!agentId) { toast.error('Select a Sales Agent'); return }
    if (assignType === 'specific_staff' && selectedStaff.size === 0) {
      toast.error('Select at least one staff member'); return
    }
    setSaving(true)
    try {
      await apiPost(`/api/bd/employers/${employer.id}/assign`, {
        sales_agent_id: Number(agentId),
        assignment_type: assignType,
        staff_ids: assignType === 'specific_staff' ? [...selectedStaff] : [],
        notes: notes.trim() || null,
      })
      toast.success('Assigned to Sales successfully')
      onDone()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to assign')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={`Assign to Sales: ${employer.name}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button
            onClick={submit}
            disabled={saving}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
          >
            {saving && <Spinner size={14} color="#fff" />}
            Assign
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Sales Agent */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Sales Agent *</label>
          <select
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
            style={{ ...IS, height: 36 }}
          >
            <option value="">Select agent…</option>
            {agents.map(a => (
              <option key={a.id} value={String(a.id)}>{a.full_name}</option>
            ))}
          </select>
        </div>

        {/* Assignment type */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Assignment Type</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['full_company', 'specific_staff'] as const).map(t => (
              <button
                key={t}
                onClick={() => setAssignType(t)}
                style={{
                  flex: 1, padding: '8px 10px', borderRadius: RADIUS.md, cursor: 'pointer',
                  border: `2px solid ${assignType === t ? NAVY : 'var(--bdr)'}`,
                  background: assignType === t ? `${NAVY}10` : 'var(--card)',
                  color: assignType === t ? NAVY : 'var(--txt2)',
                  fontSize: TEXT.sm, fontWeight: FW.semibold, textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                  {t === 'full_company' ? 'corporate_fare' : 'group'}
                </span>
                {t === 'full_company' ? 'Full Company' : 'Specific Staff'}
              </button>
            ))}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {assignType === 'full_company'
              ? `All current and future staff of ${employer.name} will be assigned to this agent.`
              : 'Choose specific staff members to assign. More can be added later.'}
          </div>
        </div>

        {/* Staff checklist (specific_staff only) */}
        {assignType === 'specific_staff' && (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, overflow: 'hidden' }}>
            {staff.length === 0 ? (
              <div style={{ padding: 14, fontSize: TEXT.sm, color: 'var(--txt3)', textAlign: 'center' }}>
                No staff on roster yet. Add them via Staff Roster first
              </div>
            ) : (
              staff.map((s, i) => (
                <label
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                    borderBottom: i < staff.length - 1 ? '1px solid var(--bdr)' : 'none',
                    cursor: 'pointer', background: selectedStaff.has(s.id) ? `${NAVY}08` : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedStaff.has(s.id)}
                    onChange={() => toggleStaff(s.id)}
                    style={{ accentColor: NAVY }}
                  />
                  <div>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)' }}>{s.full_name}</div>
                    {(s.job_title || s.department) && (
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                        {[s.job_title, s.department].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>
        )}

        {/* Notes */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Optional context for the Sales Agent…"
            style={{ ...IS, height: 'auto', resize: 'vertical', padding: '8px 10px' }}
          />
        </div>
      </div>
    </Modal>
  )
}

const PER_PAGE = 25

export default function Employers() {
  const [employers,  setEmployers]  = useState<Employer[]>([])
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState<string | null>(null)
  const [search,   setSearch]   = useState('')
  const [fSectors, setFSectors] = useState<Set<string>>(new Set())
  const [fMOU,     setFMOU]     = useState<Set<string>>(new Set())
  const [page,       setPage]       = useState(1)
  const [selected,   setSelected]   = useState<Set<string | number>>(new Set())
  const [showAdd,      setShowAdd]      = useState(false)
  const [detailRow,    setDetailRow]    = useState<Employer | null>(null)
  const [staffModal,   setStaffModal]   = useState<Employer | null>(null)
  const [assignModal,  setAssignModal]  = useState<{ employer: Employer; staff: StaffMember[] } | null>(null)
  // Bulk assign (bulk bar) — assign every selected employer (full company) to one
  // sales agent via POST /api/bd/employers/{id}/assign, the same endpoint the
  // single-employer AssignToSalesModal uses.
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false)
  const [bulkAgents,    setBulkAgents]    = useState<SalesAgent[]>([])
  const [bulkAgentId,   setBulkAgentId]   = useState('')
  const [bulkNotes,     setBulkNotes]     = useState('')
  const [bulkSaving,    setBulkSaving]    = useState(false)
  // A register lists ALL employers by default; the date range is optional (all-time).
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<any>(`/api/bd/employers?from=${dateFrom}&to=${dateTo}`)
      setEmployers(Array.isArray(res) ? res : (res?.data ?? []))
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load employers')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  // Sales agents for the bulk-assign picker (same source/roles as AssignToSalesModal).
  useEffect(() => {
    apiFetch<SalesAgent[]>('/api/admin/users?limit=200')
      .then(r => setBulkAgents((r ?? []).filter(u => u.role === 'sales_officer' || u.role === 'sales_head')))
      .catch(() => setBulkAgents([]))
  }, [])

  const uniqueSectors = useMemo(() => [...new Set(employers.map(e => e.sector).filter(Boolean))].sort() as string[], [employers])


  const filtered = useMemo(() => employers.filter(e => {
    if (fSectors.size && !fSectors.has(e.sector)) return false
    const mouKey = (e.mou_status?.toLowerCase() || 'none')
    if (fMOU.size && !fMOU.has(mouKey)) return false
    if (search) {
      const q = search.toLowerCase()
      if (!['name', 'sector', 'contact_name'].some(k => (e as any)[k]?.toLowerCase?.().includes(q))) return false
    }
    return true
  }), [employers, fSectors, fMOU, search])

  const totalStaff   = employers.reduce((s, e) => s + Number(e.staff_count ?? 0), 0)
  const mouSigned    = employers.filter(e => e.mou_status?.toLowerCase() === 'signed').length
  const mouExpiring  = employers.filter(e => {
    if (e.mou_status?.toLowerCase() !== 'signed' || !e.mou_expiry) return false
    const days = (new Date(e.mou_expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    return days >= 0 && days <= 90
  }).length

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart  = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd    = Math.min(safePage * PER_PAGE, filtered.length)

  useEffect(() => { setPage(1) }, [search, fSectors, fMOU])

  function resetFilters() {
    setSearch(''); setFSectors(new Set()); setFMOU(new Set())
  }


  // Rows behind the current selection (selection survives paging, so resolve from
  // the full loaded set, not just the visible page).
  const selectedEmployers = useMemo(() => employers.filter(e => selected.has(e.id)), [employers, selected])


  async function doBulkAssign() {
    if (!bulkAgentId) { toast.error('Select a sales agent'); return }
    const ids = [...selected]
    if (ids.length === 0) { toast.error('No employers selected'); return }
    setBulkSaving(true)
    try {
      await Promise.all(ids.map(id => apiPost(`/api/bd/employers/${id}/assign`, {
        sales_agent_id: Number(bulkAgentId),
        assignment_type: 'full_company',
        staff_ids: [],
        notes: bulkNotes.trim() || null,
      })))
      toast.success(`Assigned ${ids.length} employer${ids.length !== 1 ? 's' : ''} to sales`)
      setBulkAssignOpen(false); setBulkAgentId(''); setBulkNotes(''); setSelected(new Set()); load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to assign employers')
    } finally {
      setBulkSaving(false)
    }
  }

  const cols: TableCol<Employer>[] = [
    {
      key: 'name', label: 'Employer', sortable: true,
      render: row => <NameCell name={row.name} sub={row.sector ?? row.contact_name ?? null} />,
    },
    {
      key: 'sector', label: 'Sector', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)', fontSize: TEXT.sm }}>{row.sector ?? '—'}</span>,
    },
    {
      key: 'mou_status', label: 'MOU Status', sortable: true,
      render: row => <MOUPill status={row.mou_status ?? 'none'} />,
    },
    {
      key: 'mou_expiry', label: 'MOU Expiry', sortable: true,
      render: row => {
        if (!row.mou_expiry) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const days = Math.ceil((new Date(row.mou_expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        const color = days < 30 ? RED : days < 90 ? AMBER : 'var(--txt2)'
        return (
          <div>
            <div style={{ fontSize: TEXT.sm, color }}>{fmtDate(row.mou_expiry)}</div>
            {days >= 0 && days <= 90 && (
              <div style={{ fontSize: TEXT.xs, color, fontWeight: FW.semibold }}>{days}d left</div>
            )}
          </div>
        )
      },
    },
    {
      key: 'staff_count', label: 'Staff', sortable: true, align: 'right',
      render: row => <span style={NUM}>{fmtNum(row.staff_count)}</span>,
    },
    {
      key: 'monthly_payroll_kobo', label: 'Payroll', sortable: true, align: 'right',
      render: row => <span style={NUM}>{row.monthly_payroll_kobo ? fmtKobo(row.monthly_payroll_kobo) : '—'}</span>,
    },
    {
      key: 'lead_count', label: 'Leads', sortable: true, align: 'right',
      render: row => <span style={NUM}>{fmtNum(row.lead_count)}</span>,
    },
    {
      key: 'contact_name', label: 'Contact', sortable: true,
      render: row => (
        <div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{row.contact_name ?? '—'}</div>
          {row.contact_phone && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{row.contact_phone}</div>}
        </div>
      ),
    },
    {
      key: '_actions', label: '', sortable: false,
      render: row => <ActionRow actions={[
        { icon: 'visibility',  label: 'View',          onClick: () => setDetailRow(row) },
        { icon: 'group',       label: 'Staff Roster',  onClick: () => setStaffModal(row) },
        { icon: 'person_add',  label: 'Assign to Sales', onClick: () => setAssignModal({ employer: row, staff: [] }) },
      ]} />,
    },
  ]

  return (
    <Page
      title="Employer Register"
      subtitle={`${fmtNum(filtered.length)} employers`}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => setShowAdd(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>
            Add Employer
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        {[
          { label: 'Total Employers', value: fmtNum(employers.length), icon: 'corporate_fare', color: NAVY },
          { label: 'MOU Signed',      value: fmtNum(mouSigned),        icon: 'handshake',       color: GREEN },
          { label: 'Expiring Soon',   value: fmtNum(mouExpiring),      icon: 'warning',         color: AMBER },
          { label: 'Total Staff',     value: fmtNum(totalStaff),       icon: 'group',           color: '#7C3AED' },
        ].map(item => (
          <div key={item.label} style={{
            background: 'var(--card)', borderRadius: RADIUS.xl, padding: '14px 16px',
            border: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: RADIUS.lg, flexShrink: 0,
              background: `${item.color}12`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: item.color }}>{item.icon}</span>
            </div>
            <div>
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1 }}>{item.value}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3 }}>{item.label}</div>
            </div>
          </div>
        ))}
      </div>

      <SectionCard title="Employers" badge={employers.length} padding={false}>

        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'sector',
              label: 'Sector',
              options: uniqueSectors.map(s => ({
                value: s,
                count: employers.filter(e => e.sector === s).length,
              })),
              selected: fSectors,
              onChange: setFSectors,
            },
            {
              key: 'mou',
              label: 'MOU Status',
              options: MOU_STATUSES.map(s => ({
                value: s,
                color: MOU_COLORS[s],
                count: employers.filter(e => (e.mou_status?.toLowerCase() || 'none') === s).length,
              })),
              selected: fMOU,
              onChange: setFMOU,
            },
          ]}
          onReset={resetFilters}
          resultCount={filtered.length}
          totalCount={employers.length}
        />

        <DataTable<Employer>
          cols={cols}
          rows={pageRows}
          loading={loading}
          skeletonRows={8}
          emptyText="No employers registered yet"
          keyFn={r => r.id}
          onRowClick={r => setDetailRow(r)}
          selectable
          selectedIds={selected}
          onSelect={setSelected}
          bulkBar={
            <>
              <button onClick={() => { setBulkAgentId(''); setBulkNotes(''); setBulkAssignOpen(true) }} style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: 'none', background: NAVY, color: '#fff', cursor: 'pointer' }}>Bulk Assign</button>
            </>
          }
        />

        {/* Pagination footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {filtered.length === 0
              ? 'No employers'
              : `Showing ${showStart}–${showEnd} of ${filtered.length} employers`}
          </span>
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <PageBtn icon="chevron_left" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} />
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pg: number
                if (totalPages <= 7) pg = i + 1
                else if (safePage <= 4) pg = i + 1
                else if (safePage >= totalPages - 3) pg = totalPages - 6 + i
                else pg = safePage - 3 + i
                return <PageBtn key={pg} active={pg === safePage} onClick={() => setPage(pg)}>{pg}</PageBtn>
              })}
              <PageBtn icon="chevron_right" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} />
            </div>
          )}
        </div>

      </SectionCard>

      {showAdd && (
        <AddEmployerModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}

      {detailRow && (
        <EmployerDetailModal
          employer={detailRow}
          onClose={() => setDetailRow(null)}
        />
      )}

      {staffModal && (
        <StaffRosterModal
          employer={staffModal}
          onClose={() => setStaffModal(null)}
          onAssign={staff => {
            setAssignModal({ employer: staffModal, staff })
            setStaffModal(null)
          }}
        />
      )}

      {assignModal && (
        <AssignToSalesModal
          employer={assignModal.employer}
          staff={assignModal.staff}
          onClose={() => setAssignModal(null)}
          onDone={() => { setAssignModal(null); load() }}
        />
      )}

      {/* Bulk Assign Modal — assigns every selected employer (full company) to one agent */}
      <Modal
        open={bulkAssignOpen}
        title="Bulk Assign to Sales"
        width={460}
        onClose={() => { setBulkAssignOpen(false); setBulkAgentId(''); setBulkNotes('') }}
        footer={
          <>
            <button onClick={() => { setBulkAssignOpen(false); setBulkAgentId(''); setBulkNotes('') }} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={doBulkAssign} disabled={bulkSaving || !bulkAgentId} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (bulkSaving || !bulkAgentId) ? 'not-allowed' : 'pointer', opacity: (bulkSaving || !bulkAgentId) ? 0.6 : 1 }}>
              {bulkSaving && <Spinner size={14} color="#fff" />}
              {bulkSaving ? 'Assigning…' : `Assign ${selected.size} Employer${selected.size !== 1 ? 's' : ''}`}
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            {selected.size} employer{selected.size !== 1 ? 's' : ''} selected. Each will be assigned as a full company. All current and future staff go to the chosen agent.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Sales Agent *</label>
            <select value={bulkAgentId} onChange={e => setBulkAgentId(e.target.value)} style={{ ...IS, height: 36 }}>
              <option value="">Select agent…</option>
              {bulkAgents.map(a => <option key={a.id} value={String(a.id)}>{a.full_name}</option>)}
            </select>
            {bulkAgents.length === 0 && (
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>No sales agents found.</span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Notes</label>
            <textarea value={bulkNotes} onChange={e => setBulkNotes(e.target.value)} rows={3} placeholder="Optional context for the Sales Agent…" style={{ ...IS, height: 'auto', resize: 'vertical', padding: '8px 10px' }} />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
