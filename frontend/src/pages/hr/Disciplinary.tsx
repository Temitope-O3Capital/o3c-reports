import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ErrBanner, Spinner, StatusBadge, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DisciplinaryCase {
  id: number
  employee_name: string
  case_type: string
  incident_date: string
  outcome?: string
  status: string
  issued_by_name?: string
  description?: string
  created_at: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, { color: string; bg: string }> = {
  Warning:     { color: AMBER,  bg: `${AMBER}18` },
  Suspension:  { color: RED,    bg: `${RED}12` },
  Termination: { color: '#fff', bg: RED },
  Query:       { color: NAVY,   bg: 'rgba(14,40,65,.1)' },
  Counseling:  { color: BLUE,   bg: `${BLUE}12` },
}

function TypePill({ type }: { type: string }) {
  const s = TYPE_COLORS[type] ?? TYPE_COLORS.Query
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
      {type}
    </span>
  )
}

const OUTCOME_STYLE: Record<string, { color: string; bg: string }> = {
  resolved:   { color: GREEN,  bg: 'rgba(22,163,74,.12)' },
  dismissed:  { color: '#6B7280', bg: 'rgba(75,85,99,.1)' },
  escalated:  { color: AMBER,  bg: `${AMBER}18` },
  terminated: { color: RED,    bg: `${RED}12` },
}

function OutcomePill({ outcome }: { outcome?: string }) {
  if (!outcome) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const s = OUTCOME_STYLE[outcome?.toLowerCase()] ?? { color: 'var(--txt2)', bg: 'var(--chip-bg)' }
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
      {outcome}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK = { employee_id: '', case_type: 'Warning', incident_date: '', description: '', outcome: '' }

export default function Disciplinary() {
  const storedUser = localStorage.getItem('auth_user')
  const userRole = storedUser ? (JSON.parse(storedUser) as AuthUser).role : ''
  const canManage = ['hr_manager', 'head_hr', 'admin', 'coo'].includes(userRole)

  const [cases, setCases]           = useState<DisciplinaryCase[]>([])
  const [loading, setLoading]       = useState(true)
  const [err, setErr]               = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)

  const [detail, setDetail] = useState<DisciplinaryCase | null>(null)
  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (typeFilter)   p.set('case_type', typeFilter)
      if (statusFilter) p.set('status', statusFilter)
      const res = await apiFetch<{ data: DisciplinaryCase[] }>(`/api/hr/disciplinary?${p}`)
      setCases(Array.isArray(res.data) ? res.data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [typeFilter, statusFilter])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    if (!form.employee_id || !form.incident_date || !form.case_type) { toast.error('Required fields missing'); return }
    setSaving(true)
    try {
      await apiPost('/api/hr/disciplinary', {
        ...form,
        employee_id: Number(form.employee_id),
      })
      toast.success('Case created')
      setNewOpen(false); setForm(BLANK); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function openDetail(c: DisciplinaryCase) {
    try {
      const res = await apiFetch<{ data: DisciplinaryCase }>(`/api/hr/disciplinary/${c.id}`)
      // hrDisciplinaryGet wraps detail in {case, hearings, actions}; unwrap if needed.
      const payload = (res.data as any)?.case ?? res.data
      setDetail(payload)
    } catch { setDetail(c) }
  }

  async function handleBatchClose() {
    const ids = Array.from(sel) as number[]
    await Promise.all(ids.map(id => apiPut(`/api/hr/disciplinary/${id}/close`, {}).catch(() => null)))
    toast.success(`${ids.length} case(s) closed`)
    setSel(new Set()); load()
  }

  function exportDisciplinaryCsv(rows: DisciplinaryCase[]) {
    const header = ['Employee', 'Type', 'Incident Date', 'Outcome', 'Issued By', 'Status']
    const lines = rows.map(r => [
      `"${String(r.employee_name ?? '').replace(/"/g, '""')}"`,
      r.case_type ?? '',
      r.incident_date ?? '',
      r.outcome ?? '',
      `"${String(r.issued_by_name ?? '').replace(/"/g, '""')}"`,
      r.status ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `disciplinary-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<DisciplinaryCase>[] = [
    {
      key: 'employee_name', label: 'Employee',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.employee_name}</span>,
    },
    {
      key: 'case_type', label: 'Type',
      render: r => <TypePill type={r.case_type} />,
    },
    {
      key: 'incident_date', label: 'Date',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{fmtDate(r.incident_date)}</span>,
    },
    {
      key: 'outcome', label: 'Outcome',
      render: r => <OutcomePill outcome={r.outcome} />,
    },
    {
      key: 'issued_by_name', label: 'Issued By',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.issued_by_name ?? '—'}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
  ]

  const CASE_TYPES = ['Warning', 'Query', 'Suspension', 'Counseling', 'Termination']
  const OUTCOMES   = ['resolved', 'dismissed', 'escalated', 'terminated']

  return (
    <Page
      title="Disciplinary"
      subtitle="Disciplinary cases and outcomes"
      actions={
        canManage ? (
          <button onClick={() => { setForm(BLANK); setNewOpen(true) }} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Case
          </button>
        ) : undefined
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setTypeFilter(''); setStatusFilter('') }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Types</option>
          {CASE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
      </FilterBar>

      <SectionCard title="Cases" badge={cases.length} padding={false} actions={<button onClick={() => exportDisciplinaryCsv(cases)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <DataTable<DisciplinaryCase>
          cols={cols}
          rows={cases}
          keyFn={r => r.id}
          onRowClick={openDetail}
          emptyText="No disciplinary cases found."
          skeletonRows={loading ? 5 : 0}
          searchKeys={['employee_name', 'case_type', 'outcome', 'status', 'issued_by_name']}
          searchPlaceholder="Search cases…"
          pageSize={20}

          selectable
          selectedIds={sel}
          onSelect={setSel}
          bulkBar={
            <button onClick={handleBatchClose}
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#C00000', color: 'white', cursor: 'pointer', fontSize: 12 }}>
              Close Selected
            </button>
          }
        />
      </SectionCard>

      {/* New Case modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Disciplinary Case" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Create Case
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Employee ID *</label>
            <input value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} style={inputStyle} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Type *</label>
              <select value={form.case_type} onChange={e => setForm(f => ({ ...f, case_type: e.target.value }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                {CASE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Incident Date *</label>
              <input type="date" value={form.incident_date} onChange={e => setForm(f => ({ ...f, incident_date: e.target.value }))} style={{ ...inputStyle, height: 36 }} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Outcome</label>
            <select value={form.outcome} onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}
              style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
              <option value="">— Pending —</option>
              {OUTCOMES.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Description</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={4} placeholder="Describe the incident…" style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title="Case Detail" width={500}>
        {detail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <TypePill type={detail.case_type} />
              <OutcomePill outcome={detail.outcome} />
              <StatusBadge status={detail.status} size="sm" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
              <div><span style={{ color: 'var(--txt2)' }}>Employee:</span> <strong>{detail.employee_name}</strong></div>
              <div><span style={{ color: 'var(--txt2)' }}>Date:</span> <strong>{fmtDate(detail.incident_date)}</strong></div>
              <div><span style={{ color: 'var(--txt2)' }}>Issued By:</span> <strong>{detail.issued_by_name ?? '—'}</strong></div>
              <div><span style={{ color: 'var(--txt2)' }}>Created:</span> <strong>{fmtDate(detail.created_at)}</strong></div>
            </div>
            {detail.description && (
              <div style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: 8, fontSize: 13, color: 'var(--txt)', lineHeight: 1.6 }}>
                {detail.description}
              </div>
            )}
          </div>
        )}
      </Modal>
    </Page>
  )
}
