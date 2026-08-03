import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, lazy, Suspense, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, Spinner, KpiCard, DateFilter, NameCell, ActionRow, StatusBadge,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum, monthStart, today } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, RED, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

const C360 = lazy(() => import('../../components/C360Drawer'))

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

  const [c360Open, setC360Open] = useState(false)
  const [bulkSel,  setBulkSel]  = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      // Leads page only shows pre-conversion contacts; customers live in My Accounts.
      const p = new URLSearchParams({ limit: '500', exclude_status: 'customer' })
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
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['deals','crm'] })

  const uniqueAssigneeNames = useMemo(
    () => [...new Set(contacts.map(c => c.assigned_name).filter(Boolean))] as string[],
    [contacts],
  )

  const filteredContacts = useMemo(() => contacts.filter(c => {
    if (fStatuses.size && (c.status == null || !fStatuses.has(c.status.toLowerCase()))) return false
    if (fSources.size && (c.source == null || !fSources.has(c.source.toLowerCase()))) return false
    if (fAssignees.size && (c.assigned_name == null || !fAssignees.has(c.assigned_name))) return false
    if (fSourceTypes.size && !fSourceTypes.has(c.source_type ?? 'self_sourced')) return false
    if (search) {
      const q = search.toLowerCase()
      if (!(
        c.first_name?.toLowerCase().includes(q) ||
        c.last_name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.includes(q) ||
        c.employer_name?.toLowerCase().includes(q)
      )) return false
    }
    return true
  }), [contacts, fStatuses, fSources, fAssignees, fSourceTypes, search])

  function resetFilters() { setSearch(''); setFStatuses(new Set()); setFSources(new Set()); setFAssignees(new Set()); setFSourceTypes(new Set()) }

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: ContactKPIs }>(`/api/sales/contact-kpis?from=${dateFrom}&to=${dateTo}`)
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [dateFrom, dateTo])

  function exportContactsCsv(data: Contact[]) {
    const header = ['CIF', 'First Name', 'Last Name', 'Email', 'Phone', 'Source', 'Status', 'Assigned', 'Updated At']
    const lines = data.map(r => [
      `"${String(r.cif_number ?? '').replace(/"/g, '""')}"`,
      `"${String(r.first_name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.last_name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.email ?? '').replace(/"/g, '""')}"`,
      r.phone ?? '',
      r.source ?? '',
      r.status ?? '',
      `"${String(r.assigned_name ?? '').replace(/"/g, '""')}"`,
      r.updated_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
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
        { icon: 'edit', label: 'Edit', onClick: () => {} },
        { icon: 'archive', label: 'Archive', onClick: () => {} },
      ]} />,
    },
  ]

  return (
    <Page title="Leads" subtitle={`${fmtNum(total)} leads & prospects`}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Total Contacts" value={kpis ? fmtNum(kpis.total) : '—'} icon="contacts" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Active This Month" value={kpis ? fmtNum(kpis.active_this_month) : '—'} icon="how_to_reg" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="New This Month" value={kpis ? fmtNum(kpis.new_this_month) : '—'} icon="person_add" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Conversion Rate" value={kpis ? `${kpis.conversion_rate_pct.toFixed(1)}%` : '—'} icon="trending_up" accent={AMBER} loading={kpiLoading} />
      </div>

      <SectionCard title="Leads & Prospects" badge={contacts.length} padding={false} actions={<button onClick={() => exportContactsCsv(filteredContacts)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
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
          onRowClick={() => setC360Open(true)}
          emptyText="No contacts found."
          skeletonRows={loading ? 8 : 0}
          pageSize={20}
          selectable
          selectedIds={bulkSel}
          onSelect={setBulkSel}
          bulkBar={
            <>
              <button style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>Export</button>
              <button style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>Bulk Assign</button>
            </>
          }
        />
      </SectionCard>

      <Suspense fallback={null}>
        <C360 open={c360Open} onClose={() => setC360Open(false)} />
      </Suspense>
    </Page>
  )
}

