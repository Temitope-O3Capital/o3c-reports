import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Modal, filterInputStyle, SearchInput, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, today, monthStart } from '../../lib/fmt'
import { RED, AMBER, GREEN, BLUE, NAVY, INTER, SORA, NUM } from '../../lib/design'
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
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
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
        width: 24, height: 24, borderRadius: '50%', background: ac, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9.5, fontWeight: 700, color: '#fff', fontFamily: INTER,
      }}>{initials(name)}</div>
      <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{name}</span>
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
      <span style={{ ...NUM, fontSize: 12.5, color: 'var(--txt)' }}>{score}</span>
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
        width: 28, height: 28, borderRadius: 6,
        border: active ? 'none' : '1.5px solid var(--input-bdr)',
        background: active ? RED : 'transparent',
        color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
        fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
      }}
    >
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span> : children}
    </button>
  )
}

function FormField({ label, value, onChange, fullWidth, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; fullWidth?: boolean; type?: string
}) {
  return (
    <div style={{ gridColumn: fullWidth ? '1/-1' : undefined, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} style={{ ...filterInputStyle, height: 36 }} />
    </div>
  )
}

const BULK_ACTIONS = [
  { label: 'Assign to Sales', primary: true  },
  { label: 'Export',          primary: false },
  { label: 'Add to Campaign', primary: false },
  { label: 'Archive',         primary: false },
]

const PER_PAGE = 25

const EMPTY_LEAD = {
  entity_type: 'company' as EntityType,
  title: '', company_name: '', lead_type: '', stage: 'prospect',
  contact_name: '', contact_email: '', contact_phone: '',
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
  const [newOpen,    setNewOpen]    = useState(false)
  const [newForm,    setNewForm]    = useState(EMPTY_LEAD)
  const [saving,     setSaving]     = useState(false)
  const [detailLead, setDetailLead] = useState<Lead | null>(null)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const [data, kpiRes] = await Promise.all([
        apiFetch<Lead[]>('/api/bd/leads?limit=500'),
        apiFetch<{ data: PipelineKPIs }>('/api/bd/pipeline-kpis'),
      ])
      setLeads(data ?? [])
      setKpis(kpiRes.data)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load leads')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

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

  async function doCreateLead() {
    const et = newForm.entity_type
    if (et === 'company' && !newForm.company_name.trim()) {
      toast.error('Organisation name is required'); return
    }
    if ((et === 'individual' || et === 'individual_at_company') && !newForm.contact_name.trim()) {
      toast.error('Full name is required'); return
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
        ? { title: newForm.company_name, company_name: newForm.company_name, contact_name: newForm.contact_name || null }
      : et === 'individual'
        ? { title: newForm.contact_name, contact_name: newForm.contact_name, company_name: null }
      : /* individual_at_company */
        { title: newForm.contact_name, contact_name: newForm.contact_name, company_name: newForm.company_name, employer_name: newForm.company_name }

    setSaving(true)
    try {
      await apiPost('/api/bd/leads', { ...base, ...extra })
      toast.success('Lead created')
      setNewOpen(false); setNewForm(EMPTY_LEAD); load()
    } catch (e: any) { toast.error(e.message ?? 'Failed to create lead') }
    finally { setSaving(false) }
  }

  // ── Table columns ───────────────────────────────────────────────────────────

  const cols: TableCol<Lead>[] = [
    {
      key: 'company_name', label: 'Lead', sortable: true,
      render: row => {
        const et = row.entity_type ?? 'company'
        const primaryName =
          et === 'company' ? (row.company_name ?? row.title ?? '—')
          : (row.contact_name ?? row.title ?? '—')
        const subName =
          et === 'individual_at_company' ? (row.company_name ?? row.employer_name)
          : et === 'company' ? row.contact_name
          : null
        const color = STAGE_COLORS[row.stage] ?? '#6B7280'
        const icon = ENTITY_ICONS[et as EntityType] ?? 'business'
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: et === 'company' ? 8 : '50%', background: color, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: et === 'company' ? 11 : 14, fontWeight: 700, color: '#fff',
            }}>
              {et === 'company'
                ? <span style={{ fontSize: 11, fontWeight: 700, fontFamily: INTER }}>{primaryName.charAt(0).toUpperCase()}</span>
                : <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{icon}</span>
              }
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', lineHeight: 1.3, fontFamily: SORA }}>{primaryName}</span>
              </div>
              {subName && (
                <div style={{ fontSize: 10.5, color: 'var(--txt2)', fontFamily: INTER }}>
                  {et === 'individual_at_company' ? `@ ${subName}` : subName}
                </div>
              )}
            </div>
          </div>
        )
      },
    },
    {
      key: 'contact_name', label: 'Contact', sortable: true,
      render: row => {
        const et = row.entity_type ?? 'company'
        if (et !== 'company') return <span style={{ color: 'var(--txt3)', fontSize: 12 }}>—</span>
        return row.contact_name ? (
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)', fontFamily: SORA }}>{row.contact_name}</div>
            {row.contact_email && (
              <div style={{ fontSize: 10.5, color: 'var(--txt2)', fontFamily: INTER }}>{row.contact_email}</div>
            )}
          </div>
        ) : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
    {
      key: 'lead_type', label: 'Type', sortable: true,
      render: row => row.lead_type
        ? <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{row.lead_type}</span>
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
      render: row => <StagePill stage={row.stage} />,
    },
    {
      key: 'potential_value_kobo', label: 'Est. Value', sortable: true, align: 'right',
      render: row => <span style={{ ...NUM, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(row.potential_value_kobo)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: () => (
        <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
          {(['call', 'mail', 'swap_horiz'] as const).map(ic => (
            <button
              key={ic}
              style={{
                width: 28, height: 28, borderRadius: 7,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: 'var(--txt2)',
              }}
              onMouseEnter={e => {
                const el = e.currentTarget
                el.style.borderColor = ic === 'swap_horiz' ? RED : 'var(--txt2)'
                el.style.color = ic === 'swap_horiz' ? RED : 'var(--txt)'
              }}
              onMouseLeave={e => {
                const el = e.currentTarget
                el.style.borderColor = 'var(--input-bdr)'
                el.style.color = 'var(--txt2)'
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{ic}</span>
            </button>
          ))}
        </div>
      ),
    },
  ]

  const byStage = (s: string) => filtered.filter(l => l.stage === s)

  const kpiLoading = loading && !kpis

  return (
    <Page
      title="BD Pipeline"
      subtitle={`${fmtNum(filtered.length)} leads · ${fmtKobo(totalValue)} total value`}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => setView(v => v === 'table' ? 'kanban' : 'table')}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              border: '1px solid var(--bdr)', background: 'var(--card)',
              color: 'var(--txt)', cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>
              {view === 'table' ? 'view_kanban' : 'table_rows'}
            </span>
            {view === 'table' ? 'Kanban' : 'Table'}
          </button>
          <button
            onClick={() => setNewOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8, border: 'none',
              background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Total Leads" value={kpis ? fmtNum(kpis.total_leads) : '—'} icon="groups" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="This Month" value={kpis ? fmtNum(kpis.this_month) : '—'} icon="today" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Conversion Rate" value={kpis ? `${kpis.conversion_rate_pct.toFixed(1)}%` : '—'} icon="trending_up" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Avg Deal Value ₦" value={kpis ? fmtKobo(kpis.avg_deal_kobo) : '—'} icon="monetization_on" accent={AMBER} loading={kpiLoading} />
      </div>

      {view === 'table' ? (

        <SectionCard title="All Leads" badge={leads.length} padding={false} actions={<button onClick={() => exportLeadsCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>

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
                padding: '8px 13px', borderRadius: 9, fontSize: 12.5, fontWeight: 600,
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
                  minWidth: 17, height: 17, borderRadius: 99,
                  background: RED, color: '#fff',
                  fontSize: 10, fontWeight: 700, fontFamily: INTER,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>{activeFilterCount}</span>
              )}
            </button>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER }}>{filtered.length} of {leads.length}</span>
              <button style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '7px 11px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>view_column</span>
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
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>STAGE</div>
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
                          fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
                          background: `${c}18`, color: c, textTransform: 'capitalize',
                        }}>{s}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

                {/* Lead Type */}
                <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>TYPE</div>
                  {uniqueTypes.length === 0 ? (
                    <span style={{ fontSize: 12, color: 'var(--txt3)' }}>No types recorded</span>
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
                        <span style={{ fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA }}>{t}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

                {/* Assignee */}
                <div style={{ paddingLeft: 20 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>ASSIGNEE</div>
                  {uniqueAssignees.length === 0 ? (
                    <span style={{ fontSize: 12, color: 'var(--txt3)' }}>No assignees</span>
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
                          width: 22, height: 22, borderRadius: '50%', background: ac, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 8.5, fontWeight: 700, color: '#fff', fontFamily: INTER,
                        }}>{initials(name)}</div>
                        <span style={{ fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA }}>{name}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
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
                <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>
                  {activeFilterCount === 0
                    ? `No filters applied — showing all ${leads.length} leads`
                    : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
                </span>
                <button
                  onClick={resetFilters}
                  style={{
                    padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                    border: '1.5px solid var(--input-bdr)', background: 'transparent',
                    color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
                  }}
                >Reset</button>
                <button
                  onClick={() => setFilterOpen(false)}
                  style={{
                    marginLeft: 'auto', padding: '5px 16px', borderRadius: 7,
                    fontSize: 12, fontWeight: 600,
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
                    padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                    background: `${c}18`, color: c,
                  }}>
                    {s}
                    <span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setFStages(toggleSet(fStages, s))}>close</span>
                  </span>
                )
              })}
              {[...fTypes].map(t => (
                <span key={t} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                  background: 'rgba(192,0,0,0.10)', color: RED,
                }}>
                  {t}
                  <span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setFTypes(toggleSet(fTypes, t))}>close</span>
                </span>
              ))}
              {[...fAssignees].map(name => (
                <span key={name} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                  background: 'var(--chip-bg)', color: 'var(--chip-txt)',
                }}>
                  {name}
                  <span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setFAssignees(toggleSet(fAssignees, name))}>close</span>
                </span>
              ))}
              <button
                onClick={resetFilters}
                style={{
                  marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer',
                  fontSize: 11.5, fontWeight: 600, color: 'var(--txt3)', padding: 0, fontFamily: SORA,
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
                    padding: '5px 12px', borderRadius: 7,
                    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SORA,
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
            <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
            <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length} of {leads.length}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
            {STAGES.map(s => {
              const col = byStage(s)
              const colValue = col.reduce((sum, l) => sum + Number(l.potential_value_kobo ?? 0), 0)
              const c = STAGE_COLORS[s]
              return (
                <div key={s} style={{
                  minWidth: 220, flex: '0 0 220px',
                  background: 'var(--card)', borderRadius: 12,
                  border: '1px solid var(--bdr)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                }}>
                  <div style={{
                    padding: '10px 14px', borderBottom: '1px solid var(--bdr)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)', textTransform: 'capitalize' }}>{s}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: c, background: `${c}14`, borderRadius: 10, padding: '1px 6px' }}>{col.length}</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(colValue)}</span>
                  </div>
                  <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
                    {col.length === 0 ? (
                      <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--txt3)', fontSize: 12 }}>No leads</div>
                    ) : col.map(lead => (
                      <div
                        key={lead.id}
                        style={{
                          padding: '10px 12px', borderRadius: 8,
                          background: 'var(--bg)', border: '1px solid var(--bdr)', cursor: 'pointer',
                        }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.boxShadow = 'none'}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                          <div style={{ width: 22, height: 22, borderRadius: '50%', background: c, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff', fontFamily: INTER }}>
                            {(lead.company_name ?? lead.title ?? '?').charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {lead.company_name ?? lead.title}
                          </span>
                        </div>
                        {lead.contact_name && (
                          <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 4 }}>{lead.contact_name}</div>
                        )}
                        <div style={{ ...NUM, fontSize: 11.5, fontWeight: 600, color: NAVY }}>{fmtKobo(lead.potential_value_kobo)}</div>
                        {lead.assigned_name && (
                          <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 4 }}>{lead.assigned_name}</div>
                        )}
                      </div>
                    ))}
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
        onClose={() => { setNewOpen(false); setNewForm(EMPTY_LEAD) }}
        title="New Lead"
        width={520}
        footer={
          <>
            <button onClick={() => { setNewOpen(false); setNewForm(EMPTY_LEAD) }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={doCreateLead} disabled={saving} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Creating…' : 'Create Lead'}
            </button>
          </>
        }
      >
        {/* Entity type toggle */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 18, padding: 4, background: 'var(--th-bg)', borderRadius: 10 }}>
          {(['company', 'individual', 'individual_at_company'] as EntityType[]).map(et => {
            const active = newForm.entity_type === et
            return (
              <button key={et} onClick={() => setNewForm(f => ({ ...f, entity_type: et }))} style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '7px 8px', borderRadius: 7, fontSize: 12, fontWeight: active ? 600 : 500,
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {newForm.entity_type === 'company' ? (<>
            <FormField label="Organisation Name *" fullWidth value={newForm.company_name} onChange={v => setNewForm(f => ({ ...f, company_name: v }))} />
            <FormField label="Product / Loan Type" value={newForm.lead_type} onChange={v => setNewForm(f => ({ ...f, lead_type: v }))} />
            <FormField label="Contact Person" value={newForm.contact_name} onChange={v => setNewForm(f => ({ ...f, contact_name: v }))} />
            <FormField label="Contact Email" value={newForm.contact_email} onChange={v => setNewForm(f => ({ ...f, contact_email: v }))} />
            <FormField label="Contact Phone" value={newForm.contact_phone} onChange={v => setNewForm(f => ({ ...f, contact_phone: v }))} />
            <FormField label="Est. Value (₦)" value={newForm.potential_value_kobo} onChange={v => setNewForm(f => ({ ...f, potential_value_kobo: v }))} />
          </>) : newForm.entity_type === 'individual' ? (<>
            <FormField label="Full Name *" fullWidth value={newForm.contact_name} onChange={v => setNewForm(f => ({ ...f, contact_name: v }))} />
            <FormField label="Product / Loan Type" value={newForm.lead_type} onChange={v => setNewForm(f => ({ ...f, lead_type: v }))} />
            <FormField label="Email" value={newForm.contact_email} onChange={v => setNewForm(f => ({ ...f, contact_email: v }))} />
            <FormField label="Phone" value={newForm.contact_phone} onChange={v => setNewForm(f => ({ ...f, contact_phone: v }))} />
            <FormField label="Est. Value (₦)" fullWidth value={newForm.potential_value_kobo} onChange={v => setNewForm(f => ({ ...f, potential_value_kobo: v }))} />
          </>) : (<>
            <FormField label="Full Name *" value={newForm.contact_name} onChange={v => setNewForm(f => ({ ...f, contact_name: v }))} />
            <FormField label="Company / Employer *" value={newForm.company_name} onChange={v => setNewForm(f => ({ ...f, company_name: v }))} />
            <FormField label="Product / Loan Type" value={newForm.lead_type} onChange={v => setNewForm(f => ({ ...f, lead_type: v }))} />
            <FormField label="Email" value={newForm.contact_email} onChange={v => setNewForm(f => ({ ...f, contact_email: v }))} />
            <FormField label="Phone" value={newForm.contact_phone} onChange={v => setNewForm(f => ({ ...f, contact_phone: v }))} />
            <FormField label="Est. Value (₦)" value={newForm.potential_value_kobo} onChange={v => setNewForm(f => ({ ...f, potential_value_kobo: v }))} />
          </>)}

          <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={newForm.notes}
              onChange={e => setNewForm(f => ({ ...f, notes: e.target.value }))}
              rows={3}
              style={{ ...filterInputStyle, height: 'auto', resize: 'vertical', padding: '8px 10px' }}
            />
          </div>
        </div>
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
                navigate(`/los/new?${params.toString()}`)
              }}
              style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: RED, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              Create Application
            </button>
            <button onClick={() => setDetailLead(null)} style={{ padding: '8px 18px', borderRadius: 8, border: '1.5px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Close</button>
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
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt3)', marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>{value}</div>
                  </div>
                ))}
              </div>
              {detailLead.notes && (
                <div style={{ marginTop: 4, padding: '10px 12px', borderRadius: 8, background: 'var(--th-bg)', fontSize: 13, color: 'var(--txt)', lineHeight: 1.5 }}>
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
