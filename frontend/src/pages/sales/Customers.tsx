import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  ErrBanner, Spinner, KpiCard,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, RED, NUM } from '../../lib/design'

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
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${color}14`, color }}>
      {label}
    </span>
  )
}

function StatusPill({ status }: { status?: string }) {
  if (!status) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const s = STATUS_COLORS[status.toLowerCase()] ?? { color: '#6B7280', bg: 'rgba(75,85,99,.1)' }
  return (
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
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

  const [statusFilter, setStatusFilter]     = useState('')
  const [sourceFilter, setSourceFilter]     = useState('')
  const [assigneeFilter, setAssigneeFilter] = useState('')

  const [c360Open, setC360Open] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams({ limit: '200' })
      if (statusFilter)   p.set('status',      statusFilter)
      if (sourceFilter)   p.set('source',       sourceFilter)
      if (assigneeFilter) p.set('assigned_to',  assigneeFilter)

      const [res, us] = await Promise.all([
        apiFetch<{ data: Contact[]; total: number }>(`/api/crm/contacts?${p}`),
        apiFetch<CRMUser[]>('/api/crm/users'),
      ])
      setContacts(Array.isArray(res?.data) ? res.data : [])
      setTotal(res?.total ?? 0)
      setUsers(Array.isArray(us) ? us : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [statusFilter, sourceFilter, assigneeFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: ContactKPIs }>('/api/sales/contact-kpis')
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [])

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
      key: 'cif_number', label: 'CIF',
      render: r => r.cif_number
        ? <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.cif_number}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'first_name', label: 'Name',
      render: r => (
        <div onClick={() => navigate(`/sales/customers/${r.id}`)} style={{ cursor: 'pointer' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: NAVY }}>
            {r.first_name} {r.last_name}
          </div>
          {r.email && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.email}</div>}
        </div>
      ),
    },
    {
      key: 'phone', label: 'Phone',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)', fontFamily: 'monospace' }}>{r.phone ?? '—'}</span>,
    },
    { key: 'source',        label: 'Source',  render: r => <SourcePill source={r.source} /> },
    { key: 'assigned_name', label: 'Officer', render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.assigned_name ?? '—'}</span> },
    { key: 'status',        label: 'Status',  render: r => <StatusPill status={r.status} /> },
    {
      key: 'updated_at', label: 'Last Activity',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(r.updated_at)}</span>,
    },
  ]

  return (
    <Page title="CRM Contacts" subtitle={`${fmtNum(total)} total contacts`}>
      <ErrBanner error={err} onRetry={load} />

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
        <KpiCard label="Total Contacts" value={kpis ? fmtNum(kpis.total) : '—'} icon="contacts" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Active This Month" value={kpis ? fmtNum(kpis.active_this_month) : '—'} icon="how_to_reg" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="New This Month" value={kpis ? fmtNum(kpis.new_this_month) : '—'} icon="person_add" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Conversion Rate" value={kpis ? `${kpis.conversion_rate_pct.toFixed(1)}%` : '—'} icon="trending_up" accent={AMBER} loading={kpiLoading} />
      </div>

      <FilterBar onReset={() => { setStatusFilter(''); setSourceFilter(''); setAssigneeFilter('') }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="lead">Lead</option>
          <option value="prospect">Prospect</option>
          <option value="customer">Customer</option>
          <option value="inactive">Inactive</option>
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Sources</option>
          <option value="referral">Referral</option>
          <option value="walk_in">Walk-in</option>
          <option value="campaign">Campaign</option>
          <option value="digital">Digital</option>
          <option value="corporate">Corporate</option>
        </select>
        <select value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Officers</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </FilterBar>

      <SectionCard title="Contacts" badge={contacts.length} padding={false} actions={<button onClick={() => exportContactsCsv(contacts)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <DataTable<Contact>
          cols={cols}
          rows={contacts}
          keyFn={r => r.id}
          onRowClick={() => setC360Open(true)}
          emptyText="No contacts found."
          skeletonRows={loading ? 8 : 0}
          searchKeys={['first_name', 'last_name', 'email', 'phone']}
          searchPlaceholder="Search contacts…"
          pageSize={20}
        />
      </SectionCard>

      <Suspense fallback={null}>
        <C360 open={c360Open} onClose={() => setC360Open(false)} />
      </Suspense>
    </Page>
  )
}

