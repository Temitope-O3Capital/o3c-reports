import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, ExpandableFilterBar, Modal, btnPrimary, btnSecondary, DateFilter, NameCell, ActionRow } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, RED, NAVY, BLUE, INTER, NUM } from '../../lib/design'
import { toast } from 'sonner'

interface DSARStats {
  total:                 number
  pending:               number
  in_progress:           number
  resolved:              number
  rejected:              number
  total_erasure:         number
  erasures_processed:    number
  erasures_pending_purge:number
  last_purge_run:        string | null
}

interface DSAR {
  id:               number
  subject_cif:      string | null
  subject_name:     string | null
  subject_email:    string | null
  request_type:     string
  status:           'pending' | 'in_progress' | 'resolved' | 'rejected'
  notes:            string | null
  assigned_to_name: string | null
  created_at:       string
  resolved_at:      string | null
  processed_at:     string | null
}

const TYPE_LABELS: Record<string, string> = {
  access: 'Access', erasure: 'Erasure', rectification: 'Rectification',
  portability: 'Portability', objection: 'Objection',
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  pending:     { bg: `${AMBER}18`, color: AMBER },
  in_progress: { bg: `${BLUE}18`,  color: BLUE  },
  resolved:    { bg: `${GREEN}18`, color: GREEN  },
  rejected:    { bg: `${RED}15`,   color: RED    },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.pending
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md, ...s }}>{status.replace('_', ' ')}</span>
}

export default function DataSubjectRequests() {
  const [items,    setItems]    = useState<DSAR[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [search, setSearch]     = useState('')
  const [fType, setFType]       = useState(new Set<string>())
  const [fStatus, setFStatus]   = useState(new Set<string>())
  const [showNew,  setShowNew]  = useState(false)
  const [selected, setSelected] = useState<DSAR | null>(null)
  const [stats,    setStats]    = useState<DSARStats | null>(null)

  const [formCIF,   setFormCIF]   = useState('')
  const [formName,  setFormName]  = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formType,  setFormType]  = useState('access')
  const [formNotes, setFormNotes] = useState('')
  const [saving,    setSaving]    = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    apiFetch<any>('/api/compliance/dsar-stats').then(s => setStats((s?.data ?? s) ?? null)).catch(() => {})
    try {
      const p = new URLSearchParams()
      if (dateFrom) p.set('from', dateFrom)
      if (dateTo)   p.set('to', dateTo)
      const res = await apiFetch<any>(`/api/compliance/data-subject-requests?${p}`)
      setItems(Array.isArray(res) ? res : (res?.data ?? []))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['compliance'] })

  const create = async () => {
    if (!formType) { toast.error('Request type is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/compliance/data-subject-requests', {
        subject_cif: formCIF, subject_name: formName, subject_email: formEmail,
        request_type: formType, notes: formNotes,
      })
      toast.success('DSAR created')
      setShowNew(false)
      setFormCIF(''); setFormName(''); setFormEmail(''); setFormNotes('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const updateStatus = async (id: number, status: string) => {
    try {
      await apiFetch(`/api/compliance/data-subject-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
        headers: { 'Content-Type': 'application/json' },
      })
      toast.success('Status updated')
      setSelected(null)
      load()
    } catch (e: any) { toast.error(e.message) }
  }

  const filtered = useMemo(() => items.filter(r => {
    if (fType.size && !fType.has(r.request_type)) return false
    if (fStatus.size && !fStatus.has(r.status)) return false
    if (search) {
      const q = search.toLowerCase()
      if (![r.subject_name, r.request_type, r.status].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [items, fType, fStatus, search])

  const COLS: TableCol<DSAR>[] = [
    { key: 'id', label: 'Ref', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>DSAR-{r.id}</span> },
    { key: 'subject_name', label: 'Subject', render: r => <NameCell name={r.subject_name ?? '—'} sub={r.subject_email ?? ''} /> },
    { key: 'request_type', label: 'Type', render: r => (
      <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>{TYPE_LABELS[r.request_type] ?? r.request_type}</span>
    )},
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'created_at', label: 'Received', render: r => <span style={{ fontSize: TEXT.sm, ...NUM }}>{fmtDatetime(r.created_at)}</span> },
    { key: 'resolved_at', label: 'Resolved', render: r => r.resolved_at
      ? <span style={{ fontSize: TEXT.sm, color: GREEN, ...NUM }}>{fmtDatetime(r.resolved_at)}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span>
    },
    { key: 'processed_at', label: 'Erased', render: r => r.request_type !== 'erasure' ? null : r.processed_at
      ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[1], fontSize: TEXT.xs, fontWeight: FW.bold, color: GREEN, background: `${GREEN}14`, padding: '2px 8px', borderRadius: RADIUS.md }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>verified</span>
          {fmtDatetime(r.processed_at)}
        </span>
      )
      : <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontStyle: 'italic' }}>Pending erasure</span>
    },
    { key: 'assigned_to_name', label: 'Handler', render: r => <span style={{ fontSize: TEXT.sm }}>{r.assigned_to_name ?? '—'}</span> },
    {
      key: '_actions', label: '', sortable: false, width: 96,
      render: r => (
        <ActionRow actions={[
          { icon: 'visibility', label: 'View', onClick: () => setSelected(r) },
          ...(r.status !== 'in_progress' && r.status !== 'resolved' && r.status !== 'rejected'
            ? [{ icon: 'play_arrow', label: 'Process', onClick: () => updateStatus(r.id, 'in_progress') }]
            : []),
          ...(r.status === 'in_progress'
            ? [{ icon: 'check', label: 'Complete', onClick: () => updateStatus(r.id, 'resolved') }]
            : []),
        ]} />
      ),
    },
  ]

  const inp: React.CSSProperties = {
    padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER, width: '100%', boxSizing: 'border-box',
  }

  return (
    <Page
      title="Data Subject Requests"
      subtitle="NDPR / GDPR data subject access, erasure and portability requests"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={() => setShowNew(true)} style={btnPrimary}>+ New DSAR</button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* NDPR Worker Status */}
      {stats && (
        <SectionCard title="NDPR Purge Worker" style={{ marginBottom: SP[5] }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: SP[4] }}>
            {[
              { label: 'Total Requests',   value: stats.total,                  color: NAVY },
              { label: 'Pending',          value: stats.pending,                color: AMBER },
              { label: 'Resolved',         value: stats.resolved,               color: GREEN },
              { label: 'Erasures Total',   value: stats.total_erasure,          color: NAVY },
              { label: 'Erasures Purged',  value: stats.erasures_processed,     color: GREEN },
              { label: 'Awaiting Purge',   value: stats.erasures_pending_purge, color: stats.erasures_pending_purge > 0 ? AMBER : GREEN },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: 'var(--surface2)', borderRadius: RADIUS.md, padding: `${SP[3]}px ${SP[4]}px` }}>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: FW.bold, color, ...NUM }}>{value}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: SP[4], fontSize: TEXT.xs, color: 'var(--txt3)', display: 'flex', alignItems: 'center', gap: SP[2] }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>schedule</span>
            {stats.last_purge_run
              ? <>Last purge run: <strong style={{ color: 'var(--txt2)' }}>{fmtDatetime(stats.last_purge_run)}</strong> · Worker runs nightly at midnight</>
              : 'No erasure records processed yet · Worker runs nightly at midnight'
            }
          </div>
        </SectionCard>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <SectionCard title="Data Subject Requests" badge={items.length} padding={false}>
          <ExpandableFilterBar
            search={search} onSearch={setSearch}
            groups={[
              {
                key: 'type', label: 'Request Type',
                options: Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l, count: items.filter(r => r.request_type === v).length })),
                selected: fType, onChange: (next: Set<string>) => setFType(next),
              },
              {
                key: 'status', label: 'Status',
                options: [
                  { value: 'pending',     label: 'Pending',     color: AMBER, count: items.filter(r => r.status === 'pending').length },
                  { value: 'in_progress', label: 'In Progress', color: BLUE,  count: items.filter(r => r.status === 'in_progress').length },
                  { value: 'resolved',    label: 'Resolved',    color: GREEN, count: items.filter(r => r.status === 'resolved').length },
                  { value: 'rejected',    label: 'Rejected',    color: RED,   count: items.filter(r => r.status === 'rejected').length },
                ],
                selected: fStatus, onChange: (next: Set<string>) => setFStatus(next),
              },
            ]}
            onReset={() => { setSearch(''); setFType(new Set()); setFStatus(new Set()) }}
            resultCount={filtered.length} totalCount={items.length}
            placeholder="Search by name, type or status…"
          />
          <DataTable cols={COLS} rows={filtered} keyFn={r => r.id} emptyText="No data subject requests recorded" />
        </SectionCard>
      )}

      {/* New DSAR */}
      {showNew && (
        <Modal open title="New Data Subject Request" onClose={() => setShowNew(false)} width={560}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
              <div>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>CIF Number</label>
                <input value={formCIF} onChange={e => setFormCIF(e.target.value)} placeholder="CIF-…" style={inp} />
              </div>
              <div>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Subject Name</label>
                <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Full name" style={inp} />
              </div>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Email</label>
              <input type="email" value={formEmail} onChange={e => setFormEmail(e.target.value)} placeholder="email@example.com" style={inp} />
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Request Type *</label>
              <select value={formType} onChange={e => setFormType(e.target.value)} style={inp}>
                {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes</label>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={3}
                placeholder="Details of the request…" style={{ ...inp, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
              <button onClick={() => setShowNew(false)} style={btnSecondary}>Cancel</button>
              <button onClick={create} disabled={saving} style={btnPrimary}>{saving ? 'Creating…' : 'Create'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Status update modal */}
      {selected && (
        <Modal open title={`Update DSAR-${selected.id}`} onClose={() => setSelected(null)} width={420}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
            <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[2] }}>
              <strong>{TYPE_LABELS[selected.request_type]}</strong> request from {selected.subject_name || selected.subject_email || 'unknown'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {(['in_progress', 'resolved', 'rejected'] as const).map(s => (
                <button key={s} onClick={() => updateStatus(selected.id, s)}
                  style={{ padding: '10px 16px', borderRadius: RADIUS.md, border: `1px solid ${STATUS_STYLE[s].color}40`,
                    background: STATUS_STYLE[s].bg, color: STATUS_STYLE[s].color, fontSize: TEXT.base, fontWeight: FW.bold,
                    cursor: 'pointer', fontFamily: INTER, textAlign: 'left' }}>
                  Mark as {s.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </Page>
  )
}
