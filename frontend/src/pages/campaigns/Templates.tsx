import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, btnPrimary, btnSecondary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiDelete } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, NUM, INTER } from '../../lib/design'
import { blocksToHtml, type Block } from '../../components/EmailBlockEditor'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Template {
  id: number
  name: string
  channel: string
  category: string
  sms_body?: string
  email_subject?: string
  email_body_html?: string
  email_blocks?: Block[]
  created_at: string
  created_by_name?: string
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

// ── Access guard ──────────────────────────────────────────────────────────────

const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

// ── Main component ─────────────────────────────────────────────────────────────

export default function CampaignTemplates() {
  const navigate = useNavigate()
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [channelFilter, setChannelFilter]   = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
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
            <button onClick={e => { e.stopPropagation(); navigate(`/campaigns/templates/${r.id}/edit`) }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px' }}>Edit</button>
            <button onClick={e => { e.stopPropagation(); setDeleteTarget(r) }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px', color: '#EF4444', borderColor: '#EF444440' }}>Delete</button>
          </>}
        </div>
      ),
    },
  ]

  return (
    <Page
      title="Message Templates"
      subtitle="Reusable SMS and email campaign templates"
      actions={canWrite ? (
        <button onClick={() => navigate('/campaigns/templates/new')} style={btnPrimary}>
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

      <SectionCard title="Templates" badge={templates.length} padding={false} actions={<button onClick={() => exportCsv(templates)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
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
        />
      </SectionCard>

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
                  srcDoc={
                    (preview.email_blocks?.length ?? 0) > 0
                      ? blocksToHtml(Array.isArray(preview.email_blocks) ? preview.email_blocks : [])
                      : preview.email_body_html ?? ''
                  }
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
