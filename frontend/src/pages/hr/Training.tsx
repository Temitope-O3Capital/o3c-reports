import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ErrBanner, Spinner, StatusBadge, btnPrimary, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Training {
  id: number
  title: string
  training_type?: string
  start_date?: string
  end_date?: string
  venue?: string
  description?: string
  facilitator?: string
  status: string
  max_attendees?: number
  attendees?: Attendee[]
}

interface Attendee {
  id: number
  employee_name: string
  attended: boolean
  completed_at?: string
}

// ── Type pill ──────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  'Compliance': AMBER, 'Technical': BLUE, 'Leadership': NAVY, 'Soft Skills': GREEN, 'Onboarding': '#7C3AED',
}

function TypePill({ type }: { type?: string }) {
  if (!type) return null
  const color = TYPE_COLORS[type] ?? NAVY
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${color}14`, color }}>
      {type}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK = { title: '', training_type: 'Technical', start_date: '', end_date: '', venue: '', description: '', facilitator: '' }

export default function Training() {
  const storedUser = localStorage.getItem('auth_user')
  const userRole = storedUser ? (JSON.parse(storedUser) as AuthUser).role : ''
  const canManage = ['hr_manager', 'head_hr', 'admin'].includes(userRole)

  const [trainings, setTrainings]       = useState<Training[]>([])
  const [loading, setLoading]           = useState(true)
  const [err, setErr]                   = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const [statusFilter, setStatusFilter] = useState('')

  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)

  const [detail, setDetail]         = useState<Training | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (statusFilter) p.set('status', statusFilter)
      p.set('from', dateFrom)
      p.set('to', dateTo)
      const data = await apiFetch<{ data: Training[] }>(`/api/hr/training?${p}`)
      setTrainings(data.data ?? [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [statusFilter, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    if (!form.title) { toast.error('Training name is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/hr/training', form)
      toast.success('Training created')
      setNewOpen(false); setForm(BLANK); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function openDetail(t: Training) {
    setDetail(t)
    setLoadingDetail(true)
    // Training detail may include attendee list from the same endpoint
    setLoadingDetail(false)
  }

  function exportTrainingCsv(rows: Training[]) {
    const header = ['Name', 'Type', 'Date', 'Facilitator', 'Max Attendees', 'Status']
    const lines = rows.map(r => [
      `"${String(r.title ?? '').replace(/"/g, '""')}"`,
      r.training_type ?? '',
      r.start_date ?? '',
      `"${String(r.facilitator ?? '').replace(/"/g, '""')}"`,
      r.max_attendees ?? 0,
      r.status ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `training-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<Training>[] = [
    {
      key: 'title', label: 'Training',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.title}</span>,
    },
    {
      key: 'training_type', label: 'Type',
      render: r => <TypePill type={r.training_type} />,
    },
    {
      key: 'start_date', label: 'Date',
      render: r => r.start_date ? (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDate(r.start_date)}</span>
      ) : <span style={{ color: 'var(--txt3)' }}>TBD</span>,
    },
    {
      key: 'facilitator', label: 'Facilitator',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.facilitator ?? '—'}</span>,
    },
    {
      key: 'max_attendees', label: 'Max Attendees', align: 'right',
      render: r => <span style={NUM}>{r.max_attendees ?? 0}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
  ]

  const TYPES = ['Technical', 'Compliance', 'Leadership', 'Soft Skills', 'Onboarding']

  return (
    <Page
      title="Training"
      subtitle="Employee training and development programmes"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          {canManage && (
            <button onClick={() => { setForm(BLANK); setNewOpen(true) }} style={btnPrimary}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
              New Training
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => setStatusFilter('')}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="planned">Planned</option>
          <option value="ongoing">Ongoing</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </FilterBar>

      <SectionCard title="Training Records" badge={trainings.length} padding={false} actions={<button onClick={() => exportTrainingCsv(trainings)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>Export CSV</button>}>
        <DataTable<Training>
          cols={cols}
          rows={trainings}
          keyFn={r => r.id}
          onRowClick={openDetail}
          emptyText="No training records found."
          skeletonRows={loading ? 5 : 0}
          searchKeys={['title', 'training_type', 'facilitator', 'status']}
          searchPlaceholder="Search training…"
          pageSize={20}

        />
      </SectionCard>

      {/* New Training modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Training" width={460}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Create
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Training Name *</label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={inputStyle} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Type</label>
              <select value={form.training_type} onChange={e => setForm(f => ({ ...f, training_type: e.target.value }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Date</label>
              <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} style={{ ...inputStyle, height: 36 }} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Facilitator</label>
            <input value={form.facilitator} onChange={e => setForm(f => ({ ...f, facilitator: e.target.value }))} style={inputStyle} placeholder="Name of trainer or institution" />
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Description</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3} placeholder="Training objectives and content…" style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.title ?? 'Training Detail'} width={520}>
        {detail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
              <TypePill type={detail.training_type} />
              <StatusBadge status={detail.status} size="sm" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2], fontSize: TEXT.base }}>
              {[
                ['Date', detail.start_date ? fmtDate(detail.start_date) : 'TBD'],
                ['Facilitator', detail.facilitator ?? '—'],
                ['Max Attendees', String(detail.max_attendees ?? 0)],
              ].map(([label, value]) => (
                <div key={label}>
                  <span style={{ color: 'var(--txt2)' }}>{label}: </span>
                  <strong style={{ color: 'var(--txt)' }}>{value}</strong>
                </div>
              ))}
            </div>
            {detail.description && (
              <div style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md, fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6 }}>
                {detail.description}
              </div>
            )}
            {(detail.attendees ?? []).length > 0 && (
              <div>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', marginBottom: SP[2] }}>ATTENDEES</div>
                {(detail.attendees ?? []).map(a => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
                    <div style={{ width: 18, height: 18, borderRadius: RADIUS.xs, border: `2px solid ${a.attended ? GREEN : 'var(--input-bdr)'}`, background: a.attended ? GREEN : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {a.attended && <span className="material-symbols-rounded" style={{ fontSize: TEXT.xs, color: '#fff' }}>check</span>}
                    </div>
                    <span style={{ fontSize: TEXT.base, color: 'var(--txt)', flex: 1 }}>{a.employee_name}</span>
                    {a.completed_at && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDate(a.completed_at)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </Page>
  )
}
