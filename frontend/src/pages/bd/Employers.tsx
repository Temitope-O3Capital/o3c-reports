import { useEffect, useState, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Modal, Spinner, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, fmtNum } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

interface Employer {
  id: number; name: string; rc_number: string; sector: string
  mou_status: string; mou_signed_date: string; mou_expiry_date: string
  staff_count: number; active_loans: number; contact_name: string
  contact_email: string; contact_phone: string; address: string
  state: string; created_at: string
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
  name: string; rc_number: string; sector: string; address: string
  state: string; contact_name: string; contact_email: string; contact_phone: string
  staff_count: string; mou_status: string
}

const EMPTY_FORM: AddEmployerForm = {
  name: '', rc_number: '', sector: '', address: '', state: '',
  contact_name: '', contact_email: '', contact_phone: '',
  staff_count: '', mou_status: 'none',
}

function AddEmployerModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<AddEmployerForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const set = (k: keyof AddEmployerForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit() {
    if (!form.name.trim()) { toast.error('Employer name is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/bd/employers', {
        ...form,
        staff_count: form.staff_count ? Number(form.staff_count) : 0,
      })
      toast.success('Employer registered')
      onSaved()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to create employer')
    } finally {
      setSaving(false)
    }
  }

  const F = ({ label, k, type = 'text' }: { label: string; k: keyof AddEmployerForm; type?: string }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={form[k]} onChange={set(k)} style={IS} />
    </div>
  )

  return (
    <Modal
      open
      title="Register Employer"
      width={520}
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1/-1' }}><F label="Employer Name *" k="name" /></div>
        <F label="RC Number" k="rc_number" />
        <F label="Sector" k="sector" />
        <F label="State" k="state" />
        <F label="Staff Count" k="staff_count" type="number" />
        <div style={{ gridColumn: '1/-1' }}><F label="Address" k="address" /></div>
        <F label="Contact Name" k="contact_name" />
        <F label="Contact Phone" k="contact_phone" />
        <div style={{ gridColumn: '1/-1' }}><F label="Contact Email" k="contact_email" type="email" /></div>
        <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>MOU Status</label>
          <select value={form.mou_status} onChange={set('mou_status')} style={{ ...IS, height: 36 }}>
            <option value="none">None</option>
            <option value="pending">Pending</option>
            <option value="signed">Signed</option>
            <option value="expired">Expired</option>
          </select>
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
        {row('RC Number', employer.rc_number)}
        {row('Sector', employer.sector)}
        {row('State', employer.state)}
        {row('Address', employer.address)}
        {row('Staff Count', fmtNum(employer.staff_count))}
        {row('Active Loans', fmtNum(employer.active_loans))}
        {row('MOU Status', <span style={{ fontWeight: FW.semibold, color: mouColor, textTransform: 'capitalize' }}>{employer.mou_status || 'None'}</span>)}
        {row('MOU Signed', employer.mou_signed_date ? fmtDate(employer.mou_signed_date) : null)}
        {row('MOU Expiry', employer.mou_expiry_date ? fmtDate(employer.mou_expiry_date) : null)}
        <div style={{ marginTop: 14, padding: `${SP[3]} 14px`, borderRadius: RADIUS.lg, background: 'var(--th-bg)', border: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 8 }}>Contact</div>
          {row('Name', employer.contact_name)}
          {row('Phone', employer.contact_phone)}
          {row('Email', employer.contact_email)}
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
  const [search,     setSearch]     = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [fSectors,   setFSectors]   = useState<Set<string>>(new Set())
  const [fMOU,       setFMOU]       = useState<Set<string>>(new Set())
  const [fStates,    setFStates]    = useState<Set<string>>(new Set())
  const [page,       setPage]       = useState(1)
  const [selected,   setSelected]   = useState<Set<string | number>>(new Set())
  const [showAdd,    setShowAdd]    = useState(false)
  const [detailRow,  setDetailRow]  = useState<Employer | null>(null)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<Employer[]>('/api/bd/employers')
      setEmployers(data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load employers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const uniqueSectors = useMemo(() => [...new Set(employers.map(e => e.sector).filter(Boolean))].sort() as string[], [employers])
  const uniqueStates  = useMemo(() => [...new Set(employers.map(e => e.state).filter(Boolean))].sort() as string[], [employers])

  const activeFilterCount = fSectors.size + fMOU.size + fStates.size

  const filtered = useMemo(() => employers.filter(e => {
    if (fSectors.size && !fSectors.has(e.sector)) return false
    const mouKey = (e.mou_status?.toLowerCase() || 'none')
    if (fMOU.size && !fMOU.has(mouKey)) return false
    if (fStates.size && !fStates.has(e.state)) return false
    if (search) {
      const q = search.toLowerCase()
      if (!['name', 'rc_number', 'contact_name', 'state'].some(k => (e as any)[k]?.toLowerCase?.().includes(q))) return false
    }
    return true
  }), [employers, fSectors, fMOU, fStates, search])

  const totalStaff   = employers.reduce((s, e) => s + Number(e.staff_count ?? 0), 0)
  const mouSigned    = employers.filter(e => e.mou_status?.toLowerCase() === 'signed').length
  const mouExpiring  = employers.filter(e => {
    if (e.mou_status?.toLowerCase() !== 'signed' || !e.mou_expiry_date) return false
    const days = (new Date(e.mou_expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    return days >= 0 && days <= 90
  }).length

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart  = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd    = Math.min(safePage * PER_PAGE, filtered.length)

  useEffect(() => { setPage(1) }, [search, fSectors, fMOU, fStates])

  function toggleSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set)
    next.has(value) ? next.delete(value) : next.add(value)
    return next
  }

  function resetFilters() {
    setSearch(''); setFSectors(new Set()); setFMOU(new Set()); setFStates(new Set())
  }

  function exportEmployersCsv(data: Employer[]) {
    const header = ['Name', 'RC Number', 'Sector', 'State', 'MOU Status', 'MOU Expiry', 'Staff Count', 'Active Loans', 'Contact Name', 'Contact Phone', 'Contact Email', 'Created At']
    const lines = data.map(r => [
      `"${String(r.name ?? '').replace(/"/g, '""')}"`,
      r.rc_number ?? '',
      r.sector ?? '',
      r.state ?? '',
      r.mou_status ?? '',
      r.mou_expiry_date ?? '',
      r.staff_count != null ? String(r.staff_count) : '',
      r.active_loans != null ? String(r.active_loans) : '',
      `"${String(r.contact_name ?? '').replace(/"/g, '""')}"`,
      r.contact_phone ?? '',
      r.contact_email ?? '',
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `employers-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols: TableCol<Employer>[] = [
    {
      key: 'name', label: 'Employer', sortable: true,
      render: row => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: RADIUS.full, background: NAVY, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: TEXT.xs, fontWeight: FW.bold, color: '#fff', fontFamily: INTER,
          }}>{(row.name ?? '?').charAt(0).toUpperCase()}</div>
          <div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{row.name}</div>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: INTER }}>RC: {row.rc_number ?? '—'}</div>
          </div>
        </div>
      ),
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
      key: 'mou_expiry_date', label: 'MOU Expiry', sortable: true,
      render: row => {
        if (!row.mou_expiry_date) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const days = Math.ceil((new Date(row.mou_expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        const color = days < 30 ? RED : days < 90 ? AMBER : 'var(--txt2)'
        return (
          <div>
            <div style={{ fontSize: TEXT.sm, color }}>{fmtDate(row.mou_expiry_date)}</div>
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
      key: 'active_loans', label: 'Active Loans', sortable: true, align: 'right',
      render: row => <span style={NUM}>{fmtNum(row.active_loans)}</span>,
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
      key: 'state', label: 'State', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)', fontSize: TEXT.sm }}>{row.state ?? '—'}</span>,
    },
  ]

  return (
    <Page
      title="Employer Register"
      subtitle={`${fmtNum(filtered.length)} employers`}
      actions={
        <button
          onClick={() => setShowAdd(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>
          Add Employer
        </button>
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

      <SectionCard title="Employers" badge={employers.length} padding={false} actions={<button onClick={() => exportEmployersCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>

        {/* Filter bar */}
        <div style={{
          padding: '12px 18px',
          borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />

          <button
            onClick={() => setFilterOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: `6px ${SP[3]}`, borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
              border: `1.5px solid ${activeFilterCount > 0 ? RED : 'var(--input-bdr)'}`,
              background: 'transparent',
              color: activeFilterCount > 0 ? RED : 'var(--txt2)',
              cursor: 'pointer', fontFamily: SORA, position: 'relative',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
            Filters
            {activeFilterCount > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                width: 16, height: 16, borderRadius: RADIUS.full,
                background: RED, color: '#fff',
                fontSize: TEXT['2xs'], fontWeight: FW.bold, fontFamily: INTER,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{activeFilterCount}</span>
            )}
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length} of {employers.length}
            </span>
          </div>
        </div>

        {/* Expandable filter panel */}
        {filterOpen && (
          <div style={{ borderBottom: '1px solid var(--bdr)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '20px 20px 0' }}>

              {/* Sector */}
              <div style={{ paddingRight: 20, borderRight: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>SECTOR</div>
                {uniqueSectors.length === 0 ? (
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No sectors recorded</span>
                ) : uniqueSectors.map(s => {
                  const count = employers.filter(e => e.sector === s).length
                  return (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                      <input type="checkbox" checked={fSectors.has(s)} onChange={() => setFSectors(toggleSet(fSectors, s))}
                        style={{ accentColor: NAVY, width: 14, height: 14, cursor: 'pointer' }} />
                      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{s}</span>
                      <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                    </label>
                  )
                })}
              </div>

              {/* MOU Status */}
              <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>MOU STATUS</div>
                {MOU_STATUSES.map(s => {
                  const c = MOU_COLORS[s]
                  const count = employers.filter(e => (e.mou_status?.toLowerCase() || 'none') === s).length
                  return (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                      <input type="checkbox" checked={fMOU.has(s)} onChange={() => setFMOU(toggleSet(fMOU, s))}
                        style={{ accentColor: c, width: 14, height: 14, cursor: 'pointer' }} />
                      <span style={{
                        fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
                        background: `${c}18`, color: c, textTransform: 'capitalize',
                      }}>{s}</span>
                      <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                    </label>
                  )
                })}
              </div>

              {/* State */}
              <div style={{ paddingLeft: 20 }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>STATE</div>
                {uniqueStates.length === 0 ? (
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No states recorded</span>
                ) : uniqueStates.map(s => {
                  const count = employers.filter(e => e.state === s).length
                  return (
                    <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                      <input type="checkbox" checked={fStates.has(s)} onChange={() => setFStates(toggleSet(fStates, s))}
                        style={{ accentColor: RED, width: 14, height: 14, cursor: 'pointer' }} />
                      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{s}</span>
                      <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                    </label>
                  )
                })}
              </div>

            </div>

            <div style={{
              padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: SORA }}>
                {activeFilterCount === 0
                  ? `No filters applied — showing all ${employers.length} employers`
                  : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
              </span>
              <button onClick={resetFilters} style={{
                padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
              }}>Reset</button>
              <button onClick={() => setFilterOpen(false)} style={{
                marginLeft: 'auto', padding: '5px 16px', borderRadius: RADIUS.md,
                fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: 'none', background: RED, color: '#fff',
                cursor: 'pointer', fontFamily: SORA,
              }}>Apply · {filtered.length} results</button>
            </div>
          </div>
        )}

        {/* Active chips */}
        {!filterOpen && activeFilterCount > 0 && (
          <div style={{
            padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          }}>
            {[...fSectors].map(s => (
              <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: `${NAVY}12`, color: NAVY }}>
                {s}<span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setFSectors(toggleSet(fSectors, s))}>close</span>
              </span>
            ))}
            {[...fMOU].map(s => {
              const c = MOU_COLORS[s]
              return (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: `${c}18`, color: c, textTransform: 'capitalize' }}>
                  {s}<span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setFMOU(toggleSet(fMOU, s))}>close</span>
                </span>
              )
            })}
            {[...fStates].map(s => (
              <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                {s}<span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setFStates(toggleSet(fStates, s))}>close</span>
              </span>
            ))}
            <button onClick={resetFilters} style={{ marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', padding: 0, fontFamily: SORA }}>Clear all</button>
          </div>
        )}

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
              <button style={{
                padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
                cursor: 'pointer', fontFamily: SORA,
                border: 'none', background: NAVY, color: '#fff',
              }}>Assign Sales Officer</button>
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
    </Page>
  )
}
