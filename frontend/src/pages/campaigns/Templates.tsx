import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, btnPrimary, btnSecondary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Template {
  id: number
  name: string
  channel: string
  category: string
  sms_body?: string
  email_subject?: string
  email_body_text?: string
  merge_tags?: string
  created_at: string
  created_by_name?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const CHANNEL_COLOR: Record<string, string> = { email: BLUE, sms: PURPLE }
const CATEGORY_COLOR: Record<string, string> = {
  marketing: GREEN, collections: NAVY, general: '#6B7280',
  onboarding: BLUE, repayment_reminder: '#D97706',
}

function ChannelPill({ channel }: { channel: string }) {
  const c = CHANNEL_COLOR[channel] ?? '#6B7280'
  return <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${c}14`, color: c }}>{channel.toUpperCase()}</span>
}

function CategoryPill({ category }: { category: string }) {
  const c = CATEGORY_COLOR[category] ?? '#6B7280'
  const label = category.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return <span style={{ ...NUM, fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: `${c}10`, color: c }}>{label}</span>
}

const BLANK = { name: '', channel: 'sms', category: 'marketing', sms_body: '', email_subject: '', email_body_text: '' }

// ── Main component ─────────────────────────────────────────────────────────────

const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

export default function CampaignTemplates() {
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [channelFilter, setChannelFilter]   = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm]           = useState(BLANK)
  const [saving, setSaving]       = useState(false)
  const [saveErr, setSaveErr]     = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null)
  const [preview, setPreview]     = useState<Template | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (channelFilter)  p.set('channel',  channelFilter)
      if (categoryFilter) p.set('category', categoryFilter)
      const res = await apiFetch<Template[]>(`/api/message-templates?${p}`)
      setTemplates(Array.isArray(res) ? res : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [channelFilter, categoryFilter])

  useEffect(() => { load() }, [load])

  async function create() {
    if (!form.name.trim()) return
    setSaving(true); setSaveErr(null)
    try {
      const body: Record<string, any> = {
        name: form.name, channel: form.channel, category: form.category,
      }
      if (form.channel === 'email' || form.channel === 'multi') {
        body.email_subject  = form.email_subject
        body.email_body_text = form.email_body_text
      }
      if (form.channel === 'sms' || form.channel === 'multi') {
        body.sms_body = form.sms_body
      }
      await apiPost('/api/message-templates', body)
      setShowCreate(false); setForm(BLANK); load()
    } catch (ex: any) { setSaveErr(ex.message) }
    finally { setSaving(false) }
  }

  async function doDelete() {
    if (!deleteTarget) return
    try {
      await apiDelete(`/api/message-templates/${deleteTarget.id}`)
      setDeleteTarget(null); load()
    } catch (ex: any) { setErr(ex.message) }
  }

  function exportTemplatesCsv(data: Template[]) {
    const header = ['Name', 'Channel', 'Category', 'Created By', 'Created At']
    const lines = data.map(r => [
      `"${String(r.name ?? '').replace(/"/g, '""')}"`,
      r.channel ?? '',
      r.category ?? '',
      `"${String(r.created_by_name ?? '').replace(/"/g, '""')}"`,
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `templates-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols: TableCol<Template>[] = [
    {
      key: 'name', label: 'Template',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.name}</div>
          {r.email_subject && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.email_subject}</div>}
          {r.sms_body && !r.email_subject && (
            <div style={{ fontSize: 11.5, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
              {r.sms_body}
            </div>
          )}
        </div>
      ),
    },
    { key: 'channel',  label: 'Channel',  render: r => <ChannelPill channel={r.channel} /> },
    { key: 'category', label: 'Category', render: r => <CategoryPill category={r.category} /> },
    { key: 'created_by_name', label: 'Created By', render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.created_by_name ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(r.created_at)}</span> },
    {
      key: 'id', label: '', align: 'right',
      render: (r: Template) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button onClick={e => { e.stopPropagation(); setPreview(r) }}
            style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px' }}>Preview</button>
          {canWrite && (
            <button onClick={e => { e.stopPropagation(); setDeleteTarget(r) }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px', color: '#EF4444', borderColor: '#EF444440' }}>Delete</button>
          )}
        </div>
      ),
    },
  ]

  return (
    <Page
      title="Message Templates"
      subtitle="Reusable SMS and email campaign templates"
      actions={canWrite ? (
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Template
        </button>
      ) : undefined}
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setChannelFilter(''); setCategoryFilter('') }}>
        <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Channels</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Categories</option>
          <option value="marketing">Marketing</option>
          <option value="collections">Collections</option>
          <option value="onboarding">Onboarding</option>
          <option value="repayment_reminder">Repayment Reminder</option>
          <option value="general">General</option>
        </select>
      </FilterBar>

      <SectionCard title="Templates" badge={templates.length} padding={false}>
        <DataTable<Template>
          cols={cols}
          rows={templates}
          keyFn={r => r.id}
          emptyText="No templates found."
          skeletonRows={loading ? 6 : 0}
          searchKeys={['name', 'channel', 'category', 'created_by_name']}
          searchPlaceholder="Search templates…"
          pageSize={20}
          onExport={() => exportTemplatesCsv(templates)}
        />
      </SectionCard>

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setForm(BLANK); setSaveErr(null) }}
        title="New Message Template"
        width={500}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowCreate(false); setForm(BLANK); setSaveErr(null) }} style={btnSecondary}>Cancel</button>
            <button onClick={create} disabled={saving || !form.name.trim()} style={btnPrimary}>
              {saving ? 'Saving…' : 'Create Template'}
            </button>
          </div>
        }
      >
        {saveErr && <div style={{ color: '#EF4444', fontSize: 12.5, marginBottom: 10 }}>{saveErr}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Repayment Reminder — Month End"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>Channel</label>
              <select value={form.channel} onChange={e => setForm(f => ({ ...f, channel: e.target.value }))} style={filterInputStyle}>
                <option value="sms">SMS</option>
                <option value="email">Email</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>Category</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={filterInputStyle}>
                <option value="marketing">Marketing</option>
                <option value="collections">Collections</option>
                <option value="onboarding">Onboarding</option>
                <option value="repayment_reminder">Repayment Reminder</option>
                <option value="general">General</option>
              </select>
            </div>
          </div>
          {(form.channel === 'email') && (
            <>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>Email Subject</label>
                <input value={form.email_subject} onChange={e => setForm(f => ({ ...f, email_subject: e.target.value }))}
                  placeholder="e.g. Your repayment is due soon"
                  style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>Body (plain text)</label>
                <textarea value={form.email_body_text} onChange={e => setForm(f => ({ ...f, email_body_text: e.target.value }))}
                  rows={5} placeholder="Dear {{first_name}}, your payment of ₦{{amount}} is due on {{due_date}}."
                  style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
              </div>
            </>
          )}
          {(form.channel === 'sms') && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
                SMS Body
                <span style={{ fontWeight: 400, color: 'var(--txt3)', marginLeft: 8 }}>({form.sms_body.length} / 160 chars)</span>
              </label>
              <textarea value={form.sms_body} onChange={e => setForm(f => ({ ...f, sms_body: e.target.value }))}
                rows={4} maxLength={320} placeholder="Hi {{first_name}}, your O3 card payment of ₦{{amount}} is due today."
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
            </div>
          )}
        </div>
      </Modal>

      {/* Preview modal */}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? ''} width={480}
        footer={<button onClick={() => setPreview(null)} style={btnSecondary}>Close</button>}
      >
        {preview && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <ChannelPill channel={preview.channel} />
              <CategoryPill category={preview.category} />
            </div>
            {preview.email_subject && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', marginBottom: 4 }}>Subject</div>
                <div style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 600 }}>{preview.email_subject}</div>
              </div>
            )}
            {(preview.sms_body || preview.email_body_text) && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', marginBottom: 4 }}>
                  {preview.channel === 'sms' ? 'SMS Body' : 'Body'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--txt)', lineHeight: 1.6, background: 'var(--th-bg)', padding: '10px 12px', borderRadius: 8, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {preview.sms_body ?? preview.email_body_text}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete Template"
        body={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        onConfirm={doDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </Page>
  )
}
