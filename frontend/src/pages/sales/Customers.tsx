import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Page, SectionCard, DataTable, Modal, ConfirmModal, ErrBanner, KpiCard,
  DateFilter, NameCell, ActionRow, TblSearch, EmptyState, Input, Button, Pill,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { SelectMenu, SelectMenuField, toOptions } from '../../components/SelectMenu'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { currentUser, isSalesHead, allRoles } from '../../hooks/useAuth'

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS — what this page is for
//
// It was a raw browser over crm_contacts with no gate and no owner scope: `1=1` in the
// handler, `exclude_status=customer` on the wire. That rendered 31,053 rows to anyone who
// could open it — 15,748 call-centre contacts and 15,305 Zoho Desk helpdesk TICKETS, of
// which exactly 185 had ever reached Sales — each with Edit, Archive and Bulk Assign. It
// was the same hole migration 302 closed on the Leads page, still open one route over.
// The gate and the scope now come from applyLeadScope, the same rules as Leads: one table,
// one mental model, and a rep who cannot see a contact as a lead cannot see it here.
//
// That leaves the real question — what is this page FOR, if Leads already exists?
//
//   Leads     = the work QUEUE. What is open, who owns it, what is due. Sorted by urgency.
//   My Book   = converted customers who now hold an account.
//   Contacts  = the DIRECTORY. Everyone Sales has ever dealt with, in every state —
//               open, converted, disqualified, dormant — searchable by name, phone, email
//               or CIF, with when they arrived, how they arrived and when they were last
//               touched.
//
// The question it answers is the one a rep asks before picking up the phone: "have we
// spoken to this person before, and who did?" Leads cannot answer it, because a lead
// leaves the queue the moment it is won or lost — which is exactly when the history
// starts being worth having. So this page deliberately does NOT exclude converted or
// disqualified contacts; that is its whole point.
//
// Also fixed: every facet filter on the old page was fiction. Status offered
// Lead/Prospect/Inactive when all 31,053 rows are status='lead' — prospect and inactive
// have never existed. Source offered Referral/Campaign/Digital/Corporate/Walk-In when the
// only two values in the column are 'call_centre' and 'zoho_desk'. So each filter either
// matched everything or nothing. They are now built from the columns that actually carry
// distinctions: sales_source (how it reached Sales) and the owner.
// ─────────────────────────────────────────────────────────────────────────────

interface Contact {
  id: number
  first_name: string
  last_name: string
  phone?: string
  email?: string
  cif_number?: string
  status?: string
  source?: string
  sales_source?: string
  sales_owner_id?: number | null
  sales_owner_name?: string | null
  sales_entered_at?: string | null
  converted_line?: string | null
  converted_ref?: string | null
  lead_stage?: string
  employer_name?: string
  assigned_name?: string
  updated_at: string
  open_tasks?: number
  sales_activity_count?: number
  last_touch_at?: string | null
}

interface CRMUser { id: number; full_name: string }

interface ContactKPIs {
  total: number
  active_this_month: number
  new_this_month: number
  conversion_rate_pct: number
}

/** How the contact reached Sales — the only source distinction that exists in the data. */
const SALES_SOURCES = [
  { value: 'call_centre',  label: 'Call Centre', hint: 'Forwarded by an agent' },
  { value: 'business_dev', label: 'Business Dev', hint: 'Raised by BD' },
  { value: 'self',         label: 'Self-Sourced', hint: 'Entered by the officer' },
]

const SOURCE_COLOR: Record<string, string> = {
  call_centre: BLUE, business_dev: PURPLE, self: NAVY,
}

/** Where the relationship stands. Derived, because no single column carries it. */
function relState(c: Contact): { label: string; color: string } {
  if (c.converted_line) return { label: 'Converted', color: GREEN }
  if (c.lead_stage === 'disqualified') return { label: 'Disqualified', color: '#6B7280' }
  if (!c.sales_owner_id) return { label: 'Unclaimed', color: AMBER }
  return { label: 'Open', color: BLUE }
}

const MGMT = new Set(['sales_head', 'head_sales', 'cmo', 'md', 'admin'])

/** First day of the month N months before this one, as YYYY-MM-DD. */
function monthsAgo(n: number): string {
  const d = new Date()
  // Day 1 before shifting the month: on the 31st, setMonth(-1) would land on a month
  // that has no 31st and roll forward, skipping a month.
  d.setDate(1)
  d.setMonth(d.getMonth() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function CRMContacts() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal]       = useState(0)
  const [users, setUsers]       = useState<CRMUser[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)
  const [kpis, setKpis]         = useState<ContactKPIs | null>(null)
  const [kpiLoading, setKpiLoading] = useState(true)

  const me = currentUser()
  const isHead = isSalesHead(me) || (!!me && allRoles(me).some(r => MGMT.has(r)))

  // A directory is read over the life of the relationship, not the current month. The
  // old default was monthStart()→today() on CREATED_AT, which hid every contact who
  // arrived before the 1st — on a page whose entire purpose is history.
  const [dateFrom, setDateFrom] = useState(monthsAgo(24))
  const [dateTo,   setDateTo]   = useState(todayStr())

  const [search, setSearch] = useState('')
  const salesSource = params.get('sales_source') ?? ''
  const owner       = params.get('owner_id') ?? ''

  const [bulkSel, setBulkSel] = useState<Set<string | number>>(new Set())

  const [editing,     setEditing]     = useState<Contact | null>(null)
  const [archiving,   setArchiving]   = useState<Contact | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [editForm,    setEditForm]    = useState({ first_name: '', last_name: '', phone: '', email: '' })
  const [editSaving,  setEditSaving]  = useState(false)

  const [assignOpen,   setAssignOpen]   = useState(false)
  const [assignTo,     setAssignTo]     = useState('')
  const [assignSaving, setAssignSaving] = useState(false)

  // Search runs on the SERVER (name, CIF, phone, email) so it spans the whole directory,
  // not just the rows that happen to be loaded. Debounced to one request per pause.
  const dq = useDebouncedValue(search, 300)

  function setParam(key: string, v: string) {
    setParams(prev => {
      const q = new URLSearchParams(prev)
      if (v) q.set(key, v); else q.delete(key)
      return q
    }, { replace: true })
  }

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      // No exclude_status. Converted and disqualified contacts are the history this page
      // exists to hold — dropping them is what made it a worse copy of Leads.
      const p = new URLSearchParams({ limit: '500' })
      if (dq)          p.set('q', dq)
      if (dateFrom)    p.set('from', dateFrom)
      if (dateTo)      p.set('to', dateTo)
      if (salesSource) p.set('sales_source', salesSource)
      if (owner)       p.set('owner_id', owner)

      const [res, us] = await Promise.all([
        apiFetch<{ data: Contact[]; total: number }>(`/api/crm/contacts?${p}`),
        apiFetch<CRMUser[]>('/api/crm/users'),
      ])
      setContacts(Array.isArray(res?.data) ? res.data : [])
      setTotal(res?.total ?? 0)
      setUsers(Array.isArray(us) ? us : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo, dq, salesSource, owner])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals','crm'] })

  useEffect(() => {
    setKpiLoading(true)
    const p = new URLSearchParams({ from: dateFrom, to: dateTo })
    if (owner) p.set('owner_id', owner)
    apiFetch<{ data: ContactKPIs }>(`/api/sales/contact-kpis?${p}`)
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [dateFrom, dateTo, owner])

  const counts = useMemo(() => {
    let converted = 0, unclaimed = 0
    contacts.forEach(c => {
      if (c.converted_line) converted++
      else if (!c.sales_owner_id) unclaimed++
    })
    return { converted, unclaimed }
  }, [contacts])

  function openEdit(c: Contact) {
    setEditing(c)
    setEditForm({
      first_name: c.first_name ?? '', last_name: c.last_name ?? '',
      phone: c.phone ?? '', email: c.email ?? '',
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
      // sales_owner_id, not assigned_to: assigned_to is the CALL CENTRE's owner column.
      // Writing it here moved the contact in the agent's queue and changed nothing in
      // Sales — the same column confusion migration 302 was written to end.
      await Promise.all([...bulkSel].map(id =>
        apiFetch(`/api/sales/leads/${id}`, {
          method: 'PATCH', body: JSON.stringify({ sales_owner_id: Number(assignTo) }),
        })))
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
          <NameCell name={`${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Unnamed'}
            sub={r.employer_name ?? r.email ?? null} />
          {r.cif_number && (
            <span style={{
              fontSize: 10, fontWeight: FW.bold, padding: '1px 5px', marginTop: 2, flexShrink: 0,
              borderRadius: RADIUS.sm, background: 'var(--th-bg)', color: 'var(--txt3)',
              fontFamily: 'monospace', letterSpacing: '0.02em',
            }}>{r.cif_number}</span>
          )}
        </div>
      ),
    },
    {
      key: 'phone', label: 'Phone',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'monospace' }}>{r.phone ?? '—'}</span>,
    },
    {
      key: 'sales_source', label: 'Came From',
      render: r => {
        if (!r.sales_source) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const meta = SALES_SOURCES.find(s => s.value === r.sales_source)
        const color = SOURCE_COLOR[r.sales_source] ?? NAVY
        return <Pill label={meta?.label ?? r.sales_source} color={color} bg={`${color}14`} />
      },
    },
    {
      key: 'sales_owner_name', label: 'Officer',
      render: r => r.sales_owner_name
        ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.sales_owner_name}</span>
        : <span style={{ fontSize: TEXT.sm, color: AMBER, fontWeight: FW.semibold }}>Unclaimed</span>,
    },
    {
      key: 'converted_line', label: 'Where It Stands',
      render: r => {
        const s = relState(r)
        return (
          <div>
            <Pill label={s.label} color={s.color} bg={`${s.color}14`} />
            {r.converted_line && r.converted_ref && (
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2, fontFamily: 'monospace' }}>
                {r.converted_ref}
              </div>
            )}
          </div>
        )
      },
    },
    {
      // The real trail lives in app.activities; the old page counted crm_activities,
      // which has never had a row written to it, so every contact looked untouched.
      key: 'last_touch_at', label: 'Last Touch',
      render: r => r.last_touch_at
        ? (
          <div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDatetime(r.last_touch_at)}</div>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
              {fmtNum(r.sales_activity_count ?? 0)} interaction{(r.sales_activity_count ?? 0) === 1 ? '' : 's'}
            </div>
          </div>
        )
        : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Never</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: r => <ActionRow actions={[
        { icon: 'open_in_new', label: 'Open Lead', onClick: () => navigate(`/sales/leads?open=${r.id}`) },
        { icon: 'visibility', label: 'Details', onClick: () => navigate(`/sales/customers/${r.id}`) },
        { icon: 'edit', label: 'Edit', onClick: () => openEdit(r) },
        { icon: 'archive', label: 'Archive', danger: true, onClick: () => setArchiving(r) },
      ]} />,
    },
  ]

  const filterRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <TblSearch value={search} onChange={setSearch} width={200}
        placeholder="Name, phone, email or CIF…" ariaLabel="Search the directory" />
      <SelectMenu value={salesSource} onChange={v => setParam('sales_source', v)}
        options={SALES_SOURCES} clearLabel="Any source" searchable={false}
        ariaLabel="How they reached Sales" style={{ width: 150 }} />
      {isHead && (
        <SelectMenu value={owner} onChange={v => setParam('owner_id', v)}
          options={toOptions(users, u => u.id, u => u.full_name)}
          clearLabel="All officers" ariaLabel="Officer" style={{ width: 170 }} />
      )}
    </div>
  )

  return (
    <Page title="Contacts"
      subtitle="Everyone Sales has dealt with — open, won or lost"
      loading={loading && contacts.length === 0}
      skeletonKpis={4}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="In The Directory" value={kpis ? fmtNum(kpis.total) : '—'} icon="contacts" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Touched This Month" value={kpis ? fmtNum(kpis.active_this_month) : '—'} icon="how_to_reg" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Arrived In Window" value={kpis ? fmtNum(kpis.new_this_month) : '—'} icon="person_add" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Converted" sub="On any product line"
          value={kpis ? `${Number(kpis.conversion_rate_pct ?? 0).toFixed(1)}%` : '—'}
          icon="trending_up" accent={AMBER} loading={kpiLoading} />
      </div>

      <SectionCard
        title="Directory"
        subtitle={`${fmtNum(total)} contact${total === 1 ? '' : 's'} · ${counts.converted} converted · ${counts.unclaimed} unclaimed on this page`}
        badge={contacts.length}
        padding={false}
        actions={filterRow}
      >
        {!loading && contacts.length === 0 ? (
          <EmptyState
            icon="contacts"
            title={search || salesSource || owner ? 'Nothing matches those filters' : 'No contacts yet'}
            description={
              search || salesSource || owner
                ? 'Try a wider date window — the directory is filtered to when contacts reached Sales, not when they were created.'
                : 'A contact appears here once it reaches Sales: forwarded by the call centre, raised by BD, or entered by an officer on the Leads page.'
            }
            action={{ label: 'Go To Leads', onClick: () => navigate('/sales/leads'), icon: 'arrow_forward' }}
          />
        ) : (
          <DataTable<Contact>
            cols={cols}
            rows={contacts}
            keyFn={r => r.id}
            onRowClick={r => navigate(`/sales/customers/${r.id}`)}
            emptyText="No contacts found."
            skeletonRows={loading ? 8 : 0}
            pageSize={20}
            selectable={isHead}
            selectedIds={bulkSel}
            onSelect={setBulkSel}
            bulkBar={
              <Button size="sm" variant="secondary" icon="person_add" onClick={() => setAssignOpen(true)}>
                Assign Officer
              </Button>
            }
          />
        )}
      </SectionCard>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Contact" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={editSaving} onClick={saveEdit}>Save</Button>
          </div>
        }
      >
        {/* Status is not editable here. It is derived from what actually happened to the
            lead — converted on a product line, disqualified, still open — and typing over
            it would make the directory disagree with the lead record it describes. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="First Name" value={editForm.first_name}
              onChange={e => setEditForm(f => ({ ...f, first_name: e.target.value }))} />
            <Input label="Last Name" value={editForm.last_name}
              onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))} />
          </div>
          <Input label="Phone" value={editForm.phone}
            onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} />
          <Input label="Email" value={editForm.email}
            onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
        </div>
      </Modal>

      <Modal open={assignOpen} onClose={() => setAssignOpen(false)}
        title={`Assign ${bulkSel.size} Contact${bulkSel.size > 1 ? 's' : ''}`} width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={assignSaving} disabled={!assignTo} onClick={bulkAssign}>Assign</Button>
          </div>
        }
      >
        <SelectMenuField label="Officer" value={assignTo} onChange={setAssignTo}
          options={toOptions(users, u => u.id, u => u.full_name)}
          placeholder="Select an officer"
          hint="Sets the sales owner, which is what decides whose Leads page it appears on." />
      </Modal>

      <ConfirmModal
        open={!!archiving}
        title="Archive Contact"
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
