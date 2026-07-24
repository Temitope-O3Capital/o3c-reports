import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Modal, ConfirmModal, StatusBadge, btnPrimary, Spinner, NameCell, ActionRow } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPatch } from '../../lib/api'
import { fmtDate, today } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, TEXT, FW, SP, RADIUS, NUM } from '../../lib/design'
import { toast } from 'sonner'

interface BreachIncident {
  id: number
  ref_no: string
  title: string
  description?: string
  discovered_at: string
  notify_deadline_at: string
  affected_records?: number
  data_categories?: string[]
  breach_type: string
  severity: string
  status: string
  ndpc_notified: boolean
  ndpc_notified_at?: string
  ndpc_ref_number?: string
  reported_by_name?: string
  assigned_name?: string
}

const SEV_COLOR: Record<string, string> = {
  low: '#6B7280', medium: AMBER, high: RED, critical: '#7C0000',
}

function CountdownBadge({ deadline, notified }: { deadline: string; notified: boolean }) {
  const ms = new Date(deadline).getTime() - Date.now()
  const hours = Math.floor(ms / 3_600_000)
  const mins  = Math.floor((ms % 3_600_000) / 60_000)
  if (notified) return <span style={{ ...NUM, fontSize: TEXT.xs, color: GREEN, fontWeight: FW.bold }}>Notified ✓</span>
  if (ms <= 0)  return <span style={{ ...NUM, fontSize: TEXT.xs, color: RED, fontWeight: FW.bold }}>OVERDUE</span>
  const color = hours < 12 ? RED : hours < 24 ? AMBER : 'var(--txt2)'
  return (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color }}>
      {hours}h {mins}m left
    </span>
  )
}

export default function BreachIncidents() {
  const [items, setItems]       = useState<BreachIncident[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)
  const [addOpen, setAddOpen]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [detail, setDetail]     = useState<BreachIncident | null>(null)
  const [confirmNotify, setConfirmNotify] = useState<BreachIncident | null>(null)
  const [notifying, setNotifying] = useState(false)

  const [form, setForm] = useState({
    title: '', description: '', breach_type: 'unauthorized_access',
    severity: 'medium', affected_records: '', data_categories: '',
  })

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<BreachIncident[]>('/api/compliance/breach-incidents')
      setItems(Array.isArray(data) ? data : (data as any).data ?? [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    if (!form.title) { toast.error('Title is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/compliance/breach-incidents', {
        ...form,
        affected_records: form.affected_records ? Number(form.affected_records) : undefined,
        data_categories: form.data_categories ? form.data_categories.split(',').map(s => s.trim()).filter(Boolean) : [],
      })
      toast.success('Incident reported')
      setAddOpen(false)
      setForm({ title: '', description: '', breach_type: 'unauthorized_access', severity: 'medium', affected_records: '', data_categories: '' })
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleMarkNotified() {
    if (!confirmNotify) return
    setNotifying(true)
    try {
      await apiPatch(`/api/compliance/breach-incidents/${confirmNotify.id}`, {
        ndpc_notified: true, status: 'notified',
      })
      toast.success('NDPC notification recorded')
      setConfirmNotify(null)
      setDetail(null)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setNotifying(false) }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<BreachIncident>[] = [
    {
      key: 'title', label: 'Incident',
      render: r => <NameCell name={r.title} sub={r.ref_no} avatar={false} />,
    },
    {
      key: 'severity', label: 'Severity',
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
          background: `${SEV_COLOR[r.severity]}14`, color: SEV_COLOR[r.severity] }}>
          {r.severity.toUpperCase()}
        </span>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
    {
      key: 'discovered_at', label: 'Discovered',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.discovered_at)}</span>,
    },
    {
      key: 'notify_deadline_at', label: '72h Deadline',
      render: r => <CountdownBadge deadline={r.notify_deadline_at} notified={r.ndpc_notified} />,
    },
    {
      key: 'affected_records', label: 'Affected',
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.affected_records ?? '—'}</span>,
    },
    {
      key: 'assigned_name', label: 'Assigned To',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.assigned_name ?? '—'}</span>,
    },
    {
      key: '_actions', label: '', sortable: false, width: 64,
      render: r => (
        <ActionRow actions={[
          { icon: 'visibility', label: 'View', onClick: () => setDetail(r) },
          ...(!r.ndpc_notified ? [{ icon: 'notifications_active', label: 'Mark NDPC Notified', onClick: () => setConfirmNotify(r) }] : []),
        ]} />
      ),
    },
  ]

  const open = items.filter(i => !['closed', 'remediated'].includes(i.status)).length
  const overdue = items.filter(i => !i.ndpc_notified && new Date(i.notify_deadline_at) < new Date()).length

  return (
    <Page
      title="Data Breach Incidents"
      subtitle="Track and manage NDPC-notifiable data breaches within the 72-hour window"
      actions={
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>report</span>
          Report Incident
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[3], marginBottom: 20 }}>
        {[
          { label: 'Open Incidents', value: open, color: RED },
          { label: 'NDPC Overdue', value: overdue, color: overdue > 0 ? '#7C0000' : GREEN },
          { label: 'Total Incidents', value: items.length, color: NAVY },
        ].map(k => (
          <div key={k.label} style={{ padding: '16px 20px', background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.lg }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: 6 }}>{k.label}</div>
            <div style={{ ...NUM, fontSize: 26, fontWeight: FW.bold, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="Incidents" badge={items.length} padding={false}>
        <DataTable<BreachIncident>
          cols={cols}
          rows={items}
          keyFn={r => r.id}
          emptyText={loading ? '' : 'No breach incidents recorded.'}
          skeletonRows={loading ? 5 : 0}
          onRowClick={setDetail}
          searchKeys={['title', 'ref_no', 'breach_type', 'status']}
        />
      </SectionCard>

      {/* Report modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Report Data Breach Incident" width={560}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button onClick={() => setAddOpen(false)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Report Incident
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          <div style={{ padding: '10px 14px', background: `${RED}0F`, borderRadius: RADIUS.md, border: `1px solid ${RED}30`, fontSize: TEXT.sm, color: RED }}>
            <strong>⚠ NDPC 72-Hour Rule:</strong> Under the Nigeria Data Protection Act, the NDPC must be notified within 72 hours of discovering a personal data breach.
          </div>
          {([
            ['Incident Title *', 'title', 'text'],
            ['Affected Records (estimate)', 'affected_records', 'number'],
            ['Data Categories (comma-separated, e.g. BVN, email)', 'data_categories', 'text'],
          ] as [string, keyof typeof form, string][]).map(([label, key, type]) => (
            <div key={key}>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>{label}</label>
              <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} style={inputStyle} />
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Breach Type</label>
              <select value={form.breach_type} onChange={e => setForm(f => ({ ...f, breach_type: e.target.value }))} style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                {['unauthorized_access','data_loss','ransomware','insider_threat','phishing','other'].map(t => (
                  <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Severity</label>
              <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value }))} style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                {['low','medium','high','critical'].map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1] }}>Description</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.ref_no ?? 'Incident Detail'} width={560}>
        {detail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
            <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusBadge status={detail.severity} />
              <StatusBadge status={detail.status} />
              <CountdownBadge deadline={detail.notify_deadline_at} notified={detail.ndpc_notified} />
            </div>
            <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>{detail.title}</div>
            {detail.description && <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', lineHeight: 1.55 }}>{detail.description}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
              {[
                ['Breach Type', detail.breach_type.replace(/_/g, ' ')],
                ['Affected Records', detail.affected_records ?? '—'],
                ['Discovered', fmtDate(detail.discovered_at)],
                ['NDPC Deadline', fmtDate(detail.notify_deadline_at)],
                ['NDPC Notified', detail.ndpc_notified ? `Yes (${fmtDate(detail.ndpc_notified_at!)})` : 'No'],
                ['NDPC Ref', detail.ndpc_ref_number ?? '—'],
                ['Data Categories', detail.data_categories?.join(', ') ?? '—'],
                ['Reported By', detail.reported_by_name ?? '—'],
              ].map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)' }}>{String(value)}</div>
                </div>
              ))}
            </div>
            {!detail.ndpc_notified && (
              <button
                onClick={() => setConfirmNotify(detail)}
                style={{ ...btnPrimary, background: BLUE, alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>notifications_active</span>
                Mark NDPC as Notified
              </button>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!confirmNotify}
        title="Confirm NDPC Notification"
        body={`This will record that the NDPC has been formally notified of incident ${confirmNotify?.ref_no}. This action cannot be undone.`}
        confirmLabel="Mark as Notified"
        loading={notifying}
        onConfirm={handleMarkNotified}
        onClose={() => setConfirmNotify(null)}
      />
    </Page>
  )
}
