import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useMemo, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Modal, Spinner, ExpandableFilterBar, NameCell, ActionRow } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPatch } from '../../lib/api'
import { fmtDate, fmtNum } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

interface Assignment {
  id: number
  employer_id: number; employer_name: string
  bd_officer_id: number; bd_officer_name: string
  sales_agent_id: number; sales_agent_name: string
  assignment_type: 'full_company' | 'specific_staff'
  status: 'assigned' | 'in_progress' | 'converted' | 'lost'
  staff_count_at_assignment: number
  notes: string | null; assigned_at: string; updated_at: string
  contacts_total: number; contacts_converted: number; deals_open: number
}

const STATUS_COLOR: Record<string, string> = {
  assigned:    '#6B7280',
  in_progress: AMBER,
  converted:   GREEN,
  lost:        RED,
}

const STATUS_LABELS: Record<string, string> = {
  assigned:    'Assigned',
  in_progress: 'In Progress',
  converted:   'Converted',
  lost:        'Lost',
}

const ALL_STATUSES = ['assigned', 'in_progress', 'converted', 'lost']

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px',
      borderRadius: RADIUS['2xl'], background: `${c}18`, color: c,
      whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{STATUS_LABELS[status] ?? status}</span>
  )
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>
        {type === 'full_company' ? 'corporate_fare' : 'group'}
      </span>
      {type === 'full_company' ? 'Full Company' : 'Specific Staff'}
    </span>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 5, background: 'var(--th-bg)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', minWidth: 32, textAlign: 'right', fontFamily: INTER }}>{pct}%</span>
    </div>
  )
}

// ── Assignment detail modal ───────────────────────────────────────────────────

function AssignmentDetailModal({
  assignment, onClose, onStatusChange,
}: {
  assignment: Assignment
  onClose: () => void
  onStatusChange: (newStatus: string) => void
}) {
  const [status, setStatus] = useState(assignment.status)
  const [notes, setNotes]   = useState(assignment.notes ?? '')
  const [saving, setSaving]  = useState(false)

  const convPct = assignment.contacts_total > 0
    ? Math.round((assignment.contacts_converted / assignment.contacts_total) * 100)
    : 0

  async function save() {
    setSaving(true)
    try {
      await apiPatch(`/api/bd/assignments/${assignment.id}`, { status, notes: notes.trim() || null })
      toast.success('Assignment updated')
      onStatusChange(status)
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{value ?? '—'}</span>
    </div>
  )

  return (
    <Modal
      open
      title={`Assignment — ${assignment.employer_name}`}
      width={540}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Close</button>
          <button
            onClick={save}
            disabled={saving}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
          >
            {saving && <Spinner size={14} color="#fff" />}
            Save Changes
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {row('BD Officer', assignment.bd_officer_name)}
        {row('Sales Agent', assignment.sales_agent_name)}
        {row('Type', <TypeBadge type={assignment.assignment_type} />)}
        {row('Assigned On', fmtDate(assignment.assigned_at))}

        {/* Progress */}
        <div style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            {[
              { label: 'CRM Contacts', value: assignment.contacts_total, color: NAVY },
              { label: 'Converted',     value: assignment.contacts_converted, color: GREEN },
              { label: 'Open Deals',    value: assignment.deals_open, color: AMBER },
            ].map(m => (
              <div key={m.label} style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '8px 10px', border: '1px solid var(--bdr)' }}>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: m.color }}>{fmtNum(m.value)}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{m.label}</div>
              </div>
            ))}
          </div>
          {assignment.contacts_total > 0 && (
            <div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4 }}>Conversion rate</div>
              <ProgressBar value={assignment.contacts_converted} total={assignment.contacts_total} color={convPct >= 50 ? GREEN : convPct >= 25 ? AMBER : RED} />
            </div>
          )}
        </div>

        {/* Status edit */}
        <div style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Status</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ALL_STATUSES.map(s => (
              <button
                key={s}
                onClick={() => setStatus(s as Assignment['status'])}
                style={{
                  padding: '4px 12px', borderRadius: RADIUS['2xl'], cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.semibold,
                  border: `2px solid ${status === s ? STATUS_COLOR[s] : 'var(--bdr)'}`,
                  background: status === s ? `${STATUS_COLOR[s]}15` : 'transparent',
                  color: status === s ? STATUS_COLOR[s] : 'var(--txt2)',
                }}
              >{STATUS_LABELS[s]}</button>
            ))}
          </div>
        </div>

        {/* Notes edit */}
        <div style={{ paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: RADIUS.md,
              border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
              color: 'var(--txt)', fontSize: TEXT.sm, resize: 'vertical',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>
    </Modal>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const PER_PAGE = 25

export default function BDAssignments() {
  const [rows,       setRows]      = useState<Assignment[]>([])
  const [loading,    setLoading]   = useState(true)
  const [err,        setErr]       = useState<string | null>(null)
  const [search,     setSearch]    = useState('')
  const [fStatuses,  setFStatuses] = useState<Set<string>>(new Set())
  const [fTypes,     setFTypes]    = useState<Set<string>>(new Set())
  const [page,       setPage]      = useState(1)
  const [detailRow,  setDetailRow] = useState<Assignment | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<any>('/api/bd/assignments')
      setRows(Array.isArray(data) ? data : (data?.data ?? []))
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load assignments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['deals','crm'] })

  const filtered = useMemo(() => rows.filter(r => {
    if (fStatuses.size && !fStatuses.has(r.status)) return false
    if (fTypes.size && !fTypes.has(r.assignment_type)) return false
    if (search) {
      const q = search.toLowerCase()
      if (![r.employer_name, r.sales_agent_name, r.bd_officer_name].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [rows, fStatuses, fTypes, search])

  useEffect(() => { setPage(1) }, [search, fStatuses, fTypes])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)

  // Summary KPIs
  const total     = rows.length
  const converted = rows.filter(r => r.status === 'converted').length
  const active    = rows.filter(r => r.status === 'in_progress').length
  const contacts  = rows.reduce((s, r) => s + (r.contacts_total ?? 0), 0)

  const cols: TableCol<Assignment>[] = [
    {
      key: 'employer_name', label: 'Employer', sortable: true,
      render: r => (
        <div>
          <NameCell name={r.employer_name} sub={null} />
          <TypeBadge type={r.assignment_type} />
        </div>
      ),
    },
    {
      key: 'sales_agent_name', label: 'Sales Agent', sortable: true,
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.sales_agent_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Assigned by {r.bd_officer_name}</div>
        </div>
      ),
    },
    {
      key: 'status', label: 'Status', sortable: true,
      render: r => <StatusPill status={r.status} />,
    },
    {
      key: 'contacts_total', label: 'CRM Contacts', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.contacts_total ?? 0)}</span>,
    },
    {
      key: 'contacts_converted', label: 'Converted', sortable: true, align: 'right',
      render: r => (
        <div style={{ textAlign: 'right' }}>
          <span style={{ ...NUM, color: GREEN }}>{fmtNum(r.contacts_converted ?? 0)}</span>
          {(r.contacts_total ?? 0) > 0 && (
            <div style={{ width: 80, marginLeft: 'auto', marginTop: 3 }}>
              <ProgressBar
                value={r.contacts_converted ?? 0}
                total={r.contacts_total ?? 0}
                color={GREEN}
              />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'deals_open', label: 'Open Deals', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.deals_open > 0 ? AMBER : 'var(--txt3)' }}>{fmtNum(r.deals_open ?? 0)}</span>,
    },
    {
      key: 'assigned_at', label: 'Assigned', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.assigned_at)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: r => <ActionRow actions={[
        { icon: 'open_in_new', label: 'View Details', onClick: () => setDetailRow(r) },
      ]} />,
    },
  ]

  function PageBtn({ children, active, disabled, onClick, icon }: {
    children?: React.ReactNode; active?: boolean; disabled?: boolean
    onClick?: () => void; icon?: string
  }) {
    return (
      <button onClick={onClick} disabled={disabled} style={{
        width: 28, height: 28, borderRadius: RADIUS.sm,
        border: active ? 'none' : '1.5px solid var(--input-bdr)',
        background: active ? NAVY : 'transparent',
        color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
        fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
      </button>
    )
  }

  return (
    <Page
      title="BD Assignments"
      subtitle={`${fmtNum(filtered.length)} assignments`}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        {[
          { label: 'Total Assignments', value: fmtNum(total),     icon: 'assignment_ind', color: NAVY },
          { label: 'In Progress',        value: fmtNum(active),    icon: 'pending',         color: AMBER },
          { label: 'Converted',          value: fmtNum(converted), icon: 'check_circle',    color: GREEN },
          { label: 'CRM Contacts',       value: fmtNum(contacts),  icon: 'contacts',        color: '#7C3AED' },
        ].map(item => (
          <div key={item.label} style={{
            background: 'var(--card)', borderRadius: RADIUS.xl, padding: '14px 16px',
            border: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: RADIUS.lg, flexShrink: 0,
              background: `${item.color}12`, display: 'flex', alignItems: 'center', justifyContent: 'center',
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

      <SectionCard title="Assignment Tracker" badge={rows.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'status',
              label: 'Status',
              options: ALL_STATUSES.map(s => ({
                value: s,
                color: STATUS_COLOR[s],
                count: rows.filter(r => r.status === s).length,
              })),
              selected: fStatuses,
              onChange: setFStatuses,
            },
            {
              key: 'type',
              label: 'Type',
              options: [
                { value: 'full_company',   count: rows.filter(r => r.assignment_type === 'full_company').length },
                { value: 'specific_staff', count: rows.filter(r => r.assignment_type === 'specific_staff').length },
              ],
              selected: fTypes,
              onChange: setFTypes,
            },
          ]}
          onReset={() => { setSearch(''); setFStatuses(new Set()); setFTypes(new Set()) }}
          resultCount={filtered.length}
          totalCount={rows.length}
        />

        <DataTable<Assignment>
          cols={cols}
          rows={pageRows}
          loading={loading}
          skeletonRows={6}
          emptyText="No assignments yet — assign an employer from the Employer Register"
          keyFn={r => r.id}
          onRowClick={r => setDetailRow(r)}
        />

        {/* Pagination */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            {filtered.length === 0
              ? 'No assignments'
              : `Showing ${(safePage - 1) * PER_PAGE + 1}–${Math.min(safePage * PER_PAGE, filtered.length)} of ${filtered.length}`}
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

      {detailRow && (
        <AssignmentDetailModal
          assignment={detailRow}
          onClose={() => setDetailRow(null)}
          onStatusChange={newStatus => {
            setRows(prev => prev.map(r => r.id === detailRow.id ? { ...r, status: newStatus as Assignment['status'] } : r))
            setDetailRow(null)
          }}
        />
      )}
    </Page>
  )
}
