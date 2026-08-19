import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar, Modal, ConfirmModal,
  ErrBanner, Spinner, KpiCard, DateFilter, NameCell, ActionRow, StatusBadge,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtDatetime, fmtNum, monthStart, today } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, RED, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Contact {
  id: number
  first_name: string
  last_name: string
  phone?: string
  email?: string
  cif_number?: string
  status?: string
  source?: string
  source_type?: 'bd_assigned' | 'self_sourced'
  employer_name?: string
  assigned_name?: string
  updated_at: string
  deal_count?: number
  open_tasks?: number
}

interface CRMUser { id: number; full_name: string }

interface ContactKPIs {
  total: number
  active_this_month: number
  new_this_month: number
  conversion_rate_pct: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  referral: GREEN, campaign: AMBER, digital: BLUE, corporate: PURPLE,
  walk_in: NAVY, 'walk-in': NAVY,
}
const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  customer: { color: GREEN,  bg: 'rgba(22,163,74,.12)' },
  lead:     { color: BLUE,   bg: `${BLUE}12` },
  prospect: { color: AMBER,  bg: `${AMBER}18` },
  inactive: { color: '#6B7280', bg: 'rgba(75,85,99,.1)' },
}

function SourcePill({ source }: { source?: string }) {
  if (!source) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const color = SOURCE_COLORS[source.toLowerCase()] ?? RED
  const label = source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: `2px ${SP[2]}`, borderRadius: RADIUS['2xl'], background: `${color}14`, color }}>
      {label}
    </span>
  )
}

function StatusPill({ status }: { status?: string }) {
  if (!status) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const s = STATUS_COLORS[status.toLowerCase()] ?? { color: '#6B7280', bg: 'rgba(75,85,99,.1)' }
  return (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: s.bg, color: s.color }}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CRMContacts() {
  const navigate = useNavigate()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal]       = useState(0)
  const [users, setUsers]       = useState<CRMUser[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)
  const [kpis, setKpis]         = useState<ContactKPIs | null>(null)
  const [kpiLoading, setKpiLoading] = useState(true)

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const [search,        setSearch]        = useState('')
  const [fStatuses,     setFStatuses]     = useState<Set<string>>(new Set())
  const [fSources,      setFSources]      = useState<Set<string>>(new Set())
  const [fAssignees,    setFAssignees]    = useState<Set<string>>(new Set())
  const [fSourceTypes,  setFSourceTypes]  = useState<Set<string>>(new Set())

  const [bulkSel,  setBulkSel]  = useState<Set<string | number>>(new Set())

  // Edit contact modal
  const [editing,    setEditing]    = useState<Contact | null>(null)
  const [archiving,  setArchiving]  = useState<Contact | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [editForm,   setEditForm]   = useState({ first_name: '', last_name: '', phone: '', email: '', status: '' })
  const [editSaving, setEditSaving] = useState(false)

  // Bulk-assign modal
  const [assignOpen,   setAssignOpen]   = useState(false)
  const [assignTo,     setAssignTo]     = useState('')
  const [assignSaving, setAssignSaving] = useState(false)

  // Search runs on the SERVER (name, CIF, phone, email) so it spans every contact, not
  // just the first 500 that happen to be loaded. Debounced to one request per pause.
  const dq = useDebouncedValue(search, 300)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      // Leads page only shows pre-conversion contacts; customers live in My Accounts.
      const p = new URLSearchParams({ limit: '500', exclude_status: 'customer' })
      if (dq)       p.set('q', dq)
      if (dateFrom) p.set('from', dateFrom)
      if (dateTo)   p.set('to',   dateTo)

      const [res, us] = await Promise.all([
        apiFetch<{ data: Contact[]; total: number }>(`/api/crm/contacts?${p}`),
        apiFetch<CRMUser[]>('/api/crm/users'),
      ])
      setContacts(Array.isArray(res?.data) ? res.data : [])
      setTotal(res?.total ?? 0)
      setUsers(Array.isArray(us) ? us : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo, dq])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals','crm'] })

  const uniqueAssigneeNames = useMemo(
    () => [...new Set(contacts.map(c => c.assigned_name).filter(Boolean))] as string[],
    [contacts],
  )

  // Only facet filters run client-side now; the text search is served (see load), so a
  // server CIF/phone hit is never re-hidden by a narrower client-side text check.
  const filteredContacts = useMemo(() => contacts.filter(c => {
    if (fStatuses.size && (c.status == null || !fStatuses.has(c.status.toLowerCase()))) return false
    if (fSources.size && (c.source == null || !fSources.has(c.source.toLowerCase()))) return false
    if (fAssignees.size && (c.assigned_name == null || !fAssignees.has(c.assigned_name))) return false
    if (fSourceTypes.size && !fSourceTypes.has(c.source_type ?? 'self_sourced')) return false
    return true
  }), [contacts, fStatuses, fSources, fAssignees, fSourceTypes])

  function resetFilters() { setSearch(''); setFStatuses(new Set()); setFSources(new Set()); setFAssignees(new Set()); setFSourceTypes(new Set()) }

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: ContactKPIs }>(`/api/sales/contact-kpis?from=${dateFrom}&to=${dateTo}`)
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [dateFrom, dateTo])


  function openEdit(c: Contact) {
    setEditing(c)
    setEditForm({
      first_name: c.first_name ?? '', last_name: c.last_name ?? '',
      phone: c.phone ?? '', email: c.email ?? '', status: c.status ?? 'lead',
    })
  }

  async function saveEdit() {
    if (!editing) return
    setEditSaving(true)
    try {
      await apiPut(`/api/crm/contacts/${editing.id}`, {
        first_name: editForm.first_name,
        last_name:  editForm.last_name,
        phone:      editForm.phone,
        email:      editForm.email,
        status:     editForm.status,
      })
      toast.success('Contact updated')
      setEditing(null); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setEditSaving(false) }
  }

  async function confirmArchive() {
    if (!archiving) return
    setArchiveBusy(true)
    try {
      await apiFetch(`/api/crm/contacts/${archiving.id}`, { method: 'DELETE' })
      toast.success('Contact archived')
      setContacts(cs => cs.filter(x => x.id !== archiving.id))
      setArchiving(null)
    } catch (ex: any) { toast.error(ex.message) }
    finally { setArchiveBusy(false) }
  }

  async function bulkAssign() {
    if (!assignTo || bulkSel.size === 0) return
    setAssignSaving(true)
    try {
      await Promise.all([...bulkSel].map(id => apiPut(`/api/crm/contacts/${id}`, { assigned_to: Number(assignTo) })))
      toast.success(`${bulkSel.size} contact${bulkSel.size > 1 ? 's' : ''} assigned`)
      setAssignOpen(false); setAssignTo(''); setBulkSel(new Set()); load()
    } catch (ex: any) { toast.error(ex.message) }
    finally { setAssignSaving(false) }
  }

  const cols: TableCol<Contact>[] = [
    {
      key: 'first_name', label: 'Name',
      render: r => (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <NameCell name={`${r.first_name} ${r.last_name}`.trim()} sub={r.employer_name ?? r.email ?? null} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0, marginTop: 2 }}>
            {r.source_type === 'bd_assigned' && (
              <span style={{
                fontSize: 10, fontWeight: FW.bold, padding: '1px 5px',
                borderRadius: RADIUS.sm, background: `${PURPLE}18`, color: PURPLE, letterSpacing: '0.04em',
              }}>BD</span>
            )}
            {r.cif_number && (
              <span style={{
                fontSize: 10, fontWeight: FW.bold, padding: '1px 5px',
                borderRadius: RADIUS.sm, background: 'var(--th-bg)', color: 'var(--txt3)',
                fontFamily: 'monospace', letterSpacing: '0.02em',
              }}>{r.cif_number}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'phone', label: 'Phone',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'monospace' }}>{r.phone ?? '—'}</span>,
    },
    { key: 'source',        label: 'Source',  render: r => <SourcePill source={r.source} /> },
    { key: 'assigned_name', label: 'Officer', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.assigned_name ?? '—'}</span> },
    { key: 'status',        label: 'Status',  render: r => <StatusBadge status={r.status ?? '—'} /> },
    {
      key: 'updated_at', label: 'Last Activity',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDatetime(r.updated_at)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: r => <ActionRow actions={[
        { icon: 'visibility', label: 'View', onClick: () => navigate(`/sales/customers/${r.id}`) },
        { icon: 'edit', label: 'Edit', onClick: () => openEdit(r) },
        { icon: 'archive', label: 'Archive', danger: true, onClick: () => setArchiving(r) },
      ]} />,
    },
  ]

  return (
    <Page title="Contacts" subtitle={`${fmtNum(total)} contacts & prospects`}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Total Contacts" value={kpis ? fmtNum(kpis.total) : '—'} icon="contacts" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Active This Month" value={kpis ? fmtNum(kpis.active_this_month) : '—'} icon="how_to_reg" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="New This Month" value={kpis ? fmtNum(kpis.new_this_month) : '—'} icon="person_add" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Conversion Rate" value={kpis ? `${Number(kpis.conversion_rate_pct ?? 0).toFixed(1)}%` : '—'} icon="trending_up" accent={AMBER} loading={kpiLoading} />
      </div>

      <SectionCard title="Contacts & Prospects" badge={contacts.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          placeholder="Search contacts…"
          groups={[
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'lead',     label: 'Lead',     color: BLUE },
                { value: 'prospect', label: 'Prospect', color: AMBER },
                { value: 'inactive', label: 'Inactive', color: '#6B7280' },
              ],
              selected: fStatuses,
              onChange: setFStatuses,
            },
            {
              key: 'source',
              label: 'Source',
              options: [
                { value: 'referral',  label: 'Referral',  color: GREEN },
                { value: 'campaign',  label: 'Campaign',  color: AMBER },
                { value: 'digital',   label: 'Digital',   color: BLUE },
                { value: 'corporate', label: 'Corporate', color: PURPLE },
                { value: 'walk_in',   label: 'Walk-in',   color: NAVY },
              ],
              selected: fSources,
              onChange: setFSources,
            },
            {
              key: 'assignee',
              label: 'Officer',
              options: uniqueAssigneeNames.map(name => ({ value: name, avatarName: name })),
              selected: fAssignees,
              onChange: setFAssignees,
            },
            {
              key: 'source_type',
              label: 'Lead Source',
              options: [
                { value: 'self_sourced', label: 'Self-Sourced', color: NAVY,   count: contacts.filter(c => (c.source_type ?? 'self_sourced') === 'self_sourced').length },
                { value: 'bd_assigned',  label: 'BD Assigned',  color: PURPLE, count: contacts.filter(c => c.source_type === 'bd_assigned').length },
              ],
              selected: fSourceTypes,
              onChange: setFSourceTypes,
            },
          ]}
          onReset={resetFilters}
          resultCount={filteredContacts.length}
          totalCount={contacts.length}
        />
        <DataTable<Contact>
          cols={cols}
          rows={filteredContacts}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/sales/customers/${r.id}`)}
          emptyText="No contacts found."
          skeletonRows={loading ? 8 : 0}
          pageSize={20}
          selectable
          selectedIds={bulkSel}
          onSelect={setBulkSel}
          bulkBar={
            <>
              <button onClick={() => setAssignOpen(true)}
                style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>Bulk Assign</button>
            </>
          }
        />
      </SectionCard>

      {/* Edit contact modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Contact" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(null)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={saveEdit} disabled={editSaving} style={{ padding: '8px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: editSaving ? 'wait' : 'pointer', opacity: editSaving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {editSaving && <Spinner size={13} color="#fff" />}Save
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {([['First Name', 'first_name'], ['Last Name', 'last_name']] as const).map(([label, key]) => (
              <div key={key}>
                <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
                <input value={editForm[key]} onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))}
                  style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
              </div>
            ))}
          </div>
          {([['Phone', 'phone'], ['Email', 'email']] as const).map(([label, key]) => (
            <div key={key}>
              <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
              <input value={editForm[key]} onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))}
                style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
          ))}
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Status</label>
            <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}
              style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }}>
              {['lead', 'prospect', 'inactive'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>
        </div>
      </Modal>

      {/* Bulk-assign modal */}
      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title={`Assign ${bulkSel.size} contact${bulkSel.size > 1 ? 's' : ''}`} width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setAssignOpen(false)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={bulkAssign} disabled={assignSaving || !assignTo} style={{ padding: '8px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: assignSaving ? 'wait' : 'pointer', opacity: (assignSaving || !assignTo) ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {assignSaving && <Spinner size={13} color="#fff" />}Assign
            </button>
          </div>
        }
      >
        <div>
          <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Officer</label>
          <select value={assignTo} onChange={e => setAssignTo(e.target.value)}
            style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }}>
            <option value="">— Select officer —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
      </Modal>

      <ConfirmModal
        open={!!archiving}
        title="Archive contact"
        body={archiving ? `Archive ${`${archiving.first_name} ${archiving.last_name}`.trim()}? This removes them from the contact list.` : ''}
        confirmLabel="Archive"
        danger
        loading={archiveBusy}
        onConfirm={confirmArchive}
        onClose={() => setArchiving(null)}
      />
    </Page>
  )
}

