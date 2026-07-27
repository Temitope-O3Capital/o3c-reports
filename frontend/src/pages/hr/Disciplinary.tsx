import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  Modal, ErrBanner, Spinner, StatusBadge, btnPrimary, DateFilter,
  NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DisciplinaryCase {
  id: number
  employee_name: string
  staff_id?: string
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
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.full, background: s.bg, color: s.color }}>
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
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.full, background: s.bg, color: s.color }}>
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
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const [search, setSearch]   = useState('')
  const [fType, setFType]     = useState(new Set<string>())
  const [fStatus, setFStatus] = useState(new Set<string>())

  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)

  const [detail, setDetail] = useState<DisciplinaryCase | null>(null)
  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      p.set('from', dateFrom)
      p.set('to', dateTo)
      const res = await apiFetch<{ data: DisciplinaryCase[] }>(`/api/hr/disciplinary?${p}`)
      setCases(Array.isArray(res.data) ? res.data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

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
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<DisciplinaryCase>[] = [
    {
      key: 'employee_name', label: 'Employee',
      render: r => <NameCell name={r.employee_name} sub={r.staff_id ?? null} />,
    },
    {
      key: 'case_type', label: 'Type',
      render: r => <TypePill type={r.case_type} />,
    },
    {
      key: 'incident_date', label: 'Date',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDate(r.incident_date)}</span>,
    },
    {
      key: 'outcome', label: 'Outcome',
      render: r => <OutcomePill outcome={r.outcome} />,
    },
    {
      key: 'issued_by_name', label: 'Issued By',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.issued_by_name ?? '—'}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
    {
      key: 'id', label: '', sortable: false,
      render: r => <ActionRow actions={[
        { icon: 'visibility', label: 'View', onClick: () => openDetail(r) },
      ]} />,
    },
  ]

  const CASE_TYPES = ['Warning', 'Query', 'Suspension', 'Counseling', 'Termination']
  const OUTCOMES   = ['resolved', 'dismissed', 'escalated', 'terminated']

  const filtered = useMemo(() => cases.filter(r => {
    if (fType.size && !fType.has(r.case_type)) return false
    if (fStatus.size && !fStatus.has(r.status)) return false
    if (search) {
      const q = search.toLowerCase()
      if (![r.employee_name, r.case_type, r.outcome, r.status, r.issued_by_name].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [cases, fType, fStatus, search])

  return (
    <Page
      title="Disciplinary"
      subtitle="Disciplinary cases and outcomes"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          {canManage && (
            <button onClick={() => { setForm(BLANK); setNewOpen(true) }} style={btnPrimary}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
              New Case
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="Cases" badge={cases.length} padding={false} actions={<button onClick={() => exportDisciplinaryCsv(cases)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={[
            {
              key: 'type', label: 'Case Type',
              options: CASE_TYPES.map(t => ({ value: t, color: TYPE_COLORS[t]?.color, count: cases.filter(r => r.case_type === t).length })),
              selected: fType, onChange: (next: Set<string>) => setFType(next),
            },
            {
              key: 'status', label: 'Status',
              options: [
                { value: 'open',   label: 'Open',   color: '#C00000', count: cases.filter(r => r.status === 'open').length },
                { value: 'closed', label: 'Closed', color: GREEN,     count: cases.filter(r => r.status === 'closed').length },
              ],
              selected: fStatus, onChange: (next: Set<string>) => setFStatus(next),
            },
          ]}
          onReset={() => { setSearch(''); setFType(new Set()); setFStatus(new Set()) }}
          resultCount={filtered.length} totalCount={cases.length}
          placeholder="Search cases…"
        />
        <DataTable<DisciplinaryCase>
          cols={cols}
          rows={filtered}
          keyFn={r => r.id}
          onRowClick={openDetail}
          emptyText="No disciplinary cases found."
          skeletonRows={loading ? 5 : 0}
          pageSize={20}

          selectable
          selectedIds={sel}
          onSelect={setSel}
          bulkBar={
            <button onClick={handleBatchClose}
              style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: 'none', background: '#C00000', color: 'white', cursor: 'pointer', fontSize: TEXT.sm }}>
              Close Selected
            </button>
          }
        />
      </SectionCard>

      {/* New Case modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Disciplinary Case" width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Create Case
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Employee ID *</label>
            <input value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} style={inputStyle} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Type *</label>
              <select value={form.case_type} onChange={e => setForm(f => ({ ...f, case_type: e.target.value }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                {CASE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Incident Date *</label>
              <input type="date" value={form.incident_date} onChange={e => setForm(f => ({ ...f, incident_date: e.target.value }))} style={{ ...inputStyle, height: 36 }} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Outcome</label>
            <select value={form.outcome} onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}
              style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
              <option value="">— Pending —</option>
              {OUTCOMES.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Description</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2], fontSize: TEXT.base }}>
              <div><span style={{ color: 'var(--txt2)' }}>Employee:</span> <strong>{detail.employee_name}</strong></div>
              <div><span style={{ color: 'var(--txt2)' }}>Date:</span> <strong>{fmtDate(detail.incident_date)}</strong></div>
              <div><span style={{ color: 'var(--txt2)' }}>Issued By:</span> <strong>{detail.issued_by_name ?? '—'}</strong></div>
              <div><span style={{ color: 'var(--txt2)' }}>Created:</span> <strong>{fmtDate(detail.created_at)}</strong></div>
            </div>
            {detail.description && (
              <div style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md, fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6 }}>
                {detail.description}
              </div>
            )}
          </div>
        )}
      </Modal>
    </Page>
  )
}
