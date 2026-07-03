import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, Spinner, Tabs, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Finding {
  id: number
  finding_ref: string
  summary: string
  severity: string
  status: string
  owner_name?: string
  due_date?: string
  created_at: string
  responses?: Response[]
}

interface Response {
  id: number
  body: string
  new_status: string
  created_by_name?: string
  created_at: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const SEV_STYLE: Record<string, { color: string; bg: string }> = {
  Critical: { color: '#fff',  bg: RED },
  High:     { color: RED,    bg: `${RED}12` },
  Medium:   { color: AMBER,  bg: `${AMBER}18` },
  Low:      { color: BLUE,   bg: `${BLUE}12` },
}

function SeverityPill({ sev }: { sev: string }) {
  const s = SEV_STYLE[sev] ?? SEV_STYLE.Low
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
      {sev}
    </span>
  )
}

const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  open:        { color: RED,    bg: `${RED}12`,            label: 'Open' },
  in_progress: { color: AMBER,  bg: `${AMBER}18`,          label: 'In Progress' },
  closed:      { color: GREEN,  bg: 'rgba(22,163,74,.12)', label: 'Closed' },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.open
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

function daysOverdue(due?: string): number | null {
  if (!due) return null
  const d = Math.ceil((Date.now() - new Date(due).getTime()) / 86_400_000)
  return d > 0 ? d : null
}

// ── Export ─────────────────────────────────────────────────────────────────────

function exportFindingsCsv(rows: Finding[]) {
  const header = ['Ref#', 'Summary', 'Severity', 'Status', 'Owner', 'Due Date', 'Created At']
  const lines = rows.map(r => [
    r.finding_ref ?? '',
    `"${String(r.summary ?? '').replace(/"/g, '""')}"`,
    r.severity ?? '',
    r.status ?? '',
    `"${String(r.owner_name ?? '').replace(/"/g, '""')}"`,
    r.due_date ?? '',
    r.created_at ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `findings-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK_FORM = { summary: '', severity: 'Medium', owner: '', due_date: '' }
const BLANK_RESP = { body: '', new_status: 'in_progress' }

export default function Findings() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [sevFilter, setSevFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)
  const [saving, setSaving] = useState(false)

  const [detail, setDetail] = useState<Finding | null>(null)
  const [detailTab, setDetailTab] = useState('detail')
  const [respForm, setRespForm] = useState(BLANK_RESP)
  const [responding, setResponding] = useState(false)

  const [closeEntry, setCloseEntry] = useState<Finding | null>(null)
  const [closing, setClosing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (sevFilter)    p.set('severity', sevFilter)
      if (statusFilter) p.set('status', statusFilter)
      const data = await apiFetch<Finding[]>(`/api/compliance/findings?${p}`)
      setFindings(Array.isArray(data) ? data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [sevFilter, statusFilter])

  useEffect(() => { load() }, [load])

  async function openDetail(f: Finding) {
    try {
      const full = await apiFetch<Finding>(`/api/compliance/findings/${f.id}`)
      setDetail(full)
      setDetailTab('detail')
      setRespForm(BLANK_RESP)
    } catch { setDetail(f) }
  }

  async function handleCreate() {
    if (!form.summary || !form.severity) { toast.error('Summary and severity are required'); return }
    setSaving(true)
    try {
      await apiPost('/api/compliance/findings', form)
      toast.success('Finding created')
      setNewOpen(false); setForm(BLANK_FORM); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleRespond() {
    if (!detail || !respForm.body) { toast.error('Response body required'); return }
    setResponding(true)
    try {
      await apiPost(`/api/compliance/findings/${detail.id}/response`, respForm)
      toast.success('Response recorded')
      setRespForm(BLANK_RESP)
      openDetail(detail)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setResponding(false) }
  }

  async function handleClose() {
    if (!closeEntry) return
    setClosing(true)
    try {
      await apiPut(`/api/compliance/findings/${closeEntry.id}/close`, {})
      toast.success('Finding closed')
      setCloseEntry(null); setDetail(null); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setClosing(false) }
  }

  async function handleBulkClose() {
    const ids = [...sel]
    if (ids.length === 0) return
    try {
      await Promise.all(ids.map(id => apiPut(`/api/compliance/findings/${id}/close`, {})))
      toast.success(`${ids.length} finding${ids.length !== 1 ? 's' : ''} closed`)
      setSel(new Set()); load()
    } catch (e: any) { toast.error(e.message) }
  }

  const cols: TableCol<Finding>[] = [
    {
      key: 'finding_ref', label: 'Ref#',
      render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 700, color: NAVY }}>{r.finding_ref}</span>,
    },
    {
      key: 'summary', label: 'Finding',
      render: r => (
        <span style={{ fontSize: 13, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300, display: 'block' }}>
          {r.summary}
        </span>
      ),
    },
    {
      key: 'severity', label: 'Severity',
      render: r => <SeverityPill sev={r.severity} />,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusPill status={r.status} />,
    },
    {
      key: 'owner_name', label: 'Owner',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.owner_name ?? '—'}</span>,
    },
    {
      key: 'due_date', label: 'Due / Overdue',
      render: r => {
        const od = daysOverdue(r.due_date)
        return r.due_date ? (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--txt)' }}>{fmtDate(r.due_date)}</div>
            {od !== null && r.status !== 'closed' && (
              <div style={{ fontSize: 11.5, fontWeight: 700, color: RED }}>{od}d overdue</div>
            )}
          </div>
        ) : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
  ]

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  return (
    <Page
      title="Audit Findings"
      subtitle="Internal and external audit findings tracking"
      actions={
        <button onClick={() => { setForm(BLANK_FORM); setNewOpen(true) }} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Finding
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setSevFilter(''); setStatusFilter('') }}>
        <select value={sevFilter} onChange={e => setSevFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Severities</option>
          {['Critical', 'High', 'Medium', 'Low'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="closed">Closed</option>
        </select>
      </FilterBar>

      <SectionCard title="Findings" badge={findings.length} padding={false}>
        <DataTable<Finding>
          cols={cols}
          rows={findings}
          keyFn={r => r.id}
          onRowClick={openDetail}
          emptyText="No findings found."
          skeletonRows={loading ? 5 : 0}
          searchKeys={['summary', 'status', 'severity']}
          searchPlaceholder="Search findings…"
          pageSize={20}
          onExport={() => exportFindingsCsv(findings)}
          selectable
          selectedIds={sel}
          onSelect={setSel}
          bulkBar={
            <button onClick={handleBulkClose} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#C00000', color: 'white', cursor: 'pointer', fontSize: 12 }}>
              Close Selected
            </button>
          }
        />
      </SectionCard>

      {/* New Finding modal */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Finding"
        width={500}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleCreate} disabled={saving}
              style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Create
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Finding Summary *</label>
            <textarea value={form.summary} onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
              rows={3} placeholder="Describe the finding…" style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Severity</label>
              <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}
                style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
                {['Critical', 'High', 'Medium', 'Low'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Due Date</label>
              <input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                style={{ ...inputStyle, height: 36 }} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Owner</label>
            <input value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))}
              placeholder="Responsible person or team"
              style={inputStyle} />
          </div>
        </div>
      </Modal>

      {/* Finding detail modal */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Finding — ${detail.finding_ref}` : ''}
        width={580}
        footer={
          detail?.status !== 'closed' ? (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setCloseEntry(detail!)}
                style={{ padding: '8px 14px', borderRadius: 8, border: `1.5px solid ${GREEN}40`, background: 'transparent', color: GREEN, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Close Finding
              </button>
            </div>
          ) : undefined
        }
      >
        {detail && (
          <div>
            <Tabs
              tabs={[{ key: 'detail', label: 'Detail' }, { key: 'responses', label: `Responses (${detail.responses?.length ?? 0})` }]}
              active={detailTab}
              onChange={setDetailTab}
            />
            {detailTab === 'detail' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 16 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <SeverityPill sev={detail.severity} />
                  <StatusPill status={detail.status} />
                </div>
                <p style={{ fontSize: 14, color: 'var(--txt)', lineHeight: 1.6, margin: 0 }}>{detail.summary}</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                  <div><span style={{ color: 'var(--txt2)' }}>Owner:</span> <strong>{detail.owner_name ?? '—'}</strong></div>
                  <div><span style={{ color: 'var(--txt2)' }}>Due:</span> <strong style={{ color: daysOverdue(detail.due_date) ? RED : 'var(--txt)' }}>{detail.due_date ? fmtDate(detail.due_date) : '—'}</strong></div>
                  <div><span style={{ color: 'var(--txt2)' }}>Created:</span> <strong>{fmtDate(detail.created_at)}</strong></div>
                </div>
                {/* Respond form */}
                {detail.status !== 'closed' && (
                  <div style={{ marginTop: 8, padding: '14px', background: 'var(--th-bg)', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)' }}>Add Response</div>
                    <textarea value={respForm.body} onChange={e => setRespForm(f => ({ ...f, body: e.target.value }))}
                      rows={3} placeholder="Describe action taken…"
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <select value={respForm.new_status} onChange={e => setRespForm(f => ({ ...f, new_status: e.target.value }))}
                        style={{ height: 32, padding: '0 8px', border: '1px solid var(--input-bdr)', borderRadius: 6, fontSize: 12.5, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none' }}>
                        <option value="in_progress">Mark In Progress</option>
                        <option value="closed">Mark Closed</option>
                      </select>
                      <button onClick={handleRespond} disabled={responding}
                        style={{ ...btnPrimary, padding: '6px 14px', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: responding ? 0.7 : 1 }}>
                        {responding && <Spinner size={12} color="#fff" />}
                        Submit
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {detailTab === 'responses' && (
              <div style={{ paddingTop: 16 }}>
                {(detail.responses ?? []).length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--txt2)', fontSize: 13 }}>No responses yet.</div>
                ) : (
                  (detail.responses ?? []).map(resp => (
                    <div key={resp.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)' }}>{resp.created_by_name ?? 'System'}</span>
                        <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{fmtDate(resp.created_at)}</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--txt)', lineHeight: 1.5 }}>{resp.body}</p>
                      <StatusPill status={resp.new_status} />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!closeEntry}
        title="Close finding?"
        body={`Mark "${closeEntry?.summary?.slice(0, 60)}…" as closed? This confirms the finding has been resolved.`}
        confirmLabel="Close Finding"
        loading={closing}
        onConfirm={handleClose}
        onClose={() => setCloseEntry(null)}
      />
    </Page>
  )
}
