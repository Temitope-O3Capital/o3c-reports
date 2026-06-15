import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'
import EmailBlockEditor, { exportToHtml } from '../components/EmailBlockEditor.jsx'

/* ── Helpers ── */
const TYPE_CONFIG = {
  sms:   { label: 'SMS',       icon: 'sms',           color: '#059669', bg: '#F0FDF4' },
  email: { label: 'Email',     icon: 'email',         color: '#3B82F6', bg: '#EFF6FF' },
  multi: { label: 'SMS + Email', icon: 'forum',       color: '#8B5CF6', bg: '#F5F3FF' },
}
const STATUS_CONFIG = {
  draft:     { label: 'Draft',     color: '#6B7280', bg: '#F3F4F6' },
  scheduled: { label: 'Scheduled', color: '#F59E0B', bg: '#FFFBEB' },
  active:    { label: 'Active',    color: '#059669', bg: '#F0FDF4' },
  paused:    { label: 'Paused',    color: '#D97706', bg: '#FFF7ED' },
  completed: { label: 'Completed', color: '#0EA5E9', bg: '#F0F9FF' },
  cancelled: { label: 'Cancelled', color: '#C00000', bg: '#FFF0F0' },
}

function TypeBadge({ type }) {
  const t = TYPE_CONFIG[type] || TYPE_CONFIG.sms
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '2px 8px', borderRadius: 999, color: t.color, background: t.bg,
    }}>{t.label}</span>
  )
}
function StatusBadge({ status }) {
  const s = STATUS_CONFIG[status] || STATUS_CONFIG.draft
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '2px 8px', borderRadius: 999, color: s.color, background: s.bg,
    }}>{s.label}</span>
  )
}

function ProgressBar({ value, max, color = '#059669' }) {
  const pct = max > 0 ? Math.min(100, Math.round(value / max * 100)) : 0
  return (
    <div>
      <div style={{ height: 4, background: 'rgb(var(--bg-muted))', borderRadius: 2 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
      </div>
      <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginTop: 2 }}>{pct}% ({value.toLocaleString()} / {max.toLocaleString()})</p>
    </div>
  )
}

/* ── Campaign wizard ── */
const STEPS = ['Channel', 'Audience', 'Compose', 'Review']

function Step1Channel({ form, setForm }) {
  return (
    <div>
      <p style={{ fontSize: 13, color: 'rgb(var(--fg-2))', marginBottom: 20 }}>
        Choose how you want to reach your audience.
      </p>
      <div className="grid grid-cols-3 gap-4">
        {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
          <button key={key} type="button"
            onClick={() => setForm(f => ({ ...f, type: key }))}
            style={{
              padding: '20px 16px', borderRadius: 12, cursor: 'pointer', textAlign: 'center',
              border: `2px solid ${form.type === key ? cfg.color : 'rgb(var(--border) / 0.15)'}`,
              background: form.type === key ? cfg.bg : 'rgb(var(--bg-surface))',
              transition: 'all 0.15s ease',
            }}>
            <span className="material-symbols-rounded" style={{ fontSize: 28, color: cfg.color, display: 'block', marginBottom: 8 }}>
              {cfg.icon}
            </span>
            <p style={{ fontSize: 13, fontWeight: 700, color: 'rgb(var(--fg-1))' }}>{cfg.label}</p>
          </button>
        ))}
      </div>
      <div className="mt-6">
        <label className="form-label">Campaign Name *</label>
        <input className="form-input" required placeholder="e.g. June Collections Reminder"
          value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      </div>
      <div className="mt-4">
        <label className="form-label">Description (optional)</label>
        <input className="form-input" placeholder="Internal note about this campaign"
          value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
      </div>
    </div>
  )
}

function Step2Audience({ form, setForm, lists }) {
  const [uploadFile, setUploadFile]   = useState(null)
  const [newListName, setNewListName] = useState('')
  const [mode, setMode]               = useState('existing') // existing | upload
  const [uploading, setUploading]     = useState(false)
  const [uploadResult, setUploadResult] = useState(null)

  const uploadCsv = async () => {
    if (!uploadFile || !newListName.trim()) return
    setUploading(true)
    try {
      // Create list first
      const lst = await apiFetch('/api/contact-lists', {
        method: 'POST', body: JSON.stringify({ name: newListName }),
      })
      // Upload CSV
      const fd = new FormData()
      fd.append('file', uploadFile)
      const result = await apiFetch(`/api/contact-lists/${lst.id}/upload`, { method: 'POST', body: fd, isFormData: true })
      setUploadResult({ list: lst, ...result })
      setForm(f => ({ ...f, list_id: lst.id, list_name: lst.name }))
    } catch (e) {
      alert('Upload failed: ' + (e.message || 'Unknown error'))
    } finally { setUploading(false) }
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'rgb(var(--fg-2))', marginBottom: 20 }}>
        Select who will receive this campaign.
      </p>
      <div className="flex gap-2 mb-4">
        {[['existing','Use existing list'], ['upload','Upload new contacts']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setMode(k)}
            style={{
              fontSize: 12, fontWeight: 600, padding: '6px 16px', borderRadius: 999, cursor: 'pointer',
              border: `1.5px solid ${mode === k ? '#0E2841' : 'rgb(var(--border) / 0.2)'}`,
              background: mode === k ? '#0E2841' : 'transparent',
              color: mode === k ? '#fff' : 'rgb(var(--fg-2))',
            }}>{l}</button>
        ))}
      </div>

      {mode === 'existing' && (
        <div>
          <label className="form-label">Contact List</label>
          <select className="form-input" value={form.list_id || ''}
            onChange={e => {
              const lst = lists.find(l => l.id === Number(e.target.value))
              setForm(f => ({ ...f, list_id: Number(e.target.value) || null, list_name: lst?.name || '' }))
            }}>
            <option value="">Select a list…</option>
            {lists.map(l => (
              <option key={l.id} value={l.id}>{l.name} ({l.member_count.toLocaleString()} contacts)</option>
            ))}
          </select>
          {form.list_id && (
            <p style={{ fontSize: 12, color: '#059669', marginTop: 8 }}>
              ✓ {lists.find(l => l.id === form.list_id)?.member_count.toLocaleString()} contacts selected
            </p>
          )}
        </div>
      )}

      {mode === 'upload' && (
        <div>
          <label className="form-label">List Name *</label>
          <input className="form-input mb-3" placeholder="e.g. June Leads"
            value={newListName} onChange={e => setNewListName(e.target.value)} />
          <label className="form-label">CSV File *</label>
          <input type="file" accept=".csv"
            onChange={e => setUploadFile(e.target.files?.[0] || null)}
            style={{ display: 'block', fontSize: 13, marginBottom: 12 }} />
          <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginBottom: 12 }}>
            Columns: <code>first_name, last_name, phone, email, cif_number</code> + any custom merge fields
          </p>
          <button type="button" className="btn btn-primary btn-sm"
            onClick={uploadCsv}
            disabled={uploading || !uploadFile || !newListName.trim()}>
            {uploading ? 'Uploading…' : 'Upload CSV'}
          </button>
          {uploadResult && (
            <div className="mt-3 p-3 rounded-lg" style={{ background: '#F0FDF4', border: '1px solid #059669' }}>
              <p style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>
                ✓ {uploadResult.inserted} contacts uploaded to "{uploadResult.list.name}"
              </p>
              {uploadResult.errors?.length > 0 && (
                <p style={{ fontSize: 11, color: '#D97706', marginTop: 4 }}>
                  {uploadResult.errors.length} rows skipped
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Step3Compose({ form, setForm }) {
  const isSms   = form.type === 'sms'   || form.type === 'multi'
  const isEmail = form.type === 'email' || form.type === 'multi'
  const SMS_CHAR_LIMIT = 160
  const smsChars = (form.sms_body || '').length
  const smsParts = Math.ceil(smsChars / SMS_CHAR_LIMIT) || 1

  return (
    <div>
      {isSms && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <label className="form-label" style={{ marginBottom: 0 }}>SMS Message *</label>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: smsChars > SMS_CHAR_LIMIT ? '#D97706' : 'rgb(var(--fg-3))' }}>
              {smsChars} chars · {smsParts} part{smsParts > 1 ? 's' : ''}
            </span>
          </div>
          <textarea className="form-input" rows={5}
            placeholder="Dear {{first_name}}, your card is ready for pickup…"
            value={form.sms_body || ''}
            onChange={e => setForm(f => ({ ...f, sms_body: e.target.value }))} />
          <div className="flex flex-wrap gap-1 mt-2">
            {['{{first_name}}', '{{last_name}}', '{{amount}}', '{{due_date}}'].map(t => (
              <button key={t} type="button"
                onClick={() => setForm(f => ({ ...f, sms_body: (f.sms_body || '') + t }))}
                style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'rgb(var(--bg-muted))', border: '1px solid rgb(var(--border)/0.2)', cursor: 'pointer', fontFamily: 'monospace', color: 'rgb(var(--fg-2))' }}>
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {isEmail && (
        <div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="form-label">From Name</label>
              <input className="form-input" placeholder="O3C Cards"
                value={form.from_name || ''} onChange={e => setForm(f => ({ ...f, from_name: e.target.value }))} />
            </div>
            <div>
              <label className="form-label">From Email</label>
              <input className="form-input" type="email" placeholder="campaigns@o3ccards.com"
                value={form.from_email || ''} onChange={e => setForm(f => ({ ...f, from_email: e.target.value }))} />
            </div>
          </div>
          <div className="mb-4">
            <label className="form-label">Subject Line *</label>
            <input className="form-input" placeholder="Your O3C Card is ready — {{first_name}}"
              value={form.email_subject || ''} onChange={e => setForm(f => ({ ...f, email_subject: e.target.value }))} />
          </div>
          <label className="form-label">Email Body</label>
          <EmailBlockEditor
            value={{ blocks: form.email_blocks || [] }}
            onChange={({ blocks }) => setForm(f => ({ ...f, email_blocks: blocks }))}
          />
        </div>
      )}
    </div>
  )
}

function Step4Review({ form, lists }) {
  const typeConf  = TYPE_CONFIG[form.type]  || TYPE_CONFIG.sms
  const list = lists.find(l => l.id === form.list_id)
  const isSms   = form.type === 'sms'   || form.type === 'multi'
  const isEmail = form.type === 'email' || form.type === 'multi'

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-xl" style={{ background: 'rgb(var(--bg-subtle))', border: '1px solid rgb(var(--border) / 0.1)' }}>
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))', marginBottom: 12 }}>Campaign Summary</p>
        {[
          ['Name',    form.name        || '—'],
          ['Channel', typeConf.label],
          ['Audience', list ? `${list.name} (${list.member_count.toLocaleString()} contacts)` : '—'],
          ...(isEmail ? [
            ['Subject',   form.email_subject || '—'],
            ['From',      `${form.from_name || 'O3C Cards'} <${form.from_email || '—'}>`],
          ] : []),
          ...(isSms ? [['SMS Body', (form.sms_body || '—').slice(0, 80) + ((form.sms_body?.length || 0) > 80 ? '…' : '')]] : []),
        ].map(([k, v]) => (
          <div key={k} className="flex gap-4 py-2" style={{ borderBottom: '1px solid rgb(var(--border) / 0.06)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--fg-3))', minWidth: 80 }}>{k}</span>
            <span style={{ fontSize: 12, color: 'rgb(var(--fg-1))' }}>{v}</span>
          </div>
        ))}
      </div>
      <div className="p-4 rounded-xl" style={{ background: '#FFFBEB', border: '1px solid #F59E0B44' }}>
        <div className="flex gap-2">
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: '#D97706', flexShrink: 0 }}>info</span>
          <div style={{ fontSize: 12, color: '#92400E' }}>
            <p className="font-semibold mb-1">Before launching:</p>
            <ul style={{ paddingLeft: 16, lineHeight: 1.8 }}>
              {isEmail && <li>Ensure your sending domain has SPF and DKIM configured in SendGrid</li>}
              {isSms   && <li>Ensure your Termii sender ID is registered and approved</li>}
              <li>Every message includes an unsubscribe option as required</li>
              <li>Sending will begin immediately and cannot be undone — pause is possible</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Campaign creation wizard modal ── */
function CampaignWizard({ lists, onClose, onCreated }) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState({
    name: '', description: '', type: 'sms',
    list_id: null, list_name: '',
    sms_body: '', email_subject: '', email_blocks: [],
    from_name: '', from_email: '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const [launch, setLaunch] = useState(false)

  const canNext = () => {
    if (step === 0) return form.name.trim().length > 0
    if (step === 1) return !!form.list_id
    if (step === 2) {
      const needSms   = form.type === 'sms'   || form.type === 'multi'
      const needEmail = form.type === 'email' || form.type === 'multi'
      return (!needSms || form.sms_body?.trim()) && (!needEmail || form.email_subject?.trim())
    }
    return true
  }

  const next = () => setStep(s => Math.min(s + 1, 3))

  const create = async () => {
    setSaving(true); setError('')
    try {
      const email_body_html = exportToHtml(form.email_blocks || [])
      const campaign = await apiFetch('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({ ...form, email_body_html }),
      })
      if (launch) {
        await apiFetch(`/api/campaigns/${campaign.id}/start`, { method: 'POST' })
      }
      onCreated(campaign)
    } catch (e) {
      setError(e.message || 'Failed to create campaign')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ width: '100%', maxWidth: step === 2 ? 900 : 600, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>New Campaign</h2>
            <button onClick={onClose} className="btn btn-icon btn-ghost">
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
            </button>
          </div>
          {/* Step progress */}
          <div className="flex items-center gap-0">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center" style={{ flex: i < STEPS.length - 1 ? 1 : undefined }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: i <= step ? '#0E2841' : 'rgb(var(--bg-muted))',
                  color: i <= step ? '#fff' : 'rgb(var(--fg-3))',
                  fontSize: 12, fontWeight: 700,
                }}>
                  {i < step ? <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check</span> : i + 1}
                </div>
                <span style={{ fontSize: 11, marginLeft: 6, fontWeight: i === step ? 700 : 400, color: i === step ? 'rgb(var(--fg-1))' : 'rgb(var(--fg-3))' }}>
                  {s}
                </span>
                {i < STEPS.length - 1 && (
                  <div style={{ flex: 1, height: 1, background: i < step ? '#0E2841' : 'rgb(var(--bg-muted))', margin: '0 12px' }} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {error && <p style={{ color: '#C00000', fontSize: 13, marginBottom: 12 }}>{error}</p>}
          {step === 0 && <Step1Channel form={form} setForm={setForm} />}
          {step === 1 && <Step2Audience form={form} setForm={setForm} lists={lists} />}
          {step === 2 && <Step3Compose  form={form} setForm={setForm} />}
          {step === 3 && <Step4Review   form={form} lists={lists} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5" style={{ borderTop: '1px solid rgb(var(--border) / 0.1)' }}>
          <button type="button" className="btn btn-ghost"
            onClick={() => step === 0 ? onClose() : setStep(s => s - 1)}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          <div className="flex items-center gap-3">
            {step === 3 && (
              <label className="flex items-center gap-2" style={{ fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={launch} onChange={e => setLaunch(e.target.checked)} />
                Launch immediately
              </label>
            )}
            {step < 3 ? (
              <button type="button" className="btn btn-primary" onClick={next} disabled={!canNext()}>
                Next
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_forward</span>
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={create} disabled={saving}>
                {saving ? 'Creating…' : launch ? 'Create & Launch' : 'Save as Draft'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Campaign list card ── */
function CampaignCard({ campaign, onClick }) {
  const typeConf = TYPE_CONFIG[campaign.type] || TYPE_CONFIG.sms
  const isSms   = campaign.type === 'sms'   || campaign.type === 'multi'
  const isEmail = campaign.type === 'email' || campaign.type === 'multi'
  const total   = campaign.total_contacts || 0
  return (
    <div className="card card-hover p-5 cursor-pointer" onClick={onClick}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'rgb(var(--fg-1))' }}>{campaign.name}</h3>
          </div>
          <div className="flex items-center gap-2">
            <TypeBadge type={campaign.type} />
            <StatusBadge status={campaign.status} />
            {campaign.list_name && (
              <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{campaign.list_name}</span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <p style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-1))' }}>
            {total.toLocaleString()}
          </p>
          <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Contacts</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid gap-3" style={{ gridTemplateColumns: isSms && isEmail ? '1fr 1fr' : '1fr' }}>
        {isSms && total > 0 && (
          <div>
            <p style={{ fontSize: 10, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>SMS</p>
            <ProgressBar value={campaign.sms_delivered} max={total} color="#059669" />
          </div>
        )}
        {isEmail && total > 0 && (
          <div>
            <p style={{ fontSize: 10, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Email Opens</p>
            <ProgressBar value={campaign.emails_opened} max={campaign.emails_sent || 1} color="#3B82F6" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-3">
        <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>
          {campaign.created_at ? new Date(campaign.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
          {campaign.created_by_name ? ` · ${campaign.created_by_name}` : ''}
        </span>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'rgb(var(--fg-3))' }}>arrow_forward</span>
      </div>
    </div>
  )
}

/* ── Main page ── */
export default function Campaigns() {
  const navigate  = useNavigate()
  const [campaigns, setCampaigns] = useState([])
  const [lists,     setLists]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [showWizard, setShowWizard] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams()
      if (typeFilter)   qs.set('type',   typeFilter)
      if (statusFilter) qs.set('status', statusFilter)
      const [camps, lstList] = await Promise.all([
        apiFetch(`/api/campaigns?${qs}`),
        apiFetch('/api/contact-lists?limit=200'),
      ])
      setCampaigns(camps || [])
      setLists(lstList || [])
    } catch (e) {
      setError(e.message || 'Failed to load')
    } finally { setLoading(false) }
  }, [typeFilter, statusFilter])

  useEffect(() => { load() }, [load])

  const totals = {
    total:     campaigns.length,
    active:    campaigns.filter(c => c.status === 'active').length,
    completed: campaigns.filter(c => c.status === 'completed').length,
    contacts:  campaigns.reduce((s, c) => s + (c.total_contacts || 0), 0),
  }

  return (
    <PageShell
      title="Campaigns"
      subtitle="Bulk SMS and Email outreach campaigns"
      error={error}
      actions={
        <div className="flex items-center gap-2">
          <select className="form-input" style={{ fontSize: 12, padding: '6px 10px' }}
            value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All channels</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
            <option value="multi">SMS + Email</option>
          </select>
          <select className="form-input" style={{ fontSize: 12, padding: '6px 10px' }}
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn btn-primary" onClick={() => setShowWizard(true)}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>add</span>
            New Campaign
          </button>
        </div>
      }
    >
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Campaigns', value: totals.total,    icon: 'campaign',      color: '#0E2841' },
          { label: 'Active',          value: totals.active,   icon: 'play_circle',   color: '#059669' },
          { label: 'Completed',       value: totals.completed,icon: 'check_circle',  color: '#3B82F6' },
          { label: 'Total Contacts',  value: totals.contacts.toLocaleString(), icon: 'group', color: '#8B5CF6' },
        ].map(k => (
          <div key={k.label} className="card p-4 flex items-center gap-3">
            <div style={{ width: 36, height: 36, borderRadius: 8, background: k.color + '14', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: k.color }}>{k.icon}</span>
            </div>
            <div>
              <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>{k.label}</p>
              <p style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-1))' }}>{k.value}</p>
            </div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="spinner" /></div>
      ) : campaigns.length === 0 ? (
        <div className="card p-12 text-center">
          <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'rgb(var(--fg-4))', display: 'block', marginBottom: 12 }}>campaign</span>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--fg-2))', marginBottom: 4 }}>No campaigns yet</p>
          <p style={{ fontSize: 13, color: 'rgb(var(--fg-3))', marginBottom: 16 }}>Create your first SMS or Email campaign to reach your audience</p>
          <button className="btn btn-primary" onClick={() => setShowWizard(true)}>New Campaign</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {campaigns.map(c => (
            <CampaignCard key={c.id} campaign={c} onClick={() => navigate(`/campaigns/${c.id}`)} />
          ))}
        </div>
      )}

      {showWizard && (
        <CampaignWizard
          lists={lists}
          onClose={() => setShowWizard(false)}
          onCreated={(campaign) => {
            setShowWizard(false)
            navigate(`/campaigns/${campaign.id}`)
          }}
        />
      )}
    </PageShell>
  )
}
