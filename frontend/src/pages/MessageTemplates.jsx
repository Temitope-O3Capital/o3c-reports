import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'
import EmailBlockEditor, { exportToHtml } from '../components/EmailBlockEditor.jsx'

const CATEGORIES = ['general','collections','marketing','onboarding','repayment_reminder']
const CAT_LABELS = {
  general: 'General', collections: 'Collections', marketing: 'Marketing',
  onboarding: 'Onboarding', repayment_reminder: 'Repayment Reminder',
}

const MERGE_TAGS_HELP = [
  '{{first_name}}', '{{last_name}}', '{{amount}}', '{{due_date}}', '{{cif}}',
]

function CatBadge({ category }) {
  const COLORS = {
    general: '#6B7280', collections: '#C00000', marketing: '#3B82F6',
    onboarding: '#059669', repayment_reminder: '#D97706',
  }
  const c = COLORS[category] || '#6B7280'
  return (
    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '2px 8px', borderRadius: 999, color: c, background: c + '18' }}>
      {CAT_LABELS[category] || category}
    </span>
  )
}

/* ── Template form modal ── */
function TemplateModal({ tpl, onClose, onSaved }) {
  const [form, setForm] = useState({
    name:          tpl?.name          || '',
    channel:       tpl?.channel       || 'sms',
    category:      tpl?.category      || 'general',
    sms_body:      tpl?.sms_body      || '',
    email_subject: tpl?.email_subject || '',
    email_blocks:  tpl?.email_blocks  || [],
    merge_tags:    tpl?.merge_tags    || [],
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const isEmail = form.channel === 'email'
  const isSms   = form.channel === 'sms'

  const save = async () => {
    if (!form.name.trim()) return setError('Name is required')
    setSaving(true); setError('')
    try {
      const email_body_html = isEmail ? exportToHtml(form.email_blocks || []) : ''
      const body = { ...form, email_body_html }
      const saved = tpl?.id
        ? await apiFetch(`/api/message-templates/${tpl.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : await apiFetch('/api/message-templates', { method: 'POST', body: JSON.stringify(body) })
      onSaved(saved)
    } catch (e) {
      setError(e.message || 'Failed to save')
    } finally { setSaving(false) }
  }

  const smsChars = (form.sms_body || '').length
  const smsParts = Math.ceil(smsChars / 160) || 1

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: isEmail ? 960 : 560, maxHeight: '94vh', display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>{tpl?.id ? 'Edit Template' : 'New Template'}</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && <p style={{ color: '#C00000', fontSize: 13 }}>{error}</p>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Template Name *</label>
              <input className="form-input" placeholder="Collections SMS — June"
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="form-label">Category</label>
              <select className="form-input" value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
              </select>
            </div>
          </div>

          {!tpl?.id && (
            <div>
              <label className="form-label">Channel</label>
              <div className="flex gap-2">
                {[['sms','SMS','sms'],['email','Email','email']].map(([k, label, icon]) => (
                  <button key={k} type="button"
                    onClick={() => setForm(f => ({ ...f, channel: k }))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
                      borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                      border: `1.5px solid ${form.channel === k ? '#0E2841' : 'rgb(var(--border) / 0.2)'}`,
                      background: form.channel === k ? '#0E2841' : 'transparent',
                      color: form.channel === k ? '#fff' : 'rgb(var(--fg-2))',
                    }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isSms && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="form-label" style={{ marginBottom: 0 }}>SMS Body *</label>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: smsChars > 160 ? '#D97706' : 'rgb(var(--fg-3))' }}>
                  {smsChars} chars · {smsParts} part{smsParts > 1 ? 's' : ''}
                </span>
              </div>
              <textarea className="form-input" rows={6} placeholder="Dear {{first_name}}, …"
                value={form.sms_body} onChange={e => setForm(f => ({ ...f, sms_body: e.target.value }))} />
              <div className="flex flex-wrap gap-1 mt-2">
                {MERGE_TAGS_HELP.map(tag => (
                  <button key={tag} type="button"
                    onClick={() => setForm(f => ({ ...f, sms_body: (f.sms_body || '') + tag }))}
                    style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgb(var(--bg-muted))', border: '1px solid rgb(var(--border) / 0.2)', cursor: 'pointer', fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-2))' }}>
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isEmail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label className="form-label">Subject Line *</label>
                <input className="form-input" placeholder="Your card is ready — {{first_name}}"
                  value={form.email_subject} onChange={e => setForm(f => ({ ...f, email_subject: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Email Body</label>
                <EmailBlockEditor
                  value={{ blocks: form.email_blocks || [] }}
                  onChange={({ blocks }) => setForm(f => ({ ...f, email_blocks: blocks }))}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5" style={{ borderTop: '1px solid rgb(var(--border) / 0.1)' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : (tpl?.id ? 'Update Template' : 'Save Template')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Main page ── */
export default function MessageTemplates() {
  const [templates, setTemplates] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [channel,   setChannel]   = useState('')
  const [category,  setCategory]  = useState('')
  const [search,    setSearch]    = useState('')
  const [modal,     setModal]     = useState(null) // null | {} (new) | {template} (edit)
  const [deleting,  setDeleting]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams()
      if (channel)  qs.set('channel',  channel)
      if (category) qs.set('category', category)
      const data = await apiFetch(`/api/message-templates?${qs}`)
      setTemplates(data || [])
    } catch (e) {
      setError(e.message || 'Failed to load templates')
    } finally { setLoading(false) }
  }, [channel, category])

  useEffect(() => { load() }, [load])

  const doDelete = async (id) => {
    if (!confirm('Delete this template? This cannot be undone.')) return
    setDeleting(id)
    try {
      await apiFetch(`/api/message-templates/${id}`, { method: 'DELETE' })
      setTemplates(t => t.filter(x => x.id !== id))
    } catch (e) { alert(e.message || 'Delete failed') } finally { setDeleting(null) }
  }

  const filtered = search.trim()
    ? templates.filter(t => t.name.toLowerCase().includes(search.toLowerCase()) || (t.email_subject || '').toLowerCase().includes(search.toLowerCase()))
    : templates

  return (
    <PageShell
      title="Message Templates"
      subtitle="Reusable SMS and email templates for campaigns"
      error={error}
      actions={
        <div className="flex items-center gap-2">
          <input className="form-input" style={{ fontSize: 12, maxWidth: 200 }}
            placeholder="Search templates…" value={search}
            onChange={e => setSearch(e.target.value)} />
          <select className="form-input" style={{ fontSize: 12, padding: '6px 10px' }}
            value={channel} onChange={e => setChannel(e.target.value)}>
            <option value="">All channels</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
          <select className="form-input" style={{ fontSize: 12, padding: '6px 10px' }}
            value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
          </select>
          <button className="btn btn-primary" onClick={() => setModal({})}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>add</span>
            New Template
          </button>
        </div>
      }
    >
      {/* Tabs: SMS | Email */}
      {!channel && (
        <div className="flex gap-2 mb-5">
          {[['', 'All'], ['sms', 'SMS'], ['email', 'Email']].map(([k, l]) => (
            <button key={k} type="button"
              onClick={() => setChannel(k)}
              style={{
                fontSize: 12, fontWeight: 600, padding: '6px 16px', borderRadius: 999, cursor: 'pointer',
                border: `1.5px solid ${channel === k ? '#0E2841' : 'rgb(var(--border) / 0.2)'}`,
                background: channel === k ? '#0E2841' : 'transparent',
                color: channel === k ? '#fff' : 'rgb(var(--fg-2))',
              }}>{l} {l === 'All' ? `(${templates.length})` : `(${templates.filter(t => t.channel === k).length})`}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'rgb(var(--fg-4))', display: 'block', marginBottom: 12 }}>article</span>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--fg-2))', marginBottom: 4 }}>No templates yet</p>
          <p style={{ fontSize: 13, color: 'rgb(var(--fg-3))', marginBottom: 16 }}>Create reusable message templates to speed up campaign creation</p>
          <button className="btn btn-primary" onClick={() => setModal({})}>New Template</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(tpl => (
            <div key={tpl.id} className="card p-5">
              <div className="flex items-start justify-between mb-3 gap-2">
                <div className="flex-1 min-w-0">
                  <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tpl.name}</h3>
                  <div className="flex items-center gap-2">
                    <span style={{
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                      padding: '2px 8px', borderRadius: 999,
                      color: tpl.channel === 'sms' ? '#059669' : '#3B82F6',
                      background: tpl.channel === 'sms' ? '#F0FDF4' : '#EFF6FF',
                    }}>{tpl.channel === 'sms' ? 'SMS' : 'Email'}</span>
                    <CatBadge category={tpl.category} />
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button className="btn btn-icon btn-ghost btn-sm" title="Edit" onClick={() => setModal(tpl)}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>edit</span>
                  </button>
                  <button className="btn btn-icon btn-ghost btn-sm" title="Delete"
                    style={{ color: '#C00000' }}
                    disabled={deleting === tpl.id}
                    onClick={() => doDelete(tpl.id)}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span>
                  </button>
                </div>
              </div>

              {tpl.channel === 'sms' ? (
                <p style={{ fontSize: 12, color: 'rgb(var(--fg-2))', lineHeight: 1.6, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
                  {tpl.sms_body || <span style={{ color: 'rgb(var(--fg-4))' }}>No body</span>}
                </p>
              ) : (
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--fg-2))', marginBottom: 2 }}>
                    {tpl.email_subject || <span style={{ color: 'rgb(var(--fg-4))' }}>No subject</span>}
                  </p>
                  {tpl.email_body_html && (
                    <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>HTML body ready</p>
                  )}
                </div>
              )}

              <p style={{ fontSize: 10, color: 'rgb(var(--fg-4))', marginTop: 10 }}>
                {tpl.created_at ? new Date(tpl.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
                {tpl.created_by_name ? ` · ${tpl.created_by_name}` : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      {modal !== null && (
        <TemplateModal
          tpl={modal?.id ? modal : null}
          onClose={() => setModal(null)}
          onSaved={(saved) => {
            setModal(null)
            load()
          }}
        />
      )}
    </PageShell>
  )
}
