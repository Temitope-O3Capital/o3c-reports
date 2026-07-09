import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, ErrBanner, Spinner,
  Modal, ConfirmModal,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, API, getCsrfToken } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number
  name: string
  description: string
  status: string
  dial_ratio: number
  max_abandonment_pct: number
  caller_id: string
  max_attempts: number
  retry_delay_minutes: number
  schedule_start: string | null
  schedule_end: string | null
  created_at: string
  updated_at: string
}

interface CampaignStats {
  queue: Array<{ status: string; cnt: number }>
  calls: Array<{ answered: number; abandoned: number; total: number; avg_duration_sec: number }>
  sessions: Array<{ status: string; cnt: number }>
  abandon_pct: number
  cbn_limit_pct: number
}

interface UploadResult {
  inserted: number
  total: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_COLOUR: Record<string, { bg: string; txt: string }> = {
  draft:     { bg: 'rgba(107,114,128,.12)', txt: '#6B7280' },
  active:    { bg: `${GREEN}18`,            txt: GREEN },
  paused:    { bg: `${AMBER}18`,            txt: AMBER },
  completed: { bg: `${NAVY}12`,             txt: NAVY },
}

const labelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }
const inputSt: React.CSSProperties = { width: '100%', height: 36, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function queueTotal(stats: CampaignStats | null): number {
  if (!stats) return 0
  return stats.queue.reduce((s, r) => s + Number(r.cnt), 0)
}

function queuePending(stats: CampaignStats | null): number {
  if (!stats) return 0
  return Number(stats.queue.find(r => r.status === 'pending')?.cnt ?? 0)
}

function callsAnswered(stats: CampaignStats | null): number {
  if (!stats || !stats.calls[0]) return 0
  return Number(stats.calls[0].answered)
}

function callsTotal(stats: CampaignStats | null): number {
  if (!stats || !stats.calls[0]) return 0
  return Number(stats.calls[0].total)
}

// ── Campaign Form ─────────────────────────────────────────────────────────────

interface CampaignForm {
  name: string; description: string; dial_ratio: number; max_abandonment_pct: number
  caller_id: string; max_attempts: number; retry_delay_minutes: number
  schedule_start: string; schedule_end: string
}

const EMPTY_FORM: CampaignForm = {
  name: '', description: '', dial_ratio: 1.5, max_abandonment_pct: 3.0,
  caller_id: '', max_attempts: 3, retry_delay_minutes: 60,
  schedule_start: '', schedule_end: '',
}

function CampaignFormFields({ form, onChange }: { form: CampaignForm; onChange: (f: CampaignForm) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={labelSt}>Campaign Name *</label>
        <input value={form.name} onChange={e => onChange({ ...form, name: e.target.value })} placeholder="e.g. October Loan Renewal Drive" style={inputSt} />
      </div>
      <div>
        <label style={labelSt}>Description</label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.description} onChange={e => onChange({ ...form, description: e.target.value })} rows={2}
          style={{ ...inputSt, height: 'auto', padding: '8px 10px', resize: 'vertical' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelSt}>Dial Ratio (calls per available agent)</label>
          <input type="number" min={1} max={5} step={0.1} value={form.dial_ratio}
            onChange={e => onChange({ ...form, dial_ratio: Number(e.target.value) })} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Max Abandonment % (CBN cap: 3%)</label>
          <input type="number" min={0.5} max={3} step={0.1} value={form.max_abandonment_pct}
            onChange={e => onChange({ ...form, max_abandonment_pct: Number(e.target.value) })} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Caller ID (outbound number)</label>
          <input value={form.caller_id} onChange={e => onChange({ ...form, caller_id: e.target.value })} placeholder="+2348000000000" style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Max Attempts per Contact</label>
          <input type="number" min={1} max={10} value={form.max_attempts}
            onChange={e => onChange({ ...form, max_attempts: Number(e.target.value) })} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Retry Delay (minutes)</label>
          <input type="number" min={5} max={1440} value={form.retry_delay_minutes}
            onChange={e => onChange({ ...form, retry_delay_minutes: Number(e.target.value) })} style={inputSt} />
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 8 }}>
          Daily Schedule (optional)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelSt}>Start Time</label>
            <input type="time" value={form.schedule_start} onChange={e => onChange({ ...form, schedule_start: e.target.value })} style={inputSt} />
          </div>
          <div>
            <label style={labelSt}>End Time</label>
            <input type="time" value={form.schedule_end} onChange={e => onChange({ ...form, schedule_end: e.target.value })} style={inputSt} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Stats Panel ───────────────────────────────────────────────────────────────

function StatsTile({ label, value, sub, colour }: { label: string; value: string | number; sub?: string; colour?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 100, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 16px' }}>
      <div style={{ fontSize: 11.5, color: 'var(--txt3)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: colour ?? 'var(--txt)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DialerCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [newOpen, setNewOpen] = useState(false)
  const [editCamp, setEditCamp] = useState<Campaign | null>(null)
  const [deleteCamp, setDeleteCamp] = useState<Campaign | null>(null)
  const [form, setForm] = useState<CampaignForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Contacts upload
  const [uploadCamp, setUploadCamp] = useState<Campaign | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [uploading, setUploading] = useState(false)

  // Expanded stats
  const [statsMap, setStatsMap] = useState<Record<number, CampaignStats>>({})

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await apiFetch<Campaign[]>('/api/dialer/campaigns')
      setCampaigns(Array.isArray(data) ? data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function loadStats(id: number) {
    try {
      const s = await apiFetch<CampaignStats>(`/api/dialer/campaigns/${id}/stats`)
      setStatsMap(prev => ({ ...prev, [id]: s }))
    } catch { /* ignore */ }
  }

  async function handleCreate() {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/dialer/campaigns', form)
      toast.success('Campaign created')
      setNewOpen(false)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleUpdate() {
    if (!editCamp) return
    setSaving(true)
    try {
      await apiPut(`/api/dialer/campaigns/${editCamp.id}`, form)
      toast.success('Campaign updated')
      setEditCamp(null)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!deleteCamp) return
    setDeleting(true)
    try {
      await apiFetch(`/api/dialer/campaigns/${deleteCamp.id}`, { method: 'DELETE' })
      toast.success('Campaign deleted')
      setDeleteCamp(null)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setDeleting(false) }
  }

  async function handleLifecycle(id: number, action: 'start' | 'pause' | 'stop') {
    try {
      await apiPost(`/api/dialer/campaigns/${id}/${action}`, {})
      const label = action === 'start' ? 'started' : action === 'pause' ? 'paused' : 'stopped'
      toast.success(`Campaign ${label}`)
      load()
    } catch (e: any) { toast.error(e.message) }
  }

  async function handleUpload() {
    if (!uploadCamp || !uploadFile) { toast.error('Select a CSV file'); return }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      const res = await fetch(`${API}/api/dialer/campaigns/${uploadCamp.id}/contacts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        body: fd,
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json() as UploadResult
      setUploadResult(data)
      toast.success(`Uploaded ${data.inserted} contacts`)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setUploading(false) }
  }

  const cols: TableCol<Campaign>[] = [
    {
      key: 'name', label: 'Campaign',
      render: c => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
          {c.description && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{c.description}</div>}
        </div>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: c => {
        const st = STATUS_COLOUR[c.status] ?? STATUS_COLOUR.draft
        return <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 10, background: st.bg, color: st.txt }}>{c.status}</span>
      },
    },
    { key: 'dial_ratio', label: 'Dial Ratio', render: c => `${c.dial_ratio}×` },
    { key: 'max_abandonment_pct', label: 'Max Abandon', render: c => `${c.max_abandonment_pct}%` },
    { key: 'max_attempts', label: 'Max Attempts', render: c => String(c.max_attempts) },
    { key: 'created_at', label: 'Created', render: c => fmtDatetime(c.created_at) },
    {
      key: 'id', label: 'Actions',
      render: c => (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {c.status === 'draft' || c.status === 'paused' ? (
            <button onClick={() => handleLifecycle(c.id, 'start')} style={{ padding: '3px 10px', borderRadius: 6, border: `1.5px solid ${GREEN}40`, background: `${GREEN}10`, color: GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Start</button>
          ) : null}
          {c.status === 'active' ? (
            <>
              <button onClick={() => handleLifecycle(c.id, 'pause')} style={{ padding: '3px 10px', borderRadius: 6, border: `1.5px solid ${AMBER}40`, background: `${AMBER}10`, color: AMBER, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Pause</button>
              <button onClick={() => handleLifecycle(c.id, 'stop')} style={{ padding: '3px 10px', borderRadius: 6, border: `1.5px solid ${RED}40`, background: `${RED}10`, color: RED, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Stop</button>
            </>
          ) : null}
          <button onClick={() => { setUploadCamp(c); setUploadFile(null); setUploadResult(null) }}
            style={{ padding: '3px 10px', borderRadius: 6, border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
            Upload
          </button>
          <button onClick={() => loadStats(c.id)}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1.5px solid var(--input-bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
            Stats
          </button>
          <button onClick={() => { setForm({ name: c.name, description: c.description, dial_ratio: c.dial_ratio, max_abandonment_pct: c.max_abandonment_pct, caller_id: c.caller_id, max_attempts: c.max_attempts, retry_delay_minutes: c.retry_delay_minutes, schedule_start: c.schedule_start ?? '', schedule_end: c.schedule_end ?? '' }); setEditCamp(c) }}
            style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--input-bdr)', background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
          </button>
          <button onClick={() => setDeleteCamp(c)}
            style={{ width: 28, height: 28, borderRadius: 6, border: `1.5px solid ${RED}30`, background: `${RED}08`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: RED }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
          </button>
        </div>
      ),
    },
  ]

  const modalFooter = (onSave: () => void, label = 'Save') => (
    <div style={{ display: 'flex', gap: 8 }}>
      <button onClick={onSave} disabled={saving}
        style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {saving && <Spinner size={13} color="#fff" />}{label}
      </button>
      <button onClick={() => { setNewOpen(false); setEditCamp(null) }}
        style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
        Cancel
      </button>
    </div>
  )

  return (
    <Page
      title="Dialer Campaigns"
      subtitle="Create and manage predictive dialer campaigns"
      actions={
        <button onClick={() => { setForm(EMPTY_FORM); setNewOpen(true) }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Campaign
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={28} /></div>
      ) : (
        <SectionCard title="All Campaigns">
          <DataTable cols={cols} rows={campaigns} emptyText="No campaigns yet. Create one to start auto-dialing." />

          {/* Inline stats panels */}
          {Object.entries(statsMap).map(([idStr, stats]) => {
            const camp = campaigns.find(c => c.id === Number(idStr))
            if (!camp) return null
            const abanColour = stats.abandon_pct >= 2.5 ? RED : stats.abandon_pct >= 1.5 ? AMBER : GREEN
            return (
              <div key={idStr} style={{ marginTop: 12, padding: 16, background: 'var(--th-bg)', borderRadius: 10, border: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: NAVY, marginBottom: 12 }}>
                  Stats — {camp.name}
                  <button onClick={() => setStatsMap(prev => { const n = { ...prev }; delete n[Number(idStr)]; return n })}
                    style={{ marginLeft: 10, fontSize: 11, color: 'var(--txt3)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <StatsTile label="Queue (pending)" value={queuePending(stats)} />
                  <StatsTile label="Queue (total)" value={queueTotal(stats)} />
                  <StatsTile label="Calls Answered" value={callsAnswered(stats)} />
                  <StatsTile label="Calls Total" value={callsTotal(stats)} />
                  <StatsTile label="Abandonment Rate" value={`${stats.abandon_pct}%`} sub={`CBN limit: ${stats.cbn_limit_pct}%`} colour={abanColour} />
                  <StatsTile label="Agents Ready" value={stats.sessions.find(s => s.status === 'ready')?.cnt ?? 0} />
                  <StatsTile label="Agents On Call" value={stats.sessions.find(s => s.status === 'on_call')?.cnt ?? 0} colour={GREEN} />
                </div>
              </div>
            )
          })}
        </SectionCard>
      )}

      {/* New Campaign modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Dialer Campaign" width={540} footer={modalFooter(handleCreate, 'Create Campaign')}>
        <CampaignFormFields form={form} onChange={setForm} />
      </Modal>

      {/* Edit Campaign modal */}
      <Modal open={!!editCamp} onClose={() => setEditCamp(null)} title="Edit Campaign" width={540} footer={modalFooter(handleUpdate)}>
        <CampaignFormFields form={form} onChange={setForm} />
      </Modal>

      {/* Upload contacts modal */}
      <Modal open={!!uploadCamp} onClose={() => { setUploadCamp(null); setUploadResult(null) }} title={`Upload Contacts — ${uploadCamp?.name ?? ''}`} width={440}
        footer={
          uploadResult ? (
            <button onClick={() => { setUploadCamp(null); setUploadResult(null) }}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
              Close
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleUpload} disabled={uploading || !uploadFile}
                style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: !uploadFile || uploading ? 'not-allowed' : 'pointer', opacity: !uploadFile || uploading ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {uploading && <Spinner size={13} color="#fff" />}Upload
              </button>
              <button onClick={() => setUploadCamp(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            </div>
          )
        }
      >
        {uploadResult ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 40, color: GREEN }}>check_circle</span>
            <div style={{ marginTop: 10, fontSize: 15, fontWeight: 600 }}>Upload complete</div>
            <div style={{ fontSize: 13, color: 'var(--txt2)', marginTop: 6 }}>
              {uploadResult.inserted} of {uploadResult.total} contacts added to queue
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ fontSize: 13, color: 'var(--txt2)', margin: 0 }}>
              Upload a CSV file with columns: <strong>phone</strong> (required), customer_name, cif, priority
            </p>
            <input type="file" accept=".csv,text/csv"
              onChange={e => setUploadFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 13 }} />
            {uploadFile && <div style={{ fontSize: 12, color: 'var(--txt3)' }}>Selected: {uploadFile.name} ({Math.round(uploadFile.size / 1024)} KB)</div>}
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <ConfirmModal
        open={!!deleteCamp}
        title="Delete Campaign"
        body={`Delete "${deleteCamp?.name}"? All contacts and call logs will be removed.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteCamp(null)}
      />
    </Page>
  )
}
