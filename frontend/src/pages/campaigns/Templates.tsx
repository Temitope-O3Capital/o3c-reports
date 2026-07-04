import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, btnPrimary, btnSecondary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, NUM, INTER } from '../../lib/design'
import EmailBlockEditor, { blocksToHtml, type EmailBlock } from '../../components/EmailBlockEditor'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Template {
  id: number
  name: string
  channel: string
  category: string
  sms_body?: string
  email_subject?: string
  email_body_html?: string
  email_blocks?: EmailBlock[]
  created_at: string
  created_by_name?: string
}

interface FormState {
  id?: number
  name: string
  channel: 'sms' | 'email'
  category: string
  sms_body: string
  email_subject: string
  email_blocks: EmailBlock[]
}

const BLANK: FormState = {
  name: '', channel: 'sms', category: 'marketing',
  sms_body: '', email_subject: '', email_blocks: [],
}

// ── Pills ─────────────────────────────────────────────────────────────────────

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

// ── SMS Composer ──────────────────────────────────────────────────────────────

const MERGE_TAGS = ['{{first_name}}','{{last_name}}','{{amount}}','{{due_date}}','{{company}}','{{cta_url}}','{{phone}}']

function SMSComposer({ value, onChange }: { value: string; onChange(v: string): void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const len = value.length
  const segs = len === 0 ? 1 : len <= 160 ? 1 : Math.ceil(len / 153)
  const pct = Math.min(100, (len / 160) * 100)
  const barColor = len > 160 ? '#EF4444' : len > 130 ? '#D97706' : '#16A34A'

  function insert(tag: string) {
    const el = ref.current
    if (!el) { onChange(value + tag); return }
    const s = el.selectionStart ?? value.length
    const e = el.selectionEnd ?? value.length
    onChange(value.slice(0, s) + tag + value.slice(e))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + tag.length, s + tag.length) })
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

      {/* Composer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px 20px', gap: 14, overflowY: 'auto' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', letterSpacing: 0.5, marginBottom: 8, fontFamily: INTER }}>INSERT MERGE TAG</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {MERGE_TAGS.map(t => (
              <button key={t} onClick={() => insert(t)} style={{ fontSize: 11.5, padding: '4px 10px', border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--chip-bg)', color: 'var(--txt2)', cursor: 'pointer', fontFamily: 'monospace' }}>{t}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', letterSpacing: 0.5, fontFamily: INTER }}>MESSAGE BODY</div>
          <textarea
            ref={ref}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="Hi {{first_name}}, your O3 Capital repayment of ₦{{amount}} is due on {{due_date}}. Pay now to avoid late fees."
            style={{
              fontSize: 14, padding: '14px 16px', border: '1px solid var(--bdr)', borderRadius: 8,
              background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: 'monospace',
              resize: 'none', lineHeight: 1.7, boxSizing: 'border-box', width: '100%',
              flex: 1, minHeight: 180, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 4, background: 'var(--bdr)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 2, transition: 'width 0.1s, background 0.2s' }} />
            </div>
            <span style={{ fontSize: 12, color: barColor, fontFamily: 'monospace', fontWeight: 600, flexShrink: 0, minWidth: 120, textAlign: 'right' }}>
              {len} / 160 · {segs} SMS{segs > 1 ? ' credits' : ''}
            </span>
          </div>
          {len > 153 && (
            <div style={{ fontSize: 12, color: len > 160 ? '#EF4444' : '#D97706', display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>warning</span>
              {len > 160 ? `${segs} credits will be used per recipient` : 'Merge tags may push this past 160 chars'}
            </div>
          )}
        </div>
      </div>

      {/* Phone preview */}
      <div style={{ width: 230, borderLeft: '1px solid var(--bdr)', background: 'var(--th-bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 16px', gap: 14, flexShrink: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', letterSpacing: 0.5, fontFamily: INTER }}>SMS PREVIEW</div>
        <div style={{ background: '#0d1f36', borderRadius: 32, padding: '14px 9px 22px', width: 180, boxShadow: '0 8px 32px rgba(0,0,0,0.22)', flexShrink: 0 }}>
          <div style={{ width: 44, height: 5, background: 'rgba(255,255,255,0.12)', borderRadius: 3, margin: '0 auto 12px' }} />
          <div style={{ background: '#f2f2f2', borderRadius: 20, padding: '10px 8px 20px', minHeight: 200 }}>
            <div style={{ textAlign: 'center', marginBottom: 10, paddingTop: 2 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: '#111' }}>Messages</div>
              <div style={{ fontSize: 8.5, color: '#666', marginTop: 1 }}>O3 Capital · Now</div>
            </div>
            <div style={{ background: '#e5e5ea', borderRadius: '13px 13px 13px 4px', padding: '8px 10px', fontSize: 11, color: '#1a1a1a', lineHeight: 1.55, wordBreak: 'break-word' }}>
              {value || <span style={{ color: '#aaa', fontStyle: 'italic' }}>Your message preview…</span>}
            </div>
            <div style={{ textAlign: 'right', fontSize: 8.5, color: '#999', marginTop: 5, paddingRight: 4 }}>Delivered</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Access guard ──────────────────────────────────────────────────────────────

const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

// ── Main component ─────────────────────────────────────────────────────────────

export default function CampaignTemplates() {
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [channelFilter, setChannelFilter]   = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [form, setForm]           = useState<FormState | null>(null)
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

  function openNew() { setForm({ ...BLANK }); setSaveErr(null) }

  function openEdit(t: Template) {
    setForm({
      id: t.id, name: t.name,
      channel: t.channel === 'email' ? 'email' : 'sms',
      category: t.category,
      sms_body: t.sms_body ?? '',
      email_subject: t.email_subject ?? '',
      email_blocks: Array.isArray(t.email_blocks) ? t.email_blocks : [],
    })
    setSaveErr(null)
  }

  async function save() {
    if (!form || !form.name.trim()) return
    setSaving(true); setSaveErr(null)
    try {
      const body: Record<string, any> = { name: form.name.trim(), channel: form.channel, category: form.category }
      if (form.channel === 'sms') {
        body.sms_body = form.sms_body
      } else {
        body.email_subject = form.email_subject
        body.email_body_html = blocksToHtml(form.email_blocks)
        body.email_blocks = form.email_blocks
      }
      if (form.id) await apiPut(`/api/message-templates/${form.id}`, body)
      else await apiPost('/api/message-templates', body)
      setForm(null); load()
    } catch (ex: any) { setSaveErr(ex.message) }
    finally { setSaving(false) }
  }

  async function doDelete() {
    if (!deleteTarget) return
    try { await apiDelete(`/api/message-templates/${deleteTarget.id}`); setDeleteTarget(null); load() }
    catch (ex: any) { setErr(ex.message) }
  }

  function exportCsv(data: Template[]) {
    const hdr = ['Name', 'Channel', 'Category', 'Created By', 'Created At']
    const rows = data.map(r => [
      `"${(r.name ?? '').replace(/"/g, '""')}"`, r.channel ?? '', r.category ?? '',
      `"${(r.created_by_name ?? '').replace(/"/g, '""')}"`, r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[hdr.join(','), ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `templates-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove()
  }

  const cols: TableCol<Template>[] = [
    {
      key: 'name', label: 'Template',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.name}</div>
          {r.email_subject && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>Subject: {r.email_subject}</div>}
          {r.sms_body && !r.email_subject && (
            <div style={{ fontSize: 11.5, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
              {r.sms_body}
            </div>
          )}
        </div>
      ),
    },
    { key: 'channel',  label: 'Channel',  render: r => <ChannelPill  channel={r.channel} /> },
    { key: 'category', label: 'Category', render: r => <CategoryPill category={r.category} /> },
    { key: 'created_by_name', label: 'Created By', render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.created_by_name ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(r.created_at)}</span> },
    {
      key: 'id', label: '', align: 'right',
      render: r => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button onClick={e => { e.stopPropagation(); setPreview(r) }}
            style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px' }}>Preview</button>
          {canWrite && <>
            <button onClick={e => { e.stopPropagation(); openEdit(r) }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px' }}>Edit</button>
            <button onClick={e => { e.stopPropagation(); setDeleteTarget(r) }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px', color: '#EF4444', borderColor: '#EF444440' }}>Delete</button>
          </>}
        </div>
      ),
    },
  ]

  const drawerW = form?.channel === 'email' ? 920 : 560
  const fis = { ...filterInputStyle, height: 34 }

  return (
    <Page
      title="Message Templates"
      subtitle="Reusable SMS and email campaign templates"
      actions={canWrite ? (
        <button onClick={openNew} style={btnPrimary}>
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
          emptyText={
            canWrite
              ? 'No templates yet — click "New Template" to create your first one.'
              : 'No templates have been created yet.'
          }
          skeletonRows={loading ? 6 : 0}
          searchKeys={['name', 'channel', 'category', 'created_by_name']}
          searchPlaceholder="Search templates…"
          pageSize={20}
          onExport={() => exportCsv(templates)}
        />
      </SectionCard>

      {/* ── Create / Edit drawer ── */}
      {form && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}
          onClick={e => { if (e.target === e.currentTarget) { setForm(null); setSaveErr(null) } }}
        >
          <div style={{ width: drawerW, height: '100vh', background: 'var(--card)', display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 32px rgba(0,0,0,0.18)', overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)', fontFamily: INTER }}>
                {form.id ? 'Edit Template' : 'New Template'}
              </div>
              <button onClick={() => { setForm(null); setSaveErr(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 4, lineHeight: 1 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
              </button>
            </div>

            {/* Metadata */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'flex-end', flexShrink: 0, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>TEMPLATE NAME *</div>
                <input
                  value={form.name}
                  onChange={e => setForm(f => f && { ...f, name: e.target.value })}
                  style={{ ...fis, width: '100%', boxSizing: 'border-box' }}
                  placeholder="e.g. Repayment Reminder — Month End"
                  autoFocus
                />
              </div>
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>CHANNEL</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['sms', 'email'] as const).map(ch => (
                    <button
                      key={ch}
                      onClick={() => setForm(f => f && { ...f, channel: ch })}
                      style={{
                        padding: '0 14px', border: `1.5px solid ${form.channel === ch ? BLUE : 'var(--bdr)'}`,
                        borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: INTER,
                        background: form.channel === ch ? `${BLUE}10` : 'var(--card)',
                        color: form.channel === ch ? BLUE : 'var(--txt2)',
                        display: 'flex', alignItems: 'center', gap: 5, height: 34, boxSizing: 'border-box',
                      }}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>
                        {ch === 'sms' ? 'smartphone' : 'mail'}
                      </span>
                      {ch === 'sms' ? 'SMS' : 'Email'}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>CATEGORY</div>
                <select value={form.category} onChange={e => setForm(f => f && { ...f, category: e.target.value })} style={fis}>
                  <option value="marketing">Marketing</option>
                  <option value="collections">Collections</option>
                  <option value="onboarding">Onboarding</option>
                  <option value="repayment_reminder">Repayment Reminder</option>
                  <option value="general">General</option>
                </select>
              </div>
            </div>

            {/* Email subject row */}
            {form.channel === 'email' && (
              <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>EMAIL SUBJECT *</div>
                <input
                  value={form.email_subject}
                  onChange={e => setForm(f => f && { ...f, email_subject: e.target.value })}
                  style={{ ...fis, width: '100%', boxSizing: 'border-box' }}
                  placeholder="e.g. Your O3 Capital repayment is due soon"
                />
              </div>
            )}

            {/* Main editor — fills remaining height */}
            {form.channel === 'email' ? (
              <EmailBlockEditor
                value={{ blocks: form.email_blocks }}
                onChange={v => setForm(f => f && { ...f, email_blocks: v.blocks })}
              />
            ) : (
              <SMSComposer value={form.sms_body} onChange={v => setForm(f => f && { ...f, sms_body: v })} />
            )}

            {/* Footer */}
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: '#EF4444', flex: 1, paddingRight: 12 }}>{saveErr || ''}</div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={() => { setForm(null); setSaveErr(null) }} style={btnSecondary}>Cancel</button>
                <button onClick={save} disabled={saving || !form.name.trim()} style={btnPrimary}>
                  {saving ? 'Saving…' : form.id ? 'Save Changes' : 'Create Template'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal */}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? ''} width={520}
        footer={<button onClick={() => setPreview(null)} style={btnSecondary}>Close</button>}>
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
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', marginBottom: 6 }}>
                {preview.channel === 'sms' ? 'SMS Body' : 'Email Body'}
              </div>
              {preview.channel === 'sms' ? (
                <div style={{ fontSize: 13, color: 'var(--txt)', lineHeight: 1.6, background: 'var(--th-bg)', padding: '12px 14px', borderRadius: 8, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {preview.sms_body || '(no body)'}
                </div>
              ) : (
                <iframe
                  srcDoc={blocksToHtml(Array.isArray(preview.email_blocks) ? preview.email_blocks : [])}
                  style={{ width: '100%', height: 340, border: 'none', borderRadius: 8, background: '#F4F6FA' }}
                  title="Email preview"
                  sandbox="allow-same-origin"
                />
              )}
            </div>
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
