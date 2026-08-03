import { useEffect, useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Modal, filterInputStyle, SearchInput, DateFilter, NameCell, ActionRow, StatusBadge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPatch, API, getCsrfToken } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, today, monthStart } from '../../lib/fmt'
import { RED, AMBER, GREEN, BLUE, NAVY, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

interface PipelineKPIs {
  total_leads: number
  this_month: number
  conversion_rate_pct: number
  avg_deal_kobo: number
}

type EntityType = 'company' | 'individual' | 'individual_at_company'

interface Lead {
  id: number
  title: string
  entity_type: EntityType | null
  company_name: string | null
  employer_name: string | null
  stage: string
  lead_type: string | null
  lead_score: number | null
  potential_value_kobo: number
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  assigned_name: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

const STAGES = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const

const STAGE_COLORS: Record<string, string> = {
  prospect: '#6B7280', qualified: BLUE, proposal: AMBER,
  negotiation: '#7C3AED', won: GREEN, lost: RED,
}

const AVATAR_PALETTE = [RED, BLUE, GREEN, AMBER, '#7C3AED', '#0891B2', '#DB2777', '#EA580C']

function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

function initials(name: string): string {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

function StagePill({ stage }: { stage: string }) {
  const c = STAGE_COLORS[stage] ?? '#6B7280'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
      background: `${c}18`, color: c, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{stage}</span>
  )
}

function AssignedCell({ name }: { name?: string | null }) {
  if (!name) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const ac = avatarColor(name)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div style={{
        width: 24, height: 24, borderRadius: RADIUS.full, background: ac, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', fontFamily: INTER,
      }}>{initials(name)}</div>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{name}</span>
    </div>
  )
}

function ScoreBar({ score }: { score?: number | null }) {
  if (score == null) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const color = score >= 75 ? GREEN : score >= 45 ? AMBER : RED
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div style={{ width: 56, height: 4, borderRadius: 2, background: 'var(--bdr)', flexShrink: 0 }}>
        <div style={{ width: `${Math.min(100, score)}%`, height: '100%', borderRadius: 2, background: color }} />
      </div>
      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }}>{score}</span>
    </div>
  )
}


function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 28, height: 28, borderRadius: RADIUS.sm,
        border: active ? 'none' : '1.5px solid var(--input-bdr)',
        background: active ? RED : 'transparent',
        color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
        fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
      }}
    >
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
    </button>
  )
}

function FormField({ label, value, onChange, fullWidth, type = 'text', placeholder, list }: {
  label: string; value: string; onChange: (v: string) => void; fullWidth?: boolean; type?: string; placeholder?: string; list?: string
}) {
  return (
    <div style={{ gridColumn: fullWidth ? '1/-1' : undefined, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={value} placeholder={placeholder} list={list} onChange={e => onChange(e.target.value)} style={{ ...filterInputStyle, height: 36 }} />
    </div>
  )
}

function SelectField({ label, value, onChange, options, fullWidth, placeholder }: {
  label: string; value: string; onChange: (v: string) => void
  options: readonly string[] | { value: string; label: string }[]; fullWidth?: boolean; placeholder?: string
}) {
  const opts = options.map(o => (typeof o === 'string' ? { value: o, label: o } : o))
  return (
    <div style={{ gridColumn: fullWidth ? '1/-1' : undefined, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ ...filterInputStyle, height: 36, cursor: 'pointer', textTransform: 'capitalize' }}>
        {placeholder && <option value="">{placeholder}</option>}
        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

// Product / loan-type vocabulary — O3 is multi-product (loans, FD, cards).
const PRODUCT_OPTIONS = [
  'Salary Loan', 'Business Loan', 'Personal Loan',
  'Fixed Deposit', 'Credit Card', 'Prepaid Card',
] as const

// Kanban grouping dimensions.
type GroupBy = 'stage' | 'product' | 'type'
const GROUP_LABELS: Record<GroupBy, string> = { stage: 'Stage', product: 'Product', type: 'Type' }

const BULK_ACTIONS = [
  { label: 'Assign to Sales', primary: true  },
  { label: 'Export',          primary: false },
  { label: 'Add to Campaign', primary: false },
  { label: 'Archive',         primary: false },
]

const PER_PAGE = 25

const EMPTY_LEAD = {
  entity_type: 'company' as EntityType,
  company_name: '', lead_type: '', stage: 'prospect',
  first_name: '', last_name: '', contact_email: '', contact_phone: '',
  potential_value_kobo: '', notes: '',
}

const ENTITY_LABELS: Record<EntityType, string> = {
  company: 'Company',
  individual: 'Individual',
  individual_at_company: 'Ind. at Company',
}
const ENTITY_ICONS: Record<EntityType, string> = {
  company: 'business',
  individual: 'person',
  individual_at_company: 'badge',
}

export default function BDPipeline() {
  const navigate = useNavigate()
  const [leads,      setLeads]      = useState<Lead[]>([])
  const [kpis,       setKpis]       = useState<PipelineKPIs | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState<string | null>(null)
  const [search,     setSearch]     = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [fStages,    setFStages]    = useState<Set<string>>(new Set())
  const [fTypes,     setFTypes]     = useState<Set<string>>(new Set())
  const [fAssignees, setFAssignees] = useState<Set<string>>(new Set())
  const [dateFrom,   setDateFrom]   = useState(monthStart())
  const [dateTo,     setDateTo]     = useState(today())
  const [page,       setPage]       = useState(1)
  const [selected,   setSelected]   = useState<Set<string | number>>(new Set())
  const [view,       setView]       = useState<'table' | 'kanban'>('table')
  const [groupBy,    setGroupBy]    = useState<GroupBy>('stage')
  const [dragId,     setDragId]     = useState<number | null>(null)
  const [dropCol,    setDropCol]    = useState<string | null>(null)
  const [employerNames, setEmployerNames] = useState<string[]>([])
  const [newOpen,    setNewOpen]    = useState(false)
  const [newForm,    setNewForm]    = useState(EMPTY_LEAD)
  const [saving,     setSaving]     = useState(false)
  const [detailLead,   setDetailLead]   = useState<Lead | null>(null)
  const [editingLead,  setEditingLead]  = useState<Lead | null>(null)
  const [activityLead, setActivityLead] = useState<Lead | null>(null)
  const [newTab,     setNewTab]     = useState<'manual' | 'csv'>('manual')
  const [csvFile,    setCsvFile]    = useState<File | null>(null)
  const [csvPreview, setCsvPreview] = useState<{ valid: number; invalid: number; errors: string[] } | null>(null)
  const [csvImporting, setCsvImporting] = useState(false)
  const csvFileRef = useRef<HTMLInputElement>(null)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const [data, kpiRes] = await Promise.all([
        apiFetch<{ data: Lead[] }>('/api/bd/leads?limit=500'),
        apiFetch<{ data: PipelineKPIs }>('/api/bd/pipeline-kpis'),
      ])
      setLeads(Array.isArray(data) ? data : (data?.data ?? []))
      setKpis(kpiRes.data)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load leads')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Employer name suggestions for the New Lead form (datalist).
  useEffect(() => {
    apiFetch<{ data: { name: string }[] }>('/api/bd/employers?limit=500')
      .then(r => setEmployerNames(((r as any)?.data ?? r ?? []).map((e: any) => e.name).filter(Boolean)))
      .catch(() => setEmployerNames([]))
  }, [])

  const uniqueTypes     = useMemo(() => [...new Set(leads.map(l => l.lead_type).filter(Boolean))] as string[], [leads])
  const uniqueAssignees = useMemo(() => [...new Set(leads.map(l => l.assigned_name).filter(Boolean))] as string[], [leads])

  const activeFilterCount = fStages.size + fTypes.size + fAssignees.size

  const filtered = useMemo(() => leads.filter(l => {
    if (fStages.size && !fStages.has(l.stage)) return false
    if (fTypes.size && l.lead_type != null && !fTypes.has(l.lead_type)) return false
    if (fAssignees.size && l.assigned_name != null && !fAssignees.has(l.assigned_name)) return false
    if (dateFrom && l.created_at.slice(0, 10) < dateFrom) return false
    if (dateTo && l.created_at.slice(0, 10) > dateTo) return false
    if (search) {
      const q = search.toLowerCase()
      if (!(['company_name', 'title', 'contact_name', 'employer_name'] as const).some(k => l[k]?.toLowerCase().includes(q))) return false
    }
    return true
  }), [leads, fStages, fTypes, fAssignees, dateFrom, dateTo, search])

  const totalValue  = filtered.reduce((s, l) => s + Number(l.potential_value_kobo ?? 0), 0)
  const totalPages  = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage    = Math.min(page, totalPages)
  const pageRows    = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart   = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd     = Math.min(safePage * PER_PAGE, filtered.length)

  useEffect(() => { setPage(1) }, [search, fStages, fTypes, fAssignees, dateFrom, dateTo])

  function toggleSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set)
    next.has(value) ? next.delete(value) : next.add(value)
    return next
  }

  function resetFilters() {
    setSearch(''); setFStages(new Set()); setFTypes(new Set()); setFAssignees(new Set())
  }

  function exportLeadsCsv(data: Lead[]) {
    const header = ['Title', 'Company', 'Contact', 'Type', 'Stage', 'Score', 'Est. Value', 'Assigned', 'Created At']
    const lines = data.map(r => [
      `"${String(r.title ?? '').replace(/"/g, '""')}"`,
      `"${String(r.company_name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.contact_name ?? '').replace(/"/g, '""')}"`,
      r.lead_type ?? '',
      r.stage ?? '',
      r.lead_score != null ? String(r.lead_score) : '',
      r.potential_value_kobo != null ? String(Number(r.potential_value_kobo) / 100) : '',
      `"${String(r.assigned_name ?? '').replace(/"/g, '""')}"`,
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  function downloadLeadTemplate() {
    const csv = [
      'entity_type,first_name,last_name,company_name,contact_email,contact_phone,lead_type,stage,potential_value_naira,notes',
      'company,Chidi,Okeke,Acme Limited,chidi@acme.ng,+2348001234567,Salary Loan,prospect,500000,',
      'individual,Fatima,Ibrahim,,fatima@email.ng,+2348091234567,Personal Loan,qualified,250000,Referred by staff',
      'individual_at_company,Bello,Ahmed,First Bank,bello@firstbank.ng,+2348071234567,Business Loan,prospect,1000000,',
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = 'leads-import-template.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  async function pickLeadCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvFile(file); setCsvPreview(null)
    const text = await file.text()
    const rows = text.split(/\r?\n/).filter(l => l.trim())
    if (rows.length < 2) {
      setCsvPreview({ valid: 0, invalid: 0, errors: ['No data rows found below the header.'] })
      if (csvFileRef.current) csvFileRef.current.value = ''
      return
    }
    // Header-aware validation: each row needs a name (company_name, contact_name, or first/last).
    const headers = rows[0].split(',').map(h => h.trim().toLowerCase())
    const at = (name: string) => headers.indexOf(name)
    const iCompany = at('company_name'), iContact = at('contact_name'), iFirst = at('first_name'), iLast = at('last_name')
    const cell = (cells: string[], i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : '')
    let valid = 0, invalid = 0
    const errors: string[] = []
    rows.slice(1).forEach((line, n) => {
      const cells = line.split(',')
      const hasName = cell(cells, iCompany) || cell(cells, iContact) || cell(cells, iFirst) || cell(cells, iLast)
      if (hasName) valid++
      else { invalid++; if (errors.length < 4) errors.push(`Row ${n + 2}: no company or contact name`) }
    })
    if (iCompany < 0 && iContact < 0 && iFirst < 0) errors.unshift('Missing a name column (company_name, contact_name, or first_name/last_name).')
    setCsvPreview({ valid, invalid, errors })
    if (csvFileRef.current) csvFileRef.current.value = ''
  }

  async function importLeadsCsv() {
    if (!csvFile) return
    setCsvImporting(true)
    try {
      const fd = new FormData(); fd.append('file', csvFile)
      const res = await fetch(`${API}/api/bd/leads/import`, {
        method: 'POST', credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        body: fd,
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}))
        throw new Error((msg as any)?.error ?? `HTTP ${res.status}`)
      }
      const data: { imported: number; skipped: number } = await res.json()
      toast.success(`Imported ${data.imported} leads${data.skipped > 0 ? ` (${data.skipped} skipped)` : ''}`)
      setNewOpen(false); setCsvFile(null); setCsvPreview(null); setNewTab('manual'); load()
    } catch (e: any) { toast.error(e.message ?? 'Import failed') }
    finally { setCsvImporting(false) }
  }

  async function doCreateLead() {
    const et = newForm.entity_type
    const contactName = `${newForm.first_name} ${newForm.last_name}`.trim()
    if (et === 'company' && !newForm.company_name.trim()) {
      toast.error('Organisation name is required'); return
    }
    if ((et === 'individual' || et === 'individual_at_company') && !contactName) {
      toast.error('First name is required'); return
    }
    if (et === 'individual_at_company' && !newForm.company_name.trim()) {
      toast.error('Company / Employer is required'); return
    }

    const base = {
      entity_type: et,
      stage: newForm.stage,
      lead_type: newForm.lead_type || null,
      contact_email: newForm.contact_email || null,
      contact_phone: newForm.contact_phone || null,
      notes: newForm.notes || null,
      potential_value_kobo: newForm.potential_value_kobo
        ? Math.round(Number(newForm.potential_value_kobo) * 100) : 0,
    }

    const extra =
      et === 'company'
        ? { title: newForm.company_name, company_name: newForm.company_name, contact_name: contactName || null }
      : et === 'individual'
        ? { title: contactName, contact_name: contactName, company_name: null }
      : /* individual_at_company */
        { title: contactName, contact_name: contactName, company_name: newForm.company_name, employer_name: newForm.company_name }

    setSaving(true)
    try {
      await apiPost('/api/bd/leads', { ...base, ...extra })
      toast.success('Lead created')
      setNewOpen(false); setNewForm(EMPTY_LEAD); load()
    } catch (e: any) { toast.error(e.message ?? 'Failed to create lead') }
    finally { setSaving(false) }
  }

  // ── Kanban grouping + drag-drop ───────────────────────────────────────────────
  const groupField: Record<GroupBy, 'stage' | 'lead_type' | 'entity_type'> = {
    stage: 'stage', product: 'lead_type', type: 'entity_type',
  }
  const groupVal = (l: Lead): string =>
    groupBy === 'stage' ? l.stage
    : groupBy === 'product' ? (l.lead_type ?? 'Unspecified')
    : (l.entity_type ?? 'company')

  const kanbanColumns = useMemo<{ key: string; label: string; color: string }[]>(() => {
    if (groupBy === 'stage')
      return STAGES.map(s => ({ key: s, label: s, color: STAGE_COLORS[s] }))
    if (groupBy === 'type')
      return (['company', 'individual', 'individual_at_company'] as EntityType[])
        .map((t, i) => ({ key: t, label: ENTITY_LABELS[t], color: AVATAR_PALETTE[i] }))
    // product — show the standard products present, plus any others in the data
    const present = new Set(filtered.map(l => l.lead_type ?? 'Unspecified'))
    const base = PRODUCT_OPTIONS.filter(p => present.has(p)) as string[]
    const extra = [...present].filter(p => !(PRODUCT_OPTIONS as readonly string[]).includes(p))
    const cols = base.concat(extra)
    return (cols.length ? cols : [...PRODUCT_OPTIONS]).map((p, i) => ({
      key: p, label: p, color: AVATAR_PALETTE[i % AVATAR_PALETTE.length],
    }))
  }, [groupBy, filtered])

  async function moveLead(id: number, toValue: string) {
    const field = groupField[groupBy]
    const stored = field === 'lead_type' && toValue === 'Unspecified' ? null : toValue
    const prev = leads
    setLeads(ls => ls.map(l => (l.id === id ? ({ ...l, [field]: stored } as Lead) : l)))
    try {
      await apiPatch(`/api/bd/leads/${id}`, { [field]: stored ?? '' })
      toast.success(`Moved to ${toValue}`)
    } catch {
      setLeads(prev)
      toast.error('Could not move lead')
    }
  }

  // ── Table columns ───────────────────────────────────────────────────────────

  const cols: TableCol<Lead>[] = [
    {
      key: 'company_name', label: 'Lead', sortable: true,
      render: row => {
        const et = row.entity_type ?? 'company'
        const primaryName = et === 'company' ? (row.company_name ?? row.title ?? '—') : (row.contact_name ?? row.title ?? '—')
        const sub = et === 'individual_at_company'
          ? (row.company_name ? `@ ${row.company_name}` : row.employer_name ?? null)
          : et === 'company' ? (row.contact_name ?? null)
          : (row.contact_email ?? null)
        return <NameCell name={primaryName} sub={sub} />
      },
    },
    {
      key: 'contact_name', label: 'Contact', sortable: true,
      render: row => {
        const et = row.entity_type ?? 'company'
        if (et !== 'company') return <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>
        return row.contact_name ? (
          <div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{row.contact_name}</div>
            {row.contact_email && (
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: INTER }}>{row.contact_email}</div>
            )}
          </div>
        ) : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
    {
      key: 'lead_type', label: 'Type', sortable: true,
      render: row => row.lead_type
        ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{row.lead_type}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'assigned_name', label: 'Assigned', sortable: true,
      render: row => <AssignedCell name={row.assigned_name} />,
    },
    {
      key: 'lead_score', label: 'Score', sortable: true,
      render: row => <ScoreBar score={row.lead_score} />,
    },
    {
      key: 'stage', label: 'Stage', sortable: true,
      render: row => <StatusBadge status={row.stage} />,
    },
    {
      key: 'potential_value_kobo', label: 'Est. Value', sortable: true, align: 'right',
      render: row => <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtKobo(row.potential_value_kobo)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: row => <ActionRow actions={[
        { icon: 'visibility', label: 'View', onClick: () => setDetailLead(row) },
        { icon: 'edit', label: 'Edit Stage', onClick: () => setEditingLead(row) },
        { icon: 'add_call', label: 'Log Activity', onClick: () => setActivityLead(row) },
      ]} />,
    },
  ]

  const kpiLoading = loading && !kpis

  // Segmented Table / Kanban switch — lives on the leads section header.
  const viewSwitch = (
    <div style={{ display: 'inline-flex', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 2, border: '1px solid var(--bdr)' }}>
      {(['table', 'kanban'] as const).map(v => (
        <button key={v} onClick={() => setView(v)} style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px',
          borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer',
          fontSize: TEXT.sm, fontWeight: view === v ? FW.semibold : FW.medium,
          background: view === v ? 'var(--card)' : 'transparent',
          color: view === v ? 'var(--txt)' : 'var(--txt2)',
          boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{v === 'table' ? 'table_rows' : 'view_kanban'}</span>
          {v === 'table' ? 'Table' : 'Kanban'}
        </button>
      ))}
    </div>
  )

  const groupBySwitch = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>Group by</span>
      <div style={{ display: 'inline-flex', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 2, border: '1px solid var(--bdr)' }}>
        {(['stage', 'product', 'type'] as GroupBy[]).map(g => (
          <button key={g} onClick={() => setGroupBy(g)} style={{
            padding: '5px 10px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer',
            fontSize: TEXT.sm, fontWeight: groupBy === g ? FW.semibold : FW.medium,
            background: groupBy === g ? 'var(--card)' : 'transparent',
            color: groupBy === g ? 'var(--txt)' : 'var(--txt2)',
            boxShadow: groupBy === g ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
          }}>{GROUP_LABELS[g]}</button>
        ))}
      </div>
    </div>
  )

  return (
    <Page
      title="BD Pipeline"
      subtitle={`${fmtNum(filtered.length)} leads · ${fmtKobo(totalValue)} total value`}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => setNewOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: RADIUS.md, border: 'none',
              background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>
            New Lead
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Leads" value={kpis ? fmtNum(kpis.total_leads) : '—'} icon="groups" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="This Month" value={kpis ? fmtNum(kpis.this_month) : '—'} icon="today" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Conversion Rate" value={kpis ? `${Number(kpis.conversion_rate_pct).toFixed(1)}%` : '—'} icon="trending_up" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Avg Deal Value ₦" value={kpis ? fmtKobo(kpis.avg_deal_kobo) : '—'} icon="monetization_on" accent={AMBER} loading={kpiLoading} />
      </div>

      {view === 'table' ? (

        <SectionCard title="All Leads" badge={leads.length} padding={false} actions={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{viewSwitch}<button onClick={() => exportLeadsCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button></div>}>

          {/* ── Filter bar ─────────────────────────────────────────────────── */}
          <div style={{
            padding: '10px 18px',
            borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />

            <button
              onClick={() => setFilterOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: `${SP[2]} 13px`, borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
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
                  minWidth: 17, height: 17, borderRadius: RADIUS.full,
                  background: RED, color: '#fff',
                  fontSize: TEXT['2xs'], fontWeight: FW.bold, fontFamily: INTER,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>{activeFilterCount}</span>
              )}
            </button>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{filtered.length} of {leads.length}</span>
              <button style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '7px 11px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>view_column</span>
                Columns
              </button>
            </div>
          </div>

          {/* ── Expandable filter panel ───────────────────────────────────── */}
          {filterOpen && (
            <div style={{ borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '20px 20px 0' }}>

                {/* Stage */}
                <div style={{ paddingRight: 20, borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>STAGE</div>
                  {STAGES.map(s => {
                    const c = STAGE_COLORS[s]
                    const count = leads.filter(l => l.stage === s).length
                    return (
                      <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={fStages.has(s)}
                          onChange={() => setFStages(toggleSet(fStages, s))}
                          style={{ accentColor: c, width: 14, height: 14, cursor: 'pointer' }}
                        />
                        <span style={{
                          fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
                          background: `${c}18`, color: c, textTransform: 'capitalize',
                        }}>{s}</span>
                        <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

                {/* Lead Type */}
                <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>TYPE</div>
                  {uniqueTypes.length === 0 ? (
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No types recorded</span>
                  ) : uniqueTypes.map(t => {
                    const count = leads.filter(l => l.lead_type === t).length
                    return (
                      <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={fTypes.has(t)}
                          onChange={() => setFTypes(toggleSet(fTypes, t))}
                          style={{ accentColor: RED, width: 14, height: 14, cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{t}</span>
                        <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

                {/* Assignee */}
                <div style={{ paddingLeft: 20 }}>
                  <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>ASSIGNEE</div>
                  {uniqueAssignees.length === 0 ? (
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No assignees</span>
                  ) : uniqueAssignees.map(name => {
                    const ac = avatarColor(name)
                    const count = leads.filter(l => l.assigned_name === name).length
                    return (
                      <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={fAssignees.has(name)}
                          onChange={() => setFAssignees(toggleSet(fAssignees, name))}
                          style={{ accentColor: ac, width: 14, height: 14, cursor: 'pointer' }}
                        />
                        <div style={{
                          width: 22, height: 22, borderRadius: RADIUS.full, background: ac, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', fontFamily: INTER,
                        }}>{initials(name)}</div>
                        <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{name}</span>
                        <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

              </div>

              {/* Panel footer */}
              <div style={{
                padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: SORA }}>
                  {activeFilterCount === 0
                    ? `No filters applied — showing all ${leads.length} leads`
                    : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
                </span>
                <button
                  onClick={resetFilters}
                  style={{
                    padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
                    border: '1.5px solid var(--input-bdr)', background: 'transparent',
                    color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
                  }}
                >Reset</button>
                <button
                  onClick={() => setFilterOpen(false)}
                  style={{
                    marginLeft: 'auto', padding: '5px 16px', borderRadius: RADIUS.md,
                    fontSize: TEXT.sm, fontWeight: FW.semibold,
                    border: 'none', background: RED, color: '#fff',
                    cursor: 'pointer', fontFamily: SORA,
                  }}
                >Apply · {filtered.length} results</button>
              </div>
            </div>
          )}

          {/* ── Active chips when panel is closed ───────────────────────────── */}
          {!filterOpen && activeFilterCount > 0 && (
            <div style={{
              padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            }}>
              {[...fStages].map(s => {
                const c = STAGE_COLORS[s]
                return (
                  <span key={s} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold,
                    background: `${c}18`, color: c,
                  }}>
                    {s}
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setFStages(toggleSet(fStages, s))}>close</span>
                  </span>
                )
              })}
              {[...fTypes].map(t => (
                <span key={t} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold,
                  background: 'rgba(192,0,0,0.10)', color: RED,
                }}>
                  {t}
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setFTypes(toggleSet(fTypes, t))}>close</span>
                </span>
              ))}
              {[...fAssignees].map(name => (
                <span key={name} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold,
                  background: 'var(--chip-bg)', color: 'var(--chip-txt)',
                }}>
                  {name}
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setFAssignees(toggleSet(fAssignees, name))}>close</span>
                </span>
              ))}
              <button
                onClick={resetFilters}
                style={{
                  marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer',
                  fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', padding: 0, fontFamily: SORA,
                }}
              >Clear all</button>
            </div>
          )}

          {/* ── Table ─────────────────────────────────────────────────────────── */}
          <DataTable<Lead>
            cols={cols}
            rows={pageRows}
            loading={loading}
            skeletonRows={8}
            emptyText="No leads match the current filters"
            keyFn={r => r.id}
            onRowClick={r => setDetailLead(r)}
            selectable
            selectedIds={selected}
            onSelect={setSelected}
            bulkBar={
              <>
                {BULK_ACTIONS.map(b => (
                  <button key={b.label} style={{
                    padding: '5px 12px', borderRadius: RADIUS.md,
                    fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA,
                    border: b.primary ? 'none' : '1.5px solid var(--input-bdr)',
                    background: b.primary ? RED : 'transparent',
                    color: b.primary ? '#fff' : 'var(--txt2)',
                  }}>{b.label}</button>
                ))}
              </>
            }
          />

          {/* ── Pagination footer ──────────────────────────────────────────────── */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 18px', borderTop: '1px solid var(--bdr)',
          }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length === 0
                ? 'No leads'
                : `Showing ${showStart}–${showEnd} of ${filtered.length} leads`
              }
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

      ) : (

        /* ── Kanban view ─────────────────────────────────────────────────────── */
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            {viewSwitch}
            {groupBySwitch}
            <div style={{ flex: 1 }} />
            <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length} of {leads.length}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
            {kanbanColumns.map(colDef => {
              const col = filtered.filter(l => groupVal(l) === colDef.key)
              const colValue = col.reduce((sum, l) => sum + Number(l.potential_value_kobo ?? 0), 0)
              const c = colDef.color
              const isDrop = dropCol === colDef.key
              return (
                <div key={colDef.key}
                  onDragOver={e => { e.preventDefault(); if (dropCol !== colDef.key) setDropCol(colDef.key) }}
                  onDragLeave={() => setDropCol(d => (d === colDef.key ? null : d))}
                  onDrop={e => { e.preventDefault(); setDropCol(null); if (dragId != null && groupVal(leads.find(l => l.id === dragId)!) !== colDef.key) moveLead(dragId, colDef.key); setDragId(null) }}
                  style={{
                    minWidth: 220, flex: '0 0 220px',
                    background: isDrop ? `${c}08` : 'var(--card)', borderRadius: RADIUS.xl,
                    border: isDrop ? `1.5px dashed ${c}` : '1px solid var(--bdr)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)', transition: 'border-color .12s, background .12s',
                  }}>
                  <div style={{
                    padding: '10px 14px', borderBottom: '1px solid var(--bdr)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', textTransform: 'capitalize' }}>{colDef.label}</span>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: c, background: `${c}14`, borderRadius: RADIUS.lg, padding: '1px 6px' }}>{col.length}</span>
                    </div>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(colValue)}</span>
                  </div>
                  <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 56, maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
                    {col.length === 0 ? (
                      <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>{isDrop ? 'Drop here' : 'No leads'}</div>
                    ) : col.map(lead => {
                      const nm = lead.company_name ?? lead.contact_name ?? lead.title ?? '?'
                      return (
                      <div
                        key={lead.id}
                        draggable
                        onDragStart={e => { setDragId(lead.id); e.dataTransfer.effectAllowed = 'move' }}
                        onDragEnd={() => { setDragId(null); setDropCol(null) }}
                        onClick={() => setDetailLead(lead)}
                        style={{
                          padding: '10px 12px', borderRadius: RADIUS.md,
                          background: 'var(--bg)', border: '1px solid var(--bdr)', cursor: 'grab',
                          opacity: dragId === lead.id ? 0.5 : 1,
                        }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.boxShadow = 'none'}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                          <div style={{ width: 22, height: 22, borderRadius: RADIUS.full, background: c, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', fontFamily: INTER }}>
                            {nm.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {nm}
                          </span>
                        </div>
                        {lead.contact_name && lead.company_name && (
                          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4 }}>{lead.contact_name}</div>
                        )}
                        <div style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY }}>{fmtKobo(lead.potential_value_kobo)}</div>
                        {lead.assigned_name && (
                          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>{lead.assigned_name}</div>
                        )}
                      </div>
                    )})}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* New Lead Modal */}
      <Modal
        open={newOpen}
        onClose={() => { setNewOpen(false); setNewForm(EMPTY_LEAD); setNewTab('manual'); setCsvFile(null); setCsvPreview(null) }}
        title="New Lead"
        width={460}
        footer={
          newTab === 'manual' ? (
            <>
              <button onClick={() => { setNewOpen(false); setNewForm(EMPTY_LEAD); setNewTab('manual') }} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doCreateLead} disabled={saving} style={{ padding: `${SP[2]} 18px`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Creating…' : 'Create Lead'}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => { setNewOpen(false); setCsvFile(null); setCsvPreview(null); setNewTab('manual') }} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
              <button onClick={importLeadsCsv} disabled={csvImporting || !csvFile || !csvPreview || csvPreview.valid === 0} style={{ padding: `${SP[2]} 18px`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (csvImporting || !csvFile || !csvPreview || csvPreview.valid === 0) ? 'not-allowed' : 'pointer', opacity: (csvImporting || !csvFile || !csvPreview || csvPreview.valid === 0) ? 0.6 : 1 }}>
                {csvImporting ? 'Importing…' : `Import ${csvPreview?.valid ?? 0} Leads`}
              </button>
            </>
          )
        }
      >
        {/* Tab switcher */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 18, borderBottom: '1px solid var(--bdr)' }}>
          {([
            { key: 'manual', label: 'Manual Entry', icon: 'edit' },
            { key: 'csv',    label: 'CSV Import',   icon: 'upload_file' },
          ] as const).map(t => (
            <button key={t.key} onClick={() => setNewTab(t.key)} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '9px 12px', fontSize: TEXT.sm, fontWeight: FW.semibold,
              border: 'none', cursor: 'pointer', background: 'transparent',
              color: newTab === t.key ? NAVY : 'var(--txt2)',
              borderBottom: newTab === t.key ? `2px solid ${NAVY}` : '2px solid transparent',
              marginBottom: -1,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {newTab === 'manual' ? (
          <>
            {/* Entity type toggle */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 18, padding: 4, background: 'var(--th-bg)', borderRadius: RADIUS.lg }}>
              {(['company', 'individual', 'individual_at_company'] as EntityType[]).map(et => {
                const active = newForm.entity_type === et
                return (
                  <button key={et} onClick={() => setNewForm(f => ({ ...f, entity_type: et }))} style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '7px 8px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: active ? FW.semibold : FW.medium,
                    border: 'none', cursor: 'pointer',
                    background: active ? 'var(--card)' : 'transparent',
                    color: active ? 'var(--txt)' : 'var(--txt2)',
                    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                    transition: 'all 0.12s',
                  }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{ENTITY_ICONS[et]}</span>
                    {ENTITY_LABELS[et]}
                  </button>
                )
              })}
            </div>

            <datalist id="bd-employer-list">
              {employerNames.map(n => <option key={n} value={n} />)}
            </datalist>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {newForm.entity_type === 'company' ? (<>
                <FormField label="Organisation Name *" fullWidth list="bd-employer-list" placeholder="Search or type…" value={newForm.company_name} onChange={v => setNewForm(f => ({ ...f, company_name: v }))} />
                <SelectField label="Product / Loan Type" placeholder="Select…" options={PRODUCT_OPTIONS} value={newForm.lead_type} onChange={v => setNewForm(f => ({ ...f, lead_type: v }))} />
                <SelectField label="Stage" options={STAGES} value={newForm.stage} onChange={v => setNewForm(f => ({ ...f, stage: v }))} />
                <FormField label="Contact First Name" value={newForm.first_name} onChange={v => setNewForm(f => ({ ...f, first_name: v }))} />
                <FormField label="Contact Last Name" value={newForm.last_name} onChange={v => setNewForm(f => ({ ...f, last_name: v }))} />
                <FormField label="Contact Email" value={newForm.contact_email} onChange={v => setNewForm(f => ({ ...f, contact_email: v }))} />
                <FormField label="Contact Phone" value={newForm.contact_phone} onChange={v => setNewForm(f => ({ ...f, contact_phone: v }))} />
                <FormField label="Est. Value (₦)" fullWidth value={newForm.potential_value_kobo} onChange={v => setNewForm(f => ({ ...f, potential_value_kobo: v }))} />
              </>) : newForm.entity_type === 'individual' ? (<>
                <FormField label="First Name *" value={newForm.first_name} onChange={v => setNewForm(f => ({ ...f, first_name: v }))} />
                <FormField label="Last Name" value={newForm.last_name} onChange={v => setNewForm(f => ({ ...f, last_name: v }))} />
                <SelectField label="Product / Loan Type" placeholder="Select…" options={PRODUCT_OPTIONS} value={newForm.lead_type} onChange={v => setNewForm(f => ({ ...f, lead_type: v }))} />
                <SelectField label="Stage" options={STAGES} value={newForm.stage} onChange={v => setNewForm(f => ({ ...f, stage: v }))} />
                <FormField label="Email" value={newForm.contact_email} onChange={v => setNewForm(f => ({ ...f, contact_email: v }))} />
                <FormField label="Phone" value={newForm.contact_phone} onChange={v => setNewForm(f => ({ ...f, contact_phone: v }))} />
                <FormField label="Est. Value (₦)" fullWidth value={newForm.potential_value_kobo} onChange={v => setNewForm(f => ({ ...f, potential_value_kobo: v }))} />
              </>) : (<>
                <FormField label="First Name *" value={newForm.first_name} onChange={v => setNewForm(f => ({ ...f, first_name: v }))} />
                <FormField label="Last Name" value={newForm.last_name} onChange={v => setNewForm(f => ({ ...f, last_name: v }))} />
                <FormField label="Company / Employer *" fullWidth list="bd-employer-list" placeholder="Search or type…" value={newForm.company_name} onChange={v => setNewForm(f => ({ ...f, company_name: v }))} />
                <SelectField label="Product / Loan Type" placeholder="Select…" options={PRODUCT_OPTIONS} value={newForm.lead_type} onChange={v => setNewForm(f => ({ ...f, lead_type: v }))} />
                <SelectField label="Stage" options={STAGES} value={newForm.stage} onChange={v => setNewForm(f => ({ ...f, stage: v }))} />
                <FormField label="Email" value={newForm.contact_email} onChange={v => setNewForm(f => ({ ...f, contact_email: v }))} />
                <FormField label="Phone" value={newForm.contact_phone} onChange={v => setNewForm(f => ({ ...f, contact_phone: v }))} />
                <FormField label="Est. Value (₦)" fullWidth value={newForm.potential_value_kobo} onChange={v => setNewForm(f => ({ ...f, potential_value_kobo: v }))} />
              </>)}
              <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Notes</label>
                <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                  value={newForm.notes}
                  onChange={e => setNewForm(f => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  style={{ ...filterInputStyle, height: 'auto', resize: 'vertical', padding: '8px 10px' }}
                />
              </div>
            </div>
          </>
        ) : (
          /* CSV import tab */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Template download */}
            <div style={{ background: 'var(--th-bg)', borderRadius: RADIUS.lg, padding: 14, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY, flexShrink: 0, marginTop: 1 }}>info</span>
              <div>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>CSV Format</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6 }}>
                  Required: <code>entity_type</code> (company / individual / individual_at_company) and a name — <code>company_name</code> and/or <code>first_name</code> + <code>last_name</code>.<br />
                  Optional: <code>contact_email</code>, <code>contact_phone</code>, <code>lead_type</code>, <code>stage</code>, <code>potential_value_naira</code>, <code>notes</code>
                </div>
                <button onClick={downloadLeadTemplate} style={{
                  marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '5px 10px', borderRadius: RADIUS.md, border: `1px solid ${NAVY}30`,
                  background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
                }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
                  Download Template
                </button>
              </div>
            </div>

            {/* File picker */}
            <input ref={csvFileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={pickLeadCsv} />
            <button
              onClick={() => csvFileRef.current?.click()}
              style={{
                padding: '20px', borderRadius: RADIUS.lg, border: `2px dashed var(--bdr)`, background: 'transparent',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'pointer',
                color: 'var(--txt2)', fontSize: TEXT.sm,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = NAVY; (e.currentTarget as HTMLButtonElement).style.color = NAVY }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--bdr)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--txt2)' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 32 }}>upload_file</span>
              <span>{csvFile ? csvFile.name : 'Click to select a CSV file'}</span>
              {!csvFile && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>or drag and drop here</span>}
            </button>

            {/* Preview */}
            {csvPreview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div style={{ background: `${GREEN}12`, borderRadius: RADIUS.md, padding: '12px 16px', textAlign: 'center' }}>
                    <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: GREEN }}>{csvPreview.valid}</div>
                    <div style={{ fontSize: TEXT.xs, color: GREEN, marginTop: 2 }}>Valid rows</div>
                  </div>
                  <div style={{ background: csvPreview.invalid > 0 ? `${RED}12` : `${NAVY}08`, borderRadius: RADIUS.md, padding: '12px 16px', textAlign: 'center' }}>
                    <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: csvPreview.invalid > 0 ? RED : 'var(--txt3)' }}>{csvPreview.invalid}</div>
                    <div style={{ fontSize: TEXT.xs, color: csvPreview.invalid > 0 ? RED : 'var(--txt3)', marginTop: 2 }}>Invalid rows</div>
                  </div>
                </div>
                {csvPreview.errors.length > 0 && (
                  <div style={{ background: `${RED}0A`, border: `1px solid ${RED}22`, borderRadius: RADIUS.md, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {csvPreview.errors.map((er, i) => (
                      <div key={i} style={{ fontSize: TEXT.xs, color: RED }}>{er}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Lead Detail Modal */}
      <Modal
        open={!!detailLead}
        onClose={() => setDetailLead(null)}
        title={
          detailLead
            ? (detailLead.entity_type !== 'company'
                ? (detailLead.contact_name ?? detailLead.title ?? 'Lead Detail')
                : (detailLead.company_name ?? detailLead.title ?? 'Lead Detail'))
            : 'Lead Detail'
        }
        width={520}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => {
                if (!detailLead) return
                const params = new URLSearchParams()
                if (detailLead.contact_name) params.set('contact', detailLead.contact_name)
                if (detailLead.company_name) params.set('employer', detailLead.company_name)
                if (detailLead.lead_type)    params.set('product', detailLead.lead_type)
                navigate(`/sales/applications/new?${params.toString()}`)
              }}
              style={{ padding: `${SP[2]} 18px`, borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}
            >
              Create Application
            </button>
            <button onClick={() => setDetailLead(null)} style={{ padding: `${SP[2]} 18px`, borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>Close</button>
          </div>
        }
      >
        {detailLead && (() => {
          const et = detailLead.entity_type ?? 'company'
          const fields: { label: string; value: string | null | undefined }[] = [
            { label: 'Entity',      value: ENTITY_LABELS[et as EntityType] ?? et },
            et !== 'individual'
              ? { label: 'Company', value: detailLead.company_name }
              : { label: 'Email',   value: detailLead.contact_email },
            et === 'company'
              ? { label: 'Contact', value: detailLead.contact_name }
              : { label: 'Phone',   value: detailLead.contact_phone },
            { label: 'Product Type', value: detailLead.lead_type },
            { label: 'Assigned',     value: detailLead.assigned_name },
            et === 'company'
              ? { label: 'Email',  value: detailLead.contact_email }
              : { label: 'Contact', value: null },
            et === 'company'
              ? { label: 'Phone',  value: detailLead.contact_phone }
              : { label: 'X',      value: null },
            { label: 'Est. Value',  value: fmtKobo(detailLead.potential_value_kobo) },
            { label: 'Score',       value: detailLead.lead_score != null ? String(detailLead.lead_score) : null },
            { label: 'Date Added',  value: fmtDate(detailLead.created_at) },
          ]
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <StagePill stage={detailLead.stage} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
                {fields.filter(f => f.value && f.label !== 'X').map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{value}</div>
                  </div>
                ))}
              </div>
              {detailLead.notes && (
                <div style={{ marginTop: 4, padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)', fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.5 }}>
                  {detailLead.notes}
                </div>
              )}
            </div>
          )
        })()}
      </Modal>
    </Page>
  )
}
